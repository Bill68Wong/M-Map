/**
 * 两段式 POI 搜索（src/lib/nav/poi-search.ts，v1.3.0 · T02）
 *
 * ── 交互口径（设计 §2.A.6 · ★ 搜索优化 2026-09-21 修订）─────────────────
 *   · **打字阶段 `suggestLocal()`** —— **只查本地别名库**（`alias-resolve`），
 *     **0 高德配额**、秒回；**绝不发任何高德请求** ✗。
 *     ★ 候选**只保留巴士站 / 轻轨站**（`station` / `lrt_station`）——
 *       线路名、地点（place）、泛 POI 一律不进下拉（理由见 `suggestLocal` 内注释）。
 *   · **点「搜索」/回车阶段 `searchAmap()`** —— **无条件**调高德
 *     （`place/text` 正式搜索，必要时 `inputtips` 兜底）——这是**唯一**消耗搜索配额
 *     （5,000/月，静默超限）的时机。
 *     ★ 2026-09-21 修订：旧实现「本地已有带坐标命中就短路、不调高德」⇒
 *       用户点搜索常表现为**无反应**（输入与站点名相同/部分重合时必然如此）。
 *       现已改为**总是联网**，与本地结果合并排序。
 *   ⇒ `suggest()` 按 `mode` 分派：`type` 纯本地（0 配额）/ `enter` **总是** 本地 + 高德合并。
 *
 * ── 已知取舍（**不是 bug**）─────────────────────────────────────────────
 *   **打字时看不到「新地名」的提示** —— 逐字阶段不联网。用户输入本地库没有的新地名时，
 *   下拉区不会有候选，**直到点「搜索」**才去高德搜（§2.A.6）。
 *   本地未命中且输入 ≥2 字符时，下拉区给一行**灰字**提示（见 `HINT_*` 常量）。
 *
 * ── adcode 过滤 + 本地排序（★ 必做）──────────────────────────────────
 *   高德 `city` 参数只是「倾向」不是硬限定（实测输 `gongbei` 会返回珠海）⇒ 必须**本地按
 *   adcode（澳门=820000）过滤**；`inputtips` **无 `dist` 字段** ⇒ 排序由我们本地算
 *   haversine 距离（复用 `poi.ts` 的转换器，已内建过滤 + 近者优先）。
 *   ★ 2026-11-12（产品裁决「本应用只服务澳门」）：`citylimit=true` **实测拦不住邻市**
 *     （搜「珠海长隆」仍回 adcode=440402 的珠海条目，见 `poi.ts#classifyMacau` 注释），
 *     且高德会把个别珠海 POI 的 adcode 误标成澳门 ⇒ 准入判据统一收敛到 `classifyMacau`
 *     一处（名称前缀 / adcode / 行政区文字 / 无证据 **三分类**），两道闸（`toResults` + `filterMacau`）
 *     共用，任何一环都不允许再写「无 adcode 就放行」的兜底。
 *
 * ── 过滤记账（★ 2026-11-12「剔除要可核对」）─────────────────────────────
 *   严格过滤最大的风险是**静默吞结果**：某条真澳门地点被误判，用户只看到「搜不到」。
 *   故 `searchAmap` 恒返回 `PoiFilterReport`（`total/kept/foreign/unknown/noCoord` + 剔除样本），
 *   `suggest()` 在**有剔除时**把它挂到响应 `filtered` 键上（无剔除不下发，原有形状不变）。
 *   三个用途：① 生产日志一眼看出「搜不到」是没给还是被拦；② `unknown`（归属不明）留给人工确认；
 *   ③ 产品侧可量化「这个应用到底挡掉了多少非澳门结果」。
 *
 * ── 缓存 ──────────────────────────────────────────────────────────────
 *   回车命中**进程内 TTL 缓存**（10 分钟）→ 热门地名重复回车**零配额**。
 *   ⚠️ 这是**每实例**缓存（Serverless 跨实例不共享），是最轻量的闸门；若命中率不够，
 *   可升级为 `transit_cache` 式表缓存（工程可自决，见设计 §2.A 的「Data Cache」）。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §2.A / §2.A.6 / §6.2；调研 §6 坑#8/9。
 */
import {
  ADCODE_MACAU,
  classifyMacau,
  dirProxBonus,
  hasFilterReport,
  hasFilteredItems,
  inputtips,
  mergePoiFilterStats,
  newPoiFilterStats,
  placeText,
  poisToResults,
  tipsToResults,
  type PoiCallHook,
} from "@/lib/amap/poi";
import { haversineM, type LatLng } from "@/lib/amap/coord";
import type {
  PoiFilterReport,
  PoiPendingMatch,
  PoiSearchResult,
  PoiSuggestResponse,
  PoiSource,
  RouteSuggestion,
} from "@/lib/nav/types";
import { normalizeQuery } from "@/lib/shared/normalize";
import { aliasToResult, resolveAliases } from "./alias-resolve";
import { circuitState, recordSearchCall } from "./quota";

/**
 * 本地未命中（且输入 ≥2 字符）时的灰字提示。
 * ★ 文案 = **简体**（产品总原则：界面文案一律简体 · 站名/线路名一律繁体）。
 * ★ 【7②】v2.0.1：主入口已从「回车」改为**输入框右侧的搜索按钮** ⇒ 提示同步改为「点『搜索』」。
 */
export const HINT_NO_LOCAL_ENTER = "没有本地结果 · 点「搜索」查找网上的新地点";
/**
 * 高德也无结果时的行内提示（简体；同产品总原则）
 * ★ 2026-11-12：所有结果都因**非澳门**被剔时，不说「换个说法」——要说清**为什么**没有结果，
 *   否则用户只会反复换词试。本应用只服务澳门，这是产品边界，不是搜索故障。
 */
export const HINT_AMAP_EMPTY = "找不到这个地点，试试换个说法";
/** 结果全部落在澳门以外（或无法证明在澳门）时的行内提示 */
export const HINT_MACAU_ONLY = "该地点不在澳门范围内 · 本应用只提供澳门地点";
/**
 * ★ 搜索优化（2026-09-21）：**搜索配额熔断中**（高德兜底已停）的行内提示。
 * 为什么必须有它：熔断时点「搜索」拿不到任何网上结果，若不告知，用户只会觉得「搜索坏了」。
 */
export const HINT_AMAP_CIRCUIT = "在线搜索暂时不可用（本月配额已满）· 仍可搜本地站名";

export interface SuggestOptions {
  /** 用户当前位置（GCJ-02）——用于近者优先排序 */
  userPos?: LatLng;
  /** 最多返回条数 */
  limit?: number;
}

export interface LocalSuggest {
  /** 本地命中且**有坐标**（可直接作 destination） */
  results: PoiSearchResult[];
  /** 本地命中但**无坐标**（选中需走高德确认） */
  pending: PoiPendingMatch[];
  /**
   * 线路建议（v3.6.0 · AC-40/41）—— **独立分区**，与 `results` / `pending` 互不干扰。
   * 最多 3 条，按 score 降序；无匹配时为空数组（由 `suggest()` 决定是否下发该键）。
   */
  routes: RouteSuggestion[];
}

// ─────────────────────────── 进程内 TTL 缓存 ───────────────────────────

const CACHE_TTL_MS = 10 * 60_000;
/**
 * ★ 2026-11-12（P3）：**上游明确答复 0 条**时的短 TTL。
 *
 * 旧逻辑 `if (results.length) cacheSet(...)` 让空结果进不了缓存 ⇒ 同一个搜不到的词，
 * 每按一次回车都要重新消耗 `place/text` + `inputtips` 两次配额（实测 `quotaConsumed` 恒为 2）。
 * 但空结果也不能按 10 分钟缓存：新开的店 / 刚录入的 POI 会被一个空结果钉住太久。
 * ⇒ 取 60s：足够吸收「连打几次同一个词」的重复开销，又不至于让新数据等太久。
 *
 * ⚠️ 只有**上游成功且确实是 0 条**才写。失败 / 超时 / 熔断一律不写 ——
 * 否则一次网络抖动就会把「假空」缓存住，用户会真的以为这个地点不存在。
 */
const CACHE_TTL_EMPTY_MS = 60_000;
const CACHE_MAX = 300;
/**
 * ★ 2026-11-13（P2）：缓存条目**不再直接存打分后的结果**。
 *
 * 旧实现把 `PoiSearchResult[]` 整个存下来，而其中的 `distM` / `score` 是按**下单那一刻的
 * 用户位置**预算好的 ⇒ 在关闸搜「议事亭前地」得到 2601m，走到氹仔（真实 5706m）再搜同一个词，
 * 命中缓存后仍然显示 2601m，排序也是按关闸的位置排的。这就是「跨位置串味」。
 *
 * 现改为：存**裸 POI**（名字/坐标/类别等位置无关字段）+ `relBase`（位置无关分）。
 * 命中时按当前位置重算 `distM` 与 `score`（见 `rescoreCachedRows`）。
 * 代价是每次命中多一次 haversine 与排序，量级可忽略。
 *
 * `ttl` 逐条目存放：正常结果 10 分钟，空结果只有 60s，两者共用同一张表与淘汰策略。
 */
export interface CachedPoi {
  /** 裸 POI：除 distM / score 外的字段都与位置无关 */
  poi: PoiSearchResult;
  /** 位置无关分 = score - dirProxBonus(distM)；重算时再加当前距离加成 */
  relBase: number;
}

const amapCache = new Map<
  string,
  { at: number; ttl: number; rows: CachedPoi[]; report: PoiFilterReport }
>();

/** 写入缓存前把「打分结果」拆成「位置无关部分」 */
export function toCachedRows(results: PoiSearchResult[]): CachedPoi[] {
  return results.map((poi) => ({
    poi,
    // `toResults` 的 score = 档位 + 类别 + dirProxBonus(distM) ⇒ 减去距离项即得位置无关分。
    // 用存下来的（已取整的）distM 反推，误差 ≤0.01 分，不影响排序。
    relBase: poi.score - dirProxBonus(poi.distM),
  }));
}

/**
 * 命中缓存后按**当前**用户位置重算距离与分数。
 *
 * @param userPos 当前位置；缺省时 `distM` 一律置空 —— 绝不能沿用它处算出来的旧距离，
 *                那正是本项要修的缺陷。
 */
export function rescoreCachedRows(rows: CachedPoi[], userPos?: LatLng): PoiSearchResult[] {
  const out = rows.map(({ poi, relBase }) => {
    const distM = userPos
      ? Math.round(haversineM(userPos, { lng: poi.lng, lat: poi.lat }))
      : undefined;
    return { ...poi, distM, score: relBase + dirProxBonus(distM) };
  });
  // 与 `searchAmap` 首次直连时的排序口径一致（同分保持缓存原序，sort 稳定）
  out.sort((a, b) => b.score - a.score);
  return out;
}

function cacheGet(key: string): { rows: CachedPoi[]; report: PoiFilterReport } | null {
  const e = amapCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > e.ttl) {
    amapCache.delete(key);
    return null;
  }
  // 形态不符（本次改动前写入的旧条目，或将来字段再变）⇒ 当作未命中丢弃。
  // 读缓存这段不在 try 里，一旦 `e.rows` 为 undefined 会直接冒到 API 变成 500，
  // 为一条过时缓存把整个搜索打挂不值得。
  if (!Array.isArray(e.rows)) {
    amapCache.delete(key);
    return null;
  }
  return { rows: e.rows, report: e.report };
}
function cacheSet(
  key: string,
  rows: CachedPoi[],
  report: PoiFilterReport,
  ttl = CACHE_TTL_MS,
): void {
  if (amapCache.size >= CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of amapCache) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) amapCache.delete(oldestKey);
  }
  amapCache.set(key, { at: Date.now(), ttl, rows, report });
}

// ─────────────────────────── 第一段：本地（0 配额） ───────────────────────────

/** 站码主码归一（剥站台后缀：M1/2 → M1）——用于搜索结果去重 */
function mainCodeOf(code: string): string {
  return /^[A-Za-z]+\d+/.exec(code)?.[0] ?? code;
}

/** 打字阶段：只查本地别名库。**不发高德请求**。 */
export async function suggestLocal(query: string, opts: SuggestOptions = {}): Promise<LocalSuggest> {
  let matches: Awaited<ReturnType<typeof resolveAliases>> = [];
  try {
    matches = await resolveAliases(query, { userPos: opts.userPos, limit: opts.limit ?? 12 });
  } catch {
    return { results: [], pending: [], routes: [] }; // 本地库不可用 → 退化为「未命中」（不抛错）
  }
  const results: PoiSearchResult[] = [];
  const pending: PoiPendingMatch[] = [];
  /**
   * 线路建议（v3.6.0 · AC-40/41）。
   *
   * ★ 历史：2026-09-21 的「搜索优化」把 `route` 匹配**整条丢弃**（见下方 `continue` 的理由）；
   *   v3.6.0 起改为**收集到独立数组** —— 它们仍然**不进 `results`**（那个契约不能动，
   *   否则「输入 25 就把 25 路巴士当终点」的老问题会回来），但可以在搜索结果里
   *   以**独立分区**的形式让用户点进「线路全景页」（AC-41）。
   *   ⇒ 语义从「丢弃」变成「分流」：`results` 仍只装目的地，线路走 `routes`。
   */
  const routes: RouteSuggestion[] = [];
  const seenRoute = new Set<string>();
  /** 线路分区最多几条（AC-40：3 条，再多会盖住真正的地点结果） */
  const MAX_ROUTES = 3;
  const seen = new Set<string>();
  // ★ 去重：同站多站台（M1/2·M1/3·M1/4…）在 UI 里应合成一行 ⇒ 按【主码】去重（保留得分最高者，
  //   因 matches 已按 score 降序，先到者即最优）；place/poi 按显示名去重。
  const dedupKey = (m: { targetKind: string; targetCode: string; nameTc: string }): string =>
    m.targetKind === "station" || m.targetKind === "lrt_station"
      ? `${m.targetKind}|${mainCodeOf(m.targetCode)}`
      : `${m.targetKind}|${m.nameTc}`;
  // matches 已按 score 降序 ⇒ 先到者即分数最高、也是 `code` 最该保留的那个
  for (const m of matches) {
    // ★★ v3.6.0：`route` 不再丢弃，改走独立分区（见 `routes` 的注释）。
    //    注意**先收集再 continue**：`routes` 不受下方「只有站点进下拉」的约束。
    if (m.targetKind === "route") {
      const code = (m.targetCode || "").trim();
      if (!code || seenRoute.has(code)) continue;
      if (routes.length >= MAX_ROUTES) continue; // 已满，只是不再追加（不 break：让后续站点匹配继续）
      seenRoute.add(code);
      routes.push({
        code,
        name: m.nameTc || code,
        // 与 `/api/route-stops`、`line-shared.ts#LineKind` 同口径
        kind: code.startsWith("LRT-") ? "lrt" : "bus",
        score: m.score,
      });
      continue;
    }
    // ★ 搜索优化（2026-09-21，产品口径）：下拉候选**只允许巴士站 / 轻轨站** ——
    //   线路名（`route`，上方已分流到 routes）、已知地点（`place`，如校内部位/口岸）、
    //   泛 POI（`poi`）**一律不进下拉**。
    //   理由：
    //     ① 线路名不是「想去的地点」，且造成「输入 25 就返回 25 路巴士」的困惑（产品实测）
    //        ⇒ 故只进 `routes` 分区、绝不进 `results`（否则会变成"把 25 路当终点"）；
    //     ② 泛 POI 会带来**同名歧义** —— 实测「大三巴」会命中媽閣站旁 445m 的**同名餐厅**
    //        （「大三巴美食」）：终点被带到离大三巴牌坊 1.5km 处，做出「媽閣站下车步行数分钟」
    //        的假方案 ⇒ 用户在到达前 1.5km 就以为快到了 ✗；
    //     ③ 非站点目的地（大学 / 口岸 / 景区…）交给**高德**：用户点「搜索」时联网返回。
    if (m.targetKind !== "station" && m.targetKind !== "lrt_station") continue;
    const dk = dedupKey(m);
    if (seen.has(dk)) continue;
    const r = aliasToResult(m, { userPos: opts.userPos });
    if (r) {
      seen.add(dk);
      results.push(r);
    } else {
      seen.add(dk);
      pending.push({
        name: m.nameTc,
        targetKind: m.targetKind,
        targetCode: m.targetCode || undefined,
        source: "local",
        score: m.score,
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  // routes 天然有序（matches 已按 score 降序、先到者先 push）⇒ 无需再排
  return { results, pending, routes };
}

// ─────────────────────────── 第二段：高德（消耗配额） ───────────────────────────

/**
 * 严格的澳门过滤 —— **第二道闸**（合并前再兜一次）。
 *
 * 判据已收敛到 `classifyMacau` 一处（`amap/poi.ts`），与 `toResults` 同源，避免「两处各写一遍」
 * 再次漂移。三分类：`macau` 保留 / `foreign` 明确非澳门 / `unknown` 归属不明 ⇒ 后两者一律剔除。
 * ★ 2026-11-12 把 `unknown` 由「保留」翻转为「剔除」，实测依据见 `classifyMacau` 注释
 *   （288 条澳门本地结果 100% 带 adcode，而无 adcode 的样本恰是 `珠机城轨` 这类非澳门裸条目）。
 *
 * ⚠️ 本函数是**幂等**的：`toResults` 已按同一判据筛过一遍，这里只会再剔 0 条。
 *   因此**计数只在 `toResults` 的 `stats` 出口做**，此处不记账 —— 否则同一批条目会被数两遍，
 *   报告里的「过滤掉多少条」会翻倍失真。
 *
 * ⚠️ 只用于**高德结果**。本地库（`suggestLocal`）是 DSAT / 轻轨自有站点，本就不带 adcode，
 * **绝不能**过这道闸，否则全被误杀。
 */
export function filterMacau(list: PoiSearchResult[]): PoiSearchResult[] {
  return list.filter((r) => classifyMacau(r).verdict === "macau");
}

export interface AmapSuggest {
  results: PoiSearchResult[];
  /** true = 配额熔断中（未发请求） */
  circuitOpen: boolean;
  /** 本次实际发起的搜索调用数（0 = 命中缓存 / 熔断） */
  quotaConsumed: number;
  /**
   * ★ 2026-11-12：本次地区过滤的记账（`total/kept/foreign/unknown/noCoord` + 剔除样本）。
   * 恒定存在（无剔除时各项为 0），便于调用方判断「是搜不到，还是被过滤掉了」。
   */
  filtered: PoiFilterReport;
}

/**
 * 回车阶段：高德兜底搜索。
 * 顺序：① `place/text`（正式、容错强）→ ② 若 0 结果再 `inputtips`（提示型兜底）。
 * 两条路径都先过 `circuitState()`（熔断**同时停**二者）与跨实例令牌桶（在 `poi.ts` 内）。
 * 失败/熔断**不抛错**，收敛为空结果。
 */
export async function searchAmap(query: string, opts: SuggestOptions = {}): Promise<AmapSuggest> {
  const key = normalizeQuery(query);
  const cached = cacheGet(key);
  // ★ 2026-11-13（P2）：命中缓存**必须按当前位置重算**距离与排序，不能直接返回缓存里的 distM。
  if (cached) {
    return {
      results: rescoreCachedRows(cached.rows, opts.userPos),
      circuitOpen: false,
      quotaConsumed: 0,
      filtered: cached.report,
    };
  }

  const st = await circuitState();
  if (st.open) return { results: [], circuitOpen: true, quotaConsumed: 0, filtered: newPoiFilterStats() };

  let quota = 0;
  const onCall: PoiCallHook = (api, ok, infocode, latencyMs) => {
    quota++;
    void recordSearchCall(api, ok, infocode, latencyMs);
  };

  // ★ 搜索优化（2026-09-21）：本函数契约是「失败 / 熔断**不抛错**，收敛为空结果」。
  //   实测事故：限速组件在「生产库被置只读」时抛错（见 `rate-limit.ts` 的长注释），
  //   异常冒到 API 层后，用户看到的是**误导性**的「找不到这个地点」。
  //   此处兜住所有底层异常 ⇒ 至少不会伪装成「搜不到」。
  let results: PoiSearchResult[] = [];
  // ★ 2026-11-12（P3）：上游是否**明确答复过**（`ok:true`，哪怕 0 条）。
  //   只有它为 true 才允许把空结果写进缓存 —— 用来区分「真的没有这个地点」与「这次没问出来」。
  let upstreamOk = false;
  // ★ 2026-11-12：地区过滤记账（两路合并到同一个报告 —— 用户关心的是「这次搜索一共剔了几条」，
  //   不是「place/text 剔了几条、inputtips 又剔了几条」）。
  const report = newPoiFilterStats();
  try {
    // ① 正式搜索
    const text = await placeText(query, {
      city: ADCODE_MACAU,
      citylimit: true,
      offset: 20,
      onCall,
    });
    upstreamOk = text.ok;
    results = text.ok
      ? poisToResults(text.items, {
          source: "amap-text",
          userPos: opts.userPos,
          macauOnly: true,
          query,
          stats: report,
        })
      : [];

    // ② 无结果时用 inputtips 补一次（设计：「必要时 inputtips」）
    if (!results.length) {
      const st2 = await circuitState();
      if (!st2.open) {
        const tips = await inputtips(query, {
          city: ADCODE_MACAU,
          citylimit: true,
          location: opts.userPos,
          onCall,
        });
        if (tips.ok) {
          // 只要有一条路成功，就算「问过了」；空结果可以缓存，失败的结果不行
          upstreamOk = true;
          const tipStats = newPoiFilterStats();
          results = tipsToResults(tips.items, {
            source: "amap-inputtips",
            userPos: opts.userPos,
            macauOnly: true,
            query,
            stats: tipStats,
          });
          mergePoiFilterStats(report, tipStats);
        }
      }
    }
  } catch (e) {
    console.warn("[poi-search] searchAmap 底层异常（已收敛为空结果）：", (e as Error).message);
    results = [];
    // 异常 ⇒ 这次是「没问出来」，不是「确实没有」，绝不允许缓存
    upstreamOk = false;
  }

  results = filterMacau(results).sort((a, b) => b.score - a.score);
  // ★ 可观测：把「本次搜索剔掉了哪些非澳门条目」打进日志 —— 生产上排查「某地名搜不到」
  //   时，一眼能看出是「高德没给」还是「被地区闸拦了」，不必靠复现猜。
  if (hasFilterReport(report)) {
    const names = report.samples.map((s) => `${s.name}(${s.reason})`).join("、");
    const sus = report.suspects.map((s) => s.name).join("、");
    console.log(
      `[poi-search] 地区过滤 q="${query}" 非澳门 ${report.foreign} 条 / 归属不明 ${report.unknown} 条` +
        `（原始 ${report.total} 条，保留 ${report.kept} 条）${names ? `：${names}` : ""}` +
        `${sus ? ` ｜名称待确认：${sus}` : ""}`,
    );
  }
  // ★ 2026-11-12（P3）：空结果也入缓存，但只用短 TTL；上游没答复成功（失败/超时/熔断）则不入。
  // ★ 2026-11-13（P2）：写入的是「位置无关形态」，命中后按调用方当前位置重算。
  // ⚠️ `relBase = score - dirProxBonus(distM)` 只在 `toResults` 的 **query 分支**成立；
  //   空查询走的是旧口径（`baseScore + (1000 - dist/10)`），逆推出来是错的（实测偏 24 分）。
  //   当前唯一入口 `suggest` 的上游路由已拦掉空 `q`，此处纯防御：真有人放开，宁可不缓存。
  //   注意分支顺序：有结果但不可逆时**什么都不写**，绝不能再落到「写空数组」那一支。
  if (!results.length) {
    if (upstreamOk) cacheSet(key, [], report, CACHE_TTL_EMPTY_MS);
  } else if (query.length > 0) {
    cacheSet(key, toCachedRows(results), report);
  }
  return { results, circuitOpen: false, quotaConsumed: quota, filtered: report };
}

// ─────────────────────────── 编排（UI 只调这一个） ───────────────────────────

/**
 * 统一的搜索入口。
 *
 * @param query 用户输入
 * @param opts.mode `type` = 打字（纯本地，0 配额）/ `enter` = 回车（本地优先 + 高德兜底）
 * @param opts.forceAmap ★ 修复包 v2.2.1-B7：**强制走高德**（跳过「本地已有带坐标命中就短路」）——
 *   供「点搜索确认」那条 pending 行使用：它的语义是「我要这条本地命中对应的**真实坐标**」，
 *   而只要本地还有别的带坐标命中，旧逻辑就永不调高德 ⇒ 点击表现为**无任何反应**（FIX-10 根因）。
 *   ⚠️ 仅在 `mode="enter"` 且调用方显式要求时生效（打字阶段绝不联网）。
 */
export async function suggest(
  query: string,
  opts: { mode: "type" | "enter"; forceAmap?: boolean } & SuggestOptions,
): Promise<PoiSuggestResponse> {
  const trimmed = (query ?? "").trim();
  const local = await suggestLocal(trimmed, opts);
  const resp: PoiSuggestResponse = {
    mode: opts.mode,
    results: local.results,
    pending: local.pending,
    quotaConsumed: 0,
  };
  // ★ v3.6.0（AC-40）：线路分区在 **type / enter 两种模式下都下发**（打字阶段就要能看见）。
  //   无匹配时**不给这个键**（不是空数组）—— 前端按 `?.length` 判断，无键天然不渲染分区标题。
  //   线路**不参与**下方高德合并与 pending 去重：它不是目的地，混进 `results` 会破坏排序契约
  //   并把"输入 25"重新变成"把 25 路当终点"。⚠️ 高德可能出现同名"XX路"POI，那是**地点**，
  //   留在 `results` 里是对的（用户点它当终点），与线路分区并存不冲突。
  if (local.routes.length) resp.routes = local.routes;

  if (opts.mode === "type") {
    // 本地完全无命中（有坐标/无坐标都没有）且输入 ≥2 字符 → 灰字提示「按搜索」
    if (!local.results.length && !local.pending.length && trimmed.length >= 2) {
      resp.hint = "no_local_then_enter";
      resp.hintText = HINT_NO_LOCAL_ENTER;
    }
    return resp;
  }

  // ── 点「搜索」/回车阶段：★ **总是**去高德（搜索优化 2026-09-21）──────────
  //   旧逻辑有两条同源缺陷，都会让用户「点了搜索却像没反应」：
  //     ① `if (local.results.length) return resp;` —— 本地只要有一条带坐标命中，
  //        就**永不调高德**，用户点了搜索也拿不到网上的新结果（需求 ②）；
  //     ② 输入与站点名**相同或部分重合**时本地必然命中 ⇒ 同样短路，
  //        表现为「联网搜索不可用」（需求 ③）。
  //   现改为：enter 阶段**无条件**走一次高德，与本地结果合并后按分数排序。
  //   ⚠️ 打字阶段（`mode="type"`）仍严格 0 配额 —— 配额只在用户**显式点搜索**时消耗（设计 §2.A.6）。
  //   `opts.forceAmap` 入参保留（向后兼容：其语义已被「enter 总是联网」吸收）。
  void opts.forceAmap;
  const amap = await searchAmap(trimmed, opts);
  resp.amapCircuitOpen = amap.circuitOpen;
  resp.quotaConsumed = amap.quotaConsumed;

  if (amap.results.length) {
    resp.results = [...local.results, ...amap.results].sort((a, b) => b.score - a.score);
    // 同名 pending 行已由高德给出坐标 → 移出 pending，避免下拉里再出现一行「点搜索确认」
    resp.pending = local.pending.filter((p) => !amap.results.some((r) => r.name === p.name));
  } else if (!local.results.length) {
    // ★ 2026-11-12：高德**空**时要分清三种原因 —— 别再把「被地区闸拦住」说成「搜不到」，
    //   前者换多少种说法都搜不到（产品边界），后者才是用户输入的问题。
    if (amap.circuitOpen) {
      resp.hint = "amap_circuit";
      resp.hintText = HINT_AMAP_CIRCUIT;
    } else if (hasFilteredItems(amap.filtered)) {
      resp.hint = "macau_only";
      resp.hintText = HINT_MACAU_ONLY;
    } else {
      // 高德真的什么都没给（且本地也空）⇒ 才报「找不到」；本地有命中时静默保留本地结果
      resp.hint = "amap_empty";
      resp.hintText = HINT_AMAP_EMPTY;
    }
  } else if (amap.circuitOpen) {
    // 本地有结果、但高德被熔断 ⇒ 明说「在线搜索暂不可用」，避免用户以为搜索坏了
    resp.hint = "amap_circuit";
    resp.hintText = HINT_AMAP_CIRCUIT;
  }
  // ★ 2026-11-12：过滤报告**仅在有剔除时**下发（无剔除就不给这个键，原有响应形状不变）。
  //   产品要求「说明已过滤掉的非澳门信息数量或范围」⇒ 让剔除可核对；`unknown`（归属不明）
  //   与 `foreign`（明确非澳门）分开呈现，前者是留给人工确认的观察点。
  if (hasFilterReport(amap.filtered)) resp.filtered = amap.filtered;
  return resp;
}

/** 供诊断/测试：清空进程内缓存 */
export function _clearCache(): void {
  amapCache.clear();
}

/** 来源标签（UI 徽章用）：高德结果标「來自高德」 */
export function isAmapSource(source: PoiSource): boolean {
  return source === "amap-text" || source === "amap-inputtips";
}
