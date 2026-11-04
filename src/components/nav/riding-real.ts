/**
 * 「人确实在车上」判定（src/components/nav/riding-real.ts，★ 2026-11-05 新增）
 *
 * ── 它解决什么（一次语义变更留下的坑）────────────────────────────────────
 *   2026-11-05 起，`riding` 的语义从「**人已在车上**」变成「**车到了**」：
 *   车停靠用户上车站即切 riding（负责人裁决），而用户此刻可能还在 50 米外跑。
 *   ⇒ 任何「进入 riding 就当成已上车」的判据都**不再成立**。
 *
 * ── 为什么必须抽成一个函数（两处判据共用同一份证据）────────────────────
 *   赶车标签的可见性由**两个**判据决定，它们必须同进同退：
 *     ① `showTag`   —— 标签是否渲染（`NavDetailBody`，值来自 `NavShell` 的锁存）；
 *     ② `infoMode`  —— 信息行是「上车前单行」还是「上车后两行」。
 *   ⚠️ **只改 ① 是错的**（本批真实踩过）：`infoMode` 里 `riding` 是**无条件优先**的，
 *   而赶车标签住在 `pre` 分支里 ⇒ 车到站那一帧即使锁存没置位，`infoMode` 已变 `post`，
 *   **标签照样消失**，整行还会换成「下一站 X / 还有 n 站下车 · 约 x 分」。
 *   对一个还在跑的人是**双重错误**：既拿走了「来不来得及」，又提前宣告「你在车上」。
 *   ⇒ 两处都调本函数、**同一帧、同一份证据**；判据只在这里定义一次（另有单测直接 import）。
 *
 * ── 判据表（唯一，不接受第二种解释）──────────────────────────────────────
 *   | 进入方式   | `hasPosEvidence` | `ridingReal` | 含义 |
 *   |---|---|---|---|
 *   | `station`  | false | **false** | 车到了、人在跑 ⇒ 标签**保留**、信息行仍是上车前 |
 *   | `station`  | true  | true        | 人随车移动，位置证据已成立 ⇒ 可以隐藏 |
 *   | `position` | —     | true        | 进入判据本身就是位置证据（r2 / 跟车斜率） |
 *   | `manual`   | —     | true        | 用户本人点「我已上车」，视同证据充分 |
 *   | `null`     | —     | true        | **防御**：`riding` 却没有进入方式属不一致态，退回旧行为（隐藏） |
 *   | 非 riding  | —     | false       | — |
 *
 * ── ⚠️ 已知缺口（team-lead 2026-11-05 裁决）─────────────────────────────
 *   `station` 进入且 `hasPosEvidence` **永远不翻真**时（用户没上这班车、车开走了）：
 *     · `riding` 会一直为真、`ridingReal` 一直为假 ⇒ **赶车标签一直显示「小跑能赶上」**；
 *     · 这是一条**滞留缺陷**。
 *   ✅ **本批已用物理信号兜底**：见下方 `gaveUpBusOf`（车已驶离上车站 > 120m ⇒ 认定没赶上
 *     ⇒ 调用方解除锁存）。**仍未做**：任何"没赶上"的提示文案/UI（新概念，属设计侧判断）。
 *   ⛔ **不要**改用时间阈值兜（会误伤"慢慢走上车"的真实用户）。
 */
import type { BoardEntry, RidePhase } from "./useRideTracking";

export interface RidingRealInput {
  /** 乘车相位（`off | boarding | riding | done`） */
  phase: RidePhase | null | undefined;
  /** 本次 riding 的进入方式（`null` = 不在 riding / 未标注） */
  entry: BoardEntry | null | undefined;
  /** 「人在车上」的位置证据是否已成立（可在 `entry === "station"` 之后才翻真） */
  posEvidence: boolean;
}

/**
 * 「人确实在车上」—— 决定**能否隐藏赶车标签 / 能否切到上车后布局**。
 * 纯函数、无副作用、不读时钟；两处调用点（`NavShell` 锁存 / `NavDetailBody.infoMode`）共用。
 */
export function ridingRealOf(input: RidingRealInput): boolean {
  if (input.phase !== "riding") return false;
  /**
   * 进入方式缺失（`null` / `undefined`）而 phase 已是 riding —— **不一致态**，正常不会出现
   * （进入 riding 与写入进入方式在同一次 `switchToRiding` 回调里批处理）。
   *
   * ── ★ 取向（team-lead 2026-11-05 认可并要求写明）───────────────────────
   *   不一致态**一律视为「人在车上」**（返回 true）：
   *   > 宁可回到旧行为（**可能提前隐藏**），也不要制造**永久滞留** ——
   *   > 前者是**已知旧缺陷**，后者是**新引入且更难发现**的。
   *
   *   也就是说：将来若有某条进入路径**漏写**进入方式，后果是**静默退化成旧行为**
   *   （标签按 U2 老逻辑隐藏），而不是静默变成"标签永远显示「小跑能赶上」"。
   *   两种静默失败里选可观测、可回归的那一个 —— 这是本判据唯一的取舍依据，
   *   **不要为了"更准确"改成返回 false**（那会把漏写变成无人能发现的滞留）。
   */
  if (input.entry === null || input.entry === undefined) return true;
  /** 只有「车到站即切」这一种进入方式**没有**位置证据；其余两种进入时证据已成立 */
  if (input.entry === "station") return input.posEvidence === true;
  return true;
}

/**
 * ★ 与 `RideTrackView` 的**唯一字段名耦合点**（两处调用点都调本函数，不各自读字段）。
 *
 * ── 为什么要有这一层（而不是在调用点直接写 `t.enteredVia`）────────────────
 *   本批已经因为「同一份证据在两处各自演化」出过事（只改锁存没改 `infoMode`）。
 *   单一读取点让「两处共用同一份证据」在**结构上**成立，而不是靠约定；
 *   将来 `RideTrackView` 再改字段名，也只改这里一行。
 */
export interface RideLatchSource {
  phase: RidePhase;
  /** 本次 riding 的进入方式（`null` = 不在 riding） */
  enteredVia: BoardEntry | null;
  /** 「人在车上」的位置证据是否已成立 */
  boardedByPosition: boolean;
}

/** 从追踪视图读判定所需的两个量（**唯一**读字段的地方） */
export function ridingRealOfRide(t: RideLatchSource | null | undefined): boolean {
  if (!t) return false;
  return ridingRealOf({
    phase: t.phase,
    entry: t.enteredVia,
    posEvidence: t.boardedByPosition,
  });
}

/* ══════════════════════════════════════════════════════════════════════
   ★ 2026-11-05：「这班没赶上」兜底（治上面那个滞留缺口）
   ─────────────────────────────────────────────────────────────────────
   缺口回顾：`enteredVia === "station"` 切进 riding 后，若用户**其实没上车**
   （车来了没挤上），`boardedByPosition` 永不翻真 ⇒ `ridingReal` 恒假
   ⇒ 赶车标签会一直显示「小跑能赶上」（滞留）。
   ⇒ 用**物理信号**判定：位置证据一直不来 **且车已明显驶离上车站** = 用户没上这班车。
   **不用时间阈值**（会误伤"慢慢走上车"的真实用户）。
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 「参照车已驶离上车站」的距离阈值（米）。
 *
 * ── 为什么是 120（推导，不是经验值）────────────────────────────────────
 *   · `boardedByPosition` 成立需要「沿线位移 `alongM ≥ 35m` + 5 帧窗口」
 *     ⇒ **「车已走 35m 但证据还没到」是正常采样滞后**，阈值必须**显著大于 35m**，
 *       否则会把"正在上车的人"误判成"没赶上"；
 *   · `FOLLOW_MAX_D_M = 120`（`plate-lock.ts`：「人车贴同一位置」的位置确认门）
 *     是同量级参考点 —— 超过它，车与站台已不在"同一位置"的语义范围内。
 *   ⇒ 取 120m：既远离 35m 的采样滞后区，又与既有门限同量级，不新增孤立数字。
 *
 * ⚠️ 若将来有人要给「没赶上」加提示文案/更精细判据，**先重新推导本值**，
 *    不要因为它"看起来够用"直接沿用。
 */
export const GAVE_UP_BUS_DIST_M = 120;

export interface GaveUpInput {
  /** 本次 riding 的进入方式（`null` = 不在 riding） */
  entry: BoardEntry | null | undefined;
  /** 「人在车上」的位置证据是否已成立 */
  posEvidence: boolean;
  /** 参照车距上车站的直线距离（米）；`null` = 无牌 riding（多车歧义）或还没算过 */
  refVehDistM: number | null | undefined;
}

/**
 * 「这班车没赶上」—— 只有在**车到站切入**且**证据始终未到**且**车已驶离**时才成立。
 *
 * ⚠️ `refVehDistM === null` 有两种成因（无牌 riding 的参照车未知 / 还没算过），
 *   **两种都当"兜底判据不可用"**（返回 false），**不要当 0 或 Infinity**：
 *   · 当 0 ⇒ 永远"没走远" ⇒ 缺口不兜（但至少不误判）；
 *   · 当 Infinity ⇒ 一帧就判"没赶上" ⇒ 把正常上车的人踢出乘车态（严重得多）。
 */
export function gaveUpBusOf(input: GaveUpInput): boolean {
  if (input.entry !== "station") return false;
  if (input.posEvidence) return false;
  const d = input.refVehDistM;
  if (d === null || d === undefined) return false;
  if (!Number.isFinite(d)) return false;
  return d > GAVE_UP_BUS_DIST_M;
}

/** 从追踪视图读兜底判据（**唯一**读字段的地方，与 `ridingRealOfRide` 并列） */
export interface GaveUpSource {
  enteredVia: BoardEntry | null;
  boardedByPosition: boolean;
  refVehDistToBoardM: number | null;
}
export function gaveUpBusOfRide(t: GaveUpSource | null | undefined): boolean {
  if (!t) return false;
  return gaveUpBusOf({
    entry: t.enteredVia,
    posEvidence: t.boardedByPosition,
    refVehDistM: t.refVehDistToBoardM,
  });
}
