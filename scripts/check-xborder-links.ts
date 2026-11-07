/**
 * 深链门禁（scripts/check-xborder-links.ts · 契约 §4.4）
 *
 * ── 条款依据（原文）───────────────────────────────────────────────────
 *   海事局《使用條款》「￭ 連到本網站」：
 *     「外部網站直接連到本網站的首頁無需得到批准，但仍必須在超連結上使用本網站的官方名稱。
 *       如果要連結到**非首頁**，則必須事前得到海事及水務局的書面授權。」
 *   ⇒ 用户界面上唯一允许的海事局链接是**首页**，且链接文字必须是官方名称。
 *      `departure.aspx` / `arrival.aspx` / `schedule_7days.aspx` 这类非首页一律不得出现。
 *
 * ── 一条真实存在的矛盾（不掩盖，靠目录边界解决）────────────────────────
 *   解析器**必须**持有上游 URL 才能拉数据，所以门禁不能"全站禁止"。
 *   ⇒ 唯一豁免目录：`src/lib/cross-border/upstream/**`。
 *      其它任何目录（含 `links.ts`）出现上游 URL ⇒ FAIL。
 *   ⚠️ 绝对不允许"为了避免被扫而把 URL 拆成字符串拼接"——那是规避自家门禁，
 *      比违规本身更糟，且让下一个人找不到真实地址。
 *
 * ── 门禁必须能跑红 ────────────────────────────────────────────────────
 *   脚本自带 5 条注入自检（首页允许 / 带尾斜杠允许 / 非首页拦截 / 独立 aspx 文件名拦截 /
 *   注释不参与判定）。只验绿的门禁等于没有门禁（契约 §6 步骤 11 的同一条要求）。
 *
 * ── 一个实现细节（踩过）──────────────────────────────────────────────
 *   注释必须**按整份文件**剥离后再逐行判定，不能逐行剥离：
 *   本仓库多个文件的块注释里写着"不提供 departure.aspx 外链"这类**说明**，
 *   逐行剥离时那几行并不在块注释内部（块注释跨行），会被误判成违规（门禁假红）。
 *   剥离时还要**保留换行数**，否则行号会漂。
 *
 * 跑法：npm run check:xborder-links
 * 退出码：0 = 无违规且自检通过；1 = 有违规或自检失败
 */
import fs from "node:fs";
import path from "node:path";

const SRC_ROOT = path.resolve("src");
/** 唯一允许出现上游 URL 的目录（见文件头「真实存在的矛盾」） */
const EXEMPT = path.resolve("src/lib/cross-border/upstream");

/** 非首页页面的特征：`.aspx` 一律视为非首页（海事局站内所有页面都是 aspx） */
const ASPX = /\.aspx/i;
/** 海事局主机名（首页允许，带路径不允许） */
const MARINE_HOST = "marine.gov.mo";
/** 主机名后紧跟的路径（ASCII 足够：路径只由字母数字与 . _ - / 组成） */
const PATH_RE = new RegExp("^[/]+[A-Za-z0-9._/-]*");

/**
 * 把注释内容替换成等长空白，**保留换行**（这样行号不漂）。
 * 注释里的"说明文字"不应触发门禁，但代码里的字符串会（那才是真链接）。
 */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

/** 对**已剥注释**的文本做判定 */
function detect(text: string): string[] {
  const out: string[] = [];
  if (ASPX.test(text)) out.push("出现 .aspx 非首页路径");
  // 主机名之后如果紧跟一个非空路径，就是非首页深链。
  // 不用正则一次吃掉整条 URL：URL 尾部可能带查询串与括号，写宽了误伤、写窄了漏判。
  // 这里只回答一个问题：主机名后面有没有路径。字符集取 ASCII 足够。
  for (
    let i = text.indexOf(MARINE_HOST);
    i >= 0;
    i = text.indexOf(MARINE_HOST, i + MARINE_HOST.length)
  ) {
    const rest = text.slice(i + MARINE_HOST.length);
    const m = PATH_RE.exec(rest);
    const suffix = m ? m[0] : "";
    // 首页的两种合法写法：`https://www.marine.gov.mo` 与 `https://www.marine.gov.mo/`
    if (suffix !== "" && suffix !== "/") out.push(`marine.gov.mo 带路径：${MARINE_HOST}${suffix}`);
  }
  return out;
}

/** 判定一段源码（自行剥注释），供自检与整文件判定使用 */
export function violationsOf(source: string): string[] {
  return detect(blankComments(source));
}

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path.resolve(full) === EXEMPT) continue; // 目录级豁免（唯一一处）
      collect(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════
 * 自检：门禁必须能抓到"最像合规"的写法
 * ══════════════════════════════════════════════════════════════════════ */
const SELF_CASES: { name: string; src: string; expectViolation: boolean }[] = [
  {
    name: "首页常量（允许，无尾斜杠）",
    src: `export const MARINE_HOME = "https://www.marine.gov.mo";`,
    expectViolation: false,
  },
  {
    name: "首页常量（允许，带尾斜杠）",
    src: `const u = "https://www.marine.gov.mo/";`,
    expectViolation: false,
  },
  {
    name: "非首页深链（拦截）",
    src: `const u = "https://www.marine.gov.mo/departure.aspx?local=PE";`,
    expectViolation: true,
  },
  {
    name: "只出现 aspx 文件名（拦截）",
    src: `if (url.includes("schedule_7days.aspx")) {}`,
    expectViolation: true,
  },
  {
    name: "行注释里提到（允许，不参与判定）",
    src: `// 不要放 arrival.aspx 的链接`,
    expectViolation: false,
  },
  {
    name: "跨行块注释里提到（允许，最容易误判的一条）",
    src: `/**\n * 本端点不提供 departure.aspx 外链\n */\nconst a = 1;`,
    expectViolation: false,
  },
];

function selfTest(): void {
  console.log("─── 门禁自检 ───");
  let bad = 0;
  for (const c of SELF_CASES) {
    const hit = violationsOf(c.src).length > 0;
    const ok = hit === c.expectViolation;
    if (!ok) bad++;
    console.log(
      `${ok ? "OK  " : "FAIL"}  ${c.name.padEnd(34)} 期望=${c.expectViolation ? "违规" : "合规"} 实际=${hit ? "违规" : "合规"}`,
    );
  }
  if (bad) {
    console.error(`\n❌ 门禁自检失败（${bad} 条）—— 脚本自身不可信，先修脚本再看扫描结果。`);
    process.exit(1);
  }
}

selfTest();

/* ══════════════════════════════════════════════════════════════════════
 * 正式扫描
 * ══════════════════════════════════════════════════════════════════════ */
const files = collect(SRC_ROOT).sort();
const findings: { file: string; line: number; text: string; why: string }[] = [];

for (const file of files) {
  const raw = fs.readFileSync(file, "utf8");
  const rawLines = raw.split(/\r?\n/);
  const blankedLines = blankComments(raw).split(/\r?\n/);
  for (const [i, line] of blankedLines.entries()) {
    const v = detect(line);
    if (v.length)
      findings.push({ file, line: i + 1, text: (rawLines[i] ?? "").trim(), why: v.join("；") });
  }
}

console.log(`\n═══ 海事局深链门禁（契约 §4.4）═══`);
console.log(`扫描 ${files.length} 个源文件（豁免目录：src/lib/cross-border/upstream/**）\n`);

for (const f of findings) {
  console.log(`FAIL  ${path.relative(process.cwd(), f.file)}:${f.line}  ${f.why}`);
  console.log(`      ↳ ${f.text}`);
}

// 反向断言：`links.ts` 必须恰好提供首页常量（缺了前端就会自己硬编码，然后硬编码出非首页）
const linksSrc = fs.readFileSync(path.resolve("src/lib/cross-border/links.ts"), "utf8");
const hasMarineHome = /export const MARINE_HOME\s*=\s*"https:\/\/www\.marine\.gov\.mo"/.test(
  linksSrc,
);
const hasDataGovHome = /export const DATA_GOV_HOME\s*=\s*"https:\/\/data\.gov\.mo"/.test(linksSrc);
console.log(
  `${hasMarineHome ? "OK  " : "FAIL"}  links.ts 导出首页常量 MARINE_HOME（唯一允许对外的海事局链接）`,
);
console.log(`${hasDataGovHome ? "OK  " : "FAIL"}  links.ts 导出数据平台首页 DATA_GOV_HOME`);

const missing = hasMarineHome && hasDataGovHome ? 0 : 1;
console.log(`\n深链违规 ${findings.length} · 常量缺失 ${missing}`);
if (findings.length + missing > 0) {
  console.error(
    "\n❌ 存在非首页深链或缺失首页常量。海事局条款：连非首页需事前书面授权。\n" +
      "   上游 URL 只能出现在 src/lib/cross-border/upstream/ 下；对外链接只允许首页。",
  );
  process.exit(1);
}
