/**
 * 卡片链接 URL 契约（src/lib/recommend/card-href.ts，2026-11-06 通琴号迭代）
 *
 * ── 本文件从 `card-link.ts` 拆出的原因 ────────────────────────────────
 *   旧 `card-link.ts` 是**详情页 + 列表页两端的共用契约**：`buildCardHref` 拼地址、
 *   `parseCardQuery` 解析地址、`cardKey` 命中卡片。本批 `/card` 页面与 `/api/card`
 *   整体退役（Spec §6.2.2，进 `PAGE_RETIRED` / `GONE_PREFIXES`）⇒ `parseCardQuery`
 *   与 `cardKey` 的消费方为零，随 `card-link.ts` 一并删除。
 *   只剩 `buildCardHref` 还有唯一存活的消费方（`RecommendCard.tsx` 的兜底跳转），
 *   故单独成文件保留，**不留在原处**：原文件里两个死函数会诱导后来者以为
 *   `/card` 还能用。
 *
 * ── 现存唯一调用点与它的实际状态 ──────────────────────────────────────
 *   `RecommendCard.tsx#onClick` 的**最后一档兜底**：调用方既没传 `onCardOpen`
 *   （路线弹窗用，优先）也没传 `hrefOverride` 时才走到这里。
 *   当前全仓唯一消费方 `RouteResultPane` **必传 `onCardOpen`** ⇒ 本分支运行时不可达。
 *   保留它只为「不改变 `RecommendCard` 的对外契约」—— 删掉兜底会让点击变成静默无响应，
 *   比跳到一个 308 回首页的地址更糟（用户至少能看到页面有反应）。
 *
 * ⚠️ `/card` 已进 `PAGE_RETIRED`（308 回首页）：本函数产出的链接**不再指向详情页**。
 *    若将来要恢复详情页，必须同时把 `/card` 从 `PAGE_RETIRED` 移出并补 `page.tsx`，
 *    否则这里就是一条静默失效的链接。
 *
 * 纯函数、零依赖（不涉及 pg / server-only）→ client / server 都能 import。
 */
import { RECOMMEND_LIMIT_DEFAULT } from "./limits";
import type { SchoolZone } from "./types";

export interface CardLinkParams {
  from: string;
  to: string;
  zone: SchoolZone | null;
  /** 方案 id */
  plan: number;
  route: string;
  board: string;
  alight: string;
  /** 名次（1 起，仅展示用） */
  rank?: number;
  /** 列表页取几张卡（决定 thresholdMin，默认 `RECOMMEND_LIMIT_DEFAULT`） */
  limit?: number;
}

/**
 * 拼 `/card?...` 查询串。
 *
 * ⚠️ `limit` 必须由调用方带上**本列表的实际张数**：详情页要按同一批卡片回查
 *    （`thresholdMin` = 第 N 张卡的总时长）。历史上漏传过 ⇒ 第 N 张卡点进去
 *    必然 `route_changed`（点了没反应）。
 */
export function buildCardHref(p: CardLinkParams): string {
  const q = new URLSearchParams({
    from: p.from,
    to: p.to,
    plan: String(p.plan),
    route: p.route,
    board: p.board,
    alight: p.alight,
  });
  if (p.zone) q.set("zone", p.zone);
  if (p.rank) q.set("rank", String(p.rank));
  q.set("limit", String(p.limit ?? RECOMMEND_LIMIT_DEFAULT));
  return `/card?${q.toString()}`;
}
