/**
 * 全澳导航 · 类型与数据结构（src/lib/nav/types.ts，v1.3.0 提案）
 *
 * ⚠️ 纯类型 / 常量模块：**不得 import 任何含 pg 的模块** —— 这些视图类型会传到客户端
 *    渲染（`RecommendCard`/`CardDetailClient` 复用）。服务端查询一律另置模块。
 *
 * 对应设计：docs/设计-全澳导航-v1-20260918.md §4；类图 docs/class-diagram.mermaid。
 * 复用：`RideLegView`/`WalkLegView`/`TransferView`/`CatchTier`/`SegmentLevel` 直接沿用
 *       `src/lib/recommend/*`，**不重写**。
 */
import type { RideSegment, TransferSegment } from "@/lib/recommend/types";
import type { RideLegView, WalkLegView, TransferView } from "@/lib/recommend/types";
import type { SegmentLevel } from "@/lib/recommend/segment-lookup";

// ─────────────────────────── 坐标点 ───────────────────────────

/** 导航端点种类：GPS 定位 / 搜索到的 POI / 站点 / 预设地点 */
export type NavPointKind = "gps" | "poi" | "station" | "place";

/**
 * 导航端点。
 * ★ 坐标系铁律：进入本系统后，`lng`/`lat` **一律 GCJ-02**。
 *   · 用户 GPS（WGS84）在**边界处**转 GCJ-02（用户侧不自己转 / 由定位层统一处理）；
 *   · 高德返回坐标**原样**使用（已是 GCJ-02）；
 *   · 我们库 WGS84 坐标须经 `wgs84ToGcj02()`。
 */
export interface NavPoint {
  kind: NavPointKind;
  /** 展示名（站名用繁体官方原文，见 §6.2） */
  label: string;
  /** 经度（GCJ-02） */
  lng: number;
  /** 纬度（GCJ-02） */
  lat: number;
  /** 我们库站码（kind="station" 时有） */
  code?: string;
  /** 高德 POI id（kind="poi" 时有） */
  poiId?: string;
  /** 行政区划码（澳门 = 820000） */
  adcode?: string;
}

// ─────────────────────────── POI 解析 ───────────────────────────

/** 搜索结果来源：本地别名库（0 配额）/ 高德 inputtips / 高德 place/text */
export type PoiSource = "local" | "amap-inputtips" | "amap-text";

/** 结果类型 */
/**
 * 搜索结果种类。
 *
 * ★ v3.6.0（AC-40）：**刻意不含 `"route"`** —— 线路结果走独立的
 *   `PoiSuggestResponse.routes`（元素类型是 `RouteSuggestion`，不是 `PoiSearchResult`）。
 *   理由：`PoiSearchResult.lng/lat` 是必填坐标，而线路**没有坐标**
 *   （库里 106 条 `target_kind='route'` 的 lng/lat 全为 null）；硬塞假坐标会让
 *   「一条线路被当成一个地理点」——正是「输入 25 就把 25 路当终点」那个老坑的另一种复现。
 *   ⇒ 本类型只描述**有坐标的**搜索结果。
 */
export type PoiKind = "station" | "lrt_station" | "poi" | "place";

/** 一条 POI 搜索结果（确认后即成为 transit 的 destination） */
export interface PoiSearchResult {
  source: PoiSource;
  /** 名称（本地命中给繁体原名；高德命中给高德原文） */
  name: string;
  address?: string;
  district?: string;
  adcode?: string;
  /** 经度（GCJ-02） */
  lng: number;
  /** 纬度（GCJ-02） */
  lat: number;
  kind: PoiKind;
  /**
   * ★ 【7①】我们库的**站码**（kind='station' 时 = 主码，如 `M1`；轻轨为 `LRT-*`）。
   * 用于「巴士站带编号」显示（`M1 關閘總站`）与类型徽章；高德结果一般为空。
   */
  code?: string;
  /**
   * 与用户当前位置的距离（米）；**未知时为 `null`**（inputtips 无 dist，见调研 §6 坑#8）。
   *
   * ★ 2026-11-13：由「不填」改为「显式 null」。原因有二：
   *   ① `undefined` 会被 `JSON.stringify` 丢掉键 ⇒ 同一个接口有时带 `distM`、有时不带，
   *      客户端与门禁只能靠「键不存在」猜，判断方式很容易写错（`"distM" in r` 会误判）；
   *   ② 缓存重算（`rescoreCachedRows`）需要在「没有位置」时把距离**清零**，
   *      显式 null 比 undefined 更能表达「这次确实算不出」，而不是「忘了赋值」。
   * 消费侧统一用 `typeof x.distM === "number"` 或 `x.distM != null` 判断。
   * 故此处**必填**（`number | null`，不允许省略）——「算不出距离」用 `null` 表达，
   * 让「键是否存在于 JSON」不再成为客户端要猜的事。
   */
  distM: number | null;
  /** 排序分（越大越靠前；本地命中普遍高于高德） */
  score: number;
}

/**
 * 线路建议（`/api/poi/suggest` 的 `routes[]`，v3.6.0 · AC-40/41 · S6）
 *
 * ── ⚠️⚠️ 为什么**不能**复用 `PoiSearchResult` ────────────────────────────
 *   `PoiSearchResult` 的 `lng` / `lat` 是**必填 number**（它代表"一个可以去的地点"）。
 *   而**线路不是地点** —— `poi_aliases` 里 106 条 `target_kind='route'` 的行
 *   **`lng`/`lat` 全部为 null**（实测）。硬塞进 `PoiSearchResult` 只有两条路：
 *     ① 给假坐标（骗下游：万一被当终点用，会把用户导到几内亚湾 / 某个默认点）；
 *     ② 把 `lng`/`lat` 改成可选（波及所有把搜索结果当目的地的调用点，风险极大）。
 *   ⇒ 定义**独立类型**，字段就是前端点线路、渲染徽章所需的全部信息。
 *
 * ── 与 `PoiKind` 的关系 ────────────────────────────────────────────────
 *   **不往 `PoiKind` 里加 `"route"`**：那样会让 `Record<PoiKind, string>`（如
 *   `TYPE_LABEL`）全部编译报错，而线路**从不进入 `results`/`pending`**，
 *   加进去只会制造"线路是一种 POI"的误解。这里的 `kind` 用 `bus | lrt`，
 *   与 `/api/route-stops`、`lib/line/line-shared.ts#LineKind` **同口径**，
 *   前端据此分「巴士线路 / 轻轨线路」两区（AC-40）。
 */
export interface RouteSuggestion {
  /** 线路码原文（`26` / `51A` / `LRT-氹仔线`）—— 前端跳 `/line/[code]` 时必须 `encodeURIComponent` */
  code: string;
  /** 线路显示名（繁体官方原文，**不做简繁转换**；巴士即线路码本身） */
  name: string;
  /** 载具种类（决定分区与徽章样式） */
  kind: "bus" | "lrt";
  /** 别名匹配分（越大越靠前，与 `results` 同一套打分） */
  score: number;
}

/** 本地别名库一行（`poi_aliases`） */
export interface AliasEntry {
  /** 归一化别名（已繁→简、去空白）—— 匹配键 */
  aliasNorm: string;
  /** 'station' | 'lrt_station' | 'route' | 'poi' | 'place' */
  targetKind: string;
  /** 站码 / 线路码 / 点位码 */
  targetCode?: string;
  /** 目标显示名（繁体官方原文） */
  nameTc: string;
  /** 经度（GCJ-02） */
  lng?: number;
  /** 纬度（GCJ-02） */
  lat?: number;
  /** 命中权重 */
  weight: number;
  /** 来源：'station'|'route'|'campus'|'border'|'lrt'|'pt'|'manual' */
  source: string;
}

// ─────────────────────────── 搜索建议响应（T02） ───────────────────────────

/**
 * 本地命中但**无坐标**的候选（线路名 / 轻轨网络 / 葡文地名 / 口语别名）。
 * 这些别名库里有、但没坐标 ⇒ 不能直接作 transit 端点；选中/回车时需由高德确认坐标。
 */
export interface PoiPendingMatch {
  /** 显示名（繁体官方原文） */
  name: string;
  /** 'station' | 'lrt_station' | 'route' | 'poi' | 'place' */
  targetKind: string;
  targetCode?: string;
  source: PoiSource;
  score: number;
}

/** 下拉区灰字提示的**语义键**（UI 据此渲染；文案常量见 `poi-search.ts`） */
export type PoiHint = "no_local_then_enter" | "amap_empty" | "amap_circuit" | "macau_only";

/**
 * 地区过滤的**单条剔除记录**（★ 2026-11-12，产品裁决「本应用只服务澳门」）。
 *
 * 存在的意义：严格过滤最怕「静默吞结果」。每条被剔除的条目都留一份可核对的凭据，
 * 一旦某条真澳门结果被误杀，在这里立刻可见，不必靠猜。
 */
export interface PoiFilterItem {
  name: string;
  /**
   * foreign = 明确非澳门（其他城市/地区）；unknown = 归属不明（无任何地理标识）；
   * suspect = **已保留**但名称与属地冲突（按 adcode 在澳门、名字却像外地），待人工确认。
   */
  verdict: "foreign" | "unknown" | "suspect";
  /** 判定依据（稳定码，门禁据此断言，不要随意改名） */
  reason: MacauReason;
  adcode?: string;
  district?: string;
}

/**
 * 地区过滤的**汇总报告**（`/api/poi/suggest` 的 `filtered` 字段）。
 * ⚠️ 纯**追加**字段：不改变 `results` / `pending` 的结构与顺序，旧调用方零影响。
 */
export interface PoiFilterReport {
  /** 参与判定的原始条目数（高德 place/text 与 inputtips 合计） */
  total: number;
  /** 判定为澳门、已保留 */
  kept: number;
  /** 明确非澳门，已剔除 */
  foreign: number;
  /** 归属不明（无 adcode、无行政区文字、名称也不带外地前缀）⇒ 已隐藏，待人工确认 */
  unknown: number;
  /** 无坐标被剔除（**与地区无关**，单列以免和「非澳门」混淆） */
  noCoord: number;
  /** 剔除样本（最多 {@link POI_FILTER_SAMPLE_MAX} 条，按原序） */
  samples: PoiFilterItem[];
  /**
   * **名称与属地冲突**的**已保留**条目（最多 {@link POI_FILTER_SAMPLE_MAX} 条）。
   *
   * 与 `samples` 的区别：`samples` 里的是**被剔除**的，这里是**留在结果里**的。
   * 为什么单独一张表：这类条目按 adcode 属澳门（不该删，删了就是丢真数据），
   * 但名称像外地（如「珠海海洋王国度假酒店」实测坐标在澳门半岛花王堂区）。
   * 产品若认为「名字带外市字样的都不该出现在澳门应用里」，据此表逐条拍板即可。
   */
  suspects: PoiFilterItem[];
}

/**
 * 澳门归属判定依据（稳定码）。四态收敛为三值：
 *   · `adcode_macau`   有 adcode 且 8200xx ⇒ 澳门
 *   · `text_macau`     无 adcode，但 district/cityname 含「澳」 ⇒ 澳门
 *   · `name_foreign`   名称以其他城市/运营主体开头 ⇒ 非澳门（高德 adcode 误标时唯一有效判据）
 *   · `adcode_foreign` 有 adcode 但非 8200xx ⇒ 非澳门
 *   · `text_foreign`   无 adcode，district/cityname 明确是外地 ⇒ 非澳门
 *   · `no_signal`      三者皆无 ⇒ **归属不明**
 */
export type MacauReason =
  | "adcode_macau"
  | "text_macau"
  | "name_foreign"
  | "adcode_foreign"
  | "text_foreign"
  | "no_signal"
  | "name_conflict";

/** 澳门归属判定的三分类结果（见 `amap/poi.ts#classifyMacau`） */
export interface MacauVerdict {
  /** macau = 保留 / foreign = 明确非澳门 / unknown = 归属不明（隐藏但记账） */
  verdict: "macau" | "foreign" | "unknown";
  reason: MacauReason;
}

/** 剔除样本上限（报告只用于核对，不用于重放；有界避免长响应） */
export const POI_FILTER_SAMPLE_MAX = 12;

/** `/api/poi/suggest` 响应（★ 两段式搜索：打字纯本地 / 回车可调高德） */
export interface PoiSuggestResponse {
  /** 请求模式：type=打字（纯本地，0 配额）/ enter=回车（可调高德） */
  mode: "type" | "enter";
  /** 有坐标的候选（本地 + 高德混排；本地优先 → 近者优先） */
  results: PoiSearchResult[];
  /** 本地命中但无坐标（选中需走高德确认坐标） */
  pending: PoiPendingMatch[];
  /** 灰字提示键（仅「本地无命中且输入 ≥2 字符」或「高德也无结果」时给；否则无） */
  hint?: PoiHint;
  /** 灰字提示的**落地文案**（设计 §2.A.6 原文；与 `hint` 一一对应） */
  hintText?: string;
  /** true = 搜索配额熔断中（高德兜底已停，仅本地可用） */
  amapCircuitOpen?: boolean;
  /** 本次消耗的搜索配额次数（回车命中缓存时为 0） */
  quotaConsumed?: number;
  /**
   * 线路建议（v3.6.0 · AC-40/41）：**独立分区**，不进 `results`。
   *
   * ── 为什么单独一个字段而不是混进 `results` ──────────────────────────────
   *   `results` 的语义是「可以去的目的地」，顺序与内容被多个调用点依赖（含高德合并、
   *   pending 去重）。把线路塞进去会破坏「本地优先 → 近者优先」的排序契约。
   *
   * ── 契约细节 ───────────────────────────────────────────────────────────
   *   · 最多 **3** 条，按 `score` 降序；
   *   · **无匹配时不给这个键**（不是空数组）—— 前端用 `?.length` 判断，天然满足
   *     「无结果就不渲染分区标题」；
   *   · `mode=type`（打字）与 `mode=enter`（回车）**都给**（AC-40 要求打字阶段可见）。
   */
  routes?: RouteSuggestion[];
  /**
   * ★ 2026-11-12：地区过滤报告（**仅当本次真的剔除了条目时下发**，否则不给这个键）。
   *
   * 产品要求「说明已过滤掉的非澳门信息数量或范围」⇒ 把剔除数量与样本随响应带回，
   * 让「过滤了什么」可被核对，而不是静默吞掉。`unknown`（归属不明）单列，
   * 便于人工确认是否存在被误杀的澳门地点。
   */
  filtered?: PoiFilterReport;
}

// ─────────────────────────── 站码映射 ───────────────────────────

/** 匹配方法 */
export type StationMatchMethod = "coord" | "name" | "both" | "manual" | "unmatched";
/** 置信度（high=坐标≤30m 且名称命中；medium=坐标≤60m 或名称命中；low=其余） */
export type StationConfidence = "high" | "medium" | "low";

/**
 * 高德站 ↔ 我们站码 的映射一行（`station_amap_map`）。
 * ★ R5：`amapName`（高德简体）与 `nameTc`（我们繁体）**两列并存**，不可合并。
 */
export interface StationAmapMap {
  /** 高德站 id（有则优先按 id 匹配） */
  amapStationId?: string;
  /** 高德站名（简体） */
  amapName: string;
  /** 高德坐标（GCJ-02） */
  amapLng: number;
  amapLat: number;
  /** 我们【主码】（已剥站台后缀）；未匹配时为空 */
  dsatStationMain?: string;
  /** 我们站名（繁体官方原文） */
  nameTc?: string;
  matchMethod: StationMatchMethod;
  /** 坐标最近邻距离（米） */
  matchDistM?: number;
  /** 名称（繁简归一后）是否命中 */
  nameMatch: boolean;
  confidence: StationConfidence;
}

// ─────────────────────────── 步行 ───────────────────────────

/**
 * 步行段来源（§C.1 来源标注）。
 *  · `amap`           —— 高德 transit 自带的步行几何（主路径）
 *  · `amap-cache`     —— 降级路径命中 `walk_cache`
 *  · `walk-times`     —— 降级路径回落实测 `walk_times`
 *  · `amap-transfer`  —— 换乘步行（轻轨相关）用高德换乘时间
 *  · `straight-estimate` —— 直线 × 1.5 估算（拿不到几何时）
 *  · `fallback`       —— 常数兜底
 */
export type WalkSource =
  | "amap"
  | "amap-cache"
  | "walk-times"
  | "amap-transfer"
  | "straight-estimate"
  | "fallback";

/** 步行信息（首末段 minutes = corrected_m ÷ 84；换乘段轻轨相关 = 高德时间） */
export interface WalkInfo {
  /** 常速基准分钟（tier 3 口径） */
  minutes: number;
  /** 路径距离（米，短距修正后） */
  distanceM?: number;
  /** 目的显示名（如「C653 金峰南岸」） */
  toLabel: string;
  source: WalkSource;
  /** true = 估算（UI 标「估算」） */
  estimated: boolean;
  /** 样本数（实测口径才有意义；高德几何为 0） */
  samples: number;
}

/** `model.ts` 接缝：把「高德/缓存步行」注入 `modelOption`（不新增签名） */
export interface WalkResolver {
  /** 起点 → 上车站 */
  out(stationMain: string): WalkInfo;
  /** 下车站 → 目的地 */
  in(stationMain: string): WalkInfo;
}

// ─────────────────────────── 高德方案骨架（R2/R3 核心） ───────────────────────────

/** 高德站（含 GCJ-02 坐标） */
export interface AmapStop {
  name: string;
  /** 经度（GCJ-02） */
  lng: number;
  /** 纬度（GCJ-02） */
  lat: number;
  /** ★ 高德站 id —— 映射表的**首选**桥接键（比站名稳，站名会改名） */
  id?: string;
}

/** 高德方案里的一段载具（+ 站码桥接结果） */
export interface AmapPlanLeg {
  kind: "bus" | "lrt";
  /** 高德线路名（用于：地铁→轻轨文案、穿梭巴士黑名单） */
  amapLineName: string;
  /** 高德线路 type（'普通公交线路' | '地铁线路'） */
  amapLineType: string;
  /** 高德上车站（原始，含 GCJ-02） */
  amapBoard: AmapStop;
  /** 高德下车站（原始） */
  amapAlight: AmapStop;
  /** 完整站序（高德 `via_stops`，含坐标） */
  amapViaStops: AmapStop[];
  /** 高德该段时长（秒）；映射失败时作兜底 */
  amapDurationSec: number;
  /** ★ 桥接结果：高德站 → 我们主码（可能部分失败） */
  mappedRoute: string | null;
  mappedBoard: string | null;
  mappedAlight: string | null;
  mappedHops: [string, string][] | null;
  /**
   * ★ v2.3.0（B2）：**同一段内其余并行线的原始高德线路名**（`buslines[1..]`）。
   *   仅保留**名字**、**不保留 polyline**（02 §6 坑#2：show_fields 含 polyline 会掉方案数）。
   *   由 `parsePlan` 从 `segments[].bus.buslines` 挂上；`bridgeLeg` 再经 `routeCodeOf` 映射成
   *   本库线码填入 `RideSegment.parallelRoutes`。
   */
  parallelNames?: string[];
  /**
   * ★ v2.3.0（B2）：**同一段内并行线的本库线码**（由 `bridgeLeg` 从 `parallelNames` 经
   *   `routeCodeOf` 映射、去重、剔除主干线自身后填入；映射不出则不填）。
   */
  parallelRoutes?: string[];
}

/** 方案内的换乘步行（相邻 leg 之间的高德 walking 段） */
export interface AmapPlanTransfer {
  /** 高德换乘步行时长（秒）—— 轻轨相关时采用 */
  amapDurationSec: number;
  /** 换乘步行距离（米）；缺失 = null */
  distanceM: number | null;
}

/** 首末步行（含直线与短距修正后距离） */
export interface AmapWalkSeed {
  /** 高德步行距离（米） */
  distanceM: number;
  /** 直线距离（米，球面） */
  straightM: number;
  /** 短距修正后距离（米）—— 写卡口径 */
  correctedM: number;
}

/**
 * 一条高德方案的骨架（解析产物，**尚未二次计算**）。
 * ⚠️ 本对象是「候选来源」与「我们重算」之间的接缝：它保留高德原值（对照基准）
 *    与桥接结果（站码映射）。
 */
export interface AmapPlanSeed {
  /** 高德返回序（对照用） */
  index: number;
  /** 高德原始总时长（秒）—— 对照基准，**不用于排序** */
  amapTotalSec: number;
  /** 高德票价（元/MOP）；未知 = null */
  amapTransferFee: number | null;
  walkOut: AmapWalkSeed;
  walkIn: AmapWalkSeed;
  legs: AmapPlanLeg[];
  transfers: AmapPlanTransfer[];
}

/** 二次计算的来源/可信度凭据（差异告警用，§C.7） */
export interface RecomputeProvenance {
  /** 用我们 `lookupHop` 重算的乘车段数 */
  usedOurDataLegs: number;
  /** 映射失败、回落高德时长的乘车段数 */
  usedAmapFallbackLegs: number;
  /** 各乘车段逐跳命中层级（L1~L6） */
  hopLevels: SegmentLevel[][];
  /** |T_ours − T_amap| / T_amap */
  deviationRatio: number;
  /** true = 整方案存疑（差异过大 / 多段存疑） */
  suspect: boolean;
}

/**
 * 二次计算结果（逐方案）。
 * `totalMin` = 我们算出的门到门总时长（**排序主键**，§C.6）。
 */
export interface RecomputeResult {
  seed: AmapPlanSeed;
  /** 我们算出的门到门总时长（分钟） */
  totalMin: number;
  rides: RideLegView[];
  walkOut: WalkLegView;
  walkIn: WalkLegView;
  transfers: TransferView[];
  provenance: RecomputeProvenance;
}

// ─────────────────────────── 本地方案 / 结果页（R3 补漏与降级共用） ───────────────────────────

/** 本地图枚举产出的候选方案（R1 保留；R3 起为「补漏 + 降级」共用） */
export interface NavCandidate {
  id: string;
  from: NavPoint;
  to: NavPoint;
  /** 载具段（≥1；复用旧功能类型） */
  segments: RideSegment[];
  /** 换乘（长度 = segments.length − 1） */
  transfers: TransferSegment[];
  /** 是否含跨境段（卡片须标「不含通关」） */
  crossBorder: boolean;
  /** 展示键（去重用） */
  key: string;
}

/** 结果页内一条方案的分级标注 */
export interface Provenance {
  /** walkOut 来源标注（如「高德路徑」/「估算」） */
  walkOut: string;
  /** walkIn 来源标注 */
  walkIn: string;
  /** 各乘车段逐跳层级 */
  rideLevels: number[][];
  /** 是否含估算段 */
  hasEstimate: boolean;
}

/** 结果页一条方案（与 `RecommendCard` 结构兼容 → 渲染复用） */
export interface NavPlan {
  id: string;
  /** 排序位次（1 起） */
  rank: number;
  /** 我们算出的门到门总时长（分钟） */
  totalMin: number;
  /** 预计到达时刻（ms） */
  arriveAt: number;
  walkOut: WalkLegView;
  walkIn: WalkLegView;
  rides: RideLegView[];
  transfers: TransferView[];
  crossBorder: boolean;
  provenance: Provenance;
  /** 来源：'amap'（高德）/ 'local'（本地补漏）—— 卡片用中性文案，不暴露实现 */
  origin: "amap" | "local";
}

/** 空状态原因（§11.4；仅 0 条时呈现） */
export type NavEmptyReason =
  | "no_candidate" // 找不到可用路线
  | "no_live" // 无在途车 / 已收班
  | "too_close" // 距离过近 → 建议步行
  | "out_of_scope" // 目的地在澳门服务范围之外（★ 2026-11-13 · P6）
  | "no_cover" // 附近无站点（郊区）
  | "amap_unavailable"; // 高德不可用（降级仍无结果）

/** 导航结果（`/api/nav` 返回） */
export interface NavResult {
  plans: NavPlan[];
  /** true = 走高德降级路径（本地推算），UI 须提示「本地推算」 */
  degraded: boolean;
  /** plans 为空时的原因 */
  emptyReason?: NavEmptyReason;
}

export type {
  RideLegView,
  WalkLegView,
  TransferView,
  RideSegment,
  TransferSegment,
  SegmentLevel,
};
