"use client";

/**
 * 地图品牌栏（src/components/nav/NavBrandBar.tsx，2026-09-25 从 NavShell 拆出 · 07 §5.3）
 *
 * 三栏网格：左=空 · 中=换向键 + 线路标签 · 右=竖排按钮组（刷新 / 公共交通路线 / M Map）。
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
   * ★ v3.6.1：加 `code` —— 线路标签旁新增「全部站点」入口需要它拼 `/line/[code]` 深链。
   */
  picked: { label: string; color: string; kind: "bus" | "lrt"; code?: string } | null;
  canReverse: boolean;
  cooldownSec: number;
  onReverse: () => void;
  onExitLine: () => void;
  onRefresh: () => void;
  onOpenLines: () => void;
  /** ★ v3.3.0（AC-100）：首页定位按钮（品牌栏右列原位）；导航态由页面级 `.nav-locate-fab` 承担 */
  onLocate: () => void;
  /** ★ v3.2.0（需求 10 / AC-84）：导航语境 ⇒ 隐藏「查看路线」与「M Map logo」 */
  navMode?: boolean;
  /**
   * ★ v3.6.1：「查看全部站点」入口（跳 `/line/[code]` 深链页）。
   *   为什么需要：搜索结果改成"首页地图内打开线路"后，`/line/[code]` 只剩外部分享链接可达，
   *   成了孤儿页；这里给一个显式入口，深链页与 `SS_RETURN` 一并保留。
   *   不传 ⇒ 不渲染（收藏页等无地图上下文的调用方不受影响）。
   */
  onOpenAllStops?: (code: string) => void;
  /**
   * ★ M4（需求 5）：图层面板入口（右栏最上）。
   *   不传 ⇒ 不渲染（无地图上下文的调用方不受影响）；导航态一律隐藏（AC-84 同口径）。
   */
  onOpenLayers?: () => void;
}

export default function NavBrandBar({
  picked,
  canReverse,
  cooldownSec,
  onReverse,
  onExitLine,
  onRefresh,
  onOpenLines,
  onLocate,
  navMode = false,
  onOpenAllStops,
  onOpenLayers,
}: NavBrandBarProps) {
  return (
    <div className="nav-brandbar">
      <span className="nav-brandbar__left" aria-hidden="true" />

      <div className="nav-brandbar__mid">
        {picked && canReverse && (
          <button
            type="button"
            className="nav-rev"
            aria-label="切换行驶方向"
            title="切换行驶方向"
            onClick={onReverse}
          >
            <Icon name="exchange" size={20} />
          </button>
        )}
        {picked && (
          <span className="nav-linechip" style={{ background: picked.color }}>
            <span className="nav-linechip__text">{picked.label}</span>
            {/* ★ v3.6.1「全部站点」：复用 chip 内小键的视觉规格（不新造样式）。
                导航态不提供 —— 那会中途跳出整条导航；退出线路视图后入口仍在。 */}
            {picked.code && onOpenAllStops && !navMode && (
              <button
                type="button"
                className="nav-linechip__x"
                data-open-all-stops="on"
                aria-label={`查看 ${picked.label} 全部站点`}
                title="查看全部站点"
                onClick={() => onOpenAllStops(picked.code as string)}
              >
                <Icon name="list" size={16} />
              </button>
            )}
            <button
              type="button"
              className="nav-linechip__x"
              aria-label={`退出路线查看（${picked.label}）`}
              title="退出路线查看"
              onClick={onExitLine}
            >
              <Icon name="close" size={16} />
            </button>
          </span>
        )}
      </div>

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
