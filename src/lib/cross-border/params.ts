/**
 * 入参解析（src/lib/cross-border/params.ts）—— 纯函数，**不做静默纠正**
 *
 * 两个端点共用同一套规则，故集中在这里。路由里不许再写一份 ——
 * 两处各写一份的典型症状是"机场端点拒绝 `limit=0`、船端点默默当成 200"。
 *
 * ── 三条硬规则（契约 §2.2 / §2.3 / §2.6）────────────────────────────────
 *   ① `limit` **越界返回 null（上层回 400），不静默截断**。
 *      静默截断会让 `limit=999` 的调用方以为拿到了全部（少 799 条却毫无信号）。
 *   ② `limit` 必须是**纯十进制整数**：`"5.5"` / `"5 "`（带尾空格的原始值其实已被 trim）/
 *      `"0x10"` / `"1e3"` 全部拒绝。用 `Number()` 会把这些都放过去，故只认正则。
 *   ③ 缺省值只在**真缺省**（`null`）时生效；传了非法值（`limit=abc`）必须 400，
 *      不能"当作没传"—— 否则前端拼错参数时永远发现不了。
 */
import type { PierCode, XbAfter, XbDir } from "./types";

/** `limit` 上限。需求 5 只要 5 条，需求 6 一天最多 333 行，200 足够且能挡住放大攻击 */
export const LIMIT_MAX = 200;
export const LIMIT_DEFAULT = 200;

/** `dir`：只认 `dep` / `arr`。缺失或越界 ⇒ null（⇒ 400） */
export function parseDir(v: string | null): XbDir | null {
  const s = (v ?? "").trim();
  return s === "dep" || s === "arr" ? s : null;
}

/** `pier`：只认 `PE` / `TP` / `PI`（上游 `local` 参数原值） */
export function parsePier(v: string | null): PierCode | null {
  const s = (v ?? "").trim().toUpperCase();
  return s === "PE" || s === "TP" || s === "PI" ? s : null;
}

/** `after`：缺省 ⇒ `day`（需求 6 的"当日所有"）；非法值 ⇒ null（⇒ 400） */
export function parseAfter(v: string | null): XbAfter | null {
  const s = (v ?? "").trim();
  if (s === "") return "day";
  return s === "now" || s === "day" ? s : null;
}

/** `limit`：缺省 ⇒ 200；非纯整数 / <1 / >200 ⇒ null */
export function parseLimit(v: string | null): number | null {
  const s = (v ?? "").trim();
  if (s === "") return LIMIT_DEFAULT;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1 || n > LIMIT_MAX) return null;
  return n;
}
