/**
 * scripts/test-boarding-detect.ts —— ★ v3.6.0 S3 上车判定纯函数对拍
 *
 * 为什么必须有这份：上车判定是「沉默逻辑错误」最高危的地方 ——
 *   · 误判 = 用户还没上车就被切进"乘车中"，进度/到站提醒全错；
 *   · 漏判 = 用户已经在车上却一直显示"等待上车"。
 * 这两种都不会抛异常、不会报错，只能靠纯函数对拍把边界钉死
 * （见 references/01-standards/generated-code-failure-modes.md §2）。
 *
 * 断言口径 = 架构 §3.1 判定模型（定位主导 + 车辆只降门槛）。
 *
 * 跑法（铁律 17：npx 本机可能静默失效 ⇒ 直喂 tsx CLI 实体）：
 *   node node_modules/tsx/dist/cli.mjs scripts/test-boarding-detect.ts
 */
import {
  ANOMALY_CONFIRM,
  ANOMALY_MIN_GAP_MS,
  AUTO_TRIES_PER_LEG,
  BOARDING_START_GRACE_MS,
  R1_ACCEL_DISPLACE_FACTOR,
  R2_DISPLACE_MIN_M,
  R2_FIX_MAX_ACC_M,
  R2_SPEED_MAX_KMH,
  R2_STREAK_ALONE,
  R2_STREAK_WITH_VEHICLE,
  R2_TOL_M,
  SWITCH_COOLDOWN_MS,
  atBoardStopOf,
  autoBoardOf,
  auxOf,
  detectPausedOf,
  GPS_PAUSE_MS,
  nextLegCooldownOf,
  r2Of,
  type AutoBoardInput,
  type FixLite,
} from "@/lib/nav/boarding-detect";
import { alignedDOf, departedCandidatesOf, pickLockPlateOf } from "@/lib/nav/plate-lock";
import {
  FOLLOW_MAX_SLOPE_MPS,
  FOLLOW_MIN_ALONG_M,
  FOLLOW_MIN_FRAMES,
  followSlopeOf,
} from "@/lib/nav/follow-slope";
import { followFramesOf, type FollowFrame, type VehFrame } from "@/lib/nav/follow-frames";
import type { TrackVehicle } from "@/lib/nav/track";
import type { LL } from "@/lib/nav/route-overview";

/* ── 断言器（禁硬编码聚合；逐条打点）──────────────────────────────── */
let fail = 0;
let pass = 0;
function ok(cond: boolean, name: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(Object.is(actual, expected), name, `实际=${String(actual)} 期望=${String(expected)}`);
}

/* ── 几何夹具：一条正东向直线（GCJ-02），覆盖 -400m ~ +1600m ─────────
   1 度经度 ≈ 111320·cos(22.15°) ≈ 103,140 m。
   ★ 顶点必须**密**（2m 一个）：`r2Of` 的沿线位移用「最近顶点里程差」量化，
     量化误差 ≈ ±STEP_M；顶点越稀，位移门的边界越不可靠
     （10m 顶点时「12 km/h × 20s = 66.7m」会被量成 40m ⇒ 假失败）。
     生产环境的 `route_shapes` 顶点是密集的，夹具必须同构，否则测试是测夹具不是测逻辑。

   ★★ 2026-11-03 修正（需求 6 研判结论）：**`PATH[0]` 必须就是上车站**。
     本夹具原先从 **−400m** 起，理由是「`fixesOf` 的早帧落在起点以西，否则投影距离超 tol
     假失败」—— 但这违反生产契约 `colored[0] === board`（`buildColoredLegs` 的分支⑤
     恒返回 `slice(iBoard, iAlight+1)`，而 `iBoard` 距 board ≤ tolM）。
     违法代价（实测，见 `docs/迭代-导航优化-20261102/23-*`）：站前那段**根本不存在**的
     折线让「站前位移」变得可测 ⇒ 造出 v3.10.0「跑 24s 会误判」这个**生产上不可能发生**
     的结论，进而给真实乘车加了 +6s（需求 6 的立项原因）。
     ⇒ 现在 `PATH` 从 0 起、只向**前**延伸；需要「站前接近」的用例请让 fix 落在**路线外**
        （投影会自动钳到 `idx=0`，`distM > tol` 也照实触发 —— 这正是生产行为）。 */
const BASE_LNG = 113.55;
const BASE_LAT = 22.15;
const STEP_M = 2;
const DEG_PER_M_LNG = 1 / 103_140;
const PATH: LL[] = Array.from({ length: 1001 }, (_, i) => {
  const m = i * STEP_M; // 0m（= 上车站）… +2000m
  return [BASE_LNG + m * DEG_PER_M_LNG, BASE_LAT] as LL;
});
/** 沿线相对 BASE_LNG 的第 `meters` 米处（可为负 = 站前，落在**路线外**） */
const atM = (meters: number): { lng: number; lat: number } => ({
  lng: BASE_LNG + meters * DEG_PER_M_LNG,
  lat: BASE_LAT,
});

/** 构造 n 个采样点：**最后一帧**落在 `startM` 与 `endTs`，往前按 speedKmh / gapMs 回推 */
function fixesOf(startM: number, speedKmh: number, n: number, gapMs: number, endTs = 100_000): FixLite[] {
  const mps = speedKmh / 3.6;
  const out: FixLite[] = [];
  for (let i = 0; i < n; i++) {
    const dtMs = (i - (n - 1)) * gapMs; // 末帧 = 0
    const p = atM(startM + mps * (dtMs / 1000));
    out.push({ lng: p.lng, lat: p.lat, accuracy: 10, ts: endTs + dtMs });
  }
  return out;
}

/**
 * ★ 2026-11-03 新增：**从上车站起、沿线路向前行**的 n 帧。
 *
 * 为什么需要它：`PATH[0]` 已改为上车站（守住 `colored[0] === board`），
 * 因此「已上车并随车前进」的用例**必须**从 0 起向正方向展开；
 * 旧写法 `fixesOf(0, …)` 会跑到站前（路线外），那在正确几何下本就不该命中。
 *
 * @param kmh 车速；@param n 帧数；@param gapMs 帧间隔
 */
function fixesFromStation(kmh: number, n: number, gapMs: number, endTs = 100_000): FixLite[] {
  const mps = kmh / 3.6;
  return fixesOf(mps * (n - 1) * (gapMs / 1000), kmh, n, gapMs, endTs);
}


/** 本段站序主码（下标 0 = 上车站 T100）—— 锁牌的 L-b 判据用 */
const STOP_MAINS = ["T100", "T101", "T102", "T103"];

/** 基准输入：几何可用、无车、冷却已过、未触发过 */
function inputOf(patch: Partial<AutoBoardInput> = {}): AutoBoardInput {
  return {
    legKind: "bus",
    legDegraded: false,
    colored: PATH,
    boardMain: "T100",
    boardPos: { ...atM(0) },
    stopMains: STOP_MAINS,
    vehicles: [],
    vehFrames: [],
    fixes: [],
    lastSwitchTs: 0,
    nowMs: 1_000_000,
    autoLeft: AUTO_TRIES_PER_LEG,
    streak: 0,
    ...patch,
  };
}

/**
 * ★ I-3 夹具：把「每帧的用户里程 / 车辆里程」直接写成定位帧 + 车辆帧历史。
 *
 * 为什么必须给**车辆帧历史**而不只是当前一帧车辆：斜率判据要在两帧车辆快照之间
 * 内插出 `v(t)`，把车辆里程对齐到用户定位的时间戳。本夹具让车辆帧与定位帧同戳
 * （取端点，不引入内插误差）；内插本身另有专门用例（⑯-e）。
 */
function fixesAt(uM: number[], gapMs = 3_000, startTs = 100_000): FixLite[] {
  return uM.map((m, i) => {
    const p = atM(m);
    return { lng: p.lng, lat: p.lat, accuracy: 10, ts: startTs + i * gapMs };
  });
}

function vehAt(plate: string, m: number, ts: number, extra: Partial<TrackVehicle> = {}): VehFrame {
  const p = atM(m);
  return {
    ts,
    vehicles: [
      {
        plate,
        lat: p.lat,
        lng: p.lng,
        status: "moving",
        interval: { from: { code: "T100" }, to: { code: "T101" } },
        atStation: null,
        ...extra,
      },
    ],
  };
}

function vehHistOf(plate: string, vM: number[], extra: Partial<TrackVehicle> = {}): VehFrame[] {
  return vM.map((m, i) => vehAt(plate, m, 100_000 + i * 3_000, extra));
}

function followFixture(o: {
  uM: number[];
  vM: number[];
  gapMs?: number;
  startTs?: number;
  plate?: string;
}): { fixes: FixLite[]; vehFrames: VehFrame[] } {
  const plate = o.plate ?? "MB0001";
  return {
    fixes: fixesAt(o.uM, o.gapMs, o.startTs),
    vehFrames: o.vM.map((m, i) => vehAt(plate, m, (o.startTs ?? 100_000) + i * (o.gapMs ?? 3_000))),
  };
}

/**
 * 车：刚从本站开走（A1 = strong）
 *
 * ⚠️ 2026-11-05 修正：原夹具同时给了 `interval` 与 `atStation`，**这不代表任何真实帧**。
 *   `route-vehicles.ts:208-214` 里两者互斥：`status="1"` ⇒ 只填 `atStation`；
 *   `status="0"` ⇒ 只填 `interval`。0/1 两态不会并存。
 *   停站判据只看 `atStation` ⇒ 若夹具带着 `atStation`，"车刚开走"会被误当成"车正停靠"。
 *   ⇒ 去掉 `atStation`（移动中的车没有挂靠站），夹具才与生产同构。
 */
const vJustLeft: TrackVehicle = {
  plate: "MA0001",
  lat: atM(120).lat,
  lng: atM(120).lng,
  status: "moving",
  interval: { from: { code: "T100" }, to: { code: "T101" } },
  atStation: null,
};
/** 车：正停靠本站（A2 = weak） */
const vStopping: TrackVehicle = {
  plate: "MA0002",
  lat: atM(0).lat,
  lng: atM(0).lng,
  status: "stopping",
  interval: null,
  atStation: { code: "T100" },
};
/** 车：与本上车站无关 */
const vElsewhere: TrackVehicle = {
  plate: "MA0003",
  lat: atM(800).lat,
  lng: atM(800).lng,
  status: "moving",
  interval: { from: { code: "T900" }, to: { code: "T901" } },
  atStation: null,
};

console.log("═══ v3.6.0 S3 上车判定对拍（定位主导）═══\n");

/* ══════════ ① 核心口径：车辆**单独**绝不可触发 ══════════ */
console.log("[① 车辆不得单独触发]");
{
  const noFix = autoBoardOf(inputOf({ vehicles: [vJustLeft] }));
  eq(noFix.hit, false, "A1 车刚离站 + 无任何定位 ⇒ 不判");
  eq(noFix.streak, 0, "A1 无定位 ⇒ streak 保持 0");

  const stillFixes = fixesOf(0, 0, 4, 5_000); // 站着不动
  const still = autoBoardOf(inputOf({ vehicles: [vJustLeft], fixes: stillFixes }));
  eq(still.hit, false, "A1 车刚离站 + 用户静止 ⇒ 不判（旧版会误判）");

  const twoFrames = fixesOf(0, 20, 2, 10_000);
  const few = autoBoardOf(inputOf({ vehicles: [vJustLeft], fixes: twoFrames }));
  eq(few.hit, false, "可信帧 <3 ⇒ 不判（即便有车佐证）");
}

/* ══════════ ② 定位主导：纯定位可命中，且需要 3 连帧 ══════════ */
console.log("\n[② 纯定位主导]");
{
  const fixes = fixesFromStation(20, 3, 10_000); // 20s 走 111m，3 帧（自上车站向前）
  const r1 = autoBoardOf(inputOf({ fixes, streak: 0 }));
  eq(r1.hit, true, "沿线移动 20km/h × 20s ⇒ 命中");
  eq(r1.need, R2_STREAK_ALONE, "无车佐证 ⇒ need=3");
  eq(r1.streak, 1, "第 1 帧 streak=1");
  eq(r1.plate, null, "无车佐证 ⇒ 不锁车牌");
  eq(r1.source, "gps", "来源 = gps");
  eq(r1.reason, "gps", "reason = gps");

  const r3 = autoBoardOf(inputOf({ fixes, streak: 2 }));
  eq(r3.streak, 3, "第 3 连续帧 streak=3");
  ok(r3.hit && r3.streak >= r3.need, "第 3 帧满足 hit && streak>=need ⇒ 调用方切换");
}

/* ══════════ ③ 车辆辅助：只降门槛（need 2 + 位移 ×0.6） ══════════ */
console.log("\n[③ 车辆辅助降门槛]");
{
  const fixes = fixesFromStation(20, 3, 10_000);
  const withCar = autoBoardOf(inputOf({ fixes, vehicles: [vJustLeft] }));
  eq(withCar.need, R2_STREAK_WITH_VEHICLE, "A1 佐证 ⇒ need=2");
  eq(withCar.plate, "MA0001", "A1 唯一 ⇒ 锁定该车牌");
  eq(withCar.source, "vehicle", "A1 ⇒ 来源 vehicle");
  eq(withCar.reason, "gps+vehicle", "reason = gps+vehicle");

  /**
   * ★ 2026-11-05：**A2（车停靠本站）作为「只降门槛」的路径已被停站判据取代**。
   *   原因：A2 的判据 `atStation==board && status==="stopping"` 正是停站判据的子集
   *   ⇒ 只要 A2 成立，停站判据必然先命中并 return（`evidence="atstop"`）⇒ 走不到降门槛那段。
   *   ⇒ 这不是缺陷，是负责人裁决（「车停到站 = 已上车」）的必然后果：
   *     A2 从「降门槛」升级为「直接判上」，`need` 由 2 变成 1，且唯一候选时**会锁牌**
   *     （旧的"不锁牌"理由「站里可能多辆」由歧义门覆盖：多辆 ⇒ plate=null）。
   */
  const withWeak = autoBoardOf(inputOf({ fixes, vehicles: [vStopping] }));
  eq(withWeak.need, 1, "A2（车停靠本站）⇒ 现由停站判据直接命中，need=1（不再是降门槛的 2）");
  eq(withWeak.evidence, "atstop", "A2 ⇒ 证据 = atstop（停站判据短路）");
  eq(withWeak.plate, "MA0002", "A2 唯一候选 ⇒ 锁牌（多辆时由歧义门给 null）");
  eq(withWeak.source, "vehicle", "A2 有牌 ⇒ 来源 vehicle");

  const unrelated = autoBoardOf(inputOf({ fixes, vehicles: [vElsewhere] }));
  eq(unrelated.need, R2_STREAK_ALONE, "无关车 ⇒ need 仍 3");
  eq(unrelated.plate, null, "无关车 ⇒ 不锁车牌");

  /**
   * 位移门被降到 0.6 倍的**独立**证明：必须挑一个「速度过门、位移只过缩放后的门」的用例，
   * 否则速度门会先把用例拦掉、证明不了缩放是否生效。
   *   9 km/h × 20s ⇒ 位移 50m；gate(assisted) = max(60, 8/3.6×20)=60 → ×0.6 = 36m ⇒ 50≥36 命中
   *                     gate(alone)    = 60m ⇒ 50<60 不命中
   *   （速度 9 > 8，两条用例速度门都过，差异只可能来自位移门缩放。）
   */
  const midFixes = fixesFromStation(9, 3, 10_000); // 20s × 2.5m/s = 50m（自上车站向前）
  const assisted = autoBoardOf(inputOf({ fixes: midFixes, vehicles: [vJustLeft] }));
  const alone = autoBoardOf(inputOf({ fixes: midFixes, vehicles: [] }));
  eq(assisted.hit, true, `位移 50m 有佐证 ⇒ 命中（门槛 ${R2_DISPLACE_MIN_M}×${R1_ACCEL_DISPLACE_FACTOR}=36m）`);
  eq(alone.hit, false, `位移 50m 无佐证 ⇒ 不命中（门槛 ${R2_DISPLACE_MIN_M}m）`);
}

/* ══════════ ④ 速度门：静止漂移 / 过快 都不判 ══════════ */
console.log("\n[④ 速度门]");
{
  const stand = autoBoardOf(inputOf({ fixes: fixesOf(0, 0, 4, 10_000) }));
  eq(stand.hit, false, "静止（0km/h）⇒ 不判");

  const slow = autoBoardOf(inputOf({ fixes: fixesFromStation(3, 4, 12_000) })); // 3km/h 步行
  eq(slow.hit, false, "步行 3km/h ⇒ 不判（低于 5.5 下限）");

  const fast = autoBoardOf(inputOf({ fixes: fixesFromStation(R2_SPEED_MAX_KMH + 20, 4, 10_000) }));
  eq(fast.hit, false, `>${R2_SPEED_MAX_KMH}km/h ⇒ 不判（视为投影漂移）`);

  /**
   * ⚠️ v3.6.0 起 7 km/h **不再算"随车"**（8 km/h 是步行/车速分界，见 ⑫ 组）——
   *   这里改为「真实车速 12 km/h 必须命中」，与本轮 blocking 改动保持一致。
   */
  const busSlow = autoBoardOf(inputOf({ fixes: fixesFromStation(12, 4, 12_000) }));
  eq(busSlow.hit, true, "12km/h（真实慢速乘车） ⇒ 命中（改阈值后不得漏判）");
}

/* ══════════ ⑤ 邻线门：投影过远不判 ══════════ */
console.log("\n[⑤ 邻线投影门]");
{
  // 整条轨迹搬到北侧 400m 外（远超 tol=80m）
  const offsetLat = BASE_LAT + 400 / 111_320;
  const offPath = PATH.map(([lng, lat]) => [lng, lat + (offsetLat - BASE_LAT)] as LL);
  const fixes = fixesFromStation(20, 3, 10_000).map((f) => ({ ...f, lat: f.lat + (offsetLat - BASE_LAT) }));
  const r = autoBoardOf(inputOf({ colored: offPath, fixes }));
  // 轨迹与采样同时平移 ⇒ 投影距离仍为 0（这是同源平移），应当命中 —— 反向验证门没写死
  eq(r.hit, true, "轨迹与采样同源平移 ⇒ 仍命中（门是相对投影，不是绝对坐标）");

  const r2 = autoBoardOf(
    inputOf({ fixes: fixesFromStation(20, 3, 10_000).map((f) => ({ ...f, lat: f.lat + 400 / 111_320 })) }),
  );
  eq(r2.hit, false, `采样离线 ${R2_TOL_M}m 以上 ⇒ 不判`);
}

/* ══════════ ⑥ 硬门：几何 / 冷却 / 单次会话 ══════════ */
console.log("\n[⑥ 硬门]");
{
  const fixes = fixesFromStation(20, 4, 10_000);

  eq(autoBoardOf(inputOf({ fixes, colored: [] })).hit, false, "几何缺失（colored 空）⇒ 不判");
  eq(autoBoardOf(inputOf({ fixes, colored: [PATH[0]] })).hit, false, "几何仅 1 点 ⇒ 不判");
  eq(autoBoardOf(inputOf({ fixes, legDegraded: true })).hit, false, "legDegraded ⇒ 不判（旧版巴士会退化成 R1-only）");

  eq(autoBoardOf(inputOf({ fixes, autoLeft: 0 })).hit, false, "本腿自动判定次数用尽 ⇒ 不判");

  const cooling = autoBoardOf(
    inputOf({ fixes, lastSwitchTs: 1_000_000 - (SWITCH_COOLDOWN_MS - 1), nowMs: 1_000_000 }),
  );
  eq(cooling.hit, false, "冷却未过 ⇒ 不判");

  const cooled = autoBoardOf(
    inputOf({ fixes, lastSwitchTs: 1_000_000 - SWITCH_COOLDOWN_MS, nowMs: 1_000_000 }),
  );
  eq(cooled.hit, true, "冷却刚到 ⇒ 可判");
}

/* ══════════ ⑦ 轻轨：收紧档、无车牌 ══════════ */
console.log("\n[⑦ 轻轨]");
{
  const fast = fixesFromStation(40, 4, 10_000);
  const hit = autoBoardOf(inputOf({ legKind: "lrt", fixes: fast, vehicles: [vJustLeft] }));
  eq(hit.hit, true, "轻轨 40km/h 沿线移动 ⇒ 命中");
  eq(hit.plate, null, "轻轨无逐车数据 ⇒ 不锁车牌");
  eq(hit.source, "gps", "轻轨来源 = gps");
  eq(hit.need, R2_STREAK_ALONE, "轻轨恒需 3 连帧");

  const lightspeed = fixesFromStation(10, 4, 10_000); // 10 < 12 轻轨下限
  eq(autoBoardOf(inputOf({ legKind: "lrt", fixes: lightspeed })).hit, false, "轻轨 10km/h ⇒ 不判（下限 12）");

  eq(
    autoBoardOf(inputOf({ legKind: "lrt", fixes: fast, legDegraded: true })).hit,
    false,
    "轻轨几何缺失 ⇒ 不判",
  );
}

/* ══════════ ⑧ 精度门 ══════════ */
console.log("\n[⑧ 精度门]");
{
  const fixes = fixesFromStation(20, 3, 10_000).map((f) => ({ ...f, accuracy: R2_FIX_MAX_ACC_M + 10 }));
  eq(autoBoardOf(inputOf({ fixes })).hit, false, `所有帧 accuracy > ${R2_FIX_MAX_ACC_M}m ⇒ 全部丢弃，不判`);

  const mixed = fixesFromStation(20, 5, 10_000).map((f, i) => ({ ...f, accuracy: i < 2 ? 500 : 10 }));
  eq(autoBoardOf(inputOf({ fixes: mixed })).hit, true, "仅末 3 帧可信 ⇒ 仍可判（不因历史噪点卡死）");
}

/* ══════════ ⑨ auxOf 语义 ══════════ */
console.log("\n[⑨ auxOf]");
{
  const a1 = auxOf([vJustLeft], "T100");
  ok(a1.strong && !a1.weak && a1.plate === "MA0001", "A1 ⇒ strong + 车牌");

  const a2 = auxOf([vStopping], "T100");
  ok(!a2.strong && a2.weak && a2.plate === "MA0002", "A2 ⇒ weak + 车牌");

  const none = auxOf([vElsewhere], "T100");
  ok(!none.strong && !none.weak && none.plate === null, "无关车 ⇒ 无信号");

  // 主码归一：T100/2 应等于 T100
  const plat = auxOf([vStopping], "T100/2");
  ok(plat.weak, "站台后缀归一（T100/2 → T100）");
}

/* ══════════ ⑩ detectPausedOf（AC-25a） ══════════ */
console.log("\n[⑩ 判定是否已暂停]");
{
  const now = 200_000;
  eq(detectPausedOf([], now), true, "一帧都没有 ⇒ paused");

  const fresh = fixesOf(0, 20, 3, 5_000, now);
  eq(detectPausedOf(fresh, now), false, "刚有可信帧 ⇒ on");

  const stale = fixesOf(0, 20, 3, 5_000, now - GPS_PAUSE_MS - 1);
  eq(detectPausedOf(stale, now), true, `超过 ${GPS_PAUSE_MS}ms 无新帧 ⇒ paused`);

  const bad = fixesOf(0, 20, 2, 500, now).map((f) => ({ ...f, accuracy: R2_FIX_MAX_ACC_M + 1 }));
  eq(detectPausedOf(bad, now), true, "连续 2 帧低精度 ⇒ paused");

  const oneBad = fixesOf(0, 20, 2, 500, now);
  oneBad[0] = { ...oneBad[0], accuracy: 999 };
  eq(detectPausedOf(oneBad, now), false, "仅 1 帧低精度 ⇒ 仍 on（不因偶发噪点停机）");

  /**
   * ★ 启动宽限（advisory）：刚进候车态、一帧都没有时**不得**立刻报 paused ——
   *   否则界面会先闪「定位不可用 · 判定已暂停」再转正常（首帧 1~3s 才到）。
   */
  eq(detectPausedOf([], now, now - 1_000), false, "启动 1s（宽限内）且无帧 ⇒ 不判 paused（防首帧闪烁）");
  eq(
    detectPausedOf([], now, now - BOARDING_START_GRACE_MS - 1),
    true,
    `启动超过 ${BOARDING_START_GRACE_MS}ms 且无帧 ⇒ paused（宽限不掩盖真故障）`,
  );
  eq(detectPausedOf([], now, null), true, "未提供启动时刻（null）⇒ 维持原语义 paused");
}

/* ══════════ ⑪ streak 单调性与归零 ══════════ */
console.log("\n[⑪ streak]");
{
  const good = fixesFromStation(20, 3, 10_000);
  let s = 0;
  const seq: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = autoBoardOf(inputOf({ fixes: good, streak: s }));
    s = r.streak;
    seq.push(s);
  }
  eq(seq.join(","), "1,2,3", "连续命中 ⇒ streak 1→2→3");

  const dropped = autoBoardOf(inputOf({ fixes: fixesOf(0, 0, 3, 10_000), streak: 2 }));
  eq(dropped.streak, 0, "一帧不命中 ⇒ streak 立即归零（不保留半程）");
}

/* ══════════ ⑫ 步行不得判上车（v3.6.0 blocking：速度下限 8 km/h） ══════════ */
/**
 * 这组是本次 blocking 改动的**回归防线**：`R2_SPEED_MIN_KMH_FLEX` 若是 5.5，
 * 位移门 `max(60, 5.5/3.6×45) = 68.75m` 与「5.5 km/h × 45s」是同一约束的两种写法，
 * 速度门成了唯一实际生效的门 ⇒ 6~7 km/h 的**快走**会被判成「已上车」。
 *
 * 夹具：**2m 稠密顶点** + accuracy=10m + **45s 满窗**（4 帧 × 15s）。
 * 逐条断言、不聚合（铁律 24：断言基于契约取值域，不靠汇总掩盖）。
 */
console.log("\n[⑫ 步行不得判上车 · 45s 满窗]");
{
  /** 45s 满窗：4 帧、间隔 15s */
  const WALK_FIXES = (kmh: number) => fixesFromStation(kmh, 4, 15_000);

  /** 三种车辆场景：无车 / A1（车刚离站）/ A2（车正停靠） */
  const SCENARIOS: { label: string; vehicles: TrackVehicle[] }[] = [
    { label: "无车", vehicles: [] },
    { label: "A1 有车", vehicles: [vJustLeft] },
    { label: "A2 弱车", vehicles: [vStopping] },
  ];

  /**
   * ⚠️ **区分力分布**（架构终审指出，务必保留）：
   *   · `5.0` / `5.5` 两档 —— 在常量 = 5.5 时**同样 PASS**（`5.5 > 5.5` 被严格大于挡住），
   *     ⇒ 这 6 条**不具区分力**，只是"下界不该判上车"的补充说明。
   *   · `6.0` / `7.0` / `8.0` 三档 × 三场景 = **那 9 条才是真正的回归防线**
   *     （实测：常量退回 5.5 时恰好这 9 条 FAIL）。
   *   ⇒ **勿删 6.0 / 7.0 / 8.0**；只留 5.5 会让人误以为还在防回归，实际已经失去报警能力。
   */
  for (const kmh of [5.0, 5.5, 6.0, 7.0, 8.0]) {
    for (const sc of SCENARIOS) {
      /**
       * ★ 2026-11-05：**必须**传 `walkActive: true`。
       *   本组场景就是「用户还在走去站台的路上」（5~8 km/h 步行）——按定义处于步行段。
       *   不传的话（`undefined` ⇒ false）停站判据会认为"人已在站台"，
       *   于是 A2 弱车（车停靠本站）⇒ 直接判上，与本组意图（检验位置判据是否会把步行误判成乘车）无关。
       *   ⇒ 传 true 才忠实复现生产：步行段由 `walkActive` 门挡住停站判据，
       *     本组检验的正是**位置判据自己**能否分辨步行与乘车。
       */
      const r = autoBoardOf(inputOf({ fixes: WALK_FIXES(kmh), vehicles: sc.vehicles, walkActive: true }));
      const discriminating = kmh >= 6.0; // 6.0 / 7.0 / 8.0 才是回归防线
      eq(
        r.hit,
        false,
        `步行 ${kmh.toFixed(1)}km/h · ${sc.label} ⇒ 不得判上车${discriminating ? "" : "（不具区分力，见上方注释）"}`,
      );
    }
  }

  /**
   * 防矫枉过正：真实乘车（12 km/h）不能因为抬高下限而漏判 / 延迟。
   * 20s 窗（3 帧 × 10s）：位移 66.7m ≥ 位移门 max(60, 8/3.6×20=44.4)=60m，速度 12 > 8。
   */
  const realRide = autoBoardOf(inputOf({ fixes: fixesFromStation(12, 3, 10_000) }));
  eq(realRide.hit, true, "真实乘车 12km/h · 20s 窗 ⇒ 必须命中（防矫枉过正）");
}

/* ══════════ ⑬ 安全网参数契约 ══════════ */
console.log("\n[⑬ 安全网参数契约]");
{
  /**
   * 这两条以前只是 `console.log` 的"提示"，看着测了其实没断言。
   * 改成真断言：确认参数在契约区间内（连续确认 ≥2 次才判异常；两次确认间隔不得过短）。
   */
  ok(ANOMALY_CONFIRM >= 2, "ANOMALY_CONFIRM ≥ 2（单次抖动不得判异常）", `实际=${ANOMALY_CONFIRM}`);
  ok(ANOMALY_MIN_GAP_MS >= 20_000, "ANOMALY_MIN_GAP_MS ≥ 20s（确认间隔不得过短）", `实际=${ANOMALY_MIN_GAP_MS}`);
}

/* ══════════ ⑭ 换乘后下一段的冷却起点（nextLegCooldownOf） ══════════ */
/**
 * 这条分支被两人各推演过一次（架构找出反例、主理人批准护栏），靠注释守不住 —— 必须断言。
 * 语义：`"now"` = 保留冷却（=`Date.now()`）；`"zero"` = 归零（立即可判）。
 */
console.log("\n[⑭ 换乘后冷却起点]");
{
  eq(
    nextLegCooldownOf({ auto: true, progressSource: "gps" }),
    "now",
    "自动下车 + GPS 源 ⇒ 保留冷却（无车牌可核、判错无法纠正）",
  );
  eq(
    nextLegCooldownOf({ auto: true, progressSource: "vehicle" }),
    "zero",
    "自动下车 + 车辆源 ⇒ 归零（有车牌可核）",
  );
  eq(
    nextLegCooldownOf({ auto: false, progressSource: "gps" }),
    "zero",
    "手动下车 + GPS 源 ⇒ 归零（用户本人操作）",
  );
  eq(
    nextLegCooldownOf({ auto: false, progressSource: "vehicle" }),
    "zero",
    "手动下车 + 车辆源 ⇒ 归零",
  );
}

/* ══════════ ⑮ `colored[0] === board` 契约及其两个直接后果 ══════════ */
/**
 * ★ 2026-11-03 新增（需求 6 研判，见 `docs/迭代-导航优化-20261102/23-*`）。
 *
 * 背景：本夹具原先从 **站前 400m** 起，违反生产契约 `colored[0] === board`
 *   （`buildColoredLegs` 分支⑤ 恒 `slice(iBoard, iAlight+1)`，`iBoard` 距 board ≤ tolM）。
 *   违法副作用：站前那段不存在的折线让「站前位移」可测 ⇒ 造出 v3.10.0
 *   「跑 24s 会误判」这个生产上不可能发生的结论，代价是真实乘车 +6s。
 *
 * 本组把契约本身、以及由它推出的两条行为一起钉死：
 *   ① 契约自检 —— 夹具自身必须满足，否则下面「站前不命中」是假验证；
 *   ② 站前接近 ⇒ **永不命中**（真实几何下是数学必然，不是巧合）；
 *   ③ 唯一例外 —— `buildColoredLegs` 分支④（起终点同站 ≤50m）给 `degraded=false`
 *      但 `colored = 整条 shape` ⇒ `colored[0]` **不是**上车站 ⇒ 站前位移可测。
 */
console.log("\n[⑮ colored[0] === board 契约]");
{
  const p0 = atM(0);
  ok(
    PATH[0][0] === p0.lng && PATH[0][1] === p0.lat,
    "夹具自检：PATH[0] 就是上车站（colored[0] === boardPos）",
  );

  /**
   * ② 站前 200m 以 10km/h 走到上车站，然后停住 4 分钟。
   *    两重拦截（都来自真实几何，与加严帧数无关）：
   *      (a) 距站 > tolM(80m) 的帧 ⇒ `projs.some(distM > tol)` 直接否决整个窗口；
   *      (b) 距站 ≤ 80m 的帧全部被钳到 `idx=0` ⇒ `disp = |cum[0]−cum[0]| = 0 < 60m`。
   *    ⇒ 加 2 帧 / 减 2 帧都不会改变这个结论 —— 这正是 92a8912 加严依据失效的原因。
   */
  const approach = (() => {
    const mps = 10 / 3.6;
    const out: FixLite[] = [];
    for (let i = 0; i <= 80; i++) {
      const m = Math.min(0, -200 + mps * i * 3);
      const p = atM(m);
      out.push({ lng: p.lng, lat: p.lat, accuracy: 10, ts: 100_000 + i * 3000 });
    }
    return out;
  })();
  let approachHit = false;
  let approachStreak = 0;
  for (let i = 0; i < approach.length; i++) {
    const r = autoBoardOf(inputOf({ fixes: approach.slice(0, i + 1), streak: approachStreak }));
    approachStreak = r.streak;
    if (r.hit) approachHit = true;
  }
  eq(approachHit, false, "站前 200m 走到站台停住 ⇒ 全程不命中（站前位移被钳为 0，与加严无关）");

  /**
   * ③ 例外：`colored[0]` 不是上车站（分支④ 整线着色）。
   *    上车站取线中段 +1000m，用户从 +800m 以 10km/h 走近。
   *    ⚠️ 这条断言的用途是「**钉住例外的存在**」，不是「证明可以判」——
   *      将来若有人按「站前绝不命中」去删某道护栏，会先撞红这里。
   */
  const midBoard = atM(1000);
  const walkToMid = (() => {
    const mps = 10 / 3.6;
    const out: FixLite[] = [];
    for (let i = 0; i <= 40; i++) {
      const m = Math.min(1000, 800 + mps * i * 3);
      const p = atM(m);
      out.push({ lng: p.lng, lat: p.lat, accuracy: 10, ts: 100_000 + i * 3000 });
    }
    return out;
  })();
  let branch4Hit = false;
  let branch4Streak = 0;
  for (let i = 0; i < walkToMid.length; i++) {
    const r = autoBoardOf(
      inputOf({
        colored: PATH, // 整条 shape（分支④ 的形态）
        legDegraded: false, // 分支④ 的 degraded 是 false —— 这正是它能绕过 G1 的原因
        boardPos: { ...midBoard },
        fixes: walkToMid.slice(0, i + 1),
        streak: branch4Streak,
      }),
    );
    branch4Streak = r.streak;
    if (r.hit) branch4Hit = true;
  }
  eq(
    branch4Hit,
    true,
    "★ 例外：colored[0] ≠ board（分支④ 整线着色）⇒ 站前接近**可**命中（勿据此放松护栏）",
  );
}

/* ══════════ ⑯ I-3 · I1「相对距离斜率」：正常上车必须判上并锁牌 ══════════ */
/**
 * 这一组是 P0「正常上车也匹配不到车牌」的**回归防线**。
 *
 * 根因：旧判据只量「用户自己的平均速度」⇒ 用户上车后站着不动（等关门 / 挤门口 / 塞车）
 *   ⇒ 位移不增而窗口时长照增 ⇒ 平均速度被稀释到 8km/h 以下 ⇒ 判定迟迟不过；
 *   而锁牌只认「车刚离站」的一个站间窗口 ⇒ 判定通过时牌已锁不上。
 *
 * 新判据 `followSlopeOf`：量 `d(t) = |u − v|` 的斜率，分母是**车自己的位移**。
 */
console.log("\n[⑯ I1 相对距离斜率]");
{
  /** 用例 1：5 帧 |u−v| = [12,10,14,9,13]（斜率≈0）+ 车已离站 ⇒ hit 且**同帧**锁牌 */
  const f1 = followFixture({ uM: [32, 20, 54, 41, 73], vM: [20, 30, 40, 50, 60] });
  const r1 = autoBoardOf(inputOf({ fixes: f1.fixes, vehFrames: f1.vehFrames, vehicles: f1.vehFrames[4].vehicles }));
  eq(r1.hit, true, "车里站着不动（d 稳定）+ 车已离站 ⇒ 判上（旧判据会漏）");
  eq(r1.plate, "MB0001", "同帧锁到车牌（判定与锁牌不分离）");
  eq(r1.source, "vehicle", "有牌 ⇒ 来源 vehicle");
  eq(r1.evidence, "slope", "证据 = slope");
  ok(
    r1.followSlope != null && Math.abs(r1.followSlope) <= FOLLOW_MAX_SLOPE_MPS,
    "观测值 data-follow-slope ≈ 0（已上车）",
    `实际=${r1.followSlope?.toFixed(2)} m/s`,
  );
  eq(r1.need, R2_STREAK_WITH_VEHICLE, "斜率判据自带 ≥5 帧窗 ⇒ need=2");

  /** 用例 2：d = [10,20,30,40,50]（斜率≈车速）+ 人在站台不动 ⇒ 不判 */
  const f2 = followFixture({ uM: [0, 0, 0, 0, 0], vM: [10, 20, 30, 40, 50] });
  const r2 = autoBoardOf(inputOf({ fixes: f2.fixes, vehFrames: f2.vehFrames, vehicles: f2.vehFrames[4].vehicles }));
  eq(r2.hit, false, "车在开走、人还在站台（d 按车速增长）⇒ 不判");
  eq(r2.plate, null, "未命中 ⇒ 不锁牌");
  eq(r2.evidence, "station", "证据只剩「车已离站」");

  /**
   * 用例 3：车**停靠本站** + d≡0
   *
   * ★ 2026-11-05 **语义已变更**：本用例原先断言「物理不可分 ⇒ 不判」，
   *   现被负责人裁决推翻 ——「车停在上车站的停站期 = 用户已上车 ⇒ 立刻进入乘车导航」。
   *   物理上两者**仍然**不可分（人可能没上），这是**明知的假设代价**；
   *   纠错入口（「我没上车」）是它的兜底，见 ㉒ 组。
   *   ⇒ 本用例改为记录**新语义**，并保留旧结论作为历史留痕（勿删，解释为什么曾经不判）。
   */
  const parked: TrackVehicle = {
    plate: "MB0002",
    lat: atM(0).lat,
    lng: atM(0).lng,
    status: "stopping",
    interval: null,
    atStation: { code: "T100" },
  };
  const parkedHist = [0, 1, 2, 3, 4].map((i) => ({ ts: 100_000 + i * 3_000, vehicles: [parked] }));
  const r3 = autoBoardOf(
    inputOf({ fixes: fixesAt([0, 0, 0, 0, 0]), vehFrames: parkedHist, vehicles: [parked] }),
  );
  eq(r3.hit, true, "车停靠本站 ⇒ 现**判上**（2026-11-05 负责人裁决；旧结论「不可分⇒不判」已废止）");
  eq(r3.evidence, "atstop", "证据 = atstop（停站判据，不是位置判据）");
  eq(r3.plate, "MB0002", "唯一候选 ⇒ 锁牌");
  /** 同一输入把停站分支关掉（`walkActive=true`）⇒ 回到旧的「不可分 ⇒ 不判」行为（历史留痕） */
  const r3old = autoBoardOf(
    inputOf({ fixes: fixesAt([0, 0, 0, 0, 0]), vehFrames: parkedHist, vehicles: [parked], walkActive: true }),
  );
  eq(r3old.hit, false, "历史留痕：停站分支关闭时 d≡0 仍不可分 ⇒ 不判（旧行为，勿据此改回）");

  /** 用例 4：只给 4 帧 ⇒ 不判（**锁死 5 帧下限**，防有人缩到 3 帧引入假阳性） */
  eq(FOLLOW_MIN_FRAMES, 5, "最小样本帧数硬下限 = 5（不得下调）");
  const f4 = followFixture({ uM: [32, 20, 54, 41], vM: [20, 30, 40, 50] });
  const frames4: FollowFrame[] = followFramesOf({
    fixes: f4.fixes,
    vehFrames: f4.vehFrames,
    colored: PATH,
    plate: "MB0001",
  });
  const fs4 = followSlopeOf(frames4);
  eq(fs4.n, 4, "4 帧全部进入窗口");
  eq(fs4.ok, false, "4 帧 ⇒ 判据不成立（3~4 帧的斜率标准误与车速同量级）");
  eq(fs4.why, "too-few", "原因 = 样本不足");
  eq(
    autoBoardOf(inputOf({ fixes: f4.fixes, vehFrames: f4.vehFrames, vehicles: f4.vehFrames[3].vehicles })).hit,
    false,
    "4 帧时端到端也不得判上",
  );

  /** 用例 5：车已驶过下一站（`interval.from` 不再是本站），但 L-b 成立 ⇒ 仍能锁牌 */
  const midRide: TrackVehicle = {
    plate: "MB0003",
    lat: atM(0).lat,
    lng: atM(0).lng,
    status: "moving",
    interval: { from: { code: "T101" }, to: { code: "T102" } },
    atStation: null,
  };
  const midHist = [300, 310, 320, 330, 340].map((m, i) => vehAt("MB0003", m, 100_000 + i * 3_000, { interval: midRide.interval }));
  const midFix = fixesAt([306, 313, 325, 334, 346]);
  const dep5 = departedCandidatesOf({
    vehicles: [midRide],
    boardMain: "T100",
    stopMains: STOP_MAINS,
    colored: PATH,
    fix: { lng: atM(346).lng, lat: atM(346).lat },
  });
  ok(dep5.length === 1 && dep5[0].via.includes("L-b"), "L-b 成立：车已在本段站序内前移（passedIdx≥0）");
  const r5 = autoBoardOf(
    inputOf({ fixes: midFix, vehFrames: midHist, vehicles: [{ ...midRide, lat: atM(340).lat, lng: atM(340).lng }] }),
  );
  eq(r5.hit, true, "整段乘车（非「刚离站」站间）仍可判定");
  eq(r5.plate, "MB0003", "整段乘车仍能锁牌（旧版只认一个站间 ⇒ 这里必然 null）");
}

/* ══════════ ⑰ I-3 · I2 多车歧义：差 <2σ 不锁 / >2σ 锁近者 ══════════ */
console.log("\n[⑰ I2 多车歧义]");
{
  /**
   * ⚠️ 2026-11-04：`FOLLOW_AMBIG_M` 由 20 收到 **12**（见 `follow-slope.ts` 该常量的推导）。
   *   故"歧义"用例的差必须用 <12；而 18m 差（3σ）现在**应当**能分辨、必须锁。
   *   这不是"为了让断言变绿而放宽"——旧 20 是配在**错位 d**（σ≈26m）上的，实测只有 0.8σ；
   *   新 12 配在**对齐 d**（σ≈6m）上，是真正的 2σ。两轮锁错率见 ㉑ 组的 RED/GREEN。
   */
  eq(pickLockPlateOf([{ plate: "A", d: 10, via: ["L-a"] }, { plate: "B", d: 18, via: ["L-a"] }]).plate, null, "d 差 8m < 12（2σ）⇒ 不锁（分不出是哪辆）");
  ok(pickLockPlateOf([{ plate: "A", d: 10, via: ["L-a"] }, { plate: "B", d: 18, via: ["L-a"] }]).ambiguous, "歧义标记");
  eq(pickLockPlateOf([{ plate: "A", d: 10, via: ["L-a"] }, { plate: "B", d: 28, via: ["L-a"] }]).plate, "A", "d 差 18m（3σ）⇒ 可分辨，锁 d 小者");
  eq(pickLockPlateOf([{ plate: "A", d: 10, via: ["L-a"] }, { plate: "B", d: 45, via: ["L-a"] }]).plate, "A", "d 差 35m > 2σ ⇒ 锁 d 小者");
  eq(pickLockPlateOf([{ plate: "A", d: null, via: ["L-a"] }]).plate, "A", "唯一候选且无里程（L-a 强证据）⇒ 锁它");
  eq(pickLockPlateOf([{ plate: "A", d: null, via: ["L-b"] }, { plate: "B", d: null, via: ["L-c"] }]).plate, null, "多候选且都无里程 ⇒ 不猜");
  eq(
    pickLockPlateOf([{ plate: "A", d: 2000, via: ["L-b"] }]).plate,
    null,
    "L-b/L-c 放宽来源必须有位置确认：2km 外的同线车**不得**锁（防错锁）",
  );

  /** 端到端：r2 命中时，两车里程差决定「锁谁 / 锁不锁」 */
  const uM6 = [0, 16.7, 33.3, 50, 66.7]; // 20km/h × 12s = 66.7m ⇒ r2 位移门(60m)过
  const fix6 = fixesAt(uM6);
  const histNear = vehHistOf("MA0101", uM6.map((x) => x + 10));
  const histFar = vehHistOf("MA0102", uM6.map((x) => x + 45));
  const merge = (a: VehFrame[], b: VehFrame[]): VehFrame[] =>
    a.map((f, i) => ({ ts: f.ts, vehicles: [...f.vehicles, ...b[i].vehicles] }));

  const wide = autoBoardOf(inputOf({ fixes: fix6, vehFrames: merge(histNear, histFar), vehicles: merge(histNear, histFar)[4].vehicles }));
  eq(wide.hit, true, "两车里程差 35m ⇒ 判定成立");
  eq(wide.plate, "MA0101", "锁 d 小者");

  const histNear2 = vehHistOf("MA0101", uM6.map((x) => x + 10));
  const histFar2 = vehHistOf("MA0102", uM6.map((x) => x + 20)); // 差 10m < 12m（2σ）
  const near2 = merge(histNear2, histFar2);
  const narrow = autoBoardOf(inputOf({ fixes: fix6, vehFrames: near2, vehicles: near2[4].vehicles }));
  eq(narrow.hit, true, "里程差 <2σ ⇒ 仍可判「在车上」");
  eq(narrow.plate, null, "但**不锁牌**（分不出是哪辆 ⇒ 不猜）");
  eq(narrow.source, "gps", "无牌 ⇒ 来源退回 gps");
}

/* ══════════ ⑱ I-3 · I1 判据门槛（隔离测试）══════════ */
console.log("\n[⑱ I1 门槛隔离]");
{
  // 用户自己在动、但相对距离被拉开 ⇒ 只能由 G-e（斜率门）否决
  const g = followFramesOf({
    fixes: fixesAt([20, 40, 60, 80, 100]),
    vehFrames: vehHistOf("MB0009", [10, 40, 70, 100, 130]),
    colored: PATH,
    plate: "MB0009",
  });
  const fs = followSlopeOf(g);
  ok(fs.alongM != null && fs.alongM >= FOLLOW_MIN_ALONG_M, "用户沿线前移达门槛（排除 G-d 干扰）", `alongM=${fs.alongM?.toFixed(1)}`);
  eq(fs.ok, false, "d 从 10 拉到 30（斜率≈2m/s > 上限）⇒ 不成立");
  eq(fs.why, "growing", "原因 = 相对距离被拉开");

  // 精度不足的帧**整帧不参与**（不是拿来用）
  const bad = followFixture({ uM: [32, 20, 54, 41, 73], vM: [20, 30, 40, 50, 60] });
  const badFixes = bad.fixes.map((f) => ({ ...f, accuracy: 200 }));
  const badFrames = followFramesOf({ fixes: badFixes, vehFrames: bad.vehFrames, colored: PATH, plate: "MB0001" });
  const badSlope = followSlopeOf(badFrames);
  eq(badSlope.n, 0, "accuracy=200m 的帧全部不参与拟合");
  eq(badSlope.ok, false, "整条不判（精度不足如实拒绝，不硬判）");
  eq(
    autoBoardOf(inputOf({ fixes: badFixes, vehFrames: bad.vehFrames, vehicles: bad.vehFrames[4].vehicles })).hit,
    false,
    "整条低精度 ⇒ 端到端也不判",
  );

  // 车停着不动 ⇒ 「d 不变」是平凡解，不可判（物理限制）
  const stillCar = followFramesOf({
    fixes: fixesAt([0, 0, 0, 0, 0]),
    vehFrames: vehHistOf("MB0010", [10, 10, 10, 10, 10]),
    colored: PATH,
    plate: "MB0010",
  });
  eq(followSlopeOf(stillCar).why, "veh-still", "车停着 ⇒ 原因 = veh-still（不把平凡解当已上车）");

  /** 内插：车辆帧 12s 一帧、定位 3s 一帧 ⇒ v 必须（且只能）内插对齐到定位时间戳 */
  const sparse: VehFrame[] = [vehAt("MC0001", 0, 100_000), vehAt("MC0001", 40, 112_000)];
  const interp = followFramesOf({ fixes: fixesAt([0, 10, 20, 30, 40]), vehFrames: sparse, colored: PATH, plate: "MC0001" });
  eq(interp.length, 5, "两端车辆帧之间 5 个定位帧全部配上（含末帧）");
  ok(
    interp.every((f, i) => Math.abs(f.v - i * 10) <= 1),
    "v 按内插对齐到定位时间戳（10/20/30/40）",
    `实际=${interp.map((f) => f.v.toFixed(1)).join(",")}`,
  );
  ok(followSlopeOf(interp).ok, "内插后同速随车（d≈0）⇒ 判据成立（否则 d 会按车速锯齿增长）");
}

/* ══════════ ⑲ I-3 · I3 方向：沿线里程递减的窗口不成立 ══════════ */
console.log("\n[⑲ I3 方向校验]");
{
  const r2opts = { displaceM: 100, speedMinKmh: 8, minSamples: 3 };
  const fwd: FixLite[] = [
    { ...atM(20), accuracy: 10, ts: 100_000 },
    { ...atM(80), accuracy: 10, ts: 108_000 },
    { ...atM(140), accuracy: 10, ts: 116_000 },
  ];
  eq(r2Of(fwd, PATH, r2opts), true, "对照：正向 120m / 16s ⇒ 成立");
  const back: FixLite[] = [
    { ...atM(140), accuracy: 10, ts: 100_000 },
    { ...atM(80), accuracy: 10, ts: 108_000 },
    { ...atM(20), accuracy: 10, ts: 116_000 },
  ];
  eq(r2Of(back, PATH, r2opts), false, "反向 120m / 16s ⇒ 不成立（旧版 Math.abs 会判 true）");
}

/* ══════════ ⑳ I-3 · I4 误判可纠正：本腿 2 次自动判定 + 20s 冷却 ══════════ */
console.log("\n[⑳ I4 次数与冷却]");
{
  eq(AUTO_TRIES_PER_LEG, 2, "本腿自动判定次数初值 = 2");
  const f = followFixture({ uM: [32, 20, 54, 41, 73], vM: [20, 30, 40, 50, 60] });
  const base = { fixes: f.fixes, vehFrames: f.vehFrames, vehicles: f.vehFrames[4].vehicles };
  const T = 1_000_000;

  let streak = 0;
  let left = AUTO_TRIES_PER_LEG;
  let lastSwitch = 0;
  const frame = (nowMs: number) => {
    const r = autoBoardOf(inputOf({ ...base, autoLeft: left, streak, nowMs, lastSwitchTs: lastSwitch }));
    streak = r.streak;
    return r;
  };

  frame(T);
  const switched1 = frame(T);
  ok(switched1.hit && switched1.streak >= switched1.need, "第 1 次：连续命中达 need ⇒ 自动上车");
  left -= 1; // `switchToRiding` 里扣次数
  lastSwitch = T;
  streak = 0; // 切换后清零
  eq(left, 1, "第 1 次后剩余 1 次");

  // 用户点「我没上车」：只起冷却，不扣次数
  lastSwitch = T;
  eq(frame(T + 5_000).hit, false, "回到等车后 20s 冷却内不再判（防抖）");

  const again = frame(T + SWITCH_COOLDOWN_MS); // 冷却刚过
  eq(again.hit, true, "冷却过后仍能自动判定（旧版此处被永久关闭）");
  left -= 1;
  streak = 0;
  eq(left, 0, "第 2 次后次数用尽");

  lastSwitch = T + SWITCH_COOLDOWN_MS;
  eq(frame(T + SWITCH_COOLDOWN_MS * 3).hit, false, "第 3 次不再自动（次数用尽 ⇒ 如实停手）");
}


/* ══════════ ㉑ 同线双车：锁错率（P0 严重缺陷 · 2026-11-04） ══════════ */
/**
 * 缺陷（fe-latency 实测，负责人定性为严重 bug）：同线有后车时，约一半的判定
 * **锁到先走的那辆**（前车）⇒ 进度 / 报站 / 下车提醒全部跟着错车走。
 *
 * 本组给出的**根因结论**（用真代码复现，见 RED 段）：
 *   不是「歧义门 20m 太窄」，而是 `d` 把**两个时刻**相减 ——
 *   `departedCandidatesOf` 旧口径 = `|u(当前定位帧) − v(最近车辆帧)|`，两者相差 0~12s
 *   （`POLL_MS`）⇒ 两车同时被回退 `lag·v`（最多 40m）。用户在后车时，前车的**旧**位置
 *   恰好落到用户附近 ⇒ `argmin` 系统性偏向先走的那辆。lag 在 0~12s 均匀 ⇒ 约 2/3 帧判错，
 *   再被「车距 26.7m 只比门 20m 大 6.7m」吃掉一部分 ⇒ 实测净锁错 25~39%。
 *
 * 修法：`alignedDOf` 把 `v(t)` 内插到每个定位帧时刻、取 `|median(u − v)|`，
 *   两车的 `d` 因此来自同一时刻、同一用户位置 ⇒ 其差即真实车距。
 *
 * ── ★ 本修复的代价（有意交易，不是漏优化：见 `plate-lock.ts#pickLockPlateOf`）──
 *   双车场景下前 ~15s（对齐样本 < `LOCK_ALIGN_MIN_FRAMES = 5` 帧）多候选一律**判歧义
 *   ⇒ 不锁牌** ⇒ 该窗口内斜率判据无法工作（`followFramesOf` 需 `plate`），只能靠 r2 判上。
 *   实测首判延迟可能 **~25s → ~30s（+5s）**，换来**锁错率 21.8% → 0%**。
 *   取舍：锁错车会让进度 / 报站 / 下车提醒全部跟着错车走，比慢 5 秒严重一个量级；
 *   「不锁牌」的后果是退化成 GPS 推算（仍能工作），不是失效。
 *   ⚠️ 若为「更快锁牌」放宽该约束，必须重跑本 ㉑ 组确认锁错仍为 0。
 *
 * 本组同时给 **RED（raw 口径）/ GREEN（aligned 口径）** 两轮，跑的是**同一个 fixture、
 * 同一套统计**，唯一差别是喂不喂 `fixes`/`vehFrames`：
 *   · RED   = 不喂历史 ⇒ 走 raw 回退口径 ⇒ 复现旧缺陷（断言锁错 ≥20%）
 *   · GREEN = 喂历史 ⇒ 走对齐口径 ⇒ 锁错必须为 0，且锁对率显著上升
 */
console.log("\n[㉑ 同线双车锁错率 · RED/GREEN]");
{
  /* ── 确定性噪声（不用 Math.random：断言必须可复现）── */
  const mulberry32 = (a: number) => () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = (rnd: () => number): number => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  /** 把「沿线里程 m」写成带噪声的定位点（噪声按**米**给） */
  const noisyAt = (m: number, sigM: number, rnd: () => number) => {
    const p = atM(m);
    return { lng: p.lng + gauss(rnd) * sigM * DEG_PER_M_LNG, lat: p.lat + (gauss(rnd) * sigM) / 111_320 };
  };

  const SPEED = 3.33; // 12 km/h
  const POLL = 12_000; // 生产车辆轮询间隔
  const FIXGAP = 3_000; // 候车期定位间隔
  const SPAN = 100_000;
  const SIG_USER = 10;
  const SIG_VEH = 10;

  type Who = "A" | "B" | "station";

  /**
   * 造一轮双车场景。
   * @param gapM  车距（米）—— 生产实测 8s 车距 ≈ 26.7m
   * @param phase 用户帧相对车辆帧的相位（ms）⇒ 覆盖 lag ∈ [0, POLL) 的全部取值
   */
  function dualBus(o: { who: Who; gapM: number; phase: number; seed: number; sigVeh?: number }) {
    const SIGV = o.sigVeh ?? SIG_VEH;
    const rnd = mulberry32(o.seed);
    const mileOf = (ts: number, front: boolean) => SPEED * (ts / 1000) + (front ? o.gapM : 0);
    const vehFrames: VehFrame[] = [];
    for (let ts = 0; ts <= SPAN; ts += POLL) {
      vehFrames.push({
        ts,
        vehicles: [
          {
            plate: "AA0001",
            ...noisyAt(mileOf(ts, true), SIGV, rnd),
            status: "moving",
            interval: { from: { code: "T100" }, to: { code: "T101" } },
            atStation: null,
          },
          {
            plate: "BB0002",
            ...noisyAt(mileOf(ts, false), SIGV, rnd),
            status: "moving",
            interval: { from: { code: "T100" }, to: { code: "T101" } },
            atStation: null,
          },
        ],
      });
    }
    const fixes: FixLite[] = [];
    for (let ts = o.phase; ts <= SPAN; ts += FIXGAP) {
      const trueU = o.who === "A" ? mileOf(ts, true) : o.who === "B" ? mileOf(ts, false) : 0;
      fixes.push({ ...noisyAt(trueU, SIG_USER, rnd), accuracy: 10, ts });
    }
    return { vehFrames, fixes };
  }

  /** 在每帧定位上判一次，统计 锁对 / 锁错 / 歧义（= 未锁） */
  function measure(o: {
    who: Who;
    gapM: number;
    aligned: boolean;
    seeds?: number;
    phases?: number[];
    /** RED 用：替换判定规则（缺省 = 现行 `pickLockPlateOf`） */
    legacy?: (c: ReturnType<typeof departedCandidatesOf>) => string | null;
    sigVeh?: number;
  }) {
    const want = o.who === "A" ? "AA0001" : o.who === "B" ? "BB0002" : null;
    const phases = o.phases ?? [0, 2_000, 4_000, 6_000, 8_000, 10_000];
    const seeds = o.seeds ?? 3;
    let right = 0;
    let wrong = 0;
    let amb = 0;
    let n = 0;
    for (let s = 0; s < seeds; s++) {
      for (const ph of phases) {
        const fx = dualBus({ who: o.who, gapM: o.gapM, phase: ph, seed: 1000 * s + ph + 7, sigVeh: o.sigVeh });
        for (const f of fx.fixes) {
          if (f.ts < 30_000) continue; // 避开起步段（"历史不足"另有 ⑥ 专测）
          const past = fx.fixes.filter((x) => x.ts <= f.ts);
          const vf = fx.vehFrames.filter((x) => x.ts <= f.ts);
          const latest = vf[vf.length - 1];
          if (!latest) continue;
          const cands = departedCandidatesOf({
            vehicles: latest.vehicles,
            boardMain: "T100",
            stopMains: STOP_MAINS,
            colored: PATH,
            fix: { lng: f.lng, lat: f.lat },
            tolM: 80,
            // ★ 唯一的差别：喂不喂历史（决定走 raw 还是 aligned 口径）
            fixes: o.aligned ? past : null,
            vehFrames: o.aligned ? vf : null,
          });
          const plate = o.legacy ? o.legacy(cands) : pickLockPlateOf(cands).plate;
          n++;
          const pick = { plate } as { plate: string | null };
          if (pick.plate == null) amb++;
          else if (pick.plate === want) right++;
          else wrong++; // 含站台场景（want=null ⇒ 给牌即"多余锁牌"）
        }
      }
    }
    const pct = (x: number) => (x / Math.max(1, n)) * 100;
    return { right: pct(right), wrong: pct(wrong), amb: pct(amb), n, rightN: right, wrongN: wrong };
  }
  const fmt = (m: { right: number; wrong: number; amb: number }) =>
    `锁对 ${m.right.toFixed(1)}% · 锁错 ${m.wrong.toFixed(1)}% · 歧义 ${m.amb.toFixed(1)}%`;

  /**
   * ── ① RED：**旧判定规则 + 真实 raw d** ⇒ 复现「锁错 ≥ 20%」 ──
   *
   * 注意口径：新版 `pickLockPlateOf` 对「多候选 + raw 口径」直接判**歧义不锁**（安全降级），
   * 所以在它上面跑 RED 只会得到 100% 歧义 —— 复现不出缺陷。故 RED 用**旧规则**
   * （raw `d` 取 argmin，歧义门 20m）作用在 `departedCandidatesOf` 产出的**真实 raw d 值**上：
   * 这正是改前的生产行为（`89c8c6c` 之前的 `pickLockPlateOf`）。
   * ⇒ 断言的是「raw d 本身的信息就是错的（argmin 选错 ≥20%）」，与门多宽无关。
   */
  const legacyPick = (cands: ReturnType<typeof departedCandidatesOf>): string | null => {
    const withD = cands.filter((c) => c.d != null).sort((a, b) => (a.d as number) - (b.d as number));
    if (!withD.length) return null;
    const first = withD[0];
    const second = withD[1];
    if (second && (second.d as number) - (first.d as number) < 20) return null; // 旧门 = 20
    return first.plate;
  };
  const redB = measure({ who: "B", gapM: 26.7, aligned: false, legacy: legacyPick });
  ok(
    redB.wrong >= 20,
    `RED：旧规则(raw d + 门 20m) · 用户在后车 ⇒ 复现旧缺陷（锁错应 ≥20%，实际 ${redB.wrong.toFixed(1)}%）`,
    fmt(redB),
  );
  /**
   * RED 补充证据：**只看 argmin**（不管门多宽）也有 ≥20% 选错 ⇒ 证明问题在 d 本身而不在门。
   * 这条同时解释了「为什么单纯加宽/收窄歧义门治不好」——门再宽也只是把错锁换成不锁。
   */
  const redArgmin = measure({ who: "B", gapM: 26.7, aligned: false, legacy: (c) => {
    const withD = c.filter((x) => x.d != null).sort((a, b) => (a.d as number) - (b.d as number));
    return withD.length ? withD[0].plate : null;
  } });
  ok(
    redArgmin.wrong >= 20,
    `RED：仅看 argmin（门宽无关）也 ≥20% 选错（实际 ${redArgmin.wrong.toFixed(1)}%）⇒ 根因是 d 口径`,
    fmt(redArgmin),
  );

  /* ── ② GREEN：同一 fixture 换对齐口径 ⇒ 锁错必须归零 ── */
  const greenB = measure({ who: "B", gapM: 26.7, aligned: true });
  eq(greenB.wrongN, 0, `GREEN：对齐口径 · 用户在后车 ⇒ 锁错必须为 0（${fmt(greenB)}）`);
  ok(greenB.right >= 85, `GREEN：锁对率应 ≥85%（实际 ${greenB.right.toFixed(1)}%）`, fmt(greenB));
  ok(
    greenB.right > redB.right + 30,
    `GREEN 锁对率必须显著高于 RED（${redB.right.toFixed(1)}% → ${greenB.right.toFixed(1)}%）`,
  );

  /* ── ③ 反例二：用户在前车（旧口径下本来就对，不得回归）── */
  const redA = measure({ who: "A", gapM: 26.7, aligned: false });
  const greenA = measure({ who: "A", gapM: 26.7, aligned: true });
  eq(greenA.wrongN, 0, `GREEN：对齐口径 · 用户在前车 ⇒ 锁错必须为 0（${fmt(greenA)}）`);
  ok(greenA.right >= 85, `GREEN：前车锁对率应 ≥85%（实际 ${greenA.right.toFixed(1)}%）`, fmt(greenA));
  ok(
    greenA.wrong <= redA.wrong,
    "GREEN 不得让前车场景变差（旧口径在前车场景本来就判对）",
    `RED ${fmt(redA)} → GREEN ${fmt(greenA)}`,
  );

  /* ── ④ 反例三：用户在站台（未上车）⇒ 端到端不得判上 ── */
  const st = measure({ who: "station", gapM: 26.7, aligned: true });
  {
    const fx = dualBus({ who: "station", gapM: 26.7, phase: 0, seed: 4242 });
    const last = fx.fixes[fx.fixes.length - 1];
    const vf = fx.vehFrames.filter((x) => x.ts <= last.ts);
    const res = autoBoardOf({
      legKind: "bus",
      legDegraded: false,
      colored: PATH,
      boardMain: "T100",
      boardPos: { ...atM(0) },
      stopMains: STOP_MAINS,
      vehicles: vf[vf.length - 1].vehicles,
      vehFrames: vf,
      fixes: fx.fixes,
      lastSwitchTs: 0,
      nowMs: last.ts + 1,
      streak: 2,
    });
    eq(res.hit, false, "站台用户（车已开走、人未动）⇒ 端到端不得判上");
    // 牌层面：`pickLockPlateOf` 不负责判断"有没有上车"，它可能在两车里挑一个；
    // 但 hit=false ⇒ 该牌子不会被采用。如实记录，不做"必须 null"的假断言。
    ok(true, `站台场景牌层面（仅记录，不参与判上）：${fmt(st)}`);
  }

  /* ── ⑤ 车距敏感性：只要车距 ≥ 实测值，锁错就必须为 0 ── */
  for (const gapM of [15, 26.7, 50]) {
    const g = measure({ who: "B", gapM, aligned: true });
    if (gapM >= 26.7) {
      eq(g.wrongN, 0, `对齐口径 · 车距 ${gapM}m ≥ 实测车距 ⇒ 锁错必须为 0（${fmt(g)}）`);
      ok(g.right >= 85, `车距 ${gapM}m ⇒ 锁对率应 ≥85%（实际 ${g.right.toFixed(1)}%）`);
    } else {
      /**
       * 15m 车距**低于对齐估计量的可分辨下限**（2σ≈12m，余量仅 3m）⇒ 允许偶发锁错。
       * 如实断言"不超过 5%"，而不是假装归零；这也给出"多近会开始不安全"的界。
       */
      ok(g.wrong <= 5, `车距 ${gapM}m 低于分辨率下限 ⇒ 锁错应 ≤5%（实际 ${g.wrong.toFixed(1)}%）`, fmt(g));
      ok(g.amb >= 40, `且应以歧义为主（实际 ${g.amb.toFixed(1)}%）⇒ 表现为"不锁"而不是"锁错"`);
    }
  }

  /* ── ⑤b 车辆噪声敏感性：诚实标注"真机 σ_veh 未知"的残余风险 ── */
  for (const sigVeh of [5, 20]) {
    const g = measure({ who: "B", gapM: 26.7, aligned: true, sigVeh });
    const bound = sigVeh <= 10 ? 0 : 3;
    ok(
      g.wrongN === 0 || g.wrong <= bound,
      `σ_veh=${sigVeh}m · 车距 26.7m ⇒ 锁错 ≤${bound}%（实际 ${g.wrong.toFixed(1)}%）`,
      fmt(g),
    );
  }

  /* ── ⑥ 历史不足 ⇒ **不得**猜：>1 候选且无对齐样本 ⇒ 判歧义 ── */
  {
    const fx = dualBus({ who: "B", gapM: 26.7, phase: 0, seed: 99 });
    const early = fx.fixes[2]; // 定位仅 3 帧、车辆帧 ≤2 帧
    const vf = fx.vehFrames.filter((x) => x.ts <= early.ts);
    const cands = departedCandidatesOf({
      vehicles: vf[vf.length - 1].vehicles,
      boardMain: "T100",
      stopMains: STOP_MAINS,
      colored: PATH,
      fix: { lng: early.lng, lat: early.lat },
      tolM: 80,
      fixes: fx.fixes.filter((x) => x.ts <= early.ts),
      vehFrames: vf,
    });
    const pick = pickLockPlateOf(cands);
    eq(pick.plate, null, "对齐样本不足（<5 帧）且有两个候选 ⇒ 不锁（宁可留空，不猜）");
    ok(pick.ambiguous, "且必须标记为歧义（上层据此区分「没机会」与「有机会但分不清」）");
  }

  /* ── ⑦ 唯一候选不受「必须对齐」限制（旧行为不回归）── */
  {
    const fx = followFixture({ uM: [10, 20, 30, 40, 50], vM: [12, 22, 32, 42, 52] });
    const cands = departedCandidatesOf({
      vehicles: fx.vehFrames[4].vehicles,
      boardMain: "T100",
      stopMains: STOP_MAINS,
      colored: PATH,
      fix: { lng: fx.fixes[4].lng, lat: fx.fixes[4].lat },
      tolM: 80,
      // 故意不喂历史 ⇒ raw 口径；唯一候选仍应锁上
    });
    eq(pickLockPlateOf(cands).plate, "MB0001", "只有一辆候选 ⇒ raw 口径也锁（无需比较，旧行为不变）");
  }

  /* ── ⑧ `alignedDOf` 的空/退化输入 ── */
  {
    eq(alignedDOf({ colored: PATH, fixes: [], vehFrames: [], plate: "X", nowTs: 1 }).d, null, "alignedDOf：无样本 ⇒ null");
    eq(
      alignedDOf({ colored: PATH, fixes: fixesAt([1, 2]), vehFrames: [], plate: "X", nowTs: 1 }).d,
      null,
      "alignedDOf：无车辆帧 ⇒ null",
    );
    eq(
      alignedDOf({ colored: [], fixes: fixesAt([1, 2, 3, 4, 5]), vehFrames: vehHistOf("X", [1, 2]), plate: "X", nowTs: 100_000 })
        .d,
      null,
      "alignedDOf：几何缺失 ⇒ null",
    );
  }

  /* ── ⑨ 口径标注：对齐成功必须标 aligned（上层据此决定能否比较）── */
  {
    const fx = followFixture({ uM: [0, 3, 6, 9, 12, 15], vM: [0, 3, 6, 9, 12, 15] });
    const cands = departedCandidatesOf({
      vehicles: fx.vehFrames[5].vehicles,
      boardMain: "T100",
      stopMains: STOP_MAINS,
      colored: PATH,
      fix: { lng: fx.fixes[5].lng, lat: fx.fixes[5].lat },
      tolM: 80,
      fixes: fx.fixes,
      vehFrames: fx.vehFrames,
    });
    eq(cands[0]?.dKind, "aligned", "喂齐历史 ⇒ 口径必须是 aligned");
    ok((cands[0]?.nAligned ?? 0) >= 5, `参与对齐的样本帧数应 ≥5（实际 ${cands[0]?.nAligned}）`);
    ok(cands[0]?.d != null && (cands[0].d as number) < 30, "完全同步 ⇒ d 应接近 0", `d=${cands[0]?.d?.toFixed(1)}`);
  }
}


/* ══════════ ㉒ 「车停靠上车站 ⇒ 立即切 riding」（★ 2026-11-05 · 负责人裁决） ══════════ */
/**
 * 负责人裁决：「车停在上车站的停站期 = 用户已上车 ⇒ 立刻进入乘车导航阶段。
 *   是**检测到车到达上车站之时**，不要提前至等车时，也不要推后至离站时。」
 * 这推翻了此前「停站期只显示候选车牌、不判定」的结论。
 *
 * ── RED 的口径（必须先说清，否则这条断言是假的）───────────────────────────
 *   改前的代码**没有**这条分支（`A2` 只降门槛、不触发），所以「改前行为」只能用
 *   **把新分支关掉**来复现。唯一的关法是 `walkActive: true`（该门正是"不启用停站判据"），
 *   而它同时忠实等于改前代码在「用户静止 + 车停靠」输入下的表现：r2 速度门过不了、
 *   斜率判据 `alongM = 0` 过不了 ⇒ `hit === false`。
 *   ⇒ RED 用 `walkActive: true`，并在断言文案里写明这是"复现改前行为"，不是"用户真在走路"。
 */
console.log("\n[㉒ 停站即上车]");
{
  /** 车停靠「上车站」（T100）—— 停站判据唯一认的形态 */
  const vAtBoard: TrackVehicle = {
    plate: "MC0001",
    lat: atM(0).lat,
    lng: atM(0).lng,
    status: "stopping",
    interval: null,
    atStation: { code: "T100" },
  };
  /** 同上，但 `status` 是 **terminal**（该站恰好是线路首站 —— 澳门最常见的"从总站上车"） */
  const vAtBoardTerminal: TrackVehicle = { ...vAtBoard, plate: "MC0002", status: "terminal" };
  /** 车停在**别的**站 */
  const vAtOther: TrackVehicle = { ...vAtBoard, plate: "MC0003", atStation: { code: "T102" } };
  /** 车在路上（`atStation` 为 null） */
  const vMoving: TrackVehicle = {
    plate: "MC0004",
    lat: atM(120).lat,
    lng: atM(120).lng,
    status: "moving",
    interval: { from: { code: "T100" }, to: { code: "T101" } },
    atStation: null,
  };
  /** 车已离站（`atStation` null + `interval.from` == 上车站）= 旧的 L-a 形态 */
  const vDeparted: TrackVehicle = { ...vMoving, plate: "MC0005", atStation: null };

  /** 用户**站着不动**（这是「等车」的忠实形态；停站判据刻意不看位移） */
  const standing = fixesOf(0, 0, 5, 5_000);
  /** 用户随车移动（有位置证据） */
  const ridingFixes = fixesFromStation(20, 4, 10_000);

  /* ── ① RED：改前行为（停站分支关闭）⇒ 不判上 ── */
  {
    const r = autoBoardOf(
      inputOf({ vehicles: [vAtBoard], fixes: standing, walkActive: true, streak: 2 }),
    );
    eq(r.hit, false, "RED：停站分支关闭（复现改前行为）· 车停靠本站 + 用户静止 ⇒ 不判上");
    ok(r.evidence !== "atstop", "RED：证据不可能是 atstop（该分支未启用）", `evidence=${r.evidence}`);
  }

  /* ── ② GREEN：同一输入，停站分支启用 ⇒ 判上 ── */
  {
    const vehFrames = [0, 1, 2, 3, 4].map((i) => vehAt("MC0001", 0, 100_000 + i * 12_000));
    const r = autoBoardOf(
      inputOf({ vehicles: [vAtBoard], fixes: standing, vehFrames, walkActive: false, streak: 0 }),
    );
    eq(r.hit, true, "GREEN：车停靠本站 ⇒ 判上（GREEN）");
    eq(r.evidence, "atstop", "GREEN：证据 = atstop");
    eq(r.plate, "MC0001", "GREEN：唯一候选 ⇒ 锁定该车牌");
    eq(r.source, "vehicle", "GREEN：有牌 ⇒ 来源 vehicle");
    eq(r.need, 1, "GREEN：事件式判据 ⇒ need=1（第一帧就切，不等 streak）");
    eq(r.streak, 1, "GREEN：streak 累加 1");
  }

  /* ── ③ 不提前：车在路上 / 停别的站 ⇒ 不切 ── */
  {
    for (const [label, v] of [
      ["车在路上（atStation=null）", vMoving],
      ["车停靠在别的站", vAtOther],
    ] as const) {
      const r = autoBoardOf(inputOf({ vehicles: [v], fixes: standing, walkActive: false, streak: 2 }));
      eq(r.hit, false, `不提前：${label} ⇒ 不切`);
      ok(r.evidence !== "atstop", `不提前：${label} 的证据不得是 atstop`, `evidence=${r.evidence}`);
    }
  }

  /* ── ④ 不推后：车已离站（interval.from==board，atStation=null）⇒ **本条不触发** ── */
  {
    const r = autoBoardOf(inputOf({ vehicles: [vDeparted], fixes: standing, walkActive: false, streak: 2 }));
    ok(r.evidence !== "atstop", "不推后：已离站形态**不得**走停站判据（归旧的 L-a 路径）", `evidence=${r.evidence}`);
    eq(r.hit, false, "不推后：已离站 + 用户静止 ⇒ 本条不判上（离站路径要求位置判据）");
  }

  /* ── ⑤ ★ 总站上车：`status="terminal"` 必须照样切（原条件 `!== "terminal"` 是错的） ── */
  {
    const r = autoBoardOf(inputOf({ vehicles: [vAtBoardTerminal], fixes: standing, walkActive: false }));
    eq(r.hit, true, "★ 总站上车：status=terminal + 停靠本站 ⇒ 必须切（叠 status 过滤会永远切不了）");
    eq(r.evidence, "atstop", "★ 总站上车：证据 = atstop");
    eq(r.plate, "MC0002", "★ 总站上车：唯一候选 ⇒ 锁该牌");
  }

  /* ── ⑥ ★ `walkActive` 门：步行途中（人还没到站台）⇒ 不切 ── */
  {
    const r = autoBoardOf(inputOf({ vehicles: [vAtBoard], fixes: standing, walkActive: true, streak: 2 }));
    eq(r.hit, false, "★ walkActive=true（人还在去站台路上）+ 车停靠本站 ⇒ **不切**");
    /**
     * 钉住这道门为何**必需**（防后人当冗余删掉）：
     *   `NavShell.tsx:449-451` 写明 `startSession("out")` 在按下「开始导航」时
     *   **同时** `rideStart()`（phase→boarding）**且** `setWalkSeg("out")`
     *   ⇒ `phase === "boarding"` 在**步行段期间就已成立**；
     *   而 `tryAuto` 里**没有** walkActive 早退（`NavShell.tsx:407-412` 声称的「真互斥」从未实现）。
     *   ⇒ 若删掉这道门，「车已停在站台、人还在 300m 外」会被判成已上车。
     */
    ok(true, "（事实留痕）phase 在步行段期间已是 boarding ⇒ 本门必需，勿删");
  }

  /* ── ⑦ 多车歧义：两辆本线车停靠本站 ⇒ 切 riding 且 plate=null ── */
  {
    const v2: TrackVehicle = { ...vAtBoard, plate: "MC0006" };
    const r = autoBoardOf(inputOf({ vehicles: [vAtBoard, v2], fixes: standing, walkActive: false }));
    eq(r.hit, true, "多车歧义：两辆本线车停靠本站 ⇒ **仍然切 riding**");
    eq(r.plate, null, "多车歧义：车牌不锁（plate=null）—— **正常状态，不是缺陷**");
    eq(r.source, "gps", "多车歧义：无牌 ⇒ 来源退回 gps（走 GPS 推算）");
    eq(atBoardStopOf([vAtBoard, v2], "T100").n, 2, "atBoardStopOf 报出命中车辆数 2");
  }

  /* ── ⑧ `atBoardStopOf` 纯函数语义 ── */
  {
    eq(atBoardStopOf([], "T100").hit, false, "atBoardStopOf：无车 ⇒ 不命中");
    eq(atBoardStopOf([vAtBoard], "").hit, false, "atBoardStopOf：上车站码为空 ⇒ 不命中");
    eq(atBoardStopOf([vAtBoard], "T100/2").hit, true, "atBoardStopOf：站码归一生效（T100/2 → T100）");
    eq(atBoardStopOf([vAtMoving()], "T100").hit, false, "atBoardStopOf：车在路上 ⇒ 不命中");
    function vAtMoving(): TrackVehicle {
      return vMoving;
    }
  }

  /* ── ⑨ 与位置判据的关系：两者都能命中时，停站判据**先**（短路） ── */
  {
    const vehFrames = [0, 1, 2, 3, 4].map((i) => vehAt("MC0001", 0, 100_000 + i * 12_000));
    const r = autoBoardOf(
      inputOf({
        vehicles: [vAtBoard],
        fixes: ridingFixes, // 即使位置判据也成立
        vehFrames,
        walkActive: false,
        streak: 2,
      }),
    );
    eq(r.evidence, "atstop", "停站判据短路在前：即使位置判据也成立，证据仍报 atstop");
    eq(r.hit, true, "停站判据短路：命中即返回");
  }

  /* ── ⑩ 冷却 / 次数用尽仍生效（停站判据不得绕过 G3） ── */
  {
    const cooling = autoBoardOf(
      inputOf({
        vehicles: [vAtBoard],
        fixes: standing,
        walkActive: false,
        lastSwitchTs: 1_000_000 - 1_000,
        nowMs: 1_000_000,
      }),
    );
    eq(cooling.hit, false, "停站判据同样受 20s 冷却约束（G3 在它之前）");
    const noLeft = autoBoardOf(inputOf({ vehicles: [vAtBoard], fixes: standing, walkActive: false, autoLeft: 0 }));
    eq(noLeft.hit, false, "次数用尽 ⇒ 停站判据也不再触发（如实停手）");
  }
}

const total = pass + fail;
console.log(`\n结果：${fail === 0 ? "PASS" : "FAIL"} · ${pass}/${total} 通过${fail ? ` · ${fail} 失败` : ""}`);
process.exit(fail === 0 ? 0 : 1);
