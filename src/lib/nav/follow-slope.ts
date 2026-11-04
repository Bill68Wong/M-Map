/**
 * 跟车判据 · 相对距离斜率（src/lib/nav/follow-slope.ts，2026-11-04 新增 · P0 I-3）
 *
 * ── 解决什么 ────────────────────────────────────────────────────────────
 *   旧判据（`boarding-detect.ts` 的 `r2Of`）量的是「回看窗口内**用户自己**的平均位移速度」：
 *   用户上车后常常**静止**（站着等关门 / 挤在门口 / 塞车），分子（位移）不增、分母（窗口
 *   时长）照增 ⇒ 平均速度被系统性稀释到速度门以下 ⇒ 判不出「已上车」⇒ 锁牌窗口早就关了。
 *
 *   本模块改用**相对量** `d(t) = |u(t) − v(t)|`（用户与参照车在**同一条折线**上的沿线里程差）：
 *   ```
 *   人在站台、车已开走    d 单调增大（≈车速 3.3 m/s 量级）  ⇒ 未上车
 *   人已上车、随车走      d 基本不变（斜率≈0）              ⇒ 已上车
 *   车停靠/塞车不动       d 不变，且用户自己也不动          ⇒ 不可分，不判
 *   ```
 *   关键：分母换成「**车自己的位移**」而不是窗口时长 ⇒ 用户静止**不会**稀释判据。
 *   采样配对（含「把 `v(t)` 内插到定位时间戳」）在 `follow-frames.ts`，本文件只做统计与判定。
 *
 * ── 六条门槛（缺一条就不判，宁可晚判不误判）─────────────────────────────
 *   G-a 同车     样本必须来自同一车牌（末尾同车牌的一段，换参照车即作废）
 *   G-b 精度     `accuracy > FOLLOW_MAX_ACC_M` 的帧**不参与**（精度不足如实拒绝）
 *   G-f 车在动   窗内车速 ≥ `FOLLOW_MIN_VEH_MPS`（车停着时「d 不变」是平凡解）
 *   G-c 同处     `d_now ≤ FOLLOW_MAX_D_M` —— 人与车当前必须**贴在同一位置**
 *   G-d 真在动   窗内用户沿线**前移** ≥ `FOLLOW_MIN_ALONG_M`（带符号，反向不算）
 *   G-e 不拉开   `|d 的斜率| ≤ FOLLOW_MAX_SLOPE_MPS`
 *
 * ── ⚠️ 不可逾越的物理限制（不要试图绕过）──────────────────────────────
 *   车**停靠在用户所在站台**时，「人在站台等车」与「人已在车上」在信号上不可分
 *   （`d≈0` 且都不动）。要区分需 NFC / 蓝牙 / 加速度计动作识别 / 车内气压，本项目都没有。
 *   ⇒ 「车已驶离上车站」是唯一能把二者分开的事件（由 `plate-lock.ts` 负责），
 *     本文件只管「贴不贴、拉不拉开」。
 */
import type { FollowFrame } from "./follow-frames";

/* ══════════ 参数（唯一来源；数值依据见下）══════════ */
/**
 * 最小样本帧数 = **5**（硬下限，不得下调）。
 * 3~4 帧时斜率标准误 > 1.9 m/s，与「车速 3.33」同量级 ⇒ 会把「车开走」误判成「人跟上了」。
 * 断言见 `scripts/test-boarding-detect.ts` 的 ⑯ 组第 4 条。
 */
export const FOLLOW_MIN_FRAMES = 5;
/** 窗口上限（ms）：只拟合最近 30s。太长会把「上车前的站台期」混进来 */
export const FOLLOW_WINDOW_MS = 30_000;
/** 最多参与拟合的帧数（GPS 1s 一帧时防止窗口内样本过多、单帧权重被摊平） */
export const FOLLOW_MAX_FRAMES = 20;
/**
 * 最小窗长（ms）= 10s。
 * 依据：σ_d ≈ √2 × 10m ≈ 14m（人 / 车两侧各自定位误差独立）；
 *   10s × 3.33 m/s = 33m 的真实位移才足以把 1.2 与 3.3 m/s 分开（SNR ≈ 2.4）。
 *   更短的窗**不是**更灵敏，而是更随机。
 */
export const FOLLOW_MIN_SPAN_MS = 10_000;
/** 精度门（米）：超出的帧不参与（高精度档 σ≈10m；50m 已是 5σ） */
export const FOLLOW_MAX_ACC_M = 50;
/**
 * 斜率上限（m/s）= 1.2。
 * 两侧都不靠边才有意义：
 *   · 已在车上 ⇒ 真实斜率 **恒为 0**（数学期望），误差只来自投影噪声 ⇒ 1.2 ≈ 2.4σ；
 *   · 在站台、车已走 ⇒ 真实斜率 = 车速（12 km/h = 3.33 m/s，起步 10s 内平均也 ≥ 2.5）
 *   ⇒ 1.2 落在两者之间，且离任一侧都有余量。**不要**为迁就某个用例挪这个数。
 */
export const FOLLOW_MAX_SLOPE_MPS = 1.2;
/**
 * 相对距离上限（米）= 120。
 * 这是「人与车贴在同一位置」的门。不能收到 50：DSAT 车辆位置本身有数十秒的采集延迟，
 * 车上用户的 `d` 会恒等于「车速 × 延迟」（20s × 3.3 ≈ 66m）—— 这是**系统偏差不是噪声**，
 * 收太紧会让真实乘车永远判不出。取 120 可容纳 ≤35s 延迟，同时仍短于澳门多数站距。
 */
export const FOLLOW_MAX_D_M = 120;
/**
 * 窗内用户沿线**前移**下限（米）= 35（带符号，反向不算）。
 * 依据：Δu 的噪声 σ ≈ √2 × 10m ≈ 14m ⇒ 35m ≈ 2.5σ，低于此值与噪声不可区分。
 * 这一条挡的是「人站在站台不动、车开走后在下一站停住」⇒ `d` 停在常数、斜率≈0 的
 * 假「跟车」；也顺带把「步行沿线路挪动」排除在外（步行 30s 最多 25~35m）。
 */
export const FOLLOW_MIN_ALONG_M = 35;
/**
 * 窗内**车速**下限（m/s）= 2.0（= 7.2 km/h，沿线路正方向）。
 * 这一条把「相对距离不变」从**平凡解**里救出来：车若停在原地，`d` 当然不变，
 * 但它与「人已上车」不可分（物理限制，见文件头）。只有车**确实在动**时，
 * 「d 不动」才等价于「人跟着车动」。
 */
export const FOLLOW_MIN_VEH_MPS = 2;
/**
 * 多车歧义的里程差下限（米）= 2σ ≈ 20。
 * 两辆候选车的 `|u − v|` 差小于此值时**不锁牌**（分不出是哪辆 ⇒ 不猜），
 * 与既有 `r1Of` 的「多车歧义不触发」同一口径。
 */
export const FOLLOW_AMBIG_M = 20;

export type FollowWhy =
  | "ok"
  | "no-frame"
  | "all-bad"
  | "too-few"
  | "short-span"
  | "veh-still"
  | "far"
  | "not-moved"
  | "growing";

export interface FollowSlope {
  /** 拟合斜率（m/s）；`null` = 未拟合（样本不足 / 退化） */
  slope: number | null;
  /** 参与拟合的帧数（已过 G-a/G-b，且落在窗口内） */
  n: number;
  /** 判据是否成立（= 已上车）。⚠️ `false` **不等于**「未上车」，也可能是「不可判」 */
  ok: boolean;
  /** 末帧相对距离（米） */
  dNow: number | null;
  /** 窗内用户的**带符号**沿线位移（米，正 = 沿线路前进方向） */
  alongM: number | null;
  /** 窗内参照车的沿线速度（m/s，最小二乘；正 = 沿线路前进方向） */
  vehMps: number | null;
  /** 窗内实际时长（ms） */
  spanMs: number;
  plate: string | null;
  /** 未成立的原因（`ok=true` 时为 `ok`） */
  why: FollowWhy;
}

/** 最小二乘斜率（x 秒、y 米）⇒ m/s；退化 ⇒ `null` */
function olsSlope(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  if (!(den > 0)) return null;
  return num / den;
}

/**
 * 相对距离斜率判据（纯函数）：拟合最近一窗 `d(t) = |u − v|` 的斜率，按 G-a~G-f 给结论。
 *
 * @param frames `followFramesOf` 的输出（升序；也接受任意顺序，内部按 ts 排序）
 */
export function followSlopeOf(frames: FollowFrame[]): FollowSlope {
  const none = (why: FollowWhy, n = 0, plate: string | null = null): FollowSlope => ({
    slope: null,
    n,
    ok: false,
    dNow: null,
    alongM: null,
    vehMps: null,
    spanMs: 0,
    plate,
    why,
  });
  if (!frames.length) return none("no-frame");

  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  const last = sorted[sorted.length - 1];
  // G-a：只认末尾这一辆车（中途换参照车 ⇒ 序列不可比）
  const samePlate = sorted.filter((f) => f.plate === last.plate);
  // G-b：精度门（「精度不足如实拒绝」—— 不是把数值拿来用，而是整帧丢掉）
  const usable = samePlate.filter(
    (f) =>
      Number.isFinite(f.ts) &&
      Number.isFinite(f.u) &&
      Number.isFinite(f.v) &&
      !(Number.isFinite(f.accuracy) && f.accuracy > FOLLOW_MAX_ACC_M),
  );
  if (!usable.length) return none("all-bad", 0, last.plate);

  // 窗口：末帧往前 30s
  const win = usable.filter((f) => last.ts - f.ts <= FOLLOW_WINDOW_MS);
  if (win.length < FOLLOW_MIN_FRAMES) return none("too-few", win.length, last.plate);

  const spanMs = win[win.length - 1].ts - win[0].ts;
  if (spanMs < FOLLOW_MIN_SPAN_MS) return none("short-span", win.length, last.plate);

  const t0 = win[0].ts;
  const xs = win.map((f) => (f.ts - t0) / 1000);
  const ds = win.map((f) => Math.abs(f.u - f.v));
  const slope = olsSlope(xs, ds);
  const vehMps = olsSlope(
    xs,
    win.map((f) => f.v),
  );
  const dNow = ds[ds.length - 1];
  const alongM = win[win.length - 1].u - win[0].u;
  const base = { slope, n: win.length, dNow, alongM, vehMps, spanMs, plate: last.plate };
  if (slope == null) return { ...base, ok: false, why: "short-span" };

  // G-f：车必须在**动**（否则「d 不变」是平凡解，与「人已上车」不可分）
  if (!(vehMps != null && vehMps >= FOLLOW_MIN_VEH_MPS)) return { ...base, ok: false, why: "veh-still" };
  // G-c：人与车必须贴在同一位置（否则「d 不增长」可能只是车停在远处）
  if (!(dNow <= FOLLOW_MAX_D_M)) return { ...base, ok: false, why: "far" };
  // G-d：用户自己必须真的沿线路前移（挡「站台静止 + 车在下一站停住」的假跟车）
  if (!(alongM >= FOLLOW_MIN_ALONG_M)) return { ...base, ok: false, why: "not-moved" };
  // G-e：相对距离不得被拉开（取绝对值 —— 「稳定」是双侧要求：快速靠拢同样是相对位移）
  if (!(Math.abs(slope) <= FOLLOW_MAX_SLOPE_MPS)) return { ...base, ok: false, why: "growing" };
  return { ...base, ok: true, why: "ok" };
}
