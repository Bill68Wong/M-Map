/**
 * 站序图标数据层门禁（scripts/test-stop-marks.ts，2026-11-07 由 `.verify/_fe-c-vehmarks.ts` 迁入）
 *
 * ── 为什么必须入库 ────────────────────────────────────────────────────────
 *   原文件在 `.verify/`（`.gitignore:51` 整目录忽略）⇒ **不在版本库**，
 *   且 `package.json` / git hooks 无一处执行它。它"存在"但**从来不是门禁**，
 *   只是一份"某人某次跑过的记录"。迁到 `scripts/` 后进 `npm run verify` 链。
 *
 * ── 守什么（纯函数，零 DB / 零网络 / 零浏览器）─────────────────────────────
 *   `buildVehMarks` / `gateRows` / `pickDirByStops` 是站序巴士图标的**唯一数据源**。
 *   它们坏掉时**不会编译错、不会类型错、不会有任何报错**，表现只是
 *   「图标画在错的行 / 一辆车画两次 / 根本没画」—— 用户不会报（他不确定本该有）。
 *   ⇒ 必须用可执行断言钉住。
 *
 *   [1]–[5]  四态判据（ready / stop / moving / approach）+ frac 降级（绝不猜）
 *   [6]      数据不到位 ⇒ 一行都不画（禁止占位图标）
 *   [7]      多车同线：一行最多一个图标（优先级 stop > approach > ready > moving）
 *   [8]      环线首末同站：`buildVehMarks` 仍是"一站一份"
 *   [9]      方向判定：靠首末站，不靠"集合交集"（双方向几乎停同一批站）
 *   [10]     **`gateRows` 行级闸门**：环线首末同站 ⇒ 一辆车只画一次（QA 实测过的真 bug）
 *   [11]     **`vehSrc` 派生顺序**：`vehError` 必须先于 `drawnCount`（否则请求失败会谎报 live）
 *
 * ── 没迁过来的部分（仍在 `.verify/_fe-c-vehmarks.ts`）──────────────────────
 *   [10] RouteStopsSheet SSR 零回归 / [11] 通琴号发车时间 / [12][13] 源码断言 /
 *   [15] toast 几何 —— 那些要 React SSR 或读他人组件源码，属**一次性取证**，
 *   不是长期不变量。留在 `.verify/` 里当参考实现，不进 CI。
 *
 * 跑法：`npm run test:stop-marks`
 *      `npx tsx scripts/test-stop-marks.ts --self-test`   # 自证判据抓得到违规
 * 退出码：0 = 全部 PASS；1 = 有 FAIL。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { APPROACH_P, FALLBACK_FRAC, buildVehMarks, gateRows, pickDirByStops } from "@/components/nav/stops-veh-marks";
import type { VehicleLite } from "@/components/nav/VehicleMarker";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ` :: ${extra}` : ""}`);
  }
}

/** 本方向站序（主码）：A → B → C → D → E */
const MAINS = ["A01", "B02", "C03", "D04", "E05"];

const veh = (p: Partial<VehicleLite> & { plate: string }): VehicleLite => ({
  lat: 0,
  lng: 0,
  status: "moving",
  isLast: false,
  interval: null,
  atStation: null,
  progress: null,
  company: "澳巴",
  ...p,
});

const stopRef = (code: string) => ({ code, name: `${code} 站` });
const prog = (p: number, segFrom: string, segTo: string): VehicleLite["progress"] => ({
  p,
  remainSecD: 30,
  mdSec: 60,
  w: 0.5,
  segFrom,
  segTo,
  segLenM: 800,
});

/* ══════════════════════════════════════════════════════════════════════════
   [11] 的判据抽成独立函数 —— `--self-test` 要用同一份逻辑去测"坏源码"
   ══════════════════════════════════════════════════════════════════════════ */
/**
 * `vehSrc` 派生顺序是否正确：`kind` 门 → `vehError` 门 → `drawnCount` 门。
 *
 * 病灶（会被写成静默 bug 的那种）：若把 `drawnCount > 0` 挪到 `vehError` 前面，
 * 请求失败时若上一帧还有残留 `drawnCount`（或 React 批处理顺序变了），
 * 就会报 `live` 而实际没有可信数据 —— QA 看到 `data-veh-src="live"` 却查不到车。
 * 反过来（正确）是 `vehError ⇒ failed`，**任何**其它条件都不能越过它。
 *
 * 用「抽表达式 + 比 indexOf」而不是整段正则：格式化/加注释/换行都不影响判定，
 * 只有**真的调换顺序**才会红。
 */
function vehSrcOrderOk(src: string): boolean {
  const m = /const vehSrc\s*=([\s\S]*?);\s*\n/.exec(src);
  if (!m) return false;
  const expr = m[1];
  const iErr = expr.indexOf("vehError");
  const iDrawn = expr.indexOf("drawnCount");
  const iKind = expr.indexOf('kind !== "bus"');
  const iFailed = expr.indexOf('"failed"');
  return iKind >= 0 && iErr > iKind && iDrawn > iErr && iFailed > iErr;
}

/** 环线只画一次（`gateRows` 的判据核心） */
function ringDrawsOnce(gate: typeof gateRows): boolean {
  const ring = ["A01", "B02", "C03", "A01"];
  const marks = buildVehMarks(ring, [veh({ plate: "RING", status: "terminal", atStation: stopRef("A01") })]);
  const gated = gate(
    ring.map((code, i) => ({ code, seq: i + 1 })),
    marks,
  );
  return [...gated.values()].filter((e) => e.mark).length === 1;
}

/** 方向判定（反序站序 ⇒ dir 1） */
function dirByReverseStops(pick: typeof pickDirByStops): boolean {
  const mk = (order: string[], dir: string) => ({
    dir,
    polyline: "",
    points: 0,
    startStop: null,
    endStop: null,
    bounds: [null, null, null, null] as [number | null, number | null, number | null, number | null],
    stations: order.map((code, i) => ({ code, seq: i + 1 })),
  });
  return pick([mk(MAINS, "0"), mk([...MAINS].reverse(), "1")], [...MAINS].reverse()) === "1";
}

/* ── [1] ready：停靠在首站 ─────────────────────────────────────────────── */
console.log("\n[1] ready = 停靠在首站（表达「还没发车」，不交互）");
{
  const m = buildVehMarks(MAINS, [veh({ plate: "MR-11-11", status: "terminal", atStation: stopRef("A01") })]);
  const mark = m.get("A01");
  ok("挂在首站行", !!mark);
  ok("state=ready", mark?.state === "ready", mark?.state);
  ok("frac=0（非 moving ⇒ 吸附节点）", mark?.frac === 0, String(mark?.frac));
  ok("toEndStops=4", mark?.toEndStops === 4, String(mark?.toEndStops));
  ok("label 含车牌+运营商+还有几站", /MR-11-11 · 澳巴 · 还有 4 站/.test(mark?.label ?? ""), mark?.label ?? "(无 label)");
}

/* ── [2] stop：停靠在非首站 ───────────────────────────────────────────── */
console.log("\n[2] stop = 停靠在非首站");
{
  const m = buildVehMarks(MAINS, [veh({ plate: "MR-22-22", status: "stopping", atStation: stopRef("C03/2") })]);
  ok("站台码归一为主码后挂到 C03 行", !!m.get("C03"));
  ok("state=stop", m.get("C03")?.state === "stop", m.get("C03")?.state);
  ok("toEndStops=2", m.get("C03")?.toEndStops === 2, String(m.get("C03")?.toEndStops));
}
{
  const m = buildVehMarks(MAINS, [veh({ plate: "MR-33-33", status: "terminal", atStation: stopRef("E05") })]);
  ok("终点站停靠 ⇒ stop（不是 ready）", m.get("E05")?.state === "stop", m.get("E05")?.state);
  ok("到终点 ⇒ toEndStops=0", m.get("E05")?.toEndStops === 0, String(m.get("E05")?.toEndStops));
}

/* ── [3] moving：区间中段 ⇒ 挂"起点行"，frac = p ───────────────────────── */
console.log("\n[3] moving = 站间行驶（图标在两节点之间，frac = progress.p）");
{
  const m = buildVehMarks(MAINS, [
    veh({
      plate: "MR-44-44",
      status: "moving",
      interval: { from: stopRef("B02"), to: stopRef("C03") },
      progress: prog(0.35, "B02", "C03"),
    }),
  ]);
  const mark = m.get("B02");
  ok("挂在区间**起点**行（本行→下一行 = 该区间）", !!mark);
  ok("state=moving", mark?.state === "moving", mark?.state);
  ok("frac = p = 0.35（同口径，无换算）", mark?.frac === 0.35, String(mark?.frac));
}
{
  const m = buildVehMarks(MAINS, [
    veh({
      plate: "MR-45-45",
      status: "moving",
      interval: { from: stopRef("B02"), to: stopRef("Z99") },
      progress: prog(2.4, "B02", "Z99"),
    }),
  ]);
  ok("下一站不在站序里 ⇒ 退回「起点的下一站」并判 approach", m.get("C03")?.state === "approach", m.get("C03")?.state);
  ok("该行不是起点行（起点行不画）", !m.get("B02"));
}
{
  const m = buildVehMarks(MAINS, [
    veh({
      plate: "MR-46-46",
      status: "moving",
      interval: { from: stopRef("B02"), to: stopRef("C03") },
      progress: prog(-3, "B02", "C03"),
    }),
  ]);
  ok("p<0 被夹到 0", m.get("B02")?.frac === 0, String(m.get("B02")?.frac));
}

/* ── [4] approach：p ≥ 阈值 ⇒ 吸附**下一站**节点 ───────────────────────── */
console.log(`\n[4] approach = 即将到站（p ≥ ${APPROACH_P}）⇒ 挂在下一站行`);
{
  const base = { plate: "MR-55-55", status: "moving" as const, interval: { from: stopRef("B02"), to: stopRef("C03") } };
  const near = buildVehMarks(MAINS, [veh({ ...base, progress: prog(APPROACH_P, "B02", "C03") })]);
  ok("p = 阈值 ⇒ approach（含等号）", near.get("C03")?.state === "approach", near.get("C03")?.state);
  ok("挂在**下一站**（C03）而非起点", !!near.get("C03") && !near.get("B02"));
  ok("approach 的 frac=0", near.get("C03")?.frac === 0, String(near.get("C03")?.frac));

  const far = buildVehMarks(MAINS, [veh({ ...base, progress: prog(APPROACH_P - 0.01, "B02", "C03") })]);
  ok("p 略低于阈值 ⇒ moving", far.get("B02")?.state === "moving", far.get("B02")?.state);
}

/* ── [5] 降级：无 progress / 脏 progress ⇒ 用 0.5，绝不猜 ──────────────── */
console.log("\n[5] frac 降级（拿不到精确进度就用 0.5）");
{
  const m = buildVehMarks(MAINS, [
    veh({ plate: "MR-66-66", status: "moving", interval: { from: stopRef("B02"), to: stopRef("C03") }, progress: null }),
  ]);
  ok(`无 progress ⇒ moving + frac=${FALLBACK_FRAC}`, m.get("B02")?.frac === FALLBACK_FRAC, String(m.get("B02")?.frac));
}
{
  const m = buildVehMarks(MAINS, [
    veh({
      plate: "MR-67-67",
      status: "moving",
      interval: { from: stopRef("B02"), to: stopRef("C03") },
      // 段起点对不上 ⇒ 这段的 p 不可用（用错 = "另一段的进度画在这一段上"）
      progress: prog(0.1, "D04", "E05"),
    }),
  ]);
  ok("progress.segFrom 与 interval.from 不一致 ⇒ 降级 0.5", m.get("B02")?.frac === FALLBACK_FRAC, String(m.get("B02")?.frac));
}
{
  const m = buildVehMarks(MAINS, [
    veh({
      plate: "MR-68-68",
      status: "moving",
      interval: { from: stopRef("E05"), to: stopRef("F06") },
      progress: prog(0.5, "E05", "F06"),
    }),
  ]);
  ok("末站出发 ⇒ frac=0（否则图标溢出列表外）", m.get("E05")?.frac === 0, String(m.get("E05")?.frac));
}

/* ── [6] 数据不到位 ⇒ 不画（禁止占位图标）─────────────────────────────── */
console.log("\n[6] 数据不到位 ⇒ 一行都不画");
ok("空车列表 ⇒ 空表", buildVehMarks(MAINS, []).size === 0);
ok("空站序 ⇒ 空表", buildVehMarks([], [veh({ plate: "X", status: "stopping", atStation: stopRef("A01") })]).size === 0);
ok("status=unknown 且无区间/无挂载站 ⇒ 不画", buildVehMarks(MAINS, [veh({ plate: "MR-77-77", status: "unknown" })]).size === 0);
ok(
  "挂载站不在本线站序 ⇒ 不画（方向错了也不能瞎画）",
  buildVehMarks(MAINS, [veh({ plate: "MR-78-78", status: "stopping", atStation: stopRef("Z99") })]).size === 0,
);
ok("信号丢失（无区间）⇒ 不画", buildVehMarks(MAINS, [veh({ plate: "MR-79-79", status: "lost" })]).size === 0);

/* ── [7] 多车同线：一行最多一个图标 ───────────────────────────────────── */
console.log("\n[7] 多车同线：一行最多一个图标（stop > approach > ready > moving）");
{
  const m = buildVehMarks(MAINS, [
    veh({ plate: "MOVING", status: "moving", interval: { from: stopRef("C03"), to: stopRef("D04") }, progress: prog(0.2, "C03", "D04") }),
    veh({ plate: "STOPPED", status: "stopping", atStation: stopRef("C03") }),
  ]);
  ok("停靠胜出", m.get("C03")?.vehicle.plate === "STOPPED", m.get("C03")?.vehicle.plate);
  ok("被淘汰的车不额外占行", m.size === 1, `size=${m.size}`);
}
{
  const m = buildVehMarks(MAINS, [
    veh({ plate: "FAR", status: "moving", interval: { from: stopRef("B02"), to: stopRef("C03") }, progress: prog(0.79, "B02", "C03") }),
    veh({ plate: "NEAR", status: "moving", interval: { from: stopRef("B02"), to: stopRef("C03") }, progress: prog(0.1, "B02", "C03") }),
  ]);
  ok("同优先级 ⇒ frac 更小者（更贴近本行节点）胜出", m.get("B02")?.vehicle.plate === "NEAR", m.get("B02")?.vehicle.plate);
}

/* ── [8] 环线：`buildVehMarks` 仍是"一站一份"（行级去重交给 gateRows）─── */
console.log("\n[8] 环线（首末同站）⇒ buildVehMarks 仍一站一份");
{
  const ring = ["A01", "B02", "C03", "A01"];
  const m = buildVehMarks(ring, [veh({ plate: "RING", status: "stopping", atStation: stopRef("A01") })]);
  ok("A01 只挂一处（首行）", m.size === 1 && m.get("A01")?.state === "ready", `${m.size}/${m.get("A01")?.state}`);
}

/* ── [9] 方向判定：靠首末站（双方向几乎停同一批站，不能用集合交集）────── */
console.log("\n[9] pickDirByStops：靠首末站判方向");
{
  const mk = (order: string[], dir: string) => ({
    dir,
    polyline: "",
    points: 0,
    startStop: null,
    endStop: null,
    bounds: [null, null, null, null] as [number | null, number | null, number | null, number | null],
    stations: order.map((code, i) => ({ code, seq: i + 1 })),
  });
  const shapes = [mk(MAINS, "0"), mk([...MAINS].reverse(), "1")];
  ok("正序站序 ⇒ dir 0", pickDirByStops(shapes, MAINS) === "0", String(pickDirByStops(shapes, MAINS)));
  ok("反序站序 ⇒ dir 1", pickDirByStops(shapes, [...MAINS].reverse()) === "1", String(pickDirByStops(shapes, [...MAINS].reverse())));
  ok("单方向 ⇒ 直接取该方向", pickDirByStops([shapes[1]], MAINS) === "1");
  ok("无走向数据 ⇒ null（不猜方向）", pickDirByStops([], MAINS) === null);
  ok("undefined ⇒ null", pickDirByStops(undefined, MAINS) === null);
}

/* ── [10] gateRows：行级闸门（QA 实测过的真 bug：环线画两个图标）──────── */
console.log("\n[10] gateRows：环线首末同站 ⇒ 一辆车只画一次");
{
  const ring = ["A01", "B02", "C03", "A01"];
  const marks = buildVehMarks(ring, [veh({ plate: "RING", status: "terminal", atStation: stopRef("A01") })]);
  ok("上游 buildVehMarks 仍是「一站一份」（map 只有 1 个键）", marks.size === 1 && marks.get("A01")?.state === "ready");

  const gated = gateRows(
    ring.map((code, i) => ({ code, seq: i + 1 })),
    marks,
  );
  ok("闸门表按行全量输出（4 行都在，行序不变）", gated.size === 4);
  ok("首行 A01 仍有图标（ready）", gated.get(1)?.mark?.state === "ready", String(gated.get(1)?.mark?.state));
  ok("末行 A01（第 4 行）不画 —— 修复前这里是第二个 ready", gated.get(4)?.mark === null);
  ok("实际画出图标数 = 1（修复前 = 2）", [...gated.values()].filter((e) => e.mark).length === 1);
  ok("`code` 随行保存（`vehOf` 用它二次核对）", gated.get(4)?.code === "A01");

  const g2 = gateRows(
    [
      { code: "M95/3", seq: 1 },
      { code: "M95/1", seq: 2 },
    ],
    new Map([["M95", { state: "stop" as const }]]),
  );
  ok("同主码不同站台码 ⇒ 只有首行有 mark", !!g2.get(1)?.mark && g2.get(2)?.mark === null);

  const g3 = gateRows(
    [
      { code: "A01", seq: 1 },
      { code: "A01", seq: 1 },
    ],
    marks,
  );
  ok("重复 seq ⇒ 表里只 1 行（后一行丢弃，不重复画）", g3.size === 1, String(g3.size));

  const g4 = gateRows(
    ring.map((code, i) => ({ code, seq: i + 1 })),
    new Map(),
  );
  ok("无车 ⇒ 每行 null（零回归：纵条不出现图标元素）", [...g4.values()].every((e) => e.mark === null));
}

/* ── [11] vehSrc 派生顺序：vehError 必须先于 drawnCount ────────────────── */
console.log("\n[11] vehSrc 派生顺序（请求失败不得谎报 live）");
const ROOT = existsSyncSafe(join(process.cwd(), "src/components/nav/RouteStopsSheet.tsx"))
  ? process.cwd()
  : dirname(dirname(fileURLToPath(import.meta.url)));
const SHEET_SRC = readFileSync(join(ROOT, "src/components/nav/RouteStopsSheet.tsx"), "utf8");
ok("RouteStopsSheet 里能定位到 `const vehSrc =`", /const vehSrc\s*=/.test(SHEET_SRC));
ok("vehSrc 顺序正确（kind → vehError → drawnCount）", vehSrcOrderOk(SHEET_SRC));
ok('`failed` 绑在 vehError 分支上', /vehError\s*\n?\s*\?\s*"failed"/.test(SHEET_SRC) || vehSrcOrderOk(SHEET_SRC));

/** 极简 existsSync（避免为一个调用引入额外 import 语义误会） */
function existsSyncSafe(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   --self-test：证明上面的判据**抓得到违规**（不是只会打 PASS）
   ══════════════════════════════════════════════════════════════════════════ */
if (process.argv.includes("--self-test")) {
  console.log("\n═══ 自证有效：把实现换成「故意写错的替身」，判据必须变红 ═══");
  let bad = 0;
  const t = (name: string, cond: boolean) => {
    if (!cond) bad++;
    console.log(`  ${cond ? "OK  " : "BAD "}  ${name}`);
  };

  /* ① gateRows 变异：不做行级去重（= 修复前的 bug 形态）⇒ 「只画一次」必须为 false */
  const gateMutant = ((rows: { code: string; seq: number }[], marks: Map<string, never>) =>
    new Map(rows.map((r) => [r.seq, { code: r.code, mark: marks.get(r.code) ?? null }]))) as unknown as typeof gateRows;
  t("gateRows 变异（不按主码去重）⇒「环线只画一次」判据报红", ringDrawsOnce(gateRows) === true && ringDrawsOnce(gateMutant) === false);

  /* ② 方向变异：恒返回第一条 shape 的方向 ⇒ 「反序站序 ⇒ dir 1」必须为 false */
  const pickMutant = (() => "0") as unknown as typeof pickDirByStops;
  t("pickDirByStops 变异（恒取第一条）⇒「反序 ⇒ dir 1」判据报红", dirByReverseStops(pickDirByStops) === true && dirByReverseStops(pickMutant) === false);

  /* ③ 源码变异：把 drawnCount 挪到 vehError 之前 ⇒ 顺序判据必须为 false */
  const broken = SHEET_SRC.replace(
    /const vehSrc\s*=[\s\S]*?;\s*\n/,
    'const vehSrc = kind !== "bus" ? "off" : drawnCount > 0 ? "live" : vehError ? "failed" : "none";\n',
  );
  t("源码变异（drawnCount 越过 vehError）⇒ 顺序判据报红", vehSrcOrderOk(SHEET_SRC) === true && vehSrcOrderOk(broken) === false);

  t("空源码 ⇒ 顺序判据报红（不因「找不到」而假绿）", vehSrcOrderOk("") === false);

  console.log(bad === 0 ? "\n自测通过：4/4 判据均抓得到违规" : `\n自测失败：${bad} 条判据是废纸`);
  process.exit(bad === 0 ? 0 : 1);
}

console.log(`\n===== PASS ${pass} / FAIL ${fail} =====`);
process.exit(fail ? 1 : 0);
