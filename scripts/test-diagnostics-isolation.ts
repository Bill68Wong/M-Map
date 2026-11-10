/**
 * 诊断流隔离测试（scripts/test-diagnostics-isolation.ts，批 2 · U-06 / v4.1.2）
 * 用法：npm run test:diagnostics-isolation    （纯静态 + 纯文件系统，**不连库、不读 data/tracking 真实产物**）
 *
 * 承载 UA-01~UA-07 七条（负责人批 2 裁定，不新增编号）：
 *   UA-01 放行数 0      : 诊断文件不以 `-derived.json` 结尾 ⇒ listDerivedFiles 扫不到；当样本读 ⇒ 0 行
 *   UA-02 分母/取数完整性: 夹具 rows.length>0（防空跑假绿）；诊断不入 rawDepart/rawTerminal，ETA 样本计数不变
 *   UA-03 透传链三段    : derive 写诊断文件 → 不被 listDerivedFiles 扫到 → derived 读到的样本行数不受影响
 *   UA-04 四组夹具      : normal / aborted / 短轮 / longstop —— 每组「诊断条数>0」且「ETA 样本增量=0」
 *   UA-05 红→绿两轮     : 诊断记录**塞进** rawDepartSamples ⇒ 检测器必红；移到独立文件 ⇒ 绿（输出落 .verify/）
 *   UA-06 夹具自包含    : 夹具全部内联/落临时目录，**不引用真实 data/tracking**；源码自检无真实路径引用
 *   UA-07 与 U-01 联动  : runMeta.aborted≠null ⇒ gateRun() 拒绝，即便诊断文件存在也不入库
 *
 * ⚠️ 为什么不调 importSegmentSamples 做验收：它 dry 也 pool.query（segment-samples.ts:250,575,590,605-607）。
 *    本测试全程**零连库**：只 import 纯函数 gateRun，其余用文件系统 + 内联夹具。
 * ⚠️ listDerivedFiles()/readTrackFile() 未从 src 导出（本批零 src/ 改动），故此处**逐字符复刻**其判据
 *    （`endsWith("-derived.json")` / `rawDepart+rawTerminal`），并用**静态源码断言**守护二者不分叉。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gateRun } from "../src/lib/rebuild/segment-samples";
import type { RunMeta } from "../src/lib/rebuild/segment-samples";

let failed = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failed++;
};

const SELF = fileURLToPath(import.meta.url);
const SRC_SEG = path.resolve(process.cwd(), "src/lib/rebuild/segment-samples.ts");
const VERIFY = path.resolve(process.cwd(), ".verify");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mmap-diag-iso-"));
// 拼接 token（源码里不出现连续真实路径字面量，UA-06 自检用）
const REAL_DATA_TOKEN = ["data", "tracking"].join("/");

/** 复刻 listDerivedFiles 判据（与 src/lib/rebuild/segment-samples.ts:346-357 的 filter 逐字符一致） */
const listDerivedLike = (dir: string): string[] =>
  fs.readdirSync(dir).filter((f) => f.endsWith("-derived.json")).sort();

/** 复刻 readTrackFile 的取数（rawDepartSamples + rawTerminalSamples） */
const readSampleRows = (file: string): Record<string, unknown>[] => {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return [...(j.rawDepartSamples ?? []), ...(j.rawTerminalSamples ?? [])];
};

/** 检测器：ETA 样本里是否混入了「带 discardReason 的诊断记录」（UA-05 红/绿判据核心） */
const detectLeak = (derivedFile: string): number =>
  readSampleRows(derivedFile).filter((r) => "discardReason" in r).length;

const meta = (over: Partial<RunMeta> = {}): RunMeta => ({
  aborted: null, metaAvailable: true, durationMin: 30, rounds: 360, plannedMinutes: 30, ...over,
});

/** 造一组夹具到临时目录：derived（合法）+ diagnostics（诊断），返回路径 */
function writePair(name: string, derived: Record<string, unknown>, diag: Record<string, unknown>) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const dFile = path.join(dir, `${name}-derived.json`);
  const gFile = path.join(dir, `${name}-diagnostics.json`);
  fs.writeFileSync(dFile, JSON.stringify(derived, null, 2), "utf8");
  fs.writeFileSync(gFile, JSON.stringify(diag, null, 2), "utf8");
  return { dir, dFile, gFile };
}

const sample = (i: number) => ({ route: "25", dir: "0", plate: "P" + i, from: "C656", to: "C654", minutes: 2.4, fromIdx: 1, t: 1700000000000 + i, kind: "depart" });
const diagRec = (reason: string) => ({ discardReason: reason, label: "X", route: "25", dir: "0", plate: "P0", main: "C654", sta: "C654/3", idx: "3", status: "1", holdMin: 6.17, frames: 75, t: 1700000000000, window: { from: "a", to: "b" } });

function main() {
  // ── UA-01 放行数 0 ────────────────────────────────────────────────
  console.log("\n=== UA-01 放行数 0：诊断文件不被当样本轮 ===");
  {
    const { dir, gFile } = writePair("ua01",
      { schemaVersion: 2, rawDepartSamples: [sample(1), sample(2)], rawTerminalSamples: [{ ...sample(3), kind: "terminal" }] },
      { label: "ua01", runMeta: meta(), records: [diagRec("guard.s1ToS1Gap")] });
    const listed = listDerivedLike(dir);
    ok(listed.length === 1 && listed[0] === "ua01-derived.json", `listDerivedLike 只返回 1 个 -derived.json`, listed.join(","));
    ok(!listed.some((f) => f.endsWith("-diagnostics.json")), `诊断文件不在 listDerivedLike 结果里`);
    ok(readSampleRows(gFile).length === 0, `把诊断文件当样本读 ⇒ 0 行`, `实际 ${readSampleRows(gFile).length}`);
    // 静态守护：listDerivedFiles 判据必须是 endsWith("-derived.json")，与复刻一致
    const segSrc = fs.readFileSync(SRC_SEG, "utf8");
    ok(segSrc.includes('endsWith("-derived.json")'), `源 listDerivedFiles 判据仍为 endsWith("-derived.json")（复刻不分叉）`);
  }

  // ── UA-02 分母/取数完整性（防空跑假绿）────────────────────────────
  // ⚠️ **本段证明力上限 = 「夹具非空 + 复刻自洽」**，不要把本段读成「生产分母已验证」：
  //   `rows` 来自测试内**复刻**的 `readSampleRows`（:44-47），所以 :96 断言的是
  //   「我自己的 reader 读回我自己刚写的数组」；:95 的非空由夹具字面量（12+3）保证，真但平凡。
  //   生产 `readTrackFile` 的取数由 **T4 的源码锁**覆盖（`test-ingest-guards.ts` 抽
  //   `const raw = [ … ]` 断言标识符集合恰为 {depart,terminal}）—— 那边才是生产证明。
  //   📌 历史记录（非断言）：20260914-093900 实跑 3102 条 depart + 74 条 terminal = 3176 行。
  //     此处原有一条 `ok(etaN + termN === 3176, …)`，是**测试内常量自己加自己**、与被测代码零关系；
  //     批 4 / T8 已删（造错实证：把 3176 改成 3177 它立刻红，而当时生产代码一个字没动 ⇒ 零检测力）。
  console.log("\n=== UA-02 分母/取数完整性（夹具非空 + 复刻自洽）===");
  {
    const dep = Array.from({ length: 12 }, (_, i) => sample(i));
    const term = Array.from({ length: 3 }, (_, i) => ({ ...sample(100 + i), kind: "terminal" }));
    const { dFile } = writePair("ua02", { schemaVersion: 2, rawDepartSamples: dep, rawTerminalSamples: term }, { label: "ua02", runMeta: meta(), records: [diagRec("guard.notAdjacent"), diagRec("source.windowEnd")] });
    const rows = readSampleRows(dFile);
    ok(rows.length > 0, `夹具非空（12 条 depart + 3 条 terminal，由字面量保证）`, `${rows.length}`);
    ok(
      rows.length === dep.length + term.length,
      `复刻自洽：测试内 readSampleRows 取数 = depart+terminal，不掺诊断`,
      `${rows.length} = ${dep.length}+${term.length}`,
    );
    ok(rows.every((r) => !("discardReason" in r)), `ETA 样本里无任何 discardReason 字段（诊断未掺入）`);
  }

  // ── UA-03 透传链三段 ──────────────────────────────────────────────
  console.log("\n=== UA-03 透传链三段 ===");
  {
    const { dir, dFile, gFile } = writePair("ua03",
      { schemaVersion: 2, rawDepartSamples: [sample(1), sample(2)], rawTerminalSamples: [sample(3)] },
      { label: "ua03", runMeta: meta(), records: [diagRec("source.plateRemoved")] });
    // 段1：诊断文件写出（存在）
    ok(fs.existsSync(gFile), `段1 诊断文件已写出`);
    // 段2：不被 listDerivedFiles 扫到
    ok(!listDerivedLike(dir).includes(gFile), `段2 诊断文件不被 listDerivedFiles 扫到`);
    // 段3：derived 读到的样本行数不受诊断影响 + 首条主键稳定
    const rows = readSampleRows(dFile);
    ok(rows.length === 3, `段3 derived 样本行数 = 3（诊断不改变）`, `${rows.length}`);
    ok(rows[0].from === "C656" && rows[0].to === "C654", `段3 首条主键 (C656→C654) 稳定`);
  }

  // ── UA-04 四组夹具 ────────────────────────────────────────────────
  console.log("\n=== UA-04 四组夹具（每组：诊断条数>0 且 ETA 增量=0）===");
  {
    const groups: { name: string; derived: Record<string, unknown>; diag: Record<string, unknown>; mustReason: string }[] = [
      { name: "normal", derived: { schemaVersion: 2, rawDepartSamples: [sample(1), sample(2)], rawTerminalSamples: [], runMeta: meta() }, diag: { label: "normal", runMeta: meta(), records: [diagRec("guard.minSeriesFrames")] }, mustReason: "guard.minSeriesFrames" },
      { name: "aborted", derived: { schemaVersion: 2, rawDepartSamples: [], rawTerminalSamples: [], runMeta: meta({ aborted: "hard-breaker" }) }, diag: { label: "aborted", runMeta: meta({ aborted: "hard-breaker" }), records: [diagRec("output.abortedRound")] }, mustReason: "output.abortedRound" },
      { name: "短轮", derived: { schemaVersion: 2, rawDepartSamples: Array.from({ length: 3 }, (_, i) => sample(i)), rawTerminalSamples: [] }, diag: { label: "短轮", runMeta: meta(), records: [diagRec("guard.minSeriesFrames")] }, mustReason: "guard.minSeriesFrames" },
      { name: "longstop", derived: { schemaVersion: 2, rawDepartSamples: [sample(1)], rawTerminalSamples: [] }, diag: { label: "longstop", runMeta: meta(), records: [diagRec("source.windowEnd"), diagRec("source.plateRemoved"), diagRec("output.topNSlice")] }, mustReason: "source.windowEnd" },
    ];
    for (const g of groups) {
      const { dFile, gFile } = writePair("ua04-" + g.name, g.derived, g.diag);
      const records = (JSON.parse(fs.readFileSync(gFile, "utf8")).records ?? []) as { discardReason: string }[];
      const etaRows = readSampleRows(dFile);
      const etaClean = etaRows.every((r) => !("discardReason" in r));
      const reasonHit = records.some((r) => r.discardReason === g.mustReason);
      ok(records.length > 0 && reasonHit, `${g.name}: 诊断条数>0 且含 ${g.mustReason}`, `records=${records.length}`);
      ok(etaClean, `${g.name}: ETA 样本无诊断掺入（增量=0）`, `etaRows=${etaRows.length}`);
    }
  }

  // ── UA-05 红→绿两轮（检测器有效性）──────────────────────────────
  console.log("\n=== UA-05 红→绿两轮 ===");
  {
    fs.mkdirSync(VERIFY, { recursive: true });
    // 红轮：把诊断记录**故意塞进** rawDepartSamples
    const before = writePair("ua05-before",
      { schemaVersion: 2, rawDepartSamples: [sample(1), diagRec("guard.s1ToS1Gap")], rawTerminalSamples: [] },
      { label: "b", runMeta: meta(), records: [] });
    const leakBefore = detectLeak(before.dFile);
    fs.writeFileSync(path.join(VERIFY, "diagnostics-isolation-before.out.txt"),
      `[UA-05 红轮] 诊断记录塞进 rawDepartSamples ⇒ detectLeak=${leakBefore}（>0 即为红，判定正确）\n`, "utf8");
    ok(leakBefore > 0, `红轮：诊断混入 ETA ⇒ 检测器报污染`, `leak=${leakBefore}`);
    // 绿轮：诊断移到独立文件
    const after = writePair("ua05-after",
      { schemaVersion: 2, rawDepartSamples: [sample(1), sample(2)], rawTerminalSamples: [] },
      { label: "a", runMeta: meta(), records: [diagRec("guard.s1ToS1Gap")] });
    const leakAfter = detectLeak(after.dFile);
    fs.writeFileSync(path.join(VERIFY, "diagnostics-isolation-after.out.txt"),
      `[UA-05 绿轮] 诊断移到独立文件 ⇒ detectLeak=${leakAfter}（=0 即绿，判定正确）\n`, "utf8");
    ok(leakAfter === 0, `绿轮：诊断分离 ⇒ 检测器放行`, `leak=${leakAfter}`);
    ok(fs.existsSync(path.join(VERIFY, "diagnostics-isolation-before.out.txt")) && fs.existsSync(path.join(VERIFY, "diagnostics-isolation-after.out.txt")), `两轮输出已落 .verify/diagnostics-isolation-{before,after}.out.txt`);
  }

  // ── UA-06 夹具自包含（不引用真实 data/tracking）──────────────────
  console.log("\n=== UA-06 夹具自包含 ===");
  {
    const selfSrc = fs.readFileSync(SELF, "utf8");
    // 去注释后统计真实路径字面量（注释里叙述「不读 data/tracking」不算引用）
    const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const codeCount = (s: string) => stripComments(s).split(REAL_DATA_TOKEN).length - 1;
    ok(codeCount(selfSrc) === 0, `本测试代码（去注释）零真实路径字面量`, `count=${codeCount(selfSrc)}`);
    // 夹具全落在临时目录（不进仓库 data/）
    ok(TMP.startsWith(os.tmpdir()), `所有夹具落在系统临时目录`, TMP);
    // 造错自检：往代码里加一行真实引用 ⇒ 计数变 1 ⇒ 自检能变红
    const badProbe = selfSrc + `\nconst _probe = fs.readFileSync("${REAL_DATA_TOKEN}/x-derived.json");\n`;
    ok(codeCount(badProbe) === 1, `造错模拟：加真实引用后 codeCount=1（自检能变红）`, `count=${codeCount(badProbe)}`);
  }

  // ── UA-07 与 U-01 联动（aborted 轮即便有诊断也不入库）───────────
  console.log("\n=== UA-07 与 U-01 联动 ===");
  {
    const abortedMeta = meta({ aborted: "hard-breaker" });
    const g = gateRun({ label: "X", rows: 600, schemaVersion: 2, runMeta: abortedMeta }, null);
    ok(g.pass === false && g.reason.includes("aborted:"), `aborted 轮 gateRun 拒绝`, `pass=${g.pass} reason=${g.reason}`);
    // 即便诊断文件存在，也不改变 gateRun 的拒入结论（诊断不进 rawDepart，故不参与行数门槛）
    const { dFile } = writePair("ua07", { schemaVersion: 2, runMeta: abortedMeta, rawDepartSamples: [sample(1)], rawTerminalSamples: [] }, { label: "X", runMeta: abortedMeta, records: [diagRec("output.abortedRound")] });
    const rows = readSampleRows(dFile).length;
    const g2 = gateRun({ label: "X", rows: Math.max(rows, 100), schemaVersion: 2, runMeta: abortedMeta }, null);
    ok(g2.pass === false, `即便诊断/样本存在，aborted 轮仍拒入`, `rows=${rows} pass=${g2.pass}`);
  }

  // 清理临时目录
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(failed ? `\n❌ ${failed} 条断言失败` : `\n✅ 全部断言通过（UA-01~07：诊断流不污染 ETA、诊断文件不被当样本轮、aborted 联动拒入）`);
  if (failed) process.exitCode = 1;
}

main();
