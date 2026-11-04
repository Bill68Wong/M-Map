/**
 * 详情页纵向站条构建（src/lib/nav/strips.ts，v1.3.0 · T04）
 *
 * 把 `RecommendCard`（`.rides[].board/alight/route`）→ `SegmentStrip[]`
 * （**一趟一条**、含逐跳分钟与命中层级），供 `StationStrip` 渲染。
 * 与旧 `/card` 的 `strips` **同源同口径**：逐跳一律 `lookupHop`、`rideMin` = 卡面 `rides[i].minutes`。
 *
 * ⚠️ server-only（用 `segmentsOf` 解析站序）；`SegmentStrip` 是纯视图类型，可安全传客户端。
 * 设计：docs/设计-全澳导航-v1-20260918.md §C.9（详情页与旧版同构）
 */
import { segmentsOf } from "@/lib/recommend/enumerate";
import { lookupHop, type SegmentIndex } from "@/lib/recommend/segment-lookup";
import type {
  RecommendCard,
  RideLegView,
  RouteIndex,
  SegmentStrip,
  StripStop,
  TransferView,
} from "@/lib/recommend/types";

export interface StripBuildCtx {
  routeIdx: RouteIndex;
  segIdx: SegmentIndex;
  nameOf: Map<string, string>;
  /** ★ v3.4.0：查询时段桶（bucketOfRoute 五桶之一）——替代旧 weekday */
  nowBucket: string;
}

/** ★ v3.3.0（AC-103）：站条方向名 —— 仅轻轨段非空（取该段 `RideLegView.directionName`） */
export function stripDirLabelOf(ride: RideLegView): string | null {
  return ride.kind === "lrt" ? ride.directionName ?? null : null;
}

/**
 * ★ v3.3.0（AC-102）：该段**上车站实际可乘班车**（本库线码）—— 四规则（保守，宁回落主干不显错线）：
 *   ① 主干**常速**可赶（`tier ≥ 3`）→ 主干；
 *   ② 需提速才赶得上（`tier ∈ {1,2}`）且 `altBuses` 有可赶的**并行线** → 取其中 `totalMin` 最早者；
 *   ③ 无法判定（`tier === null`）/ 无并行线 → 主干；
 *   ④ 并行线数据缺失 → **回落主干**（不得显错线）。
 *   仅**首段**（上车站语义）有意义；其余段恒回主干。
 */
export function boardRouteOf(card: RecommendCard, i: number): string {
  const ride = card.rides[i];
  if (!ride) return "";
  const main = ride.route;
  if (i !== 0) return main;
  const parallels = ride.parallelRoutes ?? [];
  if (!parallels.length) return main;
  if (ride.tier === null || ride.tier === undefined) return main; // ③ 无法判定
  if (ride.tier >= 3) return main; // ① 常速可赶 → 主干
  const alt = (card.altBuses ?? []).filter((a) => parallels.includes(a.route));
  if (!alt.length) return main; // ④ 数据缺失 → 不显错线
  return alt.reduce((b, a) => (a.totalMin < b.totalMin ? a : b)).route; // ② 最早可赶并行线
}

/** 构建每段载具的站条（`card.rides` 与返回数组**一一对应**） */
export function buildStrips(card: RecommendCard, ctx: StripBuildCtx): SegmentStrip[] {
  return card.rides.map((ride, i) => {
    const seg = segmentsOf(ctx.routeIdx, ride.route, ride.board, ride.alight);
    // ★ 【2a】站条范围 = **用户实际上车点 → 下车点** 的切片，而不是整条线路（总站→总站）。
    //   `segmentsOf().stops` 是**整个方向**的完整站序（起点总站…终点总站），
    //   而 `segmentsOf().segs` 才是「board → alight」切片后的逐跳对
    //   ⇒ 必须用 segs 还原 codes（`[segs[0][0], ...segs.map(s => s[1])]`）。
    const codes =
      seg && seg.segs.length
        ? [seg.segs[0][0], ...seg.segs.map((s) => s[1])]
        : [ride.board, ride.alight];

    const stops: StripStop[] = codes.map((code, k) => {
      const isFirst = k === 0;
      const isLast = k === codes.length - 1;
      const next = codes[k + 1];
      const hop = !isLast && next ? lookupHop(ctx.segIdx, ride.route, code, next, ctx.nowBucket) : null;
      return {
        code,
        label: ctx.nameOf.get(code) ?? code,
        /**
         * ⚠️ 逐跳分钟**不受 `patchedCard` 影响**（本函数只从 card 取 `ride.minutes` / `waitMin` 等
         * 段级时间，`minToNext` 一律现查 `lookupHop`）⇒ 服务端下发的 `liveStrips` 与前端静态
         * `strips` 在这一列上**逐字节相同**。
         * 正因如此，前端 `NavDetailBody` 的「到下车**分钟**」可以用**静态** `strips` 的 `minToNext`
         * 与 `remainFromIdxOf` 配对（下标不会错位）；「还有几站」只吃 `lastIdx`，**不涉本列**。
         * ⇒ 若服务端将来只 patch 本列（分钟变、`stops.length` 不变），**只有「到下车分钟」要改读
         *   `liveStrips`**；若改的是 **`stops[]` 本身**（例如裁掉已走站），那两处都要跟 ——
         *   站数虽然不读 `minToNext`，但它吃 `lastIdx`，站序一变就会错位。
         */
        minToNext: hop ? hop.minutes : 0,
        level: hop ? hop.level : 0,
        role: isFirst ? "board" : isLast ? "alight" : "mid",
      };
    });

    // ★ 2026-09-27（用户需求 3）：换乘后一段（轻轨）的班次报时——供流程图换乘处渲染报时块
    const nxtLeg = card.rides[i + 1];
    const nextLeg =
      nxtLeg && nxtLeg.kind === "lrt" && nxtLeg.liveDepartures?.length
        ? {
            route: nxtLeg.route,
            dirLabel: nxtLeg.directionName ?? null,
            liveDepartures: nxtLeg.liveDepartures,
            liveClocks: nxtLeg.liveClocks ?? [],
            livePrecise: nxtLeg.livePrecise,
            mainMs: nxtLeg.liveMainMs,
          }
        : null;
    const t = card.transfers[i];
    /**
     * ★ B4（需求 7）：透传换乘等待/余量（`waitMin`/`slackMin`）⇒ 导航站条换乘行可显示
     *   「换乘 X · 步行 N 分 · 等车约 M 分」，并由 `slackMin` 派生观测钩子 H8。
     *
     * ★ v3.6.1（需求 7 冻结口径，改前先读 `types.ts#slackMin`）：
     *   · `waitMin` 进 `totalMin`；`slackMin` **只进 `cost`/风险信号**，两者不可互相替代；
     *   · `t.slackMin ?? null` 会把**同场换乘的 `undefined` 归一成 `null`** —— 这是**expected**：
     *     H8 用 `== null` 宽松判断，`null` 与 `undefined` **都落 `yes`**，所以归一不影响
     *     A4 的「同场换乘必须仍判 yes」断言（`sameField` 自身也独立透传，信息没丢）。
     *   · ⚠️ **禁止**把这行改成 `?? 0`（或任何默认值）：`0` 会走 `slack < 3 ⇒ tight`，
     *     把澳门最常见的同站台换乘整片染成 `tight`。`0` 只允许由 `model.ts` 三档赋值显式给出
     *     （档 ② 中位数兜底 / 档 ③ `SLACK_NO_DATA`），**不得在这里兜底**。
     */
    const transferAfter: TransferView | null = t
      ? {
          at: t.at,
          atLabel: t.atLabel,
          minutes: t.minutes,
          estimated: t.estimated,
          sameField: t.sameField,
          waitMin: t.waitMin ?? null,
          slackMin: t.slackMin ?? null,
        }
      : null;

    return {
      route: ride.route,
      kind: ride.kind,
      board: ride.board,
      alight: ride.alight,
      boardLabel: ride.boardLabel,
      alightLabel: ride.alightLabel,
      // ★ v3.3.0：AC-103 方向名 / AC-102 上车站实际可乘班车
      dirLabel: stripDirLabelOf(ride),
      boardRoute: boardRouteOf(card, i),
      stops,
      rideMin: ride.minutes,
      // ★ v2.3.0（B5.2）：秒级乘车时长直接从卡片腿回填（口径一致：仅 LRT_RIDE_SEC_FIXED 线非空）
      rideSecText: ride.rideSecText,
      transferAfter,
      nextLeg,
    };
  });
}
