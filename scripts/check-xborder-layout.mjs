#!/usr/bin/env node
/**
 * 跨境表格窄屏布局门禁（`scripts/check-xborder-layout.mjs`，2026-11-07 新建）
 *
 * ── 守什么（六条，全部真浏览器实测）────────────────────────────────────────
 *   1 表头字号   A 档(≤409) = 10px / B 档(≥410) = 11px    出处：05 稿 L1905 列头 + L1912 定量表
 *   2 表头文案   A 档短名「到达 / 出发」/ B 档全名「到达地 / 计划出发」  出处：今日裁定
 *   3 横滚三态   `scrollWidth > clientWidth` 即 SCROLL(FAIL)；余量分 SCROLL / EDGE / TIGHT / OK
 *   4 船务公司列 A **56** / B 72，且**实测列宽 ≥ 该列最长文案现场渲染宽**（不写死 65）
 *     ⚠️ A 档 66 已作废（把 13px 的 65.00 当 11px 用；11px 实需 55.00 ⇒ 56 即够）
 *   5 min-width 无赘肉：`min-width === Σmin + gap×(n−1) + padL + padR`，多 1px 即不合规
 *     ⚠️ **Σmin / gap / pad / min-width 四项必须同取自一个视口下的同一档**。
 *        A 档 Σmin 与 B 档 Σmin 本来就不同（air4：242 vs 266），混档必假红：
 *        拿 B 档 266 算 A 档 need ⇒ 270 被算成 294 ⇒ 落盘后报「不够红 −24」。
 *        ⇒ 缺 A 档声明时只报 `F5-Amiss-*`，**绝不拿 B 档 Σmin 硬算 A 档 need**；
 *          并由 `CS-10` 自检「A/B 两档轨道原文必须不同」防同一个 bug 复发。
 *   6 `--sheet-gutter` token 真被引用（用「改 token ⇒ 内距跟着变」证明接线，不靠 grep 字符串）
 *
 * ── 为什么必须有这个文件 ────────────────────────────────────────────────────
 *   这六条**全都不会报错**：字号小了、文案长了、表滚了、列窄了、min-width 有赘肉、
 *   token 没人用 —— 编译通过、类型通过、单测通过，只有真机上肉眼能看出来。
 *   而"肉眼能看出来"在异步协作里等于"没人看"。⇒ 只能量化钉死。
 *
 * ── 五条已踩过的假绿（每条都在下面的取数代码里对应一行显式防护）──────────
 *   G1 量 `documentElement` 而不是 `.xb-sheet__body` ⇒ 横滚永远判绿。
 *   G2 量 `.xb-th` 容器而不是里面每个 `span`  ⇒ 表头字号恒等于容器值。
 *   G3 量行的 `scrollWidth` 而不是逐格文字盒 ⇒ `.xb-c` 是 `overflow:visible`，
 *      单格溢出不改变行 scrollWidth，只画到隔壁格上 ⇒ 结构性失明。
 *   G4 量 `scrollWidth` 而不比「内容盒宽」⇒ 溢出被右内距吸收时它一秒不涨
 *      （`scrollWidth − clientWidth = max(0, padL + 需 − clientWidth)`）。
 *   G5 用「已被 `1fr` 撑满的**填充值**」当「需要的宽」⇒ 余量恒为 0。
 *      ⇒ 本脚本的 `Σmin` **只从 CSS 声明里取**（`minmax(56px,1fr)` 取 56），
 *        绝不从 `getComputedStyle().gridTemplateColumns` 的解析后 px 里取。
 *
 * ── 三态符号（替代上一版打不出来的 `PASS-MARGIN-TIGHT`）──────────────────
 *   `sw − cw` 的下界是 0（内容 100px 时它仍是 0），所以「用 sw−cw 分档」恒不可达。
 *   改成**两个独立观测量**：
 *     · 滚动与否 = **实测** `sw > cw`（这一个是硬的，直接来自滚动容器）
 *     · 余量    = **算出来**的 `margin = clientWidth − min-width`
 *   状态：
 *     SCROLL  margin <  0            ← 必须与「实测 sw > cw」同时成立，否则报脚本自检错
 *     EDGE    margin === 0           ← 刚好贴边，没余量
 *     TIGHT   1 ≤ margin ≤ 2         ← 余 1~2px，任何文案变动就翻
 *     OK      margin ≥ 3
 *   防恒真：`SCROLL` 只认实测，`margin` 只用来**分级**；两者矛盾时判**脚本坏了**，
 *   而不是判产品绿。（下面 `[自检] CS-1` 就是这条。）
 *
 * ── 不进 `npm run verify` ──────────────────────────────────────────────────
 *   要起真 Chrome。**本机可跑**（`node scripts/check-xborder-layout.mjs`）；
 *   干净克隆（没装 playwright-core 或没 Chrome）会**响亮 SKIP**（exit 0 但打印大块警示，
 *   **不假装 PASS**）。`playwright-core` 刻意**不进 devDependencies**（不动 package.json /
 *   lockfile），因此本脚本**不构成 CI 门禁**，只是本机守门员。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/* ══════════════════════════════════════════════════════════════════════════
 * 期望值表 —— 每一条都必须能追到出处，不许"我觉得"
 * ════════════════════════════════════════════════════════════════════════ */
const SPEC = {
  /* 出处：`docs/迭代-跨境交通-20261106/05-跨境交通界面设计.html`
     L1905「列头 10px / .04em」（320 档），L1912 定量表「320 = 10」。 */
  headerFont: { A: 10, B: 11 },
  /* 表头字距。A 档 `.04em × 10px = 0.40px`；B 档保持现值 `.06em × 11px = 0.66px`。
     ⚠️ 05 稿 L1858 的内联片段写的是 `letter-spacing:0`，那是**稿子手误**（同一份稿
     在 L1912 的定量表里给的是 `.04em`）⇒ 权威值取 `.04em`，实现若取 0 必须判红。 */
  headerTracking: { A: 0.4, B: 0.66 },
  /* 列间距。出处：05 稿 L1858 内联 `column-gap:4px`、L1861/1868/1875/1882 四条数据行同为 4、
     L1913 定量表「320 列 = 4」、L1894 散文「列间距 8 → 4」（8 是 390/375 起点，4 是 320 值）。 */
  gap: { A: 4, B: 8 },
  /* 单元格左右内距/侧。A 档 8（今日裁定）；B 档保持现值 16。 */
  padSide: { A: 8, B: 16 },
  /* 出处：2026-11-07 负责人裁定 —— 窄屏表头用短名，宽屏用全名。
     A 档短名不带"地/计划"前缀，是为了在 46~50px 的列里不折行。 */
  headerCopy: {
    A: { addr: "到达", depart: "出发" },
    B: { addr: "到达地", depart: "计划出发" },
  },
  /* 船务公司列。A 档 **56** / B 档 72。
     ⚠️ A 档曾定 66，**已作废**（负责人 2026-11-07 撤回）：66 是按
     `资料未公开` **@13px = 65.00** 推的，而 A 档整档表体是 **11px ⇒ 实需 55.00** ⇒ 56 即够。
     且 66 会让 sea5 总宽从 315 涨到 325、320 下横滚 5px，违反「三档零横滚」。
     B 档 72 来自 CSS 注释里「船务公司 46.6 / 65 → 72」那条推导（代码目前漂成 56）。
     ⚠️ **文案宽不写死**：判据现场量（探针复制该格 computed font）⇒ 落地后 320 下自动量到 11px / 55.00。 */
  companyCol: { A: 56, B: 72 },
  /** 档位划分：A ≤409（320/375/390/401/409）/ B ≥410（414 起） */
  breakpoint: 410,
  /* 表体字号。A 档整档 11px / B 档保持 13px。
     判4 的「装得下」必须**同一口径**量：轨道按 A 档读、文案却按 13px 量 ⇒ 一定假红
     （`资料未公开` 13px=65.00 vs 11px=55.00，差 10px 全是字号口径差）。
     ⇒ 用 `bodyFont` 断言把口径钉住，混档当场暴露。 */
  bodyFont: { A: 11, B: 13 },
  /* 状态列字号 `.xb-c--st`：基础档 12px，`@media (max-width: 409px)` 显式降到 `--text-2xs` = 11px。
     ⚠️ 这一条**必须显式写**而不是靠 `@media (max-width:400px)` 那条继承 ——
     那条止于 400，401–409 这 9px 会漏档。（CSS 注释里也写了：sea4 状态列 80px 装 12px 的
     `預計 11:45 到達` = 83.36 ⇒ 溢 3.36，所以这一档的 11px 不是可选项。） */
  statusFont: { A: 11, B: 12 },
  /* ★★★ A 档 `grid-template-columns` **原文**（FINAL 补丁）。这是判5「按档读」的验收基准。
     为什么要写在这里：A 档 Σmin 与 B 档 Σmin **根本不同**
       air4  A: 44+46+40+112 = **242**   vs  B: 48+56+50+112 = **266**
     拿 B 档 Σmin 算 A 档 need ⇒ 270 被算成 294 ⇒ 差 24px ⇒ 报「不够红 −24」这种最容易被
     误读成「轨道要给回 294」的红。所以 A 档轨道必须**按档取**，且要能逐条对上这里。
     推导（gap 4 / pad 8+8）：242+12+16=270 / 274+16+16=306 / 201+12+16=229
                               / 281+16+16=313 / 279+20+16=315 */
  aTracks: {
    "tbl-air4": "44px minmax(46px,1fr) 40px minmax(112px,1fr)",
    "tbl-air5": "44px minmax(46px,1fr) 40px minmax(112px,1fr) 32px",
    "tbl-sea3": "minmax(59px,1fr) 56px 46px 40px",
    "tbl-sea4": "minmax(59px,1fr) 56px 46px 40px 80px",
    "tbl-sea5": "minmax(59px,1fr) 56px 46px 40px 56px 22px",
  },
};

const VIEWPORTS = [
  { w: 320, tier: "A" },
  { w: 375, tier: "A" },
  { w: 390, tier: "A" },
  /* ★ 401 / 409 是 frontend 点名要测的**漏档区间**：现网 `@media (max-width:400px)`
     止于 400，401–409 的状态列仍是 12px。若新档边界设在 409 而不补这一档，就漏人。 */
  { w: 401, tier: "A" },
  { w: 409, tier: "A" },
  /* ★ 410 是**断点本身**：A 档是 `max-width: 409px`，所以 410 必须已经回到 B 档。
     只测 409 与 414 会让"409/410 边界有没有错一档"变成盲区。 */
  { w: 410, tier: "B" },
  { w: 414, tier: "B" },
];

/* 五张表的列结构。`opCol` = 船务公司列下标（机场表为 −1），`stCol` = 状态列下标。 */
const TABLES = [
  { id: "tbl-air4", cols: ["航班号", "到达地", "计划出发", "状态"], opCol: -1 },
  { id: "tbl-air5", cols: ["航班号", "到达地", "计划出发", "状态", "登机口"], opCol: -1 },
  { id: "tbl-sea3", cols: ["船名", "船务公司", "到达地", "计划出发"], opCol: 1 },
  { id: "tbl-sea5", cols: ["船名", "船务公司", "到达地", "计划出发", "状态", "闸口"], opCol: 1 },
  { id: "tbl-sea4", cols: ["船名", "船务公司", "出发地", "计划到达", "状态"], opCol: 1 },
];

/** 每张表的行数据。船务公司列刻意放**最长文案**（缺值兜底），这是 判4 的被测量。
 *  ★ 第 0 列（船名 / 航班号）**必须带 `xb-c--num`** —— `XbTable.tsx` 里
 *    `kind === "airport" ? flightNo : vessel` 与航班号同走 plate 等宽字体（`--plate-font`）。
 *    frontend 实测：`迅隆 11 號` 13px = 71.50 / 11px = 57.97（按 body 字体量只有 50.14，**作废**）。
 *    ⇒ 夹具若漏掉 `--num`，量出来的船名宽会小 7.8px，把"56 够用"这个假结论喂回来。
 *
 *  ★★ **「计划出发 / 计划到达」列只能放 `HH:MM`，放 `08:20 啟航` 是错的** ——
 *    那一格的内容是 `xb-view.ts displaySched()` 的输出：本日 ⇒ 只 `HH:MM`；
 *    跨日 ⇒ `MM-DD HH:MM`。**`啟航 / 到達 / 預計` 这些字属于「状态」列**（`lib/cross-border/status.ts` 的词表）。
 *    第一版夹具把 `08:20 啟航` 塞进「计划出发」，量出比真实文案宽 15px 的溢出
 *    ⇒ 判3 在 sea3 上报了「横滚 4px」的**假红**（sea3 的「计划出发」正好是最后一列，
 *    溢出会顶出表格右缘），还把 CS-1 拖成「脚本矛盾」。
 *    ⇒ 夹具文案必须来自**真实渲染路径**，不许自己编一句"看起来像"的。 */
const ROW_DATA = {
  "tbl-air4": [["CA101", "北京首都", "08:20", "已啟航 08:20"], ["CA103", "上海虹桥", "09:05", "停止登機"]],
  "tbl-air5": [["CA101", "北京首都", "08:20", "已啟航 08:20", "12"], ["CA103", "上海虹桥", "09:05", "停止登機", "18"]],
  "tbl-sea3": [["迅隆 11 號", "资料未公开", "香港", "08:20"], ["新渡轮", "资料未公开", "深圳蛇口", "09:30"]],
  "tbl-sea5": [["迅隆 11 號", "资料未公开", "香港", "08:20", "08:20 啟航", "12"], ["新渡轮", "资料未公开", "深圳蛇口", "09:30", "待航", "18"]],
  "tbl-sea4": [["迅隆 11 號", "资料未公开", "香港", "11:45", "預計 11:45 到達"], ["新渡轮", "资料未公开", "深圳蛇口", "12:10", "12:10 到達"]],
};

/* ══════════════════════════════════════════════════════════════════════════
 * 浏览器解析（复用 `scripts/test-stoprow-geometry.mjs` 的同一套逻辑）
 * ════════════════════════════════════════════════════════════════════════ */
function resolvePlaywright() {
  /* ① 项目依赖 ② 环境变量 ③ 本机 WorkBuddy 沙箱里那份（无浏览器 CI 上必然都没有） */
  const cands = [
    "playwright-core",
    "playwright",
    process.env.PLAYWRIGHT_CORE_DIR,
    "C:/Users/ASUS/.workbuddy/binaries/node/workspace/node_modules/playwright-core",
  ].filter(Boolean);
  const tried = [];
  for (const c of cands) {
    try {
      return { mod: require_(c), from: c };
    } catch (e) {
      tried.push(`${c} (${e.code ?? "ERR"})`);
    }
  }
  return { mod: null, tried };
}
/* ESM 里没有 require —— 用同步的动态 import 不可行，改用 createRequire */
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
function resolveChrome() {
  return [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean).find((p) => existsSync(p)) ?? null;
}
function skip(reason, detail) {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  SKIPPED —— 六条布局判据本次**一条都没有验证**（不是 PASS）           ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");
  console.log(`原因：${reason}`);
  for (const l of detail) console.log(`      ${l}`);
  console.log("⇒ 本门禁要真 Chrome，不进 `npm run verify`，只能主动跑：");
  console.log("   node scripts/check-xborder-layout.mjs");
  process.exit(0);
}

/* ══════════════════════════════════════════════════════════════════════════
 * CSS 取数（全部按**锚文本**定位，不写死行号 —— globals.css 在 12:46:50 漂过）
 * ════════════════════════════════════════════════════════════════════════ */
const cssPath = join(ROOT, "src/app/globals.css");
const cssLines = readFileSync(cssPath, "utf8").split("\n");
const XB_SEL_RE = /^\.xb-[\w-]*(\s*,|\s*\{)/;

/** 切片：整段 `.xb-` 规则（含分段注释），并做完整性自证（见 CS-0） */
function sliceXbSegment() {
  const idx = [];
  cssLines.forEach((l, i) => { if (XB_SEL_RE.test(l.trim())) idx.push(i); });
  if (!idx.length) return { from: 0, to: 0, text: "", nFile: 0, nSlice: 0, startDepth: 0 };
  let from = idx[0];
  for (let i = from; i >= 0; i--) {
    const t = cssLines[i].trim();
    if (t.startsWith("/*")) { from = i; break; }
    if (t === "}") { from = i + 1; break; }
    if (i === 0) from = 0;
  }
  const to = Math.min(cssLines.length, idx[idx.length - 1] + 5);
  const text = cssLines.slice(from, to).join("\n");
  let d = 0;
  for (let i = 0; i < from; i++) for (const ch of cssLines[i]) { if (ch === "{") d++; else if (ch === "}") d--; }
  return { from, to, text, nFile: idx.length, nSlice: text.split("\n").filter((l) => XB_SEL_RE.test(l.trim())).length, startDepth: d };
}
const SEG = sliceXbSegment();

/** 从声明块里取某条属性 */
function declOf(block, prop) {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+);`).exec(block);
  return m ? m[1].trim() : null;
}
/** 把一条 `grid-template-columns` 声明解析成「每轨最小宽」数组。
    ★ G5 防线：只认声明里的字面值 —— `minmax(56px,1fr)` 取 56，`48px` 取 48。
      绝不使用 `getComputedStyle().gridTemplateColumns`（那是 1fr 撑满后的填充值）。 */
function parseTracks(decl) {
  if (!decl) return null;
  const out = [];
  const re = /minmax\(\s*([\d.]+)px\s*,\s*[^)]+\)|([\d.]+)px|minmax\(\s*([\d.]+)px\s*,\s*([\d.]+)px\s*\)/g;
  let m;
  /* 先把 minmax 整体吃掉，再处理裸 px */
  const tokens = [];
  const scan = /minmax\([^)]*\)|[^\s]+/g;
  let t;
  while ((t = scan.exec(decl))) tokens.push(t[0]);
  for (const tk of tokens) {
    let mm = /^minmax\(\s*([\d.]+)px/.exec(tk);
    if (mm) { out.push(parseFloat(mm[1])); continue; }
    mm = /^([\d.]+)px$/.exec(tk);
    if (mm) { out.push(parseFloat(mm[1])); continue; }
    mm = /^([\d.]+)fr$/.exec(tk);
    if (mm) { out.push(0); continue; }
    return null; /* 不认识的单位 ⇒ 宁可报错也不猜 */
  }
  void re; void m;
  return out.length ? out : null;
}

/** 按 `.tbl-xxx .xb-th, .tbl-xxx .xb-tr { … }` 取每张表的轨道声明 + min-width 声明 */
function readTableDecls() {
  const out = {};
  /* 用锚文本 `grid-template-columns` 附近的 `.tbl-<id>` 选择器定位，不写行号 */
  for (const tb of TABLES) {
    const selRe = new RegExp(`\\.${tb.id}\\s+\\.xb-th\\s*,\\s*\\n?\\s*\\.${tb.id}\\s+\\.xb-tr\\s*\\{([\\s\\S]*?)\\n\\}`);
    const sm = selRe.exec(SEG.text);
    const tracks = sm ? parseTracks(declOf(sm[1], "grid-template-columns")) : null;
    const mwRe = new RegExp(`\\.${tb.id}\\s*\\{\\s*\\n?\\s*min-width\\s*:\\s*([\\d.]+)px`);
    const mm = mwRe.exec(SEG.text);
    out[tb.id] = { tracks, minWidth: mm ? parseFloat(mm[1]) : null };
  }
  return out;
}
const DECLS = readTableDecls();

/** 内距 / gap / 表头字号 / token 的**声明侧**事实（用于 判6 静态部分） */
function readGutterDecls() {
  const gut = /--sheet-gutter\s*:\s*([\d.]+)px/.exec(cssLines.join("\n"));
  const thTr = /\.xb-th,\s*\n?\.xb-tr\s*\{([\s\S]*?)\n\}/.exec(SEG.text);
  const body = thTr ? thTr[1] : "";
  return {
    tokenPx: gut ? parseFloat(gut[1]) : null,
    thTrBlock: body,
    padLeftDecl: declOf(body, "padding-left"),
    padRightDecl: declOf(body, "padding-right"),
    gapDecl: declOf(body, "column-gap"),
    headerFontDecl: /\.xb-th\s*\{([\s\S]*?)\n\}/.exec(SEG.text)?.[1] ?? "",
    headerLetterDecl: declOf(/\.xb-th\s*\{([\s\S]*?)\n\}/.exec(SEG.text)?.[1] ?? "", "letter-spacing"),
    varRefCount: (cssLines.join("\n").match(/var\(--sheet-gutter\)/g) ?? []).length,
  };
}
const GUT = readGutterDecls();

/* ══════════════════════════════════════════════════════════════════════════
 * @media 全量清点（嵌套感知的括号配平，不靠行号、不靠正则找块尾）
 *   为什么要做：team-lead 要的「窄屏覆盖到底缺不缺」只能由**枚举**回答。
 *   局部结论（"只有一个 @media 改了 .xb-c--st 字号"）没做全量清点 ⇒ 不完整。
 *   实测：全文件 **35 个 @media**，其中触及表格的只有 1 个，且只改字号。
 *
 *   ⚠️ 别把 `@media (max-width:360px) .nav-xborder-card__title` 误算成表格的媒体查询
 *     （那是需求 7 的卡片）。所以判定一律看**块内选择器**，不看条件长得像不像。
 * ════════════════════════════════════════════════════════════════════════ */
const CSS_ALL = cssLines.join("\n");
const CSS_CLEAN = CSS_ALL.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
function parseCssBlocks(src) {
  const out = [], st = [];
  let seg = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") { st.push({ at: i, head: src.slice(seg, i).trim() }); seg = i + 1; }
    else if (ch === "}") { const b = st.pop(); if (b) out.push({ ...b, end: i }); seg = i + 1; }
  }
  return out;
}
const CSS_BLOCKS = parseCssBlocks(CSS_CLEAN);
const MEDIAS = CSS_BLOCKS.filter((b) => /^@media/.test(b.head));
const innerOf = (m) => CSS_BLOCKS.filter((b) => b.at > m.at && b.end < m.end);
const TABLE_SEL = /\.xb-th|\.xb-tr|\.xb-c\b|\.xb-tbl|\.tbl-(air4|air5|sea3|sea4|sea5)/;
/** 某个媒体查询里，是否有规则**同时**命中 selRe 且声明了 declRe */
function mediaCovers(mediaRe, selRe, declRe) {
  const hits = [];
  for (const m of MEDIAS) {
    if (!mediaRe.test(m.head)) continue;
    for (const r of innerOf(m)) {
      if (!selRe.test(r.head)) continue;
      if (declRe.test(CSS_ALL.slice(r.at + 1, r.end))) hits.push({ cond: m.head, sel: r.head });
    }
  }
  return hits;
}
/** 全部媒体查询里，命中 selRe 的规则（不看属性） */
function mediaTouching(selRe) {
  const hits = [];
  for (const m of MEDIAS) for (const r of innerOf(m)) if (selRe.test(r.head)) hits.push({ cond: m.head, sel: r.head });
  return hits;
}
/** 在条件匹配 mediaRe 的媒体查询里，是否有 `:root`/`html` 规则重定义某个自定义属性。
 *  这是「窄屏走 token」这条**更好的实现路径**——必须认，否则门禁会逼人写死字面量。 */
function mediaRedefines(mediaRe, prop) {
  const hits = [];
  for (const m of MEDIAS) {
    if (!mediaRe.test(m.head)) continue;
    for (const r of innerOf(m)) {
      if (!/:root|^html\b/.test(r.head)) continue;
      if (new RegExp(`${prop.replace(/[-]/g, "\\-")}\\s*:`).test(CSS_ALL.slice(r.at + 1, r.end))) hits.push({ cond: m.head, sel: r.head, prop });
    }
  }
  return hits;
}
/** 声明里引用的第一个自定义属性名（`var(--space-2)` → `--space-2`） */
function firstVarIn(decl) {
  const m = /var\(\s*(--[\w-]+)/.exec(String(decl ?? ""));
  return m ? m[1] : null;
}
const NARROW_MEDIA = /max-width:\s*(3\d\d|40\d)px/;

/* ══════════════════════════════════════════════════════════════════════════
 * 带媒体上下文 + token 解析的**声明索引**（判5 的唯一取数来源）
 *
 * ── 为什么必须重写（这是会必然误报的结构问题）────────────────────────────
 *   旧的 `readTableDecls()` 用 `/\.tbl-x\s*\{…min-width…/` 取 **`SEG.text` 里第一个匹配**
 *   ⇒ 只读到**基础档（B 档）**的 `grid-template-columns` / `min-width`。
 *   而同一段里 gap / pad 走 `parseFloat(GUT.gapDecl)`：
 *   接线之后 `gapDecl` 是 `var(--space-1)`、`padLeftDecl` 是 `var(--sheet-gutter)`
 *   ⇒ `parseFloat` 得 **NaN** ⇒ 回退到实测 A 档值。
 *   **结论：Σmin 用 B 档、gap/pad 用 A 档，两边混档** ⇒ 落盘后五张表会全判赘肉 +28~+36。
 *   那是假红：两档各自都是零赘肉。
 *
 * ── 修法（判据语义一个字不改，只改"怎么读"）──────────────────────────────
 *   ① 声明索引：每条声明带 `{ selector, mediaCond, prop, value, at }`，`mediaCond` 空 = 基础档
 *   ② token 解析器：能跟 `var()` 链、支持 `var(--x, fallback)`、**按视口解析**
 *      （A 档把 `--sheet-gutter` 重定义成 `var(--space-2)` ⇒ 在该档解析为 8）
 *   ③ 按视口挑生效声明：同选择器里取「媒体条件匹配 v 且 `at` 最大」的那条
 *   ④ **解析失败一律进自检红（`CS-5b`），绝不回退参与计算** —— 回退正是混档的来源
 * ════════════════════════════════════════════════════════════════════════ */
/** 从任意 CSS 文本建声明索引（带媒体上下文）。**必须能从"改过的文本"重建** ——
 *  判5 是静态判据，它的变异测试必须落在 CSS 文本层，而不是运行时注入：
 *  运行时 `<style>` 不会改变 `bandSpec` 读的那份文本，用它做变异会得到"注入了但判据没反应"的假结论。 */
function indexOf(cssText) {
  const clean = cssText.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  const blocks = parseCssBlocks(clean);
  const medias = blocks.filter((b) => /^@media/.test(b.head));
  const idx = [];
  for (const b of blocks) {
    if (/^@/.test(b.head)) continue; /* @media / @property / @font-face 本身不是声明宿主 */
    const body = cssText.slice(b.at + 1, b.end);
    const props = {};
    /* ★ 结尾的 `;` 必须可选：真实样式表里"最后一条声明不写分号"很常见，
       只认 `;` 会把那些声明**静默吞掉**（第一版就这么读丢了注入的 min-width，
       表现为"gap 读到了、min-width 没读到"）。*/
    for (const m of body.matchAll(/([-\w]+)\s*:\s*([^;{}]+)(?:;|$)/g)) props[m[1]] = m[2].trim();
    let mediaCond = null;
    for (const mm of medias) if (b.at > mm.at && b.end < mm.end) { mediaCond = mm.head.replace(/\s+/g, " "); break; }
    idx.push({ selector: b.head.replace(/\s+/g, " "), at: b.at, mediaCond, props });
  }
  return idx;
}
let DECL_INDEX = indexOf(CSS_ALL);
/** 临时切到另一份 CSS 文本跑判据（同步，跑完必复原） */
function withEnv(cssText, fn) {
  const prev = DECL_INDEX;
  try { DECL_INDEX = indexOf(cssText); return fn(); } finally { DECL_INDEX = prev; }
}

/** 媒体条件匹配某视口宽。只支持 max-width / min-width（AND 语义）。
 *  `prefers-reduced-motion` / `prefers-color-scheme` 这类**与宽度无关**的块返回 false ——
 *  它们永远不会是"这一档生效的那一条"，跳过正好。 */
function mediaMatches(cond, v) {
  if (!cond) return true;
  const parts = [...cond.matchAll(/\((max|min)-width:\s*(\d+(?:\.\d+)?)px\)/g)];
  if (!parts.length) return false;
  return parts.every(([, k, n]) => (k === "max" ? v <= parseFloat(n) : v >= parseFloat(n)));
}

/** 某自定义属性在某视口下的**原始值**（取 `:root`/`html` 里媒体匹配且 `at` 最大的那条） */
function tokenRaw(name, v) {
  let best = null;
  for (const d of DECL_INDEX) {
    if (!/:root|^html\b/.test(d.selector)) continue;
    if (d.props[name] === undefined) continue;
    if (!mediaMatches(d.mediaCond, v)) continue;
    if (!best || d.at > best.at) best = d;
  }
  return best ? best.props[name] : null;
}
/** 长度解析：px / 纯数 / `var()` 链 / `var(--x, fallback)`。解析不出来返回 null（**不回退**）。 */
function resolveLen(raw, v, depth = 0) {
  if (raw == null || depth > 6) return null;
  const s = String(raw).trim();
  const vm = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(s);
  if (vm) {
    const t = tokenRaw(vm[1], v);
    if (t != null) { const r = resolveLen(t, v, depth + 1); if (r != null) return r; }
    if (vm[2]) return resolveLen(vm[2], v, depth + 1);
    return null;
  }
  const px = /^(-?[\d.]+)px$/.exec(s);
  if (px) return parseFloat(px[1]);
  const nu = /^(-?[\d.]+)$/.exec(s);
  if (nu) return parseFloat(nu[1]);
  return null; /* em/rem/% 等：表格这几条属性不用，宁可报错也不猜 */
}

/** 在某视口下取「匹配 selMatch 且声明了 prop 且媒体条件成立」的**最后一条** */
function effProp(selMatch, prop, v) {
  let best = null;
  for (const d of DECL_INDEX) {
    if (d.props[prop] === undefined) continue;
    if (!mediaMatches(d.mediaCond, v)) continue;
    if (!selMatch(d.selector)) continue;
    if (!best || d.at > best.at) best = d;
  }
  return best ? { raw: best.props[prop], selector: best.selector, mediaCond: best.mediaCond, at: best.at } : null;
}
/* 三个选择器匹配器。⚠️ `min-width` 挂在**容器选择器**（`.tbl-air4`）上，
   不在 `.xb-th` / `.xb-tr` 上 —— 取错对象会永远读不到。 */
const selIsContainer = (id) => (s) => s.split(",").some((x) => x.trim() === `.${id}`);
const selTracks = (id) => (s) => s.split(",").some((x) => x.includes(`.${id}`) && /\.xb-(th|tr)\b/.test(x));
const selGutter = () => (s) => /\.xb-(th|tr)\b/.test(s);

/** 某张表在某视口下的**该档生效值**（Σmin / min-width / gap / pad） */
function bandSpec(id, v) {
  const tk = effProp(selTracks(id), "grid-template-columns", v);
  const mw = effProp(selIsContainer(id), "min-width", v);
  const gl = effProp(selGutter(), "column-gap", v);
  const pl = effProp(selGutter(), "padding-left", v);
  const pr = effProp(selGutter(), "padding-right", v);
  const tracks = tk ? parseTracks(tk.raw) : null;
  const minWidth = mw ? resolveLen(mw.raw, v) : null;
  const gap = gl ? resolveLen(gl.raw, v) : null;
  const padL = pl ? resolveLen(pl.raw, v) : null;
  const padR = pr ? resolveLen(pr.raw, v) : null;
  const unresolved = [
    tracks ? null : "grid-template-columns",
    minWidth == null ? "min-width" : null,
    gap == null ? "column-gap" : null,
    padL == null ? "padding-left" : null,
    padR == null ? "padding-right" : null,
  ].filter(Boolean);
  return {
    tracks, minWidth, gap, padL, padR,
    pad: padL != null && padR != null ? padL + padR : null,
    sum: tracks ? tracks.reduce((a, b) => a + b, 0) : null,
    n: tracks ? tracks.length : null,
    unresolved,
    src: { tk, mw, gl, pl, pr },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 判2 的**被测对象是源码**，不是我的夹具
 *   动机：夹具是我写的，若断言比夹具文案，等于自证。必须读 `XbTable.tsx`。
 *
 *   ⚠️ 第一版用「解析 `heads: [...]` 数组」+「解析三元分支」，结果把
 *     `dir === "dep" ? "到达地" : "出发地"` 解析成 `dir === "dep" ? "到达地" : "出发地 …`
 *     这种残缺串（见上一轮 CS-2 输出）—— 数组解析对三元天生不友好。
 *   ⇒ 换成**字符串字面量集合**：把源码里的 `"…"` 字面量全收进 Set，
 *     判据问「A 档短名这个字面量在不在」。`"到达地"` 与 `"到达"` 在 Set 里是两个元素，
 *     不会互相冒充。
 *
 *   ⚠️ 只查「字符串在不在」是假绿：有人加两个孤儿字符串就能骗过。
 *   ⇒ 必须再查**切换机制**：源码或 CSS 里得有按视口切文案的东西
 *     （`matchMedia` / `useMediaQuery` / `data-tier` / `max-width: 40xpx`）。
 *     没有机制 = A 档根本不会出现短名 = 红。
 * ════════════════════════════════════════════════════════════════════════ */
function collectCopyFacts(src, segText) {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const lits = new Set([...noComments.matchAll(/"([^"\n]{1,12})"/g)].map((m) => m[1]));
  const switchInTs = /matchMedia|useMediaQuery|useBreakpoint|data-tier|xb-tier|innerWidth\s*[<>=]/.test(noComments);
  const switchInCss = /@media[^{]*max-width:\s*4\d\dp/.test(segText);
  return { lits, hasSwitch: switchInTs || switchInCss, switchInTs, switchInCss };
}
const XBTABLE_SRC = existsSync(join(ROOT, "src/components/cross-border/XbTable.tsx"))
  ? readFileSync(join(ROOT, "src/components/cross-border/XbTable.tsx"), "utf8")
  : "";
const COPY = collectCopyFacts(XBTABLE_SRC, SEG.text);

/* ══════════════════════════════════════════════════════════════════════════
 * 判2 第二层：**4 个全名键逐个校验**
 *   只检「"到达" 与 "出发" 两个短名串存在」是不够的 —— 那发现不了
 *   「只配了 dep 方向、arr 方向漏配」。真实的 4 个全名键（前端现场核出）：
 *     到达地→到达、出发地→出发、计划出发→出发、计划到达→到达
 *   arr 方向的 `出发地 / 计划到达` 在 `tbl-sea4` / `tbl-air4..5(dir=arr)` 里，
 *   漏配它**在 dep 页面上一模一样**，只能靠这条逐个键的断言抓。
 *
 *   ⚠️ 形状不写死到只有一种：认得下面三种常见写法，并在报告里打印"命中哪种"。
 *     ① `到达地: "到达"` / `"到达地": "到达"` / `'到达地': '到达'`
 *     ② `["到达地", "到达"]`
 *     ③ `{ full: "到达地", short: "到达" }`
 *   ⇒ 若落地用了第四种形状，这条会红并打印"映射表形状未识别"，那是**判据要跟着改**，
 *     不是产品错 —— 届时把形状告诉我或补进 pats。
 * ════════════════════════════════════════════════════════════════════════ */
const SHORT_MAP = [
  ["到达地", "到达"],
  ["出发地", "出发"],
  ["计划出发", "出发"],
  ["计划到达", "到达"],
];
function readShortMap(src) {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const found = {};
  const shapes = new Set();
  for (const [full, short] of SHORT_MAP) {
    const pats = [
      ["对象键值", new RegExp(`["']?${full}["']?\\s*:\\s*["']${short}["']`)],
      ["二元组", new RegExp(`\\[\\s*["']${full}["']\\s*,\\s*["']${short}["']\\s*\\]`)],
      ["full/short 字段", new RegExp(`full\\s*:\\s*["']${full}["'][\\s\\S]{0,80}?short\\s*:\\s*["']${short}["']`)],
    ];
    for (const [name, re] of pats) if (re.test(noComments)) { found[full] = short; shapes.add(name); break; }
  }
  return { found, shapes: [...shapes] };
}
const SHORTMAP = readShortMap(XBTABLE_SRC);

/** 判2 的**纯函数**形态 —— 好让变异测试能喂坏值进来，不必改 src */
function judgeHeaderCopy({ lits, hasSwitch }, tier) {
  const want = SPEC.headerCopy[tier];
  const otherTier = tier === "A" ? "B" : "A";
  const other = SPEC.headerCopy[otherTier];
  const has = lits.has(want.addr) && lits.has(want.depart);
  const hasOther = lits.has(other.addr) && lits.has(other.depart);
  return {
    ok: has && hasSwitch,
    detail: `本档要字面量「"${want.addr}"+"${want.depart}"」：${has ? "在 ✓" : "**缺**"}；` +
      `切换机制：${hasSwitch ? "有 ✓" : "**没有 ⇒ A 档不会出现短名**"}；` +
      `另一档（${otherTier}）字面量：${hasOther ? "在" : "不在"}`,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 判3 的**纯函数**形态（三态分级）
 *   ⚠️ 一致性只查**必真方向**：`min-width 撑破 ⇒ 一定滚`。
 *      反向（`滚了 ⇒ min-width 撑破`）**不成立**：`.xb-c` 是 `overflow:visible`+`nowrap`
 *      且 grid item `min-width:0`，单格文字能画到表格右缘之外 ⇒ 滚了但 min-width 没到。
 *      第一版写成双向 ⟺，恰好把这种**真实横滚**判成"脚本矛盾"（sea3 那 5 条）。
 *      ⇒ 反向差异改用 `cause` 归因（`min-width 撑破` / `单格溢出(列N)`），仍然是产品红，
 *        只是不许说成"脚本坏了"。
 * ════════════════════════════════════════════════════════════════════════ */
function classify({ sw, cw, minWidth, cellOver = [] }) {
  const scrollMeasured = sw > cw;                     /* ← 唯一"硬"观测量 */
  const margin = cw - minWidth;                       /* ← 只用于分级 */
  let state;
  if (scrollMeasured) state = "SCROLL";
  else if (margin === 0) state = "EDGE";
  else if (margin >= 1 && margin <= 2) state = "TIGHT";
  else if (margin >= 3) state = "OK";
  else state = "SCROLL";                              /* 算出来负但没实测到 ⇒ 仍需复核 */
  const consistent = margin < 0 ? scrollMeasured : true;
  const cause = !scrollMeasured
    ? null
    : margin < 0
      ? "min-width 撑破"
      : cellOver.length
        ? `单格溢出(列 ${cellOver.map((o) => `${o.c}「${o.t}」+${o.over}`).join("、")})`
        : "未归因";
  return { state, margin, scrollMeasured, consistent, cause, sw, cw };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 夹具 HTML —— 只有一个 `.xb-sheet`，一次一表（避免多表共用滚动容器互相干扰）
 * ════════════════════════════════════════════════════════════════════════ */
function buildFixture(tb) {
  const th = tb.cols.map((c) => `<span>${c}</span>`).join("");
  /* ★ 每格 class 必须**逐列还原** `XbTable.tsx` 的真实写法，否则量出来的全是别的字体：
       · 第 0 列（航班号/船名）→ `xb-c xb-c--num`（plate 等宽）
       · 状态列               → `xb-c xb-c--st`（12px，≤409px 降 11px —— 字号与其它列**不同**）
       · 登机口/闸口          → `xb-c xb-c--num xb-c--ctr`
       · 其余                 → `xb-c`
     ⚠️ 第一版所有格都给 `xb-c`：状态列于是按 13/11px 量，**少 1px 字号**，
        而 `.xb-c--st` 恰好是"最长串"那一列（`櫃檯 A10-A12 已開放` / `已啟航 預計到達 21:30`）
        ⇒ 状态列的字号与装得下判据全都测不到。 */
  const clsOf = (name, i) =>
    i === 0
      ? "xb-c xb-c--num"
      : name === "状态"
        ? "xb-c xb-c--st"
        : name === "闸口" || name === "登机口"
          ? "xb-c xb-c--num xb-c--ctr"
          : "xb-c";
  const rows = ROW_DATA[tb.id].map(
    (r) => `<div class="xb-tr">${r
      .map((c, i) => `<span class="${clsOf(tb.cols[i], i)}">${c}</span>`)
      .join("")}</div>`,
  ).join("\n      ");
  return `<div class="xb-sheet">
  <div class="xb-sheet__grab"><span class="xb-sheet__grip"></span></div>
  <div class="xb-sheet__hd"><h1 class="xb-sheet__h">跨境交通</h1><button class="xb-sheet__x" aria-label="关闭">×</button></div>
  <div class="xb-brd" role="tablist"><button class="xb-brd__t is-on">离澳</button><button class="xb-brd__t">抵澳</button></div>
  <div class="xb-sheet__body">
    <div class="xb-tbl ${tb.id}">
      <div class="xb-th">${th}</div>
      ${rows}
    </div>
  </div>
  <div class="xb-sheet__foot"><button class="xb-link">查看详细信息</button></div>
</div>`;
}

/** 页面侧取数：一次 evaluate 把 判1/3/4/5/6 要的全拿回来 */
const MEASURE = () => {
  const body = document.querySelector(".xb-sheet__body");
  const tbl = document.querySelector(".xb-tbl");
  const th = tbl.querySelector(".xb-th");
  const px = (v) => parseFloat(v) || 0;
  const r1 = (n) => Math.round(n * 10) / 10;
  const r2 = (n) => Math.round(n * 100) / 100;

  /* G2 防线：表头字号量的是 **每个 span**，不是 `.xb-th` 容器 */
  const thSpans = [...th.querySelectorAll("span")];
  const thFonts = thSpans.map((s) => px(getComputedStyle(s).fontSize));
  const thTexts = thSpans.map((s) => s.textContent.trim());
  const thLetter = thSpans.length ? getComputedStyle(thSpans[0]).letterSpacing : null;

  const cs = getComputedStyle(th);
  /* 解析后的轨道（含 1fr 填充值）—— **只用于报"实得列宽"，绝不用于算 need** */
  const resolved = cs.gridTemplateColumns.split(/\s+/).map(px);

  /* 每列每行的文字**单行渲染宽**（现场量，不写死）
     ＋ 逐格「文字有没有画到自己格子外」：
       `.xb-c` 是 `overflow:visible` + `white-space:nowrap`，且 grid item 的 `min-width:0`
       ⇒ 文字比本列宽时**不会**撑宽格子、也**不会**改变行的 `scrollWidth`（G3 失真），
         但**最后一列**的溢出会顶出表格右缘 ⇒ 真的横滚。
       所以：`cell.scrollWidth > cell.clientWidth` = 该格文字超宽，用来给横滚**归因**，
       不单独判红（判4/4b 才是"装得下"的正面判据）。 */
  const textW = [];
  const overCol = [];
  for (let c = 0; c < resolved.length; c++) {
    let mx = 0;
    for (const row of [...tbl.querySelectorAll(".xb-tr")]) {
      const cell = row.children[c];
      if (!cell) continue;
      const ccs = getComputedStyle(cell);
      const probe = document.createElement("span");
      probe.textContent = cell.textContent.trim();
      probe.style.cssText =
        "position:absolute;left:-99999px;top:0;white-space:nowrap;visibility:hidden;" +
        `font-family:${ccs.fontFamily};font-size:${ccs.fontSize};font-weight:${ccs.fontWeight};` +
        `letter-spacing:${ccs.letterSpacing};font-feature-settings:${ccs.fontFeatureSettings};`;
      document.body.appendChild(probe);
      const w = probe.getBoundingClientRect().width;
      probe.remove();
      if (w > mx) mx = w;
      const ov = r2(cell.scrollWidth - cell.clientWidth);
      if (ov > 0.5 && (!overCol[c] || ov > overCol[c].over)) {
        overCol[c] = { c, over: ov, t: cell.textContent.trim().slice(0, 12) };
      }
    }
    textW.push(r2(mx));
  }

  return {
    /* G1 防线：sw/cw 取自 `.xb-sheet__body`，**不是** documentElement */
    bodySW: body.scrollWidth,
    bodyCW: body.clientWidth,
    /* ★ 样式是否真的生效（防「CSS 被 HTML 解析器截断」那类假绿，见 render() 注释） */
    cssRules: [...document.styleSheets].reduce((a, s) => { try { return a + s.cssRules.length; } catch { return a; } }, 0),
    sheetDisplay: getComputedStyle(document.querySelector(".xb-sheet")).display,
    bodyPadL: px(getComputedStyle(body).paddingLeft),
    bodyPadR: px(getComputedStyle(body).paddingRight),
    bodyGap: getComputedStyle(body).columnGap,
    tblW: r1(tbl.getBoundingClientRect().width),
    tblMinW: px(getComputedStyle(tbl).minWidth) || 0,
    resolvedTracks: resolved.map(r1),
    gap: px(cs.columnGap),
    padL: px(cs.paddingLeft),
    padR: px(cs.paddingRight),
    bodyFont: px(getComputedStyle(tbl.querySelector(".xb-tr .xb-c") || th).fontSize),
  /* 状态列字号**与其它列不同**（`.xb-c--st` 基础 12px / ≤409px 11px）。
     只量 `.xb-c` 会漏掉这一档，而它恰好是最长串那一列。 */
  statusFont: (() => {
    const el = tbl.querySelector(".xb-tr .xb-c--st");
    return el ? px(getComputedStyle(el).fontSize) : null;
  })(),
    thFonts, thTexts, thLetter,
    textW,
    cellOver: overCol.filter(Boolean),
    /* 判6：内距是否真的由 token 驱动 —— 后面靠改 token 再量一次证明 */
    sheetPadChain: [".xb-th", ".xb-tr", ".xb-src", ".xb-note", ".xb-stale", ".xb-link", ".xb-brd"]
      .map((sel) => {
        const el = document.querySelector(sel);
        return el ? { sel, padL: px(getComputedStyle(el).paddingLeft) } : { sel, padL: null };
      }),
  };
};

/* ══════════════════════════════════════════════════════════════════════════
 * 断言账本：脚本自检 与 产品断言 **分开计数**
 *   （上一版把两者混在一个计数器里，`FAIL 2` 被读成"脚本坏了"）
 * ════════════════════════════════════════════════════════════════════════ */
let passN = 0, failN = 0;         /* 脚本自检 */
let prodPass = 0, prodFail = 0;   /* 产品断言 */
const REDS = [];
function check(tag, cond, detail) {
  if (cond) { passN++; console.log(`  ✅ ${tag} ${detail}`); }
  else { failN++; console.log(`  ❌ ${tag} ${detail}`); REDS.push(`[自检] ${tag} ${detail}`); }
}
function prodCheck(tag, cond, detail) {
  if (cond) { prodPass++; console.log(`  ✅ ${tag} ${detail}`); }
  else { prodFail++; console.log(`  ❌ ${tag} ${detail}`); REDS.push(`[产品] ${tag} ${detail}`); }
}

const playwright = resolvePlaywright();
if (!playwright.mod) {
  skip("找不到 playwright-core", [
    `已试：${(playwright.tried ?? []).join("、")}`,
    "启用方式（任选一）：",
    "  · npm i -D playwright-core（并确保有 Chrome）",
    "  · 设 PLAYWRIGHT_CORE_DIR=<playwright-core 目录绝对路径>",
  ]);
}
const chrome = resolveChrome();
if (!chrome) skip("找不到 Chrome/Chromium", ["设 CHROME_PATH=<chrome 绝对路径>"]);
const { chromium } = playwright.mod;

console.log(`[ENV] Chrome = ${chrome}`);
/* 行号一律不打印：这个文件在协作中被多次合法写入（含 +9 行/+7 行那种），行号会漂。
   判据一律按「选择器 + 属性名」或「注释原文片段」定位。 */
console.log(`[ENV] globals.css 的 \`.xb-\` 段：从「第 1 条 \`.xb-\` 规则上方最近的独立注释/规则边界」到「最后一条 \`.xb-\` 规则后 5 行」，含 \`.xb-\` 规则 **${SEG.nSlice}** 条`);

/* ── CS-0：切片完整性自证（判据能不能信，先看切片全不全）───────────────── */
console.log(`\n【脚本自检】`);
check("CS-0a", SEG.nSlice === SEG.nFile,
  `切片含 \`.xb-\` 规则 ${SEG.nSlice} 条 / 全文件 ${SEG.nFile} 条${SEG.nSlice === SEG.nFile ? "（一条不少）" : " ⇒ 切片不完整，后面读到的一切都不可信"}`);
check("CS-0b", SEG.startDepth === 0,
  `切片起点的括号深度 = ${SEG.startDepth}${SEG.startDepth === 0 ? "（切在规则边界上，不会解析错位）" : " ⇒ 切进了规则体，浏览器会做错误恢复解析"}`);

/* ── CS-9：本脚本自己不许出现 `globals.css` 的任何行号（硬要求）
   该文件在协作中被多次合法写入（+7 行 / +9 行），行号随时漂；
   判据里写死行号 = 下一次漂移后判据静默指向错误规则。⇒ 拿自己的源码自证。 */
{
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  /* 只在「同一行同时出现 globals.css」的上下文里找行号，且必须紧邻冒号 ——
     否则会把 `12:46:50` 这种时间戳误判成行号（第一版就是这么误报的）。 */
  const hardRefs = self
    .split("\n")
    .filter((l) => /globals\.css/.test(l))
    .filter((l) => /globals\.css[`'"\s]*:\s*\d{2,}/.test(l) || /\bL\d{3,}\b/.test(l));
  check("CS-9", hardRefs.length === 0,
    hardRefs.length === 0
      ? `本脚本源码里**没有任何 \`globals.css\` 行号引用**（全部按选择器/属性名/注释片段定位）`
      : `发现 ${hardRefs.length} 处行号引用：${hardRefs.map((l) => l.trim().slice(0, 60)).join(" / ")} ⇒ **必须改成锚文本**`);
}

/* ── CS-0c：五张表的轨道与 min-width 都读到了（读不到就不许往下走）──────── */
{
  const miss = TABLES.filter((t) => !DECLS[t.id]?.tracks || DECLS[t.id]?.minWidth == null);
  check("CS-0c", miss.length === 0,
    miss.length === 0
      ? `五张表轨道 + min-width 全部按锚文本读到：${TABLES.map((t) => `${t.id}[${DECLS[t.id].tracks.join(",")}]/${DECLS[t.id].minWidth}`).join("  ")}`
      : `读不到：${miss.map((m) => m.id).join("、")} ⇒ 锚文本改了，脚本要跟着改（不是产品缺陷）`);
}

const baseCss = cssLines.slice(0, SEG.from).join("\n");   /* token + 基础样式 */
const segCss = SEG.text;

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 320, height: 900 }, deviceScaleFactor: 1 });

async function render(tb, w, extraCss = "") {
  await page.setViewportSize({ width: w, height: 900 });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>`);
  /* ★★ 必须用 `textContent` 注入，**不能**把 CSS 拼进 `<style>…</style>` 的 HTML 字符串。
     实测踩过：`.nav-map__canvas` 规则上方那个注释块里有一句
       「高德 2.0 初始化时会**运行时注入** `<style>.amap-container{position:relative}</style>`」
     —— 里面是**字面量** `</style>`。HTML 解析器不懂 CSS 注释，见到 `</style>` 就闭合 style 元素，
     于是 globals.css 从那里（第 ~2500 行）起**全部失效**：`document.styleSheets[0].cssRules`
     只剩 239 条（真值 1399 条），`.xb-sheet` 退化成 `display:block`、所有盒子量出来都是 0。
     表现是「每张表 cw=0、sw=0」，会被误读成"没滚动"。
     ⇒ 用 `el.textContent = css`（不经 HTML 解析，`</style>` 只是普通字符）。
     ⇒ 并加 CS-0d 断言：页面里真实生效的规则数必须 ≥ 切片行数的一半，否则**取数不可信**。 */
  await page.evaluate(
    ({ base, seg, extra, html }) => {
      document.head.innerHTML = "";
      for (const css of [base, seg, extra]) {
        if (!css) continue;
        const s = document.createElement("style");
        s.textContent = css;
        document.head.appendChild(s);
      }
      document.body.innerHTML = html;
    },
    { base: baseCss, seg: segCss, extra: extraCss, html: buildFixture(tb) },
  );
  return page.evaluate(MEASURE);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 主循环：4 个视口 × 5 张表，逐格取数
 * ════════════════════════════════════════════════════════════════════════ */
const DATA = {};
for (const vp of VIEWPORTS) {
  DATA[vp.w] = {};
  for (const tb of TABLES) DATA[vp.w][tb.id] = await render(tb, vp.w);
}

/* ── CS-0d：样式真的注进去了（防 `</style>` 截断那一类假绿）────────────── */
{
  const d = DATA[320]["tbl-sea3"];
  const ruleCount = d.cssRules;
  const okRules = ruleCount > 800;
  check("CS-0d", okRules && d.sheetDisplay === "flex" && d.bodyCW > 0,
    `页面里生效的 CSS 规则 ${ruleCount} 条（globals.css 真值约 1399）、\`.xb-sheet\` display=${d.sheetDisplay}、body.cw=${d.bodyCW}` +
    `${okRules ? " ⇒ 样式完整生效" : " ⇒ **样式被截断了，所有读数为 0，不可信**（见 render() 里 `</style>` 那段注释）"}`);
}

/* ── CS-11 / CS-12：**锚点有效性** + **取数完整性**（两条都是"防空跑"）───────
   背景（fe-takeover 在真实产物上实测）：`.xb-sheet__body` 是**纯滚动容器** ——
   `padding-left/right = 0px`、`column-gap = normal`；真正承载 gutter/gap 的是子元素
   `.xb-th` / `.xb-tr`。代码里**没有 `.xb-td`**，数据格是 `.xb-c`、状态格是 `.xb-c--st`。

   ⇒ CS-11 钉死"我的锚点锚对了"：容器必须**不**承载 gutter（padding 0 / gap normal），
     且 `.xb-th` 的左右内距必须 **> 0**。这一条不是为了验产品，是为了验**我自己瞄的靶**：
     哪天有人把 gutter 挪到 body 上，CS-11 立刻红，提醒"锚点要跟着改"。
   ⇒ CS-12 钉死"读到的是数不是 undefined"：`undefined + 0.01 < x` 恒为 false，
     `Math.abs(undefined - want) > 0.6` 恒为 false —— 也就是说
     **querySelector 打错类名 / 夹具缺列 / 样式被截断，都会静默变成绿**。
     这类"空跑"是假绿最隐蔽的来源，所以一次性扫全部读数，非有限数即判自检红。 */
{
  const d = DATA[320]["tbl-sea3"];
  check("CS-11", d.bodyPadL === 0 && d.bodyPadR === 0 && d.bodyGap === "normal" && d.padL > 0 && d.padR > 0,
    `锚点有效性：\`.xb-sheet__body\` padding=${d.bodyPadL}/${d.bodyPadR}px、column-gap=${d.bodyGap}（应为 0/0/normal，它是纯滚动容器）；` +
    `承载 gutter 的 \`.xb-th\` padding=${d.padL}/${d.padR}px（应 > 0）⇒ ` +
    (d.bodyPadL === 0 && d.bodyPadR === 0 && d.bodyGap === "normal" && d.padL > 0 && d.padR > 0
      ? `**gutter/gap 确实挂在 \`.xb-th/.xb-tr\` 上**，量对对象了`
      : `**锚点漂了**：gutter/gap 不在本脚本假设的元素上，所有读 \`gap/pad\` 的断言都要重新对靶（不是产品问题）`));

  const fin = (x) => typeof x === "number" && Number.isFinite(x);
  const bad = [];
  for (const [w, tables] of Object.entries(DATA)) {
    for (const [id, d2] of Object.entries(tables)) {
      for (const k of ["bodySW", "bodyCW", "tblMinW", "gap", "padL", "padR", "bodyFont"]) {
        if (!fin(d2[k])) bad.push(`${w}/${id}.${k}=${d2[k]}`);
      }
      if (!Array.isArray(d2.textW) || !d2.textW.length || !d2.textW.every(fin)) bad.push(`${w}/${id}.textW`);
      if (!Array.isArray(d2.resolvedTracks) || !d2.resolvedTracks.length || !d2.resolvedTracks.every(fin)) bad.push(`${w}/${id}.resolvedTracks`);
      if (!Array.isArray(d2.thFonts) || !d2.thFonts.length || !d2.thFonts.every(fin)) bad.push(`${w}/${id}.thFonts`);
      if (d2.statusFont != null && !fin(d2.statusFont)) bad.push(`${w}/${id}.statusFont`);
      for (const o of d2.cellOver ?? []) if (!fin(o.over)) bad.push(`${w}/${id}.cellOver[${o.c}]`);
    }
  }
  check("CS-12", bad.length === 0,
    bad.length === 0
      ? `${Object.keys(DATA).length} 视口 × ${TABLES.length} 表的全部读数都是**有限数**（无 undefined / NaN / 空数组）⇒ 断言不会因为"查不到元素"而静默变绿`
      : `非有限读数 ${bad.length} 处：${bad.slice(0, 8).join("、")} ⇒ **空跑风险**：\`undefined\` 参与比较恒 false 会伪装成 PASS，先修夹具/类名/注入`);
}

/* ── 判1：表头字号（两档都断）──────────────────────────────────────────── */
console.log(`\n【判1】表头字号 —— A 档 ${SPEC.headerFont.A}px / B 档 ${SPEC.headerFont.B}px（出处：05 稿 L1905/L1912）`);
for (const vp of VIEWPORTS) {
  const want = SPEC.headerFont[vp.tier];
  const rows = TABLES.map((tb) => {
    const d = DATA[vp.w][tb.id];
    const uniq = [...new Set(d.thFonts)];
    return { id: tb.id, ok: uniq.length === 1 && Math.abs(uniq[0] - want) <= 0.1, got: uniq.join("/") };
  });
  const bad = rows.filter((r) => !r.ok);
  prodCheck(`F1-${vp.w}`,
    bad.length === 0,
    `${vp.w}px(${vp.tier} 档) 期望 ${want}px：` +
    (bad.length === 0
      ? `五张表全部 ${want}px ✓`
      : `${bad.map((b) => `${b.id}=${b.got}px`).join("、")} ⇒ **不符**`) +
    `（量的是 \`.xb-th\` 里每个 \`span\`，见 G2 防线；字距实测 ${DATA[vp.w]["tbl-sea3"].thLetter}）`);
  /* 判1 附带：字距。**两档都要断**，且要能区分"实现取 0"和"实现取 .04em"。
     A 档 `.04em × 10px = 0.40px`；B 档保持 `.06em × 11px = 0.66px`。
     ⚠️ 05 稿 L1858 的内联片段写 `letter-spacing:0`，那是**稿子手误**（L1912 定量表给的是 .04em）
       ⇒ 权威值 .04em；实现若跟着手误取 0，必须红。 */
  {
    const ls = parseFloat(DATA[vp.w]["tbl-sea3"].thLetter);
    const wantLs = SPEC.headerTracking[vp.tier];
    const isZero = Math.abs(ls) <= 0.01;
    prodCheck(`F1ls-${vp.w}`, Math.abs(ls - wantLs) <= 0.06,
      `${vp.w}px(${vp.tier} 档) 字距期望 **${wantLs}px** 实测 ${ls}px ⇒ ` +
      (Math.abs(ls - wantLs) <= 0.06
        ? "符"
        : isZero
          ? `**判红：实现取了 0 —— 那是 05 稿 L1858 内联片段的手误，权威值是 L1912 的 .04em**`
          : `**不符（现值 .06em × ${DATA[vp.w]["tbl-sea3"].thFonts[0]}px）**`));
  }
}

/* ── 判1st：状态列字号（`.xb-c--st`，与其它列**不同**，且 401–409 必须显式覆盖）── */
console.log(`\n【判1st】状态列字号 —— \`.xb-c--st\` A 档 ${SPEC.statusFont.A}px / B 档 ${SPEC.statusFont.B}px`);
for (const vp of VIEWPORTS) {
  const want = SPEC.statusFont[vp.tier];
  const rows = TABLES.filter((t) => t.cols.includes("状态"))
    .map((tb) => ({ id: tb.id, got: DATA[vp.w][tb.id].statusFont }));
  const bad = rows.filter((r) => r.got == null || Math.abs(r.got - want) > 0.1);
  prodCheck(`F1st-${vp.w}`, bad.length === 0 && rows.length > 0,
    `${vp.w}px(${vp.tier} 档) 期望 ${want}px：` +
    (bad.length === 0
      ? `四张带状态列的表全部 ${want}px ✓`
      : `${bad.map((b) => `${b.id}=${b.got}px`).join("、")} ⇒ **不符**` +
        (vp.tier === "A" ? `（401–409 漏档通常就体现在这里：只覆盖到 400 会让这一段停在 12px）` : "")));
}

/* ── 判2：表头文案（读源码，不读夹具）────────────────────────────────── */
console.log(`\n【判2】表头文案 —— A 档短名 / B 档全名（读 \`XbTable.tsx\` 的字面量 + 查切换机制）`);
{
  check("CS-2", COPY.lits.size > 20,
    `从 \`XbTable.tsx\` 收到 ${COPY.lits.size} 个字符串字面量（含「${[...COPY.lits].filter((s) => /[^\x00-\x7F]/.test(s)).slice(0, 12).join(" ")}」…）` +
    `${COPY.lits.size > 20 ? "" : " ⇒ 解析失败，判2 不可信"}`);
  console.log(`  切换机制：TS 侧 ${COPY.switchInTs ? "有" : "无"} / CSS 侧 ${COPY.switchInCss ? "有" : "无"} ⇒ 综合 ${COPY.hasSwitch ? "**有**" : "**无**"}`);
  for (const tier of ["A", "B"]) {
    const r = judgeHeaderCopy(COPY, tier);
    prodCheck(`F2-${tier}`, r.ok, `${tier} 档：${r.detail}`);
  }
  /* 第二层：4 个全名键逐个校验（专抓"只配 dep、arr 漏配"） */
  const missing = SHORT_MAP.map(([f]) => f).filter((f) => !(f in SHORTMAP.found));
  prodCheck("F2-4keys", missing.length === 0,
    SHORT_MAP.map(([f, s]) => `${f}→${s}${f in SHORTMAP.found ? " ✓" : " **缺**"}`).join(" ｜ ") +
    (missing.length === 0
      ? ` ⇒ 4 个键全覆盖（含 arr 方向的「出发地/计划到达」）`
      : ` ⇒ **缺 ${missing.length} 个键**（arr 方向漏配在 dep 页面看不出来，只有这条能抓）` +
        (SHORTMAP.shapes.length ? `；已识别的映射写法：${SHORTMAP.shapes.join("/")}` : `；**映射表形状未识别**（见 SHORT_MAP 注释里的三种写法）`)));
}

/* ── 判3：横滚三态（四个视口逐表）──────────────────────────────────────── */
console.log(`\n【判3】横滚三态 —— 量 \`.xb-sheet__body\` 的 sw/cw（G1 防线：不量 documentElement）`);
console.log(`| 视口 | 档 | 表 | sw | cw | min-width | margin | 状态 | 归因 | 必真方向自检 |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|`);
let stateAll = [];
let consistencyBad = [];
for (const vp of VIEWPORTS) {
  for (const tb of TABLES) {
    const d = DATA[vp.w][tb.id];
    const c = classify({ sw: d.bodySW, cw: d.bodyCW, minWidth: d.tblMinW, cellOver: d.cellOver });
    stateAll.push({ vp: vp.w, id: tb.id, cells: d.cellOver, ...c });
    if (!c.consistent) consistencyBad.push(`${vp.w}/${tb.id}(sw=${c.sw},cw=${c.cw},mw=${d.tblMinW})`);
    console.log(`| ${vp.w} | ${vp.tier} | ${tb.id} | ${d.bodySW} | ${d.bodyCW} | ${d.tblMinW} | ${c.margin} | **${c.state}** | ${c.cause ?? "—"} | ${c.consistent ? "✓" : "❌矛盾"} |`);
  }
}
check("CS-1", consistencyBad.length === 0,
  consistencyBad.length === 0
    ? `必真方向（\`min-width 撑破 ⇒ 实测一定滚\`）在全部 ${stateAll.length} 组里都成立 ⇒ 分级不是恒真；` +
      `反向差异（滚了但 min-width 没到）单列「归因」，不误报成脚本坏`
    : `矛盾 ${consistencyBad.length} 组：${consistencyBad.join("、")} ⇒ 算出来负却**实测没滚**，**是脚本的取数有问题**，不许当成产品绿`);
for (const vp of VIEWPORTS) {
  const rows = stateAll.filter((s) => s.vp === vp.w);
  const scrolled = rows.filter((s) => s.state === "SCROLL");
  prodCheck(`F3-${vp.w}`, scrolled.length === 0,
    scrolled.length === 0
      ? `五张表 ${rows.map((r) => `${r.id}=${r.state}(余${r.margin})`).join(" ")} ⇒ 全部不滚`
      : `**滚动**：${scrolled.map((s) => `${s.id}(sw=${s.sw}>cw=${s.cw}，${s.cause})`).join("、")}`);
}

/* ── 判4：船务公司列（A 66 / B 72，且 ≥ 现场实测最长文案宽）────────────── */
console.log(`\n【判4】船务公司列 —— A 档 ${SPEC.companyCol.A} / B 档 ${SPEC.companyCol.B}，且 ≥ 该列最长文案**现场渲染宽**`);
for (const vp of VIEWPORTS) {
  const want = SPEC.companyCol[vp.tier];
  const rows = TABLES.filter((t) => t.opCol >= 0).map((tb) => {
    const d = DATA[vp.w][tb.id];
    const got = d.resolvedTracks[tb.opCol];
    const longest = d.textW[tb.opCol];
    return { id: tb.id, got, longest, ok: Math.abs(got - want) <= 0.6 && got + 0.01 >= longest };
  });
  const badW = rows.filter((r) => Math.abs(r.got - want) > 0.6);
  const badF = rows.filter((r) => r.got + 0.01 < r.longest);
  prodCheck(`F4w-${vp.w}`, badW.length === 0,
    `${vp.w}px(${vp.tier} 档) 期望 ${want}px：` +
    (badW.length === 0 ? `三张船表全部 ${want}px ✓` : badW.map((b) => `${b.id}=${b.got}px`).join("、") + " ⇒ **列宽不符**"));
  prodCheck(`F4f-${vp.w}`, badF.length === 0,
    `「装得下」判据（列宽 ≥ 最长文案渲染宽，文案现场量不用 65 这个字面）：` +
    (badF.length === 0
      ? rows.map((r) => `${r.id} ${r.got}≥${r.longest}`).join(" ")
      : badF.map((b) => `${b.id} 列宽 ${b.got} < 文案 ${b.longest}（缺 ${(b.longest - b.got).toFixed(2)}px）`).join("、") + " ⇒ **压字/侵入隔壁**"));
}
/* ★ 口径断言（A 档 56 必须是在 **11px** 口径下够用）──────────────────────
   `资料未公开` 13px = 65.00 / 11px = 55.00 —— 差 10px **全是字号口径差**。
   若轨道按 A 档读、文案却按 13px 量，56 一定「装不下」⇒ 逼人把列宽改回 66（已作废）。
   ⇒ 直接把「该档表体字号」钉住：A=11 / B=13，混档当场暴露。 */
for (const tier of ["A", "B"]) {
  const want = SPEC.bodyFont[tier];
  const ws = VIEWPORTS.filter((v) => v.tier === tier);
  const badFont = [];
  for (const vp of ws) for (const tb of TABLES) {
    const f = DATA[vp.w][tb.id].bodyFont;
    if (Math.abs(f - want) > 0.1) badFont.push(`${vp.w}/${tb.id}=${f}px`);
  }
  prodCheck(`F4-font-${tier}`, badFont.length === 0,
    `${tier} 档表体字号（判4「装得下」的测量口径）应为 **${want}px**，横跨 ${ws.length} 视口 × ${TABLES.length} 表：` +
    (badFont.length === 0
      ? `全部 ${want}px ✓ ⇒ 列宽与文案同口径`
      : `${badFont.join("、")} ⇒ **混档**（轨道按该档读、文案却按另一档字号量，56 会被误判成装不下）`));
}

/* ── 判4b：第 0 列（船名 / 航班号）装得下 —— 它走 plate 等宽字体，不是正文字体 ──
   frontend 实测：`迅隆 11 號` 13px = 71.50 / 11px = 57.97（按 body 字体量是 50.14，**作废**）。
   差 7.8px ⇒ 任何按「正文字体 50」推出来的 56px 窄档都会压字。
   本判据的文案宽是**现场量**（探针复制该格的 computed font-family，含 `--plate-font`）。 */
console.log(`\n【判4b】第 0 列装得下（船名/航班号走 plate 等宽字体，不是正文字体）`);
const F4B = [];
for (const vp of VIEWPORTS) {
  const rows = TABLES.map((tb) => {
    const d = DATA[vp.w][tb.id];
    /* ★ 第 0 列是 `minmax(72px,1fr)` ⇒ `resolvedTracks[0]` 是**被 1fr 撑满后的填充值**
       （G5 陷阱：拿填充值判"装得下"必然恒绿）。这里只认**声明侧下限**。
       ★★ 下限必须**按该视口取该档**：A 档是 `minmax(59px,1fr)`、B 档是 `minmax(72px,1fr)`。
       拿 B 档的 72 去判 A 档 = 混档（会让 A 档永远绿，掩盖 59 是否够用）。 */
    const sp = bandSpec(tb.id, vp.w);
    const floor = sp.tracks?.[0];
    const from = sp.src.tk?.mediaCond ? sp.src.tk.mediaCond : "基础档";
    return { id: tb.id, floor, filled: d.resolvedTracks[0], need: d.textW[0], font: d.bodyFont, from, band: vp.tier, vp: vp.w };
  });
  F4B.push(...rows);
  const bad0 = rows.filter((r) => r.floor + 0.01 < r.need);
  prodCheck(`F4b-${vp.w}`, bad0.length === 0,
    `${vp.w}px(${vp.tier} 档，轨道来自 \`${rows[0].from}\`) 第 0 列**轨道下限** vs 现场实测文本宽（${rows[0].font}px 口径）：` +
    (bad0.length === 0
      ? rows.map((r) => `${r.id} 下限${r.floor}≥${r.need}（实得${r.filled}）`).join(" ")
      : bad0.map((b) => `${b.id} 下限 ${b.floor} < 文本 ${b.need}（缺 ${(b.need - b.floor).toFixed(2)}px）`).join("、") + " ⇒ **压字**"));
}
/* 两档**各判一次**（A 档下限 59 / B 档下限 72，不是同一个数） */
for (const tier of ["A", "B"]) {
  const rows = F4B.filter((r) => r.band === tier);
  const floors = [...new Set(rows.map((r) => r.floor))].sort((a, b) => a - b);
  const bad = rows.filter((r) => r.floor + 0.01 < r.need);
  prodCheck(`F4b-tier-${tier}`, bad.length === 0 && rows.length > 0,
    `${tier} 档（${[...new Set(rows.map((r) => r.vp))].join("/")}px）第 0 列声明下限 = ${floors.join("~")}px，` +
    `该档实测文本宽 ${Math.min(...rows.map((r) => r.need))}~${Math.max(...rows.map((r) => r.need))}px（${rows[0].font}px 口径）⇒ ` +
    (bad.length === 0 ? `装得下` : `**压字**：${bad.map((b) => `${b.id}@${b.vp}`).join("、")}`));
}

/* ── 判4c（条件性）：跨日班次的 `MM-DD HH:MM` 会不会压字 ──────────────────
   `xb-view.ts` 的 `displaySched` 跨日返回 `` `${schedDate.slice(5)} ${schedTime}` ``（如 `12-31 07:30`）。
   frontend 实测：plate 13px = 80.06 / 11px = 67.75，而「计划出发/到达」轨只有 50（B 档）/ 43（A 档）。
   ⚠️ **这是条件性缺陷**：只能证明「一旦上游给出跨日行就压字」，不能证明"现在就会出现"。
   所以单列一类 `COND`，**不计入 exit code**，但也**不吞**（红线：禁「算了不判」）。 */
console.log(`\n【判4c·条件性】跨日班次的「MM-DD HH:MM」是否压字（触发条件：最近五班跨午夜）`);
let condWarn = 0;
for (const vp of VIEWPORTS) {
  await render(TABLES[2], vp.w); /* 现场重渲染，确保量的是本视口下的 `.xb-c--num` */
  const w = await page.evaluate(
    ({ tblSel, col, text }) => {
      /* ★ 必须取**第 4 格（计划出发）本体**去复制 computed font：
         它是 `.xb-c`（正文字体），不是 `.xb-c--num`（plate 等宽）。第一版取的是 `.xb-c--num`
         ⇒ 拿船名的 plate 字体量「计划出发」的文案，宽度虚高 20px（80.06 vs 实际约 57）。 */
      const row = document.querySelector(`${tblSel} .xb-tr`);
      const cell = row ? row.children[col] : null;
      if (!cell) return null;
      const cs = getComputedStyle(cell);
      const p = document.createElement("span");
      p.textContent = text;
      p.style.cssText =
        "position:absolute;left:-99999px;top:0;white-space:nowrap;visibility:hidden;" +
        `font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};` +
        `letter-spacing:${cs.letterSpacing};font-feature-settings:${cs.fontFeatureSettings};`;
      document.body.appendChild(p);
      const wd = p.getBoundingClientRect().width;
      p.remove();
      return { w: Math.round(wd * 100) / 100, font: cs.fontSize };
    },
    { tblSel: ".tbl-sea3", col: 3, text: "12-31 07:30" },
  );
  const track = bandSpec("tbl-sea3", vp.w).tracks?.[3]; /* 第 4 列 = 计划出发（按该视口取档） */
  const over = (w?.w ?? 0) - track;
  if (over > 0.01) condWarn++;
  console.log(`  ${over > 0.01 ? "⚠️ COND" : "OK"} ${vp.w}px：「12-31 07:30」实测 ${w?.w}px（${w?.font} 正文字体）vs 第 4 列轨 ${track}px ⇒ ${over > 0.01 ? `**压字 ${over.toFixed(2)}px**` : `装得下（余 ${(-over).toFixed(2)}px）`}`);
}
console.log(`  ⇒ 条件性告警 ${condWarn}/${VIEWPORTS.length} 档。**不计入 exit code**，但要进报告：一旦上游在跨午夜时段返回跨日行，这一列立刻压字。轨要不要放宽是产品口径，不是脚本能定的。`);

/* ══════════════════════════════════════════════════════════════════════════
 * 判5 的前置实证：窄屏覆盖到底缺不缺（只读，枚举全部 @media）
 *   这一节不是"顺便看看"，它是判5 报红的**前提**：
 *   若真有媒体查询把 gap 改成 4、内距改成 8，那 320 下的 need 就该按 4/8 算，
 *   判5 的红绿结论会完全不同。所以必须先证明"一条覆盖都没有"。
 * ════════════════════════════════════════════════════════════════════════ */
console.log(`\n【判5 前置】@media 全量清点（嵌套感知括号配平，按选择器判定，不按行号)`);
{
  check("CS-5a", MEDIAS.length > 0,
    `全文件真块 ${CSS_BLOCKS.length} 个，其中 \`@media\` **${MEDIAS.length}** 个 ⇒ 清点覆盖到全部`);
  /* 逐条：条件 + 块内首选择器 + 是否触及表格 */
  console.log(`| # | 条件 | 块内首条选择器 | 触及表格的选择器 |`);
  console.log(`|---|---|---|---|`);
  MEDIAS.forEach((m, i) => {
    const inner = innerOf(m);
    const first = (inner[0]?.head ?? "(无内层规则)").replace(/\s+/g, " ").slice(0, 44);
    const touches = inner.filter((b) => TABLE_SEL.test(b.head)).map((b) => b.head.replace(/\s+/g, " "));
    console.log(`| ${i + 1} | ${m.head.replace(/\s+/g, " ")} | ${first} | ${touches.length ? touches.join(" / ").slice(0, 64) : "—"} |`);
  });
  const touchTbl = mediaTouching(TABLE_SEL);
  console.log(`\n  触及表格的 @media 规则共 **${touchTbl.length}** 条：${touchTbl.length ? touchTbl.map((t) => `${t.cond} → ${t.sel}`).join("；") : "无"}`);
  /* ★ 三问三答：这三条就是"窄屏覆盖缺不缺"的直接证据。
     注意两条**都允许"走 token"这条更好的路径**：
       直写 `padding:8px` 算覆盖；`@media{ :root{--sheet-gutter:8px} }` + `.xb-th{padding-left:var(--sheet-gutter)}`
       **也**算覆盖。否则门禁会逼着人把 8 写成字面量，反而和判6 打架。 */
  const padHits = mediaCovers(NARROW_MEDIA, /\.xb-th|\.xb-tr/, /padding-left\s*:|padding-right\s*:/);
  const padTokenName = firstVarIn(GUT.padLeftDecl) ?? "--sheet-gutter";
  const padViaToken = mediaRedefines(NARROW_MEDIA, padTokenName).length > 0
    && /var\(/.test(String(GUT.padLeftDecl) + String(GUT.padRightDecl));
  const gapHits = mediaCovers(NARROW_MEDIA, /\.xb-th|\.xb-tr/, /column-gap\s*:/);
  const gapTokenName = firstVarIn(GUT.gapDecl);
  const gapViaToken = gapTokenName !== null && mediaRedefines(NARROW_MEDIA, gapTokenName).length > 0
    && /\bvar\(/.test(String(GUT.gapDecl));
  prodCheck("F5-pre-gap", gapHits.length > 0 || gapViaToken,
    `\`≤409\` 让 gap 取到 ${SPEC.gap.A} 的路径：直写媒体查询 **${gapHits.length} 条**；` +
    `走 token（\`${gapTokenName ?? "无"}\` 在窄屏重定义）**${gapViaToken ? "有" : "无"}** ⇒ ` +
    (gapHits.length > 0 || gapViaToken
      ? `覆盖存在`
      : `**窄屏 gap 覆盖缺失**（320 档取不到 ${SPEC.gap.A}）` +
        (gapTokenName ? `；⚠️ 但别用「窄屏重定义 \`${gapTokenName}\`」这条路 —— 它是全局间距 token，改了会连带别的组件` : "")));
  prodCheck("F5-pre-pad", padHits.length > 0 || padViaToken,
    `\`≤409\` 让内距取到 ${SPEC.padSide.A}/侧 的路径：直写媒体查询 **${padHits.length} 条**；` +
    `走 token（\`${padTokenName}\` 在窄屏重定义 + 声明里确实 \`var()\` 引用）**${padViaToken ? "有" : "无"}** ⇒ ` +
    (padHits.length > 0 || padViaToken ? `覆盖存在` : `**窄屏内距覆盖缺失**（320 档取不到 ${SPEC.padSide.A}/侧）`));
  /* 状态列：401–409 漏档（frontend 点名）。判据 = 存在覆盖到 409 的 .xb-c--st 字号规则 */
  const stHits = mediaCovers(/max-width:\s*(4[01]\d)px/, /\.xb-c--st/, /font-size\s*:/);
  const stEnds = stHits.map((h) => parseInt(/max-width:\s*(\d+)px/.exec(h.cond)?.[1] ?? "0", 10));
  const covers409 = stEnds.some((v) => v >= 409);
  prodCheck("F5-pre-st", covers409,
    `\`.xb-c--st\` 字号的媒体查询断点：${stEnds.length ? stEnds.map((v) => `≤${v}px`).join("、") : "无"}` +
    `${covers409 ? " ⇒ 覆盖到 409" : " ⇒ **401–409 这一段漏档**（现网止于 400，那 9px 宽的状态列还是 12px）"}`);
  /* 现网解析值（实测，不是读声明）。⚠️ 这里的"有没有窄屏覆盖"必须**算**出来再说，
     不许写死 —— 落盘前是"无覆盖"，落盘后是"gap 直写 1 条 + 内距走 token 重定义"，
     同一句话在落盘前后是反的。（第一版把"无任何媒体查询覆盖"写死在字符串里，
     落盘后就成了假陈述。） */
  const d320 = DATA[320]["tbl-sea3"];
  const covNote = [
    `gap：${gapHits.length ? `直写媒体查询 ${gapHits.length} 条` : gapViaToken ? `窄屏重定义 \`${gapTokenName}\`` : "**无覆盖**"}`,
    `内距：${padHits.length ? `直写媒体查询 ${padHits.length} 条` : padViaToken ? `窄屏重定义 \`${padTokenName}\` + 声明 var() 引用` : "**无覆盖**"}`,
  ].join("；");
  console.log(`\n  ▸ 现网 320 视口**实测解析值**：\`column-gap = ${d320.gap}px\`、\`padding-left = ${d320.padL}px\`、\`padding-right = ${d320.padR}px\`` +
    `（声明侧：\`${GUT.gapDecl}\` / \`${GUT.padLeftDecl}\` / \`${GUT.padRightDecl}\`）\n    窄屏路径：${covNote}`);
}

/* ── 判5：min-width 无赘肉（**按视口取该档生效的那一条声明**）──────────
   判据本身没变：`min-width === Σmin + gap×(n−1) + padL + padR`，偏差必须为 0。
   变的是**读法**：Σmin / gap / pad / min-width **全部取自同一个视口下的同一档**，
   且 token 走 `var()` 链按视口解析（A 档 `--sheet-gutter → var(--space-2) → 8`）。
   ⇒ 不再有"Σmin 读 B 档、gap 读 A 档"的混档假红。
   两种红分开报：赘肉红（多出来的空白）/ 不够红（轨道被撑破，更严重）。 */
console.log(`\n【判5】min-width 无赘肉 —— 同一个视口下取同一档的 Σmin / gap / pad / min-width`);
const F5_VIEWS = [
  { v: 320, band: "A(min)" },
  { v: 409, band: "A(max)" },
  { v: 414, band: "B(min)" },
];
{
  /* ★ 先自证：声明解析不许出现未解析项（回退 = 混档的根源） */
  const unresolvedAll = [];
  for (const tb of TABLES) for (const { v } of F5_VIEWS) {
    const sp = bandSpec(tb.id, v);
    for (const u of sp.unresolved) unresolvedAll.push(`${tb.id}@${v}:${u}`);
  }
  check("CS-5b", unresolvedAll.length === 0,
    unresolvedAll.length === 0
      ? `Σmin / min-width / gap / pad 在 ${TABLES.length}×${F5_VIEWS.length} 组里**全部解析成功**（token 走 var() 链，无 NaN、无回退）`
      : `未解析：${unresolvedAll.join("、")} ⇒ **不许回退猜值**，先修解析器`);

  /* ══════════════════════════════════════════════════════════════════════
   * ★★ 判5 的**前置条件**：A 档必须真有一条「媒体块里的」声明
   *   为什么单列这条：Σmin 是**按档**的量，两档不可能相同
   *     air4  A 档 44+46+40+112 = **242**   /   B 档 48+56+50+112 = **266**
   *   若 A 档没声明，`bandSpec(id, 409)` 会按选择器继承退回**基础档**（B 档）的轨道
   *   ⇒ 拿 266 算 A 档 need（266+12+16=294），而正确答案是 242+12+16=**270** ⇒ 差 24px
   *   ⇒ 落盘后 min-width 是 270 就会被判「**不够红 −24**」—— 那是最容易被误读成
   *     「轨道要给回 294」的一类红，比赘肉红危险得多。
   *   ⇒ 缺声明时**只报「A 档未覆盖」，绝不拿 B 档 Σmin 硬算一个 A 档 need**。
   * ══════════════════════════════════════════════════════════════════════ */
  const A_VIEW = 409, B_VIEW = 414;
  const cov = TABLES.map((tb) => {
    const spA = bandSpec(tb.id, A_VIEW);
    return {
      id: tb.id,
      spA,
      tkFrom: spA.src.tk?.mediaCond ?? null,
      mwFrom: spA.src.mw?.mediaCond ?? null,
      ok: spA.src.tk?.mediaCond != null && spA.src.mw?.mediaCond != null,
    };
  });
  const missA = cov.filter((c) => !c.ok);
  const covA = cov.filter((c) => c.ok);

  /* ★ CS-10：A 档与 B 档的 `grid-template-columns` 必须**是两条不同的声明**。
     两者相同 ⇒ 说明我又只读到了基础档（同一个混档 bug 的第三次）⇒ 判**自检失败**，
     **不报产品红**（报产品红会把"脚本读错"当成"产品违规"，指错方向）。
     A 档声明不存在 ⇒ 本自检无可比对象：红在 `F5-Amiss-*` 里报，这里**显式说明**、不静默跳过。 */
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const sameTracks = covA.filter((c) => norm(c.spA.src.tk.raw) === norm(bandSpec(c.id, B_VIEW).src.tk?.raw));
  check("CS-10", sameTracks.length === 0,
    sameTracks.length > 0
      ? `${sameTracks.map((c) => c.id).join("、")} 的 A 档与 B 档 \`grid-template-columns\` **原文完全相同**（\`${norm(sameTracks[0].spA.src.tk.raw)}\`）⇒ **我又只读到了基础档**，自检失败 —— 先修读法，别报产品红`
      : missA.length > 0
        ? `${missA.length}/${TABLES.length} 张表**尚无 A 档声明**（${missA.map((c) => c.id).join("、")}）⇒ 无可比对象，本自检不作判定；那些红由 \`F5-Amiss-*\` 承担，**本判据不拿 B 档 Σmin 冒充 A 档**`
        : `${TABLES.length}/${TABLES.length} 张表：A 档(≤${A_VIEW}px) 与 B 档 的 \`grid-template-columns\` **逐表都不同** ⇒ 两档各自读了本档的声明`);

  /* ★ F5-Amiss：A 档覆盖的**存在性**（缺了就只报这一条，不再硬算 need） */
  for (const c of cov) {
    const spB = bandSpec(c.id, B_VIEW);
    prodCheck(`F5-Amiss-${c.id}`, c.ok,
      c.ok
        ? `A 档(≤${A_VIEW}px) 的 \`grid-template-columns\` 来自 \`${c.tkFrom}\`、\`min-width\` 来自 \`${c.mwFrom}\` ⇒ 该档有独立声明（Σmin ${c.spA.sum}）`
        : `**A 档未覆盖 · 缺 \`@media (max-width:409px)\` 声明**：` +
          `${c.tkFrom ? "" : "`grid-template-columns` "}${c.mwFrom ? "" : "`min-width` "}` +
          `在 ≤${A_VIEW}px 读到的仍是**基础档（B 档）**（Σmin ${spB.sum}，轨道 \`${norm(spB.src.tk?.raw)}\`）` +
          `⇒ **本判据不用它硬算 A 档 need**（B 档 Σmin ${spB.sum} ≠ A 档 Σmin ${parseTracks(SPEC.aTracks[c.id]).reduce((a, b) => a + b, 0)}，硬算必假红）`);
  }

  console.log(`| 表 | 视口 | 档 | Σmin | gap | pad×2 | **need** | min-width | 偏差 | 类型 | Σmin 出处 | min-width 出处 |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  const rec = [];
  for (const tb of TABLES) {
    const c = cov.find((x) => x.id === tb.id);
    for (const { v, band } of F5_VIEWS) {
      const sp = bandSpec(tb.id, v);
      const isA = band.startsWith("A");
      const fromTk = sp.src.tk?.mediaCond ?? "基础档";
      const fromMw = sp.src.mw?.mediaCond ?? "基础档";
      if (isA && !c.ok) {
        /* A 档未覆盖 ⇒ **不出这一行数**（出了就是拿 B 档 Σmin 硬算 A 档 need） */
        console.log(`| ${tb.id} | ${v} | ${band} | —(B档${sp.sum}) | ${sp.gap} | ${sp.pad} | — | ${sp.minWidth} | — | **未覆盖·不计算** | 基础档(B档，不可用于A档) | ${fromMw} |`);
        continue;
      }
      const need = sp.sum + sp.gap * (sp.n - 1) + sp.pad;
      const slack = sp.minWidth - need;
      const kind = slack > 0 ? "赘肉红" : slack < 0 ? "**不够红**" : "合规";
      rec.push({ id: tb.id, v, band, sum: sp.sum, gap: sp.gap, pad: sp.pad, n: sp.n, minWidth: sp.minWidth, need, slack, kind, fromTk, fromMw });
      console.log(`| ${tb.id} | ${v} | ${band} | ${sp.sum} | ${sp.gap} | ${sp.pad} | **${need}** | ${sp.minWidth} | ${slack > 0 ? `+${slack}` : slack} | ${kind} | ${fromTk} | ${fromMw} |`);
    }
  }
  for (const r of rec) {
    prodCheck(`F5-${r.band.replace(/[()]/g, "")}-${r.id}`, r.slack === 0,
      `${r.id} @${r.band}(${r.v}px)：min-width ${r.minWidth} vs need ${r.need}（Σmin ${r.sum} + gap ${r.gap}×${r.n - 1} + pad ${r.pad}，三项同取自 ${r.fromTk}/${r.fromMw}）⇒ ` +
      (r.slack === 0
        ? `**合规（偏差 0）**`
        : r.slack > 0
          ? `**赘肉红 +${r.slack}px**（多出来的空白；"448 vs 388"那类赘肉的根）`
          : `**不够红 ${r.slack}px**（轨道会被撑破 ⇒ 压字/横滚，比赘肉严重）`));
  }

  /* ★ A 档轨道必须**逐条对上 FINAL 补丁原文**（否则 need 对上了也可能是别的轨道凑出来的） */
  if (!covA.length) {
    console.log(`  ▸ A 档尚未落地 ⇒ \`F5-Atracks-*\` 无对象（红已由上面 ${missA.length} 条 \`F5-Amiss-*\` 报出，不重复计红）`);
  }
  for (const c of covA) {
    const want = parseTracks(SPEC.aTracks[c.id]);
    const got = c.spA.tracks;
    const eq = Array.isArray(want) && Array.isArray(got) && want.length === got.length
      && want.every((x, i) => Math.abs(x - got[i]) <= 0.01);
    prodCheck(`F5-Atracks-${c.id}`, eq,
      `${c.id} A 档轨道：声明 \`${norm(c.spA.src.tk.raw)}\` ⇒ [${(got ?? []).join(",")}] vs FINAL 补丁 [${(want ?? []).join(",")}]` +
      ` ⇒ ${eq ? `逐条对上（Σmin ${c.spA.sum}）` : `**不符**（Σmin ${c.spA.sum} vs 目标 ${(want ?? []).reduce((a, b) => a + b, 0)}）`}`);
  }

  /* ★ 覆盖**存在**还不够，值也要对：否则把 gap 写成 6 也能过「存在性」检查。
     这条直接把裁定的参数值钉住（A 档 gap 4 / 内距 8；B 档 gap 8 / 内距 16），
     出处：05 稿 L1858/L1861/1868/1875/1882/L1894/L1913 + 今日 A 档参数。 */
  {
    const gA = bandSpec("tbl-sea3", 320).gap;
    const gB = bandSpec("tbl-sea3", 414).gap;
    const pA = bandSpec("tbl-sea3", 320).pad;
    const pB = bandSpec("tbl-sea3", 414).pad;
    prodCheck("F5-val-gap", gA === SPEC.gap.A && gB === SPEC.gap.B,
      `生效 gap：A 档(320) 实测 **${gA}px** vs 裁定 ${SPEC.gap.A}px；B 档(414) 实测 **${gB}px** vs 裁定 ${SPEC.gap.B}px ⇒ ${gA === SPEC.gap.A && gB === SPEC.gap.B ? "两档都对" : "**不符**"}`);
    prodCheck("F5-val-pad", pA === SPEC.padSide.A * 2 && pB === SPEC.padSide.B * 2,
      `生效内距合计：A 档(320) 实测 **${pA}px**（/侧 ${pA / 2}）vs 裁定 ${SPEC.padSide.A * 2}px（/侧 ${SPEC.padSide.A}）；B 档(414) 实测 **${pB}px**（/侧 ${pB / 2}）vs 裁定 ${SPEC.padSide.B * 2}px ⇒ ${pA === SPEC.padSide.A * 2 && pB === SPEC.padSide.B * 2 ? "两档都对" : "**不符**"}`);
  }
  /* ★ 两档必须不同：gap 与 pad 两档不同 ⇒ need 必然不同 ⇒ min-width 也必须不同。
     相同 = 有一档根本没被媒体查询覆盖（"只写一个值、另一档靠继承"的半覆盖）。 */
  const same = TABLES.filter((tb) => bandSpec(tb.id, 409).minWidth === bandSpec(tb.id, 414).minWidth);
  prodCheck("F5-two-tier", same.length === 0,
    same.length === 0
      ? `五张表的 A 档(409)/B 档(414) min-width 声明值都不同 ⇒ 分档确实生效`
      : `${same.map((t) => t.id).join("、")} 两档 min-width 声明值**完全相同**（${bandSpec(same[0].id, 409).minWidth}px）⇒ **有一档没被媒体查询覆盖**，典型半覆盖`);
}

/* ── 判6：--sheet-gutter token 真被引用 ────────────────────────────────── */
console.log(`\n【判6】\`--sheet-gutter\` token —— 定义在 :root，当前 \`var(--sheet-gutter)\` 引用 ${GUT.varRefCount} 次`);
{
  /* 豁免名单**由门禁侧独立枚举**（team-lead 红线：不许让被测文件自己声明豁免） */
  const GATE_EXEMPT = { ".xb-flag": 10, ".xb-sheet__grab": 12, ".xb-empty": 20, ".xb-sheet__hd": 8 };
  check("CS-6a", GUT.tokenPx !== null, `token 定义值 = ${GUT.tokenPx}px（读不到 ⇒ 判6 不可信）`);
  prodCheck("F6-count", GUT.varRefCount > 0,
    `\`var(--sheet-gutter)\` 引用 **${GUT.varRefCount} 次**${GUT.varRefCount === 0 ? " ⇒ 名字与语义都对，**一个调用点都没用**，所以五处各写 16/10/0 不是马虎，是都绕过了它" : ""}`);
  prodCheck("F6-decl", /var\(--sheet-gutter\)/.test(String(GUT.padLeftDecl)) && /var\(--sheet-gutter\)/.test(String(GUT.padRightDecl)),
    `\`.xb-th,.xb-tr\` 的左右内距声明 = \`${GUT.padLeftDecl}\` / \`${GUT.padRightDecl}\`` +
    (/var\(--sheet-gutter\)/.test(String(GUT.padLeftDecl)) ? " ⇒ 走 token ✓" : " ⇒ **写死字面量**，token 改了不起作用"));

  /* ★ 接线证明（防「grep 到字符串就算过」的假绿）：把 token 改成 17，
     真由 token 驱动的元素必须跟着变。这里**只记录**，判定放在下面 F6-live，
     因为"变了没有"是**产品属性**，不是脚本自检（上一版把它记进自检账本，读数被误读）。 */
  const before = DATA[390]["tbl-sea5"].sheetPadChain;
  const probe = await render(TABLES[3], 390, ":root{--sheet-gutter:17px}");
  const after = probe.sheetPadChain;
  const changed = [], unchanged = [];
  for (const b of before) {
    const a = after.find((x) => x.sel === b.sel);
    if (!a || b.padL === null) continue;
    if (Math.abs(a.padL - b.padL) > 0.1) changed.push(b.sel); else unchanged.push(b.sel);
  }
  /* 自检只问一句：探针注入的 token 真的变成 17 了吗（否则整段证明无效） */
  const tokenInProbe = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sheet-gutter")) || null,
  );
  check("CS-6b", tokenInProbe === 17,
    `探针里 \`:root{--sheet-gutter:17px}\` 的**解析值 = ${tokenInProbe}px**${tokenInProbe === 17 ? "（注入生效，下面的对照才有意义）" : " ⇒ 注入没生效，F6-live 不可信"}`);
  const wantChanged = [".xb-th", ".xb-tr"];
  const missed = wantChanged.filter((s) => !changed.includes(s));
  console.log(`  对照：改 token 后变了 ${changed.length} 处 [${changed.join(" ") || "无"}]，没变 ${unchanged.length} 处 [${unchanged.join(" ") || "无"}]`);
  prodCheck("F6-live", missed.length === 0,
    missed.length === 0
      ? `内距链真的由 token 驱动：改 token ⇒ .xb-th/.xb-tr 跟着变（[${changed.join(" ")}]）`
      : `.xb-th/.xb-tr 内距**不受 token 影响**（实测仍是 ${before.find((x) => x.sel === ".xb-th")?.padL}px，token 已改 17px）⇒ 当前写的是字面量，token 是死定义`);
  console.log(`  豁免（门禁侧独立枚举，不读实现）：${Object.entries(GATE_EXEMPT).map(([k, v]) => `${k}=${v}px`).join(" / ")}`);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 变异测试 —— 每条两轮：改坏→必须红 / 还原→必须绿
 *   变异体带唯一标记 `MUTANT-QA-xx`，用**运行时注入**（`<style>`），不写 src/
 * ════════════════════════════════════════════════════════════════════════ */
console.log(`\n【变异测试】每条两轮：MUTANT-QA-xx（改坏，必须红）→ 撤销（还原，必须绿）`);

/** 一条变异 = 一次渲染 + 一次判据复算；返回 {red:[tag], green:[tag]} */
async function runMutant(id, tb, w, mutCss) {
  const d = await render(tb, w, mutCss);
  return d;
}

/* M1 表头字号：把 span 压到 9px ⇒ F1 必须红；还原 ⇒ 绿 */
{
  console.log(`\n  ▸ MUTANT-QA-01（表头字号）：\`.xb-th span{font-size:9px}\` @320`);
  console.log('    预期：红 F1-320');
  const b = await render(TABLES[2], 320, ".xb-th span{font-size:9px} /* MUTANT-QA-01 */");
  const bad = [...new Set(b.thFonts)];
  prodCheck("M1-red", !(bad.length === 1 && Math.abs(bad[0] - SPEC.headerFont.A) <= 0.1),
    `实测表头字号 = ${bad.join("/")}px ≠ ${SPEC.headerFont.A}px ⇒ 判据变红（**证明 F1 量的真是 span，不是容器**：容器 .xb-th 上的 font-size 是另一回事）`);
  const g = await render(TABLES[2], 320, ".xb-th span{font-size:10px} /* 还原：A 档值 */");
  const gb = [...new Set(g.thFonts)];
  prodCheck("M1-green", gb.length === 1 && Math.abs(gb[0] - SPEC.headerFont.A) <= 0.1,
    `把表头 span 设成 A 档的 ${SPEC.headerFont.A}px ⇒ 实测 ${gb.join("/")}px ⇒ **判据绿了**，红→绿闭合（也说明它认的是 span 的 font-size，不受容器 11px 干扰）`);
}

/* M2 表头文案：喂一份只有全名的字面量集合 ⇒ A 档必须红 */
{
  console.log(`\n  ▸ MUTANT-QA-02（表头文案）：把字面量集合换成只有全名 + 有切换机制`);
  console.log('    预期：红 F2-A');
  const onlyFull = { lits: new Set(["船名", "船务公司", "到达地", "计划出发", "状态", "闸口"]), hasSwitch: true };
  const r = judgeHeaderCopy(onlyFull, "A");
  prodCheck("M2-red", !r.ok, `A 档判据对「只有全名」判红：${r.detail}`);
  const r2 = judgeHeaderCopy(onlyFull, "B");
  prodCheck("M2-green", r2.ok, `同一份输入给 B 档判据判绿：${r2.detail} ⇒ 两档判据不同源，不是同一把尺子`);
  /* 第二条变异：字面量齐了但**没有切换机制** ⇒ 仍必须红（这是"孤儿字符串"的防线） */
  const noSwitch = { lits: new Set(["到达", "出发", "到达地", "计划出发"]), hasSwitch: false };
  const r3 = judgeHeaderCopy(noSwitch, "A");
  prodCheck("M2-red2", !r3.ok, `有短名字面量但无切换机制 ⇒ 仍判红：${r3.detail} ⇒ **加两个孤儿字符串骗不过去**`);
}

/* M3 三态分级：纯函数喂四组边界 */
{
  console.log(`\n  ▸ MUTANT-QA-03（三态）：给 classify() 喂边界值`);
  console.log('    预期：四档都可达；且「min-width 撑破 ⇒ 一定滚」这条**必真方向**能被证伪（造 sw=cw 但 mw > cw）');
  const cases = [
    { sw: 448, cw: 320, minWidth: 448, want: "SCROLL" },
    { sw: 320, cw: 320, minWidth: 320, want: "EDGE" },
    { sw: 320, cw: 320, minWidth: 318, want: "TIGHT" },
    { sw: 320, cw: 320, minWidth: 300, want: "OK" },
  ];
  let ok = 0;
  for (const c of cases) {
    const got = classify(c);
    const hit = got.state === c.want && got.consistent;
    if (hit) ok++;
    console.log(`    ${hit ? "✓" : "❌"} sw=${c.sw} cw=${c.cw} mw=${c.minWidth} ⇒ ${got.state}(margin=${got.margin}) 期望 ${c.want}`);
  }
  prodCheck("M3-red", ok === cases.length, `四档全中 ${ok}/${cases.length} ⇒ SCROLL/EDGE/TIGHT/OK 都可达（含 EDGE/TIGHT 这两个"贴边区间"）`);
  const contradict = classify({ sw: 320, cw: 320, minWidth: 400 });
  prodCheck("M3-guard", !contradict.consistent,
    `造矛盾输入（sw=cw 但 minWidth 400 > cw：算出来负却没滚）：consistent=${contradict.consistent} ⇒ CS-1 判**脚本取数有问题**，不会当产品绿`);
  /* ★ 反向**故意**不判矛盾：滚了但 min-width 没撑破，是「单格 nowrap 溢出画到表格外」，
     属于真实横滚 + 产品问题，不该被误报成脚本坏（sea3 那 5 条就是这么来的）。 */
  const ink = classify({ sw: 324, cw: 320, minWidth: 229, cellOver: [{ c: 3, over: 4, t: "08:20" }] });
  prodCheck("M3-ink", ink.consistent && ink.state === "SCROLL" && /单格溢出/.test(ink.cause ?? ""),
    `造「sw>cw 但 margin=+91」（单格溢出顶出表格右缘）：consistent=${ink.consistent}、state=${ink.state}、cause=${ink.cause} ⇒ ` +
    `**仍判产品红，但归因到单格溢出，不冒充 min-width 问题**`);
}

/* M4 船务公司列（A 档期望 **56**）：压到 48 ⇒ 两条都红；给回 56 + 11px 字号 ⇒ 绿 */
{
  console.log(`\n  ▸ MUTANT-QA-04（船务公司列）：轨道压到 48px @320`);
  console.log('    预期：红 F4w-320 与 F4f-320');
  const m = await render(TABLES[2], 320,
    ".tbl-sea3 .xb-th,.tbl-sea3 .xb-tr{grid-template-columns:minmax(72px,1fr) 48px 56px 50px} /* MUTANT-QA-04 */");
  const got = m.resolvedTracks[1];
  const longest = m.textW[1];
  prodCheck("M4-red", Math.abs(got - SPEC.companyCol.A) > 0.6 && got + 0.01 < longest,
    `压到 48px：列宽 ${got} ≠ 期望 ${SPEC.companyCol.A}（列宽判据红），且 < 文案 ${longest}（缺 ${(longest - got).toFixed(2)}px，装不下判据也红）`);
  /* 第二轮：改成 A 档落地后的**真实状态** —— 轨 56 + 表体 11px ⇒ 文案宽自动降到 55 左右 ⇒ 绿。
     ⚠️ 这里刻意**同时**改字号：只把轨改成 56 而字号还是 13px，文案宽 65 > 56 仍然红（那是对的，
        也正是"落地前"的状态）。要证明判据能绿，必须连字号一起到 A 档。 */
  const g = await render(TABLES[2], 320,
    ".tbl-sea3 .xb-th,.tbl-sea3 .xb-tr{grid-template-columns:minmax(72px,1fr) 56px 56px 50px} /* 还原：A 档 56 */\n.tbl-sea3 .xb-c{font-size:11px} /* 还原：A 档表体 11px */");
  const g2 = g.resolvedTracks[1];
  prodCheck("M4-green", Math.abs(g2 - SPEC.companyCol.A) <= 0.6 && g2 + 0.01 >= g.textW[1],
    `A 档落地状态（轨 56 + 表体 11px）：列宽 ${g2} == 期望 ${SPEC.companyCol.A}，文案宽降到 ${g.textW[1]} ≤ ${g2} ⇒ **判据绿了**，红→绿闭合`);
}

/* M5 min-width 赘肉：**在 CSS 文本层**做变异（静态判据必须在它读的那一层改） */
{
  console.log(`\n  ▸ MUTANT-QA-05（min-width 赘肉）：构造「A 档已落地」的 CSS 文本，再分别改坏 / 还原`);
  console.log(`    预期：红 F5 的「赘肉红」与「不够红」两种都要能报；还原后两档各自 slack=0 且两档值不同`);
  const tkA = parseTracks(SPEC.aTracks["tbl-air4"]);
  const sumA = tkA.reduce((a, b) => a + b, 0);          /* A 档 Σmin = 44+46+40+112 = 242 */
  const n4 = tkA.length;
  const needA = sumA + SPEC.gap.A * (n4 - 1) + SPEC.padSide.A * 2;  /* 242+12+16 = 270 */
  const spBase = bandSpec("tbl-air4", 414);
  const needB = spBase.sum + SPEC.gap.B * (spBase.n - 1) + SPEC.padSide.B * 2; /* 266+24+32 = 322 */
  /* ⚠️ 变异文本里 A 档**必须连轨道一起换成 A 档自己的**：只换 gap/pad 而留 B 档轨道，
     等于把"混档"这个 bug 又写进变异体 ⇒ 测出来的红绿都没意义。 */
  /* 构造 A 档生效的文本。⚠️ 顺序：先基础档（B），后 @media（A）——同权重"后来者胜"，
     反了会让基础值把 320 也盖掉（这个坑上一版翻过）。 */
  const landCss = (minWA) =>
    CSS_ALL +
    `\n/* MUTANT-QA-05 模拟 A 档落地（轨道也换成 A 档自己的，不用 B 档 Σmin）*/\n.tbl-air4{min-width:${needB}px;}\n` +
    `@media (max-width:409px){\n  .tbl-air4 .xb-th,.tbl-air4 .xb-tr{grid-template-columns:${SPEC.aTracks["tbl-air4"]};}\n` +
    `  .xb-th,.xb-tr{column-gap:${SPEC.gap.A}px;padding-left:${SPEC.padSide.A}px;padding-right:${SPEC.padSide.A}px;}\n` +
    `  .tbl-air4{min-width:${minWA}px;}\n}\n`;
  const probe = (minWA) =>
    withEnv(landCss(minWA), () => {
      const a = bandSpec("tbl-air4", 320);
      const b = bandSpec("tbl-air4", 414);
      const needOf = (s) => s.sum + s.gap * (s.n - 1) + s.pad;
      return {
        a: { ...a, need: needOf(a), slack: a.minWidth - needOf(a) },
        b: { ...b, need: needOf(b), slack: b.minWidth - needOf(b) },
      };
    });

  /* ① 赘肉红：A 档多给 6px */
  const over = probe(needA + 6);
  prodCheck("M5-red-fat", over.a.slack === 6 && over.a.gap === SPEC.gap.A && over.a.pad === SPEC.padSide.A * 2,
    `A 档 min-width 给 ${needA + 6} ⇒ 读到 gap=${over.a.gap}、pad=${over.a.pad}、need=${over.a.need} ⇒ **赘肉红 +${over.a.slack}px**（解析器确实按 A 档取值，没有混档）`);
  /* ② 不够红：A 档少给 4px */
  const short = probe(needA - 4);
  prodCheck("M5-red-short", short.a.slack === -4,
    `A 档 min-width 给 ${needA - 4} ⇒ **不够红 ${short.a.slack}px**（轨道会被撑破，比赘肉严重）⇒ 两种红都能报出来`);
  /* ③ 还原（正好）⇒ 两档各自 slack=0，且两档 min-width 不同 */
  const ok = probe(needA);
  prodCheck("M5-green", ok.a.slack === 0 && ok.b.slack === 0 && ok.a.minWidth !== ok.b.minWidth,
    `A 档给 ${needA}、B 档给 ${needB} ⇒ A: slack ${ok.a.slack}（gap ${ok.a.gap}/pad ${ok.a.pad}）、B: slack ${ok.b.slack}（gap ${ok.b.gap}/pad ${ok.b.pad}）；` +
    `两档 min-width ${ok.a.minWidth}≠${ok.b.minWidth} ⇒ **判据绿了，红→绿闭合**；也证明"一个值盖不住两档"`);
  /* ④ ★ 关键回归：A 档 Σmin 必须是 **242**（该档自己的轨道），不是 B 档的 266。
     这条变异专门抓「Σmin 只读基础档」那个混档 bug 的复发 ——
     若读到 266，need 会变 294，落盘后 270 就被判「不够红 −24」。 */
  prodCheck("M5-band-sum", ok.a.sum === sumA && ok.a.sum !== spBase.sum,
    `A 档 Σmin 读到 **${ok.a.sum}**（应为该档自己的 ${sumA} = ${tkA.join("+")}）；B 档 Σmin ${spBase.sum} ≠ A 档 ⇒ ` +
    (ok.a.sum === sumA ? `**两档各自读了本档轨道**，没有拿 B 档 Σmin 算 A 档 need（否则 need 会从 ${needA} 变成 ${spBase.sum + SPEC.gap.A * (n4 - 1) + SPEC.padSide.A * 2}）` : `**又混档了**`));
  void runMutant;
}

/* M6 token 接线：写死 16px ⇒ F6-live 必须红 */
{
  console.log(`\n  ▸ MUTANT-QA-06（token 接线）：把内距写死 \`padding-left:16px\`（不用 token）`);
  console.log('    预期：红 F6-live / CS-6b');
  const hard = await render(TABLES[3], 390,
    ".xb-th,.xb-tr{padding-left:16px;padding-right:16px} /* MUTANT-QA-06 */\n:root{--sheet-gutter:17px}");
  const hardPad = hard.sheetPadChain.find((x) => x.sel === ".xb-th")?.padL;
  prodCheck("M6-red", Math.abs(hardPad - 17) > 0.1,
    `token 改 17px 而内距写死 16px ⇒ .xb-th 实测 ${hardPad}px，**不跟着变** ⇒ 判据能识破「只 grep 到字符串」的假绿`);
  /* 第二轮：把内距改成真的走 token ⇒ 必须变 17（证明这条判据**能转绿**，不是只会红） */
  const wired = await render(TABLES[3], 390,
    ".xb-th,.xb-tr{padding-left:var(--sheet-gutter);padding-right:var(--sheet-gutter)} /* 还原：走 token */\n:root{--sheet-gutter:17px}");
  const wiredPad = wired.sheetPadChain.find((x) => x.sel === ".xb-th")?.padL;
  prodCheck("M6-green", Math.abs(wiredPad - 17) <= 0.1,
    `把内距改成 var(--sheet-gutter) 且 token=17px ⇒ .xb-th 实测 ${wiredPad}px ⇒ **判据绿了**，红→绿闭合（这是 F6-live 能通过的唯一写法）`);
}

/* M7 回放"落盘前"：把 `max-width:409px` 整块摘掉，证明「A 档未覆盖」这条分支**不是死代码**。
   为什么要保留这条：落盘之后「A 档缺声明」永远为假，那个分支再也不会被走到；
   而它恰恰是防止"拿 B 档 Σmin 硬算 A 档 need"的唯一开关 —— 死掉就等于没写。 */
{
  console.log(`\n  ▸ MUTANT-QA-07（回放落盘前）：把 \`@media (max-width: 409px)\` 整块摘掉，重跑判5 的读法`);
  console.log('    预期：A 档 5 张表全部「未覆盖·缺声明」且**不出数**（不拿 B 档 Σmin 硬算）');
  const clean = CSS_ALL.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)); /* 等长替换 ⇒ 下标不变 */
  const spans = parseCssBlocks(clean)
    .filter((b) => /^@media/.test(b.head) && /max-width:\s*409px/.test(b.head))
    .map((b) => [b.at, b.end + 1]);
  let pre = CSS_ALL;
  for (const [a, e] of spans.sort((x, y) => y[0] - x[0])) pre = pre.slice(0, a) + pre.slice(e);
  const r = withEnv(pre, () => ({
    miss: TABLES.filter((tb) => {
      const sp = bandSpec(tb.id, 409);
      return !(sp.src.tk?.mediaCond && sp.src.mw?.mediaCond);
    }).map((t) => t.id),
    bslack: TABLES.map((tb) => {
      const sp = bandSpec(tb.id, 414);
      return { id: tb.id, slack: sp.minWidth - (sp.sum + sp.gap * (sp.n - 1) + sp.pad) };
    }),
    aSumSeen: bandSpec("tbl-air4", 409).sum,
  }));
  prodCheck("M5-prelanding", r.miss.length === TABLES.length && r.bslack.every((s) => s.slack === 0),
    `摘掉 ${spans.length} 个 409 块后：A 档未覆盖 **${r.miss.length}/${TABLES.length}** 张（${r.miss.join("、")}）、` +
    `409 视口读到的 Σmin 退回 B 档的 ${r.aSumSeen} ⇒ \`F5-Amiss-*\` 会全红且 A 行**不出数**；` +
    `B 档赘肉 ${r.bslack.map((s) => `${s.id}${s.slack > 0 ? "+" + s.slack : s.slack}`).join(" ")}` +
    `（落盘同时改了 B 档 min-width，所以这里不再是落盘前那五个数 —— 那五个数在 \`.verify/qa42-baseline-run.out.txt\` 存证里）`);
}

await browser.close();

/* ══════════════════════════════════════════════════════════════════════════
 * 汇总
 * ════════════════════════════════════════════════════════════════════════ */
console.log(`\n${"═".repeat(74)}`);
console.log(`[自检汇总] PASS ${passN} / FAIL ${failN}   ← 脚本本身可不可信`);
console.log(`[产品断言] PASS ${prodPass} / FAIL ${prodFail}   ← 六条判据的真实结论`);
if (REDS.length) {
  console.log(`\n[红清单]`);
  for (const r of REDS) console.log(`  · ${r}`);
}
console.log(`\n[状态符号] SCROLL=实测 sw>cw / EDGE=余 0 / TIGHT=余 1~2 / OK=余 ≥3`);
console.log(failN === 0 && prodFail === 0 ? `\n✅ 六条判据全部通过` : `\n❌ 未通过（自检 ${failN} 条 + 产品 ${prodFail} 条）`);
process.exit(failN === 0 && prodFail === 0 ? 0 : 1);
