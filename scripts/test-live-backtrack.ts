/**
 * 回溯跳时长与到达点判定（scripts/test-live-backtrack.ts · S-14 · 批 3）
 * 用法：npm run test:live-backtrack    （纯内存夹具，不连库）
 *
 * 测 `hopsDurationBetween`（批 1 已 export）：从用户站往车辆当前站累加 `steps` 跳，
 * 用来反推「车多久前经过用户站」。核心是**末跳口径**与**到达点判定**：
 *   · 末跳（抵达车辆当前站）⇒ `run`（纯行驶，扣该站停站）；中间跳 ⇒ `total`；
 *   · 到达点用「终点**站码** == arrivalMain」判定，**不是**数组下标 —— 因为 `steps`
 *     可能绕环线一圈、到达站在中间就重复出现，按下标会错判末跳。
 *
 * 另测 `toBusArrival` 的 etaSec 三分支：status='1'（停靠）/ status='0' 无位置 / status='0' 有位置。
 *
 * 造错哨兵：把 `hopsDurationBetween` 的站码判据改成下标 `k === steps-1`，环线组必红。
 */
import { hopsDurationBetween, toBusArrival } from "../src/lib/recommend/live";
import { buildSegmentIndex } from "../src/lib/recommend/segment-lookup";
import type { RouteIndex, SegmentStatRow } from "../src/lib/recommend/types";
import type { EtaBus } from "../src/lib/dsat/eta";
import type { VehicleSegmentLocation } from "../src/lib/nav/progress";

let failed = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failed++;
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-9;

/** 造一行 segment_stats（样本数 10 ≥ HOP_MIN_SAMPLES(5)，确保命中 L1） */
const row = (from: string, to: string, p50: number, run: number): SegmentStatRow => ({
  route_code: "R",
  from_station: from,
  to_station: to,
  weekday: -1,
  time_bucket: "day",
  arrive_kind: "stop",
  avg_minutes: p50,
  p50_minutes: p50,
  samples: 10,
  p50_run_minutes: run,
});

const emptyRouteIdx: RouteIndex = {
  dirStops: new Map(),
  seqIdx: new Map(),
  dirsOf: new Map(),
  nameOf: new Map(),
  adjOwners: new Map(),
};

const etaBus = (status: string, hops: [string, string][]): EtaBus => ({
  plate: null,
  stopsAway: hops.length,
  atStation: hops[0]![0],
  atStationName: "測試站",
  status,
  hops,
});

function main() {
  // ── a. 直线 2 跳：中间跳 total / 末跳 run ──
  console.log("\n① 直线 2 跳（A→B→C，末跳 run / 中间跳 total）");
  {
    const idx = buildSegmentIndex([row("A", "B", 2, 1), row("B", "C", 2.5, 1.5)]);
    const got = hopsDurationBetween(idx, "R", ["A", "B", "C"], 0, 2, "day");
    // A→B 中间跳 total=2；B→C 末跳 run=1.5 ⇒ 3.5
    ok(got !== null && near(got, 3.5, 1e-6), "直线 2 跳 = 2(total) + 1.5(run) = 3.5", `${got}`);
    ok(got !== null && !near(got, 2 + 2.5, 1e-6), "末跳未误用 total（否则 4.5）", `${got}`);
  }

  // ── b. 环线：到达站码在中间重复出现，站码判据 ≠ 下标判据 ──
  console.log("\n② 环线 1 组（stops=[A,C,B,C]，steps=3，到达点=C 在中间重复）");
  {
    // A→C(2,run1) · C→B(3,run1.5) · B→C(2.5,run1.2)
    const idx = buildSegmentIndex([row("A", "C", 2, 1), row("C", "B", 3, 1.5), row("B", "C", 2.5, 1.2)]);
    const stops = ["A", "C", "B", "C"];
    const got = hopsDurationBetween(idx, "R", stops, 0, 3, "day");
    // arrivalMain = stops[(0+3)%4] = "C"
    // 站码判据：k0 A→C(b=C=arrival ⇒ run1) · k1 C→B(total3) · k2 B→C(b=C=arrival ⇒ run1.2) = 5.2
    // 下标判据：k0 total2 · k1 total3 · k2 run1.2 = 6.2
    ok(got !== null && near(got, 5.2, 1e-6), "环线：按到达**站码**判末跳 ⇒ 1(run)+3(total)+1.2(run)=5.2", `${got}`);
    ok(got !== null && !near(got, 6.2, 1e-6), "环线：未按下标判末跳（否则 2+3+1.2=6.2）", `${got}`);
  }

  // ── c. toBusArrival 的 etaSec 三分支（status + locSeg）──
  console.log("\n③ toBusArrival etaSec 三分支（status='1' / '0' 无位置 / '0' 有位置）");
  {
    const idx = buildSegmentIndex([row("A", "B", 2, 1), row("B", "C", 2.5, 1.5)]);
    const hops: [string, string][] = [["A", "B"], ["B", "C"]];
    // hopMin = [total(A→B)=2, run(B→C)=1.5], sum=3.5, first=2
    const a1 = toBusArrival(emptyRouteIdx, idx, "R", "0", etaBus("1", hops), "day");
    ok(a1.etaSec != null && near(a1.etaSec, 210, 1), "status='1'：etaSec = sum×60 = 3.5×60 = 210", `${a1.etaSec}`);
    const a2 = toBusArrival(emptyRouteIdx, idx, "R", "0", etaBus("0", hops), "day", null);
    ok(a2.etaSec != null && near(a2.etaSec, 150, 1), "status='0' 无位置：etaSec = 210 − first×30 = 150", `${a2.etaSec}`);
    const loc: VehicleSegmentLocation = { fromMain: "A", toMain: "B", p: 0.5, mdSec: 120, remainSecD: 50 };
    const a3 = toBusArrival(emptyRouteIdx, idx, "R", "0", etaBus("0", hops), "day", loc);
    ok(a3.etaSec != null && near(a3.etaSec, 140, 1), "status='0' 有位置：etaSec = locSeg.remainSecD(50) + (sum−first)×60(90) = 140", `${a3.etaSec}`);
    ok(a1.etaSec !== a2.etaSec && a2.etaSec !== a3.etaSec, "三分支 etaSec 互不相等（210/150/140）");
  }

  console.log(failed ? `\n❌ ${failed} 条断言失败` : `\n✅ 全部断言通过（直线/环线站码判据 + etaSec 三分支）`);
  if (failed) process.exitCode = 1;
}

main();
