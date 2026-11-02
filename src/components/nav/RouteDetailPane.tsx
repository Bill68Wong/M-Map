"use client";

/**
 * 详情 pane（src/components/nav/RouteDetailPane.tsx，2026-09-23 新增）
 *
 * 从 `RouteDetailSheet` 抽出「取数 + 渲染 `RouteDetailBody`」——现**两个消费方**共用：
 *   · `RouteSheet` 宿主的 detail pane（主页「出发 → 推荐 → 详情」）；
 *   · 收藏页 `RouteDetailSheet` 薄壳。
 * 数据由调用方下发（宿主用 `useRouteOverview`，收藏壳用 `useDetailBody`）⇒ 防两处漂移。
 *
 * ★ 2026-09-24：新增三类透传（均可选，收藏薄壳不传 ⇒ 与旧行为一致）：
 *   · `track`       —— 导航追踪态（开始导航 / 我已上车 / 实时进度 / 下车提醒）；
 *   · `destCoord`   —— 目的地坐标（「上车站其他线路 · 可切换方案」查询用）；
 *   · `onSwitchCard`—— 折叠栏「切过去」→ 打开新方案导航（宿主提供）。
 */
import { useMemo } from "react";
import NavDetailBody from "./NavDetailBody";
import { snapshotOfCard, routeSegsOfCard } from "@/lib/favorites/snapshot";
import type { FavoriteEndpoint } from "@/lib/favorites/types";
import type { RecommendCard } from "@/lib/recommend/types";
import type { DetailBody, FoldState } from "./useDetailBody";
import type { RideTrackView } from "./useRideTracking";

export interface RouteDetailPaneProps {
  card: RecommendCard;
  colors: Record<string, string>;
  /** 目的地展示名（末段步行终点文案） */
  destLabel: string;
  /** 顶部 OD 文案 */
  odLabel: string;
  /** 收藏入口数据（不传则不渲染收藏按钮） */
  fav?: { from: FavoriteEndpoint; to: FavoriteEndpoint; query: string } | null;
  /** 「本地推算」徽标 */
  degraded?: boolean;
  phase: "loading" | "ready" | "failed";
  body: DetailBody | null;
  reload: () => void;
  /**
   * ★ v3.7.0（C5）：折叠栏「本站台其他线路」的实时报站改为**展开时才查**。
   *   `foldState` 是唯一渲染判据（`idle/loading` 不得说「暂无到站信息」）；
   *   `onLoadFold` 由折叠栏首次展开时调用（幂等）。
   */
  foldState?: FoldState;
  onLoadFold?: () => void;
  /** ★ 2026-09-24：导航追踪态（主页链注入；收藏薄壳不传 = 静态详情） */
  track?: RideTrackView | null;
  /** ★ 2026-09-24：目的地坐标（GCJ-02；可切换方案查询用） */
  destCoord?: { lng: number; lat: number } | null;
  /** ★ 2026-09-24：点「切过去」→ 打开新方案导航 */
  onSwitchCard?: (card: RecommendCard, degraded: boolean) => void;
  /** ★ v3.6.0 S5：步行跟随入口（宿主提供； ⇒ 不渲染展开键） */
  onWalkStart?:
    | ((seg: "out" | "in", steps: import("@/lib/walk/walk-shared").WalkStep[]) => void)
    | null;
  onWalkExpand?: (seg: "out" | "in") => void;
  walkPreview?: import("./NavDetailBody").WalkPreview;
  /** ★ T1：末段步行预览（下车站 → 目的地） */
  walkInPreview?: import("./NavDetailBody").WalkPreview;
  /** ★ 2026-09-25：全屏化（导航中隐藏底导、收敛间距） */
  immersive?: boolean;
}

export default function RouteDetailPane({
  card,
  colors,
  destLabel,
  odLabel,
  fav = null,
  degraded = false,
  phase,
  body,
  reload,
  foldState,
  onLoadFold,
  track = null,
  destCoord = null,
  onSwitchCard,
  onWalkStart,
  onWalkExpand,
  walkPreview,
  walkInPreview,
  immersive = false,
}: RouteDetailPaneProps) {
  /** 收藏数据（纯函数在客户端现算：指纹 / 快照 / 流程图结构） */
  const favData = useMemo(() => {
    if (!fav) return null;
    const snap = snapshotOfCard(card);
    return {
      from: fav.from,
      to: fav.to,
      query: fav.query,
      fingerprint: snap.fingerprint,
      snapshot: snap,
      route: routeSegsOfCard(card),
    };
  }, [fav, card]);

  return (
    <div className="route-pane route-pane--detail" aria-label={`路线详情 ${odLabel}`}>
      {phase === "loading" && (
        <div className="cd-sk" aria-hidden="true">
          <span className="rc-sk rc-sk--big" />
          <span className="rc-sk rc-sk--line" />
          <span className="rc-sk rc-sk--line rc-sk--short" />
          <span className="rc-sk rc-sk--line" />
        </div>
      )}
      {phase === "failed" && (
        <p className="fav-note fav-note--warn t-label" role="status">
          详情加载失败（路线本身不受影响）。
          <button type="button" className="btn btn--text btn--sm" onClick={reload}>
            重试
          </button>
        </p>
      )}
      {phase === "ready" && body && (
        <NavDetailBody
          card={card}
          strips={body.strips}
          otherRoutes={body.otherRoutes}
          foldLive={body.foldLive}
          /** ★ v3.7.0（C5）：三态判据 + 按需取数入口（原样透传给折叠栏） */
          foldState={foldState}
          onLoadFold={onLoadFold}
          stationLabel={body.stationLabel}
          colors={colors}
          destLabel={destLabel}
          fav={favData}
          degraded={degraded}
          track={track}
          destCoord={destCoord}
          onSwitchCard={onSwitchCard}
          onWalkStart={onWalkStart}
          onWalkExpand={onWalkExpand}
          walkPreview={walkPreview}
          walkInPreview={walkInPreview}
          immersive={immersive}
        />
      )}
    </div>
  );
}
