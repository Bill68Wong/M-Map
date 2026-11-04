/**
 * 停站期候选车牌的**展示判定**（src/components/nav/cand-view.ts，★ 2026-11-04 新增）
 *
 * ── 为什么单独一个文件（而不是写在 `NavDetailBody.tsx` 里）────────────────
 *   这是**纯函数**，必须能被单测直接 import。放在 `.tsx` 组件里会拖进 React / 图标库 /
 *   全部子组件，测试只能"读源码字符串"或"复刻实现"——本项目刚因后者栽过一次：
 *   `test-nav-info-consistency.ts` 里复刻的判据自己是对的，组件被判据改坏时它仍全绿。
 *   ⇒ 纯逻辑一律下沉到可 import 的模块，测试断言的就是**线上那一份**。
 *
 * ── 两层职责的分界（别把时钟塞进判定层）────────────────────────────────
 *   ① `lib/nav/boarding-detect.ts#candAtStopOf` —— **只管几何**：
 *      `unique`（正停本站且只 1 辆）/ `strong`（刚离站且 ≤60m）/ `ambiguous` / `none`。
 *      纯数学、无时钟、无相位。
 *   ② 本文件 —— **只管上下文**：相位、是否已上过车、本段是否巴士、车辆帧是否新鲜。
 *      产出最终写进 `data-cand-state` 的六值。
 *   分开的好处：几何判定可以穷举单测；上下文判定可以被喂任意 `nowMs` 而不必"造时间"。
 */
import { VEH_STALE_SEC } from "./observe-hooks";

/** `data-cand-state` 的取值集合（设计 §2.10 定稿，六个值一个不多一个不少） */
export type CandState = "unique" | "strong" | "ambiguous" | "stale" | "none" | "off";

export interface CandViewInput {
  /** 判定层产物；`null` = 本帧没算（未到候车期 / 非巴士段 / 已清场） */
  cand: { plate: string | null; state: "unique" | "strong" | "ambiguous" | "none" } | null;
  /** 乘车相位是否 `boarding` */
  boarding: boolean;
  /** 单向锁存：本次导航是否已上过车（上过车就不再提示"来车"） */
  latched: boolean;
  /** 当前腿载具类型；`null` = 无卡。轻轨是时刻表制、无「来车车牌」概念 */
  legKind: "bus" | "lrt" | null;
  /** 最近一次**车辆**帧时刻（ms；0 = 本次会话还没拿到过） */
  lastVehicleTs: number;
  /** 本地"现在"（由既有 15s 心跳驱动；**不在渲染期直接 `Date.now()`**） */
  nowMs: number;
}

/** 「不显示」的统一形状（`off` 与 `none` 都长这样，靠 `state` 区分成因） */
const HIDDEN = { plate: null } as const;

/**
 * 展示判定：**只有 `unique` / `strong` 才给车牌**，其余一律 `plate = null`。
 *
 * 判定顺序（每一条都是"宁可不显示"的理由）：
 *   ① 轻轨段 / 非候车期 / 已上过车 ⇒ `off`（这一行本来就不该出现「来车」）
 *      · 已上过车仍提示「来车」= 让用户去拦一辆自己已经坐上的车；
 *   ② 车辆帧缺失或超过 `VEH_STALE_SEC`(30s) ⇒ `stale`
 *      **过期车牌比没有更危险**：用户会照着屏幕去拦一辆早就开走的车；
 *   ③ 否则取判定层结果（`null` ⇒ `none`）。
 *
 * ⚠️ **不做**防抖、**不做**「20s 记忆」（设计明确要求）：轮询 12s，2 连帧就是 12~24s，
 *   而公交停站只有 20~40s —— 任何记忆窗口都会让"刚看到的那辆车"留在屏幕上继续骗人。
 *   收紧靠**源头条件**（判定层的 `ambiguous`）+ 帧新鲜度，不是事后延时。
 */
export function candViewOf(input: CandViewInput): { state: CandState; plate: string | null } {
  const { cand, boarding, latched, legKind, lastVehicleTs, nowMs } = input;

  if (legKind !== "bus") return { state: "off", ...HIDDEN };
  if (!boarding) return { state: "off", ...HIDDEN };
  if (latched) return { state: "off", ...HIDDEN };

  /**
   * 新鲜度：`lastVehicleTs === 0`（**本次会话还没拿到过车辆帧**）也判 stale ——
   * 不能把「从没查过」当成「刚刚查过且一切正常」。
   */
  const fresh =
    lastVehicleTs > 0 && Number.isFinite(nowMs) && nowMs - lastVehicleTs <= VEH_STALE_SEC * 1_000;
  if (!fresh) return { state: "stale", ...HIDDEN };

  if (!cand) return { state: "none", ...HIDDEN };
  if ((cand.state === "unique" || cand.state === "strong") && cand.plate) {
    return { state: cand.state, plate: cand.plate };
  }
  /** `ambiguous` 保留独立档位（QA 要断言"歧义时必须不显示"）；判定层的 `none` 原样透传 */
  return { state: cand.state === "ambiguous" ? "ambiguous" : "none", ...HIDDEN };
}
