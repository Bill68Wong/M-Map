/**
 * 纵向站条快照回归（scripts/test-strips-snapshot.ts，需求1 · 1-B′）
 *
 * 用法（⚠️ **必须用 tsx 跑，不能直接 `node`**）：
 *   node node_modules/tsx/dist/cli.mjs scripts/test-strips-snapshot.ts            # 比对快照
 *   node node_modules/tsx/dist/cli.mjs scripts/test-strips-snapshot.ts --update   # 打印新快照（人工粘贴）
 *
 *   为什么不 `node` 直跑：本文件用**无扩展名**的相对 import（`../src/lib/...`，与 `src/` 内
 *   的路径别名风格一致），Node 的 ESM 解析要求显式 `.ts`/`.js` ⇒ 直跑会
 *   `ERR_MODULE_NOT_FOUND`。tsx 内部走 esbuild 解析，无此限制。
 *   （该现象由前端实测报出，我复现确认 —— 是 runner 问题，不是脚本缺陷。）
 *
 * ── 为什么需要它（这是本项目的一个真实缺口）──────────────────────────────
 *   `buildStrips` 此前**没有任何自动回归网**：
 *     · `scripts/test-route-overview.ts` 测的是 `route-overview.ts` 的几何纯函数，**不覆盖本函数**；
 *     · `.verify/p7-2-strips.ts:35` 与 `.verify/verify-b2-b5.ts:303` 仍在传 `weekday`，
 *       而 `StripBuildCtx` 自 v3.4.0 已改名 `nowBucket` ⇒ 双双 `TS2353` **静默腐坏**；
 *     · 它们之所以长期无人察觉，是因为 `.verify/` **不在 tsc 覆盖内**
 *       （根 tsconfig 的 `include` 用 `**` 通配，但 TypeScript glob **不匹配点目录**）。
 *   ⇒ 本脚本放在 `scripts/`（tsc 会检查），并**全离线**（合成索引，不连库），可进 CI 纯函数门。
 *
 * ── 为什么是「快照」而不是「v1 vs v2 对拍」──────────────────────────────
 *   需求1 / 1-B′ 最终**不修改 `strips.ts`**（采用「先产出 patchedCard 再喂 buildStrips」路线）。
 *   既然只有一个实现，`v1 vs v2` 对拍没有意义 ⇒ 改成**锁住站条语义**的快照：
 *   任何对 `strips.ts` 或 patchedCard 构造的改动，只要改变了下列任一绑定关系，本脚本立刻变红。
 *
 * ── 快照摘要（digest）锁定什么 ──────────────────────────────────────────
 *   每段一条：`route/kind/board>alight | ride=<rideMin> | wait=<换乘后等车> | stops=<节点数> |
 *              sum=<逐站 minToNext 之和> | roles=<board,mid…,alight>`
 *   其中三条是**语义绑定**，改了就说明有人换了数据源：
 *     · `ride` 必须恒等于 `card.rides[i].minutes`（`strips.ts:134`）
 *     · `wait` 必须恒等于 `card.transfers[i].waitMin ?? null`（`strips.ts:118`）
 *     · `sum` 必须恒等于 `ride`（逐站分钟之和 = 该段乘车分钟；lrt 段除外，见下）
 */
import { buildSegmentIndex } from "../src/lib/recommend/segment-lookup";
import type {
  RecommendCard,
  RideLegView,
  RouteIndex,
  SegmentStrip,
  TransferView,
} from "../src/lib/recommend/types";
import { buildStrips, type StripBuildCtx } from "../src/lib/nav/strips";

const NOW_BUCKET = "all";

/* ══════════════════════ 合成索引（与 test-remaining.ts 同构，便于交叉推理）══════════════════════ */

/**
 * 巴士 B1：A1 → A2 → A3 → A4（每跳 4 分）
 * 巴士 B2：A3 → A5 → A6（每跳 4 分）
 * 轻轨 LRT-T：L1 → L2 → L3（每跳 5 分；`kind:"lrt"` 走 rideSecText 分支）
 */
function makeRouteIdx(): RouteIndex {
  return {
    dirStops: new Map<string, string[]>([
      ["B1|0", ["A1", "A2", "A3", "A4"]],
      ["B2|0", ["A3", "A5", "A6"]],
      ["LRT-T|TFT", ["L1", "L2", "L3"]],
    ]),
    seqIdx: new Map(),
    dirsOf: new Map([
      ["B1", ["0"]],
      ["B2", ["0"]],
      ["LRT-T", ["TFT"]],
    ]),
    nameOf: new Map([
      ["A1", "A1 起點"],
      ["A2", "A2 中途"],
      ["A3", "A3 換乘"],
      ["A4", "A4 終點"],
      ["A5", "A5 中途二"],
      ["A6", "A6 終點二"],
      ["L1", "L1 輕軌一"],
      ["L2", "L2 輕軌二"],
      ["L3", "L3 輕軌三"],
    ]),
    adjOwners: new Map(),
  };
}

const routeIdx = makeRouteIdx();

/**
 * 每跳 4 分。**成对给 `stop` 与 `all` 两种 `arrive_kind`**：
 *   · `stop` 行供 `lookupHop` 的 L2 命中（`weekday=-1 / bucket=all / kind=stop`）；
 *   · `all` 行供 L6 本线均值（`routeHop`）与 L7 全局均值（`globalHop`）计算 ——
 *     缺它时 `globalHop` 会落到代码里的常量兜底 `1.5`（`segment-lookup.ts:82`），
 *     那是个魔数，会让快照基线难以手算、也掩盖真实兜底路径。
 * ⇒ LRT-T **刻意不给任何行**：真实库里轻轨没有 `segment_stats`（那是 DSAT 巴士统计），
 *    其逐站分钟必然走 L6/L7 兜底，这正是要锁住的**已知不对称**（见下方语义绑定断言）。
 */
const segIdx = buildSegmentIndex(
  (
    [
      ["B1", "A1", "A2"],
      ["B1", "A2", "A3"],
      ["B1", "A3", "A4"],
      ["B2", "A3", "A5"],
      ["B2", "A5", "A6"],
    ] as [string, string, string][]
  ).flatMap(([route, from, to]) =>
    (["stop", "all"] as const).map((kind) => ({
      route_code: route,
      from_station: from,
      to_station: to,
      weekday: -1,
      time_bucket: "all",
      arrive_kind: kind,
      avg_minutes: 4,
      p50_minutes: 4,
      samples: 10,
    })),
  ),
);

const ctx: StripBuildCtx = { routeIdx, segIdx, nameOf: routeIdx.nameOf, nowBucket: NOW_BUCKET };

/* ══════════════════════ 用例构造 ══════════════════════ */

const ride = (
  r: Partial<RideLegView> & { route: string; board: string; alight: string },
): RideLegView =>
  ({
    kind: "bus",
    boardLabel: r.board,
    alightLabel: r.alight,
    minutes: 8,
    hops: 2,
    levels: [2, 2],
    waitMin: 3,
    liveText: "",
    tier: 3,
    tierText: "",
    tierHint: "",
    ...r,
  }) as RideLegView;

const transfer = (at: string, minutes: number, waitMin: number | null): TransferView => ({
  at,
  atLabel: at,
  minutes,
  estimated: false,
  sameField: false,
  waitMin,
  slackMin: 1.2,
});

const card = (rides: RideLegView[], transfers: TransferView[], totalMin = 20): RecommendCard => ({
  planId: 990001,
  summary: "strips-snapshot",
  fromSlug: "home",
  toSlug: "school",
  totalMin,
  arriveAt: Date.UTC(2026, 10, 3, 4, 20, 0),
  walkOut: { minutes: 3, toLabel: "A1 起點", level: 1, estimated: false, samples: 8, distanceM: 210 },
  walkIn: { minutes: 2, toLabel: "學校", level: 1, estimated: false, samples: 8, distanceM: 140 },
  rides,
  transfers,
  hints: [],
  crossBorder: false,
});

const CASES: { name: string; card: RecommendCard }[] = [
  {
    name: "1-单段巴士（3 站 2 跳）",
    card: card([ride({ route: "B1", board: "A1", alight: "A3", minutes: 8 })], []),
  },
  {
    name: "2-多段含换乘（waitMin=8.7 重估值）",
    card: card(
      [
        ride({ route: "B1", board: "A1", alight: "A3", minutes: 2 }),
        ride({ route: "B2", board: "A3", alight: "A6", minutes: 8, waitMin: 8.7 }),
      ],
      [transfer("A3", 2, 8.7)],
    ),
  },
  {
    name: "3-轻轨段（rideSecText 分支）",
    card: card(
      [
        ride({
          route: "LRT-T",
          kind: "lrt",
          board: "L1",
          alight: "L3",
          minutes: 10,
          waitMin: 0,
          levels: [],
          directionName: "終點方向",
          rideSecText: "10分0秒",
        }),
      ],
      [],
    ),
  },
  {
    name: "4-board==alight（站序无法切片，退化为 2 节点）",
    card: card([ride({ route: "B1", board: "A1", alight: "A1", minutes: 0 })], []),
  },
  {
    name: "5-两站短链（1 跳）",
    card: card([ride({ route: "B1", board: "A1", alight: "A2", minutes: 4, hops: 1, levels: [2] })], []),
  },
  {
    name: "6-最长链（4 站 3 跳）",
    card: card([ride({ route: "B1", board: "A1", alight: "A4", minutes: 12, hops: 3, levels: [2, 2, 2] })], []),
  },
  {
    name: "7-极端取值（minutes=0 / waitMin=0 / tier=null）",
    card: card(
      [
        ride({ route: "B1", board: "A1", alight: "A3", minutes: 0, waitMin: 0, tier: null, tierText: "" }),
        ride({ route: "B2", board: "A3", alight: "A6", minutes: 8, waitMin: 0, tier: null, tierText: "" }),
      ],
      [transfer("A3", 2, 0)],
      0,
    ),
  },
  {
    name: "8-亚分钟小数（minutes=0.04 / waitMin=0.06）",
    card: card(
      [ride({ route: "B1", board: "A1", alight: "A3", minutes: 0.04, waitMin: 0.06 })],
      [],
      0.1,
    ),
  },
];

/* ══════════════════════ 摘要与快照 ══════════════════════ */

const round = (v: number): number => Math.round(v * 10) / 10;

/** 把一段站条压成一行可读摘要（锁住三条语义绑定 + 几何形状） */
function digestOf(s: SegmentStrip): string {
  const sum = round(s.stops.slice(0, -1).reduce((a, x) => a + x.minToNext, 0));
  const roles = s.stops.map((x) => x.role[0]).join(""); // b/m/a 三字母串
  return [
    `${s.route}/${s.kind}/${s.board}>${s.alight}`,
    `ride=${s.rideMin}`,
    `wait=${s.transferAfter?.waitMin ?? "-"}`,
    `stops=${s.stops.length}`,
    `sum=${sum}`,
    `roles=${roles}`,
  ].join("|");
}

const snapshotOf = (c: RecommendCard): string[] => buildStrips(c, ctx).map(digestOf);

/**
 * 快照基线（首次由 `--update` 生成，人工核对后粘贴）。
 * ⚠️ 若**有意**改变 `strips.ts` 语义（如 `rideMin` 改为读别的字段），
 *    必须先确认消费方（`NavStrip.tsx:97/171/182`、`StationStrip.tsx:107/152`）同步，
 *    再更新本基线；**仅因测试变红就改基线**等于把回归网拆掉。
 */
const GOLDEN: Record<string, string[]> = {
  "1-单段巴士（3 站 2 跳）": [
    "B1/bus/A1>A3|ride=8|wait=-|stops=3|sum=8|roles=bma",
  ],
  "2-多段含换乘（waitMin=8.7 重估值）": [
    "B1/bus/A1>A3|ride=2|wait=8.7|stops=3|sum=8|roles=bma",
    "B2/bus/A3>A6|ride=8|wait=-|stops=3|sum=8|roles=bma",
  ],
  // LRT-T 无 segment_stats 行 ⇒ 逐站分钟落 `globalHop` 兜底（4 分/跳 × 2 跳 = 8），
  // 与 `rideMin=10`（轻轨常量口径）**本就不同源**。这是真实库的已知不对称，锁住以防漂移。
  "3-轻轨段（rideSecText 分支）": [
    "LRT-T/lrt/L1>L3|ride=10|wait=-|stops=3|sum=8|roles=bma",
  ],
  // board==alight：`segmentsOf` 切不出同站区间 ⇒ 退化为 2 节点、1 跳查不到行 ⇒ L6 本线均值 4
  "4-board==alight（站序无法切片，退化为 2 节点）": [
    "B1/bus/A1>A1|ride=0|wait=-|stops=2|sum=4|roles=ba",
  ],
  "5-两站短链（1 跳）": ["B1/bus/A1>A2|ride=4|wait=-|stops=2|sum=4|roles=ba"],
  "6-最长链（4 站 3 跳）": ["B1/bus/A1>A4|ride=12|wait=-|stops=4|sum=12|roles=bmma"],
  "7-极端取值（minutes=0 / waitMin=0 / tier=null）": [
    "B1/bus/A1>A3|ride=0|wait=0|stops=3|sum=8|roles=bma",
    "B2/bus/A3>A6|ride=8|wait=-|stops=3|sum=8|roles=bma",
  ],
  "8-亚分钟小数（minutes=0.04 / waitMin=0.06）": [
    "B1/bus/A1>A3|ride=0.04|wait=-|stops=3|sum=8|roles=bma",
  ],
};

/* ══════════════════════ 主流程 ══════════════════════ */

const update = process.argv.includes("--update");
let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, extra = ""): void => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.error(`  FAIL  ${label}${extra ? "  " + extra : ""}`);
  }
};

console.log("═══ 纵向站条快照回归（全离线，不连库）═══\n");

if (update) {
  console.log("── 新快照（粘贴进 GOLDEN）──");
  for (const c of CASES) {
    console.log(`  ${JSON.stringify(c.name)}: [`);
    for (const d of snapshotOf(c.card)) console.log(`    ${JSON.stringify(d)},`);
    console.log("  ],");
  }
  console.log("\n（--update 模式不判失败，仅打印）");
  process.exit(0);
}

for (const c of CASES) {
  const got = snapshotOf(c.card);
  const want = GOLDEN[c.name];
  ok(
    !!want && JSON.stringify(got) === JSON.stringify(want),
    `快照 ${c.name}`,
    want ? `${got.length} 段` : "基线缺失（先跑 --update）",
  );
  if (want && JSON.stringify(got) !== JSON.stringify(want)) {
    for (let i = 0; i < Math.max(got.length, want.length); i++) {
      if (got[i] !== want[i]) {
        console.error(`        段#${i} 实际 ${got[i] ?? "<缺>"}`);
        console.error(`        段#${i} 期望 ${want[i] ?? "<缺>"}`);
      }
    }
  }
}

/* ── 三条语义绑定的独立断言（比快照更会指路）── */
console.log("\n── 语义绑定（改数据源即变红）──");
{
  // ⚠️ 这里必须用**未打补丁的原 card**：只有当 `rideMin` 与「全段逐跳」同源时，
  //   `sum(minToNext) === rideMin` 才成立。patchedCard 下该等式**故意不成立**
  //   （`rideMin` 是剩余，站条仍显全段）—— 见紧随其后的不对称断言。
  const c = card(
    [
      ride({ route: "B1", board: "A1", alight: "A3", minutes: 8, waitMin: 1 }),
      ride({ route: "B2", board: "A3", alight: "A6", minutes: 8, waitMin: 8.7 }),
    ],
    [transfer("A3", 2, 8.7)],
  );
  const strips = buildStrips(c, ctx);
  ok(
    strips.every((s, i) => s.rideMin === c.rides[i]!.minutes),
    "rideMin ≡ card.rides[i].minutes（strips.ts:134）",
  );
  ok(
    strips.every((s, i) => (s.transferAfter?.waitMin ?? null) === (c.transfers[i]?.waitMin ?? null)),
    "transferAfter.waitMin ≡ card.transfers[i].waitMin（strips.ts:118）",
  );
  ok(
    strips
      .filter((s) => s.kind === "bus")
      .every((s) => round(s.stops.slice(0, -1).reduce((a, x) => a + x.minToNext, 0)) === round(s.rideMin)),
    "bus 段（原 card）：逐站 minToNext 之和 ≡ rideMin（同一串 hops + 同一个 lookupHop）",
  );
  ok(
    strips.map((s) => s.board).join() === c.rides.map((r) => r.board).join() &&
      strips.map((s) => s.alight).join() === c.rides.map((r) => r.alight).join(),
    "段与 card.rides 一一对应、同序",
  );
  ok(
    strips.every((s, i) => (i === strips.length - 1 ? s.transferAfter === null : s.transferAfter !== null)),
    "最后一段 transferAfter 为 null，其余非 null",
  );
}

/* ── 已知不对称（★ 需求1 实现者必读）：patchedCard 只改时间字段，不裁剪站条 ── */
console.log("\n── 已知不对称：patchedCard 下 sum(minToNext) ≠ rideMin（预期）──");
{
  const patched = card(
    [
      ride({ route: "B1", board: "A1", alight: "A3", minutes: 2.5, waitMin: 1 }),
      ride({ route: "B2", board: "A3", alight: "A6", minutes: 8, waitMin: 8.7 }),
    ],
    [transfer("A3", 2, 8.7)],
  );
  const s = buildStrips(patched, ctx);
  const sum0 = round(s[0]!.stops.slice(0, -1).reduce((a, x) => a + x.minToNext, 0));
  ok(s[0]!.rideMin === 2.5, "patchedCard：rideMin 已变为剩余 2.5", `实际 ${s[0]!.rideMin}`);
  ok(sum0 === 8, "patchedCard：逐站 minToNext 之和仍为全段 8（**不随之变化**）", `实际 ${sum0}`);
  ok(
    sum0 !== s[0]!.rideMin,
    "⇒ 二者不再相等，这是**预期**：`minToNext` 只来自 `lookupHop(nowBucket)`（strips.ts:74），不吃 card.minutes",
  );
  /**
   * 为什么可以接受 —— **机制是"渲染条件恰好挡住"，不是"用户看不见"**（前端独立核实，我采纳）：
   *   · `NavStrip.tsx:138` 的逐跳「N 分」条件是 `!end && s.minToNext > 0 && !nav`；
   *   · `NavStrip.tsx:72` `const open = openManual || !!nav` ⇒ riding 当前腿 `nav` **恒非空**；
   *   · ⇒ **恰恰在 `rideMin` 被补丁的那个场景，逐跳标签不渲染**；其余腿 `nav` 为 null
   *     （逐跳可见）但它们未被补丁 ⇒ 各自自洽。
   * ⚠️⚠️ 这是**结构必然**，不是侥幸。所以：**若将来有人放开 `NavStrip` 的 `!nav` 条件**
   *   （例如想在导航中也显示逐跳分钟），本不对称会**立刻变成用户可见** ⇒
   *   **必须先重裁站条范围（要不要按已过站裁剪 `stops[]`），再来放开条件。**
   *   顺序反了就会给用户看到「车上约 2 分，但下面逐站加起来 8 分」。
   * 非导航态（详情预览）不会走 patchedCard（只有 `/api/nav/remaining` 产出它）。
   */
  ok(
    s[0]!.stops.length === 3,
    "站条节点数不变 ⇒ 几何/站序不受影响（裁剪站条需另设计，本轮明确不做）",
  );
}

console.log(`\n═══ 合计 ${pass + fail} 条：PASS ${pass} / FAIL ${fail} ═══`);
process.exit(fail === 0 ? 0 : 1);
