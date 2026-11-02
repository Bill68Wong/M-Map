"use client";

/**
 * 回前台 / 网络恢复 ⇒ 立即补刷（src/components/nav/useResumeRefresh.ts，★ v3.7.0 S2 新增）
 *
 * ── 解决什么（架构 D1 / D6 / D9）──────────────────────────────────────
 *   导航中的 12s 轮询是裸 `setInterval`：切后台后被浏览器节流（隐藏 5min 后降到 1 次/分钟）
 *   或被 iOS 冻结 ⇒ 回到前台时**不会**立刻补一次，用户得盯着旧位置等下一个 tick。
 *   本 hook 把「什么时候该补刷」这件事收成一处，三个调用点（候车 / 乘车 / 线路查看）共用。
 *
 * ── 三个入口缺一不可 ──────────────────────────────────────────────────
 *   · `visibilitychange → visible`：Chrome / Android 切标签、锁屏回来；
 *   · `online`：断网恢复、Wi-Fi ↔ 移动数据切换；
 *   · `pageshow(persisted)`：iOS「加入主屏」独立窗口 + bfcache 还原（D9 明确指出只做
 *     `visibilitychange` 会漏掉这条路径）。
 *
 * ── 两条纪律 ──────────────────────────────────────────────────────────
 *   1. **2s 去抖**：回前台时三个事件可能同时到（`visibilitychange` + `pageshow` + `online`），
 *      连发会造成请求风暴（测试 AC2.5：同源 2s 窗口内 ≤1 次）⇒ 首次立刻触发，2s 内再来的丢弃；
 *   2. **只给"什么时候刷"，不管"刷什么"**：回调由调用方提供，冷却 / 作用域 / 是否轻轨
 *      全在调用方判断 —— 本 hook **不得**成为绕过 `useCooldown` 的后门。
 */
import { useEffect, useRef } from "react";

/** 回前台连发去抖窗口（ms）—— 与 AC2.1（≤2s 内发出）和 AC2.5（2s 内 ≤1 次）同时相容 */
export const RESUME_DEBOUNCE_MS = 2_000;

/**
 * @param onResume 需要补刷时调用（**不要在这里写冷却判断**，冷却属于调用方语义）
 * @param enabled  是否挂监听（默认 `true`；通常传「当前是否处于该阶段」）
 */
export function useResumeRefresh(onResume: () => void, enabled = true, debounceMs = RESUME_DEBOUNCE_MS): void {
  /** 回调镜像：监听器只注册一次，但每次都调最新闭包（避免依赖 onResume 反复解绑重绑） */
  const cbRef = useRef(onResume);
  cbRef.current = onResume;
  /** 上次触发时刻（跨 effect 重建保留 ⇒ 解绑重绑不会造成二次连发） */
  const firedAtRef = useRef(0);

  useEffect(() => {
    if (!enabled || typeof document === "undefined" || typeof window === "undefined") return;

    const fire = () => {
      // 后台里 `online` 也可能触发：隐藏时不刷（刷了也白刷，且会白占配额）
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - firedAtRef.current < debounceMs) return;
      firedAtRef.current = now;
      cbRef.current();
    };

    const onVis = () => {
      if (document.visibilityState === "visible") fire();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      // 只有「从缓存/独立窗口还原」才算恢复；首次加载的 pageshow 不重复刷
      if (e.persisted) fire();
    };

    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", fire);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", fire);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [enabled, debounceMs]);
}
