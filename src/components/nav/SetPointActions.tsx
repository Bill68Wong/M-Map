"use client";

/**
 * 统一设点组件（M4 · 需求 4 的核心）—— 「设为起点 / 设为目的地」的唯一实现。
 *
 * ── 为什么要抽成一个组件 ────────────────────────────────────────────────
 *   巴士站卡（`StationCard`）、通琴号卡、跨境地标卡（`XborderCard`）、公厕卡
 *   （`PublicToiletCard`）四处都要这两个按钮。若每个调用点自己写一遍
 *   `{!navActive && (<div className="nav-station-card__acts">…)}`，
 *   **下一个新增的弹窗必然漏判**（漏了就在导航态给用户一个「设为起点」——
 *   点下去会把他正在导航的行程改掉）。
 *   ⇒ 可见性判定**只写在组件内部**，调用点只管传 `navActive`。
 *
 * ── 行为与巴士站弹窗**完全一致** ─────────────────────────────────────────
 *   本组件不自己算坐标、不自己写 stage：只是把宿主的两个回调接上来。
 *   宿主传的就是它原本给 `StationCard` 的 `onSetFrom` / `onSetTo`，
 *   保证「设点」在四个弹窗里是同一条代码路径。
 */
import type { ReactNode } from "react";

export interface SetPointActionsProps {
  /** 是否处于导航语境（首页地图以外）。true ⇒ **整块不渲染**（不是 `display:none`） */
  navActive?: boolean;
  onSetFrom: () => void;
  onSetTo: () => void;
  /** 观测钩子用（默认 `data-set-points="on"`；无需传） */
  extra?: ReactNode;
}

export default function SetPointActions({ navActive = false, onSetFrom, onSetTo, extra }: SetPointActionsProps) {
  /* ★ 唯一判定点：导航态 DOM 移除（`display:none` 会让屏幕阅读器仍可聚焦） */
  if (navActive) return null;
  return (
    <div className="nav-station-card__acts" data-set-points="on">
      <button className="btn btn--outline btn--sm" type="button" onClick={onSetFrom}>
        设为起点
      </button>
      <button className="btn btn--primary btn--sm" type="button" onClick={onSetTo}>
        设为目的地
      </button>
      {extra}
    </div>
  );
}
