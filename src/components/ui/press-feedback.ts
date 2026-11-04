"use client";

/**
 * ★ U11（2026-11-04）：全站**统一按压反馈控制器**（唯一写入口）。
 *
 * ── 为什么需要它（根因）──────────────────────────────────────────────────
 *   原按压基元绑在**元素类型**上（`button, .btn, .btn--undo`），
 *   而非 button 的可点元素（`<a>` / `<div role=button>` / `<summary>`）整类漏掉
 *   ⇒ `.link-hit`、`.rc-report__link`、`.nav-brand`、`.route-sheet__peek`、
 *     `.help-faq__q` 这 5 处点了毫无反馈。
 *   修法不是"再往选择器后面追加类名"，而是把**状态端与样式端解耦**：
 *   本文件只负责把 `data-pressed="true"` 写/删到"当前被按住的元素"上，
 *   它**不关心**那是 `<a>` 还是 `<summary>`；CSS 侧只认属性。
 *
 * ── 可观测契约（QA 可断言）─────────────────────────────────────────────
 *   · 按下 → `data-pressed="true"`；
 *   · 松开 / 取消 / 滚动 / 位移超限 → **removeAttribute**（绝不写 "false"）。
 *
 * ── 不阻塞主线程 ────────────────────────────────────────────────────────
 *   普通元素在 `pointerdown` 当帧同步写属性（实测 <1ms，远低于 16ms 预算）；
 *   只有**拖拽摘要面**（`.route-sheet__peek`）走 16ms 消歧窗口 ——
 *   因为它的 `:active` 会在整个拖拽期常亮（轻点典型持续 60–90ms，
 *   若用 80ms 窗口则大部分正常点击都没有反馈，故选 16ms）。
 *
 * ── 回滚 ────────────────────────────────────────────────────────────────
 *   删本文件 + 删 `layout.tsx` 里那一行 import，全站即回到纯 `:active` 时代。
 */
import { useEffect } from "react";

/** 可点元素的**白名单**（属性只写到这些元素上；CSS 端才敢用裸属性选择器） */
const PRESSABLE = [
  "button",
  "a[href]",
  "summary",
  "[role='button']",
  ".btn",
  ".btn--undo",
  ".btn--icon",
  ".chip",
  ".press-card",
  ".rc",
  ".rv-card",
  ".ssheet__item",
  ".rpanel__row",
  ".rl-chip",
  ".fav-flat__main",
  ".line-result",
  ".link-hit",
  ".rc-report__link",
  ".nav-brand",
  ".help-faq__q",
  ".route-sheet__peek",
  ".pref-switch__opt",
  ".lrt-switch",
  "[data-press]",
].join(",");

/**
 * 走 16ms 消歧窗口的元素（T9 拖拽摘要面）。
 * ⚠️ 不能用 80ms：轻点持续 60–90ms，80ms 窗口会让大部分正常点击**没有反馈**。
 */
const DEFERRED = ".route-sheet__peek";

/**
 * 地图容器内**一律不写属性**（T8）。
 * 高德自己监听 touch 做平移/缩放，且站点 pin 是容器内的 DOM（`data-code` 元素），
 * 拖动地图时 pointerdown 必然先落在 pin 或容器上 ⇒ 若在此写属性，
 * 每次拖动都会闪一下 press 态。故整棵容器排除，宁可地图 pin 无按压反馈。
 */
const MAP_SURFACE = ".amap-container, [data-map-surface]";

const ATTR = "data-pressed";
const DISAMBIG_MS = 16;
/** 位移超过此值即判为拖拽，撤销 press 态 */
const CANCEL_PX = 6;

type Pt = { x: number; y: number };

function isDisabled(el: Element): boolean {
  if (el instanceof HTMLButtonElement && el.disabled) return true;
  return el.getAttribute("aria-disabled") === "true";
}

/** 命中"可点元素"，且不在禁用态 / 地图容器内 */
function resolveTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  if (node.closest(MAP_SURFACE)) return null;
  const el = node.closest(PRESSABLE);
  if (!(el instanceof HTMLElement)) return null;
  if (isDisabled(el)) return null;
  return el;
}

function clear(el: HTMLElement | null) {
  if (el) el.removeAttribute(ATTR);
}

export default function PressFeedback() {
  useEffect(() => {
    /** 当前按住的那个元素（同一时刻只允许一个） */
    let held: HTMLElement | null = null;
    let origin: Pt = { x: 0, y: 0 };
    let pointerId: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const release = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      clear(held);
      held = null;
      pointerId = null;
      cancelled = false;
    };

    /** 触点在元素内的百分比 + 涟漪直径（真实触点，不是中心） */
    const writeRipple = (el: HTMLElement, x: number, y: number) => {
      const r = el.getBoundingClientRect();
      const w = r.width || 1;
      const h = r.height || 1;
      const px = Math.min(100, Math.max(0, ((x - r.left) / w) * 100));
      const py = Math.min(100, Math.max(0, ((y - r.top) / h) * 100));
      el.style.setProperty("--press-x", `${px.toFixed(2)}%`);
      el.style.setProperty("--press-y", `${py.toFixed(2)}%`);
      // 直径取对角线 ×2：保证半径在动画结束时必然盖满整块
      el.style.setProperty("--press-d", `${Math.hypot(w, h) * 2}px`);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const el = resolveTarget(e.target);
      if (!el) return;
      if (held) release();
      held = el;
      pointerId = e.pointerId;
      origin = { x: e.clientX, y: e.clientY };
      cancelled = false;
      writeRipple(el, e.clientX, e.clientY);

      if (el.matches(DEFERRED)) {
        // T9：先等一个 16ms 消歧窗口，仍在原位才认定是"轻点"
        timer = setTimeout(() => {
          timer = null;
          if (!cancelled && held === el) el.setAttribute(ATTR, "true");
        }, DISAMBIG_MS);
      } else {
        el.setAttribute(ATTR, "true");
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!held || e.pointerId !== pointerId) return;
      if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > CANCEL_PX) {
        cancelled = true;
        release();
      }
    };

    /** 滚动中一律撤（长列表滑动时不该留下高亮） */
    const onScroll = () => {
      if (held) {
        cancelled = true;
        release();
      }
    };

    /** 键盘：Enter / Space 按下即等价于按下态（无触点 ⇒ 涟漪回落 50%） */
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
      const el = resolveTarget(e.target);
      if (!el) return;
      if (held && held !== el) release();
      held = el;
      pointerId = null;
      // 键盘无触点 ⇒ 涟漪从元素中心起（唯一允许回落 50% 的场合）
      const r = el.getBoundingClientRect();
      el.style.setProperty("--press-x", "50%");
      el.style.setProperty("--press-y", "50%");
      el.style.setProperty(
        "--press-d",
        `${Math.hypot(r.width || 1, r.height || 1) * 2}px`,
      );
      el.setAttribute(ATTR, "true");
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
      if (held && pointerId === null) release();
    };

    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerup", release, { passive: true });
    document.addEventListener("pointercancel", release, { passive: true });
    // capture=true：任何滚动容器（含 .route-sheet / 列表）滚起来都要撤
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);

    return () => {
      release();
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", release);
      document.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
    };
  }, []);

  return null;
}
