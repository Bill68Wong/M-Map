/**
 * 公共廁所（澳門市政署）静态数据 · 类型与加载器（src/lib/map/public-toilets.ts · M3 · 2026-11-10）
 *
 * ── 数据从哪来 ────────────────────────────────────────────────────────
 *   `public/data/public-toilets.json` 由 `scripts/build-toilets.mjs` 从
 *   data.gov.mo 的《公共廁所》数据包生成（WGS84 → GCJ-02 已换算，两份坐标都留）。
 *   原始逐字节副本见 `public/data/public-toilets.raw.json`（用于校验/追溯）。
 *
 * ── 为什么 fetch 而不是 import ─────────────────────────────────────────
 *   负责人定：做成**静态 JSON、图层默认关闭、打开时才加载**。若 `import` 进来，
 *   打包器会把它塞进 JS bundle，等于「一进页面就下载」，违背按需加载。故运行时
 *   `fetch("/data/public-toilets.json")`，并用**模块级 Promise 缓存**保证只请求一次。
 *   ⚠️ 不传 `cache: "force-cache"`：让浏览器按正常 HTTP 缓存策略处理即可。
 *
 * ⚠️ 本文件是纯类型 + 纯 fetch，不得 import pg / server-only。
 */

/** 单条公厕（展示用；坐标已含原始 WGS84 与转换后 GCJ-02 两套） */
export interface PublicToilet {
  /**
   * 稳定公开 id：`PT-` + sha256(nameTc + 原始 WGS84 满精度坐标) 前 12 位大写十六进制。
   * 撞键时按「名字 → 经度 → 纬度 → 原始行序」稳定排序，第 2+ 个追加 `-2`/`-3`。
   * **不按抓取顺序编号**（顺序会随数据源更新而变，序号一变前端缓存/分享/收藏全错位）。
   */
  publicId: string;
  /** 繁体中文名称（源 nameZh） */
  nameTc: string;
  /** 地址（源 addressZh）；空 → null */
  address: string | null;
  /** 開放時間（源 openHourZh）—— **唯一允许折行的字段**；空 → null */
  openingHours: string | null;
  /** 電話（源 telZh）；空 → null */
  tel: string | null;
  /** 相片 URL；源空串的 5 条 → null */
  photo: string | null;
  /** 原始坐标（WGS84）纬度；location 为 null 的记录 → null */
  latWgs84: number | null;
  /** 原始坐标（WGS84）经度 */
  lngWgs84: number | null;
  /** 展示坐标（GCJ-02）纬度，6 位小数；location 为 null 的记录 → null */
  lat: number | null;
  /** 展示坐标（GCJ-02）经度 */
  lng: number | null;
  /** 有无傷殘人士洗手間（源 hasDwc） */
  hasDwc: boolean;
  /** 有无家庭/育嬰洗手間（源 hasFwc） */
  hasFwc: boolean;
  /** 是否暫停開放（源 tempClose） */
  tempClose: boolean;
}

/** 静态 JSON 顶层结构（= `public/data/public-toilets.json`） */
export interface PublicToiletFile {
  /** 数据集详情页 */
  source: string;
  /** 数据集名（繁體） */
  sourceName: string;
  /** 提供機構 */
  provider: string;
  /** 取得日期 YYYY-MM-DD */
  acquiredOn: string;
  /** 生成时刻（ISO 8601 UTC，构建脚本写入，供交接/追溯） */
  generatedAt: string;
  /** 记录数（= items.length） */
  recordCount: number;
  /** 原始 toliet.json 的 sha256 */
  rawSha256: string;
  /** 原始 toliet.json 字节数 */
  rawBytes: number;
  /** 原始坐标系 */
  sourceCoordSystem: string;
  /** 展示坐标系 */
  coordSystem: string;
  /** 转换说明 */
  transform: string;
  /** 派生字段说明（可追溯） */
  derived: string[];
  items: PublicToilet[];
}

/** 默认静态路径（`public/` 根映射到站点根） */
export const PUBLIC_TOILETS_URL = "/data/public-toilets.json";

/**
 * 模块级缓存：保证并发/多次调用只发一次请求。
 * 失败时清空缓存，允许重试（不把一次网络抖动钉死成永久失败）。
 */
let cache: Promise<PublicToiletFile> | null = null;

export function loadPublicToilets(): Promise<PublicToiletFile> {
  if (cache) return cache;
  cache = fetch(PUBLIC_TOILETS_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`公厕数据加载失败：HTTP ${res.status}`);
      return res.json() as Promise<PublicToiletFile>;
    })
    .catch((err) => {
      cache = null; // 允许下次重试
      throw err;
    });
  return cache;
}
