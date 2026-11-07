/**
 * 允许对外的官方链接（src/lib/cross-border/links.ts · 契约 §4.4）
 *
 * ── 为什么只允许两个常量、且只能是首页 ──────────────────────────────────
 *   海事局《使用條款》「￭ 連到本網站」原文：
 *     「外部網站直接連到本網站的首頁無需得到批准，但仍必須在超連結上使用本網站的官方名稱。
 *       如果要連結到**非首頁**，則必須事前得到海事及水務局的書面授權。」
 *   ⇒ 用户界面上**不得**出现 `departure.aspx` / `arrival.aspx` / `schedule_7days.aspx`
 *     这类非首页链接。需要"查看原文"就只跳首页 `https://www.marine.gov.mo`。
 *
 * ── 那解析器怎么拉数据？───────────────────────────────────────────────
 *   解析器**必须**持有上游 URL 才能工作 —— 这是本文件与 `fetch.ts` 之间**真实存在的矛盾**，
 *   不掩盖：`scripts/check-xborder-links.ts` 按**目录**豁免
 *   `src/lib/cross-border/upstream/**`（上游 URL 只许出现在那里），其余目录一律禁止。
 *   ⚠️ 绝不能为了"不被扫到"而把 URL 拆成字符串拼接 —— 那是规避自家门禁，比违规更糟。
 *
 * ⚠️ 本文件**不得**导出任何 `*.aspx` 常量。
 */

/** 海事局首页（唯一允许对外的海事局链接；链接文字必须是官方名称） */
export const MARINE_HOME = "https://www.marine.gov.mo";

/** 澳门数据开放平台首页（机场数据的来源平台） */
export const DATA_GOV_HOME = "https://data.gov.mo";

/**
 * 链接文字（必须是官方名称，条款硬要求）。
 * 前端渲染 `<a href={MARINE_HOME}>{MARINE_LINK_LABEL}</a>`，不要自己写"海事局"。
 */
export const MARINE_LINK_LABEL = "澳門特別行政區海事及水務局";
export const DATA_GOV_LINK_LABEL = "澳門特別行政區政府數據開放平台";
