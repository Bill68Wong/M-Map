/**
 * 推荐编排 + 结果缓存（src/lib/recommend/service.ts，v1.0.0）
 *
 * 一条完整的自动选线链路，SSR 页面与 JSON 接口**共用同一份实现**（口径不可能漂移）：
 *
 *   ① loadStatics（60s 进程内缓存）→ 站序 / 段统计 / 步行 / 换乘 / 方案腿
 *   ② optionsFor(from→to)          → 候选路线方案枚举（首段上车 × 动态下车）
 *   ③ fetchLive(seeds)             → 实时班次（DSAT 巴士 + 本库轻轨时刻表，分桶并发）
 *   ④ modelOption × N              → 逐条算门到门总耗时 / 到达时刻 / 赶车档
 *   ⑤ sortCards                    → 按总用时排序，取前 limit 条
 *
 * ⚠️ 本模块含 pg（server-only）。client 只接收 `RecommendCard[]`（`./types` 里的纯视图类型）。
 *
 * ────────────────────────── 缓存 ──────────────────────────
 * `globalThis.__recCache`：key = `from|to|zone|limit`，TTL **10s**。
 *   · 命中 → 直接返回上一次的卡（含 excluded/stats），零计算零网络 → 刷新体感即时。
 *   · 用户手动刷新带 `force` → 绕过缓存直算（并回写）。
 *   · ⚠️ key 必须含 zone：同一 from→to 在 B/C 与 N/O 座区的**步行分钟不同** → 卡也不同。
 *     这正是项目铁律「学校不同座 = 不同目的地」在缓存层的落实。
 */
import type { Pool } from "pg";
import { nowBucketOfHolidayAware } from "@/lib/rebuild/holidays";
import { convergeByAlight } from "./converge";
import { fetchLive, type LiveBatch } from "./live";
import { loadHeadway } from "./headway";
import { ALT_BUSES_MAX, RECOMMEND_LIMIT_DEFAULT } from "./limits";
import { modelOption, sortCards, type ModeledOption } from "./model";
import { contextFor, loadStatics, optionsFor, type RecStatic } from "./query";
import { PREF_DEFAULTS, type Prefs } from "./score";
import type { ScheduleHideReason } from "./schedule";
import type { RecommendCard, SchoolZone } from "./types";

const CACHE_TTL_MS = 10_000;

const g = globalThis as unknown as {
  __recCache?: Map<string, { ts: number; data: RecommendResult }>;
};
if (!g.__recCache) g.__recCache = new Map();

export interface RecommendStats {
  /** 枚举出的候选路线方案总数 */
  candidates: number;
  /** 静态装载耗时（ms） */
  staticMs: number;
  /** 实时层耗时（ms） */
  liveMs: number;
  /** 实时桶数 / DSAT 调用数 / 超时桶数 */
  buckets: number;
  dsatCalls: number;
  timedOut: number;
  /** 模型计算耗时（ms） */
  modelMs: number;
  /** 总耗时（ms） */
  ms: number;
  /** 实时层逐桶明细（诊断） */
  bucketsDetail: LiveBatch["stats"]["items"];
}

export interface RecommendResult {
  fromSlug: string;
  toSlug: string;
  zone: SchoolZone | null;
  cards: RecommendCard[];
  /** 线路码 → 主题色（静态层带出，省一次查询；刷新时可原样复用） */
  colors: Record<string, string>;
  /** 被排除的线路（**无在途车 / 已收车 / 站序缺失**）→ 静默剔除计数器 */
  excluded: string[];
  /**
   * ★ v1.0.6：因「**首段赶不上**」被剔除的线路。
   * 与 `excluded` 分开：前者是「现在这条线没车」，后者是「车来了但你赶不上」——
   * UI 文案要能分辨，诊断也要能分辨。
   */
  missed: string[];
  /**
   * ★ 2026-11-04（U8）：因「不在运营窗口 **且** 无车」被隐藏的线路（与上面两位**并列**）。
   * 记录 `{route, boardMain, reason}` —— `boardMain` 已归一（`C690/3 → C690`）。
   * 没有这一位，「因运营时间隐藏」就不可观测（属静默变更）。
   */
  skipped_by_schedule: { route: string; boardMain: string; reason: ScheduleHideReason }[];
  /**
   * ★ 2026-11-04（U9）：`pin` 指定的那张卡（详情页「另有 N 个下车点」回查用）。
   *
   * 为什么不能在 `cards` 里找：同线收敛（`convergeByAlight`）之后，**非代表下车点**的卡
   * 已不在榜单里；再叠加 `slice(limit)` ⇒ 直接 `find` 必然拿不到 ⇒ 详情页报 `route_changed`。
   * 这里在**收敛之前**按四元组取同一个对象引用（收敛不复制卡对象）⇒ 不需要第二套状态机。
   * 未指定 `pin` 或该四元组本轮无卡 ⇒ `null`。
   */
  pinned: RecommendCard | null;
  stats: RecommendStats;
  /** 结果生成时刻（ms） */
  generatedAt: number;
  /** 本次是否命中缓存 */
  cached: boolean;
}

export interface RecommendInput {
  fromSlug: string;
  toSlug: string;
  /** 座区（仅 school 侧有意义；非 school 侧忽略） */
  zone?: SchoolZone | null;
  /** 取前几名（默认 5） */
  limit?: number;
  /** 绕过 10s 缓存直算（用户手动刷新） */
  force?: boolean;
  /**
   * ★ 时间基准注入（默认 `Date.now()`）。用途：探针在**收班时段**用假时间验证白天链路
   * （轻轨时刻表按注入时刻算；⚠️ 巴士是 DSAT 实时数据，**无法伪造**——
   *  深夜跑探针时巴士仍按真实无车剔除，属预期）。
   */
  nowMs?: number;
  /**
   * ★ B4（需求 8）：**用户偏好三档**（缺省 `balanced`）。影响**排序**（`sortCards`），
   *   不影响 `totalMin` 数值；并已纳入 10s 缓存键（不同偏好不互相污染）。
   */
  prefs?: Prefs;
  /**
   * ★ 2026-11-04（U9）：把**指定四元组**（planId + route + board + alight）的那张卡一并带出
   * （`RecommendResult.pinned`）。详情页回查「非代表下车点」时用 —— 那些卡已被同线收敛/
   * 名额裁掉，光靠 `cards[].find()` 拿不到。**不传 ⇒ 零副作用**。
   */
  pin?: { planId: number; route: string; board: string; alight: string };
}

/**
 * 算一批推荐卡。
 * @returns 可能 `cards` 为空（该时段线路全部收车/无在途车）——调用方须渲染空状态
 */
export async function recommend(
  pool: Pool,
  input: RecommendInput,
): Promise<RecommendResult> {
  const zone = input.zone ?? null;
  // ★ 2026-11-04（U10）：默认张数 5 → 6（`RECOMMEND_LIMIT_DEFAULT`，**禁止**再写字面量）
  const limit = Math.max(1, Math.min(20, input.limit ?? RECOMMEND_LIMIT_DEFAULT));
  // ★ B4（需求 8）：偏好在**缓存键内**（不同档排序不同 ⇒ 不可共用同一条缓存）
  const prefs = input.prefs ?? PREF_DEFAULTS.balanced;
  /** ★ U9：pin 必须进缓存键 —— 否则不同 `pin` 会共用同一条缓存而拿到错的 `pinned` */
  const pinKey = input.pin
    ? `pin:${input.pin.planId}|${input.pin.route}|${input.pin.board}|${input.pin.alight}`
    : "";
  const key = `${input.fromSlug}|${input.toSlug}|${zone ?? ""}|${limit}|${prefs.mode}|${pinKey}`;
  const cached = g.__recCache!.get(key);
  if (!input.force && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { ...cached.data, cached: true };
  }

  const tAll = Date.now();
  const nowMs = input.nowMs ?? Date.now();

  // ① 静态
  const tStatic = Date.now();
  const st: RecStatic = await loadStatics(pool);
  const staticMs = Date.now() - tStatic;

  // ② 枚举候选
  const seeds = optionsFor(st, input.fromSlug, input.toSlug);

  // ③ 实时
  const tLive = Date.now();
  // ★ B4（需求 7）：发车间隔索引注入实时层（未发车估算）与模型上下文（第 2 段巴士等车）
  const headway = await loadHeadway(pool);
  const nowBucket = await nowBucketOfHolidayAware(pool, nowMs);
  const batch = await fetchLive(pool, seeds, st.routeIdx, st.segIdx, {
    nowBucket,
    nowMs: input.nowMs,
    lrtPre: st.lrtPre,
    headway,
  });
  const liveMs = Date.now() - tLive;

  // ④ 逐条建模
  const tModel = Date.now();
  const ctx = { ...contextFor(st, nowMs, zone, batch.live, nowBucket), headway };
  const modeled: ModeledOption[] = [];
  for (const seed of seeds) {
    const m = modelOption(seed, ctx);
    if (m) modeled.push(m);
  }
  // ⑤ 排序取前 N
  // ★ 2026-11-04（U9）：**同线同上下车站（按主码）收敛** —— 位置必须在 `slice(limit)` 之前，
  //   否则被收敛掉的卡已经占掉名额，收敛等于白做。
  //   顺序：枚举 → R1 站内互斥（enumerate）→ **R5（IMP6）站台归一（enumerate）**
  //        → **IMP7 同线收敛（此步，必须在 slice 之前）** → sortCards → slice(limit)
  const converged = convergeByAlight(modeled.map((m) => m.card), prefs.mode);
  const top = sortCards(converged, prefs).slice(0, limit);

  /**
   * ★ 2026-11-04（U9）：`pin` 指定的卡 —— 在**收敛之前**按四元组取同一个对象引用。
   * 收敛/排序只搬数组、不复制卡对象 ⇒ 取到的就是详情页要的那一张。
   */
  const pinned: RecommendCard | null = input.pin
    ? (modeled.find((m) => {
        const r0 = m.card.rides[0];
        const p = input.pin!;
        return (
          !!r0 &&
          m.card.planId === p.planId &&
          r0.route === p.route &&
          r0.board === p.board &&
          r0.alight === p.alight
        );
      })?.card ?? null)
    : null;

  // ★ v1.1.5：回填「本班之外的后续班次」——阈值是**第 N 张卡的总时长**，
  //   所以必须在排完序取完前 N 之后才能算（`modelOption` 无法预知阈值）。
  //   用户口径：坐这一班后车的话，**门到门总时长要不差于第 N 张卡**才值得列出来。
  if (top.length) {
    const threshold = top[top.length - 1].totalMin;
    const topSet = new Set(top);
    for (const m of modeled) {
      if (!topSet.has(m.card)) continue;
      // ★ U9：单卡「后续班车」最多 `ALT_BUSES_MAX` 行（口径见 limits.ts）
      const keep = m.alts.filter((a) => a.totalMin <= threshold + 1e-9).slice(0, ALT_BUSES_MAX);
      if (keep.length) m.card.altBuses = keep;
    }
  }
  const modelMs = Date.now() - tModel;

  const result: RecommendResult = {
    fromSlug: input.fromSlug,
    toSlug: input.toSlug,
    zone,
    cards: top,
    colors: st.routeColors,
    excluded: [...new Set(ctx.excluded)],
    missed: [...new Set(ctx.missed)],
    skipped_by_schedule: ctx.skippedBySchedule ?? [],
    pinned,
    stats: {
      candidates: seeds.length,
      staticMs,
      liveMs,
      buckets: batch.stats.buckets,
      dsatCalls: batch.stats.dsatCalls,
      timedOut: batch.stats.timedOut,
      modelMs,
      ms: Date.now() - tAll,
      bucketsDetail: batch.stats.items,
    },
    generatedAt: nowMs,
    cached: false,
  };

  g.__recCache!.set(key, { ts: Date.now(), data: result });
  return result;
}

/** 清空推荐结果缓存（探针 / 调试用，慎在生产调用） */
export function clearRecommendCache(): void {
  g.__recCache?.clear();
}
