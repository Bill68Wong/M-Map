/**
 * 澳門地球物理氣象局（SMG）XML 數據接入（src/lib/weather/smg.ts · v4.1.0）
 *
 * ── 為什麼必須在服務端取（硬約束，不要再嘗試前端直連）────────────────────
 *   `xml.smg.gov.mo` **不返回 CORS 響應頭**（實測：同屬 SMG 的 `www.smg.gov.mo`
 *   JSON 帶 `Access-Control-Allow-Origin: *`，但 XML 這個域沒有）。瀏覽器直連會被
 *   CORS 攔死，故一律由 Next.js 服務端 fetch 後再吐給前端。
 *
 * ── 六個端點的實測事實（2026-11-07 23:4x，逐字核對，不是照抄文檔）──────────
 *   | URL                        | 根節點               | 編碼  | 記錄數 | 實測耗時 |
 *   | c_actual_brief.xml         | ActualWeatherBrief   | UTF-8 | 1      | 47 ms   |
 *   | c_actualweather.xml        | ActualWeather        | UTF-8 | 17 站  | 73 ms   |
 *   | c_forecast.xml             | ActualForecast       | UTF-8 | 2 天   | 50 ms   |
 *   | c_7daysforecast.xml        | SevenDaysForecast    | UTF-8 | 7 天   | 41 ms   |
 *   | c_rainstorm.xml            | RainstormWarning     | UTF-8 | 1      | 39 ms   |
 *   | c_typhoon.xml              | TyphoonWarning       | UTF-8 | 1      | 35 ms   |
 *   全部 HTTP 200、無 key、無註冊。XML 聲明均為 `encoding="UTF-8"`（大小寫兩種寫法都出現過），
 *   故常規路徑是 UTF-8；下面仍保留「按聲明解碼」是為了上游改 BIG5 時不至於整屏亂碼。
 *
 * ── 解析方式：為什麼是手寫最小解析器而不是裝庫 ────────────────────────────
 *   `node_modules` 裡沒有 `fast-xml-parser` / `xml2js`，而本項目對新依賴有門檻。
 *   六個端點的結構固定、層級淺（最深 4 層）、無命名空間前綴、無 CDATA、無混合內容，
 *   用 `tagBlocks` / `pickText` 兩個 10 行函數即可覆蓋，且**失敗一定是拋錯**（見下）。
 *   真需要處理任意 XML 時再換庫 —— 那時結構也一定已經變了，屆時本來就要重寫。
 *
 * ── fail-closed 的含義（本文件的中心思想）─────────────────────────────────
 *   所有解析器在「根節點不符 / 必需字段缺失 / 數值不可解析」時**拋 `SmgParseError`**，
 *   絕不返回「看起來正常的空對象」。理由：氣象數據的消費者包含**暴雨警告**，
 *   一個「空的但有 200」的響應會被前端渲染成「現時沒有警告」—— 那是把人往雨裡送。
 *   對外契約見 `SmgResult`：成功帶數據，失敗帶可判別錯誤碼，**沒有第三種形態**。
 *
 * ── SysPubdate 的兩種形態（實測）────────────────────────────────────────
 *   `2026-11-07 22:56`（無時區）與 `2026-10-04 23:25 GMT+8`（帶時區後綴）都出現過。
 *   `normalizeSmgStamp` 統一成 `YYYY-MM-DDTHH:MM:00+08:00`；解析不了就返回 null
 *   （**不猜**：寧可讓前端顯示「時間未提供」，也不編一個看起來合理的時刻）。
 */

/** 對外標注的數據來源（四紅線之一：必須註明來源） */
export const SMG_SOURCE = {
  name: "地球物理氣象局（SMG）",
  url: "https://www.smg.gov.mo/",
} as const;

/** 六個上游端點。改地址只改這裡（測試與路由都引用同一份，避免兩處漂移） */
export const SMG_URL = {
  brief: "https://xml.smg.gov.mo/c_actual_brief.xml",
  actual: "https://xml.smg.gov.mo/c_actualweather.xml",
  forecast: "https://xml.smg.gov.mo/c_forecast.xml",
  sevenDay: "https://xml.smg.gov.mo/c_7daysforecast.xml",
  rainstorm: "https://xml.smg.gov.mo/c_rainstorm.xml",
  typhoon: "https://xml.smg.gov.mo/c_typhoon.xml",
} as const;

/**
 * 單次上游超時。取 25 秒是因為同類政府接口實測出現過「首次 504、重試即好」，
 * 過早放棄等於把一次可自愈的抖動變成用戶可見的失敗。
 */
const UPSTREAM_TIMEOUT_MS = 25_000;
/** 總嘗試次數（首次 + 1 次重試）。最壞耗時 ≈ 50s，路由 `maxDuration` 必須 ≥ 60 */
const UPSTREAM_ATTEMPTS = 2;

/**
 * UA 標注用途：政府站點若查日誌，能看出這是一台在正常使用公開數據的客戶端。
 * 不偽造 Referer —— 我們不是從那些頁面點進來的，偽造才叫繞過。
 */
const UPSTREAM_HEADERS = {
  "User-Agent": "M-Map/4.1 (Macau transit companion; non-commercial) node-fetch",
  Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
} as const;

/* ══════════════════════════════════════════════════════════════════════
 * 1. 類型（對外只給這些，原始 XML 永不出本文件）
 * ══════════════════════════════════════════════════════════════════════ */

/** 失敗原因。`detail` 只進服務端日誌，不回客戶端（錯誤碼閉集見 API_ERROR） */
export type SmgErrorCode = "timeout" | "network" | "http_status" | "decode" | "parse";

export type SmgResult<T> =
  | { ok: true; data: T; fetchedAt: string }
  | { ok: false; code: SmgErrorCode; detail: string };

/** 實時天氣簡報（c_actual_brief.xml） */
export interface SmgBrief {
  /** 上游發佈時刻（`SysPubdate` 歸一化為 +08:00 ISO；解析不了為 null） */
  publishedAt: string | null;
  validFor: string | null;
  temperatureC: number | null;
  /** `<Temperature><Type>8</Type>`（當日最高，實測與七日預報同值） */
  temperatureMaxC: number | null;
  /** `<Temperature><Type>9</Type>`（當日最低） */
  temperatureMinC: number | null;
  humidityPct: number | null;
  windSpeedKmh: number | null;
  /** 風速級別原文（例「三級」） */
  windSpeedLevel: string | null;
  /** 風向代碼（例 `ENE`，來自 `<WindDirection><Value>`） */
  windDirectionCode: string | null;
  /** 風向中文（例「東北偏東」） */
  windDirection: string | null;
  /** 天氣代碼（例 `03`） */
  weatherStatus: string | null;
  /** 天氣描述（`<Icon><IconDescription>`，例「多雲」） */
  description: string | null;
  iconUrl: string | null;
  /** 體感描述（例「溫暖」） */
  feelsLike: string | null;
}

/**
 * 單個氣象站的實時觀測（c_actualweather.xml，17 站）
 *
 * ⚠️ 實測事實（2026-11-07）：17 站裡有 7 個**橋樑站**（MN/MS/PN/PS/PG/PV/PL）**只上報風**，
 *    沒有 Temperature / Humidity / DewPoint / FeelsLike 塊 ⇒ 這些字段為 null 是**正常**，
 *    不是解析失敗。UI 對橋樑站只顯示風速風向即可，不要把它們當成「數據缺失」。
 */
export interface SmgStation {
  code: string;
  name: string;
  recordTime: string | null;
  temperatureC: number | null;
  temperatureMaxC: number | null;
  temperatureMinC: number | null;
  humidityPct: number | null;
  dewPointC: number | null;
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  /** 風向代碼（例 `ENE`） */
  windDirectionCode: string | null;
  /** 風向角度（`<Degree>`，度） */
  windDirectionDegree: number | null;
  windDirection: string | null;
  feelsLike: string | null;
  /** 海平面氣壓（hPa）。僅部分站點有，缺省為 null */
  meanSeaLevelPressureHpa: number | null;
}

export interface SmgActualWeather {
  publishedAt: string | null;
  stations: SmgStation[];
}

/** 暴雨警告（c_rainstorm.xml） */
export interface SmgRainstormWarning {
  publishedAt: string | null;
  /** 警告代碼；無警告時為字面量 `NIL` */
  warncode: string | null;
  action: string | null;
  issuedAt: string | null;
  /** ★ 布爾位：`0` → false，非 0 → true（實測無警告時是 `0`） */
  inforce: boolean;
  status: string | null;
  description: string | null;
}

/** 熱帶氣旋 / 風暴潮警告（c_typhoon.xml） */
export interface SmgTyphoonWarning {
  publishedAt: string | null;
  tcid: string | null;
  name: string | null;
  warncode: string | null;
  action: string | null;
  issuedAt: string | null;
  inforce: boolean;
  description: string | null;
  major: string | null;
  imageUrl: string | null;
}

export interface SmgForecastDay {
  validFor: string | null;
  description: string;
  astronomicalTide: string | null;
}

export interface SmgForecast {
  publishedAt: string | null;
  /** 今日天氣形勢（`<TodaySituation>`），可能為空串 */
  situation: string | null;
  days: SmgForecastDay[];
}

export interface SmgSevenDay {
  publishedAt: string | null;
  issuedTime: string | null;
  days: SmgSevenDayItem[];
}

export interface SmgSevenDayItem {
  validFor: string | null;
  /** 星期幾中文（`<c_DayOfWeek>`，例「日」） */
  dayOfWeek: string | null;
  weatherStatus: string | null;
  iconUrl: string | null;
  /** 最高溫（`<Temperature><Type>1</Type>`）—— 依據：實測 11-08 為 29，
   *  同日 c_forecast 文字寫「氣溫約為攝氏24至29度」，Type 1 對應上界 */
  temperatureMaxC: number | null;
  /** 最低溫（`<Type>2</Type>`，同上依據 24 對應下界） */
  temperatureMinC: number | null;
  /** 最高濕度（`<Humidity><Type>1</Type>`，實測 95；預報文字「60至95」⇒ Type 1 為上界） */
  humidityMaxPct: number | null;
  humidityMinPct: number | null;
  description: string | null;
}

/* ══════════════════════════════════════════════════════════════════════
 * 2. XML 最小解析（只認這六份文檔的固定結構）
 * ══════════════════════════════════════════════════════════════════════ */

export class SmgParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmgParseError";
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/** 解 XML 實體 + 去 CDATA 包裹（`&#176;C` 這種在七日預報的 MeasureUnit 裡真實出現） */
function decodeEntities(s: string): string {
  const noCdata = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const fromCodePoint = (cp: number, whole: string) =>
    Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
  return noCdata.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return fromCodePoint(Number.parseInt(body.slice(2), 16), whole);
    }
    if (body.startsWith("#")) {
      return fromCodePoint(Number.parseInt(body.slice(1), 10), whole);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** 取 `<tag>…</tag>` 全部塊（非貪婪；`<tag/>` 不算塊，但 pickText 会处理） */
function tagBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) out.push(m[1]);
  return out;
}

/**
 * 取單個標籤的文本。
 * · 有開始結束標籤 ⇒ 去實體、trim；
 * · 自閉合 `<tag/>` 或 `<tag />` ⇒ 空串（上游真的會給 `<Minor/>`，語義就是「空」）；
 * · 完全沒有這個標籤 ⇒ null（**與空串區分**，缺字段要用來判結構異常）。
 */
function pickText(xml: string, tag: string): string | null {
  const closed = tagBlocks(xml, tag);
  if (closed.length > 0) return decodeEntities(closed[0]).trim();
  const selfClosing = new RegExp(`<${tag}(?:\\s[^>]*)?/>`).test(xml);
  return selfClosing ? "" : null;
}

/**
 * 必需塊：取 `<tag>…</tag>` 的**原始內部 XML**（不解實體 —— 供後續再從塊裡取子標籤）。
 * 解實體會把 `&lt;` 變成 `<`，之後的子標籤正則就可能吃到假標籤。
 */
function requireBlock(xml: string, tag: string, where: string): string {
  const block = tagBlocks(xml, tag)[0];
  if (block === undefined) throw new SmgParseError(`${where} 缺 <${tag}>`);
  return block;
}

/** 必需標籤：缺失或全空 ⇒ 拋（fail-closed，不靜默給 null） */
function requireText(xml: string, tag: string, where: string): string {
  const v = pickText(xml, tag);
  if (v === null) throw new SmgParseError(`${where} 缺 <${tag}>`);
  const t = v.trim();
  if (t === "") throw new SmgParseError(`${where} 的 <${tag}> 為空`);
  return t;
}

function toNum(v: string | null): number | null {
  if (v === null) return null;
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * 取「帶子元素的量測塊」裡的 `<Value>`（形如 `<Temperature><MeasureUnit>°C</MeasureUnit>
 * <Type>3</Type><Value>26</Value></Temperature>`）。
 * ⚠️ 不能對這種塊直接用 `pickText` —— 那會拿到整段子 XML 而不是數值。
 */
function numIn(xml: string, tag: string): number | null {
  const block = tagBlocks(xml, tag)[0];
  return block === undefined ? null : toNum(pickText(block, "Value"));
}

/** 同上，但取文本（例如 `<WindSpeed><WindSpeedDescription>三級</…>`） */
function textIn(xml: string, tag: string, child: string): string | null {
  const block = tagBlocks(xml, tag)[0];
  return block === undefined ? null : pickText(block, child);
}

/** 根節點校驗：上游若返回錯誤頁 / 改版，這裡必須炸，不能「解析出 0 條」 */
function requireRoot(xml: string, root: string): void {
  const re = new RegExp(`<${root}(?:\\s[^>]*)?>`);
  if (!re.test(xml)) {
    throw new SmgParseError(`根節點不是 <${root}>（可能是錯誤頁或上游改版）`);
  }
}

/**
 * `Inforce` 布爾位：實測 `0`=無警告、非 0=生效。
 * 空串 / 非數字 ⇒ 拋。**不能讓空串走 `Number("")===0` 順便變成「無警告」** ——
 * 那正是「字段丟了卻顯示安全」的靜默路徑。
 */
function parseInforce(raw: string | null, where: string): boolean {
  if (raw === null) throw new SmgParseError(`${where} 缺 <Inforce>`);
  const t = raw.trim();
  if (t === "") throw new SmgParseError(`${where} 的 <Inforce> 為空`);
  const n = Number(t);
  if (!Number.isFinite(n)) {
    throw new SmgParseError(`${where} 的 <Inforce> 不是數字：${JSON.stringify(raw)}`);
  }
  return n !== 0;
}

/**
 * 回代校驗用的格式化器（模塊級：`new Intl…` 每次調用都要建 ICU 對象，沒必要）。
 * 固定 `h23` 小時循環：用 `hour12:false` 在部分 locale 下會輸出 `24:xx`，
 * 凌晨 00:xx 會被誤判成非法而丟掉（真實坑）。
 */
const MACAU_STAMP_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Macau",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * 上游時刻歸一化：`2026-11-07 22:56` / `2026-10-04 23:25 GMT+8` ⇒ `…T22:56:00+08:00`。
 * 解析不了返回 null（不猜）。澳門常年在 UTC+8，無夏令時，故固定 +08:00。
 */
export function normalizeSmgStamp(raw: string | null): string | null {
  if (raw === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  const stamp = `${y}-${mo}-${d}T${hh}:${mm}:00+08:00`;
  // 回代校驗：`2026-02-30` 這種 Date 會自動進位，必須能原路返回才算合法
  const back = new Date(stamp);
  if (Number.isNaN(back.getTime())) return null;
  if (MACAU_STAMP_FMT.format(back) !== `${y}-${mo}-${d}, ${hh}:${mm}`) return null;
  return stamp;
}

/**
 * 圖標地址歸一：七日預報給的是 `http://www.smg.gov.mo/...`（明文）。
 * PWA 是 https，明文圖標會被瀏覽器**直接攔掉**（mixed content），故升級為 https。
 * 已實測 `https://www.smg.gov.mo/icons/weatherIcon/ww-c28.gif` 返回 200 image/gif，
 * 同主機同路徑，只換協議 ⇒ 不是改內容，只是換一個能加載的地址。
 */
function normalizeIconUrl(raw: string | null): string | null {
  if (raw === null) return null;
  return raw.trim().replace(/^http:\/\/(www\.smg\.gov\.mo\/)/i, "https://$1");
}

/* ══════════════════════════════════════════════════════════════════════
 * 3. 各端點解析器（純函數：輸入 XML 文本，輸出類型化對象，失敗拋錯）
 * ══════════════════════════════════════════════════════════════════════ */

/** 實測：同一份 XML 裡 `<Temperature>` 出現三次，靠 `<Type>` 區分（3=當前 / 8=最高 / 9=最低） */
function pickByType(blocks: string[], type: string): string | null {
  for (const b of blocks) {
    const t = pickText(b, "Type");
    if (t !== null && t.trim() === type) return pickText(b, "Value");
  }
  return null;
}

export function parseWeatherBrief(xml: string): SmgBrief {
  requireRoot(xml, "ActualWeatherBrief");
  const custom = requireBlock(xml, "Custom", "ActualWeatherBrief");
  const temps = tagBlocks(custom, "Temperature");

  const temperatureC = toNum(pickByType(temps, "3"));
  if (temperatureC === null) {
    throw new SmgParseError("ActualWeatherBrief 缺當前氣溫（<Temperature><Type>3</Type>）");
  }

  return {
    publishedAt: normalizeSmgStamp(pickText(xml, "SysPubdate")),
    validFor: pickText(custom, "ValidFor"),
    temperatureC,
    temperatureMaxC: toNum(pickByType(temps, "8")),
    temperatureMinC: toNum(pickByType(temps, "9")),
    humidityPct: numIn(custom, "Humidity"),
    windSpeedKmh: numIn(custom, "WindSpeed"),
    windSpeedLevel: textIn(custom, "WindSpeed", "WindSpeedDescription"),
    windDirectionCode: textIn(custom, "WindDirection", "Value"),
    windDirection: textIn(custom, "WindDirection", "WindDescription"),
    weatherStatus: pickText(custom, "WeatherStatus"),
    description: textIn(custom, "Icon", "IconDescription"),
    iconUrl: normalizeIconUrl(textIn(custom, "Icon", "IconURL")),
    feelsLike: pickText(custom, "FeelsLikeDescription"),
  };
}

export function parseActualWeather(xml: string): SmgActualWeather {
  requireRoot(xml, "ActualWeather");
  const custom = requireBlock(xml, "Custom", "ActualWeather");
  const stations: SmgStation[] = [];

  for (const block of tagBlocks(custom, "WeatherReport")) {
    const code = /<station\b[^>]*\bcode\s*=\s*"([^"]+)"/.exec(block)?.[1];
    if (!code) throw new SmgParseError('WeatherReport 缺 <station code="…">');
    const name = requireText(block, "stationname", `站點 ${code}`);

    stations.push({
      code,
      name,
      recordTime: pickText(block, "RecordTime"),
      temperatureC: numIn(block, "Temperature"),
      temperatureMaxC: numIn(block, "Temperature_daily_max"),
      temperatureMinC: numIn(block, "Temperature_daily_min"),
      humidityPct: numIn(block, "Humidity"),
      dewPointC: numIn(block, "DewPoint"),
      windSpeedKmh: numIn(block, "WindSpeed"),
      windGustKmh: numIn(block, "WindGust"),
      windDirectionCode: textIn(block, "WindDirection", "Value"),
      windDirectionDegree: toNum(textIn(block, "WindDirection", "Degree")),
      windDirection: textIn(block, "WindDirection", "WindDescription"),
      feelsLike: textIn(block, "FeelsLike", "FeelsLikeDescription"),
      meanSeaLevelPressureHpa: numIn(block, "MeanSeaLevelPressure"),
    });
  }

  // 實測恆為 17 站；0 站說明結構變了（或拿到空殼），不能當成「今天沒有觀測」
  if (stations.length === 0) throw new SmgParseError("ActualWeather 解析出 0 個氣象站");
  return { publishedAt: normalizeSmgStamp(pickText(xml, "SysPubdate")), stations };
}

export function parseRainstormWarning(xml: string): SmgRainstormWarning {
  requireRoot(xml, "RainstormWarning");
  const custom = requireBlock(xml, "Custom", "RainstormWarning");
  const warning = tagBlocks(custom, "Rainstorm")[0];
  if (warning === undefined) throw new SmgParseError("RainstormWarning 缺 <Custom><Rainstorm>");

  return {
    publishedAt: normalizeSmgStamp(pickText(xml, "SysPubdate")),
    warncode: pickText(warning, "Warncode"),
    action: pickText(warning, "Action"),
    issuedAt: pickText(warning, "IssuedAt"),
    inforce: parseInforce(pickText(warning, "Inforce"), "暴雨警告"),
    status: pickText(warning, "Status"),
    description: pickText(warning, "Description"),
  };
}

export function parseTyphoonWarning(xml: string): SmgTyphoonWarning {
  requireRoot(xml, "TyphoonWarning");
  const custom = requireBlock(xml, "Custom", "TyphoonWarning");
  const cyclone = tagBlocks(custom, "TropicalCyclone")[0];
  if (cyclone === undefined) throw new SmgParseError("TyphoonWarning 缺 <Custom><TropicalCyclone>");
  const image = tagBlocks(cyclone, "Image")[0] ?? null;

  return {
    publishedAt: normalizeSmgStamp(pickText(xml, "SysPubdate")),
    tcid: pickText(cyclone, "Tcid"),
    name: pickText(cyclone, "Name"),
    warncode: pickText(cyclone, "Warncode"),
    action: pickText(cyclone, "Action"),
    issuedAt: pickText(cyclone, "IssuedAt"),
    inforce: parseInforce(pickText(cyclone, "Inforce"), "熱帶氣旋警告"),
    description: pickText(cyclone, "Description"),
    major: pickText(cyclone, "Major"),
    imageUrl: image === null ? null : normalizeIconUrl(pickText(image, "ImageURL")),
  };
}

export function parseForecast(xml: string): SmgForecast {
  requireRoot(xml, "ActualForecast");
  const custom = requireBlock(xml, "Custom", "ActualForecast");
  const days = tagBlocks(custom, "WeatherForecast").map((b) => ({
    validFor: pickText(b, "ValidFor"),
    description: requireText(b, "WeatherDescription", "預報日"),
    astronomicalTide: pickText(b, "AstronomicalTide"),
  }));
  if (days.length === 0) throw new SmgParseError("ActualForecast 解析出 0 天預報");

  return {
    publishedAt: normalizeSmgStamp(pickText(xml, "SysPubdate")),
    situation: pickText(custom, "TodaySituation"),
    days,
  };
}

export function parseSevenDayForecast(xml: string): SmgSevenDay {
  requireRoot(xml, "SevenDaysForecast");
  const custom = requireBlock(xml, "Custom", "SevenDaysForecast");
  const days = tagBlocks(custom, "WeatherForecast").map((b) => {
    const temps = tagBlocks(b, "Temperature");
    const humidity = tagBlocks(b, "Humidity");
    const icon = tagBlocks(b, "Icon")[0] ?? null;
    return {
      validFor: pickText(b, "ValidFor"),
      dayOfWeek: pickText(b, "c_DayOfWeek"),
      weatherStatus: pickText(b, "WeatherStatus"),
      iconUrl: icon === null ? null : normalizeIconUrl(pickText(icon, "IconURL")),
      temperatureMaxC: toNum(pickByType(temps, "1")),
      temperatureMinC: toNum(pickByType(temps, "2")),
      humidityMaxPct: toNum(pickByType(humidity, "1")),
      humidityMinPct: toNum(pickByType(humidity, "2")),
      description: requireText(b, "WeatherDescription", "七日預報日"),
    };
  });
  if (days.length === 0) throw new SmgParseError("SevenDaysForecast 解析出 0 天預報");

  return {
    publishedAt: normalizeSmgStamp(pickText(xml, "SysPubdate")),
    issuedTime: pickText(custom, "IssuedTime"),
    days,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 4. 取數 + 解碼（超時 25s，總共 2 次嘗試）
 * ══════════════════════════════════════════════════════════════════════ */

type RawXml = { ok: true; text: string } | { ok: false; code: SmgErrorCode; detail: string };

/**
 * 按 XML 聲明解碼，並**拒絕含 U+FFFD 的結果**：
 * 解錯編碼的典型表現就是一片 �，而 � 會被前端當正常文本渲染出來（比報錯更糟）。
 */
function decodeXmlBuffer(buf: ArrayBuffer): RawXml {
  const head = new TextDecoder("latin1").decode(buf.slice(0, 200));
  const declared = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase() ?? "utf-8";
  let text: string;
  try {
    text = new TextDecoder(declared, { fatal: false }).decode(buf);
  } catch {
    text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
  text = text.replace(/^\uFEFF/, "");
  if (text.includes("\uFFFD")) {
    return {
      ok: false,
      code: "decode",
      detail: `按 ${declared} 解碼後出現替換字符（U+FFFD），拒絕向下游輸出亂碼`,
    };
  }
  return { ok: true, text };
}

async function fetchXml(url: string): Promise<RawXml> {
  let last: { code: SmgErrorCode; detail: string } = { code: "network", detail: "未執行" };

  for (let attempt = 1; attempt <= UPSTREAM_ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: UPSTREAM_HEADERS });
      if (!res.ok) {
        last = { code: "http_status", detail: `HTTP ${res.status}` };
        continue;
      }
      const decoded = decodeXmlBuffer(await res.arrayBuffer());
      if (!decoded.ok) {
        last = { code: decoded.code, detail: decoded.detail };
        continue;
      }
      return decoded;
    } catch (e) {
      const aborted = ac.signal.aborted;
      last = aborted
        ? { code: "timeout", detail: `超過 ${UPSTREAM_TIMEOUT_MS}ms 未響應` }
        : { code: "network", detail: (e as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, ...last };
}

/** 取數 → 解析 → 類型化結果。解析異常一律轉成 `ok:false`，**不讓它冒到路由外** */
async function load<T>(
  url: string,
  parse: (xml: string) => T,
  label: string,
): Promise<SmgResult<T>> {
  const raw = await fetchXml(url);
  if (!raw.ok) return raw;
  try {
    return { ok: true, data: parse(raw.text), fetchedAt: new Date().toISOString() };
  } catch (e) {
    return {
      ok: false,
      code: "parse",
      detail: `${label}：${(e as Error).message}`,
    };
  }
}

/**
 * 可選參數 `url` 只為測試注入用（例如塞一個 `data:` URL 驗 fail-closed 路徑），
 * 生產調用一律不傳。
 */
export function fetchWeatherBrief(url: string = SMG_URL.brief): Promise<SmgResult<SmgBrief>> {
  return load(url, parseWeatherBrief, "實時天氣簡報");
}

export function fetchActualWeather(url: string = SMG_URL.actual): Promise<SmgResult<SmgActualWeather>> {
  return load(url, parseActualWeather, "實時天氣（分站）");
}

export function fetchRainstormWarning(
  url: string = SMG_URL.rainstorm,
): Promise<SmgResult<SmgRainstormWarning>> {
  return load(url, parseRainstormWarning, "暴雨警告");
}

export function fetchTyphoonWarning(
  url: string = SMG_URL.typhoon,
): Promise<SmgResult<SmgTyphoonWarning>> {
  return load(url, parseTyphoonWarning, "熱帶氣旋警告");
}

export function fetchForecast(url: string = SMG_URL.forecast): Promise<SmgResult<SmgForecast>> {
  return load(url, parseForecast, "天氣預報");
}

export function fetchSevenDayForecast(
  url: string = SMG_URL.sevenDay,
): Promise<SmgResult<SmgSevenDay>> {
  return load(url, parseSevenDayForecast, "七日天氣預報");
}
