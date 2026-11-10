/**
 * 剩余行程重算（src/lib/nav/remaining.ts，需求1 · 1-B′）
 *
 * ── 解决什么 ──────────────────────────────────────────────────────────
 *   导航中点「刷新」时，`card.totalMin` / `card.arriveAt` 是**规划时刻的快照**
 *   （`model.ts:817/879` 一次算定、全仓无回写）⇒ 走了 20 分钟仍显示「19.3 分」。
 *   本模块**只在当前这条路线内重算时间**：不重新规划、不切换路线、不提示更快方案。
 *
 * ── 口径（产品已拍板，不要自行扩展）────────────────────────────────────
 *   「总时长并不是从当前时间重新走一遍，而是减掉用户已经花的时间、已经经过的路程，
 *     算的是从现在这个地方到达目的地所需时间。」
 *   ⇒ 已发生的部分（出发步行 `walkOut`、当前腿已走的里程、当前腿的候车）**一律不计入**。
 *
 * ── 三段时间的来源（这是本模块存在的理由）──────────────────────────────
 *   | 段 | 取法 | 为什么 |
 *   |---|---|---|
 *   | 当前腿剩余 | `segRemainSec`（到**基准站**的首跳剩余）+ 基准站之后逐跳 → 无 `segRemainSec` 则逐跳累加 → 再退全段静态分钟 | 只有客户端知道用户在这段的哪里 |
 *   | 下游乘车 | `card.rides[i].minutes`（静态） | `rideOfHops` 是纯查表，与实时无关 |
 *   | **下游候车** | `headwayAt(headway, route, 预计到达该换乘站时刻)` **重估** | **本模块的核心价值**：客户端拿不到 `HeadwayIndex`（`loadHeadway` 需要 `Pool`） |
 *   | 末段步行 | `card.walkIn.minutes`（静态） | 已冻在卡里 |
 *
 * ── ★ 口径（U3 修正，改动前必读）──────────────────────────────────────
 *   `segRemainSec` 是**到下一站（基准站）的首跳剩余**，**不是**整段乘车剩余
 *   （来源 `md × h[1−p]`，`md` = 相邻站对中位时长，见 `progress.ts:237`）。整段剩余必须再叠加
 *   「基准站之后到下车点」的逐跳：
 *   ```
 *   pivotIdx  = prog.kind === "at" ? prog.atIdx : prog.nextIdx   // track.ts#remainFromIdxOf
 *   legRemain = segRemainSec / 60 + hopMinutesFrom(ctx, ride, pivotIdx)
 *   ```
 *   **基准站**由客户端按同一条规则算好、经 `nextIdx` 上行（字段名不变，语义 = 基准站下标）。
 *   停靠态必须把 `segRemainSec` 显式传 `0`（`track.ts#segRemainSecOf`），
 *   **不得**用「`progress` 字段缺失」推断停靠 —— 那只是「车丢了」。
 *   旧实现直接拿 `segRemainSec/60` 当整段用 ⇒ 车辆从「站间行驶」切到「进站停靠」时，
 *   载体从「首跳剩余」换成「逐跳累加」，剩余时间整段突变（U3）。
 *
 * ── 红线（硬约束，不是优化建议）──────────────────────────────────────
 *   **0 次 DSAT、0 次高德。** 本模块不 import 任何 `@/lib/dsat/*` / `@/lib/amap/*` 的调用型模块，
 *   只吃已装载好的 `RouteIndex` / `SegmentIndex` / `HeadwayIndex`。
 *   理由：一次刷新 2 次 DSAT × 高频轮询会把 `DSAT_QPS=3` 的**全 Key 全局单桶**打满
 *   （约 7 并发用户），且新 purpose 不进 `skipBreaker` 白名单会撞开全局熔断、
 *   静默计时器主流程 30 分钟（`dsat/client.ts:93`）。
 *
 * ── 为什么输出「patchedCard」而不是「改 buildStrips」────────────────────
 *   `buildStrips` 的四个时间字段全部取自「card 或静态桶」：`rideMin` ← `ride.minutes`（`strips.ts:134`）、
 *   `rideSecText` ← `ride.rideSecText`（`:136`）、`transferAfter.waitMin` ← `t.waitMin`（`:118`）、
 *   `minToNext` ← `lookupHop(..., nowBucket)`（`:74`）⇒ 只要喂一份「时间已重估」的 card，
 *   站条自动整形，`strips.ts` **一行不改**（`buildStrips` 函数体内无时间源 ⇒ 确定性纯函数）。
 *
 * ⚠️ **`patchedCard` 只在服务端内部流转，绝不下发**：前端存回 state 会污染
 *   `RecommendCard.tsx:143` 的 `rides.slice(1).reduce((s, r) => s + r.waitMin, 0)` 加总。
 *
 * ── 已知边界（实现/接入时必读，不要当成 bug 去「修」）──────────────────
 *   ① ★ **本模块假设用户已上车**（`boarding` 相位不要调用本端点）。
 *      **为什么**：`rides[legIndex].waitMin` 被视为**已发生**、不计入剩余（时间轴从 `legIndex+1`
 *      段起算）。boarding 时该段候车**还没花掉** ⇒ 调了会漏算当前候车（典型 3~9 分），剩余偏短。
 *      **boarding 期怎么算**：不调本端点，直接用原卡的 `totalMin` / `arriveAt` —— 那张卡是在
 *      用户还站在站台时算的，行程一分钟都没消耗 ⇒ 它在数学上就等于真实剩余。
 *      ⚠️ 已知残余偏差：若规划的那班车已过、用户仍在等车，原卡快照会偏乐观（偏小）。
 *      正解需入参加 `phase`/`boarded` 并重估候车（**契约扩展，独立批次**）。
 *      **不要**在这里用 `segRemainSec == null` 去猜「是否已上车」—— 猜错不会有报错，只会静默给错数。
 *      （此边界由 UI 侧 `useNavRemaining` 的 `enabled = phase === "riding"` 与本处**两处**同时登记。）
 *   ② **轻轨段候车不重估**（`source:"kept"`）：轻轨候车来自 `lrt_timetables`（需 `LrtPreload`），
 *      本模块刻意不接受该依赖 ⇒ 保留卡面原值。这是**刻意的边界**，不是遗漏。
 *   ③ **站条不裁剪**：`patchedCard` 只改 `minutes`/`waitMin`，不改 `stops[]` ⇒
 *      纵条逐站 `minToNext` / `minToNextEst` 仍是**全段**值（`strips.ts` 只吃 `lookupHop`）。
 *      这一点现已**无处可见**：纵轴逐站分钟已随需求 7（2026-11-09）整块删除渲染
 *      （原 `NavStrip.tsx` 的 `!end && !nav` 分支已不存在），任何导航状态都不再印逐站读数。
 *      ⇒ `sum(minToNextEst) !== rideMin` 在 patchedCard 下仍是**预期**，已被快照脚本锁为断言。
 *   ④ **末段步行不重估**：`walkIn.minutes` 是静态实测均值，用户实际走得快/慢都按均值算。
 *      重估它需要实时 GPS 距离，超出「只重算时间」的范围。
 *
 * 纯函数：无 I/O、无 `Pool`、除 `nowMs` 外不读时钟 ⇒ 可用合成索引单测（见 `scripts/test-remaining.ts`）。
 * 设计：docs/迭代-导航优化-20261102/20-后端-需求1之1B可行性-20261103.md
 */
import { segmentsOf } from "@/lib/recommend/enumerate";
import { conservativeWaitMin, headwayAt, headwayMedian, type HeadwayIndex } from "@/lib/recommend/headway";
import { lookupHop, type SegmentIndex } from "@/lib/recommend/segment-lookup";
import type { RecommendCard, RideLegView, RouteIndex } from "@/lib/recommend/types";

/** 重算所需的**已装载**索引（由 route 层 `loadStatics` / `loadHeadway` 备好，本模块不查库） */
export interface RemainingCtx {
  routeIdx: RouteIndex;
  segIdx: SegmentIndex;
  /** 查询时段桶（`nowBucketOfHolidayAware` 五桶之一） */
  nowBucket: string;
  /**
   * 班距索引；`null` = 不重估候车（单段卡无需下游候车 ⇒ 调用方应传 null 以省冷路径 DB）。
   */
  headway: HeadwayIndex | null;
}

export interface RemainingInput {
  card: RecommendCard;
  /** 当前所在载具段下标（`card.rides` 下标） */
  legIndex: number;
  /**
   * 本段**到基准站**的首跳剩余秒数（客户端 `track.segProgress.segRemainSec` =
   * 服务端位置模型 + 客户端时间项融合值）。
   * 必须与 `nextIdx` **成对**上行：单独出现时只说明「到某一站的剩余」，
   * 基准站未知 ⇒ 回落该段全量静态分钟（保守偏长，**不双计**）。
   * 停靠态客户端应显式传 `0`（不是 `null`）。
   */
  segRemainSec?: number | null;
  /**
   * **基准站**下标（客户端 `track.ts#remainFromIdxOf(track.prog)`）。
   * 停靠态 = 所停站 `atIdx`（**不是** `prog.nextIdx`，那个指向所停站的下一站，
   * 从那里起累加会整跳漏掉「所停站 → 下一站」）；行驶态 = `prog.nextIdx`（区间终点）。
   * 仅用于「从基准站起累加 `minToNextEst`（估算列，非可为 `null` 的展示列）」；
   * 缺省 ⇒ 站序精确回退不可用，回落该段静态分钟。
   */
  nextIdx?: number | null;
  /** 重算基准时刻（缺省 `Date.now()`；测试可注入） */
  nowMs?: number;
}

/** 某段候车重估的取值来源（诊断用；**不进对外契约**） */
export type WaitSource = "headway" | "median" | "kept";

export interface RemainingResult {
  /** 剩余门到门分钟（**已在最上层 clamp 到 ≥0**，永不为负） */
  remainingMin: number;
  /** 预计到达时刻（epoch ms）= `nowMs + remainingMin × 60_000` */
  arriveAtMs: number;
  /** 时间字段被重估后的 card 副本（其余字段与入参逐字节一致） */
  patchedCard: RecommendCard;
  /** 逐段候车重估明细（诊断/测试用；route 层**不下发**） */
  retimedWaits: { legIndex: number; route: string; waitMin: number; source: WaitSource }[];
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** 非有限值（undefined / NaN / 字符串脏数据）统一归 0 —— 上游 body 只做浅校验，这里兜底 */
const numOr0 = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 该段「从第 `fromIdx` 站起」到下车点的剩余逐跳分钟。
 * 与前端 `NavDetailBody.tsx` 的回退口径逐字对应（`for k = nextIdx; k < stops.length-1; sum += minToNextEst`，
 * 前端传的是 `minToNextEst` 估算列 —— 见 `NavDetailBody.tsx:762`，**不要**改成可为 `null` 的 `minToNext`）；
 * 站序由 `segmentsOf` 切出「上车站 → 下车站」的切片（与 `buildStrips` 同一个切法，见 `strips.ts:61-68`）。
 * @returns `null` = 站序缺失（调用方回退到 `ride.minutes`）
 */
function hopMinutesFrom(
  ctx: RemainingCtx,
  ride: RideLegView,
  fromIdx: number,
): number | null {
  const seg = segmentsOf(ctx.routeIdx, ride.route, ride.board, ride.alight);
  if (!seg || !seg.segs.length) return null;
  // 与 buildStrips 同口径：codes = [首站, ...每跳的下车站]
  const codes = [seg.segs[0]![0], ...seg.segs.map((s) => s[1])];
  const start = Math.max(0, Math.min(Math.trunc(fromIdx), codes.length - 1));
  let sum = 0;
  for (let k = start; k < codes.length - 1; k++) {
    // ★ 2026-11-09 裁定：末跳（B = codes 末位 = 本次下车站）用纯行驶，中间跳含停站。
    const isFinal = k === codes.length - 2;
    const hop = lookupHop(ctx.segIdx, ride.route, codes[k]!, codes[k + 1]!, ctx.nowBucket, { final: isFinal });
    sum += Math.max(0, numOr0(hop.estMinutes));
  }
  return sum;
}

/**
 * 按「预计到达该换乘站的绝对时刻」重估候车。三档（与 `model.ts` 巴士第 2 段同源）：
 *   ① `headwayAt` 命中时段行 → `(lo + 2·hi)/3`（偏保守，约 P67）
 *   ② 未命中但中位数可用   → 该线全时段班距中位数
 *   ③ 连中位数都没有       → **保留卡面原值**（`source:"kept"`）
 *
 * ⚠️ 档 ③ 为什么**不像 `model.ts` 那样归零**：`model.ts` 归零的同时会改写文案
 *   「等车时间暂无数据」把不确定性显式暴露；本模块无文案通道，归零等于**凭空把剩余变短**
 *   （乐观偏差，用户看不出来）⇒ 宁取卡面原值，并让 `source:"kept"` 可被测试与日志看见。
 * ⚠️ 轻轨段一律 `kept`（候车来自 `lrt_timetables`，本模块刻意不接受 `LrtPreload`）：**已知边界**。
 */
function reestimateWait(
  ctx: RemainingCtx,
  ride: RideLegView,
  arrivalMs: number,
): { waitMin: number; source: WaitSource } {
  const kept = Math.max(0, numOr0(ride.waitMin));
  if (ride.kind === "lrt") return { waitMin: kept, source: "kept" };
  const idx = ctx.headway;
  if (!idx) return { waitMin: kept, source: "kept" };

  const hit = headwayAt(idx, ride.route, arrivalMs);
  if (hit) {
    const m = conservativeWaitMin(hit);
    if (Number.isFinite(m) && m >= 0) return { waitMin: m, source: "headway" };
  }
  const med = headwayMedian(idx, ride.route) ?? headwayMedian(idx);
  if (med !== null && Number.isFinite(med) && med >= 0) return { waitMin: med, source: "median" };
  return { waitMin: kept, source: "kept" };
}

/**
 * 在当前这条推荐路线内重算剩余时间。
 *
 * 时间轴（绝对 ms，串行累加）：
 * ```
 * now ──[当前腿剩余 curRemain]──▶ 到达本段下车站
 *      ──[换乘步行 transfers[i-1].minutes]──▶
 *      ──[候车 重估 headwayAt]──▶
 *      ──[乘车 rides[i].minutes 静态]──▶  …逐段重复…
 *      ──[末段步行 walkIn.minutes]──▶ 到达目的地
 * ```
 *
 * @returns `remainingMin` 已 clamp 到 ≥0（车晚点走到 0 就停在 0，绝不出现「-3 分钟」）
 */
export function recomputeRemaining(ctx: RemainingCtx, input: RemainingInput): RemainingResult {
  const card = input.card;
  const rides = Array.isArray(card.rides) ? card.rides : [];
  const nowMs = Number.isFinite(input.nowMs as number) ? (input.nowMs as number) : Date.now();

  // ── 防御：无载具段（正常不会出现；route 层已校验 rides 非空）──
  if (!rides.length) {
    const walkOnly = round1(Math.max(0, numOr0(card.walkIn?.minutes)));
    return {
      remainingMin: walkOnly,
      arriveAtMs: nowMs + Math.round(walkOnly * 60_000),
      patchedCard: { ...card, totalMin: walkOnly, arriveAt: nowMs + Math.round(walkOnly * 60_000) },
      retimedWaits: [],
    };
  }

  const lastIdx = rides.length - 1;
  const legIndex = Math.max(0, Math.min(Math.trunc(numOr0(input.legIndex)), lastIdx));
  const curRide = rides[legIndex]!;

  // ── ① 当前腿剩余（**唯一口径**：到基准站的首跳剩余 + 基准站之后逐跳，见 `track.ts#remainFromIdxOf`）──
  const segSecRaw = input.segRemainSec;
  const hasSegSec =
    segSecRaw !== null && segSecRaw !== undefined && Number.isFinite(Number(segSecRaw)) && Number(segSecRaw) >= 0;
  const nextIdxRaw = input.nextIdx;
  const pivotIdx =
    nextIdxRaw !== null && nextIdxRaw !== undefined && Number.isFinite(Number(nextIdxRaw))
      ? Math.trunc(Number(nextIdxRaw))
      : null;
  /** 基准站之后到下车点的逐跳分钟；`null` = 站序缺失（无从累加） */
  const tailMin = pivotIdx === null ? null : hopMinutesFrom(ctx, curRide, pivotIdx);
  const legStaticMin = Math.max(0, numOr0(curRide.minutes));

  let curRemainMin: number;
  if (hasSegSec && tailMin !== null) {
    curRemainMin = Number(segSecRaw) / 60 + tailMin;
  } else if (tailMin !== null && !hasSegSec) {
    curRemainMin = tailMin;
  } else {
    // ⚠️ 只有 `segRemainSec`（基准站未知）时**不得**回落 `segRemainSec/60`：
    //   它只覆盖到基准站那一跳，拿它当整段会**少算下游跳**（U3 的根因本体）。
    //   ⇒ 回落该段全量静态分钟（偏长不多算，用户早到不会被骗）。
    curRemainMin = legStaticMin;
  }
  curRemainMin = Math.max(0, numOr0(curRemainMin));

  // ── ② 下游逐段：换乘步行 + 候车（重估）+ 乘车（静态）──
  let cursor = nowMs + curRemainMin * 60_000;
  /** legIndex → 重估后的 waitMin（同时回写 rides[i].waitMin 与 transfers[i-1].waitMin） */
  const newWaitOf = new Map<number, number>();
  const retimedWaits: RemainingResult["retimedWaits"] = [];

  for (let i = legIndex + 1; i < rides.length; i++) {
    const ride = rides[i]!;
    const t = card.transfers?.[i - 1];
    if (t) cursor += Math.max(0, numOr0(t.minutes)) * 60_000;

    const w = reestimateWait(ctx, ride, cursor);
    const wMin = round1(Math.max(0, numOr0(w.waitMin)));
    newWaitOf.set(i, wMin);
    retimedWaits.push({ legIndex: i, route: ride.route, waitMin: wMin, source: w.source });
    cursor += wMin * 60_000;

    cursor += Math.max(0, numOr0(ride.minutes)) * 60_000;
  }

  // ── ③ 末段步行 ──
  cursor += Math.max(0, numOr0(card.walkIn?.minutes)) * 60_000;

  // ── ④ clamp（车晚点时 cursor 可能早于 now ⇒ 停在 0）──
  const remainingMin = round1(Math.max(0, (cursor - nowMs) / 60_000));
  const arriveAtMs = nowMs + Math.round(remainingMin * 60_000);

  // ── ⑤ patchedCard：只改时间字段，其余**引用与值都不动** ──
  const patchedCard: RecommendCard = {
    ...card,
    totalMin: remainingMin,
    arriveAt: arriveAtMs,
    rides: rides.map((r, i) => {
      if (i === legIndex) return { ...r, minutes: round1(curRemainMin) };
      const w = newWaitOf.get(i);
      return w === undefined ? r : { ...r, waitMin: w };
    }),
    transfers: Array.isArray(card.transfers)
      ? card.transfers.map((t, i) => {
          const w = newWaitOf.get(i + 1);
          return w === undefined ? t : { ...t, waitMin: w };
        })
      : card.transfers,
  };

  return { remainingMin, arriveAtMs, patchedCard, retimedWaits };
}
