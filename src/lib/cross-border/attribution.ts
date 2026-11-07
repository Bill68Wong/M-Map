/**
 * 合规署名文本（src/lib/cross-border/attribution.ts · 契约 §4.1 / §4.2）
 *
 * ── 为什么署名要放在**服务端**、由响应体下发 ────────────────────────────
 *   前端硬编码一份署名 = 两份真相。将来条款要求改措辞时，后端改了、前端没改，
 *   页面上就是错的；而且"页面上显示的来源"与"数据实际来自哪"之间没有代码级绑定。
 *   ⇒ 响应体顶层 `attribution` 是**唯一真相**，UI 只渲染它。
 *
 * ── 两套文本不可混用（授权性质完全不同）────────────────────────────────
 *   · 机场：data.gov.mo 完全开放数据，义务仅「註明數據來源＋取得日期」；
 *   · 船　：海事局条款额外要求「必須註明內容來源於"澳門特別行政區海事及水務局"
 *           以及獲得內容的日期；必須確保所複製的內容準確；均不可以修改任何內容」。
 *
 * ⚠️ **船侧署名必须逐字含官方自称「澳門特別行政區海事及水務局」**，
 *    不得简写为「海事局」或「海事及水務局」。`scripts/test-xborder-compliance.ts`
 *    有一条**反向断言**：`includes('海事局') && !includes('海事及水務局')` ⇒ 失败。
 *    （注意「海事及水務局」中「海事」与「局」之间夹着「及水務」，故不含连续的「海事局」。
 *      这条反向断言能抓的真正错误是"有人把全称改成了『澳門海事局』"。）
 */
import { macauDate } from "./time";
import type { XbAttribution } from "./types";

/** 机场署名正文（不含取得日期；日期由 `airportAttribution()` 逐响应填） */
export const AIRPORT_ATTRIBUTION_TEXT =
  "資料來源：澳門特別行政區政府數據開放平台 data.gov.mo · 澳門國際機場離澳／抵澳航班資訊";

/**
 * 船署名正文。**必须含完整官方自称**，见文件头。
 * 不含"取得日期"字样以外的加工 —— 日期由 `acquiredOn` 字段给出。
 */
export const MARINE_ATTRIBUTION_TEXT = "資料來源：澳門特別行政區海事及水務局";

/**
 * 构造署名对象。
 *
 * @param text       正文常量（上面两个之一）
 * @param acquiredAt 该批数据的取得时刻（= 该作用域的 `max(last_seen_at)`）；
 *                   从未采集过时传 null ⇒ 取**响应时刻**的澳门日期。
 *                   （没有数据就没有"取得日期"，但我们仍需给前端一个可渲染的值；
 *                     此时 `emptyReason='not_yet_collected'` 已经把真相说清楚了。）
 */
export function attributionOf(text: string, acquiredAt: Date | string | null): XbAttribution {
  // 统一成 Date：`acquiredAt` 可能是 Date / ISO 字符串 / null。非法值（NaN）退回"现在"，
  // 因为署名日期是**合规必填**，不能因为一个坏入参就整块响应缺字段。
  const at = acquiredAt === null ? new Date() : new Date(acquiredAt);
  return {
    text,
    acquiredOn: macauDate(Number.isNaN(at.getTime()) ? Date.now() : at),
  };
}

/** 机场端点专用快捷方式 */
export const airportAttribution = (acquiredAt: Date | string | null): XbAttribution =>
  attributionOf(AIRPORT_ATTRIBUTION_TEXT, acquiredAt);

/** 船端点专用快捷方式 */
export const marineAttribution = (acquiredAt: Date | string | null): XbAttribution =>
  attributionOf(MARINE_ATTRIBUTION_TEXT, acquiredAt);
