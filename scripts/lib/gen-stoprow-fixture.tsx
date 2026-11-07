/**
 * 几何门禁的夹具生成器（scripts/lib/gen-stoprow-fixture.tsx，2026-11-07 迁入）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────────
 *   把真实的 `LineStopList` 渲染成一份**自带 globals.css 的静态 HTML**，
 *   交给 `scripts/test-stoprow-geometry.mjs` 用真 Chrome 量：
 *     · 每一行：`li` / `.lp-stop__dot` / `.lp-stop__name` / `.lp-stop__veh` 的 rect；
 *     · 图标的**实际着墨 bbox**（隐藏图标层前后两帧逐像素差，不是估的）；
 *     · 是否压到站名 / 是否溢出到相邻行。
 *
 * ── 为什么拆成"生成器 + 执行器"两个文件 ────────────────────────────────────
 *   生成器要 `tsx`（React + TSX 才能 renderToStaticMarkup）；执行器是纯 `.mjs`
 *   （playwright-core 是 CJS，用 `createRequire` 更稳）。由执行器 `spawn` 本文件
 *   来生成夹具，**产物写到 os.tmpdir()**，不落在仓库里（`scripts/` 是入库目录，
 *   不能塞构建产物）。
 *
 * 夹具里放**两组同构列表**：
 *   · `#with`：第 2~5 行分别给 ready / stop / approach / moving 四态图标；
 *   · `#none`：完全不给 veh（DOM 与改前逐字节一致的那条路径）⇒ 量「文字起点」的基准。
 *
 * 跑法（一般不直接调，由执行器 spawn）：
 *   npx tsx scripts/lib/gen-stoprow-fixture.tsx <输出 html 路径>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LineStopList from "@/components/line/LineStopList";
import type { LineStopVeh } from "@/components/line/LineStopRow";
import type { LineStop } from "@/lib/line/line-shared";

const stops: LineStop[] = [
  { seq: 1, code: "M95/1", name: "亞馬喇前地", kind: "bus", lat: null, lng: null, mileM: null },
  { seq: 2, code: "M95/2", name: "八角亭", kind: "bus", lat: null, lng: null, mileM: null },
  { seq: 3, code: "M95/3", name: "水坑尾", kind: "bus", lat: null, lng: null, mileM: null },
  { seq: 4, code: "M95/4", name: "塔石", kind: "bus", lat: null, lng: null, mileM: null },
  { seq: 5, code: "M95/5", name: "澳門巴士總站", kind: "bus", lat: null, lng: null, mileM: null },
  { seq: 6, code: "M95/6", name: "關閘", kind: "bus", lat: null, lng: null, mileM: null },
];

/** 第 2~5 行：ready / stop / approach / moving（四态各一行，同行可比） */
const STATES: LineStopVeh["state"][] = ["ready", "stop", "approach", "moving"];

const noop = () => {};
const noLines = new Map<string, string[]>();
const etaOn = () => ({ phase: "on" as const, text: "3 分" });

const withVeh = renderToStaticMarkup(
  React.createElement(LineStopList, {
    stops,
    color: "#C26D32",
    etaOf: etaOn,
    registerEl: noop,
    linesOfStation: noLines,
    lineCode: "26",
    vehOf: (s: LineStop) =>
      s.seq >= 2 && s.seq <= 5 ? { state: STATES[s.seq - 2], frac: 0.5, label: "MX-12-34 · 澳巴 · 还有 3 站" } : null,
    onOpenBusCard: () => {},
  } as never),
);

const noVeh = renderToStaticMarkup(
  React.createElement(LineStopList, {
    stops,
    color: "#C26D32",
    etaOf: etaOn,
    registerEl: noop,
    linesOfStation: noLines,
    lineCode: "26",
  } as never),
);

/**
 * 仓库根：从 cwd 往上找（`scripts/lib/` 距根**两层**，与旧的 `.verify/` **一层**不同
 * ⇒ 直接照搬 `../` 会指向 `scripts/src/...` 而 ENOENT。这是迁移最容易静默坏掉的一处）。
 */
function findRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const cands = [process.cwd(), join(here, "..", "..")];
  for (const c of cands) {
    if (existsSync(join(c, "src/app/globals.css"))) return c;
  }
  throw new Error("找不到仓库根（src/app/globals.css 不存在）。请从仓库根运行。");
}
const ROOT = findRoot();
const CSS = readFileSync(join(ROOT, "src/app/globals.css"), "utf8");
/**
 * ⚠️ 必踩的坑：`globals.css` 的**注释里**写着 `<style>.amap-container{…}</style>`
 * （见 `.nav-map__canvas` 那段实测记录）。内联进 HTML 时，HTML 分词器**只认字符序列**
 * —— 遇到第一个 `</style` 就把样式表截断，剩下 200KB 的 CSS 会被当成 HTML 解析，
 * 于是 DOM 结构离奇错位（实测：`#with` 只剩 3 个 `<li>`、`#none` 被吃进 `#with` 里）。
 * ⇒ 把 `</style` 打断即可（它在 CSS 注释里，加反斜杠不改变注释语义）。
 */
const CSS_SAFE = CSS.replace(/<\/style/gi, "<\\/style");

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<style>${CSS_SAFE}</style>
<style>
  /* 夹具专用：把两段列表并排放，各自固定 375px（iPhone 最小宽），互不影响 */
  html,body{margin:0;padding:0;background:var(--surface)}
  .fx-row{display:flex;align-items:flex-start;gap:0}
  .fx-col{width:375px;flex:none;background:var(--surface)}
  .fx-col h4{margin:0;padding:4px 8px;font:12px/1.4 monospace;color:#555}
  /* 图标层开关：只动 visibility（不参与布局），用于"有图标/无图标"两帧逐像素差 */
  body.hide-veh .lp-stop__veh{visibility:hidden}
</style>
</head>
<body>
<div class="fx-row">
  <div class="fx-col" id="with"><h4>#with（四态图标）</h4><div class="lp-page" data-kind="bus">${withVeh}</div></div>
  <div class="fx-col" id="none"><h4>#none（无图标基准）</h4><div class="lp-page" data-kind="bus">${noVeh}</div></div>
</div>
</body></html>
`;

/**
 * 输出路径由 argv 给（执行器传 os.tmpdir() 下的临时文件）。
 * ⚠️ **不要**写死到脚本同级目录：`scripts/` 是入库目录，产物会被误提交；
 *    而且并发跑两份时会互相踩。
 */
const outPath = process.argv[2];
if (!outPath) {
  console.error("用法：npx tsx scripts/lib/gen-stoprow-fixture.tsx <输出 html 路径>");
  process.exit(2);
}
writeFileSync(outPath, html, "utf8");
console.log(`[gen] 夹具已写入 ${outPath}（${(html.length / 1024).toFixed(1)} KB）`);
