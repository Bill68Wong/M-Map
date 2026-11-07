/**
 * 终态判定 + 空态判定 + 入参解析 断言（scripts/test-xborder-status.ts）
 *
 * ── 守的是什么（契约 §2.10.5 / §2.5 / §2.2-2.3）────────────────────────
 *   ① **方向敏感**：`已啟航` 在离澳是终态、在抵澳是"马上到"。写错的话抵澳板会整片空白，
 *      而"空着"看起来很正常，没人会报 bug ⇒ 必须由断言钉死。
 *   ② **未知兜底方向**：未知状态必须归**非终态**（宁可多显示，不可漏显示）。
 *   ③ **SQL 侧与分类侧同源**：`TERMINAL_KINDS` 是给 SQL 用的，`classify()` 是给展示用的。
 *      两者一旦不一致，症状是"响应说没终态、SQL 已把它剔除"，同样静默。
 *      故这里做**双向等值断言**：对每个探针文本，`classify().terminal` 必须等于
 *      `TERMINAL_KINDS` 是否包含该 kind。
 *   ④ **白名单覆盖（内联样本表）**：独立列出每种实测状态文本及其期望 `(kind, terminal)`，
 *      逐条断言 `classify()` 的输出。**与 fixture 解耦** —— 逐字节真实快照在凌晨
 *      97% 是字面量 `0`，若靠「数 fixture 里的行」来守白名单，删光白名单也能全绿。
 *      期望值刻意不导出自 `status.ts#TABLES`（那是「拿实现测实现」，断言永远绿）。
 *      我们自己改正则时，漏哪条红哪条 —— 这正是白名单方案的主要价值。
 *   ⑤ **空态三值互斥** + `after=day` 永不返回 `none_remaining_today`。
 *
 * 运行：npm run test:xborder-status
 */
import fs from "node:fs";
import path from "node:path";
import { parseAirportFlights } from "../src/lib/cross-border/airport/parse";
import { parseFerrySailings } from "../src/lib/cross-border/ferry/parse";
import {
  LIMIT_DEFAULT,
  LIMIT_MAX,
  parseAfter,
  parseDir,
  parseLimit,
  parsePier,
} from "../src/lib/cross-border/params";
import {
  buildListResponse,
  CACHE_HEADERS,
  resolveEmptyReason,
} from "../src/lib/cross-border/respond";
import { classify, TERMINAL_KINDS, UNKNOWN_DRIFT_THRESHOLD } from "../src/lib/cross-border/status";
import type { XbDir } from "../src/lib/cross-border/types";

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
function assertThrows(fn: () => void, re: RegExp, msg: string) {
  try {
    fn();
    assert(false, `${msg}（未抛错）`);
  } catch (e) {
    const m = (e as Error).message;
    assert(re.test(m), `${msg}（抛出的信息：${m}）`);
  }
}

const FIXTURES = path.resolve(process.cwd(), "scripts/fixtures/xborder");
const readText = (f: string) => fs.readFileSync(path.join(FIXTURES, f), "utf8");
/** fixture 的采集时刻：2026-11-06 23:20 澳门时间（= 快照实际抓取时段） */
const AT = new Date("2026-11-06T23:20:00+08:00");

console.log("跨境交通 · 终态/空态/入参 断言\n");

/* ══════════════════════════════════════════════════════════════════
 * A. 三条反直觉事实（写错任何一条都是用户可见的错）
 * ══════════════════════════════════════════════════════════════════ */
console.log("A. 方向敏感（同一句状态在两个方向含义相反）");

// ① 已啟航：离澳 = 走了（终态）；抵澳 = 已从始发地起飞、马上到（非终态）
assertEq(
  classify("airport", "dep", "已啟航 08:20").kind,
  "departed",
  "离澳「已啟航 08:20」⇒ departed",
);
assertEq(
  classify("airport", "dep", "已啟航 08:20").terminal,
  true,
  "离澳「已啟航」是**终态**（用户赶不上）",
);
assertEq(
  classify("airport", "arr", "已啟航 預計到達 21:30").kind,
  "departed",
  "抵澳「已啟航 預計到達 21:30」⇒ departed（同为 departed）",
);
assertEq(
  classify("airport", "arr", "已啟航 預計到達 21:30").terminal,
  false,
  "抵澳「已啟航 預計到達」是**非终态**（马上落地，必须显示）",
);
assertEq(
  classify("ferry", "arr", "已啟航").terminal,
  false,
  "到港「已啟航」（对方港已开出）非终态",
);
assertEq(classify("ferry", "dep", "16:32 啟航").terminal, true, "离港「16:32 啟航」是终态");

// ② 取消两种写法
assertEq(classify("airport", "dep", "已取消").kind, "cancelled", "离澳写作「已取消」");
assertEq(
  classify("airport", "arr", "航班取消").kind,
  "cancelled",
  "抵澳写作「航班取消」（不能只匹配一个）",
);
assertEq(
  classify("airport", "dep", "航班取消").terminal,
  true,
  "离澳也认「航班取消」（防御性：两种都认）",
);
assertEq(classify("airport", "arr", "已取消").terminal, true, "抵澳也认「已取消」");

// ③ `0` 不是空串：必须 unknown 且**非终态**（行保留、状态原样显示）
assertEq(classify("airport", "arr", "0").kind, "unknown", "字面量 `0` ⇒ unknown");
assertEq(classify("airport", "arr", "0").terminal, false, "字面量 `0` 非终态（不剔除该行）");
assertEq(classify("airport", "arr", "").kind, "unknown", "空串 ⇒ unknown");
assertEq(
  classify("airport", "dep", "  停止登機  ").kind,
  "boarding_closed",
  "两侧空白用 trim 容忍",
);

// 其余实测形态
assertEq(
  classify("airport", "dep", "櫃檯 A10-A12 已開放").kind,
  "checkin_open",
  "柜台开放形态（A10-A12）",
);
assertEq(
  classify("airport", "dep", "櫃檯 B5 已開放").kind,
  "checkin_open",
  "柜台开放形态（单号 B5）",
);
assertEq(
  classify("airport", "dep", "航班延誤至 18:40").kind,
  "delayed",
  "延误（前缀匹配，容忍后续变化）",
);
assertEq(classify("airport", "dep", "航班延誤").kind, "delayed", "延误（无后续内容也认）");
assertEq(classify("airport", "arr", "航班著陸 21:28").kind, "landed", "抵澳「航班著陸」");
assertEq(classify("ferry", "dep", "待航").kind, "pending", "离港「待航」");
assertEq(
  classify("ferry", "arr", "待航").kind,
  "pending",
  "到港「待航」也是 pending（真实快照 8 行里 4 行是它，抄漏就全 unknown）",
);
assertEq(classify("ferry", "arr", "預計 20:35 到達").kind, "eta", "到港「預計 HH:MM 到達」");
assertEq(classify("ferry", "arr", "17:35 到達").kind, "arrived", "到港「HH:MM 到達」");
assertEq(
  classify("ferry", "dep", "16:32啟航").kind,
  "departed",
  "离港无空格写法也认（容忍空格差异）",
);

/* ══════════════════════════════════════════════════════════════════
 * B. SQL 侧终态集合与 classify 同源（双向等值）
 * ══════════════════════════════════════════════════════════════════ */
console.log("\nB. TERMINAL_KINDS 与 classify() 同源（SQL 与展示不得各说一套）");

/** 覆盖每个 (source, dir) 会出现的全部 kind 的探针文本 */
const PROBES: Record<"airport" | "ferry", Record<XbDir, string[]>> = {
  airport: {
    dep: [
      "已啟航 08:20",
      "航班著陸 09:00",
      "已取消",
      "航班取消",
      "停止登機",
      "櫃檯 A10-A12 已開放",
      "航班延誤至 18:40",
      "",
      "0",
    ],
    arr: ["航班著陸 21:28", "已取消", "航班取消", "已啟航 預計到達 21:30", "0", ""],
  },
  ferry: {
    dep: ["16:32 啟航", "待航", "已啟航", "", "0"],
    arr: ["17:35 到達", "預計 20:35 到達", "已啟航", "待航", ""],
  },
};

for (const source of ["airport", "ferry"] as const) {
  for (const dir of ["dep", "arr"] as const) {
    const terminalKinds = TERMINAL_KINDS[source][dir];
    const bad: string[] = [];
    for (const raw of PROBES[source][dir]) {
      const v = classify(source, dir, raw);
      const inSqlSet = terminalKinds.includes(v.kind);
      if (v.terminal !== inSqlSet)
        bad.push(`${JSON.stringify(raw)}=${v.kind}/terminal=${v.terminal}/sql=${inSqlSet}`);
    }
    assertEq(
      bad.length,
      0,
      `${source}/${dir}：每个探针的 terminal 都等于"kind 是否在 SQL 终态集合里"${bad.length ? " 违例：" + bad.join(", ") : ""}`,
    );
    // 反向：集合里每个 kind 都必须真的能被 classify 产出为终态，否则就是死条目
    const produced = PROBES[source][dir].map((t) => classify(source, dir, t));
    const deadKinds = terminalKinds.filter(
      (k) => !produced.some((v) => v.kind === k && v.terminal),
    );
    assertEq(
      deadKinds.length,
      0,
      `${source}/${dir}：SQL 终态集合里的每个 kind 都有真实终态来源${deadKinds.length ? " 死条目：" + deadKinds.join(",") : ""}`,
    );
  }
}

// 反向陷阱：airport.dep 与 airport.arr 的终态集合**必须不同**（departed 只在前者是终态）
assert(
  JSON.stringify(TERMINAL_KINDS.airport.dep) !== JSON.stringify(TERMINAL_KINDS.airport.arr),
  "机场离/抵的终态集合不同（若相等，说明 departed 被误当成两向通用终态）",
);
assert(!TERMINAL_KINDS.airport.arr.includes("departed"), "抵澳终态集合**不含** departed");

/* ══════════════════════════════════════════════════════════════════
 * C. 白名单覆盖（内联样本表，与 fixture 解耦）
 * ══════════════════════════════════════════════════════════════════ */
console.log("\nC. 白名单覆盖（§2.10.5 ① · 内联样本表）");
// ★ 为什么不数 fixture：旧写法数 `airport-*.json` 里各 status_kind 的行数
//   （72/73 条、unknown 精确 0/6）。但 2026-11-07 01:17 的逐字节真实快照里
//   97% 状态是字面量 `0` ⇒ 8 种已知状态文本几乎都不出现，白名单即使被删光也能全绿。
//   ⇒ 断言挂错了载体：改为独立列出每种实测状态文本 + 期望 (kind, terminal)，
//   逐条直接断言 classify()。漏哪条红哪条，且完全不受上游某时刻数据形态影响。
// ⚠️ 期望值刻意不从 `status.ts#TABLES` 自动导出 —— 那会变成「拿实现测实现」，断言永远绿。
interface KnownStatus {
  source: "airport" | "ferry";
  dir: XbDir;
  text: string;
  kind: string;
  terminal: boolean;
  from: string;
}
const KNOWN_STATUSES: readonly KnownStatus[] = [
  // 机场离澳（调研文档 2026-11-06 20:31 实测状态文本）
  { source: "airport", dir: "dep", text: "已啟航 08:20", kind: "departed", terminal: true, from: "实测 57 条" },
  { source: "airport", dir: "dep", text: "停止登機", kind: "boarding_closed", terminal: false, from: "实测 8 条" },
  { source: "airport", dir: "dep", text: "櫃檯 A10-A12 已開放", kind: "checkin_open", terminal: false, from: "实测 4 条" },
  { source: "airport", dir: "dep", text: "航班延誤至 18:40", kind: "delayed", terminal: false, from: "实测 2 条" },
  { source: "airport", dir: "dep", text: "已取消", kind: "cancelled", terminal: true, from: "实测 1 条" },
  // 机场抵澳
  { source: "airport", dir: "arr", text: "航班著陸 09:09", kind: "landed", terminal: true, from: "实测 62 条" },
  { source: "airport", dir: "arr", text: "航班取消", kind: "cancelled", terminal: true, from: "实测 1 条" },
  { source: "airport", dir: "arr", text: "已啟航 預計到達 21:12", kind: "departed", terminal: false, from: "实测 4 条（非终态）" },
  { source: "airport", dir: "arr", text: "0", kind: "unknown", terminal: false, from: "实测 6 条字面量 0 + 凌晨快照 97%" },
  // 船（真实快照逐字节）
  { source: "ferry", dir: "dep", text: "17:04 啟航", kind: "departed", terminal: true, from: "ferry-dep-PE.html 首行" },
  { source: "ferry", dir: "dep", text: "待航", kind: "pending", terminal: false, from: "ferry-dep-PE.html 末尾 3 行" },
  { source: "ferry", dir: "arr", text: "21:30 到達", kind: "arrived", terminal: true, from: "ferry-arr-tp.html 首行" },
  { source: "ferry", dir: "arr", text: "預計 20:35 到達", kind: "eta", terminal: false, from: "§2.10.3 词表" },
  { source: "ferry", dir: "arr", text: "已啟航", kind: "departed", terminal: false, from: "§2.10.3 非终态" },
  { source: "ferry", dir: "arr", text: "待航", kind: "pending", terminal: false, from: "ferry-arr-tp.html 4 行" },
];
for (const s of KNOWN_STATUSES) {
  const v = classify(s.source, s.dir, s.text);
  assertEq(v.kind, s.kind, `${s.source}.${s.dir} 「${s.text}」⇒ kind=${s.kind}（${s.from}）`);
  assertEq(
    v.terminal,
    s.terminal,
    `${s.source}.${s.dir} 「${s.text}」⇒ terminal=${s.terminal}（${s.from}）`,
  );
}
// 独立期望：样本表必须覆盖全部 10 个 kind（硬编码，不从 status.ts 导出）
assertEq(
  [...new Set(KNOWN_STATUSES.map((s) => s.kind))].sort().join(","),
  "arrived,boarding_closed,cancelled,checkin_open,delayed,departed,eta,landed,pending,unknown",
  "样本表覆盖全部 10 个 kind（独立硬编码期望，删样本会红）",
);
assertEq(KNOWN_STATUSES.length, 15, "内联样本表 15 条实测状态文本");

// ── 船的 fixture 覆盖率：两份**真实快照**里 unknown 必须为 0 ──
//   （这条断言的价值就从这里体现过：`到港待航` 曾被白名单抄漏，快照一跑就 4/8 未知）
const sailDep = parseFerrySailings(readText("ferry-dep-PE.html"), "PE", "dep", AT);
const sailArr = parseFerrySailings(readText("ferry-arr-tp.html"), "TP", "arr", AT);
assertEq(sailDep.length, 10, "外港离港快照 10 条");
assertEq(sailArr.length, 8, "氹仔到港快照 8 条");
assertEq(sailDep.filter((r) => r.statusKind === "unknown").length, 0, "离港快照 unknown 数 = 0");
assertEq(
  sailArr.filter((r) => r.statusKind === "unknown").length,
  0,
  "到港快照 unknown 数 = 0（含 4 条「待航」）",
);

/* ══════════════════════════════════════════════════════════════════
 * D. 空态三值互斥 + after=day 的禁忌
 * ══════════════════════════════════════════════════════════════════ */
console.log("\nD. 空态三值与 buildListResponse");
const base = {
  after: "now" as const,
  serverNow: "2026-11-06T23:52:10+08:00",
  stale: false,
  scope: "t",
};
const ATTR = { text: "x", acquiredOn: "2026-11-06" };

assertEq(
  resolveEmptyReason({ ...base, itemCount: 3, dayTotal: 3, dataFetchedAt: "s", scope: "t" }),
  undefined,
  "有数据 ⇒ 无 emptyReason",
);
assertEq(
  resolveEmptyReason({ ...base, itemCount: 0, dayTotal: 12, dataFetchedAt: "s", scope: "t" }),
  "none_remaining_today",
  "after=now 且当日有班但全走完 ⇒ none_remaining_today",
);
assertEq(
  resolveEmptyReason({ ...base, itemCount: 0, dayTotal: 0, dataFetchedAt: "s", scope: "t" }),
  "no_service_today",
  "采到了但当日 0 班 ⇒ no_service_today",
);
assertEq(
  resolveEmptyReason({ ...base, itemCount: 0, dayTotal: 0, dataFetchedAt: null, scope: "t" }),
  "not_yet_collected",
  "从未采到 ⇒ not_yet_collected（我方故障，与「没有班次」不同）",
);

// ★ 禁忌：after=day 出现 none_remaining_today 就是终态过滤被误加到了 day 分支
assertEq(
  resolveEmptyReason({
    ...base,
    after: "day",
    itemCount: 0,
    dayTotal: 12,
    dataFetchedAt: "s",
    scope: "t",
  }),
  "no_service_today",
  "after=day 且 dayTotal>0 的**不可达分支**不得返回 none_remaining_today（返回 no_service_today 并打 error 日志）",
);

const withItems = buildListResponse({
  ...base,
  items: [1, 2],
  dayTotal: 2,
  dataFetchedAt: "s",
  attribution: ATTR,
});
assertEq("emptyReason" in withItems, false, "有数据时 emptyReason **字段缺席**（不是 null）");

const emptyResp = buildListResponse({
  ...base,
  items: [],
  dayTotal: 5,
  dataFetchedAt: "s",
  attribution: ATTR,
});
assertEq(emptyResp.emptyReason, "none_remaining_today", "空列表时字段存在且有值");
assertEq(emptyResp.ok, true, "空态仍是 ok:true（永不 204/500）");
assertEq(emptyResp.items.length, 0, "items 是空数组（形状不变）");

// 缓存头必须同时有 max-age 与 s-maxage
for (const k of ["airport", "ferry"] as const) {
  const cc = CACHE_HEADERS[k]["Cache-Control"];
  assert(/max-age=\d+/.test(cc), `${k} 缓存头含 max-age（只写 s-maxage 会被 Vercel 剥掉）`);
  assert(/s-maxage=\d+/.test(cc), `${k} 缓存头含 s-maxage`);
  assert(/stale-while-revalidate=\d+/.test(cc), `${k} 缓存头含 stale-while-revalidate`);
}
assertEq(CACHE_HEADERS.stale["Cache-Control"], "no-store", "stale 降级响应必须 no-store");

/* ══════════════════════════════════════════════════════════════════
 * E. 入参解析（不静默纠正）
 * ══════════════════════════════════════════════════════════════════ */
console.log("\nE. 入参解析");
assertEq(parseDir("dep"), "dep", "dir=dep");
assertEq(parseDir(" arr "), "arr", "dir 两侧空白容忍");
assertEq(parseDir("0"), null, "dir=0 ⇒ null（巴士的 0/1 不能混进来）");
assertEq(parseDir(null), null, "dir 缺失 ⇒ null（必填）");
assertEq(parsePier("pe"), "PE", "pier 归一为大写");
assertEq(parsePier("HK"), null, "pier=HK ⇒ null（只允许 PE/TP/PI）");
assertEq(parseAfter(null), "day", "after 缺省 ⇒ day（需求 6）");
assertEq(parseAfter("now"), "now", "after=now");
assertEq(parseAfter("today"), null, "after 非法值 ⇒ null（不当作缺省）");
assertEq(parseLimit(null), LIMIT_DEFAULT, "limit 缺省 ⇒ 200");
assertEq(parseLimit("5"), 5, "limit=5");
assertEq(parseLimit("0"), null, "limit=0 ⇒ null（不静默当 200）");
assertEq(parseLimit(String(LIMIT_MAX + 1)), null, "limit 超上限 ⇒ null（不静默截断）");
assertEq(parseLimit("5.5"), null, "limit=5.5 ⇒ null");
assertEq(parseLimit("1e3"), null, "limit=1e3 ⇒ null（Number() 会放过，正则不放）");
assertEq(parseLimit("abc"), null, "limit=abc ⇒ null");

// 漂移阈值是个公开常量（运行时探针与断言共用），别让人随手改成 0.5
assertEq(UNKNOWN_DRIFT_THRESHOLD, 0.2, "未知状态漂移阈值 = 0.20（抵澳 8% 脏值 + 足够余量）");

// 解析器对空数组必须抛（否则一次上游异常会清空"当日所有"）
assertThrows(() => parseAirportFlights([], "dep", AT), /空数组/, "空数组 ⇒ 抛（防 void 清空当日）");

console.log(`\n结果：通过 ${pass} · 失败 ${fail}`);
if (fail) {
  console.error("\n❌ 终态/空态/入参判定与预期不符 —— 每条 ✗ 都是一次用户可见的错误显示。");
  process.exit(1);
}
