/**
 * 合规断言（scripts/test-xborder-compliance.ts · 契约 §4.1 / §4.2 / §4.3）
 *
 * ── 为什么合规要写测试，而不是写在文档里 ────────────────────────────────
 *   契约原话：「每条都要有一个能跑红的断言。写在文档里没人执行，等于没写」。
 *   两个源的义务不同，且都有一条**反向**义务（不许简写、不许改写）：
 *     · 机场（data.gov.mo）：注明来源 + 取得日期；
 *     · 船（海事局）　　：注明来源（**必须用完整官方自称**）+ 取得日期 +
 *                         「均不可以修改任何內容」+ 不得深链非首页。
 *
 * ── 三组断言 ──────────────────────────────────────────────────────────
 *   A. 署名文本：含完整官方自称；**反向**断言禁止简写成「海事局」。
 *   B. 取得日期：格式 + 澳门本地日（跨 UTC 日界线时不得差一天）。
 *   C. 字符级等值 + 代码级门禁：上游文本经解析后逐字符不变；
 *      并扫源码禁止对 `*_raw` 变量做 replace / 大小写 / 全半角 / 繁简转换。
 *      ⚠️ 门禁**带自检**（注入一个违规样本必须被抓到）—— 只验绿的门禁等于没有门禁。
 *
 * 运行：npm run test:xborder-compliance
 */
import fs from "node:fs";
import path from "node:path";
import {
  airportAttribution,
  AIRPORT_ATTRIBUTION_TEXT,
  MARINE_ATTRIBUTION_TEXT,
  marineAttribution,
} from "../src/lib/cross-border/attribution";
import { parseFerrySailings } from "../src/lib/cross-border/ferry/parse";
import { macauDate } from "../src/lib/cross-border/time";

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

const FIX = path.resolve(process.cwd(), "scripts/fixtures/xborder");
const AT = new Date("2026-11-06T23:20:00+08:00");

console.log("跨境交通 · 合规断言\n");

/* ══════════════════════════════════════════════════════════════════
 * A. 署名文本（两套，不可混用）
 * ══════════════════════════════════════════════════════════════════ */
console.log("A. 署名文本");

// 机场：来源平台 + 机场航班资讯
assert(AIRPORT_ATTRIBUTION_TEXT.includes("data.gov.mo"), "机场署名含来源平台 data.gov.mo");
assert(AIRPORT_ATTRIBUTION_TEXT.includes("澳門國際機場"), "机场署名含数据主体「澳門國際機場」");
assert(!AIRPORT_ATTRIBUTION_TEXT.includes("海事"), "机场署名不得混入海事局（两套授权性质不同）");

// 船：必须逐字含官方自称
const OFFICIAL = "澳門特別行政區海事及水務局";
assert(
  MARINE_ATTRIBUTION_TEXT.includes(OFFICIAL),
  `船署名含**完整官方自称**「${OFFICIAL}」（条款引号内原文）`,
);
// ★ 反向断言：禁止简写。`海事及水務局` 里「海事」与「局」之间夹着「及水務」，故不含连续的「海事局」
assert(
  !(MARINE_ATTRIBUTION_TEXT.includes("海事局") && !MARINE_ATTRIBUTION_TEXT.includes(OFFICIAL)),
  "反向断言：船署名不得出现单独形式的「海事局」（如「澳門海事局」）",
);
assert(
  MARINE_ATTRIBUTION_TEXT.includes("資料來源"),
  "船署名以「資料來源：」起头（条款要求注明内容来源）",
);

/* ══════════════════════════════════════════════════════════════════
 * B. 取得日期（澳门本地）
 * ══════════════════════════════════════════════════════════════════ */
console.log("\nB. 取得日期");
const a1 = airportAttribution(AT);
const m1 = marineAttribution(AT);
assert(
  /^\d{4}-\d{2}-\d{2}$/.test(a1.acquiredOn),
  `机场 acquiredOn 形如 YYYY-MM-DD（${a1.acquiredOn}）`,
);
assertEq(a1.acquiredOn, "2026-11-06", "机场 acquiredOn = 该批数据的澳门本地日期");
assertEq(m1.acquiredOn, "2026-11-06", "船 acquiredOn 同口径");
assertEq(a1.text, AIRPORT_ATTRIBUTION_TEXT, "机场 attribution.text 就是常量本身（无二次加工）");
assertEq(m1.text, MARINE_ATTRIBUTION_TEXT, "船 attribution.text 就是常量本身");

// 跨 UTC 日界线：UTC 16:30 = 澳门次日 00:30 ⇒ 日期必须跟着变（不能用 UTC 日期）
assertEq(
  marineAttribution(new Date("2026-11-06T16:30:00Z")).acquiredOn,
  "2026-11-07",
  "UTC 16:30 ⇒ 澳门已是次日（取得日期按澳门本地算，不按 UTC）",
);
assertEq(
  marineAttribution(new Date("2026-11-06T15:59:00Z")).acquiredOn,
  "2026-11-06",
  "UTC 15:59 ⇒ 澳门仍是当日（边界另一侧）",
);

// 从未采集过：仍给一个可渲染的日期（今天），并保证格式合法
const never = marineAttribution(null);
assert(
  /^\d{4}-\d{2}-\d{2}$/.test(never.acquiredOn),
  "从未采集过时 acquiredOn 仍是合法日期（不至于 UI 空着）",
);
assertEq(never.acquiredOn, macauDate(), "从未采集过 ⇒ acquiredOn 取响应时刻的澳门日期");

/* ══════════════════════════════════════════════════════════════════
 * C1. 字符级等值（上游文本经解析后逐字符不变）
 * ══════════════════════════════════════════════════════════════════ */
console.log("\nC1. 字符级等值（真实快照）");
const sail = parseFerrySailings(
  fs.readFileSync(path.join(FIX, "ferry-dep-PE.html"), "utf8"),
  "PE",
  "dep",
  AT,
);
// 逐条把解析结果与**快照原文**对照：状态/船名/船种/公司/目的港
const PAIRS: [string, string][] = [
  ["17:04 啟航", sail[0].statusRaw],
  ["香港", sail[0].placeRaw],
  ["宇航 2006", sail[0].vesselRaw ?? ""],
  ["豪華雙體船", sail[0].vesselTypeRaw ?? ""],
  ["噴射飛航", sail[0].operatorRaw],
  ["待航", sail.find((r) => r.statusRaw === "待航")?.statusRaw ?? ""],
];
for (const [want, got] of PAIRS) assertEq(got, want, `解析后逐字符等于原文「${want}」`);

// 内部全角空格必须保留（不得做全半角转换）；两侧空白才允许 trim（§4.3 明确只允许 trim）
const synthetic = `<table class='item_table table-striped'>
<tr><th>航班</th><th>目的港</th><th>狀態</th><th>閘口</th><th>船名(船種)</th><th>船務公司</th></tr>
<tr><td>20:00</td><td>香港</td><td>18:03　啟航</td><td></td><td>宇航　2005<br>雙體船</td><td>噴射飛航</td></tr>
</table>`;
const s2 = parseFerrySailings(synthetic, "PE", "dep", AT);
assert(
  s2[0].statusRaw.includes("\u3000"),
  "状态文本里的**内部全角空格 U+3000 被保留**（禁止全半角转换）",
);
assertEq(s2[0].statusRaw, "18:03　啟航", "内部全角空格逐字符一致");
assert(s2[0].vesselRaw?.includes("\u3000") === true, "船名内部全角空格同样保留");

// 两侧空白：允许 trim（判空用），且 trim 后语义仍是同一条状态
const padded = `<table class='item_table table-striped'>
<tr><th>航班</th><th>目的港</th><th>狀態</th><th>閘口</th><th>船名(船種)</th><th>船務公司</th></tr>
<tr><td>20:00</td><td>香港</td><td>　待航　</td><td></td><td><br></td><td>噴射飛航</td></tr>
</table>`;
assertEq(
  parseFerrySailings(padded, "PE", "dep", AT)[0].statusRaw,
  "待航",
  "两侧空白按 §4.3 允许的 trim 处理",
);

/* ══════════════════════════════════════════════════════════════════
 * C2. 代码级门禁（+ 自检：注入违规必须被抓到）
 * ══════════════════════════════════════════════════════════════════ */
console.log("\nC2. 代码级门禁（禁止改写 *_raw）");

/** 展示文本变量名：`status_raw` / `vessel_raw` / `place_raw` / `operator_raw` 及其驼峰形式 */
const RAW_VAR = String.raw`(?:status|vessel(?:Type)?|place|operator)(?:_?[Rr]aw)`;
/**
 * 禁止的加工：replace / toLowerCase / toUpperCase / normalize（含 NFKC 全半角归一）。
 * `trim()` **不在**禁止列表里 —— 契约 §4.3 明确"只允许 trim()（判空用）"。
 */
const FORBIDDEN = new RegExp(
  String.raw`${RAW_VAR}\s*\.\s*(replace|toLowerCase|toUpperCase|normalize)\s*\(`,
  "g",
);

/** 去掉注释与字符串字面量（避免注释里写"禁止 replace"反而被抓） */
function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/** 扫一个目录下所有 .ts/.tsx，返回违规清单 */
function scanDir(dir: string): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...scanDir(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    const raw = fs.readFileSync(full, "utf8");
    const stripped = stripCommentsAndStrings(raw);
    for (const [i, line] of stripped.split(/\r?\n/).entries()) {
      FORBIDDEN.lastIndex = 0;
      if (FORBIDDEN.test(line))
        out.push({ file: full, line: i + 1, text: raw.split(/\r?\n/)[i].trim() });
    }
  }
  return out;
}

// 自检：门禁必须能抓到"最像合规写法"的违规（而不是只抓明显违规）
const SELF_CASES: { src: string; expectHit: boolean; why: string }[] = [
  { src: `const x = statusRaw.replace('啟航', '开航');`, expectHit: true, why: "直接改写状态文本" },
  { src: `const y = row.status_raw.toLowerCase();`, expectHit: true, why: "大小写转换" },
  { src: `const z = vesselRaw.normalize('NFKC');`, expectHit: true, why: "全半角归一（NFKC）" },
  { src: `const t = statusRaw.trim();`, expectHit: false, why: "trim 是契约允许的唯一加工" },
  { src: `// 注释里写 statusRaw.replace( 不算违规`, expectHit: false, why: "注释不参与判定" },
  {
    src: `const no = String(item.flightNo).toUpperCase();`,
    expectHit: false,
    why: "flightNo 是我方归一字段，不属展示原文",
  },
];
for (const c of SELF_CASES) {
  FORBIDDEN.lastIndex = 0;
  const hit = FORBIDDEN.test(stripCommentsAndStrings(c.src));
  assertEq(hit, c.expectHit, `门禁自检：${c.why}`);
}

const violations = [
  ...scanDir(path.resolve("src/lib/cross-border")),
  ...scanDir(path.resolve("src/app/api/cross-border")),
];
for (const v of violations) {
  console.error(`  ↳ ${path.relative(process.cwd(), v.file)}:${v.line}  ${v.text}`);
}
assertEq(
  violations.length,
  0,
  "src/lib/cross-border 与 src/app/api/cross-border 下无任何 *_raw 改写（§4.3）",
);

console.log(`\n结果：通过 ${pass} · 失败 ${fail}`);
if (fail) {
  console.error("\n❌ 合规断言未通过 —— 这些是**条款级**义务，不是风格问题。");
  process.exit(1);
}
