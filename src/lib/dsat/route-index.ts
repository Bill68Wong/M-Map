/**
 * 站序索引（src/lib/dsat/route-index.ts，v1.0.0 / v1.0.2 / v1.0.4）
 *
 * **一次 SQL 取全量站序 / 站名 / 方向 / 邻接归属**，供两处共用：
 *   · `src/lib/dsat/eta.ts#queryEta` —— 消灭 per-route DB 往返
 *     （现状 12 条线 ≈ 36~48 次往返 → 1 次）
 *   · `src/lib/recommend/*` —— 枚举逐跳、方向推导
 *
 * ⚠️ 站序数据是**低频变更**的静态数据（由 db:sync-routes 同步）→ 进程内缓存 5 分钟即可，
 *    不必每次请求都查库（Vercel 同一实例复用）。
 *
 * ★ v1.0.4：拆出**纯构建函数** `buildRouteIndexFromRows`（零 DB 访问），
 *   让推荐链路可以把「取行」放进 Vercel Data Cache（跨实例、跨冷启动持久）
 *   —— 只缓存原始行，索引仍在内存里构建（Map 不可 JSON 序列化，不能整体缓存）。
 */
import type { Pool } from "pg";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { RouteIndex } from "@/lib/recommend/types";

const CACHE_TTL_MS = 5 * 60_000;

const g = globalThis as unknown as {
  __routeIndexCache?: { ts: number; idx: RouteIndex };
};

/** 站序行（`route_stations` 聚合后，每「线路 × 方向」一行） */
export interface RouteStopRow {
  route: string;
  dsat_dir: string;
  stops: string[] | null;
}
/** 站点行（`stations` 全量） */
export interface StationRow {
  code: string;
  name_tc: string | null;
  kind: string | null;
}

/**
 * ★ v1.0.4：站序索引的**纯构建函数**（零 DB 访问）。
 *
 * 为什么拆出来：线上冷启动 `loadStatics` 实测 2283ms，而 v1.0.2（连接池上限 5→12）
 * 与 v1.0.3（`route_stations` 传输量 −90%）都**没能改善**——传输量与解析量各降 9 成
 * 而耗时不动，反证瓶颈是**每次冷启动都要重新建库连接**这一固定成本
 * （函数在 iad1、主库在新加坡，TCP+TLS+SCRAM+startup 要 5~6 个往返）。
 * 对策 = 让「取行」住进 Vercel Data Cache（见 `src/lib/recommend/query.ts`），
 * 冷启动直接读缓存 → 完全不碰数据库；索引则每次在内存里重建（成本可忽略）。
 */
export function buildRouteIndexFromRows(stopsRows: RouteStopRow[], stationRows: StationRow[]): RouteIndex {
  const dirStops = new Map<string, string[]>();
  const seqIdx = new Map<string, Map<string, number[]>>();
  const dirsOf = new Map<string, string[]>();
  const nameOf = new Map<string, string>();
  const adjOwners = new Map<string, Set<string>>();

  for (const r of stopsRows) {
    const key = `${r.route}|${r.dsat_dir}`;
    const stops = r.stops ?? [];
    dirStops.set(key, stops);

    // seqIdx：站码 → 该方向内的出现位置（相对先后顺序，等价于原 rs.seq 的 1 基版本）
    const m = new Map<string, number[]>();
    for (let i = 0; i < stops.length; i++) {
      const code = stops[i];
      if (!m.has(code)) m.set(code, []);
      m.get(code)!.push(i);
    }
    seqIdx.set(key, m);

    const arr = dirsOf.get(r.route) ?? [];
    arr.push(r.dsat_dir);
    dirsOf.set(r.route, arr);

    // 邻接归属：数组相邻 = 原「同一 (route,dir) 内上一站 → 本站」
    for (let i = 1; i < stops.length; i++) {
      const adj = `${mainCodeOf(stops[i - 1])}→${mainCodeOf(stops[i])}`;
      if (!adjOwners.has(adj)) adjOwners.set(adj, new Set());
      adjOwners.get(adj)!.add(r.route);
    }
  }

  // 巴士带站号前缀（「C653 金峰南岸」），轻轨不带（「氹仔碼頭」）——与 LiveEta / LrtEta 口径一致
  for (const s of stationRows) {
    if (!s.name_tc) continue;
    nameOf.set(s.code, s.kind === "bus" ? `${s.code} ${s.name_tc}` : s.name_tc);
  }

  // ★ 【3】主码兜底（v2.0.1）：`stations` 里同一个巴士站可能只有「带站台的码」（如 `T363/1`），
  //   而线路站序 / 高德桥接产物用的是**主码**（`T363`）⇒ `nameOf.get("T363")` 取不到名字，
  //   界面就只剩纯站码（「步行 →  T363」，用户看不出这是哪一站）。
  //   这里补一层「主码 → 带名标签」的兜底：**只在主码缺失时填**（不覆盖已有键，故对既有
  //   显示零影响，纯增益）。轻轨主码 = 原码（`mainCodeOf('LRT-MUST')` 不变）。
  for (const s of stationRows) {
    if (!s.name_tc) continue;
    const main = mainCodeOf(s.code);
    if (!nameOf.has(main)) nameOf.set(main, s.kind === "bus" ? `${main} ${s.name_tc}` : s.name_tc);
  }

  return { dirStops, seqIdx, dirsOf, nameOf, adjOwners };
}

/** 站序索引的原始行查询（**服务端聚合 + 站名单独取**，见下）+ 构建 */
export async function buildRouteIndex(pool: Pool): Promise<RouteIndex> {
  const [stopsRows, stationRows] = await queryRouteIndexRows(pool);
  return buildRouteIndexFromRows(stopsRows, stationRows);
}

/**
 * 取站序索引所需的两个结果集。
 *
 * ★ v1.0.2：**服务端聚合 + 站名单独取**，把跨洲传输量压掉 ~90%。
 *   原实现是「逐站一行」（2870 行 / 270 KB，实测），改成 `array_agg`（119 行 / 26 KB）
 *   + `stations` 单独取（613 行 / 30 KB）。
 *   等价性已对拍（`.verify/route-index-eq.ts`，5 项 0 不一致）：
 *     · dirStops / dirsOf / adjOwners —— 逐字段一致
 *     · seqIdx —— 仅**基址**不同（DB rs.seq 1 基 → 数组下标 0 基），相对顺序一致；
 *       该字段全仓无消费方（grep 确认），故无影响
 *     · nameOf —— 新实现是**超集**：多出 3 个「未被任何线路站序引用」的孤立站
 *       （C688 / C690 / M8/1），只增不减，且能让主码站显示出站名（改善）
 *   ⚠️ 实测证明这一步**并没有**让线上 staticMs 变快（2283ms）——因为瓶颈不在传输量，
 *      而在每次冷启动重建连接的固定成本。真正的对策见 `buildRouteIndexFromRows` 注释。
 */
export async function queryRouteIndexRows(pool: Pool): Promise<[RouteStopRow[], StationRow[]]> {
  const [stopsRes, stRes] = await Promise.all([
    // ★ v3.6.0：`WHERE r.is_active` —— **停运线路不得进候选**。
    //   何以必须在这里过滤：站序索引是「线路 → 站序 → 逐跳枚举」的唯一原料，
    //   推荐 / 替代线路 / 站牌线路全部从 `dirStops` 派生 ⇒ 一旦停运线路留在索引里，
    //   它会作为一个**可被规划出来**的方案复活（36 路自 2026-10-24 并入 MT2 后即属此类）。
    //   ⚠️ **此处是唯一过滤点**：删掉这个条件，已取消的线路就会重新出现在导航候选里，
    //     且不会有任何报错（沉默逻辑错误，只有对比导航方案时才会暴露）。
    //   前置条件：`routes.is_active` 由 `db:sync-all` 的对账步骤维护
    //   （不在本次 DSAT 清单内的 bus 线路 → is_active=false）；本查询不再额外硬编码线路名，
    //   以免「停运事实」在代码里长成第二份真相。
    pool.query(
      `SELECT r.code AS route, rs.dsat_dir,
              array_agg(rs.station_code ORDER BY rs.seq) AS stops
         FROM route_stations rs
         JOIN routes r ON r.id = rs.route_id
        WHERE r.is_active
        GROUP BY r.code, rs.dsat_dir
        ORDER BY r.code, rs.dsat_dir`,
    ),
    // 站名与 kind 只随「站」变化（613 行），没必要在每一行停靠里重复 2870 次
    pool.query(`SELECT code, name_tc, kind FROM stations`),
  ]);
  return [stopsRes.rows as RouteStopRow[], stRes.rows as StationRow[]];
}

/** 带进程内缓存的站序索引（TTL 5 分钟；force=true 绕过） */
export async function loadRouteIndex(pool: Pool, force = false): Promise<RouteIndex> {
  const c = g.__routeIndexCache;
  if (!force && c && Date.now() - c.ts < CACHE_TTL_MS) return c.idx;
  const idx = await buildRouteIndex(pool);
  g.__routeIndexCache = { ts: Date.now(), idx };
  return idx;
}

/**
 * ★ v3.7.0（缓存专项）：观测用 —— 进程内站序索引的**年龄（秒）**。
 *
 * 为什么要暴露：站序缓存 300s，而「改了站序但没发版」会让旧站序持续服务到 TTL 结束。
 * 有了这个读数，「旧站序枚举」一旦发生就可观测，不必改机制
 * （一次部署会重建实例、`globalThis` 自然清空）。
 *
 * @returns 秒；**从未装载过 ⇒ `null`**（不返回 0 —— 0 会被读成「刚刚装载」）
 */
export function routeIndexAgeSecOf(nowMs: number = Date.now()): number | null {
  const c = g.__routeIndexCache;
  if (!c) return null;
  return Math.max(0, Math.round((nowMs - c.ts) / 1000));
}

/** 站序索引的 TTL（秒）—— 供 `/api/health` 与文档对齐，避免两处数字漂移 */
export const ROUTE_INDEX_TTL_SEC = CACHE_TTL_MS / 1000;
