"use client";

/**
 * 地图取景 / 读值纯函数（src/components/nav/nav-map-fit.ts，2026-09-25 从 NavMap 拆出 · 07 §5.3）
 *
 * 只放**无副作用**的取景计算与运行时读值：
 *   · `readToken`   —— 运行时读 CSS Token 的 resolved 具体值（AMap 画布拿不到 `var()`）；
 *   · `maskFill`    —— 域外遮罩填充色（读 `--fg`）；
 *   · `zoomForAcross` —— 「一屏宽的横向米数」→ zoom（标准 Web Mercator）；
 *   · `fitGapPx` / `panelTopPx` —— 取景呼吸边距 / 面板顶边像素探针。
 *
 * ⚠️ 拆分**零行为变更**：原实现逐字搬移，仅导出名不变。
 */

/** 一屏宽横向显示的默认米数（定位成功后使用） */
export const TARGET_METERS_ACROSS = 2500;
/** ★ S1：缩放收敛区间（minZoom=11：一屏≈27.6km，远小于遮罩外圈±1.6°≈178km ⇒ 永不露边） */
export const MIN_ZOOM = 11;
export const MAX_ZOOM = 18;
/**
 * 域外遮罩不透明度
 * ★ 2026-10-31：0.42 → 0.25。本应用只服务澳门，域外只需**压暗**区分主次，
 *   0.42 时珠海/横琴与澳门对比过强（实测截图：域外近深蓝灰、澳门全亮）⇒ 降到中等暗度。
 */
export const MASK_OPACITY = 0.25;

/**
 * 运行时读一个 CSS Token 的 **resolved 具体值**。
 * 防呆：值里若仍含 `(`（= `color-mix(...)` / `var(...)` 未被解析）⇒ 视为读不到 ⇒ 返回 null。
 */
export function readToken(name: string): string | null {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!v || v.includes("(")) return null;
    return v;
  } catch {
    return null;
  }
}

/** 遮罩填充色（读 `--fg`）；读不到 ⇒ null（调用方跳过遮罩） */
export function maskFill(): string | null {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--fg").trim();
    return v || null;
  } catch {
    return null;
  }
}

/** 让「一屏宽」横向放下 `TARGET_METERS_ACROSS` 米的 zoom（按纬度与容器像素宽实时算） */
export function zoomForAcross(lat: number, widthPx: number): number {
  const w = widthPx > 0 ? widthPx : 390;
  const mpp = TARGET_METERS_ACROSS / w;
  const z = Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / mpp);
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z * 100) / 100));
}

/** 读「半屏可出发」面板（`.rpanel`）的真实顶边像素（取景用）；异常 ⇒ null */
export function panelTopPx(fallbackH: number): number | null {
  try {
    const el = document.querySelector<HTMLElement>(".rpanel");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r || r.height <= 0) return null;
    const top = Math.round(r.top);
    if (top < 80 || top > fallbackH - 40) return null;
    return top;
  } catch {
    return null;
  }
}

/** 读设计 Token `--map-fit-gap`（px）——取景呼吸边距；回落 20 */
export function fitGapPx(): number {
  const v = readToken("--map-fit-gap");
  const n = v ? Number.parseFloat(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 && n < 200 ? n : 20;
}
