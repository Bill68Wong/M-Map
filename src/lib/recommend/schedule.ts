/**
 * 线路运营状态判定（src/lib/recommend/schedule.ts，2026-11-04 新增）
 *
 * ── 需求（U8）────────────────────────────────────────────────────────
 *   用户原话：「是 AND 的关系，不在运营时间且无车才不考虑，否则就要考虑」。
 *   ⇒ **隐藏需要两份证据**：① 不在运营窗口 **且** ② 无车。举证责任在「隐藏」一方。
 *   现状 bug：凌晨出卡的夜班线（如 `N3`）只会出现在**段内并行标签**里（卡片列表已被
 *   `model.ts` 的「无实车且无估算」挡住），早上 07:00 仍能看到「N3」这个不可能存在的选项。
 *
 * ── 数据源（唯一）─────────────────────────────────────────────────────
 *   `route_frequency`（经 `headway.ts#loadHeadway`）。**不新增数据表、不新增查询**。
 *   ⚠️ 日期类型匹配**统一调 `matchesDayType`**，时间基准统一调 `macauNowParts`
 *      —— 本文件**不复制第二套**星期/假期判定（复制一份就等于埋两个口径）。
 *
 * ── 判定为什么必须偏 `closed` 侧（后果不对称）───────────────────────────
 *   误判 `closed` 的最坏后果 = 「无车时不显示」——**这本就是需求要的效果**；
 *   误判 `no_data` 的后果 = 「根本不跑的线全天显示」——**正是要修的 bug**。
 *   后果不对称 ⇒ 「有该线但今日落在所有窗口之外（含内部断档）」与「今日无匹配
 *   day_type 行」一律判 `closed`；`no_data` 只保留给「该线完全不在班距表里」。
 */
import { macauNowParts } from "@/lib/lrt/day-type";
import { matchesDayType, type HeadwayIndex } from "./headway";
import type { RouteLive } from "./types";

/** 运营状态五态 */
export type ServiceState = "open" | "closing" | "closed" | "before_first" | "no_data";

/**
 * 末班宽限（分钟）——**只挂在当日 `max(toMin)` 上**（不给每个窗口都加）。
 *
 * 推导：`N3` 官方 20–25 分钟一班 ⇒ 末班时段结束后，末班车仍可能在路上/晚点，
 *   取一个**班距下限** 20 分钟作宽限。上界不得超 30 —— 否则「07:00 还显示夜班线」
 *   这个原始 bug 会回归（`N3` 窗口 00:00–06:00，30 分宽限会撑到 06:30 之后仍算「收班中」）。
 */
export const SERVICE_TAIL_GRACE_MIN = 20;

/**
 * 首班宽限（分钟）= 0。
 * 首班前**没有任何「车已在路上」的合法情形**（车还没发出来），故不给宽限：
 * 「首班前」一律按「有没有实时车」判（有车 = 显示）。
 */
export const SERVICE_HEAD_GRACE_MIN = 0;

/** `serviceStateAt` 的产物（诊断字段一并带出，避免调用方二次计算） */
export interface ServiceStateAt {
  state: ServiceState;
  /**
   * true = 假期表不可用，日期类型只能**按星期**判定（见 `headway.ts:121-123` 的退化分支）。
   * ⚠️ 这个信号**不可靠**（假期落在工作日时，`sun_holiday` 行会匹配不到 ⇒ 把照常营运的线
   *    误判成收班）⇒ 一旦为 true，本模块**不提供隐藏依据**（直接判 `no_data` = 永不因时间隐藏），
   *    只把它记进诊断（`holiday_fallback`）。
   */
  holidayFallback: boolean;
  /** 今日（匹配 day_type 后）窗口的最早开始分钟 */
  minFromMin: number | null;
  /** 今日窗口的最晚结束分钟（跨午夜行 > 1440） */
  maxToMin: number | null;
  /** 命中窗口的展示串（如 `00:00-06:00`），未命中为 null */
  span: string | null;
}

/**
 * 查「此刻」该线路的运营状态。
 *
 * @param idx   `loadHeadway()` 的结果；`undefined` ⇒ 无班距表 ⇒ 判 `no_data`（永不隐藏）
 * @param route 线路码（如 `N3`）
 * @param nowMs 时间基准（默认现在）
 *
 * 判定顺序（`closed` 只能由「与当日 max(toMin) 比较」得出，不能由「没命中任何窗口」得出）：
 *   ① 命中任一窗口                                   → `open`
 *   ② 未命中，但探针落在今日整体跨度 `[minFrom, maxTo]` 内 → `closed`（**内部断档**，如 `59` 的 10:00–15:00）
 *   ③ 未命中，探针落在末班宽限 `(maxTo, maxTo+G_tail]`   → `closing`
 *   ④ 未命中，`nowMin < minFrom`                        → `before_first`
 *   ⑤ 其余                                              → `closed`
 * 跨午夜：`toMin > 1440` 的行用 `nowMin + 1440` 比对（与 `headway.ts:171` 同一双探针口径）。
 */
export function serviceStateAt(
  idx: HeadwayIndex | undefined,
  route: string,
  nowMs?: number,
): ServiceStateAt {
  const none: ServiceStateAt = {
    state: "no_data",
    holidayFallback: false,
    minFromMin: null,
    maxToMin: null,
    span: null,
  };
  const list = idx?.byRoute.get(route);
  // ① 该线完全不在班距表里 ⇒ no_data（唯一保留给「无数据」的情形）
  if (!idx || !list || !list.length) return none;

  // ② 假期表不可用 ⇒ 日期类型不可靠 ⇒ 不提供隐藏依据（见 ServiceStateAt.holidayFallback）
  const holidayFallback = idx.holidays.size === 0;
  if (holidayFallback) return { ...none, holidayFallback: true };

  const parts = macauNowParts(nowMs ? new Date(nowMs) : undefined);
  const isHoliday = idx.holidays.has(parts.ymd);
  const nowMin = Math.floor(parts.daySec / 60);
  const probes = [nowMin, nowMin + 1440];

  // 今日适用的行（day_type 匹配统一走 matchesDayType，禁止另写一套）
  let minFromMin: number | null = null;
  let maxToMin: number | null = null;
  let hitSpan: string | null = null;
  for (const row of list) {
    if (!matchesDayType(row.dayType, parts.weekday, isHoliday)) continue;
    minFromMin = minFromMin === null ? row.fromMin : Math.min(minFromMin, row.fromMin);
    maxToMin = maxToMin === null ? row.toMin : Math.max(maxToMin, row.toMin);
    if (hitSpan) continue;
    for (const t of probes) {
      if (t >= row.fromMin && t <= row.toMin) {
        hitSpan = `${row.timeFrom}-${row.timeTo}`;
        break;
      }
    }
  }

  // ③ 今日无匹配 day_type 行（如 12 条线无周日覆盖、`15T` 无平日覆盖）⇒ `closed`
  //    ⚠️ 不是 `no_data`：该线在表里、只是今天不跑 —— 后果不对称那条规则见文件头。
  if (minFromMin === null || maxToMin === null) {
    return { state: "closed", holidayFallback: false, minFromMin: null, maxToMin: null, span: null };
  }
  const base = { holidayFallback: false, minFromMin, maxToMin };

  if (hitSpan) return { ...base, state: "open", span: hitSpan };

  const inSpan = probes.some((p) => p >= minFromMin && p <= maxToMin);
  if (inSpan) return { ...base, state: "closed", span: null };

  const inTail = probes.some((p) => p > maxToMin && p <= maxToMin + SERVICE_TAIL_GRACE_MIN);
  if (inTail) return { ...base, state: "closing", span: null };

  const beforeFirst = nowMin + SERVICE_HEAD_GRACE_MIN < minFromMin;
  return { ...base, state: beforeFirst ? "before_first" : "closed", span: null };
}

/**
 * ★ 2026-11-04（U8）：**假期表是否不可用**（诊断位 `holiday_fallback` 的唯一取值来源）。
 *
 * 该结论是**全局**的（`lrt_holidays` 有没有行），不是逐线的 ⇒ 由两条链路各自算一次、
 * 挂在结果顶层；`serviceStateAt` 内部也用它（不可用 ⇒ 判 `no_data`，永不因时间隐藏）。
 * 传 `undefined`（没有班距表）⇒ `false`：此时根本没做时间判定，报「假期回退」会误导。
 */
export function holidayFallbackOf(idx: HeadwayIndex | undefined): boolean {
  return idx ? idx.holidays.size === 0 : false;
}

/** 隐藏依据（诊断位 `skipped_by_schedule` 的取值域） */
export type ScheduleHideReason = "closed_none" | "closed_unknown";

/**
 * 「此刻该线有没有车」——**未知**返回 `null`，不得用 `false` 冒充（两者判定结论不同）。
 *
 * 口径：
 *   · 实时层没有这条线的记录（未纳入本轮抓取 / 抓取失败）⇒ `null`（未知）；
 *   · 巴士：`BusLive.empty === true` = 本方向无任何在途车 ⇒ `false`；
 *   · 轻轨：`LrtLive.state === "running"` ⇒ `true`，其余（before_first/after_last/no_data）⇒ `false`。
 */
export function hasCarOf(live: Map<string, RouteLive> | undefined, route: string): boolean | null {
  const lv = live?.get(route);
  if (!lv) return null;
  if (lv.kind === "bus") return !lv.empty;
  return lv.state === "running";
}

export interface HideDecision {
  hide: boolean;
  reason?: ScheduleHideReason;
}

/**
 * 十二格判定表（**边界已逐格核过，改动前先看这张表**）：
 *
 * | 窗口        | 有车 | 结论                                              |
 * |-------------|------|---------------------------------------------------|
 * | open        | 任意 | 显示                                              |
 * | closed      | 有   | **必须显示**（末班晚点 = 合法情形）               |
 * | closed      | 无   | 隐藏（`closed_none`）                             |
 * | closed      | 未知 | **隐藏**（`closed_unknown`）★ 已知偏离，见下      |
 * | closing     | 有   | 显示                                              |
 * | closing     | 无   | 隐藏（`closed_none`）                             |
 * | closing     | 未知 | **显示**（保守：不得因「未知」提前隐藏）           |
 * | before_first| 有   | 显示（首班前宽限 = 0）                            |
 * | before_first| 无   | 隐藏（`closed_none`）                             |
 * | before_first| 未知 | **显示**（保守，同上）                            |
 * | no_data     | 任意 | **显示**（永不因时间隐藏）                        |
 *
 * ★ **已知偏离**：`closed + 未知 ⇒ 隐藏` 偏离用户原话的字面（严格按 AND 应显示）。
 *   理由：澳门巴士**不设站外上客**，窗口结束超 `G_tail` 后「此刻有没有车」已不影响能否乘坐
 *   （该线上车点已无合法班次）⇒ 此时「未知」与「无车」的可乘结论相同。
 *   ⚠️ 不得因本格放宽 `SERVICE_TAIL_GRACE_MIN` —— 宽限是「末班晚点」的容错，不是本格的补丁。
 */
export function hideBySchedule(state: ServiceState, hasCar: boolean | null): HideDecision {
  if (state === "no_data" || state === "open") return { hide: false };
  if (hasCar === true) return { hide: false }; // 有车 ⇒ 一律显示（含 closed 的末班晚点）
  if (state === "closed") {
    return { hide: true, reason: hasCar === null ? "closed_unknown" : "closed_none" };
  }
  // closing / before_first：只有**明确无车**才隐藏；未知 ⇒ 保守显示
  if (hasCar === false) return { hide: true, reason: "closed_none" };
  return { hide: false };
}

export interface ScheduleGate extends HideDecision {
  state: ServiceState;
  holidayFallback: boolean;
}

/**
 * 判定入口（调用方只需「该不该隐藏」时用这个，不必自己拼状态 + 有车）。
 *
 * @param headway `loadHeadway()` 产物；`undefined` ⇒ 一律显示（fail-safe）
 * @param live    实时视图（`ModelContext.live`）
 */
export function scheduleGate(
  headway: HeadwayIndex | undefined,
  live: Map<string, RouteLive> | undefined,
  route: string,
  nowMs: number,
): ScheduleGate {
  const at = serviceStateAt(headway, route, nowMs);
  const d = hideBySchedule(at.state, hasCarOf(live, route));
  return { ...d, state: at.state, holidayFallback: at.holidayFallback };
}
