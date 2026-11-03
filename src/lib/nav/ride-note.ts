/**
 * 乘车态「没有进度」的提示判定（src/lib/nav/ride-note.ts，2026-11-03 新增）
 *
 * ── 这个文件解决什么 ────────────────────────────────────────────────────
 *   无牌巴士（锁不到车牌）在两种结构性缺失下拿不到 `prog`，而 `prog` 同时驱动
 *   「到站横幅 + 震动」与「自动下车判定」两件事 ⇒ 两者一起静默失效，
 *   用户会在**没有任何提示**的情况下坐过站。本模块只负责一件事：
 *   **把「为什么没有进度」「你该自己做什么」变成一句用户看得懂的文案**，
 *   并把同一组输入派生为观测钩子取值，供 QA 量测真实触发率。
 *
 * ── 两类缺失（都是结构性、不会自愈）────────────────────────────────────
 *   · 无几何：`ensureLadder` 在 `leg.colored.length < 2` 时裸 `return`
 *     （`useRideTracking.ts` 的阶梯建立处）⇒ 阶梯永远是 null ⇒ GPS 推进不产出进度。
 *   · 无站序：本段站条只有 1 站 ⇒ 引擎侧 `lastIdx < 1` 直接判不成立
 *     （`alight-detect.ts` 的 `lastIdx < 1` 早退）⇒ 用户点与到站提醒一起消失。
 *
 * ── 为什么「有牌」必须返回 null（本模块最重要的约束）────────────────────
 *   有牌时存在**另一条**独立进度源（车辆帧的站序投影）⇒ 下一帧（12s）就会自愈，
 *   属于抖动而非缺失。若在这里也报「看不到进度」，用户会看到文案一闪即失，
 *   比不显示更糟。⇒ `hasPlate === true` 一律 null。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 *   · **零 IO / 零 DOM / 零 React**：纯函数，node 可直接 import 做单测；
 *   · 判定逻辑只此一处，组件里只做「取输入 → 调它 → 用返回值」；
 *   · 文案经 `.verify/check-ui-copy.mjs` 门禁（禁开发语言泄漏）。
 */

/**
 * 无几何（`colored.length < 2`）⇒ 拿不到沿线里程轴，任何位置推算都不可能。
 * 文案必须给出**用户可执行的下一步**：「留意站牌」+「自己点我已下车」。
 */
export const NOTE_NO_GEOMETRY =
  "这段路暂时没有可用轨迹，看不出车开到哪 · 请留意站牌播报，到站后自己点「我已下车」";

/**
 * 无站序（本段站条 < 2 站）⇒ 没有「第几站」可比对，用户点与到站提醒都不成立。
 * 与无几何的区别：轨迹是有的（用户点画得出来），但**站**对不上。
 */
export const NOTE_NO_STOPS =
  "这段路查不到中途站，没法自动报站 · 请留意沿途站名，到站后自己点「我已下车」";

/**
 * 阶梯状态（**已对外承诺的观测契约**，QA 浏览器断言直接读
 * `body[data-ladder-state]`，不得改名/改取值集）。
 *   · `built`       本站里程阶梯已建立（正常态）；
 *   · `no-geometry` 几何不足（`colored.length < 2`）⇒ 建不起来；
 *   · `no-stops`    站序不足（本段站条 < 2 站）⇒ 建起来也判不了；
 *   · `idle`        非乘车态（未开始 / 候车 / 已到达 / 已销毁）。
 */
export type LadderState = "built" | "no-geometry" | "no-stops" | "idle";

export interface RideNoteInput {
  /** 当前乘车阶段（`off | boarding | riding | done`）；只有 `riding` 才可能出文案 */
  phase: string;
  /**
   * 是否已锁定车牌。**true ⇒ 一律不提示**：有牌时车辆帧是另一条独立进度源，
   * 下一帧（12s）自愈，属抖动（见文件头注）。
   */
  hasPlate: boolean;
  /** 当前腿几何点数（`legs[legIndex].colored.length`）；`< 2` 无法构成里程轴 */
  coloredLen: number;
  /** 当前腿站条站数（`strips[legIndex].stops.length`）；`< 2` 无法比对站序 */
  stopsLen: number;
}

/**
 * 乘车态提示判定（纯函数）。**分支顺序即优先级**，5 条分支穷尽全部输入：
 *
 * | # | 条件 | 返回 |
 * |---|------|------|
 * | 1 | `phase !== "riding"` | `null`（非乘车态不提示） |
 * | 2 | `hasPlate` | `null`（有牌自愈，绝不误报） |
 * | 3 | `coloredLen < 2` | `NOTE_NO_GEOMETRY` |
 * | 4 | `stopsLen < 2` | `NOTE_NO_STOPS` |
 * | 5 | 其余 | `null` |
 *
 * ⚠️ **已知未覆盖的残留**（刻意不在此处加分支，避免与规格冻结的 5 条漂移）：
 *   几何 ≥2 点、站条 ≥2 站，但站码在站图上解析失败导致阶梯稀疏/为空时，
 *   同样产不出进度而这里不会提示。它无法由「长度」判据区分（要问站图解析结果），
 *   属于数据侧成因，需另立判据；本批只覆盖两个**纯长度可判**的结构性缺失。
 */
export function rideNoteOf(input: RideNoteInput): string | null {
  if (input.phase !== "riding") return null;
  if (input.hasPlate) return null;
  if (input.coloredLen < 2) return NOTE_NO_GEOMETRY;
  if (input.stopsLen < 2) return NOTE_NO_STOPS;
  return null;
}

/**
 * 观测钩子取值判定（纯函数）。
 *
 * 与 `rideNoteOf` **同源同输入**（只是把「该说什么」换成「处在哪一档」），
 * 因此文案与量测不可能各说一套。注意二者的**仅有一处刻意差异**：
 * `ladderStateOf` 不因 `hasPlate` 归 `idle` —— 量测要的是「阶梯到底建没建起来」
 * （有牌也可能 `no-geometry`，那同样是可观测的结构性问题），
 * 而文案要的是「用户此刻需不需要自己盯」。
 */
export function ladderStateOf(input: {
  phase: string;
  coloredLen: number;
  stopsLen: number;
}): LadderState {
  if (input.phase !== "riding") return "idle";
  if (input.coloredLen < 2) return "no-geometry";
  if (input.stopsLen < 2) return "no-stops";
  return "built";
}
