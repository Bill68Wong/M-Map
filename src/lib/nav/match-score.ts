/**
 * 车辆匹配 · 单车打分（src/lib/nav/match-score.ts，v3.7.0 · ADR C10）
 *
 * 从 `match-vehicle.ts` 抽出来的**单项职责**：给定一辆候选车与用户轨迹，算出 S1~S5 五项证据、
 * 加权分与残差发散标记。抽出的原因有两个：
 *   ① `match-vehicle.ts` 已到 300 行门禁；
 *   ② 五项证据是「可逐项打点」的验收对象（`data-match-reasons` / `data-match-score`），
 *      单独成文件后参数与公式集中一处，改动时不会牵动候选池与置信度分级的代码。
 *
 * ── 五项证据（权重见 `match-params.ts#MATCH_W`）────────────────────────
 *   S1 位置一致 —— `exp(−r²/2σ_p²)` 的**逐帧均值**，`r` = 用户里程 − 车辆里程；
 *                  同一循环里累积逐帧对数似然比 `logL`（正态 vs 均匀零假设）。
 *   S2 速度一致 —— 对照物是**该车自己的实测沿线速度**，不是固定门槛。
 *                  （速度门无法区分「冲刺赶车 12.96 km/h」与「乘车」，此处的对照物设计才是关键）
 *   S3 方向一致 —— 用**里程单调方向**同号，不用车头朝向；位移 < 30m 时该项不参与。
 *   S4 曾经过我 —— 窗口内该车里程曾 ≤ 我的里程且相距 ≤ 120m；**无历史 ⇒ 不参与**
 *                  （冷启动时既不奖励也不惩罚，权重按比例回填给其余项）。
 *   S5 时间可达 —— 车在**前方**按单跳时长预算；车在**后方**必须**追近**（防后车误锁）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   纯函数、client-safe；不读全局、不取 `Date.now()`（`nowMs` 由调用方给）。
 *   「算不出里程 / 对不上帧」一律返回 `null` 让上层跳过，**绝不**用 0 分代替（那会误判成「不是这辆」）。
 */

import type { LL } from "./route-overview";
import type { LrtLadder } from "./lrt-progress";
import type { TrackVehicle } from "./track";
import { alignFrames, combine, inWindow, speedOf, vehicleMileOf } from "./match-mile";
import {
  MATCH_DIVERGE_SCORE_CAP,
  MATCH_MIN_STEP_M,
  MATCH_NULL_RANGE_M,
  MATCH_RESID_GROW_TOL_M,
  MATCH_S4_PASS_M,
  MATCH_S4_WINDOW_MS,
  MATCH_S5_HOP_FACTOR,
  MATCH_S5_HOP_P50_SEC,
  MATCH_SIGMA_V_KMH,
  MATCH_W,
  MATCH_WINDOW_MS,
  type MatchEvidenceItem,
  type MileSample,
} from "./match-params";

/** 一项证据的原始值（`null` = 该项不参与，权重按比例回填） */
export interface MatchTerms {
  s1: number | null;
  s2: number | null;
  s3: number | null;
  s4: number | null;
  s5: number | null;
}

/** 打分结果（成功） */
export interface ScoredVehicle {
  plate: string;
  /** 加权均分 0..1（发散时封顶 0.6） */
  score: number;
  /** 逐帧对数似然比之和（nats，本窗口内） */
  logL: number;
  frames: number;
  /** 该车当前沿线里程（米） */
  dM: number;
  evidence: MatchEvidenceItem[];
  /** 残差持续拉大 ⇒ 不是同一辆车（冲刺赶车的唯一防线） */
  diverged: boolean;
  /** 最后一帧的残差（米） */
  rLast: number;
}

/** 打分上下文（一次调用内不变的部分） */
export interface ScoreContext {
  mains: string[];
  ladder: LrtLadder;
  /** 本段乘车折线（GCJ-02）—— 车辆无 progress 时用它做同轴投影兜底 */
  colored: LL[];
  uSeries: MileSample[];
  dUnow: number;
  dUdelta: number;
  vUser: number | null;
  vehicleHistory?: Record<string, MileSample[]>;
  nowMs: number;
  /** 位置一致 σ_p（米，= max(60, 1.5×accuracy)） */
  sigmaP: number;
}

export type ScoreOutcome =
  | { ok: true; scored: ScoredVehicle }
  | { ok: false; why: "no-mile" | "no-frame" };

/**
 * 给一辆候选车打分。
 * @returns `{ ok:false }` ⇒ 该车不进池（无里程 / 无对齐帧）。**不判负、不猜。**
 */
export function scoreVehicle(v: TrackVehicle, ctx: ScoreContext): ScoreOutcome {
  const { nowMs, mains, ladder, colored, uSeries, dUnow, dUdelta, vUser, sigmaP } = ctx;

  /* ① 车辆里程序列（历史 + 本帧观测） */
  const dVcur = vehicleMileOf(v, mains, ladder, colored);
  const vSeries: MileSample[] = (ctx.vehicleHistory?.[v.plate] ?? [])
    .filter((s) => inWindow(s, nowMs, MATCH_WINDOW_MS))
    .map((s) => ({ ts: s.ts, dM: s.dM }))
    .sort((a, b) => a.ts - b.ts);
  if (dVcur != null && !vSeries.some((s) => s.ts === nowMs)) vSeries.push({ ts: nowMs, dM: dVcur });
  const lastSample = vSeries[vSeries.length - 1];
  // 无 progress / 隧道失联 / 无新帧 ⇒ 不进池（**绝不据此判负**）
  if (!lastSample || lastSample.dM == null) return { ok: false, why: "no-mile" };

  /* ② 逐帧对齐（环线跳变帧在这里被丢弃并重置基线） */
  const frames = alignFrames(vSeries, uSeries);
  if (!frames.length) return { ok: false, why: "no-frame" };

  const dVnow = lastSample.dM;
  const vV = speedOf(vSeries);

  /* S1 位置一致（逐帧均值）+ 逐帧对数似然比累积 */
  let s1sum = 0;
  let logL = 0;
  const inv = 1 / (2 * sigmaP * sigmaP);
  /** ln(1/(σ√2π)) − ln(1/(2·NULL_RANGE)) = 正态密度相对均匀零假设的对数比 */
  const logNorm = Math.log((2 * MATCH_NULL_RANGE_M) / (sigmaP * Math.sqrt(2 * Math.PI)));
  for (const f of frames) {
    const z = f.r * f.r * inv;
    s1sum += Math.exp(-z);
    logL += logNorm - z;
  }
  const s1 = s1sum / frames.length;

  /* S2 速度一致 —— 对照物是**该车自己的实测速度**，不是固定门槛 */
  const sigmaV = MATCH_SIGMA_V_KMH;
  const s2 = vUser != null && vV != null ? Math.exp(-((vUser - vV) ** 2) / (2 * sigmaV * sigmaV)) : null;

  /* S3 方向一致 —— 里程单调方向，不用车头朝向 */
  const dVdelta = dVnow - (vSeries[0]?.dM ?? dVnow);
  const dirOk = Math.sign(dUdelta) === Math.sign(dVdelta) && Math.sign(dUdelta) !== 0;
  const s3 =
    Math.abs(dUdelta) < MATCH_MIN_STEP_M || Math.abs(dVdelta) < MATCH_MIN_STEP_M ? null : dirOk ? 1 : 0;

  /* S4 车曾经过我（无历史 ⇒ 不参与，权重按比例回填） */
  const s4hist = (ctx.vehicleHistory?.[v.plate] ?? []).filter((s) => inWindow(s, nowMs, MATCH_S4_WINDOW_MS));
  const s4 =
    s4hist.length === 0
      ? null
      : s4hist.some((s) => s.dM != null && s.dM <= dUnow && Math.abs(s.dM - dUnow) <= MATCH_S4_PASS_M)
        ? 1
        : 0;

  /* S5 时间可达 —— 车在前方按时间预算；车在后方必须**追近** */
  const gap = dVnow - dUnow;
  const gapFirst = (frames[0]?.dV ?? dVnow) - dUnow;
  const vEff = Math.max((vV ?? 0) / 3.6, 1.4);
  const s5 =
    gap >= 0
      ? gap / vEff <= MATCH_S5_HOP_P50_SEC * MATCH_S5_HOP_FACTOR
        ? 1
        : 0
      : Math.abs(gap) < Math.abs(gapFirst) - 10
        ? 1
        : 0;

  /* 残差收敛性：「车在前方且差距持续拉大」⇒ 不是同一辆车 */
  const rLast = frames[frames.length - 1]!.r;
  const diverged = gap > 0 && Math.abs(rLast) > Math.abs(frames[0]!.r) + MATCH_RESID_GROW_TOL_M;

  const terms: MatchTerms = { s1, s2, s3, s4, s5 };
  const raw = combine([
    { value: s1, weight: MATCH_W.s1 },
    { value: s2, weight: MATCH_W.s2 },
    { value: s3, weight: MATCH_W.s3 },
    { value: s4, weight: MATCH_W.s4 },
    { value: s5, weight: MATCH_W.s5 },
  ]);
  const score = diverged ? Math.min(raw, MATCH_DIVERGE_SCORE_CAP) : raw;
  const evidence: MatchEvidenceItem[] = (Object.keys(terms) as (keyof MatchTerms)[])
    .filter((k) => terms[k] != null)
    .map((k) => ({ key: k, value: terms[k] as number, weight: MATCH_W[k] }));

  return {
    ok: true,
    scored: { plate: v.plate, score, logL, frames: frames.length, dM: dVnow, evidence, diverged, rLast },
  };
}
