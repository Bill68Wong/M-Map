/**
 * 车辆匹配 · 里程轴工具（src/lib/nav/match-mile.ts，v3.7.0 · ADR C10）
 *
 * 一个标量统一两侧：**沿线里程 `d`（米，原点 = 本段上车站）**。
 *   · 用户 `dU`  —— `advanceLrt` 的 `distNow`（已过可信门 / 迟滞 / 单帧最多推进 1 站）；
 *   · 车辆 `dV`  —— 三档来源，**同一根轴**：
 *       ① `progress.segFrom/segTo/p` 在站里程碑上插值（行驶车，最准）；
 *       ② `atStation` 的站里程（停靠 / 总站车）；
 *       ③ `progress` 缺失时把车辆坐标投影到**同一条 `colored`** 上（可信门 60m）。
 *     ③ 与用户的 `dU` 用同一条折线、同一个投影函数 ⇒ 同源同轴，不是「跨轴换算」。
 * 前提已验证：`route_station_mileage` 的 **111 个线路方向全部严格单调**（非单调间隙 0 个）
 * ⇒ 里程轴良定义，按里程比对可行。
 *
 * ── 环线（55/111 个方向 = 49.5%）的三道防护 ──────────────────────────
 *   ① 站里程碑由 `buildLrtLadder` 生成 —— 已强制单调、剔除乱序站；
 *   ② 区间对只认「**同圈内递增**」（`ti > fi`），跨圈对直接跳过 ⇒ 不跨圈重复计数；
 *   ③ 相邻采纳帧的里程跳变 > 车速上限 + 余量 ⇒ 判「换圈 / 投影跳变」，
 *      该帧**既不加分也不惩罚**（重置基线）。
 *      ⚠️ 与 `track.ts` 的 `monotonicCut`：**常量同源，判据更严（双向）** ——
 *      `monotonicCut` 只判上行（`upM`），这里用 `Math.abs(ΔdM)` ⇒ 前后跳都拦。
 *      两者**不可互换**：那边是为了画线不倒退，这边是为了不把换圈当位移。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   纯函数、client-safe（不 import `pg`）；「算不出就返回 `null`」，由上层决定降级，**绝不猜**。
 */

import { cumDistM, nearestOnPath, type LL } from "./route-overview";
import { TRAVELED_MAX_SPEED_MPS, mainOf, perpDistM, type TrackVehicle } from "./track";
import type { LrtLadder } from "./lrt-progress";
import {
  MATCH_ALIGN_TOL_MS,
  MATCH_PROJ_TRUST_M,
  MATCH_STEP_SLACK_M,
  type MatchFrame,
  type MileSample,
} from "./match-params";

/** 采样是否可用：时刻在窗口内（不超前于 `nowMs`）、里程有限 */
export function inWindow(s: MileSample, nowMs: number, winMs: number): boolean {
  return Number.isFinite(s.ts) && s.ts <= nowMs && nowMs - s.ts <= winMs && s.dM != null && Number.isFinite(s.dM);
}

/** 站主码在本段站序中的全部下标（环线闭合站会出现两次 ⇒ 必须返回数组，不能只给首个） */
export function indicesOf(mains: string[], code: string): number[] {
  const main = mainOf(code);
  const out: number[] = [];
  for (let i = 0; i < mains.length; i++) if (mains[i] === main) out.push(i);
  return out;
}

/**
 * 车辆沿线里程（米）。算不出 ⇒ `null`（该车不进池，**绝不**用坐标乱塞）。
 * 三档来源（同一根轴，见文件头）：
 *   ① 区间插值 `a + p × (b − a)`；环线只接受 `ti > fi` 的区间对（跨圈对一律不取）；
 *   ② `atStation` 的站里程（停靠 / 总站车 —— 覆盖率约 4% 的车正是靠这档进池）；
 *   ③ `progress` 与 `atStation` 都没有时：把坐标投影到**同一条 `colored`**（可信门 60m）。
 *      ⚠️ ③ 与用户的 `dU` 同折线同函数 ⇒ 同源同轴；但**必须守住 60m 门**，
 *         否则远处的车会被投影「硬塞」进候选池，`margin` 一拉开就是误锁。
 */
/**
 * 车辆沿线里程（米）。算不出 ⇒ `null`（该车不进池，**绝不**用坐标乱塞）。
 * 三档来源（同一根轴，见文件头）：
 *   ① 区间插值 `a + p × (b − a)`；环线只接受 `ti > fi` 的区间对（跨圈对一律不取）；
 *   ② `atStation` 的站里程（停靠 / 总站车 —— 覆盖率约 4% 的车正是靠这档进池）；
 *   ③ 前两档都拿不到时：把坐标投影到**同一条 `colored`**（可信门 60m）。
 *      ⚠️ ③ 与用户的 `dU` 同折线同函数 ⇒ 同源同轴；但**必须守住 60m 门**，
 *         否则远处的车会被投影「硬塞」进候选池，`margin` 一拉开就是误锁。
 *
 * 🚫 **禁止给 `colored` 加默认值 `= []`**（它是必填的，这是刻意的）。
 *
 *   为什么是禁令而不是"历史上的坑"：加回默认值后，**漏传会变成静默降级** ——
 *   第 ③ 档（同轴投影兜底）关闭、覆盖率悄悄掉一半，而 **tsc 全绿、lint 全绿**。
 *   实测（变异 M1c：加回 `= []` + 去掉算法侧传参）：`tsc` 无任何报错，只有行为用例能发现。
 *   ⇒ 这条防线**完全依赖「必填参数」这一个编译器特性**。加个默认值就无声蒸发。
 *
 *   历史事故（说明代价，不是"已经修好了"）：曾经写成 `colored: LL[] = []` ⇒ 算法侧传了、
 *   录制侧漏传 ⇒ 同一辆「无 progress 无 atStation」的车当帧有里程、历史全 `null`
 *   ⇒ 序列只剩 1 帧 ⇒ 撞 `frames ≥ 2` 门 ⇒ **永远锁不上**，且不报任何错。
 *
 *   确实没有几何的调用方请**显式**传 `[]`（语义清晰：本段无几何，不启用兜底）。
 */
export function vehicleMileOf(
  v: TrackVehicle,
  mains: string[],
  ladder: LrtLadder,
  colored: LL[],
): number | null {
  const L = ladder.ladder;
  const good = (i: number) => i >= 0 && i < L.length && ladder.valid[i] === true && Number.isFinite(L[i]);
  const pr = v.progress ?? null;
  if (pr && Number.isFinite(pr.p)) {
    const p = Math.min(1, Math.max(0, pr.p));
    for (const fi of indicesOf(mains, pr.segFrom)) {
      if (!good(fi)) continue;
      for (const ti of indicesOf(mains, pr.segTo)) {
        if (!good(ti) || ti <= fi) continue; // 跨圈对：跳过
        const a = L[fi];
        const b = L[ti];
        if (!(b > a)) continue;
        return a + p * (b - a);
      }
    }
  }
  if (v.atStation?.code) {
    for (const i of indicesOf(mains, v.atStation.code)) if (good(i)) return L[i];
  }
  // ③ 同轴投影兜底（覆盖率兜底，不是「用坐标凑」）
  if (colored.length >= 2 && Number.isFinite(v.lat) && Number.isFinite(v.lng)) {
    const pos = { lng: v.lng, lat: v.lat };
    const proj = nearestOnPath(colored, pos);
    if (proj.idx >= 0 && perpDistM(colored, proj.idx, pos) <= MATCH_PROJ_TRUST_M) {
      const cum = cumDistM(colored);
      const d = cum[proj.idx];
      if (d != null && Number.isFinite(d)) return d;
    }
  }
  return null;
}

/** 沿线平均速度（km/h，取绝对值）；给了 `given` 就用它；样本不足 ⇒ `null` */
export function speedOf(series: MileSample[], given?: number | null): number | null {
  if (given != null && Number.isFinite(given)) return Math.abs(given);
  const a = series[0];
  const b = series[series.length - 1];
  if (!a || !b || a.dM == null || b.dM == null) return null;
  const dt = (b.ts - a.ts) / 1000;
  if (!(dt > 0)) return null;
  return (Math.abs(b.dM - a.dM) / dt) * 3.6;
}

/**
 * 逐帧对齐：每个用户帧配该车**最近时刻**的采样（错位 ≤ `MATCH_ALIGN_TOL_MS`）。
 * 环线 / 投影跳变帧 ⇒ 丢弃并重置基线（不判负也不加分）。
 *
 * ⚠️ **跳变之后的帧**按**新基线**继续算残差；若车与用户实际不在同一圈，残差会很大 ⇒
 *   S1 判负 ⇒ 该车不会被锁定。方向是「宁可少锁，不可锁错」（全圈乘坐的极端场景会退化成
 *   不锁、回落 `progressSource="gps"`），这是刻意的取舍，不是缺陷。
 *   真正的跨圈里程补偿需要圈长（`leg.colored` 只是**本段**几何，不含圈长）⇒ 属独立改造。
 *
 * ℹ️ 关于长间隔（切后台 2 分钟）：`monotonicCut` 用 `TRAVELED_STALE_MS` 显式豁免，
 *   本函数**没有**对应判断 —— 也不需要：跳变门是 `MAX_SPEED × elapsed + 120`，
 *   `elapsed` 一大门就自动放宽，等效于豁免。别以为漏了一条。
 */
export function alignFrames(vSeries: MileSample[], uSeries: MileSample[]): MatchFrame[] {
  const out: MatchFrame[] = [];
  let prevTs = 0;
  let prevD = 0;
  for (const u of uSeries) {
    if (u.dM == null) continue;
    let best: MileSample | null = null;
    let bestDt = Infinity;
    for (const s of vSeries) {
      if (s.dM == null) continue;
      const dt = Math.abs(s.ts - u.ts);
      if (dt < bestDt) {
        bestDt = dt;
        best = s;
      }
    }
    if (!best || best.dM == null || bestDt > MATCH_ALIGN_TOL_MS) continue;
    if (prevTs > 0) {
      const elapsed = (best.ts - prevTs) / 1000;
      if (Math.abs(best.dM - prevD) > TRAVELED_MAX_SPEED_MPS * elapsed + MATCH_STEP_SLACK_M) {
        prevTs = best.ts;
        prevD = best.dM;
        continue; // 换圈 / 跳变：重置基线，本帧不计证据
      }
    }
    prevTs = best.ts;
    prevD = best.dM;
    out.push({ ts: best.ts, dV: best.dM, r: u.dM - best.dM });
  }
  return out;
}

/** 加权均分：`null` 项不参与，其权重按比例分给其余项（S4 冷启动即走这条路） */
export function combine(terms: { value: number | null; weight: number }[]): number {
  let num = 0;
  let den = 0;
  for (const t of terms) {
    if (t.value == null) continue;
    num += t.value * t.weight;
    den += t.weight;
  }
  return den > 0 ? num / den : 0;
}
