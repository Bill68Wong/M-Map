"use client";

/**
 * 推荐列表 pane（src/components/nav/RouteResultPane.tsx，2026-09-23 新增）
 *
 * 从 `RouteResultSheet` 抽出「列表渲染」，改为 `RouteSheet` 宿主的**常驻子 pane**
 *   （`hidden`/`display` 切换，**不卸载** ⇒ 保留滚动位置，秒回）。
 * 数据由宿主 `useRecommend` 下发（同一份数据供宿主渲染 peek 摘要）。
 */
import Icon from "@/components/ui/Icon";
import BrandRouteLoader from "@/components/brand/BrandRouteLoader";
import RecommendCards from "@/components/RecommendCards";
import { lrtPromotedOf } from "@/components/RoutePieces";
import type { RecommendCard } from "@/lib/recommend/types";
import type { CSSProperties } from "react";
import type { RecommendData } from "./useRecommend";

/**
 * 空状态文案（与 `/nav` 页同口径）。
 * ★ v3.3.0（AC-108）：**空态与错误态严格区分** ——
 *   · 空态（0 卡）：中性灰（`--meta`）+ `route-2` 图标 + 重试按钮，**无红色**；
 *   · 错误态（路网不可用）：保留既有警告样式与「路网数据暂时不可用」文案（需求 8 修根因、不删文案）。
 */
const EMPTY_TEXT: Record<string, { title: string; body: string }> = {
  too_close: { title: "距离很近", body: "起点与目的地很近，建议直接步行前往。" },
  no_live: { title: "暂时没有可用的班次", body: "现在这个时段，能到这个方向的线路大多已收班，或暂时查不到车。" },
  no_candidate: { title: "暂时没有可用方案", body: "换个起终点，或稍后重试。" },
  amap_unavailable: { title: "路网数据暂时不可用", body: "暂时没能算出可用路线。请稍后重试。" },
};

export interface RouteResultPaneProps {
  phase: "idle" | "loading" | "ready" | "failed";
  data: RecommendData | null;
  err: string;
  onRetry: () => void;
  onCardOpen: (card: RecommendCard, degraded: boolean) => void;
  /**
   * ★ 2026-11-12（P1-b）：`too_close` 空态的「步行导航」入口。
   *
   * 为什么必须有：`too_close` 的结论是「建议直接步行」，但旧面板只给一句
   * 「步行约 N 分钟」+「重试」——用户被劝去走路，却没有任何可点的下一步，
   * 等于把导航断在这里。缺省不传 ⇒ 不渲染按钮（其他空态/调用方零影响）。
   */
  onWalkNav?: () => void;
}

/**
 * ★ 2026-11-06（问题 #6 收尾）：「数据时刻」那一行的样式。
 *
 * 为什么是内联而不是新类：本批**只允许**在 `globals.css` 的 `.lp-stop__veh` 段新增两条
 * 图标字色规则（别人的成果不能顺手改），故这一行的视觉全部走 **Token 变量**内联声明
 * （`--text-2xs` / `--meta` / `--space-2` 均已存在）⇒ 零新增全局选择器、零硬编码色值（P0-2）。
 *
 * 三条硬约束（对应本批验收）：
 *   · 只占**一行**、11px（`--text-2xs`）、`--meta` 灰 ⇒ 不许抢主体；
 *   · 数字用 `tabular-nums` ⇒ 秒位跳动时不左右抖（否则每次刷新整行字宽在变）；
 *   · `lineHeight: 1.4` 定死 ⇒ 有无这一行都不改变卡片起点节奏（避免"提示消失后卡片上跳"）。
 */
const FRESH_STYLE: CSSProperties = {
  margin: "0 0 var(--space-2)",
  fontSize: "var(--text-2xs)",
  lineHeight: 1.4,
  letterSpacing: "0.01em",
  color: "var(--meta)",
  fontVariantNumeric: "tabular-nums",
};

/**
 * ISO 8601 → 本地时区「HH:MM:SS」（24 小时制，补零）。
 *
 * ⚠️ **不要**改成 `toLocaleTimeString()`：① 它随 locale 变 12/24 小时制（会出现「上午 9:41:07」，
 *   与本批"一行、11px"的版面互斥）；② 服务端渲染与客户端 locale/TZ 可能不同 ⇒ hydration 报错。
 *   手写 `getHours/getMinutes/getSeconds` + `padStart` 只依赖本地时区，输出恒定。
 * ⚠️ 非法 / 空值 ⇒ `null`（调用方据此**整行不渲染**，而不是渲染「数据时刻 --:--:--」占位）。
 */
function fmtClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function RouteResultPane({ phase, data, err, onRetry, onCardOpen, onWalkNav }: RouteResultPaneProps) {
  const empty = data && data.cards.length === 0 ? EMPTY_TEXT[data.emptyReason ?? "no_candidate"] : null;
  /**
   * ★ 2026-11-06：两种"时间相关"状态，**同一行槽位**互斥渲染（永远不会两行 / 不会留空位）：
   *   · `refreshing`：有旧数据 + 正在重拉 ⇒ 「正在更新…」。
   *     ⚠️ 关键：卡片区渲染条件 `{data && …}` **与 phase 无关** ⇒ 重拉期间旧卡一直可见。
   *        所以这里**只加一行提示**，**不要**改用骨架（骨架条件是 `loading && !data`）——
   *        拿骨架替换旧卡会让整屏闪空，用户反而以为数据丢了。
   *   · 否则显示这批数据的取数时刻（`generatedAt` 缺失 ⇒ 整行不渲染）。
   */
  const refreshing = phase === "loading" && data !== null;
  const clock = fmtClock(data?.generatedAt);

  return (
    <div className="route-pane route-pane--recommend">
      {phase === "loading" && <span className="nav-result__progress" aria-hidden="true" />}

      {phase === "failed" && !data && (
        <p className="fav-note fav-note--warn t-label" role="status">
          {err}
          <button type="button" className="btn btn--text btn--sm" onClick={onRetry}>
            重试
          </button>
        </p>
      )}

      {phase === "loading" && !data && (
        /* ★ v3.9.0（05 规格 §12.2①）：等待卡 ×1 —— 保留 .card 轮廓防面板塌缩（min-height 112px），
            去掉全部 rc-sk；32px M（规格 §12.1 紧凑档：卡内 48px 喧宾夺主）+ label。
            ⚠️ 不再加 aria-hidden：label 要进 live region（role="status"）让读屏播报。
            slot="list"：QA 断言用；门控 300ms 与 request 相同（§12.0 总纲二）。 */
        <div className="rc-list">
          <div className="card rc rc--loading">
            <BrandRouteLoader active size={32} slot="list" label="正在搜索路线…" />
          </div>
        </div>
      )}

      {data && (
        <>
          {/* ★ 2026-11-06（问题 #6 收尾）：**一行**「正在更新… / 数据时刻 HH:MM:SS」。
              · 位置在卡片区**上方**、`degraded` 提示之前 ⇒ 扫读顺序 = 先"这批数是什么时候的"，再看方案；
              · `role="status"` 只给「正在更新…」（一次性状态，值得播报）；
                「数据时刻」**不给** live region —— 每次刷新都播报时间戳会打断读屏；
              · `data-fresh` / `data-generated-at` 是 QA 断言钩子（与 `data-pane` / `data-veh` 同风格），
                `data-generated-at` 存**原始 ISO**（不清洗）⇒ 可断言"屏上时刻 = 服务端返回的时刻"；
              · ⚠️ `className="nav-fresh"` 是**语义钩子，刻意没有 CSS 规则**（样式全走 `FRESH_STYLE`
                的 Token 内联）。将来若要收编成类，在 `.nav-result__progress` 那一段旁边加即可；
              · 文案纪律：不写「实时」（隐含秒级推送）、不写「缓存/已过期」（技术词）。 */}
          {refreshing ? (
            <p className="nav-fresh" role="status" data-fresh="updating" style={FRESH_STYLE}>
              正在更新…
            </p>
          ) : clock ? (
            <p
              className="nav-fresh"
              data-fresh="stamp"
              data-generated-at={data.generatedAt ?? undefined}
              style={FRESH_STYLE}
            >
              数据时刻 {clock}
            </p>
          ) : null}

          {data.degraded && (
            <div className="nav-degraded t-label">路网数据暂时不可用，以下为估算结果</div>
          )}
          {empty ? (
            /* ★ v3.3.0（AC-108）：**中性空态**（图标 + 主句 + 副句 + 重试；中性灰、无红色） */
            <div className="card rc-empty rc-empty--neutral">
              <span className="rc-empty__icon" aria-hidden="true">
                <Icon name="route-2" size={24} />
              </span>
              <p className="h-title">{empty.title}</p>
              <p className="t-body t-muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
                {empty.body}
              </p>
              {data.emptyReason === "too_close" && data.nearbyWalkMin != null && (
                <p className="t-label t-muted" style={{ marginTop: 8, lineHeight: 1.6 }}>
                  步行约 <b>{data.nearbyWalkMin}</b> 分钟（比等车更快）。
                </p>
              )}
              {/* ★ 2026-11-12（P1-b）：「建议步行」必须给出**可执行的下一步**，
                  否则用户被劝走路却无处可点。步行是这里的主行动 ⇒ 主按钮；重试降为次按钮。 */}
              <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "center" }}>
                {data.emptyReason === "too_close" && onWalkNav ? (
                  <button type="button" className="btn btn--primary btn--sm" onClick={onWalkNav}>
                    步行导航
                  </button>
                ) : null}
                <button type="button" className="btn btn--outline btn--sm" onClick={onRetry}>
                  重试
                </button>
              </div>
            </div>
          ) : (
            <RecommendCards
              cards={data.cards}
              colors={data.colors}
              zone={null}
              fromSlug={data.fromSlug}
              toSlug={data.toSlug}
              excluded={data.excluded}
              missed={data.missed}
              /* ★ v3.3.0（AC-105）：被「轻轨优先」置顶的卡 → 头部角标（未触发 ⇒ 不渲染，静默） */
              cardAction={(c) =>
                lrtPromotedOf(c) ? (
                  <span className="rc-lrtbadge" data-lrt-promoted="on">
                    <Icon name="lrt" size={16} />
                    轻轨优先
                  </span>
                ) : null
              }
              onCardOpen={(c) => onCardOpen(c, data.degraded)}
            />
          )}
        </>
      )}
    </div>
  );
}
