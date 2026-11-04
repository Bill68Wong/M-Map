/**
 * 跟车判据 · 采样配对（src/lib/nav/follow-frames.ts，2026-11-04 新增 · P0 I-3）
 *
 * ── 职责 ────────────────────────────────────────────────────────────────
 *   把「用户定位帧」与「车辆帧历史」配成**同一时刻**的 `{ts, u, v}` 相对距离样本，
 *   并给出「点 → 折线的分数里程」。判据本身（斜率 / 门槛）在 `follow-slope.ts`。
 *
 * ── 为什么必须配对到同一时刻（本模块存在的唯一理由）──────────────────────
 *   车辆帧 12s 一帧、GPS 1~3s 一帧。若直接拿「当前 GPS 里程」减「上一车辆帧里程」，
 *   `d(t) = |u − v|` 会按车速**锯齿增长**（车没更新、人已更新）⇒ 斜率恒 ≈ 车速
 *   ⇒ 「人在车上」永远判不出。所以只在**两帧车辆快照之间**线性内插求 `v(t)`：
 *   两端都是**实测**位置，内插不是猜测；不外推，缺端点即跳过。
 *
 * ── 另一个坑：里程不能取「最近顶点」──────────────────────────────────────
 *   `nearestOnPath` 返回最近**顶点**，真实 `route_shapes` 顶点间距中位 ≈19m ⇒ 量化误差
 *   与 10m 级定位差同量级，斜率判据直接失效。故 `alongMileM` 在相邻两段内做垂直投影取
 *   `t`（分数里程），量化误差 ≈0（局部平面近似与 `track.ts#perpDistM` 同一套）。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 *   · client-safe 纯函数（不 import `pg`、不进 React、不读 DOM）；
 *   · 样本配对不上（缺端点 / 越容差 / 时间越界）⇒ **跳过**，绝不外推、绝不填值。
 */
import { cumDistM, nearestOnPath, type LL } from "./route-overview";
import type { TrackVehicle } from "./track";

/** 一帧「用户 ↔ 参照车」的相对距离样本（`u`/`v` 都是同一条 `colored` 上的沿线里程，米） */
export interface FollowFrame {
  ts: number;
  u: number;
  v: number;
  /** 该帧用户定位的水平精度（米） */
  accuracy: number;
  /** 参照车车牌（换车即作废） */
  plate: string;
}

/** 一帧车辆快照（`fetchFrame` 每次成功往返记一条） */
export interface VehFrame {
  ts: number;
  vehicles: TrackVehicle[];
}

/** 车辆位置投影到线路的容差（米）：超出的车辆快照不参与（坐标异常 / 越界） */
export const FOLLOW_VEH_TOL_M = 120;
/**
 * 配对前的定位帧裁剪下界（ms）：只留最近 50s。
 * 判据窗口上限 30s ⇒ 留 20s 余量即可；90s 缓冲里最多 90 帧，先裁剪可省掉几十次全折线投影。
 */
export const FOLLOW_PAIR_KEEP_MS = 50_000;

/** 折线上的投影结果（沿线里程 + 真垂距） */
export interface MileOnPath {
  /** 沿线里程（米，`cum[0]` 起算；**线段内插**，不是最近顶点） */
  m: number;
  /** 到折线的真垂距（米） */
  dist: number;
}

/**
 * 点 → 折线的**分数里程**（沿线里程，米）。
 *
 * @param poly 折线（GCJ-02，≥2 点）
 * @param cum  `cumDistM(poly)`（必须等长，否则视为不可用）
 */
export function alongMileM(poly: LL[], cum: number[], p: { lng: number; lat: number }): MileOnPath | null {
  if (poly.length < 2 || cum.length !== poly.length) return null;
  if (!Number.isFinite(p.lng) || !Number.isFinite(p.lat)) return null;
  const { idx } = nearestOnPath(poly, p);
  const latMid = ((poly[idx][1] + p.lat) / 2) * (Math.PI / 180);
  const kx = 111320 * Math.cos(latMid);
  const ky = 111320;
  const px = p.lng * kx;
  const py = p.lat * ky;

  let best: { t: number; dist: number; ai: number; bi: number } | null = null;
  for (const [ai, bi] of [
    [idx - 1, idx],
    [idx, idx + 1],
  ] as const) {
    if (ai < 0 || bi >= poly.length) continue;
    const ax = poly[ai][0] * kx;
    const ay = poly[ai][1] * ky;
    const bx = poly[bi][0] * kx;
    const by = poly[bi][1] * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = 0;
    let dist: number;
    if (!(l2 > 0)) {
      dist = Math.hypot(px - ax, py - ay); // 重复顶点 ⇒ 退化为点距
    } else {
      t = ((px - ax) * dx + (py - ay) * dy) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    }
    if (!best || dist < best.dist) best = { t, dist, ai, bi };
  }
  if (!best) return null;
  const segLen = cum[best.bi] - cum[best.ai];
  return { m: cum[best.ai] + best.t * segLen, dist: best.dist };
}

/** 某车在某折线上的沿线里程（米）；坐标异常 / 离线路超过 `tolM` ⇒ `null`（不猜） */
export function vehicleMileOnPath(
  poly: LL[],
  cum: number[],
  vehicles: TrackVehicle[],
  plate: string,
  tolM = FOLLOW_VEH_TOL_M,
): number | null {
  const v = vehicles.find((x) => x.plate === plate);
  if (!v || !Number.isFinite(v.lat) || !Number.isFinite(v.lng)) return null;
  const r = alongMileM(poly, cum, { lng: v.lng, lat: v.lat });
  if (!r || r.dist > tolM) return null;
  return r.m;
}

/**
 * 把「用户定位帧」与「车辆帧历史」配成同一时刻的相对距离样本。
 *
 * · 只在 `[vehFrames[i], vehFrames[i+1]]` **之间**内插，不外推（首帧之前 / 末帧之后跳过）；
 * · 该车在任一端点缺失（或越容差）⇒ 整段跳过 —— 宁缺勿错；
 * · 输出按时间升序，只保留末尾 `maxFrames` 条。
 *
 * @param plate 参照车车牌（`null` ⇒ 无样本）
 * @param tolM  车辆投影容差（缺省 `FOLLOW_VEH_TOL_M`）；用户侧另按 `accuracy × 1.5` 放开
 */
export function followFramesOf(o: {
  fixes: { lng: number; lat: number; accuracy: number; ts: number }[];
  vehFrames: VehFrame[];
  colored: LL[];
  plate: string | null;
  tolM?: number;
  maxFrames?: number;
}): FollowFrame[] {
  const { fixes, vehFrames, colored, plate } = o;
  if (!plate || colored.length < 2 || fixes.length < 1 || vehFrames.length < 2) return [];
  const cum = cumDistM(colored);
  const tol = o.tolM ?? FOLLOW_VEH_TOL_M;
  const marks = vehFrames
    .filter((f) => Number.isFinite(f.ts))
    .map((f) => ({ ts: f.ts, m: vehicleMileOnPath(colored, cum, f.vehicles, plate, tol) }))
    .sort((a, b) => a.ts - b.ts);
  const lastMarkTs = marks.length ? marks[marks.length - 1].ts : 0;
  const from = lastMarkTs - FOLLOW_PAIR_KEEP_MS;

  const out: FollowFrame[] = [];
  let j = 0;
  for (const f of fixes) {
    if (!Number.isFinite(f.ts) || f.ts < from) continue;
    // ⚠️ 条件必须是 `j + 2 < marks.length`（不是 `j + 1`）：否则定位戳正好落在
    //   **最后一帧车辆快照**上时会被推进到 `j = len-1`、`b` 缺失 ⇒ 最新那几帧全被丢掉。
    //   保留 `j ≤ len-2` ⇒ 末段按 `k = 1` 取最后一帧实测值（不外推）。
    while (j + 2 < marks.length && marks[j + 1].ts <= f.ts) j++;
    const a = marks[j];
    const b = marks[j + 1];
    if (!a || !b) continue;
    if (f.ts < a.ts || f.ts > b.ts) continue;
    if (a.m == null || b.m == null) continue;
    const span = b.ts - a.ts;
    if (!(span > 0)) continue;
    const r = alongMileM(colored, cum, f);
    if (!r) continue;
    const acc = Number.isFinite(f.accuracy) ? f.accuracy : 0;
    if (r.dist > Math.max(tol, acc * 1.5)) continue;
    const k = (f.ts - a.ts) / span;
    out.push({ ts: f.ts, u: r.m, v: a.m + (b.m - a.m) * k, accuracy: acc, plate });
  }
  const max = Math.max(1, o.maxFrames ?? 20);
  return out.length > max ? out.slice(-max) : out;
}
