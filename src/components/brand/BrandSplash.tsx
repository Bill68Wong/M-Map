/**
 * 开屏覆盖层（src/components/brand/BrandSplash.tsx，v3.8.0 终版 · 05 规格 v1.2）
 *
 * ── 触发口径（负责人裁定 · 终版）──────────────────────────────────────────
 *   **每次都播**：任何整页加载（冷启动 / F5 刷新 / 深链 / 分享链接 / 重开标签）都播。
 *   版本门（cookie `mmap.splash.ver`）已废除——原始需求即「趁首页地图加载时用开屏优化体验」。
 *
 *   **客户端路由不播**——靠挂载在根 `layout.tsx`（客户端导航不重挂）实现，
 *   **不使用任何已播标记**。bfcache 还原（`pageshow.persisted === true`）只移除容器、不重播。
 *
 *   ⛔ 不要把挂载点挪回 `page.tsx`：会导致深链进 `/help`、`/line/**` 等内页完全不播
 *      （那是「进入应用」，负责人要求每次都播）；届时必须加已播标记来压制客户端路由，
 *      而标记在 React StrictMode 双挂载下会造成覆盖层永不移除（dev 下整站不可点击）。
 *
 * ── 结构（SSR 直出 ⇒ 动画从首帧开始、零 hydration 依赖）──────────────────
 *   根 `layout.tsx` 无条件渲染本组件；CSS 动画在首帧绘制时即开始，逐帧完全由 CSS 驱动。
 *   客户端 JS 只做三件事：reduced-motion 判定、播完/跳过后移除容器、
 *   `data-splash-state` 四态钩子（机验靠它）。
 *
 * ── 红线（规格 §3 / §10，实现缺陷级）───────────────────────────────────
 *   · 交接顺序恒定：内容就绪（SSR 已渲染）→ 覆盖层淡出（CSS 段 8）→ 移除容器。
 *     「动画层先移除、内容后出现」= 缺陷（unpleasant flash）。
 *   · 每条 animation 显式 `fill-mode: both`：全局杀开关（globals.css :541，0.01ms
 *     瞬播完）下省略 fill-mode ⇒ 跳回初始帧 ⇒ 空 M（静默缺陷）。
 *   · 覆盖层 z-index 200 > 车辆层 130（项目显式数字层级纪律）。
 *   · 移除 = 从 DOM 移除容器（React 卸载），**禁止** opacity:0 / pointer-events:none /
 *     visibility:hidden 三种假移除（跳过断言的「双条件」依赖真移除）。
 *   · mask id 用 `useId()`（首页同时存在 BrandMark 的 mask，固定 id 会撞）。
 *   · 光点 cx/cy 缺省 (0,0)：offset-path 把锚点（SVG 缺省 transform-origin = 0 0）
 *     钉到路径点；段 4 的 scale(0.35) 围绕局部原点收缩 ⇒ 原地缩小。**勿写 cx/cy。**
 *   · 光点在 mask 组**之外**（规格 v1.1 §2：全程可见压过镂空孔；少一个跨实例同步点）。
 */
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { APP_VERSION } from "@/lib/splash/version";

/** `data-splash-state` 四态（互斥优先级 skipped > done > reduced > playing） */
type SplashState = "playing" | "skipped" | "done" | "reduced";

/**
 * 无 prop：本组件在根 `layout.tsx` 中，每次整页加载挂载一次、播一次。
 * 「客户端路由不播」由根布局不重挂保证（结构性），**不使用任何已播标记**。
 */
export default function BrandSplash() {
  const maskId = `mm-splash-hole-${useId().replace(/:/g, "")}`;
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [gone, setGone] = useState(false);
  /** 终态记账：一旦进入 done/skipped/reduced 不再改写（互斥；skipped 恒可覆盖 done） */
  const stateRef = useRef<SplashState | null>(null);

  useEffect(() => {
    // 只读钩子：构建期注入的版本单字符串（验收脚本用它对照/记录，**不参与门判定**）
    document.body.dataset.appVersion = APP_VERSION;

    // reduced-motion 是用户偏好（matchMedia 判定，CSS 设不了 data 属性）：
    // 自然播完记 `reduced`（不是 done）；跳过一律记 `skipped`
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    stateRef.current = reduced ? "reduced" : "playing";
    document.body.dataset.splashState = stateRef.current;

    const overlay = overlayRef.current;
    if (!overlay) return;

    let removed = false;
    const removeNow = () => {
      if (removed) return;
      removed = true;
      setGone(true); // React 卸载容器 ⇒ [data-splash-root] 从 DOM 消失（真移除，非假移除）
    };
    /**
     * done 只覆盖 playing —— reduced 播完**保持 reduced**（S10 互斥优先级：
     * 「reduced-motion 下播完记 reduced」；若被改写成 done，S6 断言必挂）。
     * skipped 不在此处理（skip 有自己的赋值路径，恒可覆盖）。
     */
    const markDone = () => {
      if (stateRef.current === "playing") {
        stateRef.current = "done";
        document.body.dataset.splashState = "done";
      }
    };

    // 段 8 淡出结束（960ms）⇒ 移除容器。done 在此记（比规格 §7.2 的「淡出启动」晚约 100ms；
    // S1/S6 只断终态值，无 done 时机断言，差值可接受 —— JS 无法可靠对齐 CSS 动画的启动时刻）。
    // 同时接住 skip 动画的 animationend：skip 路径的移除必须挂在动画结束上（S5 断 click→移除
    // ≤120ms，140ms 定时器兜底永远过不了这条断言）。
    const onExitEnd = (e: AnimationEvent) => {
      if (e.animationName !== "brand-splash-exit" && e.animationName !== "brand-splash-skip") return;
      if (e.animationName === "brand-splash-exit") markDone();
      removeNow();
    };
    overlay.addEventListener("animationend", onExitEnd);

    // 迟挂载兜底：JS 挂载时退出动画已播完（computed opacity === "0"，fill-mode both 钉住末帧）
    // ⇒ animationend 已错过、不会再触发 ⇒ 立即移除（「动画先完成 ⇒ 停在末帧静置等待」的收尾）。
    if (getComputedStyle(overlay).opacity === "0") {
      markDone();
      removeNow();
    }

    // 兜底计时器：动画时间轴上限 960ms + 余量。animationend 若因任何原因丢失也保证移除
    //（S5 的「首屏立即可用」不能依赖单一事件）。
    const backstop = window.setTimeout(() => {
      markDone();
      removeNow();
    }, 2500);

    // 跳过：点击任意处（含覆盖层内）⇒ skipped（优先级最高，可覆盖 done）⇒ 淡出并移除。
    // 淡出必须走【内联 animation】替换段 8 的延迟动画：CSS 动画的 fill 值 sits above inline
    // style，用 transition/inline opacity 会被段 8 的 backwards fill 压住（点不动）。
    // 时长取 100ms（PM S5 断言 click→移除 ≤120ms：120ms 动画 + 事件/观测延迟必然超限，
    // 100ms 留出测量余量，仍满足「≤120ms 淡出并移除」）；移除挂 animationend，120ms 兜底。
    const skip = () => {
      if (removed) return;
      stateRef.current = "skipped";
      document.body.dataset.splashState = "skipped";
      overlay.style.animation = "brand-splash-skip 100ms ease-out both"; // 内联覆盖类动画
      window.setTimeout(removeNow, 120); // animationend（100ms）命中时 removeNow 幂等；仅兜底
    };
    overlay.addEventListener("click", skip);
    // 键盘同权（规格未禁止；开屏无必须信息，Esc/Enter/Space 皆可跳过）
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") skip();
    };
    overlay.addEventListener("keydown", onKey);

    /**
     * bfcache 还原（浏览器前进/后退）：DOM 是快照，CSS 动画可能从中途续播或已失效，
     * 重播会与已有内容打架 ⇒ 只移除容器，**不重播、不改状态**。
     * `pageshow` 在首次加载也会触发，但那时 `persisted === false` ⇒ 被下面的判断过滤掉。
     */
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      removeNow();
    };
    window.addEventListener("pageshow", onPageShow);

    return () => {
      overlay.removeEventListener("animationend", onExitEnd);
      overlay.removeEventListener("click", skip);
      overlay.removeEventListener("keydown", onKey);
      window.removeEventListener("pageshow", onPageShow);
      window.clearTimeout(backstop);
    };
  }, []);

  // 本会话已播过 / 播放结束 ⇒ 渲染 null（容器不在 DOM 中）
  if (gone) return null;

  return (
    <div
      ref={overlayRef}
      className="brand-splash__overlay"
      data-splash-root=""
      aria-hidden="true" /* 覆盖层内无内容；让 AT 直接穿透到下方真实内容 */
    >
      <svg
        className="brand-splash__mark brand-anim--narrative"
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
        <g mask={`url(#${maskId})`}>
          {/* 段 2：M 描边生长（pathLength="1" 归一化；dasharray/offset 全在 CSS）。
              仅 <path> 可用 pathLength —— 站环 <circle> 禁用（WebKit bug 区）。 */}
          <path
            className="brand-mark__route"
            d="M12 48 L12 16 L30 34 L48 16"
            pathLength={1}
            fill="none"
            strokeWidth="6.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* 段 6：钉弹跳（显式 scale 关键帧；transform-origin = 钉尖，见 CSS） */}
          <path className="brand-mark__pin" d="M40.29 18.13 L48 46 L55.71 18.13 A8 8 0 1 0 40.29 18.13 Z" />
        </g>
        {/* 段 0：站环首帧常驻（v1.1 删充能段的原因——避免站环「闪没又出现」） */}
        <circle className="brand-mark__station" cx="12" cy="48" r="4.6" fill="none" strokeWidth="2.2" />
        <circle className="brand-mark__station" cx="30" cy="34" r="4.6" fill="none" strokeWidth="2.2" />
        {/* 段 2'/4：光点 —— cx/cy 缺省 (0,0)（锚点即圆心，勿写）；mask 组之外、路线之上 */}
        <circle className="brand-anim__dot" r="2.6" />
        {/* 段 5：钉帽孔内点亮（深底钉绿 2.97:1 的时序补偿） */}
        <circle className="brand-anim__hole-flash" cx="48" cy="16" r="2.7" />
        {/* 段 7：涟漪（仅 scale+opacity；禁 blur） */}
        <circle className="brand-anim__ripple" cx="48" cy="46" r="11" strokeWidth="2" />
      </svg>
    </div>
  );
}
