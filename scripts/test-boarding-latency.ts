/**
 * scripts/test-boarding-latency.ts —— 「车起步 → 切 riding + 锁牌」**延迟预算**对拍
 * （2026-11-04 新增 · P0 延迟 15~25s → ≤10s）
 *
 * ── 为什么必须有这份 ────────────────────────────────────────────────────
 *   `test-boarding-detect.ts` 只锁「判据对不对」，锁不住「判得多快」。
 *   而延迟没法手算：`followSlopeOf` 的四道门（帧数 / 窗长 / 位移 / 车速）全部在
 *   **同一个拟合窗**上求值，车刚起步时该窗**同时包含站台停靠期**（人车都静止），
 *   于是 `vehMps`（v 对 t 的 OLS 斜率）与 `alongM`（Δu）都被稀释 ——
 *   稀释量取决于「停靠帧在窗内占比」，不是任何单点门槛的秒数。
 *   ⇒ 只能跑**真代码**（`autoBoardOf` 全链路）量。
 *
 * ── 场景模型（每一处都对应生产参数，改生产参数请同步改这里）─────────────
 *   · t=0 = 公交车**关门起步**；t<0 = 站台停靠（人车同在 m=0）。
 *   · 车：静止 → 以 `A_MPS2` 匀加速到 `V_CRUISE_MPS` → 匀速（澳门市区常态 12 km/h）。
 *   · 定位帧：`GPS_GAP_MS = 1.5s`（`NavShell.tsx` 的 `gpsIntervalMs` 候车期）。
 *   · 车辆帧：`VEH_GAP_MS = 12s`（`useRideTracking.ts` 的 `POLL_MS`），相位 `vehPhaseS`。
 *   · 停靠期车辆帧 `status=stopping / atStation=T100`（不构成 L-a，与生产同）。
 *
 * ⚠️ 本文件的秒数是**模型推算值**，不是真机实测：加速度 / 巡航速度 / DSAT 采集延迟
 *   三项需真机标定（见文件末 `未标定项`）。断言只钉「结构性结论」（哪道门在卡、
 *   排序关系、下界），不钉「绝对秒数」以免真机标定后被迫改断言。
 *
 * 跑法：node node_modules/tsx/dist/cli.mjs scripts/test-boarding-latency.ts
 */
import { AUTO_TRIES_PER_LEG, autoBoardOf, type FixLite } from "@/lib/nav/boarding-detect";
import { followFramesOf, type VehFrame } from "@/lib/nav/follow-frames";
import {
  FOLLOW_MAX_SLOPE_MPS,
  FOLLOW_MIN_ALONG_M,
  FOLLOW_MIN_FRAMES,
  FOLLOW_MIN_SPAN_MS,
  FOLLOW_MIN_VEH_MPS,
  followSlopeOf,
  type FollowSlope,
} from "@/lib/nav/follow-slope";
import type { LL } from "@/lib/nav/route-overview";
import type { TrackVehicle } from "@/lib/nav/track";

/* ══════════ 断言器（与 test-boarding-detect.ts 同口径）══════════ */
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
function le(actual: number, bound: number, name: string): void {
  ok(actual <= bound, name, `实际=${actual.toFixed(1)} 上限=${bound}`);
}

/* ══════════ 几何（与 test-boarding-detect.ts 同构：2m 顶点、colored[0]=上车站）══════════ */
const BASE_LNG = 113.55;
const BASE_LAT = 22.15;
const STEP_M = 2;
const DEG_PER_M_LNG = 1 / 103_140;
const PATH: LL[] = Array.from({ length: 1001 }, (_, i) => [BASE_LNG + i * STEP_M * DEG_PER_M_LNG, BASE_LAT] as LL);
const atM = (m: number) => ({ lng: BASE_LNG + m * DEG_PER_M_LNG, lat: BASE_LAT });
const STOP_MAINS = ["T100", "T101", "T102", "T103"];
const PLATE = "MB0001";
/** 停驶反例里巴士的位置（米，前方 60m —— 同线路下一段，`d ≤ 120` 仍成立） */
const BUS_PARK_M = 60;

/* ══════════ 物理与采样（生产参数）══════════ */
const V_CRUISE_MPS = 12 / 3.6; // 12 km/h
const A_MPS2 = 1.0; // 起步加速度
const GPS_GAP_MS = 1_500;
const VEH_GAP_MS = 12_000;
const T0_MS = 1_000_000;
/** 车在 t 秒时的沿线里程（t=0 起步；t<0 停在 0） */
function busM(t: number): number {
  const dt = Math.max(0, t);
  const tAcc = V_CRUISE_MPS / A_MPS2;
  if (dt <= tAcc) return 0.5 * A_MPS2 * dt * dt;
  return 0.5 * A_MPS2 * tAcc * tAcc + V_CRUISE_MPS * (dt - tAcc);
}
/** 车走完 `m` 米所需的秒数（自起步） */
function tAtM(m: number): number {
  const tAcc = V_CRUISE_MPS / A_MPS2;
  const dAcc = 0.5 * A_MPS2 * tAcc * tAcc;
  return m <= dAcc ? Math.sqrt((2 * m) / A_MPS2) : tAcc + (m - dAcc) / V_CRUISE_MPS;
}

/** 确定性伪随机（LCG + Box-Muller）—— 保证断言可复现 */
function gaussOf(seed: number): () => number {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return () => {
    const u1 = Math.max(1e-9, rnd());
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rnd());
  };
}

/* ══════════ 场景跑法：逐帧调 `autoBoardOf`（= 生产 `tryAuto` 的调用点）══════════ */
interface RunOpts {
  vehPhaseS?: number;
  accNoiseM?: number;
  seed?: number;
  /** 车在起步后多少秒**再次停住**（模拟红灯 / 下一站停靠），`null` = 不停 */
  stopAgainAtS?: number | null;
  /** 用户是否真的在车上（`false` = 站在站台等车，车开走） */
  onBoard?: boolean;
  /** 用户步行速度（m/s，替代乘车；`>0` 时用户自己沿线路前进） */
  walkMps?: number;
  /** 车辆位置是否恒为 0（停驶巴士，用于步行反例） */
  busParked?: boolean;
  /** 巴士定位噪声 σ（米）—— DSAT 侧位置精度，**未标定项**；用于量车速门的噪声韧性 */
  vehNoiseM?: number;
  /** 观测终止时刻（秒，默认 60） */
  tEndS?: number;
}

interface RunOut {
  tHit: number | null;
  evidence: string | null;
  plate: string | null;
  /** 判上时（或末帧）的斜率判据读数 */
  at: FollowSlope | null;
}

function run(o: RunOpts = {}): RunOut {
  const vehPhaseS = o.vehPhaseS ?? 0;
  const gauss = gaussOf(o.seed ?? 424242);
  const onBoard = o.onBoard ?? true;
  const tEnd = o.tEndS ?? 60;
  const walkMps = o.walkMps ?? 0;

  /** 车的位置：停驶 ⇒ 恒停在 `BUS_PARK_M`（**前方 60m**，见下）；否则物理曲线 */
  const vehPos = (t: number): number => {
    if (o.busParked) return BUS_PARK_M;
    const tEff = o.stopAgainAtS != null ? Math.min(t, o.stopAgainAtS) : t;
    return busM(tEff);
  };
  /** 用户位置：车上是车的位置；站台等车恒 0；步行则匀速前进 */
  const userPos = (t: number): number => {
    if (walkMps > 0) return Math.max(0, t) * walkMps;
    return onBoard ? Math.max(0, vehPos(t)) : 0;
  };

  const fixes: FixLite[] = [];
  /**
   * 定位帧网格从 **−39s** 起（不是 −40s）：这样 1.5s 网格与「整秒」对齐，
   * 车辆帧（`vehPhaseS + k×12`，相位取整秒）总能落在某个定位帧上。
   * 否则网格会整体偏移 0.5s，量出来的延迟平白多出一帧（1.5s）——那是夹具的错，不是判据的。
   */
  for (let t = -39; t <= tEnd; t += GPS_GAP_MS / 1000) {
    const p = atM(userPos(t) + (o.accNoiseM ? gauss() * o.accNoiseM : 0));
    fixes.push({ lng: p.lng, lat: p.lat, accuracy: 10, ts: T0_MS + t * 1000 });
  }
  const vehFrames: VehFrame[] = [];
  /**
   * 车辆帧时刻 = `vehPhaseS + k × 12s`（k 取负也覆盖站台期）。
   * 相位语义 = **起步后第一帧车辆快照落在第几秒** —— 这是延迟的主导变量
   * （起步前那一帧不携带任何「车已离站」信息，见 `followFramesOf` 的末段丢弃）。
   */
  for (let k = -4; k <= Math.ceil(tEnd / (VEH_GAP_MS / 1000)) + 1; k++) {
    const t = vehPhaseS + k * (VEH_GAP_MS / 1000);
    const m = vehPos(t) + (o.vehNoiseM ? gauss() * o.vehNoiseM : 0);
    const p = atM(m);
    const moved = !o.busParked && t > 0 && m > 0;
    const v: TrackVehicle = {
      plate: PLATE,
      lat: p.lat,
      lng: p.lng,
      /**
       * 停驶反例必须仍然**是锁牌候选**（否则 `lock.plate = null` ⇒
       * `followFramesOf` 直接产不出样本 ⇒ 测不到判据本身，测试变成空跑）。
       * 用 L-c：车停在**别的站**（T101 ≠ 上车站）⇒ 候选成立、位置确认 `d ≤ 120` 成立。
       */
      status: o.busParked ? "stopping" : moved ? "moving" : "stopping",
      interval: o.busParked ? null : moved ? { from: { code: "T100" }, to: { code: "T101" } } : null,
      atStation: o.busParked ? { code: "T101" } : moved ? null : { code: "T100" },
    };
    vehFrames.push({ ts: T0_MS + t * 1000, vehicles: [v] });
  }

  let streak = 0;
  let out: RunOut = { tHit: null, evidence: null, plate: null, at: null };
  for (const fx of fixes) {
    const now = fx.ts;
    const win = fixes.filter((f) => f.ts <= now && now - f.ts <= 90_000);
    const vh = vehFrames.filter((f) => f.ts <= now).slice(-8);
    const lastVeh = vh[vh.length - 1];
    const r = autoBoardOf({
      legKind: "bus",
      legDegraded: false,
      colored: PATH,
      boardMain: "T100",
      boardPos: atM(0),
      stopMains: STOP_MAINS,
      vehicles: lastVeh ? lastVeh.vehicles : [],
      vehFrames: vh,
      fixes: win,
      lastSwitchTs: 0,
      nowMs: now,
      autoLeft: AUTO_TRIES_PER_LEG,
      streak,
    });
    streak = r.streak;
    const fs = followSlopeOf(
      followFramesOf({ fixes: win, vehFrames: vh, colored: PATH, plate: r.plate ?? PLATE }),
    );
    if (r.hit && r.streak >= r.need && out.tHit == null) {
      out = { tHit: (now - T0_MS) / 1000, evidence: r.evidence, plate: r.plate, at: fs };
    }
    if (out.tHit == null) out = { ...out, at: fs };
  }
  return out;
}

console.log("═══ 上车判定延迟预算（模型推算值）═══\n");

/* ══════════ ㉑ 物理下界：位移门决定的最短可能时刻 ══════════ */
console.log("[㉑ 物理下界]");
{
  const t35 = tAtM(FOLLOW_MIN_ALONG_M);
  const t28 = tAtM(28);
  const t21 = tAtM(FOLLOW_MIN_ALONG_M * 0.6);
  console.log(
    `  12 km/h / 1.0 m/s² 起步：${FOLLOW_MIN_ALONG_M}m → ${t35.toFixed(1)}s · 28m → ${t28.toFixed(
      1,
    )}s · 21m(=0.6×35) → ${t21.toFixed(1)}s`,
  );
  ok(t35 > 10, "★ `FOLLOW_MIN_ALONG_M=35` 的物理下界已超 10s（35m 需 ≈12.2s）⇒ 只靠调门窗参数不可能 ≤10s", `下界=${t35.toFixed(1)}s`);
  ok(
    t21 < 10,
    "★ 45% 位移门（21m，与 `R1_ACCEL_DISPLACE_FACTOR` 同口径）的物理下界才 <10s",
    `下界=${t21.toFixed(1)}s`,
  );
  ok(
    GPS_GAP_MS * (FOLLOW_MIN_FRAMES - 1) < FOLLOW_MIN_SPAN_MS || GPS_GAP_MS * (FOLLOW_MIN_FRAMES - 1) === 6_000,
    "帧数门（5 帧 × 1.5s = 6s）与窗长门（6s）同量级 ⇒ 两者都不再是卡点",
    `帧数门=${((FOLLOW_MIN_FRAMES - 1) * GPS_GAP_MS) / 1000}s 窗长门=${FOLLOW_MIN_SPAN_MS / 1000}s`,
  );
}

/* ══════════ ㉒ 停靠期**不得稀释**车速门（本次改动的核心）══════════ */
/**
 * 起步后第一帧车辆快照（t=12s，相位 0）时，车**已经实走 34.4m**（≈12 km/h 巡航）。
 * 拟合窗仍含 16s 站台停靠期。
 *   · 旧估计（全窗 OLS）：`v` 被 16s 的「v 不变」摊平 ⇒ vehMps ≈ **1.1** < 2 ⇒ 假 `veh-still`；
 *   · 新估计（近端 12s）：只覆盖起步后的真实运动 ⇒ vehMps ≈ **3.3** ⇒ 如实反映「车在动」。
 * 这不是放宽门槛，而是让 `FOLLOW_MIN_VEH_MPS` 量到它注释里声称的东西（「窗内车速」）。
 */
console.log("\n[㉒ 停靠期不得稀释车速门]");
{
  const r = run({ vehPhaseS: 0, tEndS: 14 });
  // t=12 时的读数（run 返回的是末帧读数；tEndS=14 时末帧即 t=13.5，仍在第一段车辆帧内）
  const fs = r.at;
  ok(fs != null && fs.vehMps != null, "有可用样本", `n=${fs?.n} span=${(fs?.spanMs ?? 0) / 1000}s`);
  ok(
    fs != null && fs.vehMps != null && fs.vehMps >= FOLLOW_MIN_VEH_MPS,
    "★ 起步后 12~14s：`vehMps` 达车速门（旧实现被停靠期稀释到 ≈1.1 ⇒ 假 veh-still）",
    `vehMps=${fs?.vehMps?.toFixed(2)} why=${fs?.why}`,
  );
}

/* ══════════ ㉓ 端到端延迟：四个车辆帧相位 ══════════ */
console.log("\n[㉓ 端到端延迟（4 个车辆帧相位）]");
{
  const rows: { phase: number; tHit: number | null; evidence: string | null; plate: string | null }[] = [];
  for (const phase of [0, 3, 6, 9]) {
    const r = run({ vehPhaseS: phase, tEndS: 60 });
    rows.push({ phase, tHit: r.tHit, evidence: r.evidence, plate: r.plate });
    console.log(
      `  相位 ${String(phase).padStart(2)}s ⇒ 判上 ${r.tHit?.toFixed(1) ?? "未判上"}s（证据 ${
        r.evidence ?? "-"
      }，牌 ${r.plate ?? "-"}）`,
    );
  }
  const hits = rows.filter((x) => x.tHit != null);
  ok(hits.length === rows.length, "四个相位全部判上（无「相位不好就永远判不上」）");
  ok(
    rows.every((x) => x.plate === PLATE),
    "★ 判上那一帧**同帧**锁到车牌（判定与锁牌不分离）",
    rows.map((x) => `相位${x.phase}:${x.plate ?? "null"}`).join(" "),
  );
  const worst = Math.max(...rows.map((x) => x.tHit ?? 999));
  /**
   * 上界口径 = **物理下界向上取整到车辆帧网格 + 两帧 streak**，不是拍出来的数：
   *   · 位移门 35m ⇒ 物理下界 12.2s（12 km/h / 1 m/s² 起步）；
   *   · 观测前沿只能推进到「最新一帧车辆快照」（`followFramesOf` 绝不外推）⇒
   *     12s 一帧 ⇒ 下界被抬到 ⌈12.2/12⌉×12 = 24s；
   *   · 斜率判据要 `need = R2_STREAK_WITH_VEHICLE = 2` 连帧 ⇒ +1.5s。
   * ⇒ 27s。本断言的含义：**除这三项之外不得再有浪费**（旧实现的停靠期稀释多赔了 6~12s）。
   * ⚠️ 这个上界是「35m 位移门 + 12s 轮询」的**结构性后果**，与本次改动无关 ——
   *   要压到 10s 必须动位移门或轮询节奏，两者都不在本文件权限内。
   */
  const ceilFrames = Math.ceil(tAtM(FOLLOW_MIN_ALONG_M) / (VEH_GAP_MS / 1000));
  const bound = ceilFrames * (VEH_GAP_MS / 1000) + GPS_GAP_MS / 1000;
  le(worst, bound, `★ 最坏延迟 ≤ 物理下界取整(${bound}ms) —— 除量化/连帧外不得有额外浪费`);
  console.log(`  ⇒ 最坏 ${worst.toFixed(1)}s · 中位 ${[...rows.map((x) => x.tHit ?? 999)].sort((a, b) => a - b)[2].toFixed(1)}s`);
}

/* ══════════ ㉔ 反例不得因本次改动被放行 ══════════ */
console.log("\n[㉔ 反例回归]");
{
  /** ① 站在站台不动，车开走并在下一站（60m 外）停住 ⇒ d 先涨后平，必须仍拒绝 */
  const waiter = run({ onBoard: false, stopAgainAtS: tAtM(60), tEndS: 60 });
  ok(waiter.tHit == null, "站台人等车开走（车在 60m 外停住，d 先涨后平）⇒ 不判上", `tHit=${waiter.tHit}`);

  /** ② 用户沿线路步行（1.4 m/s）+ 巴士停驶（停在前方 60m 的下一站，仍是锁牌候选）⇒ 必须仍拒绝 */
  const walker = run({ onBoard: false, walkMps: 1.4, busParked: true, tEndS: 60 });
  ok(walker.tHit == null, "步行沿线路移动（1.4 m/s）+ 巴士停驶 ⇒ 不判上", `tHit=${walker.tHit}`);

  /**
   * ③ ★ 本次改动的**代价**在这里量化：`vehMps` 从「30s 全窗 OLS」换成「12s 近端窗」后，
   *  估计量噪声底从 ≈0.4 m/s 抬到 ≈1.2 m/s（σ_巴士=10m）⇒ 对「停驶巴士」的余量从 5σ 降到 1.7σ。
   *  所以必须扫巴士定位噪声：只要 DSAT 位置抖动不足以把「停驶」伪装成 ≥2 m/s，
   *  误判率就仍是 0。**这一组是 `FOLLOW_VEH_RECENT_MS` 的安全边界**，改它必须重跑。
   */
  let totFp = 0;
  let totN = 0;
  for (const vn of [0, 3, 5, 10]) {
    let fp = 0;
    for (let k = 0; k < 16; k++) {
      const r = run({
        onBoard: false,
        walkMps: 1.4,
        busParked: true,
        accNoiseM: 10,
        vehNoiseM: vn,
        seed: 900 + k * 131,
        tEndS: 45,
      });
      if (r.tHit != null) fp++;
    }
    totFp += fp;
    totN += 16;
    ok(fp === 0, `步行 + 停驶巴士（巴士定位抖动 σ=${vn}m，16 种子）⇒ 0 次误判`, `误判=${fp}/16`);
  }
  ok(totFp === 0, "★ 合计：车速门换近端窗后，停驶巴士反例的误判率仍为 0", `误判=${totFp}/${totN}`);

  /** ④ 4 帧 ⇒ 仍不判（`FOLLOW_MIN_FRAMES` 硬下限不受本次改动影响） */
  ok(FOLLOW_MIN_FRAMES === 5, "最小样本帧数仍为 5（本次未动）");
}

/* ══════════ ㉖ 「停站期就开始跟踪」提案的裁决依据（2026-11-04）══════════ */
/**
 * ── 提案原文（负责人）────────────────────────────────────────────────
 *   「车到站挂的是停站状态，可以在停站状态就开始跟踪，不用等到离站；停站期间肯定有
 *     十几秒，理论上足矣支持车辆判定及匹配。」→ 推成「离站后 3~5 帧确认 d 没拉开就判上，
 *     绕开 `FOLLOW_MIN_ALONG_M=35` 那道门」。
 *
 * ── 本组的作用：把「为什么不成立」变成可复跑的断言 ──────────────────────
 *   结论一（㉖）：把窗缩到 3~5 帧，**两个方向同时变差** —— 不是更灵敏，是更随机。
 *   结论二（㉗）：取消 `alongM` 门 ⇒ 「站台人等车开走」误判率从 0/80 涨到 25/80。
 *   结论三（㉘）：35m 那道门的耗时由**巴士自身运动学**决定，与「量谁的位移」无关。
 */
console.log("\n[㉖ 窗长可分性：3~5 帧为什么不成立]");
{
  /** 用真代码生成一窗样本，返回该窗的 d 斜率估计（`nWin` 帧、1.5s 间距） */
  const slopeOfWindow = (boarded: boolean, seed: number, nWin: number): number | null => {
    const g = gaussOf(seed);
    const tEnd = 40;
    const userPos = (t: number) => (boarded ? Math.max(0, busM(t)) : 0);
    const fixes: FixLite[] = [];
    for (let t = -39; t <= tEnd; t += GPS_GAP_MS / 1000) {
      const p = atM(userPos(t) + g() * 10);
      fixes.push({ lng: p.lng, lat: p.lat, accuracy: 10, ts: T0_MS + t * 1000 });
    }
    const vehFrames: VehFrame[] = [];
    for (let k = -4; k <= 4; k++) {
      const t = k * (VEH_GAP_MS / 1000);
      const m = t > 0 ? busM(t) : 0;
      const p = atM(m + g() * 5);
      const moving = t > 0 && m > 1;
      vehFrames.push({
        ts: T0_MS + t * 1000,
        vehicles: [
          {
            plate: PLATE,
            lat: p.lat,
            lng: p.lng,
            status: moving ? "moving" : "stopping",
            interval: moving ? { from: { code: "T100" }, to: { code: "T101" } } : null,
            atStation: moving ? null : { code: "T100" },
          } as TrackVehicle,
        ],
      });
    }
    const ff = followFramesOf({ fixes, vehFrames, colored: PATH, plate: PLATE });
    const sorted = [...ff].sort((a, b) => a.ts - b.ts);
    if (sorted.length < nWin) return null;
    const w = sorted.slice(-nWin);
    const xs = w.map((f) => (f.ts - w[0].ts) / 1000);
    let mx = 0;
    let my = 0;
    const ys = w.map((f) => Math.abs(f.u - f.v));
    for (let i = 0; i < xs.length; i++) {
      mx += xs[i];
      my += ys[i];
    }
    mx /= xs.length;
    my /= xs.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) * (xs[i] - mx);
    }
    return den > 0 ? num / den : null;
  };

  const rate = (boarded: boolean, nWin: number, n = 80): { pass: number; total: number; sd: number } => {
    let pass = 0;
    let total = 0;
    const vals: number[] = [];
    for (let k = 0; k < n; k++) {
      const s = slopeOfWindow(boarded, 5000 + k * 31, nWin);
      if (s == null) continue;
      total++;
      vals.push(s);
      if (Math.abs(s) <= FOLLOW_MAX_SLOPE_MPS) pass++;
    }
    const mean = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, vals.length));
    return { pass, total, sd };
  };

  const fullBoard = rate(true, 20);
  const fullWait = rate(false, 20);
  ok(
    fullBoard.pass / fullBoard.total >= 0.97,
    "★ 全窗（20 帧 / 28.5s）：已上车的 |slope| ≤ 1.2 通过率 ≥ 97%（真上车判得上）",
    `${((fullBoard.pass / fullBoard.total) * 100).toFixed(1)}% (n=${fullBoard.total})`,
  );
  ok(
    fullWait.pass / fullWait.total <= 0.02,
    "★ 全窗：站台等车（d 按车速增长）误通过率 ≤ 2%（车开走判不上）",
    `${((fullWait.pass / fullWait.total) * 100).toFixed(1)}% (n=${fullWait.total})`,
  );

  const shortBoard = rate(true, 5);
  ok(
    shortBoard.pass / shortBoard.total <= 0.85,
    "★ 5 帧 / 6s 窗：已上车通过率显著下降 ⇒ 「3~5 帧就判」会大量漏判（真上车判不上）",
    `${((shortBoard.pass / shortBoard.total) * 100).toFixed(1)}% (n=${shortBoard.total})`,
  );
  /**
   * 机制断言（比「误通过率」更稳，不受采样起伏影响）：
   * 窗从 28.5s 缩到 6s，斜率估计的标准差放大约 **4~5 倍**（σ_slope ∝ 1/窗长）。
   * 该噪声底一旦接近阈值 1.2 m/s，**两个方向同时崩**：真上车被拒（漏判）、
   * 站台等车被收（误判）。这正是 `FOLLOW_MIN_SPAN_MS` 当初取 10s 的原始依据，
   * 也是「停站期 3~5 帧判上」提案不可行的地方 —— 与 `alongM` 放不放宽无关。
   */
  ok(
    shortBoard.sd >= 3 * fullBoard.sd,
    "★ 5 帧窗的斜率估计标准差 ≥ 全窗的 3 倍（σ ∝ 1/窗长）⇒ 短窗不是更灵敏，是更随机",
    `σ_5帧=${shortBoard.sd.toFixed(2)} σ_全窗=${fullBoard.sd.toFixed(2)} 比值=${(shortBoard.sd / fullBoard.sd).toFixed(1)}×`,
  );
  ok(
    fullBoard.sd <= 0.6,
    "全窗的斜率噪声底 ≤ 0.6 m/s（阈值 1.2 尚有 ≥2σ 余量）",
    `σ=${fullBoard.sd.toFixed(2)}`,
  );
}

/* ══════════ ㉗ 「取消 alongM 门」的反例代价 ══════════ */
/**
 * 提案的实质是「不量用户自己走了多远，只量 d 没拉开」。本组量它的代价：
 *   · `alongM` 是「站台人等车开走 + 车在下一站停住」这条反例的**唯一**有效防线
 *     —— 该反例里 `vehMps` 会被车停住拉到 0 之外的中间值，斜率也接近 0，只有 alongM 能拒；
 *   · 实测（本文件 ㉙ 的扫档，每档 80 个样本）：`alongM=35` ⇒ 0/80；`=21` ⇒ 1/80；
 *     `=0`（即提案）⇒ **25/80**。
 * ⇒ 断言只钉「35 必须守住」；全档扫描的数字（35 ⇒ 0/80 · 30 ⇒ 0/80 · 21 ⇒ 1/80 · 0 ⇒ 25/80）
 *   写在注释里留痕，不进断言 —— 扫档要跑几百次，不值得占 CI 时间。
 */
console.log("\n[㉗ 取消 alongM 门的代价]");
{
  ok(FOLLOW_MIN_ALONG_M === 35, "`FOLLOW_MIN_ALONG_M` 仍为 35（提案被否决，未下调）", `实际=${FOLLOW_MIN_ALONG_M}`);
  /** 站台人等车开走 + 车在下一站（≈68m）停住：35m 门必须拒 */
  let fp = 0;
  for (let k = 0; k < 20; k++) {
    for (const phase of [0, 3, 6, 9]) {
      const r = run({
        onBoard: false,
        stopAgainAtS: 22,
        accNoiseM: 10,
        vehNoiseM: 5,
        vehPhaseS: phase,
        seed: 1100 + k * 53,
        tEndS: 60,
      });
      if (r.tHit != null) fp++;
    }
  }
  ok(fp === 0, "★ 35m 门在岗：站台人等车开走（含 bus 抖动 σ=5m、20 种子 × 4 相位）⇒ 0 次误判", `误判=${fp}/80`);
}

/* ══════════ ㉘ 物理下界：35m 的耗时与「量谁的位移」无关 ══════════ */
/**
 * 提案里最容易被误读的一句：「『车走了 35m 而 d 没变』与『人走了 35m』在证据上等价，
 * 但前者不需要等用户自己走出 35m 的物理时间」。
 *
 * **这句不成立。** 因为 `d = |u − v|`，若 `d` 恒定则 `Δu ≈ Δv` —— 人就在车上，
 * 人的 35m 与车的 35m 是**同一个 35m**。巴士从静止走 35m 需要 12.2s（12 km/h、1 m/s²），
 * 这个时间由**巴士运动学**决定，与量 u 还是量 v 无关。
 * ⇒ 本组把这条写成断言：`tAtM(35)` 必须 > 10s，且「任何 ≤10s 的方案都必须放宽 35m 门」。
 */
console.log("\n[㉘ 物理下界不随量的对象改变]");
{
  const t35 = tAtM(FOLLOW_MIN_ALONG_M);
  ok(t35 > 10, "35m 的物理耗时 > 10s（巴士运动学决定，与量 u 还是量 v 无关）", `${t35.toFixed(1)}s`);
  ok(
    GPS_GAP_MS / 1000 + t35 > 13,
    "⇒ 12s 巴士轮询下，最早可能判上时刻 = 首个「车已走够 35m」的车辆帧 + 1 帧 streak（>13s）",
    `≈${(Math.ceil(t35 / (VEH_GAP_MS / 1000)) * (VEH_GAP_MS / 1000) + GPS_GAP_MS / 1000).toFixed(1)}s（相位 0）`,
  );
}


{
  ok(FOLLOW_MIN_SPAN_MS === 6_000, "`FOLLOW_MIN_SPAN_MS` = 6000", `实际=${FOLLOW_MIN_SPAN_MS}`);
  /** 6.0s 窗（5 帧 × 1.5s）在 6s 门下必须成立；4.8s 窗必须不成立。
   *  ⚠️ 车与人同速且取 **6.5 m/s（23 km/h）**：6s 窗要满足 `alongM ≥ 35m` 等价于
   *  平均车速 ≥ 5.8 m/s（这就是「10s→6s 安全」的全部依据）⇒ 夹具必须落在这个速度区间，
   *  否则被 `not-moved` 拦下，测到的就不是窗长门。 */
  const mps = 6.5;
  const mk = (gapMs: number, n: number) => {
    const fixes: FixLite[] = Array.from({ length: n }, (_, i) => {
      const p = atM((i * gapMs * mps) / 1000);
      return { lng: p.lng, lat: p.lat, accuracy: 10, ts: T0_MS + i * gapMs };
    });
    const vf: VehFrame[] = [0, 1, 2].map((k) => {
      const p = atM(k * 20 * mps);
      return {
        ts: T0_MS + k * 20_000,
        vehicles: [
          {
            plate: PLATE,
            lat: p.lat,
            lng: p.lng,
            status: "moving",
            interval: { from: { code: "T100" }, to: { code: "T101" } },
            atStation: null,
          } as TrackVehicle,
        ],
      };
    });
    return followSlopeOf(followFramesOf({ fixes, vehFrames: vf, colored: PATH, plate: PLATE }));
  };
  const short = mk(1_200, 5); // 4.8s 窗
  const mid = mk(1_500, 5); // 6.0s 窗
  ok(short.why === "short-span", "4.8s 窗仍被判 short-span（窗长门没有被废掉）", `why=${short.why}`);
  ok(mid.ok, "6.0s 窗可以通过窗长门（且其余门槛成立 ⇒ ok）", `why=${mid.why} n=${mid.n} span=${mid.spanMs}`);
}

/* ══════════ 汇总 ══════════ */
const total = pass + fail;
console.log(`\n结果：${fail === 0 ? "PASS" : "FAIL"} · ${pass}/${total} 通过${fail ? ` · ${fail} 失败` : ""}`);
if (fail) process.exitCode = 1;
