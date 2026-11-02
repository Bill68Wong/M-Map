"use client";

/**
 * 冷却（倒计时）唯一源（src/components/nav/useCooldown.ts，★ v3.6.0 S4 新增）
 *
 * ── 为什么要有这个 hook ───────────────────────────────────────────────
 *   v3.5.x 的「冷却」其实是**请求状态**：`disabled={traveling}` / `phase === "loading"`。
 *   于是「冷却多久」=「一次 HTTP 往返多久」（≈1 秒）⇒ 用户看到的就是
 *   「点一下能刷、停了立刻又能刷」，俗称**一秒冷却一次**，起不到防连点作用。
 *   ⇒ 冷却必须是**时间戳**概念：点下去就记一个 `until`，与请求是否完成无关。
 *
 * ── 纪律（这几条是"假冷却"复发的唯一防线）──────────────────────────────
 *   · 计时器挂在 hook 层（`useEffect([])` + `useRef` 时间戳）——
 *     宿主组件重渲染**不会**重建 timer，也不会重置倒计时；
 *   · 禁止在渲染期读写 `Date.now()`（渲染必须纯）；读取只在 timer 回调里；
 *   · 值未变不 `setState`（250ms 轮询、1s 显示粒度，避免卡秒又不空转重渲染）；
 *   · **作用域局部**：每个调用点各自一份冷却 —— 车辆刷新冷却不得牵连定位刷新 /
 *     步行进度推进 / 步行路径重算（各自有各自的成本，混用会误伤）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** 冷却口径（秒）—— 唯一来源，勿在各调用点各写一个数字 */
export const COOLDOWN_VEHICLE_SEC = 5;
/** 推荐列表刷新：每次 ≈1 次高德 transit + 9~13 个 DSAT 桶，成本最高 */
export const COOLDOWN_RECOMMEND_SEC = 5;
/** 步行路径重算（偏航/手动）：单次成本低，但高德 walking 有 3 QPS 硬上限（S5 接入用） */
export const COOLDOWN_WALK_SEC = 3;

export interface UseCooldown {
  /** 剩余秒数（0 = 可刷新） */
  sec: number;
  /** 是否仍在冷却中（等价 `sec > 0`，便于 JSX 里少写比较） */
  cooling: boolean;
  /** 开始一轮冷却（点下刷新的那一刻调用，**与请求是否完成无关**） */
  start: () => void;
  /**
   * 立即结束冷却（不等倒计时走完）。
   * 用途：**语境切换**清场 —— 例如进入/退出某条线路，上一轮的冷却不该带到新语境里。
   * 注意：这是"换语境"，不是"绕过防连点"；防连点请勿调它。
   */
  reset: () => void;
  /**
   * ★ v3.7.0 S2：**实时**读取剩余秒数（`untilRef` + `Date.now()`，不读 `sec` state）。
   *
   * 为什么需要它：`sec` 由 250ms 计时器写 state，而**页面隐藏时计时器被节流/冻结** ⇒
   * 回到前台的那一刻 `sec` 还停在后台前的旧值（例如 4），据此判断会「以为还在冷却」
   * 而**静默不刷**（正是 D1「回前台不刷新」的复发路径）。事件回调里读时间戳才准。
   *
   * 只能用于"事件到达瞬间"的判断；渲染期请继续用 `sec`（渲染必须纯）。
   */
  remainingSec: () => number;
}

/**
 * @param totalSec 冷却总时长（秒）。取上面 `COOLDOWN_*` 常量，不要写裸数字。
 */
export function useCooldown(totalSec: number): UseCooldown {
  /** 冷却截止时刻（ms，0 = 未开始）。**唯一真相**，永远不因重渲染重置 */
  const untilRef = useRef(0);
  const [sec, setSec] = useState(0);

  useEffect(() => {
    // ★ 250ms 轮询：显示粒度 1s，但不会「卡秒」；值未变不 setState
    const t = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((untilRef.current - Date.now()) / 1000));
      setSec((s) => (s === left ? s : left));
    }, 250);
    return () => window.clearInterval(t);
  }, []);

  const start = useCallback(() => {
    untilRef.current = Date.now() + totalSec * 1000;
    setSec(totalSec);
  }, [totalSec]);

  const reset = useCallback(() => {
    untilRef.current = 0;
    setSec(0);
  }, []);

  const remainingSec = useCallback(
    () => Math.max(0, Math.ceil((untilRef.current - Date.now()) / 1000)),
    [],
  );

  return { sec, cooling: sec > 0, start, reset, remainingSec };
}
