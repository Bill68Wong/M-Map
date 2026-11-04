/**
 * 锁牌：车「已不在上车站」的证据并集（src/lib/nav/plate-lock.ts，2026-11-04 新增 · P0 I-3 / I2）
 *
 * ── 为什么需要独立成模块 ────────────────────────────────────────────────
 *   `boarding-detect.ts` 的判定（要不要切 riding）与**锁哪辆车**是两件事：
 *     · 判定错了 ⇒ 用户还没上车就被切进「乘车中」；
 *     · 锁错了   ⇒ 进度、报站、到站提醒全部跟着错车走，且比漏判更难发现。
 *   两者共用同一帧数据（所以必须同帧完成），但判据与失效模式完全不同 ⇒ 分包。
 *
 * ── 为什么不能再只认「车刚离开本站」（旧 `aux.strong`）────────────────────
 *   `interval` 只在 `status="moving"` 时由服务端给出 ⇒ **车一到下一站，`interval.from` 就变**
 *   ⇒ `strong` 的有效期 ≈ 一个站间（约 45s）。而判定窗口本身要 10~60s ⇒ 等判定通过时，
 *   锁牌窗口往往已经关闭；进 `riding` 后 `tryAuto` 立即返回 ⇒ 本段再无锁牌机会
 *   （这正是「正常上车也匹配不到车牌」的直接成因）。
 *
 *   ★ 历史教训（v3.6.0，`69d3cae^`）：当时为消「同站台来车即误判」，把「车停靠本站」从
 *     **触发器**降级，**连带把它的锁牌权一起删了**。消误判只需删触发、不必删锁牌 ——
 *     本模块把锁牌权按「证据来源」重新分配，而不是按「能不能触发」。
 *
 * ── 三条并集（覆盖面 = 整段乘车 3~40 分钟）──────────────────────────────
 *   L-a `interval.from` == 上车站主码 —— 刚离站（沿用旧 `strong`）
 *   L-b `progressOf(stopMains).passedIdx ≥ 0` —— 车已在本段站序内**驶过至少一站**
 *       （整段乘车都成立；需调用方给 `stopMains`，缺省则本条不可用）
 *   L-c `atStation` 存在且**不是**上车站 —— 车停在别的站（中途停靠也成立）
 *
 * ⚠️ A2（车正停靠**本站**）仍然**不锁牌**：三条都不成立（L-c 要求 ≠ 上车站），
 *    与改前语义一致 —— 站里可能停着好几辆，锁错会让进度跟错站。
 *
 * ⚠️ 这不是「记忆窗口 / TTL 缓存」：全部基于**本帧**数据，没有任何跨帧残留。
 *    用户已明确否决「事后补牌」式补偿，本模块只做同帧判定。
 */
import { cumDistM, type LL } from "./route-overview";
import { mainOf, progressOf, type TrackVehicle } from "./track";
import { alongMileM, followFramesOf, vehicleMileOnPath, type VehFrame } from "./follow-frames";
import { FOLLOW_AMBIG_M, FOLLOW_MAX_D_M, medianOf } from "./follow-slope";

/** 「车已不在上车站」的证据来源（三条件并集；任一成立即可） */
export type DepartVia = "L-a" | "L-b" | "L-c";

/** 候选车的距离口径：`aligned` = 时间对齐中位（可比较）；`raw` = 单帧错位（**不可**用于比较） */
export type DistKind = "aligned" | "raw";

export interface DepartCand {
  plate: string;
  /**
   * 用户与该车的沿线里程差（米）—— **择优比较用这个值**。
   * `aligned`：把 `v(t)` 内插到每个定位帧时刻后取 `|median(u − v)|`（见 `alignedDOf`）。
   * `raw`（历史不足时的回退）：`|最新帧 u − 最近车辆帧 v|`，**含 0~12s 时间错位**。
   */
  d: number | null;
  via: DepartVia[];
  /** `d` 的口径；缺省按 `aligned` 处理（兼容既有调用点与测试字面量） */
  dKind?: DistKind;
  /** 参与对齐的样本帧数（`raw` 时无意义） */
  nAligned?: number;
}

/** 择优用的对齐窗（ms）= 45s ≈ 4 个车辆帧周期 ⇒ 车辆位置噪声可被中位压掉一层 */
export const LOCK_ALIGN_SPAN_MS = 45_000;
/**
 * 对齐估计量的最少样本帧数 = 5。
 * 依据：`median` 在 n<5 时崩溃点过低（1 个离群帧即可带动结论）；5 帧 ≈ 15s（定位 3s 一帧）
 * 已能覆盖 1 个以上车辆帧段。
 */
export const LOCK_ALIGN_MIN_FRAMES = 5;

/**
 * 某车相对用户的**时间对齐**里程差（米）—— 本模块的核心估计量。
 *
 * ── 为什么必须对齐（2026-11-04 修「同线双车锁错 25.7~39.4%」的根因）────────
 *   旧口径 `d = |u(t_now) − v(t_last_frame)|` 把**两个不同时刻**相减：车辆帧 12s 一帧
 *   ⇒ 车位置最多旧 12s（回退 40m）。两车**同时**被回退 ⇒ 用户在后车时前车的旧位置
 *   恰好落到用户附近 ⇒ `argmin` 系统性偏向**先走的那辆**。
 *   实测（车距 26.7m、σ=10m）：lag 10s ⇒ d_前 6.6 / d_后 33.3 ⇒ 锁前车（错）；
 *   lag 1s ⇒ 23.4 / 3.3 ⇒ 锁后车（对）。lag 在 0~12s 均匀 ⇒ 约 2/3 的帧判错。
 *
 * ── 对齐后为什么就对了 ────────────────────────────────────────────────
 *   `followFramesOf` 在**两帧车辆快照之间**线性内插出 `v(t)`，与每个定位帧同刻相减；
 *   再取 `median(u − v)`。两车的 `d` 因此来自**同一时刻、同一用户位置**，其差即真实车距。
 *
 * ⚠️ 用 `|median(u − v)|` 而不是 `median(|u − v|)`：后者被半正态偏置抬高
 *   （E|N(0,σ)| = 0.8σ），实测让 26.7m 车距只剩 ~18m 的观测差 ⇒ 歧义率反而更高。
 *   取带符号中位再取绝对值，正确车的 `d` 才真的 ≈ 0。
 */
export function alignedDOf(o: {
  colored: LL[];
  fixes: { lng: number; lat: number; accuracy: number; ts: number }[];
  vehFrames: VehFrame[];
  plate: string;
  /** 参考时刻（调用方传最新定位帧 ts）；窗 = [now − LOCK_ALIGN_SPAN_MS, now] */
  nowTs: number;
}): { d: number | null; n: number } {
  if (o.colored.length < 2 || o.fixes.length < 2 || (o.vehFrames?.length ?? 0) < 2) return { d: null, n: 0 };
  const frames = followFramesOf({
    fixes: o.fixes,
    vehFrames: o.vehFrames,
    colored: o.colored,
    plate: o.plate,
    maxFrames: 32,
  });
  const win = frames.filter((f) => o.nowTs - f.ts <= LOCK_ALIGN_SPAN_MS);
  if (win.length < LOCK_ALIGN_MIN_FRAMES) return { d: null, n: win.length };
  const signed = win.map((f) => f.u - f.v);
  return { d: Math.abs(medianOf(signed)), n: signed.length };
}

/**
 * 候选车 = **已不在上车站**的车。
 *
 * @param fix       用户最新**可信**定位（算 `raw` 口径用）；缺省或越容差 ⇒ `raw` 为 null
 * @param tolM      用户投影容差（米，缺省 80 —— 与 `R2_TOL_M` 同口径，由调用方传入避免双源）
 * @param fixes     用户定位历史 —— **给齐 `fixes` + `vehFrames` 才启用对齐口径**
 * @param vehFrames 车辆帧历史
 */
export function departedCandidatesOf(o: {
  vehicles: TrackVehicle[];
  boardMain: string;
  /** 本段站序主码（下标 0 = 上车站）；缺省 ⇒ L-b 不可用 */
  stopMains?: string[] | null;
  colored: LL[];
  fix?: { lng: number; lat: number } | null;
  tolM?: number;
  fixes?: { lng: number; lat: number; accuracy: number; ts: number }[] | null;
  vehFrames?: VehFrame[] | null;
}): DepartCand[] {
  const board = mainOf(o.boardMain);
  if (!board) return [];
  const cands: DepartCand[] = [];
  for (const v of o.vehicles) {
    const via: DepartVia[] = [];
    if (v.interval?.from?.code && mainOf(v.interval.from.code) === board) via.push("L-a");
    if (o.stopMains && o.stopMains.length >= 2 && progressOf(o.stopMains, v).passedIdx >= 0) via.push("L-b");
    if (v.atStation?.code && mainOf(v.atStation.code) !== board) via.push("L-c");
    if (via.length) cands.push({ plate: v.plate, d: null, via, dKind: "raw", nAligned: 0 });
  }
  if (!cands.length || o.colored.length < 2) return cands;

  const cum = cumDistM(o.colored);
  const tol = o.tolM ?? 80;
  let u: number | null = null;
  if (o.fix) {
    const r = alongMileM(o.colored, cum, o.fix);
    if (r && r.dist <= tol) u = r.m;
  }
  const fixes = o.fixes ?? null;
  const vehFrames = o.vehFrames ?? null;
  const nowTs = fixes && fixes.length ? fixes[fixes.length - 1].ts : Number.NaN;

  for (const c of cands) {
    // ① 对齐口径（可比较，择优用）
    if (fixes && vehFrames && Number.isFinite(nowTs)) {
      const a = alignedDOf({ colored: o.colored, fixes, vehFrames, plate: c.plate, nowTs });
      c.nAligned = a.n;
      if (a.d != null) {
        c.d = a.d;
        c.dKind = "aligned";
        continue;
      }
    }
    // ② 回退：单帧错位口径 —— **只用于「唯一候选」的资格判定**，不参与两车比较
    if (u == null) continue;
    const mv = vehicleMileOnPath(o.colored, cum, o.vehicles, c.plate);
    if (mv != null) {
      c.d = Math.abs(u - mv);
      c.dKind = "raw";
    }
  }
  return cands;
}

export interface LockPick {
  plate: string | null;
  /** 选中车的里程差（米）；未选中 / 无里程 ⇒ `null` */
  d: number | null;
  /** 多车无法分辨（里程差 < `FOLLOW_AMBIG_M`）⇒ **不锁** */
  ambiguous: boolean;
}

/**
 * 从候选里挑**可锁车牌**：取 `d` 最小者，且与第二名的差必须 > `FOLLOW_AMBIG_M`。
 * 无里程可比时只有「唯一候选」才锁 —— 分不出是哪辆就**不猜**（与 `r1Of` 的多车歧义同口径）。
 *
 * ⚠️ **L-a 与 L-b/L-c 的资格不同**（防错锁）：
 *   · L-a（车刚从**本站**开走）= 时间 + 空间的强证据 ⇒ 允许「只有它一辆」就锁（旧版行为不变）；
 *   · L-b / L-c 是为「整段乘车」放宽出来的 ⇒ 必须有**位置确认**（`d ≤ FOLLOW_MAX_D_M`）。
 *     否则会出现「用户在站台等车，却锁住 2km 外那辆同线车」的错锁 —— 这正是放宽锁牌
 *     窗口最容易引入的新失效模式。判据不成立的同帧绝不锁，宁可留空。
 *
 * ⚠️ **多车比较只接受 `aligned` 口径**（2026-11-04 修）：
 *   `raw` 含 0~12s 时间错位（两车同时被回退），拿它比大小会系统性偏向先走的车
 *   ⇒ 实测 25.7~39.4% 锁错。故 >1 个候选时，任一候选缺 `aligned` ⇒ **判歧义、不锁**
 *   （宁可留空让上层走 GPS 推算，也不锁错车）。唯一候选不受此限（无需比较）。
 *
 * ── ★★ 本函数的 `aligned` 约束与 `follow-slope.ts#FOLLOW_AMBIG_M`(12) 是**一对** ──
 *   单独改任一条都会静默出错（实测数字见 `FOLLOW_AMBIG_M` 上方那张四配对表）：
 *     · 放宽本约束（允许 raw 参与比较）+ 门仍 12 ⇒ **锁错 37.8%**，比修复前 21.8% 更糟；
 *     · 门改回 20 + 本约束不变 ⇒ 锁错 0 但锁对率白丢 25 个点（87.3% → 62.0%）。
 *   ⇒ 两处必须一起改，改前先读这三处注释（本处 / `FOLLOW_AMBIG_M` / `test-boarding-latency` ㉙）。
 *
 * ── ★ 本修复的**代价（有意交易，不是漏优化）** ──────────────────────────
 *   双车场景下，前 ~15s（`LOCK_ALIGN_MIN_FRAMES = 5` 帧定位 ≈ 15s）尚无对齐样本
 *   ⇒ 多候选一律判歧义 ⇒ **不锁牌** ⇒ 该窗口内斜率判据无法工作（`followFramesOf`
 *   需要 `plate` 才能算），只能靠 r2（GPS 纯定位）判上。
 *   实测首判延迟可能从 **~25s 增到 ~30s（+5s）**，换回来的是**锁错率 21.8% → 0%**。
 *   取舍依据：锁错车会让进度 / 报站 / 下车提醒**全部跟着错车走**，比慢 5 秒严重一个量级；
 *   且「不锁牌」的后果是退化成 GPS 推算（仍能工作），不是失效。
 *   ⚠️ 将来若有人为了「更快锁牌」放宽这条约束，请先重跑 `test-boarding-detect` ㉑ 组，
 *      确认锁错率仍为 0 —— 否则就是拿正确性换延迟。
 */
export function pickLockPlateOf(cands: DepartCand[]): LockPick {
  if (!cands.length) return { plate: null, d: null, ambiguous: false };
  const eligible = cands.filter((c) => c.via.includes("L-a") || (c.d != null && c.d <= FOLLOW_MAX_D_M));
  if (!eligible.length) return { plate: null, d: null, ambiguous: false };
  if (eligible.length === 1) {
    const only = eligible[0];
    return { plate: only.plate, d: only.d, ambiguous: false };
  }
  // 多候选：只有「全部都能对齐」时才允许比大小
  const kind = (c: DepartCand): DistKind => c.dKind ?? "aligned";
  const comparable = eligible.filter((c) => c.d != null && kind(c) === "aligned");
  if (comparable.length < eligible.length) {
    return { plate: null, d: null, ambiguous: true };
  }
  const withD = comparable.sort((a, b) => (a.d as number) - (b.d as number));
  const first = withD[0];
  const second = withD[1];
  if (second && (second.d as number) - (first.d as number) < FOLLOW_AMBIG_M) {
    return { plate: null, d: first.d, ambiguous: true };
  }
  return { plate: first.plate, d: first.d, ambiguous: false };
}
