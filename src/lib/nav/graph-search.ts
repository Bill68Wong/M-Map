/**
 * 本地图枚举 · 有界 BFS（src/lib/nav/graph-search.ts，v1.3.0 提案 · T03 / G4）
 *
 * ── 定位（设计 §B.5 / §B.6 / §G4）────────────────────────────────────
 *   本地 `route_stations` 图上搜「A→B」候选，换乘 ≤ `maxTransfers`（默认 2）。
 *   **两处复用**：① **补漏交付**（找高德没给的更优组合）；② **降级出卡**（高德不可用时）。
 *
 * ── 算法（有界 BFS / hub 组合）────────────────────────────────────────
 *   ① 近站点筛选（**降级路径的 R1 口径**）：起点/终点各取**最近 K=8 站、≤700m**（WGS 球面）；
 *   ② 沿线路（站序索引）算「起点站集合单程可达的 hub」与「能单程到达终点站的 hub」；
 *   ③ 组合：
 *      · 0 换乘：任一线 r，`a→b` 可顺向解出；
 *      · 1 换乘：hub h 同时「a 可达」与「可达 b」；
 *      · 2 换乘：hub h₁（a 可达）× hub h₂（可达 b），且存在中段线 rMid 连接 h₁→h₂
 *        （中段候选 = 两 hub 共有线路 → 交集很小，避免 O(hubs²·routes) 爆炸）；
 *   ④ 去重（键 = 线路@上→下 链）+ **候选数控制**（研究报告 §4.6 / 附录 C·§4S.2.4 处方）：
 *      · 全局硬上限 `maxCandidates`（防请求期超时）；
 *      · **链级变体限额** `perChainLimit`：同一条「链」（= 线路序列）只保留最优的若干个
 *        上下车站变体，避免同一链的多变体吃光名额、挤掉其它链与 2 换乘阶段；
 *      · **阶段预算** `stage1Share`：1 换乘阶段到点即收手，把剩余名额让给 2 换乘。
 *
 * ── ★ 已知局限（诚实，§B.6 已认可「本地可能漏」）──────────────────────
 *   · 换乘按**同一主码**（= 同物理站群，多站台已归一）处理 ⇒ 换乘步行计 0；
 *     真实的**跨街换乘**（不同主码、需走 100m）**不建模** ⇒ 本地候选取时偏乐观；
 *     ⇒ 故本地候选仍须过**质量闸门**（`merge-sources.ts`：站序可解 + 不与高德重复 +
 *        覆盖度 ≥0.5 + 非存疑；★ 自 2026-09-19 起**不再要求「必须快于高德最优」**）。
 *   · hub 组合是**有界**的（hub 限量、候选限量）⇒ **非穷举**（设计已接受）。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §B.5 / §B.6 / §G4；R1 §B.6「有界 BFS 换乘 ≤2」
 */
import { haversineM, type LatLng } from "@/lib/amap/coord";
import { segmentsOf } from "@/lib/recommend/enumerate";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { RouteIndex } from "@/lib/recommend/types";

/** 站点地理（**WGS84**，与我们库一致） */
export interface GeoStation {
  main: string;
  lat: number;
  lng: number;
}

export interface SearchOpts {
  /** 起/终点各取最近 K 站（默认 8） */
  k?: number;
  /** 近站半径（米，默认 700） */
  radiusM?: number;
  /** 最大换乘次数（默认 2） */
  maxTransfers?: number;
  /** 候选硬上限（默认 200） */
  maxCandidates?: number;
  /** 2 换乘时每侧 hub 限量（默认 25） */
  hubLimit?: number;
  /**
   * ★ 链级变体限额（默认 12）。
   *   一条「链」= 乘车段的**线路序列**（如 `3X|26A`，与上/下车站、换乘点无关）；
   *   同链的不同「上车站 × 换乘点 × 下车站」组合 = 该链的**变体**，共享同一个名额池。
   *   超限的变体**只跳过本变体、不终止搜索**——防止同一链的多变体吃光全局名额、
   *   挤掉其它链与 2 换乘阶段（§4.6 实测：修此点后本地漏线率 20.5% → 8.6%）。
   */
  perChainLimit?: number;
  /**
   * ★ 1 换乘阶段的候选预算占比（默认 0.6）。
   *   当 `results.length >= maxCandidates * stage1Share` 时**提前结束 1 换乘阶段**，
   *   把剩余名额留给 2 换乘。0 换乘不受此限（其有效候选数量天然很小）。
   */
  stage1Share?: number;
  /**
   * ★ v2.3.0（07 §3.7 软吸附）：**起点吸附锚站主码** —— 名称与起点 POI 重合的站，
   *   去重**前置**到 `SRC` 首位（即使超出 `radiusM` 半径也**额外纳入**）。
   *   缺省 = 不吸附（保持「最近站」逻辑不变）。
   */
  anchorFromMain?: string;
  /** ★ v2.3.0：**终点吸附锚站主码** —— 同上，作用于 `DST` */
  anchorToMain?: string;
  // ── ★ 2026-09-21：绕路治理（四项几何闸门，详见文件内 long comment）──
  /** 乘车里程 ÷ 起终点直线距离 的**上限**（超过即剔除）；默认 2.5 */
  maxDetourRatio?: number;
  /** 首段「上车站→下车站」方位与「起点→终点」方位的**最大夹角**（度）；默认 120 */
  maxFirstLegAngleDeg?: number;
  /** 换乘枢纽必须落在「起终点椭圆走廊」内，长轴 = 直线 × 此系数；默认 2.0 */
  corridorRatio?: number;
  /** 同一「首末站 × 线路序列」最多保留几条变体；默认 1 */
  perFamilyLimit?: number;
}

export interface RidePath {
  route: string;
  board: string;
  alight: string;
  hops: [string, string][];
}
export interface StationPath {
  rides: RidePath[];
  transfers: { at: string; to: string }[];
}

const DEFAULTS: Required<Omit<SearchOpts, "anchorFromMain" | "anchorToMain">> = {
  k: 8,
  radiusM: 700,
  maxTransfers: 2,
  maxCandidates: 200,
  hubLimit: 25,
  perChainLimit: 12,
  stage1Share: 0.6,
  // ★ 2026-09-21 绕路治理默认值（依据实测 240 条候选的倍率分布，见文件内注释）
  maxDetourRatio: 2.5,
  maxFirstLegAngleDeg: 120,
  corridorRatio: 2.0,
  perFamilyLimit: 1,
};

/** ★ v2.3.0 软吸附：把锚站去重**前置**到首位（命中则移前；不在列表内则**追加**） */
function withAnchor(list: string[], anchor?: string): string[] {
  if (!anchor) return list;
  return [anchor, ...list.filter((m) => m !== anchor)];
}

/** 取离 point 最近的主码（≤radius，最多 k 个；按距离升序） */
function nearestMains(geo: GeoStation[], point: LatLng, k: number, radiusM: number): string[] {
  const arr = geo
    .map((g) => ({ main: g.main, d: haversineM(point, { lat: g.lat, lng: g.lng }) }))
    .filter((x) => x.d <= radiusM)
    .sort((a, b) => a.d - b.d);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of arr) {
    if (seen.has(x.main)) continue;
    seen.add(x.main);
    out.push(x.main);
    if (out.length >= k) break;
  }
  return out;
}

/** 构建「主码 → 停靠线路集合」 */
function buildRoutesAt(routeIdx: RouteIndex): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const [key] of routeIdx.dirStops) {
    const [route] = key.split("|");
    const stops = routeIdx.dirStops.get(key)!;
    for (const code of stops) {
      const main = mainCodeOf(code);
      let s = m.get(main);
      if (!s) m.set(main, (s = new Set()));
      s.add(route);
    }
  }
  return m;
}

/** 该线该主码**顺向可达**的下游主码集合（任一方向）；缓存 */
function makeReachability(routeIdx: RouteIndex) {
  const cache = new Map<string, Set<string>>();
  return function reachableAfter(route: string, fromMain: string): Set<string> {
    const ck = `${route}|${fromMain}`;
    const hit = cache.get(ck);
    if (hit) return hit;
    const out = new Set<string>();
    for (const d of routeIdx.dirsOf.get(route) ?? []) {
      const stops = routeIdx.dirStops.get(`${route}|${d}`);
      if (!stops) continue;
      for (let i = 0; i < stops.length; i++) {
        if (mainCodeOf(stops[i]) !== fromMain) continue;
        for (let j = i + 1; j < stops.length; j++) out.add(mainCodeOf(stops[j]));
      }
    }
    cache.set(ck, out);
    return out;
  };
}

/** 该主码在该线上的**上游**主码集合（可达 from 的主码）；缓存 */
function makeReachabilityBack(routeIdx: RouteIndex) {
  const cache = new Map<string, Set<string>>();
  return function reachableBefore(route: string, toMain: string): Set<string> {
    const ck = `${route}|${toMain}`;
    const hit = cache.get(ck);
    if (hit) return hit;
    const out = new Set<string>();
    for (const d of routeIdx.dirsOf.get(route) ?? []) {
      const stops = routeIdx.dirStops.get(`${route}|${d}`);
      if (!stops) continue;
      for (let j = 0; j < stops.length; j++) {
        if (mainCodeOf(stops[j]) !== toMain) continue;
        for (let i = 0; i < j; i++) out.add(mainCodeOf(stops[i]));
      }
    }
    cache.set(ck, out);
    return out;
  };
}

const pathKey = (p: StationPath): string =>
  p.rides.map((r) => `${r.route}@${mainCodeOf(r.board)}>${mainCodeOf(r.alight)}`).join("|");

// ─────────────────── ★ 2026-09-21：绕路治理（四项几何判据）───────────────────
//
// 背景（实测事故）：本地枚举 240 条候选里，**96 条（40%）的乘车里程是直线距离的 5 倍以上**，
//   最严重的一条「黑沙海滩 → 十月初五马路」（直线 2115m）绕到 **27,795m / 13.14 倍** ——
//   它先坐 21A 到 C687、再坐 26A 一路往北到半岛的 **M172 亞馬喇前地**、最后坐 50 往回环市区。
//   根因：BFS 的 hub 判据**只保证「连通」，完全不看 hub 在哪、方向对不对**。
// ⇒ 本轮加四道几何闸门（**只作用于本地候选，不影响高德主路径**）。

/** 站点地理索引（主码 → 坐标） */
type GeoMap = Map<string, { lat: number; lng: number }>;

/** 一条候选的「乘车里程」（米）＝ 逐跳球面距离之和 */
function rideMeters(rides: RidePath[], geoOf: GeoMap): number {
  let m = 0;
  for (const r of rides) {
    for (const [a, b] of r.hops) {
      const pa = geoOf.get(mainCodeOf(a));
      const pb = geoOf.get(mainCodeOf(b));
      if (pa && pb) m += haversineM(pa, pb);
    }
  }
  return m;
}

/** 方位角（度，0=正北，顺时针） */
function bearingOf(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** 两个方位角的夹角（0~180°） */
function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * 椭圆走廊判据：点 `p` 是否落在以「起点 a、终点 b」为焦点、
 * 长轴 = `straight × maxRatio` 的椭圆内（`|a→p| + |p→b| ≤ 长轴`）。
 *
 * 用途：约束换乘枢纽（hub）不得离「起终点之间」太远 ⇒ 从源头阻断
 * 「绕到半岛再坐回来」这类往返绕圈（实测那条 13 倍绕路，hub 就是半岛的 M172）。
 */
function inCorridor(
  p: { lat: number; lng: number },
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  straight: number,
  maxRatio: number,
): boolean {
  return haversineM(a, p) + haversineM(p, b) <= straight * maxRatio;
}

/** 同族站阈值（米）：马路两侧站台一般相距 20~60m；120m 足够合并同族而不误并相邻站 */
const FAMILY_RADIUS_M = 120;

/**
 * ★ D 同族站归并：把距离 < `FAMILY_RADIUS_M` 的站视为**同一站族**（马路两侧 / 多站台），
 *   只保留列表中**靠前**的那个（调用方已按「离目标点距离升序」传入）。
 *
 * 解决什么：澳门巴士「马路两侧站名不同」，两侧都能上下车 —— 若两侧各生成一整批候选，
 *   既浪费名额、又容易出现「这侧上车、对面下车」的绕圈。归并后每族只出一个代表。
 */
function dedupeByFamily(list: string[], geoOf: GeoMap): string[] {
  const out: string[] = [];
  for (const m of list) {
    const p = geoOf.get(m);
    if (!p) {
      out.push(m);
      continue;
    }
    const dup = out.some((k) => {
      const q = geoOf.get(k);
      return q ? haversineM(p, q) < FAMILY_RADIUS_M : false;
    });
    if (!dup) out.push(m);
  }
  return out;
}

/**
 * ★ 2026-10-30：**环线跳站**的最小绕行里程（米）。
 *   低于此值的「绕回同族站」不改写上车站 —— 相邻站台沿路微移不属于绕圈。
 *   实测（T8 擎天匯 → 關閘廣場）：25/26/50/N3 由 C652 安順大廈 上车，
 *   需绕 6 站才回到 20m 外的 C653 金峰南岸。
 */
const LOOP_MIN_RIDE_M = 300;

/**
 * ★ 2026-10-30 **环线跳站**：`boardMain` 上车后若先绕一圈、再回到**物理相邻**的同族站
 *   （≤ `FAMILY_RADIUS_M`），返回该下游同族站主码 —— 在那里上车即可跳过绕圈。
 *
 * 判据（同一 `route|dir` 站序）：
 *   · `board` 之后、`alight` 之前存在下标 `k`；
 *   · `board → k` 沿站序累计里程 ≥ `LOOP_MIN_RIDE_M`（确为绕圈，非相邻站台微移）；
 *   · `stops[k]` 与 `board` 的球面距离 ≤ `FAMILY_RADIUS_M`。
 * 命中多个 ⇒ 取绕行里程最大者。
 */
function loopSkipBoardOf(
  routeIdx: RouteIndex,
  geoOf: GeoMap,
  route: string,
  boardMain: string,
  alightMain: string,
): string | null {
  const pb = geoOf.get(boardMain);
  if (!pb) return null;
  let best: { main: string; skipM: number } | null = null;
  for (const d of routeIdx.dirsOf.get(route) ?? []) {
    const stops = routeIdx.dirStops.get(`${route}|${d}`);
    if (!stops) continue;
    const mains = stops.map(mainCodeOf);
    const ais = mains.map((m, i) => (m === alightMain ? i : -1)).filter((i) => i >= 0);
    if (!ais.length) continue;
    for (let i = 0; i < mains.length; i++) {
      if (mains[i] !== boardMain) continue;
      const j = ais.find((x) => x > i); // 本方向上「该上车出现位置」之后仍能到达下车点
      if (j === undefined) continue;
      let run = 0;
      for (let k = i + 1; k < j; k++) {
        const prev = geoOf.get(mains[k - 1]);
        const cur = geoOf.get(mains[k]);
        if (prev && cur) run += haversineM(prev, cur);
        if (run < LOOP_MIN_RIDE_M || !cur) continue;
        if (mains[k] === boardMain) continue;
        if (haversineM(pb, cur) > FAMILY_RADIUS_M) continue;
        if (!best || run > best.skipM) best = { main: mains[k], skipM: run };
      }
    }
  }
  return best?.main ?? null;
}

/**
 * ★ 链键 = 乘车段的**线路序列**（与上/下车站、换乘点无关）。
 *   同一条链的多个「上车站 × 换乘点 × 下车站」组合 = 该链的**变体**，共享一个名额池
 *   （供 `perChainLimit` 链级限额使用）。
 */
const chainKeyOf = (rides: RidePath[]): string => rides.map((r) => r.route).join("|");

/**
 * 本地图枚举主入口。
 *
 * @param routeIdx 站序索引（`query.loadStatics().routeIdx`）
 * @param geo      站点地理（WGS84）
 * @param fromWgs  起点（**WGS84**；调用方须把 GCJ 的 GPS/POI 先 `gcj02ToWgs84`）
 * @param toWgs    终点（WGS84）
 */
export function searchStationPaths(
  routeIdx: RouteIndex,
  geo: GeoStation[],
  fromWgs: LatLng,
  toWgs: LatLng,
  opts: SearchOpts = {},
): StationPath[] {
  const o = { ...DEFAULTS, ...opts };
  const geoOf: GeoMap = new Map(geo.map((g) => [g.main, { lat: g.lat, lng: g.lng }]));
  /** 起终点直线距离（几何闸门的分母）；为 0 时全部闸门自动放行 */
  const straight = haversineM(fromWgs, toWgs);
  /** 「起点→终点」期望方位（首段方向一致性判据用） */
  const wantBearing = straight > 0 ? bearingOf(fromWgs, toWgs) : 0;

  // ★ v2.3.0：软吸附 —— 同名站锚站去重前置（即使超出半径也纳入，§3.7）
  // ★ 2026-09-21 D：**同族站归并** —— 距离 < 120m 视为同一站族（马路两侧 / 多站台），每族只留最近的一个
  const SRC = dedupeByFamily(withAnchor(nearestMains(geo, fromWgs, o.k, o.radiusM), o.anchorFromMain), geoOf);
  const DST = dedupeByFamily(withAnchor(nearestMains(geo, toWgs, o.k, o.radiusM), o.anchorToMain), geoOf);
  if (!SRC.length || !DST.length) return [];

  /** ★ C hub 走廊约束：枢纽必须落在「起终点椭圆走廊」内（缺坐标 ⇒ 放行） */
  const hubInCorridor = (main: string): boolean => {
    if (straight <= 0) return true;
    const p = geoOf.get(main);
    if (!p) return true;
    return inCorridor(p, fromWgs, toWgs, straight, o.corridorRatio);
  };

  const routesAt = buildRoutesAt(routeIdx);
  const reachAfter = makeReachability(routeIdx);
  const reachBefore = makeReachabilityBack(routeIdx);

  // ★ 变体优度排名：SRC/DST 已由 `nearestMains()` **按距离升序**返回 ⇒ 下标越小越优。
  //   同一链的变体按「board 在 SRC 中的位次 + alight 在 DST 中的位次」由优到劣产生
  //   （见 1 换乘阶段对 froms/tos 的排序）——这样被 `perChainLimit` 砍掉的是**较差**的变体。
  const srcRank = new Map<string, number>();
  SRC.forEach((m, i) => {
    if (!srcRank.has(m)) srcRank.set(m, i);
  });
  const dstRank = new Map<string, number>();
  DST.forEach((m, i) => {
    if (!dstRank.has(m)) dstRank.set(m, i);
  });
  /** 位次升序比较器（未收录 → 视为最末） */
  const byRank =
    (rank: Map<string, number>) =>
    (a: string, b: string): number =>
      (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER);

  const results: StationPath[] = [];
  const seen = new Set<string>();
  /** 链键 → 已保留的变体数（链级限额用） */
  const chainCount = new Map<string, number>();
  /**
   * 加入一条候选。
   * @returns `true` = **继续**（已加入 / 属重复 / 链级超限被跳过，但全局未满）；
   *          `false` = **全局名额已满**（`results.length >= maxCandidates`，调用方应停止）。
   *   ★ 语义理顺：原实现把「重复」也返回 `false`，会被调用方误判成「停止搜索」。
   */
  /** ★ 2026-09-21 E：同「首末站 × 线路序列」已保留的变体数（候选限流用） */
  const familyCount = new Map<string, number>();

  const ride = (route: string, a: string, b: string): RidePath | null => {
    if (mainCodeOf(a) === mainCodeOf(b)) return null;
    const seg = segmentsOf(routeIdx, route, a, b);
    if (!seg || !seg.segs.length) return null;
    return { route, board: a, alight: b, hops: seg.segs };
  };

  const add = (rawRides: RidePath[], transfers: { at: string; to: string }[]): boolean => {
    const full = (): boolean => results.length >= o.maxCandidates;
    let rides = rawRides;

    // ★ 2026-10-30 **环线跳站**：首段若绕 ≥`LOOP_MIN_RIDE_M` 后回到 ≤`FAMILY_RADIUS_M` 内的
    //   同族站，把上车站改到该下游站（起点步行距离由 `candidatesToSeeds` 按新站重算）。
    //   实测（T8 擎天匯 → 關閘廣場）：25/26/50/N3 由 C652 安順大廈 上车需绕 6 站才到 C653。
    //   ⚠️ 只改**首段**：中段改写会让 `transfers`（换乘点）与前后腿对不上。
    const r0 = rides[0];
    if (r0) {
      const skip = loopSkipBoardOf(routeIdx, geoOf, r0.route, mainCodeOf(r0.board), mainCodeOf(r0.alight));
      if (skip) {
        const nr = ride(r0.route, skip, r0.alight);
        if (nr) rides = [nr, ...rides.slice(1)];
      }
    }

    // ★ 2026-10-30 **换乘段环线**：中段同样是「上车后绕一圈回到同族站」时——本站的换乘口径
    //   只支持同一主码（步行 0，`transfer_walks` 也无近距跨站记录）⇒ 直接剔除该候选；
    //   只有上一段恰好也在跳过的那个站下车（可原地换乘）时才改写上车站。
    for (let i = 1; i < rides.length; i++) {
      const r = rides[i];
      const skip = loopSkipBoardOf(routeIdx, geoOf, r.route, mainCodeOf(r.board), mainCodeOf(r.alight));
      if (!skip) continue;
      if (mainCodeOf(rides[i - 1].alight) !== skip) return !full();
      const nr = ride(r.route, skip, r.alight);
      if (!nr) return !full();
      rides[i] = nr;
      transfers[i - 1] = { at: skip, to: skip };
    }

    // ★ 2026-10-30 **近邻腿否决**：任一段「上车站 ≈ 下车站（≤ `FAMILY_RADIUS_M`）」的乘车
    //   无意义（步行更快）⇒ 剔除整条候选（实测绕圈候选多由此产生）。
    for (const r of rides) {
      const a = geoOf.get(mainCodeOf(r.board));
      const b = geoOf.get(mainCodeOf(r.alight));
      if (a && b && haversineM(a, b) <= FAMILY_RADIUS_M) return !full();
    }

    // ★ 2026-09-21 新增：剔除「同一线路被重复乘坐」的候选。
    //
    //   实测事故（黑沙海滩 → 十月初五马路，22:00）：本地枚举产出
    //   `21A → 15T → 21A` —— 先坐 21A 一站，再乘 15T 折返回去，最后又坐回 21A；
    //   全程 40~47 分。而当高德的直达方案（26A，28 分）因**该时段已收班**被剔除后，
    //   这个荒谬组合竟成了**唯一结果** ⇒ 用户看到的就是「一堆绕路的怪方案」。
    //
    //   在澳门巴士网络里，同一线路在同一方案里出现两次几乎必然是坏解
    //   （真实换乘不会「坐回去再坐回来」）⇒ 宁可少给候选，也不给这种解 ✗
    const routes = rides.map((r) => r.route);
    if (new Set(routes).size !== routes.length) return !full();

    // ★ 2026-09-21 A：**几何绕路过滤** —— 乘车里程 ÷ 起终点直线距离 超过 `maxDetourRatio` 即剔。
    //   实测依据：本场景 240 条候选里 **96 条（40%）≥5×**，最严重一条达 **13.14×**
    //   （直线 2115m，却坐了 27,795m —— 先北上到半岛亞馬喇前地再南返回环）。
    if (straight > 0) {
      const dm = rideMeters(rides, geoOf);
      if (dm > straight * o.maxDetourRatio) return !full();
    }

    // ★ 2026-09-21 B：**首段方向一致性** —— 首段「上车站→下车站」的方位与「起点→终点」
    //   期望方位的夹角超过 `maxFirstLegAngleDeg`（默认 120°）即剔
    //   ⇒ 干掉「一上车就往反方向坐」的候选（实测有 15 条偏离 135° 以上）。
    if (straight > 0) {
      const f = rides[0];
      const pb = geoOf.get(mainCodeOf(f.board));
      const pa = geoOf.get(mainCodeOf(f.alight));
      if (pb && pa && angleBetween(bearingOf(pb, pa), wantBearing) > o.maxFirstLegAngleDeg) return !full();
    }

    // ★ 2026-09-21 E：**候选限流** —— 同一「首末站 × 线路序列」只保留 `perFamilyLimit` 条，
    //   避免同一走法的上百种变体（仅仅是换乘点微调）吃光全局名额。
    //   名额应装进「**不同走法**」，而不是同一走法的变体。
    const firstRide = rides[0];
    const lastRide = rides[rides.length - 1];
    const famKey = `${mainCodeOf(firstRide.board)}>${mainCodeOf(lastRide.alight)}|${chainKeyOf(rides)}`;
    if ((familyCount.get(famKey) ?? 0) >= o.perFamilyLimit) return !full();

    const k = pathKey({ rides, transfers });
    if (seen.has(k)) return !full(); // 重复：不新增，按当前是否满载决定续/停
    const ck = chainKeyOf(rides);
    if ((chainCount.get(ck) ?? 0) >= o.perChainLimit) return !full(); // 链级超限：跳过本变体（不终止搜索）
    seen.add(k);
    chainCount.set(ck, (chainCount.get(ck) ?? 0) + 1);
    familyCount.set(famKey, (familyCount.get(famKey) ?? 0) + 1);
    results.push({ rides, transfers });
    return !full();
  };

  // ── 0 换乘 ──
  const allRoutes = [...routeIdx.dirsOf.keys()];
  for (const r of allRoutes) {
    for (const a of SRC) {
      for (const b of DST) {
        const rd = ride(r, a, b);
        if (rd) add([rd], []);
        // ★ 硬上限校验（与 1 换乘阶段末尾同款语义）：到上限立即返回，防 0 换乘阶段退化为软上限
        if (results.length >= o.maxCandidates) return results;
      }
    }
  }
  if (results.length >= o.maxCandidates) return results;

  // ── 1 换乘 ──
  const reachFrom = new Map<string, { route: string; from: string }[]>();
  for (const r of allRoutes) {
    for (const a of SRC) {
      for (const h of reachAfter(r, a)) {
        if (h === a) continue;
        let arr = reachFrom.get(h);
        if (!arr) reachFrom.set(h, (arr = []));
        arr.push({ route: r, from: a });
      }
    }
  }
  const reachTo = new Map<string, { route: string; to: string }[]>();
  for (const r of allRoutes) {
    for (const b of DST) {
      for (const h of reachBefore(r, b)) {
        if (h === b) continue;
        let arr = reachTo.get(h);
        if (!arr) reachTo.set(h, (arr = []));
        arr.push({ route: r, to: b });
      }
    }
  }

  // ★ 1 换乘阶段预算：到点即收手，把剩余名额让给 2 换乘（研究报告 §4.6 处方）。
  const stage1Cap = Math.max(1, Math.floor(o.maxCandidates * o.stage1Share));
  stage1: for (const [hub, froms] of reachFrom) {
    const tos = reachTo.get(hub);
    if (!tos) continue;
    // ★ 2026-09-21 C：**hub 走廊约束** —— 换乘枢纽若落在「起终点走廊」外（如跑到半岛），
    //   几乎必然意味着往返绕圈（实测那条 13 倍绕路的 hub 就是半岛的 M172 亞馬喇前地）⇒ 跳过。
    if (!hubInCorridor(hub)) continue;
    // 变体优度：同一链优先产生「近上车站 × 近下车站」组合（SRC/DST 升序 ⇒ 位次即优度）。
    const fromsSorted = [...froms].sort((x, y) => byRank(srcRank)(x.from, y.from));
    const tosSorted = [...tos].sort((x, y) => byRank(dstRank)(x.to, y.to));
    for (const f of fromsSorted) {
      for (const t of tosSorted) {
        if (f.route === t.route) continue;
        const r1 = ride(f.route, f.from, hub);
        const r2 = ride(t.route, hub, t.to);
        if (!r1 || !r2) continue;
        add([r1, r2], [{ at: hub, to: hub }]);
        if (results.length >= o.maxCandidates) return results; // 全局满 → 2 换乘也无名额
        if (results.length >= stage1Cap) break stage1; // 阶段预算达成 → 让位 2 换乘
      }
    }
  }
  if (o.maxTransfers < 2 || results.length >= o.maxCandidates) return results;

  // ── 2 换乘（hub 限量，中段线取两 hub 共有线路交集）──
  const hub1 = [...reachFrom.keys()].slice(0, o.hubLimit);
  const hub2 = [...reachTo.keys()].slice(0, o.hubLimit);
  outer: for (const h1 of hub1) {
    for (const h2 of hub2) {
      if (h1 === h2) continue;
      // ★ 2026-09-21 C：两个枢纽都必须在「起终点走廊」内（同 1 换乘的判据）
      if (!hubInCorridor(h1) || !hubInCorridor(h2)) continue;
      const s1 = routesAt.get(h1);
      const s2 = routesAt.get(h2);
      if (!s1 || !s2) continue;
      const mids: string[] = [];
      for (const r of s1) if (s2.has(r)) mids.push(r);
      if (!mids.length) continue;
      // 变体优度：2 换乘同样先产生「近上车站（h1 侧）× 近下车站（h2 侧）」组合。
      const froms1 = [...(reachFrom.get(h1) ?? [])].sort((x, y) => byRank(srcRank)(x.from, y.from));
      const tos2 = [...(reachTo.get(h2) ?? [])].sort((x, y) => byRank(dstRank)(x.to, y.to));
      for (const rMid of mids) {
        const mid = ride(rMid, h1, h2);
        if (!mid) continue;
        for (const f of froms1) {
          if (f.route === rMid) continue;
          const r1 = ride(f.route, f.from, h1);
          if (!r1) continue;
          for (const t of tos2) {
            if (t.route === rMid) continue;
            const r3 = ride(t.route, h2, t.to);
            if (!r3) continue;
            if (!add([r1, mid, r3], [{ at: h1, to: h1 }, { at: h2, to: h2 }])) break outer;
          }
        }
      }
    }
  }
  return results;
}
