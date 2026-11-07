/**
 * 通琴号 · 服务端取数层（src/lib/tqh/query.ts）
 *
 * ── 分层位置 ──────────────────────────────────────────────────────────
 *   route.ts（参数校验 → 调本文件 → 组装响应）
 *        ↓
 *   query.ts（SQL + 行 → DTO 映射，**唯一序列化真源**）
 *        ↓
 *   `@/lib/db`（pg 连接池）
 *
 *   三个端点共用这里的序列化函数：`/api/tqh/lines` 的 `stations` 与
 *   `/api/tqh/stations` 的 `stations` **必须逐字段一致**（openapi.yaml 的硬要求），
 *   若各写一份，第一次改字段就会分叉。
 *
 * ── 三条硬约束（改动前先读）──────────────────────────────────────────
 *   ① **只读**：本文件只有 SELECT，没有任何写库语句。
 *   ② **请求期零高德调用**：几何全部来自 `tqh_segment_paths`（离线脚本预生成）。
 *      本项目已有「高德配额用尽时静默返回空」的事故面（`src/lib/nav/quota.ts`），
 *      把外部调用放进请求路径会造成「时好时坏且不报错」。
 *   ③ **不做坐标转换**：`tqh_stations.lng/lat` 本身就是 GCJ-02。
 *      这与 `/api/stations`（库内 WGS84、出口转 GCJ-02）**口径相反**，
 *      是本方案最容易被后来者「顺手统一」而写错的一处。
 */
import { getPool } from "@/lib/db";
import {
  TQH_DATA_VERSION,
  TQH_SEGMENT_PROFILE,
  type TqhDirection,
  type TqhLinesPayload,
  type TqhSegment,
  type TqhSegmentStatus,
  type TqhStation,
  type TqhStationsPayload,
  type TqhStop,
  type TqhTrip,
  type TqhTripPathPayload,
  compareTqhRouteNo,
} from "./types";

/* ══════════════════════════════════════════════════════════════════════════
 * 行类型（与 SQL 的 SELECT 列一一对应；列名逐字沿用库内列名）
 * ══════════════════════════════════════════════════════════════════════════ */

interface StationRow {
  id: number;
  name: string;
  lng: number;
  lat: number;
  side: string;
  bus_station_code: string | null;
  same_place_group: number | null;
}

interface TripRow {
  id: number;
  trip_code: string;
  route_no: string;
  direction: string;
  line_full_name: string;
  trip_label: string;
  departure_time: string;
  arrival_time: string;
  stop_count: number;
  origin_name: string;
  terminal_name: string;
}

interface StopRow {
  trip_id: number;
  seq: number;
  station_id: number;
  stop_time: string;
}

interface SegmentRow {
  from_station_id: number;
  to_station_id: number;
  has_row: boolean;
  polyline: unknown;
  distance_m: number | null;
  duration_s: number | null;
  source: string | null;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 行 → DTO
 * ══════════════════════════════════════════════════════════════════════════ */

function toStation(row: StationRow): TqhStation {
  return {
    id: row.id,
    name: row.name,
    // GCJ-02 原值直出。⚠️ 不要把这里换成 wgs84ToGcj02(row.lng) —— tqh_* 已是 GCJ-02。
    lng: row.lng,
    lat: row.lat,
    side: row.side === "澳门" ? "澳门" : "横琴",
    bus_station_code: row.bus_station_code,
    same_place_group: row.same_place_group,
  };
}

/**
 * `polyline` 是 jsonb，`pg` 会直接反序列化成嵌套数组。
 * 这里做一次**形状校验而不是无条件 cast**：离线脚本若误写成 `"lng,lat;…"` 文本，
 * 无校验的实现会把字符串塞进响应，前端 `flat()` 时才炸（且是运行时才炸）。
 */
function toPolyline(value: unknown): [number, number][] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const out: [number, number][] = [];
  for (const p of value) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const lng = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    out.push([lng, lat]);
  }
  return out;
}

/**
 * 段状态由**行是否存在 + polyline 是否为空**推导，而不是靠一个 `status` 列。
 *
 * 口径（与 Spec §6.1 锁定的列清单一致，该表只有 source / fetched_at，没有 status）：
 *   · 无行                       → `missing`（离线脚本还没算到）
 *   · 有行但 polyline 为 NULL     → `failed`（上游明确无路网，脚本 30 天内不再重试）
 *   · 有行且 polyline 是有效点数组 → `ok`
 *
 * ⚠️ 必须显式判断「行存在」（SQL 里 `p.from_station_id IS NOT NULL AS has_row`），
 *    不能靠 `source == null` 反推：无行与「有行但 source 为空」在 LEFT JOIN 后
 *    看起来一样，而两者语义不同（前者该补算，后者不该无限重试）。
 *
 * 前端把 `missing` 与 `failed` 都画虚线，区别只在离线脚本的重试策略。
 */
function toSegmentStatus(hasRow: boolean, polyline: [number, number][] | null): TqhSegmentStatus {
  if (!hasRow) return "missing";
  return polyline ? "ok" : "failed";
}

/* ══════════════════════════════════════════════════════════════════════════
 * 对外查询
 * ══════════════════════════════════════════════════════════════════════════ */

/** 138 个通琴号站点（GCJ-02）。`/api/tqh/stations` 与 `/api/tqh/lines` 共用。 */
export async function loadTqhStations(): Promise<TqhStationsPayload> {
  const res = await getPool().query(
    `SELECT id, name, lng, lat, side, bus_station_code, same_place_group
       FROM tqh_stations
      ORDER BY id`,
  );
  return { stations: (res.rows as StationRow[]).map(toStation) };
}

/**
 * 80 个班次 + 843 条站序 + 138 个站点，一次返回。
 *
 * 体量实测约 46 KB（gzip 后约 8 KB），比既有 `/api/stations` 的 619 站还小；
 * 收益是 R4 站点卡、R6 属地标签、R7 搜索全部变成纯客户端计算（零请求、零配额）。
 *
 * 查询形态：3 次全表扫描 + 内存 group（80 / 843 / 138 行），O(n) 且 n < 1000，
 * **无 N+1**。不要为了「看起来更优雅」改成逐班次查站序。
 */
export async function loadTqhLines(): Promise<TqhLinesPayload> {
  const pool = getPool();

  const [tripRes, stopRes, stationRes] = await Promise.all([
    pool.query(
      `SELECT id, trip_code, route_no, direction, line_full_name, trip_label,
              to_char(departure_time, 'HH24:MI:SS') AS departure_time,
              to_char(arrival_time,   'HH24:MI:SS') AS arrival_time,
              stop_count, origin_name, terminal_name
         FROM tqh_trips
        ORDER BY id`,
    ),
    pool.query(
      `SELECT trip_id, seq, station_id, to_char(stop_time, 'HH24:MI:SS') AS stop_time
         FROM tqh_trip_stops
        ORDER BY trip_id, seq`,
    ),
    pool.query(
      `SELECT id, name, lng, lat, side, bus_station_code, same_place_group
         FROM tqh_stations
        ORDER BY id`,
    ),
  ]);

  // 站序按 trip_id 分桶（一次遍历，O(n)）
  const stopsByTrip = new Map<number, TqhStop[]>();
  for (const row of stopRes.rows as StopRow[]) {
    const list = stopsByTrip.get(row.trip_id);
    const stop: TqhStop = { seq: row.seq, station_id: row.station_id, stop_time: row.stop_time };
    if (list) list.push(stop);
    else stopsByTrip.set(row.trip_id, [stop]);
  }

  let stopCountDrift = 0;
  const trips: TqhTrip[] = (tripRes.rows as TripRow[]).map((row) => {
    const stops = stopsByTrip.get(row.id) ?? [];
    // 契约要求 stop_count === stops.length。若库内两处不一致，以**实际站序**为准
    // （前端按 stops 渲染，用库内计数会造成「卡片说 7 站、列表画 6 站」）。
    if (row.stop_count !== stops.length) stopCountDrift++;
    return {
      trip_code: row.trip_code,
      route_no: row.route_no,
      direction: (row.direction === "往澳门" ? "往澳门" : "往横琴") as TqhDirection,
      line_full_name: row.line_full_name,
      trip_label: row.trip_label,
      departure_time: row.departure_time,
      arrival_time: row.arrival_time,
      stop_count: stops.length,
      origin_name: row.origin_name,
      terminal_name: row.terminal_name,
      stops,
    };
  });

  // 数据漂移只报警一次（不逐条刷屏），且不阻断请求 —— 站序本身仍是可用的。
  if (stopCountDrift > 0) {
    console.warn(
      `[tqh/query] ${stopCountDrift} 个班次的 stop_count 与站序行数不一致，已按站序行数输出`,
    );
  }

  // 稳定排序：标号数值序 → 发车时刻 → trip_code。
  // 不在 SQL 里排：`route_no` 直接 ORDER BY 会得到 B1,B10,B11…,B2 的字典序。
  trips.sort((a, b) => {
    const byNo = compareTqhRouteNo(a.route_no, b.route_no);
    if (byNo !== 0) return byNo;
    if (a.departure_time !== b.departure_time) {
      return a.departure_time < b.departure_time ? -1 : 1;
    }
    return a.trip_code < b.trip_code ? -1 : a.trip_code > b.trip_code ? 1 : 0;
  });

  return {
    version: TQH_DATA_VERSION,
    trips,
    stations: (stationRes.rows as StationRow[]).map(toStation),
  };
}

/** 班次是否存在（`/api/tqh/trip-path` 用 404 区分「不存在」与「服务故障」） */
export async function findTqhTripId(tripCode: string): Promise<number | null> {
  const res = await getPool().query(`SELECT id FROM tqh_trips WHERE trip_code = $1 LIMIT 1`, [
    tripCode,
  ]);
  const row = res.rows[0] as { id: number } | undefined;
  return row ? row.id : null;
}

/**
 * 单个班次的逐段几何。
 *
 * 返回**段数组**而不是拼好的一条折线：前端要把 `status != ok` 的段画成虚线、
 * `ok` 段画实线，拼成一条就丢了分界信息。拼接在客户端一次 `flat()`，O(n)。
 *
 * SQL 形态：`tqh_trip_stops` 自连接取相邻站对（≤18 行）+ 一次 `tqh_segment_paths`
 * LEFT JOIN（唯一键命中）。**两条查询、零循环内 IO**。
 *
 * ⚠️ 去重键是 `(from_station_id, to_station_id, profile)`，**禁止**改成
 *    `route_no + direction`：实测 64 组 (route_no,direction) 装不下 73 种真实站序，
 *    其中 8 组是「真不同路线」（差异 259–3701 m）⇒ 按标号级 key 会在地图上画错路。
 *
 * @param tripId   已确认存在的 `tqh_trips.id`
 * @param tripCode 回填到响应里（前端按它对齐请求）
 */
export async function loadTqhTripPath(
  tripId: number,
  tripCode: string,
): Promise<TqhTripPathPayload> {
  const res = await getPool().query(
    `WITH s AS (
       SELECT seq,
              station_id,
              lead(station_id) OVER (ORDER BY seq) AS next_station_id
         FROM tqh_trip_stops
        WHERE trip_id = $1
     )
     SELECT s.station_id      AS from_station_id,
            s.next_station_id AS to_station_id,
            (p.from_station_id IS NOT NULL) AS has_row,
            p.polyline,
            p.distance_m,
            p.duration_s,
            p.source
       FROM s
       LEFT JOIN tqh_segment_paths p
              ON p.from_station_id = s.station_id
             AND p.to_station_id   = s.next_station_id
             AND p.profile         = $2
      WHERE s.next_station_id IS NOT NULL
      ORDER BY s.seq`,
    [tripId, TQH_SEGMENT_PROFILE],
  );

  const segments: TqhSegment[] = (res.rows as SegmentRow[]).map((row) => {
    const polyline = toPolyline(row.polyline);
    return {
      from_station_id: row.from_station_id,
      to_station_id: row.to_station_id,
      status: toSegmentStatus(row.has_row, polyline),
      polyline,
      distance_m: row.distance_m,
      duration_s: row.duration_s,
    };
  });

  return {
    trip_code: tripCode,
    version: TQH_DATA_VERSION,
    segments,
    complete: segments.length > 0 && segments.every((s) => s.status === "ok"),
  };
}
