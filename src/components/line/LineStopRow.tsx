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
 *         └ .lp-stop__time  计划时刻 `HH:MM`（★ 2026-11-08，**可选**；不传即不渲染）
 *
 * ── ★ 2026-11-06（问题 #5c）：纵条上的**四态巴士图标** ────────────────────
 *   新增尾元素 `.lp-stop__veh`（`position:absolute`，**不入 flex 流**）：
 *   · **不传 `veh` ⇒ 该元素完全不渲染** ⇒ 既有消费方（`/line/[code]` 页、
 *     通琴号 `LineStopsSheet`）的 DOM 与改前**逐字节一致**（零回归，不动版式）。
 *   · 四态（`data-veh` 四值，**色盲安全** —— 形状/环宽不同，不靠颜色区分）：
 *
 *     | `data-veh` | 语义 | 判据（数据层给） | 字形修饰（`BusGlyph`） | 环 |
 *     |---|---|---|---|---|
 *     | `ready`    | 准备发车 | 在首站且未发车 | **虚线圈**（总站待发） | 无 |
 *     | `stop`     | 停站 | DSAT `status=1`（停靠挂载站） | **「‖」徽章**（停靠中） | 无 |
 *     | `approach` | 进站 | `status=0` 且 `stopsAway ≤ 1` | 无 | **4px 强环 + 1.6s 呼吸** |
 *     | `moving`   | 站间行驶 | 其余 | 无 | 2px 弱环 |
 *
 *   · ★ 2026-11-07（返工 #1）：图标本体换成**地图那套** `<BusGlyph>`
 *     （与 `VehicleMarker` 共用同一份 SVG，不再用 Tabler 的通用 `bus` 线条图标）：
 *     车头正视图 + 硬投影 + 白描边 + 墨色描边 + **线路色涂装** + 后视镜 / 线路牌 /
 *     挡风玻璃 / 大灯 / 保险杠；状态修饰（虚线圈 / ‖ / !）与地图侧同源。
 *     线路色经 `livery` 注入（`var(--lp-color, var(--primary))` ⇒ 与纵条同源）。
 *     · 原先的「22px 实心/空心圆盘 + 白色线条图标」退场：盘变成**只画环的透明层**
 *       （`.lp-stop__veh-disc` 仍是呼吸动画的挂载点，CSS 依赖它，不可删）。
 *     · 尺寸 `22px`（32 单位画布等比缩到 0.6875）：再小则挡风玻璃/大灯糊成一团，
 *       再大则右边缘压字 —— 实测值见 `.verify/_fe-c-stoprow-geom.mjs`（真浏览器）。
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
 *   ⚠️ **横向占位（返工 #1 · 真浏览器逐像素实测，不是估算）** ────────────────
 *     图标壳中心 `16.5px`（= 竖线 `left:15` + `3/2`，与 rail / dot 同源），壳 22px
 *     ⇒ 盒子 `5.5 ~ 27.5px`。**实际着墨**（含 box-shadow 外环与「‖」徽章，
 *     375px 列宽 / DPR 2，隐藏↔显示图标两帧逐像素差的 bbox）：
 *
 *     | `data-veh` | 着墨 x 范围（相对行左） | 最外沿 |
 *     |---|---|---|
 *     | `ready`（虚线圈） | 7.5 ~ 27 | 27 |
 *     | `stop`（‖ 徽章） | 7.5 ~ 28 | 28 |
 *     | `approach`（4px 呼吸环） | 2 ~ 32 | **32** |
 *     | `moving`（2px 环） | 4 ~ 30 | 30 |
 *
 *     ⇒ 站名文字起点必须 ≥ `32 + 4`（车主诉求：左右各留 4px）= **36px**。
 *       现行 `.lp-stop { padding-left: 26px }`（`globals.css`）**不够** ——
 *       实测右间距是 `ready −1 / stop −2 / approach −6 / moving −4` px，
 *       也就是**已经在压字**（改前的 16px Tabler 图标右沿 24.5px 只是"没压到"而已，
 *       换成本字形立刻暴露）。
 *       故 **必须**由 CSS 负责人把 `padding-left` 提到 **36px**（规则原文见交付报告）。
 *       落地后实测右间距：`9 / 8 / 4 / 6` px，站名可用宽度仍 ≥ 211px。
 *       本文件不自作主张：`.lp-stop` 的版式归 `globals.css`（前端 B 的域）。
 *     ⚠️ 反模式提醒：**不要**用「给 body 加 padding」实现同样的效果 —— 那是把
 *       同一个位移写成两套（li 的 padding-left + body 的 padding），早晚不同步。
 *
 *   ⚠️ **纵向（相邻行）**：行高 `min-height:56px`，图标盒 22px 垂直居中 ⇒
 *      上下各余 17px；`approach` 的 4px 呼吸环保留 ⇒ 实测余量 上 13.2 / 下 12.8px。
 *      `ready` / `stop` / `approach`（`frac=0`，吸附本行节点）**完全落在本行内**；
 *      `moving` 按契约画在两行之间（`frac=0.5` 时中心正好在交界）⇒ 必然跨行，
 *      但它的 **x 范围全程在文字列左侧**，实测「压到任何一行站名文字」= 0 行。
 *      证据：`.verify/_fe-c-stoprow-geom.mjs` 的 [4] 段（真 Chrome 逐像素差）。
 *
 * ── `data-eta` 是本行的断言抓手（AC-42a / AC-46）────────────────────────
 *   `idle` = 还没加载（空白但占位）· `on` = 有车 · `none` = 无车 / 轻轨。
 *   ⚠️ 即使 CSS 把报站列隐藏（轻轨场景），**属性也必须照常输出到 DOM** ——
 *      渲染层断言抓属性，不抓可见性。禁止用「不渲染这个 span」来实现隐藏。
 *
 * ── `data-kind` 挂在 `.lp-page`（容器上），本行不重复 ──────────────────────
 */
import type { CSSProperties } from "react";
import BusGlyph, { type BusGlyphState } from "@/components/nav/BusGlyph";
import type { EtaState } from "./useLazyEta";
import type { LineStop } from "@/lib/line/line-shared";

/** 纵条巴士图标的四态（互斥且完备 —— 任一时刻恰好一个，Spec #5c） */
export type VehState = "ready" | "stop" | "approach" | "moving";

/**
 * 纵条四态 → `<BusGlyph>` 的**字形状态**。
 * 值恰好同名，但**不要**把两张表合并：纵条说的是「车相对本站在干什么」，
 * 字形说的是「画哪些修饰」。将来若纵条加第五态（例如"末班已发"），
 * 这里能独立退化到无修饰，而字形不必跟着改。
 */
const VEH_GLYPH_STATE: Record<VehState, BusGlyphState> = {
  ready: "ready",
  stop: "stop",
  approach: "approach",
  moving: "moving",
};

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

/** 盘径 22 = 字形 22（盘已退化成"只画环"的透明层，见文件头注释） */
const VEH_DISC = 22;
/** 字形渲染尺寸 = 22px（与壳/盘同尺寸）；实测着墨最外沿 32px ⇒ 文字起点须 36px（见文件头实测表） */
const VEH_GLYPH = VEH_DISC;
/* 命中区外扩 (44 − 22) / 2 = 11 ⇒ 44×44（WCAG 2.5.5）——**已交 CSS**：
   `.lp-stop__veh-hit { position:absolute; inset:-11px }`（`globals.css`）。
   本文件不再持有该常量 ⇒ 否则就是「两套边界做法」（内联 + 类各写一遍）。 */

/**
 * 四态的**外环**（色盲安全的形状编码；盘底不再上色 —— 涂装在字形里）。
 * `breath` 只输出 `data-veh-anim`，真动画由 CSS 给（见下方注释：内联 `animation`
 * 无法被 `prefers-reduced-motion` 关掉，故本文件**刻意不写内联动画**）。
 */
const VEH_LOOK: Record<VehState, { ringPx: number; ringAlpha: number }> = {
  ready: { ringPx: 0, ringAlpha: 0 },
  stop: { ringPx: 0, ringAlpha: 0 },
  approach: { ringPx: 4, ringAlpha: 0.4 },
  moving: { ringPx: 2, ringAlpha: 0.22 },
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
   * ★ 2026-11-08：本站的**计划时刻**（已格式化 `HH:MM`，通琴号用）。
   *
   *   · **不传 / `null` / 空串 ⇒ 该元素完全不渲染** ⇒ 既有消费方
   *     （`/line/[code]` 页、`RouteStopsSheet`）的 DOM 与改前逐字节一致（硬要求）。
   *   · 这是**计划时刻表**里的时刻，不是报站：文案只放时刻本身，
   *     禁止出现「还有 N 分钟」「即将到站」「实时」这类暗示实时的措辞。
   *   · ⚠️ 渲染在 **`.lp-stop__eta` 内部**（不是新增一列），原因见下方 `render` 处注释：
   *     320px 实测新增独立列会把站名从 125px 压到 90px（7/7 行被省略号截断）。
   *   · `data-eta` 三态契约**不变**：属性取值与「on/none 文案」逻辑逐字未动，
   *     计划时刻只是在同一格里**追加**（两者不会同时出现：通琴号无实时源）。
   */
  plannedTime?: string | null;
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
  plannedTime,
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
      {/* 三态同高 16px：idle 留空（不放骨架/省略号），出现与替换时列表不跳动。
          ★ 2026-11-08：计划时刻 `plannedTime` 渲染在**同一个格子里**（右对齐列）。
          ⚠️ 为什么不是独立一列（真浏览器实测，不是估算）：
             视口 320px 时 `.lp-list` 内宽 288 − 左内距 36 − 两处 gap 16 − `.lp-stop__eta`
             的 `min-width:96px` ⇒ 站名只剩 125px；再塞一列时刻（27px）后掉到 **90px**，
             7/7 行全部出现省略号（改前是 0/7 需要时……实测 7/7 已截断，本列再压 28%）。
             而通琴号的报站列**恒空**（无实时源，`etaOf` 恒 idle）⇒ 这 96px 本来就是空转的，
             把计划时刻放进去：站名宽度**回到改前**，时刻贴右边缘对齐，不留空洞。
          ⚠️ `data-eta` 仍是 `eta.phase`（属性逐字未动），只有「on / none」才出文案，
             计划时刻是**追加**内容 ⇒ 三态契约不变。 */}
      <span className="lp-stop__eta">
        {plannedTime ? <span className="lp-stop__time">{plannedTime}</span> : null}
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
 * ── 盘为什么"只剩环"（返工 #1）─────────────────────────────────────────
 *   改前：22px 圆盘上色（ready 空心 / 其余实心）+ 16px 白色 Tabler 线条图标。
 *   现在：字形自带涂装 + 白描边 + 墨描边 ⇒ **再垫一层实心底就会把字形吃掉**
 *   （白描边层压在线路色盘上 = 白环套色环，巴士被挤成色块）。
 *   ⇒ 盘只保留 `boxShadow` 外环（approach 4px / moving 2px，色盲安全的形状编码），
 *     底与描边一律透明；`ready` / `stop` 的识别改由**字形自身的修饰**承担
 *   （虚线圈 / ‖ 徽章），与地图 marker 完全一致 —— 正是车主说的「含行驶、停站等样式」。
 *   ⚠️ `.lp-stop__veh-disc` 这个类**不能删**：`globals.css` 的 `@keyframes lpVehBreath`
 *      与 `prefers-reduced-motion` 分支都挂在它上面。
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

  /** 环 + 字形（字形与地图 marker 共用 `nav/BusGlyph`，零新增图标库、零 emoji） */
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
          /* 盘**只画环**：底色/描边全透明（实心底会与字形的白描边层打架，见函数头注释） */
          background: "transparent",
          border: 0,
          boxShadow: ring,
        }}
      >
        {/*
          `.lp-stop__veh-ico` 现在只负责**居中**（原先是四态字色的挂载点）。
          `globals.css` 里那两条 `color` 规则（ready ⇒ 线路色 / 其余 ⇒ #fff）
          对本字形**不生效也无害**：字形每一层都是显式 fill，不吃 `color`。
          ⚠️ 类名仍**不可删** —— CSS 侧有四态规则挂在它上面
             （删了它们就变成死规则，`_fe-c-veh.tsx` 的 [10] 段会报红）。
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
          {/* 线路色即涂装色：纵条与车同色（本层拿不到运营商 company，也不该造第二个数据源） */}
          <BusGlyph size={VEH_GLYPH} state={VEH_GLYPH_STATE[veh.state]} livery="var(--lp-color, var(--primary))" />
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
