"use client";

/**
 * 回前台 / 网络恢复 ⇒ 立即补刷（src/components/nav/useResumeRefresh.ts，★ v3.7.0 S2 新增）
 *
 * ── 解决什么（架构 D1 / D6 / D9）──────────────────────────────────────
 *   导航中的 12s 轮询是 `setTimeout` 链：切后台后被浏览器节流、或被整页冻结（freeze）
 *   ⇒ 回到前台时**不会**立刻补一次，用户得盯着旧位置等下一个 tick。
 *   本 hook 把「什么时候该补刷」这件事收成一处，三个调用点（候车 / 乘车 / 线路查看）共用。
 *
 * ── ★ 需求5（2026-11-03）：为什么从三个入口扩到五个 ────────────────────
 *   决定性外部证据：`phoenixframework/phoenix` #6804 是一份**安卓已安装 PWA（WebAPK）+
 *   Android 15 + Chrome 151** 的设备端 trace，与我们症状同构，三条硬结论：
 *     · 熄屏约 **60 秒**就 `freeze`（`hiddenFor=60`；5 分钟是**定时器节流**档位，不是 freeze）；
 *     · 解冻时 **`resume` 到了**，但 `visibilitychange` / `pageshow` / `pagehide` **一个都没发**；
 *     · `visibilitychange` 迟到 **14 秒**才补发（且疑似要等后续交互）。
 *   ⇒ 只挂 `visibilitychange`/`pageshow`/`online` 的旧矩阵，在这台机型上**等于零个入口**。
 *   故新增两个入口：`document['resume']`（Page Lifecycle API）与 `window['focus']`。
 *
 * ── 五个入口 ──────────────────────────────────────────────────────────
 *   · `visibilitychange → visible`：Chrome / Android 切标签、锁屏回来（**会迟到，不能只靠它**）；
 *   · `resume`：Page Lifecycle 解冻信号 —— WebAPK 上**唯一确定会到**的那个（见上）；
 *   · `focus`：窗口重新获得焦点（安卓 WebAPK 上是否发**未验证**，成本近零故挂上）；
 *   · `online`：断网恢复、Wi-Fi ↔ 移动数据切换；
 *   · `pageshow`：iOS「加入主屏」独立窗口 + bfcache 还原（D9 指出只做 `visibilitychange` 会漏）。
 *
 * ── 三条纪律（★ 需求5 修订了第 1、3 条）───────────────────────────────
 *   1. **`visibilityState === "hidden"` 守卫只对 `online` 生效**（旧版对**所有**来源生效）。
 *      为什么必须按来源放开：某些机型 `resume` 触发时 `visibilityState` **还没翻到 visible**
 *      （trace 里 `resume` 与 `visibilitychange` 相差 14s）—— 旧守卫会把 `resume` 当场吞掉，
 *      「加了监听也不生效」这类最难查的空转就是这么来的。`online` 保留该守卫的理由没变：
 *      后台里的网络恢复刷了也白刷，还白占配额。
 *   2. **2s 去抖**（`RESUME_DEBOUNCE_MS`）：恢复事件常成群到达（`resume` + `visibilitychange`
 *      + `pageshow` 相隔几十毫秒）⇒ 首个立刻触发，2s 内再来的一律丢弃（AC2.1 / AC2.5）。
 *   3. **`pageshow` 去掉 `e.persisted` 限制**，改用「页面加载后首 5s 内忽略」护栏。
 *      为什么：安卓熄屏场景 `persisted` **恒为 false**（上一轮实测），旧写法等于关闭该入口；
 *      而去掉后首个 `pageshow`（首次加载时浏览器必发一次）会白刷一帧 ⇒ 用加载窗口挡掉它。
 *   4. **只给"什么时候刷"，不管"刷什么"**：回调由调用方提供，冷却 / 作用域 / 是否轻轨
 *      全在调用方判断 —— 本 hook **不得**成为绕过 `useCooldown` 的后门。
 */
import { useEffect, useRef } from "react";

/** 回前台连发去抖窗口（ms）—— 与 AC2.1（≤2s 内发出）和 AC2.5（2s 内 ≤1 次）同时相容 */
export const RESUME_DEBOUNCE_MS = 2_000;

/**
 * `pageshow` 的「首次加载」忽略窗口（ms）—— 去 `persisted` 限制后的必要护栏。
 * 取值理由：首次加载的 `pageshow` 在 `load` 后立刻发（远小于 1s）；而真实的
 * 熄屏恢复 / bfcache 还原发生在用户离开至少十几秒之后。5s 是这两者之间的宽裕分界。
 */
export const PAGESHOW_GRACE_MS = 5_000;

/** 恢复事件来源 —— `fire()` 按来源决定要不要过「当前是否可见」这道门 */
export type ResumeSource = "visibilitychange" | "resume" | "focus" | "online" | "pageshow";

/**
 * 本模块（≈ 页面）加载时刻 —— `pageshow` 护栏的基准。
 *
 * 为什么用模块级而不是 `useRef`：`pageshow` 的护栏语义是「**页面**加载后首 5s」，
 * 而 hook 可能晚挂载（`enabled` 从 false 翻 true）、也可能因依赖变化重挂 ——
 * 若每次挂载都重置基准，从其它页面切进来后的首个 `pageshow` 会被误当成"首次加载"而丢掉。
 */
const PAGE_LOADED_AT = Date.now();

/**
 * @param onResume 需要补刷时调用（**不要在这里写冷却判断**，冷却属于调用方语义）
 * @param enabled  是否挂监听（默认 `true`；通常传「当前是否处于该阶段」）
 * @param debounceMs 去抖窗口（缺省 `RESUME_DEBOUNCE_MS`；调用方一般不用改）
 */
export function useResumeRefresh(onResume: () => void, enabled = true, debounceMs = RESUME_DEBOUNCE_MS): void {
  /** 回调镜像：监听器只注册一次，但每次都调最新闭包（避免依赖 onResume 反复解绑重绑） */
  const cbRef = useRef(onResume);
  cbRef.current = onResume;
  /** 上次触发时刻（跨 effect 重建保留 ⇒ 解绑重绑不会造成二次连发） */
  const firedAtRef = useRef(0);

  useEffect(() => {
    if (!enabled || typeof document === "undefined" || typeof window === "undefined") return;

    /**
     * 唯一的放行口。
     * @param source 事件来源 —— **只有 `online` 看 `visibilityState`**（见文件头纪律 1）。
     */
    const fire = (source: ResumeSource) => {
      // 后台里 `online` 也会触发：隐藏时不刷（刷了也白刷，且会白占配额）。
      // ⚠️ 其余来源**不得**加这道门：`resume` 可能先于 `visibilityState` 翻面（trace 中相差 14s）。
      if (source === "online" && document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - firedAtRef.current < debounceMs) return;
      firedAtRef.current = now;
      cbRef.current();
    };

    const onVis = () => {
      if (document.visibilityState === "visible") fire("visibilitychange");
    };
    /** Page Lifecycle API：解冻信号。非 Chromium 系浏览器不会发（不影响其它入口） */
    const onResumeEvent = () => fire("resume");
    const onFocus = () => fire("focus");
    const onOnline = () => fire("online");
    const onPageShow = () => {
      // 去掉 `e.persisted` 限制（安卓熄屏场景恒 false），改挡「页面加载后首 5s」
      if (Date.now() - PAGE_LOADED_AT < PAGESHOW_GRACE_MS) return;
      fire("pageshow");
    };

    /**
     * `resume` 只在 `document` 上派发（Page Lifecycle 规范）。
     * ⚠️ TS 的 `DocumentEventMap` **未收录** `freeze`/`resume` ⇒ 直接写字符串名会过不了 tsc。
     *    不写 `@ts-expect-error`（那是"等着它报错"的写法），改用 `EventTarget` 视图：
     *    运行期就是同一个对象、同一个 `addEventListener`，只是绕开窄化的字面量重载。
     */
    const docLifecycle = document as unknown as EventTarget;

    document.addEventListener("visibilitychange", onVis);
    docLifecycle.addEventListener("resume", onResumeEvent);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      docLifecycle.removeEventListener("resume", onResumeEvent);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [enabled, debounceMs]);
}
