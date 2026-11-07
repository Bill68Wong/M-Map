/**
 * 候车期「怎样走才能赶上」· 实时重算（src/lib/nav/catch-up-live.ts，2026-11-06 · 修复批 #10）
 *
 * ── 解决什么（QA 实测）────────────────────────────────────────────────
 *   点「刷新巴士数据」前后，导航信息行右槽恒为「小跑能赶上」——
 *   那是**规划时刻**的档位（`card.rides[0].tierText`，按「起点 → 上车站的完整步行时长」算的），
 *   人已经走了 300 米，这个结论却一步没动。
 *   本模块按**当前剩余步行距离**与**刷新后的车辆到站时间**重算档位。
 *
 * ── 计算口径（★ 唯一，别改成 `baseMin × (1 − ratio)`）────────────────────
 *   `所需秒数(tier) = (剩余步行米 ÷ 常速米每分钟) × 60 × 耗时比(tier)`
 *
 *   · **分子必须是「剩余距离」**：`baseMin` 是规划时的**全程**步行基准分钟，
 *     用它算剩余段会把「已经走过的那段」再算一遍；
 *   · **不要用 `baseMin × (1 − ratio)` 当节余再去减**：那句式把**已消耗的固定开销**
 *     （`OVERHEAD_SEC = 15` 秒：反应 / 起步 / 过街等待）也一并折掉了 ⇒ 末段会**系统性高估**
 *     （离站台只剩 30 米时它仍能算出"要快 1 分半"，用户会以为来不及而放弃）；
 *   · **不加 `OVERHEAD_SEC`**：人已经在路上，起步/反应已经付过；把 15 秒再加回去，
 *     在最后 50 米这档（常速只要 36 秒）等于凭空多 40% —— 同样是系统性延误。
 *     真正的第二次过街等待应由「剩余距离」本身与 GPS 位移体现，不靠常数兜。
 *   · `耗时比` 一律**复用** `src/lib/recommend/types.ts` 的 `SPEED_RATIO`
 *     （档 1 用 `tier1EffRatio(剩余米)`，随距离衰减，同 `catch-up.ts#requiredSec`）
 *     —— 本文件**不新造任何速度常数、不新造任何档位文案**（文案取 `TIER_TEXT`）。
 *
 * ── 判据方向（与既有模型完全一致）────────────────────────────────────────
 *   从**最慢档 5** 往**最快档 1** 找首个 `所需秒数 ≤ 车辆到站秒数` 的档 ——
 *   与 `catch-up.ts#pickCatchTier` 同序同义（越慢的档要求越低）。
 *   都不满足（连冲刺也赶不上）⇒ `tier = null`，**文案留空**：
 *   本项目**没有**「赶不上」这个文案概念（赶不上的路线在规划阶段就被整条剔除，
 *   见 `types.ts:163-171`），这里不新开一个 —— 调用方见到 `null` 就保持原标签不动。
 */

import { SPEED_RATIO, TIER_TEXT, tier1EffRatio, type CatchTier } from "@/lib/recommend/types";

/**
 * 档位阈值覆盖（与 `catch-up.ts#TierSpeedOverride.ratio` 同形）。
 * 缺省 = 模块默认常量；`NavShell` 目前不传（卡片级 `tiers` 参数只作用于规划侧）。
 */
export interface CatchUpLiveThresholds {
  ratio?: Partial<Record<CatchTier, number>>;
}

export interface CatchUpLiveInput {
  /** 剩余步行距离（米）—— 从**用户实时位置**到上车站（沿步行路径，不是直线） */
  remainWalkM: number;
  /** 常速步行速度（米/分钟）—— 必须传 `WALK_BASE_M_PER_MIN`（= 84），不要自造 */
  walkSpeedMPerMin: number;
  /** 刷新后的巴士到站（分钟，`/api/station/eta` 的 `etaMin`） */
  etaMin: number;
  /** 档位阈值覆盖（可选；缺省走 `SPEED_RATIO`） */
  thresholds?: CatchUpLiveThresholds;
}

export interface CatchUpLiveResult {
  /** 档位；`null` = 连冲刺也赶不上（**文案留空**，调用方保持原标签） */
  tier: CatchTier | null;
  /** 档位文案（取 `TIER_TEXT`，与规划侧同一套枚举；`tier === null` ⇒ `""`） */
  text: string;
  /** 剩余步行分钟（诊断用：= `remainWalkM ÷ walkSpeedMPerMin`） */
  remainWalkMin: number;
}

/** 某档的「耗时比」（基准速度 ÷ 该档速度）；档 1 随剩余距离衰减 */
export function ratioOfTier(
  tier: CatchTier,
  remainWalkM: number,
  ov?: CatchUpLiveThresholds,
): number {
  if (tier === 1) return ov?.ratio?.[1] ?? tier1EffRatio(remainWalkM);
  return ov?.ratio?.[tier] ?? SPEED_RATIO[tier];
}

/**
 * 走完**剩余**距离在该档下需要的秒数（本模块的**唯一**算法出口）。
 * `walkSpeedMPerMin <= 0` / 非法距离 ⇒ 返回 `Infinity`（= 判不出来 ⇒ 不选该档，宁可留空）。
 */
export function requiredSecForRemain(
  remainWalkM: number,
  walkSpeedMPerMin: number,
  tier: CatchTier,
  ov?: CatchUpLiveThresholds,
): number {
  if (!Number.isFinite(remainWalkM) || remainWalkM < 0) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(walkSpeedMPerMin) || walkSpeedMPerMin <= 0) return Number.POSITIVE_INFINITY;
  const walkSec = (remainWalkM / walkSpeedMPerMin) * 60;
  return walkSec * ratioOfTier(tier, remainWalkM, ov);
}

/** 判档：从 5 → 1 找首个 `所需秒数 ≤ etaMin*60` 的档；都不满足 ⇒ `null` */
export function pickLiveTier(input: CatchUpLiveInput): CatchTier | null {
  const { remainWalkM, walkSpeedMPerMin, etaMin, thresholds } = input;
  if (!Number.isFinite(etaMin) || etaMin < 0) return null;
  const waitSec = etaMin * 60;
  for (let k = 5; k >= 1; k--) {
    const t = k as CatchTier;
    if (requiredSecForRemain(remainWalkM, walkSpeedMPerMin, t, thresholds) <= waitSec) return t;
  }
  return null;
}

/**
 * 实时档位 + 文案。
 * ⚠️ `tier === null` 时 `text` 是 `""` —— 调用方（`NavDetailBody`）据此回落 `card.rides[0].tierText`，
 *    而不是渲染一个空胶囊或新造一句「赶不上」。
 */
export function catchUpLive(input: CatchUpLiveInput): CatchUpLiveResult {
  const remainWalkMin =
    Number.isFinite(input.remainWalkM) && input.walkSpeedMPerMin > 0
      ? Math.max(0, input.remainWalkM) / input.walkSpeedMPerMin
      : 0;
  const tier = pickLiveTier(input);
  return { tier, text: tier === null ? "" : TIER_TEXT[tier], remainWalkMin };
}
