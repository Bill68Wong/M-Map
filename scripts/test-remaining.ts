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
 *   ⑭ 基准站规则 `remainFromIdxOf` / `segRemainSecOf`（U3：停靠态基准站 = 所停站；停靠显式给 0）
 *   ⑮ 连续刷新：站间行驶 ↔ 进站停靠 切换不得跳变（单调性 / 恒等式 / B-1·B-2·B-3 / 到达锚上界）
 *   ⑯ 真实索引联调（连库；不可达则跳过）
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
import { progressOf, remainFromIdxOf, segRemainSecOf, stopsAwayOf, type TrackVehicle } from "../src/lib/nav/track";
import { PROGRESS_H, PROGRESS_W } from "../src/lib/nav/progress-params";

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

/* ── ① 有 segRemainSec（**与 nextIdx 成对**：首跳剩余 + 基准站之后逐跳）── */
console.log("① 当前腿有 segRemainSec（+ nextIdx 成对）");
{
  const card = mkTwoLegCard(BASE_MS);
  const r = recomputeRemaining(ctx, { card, legIndex: 0, segRemainSec: 120, nextIdx: 1, nowMs: BASE_MS });
  // 剩余 = 6（本段：首跳 2 + 基准站 A2 之后一跳 4）+ 2（换乘步行）+ 8.7（B2 候车重估）+ 8（B2 乘车）+ 2（末段步行）= 26.7
  //  ⚠️ 旧期望 22.7 是**少算了下游跳**的旧口径（把首跳剩余当整段剩余）；U3 修正后必须 26.7
  ok(r.remainingMin === 26.7, "remainingMin = 26.7（6 + 2 + 8.7 + 8 + 2）", `实际 ${r.remainingMin}`);
  ok(r.patchedCard.rides[0]!.minutes === 6, "patchedCard 当前腿 minutes = 2 + 4 = 6（首跳剩余 + 基准站之后逐跳）", `实际 ${r.patchedCard.rides[0]!.minutes}`);
  ok(r.arriveAtMs === BASE_MS + Math.round(26.7 * 60_000), "arriveAtMs = nowMs + remainingMin×60000");
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

/* ── ②b 只传 segRemainSec、不传 nextIdx（契约收紧）──
 * ── 为什么必须回落「该段全量静态分钟」而不是 `segRemainSec/60` ──────────
 *   `segRemainSec` 只覆盖到**基准站**那一跳；基准站未知时，它既可能是全程的 1/2，
 *   也可能是全部。拿它当整段 ⇒ **少算下游跳**（正是 U3 的根因本体）。
 *   宁可偏长（保守，用户早到不会被骗），也不偏短（会让用户以为快到了）。
 */
console.log("\n②b 只有 segRemainSec（无 nextIdx）⇒ 回落该段静态分钟，不拿它当整段");
{
  const card = mkTwoLegCard(BASE_MS);
  const r = recomputeRemaining(ctx, { card, legIndex: 0, segRemainSec: 120, nowMs: BASE_MS });
  ok(r.patchedCard.rides[0]!.minutes === 8, "segRemainSec 单独出现 ⇒ 本段 8 分（不是 2 分）", `实际 ${r.patchedCard.rides[0]!.minutes}`);
  ok(r.remainingMin === 28.7, "remainingMin = 28.7（与 ② 同值：宁可偏长）", `实际 ${r.remainingMin}`);
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
  const r = recomputeRemaining(ctx, { card, legIndex: 0, segRemainSec: 120, nextIdx: 1, nowMs: BASE_MS });
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
  const r = recomputeRemaining(ctx, { card, legIndex: 0, segRemainSec: 120, nextIdx: 1, nowMs: BASE_MS });
  const after: SegmentStrip[] = buildStrips(r.patchedCard, stripCtx);
  ok(before[0]!.rideMin === 8, "原 card 首段 rideMin = 8", `实际 ${before[0]!.rideMin}`);
  ok(after[0]!.rideMin === 6, "patched 后首段 rideMin = 6（首跳 2 + 下游跳 4）", `实际 ${after[0]!.rideMin}`);
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
  // 本段剩余 2 分（首跳）+ 4 分（基准站之后一跳）+ 换乘步行 2 分 = 8 分后到 A3。B2 是 daily 00:00-23:59 定区间 ⇒ 恒命中
  const r = recomputeRemaining(ctx, { card, legIndex: 0, segRemainSec: 120, nextIdx: 1, nowMs: BASE_MS });
  ok(r.retimedWaits[0]!.waitMin === 8.7, "B2 候车 3 → 8.7（(6+2×10)/3 = 8.67）", `实际 ${r.retimedWaits[0]!.waitMin}`);
  ok(r.patchedCard.rides[1]!.waitMin === 8.7, "回写 rides[1].waitMin");
  ok(r.patchedCard.transfers[0]!.waitMin === 8.7, "同时回写 transfers[0].waitMin（两处必须同值）");

  // headway=null ⇒ 保留卡面原值（保守，不归零）
  const r2 = recomputeRemaining(ctxNoHeadway, { card, legIndex: 0, segRemainSec: 120, nextIdx: 1, nowMs: BASE_MS });
  ok(r2.patchedCard.rides[1]!.waitMin === 3, "headway=null ⇒ 保留原值 3（不归零，避免乐观偏差）", `实际 ${r2.patchedCard.rides[1]!.waitMin}`);
  ok(r2.retimedWaits[0]!.source === "kept", "source 标为 kept（可被日志看见）");
}

/* ── ⑧ 单段卡：headway=null 也能算 ── */
console.log("\n⑧ 单段卡（headway=null，无需下游候车）");
{
  const card = mkOneLegCard(BASE_MS);
  // B1 = A1→A2→A3→A4，codes = [A1,A2,A3,A4]；nextIdx=3 = 下车站 ⇒ 首跳剩余 5 + 之后 0 跳
  const r = recomputeRemaining(ctxNoHeadway, { card, legIndex: 0, segRemainSec: 300, nextIdx: 3, nowMs: BASE_MS });
  ok(near(r.remainingMin, 7), "remainingMin = 5 + 2 = 7（首跳剩余 + 末段步行）", `实际 ${r.remainingMin}`);
  ok(r.retimedWaits.length === 0, "无下游段 ⇒ 无重估明细");
  const stripCtx = { routeIdx, segIdx, nameOf: routeIdx.nameOf, nowBucket: "all" };
  const strips = buildStrips(r.patchedCard, stripCtx);
  ok(strips.length === 1 && strips[0]!.rideMin === 5, "单段 strips 的 rideMin = 5", `实际 ${strips[0]?.rideMin}`);
}

/* ── ⑨ legIndex 越界被夹取 ── */
console.log("\n⑨ legIndex 越界被夹取（防御）");
{
  const card = mkTwoLegCard(BASE_MS);
  // 判定「夹到了哪一段」靠**哪一段的 minutes 被改写**（两段静态都是 8，不能只看数值）
  const hi = recomputeRemaining(ctx, { card, legIndex: 99, segRemainSec: 60, nextIdx: 1, nowMs: BASE_MS });
  ok(hi.patchedCard.rides[1]!.minutes === 5, "legIndex=99 ⇒ 夹到最后一段（1 + 4 = 5）", `实际 ${hi.patchedCard.rides[1]!.minutes}`);
  ok(hi.patchedCard.rides[0]!.minutes === 8, "  首段未被改写（证明夹取方向正确）", `实际 ${hi.patchedCard.rides[0]!.minutes}`);
  const lo = recomputeRemaining(ctx, { card, legIndex: -5, segRemainSec: 60, nextIdx: 1, nowMs: BASE_MS });
  ok(lo.patchedCard.rides[0]!.minutes === 5, "legIndex=-5 ⇒ 夹到第一段（1 + 4 = 5）", `实际 ${lo.patchedCard.rides[0]!.minutes}`);
  ok(lo.patchedCard.rides[1]!.minutes === 8, "  末段未被改写", `实际 ${lo.patchedCard.rides[1]!.minutes}`);
  const nan = recomputeRemaining(ctx, { card, legIndex: Number.NaN, segRemainSec: 60, nextIdx: 1, nowMs: BASE_MS });
  ok(nan.patchedCard.rides[0]!.minutes === 5, "legIndex=NaN ⇒ 归 0（第一段）", `实际 ${nan.patchedCard.rides[0]!.minutes}`);
}

/* ── ⑩ 最后一段：不看 transfers ── */
console.log("\n⑩ legIndex = 最后一段时不引入 transfers");
{
  const card = mkTwoLegCard(BASE_MS);
  // B2 = A3→A5→A6，nextIdx=1 ⇒ 首跳 3 + A5→A6 一跳 4 = 7
  const r = recomputeRemaining(ctx, { card, legIndex: 1, segRemainSec: 180, nextIdx: 1, nowMs: BASE_MS });
  ok(near(r.remainingMin, 9), "remainingMin = 3 + 4 + 2 = 9（首跳 + 下游跳 + 末段步行）", `实际 ${r.remainingMin}`);
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
  const r = recomputeRemaining(ctx, { card: withWait, legIndex: 0, segRemainSec: 120, nextIdx: 1, nowMs: BASE_MS });
  // 剩余 = 6（首跳 2 + 基准站之后 4）+ 2（换乘步行）+ 8.7（下游候车）+ 8（下游乘车）+ 2（末段步行）
  // 注意：**不含** 7.5（当前腿候车）—— 这就是"假设已上车"的体现
  ok(r.remainingMin === 26.7, "当前腿 waitMin=7.5 完全不计入剩余（= 26.7）", `实际 ${r.remainingMin}`);

  // 反证：若把该 waitMin 计入（即 boarding 语义），结果应恰好多 7.5
  const boardingSemantics = round1(26.7 + 7.5);
  ok(
    // 比对走 round1：34.2 − 26.7 在二进制浮点下是 7.499999…996，取 1 位小数才是本行的语义
    round1(boardingSemantics - r.remainingMin) === 7.5,
    "⇒ 误用（boarding 相位）的偏差 = rides[legIndex].waitMin = 7.5（精确等式）",
    `boarding 语义应为 ${boardingSemantics}`,
  );

  // 再证：换一个 waitMin 值，偏差随之线性变化（说明是真的"整段漏掉"，不是巧合）
  const withWait2: RecommendCard = {
    ...card,
    rides: card.rides.map((r2, i) => (i === 0 ? { ...r2, waitMin: 0 } : r2)),
  };
  const r2 = recomputeRemaining(ctx, { card: withWait2, legIndex: 0, segRemainSec: 120, nextIdx: 1, nowMs: BASE_MS });
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
    ["有 segRemainSec", { card: mkTwoLegCard(BASE_MS), legIndex: 0, segRemainSec: 120, nextIdx: 1, nowMs: BASE_MS }],
    ["有 segRemainSec 但无 nextIdx", { card: mkTwoLegCard(BASE_MS), legIndex: 0, segRemainSec: 120, nowMs: BASE_MS }],
    ["无 segRemainSec", { card: mkTwoLegCard(BASE_MS), legIndex: 0, segRemainSec: null, nowMs: BASE_MS }],
    ["有 nextIdx", { card: mkTwoLegCard(BASE_MS), legIndex: 0, segRemainSec: null, nextIdx: 1, nowMs: BASE_MS }],
    ["最后一段", { card: mkTwoLegCard(BASE_MS), legIndex: 1, segRemainSec: 180, nextIdx: 1, nowMs: BASE_MS }],
    ["单段卡", { card: mkOneLegCard(BASE_MS), legIndex: 0, segRemainSec: 300, nextIdx: 3, nowMs: BASE_MS }],
    ["晚点（clamp 到 0）", { card: mkTwoLegCard(BASE_MS), legIndex: 1, segRemainSec: 0, nextIdx: 1, nowMs: BASE_MS + 120 * 60_000 }],
    ["停靠态（segRemainSec=0）", { card: mkTwoLegCard(BASE_MS), legIndex: 0, segRemainSec: 0, nextIdx: 1, nowMs: BASE_MS }],
    ["亚分钟小数", { card: mkTwoLegCard(BASE_MS), legIndex: 0, segRemainSec: 7, nextIdx: 1, nowMs: BASE_MS }],
    ["奇数秒（易暴露取整）", { card: mkTwoLegCard(BASE_MS), legIndex: 0, segRemainSec: 13, nextIdx: 1, nowMs: BASE_MS }],
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
    const nextIdx = 1;
    const input: Parameters<typeof recomputeRemaining>[1] = {
      card: mkTwoLegCard(BASE_MS),
      legIndex: 0,
      segRemainSec,
      nextIdx,
      nowMs: BASE_MS,
    };
    const r = recomputeRemaining(ctx, input);
    const card = input.card;
    // 逐项复算（与 remaining.ts 时间轴同序：本段剩余 → (换乘步行 → 候车 → 乘车)* → 末段步行）
    //   本段剩余 = segRemainSec/60 + 「基准站之后逐跳」= 13/60 + 4（A2→A3 一跳）
    //   候车取重估值 8.7（(6+2×10)/3 = 8.6667 → round1）
    const exactMin =
      segRemainSec / 60 +
      4 + // hopMinutesFrom(ctx, rides[0], nextIdx=1) = A2→A3 一跳
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

/* ══════════════ ⑭ 基准站规则（U3）——「到下一站」与「整段剩余」的分界 ══════════════
 * 这一节单独测 `track.ts` 的两条纯规则，因为 U3 的根因就在「基准站取错」：
 *   停靠态的 `prog.nextIdx` 是**所停站的下一站**，从那里起累加会整跳漏掉
 *   「所停站 → 下一站」；行驶态则必须用 `nextIdx`（区间终点），因为
 *   `segRemainSec` 正是「到该站」的剩余。
 */
console.log("\n⑭ 基准站规则 remainFromIdxOf / segRemainSecOf（纯函数）");
{
  // ① 真实帧推导：车停靠在 A2（站序 [A1,A2,A3]）⇒ 基准站必须是 1，而 prog.nextIdx 是 2
  const stopMains = ["A1", "A2", "A3"];
  const atA2: TrackVehicle = {
    plate: "T1",
    lat: 0,
    lng: 0,
    status: "stopping",
    interval: null,
    atStation: { code: "A2" },
    progress: null,
  };
  const progAt = progressOf(stopMains, atA2);
  ok(progAt.kind === "at" && progAt.nextIdx === 2, "progressOf 停靠 A2 ⇒ nextIdx = 2（所停站的下一站）", `${progAt.kind}/${progAt.nextIdx}`);
  ok(remainFromIdxOf(progAt) === 1, "remainFromIdxOf 停靠 A2 ⇒ 基准站 = 1（**所停站本身**，不是 nextIdx）", `实际 ${remainFromIdxOf(progAt)}`);

  const moving: TrackVehicle = {
    plate: "T1",
    lat: 0,
    lng: 0,
    status: "moving",
    interval: { from: { code: "A1" }, to: { code: "A2" } },
    atStation: null,
    progress: null,
  };
  const progBetween = progressOf(stopMains, moving);
  ok(
    remainFromIdxOf(progBetween) === 1,
    "remainFromIdxOf 行驶中(A1→A2) ⇒ 基准站 = A2 的下标 1（区间终点）",
    `实际 ${remainFromIdxOf(progBetween)}`,
  );

  // ② 边界：末站停靠（nextIdx 为 null）仍要给出基准站 = 末站
  ok(
    remainFromIdxOf({ kind: "at", passedIdx: 2, atIdx: 3, nextIdx: null }) === 3,
    "末站停靠（nextIdx=null）⇒ 基准站 = atIdx = 3",
  );
  ok(
    remainFromIdxOf({ kind: "between", passedIdx: 1, atIdx: null, nextIdx: null }) === 2,
    "行驶态 nextIdx 缺失 ⇒ 基准站退化为 passedIdx + 1（该兜底**可达**：区间起点已是末站）",
  );
  /* 对象不自洽：`kind==="at"` 但 `atIdx` 为 null（`progressOf` 造不出来）⇒ **如实 null**，
   * 不拿 `passedIdx + 1` 去猜 —— 猜了会把"数据不自洽"伪装成"正常"，下游就看不到出问题。 */
  ok(
    remainFromIdxOf({ kind: "at", passedIdx: 1, atIdx: null, nextIdx: 2 }) === null,
    "停靠态但 atIdx 缺失（不自洽）⇒ 基准站 null（不猜）",
  );
  // ③ 数据对不上 ⇒ 如实 null，不猜
  ok(remainFromIdxOf({ kind: "lost", passedIdx: -1, atIdx: null, nextIdx: null }) === null, "lost ⇒ null（不猜）");
  ok(remainFromIdxOf({ kind: "unknown", passedIdx: -1, atIdx: null, nextIdx: null }) === null, "unknown ⇒ null（不猜）");
  ok(remainFromIdxOf(null) === null, "null ⇒ null");

  // ④ 停靠态显式给 0
  ok(segRemainSecOf(true, null) === 0, "明确停靠 + 无位置模型 ⇒ 0（不是 null）");
  ok(segRemainSecOf(true, 123) === 0, "明确停靠 + 有位置模型 ⇒ 仍 0（停靠时首跳剩余已走完）");
  ok(segRemainSecOf(false, 123) === 123, "未停靠 ⇒ 原样透传融合值");
  ok(segRemainSecOf(false, null) === null, "未停靠且无融合值 ⇒ null（回退逐跳累加）");
  ok(segRemainSecOf(false, -5) === null, "负融合值 ⇒ null（脏数据不外泄）");
  ok(segRemainSecOf(false, Number.NaN) === null, "NaN ⇒ null");

  /* ⑤ `stopsAwayOf`：「还有几站下车」与基准站同源（修停靠态多算 1 站的 off-by-one）
   * ── 为什么这条必须有 ──────────────────────────────────────────────────
   *   `progressOf` 停靠分支给 `passedIdx = atIdx − 1`（track.ts:76-86）。
   *   若按「已过站数」算 `lastIdx − passedIdx`，停靠在第 k 站会得出 `lastIdx − k + 1`
   *   —— 比真实剩余跳数多 1 站；而行驶态 `nextIdx = k+1` 恰好算对
   *   ⇒ 这个错**只在停靠时出现**，还会与「即将到达」的到站提醒同屏打架。
   *   全部用**真实 `progressOf` 产物**喂，不手搓 TrackProgress 字面量（避免"测的是我抄的期望"）。
   *
   * ── ★ 本组变异自检曾在**实现阶段**拦下一次错误口径（保留它的原因）──────────
   *   当时的裁决是「站数复用 `remainFromIdxOf`（分钟用的基准站），同源就不会漂」。
   *   照此实现后，下面那条 `[变异] 行驶态两者同值` 立刻变红（旧=1 新=0）：
   *   车在 2→3 区间、下车站是 3 时，复用会算出 0（写「还有 0 站下车」），
   *   而正确值是 1 —— 只是把「多 1」翻成了「少 1」，矛盾没消掉。
   *   这条错误**只有这组断言看得见**（真机上表现为「到站前一站数字突然变 0」，
   *   人眼很难判定是错）：所以**不要**删掉 `[变异] 行驶态两者同值` 这条，
   *   也不要把它改成"只测停靠态"——它是"两锚站不同"的唯一守卫。
   */
  {
    const lastIdx = stopMains.length - 1; // [A1,A2,A3] ⇒ 2 = 下车站
    const atSt = (code: string): TrackVehicle => ({
      plate: "T1",
      lat: 0,
      lng: 0,
      status: "stopping",
      interval: null,
      atStation: { code },
      progress: null,
    });
    const onHop = (from: string, to: string): TrackVehicle => ({
      plate: "T1",
      lat: 0,
      lng: 0,
      status: "moving",
      interval: { from: { code: from }, to: { code: to } },
      atStation: null,
      progress: null,
    });

    const pAt1 = progressOf(stopMains, atSt("A2")); // 停靠在中间站（下标 1）
    const pAtAlight = progressOf(stopMains, atSt("A3")); // 停靠在下车站
    const pAtBoard = progressOf(stopMains, atSt("A1")); // 停靠在上车站（还没发车）
    const pMoving = progressOf(stopMains, onHop("A2", "A3")); // 行驶在中→下

    ok(stopsAwayOf(pAt1, lastIdx) === 1, "停靠中间站(1) ⇒ 还有 1 站（真实剩余 1 跳）", `实际 ${stopsAwayOf(pAt1, lastIdx)}`);
    ok(stopsAwayOf(pMoving, lastIdx) === 1, "行驶在中→下 ⇒ 还有 1 站（正在开往的那一站要算）", `实际 ${stopsAwayOf(pMoving, lastIdx)}`);
    ok(stopsAwayOf(pAtAlight, lastIdx) === 0, "停靠下车站 ⇒ 0 站（次行此时提前返回「本站下车」）", `实际 ${stopsAwayOf(pAtAlight, lastIdx)}`);
    ok(stopsAwayOf(pAtBoard, lastIdx) === 2, "停靠上车站 ⇒ 还有 2 站（全段未走）", `实际 ${stopsAwayOf(pAtBoard, lastIdx)}`);
    /** ★ 这一条专门锁「行驶态不得少算 1 站」：直接复用 `remainFromIdxOf`（区间终点站）会算成 0 */
    {
      const pOnHop0 = progressOf(stopMains, onHop("A1", "A2"));
      ok(
        stopsAwayOf(pOnHop0, lastIdx) === 2,
        "行驶在上→中 ⇒ 还有 2 站（复用「分钟」基准站会错算成 1）",
        `实际 ${stopsAwayOf(pOnHop0, lastIdx)}`,
      );
      ok(
        stopsAwayOf(pOnHop0, lastIdx) !== lastIdx - remainFromIdxOf(pOnHop0)!,
        "站数锚站 ≠ 分钟基准站（前者含正在开往的那一站，差 1 是语义必然）",
        `站数锚=${lastIdx - stopsAwayOf(pOnHop0, lastIdx)!} 分钟基准=${remainFromIdxOf(pOnHop0)}`,
      );
    }
    ok(stopsAwayOf(null, lastIdx) === null, "无进度 ⇒ null（不写「还有 0 站」）");
    ok(
      stopsAwayOf({ kind: "lost", passedIdx: -1, atIdx: null, nextIdx: null }, lastIdx) === null,
      "丢信号 ⇒ null（不猜站数）",
    );
    ok(stopsAwayOf(pAt1, 0) === null, "站序不足两站（lastIdx=0）⇒ null");
    ok(
      stopsAwayOf({ kind: "at", passedIdx: 1, atIdx: null, nextIdx: 2 }, lastIdx) === null,
      "停靠态但 atIdx 缺失（不自洽）⇒ null（不拿 passedIdx+1 猜）",
    );

    /* 变异自检：旧公式（按已过站数算）在**停靠态**必多 1 站 —— 这条是 off-by-one 的可检出证据 */
    const oldFormula = (p: typeof pAt1): number => Math.max(0, lastIdx - p.passedIdx);
    ok(
      oldFormula(pAt1) === 2 && stopsAwayOf(pAt1, lastIdx) === 1,
      "[变异] 旧公式（lastIdx − passedIdx）停靠态多算 1 站能被检出",
      `旧=${oldFormula(pAt1)} 新=${stopsAwayOf(pAt1, lastIdx)}`,
    );
    ok(
      oldFormula(pMoving) === stopsAwayOf(pMoving, lastIdx),
      "[变异] 行驶态两者同值（说明这个 off-by-one **只在停靠时**出现）",
      `旧=${oldFormula(pMoving)} 新=${stopsAwayOf(pMoving, lastIdx)}`,
    );
  }
}

/* ══════════════ ⑮ 连续刷新：切换瞬间不得跳变（U3 · 根因证据 + 回归锁）══════════════
 *
 * ── 这一节在验什么 ────────────────────────────────────────────────────
 *   车辆在「站间行驶」与「进站停靠」之间切换时，刷新后的**预计到达时刻不得整段上涨**。
 *   判据全部从**记录序列**直接检验（不依赖任何实现细节）：
 *     · 单调性   —— 相邻两次 `remainingMin` 之差 ≤ 0.25 分（时间只会往前走）
 *     · 恒等式   —— `arriveAt − (nowMs + remainingMin×60000)` 残差**恰好 0**
 *     · B-1 方向 —— 切换瞬间 `remaining[i+1] − remaining[i] ≤ +0.1`
 *     · B-2 幅度 —— 进站那一步（前后基准站同为站 i）`|Δ| ≤ |segRemainSec[i]/60| + 0.1`
 *     · B-3 幅度 —— 任何一步 `|Δ| ≤ md/60 + 0.1`（完成一跳不可能超过该跳中位时长）
 *     · 到达锚上界 —— 单段卡相邻两次 `|ΔarriveAt| ≤ 15000 ms`
 *
 * ── 帧怎么造（与线上同式，不是编数字）──────────────────────────────────
 *   `fused = w·D + (1−w)·max(md−u, 0)`，`D = md·h[段型][⌊(1−p)·20⌋]`
 *   —— 与 `useRideTracking.ts:996` 逐字同式；`md` 取合成卡里每跳 4 分（与 `makeSegRows` 一致），
 *   刷新间隔取车辆轮询 `POLL_MS = 12s`（`useRideTracking.ts`）。
 *   停靠帧的载荷按**修好后的客户端**造：`segRemainSec = 0` 且 `nextIdx = 基准站 = 所停站`。
 */
console.log("\n⑮ 连续刷新：站间行驶 ↔ 进站停靠 切换不得跳变");
{
  /** 与 `useRideTracking.ts:996` 同式的位置模型融合值 */
  const fusedSecOf = (mdSec: number, uSec: number): number => {
    const p = Math.min(1, Math.max(0, uSec / mdSec));
    const b = Math.min(19, Math.max(0, Math.floor((1 - p) * 20)));
    const D = mdSec * PROGRESS_H.short[b]!;
    return PROGRESS_W.short * D + (1 - PROGRESS_W.short) * Math.max(mdSec - uSec, 0);
  };
  const MD_SEC = 240; // 每跳 4 分（= makeSegRows 的 avg_minutes）
  const STEP_MS = 12_000; // 车辆轮询节拍

  interface SimFrame {
    label: string;
    nowMs: number;
    /** 车辆帧显式停靠在本段站（`atStation` 存在且 `status === "stopping"`） */
    stopped: boolean;
    /** 客户端位置模型融合值（停靠帧无 progress ⇒ null） */
    fused: number | null;
    /** 客户端算出的基准站（`remainFromIdxOf(prog)`） */
    pivot: number;
  }

  /** 沿一条腿逐跳生成帧序列（每帧 12s，含每站的停靠帧） */
  const framesOf = (hopCount: number, t0: number): SimFrame[] => {
    const out: SimFrame[] = [];
    let t = t0;
    for (let hop = 0; hop < hopCount; hop++) {
      for (let u = STEP_MS / 1000; u <= MD_SEC - STEP_MS / 1000; u += STEP_MS / 1000) {
        out.push({
          label: `第${hop + 1}跳 u=${u}s`,
          nowMs: t,
          stopped: false,
          fused: fusedSecOf(MD_SEC, u),
          pivot: hop + 1,
        });
        t += STEP_MS;
      }
      // 停靠帧：基准站 = **所停站**（= 第 hop 跳的终点站，下标 hop + 1）
      out.push({ label: `停靠第${hop + 1}站`, nowMs: t, stopped: true, fused: null, pivot: hop + 1 });
      t += STEP_MS;
    }
    out.push({ label: `停靠末站`, nowMs: t, stopped: true, fused: null, pivot: hopCount });
    return out;
  };

  /** 修好后的客户端载荷 */
  const payloadOf = (card: RecommendCard, f: SimFrame): Parameters<typeof recomputeRemaining>[1] => ({
    card,
    legIndex: 0,
    segRemainSec: segRemainSecOf(f.stopped, f.fused),
    nextIdx: f.pivot,
    nowMs: f.nowMs,
  });

  const mdMin = MD_SEC / 60;
  /** 逐帧跑一遍，返回 remainingMin / arriveAt / 停靠前最后一帧的 segRemainSec */
  const run = (card: RecommendCard, frames: SimFrame[], useHeadway: boolean) => {
    const useCtx = useHeadway ? ctx : ctxNoHeadway;
    return frames.map((f) => {
      const r = recomputeRemaining(useCtx, payloadOf(card, f));
      return { f, r, retimed: r.retimedWaits[0]?.waitMin ?? null };
    });
  };

  /* ── 单段卡（无下游候车 ⇒ 噪声最小，用于**到达锚上界**）── */
  const oneCard = mkOneLegCard(BASE_MS);
  const oneFrames = framesOf(3, BASE_MS); // B1 A1→A4 = 3 跳
  const oneRun = run(oneCard, oneFrames, false);

  /* ── 多段卡（用于单调性 / 切换瞬间三判据）── */
  const twoCard = mkTwoLegCard(BASE_MS);
  const twoFrames = framesOf(2, BASE_MS); // B1 A1→A3 = 2 跳
  const twoRun = run(twoCard, twoFrames, true);

  /* ① 单调性：相邻两次 remainingMin 之差 ≤ 0.25 分（现状：切换瞬间 +3.x ⇒ 必红） */
  {
    let worst = Number.NEGATIVE_INFINITY;
    let worstAt = "";
    let checked = 0;
    for (let i = 0; i + 1 < twoRun.length; i++) {
      const d = twoRun[i + 1]!.r.remainingMin - twoRun[i]!.r.remainingMin;
      checked++;
      if (d > worst) {
        worst = d;
        worstAt = `${twoRun[i]!.f.label} → ${twoRun[i + 1]!.f.label}`;
      }
    }
    ok(
      worst <= 0.25,
      "★ 单调性：相邻两次 remainingMin 之差 ≤ 0.25 分",
      `比对 ${checked} 对 / 最大 +${round1(worst)} 分（${worstAt}）`,
    );
  }

  /* ② 恒等式：arriveAt 必须恰等于 nowMs + remainingMin×60000（残差 0，不是"小于阈值"）*/
  {
    let nonzero = 0;
    let checked = 0;
    for (const x of [...oneRun, ...twoRun]) {
      checked++;
      if (x.r.arriveAtMs - (x.f.nowMs + x.r.remainingMin * 60_000) !== 0) nonzero++;
    }
    ok(nonzero === 0, "★ 恒等式：arriveAt − (nowMs + remainingMin×60000) 残差恰好 0", `比对 ${checked} 帧 / 非零 ${nonzero}`);
  }

  /* ③ B-1 方向：切换瞬间不得整段上涨（≤ +0.1）*/
  {
    let checked = 0;
    let bad = 0;
    let worst = Number.NEGATIVE_INFINITY;
    let worstAt = "";
    for (let i = 0; i + 1 < twoRun.length; i++) {
      const a = twoRun[i]!;
      const b = twoRun[i + 1]!;
      if (a.f.stopped === b.f.stopped) continue;
      checked++;
      const d = b.r.remainingMin - a.r.remainingMin;
      if (d > 0.1) bad++;
      if (d > worst) {
        worst = d;
        worstAt = `${a.f.label} → ${b.f.label}`;
      }
    }
    ok(
      bad === 0,
      "★ B-1 方向：切换瞬间 remaining[i+1] − remaining[i] ≤ +0.1",
      `比对 ${checked} 处切换 / 超限 ${bad} / 最大 ${round1(worst)} 分（${worstAt}）`,
    );
  }

  /* ④ B-2 幅度（精确）：**进站**那一步前后基准站同为站 i ⇒ Δ 必须恰等于 −segRemainSec/60 */
  {
    let checked = 0;
    let bad = 0;
    const detail: string[] = [];
    for (let i = 0; i + 1 < twoRun.length; i++) {
      const a = twoRun[i]!;
      const b = twoRun[i + 1]!;
      if (a.f.stopped || !b.f.stopped) continue; // 只看「行驶 → 停靠」
      checked++;
      // 首跳剩余（分）= 停靠前最后一帧**实际上报**的 segRemainSec
      const segMin = (payloadOf(twoCard, a.f).segRemainSec ?? 0) / 60;
      const d = b.r.remainingMin - a.r.remainingMin;
      detail.push(`Δ=${round1(d)} 期望≈${round1(-segMin)}`);
      if (Math.abs(d) > Math.abs(segMin) + 0.1) bad++;
    }
    ok(
      bad === 0,
      "★ B-2 幅度：进站一步 |Δremaining| ≤ |segRemainSec/60| + 0.1",
      `比对 ${checked} 处进站 / 超限 ${bad} / ${detail.join(" · ")}`,
    );
  }

  /* ⑤ B-3 幅度（兜底）：任何一步的 |Δ| 不得超过该跳中位时长 */
  {
    let checked = 0;
    let bad = 0;
    let worst = 0;
    for (let i = 0; i + 1 < twoRun.length; i++) {
      checked++;
      const d = Math.abs(twoRun[i + 1]!.r.remainingMin - twoRun[i]!.r.remainingMin);
      if (d > worst) worst = d;
      if (d > mdMin + 0.1) bad++;
    }
    ok(
      bad === 0,
      `★ B-3 幅度（兜底）：任何一步 |Δremaining| ≤ md/60 + 0.1（= ${round1(mdMin)} + 0.1）`,
      `比对 ${checked} 步 / 超限 ${bad} / 最大 ${round1(worst)} 分`,
    );
  }

  /* ⑥ 到达锚上界：单段卡相邻两次 |ΔarriveAt| ≤ 15000 ms
   *
   * ── 这条判据的**适用范围**（team-lead 裁决，写清楚以免被当成漏做）──────────
   *   ① **只在同一状态内生效**（连续帧：一直是站间行驶、或一直是进站停靠）。
   *      推导：`round1` 步长 0.1 分 ⇒ 单向量化误差 ≤0.05 分 = 3000ms，两次采集各一次
   *      ⇒ 6000ms；再加 h 曲线跨桶阶跃（20 桶）上界约 8300ms ⇒ ≈14300ms，取整 15000ms。
   *   ② **状态切换那几步刻意豁免**：车辆从「站间行驶」切到「进站停靠」时，
   *      剩余时间的载体本来就换了一套（首跳剩余 → 从所停站起逐跳累加），
   *      这一步产生**真实跳变**；把切换步也塞进"突变判定"，会把正常的口径切换误报成回归，
   *      从而掩盖真正的突变（与「区间用时稳、绝对值漂移」是本项目同一实证结论）。
   *      合成依据：位置模型 `h[1] = 0.25·md`（最后 5% 路程按 25% 时长估，即刹车减速），
   *      而本脚本的合成帧是匀速车 ⇒ 切换步实测 30000ms 属**合成假设差异**，已单列诊断输出。
   *   ③ 切换步**不是没人管**，它由下面三条断言守（各自守的东西不同）：
   *      · **B-1 方向**：`remaining[i+1] − remaining[i] ≤ +0.1` —— 切换瞬间**不得整段上涨**
   *        （U3 的根因就是这条：旧实现 +3.7 分）；
   *      · **B-2 精确幅度**（进站那一步）：`|Δ| ≤ |segRemainSec/60| + 0.1` —— 前后基准站同为站 i
   *        时，Δ 必须**恰好等于**切换前最后上报的首跳剩余（多算/少算都会越界）；
   *      · **B-3 兜底幅度**：任何一步 `|Δ| ≤ md/60 + 0.1` —— 完成一跳不可能超过该跳中位时长
   *        （防"过度修正"方向：把尾巴重复计一遍也会被这条拦下）。
   */
  {
    let checked = 0;
    let bad = 0;
    let worst = 0;
    let worstAt = "";
    let switchWorst = 0;
    let switchAt = "";
    for (let i = 0; i + 1 < oneRun.length; i++) {
      const d = Math.abs(oneRun[i + 1]!.r.arriveAtMs - oneRun[i]!.r.arriveAtMs);
      if (oneRun[i]!.f.stopped !== oneRun[i + 1]!.f.stopped) {
        if (d > switchWorst) {
          switchWorst = d;
          switchAt = `${oneRun[i]!.f.label} → ${oneRun[i + 1]!.f.label}`;
        }
        continue;
      }
      checked++;
      if (d > worst) {
        worst = d;
        worstAt = `${oneRun[i]!.f.label} → ${oneRun[i + 1]!.f.label}`;
      }
      if (d > 15_000) bad++;
    }
    ok(
      bad === 0,
      "★ 到达锚上界：单段卡同状态内相邻两次 |ΔarriveAt| ≤ 15000 ms",
      `比对 ${checked} 对 / 超限 ${bad} / 实测最大 ${worst}ms（${worstAt}）`,
    );
    console.log(`  诊断（不判定）：跨状态那几步的 |ΔarriveAt| 最大 ${switchWorst}ms（${switchAt}）—— 由 h 曲线末端减速假设与匀速合成帧的差异造成`);
  }

  /* ⑦ 多段卡上界（先剔除「候车跨桶」与「状态切换」样本对）+ 跨桶跳变分布 */
  {
    let checked = 0;
    let skipped = 0;
    let switchPairs = 0;
    let bad = 0;
    let worst = 0;
    const jumps: string[] = [];
    for (let i = 0; i + 1 < twoRun.length; i++) {
      const a = twoRun[i]!;
      const b = twoRun[i + 1]!;
      if (a.retimed !== b.retimed) {
        // 候车取值变了 ⇒ 到达换乘站的时刻跨了时段桶，整段跳变属**时段表固有分段**，本批不修
        skipped++;
        jumps.push(`${round1((b.retimed ?? 0) - (a.retimed ?? 0))}`);
        continue;
      }
      if (a.f.stopped !== b.f.stopped) {
        switchPairs++;
        continue;
      }
      checked++;
      const d = Math.abs(b.r.arriveAtMs - a.r.arriveAtMs);
      if (d > worst) worst = d;
      if (d > 15_000) bad++;
    }
    ok(
      bad === 0,
      "★ 多段卡上界（剔除候车跨桶 + 状态切换样本后）：|ΔarriveAt| ≤ 15000 ms",
      `判定 ${checked} 对 / 剔除跨桶 ${skipped} 对 / 剔除切换 ${switchPairs} 对 / 超限 ${bad} / 实测最大 ${worst}ms`,
    );
    console.log(`  跨桶跳变分布（本批不修，仅记录）：${jumps.length ? jumps.join(",") + " 分" : "0 处（合成班距为单行全天时段，无桶边界）"}`);
  }

  /* ⑧ 抵达终点：本段跑完 ⇒ 剩余只剩末段步行（单段卡，无下游段可混） */
  {
    const last = oneRun[oneRun.length - 1]!;
    ok(
      last.r.remainingMin === 2,
      "到达下车站 ⇒ 剩余恰为末段步行 2 分（首跳剩余 0 + 无下游跳 + 2）",
      `实际 ${last.r.remainingMin}`,
    );
  }

  /* ⑨ 诊断（**不参与判定**）：旧客户端载荷在新服务端下的表现
   *   旧载荷 = 停靠不发 0（`null`）+ `nextIdx = 所停站 + 1`（即 `prog.nextIdx` 原样上行）。
   *   ⇒ 这一行是「前端不接 `remainFromIdxOf` 就会退回原缺陷」的证据（不是断言）。 */
  {
    let worst = Number.NEGATIVE_INFINITY;
    let worstAt = "";
    for (let i = 0; i + 1 < twoRun.length; i++) {
      const a = twoFrames[i]!;
      const b = twoFrames[i + 1]!;
      const legacy = (f: SimFrame) =>
        recomputeRemaining(ctx, {
          card: twoCard,
          legIndex: 0,
          segRemainSec: f.stopped ? null : f.fused,
          nextIdx: f.stopped ? f.pivot + 1 : f.pivot,
          nowMs: f.nowMs,
        });
      const d = legacy(b).remainingMin - legacy(a).remainingMin;
      if (d > worst) {
        worst = d;
        worstAt = `${a.label} → ${b.label}`;
      }
    }
    console.log(
      `  诊断（不判定）：旧客户端载荷（停靠发 null + nextIdx=所停站+1）下最大单步上涨 +${round1(worst)} 分（${worstAt}）` +
        " ⇒ 前端必须接 remainFromIdxOf，否则缺陷依旧",
    );
  }
}

/* ══════════════════════ ⑯ 真实索引联调（库不可达则跳过）══════════════════════
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
  // nextIdx = 2 = 下车站本身（基准站=下车点）⇒ 基准站之后 0 跳 ⇒ 剩余 = 150s/60
  const r = recomputeRemaining(realCtx, { card, legIndex: 0, segRemainSec: 150, nextIdx: 2, nowMs });
  ok(near(r.remainingMin, 4.5), `真实线 ${route}：remainingMin = 2.5 + 2 = 4.5`, `实际 ${r.remainingMin}`);
  ok(r.patchedCard.rides[0]!.minutes === 2.5, "patchedCard 本段 minutes = 150s/60 = 2.5");

  // ★ 基准站 = 中间站（1）⇒ 必须再叠加「中间站 → 下车站」那一跳（U3 的核心口径）
  {
    const r1 = recomputeRemaining(realCtx, { card, legIndex: 0, segRemainSec: 150, nextIdx: 1, nowMs });
    const hop2 = round1(rideOfHops(st.segIdx, route, hops.slice(1), "all").minutes);
    ok(
      near(r1.remainingMin, round1(2.5 + hop2 + 2), 0.06),
      `真实线 ${route}：nextIdx=1 ⇒ 剩余 = 2.5 + 第二跳 ${hop2} + 2（不是只算 2.5 + 2）`,
      `实际 ${r1.remainingMin}`,
    );
  }
  // ★ 停靠态（segRemainSec=0 + 基准站=所停站）⇒ 剩余 = 从所停站到下车点的逐跳（含「所停站 → 下一站」）
  {
    const r1 = recomputeRemaining(realCtx, { card, legIndex: 0, segRemainSec: 0, nextIdx: 1, nowMs });
    const hop2 = round1(rideOfHops(st.segIdx, route, hops.slice(1), "all").minutes);
    ok(
      near(r1.remainingMin, round1(hop2 + 2), 0.06),
      `真实线 ${route}：停靠在中间站 ⇒ 剩余 = ${hop2} + 2（不得整跳漏掉「所停站 → 下一站」）`,
      `实际 ${r1.remainingMin}`,
    );
  }

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
  console.log("\n⑯ 真实索引联调（库不可达则跳过，不判失败）");
  const st = await loadRealStatics();
  if (st) realIndexCheck(st);
  if (realConn.pool) await realConn.pool.end().catch(() => undefined);

  console.log(`\n═══ 合计 ${pass + fail} 条：PASS ${pass} / FAIL ${fail} ═══`);
  process.exit(fail === 0 ? 0 : 1);
})();
