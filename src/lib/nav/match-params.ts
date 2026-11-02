/**
 * 车辆匹配 · 参数与类型（src/lib/nav/match-params.ts，v3.7.0 · ADR C10）
 *
 * 为什么单独成文件：参数取值是「有依据、待标定」的东西（01-技术调研 §6.4 参数表），
 * 必须集中一处、可被单测直接断言 —— 散落在算法实现里就没人敢改、也没人能核对。
 * 与 `boarding-detect.ts` 的「判定参数锁定表」是同一套纪律。
 *
 * ⚠️ **参数来源局限（必须写明）**：`σ_p / σ_v / 阈值` 三个值目前**有依据但未标定**。
 *   库里没有「乘客手机 GPS 轨迹」数据（`data/tracking/` 是**车辆侧** loc 采集），无法离线回归。
 *   真机标定需要同一次乘车同时录（a）用户手机 GPS、（b）该车 loc，再拟合 σ 与阈值。
 *   在此之前按 §6.4 取值，**不要**为「让某个用例通过」而挪动这些数字。
 */

/** 总开关：默认 **false**（Spec §10「匹配算法误锁」的回滚手段），灰度验证后再开 */
export const MATCH_VEHICLE_ENABLED = false;

/** 证据窗口 T —— 与 `useRideTracking` 的 `FIX_KEEP_MS = 90_000` 一致（也覆盖 3 个 12s 车辆帧） */
export const MATCH_WINDOW_MS = 90_000;
/** 用户帧与车辆帧允许的最大时间错位（车辆帧 12s 一帧、GPS ~1s 一帧 ⇒ 6s 足够配对） */
export const MATCH_ALIGN_TOL_MS = 6_000;

/**
 * 位置一致 σ_p 下限（米）：沿用 `R2_TOL_M = 80` 与 `R2_ACC_TOL_FACTOR = 1.5` 的既有口径
 * （`boarding-detect.ts:42,46`）—— **不引入第二套容差**，否则同一个投影会有两个「可信」标准。
 */
export const MATCH_SIGMA_P_FLOOR_M = 60;
export const MATCH_SIGMA_P_ACC_FACTOR = 1.5;

/** 速度一致 σ_v（km/h）：实测段速 p25/p50/p75 = 9.6/14.8/23.1 ⇒ 四分位半宽 ≈ 6.8，取 6 */
export const MATCH_SIGMA_V_KMH = 6;

/** 方向一致性所需的最小位移（米）：低于此值方向无意义 ⇒ 该项**不参与**（权重按比例回填） */
export const MATCH_MIN_STEP_M = 30;

/** S4「车曾经过我」时间窗：覆盖「上车 → 点开始导航」的操作延迟（= `GPS_PAUSE_MS × 2`） */
export const MATCH_S4_WINDOW_MS = 120_000;
/** S4「经过我」的里程容差（米） */
export const MATCH_S4_PASS_M = 120;

/** S5 时间可达：单跳时长先验 p50 = 105s（实测 2458 个站对），预算倍数 ×2 */
export const MATCH_S5_HOP_P50_SEC = 105;
export const MATCH_S5_HOP_FACTOR = 2;

/** 里程跳变余量（米）—— 与 `monotonicCut` 的 `+120` 同一写法 */
export const MATCH_STEP_SLACK_M = 120;

/** 残差收敛判定容忍（米）：残差增大超过此值 ⇒ 判「在拉开距离」 */
export const MATCH_RESID_GROW_TOL_M = 30;

/** 零假设下的里程范围（米）：不在这辆车上时，沿线里程近似在 ±此值内均匀分布（建模假设） */
export const MATCH_NULL_RANGE_M = 800;

/** 五项权重（顺序即 `evidence` 的打印顺序） */
export const MATCH_W = { s1: 0.4, s2: 0.2, s3: 0.15, s4: 0.15, s5: 0.1 } as const;

/** 锁定分数线 / 与次优的最小间距 */
export const MATCH_HIGH_SCORE = 0.75;
export const MATCH_HIGH_MARGIN = 0.2;
/** 中置信分数线（锁定 + 标注「车牌待确认」） */
export const MATCH_MEDIUM_SCORE = 0.6;

/** 高置信所需证据量（nats；ln 20 ≈ 3.0 = 20:1 优势比） */
export const MATCH_L_HIGH = 3.0;
/** 中置信所需证据量 */
export const MATCH_L_MEDIUM = 1.0;

/**
 * 高置信所需的最少对齐帧数。
 *
 * ⚠️ 取值口径（别再写成「取严」）：设计文档写的是「有车速佐证 3 帧 / 无则 4 帧」，
 *   本实现**统一取 3** —— 因为「有无车速佐证」由 S2/S3 是否参与隐式表达，而 `combine`
 *   对未参与项按比例回填权重 ⇒ 帧数再加一档并不能替代**分数门**。
 *   「别让 1 帧就锁牌」的责任改由 `MATCH_MEDIUM_MIN_FRAMES = 2` 兜住（medium 才是单帧的真实漏洞）。
 */
export const MATCH_MIN_FRAMES = 3;

/**
 * 中置信所需的**最少对齐帧数**（v3.7.0 复核新增）。
 *
 * 为什么必须 ≥2：σ_p = 60 时单帧 `r ≈ 0` 的对数似然比就有 2.37 nats ≥ `MATCH_L_MEDIUM(1.0)`
 * ⇒ **一帧即可进 medium**。而这**不是边角场景**：池里 3~5 辆车通常有 2~3 辆是
 * `stopping`/`terminal`，它们靠 `atStation` 拿里程能进池，但车辆序列只有 1 帧。
 * medium 一旦锁牌，`progressSource` 就变成 `vehicle`（报站值从车牌推），
 * 契约明确「medium 不得据以报站」⇒ 单帧撑不住这个责任。
 *
 * 🚫 **不许取 1**。注意一条不变式：`scoreVehicle` 在 `frames.length === 0` 时直接返回
 *   `ok:false`（`why:"no-frame"`）⇒ **任何进入评分的候选都满足 `frames ≥ 1`**。
 *   因此 `MATCH_MEDIUM_MIN_FRAMES = 1` 与「**整块删掉这道帧数门**」在语义上**完全等价**，
 *   不是"稍微放松一点"。实测（变异 M3 删门 vs M4 改为 1）：两者在本仓 68 条用例上
 *   产生**完全相同的 6 条红**，无法区分 —— 正因为它们本来就是同一个改动。
 *   ⇒ 看到有人把它调成 1，等同于看到有人删门，必须同等对待。
 */
export const MATCH_MEDIUM_MIN_FRAMES = 2;

/** 残差在拉开距离时的分数上限（低于 `MATCH_HIGH_SCORE` ⇒ 冲刺赶车拿不到高置信） */
export const MATCH_DIVERGE_SCORE_CAP = 0.6;

/**
 * 同轴投影兜底的可信门（米）= `track.ts` 的 `TRAVELED_SNAP_MAX_M`（60m，与蓝点吸附同门）。
 * 用途：车辆没有 `progress` 时，直接把车辆坐标投影到**同一条** `leg.colored` 上取里程。
 * 这不是「用坐标硬凑」—— 它与用户的 `dU` 走**同一条折线、同一个投影函数**，同源同轴；
 * 60m 门保证「远处的车不会靠投影硬塞进候选池」。投影到折线的距离用 `perpDistM`（真垂距），
 * 不能用「到最近顶点的距离」（顶点量化会系统性高估，见 `perpDistM` 的 JSDoc）。
 */
export const MATCH_PROJ_TRUST_M = 60;

/* ══════════════════ 类型 ══════════════════ */

import type { LL } from "./route-overview";
import type { LrtLadder } from "./lrt-progress";
import type { TrackVehicle } from "./track";

/** 里程采样（`dM` = 沿线里程，米；`null` = 该帧算不出，不参与） */
export interface MileSample {
  ts: number;
  dM: number | null;
}

/** 对齐后的一帧（`r` = 用户里程 − 车辆里程，米） */
export interface MatchFrame {
  ts: number;
  dV: number;
  r: number;
}

export interface MatchInput {
  /** 本段乘车折线（GCJ-02；`colored[0]` = 上车站）。仅用于「几何可用」硬门 */
  colored: LL[];
  /** `buildLrtLadder(colored, stops)` 的结果（站里程碑 + 有效性） */
  ladder: LrtLadder;
  /** 用户沿线里程（`advanceLrt` 的 `distNow`）；`null` = 不可信/无锚 ⇒ **不判** */
  dUser: number | null;
  /** 用户沿线速度（km/h）；缺省则由 `userHistory` 推算 */
  userSpeedKmh: number | null;
  /** 该线路该方向**全部在途车**（**不**过滤 `passedBoardOf`） */
  vehicles: TrackVehicle[];
  /** 「不是这辆」累积排除的车牌 */
  excludedPlates: string[];
  /** 本帧时刻（ms）—— 由调用方给；函数内**不取时**（纯函数） */
  nowMs: number;
  /** 与 `ladder.ladder` **下标对齐**的站主码数组（把 `progress.segFrom/segTo` 锚到里程） */
  stopMains?: string[];
  /** 最新定位精度（米）；缺省按下限处理 */
  userAccuracyM?: number;
  /** 用户里程序列（窗口内的可信帧；逐帧比对与证据累积都要） */
  userHistory?: MileSample[];
  /** 车牌 → 车辆里程序列（S4 与逐帧比对用；缺省 ⇒ S4 不参与） */
  vehicleHistory?: Record<string, MileSample[]>;
  /** 显式覆盖总开关（单测 / 灰度；缺省读 `MATCH_VEHICLE_ENABLED`） */
  enabled?: boolean;
}

export interface MatchEvidenceItem {
  key: "s1" | "s2" | "s3" | "s4" | "s5";
  value: number;
  weight: number;
}

export interface MatchRank {
  plate: string;
  score: number;
  logL: number;
  frames: number;
  /** 该车当前沿线里程（米） */
  dM: number;
}

export interface MatchResult {
  /** 高/中置信时为车牌；**低置信恒 `null`**（绝不猜） */
  plate: string | null;
  confidence: "high" | "medium" | "low";
  /**
   * 加权均分 0..1（未参与的项**按比例回填权重**）。
   * ⚠️ **`confidence === "low"` 时恒为 `0`**（无可信结论就不报分数，见 `low()`）。
   * 下游若要判断「有没有结论」，看 `confidence`，**不要**用 `score > 0`。
   *
   * ⚠️ **另注意分母塌缩**：未参与项被按比例回填 ⇒ 证据项越少、权重分母越小、均分被**结构性抬高**，
   * 单帧可得 ≈1.0。⇒ **分数门测的是「已有证据有多一致」，不测「证据数量」**；
   * 帧数门（`MATCH_MEDIUM_MIN_FRAMES` / `MATCH_MIN_FRAMES`）才是唯一度量证据量的门。
   * 别因为「单帧 score 都 1.0」就认为分数门无效 —— 那是把证据强度与证据数量混为一谈。
   */
  score: number;
  /** `score_1 − score_2`（只有 1 辆时 = `score_1`）；low 时恒 `0`（同 `score` 的归零契约） */
  margin: number;
  /** 可打分候选数（`dV` 可解、未被排除、时间上对得上） */
  poolSize: number;
  /**
   * 逐帧对数似然比之**和**（本窗口内，nats）。
   * ⚠️ **`confidence === "low"` 时恒为 `0`**（同 `score` 的归零契约）。
   */
  logL: number;
  /**
   * 参与比对的对齐帧数。
   * ⚠️ **`confidence === "low"` 时恒为 `0`**（无可信结论就不报帧数）。
   *
   * 这条是**对外契约**，不是实现巧合 —— 写成 0 是刻意的：若 low 时仍回带真实帧数，
   * 下游很容易把「1 帧」当成「有 1 帧证据可用」而去反推可信度（实际是被帧数门拦下的）。
   * ⇒ **不能用返回值的 `frames` 反推「实际对齐了几帧」**，也不能据此判断「是不是分数不够」；
   * 要观察内部分数请直接调 `scoreVehicle`（`match-score.ts`），它给出未经归零的 `frames/logL/score`。
   */
  frames: number;
  /** 逐项判负原因（如 `s3:direction` / `skip:no-mile:AB1234`） */
  reasons: string[];
  /** 胜出候选的五项证据（逐项打点，供 `data-match-reasons`） */
  evidence: MatchEvidenceItem[];
  /** 前 3 名（已剔除 `excludedPlates`） */
  ranking: MatchRank[];
}
