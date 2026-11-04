"use client";

/**
 * 自动选线 · 卡片列表（src/components/RecommendCards.tsx，v1.0.0；★ v2.4.1 删两个透传参数）
 *
 * 只负责渲染：把 `RecommendCard[]` 铺成一组大卡，并统一注入线路色 / 座区。
 * 数据来源由父级决定（SSR 首屏来自 server 组件；刷新后来自 `/api/recommend`）。
 *
 * ★ v2.4.1：**删除 `originOf` 与 `devMode` 两个透传参数** ——
 *   用户要求卡面「不再标注方案来源」且「删除右上角的绿色圆点」，
 *   `RecommendCard` 已不再渲染这两者 ⇒ 本层的透传（及其 `useDevMode` 调用）一并删除，
 *   避免留下"传了但下游不用"的死参数。调用方（`NavResultClient`）同步移除 `originOf`。
 *
 * 空状态：深度时段多数线路已收班 / 无在途车 → 0 张卡时给明确原因与出口，
 *   不留白屏（计划 §7.1）。
 */
import RecommendCard from "./RecommendCard";
import { RECOMMEND_LIMIT_DEFAULT } from "@/lib/recommend/limits";
import type { RecommendCard as CardData, SchoolZone } from "@/lib/recommend/types";

export default function RecommendCards({
  cards,
  colors,
  zone,
  fromSlug,
  toSlug,
  excluded = [],
  missed = [],
  hrefBuilder,
  cardAction,
  onCardOpen,
  limit = RECOMMEND_LIMIT_DEFAULT,
}: {
  cards: CardData[];
  colors: Record<string, string>;
  zone: SchoolZone | null;
  /** ★ v1.1.8：卡片点击要跳详情页，需要带上起终点（详情页 URL 契约） */
  fromSlug: string;
  toSlug: string;
  /** 被排除的线路（无在途车 / 已收车）——不足目标张数 / 空状态时用于解释原因 */
  excluded?: string[];
  /** ★ v1.0.6：因「首段赶不上」被剔除的路线（与 excluded 分开，文案要说实话） */
  missed?: string[];
  /** ★ v1.3.0（全澳导航）：覆盖点击跳转（如 `/nav/detail?…`） */
  hrefBuilder?: (card: CardData) => string;
  /** 头部附加角标（如「当下最快」「已保存」）；★ v2.4.1 从底部动作槽移到卡片头部 */
  cardAction?: (card: CardData, rank: number) => React.ReactNode;
  /**
   * ★ 2026-09-23：点击卡片 → **打开全屏详情弹窗**（优先于 `hrefBuilder`）。
   *   主页「出发」推荐层与收藏组合页用它替代整页跳转。
   */
  onCardOpen?: (card: CardData) => void;
  /**
   * ★ 2026-11-04（U10）：**本列表取了前几张卡**。必须下传给每张卡 ——
   *   卡片的详情链接要带回同一个张数，否则详情页只按更少的张数回查，
   *   **第 N 张卡必然 `route_changed`（点了没反应）**。
   */
  limit?: number;
}) {
  // 剔除原因（分两类：没车 vs 赶不上）—— 合并成一个数组只用于文案拼接
  // ★ P1-2（T05 修复）：界面文案**一律简体**（站名/线路名才用繁体；校名「澳門科技大學」属地名）
  const reasons: string[] = [];
  if (excluded.length > 0) reasons.push(`${excluded.length} 条线路暂无班次`);
  if (missed.length > 0) reasons.push(`${missed.length} 条路线赶不上首班车`);

  if (!cards.length) {
    return (
      <div className="card rc-empty">
        <p className="h-title">暂时没有可用的班次</p>
        <p className="t-body t-muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
          现在这个时段，能到这个方向的线路大多已收班，或暂时查不到车。
          {reasons.length > 0 && <>（{reasons.join("・")}）</>}
        </p>
        <p className="t-label t-muted" style={{ marginTop: 8, lineHeight: 1.6 }}>
          建议：稍后再试，或改用其他交通方式。轻轨服务时间约 06:30–23:30。
        </p>
      </div>
    );
  }

  return (
    <div className="rc-list">
      {/* ★ v3.3.0（AC-108）：删除「目前仅有 X 条路线可用」提示（用户明确要求不展示）。
          结果不足时的解释改由空态块承担（`RouteResultPane` 中性空态：图标 + 「暂时没有可用方案」+ 重试）。 */}
      {cards.map((c, i) => (
        <RecommendCard
          key={`${c.planId}-${c.rides.map((r) => `${r.route}${r.alight}`).join("_")}`}
          card={c}
          colors={colors}
          zone={zone}
          rank={i + 1}
          fromSlug={fromSlug}
          toSlug={toSlug}
          hrefOverride={hrefBuilder?.(c)}
          cardAction={cardAction?.(c, i + 1)}
          onCardOpen={onCardOpen ? () => onCardOpen(c) : undefined}
          limit={limit}
          /* ★ v1.1.8：入场错峰（原先 5 张卡同时同速上浮，既没方向感也白花一次动画预算） */
          delayMs={i * 40}
        />
      ))}
    </div>
  );
}
