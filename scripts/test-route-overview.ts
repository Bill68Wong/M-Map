/**
 * 路线总览纯函数对拍（scripts/test-route-overview.ts，2026-09-23 新增）
 * 用法：npm run test:overview
 *
 * 覆盖：parsePolyline / nearestOnPath / cutColored（正向 / 反向 / 环线环绕）/
 *       chooseShape（方向选择 / 超容差降级）/ buildColoredLegs（降级 / 同站整线）/
 *       真实数据对拍（route_shapes 26 环线 + 51A 双向）。
 *
 * ⚠️ 用例 1–8 为**确定性纯函数**断言；用例 9 连库（读 `route_shapes`），
 *    库不可达时**跳过并告警**（不判失败），保证 CI 纯函数门稳定。
 */
import type { Pool } from "pg";
import {
  BOARD_EQ_ALIGHT_M,
  arcMiles,
  buildColoredLegs,
  chooseShape,
  cumDistM,
  cutColored,
  decimate,
  distM,
  isLoop,
  nearestOnPath,
  nearestTrips,
  parsePolyline,
  unionBox,
  type LL,
  type RouteShapeLite,
  type RouteStopSeq,
} from "../src/lib/nav/route-overview";

let pass = 0;
let fail = 0;
/**
 * ★ 跳过计数（**不计入 pass**）。
 *
 * 为什么必须单独计数：本脚本的核心验收价值在连库用例（⑩ 真实数据对拍 /
 * ⑱ 真实卡指纹对拍 —— 需求 4 的「4 张对照卡指纹不变 + 25 号靶子」全在里面）。
 * 旧实现把连库块整体包进 `try/catch`，库不可达时**一条没跑**却照样打印
 * `✅ 全部通过` + exit 0 ⇒ 「最该验的没验，还告诉 CI 一切正常」（跳过型假绿）。
 * ⇒ 现在：跳过单独计数、单独列出用例编号与原因、末尾必须显式可见。
 */
let skip = 0;
/** 被跳过的用例登记表（编号 + 名称 + 原因）—— 读者要知道跳过的是核心验收项还是边角料 */
const skipped: { id: string; name: string; reason: string }[] = [];

function skipCase(id: string, name: string, reason: string) {
  skip++;
  skipped.push({ id, name, reason });
  console.log(`  ⏭  ${id} ${name} —— 跳过（未验证）：${reason}`);
}

function ok(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.error(`  ❌ ${label}`);
  }
}
function close(a: number, b: number, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}
function near(a: LL, b: LL, tolM = 1) {
  return distM(a, b) <= tolM;
}

/** 直线折线：起点 (lng0,lat0)，每步 +stepLng，共 n 点 —— y 恒定 */
function line(lng0: number, lat0: number, stepLng: number, n: number): LL[] {
  const out: LL[] = [];
  for (let i = 0; i < n; i++) out.push([lng0 + i * stepLng, lat0]);
  return out;
}

function test1_parsePolyline() {
  console.log("① parsePolyline");
  const a = parsePolyline("113.5,22.1;113.6,22.2");
  ok(a.length === 2, "2 点解析");
  ok(close(a[0][0], 113.5) && close(a[0][1], 22.1), "首点数值正确");
  ok(close(a[1][0], 113.6) && close(a[1][1], 22.2), "末点数值正确");
  const b = parsePolyline("113.5,22.1;bad;113.6,22.2;;x,y;;");
  ok(b.length === 2, "非法段被过滤（bad / 空 / x,y 丢弃）");
  ok(parsePolyline("").length === 0, "空串 → 空数组");
}

function test2_nearestOnPath() {
  console.log("② nearestOnPath");
  const pts = line(113.5, 22.1, 0.01, 5); // idx0..4
  const r = nearestOnPath(pts, { lng: 113.5205, lat: 22.1001 });
  ok(r.idx === 2, "点落在第 3 顶点附近 → idx===2");
  ok(r.distM < 60 && r.distM > 20, `距离合理（${r.distM.toFixed(1)}m）`);
}

function test3_cutForward() {
  console.log("③ cutColored 非环线正向");
  const pts = line(113.5, 22.1, 0.01, 5);
  const c = cutColored(pts, 1, 3, false);
  ok(!!c && c.length === 3, "slice(ib, ia+1) 长度 3");
  ok(!!c && near(c[0], pts[1]) && near(c[2], pts[3]), "两端点 = pts[1]/pts[3]");
}

function test4_cutReverse() {
  console.log("④ cutColored 非环线 ib>ia（存储几何与行驶方向相反 → 反向切片）");
  const pts = line(113.5, 22.1, 0.01, 5);
  const c = cutColored(pts, 3, 1, false);
  ok(
    !!c && c.length === 3 && near(c[0], pts[3]) && near(c[2], pts[1]),
    "反向切片 [pts3,pts2,pts1]：colored[0]=board、colored.at(-1)=alight",
  );
}

function test5_loopWrap() {
  console.log("⑤ cutColored 环线环绕");
  const pts: LL[] = [
    [113.5, 22.1], // 0 head
    [113.51, 22.1], // 1 alight 邻域
    [113.52, 22.1], // 2
    [113.53, 22.1], // 3
    [113.53, 22.11], // 4
    [113.52, 22.11], // 5 board 邻域
    [113.51, 22.11], // 6
    [113.5, 22.1], // 7 ≈ 0（闭合）
  ];
  const n = pts.length;
  const ib = 5;
  const ia = 1;
  ok(isLoop(pts), "首尾闭合 → isLoop");
  const c = cutColored(pts, ib, ia, true);
  const expectLen = n - ib + (ia + 1);
  ok(!!c && c.length === expectLen, `环绕长度 = (n-ib)+(ia+1) = ${expectLen}`);
  ok(!!c && near(c[0], pts[ib]), "colored[0] ≈ board");
  ok(!!c && near(c[c.length - 1], pts[ia]), "colored.at(-1) ≈ alight");
}

function test6_chooseShape() {
  console.log("⑥ chooseShape 方向选择 / 超容差");
  const fwd = line(113.5, 22.1, 0.01, 11); // idx0..10，lng 递增
  const rev = [...fwd].reverse();
  const shapeA: RouteShapeLite = { dir: "0", polyline: toPoly(fwd) };
  const shapeB: RouteShapeLite = { dir: "1", polyline: toPoly(rev) };
  const board = { lng: 113.51, lat: 22.1 };
  const alight = { lng: 113.53, lat: 22.1 };
  const picked = chooseShape([shapeA, shapeB], board, alight);
  ok(!!picked && picked.shape === shapeA, "选中 board 在 alight 之前的方向");
  ok(!!picked && picked.iBoard < picked.iAlight, "iBoard < iAlight（正向）");
  const none = chooseShape([shapeA, shapeB], { lng: 113.9, lat: 22.5 }, alight);
  ok(none === null, "两方向都超 TOL → null");
}

function test7_degradeMissingRoute() {
  console.log("⑦ buildColoredLegs 缺 route 降级");
  const legs = [
    {
      index: 0,
      route: "X9",
      kind: "bus" as const,
      color: "#276299",
      board: { code: "A", lng: 113.5, lat: 22.1 },
      alight: { code: "B", lng: 113.52, lat: 22.1 },
    },
  ];
  const out = buildColoredLegs(legs, {});
  ok(out.length === 1 && out[0].degraded === true, "degraded=true");
  ok(out[0].colored === out[0].gray, "colored === gray（引用相等）");
  ok(out[0].gray.length === 0, "无 shapes → gray 为空");
}

function test8_boardEqAlight() {
  console.log("⑧ buildColoredLegs 起终点同站 → 整线着色");
  const pts = line(113.5, 22.1, 0.01, 11);
  const shapesByRoute: Record<string, RouteShapeLite[]> = {
    "26": [{ dir: "0", polyline: toPoly(pts), startStop: "S", endStop: "S" }],
  };
  const board = { code: "S", lng: 113.55, lat: 22.1 };
  const alight = { code: "S", lng: 113.5501, lat: 22.1 }; // ≈同一物理点（< 50m）
  ok(distM([board.lng, board.lat], [alight.lng, alight.lat]) <= BOARD_EQ_ALIGHT_M, "两点 < 50m");
  const out = buildColoredLegs(
    [{ index: 0, route: "26", kind: "bus", color: null, board, alight }],
    shapesByRoute,
  );
  ok(out[0].colored === out[0].gray, "整线着色（colored === gray）");
  ok(out[0].degraded === false, "非降级");
}

/** 附加：unionBox / decimate 基本正确性（并入 ①②⑧ 之外的健壮性） */
function testExtra_geom() {
  console.log("⑨+ unionBox / decimate");
  const box = unionBox(
    [line(113.5, 22.1, 0.01, 3)],
    [{ lng: 113.6, lat: 22.2 }],
  );
  ok(!!box && close(box.minLng, 113.5) && close(box.maxLng, 113.6), "unionBox 含 extra 点");
  ok(!!box && close(box.minLat, 22.1) && close(box.maxLat, 22.2), "unionBox 纬度范围正确");
  ok(unionBox([]) === null, "空集合 → null");
  const dense = line(113.5, 22.1, 0.00002, 100); // 每步 ≈2m < 15m
  const th = decimate(dense, 15);
  ok(th.length < dense.length && th.length >= 2, `抽稀生效（${dense.length}→${th.length}）`);
  ok(near(th[0], dense[0]) && near(th[th.length - 1], dense[dense.length - 1]), "保首尾");
}

function toPoly(pts: LL[]): string {
  return pts.map((p) => `${p[0]},${p[1]}`).join(";");
}

/* ══════════════════════════════════════════════════════════════════════
 * ★ 4-B−（需求 4 · 2026-11-03）：站序感知的趟次配对
 *
 * 背景：彩段锚点原先只靠「站点坐标 → shape 最近顶点」。两个站台若物理相距 ~20m
 * 而站序相差若干站（实例 C652 安順大廈 / C653 金峰南岸，相距约 20m、25 号线
 * 站序差 6 站），最近顶点会落到**对侧站台那一趟** ⇒ 彩段从对面站台起画并绕一整圈。
 * 几何上无法区分（两趟都远在 80m 容差内）⇒ 必须引入站序。
 * 以下 ⑥⑧ 为契约用例，⑪~⑯ 为 4-B− 新增用例。
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 「去—回」型闭合环夹具（模拟「同一条路两侧各一趟」）：
 *   0..N      去程，lat = LAT
 *   N+1       折返点
 *   N+2..2N+1 回程，lat = LAT + 0.0002（≈22.3m 偏移，仍 < LOOP_EPS_M 25m ⇒ 判环线）
 * 站台放在两条线中间 ⇒ 每站恰好被经过 **2 趟**。
 */
const LAT_A = 22.1;
const LAT_B = 22.1002;
function shuttle(N = 50, step = 0.0002): LL[] {
  const out: LL[] = [];
  for (let i = 0; i <= N; i++) out.push([113.5 + i * step, LAT_A]);
  out.push([113.5 + N * step, LAT_B]); // 折返
  for (let k = 1; k <= N; k++) out.push([113.5 + (N - k) * step, LAT_B]);
  return out;
}
/** 站台落在两条线中间（各 ≈11.1m）⇒ 两趟都在 tolM 内、且**等距**（用于测聚类） */
const midway = (steps: number): { lng: number; lat: number } => ({
  lng: 113.5 + steps * 0.0002,
  lat: (LAT_A + LAT_B) / 2,
});
/**
 * 站台**偏向去程线**（≈5.6m 去程 / ≈16.7m 回程）⇒ 最近顶点落在去程（正确那一趟）。
 */
const nearOut = (steps: number): { lng: number; lat: number } => ({
  lng: 113.5 + steps * 0.0002,
  lat: LAT_A + 0.00005,
});
/**
 * 站台**偏向回程线**（≈14.5m 去程 / ≈7.8m 回程）⇒ 最近顶点落在回程（**错误**那一趟）。
 * 这正是 C652/C653 的真实情形：几何最近点落在对侧站台。
 */
const nearReturn = (steps: number): { lng: number; lat: number } => ({
  lng: 113.5 + steps * 0.0002,
  lat: LAT_B - 0.00007,
});

function test11_nearestTrips() {
  console.log("⑪ nearestTrips（≤ tol 的全部趟次，按趟聚类、簇内取最近点为代表）");
  const pts = shuttle();
  const b = midway(10);
  const trips = nearestTrips(pts, b);
  ok(trips.length === 2, `同一站台被经过 2 趟 ⇒ 返回 2 趟（实际 ${trips.length}）`);
  ok(trips[0].idx === 10, `去程趟代表 = idx 10（实际 ${trips[0]?.idx}）`);
  ok(trips[1].idx === 91, `回程趟代表 = idx 91（实际 ${trips[1]?.idx}）`);
  ok(
    trips[0].distM > 5 && trips[0].distM < 20,
    `代表点到站台的距离 ≈ 半幅（${trips[0]?.distM.toFixed(1)}m）`,
  );
  ok(nearestTrips(pts, { lng: 113.9, lat: 22.9 }).length === 0, "远离线路 ⇒ 0 趟");
  // 单趟线路：仍只有 1 趟
  const line1 = line(113.5, 22.1, 0.01, 5);
  ok(nearestTrips(line1, { lng: 113.52, lat: 22.1001 }).length === 1, "普通直线 ⇒ 1 趟");
}

function test12_arcMiles() {
  console.log("⑫ arcMiles（沿索引累计里程差分；非环线取绝对值、环线计环绕与闭合边）");
  const lin = line(113.5, 22.1, 0.01, 5); // 每步 ≈1.03km
  const cumL = cumDistM(lin);
  ok(close(arcMiles(lin, 1, 3, false, cumL), cumL[3] - cumL[1], 1e-6), "非环线正向 = cum[3]-cum[1]");
  ok(
    close(arcMiles(lin, 3, 1, false, cumL), cumL[3] - cumL[1], 1e-6),
    "非环线反向 = 同样里程（reverse() 不改变点集长度）",
  );
  const sh = shuttle();
  const cumS = cumDistM(sh);
  const n = sh.length;
  ok(
    close(arcMiles(sh, 10, 30, true, cumS), cumS[30] - cumS[10], 1e-6),
    "环线 iTo>iFrom ⇒ 前向差",
  );
  const wrap = arcMiles(sh, 91, 30, true, cumS);
  const wrapExpect = cumS[n - 1] - cumS[91] + distM(sh[n - 1], sh[0]) + cumS[30];
  ok(close(wrap, wrapExpect, 1e-6), `环线 iTo<iFrom ⇒ 环绕弧且**含闭合边**（${wrap.toFixed(0)}m）`);
  ok(wrap > cumS[n - 1] - cumS[91] + cumS[30], "闭合边确实被计入（否则会少十几米）");
  ok(close(arcMiles(sh, 7, 7, true, cumS), 0, 1e-9), "同顶点 ⇒ 0");
}

function test13_seqShortestArc() {
  console.log("⑬ 站序生效：上车站的最近顶点落在「回程那一趟」（几何选错）⇒ 站序把它拨回正确一趟");
  const pts = shuttle();
  // B 偏向回程 ⇒ nearestPoints 选中回程那一趟（第 91 号顶点）；
  // A 偏向去程 ⇒ 选中去程（第 30 号顶点）。组合 (91,30) 沿环线要绕一大圈。
  const b = nearReturn(10);
  const a = nearOut(30);
  const poly = toPoly(pts);
  const stations: RouteStopSeq[] = [
    { code: "S0", seq: 0 },
    { code: "S1", seq: 1 },
    { code: "B", seq: 2 },
    { code: "S3", seq: 3 },
    { code: "A", seq: 4 },
    { code: "S5", seq: 5 },
    { code: "S6", seq: 6 },
    { code: "S7", seq: 7 },
    { code: "S8", seq: 8 },
    { code: "S9", seq: 9 },
  ];
  const legacy: RouteShapeLite = { dir: "0", polyline: poly, startStop: "S", endStop: "S" };
  const withSeq: RouteShapeLite = { ...legacy, stations };
  const board = { code: "B", lng: b.lng, lat: b.lat };
  const alight = { code: "A", lng: a.lng, lat: a.lat };

  const L = chooseShape([legacy], board, alight)!;
  const N = chooseShape([withSeq], board, alight)!;
  ok(L.loop && N.loop, "两条线都判为环线");
  ok(L.iBoard === 91, `旧解起点落在回程趟 idx 91（实际 ${L.iBoard}）—— 这就是 C652/C653 的机制`);
  ok(N.iBoard === 10 && N.iAlight === 30, `新解拨回「去程那两趟」（${N.iBoard}→${N.iAlight}）`);
  ok(N.repicked === true, "标注已发生趟次重选");
  ok(N.seqDir === "forward", "站序方向 = forward");
  const lA = cumDistM(cutColored(L.pts, L.iBoard, L.iAlight, L.loop)!).slice(-1)[0];
  const nA = cumDistM(cutColored(N.pts, N.iBoard, N.iAlight, N.loop)!).slice(-1)[0];
  ok(nA < lA, `新解更短（${Math.round(lA)}m → ${Math.round(nA)}m）`);
  ok(near(cutColored(N.pts, N.iBoard, N.iAlight, N.loop)![0], pts[10]), "彩段首点 = 上车站落点");
  ok(nA < 600, `新解里程 ≈ 走一趟路的长度（${Math.round(nA)}m，不绕环）`);
}

function test14_seqNeverLonger() {
  console.log("⑭ 永不变长：站序指向的候选都比旧解长 ⇒ 原样回落");
  const pts = shuttle();
  const poly = toPoly(pts);
  const b = midway(10);
  const a = midway(30);
  // 站序把 B 放在很后面、A 在前面 ⇒ hops 极大 ⇒ 可信下限抬高 ⇒ 全部候选被剔除
  const stations: RouteStopSeq[] = [
    { code: "A", seq: 0 },
    { code: "S1", seq: 1 },
    { code: "S2", seq: 2 },
    { code: "S3", seq: 3 },
    { code: "S4", seq: 4 },
    { code: "B", seq: 5 },
  ];
  const base: RouteShapeLite = { dir: "0", polyline: poly, startStop: "S", endStop: "S" };
  const board = { code: "B", lng: b.lng, lat: b.lat };
  const alight = { code: "A", lng: a.lng, lat: a.lat };
  const L = chooseShape([base], board, alight)!;
  const N = chooseShape([{ ...base, stations }], board, alight)!;
  ok(N.iBoard === L.iBoard && N.iAlight === L.iAlight, "回落旧解（下标完全一致）");
  ok(N.repicked === false, "未重选");
  const lA = cumDistM(cutColored(L.pts, L.iBoard, L.iAlight, L.loop)!).slice(-1)[0];
  const nA = cumDistM(cutColored(N.pts, N.iBoard, N.iAlight, N.loop)!).slice(-1)[0];
  ok(close(lA, nA, 1e-6), "彩段里程不变（永不变长硬保证）");
}

function test15_seqMissingFallback() {
  console.log("⑮ stations 缺失（undefined / [] / null）⇒ 与不传逐字节等价");
  const pts = shuttle();
  const poly = toPoly(pts);
  const b = midway(10);
  const a = midway(30);
  const board = { code: "B", lng: b.lng, lat: b.lat };
  const alight = { code: "A", lng: a.lng, lat: a.lat };
  const base: RouteShapeLite = { dir: "0", polyline: poly, startStop: "S", endStop: "S" };
  const r0 = chooseShape([base], board, alight)!;
  const r1 = chooseShape([{ ...base, stations: [] }], board, alight)!;
  const r2 = chooseShape([{ ...base, stations: null }], board, alight)!;
  const key = (r: typeof r0) => `${r.dir}|${r.iBoard}|${r.iAlight}|${r.loop}|${r.pts.length}`;
  ok(key(r0) === key(r1), "[] ⇒ 完全一致");
  ok(key(r0) === key(r2), "null ⇒ 完全一致");
  // 无 code（调用方没传站码）也必须回落
  const r3 = chooseShape([{ ...base, stations: [{ code: "B", seq: 0 }, { code: "A", seq: 1 }] }], { lng: b.lng, lat: b.lat }, { lng: a.lng, lat: a.lat })!;
  ok(key(r0) === key(r3), "无 code ⇒ 完全一致");
  ok(r0.seqDir === null && r3.seqDir === null, "seqDir = null（观测到已回落）");
}

function test16_seqDuplicateCodes() {
  console.log("⑯ 站码在站序里出现多次 ⇒ 回落旧解（不冒险）");
  const pts = shuttle();
  const poly = toPoly(pts);
  const b = midway(10);
  const a = midway(30);
  const board = { code: "B", lng: b.lng, lat: b.lat };
  const alight = { code: "A", lng: a.lng, lat: a.lat };
  const base: RouteShapeLite = { dir: "0", polyline: poly, startStop: "S", endStop: "S" };
  const stations: RouteStopSeq[] = [
    { code: "B", seq: 0 }, // B 出现两次 ⇒ 第几次经过不可判
    { code: "A", seq: 1 },
    { code: "S2", seq: 2 },
    { code: "B", seq: 3 },
  ];
  const L = chooseShape([base], board, alight)!;
  const N = chooseShape([{ ...base, stations }], board, alight)!;
  ok(N.iBoard === L.iBoard && N.iAlight === L.iAlight, "回落旧解（下标一致）");
  ok(N.repicked === false, "未重选");
}

function test17_buildColoredLegsSeqWiring() {
  console.log("⑰ buildColoredLegs 透传 stations（腿级接线正确）");
  const pts = shuttle();
  const poly = toPoly(pts);
  const b = nearReturn(10);
  const a = nearOut(30);
  const stations: RouteStopSeq[] = [
    { code: "S0", seq: 0 }, { code: "S1", seq: 1 }, { code: "B", seq: 2 }, { code: "S3", seq: 3 },
    { code: "A", seq: 4 }, { code: "S5", seq: 5 }, { code: "S6", seq: 6 }, { code: "S7", seq: 7 },
    { code: "S8", seq: 8 }, { code: "S9", seq: 9 },
  ];
  const leg = {
    index: 0, route: "T1", kind: "bus" as const, color: null,
    board: { code: "B", lng: b.lng, lat: b.lat },
    alight: { code: "A", lng: a.lng, lat: a.lat },
  };
  const withoutSeq = buildColoredLegs([leg], { T1: [{ dir: "0", polyline: poly, startStop: "S", endStop: "S" }] });
  const withSeq = buildColoredLegs([leg], { T1: [{ dir: "0", polyline: poly, startStop: "S", endStop: "S", stations }] });
  const lA = cumDistM(withoutSeq[0].colored).slice(-1)[0];
  const nA = cumDistM(withSeq[0].colored).slice(-1)[0];
  ok(nA < lA, `腿级接线生效（${lA.toFixed(0)}m → ${nA.toFixed(0)}m）`);
  ok(withSeq[0].degraded === false && withoutSeq[0].degraded === false, "两者都不降级");
  ok(withSeq[0].colored !== withSeq[0].gray, "切割成功（非整线着色）");
  ok(near(withSeq[0].colored[0], pts[10]), "彩段首点 = 上车站落点");
}

/**
 * 「去—回两条平行线」夹具（**非环线**，需首尾相距 > LOOP_EPS_M，故两线间距可放大到 ~44m）。
 * 用来制造「同一站被经过两趟、且两趟投影距离差很大」的场景。
 */
function shuttleOpen(N = 30, step = 0.0002, gapDeg = 0.0004): LL[] {
  const out: LL[] = [];
  for (let i = 0; i <= N; i++) out.push([113.5 + i * step, LAT_A]);
  for (let k = 0; k <= N; k++) out.push([113.5 + (N - k) * step, LAT_A + gapDeg]);
  return out;
}

function test18_proximityGuard() {
  console.log("⑱ 投影邻近度护栏：为缩弧长把锚点甩到容差边缘 ⇒ 拒绝重选（锚点保真优先）");
  const N = 30;
  const outPts = shuttleOpen(N);
  const poly = toPoly(outPts);
  // B 站：正对**回程**顶点 20（≈0m），而正确的「去程那一趟」距 44m
  const b = { lng: 113.5 + 20 * 0.0002, lat: LAT_A + 0.0004 };
  // A 站：正对**去程**顶点 28
  const a = { lng: 113.5 + 28 * 0.0002, lat: LAT_A };
  const stations: RouteStopSeq[] = [
    { code: "B", seq: 0 },
    { code: "S1", seq: 1 },
    { code: "S2", seq: 2 },
    { code: "A", seq: 3 },
  ];
  const base: RouteShapeLite = { dir: "0", polyline: poly };
  const pts = parsePolyline(poly);
  ok(!isLoop(pts), "夹具为非环线（首尾相距 > LOOP_EPS_M）⇒ 两线间距可放大到 ~44m");

  const tripsB = nearestTrips(pts, b);
  ok(tripsB.length === 2, `B 站识别出 2 趟（实际 ${tripsB.length}）`);
  const dB = tripsB.map((t) => t.distM).sort((x, y) => x - y);
  ok(dB[1] - dB[0] > 25, `两趟投影距离差 > 25m（${dB[0].toFixed(0)}m vs ${dB[1].toFixed(0)}m）⇒ 护栏应生效`);

  const L = chooseShape([base], b, a)!;
  const Nw = chooseShape([{ ...base, stations }], b, a)!;
  ok(L.iBoard === N + 1 + (N - 20), `旧解锚点落在最近顶点（${L.iBoard}，回程 lng=113.5+${N - 20}step）`);
  ok(Nw.repicked === false, "未发生重选（不把起点甩到 44m 外去换短弧长）");
  ok(Nw.iBoard === L.iBoard, "起点索引不变 ⇒ 彩段仍从站点旁的顶点起画");
  const drift =
    distM(pts[Nw.iBoard], [b.lng, b.lat]) - distM(pts[L.iBoard], [b.lng, b.lat]);
  ok(Math.abs(drift) < 1, `起锚距站变化 ≈ 0（${drift.toFixed(1)}m）`);
}

function test20_allBlockedFallsBackToBase() {
  console.log("⑳ 全部候选被挡 ⇒ 回落现状解（不是空值、不降级为整线着色）");
  const pts = shuttle();
  const poly = toPoly(pts);
  const b = nearOut(10);
  const a = nearOut(30);
  const board = { code: "B", lng: b.lng, lat: b.lat };
  const alight = { code: "A", lng: a.lng, lat: a.lat };
  const base: RouteShapeLite = { dir: "0", polyline: poly, startStop: "S", endStop: "S" };

  /**
   * 构造「所有候选都被判据挡掉」：把 B 放在站序**最后**、A 放在**最前** ⇒
   * 环线 `hops = stopCount − pb + pa` 极大 ⇒ `hopFloor` 抬高到远超任何候选弧长
   * ⇒ ②（可信下限）必然全部 `continue` ⇒ 只能回落现状解。
   * （这也是 `MAX_GROW_RATIO` 那道门被触发时的同一条回落链路：
   *   任一门 `continue` 掉全部候选 ⇒ `repicked` 保持 false ⇒ `return { ...base }`。）
   */
  const stations: RouteStopSeq[] = [
    { code: "A", seq: 0 },
    { code: "S1", seq: 1 },
    { code: "S2", seq: 2 },
    { code: "S3", seq: 3 },
    { code: "S4", seq: 4 },
    { code: "S5", seq: 5 },
    { code: "S6", seq: 6 },
    { code: "S7", seq: 7 },
    { code: "S8", seq: 8 },
    { code: "B", seq: 9 },
  ];

  const L = chooseShape([base], board, alight)!;
  const Nw = chooseShape([{ ...base, stations }], board, alight)!;

  // ── 第一层：配对层必须回落「现状解」而不是空值 ──
  ok(Nw !== null, "chooseShape 不返回 null（不触发调用方的整线着色降级分支）");
  ok(Nw.iBoard === L.iBoard, `iBoard 回落现状解（${Nw.iBoard} === ${L.iBoard}）`);
  ok(Nw.iAlight === L.iAlight, `iAlight 回落现状解（${Nw.iAlight} === ${L.iAlight}）`);
  ok(Nw.repicked === false, "repicked=false（未发生重选）");
  ok(Nw.loop === L.loop && Nw.dir === L.dir, "loop / dir 均与现状解一致（车辆方向不受影响）");

  // ── 第二层：腿级必须仍然「切出彩段」，绝不是整线着色 ──
  const leg = {
    index: 0, route: "T20", kind: "bus" as const, color: null,
    board: { code: "B", lng: b.lng, lat: b.lat },
    alight: { code: "A", lng: a.lng, lat: a.lat },
  };
  const outBase = buildColoredLegs([leg], { T20: [base] });
  const outSeq = buildColoredLegs([leg], { T20: [{ ...base, stations }] });
  ok(outSeq[0].degraded === false, "degraded=false（回落 ≠ 降级）");
  ok(outSeq[0].colored !== outSeq[0].gray, "colored !== gray ⇒ 彩段仍被切出（不是整线着色）");
  ok(
    cumDistM(outSeq[0].colored).slice(-1)[0] === cumDistM(outBase[0].colored).slice(-1)[0],
    "彩段里程与「无 stations」逐字节相同（回落等价）",
  );
  ok(near(outSeq[0].colored[0], outBase[0].colored[0]), "彩段首点与现状解一致");
  ok(
    near(outSeq[0].colored[outSeq[0].colored.length - 1], outBase[0].colored[outBase[0].colored.length - 1]),
    "彩段末点与现状解一致",
  );
}

function test19_neverLongerSweep() {
  console.log("⑲ 永不变长（遍历全部夹具站对：新弧长恒 ≤ 旧弧长）");
  const pts = shuttle();
  const poly = toPoly(pts);
  const stations: RouteStopSeq[] = [
    { code: "S0", seq: 0 }, { code: "S1", seq: 1 }, { code: "S2", seq: 2 }, { code: "S3", seq: 3 },
    { code: "S4", seq: 4 }, { code: "S5", seq: 5 }, { code: "S6", seq: 6 }, { code: "S7", seq: 7 },
    { code: "S8", seq: 8 }, { code: "S9", seq: 9 }, { code: "S10", seq: 10 }, { code: "S11", seq: 11 },
  ];
  const base: RouteShapeLite = { dir: "0", polyline: poly, startStop: "S", endStop: "S" };
  const withSeq: RouteShapeLite = { ...base, stations };
  // 站台坐标：让每条站码都落在两条线之间/附近，制造大量双趟场景
  const pos = new Map<string, { lng: number; lat: number }>();
  for (const s of stations) {
    const step = Number(s.code.slice(1));
    pos.set(s.code, { lng: 113.5 + step * 4 * 0.0002, lat: LAT_B - 0.00007 });
  }
  let cmp = 0;
  let grew = 0;
  let worst = 0;
  for (const b of stations) {
    for (const a of stations) {
      if (b.seq >= a.seq) continue;
      const bp = pos.get(b.code)!;
      const ap = pos.get(a.code)!;
      const board = { code: b.code, ...bp };
      const alight = { code: a.code, ...ap };
      const L = chooseShape([base], board, alight);
      const N = chooseShape([withSeq], board, alight);
      if (!L || !N) continue;
      const c0 = cutColored(L.pts, L.iBoard, L.iAlight, L.loop);
      const c1 = cutColored(N.pts, N.iBoard, N.iAlight, N.loop);
      if (!c0 || c0.length < 2 || !c1 || c1.length < 2) continue;
      const a0 = cumDistM(c0).slice(-1)[0];
      const a1 = cumDistM(c1).slice(-1)[0];
      if (!Number.isFinite(a0) || !Number.isFinite(a1)) continue;
      cmp++;
      if (a1 > a0 + 1e-6) {
        grew++;
        worst = Math.max(worst, a1 - a0);
      }
    }
  }
  ok(cmp > 30, `遍历 ${cmp} 组站对`);
  ok(grew === 0, `变长 0 组（实际 ${grew}）${grew ? `，最大 +${worst.toFixed(0)}m` : ""}`);
}

async function testReal(pool: Pool) {
  console.log("⑩ 真实数据对拍（route_shapes 26 环线 + 51A）");
  const q = async (code: string) =>
    (
      await pool.query(
        `SELECT dsat_dir, polyline, start_stop, end_stop FROM route_shapes WHERE route_code=$1 ORDER BY dsat_dir`,
        [code],
      )
    ).rows as { dsat_dir: string; polyline: string; start_stop: string | null; end_stop: string | null }[];

  // ── 26 号环线：首尾闭合 + 环绕切分 ──
  const rows26 = await q("26");
  if (!rows26.length) {
    console.log("  ⚠️ 26 无 route_shapes 数据 → 跳过该子项");
  } else {
    const pts = parsePolyline(rows26[0].polyline);
    ok(pts.length > 50, `26 polyline 点数 > 50（实际 ${pts.length}）`);
    const loop = isLoop(pts, rows26[0].start_stop, rows26[0].end_stop);
    ok(loop, "26 判定为环线（闭合 / 首尾同站）");
    const n = pts.length;
    // board 靠尾、alight 靠首 ⇒ 触发环绕
    const iB = Math.round(n * 0.8);
    const iA = Math.round(n * 0.2);
    const board = { code: "B", lng: pts[iB][0], lat: pts[iB][1] };
    const alight = { code: "A", lng: pts[iA][0], lat: pts[iA][1] };
    const shapes: RouteShapeLite[] = rows26.map((r) => ({
      dir: r.dsat_dir,
      polyline: r.polyline,
      startStop: r.start_stop,
      endStop: r.end_stop,
    }));
    const out = buildColoredLegs(
      [{ index: 0, route: "26", kind: "bus", color: null, board, alight }],
      { "26": shapes },
    );
    const leg = out[0];
    ok(leg.colored.length <= leg.gray.length + 1, "colored 长度 ≤ gray + 1");
    ok(leg.colored.length > 0, "环绕彩段非空");
    ok(
      near(leg.colored[0], [board.lng, board.lat], 1),
      "colored 起点 ≈ board",
    );
    ok(
      near(leg.colored[leg.colored.length - 1], [alight.lng, alight.lat], 1),
      "colored 终点 ≈ alight",
    );
  }

  // ── 51A：双向 shape → chooseShape 选一 ──
  const rows51 = await q("51A");
  if (rows51.length < 1) {
    console.log("  ⚠️ 51A 无 route_shapes 数据 → 跳过该子项");
  } else {
    const pts = parsePolyline(rows51[0].polyline);
    ok(pts.length > 50, `51A polyline 点数 > 50（实际 ${pts.length}）`);
    const n = pts.length;
    const board = { code: "B", lng: pts[Math.round(n * 0.2)][0], lat: pts[Math.round(n * 0.2)][1] };
    const alight = { code: "A", lng: pts[Math.round(n * 0.7)][0], lat: pts[Math.round(n * 0.7)][1] };
    const shapes: RouteShapeLite[] = rows51.map((r) => ({
      dir: r.dsat_dir,
      polyline: r.polyline,
      startStop: r.start_stop,
      endStop: r.end_stop,
    }));
    const picked = chooseShape(shapes, board, alight);
    ok(!!picked, "51A 能选出一个方向");
    if (picked) {
      ok(picked.dBoard <= 1 && picked.dAlight <= 1, "选中方向 board/alight 在线上（<1m）");
      const out = buildColoredLegs(
        [{ index: 0, route: "51A", kind: "bus", color: null, board, alight }],
        { "51A": shapes },
      );
      ok(out[0].colored.length <= out[0].gray.length, "51A colored ≤ gray");
      ok(out[0].colored[0] && near(out[0].colored[0], [board.lng, board.lat], 1), "51A colored 起点 ≈ board");
    }
  }
}

/**
 * ⑱ 真实卡「完整指纹」对拍（★ 4-B− 的验收靶子 + 无回归对照集）
 *
 * 指纹 = `dir|iBoard|iAlight|彩段里程(取整)|最南纬度(4位)`。
 * 其中 **4 张已核对正确的卡** 是宝贵的对照集：加了站序之后它们的指纹必须**一位不变**；
 * `planId 900001 / 25 号线` 是用户实测缺陷的靶子，指纹必须**按预期改变**。
 */
async function testFingerprint(pool: Pool) {
  console.log("⑱ 真实卡指纹对拍（4 张对照集必须不变 + 25 号靶子必须修正）");
  const { wgs84ToGcj02 } = await import("../src/lib/amap/coord");
  const mainOf = (c: string) => c.replace(/\/\d+$/, "");

  const stRows = (await pool.query(`SELECT code, lat, lng FROM stations`)).rows as {
    code: string; lat: number; lng: number;
  }[];
  const S = new Map<string, LL>();
  for (const s of stRows) {
    const g = wgs84ToGcj02({ lat: Number(s.lat), lng: Number(s.lng) });
    S.set(mainOf(String(s.code)), [g.lng, g.lat]);
  }

  const seqRows = (
    await pool.query(
      `SELECT r.code AS route, rs.dsat_dir AS dir, rs.station_code AS code
         FROM route_stations rs JOIN routes r ON r.id = rs.route_id
        ORDER BY r.code, rs.dsat_dir, rs.seq`,
    )
  ).rows as { route: string; dir: string; code: string }[];
  const seqBy = new Map<string, RouteStopSeq[]>();
  for (const r of seqRows) {
    const k = `${r.route}|${r.dir}`;
    const arr = seqBy.get(k) ?? [];
    const last = arr[arr.length - 1];
    if (last && last.code === mainOf(r.code)) continue; // 相邻站台折叠（与 API 同口径）
    arr.push({ code: mainOf(r.code), seq: arr.length });
    seqBy.set(k, arr);
  }

  const q = async (code: string) =>
    (
      await pool.query(
        `SELECT dsat_dir, polyline, start_stop, end_stop FROM route_shapes WHERE route_code=$1 ORDER BY dsat_dir`,
        [code],
      )
    ).rows as { dsat_dir: string; polyline: string; start_stop: string | null; end_stop: string | null }[];

  /** 线上 5 张卡（`.verify/_q4-nav.json`） */
  const CARDS: { planId: number; route: string; board: string; alight: string; expect: string }[] = [
    { planId: 1, route: "26A", board: "C653", alight: "T363", expect: "unchanged" },
    { planId: 3, route: "26", board: "C653", alight: "T374", expect: "unchanged" },
    { planId: 900003, route: "26A", board: "C653", alight: "T367", expect: "unchanged" },
    { planId: 900000, route: "21A", board: "C653", alight: "T306", expect: "unchanged" },
    { planId: 900001, route: "25", board: "C653", alight: "T306", expect: "fixed" },
  ];

  const fingerprint = (
    shapes: RouteShapeLite[],
  ): { fp: string; arc: number; south: number; loop: boolean; dir: string } | null => {
    const picked = chooseShape(shapes, boardCur, alightCur, 80);
    if (!picked) return null;
    const cc = cutColored(picked.pts, picked.iBoard, picked.iAlight, picked.loop);
    if (!cc || cc.length < 2) return null;
    const arc = cumDistM(cc).slice(-1)[0];
    let south = cc[0];
    for (const p of cc) if (p[1] < south[1]) south = p;
    return {
      fp: `${picked.dir}|${picked.iBoard}|${picked.iAlight}|${Math.round(arc)}|${south[1].toFixed(4)}`,
      arc,
      south: south[1],
      loop: picked.loop,
      dir: picked.dir ?? "",
    };
  };
  let boardCur = { code: "", lng: 0, lat: 0 };
  let alightCur = { code: "", lng: 0, lat: 0 };

  for (const card of CARDS) {
    const rows = await q(card.route);
    if (!rows.length) {
      console.log(`  ⚠️ ${card.route} 无 route_shapes ⇒ 跳过 planId ${card.planId}`);
      continue;
    }
    const b = S.get(mainOf(card.board));
    const a = S.get(mainOf(card.alight));
    if (!b || !a) {
      console.log(`  ⚠️ ${card.board}/${card.alight} 无坐标 ⇒ 跳过 planId ${card.planId}`);
      continue;
    }
    boardCur = { code: mainOf(card.board), lng: b[0], lat: b[1] };
    alightCur = { code: mainOf(card.alight), lng: a[0], lat: a[1] };
    const legacy: RouteShapeLite[] = rows.map((r) => ({
      dir: r.dsat_dir, polyline: r.polyline, startStop: r.start_stop, endStop: r.end_stop,
    }));
    const withSeq: RouteShapeLite[] = legacy.map((l) => ({
      ...l, stations: seqBy.get(`${card.route}|${l.dir}`) ?? [],
    }));
    const L = fingerprint(legacy);
    const N = fingerprint(withSeq);
    if (!L || !N) {
      console.log(`  ⚠️ ${card.route} 两方向均超容差 ⇒ 跳过 planId ${card.planId}`);
      continue;
    }
    if (card.expect === "unchanged") {
      ok(N.fp === L.fp, `planId ${card.planId}（${card.route}）指纹不变 ${
        N.fp === L.fp ? `【${L.fp}】` : `旧【${L.fp}】新【${N.fp}】`
      }`);
    } else {
      ok(N.dir === "0", `planId ${card.planId}（25 号）方向仍为 dir=0（车辆方向不得翻转）`);
      ok(N.loop === true, "25 号仍判为闭合环");
      ok(N.arc >= 3500 && N.arc <= 3600, `25 号彩段里程 ≈ 3549m（实际 ${Math.round(N.arc)}m）`);
      ok(N.south >= 22.125 && N.south <= 22.126, `25 号最南点 lat ≈ 22.1255（实际 ${N.south.toFixed(4)}，旧 ${L.south.toFixed(4)}）`);
      ok(N.south > L.south, "最南点不再落到路環市區（纬度北移）");
      ok(L.arc > N.arc + 3000, `旧解绕远已消除（${Math.round(L.arc)}m → ${Math.round(N.arc)}m）`);
    }
  }
}

async function main() {
  test1_parsePolyline();
  test2_nearestOnPath();
  test3_cutForward();
  test4_cutReverse();
  test5_loopWrap();
  test6_chooseShape();
  test7_degradeMissingRoute();
  test8_boardEqAlight();
  testExtra_geom();
  test11_nearestTrips();
  test12_arcMiles();
  test13_seqShortestArc();
  test14_seqNeverLonger();
  test15_seqMissingFallback();
  test16_seqDuplicateCodes();
  test17_buildColoredLegsSeqWiring();
  test18_proximityGuard();
  test19_neverLongerSweep();
  test20_allBlockedFallsBackToBase();

  /**
   * ── 用例 ⑩ / ⑱：连库对拍 ────────────────────────────────────────────────
   *
   * ★ 严格区分三种结局（旧实现把三者混成一种，是「跳过型假绿」的根源）：
   *   ① **库不可达**（无 URL / 连不上 / 探测失败）⇒ `skip`（环境问题，不是代码问题）
   *   ② **库通了但用例内部抛错 / 断言失败** ⇒ `fail`（真实缺陷，必须红）
   *   ③ 跑完 ⇒ 正常计入 `pass`
   *
   * ⇒ 先做一次 `SELECT 1` 探测：探测失败才允许 skip；探测成功后的任何异常都算 fail。
   *   否则「库通了但 SQL 写错」会被误当成「环境没库」静默跳过 —— 那比假绿更危险。
   *
   * ★ 两个用例**各自独立 try/catch**：旧实现共用一个，`testReal` 抛错会把
   *   `testFingerprint`（需求 4 的靶子验收）一起吞掉。
   */
  let pool: import("pg").Pool | null = null;
  let dbReason: string | null = null;
  try {
    process.loadEnvFile();
    const url = process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL;
    if (!url) throw new Error("无 DATABASE_URL / DATABASE_URL_LOCAL");
    const { default: PG } = await import("pg");
    const p = new PG.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
    p.on("error", () => {});
    // 连通性探测：能连上 ⇒ 后续一切异常都归因于代码/数据，不得再 skip
    await p.query("SELECT 1");
    pool = p;
  } catch (e) {
    dbReason = (e as Error).message;
  }

  if (!pool) {
    skipCase("⑩", "真实数据对拍（route_shapes 26 环线 + 51A）", dbReason ?? "库不可达");
    skipCase(
      "⑱",
      "真实卡指纹对拍（4 张对照集 + 25 号靶子 iBoard=539/3549m/22.1255）",
      dbReason ?? "库不可达",
    );
  } else {
    try {
      await testReal(pool);
    } catch (e) {
      // 库是通的 ⇒ 这里的异常属真实缺陷，计 fail 而不是 skip
      fail++;
      console.error(`  ❌ ⑩ 真实数据对拍抛错（库已连通，属真实缺陷）：${(e as Error).message}`);
    }
    try {
      await testFingerprint(pool);
    } catch (e) {
      fail++;
      console.error(`  ❌ ⑱ 真实卡指纹对拍抛错（库已连通，属真实缺陷）：${(e as Error).message}`);
    }
    await pool.end().catch(() => {});
  }

  /* ── 末尾汇总：pass / fail / **skip 三者都必须可见** ── */
  const requireDb = process.env.REQUIRE_DB === "1";
  if (skip > 0) {
    const bar = "=".repeat(72);
    console.log(`\n${bar}`);
    console.log(`⚠️  未完整验证 —— ${skip} 个用例被跳过（**不计入 pass**）`);
    for (const s of skipped) console.log(`   · ${s.id} ${s.name}\n     原因：${s.reason}`);
    if (skipped.some((s) => s.id === "⑱")) {
      console.log(`   ⚠️ 其中 ⑱ 是**需求 4 的验收依据**（4 张卡指纹 + 25 号靶子），`);
      console.log(`      它没跑 ⇒ 本次结果**不能**作为「彩段几何修复已验证」的证据。`);
    }
    console.log(`   补齐方式：在项目根建 .env 并配 DATABASE_URL，或设 DATABASE_URL_LOCAL。`);
    if (requireDb) console.log(`   REQUIRE_DB=1 ⇒ 按 CI 口径判定为**失败**（exit 2）。`);
    console.log(bar);
  }

  const verdict = fail > 0 ? "❌ 存在失败" : skip > 0 ? "⚠️ 未完整验证" : "✅ 全部通过";
  console.log(`\n${verdict}：pass=${pass} fail=${fail} skip=${skip}${skip > 0 ? " ⚠️" : ""}`);

  if (fail > 0) process.exit(1);
  /**
   * 退出码策略（skip>0 时）：
   *   · 默认 **exit 0** —— 无库环境（本地新克隆、只跑纯函数门）不该红，
   *     否则「为了让 CI 绿而把脚本从流水线摘掉」比假绿更糟；
   *   · `REQUIRE_DB=1` ⇒ **exit 2** —— CI 里显式声明「本环境必须有库」，
   *     此时跳过即视为失败。用 2 而不是 1，便于在流水线里区分
   *     「断言失败(1)」与「未完整验证(2)」。
   */
  if (skip > 0 && requireDb) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
