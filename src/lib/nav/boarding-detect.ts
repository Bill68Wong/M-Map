/**
 * 全自动上车判定 + 安全网（src/lib/nav/boarding-detect.ts，2026-09-25 · v2.14 · ★ v3.6.0 S3 重写）
 *
 * ── 职责（05-Spec §4.3 / 07 §1；★ v3.6.0 架构 §3.1）───────────────────
 *   把判据抽成**纯函数**（可单测、可对拍），供 `useRideTracking` 调用：
 *     · `r1Of`       —— 车辆侧（**★ v3.6.0 起不再作触发器**，仅用于候选排序/文案）；
 *     · `auxOf`      —— 车辆辅助信号（只降门槛，**不得单独触发**）；
 *     · `r2Of`       —— GPS 侧：45s 窗口内投影 / 沿线**带符号**位移 / 速度；
 *     · `departedCandidatesOf` / `pickLockPlateOf`（`plate-lock.ts`）—— ★ I-3 锁牌依据；
 *     · `followSlopeOf` / `followFramesOf`（`follow-slope.ts` / `follow-frames.ts`）—— ★ I-3 跟车斜率；
 *     · `autoBoardOf`—— 组合判定（★ v3.6.0 **定位主导**；★ I-3 起并入「跟车斜率」）；
 *     · `detectPausedOf` —— 判定是否已「事实上停止」（AC-25a 的 `data-board-detect`）；
 *     · `anomalyOf`  —— 安全网异常检出（A1 疑似未上车 / A2 疑似提前下车）。
 *
 * ── ★ I-3（2026-11-04）为什么必须加「跟车斜率」（用户投诉：正常上车也匹配不到车牌）
 *   旧判定只有一个证据源 `r2Of`，量的是「回看窗口内**用户自己**的平均位移速度」。
 *   用户上车后常常**静止**（等关门 / 挤门口 / 塞车）⇒ 位移不增而窗口时长照增 ⇒
 *   平均速度被稀释到速度门以下 ⇒ 判定迟迟不过；等它过了，锁牌窗口（只认 `aux.strong`，
 *   有效约一个站间）早已关闭 ⇒ 本段再无锁牌机会。
 *   ⇒ 新增 `followSlope`（`lib/nav/follow-slope.ts`）：量「用户与参照车的**相对距离**斜率」，
 *     分母是车自己的位移 ⇒ 用户静止不会稀释；并把锁牌放宽为三条件并集（见 `departedCandidatesOf`）
 *     ⇒ **判定成立的那一帧，锁牌条件必然同时成立**（斜率判据的前提 ⊆ 并集）。
 *     `r2Of` 原样保留为并存证据源（避免回归既有行为）。
 *
 * ── ★ v3.6.0 为什么改成「定位主导」（用户口径）───────────────────────
 *   旧版 R1（车辆停靠/刚离上车站）是**触发器**：第一辆车到站就判「用户已上车」，
 *   而用户可能还在路上 —— 实测高频误判。新版：R1 降级为**辅助**（只把位移门 ×0.6、
 *   所需连续帧 3→2），单独出现**绝不**触发；真正的判据必须是「用户自己沿线在动」。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   · **client-safe 纯函数**：不 import `pg` / server-only；坐标一律 GCJ-02；
 *   · **宁可晚判、不误判**：保守阈值 + 冷却 + 单次会话单次自动；
 *   · 一切「对不上」都如实返回，**绝不猜测**（沿用项目铁律）；
 *   · 阈值/窗口/冷却的数值**只在本文件定义**（架构 §3.1 参数锁定表），组件只读不改。
 */
import { cumDistM, distM, nearestOnPath, type LL } from "./route-overview";
import { mainOf, rankBoardingVehicles, type TrackVehicle } from "./track";
import { followFramesOf, type VehFrame } from "./follow-frames";
import { followSlopeOf, type FollowSlope } from "./follow-slope";
import { departedCandidatesOf, pickLockPlateOf } from "./plate-lock";

/** ★ I-3：本腿允许的**自动判定次数**（初值）。用尽后仅剩手动/纠错入口（见 I4） */
export const AUTO_TRIES_PER_LEG = 2;

/** 自动上车总开关（Spec R-1：关掉即回退 v2.13「我已上车」手动） */
export const AUTO_BOARDING_ENABLED = true;

/** 用户定位一帧（GCJ-02；已由 wgs84ToGcj02 转换） */
export interface FixLite {
  lng: number;
  lat: number;
  accuracy: number;
  ts: number;
}

/* ══════════ 参数（★ v3.6.0 架构 §3.1 判定参数锁定表 = 唯一来源）══════════ */
/** GPS 采样窗口 */
export const R2_WINDOW_MS = 45_000;
/** 巴士投影容差基准（与 `accuracy × R2_ACC_TOL_FACTOR` 取大） */
export const R2_TOL_M = 80;
/** 轻轨收紧档：轨道固定，容差可更小 */
export const R2_LRT_TOL_M = 60;
/** `tol = max(基准容差, accuracy × 1.5)` —— 手机在车内定位精度差时的自适应 */
export const R2_ACC_TOL_FACTOR = 1.5;
/** 精度门（米）：单帧 accuracy 超此值 ⇒ 该帧不可信，不参与判定 */
export const R2_FIX_MAX_ACC_M = 150;
/** 沿线位移下限（米）—— 防 GPS 慢速漂移 */
export const R2_DISPLACE_MIN_M = 60;
/**
 * 巴士车速下限：**8 km/h 是步行与车速的分界**。
 *
 * ⚠️ 不要改回 5.5：位移门是 `max(R2_DISPLACE_MIN_M, (R2_SPEED_MIN_KMH_FLEX/3.6) × dt)`——
 *   45s 满窗时 `5.5/3.6×45 = 68.75m`，与「5.5 km/h × 45s」是同一约束的两种写法 ⇒
 *   位移门与速度门冗余，**速度门成了唯一实际生效的门**。
 *   而 5.5 km/h 低于正常快走速度（6~7 km/h）⇒ 乘客步行沿线走向车站会被判成「已上车」
 *   （即用户投诉的那类误判）。取 8 才能把「步行」与「车速」真正分开。
 *   真实乘车（12 km/h 级）不受影响，无延迟。
 */
export const R2_SPEED_MIN_KMH_FLEX = 8;
/** 轻轨车速下限（起速快，可抬高） */
export const R2_LRT_SPEED_MIN_KMH = 12;
/** 车速上限（超此值视为投影漂移，不是真随车移动） */
export const R2_SPEED_MAX_KMH = 80;
/** 有车辆佐证时所需连续命中帧数 */
export const R2_STREAK_WITH_VEHICLE = 2;
/** 纯定位判定所需连续命中帧数（也是单次判定的最少可信帧数） */
export const R2_STREAK_ALONE = 3;
/** 有车辆佐证时位移门的缩放系数（<1 = 降门槛，**不改** P1 邻线门与 P3 速度门） */
export const R1_ACCEL_DISPLACE_FACTOR = 0.6;
/** 无新帧多久视为「判定已暂停」（与 AC-25a 一致） */
export const GPS_PAUSE_MS = 60_000;
/**
 * 启动宽限（毫秒）：点「开始导航」后的这段时间内**不判 paused**。
 * 为什么需要：刚进导航时 GPS 缓冲还是空的，`detectPausedOf([], now)` 会立即返回 `true`，
 * 界面在 1~3s 内先闪一句「定位不可用 · 判定已暂停」再转正常 —— 属于把"还没拿到第一帧"
 * 误报成"定位不可用"。宽限期让第一帧有机会到达。
 */
export const BOARDING_START_GRACE_MS = 5_000;

/** 状态切换后的冷却（毫秒）—— 防抖 + 防死循环 */
export const SWITCH_COOLDOWN_MS = 20_000;
/** 安全网：连续确认次数与最小间隔 */
export const ANOMALY_CONFIRM = 2;
export const ANOMALY_MIN_GAP_MS = 45_000;

/* ── 以下三个为 v3.5.x 遗留常量：仅为向后兼容保留，★ v3.6.0 判定已不再读 ── */
/** @deprecated v3.6.0：位移门改由 `adaptiveOpts` + `R1_ACCEL_DISPLACE_FACTOR` 计算 */
export const R2_DISPLACE_M = 150;
/** @deprecated v3.6.0：巴士速度下限统一用 `R2_SPEED_MIN_KMH_FLEX` */
export const R2_SPEED_MIN_KMH = 8;
/** @deprecated v3.6.0：判据改为「连续命中帧数」（`R2_STREAK_*`），单帧样本数恒为 `R2_STREAK_ALONE` */
export const R2_MIN_SAMPLES_WITH_R1 = 2;
/** 单次判定所需最少可信帧（与 `R2_STREAK_ALONE` 同值，保留旧名供 R2Opts 缺省） */
export const R2_MIN_SAMPLES_ALONE = 3;


/* ══════════════════════════ R1（车辆侧） ══════════════════════════ */

export interface R1Result {
  /** strong = 车刚从本上车站开走；weak = 车正停靠本上车站；none = 不触发 */
  kind: "strong" | "weak" | "none";
  plate: string | null;
}

/**
 * R1 判定（07 §1.1）：只用 `rankBoardingVehicles` 的分档 0/1，不用距离项。
 * @param list     本帧车辆（`status ∈ {moving,stopping,terminal}` 的过滤已由 rank 完成）
 * @param boardMain 本段上车站主码
 * @param boardPos  上车站坐标（可空）
 */
export function r1Of(
  list: TrackVehicle[],
  boardMain: string,
  boardPos?: { lng: number; lat: number } | null,
): R1Result {
  const board = mainOf(boardMain);
  if (!board) return { kind: "none", plate: null };
  const ranked = rankBoardingVehicles(list, board, boardPos);

  const strongs = ranked.filter(
    (v) => v.interval?.from?.code && mainOf(v.interval.from.code) === board,
  );
  const weaks = ranked.filter(
    (v) => v.atStation?.code && mainOf(v.atStation.code) === board && v.status === "stopping",
  );

  if (strongs.length > 0) {
    // 多车歧义：strong 与 weak 车牌不同 ⇒ 不触发
    if (weaks.length > 0 && strongs[0].plate !== weaks[0].plate) {
      return { kind: "none", plate: null };
    }
    if (strongs.length === 1) return { kind: "strong", plate: strongs[0].plate };
    // strong 多辆：取排序第 1，且必须在 strong 集合内；否则不唯一 ⇒ 不触发
    const top = ranked[0];
    if (top && strongs.some((s) => s.plate === top.plate)) {
      return { kind: "strong", plate: top.plate };
    }
    return { kind: "none", plate: null };
  }
  if (weaks.length > 0) return { kind: "weak", plate: weaks[0].plate };
  return { kind: "none", plate: null };
}

/* ══════════════════════════ R2（GPS 侧） ══════════════════════════ */

export interface R2Opts {
  tolM?: number;
  displaceM?: number;
  speedMinKmh?: number;
  speedMaxKmh?: number;
  minSamples?: number;
  windowMs?: number;
}

/**
 * R2 判定（07 §1.2）：45s 窗口内
 *   · 每个采样点到 `colored` 投影 ≤ tolM；
 *   · 沿线位移（最早→最新投影里程差）≥ displaceM；
 *   · 平均速度 ∈ [speedMin, speedMax]；
 *   · 采样数 ≥ minSamples。
 */
export function r2Of(fixes: FixLite[], colored: LL[], opts: R2Opts = {}): boolean {
  if (colored.length < 2) return false;
  const tol = opts.tolM ?? R2_TOL_M;
  const displace = opts.displaceM ?? R2_DISPLACE_M;
  const vMin = opts.speedMinKmh ?? R2_SPEED_MIN_KMH;
  const vMax = opts.speedMaxKmh ?? R2_SPEED_MAX_KMH;
  const minSamples = opts.minSamples ?? R2_MIN_SAMPLES_ALONE;
  const windowMs = opts.windowMs ?? R2_WINDOW_MS;

  const latest = fixes[fixes.length - 1];
  if (!latest) return false;
  const win = fixes.filter((f) => latest.ts - f.ts <= windowMs && f.ts <= latest.ts);
  if (win.length < minSamples) return false;

  const cum = cumDistM(colored);
  const projs = win.map((f) => nearestOnPath(colored, f));
  if (projs.some((p) => p.distM > tol)) return false;

  const i0 = projs[0].idx;
  const i1 = projs[projs.length - 1].idx;
  /**
   * ★ I-3（2026-11-04）：**去掉 `Math.abs`** —— 原式 `|cum[i1] − cum[i0]|` 把方向信息抹掉了：
   *   人在线路上**反向**移动（走回头路 / 折返同路段 / 投影跳到环线的另一遍）也算「正向位移」，
   *   于是「反向 80m + 速度 20km/h」可以满足「沿线位移 ≥60m 且速度 ∈[8,80]」⇒ 误判已上车。
   *   本项目 `colored` 是「本段乘车方向」的折线，里程**递增 = 沿乘车方向前移**是唯一合法方向。
   *   ⇒ 改为带符号差值 + 单调前移校验：位移必须为正，否则该窗口不成立（**不取绝对值**、
   *     也不 `clamp` 到 0 —— 夹紧会让「反向」悄悄退化成「位移 0」再被位移门拦下，
   *     虽然结果相同，但诊断上再也看不出方向错了）。
   */
  const disp = cum[i1] - cum[i0];
  if (!(disp >= 0)) return false;
  if (disp < displace) return false;

  const dtSec = (win[win.length - 1].ts - win[0].ts) / 1000;
  if (dtSec <= 0) return false;
  const kmh = (disp / dtSec) * 3.6;
  /**
   * 下限用**严格 `>`**（不是 `>=`）：`R2_SPEED_MIN_KMH_FLEX` = 8 是「步行 / 车速」的**契约分界**，
   * 落在分界值上应归**步行**一侧 —— 这是语义选择，不是"消噪"手段。
   *
   * ⚠️ **别误以为换成 `>` 就消除了边界模糊**（架构已双向实测证伪）：
   *   6 种几何起点偏移 × 速度扫描（45s 满窗）结果，`>=` 与 `>` **完全相同** ——
   *   5.0~7.5 km/h 都是 0/6 命中、**8.0 都是 1/6**、8.5 都是 5/6、9.0~12.0 都是 6/6。
   *   即 8.0 km/h 的偶发性两种运算符都有。
   *
   * 模糊带的**真因是顶点量化**：`r2Of` 的沿线位移取「最近顶点里程差」，
   *   · 分辨率 = 顶点间距 ÷ 窗口时长（10m 顶点 ÷ 45s ≈ **0.8 km/h** 一档）；
   *   · 误差**不对称** —— 100m 的真实位移可能被量成 110m ⇒ 测得 8.8 km/h ⇒ 命中。
   *   ⇒ 边界附近（约 8~8.5 km/h）本身就是灰带，不要假定它是精确的；
   *     要收紧只能加密 `route_shapes` 顶点，改运算符无效。
   *
   * 上限仍用 `<=`（80 km/h 是"漂移"判据，取等无语义差异）。
   */
  return kmh > vMin && kmh <= vMax;
}

/* ══════════════════════════ 车辆辅助信号（★ v3.6.0 新增） ══════════════════════════ */

/**
 * 车辆辅助信号 —— **只用于降低门槛，本身绝不触发上车判定**。
 *
 * 为什么单独抽：`r1Of` 的 `strong`（车刚从本站开走）在旧版是**触发器**，导致
 * 「第一辆车到站 ⇒ 判定用户已上车」的高频误判（用户可能还在路上）。
 * v3.6.0 起它只做两件事：位移门 ×`R1_ACCEL_DISPLACE_FACTOR`、所需连续帧 3→2。
 * 判据内核仍是「用户自己的定位沿线在动」（`r2Of`）。
 *
 * @param list      本帧车辆
 * @param boardMain 本段上车站主码
 * @param boardPos  上车站坐标（可空；用于多车歧义时的排序）
 */
export interface AuxSignal {
  /** A1：存在车刚从本站开走（`interval.from` == 上车站）—— 最强佐证 */
  strong: boolean;
  /** A2：存在车停靠/挂靠本站（`status === "stopping"`） */
  weak: boolean;
  /** 佐证车牌（有歧义时为 null） */
  plate: string | null;
}

export function auxOf(
  list: TrackVehicle[],
  boardMain: string,
  boardPos?: { lng: number; lat: number } | null,
): AuxSignal {
  const r = r1Of(list, boardMain, boardPos);
  return { strong: r.kind === "strong", weak: r.kind === "weak", plate: r.plate };
}

/* ══════════════════════════ 组合判定 ══════════════════════════ */

export interface AutoBoardInput {
  legKind: "bus" | "lrt";
  /** 几何不可用（colored < 2 或 degraded）⇒ **一律不自动判定**（v3.6.0 比旧版更严） */
  legDegraded: boolean;
  colored: LL[];
  boardMain: string;
  boardPos?: { lng: number; lat: number } | null;
  /**
   * ★ I-3（I2）：本段站序主码（下标 0 = 上车站）。缺省 ⇒ 锁牌的 L-b 判据不可用
   * （只剩 L-a / L-c），**不影响** r2 判据。
   */
  stopMains?: string[] | null;
  vehicles: TrackVehicle[];
  /**
   * ★ I-3（I1）：最近若干帧车辆快照（升序）。缺省 ⇒ 跟车斜率判据不可用（如实不判）。
   * 由调用方在每次车辆帧到达时 `push({ ts, vehicles })`。
   */
  vehFrames?: VehFrame[] | null;
  fixes: FixLite[];
  /** 上次切换时刻（冷却用） */
  lastSwitchTs: number;
  nowMs: number;
  /**
   * ★ I-3（I4）：本腿**剩余**自动判定次数（初值 `AUTO_TRIES_PER_LEG = 2`）；
   * 每次自动上车消耗 1 次，用户点「我没上车」**不消耗**（消耗的是那次误判）。
   * 次数用尽 ⇒ 不再自动判，只剩手动 / 纠错入口（如实停手，不假装还能自动）。
   * 缺省 = 未消耗过。
   */
  autoLeft?: number;
  /** 调用方维护的连续命中帧数 */
  streak?: number;
}

/** 本帧**最强可用证据**（`station` = 只有车辆侧「已离站」证据，未构成命中） */
export type BoardEvidence = "slope" | "r2" | "station" | "none";

export interface AutoBoardResult {
  hit: boolean;
  plate: string | null;
  source: "vehicle" | "gps";
  /** `gps` = 纯定位；`gps+vehicle` = 定位命中且有车辆佐证（**不代表车触发**） */
  reason: "gps" | "gps+vehicle" | "none";
  /** 更新后的连续命中帧数（`hit` 时累加，未命中归零） */
  streak: number;
  /**
   * ★ v3.6.0：本次判定要求的连续帧数。
   *   调用方**唯一**的切换条件 = `hit && streak >= need`（不再按 `reason` 特判）。
   */
  need: number;
  /**
   * ★ I-3：本帧命中的是哪条证据（观测钩子 `data-board-evidence` 的值源）。
   * ⚠️ 非命中帧也会给值（此时含义是「最强可用证据」，用于区分
   * 「压根没有机会」(`none`/`station`) 与「有机会但没判上」）。
   */
  evidence: BoardEvidence;
  /** ★ I-3：本帧相对距离斜率（m/s；`null` = 无可用样本）—— 观测钩子 `data-follow-slope` */
  followSlope: number | null;
  /** ★ I-3：斜率判据未成立的原因（诊断；`ok` 时为 `ok`） */
  followWhy: FollowSlope["why"];
}

/** 未命中基线（`streak` 由调用方覆盖） */
const NO_HIT: AutoBoardResult = {
  hit: false,
  plate: null,
  source: "gps",
  reason: "none",
  streak: 0,
  need: R2_STREAK_ALONE,
  evidence: "none",
  followSlope: null,
  followWhy: "no-frame",
};

/** 取「可信帧」（accuracy ≤ 精度门；缺失按 0 视为可信） */
function trustedFixes(fixes: FixLite[]): FixLite[] {
  return fixes.filter((f) => !(Number.isFinite(f.accuracy) && f.accuracy > R2_FIX_MAX_ACC_M));
}

/** 由 GPS 采样自适应算 R2 阈值（tol 随 accuracy、displace 随 dt 缩放）—— 两项恒有值 */
function adaptiveOpts(fixes: FixLite[], baseTolM: number): { tolM: number; displaceM: number } {
  const latest = fixes[fixes.length - 1] ?? null;
  const acc = latest && Number.isFinite(latest.accuracy) ? latest.accuracy : 0;
  const tol = Math.max(baseTolM, acc * R2_ACC_TOL_FACTOR);
  const win = latest ? fixes.filter((f) => latest.ts - f.ts <= R2_WINDOW_MS) : [];
  const dtSec = win.length >= 2 ? (win[win.length - 1].ts - win[0].ts) / 1000 : 0;
  const displace = Math.max(R2_DISPLACE_MIN_M, (R2_SPEED_MIN_KMH_FLEX / 3.6) * dtSec);
  return { tolM: tol, displaceM: displace };
}

/** 空斜率（轻轨 / 几何不可用） */
const NO_FOLLOW: FollowSlope = {
  slope: null,
  n: 0,
  ok: false,
  dNow: null,
  alongM: null,
  vehMps: null,
  spanMs: 0,
  plate: null,
  why: "no-frame",
};

/**
 * 组合判定 —— ★ v3.6.0 **定位主导** + ★ I-3 **相对距离斜率**
 *
 * ```
 * ① 硬门（任一不满足 ⇒ 不判）
 *    G1 几何可用   G2 有 ≥3 帧可信 GPS   G3 剩余次数 > 0 且冷却已过
 * ② 车辆侧证据（I-3 并集；属**测量**，冷却中也算 —— 观测钩子要能看到）
 *    L-a 车刚从本站开走 · L-b 车已在本段站序内前移 · L-c 车停靠在别的站
 *    ⇒ 唯一且不歧义的候选 = **可锁车牌**（`departedCandidatesOf` / `pickLockPlateOf`）
 * ③ 两个判定源（任一成立即 hit）
 *    r2  ：邻线投影 ≤ tol ∧ **带符号**沿线位移 ≥ 门槛 ∧ 平均速度 ∈ (8, 80] km/h
 *    slope：`followSlopeOf` 的 G-a…G-f（相对距离不拉开；用户静止**不稀释**）
 * ④ 车辆辅助（只降门槛，不得单独触发）：A1/A2 ⇒ 位移门 ×0.6、所需帧数 3→2
 * ⑤ 出结论：hit = r2 ∨ slope；牌取 ② 的结果（**与判定同帧**，无任何补牌/记忆）
 * ```
 */
export function autoBoardOf(input: AutoBoardInput): AutoBoardResult {
  const prevStreak = Math.max(0, input.streak ?? 0);

  /* ① 硬门 G1：几何缺失 ⇒ 一律不自动判（旧版巴士会退化成 R1-only，那是误判来源） */
  const geomOk = input.colored.length >= 2 && !input.legDegraded;
  if (!geomOk) return { ...NO_HIT, streak: 0 };

  const fixes = trustedFixes(input.fixes);
  const latest = fixes[fixes.length - 1] ?? null;

  /* ② 车辆侧证据 + 跟车斜率（纯测量，放在硬门之前：冷却 / 次数用尽时也要写进观测钩子） */
  const dep =
    input.legKind === "bus"
      ? departedCandidatesOf({
          vehicles: input.vehicles,
          boardMain: input.boardMain,
          stopMains: input.stopMains,
          colored: input.colored,
          fix: latest ? { lng: latest.lng, lat: latest.lat } : null,
          tolM: Math.max(
            R2_TOL_M,
            (latest && Number.isFinite(latest.accuracy) ? latest.accuracy : 0) * R2_ACC_TOL_FACTOR,
          ),
        })
      : [];
  const lock = pickLockPlateOf(dep);
  const follow =
    input.legKind === "bus"
      ? followSlopeOf(
          followFramesOf({
            fixes,
            vehFrames: input.vehFrames ?? [],
            colored: input.colored,
            plate: lock.plate,
          }),
        )
      : NO_FOLLOW;
  /** 未命中：带上本帧**最强可用证据**（`data-board-evidence` / `data-follow-slope` 的值源） */
  const noHit = (): AutoBoardResult => ({
    ...NO_HIT,
    streak: 0,
    evidence: follow.ok ? "slope" : dep.length ? "station" : "none",
    followSlope: follow.slope,
    followWhy: follow.why,
  });

  /* ③ 硬门 G3：总开关 / 本腿剩余次数 / 冷却 */
  if (!AUTO_BOARDING_ENABLED) return noHit();
  const autoLeft = input.autoLeft ?? AUTO_TRIES_PER_LEG;
  if (!(autoLeft > 0)) return noHit();
  if (input.nowMs - input.lastSwitchTs < SWITCH_COOLDOWN_MS) return noHit();

  /* ③ 硬门 G2：定位主导 ⇒ 没有足够可信帧就不判 */
  if (fixes.length < R2_STREAK_ALONE) return noHit();

  /* ── 轻轨：无逐车数据 ⇒ 仅 R2 收紧档（投影 ≤60m、速度 ≥12、≥3 帧、≥3 连续帧）── */
  if (input.legKind === "lrt") {
    const opts = adaptiveOpts(fixes, R2_LRT_TOL_M);
    const hit = r2Of(fixes, input.colored, {
      tolM: opts.tolM,
      displaceM: opts.displaceM,
      speedMinKmh: R2_LRT_SPEED_MIN_KMH,
      minSamples: R2_STREAK_ALONE,
    });
    if (!hit) return noHit();
    return {
      hit: true,
      plate: null,
      source: "gps",
      reason: "gps",
      streak: prevStreak + 1,
      need: R2_STREAK_ALONE,
      evidence: "r2",
      followSlope: null,
      followWhy: follow.why,
    };
  }

  /* ── 巴士：定位主导 + 车辆辅助降门槛 + 跟车斜率 ── */
  const aux = auxOf(input.vehicles, input.boardMain, input.boardPos);
  const assisted = aux.strong || aux.weak;
  const opts = adaptiveOpts(fixes, R2_TOL_M);
  const displaceM = opts.displaceM * (assisted ? R1_ACCEL_DISPLACE_FACTOR : 1);
  const need = assisted ? R2_STREAK_WITH_VEHICLE : R2_STREAK_ALONE;

  const hitR2 = r2Of(fixes, input.colored, {
    tolM: opts.tolM,
    displaceM,
    speedMinKmh: R2_SPEED_MIN_KMH_FLEX,
    minSamples: R2_STREAK_ALONE,
  });
  /**
   * ★ I1：斜率判据成立 ⇒ **车牌必然非空**（`followFramesOf` 没有 `plate` 就产不出样本，
   *   `ok` 也就恒为 false）⇒ 「判定成功那一帧必然能锁牌」是**结构性**保证，不靠时序运气。
   */
  const hitFollow = follow.ok && lock.plate != null;
  if (!hitR2 && !hitFollow) return noHit();

  return {
    hit: true,
    // ★ I2：锁牌口径 = 三条件并集（不再是「只认刚离站」的一个站间窗口）
    plate: lock.plate,
    source: lock.plate ? "vehicle" : "gps",
    reason: lock.plate ? "gps+vehicle" : "gps",
    streak: prevStreak + 1,
    /** 斜率判据自带「≥5 帧 / ≥10s 窗」+ 车已离站证据 ⇒ 不再额外要求 3 连帧 */
    need: hitFollow ? R2_STREAK_WITH_VEHICLE : need,
    evidence: hitFollow ? "slope" : "r2",
    followSlope: follow.slope,
    followWhy: follow.why,
  };
}

/* ══════════════════════════ 换乘后下一段的冷却起点 ══════════════════════════ */

/**
 * 换乘后**下一段**的冷却起点策略（纯函数，供 `useRideTracking.doAlight` 调用）。
 *
 * ── 为什么需要这个判断 ────────────────────────────────────────────────
 *   默认应「归零」（`"zero"`）：下一段是全新行程，用户刚下车、人就站在换乘站台，
 *   上车判定应**立刻可用**；保留 20s 冷却 = 让同站换乘用户干等 20 秒，属把「防抖」
 *   错误地推广成「惩罚」。
 *
 *   **唯一例外 = GPS 源的自动下车**（返回 `"now"`，保留冷却）：
 *   这是唯一「可能判错、且判错后没有车辆信号能纠正」的路径 ——
 *   `autoAlightOf` 的 gps 分支靠「里程越站 30m」判断，误差直接来自投影；
 *   一旦误判提前下车，新段会立刻在错误的站台重新开始判定，且无车牌可核对。
 *   ⇒ 只对这条路径防抖；手动下车（用户本人操作）、车辆源自动下车（有车牌可核）都归零。
 *
 * ⚠️ 本判断已被两人各推演过一次 —— 靠注释守不住，`test-boarding-detect.ts` 的
 *    ⑭ 组用 4 条断言锁住四种组合，改动请同步改断言。
 */
export function nextLegCooldownOf(o: {
  /** 是否由自动判定触发的下车（`false` = 用户手动点「我已下车」） */
  auto: boolean;
  /** 本段进度来源：`gps` = 无车牌、纯投影驱动 */
  progressSource: "gps" | "vehicle";
}): "now" | "zero" {
  return o.auto && o.progressSource === "gps" ? "now" : "zero";
}

/* ══════════════════════════ 判定是否已暂停（AC-25a） ══════════════════════════ */
/**
 * 自动判定是否**事实上已停止**（纯函数，便于对拍）。
 *
 * 为什么需要：GPS 被拒权或长时间无帧时，系统已不再判定，但界面若仍写「正在检测车辆」，
 * 用户会以为「车还没来」，实际是「我不看了」—— 这正是 AC-25a 要禁的
 * 「把未判定渲染成正在判定」。
 *
 * ⚠️ 本函数**只管自动判定与文案**；地图蓝点仍走自己的冻结逻辑，两者不得合并成一个开关。
 *
 * @param startedAtMs 进入候车态的时刻（可选）。给了就在 `BOARDING_START_GRACE_MS` 内恒返回
 *   `false` —— 避免刚点「开始导航」、第一帧还没到时闪一句"定位不可用"。
 */
export function detectPausedOf(fixes: FixLite[], nowMs: number, startedAtMs?: number | null): boolean {
  // 启动宽限：还没拿到第一帧不等于定位不可用
  if (startedAtMs != null && Number.isFinite(startedAtMs) && nowMs - startedAtMs < BOARDING_START_GRACE_MS) {
    return false;
  }
  const latest = fixes[fixes.length - 1];
  if (!latest) return true; // 一次定位都没拿到
  if (nowMs - latest.ts > GPS_PAUSE_MS) return true; // 60s 无新帧 = 停了
  // 连续 2 帧精度超门限 ⇒ 视为不可用（与 trustedFixes 同门限）
  const tail = fixes.slice(-2);
  return tail.length === 2 && tail.every((f) => Number.isFinite(f.accuracy) && f.accuracy > R2_FIX_MAX_ACC_M);
}

/* ══════════════════════════ 安全网 ══════════════════════════ */

export type Anomaly = "none" | "not_boarded" | "alighted";

/** 近 `windowMs` 内 GPS 原始平均速度（km/h）—— 样本不足 ⇒ null */
export function gpsSpeedKmh(fixes: FixLite[], windowMs: number): number | null {
  const latest = fixes[fixes.length - 1];
  if (!latest) return null;
  const win = fixes.filter((f) => latest.ts - f.ts <= windowMs);
  if (win.length < 2) return null;
  const a = win[0];
  const b = win[win.length - 1];
  const dtSec = (b.ts - a.ts) / 1000;
  if (dtSec <= 0) return null;
  const m = distM([a.lng, a.lat], [b.lng, b.lat]);
  return (m / dtSec) * 3.6;
}

export interface AnomalyInput {
  /** 本次 riding 是否由自动判定进入（非手动） */
  autoSwitched: boolean;
  /** 进度来源：vehicle = 有车牌；gps = GPS 驱动 */
  progressSource: "vehicle" | "gps";
  fixes: FixLite[];
  /** 最新定位到 leg.colored 的投影距离（无几何 ⇒ null） */
  projDistM: number | null;
  /** 车辆已推进 ≥1 站（GPS 驱动时为「投影里程持续增长」） */
  advanced: boolean;
}

/**
 * 异常检出（**瞬时**条件；连续 2 次 + 间隔 ≥45s 的确认在调用方累计）。
 *   A1 疑似未上车：自动进入 + 近 60s 静止(<2km/h) + 离线 >250m + 已推进。
 *   A2 疑似提前下车：riding + 近 45s 静止(<3km/h) + 离线 >250m + 已推进。
 */
export function anomalyOf(input: AnomalyInput): Anomaly {
  const farOff = input.projDistM != null && input.projDistM > 250;
  if (!farOff) return "none";

  const v60 = gpsSpeedKmh(input.fixes, 60_000);
  if (input.autoSwitched && v60 != null && v60 < 2 && input.advanced) return "not_boarded";

  const v45 = gpsSpeedKmh(input.fixes, 45_000);
  if (v45 != null && v45 < 3 && input.advanced) return "alighted";
  return "none";
}
