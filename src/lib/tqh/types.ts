/**
 * 通琴号 · 共享类型与纯函数（src/lib/tqh/types.ts）
 *
 * ── 这个文件的边界（为什么必须是纯的）──────────────────────────────────
 *   它同时被 **server（三个 /api/tqh route + query.ts）** 与 **client 组件** import。
 *   因此这里**只允许**出现 `interface` / `type` / 常量 / 无副作用纯函数，
 *   **禁止** import `pg`、`@/lib/db` 或任何 server-only 模块 —— 一旦引入，
 *   客户端组件会在打包期把整条数据库链路拖进来（铁律 6 / C4）。
 *
 * ── 字段命名规则（一条，避免踩坑）──────────────────────────────────────
 *   API 字段名**逐字沿用库内列名**，不做驼峰、不改名。理由不是风格，是实操：
 *   任何「接口叫 station_id、库里叫 id」的改名，都会在第一次写 SQL 时错一次，
 *   而错误形态是运行时 `column does not exist`，不是编译错误。
 *
 *   三个最容易写错的地方（实测确认，2026-11-05）：
 *     ① `tqh_stations` 主键列名是 `id`，**不是** `station_id`；
 *        `stops[].station_id` 指向它。
 *     ② `trip_code` 的竖线是**全角 `｜`（U+FF5C）**，不是 ASCII `|`。
 *        实测 `SELECT position('|' in trip_code) FROM tqh_trips` 全为 0。
 *     ③ 终点站列名是 `terminal_name`（没有 `dest_name`），
 *        首末时刻是 `departure_time` / `arrival_time`（没有 `first_time` / `last_time`）。
 */

/**
 * 数据结构版本。
 *
 * 用途：前端把它与模块级常驻缓存里的版本比对，不一致就丢弃内存缓存重新拉。
 * ⚠️ **不要把版本号塞进 URL** —— 本项目既有教训：URL 一变，CDN 与浏览器两层缓存
 *    各管一段，发版后反而拿不到新数据。结构变更（字段增删/语义变化）时改这里。
 */
export const TQH_DATA_VERSION = "tqh-20261105-1";

/**
 * `trip_code` 的分隔符：**全角竖线 U+FF5C**。
 *
 * ⚠️ 解析与拼接一律走这个常量，禁止手写 `"|"`：
 *    ASCII 竖线在通琴号数据里出现 0 次，写错的表现是「全部查不到」而不是报错。
 */
export const TQH_TRIP_CODE_SEP = "\uFF5C";

/** `trip_code` 长度上限（实测真实值 13–23 字符，取 64 留余量；与 openapi.yaml 一致） */
export const TQH_TRIP_CODE_MAX_LEN = 64;

/** 段几何的算法版本。改算路算法/坐标系口径时升版本，旧行保留不删。 */
export const TQH_SEGMENT_PROFILE = "driving-v1";

/** 属地（站点的物理所在侧，**不是**班次方向） */
export type TqhSide = "澳门" | "横琴";

/** 班次方向 = 终点站属地，不看「上班/下班」 */
export type TqhDirection = "往澳门" | "往横琴";

/** 单段几何状态。`missing` 与 `failed` 前端都画虚线，区别只在离线脚本是否重试。 */
export type TqhSegmentStatus = "ok" | "missing" | "failed";

/** 通琴号站点（`tqh_stations`） */
export interface TqhStation {
  /** `tqh_stations.id`（不是 station_id；`TqhStop.station_id` 指向它） */
  id: number;
  /** 站名原文，含 ①②③ 圈号，**不可剥**（圈号是区分同物理点不同站台的唯一标识） */
  name: string;
  /** 经度，**GCJ-02**（库内原值，服务端不做转换） */
  lng: number;
  /** 纬度，**GCJ-02** */
  lat: number;
  side: TqhSide;
  /** 关联澳门巴士站站台码（对应 `stations.code`）；无关联为 null。41 个有值，去重后 35 个 */
  bus_station_code: string | null;
  /** 同物理点分组 id（integer，同组应视作一处） */
  same_place_group: number | null;
}

/** 班次内的一个站序点（`tqh_trip_stops`） */
export interface TqhStop {
  /** 站序，从 1 开始连续 */
  seq: number;
  /** 指向顶层 `stations[].id` */
  station_id: number;
  /** 计划时刻 `HH:MM:SS`（库内 time 列），本地时 Asia/Macau。**不是实时到站** */
  stop_time: string;
}

/** 一个班次（`tqh_trips` + 内嵌站序） */
export interface TqhTrip {
  /** `序号｜方向｜线路名全称`，竖线为全角 `｜` */
  trip_code: string;
  /** 线路标号 A1 / B6 / C4 / D3 */
  route_no: string;
  direction: TqhDirection;
  line_full_name: string;
  trip_label: string;
  /** 首站计划发车时刻 `HH:MM:SS` */
  departure_time: string;
  /** 末站计划到达时刻 `HH:MM:SS` */
  arrival_time: string;
  /** 站数，等于 `stops.length` */
  stop_count: number;
  origin_name: string;
  /** 终点站名（列名就叫 terminal_name） */
  terminal_name: string;
  /** 按 seq 升序 */
  stops: TqhStop[];
}

/** `GET /api/tqh/lines` 成功响应 */
export interface TqhLinesPayload {
  version: string;
  trips: TqhTrip[];
  stations: TqhStation[];
}

/** `GET /api/tqh/stations` 成功响应 */
export interface TqhStationsPayload {
  stations: TqhStation[];
}

/** 班次的一段相邻有向站对几何 */
export interface TqhSegment {
  from_station_id: number;
  to_station_id: number;
  status: TqhSegmentStatus;
  /** `[lng, lat]` 数组（经度在前），**GCJ-02**；`status !== "ok"` 时为 null */
  polyline: [number, number][] | null;
  /** 高德自报该段距离（米） */
  distance_m: number | null;
  /** 高德自报该段耗时（秒） */
  duration_s: number | null;
}

/** `GET /api/tqh/trip-path` 成功响应 */
export interface TqhTripPathPayload {
  trip_code: string;
  version: string;
  /** 长度 = stop_count - 1 */
  segments: TqhSegment[];
  /** true = 所有段 status 均为 ok */
  complete: boolean;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 纯函数（server / client 共用，禁止加副作用）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 解析通琴号时刻为「当日秒数」整数。**同时接受 `HH:MM` 与 `HH:MM:SS`**。
 *
 * ── 为什么必须两种都吃（实测，不是防御性编程）──────────────────────────
 *   同一个概念在两个数据源里格式不同：
 *     · 数据库 `time` 列经 `pg` 返回 → `"07:30:00"`；
 *     · 源数据模块 `db/tqh-data.ts` → `"07:30"`。
 *   直接 `new Date("07:30")` 会得到 `Invalid Date`；按 `HH:MM:SS` 硬切则 `"07:30"` 会崩。
 *
 * 解析后**全程只用整数比较**，禁止中途保留字符串或 Date 对象 —— 时刻比较一旦掺进
 * 设备时区就不可复现。时区语义固定 Asia/Macau（UTC+8），且实测跨零点班次 0 班
 * （`arrival_time < departure_time` 的班次数为 0）⇒ 不需要跨日回绕逻辑。
 *
 * @returns 当日秒数 0..86399；格式非法返回 `null`（**不抛异常**，调用方决定降级方式）
 */
export function parseTqhTimeToSec(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = m[3] === undefined ? 0 : Number(m[3]);
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return hh * 3600 + mm * 60 + ss;
}

/** 当日秒数 → `HH:MM`（用于班次卡的「HH:MM 发车」）。越界返回 null。 */
export function tqhTimeOfSec(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec < 0 || sec > 86399) return null;
  const s = Math.floor(sec);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * 线路标号的排序键：`[族序号, 族内数值]`。
 *
 * ── 为什么不能直接用字典序 ─────────────────────────────────────────────
 *   字典序会得到 `B1 B10 B11 … B2`（设计初稿实测踩过），
 *   而产品要求是 `B1 B2 … B9 B10`。
 *
 * 本函数与 `src/app/api/route-lines/route.ts` 的 `sortKey()` **同源同规则**
 * （数字优先 + 字母后缀），但通琴号的 `route_no` 只有「字母 + 数字」一种形态
 * （实测 35 个：A1~A5、B1~B21、C1~C4、D1/D2/D3/D5/D6，**无 D4**）。
 * 抽成共享纯函数而不是在组件里复制一份，是为了避免两处排序规则漂移。
 */
export function tqhRouteNoSortKey(routeNo: string): [number, number, string] {
  const m = /^([A-Za-z]+)(\d+)(.*)$/.exec(routeNo);
  if (!m) return [999, 9999, routeNo];
  return [m[1].toUpperCase().charCodeAt(0), Number(m[2]), m[3]];
}

/** 比较两个线路标号（数值序）。返回 `<0` / `0` / `>0`，可直接传 `Array.prototype.sort`。 */
export function compareTqhRouteNo(a: string, b: string): number {
  const ka = tqhRouteNoSortKey(a);
  const kb = tqhRouteNoSortKey(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] !== kb[1]) return ka[1] - kb[1];
  return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
}
