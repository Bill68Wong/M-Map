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
 *
 * ★ 2026-11-06（问题 #6 · C4）**「本层不缓存任何实时字段」的结构性保证** ——
 *   60s 内复用的是**派生表的原始行**，逐字段核对（`fetchStaticRowsUncached` 的 10 条 SELECT）：
 *     routeStops/stations（站序·站名·坐标）· seg（`segment_stats` 逐跳时长统计）
 *     · walk（`walk_times` 步行均值）· transfer（`transfer_walks`）· colors（`routes.color`）
 *     · lrtApi（站码映射）· lrtHol（法定假期日）· lrtTt（`lrt_timetables` **表定班次**）
 *     · lrtBias / lrtLineParams（时刻偏差校准值）
 *   ⇒ 全部是「已入库的历史统计 / 表定数据」，**没有任何一项随车辆位置或到站时刻变化**。
 *   实时部分（DSAT 报站 / 轻轨下一班）**不经过本层**：
 *     · 巴士 → `live.ts` 每次请求现查 DSAT（2026-11-06 起 `force=true` 穿透其 5s 进程缓存）；
 *     · 轻轨 → `lrtPre` 只装**时刻表行**，`queryLrtDepartures(pre, { nowMs })` 每次按 `nowMs`
 *       现算「下一班」（`buildLrtPreload` 是纯函数，不落任何 `now` 快照）。
 *   ⇒ 本层 60s 缓存**不会**让「还有 N 站 / 约 X 分」变旧。改本文件时若往 `StaticRows` 加字段，
 *     必须先回答「它会不会过期」——会过期的**不许进这里**。
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
import { buildSegmentIndex, type SegmentIndex } from "./segment-lookup";
// ★ v4.1.0：中途总站判据（单一源，见文件头）；纯函数，复用已缓存的站序/站名
import { buildMidTerminusKeys } from "@/lib/rebuild/mid-terminus";
import {
  buildTransferIndex,
  buildWalkIndex,
  type ModelContext,
  type TransferIndex,
  type WalkIndex,
} from "./model";
import { PLACE_ID_BY_SLUG } from "./place-ids";
import type {
  RouteIndex,
  SchoolZone,
  SegmentStatRow,
  TransferWalkRow,
  WalkTimeRow,
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
  /** slug → place_id（★ 2026-11-06 起来自 `./place-ids` 常量，不再查 `places` 表） */
  placeIds: Record<string, number>;
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
  "arrive_kind", "avg_minutes", "p50_minutes", "samples", "p50_run_minutes",
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
  /**
   * ★ v4.1.0：邻接对沿线里程（米）——**只服务 L6/L7 物理护栏**（隐含速度越界 ⇒ 展示留白）。
   *   由 `route_station_mileage` 的相邻站差推出；表不存在/未跑 db:station-mileage 时为空
   *   ⇒ 护栏失效（不误判），不会阻塞推荐。
   */
  hopDist: { r: string; f: string; t: string; m: number }[];
  walk: WalkTimeRow[];
  transfer: TransferWalkRow[];
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
    hopDistRes,
    walkRes,
    transferRes,
    colorRes,
    lrtApiRes,
    lrtHolRes,
    lrtTtRes,
    lrtBiasRes,
    lrtLineParamRes,
  ] = await Promise.all([
    queryRouteIndexRows(pool),
    // ★ v4.1.0：`p50_run_minutes` 由 db/migrate-v4100-hop-basis.ts 增加；
    //   迁移未跑时降级为 NULL（不阻塞推荐，行为 = 旧版）。
    pool
      .query(
        `SELECT route_code, from_station, to_station, weekday, time_bucket, arrive_kind,
                avg_minutes, p50_minutes, samples, p50_run_minutes FROM segment_stats`,
      )
      .catch(() =>
        pool.query(
          `SELECT route_code, from_station, to_station, weekday, time_bucket, arrive_kind,
                  avg_minutes, p50_minutes, samples, NULL::numeric AS p50_run_minutes FROM segment_stats`,
        ),
      ),
    // ★ v4.1.0：相邻站对的沿线里程（L6/L7 物理护栏）。表不存在时为空 → 护栏失效但不报错。
    pool
      .query(
        `WITH adj AS (
           SELECT route_code, dsat_dir, main_code AS f,
                  lead(main_code) OVER w AS t,
                  lead(mile_m)   OVER w - mile_m AS d
             FROM route_station_mileage
           WINDOW w AS (PARTITION BY route_code, dsat_dir ORDER BY mile_m)
         )
         SELECT route_code AS r, f, t, max(d)::float8 AS m
           FROM adj WHERE t IS NOT NULL AND d > 0
          GROUP BY 1, 2, 3`,
      )
      .catch(() => ({ rows: [] as unknown[] })),
    pool.query(`SELECT place_id, station_code, zone, minutes, samples, distance_m FROM walk_times`),
    // transfer_walks 在 v1.0.0 新建；表尚未建时容错为空（不阻塞推荐）
    pool
      .query(`SELECT from_station, to_station, minutes, samples, source FROM transfer_walks`)
      .catch(() => ({ rows: [] as unknown[] })),
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
    hopDist: hopDistRes.rows as StaticRows["hopDist"],
    walk: walkRes.rows as unknown as WalkTimeRow[],
    transfer: transferRes.rows as unknown as TransferWalkRow[],
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
  // ★ v4.1.0：v2 → v3 —— seg 编码多一列（p50_run_minutes）+ 新增 hopDist。
  //   不换 key 会让旧条目（9 列）解出 `p50_run_minutes: undefined`，护栏/纯行驶统计静默失效。
  ["rec-static-rows-v3"],
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

  // ★ 2026-11-06：`places` 表已删，slug ↔ id 关系固定在 `./place-ids` 常量里。
  //   方向是 slug → id（`nav-service.ts#slugOf` 用 `Object.keys(st.placeIds)` 判断
  //   「起终点是不是预设四地点」，键必须是 slug）。
  const placeIds: Record<string, number> = { ...PLACE_ID_BY_SLUG };

  const routeColors: Record<string, string> = {};
  for (const r of rows.colors) routeColors[r.code] = r.color;

  const routeIdx = buildRouteIndexFromRows(rows.routeStops, rows.stations);

  // ★ v4.1.0：中途总站集合（站名含總站/总站且不在首末位）——纯函数，零额外 DB 往返
  //   判据本体在 `src/lib/rebuild/mid-terminus.ts`（不要在此另写一套）。
  const midTerminus = buildMidTerminusKeys(
    rows.routeStops,
    new Map(rows.stations.map((s) => [s.code, s.name_tc])),
  );
  const hopMeters = new Map(rows.hopDist.map((d) => [`${d.r}|${d.f}|${d.t}`, Number(d.m)]));

  return {
    routeIdx,
    // ★ v3.6.1：seg 在缓存里是数组编码 → 消费前解码回对象（仅 cache-miss 路径，~15k 次 map 可忽略）
    segIdx: buildSegmentIndex(decodeSegRows(rows.seg), { midTerminus, hopMeters }),
    // ★ 2026-11-06：`station_walk_distance` 已删。`walk_times.distance_m` 实测 20 行全为 NULL
    //   ⇒ 距离索引为空，档 1（「全力冲刺能赶上」）退回线性速度比（`tier1EffRatio` 的既有无值分支）。
    //   这是 Spec §6.2 已接受的降级，**不是静默失败**：不传第二参数，索引内 distByKey 恒空。
    walkIdx: buildWalkIndex(rows.walk),
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
    routeColors,
  };
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
    // ★ 2026-11-04（U8）：「因运营时间且无车」被隐藏的线路（与 excluded/missed 并列，独立可观测）
    skippedBySchedule: [],
    nowBucket,
  };
}
