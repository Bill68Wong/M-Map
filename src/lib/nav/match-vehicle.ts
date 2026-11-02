/**
 * 车辆匹配主函数（src/lib/nav/match-vehicle.ts，v3.7.0 · ADR C10 · 01-技术调研 §6）
 *
 * ── 解决的问题 ────────────────────────────────────────────────────────
 *   「上车后才点开始导航」时，既有 `rankBoardingVehicles({filterPassed:true})` 的候选池口径是
 *   **上车站附近的车**，此刻用户那辆车早已离站 ⇒ 池子空 ⇒ 只能落到 `progressSource="gps"`：
 *   等约 65 秒、最后拿到一辆**没有车牌**的车（地图上看不到自己坐的车，也报不了站）。
 *   根因是**候选池口径**，不是阈值太紧 ⇒ 另建一套，候选 = 本线路本方向**全部在途车**。
 *
 * ── 方法（不照搬 HMM 路网匹配）────────────────────────────────────────
 *   本问题结构是「**已知道路（一条链），未知车辆**」⇒ 单传感器多假设数据关联：
 *   两侧投影到**同一条沿线里程轴**（`match-mile.ts`）→ 逐帧比对「里程-时间」曲线（S1~S5）→
 *   逐帧对数似然比之和 `logL` 作证据量，配合均值口径的 `score / margin` 定置信度。
 *   依据：Newson & Krumm 2009（HMM 路网匹配在本问题退化为 1-D）；Wald 1947（SPRT）；
 *   多目标跟踪的 NN/GNN 数据关联（「一束候选 × 一条轨迹」，单传感器）。
 *   五项证据的定义与权重见 `match-params.ts` 的 `MATCH_W`。
 *
 * ── 为什么速度门在这里不能干活（本项目自己算出来的）──────────────────
 *   档 1「全力冲刺」= 3.6 m/s = **12.96 km/h**，落在既有 R2 速度带 (8, 80] 内，
 *   与实测段速 p50 = 14.8 km/h 几乎重叠 ⇒ 单靠速度**无法**区分「冲刺赶车」与「乘车」。
 *   本实现的解法：S2 比对的是候选车的实测速度 + **残差收敛性**（`diverged`）——
 *   冲刺时与前方车的里程差会持续拉大，`diverged` 一旦成立即封顶 0.6 分并禁高置信。
 *
 * ── ⚠️ 硬依赖：`progress.ts` 的几何缓存新鲜度（AC5.7）──────────────
 *   `dV` 由 `progress.segFrom/segTo/p` 插值得到，而 `p` 是**形状派生量**：改道后若 shape 缓存
 *   仍是旧折线、客户端用的是新折线，同一物理位置的 `p` 就不同（误差可达改道长度的一半，
 *   与 σ_p=60m 同量级）。**失效方向是「拒绝锁车」而不是「锁错车」**：旧+旧 ⇒ 位置项不过线；
 *   旧+新 ⇒ `p` 被 clamp 在端点 ⇒ 偏差一整段 ⇒ 同样不锁。只有「偏差恰好把另一辆车推到
 *   `dU` 附近」才可能锁错，而那时 `margin` 会把置信压到 medium。
 *   ⇒ 代码侧靠 `progress.ts` 的 `TTL_GEOM_MS = 120s`，运维侧靠 `/api/health?warm=1` 的
 *     `versionDrift`（抓「改了道忘了重建里程表」）。**别把 TTL 调回 10 分钟。**
 *
 * ── 与既有判定的边界（ADR C10 选 A = 叠加，不替换）──────────────────
 *   · **不改 `boarding-detect.ts` 一行**：`rankBoardingVehicles` / R1 / R2 继续服务
 *     「上车前开始导航」那条路径；
 *   · `medium` 只允许**标注**（「车牌待确认」），调用方**不得**据此报站读数值；
 *   · `low` 一律 `plate = null`（绝不猜）；总开关默认 false，也可用 `input.enabled` 覆盖。
 *
 * ── 铁律：不做「跨调用累积」──────────────────────────────────────────
 *   若把上一次调用的 `logL` 传进来叠加，90s 窗口在相邻两次 12s 调用间高度重叠 ⇒
 *   同一批帧被重复计入 ⇒ `logL` 虚高 ⇒ **静默误锁**。将来做真正的序贯累积必须只喂
 *   「自上次调用以来的新帧」（新增 `sinceTs`），而不是复用整个窗口。
 */

import {
  MATCH_HIGH_MARGIN,
  MATCH_HIGH_SCORE,
  MATCH_L_HIGH,
  MATCH_L_MEDIUM,
  MATCH_MEDIUM_MIN_FRAMES,
  MATCH_MEDIUM_SCORE,
  MATCH_MIN_FRAMES,
  MATCH_SIGMA_P_ACC_FACTOR,
  MATCH_SIGMA_P_FLOOR_M,
  MATCH_VEHICLE_ENABLED,
  MATCH_WINDOW_MS,
  type MatchInput,
  type MatchRank,
  type MatchResult,
  type MileSample,
} from "./match-params";
import { inWindow, speedOf } from "./match-mile";
import { scoreVehicle, type ScoreContext, type ScoredVehicle } from "./match-score";

/** 参数与类型统一从本文件可见（契约里 `match-vehicle.ts` 是唯一入口） */
export * from "./match-params";

export function matchVehicle(input: MatchInput): MatchResult {
  const reasons: string[] = [];
  const mains = input.stopMains ?? [];
  const excluded = new Set(input.excludedPlates ?? []);
  const enabled = input.enabled ?? MATCH_VEHICLE_ENABLED;

  const low = (poolSize = 0): MatchResult => ({
    plate: null,
    confidence: "low",
    score: 0,
    margin: 0,
    poolSize,
    logL: 0,
    frames: 0,
    reasons,
    evidence: [],
    ranking: [],
  });

  /* ── 候选池：本线路本方向**全部在途车**（不用 `passedBoardOf`）── */
  const inTransit = (input.vehicles ?? []).filter(
    (v) =>
      (v.status === "moving" || v.status === "stopping" || v.status === "terminal") && !excluded.has(v.plate),
  );

  /* ── 硬门（任一不过 ⇒ 不判，`plate = null`）── */
  const gate = (why: string, pool: number): MatchResult => {
    reasons.push(why);
    return low(pool);
  };
  const dUser = input.dUser;
  if (!enabled) return gate("switch:disabled", inTransit.length);
  if (input.colored.length < 2 || input.ladder.path.length < 2) return gate("g1:geometry", inTransit.length);
  if (mains.length < 2) return gate("g1:stop-mains", inTransit.length);
  if (dUser == null || !Number.isFinite(dUser)) return gate("g2:no-user-anchor", inTransit.length);
  if (!inTransit.length) return gate("g3:empty-pool", 0);

  const nowMs = input.nowMs;
  const sigmaP = Math.max(MATCH_SIGMA_P_FLOOR_M, MATCH_SIGMA_P_ACC_FACTOR * (input.userAccuracyM ?? 0));

  /* 用户里程序列：优先历史帧（逐帧比对与 S4 都要序列），否则退化为一帧 */
  const uSeries: MileSample[] = (input.userHistory ?? [])
    .filter((s) => inWindow(s, nowMs, MATCH_WINDOW_MS))
    .map((s) => ({ ts: s.ts, dM: s.dM }))
    .sort((a, b) => a.ts - b.ts);
  if (!uSeries.length) uSeries.push({ ts: nowMs, dM: dUser });
  const uFirst = uSeries[0]!;
  const uLast = uSeries[uSeries.length - 1]!;
  const dUnow = uLast.dM ?? dUser;
  const dUdelta = dUnow - (uFirst.dM ?? dUnow);
  const vUser = speedOf(uSeries, input.userSpeedKmh);

  const scored: ScoredVehicle[] = [];
  const ctx: ScoreContext = {
    mains,
    ladder: input.ladder,
    colored: input.colored,
    uSeries,
    dUnow,
    dUdelta,
    vUser,
    vehicleHistory: input.vehicleHistory,
    nowMs,
    sigmaP,
  };
  let skipped = 0;
  for (const v of inTransit) {
    const r = scoreVehicle(v, ctx);
    if (!r.ok) {
      if (skipped < 3) reasons.push(`skip:${r.why}:${v.plate}`);
      skipped++;
      continue;
    }
    scored.push(r.scored);
  }

  const poolSize = scored.length;
  if (!poolSize) {
    reasons.push("g4:no-scorable-vehicle");
    return low(0);
  }

  scored.sort((a, b) => b.score - a.score || b.logL - a.logL);
  const top = scored[0]!;
  const second = scored[1] ?? null;
  const margin = second ? top.score - second.score : top.score;
  const ranking: MatchRank[] = scored
    .slice(0, 3)
    .map(({ plate, score, logL, frames, dM }) => ({ plate, score, logL, frames, dM }));
  /* 逐项判负原因（只打胜出者；供 `data-match-reasons`） */
  const label: Record<string, string> = {
    s1: "s1:position",
    s2: "s2:speed",
    s3: "s3:direction",
    s4: "s4:not-passed",
    s5: "s5:unreachable",
  };
  for (const e of top.evidence) if (e.value < 0.5) reasons.push(label[e.key] ?? e.key);
  if (top.diverged) reasons.push("s1:diverging");

  const pick = (confidence: MatchResult["confidence"]): MatchResult => ({
    plate: top.plate,
    confidence,
    score: top.score,
    margin,
    poolSize,
    logL: top.logL,
    frames: top.frames,
    reasons,
    evidence: top.evidence,
    ranking,
  });

  /**
   * 分级（阈值见 `match-params.ts`）：
   *   high   = `logL ≥ 3.0` ∧ `score ≥ 0.75` ∧ `margin ≥ 0.20` ∧ `frames ≥ 3` ∧ 未发散
   *   medium = `logL ≥ 1.0` ∧ `score ≥ 0.60` ∧ **`frames ≥ 2`**（锁定但标注「车牌待确认」，**不得据此报站**）
   *   low    = 其余（`plate = null`）
   * ⚠️ `frames ≥ 2` 不是保守起见：σ_p = 60 时单帧 `r ≈ 0` 的对数似然比就有 2.37 nats，
   *   **一帧即可越过 `logL ≥ 1.0`**；而池里 3~5 辆车通常有 2~3 辆是停靠/总站车
   *   （靠 `atStation` 拿里程进池、但车辆序列只有 1 帧）⇒ 这是**每次乘车都会发生**的路径。
   *   medium 一锁牌 `progressSource` 就变 `vehicle`（报站值从车牌推），单帧撑不住。
   * ⚠️ 已发散且残差超出 σ_p ⇒ 直接 low（冲刺赶车 ⇒ 不能判成乘车）。
   */
  if (top.diverged && Math.abs(top.rLast) > sigmaP) {
    reasons.push("gate:diverged");
    return low(poolSize);
  }
  if (
    top.logL >= MATCH_L_HIGH &&
    top.score >= MATCH_HIGH_SCORE &&
    margin >= MATCH_HIGH_MARGIN &&
    top.frames >= MATCH_MIN_FRAMES &&
    !top.diverged
  ) {
    return pick("high");
  }
  /**
   * 中置信：先过 `logL / score / frames` 三道门，再过 `margin`。
   * `reasons` 按**实际未满足的那道门**分派 —— 它是 QA 区分「medium 与 high」的唯一依据，
   * 统一打成 `gate:margin` 会让人误判成「池里没别的车」（其实可能只是帧数不够）。
   */
  if (top.frames < MATCH_MEDIUM_MIN_FRAMES) {
    reasons.push("gate:frames");
    return low(poolSize);
  }
  if (top.logL >= MATCH_L_MEDIUM && top.score >= MATCH_MEDIUM_SCORE) {
    /**
     * 到 medium 只说明「两帧门 + logL/score 门」都过了，**不代表 high 的每一道门都过了**。
     * 按实际缺的那道门分派 —— 顺序即硬度：帧数是硬约束（`high` 要 3 帧、`medium` 只要 2），
     * 其次是证据量，最后才是分数/间距。
     * ⚠️ `gate:frames`（frames < 2，连 medium 都不够）与 `gate:frames-high`
     *   （2 ≤ frames < 3，够 medium 不够 high）**必须区分**：
     *   前者是「证据太少」，后者是「再多攒一帧就能升 high」，排查方向完全不同。
     */
    if (top.frames < MATCH_MIN_FRAMES) reasons.push("gate:frames-high");
    else if (top.logL < MATCH_L_HIGH) reasons.push("gate:logl");
    else if (top.score < MATCH_HIGH_SCORE) reasons.push("gate:score");
    else reasons.push(top.diverged ? "gate:diverging" : "gate:margin");
    return pick("medium");
  }
  reasons.push("gate:evidence");
  return low(poolSize);
}
