/**
 * 加载小循环（src/components/brand/BrandRouteLoader.tsx，v3.8.0 · 05 规格 §5）
 *
 * ── 使用场景（PM 边界）─────────────────────────────────────────────────
 *   真实加载 >300ms 才出现（避免快路径闪烁）；地图保持可见可操作；
 *   M 图标固定在分步文案行左侧，不随文案换行跳动。动画是配角，文案才是主角。
 *
 * ── 行为 ──────────────────────────────────────────────────────────────
 *   · 路线 + 站环 + 钉**全程静态常驻**（无描边/无弹跳）——画面主体恒定，循环无接缝；
 *     唯一变量是光点（1200ms 循环：淡入 → 行进 → 折点脉冲 → 钻孔淡出）。
 *   · >300ms 门在本组件内实现：宿主只需把 `active` 绑到自己的加载态，
 *     若加载在 300ms 内结束（active 翻 false），光点从未出现（无闪烁）。
 *   · reduced-motion：全局杀开关（globals.css :541）把循环压成 0.01ms 单次 ⇒
 *     光点停在末帧（钻孔后 opacity 0）⇒ 呈现静态 mark。架构评估 §四裁定
 *     「符合设计意图，无需处理」⇒ 本组件不写任何 reduced-motion 特判。
 *
 * ── 红线 ──────────────────────────────────────────────────────────────
 *   · 不引第三方库 / 不动态 import（体积红线）；颜色全走 class token；
 *   · mask id 用 `useId()`（可与开屏/BrandMark 同页共存）；
 *   · 光点 cx/cy 缺省 (0,0)（同 BrandSplash —— offset-path 锚点即圆心）。
 */
"use client";

import { useEffect, useId, useState } from "react";

export interface BrandRouteLoaderProps {
  /** 宿主的加载态：true 开始计时，持续 >300ms 才显示；翻 false 立即消失（含未显示期） */
  active: boolean;
  /** 边长（px）；规格 §5 给 48–64，默认 48 */
  size?: number;
  /** 分步文案（主角）；缺省只出图标 */
  label?: string;
  /**
   * 调用点消歧（观测钩子）。两个调用点可能同时存在，`[data-loader-root]` 会命中多个：
   *   · `map-cover`  遮「开屏结束 → 地图就绪」的空窗（居中、无 label）
   *   · `request`    遮请求等待（内联在文案行左侧、带 label）
   * ⚠️ 不提供 `data-loader-state`：组件在 `!active || !visible` 时 `return null`，
   *    「未加载」在 DOM 里没有节点 ⇒ 该属性恒为 "loading"，断言它恒真、零信息量。
   */
  slot?: "map-cover" | "request";
}

/**
 * 快路径门控时长（ms，按插槽区分）：真实加载超过它才出现动画。
 *
 * · `map-cover`（居中位）⇒ **0**：开屏覆盖层（z-200 全屏）已经把这段加载遮了 ~960ms，
 *   用户从未见过「空的加载位」，因此这里再加 300ms 门控只会造成「开屏撤走 → 空 300ms →
 *   小 M 才出现」的空窗。开屏撤走的同一帧就该有小 M 在场（P7c）。
 * · `request`（内联位，带 label）⇒ **300**：快速请求不闪动画（NN/g：<1s 无需反馈）。
 */
const GATE_MS_BY_SLOT: Record<NonNullable<BrandRouteLoaderProps["slot"]>, number> = {
  "map-cover": 0,
  request: 300,
};

export default function BrandRouteLoader({ active, size = 48, label, slot = "map-cover" }: BrandRouteLoaderProps) {
  const maskId = `mm-loader-hole-${useId().replace(/:/g, "")}`;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false); // 未显示期就翻 false ⇒ 计时器随 cleanup 取消，光点从未出现
      return;
    }
    const gate = GATE_MS_BY_SLOT[slot];
    if (gate <= 0) {
      setVisible(true); // 门控为 0：立即出现，不留空窗
      return;
    }
    const t = window.setTimeout(() => setVisible(true), gate);
    return () => window.clearTimeout(t);
  }, [active, slot]);

  if (!active || !visible) return null;

  return (
    <div
      className="brand-loader"
      role="status"
      aria-live="polite"
      data-loader-root="1"
      data-loader-mode="loop"
      data-loader-slot={slot}
    >
      <svg
        className="brand-anim--loop"
        width={size}
        height={size}
        viewBox="1.15 0.85 60 60"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
            <rect x="0" y="0" width="64" height="64" fill="#fff" />
            <circle cx="12" cy="48" r="3.9" fill="#000" />
            <circle cx="30" cy="34" r="3.9" fill="#000" />
            <circle cx="48" cy="16" r="2.7" fill="#000" />
          </mask>
        </defs>
        {/* 静态常驻：路线/钉在 mask 组内；站环全程可见（同 BrandMark 构图） */}
        <g mask={`url(#${maskId})`}>
          <path
            className="brand-mark__route"
            d="M12 48 L12 16 L30 34 L48 16"
            fill="none"
            strokeWidth="6.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path className="brand-mark__pin" d="M40.29 18.13 L48 46 L55.71 18.13 A8 8 0 1 0 40.29 18.13 Z" />
        </g>
        <circle className="brand-mark__station" cx="12" cy="48" r="4.6" fill="none" strokeWidth="2.2" />
        <circle className="brand-mark__station" cx="30" cy="34" r="4.6" fill="none" strokeWidth="2.2" />
        {/* 唯一变量：光点（cx/cy 缺省 (0,0)；循环动画见 CSS `.brand-anim--loop` 段） */}
        <circle className="brand-anim__dot" r="2.6" />
      </svg>
      {label ? <span className="brand-loader__label">{label}</span> : null}
    </div>
  );
}
