"use client";

/**
 * 巴士字形（src/components/nav/BusGlyph.tsx，v1.0.0 · #1 站序纵条图标返工）
 *
 * ── 为什么单独成文件 ──────────────────────────────────────────────────────
 *   车主反馈 #1：「站序弹窗纵轴上的巴士图标你画错了，我要的是**地图上那种**
 *   巴士图标的样式，含行驶、停站等样式」。
 *   ⇒ 车头正视图这套 SVG（32 单位画布 / 7 组图形 / 状态修饰）**只允许一份**：
 *     地图 marker（`VehicleMarker`）与站序纵条（`LineStopRow` 的 `VehMark`）
 *     共用本组件。禁止任何一处再抄一遍 rect 坐标 —— 两套 = 早晚画歪。
 *
 * ── 只画 SVG，不画交互壳 ────────────────────────────────────────────────
 *   ❌ 不含 `<button class="vbus-wrap">`（44×44 命中盒 + `data-state` 是
 *      `VehicleMarker` 自己的交互壳，属于地图 marker 的域）
 *   ✅ 只输出 `<svg class="vbus" viewBox="0 0 32 32">` ⇒ 任何容器按需缩放
 *
 * ── 状态为什么用内联 `display` 而不是 CSS 类 ────────────────────────────
 *   `.vbus__stop / .vbus__lost / .vbus__dash` 的 `display` 在 `globals.css`
 *   里由 **`.vbus-wrap[data-state=…]`** 驱动 —— 那只在地图 marker 的壳里成立。
 *   纵条里没有 `.vbus-wrap`（也不该有：44px 壳会撞行高），若只靠 CSS，
 *   纵条上的「虚线圈 / ‖ / !」会**静默全部不显示**（默认 `display:none`），
 *   不报错、不告警 —— 正是最坏的那类静默失效。
 *   ⇒ 字形自带状态渲染：三组修饰节点各写一条内联 `display`。
 *   · 地图侧与 CSS **取值完全等价**（见 `_fe-c-glyph-snap.tsx` 的等价表断言，
 *     该表逐条对读 `globals.css:5889-5936` 的规则）；
 *   · 内联只写 `display`，**不写** `fill` / `opacity` / `stroke` ——
 *     涂装淡色（terminal）、转灰（lost）、末班琥珀（data-last）仍 100% 由 CSS 管。
 *
 * ── 涂装色 ──────────────────────────────────────────────────────────────
 *   `--vbus-livery` 是**数据**（运营商色 / 线路色），一律由调用方注入：
 *   · `VehicleMarker` **不传** ⇒ 字形沿用祖先 `.vbus-wrap` 的 `--vbus-livery`
 *     （地图侧零冗余，视觉逐像素不变）；
 *   · 站序纵条传 `var(--lp-color, var(--primary))`（线路主题色）。
 *   `--vbus-ink`（墨色描边）由本组件按同一公式算出并内联：公式与
 *   `globals.css` 的 `.vbus-wrap { --vbus-ink: … }` **字面同源**，
 *   只是多一个 `var(--meta)` 回退 ⇒ 独立使用（无 `.vbus-wrap` 祖先）时也不会
 *   退化成"继承色"（那样深色主题下墨层会消失）。
 *
 * ── ★★ 三层同心矩形 = 互补双描边（**改之前必须读完本节**）──────────────
 *   字形不是"三层并列色块"，而是**依次内缩**的三个同心矩形：
 *
 *     .vbus__white  x5    y4    w22 h24   ← 最外：1.5px 白环
 *     .vbus__ink    x6.5  y5.5  w19 h21   ← 内缩 1.5：1.5px 墨环
 *     .vbus__body   x8    y7    w16 h18   ← 再内缩 1.5：涂装车身
 *
 *   白环 + 墨环是**互补双描边**，设计意图就是「**浅底靠墨、深底靠白**」各出一层轮廓：
 *
 *     | 宿主底色 | 白环 vs 底 | 墨环 vs 底 | 有效轮廓 |
 *     |---|---|---|---|
 *     | 浅色 `#ffffff` | 1.00:1（与底融合 —— **正是意图**） | **12.13:1** | 墨环 |
 *     | 深色 `#1c1e24` | **16.66:1** | 4.83:1 | 白环 |
 *
 *   （数字来自 `.verify/_css2-vbus-ink-contrast.mjs`，真 Chrome 读 computed fill 实测；
 *     涂装色取 `#1B4D8F`，卡片底取 `--surface`。
 *     ⚠️ 原报「21.00 / 1.25」系 `.verify/_fe-c-glyph-dark.mjs` 的**解析假绿，已更正**：
 *     它用 `css.match(/[\d.]+/g)` 解析 Chrome 的 `color(srgb 0.086 0.213 0.378)`，
 *     把 **0~1 归一化分量**当成 0~255 再取整 ⇒ `[0,0,0]` 纯黑（21.00 恰是 #000/#fff 的理论上限）
 *     与 `[0,1,1]`（≈1.25）。正确解析须对 `color(srgb…)` 分量 **×255**。
 *     墨环随 `--vbus-livery` 变 ⇒ 全库色域浅侧最坏 7.58（澳巴橙）、深侧最坏 4.83（轻轨深蓝）。）
 *
 *   ⛔⛔ **深色主题下白环呈现一圈「亮白轮廓」——这是双描边在深底上的正确行为，
 *        不是缺陷，已被 team-lead 裁决为「保持现状」。勿为"统一观感"把它改掉。**
 *
 *   · **不要**把 `.vbus__white` 在深色块里换成 `var(--surface)`：
 *     那会把互补双描边退化成单描边，浅色底上就只剩墨环可依赖（结构被破坏）。
 *   · **不要**把任一环删掉/合并、也不要给"每层都要 ≥3:1"设成门禁 ——
 *     那是**判据写错**（本组件开发中真实发生过一次假红）：浅色下白环 1.00:1
 *     是设计意图，正确判据是「**`max(各轮廓层 vs 底) ≥ 3:1`** + 车身 vs 紧邻内环 ≥1.5:1」。
 *   · **「深色主题下要与地图 marker 观感一致」这个目标不成立**，别拿它当验收标准：
 *     地图 marker 永远画在高德底图上，而本项目**未启用深色底图** ⇒
 *     「深色主题下的地图观感」在项目里根本不存在，属**不可验证**的要求。
 *     纵条宿主底是 `--surface`（随主题翻色），与地图的宿主底本就不同；
 *     同一个字形在不同宿主底上出不同轮廓层，是这套双描边的**设计本意**。
 *
 *   ⚠️ 与之配套的 CSS 在 `globals.css`：`.vbus__white { fill: #fff }` 等分层色
 *      （**前端 CSS 域**，不在本文件）。若你在那边看到这些规则想"顺手修正深色观感"，
 *      请先回读本节 —— 那不是 bug。
 *
 * ⚠️ 零 emoji：全部由 rect / circle 组成（P0-1）。
 */

import type { CSSProperties } from "react";

/**
 * 字形状态（**视觉修饰**，与数据层的车辆状态是两个概念，映射见调用方）。
 *   · `moving`   行驶中 —— 无修饰（地图上靠位置移动表达"在开"）
 *   · `stop`     停靠中 —— 右下角「‖」徽章
 *   · `approach` 进站中 —— 本组件无修饰；呼吸环由容器给（见下）
 *   · `ready`    总站待发 / 准备发车 —— 虚线白圈
 *   · `lost`     信号丢失 —— 虚线白圈 + 左下角「!」徽章
 *
 * ⚠️ `approach` 的 1.6s 呼吸**不在本组件**：呼吸环挂在容器（`.lp-stop__veh-disc`）
 *    的 `box-shadow` 上，由 `LineStopRow` 输出 `data-veh-anim="breath"`、CSS 给 keyframes。
 *    原因没变：内联 `animation` 无法被 `prefers-reduced-motion` 覆盖。
 */
export type BusGlyphState = "moving" | "stop" | "approach" | "ready" | "lost";

export interface BusGlyphProps {
  /** 渲染尺寸（px）；内部 `viewBox` 恒为 `0 0 32 32` ⇒ 等比缩放，不裁剪 */
  size?: number;
  /** 视觉修饰状态。缺省 `moving`（无修饰） */
  state?: BusGlyphState;
  /**
   * 涂装色（任意合法 CSS `<color>` 值，通常是 `#RRGGBB` 或 `var(--token)`）。
   * **不传** ⇒ 沿用祖先的 `--vbus-livery`，再回退中性色 `var(--meta)`。
   */
  livery?: string;
  /** 追加类名（与 `vbus` 并列，不替换） */
  className?: string;
}

/**
 * 三组状态修饰的可见性表 —— **唯一真相**，与 `globals.css` 的
 * `.vbus-wrap[data-state=…]` 规则逐条等价：
 *   stopping          ⇒ .vbus__stop
 *   terminal          ⇒ .vbus__dash
 *   lost              ⇒ .vbus__dash + .vbus__lost
 *   moving / unknown  ⇒ 无
 */
const MODIFIER_DISPLAY: Record<BusGlyphState, { dash: boolean; stop: boolean; lost: boolean }> = {
  moving: { dash: false, stop: false, lost: false },
  approach: { dash: false, stop: false, lost: false },
  stop: { dash: false, stop: true, lost: false },
  ready: { dash: true, stop: false, lost: false },
  lost: { dash: true, stop: false, lost: true },
};

/** 墨色描边：与 `.vbus-wrap { --vbus-ink }` 同一公式 + 中性回退 */
const INK_FORMULA = "color-mix(in srgb, var(--vbus-livery, var(--meta)) 58%, var(--fg))";

export default function BusGlyph({ size = 32, state = "moving", livery, className }: BusGlyphProps) {
  const mod = MODIFIER_DISPLAY[state];
  /** `display` 的三态：只有命中时才是 `block`，其余 `none`（与 CSS 同值） */
  const show = (on: boolean) => ({ display: on ? "block" : "none" }) as CSSProperties;

  return (
    <svg
      className={className ? `vbus ${className}` : "vbus"}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      data-glyph-state={state}
      style={{
        width: size,
        height: size,
        /* 涂装色：传了就内联（独立使用），没传就沿用祖先（地图 marker 的壳） */
        ...(livery ? { ["--vbus-livery" as string]: livery } : null),
        ["--vbus-ink" as string]: INK_FORMULA,
      }}
    >
      {/* ① 硬投影：车身剪影 translate(3 3)、零模糊（后视镜不投影，避免出画布） */}
      <g className="vbus__shadow" transform="translate(3 3)">
        <rect x="5" y="4" width="22" height="24" rx="5" />
      </g>
      {/* ② 白描边层 —— ⛔ 深色主题下这层会呈现「亮白轮廓」，那是双描边在深底的**正确行为**，
             不是缺陷（team-lead 已裁决保持现状）。**不要**在深色块里把它换成 var(--surface)：
             互补双描边会退化成单描边。详见文件头「三层同心矩形」一节。 */}
      <rect className="vbus__white" x="5" y="4" width="22" height="24" rx="5" />
      {/* ③ 墨色描边层（1.5px）—— 用同心矩形而非 stroke：stroke 居中会吃掉 3px 硬投影 */}
      <rect className="vbus__ink" x="6.5" y="5.5" width="19" height="21" rx="3.6" />
      {/* ④ 涂装车身（运营商/线路色，由 --vbus-livery 注入） */}
      <rect className="vbus__body" x="8" y="7" width="16" height="18" rx="2.2" />
      {/* ⑤ 后视镜（顶部两侧 ⇒ 「车头在上」的强线索） */}
      <rect className="vbus__mirror" x="2.2" y="10.2" width="3" height="2.6" rx="1.2" />
      <rect className="vbus__mirror" x="26.8" y="10.2" width="3" height="2.6" rx="1.2" />
      {/* ⑥ 极简扁平细节：线路牌 / 挡风玻璃 / 左右大灯 / 前保险杠 */}
      <rect className="vbus__sign" x="11.5" y="7" width="9" height="1.2" rx="0.6" />
      <rect className="vbus__glass" x="9.2" y="8.4" width="13.6" height="7.2" rx="1.8" />
      <circle className="vbus__lamp" cx="11.4" cy="19.4" r="1.9" />
      <circle className="vbus__lamp" cx="20.6" cy="19.4" r="1.9" />
      <rect className="vbus__bumper" x="8" y="22.4" width="16" height="2.2" rx="1.1" />
      {/* ⑦ 状态修饰 A：虚线白圈（总站待发 / 准备发车 / 信号丢失） */}
      <rect className="vbus__dash" x="5.75" y="4.75" width="20.5" height="22.5" rx="4.25" style={show(mod.dash)} />
      {/* ⑦ 状态修饰 B：停靠中 ‖（右下） */}
      <g className="vbus__stop" style={show(mod.stop)}>
        <circle className="vbus__badge-bg" cx="26" cy="26" r="4.8" />
        <rect className="vbus__badge-mark" x="23.7" y="23.4" width="1.6" height="5.2" rx="0.8" />
        <rect className="vbus__badge-mark" x="26.7" y="23.4" width="1.6" height="5.2" rx="0.8" />
      </g>
      {/* ⑦ 状态修饰 C：信号丢失 !（左下） */}
      <g className="vbus__lost" style={show(mod.lost)}>
        <circle className="vbus__badge-bg" cx="6" cy="26" r="4.8" />
        <rect className="vbus__badge-mark" x="5.35" y="23.2" width="1.3" height="3.3" rx="0.65" />
        <circle className="vbus__badge-mark" cx="6" cy="28" r="0.8" />
      </g>
    </svg>
  );
}
