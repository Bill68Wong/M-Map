/**
 * /recommend —— 自动选线页（src/app/recommend/page.tsx，v1.0.0）
 *
 * 用户从首页方向卡进来（`?from=home&to=school&zone=N/O`），这里按「现在出发」算出
 * 最快的 5 条门到门路线，SSR 直接出全卡。
 *
 * 流式：页壳立刻可见，卡片区用 `<Suspense>` 包住 —— 骨架先出，`recommend()` 算完即填
 *   （DSAT 实时 + 轻轨时刻表要 ~0.3s）。所以「点首页卡 → 看到 5 张卡」的首屏感知 = 骨架即刻。
 *
 * ⚠️ 函数区域由项目级 `vercel.json: "regions": ["hkg1"]`（v3.7.0 · ADR C1）决定。
 * ⚠️ `force-dynamic`：绝不能静态化/缓存 —— 结果含「现在」的实时班次。
 * 座区只从 `?zone=` 读（切换入口在首页，见计划 §7.1）。
 */
import { Suspense } from "react";
import RecommendClient from "@/components/RecommendClient";
import BrandRouteLoader from "@/components/brand/BrandRouteLoader";
import Icon from "@/components/ui/Icon";
import { getPool } from "@/lib/db";
import { PLACE_SHORT } from "@/lib/home-plans-shared";
import { recommend } from "@/lib/recommend/service";
import { DEFAULT_ZONE, SCHOOL_ZONES, type SchoolZone } from "@/lib/recommend/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ZONE_VALUES = SCHOOL_ZONES.map((z) => z.value);

const labelOf = (slug: string) => PLACE_SHORT[slug] ?? slug;

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; zone?: string }>;
}) {
  const sp = await searchParams;
  const from = sp.from?.trim() || "home";
  const to = sp.to?.trim() || "school";
  const zoneParam = sp.zone?.trim();
  const zone: SchoolZone = (ZONE_VALUES as string[]).includes(zoneParam ?? "")
    ? (zoneParam as SchoolZone)
    : DEFAULT_ZONE;

  return (
    <Suspense fallback={<RecommendSkeleton from={from} to={to} zone={zone} />}>
      <CardsSection from={from} to={to} zone={zone} />
    </Suspense>
  );
}

/** 数据区（server）：算完立即渲染整块 —— 外面 Suspense 的 fallback 是其骨架 */
async function CardsSection({ from, to, zone }: { from: string; to: string; zone: SchoolZone }) {
  const r = await recommend(getPool(), { fromSlug: from, toSlug: to, zone, limit: 5 });

  return (
    <RecommendClient
      fromSlug={from}
      toSlug={to}
      fromLabel={labelOf(from)}
      toLabel={labelOf(to)}
      zone={zone}
      initial={{
        cards: r.cards,
        colors: r.colors,
        excluded: r.excluded,
        missed: r.missed,
        generatedAt: r.generatedAt,
        count: r.cards.length,
      }}
    />
  );
}

/** 页壳骨架（Suspense fallback）：形状与真卡片一致，避免填入时跳动 */
function RecommendSkeleton({ from, to, zone }: { from: string; to: string; zone: SchoolZone }) {
  // 座区：学校在**任一侧**都标（与 RecommendClient 的标题口径一致）
  const zoneBadge = <span className="rc-zone">（{zone} 座）</span>;
  return (
    <main className="page">
      <div className="rc-top">
        <span className="btn btn--text btn--sm">
          <Icon name="back" size={20} />
          返回
        </span>
        <span className="btn btn--text btn--sm">
          <Icon name="refresh" size={20} />
          刷新
        </span>
      </div>
      <h1 className="h-headline rc-title">
        {to === "school" ? (
          <>
            {labelOf(from)} → {labelOf(to)}
            {zoneBadge}
          </>
        ) : from === "school" ? (
          <>
            {labelOf(from)}
            {zoneBadge} → {labelOf(to)}
          </>
        ) : (
          <>
            {labelOf(from)} → {labelOf(to)}
          </>
        )}
      </h1>
      <p className="t-label t-muted rc-subtitle">正在計算最快路線…</p>
      {/* ★ v3.9.0（05 规格 §12.2③）：rc-list 换为单个 M 容器（48px，min-height 240px）。
          本页标题/副标题（「正在計算最快路線…」）就是该位置的 label —— **不重复传 label**
          （§12.4：加了反而重复播报）。slot="list"；300ms 门（§12.0 总纲二）。
          ⚠️ 与 loading.tsx 同形（§12.2④ 红线：两层必须同批同形，否则自造跳动）。 */}
      <div className="rc-list rc-list--loading">
        <BrandRouteLoader active size={48} slot="list" />
      </div>
    </main>
  );
}
