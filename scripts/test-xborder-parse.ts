/**
 * 解析器断言（scripts/test-xborder-parse.ts）—— 纯函数，**不联网、不连库**
 *
 * ── 守的是什么（契约 §1.4 / §3.5 第 4 步）──────────────────────────────
 *   契约要求"先写纯解析函数 + 固定样例断言，再接 fetch"。理由很实际：
 *   出问题时**分不清是解析错了还是上游变了**，是这类接入最常见的时间黑洞。
 *
 *   本文件钉死四类东西：
 *   ① **机场的两个日期坑**：`date` 是 DD-MM-YYYY（`06-11-2026` = 11 月 6 日），
 *      `time` 的前缀是 DD-MM。按 MM-DD 读会把 11 月读成 6 月 —— 而且**不报错**，
 *      只是数据默默跑到另一个月。故这里同时断言"正确读法"与"错法必须抛"。
 *   ② **船的换日规则**：真实快照（23 点档）里含次日 07:30 待航行；解析后它们的
 *      `sail_date` 必须是**次日**。写错的话，次日早班会被当成"今天的清晨班"（已过）。
 *   ③ **船的结构校验**：表头对不上 / 列数不对 / 航班列不是 HH:MM ⇒ 必须抛。
 *      唯一允许返回空数组的情形是"表头正常、0 条数据行"（= 停航），语义真实。
 *   ④ **字符级等值**：上游文本经解析后必须逐字符不变（海事局条款「不得修改任何内容」）。
 *
 * 运行：npm run test:xborder-parse
 */
import fs from "node:fs";
import path from "node:path";
import { sanitizeAirportRawText } from "../src/lib/cross-border/airport/fetch";
import { parseAirportFlights } from "../src/lib/cross-border/airport/parse";
import { parseFerrySailings } from "../src/lib/cross-border/ferry/parse";
import {
  addDays,
  daysBetween,
  hhMmToMinutes,
  macauDate,
  macauHhMm,
  macauIso,
  macauStampToUtc,
} from "../src/lib/cross-border/time";

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
  assert(got === want, `${msg}（实际 ${JSON.stringify(got)} / 预期 ${JSON.stringify(want)}）`);
}
function assertThrows(fn: () => unknown, re: RegExp, msg: string) {
  try {
    fn();
    assert(false, `${msg}（未抛错）`);
  } catch (e) {
    const m = (e as Error).message;
    assert(re.test(m), `${msg}（抛出的信息：${m}）`);
  }
}

const FIX = path.resolve(process.cwd(), "scripts/fixtures/xborder");
const readText = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8");
const readJson = (f: string) => JSON.parse(readText(f)) as unknown;

/**
 * 断言基准时刻。船件抓于 2026-11-06 23:2x，故固定 23:20；
 * 机场件抓于 2026-11-07 01:17（`date=07-11-2026`），靠 `parseUpstreamDate` 的 ±1 天
 * 跨午夜容差解析到 11-07 —— 正是该容差要覆盖的真实场景。
 * 不另设 AT：改了它，船件的换日断言（当日 11-06 / 次日 11-07）会整体位移一天。
 */
const AT = new Date("2026-11-06T23:20:00+08:00");

console.log("跨境交通 · 解析器断言\n");

/* ══════════════════════════════════════════════════════════════════
 * A. 时间工具（纯算术，与宿主时区/ICU 无关）
 * ══════════════════════════════════════════════════════════════════ */
console.log("A. 澳门时间工具");
assertEq(
  macauDate(Date.parse("2026-11-06T15:52:10Z")),
  "2026-11-06",
  "UTC 15:52 ⇒ 澳门 23:52 同一天",
);
assertEq(macauHhMm(Date.parse("2026-11-06T15:52:10Z")), "23:52", "UTC 15:52 ⇒ 澳门 23:52");
// 跨日边界：UTC 16:00 = 澳门次日 00:00
assertEq(
  macauDate(Date.parse("2026-11-06T16:00:00Z")),
  "2026-11-07",
  "UTC 16:00 ⇒ 澳门次日（边界）",
);
assertEq(macauHhMm(Date.parse("2026-11-06T16:00:00Z")), "00:00", "UTC 16:00 ⇒ 澳门 00:00");
assertEq(
  macauIso(Date.parse("2026-11-06T15:52:10Z")),
  "2026-11-06T23:52:10+08:00",
  "serverNow 必须带 +08:00 偏移（不是 Z 结尾）",
);
const st = macauStampToUtc("2026-11-06", "08:00");
assertEq(st?.toISOString(), "2026-11-06T00:00:00.000Z", "(11-06 08:00 澳门) = 00:00Z（UTC+8）");
assertEq(
  macauStampToUtc("2026-02-30", "08:00"),
  null,
  "2026-02-30 不是合法日期 ⇒ null（Date 会自动进位，故要回代校验）",
);
assertEq(macauStampToUtc("2026-11-06", "24:00"), null, "24:00 ⇒ null");
assertEq(daysBetween("2026-11-06", "2026-11-07"), 1, "相邻两天相差 1 天");
assertEq(daysBetween("2026-11-06", "2026-11-08"), 2, "相差 2 天");
assertEq(addDays("2026-11-06", 1), "2026-11-07", "加 1 天");
assertEq(addDays("2026-11-01", -1), "2026-10-31", "跨月减 1 天");
assertEq(hhMmToMinutes("07:10"), 430, "07:10 = 430 分钟");

/* ══════════════════════════════════════════════════════════════════
 * B. 机场解析：DD-MM 两个坑
 * ══════════════════════════════════════════════════════════════════ */
console.log("\nB. 机场解析（DD-MM-YYYY 与 DD-MM HH:MM）");

// 2026-11-07 01:17 的逐字节真实快照（非构造）。凌晨上游状态绝大多数是字面量 `0`，
// 属正常；本节只验结构（DD-MM 日期/时刻、gate=0 归一、字段映射），白名单覆盖另见
// `test-xborder-status.ts` 的 `-coverage.json` 样本。
const dep = parseAirportFlights(readJson("airport-dep.json"), "dep", AT);
assertEq(dep.length, 65, "离澳真实快照 65 条全部解析成功");
assertEq(dep[0].schedDate, "2026-11-07", "`date=07-11-2026` ⇒ 2026-11-07（**不是** 2026-07-11）");
assertEq(dep[0].schedTime, "08:00", "`time=07-11 08:00` ⇒ 只取 HH:MM");
assert(
  /^[A-Z0-9]{2}\d+$/.test(dep[0].flightNo),
  `flightNo 是「两字码+数字」形态（实际 ${dep[0].flightNo}）`,
);
assertEq(dep[0].direction, "dep", "direction 由调用方给出");
assertEq(dep[0].gateRaw, "10", "gate 原文保留（10；非 0 不归一）");
assertEq(dep[0].placeRaw, "台北", "place 取 destination（离澳）");
assertEq(dep[0].airlineRaw, dep[0].flightNo.slice(0, 2), "airline 保留且与该行 flightNo 前缀一致");

// gate 字面量 '0' ⇒ null（语义是"尚未分配"，不能让 UI 显示"闸口 0"）
assert(
  dep.every((r) => r.gateRaw !== "0"),
  "gate 里不再出现字面量 `0`（已归一为 null）",
);
assertEq(
  dep.filter((r) => r.gateRaw === null).length,
  3,
  "恰好 3 条 gate=null（真实快照里 3 条 `0`）",
);

// 号码归一：小写 + 空白 ⇒ 大写去空白
const lower = parseAirportFlights(
  [
    {
      date: "06-11-2026",
      time: "06-11 09:15",
      flightNo: " nx632 ",
      destination: "台北",
      status: "待航",
      gate: "",
    },
  ],
  "dep",
  AT,
);
assertEq(lower[0].flightNo, "NX632", "flightNo 归一为 trim+大写（否则同号会被当成两条）");
assertEq(lower[0].gateRaw, null, "空 gate ⇒ null");

// 抵澳：无 gate 字段 ⇒ 恒 null；place 取 origin
const arr = parseAirportFlights(readJson("airport-arr.json"), "arr", AT);
assertEq(arr.length, 66, "抵澳真实快照 66 条全部解析成功");
assert(
  dep.every((r) => r.direction === "dep"),
  "离澳行 direction 全为 dep",
);
assert(
  arr.every((r) => r.gateRaw === null),
  "抵澳行 gate 恒为 null（真实响应无 gate 字段）",
);
assertEq(arr[0].placeRaw, "台中", "place 取 origin（抵澳，快照首行 origin=台中）");
assertEq(arr[0].statusRaw, "0", "status 原文照录（凌晨快照该行是字面量 `0`，不得改写）");

// ── 机场侧 U+0000 消毒（负责人裁决）：喂含 NUL 的状态串，产出无 NUL 且逐字保留 ──
const NUL = String.fromCharCode(0);
const CLEAN_STATUS = "航班延誤至 18:40";
const dirtyStatus = `航班延誤${NUL}至 18:40`;
const baseFlight = {
  date: "06-11-2026",
  time: "06-11 18:00",
  flightNo: "NX1",
  destination: "台北",
  gate: "1",
};
// ① 以合法 JSON 转义 \u0000 到达（01:08 arr 503 的实际路径）：JSON.stringify 会把
//    U+0000 写成 6 字符转义，正是上游的形态；此时 JSON.parse 不抛，但会把 NUL 还原进库。
const escapedJson = JSON.stringify([{ ...baseFlight, status: dirtyStatus }]);
// ② 以原始 0x00 字节到达：JSON.parse 本来会抛 Bad control character，消毒后必须能正常解析。
const rawByteJson =
  `[{"date":"06-11-2026","time":"06-11 18:00","flightNo":"NX1",` +
  `"destination":"台北","gate":"1","status":"航班延誤${NUL}至 18:40"}]`;
for (const [label, rawJson] of [
  ["JSON 转义 \\u0000", escapedJson],
  ["原始 0x00 字节", rawByteJson],
] as const) {
  const rows = parseAirportFlights(
    JSON.parse(sanitizeAirportRawText(rawJson)) as unknown,
    "dep",
    AT,
  );
  assertEq(
    rows[0].statusRaw,
    CLEAN_STATUS,
    `机场消毒（${label}）：产出无 NUL 且其余字符逐字保留`,
  );
  assert(
    !rows[0].statusRaw.includes(NUL),
    `机场消毒（${label}）：statusRaw 不再含 U+0000（否则 Postgres 拒写）`,
  );
  assertEq(rows[0].placeRaw, "台北", `机场消毒（${label}）：其它字段逐字不受影响`);
}
assertEq(
  sanitizeAirportRawText(`甲${NUL}乙${NUL}丙`),
  "甲乙丙",
  "消毒只删控制字节，多位置也不碰可见字符",
);

// ── 边界（2026-11-07 实测）：可见文本 \u0000 不能被当成 NUL 转义删掉 ──
// JSON 里表示字面文本 "\u0000" 要写成双反斜杠 \\u0000（7 字符）；无负向后顾的
// /\\u0000/gi 会从第二个反斜杠起匹配并删掉，留下孤立反斜杠 ⇒ parse 抛 Unterminated string。
const VISIBLE_NUL = "\\u0000"; // 6 字符可见文本（\ + u0000），不是 NUL
const visibleJson = JSON.stringify([{ ...baseFlight, status: VISIBLE_NUL }]);
const visibleSanitized = sanitizeAirportRawText(visibleJson);
let visibleParseOk = true;
let visibleStatus = "";
try {
  visibleStatus = (JSON.parse(visibleSanitized) as { status: string }[])[0].status;
} catch {
  visibleParseOk = false;
}
assert(
  visibleParseOk,
  "边界：含双反斜杠可见文本 \\u0000 的合法 JSON 消毒后仍可 parse（不留孤立反斜杠）",
);
assertEq(visibleStatus, VISIBLE_NUL, "边界：可见文本 \\u0000 逐字保留（未被当成转义删掉）");

// 2 个字面反斜杠 + 文本 u0000（JSON 四反斜杠）同样必须原样保留
const FOUR_SLASH = "\\\\u0000"; // 7 字符：两个反斜杠 + u0000
const fourJson = JSON.stringify([{ ...baseFlight, status: FOUR_SLASH }]);
assertEq(
  (JSON.parse(sanitizeAirportRawText(fourJson)) as { status: string }[])[0].status,
  FOUR_SLASH,
  "边界：四反斜杠的可见文本原样保留",
);

// 混合：同一响应内既有可见文本、又有真 NUL 转义 ⇒ 两者各自正确处理
// ⚠️ 两条必须用不同 flightNo：业务键 = date|flightNo|time，同键会被 parse 去重（保留最后一条），
//    那样只剩 1 行，断言就会读不到 [1]、误判成消毒失效。
const mixedJson = JSON.stringify([
  { ...baseFlight, flightNo: "NX1", status: VISIBLE_NUL },
  { ...baseFlight, flightNo: "NX2", status: dirtyStatus },
]);
const mixedRows = parseAirportFlights(
  JSON.parse(sanitizeAirportRawText(mixedJson)) as unknown,
  "dep",
  AT,
);
assertEq(mixedRows[0].statusRaw, VISIBLE_NUL, "混合响应：可见文本 \\u0000 保留");
assertEq(mixedRows[1].statusRaw, CLEAN_STATUS, "混合响应：真 NUL 被删且其余字符逐字保留");
assert(!mixedRows.some((r) => r.statusRaw.includes(NUL)), "混合响应：无任何 U+0000 残留");

// 防止消毒函数变成没接线的死代码：fetch.ts 必须在 res.text() 与 JSON.parse 之间调用它
const fetchSrc = fs.readFileSync(
  path.resolve(process.cwd(), "src/lib/cross-border/airport/fetch.ts"),
  "utf8",
);
assert(
  /const rawText = await res\.text\(\);[\s\S]{0,200}?const body = sanitizeAirportRawText\(rawText\);[\s\S]{0,200}?JSON\.parse\(body\)/.test(
    fetchSrc,
  ),
  "fetch.ts 的消毒确实接在 res.text() 与 JSON.parse 之间（不是死代码）",
);

// ── 错法必须抛 ──
assertThrows(
  () =>
    parseAirportFlights(
      [
        {
          date: "11-06-2026",
          time: "11-06 08:00",
          flightNo: "NX1",
          destination: "台北",
          status: "",
        },
      ],
      "dep",
      AT,
    ),
  /相差/,
  "把 DD-MM 当 MM-DD 读（11-06 读成 11 月 6 日 = 6 月 11 日）⇒ 与抓取日相差 >1 天 ⇒ 抛",
);
assertThrows(
  () =>
    parseAirportFlights(
      [
        {
          date: "06-11-2026",
          time: "07-11 08:00",
          flightNo: "NX1",
          destination: "台北",
          status: "",
        },
      ],
      "dep",
      AT,
    ),
  /不一致/,
  "time 前缀与 date 不是同一天 ⇒ 抛（两个字段打架时不猜）",
);
assertThrows(
  () =>
    parseAirportFlights(
      [
        {
          date: "2026-11-06",
          time: "06-11 08:00",
          flightNo: "NX1",
          destination: "台北",
          status: "",
        },
      ],
      "dep",
      AT,
    ),
  /DD-MM-YYYY/,
  "date 用了 ISO 写法 ⇒ 抛（格式变了就必须炸，不能静默）",
);
assertThrows(
  () =>
    parseAirportFlights(
      [{ date: "06-11-2026", time: "06-11 08:00", flightNo: "NX1", status: "" }],
      "dep",
      AT,
    ),
  /缺 destination/,
  "离澳缺 destination ⇒ 抛（place 是业务必需）",
);
assertThrows(() => parseAirportFlights({}, "dep", AT), /不是数组/, "响应不是数组 ⇒ 抛");
assertThrows(
  () =>
    parseAirportFlights(
      [
        {
          date: "06-11-2026",
          time: "06-11 08:00",
          flightNo: "  ",
          destination: "台北",
          status: "",
        },
      ],
      "dep",
      AT,
    ),
  /缺 flightNo/,
  "空 flightNo ⇒ 抛",
);

/* ══════════════════════════════════════════════════════════════════
 * C. 船解析：真实快照（逐字节）
 * ══════════════════════════════════════════════════════════════════ */
console.log("\nC. 船解析（真实快照，非构造）");
const depHtml = readText("ferry-dep-PE.html");
const sail = parseFerrySailings(depHtml, "PE", "dep", AT);
assertEq(sail.length, 10, "外港离港快照解析出 10 条（= 页面 10 个数据行）");
assertEq(sail[0].schedTime, "17:00", "第 1 条计划时刻 17:00");
assertEq(sail[0].placeRaw, "香港", "第 1 条目的港「香港」原文");
assertEq(sail[0].statusRaw, "17:04 啟航", "第 1 条状态原文（含实际开航时刻）");
assertEq(sail[0].gateRaw, "9", "第 1 条闸口 9");
assertEq(sail[0].vesselRaw, "宇航 2006", "船名从「船名<br>船種」的第一行取");
assertEq(sail[0].vesselTypeRaw, "豪華雙體船", "船种取第二行");
assertEq(sail[0].operatorRaw, "噴射飛航", "船务公司取第一行（`<img logo>` 已丢弃）");
assertEq(sail[0].statusKind, "departed", "「17:04 啟航」⇒ departed");
assertEq(sail[0].pier, "PE", "pier 来自入参（不从页面文字反推）");
assertEq(sail[0].sailDate, "2026-11-06", "当日行 sail_date = 采集当天");

// ★ 换日规则：23 点档页面里 07:30/08:30/09:00 的「待航」是**次日**早班
const pending = sail.filter((r) => r.statusRaw === "待航");
assertEq(pending.length, 3, "快照里有 3 条「待航」（07:30 / 08:30 / 09:00）");
assert(
  pending.every((r) => r.sailDate === "2026-11-07"),
  "这 3 条的 sail_date 全部是**次日** 2026-11-07（时刻回退 ⇒ 换日）",
);
assert(
  sail.filter((r) => r.statusRaw !== "待航").every((r) => r.sailDate === "2026-11-06"),
  "换日只影响回退之后的行（前面 7 条仍是当日）",
);
assertEq(pending[0].vesselRaw, null, "待航行没有船名（上游该格是 `<br>`）⇒ null");

// 到港：5 列、无闸口
const arrSail = parseFerrySailings(readText("ferry-arr-tp.html"), "TP", "arr", AT);
assertEq(arrSail.length, 8, "氹仔到港快照解析出 8 条");
assert(
  arrSail.every((r) => r.gateRaw === null),
  "到港行 gate 恒为 null（上游无闸口列）",
);
assertEq(arrSail[0].statusRaw, "21:30 到達", "到港状态原文照录");
assertEq(arrSail[0].statusKind, "arrived", "「HH:MM 到達」⇒ arrived");
assertEq(arrSail[0].operatorRaw, "金光飛航", "到港公司原文");
assertEq(arrSail[0].vesselTypeRaw, "雙體高速船", "到港船种取第二行");

/* ══════════════════════════════════════════════════════════════════
 * D. 船解析：结构性失败必须抛（唯一允许的空数组 = 停航）
 * ══════════════════════════════════════════════════════════════════ */
console.log("\nD. 船解析的结构校验");
const HDR_DEP = `<tr><th>航班</th><th>目的港</th><th>狀態</th><th>閘口</th><th>船名(船種)</th><th>船務公司</th></tr>`;
const wrap = (rows: string) => `<table class='item_table table-striped'>${rows}</table>`;

// 表头正常 + 0 条数据行 ⇒ 空数组（停航/未排班，合法）
assertEq(
  parseFerrySailings(wrap(HDR_DEP), "PE", "dep", AT).length,
  0,
  "表头正常但 0 条数据行 ⇒ 返回空数组（= 当日确实没有班次，不是解析失败）",
);
assertThrows(
  () => parseFerrySailings("<html><body>很抱歉，此網頁並不存在</body></html>", "PE", "dep", AT),
  /找不到 class='item_table'/,
  "页面里没有航班表 ⇒ 抛（错误页/维护页不能被当成「今天没船」）",
);
assertThrows(
  () =>
    parseFerrySailings(wrap(`<tr><th>航班</th><th>目的港</th><th>狀態</th></tr>`), "PE", "dep", AT),
  /表头与预期不符/,
  "表头列数变了 ⇒ 抛（页面改版必须炸，不能静默解析出 0 行）",
);
assertThrows(
  () =>
    parseFerrySailings(
      wrap(`${HDR_DEP}<tr><td>18:00</td><td>香港</td><td>18:03 啟航</td></tr>`),
      "PE",
      "dep",
      AT,
    ),
  /列数/,
  "数据行列数 ≠ 表头列数 ⇒ 抛",
);
assertThrows(
  () =>
    parseFerrySailings(
      wrap(
        `${HDR_DEP}<tr><td>18:00/18:30</td><td>香港</td><td>待航</td><td></td><td><br></td><td>噴射飛航</td></tr>`,
      ),
      "PE",
      "dep",
      AT,
    ),
  /不是 HH:MM/,
  "航班列不是 HH:MM ⇒ 抛",
);
assertThrows(
  () =>
    parseFerrySailings(
      wrap(
        `${HDR_DEP}<tr><td>18:00</td><td></td><td>待航</td><td></td><td><br></td><td>噴射飛航</td></tr>`,
      ),
      "PE",
      "dep",
      AT,
    ),
  /目的港/,
  "目的港为空 ⇒ 抛",
);

console.log(`\n结果：通过 ${pass} · 失败 ${fail}`);
if (fail) {
  console.error("\n❌ 解析器与预期不符 —— 每条 ✗ 都可能意味着「库里的日期/班次是错的」。");
  process.exit(1);
}
