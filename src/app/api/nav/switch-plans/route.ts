/**
 * POST /api/nav/switch-plans —— 详情页「本站台其他线路 · 可切换方案」（2026-09-24 新增）
 *
 * ── 解决什么 ──────────────────────────────────────────────────────────
 *   用户在导航详情页看到「当前方案从 S 站坐 25 路」时，想知道**同一站台**还能坐别的哪条线、
 *   各自门到门要多久。本接口在服务端枚举「从 S 站出发、首程线路 ≠ 当前线路」的组合，
 *   逐个建模成**完整 RecommendCard** —— 前端拿到即可直接打开新导航界面（不重算）。
 *
 * ── 口径 / 数据源（★ 与 planNav 的本地枚举分支同一条链路，**零高德调用**）─────
 *   `loadStatics`（已缓存）→ `loadStationGeoCached`（WGS84 站点地理）→
 *   `loadWalkCacheCached`（`walk_cache` 内存索引）→
 *   `searchStationPaths`（本地图枚举：k=8 / 800m / 换乘 ≤1 / 候选 ≤200）
 *   → **后置过滤**「首程上车站主码 = S 且首程线路 ≠ 当前线路」→ 按首程线路分组
 *   → `pathsToCandidates` → `candidatesToSeeds` → `fetchLive`（DSAT 实时 + 轻轨时刻表，一次性批量）
 *   → 逐候选 `modelOption`（注入 `makeCacheWalkResolver` 的本地步行）→ 每组按 `totalMin` 升序、
 *     按 `chainRoutes@alightMain` 去重后保留 **top-K（`SIBLING_TOP_K`）**：top-1 = 主卡 `card`，
 *     其余 = `siblings`（§3.4「一父多子」）。
 *
 *   ⚠️ 本端点**不消耗高德配额**：全程不调用 `fetchTransitPlans` / `parseAndAmap` 等；
 *      实时数据走既有 `fetchLive`（其 purpose 已按项目规矩排除熔断判定，勿改）。
 *
 * ── 坐标系（铁律）─────────────────────────────────────────────────────
 *   请求 `dest` 为 **GCJ-02**（客户端持有）；服务端 `gcj02ToWgs84` 后参与本地图枚举
 *   （与 `planNav` 同口径）。`loadStationGeoCached` 出的站点地理本身即 **WGS84**。
 *   `fromWgs` = **当前方案首程上车站（S）的坐标** ⇒ 首段步行 ≈ 0（人在站上换线）。
 *
 * ── 降级 ──────────────────────────────────────────────────────────────
 *   任何一步失败（无候选 / 建模全被剔 / 意外异常）⇒ `ok:true` + `plans:[]` + `degraded:"<步骤名>"`，
 *   **绝不 500 阻塞详情页**；`400` 仅用于参数缺失 / 非法。允许的 degraded 值：
 *   `station_geo_missing` / `no_paths` / `no_candidates` / `no_live` / `internal`。
 *
 * ── 缓存 ──────────────────────────────────────────────────────────────
 *   20s 内存小缓存（键 = `主码|lng|lat|当前首程线路`），防详情页重复打开反复计算。
 *
 * 幂等：只读（本地索引 + DSAT 实时 + 内存缓存），无副作用。
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { gcj02ToWgs84 } from "@/lib/amap/coord";
import { nowBucketOfHolidayAware } from "@/lib/rebuild/holidays";
import { contextFor, loadStatics } from "@/lib/recommend/query";
import { loadHeadway } from "@/lib/recommend/headway";
import { fetchLive } from "@/lib/recommend/live";
import { modelOption } from "@/lib/recommend/model";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { RecommendCard } from "@/lib/recommend/types";
import { candidatesToSeeds, pathsToCandidates } from "@/lib/nav/enumerate-nav";
import { searchStationPaths, type StationPath } from "@/lib/nav/graph-search";
import { loadStationGeoCached, loadWalkCacheCached } from "@/lib/nav/nav-service";
import { makeCacheWalkResolver } from "@/lib/nav/recompute";
import { splitPlanCards } from "@/lib/nav/switch-plans-shared";
import type { NavCandidate, NavPoint } from "@/lib/nav/types";
import { API_ERROR, errorResponse } from "@/lib/http/errors";
import {
  DSAT_BUCKET_CAPACITY,
  DSAT_QPS,
  RATE_BUCKET,
  acquireToken,
} from "@/lib/amap/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 内存缓存 TTL（毫秒）——同 `/api/station/eta` 口径 */
const CACHE_TTL_MS = 20_000;
/** 每组（= 首程线路）最多建模候选数 */
const PER_GROUP_MAX = 6;
/** 全端点建模候选总数硬上限（超出按「先直达后换乘、先短后长」截断） */
const TOTAL_MAX_MODELED = 120;

/** 单个可切换方案（响应体 `plans[]` 元素） */
export interface SwitchPlanItem {
  /** 该方案首程线路（= 分组键） */
  route: string;
  /** 全部乘车段线路（含换乘），如 `["25","26A"]` —— 供 UI 画「标签→标签」 */
  chainRoutes: string[];
  /** 预测总时长（分钟，与卡片口径一致；**从 S 站起算** —— 人已在站上） */
  totalMin: number;
  /**
   * `totalMin − current.fromStopMin`（负 = 更快）。
   * ⚠️ 基准 =「当前方案**从本站起算**的余下时长」（已扣除用户已走完的出发步行 `walkOut`）——
   *   与 `totalMin` 同为「站上起算」，避免把「已走完的步行」算成新方案的优势。
   */
  deltaMin: number;
  /** ★ 组内最优（top-1，`totalMin` 最小者）—— 语义不变，向后兼容 */
  card: RecommendCard;
  /**
   * ★ v2.14.0（§3.4）新增可选：组内其余方案（top-2 ~ top-K），`totalMin` 升序，≤ `SIBLING_TOP_K - 1` 条。
   *   老客户端忽略本字段 ⇒ 只见主卡（＝v2.13 现状，**零破坏**）；新客户端子行 = `[card, ...(siblings ?? [])]`。
   *   该组只有 1 条走法时**不返回**本字段。
   */
  siblings?: RecommendCard[];
  /** 首程上车站主码（应 = `station.code`） */
  boardMain: string;
  /** 末程下车站主码 */
  alightMain: string | null;
  /** 末程下车站显示名 */
  alightLabel: string | null;
}

export interface SwitchPlansResponse {
  ok: true;
  /** 第一程上车站：主码 + 显示名 */
  station: { code: string; label: string | null };
  /**
   * 当前方案：首程线路 + 总时长。
   * `totalMin` = 卡片原值（含出发步行）；`fromStopMin` = **从本站起算**的余下时长
   * （= totalMin − walkOut；用户已走完的步行不计入）—— 即 `deltaMin` 的比较基准。
   */
  current: { route: string; totalMin: number; fromStopMin: number };
  plans: SwitchPlanItem[];
  computedAt: number;
  /** 软降级说明（此时 `plans` 可为 `[]`） */
  degraded?: string;
}

const g = globalThis as unknown as {
  __switchPlansCache?: Map<string, { ts: number; data: SwitchPlansResponse }>;
};
if (!g.__switchPlansCache) g.__switchPlansCache = new Map();

/** 段内候选排序口径：先直达（乘车段少）后换乘，再按总跳数（≈里程）短 → 长 */
const hopsOf = (p: StationPath): number => p.rides.reduce((a, r) => a + r.hops.length, 0);
const cmpPath = (a: StationPath, b: StationPath): number =>
  a.rides.length - b.rides.length || hopsOf(a) - hopsOf(b);

// ★ v2.14.0（§3.4）：组内 top-K（`SIBLING_TOP_K` / 组内 comparator / `dedupKeyOf` / `splitPlanCards`）
//   已抽到 `src/lib/nav/switch-plans-shared.ts`（纯函数，便于单测）—— 见该模块说明。

export async function POST(req: Request) {
  // ★ v3.6.0（S2 评审阻断 2）：本接口是全站**最高的匿名放大面** —— 一次请求会经 `fetchLive`
  //   打出 9~13 次 DSAT 调用。拆口令门后必须限流，否则一个脚本就能把 DSAT 配额和风控额度吃光。
  //   与 `/api/station/eta`、`/api/nav/detail-body` 共用 `dsat` 桶（复用 `amap_rate_bucket`，无 DDL）。
  //   ⚠️ 放在解析 body / 读库之前。
  const rl = await acquireToken(RATE_BUCKET.dsat, DSAT_QPS, DSAT_BUCKET_CAPACITY);
  if (!rl.ok) {
    return errorResponse(API_ERROR.rate_limited, undefined, { "Retry-After": "1" });
  }

  // ── ① 解析 + 校验（非法 → 400）──
  let body: { card?: RecommendCard; dest?: { lng?: unknown; lat?: unknown; name?: unknown } };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse(API_ERROR.bad_request);
  }
  const card = body?.card;
  if (!card || !Array.isArray(card.rides) || !card.rides.length) {
    return errorResponse(API_ERROR.bad_request);
  }
  for (const r of card.rides) {
    if (!r || typeof r.route !== "string" || typeof r.board !== "string" || typeof r.alight !== "string") {
      return errorResponse(API_ERROR.bad_request);
    }
  }
  const dLng = Number(body?.dest?.lng);
  const dLat = Number(body?.dest?.lat);
  if (!Number.isFinite(dLng) || !Number.isFinite(dLat)) {
    return errorResponse(API_ERROR.bad_request);
  }
  const destName = typeof body?.dest?.name === "string" ? body.dest.name.trim() : "";

  const main = mainCodeOf(card.rides[0].board);
  const currentRoute = card.rides[0].route;
  const currentTotalMin = Number.isFinite(card.totalMin) ? card.totalMin : 0;
  /**
   * ★ delta 基准 =「当前方案**从本站起算**的余下时长」：
   *   用户此刻站在 S 站（已走完出发步行），拿「卡片全量 totalMin」当基准会把
   *   已走完的步行算成新方案的优势 ⇒ 按 `walkOut.minutes` 扣除（下限 0，四舍五入到 0.1）。
   */
  const walkOutMin = Number.isFinite(card.walkOut?.minutes) ? Number(card.walkOut.minutes) : 0;
  const currentFromStopMin = Math.max(0, Math.round((currentTotalMin - walkOutMin) * 10) / 10);
  const nowMs = Date.now();

  // 响应外壳（降级分支复用同一 station/current 结构）
  const shell = {
    ok: true as const,
    station: { code: main, label: null as string | null },
    current: { route: currentRoute, totalMin: currentTotalMin, fromStopMin: currentFromStopMin },
  };
  const degraded = (reason: string): NextResponse<SwitchPlansResponse> =>
    NextResponse.json(
      { ...shell, plans: [] as SwitchPlanItem[], computedAt: nowMs, degraded: reason },
      { headers: { "Cache-Control": "no-store" } },
    );

  // ── ② 内存缓存（连点保护）──
  const ckey = `${main}|${dLng.toFixed(4)}|${dLat.toFixed(4)}|${currentRoute}`;
  const hit = g.__switchPlansCache!.get(ckey);
  if (hit && nowMs - hit.ts < CACHE_TTL_MS) {
    return NextResponse.json(hit.data, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const pool = getPool();
    const st = await loadStatics(pool);
    const nameOf = st.routeIdx.nameOf;
    shell.station.label = nameOf.get(main) ?? null;

    // ── ③ 站点地理（WGS84）→ fromWgs = 本方案首程上车站（S）坐标 ──
    const geo = await loadStationGeoCached(pool);
    const gMain = geo.find((s) => s.main === main);
    if (!gMain) return degraded("station_geo_missing");
    const fromWgs = { lng: gMain.lng, lat: gMain.lat };
    const toWgs = gcj02ToWgs84({ lng: dLng, lat: dLat });

    // ── ④ 本地图枚举（换乘 ≤1）──
    const paths = searchStationPaths(st.routeIdx, geo, fromWgs, toWgs, {
      k: 8,
      radiusM: 800,
      maxTransfers: 1,
      maxCandidates: 200,
      anchorFromMain: main,
    });
    // ★ 后置过滤：引擎会把「起终点附近 800m 的其他站」也算进来
    //   ⇒ 只保留「从 S 站出发」且「首程线路 ≠ 当前线路」的路径
    const kept = paths.filter(
      (p) => p.rides.length > 0 && mainCodeOf(p.rides[0].board) === main && p.rides[0].route !== currentRoute,
    );
    if (!kept.length) return degraded("no_paths");

    // ── ⑤ 按首程线路分组；组内排序；每组 1~6 条、全局 ≤120 ──
    const groups = new Map<string, StationPath[]>();
    for (const p of kept) {
      const arr = groups.get(p.rides[0].route);
      if (arr) arr.push(p);
      else groups.set(p.rides[0].route, [p]);
    }
    const bestPerGroup: { route: string; path: StationPath }[] = [];
    const extras: { route: string; path: StationPath }[] = [];
    for (const [route, list] of groups) {
      list.sort(cmpPath);
      // 首条进 bestPerGroup（保证「每组至少建模 1 条」），其余进 extras 参与全局排序
      list.slice(0, PER_GROUP_MAX).forEach((path, i) => (i === 0 ? bestPerGroup : extras).push({ route, path }));
    }
    extras.sort((a, b) => cmpPath(a.path, b.path));
    const chosen = [...bestPerGroup, ...extras].slice(0, TOTAL_MAX_MODELED);

    // ── ⑥ 候选 → 种子（planId ≥ 900000，与高德方案不撞号）──
    const from: NavPoint = { kind: "gps", label: shell.station.label ?? main, lng: fromWgs.lng, lat: fromWgs.lat };
    const to: NavPoint = { kind: "poi", label: destName || "目的地", lng: dLng, lat: dLat };
    /** OptionSeed.key → 首程线路（分组键），供建模后归组 */
    const candRoute = new Map<string, string>();
    const allCands: NavCandidate[] = [];
    for (const { route, path } of chosen) {
      for (const c of pathsToCandidates([path], from, to)) {
        if (candRoute.has(c.key)) continue;
        candRoute.set(c.key, route);
        allCands.push(c);
      }
    }
    if (!allCands.length) return degraded("no_candidates");
    const seeds = candidatesToSeeds(allCands, {
      planIdBase: 900_000,
      fromSlug: "gps",
      toSlug: card.toSlug || "poi",
    });

    // ── ⑦ 实时（全候选一次性批量：DSAT 巴士 + 本库轻轨时刻表）──
    const nowBucket = await nowBucketOfHolidayAware(pool, nowMs);
    // 发车间隔索引失败不影响出卡（fetchLive 传 null = 不估算，退化为旧行为）
    const headway = await loadHeadway(pool).catch(() => null);
    const batch = await fetchLive(pool, seeds, st.routeIdx, st.segIdx, {
      nowBucket,
      nowMs,
      lrtPre: st.lrtPre,
      headway,
    });

    // ── ⑧ 逐候选建模；每组收集全部卡片（组内 top-K 在组装段统一处理）──
    //   ★ B4（需求 7）：`headway` 同时注入模型上下文 —— 第 2 段巴士等车按到达时刻查班距（§h.2）。
    //   ⚠️ **偏好（prefs）不进本端点**：组内排序仍按 `totalMin`（07 §i.3 契约硬约束）。
    const baseCtx = {
      ...contextFor(st, nowMs, null, batch.live, nowBucket),
      destLabel: destName || undefined,
      headway: headway ?? undefined,
    };
    const geoOf = new Map<string, { lng: number; lat: number }>();
    for (const s of geo) geoOf.set(s.main, { lng: s.lng, lat: s.lat });
    const walkCache = await loadWalkCacheCached(pool);

    /** route → 该组建模成功的卡片（未排序/未去重，组装段再收敛） */
    const bestCards = new Map<string, RecommendCard[]>();
    for (const seed of seeds) {
      const route = candRoute.get(seed.key);
      if (!route) continue;
      const ctx = {
        ...baseCtx,
        walkResolver: makeCacheWalkResolver(seed, fromWgs, toWgs, geoOf, walkCache, nameOf),
      };
      const m = modelOption(seed, ctx);
      if (!m) continue;
      const arr = bestCards.get(route);
      if (arr) arr.push(m.card);
      else bestCards.set(route, [m.card]);
    }
    if (!bestCards.size) return degraded("no_live");

    // ── ⑨ 组装（组内 top-K：排序 → 去重 → 截断，纯逻辑见 `switch-plans-shared.splitPlanCards`）──
    const plans: SwitchPlanItem[] = [];
    for (const [route, cards] of bestCards) {
      const { card: mainCard, siblings } = splitPlanCards(cards);
      const last = mainCard.rides[mainCard.rides.length - 1];
      plans.push({
        route,
        chainRoutes: mainCard.rides.map((r) => r.route),
        totalMin: mainCard.totalMin,
        deltaMin: Math.round((mainCard.totalMin - currentFromStopMin) * 10) / 10,
        card: mainCard,
        ...(siblings ? { siblings } : {}),
        boardMain: mainCodeOf(mainCard.rides[0].board),
        alightMain: last ? mainCodeOf(last.alight) : null,
        alightLabel: last ? last.alightLabel : null,
      });
    }
    plans.sort((a, b) => a.totalMin - b.totalMin || a.route.localeCompare(b.route));

    const data: SwitchPlansResponse = { ...shell, plans, computedAt: nowMs };
    g.__switchPlansCache!.set(ckey, { ts: nowMs, data });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // ★ 优先软降级：枚举/建模失败也返回 ok:true + plans:[]，绝不 500 阻塞详情页
    console.warn("[api/nav/switch-plans] 失败（软降级为空）：", (e as Error).message);
    return degraded("internal");
  }
}
