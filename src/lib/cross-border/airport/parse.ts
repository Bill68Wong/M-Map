/**
 * 机场 FIDS 响应 → 待入库行（src/lib/cross-border/airport/parse.ts · 纯函数）
 *
 * ── 为什么解析必须先于联网完成 ──────────────────────────────────────────
 *   出问题时"到底是解析错了还是上游变了"分不清，是这类接入最常见的时间黑洞。
 *   故本文件**零 IO**：喂固定 JSON 就能断言（`scripts/test-xborder-parse.ts`）。
 *
 * ── ★ 两个日期坑（照 §1.4 实现，别自己重新推）───────────────────────────
 *   ① `date` 是 **DD-MM-YYYY**：实测 `06-11-2026` 而抓取日是 2026-11-06
 *      ⇒ 只有 DD-MM-YYYY 读法自洽。按 MM-DD 读会得到 6 月 11 日。
 *      并且加**硬断言**：解析结果与"抓取时刻的澳门日期"相差 > 1 天 ⇒ 抛错，不猜。
 *      （这一条能在上游悄悄换格式时立刻炸，而不是让 6 月的数据混进 11 月的表。）
 *   ② `time` 的前缀是 **DD-MM** 不是 MM-DD：实测 `06-11 08:00`。
 *      两条字段必须指向同一天 ⇒ 前缀与 `date` 同序；前缀与 `date` 不一致 ⇒ 抛错。
 *      ⚠️ **不要**用 `time` 前缀拼日期，日期一律以 `date` 为准，`time` 只取 `HH:MM`。
 *
 * ── 三条"失败即抛"的取舍 ───────────────────────────────────────────────
 *   · **空数组 ⇒ 抛**：该接口返回的是"当日全量"，实际永远非空（实测 72/73 条）。
 *     空数组几乎只能是上游异常；若当成功处理，`voided_at` 判定会把当日未来班次
 *     全部标失效（一次异常 = 清空"当日所有"）。
 *   · **字段缺失 ⇒ 抛**：`place` / `flightNo` 是业务必需，缺了就无法展示也无法做唯一键。
 *   · **同一响应内业务键重复 ⇒ 去重 + warn**：不抛。原因是 Postgres 的
 *     `ON CONFLICT DO UPDATE` 不接受同一语句内重复键（会直接报错），
 *     而上游偶发重复行不该让整个刷新失败（宁可留一条 + 日志）。
 */
import { classify, warnOnStatusDrift } from "../status";
import { daysBetween, hhMmToMinutes, macauDate, macauStampToUtc } from "../time";
import type { FlightUpsertRow, XbDir } from "../types";

const DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/;
const TIME_RE = /^(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/;

/**
 * 失败即抛。
 * ⚠️ 必须是 `function` 声明而不是 `const` 箭头函数：TS 的 never-返回值控制流收窄
 *   只对「函数声明」与「带显式类型标注的 const」生效，写成 `const fail = (m): never => {}`
 *   时 `if (!x) fail(...)` 之后 **不会**把 x 收窄，编译期就会报 "possibly null"。
 */
function fail(msg: string): never {
  throw new Error(`[xborder] airport parse: ${msg}`);
}

/** 上游一个条目（字段都可能缺，故全 optional，逐个校验） */
interface RawFlight {
  date?: unknown;
  time?: unknown;
  flightNo?: unknown;
  airline?: unknown;
  destination?: unknown;
  origin?: unknown;
  gate?: unknown;
  status?: unknown;
}

/** 只做 trim：判空/对齐用。机场侧无"不得修改"条款，但也没有改写文本的理由 */
const text = (v: unknown): string => String(v ?? "").trim();

/**
 * `DD-MM-YYYY` → `YYYY-MM-DD`。与抓取日相差 > 1 天 ⇒ 抛。
 * 允许 ±1 天是因为采集中跨午夜时，上游可能还挂着"昨天"的末班（或已换到"明天"）。
 */
function parseUpstreamDate(raw: string, today: string): string {
  const m = DATE_RE.exec(raw);
  if (!m) fail(`date 格式不是 DD-MM-YYYY：${JSON.stringify(raw)}`);
  const [, dd, mm, yyyy] = m;
  const iso = `${yyyy}-${mm}-${dd}`;
  if (!macauStampToUtc(iso, "00:00")) fail(`date 不是合法日历日：${JSON.stringify(raw)}`);
  const diff = daysBetween(today, iso);
  if (diff === null || Math.abs(diff) > 1)
    fail(`date 与抓取日相差 ${String(diff)} 天（>1）：date=${raw} today=${today}`);
  return iso;
}

/**
 * `DD-MM HH:MM` → `HH:MM`，并校验前缀与 `date` 的 DD-MM 一致。
 * @param isoDate 已解析的 `YYYY-MM-DD`（以 `date` 为准）
 */
function parseUpstreamTime(raw: string, isoDate: string, rawDate: string): string {
  const m = TIME_RE.exec(raw);
  if (!m) fail(`time 格式不是 "DD-MM HH:MM"：${JSON.stringify(raw)}`);
  const [, dd, mm, hh, mi] = m;
  const hhmm = `${hh}:${mi}`;
  if (hhMmToMinutes(hhmm) === null) fail(`time 时刻越界：${JSON.stringify(raw)}`);
  // 前缀与 date 必须同一天：不一致说明上游两个字段打架，不猜哪个对
  const expectPrefix = `${isoDate.slice(8, 10)}-${isoDate.slice(5, 7)}`;
  if (`${dd}-${mm}` !== expectPrefix)
    fail(`time 前缀 ${dd}-${mm} 与 date ${rawDate}（${isoDate}）不一致`);
  return hhmm;
}

/**
 * 闸口归一：空串 → null；字面量 `0` → null。
 *
 * 为什么 `0` 要变 null：实测离澳有 1 条 `gate` = `"0"`，语义是**尚未分配**。
 * 原样下发会让 UI 显示"闸口 0"（一个不存在的登机口）。机场侧没有"不得修改"条款，
 * 且闸口是编号而非叙述文本 ⇒ 在这里归一为"无"，比让三个端各自判断更安全。
 */
function gateOf(v: unknown): string | null {
  const s = text(v);
  return s === "" || s === "0" ? null : s;
}

/**
 * 解析整个响应。
 *
 * @param raw         上游 JSON（未知形状，逐字段校验）
 * @param direction   `dep` / `arr`（决定取 `destination` 还是 `origin`）
 * @param collectedAt 本轮采集时刻（用于日期合理性断言与 `date` 的基准日）
 */
export function parseAirportFlights(
  raw: unknown,
  direction: XbDir,
  collectedAt: Date = new Date(),
): FlightUpsertRow[] {
  if (!Array.isArray(raw)) fail(`响应不是数组：${typeof raw}`);
  const list = raw as RawFlight[];
  if (list.length === 0) fail("响应是空数组（该接口返回当日全量，正常不会为空）⇒ 视为上游异常");

  const today = macauDate(collectedAt);
  const seen = new Set<string>();
  const rows: FlightUpsertRow[] = [];
  let dupes = 0;

  for (const [idx, item] of list.entries()) {
    if (typeof item !== "object" || item === null) fail(`第 ${idx} 条不是对象`);

    const rawDate = text(item.date);
    const rawTime = text(item.time);
    const flightNo = text(item.flightNo).toUpperCase();
    if (!rawDate) fail(`第 ${idx} 条缺 date`);
    if (!rawTime) fail(`第 ${idx} 条缺 time`);
    if (!flightNo) fail(`第 ${idx} 条缺 flightNo`);

    const schedDate = parseUpstreamDate(rawDate, today);
    const schedTime = parseUpstreamTime(rawTime, schedDate, rawDate);

    const place = text(direction === "dep" ? item.destination : item.origin);
    if (!place)
      fail(`第 ${idx} 条（${flightNo}）缺 ${direction === "dep" ? "destination" : "origin"}`);

    const statusRaw = text(item.status);
    const verdict = classify("airport", direction, statusRaw);
    const key = `${schedDate}|${flightNo}|${schedTime}`;
    if (seen.has(key)) {
      // 同一语句内重复键会让 ON CONFLICT 报错 ⇒ 保留最后一条（状态通常是更新的那条）
      dupes += 1;
      const prev = rows.findIndex(
        (r) => r.schedDate === schedDate && r.flightNo === flightNo && r.schedTime === schedTime,
      );
      if (prev >= 0) rows.splice(prev, 1);
    }
    seen.add(key);

    rows.push({
      schedDate,
      direction,
      flightNo,
      schedTime,
      airlineRaw: text(item.airline) || null,
      placeRaw: place,
      // 抵澳无登机口字段（上游就没有），恒 null
      gateRaw: direction === "dep" ? gateOf(item.gate) : null,
      statusRaw,
      statusKind: verdict.kind as FlightUpsertRow["statusKind"],
      isTerminal: verdict.terminal,
    });
  }

  if (dupes > 0)
    console.warn(
      `[xborder] airport ${direction}: 同一响应内 ${dupes} 条业务键重复（已去重保留最后一条）`,
    );

  warnOnStatusDrift("airport", direction, rows);
  return rows;
}
