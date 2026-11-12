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

/**
 * 卡片标题用的设施名 —— **剥掉源数据串首的设施编号**（`T8` / `T20` / `AM01` / `GC02` /
 * `C18` …）。2026-11-10 实测 198 条：189 条是「编号 + 空格 + 名」，9 条是「编号直接接名」
 * （如 `C18路環黑沙兵房路臨時公廁`）；编号形态统一为 1~3 个大写字母 + 1~3 位数字，且必在串首。
 *
 * ⚠️ **只在渲染层剥离，绝不改 JSON**：编号是官方数据的取值，改文件等于改政府原文；
 * 原始值在 `public-toilets.json` / `public-toilets.raw.json` 里逐字保留，随时可追溯。
 * 剥离后若为空串（理论上不会出现）⇒ 回落原文，宁可带编号也不出空标题。
 *
 * ── ★ 2026-11-11 防误伤护栏（qa 变异验收后补）─────────────────────────
 *   原正则对**任意**「字母+数字开头」都剥，遇到「站台码 / 复合码」会把编号剥掉、
 *   留下半截垃圾：`M2/1 關閘總站` → `/1 關閘總站`、`M1/2 關閘` → `/2 關閘`。
 *   ⇒ 编号（含其后的空白）之后若紧跟**标点**，判为「不是设施编号 + 名字」，**原样返回不剥**。
 *   ⚠️ 不改成「白名单编号前缀」：那要维护一份官方码表，新增设施就会被静默漏剥，
 *      属于过度设计 + 引入数据依赖。这里只挡「剥完会留下标点开头」这一可判别的坏形态。
 *   ⚠️ 边界（诚实说明）：`A1 大堂` / `M2 澳門站` / `AP1 碼頭` 与真实 189 条
 *      「编号 + 空白 + 中文名」**构造上完全相同**，任何护栏都无法只挡它们而不误伤真实数据；
 *      因此它们仍会剥 —— 这不是缺陷，是数据形态决定的。本护栏只承诺挡住斜杠/标点型。
 *   ✅ 现有 198 条**零误伤**：实读 JSON，编号后紧跟标点的记录为 0 条
 *      （189 条编号+空白、9 条编号直连中文；`LT01/02/03` 是三条独立记录
 *       `LT01氹仔…` / `LT02氹仔…` / `LT03氹仔…`，不是一条带斜杠的复合码）。
 */
/** 编号后若紧跟此类标点 ⇒ 不是「设施编号 + 名字」，原样返回不剥（见上方护栏说明） */
const DISPLAY_NAME_RE =
  /^[A-Z]{1,3}\d{1,3}[ \u3000]*(?![\/／,，、.．:：;；()（）\[\]【】\-–—_])(\S[\s\S]*)$/u;

export function toiletDisplayName(nameTc: string): string {
  const m = DISPLAY_NAME_RE.exec(nameTc);
  return m ? m[1] : nameTc;
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
