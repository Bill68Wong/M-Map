/**
 * 运营状态判定（`serviceStateAt` / `hideBySchedule`）· 单测
 * （scripts/test-service-state.ts · 2026-11-04 · 需求 U8）
 *
 * ── 守的是什么 ────────────────────────────────────────────────────────
 *   「**不在运营时间 且 无车** 才隐藏」——隐藏需要**两份证据**（用户原话是 AND）。
 *   本脚本把五态判定与十二格结论**逐格钉死**，任何一处放宽立刻红灯。
 *
 * ── 为什么样例要写死真实线路形态 ──────────────────────────────────────
 *   线上数据已实测（`route_frequency`）：
 *     · `N3 | daily | 00:00–06:00 | 0–360 | 20~25`（夜班线，07:00 必须已收班）
 *     · `25` 末段 `21:30–01:15`，`to_min = 1515`（**跨午夜**，凌晨 01:00 仍在跑）
 *     · `59` 尖峰专线在 `10:00–15:00` **内部断档** ⇒ 12:00 必须判 `closed` 而非 `no_data`
 *     · `15T` 无平日覆盖 ⇒ 平日判 `closed`
 *   这些形态用合成表复刻（不连库、可离线跑）。
 *
 * ⚠️ 断言的「预期」是**判定口径**，不是「当前实现的输出」——禁止为了变绿改预期。
 *
 * 运行：npm run test:service-state（= tsx scripts/test-service-state.ts）
 */
import { macauNowParts } from "../src/lib/lrt/day-type";
import type { FreqRow, HeadwayIndex } from "../src/lib/recommend/headway";
import {
  hideBySchedule,
  holidayFallbackOf,
  serviceStateAt,
  type ServiceState,
} from "../src/lib/recommend/schedule";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    fail++;
    console.error("  ✗ " + msg);
  }
}
function assertEq<T>(got: T, want: T, msg: string) {
  assert(got === want, `${msg}（实际 ${String(got)} / 预期 ${String(want)}）`);
}

const row = (dayType: string, from: number, to: number, span: string): FreqRow => ({
  dayType,
  timeFrom: span.split("-")[0]!,
  timeTo: span.split("-")[1]!,
  fromMin: from,
  toMin: to,
  freqLo: 10,
  freqHi: 15,
});

const byRoute = new Map<string, FreqRow[]>([
  // 夜班线：00:00–06:00
  ["N3", [row("daily", 0, 360, "00:00-06:00")]],
  // 跨午夜末段：21:30–01:15（to_min = 1515 = 次日 01:15）
  [
    "25",
    [row("daily", 360, 1290, "06:00-21:30"), row("daily", 1290, 1515, "21:30-01:15")],
  ],
  // 尖峰专线：10:00–15:00 内部断档
  ["59", [row("daily", 360, 600, "06:00-10:00"), row("daily", 900, 1320, "15:00-22:00")]],
  // 无平日覆盖（只有周六 / 周日及公众假期）
  ["15T", [row("sat", 420, 1200, "07:00-20:00"), row("sun_holiday", 420, 1200, "07:00-20:00")]],
]);

/** 非空假期集合（只为让「假期表可用」这条前提成立；日期不与样例冲突） */
const idx: HeadwayIndex = { byRoute, holidays: new Set(["2026-12-25"]), size: 6 };
/** 假期表不可用（空集合 ⇒ 退化为只按星期判定） */
const idxNoHoliday: HeadwayIndex = { byRoute, holidays: new Set<string>(), size: 6 };

/** 澳门时间 → epoch ms（UTC+8） */
const macau = (ymd: string, hhmm: string): number => Date.parse(`${ymd}T${hhmm}:00+08:00`);

const WED = "2026-11-04"; // 周三
const state = (r: string, now: number, table: HeadwayIndex = idx): ServiceState =>
  serviceStateAt(table, r, now).state;

console.log("serviceStateAt / hideBySchedule · 运营状态判定单测\n");

// ── ⓪ 前提自检：样例日期必须是周三（否则「平日」相关断言失去意义）──
{
  const w = macauNowParts(new Date(macau(WED, "12:00"))).weekday;
  assertEq(w, 3, "前提：2026-11-04 是周三（平日）");
}

// ── ① 五态：跨午夜 / 收班 / 断档 / 无平日覆盖 / 完全无数据 ──
console.log("① 五态判定");
assertEq(state("N3", macau(WED, "03:00")), "open", "N3@03:00 = open（00:00-06:00 窗口内）");
assertEq(state("N3", macau(WED, "07:00")), "closed", "N3@07:00 = closed（超窗口 60 分 > 20 分宽限）");
assertEq(state("25", macau(WED, "01:00")), "open", "25@01:00 = open（跨午夜末段 to_min=1515）");
assertEq(state("25", macau(WED, "03:00")), "before_first", "25@03:00 = before_first（首班 06:00 前）");
assertEq(
  state("59", macau(WED, "12:00")),
  "closed",
  "59@12:00 = closed（内部断档 10:00-15:00 ⇒ 不是 no_data）",
);
assertEq(state("59", macau(WED, "08:00")), "open", "59@08:00 = open（窗口内）");
assertEq(state("15T", macau(WED, "12:00")), "closed", "15T 平日 = closed（无平日 day_type 行）");
assertEq(state("15T", macau("2026-11-08", "12:00")), "open", "15T 周日@12:00 = open（有 sun_holiday 行）");
assertEq(state("N999", macau(WED, "12:00")), "no_data", "完全不在表里的线 = no_data");

// ── ② 末班宽限边界（只挂当日 max(toMin)）──
console.log("② 末班宽限 G_tail = 20 分（边界必须逐分可判）");
assertEq(state("25", macau(WED, "01:15")), "open", "25@01:15 = open（末班窗口上界含等号）");
assertEq(state("25", macau(WED, "01:20")), "closing", "25@01:20 = closing（末班后 +5 分，宽限内）");
assertEq(state("25", macau(WED, "01:35")), "closing", "25@01:35 = closing（末班后 +20 分，宽限上界含等号）");
assertEq(state("N3", macau(WED, "06:20")), "closing", "N3@06:20 = closing（06:00 末班 +20 分内）");

// ── ③ 假期表不可用 ⇒ 不提供隐藏依据（只记诊断 holiday_fallback）──
console.log("③ 假期表不可用（退化分支）");
{
  const at = serviceStateAt(idxNoHoliday, "N3", macau(WED, "07:00"));
  assertEq(at.state, "no_data", "假期表不可用 ⇒ 判 no_data（永不因时间隐藏）");
  assert(at.holidayFallback === true, "假期表不可用 ⇒ 诊断 holiday_fallback = true");
  const ok = serviceStateAt(idx, "N3", macau(WED, "07:00"));
  assert(ok.holidayFallback === false, "假期表可用 ⇒ holiday_fallback = false");
  // 诊断位（结果顶层 `holiday_fallback`）的唯一取值来源
  assertEq(holidayFallbackOf(idxNoHoliday), true, "holidayFallbackOf：假期表空 ⇒ true（诊断位）");
  assertEq(holidayFallbackOf(idx), false, "holidayFallbackOf：假期表可用 ⇒ false");
  assertEq(holidayFallbackOf(undefined), false, "holidayFallbackOf：无班距表 ⇒ false（未做时间判定，不误报）");
}

// ── ④ 十二格判定表（边界逐格）──
console.log("④ 十二格：窗口 × 有车 ⇒ 隐藏与否");
{
  const cases: {
    st: ServiceState;
    has: boolean | null;
    hide: boolean;
    reason?: "closed_none" | "closed_unknown";
  }[] = [
    { st: "open", has: true, hide: false },
    { st: "open", has: false, hide: false },
    { st: "open", has: null, hide: false },
    { st: "closed", has: true, hide: false },
    { st: "closed", has: false, hide: true, reason: "closed_none" },
    { st: "closed", has: null, hide: true, reason: "closed_unknown" },
    { st: "closing", has: true, hide: false },
    { st: "closing", has: false, hide: true, reason: "closed_none" },
    { st: "closing", has: null, hide: false },
    { st: "before_first", has: true, hide: false },
    { st: "before_first", has: false, hide: true, reason: "closed_none" },
    { st: "before_first", has: null, hide: false },
    { st: "no_data", has: false, hide: false },
    { st: "no_data", has: null, hide: false },
  ];
  for (const c of cases) {
    const got = hideBySchedule(c.st, c.has);
    const hasText = c.has === null ? "未知" : c.has ? "有车" : "无车";
    assertEq(
      got.hide,
      c.hide,
      `${c.st} + ${hasText} ⇒ ${c.hide ? "隐藏" : "显示"}`,
    );
    if (c.hide) assertEq(got.reason, c.reason, `${c.st} + ${hasText} ⇒ 诊断 reason`);
  }
}

// ── ⑤ 用户原话的核心：AND 关系（举证责任在「隐藏」一方）──
console.log("⑤ 用户口径：「不在运营时间 且 无车」才隐藏");
assert(
  hideBySchedule("closed", true).hide === false,
  "closed + 有车 ⇒ **必须显示**（末班晚点是合法情形，不得因时间一键隐藏）",
);
assert(
  hideBySchedule("open", false).hide === false,
  "open + 无车 ⇒ 显示（在运营窗口内，不能因为一次没抓到车就隐藏整条线）",
);
assert(
  hideBySchedule("no_data", false).hide === false,
  "no_data + 无车 ⇒ 显示（永不因时间隐藏；无数据不等于不营运）",
);

console.log("\n" + (fail === 0 ? "✅ 全部通过" : "❌ 有失败") + "：pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
