/**
 * 推荐实时层（src/lib/recommend/live.ts，v1.0.0）
 *
 * 职责单一：为一批候选路线方案，取回「首段/各段」的实时班次，转成 `RouteLive`（纯视图）。
 *   · 巴士 → DSAT 实时报站（`queryEta`，注入站序索引 + purpose='recommend'）
 *   · 轻轨 → 本库时刻表本地算（`queryLrtDepartures`，零 DSAT 依赖）
 *
 * ⚠️ **只有首段巴士需要实时**：`model.ts` 里第 2 段起的巴士等车按「到达换乘站时刻查
 *    `route_frequency` 班距（偏保守 `(lo+2·hi)/3`）」估 —— 因为没有第二条 DSAT 数据源可查，
 *    且**不引入新的高频 DSAT 请求**。
 *    轻轨则**任何段**都要时刻表：第 2 段起用「预计到达换乘站时刻之后的第一班」。
 *
 * ────────────────────────── 分桶与并发（性能要点）──────────────────────────
 * 桶 = 一次 DSAT 调用的粒度：
 *   · 巴士桶：`(上车站, 下车点)` 聚合出该站该方向的全部线路 → 与 `queryEta` 的
 *     MAX_ROUTES=6 对齐，超过 6 条拆成多桶（同一物理站在同一时刻可一次问多线）。
 *   · 轻轨桶：`(上车站, 线路, 下车点)` 一个（时刻表按站查，不能跨站合并）。
 *
 * ★ v1.0.0 性能修复（线上实测倒逼）：**桶间由「串行」改为「并发」**。
 *   原设计「桶间串行 × 每波 3 桶」在本机（澳门，距 DSAT 11ms）没问题；
 *   但线上函数实际跑在 **Vercel Hobby 默认区域 iad1（美东）**，
 *   `preferredRegion="sin1"` 在 Hobby 下**不生效** → DSAT 单次往返 ~250ms、主库 ~230ms。
 *   实测：11 个桶分 4 波 → 首波 3 个各 ~920ms 串起来 = 3.07s，**远超 2 秒门槛**。
 *   现在每波 12 桶（覆盖本项目全部方向的桶数）→ 总耗时 ≈ 最慢的单桶。
 *   ⚠️ 流量仍温和：本项目桶多为「1 桶 1 线」→ 实测并发 DSAT 调用 ≈ 9 次，
 *      与既有采集器并发 6 同量级；且**只在用户点开卡片时发生一次**。
 *
 * 单桶超时 **1.2s**：超时/失败的桶 → 其线路不进 `live` → `model.ts` 按「无实时车」
 * 把相应方案排除（记入剔除计数器）→ 卡片少几张，但**绝不显示假数据**。
 * ⚠️ 轻轨桶走**预载内存**（`LrtPreload`）→ 0 次 DB 往返 → 不再有超时风险。
 *
 * ⚠️ 本模块**不做结果缓存**（原注释「缓存统一放在 `service.ts`，key=`from|to|zone`，TTL 10s」
 *    已失效：`service.ts` 早已删除）。现存的三层缓存各有明确边界：
 *      · 高德 OD 方案（`transit_cache`，≤60s）→ **每次请求都真实调用**，仅在调用彻底失败时兜底读
 *        （`nav-service.ts` ③ 段，问题 #6 · C1）；
 *      · DSAT 报站（`dsat/eta.ts` 进程内 5s）→ 本模块用 `force=true` **穿透**（见 `queryBusBucket`）；
 *      · 静态索引（`recommend/query.ts` 60s）→ 只含站序/段时长/步行/换乘/轻轨时刻表，**无实时字段**。
 */
import type { Pool } from "pg";
import { queryEta, type EtaBus } from "@/lib/dsat/eta";
import { getBusLocations } from "@/lib/dsat/client";
import { wgs84ToGcj02 } from "@/lib/amap/coord";
import { locateSegmentOf, type VehicleSegmentLocation } from "@/lib/nav/progress";
import { queryLrtDepartures, type LrtPreload } from "@/lib/lrt/next-departures";
import { idxsOf } from "./enumerate";
import { headwayAt, type HeadwayIndex } from "./headway";
import { lookupHop, mainCodeOf, type SegmentIndex } from "./segment-lookup";
import {
  HOP_HI_FACTOR,
  HOP_LO_FACTOR,
  type BusArrival,
  type BusLive,
  type LrtLive,
  type OptionSeed,
  type RouteIndex,
  type RouteLive,
  type WaitEstimate,
} from "./types";

/**
 * 单桶超时（ms）：超时即视为该桶无数据（该桶线路的方案被排除，不阻塞整页）。
 * ⚠️ 这是**兜底安全阀**，不是性能目标 —— 巴士桶正常在 450~950ms 内返回。
 *
 * ★ v1.0.2：1_200 → **3_000**。
 *   线上冷启动实测：函数执行在 iad1（美东）、DSAT 在澳门，11 个桶并发时首轮请求
 *   要先建 TLS，9 个桶顶到 1.2s 超时线（`✗bus:…=1200ms`）→ 巴士线被整批剔除、
 *   只剩轻轨卡（点首页卡从 5 张掉到 1~3 张）。
 *   **取舍（2026-09-16 用户拍板）**：宁可多等、也要拿到真实实时数据
 *   —— 明确不接受估算卡，因此这里只放宽时限，**超时语义仍是「按无车剔除」**。
 *   代价：服务器刚睡醒时出卡可能超过 2 秒；热态不受影响（正常仍 <1s）。
 */
const BUCKET_TIMEOUT_MS = 3_000;

/**
 * 每波并发桶数。
 * 12 已覆盖本项目全部方向的桶数（实测 6 个方向多为 9~13 桶）→ 实际上 = 「全部并发」，
 * 而单个桶的 DSAT 调用数受 `queryEta` 内部 MAX_ROUTES=6 约束 → 峰值调用量可控。
 */
const BUCKET_CONCURRENCY = 12;
/** 单桶最多线路数（与 src/lib/dsat/eta.ts 的 MAX_ROUTES 对齐） */
const MAX_ROUTES_PER_BUCKET = 6;
/** 轻轨取几班：跨「等车 + 换乘」后仍要能找到晚于到达时刻的一班 */
const LRT_TAKE = 6;

export interface LiveBucketStat {
  kind: "bus" | "lrt";
  key: string;
  routes: string[];
  ms: number;
  /** true = 在超时内拿到结果（含「该线无车」这种正常空态） */
  ok: boolean;
  note?: string;
}

export interface LiveBatch {
  /** route → 实时视图（model.ts 的 Key）。同线多站冲突时取首个并记 note */
  live: Map<string, RouteLive>;
  stats: {
    buckets: number;
    dsatCalls: number;
    timedOut: number;
    ms: number;
    items: LiveBucketStat[];
  };
}

interface BusBucket {
  kind: "bus";
  station: string;
  dest: string;
  routes: string[];
}
interface LrtBucket {
  kind: "lrt";
  station: string;
  route: string;
  dest: string;
}
type Bucket = BusBucket | LrtBucket;

/** 该线路的兜底单跳时长（L5 该线均值 → L6 全局均值） */
function fallbackHop(segIdx: SegmentIndex, route: string): number {
  const per = segIdx.routeHop.get(route);
  if (per !== undefined && per > 0) return per;
  return segIdx.globalHop > 0 ? segIdx.globalHop : 3;
}

/**
 * DSAT 一辆在途车 → 到用户站的「区间」（秒）。
 *
 * 逐跳展开（**禁「站数 × 常数」**：各跳站间距不同）：
 *   优先用 `queryEta` 随结果返回的 `hops`（它算 stopsAway 时用的同一段区间）——
 *   环线（只有 dir=0 一套站序、首尾同码）在本地重新展开极可能取到**另一圈**的跳，
 *   实测把「还有 2 站」展开成 16.8 分钟（v1.0.0 踩到）。
 *   `hops` 缺失时才退化为本地按站序索引展开，最后退化为「该线单跳均值 × 站数」。
 *
 * 下限（判定能否赶上用，往短了算）：
 *   status='1'（停靠挂载站）= 车还在站上 → 含第 1 跳
 *   status='0'（已离挂载站驶向下一站）= 第 1 跳已在路上 → 该跳算 0
 */
export function toBusArrival(
  idx: RouteIndex,
  segIdx: SegmentIndex,
  route: string,
  dir: string,
  e: EtaBus,
  nowBucket: string,
  /** ★ v3.5.0：该车的区间定位（区间进度模型结果；不可用传 null）——供「还有 N 站」单值化 */
  locSeg: VehicleSegmentLocation | null = null,
): BusArrival {
  const hopMin: number[] = [];
  const pairs: [string, string][] =
    e.hops && e.hops.length
      ? e.hops
      : (() => {
          // 退化路径：本地按索引展开（与 queryEta 同口径，但环线可能取错圈）
          const stops = idx.dirStops.get(`${route}|${dir}`) ?? [];
          const bi = idxsOf(stops, e.atStation)[0] ?? -1;
          if (bi < 0 || !stops.length) return [];
          const n = stops.length;
          const out: [string, string][] = [];
          for (let k = 0; k < e.stopsAway; k++) {
            const a = stops[(bi + k) % n];
            const b = stops[(bi + k + 1) % n];
            if (!a || !b) break;
            out.push([a, b]);
          }
          return out;
        })();

  for (const [a, b] of pairs) hopMin.push(lookupHop(segIdx, route, a, b, nowBucket).minutes);
  // 逐跳完全缺失（站序对不上）→ 退化为「该线单跳均值 × 站数」
  if (!hopMin.length && e.stopsAway > 0) {
    const per = fallbackHop(segIdx, route);
    for (let k = 0; k < e.stopsAway; k++) hopMin.push(per);
  }

  const sum = hopMin.reduce((a, b) => a + b, 0);
  const first = hopMin[0] ?? 0;
  // ★ v3.5.0：单值点估计 etaSec——「还有 N 站 · 约 X 分钟」的口径（区间 loSec/hiSec 围绕它派生）
  //   ① 在途 + 位置可用（区间进度模型）→ 首跳位置剩余 + 后续静态跳
  //      （实测：过半场景误差 −42%、将到场景 −59%——.verify/_track-progress-13-interval-k.mjs）
  //   ② 在途 + 无位置 → sum − 首跳×0.5（「已离站位置未知」的期望中点——比旧「减整跳」居中）
  //   ③ 在站停靠 → sum
  let etaSec: number;
  if (e.status === "0") {
    const restSec = Math.max(0, (sum - first) * 60);
    const expectedNext = mainCodeOf((e.hops && e.hops.length ? e.hops[0]?.[1] : pairs[0]?.[1]) ?? "");
    if (locSeg && expectedNext && mainCodeOf(locSeg.toMain) === expectedNext) {
      etaSec = locSeg.remainSecD + restSec;
    } else {
      etaSec = Math.max(0, sum * 60 - first * 60 * 0.5);
    }
  } else {
    etaSec = sum * 60;
  }
  // ★ v3.4.1 实测标定：区间 [0.6×eta, 1.4×eta]（覆盖率 84.9%；accuracy-report.txt）
  const loSec = Math.max(0, Math.round(etaSec * HOP_LO_FACTOR));
  return {
    stopsAway: e.stopsAway,
    atStation: e.atStation,
    status: e.status,
    etaSec: Math.round(etaSec),
    loSec,
    hiSec: Math.max(loSec, Math.round(etaSec * HOP_HI_FACTOR)),
    hopMin,
  };
}

/**
 * ★ v1.2.0：`queryEta` 的一条线路结果 → `BusLive`（供 `fetchLive` 与 `fetchStationLive` 共用）。
 *
 * 候选池口径（v1.1.4，用户 2026-09-16 定）：「**还没到用户上车站**」的全部在途车 ——
 *   · `passed`（已过站、环线按绕一圈计）→ **排除**：它们往往要等一整圈（可达 40 分钟），
 *     留着会让「赶不上就整条剔除」名存实亡（环线永远有车）。
 *   · **不设条数上限**：`eta.ts` 的 `rest` 给出第 3 辆起的全部。
 *   · 池内顺序沿用 `eta.ts` 的升序（按站距）→ nearest/second/more 语义不变。
 */
/** 从 `stops[fromIdx]` 沿该方向走 `steps` 跳的总时长（分钟）；一步都解不出 ⇒ `null` */
function hopsDurationBetween(
  segIdx: SegmentIndex,
  route: string,
  stops: string[],
  fromIdx: number,
  steps: number,
  nowBucket: string,
): number | null {
  const n = stops.length;
  if (!n || steps <= 0) return null;
  let sum = 0;
  let any = false;
  for (let k = 0; k < steps; k++) {
    const a = stops[(fromIdx + k) % n];
    const b = stops[(fromIdx + k + 1) % n];
    if (!a || !b) break;
    sum += lookupHop(segIdx, route, a, b, nowBucket).minutes;
    any = true;
  }
  return any ? sum : null;
}

/**
 * ★ 2026-09-21 新增：**未发车线路的等待时间估算**（区间）。
 *
 * ── 解决什么 ──────────────────────────────────────────────────────────
 *   在起点站等车时，本方向的车**都已发出去** ⇒ `nearest/second/more` 全空 ⇒
 *   `empty = true` ⇒ 整条方案被剔除（实测：26A 黑沙海灘的 28 分直达被剔，
 *   只剩 70~83 分的绕路方案）。但**并非真的没车**：
 *   用「发车间隔（`route_frequency`）」+「**已过站班车**跑了多远」可以反推下一班何时到。
 *
 * ── 算法（两级）───────────────────────────────────────────────────────
 *   ① `basis='passed'`（较准）：取**已过用户站且下游最近**的那辆车（`EtaBus.passed`）
 *      ⇒ 它从用户站到当前挂载站的逐跳时长 ≈ 它**多久前经过用户站**（`sinceLast`）
 *      ⇒ 下一班等待 ≈ 发车间隔 − sinceLast，仍以**区间** `[lo−s, hi−s]` 表达（下限截 0）
 *   ② `basis='headway'`（较粗，降级）：无已过站班车可用（典型＝**在起点站**等车）
 *      ⇒ 保守给 `[0, hi]`（最多再等一个完整间隔）
 *
 * ⚠️ 仅当实车候选全空时才调用（有实车时**零改动**，走原有精确路径）。
 * ⚠️ 一律**估算**（DSAT 无发车时刻表）⇒ UI 必须写「约 X 到 Y 分钟」。
 * ⚠️ **暂不参与排序**（两步走的第一步：先展示、观察准确性）。
 */
function estimateWait(
  r: { route: string; dir?: string; nearest?: EtaBus; second?: EtaBus; rest?: EtaBus[] },
  station: string,
  idx: RouteIndex,
  segIdx: SegmentIndex,
  nowBucket: string,
  headway: HeadwayIndex | null,
  nowMs: number,
): WaitEstimate | null {
  if (!headway) return null;
  // 该线此刻没有班次基准（如 N2 白天停驶、15T 平日不运营）⇒ **不估**（宁缺毋滥）
  const hit = headwayAt(headway, r.route, nowMs);
  if (!hit) return null;

  const dir = r.dir ?? "0";
  const stops = idx.dirStops.get(`${r.route}|${dir}`) ?? [];
  if (!stops.length) return null;
  const userIdx = idxsOf(stops, station)[0] ?? -1;
  if (userIdx < 0) return null;

  // ① 找「刚过用户站」的班车：passed=true 且站序在用户站下游（环线按模运算）
  const passed = [r.nearest, r.second, ...(r.rest ?? [])].filter((e): e is EtaBus => !!e && e.passed === true);
  let sinceLastMin: number | null = null;
  if (passed.length) {
    const n = stops.length;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const e of passed) {
      const bi = idxsOf(stops, e.atStation)[0] ?? -1;
      if (bi < 0) continue;
      const gap = bi > userIdx ? bi - userIdx : bi + n - userIdx;
      if (gap <= 0 || gap >= bestGap) continue;
      const mins = hopsDurationBetween(segIdx, r.route, stops, userIdx, gap, nowBucket);
      if (mins !== null) {
        bestGap = gap;
        sinceLastMin = mins;
      }
    }
  }

  const round1 = (v: number) => Math.round(v * 10) / 10;
  // ② 降级：无已过站班车 ⇒ 保守区间
  if (sinceLastMin === null) {
    return {
      loMin: 0,
      hiMin: hit.hi,
      basis: "headway",
      headwayLo: hit.lo,
      headwayHi: hit.hi,
      span: hit.span,
    };
  }
  // ③ 主线：用「上一班已过去多久」把间隔区间往前推
  const lo = Math.max(0, hit.lo - sinceLastMin);
  const hi = Math.max(lo, hit.hi - sinceLastMin);
  return {
    loMin: round1(lo),
    hiMin: round1(hi),
    basis: "passed",
    headwayLo: hit.lo,
    headwayHi: hit.hi,
    sinceLastMin: round1(sinceLastMin),
    span: hit.span,
  };
}

function buildBusLive(
  r: { route: string; dir?: string; nearest?: EtaBus; second?: EtaBus; rest?: EtaBus[] },
  idx: RouteIndex,
  segIdx: SegmentIndex,
  nowBucket: string,
  /** ★ 2026-09-21：以下三个参数供「未发车估算」用（实车为空时才用到） */
  station: string,
  headway: HeadwayIndex | null,
  nowMs: number,
  /** ★ v3.5.0：位置修正表（`route|plate` → 区间定位；缺省 = 不修正，静态降级） */
  locOf?: Map<string, VehicleSegmentLocation>,
): BusLive {
  const dir = r.dir ?? "0";
  const toArr = (e: EtaBus | undefined) =>
    e
      ? toBusArrival(idx, segIdx, r.route, dir, e, nowBucket, e.plate ? (locOf?.get(`${r.route}|${e.plate}`) ?? null) : null)
      : null;
  const pool = [r.nearest, r.second, ...(r.rest ?? [])].filter((e): e is EtaBus => !!e && !e.passed);
  const arr = pool.map((e) => toArr(e)).filter((x): x is BusArrival => x !== null);
  const empty = arr.length === 0;
  return {
    kind: "bus",
    route: r.route,
    // empty = 该方向**没有一辆还没到站的车**（不在运营时间 / 末班已过）
    //   ★ 2026-09-21：不再等于「整条方案排除」—— 若能量出 waitEstimate，仍可出卡（见 model.ts）
    empty,
    nearest: arr[0] ?? null,
    second: arr[1] ?? null,
    more: arr.slice(2),
    // 仅在全空时估算（有实车时不需要，保持原有精确路径）
    waitEstimate: empty ? estimateWait(r, station, idx, segIdx, nowBucket, headway, nowMs) ?? undefined : undefined,
  };
}

/** ★ v3.5.0：位置修正的最大线路数（超出不修正——静态降级，防止请求膨胀） */
const MAX_LOC_ROUTES = 8;

/**
 * ★ v3.5.0（等车场景）：为「在途车」批量拉实时坐标 → 定位所在区间。
 * 输入：`route|plate` → { route, dir, plate }（来自报站结果的 status='0' 车）。
 * 输出：`route|plate` → 区间定位（供 toBusArrival 把首跳换成「位置剩余」）。
 * ⚠️ 任一环缺失（无坐标/定位失败/超上限）→ 该车不进表 → 调用方按静态降级（宁缺勿错）。
 */
export async function fetchLocSegments(
  pool: Pool,
  moving: Map<string, { route: string; dir: string; plate: string }>,
): Promise<Map<string, VehicleSegmentLocation>> {
  const out = new Map<string, VehicleSegmentLocation>();
  if (!moving.size) return out;
  const rds = [...new Set([...moving.values()].map((x) => `${x.route}|${x.dir}`))].slice(0, MAX_LOC_ROUTES);
  await Promise.all(
    rds.map(async (rd) => {
      const [route, dir] = rd.split("|") as [string, string];
      try {
        const res = await getBusLocations(route, dir, "recommend");
        const list = res.ok ? res.data?.busInfoList : undefined;
        if (!list?.length) return;
        const locByPlate = new Map<string, { lat: number; lng: number }>();
        for (const c of list) {
          const p = String(c.busPlate ?? "").trim();
          const lat = Number(c.latitude);
          const lng = Number(c.longitude);
          if (p && Number.isFinite(lat) && Number.isFinite(lng)) locByPlate.set(p, { lat, lng });
        }
        for (const mv of moving.values()) {
          if (mv.route !== route || mv.dir !== dir) continue;
          const loc = locByPlate.get(mv.plate);
          if (!loc) continue;
          // loc 坐标为 WGS84 → 转 GCJ（route_shapes 为 GCJ）
          const gcj = wgs84ToGcj02({ lat: loc.lat, lng: loc.lng });
          const seg = await locateSegmentOf(pool, route, dir, gcj.lat, gcj.lng);
          if (seg) out.set(`${route}|${mv.plate}`, seg);
        }
      } catch {
        /* 单线失败 → 该组装车不修正（调用方静态降级） */
      }
    }),
  );
  return out;
}

/** ★ v3.5.0：位置修正拉取的整体超时（ms）——超时 → 全部按静态降级 */
const LOC_FIX_TIMEOUT_MS = 1_500;

/** ★ v3.5.0：从桶结果收集「在途（status='0'）且有车牌」的车——位置修正的输入 */
export function collectMoving(
  res: { route: string; ok: boolean; dir?: string; nearest?: EtaBus; second?: EtaBus; rest?: EtaBus[] }[],
): Map<string, { route: string; dir: string; plate: string }> {
  const moving = new Map<string, { route: string; dir: string; plate: string }>();
  for (const r of res) {
    if (!r.ok || !r.dir) continue;
    for (const e of [r.nearest, r.second, ...(r.rest ?? [])]) {
      if (e && e.status === "0" && e.plate) {
        moving.set(`${r.route}|${e.plate}`, { route: r.route, dir: r.dir, plate: e.plate });
      }
    }
  }
  return moving;
}

/** 超时包装：到点即抛，由调用方按「该桶无数据」处理 */function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * 取回一批候选方案的实时班次。
 *
 * @param idx 站序索引（内存）—— 供逐跳展开与方向推导，消灭 per-route DB 往返
 * @param segIdx 段统计索引（内存）—— 供逐跳时长
 * @param opts.lrtPre 轻轨预载（内存）—— 轻轨桶 0 次 DB 往返（见 `LrtPreload`）
 */
export async function fetchLive(
  pool: Pool,
  seeds: OptionSeed[],
  idx: RouteIndex,
  segIdx: SegmentIndex,
  opts: {
    nowBucket: string;
    nowMs?: number;
    lrtPre: LrtPreload;
    /**
     * ★ 2026-09-21：**发车间隔索引**（供「未发车估算」用）。
     * 不传 / 传 null ⇒ 不估算（行为与旧版完全一致）。
     */
    headway?: HeadwayIndex | null;
  },
): Promise<LiveBatch> {
  const t0 = Date.now();
  const nowBucket = opts.nowBucket;
  /** 诊断用：同线多站冲突（route 只能有一个 live 视图 → 取首个） */
  const conflicts: string[] = [];

  // ── ① 收集需求 ─────────────────────────────────────────────
  const busNeed = new Map<string, { station: string; dest: string; routes: Set<string> }>();
  const lrtNeed = new Map<string, LrtBucket>();
  /** route → 该线被请求的站集合（冲突检测） */
  const stationsOfRoute = new Map<string, Set<string>>();
  const noteStation = (route: string, station: string) => {
    const s = stationsOfRoute.get(route) ?? new Set<string>();
    s.add(station);
    stationsOfRoute.set(route, s);
  };

  for (const seed of seeds) {
    for (let i = 0; i < seed.segments.length; i++) {
      const seg = seed.segments[i];
      if (seg.kind === "bus") {
        if (i !== 0) continue; // 第 2 段起按班次间隔估，无需实时（见文件头）
        const k = `${seg.board}|${seg.alight}`;
        const e = busNeed.get(k) ?? { station: seg.board, dest: seg.alight, routes: new Set<string>() };
        e.routes.add(seg.route);
        busNeed.set(k, e);
      } else {
        const k = `${seg.board}|${seg.route}|${seg.alight}`;
        if (!lrtNeed.has(k)) lrtNeed.set(k, { kind: "lrt", station: seg.board, route: seg.route, dest: seg.alight });
      }
      noteStation(seg.route, seg.board);
    }
  }

  // ── ② 建桶（巴士按 6 条/桶拆分）─────────────────────────────
  const buckets: Bucket[] = [];
  for (const [, e] of busNeed) {
    const routes = [...e.routes].sort();
    for (let i = 0; i < routes.length; i += MAX_ROUTES_PER_BUCKET) {
      buckets.push({ kind: "bus", station: e.station, dest: e.dest, routes: routes.slice(i, i + MAX_ROUTES_PER_BUCKET) });
    }
  }
  for (const [, e] of lrtNeed) buckets.push(e);

  const live = new Map<string, RouteLive>();
  const items: LiveBucketStat[] = [];
  let dsatCalls = 0;
  let timedOut = 0;
  const seenRoute = new Map<string, string>(); // route → 已写入的站（冲突检测）

  const put = (route: string, station: string, lv: RouteLive) => {
    const prev = seenRoute.get(route);
    if (prev !== undefined && prev !== station) {
      // route 是 model.ts 的取用键 → 同线多站只能保一个（同方向实测不会发生，留告警以备数据变化）
      //
      // ★ v3.3.0（AC-97）：**「可用者优先」** —— 旧口径「首个桶为准」是**顺序相关**的：
      //   实测「石排灣→科大」时，`LRT-石排湾线` 先被一个**非营运**的上车站视图占用
      //   （`state=no_data`）⇒ 后到的**可用**视图（本地链上车站 `LRT-SPW`，`running`）被丢弃
      //   ⇒ 本地跨线换乘候选在建模期即被 `excluded`（先于质量闸门）⇒ AC-97 假绿。
      //   现：**已存视图不可用（轻轨非 running）而后到者可用 ⇒ 覆盖**；否则维持首个（行为不变）。
      //   ⚠️ 仅对**轻轨**生效（巴士 `BusLive` 无 running 语义 ⇒ 恒视为可用 ⇒ 行为零变化）。
      const prevLv = live.get(route);
      const prevUsable = prevLv?.kind === "lrt" ? prevLv.state === "running" : true;
      const nextUsable = lv.kind === "lrt" ? lv.state === "running" : true;
      if (!prevUsable && nextUsable) {
        seenRoute.set(route, station);
        live.set(route, lv);
        conflicts.push(`${route}: ${prev} 与 ${station}（改取可用者 ${station}）`);
      } else {
        conflicts.push(`${route}: ${prev} 与 ${station}（取 ${prev}）`);
      }
      return;
    }
    seenRoute.set(route, station);
    live.set(route, lv);
  };

  // ── ③ 桶间并发（每波 BUCKET_CONCURRENCY 个桶；本项目实测 = 全部并发）──
  for (let i = 0; i < buckets.length; i += BUCKET_CONCURRENCY) {
    const batch = buckets.slice(i, i + BUCKET_CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (b): Promise<LiveBucketStat> => {
        const bt = Date.now();
        const key =
          b.kind === "bus" ? `${b.station}→${b.dest} [${b.routes.join(",")}]` : `${b.station}→${b.dest} ${b.route}`;
        try {
          if (b.kind === "bus") {
            // ⚠️ purpose='recommend' → 不进熔断判定 + 独立 1.5s 超时（见 dsat/client.ts）
            const res = await withTimeout(
              queryBusBucket(idx, b),
              BUCKET_TIMEOUT_MS,
              key,
            );
            // ★ v3.5.0：位置修正——对本桶「在途车」拉 loc → 定位区间（超时/失败 → 静态降级）
            const moving = collectMoving(res);
            const locOf = await withTimeout(
              fetchLocSegments(pool, moving),
              LOC_FIX_TIMEOUT_MS,
              `locfix:${key}`,
            ).catch(() => new Map<string, VehicleSegmentLocation>());
            for (const r of res)
              put(
                r.route,
                b.station,
                buildBusLive(
                  r,
                  idx,
                  segIdx,
                  nowBucket,
                  b.station,
                  opts.headway ?? null,
                  opts.nowMs ?? Date.now(),
                  locOf,
                ),
              );
            dsatCalls += b.routes.length;
          } else {
            const res = await withTimeout(
              queryLrtDepartures(pool, {
                station: b.station,
                route: b.route,
                dest: b.dest,
                take: LRT_TAKE,
                nowMs: opts.nowMs,
                // ★ 0 次 DB 往返（内存预载）；缺它时线上会因跨洲往返而恒定超时
                pre: opts.lrtPre,
              }),
              BUCKET_TIMEOUT_MS,
              key,
            );
            const lv: LrtLive = res.ok
              ? {
                  kind: "lrt",
                  route: b.route,
                  state: res.state,
                  departures: res.departures.map((d) => d.depMs),
                  clocks: res.departures.map((d) => d.clock),
                  // ★ v3.2.0：与 departures 一一对应的秒级精准标记（缺省 → false）
                  precise: res.departures.map((d) => d.secPrecise ?? false),
                  directionName: res.directionName,
                  lineCode: res.lineCode,
                }
              : {
                  kind: "lrt",
                  route: b.route,
                  state: "no_data",
                  departures: [],
                  clocks: [],
                  directionName: null,
                  lineCode: b.route,
                };
            put(b.route, b.station, lv);
          }
          return { kind: b.kind, key, routes: b.kind === "bus" ? b.routes : [b.route], ms: Date.now() - bt, ok: true };
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          if (msg.startsWith("timeout:")) timedOut++;
          return {
            kind: b.kind,
            key,
            routes: b.kind === "bus" ? b.routes : [b.route],
            ms: Date.now() - bt,
            ok: false,
            note: msg.slice(0, 80),
          };
        }
      }),
    );
    items.push(...settled);
  }

  if (conflicts.length) {
    console.warn("[recommend/live] 同线路多上车站冲突：", conflicts.join(" · "));
  }

  return {
    live,
    stats: {
      buckets: buckets.length,
      dsatCalls,
      timedOut,
      ms: Date.now() - t0,
      items,
    },
  };
}

/**
 * 巴士桶查询：一次问该站在同一方向的 ≤6 条线（注入站序索引 → 0 次 per-route DB 往返）
 *
 * ★ 2026-11-06（问题 #6 · C5 复查结论）：第 5 个实参 `force` 由 `false` → **`true`**。
 *
 * `queryEta` 内部有一层**进程内 5s 缓存**（`dsat/eta.ts` 的 `g.__etaCache`，
 * 键 = `站|线路组|dir|dest`）—— 这是全链路里**唯一直接缓存「还有 N 站」原始数值**的地方。
 * 旧实现传 `false`，后果：
 *   · 用户点刷新（`reload({nocache:true})`）跳过的是**高德 OD 缓存**，
 *     而 DSAT 那层 5s 缓存**照读** ⇒ 5 秒内连点两次刷新，卡面数字**一个字节都不变**
 *     ⇒ 用户合理地认为「刷新没用 / 走的是缓存」。
 *   · 两个入口（推荐首屏 与 卡片详情）在 5s 内互相命中对方的缓存，
 *     明明是两次独立请求，却拿到同一份车辆位置。
 *
 * `force=true` 的语义（`dsat/eta.ts` 既有实现）：**跳过读取、仍然写回**。
 *   ⇒ 本次一定真实调 DSAT；同时把结果写回缓存供**其它**调用方（站卡 / 计时器）复用，
 *     不会把他们的防抖窗口一起打掉。
 *
 * 成本：`/api/nav` 的 DSAT 调用数不变（本来就是桶数 ≈ 9~13 次/请求，实测
 *   `dsat_call_logs` 里 `purpose='recommend'` 的节奏）。变的只是「不再命中 5s 旧值」。
 */
async function queryBusBucket(
  idx: RouteIndex,
  b: BusBucket,
): Promise<
  { route: string; ok: boolean; dir?: string; nearest?: EtaBus; second?: EtaBus; rest?: EtaBus[] }[]
> {
  const res = await queryEta(b.station, b.routes, "0", b.dest, true, undefined, idx, "recommend");
  return res.results as { route: string; ok: boolean; dir?: string; nearest?: EtaBus; second?: EtaBus; rest?: EtaBus[] }[];
}

/**
 * ★ v1.2.0：任意「站 × 线路组 × 下车点」的实时班次查询 —— 供**详情页**的
 * 「该站台剩余所有能到达目的地的路线」用（用户 2026-09-16 口径）。
 *
 * 为什么不复用 `fetchLive`：
 *   `fetchLive` 的桶由 `OptionSeed` 反推（只覆盖**本卡方案表**里的线路），
 *   而详情页要的是「该站台**所有**可达线路」——可能包含方案表外的线（实测 C653 就有 `N3`）。
 *   → 这里接受**显式构造的 jobs**，按 `(station, dest)` 分桶、每桶 ≤ `MAX_ROUTES_PER_BUCKET` 条线。
 *
 * ⚠️ 纯追加导出：**不改 `fetchLive` 的任何行为**；返回值按 `route@station` 键（同站多线不冲突，
 *    与 `fetchLive` 的「route → 首站」键不同，故不会互相污染）。
 * ⚠️ 同样走 `purpose='recommend'`（不进熔断判定、独立超时）。
 */
export async function fetchStationLive(
  pool: Pool,
  jobs: { station: string; dest: string; routes: string[] }[],
  idx: RouteIndex,
  segIdx: SegmentIndex,
  opts: { nowBucket: string; nowMs?: number },
): Promise<Map<string, BusLive>> {
  // ★ v3.5.0：pool 现用于「位置修正」的区间定位（locateSegmentOf 读 shape/里程表/时长表，模块级缓存）
  const nowBucket = opts.nowBucket;
  const out = new Map<string, BusLive>();

  // 分桶：(station, dest) → routes（再按 MAX_ROUTES_PER_BUCKET 切片）
  const byKey = new Map<string, { station: string; dest: string; routes: string[] }>();
  for (const j of jobs) {
    const k = `${j.station}|${j.dest}`;
    const cur = byKey.get(k) ?? { station: j.station, dest: j.dest, routes: [] };
    for (const r of j.routes) if (!cur.routes.includes(r)) cur.routes.push(r);
    byKey.set(k, cur);
  }
  const buckets: BusBucket[] = [];
  for (const b of byKey.values()) {
    for (let i = 0; i < b.routes.length; i += MAX_ROUTES_PER_BUCKET) {
      buckets.push({ kind: "bus", station: b.station, dest: b.dest, routes: b.routes.slice(i, i + MAX_ROUTES_PER_BUCKET) });
    }
  }

  for (let i = 0; i < buckets.length; i += BUCKET_CONCURRENCY) {
    const batch = buckets.slice(i, i + BUCKET_CONCURRENCY);
    await Promise.all(
      batch.map(async (b) => {
        const key = `${b.station}→${b.dest} [${b.routes.join(",")}]`;
        try {
          const res = await withTimeout(queryBusBucket(idx, b), BUCKET_TIMEOUT_MS, key);
          // ★ v3.5.0：位置修正——对本桶「在途车」拉 loc → 定位区间（超时/失败 → 静态降级）
          const moving = collectMoving(res);
          const locOf = await withTimeout(fetchLocSegments(pool, moving), LOC_FIX_TIMEOUT_MS, `locfix:${key}`).catch(
            () => new Map<string, VehicleSegmentLocation>(),
          );
          // ★ 2026-09-21：站级实时（非路线推荐链路）暂不做「未发车估算」⇒ headway 传 null，
          //   行为与旧版完全一致（等需要时再接，避免这次改动面扩散）。
          for (const r of res)
            out.set(
              `${r.route}@${b.station}`,
              buildBusLive(r, idx, segIdx, nowBucket, b.station, null, Date.now(), locOf),
            );
        } catch {
          // 超时/失败 → 该桶的线路不出现在结果里（调用方按「无实时数据」降级展示）
        }
      }),
    );
  }
  return out;
}
