/**
 * 区间时长口径 · 查询端测试（scripts/test-hop-basis.ts，v4.1.0）
 *
 * ── 2026-11-09 负责人裁定（本文件契约已整体改写）────────────────────────
 *   口径**由「是否末跳」决定**，不再由「是否中途总站」决定。
 *
 *   ❌ 旧契约（已被取代，保留说明以免后人以为是「放宽」）：
 *      「`to` 是该线路的中途总站且该行有 `p50_run_minutes` ⇒ 无条件取纯行驶 run」。
 *      **为什么错**：`p50_minutes` = 离开B − 离开A = 行驶 + B 站停站。中间跳时车真的会在 B
 *      停（乘客继续坐）⇒ 停站是**真实等待**，用 run 会**漏算**（负责人抓到的正是司机休息
 *      导致的长停）；而末跳时乘客到 B 就下车，B 的停站发生在下车之后，用 total 会**多算**
 *      一个目的站停站。两个错误方向相反、部分抵消 ⇒ 长期未被发现。
 *
 *   ✅ 新契约：
 *      · 中间跳（`final:false`，也是 `lookupHop` 的默认）⇒ `basis:"total"`（含停站）；
 *      · 末跳（`final:true`）⇒ 优先 `basis:"run"`（纯行驶），无 run 列则回退 `total`。
 *
 * 覆盖四件事（全部**纯内存**，不连库）：
 *   ① 中间跳（`final:false`）对中途总站 ⇒ `total`；
 *   ② 末跳（`final:true`）⇒ `run`；同一行缺 `p50_run_minutes` ⇒ 回退 `total`；
 *   ③ 末跳之外的行为与旧版一致（非中途总站仍 `total`）；
 *   ④ L6/L7 兜底 + 隐含速度越界（>80 / <3 km/h）⇒ 展示值 `minutes:null`，
 *      但 `estMinutes` 保持原估算（累加不许变短）。
 */
import {
  buildSegmentIndex,
  lookupHop,
  MAX_IMPLIED_KMH,
  MIN_IMPLIED_KMH,
} from "../src/lib/recommend/segment-lookup";
import type { SegmentStatRow } from "../src/lib/recommend/types";

let failed = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failed++;
};

const row = (p: Partial<SegmentStatRow>): SegmentStatRow => ({
  route_code: "R",
  from_station: "A",
  to_station: "B",
  weekday: -1,
  time_bucket: "all",
  arrive_kind: "stop",
  avg_minutes: 2,
  p50_minutes: 2,
  samples: 10,
  p50_run_minutes: null,
  ...p,
});
// ★ 批 1 · #13 更正 1：下面 ①②③ 的夹具命中 S-06 特判集合 `26|C656|C654`。
//   选「显式传 avg_minutes:1.5」而不是「改 route 为非 25/26」，理由：
//     · 保留 `26|C656→C654/3` + `midTerminus:["26|C654"]` 的中途总站语义与覆盖意图；
//     · 使新分支（命中特判优先取 avg）仍得 1.5 ⇒ 既有 1.5 / 0.8 断言不假红；
//     · 数据侧实跑证明真缺 avg 字段时中间跳与末跳会双双掉 L7、末跳 run 0.8 丢失，
//       故生产侧 `valueOf` 新分支必须带 `if (avg > 0)` 回退到 p50（已实现）。

console.log("\n① 中间跳（final:false）⇒ total（含 B 站停站的真实等待）");
{
  const idx = buildSegmentIndex([row({ route_code: "26", from_station: "C656", to_station: "C654/3", p50_minutes: 1.5, avg_minutes: 1.5, p50_run_minutes: 0.8 })], {
    midTerminus: new Set(["26|C654"]),
  });
  const h = lookupHop(idx, "26", "C656", "C654/3", "day", { final: false });
  ok(h.basis === "total" && h.minutes === 1.5 && h.level === 2, "中途总站·中间跳 ⇒ total 1.5", JSON.stringify(h));
  // 不传 opts = 中间跳（向后兼容，默认 false）
  const hd = lookupHop(idx, "26", "C656", "C654/3", "day");
  ok(hd.basis === "total" && hd.minutes === 1.5, "不传 opts 默认按中间跳 ⇒ total 1.5", JSON.stringify(hd));
}

console.log("\n② 末跳（final:true）⇒ run；缺 run 列回退 total");
{
  const idx = buildSegmentIndex([row({ route_code: "26", from_station: "C656", to_station: "C654/3", p50_minutes: 1.5, avg_minutes: 1.5, p50_run_minutes: 0.8 })], {
    midTerminus: new Set(["26|C654"]),
  });
  const h = lookupHop(idx, "26", "C656", "C654/3", "day", { final: true });
  ok(h.basis === "run" && h.minutes === 0.8, "末跳 ⇒ run 0.8", JSON.stringify(h));

  // 缺 run：即便确实是末跳，也只能回退 total（不得返回 null / 0）
  const noRun = buildSegmentIndex([row({ route_code: "26", from_station: "C656", to_station: "C654/3", p50_minutes: 1.5, avg_minutes: 1.5 })], {
    midTerminus: new Set(["26|C654"]),
  });
  const h2 = lookupHop(noRun, "26", "C656", "C654/3", "day", { final: true });
  ok(h2.basis === "total" && h2.minutes === 1.5, "末跳但无 run 列 ⇒ 回退 total 1.5", JSON.stringify(h2));
}

console.log("\n③ 非中途总站：中间跳 / 末跳都按各自规则（不再受 midTerminus 影响）");
{
  const noMid = buildSegmentIndex([row({ route_code: "26", from_station: "C656", to_station: "C654/3", p50_minutes: 1.5, avg_minutes: 1.5, p50_run_minutes: 0.8 })]);
  const h1 = lookupHop(noMid, "26", "C656", "C654/3", "day");
  ok(h1.basis === "total" && h1.minutes === 1.5, "不在中途集合·中间跳 ⇒ total 1.5", JSON.stringify(h1));
  const h2 = lookupHop(noMid, "26", "C656", "C654/3", "day", { final: true });
  ok(h2.basis === "run" && h2.minutes === 0.8, "不在中途集合·末跳 ⇒ 仍用 run 0.8（口径只看 final）", JSON.stringify(h2));
}

console.log("\n④ L6/L7 物理护栏（隐含速度越界 ⇒ minutes:null）");
{
  // 无任何样本 ⇒ 落到 L6（该线单站均值 2.28 分）；里程 7,171 m ⇒ 隐含 188 km/h
  const idx = buildSegmentIndex([], { hopMeters: new Map([["59|T317|M9", 7171]]) });
  const h = lookupHop(idx, "59", "T317", "M9/2", "day");
  ok(h.level === 7 || h.level === 6, "落到兜底层", `level=${h.level}`);
  ok(h.minutes === null, "展示值 null（不印 188 km/h）", JSON.stringify(h));
  ok(h.estMinutes > 0, `累加值保持 ${h.estMinutes}（不因缺值变短）`);
  ok((h.impliedKmh ?? 0) > MAX_IMPLIED_KMH, `隐含速度 ${h.impliedKmh} > ${MAX_IMPLIED_KMH}`);

  // 短跳 + 极慢兜底 ⇒ < 3 km/h 同样判不可信
  const slow = buildSegmentIndex([], { hopMeters: new Map([["R|A|B", 40]]) });
  const h2 = lookupHop(slow, "R", "A", "B", "day");
  ok(h2.minutes === null && (h2.impliedKmh ?? 99) < MIN_IMPLIED_KMH, `40 m / ${h2.estMinutes} 分 ⇒ ${h2.impliedKmh} km/h < ${MIN_IMPLIED_KMH}`, JSON.stringify(h2));

  // 正常短跳（400 m / 1.5 分 = 16 km/h）⇒ 不该被拦
  const normal = buildSegmentIndex([row({ p50_minutes: 1.5 }), row({ route_code: "R", time_bucket: "all", arrive_kind: "all", p50_minutes: 1.5 })], {
    hopMeters: new Map([["R|A|B", 400]]),
  });
  const h3 = lookupHop(normal, "R", "A", "B", "day");
  ok(h3.minutes === 1.5, "有样本的短跳不受护栏影响", JSON.stringify(h3));
}

console.log(failed ? `\n❌ ${failed} 条断言失败` : `\n✅ 全部断言通过`);
if (failed) process.exitCode = 1;
