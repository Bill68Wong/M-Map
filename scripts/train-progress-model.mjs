/**
 * 进度模型参数训练（scripts/train-progress-model.mjs）
 * 用法：node scripts/train-progress-model.mjs
 *
 * 从全部区间段样本（data/tracking/analysis-20260927/progress/segments-*.jsonl）学习
 * 「剩余时间比例 h(剩余路程比例)」经验曲线（4 类段型 × 20 桶，PAVA 单调化），
 * 输出到 src/lib/nav/progress-params.ts（随代码部署）。
 *
 * 段型（与服务端 progressTypeOf 同口径）：
 *   short（<1km）· mid（1-2.5km）· long_fast（≥2.5km 且中位速度≥25km/h）· long_slow（其余长段）
 * 融合权重 W（批判自审⑩a 实测标定）：short 0.6 · mid 0.5 · long 0.15
 */
import fs from "node:fs";
import path from "node:path";

// ★ 2026-11-12 修：原硬编码作者机绝对路径（DIR/OUT 均指向仓库内 data/ 与 src/）。
const ROOT = process.cwd();
const DIR = path.join(ROOT, "data/tracking/analysis-20260927/progress");
const OUT = path.join(ROOT, "src/lib/nav/progress-params.ts");

const files = fs.readdirSync(DIR).filter((f) => f.startsWith("segments-") && f.endsWith(".jsonl"));
let raw = [];
for (const f of files) for (const line of fs.readFileSync(path.join(DIR, f), "utf8").split("\n")) if (line) raw.push(JSON.parse(line));
const segs = raw.filter((s) => {
  if (!s.pts || s.pts.length < 2) return false;
  if ((s.pts[s.pts.length - 1].p - s.pts[0].p) < 0.15) return false;
  return (s.segLenM * 3.6) / s.segSec <= 80;
});
console.log(`段样本：${raw.length} → 过滤后 ${segs.length}（${files.length} 场）`);

const median = (v) => { const a = [...v].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
const mdByKey = new Map();
for (const s of segs) { const k = `${s.route}|${s.segKey}`; if (!mdByKey.has(k)) mdByKey.set(k, []); mdByKey.get(k).push(s.segSec); }
const mdOf = new Map(); for (const [k, v] of mdByKey) mdOf.set(k, median(v));

const typeOf = (s) => {
  if (s.segLenM < 1000) return "short";
  if (s.segLenM < 2500) return "mid";
  const md = mdOf.get(`${s.route}|${s.segKey}`) ?? s.segSec;
  return (s.segLenM * 3.6) / md >= 25 ? "long_fast" : "long_slow";
};

const NB = 20;
function pava(y) {
  const v = [...y], w = new Array(y.length).fill(1);
  const stack = [];
  for (let i = 0; i < v.length; i++) {
    let cv = v[i], cw = w[i];
    while (stack.length && stack[stack.length - 1].v > cv) {
      const top = stack.pop();
      cv = (top.v * top.w + cv * cw) / (top.w + cw);
      cw = top.w + cw;
    }
    stack.push({ v: cv, w: cw });
  }
  const out = [];
  for (const { v: cv, w: cw } of stack) for (let i = 0; i < cw; i++) out.push(cv);
  return out;
}

const TYPES = ["short", "mid", "long_fast", "long_slow"];
const hOf = {};
const counts = {};
for (const t of TYPES) {
  const list = segs.filter((s) => typeOf(s) === t);
  counts[t] = { segs: list.length, pts: list.reduce((a, s) => a + s.pts.length, 0) };
  const buckets = Array.from({ length: NB }, () => []);
  for (const s of list) for (const pt of s.pts) {
    const b = Math.min(NB - 1, Math.max(0, Math.floor((1 - pt.p) * NB)));
    buckets[b].push(pt.remainSec / s.segSec);
  }
  let curve = buckets.map((v) => (v.length >= 10 ? median(v) : null));
  for (let i = 0; i < NB; i++) if (curve[i] === null) { const p = [...curve.slice(0, i)].reverse().find((x) => x !== null); const n = curve.slice(i + 1).find((x) => x !== null); curve[i] = p ?? n ?? 1; }
  curve = pava(curve);
  hOf[t] = curve.map((x) => Math.round(x * 1000) / 1000);
  console.log(`  ${t.padEnd(10)} 段=${String(counts[t].segs).padStart(6)} 点=${String(counts[t].pts).padStart(7)}`);
}

const ts = `/**
 * 进度模型部署参数（★ 自动生成，勿手改 —— scripts/train-progress-model.mjs）
 *
 * 生成：${new Date().toISOString()}
 * 数据：${files.length} 场采集 · 过滤后 ${segs.length} 段（原始 ${raw.length}）
 * 曲线：h[段型][剩余路程比 1−p 的 20 桶] = 剩余时间比例中位数（PAVA 单调化）
 * 依据：docs/区间进度模型-调研报告-20260927.md（§4 模型设计 · §8 批判自审）
 */
export type ProgressSegType = "short" | "mid" | "long_fast" | "long_slow";

/** 段型判定（服务端与训练同口径）：长度 + 中位速度 */
export function progressTypeOf(segLenM: number, mdSec: number): ProgressSegType {
  if (segLenM < 1000) return "short";
  if (segLenM < 2500) return "mid";
  return (segLenM * 3.6) / Math.max(1, mdSec) >= 25 ? "long_fast" : "long_slow";
}

/** 融合权重 w（pred = w·D + (1−w)·B）——批判自审⑩a 实测标定 */
export const PROGRESS_W: Record<ProgressSegType, number> = {
  short: 0.6,
  mid: 0.5,
  long_fast: 0.15,
  long_slow: 0.15,
};

/** 训练统计（诊断用） */
export const PROGRESS_META = {
  generatedAt: ${JSON.stringify(new Date().toISOString())},
  sessions: ${files.length},
  segs: ${segs.length},
  counts: ${JSON.stringify(counts)},
} as const;

/** h 曲线（剩余时间比例，桶 i = 剩余路程比 [i/20, (i+1)/20)） */
export const PROGRESS_H: Record<ProgressSegType, number[]> = {
${TYPES.map((t) => `  ${t}: [${hOf[t].join(", ")}],`).join("\n")}
};
`;

fs.writeFileSync(OUT, ts, "utf8");
// 回读复核（项目铁律：写完必须回读）
const check = fs.readFileSync(OUT, "utf8");
console.log(`\n✅ 已写入 ${OUT}（${check.length} 字节）· 回读 ${check.length === ts.length ? "一致" : "不一致 ✗"}`);
