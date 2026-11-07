"use client";

/**
 * 站序单行（src/components/line/LineStopRow.tsx，v3.6.0 · S6）
 *
 * ── 结构（设计 §2.8）────────────────────────────────────────────────────
 *   .lp-stop
 *     ├ .lp-stop__rail  线路色竖线 3px（首站从圆点起、末站到圆点止）
 *     ├ .lp-stop__dot   9px 空心圆（线路色描边）／首末站 11px 实心
 *     ├ .lp-stop__body
 *     │   ├ .lp-stop__name  站名（繁体原文，**不做简繁转换**）
 *     │   └ .lp-stop__xfer  「换乘 3 路、25 路」（可选，最多 3 条）
 *     └ .lp-stop__eta   报站三态，固定 16px 高（**不画骨架**，列表零跳动）
 *
 * ── ★ 2026-11-06（问题 #5c）：纵条上的**四态巴士图标** ────────────────────
 *   新增尾元素 `.lp-stop__veh`（`position:absolute`，**不入 flex 流**）：
 *   · **不传 `veh` ⇒ 该元素完全不渲染** ⇒ 既有消费方（`/line/[code]` 页、
 *     通琴号 `LineStopsSheet`）的 DOM 与改前**逐字节一致**（零回归，不动版式）。
 *   · 四态（`data-veh` 四值，**色盲安全** —— 形状/环宽不同，不靠颜色区分）：
 *
 *     | `data-veh` | 语义 | 判据（数据层给） | 盘 | 环 |
 *     |---|---|---|---|---|
 *     | `ready`    | 准备发车 | 在首站且未发车 | 空心（`--surface` 底 + 主题色描边） | 无 |
 *     | `stop`     | 停站 | DSAT `status=1`（停靠挂载站） | 实心 | 无 |
 *     | `approach` | 进站 | `status=0` 且 `stopsAway ≤ 1` | 实心 | **4px 强环 + 1.6s 呼吸** |
 *     | `moving`   | 站间行驶 | 其余 | 实心 | 2px 弱环 |
 *
 *   · `moving` 的纵向位置 = 比例变量 `--veh-frac`（`frac ∈ [0,1]` 为本行到**下一行**
 *     节点的插值比例），**表达式只写在 CSS**：`top: calc(50% + var(--veh-frac) * 100%)`。
 *     ⇒ 与本项目导航纵条的 `--you-frac`（`globals.css:6904`）**同一口径**，别另造第二套插值表达。
 *     ⚠️ **陷阱（前端 A 登记，本行已按「变量」路线收口，不再有内联 `top`）**：
 *        若哪天把 `--veh-frac` 的写出删掉/按 state 分支漏写，CSS 的 `var(--veh-frac, 0)`
 *        会**静默**退化成 0 ⇒ 行驶中的车吸在本行节点上，不报错、不告警。
 *        故本行**无条件写出该变量**（四种态都写，非 `moving` 写 0），从结构上消除漏写面。
 *   · ★ 防 NaN（Spec 5c 断言）：`frac` 非有限值或越界 ⇒ **夹到 [0,1]**；
 *     数据层在 `gap_sec <= 0` 时本就不该给 `moving`（应吸附终点 + 取 `stop`），
 *     本行只做渲染层的最后一道夹取。
 *
 *   ⚠️ **`data-veh` 与 `body[data-veh]` 同名但不同义**（后者见 `nav/observe-hooks.ts:14`：
 *      `fresh|stale|failed|open` 是**车辆数据新鲜度**）。二者**元素不同**（`li` vs `body`），
 *      `body[data-veh=...]` 这类选择器不会串；但**未限作用域的 `[data-veh]` 会双匹配**。
 *      故本行额外输出 `data-veh-scope="stops"`，QA 请用 `.lp-stop__veh[data-veh]` 或
 *      `[data-veh-scope="stops"]` 定位。
 *
 * ── `data-eta` 是本行的断言抓手（AC-42a / AC-46）────────────────────────
 *   `idle` = 还没加载（空白但占位）· `on` = 有车 · `none` = 无车 / 轻轨。
 *   ⚠️ 即使 CSS 把报站列隐藏（轻轨场景），**属性也必须照常输出到 DOM** ——
 *      渲染层断言抓属性，不抓可见性。禁止用「不渲染这个 span」来实现隐藏。
 *
 * ── `data-kind` 挂在 `.lp-page`（容器上），本行不重复 ──────────────────────
 */
import type { CSSProperties } from "react";
import Icon from "@/components/ui/Icon";
import type { EtaState } from "./useLazyEta";
import type { LineStop } from "@/lib/line/line-shared";

/** 纵条巴士图标的四态（互斥且完备 —— 任一时刻恰好一个，Spec #5c） */
export type VehState = "ready" | "stop" | "approach" | "moving";

/** 巴士图标的状态载荷（由数据层算好，本行只渲染） */
export interface LineStopVeh {
  state: VehState;
  /**
   * `moving` 时在本行 → **下一行**之间的插值比例（0 = 本行节点，1 = 下一行节点）。
   * 其余三态忽略。非有限值/越界会被夹到 [0,1]（防 `NaN` 进 CSS）。
   */
  frac?: number | null;
  /** 巴士信息摘要（车牌 · 运营商 · 还有几站），用于按钮 `aria-label` */
  label?: string | null;
}

/** 盘径（22 = 16px 图标 + 左右各 3px 呼吸） */
const VEH_DISC = 22;
/* 命中区外扩 (44 − 22) / 2 = 11 ⇒ 44×44（WCAG 2.5.5）——**已交 CSS**：
   `.lp-stop__veh-hit { position:absolute; inset:-11px }`（`globals.css`）。
   本文件不再持有该常量 ⇒ 否则就是「两套边界做法」（内联 + 类各写一遍）。 */

/**
 * 四态的静态外观（**颜色/形状差异只是冗余编码**，主编码是 `data-veh` 与环宽）。
 * `breath` 只输出 `data-veh-anim`，真动画由 CSS 给（见下方注释：内联 `animation`
 * 无法被 `prefers-reduced-motion` 关掉，故本文件**刻意不写内联动画**）。
 */
const VEH_LOOK: Record<VehState, { solid: boolean; ringPx: number; ringAlpha: number }> = {
  ready: { solid: false, ringPx: 0, ringAlpha: 0 },
  stop: { solid: true, ringPx: 0, ringAlpha: 0 },
  approach: { solid: true, ringPx: 4, ringAlpha: 0.4 },
  moving: { solid: true, ringPx: 2, ringAlpha: 0.22 },
};

export interface LineStopRowProps {
  stop: LineStop;
  /** 站序下标（0 基）—— 用于判首末站 */
  index: number;
  total: number;
  /** 线路主题色（竖线 / 圆点描边） */
  color: string;
  /** 报站三态 */
  eta: EtaState;
  /** 换乘线路（已去掉本线，最多 3 条） */
  xfer: string[];
  /** 登记 DOM（IntersectionObserver 需要） */
  registerEl: (code: string, el: HTMLElement | null) => void;
  /**
   * ★ 2026-11-05（通琴号 R6 / `03-UIUX.md` §17-R4）：站的**属地**小标签。
   *   只由通琴号站序弹窗传（`澳` / `琴`）；不传 ⇒ **DOM 与改前逐字节一致**（零回归）。
   *   属地是**中性元数据** ⇒ 底色 `--surface-2` / 字色 `--meta`（5.04:1 达标），
   *   **不用主题色**（主题色只属通琴号线本身）。
   */
  side?: "澳门" | "横琴";
  /**
   * ★ 2026-11-06（#5c）：本行的巴士图标状态。**不传 / null ⇒ 不渲染该元素**
   *   ⇒ 既有消费方 DOM 零变化。轻轨（无实时车辆）与通琴号（无实时源）**恒不传**。
   */
  veh?: LineStopVeh | null;
  /**
   * ★ 2026-11-06（#5c）：点巴士图标 → 打开巴士信息弹窗。
   *   不传 ⇒ 图标渲染为**非交互 `span`**（不做「死键」：绝不渲染一个点了没反应的 button）。
   */
  onOpenBusCard?: ((veh: LineStopVeh) => void) | null;
}

/** 把 `frac` 夹进 [0,1]；非有限值（NaN / ±Infinity）⇒ 0（吸附本行节点） */
function clampFrac(v: number | null | undefined): number {
  if (v == null || !Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export default function LineStopRow({
  stop,
  index,
  total,
  color,
  eta,
  xfer,
  registerEl,
  side,
  veh,
  onOpenBusCard,
}: LineStopRowProps) {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const isEnd = isFirst || isLast;

  return (
    <li
      ref={(el) => registerEl(stop.code, el)}
      data-stop-code={stop.code}
      data-eta={eta.phase}
      data-stop-end={isEnd ? "1" : undefined}
      className="lp-stop"
      style={{ ["--lp-color" as string]: color }}
    >
      <span className="lp-stop__rail" data-edge={isFirst ? "start" : isLast ? "end" : undefined} aria-hidden="true" />
      <span className="lp-stop__dot" data-end={isEnd ? "1" : undefined} aria-hidden="true" />
      <span className="lp-stop__body">
        {/* ★ R6：站名与属地标签同一行；站名优先占位（`flex:1 min-width:0`），标签 `flex:none` 不参与省略 */}
        <span className="lp-stop__namerow">
          <span className="lp-stop__name">{stop.name}</span>
          {side && (
            <span
              className="lp-stop__side"
              aria-label={side === "横琴" ? "横琴侧" : "澳门侧"}
              data-side={side}
            >
              {side === "横琴" ? "琴" : "澳"}
            </span>
          )}
        </span>
        {xfer.length > 0 && (
          <span className="lp-stop__xfer">换乘 {xfer.join("、")}</span>
        )}
      </span>
      {/* 三态同高 16px：idle 留空（不放骨架/省略号），出现与替换时列表不跳动 */}
      <span className="lp-stop__eta">
        {eta.phase === "on" ? eta.text : eta.phase === "none" ? "—" : null}
      </span>
      {veh && <VehMark veh={veh} onOpen={onOpenBusCard ?? null} disabled={!vehOnRideable(veh)} />}
    </li>
  );
}

/**
 * 该态是否「有车在跑」（决定图标可不可点）。
 * `ready` = 车还没发车 ⇒ 没有可展示的行车信息 ⇒ 不交互（但仍显示，表达「待发车」）。
 */
function vehOnRideable(veh: LineStopVeh): boolean {
  return veh.state !== "ready";
}

/**
 * 纵条巴士图标（四态）。
 *
 * ── 为什么 `position:absolute` 而非入 flex 流 ────────────────────────────
 *   `LineStopRow` 的版式（节点 `left:12px` / 竖线 `left:15px` / 文字 `padding-left:26px`）
 *   正被**前端 B 的任务 #2** 依赖，改任何一处都会撞。绝对定位 ⇒ 不参与 flex 计算、
 *   不改变行高（`min-height:56px` 保持不变）、不影响文字换行。
 *
 * ── 坐标 ────────────────────────────────────────────────────────────────
 *   竖线 `left:15px` + 宽 3px ⇒ 中心 `16.5px`；圆点 `left:12px` + 9px ⇒ 中心同为 `16.5px`。
 *   图标盘 `22px` ⇒ `left: 16.5px` + `translateX(-50%)` 即与节点同心。
 *
 * ── 动画为什么只留钩子 ──────────────────────────────────────────────────
 *   `approach` 的 1.6s 呼吸必须能被 `prefers-reduced-motion` 关掉。内联 `animation`
 *   **无法**被媒体查询覆盖 ⇒ 故此处只输出 `data-veh-anim="breath"`，keyframes 交 CSS。
 *   ★ 2026-11-06：`@keyframes lpVehBreath` + reduce 分支**已由前端 A 入库**
 *     （`globals.css` 的 `.lp-stop__veh[data-veh-anim="breath"] .lp-stop__veh-disc`）。
 */
function VehMark({
  veh,
  onOpen,
  disabled,
}: {
  veh: LineStopVeh;
  onOpen: ((veh: LineStopVeh) => void) | null;
  disabled: boolean;
}) {
  const look = VEH_LOOK[veh.state];
  /**
   * ★ `frac` 的契约是「**仅 `moving` 有意义，其余三态忽略**」（见 `LineStopVeh.frac`）。
   *   非 `moving` 一律夹成 0 ⇒ 图标吸附本行节点。不能让数据层误传的 `frac` 生效：
   *   `data-veh="stop"` 却把图标画在行间，是**视觉与语义自相矛盾**的静默错位。
   */
  const frac = veh.state === "moving" ? clampFrac(veh.frac) : 0;
  const ring = look.ringPx > 0 ? `0 0 0 ${look.ringPx}px color-mix(in srgb, var(--lp-color) ${look.ringAlpha * 100}%, transparent)` : undefined;

  /** 盘 + 中的巴士图标（图标走全站唯一出口 `<Icon>`，零新增图标库） */
  const visual = (
    <>
      <span
        className="lp-stop__veh-disc"
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: VEH_DISC,
          height: VEH_DISC,
          marginLeft: -VEH_DISC / 2,
          marginTop: -VEH_DISC / 2,
          boxSizing: "border-box",
          borderRadius: "var(--radius-full)",
          /* `ready` 空心盘：`--surface` 底 + 主题色描边；其余实心 */
          background: look.solid ? "var(--lp-color)" : "var(--surface)",
          border: look.solid ? "0" : "1.5px solid var(--lp-color)",
          boxShadow: ring,
        }}
      >
        {/*
          字色由 `globals.css` 的 `.lp-stop__veh-ico` **四态规则**决定，**不在 TSX 内联**：
          · `[data-veh="ready"]` ⇒ `var(--lp-color, var(--primary))`（空心盘 + 线路色图标）
          · `stop` / `approach` / `moving` ⇒ `#fff`（实心盘 + 白图标，R6 裁决）
          ⚠️ `className` 是 CSS 的**唯一挂载点 —— 不可删**（删了四态字色全部失效，
             实心盘会回落成继承色 ⇒ 深字压线路色底，直接踩 R6）。
          ⚠️ 本 span 的**布局**（`position/inset/display/placeItems`）仍在内联：
             `globals.css` 目前**只**有 `.lp-stop__veh-ico` 的 `color` 规则、无布局规则
             （已 grep 确认），此刻把布局也搬走会让图标失去居中 ⇒ 等 A 补布局规则后再迁。
        */}
        <span
          className="lp-stop__veh-ico"
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
          }}
        >
          <Icon name="bus" size={16} />
        </span>
      </span>
      {/* 命中区 44×44（真元素而非 `::after` ⇒ `getBoundingClientRect()` 可量到）。
          几何由 `.lp-stop__veh-hit` 给（`position:absolute; inset:-11px`）。 */}
      <span className="lp-stop__veh-hit" aria-hidden="true" />
    </>
  );

  const shared = {
    className: "lp-stop__veh",
    "data-veh": veh.state,
    "data-veh-scope": "stops" as const,
    "data-veh-anim": veh.state === "approach" ? ("breath" as const) : undefined,
    style: {
      position: "absolute" as const,
      /* 竖线中心 16.5px = 15 + 3/2（与 `.lp-stop__rail` 同源，改 rail 时须同步） */
      left: "16.5px",
      /* ★ 纵向比例：**只交变量**，表达式在 CSS（`calc(50% + var(--veh-frac) * 100%)`）。
         无条件写出（含非 moving 的 0）⇒ 结构上没有「漏写 ⇒ 恒 0 静默吸节点」的可能。 */
      ["--veh-frac" as string]: String(frac),
      transform: "translate(-50%, -50%)",
      zIndex: 3,
      width: VEH_DISC,
      height: VEH_DISC,
      padding: 0,
      border: 0,
      background: "transparent",
      cursor: onOpen && !disabled ? "pointer" : "default",
    } as CSSProperties,
  };

  if (!onOpen || disabled) {
    return (
      <span {...shared} role="img" aria-label={veh.label ?? "线路车辆"}>
        {visual}
      </span>
    );
  }
  return (
    <button
      {...shared}
      type="button"
      aria-label={`查看巴士信息${veh.label ? `：${veh.label}` : ""}`}
      onClick={(e) => {
        /* 行本身在弹窗内可滚；不阻止冒泡会让上层的手势/点按逻辑收到这次点击 */
        e.stopPropagation();
        onOpen(veh);
      }}
    >
      {visual}
    </button>
  );
}
