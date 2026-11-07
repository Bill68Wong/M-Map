/**
 * 线路名展示统一口径（src/lib/route-label.ts，v0.19.1）
 * ⚠️ 纯展示层，禁止 import 任何含 pg/db 的模块（client 组件会直接 import）。
 *
 * ★ 2026-11-06（M23 / 死代码门禁）：原 `kindIcon()` 已删除 —— 它是「图标未收敛」时代的
 *   残留（早期返回轻轨/巴士两个 **emoji** 表情符，后改成 `"lrt" | "bus"`），全仓**零调用方**。
 *   图标请一律走 `<Icon name="bus" | "lrt" />`（`src/components/ui/Icon.tsx`），
 *   **不要**在这里重新造「码 → 图标名」的映射，那会变成图标系统的第二份真相。
 */

/** 轻轨码判定 */
export const isLrtCode = (code?: string | null): boolean => !!code && code.startsWith("LRT-");

/**
 * 线路标签文字（谷歌地图风格，简洁）：
 *   巴士 → '26' / '25B'（不带「路」字）；轻轨 → '氹仔線'（不带「輕軌·」前缀）
 */
export function lineNameOf(code: string): string {
  if (!code) return "";
  if (isLrtCode(code))
    return code
      .replace(/^LRT-/, "")
      .replace(/湾/g, "灣")
      .replace(/横/g, "橫")
      .replace(/线/g, "線");
  return code;
}

/**
 * 多线路展示顺序：轻轨在前 + 巴士自然排序（25 → 25AX → 25B → 25BS → 26 → 50 → 51 → 102 → 701X → N6）
 *
 * ★ 2026-11-06（旧推荐链下线）：本函数原在 `src/lib/timer-flow.ts`（计时流程状态机）。
 *   计时链（`/api/timer`、`/timer`、`TimerWizard`）整体退役后，那张状态机只剩本函数
 *   仍有消费方（`RouteStack` / `StationReachFold` 经本文件引用）⇒ 迁到本文件，
 *   `timer-flow.ts` 随之删除。**行为逐字未改**，别在迁移中顺手"优化"排序口径。
 *
 * ① 轻轨（`LRT-*`）统一排在巴士之上，轻轨之间保持方案原相对顺序；
 * ② 巴士按「自然排序」：开头数字升序 → 同数字按字母后缀升序 → 纯字母开头（N6 等）排最后。
 *
 * ⚠️ 只用于「展示排序」，不改变 `route_options` 数组本身 ——
 *    `route_options[0]` 语义 = 方案默认线路（历史样本口径），排序不得影响它。
 */
export function sortRouteOptions(codes: (string | null)[] | null | undefined): string[] {
  const list = (codes ?? []).filter((c): c is string => !!c);
  const lrt = list.filter((c) => c.startsWith("LRT-"));
  const bus = list.filter((c) => !c.startsWith("LRT-"));
  const keyOf = (c: string): [number, number, string] => {
    const m = c.match(/^(\d+)(.*)$/);
    return m ? [0, Number(m[1]), m[2] ?? ""] : [1, 0, c];
  };
  bus.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
  });
  return [...lrt, ...bus];
}
