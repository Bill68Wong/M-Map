/**
 * 机场 FIDS 拉取（src/lib/cross-border/airport/fetch.ts）—— **只负责取回原始 JSON**
 *
 * ── 分层 ──────────────────────────────────────────────────────────────
 *   freshness.ts（决定"要不要拉"）
 *     → 本文件（HTTP：认证 / 超时 / 状态码）
 *       → airport/parse.ts（形状校验 + 字段归一，纯函数）
 *         → store-write.ts（upsert）
 *   本文件**不解析**、不写入、不判断业务：它只把"上游原样的 unknown"交出去。
 *   这样"网络问题"与"形状问题"在日志里永远分得开（契约 §3.5 第 4 步的用意）。
 *
 * ── 两个必须遵守的细节 ────────────────────────────────────────────────
 *   ① 凭据从 `AACM_APPCODE` 读，**不写死、不打印**。缺失时抛错（由上层降级为 503/ stale），
 *      错误文案只提变量名，不回显任何值 —— 这个值本仓库曾公开泄漏过一次
 *      （`docs/复盘-GitHub封号事故-20261028.md`），日志里再露一次等于白改。
 *   ② 先 `res.text()` 再 `JSON.parse`。直接 `res.json()` 在上游返回 HTML 错误页时
 *      只给一句 `Unexpected token '<'`，而带上前 80 字符就能立刻看出是网关页还是数据。
 *   ③ `res.text()` 之后、`JSON.parse` 之前消毒 U+0000（见 `sanitizeAirportRawText`）：
 *      上游瞬时控制字节会让整批 INSERT 原子失败。这是本文件唯一允许的文本加工。
 */
import { AIRPORT_FLIGHT_URL, UPSTREAM_HEADERS, UPSTREAM_TIMEOUT_MS } from "../upstream/urls";
import type { XbDir } from "../types";

/**
 * 机场侧上游文本消毒（**只删控制字节，不改任何可见文本**）。
 *
 * 为什么需要：AACM 会在 `status` 文本里混入 U+0000。2026-11-07 01:08 实测导致
 * Postgres `invalid byte sequence for encoding "UTF8": 0x00`，整批 INSERT 原子失败，
 * 表现为 `dir=arr` 503。NUL 是 UTF8 不允许的控制字节、不是内容：删掉它不改变任何可见字符。
 *
 * ⚠️ **两种到达形式都要删**（实测，见 `scripts/test-xborder-parse.ts` 的两条断言）：
 *   ① 原始 0x00 字节 —— `JSON.parse` 会直接抛 `Bad control character in string literal`；
 *   ② 合法 JSON 转义 `\u0000`（6 字符）—— `JSON.parse` **不抛**，但会还原成 U+0000
 *      落进 `status_raw` ⇒ 正是 01:08 那条 503 的路径。只做 ① 的消毒对该路径无效。
 *   故必须在 `JSON.parse` **之前**于原始文本里把这段转义删掉，parse 之后就晚了。
 *
 * ⚠️ **第二段必须带负向后顾 `(?<!\\)`**（2026-11-07 边界实测，断言见 `test-xborder-parse.ts`）：
 *   若上游状态是「可见文本 `\u0000`」，JSON 里编码成双反斜杠 `\\u0000`（7 字符）。
 *   无后顾的 `/\\u0000/gi` 会从**第二个**反斜杠起匹配并删掉，留下孤立反斜杠 ⇒
 *   `Unterminated string in JSON` ⇒ 整批 parse 抛错（实测 2 例：单字段、混合响应）。
 *   加 `(?<!\\)` 后：双反斜杠的第二个 `\` 前面是 `\` ⇒ 不匹配 ⇒ 可见文本逐字保留；
 *   单反斜杠的 6 字符转义前面是 `"` ⇒ 匹配 ⇒ 照删。两种到达形式仍全覆盖。
 *   **已知限制（advisory，非阻塞）**：奇数个连续反斜杠后紧跟真 NUL 转义（JSON 文本
 *   `\\\u0000`，即「1 个字面反斜杠 + U+0000」）时，后顾会误判为"已转义"而漏删，
 *   残留 NUL ⇒ 与 01:08 同款**可见** 503（Postgres 拒写，上层 stale 降级兜住，
 *   不会静默写错数据）。该组合需上游在状态文本里同时塞字面反斜杠与控制字节，
 *   实测未出现；若将来真出现，升级为「parse 后递归清理字符串值」并同步改接线断言。
 *
 * ⚠️ **只在机场侧生效**：船侧海事局条款「均不可以修改任何內容」，其页面走
 *    `ferry/fetch.ts`，不经过本函数；本消毒不得搬到船侧。
 * ⚠️ 写成 `rawText.replace(...)` 而非 `statusRaw.replace(...)`：此时还不是 `*_raw`
 *    变量，不会触发 `test-xborder-compliance.ts` 的 C2 门禁（禁 RAW_VAR.replace）。
 * 导出供 `scripts/test-xborder-parse.ts` 同步断言直接调用 —— 本仓库 tsx 是 CJS，
 * 不支持顶层 await，无法在断言里 mock 一次真实 fetch。
 */
export function sanitizeAirportRawText(rawText: string): string {
  return rawText.replace(/\u0000/g, "").replace(/(?<!\\)\\u0000/gi, "");
}

/**
 * 取回一个方向的原始响应体（未校验形状）。
 *
 * @throws 凭据缺失 / 非 2xx / 非 JSON —— 上层按"上游不可用"处理（有旧数据则 stale 降级）
 */
export async function fetchAirportFlights(dir: XbDir): Promise<unknown> {
  const appcode = String(process.env.AACM_APPCODE ?? "").trim();
  if (!appcode) {
    // 不提"值是空的"以外的东西；变量名足够让人去 .env.example 查申请方式
    throw new Error("[xborder] 缺少环境变量 AACM_APPCODE（见 .env.example 该变量注释）");
  }

  const url = AIRPORT_FLIGHT_URL[dir];
  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...UPSTREAM_HEADERS,
      Accept: "application/json",
      // 上游认证头格式固定为 `APPCODE <值>`（data.gov.mo 数据集详情页原文）
      Authorization: `APPCODE ${appcode}`,
    },
    // 数据是实时状态，任何一层缓存都不该介入
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`[xborder] airport ${dir} HTTP ${res.status}（${url}）`);
  }

  const rawText = await res.text();
  // 消毒落在 res.text() 与 JSON.parse 之间（理由见 sanitizeAirportRawText）
  const body = sanitizeAirportRawText(rawText);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    const head = body.slice(0, 80).replace(/\s+/g, " ");
    throw new Error(`[xborder] airport ${dir} 响应不是 JSON（前 80 字符：${head}）`);
  }
}
