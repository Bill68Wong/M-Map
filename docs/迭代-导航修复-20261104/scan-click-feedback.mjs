/**
 * 点击反馈覆盖扫描（U11 验收工具 · 只读）
 *
 * 用途：找出「声明了 cursor:pointer（= 看起来可点）但没有任何 :active 规则（= 按下去没反馈）」的选择器。
 *      这是 U11「全项目点击体验升级」的**机器可读缺口清单**，不依赖任何主观判断。
 *
 * 用法：node docs/迭代-导航修复-20261104/scan-click-feedback.mjs src/app/globals.css
 * 输出：cursor:pointer 规则数 / :active 覆盖类名 / 缺口选择器清单（含行号）
 *
 * 判定口径（写死，不要放宽）：
 *   · 只看**选择器行**，不看声明行（否则 `transition` 里的 :active 会被误算成覆盖）。
 *   · 缺口 = 该规则的选择器里有 .className，且这些 className 中**没有一个**在 :active 集合里。
 *   · 纯元素选择器（如 `button`）跳过 —— 它们走全局 `button:active` 兜底。
 */
import fs from "node:fs";

const path = process.argv[2] ?? "src/app/globals.css";
const css = fs.readFileSync(path, "utf8").split(/\r?\n/);
const isPtr = (s) => s.replace(/\s+/g, "").includes("cursor:pointer");

/** cursor:pointer 所属规则块的选择器（向上找最近的 `{` 结尾行） */
const ptrs = [];
for (let i = 0; i < css.length; i++) {
  if (!isPtr(css[i])) continue;
  for (let j = i; j >= 0; j--) {
    if (/\{\s*$/.test(css[j])) {
      let sel = css[j].replace(/\{.*$/, "").trim();
      let k = j - 1;
      while (sel === "" && k >= 0) {
        sel = css[k].replace(/\{.*$/, "").trim();
        k--;
      }
      ptrs.push({ line: i + 1, sel });
      break;
    }
  }
}

/** :active 规则里出现的类名 */
const actSel = new Set();
const actLines = [];
for (let i = 0; i < css.length; i++) {
  const t = css[i].trim();
  if (!t || t.startsWith("/*")) continue;
  // 只认选择器行：必须含 `:active` 且不是属性声明（属性声明形如 `foo: bar;`）
  if (!/:active/.test(t) || /;\s*$/.test(t) && !/[{}]/.test(t)) continue;
  actLines.push(`${i + 1}: ${t}`);
  for (const m of t.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
    if (t.slice(m.index).includes(":active")) actSel.add(m[1]);
  }
}

const missing = [];
for (const p of ptrs) {
  const cls = [...p.sel.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
  if (!cls.length) continue;
  if (!cls.some((c) => actSel.has(c))) missing.push(p);
}

console.log(`文件 = ${path}`);
console.log(`cursor:pointer 规则数 = ${ptrs.length}`);
console.log(`含 :active 的选择器行数 = ${actLines.length}`);
console.log(`:active 覆盖的类名 = ${[...actSel].sort().join(", ")}`);
console.log(`\n=== 缺口候选（有 cursor:pointer 但同类名无 :active）: ${missing.length} ===`);
for (const m of missing) console.log(`  L${m.line}  ${m.sel.slice(0, 90)}`);
