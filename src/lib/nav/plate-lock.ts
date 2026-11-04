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
import { alongMileM, vehicleMileOnPath } from "./follow-frames";
import { FOLLOW_AMBIG_M, FOLLOW_MAX_D_M } from "./follow-slope";

/** 「车已不在上车站」的证据来源（三条件并集；任一成立即可） */
export type DepartVia = "L-a" | "L-b" | "L-c";

export interface DepartCand {
  plate: string;
  /** 用户与该车的沿线里程差（米）；几何/定位不可用 ⇒ `null` */
  d: number | null;
  via: DepartVia[];
}

/**
 * 候选车 = **已不在上车站**的车。
 *
 * @param fix  用户最新**可信**定位（算 `d` 用）；缺省或越容差 ⇒ `d` 一律 null（不猜）
 * @param tolM 用户投影容差（米，缺省 80 —— 与 `R2_TOL_M` 同口径，由调用方传入以避免双源）
 */
export function departedCandidatesOf(o: {
  vehicles: TrackVehicle[];
  boardMain: string;
  /** 本段站序主码（下标 0 = 上车站）；缺省 ⇒ L-b 不可用 */
  stopMains?: string[] | null;
  colored: LL[];
  fix?: { lng: number; lat: number } | null;
  tolM?: number;
}): DepartCand[] {
  const board = mainOf(o.boardMain);
  if (!board) return [];
  const cands: DepartCand[] = [];
  for (const v of o.vehicles) {
    const via: DepartVia[] = [];
    if (v.interval?.from?.code && mainOf(v.interval.from.code) === board) via.push("L-a");
    if (o.stopMains && o.stopMains.length >= 2 && progressOf(o.stopMains, v).passedIdx >= 0) via.push("L-b");
    if (v.atStation?.code && mainOf(v.atStation.code) !== board) via.push("L-c");
    if (via.length) cands.push({ plate: v.plate, d: null, via });
  }
  if (!cands.length || o.colored.length < 2) return cands;

  const cum = cumDistM(o.colored);
  const tol = o.tolM ?? 80;
  let u: number | null = null;
  if (o.fix) {
    const r = alongMileM(o.colored, cum, o.fix);
    if (r && r.dist <= tol) u = r.m;
  }
  if (u == null) return cands; // 用户位置不可信 ⇒ d 一律 null（不猜）
  for (const c of cands) {
    const mv = vehicleMileOnPath(o.colored, cum, o.vehicles, c.plate);
    if (mv != null) c.d = Math.abs(u - mv);
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
 * 从候选里挑**可锁车牌**：取 `d` 最小者，且与第二名的差必须 > `FOLLOW_AMBIG_M`（2σ≈20m）。
 * 无里程可比时只有「唯一候选」才锁 —— 分不出是哪辆就**不猜**（与 `r1Of` 的多车歧义同口径）。
 *
 * ⚠️ **L-a 与 L-b/L-c 的资格不同**（防错锁）：
 *   · L-a（车刚从**本站**开走）= 时间 + 空间的强证据 ⇒ 允许「只有它一辆」就锁（旧版行为不变）；
 *   · L-b / L-c 是为「整段乘车」放宽出来的 ⇒ 必须有**位置确认**（`d ≤ FOLLOW_MAX_D_M`）。
 *     否则会出现「用户在站台等车，却锁住 2km 外那辆同线车」的错锁 —— 这正是放宽锁牌窗口
 *     最容易引入的新失效模式。判据不成立的同帧绝不锁，宁可留空。
 */
export function pickLockPlateOf(cands: DepartCand[]): LockPick {
  if (!cands.length) return { plate: null, d: null, ambiguous: false };
  const eligible = cands.filter((c) => c.via.includes("L-a") || (c.d != null && c.d <= FOLLOW_MAX_D_M));
  if (!eligible.length) return { plate: null, d: null, ambiguous: false };
  const withD = eligible.filter((c) => c.d != null).sort((a, b) => (a.d as number) - (b.d as number));
  if (!withD.length) {
    return eligible.length === 1
      ? { plate: eligible[0].plate, d: null, ambiguous: false }
      : { plate: null, d: null, ambiguous: true };
  }
  const first = withD[0];
  const second = withD[1];
  if (second && (second.d as number) - (first.d as number) < FOLLOW_AMBIG_M) {
    return { plate: null, d: first.d, ambiguous: true };
  }
  return { plate: first.plate, d: first.d, ambiguous: false };
}
