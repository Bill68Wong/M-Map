/**
 * 船班次拉取（src/lib/cross-border/ferry/fetch.ts）—— **只负责把 HTML 取回来**
 *
 * 分层同机场：freshness（要不要拉）→ 本文件（HTTP）→ ferry/parse.ts（解析）→ store-write。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────────
 *   ① **只拉用户正在看的那一页**（`(pier, dir)` 一个组合）。6 页全刷是 6 倍上游压力
 *      换 0 用户体验（契约 §3.3 ③）。
 *   ② 不伪造 Referer、不加自定义请求头（除 UA / Accept-Language）。这是公开页面，
 *      伪装成"从站内点进来"没有任何必要，且属于规避性行为。
 *   ③ 200 但内容异常（登录页 / 维护页 / 极短页）要在**本文件**就拦掉：
 *      `parse.ts` 的表头校验能抓"结构变了"，但抓不到"整页被替换成通告"这种情况的
 *      早期信号。故这里做两件廉价检查：字节数下限 + 必须含 `item_table`。
 *      注意：**不**在这里判断"有没有数据行" —— 0 行是合法业务状态（停航），交给 parse。
 */
import { ferryUrl, UPSTREAM_HEADERS, UPSTREAM_TIMEOUT_MS } from "../upstream/urls";
import type { PierCode, XbDir } from "../types";

/** 实测三码头页面 180KB 上下；3KB 以下的整页几乎必然是错误页/维护页 */
const MIN_HTML_BYTES = 3000;

/**
 * 取回某码头某方向的页面 HTML。
 *
 * @throws 非 2xx / 内容过短 / 不含航班表 —— 上层按"上游不可用"处理
 */
export async function fetchFerryPage(pier: PierCode, dir: XbDir): Promise<string> {
  const url = ferryUrl(pier, dir);
  const res = await fetch(url, {
    method: "GET",
    headers: { ...UPSTREAM_HEADERS, Accept: "text/html,application/xhtml+xml" },
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`[xborder] ferry ${pier}/${dir} HTTP ${res.status}（${url}）`);

  const html = await res.text();
  if (html.length < MIN_HTML_BYTES)
    throw new Error(
      `[xborder] ferry ${pier}/${dir} 响应过短（${html.length} < ${MIN_HTML_BYTES} 字节）⇒ 疑似错误页`,
    );
  if (!html.includes("item_table"))
    throw new Error(
      `[xborder] ferry ${pier}/${dir} 响应里没有 class=item_table ⇒ 页面结构已变（不是空班次）`,
    );

  return html;
}
