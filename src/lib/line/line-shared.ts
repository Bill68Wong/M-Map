/**
 * 线路全景页 · 前后端共用类型（src/lib/line/line-shared.ts，v3.6.0 · S6）
 *
 * ── 为什么单独成文件 ────────────────────────────────────────────────────
 *   服务端组件（`page.tsx`）与客户端外壳（`LineClient.tsx` / `LineStopList.tsx`）
 *   必须对「一站长什么样」有同一份定义。若客户端从 `load-route-stops.ts` 里 import
 *   类型，就会把 `pg` 拖进浏览器包（铁律 6：client 禁 import 含 pg 的 server 模块）。
 *   ⇒ 本文件**只允许** `type` 与零依赖常量。
 *
 * ── 坐标口径 ────────────────────────────────────────────────────────────
 *   `lat` / `lng` **一律 GCJ-02**（服务端已转）。前端**不得**再转一次 ——
 *   `stations` 表是 WGS84，但出口已转，重复转会偏移几百米。
 *
 * ── `mileM` 为什么可空 ─────────────────────────────────────────────────
 *   来自 `route_station_mileage`（站投影到 `route_shapes` 的弧长）：
 *   · 轻轨**全部为 null**（无投影数据）；
 *   · 未跑 `db:station-mileage` 时也全 null。
 *   ⇒ **null 时不得参与任何计算**（排序/进度/比例都不行），只能当可选展示。
 */

/**
 *   线路名统一口径（剥 `LRT-` + 简→繁）。纯展示层、零依赖 ⇒ 不违反本文件「只允许 type 与零依赖常量」。
 *   ⚠️ 引入它是为了消灭「就地写 replace」造成的简繁分裂（见 `chipLabelOf` 注释）。
 */
import { lineNameOf } from "@/lib/route-label";

/** 线路种类 */
export type LineKind = "bus" | "lrt";

/** 全景页的一站（= `/api/route-stops` 的 `stops[i]`） */
export interface LineStop {
  /** 站序，**1 基**（来自 `route_stations.seq`，与 DSAT 口径一致） */
  seq: number;
  /**
   * **站台码**（如 `M95/3` / `T373/1`）—— 不是主码！
   * ★ 报站必须用它做 `platform` 匹配，见 `LineClient` 的坑②说明。
   */
  code: string;
  /** 站名（繁体原文，**不做简繁转换**） */
  name: string;
  kind: LineKind;
  /** GCJ-02；缺坐标时为 `null`（站表未补坐标） */
  lat: number | null;
  lng: number | null;
  /** 沿线里程（米）；**null 表示无数据，不得参与计算** */
  mileM: number | null;
}

/** `/api/route-stops` 的成功响应 */
export interface RouteStopsOk {
  ok: true;
  code: string;
  kind: LineKind;
  /** 线路主题色（`routes.color`），徽章底色用 */
  color: string;
  company: string | null;
  /** 可用方向（`dsat_dir`，通常 `["0"]` 或 `["0","1"]`） */
  dirs: string[];
  /** 本次返回的方向 */
  dir: string;
  /** 首末站名（给「往 XXX · 共 N 站」用）；站序为空时为 null */
  label: { from: string; to: string } | null;
  stops: LineStop[];
}

/** `/api/route-stops` 的失败响应 */
export interface RouteStopsErr {
  ok: false;
  error: string;
}

export type RouteStopsResp = RouteStopsOk | RouteStopsErr;

/** `/api/route-shapes` 的单方向走向 */
export interface LineShape {
  dir: string;
  /** `lng,lat;lng,lat;...` —— **GCJ-02**，直接喂高德，**不要再转** */
  polyline: string;
  points: number;
  startStop: string | null;
  endStop: string | null;
  bounds: [number | null, number | null, number | null, number | null];
  /**
   * ★ 4-B−（2026-11-03 需求 4）：本方向**站序**（主码、按 `seq` 升序、相邻重复已折叠）。
   *
   * 为什么需要：彩段切割靠「站点坐标 → shape 最近顶点」定锚点。两个站台若物理相距
   * ~20m 而站序相差若干站，最近顶点会落到**对侧站台那一趟**，几何上无法区分
   * （两趟都在容差内）⇒ 必须用站序判方向。
   *
   * 缺省 / 空数组 = 无站序数据（老缓存、轻轨线）⇒ 消费方**回落旧逻辑**，不得报错。
   */
  stations?: { code: string; seq: number }[];
}

/** `/api/route-shapes` 的响应（`shapes` 空 + `note: "no_shape"` ⇒ 该线无走向数据） */
export interface RouteShapesResp {
  code?: string;
  kind?: LineKind;
  color?: string | null;
  shapes?: LineShape[];
  /** 无走向数据时的标记 */
  note?: string;
  error?: string;
}

/**
 * `/api/station/eta` 的单条报站（只声明本页用到的字段）。
 *
 * ★ 关键：`platform` 是**站台码**。一个主码（如 `M95`）下有多个站台
 *   （`M95/2`、`M95/3`），所以**必须**用 `route + platform` 双条件匹配，
 *   只按 `route` 会取到隔壁站台的车（表现：报站少/多几站）。
 */
export interface StationEtaItem {
  route: string;
  dir: string;
  platform: string;
  dirLabel: string;
  /** 最近一辆车还有几站；null = 暂无在途车（轻轨恒 null） */
  stopsAway: number | null;
  /** 约几分钟到站；null = 无在途车 */
  etaMin: number | null;
  /** false = 该线查询失败/超时（区别于「查询成功但暂无车」） */
  ok: boolean;
  kind: LineKind;
}

/** `/api/station/eta` 响应（只声明本页用到的字段） */
export interface StationEtaResp {
  code?: string;
  items?: StationEtaItem[];
  error?: string;
}

/** `/api/stations` 的单站（只声明本页用到的字段 —— 换乘线路列） */
export interface StationBrief {
  /** 主码（已去平台后缀） */
  code: string;
  name: string;
  kind: LineKind;
  /** 该站停靠的线路码（去重） */
  lines?: string[];
}

export interface StationsResp {
  stations?: StationBrief[];
  error?: string;
}

/**
 * 站台码 → 主码（`T373/1` → `T373`）。
 * 与 `lib/recommend/segment-lookup.ts#mainCodeOf` **同口径**，此处内联一份是为了让
 * client 不必 import 含服务端依赖的模块。
 */
export function mainOf(code: string): string {
  return /^[A-Za-z]+\d+/.exec(code)?.[0] ?? code;
}

/**
 * 徽章文案：轻轨走统一口径 `lineNameOf()` —— 剥 `LRT-` 前缀 **并做简→繁转换**
 *
 * ★ 2026-11-06（D-1 缺陷修复）：原先是 `code.replace(/^LRT-/, "")`，只剥前缀不转字
 *   ⇒ `/line/LRT-氹仔线` 顶栏显示简体 `氹仔线`，而「全部线路」面板与 `RouteStack`
 *   都走 `lineNameOf` 显示繁体 `氹仔線` ⇒ **同一条线两种写法**，用户会以为是两条线。
 *   **不要再就地写 replace**，一律走本函数。
 */
export function chipLabelOf(code: string, kind: LineKind): string {
  return kind === "lrt" ? lineNameOf(code) : code;
}
