/**
 * 车辆区间进度（src/lib/nav/progress.ts，v3.4.0）
 *
 * 给「行驶中（status=moving）」的车辆计算**区间内相对进度 p** 与**位置模型剩余时间**：
 *   车辆 GCJ 坐标 → 投影到线路几何（route_shapes）→ 沿线里程 m
 *   → 用「区间两端站的里程锚」（route_station_mileage）求 p = (m − mFrom)/(mTo − mFrom)
 *   → 剩余 = md × h[段型][1−p]（md 来自 route_hop_stats；h/W 来自 progress-params）
 *
 * ── 数据依赖（两张预计算表 + 一个参数文件）────────────────────────────
 *   · route_station_mileage（npm run db:station-mileage）：站 → 沿线里程（多行制，环线同站两候选）
 *   · route_hop_stats（npm run db:hop-stats）：线路×邻接站对 → 主码级中位秒数
 *   · src/lib/nav/progress-params.ts（scripts/train-progress-model.mjs）：h 曲线 + 权重
 *
 * ── 设计要点（详见 docs/区间进度模型-调研报告-20260927.md）────────────
 *   · 只对 moving 车算（停靠中无意义——区间未开始/已结束）；
 *   · 环线消歧：同一站有多个里程候选 → 取「包含车辆里程的最小区间」；再不行取最近中点；
 *   · 任何一环缺失（无几何/无里程/无 md）→ 该车**不出 progress 字段**（调用方降级）——
 *     宁缺勿错，绝不猜；★ v4.1.1：`route_hop_stats.samples < HOP_MIN_SAMPLES(5)` 视为「无 md」。
 *   · ★ v3.7.0（缓存专项 · AC5.7）：三份缓存的**键里带三源版本令牌**
 *     （`route_shapes.fetched_at` + `route_station_mileage.updated_at` + `route_hop_stats.updated_at`，
 *     见 `progress-freshness.ts#versionTokenOf`）⇒ 改道 / 重算里程 / 重算时长后**立即**失效。
 *     TTL（几何 120s / 跳时长 600s）只作内存上界，**不是**新鲜度的唯一手段。
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️⚠️ **`p` 是形状派生量，参与「锁哪辆车」的判定**（不是纯视觉）：`p` 的分子分母都来自
 *   本文件的两张表，与里程原点无关（所以客户端在 `leg.colored` 轴上插值是自洽的）。
 *   若改道后 shape 缓存还是旧折线、客户端却用新折线 ⇒ 同一位置的 `p` 不同 ⇒ 误差可达
 *   改道长度的一半（与 σ_p=60m 同量级）⇒ 位置项判负。
 *   ⇒ 失效方向是**拒绝锁车**（旧+旧 ≈ 50~100m 不过线；旧+新 ≈ `p` 越界被 clamp 在端点、
 *     偏差一整段），**不是锁错车**。但代码兜不住「改了道却忘了重建里程表」这种运维遗漏
 *     （两表都"新"、令牌一致，但里程内容没重算）⇒ 靠 `/api/health?warm=1` 的 `versionDrift` 暴露。
 *     **运维 SOP：改道后必须跑 `npm run db:station-mileage`。**
 */
import type { Pool } from "pg";
import { PROGRESS_H, PROGRESS_W, progressTypeOf } from "./progress-params";
import { versionTokenOf } from "./progress-freshness";

export interface VehicleProgress {
  /** 区间内相对进度（0 = 刚离站，1 = 即将到站） */
  p: number;
  /** 位置模型剩余秒数（md × h[段型][1−p]）——客户端可与时间项融合 */
  remainSecD: number;
  /** 区间中位时长（秒）——客户端算时间项 max(md − u, 0) 用 */
  mdSec: number;
  /** 融合权重 w（pred = w·D + (1−w)·B，按段型） */
  w: number;
  /** 所在区间（主码） */
  segFrom: string;
  segTo: string;
  /** 区间沿线路长度（米） */
  segLenM: number;
}

/** ★ v3.5.0（等车场景）：**自动定位**车辆所在区间——无需已知 from/to（供「还有 N 站」位置修正） */
export interface VehicleSegmentLocation {
  /** 区间起点站（主码，= 车刚离开的站） */
  fromMain: string;
  /** 区间终点站（主码，= 车的下一站） */
  toMain: string;
  /** 相对进度 0-1 */
  p: number;
  /** 该区间中位时长（秒） */
  mdSec: number;
  /** 位置模型「到下一站」剩余（秒）= md × h[段型][1−p] */
  remainSecD: number;
}

interface ShapeRec {
  pts: [number, number][];
  cum: number[];
}

/**
 * 缓存 TTL **分级**（v3.7.0 · AC5.7）。TTL **只作内存上界**，新鲜度由键里的三源版本令牌负责：
 *   · 令牌：数据变 ⇒ 键变 ⇒ 立即失效（正确性）；   · TTL：键不变时的回收上界（容量 / 兜底）。
 * · **几何 / 里程 = 120s**：二者共同决定 `p` 的分子分母 ⇒ 键万一没变（令牌查询失败退化成
 *   30s 桶时），陈旧窗口也还有个 2 分钟的上限。
 * · **跳时长 = 600s**：`md` 是**统计量**，不参与几何、不参与 `p` 的分母，只影响 `remainSecD`；
 *   三者绑同一 TTL 会让 hop 白多查 5 倍。
 *
 * ⚠️ **契约**：`attachProgress` / `locateSegmentOf` 都是**同一个令牌 + 同批**取三者 ⇒
 *   `p` 的分子分母必然同版本。**不许**给其中一份单独的令牌或单独一次查询，否则同一辆车
 *   拿到的 `p` 会跨越两个版本（旧折线 + 新里程表）⇒ 偏差可达一整段。
 */
const TTL_GEOM_MS = 120_000;
const TTL_HOP_MS = 600_000;
/**
 * `route_hop_stats` 的**最小样本门槛**（v4.1.1）。
 *
 * 为什么必须有：该表按 (route, from_main, to_main) 聚合，没有下限时 `samples=1` 的行也会被当成
 * 「该跳的中位时长」。实测全库 2,458 行里 **59 行 samples ≤ 2、70 行 < 5**，它们全是单次观测 ——
 * 把「跨海 7km 只测到 1 次 40 秒」这种极端值直接喂给 `md` 会让 `remainSecD` 偏差一整段，
 * 而 `md` 同时决定 `progressTypeOf(segLenM, md)` 的段型与融合权重 `w`（一处错、三处错）。
 *
 * 门槛取 5 的依据：与 `long-stop.ts` 的 `MIN_DWELL_SAMPLES=5` 同一档（经验阈值、非文献值）；
 * 低于它视为**无样本** → 走既有降级路径（`attachProgress` 跳过该车 / `locateSegmentOf` 返回 null），
 * 而不是用噪声硬算。**宁缺勿错**是本文件一贯的口径（见文件头设计要点）。
 *
 * ⚠️ 改这个值等于改「哪些区间有位置模型」：调小 → 噪声进 ETA；调大 → 长尾区间失去进度修正。
 */
export const HOP_MIN_SAMPLES = 5;
const shapeCache = new Map<string, { at: number; rec: ShapeRec | null }>();
const mileCache = new Map<string, { at: number; map: Map<string, number[]> }>();
const hopCache = new Map<string, { at: number; map: Map<string, number> }>();

const rad = (d: number) => (d * Math.PI) / 180;
const R = 6371008.8;
function havM(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

async function getShape(pool: Pool, route: string, dir: string, ver: string): Promise<ShapeRec | null> {
  // ★ 键含版本令牌 ⇒ 改道 / 重算里程后**立即**失效，不必等 TTL 到点
  const key = `${route}|${dir}|${ver}`;
  const hit = shapeCache.get(key);
  if (hit && Date.now() - hit.at < TTL_GEOM_MS) return hit.rec;
  let rec: ShapeRec | null = null;
  try {
    const r = await pool.query(`SELECT polyline FROM route_shapes WHERE route_code = $1 AND dsat_dir = $2 LIMIT 1`, [route, dir]);
    const poly = (r.rows[0] as { polyline?: string } | undefined)?.polyline;
    if (poly) {
      const pts = poly.split(";").map((x) => x.split(",").map(Number) as [number, number]);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + havM(pts[i - 1], pts[i]));
      rec = { pts, cum };
    }
  } catch (e) {
    console.warn("[progress] route_shapes 读取失败：", (e as Error).message);
  }
  // ⚠️ 失败/空结果**不入缓存**：旧实现会把 null 也缓存 10 分钟 ⇒ 一次库抖动让进度模型瞎 10 分钟
  if (rec) shapeCache.set(key, { at: Date.now(), rec });
  return rec;
}

async function getMiles(pool: Pool, route: string, dir: string, ver: string): Promise<Map<string, number[]>> {
  const key = `${route}|${dir}|${ver}`;
  const hit = mileCache.get(key);
  if (hit && Date.now() - hit.at < TTL_GEOM_MS) return hit.map;
  const map = new Map<string, number[]>();
  try {
    const r = await pool.query(
      `SELECT main_code, mile_m FROM route_station_mileage WHERE route_code = $1 AND dsat_dir = $2`,
      [route, dir],
    );
    for (const row of r.rows as { main_code: string; mile_m: number }[]) {
      const arr = map.get(row.main_code) ?? [];
      arr.push(Number(row.mile_m));
      map.set(row.main_code, arr);
    }
  } catch (e) {
    console.warn("[progress] route_station_mileage 读取失败：", (e as Error).message);
  }
  if (map.size) mileCache.set(key, { at: Date.now(), map });
  return map;
}

async function getHops(pool: Pool, route: string, ver: string): Promise<Map<string, number>> {
  const key = `${route}|${ver}`;
  const hit = hopCache.get(key);
  if (hit && Date.now() - hit.at < TTL_HOP_MS) return hit.map;
  const map = new Map<string, number>();
  try {
    // ★ v4.1.1：`samples < HOP_MIN_SAMPLES` 的行**不参与**（视为无样本 → 调用方降级）。
    //   门槛是常量、不是魔数；理由见 `HOP_MIN_SAMPLES` 注释。
    const r = await pool.query(
      `SELECT from_main, to_main, p50_sec FROM route_hop_stats
        WHERE route_code = $1 AND samples >= $2`,
      [route, HOP_MIN_SAMPLES],
    );
    for (const row of r.rows as { from_main: string; to_main: string; p50_sec: number }[]) {
      map.set(`${row.from_main}|${row.to_main}`, Number(row.p50_sec));
    }
  } catch (e) {
    console.warn("[progress] route_hop_stats 读取失败：", (e as Error).message);
  }
  if (map.size) hopCache.set(key, { at: Date.now(), map });
  return map;
}

/** 点到折线的沿线里程（全局最近线段；shape ≤2k 点，毫秒级） */
function projectMile(rec: ShapeRec, p: [number, number]): number {
  const kx = Math.cos(rad(p[1])) * 111320, ky = 110540;
  const px = p[0] * kx, py = p[1] * ky;
  let bestD = Infinity, bestM = 0;
  for (let i = 0; i + 1 < rec.pts.length; i++) {
    const a = rec.pts[i], b = rec.pts[i + 1];
    const ax = a[0] * kx, ay = a[1] * ky, bx = b[0] * kx, by = b[1] * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < bestD) {
      bestD = d;
      bestM = rec.cum[i] + t * (rec.cum[i + 1] - rec.cum[i]);
    }
  }
  return bestM;
}

/** 给（moving 且有 interval 的）车辆**原地附加** progress 字段；任何一环缺失则跳过该车。 */
export async function attachProgress(
  pool: Pool,
  route: string,
  dir: string,
  vehicles: { lat: number; lng: number; status: string; interval: { from: { code: string }; to: { code: string } } | null; progress?: VehicleProgress }[],
): Promise<void> {
  if (!vehicles.length) return;
  // ⚠️ 三者共用**同一个令牌**（否则 `p` 的分子分母会来自两个版本，见 `TTL_GEOM_MS` 上的契约说明）
  const ver = await versionTokenOf(pool, route, dir);
  const [shape, miles, hops] = await Promise.all([
    getShape(pool, route, dir, ver),
    getMiles(pool, route, dir, ver),
    getHops(pool, route, ver),
  ]);
  if (!shape || !miles.size || !hops.size) return;

  for (const v of vehicles) {
    if (v.status !== "moving" || !v.interval) continue;
    const fC = miles.get(v.interval.from.code);
    const tC = miles.get(v.interval.to.code);
    if (!fC?.length || !tC?.length) continue;
    const md = hops.get(`${v.interval.from.code}|${v.interval.to.code}`);
    if (!md || md <= 0) continue;

    const m = projectMile(shape, [v.lng, v.lat]);
    // 环线消歧：优先「包含车辆里程的最小区间」；否则取「中点最接近」的组合
    let best: { mf: number; mt: number } | null = null;
    for (const mf of fC) {
      for (const mt of tC) {
        if (mf + 40 >= mt) continue;
        if (m >= mf - 80 && m <= mt + 80) {
          if (!best || mt - mf < best.mt - best.mf) best = { mf, mt };
        }
      }
    }
    if (!best) {
      let bestDiff = Infinity;
      for (const mf of fC) {
        for (const mt of tC) {
          if (mf + 40 >= mt) continue;
          const diff = Math.abs(m - (mf + mt) / 2);
          if (diff < bestDiff) { bestDiff = diff; best = { mf, mt }; }
        }
      }
    }
    if (!best) continue;
    const segLenM = best.mt - best.mf;
    const p = Math.min(1, Math.max(0, (m - best.mf) / segLenM));
    const type = progressTypeOf(segLenM, md);
    const h = PROGRESS_H[type];
    const b = Math.min(19, Math.max(0, Math.floor((1 - p) * 20)));
    v.progress = {
      p: Math.round(p * 1000) / 1000,
      remainSecD: Math.round(md * h![b]!),
      mdSec: Math.round(md),
      w: PROGRESS_W[type],
      segFrom: v.interval.from.code,
      segTo: v.interval.to.code,
      segLenM: Math.round(segLenM),
    };
  }
}

/**
 * ★ v3.5.0：**自动定位**单车所在区间（等车场景 · 「还有 N 站」的位置修正用）。
 *   与 `attachProgress` 的区别：无需已知 from/to——直接拿「线路全部站里程链」找包含车辆里程的最小间隔。
 *   环线安全：排序后仅取「间隔 ≥ 60m」的相邻对；坐标/数据异常 → 返回 null（调用方降级，宁缺勿错）。
 */
export async function locateSegmentOf(
  pool: Pool,
  route: string,
  dir: string,
  lat: number,
  lng: number,
): Promise<VehicleSegmentLocation | null> {
  // ⚠️ 三者共用**同一个令牌**（否则 `p` 的分子分母会来自两个版本，见 `TTL_GEOM_MS` 上的契约说明）
  const ver = await versionTokenOf(pool, route, dir);
  const [shape, miles, hops] = await Promise.all([
    getShape(pool, route, dir, ver),
    getMiles(pool, route, dir, ver),
    getHops(pool, route, ver),
  ]);
  if (!shape || !miles.size || !hops.size) return null;

  const stations: { m: number; main: string }[] = [];
  for (const [main, arr] of miles) for (const m of arr) stations.push({ m, main });
  stations.sort((a, b) => a.m - b.m);
  if (stations.length < 2) return null;

  const m = projectMile(shape, [lng, lat]);
  let best: { from: string; to: string; mf: number; mt: number } | null = null;
  for (let i = 0; i + 1 < stations.length; i++) {
    const a = stations[i]!;
    const b = stations[i + 1]!;
    const gap = b.m - a.m;
    if (gap < 60) continue; // 同站双行/退化间隔 → 跳过
    if (m >= a.m - 80 && m <= b.m + 80) {
      if (!best || gap < best.mt - best.mf) best = { from: a.main, to: b.main, mf: a.m, mt: b.m };
    }
  }
  if (!best) return null;

  const md = hops.get(`${best.from}|${best.to}`);
  if (!md || md <= 0) return null;
  const segLenM = best.mt - best.mf;
  const p = Math.min(1, Math.max(0, (m - best.mf) / segLenM));
  const type = progressTypeOf(segLenM, md);
  const bi = Math.min(19, Math.max(0, Math.floor((1 - p) * 20)));
  return {
    fromMain: best.from,
    toMain: best.to,
    p: Math.round(p * 1000) / 1000,
    mdSec: Math.round(md),
    remainSecD: Math.round(md * PROGRESS_H[type][bi]!),
  };
}
