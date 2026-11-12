"use client";

/**
 * 可变高度面板骨架（src/components/nav/BottomSheet.tsx，2026-09-23 新增）
 *
 * ── 结构（只动画 transform）─────────────────────────────────────────────
 *   ```
 *   section.route-sheet          position:fixed; top:0; height:100dvh;
 *     ├─ .route-sheet__panes     ← 各 pane 内容（推荐列表 / 详情），常驻不卸载
 *     ├─ .route-sheet__handle    ← 非 peek 头部（grip + bar）；起拖区
 *     └─ .route-sheet__peek      ← peek 档摘要（grip + OD + 指标）；起拖区 + 点按回默认档
 *   ```
 *   位移 = `transform: translateY(var(--sheet-y-anim))`；`--sheet-y-layout` 只喂滚动容器
 *   `padding-bottom`（档位落定才变 ⇒ 拖动中零重排）。
 *
 * ── 观测钩子（自动化验收 · **契约唯一名称，已冻结**）────────────────────
 *   · `data-sheet-state="recommend|detail"` —— 当前 pane；
 *   · `data-detent="full|half|peek"` —— 当前档；
 *   · `data-dragging="on|off"` · `data-open="on|off"`；
 *   · `data-phase="loading|ready|empty|failed"` —— 当前 pane 的数据阶段；
 *   · `data-live="on|none|ended"` —— 实时班次状态（在途车 / 未发车 / 已收班）。
 *   （`data-map="ok|failed"` 挂在 `NavMap` 容器上，与 `data-map-mask` 区分。）
 *
 * ⚠️ 必须挂在 `.nav-map-wrap` **之外**（wrap 是层叠上下文，挂进去会被底部 chrome 压住）。
 */
import type { CSSProperties, PointerEvent, ReactNode, RefObject } from "react";
import Icon from "@/components/ui/Icon";
import type { Detent } from "./sheet-detents";

export interface BottomSheetProps {
  /**
   * ★ 2026-09-25：`.route-sheet` 根元素 ref（透传给 `useSnapSheet` 做**命令式**位移写入，
   *   拖动期不触发 React 重渲染）。不传则退回 React style 驱动的落定位移。
   */
  sectionRef?: RefObject<HTMLElement | null>;
  open: boolean;
  /**
   * 当前 pane。★ 2026-11-12（P1-b）：新增 `"walk"`（独立步行导航）。
   * 本组件只把它写到 `data-sheet-state` 供观测，样式表**没有**按此值分支的选择器
   * （已全仓核对 `data-sheet-state` 零命中）⇒ 新增取值不会改变任何既有外观。
   */
  pane: "recommend" | "detail" | "walk";
  detent: Detent;
  /** 当前 pane 的数据阶段（观测钩子 `data-phase`） */
  phase: "loading" | "ready" | "empty" | "failed";
  /** 实时班次状态（观测钩子 `data-live`） */
  live: "on" | "none" | "ended";
  dragging: boolean;
  /** 当前 translateY（px，只喂 transform） */
  translateY: number;
  /** 滚动容器 padding（px，档位落定值） */
  layoutY: number;
  ariaLabel: string;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLDivElement>) => void;
  /** 点 peek 区回该 pane 默认档（`peekTapGuard()` 为 false 时忽略，避免拖完误触） */
  onPeekTap: () => void;
  peekTapGuard: () => boolean;
  /**
   * ★ 2026-09-24：peek 档的**关闭途径**（设计规范：「peek 仅留抓手 + 摘要 + 关闭途径」）。
   *   背景：推荐层禁用"下拉关闭"后，bar 上的 X 会被 peek 摘要层（z3）盖住
   *   ⇒ 在摘要层右上角提供独立关闭键；不传则不渲染。
   */
  onDismiss?: () => void;
  /** 非 peek 头部（OD + 动作键） */
  bar: ReactNode;
  /** peek 摘要内容（不含 grip） */
  peek: ReactNode;
  /** 各 pane（推荐列表 / 详情） */
  children: ReactNode;
  /**
   * ★ 本批（需求③ / AC-58）：**吸底操作条挂载点**（`.route-sheet__actions-slot`）。
   *   挂在 `.route-sheet` 根下 ⇒ 与面板**同一 `transform` 上下文** ⇒ 物理上不可能跑位。
   */
  actions?: ReactNode;
  /** ★ 本批（需求⑧ / AC-52）：观测钩子 H7 `data-pref`（当前偏好档） */
  pref?: string;
}

export default function BottomSheet({
  sectionRef,
  open,
  pane,
  detent,
  phase,
  live,
  dragging,
  translateY,
  layoutY,
  ariaLabel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPeekTap,
  peekTapGuard,
  onDismiss,
  bar,
  peek,
  children,
  actions = null,
  pref,
}: BottomSheetProps) {
  return (
    <section
      ref={sectionRef}
      className="route-sheet"
      /* ★ 观测钩子（契约唯一名称，已冻结）：data-sheet-state / data-detent /
         data-phase / data-live / data-dragging / data-open / data-pref（旧别名已全部移除） */
      data-sheet-state={pane}
      data-detent={detent}
      data-phase={phase}
      data-live={live}
      data-dragging={dragging ? "on" : "off"}
      data-open={open ? "on" : "off"}
      data-pref={pref}
      aria-hidden={!open}
      inert={!open ? true : undefined}
      aria-label={ariaLabel}
      style={
        {
          "--sheet-y-anim": `${Math.round(translateY)}px`,
          "--sheet-y-layout": `${Math.round(layoutY)}px`,
        } as CSSProperties
      }
    >
      {/* 非 peek 头部：grip + bar（起拖区；流内首元素 ⇒ panes 在其下） */}
      <div
        className="route-sheet__handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="route-sheet__grip" aria-hidden="true" />
        <div className="route-sheet__bar">{bar}</div>
      </div>

      <div className="route-sheet__panes">{children}</div>

      {/* ★ 本批：吸底操作条挂载点 —— 挂在面板根（`transform` 同上下文；AC-58） */}
      {actions && <div className="route-sheet__actions-slot">{actions}</div>}

      {/* peek 摘要：grip + OD + 指标（点整区回默认档；亦为起拖区；absolute 覆盖） */}
      <div
        className="route-sheet__peek"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={() => {
          if (peekTapGuard()) onPeekTap();
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onPeekTap();
          }
        }}
        aria-label="展开面板"
      >
        <span className="route-sheet__grip" aria-hidden="true" />
        {peek}
        {/* ★ 2026-09-24：peek 档独立关闭键（bar 的 X 被本摘要层遮挡；推荐层又已禁用下拉关闭） */}
        {onDismiss && (
          <button
            type="button"
            className="route-sheet__peek-close"
            aria-label="关闭面板"
            onClick={(e) => {
              e.stopPropagation(); // 不触发 peek 整区的「回默认档」
              onDismiss();
            }}
          >
            <Icon name="close" size={20} />
          </button>
        )}
      </div>
    </section>
  );
}
