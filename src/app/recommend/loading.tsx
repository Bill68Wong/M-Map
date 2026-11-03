/**
 * /recommend 路由级加载骨架（src/app/recommend/loading.tsx，v1.0.0）
 *
 * 与 `page.tsx` 内 Suspense 的 fallback 同一形态 —— 这层负责「路由切换瞬间」的占位
 * （用户从首页点方向卡的第一次反馈），内层负责「数据正在算」的占位。
 * 两层形状一致 → 骨架不跳动。
 */
import Icon from "@/components/ui/Icon";
import BrandRouteLoader from "@/components/brand/BrandRouteLoader";

export default function Loading() {
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
      <h1 className="h-headline rc-title">正在計算…</h1>
      <p className="t-label t-muted rc-subtitle">分析实时班次与步行时间</p>
      {/* ★ v3.9.0（05 规格 §12.2④）：与 page.tsx 的 Suspense fallback **完全同形**
          （48px M 容器、min-height 240px、无 label——页面文案即 label）。
          ⚠️ 红线：③④ 必须同批同形，只换一层 = 路由切换瞬间两套语言先后出现 = 自造跳动。 */}
      <div className="rc-list rc-list--loading">
        <BrandRouteLoader active size={48} slot="list" />
      </div>
    </main>
  );
}
