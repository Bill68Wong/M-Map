/**
 * 轮级质量闸 · 纯函数负向验收（scripts/test-run-gate.ts，批 1 · U-01 / v4.1.2）
 * 用法：npm run test:run-gate     （不连库、不读 data/tracking、夹具全部内联）
 *
 * ── 为什么必须是「纯函数 + 内联夹具」的测试 ────────────────────────────
 *   `importSegmentSamples` 即使 dry-run 仍会 pool.query（src/lib/rebuild/segment-samples.ts
 *   :250/:575/:590），拿它做验收会连库；而 data/tracking/*-derived.json 被 .gitignore 排除，
 *   夹具一旦依赖真实采集文件，换台机器/清库后测试会静默空跑 ⇒ 假绿。
 *   故这里**只 import 纯函数**（gateRun / normalizeRunMeta / readRunMeta）与生产导出的
 *   常量（RUN_LABEL_SKIP_RE / MIN_RUN_SAMPLES / RUN_GATE_MIN_SCHEMA），夹具全部内联。
 *
 * ── 断言（QA ⑩ 六要素，与 v2 UA 系列对齐）────────────────────────────
 *   ① 放行数为 0：aborted 新轮 gateRun(...).pass 必须为 false，且「被放行的 aborted 轮数 === 0」。
 *   ② 分母断言：参与判据的轮数 === FIXTURES.length（夹具被塞空 / 静默跳过 ⇒ 立刻变红）。
 *   ③ 透传链三段：derived.runMeta →(normalizeRunMeta)→ RunMeta →(gateRun)→ GateResult.reason，
 *      逐段断言，且断言 schemaVersion>=RUN_GATE_MIN_SCHEMA 的开关本身生效。
 *   ④ 夹具：normal / aborted / 短轮 / no-meta / 存量轮 / test-label（后两组为互补，
 *      前三组为负责人指定核心三夹具）。全部内联，不依赖任何被 gitignore 的文件。
 *   ⑤ 红→绿两轮：由落地验收阶段「短路 gateRun 的 aborted 分支」「塞空 FIXTURES」两次
 *      造错各跑一轮（红），恢复后再跑一轮（绿）——见落地报告，不在脚本内自证。
 *   ⑥ 常量引用生产导出而非测试里写死（防硬编码）：RUN_LABEL_SKIP_RE / MIN_RUN_SAMPLES /
 *      RUN_GATE_MIN_SCHEMA 全部 import 自 src/lib/rebuild/segment-samples.ts。
 *
 * ★ 分歧② 裁定 (a)：闸仅对 schemaVersion>=2 的新轮生效，存量轮维持现状。
 *   ⇒ 存量轮（schemaVersion=null）即使 fallbackMeta.aborted 非 null 也必须放行。
 * ★ meta==null / metaAvailable=false 放行 + unknownMeta=true + WARN（不 fail-closed）。
 * ★ 只过滤导入、不删库内既有行、不重建派生表（G13 硬护栏）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  gateRun,
  normalizeRunMeta,
  readRunMeta,
  RUN_LABEL_SKIP_RE,
  MIN_RUN_SAMPLES,
  RUN_GATE_MIN_SCHEMA,
} from "../src/lib/rebuild/segment-samples";
import type { RunMeta, GateResult } from "../src/lib/rebuild/segment-samples";

let failed = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failed++;
};

const meta = (over: Partial<RunMeta> = {}): RunMeta => ({
  aborted: null,
  metaAvailable: true,
  durationMin: 30,
  rounds: 360,
  plannedMinutes: 30,
  ...over,
});

interface Case {
  name: string;
  b: { label: string; rows: number; schemaVersion: number | null; runMeta: RunMeta | null };
  fallbackMeta: RunMeta | null;
  pass: boolean;
  reasonHas?: string;
  unknownMeta?: boolean;
}

// 四+二组内嵌夹具：normal / aborted / 短轮 为核心三夹具；no-meta / 存量轮 / test-label 互补。
const FIXTURES: Case[] = [
  {
    name: "normal（正常新轮，跑满窗口）",
    b: { label: "20261109-120000", rows: 600, schemaVersion: 2, runMeta: meta() },
    fallbackMeta: null,
    pass: true,
  },
  {
    name: "aborted（新轮中止：硬熔断）",
    b: { label: "20261109-130000", rows: 600, schemaVersion: 2, runMeta: meta({ aborted: "hard-breaker" }) },
    fallbackMeta: null,
    pass: false,
    reasonHas: "aborted:",
  },
  {
    name: "短轮（rows < MIN_RUN_SAMPLES，既有闸对所有轮生效）",
    b: { label: "20261109-140000", rows: MIN_RUN_SAMPLES - 1, schemaVersion: 2, runMeta: meta() },
    fallbackMeta: null,
    pass: false,
    reasonHas: String(MIN_RUN_SAMPLES),
  },
  {
    name: "no-meta（新轮读不到 runMeta/meta ⇒ 放行 + 计数，不 fail-closed）",
    b: { label: "20261109-150000", rows: 600, schemaVersion: 2, runMeta: null },
    fallbackMeta: null,
    pass: true,
    unknownMeta: true,
  },
  {
    name: "存量轮（schemaVersion=null + meta.aborted ⇒ 维持现状、放行）",
    b: { label: "20260914-093900", rows: 3176, schemaVersion: null, runMeta: null },
    fallbackMeta: meta({ aborted: "hard-breaker" }),
    pass: true,
  },
  {
    name: "test-label（命中 RUN_LABEL_SKIP_RE，既有闸对所有轮生效）",
    b: { label: "selftest-run-gate", rows: 600, schemaVersion: 2, runMeta: meta() },
    fallbackMeta: null,
    pass: false,
    reasonHas: "run_label",
  },
];

function run() {
  console.log("\n① + ② 分母断言 + 逐夹具 gateRun 判据");
  ok(FIXTURES.length === 6, `夹具分母 = 6（防塞空 / 静默跳过）`, `实际 ${FIXTURES.length}`);
  const results: { c: Case; g: GateResult }[] = [];
  for (const c of FIXTURES) {
    const g = gateRun(c.b, c.fallbackMeta);
    results.push({ c, g });
    const reasonOk = c.reasonHas ? g.reason.includes(c.reasonHas) : true;
    const unknownOk = c.unknownMeta === undefined ? true : g.unknownMeta === c.unknownMeta;
    ok(
      g.pass === c.pass && reasonOk && unknownOk,
      `${c.name} ⇒ pass=${g.pass}${c.reasonHas ? ` / reason⊇"${c.reasonHas}"` : ""}${c.unknownMeta ? ` / unknownMeta=${g.unknownMeta}` : ""}`,
      `reason=${g.reason || "（空）"}`,
    );
  }
  // ★ 批 4 / T3：原写法 `results.length === FIXTURES.length` 恒真（:114-116 无条件 push
  //   每条夹具一次）⇒ 永不失败。换成**判据有区分力**：结果里必须同时存在 pass=true 与
  //   pass=false —— 若 gateRun 退化成恒放行（或恒拒绝），这条立刻红。
  ok(
    new Set(results.map((r) => r.g.pass)).size === 2,
    `判据有区分力：结果中同时存在 pass=true 与 pass=false（实际 ${JSON.stringify([
      results.filter((r) => r.g.pass).length,
      results.filter((r) => !r.g.pass).length,
    ])}（放行/拒绝））`,
  );
  // 夹具名唯一：防两条同名夹具互相顶替（同名会让上面「有区分力」在少测一档时仍然成立）
  ok(
    new Set(results.map((r) => r.c.name)).size === FIXTURES.length,
    `夹具名唯一（防同名互相顶替；实际 ${new Set(results.map((r) => r.c.name)).size}/${FIXTURES.length}）`,
  );

  console.log("\n③ 放行数为 0（核心负向）：aborted 新轮不得有一个被放行");
  const abortedPassed = results.filter(
    (r) => r.c.b.runMeta?.aborted && r.c.b.schemaVersion !== null && r.c.b.schemaVersion >= RUN_GATE_MIN_SCHEMA && r.g.pass,
  );
  ok(abortedPassed.length === 0, `被放行的 aborted 新轮数 === 0`, `实际 ${abortedPassed.length}`);
  const rejectedAborted = results.filter((r) => r.g.reason.startsWith("aborted:"));
  ok(rejectedAborted.length === 1, `被拒且可归因 "aborted:" 的轮数 === 1`, `实际 ${rejectedAborted.length}`);

  console.log("\n④ 透传链三段：derived 顶层 → normalizeRunMeta → gateRun → reason");
  // 段 1：模拟 track-derive.mjs 写入 derived.json 顶层的 runMeta（含脏字段）
  const rawDerivedTop = {
    aborted: "signal:SIGINT",
    metaAvailable: true,
    durationMin: 4.2,
    rounds: "48",
    plannedMinutes: "not-a-number",
  };
  const n1 = normalizeRunMeta(rawDerivedTop);
  ok(n1 !== null, `段1a normalizeRunMeta 产出非 null`);
  ok(n1?.aborted === "signal:SIGINT", `段1b aborted 原样透传`, `实际 ${n1?.aborted}`);
  ok(n1?.rounds === 48, `段1c 数字字符串归一为 number`, `实际 ${n1?.rounds}`);
  ok(n1?.plannedMinutes === null, `段1d 脏字段退回 null（不抛、不 NaN）`, `实际 ${n1?.plannedMinutes}`);
  ok(normalizeRunMeta(undefined) === null && normalizeRunMeta(42) === null, `段1e 非对象 / undefined ⇒ null`);
  // 段 2：schemaVersion 开关本身生效（>=2 才启用 aborted 判据）
  const abortedMeta = meta({ aborted: "hard-breaker" });
  const gNew = gateRun({ label: "20261109-160000", rows: 600, schemaVersion: RUN_GATE_MIN_SCHEMA, runMeta: abortedMeta }, null);
  const gOld = gateRun({ label: "20260914-093900", rows: 600, schemaVersion: null, runMeta: abortedMeta }, null);
  ok(gNew.pass === false, `段2a schemaVersion>=${RUN_GATE_MIN_SCHEMA} ⇒ aborted 判据启用（拒）`, `pass=${gNew.pass}`);
  ok(gOld.pass === true, `段2b 存量轮 schemaVersion=null ⇒ 维持现状（放行）`, `pass=${gOld.pass}`);
  // 段 3：reason 可归因、unknownMeta 分流正确
  ok(gNew.reason.startsWith("aborted:") && !gNew.unknownMeta, `段3a 拒绝可归因且不误报 unknownMeta`, `reason=${gNew.reason}`);
  const gUnknown = gateRun({ label: "20261109-170000", rows: 600, schemaVersion: 2, runMeta: null }, null);
  ok(gUnknown.pass && gUnknown.unknownMeta, `段3b meta==null ⇒ 放行 + unknownMeta=true（不 fail-closed）`);
  const gNotAvail = gateRun(
    { label: "20261109-180000", rows: 600, schemaVersion: 2, runMeta: meta({ metaAvailable: false }) },
    null,
  );
  ok(gNotAvail.pass && gNotAvail.unknownMeta, `段3c metaAvailable=false ⇒ 放行 + unknownMeta=true`);

  console.log("\n⑤ 常量引用生产导出（防硬编码）+ 既有两闸对所有轮生效");
  ok(RUN_LABEL_SKIP_RE.test("smoke-abc") && !RUN_LABEL_SKIP_RE.test("20261109-120000"), `RUN_LABEL_SKIP_RE 语义`, `${RUN_LABEL_SKIP_RE}`);
  ok(MIN_RUN_SAMPLES === 50, `MIN_RUN_SAMPLES 由生产导出（=50）`, `实际 ${MIN_RUN_SAMPLES}`);
  ok(RUN_GATE_MIN_SCHEMA === 2, `RUN_GATE_MIN_SCHEMA 由生产导出（=2）`, `实际 ${RUN_GATE_MIN_SCHEMA}`);
  const gShortOld = gateRun({ label: "20260914-093900", rows: 1, schemaVersion: null, runMeta: null }, null);
  ok(gShortOld.pass === false && gShortOld.reason.includes(String(MIN_RUN_SAMPLES)), `存量轮也受 MIN_RUN_SAMPLES 既有闸约束（行为不变）`);

  console.log("\n⑥ readRunMeta 回查：meta 存在 / 不存在 两分支（临时目录，不碰仓库）");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mmap-run-gate-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "20261109-190000-meta.json"),
      JSON.stringify({ aborted: null, durationMin: 30, cfg: { minutes: 30 }, totals: { rounds: 360 } }),
      "utf8",
    );
    const r1 = readRunMeta(tmp, "20261109-190000");
    ok(r1 !== null && r1.aborted === null && r1.metaAvailable && r1.plannedMinutes === 30, `回查命中：aborted=null / plannedMinutes=30`, JSON.stringify(r1));
    const r2 = readRunMeta(tmp, "no-such-label");
    ok(r2 === null, `回查未命中 ⇒ null（调用方按「未知」放行 + WARN）`, `实际 ${r2}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failed ? `\n❌ ${failed} 条断言失败` : `\n✅ 全部断言通过（run-gate 放行数为 0 / 夹具分母=6 / 判据有区分力 / 透传链三段）`);
  if (failed) process.exitCode = 1;
}

run();
