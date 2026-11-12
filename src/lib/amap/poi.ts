/**
 * 高德 · POI 搜索客户端（src/lib/amap/poi.ts，v1.3.0 提案）
 *
 * ── 定位 ──────────────────────────────────────────────────────────────
 *   本地别名库 `poi_aliases` **未命中**时的高德兜底。提供两个端点：
 *     · `inputtips`（`/v3/assistant/inputtips`）—— 提示型，**错别字/繁简/拼音容错强**，
 *        但不支持分页、**无 `dist` 字段**、上限 10 条（调研 §6 坑#8/9）；
 *     · `place/text`（`/v3/place/text`）—— 正式搜索，容错同样强（实测「澳科打」也能命中），
 *        可分页、条数可控。
 *   ★ 搜索交互已定（§2.A.6 / R5）：**打字只查本地**（0 配额），**回车才调高德** ⇒
 *     请求期只在「回车」这一刻消耗搜索配额。本模块是那一次调用的**薄客户端**。
 *
 * ── 约束 ──────────────────────────────────────────────────────────────
 *   · 调用前取**跨实例令牌桶**（`search` 桶）——搜索与 transit/walking **共用 3 QPS**（§B.4）；
 *   · 结果按 **adcode 过滤（澳门 820000）** + **本地 haversine 排序**（不依赖 `location` 偏置，
 *     实测该偏置无效，调研 §6 坑#9）；
 *   · 只做 HTTP + 归一，**不落库**（配额记账由调用方通过 `onCall` 钩子写入 `search_quota_log`）。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §2.A / §2.A.6；
 *       调研：docs/调研-全澳导航-高德API能力-20260918.md §C、§6。
 */
import { haversineM } from "./coord";
import { acquireToken, RATE_BUCKET, type RateDecision } from "./rate-limit";
import { normalizeName } from "@/lib/shared/normalize";
import { POI_FILTER_SAMPLE_MAX } from "@/lib/nav/types";
import type {
  MacauVerdict,
  PoiKind,
  PoiFilterReport,
  PoiSearchResult,
} from "@/lib/nav/types";

const BASE = "https://restapi.amap.com";
/** 输入提示端点 */
export const AMAP_INPUTTIPS_ENDPOINT = `${BASE}/v3/assistant/inputtips`;
/** 关键字搜索端点 */
export const AMAP_TEXT_ENDPOINT = `${BASE}/v3/place/text`;
/** 澳门 adcode */
export const ADCODE_MACAU = "820000";
const TIMEOUT_MS = 3_000;
/** 搜索上限（place/text 每页最多 25，分页 ≤ 100） */
const MAX_OFFSET = 25;

/** 配额/可观测回调（调用方注入 DB 写入；本模块不碰 DB） */
export type PoiCallHook = (
  api: "inputtips" | "place/text",
  ok: boolean,
  infocode: string | undefined,
  latencyMs: number,
) => void;

/**
 * ★ 2026-11-02：高德在澳门会把**无地址**的 POI 回成 `address: []`（实测「黑沙海滩草地」
 *   「黑沙海滩烧烤区」等）；按字符串直接用会在前端 `.trim()` 处崩掉 ⇒ 类型如实声明为数组。
 */
export interface AmapTip {
  id?: string;
  name?: string;
  district?: string;
  adcode?: string;
  location?: string;
  address?: string | string[];
  typecode?: string;
}

export interface AmapPoi {
  id?: string;
  name?: string;
  district?: string;
  adcode?: string;
  location?: string;
  address?: string | string[];
  typecode?: string;
  cityname?: string;
  adname?: string;
  /** place/text 才返回（米）；inputtips 无 */
  distance?: string;
}

export interface PoiFetchResult<T> {
  ok: boolean;
  items: T[];
  infocode?: string;
  error?: string;
}

function getKey(): string {
  const k = (process.env.AMAP_KEY ?? "").trim();
  if (!k) throw new Error("缺少 AMAP_KEY：请在 .env 配置高德 Web 服务 Key。");
  return k;
}

/** `"lng,lat"` → `{lng,lat}`；无法解析返回 null */
function parseLoc(loc: string | undefined): { lng: number; lat: number } | null {
  if (!loc) return null;
  const p = loc.split(",").map((s) => Number(s.trim()));
  if (p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
  return { lng: p[0], lat: p[1] };
}

/** 高德 typecode → 我们的 kind */
export function kindOfTypeCode(typecode: string | undefined): PoiKind {
  const t = typecode ?? "";
  // 150700 = 公交车站；150500 = 地铁站（澳门轻轨被归为此类）
  if (t.startsWith("150700")) return "station";
  if (t.startsWith("150500")) return "lrt_station";
  return "poi";
}

/**
 * 是否澳门 adcode。★ **不能只判 `=== '820000'`**：澳门 8 个下辖区用 **820001~820008**
 * （如 820001 花地玛堂区），高德多数 POI 返回的是**区级码** ⇒ 只匹配 820000 会把
 * 绝大多数澳门本地结果**误杀**（实测：`新葡京`/`金沙城中心` 全被过滤成 0 条 ✗）。
 * 澳门 = 820000（省级）+ 820001~820008（区级），统一以 `8200` 前缀判定。
 * 【实测】高德返回邻市（珠海）为 440402，不会误入。
 */
export function isMacauAdcode(adcode: string | undefined | null): boolean {
  return /^8200\d{2}$/.test(String(adcode ?? ""));
}

/**
 * **境外轨道交通线路名**前缀 —— 这是**唯一**允许「即使 adcode 写着澳门也要判非澳门」的名称规则。
 *
 * 依据：线路名的属地就是线路所在城市，而 `珠机城轨`（珠海站—珠海机场）、`广珠城际`（广州—珠海）、
 * `广深港高铁` 等**都不经澳门**；澳门自己的轨道叫「氹仔线 / 横琴线 / 石排湾线」。
 * ⇒ 这类名字在澳门应用里出现一定是脏数据（实测 `inputtips("珠机城轨")` 返回裸条目，
 *   正是用户报的「搜横琴冒出珠海城轨线」）。
 * ⚠️ 与下面的「城市名前缀」严格区分：城市名前缀**不能**硬删（会误杀澳门本地店，见下）。
 */
const NON_MACAU_TRANSIT_PREFIX =
  /^(珠機城軌|珠机城轨|廣珠城際|广珠城际|廣珠澳|广珠澳|廣深港|广深港|珠三角城際|珠三角城际|廣佛城際|广佛城际)/;

/**
 * 其他城市名前缀 —— **只用于「无 adcode 时」的兜底**，以及「名称与属地冲突」的标注。
 *
 * ⚠️ ★ 2026-11-12 修正（实测推翻上一版）：**绝不能在有 adcode 时用它硬删**。
 *   上一版把「名称前缀 = 非澳门」当成硬判据，实测直接把澳门本地店全杀了：
 *     · `中山新村`（adcode 820005 / 风顺堂区，113.53775,22.18524）
 *     · `广州街`（820004 / 大堂区）、`广州酒家(华富大厦店)`（820005 / 风顺堂区）
 *     · `香港佳佳甜品(氹仔店)`（820006 / 嘉模堂区）等 12 家 —— 全在澳门境内，只是店名带外地字样。
 *   澳门有大量以「中山」「广州」「香港」命名的街道与老店，名字**不能**证明位置。
 *
 * ⚠️ 同理修正：`珠海海洋王国度假酒店` 曾被判为「adcode 误标的脏数据」，实测其坐标
 *   `113.55095, 22.19823` **在澳门半岛**（花王堂区）—— 它确实是澳门的一家酒店，只是借了
 *   珠海长隆的名号揽客。⇒ 按属地保留，但因为「名称与属地冲突」，会在报告里**标注为待确认**
 *   （`PoiFilterReport.suspects`），由产品而不是我决定要不要展示。
 */
const NON_MACAU_CITY_PREFIX =
  /^(珠海|廣州|广州|深圳|中山|江門|江门|佛山|東莞|东莞|惠州|肇慶|肇庆|香港)/;

/**
 * 同上的**英文写法**（实测「the pavillion shenzhen」这类澳门注册商户会用英文城市名）：
 * 只用于「无 adcode 时剔除」与「名称冲突标注」，口径与中文版一致。
 */
const NON_MACAU_CITY_PREFIX_EN =
  /^(?:the\s+)?(shenzhen|zhuhai|guangzhou|foshan|zhongshan|jiangmen|dongguan|huizhou|zhaoqing|hong\s?kong)\b/i;

/** 名称是否以**其他城市名**开头（中/英两种写法，语义同 `NON_MACAU_CITY_PREFIX`） */
function hasForeignCityName(name: string): boolean {
  const n = name.trim();
  return !!n && (NON_MACAU_CITY_PREFIX.test(n) || NON_MACAU_CITY_PREFIX_EN.test(n));
}

/**
 * ★ 2026-11-12（产品裁决：本应用**只服务澳门**，结果必须能证明在澳门）——
 *   高德结果的**唯一准入判据**，`toResults` 与 `poi-search#filterMacau` 共用这一处，
 *   避免两处口径漂移（历史上正是两处各写一遍才漏了条目）。
 *
 * 三分类（**不是布尔**）：`macau` 保留 / `foreign` 明确非澳门剔除 / `unknown` 归属不明隐藏。
 * 之所以要区分后两者：产品要求「过滤掉多少、过滤了什么」可核对，且「归属不明」必须能被单独
 * 标注出来人工确认 —— 布尔返回值做不到这件事。
 *
 * 判据按**证据强度**排序，命中即返回：
 *   ⓿ `name_foreign`（境外线路名）—— `珠机城轨`/`广珠城际`/`广深港` 等**不经澳门**的线路，
 *      无论 adcode 写什么都判非澳门（唯一凌驾 adcode 的名称规则，理由见 `NON_MACAU_TRANSIT_PREFIX`）。
 *   ① `adcode_macau` / `adcode_foreign` —— **有 adcode 就以 adcode 为准**
 *      （澳门 = 820000 省级 + 820001~820008 八区；珠海=440402、中山=442000）；
 *      这是唯一能区分「澳门店名叫广州街」与「广州的街」的字段。
 *      ⚠️ 有 adcode 时**不看**城市名前缀 —— 实测那会误杀 `中山新村`/`广州街`/`香港佳佳甜品` 等澳门本地店。
 *   ② 无 adcode 且名称以其他城市名开头 ⇒ `name_foreign`
 *      （实测 `inputtips("珠机城轨")` 返回 `{name:"珠机城轨", adcode:"", district:""}` 裸条目，
 *       正是用户报的「搜横琴冒出珠海城轨线」）；
 *   ③ 无 adcode ⇒ 行政区文字（`district`/`cityname`）：含「澳」/`macau` ⇒ `text_macau`；
 *      有文字但不含「澳」⇒ `text_foreign`（文字本身就是行政区名，明确指向别处）；
 *   ④ 三者皆空 ⇒ `no_signal`（**归属不明**）。
 *
 * ── 为什么第 ④ 态从「保留」翻转为「隐藏」（实测）────────────────────────
 *   · 10 个澳门本地词（大三巴/新葡京/关闸/氹仔码头/澳门机场/官也街/妈阁/威尼斯人/横琴/
 *     轻轨站）走 `place/text` + `inputtips` 共 **288 条结果，无 adcode 者 0 条**
 *     ⇒ 「无 adcode 的澳门本地结果」在本数据源里**不存在**，旧兜底保护的是一类空集；
 *   · 那一类空集恰好就是非澳门裸条目 —— 旧兜底等于给脏数据开了一道门。
 *   ⚠️ `unknown` 不是「删掉就算」：它会被记进 `PoiFilterReport.samples` 供人工核对。
 *
 * ⚠️ 本地库（DSAT / 轻轨自有站点）**不带 adcode**，绝不能过这道闸 —— 只用于高德结果。
 */
export function classifyMacau(r: {
  adcode?: string | null;
  district?: string | null;
  cityname?: string | null;
  name?: string | null;
}): MacauVerdict {
  const name = String(r.name ?? "").trim();

  // ⓿ 境外轨道线路名 ⇒ 无条件非澳门（唯一凌驾于 adcode 的名称规则，理由见常量注释）
  if (name && NON_MACAU_TRANSIT_PREFIX.test(name)) return { verdict: "foreign", reason: "name_foreign" };

  // ① adcode 优先：最强的属地证据（澳门 8 个辖区都用 8200xx）
  const ad = String(r.adcode ?? "").trim();
  if (ad) {
    return isMacauAdcode(ad)
      ? { verdict: "macau", reason: "adcode_macau" }
      : { verdict: "foreign", reason: "adcode_foreign" };
  }

  // ② 无 adcode：城市名前缀 ⇒ 非澳门（有 adcode 时**不**采信，否则误杀本地店）
  if (hasForeignCityName(name)) return { verdict: "foreign", reason: "name_foreign" };

  // ③ 无 adcode：退到行政区文字
  const where = `${r.district ?? ""} ${r.cityname ?? ""}`.trim();
  if (!where) return { verdict: "unknown", reason: "no_signal" };
  return /澳|macau/i.test(where)
    ? { verdict: "macau", reason: "text_macau" }
    : { verdict: "foreign", reason: "text_foreign" };
}

/**
 * 「名称与属地冲突」检测 —— **只标注，不删除**。
 *
 * 用于 adcode 判定为澳门、但名称以其他城市开头的情况（实测：`珠海海洋王国度假酒店`
 * 坐标在澳门半岛却被判过脏数据）。这类条目的归属**不是**由我或代码定夺的：按属地它在澳门，
 * 按名字它像外地 ⇒ 保留 + 在报告里挂 `suspects`，交产品确认。
 */
export function isNameCityConflict(r: { name?: string | null }): boolean {
  return hasForeignCityName(String(r.name ?? ""));
}

/**
 * 布尔薄封装 —— **只为向后兼容**（既有调用点/门禁按布尔用）。
 * ⚠️ 新代码请直接用 `classifyMacau`：布尔丢掉了 `foreign` 与 `unknown` 的区分，
 *   而那正是「过滤可核对」的前提。
 */
export function isMacauRow(r: {
  adcode?: string | null;
  district?: string | null;
  cityname?: string | null;
  name?: string | null;
}): boolean {
  return classifyMacau(r).verdict === "macau";
}

// ─────────────────────── 过滤报告（可核对的剔除凭据） ───────────────────────

/** 新建一个空报告累加器 */
export function newPoiFilterStats(): PoiFilterReport {
  return { total: 0, kept: 0, foreign: 0, unknown: 0, noCoord: 0, samples: [], suspects: [] };
}

/** 把 `from` 计入 `into`（多路结果合并时用；样本共用同一个上限） */
export function mergePoiFilterStats(into: PoiFilterReport, from: PoiFilterReport): void {
  into.total += from.total;
  into.kept += from.kept;
  into.foreign += from.foreign;
  into.unknown += from.unknown;
  into.noCoord += from.noCoord;
  for (const s of from.samples) {
    if (into.samples.length >= POI_FILTER_SAMPLE_MAX) break;
    into.samples.push(s);
  }
  for (const s of from.suspects) {
    if (into.suspects.length >= POI_FILTER_SAMPLE_MAX) break;
    into.suspects.push(s);
  }
}

/** 本次是否**真的剔除了**条目（决定是否换用「不在澳门范围」提示） */
export function hasFilteredItems(r: PoiFilterReport | undefined): boolean {
  return !!r && r.foreign + r.unknown > 0;
}

/** 本次是否有任何值得回报的东西（剔除或待确认）—— 决定是否下发 `filtered` 键 */
export function hasFilterReport(r: PoiFilterReport | undefined): boolean {
  return !!r && (r.foreign + r.unknown > 0 || r.suspects.length > 0);
}

// ─────────────────────────── inputtips ───────────────────────────

export interface InputTipsOptions {
  /** 城市限定（澳门 adcode 820000 或 citycode 1853） */
  city?: string;
  /** 仅返回该城市（默认 true） */
  citylimit?: boolean;
  /** 就近偏置点（GCJ-02）—— ⚠️ 实测效果不明显，仅传、不依赖 */
  location?: { lng: number; lat: number };
  /** 数据类型（默认 all） */
  datatype?: string;
  /** 配额记账钩子 */
  onCall?: PoiCallHook;
}

/** 调 `inputtips`（提示型搜索）。失败不抛错，收敛为 `{ok:false}`。 */
export async function inputtips(
  keywords: string,
  opts: InputTipsOptions = {},
): Promise<PoiFetchResult<AmapTip>> {
  // ★ 搜索优化（2026-09-21）：本函数契约是「**失败不抛错**」—— 限速组件自身异常也必须兜住。
  //   背景（实测事故）：生产库被平台置只读时，取令牌的 INSERT 会失败；修前它一路冒泡，
  //   直接让「点搜索」整体不可用。`rate-limit.ts` 已改为 fail-open，此处再加一层防御。
  let token: RateDecision;
  try {
    token = await acquireToken(RATE_BUCKET.search);
  } catch (e) {
    console.warn("[poi] 取令牌异常，放行本次调用：", (e as Error).message);
    token = { ok: true, tokensLeft: null };
  }
  if (!token.ok) return { ok: false, items: [], error: "rate_limited" };

  const params = new URLSearchParams({
    keywords,
    city: opts.city ?? ADCODE_MACAU,
    citylimit: String(opts.citylimit ?? true),
    datatype: opts.datatype ?? "all",
    key: getKey(),
  });
  if (opts.location) params.set("location", `${opts.location.lng.toFixed(6)},${opts.location.lat.toFixed(6)}`);

  const started = Date.now();
  try {
    const res = await fetch(`${AMAP_INPUTTIPS_ENDPOINT}?${params.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = (await res.json()) as {
      status?: string;
      info?: string;
      infocode?: string;
      tips?: AmapTip[];
    };
    const ok = j.status === "1";
    opts.onCall?.("inputtips", ok, j.infocode, Date.now() - started);
    if (!ok) return { ok: false, items: [], infocode: j.infocode, error: j.info };
    return { ok: true, items: j.tips ?? [], infocode: j.infocode };
  } catch (e) {
    opts.onCall?.("inputtips", false, undefined, Date.now() - started);
    return { ok: false, items: [], error: (e as Error).message };
  }
}

// ─────────────────────────── place/text ───────────────────────────

export interface PlaceTextOptions {
  city?: string;
  citylimit?: boolean;
  /** 每页条数（1~25，默认 20） */
  offset?: number;
  /** 页码（默认 1） */
  page?: number;
  onCall?: PoiCallHook;
}

/** 调 `place/text`（正式搜索）。失败不抛错。 */
export async function placeText(
  keywords: string,
  opts: PlaceTextOptions = {},
): Promise<PoiFetchResult<AmapPoi>> {
  // ★ 搜索优化（2026-09-21）：本函数契约是「**失败不抛错**」—— 限速组件自身异常也必须兜住。
  //   背景（实测事故）：生产库被平台置只读时，取令牌的 INSERT 会失败；修前它一路冒泡，
  //   直接让「点搜索」整体不可用。`rate-limit.ts` 已改为 fail-open，此处再加一层防御。
  let token: RateDecision;
  try {
    token = await acquireToken(RATE_BUCKET.search);
  } catch (e) {
    console.warn("[poi] 取令牌异常，放行本次调用：", (e as Error).message);
    token = { ok: true, tokensLeft: null };
  }
  if (!token.ok) return { ok: false, items: [], error: "rate_limited" };

  const offset = Math.min(MAX_OFFSET, Math.max(1, opts.offset ?? 20));
  const params = new URLSearchParams({
    keywords,
    city: opts.city ?? ADCODE_MACAU,
    citylimit: String(opts.citylimit ?? true),
    offset: String(offset),
    page: String(Math.max(1, opts.page ?? 1)),
    extensions: "all",
    key: getKey(),
  });

  const started = Date.now();
  try {
    const res = await fetch(`${AMAP_TEXT_ENDPOINT}?${params.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = (await res.json()) as {
      status?: string;
      info?: string;
      infocode?: string;
      pois?: AmapPoi[];
    };
    const ok = j.status === "1";
    opts.onCall?.("place/text", ok, j.infocode, Date.now() - started);
    if (!ok) return { ok: false, items: [], infocode: j.infocode, error: j.info };
    return { ok: true, items: j.pois ?? [], infocode: j.infocode };
  } catch (e) {
    opts.onCall?.("place/text", false, undefined, Date.now() - started);
    return { ok: false, items: [], error: (e as Error).message };
  }
}

// ─────────────────────────── 归一 → PoiSearchResult ───────────────────────────

export interface ToResultsOptions {
  /** 结果来源标签 */
  source: PoiSearchResult["source"];
  /** 用户当前位置（GCJ-02）；给了就算 distM 并按距离做次级排序 */
  userPos?: { lng: number; lat: number };
  /** 仅保留澳门（adcode 820000/8200xx）；默认 true */
  macauOnly?: boolean;
  /** 基础分（本地/高德不同权重由调用方给）——★ 仅在**未给 `query`** 时生效（旧口径） */
  baseScore?: number;
  /**
   * ★ v1.3.0：用户查询串。**给了就启用「相关性优先」排序**：
   *   主排序 = 文字相关性（完全匹配 > 前缀 > 包含 > 模糊），距离**仅作同档 tie-break**。
   *   不给（undefined）时退回「距离优先」旧口径（向后兼容）。
   */
  query?: string;
  /**
   * ★ 2026-11-12：过滤统计**出口**（可选）。传入一个 `newPoiFilterStats()` 的对象，
   *   本函数把「判定了几条 / 留下几条 / 剔了几条非澳门 / 几条归属不明 / 剔除样本」
   *   累加进去。**返回值类型不变**（仍是 `PoiSearchResult[]`），故所有旧调用方零改动。
   */
  stats?: PoiFilterReport;
}

/** `AmapTip[]` → `PoiSearchResult[]`（过滤无坐标者 + adcode + 本地排序） */
export function tipsToResults(tips: AmapTip[], opts: ToResultsOptions): PoiSearchResult[] {
  return toResults(
    tips.map((t) => ({
      name: t.name,
      address: t.address,
      district: t.district,
      adcode: t.adcode,
      location: t.location,
      typecode: t.typecode,
    })),
    opts,
  );
}

/** `AmapPoi[]` → `PoiSearchResult[]` */
export function poisToResults(pois: AmapPoi[], opts: ToResultsOptions): PoiSearchResult[] {
  return toResults(
    pois.map((p) => ({
      name: p.name,
      address: p.address,
      district: p.district ?? p.adname,
      adcode: p.adcode,
      location: p.location,
      typecode: p.typecode,
      cityname: p.cityname,
    })),
    opts,
  );
}

/**
 * 文字相关性档位：**3=完全匹配 / 2=前缀 / 1=包含 / 0=模糊（其它）**。
 * 用 `normalizeName`（繁→简 + 去交通后缀 + 去括注）对齐比较，故「新葡京」能匹配
 * 「新葡京酒店(公交站)」（去括注后前缀命中），而「新普京桑拿水疗」为 0 档。
 */
function relevanceTier(queryNorm: string, name: string): number {
  if (!queryNorm) return 0;
  const nn = normalizeName(name);
  if (!nn) return 0;
  if (nn === queryNorm) return 3;
  if (nn.startsWith(queryNorm)) return 2;
  if (nn.includes(queryNorm)) return 1;
  return 0;
}

/** 相关性档 → 基础分（间距 ≥250，确保「档位」永远压过「距离」的 ≤100 加成） */
const REL_BASE: Record<number, number> = { 3: 900, 2: 650, 1: 400, 0: 150 };
/** 同档内的距离近者加成上限（0~100；只做 tie-break，不跨档） */
const REL_PROX_MAX = 100;

/**
 * ★ 【7③】POI 类别权重：**地标 / 酒店 / 建筑 优先于「公交站」**。
 *
 * 产品实测（2026-09-19）：搜「新葡京」，高德 `place/text` 原始返回**第一个是公交站**
 *   「新葡京(公交站)」，而用户想去的「澳门新葡京酒店」被排在后面。
 *   根因：我们的相关性档把「新葡京(公交站)」去括注后判为**完全匹配(档3)**，
 *   而「澳门新葡京酒店」因以「澳门」开头只判为**包含(档1)** ⇒ 站点恒定压过酒店。
 *
 * 对策：给**场所型**类别加一个足以跨 1 个相关性档的加成（`+600`）——
 *   · 住宿/风景名胜/商务住宅/政府机构/科教文化/公司企业（高德 typecode 前 3 位
 *     `100/110/120/130/140/170`）⇒ **+600**（「地点/地标/建筑」）；
 *   · **交通设施（`15xxxx`：公交站 150700 / 地铁·轻轨站 150500 / 机场 150100 等）⇒ 0**
 *     （找车站时仍按档位+距离排序，不被加成淹没）；
 *   · 餐饮/购物/生活服务等（`050/060/070…`）⇒ 0（避免「金峰餐廳」压过「金峰南岸」巴士站）；
 *   · 无 typecode ⇒ **+300**（中性，仍略高于纯交通，但低于明确的场所型）。
 *
 * 效果（实测「新葡京」）：酒店 = 档1(400) + 600 = **1000** ＞ 公交站 = 档3(900) + 0 = 900
 *   ⇒ 酒店排到公交站前面 ✓
 */
function poiCategoryBonus(typecode: string | undefined): number {
  const t = typecode ?? "";
  if (!t) return 300;
  const p3 = t.slice(0, 3);
  if (p3 === "100" || p3 === "110" || p3 === "120" || p3 === "130" || p3 === "140" || p3 === "170") {
    return 600; // 住宿 / 风景名胜 / 商务住宅 / 政府机构 / 科教文化 / 公司企业
  }
  return 0; // 交通设施（15x）、餐饮购物等，以及其它类别
}

/**
 * 地址归一：高德 `address` 可能是字符串或字符串数组（澳门实测空结果为 `[]`）。
 * 数组 ⇒ 用空格拼接；归一后为空 ⇒ `undefined`（前端按「无地址」处理，不显示地址行）。
 */
function addressOf(a: string | string[] | undefined): string | undefined {
  if (typeof a === "string") return a.trim() || undefined;
  if (Array.isArray(a)) {
    const s = a.filter((x) => typeof x === "string").join(" ").trim();
    return s || undefined;
  }
  return undefined;
}

/**
 * 文本归一：高德对空字段回 `[]`（数组）而非空串（同 `address` 的老坑，见 `addressOf`）。
 * 报告要直接给人看/给前端读，`adcode: []` 这种形状没意义 ⇒ 统一收敛为 `undefined`。
 */
function textOf(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (Array.isArray(v)) {
    const s = v.filter((x) => typeof x === "string").join(" ").trim();
    return s || undefined;
  }
  return undefined;
}

function toResults(
  rows: {
    name?: string;
    address?: string | string[];
    district?: string;
    adcode?: string;
    location?: string;
    typecode?: string;
    cityname?: string;
  }[],
  opts: ToResultsOptions,
): PoiSearchResult[] {
  const queryNorm = opts.query ? normalizeName(opts.query) : "";
  const scored: { r: PoiSearchResult; i: number }[] = [];
  const stats = opts.stats;
  const macauOnly = opts.macauOnly ?? true;
  let i = 0;
  for (const r of rows) {
    const idx = i++;
    if (!r.name) continue;
    if (stats) stats.total++;
    // ★ 2026-11-12：地区判定**先于**坐标判定 —— 否则「无坐标的非澳门条目」会被记成 `noCoord`，
    //   把「地区过滤到底拦了什么」这件事搅浑（报告必须能如实回答「过滤掉多少非澳门信息」）。
    const v = classifyMacau(r);
    if (macauOnly && v.verdict !== "macau") {
      if (stats) {
        if (v.verdict === "foreign") stats.foreign++;
        else stats.unknown++;
        if (stats.samples.length < POI_FILTER_SAMPLE_MAX) {
          stats.samples.push({
            name: r.name,
            verdict: v.verdict,
            reason: v.reason,
            adcode: textOf(r.adcode),
            district: textOf(r.district),
          });
        }
      }
      continue;
    }
    const ll = parseLoc(r.location);
    if (!ll) {
      // 无坐标（行政区等）→ 无法作为 transit 端点
      if (stats) stats.noCoord++;
      continue;
    }
    if (stats) {
      stats.kept++;
      // ★ 名称与属地冲突：**保留**但标注（见 `isNameCityConflict` 注释的实测案例）
      if (isNameCityConflict(r) && stats.suspects.length < POI_FILTER_SAMPLE_MAX) {
        stats.suspects.push({
          name: r.name,
          verdict: "suspect",
          reason: "name_conflict",
          adcode: textOf(r.adcode),
          district: textOf(r.district),
        });
      }
    }
    const distM = opts.userPos ? haversineM(opts.userPos, ll) : undefined;
    let score: number;
    if (opts.query) {
      // ★ 相关性优先：档位基础分 + 类别加成（地标/酒店/建筑优先于公交站）+ 档内距离加成
      const near = distM !== undefined ? Math.max(0, REL_PROX_MAX - distM / 50) : 0;
      score = REL_BASE[relevanceTier(queryNorm, r.name)] + poiCategoryBonus(r.typecode) + near;
    } else {
      // 旧口径（距离优先）——向后兼容
      score = (opts.baseScore ?? 1) + (distM !== undefined ? Math.max(0, 1000 - distM / 10) : 0);
    }
    scored.push({
      i: idx,
      r: {
        source: opts.source,
        name: r.name,
        address: addressOf(r.address),
        district: r.district,
        adcode: r.adcode,
        lng: ll.lng,
        lat: ll.lat,
        kind: kindOfTypeCode(r.typecode),
        distM: distM !== undefined ? Math.round(distM) : undefined,
        score,
      },
    });
  }
  // score 已含「档位 + 类别 + 档内距离」；同分再按高德原序（稳定 tie-break）
  scored.sort((a, b) => b.r.score - a.r.score || a.i - b.i);
  return scored.map((x) => x.r);
}
