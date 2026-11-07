/**
 * 发车间隔查询（src/lib/recommend/headway.ts，2026-09-21 新增）
 *
 * ── 用途 ──────────────────────────────────────────────────────────────
 *   为「未发车」的线路推算**下一班等待时间**（配合 `live.ts` 的估算逻辑）。
 *   数据来自 `route_frequency` 表（来源与抓取见 `scripts/fetch-bus-frequency.ts`）。
 *
 * ── 为什么单独一个模块 ────────────────────────────────────────────────
 *   1. **纯查询 + 纯判定**，不碰实时链路 ⇒ 可单测、可独立验证；
 *   2. 把「日期类型匹配」这条易错逻辑（5 种写法 × 平日/周六/周日/假期）集中一处；
 *   3. `live.ts` 只需调用 `headwayAt()`，不必关心 SQL 与假期表。
 *
 * ── 日期类型匹配口径 ──────────────────────────────────────────────────
 *   抓取得到的 `day_type` 共 7 种（见 `scripts/fetch-bus-frequency.ts` 的 `DAY_TYPE_MAP`）：
 *     `daily` 每日 · `mon_sat` 星期一至六 · `mon_fri` 星期一至五 ·
 *     `sat` 星期六 · `sun_holiday` 星期日及公眾假期 ·
 *     `sat_sun_holiday` 星期六日及公眾假期 · `special` 临时措施（**不参与**自动匹配）
 *   ⚠️ `special` 是「特定日历日期」的临时班次，**不是周期规则** ⇒ 本模块**显式排除**它，
 *      避免把它误当成「每天都适用」。
 *   ⚠️ **假期一律按「非工作日」处理**：澳门公众假期落在周一~周五时，
 *      页面用的是「星期日及公眾假期」那一档（与轻轨 `day-type.ts` 口径一致）。
 */
import type { Pool } from "pg";
import { macauNowParts, type MacauNowParts } from "@/lib/lrt/day-type";

/** `route_frequency` 的一行（只取本模块用得到的列） */
export interface FreqRow {
  dayType: string;
  timeFrom: string;
  timeTo: string;
  fromMin: number;
  /** ⚠️ 跨午夜时段（如 20:00-01:15）会 > 1440，表示**次日** */
  toMin: number;
  freqLo: number;
  freqHi: number;
}

export interface HeadwayIndex {
  /** 线路码 → 该线全部时段行 */
  byRoute: Map<string, FreqRow[]>;
  /** 澳门公众假期（'YYYY-MM-DD'）—— 与轻轨共用 `lrt_holidays` */
  holidays: Set<string>;
  /** 载入的行数（诊断用） */
  size: number;
}

/** 该 `day_type` 是否适用于「今天」 */
export function matchesDayType(dayType: string, weekday: number, isHoliday: boolean): boolean {
  switch (dayType) {
    case "daily":
      return true;
    case "mon_sat":
      return !isHoliday && weekday >= 1 && weekday <= 6;
    case "mon_fri":
      return !isHoliday && weekday >= 1 && weekday <= 5;
    case "sat":
      return !isHoliday && weekday === 6;
    case "sun_holiday":
      return isHoliday || weekday === 0;
    case "sat_sun_holiday":
      return isHoliday || weekday === 0 || weekday === 6;
    // ⚠️ special（临时措施）与 unknown 一律不参与自动匹配
    default:
      return false;
  }
}

/** 载入发车间隔索引（模块级缓存，调用方传入 pool；行数很小，全量进内存） */
const CACHE_TTL_MS = 10 * 60_000;
let cache: { at: number; idx: HeadwayIndex } | null = null;

export async function loadHeadway(pool: Pool, force = false): Promise<HeadwayIndex> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.idx;

  const rows = (
    await pool.query(
      `SELECT route_code, day_type, time_from, time_to, from_min, to_min, freq_lo, freq_hi
         FROM route_frequency
        WHERE day_type <> 'special'`,
    )
  ).rows as {
    route_code: string;
    day_type: string;
    time_from: string;
    time_to: string;
    from_min: number;
    to_min: number;
    freq_lo: number;
    freq_hi: number;
  }[];

  const byRoute = new Map<string, FreqRow[]>();
  for (const r of rows) {
    const list = byRoute.get(r.route_code);
    const row: FreqRow = {
      dayType: r.day_type,
      timeFrom: r.time_from,
      timeTo: r.time_to,
      fromMin: Number(r.from_min),
      toMin: Number(r.to_min),
      freqLo: Number(r.freq_lo),
      freqHi: Number(r.freq_hi),
    };
    if (list) list.push(row);
    else byRoute.set(r.route_code, [row]);
  }

  // 假期表：与轻轨共用 `lrt_holidays`（列名用 information_schema 探测，避免写死）
  const holidays = new Set<string>();
  try {
    const cols = (
      await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'lrt_holidays'`,
      )
    ).rows as { column_name: string }[];
    const col = ["date", "ymd", "day", "holiday_date"].find((c) => cols.some((x) => x.column_name === c));
    if (col) {
      const hs = (await pool.query(`SELECT ${col}::text AS d FROM lrt_holidays`)).rows as { d: string }[];
      for (const h of hs) holidays.add(String(h.d).slice(0, 10));
    }
  } catch {
    /* 假期表不可用 ⇒ 退化为「只按星期判定」（保守：可能把假期当工作日） */
  }

  const idx: HeadwayIndex = { byRoute, holidays, size: rows.length };
  cache = { at: Date.now(), idx };
  return idx;
}

export interface HeadwayHit {
  lo: number;
  hi: number;
  /** 命中的时段（诊断/展示用，如 `06:00-10:00`） */
  span: string;
  dayType: string;
  /** true = 该时段跨午夜（`toMin > 1440`） */
  crossesMidnight: boolean;
  /**
   * ★ 需求 7（换乘盲区修正）：命中时段的**起止分钟**（含跨午夜时 `toMin > 1440`）。
   *   供 `transfer-slack.ts` 计算「到达点距时段尾的余量」——桶内唯一可用的时序信息。
   */
  fromMin: number;
  toMin: number;
  /** 命中时实际用来比对的「当日分钟」（= `nowMin` 或 `nowMin + 1440`，与 `toMin` 同域） */
  arrivalMin: number;
}

/**
 * 查「此刻」该线路的发车间隔。
 *
 * @param idx      `loadHeadway()` 的结果
 * @param route    线路码（如 `26A`）
 * @param nowMs    时间基准（默认现在）
 * @returns 命中则给出**区间** `[lo, hi]`；未覆盖该线路/时段 ⇒ `null`（调用方走降级）
 *
 * ⚠️ 跨午夜处理：`20:00 - 01:15` 这类时段的 `toMin` 已 +1440（次日）。
 *    因此「凌晨 00:30」要同时匹配**前一天的该时段** ⇒ 用 `nowMin` 与 `nowMin + 1440` 各试一次。
 */
export function headwayAt(
  idx: HeadwayIndex,
  route: string,
  nowMs?: number,
): HeadwayHit | null {
  const list = idx.byRoute.get(route);
  if (!list || !list.length) return null;

  const parts: MacauNowParts = macauNowParts(nowMs ? new Date(nowMs) : undefined);
  const isHoliday = idx.holidays.has(parts.ymd);
  const nowMin = Math.floor(parts.daySec / 60);
  // 候选：今日分钟 + 昨日跨午夜段（用 +1440 对齐）
  const probes = [nowMin, nowMin + 1440];
  // 优先级：越具体越优先（sat_sun_holiday > sun_holiday > sat > mon_fri > mon_sat > daily）
  const PRIORITY = ["sat_sun_holiday", "sun_holiday", "sat", "mon_fri", "mon_sat", "daily"];

  let best: HeadwayHit | null = null;
  let bestPri = PRIORITY.length;
  for (const row of list) {
    if (!matchesDayType(row.dayType, parts.weekday, isHoliday)) continue;
    for (const t of probes) {
      if (t >= row.fromMin && t <= row.toMin) {
        const pri = PRIORITY.indexOf(row.dayType);
        if (pri >= 0 && pri < bestPri) {
          bestPri = pri;
          best = {
            lo: row.freqLo,
            hi: row.freqHi,
            span: `${row.timeFrom}-${row.timeTo}`,
            dayType: row.dayType,
            crossesMidnight: row.toMin > 1440,
            fromMin: row.fromMin,
            toMin: row.toMin,
            arrivalMin: t,
          };
        }
        break;
      }
    }
  }
  return best;
}

/** 供诊断/测试：清空缓存 */
export function _clearHeadwayCache(): void {
  cache = null;
}

/* ══════════════════════════════════════════════════════════════════════════
   ★ B4（需求 7 / AC-61）：换乘等待的「偏保守」取值 + 数据缺失降级
   ──────────────────────────────────────────────────────────────────────────
   背景：换乘后第 2 段的等车原本写死为常量（第 2 段巴士等车恒 180s），
   导致多段方案总耗时系统性偏乐观（见 02 诊断 §7）。现改为**数据驱动**：
   按「到达换乘站的时刻」查本表（`headwayAt`），取偏保守值；未命中再降级。
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 偏保守取值权重（可审计常量）。
 *
 * `waitMin = lo + WEIGHT × (hi − lo)`：
 *   · 当 `freqLo === freqHi`（定班）⇒ 恒等于班距本身；
 *   · 当 `WEIGHT = 1` ⇒ 取上限（纯最大值，会因粗粒度区间过度膨胀，吓人）；
 *   · 当 `WEIGHT = 1/2` ⇒ 取中点（偏乐观，与本需求「不系统性低估」相悖）；
 *   · **取 `2/3`** —— 落在保守侧（约 P67），兼顾「不系统性低估」与「不过度吓人」。
 *
 * ⚠️ 与 `06-产品-补充调研-推荐排序机制.md` §4.4「等待不再额外线性惩罚」一致：
 *    本值只作为「第 2 段等车的耗时估计」计入 `totalMin`，**不叠加**偏好成本惩罚项。
 */
export const TRANSFER_WAIT_HI_WEIGHT = 2 / 3;

/** 命中区间 → 偏保守等待分钟：`(lo + 2·hi) / 3 = lo + (2/3)·(hi − lo)`。 */
export function conservativeWaitMin(hit: Pick<HeadwayHit, "lo" | "hi">): number {
  return (hit.lo + 2 * hit.hi) / 3;
}

/**
 * ★ v3.6.1（需求 7 · 档 ③）：**连班距中位数都拿不到**时的换乘余量取值。
 *
 * ── 三档取值（`model.ts` 巴士第 2 段 slackMin，与 `07` 文档 §h.3 对齐）────────
 *   | 档 | 数据情况 | `waitMin`（进 totalMin） | `slackMin`（只进 cost/风险项） |
 *   |----|----------|--------------------------|--------------------------------|
 *   | ①  | `headwayAt` 命中时段行 | `(lo + 2·hi)/3` | `max(0, 2·lo − hi)` |
 *   | ②  | 未命中、但中位数可用 | 该线/全表中位数 | `0`（区间丢了 ⇒ 按最不确定） |
 *   | ③  | 连中位数都没有 | 0（且卡面明示「等车时间暂无数据」） | **本常量** |
 *
 * ── 为什么档 ③ 不取 `null`（不判 `yes`）───────────────────────────────────
 *   若档 ③ 取 `null`，风险项为 0 ⇒ 比档 ②（`0` ⇒ `tight`）**更宽松**，等于
 *   「数据越少越不告警」—— 与「不确定时按风险处理」的方向相反，且它唯一的托底是
 *   一句卡面文案（删文案 / 换组件渲染，静默乐观就回来了）。
 *   ⇒ 档 ③ 也走 `tight` 侧。`null` 只保留给「同场换乘不写该字段（`undefined`）」与
 *   「字段缺失」这两种**本就不该有风险信号**的情形。
 *
 * ⚠️ **取值待测量**（原测量入口 `scripts/compare-slack-impact.ts` 的档 ③ 占比 + top3 翻转组数；
 *   ★ 2026-11-06：该脚本已随 `shadow_diff_report` 同批删除，**复测入口已移除**；
 *   如需重测请参考 git 历史（删除前最后一个提交版），
 *   现默认 `0`（= 与档 ② 同口径）。改这里会同时改 cost 与排序，属可审计常量。
 */
export const SLACK_NO_DATA = 0;

/**
 * 班距中位数（分钟）——`headwayAt` 未命中时的**数据驱动降级**。
 *
 * 口径：
 *   · 传 `route` 且该线在本表内 ⇒ 取**该线全部时段行**的 `(freqLo + freqHi) / 2` 中位数；
 *   · 传 `route` 但该线不在表内 ⇒ `null`（由调用方决定是否再退到全表中位数）；
 *   · **不传 `route`**（或传空串）⇒ 取**全表**所有行的 `(freqLo + freqHi) / 2` 中位数。
 *
 * ⚠️ 表很小（`route_frequency` ≈ 512 行）⇒ 即时计算即可，不另建全表统计缓存
 *    （07 §6.4 遗留 ③）。返回 `null` ⇒ 调用方明示降级（不得拍脑袋设默认值）。
 */
export function headwayMedian(idx: HeadwayIndex, route?: string): number | null {
  const mids: number[] = [];
  if (route) {
    const list = idx.byRoute.get(route);
    if (!list || !list.length) return null;
    for (const r of list) mids.push((r.freqLo + r.freqHi) / 2);
  } else {
    for (const list of idx.byRoute.values()) {
      for (const r of list) mids.push((r.freqLo + r.freqHi) / 2);
    }
  }
  if (!mids.length) return null;
  mids.sort((a, b) => a - b);
  const n = mids.length;
  const mid = n >> 1;
  return n % 2 === 1 ? mids[mid] : (mids[mid - 1] + mids[mid]) / 2;
}
