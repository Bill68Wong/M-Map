/**
 * 澳门时间（src/lib/cross-border/time.ts）—— 纯算术，**不依赖 ICU / 宿主时区**
 *
 * ── 为什么不用 `toLocaleString('zh-MO', {timeZone:'Asia/Macau'})` ──────
 *   三个环境跑同一份代码：Node 服务端、`tsx` 脚本（断言）、将来可能的 Edge。
 *   `Intl` 的输出随**宿主 ICU 版本与 locale 数据**变化（`en-CA` 给 `YYYY-MM-DD`
 *   这件事本身就是实现细节），而本项目对日期口径的要求是"解析结果必须能与
 *   上游 `DD-MM-YYYY` 逐日比对"。用一个会随环境变的 API 去钉一个必须不变的量，
 *   是自找静默分叉。
 *
 *   澳门自 1980 年起**没有夏令时**，常年 UTC+8（无例外）⇒ 固定偏移的纯算术
 *   在可预见范围内是正确的，且**完全确定**（同输入同输出，任何机器都一样）。
 *   若将来澳门恢复夏令时（无任何迹象），本文件的 `MACAU_OFFSET_MS` 需要重审 ——
 *   这是本文件唯一的假设，写在这里而不是散落在各处。
 *
 * ── 约定 ──────────────────────────────────────────────────────────────
 *   · 日期一律 `YYYY-MM-DD`（澳门本地），时刻一律 `HH:MM`；
 *   · `sched_at` 存 `TIMESTAMPTZ`（UTC 瞬时值），由 `macauStampToUtc()` 合成；
 *   · 对外 `serverNow` 必须带 `+08:00` 偏移（前端据此算"还有几分钟"，
 *     不能依赖浏览器时钟 —— 两端时钟差会让"最近五班"看起来少一班）。
 */

/** 澳门恒定偏移（UTC+8，无夏令时）。改这个值前先读文件头。 */
export const MACAU_OFFSET_MS = 8 * 60 * 60 * 1000;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 把瞬时值平移到"澳门墙上时间"的一套 UTC getter 上使用 */
function shifted(at: Date | number): Date {
  return new Date((typeof at === "number" ? at : at.getTime()) + MACAU_OFFSET_MS);
}

/** 澳门本地日期 `YYYY-MM-DD` */
export function macauDate(at: Date | number = Date.now()): string {
  const d = shifted(at);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 澳门本地时刻 `HH:MM` */
export function macauHhMm(at: Date | number = Date.now()): string {
  const d = shifted(at);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * 澳门本地 ISO 8601，**带 `+08:00` 偏移**（`2026-11-06T23:52:10+08:00`）。
 * 不用 `toISOString()`（那是 `Z` 结尾的 UTC，前端拿它直接显示会差 8 小时）。
 */
export function macauIso(at: Date | number = Date.now()): string {
  const d = shifted(at);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}+08:00`
  );
}

/**
 * `(YYYY-MM-DD, HH:MM)` → UTC 瞬时（澳门本地时间解释）。
 * 非法入参返回 null（**不抛** —— 校验由调用方按"解析失败即抛"的粒度决定）。
 */
export function macauStampToUtc(date: string, hhmm: string): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!dm || !tm) return null;
  const y = Number(dm[1]);
  const mo = Number(dm[2]);
  const da = Number(dm[3]);
  const h = Number(tm[1]);
  const mi = Number(tm[2]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const utc = Date.UTC(y, mo - 1, da, h, mi) - MACAU_OFFSET_MS;
  const d = new Date(utc);
  // 回代校验：拒绝 2026-02-30 这类"看起来合法"的日期（Date.UTC 会自动进位）
  if (macauDate(utc) !== date || macauHhMm(utc) !== hhmm) return null;
  return d;
}

/** 两个 `YYYY-MM-DD` 相差的天数（后 − 前）；口径错时用它做"相差 > 1 天就抛"的断言 */
export function daysBetween(fromDate: string, toDate: string): number | null {
  const a = macauStampToUtc(fromDate, "00:00");
  const b = macauStampToUtc(toDate, "00:00");
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** `YYYY-MM-DD` 加 n 天（可为负）；非法入参返回 null */
export function addDays(date: string, n: number): string | null {
  const d = macauStampToUtc(date, "00:00");
  if (!d) return null;
  return macauDate(d.getTime() + n * 86_400_000);
}

/** `HH:MM` → 当日分钟数；非法返回 null。船的"跨午夜判定"靠它比较顺序 */
export function hhMmToMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
