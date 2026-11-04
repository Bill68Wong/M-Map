/**
 * 缺口元素的渲染标签判定（U11 验收工具 · 只读）— v2
 *
 * v1 缺陷：只取 `git grep` 命中的**同一行**找 `<tag`，而本项目 JSX 属性大量多行书写
 *   （`className` 独占一行）⇒ 34/45 被判成「需人工确认」，结论不可用。
 * v2 修正：定位 file:line 后，**向上回溯**到最近的未闭合 `<`，取其标签名。
 *
 * 判定口径：若元素是 `<button>` 会继承全局 `button:active` 兜底（有反馈）；
 *   `<a>/<div>/<span>/<summary>/<label>/<li>` 则完全无按压反馈（真缺口）。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

const css = fs.readFileSync("src/app/globals.css", "utf8").split(/\r?\n/);
const isPtr = (s) => s.replace(/\s+/g, "").includes("cursor:pointer");

const ptrs = [];
for (let i = 0; i < css.length; i++) {
  if (!isPtr(css[i])) continue;
  for (let j = i; j >= 0; j--) {
    if (/\{\s*$/.test(css[j])) {
      let sel = css[j].replace(/\{.*$/, "").trim();
      let k = j - 1;
      while (sel === "" && k >= 0) { sel = css[k].replace(/\{.*$/, "").trim(); k--; }
      ptrs.push(sel);
      break;
    }
  }
}
const actSel = new Set();
for (const raw of css) {
  const t = raw.trim();
  if (!t || t.startsWith("/*") || !/:active/.test(t)) continue;
  if (/;\s*$/.test(t) && !/[{}]/.test(t)) continue;
  for (const m of t.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
    if (t.slice(m.index).includes(":active")) actSel.add(m[1]);
  }
}
const gapCls = [];
for (const sel of ptrs) {
  const cls = [...sel.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
  if (!cls.length) continue;
  if (!cls.some((c) => actSel.has(c))) gapCls.push(cls[0]);
}

const fileCache = new Map();
function readFile(f) {
  if (!fileCache.has(f)) fileCache.set(f, fs.readFileSync(f, "utf8").split(/\r?\n/));
  return fileCache.get(f);
}

/** 在 file:line 处向上回溯找最近的未闭合 `<`，返回标签名 */
function tagAt(file, line) {
  const lines = readFile(file);
  let depth = 0;
  for (let i = line - 1; i >= 0 && i > line - 40; i--) {
    const s = lines[i];
    // 从右向左扫描，追踪标签嵌套
    for (let p = s.length - 1; p >= 0; p--) {
      if (s[p] === ">") depth++;
      else if (s[p] === "<") {
        if (depth === 0) {
          const m = s.slice(p).match(/^<([a-zA-Z][a-zA-Z0-9.]*)/);
          if (m) return m[1];
        } else depth--;
      }
    }
  }
  return "?";
}

const rows = gapCls.map((cls) => {
  let loc = "";
  try {
    loc = execSync(`git grep -n "className=[\\"'][^\\"']*${cls}" -- src`, { encoding: "utf8" })
      .split(/\r?\n/).filter(Boolean)[0] ?? "";
  } catch { /* 无命中 */ }
  if (!loc) return { cls, tag: "（JSX 未直接命中：可能为动态拼接类名）" };
  const m = loc.match(/^([^:]+):(\d+):/);
  if (!m) return { cls, tag: "?" };
  return { cls, tag: tagAt(m[1], Number(m[2])), file: m[1], line: Number(m[2]) };
});

const BARE = new Set(["a", "div", "span", "summary", "label", "li", "p"]);
const bare = rows.filter((r) => BARE.has(r.tag));
const btn = rows.filter((r) => r.tag === "button");
const other = rows.filter((r) => !BARE.has(r.tag) && r.tag !== "button");

console.log(`缺口选择器 ${rows.length} 个\n`);
console.log(`=== 真缺口（无全局 button 兜底）: ${bare.length} ===`);
for (const r of bare) console.log(`  <${r.tag}> .${r.cls}   ${r.file ?? ""}:${r.line ?? ""}`);
console.log(`\n=== 有 <button> 兜底（已有反馈）: ${btn.length} ===`);
for (const r of btn) console.log(`  .${r.cls}`);
if (other.length) {
  console.log(`\n=== 需人工确认: ${other.length} ===`);
  for (const r of other) console.log(`  <${r.tag}> .${r.cls}   ${r.file ?? ""}:${r.line ?? ""}`);
}
