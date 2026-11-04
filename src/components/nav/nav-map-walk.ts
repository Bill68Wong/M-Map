"use client";

/**
 * 步行三种路的折线绘制（src/components/nav/nav-map-walk.ts，v3.6.0 · S5 · 设计 §2.3）
 *
 * ── 口径（架构锁定，**不得出现别名**）───────────────────────────────────
 *   地图上是**三条各自独立的 `AMap.Polyline`**，不是"同一条折线切三份"：
 *     `donePath`  已走过（**累积、单调增长**）  灰   w5 op0.85 z69
 *     `aheadPath` 后续步（尚未开始）            绿   w6 op0.75 z70
 *     `nowPath`   当前步**剩余**部分            绿   w6 op0.75 z73（带 showDir）
 *
 * ── ★ U1（2026-11-04）：未走段单一语义组，now/ahead 共享**同一对象引用** ──
 *   缺陷：`now`（op1.00 / w7）与 `ahead`（op0.55 / w5）**同属「未走」却各持一套参数**，
 *     而两者在地图首尾相接 ⇒ 人眼看到一条连续路径中途突变，读作"渲染错误"。
 *   修法（不是"把两个值改相等"，而是**让分叉写不出来**）：
 *     · 外观三参数（color/weight/opacity）收进唯一对象 `style.unwalked`；
 *     · `common()` 的签名变成 `(共享外观对象, z, showDir)` ⇒ now/ahead 能传入的差异
 *       **只剩 z 与 showDir**（这是层级职责与方向箭头，不是外观）；
 *     · 对外暴露的 `style.now` / `style.ahead` 是**只读视图**，外观全部 getter 代理到
 *       `unwalked`，自身只持有 z，且类型里**没有 opacity 字段** ⇒
 *       "给当前步单独调透明度"在类型层面无处可写（要写必须先改类型，改动必被 review 看见）。
 *   ⚠️ 分叉变量 `--map-walk-(w|op)-(now|ahead)` 已在 globals.css 降级为别名，
 *      本文件对它们**零引用**（`git grep -n "map-walk-\(w\|op\)-\(now\|ahead\)" -- src/`
 *      应只在 globals.css 的定义行命中）。
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

/** 折线的「外观三参数」（刻意**不含 z** —— z 是层级职责，不是外观） */
export interface WalkInkStyle {
  readonly color: string;
  readonly weight: number;
  readonly opacity: number;
}

/** 完整单层外观（含 z）—— 仅**语义独占**的层使用（已走 / 走廊） */
export interface WalkLayerStyle extends WalkInkStyle {
  readonly z: number;
}

/**
 * 只读层级视图（★ 刻意**不含 opacity**）。
 * `now` / `ahead` 对外的形状：外观一律代理到 `unwalked`，自己只持有 `z`。
 * ⇒ 「当前步单独调透明度」在这份类型里**没有字段可写**。
 */
export interface WalkLayerView {
  readonly color: string;
  readonly weight: number;
  readonly z: number;
}

export interface WalkPolylineStyle {
  /** 已走（用户的真实轨迹，语义上不属于「路」，故独立成组） */
  done: WalkLayerStyle;
  /**
   * ★ 未走段**唯一**语义组（U1）。
   * 绘制时 `nowPath` 与 `aheadPath` 传入的是**同一个对象引用**（`Object.is` 为真），
   * 不是"两份相等的值"—— 后者仍可被单独改一半。
   */
  unwalked: WalkInkStyle;
  /** 兼容既有只读钩子（NavMap 的 `[data-walk-layers]`）：外观代理自 `unwalked`，仅 z 独立 */
  now: WalkLayerView;
  ahead: WalkLayerView;
  /**
   * ★ T1：走廊 ghost（非当前段的完整步行走廊）—— **独立语义组**。
   * ⚠️ 它是"另一段路的预告"，不承载当前唯一可执行指引 ⇒ 不得与 `unwalked` 同值。
   */
  corridor: {
    readonly weight: number;
    readonly opacity: number;
    readonly opacityDone: number;
    readonly z: number;
  };
}

/**
 * 从 CSS 变量读真实色值（JS 侧**不写死色值**，兜底值仅为 Token 失效时的最后一道防线）。
 *
 * ⚠️ 兜底守卫（U1）：色值 Token 可能是 `var(...)` 别名或未解析的 `color-mix()`，
 *   这两种字面量喂给 AMap 画布会**静默失效**（线不画、不报错）。
 *   ⇒ 只接受已解析的字面量，否则回落兜底色。
 */
export function readWalkStyle(root: HTMLElement | null): WalkPolylineStyle {
  const cs = root ? getComputedStyle(root) : null;
  const v = (name: string, fb: string) => {
    const raw = (cs?.getPropertyValue(name) ?? "").trim();
    return raw && !/^(var|color-mix)\(/i.test(raw) ? raw : fb;
  };
  /**
   * ★ U1：未走段唯一外观对象。`Number(fb)` 兜底值必须与 globals.css 的 Token 值一致
   *   （6 / 0.75），否则主题变量整体失效时会**静默变样**。
   */
  const unwalked: WalkInkStyle = Object.freeze({
    color: v("--map-walk-unwalked-color", "#0b6e4f"),
    weight: Number(v("--map-walk-w-unwalked", "6")) || 6,
    opacity: Number(v("--map-walk-op-unwalked", "0.75")) || 0.75,
  });
  const zNow = Number(v("--map-z-walk-now", "73")) || 73;
  const zAhead = Number(v("--map-z-walk-ahead", "70")) || 70;
  /**
   * 只读视图：color/weight 走 getter 代理到**同一个** `unwalked`，自身只有 z。
   * `Object.freeze` 后再无 setter ⇒ 运行期也无法给 now 单独赋 opacity。
   */
  const view = (z: number): WalkLayerView =>
    Object.freeze({
      get color() {
        return unwalked.color;
      },
      get weight() {
        return unwalked.weight;
      },
      z,
    });
  return {
    done: {
      color: v("--map-walk-done", "#8c93a0"),
      weight: Number(v("--map-walk-w-done", "5")) || 5,
      opacity: Number(v("--map-walk-op-done", "0.85")) || 0.85,
      z: Number(v("--map-z-walk-done", "69")) || 69,
    },
    unwalked,
    now: view(zNow),
    ahead: view(zAhead),
    corridor: {
      weight: Number(v("--map-walk-w-corridor", "4")) || 4,
      opacity: Number(v("--map-walk-op-corridor", "0.6")) || 0.6,
      opacityDone: Number(v("--map-walk-op-corridor-done", "0.75")) || 0.75,
      z: Number(v("--map-z-walk-ghost", "68")) || 68,
    },
  };
}

/**
 * 公共折线参数。
 *
 * ★ v3.8.1（需求 6）：**虚线改实线** —— 负责人要求步行路径与巴士段同样用实线绘制
 *   （"绿实线"）。删除 `strokeStyle:"dashed"` / `strokeDasharray` 后取 AMap 默认实线；
 *   线宽与巴士段对齐的改动落在 CSS 变量（`--map-walk-w-unwalked: 6`，见 globals.css），
 *   本函数只管线型，不再管宽。
 *
 * ★ U1（2026-11-04）：签名由「4 个散数字 (color, weight, opacity, z)」收成
 *   **(共享外观对象, z, showDir)**。这是本需求的核心手段之一：
 *   now 与 ahead 调用时能传入的差异**只剩 z 与 showDir**，
 *   "未走段两套绿"在函数签名层面就无法再产生（不是靠注释提醒）。
 *
 * ⚠️ `lineCap:"round"` **刻意保持**。改 `butt` 会让每个 step 交界出现 90° 平口，
 *   弯道上肉眼可见断口 —— 比它带来的问题更严重。
 *   **已知并接受**的残留：两个相邻 step 共享的顶点处是两次 source-over 合成，
 *   会呈现约 6px 的略深圆点（Δrgb ≈ [46,27,33]）。不要试图消除它，
 *   更不要为了消除它改 lineCap。
 */
function common(ink: WalkInkStyle, z: number, withDir = false) {
  return {
    strokeColor: ink.color,
    strokeWeight: ink.weight,
    strokeOpacity: ink.opacity,
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
    next.donePath = new ctor({ path: seed?.done ?? [], ...common(style.done, style.done.z) });
    map.add(next.donePath);
  }
  /* ★ U1：ahead 与 now 传的是**同一个 `style.unwalked` 对象**，差异只有 z 与 showDir */
  if (!next.aheadPath && ok(seed?.ahead)) {
    next.aheadPath = new ctor({ path: seed?.ahead ?? [], ...common(style.unwalked, style.ahead.z) });
    map.add(next.aheadPath);
  }
  if (!next.nowPath && ok(seed?.now)) {
    next.nowPath = new ctor({ path: seed?.now ?? [], ...common(style.unwalked, style.now.z, true) });
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
     · 还没走 = corridor·ahead（绿细实线，op 0.6）；
     · 已走完 / 已乘车过 = corridor·done（灰细实线，op 0.75）—— 与「已驶过灰实线」同色系。
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
 * ghost 折线参数（细 + 浅 + 实线）。
 * ⚠️ 线宽/透明度/层级全部走 **corridor 语义组**（`--map-walk-w-corridor` 等），
 *   **不在这里写死数字**；颜色复用同族常量：已过 = `done`（灰）、未走 = `unwalked`（绿）。
 * ★ U1：走廊是**另一段路的预告**，不承载当前唯一可执行指引 ⇒
 *   它与「未走段」必须是两组不同参数（4/0.6 vs 6/0.75），**不得同值**。
 */
function ghostOptions(style: WalkPolylineStyle, tone: WalkGhostTone) {
  const ink: WalkInkStyle = {
    color: tone === "done" ? style.done.color : style.unwalked.color,
    weight: style.corridor.weight,
    opacity: tone === "done" ? style.corridor.opacityDone : style.corridor.opacity,
  };
  return common(ink, style.corridor.z);
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
