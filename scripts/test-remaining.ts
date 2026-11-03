/**
 * 剩余时间重算 · 纯函数回归（scripts/test-remaining.ts，需求1 · 1-B′）
 *
 * 用法：`node node_modules/tsx/dist/cli.mjs scripts/test-remaining.ts`
 *
 * ── 为什么放 `scripts/` 而不是 `.verify/` ────────────────────────────────
 *   `.verify/` **不在 tsc 覆盖范围内**（根 `tsconfig.json` 的 `include` 用 `**` 通配，
 *   但 TypeScript 的 glob **不匹配点目录**）—— 该目录下已有两个脚本因
 *   `StripBuildCtx.weekday → nowBucket` 改名而静默腐坏
 *   （`.verify/p7-2-strips.ts:35`、`.verify/verify-b2-b5.ts:303`，报 TS2353）。
 *   ⇒ 本脚本必须放在被 tsc 检查的位置，否则会重蹈覆辙。
 *
 * ── 全离线 ──────────────────────────────────────────────────────────────
 *   **不连库、不联网**：`RouteIndex` / `SegmentIndex` / `HeadwayIndex` 全部用合成数据构造。
 *   这样它能进 CI 纯函数门（与 `scripts/test-route-overview.ts` 用例 1–8 同性质）。
 *
 * ── 覆盖 ────────────────────────────────────────────────────────────────
 *   ① 当前腿有 `segRemainSec`
 *   ② 当前腿无 `segRemainSec`（回退该段全量静态分钟）
 *   ③ 当前腿无 `segRemainSec` 但有 `nextIdx`（逐跳累加，与前端 `NavDetailBody.tsx:162-166` 同口径）
 *   ④ `remainingMin` 永不为负（即使 nowMs 已晚于原到达时刻）
 *   ⑤ `patchedCard` 除时间字段外与入参**逐字段一致**
 *   ⑥ `buildStrips(patchedCard)` 的 `rideMin` / `waitMin` 确实随 patchedCard 变化
 *   ⑦ 下游候车按「预计到达该换乘站的绝对时刻」重估（本模块的核心价值）
 *   ⑧ 单段卡：不传 `headway`（null）也不崩，只算「当前腿 + 末段步行」
 *   ⑨ `legIndex` 越界被夹取（防御）
 *   ⑩ 末段下车后立即到达：`legIndex` = 最后一段时不看 transfers
 */
import { buildSegmentIndex, rideOfHops } from "../src/lib/recommend/segment-lookup";
import { segmentsOf } from "../src/lib/recommend/enumerate";
import { loadStatics, type RecStatic } from "../src/lib/recommend/query";
import type { HeadwayIndex } from "../src/lib/recommend/headway";
import type {
  SegmentStatRow,
  RecommendCard,
  RideLegView,
  RouteIndex,
  SegmentStrip,
  TransferView,
} from "../src/lib/recommend/types";
import { recomputeRemaining, type RemainingCtx } from "../src/lib/nav/remaining";
import { buildStrips } from "../src/lib/nav/strips";

/* ══════════════════════ 断言工具 ══════════════════════ */

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
const near = (a: number, b: number, eps = 0.05): boolean => Math.abs(a - b) <= eps;
/** 与 `remaining.ts` 内部的 round1 同口径（1 位小数） */
const round1 = (v: number): number => Math.round(v * 10) / 10;

/* ══════════════════════ 合成索引 ══════════════════════ */

/**
 * 线路 B1：A1 → A2 → A3 → A4（4 站 3 跳）
 * 线路 B2：A3 → A5 → A6（3 站 2 跳）
 * ⇒ 换乘点 A3，与真实「同站换线」结构一致。
 */
function makeRouteIdx(): RouteIndex {
  const dirStops = new Map<string, string[]>([
    ["B1|0", ["A1", "A2", "A3", "A4"]],
    ["B2|0", ["A3", "A5", "A6"]],
  ]);
  return {
    dirStops,
    seqIdx: new Map(),
    dirsOf: new Map([
      ["B1", ["0"]],
      ["B2", ["0"]],
    ]),
    nameOf: new Map([
      ["A1", "A1 起點"],
      ["A2", "A2 中途"],
      ["A3", "A3 換乘"],
      ["A4", "A4 終點"],
      ["A5", "A5 中途二"],
      ["A6", "A6 終點二"],
    ]),
    adjOwners: new Map(),
  };
}

/** 每跳 4 分钟（weekday=-1 / all / stop ⇒ lookupHop 命中 L2，level=2） */
function makeSegRows(): SegmentStatRow[] {
  const pairs: [string, string, string][] = [
    ["B1", "A1", "A2"],
    ["B1", "A2", "A3"],
    ["B1", "A3", "A4"],
    ["B2", "A3", "A5"],
    ["B2", "A5", "A6"],
  ];
  return pairs.map(([route, from, to]) => ({
    route_code: route,
    from_station: from,
    to_station: to,
    weekday: -1,
    time_bucket: "all",
    arrive_kind: "stop",
    avg_minutes: 4,
    p50_minutes: 4,
    samples: 10,
  }));
}

/** B2 班距 6~10 分 ⇒ 保守值 (6 + 2×10)/3 = 8.666… → round1 = 8.7 */
function makeHeadway(): HeadwayIndex {
  return {
    byRoute: new Map([
      [
        "B2",
        [
          {
            dayType: "daily",
            timeFrom: "00:00",
            timeTo: "23:59",
            fromMin: 0,
            toMin: 1439,
            freqLo: 6,
            freqHi: 10,
          },
        ],
      ],
    ]),
    holidays: new Set<string>(),
    size: 1,
  };
}

/* ══════════════════════ 合成 card ══════════════════════ */

const mkRide = (
  route: string,
  board: string,
  alight: string,
  minutes: number,
  waitMin: number,
): RideLegView => ({
  route,
  kind: "bus",
  board,
  alight,
  boardLabel: board,
  alightLabel: alight,
  minutes,
  hops: 2,
  levels: [2, 2],
  waitMin,
  liveText: "",
  tier: 3,
  tierText: "",
  tierHint: "",
});

const mkTransfer = (at: string, minutes: number, waitMin: number): TransferView => ({
  at,
  atLabel: at,
  minutes,
  estimated: false,
  sameField: false,
  waitMin,
  slackMin: 1.0,
});

/** 两段卡：B1（A1→A3，2 跳 = 8 分，候车 3 分）换乘 B2（A3→A6，2 跳 = 8 分，候车 3 分） */
function mkTwoLegCard(nowMs: number): RecommendCard {
  return {
    planId: 880001,
    summary: "synthetic-two-leg",
    fromSlug: "home",
    toSlug: "school",
    totalMin: 3 + 8 + 2 + 3 + 8 + 2, // walkOut 3 + ride 8 + transfer 2 + wait 3 + ride 8 + walkIn 2 = 26
    arriveAt: nowMs + 26 * 60_000,
    walkOut: { minutes: 3, toLabel: "A1 起點", level: 1, estimated: false, samples: 8, distanceM: 210 },
    walkIn: { minutes: 2, toLabel: "學校", level: 1, estimated: false, samples: 8, distanceM: 140 },
    rides: [mkRide("B1", "A1", "A3", 8, 3), mkRide("B2", "A3", "A6", 8, 3)],
    transfers: [mkTransfer("A3", 2, 3)],
    hints: [],
    crossBorder: false,
  };
}

/** 单段卡：B1 全段（A1→A4） */
function mkOneLegCard(nowMs: number): RecommendCard {
  return {
    planId: 880002,
    summary: "synthetic-one-leg",
    fromSlug: "home",
    toSlug: "school",
    totalMin: 3 + 12 + 3 + 2,
    arriveAt: nowMs + 20 * 60_000,
    walkOut: { minutes: 3, toLabel: "A1 起點", level: 1, estimated: false, samples: 8, distanceM: 210 },
    walkIn: { minutes: 2, toLabel: "學校", level: 1, estimated: false, samples: 8, distanceM: 140 },
    rides: [mkRide("B1", "A1", "A4", 12, 3)],
    transfers: [],
    hints: [],
    crossBorder: false,
  };
}

/* ══════════════════════ ⑤ 深比较工具 ══════════════════════ */

/**
 * 「除时间字段外逐字段一致」的判据。
 *
 * 时间字段 = `totalMin` / `arriveAt` / `rides[].minutes` / `rides[].waitMin` / `transfers[].waitMin`
 * （这几个正是本模块**允许**改的），其余必须原样。
 * 判定方式：把这些时间字段**抹平**成同一常量后 `JSON.stringify` 全等。
 */
function maskedJson(card: RecommendCard): string {
  const clone = {
    ...card,
    totalMin: 0,
    arriveAt: 0,
    rides: card.rides.map((r) => ({ ...r, minutes: 0, waitMin: 0 })),
    transfers: (card.transfers ?? []).map((t) => ({ ...t, waitMin: 0 })),
  };
  return JSON.stringify(clone);
}

/* ══════════════════════ 用例 ══════════════════════ */

const routeIdx = makeRouteIdx();
const segIdx = buildSegmentIndex(makeSegRows());
const headway = makeHeadway();
const BASE_MS = Date.UTC(2026, 10, 3, 4, 0, 0); // 澳门 12:00 ⇒ 命中 daily 时段

const ctx: RemainingCtx = { routeIdx, segIdx, nowBucket: "all", headway };
const ctxNoHeadway: RemainingCtx = { ...ctx, headway: null };

console.log("═══ 剩余时间重算 · 纯函数回归（全离线，不连库）═══\n");

/* ── ① 有 segRemainSec ── */
console.log("① 当前腿有 segRemainSec");
{
  const card = mkTwoLegCard(BASE_MS);
  const r = recomputeRemaining(ctx, { card, legIndex: 0, segRemainSec: 120, nowMs: BASE_MS });
  // 剩余 = 2（本段剩余）+ 2（换乘步行）+ 8.7（B2 候车重估）+ 8（B2 乘车）+ 2（末段步行）= 22.7
  ok(r.remainingMin === 22.7, "remainingMin = 22.7（2 + 2 + 8.7 + 8 + 2）", `实际 ${r.remainingMin}`);
  ok(r.patchedCard.rides[0]!.minutes === 2, "patchedCard 当前腿 minutes 改为剩余 2", `实际 ${r.patchedCard.rides[0]!.minutes}`);
  ok(r.arriveAtMs === BASE_MS + Math.round(22.7 * 60_000), "arriveAtMs = nowMs + remainingMin×60000");
  ok(r.retimedWaits.length === 1 && r.retimedWaits[0]!.source === "headway", "候车重估走 headway 档", JSON.stringify(r.retimedWaits));
}

/* ── ② 无 segRemainSec → 回退全段静态分钟 ── */
console.log("\n② 当前腿无 segRemainSec（回退该段全量静态分钟）");
{
  const card = mkTwoLegCard(BASE_MS);
  const r = recomputeRemaining(ctx, { card, legIndex: 0, segRemainSec: null, nowMs: BASE_MS });
  // 8（B1 全段）+ 2 + 8.7 + 8 + 2 = 28.7
  ok(r.remainingMin === 28.7, "remainingMin = 28.7（8 + 2 + 8.7 + 8 + 2）", `实际 ${r.remainingMin}`);
  ok(r.patchedCard.rides[0]!.minutes === 8, "回退值 = 该段静态分钟 8", `实际 ${r.patchedCard.rides[0]!.minutes}`);
}

/* ── ③ 无 segRemainSec 但有 nextIdx → 逐跳累加 ── */
console.log("\n③ 无 segRemainSec 但有 nextIdx（逐跳累加，同前端 NavDetailBody 口径）");
{
  const card = mkTwoLegCard(BASE_MS);
  // B1 = A1→A2→A3，codes = [A1, A2, A3]；nextIdx=1 ⇒ 只累加 A2→A3 一跳 = 4 分
  const r = recomputeRemaining(ctx, { card, legIndex: 0, segRemainSec: null, nextIdx: 1, nowMs: BASE_MS });
  ok(r.patchedCard.rides[0]!.minutes === 4, "nextIdx=1 ⇒ 本段剩余 4 分（仅 A2→A3）", `实际 ${r.patchedCard.rides[0]!.minutes}`);
  ok(r.remainingMin === 24.7, "remainingMin = 24.7（4 + 2 + 8.7 + 8 + 2）", `实际 ${r.remainingMin}`);
  const r2 = recomputeRemaining(ctx, { card, legIndex: 0, segRemainSec: null, nextIdx: 0, nowMs: BASE_MS });
  ok(r2.patchedCard.rides[0]!.minutes === 8, "nextIdx=0 ⇒ 8 分（两跳）= 全段", `实际 ${r2.patchedCard.rides[0]!.minutes}`);
}

/* ── ④ remainingMin 永不为负 ── */
console.log("\n④ remainingMin 永不为负");
{
  const card = mkTwoLegCard(BASE_MS);
  // nowMs 比原 arriveAt 晚 2 小时，且本段剩余为 0 ⇒ 下游全 0 也不该出负数
  const late = BASE_MS + 120 * 60_000;
  const r = recomputeRemaining(ctx, { card, legIndex: 1, segRemainSec: 0, nowMs: late });
  ok(r.remainingMin >= 0, "极端晚点场景 remainingMin ≥ 0", `实际 ${r.remainingMin}`);
  ok(r.patchedCard.totalMin >= 0, "patchedCard.totalMin ≥ 0", `实际 ${r.patchedCard.totalMin}`);
  ok(r.arriveAtMs >= late, "arriveAtMs 不早于 nowMs", `实际 ${r.arriveAtMs - late}ms`);
  // 另一个方向：负的 segRemainSec 被 route 层拒绝，这里防御性归 0
  const r2 = recomputeRemaining(ctx, { card, legIndex: 0, segRemainSec: -60, nowMs: BASE_MS });
  ok(r2.patchedCard.rides[0]!.minutes === 8, "负 segRemainSec 视为无效 ⇒ 回退静态分钟（不产生负数）", `实际 ${r2.patchedCard.rides[0]!.minutes}`);
}

/* ── ⑤ patchedCard 其余字段逐字节一致 ── */
console.log("\n⑤ patchedCard 除时间字段外逐字段一致");
{
  const card = mkTwoLegCard(BASE_MS);
  const r = recomputeRemaining(ctx, { card, legIndex: 0, segRemainSec: 120, nowMs: BASE_MS });
  ok(maskedJson(r.patchedCard) === maskedJson(card), "抹平时间字段后 JSON 全等", `${maskedJson(card).length} bytes`);
  ok(r.patchedCard.planId === card.planId && r.patchedCard.summary === card.summary, "非时间字段（planId/summary）不变");
  ok(
    r.patchedCard.walkOut.minutes === 3 && r.patchedCard.walkIn.minutes === 2,
    "walkOut / walkIn 原样（已发生的出发步行不计入剩余）",
  );
}

/* ── ⑥ buildStrips(patchedCard) 确实随 card 变 ── */
console.log("\n⑥ buildStrips 的 rideMin / waitMin 随 patchedCard 变化");
{
  const card = mkTwoLegCard(BASE_MS);
  const stripCtx = { routeIdx, segIdx, nameOf: routeIdx.nameOf, nowBucket: "all" };
  const before: SegmentStrip[] = buildStrips(card, stripCtx);
  const r = recomputeRemaining(ctx, { card, legIndex: 0, segRemainSec: 120, nowMs: BASE_MS });
  const after: SegmentStrip[] = buildStrips(r.patchedCard, stripCtx);
  ok(before[0]!.rideMin === 8, "原 card 首段 rideMin = 8", `实际 ${before[0]!.rideMin}`);
  ok(after[0]!.rideMin === 2, "patched 后首段 rideMin = 2（剩余）", `实际 ${after[0]!.rideMin}`);
  ok(before[0]!.transferAfter?.waitMin === 3, "原 card 换乘 waitMin = 3", `实际 ${before[0]!.transferAfter?.waitMin}`);
  ok(after[0]!.transferAfter?.waitMin === 8.7, "patched 后换乘 waitMin = 8.7（重估）", `实际 ${after[0]!.transferAfter?.waitMin}`);
  ok(after[1]!.rideMin === 8, "下游段 rideMin 仍为静态 8（乘车分钟不重估）", `实际 ${after[1]!.rideMin}`);
  ok(
    after[0]!.stops.length === before[0]!.stops.length && after[1]!.stops.length === before[1]!.stops.length,
    "站条节点数不变（几何/站序不含时间，不该被影响）",
  );
}

/* ── ⑦ 下游候车按「到达该换乘站的绝对时刻」重估 ── */
console.log("\n⑦ 候车按到达换乘站的绝对时刻重估（核心价值）");
{
  const card = mkTwoLegCard(BASE_MS);
  // 本段剩余 2 分 + 换乘步行 2 分 = 4 分后到 A3。B2 是 daily 00:00-23:59 定区间 ⇒ 恒命中
  const r = recomputeRemaining(ctx, { card, legIndex: 0, segRemainSec: 120, nowMs: BASE_MS });
  ok(r.retimedWaits[0]!.waitMin === 8.7, "B2 候车 3 → 8.7（(6+2×10)/3 = 8.67）", `实际 ${r.retimedWaits[0]!.waitMin}`);
  ok(r.patchedCard.rides[1]!.waitMin === 8.7, "回写 rides[1].waitMin");
  ok(r.patchedCard.transfers[0]!.waitMin === 8.7, "同时回写 transfers[0].waitMin（两处必须同值）");

  // headway=null ⇒ 保留卡面原值（保守，不归零）
  const r2 = recomputeRemaining(ctxNoHeadway, { card, legIndex: 0, segRemainSec: 120, nowMs: BASE_MS });
  ok(r2.patchedCard.rides[1]!.waitMin === 3, "headway=null ⇒ 保留原值 3（不归零，避免乐观偏差）", `实际 ${r2.patchedCard.rides[1]!.waitMin}`);
  ok(r2.retimedWaits[0]!.source === "kept", "source 标为 kept（可被日志看见）");
}

/* ── ⑧ 单段卡：headway=null 也能算 ── */
console.log("\n⑧ 单段卡（headway=null，无需下游候车）");
{
  const card = mkOneLegCard(BASE_MS);
  const r = recomputeRemaining(ctxNoHeadway, { card, legIndex: 0, segRemainSec: 300, nowMs: BASE_MS });
  ok(near(r.remainingMin, 7), "remainingMin = 5 + 2 = 7（本段剩余 + 末段步行）", `实际 ${r.remainingMin}`);
  ok(r.retimedWaits.length === 0, "无下游段 ⇒ 无重估明细");
  const stripCtx = { routeIdx, segIdx, nameOf: routeIdx.nameOf, nowBucket: "all" };
  const strips = buildStrips(r.patchedCard, stripCtx);
  ok(strips.length === 1 && strips[0]!.rideMin === 5, "单段 strips 的 rideMin = 5", `实际 ${strips[0]?.rideMin}`);
}

/* ── ⑨ legIndex 越界被夹取 ── */
console.log("\n⑨ legIndex 越界被夹取（防御）");
{
  const card = mkTwoLegCard(BASE_MS);
  const hi = recomputeRemaining(ctx, { card, legIndex: 99, segRemainSec: 60, nowMs: BASE_MS });
  ok(hi.patchedCard.rides[1]!.minutes === 1, "legIndex=99 ⇒ 夹到最后一段", `实际 ${hi.patchedCard.rides[1]!.minutes}`);
  const lo = recomputeRemaining(ctx, { card, legIndex: -5, segRemainSec: 60, nowMs: BASE_MS });
  ok(lo.patchedCard.rides[0]!.minutes === 1, "legIndex=-5 ⇒ 夹到第一段", `实际 ${lo.patchedCard.rides[0]!.minutes}`);
  const nan = recomputeRemaining(ctx, { card, legIndex: Number.NaN, segRemainSec: 60, nowMs: BASE_MS });
  ok(nan.patchedCard.rides[0]!.minutes === 1, "legIndex=NaN ⇒ 归 0", `实际 ${nan.patchedCard.rides[0]!.minutes}`);
}

/* ── ⑩ 最后一段：不看 transfers ── */
console.log("\n⑩ legIndex = 最后一段时不引入 transfers");
{
  const card = mkTwoLegCard(BASE_MS);
  const r = recomputeRemaining(ctx, { card, legIndex: 1, segRemainSec: 180, nowMs: BASE_MS });
  ok(near(r.remainingMin, 5), "remainingMin = 3 + 2 = 5（本段剩余 + 末段步行）", `实际 ${r.remainingMin}`);
  ok(r.retimedWaits.length === 0, "无下游段");
  ok(r.patchedCard.transfers[0]!.waitMin === 3, "已发生的换乘候车不被改动", `实际 ${r.patchedCard.transfers[0]!.waitMin}`);
}

/* ── ⑪ 无载具段防御 ── */
console.log("\n⑪ 无载具段（异常输入）不崩");
{
  const card = mkOneLegCard(BASE_MS);
  const broken = { ...card, rides: [] as RideLegView[] };
  const r = recomputeRemaining(ctxNoHeadway, { card: broken, legIndex: 0, segRemainSec: null, nowMs: BASE_MS });
  ok(r.remainingMin === 2, "只剩末段步行 2 分", `实际 ${r.remainingMin}`);
  ok(Number.isFinite(r.arriveAtMs), "arriveAtMs 有限");
}

/* ══════════════ ⑫ boarding 误用的漏算量（把边界变成可验证数字）══════════════
 * 模块头「已知边界 ①」说「boarding 调用会漏算当前候车」。文字描述容易被后人读成
 * "大概差几分钟，问题不大" ⇒ 这里把它钉成**精确等式**，让误用的代价一眼可见：
 *
 *     误用偏差 = rides[legIndex].waitMin（当前段候车，整段漏掉）
 *
 * 这条断言的用途是**防回归**：若将来有人为支持 boarding 而改 `recomputeRemaining`
 * 让它把 `waitMin` 也算进去，那么 riding 期的结果会**多算一段已发生的候车** ⇒ 本断言立刻变红，
 * 逼他去改契约（加 `boarded?: boolean`）而不是偷偷改语义。
 */
console.log("\n⑫ boarding 误用的漏算量 = rides[legIndex].waitMin（精确）");
{
  const card = mkTwoLegCard(BASE_MS);
  // 把当前腿候车设成一个显著值，便于观察
  const withWait: RecommendCard = {
    ...card,
    rides: card.rides.map((r, i) => (i === 0 ? { ...r, waitMin: 7.5 } : r)),
  };
  const r = recomputeRemaining(ctx, { card: withWait, legIndex: 0, segRemainSec: 120, nowMs: BASE_MS });
  // 剩余 = 2（本段剩余）+ 2（换乘步行）+ 8.7（下游候车）+ 8（下游乘车）+ 2（末段步行）
  // 注意：**不含** 7.5（当前腿候车）—— 这就是"假设已上车"的体现
  ok(r.remainingMin === 22.7, "当前腿 waitMin=7.5 完全不计入剩余（= 22.7）", `实际 ${r.remainingMin}`);

  // 反证：若把该 waitMin 计入（即 boarding 语义），结果应恰好多 7.5
  const boardingSemantics = 22.7 + 7.5;
  ok(
    boardingSemantics - r.remainingMin === 7.5,
    "⇒ 误用（boarding 相位）的偏差 = rides[legIndex].waitMin = 7.5（精确等式）",
    `boarding 语义应为 ${boardingSemantics}`,
  );

  // 再证：换一个 waitMin 值，偏差随之线性变化（说明是真的"整段漏掉"，不是巧合）
  const withWait2: RecommendCard = {
    ...card,
    rides: card.rides.map((r2, i) => (i === 0 ? { ...r2, waitMin: 0 } : r2)),
  };
  const r2 = recomputeRemaining(ctx, { card: withWait2, legIndex: 0, segRemainSec: 120, nowMs: BASE_MS });
  ok(
    r2.remainingMin === r.remainingMin,
    "当前腿 waitMin 从 7.5 改成 0 ⇒ remainingMin **不变**（证明它根本没参与计算）",
    `7.5时=${r.remainingMin} 0时=${r2.remainingMin}`,
  );
}

/* ══════════════════ ⑬ 时间锚自洽（前端倒计时的硬前提）══════════════════
 * 客户端按 `arriveAt` 做绝对倒计时，同时又拿 `remainingMin` 做总时长显示 ——
 * 两者若不自洽，同一屏上会出现「总时长 22 分、到达时刻却差 25 秒」的互相打架。
 *
 * 契约（★ 必须恒等，不是"约等于"）：
 *     arriveAt === recomputedAt + remainingMin × 60_000
 *
 * 我的实现方式保证了它**结构上恒等**：`arriveAt` 是**由四舍五入后的 `remainingMin`
 * 反推出来的**（`arriveAtMs = nowMs + Math.round(remainingMin × 60_000)`），
 * 而 `recomputedAt = nowMs` ⇒ 恒等式成立且残差恒为 **0**。
 * 代价：`arriveAt` 与"真实计算出的到达时刻"（内部 `cursor`）可能有 ≤3s 的偏差
 *   （`remainingMin` 保留 1 位小数 ⇒ 0.05 分 = 3 秒），但这不影响自洽性。
 */
console.log("\n⑬ 时间锚自洽：arriveAt === recomputedAt + remainingMin × 60000");
{
  const cases: [string, Parameters<typeof recomputeRemaining>[1]][] = [
    ["有 segRemainSec", { card: mkTwoLegCard(BASE_MS), legIndex: 0, segRemainSec: 120, nowMs: BASE_MS }],
    ["无 segRemainSec", { card: mkTwoLegCard(BASE_MS), legIndex: 0, segRemainSec: null, nowMs: BASE_MS }],
    ["有 nextIdx", { card: mkTwoLegCard(BASE_MS), legIndex: 0, segRemainSec: null, nextIdx: 1, nowMs: BASE_MS }],
    ["最后一段", { card: mkTwoLegCard(BASE_MS), legIndex: 1, segRemainSec: 180, nowMs: BASE_MS }],
    ["单段卡", { card: mkOneLegCard(BASE_MS), legIndex: 0, segRemainSec: 300, nowMs: BASE_MS }],
    ["晚点（clamp 到 0）", { card: mkTwoLegCard(BASE_MS), legIndex: 1, segRemainSec: 0, nowMs: BASE_MS + 120 * 60_000 }],
    ["亚分钟小数", { card: mkTwoLegCard(BASE_MS), legIndex: 0, segRemainSec: 7, nowMs: BASE_MS }],
    ["奇数秒（易暴露取整）", { card: mkTwoLegCard(BASE_MS), legIndex: 0, segRemainSec: 13, nowMs: BASE_MS }],
  ];
  for (const [label, input] of cases) {
    const r = recomputeRemaining(ctx, input);
    const expect = input.nowMs! + r.remainingMin * 60_000;
    const diff = r.arriveAtMs - expect;
    // 恒等 ⇒ 残差必须恰好 0（不是"小于某容差"）
    ok(diff === 0, `${label}：arriveAt 恒等于 recomputedAt + remainingMin×60000（残差 ${diff}ms）`);
  }
  // 与"真实 cursor"的偏差上界：remainingMin 保留 1 位小数 ⇒ ≤0.05 分 = 3000ms
  //   ⚠️ 精确值必须**按实际入参算**，不要抄别处的常量（曾抄错一个 2.5 vs 13s 的差 ⇒ 假失败）
  {
    const segRemainSec = 13;
    const input: Parameters<typeof recomputeRemaining>[1] = {
      card: mkTwoLegCard(BASE_MS),
      legIndex: 0,
      segRemainSec,
      nowMs: BASE_MS,
    };
    const r = recomputeRemaining(ctx, input);
    const card = input.card;
    // 逐项复算（与 remaining.ts 时间轴同序：本段剩余 → (换乘步行 → 候车 → 乘车)* → 末段步行）
    //   候车取重估值 8.7（(6+2×10)/3 = 8.6667 → round1），本段剩余 = segRemainSec/60
    const exactMin =
      segRemainSec / 60 +
      (card.transfers[0]?.minutes ?? 0) +
      8.7 +
      (card.rides[1]?.minutes ?? 0) +
      (card.walkIn?.minutes ?? 0);
    const trueCursor = BASE_MS + exactMin * 60_000;
    const dev = Math.abs(r.arriveAtMs - trueCursor);
    ok(
      dev <= 3_000,
      `对"真实到达时刻"的偏差 ≤3000ms（实测 ${dev}ms；exactMin=${round1(exactMin)} 而 remainingMin=${r.remainingMin}）`,
    );
  }
}

/* ══════════════════════ ⑭ 真实索引联调（库不可达则跳过）══════════════════════
 * 与 `scripts/test-route-overview.ts` 用例 9 同款：连库只读。
 * ⚠️ **try/catch 只包「连库」这一步** —— 断言阶段的异常必须冒泡成真失败。
 *    （曾踩过：把断言也包进 try，一个 `ReferenceError` 被当成「库不可达」SKIP 掉，
 *      脚本显示全绿而断言其实从未执行。）
 *
 * 验的是「合成数据验不到」的那一层：真实 `route_stations` + `segment_stats` 下
 *   ① 单段卡重算结果 = 本段剩余 + 末段步行；
 *   ② `buildStrips(patchedCard).rideMin` 严格等于 patched 值；
 *   ③ **逐站 `minToNext` 之和 ≡ `rideOfHops`**（同一串 hops + 同一个 `lookupHop`）
 *      —— 这是 `strips.ts` 与 `model.ts` 同源的真实口径实证；
 *      合成数据只能证结构，证不了「真实库里同源」。
 */
/**
 * 真实库连接池持有者（仅真实索引联调用；连不上则 `pool` 保持 null）。
 *
 * ⚠️ 为什么用**对象**而不是模块级 `let poolForReal: X | null`：
 *   模块级 `let` 只在某个函数体内被赋值时，TS 的控制流分析在顶层仍认为它是初值 `null`，
 *   于是 `poolForReal?.end()` 会被推断成 `never` 上的属性访问 ⇒ **编译报错**。
 *   这正是本文件上一轮 `:488 Property 'end' does not exist on type 'never'` 的成因。
 *   用对象持有后，属性访问不受顶层收窄影响 ⇒ 从根上消除该类脆弱写法。
 */
const realConn: { pool: { end: () => Promise<void> } | null } = { pool: null };

async function loadRealStatics(): Promise<RecStatic | null> {
  try {
    process.loadEnvFile();
    const url = process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL;
    if (!url) throw new Error("无 DATABASE_URL");
    const { default: PG } = await import("pg");
    const pool = new PG.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
    pool.on("error", () => undefined);
    realConn.pool = pool as unknown as { end: () => Promise<void> };
    return await loadStatics(pool);
  } catch (e) {
    console.log(`  SKIP  连库联调跳过（${(e as Error).message}）—— 纯函数门不受影响`);
    return null;
  }
}

/** 真实索引上的断言（**不在 try 里**：异常即失败） */
function realIndexCheck(st: RecStatic): void {
  // 取一条站数 ≥4 的巴士线，用前 3 站造一段腿
  const routeKey = [...st.routeIdx.dirStops.keys()]
    .filter((k) => !k.startsWith("LRT-") && (st.routeIdx.dirStops.get(k)?.length ?? 0) >= 4)
    .sort()[0];
  if (!routeKey) {
    ok(false, "找不到 ≥4 站的巴士线（真实库异常）");
    return;
  }
  const [route, dir] = routeKey.split("|") as [string, string];
  const stops = st.routeIdx.dirStops.get(routeKey)!;
  const board = stops[0]!;
  const alight = stops[2]!;
  const seg = segmentsOf(st.routeIdx, route, board, alight);
  const hops = seg?.segs ?? [];
  // ★ 真实「该段静态分钟」= rideOfHops（model.ts:586 就是用这个），**不是我拍的值**
  const rh = rideOfHops(st.segIdx, route, hops, "all");
  const rideStatic = round1(rh.minutes);

  const nowMs = BASE_MS;
  const card: RecommendCard = {
    planId: 880099,
    summary: "real-index",
    fromSlug: "home",
    toSlug: "school",
    totalMin: 30,
    arriveAt: nowMs + 30 * 60_000,
    walkOut: { minutes: 3, toLabel: board, level: 1, estimated: false, samples: 5, distanceM: 200 },
    walkIn: { minutes: 2, toLabel: "目的地", level: 1, estimated: false, samples: 5, distanceM: 130 },
    rides: [
      {
        route,
        kind: "bus",
        board,
        alight,
        boardLabel: st.routeIdx.nameOf.get(board) ?? board,
        alightLabel: st.routeIdx.nameOf.get(alight) ?? alight,
        minutes: rideStatic,
        hops: hops.length,
        levels: rh.levels,
        waitMin: 3,
        liveText: "",
        tier: 3,
        tierText: "",
        tierHint: "",
      },
    ],
    transfers: [],
    hints: [],
    crossBorder: false,
  };

  const realCtx: RemainingCtx = { routeIdx: st.routeIdx, segIdx: st.segIdx, nowBucket: "all", headway: null };
  const r = recomputeRemaining(realCtx, { card, legIndex: 0, segRemainSec: 150, nowMs });
  ok(near(r.remainingMin, 4.5), `真实线 ${route}：remainingMin = 2.5 + 2 = 4.5`, `实际 ${r.remainingMin}`);
  ok(r.patchedCard.rides[0]!.minutes === 2.5, "patchedCard 本段 minutes = 150s/60 = 2.5");

  const stripCtx = { routeIdx: st.routeIdx, segIdx: st.segIdx, nameOf: st.routeIdx.nameOf, nowBucket: "all" };
  const strips = buildStrips(r.patchedCard, stripCtx);
  ok(strips[0]?.rideMin === 2.5, "buildStrips(patchedCard).rideMin = 2.5", `实际 ${strips[0]?.rideMin}`);

  // ③ 逐站之和 ≡ rideOfHops（同源实证）
  const origStrip = buildStrips(card, stripCtx)[0]!;
  const sum = round1(origStrip.stops.slice(0, -1).reduce((a, x) => a + x.minToNext, 0));
  const levels = origStrip.stops.slice(0, -1).map((s) => s.level);
  ok(near(sum, rideStatic, 0.06), `真实逐站之和 ${sum} ≡ rideOfHops ${rideStatic}（levels=${levels.join("/")}）`);
  console.log(`  实际线路：${route} dir=${dir} ${board} → ${alight}（整线 ${stops.length} 站，${hops.length} 跳）`);
}

(async () => {
  console.log("\n⑭ 真实索引联调（库不可达则跳过，不判失败）");
  const st = await loadRealStatics();
  if (st) realIndexCheck(st);
  if (realConn.pool) await realConn.pool.end().catch(() => undefined);

  console.log(`\n═══ 合计 ${pass + fail} 条：PASS ${pass} / FAIL ${fail} ═══`);
  process.exit(fail === 0 ? 0 : 1);
})();
