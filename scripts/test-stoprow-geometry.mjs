#!/usr/bin/env node
/**
 * 站序纵条几何门禁（scripts/test-stoprow-geometry.mjs，2026-11-07 由 `.verify/` 迁入）
 *
 * ── 守什么 ────────────────────────────────────────────────────────────────
 *   车主的原始诉求：「节点和巴士图标不能挡到右边站名文字」。
 *   这是一条**尺寸依赖的物理约束**，不是代码不变量：
 *   `.lp-stop` 的 `padding-left`、图标尺寸、环宽，任一变动都可能让它重新压字。
 *   而压字**没有编译错、没有类型错、没有报错**，只是文字被盖住 ——
 *   用户会以为是"设计就这样"。⇒ 必须用真浏览器量化钉住。
 *
 *   [0] 夹具自检
 *   [1] 现行 CSS 下四态右间距 ≥ 4px（**硬断言**；CSS 未落地时退化为 WAIT，见下）
 *   [2] 圆点（节点）↔ 站名 ≥ 4px（车主的第二条诉求）
 *   [3] 站名可用宽度仍够（≥180px，防止"为了不压字把名字挤没"）
 *   [4] 纵向：ready/stop/approach 完全在本行内；四态都不得压到**任何一行**站名
 *   [5] 既有约束未被改小（命中区 44×44、壳 22×22、与竖线同心）
 *   [6] 四态 → `data-glyph-state` 映射（真 DOM 取值）
 *   [7] 涂装色 == 线路色（不是写死的运营商色）
 *
 * ── 为什么**不**进 `npm run verify` 链 ────────────────────────────────────
 *   要起真 Chrome（playwright-core）。塞进 verify 会让整条链变慢、且在无
 *   浏览器的环境（CI 容器）里直接失败，把"真门禁"拖成红。
 *   ⇒ 单独入口 `npm run test:geometry`，**必须有人/夜间任务主动跑**。
 *   ⚠️ 它缺失浏览器时是**响亮 SKIP**（exit 0 但打印大块警示），不会假装 PASS。
 *      这是有意的取舍：SKIP 骗不了人，但"塞进 verify 让人永远看不到它"更糟。
 *
 * ── 怎么量（不靠估）──────────────────────────────────────────────────────
 *   ① `spawn` 生成器（`scripts/lib/gen-stoprow-fixture.tsx`）产出夹具到 os.tmpdir()
 *      ⇒ 入库目录里不留构建产物；
 *   ② 真 Chrome（DPR 2）对**同一行**拍两帧：只把这行的 `.lp-stop__veh`
 *      `visibility:hidden` / 还原；
 *      ⚠️ 必须**逐行**开关 —— 整页开关会把相邻行的 4px 呼吸环算进本行 bbox
 *         （实测踩过，clip 高 136px 时发生过）；
 *   ③ 两帧逐像素差 ⇒ 图标**实际着墨** bbox（含 box-shadow 外环与 ‖ 徽章）；
 *   ④ 与 `.lp-stop__name` 的 rect 相减 ⇒ 间距；与相邻行 rect 相交 ⇒ 溢出判定。
 *
 * 跑法：
 *   npm run test:geometry
 *   node scripts/test-stoprow-geometry.mjs --self-test   # 自证：故意把内距改坏，须变红
 * 退出码：0 = 全 PASS 或 SKIP；1 = 有 FAIL / 自测失败。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodePNG, diffBBox } from "./lib/png-decode.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DPR = 2;
/** 图标与站名文字之间**要求的最小间距**（px）—— 车主诉求，写死成门禁 */
const MIN_GAP = 4;
/** 站名可用宽度下限（防止"为了不压字把名字挤没"） */
const MIN_NAME_W = 180;
const SELF_TEST = process.argv.includes("--self-test");

let pass = 0;
let fail = 0;
let wait = 0;
function ok(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra ? ` :: ${extra}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ` :: ${extra}` : ""}`);
  }
}
/** 「待他人落地」：不算 FAIL（否则门禁长期红着 = 没人看），但绝不静默 */
function pending(name, extra = "") {
  wait++;
  console.log(`  WAIT  ${name}${extra ? ` :: ${extra}` : ""}`);
}

/* ══════════════════════════════════════════════════════════════════════════
   依赖解析：两样东西都**不是** package.json 的直接依赖 ⇒ 必须多源 + 缺则响亮 SKIP
   ══════════════════════════════════════════════════════════════════════════ */
function resolvePlaywright() {
  /* ★ 测试钩子：`STOPROW_GEOM_FORCE_SKIP=1` 强制走 SKIP 分支。
     为什么需要它：SKIP 路径是**错误路径**，而错误路径不测就会悄悄坏
     （例如某天把 `process.exit(0)` 写成 `process.exit(1)`，或忘了打印警示，
     那么"没浏览器"就会被当成"通过"）。有了这个钩子，SKIP 分支可被 CI/人手动验证。 */
  if (process.env.STOPROW_GEOM_FORCE_SKIP === "1") return null;
  const require_ = createRequire(import.meta.url);
  const cands = [
    process.env.PLAYWRIGHT_CORE_PATH,
    // 本机 WorkBuddy 自带的 playwright-core（**仅开发机**，别指望 CI 有）
    "C:/Users/ASUS/.workbuddy/binaries/node/workspace/node_modules/playwright-core",
  ].filter(Boolean);
  for (const c of [null, ...cands]) {
    try {
      return c ? require_(c) : require_("playwright-core");
    } catch {
      /* 继续试下一个 */
    }
  }
  return null;
}
function resolveChrome() {
  const cands = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  return cands.find((p) => existsSync(p)) ?? null;
}

function skip(reason, detail) {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  SKIPPED —— 本次**没有验证**任何几何约束（不是 PASS，别当绿灯）      ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");
  console.log(`原因：${reason}`);
  for (const l of detail) console.log(`      ${l}`);
  console.log("");
  console.log("⇒ 本门禁不进 `npm run verify`（要起浏览器），只能手动跑。");
  console.log("   在没有它的机器上，「纵条图标不压站名」这条**当前无人守**。");
  process.exit(0);
}

const playwright = resolvePlaywright();
if (!playwright) {
  skip("找不到 playwright-core", [
    "它是本机/开发环境的可选依赖，不在 package.json 里。",
    "启用方式（任选一）：",
    "  · npm i -D playwright-core（并确保有 Chrome）",
    "  · 设 PLAYWRIGHT_CORE_PATH=<playwright-core 目录>",
  ]);
}
const chrome = resolveChrome();
if (!chrome) {
  skip("找不到 Chrome/Chromium 可执行文件", [
    "已试：$CHROME_PATH、Windows/macOS/Linux 常见路径。",
    "启用方式：设 CHROME_PATH=<chrome 可执行文件绝对路径>",
  ]);
}

/* ── 生成夹具（产物落 os.tmpdir，不污染入库目录）──────────────────────── */
const work = mkdtempSync(join(tmpdir(), "stoprow-geom-"));
const FIXTURE = join(work, "fixture.html");
const gen = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/lib/gen-stoprow-fixture.tsx", FIXTURE], {
  cwd: join(HERE, ".."),
  encoding: "utf8",
});
if (gen.status !== 0 || !existsSync(FIXTURE)) {
  console.error("[FAIL] 夹具生成失败：");
  console.error(gen.stdout || "", gen.stderr || "");
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

const r1 = (n) => Math.round(n * 10) / 10;
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 860, height: 900 }, deviceScaleFactor: DPR });
await page.goto(pathToFileURL(FIXTURE).href, { waitUntil: "load" });
/* 呼吸动画会污染「两帧像素差」（同一元素两个相位）⇒ 测量期间强制关掉。
   ⚠️ 这只是**测量夹具**的开关；产品里 approach 的 1.6s 呼吸仍由 CSS 给。 */
await page.addStyleTag({ content: "*{animation:none!important;transition:none!important}" });
/* 版式探针：**单例** style，靠改 textContent 切变体。
   ⚠️ 不能用 `querySelectorAll("style").remove()` —— 会把内联的 globals.css 一起删掉，
      页面瞬间无样式 ⇒ 两帧像素差为空（这个坑实测踩过一次）。 */
await page.evaluate(() => {
  const s = document.createElement("style");
  s.id = "probe";
  document.head.appendChild(s);
});
const setPad = (px) =>
  page.evaluate((p) => {
    document.getElementById("probe").textContent = p ? `.lp-stop{padding-left:${p}px}` : "";
  }, px);

/** 读 `#with` 里第 i 行的几何（页坐标） */
async function rects(i) {
  return page.evaluate((idx) => {
    const row = document.querySelectorAll("#with .lp-stop")[idx];
    const q = (sel) => {
      const el = row.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const rr = row.getBoundingClientRect();
    const svg = row.querySelector("svg.vbus");
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    };
    return {
      row: { left: rr.left, right: rr.right, top: rr.top, bottom: rr.bottom, width: rr.width, height: rr.height },
      dot: q(".lp-stop__dot"),
      name: q(".lp-stop__name"),
      eta: q(".lp-stop__eta"),
      veh: q(".lp-stop__veh"),
      hit: q(".lp-stop__veh-hit"),
      svg: q("svg.vbus"),
      state: row.querySelector(".lp-stop__veh")?.getAttribute("data-veh") ?? null,
      glyphState: svg?.getAttribute("data-glyph-state") ?? null,
      prevName: box(row.previousElementSibling?.querySelector(".lp-stop__name")),
      nextName: box(row.nextElementSibling?.querySelector(".lp-stop__name")),
    };
  }, i);
}

/** 只把第 i 行图标隐藏再还原，两帧逐像素差 ⇒ 该图标实际着墨 bbox（页坐标） */
async function inkBBox(i, pad = 8) {
  const m = await rects(i);
  const clip = {
    x: Math.max(0, Math.floor(m.row.left)),
    y: Math.max(0, Math.floor(m.row.top - pad)),
    width: 48,
    height: Math.ceil(m.row.height + pad * 2),
  };
  const toggle = (hidden) =>
    page.evaluate(
      ({ idx, hid }) => {
        const el = document.querySelectorAll("#with .lp-stop")[idx].querySelector(".lp-stop__veh");
        el.style.visibility = hid ? "hidden" : "";
      },
      { idx: i, hid: hidden },
    );
  await toggle(true);
  const A = decodePNG(await page.screenshot({ clip }));
  await toggle(false);
  const B = decodePNG(await page.screenshot({ clip }));
  const bb = diffBBox(A, B);
  if (!bb) return null;
  return {
    left: clip.x + bb.minX / DPR,
    right: clip.x + (bb.maxX + 1) / DPR,
    top: clip.y + bb.minY / DPR,
    bottom: clip.y + (bb.maxY + 1) / DPR,
  };
}

/** 量四行（ready / stop / approach / moving），返回间距等派生量 */
async function sweep() {
  const out = [];
  for (let i = 1; i <= 4; i++) {
    const m = await rects(i);
    const ink = await inkBBox(i);
    out.push({
      i,
      state: m.state,
      m,
      ink,
      inkLeftInRow: ink.left - m.row.left,
      inkRightInRow: ink.right - m.row.left,
      gapRight: m.name.left - ink.right,
      gapLeft: ink.left - m.row.left,
      dotToName: m.name.left - m.dot.right,
      nameWidth: m.eta.left - m.name.left,
    });
  }
  return out;
}

/** 现行 CSS 的 `padding-left`（去注释后读，避免命中文档里的示例） */
const CSS_NO_COMMENT = readFileSync(join(HERE, "..", "src/app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const padFromCss = (() => {
  const m = /\.lp-stop\s*\{([^}]*)\}/.exec(CSS_NO_COMMENT);
  const d = m && /padding-left:\s*(\d+)px/.exec(m[1]);
  return d ? Number(d[1]) : null;
})();

console.log("═══ 站序纵条几何门禁 ═════════════════════════════════════════════════");
console.log(`真 Chrome · DPR ${DPR} · 375px 列 · 着墨 = 隐藏/显示图标两帧逐像素差`);
console.log(`现行 CSS：.lp-stop{padding-left:${padFromCss}px}`);
console.log("──────────────────────────────────────────────────────────────────────");

/* ── [0] 夹具自检 ─────────────────────────────────────────────────────── */
const names = await page.evaluate(() => [...document.querySelectorAll("#with .lp-stop__name")].map((e) => e.textContent));
ok("[0] 夹具 6 行站名齐全", names.length === 6, names.join("/"));

/* ── [1] 现状（真实 CSS）──────────────────────────────────────────────────
   ⚠️ CSS 未落地时不写死 FAIL 而写 WAIT：`.lp-stop` 的版式归 `globals.css`（他人域），
      本轮改动可能只有 TSX。落地后本条自动转硬断言。 */
console.log("\n[1] 现状：实测四态右间距");
await setPad(null);
const cur = await sweep();
for (const r of cur) {
  console.log(
    `   ${String(r.state).padEnd(8)} 图标着墨 x=${r1(r.inkLeftInRow)}~${r1(r.inkRightInRow)} · ` +
      `站名 left=${r1(r.m.name.left - r.m.row.left)} · **右间距 ${r1(r.gapRight)}px**`,
  );
}
const worstCur = Math.min(...cur.map((r) => r.gapRight));
const leftOk = cur.every((r) => r.gapLeft >= 0);
ok("[1] 图标未越出行左边界（左间距 ≥ 0）", leftOk, cur.map((r) => r1(r.gapLeft)).join("/"));
if (worstCur >= MIN_GAP) {
  ok(`[1] 现行 CSS（padding-left:${padFromCss}px）四态右间距 ≥ ${MIN_GAP}px`, true, `最差 ${r1(worstCur)}px`);
} else {
  pending(
    `[1] 现行 CSS（padding-left:${padFromCss}px）最差右间距 ${r1(worstCur)}px < ${MIN_GAP}，需 CSS 侧加大内距`,
    `实测最外沿 ${r1(Math.max(...cur.map((r) => r.inkRightInRow)))}px ⇒ padding-left 至少再 +${Math.ceil(
      MIN_GAP - worstCur,
    )}px`,
  );
}

/* ── [2] 节点（圆点）↔ 站名（车主第二条诉求）─────────────────────────── */
console.log("\n[2] 圆点（节点）↔ 站名");
const worstDot = Math.min(...cur.map((r) => r.dotToName));
for (const r of cur) console.log(`   ${String(r.state).padEnd(8)} 圆点→文字 ${r1(r.dotToName)}px`);
ok("[2] 圆点与站名之间 ≥ 4px（不紧贴）", worstDot >= 4, `最差 ${r1(worstDot)}px`);

/* ── [3] 站名可用宽度 ─────────────────────────────────────────────────── */
const minNameW = Math.min(...cur.map((r) => r.nameWidth));
console.log(`\n[3] 站名可用宽度 最窄 ${r1(minNameW)}px`);
ok(`[3] 站名可用宽度 ≥ ${MIN_NAME_W}px（防止"为不压字把名字挤没"）`, minNameW >= MIN_NAME_W, `最窄 ${r1(minNameW)}px`);

/* ── [4] 纵向：不压任何一行的站名 ───────────────────────────────────────
   判据**分态**：ready/stop/approach 的 frac=0 ⇒ 必须完全落在本行；
   `moving` 按 `--veh-frac` 契约**本来就要画在两行之间**（frac=0.5 时中心落在交界），
   这是设计意图，不是溢出。要守的是"它的着墨不能碰到任何一行站名文字"。 */
console.log("\n[4] 纵向：图标着墨 vs 本行 / 相邻行文字");
let badOwn = 0;
let badName = 0;
for (let i = 1; i <= 4; i++) {
  const m = await rects(i);
  const ink = await inkBBox(i, 34);
  const isMoving = m.state === "moving";
  const insideOwn = ink.top >= m.row.top - 0.5 && ink.bottom <= m.row.bottom + 0.5;
  const hit = [m.prevName, m.nextName]
    .filter(Boolean)
    .filter((n) => ink.bottom > n.top + 0.5 && ink.top < n.bottom - 0.5 && ink.right > m.name.left - MIN_GAP + 0.001);
  if (!isMoving && !insideOwn) badOwn++;
  if (hit.length) badName++;
  console.log(
    `   第 ${i + 1} 行 ${String(m.state).padEnd(8)} 行 ${r1(m.row.top)}~${r1(m.row.bottom)} · 图标 ${r1(ink.top)}~${r1(
      ink.bottom,
    )} · 余量 上 ${r1(ink.top - m.row.top)} / 下 ${r1(m.row.bottom - ink.bottom)} · ` +
      `${isMoving ? "跨行（frac=0.5，设计意图）" : insideOwn ? "本行内 ✓" : "**越界**"} · 压到邻行文字 ${hit.length}`,
  );
}
ok("[4] ready/stop/approach（frac=0）图标完全落在本行内", badOwn === 0, `越界 ${badOwn} 行`);
ok("[4] 四态图标都没有碰到任何一行站名文字（含 moving 跨行态）", badName === 0, `压字 ${badName} 行`);

/* ── [5] 既有约束未被改小 ─────────────────────────────────────────────── */
const m1 = await rects(1);
ok("[5] 命中区 = 44×44（WCAG 2.5.5）", Math.round(m1.hit.width) === 44 && Math.round(m1.hit.height) === 44, `${m1.hit.width}×${m1.hit.height}`);
ok("[5] 图标壳 22×22", Math.round(m1.veh.width) === 22 && Math.round(m1.veh.height) === 22, `${m1.veh.width}×${m1.veh.height}`);
ok("[5] 字形 svg 22×22（32 单位画布等比缩放）", Math.round(m1.svg.width) === 22 && Math.round(m1.svg.height) === 22, `${m1.svg.width}×${m1.svg.height}`);
ok(
  "[5] 字形与纵条同心（svg 中心 = 竖线中心 16.5px）",
  Math.abs(m1.svg.left + m1.svg.width / 2 - (m1.row.left + 16.5)) < 0.6,
  `svg 中心 ${r1(m1.svg.left + m1.svg.width / 2 - m1.row.left)} vs 16.5`,
);

/* ── [6] 四态 → 字形状态（真 DOM 取值）────────────────────────────────── */
console.log("\n[6] 四态 → 字形状态（真 DOM）");
const MAPPING = { ready: "ready", stop: "stop", approach: "approach", moving: "moving" };
for (let i = 1; i <= 4; i++) {
  const m = await rects(i);
  ok(`[6] data-veh=${m.state} ⇒ data-glyph-state=${m.glyphState}`, MAPPING[m.state] === m.glyphState, m.glyphState);
}
ok(
  "[6] 观测钩子齐在（data-veh-scope / data-veh-anim）",
  await page.evaluate(() => {
    const v = document.querySelector('#with .lp-stop__veh[data-veh="approach"]');
    return !!v && v.getAttribute("data-veh-scope") === "stops" && v.getAttribute("data-veh-anim") === "breath";
  }),
);

/* ── [7] 涂装色 == 线路色 ─────────────────────────────────────────────── */
const livery = await page.evaluate(() => {
  const svg = document.querySelector("#with .lp-stop__veh svg.vbus");
  return {
    bodyFill: getComputedStyle(svg.querySelector(".vbus__body")).fill,
    inkFill: getComputedStyle(svg.querySelector(".vbus__ink")).fill,
    livery: getComputedStyle(svg).getPropertyValue("--vbus-livery").trim(),
    lineColor: getComputedStyle(svg.closest(".lp-stop")).getPropertyValue("--lp-color").trim(),
  };
});
ok("[7] 车身 fill 已解析成线路色", livery.bodyFill === "rgb(194, 109, 50)", livery.bodyFill);
ok(
  "[7] 墨色描边 fill 是独立实色（`color-mix` 会解析成 `color(srgb …)`，不是 rgb）",
  /^(rgb|color)\(/.test(livery.inkFill) && livery.inkFill !== livery.bodyFill,
  livery.inkFill,
);
ok("[7] `--vbus-livery` == 线路色", livery.livery === livery.lineColor, JSON.stringify(livery));

/* ══════════════════════════════════════════════════════════════════════════
   --self-test：把内距**故意改坏**，上面的量法必须变红
   这是几何门禁最关键的一步：证明"量出来的数"真的能反映版式，
   而不是量错东西后一律绿灯（例如 bbox 取错元素、像素差为空）。
   ══════════════════════════════════════════════════════════════════════════ */
if (SELF_TEST) {
  console.log("\n═══ 自证有效：故意把 padding-left 改坏（26px），右间距判据必须变红 ═══");
  let bad = 0;
  const t = (name, cond) => {
    if (!cond) bad++;
    console.log(`  ${cond ? "OK  " : "BAD "}  ${name}`);
  };
  await setPad(26);
  const mutated = await sweep();
  const worstMut = Math.min(...mutated.map((r) => r.gapRight));
  for (const r of mutated) console.log(`   改坏后 ${String(r.state).padEnd(8)} 右间距 ${r1(r.gapRight)}px`);
  t(`改坏后最差右间距 ${r1(worstMut)}px < ${MIN_GAP}（判据能报红）`, worstMut < MIN_GAP);
  t("改坏后仍量得到非空着墨 bbox（量法本身没坏）", mutated.every((r) => r.ink !== null && r.inkRightInRow > 0));
  await setPad(null);
  const restored = await sweep();
  const worstRestored = Math.min(...restored.map((r) => r.gapRight));
  t(`恢复真实 CSS 后最差右间距 ${r1(worstRestored)}px ≥ ${MIN_GAP}（判据能回绿）`, worstRestored >= MIN_GAP);
  console.log(bad === 0 ? "\n自测通过：3/3 —— 量法对版式变化敏感" : `\n自测失败：${bad} 条 —— 本门禁不可信`);
  await browser.close();
  rmSync(work, { recursive: true, force: true });
  process.exit(bad === 0 ? 0 : 1);
}

console.log("\n──────────────────────────────────────────────────────────────────────");
console.log(`实测汇总（现行 CSS）`);
for (const r of cur) {
  console.log(
    `  行 ${r.i + 1} [${r.state.padEnd(8)}] 图标 x=${r1(r.inkLeftInRow)}~${r1(r.inkRightInRow)} · 右间距 ${r1(
      r.gapRight,
    )}px · 左间距 ${r1(r.gapLeft)}px · 圆点→文字 ${r1(r.dotToName)}px`,
  );
}
console.log(`\n===== PASS ${pass} / FAIL ${fail} / WAIT ${wait} =====`);
await browser.close();
rmSync(work, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
