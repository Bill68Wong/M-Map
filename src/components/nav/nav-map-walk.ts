"use client";

/**
 * 步行三种路的折线绘制（src/components/nav/nav-map-walk.ts，v3.6.0 · S5 · 设计 §2.3）
 *
 * ── 口径（架构锁定，**不得出现别名**）───────────────────────────────────
 *   地图上是**三条各自独立的 `AMap.Polyline`**，不是"同一条折线切三份"：
 *     `donePath`  已走过（**累积、单调增长**）  灰   w5 op0.85 z69
 *     `aheadPath` 后续步（尚未开始）            绿   w5 op0.55 z70
 *     `nowPath`   当前步**剩余**部分            绿   w7 op1.00 z73（带 showDir）
 *
 * ── 切分规则（容易写反）──────────────────────────────────────────────────
 *   · `nowPath` = 当前步折线按 `ratio` 切开后的**后半**（还没走的那截）；
 *   · `donePath` **不参与任何切分** —— 每帧把当前位置投影点**追加**到末尾，
 *     **偏航重算后不清空、不重置**（长度单调不减）。
 *   ⇒ `donePath` 与另两条**可能几何不同源**（重算后路径变了）。
 *     "灰线与新绿线接续但不完全共线"是**正确行为**：灰线是用户真实轨迹，不该跟着新路径重画。
 *
 * ── z 纪律 ────────────────────────────────────────────────────────────
 *   三条都 ≤74（不得压住公交段灰实线 74 之上的层级）；蓝点 128 / 车辆 130 永远在上。
 *   进入 `riding` 时调用方应 `clear()` 三条（0ms 移除，不做淡出）—— 把共存窗口直接消掉。
 */
import type { WalkStep } from "@/lib/walk/walk-shared";

/** 这里只依赖 AMap 的最小面（避免把 @amap 类型拖进纯逻辑） */
interface PolylineLike {
  setPath(p: [number, number][]): void;
  setOptions?(o: Record<string, unknown>): void;
  show?(): void;
  hide?(): void;
}
interface MapLike {
  add(o: unknown): void;
  remove(o: unknown): void;
}
interface PolylineCtor {
  new (o: Record<string, unknown>): PolylineLike;
}

export interface WalkLayers {
  donePath: PolylineLike | null;
  nowPath: PolylineLike | null;
  aheadPath: PolylineLike | null;
}

export interface WalkPolylineStyle {
  done: { color: string; weight: number; opacity: number; z: number };
  ahead: { color: string; weight: number; opacity: number; z: number };
  now: { color: string; weight: number; opacity: number; z: number };
  /** ★ T1：走廊 ghost（非当前段的完整步行走廊）—— 细一档、淡一档、z 低一档 */
  ghost: { weight: number; opacity: number; opacityDone: number; z: number };
}

/** 从 CSS 变量读真实色值（禁止在 JS 里写死色） */
export function readWalkStyle(root: HTMLElement | null): WalkPolylineStyle {
  const cs = root ? getComputedStyle(root) : null;
  const v = (name: string, fb: string) => (cs?.getPropertyValue(name).trim() || fb).trim();
  return {
    done: {
      color: v("--map-walk-done", "#8c93a0"),
      weight: Number(v("--map-walk-w-done", "5")) || 5,
      opacity: Number(v("--map-walk-op-done", "0.85")) || 0.85,
      z: Number(v("--map-z-walk-done", "69")) || 69,
    },
    ahead: {
      color: v("--map-walk-ahead", "#0b6e4f"),
      weight: Number(v("--map-walk-w-ahead", "5")) || 5,
      opacity: Number(v("--map-walk-op-ahead", "0.55")) || 0.55,
      z: Number(v("--map-z-walk-ahead", "70")) || 70,
    },
    now: {
      color: v("--map-walk-ahead", "#0b6e4f"),
      weight: Number(v("--map-walk-w-now", "7")) || 7,
      opacity: Number(v("--map-walk-op-now", "1")) || 1,
      z: Number(v("--map-z-walk-now", "73")) || 73,
    },
    ghost: {
      weight: Number(v("--map-walk-w-ghost", "4")) || 4,
      opacity: Number(v("--map-walk-op-ghost", "0.4")) || 0.4,
      opacityDone: Number(v("--map-walk-op-ghost-done", "0.5")) || 0.5,
      z: Number(v("--map-z-walk-ghost", "68")) || 68,
    },
  };
}

/**
 * 公共折线参数。
 *
 * ★ v3.8.1（需求 6）：**虚线改实线** —— 负责人要求步行路径与巴士段同样用实线绘制
 *   （"绿实线"）。删除 `strokeStyle:"dashed"` / `strokeDasharray` 后取 AMap 默认实线；
 *   线宽与巴士段对齐的改动落在 CSS 变量（`--map-walk-w-ahead: 6`，见 globals.css），
 *   本函数只管线型，不再管宽。
 *   ⚠️ `lineCap:"round"` 在虚线时代是"圆点"的唯一来源；实线化后它仍保留（端点圆润），
 *      不再产生圆点节奏 —— 旧注释里"缺了会被误读成施工路段"的语境已随虚线一起删除。
 */
function common(color: string, weight: number, opacity: number, z: number, withDir = false) {
  return {
    strokeColor: color,
    strokeWeight: weight,
    strokeOpacity: opacity,
    lineJoin: "round",
    lineCap: "round",
    zIndex: z,
    bubble: false,
    showDir: withDir,
  };
}

/**
 * 建三条（幂等：已存在则复用）。
 *
 * ★ P0（2026-10-31）：可选 `seed` = **每层的初始几何**。
 *   高德 `Polyline` 对**空 `path`** 会抛 `Polyline path`（且构造时也可能抛），
 *   而"最后一步的 ahead"天然是 `[]`、步末的 `remaining` 也可能是 `[]`。
 *   ⇒ 没有几何的层**不要建**（`seed` 里长度 <2 就跳过），需要时下一帧再建。
 *   不传 `seed` 时保持旧行为（`path: []`），仅供不需要判空的调用方使用。
 */
export function ensureWalkLayers(
  map: MapLike | null,
  ctor: PolylineCtor | null,
  style: WalkPolylineStyle,
  cur: WalkLayers,
  seed?: { done: [number, number][]; now: [number, number][]; ahead: [number, number][] },
): WalkLayers {
  if (!map || !ctor) return cur;
  const next = { ...cur };
  /** 该层是否"有几何可画"；没传 seed ⇒ 视为可建（旧行为） */
  const ok = (p?: [number, number][]) => !seed || (p != null && p.length >= 2);
  if (!next.donePath && ok(seed?.done)) {
    next.donePath = new ctor({ path: seed?.done ?? [], ...common(style.done.color, style.done.weight, style.done.opacity, style.done.z) });
    map.add(next.donePath);
  }
  if (!next.aheadPath && ok(seed?.ahead)) {
    next.aheadPath = new ctor({ path: seed?.ahead ?? [], ...common(style.ahead.color, style.ahead.weight, style.ahead.opacity, style.ahead.z) });
    map.add(next.aheadPath);
  }
  if (!next.nowPath && ok(seed?.now)) {
    next.nowPath = new ctor({ path: seed?.now ?? [], ...common(style.now.color, style.now.weight, style.now.opacity, style.now.z, true) });
    map.add(next.nowPath);
  }
  return next;
}

/**
 * 按 `ratio` 把当前步折线切成「已走 / 未走」两段。
 * ⚠️ 返回的**后半**才是 `nowPath`（设计 §2.3：nowPath = 还没走的那截）。
 */
export function splitStepByRatio(
  step: WalkStep | undefined,
  ratio: number,
): { walked: [number, number][]; remaining: [number, number][] } {
  const poly = step?.polyline ?? [];
  if (poly.length < 2) return { walked: [], remaining: [] };
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  if (r <= 0) return { walked: [], remaining: poly };
  if (r >= 1) return { walked: poly, remaining: [] };

  /* 按顶点等分近似定位切点（步内顶点均匀里程由服务端 `cumM` 保证；
     这里只做几何切分，**不重算累计里程**） */
  const seg = (poly.length - 1) * r;
  const i = Math.floor(seg);
  const t = seg - i;
  const a = poly[i];
  const b = poly[i + 1] ?? a;
  const cut: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return {
    walked: [...poly.slice(0, i + 1), cut],
    remaining: [cut, ...poly.slice(i + 1)],
  };
}

/** 清空三条（进入 riding / 退出 walk 时调用；0ms 移除，不做淡出） */
export function clearWalkLayers(map: MapLike | null, layers: WalkLayers): WalkLayers {
  if (map) {
    for (const l of [layers.donePath, layers.nowPath, layers.aheadPath]) {
      if (l) map.remove(l);
    }
  }
  return { donePath: null, nowPath: null, aheadPath: null };
}

/* ══════════════════════════════════════════════════════════════════════════
   ★ 一条导航流：**非当前段的步行走廊（ghost）**
   ──────────────────────────────────────────────────────────────────────────
   为什么要单独一层：末段步行原来的 `walk` 三线只在「正在跟随」时存在
   ⇒ 乘车途中地图上**看不到**下车后要走的那段（用户以为没规划）。
   现在首段/末段只要有几何就常驻地图：
     · 还没走 = `ahead`（绿细虚线，op 0.4）；
     · 已走完 / 已乘车过 = `done`（灰细虚线，op 0.5）—— 与「已驶过灰实线」同色系。
   与三线的关系：**同一时刻只有一段走三线（正在跟随那段）**，另一段走 ghost；不重叠、不重复画。
   zIndex 68 < 乘车彩段 72 ⇒ 与乘车段共线时也不压住线路色。
   ══════════════════════════════════════════════════════════════════════════ */
export type WalkGhostTone = "ahead" | "done";

export interface WalkGhost {
  /** 稳定 key（段名，如 `out` / `in`）—— 用于增量 diff，避免每帧重建折线 */
  key: string;
  path: [number, number][];
  tone?: WalkGhostTone;
}

export interface WalkGhostRec {
  pl: PolylineLike;
  tone: WalkGhostTone;
}

/**
 * ghost 折线参数（细 + 浅 + 虚线）。
 * ⚠️ 线宽/透明度/层级全部走 Token（`--map-walk-w-ghost` 等），**不在这里写死数字**；
 *   颜色复用同族常量：已过 = `done`（灰）、未走 = `ahead`（绿）。
 */
function ghostOptions(style: WalkPolylineStyle, tone: WalkGhostTone) {
  const color = tone === "done" ? style.done.color : style.ahead.color;
  const op = tone === "done" ? style.ghost.opacityDone : style.ghost.opacity;
  return { ...common(color, style.ghost.weight, op, style.ghost.z) };
}

/**
 * 同步 ghost 层（增量：key 集合 diff + tone 变化时 `setOptions`）。
 * 返回新的存活表（调用方持有 ref，卸载/离开时交给 `clearWalkGhosts`）。
 */
export function syncWalkGhosts(
  map: MapLike | null,
  ctor: PolylineCtor | null,
  style: WalkPolylineStyle,
  cur: Map<string, WalkGhostRec>,
  ghosts: WalkGhost[],
): Map<string, WalkGhostRec> {
  if (!map || !ctor) return cur;
  const next = new Map(cur);
  const want = new Set(ghosts.filter((g) => g.path.length >= 2).map((g) => g.key));
  for (const [k, rec] of next) {
    if (want.has(k)) continue;
    map.remove(rec.pl);
    next.delete(k);
  }
  for (const g of ghosts) {
    if (g.path.length < 2) continue;
    const tone: WalkGhostTone = g.tone ?? "ahead";
    const rec = next.get(g.key);
    if (!rec) {
      const pl = new ctor({ path: g.path, ...ghostOptions(style, tone) });
      map.add(pl);
      next.set(g.key, { pl, tone });
      continue;
    }
    rec.pl.setPath(g.path);
    if (rec.tone !== tone) {
      rec.pl.setOptions?.(ghostOptions(style, tone));
      rec.tone = tone;
    }
  }
  return next;
}

/** 清空 ghost（退出导航 / 离开 detail 时调用；0ms 移除） */
export function clearWalkGhosts(map: MapLike | null, cur: Map<string, WalkGhostRec>): Map<string, WalkGhostRec> {
  if (map) for (const [, rec] of cur) map.remove(rec.pl);
  cur.clear();
  return cur;
}
