/**
 * 容差门禁（scripts/test-tolerance-guard.ts，批 1 · 静态元断言，v4.1.2）
 * 用法：npm run test:tolerance-guard     （纯静态：只读源码文本，不连库、不 import 生产模块、不跑被测脚本）
 *
 * ── 为什么需要它（负责人 2026-11-09 裁定）────────────────────────────
 *   `scripts/test-eta-basis.ts` 的 `near(a, b, tol) = |实跑值 − 目标值| <= tol`。
 *   实跑值本就等于真值 ⇒「放宽容差」只会让判据更松、**永远不会**让被测脚本变红
 *   （批 1 造错 C 组实测：只把 ④ 容差 0.06→2.0，test:eta-basis 仍 exit=0）。
 *   要守的命题是「容差有没有被偷偷放大 / 有没有被变量绕开」——
 *   这只能由检查**测试文件自身**的静态元断言来守（G10 / 铁律 52）。
 *
 * ── 判据（三条）────────────────────────────────────────────────────
 *   R1  `near(a, b, tol)` 的第三实参必须是**数字字面量**：禁变量 / 表达式 / 常量引用
 *       （堵 `const TOL = 2.0` 再 `near(x, y, TOL)` 的绕过）。
 *   R2  `tol <= 0.06` ⇒ 放行（收紧天然安全，不需要登记）。
 *   R3  `tol > 0.06` ⇒ 必须命中本脚本 `TOL_EXCEPTIONS` 登记表（每项含 行锚 + 目标值 + 理由）；
 *       且**表项数必须等于实测命中数**（分母守恒，铁律 44c）——删/漏登记 ⇒ 必红。
 *
 * ── 已知坑（QA 纠偏，务必保持）──────────────────────────────────────
 *   · 容差实为**两种、共 15 处调用**：`0.06 × 13` + `1 × 2`（⑧ :157 etaSec48、⑨ :171
 *     etaSec198，**秒级**容差）。15 处实读明细见脚本运行时打印（勿沿用任何转述数字）。
 *     （26A 断言行原 ±0.15 已于本批收紧到 ±0.06，理由见 test-eta-basis.ts 该断言行上方注释。）
 *   · `:165` **一行内两次 `near()`**（hopMin[0] 与 [1]）⇒ 正则必须 `g` 全局匹配，
 *     否则会数成 14、分母错 1。
 *   · 「行锚」只作诊断打印；实际匹配用 `目标值@容差`（行号会随文件改动漂移，
 *     用行号做匹配键会假红）。行号不一致只 WARN，不 fail。
 *   · 参照：铁律 53「名字对值错」——若将来要校验断言文案里的「±0.06」与实参一致，
 *     在本脚本追加 R4（本批暂不做，避免文案解析引入误判）。
 */
import fs from "node:fs";
import path from "node:path";

/** 被测文件（相对 cwd）。R1 只扫此文件——勿顺手扩大到其它 near() 实现。 */
const TARGET_REL = "scripts/test-eta-basis.ts";
/** 容差硬上限：<= 此值放行（分钟口径的最小严格容差）。 */
const TOL_LIMIT = 0.06;

interface TolException {
  /** 当前实测行号（仅诊断打印，不参与匹配，防文件改动后假红） */
  line: number;
  /** `near(a, b, value, tol)` 里的目标值 b */
  value: number;
  /** `near(a, b, value, tol)` 里的容差 tol */
  tol: number;
  reason: string;
}

/** `tol > 0.06` 的合法例外（当前 2 项，与实测命中数必须相等）。
 *  只剩 etaSec 两处**秒级**容差：秒 = 分钟 × 60 取整的结果，1 秒 ≈ 0.0167 分，
 *  物理上不可与 0.06 分钟的分钟口径容差比较，故登记为合法例外。 */
const TOL_EXCEPTIONS: TolException[] = [
  { line: 161, value: 48, tol: 1, reason: "⑧ etaSec 48 @1 —— 秒级容差（0.8 分×60，分钟→秒取整；1 秒≈0.017 分）" },
  { line: 175, value: 198, tol: 1, reason: "⑨ etaSec 198 @1 —— 秒级容差（3.3 分×60，分钟→秒取整；1 秒≈0.017 分）" },
];

interface NearCall {
  line: number;
  value: number;
  tol: number;
  tolRaw: string;
}

let failed = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failed++;
};

/** 解析 near(a, b, tol)：第三实参捕获为原文（用于 R1 判断是否纯数字字面量）。 */
function parseNearCalls(src: string): NearCall[] {
  const calls: NearCall[] = [];
  // 参数内不含逗号/括号（现有 15 处均为 标识符 / 数字 / a.hopMin[0]! 形态），
  // g 全局匹配必不可少：:165 一行两次 near()，非全局会漏 1 处 → 分母 14 错。
  const re = /\bnear\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/g;
  src.split("\n").forEach((rawLine, idx) => {
    const line = rawLine.replace(/\/\/.*$/, ""); // 去行尾注释，避免注释里的 near( 误匹配
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const tolRaw = m[3].trim();
      calls.push({ line: idx + 1, value: Number(m[2].trim()), tol: Number(tolRaw), tolRaw });
    }
  });
  return calls;
}

function main() {
  const target = path.resolve(process.cwd(), TARGET_REL);
  if (!fs.existsSync(target)) {
    console.error(`❌ 找不到被测文件：${target}`);
    process.exitCode = 1;
    return;
  }
  const calls = parseNearCalls(fs.readFileSync(target, "utf8"));

  console.log(`\n容差门禁（${TARGET_REL} 静态元断言）`);
  console.log(`  实测 near() 调用：${calls.length} 处`);

  // ── R1：第三实参必须是数字字面量 ──
  const NUMBER_LITERAL = /^-?\d+(\.\d+)?$/;
  const r1Bad = calls.filter((c) => !NUMBER_LITERAL.test(c.tolRaw));
  ok(
    r1Bad.length === 0,
    `R1 全部第三实参为数字字面量（禁变量/表达式/常量引用）`,
    r1Bad.length ? `违规：${r1Bad.map((c) => `:${c.line} "${c.tolRaw}"`).join(" / ")}` : "",
  );

  // ── R2 / R3 分流 ──
  const le = calls.filter((c) => Number.isFinite(c.tol) && c.tol <= TOL_LIMIT);
  const gt = calls.filter((c) => Number.isFinite(c.tol) && c.tol > TOL_LIMIT);

  // ★ 批 4 / T1：原写法 `ok(le.length >= 0, ...)` 恒真（数组长度不可能为负）⇒ 永不失败。
  //   换成**分流完备 + 分母>0 绑成一条**：
  //     ① 分母 `calls.length > 0`：解析器一旦坏掉、一处都解析不出来，完备性会退化成 `0+0===0`
  //        照样绿 —— 那就是把恒真假判据换个地方复发。（R3-b 的 `2 === 0` 能顺手兜住，但那是巧合重叠，不是设计。）
  //     ② 完备 `le + gt === calls.length`：两条 filter 必须恰好覆盖全部调用，无遗漏无重复。
  //   可红点：某条 near() 的第三实参解析成 NaN 时（如写成 `near(a, 48, NaN)`），
  //   le / gt 都因 `Number.isFinite(NaN)` 为假而漏掉它 ⇒ 和 < 总数 ⇒ 红。
  ok(
    calls.length > 0 && le.length + gt.length === calls.length,
    `R2/R3 分流完备：near() 调用数 > 0 且 le+gt === 调用总数`,
    `${calls.length} 处；${le.length}+${gt.length}（R2 放行 ${le.length} / R3 例外 ${gt.length}）`,
  );

  // R3-1：每条 >0.06 必须命中例外表（按 目标值@容差 匹配）
  const exKey = (v: number, t: number) => `${v}@${t}`;
  const exKeys = new Set(TOL_EXCEPTIONS.map((e) => exKey(e.value, e.tol)));
  const unmatched = gt.filter((c) => !exKeys.has(exKey(c.value, c.tol)));
  ok(
    unmatched.length === 0,
    `R3-a 每条 tol>${TOL_LIMIT} 都命中 TOL_EXCEPTIONS`,
    unmatched.length ? `未登记：${unmatched.map((c) => `:${c.line} ${c.value}@${c.tol}`).join(" / ")}` : "",
  );

  // R3-2：分母守恒——表项数 == 实测命中数（删/漏登记 ⇒ 红）
  ok(
    TOL_EXCEPTIONS.length === gt.length,
    `R3-b 分母守恒：登记例外 ${TOL_EXCEPTIONS.length} === 实测命中 ${gt.length}`,
  );

  // R3-3：反向——登记表里的每一项都应真的存在于源码（防登记项凭空多出 / 值写错）
  const callKeys = new Set(gt.map((c) => exKey(c.value, c.tol)));
  const stale = TOL_EXCEPTIONS.filter((e) => !callKeys.has(exKey(e.value, e.tol)));
  ok(
    stale.length === 0,
    `R3-c 登记项在源码中真实存在（无凭空/写错）`,
    stale.length ? `多余：${stale.map((e) => `${e.value}@${e.tol}`).join(" / ")}` : "",
  );

  // 行锚诊断（不 fail）：登记行号 vs 实测最近行号
  for (const e of TOL_EXCEPTIONS) {
    const hit = gt.find((c) => exKey(c.value, c.tol) === exKey(e.value, e.tol));
    if (hit && hit.line !== e.line) {
      console.log(`  ℹ️ 行锚漂移（仅诊断，不影响判据）：${e.value}@${e.tol} 登记 :${e.line} 实测 :${hit.line}`);
    }
  }

  // ── 关键分母打印（派工要求的固定文案）──
  console.log(
    `\n  分母：实测命中 ${calls.length} 处 / 登记例外 ${TOL_EXCEPTIONS.length} 条 / 其余 ${le.length} 条 <= ${TOL_LIMIT}`,
  );
  for (const e of TOL_EXCEPTIONS) console.log(`    例外 ${e.value}@${e.tol}（:${e.line}）：${e.reason}`);

  console.log(
    failed
      ? `\n❌ ${failed} 条断言失败`
      : `\n✅ 全部断言通过（容差未被放大：${calls.length} 处 / ${TOL_EXCEPTIONS.length} 例外 / ${le.length} 条 ≤${TOL_LIMIT}）`,
  );
  if (failed) process.exitCode = 1;
}

main();
