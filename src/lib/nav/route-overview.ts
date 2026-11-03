/**
 * 路线总览切割纯函数（src/lib/nav/route-overview.ts，2026-09-23 新增）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   把「乘车段」映射到线路走向 polyline 上，切出「乘车区间（彩段）」与
 *   「同线路非乘车区间（灰段）」，并给出取景外包框 —— 供 `NavMap` 双层 polyline 绘制。
 *
 * ── 为什么单独成模块 ──────────────────────────────────────────────────
 *   · **client-safe**：前端组件直接 import；**绝不 import `pg`**（纯几何）；
 *   · **纯函数、零副作用** ⇒ 可 `scripts/test-route-overview.ts` 对拍（防沉默逻辑错误）。
 *
 * ── 坐标系铁律 ────────────────────────────────────────────────────────
 *   `route_shapes.polyline`（高德）与 `/api/stations`（DSAT→GCJ）**同为 GCJ-02**，
 *   可叠加；但**来源不同**（不同源）⇒ 用「**最近顶点 + 容差 TOL_M**」而非精确相等。
 *
 * ── 关键边界（Spec §10 / 附录 A.2.1）────────────────────────────────────
 *   · 环线（26 号，首尾同站）⇒ 首尾闭合检测 + **环绕切分**；
 *   · 起终点同站（board≈alight，分支 ④）⇒ 整线着色（不画区间外灰色）；
 *   · 超容差 / 数据缺失 / 切割失败 ⇒ **降级**（整线着色，`degraded=true`，`console.warn`）。
 *
 * ── 两消费方判据分叉点（本模块最易误伤处 —— 勿擅自统一）────────────────
 *   同一份 `ColoredLeg[]` 输出被两条链路消费，二者判「要不要补画灰底线 / 是否
 *   已正常切割」用的**不是同一条判据**：
 *     · 导航·绘制层（`nav-map-overview.ts` 的 `grayIsWhole`）—— 判**引用相等**：
 *       `colored !== gray` 时才补画灰底线 ⇒ `colored === gray` 即「整线着色」；
 *     · 行程·进度层（`useRideTracking.ts`）—— 判 **`!degraded`**（是否已成功
 *       切出乘车区间）。
 *   两条判据**仅在分支 ④（起终点同站）处取值相反**：此时 `degraded === false`
 *   但 `colored === gray`。分叉**行为良性** —— 导航侧同样整线着色（不补灰虚线），
 *   两链路视觉与语义一致。
 *   ⚠️ **禁止互替**：不得以 `!degraded` 代 `colored !== gray`（④ 会被误判成「非整线」、
 *      多画一条灰虚线 —— 即 v2.15 已修的回归）；反向替换同理。判据契约的权威出处见
 *      下方 `ColoredLeg.colored` JSDoc —— 本节仅为概览指针，勿重复维护。
 */

/** [lng, lat]（GCJ-02） */
export type LL = [number, number];

/** 站到线最近点容差（米）—— 超差视为该方向不含此站 */
export const TOL_M = 80;
/** 首尾闭合判定（米）—— 环线 */
export const LOOP_EPS_M = 25;
/** 起终点同站阈值（米）—— 整线着色 */
export const BOARD_EQ_ALIGHT_M = 50;
/** 灰底线抽稀步长（米） */
export const DECIMATE_STEP_M = 15;

/**
 * ★ 4-B−（需求 4）：候选弧的**可信下限**（相对于「跳数 × 平均站距」的倍率）。
 *
 * 弧长下限由两部分取大：
 *   ① **可证明的几何不变量**（三角不等式，无需任何调参）：
 *      `弧长 ≥ 起终点直线距离 − 两端到 shape 的投影距离`。
 *      因为路径「A 附近 → B 附近」的长度必然 ≥ 两点直线距离减去两端偏移。
 *      ⇒ 违反它的候选在几何上**不可能**成立，直接剔除。
 *   ② **本条线路的站距经验值**：`≥ 倍率 × 跳数 × 平均站距`
 *      （平均站距 = shape 全长 ÷ 停靠数，两者都不需要站点坐标）。
 *      ①只能挡住「比直线还短」的荒谬候选；②才能挡住「比直线长、但远短于真实
 *      乘车里程」的退化候选（实例 `12/0 M159→M257`：8 跳真实 3591m 被切成 1056m）。
 *
 * ⚠️ 只设**下限**、**不设上限**：上界会误伤「相邻两站本来就比平均站距近」的正常短程
 *   （实例 `51B/0 T375→T379`：平均站距 855m、实际 609m ⇒ 上界把它判死，
 *   反而选出绕行 4293m 的解）。「永不变长」由 `pickTripPair` 末尾的显式比较保证。
 */
export const ARC_MIN_PER_HOP_RATIO = 0.55;

/**
 * ★ 4-B−（需求 4）：「只缩短不延长」的**显式护栏倍率**。
 *
 * 语义：任何重选后的彩段弧长不得超过**现状解弧长**的该倍率，超出即丢弃该候选。
 *
 * ── 为什么是 1.3（实测敏感度，非推断）─────────────────────────────────
 *   现状解 `(iBoard0, iAlight0)` **本身就在候选池里**（见 `pickTripPair`），
 *   且择优规则是「取最短弧」⇒ 结果**结构性地**恒 ≤ 现状弧长。
 *   实测（93 线 × 方向 × 站距 1/2/4/8 = **9343 个有效样本**）：
 *   `新弧长 − 旧弧长` 的最大值 = **0.000m**（即从未出现过任何变长）。
 *   ⇒ 该倍率在 `[1.0, ∞)` 内取任何值，**对最终结果完全无影响**（四数恒定：
 *     改善 540 / 持平 8803 / 过短 0 / 过长 0 / 变长 0）。
 *
 *   取 1.3 的理由**不是**「调出更好结果」，而是选一个哨兵值：
 *   · 取 1.0 与「取最短弧」语义重复，且无法区分「本就是最短」与「被门拦下」；
 *   · 取 1.5 太松 —— 将来若有人把现状解移出候选池，1.4× 的绕远会被沉默放行；
 *   · 1.3 落在「常见接驳抖动（≤1.2×）之外、明显绕远（≥1.5×）之内」。
 *
 * ⚠️⚠️ **上表的前提**：它成立于「现状解 `(iBoard0, iAlight0)` **留在候选池里**」这一条。
 *   若将来有人把现状解移出候选池（例如为了允许「换一条更长的正确弧」），
 *   本护栏就从「非绑定哨兵」变成**真正承重的唯一防线**，1.3 的取值也**不再被实测覆盖** ⇒
 *   **必须先重跑 9343/9476 段对拍**（`.verify/_q4b-final4.ts`），确认过短/过长双双为 0，
 *   再决定是否改这个值。否则 1.3 会退化成「看起来有护栏、其实没人验过」的假保护。
 *
 * ⚠️ 历史依据：4-A 阶段（纯最短弧、现状解**不在**候选池）实测有 3/9531 段变长，
 *   正是本护栏要防的那类 —— 属「低频真实缺陷」，不是当前已发生的问题。
 */
export const MAX_GROW_RATIO = 1.3;

/** `POST /api/nav/detail-body` 返回的逐段几何锚点（与 `card.rides` 一一对应、同序） */
export interface OverviewLegInput {
  index: number;
  route: string;
  kind: "bus" | "lrt";
  color: string | null;
  board: { code: string; lng: number; lat: number } | null;
  alight: { code: string; lng: number; lat: number } | null;
}

/** ★ 4-B−：`/api/route-shapes` 的 `shapes[].stations[]` 元素（本方向站序，主码） */
export interface RouteStopSeq {
  code: string;
  seq: number;
}

/** `/api/route-shapes` 的 `shapes[]` 元素（子集） */
export interface RouteShapeLite {
  /** `dsat_dir` */
  dir?: string;
  /** "lng,lat;lng,lat;..."（GCJ-02） */
  polyline: string;
  startStop?: string | null;
  endStop?: string | null;
  /**
   * ★ 4-B−：本方向**站序**（主码、按 `seq` 升序、相邻重复已折叠）。
   *   缺省 / 空数组 ⇒ 无站序数据 ⇒ `chooseShape` **严格回落旧逻辑**（结果逐字节一致）。
   *   这是老响应缓存（`max-age=3600`）与轻轨线的正常状态，**不得**据此报错或降级。
   */
  stations?: RouteStopSeq[] | null;
}

/** 组装后的乘车段（供绘制 + 车辆方向） */
export interface ColoredLeg {
  index: number;
  route: string;
  kind: "bus" | "lrt";
  color: string | null;
  /** 选中方向（供 `/api/route-vehicles?dir=` 用） */
  dir: string | null;
  /** 所选方向整条线（灰底线，zIndex 68） */
  gray: LL[];
  /**
   * board→alight 乘车区间（彩段，zIndex 72）。
   *
   * ⚠️ **整线着色不变式（跨模块契约，勿改依赖方式）**：
   *   `colored === gray`（**引用相等**）⇔ 「整线着色」——两种来源：
   *     · 降级（①②③⑤：无 shapes / 缺坐标 / 双向超容差 / 切割失败）⇒ `degraded=true`；
   *     · 起终点同站（④，board≈alight）⇒ **`degraded=false`** 且 `colored===gray`。
   *   渲染层据此判定「是否再画灰底线」时**必须用本引用相等**（`nav-map-overview.ts` 的 `grayIsWhole`）；
   *   不可改判 `!degraded`——④ 会因 `degraded=false` 误判为非整线，多画一条灰虚线（回归）。
   *   对拍证据：`scripts/test-route-overview.ts` ⑧（整线着色 ∧ degraded===false）。
   */
  colored: LL[];
  /** true = 未切割成功 ⇒ colored === gray（整线着色）；**注意 ④ 同站整线着色为 false 但 colored===gray** */
  degraded: boolean;
}

/* ────────────────────────────── 基础几何 ────────────────────────────── */

/** "lng,lat;lng,lat;..." → 点列（非法段过滤；坐标非有限值丢弃） */
export function parsePolyline(s: string): LL[] {
  if (typeof s !== "string" || !s) return [];
  const out: LL[] = [];
  for (const seg of s.split(";")) {
    const parts = seg.split(",");
    if (parts.length !== 2) continue;
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    out.push([lng, lat]);
  }
  return out;
}

/** 两点距离（米）—— 等距近似：dLat·111320、dLng·111320·cos(lat)（取两点中点纬度） */
export function distM(a: LL, b: LL): number {
  const latMid = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (a[0] - b[0]) * 111320 * Math.cos(latMid);
  const dy = (a[1] - b[1]) * 111320;
  return Math.hypot(dx, dy);
}

/** 累积距离（米）；返回与 `pts` 等长数组，`[0]=0` */
export function cumDistM(pts: LL[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + distM(pts[i - 1], pts[i]));
  return out;
}

/** 最近**顶点**（小范围，欧氏近似足够） */
export function nearestOnPath(pts: LL[], p: { lng: number; lat: number }): { idx: number; distM: number } {
  let idx = 0;
  let best = Infinity;
  const q: LL = [p.lng, p.lat];
  for (let i = 0; i < pts.length; i++) {
    const d = distM(pts[i], q);
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  return { idx, distM: best };
}

/**
 * ★ 4-B−：「同一趟经过」的聚类间距（米）—— 相邻两次命中间隔超过它即视为**另一趟**。
 *
 * 为什么按**里程**而不是按索引间隔：各线顶点密度差 2 倍以上
 *   （25 号 913 点 / 29.8km ≈ 33m 每点；26 号 1676 点更密；N3 更疏），
 *   固定「隔 3 个顶点」在不同线路上代表的路程完全不同。
 */
export const PASS_CLUSTER_GAP_M = 120;

/**
 * ★ 4-B−：候选趟次的**投影邻近度上限**（相对最靠近的那一趟的倍数）。
 *
 * ── 为什么需要（实测，2026-11-03）────────────────────────────────────
 *   「同一站被经过两趟」时两趟的投影距离可能差一个数量级。实例 `10/dir0 M52`：
 *     · 趟① `distM = 5m`   （站点正对）
 *     · 趟② `distM = 80m`  （已到容差边缘，实际是下游另一个位置）
 *   若只按「最短弧」择优，会选趟② ⇒ 彩段起点距站点 **80m**（≈2~3 个顶点、
 *   约一个路口），用户看到的是「线从我这一站的下一个路口才开始画」。
 *   实测：835 个重选段里 **152 个锚点漂移 >30m、98 个 >50m、最大 +75m**。
 *   ⇒ 必须限制「只在**投影距离相当**的几趟之间比弧长」，不能为了缩短弧长
 *     把锚点甩到容差边缘。
 *
 * 取 3 倍：C652/C653 场景（16.8m vs 25.9m，比值 1.54）不被误伤；
 *   `M52` 场景（5m vs 80m，比值 16）被正确拒绝。
 *   同时设**绝对下限 25m**，避免「bestD 很小（如 1m）」时把 3m 之外的正常趟次挤掉
 *   （相邻两趟在同一站台两侧、各自 5~15m 是常见且合法的）。
 */
export const TRIP_PROXIMITY_RATIO = 3;
export const TRIP_PROXIMITY_MIN_M = 25;

/** ★ 4-B−：一次「趟次」（`from/to` = 该簇在 shape 上的索引区间；`idx` = 簇内最近顶点） */
export interface Trip {
  idx: number;
  distM: number;
  from: number;
  to: number;
}

/**
 * ★ 4-B−：≤ `tolM` 的**全部趟次**（按索引升序；每趟取簇内**最近顶点**为代表）。
 *
 * 三件事一起做，少一件都会出错：
 *   ① **信息完整**：同一站台被经过 k 趟时全部摊开（`nearestOnPath` 只留全局最小，
 *      「还有别的可能」这一信息被丢弃，调用方无从判断）；
 *   ② **聚类成趟**：连续命中的顶点属同一次经过，必须合并 —— 否则「最短弧」会从
 *      簇头取起点、簇尾取终点，把锚点从最近点漂到几十米外
 *      （实测 25 号：C653 的趟②最优代表是 i=539，若不聚类会选到 i=541，弧长从
 *      3549m 变成 3504m，验收靶子直接错位）；
 *   ③ **代表取最近**：簇内 `distM` 最小者才是该站台的落点。这是「锚点」语义，
 *      与「区间边界」不同，不能为了凑最短弧而移动它。
 *
 * ⚠️ `nearestOnPath` **保留不动**：它是对拍用例②的直测对象，也被
 *    `useRideTracking`（GPS 投影 / 安全网）import —— 替换它会越界改变两处行为。
 */
export function nearestTrips(
  pts: LL[],
  p: { lng: number; lat: number },
  tolM: number = TOL_M,
): Trip[] {
  const q: LL = [p.lng, p.lat];
  const out: Trip[] = [];
  let cur: Trip | null = null;
  /** 距上一次命中顶点累计的路程（判断「是否另起一趟」） */
  let runM = 0;
  let prevHit = -1;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) runM += distM(pts[i - 1], pts[i]);
    const d = distM(pts[i], q);
    if (d > tolM) continue;
    if (prevHit >= 0 && runM > PASS_CLUSTER_GAP_M) {
      if (cur) out.push(cur);
      cur = { idx: i, distM: d, from: i, to: i };
    } else if (!cur) {
      cur = { idx: i, distM: d, from: i, to: i };
    } else {
      cur.to = i;
      if (d < cur.distM) {
        cur.distM = d;
        cur.idx = i;
      }
    }
    prevHit = i;
    runM = 0;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * ★ 4-B−：沿索引从 `iFrom` 到 `iTo` 的里程（米）。
 *
 * · **非环线**：`|cum[iTo] − cum[iFrom]|` —— 与 `cutColored` 的两种切片
 *   （正向 / `reverse()`）长度一致：反转不改变点集，故里程相同。
 * · **环线**：`iTo ≥ iFrom` ⇒ 前向差；`iTo < iFrom` ⇒ **环绕弧**
 *   （`total − cum[iFrom] + cum[iTo]`），与 `cutColored` 的 concat 分支一一对应。
 *   ⚠️ 环线只算**索引递增**那一条弧 —— 因为 `cutColored` 从不产生反向弧，
 *     只算能真正画出来的弧，评分与绘制才不会打架。
 *
 * `cum` 可由 `cumDistM(pts)` 预先算好传入（组合枚举时避免 O(n·k²)）。
 */
export function arcMiles(
  pts: LL[],
  iFrom: number,
  iTo: number,
  loop: boolean,
  cum?: number[],
): number {
  const n = pts.length;
  if (n < 2) return 0;
  const c = cum ?? cumDistM(pts);
  const a = Math.max(0, Math.min(n - 1, iFrom));
  const b = Math.max(0, Math.min(n - 1, iTo));
  if (b >= a) return c[b] - c[a];
  if (!loop) return c[a] - c[b];
  /**
   * 环绕弧 = 后半段 + **闭合边** + 前半段。
   * 闭合边（末顶点 → 首顶点，≤ `LOOP_EPS_M`）必须计入 —— `cutColored` 的
   * `concat` 把两段拼成一个点列，`cumDistM` 在拼接处会算上这 1 条边；
   * 漏掉它会让「评分用的弧长」比「真正画出来的长度」少十几米（实测 16m）。
   */
  return c[n - 1] - c[a] + distM(pts[n - 1], pts[0]) + c[b];
}

/**
 * 是否环线：首尾站码相同 **或** 首尾顶点距离 ≤ LOOP_EPS_M。
 */
export function isLoop(pts: LL[], startStop?: string | null, endStop?: string | null): boolean {
  if (startStop && endStop && startStop === endStop) return true;
  if (pts.length < 2) return false;
  return distM(pts[0], pts[pts.length - 1]) <= LOOP_EPS_M;
}

/* ──────────────────────────────── 核心 ──────────────────────────────── */

export interface ChooseShapeResult {
  shape: RouteShapeLite;
  dir: string | null;
  iBoard: number;
  iAlight: number;
  dBoard: number;
  dAlight: number;
  /** 该 shape 的完整折线（省一次 parsePolyline） */
  pts: LL[];
  loop: boolean;
  /**
   * ★ 4-B−：站序判定的方向（`null` = 站序不可用，已回落旧逻辑）。
   *   `forward` = 站序递增方向上，shape 索引也应递增；`reverse` = 反之。
   *   仅供诊断与对拍断言，**不参与渲染**。
   */
  seqDir?: SeqDir;
  /** ★ 4-B−：是否发生「趟次重选」（`false` ⇒ 与旧 `nearestOnPath` 解完全一致） */
  repicked?: boolean;
}

/** ★ 4-B−：站序方向（`null` = 无站序数据） */
export type SeqDir = "forward" | "reverse" | null;

/** 站码归一（剥站台后缀）—— 与 `detail-body` 的 `legs[].board.code`（主码）同口径 */
function mainCodeOf(code: string): string {
  return code.replace(/\/\d+$/, "");
}

/**
 * ★ 4-B−：在**同一条 shape** 上，用「站序 + 单跳里程」挑一对 `(iBoard, iAlight)` 趟次。
 *
 * ── 为什么必须引入站序（实测，2026-11-03）────────────────────────────
 *   25 号线 C653 金峰南岸：shape 上 80m 内有**两趟**顶点
 *     · `[430..435]` 最近 i=433，距 C653 **16.8m**，距 C652 安順大廈 **5.0m**
 *     · `[538..543]` 最近 i=539，距 C653 **25.9m**，距 C652 16.9m
 *   「离 C653 更近」按纯几何排序**必然选 433**（16.8 < 25.9）—— 但 433 那一趟
 *   物理上就是安顺大厦的站台。⇒ **几何最近点在 20m 双台场景下无法定解**，
 *   唯一可靠判据是站序。
 *
 * ── 判据分工（缺一不可）───────────────────────────────────────────────
 *   ① **方向**（`wantIdxUp`）：取自**旧解的索引序** `iAlight0 ≥ iBoard0`。
 *      它回答的是「shape 是正向还是逆向**存储**的」，与站序位置无关 ⇒
 *      不受「同站多次经过」干扰。非环线据此只保留同向候选。
 *   ② **单跳下限**：弧长须 ≥ `跳数 × ARC_MIN_PER_HOP_M`，剔除退化成直线的假短弧。
 *      **只设下限不设上限**（理由见 `ARC_MIN_PER_HOP_M` 注释）。
 *   ③ **最短弧**：在剩余候选里取里程最小者。
 *   ④ **永不变长**：比旧解更长一律回落旧解。
 *
 * ── 站码重复的安全阀 ──────────────────────────────────────────────────
 *   环线会多次经过同一站（实测 101/103/10B/11/12 等线同一主码在站序里出现两次）。
 *   此时「第几次经过」无法判定 ⇒ **整段回落旧解**（不冒险，宁可少改不肯改错）。
 *   覆盖：实测 845/9467 ≈ 8.9% 的站段走这条回落路径。
 *
 * ── 严格回落条件（任一成立即返回旧解，逐字节等价于改动前）──────────────
 *   · 无 `stations`（老缓存 / 轻轨线）；· 站码不在站序里；· 站码出现多次；
 *   · 两站序位置相同；· 全部候选被判据剔除；· 结果比旧解更长。
 *   **回落永不更差**。
 */
function pickTripPair(
  pts: LL[],
  board: { lng: number; lat: number; code?: string },
  alight: { lng: number; lat: number; code?: string },
  loop: boolean,
  tolM: number,
  stations: RouteStopSeq[] | null | undefined,
  iBoard0: number,
  iAlight0: number,
): { iBoard: number; iAlight: number; seqDir: SeqDir; repicked: boolean } {
  const base = { iBoard: iBoard0, iAlight: iAlight0, seqDir: null as SeqDir, repicked: false };
  if (!stations || stations.length < 2) return base;
  if (!board.code || !alight.code) return base;

  /**
   * 站码 → **全部**站序位置。⚠️ 取「首次出现」是不成立的：环线会**多次经过同一站**
   * （实测 101/103/10B/11/12 等线都出现同一主码在站序里出现两次），首次出现会把
   * 「第 40 位 → 第 41 位」误判成「第 40 位 → 第 5 位」⇒ 方向判反。
   * ⇒ 只有「两个站码**各只出现一次**」时才用站序出方向与跳数；否则降级为
   *    「方向取自旧解索引序、跳过里程区间护栏」（下面 `unambiguous` 分支）。
   */
  const posB: number[] = [];
  const posA: number[] = [];
  stations.forEach((s, i) => {
    const k = mainCodeOf(s.code);
    if (k === mainCodeOf(board.code!)) posB.push(i);
    if (k === mainCodeOf(alight.code!)) posA.push(i);
  });
  if (!posB.length || !posA.length) return base;

  const unambiguous = posB.length === 1 && posA.length === 1;
  const pb = posB[0];
  const pa = posA[0];
  /** 站码在站序里出现多次 ⇒ 「第几次经过」不可判 ⇒ 直接回落旧解（不冒险） */
  if (!unambiguous || pb === pa) return base;

  const tb = nearestTrips(pts, board, tolM);
  const ta = nearestTrips(pts, alight, tolM);
  // 两个站都只有一趟 ⇒ 「重选」没有意义（与旧解一致）
  if (tb.length < 2 && ta.length < 2) return { ...base, seqDir: pa > pb ? "forward" : "reverse" };

  /**
   * ★ 投影邻近度闸门（理由与取值见 `TRIP_PROXIMITY_RATIO` 常量注释）：
   *   只保留「投影距离与最近的那一趟相当」的趟次，避免为缩短弧长把锚点甩到容差边缘。
   *   `(iBoard0, iAlight0)` 是全局最近点 ⇒ 天然在带内，故保底候选不受影响。
   */
  const nearTrips = (trips: Trip[], anchorIdx: number): Trip[] => {
    const best = Math.min(...trips.map((t) => t.distM));
    const lim = Math.max(best * TRIP_PROXIMITY_RATIO, TRIP_PROXIMITY_MIN_M);
    return trips.filter((t) => t.distM <= lim || t.idx === anchorIdx);
  };
  const tbIn = nearTrips(tb, iBoard0);
  const taIn = nearTrips(ta, iAlight0);
  if (tbIn.length < 2 && taIn.length < 2) return { ...base, seqDir: pa > pb ? "forward" : "reverse" };

  /**
   * ★ 方向基准：**旧解的索引序**（它反映 shape 是正向还是逆向**存储**的，
   *   与站序位置无关）。站序负责另两件事：① 诊断字段 `seqDir`；② 给出跳数。
   *   ⚠️ 不用站序直接定索引方向：非环线逆向存储的 shape 上「站序前向」对应的是
   *      **索引递减**，两者必须分开建模。
   */
  const wantIdxUp = iAlight0 >= iBoard0;
  const seqDir: SeqDir = pa > pb ? "forward" : "reverse";

  const cum = cumDistM(pts);
  const stopCount = stations.length;
  const total = cum[pts.length - 1];
  const avgHopM = total / Math.max(1, loop ? stopCount : stopCount - 1);
  /**
   * 期望跳数：环线可能**环绕**（下车站在站序里在上车站之前 ⇒ 实际跳数 = 绕回来那段）。
   */
  const hops = pa > pb ? pa - pb : loop ? stopCount - pb + pa : pb - pa;
  /** ② 本条线路的站距经验下限 */
  const hopFloor = ARC_MIN_PER_HOP_RATIO * hops * avgHopM;
  /** 起终点直线距离（① 三角不等式用；两个端点在同一坐标系，无需转换） */
  const straightM = distM([board.lng, board.lat], [alight.lng, alight.lat]);

  const baseArc = arcMiles(pts, iBoard0, iAlight0, loop, cum);

  /**
   * 现状解 `(iBoard0, iAlight0)` **作为保底候选**放进池子。
   * ⇒ 「所有候选都过不了门」时天然回落到原解（不是空值、不是更差的解），
   *   且因为择优是「取最短弧」，结果**结构性**恒 ≤ 现状弧长。
   */
  let pick: { iBoard: number; iAlight: number; arc: number } = {
    iBoard: iBoard0,
    iAlight: iAlight0,
    arc: baseArc,
  };
  let repicked = false;
  for (const x of tbIn) {
    for (const y of taIn) {
      if (x.idx === iBoard0 && y.idx === iAlight0) continue; // 原解已在池子里
      // ① 方向一致（环线不设约束：`cutColored` 的环绕分支对任意 (ib, ia) 都合法）
      if (!loop) {
        if (wantIdxUp && y.idx < x.idx) continue;
        if (!wantIdxUp && y.idx > x.idx) continue;
      }
      const arc = arcMiles(pts, x.idx, y.idx, loop, cum);
      // ② 可信下限：几何不变量（三角不等式）+ 线路站距经验值，取大
      const triFloor = straightM - x.distM - y.distM;
      if (arc + 1e-6 < triFloor || arc < hopFloor) continue;
      /**
       * ③ **只缩短不延长**（显式护栏）。`MAX_GROW_RATIO` 的取值依据见常量注释；
       *   因为原解在池中且择优取最短，本道门当前**非绑定**（结构性恒不长），
       *   它的价值是「将来若有人把原解移出候选集，这里会立刻拦住变长」。
       */
      if (Number.isFinite(baseArc) && arc > baseArc * MAX_GROW_RATIO) continue;
      // ④ 最短弧
      if (arc < pick.arc - 1e-9) {
        pick = { iBoard: x.idx, iAlight: y.idx, arc };
        repicked = true;
      }
    }
  }
  if (!repicked) return { ...base, seqDir };
  return { iBoard: pick.iBoard, iAlight: pick.iAlight, seqDir, repicked: true };
}

/**
 * 选方向：
 *   对每个 shape 求 board / alight 最近顶点距离；**剔除任一 > tolM 者**；
 *   在合法 shape 中取 `dBoard+dAlight` 最小者；并列优先「正向」（iBoard ≤ iAlight）。
 *   全部非法 → 返回 `null`（调用方走降级）。
 *
 * ★ 4-B−：**外层选向规则一字未改**（仍是 `dBoard + dAlight` 最小 + 正向 tiebreak）。
 *   改动只在**内层配对**：`iBoard / iAlight` 由 `pickTripPair` 结合站序重选。
 *   为什么不顺手改成「按弧长选 shape」：`ColoredLeg.dir` 会喂给
 *   `/api/route-vehicles?dir=`（车辆方向），改外层选向会翻转车辆 → 越界。
 *   且实测 61 条环线**全部只有 1 条 shape** ⇒ 跨 shape 按弧长选向在本库无收益。
 */
export function chooseShape(
  shapes: RouteShapeLite[],
  board: { lng: number; lat: number; code?: string },
  alight: { lng: number; lat: number; code?: string },
  tolM: number = TOL_M,
): ChooseShapeResult | null {
  let best: ChooseShapeResult | null = null;
  let bestScore = Infinity;
  for (const shape of shapes ?? []) {
    const pts = parsePolyline(shape.polyline);
    if (pts.length < 2) continue;
    const nb = nearestOnPath(pts, board);
    const na = nearestOnPath(pts, alight);
    if (nb.distM > tolM || na.distM > tolM) continue; // 该方向不含此站
    const score = nb.distM + na.distM;
    const loop = isLoop(pts, shape.startStop, shape.endStop);

    // ★ 4-B−：内层按站序重选配对（无站序 / 无更优解 ⇒ 原样返回旧解）
    const pair = pickTripPair(
      pts,
      board,
      alight,
      loop,
      tolM,
      shape.stations,
      nb.idx,
      na.idx,
    );

    const candidate: ChooseShapeResult = {
      shape,
      dir: shape.dir ?? null,
      iBoard: pair.iBoard,
      iAlight: pair.iAlight,
      dBoard: nb.distM,
      dAlight: na.distM,
      pts,
      loop,
      seqDir: pair.seqDir,
      repicked: pair.repicked,
    };
    /**
     * ★ D2（回归修复）：并列时的 tiebreak 必须用**旧解**的索引序 `nb.idx <= na.idx`，
     *   不能用重选后的 `pair.iBoard <= pair.iAlight`。
     *
     *   理由：本模块的 `dir` 会被 `useRideTracking` 当作
     *   `/api/route-vehicles?dir=` 的入参（车辆方向）。两个 shape 的
     *   `dBoard + dAlight` 打平时，若 tiebreak 依赖「站序重选后的索引序」，
     *   同一张卡在「有站序 / 无站序」两种输入下可能选出**不同方向** ⇒ 车辆图标
     *   拖错方向。用旧解的索引序则两者恒等价（无站序时 pair 就是旧解）。
     */
    const forward = nb.idx <= na.idx;
    const bestForward = best ? best.iBoard <= best.iAlight : false;
    if (
      score < bestScore - 1e-6 ||
      (Math.abs(score - bestScore) <= 1e-6 && forward && !bestForward)
    ) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * 切彩段（保证 `colored[0]=board`、`colored[-1]=alight`）：
 *   · 非环线：`iBoard <= iAlight` 取正向 `slice(ib, ia+1)`；
 *     `iBoard > iAlight`（存储几何与行驶方向相反）取 `slice(ia, ib+1).reverse()`；
 *   · 环线：`iAlight >= iBoard` 取正向切片；`iAlight < iBoard` **环绕**
 *     `slice(iBoard).concat(slice(0, iAlight+1))`。
 */
export function cutColored(pts: LL[], iBoard: number, iAlight: number, loop: boolean): LL[] | null {
  const n = pts.length;
  if (n < 2) return null;
  const ib = Math.max(0, Math.min(n - 1, iBoard));
  const ia = Math.max(0, Math.min(n - 1, iAlight));
  if (!loop) {
    if (ib <= ia) return pts.slice(ib, ia + 1);
    return pts.slice(ia, ib + 1).reverse();
  }
  if (ia >= ib) return pts.slice(ib, ia + 1);
  return pts.slice(ib).concat(pts.slice(0, ia + 1));
}

/**
 * 组装全部乘车段（多段换乘逐段处理）。
 * 决策表见附录 A.2.1；任一条件不满足 → 该段 `degraded=true`、`colored=gray`。
 */
export function buildColoredLegs(
  legs: OverviewLegInput[],
  shapesByRoute: Record<string, RouteShapeLite[]>,
  opts?: { tolM?: number; boardEqAlightM?: number },
): ColoredLeg[] {
  const tolM = opts?.tolM ?? TOL_M;
  const eqM = opts?.boardEqAlightM ?? BOARD_EQ_ALIGHT_M;
  return (legs ?? []).map((leg) => {
    const shapes = shapesByRoute?.[leg.route] ?? [];
    const base = {
      index: leg.index,
      route: leg.route,
      kind: leg.kind,
      color: leg.color,
    };

    // ① 无 shapes：不画线（降级，保持 colored===gray 引用）
    if (!shapes.length) {
      const empty: LL[] = [];
      return { ...base, dir: null, gray: empty, colored: empty, degraded: true };
    }

    // ② 缺坐标：用第一个 shape 整线着色（无方向信息）
    if (!leg.board || !leg.alight) {
      const first = shapes[0];
      const gray = parsePolyline(first.polyline);
      return { ...base, dir: first.dir ?? null, gray, colored: gray, degraded: true };
    }

    // ③ 选方向
    /**
     * ★ 4-B− 范围闸门：**只有巴士段吃站序**。
     *
     * 理由（风险隔离，不是能力缺失）：
     *   · 用户报告的缺陷域就是巴士段（地图上巴士彩段从对侧站台起画、绕路环一圈）；
     *   · 轻轨段的 `colored` 另有一套消费者 —— `useRideTracking` 的 `buildLrtLadder`
     *     （GPS 里程阶梯）、`cutAt`（安全网投影距离）、`youAt`（纵条用户点）、
     *     自动下车阈值，都按 `colored` 的里程推进。改轻轨彩段 = 动这套推进的基准，
     *     属于另一个子系统，须独立回归。实测轻轨段确实会变（如 氹仔线
     *     `LRT-OCH→LRT-JCK` 772m→678m，方向上是变准），但**本轮不顺手改**。
     *   · 接口对轻轨也下发了 `stations`（有用且无副作用），闸门只在前端这一处；
     *     将来要放开，删掉这个三元即可（一行、可逆）。
     */
    const pickShapes =
      leg.kind === "bus"
        ? shapes
        : shapes.map((s) => (s.stations ? { ...s, stations: null } : s));
    const picked = chooseShape(pickShapes, leg.board, leg.alight, tolM);
    if (!picked) {
      // 两方向都超容差 → 降级：第一个 shape 整线着色
      const gray = parsePolyline(shapes[0].polyline);
      console.warn(`[route-overview] ${leg.route} 两个方向均超容差(${tolM}m) ⇒ 整线着色降级`);
      return { ...base, dir: shapes[0].dir ?? null, gray, colored: gray, degraded: true };
    }

    const gray = picked.pts;
    const dir = picked.dir;

    // ④ 起终点同站 ⇒ 整线着色（非降级）
    const boardPt: LL = [leg.board.lng, leg.board.lat];
    const alightPt: LL = [leg.alight.lng, leg.alight.lat];
    if (distM(boardPt, alightPt) <= eqM) {
      return { ...base, dir, gray, colored: gray, degraded: false };
    }

    // ⑤ 正常切割
    const colored = cutColored(gray, picked.iBoard, picked.iAlight, picked.loop);
    if (!colored || colored.length < 2) {
      console.warn(`[route-overview] ${leg.route} 切割失败（iBoard=${picked.iBoard} iAlight=${picked.iAlight}）⇒ 降级`);
      return { ...base, dir, gray, colored: gray, degraded: true };
    }
    return { ...base, dir, gray, colored, degraded: false };
  });
}

/** 并集外包框（取景用；含起终点）—— 无点则 `null` */
export function unionBox(
  pathSets: LL[][],
  extra?: { lng: number; lat: number }[],
): { minLng: number; minLat: number; maxLng: number; maxLat: number } | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let n = 0;
  const eat = (lng: number, lat: number) => {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
    n++;
  };
  for (const set of pathSets ?? []) for (const p of set ?? []) eat(p[0], p[1]);
  for (const p of extra ?? []) eat(p.lng, p.lat);
  return n ? { minLng, minLat, maxLng, maxLat } : null;
}

/**
 * 灰底线抽稀：**保首尾**；相邻顶点 < `minStepM` 的中间点丢弃。
 * 用于削减数千点长线的绘制开销（彩段端点由调用方另行拼接，不受影响）。
 */
export function decimate(pts: LL[], minStepM: number = DECIMATE_STEP_M): LL[] {
  if (pts.length <= 2) return pts.slice();
  const out: LL[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (distM(pts[i], out[out.length - 1]) >= minStepM) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
