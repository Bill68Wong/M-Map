/**
 * 收藏页 `/favorites`（src/app/favorites/page.tsx，M Map 改版 S4 新增；★ v3.3.0 收藏大改）
 *
 * Server 壳 + 客户端 `FavoritesClient`（`localStorage` 只能在客户端读，F1）。
 * ★ v3.3.0（ADR-104）：**系统预置组合清退** ⇒ 不再注入默认种子（`ComboSeeder` 已退役，`presets` 不再使用）；
 *   页壳因此恢复为「零 DB 依赖的纯壳」（原先为种子而做的配色 / 端点坐标查询一并删除）。
 * 挂**页级底部导航**（ADR-003：不挂全局布局）。
 * ⚠️ 本页必须在 `src/middleware.ts` 的公开白名单里（fail-closed，否则路人打不开）。
 */
import type { Metadata } from "next";
import BottomNav from "@/components/BottomNav";
import ComplianceBar from "@/components/nav/ComplianceBar";
import FavoritesClient from "@/components/favorites/FavoritesClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "收藏",
  description: "保存常用的一对起终点（组合）与单个地点，点击即回到首页规划或选点。",
};

export default function FavoritesPage() {
  return (
    <main className="page page--with-nav">
      <FavoritesClient />
      <ComplianceBar />
      <BottomNav />
    </main>
  );
}
