"use client";

/**
 * 面板三档几何（src/components/nav/sheet-detents.ts，2026-09-23 新增）
 *
 * ── 三档（顶边 = 面板上缘 y，向下 = 收起）──────────────────────────────
 *   · `full`  = `clamp(max(safe-top + 44, 12vh), 96, 128)`（推荐默认 / 详情上拖）；
 *   · `half`  = `50vh`（详情默认「下半屏」）；
 *   · `peek`  = `80vh`（收起档，20% 可见）。
 *
 * ⚠️ 阈值/铺位一律**按运行时 px 现算**（不得把 90/71 之类当常量；换屏即变）。
 * ⚠️ `full` 与 CSS `--sheet-top-full` 同式（含 `env(safe-area-inset-top)`）——
 *    JS 侧经 `readSafeTopPx()` 探针读到真实安全区像素，保证面板顶边与地图取景槽一致。
 */
export type Detent = "full" | "half" | "peek";

/** 档位顺序：full(最上) → half → peek(最下) */
export const DETENTS: Detent[] = ["full", "half", "peek"];

/** 当前视口下各档顶边像素（**升序**，与 `DETENTS` 下标对齐） */
export function detentTopsPx(winH: number, safeTop = 0): number[] {
  const h = winH > 0 ? winH : 844;
  const full = Math.min(128, Math.max(96, Math.max(safeTop + 44, h * 0.12)));
  return [full, h * 0.5, h * 0.8];
}

/**
 * 读 `env(safe-area-inset-bottom)` 的真实像素（同 `readSafeTopPx` 的探针法）。
 * 通琴号站序弹窗的 peek 档顶边要用它（`--tqh-peek-h` 含底部安全区）。
 */
export function readSafeBottomPx(): number {
  if (typeof window === "undefined" || typeof document === "undefined") return 0;
  try {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;bottom:0;left:0;width:0;height:env(safe-area-inset-bottom,0px);pointer-events:none;visibility:hidden";
    document.body.appendChild(probe);
    const h = probe.getBoundingClientRect().height;
    probe.remove();
    return Number.isFinite(h) && h > 0 ? h : 0;
  } catch {
    return 0;
  }
}

/**
 * ★ 2026-11-05（通琴号站序弹窗）：三档顶边 —— **只覆盖 peek，full/half 沿用**。
 *
 * ```
 * full = clamp(max(safeTop+44, 12vh), 96, 128)   ← 与 `detentTopsPx` 同式
 * half = 50vh
 * peek = winH − (96 + safeBottom)                ← 可见 = 抓手带 24 + 行 44 + 呼吸 28 + 安全区
 * ```
 *
 * 为什么 peek 不能直接复用 `detentTopsPx` 的第三档（`80vh`）：
 *   导航 peek 要放「摘要 + 指标」（可见 20% ≈ 169px）；通琴号 peek **只放一行**
 *   （`[A1] 往横琴 · 08:30  [换向][刷新][叉]`），可见高必须按 96px 重算，否则会出现
 *   "单行面板拖出半屏空白"的破面。这是本迭代唯一需要覆写的几何值。
 */
export function tqhDetentTopsPx(winH: number, safeTop = 0, safeBottom = 0): number[] {
  const h = winH > 0 ? winH : 844;
  const [full, half] = detentTopsPx(h, safeTop);
  /** 96 = 抓手带 24 + 行 44 + 上下呼吸 28（与 `--tqh-peek-h` 的 96 同一口径） */
  return [full, half, Math.max(full + 120, h - (96 + safeBottom))];
}

/** `Detent` → 在 `DETENTS` / `detentTopsPx` 中的下标（越界夹取） */
export function detentIndex(d: Detent): number {
  const i = DETENTS.indexOf(d);
  return i < 0 ? 0 : i;
}

/**
 * 读 `env(safe-area-inset-top)` 的真实像素。
 * 做法：临时插一个 `height: env(safe-area-inset-top)` 的探针量一次（env 不能在 JS 直读；
 * `getComputedStyle` 对自定义属性不解析 `env()`）。失败 → 0（退化到无安全区，不阻塞）。
 */
export function readSafeTopPx(): number {
  if (typeof window === "undefined" || typeof document === "undefined") return 0;
  try {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);pointer-events:none;visibility:hidden";
    document.body.appendChild(probe);
    const h = probe.getBoundingClientRect().height;
    probe.remove();
    return Number.isFinite(h) && h > 0 ? h : 0;
  } catch {
    return 0;
  }
}
