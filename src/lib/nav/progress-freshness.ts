/**
 * 进度数据的**版本令牌 + 跨表版本漂移**观测（src/lib/nav/progress-freshness.ts，v3.7.0 · AC5.7）
 *
 * 两个导出，解决两个不同层面的问题：
 *   ① `versionTokenOf`  —— **运行时判新旧**：三源时间戳拼成令牌，塞进 `progress.ts` 三份缓存的键
 *                          ⇒ 改道 / 重算里程 / 重算时长后缓存**立即**失效，不必等 TTL 到点；
 *   ② `versionDriftOf`  —— **运维遗漏的可观测性**：两表版本时刻的差值。
 *                          令牌解决不了「改了道、忘了跑 `db:station-mileage`」——
 *                          那种情况下两表都可能"新"、令牌一致，但里程表内容其实没重建。
 *
 * ── 为什么令牌要含三源（不是只看 shape）──────────────────────────────
 *   `p` = (车辆里程 − 起点里程) / (终点里程 − 起点里程)：分子来自 `route_shapes` 投影，
 *   分母来自 `route_station_mileage`，而 `md`（时长）来自 `route_hop_stats`。
 *   **只看 shape 会漏掉「折线换了但里程表没重建」这个跨表不一致** —— 那正是偏差最大的一种
 *   （`p` 可能为负或 >1，被 clamp 在端点 ⇒ 车辆钉死在区间端点上）。
 *   三个时间戳都进令牌，任何一源变化都让缓存键变 ⇒ 跨表不一致不会被缓存固化。
 *
 * ── 令牌结果进程内缓存 5s（成本控制）─────────────────────────────────
 *   稳态下每次 `attachProgress` / `locateSegmentOf` 都要令牌 ⇒ 不缓存等于每 12s 一帧都多一次
 *   轻查询。缓存 **5s** 后：同一实例 5s 内的多次调用复用（12s 一帧的轮询实际几乎不查库），
 *   而改道最迟 5s 生效。
 *   ⚠️ **上限就是 5s，不能再长**：车辆帧是 12s，令牌若超过一个帧的寿命，
 *      同一个「取令牌 → 查缓存」窗口里就可能用旧几何算 `p`，把窗口重新打开。
 */
import type { Pool } from "pg";

/** 漂移告警阈值（秒）：超过 1 小时基本只可能是「改道后忘了重建里程表」 */
export const VERSION_DRIFT_WARN_SEC = 3600;

/** 令牌的进程内缓存时长（毫秒）。**上限 5s**，理由见文件头。 */
export const VERSION_TOKEN_MEMO_MS = 5_000;

/** 令牌缓存（键 = `route|dir`，只存最近一次） */
const tokenCache = new Map<string, { at: number; token: string }>();

export interface VersionDrift {
  /**
   * 「折线比里程表新超过阈值」的**线路方向个数**（真正的异常：改了道没重建里程表）。
   * 按 `route_code|dsat_dir` 逐个比较，只数危险方向。
   */
  staleCount: number;
  /** 上述危险方向里最大的「折线比里程新」秒数（无危险方向 ⇒ 0） */
  maxDriftSec: number;
  /** 判定阈值（秒） */
  thresholdSec: number;
  /** `staleCount > 0` */
  stale: boolean;
}

/**
 * 三源版本令牌（`route_shapes.fetched_at` + `route_station_mileage.updated_at` +
 * `route_hop_stats.updated_at`）。
 *
 * 失败兜底：查询失败（库抖动）⇒ 退化为 **30 秒桶**令牌 —— 宁可多查一次数据，
 * 也绝不用无法确认新鲜度的旧几何（与「宁缺勿错」同一条纪律）。桶变小**不会**造成错误，
 * 只会让命中率短暂下降。
 */
export async function versionTokenOf(pool: Pool, route: string, dir: string): Promise<string> {
  const key = `${route}|${dir}`;
  const hit = tokenCache.get(key);
  if (hit && Date.now() - hit.at < VERSION_TOKEN_MEMO_MS) return hit.token;

  let token: string;
  try {
    const r = await pool.query(
      `SELECT
         (SELECT max(fetched_at) FROM route_shapes          WHERE route_code = $1 AND dsat_dir = $2) AS shape_at,
         (SELECT max(updated_at) FROM route_station_mileage WHERE route_code = $1 AND dsat_dir = $2) AS mile_at,
         (SELECT max(updated_at) FROM route_hop_stats       WHERE route_code = $1)                   AS hop_at`,
      [route, dir],
    );
    const row = r.rows[0] as
      | { shape_at: Date | string | null; mile_at: Date | string | null; hop_at: Date | string | null }
      | undefined;
    const ms = (v: Date | string | null | undefined): number => (v ? new Date(v).getTime() : 0);
    token = `${ms(row?.shape_at)}|${ms(row?.mile_at)}|${ms(row?.hop_at)}`;
  } catch {
    // 兜底桶**不进缓存**：让下一次调用重新尝试真查询（抖动通常是瞬时的）
    return `b${Math.floor(Date.now() / 30_000)}`;
  }
  tokenCache.set(key, { at: Date.now(), token });
  return token;
}

/**
 * 逐线路方向比较两表版本，找出「改了道但里程表没跟上」的方向。
 *
 * ── 为什么不能拿两表的全局 `max()` 相减（第一版就这么写，在生产数据上立刻翻车）
 *   实测：全局 `max(fetched_at)` 与 `max(updated_at)` 相差 **约 4.7 天**，但那完全是**正常顺序** ——
 *   运维「先抓折线，过几天再重建里程」，`mileAt` 天然比 `shapeAt` 新。
 *   按全局**绝对值**比 ⇒ **恒为 stale**，读数直接废掉（告警沦为背景噪音，等于没做）。
 *
 * ── 正确的判据是**有方向**的
 *   唯一危险：**某条线路的折线比它自己的里程表新**（`shapeAt − mileAt > 阈值`）
 *   ⇒ 这条线改了道、里程表还是旧的 ⇒ `p` 的分母是旧值。
 *   里程表**比折线新**属正常（重建在后），不告警。
 *   里程表**整条缺失** ⇒ 也算危险（`COALESCE` 到 epoch 0），因为 `p` 根本算不出来。
 *
 * ── 只比较巴士方向（排除 `kind='lrt'`）
 *   实测：全库 117 个方向里有 **6 个轻轨方向没有 `route_station_mileage` 行**（轻轨走时刻表，
 *   不参与本进度模型）⇒ 若不排除，读数恒为 `staleCount: 6`，又是一个「天天红」的假告警。
 *   排除后实测：111 个巴士方向 **`stale=0 / no_mile=0`** —— 这才是可用的基线。
 *
 * @returns 查询失败 ⇒ `null`（**不编造 0** —— 0 会被读成「没有危险方向，一切正常」）
 */
export async function versionDriftOf(
  pool: Pool,
  thresholdSec: number = VERSION_DRIFT_WARN_SEC,
): Promise<VersionDrift | null> {
  try {
    const r = await pool.query(
      `WITH s AS (
         SELECT route_code, dsat_dir, max(fetched_at) AS at
           FROM route_shapes
          WHERE kind <> 'lrt'          -- 轻轨无里程表（走时刻表），不计入
          GROUP BY 1, 2
       ), m AS (
         SELECT route_code, dsat_dir, max(updated_at) AS at FROM route_station_mileage GROUP BY 1, 2
       )
       SELECT count(*) FILTER (WHERE d > $1)::int             AS stale_count,
              COALESCE(max(d) FILTER (WHERE d > $1), 0)::int    AS max_drift
         FROM (
           SELECT EXTRACT(EPOCH FROM (s.at - COALESCE(m.at, to_timestamp(0))))::int AS d
             FROM s LEFT JOIN m USING (route_code, dsat_dir)
         ) x`,
      [thresholdSec],
    );
    const row = r.rows[0] as { stale_count: number; max_drift: number } | undefined;
    const staleCount = Number(row?.stale_count ?? 0);
    return { staleCount, maxDriftSec: Number(row?.max_drift ?? 0), thresholdSec, stale: staleCount > 0 };
  } catch {
    return null;
  }
}

