/**
 * 「中途总站」判定 —— **单一源**（src/lib/rebuild/mid-terminus.ts，v4.1.0）
 *
 * ── 为什么需要它（负责人实证）──────────────────────────────────────────
 *   26 路 `C656 路環警察訓練營-2 → C654/3 聯生圓形地總站` 实测 71 条样本：
 *   minutes 7.58 / dwell_B 6.58 → 纯行驶仅 **1.00 分**；纯行驶稳定在 0.75~1.08 分，
 *   长的部分全是**司机在总站休息**。但 C654/3 在 26 路是 `seq 43 / 76` 的**中途站**，
 *   现有「末站长停排除」（`./long-stop.ts`，要求 `./terminus.ts` 判为终点站）抓不到它 ——
 *   因为判定用的是「全澳总站并集」+ 本线末位，而这里的 (route, 站) 对不满足「本线末位」。
 *
 * ── 判据（负责人给的定义，勿另起一套）─────────────────────────────────
 *   `isMidTerminus(routeCode, stationCode)`
 *     = 站名含「總站」或「总站」
 *       AND 该站序 ≠ 首站
 *       AND 该站序 ≠ 末站
 *   逐站序行判定（同一物理站可能在某方向是首/末位、在另一方向是中途位）。
 *
 * ── 数据来源 ──────────────────────────────────────────────────────────
 *   运行时：复用 `loadStatics` 已缓存的 `routeStops`（站序）+ `stations`（站名）——
 *     零额外 DB 往返，见 `src/lib/recommend/query.ts` 的 `buildMidTerminusKeys` 调用。
 *   诊断/测试：`loadMidTerminusKeys(q)` 直接查库（`MID_TERMINUS_SQL`），
 *     供 `scripts/test-mid-terminus.ts` 对 28 个 (线路, 站) 做全命中断言。
 *   ⇒ **不得**把 28 行清单硬编码进代码：线路调整（加班次/改道）后它会静默过期。
 *
 * ⚠️ 归一必须用 `mainOf`（`C654/3 → C654`）—— `lookupHop` 全程按主码查询，
 *    两处归一不一致会让集合「看着有、查不到」，症状与「没实现」完全一样。
 */
import { mainOf } from "./terminus";

/** 站名判定用词（繁体 / 简体两种写法都要收：数据源是繁体，人工补录出现过简体） */
export const TERMINUS_NAME_MARKS = ["總站", "总站"] as const;

/** 站名是否含「總站 / 总站」 */
export function nameIsTerminus(name: string | null | undefined): boolean {
  const s = String(name ?? "");
  return TERMINUS_NAME_MARKS.some((m) => s.includes(m));
}

/** 站序行（与 `RouteStopRow` 同形，只取本判据需要的两列，便于脚本/测试复用） */
export interface MidTerminusStopRow {
  route: string;
  stops: string[] | null;
}

/**
 * 纯函数：站序行 + 「站码 → 站名」→ `route|main` 集合。
 *
 * @param stopsRows 每「线路 × 方向」一条，`stops` 为该方向**有序**站码（含站台号）
 * @param nameOf    站台码 → 站名（`stations.name_tc`）
 *
 * 判据逐**位置**判定：`i !== 0 && i !== stops.length - 1`。
 * 环线（首站 = 末站）时该站同时占首/末位 ⇒ 两个位置都排除，符合「首末位的總站不算中途」。
 */
export function buildMidTerminusKeys(
  stopsRows: readonly MidTerminusStopRow[],
  nameOf: ReadonlyMap<string, string | null | undefined>,
): Set<string> {
  const out = new Set<string>();
  for (const r of stopsRows) {
    const stops = r.stops ?? [];
    if (stops.length < 3) continue; // 只有 ≤2 站 ⇒ 没有「中途」位置
    for (let i = 1; i < stops.length - 1; i++) {
      const code = stops[i];
      if (!nameIsTerminus(nameOf.get(code))) continue;
      out.add(`${r.route}|${mainOf(code)}`);
    }
  }
  return out;
}

/** 单点判定（等价于集合查询，供调用方/测试直读） */
export function isMidTerminus(
  keys: ReadonlySet<string>,
  routeCode: string,
  stationCode: string,
): boolean {
  return keys.has(`${routeCode}|${mainOf(stationCode)}`);
}

/**
 * 诊断用 SQL（与 `buildMidTerminusKeys` 同义）。
 *
 * ⚠️ 窗口函数 `max(seq) OVER (...)` **必须在未过滤的站序全集上算**再过滤站名：
 *    若把 `WHERE 站名 LIKE '%總站%'` 写进子查询，`max(seq)` 会变成「名字含總站的站里的最大 seq」
 *    ⇒ 每个这样的站都被判成末位，中途总站全部漏判（首批核查时踩过，26|C654/3 就是这样被漏掉的）。
 */
export const MID_TERMINUS_SQL = `WITH seq AS (
  SELECT r.code AS route, r.id AS rid, rs.dsat_dir AS dir, rs.seq, rs.station_code,
         max(rs.seq) OVER (PARTITION BY r.id, rs.dsat_dir) AS mx
    FROM route_stations rs JOIN routes r ON r.id = rs.route_id
   WHERE r.kind = 'bus'
)
SELECT DISTINCT s.route, s.station_code
  FROM seq s JOIN stations st ON st.code = s.station_code
 WHERE (st.name_tc LIKE '%總站%' OR st.name_tc LIKE '%总站%')
   AND s.seq <> 1 AND s.seq <> s.mx`;

/** 查库版（诊断/测试用；运行时请用 `buildMidTerminusKeys` 复用已缓存的行） */
export async function loadMidTerminusKeys(
  q: (sql: string) => Promise<Record<string, unknown>[]>,
): Promise<Set<string>> {
  const rows = await q(MID_TERMINUS_SQL);
  return new Set(rows.map((r) => `${String(r.route)}|${mainOf(String(r.station_code))}`));
}
