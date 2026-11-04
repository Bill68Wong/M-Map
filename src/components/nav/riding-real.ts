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
 * ── ⚠️ 已知缺口（team-lead 2026-11-05 裁决：**接受并记录，不实现阈值**）────
 *   `station` 进入且 `hasPosEvidence` **永远不翻真**时（用户没上这班车、车开走了）：
 *     · `riding` 会一直为真、`ridingReal` 一直为假 ⇒ **赶车标签一直显示「小跑能赶上」**；
 *     · 这是一条**滞留缺陷**，本批**不修**。
 *   为什么不用时间阈值兜：任何"N 秒后强制认定"在用户真的慢慢上车时会误判
 *     （明明上了车，N 秒后标签突然说没上），代价大于收益。
 *   正确方向 = 用**已有物理信号**：车已驶离上车站超过一定距离（复用现有常量，不新造）
 *     或安全网判定「疑似还没上车」⇒ 才认定为"人不在车上"。
 *   ⇒ 需要「车离上车站多远」这个量，等实现方提供后再做（下一批）。
 *   **不要**在此处擅自加 `setTimeout` / 秒数常量。
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
   * 处置：退回**旧行为（视为已上车 ⇒ 隐藏）**。理由：若选"不隐藏"，一旦某条进入路径漏写
   * 进入方式，标签会永久滞留（比缺陷 #2 更难发现）；而选"隐藏"只是回到 U2 已验证的行为。
   */
  if (input.entry === null || input.entry === undefined) return true;
  /** 只有「车到站即切」这一种进入方式**没有**位置证据；其余两种进入时证据已成立 */
  if (input.entry === "station") return input.posEvidence === true;
  return true;
}

/**
 * ★ 与 `RideTrackView` 的**唯一字段名耦合点**（两处调用点都调本函数，不各自读字段）。
 *
 * ── 为什么要有这一层（而不是在调用点直接写 `ride.xxx`）────────────────────
 *   ① **字段名正在变**：实现方先落地了 `boardEntry` / `hasPosEvidence`，
 *      随后按 team-lead 口径改名为 `enteredVia` / `boardedByPosition`（改名在途）。
 *      若在两个调用点各写一次字段名，改名要改两处、漏一处就编译不过或读到 `undefined`。
 *      收成这一处后，改名只需改这里一行。
 *   ② **踩过的坑**：本批已经因为「同一份证据在两处各自演化」出过事（只改锁存没改 `infoMode`）。
 *      单一读取点让「两处共用同一份证据」在结构上成立，而不是靠约定。
 *
 * ⚠️ 改名落地后应收窄为最终名（届时删除另一分支）。**过渡期两个名字都收**，
 *   是因为改名 WIP 尚未提交，此刻写死任一侧都会让其中一种状态编译失败。
 */
export interface RideLatchSource {
  phase: RidePhase;
  /** 改名后的名字（team-lead 2026-11-05 口径） */
  enteredVia?: BoardEntry | null;
  /** 改名前的名字（实现方初版） */
  boardEntry?: BoardEntry | null;
  /** 改名后的名字（team-lead 2026-11-05 口径） */
  boardedByPosition?: boolean;
  /** 改名前的名字（实现方初版） */
  hasPosEvidence?: boolean;
}

/** 从追踪视图读判定所需的两个量（**唯一**读字段的地方） */
export function ridingRealOfRide(t: RideLatchSource | null | undefined): boolean {
  if (!t) return false;
  const entry = t.enteredVia ?? t.boardEntry ?? null;
  const posEvidence = t.boardedByPosition ?? t.hasPosEvidence ?? false;
  return ridingRealOf({ phase: t.phase, entry, posEvidence });
}
