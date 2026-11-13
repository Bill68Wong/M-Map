/**
 * 全澳导航编排（src/lib/nav/nav-service.ts，v1.3.0 提案 · T03）
 *
 * ── 一条完整链路（设计 §1.1 / §2.B / §2.C）────────────────────────────
 *   ① 静态装载 `loadStatics()`（复用旧推荐域：站序/段统计/步行/换乘/轻轨预载）；
 *   ② 站码映射表 `loadStationMap()`（人工确认优先）；
 *   ③ **高德 transit**（`fetchTransitPlans`，`AlternativeRoute=10`）——
 *      ★ 2026-11-06（问题 #6）：**每次请求都真实调用**；`transit_cache` 退化为
 *      「真实调用彻底失败时的拓扑兜底」（`stats.transitCacheFallback` 可观测）。
 *   ④ 解析 → 过滤（穿梭巴士/在建）→ **桥接**（高德站→我们主码 + 逐跳站序）；
 *   ⑤ **本地图枚举**（补漏来源；**请求期现场跑**，失败即降级引擎）→ 候选；
 *   ⑥ `fetchLive`（DSAT 巴士 + 本库轻轨时刻表，**两来源共用一次**）；
 *   ⑦ 逐方案：`modelOption`（**注入 walkResolver + 方案级换乘索引**）→ `patchAmapFallback`（映射失败段回落高德 + provenance）；
 *   ⑧ `merge-sources`（补漏质量闸门；数量**默认不限**）→ `rank`（`T_ours` 升序）；
 *   ⑨ 返回前 `limit` 张（与旧版**完全一致**的卡片结构 → T04 直接复用渲染）。
 *
 * ── ★ 降级（§B.6）─────────────────────────────────────────────────────
 *   高德失败/超时/限流/0 方案 → `degraded=true`，**只用本地枚举 + `walk_times`（旧实测）**出卡。
 *
 * ── ★ 请求期现场枚举（2026-09-19 口径变更）──────────────────────────────
 *   产品拍板：本地枚举**每次请求现场执行**（`searchStationPaths`），**不再依赖离线表**
 *   `shadow_diff_report`。理由：离线表只覆盖历史 OD，新 OD 拿不到补漏；且枚举已被
 *   「链级限额 + 阶段预算」压到可控成本（研究报告 §4.6：修候选数控制后漏线率 20.5% → 8.6%）。
 *   ⇒ 删除原「只读离线表 `loadOfflineExtras`」路径，`localSource` 语义固定为 `"inline"`。
 *
 * ── ★ 多策略按需补查（2026-09-19 口径变更）──────────────────────────────
 *   默认只查高德 `strategy=0`；当**可用候选偏少**（`< MULTI_STRATEGY_WHEN_BELOW`）时
 *   **并行**补查 s=7/s=8 并按方案指纹合并去重（省配额 15 万/月；见 `fetchMultiStrategySeeds`）。
 *   补查**不得拖垮主流程**：整体失败静默降级为「只有 s=0 结果」。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §1.1 / §2.B / §2.C / §B.5 / §B.6
 */
import type { Pool } from "pg";
import { gcj02ToWgs84, haversineM } from "@/lib/amap/coord";
import { nowBucketOfHolidayAware } from "@/lib/rebuild/holidays";
import { fixWalkDistance, walkMinutes } from "@/lib/amap/walk-fix";
import {
  fetchTransitPlans,
  odKeyOf,
  TRANSIT_CACHE_TTL_SEC,
  type RawPlan,
  type TransitCacheIo,
  type AmapTransitRawResponse,
} from "@/lib/amap/transit";
import { convergeByAlight } from "@/lib/recommend/converge";
import { fetchLive } from "@/lib/recommend/live";
import { ALT_BUSES_MAX, NAV_LIMIT_DEFAULT } from "@/lib/recommend/limits";
import { amapPlanToSeed, modelOption, type ModeledOption } from "@/lib/recommend/model";
import { contextFor, loadStatics, type RecStatic } from "@/lib/recommend/query";
import { loadHeadway } from "@/lib/recommend/headway";
import { PREF_DEFAULTS, type Prefs } from "@/lib/recommend/score";
import { holidayFallbackOf, type ScheduleHideReason } from "@/lib/recommend/schedule";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { AltBusView, OptionSeed, RecommendCard, SchoolZone } from "@/lib/recommend/types";
import { candidatesToSeeds, chainToCandidates, pathsToCandidates, LOCAL_SUMMARY } from "./enumerate-nav";
import { inMacauServiceArea, nearestEntryPoint } from "./macau-service-area";

/**
 * ★ 2026-11-12（P1）：「起终点过近 ⇒ 建议直接步行」的直线距离阈值（米）。
 *
 * 原实现把 `400` 写死在收尾处 `if (cards.length === 0)` 内层 —— 而本地补充策略会先把卡片凑满，
 * 该分支对新请求**永不进入**，等于死代码（实测 `from == to` 仍返回 6 张「绕一圈回到原点」的卡）。
 * 现在同一常量被**两处**引用：① 候选枚举之前的早退闸门；② 收尾兜底（chain 模式与边界情形）。
 * 提到一处是为了防止两个字面量各自漂移（改一个忘一个 ⇒ 早退与归因口径不一致）。
 */
const NAV_TOO_CLOSE_M = 400;
import { anchorMainFor } from "./anchor";
import { siblingSeedsOf } from "./parallel-alts";
import { applyWalkSeg, tierSpeedOverrideOf, type ChainStep, type TierOverride, type WalkOverride } from "./combo-params";
import { searchStationPaths, type GeoStation, type StationPath } from "./graph-search";
import { loadStationMap, type BridgeContext, type StationMap } from "./map-stations";
import { mergeSources } from "./merge-sources";
import { parseAndBridge } from "./parse-amap-plan";
import { rankItems, type RankedItem } from "./rank";
import { applyLrtPriority } from "@/lib/recommend/lrt-priority";
import { makeCacheWalkResolver, makeWalkResolver, ourDataCoverage, overlayTransferIndex, patchAmapFallback, type WalkCacheMap } from "./recompute";
import type { AmapPlanSeed, NavEmptyReason, NavPoint, RecomputeProvenance, SegmentLevel, WalkResolver } from "./types";

// ─────────────────────────── 接口 ───────────────────────────

export interface NavInput {
  origin: NavPoint;
  dest: NavPoint;
  /** 座区（仅当 origin/dest 是学校 place 时有意义） */
  zone?: SchoolZone | null;
  /** 取前几名（默认 5） */
  limit?: number;
  /** 时间基准（默认 `Date.now()`；测试可注入） */
  nowMs?: number;
  /**
   * ★ 2026-11-06（问题 #6 · C1）语义已收窄：主调用**恒不读** `transit_cache`，
   *   本参数现在只控制**失败兜底**要不要读缓存（`true` ⇒ 连兜底也不要，宁失败不给旧拓扑）。
   *   `/api/nav?nocache=1`（用户手动刷新）正是这个语义。
   */
  noCache?: boolean;
  /**
   * @deprecated 自 2026-09-19 起**本地枚举每次请求现场执行**（见文件头「请求期现场枚举」），
   *   本字段不再生效，保留仅为**编译兼容**（现有调用方均未传，实际可删）。
   */
  allowInlineLocal?: boolean;
  /** 测试/回放：直接注入高德原始响应（跳过网络） */
  transitFixture?: AmapTransitRawResponse;
  /**
   * ★ v2.3.0（`/api/nav` 可选参数）：**自定义站链**（07 §2.2）。
   *   非空 ⇒ **候选枚举按链约束**（段 = 用户指定 board/alight/routes；不调高德）；
   *   缺省 ⇒ 自动选线，**行为与 v2.2.0 完全一致**。
   */
  chain?: ChainStep[];
  /** ★ v2.3.0：两段步行覆盖（仅在 `chain` 非空时生效，见 07 §2.2） */
  walk?: WalkOverride;
  /** ★ v2.3.0：五档覆盖（仅在 `chain` 非空时生效） */
  tiers?: TierOverride;
  /**
   * ★ B4（需求 8）：**用户偏好三档**（`balanced` 默认 / `fewer_transfers` / `less_walk`）。
   *   缺省 ⇒ `PREF_DEFAULTS.balanced`（cost 升序，与「综合」档等价）。
   *   ⚠️ 偏好只影响**排序**（`rankItems` / `sortCards`）；**不进** `switch-plans` 组内排序。
   */
  prefs?: Prefs;
  /**
   * ★ v3.3.0（AC-105 · `/api/nav?lrtFirst=1`）：**轻轨优先**开关。
   *   true ⇒ 含轻轨段且总时长 ≤ 前 `limit` 张最慢 + 15min 的候选**稳定置顶**；
   *   其余相对序不变、张数不变；未命中静默。缺省 = false（行为与旧版完全一致）。
   */
  lrtFirst?: boolean;
}

export interface NavStats {
  staticMs: number;
  /** 高德 s=0 主策略耗时（**不含**多策略补查，见 `multiStrategyMs`） */
  transitMs: number;
  /**
   * ★ v3.7.0（C13）：s=7/s=8 **多策略按需补查**耗时（毫秒），未触发补查时恒 0。
   *
   * 为什么单独计量而不并入 `transitMs`：`transitMs` 是既有的「高德主调用」口径，
   * 已被历次基线测量与测试引用；补查是**条件分支**（仅当 s=0 候选 < 阈值），
   * 并入会让同一字段在两次请求间代表不同含义 ⇒ 归因永远算不清。
   * 实测：只要 `strategiesUsed` 含 7/8，「未埋点」就从 59–741ms 跳到 817–4022ms。
   */
  multiStrategyMs: number;
  transitOk: boolean;
  /** true = 本次的 `rawPlans` 来自 `transit_cache`（见下方 `transitCacheFallback`，正常路径恒 false） */
  transitFromCache: boolean;
  /**
   * ★ 2026-11-06（问题 #6 · C1）：**高德真实调用彻底失败**，本次读的是 60s 内最近一次
   *   成功结果（兜底）。正常路径恒 `false` —— 因为主调用已强制 `noCache`。
   *
   * 为什么必须单独可观测：把缓存从「默认复用」改成「仅失败兜底」以后，
   *   `transitFromCache=true` 的含义从「省了一次调用」变成「**高德此刻不可用**」。
   *   两者的运维处置完全不同（前者是常态，后者要查配额/网络），混用一个字段就分不清。
   */
  transitCacheFallback: boolean;
  amapPlans: number;
  bridged: number;
  /**
   * ★ v3.3.0（AC-119 / ADR-105 §3）：**合并**两类丢弃记录 ——
   *   · 高德解析丢弃：`{ index, reason }`（如 `s7:unsolvable`）；
   *   · 本地闸门丢弃：`{ key, reason }`（如 `low_coverage(0.42)` / `unsolvable_stops` / `duplicate_of_amap` / `suspect`）。
   *   旧口径只记高德侧 ⇒ 本类「本地候选被闸门丢掉」的问题**长期不可见**。
   */
  dropped: { index?: number; key?: string; reason: string }[];
  localCandidates: number;
  localKept: number;
  /** 本地枚举来源：`"inline"` = 请求期现场跑；`"none"` = 未产出（无近站等） */
  localSource: "inline" | "none";
  /** ★ 本次实际使用的高德策略（诊断用；如 `[0]` 或 `[0,7,8]`） */
  strategiesUsed: number[];
  /** ★ v2.3.0：是否走「自定义站链」模式（诊断用；true 时未调高德） */
  chainMode: boolean;
  liveMs: number;
  modelMs: number;
  ms: number;
}

export interface NavOutput {
  fromSlug: string;
  toSlug: string;
  /** 卡片（与旧版 `RecommendCard` **同构** → T04 直接复用） */
  cards: RecommendCard[];
  colors: Record<string, string>;
  /** true = 走高德降级路径（本地推算）→ UI 须提示「本地推算」 */
  degraded: boolean;
  emptyReason?: NavEmptyReason;
  /** ★ 当 `emptyReason='too_close'` 时给出的**纯步行建议**（分钟）——「走路比坐车快」（§11.4） */
  nearbyWalkMin?: number;
  /** 逐方案的二次计算凭据（键 = `optionSeed.key`） */
  provenance: Record<string, RecomputeProvenance>;
  /** 被剔除的线路（无在途车 / 已收车）与「首段赶不上」——沿用旧语义 */
  excluded: string[];
  missed: string[];
  /**
   * ★ 2026-11-04（U8）：因「不在运营窗口 **且** 无车」被隐藏的线路（与上面两位并列）。
   * 记录 `{route, boardMain, reason}` —— 没有这一位，「因运营时间隐藏」就不可观测。
   */
  skipped_by_schedule: { route: string; boardMain: string; reason: ScheduleHideReason }[];
  /** ★ 2026-11-04（U8）：假期表不可用 ⇒ U8 本轮**未生效**（一律不因时间隐藏） */
  holiday_fallback: boolean;
  /**
   * ★ 2026-11-13（P6 收尾）：**起点在服务范围外时，实际采用的入境口岸**。
   *
   * 背景：从珠海/香港出发是真实需求，不能像目的地那样直接判 `out_of_scope`；
   *   但拿珠海坐标去找"最近的澳门站"会跨海吸附到路环/氹仔某站，规划出现实走不通的路线。
   *   ⇒ 改为锚到最近**入境口岸**（关闸/青茂/横琴/港珠澳/氹仔码头/外港码头），并在响应里
   *   明确告诉 UI「出发点被换成了哪个口岸」，否则用户看到「步行 300m 到关闸总站」会莫名。
   *
   * `null` / 缺省 = 起点本来就在服务范围内（绝大多数请求）⇒ UI 不渲染任何提示。
   */
  origin_gate?: { name: string; lng: number; lat: number } | null;
  stats: NavStats;
  generatedAt: number;
}

// ─────────────────────────── 缓存（映射表 / 站点地理） ───────────────────────────

const TTL_MS = 60_000;
const g = globalThis as unknown as {
  __navCaches?: { map?: { ts: number; data: StationMap }; geo?: { ts: number; data: GeoStation[] } };
};
if (!g.__navCaches) g.__navCaches = {};

async function loadStationMapCached(pool: Pool, force = false): Promise<StationMap> {
  const c = g.__navCaches!.map;
  if (!force && c && Date.now() - c.ts < TTL_MS) return c.data;
  const data = await loadStationMap(pool);
  g.__navCaches!.map = { ts: Date.now(), data };
  return data;
}

/** 站点地理（主码去重；**WGS84**，供本地图枚举的近站筛选） */
export async function loadStationGeoCached(pool: Pool, force = false): Promise<GeoStation[]> {
  const c = g.__navCaches!.geo;
  if (!force && c && Date.now() - c.ts < TTL_MS) return c.data;
  const res = await pool.query(`SELECT code, lat, lng FROM stations WHERE lat IS NOT NULL AND lng IS NOT NULL`);
  const seen = new Set<string>();
  const data: GeoStation[] = [];
  for (const r of res.rows as Record<string, unknown>[]) {
    const main = mainCodeOf(String(r.code));
    if (seen.has(main)) continue;
    seen.add(main);
    data.push({ main, lat: Number(r.lat), lng: Number(r.lng) });
  }
  g.__navCaches!.geo = { ts: Date.now(), data };
  return data;
}

/** ★ P1-4：`walk_cache` 内存索引（供**本地/降级**路径的首末步行解析器；表小，整体载入） */
const gWalk = globalThis as unknown as { __navWalkCache?: { ts: number; data: WalkCacheMap } };
export async function loadWalkCacheCached(pool: Pool, force = false): Promise<WalkCacheMap> {
  const c = gWalk.__navWalkCache;
  if (!force && c && Date.now() - c.ts < TTL_MS) return c.data;
  const m: WalkCacheMap = new Map();
  try {
    const res = await pool.query(`SELECT cache_key, distance_m, corrected_m FROM walk_cache LIMIT 20000`);
    for (const r of res.rows as Record<string, unknown>[]) {
      const d = Number(r.distance_m);
      const cm = Number(r.corrected_m);
      m.set(String(r.cache_key), {
        distanceM: Number.isFinite(d) ? d : null,
        correctedM: Number.isFinite(cm) ? cm : null,
      });
    }
  } catch {
    /* 表缺失 → 空缓存（解析器会回落「直线×1.5」） */
  }
  gWalk.__navWalkCache = { ts: Date.now(), data: m };
  return m;
}

// ─────────────────────────── 辅助 ───────────────────────────

/** 高德 OD 缓存读写（表不存在时静默降级为「不过缓存」） */
function makeTransitCacheIo(pool: Pool): TransitCacheIo {
  return {
    async get(odKey: string, ttlSec: number): Promise<RawPlan[] | null> {
      try {
        const r = await pool.query(
          `SELECT plans_json FROM transit_cache
            WHERE od_key = $1 AND fetched_at > now() - make_interval(secs => $2)`,
          [odKey, ttlSec],
        );
        const row = (r.rows as { plans_json?: unknown }[])[0];
        if (!row?.plans_json || !Array.isArray(row.plans_json)) return null;
        return row.plans_json as RawPlan[];
      } catch {
        return null;
      }
    },
    async put(odKey: string, plans: RawPlan[]): Promise<void> {
      try {
        await pool.query(
          `INSERT INTO transit_cache (od_key, plans_json, fetched_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT (od_key) DO UPDATE SET plans_json = EXCLUDED.plans_json, fetched_at = now()`,
          [odKey, JSON.stringify(plans)],
        );
      } catch {
        /* 缓存写失败不影响本次结果 */
      }
    },
  };
}

/**
 * ★ 多策略按需补查阈值（产品口径 2026-09-19）：s=0 的**可用候选**（`seeds.length`）低于此值时，
 *   补查 s=7/s=8 以覆盖「路线太少」问题；否则只查 s=0（省配额）。
 */
const MULTI_STRATEGY_WHEN_BELOW = 3;

/**
 * ★ 2026-09-21：高德 transit 失败后的**重试间隔**（毫秒）。
 *
 * 实测高德会「几十秒内时好时坏」（同一查询连测得 正常 / 0 方案 / 正常 三种结果）
 * ⇒ 失败后稍等再试一次，即可消掉大部分此类抖动，用户不必手动刷新。
 * 取 350ms：足够让瞬时故障过去，又不会明显拖长请求（Serverless 有 maxDuration 约束）。
 */
const TRANSIT_RETRY_DELAY_MS = 350;

/** 补查使用的高德策略（产品指定：7/8） */
const MULTI_STRATEGIES: readonly number[] = [7, 8];

/**
 * ★ 方案指纹（跨策略去重用）：乘车段按 `${kind}:${线路名}:${上车站名}>${下车站名}` 拼接。
 *   用**高德原文**（`amapLineName`/`amapBoard.name`/`amapAlight.name`）而非桥接后主码——
 *   桥接可能部分失败，主码为空会把不同方案误判成同一条，原文更稳。
 */
function planFingerprint(seed: AmapPlanSeed): string {
  return seed.legs
    .map((l) => `${l.kind}:${l.amapLineName}:${l.amapBoard.name}>${l.amapAlight.name}`)
    .join("|");
}

/**
 * 按指纹把 `extra` 方案并入 `base`（**`base` 优先保留**：已存在指纹的 extra 丢弃）。
 * @returns 去重后的新数组（`base` 顺序不变，新增项追加在后）
 */
function mergeSeedsByFingerprint(base: AmapPlanSeed[], extra: AmapPlanSeed[]): AmapPlanSeed[] {
  const seen = new Set(base.map(planFingerprint));
  const out = [...base];
  for (const s of extra) {
    const fp = planFingerprint(s);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push(s);
  }
  return out;
}

/**
 * ★ 多策略按需补查（产品口径 2026-09-19）：并行抓 s=7/s=8 → 解析桥接 → 各策略独立容错。
 *
 * · 每个策略**独立 try/catch**：单个失败**静默忽略**（视为空），不影响其它策略与主流程；
 * · 仍走原缓存（`transit_cache`，键含策略维度）与令牌桶（`rate-limit`）；
 * · 整体失败 ⇒ 返回空，调用方自然降级为「只有 s=0 结果」（**补查不得拖垮主流程**）。
 *
 * @returns 补查 seeds（**未与 s=0 去重**，由调用方合并）、带策略标签的 dropped、成功的策略号
 */
async function fetchMultiStrategySeeds(
  pool: Pool,
  origin: NavPoint,
  dest: NavPoint,
  bridgeCtx: BridgeContext,
  nowMs: number,
  noCache?: boolean,
): Promise<{ seeds: AmapPlanSeed[]; dropped: { index: number; reason: string }[]; strategiesUsed: number[] }> {
  const results = await Promise.all(
    MULTI_STRATEGIES.map(async (strategy) => {
      try {
        const r = await fetchTransitPlans(
          { lng: origin.lng, lat: origin.lat },
          { lng: dest.lng, lat: dest.lat },
          { cache: makeTransitCacheIo(pool), noCache, nowMs, strategy },
        );
        if (!r.ok) return { strategy, ok: false as const, seeds: [], dropped: [] };
        const raw: AmapTransitRawResponse = { status: "1", route: { transits: r.raw } };
        const parsed = parseAndBridge(raw, origin, dest, bridgeCtx);
        return {
          strategy,
          ok: true as const,
          seeds: parsed.seeds,
          // ★ 标注策略号，避免与 s=0 的 `index` 混淆（各策略 index 都从 1 起）
          dropped: parsed.dropped.map((d) => ({ index: d.index, reason: `s${strategy}:${d.reason}` })),
        };
      } catch {
        return { strategy, ok: false as const, seeds: [], dropped: [] };
      }
    }),
  );

  const seeds: AmapPlanSeed[] = [];
  const dropped: { index: number; reason: string }[] = [];
  const strategiesUsed: number[] = [];
  for (const r of results) {
    if (!r.ok) continue;
    strategiesUsed.push(r.strategy);
    seeds.push(...r.seeds);
    dropped.push(...r.dropped);
  }
  strategiesUsed.sort((a, b) => a - b); // Promise.all 已保序，此处再兜一层
  return { seeds, dropped, strategiesUsed };
}

/** NavPoint → 合成 slug（复用旧 `model.ts` 的 school 座区判据） */
function slugOf(p: NavPoint, placeSlugs: Set<string>): string {
  if (p.kind === "place" && p.code && placeSlugs.has(p.code)) return p.code;
  return p.kind;
}

/**
 * ★ v2.3.0：把「组合级步行覆盖」（`/api/nav` 的 `walk`）套到步行解析器上。
 *   `seg1` = 出发地→上车站（out）；`seg2` = 下车站→目的地（in）——见 07 §2.5。
 *   **无覆盖 → 原样返回**（自动选线/默认链路零变化）。
 */
function withWalkOverride(r: WalkResolver, ov?: WalkOverride): WalkResolver {
  if (!ov || (!ov.seg1 && !ov.seg2)) return r;
  return {
    out: () => applyWalkSeg(r.out(""), ov.seg1),
    in: () => applyWalkSeg(r.in(""), ov.seg2),
  };
}

// ─────────────────────────── 主流程 ───────────────────────────

export async function planNav(pool: Pool, input: NavInput): Promise<NavOutput> {
  const tAll = Date.now();
  const nowMs = input.nowMs ?? Date.now();
  // ★ 2026-11-04（U10）：默认张数 5 → `NAV_LIMIT_DEFAULT`（与 /recommend 同值、但常量并存不合并）
  const limit = Math.max(1, Math.min(20, input.limit ?? NAV_LIMIT_DEFAULT));
  const zone = input.zone ?? null;
  const origin = input.origin;
  const dest = input.dest;

  // ★ v2.3.0：自定义站链模式（`chain` 非空）—— 候选枚举按链约束、**不调高德**；
  //   `walk` / `tiers` 仅在此模式下生效（07 §2.2：chain 为空 = 现有路径，零改动）。
  const chain = input.chain && input.chain.length >= 2 ? input.chain : undefined;
  const chainMode = !!chain;
  const tierOverride = chainMode ? tierSpeedOverrideOf(input.tiers) : undefined;
  // ★ B4（需求 8）：偏好三档（缺省 balanced）
  const prefs = input.prefs ?? PREF_DEFAULTS.balanced;

  /**
   * ★ 2026-11-13（P6 收尾）：**起点在服务范围外 ⇒ 锚到最近入境口岸**。
   *
   * 旧行为：起点不判范围，交给坐标吸附去找"最近的澳门站"。珠海长隆（对岸）会跨海吸到
   *   路环或氹仔的某个站，再让高德规划「步行过海」—— 生成一条现实中走不通的路线。
   *
   * 为什么不直接判 `out_of_scope`：从珠海/香港过关来澳门是真实需求，砍掉等于把主路径
   *   一起砍了（目的地判定可以砍，起点不行）。改为落到**通关必经的口岸**，
   *   首段接驳才是真的；同时把落点写进 `origin_gate` 让 UI 明说，避免"我明明在长隆"。
   *
   * `chainMode` 不锚：显式站链是用户自己的意图，与 P1/P6 早退同一取舍。
   */
  const originGate =
    !chainMode && !inMacauServiceArea(origin.lng, origin.lat)
      ? nearestEntryPoint(origin.lng, origin.lat)
      : null;
  const fromWgs = gcj02ToWgs84(
    originGate ? { lng: originGate.lng, lat: originGate.lat } : { lng: origin.lng, lat: origin.lat },
  );
  const toWgs = gcj02ToWgs84({ lng: dest.lng, lat: dest.lat });

  // ① 静态
  const tStatic = Date.now();
  const st: RecStatic = await loadStatics(pool);
  const staticMs = Date.now() - tStatic;

  const map = await loadStationMapCached(pool);
  const geo = await loadStationGeoCached(pool);
  const validRoutes = new Set<string>(st.routeIdx.dirsOf.keys());
  const bridgeCtx: BridgeContext = { map, validRoutes, routeIdx: st.routeIdx, geo };
  const placeSlugs = new Set(Object.keys(st.placeIds));
  const fromSlug = slugOf(origin, placeSlugs);
  const toSlug = slugOf(dest, placeSlugs);

  // ★ v2.3.0（07 §3.7 软吸附）：POI/地点名 ↔ 站名 命中（L1/L2）+ L3 距离闸门 ⇒ 吸附锚站主码。
  //   只改「下车/上车锚站」，**不改终点本身**（`walkIn` 仍走到 POI 坐标）；无命中 ⇒ null（逻辑不变）。
  const anchorFromMain = anchorMainFor({ label: origin.label, lng: origin.lng, lat: origin.lat }, geo, st.routeIdx)?.main;
  const anchorToMain = anchorMainFor({ label: dest.label, lng: dest.lng, lat: dest.lat }, geo, st.routeIdx)?.main;

  const straightM = haversineM(fromWgs, toWgs);

  /**
   * 「尚未调用任何上游就早退」的响应骨架（P1 过近 / P6 范围外共用）。
   *
   * 为什么抽出来：这两条早退的字段**除 `emptyReason`/`nearbyWalkMin` 外完全一致**。
   *   复制两份的代价不是这 20 行，而是以后每加一个 `stats` 字段都要记得改两处 ——
   *   漏一处的表现是「某些空态下 stats 缺键」，而 JSON 很难在测试里立刻发现。
   *
   * ⚠️ `degraded` 必须显式 `false`：下面收尾路径写的是 `!transitOk && !chainMode`，
   *   而早退时 `transitOk` 尚未置位（恒 false）——若照抄该表达式会把「没调高德」
   *   误标成「高德不可用、本地推算」，前端会挂上「本地推算」标签。
   * ⚠️ `stats` 其余字段恒 0 是**事实**而非占位：早退确实没调高德、没建模、没排名。
   */
  const earlyExit = (emptyReason: NavEmptyReason, extra: Partial<NavOutput> = {}): NavOutput => ({
    fromSlug,
    toSlug,
    cards: [],
    // colors 取已装载的 `st.routeColors`（空卡片时 UI 用不到，但契约要求非空映射）
    colors: st.routeColors,
    degraded: false,
    emptyReason,
    provenance: {},
    excluded: [],
    missed: [],
    skipped_by_schedule: [],
    // 未读 headway ⇒ 不存在「假期表不可用」，恒 false（不是"未知"）
    holiday_fallback: false,
    stats: {
      staticMs,
      transitMs: 0,
      multiStrategyMs: 0,
      transitOk: false,
      transitFromCache: false,
      transitCacheFallback: false,
      amapPlans: 0,
      bridged: 0,
      dropped: [],
      localCandidates: 0,
      localKept: 0,
      localSource: "none",
      strategiesUsed: [],
      chainMode,
      liveMs: 0,
      modelMs: 0,
      ms: Date.now() - tAll,
    },
    generatedAt: nowMs,
    // 起点被锚到口岸时如实上报（UI 据此显示「已从 XX 出发」）；范围内 ⇒ null
    origin_gate: originGate,
    ...extra,
  });

  // ★ 2026-11-12（P1）：**起终点过近 ⇒ 候选枚举之前早退**（"走路比坐车快"，§11.4）。
  //
  //   为什么必须提前：原判据写在收尾处 `if (cards.length === 0)` 里，但本地补充策略
  //   （请求期现场枚举）会先生成候选 ⇒ 卡片数永不为 0 ⇒ 该判据对新请求**永不进入**。
  //   实测 `from == to`（直线 0 米）返回 6 张卡，卡 1 = 步行 113m → 關閘總站 → AP1 转 3A
  //   → 回 M1 → 步行 113m，全程 41 分钟「绕一圈回到原点」——这是错误推荐，不是降级。
  //
  //   触发场景：GPS 抖动后点「到这里」、或直接选了身边的站（直线 < 阈值）。
  //   收益：除纠正结论外，本轮还省掉高德调用 + 建模 + 排名（早退发生在 ② 本地 / ③ 高德 之前）。
  //
  //   `chain` 模式**不受约束**：自定义站链是用户的显式意图（300m 也可能是他要的走法），
  //   与收尾处 `if (chainMode)` 分支保持同一取舍。
  if (!chainMode && straightM < NAV_TOO_CLOSE_M) {
    // 纯步行建议：直线 → 短距修正（无高德几何）→ ÷84（常速基准分钟），与收尾处同一口径
    const corrected = fixWalkDistance(straightM, null).correctedM;
    return earlyExit("too_close", { nearbyWalkMin: Math.max(1, Math.round(walkMinutes(corrected))) });
  }

  // ★ 2026-11-13（P6）：**目的地不在澳门服务范围 ⇒ 明确归因**，不再伪装成「已收班」。
  //
  //   旧行为：目的地填珠海长隆 → `cards: 0 + emptyReason:"no_live"`，文案「暂时没有可用的班次
  //   …线路大多已收班」⇒ 用户以为等一会儿就有车，实际**永远不会有**。
  //
  //   为什么排在 too_close **之后**：起终点都在珠海且相距 100m 时，「建议直接步行」仍然是
  //   用户眼前能执行的正确结论（人确实走两步就到），不必先教他"澳门不覆盖"。
  //   两个判据都成立时，按「能立刻执行」的那条给。
  //
  //   为什么**只判目的地、不判起点**：从珠海/香港出发前往澳门是真实需求（过关后接着坐车），
  //   起点在界外不应阻断规划。`anchorToMain` 会把界外起点锚到最近的澳门站点 —— 那是既有
  //   行为，不在本项范围内改动（改了会动到「从珠海来」这条主路径）。
  //
  //   `chain` 模式同样不判：用户显式挑的站都在库内，与 P1 早退的 `!chainMode` 取舍一致。
  if (!chainMode && !inMacauServiceArea(dest.lng, dest.lat)) {
    return earlyExit("out_of_scope");
  }

  // ③ 高德（默认 strategy=0）
  const tTransit = Date.now();
  let transitOk = false;
  let fromCache = false;
  /** ★ 2026-11-06（问题 #6 · C1）：本次是否是「真实调用失败 → 读缓存兜底」 */
  let cacheFallback = false;
  let rawPlans: AmapTransitRawResponse = { status: "1", route: { transits: [] } };
  let bridgedSeeds: AmapPlanSeed[] = [];
  let dropped: { index: number; reason: string }[] = [];
  let amapTotal = 0;
  /** ★ 本次实际用到的策略（诊断；s=0 恒在，命中补查时追加 7/8） */
  const strategiesUsed: number[] = [];

  if (!chainMode) {
    if (input.transitFixture) {
      rawPlans = input.transitFixture;
      amapTotal = (input.transitFixture.route?.transits ?? []).length;
      // ★ §B.6 触发条件③：高德返回 **0 方案** = 异常 ⇒ 视为**不可用**（走降级）
      transitOk = amapTotal > 0;
      if (transitOk) strategiesUsed.push(0);
    } else {
      /**
       * ══════════════════════════════════════════════════════════════════
       * ★ 2026-11-06（问题 #6 · C1 · 负责人要求「从根源上杜绝实时巴士导航数据走缓存」）
       *
       * **口径变更：`transit_cache` 从「默认先读缓存」→「只在真实调用失败时兜底读」。**
       *
       * 改动前（v3.8.x）：
       *   首屏打开**不带** `nocache=1` ⇒ 先读 `transit_cache`；
       *   只有用户手动点刷新才带 `nocache=1`。实测命中时 `stats.transitFromCache=true`、
       *   `transitMs` 掉到 ~0ms。**这就是「首屏与刷新结果不一致」的唯一行为差异**
       *   —— 手动刷新比首屏只多做了「跳缓存」这一件事。
       *
       * 取证结论（`.verify/_be-cache-probe.ts` 读线上表实测，见 `04-缓存排查.md` C1）：
       *   `plans_json` 的结构只有「拓扑 + 高德自己的规划时长」——
       *     `cost.duration` / `distance` / `segments[].walking.distance` /
       *     `buslines[].{name,departure_stop,arrival_stop,via_stops,cost.duration,
       *                 station_start_time,station_end_time}`
       *   而 `start_time` / `end_time` / `bus_time_tips` **实测全为空串**，
       *   **没有任何 `eta` / 到站时刻 / 车牌 / 在途车辆数** ⇒ 缓存里不存在实时巴士数据。
       *
       * 但「不含实时数字」不等于「可以缓存」：
       *   ① `buslines[].cost.duration` 会在**桥接失败**时被 `patchAmapFallback` 当成
       *      `ride.minutes` 用（`recompute.ts:216`）；60s 内复用等于让乘客看到 60s 前的规划时长；
       *   ② 缓存命中的是**整份方案集合**，方案集变化（高德随时重算）会直接改变出卡与排序，
       *      用户看到的「第一条推荐路线」可能就是上一次的旧方案；
       *   ③ 行为上无法向用户解释「为什么首屏和刷新不一样」。
       *
       * 成本实测与估算（配额账见 `04-缓存排查.md` §5）：
       *   去缓存后每次打开 = 1 次真实调用（候选偏少时 +最多 2 次补查）。
       *   `transit_cache` 现有 888 个不同 od_key / 约 7 周 —— 说明真实调用量极小，
       *   相对高德「路径规划」类 ~15 万/月 的额度不构成风险；3 QPS 由令牌桶守住
       *   （取不到令牌 ⇒ 降级或下面这条兜底，不会打穿）。
       *
       * ⚠️ 兜底只在**真实调用两次都失败**时生效，且**必须**同时置 `transitCacheFallback`
       *   —— 否则「高德此刻不可用」会被误读成「一切正常」。
       *   `?nocache=1`（用户手动刷新）连兜底也不要：那是「我宁可失败也别给我旧数据」的语义。
       * ══════════════════════════════════════════════════════════════════
       */
      const cacheIo = makeTransitCacheIo(pool);
      const callReal = () =>
        fetchTransitPlans(
          { lng: origin.lng, lat: origin.lat },
          { lng: dest.lng, lat: dest.lat },
          {
            cache: cacheIo,
            // ★ 恒 true：主调用**永不读** `transit_cache`（见上方长注释）
            noCache: true,
            nowMs,
            strategy: 0,
          },
        );
      let r = await callReal();
      // ★ 2026-09-21 新增：高德失败 / 返回 0 方案时，**自动重试一次**。
      //   实测（黑沙海滩 → 十月初五马路，22:2x）：**同一查询在几十秒内时好时坏** ——
      //   连测三次分别得到「infocode=10000 正常 / 直接 0 方案 / 又一次正常」，
      //   用户表现为「刷一下才有结果」。重试一次即可消掉大部分这类抖动。
      //   成本：偶发多一次 transit 调用（高德 transit 配额充足，非搜索类 5,000/月 那种紧约束）。
      //   ⚠️ 只重试**一次**：第二次仍失败就照旧降级，避免把请求时长拖爆（Serverless 有 maxDuration）。
      if (!r.ok) {
        await new Promise((res) => setTimeout(res, TRANSIT_RETRY_DELAY_MS));
        r = await callReal();
      }
      if (r.ok) {
        transitOk = true;
        fromCache = r.fromCache;
        rawPlans = { status: "1", route: { transits: r.raw } };
        amapTotal = r.raw.length;
        strategiesUsed.push(0);
      } else if (!input.noCache) {
        // ★ 真实调用两次都失败 ⇒ 读 60s 内最近一次成功结果（**仅拓扑/规划时长**，见长注释）
        const cached = await cacheIo.get(
          `${odKeyOf({ lng: origin.lng, lat: origin.lat }, { lng: dest.lng, lat: dest.lat }, nowMs)}|s0`,
          TRANSIT_CACHE_TTL_SEC,
        );
        if (cached && cached.length > 0) {
          transitOk = true;
          fromCache = true;
          cacheFallback = true;
          rawPlans = { status: "1", route: { transits: cached } };
          amapTotal = cached.length;
          strategiesUsed.push(0);
        }
      }
    }
  }
  const transitMs = Date.now() - tTransit;
  /** ★ v3.7.0（C13）：补查耗时；未触发 = 0（0 与「很快」不混淆：触发时必然 > 0） */
  let multiStrategyMs = 0;

  if (transitOk) {
    const parsed = parseAndBridge(rawPlans, origin, dest, bridgeCtx);
    bridgedSeeds = parsed.seeds;
    dropped = parsed.dropped;

    // ★ 多策略按需补查：s=0 可用候选偏少 ⇒ 并行补 s=7/s=8，按指纹合并去重（s=0 优先保留）。
    //   ⚠️ fixture 模式（测试/回放）不补查；补查整体失败静默降级为「只有 s=0 结果」。
    if (!input.transitFixture && bridgedSeeds.length < MULTI_STRATEGY_WHEN_BELOW) {
      // ★ v3.7.0（C13）：这段 2 次额外高德调用此前落在所有埋点之外（不可见）
      const tMulti = Date.now();
      // ★ 2026-11-06（问题 #6 · C1）：补查同样**恒真实调用**。
      //   补查的语义是「主调用方案太少 ⇒ 再问两个策略」；若补查读缓存，
      //   它拿到的可能是 s=0 之外**上个月的**方案集合，与主调用不是同一时刻的快照
      //   ⇒ 合并进候选池会出「新旧混排」的卡。宁可少几条候选，也不要混时刻。
      const extra = await fetchMultiStrategySeeds(pool, origin, dest, bridgeCtx, nowMs, true);
      multiStrategyMs = Date.now() - tMulti;
      bridgedSeeds = mergeSeedsByFingerprint(bridgedSeeds, extra.seeds);
      dropped = [...dropped, ...extra.dropped];
      strategiesUsed.push(...extra.strategiesUsed);
    }
  }

  // ⑤ 候选
  //   · chain 模式：**按用户站链约束**现场生成（段 = 用户指定 board/alight/routes，07 §2.2）；
  //   · 否则：**请求期现场枚举**（补漏来源 + 降级引擎共用同一实现）。
  //     （已删除原「只读离线表 `shadow_diff_report`」路径，口径变更 2026-09-19，见文件头。）
  let localSource: NavStats["localSource"] = "none";
  let localCandidates: StationPath[] = [];
  let localSeeds: OptionSeed[] = [];
  if (chainMode && chain) {
    const chainCands = chainToCandidates(chain, st.routeIdx, origin, dest);
    localSeeds = candidatesToSeeds(chainCands, { planIdBase: 900_000, fromSlug, toSlug });
    localSource = chainCands.length ? "inline" : "none";
  } else if (geo.length) {
    localCandidates = searchStationPaths(st.routeIdx, geo, fromWgs, toWgs, {
      maxCandidates: 240,
      anchorFromMain,
      anchorToMain,
    });
    localSource = "inline";
    localSeeds = candidatesToSeeds(pathsToCandidates(localCandidates, origin, dest), {
      planIdBase: 900_000,
      fromSlug,
      toSlug,
    });
  }

  // ── 组装 OptionSeed（两来源一次性喂 fetchLive）──
  const amapSeeds: { seed: AmapPlanSeed; opt: ReturnType<typeof amapPlanToSeed> }[] = [];
  for (let i = 0; i < bridgedSeeds.length; i++) {
    const s = bridgedSeeds[i];
    const summary = s.legs.map((l) => l.mappedRoute ?? l.amapLineName.split("(")[0]).join(" → ");
    const opt = amapPlanToSeed(s, { planId: i + 1, summary, fromSlug, toSlug, crossBorder: false });
    if (opt) amapSeeds.push({ seed: s, opt });
  }

  const allSeeds = [...amapSeeds.map((a) => a.opt!).filter(Boolean), ...localSeeds];

  // ⑥ 实时（两来源共用一次）
  const tLive = Date.now();
  const nowBucket = await nowBucketOfHolidayAware(pool, nowMs);
  // ★ B4（需求 7）：发车间隔索引 —— 既供 `fetchLive` 做「未发车估算」（旧行为），
  //   **也注入 `ModelContext.headway`** 供 `model.ts` 第 2 段巴士等车按到达时刻查班距（§h.2）。
  //   失败/表不存在 ⇒ `loadHeadway` 内部兜底（空索引）⇒ 第 2 段等车明示降级（waitMin=null）。
  const headway = await loadHeadway(pool);
  const batch = await fetchLive(pool, allSeeds, st.routeIdx, st.segIdx, {
    nowBucket,
    nowMs,
    lrtPre: st.lrtPre,
    // ★ 2026-09-21：发车间隔索引 ⇒ 让「本方向无在途车」的线路也能出卡（估算等待时间，见 live.ts）。
    //   失败/表不存在 ⇒ loadHeadway 内部已兜底（返回空索引）⇒ 退化为旧行为，不影响出卡。
    headway,
  });
  const liveMs = Date.now() - tLive;
  // ★ v2.4.1：`destLabel` = 目的地展示名 —— 供 `model.ts` 把末段步行文案写成
  //   「步行 N 分 → 目的地」。**必须由这里显式传入**：本链路的 `toSlug` 对非预设地点
  //   会兜底成 `"place"`，模型层靠 slug 反查只能得到 slug 原文。
  const baseCtx = { ...contextFor(st, nowMs, zone, batch.live, nowBucket), tierOverride, destLabel: dest.label, headway };

  // ⑦ 建模
  const tModel = Date.now();
  const provenance: Record<string, RecomputeProvenance> = {};
  /** ★ P2-a：保留 `modelOption` 的 `alts`（本班之外的后续班次），排序后按旧口径回填 `altBuses` */
  const modeled: ModeledOption[] = [];
  const amapItems: RankedItem[] = [];
  /** ★ v2.3.0（A3）：并行线 sibling 的后续班次（按主干线 planId 归并）——不单独出卡 */
  const siblingAlts: { parentPlanId: number; route: string; alts: AltBusView[] }[] = [];
  for (const { seed, opt } of amapSeeds) {
    if (!opt) continue;
    const ctx = {
      ...baseCtx,
      walkResolver: makeWalkResolver(seed, st.routeIdx.nameOf),
      transferIdx: overlayTransferIndex(seed, st.transferIdx),
    };
    const modeled1 = modelOption(opt, ctx);
    if (!modeled1) continue;
    const prov = patchAmapFallback(modeled1.card, seed, st.segIdx, nowBucket);
    provenance[opt.key] = prov;
    modeled.push(modeled1);
    amapItems.push({ card: modeled1.card, origin: "amap", key: opt.key, seed, provenance: prov });

    // ★ v2.3.0（A3）：段内并行线各建模一次（**仅取 alts**，不进 items/排序/展示）
    if (opt.segments[0]?.parallelRoutes?.length) {
      for (const sib of siblingSeedsOf(opt, st.routeIdx)) {
        const mSib = modelOption(sib.seed, ctx);
        if (mSib) siblingAlts.push({ parentPlanId: opt.planId, route: sib.route, alts: mSib.alts });
      }
    }
  }

  // 本地（**P1-4**：首末步行走 `walk_cache`（未命中 → 直线×1.5），不再落 `walkIdx` 的全局均值）
  const geoOf = new Map<string, { lng: number; lat: number }>();
  for (const s of geo) geoOf.set(s.main, { lng: s.lng, lat: s.lat });
  const walkCache = await loadWalkCacheCached(pool);
  const localItems: RankedItem[] = [];
  for (const lseed of localSeeds) {
    const ctx = {
      ...baseCtx,
      walkResolver: withWalkOverride(
        makeCacheWalkResolver(lseed, fromWgs, toWgs, geoOf, walkCache, st.routeIdx.nameOf),
        chainMode ? input.walk : undefined,
      ),
    };
    const modeled1 = modelOption(lseed, ctx);
    if (!modeled1) continue;
    const card = modeled1.card;
    const hopLevels = card.rides.map((r) => r.levels as SegmentLevel[]);
    const prov: RecomputeProvenance = {
      usedOurDataLegs: card.rides.length,
      usedAmapFallbackLegs: 0,
      hopLevels,
      deviationRatio: 0,
      suspect: false,
    };
    modeled.push(modeled1);
    localItems.push({
      card,
      origin: "local",
      key: lseed.key,
      provenance: prov,
      coverage: ourDataCoverage(card),
    });

    // ★ v3.3.0（AC-95/120）：**本地种子也造 sibling** —— 组合内每条线都要有各自的后续班车
    //   候选（`enumerate.ts` 已为本地的 `RideSegment` 补 `parallelRoutes`，此处据此建模）。
    if (lseed.segments[0]?.parallelRoutes?.length) {
      for (const sib of siblingSeedsOf(lseed, st.routeIdx)) {
        const mSib = modelOption(sib.seed, ctx);
        if (mSib) siblingAlts.push({ parentPlanId: lseed.planId, route: sib.route, alts: mSib.alts });
      }
    }
  }

  // ⑧ 合并 + 排序：站链由用户显式指定 ⇒ **不过本地补漏质量闸门**（覆盖度/补漏语义不适用），
  //     直接把链候选送入统一排优；缺省模式仍走 `mergeSources` 闸门（口径不变）。
  const rankedLocal = rankItems(localItems, prefs);
  const merged = chainMode
    ? { items: rankedLocal, dropped: [] as { key: string; reason: string }[], localCap: Number.POSITIVE_INFINITY }
    : mergeSources(amapItems, rankedLocal, {});
  const ranked = rankItems(merged.items, prefs);
  /**
   * ★ 2026-11-04（U9）：**同线同上下车站（按主码）收敛** —— 位置与 `/recommend` 一致：
   *   必须在 `slice(limit)` **之前**（否则被收敛的卡已经占掉名额）。
   *   判定键带 `route` ⇒ 跨线永不合并（`25` 与 `26A` 出 2 张；`25` 与 `25X` 视为两条线）。
   *   ⚠️ 收敛后 `RankedItem` 的来源标记（`origin`）取**代表卡自己**的那一条。
   */
  const convergeKeep = new Set(convergeByAlight(ranked.map((i) => i.card), prefs.mode));
  const converged = ranked.filter((i) => convergeKeep.has(i.card));
  // ★ v3.3.0（AC-105）：**轻轨优先** —— 注入点 = `rankItems` 之后、`slice(limit)` **之前**；
  //   只重排不增删（未开启/未命中则原样，静默）。
  const ordered = applyLrtPriority(converged, limit, input.lrtFirst ?? false);
  const cards = ordered.slice(0, limit).map((r) => r.card);

  // ★ P2-a：回填「本班之外的后续班次」（**逐字复用旧 `service.ts` v1.1.5 口径**）
  //   ★ v2.3.0（A3）：并行线 sibling 的 alts 一并合并（按 route 分组）
  backfillAltBuses(cards, modeled, siblingAlts);
  const modelMs = Date.now() - tModel;

  // ── 空状态原因（§11.4）──
  let emptyReason: NavEmptyReason | undefined;
  let nearbyWalkMin: number | undefined;
  if (cards.length === 0) {
    // ★ 2026-11-12（P1）：`straightM` 已在函数前部算过一次（早退闸门共用），此处直接复用，
    //   不重复 haversine、也不引入 shadow（同函数内同名 const 易被 lint 拦）。
    if (chainMode) {
      // 自定义站链：不算「太近」；无候选 = 该链当前无实时/无解
      emptyReason = batch.live.size === 0 ? "no_live" : "no_candidate";
    } else if (straightM < NAV_TOO_CLOSE_M) {
      emptyReason = "too_close";
      // ★ 纯步行建议：直线 → 短距修正（无高德几何时）→ ÷84（常速基准分钟）
      const corrected = fixWalkDistance(straightM, null).correctedM;
      nearbyWalkMin = Math.max(1, Math.round(walkMinutes(corrected)));
    } else if (!transitOk) emptyReason = "amap_unavailable";
    // ★ 2026-09-21 修正：`batch.live.size > 0` 只说明「**至少有一条**线路有实时数据」，
    //   并不代表候选能用。实测（黑沙海滩 → 十月初五马路，22:00）：live 里确实有 21A/15T，
    //   但通往该方向的班次**全部收班**（`excluded` 里堆了 26A / 15T…）⇒ 候选被剔光，
    //   旧逻辑却报 `no_candidate`（「找不到可用路线 · 试试更近的车站」）—— **归因错了** ✗
    //   只要**有线路因「无在途车 / 已收班」被剔除**，就该报 `no_live`
    //   （其文案本就写着「这个时段通往该方向的线路大多已收班，或暂时没有在途车辆」）✓
    else if (batch.live.size === 0 || baseCtx.excluded.length > 0) emptyReason = "no_live";
    else emptyReason = "no_candidate";
  }

  return {
    fromSlug,
    toSlug,
    cards,
    colors: st.routeColors,
    // ★ chain 模式未调高德（是既定路径，非失败）⇒ 不标「本地推算」降级
    degraded: !transitOk && !chainMode,
    emptyReason,
    nearbyWalkMin,
    provenance,
    excluded: [...new Set(baseCtx.excluded)],
    missed: [...new Set(baseCtx.missed)],
    skipped_by_schedule: baseCtx.skippedBySchedule ?? [],
    holiday_fallback: holidayFallbackOf(headway),
    stats: {
      staticMs,
      transitMs,
      multiStrategyMs,
      transitOk,
      transitFromCache: fromCache,
      transitCacheFallback: cacheFallback,
      amapPlans: amapTotal,
      bridged: bridgedSeeds.length,
      // ★ v3.3.0（AC-119）：高德解析丢弃 + 本地闸门丢弃（mergeSources）**合并**上报
      dropped: [...dropped, ...merged.dropped],
      localCandidates: localCandidates.length,
      localKept: merged.items.filter((i) => i.origin === "local").length,
      localSource,
      strategiesUsed,
      chainMode,
      liveMs,
      modelMs,
      ms: Date.now() - tAll,
    },
    generatedAt: nowMs,
    origin_gate: originGate,
  };
}

/** 供 UI 做「另一種走法」中性文案（产品口径，§B.5） */
export const NEUTRAL_LOCAL_LABEL = LOCAL_SUMMARY;

/**
 * ★ P2-a：把「本班之外的后续班次」按**旧口径**回填到卡片（逐字复用 `service.ts` v1.1.5）。
 *
 * 规则：阈值 = **最后一张卡**的总时长；只列 `totalMin ≤ 阈值` 的后续班次
 *   （用户口径：坐这一班的车，门到门总时长**不差于第 N 张卡**才值得列）。
 * ⚠️ `modelOption` 内部已按 `loSec` 去重并排除本班（v1.1.6）—— 此处**不重复**该逻辑。
 *
 * ★ v2.3.0（A3）：`siblings` = 该卡首段**并行线**的后续班次（由 `siblingSeedsOf` 独立建模、
 *   不单独出卡）。合并顺序 = 主干线 → 各并行线（`parallelRoutes` 原序），每条已带 `route`
 *   ⇒ 前端按 `route` 分组列出。阈值筛选对每一组同样生效（口径不变）。
 */
export function backfillAltBuses(
  cards: RecommendCard[],
  modeled: ModeledOption[],
  siblings: { parentPlanId: number; route: string; alts: AltBusView[] }[] = [],
): void {
  if (!cards.length) return;
  const threshold = cards[cards.length - 1].totalMin;
  const topSet = new Set(cards);
  for (const m of modeled) {
    if (!topSet.has(m.card)) continue;
    // ★ v3.3.0（AC-120）：**幂等** —— 先清空再重建（重复调用结果一致；防陈旧 altBuses 残留）
    m.card.altBuses = undefined;
    const byThreshold = (a: AltBusView) => a.totalMin <= threshold + 1e-9;
    // 本线（主干线）后续
    const groups: AltBusView[] = m.alts.filter(byThreshold);
    // 并行线后续（按首段 parallelRoutes 原序；各线已按 totalMin 升序）
    for (const pr of m.card.rides[0]?.parallelRoutes ?? []) {
      const sib = siblings.find((s) => s.parentPlanId === m.card.planId && s.route === pr);
      if (sib) groups.push(...sib.alts.filter(byThreshold));
    }
    /**
     * ★ 2026-11-04（U9/U8）：**只允许卡面标签里出现过的线路**贡献后续班次行。
     *
     * `m.card.rides[0].parallelRoutes` 已被模型层的「运营时间 ∧ 实时车」谓词过滤过
     * （`model.ts#keepParallel`）；这里再按同一集合裁一次，把「标签里没这条线、后续班次行里
     * 却有它的车」这条不一致路径**从结构上堵死**（而不是靠调用顺序保证）。
     */
    const allowed = new Set<string>(
      [m.card.rides[0]?.route, ...(m.card.rides[0]?.parallelRoutes ?? [])].filter(
        (x): x is string => !!x,
      ),
    );
    // 去重（键 = `route + totalMin`）——sibling 与主干线可能给出同线同班次
    const seen = new Set<string>();
    const dedup = groups.filter((g) => {
      if (!allowed.has(g.route)) return false;
      const k = `${g.route}|${g.totalMin}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    /**
     * ★ 2026-11-04（U9）：单卡**最多 `ALT_BUSES_MAX` 行**。
     * ⚠️ 上限必须落在本函数内（`m.card.altBuses = …` **之前**）：若只截主干线、
     *   回填时又把并行线加回来，上限形同不存在（口径见 `limits.ts`）。
     */
    const capped = dedup.slice(0, ALT_BUSES_MAX);
    if (capped.length) m.card.altBuses = capped;
  }
}
