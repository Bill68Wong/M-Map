/**
 * 「本站台其他线路 · 可切换方案」计算主体（src/lib/nav/switch-plans-compute.ts）
 *
 * 从 `src/app/api/nav/switch-plans/route.ts` 下沉出来的**业务编排**（路由只做校验/限流/合流/出站）。
 *
 * ── 口径 / 数据源（★ 与 planNav 的本地枚举分支同一条链路，**零高德调用**）─────
 *   `loadStatics`（已缓存）→ `loadStationGeoCached`（WGS84 站点地理）→
 *   `loadWalkCacheCached`（`walk_cache` 内存索引）→
 *   `searchStationPaths`（本地图枚举：k=8 / 800m / 换乘 ≤1 / 候选 ≤200）
 *   → **后置过滤**「首程上车站主码 = S 且首程线路 ≠ 当前线路」→ 按首程线路分组
 *   → `pathsToCandidates` → `candidatesToSeeds` → `fetchLive`（DSAT 实时 + 轻轨时刻表，一次性批量）
 *   → 逐候选 `modelOption` → 每组按 `totalMin` 升序、按 `chainRoutes@alightMain` 去重后保留 top-K。
 *
 *   ⚠️ 本链路**不消耗高德配额**；实时数据走既有 `fetchLive`（purpose 已按项目规矩排除熔断判定）。
 *
 * ── 坐标系（铁律）─────────────────────────────────────────────────────
 *   入参 `dest` 为 **GCJ-02**（客户端持有）；内部 `gcj02ToWgs84` 后参与本地图枚举。
 *   `fromWgs` = **当前方案首程上车站（S）的坐标** ⇒ 首段步行 ≈ 0（人在站上换线）。
 *
 * ── ★ 2026-11-06（问题 #6 · 杜绝实时巴士导航数据走缓存）────────────────────
 *   **本模块刻意不含任何缓存**。改动前本链路在 route 里有一层 **20s 进程内响应缓存**
 *   （键 = `主码|dest|当前首程线路`），缓存体里是 `plans[].card` —— 即**已算好的实时数字**
 *   （`liveText`「还有 N 站」/ `waitMin` / `totalMin` / `altBuses`）。
 *   20s 是 DSAT 自身 5s 粒度的 4 倍、也远超「车辆 12s 一帧」的可感知阈值
 *   ⇒ 详情页重复打开会看到 20s 前的到站读数。用户要求「从根源杜绝实时数据走缓存」，
 *   故该层已删除；防重复计算改由路由层做**在飞合流**（in-flight coalescing，
 *   只合并「同一刻正在进行」的重复请求，已完成的旧结果**永不复用**）。
 */
import type { Pool } from "pg";
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
   * ⚠️ 基准 =「当前方案**从本站起算**的余下时长」（已扣除用户已走完的出发步行 `walkOut`）。
   */
  deltaMin: number;
  /** ★ 组内最优（top-1，`totalMin` 最小者）—— 语义不变，向后兼容 */
  card: RecommendCard;
  /**
   * ★ v2.14.0（§3.4）新增可选：组内其余方案（top-2 ~ top-K），`totalMin` 升序，≤ `SIBLING_TOP_K - 1` 条。
   *   老客户端忽略本字段 ⇒ 只见主卡（零破坏）；新客户端子行 = `[card, ...(siblings ?? [])]`。
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
   * `totalMin` = 卡片原值（含出发步行）；`fromStopMin` = **从本站起算**的余下时长。
   */
  current: { route: string; totalMin: number; fromStopMin: number };
  plans: SwitchPlanItem[];
  /** 本次计算的**服务端时刻**（毫秒）。客户端可直接当「数据时刻」展示 */
  computedAt: number;
  /** 软降级说明（此时 `plans` 可为 `[]`）：`station_geo_missing|no_paths|no_candidates|no_live|internal` */
  degraded?: string;
}

export interface SwitchPlansInput {
  /** 客户端持有的当前方案卡（未打补丁的原卡） */
  card: RecommendCard;
  /** 目的地：GCJ-02 坐标 + 展示名 */
  dest: { lng: number; lat: number; name: string };
  /** 时间基准（默认 `Date.now()`；测试可注入） */
  nowMs?: number;
}

/** 段内候选排序口径：先直达（乘车段少）后换乘，再按总跳数（≈里程）短 → 长 */
const hopsOf = (p: StationPath): number => p.rides.reduce((a, r) => a + r.hops.length, 0);
const cmpPath = (a: StationPath, b: StationPath): number =>
  a.rides.length - b.rides.length || hopsOf(a) - hopsOf(b);

/** 响应外壳（`degraded` 分支与正常分支共用；`label` 装载后回填） */
function shellOf(card: RecommendCard) {
  const main = mainCodeOf(card.rides[0].board);
  const currentTotalMin = Number.isFinite(card.totalMin) ? card.totalMin : 0;
  /**
   * ★ delta 基准 =「当前方案**从本站起算**的余下时长」：
   *   用户此刻站在 S 站（已走完出发步行），拿「卡片全量 totalMin」当基准会把
   *   已走完的步行算成新方案的优势 ⇒ 按 `walkOut.minutes` 扣除（下限 0，四舍五入到 0.1）。
   */
  const walkOutMin = Number.isFinite(card.walkOut?.minutes) ? Number(card.walkOut.minutes) : 0;
  const currentFromStopMin = Math.max(0, Math.round((currentTotalMin - walkOutMin) * 10) / 10);
  return {
    main,
    currentRoute: card.rides[0].route,
    currentFromStopMin,
    shell: {
      ok: true as const,
      station: { code: main, label: null as string | null },
      current: { route: card.rides[0].route, totalMin: currentTotalMin, fromStopMin: currentFromStopMin },
    },
  };
}

/**
 * 计算「本站台其他线路」。**任何一步失败都软降级**（`ok:true` + `plans:[]` + `degraded`），
 * **绝不抛错**（含外壳构造阶段）—— 详情页不能被这个次级面板阻塞，也不能让在飞合流表里
 * 留下一个 rejected Promise（两个等待者会一起 500）。
 */
export async function computeSwitchPlans(pool: Pool, input: SwitchPlansInput): Promise<SwitchPlansResponse> {
  try {
    return await computeInner(pool, input);
  } catch (e) {
    // ★ 保底：连 `shellOf` 都失败（极端脏卡）也要给出结构合法的响应
    console.warn("[api/nav/switch-plans] 失败（软降级为空）：", (e as Error).message);
    const nowMs = input.nowMs ?? Date.now();
    return {
      ok: true,
      station: { code: "", label: null },
      current: { route: "", totalMin: 0, fromStopMin: 0 },
      plans: [],
      computedAt: nowMs,
      degraded: "internal",
    };
  }
}

async function computeInner(pool: Pool, input: SwitchPlansInput): Promise<SwitchPlansResponse> {
  const { card, dest } = input;
  const nowMs = input.nowMs ?? Date.now();
  const dLng = dest.lng;
  const dLat = dest.lat;
  const destName = dest.name;

  const { main, currentRoute, currentFromStopMin, shell } = shellOf(card);

  const degraded = (reason: string): SwitchPlansResponse => ({
    ...shell,
    plans: [],
    computedAt: nowMs,
    degraded: reason,
  });

  try {
    // ── ① 静态索引 + 站点地理（WGS84）→ fromWgs = 本方案首程上车站（S）坐标 ──
    const st = await loadStatics(pool);
    const nameOf = st.routeIdx.nameOf;
    shell.station.label = nameOf.get(main) ?? null;

    const geo = await loadStationGeoCached(pool);
    const gMain = geo.find((s) => s.main === main);
    if (!gMain) return degraded("station_geo_missing");
    const fromWgs = { lng: gMain.lng, lat: gMain.lat };
    const toWgs = gcj02ToWgs84({ lng: dLng, lat: dLat });

    // ── ② 本地图枚举（换乘 ≤1）──
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

    // ── ③ 按首程线路分组；组内排序；每组 1~6 条、全局 ≤120 ──
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

    // ── ④ 候选 → 种子（planId ≥ 900000，与高德方案不撞号）──
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

    // ── ⑤ 实时（全候选一次性批量：DSAT 巴士 + 本库轻轨时刻表）──
    const nowBucket = await nowBucketOfHolidayAware(pool, nowMs);
    // 发车间隔索引失败不影响出卡（fetchLive 传 null = 不估算，退化为旧行为）
    const headway = await loadHeadway(pool).catch(() => null);
    const batch = await fetchLive(pool, seeds, st.routeIdx, st.segIdx, {
      nowBucket,
      nowMs,
      lrtPre: st.lrtPre,
      headway,
    });

    // ── ⑥ 逐候选建模 ──
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

    // ── ⑦ 组装（组内 top-K：排序 → 去重 → 截断，纯逻辑见 `switch-plans-shared.splitPlanCards`）──
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

    return { ...shell, plans, computedAt: nowMs };
  } catch (e) {
    // ★ 优先软降级：枚举/建模失败也返回 ok:true + plans:[]，绝不 500 阻塞详情页
    console.warn("[api/nav/switch-plans] 失败（软降级为空）：", (e as Error).message);
    return degraded("internal");
  }
}
