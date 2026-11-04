/**
 * scripts/test-boarding-latency.ts —— 「上车 → 切 riding + 锁牌」**延迟预算**对拍
 * （2026-11-04 新增 · P0 延迟 15~25s → ≤10s；2026-11-05 补停站判据路径）
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ **先读这段，否则会把数字读反**（2026-11-05 判据格局变了）
 *
 *   本文件测的是**两条判据路径**，它们的延迟差一个数量级：
 *
 *   | 路径 | 触发条件 | 实测延迟 | 覆盖场景 | 断言组 |
 *   |---|---|---|---|---|
 *   | **停站判据** `atBoardStopOf` | 车 `atStation` == 上车站 | **中位 6.0s / 平均 5.5s / 最差 11.0s** | 约 90%+ （dwell ≥ 12s） | ㉚ |
 *   | 位置判据 r2 / 跟车斜率 | 用户随线路移动 | 中位 19.5~20.0s / 最差 29~31.5s | 漏停站帧的少数场景 | ㉑~㉘ |
 *
 *   ⇒ **用户实际等待 ≈ 6s，不是 20s。** 只引 ㉑~㉘ 的 20s 会严重高估。
 *     停站判据是 2026-11-05 负责人裁决新增（「车到上车站 ⇒ 立刻切 riding」），
 *     它把「等车走够 35m（12.2s 物理下界）」这道门整条绕过了。
 *
 *   ⚠️ 本文件 ㉑~㉘ 的夹具显式传 `walkActive: true`（由 be-plate 在 `f009c9a` 加，
 *     fe-latency 已复核：仅此一行 + 注释，断言数 26 处/28 条改前改后一致）。
 *     目的是**隔离出位置判据**，不代表「用户在走路」。停站判据本身在 ㉚ 与
 *     `test-boarding-detect.ts` ㉒ 组覆盖。
 *
 *   ⚠️ 停站判据的已接受代价（㉚ 末两条断言钉住行为，防被当 bug 修掉）：
 *     · 用户留守站台、车停靠本站 ⇒ 也会判上（裁决「车到了就会上车」）；
 *     · `walkActive=true`（仍在步行段）时该判据被门挡住 —— 这道门是必需的。
 * ══════════════════════════════════════════════════════════════════════
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
 *   · 位置判据（`run()`）：t=0 = 公交车**关门起步**；t<0 = 站台停靠（人车同在 m=0）。
 *   · 停站判据（`runStation()`）：`arriveS` = 车到站；`dwellS` = 停靠时长（生产中位 40s）。
 *   · 车：静止 → 以 `A_MPS2` 匀加速到 `V_CRUISE_MPS` → 匀速（澳门市区常态 12 km/h）。
 *   · 定位帧：`GPS_GAP_MS = 1.5s`（`NavShell.tsx` 的 `gpsIntervalMs` 候车期）。
 *   · 车辆帧：`VEH_GAP_MS = 12s`（`useRideTracking.ts` 的 `POLL_MS`），相位 `vehPhaseS`。
 *
 * ⚠️ 本文件的秒数是**模型推算值**，不是真机实测：加速度 / 巡航速度 / DSAT 采集延迟 /
 *   dwell 分布四项需真机标定。断言只钉「结构性结论」（哪道门在卡、排序关系、上界），
 *   不钉「绝对秒数」以免真机标定后被迫改断言。
 * ⚠️ 量化误差（偏向高估，可接受）：本文件只在**定位帧**上调用 `autoBoardOf`，而生产
 *   `tryAuto` 在车辆帧到达后也会调用 ⇒ 停站判据的实测延迟最多比真机多 1.5s。
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
      /**
       * ⚠️ 2026-11-05（be-plate 加，fe-latency 请复核）：**只为隔离判据路径，不代表"用户在走路"**。
       *
       * 本套件测的是「**位置判据**（r2 / 跟车斜率）的延迟」，而 `walkActive` 是停站判据
       * （`atBoardStopOf`，2026-11-05 负责人裁决）唯一的开关。本文件的夹具在 t<0 让车
       * `atStation=T100`（停靠上车站）—— 按新裁决那**就是已上车** ⇒ 停站判据会在 t=0 立即
       * 命中（`evidence="atstop"`、`need=1`），于是「位置判据延迟」测不到任何东西。
       * ⇒ 传 `true` 把停站判据关掉，让本套件继续只测位置判据。
       *   停站判据本身由 `test-boarding-detect.ts` ㉒ 组覆盖（含"总站上车"/"walkActive 门"/"多车歧义"）。
       * ⚠️ 若将来删掉 `walkActive` 门，这群用例会立刻变红 —— 那是**信号**，不是误报。
       */
      walkActive: true,
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

/* ══════════ ㉓ 端到端延迟：四个车辆帧相位（**位置判据路径**）══════════ */
/**
 * ⚠️ 本组测的是**位置判据**（r2 / 跟车斜率）的端到端延迟，`walkActive: true` 隔离开了
 *   停站判据。它对应生产的**少数场景**（漏停站帧，约 5~10%）。
 *   **主路径的延迟见 ㉚（中位 6.0s）** —— 别只引本组的 20s，那会高估用户实际等待 3 倍。
 */
console.log("\n[㉓ 端到端延迟（位置判据路径 · 4 个车辆帧相位）]");
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
/**
 * ⚠️ **适用范围（2026-11-05 补）**：本组全部走**位置判据**路径（`walkActive: true` 隔离开停站判据）。
 *   生产里若用户已到站（`walkActive=false`），「车停靠上车站」会先被**停站判据**判上——
 *   那是 2026-11-05 负责人裁决接受的代价（见 ㉚ 末两条），**不是本组失效**。
 *   本组守住的是：**位置判据这一路**不得被"站台等车 / 步行"骗过。
 */
console.log("\n[㉔ 反例回归（位置判据路径）]");
{
  /** ① 站在站台不动，车开走并在下一站（60m 外）停住 ⇒ d 先涨后平，必须仍拒绝 */
  const waiter = run({ onBoard: false, stopAgainAtS: tAtM(60), tEndS: 60 });
  ok(waiter.tHit == null, "站台人等车开走（车在 60m 外停住，d 先涨后平）⇒ 位置判据不判上", `tHit=${waiter.tHit}`);

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
 *
 * ⚠️ **适用范围（2026-11-05 补）**：本组只对**位置判据**成立。停站判据不走 35m 位移，
 *   它的延迟由「车到站 → 下一个车辆帧」决定（㉚ 实测中位 6.0s），因此**不受本条约束**。
 *   换言之：负责人要的「≤10s」是靠**换判据**（停站）达成的，不是靠放宽 35m 门。
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

/* ══════════ ㉙ 【已知缺陷 · 非本批引入】FOLLOW_AMBIG_M 偏小 ⇒ 同线后车锁错 ══════════ */
/**
 * 🚩 **这是既有缺陷的留痕，不是断言**（本段零 `ok()` 调用、零生产代码）。
 *   写在这里的唯一目的：下一个读这份文件的人看到下面的数字时，**不要**先怀疑是
 *   `FOLLOW_VEH_RECENT_MS` / `FOLLOW_MIN_SPAN_MS` 这两项（本批改动）引入的 —— 两者无关。
 *
 * ── 现象 ────────────────────────────────────────────────────────────────
 *   场景：同线两辆车，前车 A 先走，用户上的是 8s 后到的后车 B（两车都在 `vehicles` 里）。
 *   实测（40 样本 = 10 种子 × 4 个车辆帧相位，用户定位 σ=10m、巴士 σ=5m）：
 *     · 锁对（B）       18/40
 *     · **锁错（A）     20/40 = 50%**
 *     · 歧义不锁（null） 2/40
 *     · 未判上           0/40
 *
 * ── 机制（★ 2026-11-05 更正：原判「歧义门太窄」不成立）──────────────────
 *   本段原写「机制 = `FOLLOW_AMBIG_M`(20m) 小于实际可分距离 ⇒ 门不触发」。
 *   be-plate 用真代码（`departedCandidatesOf` + 只取 argmin、**完全绕开歧义门**）复测：
 *   **60.3% 选错**（6 相位 × 3 种子 × 474 样本）⇒ **根因与门宽无关**。
 *
 *   真根因 = `d` 把**两个时刻**相减：旧口径 `d = |u(当前定位帧) − v(最近车辆帧)|`，
 *   两者相差 0~12s（`POLL_MS`）⇒ 两车同时被回退 `lag·v`（最多 40m）。用户在后车时，
 *   前车的**旧**位置恰好落到用户附近 ⇒ argmin 系统性偏向先走的那辆：
 *     lag 10s ⇒ d_前 6.6 / d_后 33.3（锁错）· lag 1s ⇒ 23.4 / 3.3（锁对）
 *   lag 在 0~12s 均匀 ⇒ 约 2/3 帧判错。旧 20m 标称「2σ」但错位 d 的 σ≈26m
 *   ⇒ 实际只有 **0.8σ**，门形同不存在（这才是「26.7m 看着 > 20m 却仍频繁锁错」的解释）。
 *
 * ── 归属（重要）────────────────────────────────────────────────────────
 *   `FOLLOW_AMBIG_M` 原值 20 由 I-3（`82ae10d`，be-plate）定下，**不是本批引入**。
 *   本批两笔改动（`e8c663b`：`FOLLOW_VEH_RECENT_MS` 近端窗 + `FOLLOW_MIN_SPAN_MS` 10s→6s）
 *   **完全没有触碰 `plate-lock.ts`、`pickLockPlateOf`、`FOLLOW_AMBIG_M`**，与该缺陷无关。
 *   ⚠️ 交互已核：本批缩短的是**判定窗**（`followSlopeOf` 的拟合窗），
 *      而锁牌用的是 `plate-lock.ts#alignedDOf` 自己的 `LOCK_ALIGN_SPAN_MS = 45s`
 *      （≈4 个车辆帧段），两者互不影响 ⇒ 「进一步缩判定窗会推高锁错率」不成立。
 *
 * ── 状态（★ 2026-11-05 已修，`3df2793`）──────────────────────────────────
 *   修法：`plate-lock.ts` 新增 `alignedDOf` —— 把 `v(t)` 内插到每个定位帧时刻、取
 *   `|median(u − v)|`，两车的 `d` 来自同一时刻同一用户位置；多候选只接受 `aligned` 口径
 *   （`raw` 一律判歧义，宁可不锁也不锁错）；`FOLLOW_AMBIG_M` 20 → **12**（按新 σ≈6m 重标定）。
 *   实测：后车 锁错 **21.8% → 0.0%**、锁对 12.4% → **87.3%**；前车 0% / 91.3%；
 *        车距 15m（低于 2σ 分辨率）锁错 0.5% 且以歧义为主；σ_veh=20m 时 2.3%。
 *   ⇒ 本节保留为**历史留痕**（记录一次误判过的根因），但**勿据此调 `FOLLOW_AMBIG_M`**：
 *     当前 12 是配 `aligned` 口径标定的，若换回 `raw` 口径须改回 20 以上。
 *
 * 影响面提醒：锁错车比延迟严重一个量级 —— 进度、报站、下车提醒会**全部跟着错车走**。
 */

/* ══════════ ㉚ 停站判据（2026-11-05 负责人裁决）的真实延迟 ══════════ */
/**
 * ── 为什么必须单独测这一组（be-plate 改了本文件 `walkActive: true` 之后）─────────
 *   新裁决「车**停靠上车站**的停站期 = 用户已上车 ⇒ 立即切 riding」上线后，
 *   本文件 ㉑~㉘ 测的那条路径（r2 / 跟车斜率）**不再是主路径**：
 *   它只在「漏掉停站帧」时才被用到。⇒ 若只报「位置判据 20s」，会严重高估用户实际等待。
 *   本组量的是新主路径：**车到站 → 判上**。
 *
 * ── 场景模型（与 `run()` 不同，别混用）──────────────────────────────────
 *   车：`t < arriveS` 在路上（`atStation=null`）→ `[arriveS, arriveS+dwellS)` 停靠上车站
 *       （`atStation=T100`）→ 之后离站继续走。
 *   用户：`userBoards=true` 时从 `arriveS` 起跟着车走；`false` 时全程留在站台。
 *   `walkActive=false` ⇒ 停站判据启用（生产：已到站、不在步行段）。
 *
 * ⚠️ 量化误差：本夹具只在**定位帧（1.5s）**上调用 `autoBoardOf`，而生产 `tryAuto`
 *   在**车辆帧到达后也会调用**（`useRideTracking.ts` 的调用点注释）。⇒ 本组测得的延迟
 *   最多比真机多 1.5s（一个定位帧）。宁可高估。
 */
interface StationOpts {
  /** 车到站时刻（秒，可为 0） */
  arriveS: number;
  /** 停靠时长（秒）—— 生产 dwell 中位 40s、p10 15s */
  dwellS: number;
  /** `false` = 不在步行段 ⇒ 停站判据启用（生产常态） */
  walkActive: boolean;
  /** 车离站后用户是否跟着走（`false` = 留守站台，用于量误判代价） */
  userBoards: boolean;
  vehPhaseS?: number;
  accNoiseM?: number;
  seed?: number;
  tEndS?: number;
}

function runStation(o: StationOpts): { tHit: number | null; evidence: string | null; plate: string | null } {
  const gauss = gaussOf(o.seed ?? 424242);
  const ph = o.vehPhaseS ?? 0;
  const tEnd = o.tEndS ?? o.arriveS + o.dwellS + 60;
  const leaveS = o.arriveS + o.dwellS;

  /** 车的位置 + 状态（停站期 `atStation` 指上车站） */
  const vehAt = (t: number): { m: number; atStation: { code: string } | null; moving: boolean } => {
    if (t < o.arriveS) return { m: 0, atStation: null, moving: true }; // 在路上（已在本段，未到站）
    if (t < leaveS) return { m: 0, atStation: { code: "T100" }, moving: false }; // 停靠上车站
    return { m: busM(t - leaveS), atStation: null, moving: true }; // 已离站
  };
  const userPos = (t: number): number => {
    if (!o.userBoards) return 0;
    return t < leaveS ? 0 : busM(t - leaveS); // 只在车离站后才随车走
  };

  const fixes: FixLite[] = [];
  for (let t = -36; t <= tEnd; t += GPS_GAP_MS / 1000) {
    const p = atM(userPos(t) + (o.accNoiseM ? gauss() * o.accNoiseM : 0));
    fixes.push({ lng: p.lng, lat: p.lat, accuracy: 10, ts: T0_MS + t * 1000 });
  }
  const vehFrames: VehFrame[] = [];
  for (let k = -4; k <= Math.ceil(tEnd / (VEH_GAP_MS / 1000)) + 1; k++) {
    const t = ph + k * (VEH_GAP_MS / 1000);
    const st = vehAt(t);
    const p = atM(st.m);
    const v: TrackVehicle = {
      plate: PLATE,
      lat: p.lat,
      lng: p.lng,
      status: st.moving ? "moving" : "stopping",
      interval: st.moving && t >= leaveS ? { from: { code: "T100" }, to: { code: "T101" } } : null,
      atStation: st.atStation,
    };
    vehFrames.push({ ts: T0_MS + t * 1000, vehicles: [v] });
  }

  let streak = 0;
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
      walkActive: o.walkActive,
    });
    streak = r.streak;
    if (r.hit && r.streak >= r.need) {
      return { tHit: (now - T0_MS) / 1000, evidence: r.evidence, plate: r.plate };
    }
  }
  return { tHit: null, evidence: null, plate: null };
}

console.log("\n[㉚ 停站判据延迟（新主路径）]");
{
  /** 扫「车到站落在轮询周期的哪一段」：这是新判据延迟的唯一主导变量 */
  const delays: number[] = [];
  let allAtStop = true;
  for (const phase of [0, 3, 6, 9]) {
    for (const arrive of [0, 2, 4, 6, 8, 10]) {
      const r = runStation({ arriveS: arrive, dwellS: 40, walkActive: false, userBoards: true, vehPhaseS: phase });
      if (r.tHit == null || r.evidence !== "atstop") allAtStop = false;
      if (r.tHit != null) delays.push(r.tHit - arrive);
    }
  }
  delays.sort((a, b) => a - b);
  const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
  console.log(
    `  dwell=40s（中位）· 24 组合：延迟 min ${delays[0]?.toFixed(1)} / 中位 ${delays[Math.floor(delays.length / 2)]?.toFixed(
      1,
    )} / mean ${mean.toFixed(1)} / max ${delays[delays.length - 1]?.toFixed(1)}s`,
  );
  ok(
    allAtStop && delays.length === 24,
    "★ dwell=40s 时 24 组合全部由**停站判据**判上（evidence=atstop），无一走位置判据",
    `命中=${delays.length}/24`,
  );
  ok(
    delays[delays.length - 1] <= VEH_GAP_MS / 1000 + GPS_GAP_MS / 1000,
    "★ 停站判据延迟 ≤ 一个轮询周期 + 一个定位帧（= 12 + 1.5s）—— 由 `atStation` 事件决定，与车速/位移无关",
    `max=${delays[delays.length - 1]?.toFixed(1)}s`,
  );
  ok(
    mean <= 7.5,
    "★ 停站判据平均延迟 ≤ 7.5s（理论均值 = 半个轮询周期 6s + 定位帧量化）",
    `mean=${mean.toFixed(1)}s`,
  );

  /** 与位置判据对照：㉓ 的 20s 现在只适用于「漏停站帧」的少数场景 */
  const posDelay = 19.5; // ㉓/㉔ 实测中位（walkActive=true 路径）
  ok(
    mean <= posDelay - 8,
    "★ 新主路径比位置判据快 ≥ 8s ⇒ 报「延迟 20s」会严重高估用户实际等待",
    `停站 mean=${mean.toFixed(1)}s vs 位置 ${posDelay}s`,
  );

  /** 短停（dwell < 一个轮询周期）+ 不利相位 ⇒ 必然漏掉停站帧，退回位置判据 */
  let missed = 0;
  for (const phase of [0, 3, 6, 9]) {
    for (const arrive of [0, 2, 4, 6, 8, 10]) {
      const r = runStation({ arriveS: arrive, dwellS: 8, walkActive: false, userBoards: true, vehPhaseS: phase, tEndS: 120 });
      if (r.evidence !== "atstop") missed++;
    }
  }
  ok(
    missed > 0,
    "★ dwell=8s（短于一个轮询周期）时存在漏帧组合 ⇒ 退回位置判据（与「~5% 场景走旧路径」的预期一致，非缺陷）",
    `漏停站帧=${missed}/24`,
  );

  /**
   * ⚠️ **这是裁决接受的代价，不是缺陷** —— 本断言只把行为钉住，防止有人当 bug 改掉：
   *   用户留守站台、车到站停靠 ⇒ 停站判据同样命中 ⇒ 进 riding（而用户其实没上车）。
   *   负责人裁决原文「车到了用户就会上车」，本组把它量出来备查。
   */
  const stayed = runStation({ arriveS: 4, dwellS: 40, walkActive: false, userBoards: false, vehPhaseS: 0 });
  ok(
    stayed.tHit != null && stayed.evidence === "atstop",
    "★ 已知代价：用户留守站台、车停靠本站 ⇒ 也会判上（裁决「车到了就会上车」接受的误判，勿当 bug 修）",
    `tHit=${stayed.tHit?.toFixed(1)} evidence=${stayed.evidence}`,
  );

  /** `walkActive=true`（仍在步行段）⇒ 停站判据必须被门挡住（防「车到站、人还在 300m 外」） */
  const walking = runStation({ arriveS: 4, dwellS: 40, walkActive: true, userBoards: false, vehPhaseS: 0, tEndS: 60 });
  ok(
    walking.evidence !== "atstop",
    "★ walkActive=true 时停站判据不触发（该门是必需的：`phase` 在步行段期间已是 boarding）",
    `evidence=${walking.evidence ?? "none"}`,
  );
}

/* ══════════ 汇总 ══════════ */
const total = pass + fail;
console.log(`\n结果：${fail === 0 ? "PASS" : "FAIL"} · ${pass}/${total} 通过${fail ? ` · ${fail} 失败` : ""}`);
if (fail) process.exitCode = 1;
