"use client";

/**
 * 全屏路线详情弹窗 · 薄壳（src/components/nav/RouteDetailSheet.tsx，2026-09-23 改造）
 *
 * ── 定位 ──────────────────────────────────────────────────────────────
 *   **收藏页 `ComboPlans`** 在用（无地图上下文）—— 首页「出发 → 推荐 → 详情」已改由
 *   `RouteSheet` 宿主承担（三档面板 + 路线总览），故本组件**薄壳化**为：
 *   「全屏壳 + `useDetailBody` 取数 + `RouteDetailPane`」，与宿主**共用同一份渲染路径**，防漂移。
 *
 * ── 数据：`POST /api/nav/detail-body`（`card` 直传）──────────────────────
 *   用哪张卡就显示哪张（`planId` 不参与）⇒ 从根上消除「点 51 显示 56」。
 *
 * ⚠️ 挂载位置：必须在 `.nav-map-wrap` **之外**（层叠上下文，Spec AC-13 教训）。
 */
import ComplianceBar from "@/components/nav/ComplianceBar";
import Icon from "@/components/ui/Icon";
import RouteDetailPane from "./RouteDetailPane";
import { useDetailBody } from "./useDetailBody";
import type { FavoriteEndpoint } from "@/lib/favorites/types";
import type { RecommendCard } from "@/lib/recommend/types";

export interface RouteDetailSheetProps {
  card: RecommendCard;
  colors: Record<string, string>;
  /** 目的地展示名（末段步行终点文案） */
  destLabel: string;
  /** 顶部 OD 文案（如「擎天匯 → 澳門科技大學」） */
  odLabel: string;
  /** 收藏入口数据（不传则不渲染收藏按钮） */
  fav?: { from: FavoriteEndpoint; to: FavoriteEndpoint; query: string } | null;
  /** 「本地推算」徽标（推荐列表 degraded 时透传） */
  degraded?: boolean;
  onClose: () => void;
}

export default function RouteDetailSheet({
  card,
  colors,
  destLabel,
  odLabel,
  fav = null,
  degraded = false,
  onClose,
}: RouteDetailSheetProps) {
  const { phase, body, reload, foldState, loadFold } = useDetailBody(card, true);

  return (
    <div className="detail-sheet" role="dialog" aria-modal="true" aria-label={`路线详情 ${odLabel}`}>
      <div className="detail-sheet__bar">
        <button type="button" className="btn btn--text btn--sm" onClick={onClose} aria-label="返回">
          <Icon name="back" size={20} />
          返回
        </button>
        <span className="detail-sheet__od t-label">{odLabel}</span>
      </div>

      <div className="detail-sheet__body">
        <RouteDetailPane
          card={card}
          colors={colors}
          destLabel={destLabel}
          odLabel={odLabel}
          fav={fav}
          degraded={degraded}
          phase={phase}
          body={body}
          reload={reload}
          /* ★ v3.7.0（C5）：折叠栏展开才查实时报站（与主页链同一套三态判据） */
          foldState={foldState}
          onLoadFold={loadFold}
        />
      </div>

      <ComplianceBar />
    </div>
  );
}
