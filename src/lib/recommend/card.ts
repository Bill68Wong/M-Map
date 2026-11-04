/**
 * 预测卡片**详情页**编排（src/lib/recommend/card.ts，v1.1.8）
 *
 * ⚠️ server-only（含 pg）—— client 组件**禁止** import 本模块；视图类型走 `./types`。
 *
 * 用户口径（2026-09-16）：
 *   · 折叠栏 = 该站台**剩余所有能到达目的地的路线**的报站；报站的车辆 = 第一辆 + 速度优于第 N 张卡的车
 *   · 站条 = **一趟一条**；中间站默认收起；左侧线路主题色轨；中间站之间给模型预测行驶时间
 *   · 详情页承担全部信息，外卡片只留摘要
 *
 * 三条必须守住的事实（已在实现里落实）：
 *   1. **站条的逐跳站点直接用 seed 的 `segments[].hops`** —— 而 `model.ts` 的车上时长正是
 *      `rideOfHops(segIdx, route, seg.hops, weekday)` 逐跳累加 ⇒ 用同一串 hops + 同一个
 *      `lookupHop` 算出的 `rideMin` 与卡片上的 `rides[i].minutes` **逐秒一致**。
 *      ⚠️ 禁止「站数 × 常数」（项目铁律）。
 *   2. **方案表外的线路没有 seed**（如 `N5`）⇒ 算不出总时长 → `minutes: null`，只展报站。
 *   3. 折叠栏那一批实时数据加**软闸**：整体超时 → `reports: []` + `liveDegraded: true`，绝不造假数据。
 */
import type { Pool } from "pg";
import { nowBucketOfHolidayAware } from "@/lib/rebuild/holidays";
import { etaTextOf } from "./catch-up";
import { loadHeadway, type HeadwayIndex } from "./headway";
import { RECOMMEND_LIMIT_DEFAULT } from "./limits";
import { modelOption } from "./model";
import { optionsFor, contextFor, loadStatics, type RecStatic } from "./query";
import { hideBySchedule, serviceStateAt } from "./schedule";
import { otherAlightsOf } from "./converge";
import { lookupHop } from "./segment-lookup";
import { recommend } from "./service";
import { destCodesFor, reachableFrom, kindOfRoute } from "./station-routes";
import { fetchStationLive } from "./live";
import { queryLrtDepartures } from "@/lib/lrt/next-departures";
import { buildCardHref } from "./card-link";
import { boardRouteOf, stripDirLabelOf } from "@/lib/nav/strips";
import type {
  AlightOption,
  CardDetailPayload,
  CatchTier,
  ReachReport,
  RecommendCard,
  SchoolZone,
  SegmentStrip,
  StripStop,
} from "./types";
import { LRT_MIN_PER_HOP } from "./types";

/** 折叠栏那一批实时数据的软闸（毫秒）——超时则整体降级，不让详情页卡死 */
const REPORT_DEADLINE_MS = 2_500;

/** 给 promise 加软闸；超时抛 `timeout:report` */
function withDeadline<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout:${tag}`)), ms)),
  ]);
}

export interface CardDetailInput {
  fromSlug: string;
  toSlug: string;
  zone: SchoolZone | null;
  limit?: number;
  /** 命中条件四元组（planId 不唯一，必须带 route/board/alight） */
  planId: number;
  route: string;
  board: string;
  alight: string;
  force?: boolean;
  nowMs?: number;
}

/**
 * 组织详情页数据。
 * @returns `card: null` = 该路线当前算不出卡（实时班次漂移 / 该线已收车）→ 页面提示「返回自動選線」
 */
export async function cardDetail(
  pool: Pool,
  input: CardDetailInput,
): Promise<{ ok: true; data: CardDetailPayload } | { ok: false; error: string }> {
  // ★ 2026-11-04（U10）：默认张数从 `limits.ts` 取（禁止字面量 —— 漏改一处就会出现
  //   「首屏 6 张、详情页按 5 张算」⇒ 第 6 张卡点进去报 `route_changed`）
  const limit = Math.max(1, Math.min(20, input.limit ?? RECOMMEND_LIMIT_DEFAULT));

  // ① 复用同一份 service 与它的 10s 缓存（不另开缓存层）
  // ★ 2026-11-04（U9）：带上 `pin` —— 详情页可能指向**非代表下车点**（已被同线收敛/名额裁掉），
  //   光靠 `rec.cards.find()` 必然拿不到 ⇒ 误报 `route_changed`。
  const rec = await recommend(pool, {
    fromSlug: input.fromSlug,
    toSlug: input.toSlug,
    zone: input.zone,
    limit,
    force: input.force,
    nowMs: input.nowMs,
    pin: { planId: input.planId, route: input.route, board: input.board, alight: input.alight },
  });
  const thresholdMin = rec.cards.length ? rec.cards[rec.cards.length - 1]!.totalMin : Number.POSITIVE_INFINITY;

  // ② 命中卡（planId 不唯一 → 必须四元组）；榜单里没有则回落到 `pin`（收敛前的同一对象引用）
  const card: RecommendCard | undefined =
    rec.cards.find((c) => {
      const r0 = c.rides[0];
      return c.planId === input.planId && r0?.route === input.route && r0.board === input.board && r0.alight === input.alight;
    }) ??
    rec.pinned ??
    undefined;
  if (!card) return { ok: false, error: "route_changed" };

  // ③ 静态层（Data Cache 命中，几乎零成本）
  const st: RecStatic = await loadStatics(pool);
  const nowMs = input.nowMs ?? Date.now();
  // ★ v3.4.0：查询上下文由「星期」升级为「时段桶」（bucketOfRoute 五桶）——见 segment-lookup 头注
  const nowBucket = await nowBucketOfHolidayAware(pool, nowMs);
  // ★ 2026-11-04（U8）：运营状态判定需要班距表（10 分钟进程内缓存，不额外打库）
  const headway = await loadHeadway(pool);

  /**
   * ★ 2026-11-04（U9）：**本方案实际用的下车点**优先。
   *
   * 折叠栏要按「这条线在这个站台实际会下哪一站」取实时数据。收敛之后
   * 「候选列表首项」与「本方案实际用的下车点」可能不一致 ⇒ 对**本卡自己的线路**
   * 必须用 `input.alight`（否则折叠栏算的是另一站，与卡面/站条对不上）；
   * 其他线路仍用它们各自的首选项。
   */
  const alightOfRoute = (r: { route: string; alights: string[] }): string =>
    r.route === input.route && input.alight ? input.alight : r.alights[0]!;

  // ④ 站条：每段载具一条。逐跳站点取 **seed 自己的 hops**（见文件头事实 1）
  const seeds = optionsFor(st, input.fromSlug, input.toSlug);
  const seed = seeds.find((s) => {
    const g0 = s.segments[0];
    return s.planId === input.planId && g0?.route === input.route && g0.board === input.board && g0.alight === input.alight;
  });
  const strips: SegmentStrip[] = [];
  for (let i = 0; i < card.rides.length; i++) {
    const ride = card.rides[i]!;
    const seg = seed?.segments[i];
    const hops = seg?.hops ?? [];
    // 用同一串 hops 逐跳取值 → 与 card.rides[i].minutes 同源同值
    let sum = 0;
    const stops: StripStop[] = [];
    for (let k = 0; k < hops.length; k++) {
      const [a, b] = hops[k]!;
      const hit = ride.kind === "lrt" ? { minutes: LRT_MIN_PER_HOP, level: 2 } : lookupHop(st.segIdx, ride.route, a, b, nowBucket);
      sum += hit.minutes;
      stops.push({
        code: a,
        label: st.routeIdx.nameOf.get(a) ?? a,
        minToNext: hit.minutes,
        level: hit.level,
        role: k === 0 ? "board" : "mid",
      });
    }
    if (stops.length) {
      const lastStop = stops[stops.length - 1]!;
      lastStop.minToNext = 0;
      lastStop.level = 0;
      lastStop.role = "alight";
    }
    strips.push({
      route: ride.route,
      kind: ride.kind,
      board: ride.board,
      alight: ride.alight,
      boardLabel: ride.boardLabel,
      alightLabel: ride.alightLabel,
      // ★ v3.3.0：AC-103 方向名 / AC-102 上车站实际可乘班车（与 `nav/strips.ts` 同源）
      dirLabel: stripDirLabelOf(ride),
      boardRoute: boardRouteOf(card, i),
      stops,
      // ⚠️ 用逐跳累加值；与卡片同源（hops 相同、lookupHop 相同）→ 断言相等
      rideMin: Math.round(sum * 10) / 10,
      transferAfter: card.transfers[i] ?? null,
    });
  }

  // ⑤ 折叠栏：该站台**全部可达线路**（不只本卡方案表）
  const destCodes = destCodesFor(st, input.toSlug);
  const reachable = reachableFrom(st.routeIdx, input.board, destCodes);

  // 每条线在自己的下车站上取值（不同线的 alight 不同 → 必须各自建 job）
  const busJobs = reachable
    .filter((r) => r.kind === "bus")
    .map((r) => ({ station: input.board, dest: alightOfRoute(r), routes: [r.route] }));

  let reports: ReachReport[] = [];
  let liveDegraded = false;
  try {
    const liveMap = await withDeadline(
      fetchStationLive(pool, busJobs, st.routeIdx, st.segIdx, { nowBucket, nowMs }),
      REPORT_DEADLINE_MS,
      "report",
    );
    reports = await buildReports(
      pool,
      st,
      input,
      card,
      reachable,
      liveMap,
      seeds,
      nowMs,
      nowBucket,
      thresholdMin,
      headway,
      alightOfRoute,
    );
  } catch {
    liveDegraded = true;
    reports = [];
  }

  // ⑥ ★ 2026-11-04（U9）：**备选下车点**（同线同站、不同下车点）—— 只在详情页出现，不进卡片列表
  const alightOthers = buildAlightOthers(st, input, seeds, headway, nowMs);

  return {
    ok: true,
    data: {
      fromSlug: input.fromSlug,
      toSlug: input.toSlug,
      zone: input.zone,
      card,
      colors: rec.colors,
      strips,
      reports,
      alightOthers,
      thresholdMin,
      generatedAt: rec.generatedAt,
      liveDegraded,
    },
  };
}

/**
 * ★ 2026-11-04（U9）：**另有 N 个下车点** —— 同一条线、同一上车站，但下车站不同。
 *
 * 候选集由纯函数 `converge.ts#otherAlightsOf` 给出（可单测、不碰 IO）；本函数只做两件事：
 *   ① 过 **U8 的同一谓词**；② 用 `buildCardHref` 拼详情地址（与卡片链接**同一份 URL 契约**
 *   ⇒ 点选即「换 alight 重进详情」，不需要任何新状态机）。
 *
 * ⚠️ 谓词这里取 `hasCar = true`：本函数的调用前提是「这张卡已经出出来了」⇒ 该线此刻确有车。
 *   作用不是过滤（这一格在判定表里恒显示），而是**单一来源**：将来若收紧
 *   `closed + 有车` 那一格，备选列表会自动跟随，不会留下「点开备选却是不可乘」的死角。
 */
function buildAlightOthers(
  st: RecStatic,
  input: CardDetailInput,
  seeds: ReturnType<typeof optionsFor>,
  headway: HeadwayIndex,
  nowMs: number,
): AlightOption[] {
  const state = serviceStateAt(headway, input.route, nowMs).state;
  if (hideBySchedule(state, true).hide) return [];
  return otherAlightsOf(input.route, input.board, input.alight, seeds, st.routeIdx.nameOf).map((a) => ({
    code: a.code,
    label: a.label,
    // 与卡片链接同一份契约（`buildCardHref`）⇒ 不需要新状态机，点选即「换 alight 重进详情」
    href: buildCardHref({
      from: input.fromSlug,
      to: input.toSlug,
      zone: input.zone,
      plan: a.planId,
      route: input.route,
      board: a.board,
      alight: a.code,
      limit: input.limit,
    }),
  }));
}

/** 组装折叠栏的行：每线取「第一辆可赶车 + 优于阈值的后车」，并用 `modelOption` 复算总时长 */
async function buildReports(
  pool: Pool,
  st: RecStatic,
  input: CardDetailInput,
  card: RecommendCard,
  reachable: ReturnType<typeof reachableFrom>,
  liveMap: Awaited<ReturnType<typeof fetchStationLive>>,
  seeds: ReturnType<typeof optionsFor>,
  nowMs: number,
  nowBucket: string,
  thresholdMin: number,
  headway: HeadwayIndex,
  alightOfRoute: (r: { route: string; alights: string[] }) => string,
): Promise<ReachReport[]> {
  const out: ReachReport[] = [];
  const ctx = contextFor(st, nowMs, input.zone, liveMap as Map<string, never>, nowBucket);

  for (const r of reachable) {
    // ★ U9：本卡自己的线路取「本方案实际用的下车点」（`input.alight`），其余线路取各自首选项
    const alight = alightOfRoute(r);
    const alightLabel = `${alight} ${st.routeIdx.nameOf.get(alight) ?? ""}`.trim();
    const boardLabel = `${input.board} ${st.routeIdx.nameOf.get(input.board) ?? ""}`.trim();

    /**
     * ★ 2026-11-04（U8）：折叠栏同样受「运营时间 ∧ 实时车」谓词约束 —— 否则会出现
     * 「卡片列表已经不含 N3，但详情页折叠栏里仍列着 N3（暂无实时报站）」的半修状态。
     * 有车证据取自本线在**本站台**的实时记录（`liveMap`）；没有记录 = 未知，
     * 未知在 `open` / `no_data` 下仍显示、在 `closed` 下隐藏（十二格表见 schedule.ts）。
     */
    const stat = serviceStateAt(headway, r.route, nowMs).state;
    const lvProbe = r.kind === "bus" ? liveMap.get(`${r.route}@${input.board}`) : null;
    const hasCar: boolean | null = lvProbe ? !lvProbe.empty : null;
    if (hideBySchedule(stat, hasCar).hide) continue;

    // 找该线的 seed（同线路 + 同方向的上车站）→ 用 modelOption 复算门到门总时长
    const seed = seeds.find((s) => {
      const g0 = s.segments[0];
      return g0 && g0.route === r.route && (g0.board === input.board || g0.board.split("/")[0] === input.board.split("/")[0]);
    });

    let minutes: number | null = null;
    /** 是否出现在在用方案表里（有 seed）—— `minutes === null` 时必须靠它区分两种成因 */
    const inPlan = !!seed;
    let tier: CatchTier | null = null;
    let tierText = "";
    let liveText = "";
    let liveDepartures: number[] | undefined;
    let liveClocks: string[] | undefined;
    /** ★ v3.2.0：与 liveDepartures 一一对应的秒级精准标记（折叠栏读秒同口径，AC-70） */
    let livePrecise: boolean[] | undefined;
    let live = false;
    let href: string | null = null;

    if (r.kind === "bus") {
      const lv = liveMap.get(`${r.route}@${input.board}`);
      if (lv && !lv.empty) {
        live = true;
        const n = lv.nearest;
        liveText = n ? `还有 ${n.stopsAway} 站 · ${etaTextOf(n)}` : "有车";
        // ★ 只把该线自己的 live 注入模型，避免其它线的实时数据污染（model.ts 的取用键是 route）
        if (seed) {
          const m = modelOption(seed, { ...ctx, live: new Map([[r.route, lv]]) as never });
          if (m) {
            minutes = m.card.totalMin;
            tier = m.card.rides[0]?.tier ?? null;
            tierText = m.card.rides[0]?.tierText ?? "";
            href = buildCardHref({
              from: input.fromSlug,
              to: input.toSlug,
              zone: input.zone,
              plan: m.card.planId,
              route: r.route,
              board: m.card.rides[0]!.board,
              alight: m.card.rides[0]!.alight,
              limit: input.limit,
            });
          }
        }
        if (!href) {
          href = buildCardHref({
            from: input.fromSlug, to: input.toSlug, zone: input.zone,
            plan: seed?.planId ?? card.planId, route: r.route, board: input.board, alight, limit: input.limit,
          });
        }
      } else {
        // ★ v1.1.8 修正：原先这里直接把 minutes 留成 null → 会和「方案表外」混为一谈。
        //   现在 minutes 仍为 null（本轮确实没有车、算不出门到门时长），
        //   但 UI 靠 inPlan 区分文案：「暫無實時車」（在方案里但没车）vs「未收錄於方案」（没 seed）。
        liveText = "暂无实时车";
      }
    } else {
      // 轻轨：直接问下一班（**必须带 pre**，否则线上跨洲往返恒定超时）
      try {
        const res = await queryLrtDepartures(pool, {
          station: input.board,
          route: r.route,
          dest: alight,
          take: 6,
          nowMs,
          pre: st.lrtPre,
        });
        if (res.ok && res.departures.length) {
          live = true;
          liveDepartures = res.departures.map((d) => d.depMs);
          liveClocks = res.departures.map((d) => d.clock);
          livePrecise = res.departures.map((d) => d.secPrecise ?? false);
          liveText = `${liveClocks[0]} 开出`;
        } else {
          liveText = "暂无实时报站";
        }
      } catch {
        liveText = "暂无实时报站";
      }
      href = buildCardHref({
        from: input.fromSlug, to: input.toSlug, zone: input.zone,
        plan: seed?.planId ?? card.planId, route: r.route, board: input.board, alight, limit: input.limit,
      });
    }

    out.push({
      route: r.route,
      kind: kindOfRoute(r.route),
      boardLabel,
      alightLabel,
      liveText,
      liveDepartures,
      liveClocks,
      livePrecise,
      alightCandidates: r.alights,
      minutes,
      inPlan,
      tier,
      tierText,
      href,
      live,
    });
  }

  // 用户口径：只保留「第一辆 + 速度优于第 N 张卡的车」——
  //   本卡自己必然在列（它的 totalMin 就是入选卡之一，≤ thresholdMin）；
  //   方案表外的线（minutes === null）无阈值可比 → 保留（只展报站），排最后。
  const kept = out.filter((x) => x.minutes === null || x.minutes <= thresholdMin + 1e-9);
  kept.sort((a, b) => {
    if (a.minutes === null && b.minutes === null) return a.route.localeCompare(b.route, "en", { numeric: true });
    if (a.minutes === null) return 1;
    if (b.minutes === null) return -1;
    return a.minutes - b.minutes;
  });
  return kept;
}
