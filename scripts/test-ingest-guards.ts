/**
 * 入库护栏常量负向测试（scripts/test-ingest-guards.ts · S-13 · 批 3）
 * 用法：npm run test:ingest-guards    （**不连库**：常量引用生产导出 + 源码结构锁）
 *
 * ── 守的是什么 ────────────────────────────────────────────────────────
 *   「标记」与「排除」是两档不同阈值，极易被后人误改成一档：
 *     · dwell ≥ LONG_STOP_MARK_MIN(3)  ⇒ **只标记**（long_stop 入库列），仍进 ETA 主口径；
 *     · dwell ≥ LONG_STOP_EXCLUDE_MIN(5) ⇒ **才排除**（不进聚合），防司机休息污染段时长。
 *   本测试喂 3.0 / 4.9 / 5.0 / 5.1 四个边界样本，断言「标记数」与「排除数」两档不同。
 *
 *   另外锁：MIN_RUN_SAMPLES(50) 轮级样本下限、HOP_MIN_SAMPLES(5) 细层启用门槛、
 *   RUN_LABEL_SKIP_RE 测试轮跳过、`spanned` 样本**不入库**（arrive_kind='spanned' 行数=0）。
 *
 * ⚠️ 常量值一律 import 生产导出，**禁止在测试里复制字面量再自证**（那等于自己跟自己比）。
 */
import fs from "node:fs";
import path from "node:path";
import {
  LONG_STOP_MARK_MIN,
  LONG_STOP_EXCLUDE_MIN,
  shouldExcludeLongStop,
} from "../src/lib/rebuild/long-stop";
import type { SkipReason } from "../src/lib/rebuild/long-stop";
import { HOP_MIN_SAMPLES } from "../src/lib/nav/progress";
import { MIN_RUN_SAMPLES, RUN_LABEL_SKIP_RE } from "../src/lib/rebuild/segment-samples";

let failed = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failed++;
};
const assertEq = <T,>(got: T, want: T, label: string) =>
  ok(got === want, `${label}（实际 ${String(got)} / 预期 ${String(want)}）`);

// ── ① 常量引用生产导出 ──
console.log("\n① 常量值（引用生产导出，非测试内复制）");
assertEq(LONG_STOP_MARK_MIN, 3, "LONG_STOP_MARK_MIN = 3（只标记档）");
assertEq(LONG_STOP_EXCLUDE_MIN, 5, "LONG_STOP_EXCLUDE_MIN = 5（才排除档）");
assertEq(HOP_MIN_SAMPLES, 5, "HOP_MIN_SAMPLES = 5（细层启用门槛）");
assertEq(MIN_RUN_SAMPLES, 50, "MIN_RUN_SAMPLES = 50（轮级样本下限）");
ok(LONG_STOP_MARK_MIN < LONG_STOP_EXCLUDE_MIN, "标记档 < 排除档（两档不可合并成一档）");

// ── ② long-stop 标记 vs 排除（喂 3.0 / 4.9 / 5.0 / 5.1）──
console.log("\n② long-stop 标记数 vs 排除数（边界四样本 3.0/4.9/5.0/5.1）");
{
  // policy：终点站在总站集合内（M9），无 skipPairs ⇒ shouldExcludeLongStop 的 dwell 门槛是唯一变量
  const policy = { terminus: new Set(["M9"]), skipPairs: new Map<string, SkipReason>() };
  const dwells = [3.0, 4.9, 5.0, 5.1];
  const marked = dwells.filter((d) => d >= LONG_STOP_MARK_MIN).length;
  const excluded = dwells.filter((d) => shouldExcludeLongStop("59", "M9", d, policy)).length;
  assertEq(marked, 4, "标记数 = 4（≥3 分全部标记）");
  assertEq(excluded, 2, "排除数 = 2（只有 ≥5 分的 5.0/5.1 被排除）");
  ok(!shouldExcludeLongStop("59", "M9", 3.0, policy), "3.0 分：标记但不排除");
  ok(!shouldExcludeLongStop("59", "M9", 4.9, policy), "4.9 分：标记但不排除（边界下沿）");
  ok(shouldExcludeLongStop("59", "M9", 5.0, policy), "5.0 分：排除（边界上沿，含等号）");
  ok(shouldExcludeLongStop("59", "M9", 5.1, policy), "5.1 分：排除");
  ok(!shouldExcludeLongStop("59", "NOT_A_TERMINUS", 9.0, policy), "非总站站点：即使 9 分也不排除（判据含终点站∈总站）");
}

// ── ③ RUN_LABEL_SKIP_RE（1 正 1 反）──
console.log("\n③ RUN_LABEL_SKIP_RE（测试轮跳过）");
ok(RUN_LABEL_SKIP_RE.test("selftest-20261109"), "selftest 标签命中（跳过）");
ok(!RUN_LABEL_SKIP_RE.test("20261109-120000"), "正常时间戳标签不命中（保留）");

// ── ④ spanned 不入库（源码断言 + 夹具自证，不连库）──
console.log("\n④ spanned 样本不入库");
{
  // 4a 源码断言：segment-samples.ts 的**代码**（去注释）不引用 rawSpannedSamples
  const segSrc = fs.readFileSync(path.resolve(process.cwd(), "src/lib/rebuild/segment-samples.ts"), "utf8");
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const code = stripComments(segSrc);
  ok(!code.includes("rawSpannedSamples"), "源码断言：segment-samples.ts 代码级不引用 rawSpannedSamples（入库路径只取 depart+terminal）");
  // 4b 源码结构锁（批 4 / T4：替换原三条**同义反复**断言）
  //   原写法（已删）的致命之处：`rows` 由测试自己用 depart+terminal 手工拼出 ⇒ `spannedRows` 必为 0；
  //   `rawSpannedSamples.length` 是测试自己刚塞进去的 2 ⇒ 三条都不可能失败，纯自证。
  //   换成：从 `readTrackFile` 里抽出 `const raw = [ … ];` 代码块，断言块内引用的 `raw*Samples`
  //   标识符集合**恰好等于** {rawDepartSamples, rawTerminalSamples}。
  //   可红点：有人往数组里加 `...j.rawSpannedSamples`（或任何第三个 raw*Samples）⇒ 集合变大 ⇒ 红。
  //   ⚠️ 不许为测试给 `readTrackFile` 加 export（生产代码不为测试开口子）⇒ 只能做源码结构锁。
  {
    // ★ 批 4 / T4：**按内容定位，绝不按行号切片**。行号会随 prettier / 本文件的改动漂移；
    //   更坏的是：若切到不含目标块的区间，标识符集合会变空 —— 而「空集不含额外项」照样绿，
    //   等于又种一条死判据（与 test-limits 的 P3 同类）。故分母断言（定位成功且非空）单独成一条。
    const m = /const raw = \[([\s\S]*?)\n  \];/.exec(code);
    const inner = m?.[1] ?? "";
    const at = code.indexOf("const raw");
    ok(
      m !== null && inner.trim().length > 0,
      "4b 分母：readTrackFile 的 `const raw = [ … ];` 块定位成功且非空（定位不到 ⇒ 下面的集合锁不可信）",
      m
        ? `${inner.trim().length} 字符`
        : `未定位到；实际片段：${code.slice(Math.max(at, 0), Math.max(at, 0) + 160).replace(/\n/g, "⏎")}`,
    );
    const ids = [...new Set(inner.match(/raw\w*Samples/g) ?? [])].sort();
    assertEq(
      ids.join(","),
      "rawDepartSamples,rawTerminalSamples",
      "4b 入库数组内 raw*Samples 标识符恰为 {depart,terminal}（spanned 等第三个数组不得混入）",
    );
  }
}

console.log(failed ? `\n❌ ${failed} 条断言失败` : `\n✅ 全部断言通过（六常量负向：标记≠排除 / 门槛 / 跳过 / spanned 不入库）`);
if (failed) process.exitCode = 1;
