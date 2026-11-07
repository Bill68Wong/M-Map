/**
 * 通琴号（TQH）· 前端数据模型与纯函数（src/components/nav/tqh-model.ts，2026-11-05）
 *
 * ── 为什么前端另存一份类型 ──────────────────────────────────────────────
 *   权威类型在 `src/lib/tqh/types.ts`（后端定义、前端只读），该文件本批由后端同事创建。
 *   ⚠️ 本文件是**镜像**，字段名逐字对齐 `docs/迭代-通琴号-20261105/openapi.yaml`：
 *      · 站名原文含 ①②③（区分站台位的唯一标识）——**不可剥离**；
 *      · `tqh_stations` 主键是 `id`，不是 `station_id`；
 *      · `trip_code` 用**全角竖线** `｜`（U+FF5C），请求时必须 `encodeURIComponent()`。
 *   后端文件就绪后，把这里的 `export interface` 换成 `export type { … } from "@/lib/tqh/types"`
 *   即可（消费方 import 路径不变）。
 *
 * ── 只放纯函数 ──────────────────────────────────────────────────────────
 *   零 React、零 DOM、零 fetch ⇒ 可被任何 client/server 边界安全引用。
 */

/** 站点属地（物理所在侧，**不是**班次方向） */
export type TqhSide = "澳门" | "横琴";

/** 班次方向 = **终点站属地**，不看「上班/下班」 */
export type TqhDirection = "往澳门" | "往横琴";

/** `/api/tqh/lines` · `stations[i]`（坐标 **GCJ-02 原值**，前端不得再转） */
export interface TqhStation {
  /** `tqh_stations.id`；下游 `stops[].station_id` 指向它 */
  id: number;
  /** 站名原文（含 ①②③） */
  name: string;
  /** 经度 GCJ-02 */
  lng: number;
  /** 纬度 GCJ-02 */
  lat: number;
  side: TqhSide;
  /**
   * 关联澳门巴士站**站台码**（如 `T365/1`）。
   * ⚠️ 41 个站点有值，但只有 **35 个不同站码** ⇒ 画右半圆必须去重（否则同站叠两个半圆）。
   */
  bus_station_code?: string | null;
  /** 同物理点分组（当前只有 1 组 2 条：澳科大南門①②） */
  same_place_group?: number | null;
}

/** `/api/tqh/lines` · `trips[i].stops[j]` */
export interface TqhStop {
  /** 站序，1 基连续 */
  seq: number;
  /** 指向顶层 `stations[].id` */
  station_id: number;
  /** 本站**计划时刻** `HH:MM:SS`（Asia/Macau）——**不是实时到站** */
  stop_time: string;
}

/** `/api/tqh/lines` · `trips[i]`（字段名逐字沿用库内列名） */
export interface TqhTrip {
  /** `序号｜方向｜线路全称`，竖线为**全角** `｜` */
  trip_code: string;
  /** 线路标号（35 个：A1~A5 / B1~B21 / C1~C4 / D1~D5） */
  route_no: string;
  direction: TqhDirection;
  /** 线路全称，如 `A1线-上班线` */
  line_full_name: string;
  /** 班次标签（`上班线` / `下班`…） */
  trip_label?: string;
  /** 首站计划发车时刻 `HH:MM:SS` */
  departure_time?: string;
  /** 末站计划到达时刻 `HH:MM:SS` */
  arrival_time?: string;
  stop_count?: number;
  origin_name?: string;
  /** 终点站名（库内列名 `terminal_name`） */
  terminal_name?: string;
  stops: TqhStop[];
}

/** `/api/tqh/lines` 全量响应 */
export interface TqhLinesResponse {
  version: string;
  trips: TqhTrip[];
  stations: TqhStation[];
  /** 失败时服务端保留数组形状（`trips: []` / `stations: []`） */
  error?: string;
}

/** `/api/tqh/trip-path` · `segments[i]` */
export interface TqhSegment {
  from_station_id: number;
  to_station_id: number;
  /**
   * `ok` 有几何（画实线）· `missing` 无记录 · `failed` 上游确认无路网
   * ⇒ 后两者画**直线虚线**降级（不造假）。
   */
  status: "ok" | "missing" | "failed";
  /** `[lng,lat]` 数组（GCJ-02）；`status != ok` 时为 null */
  polyline?: [number, number][] | null;
  distance_m?: number | null;
  duration_s?: number | null;
}

/** `/api/tqh/trip-path` 响应 */
export interface TqhTripPathResponse {
  trip_code: string;
  version?: string;
  segments: TqhSegment[];
  /** true = 所有段均 ok */
  complete?: boolean;
  error?: string;
}

/**
 * `HH:MM:SS` → `HH:MM`（无秒段也容忍：`7:30` → `07:30`）。
 * 库内是 `time without time zone`，解析**不得**经过 `Date`（会卷进设备时区）。
 */
export function hhmm(t: string | null | undefined): string {
  const s = String(t ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** `HH:MM:SS` → 当日分钟数（排序用；无法解析 → `Number.MAX_SAFE_INTEGER` 排最后） */
function minutesOf(t: string | null | undefined): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.MAX_SAFE_INTEGER;
}

/**
 * 标号 → `{ family, num }`（`A1` → `{A,1}`）。
 *
 * ⚠️ **禁止字典序**：字典序会得到 `B1 B10 B11 … B2`（`route-lines/route.ts:47` 的历史坑）。
 * 族内必须按 `num` 数值升序（`B9` 紧邻 `B10`）。
 */
export function routeNoParts(no: string): { family: string; num: number } {
  const m = /^([A-Za-z]+)0*(\d+)/.exec(String(no ?? "").trim());
  if (!m) return { family: String(no ?? ""), num: Number.MAX_SAFE_INTEGER };
  return { family: m[1].toUpperCase(), num: Number(m[2]) };
}

/** 标号比较：先族名（A→B→C）、再族内数值 */
export function compareRouteNo(a: string, b: string): number {
  const pa = routeNoParts(a);
  const pb = routeNoParts(b);
  if (pa.family !== pb.family) return pa.family < pb.family ? -1 : 1;
  return pa.num - pb.num;
}

/** 一个字母族（`A` / `B` / `C` / `D`）及其标号（族内已按数值升序） */
export interface TqhFamily {
  family: string;
  routeNos: string[];
}

/**
 * 把班次摊成「字母族 → 标号」结构（`TqhBoard` 的 7 列 6 行栅格数据源）。
 *
 * 排布规则（负责人 §17-R3 裁决）：**每个字母族各自起新行**，族内数值序，行末留空。
 * 实测 35 个标号 ⇒ A 5 / B 21 / C 4 / D 5 ⇒ 1 + 3 + 1 + 1 = **6 行**。
 */
export function groupRouteNos(trips: TqhTrip[]): TqhFamily[] {
  const byFamily = new Map<string, Set<string>>();
  for (const t of trips) {
    const no = String(t.route_no ?? "").trim();
    if (!no) continue;
    const { family } = routeNoParts(no);
    if (!byFamily.has(family)) byFamily.set(family, new Set());
    byFamily.get(family)!.add(no);
  }
  return [...byFamily.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([family, set]) => ({ family, routeNos: [...set].sort(compareRouteNo) }));
}

/** 同一标号下的全部班次，按**发车时刻**升序（同刻按方向稳定） */
export function tripsOfRouteNo(trips: TqhTrip[], routeNo: string): TqhTrip[] {
  return trips
    .filter((t) => t.route_no === routeNo)
    .slice()
    .sort((a, b) => {
      const d = minutesOf(a.departure_time) - minutesOf(b.departure_time);
      if (d !== 0) return d;
      return a.direction < b.direction ? -1 : a.direction > b.direction ? 1 : 0;
    });
}

/** 某标号是否单向（`distinct direction === 1` ⇒ 换向键 `aria-disabled`） */
export function isSingleDirection(trips: TqhTrip[], routeNo: string): boolean {
  const set = new Set(trips.filter((t) => t.route_no === routeNo).map((t) => t.direction));
  return set.size <= 1;
}

/** 站码主码归一（剥站台后缀：`T365/1` → `T365`）—— 与 `StationCard` 内联的实现同口径 */
export function mainCodeOf(code: string | null | undefined): string {
  return /^[A-Za-z]+\d+/.exec(String(code ?? ""))?.[0] ?? String(code ?? "");
}

/**
 * 关联巴士站去重（41 个通琴号站 → **35 个完整站台码**）。
 * key = **完整站码**（`T373/1`）；同一站台被多站共用只保留第一个站。
 *
 * ⚠️ 口径必须是**完整站码**，不是主码：实测 41 个站码 → 完整站码 35 / 主码 33，
 *   按主码去重会把 `T551/1` 与 `T551/2`（两个不同站台）、`M172/15` 与 `M172/16`
 *   各并掉一个。
 * ★ 2026-11-06（修复批 #1）：本函数现在**只作口径核对 + 双色集来源**，
 *   **不再是绘制清单** —— 带 `bus_station_code` 的通琴号站**不再单独画 marker**，
 *   通琴号信息挂到巴士站标上（左蓝右粉）。
 */
export function sharedBusStations(stations: TqhStation[]): Map<string, TqhStation> {
  const out = new Map<string, TqhStation>();
  for (const s of stations) {
    const code = String(s.bus_station_code ?? "").trim();
    if (!code) continue;
    if (!out.has(code)) out.set(code, s);
  }
  return out;
}

/**
 * ★ 2026-11-06（修复批 #1）：**双色巴士标**的完整站台码集合（实测 35 个）。
 *
 * 用途：口径核对 / 断言（「41 站 → 35 个站台码」）。**不用于渲染判据** ——
 * 渲染看的是下面 `sharedBusMainCodes()`（`/api/stations` 只下发主码）。
 */
export function sharedBusCodes(stations: TqhStation[]): Set<string> {
  const out = new Set<string>();
  for (const s of stations) {
    const code = String(s.bus_station_code ?? "").trim();
    if (code) out.add(code);
  }
  return out;
}

/**
 * ★ 2026-11-06（修复批 #1）：**双色巴士标**的主码集合（实测 33 个）= 渲染判据。
 *
 * 为什么是主码而不是完整站台码：
 *   `GET /api/stations` 按**主码**去重后才下发（`stations/route.ts:135-176`，
 *   `M172/1…M172/17` 塌成一个 `code: "M172"` 的点）⇒ 地图上的巴士 marker 天生只有主码粒度。
 *   35 个站台码 → 33 个主码（`M172/15`+`M172/16`、`T551/1`+`T551/2` 各自并成一个点）
 *   ⇒ 实际能染双色的巴士 marker = **33 个**，不是 35 个。
 *   ⚠️ 这不是漏染：那 2 组站台在 `stations` 表里本来就共用**同一个蓝点**，
 *      染 1 个点 = 视觉上「这一站与通琴号共用」，语义正确。
 */
export function sharedBusMainCodes(stations: TqhStation[]): Set<string> {
  const out = new Set<string>();
  for (const s of stations) {
    const code = String(s.bus_station_code ?? "").trim();
    if (code) out.add(mainCodeOf(code));
  }
  return out;
}

/**
 * ★ 2026-11-06（R1）：同物理点分组（`same_place_group`）→ 站数组。
 *
 * 实测只有 1 组（id 21：`澳门科技大学南门（新濠天地）①` + `②`，间距 1.0 m）。
 * R1 裁决「只合并这一组」⇒ 地图上 1 个标，弹窗内按原站（①/②）各自成组。
 * ⚠️ 组内按 `id` 升序（与 `db/migrate-v3701.ts:95` 「`same_place_group` 取组内最小 id」同口径），
 *   代表站 = 组内 `id` 最小者（坐标偏差 1.0 m，视觉无差别）。
 */
export function samePlaceGroupsOf(stations: TqhStation[]): Map<number, TqhStation[]> {
  const out = new Map<number, TqhStation[]>();
  for (const s of stations) {
    const g = s.same_place_group;
    if (typeof g !== "number") continue;
    const arr = out.get(g);
    if (arr) arr.push(s);
    else out.set(g, [s]);
  }
  for (const arr of out.values()) arr.sort((a, b) => a.id - b.id);
  return out;
}

/** 站名去掉尾部的圈码（`…南门①` → `…南门`），仅用于合并组标题 */
function stripCircled(name: string): string {
  return String(name ?? "").replace(/[\u2460-\u2473]\s*$/, "").trim();
}

/**
 * 合并组的**卡片标题**：组内站名去掉圈码后若一致 ⇒ 用该共同名（`澳门科技大学南门（新濠天地）`），
 * 否则回落代表站名。单站 ⇒ 原样返回。
 */
export function mergedTitleOf(list: TqhStation[]): string {
  const first = list[0];
  if (!first) return "";
  if (list.length <= 1) return first.name;
  const bases = new Set(list.map((s) => stripCircled(s.name)));
  return bases.size === 1 ? [...bases][0] : first.name;
}

/* ─────────────────── 卡片分组数据（修复批 #2 / R1） ─────────────────── */

/** 一个「通琴号站」及其方向分组（站点卡里的一组） */
export interface TqhStationEntry {
  station: TqhStation;
  groups: TqhStationGroup[];
}

/** 方向分组（组序固定 往澳门 → 往横琴；组内按计划发车时刻） */
function groupsForIds(trips: TqhTrip[], ids: ReadonlySet<number>): TqhStationGroup[] {
  if (!ids.size) return [];
  const out: TqhStationGroup[] = [
    { direction: "往澳门", trips: [] },
    { direction: "往横琴", trips: [] },
  ];
  for (const t of trips) {
    if (!t.stops.some((st) => ids.has(st.station_id))) continue;
    const g = out.find((x) => x.direction === t.direction);
    if (g) g.trips.push(t);
  }
  for (const g of out) {
    g.trips.sort((a, b) => minutesOf(a.departure_time) - minutesOf(b.departure_time));
  }
  return out.filter((g) => g.trips.length > 0);
}

/**
 * ★ 2026-11-06（#2 / R1）：站点卡底部的**通琴号分组**。
 *
 * 口径（Spec §3 #2）：组名 `通琴号-<通琴号站名>`，**位置最底部**、**不显示巴士标号**。
 * 一个巴士主码可能对应**多个通琴号站**（`M172` → `亚马喇前地F站台`(M172/15) +
 * `亚马喇前地G站台`(M172/16)；`T429` → 3 个）⇒ 逐个站各成一组，不混在一起。
 * 无班次的站不列出（避免空组）。
 */
export function tqhEntriesAtBusStation(
  trips: TqhTrip[],
  stations: TqhStation[],
  busCode: string | null | undefined,
): TqhStationEntry[] {
  const want = mainCodeOf(busCode);
  if (!want) return [];
  const out: TqhStationEntry[] = [];
  for (const s of stations) {
    if (!s.bus_station_code) continue;
    if (mainCodeOf(s.bus_station_code) !== want) continue;
    const groups = groupsForIds(trips, new Set([s.id]));
    if (groups.length) out.push({ station: s, groups });
  }
  return out.sort((a, b) => a.station.id - b.station.id);
}

/**
 * ★ 2026-11-06（R1）：**同物理点合并组**的通琴号分组（弹窗内按原站 ①/② 各自成组）。
 * 排序按站名（`①` < `②`，圈码在 Unicode 里本就升序）⇒ 卡片里的组序符合直觉。
 */
export function tqhEntriesAtStations(trips: TqhTrip[], list: TqhStation[]): TqhStationEntry[] {
  const out: TqhStationEntry[] = [];
  for (const s of list) {
    const groups = groupsForIds(trips, new Set([s.id]));
    if (groups.length) out.push({ station: s, groups });
  }
  return out.sort((a, b) =>
    a.station.name.localeCompare(b.station.name, "zh-Hant", { numeric: true }),
  );
}

/** 站 id → 站对象（时间线/卡片的 O(1) 查表） */
export function stationMapOf(stations: TqhStation[]): Map<number, TqhStation> {
  const m = new Map<number, TqhStation>();
  for (const s of stations) m.set(s.id, s);
  return m;
}

/** 某班次经过的站点 id 集合（地图高亮用） */
export function tripStationIds(trip: TqhTrip | null | undefined): Set<number> {
  const s = new Set<number>();
  for (const st of trip?.stops ?? []) s.add(st.station_id);
  return s;
}

/**
 * 搜索命中的班次（AC-9：按班次逐条、上限 80 条）。
 *
 * 匹配口径：标号（`B6`，大小写不敏感、可带前导零）+ 线路全称 + 方向。
 * ⚠️ 不接 `/api/poi/suggest`（高德月配额 5,000 次），本地过滤即可。
 */
export const TQH_SEARCH_MAX = 80;

export function searchTrips(trips: TqhTrip[], keyword: string): TqhTrip[] {
  const q = keyword.trim().toLowerCase();
  if (!q) return [];
  const hit: TqhTrip[] = [];
  for (const t of trips) {
    const no = t.route_no.toLowerCase();
    if (no.startsWith(q) || no === q || t.line_full_name.toLowerCase().includes(q) || t.direction.includes(q)) {
      hit.push(t);
    }
  }
  hit.sort((a, b) => {
    const c = compareRouteNo(a.route_no, b.route_no);
    if (c !== 0) return c;
    const d = minutesOf(a.departure_time) - minutesOf(b.departure_time);
    if (d !== 0) return d;
    return a.direction < b.direction ? -1 : a.direction > b.direction ? 1 : 0;
  });
  return hit.slice(0, TQH_SEARCH_MAX);
}

/**
 * 某站点在「站点卡片」里的分组（负责人裁决 5：按方向分组，组内按时间）。
 * 组序固定 **往澳门 → 往横琴**（与地图上「先入澳、后出澳」的阅读顺序一致）。
 *
 * ★ 2026-11-06（修复批 #2）：产出函数已换成 `tqhEntriesAtBusStation` /
 *   `tqhEntriesAtStations`（按**通琴号站**成组，组名 `通琴号-<站名>`）；
 *   旧的 `tripsAtStation`（按主码一锅端）已删除 —— 它会把 `M172` 的 F/G 两个站台
 *   混成一坨，且与「一个站一个组名」的要求冲突。**不要再加回第二套口径。**
 */
export interface TqhStationGroup {
  direction: TqhDirection;
  trips: TqhTrip[];
}
