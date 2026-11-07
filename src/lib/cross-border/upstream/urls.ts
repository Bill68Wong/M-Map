/**
 * 上游访问地址（src/lib/cross-border/upstream/urls.ts）
 *
 * ⚠️ **本目录是 `scripts/check-xborder-links.ts` 的唯一豁免区**。
 *   原因（真实矛盾，不掩盖）：解析器必须持有上游 URL 才能拉数据，而海事局条款
 *   又禁止"连到非首页"。两者只能靠**目录边界**共存：
 *      · 上游 URL 只许出现在 `src/lib/cross-border/upstream/**`；
 *      · 其余目录（含 `links.ts`）一律不得出现 `*.aspx` / 非首页 `marine.gov.mo` 路径。
 *   ⇒ **不要**为了"不被扫到"把 URL 拆成字符串拼接：那是规避自家门禁，比违规本身更糟，
 *     且会让下一个维护者找不到真实地址。
 *
 * 这些地址是**服务端拉取用**，永不下发到浏览器（前端只用 `links.ts` 的首页常量）。
 */

const MARINE_ORIGIN = "https://www.marine.gov.mo";

/**
 * 机场两个 FIDS 端点（data.gov.mo 完全开放数据，需 `Authorization: APPCODE <AACM_APPCODE>`）。
 * 字段：离澳 = time/airline/destination/flightNo/gate/status/date
 *       抵澳 = time/airline/origin/flightNo/status/date（**无 gate**）
 */
export const AIRPORT_FLIGHT_URL = {
  dep: "https://aacm.apigateway.data.gov.mo/api/open/listDepartureFlight/CHINESE",
  arr: "https://aacm.apigateway.data.gov.mo/api/open/listArrivalFlight/CHINESE",
} as const;

/**
 * 船 · 实时离港/到港页（HTML 表格，无 JSON 接口）。
 * `local` = 码头（PE/TP/PI），`port` = 目的港筛选（ALL = 不过滤）。
 *
 * ⚠️ `port=ALL` 是**页面自带链接**的取值，与本文件无关的另一个坑在班期表：
 *    `schedule_7days.aspx` 的 `company` 必须传**空串**，传 `ALL` 返回 0 行。
 */
const FERRY_PAGE = {
  dep: `${MARINE_ORIGIN}/departure.aspx`,
  arr: `${MARINE_ORIGIN}/arrival.aspx`,
} as const;

export function ferryUrl(pier: "PE" | "TP" | "PI", dir: "dep" | "arr"): string {
  return `${FERRY_PAGE[dir]}?local=${pier}&port=ALL`;
}

/**
 * 请求头。
 * · UA 标注用途（政府站点若查日志，能看出这是一台在正常使用公开数据的客户端）；
 * · `Accept-Language: zh-TW` —— 页面状态文本是繁体，发中文优先可避免偶发的语言分支；
 * · 不伪造 Referer：本项目不是从那些页面点进来的，伪造才是"绕过"。
 */
export const UPSTREAM_HEADERS = {
  "User-Agent":
    "M-Map/3.10 (Macau bus & ferry companion; non-commercial; +https://github.com/) node-fetch",
  "Accept-Language": "zh-TW,zh;q=0.9",
  Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
} as const;

/** 单次上游请求超时（毫秒）。慢于这个值就当上游不可用 —— 用户在等着看弹窗 */
export const UPSTREAM_TIMEOUT_MS = 10_000;
