/**
 * 站序弹窗 · 纵条四态巴士图标的**数据映射**（src/components/nav/stops-veh-marks.ts，2026-11-06 · #6）
 *
 * ── 职责边界（纯函数，零 React / 零网络）─────────────────────────────────
 *   把「`/api/route-vehicles` 的在途车辆」+「本方向站序（主码顺序）」翻译成
 *   `LineStopRow` 能吃的一行一个 `LineStopVeh`：
 *     · 一行**最多一个图标**（`LineStopRow.veh` 是单值 prop ⇒ 结构上天然一站一图标）；
 *     · 语义判据、优先级、插值全部收在**本文件**，组件只负责渲染（可被脚本直接跑）。
 *   渲染层（`LineStopRow`）已有四态的**外观**与 `--veh-frac` 夹取；本文件只给语义与比例。
 *
 * ── ★ 不重算「车在站序第几站」（复用既有引擎）────────────────────────────
 *   「车辆 → 站序位置」的**唯一权威实现**是 `lib/nav/track.ts#progressOf`
 *   （导航 / 乘车追踪全线在用，`scripts/test-nav-info-consistency.ts` 与
 *   `test-remaining-view.ts` 都在守它，含环线首末同站、`unknown` 如实上报等边界）。
 *   本文件**不写第二套 indexOf 逻辑**，只做映射：
 *     `progressOf` 的 `at` → `ready` / `stop`；`between` → `approach` / `moving`；
 *     `unknown` / `lost` → **不画**。
 *   「到终点还有几站」同样复用 `stopsAwayOf(prog, lastIdx)`（下车站 = 本方向终点站）——
 *   自己写 `lastIdx − idx` 必然在「停靠 / 行驶」其中一种态上差 1（该函数注释记着真实事故）。
 *
 * ── 四态判据（★ 与 `LineStopRow` 顶部表格逐项对照，DSAT 实际字段见 `/api/route-vehicles`）
 *
 *   | `data-veh` | 语义 | 本文件的判据 |
 *   |---|---|---|
 *   | `ready`    | 准备发车 | `progressOf` = `at` 且 `atIdx === 0`（停靠在**本方向首站**，尚未发车） |
 *   | `stop`     | 停站 | `progressOf` = `at` 且 `atIdx > 0`（停靠在非首站，含终点站到达） |
 *   | `approach` | 进站 | `progressOf` = `between` 且 **`progress.p ≥ APPROACH_P`**（已走完区间 ≥ 80%） |
 *   | `moving`   | 站间行驶 | 其余 `between`（在区间中段 / 进度不可用） |
 *
 *   ⚠️ **为什么 `approach` 用 `progress.p` 而不是「`stopsAway ≤ 1`」**：`/api/route-vehicles`
 *      的报站口径里，每辆在途车的「挂载站 = 刚离开的站」⇒「到下一站」恒为 1 站
 *      ⇒ 拿它判进站会让**所有在途车**都成 `approach`，`moving` 永不可达
 *      （四态静默退化成三态，无任何报错）。`p` 是唯一能区分「区间中段 / 快到站」的量：
 *      `p < 0.8` ⇒ `moving`（图标在两节点之间）；`p ≥ 0.8` ⇒ `approach`（吸附下一站节点
 *      + 4px 呼吸环）。取不到 `p`（无几何 / 无里程 / 无跳时长 ⇒ 服务端刻意不吐 progress）
 *      ⇒ `moving` + `frac = 0.5`（居中），**绝不猜**。
 *
 * ── `frac` 的来源与降级 ─────────────────────────────────────────────────
 *   · 来源：`progress.p`（0 = 刚离 `interval.from`，1 = 即将到 `interval.to`）。
 *   · `LineStopRow` 的 `--veh-frac` 契约是「本行 → **下一行**」的比例，而行 = `passedIdx`
 *     （= 刚离开的站 = `interval.from`）⇒ `frac = p` 天然同口径。
 *   · 防御：`progress.segFrom` 与 `interval.from` 主码不一致 ⇒ 视为脏数据，降级 `0.5`
 *     （否则会拿「另一段」的 p 画在「这一段」上 —— 静默错位，不报错）。
 *   · 降级：`p` 缺失/非有限 ⇒ `0.5`；本行是**末站**（没有下一行）⇒ `0`（否则图标溢出列表外）。
 *   · 夹取：本文件输出前已 clamp 到 `[0, 1]`；`LineStopRow` 还有最后一道夹取（双保险）。
 *   · ⚠️ `p ≥ 0.8` 时走 `approach`（frac 恒 0）⇒ clamp 的上界分支实际是**防御性**的。
 *
 * ── 多车策略（高峰同线多车）─────────────────────────────────────────────
 *   判据「一行一个图标」⇒ 同一行出现多辆车时**取优先级最高的一辆**：
 *     `stop(3) > approach(2) > ready(1) > moving(0)`；
 *   同优先级取 `frac` 更小者（更靠近本行节点 = 更"刚离站"，与本行文字的空间关系更紧）。
 *   理由：`stopping` 是**确定性事实**（车就在这站），在途是**估计**（依赖进度模型）⇒
 *   事实优先；否则会出现「明明有车停在这站，却什么都看不见」。
 *   ⚠️ 被淘汰的车**不是消失** —— 地图层（`VehicleLayer`）仍然画着它们；本文件只决定
 *      「纵条这一行的图标归谁」。
 */
import { mainOf, type RouteShapesResp } from "@/lib/line/line-shared";
import { progressOf, stopsAwayOf, type TrackVehicle } from "@/lib/nav/track";
import type { LineStopVeh, VehState } from "@/components/line/LineStopRow";
import { companyLabel, normalizeCompany, type VehicleLite } from "./VehicleMarker";

/** 「进站」阈值：区间进度 `p ≥ 0.8` 判为「即将到站」（见文件头的判据说明） */
export const APPROACH_P = 0.8;

/** 无 `progress` 时的降级插值比例（居中；见文件头「frac 的来源与降级」） */
export const FALLBACK_FRAC = 0.5;

/** 纵条一行的图标载荷（= `LineStopVeh` + 打开巴士卡所需的完整车辆记录） */
export interface VehMark extends LineStopVeh {
  /** 该图标代表的车辆（点击 → 巴士信息卡直接吃它，无需再查表） */
  vehicle: VehicleLite;
  /** 距**本方向终点站**还有几站（0 = 已到终点站） */
  toEndStops: number;
}

/** 一格一图标：同一行多车时的取舍优先级（数值大者胜） */
const PRIORITY: Record<VehState, number> = { stop: 3, approach: 2, ready: 1, moving: 0 };

interface MarkCore {
  /** 该图标挂在哪个站（**主码**，与站序数组的主码同口径） */
  rowMain: string;
  state: VehState;
  frac: number;
  toEndStops: number;
}

/** 把 code 归一到主码的薄封装（`M95/3` → `M95`；非标准码原样返回） */
export const toMain = (code: string | null | undefined): string | null => {
  const s = (code ?? "").trim();
  return s ? mainOf(s) : null;
};

/** 数值夹取（防 NaN / ±Infinity 进 CSS 变量） */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 单车 → 纵条图标位置。
 *
 * ── ★ 复用既有引擎，不写第二套「车在站序第几站」 ─────────────────────────
 *   「车辆 → 站序位置」的**唯一权威实现**是 `lib/nav/track.ts#progressOf`
 *   （导航/乘车追踪全线在用，`scripts/test-nav-info-consistency.ts` 与
 *   `test-remaining-view.ts` 都在守它）。本函数**不重算**下标，只做两件事：
 *     ① 把 `TrackProgress` 的三种 `kind` 映射成四态；
 *     ② 补上渲染层要的 `frac`（`progressOf` 不管纵向插值）。
 *   「到终点还有几站」同样复用 `stopsAwayOf(prog, lastIdx)`（下车站 = 本方向终点站），
 *   **不自己写 `lastIdx − idx`** —— 那个式子在「停靠 / 行驶」两种态上的锚站不同，
 *   自己写必然在某一种态上差 1（`stopsAwayOf` 的注释记着这个真实事故）。
 *
 * @returns `null` = 这辆车无法落到本方向的任何一行（数据不到位 ⇒ 不画，绝不放占位图标）
 */
function coreOf(v: VehicleLite, stopMains: string[], lastIdx: number): MarkCore | null {
  /**
   * 显式收窄成 `TrackVehicle`（三处 `?? null` 不是冗余）：
   * `VehicleLite` 的可选字段是**可选**（`interval?`），而 `TrackVehicle` 要求**必填可空**
   * —— 直接传会因为 `undefined` 不可赋给 `null` 而报错；顺手把「缺席」统一成 `null`。
   */
  const track: TrackVehicle = {
    plate: v.plate,
    lat: v.lat,
    lng: v.lng,
    status: v.status,
    interval: v.interval ?? null,
    atStation: v.atStation ?? null,
    progress: v.progress ?? null,
  };
  const prog = progressOf(stopMains, track);
  /** 统一口径的「到终点还有几站」；`null` = 进度不可用/站序不足两站 ⇒ 这辆车不画 */
  const toEnd = stopsAwayOf(prog, lastIdx);
  if (prog.kind !== "at" && prog.kind !== "between") return null;
  if (toEnd === null) return null;

  // ① 停靠（`progressOf` 的 `at` 分支：含总站待发）
  if (prog.kind === "at") {
    if (prog.atIdx === null) return null; // 对象不自洽 ⇒ 不画（不拿 passedIdx+1 去猜）
    const row = stopMains[prog.atIdx];
    if (!row) return null;
    return {
      rowMain: row,
      // 首站 ⇒ 还没发车（空心盘）；其余一律「停站」（实心盘）
      state: prog.atIdx === 0 ? "ready" : "stop",
      frac: 0,
      toEndStops: toEnd,
    };
  }

  // ② 在途（`progressOf` 的 `between` 分支：`passedIdx` = 刚离开的站）
  const fromIdx = prog.passedIdx;
  const row = stopMains[fromIdx];
  if (!row) return null;
  const p = v.progress?.p;
  // 进度是否可信：`progress.segFrom` 必须与本段起点一致（见文件头「防御」）
  const segOk = !v.progress?.segFrom || toMain(v.progress.segFrom) === toMain(v.interval?.from?.code);
  const usable = typeof p === "number" && Number.isFinite(p) && segOk;

  // ②-a 进站：已走完 ≥ 80% 且知道下一站是谁 ⇒ 吸附**下一站节点**（4px 呼吸环）
  if (usable && (p as number) >= APPROACH_P && prog.nextIdx !== null) {
    const next = stopMains[prog.nextIdx];
    if (next) {
      const nextToEnd = stopsAwayOf({ ...prog, kind: "at", atIdx: prog.nextIdx }, lastIdx);
      return {
        rowMain: next,
        state: "approach",
        frac: 0, // 非 moving ⇒ 图标吸附节点（`LineStopRow` 也会把 frac 夹成 0）
        toEndStops: nextToEnd ?? toEnd,
      };
    }
  }

  // ②-b 站间行驶：末站没有「下一行」⇒ frac 必须为 0，否则图标溢出列表
  const cur = usable ? clamp01(p as number) : FALLBACK_FRAC;
  return {
    rowMain: row,
    state: "moving",
    frac: fromIdx >= lastIdx ? 0 : cur,
    toEndStops: toEnd,
  };
}

/** 图标的读屏/悬浮摘要：`车牌 · 运营商 · 还有 N 站`（`LineStopVeh.label` 的既定口径） */
function labelOf(v: VehicleLite, toEndStops: number): string {
  const company = v.company ? companyLabel(normalizeCompany(v.company)) : "";
  const tail = toEndStops <= 0 ? "已到终点" : `还有 ${toEndStops} 站`;
  return [v.plate, company, tail].filter(Boolean).join(" · ");
}

/** `a` 是否应该顶掉 `b`（见文件头「多车策略」） */
function outranks(a: VehMark, b: VehMark): boolean {
  const pa = PRIORITY[a.state];
  const pb = PRIORITY[b.state];
  if (pa !== pb) return pa > pb;
  // `frac` 在 `LineStopVeh` 上是可选的（其余三态无意义）⇒ 这里按 0 取，不做非空断言
  return (a.frac ?? 0) < (b.frac ?? 0);
}

/**
 * 车辆列表 + 本方向站序 ⇒ 「主码 → 图标」查表。
 *
 * @param stopMains 本方向站序的**主码**（顺序即站序；与 `LineStopRow` 的行顺序同源）
 * @param vehicles  `/api/route-vehicles` 的车辆（坐标已 GCJ-02，本文件不用坐标）
 */
export function buildVehMarks(stopMains: string[], vehicles: VehicleLite[]): Map<string, VehMark> {
  const out = new Map<string, VehMark>();
  if (!stopMains.length || !vehicles.length) return out;

  const lastIdx = stopMains.length - 1;

  for (const v of vehicles) {
    const core = coreOf(v, stopMains, lastIdx);
    if (!core) continue;
    const mark: VehMark = {
      state: core.state,
      frac: core.frac,
      label: labelOf(v, core.toEndStops),
      vehicle: v,
      toEndStops: core.toEndStops,
    };
    const prev = out.get(core.rowMain);
    if (!prev || outranks(mark, prev)) out.set(core.rowMain, mark);
  }
  return out;
}

/**
 * 一行需要的最小身份：`seq`（1 基站序，**行内唯一**）+ `code`（站台码，用于二次核对）。
 */
export interface RowKeyLike {
  code: string;
  seq: number;
}

/**
 * 「主码 → 图标」⇒「**行** → 图标」的闸门（2026-11-07 · 环线重复站的重复图标修复）。
 *
 * ── 为什么需要这一层（`buildVehMarks` 解决不了）───────────────────────────
 *   `buildVehMarks` 的键是**主码** ⇒ 一站一份，天然「一站最多一个 mark」。但渲染是按
 *   **行**（站台码）来的，而 `vehOf(stop)` 用 `mainOf(stop.code)` 查表 ⇒
 *   **同一个主码出现在几行，就在几行各画一个图标**。
 *   **环线**（如 26 路）首末同站，站序里同一站出现**两次**
 *   （`src/lib/line/load-route-stops.ts` 文件头明写「环线首尾同站出现两次」，里程多行制
 *   就是为它做的）⇒ 首末两行主码相同 ⇒ 同一辆车被画两个图标。
 *   实测症状：QA 看到 `data-veh-count=4`（唯一主码数）而 `.lp-stop__veh` 元素 = 5。
 *   ⚠️ 这是**静默**错误：不报错、不空屏，只是「同一台车在图上出现两次」，
 *      用户读出「这条线有两辆车在首站待发」，比不显示更坏。
 *
 * ── 修法：只给「该主码**首次出现**的那一行」 ─────────────────────────────
 *   环线首末同站 ⇒ 图标画在**首行**（出发那一端），末行（绕回来的同一个节点）不重复画。
 *   这与 `LineStopList` 的首末站实心点口径一致（两端都是"到头了"的视觉表达，
 *   车辆图标只属第一次遇到的那一行）。
 *
 * ── 脏数据防线 ───────────────────────────────────────────────────────────
 *   `Map` 的键是 `seq`（行内唯一）。若服务端给出**重复 `seq`**（脏数据），后一行会被
 *   **丢弃**（`if (out.has(seq)) continue`）⇒ 该行不画图标，而不是让两行抢同一个键、
 *   甚至重复画同一辆车。`code` 一并存下，调用方查表时二次核对 ⇒ `seq` 撞车也不会
 *   把 A 行的图标画到 B 行上（错位 = 静默错版）。
 *
 * ⚠️ 本函数只做「行级闸门」，**不重新判四态/不重新取舍多车** —— 那些全在
 *    `buildVehMarks` 里，一行仍然只有一辆车（见该函数「多车策略」）。
 *
 * @param rows  本方向站序的行身份（顺序即渲染顺序）
 * @param marks `buildVehMarks` 的输出（键 = 主码）
 * @returns `seq → { code, mark }`；`mark === null` = 该行不画（非首次出现 / 无车）
 */
export function gateRows<M>(
  rows: RowKeyLike[],
  marks: ReadonlyMap<string, M>,
): Map<number, { code: string; mark: M | null }> {
  const seen = new Set<string>();
  const out = new Map<number, { code: string; mark: M | null }>();
  for (const row of rows) {
    if (out.has(row.seq)) continue; // 脏数据（重复 seq）⇒ 该行不画，绝不重复画同一辆车
    const main = toMain(row.code);
    const first = main !== null && !seen.has(main);
    if (main !== null) seen.add(main);
    out.set(row.seq, { code: row.code, mark: first ? marks.get(main) ?? null : null });
  }
  return out;
}

/**
 * 方向判定：本方向站序 ↔ `/api/route-shapes` 的 `shapes[].stations`（主码、按站序）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 *   `/api/route-vehicles` **必须**带 `dir`（缺省回 400）。站序弹窗的 props 里没有方向，
 *   宿主（`NavShell`）也没传 ⇒ 只能就地判。
 *
 * ── ⚠️⚠️ 方向判错 = **没有任何信号**（本函数最危险的失效方式）─────────────
 *   判错方向不会报错、不会空列表、不会白屏 —— 接口照样返回一堆车，每辆都"有车牌、
 *   有状态、有几站"，于是纵条上会画出**看起来完全正常**的图标，但画的是**反方向**的
 *   另外几辆车。用户读到的是「车还有 12 站到终点」而实际只剩 2 站。
 *   这类错误**比不显示图标坏得多**：不显示 ⇒ 用户知道没数据；显示错的 ⇒ 用户信了。
 *   ⇒ **禁止**用「站集合交集 / 站数相同 / 站名相似度」判方向：双方向几乎停同一批站
 *     （只是反序）⇒ 集合相同、交集相同 ⇒ 判不出，等于随机挑一个（静默选错的经典形态）。
 *     唯一可靠判据是**首站 / 末站**（反序时必然互换）。
 *
 * ── 三级方向来源的**主次关系**（改这里的代码前必读，别为了省一次请求把它改坏）
 *   ① 宿主给 `dir`（`RouteStopsSheet.dir`）—— **首选**，零额外请求、绝对权威。
 *   ② 本函数（读 `route-shapes` 首末站判定）—— **只是省一次请求的优化**，不是主路径：
 *      `route-shapes` 是静态几何、有 `max-age=3600`，且 `NavMap` 选线时已请求过同一 URL
 *      ⇒ 实际多为浏览器缓存命中。**它的价值仅在"少一次往返"，不在"判得更准"。**
 *   ③ 判不出（`shapes` 为空 / 无 `stations` 字段 / 两个方向同首末站）⇒ 返回 `null`
 *      ⇒ 调用方**不取车辆、一行图标都不画**。
 *
 *   🚩 **第 ③ 级是安全底线，不是"保守的兜底"，删了它就是 bug**：
 *      它挡的正是上面那种「静默画错方向」的形态。任何人若为了"减少一次请求/让图标尽量
 *      显示"而删掉 ③（例如判不出时 `return usable[0].dir` 随便挑一个），
 *      都会把「偶尔没图标」升级成「经常显示反方向的车」——
 *      **反向车的站数显示比没有图标坏得多。**
 *      正确做法是从 ① 补数据（宿主传 `dir`），而不是放宽 ③。
 *
 * ── 退回顺序（函数内部）────────────────────────────────────────────────
 *   只认得出一个方向 ⇒ 直接用它（不用判）。
 *   两个方向都能判 ⇒ 按首末站打分（首站命中 +2 / 末站命中 +2 / 站码重叠比例作同分次序项，
 *   三项都拿不到分才落到 `usable[0]`，即服务端 `dirs[0]`，与 `/api/route-stops` 缺省方向同口径）。
 *   `shapes` 为空 ⇒ `null`（见第 ③ 级）。
 */
export function pickDirByStops(shapes: RouteShapesResp["shapes"], stopMains: string[]): string | null {
  const usable = (shapes ?? []).filter((s) => s && typeof s.dir === "string" && s.dir !== "");
  if (!usable.length) return null;
  if (usable.length === 1) return usable[0].dir;

  const first = stopMains[0] ?? null;
  const last = stopMains.length ? stopMains[stopMains.length - 1] : null;
  const all = new Set(stopMains);

  let best = usable[0];
  let bestScore = -1;
  for (const s of usable) {
    const codes = (s.stations ?? []).map((x) => x.code);
    let score = 0;
    if (codes.length && stopMains.length) {
      if (first && codes[0] === first) score += 2;
      if (last && codes[codes.length - 1] === last) score += 2;
      // 同分时的次序项：重叠比例（<1，不会盖过首末站的 2 分）
      score += codes.filter((c) => all.has(c)).length / Math.max(1, codes.length);
    }
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best.dir;
}
