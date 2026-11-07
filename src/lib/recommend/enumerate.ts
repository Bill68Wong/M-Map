/**
 * 站序解析与站台归一（src/lib/recommend/enumerate.ts）
 *
 * 站序解析（`segmentsOf` / `idxsOf` / `deriveDirInMemory`）从 `scripts/seg-coverage.ts`
 * 移植为纯函数版 —— 采集脚本与推荐引擎共用同一套「逐跳展开」口径，避免两处漂移。
 * 活消费方：`lib/nav/{graph-search,enumerate-nav,map-stations,parallel-alts,remaining,strips}.ts`、
 * `lib/dsat/eta.ts`、`scripts/test-*.ts`。
 *
 * ★ 2026-11-04（需求 U9）：`dedupeByMain` 做**站台归一去掉重** ——
 *   `[...new Set(...)]` 是字符串全等去重，不做站台归一 ⇒ `C690/3`/`C690`/`C690/1` 各占一个名额。
 *   ⚠️ 归一**只用于去重键**；展示值保留原始站台码（`C690/2` 不得变成 `C690`）。
 *
 * ★ 2026-11-06（旧推荐链下线 · Spec §6.2.2）：本文件原还含「候选枚举」整段
 *   （`enumerateOptions` / `boardsOf` / `alightsOf` / `applyStopPriority` / `STOP_PRIORITY` /
 *   `PlanLegsRow` / `PlanLite` / `stopsFor`）—— 它们只服务于 `optionsFor → modelOption`
 *   那条已被删除的本地枚举链（`service.ts` / `card.ts`），且 `plan_legs` 表本批删除
 *   ⇒ 全部零消费方，已随链下线删除。**别按 git 历史把它们搬回来**：数据源已不存在。
 */
import { mainCodeOf } from "./segment-lookup";
import type { RouteIndex } from "./types";

/** 三段式站码匹配 → 返回所有命中的下标（循环线首尾同码会返回 2 个） */
export function idxsOf(stops: string[], target: string): number[] {
  const hit = (fn: (s: string) => boolean) => stops.map((s, i) => (fn(s) ? i : -1)).filter((i) => i >= 0);
  const exact = hit((s) => s === target);
  if (exact.length) return exact;
  const mid = hit((s) => s.startsWith(target + "/"));
  if (mid.length) return mid;
  const rev = hit((s) => target.startsWith(s + "/"));
  if (rev.length) return rev;
  const p = mainCodeOf(target);
  return hit((s) => mainCodeOf(s) === p);
}

/**
 * 对某条线路、某 from→to，取逐跳段列表
 * （选能顺向解出的方向 + 沿行驶方向环距最近的解 —— 循环线首尾同码取近的一圈）
 */
export function segmentsOf(
  idx: RouteIndex,
  route: string,
  from: string,
  to: string,
): { stops: string[]; segs: [string, string][] } | null {
  const dirs = idx.dirsOf.get(route) ?? [];
  let best: { stops: string[]; segs: [string, string][] } | null = null;
  for (const d of dirs) {
    const stops = idx.dirStops.get(`${route}|${d}`);
    if (!stops) continue;
    const fis = idxsOf(stops, from);
    const tis = idxsOf(stops, to);
    if (!fis.length || !tis.length) continue;
    let bestPair: { i: number; j: number } | null = null;
    for (const i of fis) {
      for (const j of tis) {
        if (j <= i) continue;
        if (!bestPair || j - i < bestPair.j - bestPair.i) bestPair = { i, j };
      }
    }
    if (!bestPair) continue;
    const segs: [string, string][] = [];
    for (let k = bestPair.i; k < bestPair.j; k++) segs.push([stops[k], stops[k + 1]]);
    if (!best || segs.length > best.segs.length) best = { stops, segs };
  }
  return best;
}

/**
 * 内存版方向推导（语义对齐 `src/lib/dsat/eta.ts#deriveRouteDir`）：
 * 找「from 在 to 之前」的那套方向；推导不出回退 fallback；
 * 循环线（只有一套站序且两站都在）用该唯一方向。站码取**末次出现**（与 SQL 的 max(seq) 一致）。
 */
export function deriveDirInMemory(
  idx: RouteIndex,
  route: string,
  from: string | null | undefined,
  to: string | null | undefined,
  fallback = "0",
): string {
  if (!from || !to) return fallback;
  const dirs = idx.dirsOf.get(route) ?? [];
  let candidate: string | null = null;
  let bothCount = 0;
  for (const d of dirs) {
    const stops = idx.dirStops.get(`${route}|${d}`);
    if (!stops) continue;
    let fi = -1;
    let ti = -1;
    for (let i = 0; i < stops.length; i++) {
      const c = stops[i] ?? "";
      if (c === from || c.startsWith(from + "/")) fi = i;
      if (c === to || c.startsWith(to + "/")) ti = i;
    }
    if (fi >= 0 && ti >= 0) {
      bothCount++;
      candidate = d;
      if (fi < ti) return d;
    }
  }
  if (bothCount === 1 && candidate) return candidate;
  return fallback;
}

/**
 * ★ R5（IMP6）（2026-11-04 · 需求 U9）：**按 `mainCodeOf` 归一去重**（保序）。
 *
 * 已查实缺陷：原先两处都写 `[...new Set(out.filter(Boolean))]` —— 那是**字符串全等**去重，
 * 不做站台归一。实例：`C690/3`、`C690`、`C690/1`、`T367`、`T367/2` ⇒ `new Set` 得 5 个
 * ⇒ 每个各生成一条 seed ⇒ **同一物理站最多 5 张卡**（说的是同一件事）。
 * 按 `mainCodeOf` 归一并保留首次出现的写法后，只剩 `C690, T367` 两个。
 *
 * ⚠️ **IMP6：归一只用于「去重键」，展示值必须保留原始站台码** ——
 *   同一主码里若有一个带站台号的写法（`C690/2`），**展示值取它**，不得抹平成 `C690`。
 *   站台号是真实信息（DSAT 报站与站牌都按站台区分），抹掉等于降级卡面精度。
 */
export function dedupeByMain(list: string[]): string[] {
  const order: string[] = [];
  const picked = new Map<string, string>();
  for (const s of list) {
    if (!s) continue;
    const k = mainCodeOf(s);
    const cur = picked.get(k);
    if (cur === undefined) {
      picked.set(k, s);
      order.push(k);
      continue;
    }
    // 同一物理站的两种写法：优先保留**带站台号**的那个（`s !== k` ⇔ s 有站台后缀）
    if (cur === k && s !== k) picked.set(k, s);
  }
  return order.map((k) => picked.get(k)!);
}


