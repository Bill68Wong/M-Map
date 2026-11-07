"use client";

/**
 * 车辆图标（src/components/nav/VehicleMarker.tsx，v2.10.0）
 *
 * ── 图形（设计规格锁定：**车头正视图**，用户反馈上一版像车顶）─────────
 *   · 画布 32×32、命中区 44×44、**车头恒朝上**（接口无航向角，不旋转）；
 *   · 全部由纯 rect / circle 组成，**零依赖、零 emoji**；
 *   · 状态由 `data-state` 驱动（**只切 display / fill，不改 SVG 结构**）；
 *   · 涂装色由行内 `--vbus-livery` 注入（**运营商色是数据**，不写进 CSS）。
 *   ⚠️ 车辆图标**不经 Tabler**（它是自绘插画）；卡内功能图标才用 Tabler。
 *
 * ── ★ 2026-11-07（返工 #1）：图形本体已抽成 `<BusGlyph>` ────────────────
 *   车主反馈站序弹窗纵条上的巴士「画错了，我要地图上那种」⇒ 图形只能有**一份**。
 *   · 本文件从此**不再持有任何 rect/circle 坐标**，只保留 44×44 命中盒这一层
 *     交互壳（`<button class="vbus-wrap" data-state + --vbus-livery>`）；
 *   · 12 个图形组 / 状态修饰全部搬进 `nav/BusGlyph.tsx`，两处共用；
 *   · **视觉零变化**的证据（不是"应该没变"）：
 *       `.verify/_fe-c-glyph-snap.tsx` 拿改动前的 SSR 基线做逐字节比对（只剥掉
 *       BusGlyph 引入的三处等价替换），并逐条对读 CSS 的 `display` 值；
 *       `.verify/_fe-c-glyph-pixel.mjs` 再做**真浏览器截图逐字节比对**。
 *   ⚠️ `data-state` 仍留在 wrap 上：涂装淡色（terminal）/ 转灰（lost）/
 *      末班琥珀（data-last）全部是 `.vbus-wrap[data-state=…]` 的 CSS 派生色，
 *      删了就会静默变成满色。
 *
 * ── 状态的两个正交维度 ────────────────────────────────────────────────
 *   · `data-state` ∈ moving | stopping | terminal | lost | unknown
 *   · `data-last="1"` = 末班车（**独立属性** —— 末班车同时也在行驶，不能挤进 data-state）
 *
 * ── 多车合并 ──────────────────────────────────────────────────────────
 *   屏距 ≤ `VEHICLE_MERGE_DIST`（28px）合并为一枚图标；角标 ≤9 显数字、>9 显 `9+`。
 */
import type { CSSProperties } from "react";
import BusGlyph, { type BusGlyphState } from "./BusGlyph";
import type { VehicleProgress } from "@/lib/nav/progress";

/** `/api/route-vehicles` 单车（前端视图模型；`company` 由调用方从响应顶层注入） */
export interface VehicleLite {
  plate: string;
  /**
   * ★ v3.6.1：**车队编号**（DSAT `busCode`，如 `HE380` / `E3246` / 纯数字 `2107`）。
   *
   * ⚠️ 语义是「**整个键可能不存在**」，不是 `null`、不是空串：
   *    它来自报站接口，报站失败时该字段整体缺席（此时 `interval` 也是 null、`status="unknown"`）。
   *    ⇒ 判断一律用 `vehicle.busCode && …`；
   *      **不要**写 `busCode !== null`（`undefined !== null` 为真 ⇒ 会渲染空角标）。
   * 长度 4~5 字符（全库实测），纯数字那批是澳巴真实旧编号，不是脏数据。
   */
  busCode?: string;
  /** GCJ-02 */
  lat: number;
  lng: number;
  status: "moving" | "stopping" | "terminal" | "unknown" | "lost";
  isLast?: boolean;
  /** 精确行驶区间（报站接口给；失败为 null） */
  interval?: { from: { code: string; name: string }; to: { code: string; name: string } } | null;
  /** 停靠中所在站 */
  atStation?: { code: string; name: string } | null;
  /** ★ v3.4.0：区间进度（服务端 `?progress=1` 填充；缺省 = 该车不可算，调用方降级） */
  progress?: VehicleProgress | null;
  /** 运营商：`澳巴` / `新福利`（决定涂装色） */
  company?: string;
}

/** 合并阈值（屏距，px）—— Spec AC-07 */
export const VEHICLE_MERGE_DIST = 28;

/** 状态文案（界面一律简体） */
export const VEHICLE_STATE_LABEL: Record<string, string> = {
  moving: "行驶中",
  stopping: "停靠中",
  terminal: "总站待发",
  lost: "信号丢失",
  unknown: "状态未知",
};

/** 运营商 → 涂装色（Spec §8：澳巴橙 / 新福利蓝） */
export const VEHICLE_LIVERY = {
  transmac: "#E26A0E",
  nfb: "#1466B8",
} as const;

/**
 * 车辆状态 → `<BusGlyph>` 的视觉修饰（**不是**语义改名，只是图形层的映射表）：
 *   · `stopping` ⇒ `stop`（右下角「‖」）
 *   · `terminal` ⇒ `ready`（虚线白圈；地图侧另有 CSS 把涂装调淡，靠 wrap 的 data-state）
 *   · `lost`     ⇒ `lost`（虚线白圈 + 左下角「!」）
 *   · `moving` / `unknown` ⇒ 无修饰
 *
 * ⚠️ `unknown` 归到 `moving`（无修饰）是**有意的**：旧版 CSS 对 `data-state="unknown"`
 *    没有任何修饰规则 ⇒ 归到 `moving` 才能保持逐像素一致。**不要**给它加新修饰。
 */
export const VEHICLE_GLYPH_STATE: Record<VehicleLite["status"], BusGlyphState> = {
  moving: "moving",
  stopping: "stop",
  terminal: "ready",
  lost: "lost",
  unknown: "moving",
};

/** 把后端可能的多种运营商写法归一为 `transmac` | `nfb` */
export function normalizeCompany(raw?: string | null): "transmac" | "nfb" {
  const s = (raw ?? "").trim();
  if (s === "新福利" || s.toLowerCase() === "nfb" || s.toLowerCase() === "transmac_nfb") return "nfb";
  return "transmac";
}

/** 运营商中文名（aria-label 用） */
export function companyLabel(c: "transmac" | "nfb"): string {
  return c === "nfb" ? "新福利" : "澳巴";
}

export interface ScreenPoint {
  v: VehicleLite;
  x: number;
  y: number;
}

export interface VehicleCluster {
  /** 稳定 key（车牌拼接） */
  key: string;
  /** 合并后中心（屏幕像素） */
  x: number;
  y: number;
  items: VehicleLite[];
}

/**
 * 按**屏幕距离**合并车辆（贪心：以首个未分组点为锚，吸收 `dist` 内的其余点，取质心）。
 * 纯函数、无副作用 —— 便于单测与复用。
 */
export function clusterByScreenDistance(
  pts: ScreenPoint[],
  dist: number = VEHICLE_MERGE_DIST,
): VehicleCluster[] {
  const used = new Array<boolean>(pts.length).fill(false);
  const out: VehicleCluster[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const group = [pts[i]];
    for (let j = i + 1; j < pts.length; j++) {
      if (used[j]) continue;
      if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) <= dist) {
        used[j] = true;
        group.push(pts[j]);
      }
    }
    const x = group.reduce((s, g) => s + g.x, 0) / group.length;
    const y = group.reduce((s, g) => s + g.y, 0) / group.length;
    out.push({ key: group.map((g) => g.v.plate).join("|"), x, y, items: group.map((g) => g.v) });
  }
  return out;
}

export interface VehicleMarkerProps {
  /** 合并组内的车辆（≥1；`items[0]` 代表该组） */
  items: VehicleLite[];
  /**
   * @deprecated ★ 2026-09-23：车辆已**原生化**（`VehicleLayer` 的 AMap.Marker 驱动位置）
   *   ⇒ 屏幕坐标不再使用（调用方传 0）；保留字段仅为兼容签名，**不影响渲染**。
   */
  x?: number;
  /** @deprecated 同上（屏幕坐标不再使用） */
  y?: number;
  onClick?: () => void;
}

/**
 * 单枚车辆图标。**位置由外层决定**：
 *   · 原生化后由 `AMap.Marker`（`anchor:'center'`）定位 ⇒ 本组件只画 44×44 命中盒 + 32px svg。
 */
export default function VehicleMarker({ items, onClick }: VehicleMarkerProps) {
  const v = items[0];
  const count = items.length;
  const company = normalizeCompany(v.company);
  const state = v.status;
  const label = `${companyLabel(company)}${v.isLast ? " 末班" : ""} ${VEHICLE_STATE_LABEL[state] ?? "状态未知"}${
    count > 1 ? `，共 ${count} 辆` : ""
  }`;

  return (
    <button
      type="button"
      className="vbus-wrap"
      data-state={state}
      data-last={v.isLast ? "1" : undefined}
      style={{ "--vbus-livery": VEHICLE_LIVERY[company] } as CSSProperties}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {/* 图形本体（32px = ViewBox 原名尺寸；**不传 livery** ⇒ 沿用本按钮的 --vbus-livery，
          避免同一份涂装色在两处各写一遍） */}
      <BusGlyph size={32} state={VEHICLE_GLYPH_STATE[state]} />
      {count > 1 && (
        <span className="vbus__count" aria-hidden="true">
          {count > 9 ? "9+" : count}
        </span>
      )}
    </button>
  );
}
