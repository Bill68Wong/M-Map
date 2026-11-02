/**
 * 推荐静态数据装载（src/lib/recommend/query.ts，v1.0.0 / v1.0.4）
 *
 * ⚠️ server-only（含 pg）：client 组件**禁止** import 本模块 → 视图类型走 ./types。
 *
 * ────────────────────────── ★ v1.0.4 缓存架构 ──────────────────────────
 * 静态数据全部来自**派生表**（站序由 db:sync-routes 同步；段/步行/换乘由每日 Cron 重算）
 * → 低频变更 → 放进 **Vercel Data Cache**（`unstable_cache`）：**跨实例、跨冷启动持久**。
 *
 * 缓存的是**原始行**（纯 JSON）；索引（Map）仍在内存里构建
 *   —— Map 不能 JSON 序列化，整体缓存会静默丢成 `{}`。
 *
 * 为什么必须跨实例（这是本轮性能问题的正解）：
 *   线上函数执行在 iad1（美东）、主库在 ap-southeast-1（新加坡）→ **每次冷启动**重建
 *   数据库连接要 5~6 个往返（TCP + TLS + SCRAM 认证 + startup）≈ 2.3s。
 *   实测反证链：v1.0.2 把连接池上限 5→12（无效）、v1.0.3 把 route_stations 传输量
 *   压掉 9 成（仍无效，staticMs 2283ms 几乎不动）→ **传输量与连接数都不是瓶颈，
 *   固定建连成本才是**。走 Data Cache 后，冷启动直接读边缘缓存 → 完全不碰数据库。
 */
import type { Pool } from "pg";
import { unstable_cache } from "next/cache";
import { getPool } from "@/lib/db";
import {
  buildRouteIndexFromRows,
  queryRouteIndexRows,
  type RouteStopRow,
  type StationRow,
} from "@/lib/dsat/route-index";
import { buildLrtPreload, type LrtPreload } from "@/lib/lrt/next-departures";
import type { PlanLegLite } from "@/lib/timer-flow";
import { enumerateOptions, type PlanLite } from "./enumerate";
import { buildSegmentIndex, type SegmentIndex } from "./segment-lookup";
import {
  buildTransferIndex,
  buildWalkIndex,
  type ModelContext,
  type TransferIndex,
  type WalkIndex,
} from "./model";
import type {
  OptionSeed,
  RouteIndex,
  SchoolZone,
  SegmentStatRow,
  TransferWalkRow,
  WalkTimeRow,
  StationWalkDistanceRow,
} from "./types";

export interface RecStatic {
  routeIdx: RouteIndex;
  segIdx: SegmentIndex;
  walkIdx: WalkIndex;
  transferIdx: TransferIndex;
  /**
   * ★ 轻轨预载（v1.0.0 性能修复）：把轻轨的 6 次串行 DB 往返折进本层已有的并行窗口。
   * 不这么做时，线上（函数在 iad1、主库在新加坡）每个轻轨桶恒定 1.2s 超时 → 轻轨方案被剔除。
   * 详见 `src/lib/lrt/next-departures.ts#LrtPreload`。
   */
  lrtPre: LrtPreload;
  placeIds: Record<string, number>;
  /** 全部在用方案的幂等数据（plan + legs） */
  planRows: { plan: PlanLite; legs: PlanLegLite[] }[];
  /** 线路码 → 主题色 */
  routeColors: Record<string, string>;
}

/** 轻轨时刻行（`lrt_timetables` 全量） */
type LrtTtRow = {
  api_station: string;
  route_no: string;
  direction: string;
  day_type: string;
  first_min: number;
  last_min: number;
  minutes: { hour: number; minutes: number[] }[];
};

/**
 * ★ v3.6.1：seg 行的**数组编码**（落 Data Cache 用）。
 *
 * 为什么：`segment_stats` 14,951 行按对象编码序列化 ≈3.07MB，超 Next 单条 2MB 上限
 * ⇒ 生产 `console.warn` 后**静默跳过写入**（不报错）⇒「跨实例缓存」自上线起从未生效。
 * 改数组编码（去掉每行重复的键名 + 减少引号）后实测 **0.967MB**，单 key 即可入缓存。
 *
 * ⚠️ encode/decode 都由 `SEG_COLS` **同一份常量驱动**（map 取列 / zip 回对象），
 *    杜绝「列顺序手写错位」——错位会被全量等价性证明立刻抓出
 *    （`.verify/_o-array-equiv.ts`，14,951 行 deep-equal，差异必须 0）。
 */
type SegRowEncoded = (string | number | null)[];

/** 列序 = 编码数组下标 = decode 键序。**改列必须三处同步**（SELECT 列表 / 此常量 / 类型）。 */
const SEG_COLS = [
  "route_code", "from_station", "to_station", "weekday", "time_bucket",
  "arrive_kind", "avg_minutes", "p50_minutes", "samples",
] as const;

const encodeSegRows = (rows: SegmentStatRow[]): SegRowEncoded[] =>
  rows.map((r) => SEG_COLS.map((c) => (r as unknown as Record<string, unknown>)[c] as string | number | null));

const decodeSegRows = (enc: SegRowEncoded[]): SegmentStatRow[] =>
  enc.map((e) => Object.fromEntries(SEG_COLS.map((c, i) => [c, e[i]])) as unknown as SegmentStatRow);

/** ★ v1.0.4：静态数据原始行（纯 JSON · 可跨实例缓存 · **不含任何 Map**） */
interface StaticRows {
  routeStops: RouteStopRow[];
  stations: StationRow[];
  /** ★ v3.6.1：**数组编码**形态（消费前必须 `decodeSegRows`，见 loadStaticsUncached） */
  seg: SegRowEncoded[];
  walk: WalkTimeRow[];
  /** ★ v1.2.0：高德步行距离（独立缓存表） */
  walkDist: StationWalkDistanceRow[];
  transfer: TransferWalkRow[];
  places: { id: number; slug: string }[];
  plans: PlanLite[];
  legs: Record<string, unknown>[];
  colors: { code: string; color: string }[];
  lrtApi: { db_code: string; api_id: string; name_tc: string | null }[];
  lrtHol: { d: string }[];
  lrtTt: LrtTtRow[];
  /** ★ v3.2.0：轻轨逐站/逐模式偏差（读秒唯一真源）；新表不存在时为空 */
  lrtBias: { route_code: string; direction: string; pattern: string; api_station: string; dep_bias_sec: number | string | null }[];
  /** ★ v3.2.0：轻轨线路级偏差（石排湾/横琴兜底） */
  lrtLineParams: { route_code: string; dep_bias_sec: number | string | null }[];
}

/** 全部静态查询**并行发出**（一个 RTT 窗口），返回可序列化的原始行 */
async function fetchStaticRowsUncached(pool: Pool): Promise<StaticRows> {
  const [
    routeIdxRows,
    segRes,
    walkRes,
    walkDistRes,
    transferRes,
    placeRes,
    planRes,
    legRes,
    colorRes,
    lrtApiRes,
    lrtHolRes,
    lrtTtRes,
    lrtBiasRes,
    lrtLineParamRes,
  ] = await Promise.all([
    queryRouteIndexRows(pool),
    pool.query(
      `SELECT route_code, from_station, to_station, weekday, time_bucket, arrive_kind,
              avg_minutes, p50_minutes, samples FROM segment_stats`,
    ),
    pool.query(`SELECT place_id, station_code, zone, minutes, samples, distance_m FROM walk_times`),
    // ★ v1.2.0：高德步行距离（与 walk_times 分层的独立缓存表）
    //   即使某组还没有实测样本，只要抓过距离，档 1 的随距离衰减就能算 ✓
    //   表尚未建时容错为空（不阻塞推荐）
    pool
      .query(`SELECT place_id, station_main, zone, distance_m FROM station_walk_distance`)
      .catch(() => ({ rows: [] as unknown[] })),
    // transfer_walks 在 v1.0.0 新建；表尚未建时容错为空（不阻塞推荐）
    pool
      .query(`SELECT from_station, to_station, minutes, samples, source FROM transfer_walks`)
      .catch(() => ({ rows: [] as unknown[] })),
    pool.query(`SELECT id, slug FROM places`),
    pool.query(
      `SELECT p.id, p.summary, pf.slug AS from_slug, pt.slug AS to_slug
         FROM commute_plans p
         JOIN places pf ON pf.id = p.from_place
         JOIN places pt ON pt.id = p.to_place
        WHERE p.is_active
        ORDER BY p.id`,
    ),
    pool.query(
      `SELECT l.plan_id, l.seq, l.leg_kind, l.route_options, l.from_station, l.to_station,
              l.board_candidates, l.alight_candidates, l.route_meta, l.border_label
         FROM plan_legs l
         JOIN commute_plans p ON p.id = l.plan_id
        WHERE p.is_active
        ORDER BY l.plan_id, l.seq`,
    ),
    pool.query(`SELECT code, color FROM routes WHERE color IS NOT NULL`),
    // ── 轻轨预载三件套（v1.0.0 性能修复；都是极小静态表）──
    pool
      .query(`SELECT db_code, api_id, name_tc FROM lrt_api_stations`)
      .catch(() => ({ rows: [] as unknown[] })),
    pool.query(`SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d FROM lrt_holidays`),
    pool.query(
      `SELECT api_station, route_no, direction, day_type, first_min, last_min, minutes
         FROM lrt_timetables`,
    ),
    // ★ v3.2.0：轻轨偏差两件套折进**同一并行窗口**（小表；**零额外串行往返**，守住 230ms 红线）。
    //   `lrt_station_biases` 为 v3.2.0 新表 —— 尚未建时容错为空（回落分钟级，不阻塞推荐）。
    pool
      .query(
        `SELECT route_code, direction, pattern, api_station, dep_bias_sec
           FROM lrt_station_biases`,
      )
      .catch(() => ({ rows: [] as unknown[] })),
    pool
      .query(`SELECT route_code, dep_bias_sec FROM lrt_route_params`)
      .catch(() => ({ rows: [] as unknown[] })),
  ]);

  const [routeStops, stations] = routeIdxRows;
  return {
    routeStops,
    stations,
    seg: encodeSegRows(segRes.rows as unknown as SegmentStatRow[]),
    walk: walkRes.rows as unknown as WalkTimeRow[],
    walkDist: walkDistRes.rows as unknown as StationWalkDistanceRow[],
    transfer: transferRes.rows as unknown as TransferWalkRow[],
    places: placeRes.rows as { id: number; slug: string }[],
    plans: planRes.rows as unknown as PlanLite[],
    legs: legRes.rows as Record<string, unknown>[],
    colors: colorRes.rows as { code: string; color: string }[],
    lrtApi: lrtApiRes.rows as { db_code: string; api_id: string; name_tc: string | null }[],
    lrtHol: lrtHolRes.rows as { d: string }[],
    lrtTt: lrtTtRes.rows as unknown as LrtTtRow[],
    lrtBias: lrtBiasRes.rows as StaticRows["lrtBias"],
    lrtLineParams: lrtLineParamRes.rows as StaticRows["lrtLineParams"],
  };
}

/**
 * ★ v1.0.4：静态行 = **跨实例数据缓存**（60s 重新验证，与原有进程内 TTL 同口径）。
 * ⚠️ 不走 `pool` 参数：`unstable_cache` 会把入参序列化进 cache key，
 *    而 Pool 实例不可序列化 → 必须用模块级 `getPool()`。
 *    若 Data Cache 未命中，则回落到一次真实查询（行为与 v1.0.3 相同）。
 */
const getStaticRows = unstable_cache(
  async () => fetchStaticRowsUncached(getPool()),
  // ★ v3.6.1：v1 → v2 —— seg 从对象编码换数组编码。换 key 而不做 f.encoding 分支的理由：
  //   旧条目 revalidate=60s，一分钟内自然过期，分支代码是永久负担；换 key 零风险。
  ["rec-static-rows-v2"],
  { revalidate: 60, tags: ["rec-static"] },
);

/**
 * 静态数据进程内缓存（同实例复用，避免每次请求重建索引）。
 * 与 Data Cache 是两层：外层（跨实例）管「取行」，内层（本实例）管「建索引」。
 */
const STATIC_TTL_MS = 60_000;
const g = globalThis as unknown as {
  __recStaticCache?: { ts: number; data: RecStatic };
  __staticCacheObs?: StaticCacheObs;
};

/* ══════════════════════════════════════════════════════════════════════
 * ★ v3.6.1：静态数据 Data Cache **观测**（为什么必须有）
 *
 * 背景（2026-10-30 实测）：`StaticRows` 序列化后 ≈ 3.07MB，超过 Next 的
 * **单条 2MB 上限**（`incremental-cache/index.js:429-441`）：
 *   · 生产：`console.warn` 后 `return` ⇒ **不抛错、不 500，但缓存从不写入**
 *     ⇒ 「跨实例缓存」从上线起就静默失效，每次 cache miss 都直连数据库；
 *   · dev：`throw` ⇒ 悬空 rejection（`pendingRevalidates`）⇒ 冷启动首请求 500、
 *     之后被进程内 60s 缓存遮住 ⇒ 看起来「好了」，其实没有。
 *
 * 「不报错」恰恰是「一直没缓存」的证据 ⇒ 必须有**外部可探测**的状态，只打日志没人看。
 * 状态语义：
 *   `ok`               = payload ≤ 1.8MB，Data Cache 正常写入且有裕量
 *   `oversize-warning` = 1.8MB < payload ≤ 2MB ⇒ **快触顶**（v3.7.0 新增，见下）
 *   `skipped-oversize` = payload > 2MB，生产会静默跳过（已超限）
 *   `error`            = Data Cache 层抛错（dev 超限 / incrementalCache 缺失），已回落直查
 *   `not-run`          = 本次进程还没装载过静态数据
 *
 * ★ v3.7.0（缓存专项 RL9）：新增 `oversize-warning` —— 只报「已经超了」是不够的。
 *   现状实测约 1.20MB，但最大那张表占 76%：涨到约 3.8 万行就会再次触顶 2MB，然后**静默不写入**。
 *   ⇒ 1.8MB 设预警线（≈1.5 倍当前体积），并打 `console.error`（**不是 warn**：
 *     本项目已经吃过一次「只 warn ⇒ 三年没发现」的亏，warn 在这个仓库等于静音）。
 * ══════════════════════════════════════════════════════════════════════ */

/** Next 单条缓存上限（2MB）——与 `incremental-cache` 的硬编码一致 */
const DATA_CACHE_ITEM_LIMIT = 2 * 1024 * 1024;
/**
 * 体积预警线（1.8MB）。取值依据：当前实测 ≈1.20MB，最大表占 76% ⇒ 该表行数增长 50% 即触顶；
 * 1.8MB 相当于「再涨 50%」的位置，留出一次发版周期的反应时间。
 */
const DATA_CACHE_WARN_BYTES = Math.round(1.8 * 1024 * 1024);
/** 观测状态（外部经 /api/health GET 读取；不落库、不进客户端包） */
export type StaticCacheStatus = "ok" | "oversize-warning" | "skipped-oversize" | "error" | "not-run";
export interface StaticCacheObs {
  status: StaticCacheStatus;
  /** 按 Next 真实口径估算的 itemSize（body 先 stringify 再被外层 stringify，引号二次转义） */
  sizeBytes: number;
  limitBytes: number;
  /** true = getStaticRows 抛错、已回落直查（dev 超限 / incrementalCache 缺失） */
  fallbackUsed: boolean;
  /** 最近一次装载的 epoch ms */
  at: number;
}

/** 复刻 Next 的序列化链：`itemSize = JSON.stringify({kind,data:{…body:JSON.stringify(result)…}}).length` */
function predictedItemSize(rows: StaticRows): number {
  const body = JSON.stringify(rows);
  return JSON.stringify({
    kind: "FETCH",
    data: { headers: {}, body, status: 200, url: "" },
    revalidate: 60,
  }).length;
}

/**
 * Data Cache **真实读写探针**：小 payload（不受 2MB 限制）。
 * 两次调用若拿到同一个 token ⇒ 写入+读回成立 ⇒ Data Cache 本身可用；
 * 拿到新 token ⇒ 该次被重新生成（未命中或不可用）。
 * 这把「缓存是否真的在工作」与「payload 是否超限」**解耦成两个可分别观测的问题**。
 */
const cacheProbe = unstable_cache(
  async () => ({ t: Date.now(), n: Math.random() }),
  ["rec-cache-probe-v1"],
  { revalidate: 60, tags: ["rec-static-probe"] },
);

/** 供 /api/health 读取：状态 + 探针读写结论。GET 即探，无副作用、不落库。 */
export async function getStaticCacheObs(): Promise<
  StaticCacheObs & { probe: { roundTrip: "ok" | "miss" | "error"; first: number; second: number } }
> {
  const base: StaticCacheObs =
    g.__staticCacheObs ?? {
      status: "not-run",
      sizeBytes: 0,
      limitBytes: DATA_CACHE_ITEM_LIMIT,
      fallbackUsed: false,
      at: 0,
    };
  let probe: { roundTrip: "ok" | "miss" | "error"; first: number; second: number };
  try {
    // ⚠️ 两次调用若**恰好跨越 revalidate 窗口**（60s），第二次会重新生成 ⇒ miss 是预期行为，
    //    不是故障。为让读数稳定：miss 时重试一对（连续两次几乎必在同一窗口内）。
    let a = await cacheProbe();
    let b = await cacheProbe();
    if (a.t !== b.t) {
      a = await cacheProbe();
      b = await cacheProbe();
    }
    const roundTrip = a.t === b.t && a.n === b.n ? "ok" : "miss";
    probe = { roundTrip, first: a.t, second: b.t };
  } catch {
    // 非 Next 运行时（tsx 脚本）会抛 `incrementalCache missing` —— 探针不可用不算故障
    probe = { roundTrip: "error", first: 0, second: 0 };
  }
  return { ...base, probe };
}

/** 装入全部静态数据（默认走 60s 进程内缓存；取行走 Vercel Data Cache） */
export async function loadStatics(pool: Pool, force = false): Promise<RecStatic> {
  // ★ v1.0.4：取行已交给 Data Cache（跨实例），pool 参数仅为兼容既有签名保留
  void pool;
  const c = g.__recStaticCache;
  if (!force && c && Date.now() - c.ts < STATIC_TTL_MS) return c.data;
  const data = await loadStaticsUncached();
  g.__recStaticCache = { ts: Date.now(), data };
  return data;
}

async function loadStaticsUncached(): Promise<RecStatic> {
  // ★ v1.3.0：非 Next 运行时（`tsx` 脚本 / 探针）里 `unstable_cache` 不可用
  //   （会抛 `Invariant: incrementalCache missing`）→ 回落到**直接查库**。
  //   ⚠️ 只在 Next 运行时之外触发 ⇒ 线上行为**零变化**（正常路径仍走 Data Cache）。
  // ★ v3.6.1：无论走哪条路，都把「缓存会否写入」记进观测（/api/health 可 GET）。
  //   注意：dev 超限时 Next 抛的是**悬空 rejection**（`pendingRevalidates`），本 try/catch
  //   能接住的是同步抛出的那一支；生产超限不抛、只 console.warn ⇒ 靠下面的体积估算判定。
  let rows: StaticRows;
  let fallbackUsed = false;
  try {
    rows = await getStaticRows();
  } catch {
    fallbackUsed = true;
    rows = await fetchStaticRowsUncached(getPool());
  }
  // ⚠️ 体积估算在**cache-miss 路径**才执行（约每 60s 一次/实例），不在每请求路径。
  //    复刻 Next 的 2MB 判定口径（含 body 二次 stringify 的引号转义膨胀，实测系数 ≈1.19）。
  const sizeBytes = predictedItemSize(rows);
  /**
   * 状态优先级：已超限 > 回落 > 快超限 > 正常。
   * `fallbackUsed` 排在预警前面：Data Cache 都没走通时，「体积快超了」不是当下要处理的问题。
   */
  const status: StaticCacheStatus =
    sizeBytes > DATA_CACHE_ITEM_LIMIT
      ? "skipped-oversize"
      : fallbackUsed
        ? "error"
        : sizeBytes > DATA_CACHE_WARN_BYTES
          ? "oversize-warning"
          : "ok";
  if (status === "skipped-oversize" || status === "oversize-warning") {
    // ⚠️ 有意用 error 级别：warn 在本仓库等于静音（v3.6.1 之前「只 warn」导致缓存三年没写入）
    console.error(
      `[recommend/query] 静态数据体积${status === "skipped-oversize" ? "已超 2MB 上限（缓存不会写入）" : "接近 2MB 上限（预警）"}：` +
        `${(sizeBytes / 1024 / 1024).toFixed(2)}MB / 上限 2.00MB · 预警线 1.80MB · ` +
        `segmentStats=${rows.seg?.length ?? 0} 行`,
    );
  }
  g.__staticCacheObs = {
    status,
    sizeBytes,
    limitBytes: DATA_CACHE_ITEM_LIMIT,
    fallbackUsed,
    at: Date.now(),
  };

  const placeIds: Record<string, number> = {};
  for (const r of rows.places) placeIds[r.slug] = r.id;

  const routeColors: Record<string, string> = {};
  for (const r of rows.colors) routeColors[r.code] = r.color;

  const legsByPlan = new Map<number, PlanLegLite[]>();
  for (const r of rows.legs) {
    const pid = r.plan_id as number;
    if (!legsByPlan.has(pid)) legsByPlan.set(pid, []);
    const opts = r.route_options ? (JSON.parse(r.route_options as string) as string[]) : null;
    legsByPlan.get(pid)!.push({
      seq: r.seq as number,
      leg_kind: r.leg_kind as PlanLegLite["leg_kind"],
      route_options: opts,
      from_station: (r.from_station as string) ?? null,
      to_station: (r.to_station as string) ?? null,
      board_candidates: (r.board_candidates as string[]) ?? null,
      alight_candidates: (r.alight_candidates as string[]) ?? null,
      route_meta: (r.route_meta as PlanLegLite["route_meta"]) ?? null,
      border_label: (r.border_label as string) ?? null,
      // plan_legs 无 color 列 → 按默认线路（route_options[0]）取线路主题色（口径同 home-plans.ts）
      color: opts?.[0] ? (routeColors[opts[0]] ?? null) : null,
    });
  }

  const planRows = rows.plans.map((plan) => ({
    plan,
    legs: legsByPlan.get(plan.id) ?? [],
  }));

  const routeIdx = buildRouteIndexFromRows(rows.routeStops, rows.stations);

  return {
    routeIdx,
    // ★ v3.6.1：seg 在缓存里是数组编码 → 消费前解码回对象（仅 cache-miss 路径，~15k 次 map 可忽略）
    segIdx: buildSegmentIndex(decodeSegRows(rows.seg)),
    walkIdx: buildWalkIndex(rows.walk, rows.walkDist),
    transferIdx: buildTransferIndex(rows.transfer),
    // 站序直接复用刚构建的 routeIdx.dirStops（不再单独查 route_stations）
    lrtPre: buildLrtPreload({
      apiRows: rows.lrtApi,
      holidayRows: rows.lrtHol,
      ttRows: rows.lrtTt,
      dirStopsAll: routeIdx.dirStops,
      biasRows: rows.lrtBias,
      lineParamRows: rows.lrtLineParams,
    }),
    placeIds,
    planRows,
    routeColors,
  };
}

/** 枚举某方向（from→to）的全部候选路线方案 */
export function optionsFor(st: RecStatic, fromSlug: string, toSlug: string): OptionSeed[] {
  const rows = st.planRows.filter((r) => r.plan.from_slug === fromSlug && r.plan.to_slug === toSlug);
  const out: OptionSeed[] = [];
  for (const r of rows) out.push(...enumerateOptions(r.plan, r.legs, st.routeIdx));
  return out;
}

/** 组装模型上下文（live 由调用方注入；nowBucket 由调用方用 `nowBucketOfHolidayAware` 算好） */
export function contextFor(
  st: RecStatic,
  nowMs: number,
  zone: SchoolZone | null,
  live: ModelContext["live"],
  /** ★ v3.5.5：节假日感知查询桶（调用方 `await nowBucketOfHolidayAware(pool, nowMs)` 传入） */
  nowBucket: string,
): ModelContext {
  return {
    nowMs,
    segIdx: st.segIdx,
    walkIdx: st.walkIdx,
    transferIdx: st.transferIdx,
    placeIds: st.placeIds,
    nameOf: st.routeIdx.nameOf,
    zone,
    live,
    excluded: [],
    missed: [],
    nowBucket,
  };
}

/** 候选方案需要的全部线路码（去重） */
export function routesOf(options: OptionSeed[]): string[] {
  const s = new Set<string>();
  for (const o of options) for (const seg of o.segments) s.add(seg.route);
  return [...s];
}
