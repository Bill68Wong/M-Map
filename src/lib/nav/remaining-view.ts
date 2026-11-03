/**
 * 导航「剩余时间」视图派生（src/lib/nav/remaining-view.ts，★ 2026-11-03 新增）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 *   用户原话：「点击刷新按钮后，还有几站、还有几分钟、总时长、到达目的地的时刻，
 *   这些信息都需要刷新；总时长不是从当前时间重新走一遍，而是减掉已经花的时间和
 *   已经经过的路程」。
 *
 *   改造前 `card.totalMin` / `card.arriveAt` 是**服务端规划时的一次性快照**
 *   （`src/lib/recommend/model.ts:817/878/879`），规划完成后**永不重算** ——
 *   于是「总时长」永远停在规划那一刻，「预计到达」是个死时刻（时间在走，它不动）。
 *
 *   本模块提供**纯函数**派生值：由「绝对到达时刻」与「当前时刻」现算剩余，
 *   因此刷新（或任何一次渲染）都能拿到自洽的数字。
 *   ⚠️ 服务端还会下发一份**位置感知**的更精确值（`/api/nav/remaining`），
 *   那边有优先权；本模块是**没有服务端结果时的兜底**（也是首屏立即可用的值）。
 *
 * ── 两条语义红线（**刻意不同，不要"统一"**）──────────────────────────
 *   ① 「全程剩余」（顶部 `.rc-total`）：**clamp 到 0**，归零后切文案「即将到达」。
 *      **绝不允许**出现「-3 分」这类负值 —— 用户已经到站/超时了还显示负数，
 *      是"沉默算错"，比不给数字更糟。
 *   ② 「还有几分钟」（距下车站，`.nav-note__sub`）：**保留 `Math.max(1, …)` 地板**。
 *      因为它回答的是「我到**下车**还有多久」，写「还有 0 分钟」读起来像"已经到站"，
 *      会与到站提醒（`alarm === "now"` 的「已到站」）语义打架 —— 后者才是到站信号。
 *   ⇒ 两个数字**不合并**：① = 全程还剩多久，② = 到下车站还有多久，问的不是同一件事。
 *
 * ── 渲染纪律 ──────────────────────────────────────────────────────────
 *   **禁止在渲染期直接调用 `Date.now()`**（渲染必须纯，见 `useCooldown.ts:15`）。
 *   调用方把 `nowMs` 作为参数传入，且 `nowMs` 只由既有 15s `etaTick` 驱动刷新
 *   （`NavDetailBody` 内已有该定时器，**不要**新增第二个）。
 */

const MIN_MS = 60_000;

/** 全程剩余显示「即将到达」的阈值：四舍五入后为 0 分钟（含负值/超时） */
const ARRIVED_BELOW_MIN = 0.5;

export interface RemainView {
  /** 全程剩余分钟（**未取整、已 clamp ≥0**；永不为负） */
  totalMin: number;
  /** 到达时刻（绝对 ms，**原样透传** —— 绝对量不随渲染变化） */
  arriveAtMs: number;
  /** 是否已过预计到达时刻（`nowMs > arriveAtMs`） */
  overdue: boolean;
  /** 全程剩余是否已归零（取整后 0 分钟）⇒ UI 应切「即将到达」文案 */
  arrived: boolean;
}

/**
 * 由「绝对到达时刻 + 当前时刻」派生剩余视图。
 *
 * @param arriveAtMs 预计到达时刻（绝对毫秒，`card.arriveAt`）
 * @param nowMs 当前时刻（毫秒，**由调用方传入**，禁止在渲染期取 `Date.now()`）
 */
export function remainOf(arriveAtMs: number, nowMs: number): RemainView {
  // 非法输入（NaN / 非有限）⇒ 视为「未知」，用 0 表示不显示，不抛错、不显示 NaN
  if (!Number.isFinite(arriveAtMs) || !Number.isFinite(nowMs)) {
    return { totalMin: 0, arriveAtMs, overdue: false, arrived: true };
  }
  const diffMs = arriveAtMs - nowMs;
  const totalMin = Math.max(0, diffMs / MIN_MS);
  return {
    totalMin,
    arriveAtMs,
    overdue: diffMs < 0,
    arrived: totalMin < ARRIVED_BELOW_MIN,
  };
}

/** 全程剩余分钟（整数，可直接上屏；已 clamp ≥0） */
export function remainTotalMinOf(v: RemainView): number {
  return Math.max(0, Math.round(v.totalMin));
}

/**
 * ★ 2026-11-03（需求 1b）：**有服务端重算结果时**的剩余视图。
 *
 * ── 与 `remainOf` 的分工（两个入口，别混）────────────────────────────
 *   · `remainOf(arriveAt, nowMs)`        —— **无服务端结果**时的兜底（首帧 / 请求失败 / 非乘车段）。
 *   · `remainServedOf({...})`            —— **有服务端结果**时用，总时长以 `remainingMin` 为基准。
 *
 * ── 为什么总时长以 `remainingMin` 为基准，而不是 `arriveAt − now` ────────
 *   按 team-lead 冻结的契约：`remainingMin`（相对）负责**总时长显示**，
 *   `arriveAt`（绝对）负责**到达时刻显示**。两条独立，互不反算。
 *
 * ── 为什么必须再扣 `staleSec`（这是本函数存在的唯一理由）────────────────
 *   服务端一定带**进程内微缓存**（`route.ts:150-161`）：命中时 `recomputedAt` 保持原值、
 *   `serverNowMs` 取当前 ⇒ `serverNowMs − recomputedAt` 就是「这份 `remainingMin` 已经过时了多久」。
 *   **不扣它，倒计时会比真实值偏大几秒** —— 正是 `/api/station/eta` 那个
 *   「相对快照命中缓存时整体偏大」的旧坑（`station/eta/route.ts:118` 注释）。
 *
 *   本函数把「偏大」的两部分都扣掉：
 *     ① `staleSec`            —— 数据生成 → 响应发出的缓存陈旧；
 *     ② `nowMs − serverNowMs` —— 响应发出 → 现在的流逝（`nowMs` 是**服务端时间轴**的当前值）。
 *   两项都只用**时间差**，不要求设备时钟绝对准确 ⇒ 比 `arriveAt − Date.now()` 更鲁棒。
 */
export interface ServedRemainInput {
  /** 服务端算出的剩余分钟（相对基准） */
  remainingMin: number;
  /** 服务端响应生成时刻（服务端 `Date.now()`，ms） */
  serverNowMs: number;
  /** 缓存陈旧秒 = `(serverNowMs − recomputedAt) / 1000`；非缓存命中时为 0 */
  staleSec: number;
  /** 服务端绝对到达时刻（ms）—— **只用于到达时刻显示**，不参与总时长计算 */
  arriveAtMs: number;
  /** 当前时刻（**服务端时间轴**：`Date.now() + clockOffsetMs`；由调用方在 useMemo 内取） */
  nowMs: number;
}

export function remainServedOf(input: ServedRemainInput): RemainView {
  const { remainingMin, serverNowMs, staleSec, arriveAtMs, nowMs } = input;
  if (!Number.isFinite(remainingMin) || !Number.isFinite(serverNowMs) || !Number.isFinite(nowMs)) {
    return { totalMin: 0, arriveAtMs, overdue: false, arrived: true };
  }
  // ① 扣缓存陈旧  ② 扣响应发出后的流逝（两者都是**时间差**，不依赖设备时钟绝对值）
  const elapsedSec = Math.max(0, (nowMs - serverNowMs) / 1000);
  const remainSec = remainingMin * 60 - Math.max(0, staleSec) - elapsedSec;
  const totalMin = Math.max(0, remainSec / 60);
  return {
    totalMin,
    arriveAtMs,
    /** overdue 以**到达时刻**为准（它与总时长是两条独立契约，任一归零都算"已到"） */
    overdue: nowMs > arriveAtMs || remainSec < 0,
    arrived: totalMin < ARRIVED_BELOW_MIN,
  };
}

/** 全程剩余归零时的替代文案（替代「0 分」，避免与到站提醒混淆） */
export const REMAIN_ARRIVED_TEXT = "即将到达";

/** 到达时刻已过时的后缀文案（替代裸露的过去时刻） */
export const ARRIVE_OVERDUE_TEXT = "预计已过";
