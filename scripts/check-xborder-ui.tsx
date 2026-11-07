/**
 * 跨境交通 · 前端断言（scripts/check-xborder-ui.tsx，2026-11-07）
 *
 * ── 守的是什么 ──────────────────────────────────────────────────────────
 *   本批的 UI 有三处「错了也不会报错、只会静默错」的地方，本脚本把它们钉死：
 *
 *   ① **图标静默消失**：`Icon.tsx` 在未知语义名时 `return null`（本仓既有的坑）。
 *      名字拼错 / 库版本不匹配 ⇒ 页面上"就是没有图标"，不报错、不进日志。
 *      ⇒ 4 个新名字**逐个真渲染**，断言产出的 `<svg>` 非空；
 *        并留一条**反向对照**（假名字必须渲染出空串），证明这条断言真能红。
 *
 *   ② **抵澳板整片置灰**：`statusKind === "departed"` 在离澳是终态、在抵澳是"在途马上到"。
 *      按 `statusKind` 置灰会让抵澳板灰成一片 —— 而"抵澳板灰着"看起来跟"今晚没航班"一样。
 *      ⇒ 断言「同一 `statusKind` + `isTerminal=false` ⇒ 不置灰」。
 *
 *   ③ **空态说错话**：三值 `emptyReason` 必须三句不同的话；若混成一句，
 *      "我们没采到"会被说成"今天没有船"。
 *      ⇒ 断言三句互不相同、且都不含归因错误词表。
 *
 * 另测：平铺大表格的行数完整性（**2026-11-07 已取消小时分组**，见 [4] 段头注释）、
 *      「現在」游标插入位置、下一班、跨日时刻、列模板。
 * 全部是纯函数 / 无 DOM ⇒ **不连库、不联网、不需要浏览器**，可进 verify。
 *
 * 运行：npx tsx scripts/check-xborder-ui.tsx
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import Icon from "../src/components/ui/Icon";
import {
  buildTableNodes,
  displaySched,
  emptyCopy,
  hmToMinutes,
  macauParts,
  nextSailing,
  PIER_NAME,
  PIER_ROUTE_HINT,
  remainingCount,
  statusCell,
  statusClass,
  type XbRow,
} from "../src/components/cross-border/xb-view";
import XbTable, { tableSpec } from "../src/components/cross-border/XbTable";
import { XbStale } from "../src/components/cross-border/XbBits";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${msg}`);
  } else {
    fail++;
    console.error(`  FAIL  ${msg}`);
  }
}
function assertEq<T>(a: T, b: T, msg: string) {
  assert(Object.is(a, b), `${msg}（实际 ${JSON.stringify(a)} / 期望 ${JSON.stringify(b)}）`);
}

/* ══════════════════════════════════════════════════════════════════════
 * [1] 图标：4 个新语义名必须真渲染出非空 <svg>
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[1] 新图标必须真渲染（`Icon` 未知名字会静默 return null）");
const ICONS = [
  /* 实心变体走 `fill="currentColor" stroke="none"`（Tabler filled 族；与既有
     homeFilled / bookmarkFilled / bookFilled 同款）⇒ 它**不该**有 stroke-width=2，
     断言必须分开写，否则这条会永远红（我第一版就是这么写错的）。 */
  { name: "crossBorderIcon", filled: false },
  { name: "crossBorderFilledIcon", filled: true },
  { name: "ferryIcon", filled: false },
  { name: "planeIcon", filled: false },
] as const;
for (const { name, filled } of ICONS) {
  const html = renderToStaticMarkup(<Icon name={name} size={20} />);
  assert(html.startsWith("<svg"), `${name} 渲染出 <svg>`);
  /* 非空：至少有条路径/圆 —— 只有空 <svg></svg> 说明图标组件是空的 */
  assert(/<(path|circle|rect|line|polyline)/.test(html), `${name} 的 <svg> 内含图形（非空壳）`);
  if (filled) {
    assert(/fill="currentColor"/.test(html) && /stroke="none"/.test(html), `${name} 是实心变体（fill=currentColor / stroke=none）`);
  } else {
    assert(
      html.includes('stroke-linecap="butt"') && html.includes('stroke-width="2"'),
      `${name} 走 Icon.tsx 线性口径（stroke=2 / butt cap）`,
    );
  }
}
/* 反向对照：这条能红，说明上面那条不是"永远 PASS" */
assertEq(renderToStaticMarkup(<Icon name="thisIconDoesNotExist" size={20} />), "", "反向对照：假名字渲染为空（证明断言有效）");

/* ══════════════════════════════════════════════════════════════════════
 * [2] 终态/置灰：只能用 isTerminal，不能用 statusKind
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[2] 置灰只看 isTerminal（抵澳 `已啟航` 是在途，不是终态）");
assertEq(statusClass("departed", true), "xb-st--past", "离澳 已啟航（终态）⇒ 置灰");
assertEq(statusClass("departed", false), "", "抵澳 已啟航（在途）⇒ **不置灰**（这条错了抵澳板会整片灰掉）");
assertEq(statusClass("landed", true), "xb-st--past", "已降落（终态）⇒ 置灰");
assertEq(statusClass("cancelled", true), "xb-st--danger", "取消 ⇒ 用 --danger（终态里唯一必须能看清的）");
assertEq(statusClass("delayed", false), "xb-st--warn", "延误 ⇒ --warn");
assertEq(statusClass("pending", false), "", "待航 ⇒ 不额外着色");
/* ★ 设计稿 v1.1 §04 权威映射表逐行校对（v1.0 漏了 boarding_closed） */
assertEq(statusClass("boarding_closed", false), "xb-st--warn", "停止登機（关闸中、非终态）⇒ --warn");
assertEq(statusClass("checkin_open", false), "", "櫃檯已開放 ⇒ 正常前景（不着色）");
assertEq(statusClass("arrived", true), "xb-st--past", "船 已到達（终态）⇒ 置灰");
assertEq(statusClass("unknown", false), "", "上游未提供状态 ⇒ 正常前景（不着色）");

/* ══════════════════════════════════════════════════════════════════════
 * [3] 时刻：澳门固定 +8，不看设备时区
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[3] 时刻口径（澳门 +8，不读设备时区）");
const parts = macauParts("2026-11-07T09:56:00+08:00");
assertEq(parts?.hm, "09:56", "ISO(+08:00) ⇒ 09:56");
assertEq(parts?.ymd, "2026-11-07", "ISO ⇒ 澳门当日日期");
assertEq(parts?.minutes, 9 * 60 + 56, "ISO ⇒ 当日分钟数");
assertEq(macauParts("2026-11-07T00:30:00+08:00")?.ymd, "2026-11-07", "午夜后 00:30 仍属当日（不往前跳一天）");
assertEq(macauParts("not-a-date"), null, "不可解析 ⇒ null（由调用方降级，不猜）");
assertEq(hmToMinutes("08:05"), 485, "HH:MM 解析");
assertEq(hmToMinutes("24:00"), null, "非法小时 ⇒ null（不静默纠正）");
assertEq(displaySched("2026-11-07", "08:05", "2026-11-07"), "08:05", "本日 ⇒ 只显 HH:MM");
assertEq(displaySched("2026-11-08", "00:30", "2026-11-07"), "11-08 00:30", "跨日 ⇒ 拼月日");

/* ══════════════════════════════════════════════════════════════════════
 * [4] 平铺大表格（2026-11-07 取消小时分组）+ 「現在」游标
 *
 *   ★ 口径反转（负责人 2026-11-07 裁决「取消并改设计稿」）：
 *     机场与码头班次表**取消按小时分组**，改成一列到底的平铺大表格（表头吸附保留、不插小时分隔条）。
 *     故本段由「必须有 hour 节点」反转为「**不得**有 hour 节点」。
 *
 *   ⚠️ 本段**不再出现** `x.kind === "hour"` 这类类型层比较 —— 统一走 `String(x.kind)`。
 *      原因：`XbNode` 联合类型里保留 `hour` 成员的**唯一**理由就是本脚本还在比它
 *      （删掉会让 `npx tsc --noEmit` 在本文件报 TS2367「类型无重叠」，见 xb-view.ts:174-181）。
 *      改成字符串比较后，前端可以**安全删除** `hour` 成员与 `hourLabel`，本脚本仍能编译与运行。
 *
 *   ⚠️ 「行数 = 输入条数」这类判据**一律不写死数字**（上次栽在 `n === 6` 上：瞬时值当不变式，
 *      换一天数据就红、红得没信息量）。右值一律从输入数据现算，并配**变异对照**证明它有判别力。
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[4] 平铺大表格与游标（70+ 行的定位锚；已取消小时分组）");
const mk = (id: number, t: string, terminal = false): XbRow => ({
  id,
  schedTime: t,
  schedDate: "2026-11-07",
  isTerminal: terminal,
  statusKind: terminal ? "departed" : "pending",
});
const rows = [mk(1, "08:00", true), mk(2, "08:15", true), mk(3, "09:30", true), mk(4, "10:20"), mk(5, "11:05")];

/* 类型层只看 `string`：不依赖 `XbNode` 是否还声明 `hour` */
const kindsOf = (ns: readonly { kind: string }[]): string[] => ns.map((x) => String(x.kind));
const countKind = (ns: readonly { kind: string }[], k: string): number => kindsOf(ns).filter((x) => x === k).length;
const countRows = (ns: readonly { kind: string }[]): number => countKind(ns, "row");
const idAt = (ns: readonly { kind: string; row?: { id: number } }[], id: number): number =>
  ns.map((x, i) => (String(x.kind) === "row" && x.row?.id === id ? i : -1)).filter((i) => i >= 0)[0];

const NOW1 = 9 * 60 + 56;
const n1 = buildTableNodes(rows, NOW1);

/* ── (1) 反向：不得再产出小时分组头 ── */
assertEq(countKind(n1, "hour"), 0, "不得再产出 hour 分组头（已取消小时分组，改平铺大表格）");
assertEq(
  kindsOf(n1).filter((k) => k !== "row" && k !== "now").length,
  0,
  "节点类型只有 row / now（不得再插入小时分隔条一类的第三种节点）",
);

/* ── (2) 平铺完整性：数据行数 = 输入班次条数（动态对照，不写死） ── */
assertEq(countRows(n1), rows.length, "平铺完整性：数据行数 = 输入班次条数（右值从数据现算，不写死）");
const rowsSmall = rows.slice(0, 3);
assertEq(countRows(buildTableNodes(rowsSmall, NOW1)), rowsSmall.length, "换一组数据（3 条）仍相等 ⇒ 证明右值随数据变、不是写死的 5");

/* ── (3) 游标不变量（语义与改前一致） ── */
assertEq(countKind(n1, "now"), 1, "只插一个游标");
const nowAt1 = kindsOf(n1).indexOf("now");
const lastBeforeNow = idAt(n1, 3);
const firstAfterNow = idAt(n1, 4);
/* 不变量：游标**在第一条 >= now 的行之前**、且在最后一条 < now 的行之后。
   ⚠️ 不能写成「游标下标 = 下一行下标 - 1」—— 此前两者之间还夹着分组头，那样写会永远红。 */
assert(nowAt1 > lastBeforeNow, "游标在「最后一条 < now 的行」之后");
assert(nowAt1 < firstAfterNow, "游标在「第一条 >= now 的行」之前（游标错位会让用户以为下一班已过）");

/* 平铺后仍不能丢「未过班次」：游标之后的 row 数 = 时刻 >= now 的条数 */
const rowsAfterNow = rows.filter((r) => {
  const m = hmToMinutes(r.schedTime);
  return m != null && m >= NOW1;
}).length;
assertEq(
  n1.slice(nowAt1 + 1).filter((x) => String(x.kind) === "row").length,
  rowsAfterNow,
  "游标之后的 row 数 = 时刻 >= now 的班次条数（平铺也不得把未过班次挤掉）",
);

/* ── (4) 变异对照（铁律 44：没有变异对照的守护型断言不算数） ──
   故意把右值写成「总数 − 1」「总数 + 1」，两者都必须**不成立**：
   · 若「−1」成立 ⇒ 有行被吞（分组结构残留 / 去重过头）
   · 若「+1」成立 ⇒ 有行被重复渲染
   这两条一旦变红，说明上面「行数 = 条数」的判据已失去判别力，必须当成断言故障处理。 */
const rc = countRows(n1);
assert(rc !== rows.length - 1, `变异对照：若「行数 = 总数−1」成立 ⇒ 有行被吞（实际 ${rc}，总数−1 = ${rows.length - 1}）`);
assert(rc !== rows.length + 1, `变异对照：若「行数 = 总数+1」成立 ⇒ 有行重复渲染（实际 ${rc}，总数+1 = ${rows.length + 1}）`);
assert(rc !== 0, "变异对照：行数为 0 会让上面所有相等判据「空洞成立」，必须不成立");

const n2 = buildTableNodes(rows, 23 * 60);
assertEq(kindsOf(n2).indexOf("now"), n2.length - 1, "全部已过 ⇒ 游标落在末尾（不丢行、不隐藏）");
assertEq(countKind(buildTableNodes(rows, null), "now"), 0, "serverNow 不可解析 ⇒ 不画游标");
assertEq(buildTableNodes([], 600).length, 1, "空表 + 有 now ⇒ 只有游标（调用方此时不该传 now）");

/* ══════════════════════════════════════════════════════════════════════
 * [4b] `.xb-hr`（小时分组分隔条）必须**在源码里彻底消失**，出现 0 次
 *
 *   上一段测的是「纯函数不再产出 hour 节点」；但组件层 / 样式层若还留着
 *   `.xb-hr { … }` 规则或 `<div className="xb-hr">`，说明分组只是"没被调用"，
 *   随时会被下一手接回去（这类"留着不用"的代码正是复发温床）。
 *   ⇒ 对 `src/` 全量做**去注释后**的字符串扫描，命中必须为 0。
 *
 *   ★ 为什么要先去掉注释：`globals.css:10724` 有一条**留痕注释**
 *     `/* .xb-hr / .xb-hr__c（…）已于 2026-11-07 取消分组时删除。 *\/`
 *     ——注释是给人看的证据，不是实现。直接 grep 会把它算成"还活着"，是假阳性。
 *     去掉注释后再说 0 命中，才是"实现层真没了"。
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[4b] `.xb-hr` 必须彻底消失（去注释后源码 0 命中）");
/** 去掉块注释与整行 `//` 注释（行内 `//` 不动：JSX 里的 URL 会被误伤） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}
function walkFiles(dir: string, exts: readonly string[], acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, exts, acc);
    else if (exts.some((e) => name.endsWith(e))) acc.push(p);
  }
  return acc;
}
const SRC_DIR = resolve(process.cwd(), "src");
/** 统计 needle 在 `src/` 全量（去注释后）出现的总次数，并返回命中文件 */
function scanSrc(needle: string): { total: number; files: string[] } {
  const files = walkFiles(SRC_DIR, [".ts", ".tsx", ".css"]);
  const hits: string[] = [];
  let total = 0;
  for (const f of files) {
    const code = stripComments(readFileSync(f, "utf8"));
    const n = code.split(needle).length - 1;
    if (n > 0) {
      total += n;
      hits.push(`${f.slice(SRC_DIR.length + 1)}×${n}`);
    }
  }
  return { total, files: hits };
}
const hrScan = scanSrc("xb-hr");
assertEq(hrScan.total, 0, `\`.xb-hr\` 在源码（去注释）中出现 0 次（实际命中：${hrScan.files.join(", ") || "无"}）`);
/* 顺带：`hour` 字面量是否还有「生产代码路径」在用 —— 只报告不判定（`XbNode` 的废弃成员与注释仍会有） */
const hourWords = scanSrc("xb-hr__");
assertEq(hourWords.total, 0, `\`.xb-hr__\`（分隔条内层）同样 0 次（实际命中：${hourWords.files.join(", ") || "无"}）`);
/* ★ 变异对照：同一个扫描器必须能**扫到东西**，否则上面两条的 0 只是"扫描器坏了" */
const nowScan = scanSrc("xb-now");
assert(nowScan.total > 0, `变异对照：同一扫描器扫 \`xb-now\` 应有命中（实际 ${nowScan.total} 次 / ${nowScan.files.length} 个文件）——为 0 则证明是扫描失效而非真的干净`);

/* ══════════════════════════════════════════════════════════════════════
 * [5] 下一班 / 剩余班数
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[5] 下一班与剩余班数");
/* 09:30 那条是**终态**（已走完）⇒ 09:00 时"下一班"应跳到 10:20，不是 09:30。
   这条正是「终态不算下一班」的守卫：算错的话用户会去赶一班已经开走的船。 */
assertEq(nextSailing(rows, 9 * 60)?.id, 4, "09:00 时下一班 = 10:20（09:30 已终态，不算）");
assertEq(nextSailing(rows, 10 * 60 + 30)?.id, 5, "10:30 时下一班 = 11:05");
assertEq(nextSailing(rows, 23 * 60), null, "当日已无后续 ⇒ null（卡片显示 -- 并降权）");
assertEq(nextSailing(rows, null), null, "now 不可解析 ⇒ null（不猜）");
assertEq(remainingCount(rows), 2, "剩余班数只数非终态");
assertEq(remainingCount([]), 0, "空表剩余 0");

/* ══════════════════════════════════════════════════════════════════════
 * [5b] 上游哨兵 `status="0"`（机场抵澳实测 6 条）
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[5b] 认不出的状态与空状态（不能裸渲染 0、也不能留空、更不能替上游归因）");
assertEq(statusCell("0").text, "—", "认不出的 \"0\" ⇒ 显示「—」");
assertEq(statusCell("0").unrecognized, true, "认不出的 \"0\" ⇒ 标 unrecognized（TSX 据此加 aria-label 与 --meta）");
assertEq(statusCell("  0  ").unrecognized, true, "带空白的 \"0\" 同样认不出（上游会带空格）");
/* ★ 措辞：空状态必须是「状态未识别」（陈述我方认知边界，简体是裁决后的写法），**不得**是「資料未公開」——
   「資料未公開」是在替上游归因（"机场没公开"），而我们并不知道是不是真没公开。
   这条断言守的是口径，改回去会红。★ 下面两条**方向不同、不是重复**：
     · `assertEq` 验「等于什么」（正向锁定，改了文案会红）；
     · `!== / 正则` 验「不得含什么」（反向排除，繁简两种写法都拦）。
   反向那条原先写死单个繁体串 ⇒ 只有"上游恰好返回该串"才可能红 ⇒ 零信息量；
   改为**反向正则覆盖繁简**，谁把兜底改成"未（公）开"都会红。 */
assertEq(statusCell("").text, "状态未识别", "空状态 ⇒ 「状态未识别」（不是「資料未公開」）");
assert(!/未公開|未公开/.test(statusCell("").text), "空状态**不得**归因成上游未公开（繁简都拦）");
assertEq(statusCell("已啟航 預計到達 21:12").text, "已啟航 預計到達 21:12", "真实状态**逐字保留**（不改写/不截断）");
assertEq(statusCell("航班著陸").unrecognized, false, "普通状态不是「认不出」");
/* 反向：哨兵行在服务端是 `statusKind=unknown` + `isTerminal=false`
   ⇒ 它**不是终态**，行必须留着、也不该被置灰。
   ⚠️ 不能把 `statusCell("0").unrecognized` 当 `isTerminal` 传给 statusClass ——
      `unrecognized`(我方没读懂) 与 `isTerminal`(已走完) 是两件事，混用正是本文件要防的错。 */
assertEq(statusClass("unknown", false), "", "认不出的行（unknown + 非终态）不置灰、行必须可见");

/* ══════════════════════════════════════════════════════════════════════
 * [5c] 两处「缺值兜底 / 降级条」文案：**正向锁定** + 反向锁繁体
 *      2026-11-07 主控追加（这处洞是 coder 反过来指出来的）。
 *
 *      为什么非补不可：[5b] 只有**反向**排除「不得含未公开」，而反向只能证明"不是坏的"、
 *      不能证明"是好的" —— 谁把 `ABSENT` 换成别的词、或把 stale 那句改写掉，
 *      本门禁**一条都不会红**。
 *
 *      断言对象是**真渲染出来的文本**（不是源码 grep）：宁可多跑一次
 *      `renderToStaticMarkup`，也不守一个"源码里有、页面上却没有"的字面量。
 *      变异对照的做法见 `.verify/qa36-mutation-new-guards.mjs`（改字面量 ⇒ 本条必红）。
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[5c] 兜底/降级条文案：正向锁定简体 + 不得回退繁体");
const plainText = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/* ① `ABSENT`（XbTable.tsx:46）= 船名 / 船务公司缺值的**唯一**文案来源。
   造一条「船名与船务公司都为空」的船侧行，渲染整张表 ⇒ 缺值处必须出现两次同一句。 */
const absentText = plainText(
  renderToStaticMarkup(
    <XbTable
      kind="ferry"
      dir="arr"
      after="day"
      nowMinutes={null}
      today={null}
      items={[
        {
          id: 9001,
          schedTime: "08:20",
          schedDate: "2026-11-07",
          isTerminal: false,
          statusKind: "pending",
          status: "待航",
          place: "澳門",
          vessel: "",
          operator: "",
        },
      ]}
    />,
  ),
);
assertEq(
  (absentText.match(/资料未公开/g) ?? []).length,
  2,
  "船名与船务公司同时缺值 ⇒ 两处都是「资料未公开」（不留空单元格、不换成别的词）",
);
assert(
  !/資料未公開/.test(absentText),
  "缺值兜底**不得**回退成繁体「資料未公開」（繁体回退不报错，只会让界面忽繁忽简）",
);

/* ② `XbStale`（XbBits.tsx:46）：整句**一个字都是我们打的**（无 props、上游只给 boolean、句内零插值）
   ⇒ 正向锁简体全句；将来再改，这条会红，改的人必须来解释。 */
const staleText = plainText(renderToStaticMarkup(<XbStale />));
assertEq(
  staleText,
  "暂时无法更新（上游暂时取不到新数据，以下是上次成功取得的内容）",
  "stale 降级条整句 = 「暂时无法更新（上游暂时取不到新数据，以下是上次成功取得的内容）」",
);
assert(
  !/暫時無法更新/.test(staleText),
  "stale 降级条**不得**回退成繁体「暫時無法更新」（理由同 [5b] 那条反向正则：回退不报错）",
);

/* ══════════════════════════════════════════════════════════════════════
 * [5d] 码头卡副标题 `PIER_ROUTE_HINT`：我方硬编码目的地名 ⇒ 正向锁简体
 *      2026-11-07 前端反过来提示"这三串今天被谁改回去，门禁一条都不会红"，
 *      与前一处（ABSENT / stale）是同一个洞：**只有反向断言 = 只证明"不是坏的"**。
 *
 *      ⚠️ 判据与 `PIER_NAME` **不同**，别为了"看起来统一"把两者对齐：
 *        · `PIER_ROUTE_HINT` = 我们打的目的地名（珠海湾仔 / 香港 / 深圳蛇口）⇒ 简体
 *        · `PIER_NAME` / `AIRPORT_NAME` = 官方专名（內港碼頭 / 澳門國際機場）⇒ **保持繁体**
 *      所以下面既锁了"该简体的必须简体"，也锁了"该繁体的不许被顺手改成简体"。
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[5d] 码头卡副标题（我方目的地名）正向锁简体 + 官方专名不得被顺手改简");
const HINT_EXPECT: Record<"PI" | "PE" | "TP", string> = {
  PI: "珠海湾仔",
  PE: "香港 / 深圳蛇口",
  TP: "香港 / 深圳蛇口",
};
for (const k of ["PI", "PE", "TP"] as const) {
  assertEq(PIER_ROUTE_HINT[k], HINT_EXPECT[k], `PIER_ROUTE_HINT.${k} = 「${HINT_EXPECT[k]}」（我方文案，改了必须有人知道）`);
}
assert(!/灣仔/.test(PIER_ROUTE_HINT.PI), "PIER_ROUTE_HINT.PI **不得**回退成繁体「珠海灣仔」");
/* 反向对照：官方专名族必须仍是繁体 —— 证明上一行不是"全仓简体化"的粗暴规则 */
assertEq(PIER_NAME.TP, "氹仔碼頭", "反向对照：PIER_NAME 是官方专名 ⇒ **保持繁体**（与 PIER_ROUTE_HINT 判据不同，不许对齐）");
assertEq(PIER_NAME.PE, "外港碼頭", "反向对照：PIER_NAME.PE 保持繁体");

/* ══════════════════════════════════════════════════════════════════════
 * [6] 空态三值 = 三句不同的话，且无归因错误词
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[6] 空态三值文案");
const REASONS = ["none_remaining_today", "no_service_today", "not_yet_collected"] as const;
const BANNED = ["暂无数据", "系統", "系统", "加载失败", "未知", "N/A", "--"];
for (const kind of ["airport", "ferry"] as const) {
  const titles = REASONS.map((r) => emptyCopy(r, kind, "dep").title);
  assertEq(new Set(titles).size, 3, `${kind}：三值三句不同的话`);
  for (const r of REASONS) {
    const { title, body } = emptyCopy(r, kind, "dep");
    const text = title + body;
    assert(!BANNED.some((w) => text.includes(w)), `${kind}/${r}：不含归因错误词（${BANNED.join("/")}）`);
    assert(text.length > 8, `${kind}/${r}：文案非空壳`);
  }
}
assert(emptyCopy("not_yet_collected", "ferry", "dep").body.includes("不是没有"), "「未采集」必须说清不是我方故障≠没有班次");

/* ══════════════════════════════════════════════════════════════════════
 * [7] 列模板（四个界面各自的列数与列头）
 *
 *   ★ 判据变更（2026-11-07）：**不再**用「类名末位数字」当列数。
 *     旧判据 `Number(s.cls.slice(-1))` 已失效 —— 红轮实测：
 *       tbl-sea3 表头 4 / 旧期望 3 · tbl-sea5 表头 6 / 旧期望 5 · tbl-sea4 表头 5 / 旧期望 4
 *     定性：**口径偏，不是实现缺**。依据两处（前端已明写）：
 *       · `XbTable.tsx:48-57`「船侧三个模板名里的数字**不再等于列数**（各 +1 了『船务公司』）…
 *          `scripts/check-xborder-ui.tsx` 那条『表头数 = 类名末位数字』的断言因此失效，
 *          需由 QA 改为按实际列数表」
 *       · `globals.css:10671`「模板名里的数字**不再等于列数**（船侧各 +1）」
 *     ⇒ 改为与 **CSS 里真实的 `grid-template-columns` 轨道数**对照：
 *       表头格数 ≠ 网格轨道数 = 整列错位（这才是那条断言真正要守的东西）。
 *       右值**从 CSS 现读**，不写死任何数字（连"实际列数表"都不必维护）。
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[7] 列模板");
assertEq(tableSpec("airport", "dep", "day").cls, "tbl-air5", "机场 离澳 当日所有 ⇒ 用 tbl-air5（含登机口）");
assert(tableSpec("airport", "dep", "day").heads.includes("登机口"), "机场 离澳 全量有登机口列");
assertEq(tableSpec("airport", "arr", "day").cls, "tbl-air4", "机场 抵澳 ⇒ 用 tbl-air4");
assert(!tableSpec("airport", "arr", "day").heads.includes("登机口"), "抵澳无登机口列（上游无此字段）");
assertEq(tableSpec("airport", "dep", "now").cls, "tbl-air4", "机场 最近五班 ⇒ 用 tbl-air4（不显示登机口）");
assertEq(tableSpec("ferry", "dep", "now").cls, "tbl-sea3", "船 最近五班 ⇒ 用 tbl-sea3");
assertEq(tableSpec("ferry", "dep", "day").cls, "tbl-sea5", "船 离澳 当日所有 ⇒ 用 tbl-sea5（含闸口）");
assertEq(tableSpec("ferry", "arr", "day").cls, "tbl-sea4", "船 抵澳 当日所有 ⇒ 用 tbl-sea4（无闸口）");

/* ── 从 globals.css 现读每个模板的真实网格轨道数 ── */
const CSS_PATH = resolve(process.cwd(), "src/app/globals.css");
const CSS_TEXT = readFileSync(CSS_PATH, "utf8");
/** 取 `.tbl-xxx .xb-th, .tbl-xxx .xb-tr { grid-template-columns: … }` 里的轨道数；取不到 ⇒ null
 *  `text` 可注入 —— 供下面的**内存篡改**变异对照使用（不写盘、不碰 `src/`） */
function gridTracks(cls: string, text: string = CSS_TEXT): number | null {
  const re = new RegExp(`\\.${cls}\\s+\\.xb-th[^{]*\\{[^}]*grid-template-columns:\\s*([^;]+);`);
  const m = text.match(re);
  if (!m) return null;
  /* 按**顶层**空格切分：`minmax(0, 68px)` 内的空格与逗号不是分隔符 */
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of m[1]) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out.length;
}

for (const [k, d, a] of [
  ["airport", "dep", "day"],
  ["airport", "arr", "day"],
  ["airport", "dep", "now"],
  ["ferry", "dep", "now"],
  ["ferry", "dep", "day"],
  ["ferry", "arr", "day"],
] as const) {
  const s = tableSpec(k, d, a);
  const tracks = gridTracks(s.cls);
  assert(tracks != null, `${s.cls}：能在 globals.css 里取到 grid-template-columns（取不到 ⇒ 类名与样式脱钩）`);
  assertEq(s.heads.length, tracks, `${s.cls}（${k}/${d}/${a}）：表头格数 = CSS 网格轨道数（不一致会导致整列错位）`);
}
/* ★ 变异对照：证明上面那条判据**不是永真** —— 故意算错一格，必须不成立 */
const sea5 = tableSpec("ferry", "dep", "day");
const sea5Tracks = gridTracks(sea5.cls);
assert(sea5Tracks !== sea5.heads.length - 1, `变异对照：若「表头格数 = 轨道数−1」成立 ⇒ 少一列（实际 ${sea5.heads.length} / 轨道 ${sea5Tracks}）`);
assert(sea5Tracks !== sea5.heads.length + 1, `变异对照：若「表头格数 = 轨道数+1」成立 ⇒ 多一列（实际 ${sea5.heads.length} / 轨道 ${sea5Tracks}）`);
assertEq(gridTracks("tbl-does-not-exist"), null, "变异对照：不存在的模板名取不到轨道数 ⇒ 证明 parser 真在解析 CSS，不是恒返回同一个数");

/* ★ 变异对照 B（**内存**篡改 CSS，不写盘、不碰 `src/`）：
 *   把 sea5 的 6 轨改写成 5 轨，重解析必须得 5，且 5 ≠ 表头格数 6
 *   ⇒ 证明「CSS 少一轨」时这条判据**会红**，不是恒真。 */
const tampered = CSS_TEXT.replace(
  /(\.tbl-sea5\s+\.xb-th[^{]*\{[^}]*grid-template-columns:\s*)[^;]+;/,
  "$1minmax(72px, 1fr) 72px 54px 48px 90px;",
);
assert(tampered !== CSS_TEXT, "变异对照 B：内存篡改确实改到了 sea5 那一行（改不到 ⇒ 正则与 CSS 写法脱钩）");
assertEq(gridTracks("tbl-sea5", tampered), 5, "变异对照 B：篡改后按 5 轨解析出来（实际篡改生效）");
assert(
  gridTracks("tbl-sea5", tampered) !== sea5.heads.length,
  `变异对照 B：CSS 若只剩 5 轨 ⇒ 「表头格数 = 轨道数」会红（表头 ${sea5.heads.length}）——判据随 CSS 变，非永真`,
);

/* 船侧三个模板必须含「船务公司」列（负责人 2026-11-07 新需求 ⑤「船名后要加船务公司」）
   ⚠️ 这条锁的是**新需求已落地的既成事实**；若日后取消该列，改这里而不是改上面的轨道数判据。 */
for (const [k, d, a] of [
  ["ferry", "dep", "now"],
  ["ferry", "dep", "day"],
  ["ferry", "arr", "day"],
] as const) {
  const s = tableSpec(k, d, a);
  assert(s.heads.includes("船务公司"), `${s.cls}（${k}/${d}/${a}）：含「船务公司」列（新需求 ⑤）`);
}
assert(!tableSpec("airport", "dep", "day").heads.includes("船务公司"), "机场侧**不**得出现「船务公司」列（上游无此字段）");

console.log(`\n结果：通过 ${pass} · 失败 ${fail}`);
if (fail) {
  console.error("\n❌ 跨境交通前端断言不符 —— 每条 ✗ 都会在页面上表现为「看起来正常、其实说错话」。");
  process.exit(1);
}
