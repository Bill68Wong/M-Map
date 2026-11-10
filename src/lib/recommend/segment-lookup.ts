/**
 * 段时长回退链（src/lib/recommend/segment-lookup.ts，v4.1.0）
 *
 * 逐跳取「A 站开到 B 站要几分钟」。★ 链（依据 docs/量化方案-导航站间时长-20260927.md §6）：
 *   ① `(route,f,t,-1,当前桶,'stop')`  n≥5 → p50      ← 时段优先（新五桶 am_work/am_weekend/day/pm/night）
 *   ② `(route,f,t,-1,'all','stop')`    n≥1 → p50      ← 本线全周
 *   ③ `(route,f,t,-1,'all','all')`     n≥1 → p50/avg
 *   ④ **跨线邻接共享 · 当前桶**：任一线路的 `(f→t,-1,当前桶,'stop')` n≥5 → p50
 *   ⑤ 跨线邻接共享 · 任意行 n≥1（原 ④；邻接区间可跨线路复用——物理同源）
 *   ⑥ 该线「单站均值」× 1 跳
 *   ⑦ 全局「单站均值」× 1 跳
 *
 * ── v4.1.0 四处口径修正（负责人定案，改前先读）────────────────────────
 *   ① **末站样本可用**：`arrive_kind='terminal'` 的样本（到达末站 − 离开倒数第二站）
 *      在 `segment_stats` 里与 depart 样本同键聚合，因此「末站跳」不再落到 L6/L7。
 *      本文件的取值链**不加分支**：有样本即命中 L1~L5。
 *   ② ★ **口径由「是否末跳」决定（2026-11-09 负责人裁定，取代旧的「中途总站 ⇒ run」）**：
 *      `p50_minutes` 的定义是「离开 B − 离开 A」= **行驶 + B 站停站**。这个量怎么用
 *      **取决于这一跳是不是本次行程的最后一跳**：
 *        · **中间跳**（B 不是本次下车站）→ 车真的会在 B 停，乘客继续坐 ⇒ 停站是**真实等待**
 *          ⇒ 取 `total`（`p50_minutes`）；
 *        · **末跳**（B = 本次下车站）→ 乘客到 B 就下车，B 的停站发生在下车之后
 *          ⇒ 取 `run`（`p50_run_minutes`），无 run 时回退 `total`。
 *      旧实现按「中途总站」无条件改 `run` **不看是否末跳** ⇒ 中间跳漏算真实等待
 *      （司机休息的长停），同时其余末跳仍用 `total` 多算目的站停站；两个错误方向相反、
 *      部分抵消，所以一直没被发现。
 *      `SegmentIndex.midTerminus` **仅诊断用，不参与取值口径**（`test:mid-terminus` /
 *      `test:c654-isolation` 仍靠它断言数据侧身份）。
 *      不带 `final` 的调用方保持中间跳语义（`total`），行为不变。
 *   ③ **L6/L7 物理护栏**：兜底估算值若隐含速度 > 80 km/h 或 < 3 km/h（里程取沿线里程，
 *      `route_station_mileage` 推出的相邻对距离），说明这个「估算」不合物理
 *      ⇒ 展示值 `minutes` 返回 `null`（UI 显示「—」），而不是印出一个 215 km/h 的读数。
 *      **总数/ETA 仍用 `estMinutes`**（护栏前的值）：宁可在单跳展示上留白，
 *      也不让卡片总时长因缺值而系统性偏低（缺值方向的偏差是「用户赶不上车」）。
 *   ④ **联生圆形地总站（C654）入向隔离**：25 / 26 路在该站的长停是司机休息。
 *      按 ② 的新口径，这两条线**中间跳**仍取 `total`（含休息 —— 乘客在车上等，这是真实
 *      等待），**末跳**取 `run`；但其入向 `p50_minutes` **不进入跨线邻接池**，
 *      免得被同样经过 C654 的 50 / 26A / 21A / N3 等线路当作「普通中间跳」取用
 *      （那些线路的乘客不在 C654 等司机休息，取到含休息的值会系统性偏长）。
 *      **只排入向**（`to_main = C654`）：`minutes(A→C654)` 含休息；
 *      `minutes(C654→B)` = depart(B) − depart(C654)，不含休息，是干净数据，保留共享。
 *      名单见 `CROSS_ROUTE_EXCLUDED`；只影响 `byAdj`（L4/L5），不动 `byRoute`（L1~L3）。
 *
 * ⚠️ 全程 **mainCode 归一**（C690/3 ≡ C690、M9/2 ≡ M9）：同站多台是同一物理位置。
 */
import type { RouteIndex, SegmentStatRow } from "./types";

/** 站码主码归一：剥掉站台号后缀（C690/3 → C690、M9/2 → M9、T376/1 → T376） */
export function mainCodeOf(code: string): string {
  return /^[A-Za-z]+\d+/.exec(code)?.[0] ?? code;
}

/** 命中层级：1~7 = 回退链第 n 级（v3.4.0 七层） */
export type SegmentLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** run = 末跳纯行驶（扣下车站停站）；total = 含终点站停站的离开口径（中间跳的真实等待） */
export type HopBasis = "run" | "total";

/** L6/L7 物理护栏阈值（km/h）——全库实测最大隐含速度 91.2 km/h（仅 1 条），80 为合理上限 */
export const MAX_IMPLIED_KMH = 80;
/** 低于此速度的「兜底估算」同样不合物理（相邻两站不可能慢于步行） */
export const MIN_IMPLIED_KMH = 3;

/**
 * 跨线共享层（L4/L5）排除表 —— `route|toMain`
 *
 * 联生圆形地总站（C654）特例（负责人裁定）：
 *   25 / 26 路在该站的长停是**司机休息**（实测 25 路 4 条、26 路 3 条 dwell ≥5 分样本，
 *   最长 5.42 / 6.58 分），分钟数里含这段休息。按 2026-11-09 新口径，这两条线的**中间跳**
 *   仍取含休息的 `total`（乘客在车上等，是真实等待），**末跳**取 `run`；
 *   但其 `p50_minutes` 一旦进入跨线池，会被 50 / 26A / 21A / N3 等同样经过 C654 的线路
 *   当作普通中间跳取用（它们的乘客不在 C654 等司机休息）⇒ 污染别人的邻接段。
 *
 * ⚠️ 只排**入向**（`to_main = C654`）：`minutes(A→C654)` 含休息；
 *    `minutes(C654→B)` = depart(B) − depart(C654)，**不含**休息，是干净数据，保留共享。
 * ⚠️ 新增条目必须有实测依据（哪条线、哪个站、多少条长停样本），不许凭感觉加。
 *
 * ── 明确**不**纳入的（负责人 2026-11-09 裁定，勿擅加）────────────────────
 *   51|M9（關閘廣場）：该站有 3 条 dwell ≥5 分样本（最长 5.99 分，多算约 2.3 分），
 *     但**尚无证据是司机休息**（站名不含「總站」、10 条线共用 ⇒ 更像口岸排队）。
 *     负责人裁定：**不隔离**，正常走跨线共享与含停站的 `p50_minutes`。
 *   ⇒ 判据是「有司机休息证据」而不是「长停数值大」。数值大但机制不明的一律不动。
 */
export const CROSS_ROUTE_EXCLUDED: ReadonlySet<string> = new Set(["25|C654", "26|C654"]);

/**
 * ★ 批 1 · S-06（负责人 2026-11-09 裁定「到站时间只改 25/26 两段」）。
 *
 * 这两段的 `C656 → C654` 中间跳存在**司机休息证据**（与 `CROSS_ROUTE_EXCLUDED` 同源：
 * 25 路 4 条、26 路 3 条 dwell ≥5 分样本，最长 5.42 / 6.58 分），停站时长右偏，
 * `p50_minutes` 系统性偏乐观 ⇒ 该跳的「到站时间」改用 `avg_minutes`（含停站的真实等待）。
 *
 * ⚠️ 判据是**「有司机休息证据」**，不是「avg 比 p50 大」、也不是任何写死的分钟数。
 *    数值大但机制不明的站对（如 51|M9）一律不动（负责人裁定）。
 * ⚠️ 键是完整站对 `route|fromMain|toMain`（主码），只含这两段；26A 同段不在集合内。
 * ⚠️ 只影响**中间跳**（`final:false` → `total`）；末跳仍走 `p50_run_minutes`（run），
 *    所以「只坐一站到 C654 = 0.8」回归锚保持不变。
 */
export const DRIVER_REST_AVG_BASIS_HOPS: ReadonlySet<string> = new Set([
  "25|C656|C654",
  "26|C656|C654",
]);

export interface SegmentIndex {
  /** `route|mainF|mainT` → 该线路该邻接对的全部行 */
  byRoute: Map<string, SegmentStatRow[]>;
  /** `mainF|mainT` → 全部拥有该邻接对的线路的行（跨线共享，L4） */
  byAdj: Map<string, SegmentStatRow[]>;
  /** route → 该线单跳加权均值（L5） */
  routeHop: Map<string, number>;
  /** 全局单跳加权均值（L6） */
  globalHop: number;
  /**
   * `route|main` → 该线路的「中途总站」。
   * ⚠️ **仅诊断用，不参与取值口径**：口径自 2026-11-09 起由「是否末跳」(`opts.final`)
   * 决定，不再由「是否中途总站」决定（见文件头 ②）。保留此字段是因为
   * `test:mid-terminus` / `test:c654-isolation` 用它断言数据侧身份。
   */
  midTerminus: Set<string>;
  /** `route|mainF|mainT` → 沿线里程（米），仅 L6/L7 物理护栏使用 */
  hopMeters: Map<string, number>;
}

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 由 segment_stats 全量行构建内存索引（**只读一次库**，之后纯内存查询） */
export function buildSegmentIndex(
  rows: SegmentStatRow[],
  extras: { midTerminus?: ReadonlySet<string>; hopMeters?: ReadonlyMap<string, number> } = {},
): SegmentIndex {
  const byRoute = new Map<string, SegmentStatRow[]>();
  const byAdj = new Map<string, SegmentStatRow[]>();
  const hopAgg = new Map<string, { sum: number; n: number }>();
  let gSum = 0;
  let gN = 0;

  for (const r of rows) {
    const mf = mainCodeOf(r.from_station);
    const mt = mainCodeOf(r.to_station);
    const kr = `${r.route_code}|${mf}|${mt}`;
    if (!byRoute.has(kr)) byRoute.set(kr, []);
    byRoute.get(kr)!.push(r);

    // 跨线邻接池（L4/L5）：联生圆形地总站入向特例见 `CROSS_ROUTE_EXCLUDED`。
    // ⚠️ 只排除 `byAdj` 的**入向**行；`byRoute` 的写入必须保持原样（25/26 自己的查询走 L1~L3）。
    // ⚠️ `routeHop`（L6，各线自己的均值）与 `globalHop`（L7，全局均值）**不排除**：
    //    前者是「该线单站均值」，扣掉 C654 反而会让估算偏短；后者影响可忽略
    //    （25+26 在 C654 约 284 条样本 / 全库 20.7 万，占 0.14%）。
    const ka = `${mf}|${mt}`;
    if (!CROSS_ROUTE_EXCLUDED.has(`${r.route_code}|${mt}`)) {
      if (!byAdj.has(ka)) byAdj.set(ka, []);
      byAdj.get(ka)!.push(r);
    }

    // 单跳均值只取「兜底层」（weekday=-1 / bucket=all / kind=all），避免分层行重复计数
    if (r.weekday === -1 && r.time_bucket === "all" && r.arrive_kind === "all") {
      const avg = num(r.avg_minutes);
      if (avg !== null && r.samples > 0) {
        const a = hopAgg.get(r.route_code) ?? { sum: 0, n: 0 };
        a.sum += avg * r.samples;
        a.n += r.samples;
        hopAgg.set(r.route_code, a);
        gSum += avg * r.samples;
        gN += r.samples;
      }
    }
  }

  const routeHop = new Map<string, number>();
  for (const [k, v] of hopAgg) if (v.n > 0) routeHop.set(k, v.sum / v.n);

  return {
    byRoute,
    byAdj,
    routeHop,
    globalHop: gN > 0 ? gSum / gN : 1.5,
    midTerminus: new Set(extras.midTerminus ?? []),
    hopMeters: new Map(extras.hopMeters ?? []),
  };
}

export interface HopLookup {
  /** 可展示分钟；`null` = 兜底估算不合物理（隐含速度越界）⇒ UI 应显示「—」 */
  minutes: number | null;
  /** 累加用分钟（护栏前原值；L1~L5 与 minutes 相同）——卡片总时长 / ETA 只许用它 */
  estMinutes: number;
  level: SegmentLevel;
  /** run = 末跳优先纯行驶；total = 含终点站停站（中间跳的真实等待） */
  basis: HopBasis;
  /** 隐含速度（km/h）；仅在算得出里程时有值，供排查 */
  impliedKmh: number | null;
}

/** 行 → 取值（优先 p50，缺则 avg；★ S-06：司机休息证据站对的中间跳改用 avg）
 *
 *  · `DRIVER_REST_AVG_BASIS_HOPS` 命中 ⇒ 优先 `avg_minutes`；**必须带 `avg > 0` 回退**，
 *    否则真缺 avg 字段时中间跳与末跳会双双掉 L7、末跳 run 0.8 丢失
 *    （data-engineer 实跑证明的防御要求，#13 更正 1）。
 *  · 未命中 ⇒ 原逻辑不变（p50 优先，缺则 avg）。
 */
const valueOf = (r: SegmentStatRow): number | null => {
  const p = num(r.p50_minutes);
  const a = num(r.avg_minutes);
  const key = `${r.route_code}|${mainCodeOf(String(r.from_station ?? ""))}|${mainCodeOf(String(r.to_station ?? ""))}`;
  if (DRIVER_REST_AVG_BASIS_HOPS.has(key) && a !== null && a > 0) return a;
  if (p !== null && p > 0) return p;
  return a !== null && a > 0 ? a : null;
};

const pickRow = (
  rows: SegmentStatRow[] | undefined,
  pred: (r: SegmentStatRow) => boolean,
  minSamples: number,
): SegmentStatRow | null => {
  if (!rows) return null;
  const hit = rows.filter((r) => pred(r) && r.samples >= minSamples);
  if (!hit.length) return null;
  // 多行同时命中（如 stop/all 并存）→ 取样本最多的一行
  hit.sort((a, b) => b.samples - a.samples);
  return hit[0] ?? null;
};

// ── samples 门槛：**标定结论 = 1**（2026-09-15 探针 `.verify/rec-static-probe.ts` 实测）──
// 244 跳标定：n≥3 时 L1/L2 仅命中 24 跳（9.8%），大量真实实测样本被弃用 → 退化成「站均」拍脑袋值；
// n≥1 时 L1 19 跳、L2 覆盖 141 跳（57.8%），L4 覆盖 **82.0%**（200/244）。
// 判据：单条实测样本也远优于「单站均值」，故各层一律「有样本即用」，多层命中取样本最多者。

/**
 * 行取值 + 口径（2026-11-09 裁定：由「是否末跳」决定，不再看中途总站）。
 * · `opts.final === true`（B = 本次下车站）⇒ 优先 `p50_run_minutes`（纯行驶，扣掉 B 站停站）；
 * · 其余（中间跳 / 未声明）⇒ `p50_minutes`（含 B 站停站 = 真实等待）。
 * @param _idx 保留旧签名参数位；口径已不读索引（`midTerminus` 仅诊断用）
 */
function valueWithBasis(
  _idx: SegmentIndex,
  r: SegmentStatRow,
  opts: { final?: boolean } = {},
): { value: number; basis: HopBasis } | null {
  const total = valueOf(r);
  if (total === null) return null;
  if (opts.final) {
    const run = num(r.p50_run_minutes);
    if (run !== null && run > 0) return { value: run, basis: "run" };
  }
  return { value: total, basis: "total" };
}

/** 兜底估算的物理护栏（只作用于 L6/L7） */
function guardEstimate(
  idx: SegmentIndex,
  route: string,
  mf: string,
  mt: string,
  minutes: number,
): HopLookup {
  const rounded = Math.round(minutes * 10) / 10;
  const meters = idx.hopMeters.get(`${route}|${mf}|${mt}`);
  let impliedKmh: number | null = null;
  if (meters !== undefined && meters > 0 && rounded > 0) {
    impliedKmh = Math.round(((meters / 1000) / (rounded / 60)) * 10) / 10;
  }
  const implausible =
    impliedKmh !== null && (impliedKmh > MAX_IMPLIED_KMH || impliedKmh < MIN_IMPLIED_KMH);
  return {
    minutes: implausible ? null : rounded,
    estMinutes: rounded,
    level: 6,
    basis: "total",
    impliedKmh,
  };
}

/**
 * 查一跳的时长（分钟）。
 * @param nowBucket ★ v3.4.0：当前时段桶（`bucketOfRoute` 五桶之一）——替代旧的 `todayWeekday`。
 *   消费方由 `nowBucketOf(nowMs)`（src/lib/rebuild/buckets.ts）一键构造。
 * @param opts `final` = 这一跳的终点 B **就是本次下车站** ⇒ 用纯行驶（扣 B 站停站）。
 *   **默认 `false`（按中间跳 = 含停站）**：不传即保持旧调用方的中间跳语义；
 *   末跳调用方必须显式传 `{ final: true }`（`rideOfHops` / `strips` / `remaining` 已传）。
 */
export function lookupHop(
  idx: SegmentIndex,
  route: string,
  from: string,
  to: string,
  nowBucket: string,
  opts: { final?: boolean } = {},
): HopLookup {
  const mf = mainCodeOf(from);
  const mt = mainCodeOf(to);
  const routeRows = idx.byRoute.get(`${route}|${mf}|${mt}`);

  // ① 本线 · 当前时段桶 · stop（细层门槛 n≥5——实验②：n<5 噪声大于收益）
  const r1 = pickRow(routeRows, (r) => r.weekday === -1 && r.time_bucket === nowBucket && r.arrive_kind === "stop", 5);
  const v1 = r1 ? valueWithBasis(idx, r1, opts) : null;
  if (v1) return { minutes: v1.value, estMinutes: v1.value, level: 1, basis: v1.basis, impliedKmh: null };

  // ② 本线 · 全周 · stop
  const r2 = pickRow(routeRows, (r) => r.weekday === -1 && r.time_bucket === "all" && r.arrive_kind === "stop", 1);
  const v2 = r2 ? valueWithBasis(idx, r2, opts) : null;
  if (v2) return { minutes: v2.value, estMinutes: v2.value, level: 2, basis: v2.basis, impliedKmh: null };

  // ③ 本线 · 全周 · all
  const r3 = pickRow(routeRows, (r) => r.weekday === -1 && r.time_bucket === "all" && r.arrive_kind === "all", 1);
  const v3 = r3 ? valueWithBasis(idx, r3, opts) : null;
  if (v3) return { minutes: v3.value, estMinutes: v3.value, level: 3, basis: v3.basis, impliedKmh: null };

  // ④ 跨线邻接共享 · 当前时段桶 · stop（n≥5）
  //    （同一条实体马路，任意线路的样本皆可用——物理时长同源）
  const adj = idx.byAdj.get(`${mf}|${mt}`);
  const r4 = pickRow(adj, (r) => r.weekday === -1 && r.time_bucket === nowBucket && r.arrive_kind === "stop", 5);
  const v4 = r4 ? valueWithBasis(idx, r4, opts) : null;
  if (v4) return { minutes: v4.value, estMinutes: v4.value, level: 4, basis: v4.basis, impliedKmh: null };

  // ⑤ 跨线邻接共享 · 任意行（原 ④）
  const r5 = pickRow(adj, () => true, 1);
  const v5 = r5 ? valueWithBasis(idx, r5, opts) : null;
  if (v5) return { minutes: v5.value, estMinutes: v5.value, level: 5, basis: v5.basis, impliedKmh: null };

  // ⑥ 该线单站均值 × 1 跳（物理护栏）
  const per = idx.routeHop.get(route);
  if (per !== undefined && per > 0) return { ...guardEstimate(idx, route, mf, mt, per), level: 6 };

  // ⑦ 全局单站均值 × 1 跳（物理护栏）
  const g = idx.globalHop > 0 ? idx.globalHop : 1.5;
  return { ...guardEstimate(idx, route, mf, mt, g), level: 7 };
}

/** 一条载具段的行驶时长 = 逐跳累加（⚠️ 禁止「站数 × 常数」跳过逐跳，见项目铁律） */
export function rideOfHops(
  idx: SegmentIndex,
  route: string,
  hops: [string, string][],
  nowBucket: string,
): { minutes: number; levels: SegmentLevel[]; unshownHops: number } {
  let sum = 0;
  let unshownHops = 0;
  const levels: SegmentLevel[] = [];
  for (let i = 0; i < hops.length; i++) {
    const [a, b] = hops[i]!;
    // ★ 2026-11-09 裁定：**末跳只算纯行驶**（乘客在 B 下车，B 的停站发生在下车之后）；
    //   中间跳含停站（车真的会停，乘客继续坐 ⇒ 是真实等待）。
    const isFinal = i === hops.length - 1;
    const r = lookupHop(idx, route, a, b, nowBucket, { final: isFinal });
    // ⚠️ 累加必须用 estMinutes（护栏前的值）：minutes=null 只用于**展示**
    //    （见文件头 ③）。若这里加 0，卡片总时长会系统性偏低。
    sum += r.estMinutes;
    if (r.minutes === null) unshownHops++;
    levels.push(r.level);
  }
  return { minutes: sum, levels, unshownHops };
}

/** 仅供 RouteIndex 类型引用（避免 TS「未使用」告警） */
export type { RouteIndex };
