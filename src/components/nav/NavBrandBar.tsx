"use client";

/**
 * 地图品牌栏（src/components/nav/NavBrandBar.tsx，2026-09-25 从 NavShell 拆出 · 07 §5.3）
 *
 * 单列（右栏竖排按钮组：图层 / 刷新 / 公共交通路线 / 定位 / M Map）。
 * ★ 2026-11-11（负责人裁定）：**原中栏整块已删除** —— 换向键 + 线路标签（含
 *   「查看全部站点」「退出路线查看」两个小键）与左栏空占位一并移除；理由是与
 *   `RouteStopsSheet` 弹窗纵条功能重复，只保留弹窗。`grid-template-columns` 仍是
 *   `1fr auto 1fr`（`globals.css` 声明值不动），右栏仍由 `grid-column: 3` 靠右。
 * 纯展示：数据与回调由 `NavShell` 下发。
 *
 * ★ v3.2.0（需求 9/10/11 / AC-84）：
 *   · **定位按钮已移出**本栏 —— 改由页面级 `.nav-locate-fab` 承担（随面板档位上下避让，见 NavShell）；
 *   · `navMode`（= `data-nav-phase !== "off"`）⇒ **隐藏「公共交通路线」（查看路线）与「M Map logo」**，
 *     右列仅剩（可选）刷新（CSS 另有整列隐藏规则兜底）。
 */
import Link from "next/link";
import BrandMark from "@/components/brand/BrandMark";
import Icon from "@/components/ui/Icon";
import RefreshButton from "./RefreshButton";
import { COOLDOWN_VEHICLE_SEC } from "./useCooldown";

export interface NavBrandBarProps {
  /**
   * 当前查看的线路（null = 未进入路线查看模式）。
   * ⚠️ 品牌栏内**只**用 `kind` 决定右栏刷新键是否显示（下方 `picked?.kind === "bus"` 分支）；
   * `label` / `color` / `code` 供宿主与后续扩展保留，中栏删除后本组件不再渲染线路标签。
   */
  picked: { label: string; color: string; kind: "bus" | "lrt"; code?: string } | null;
  cooldownSec: number;
  onRefresh: () => void;
  onOpenLines: () => void;
  /** ★ v3.3.0（AC-100）：首页定位按钮（品牌栏右列原位）；导航态由页面级 `.nav-locate-fab` 承担 */
  onLocate: () => void;
  /** ★ v3.2.0（需求 10 / AC-84）：导航语境 ⇒ 隐藏「查看路线」与「M Map logo」 */
  navMode?: boolean;
  /**
   * ★ M4（需求 5）：图层面板入口（右栏最上）。
   *   不传 ⇒ 不渲染（无地图上下文的调用方不受影响）；导航态一律隐藏（AC-84 同口径）。
   */
  onOpenLayers?: () => void;
  /* ★ 2026-11-11：原 v3.6.1「查看全部站点」入口（`/line/[code]` 深链）已按负责人裁定移除 ——
     弹窗纵条 `RouteStopsSheet` 已覆盖同等功能；深链页面文件本身保留，仅 App 内不再有入口。
     中栏配套的四个 props（换向 / 退出线路 / 深链回调等）同步移除：
     换向与退出改由弹窗自己的 `onFlipDirection` / `onClose` 承担（见 NavShell.tsx:2807/2809）。 */
}

export default function NavBrandBar({
  picked,
  cooldownSec,
  onRefresh,
  onOpenLines,
  onLocate,
  navMode = false,
  onOpenLayers,
}: NavBrandBarProps) {
  return (
    <div className="nav-brandbar">
      {/* 右栏：竖排按钮组（图层 → 刷新 → 公共交通路线 → M Map）※「定位」已移至页面级 `.nav-locate-fab` */}
      <div className="nav-brandbar__acts">
        {/* ★ M4（需求 5）：图层面板入口 —— **右栏最上**（负责人指定），搜索框正上方。
            导航语调整列隐藏（AC-84 同一口径）⇒ 导航中不可达（导航时不该换图层）。
            图标沿用右栏同一套 20px / 1.8 描边规格，不新造视觉。 */}
        {!navMode && onOpenLayers && (
          <button
            type="button"
            className="nav-locate"
            data-open-layers="on"
            aria-label="图层"
            title="图层"
            onClick={onOpenLayers}
          >
            <Icon name="pin" size={20} />
          </button>
        )}
        {picked?.kind === "bus" && (
          <RefreshButton
            cooling={cooldownSec > 0}
            seconds={cooldownSec}
            total={COOLDOWN_VEHICLE_SEC}
            onRefresh={onRefresh}
          />
        )}
        {/* ★ 需求 10 / AC-84：导航语境（navMode）⇒ 隐藏「查看路线」与「M Map logo」 */}
        {!navMode && (
          <button
            type="button"
            className="nav-locate"
            aria-label="公共交通路线"
            title="公共交通路线"
            onClick={onOpenLines}
          >
            {/* ★ v3.3.0（设计师裁决）：本键语义 = 「全部线路」⇒ 改 `route-2`（比 `records` 更贴切） */}
            <Icon name="route-2" size={20} />
          </button>
        )}
        {/* ★ v3.3.0（AC-100）：**首页定位按钮 = 品牌栏右列原位**（「查看路线」下方）。
            导航态整列隐藏（`body[data-nav-phase]:not([data-nav-phase="off"]) .nav-brandbar__acts`）
            ⇒ 此时由页面级 `.nav-locate-fab`（`data-locate-pos="float"`）承担，两模式互斥不重叠。 */}
        {!navMode && (
          <button
            type="button"
            className="nav-locate"
            data-locate-pos="bar"
            aria-label="定位到我的位置"
            title="定位到我的位置"
            onClick={onLocate}
          >
            <Icon name="locate" size={20} />
          </button>
        )}
        {/* 品牌位（★ v2.15.0）：标志 + 字标。标志走内联 SVG ⇒ var(--brand-route/pin)
            随 prefers-color-scheme 自动换亮蓝/亮绿（详见 BrandMark.tsx 头注）。 */}
        {!navMode && (
          <Link href="/help" className="nav-brand" aria-label="M Map · 帮助与合规说明">
            <BrandMark className="nav-brand__mark" size={20} />
            {"M Map"}
          </Link>
        )}
      </div>
    </div>
  );
}
