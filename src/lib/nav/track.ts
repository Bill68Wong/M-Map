/**
 * 乘车追踪引擎（src/lib/nav/track.ts，2026-09-24 新增）
 *
 * ── 定位（v2.13 导航界面 · 用户实时进度）────────────────────────────────
 *   把「官方班车实时数据」（`/api/route-vehicles`：车牌 / 坐标 / 挂载站 / 状态 / 区间）
 *   翻译成「用户在站序中的进度」：
 *     · `pickBoarding` —— 「我已上车」时从在途车中锁定**用户坐的那辆**；
 *     · `progressOf`   —— 由车辆区间/挂靠站推导「已过到第几站 / 下一站是谁」；
 *     · `cutAt`        —— 把车辆坐标投影到该段乘车 polyline 上，供「已驶过路段变绿」切割。
 *   ★ v3.6.1（需求 7）新增：`anchorOf` / `passedBoardOf` —— 候车阶段按锚点剔除**已过站**的车，
 *     让「候选中没车（错过班次）」能够成立；`rankBoardingVehicles` 以 `opts.filterPassed` 接入
 *     （默认关闭 = 旧行为不变，接线在 `useRideTracking`）。
 *
 * ── 为什么车道数据当主信号（用户拍板 2026-09-24）────────────────────────
 *   官方数据与报站同源（站点级准确）、车牌可稳定锁定、无定位权限门槛；
 *   手机 GPS 仅作后续增强（PWA 锁屏/后台被系统暂停，且隧道/桥上会漂）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   · **client-safe 纯函数**：不 import `pg`、不 import server-only 模块
 *     （`mainCodeOf` 在本文件内联 —— `segment-lookup` 是 server-only，客户端禁引）；
 *   · 一切「找不到 / 对不上」都**如实返回**（unknown/lost），由调用方决定冻结或提示，
 *     **绝不猜测**（呼应「报站数必须符合物理常识」的项目口径）。
 */
import { cumDistM, nearestOnPath, type LL } from "./route-overview";
import type { VehicleProgress } from "./progress";

/** 追踪用的车辆子集（= `/api/route-vehicles` 的 vehicles[] 元素；坐标已 GCJ-02） */
export interface TrackVehicle {
  plate: string;
  lat: number;
  lng: number;
  /** moving | stopping | terminal | unknown | lost */
  status: string;
  /** 行驶区间（status='moving' 时存在）；code 为主码 */
  interval: { from: { code: string }; to: { code: string } } | null;
  /** 挂靠站（status='stopping'/'terminal' 时存在）；code 为主码 */
  atStation: { code: string } | null;
  /** ★ v3.4.0：区间进度（服务端 `?progress=1` 填充；缺省 = 不可算） */
  progress?: VehicleProgress | null;
}

/** 站码归一（剥站台后缀：`T373/1` → `T373`）—— 与全站口径一致 */
export function mainOf(code: string): string {
  return /^[A-Za-z]+\d+/.exec(String(code ?? ""))?.[0] ?? String(code ?? "");
}

/** 进度（相对**本段站序**；下标 0 = 上车站，-1 = 未知） */
export interface TrackProgress {
  /**
   * `at`      = 车停靠在某站（含总站待发）；
   * `between` = 车在某区间行驶中；
   * `unknown` = 数据对不上本段站序（调用方应**冻结**上次进度，不可乱跳）；
   * `lost`    = 本帧无车辆数据。
   */
  kind: "at" | "between" | "unknown" | "lost";
  /** 已**完全驶过**的最后一站下标（-1 = 一站未过）；站条据此把文字变绿 */
  passedIdx: number;
  /** 车当前停靠站下标（kind='at' 时有效） */
  atIdx: number | null;
  /** 下一站下标（kind='between' 时为区间终点站；'at' 时为停靠站的下一站） */
  nextIdx: number | null;
}

const EMPTY_PROGRESS: TrackProgress = { kind: "lost", passedIdx: -1, atIdx: null, nextIdx: null };

/**
 * 由车辆数据推导进度。
 * @param stopMains 本段站序（主码数组，0 = 上车站、末位 = 下车站）
 * @param v         追踪中的车辆（null = 尚未锁定/本帧无数据）
 */
export function progressOf(stopMains: string[], v: TrackVehicle | null): TrackProgress {
  if (!v || !stopMains.length) return EMPTY_PROGRESS;
  const lastIdx = stopMains.length - 1;

  // ① 停靠中（含总站待发）—— 以挂靠站为准
  if (v.atStation?.code) {
    const idx = stopMains.indexOf(mainOf(v.atStation.code));
    if (idx >= 0) {
      return {
        kind: "at",
        passedIdx: idx - 1,
        atIdx: idx,
        nextIdx: idx < lastIdx ? idx + 1 : null,
      };
    }
  }

  // ② 行驶中 —— 以区间为准：已离开 from（= 已驶过 from），驶向 to
  if (v.interval?.from?.code) {
    const fromIdx = stopMains.indexOf(mainOf(v.interval.from.code));
    if (fromIdx >= 0) {
      const toIdx = v.interval.to?.code ? stopMains.indexOf(mainOf(v.interval.to.code)) : -1;
      return {
        kind: "between",
        passedIdx: fromIdx,
        atIdx: null,
        nextIdx: toIdx >= 0 ? toIdx : fromIdx < lastIdx ? fromIdx + 1 : null,
      };
    }
  }

  // ③ 都对不上本段站序（可能尚未到上车站后方 / 数据异常）→ 如实报 unknown
  return { kind: "unknown", passedIdx: -1, atIdx: null, nextIdx: null };
}

/* ══════════════ 剩余时间口径：**基准站**（U3 · 本批新增） ══════════════
 *
 * ── 背景：一次「口径断裂」而非速度假设错误 ─────────────────────────────
 *   客户端上行的 `segProgress.segRemainSec` 是**到下一站**的剩余
 *   （位置模型 `md × h[1−p]`，`progress.ts:237`，`md` 取相邻站对中位时长），
 *   **不是**「到本段下车站」的整段剩余。下游若把它当整段用，就少算了
 *   「下一站之后到下车点」的那几跳 ⇒ 车辆从「站间行驶」切到「进站停靠」时，
 *   载体从「首跳剩余」换成「逐跳累加」，数字会整段**突变**。
 *   ⇒ 剩余必须先定义「以哪一站为基准」，两侧（客户端 / 服务端）用**同一条规则**。
 */

/**
 * **基准站**（pivot）下标 = 剩余时间计算的起算点。纯函数，可单测。
 *
 * 规则（只有两条，不接受第三种解释）：
 *   · `kind === "at"`（车停靠在本段某站）⇒ 基准站 = **所停站 `atIdx`**。
 *     ⚠️ **不是 `atIdx + 1`**：`progressOf` 在停靠态给出的 `nextIdx` 是
 *     「所停站的**下一站**」（见下方 `progressOf` ① 分支）。从那里起累加会
 *     **整跳漏掉「所停站 → 下一站」** —— 车停在 C 站，实际还要 C→D + D→E，
 *     从 D 起算就少算了 C→D（典型 3 分钟）。
 *   · `kind === "between"`（车在区间内）⇒ 基准站 = `nextIdx`（区间终点站），
 *     因为 `segRemainSec` 正是「到该站」的剩余。
 *   · `unknown` / `lost` ⇒ `null` —— 数据对不上本段站序时**如实返回 null**，
 *     由调用方降级（宁可用整段静态分钟，也不猜一个位置）。
 */
export function remainFromIdxOf(prog: TrackProgress | null | undefined): number | null {
  if (!prog || prog.kind === "lost" || prog.kind === "unknown") return null;
  /**
   * ⚠️ `atIdx` 的类型是 `atIdx: number | null`（**必填可空**，不是 `atIdx?:`）：
   *   可空是为了让 `between` / `lost` / `unknown` 三种 `kind` 能表达「无此值」，
   *   而 `progressOf` 的 `at` 分支**恒给 `idx`**（见 `progressOf` ①）。
   *   ⇒ `kind === "at"` 而 `atIdx === null` 是**对象不自洽**（只可能由 `progressOf`
   *     之外的第三个生产者造出来；当前编辑器/测试里都没有这种构造）。
   *   这里**如实返回 null**、不拿 `passedIdx + 1` 去猜（那是同一个数的另一种写法，
   *   但会把"不自洽"掩盖成"正常"，下游就看不到数据出问题了）。
   *   `between` 的 `nextIdx ?? passedIdx + 1` 不一样：`progressOf` 在「区间起点已是末站」
   *   时**真的**会给 `nextIdx: null`，那里的兜底是可达路径，保留。
   */
  if (prog.kind === "at" && prog.atIdx === null) return null;
  const raw = prog.kind === "at" ? prog.atIdx! : (prog.nextIdx ?? prog.passedIdx + 1);
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

/**
 * 到下车还有**几站**（要经过几站才到下车点，0 = 已到站）。
 *
 * ── 为什么不能用「已过站数」算（这是修一个真实 off-by-one 的地方）────────────
 *   `progressOf` 停靠分支给的是 `passedIdx = atIdx − 1`（见上方 `progressOf` ①）。
 *   若统一按 `lastIdx − passedIdx` 算，停靠在第 k 站会得出 `lastIdx − k + 1`，
 *   **比真实剩余站数多 1** ⇒ 车停在下车站时还会显示「还有 1 站下车」，
 *   与同一帧的到站提醒（`prog.atIdx === alightIdx ⇒ alarm="now"`，底栏「即将到达」）自相矛盾。
 *
 * ── 锚站（与「分钟」的基准站**刻意不是同一个**，别合并）──────────────────
 *   数「还要经过几站」要从**当前所在（或刚离开）的站**起算：
 *     · `kind === "at"`      ⇒ 锚站 = `atIdx`（车就停在第 k 站，还剩 `lastIdx − k` 站）；
 *     · `kind === "between"` ⇒ 锚站 = `passedIdx`（= 区间起点站；车正驶向 `passedIdx + 1`，
 *                              那也算「还要经过的一站」，所以不能用区间终点站）。
 *   ⚠️ 而 `remainFromIdxOf`（分钟用）返回的是**区间终点站 `nextIdx`** —— 因为
 *   `segRemainSec` 量的就是「到那一站」的剩余。两者差 1 是**语义必然**：
 *     「还要经过几站」含正在开往的那一站，「到那一站的剩余时间」不含它。
 *   ⇒ **不要**把 `stopsAwayOf` 改成复用 `remainFromIdxOf`：那会让行驶态的站数少 1
 *     （实测：车在 A2→A3 区间、下车站是 A3 时，会写「还有 0 站下车」而不是「还有 1 站」）。
 *
 * @param lastIdx 本段**下车站**的下标（= `stops.length − 1`；< 1 表示站序不足两站）
 * @returns `null` = 站序不足两站 / 进度不可用（`lost`/`unknown`）/ **对象不自洽**
 *          （`kind==="at"` 但 `atIdx` 为 null，见 `remainFromIdxOf` 的同款说明）⇒ 调用方**不显示站数**
 */
export function stopsAwayOf(prog: TrackProgress | null | undefined, lastIdx: number): number | null {
  if (!prog || prog.kind === "lost" || prog.kind === "unknown") return null;
  // `kind === "at"` 时 `atIdx` 必存在（可空只是为了让 other kind 能表达"无此值"）；
  // 真为 null ⇒ 对象不自洽 ⇒ 如实返回 null，**不**拿 `passedIdx + 1` 去猜。
  if (prog.kind === "at" && prog.atIdx === null) return null;
  const rawAnchor = prog.kind === "at" ? prog.atIdx! : prog.passedIdx;
  const anchor = Number(rawAnchor);
  if (!Number.isFinite(anchor) || anchor < 0) return null;
  if (!Number.isFinite(lastIdx) || lastIdx < 1) return null;
  return Math.max(0, Math.trunc(lastIdx) - Math.trunc(anchor));
}

/**
 * 本帧「到基准站」的剩余秒数 = 上行 `/api/nav/remaining` 的 `segRemainSec`。
 *
 * ① 车辆帧**显式**停靠在本段某站（`atStation` 存在且 `status === "stopping"`）⇒ 返回 `0`；
 * ② 否则有位置模型融合值（`RideSegProgress.segRemainSec`）⇒ 原样返回；
 * ③ 都没有 ⇒ `null`（下游回退「从基准站逐跳累加」）。
 *
 * ⚠️ **不得**用「`progress` 字段缺失」推断停靠：`attachProgress` 只给 `status === "moving"`
 *   的车挂 `progress`（`progress.ts:201`），而 `progress` 缺失同时覆盖
 *   「车停靠」「车数据丢了」「几何/里程表缺行」三种完全不同的情况。
 *   拿缺失当停靠 ⇒ 把「丢车」也说成「到站」，剩余被**静默**算成 0（用户看不出错）。
 *   ⇒ 停靠信号只认车辆帧的显式字段，由调用方在本帧上下文里算好传进来。
 */
export function segRemainSecOf(
  /** 本帧是否**明确**停靠在本段站：`!!v.atStation?.code && v.status === "stopping"` */
  stoppedAtStation: boolean,
  /** 客户端融合后的「到下一站」剩余秒（`RideSegProgress.segRemainSec`） */
  fusedSec: number | null | undefined,
): number | null {
  if (stoppedAtStation) return 0;
  if (fusedSec === null || fusedSec === undefined) return null;
  const n = Number(fusedSec);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * ★ v3.6.1（需求 7 · 追踪补漏）：**候车锚**——`start()` 时记下首帧排序第一名的身份与位置。
 *
 * ── 为什么需要 ────────────────────────────────────────────────────────
 *   `rankBoardingVehicles` 只看 `status ∈ {moving, stopping, terminal}` 与「到上车站的几何距离」，
 *   **不过滤已过站的车** ⇒ 两个后果：
 *     ① 用户等的车过站后仍留在候选里 ⇒「候选中没车（错过班次）」这个信号**永不成立**
 *        （`useRideTracking` 只有在 `ranked.length === 0` 时才会提示）；
 *     ② 后车驶来会顶到第一位 ⇒ `switchToRiding(res.plate)` 可能锁到后车。
 *   ⇒ 用**首帧第一名的车牌**做锚，之后按「该车是否已越过上车站 / 距离是否单调增大」判定过站。
 *
 * ── ⚠️ 级别说明（别写错）────────────────────────────────────────────────
 *   `autoBoardOf` 是**定位主导**（R1 车辆信号只降门槛、不触发）⇒ 本改动**不会导致上错车**，
 *   它修的是「**错过班次提示缺失**」+「候选排序失真」。锁牌（`switchToRiding`）只在
 *   `aux.strong && 唯一` 时才发生，且 `aux` 的 strong 判据是「刚从本站开走」——
 *   已过站的车挂靠站不再是本站 ⇒ 不会成为 strong。
 */
export interface BoardAnchor {
  /** 锚定车牌 */
  plate: string;
  /** 锚定时该车距上车站的几何距离（米）；无坐标 ⇒ `null` */
  distM: number | null;
  /** 锚定时该车「还有多久到站」的秒数（`BusArrival.loSec`）；无 ⇒ `null`（仅供诊断/对比） */
  loSec: number | null;
  /** 锚定时刻（ms） */
  atMs: number;
}

/** 锚定时距上车站 ≤ 此值 ⇒ 才承认「我们确实看到它还在上车站附近」 */
export const PASS_ANCHOR_NEAR_M = 150;
/** 之后距离增大超过此值 ⇒ 判「已驶离上车站」（几何判据，需配合锚点距离门） */
export const PASS_MARGIN_M = 120;

/** 车辆到上车站的直线距离（米）；无坐标 ⇒ `null` */
export function distToBoardM(
  v: Pick<TrackVehicle, "lat" | "lng">,
  boardPos?: { lng: number; lat: number } | null,
): number | null {
  if (!boardPos) return null;
  if (!Number.isFinite(v.lat) || !Number.isFinite(v.lng)) return null;
  const dx = (v.lng - boardPos.lng) * 111320 * Math.cos((boardPos.lat * Math.PI) / 180);
  const dy = (v.lat - boardPos.lat) * 111320;
  return Math.hypot(dx, dy);
}

/**
 * 记候车锚：取**当前排序第一名**（停靠本站 > 刚离开本站 > 距站最近）。
 * @returns 无候选 ⇒ `null`（此时无从锚定，调用方应保持 `anchor = null`）
 */
export function anchorOf(
  vehicles: TrackVehicle[],
  boardMain: string,
  boardPos?: { lng: number; lat: number } | null,
  opts?: { loSec?: number | null; nowMs?: number },
): BoardAnchor | null {
  const ranked = rankBoardingVehicles(vehicles, boardMain, boardPos);
  const top = ranked[0];
  if (!top) return null;
  return {
    plate: top.plate,
    distM: distToBoardM(top, boardPos),
    loSec: opts?.loSec ?? null,
    atMs: opts?.nowMs ?? Date.now(),
  };
}

/**
 * 该车是否**已越过上车站**（三条判据，任一成立即可，均为「有证据才判」）。
 *
 * ① **站序判据**（最可靠，需 `stopMains`）：`progressOf` 给出 `atIdx > 0`
 *    （停在第 1 站及以后）或 `between` 且 `passedIdx ≥ 0`（已驶离上车站）。
 * ② **几何判据**（需锚 + 坐标）：锚定时该车**确实在上车站 150m 内**，
 *    而现在距站比锚定时远了 > 120m ⇒ 它在远离上车站（API 已按 `dir` 过滤，
 *    同向车不会「从远处开来又变远」）。
 * ③ 其余一律 `false` —— **宁可留着候选，也不误删**（呼应「找不到就如实返回」）。
 */
export function passedBoardOf(input: {
  vehicle: TrackVehicle;
  /** 本段站序（下标 0 = 上车站）；缺省 ⇒ 退化为几何判据 */
  stopMains?: string[] | null;
  boardPos?: { lng: number; lat: number } | null;
  anchor?: BoardAnchor | null;
}): boolean {
  const { vehicle: v, stopMains, boardPos, anchor } = input;

  // ① 站序判据
  if (stopMains && stopMains.length >= 2) {
    const p = progressOf(stopMains, v);
    if (p.atIdx != null && p.atIdx > 0) return true;
    if (p.kind === "between" && p.passedIdx >= 0) return true;
    if (p.kind === "at" && p.atIdx === 0) return false;
  }

  // ② 几何判据（需锚 + 锚点确实在上车站附近）
  if (anchor && anchor.plate === v.plate && anchor.distM != null && anchor.distM <= PASS_ANCHOR_NEAR_M) {
    const now = distToBoardM(v, boardPos);
    if (now != null && now - anchor.distM > PASS_MARGIN_M) return true;
  }

  // ③ 无证据 ⇒ 不判过站
  return false;
}

/**
 * 「我已上车」候选排序：把在途车按「更可能是用户乘坐的那辆」排序。
 * 打分：停靠**本上车站** > 刚离开本上车站 > 距上车站更近。
 * @param boardPos 上车站坐标（GCJ-02；来自 detail-body legs，缺失时跳过距离项）
 * @param opts     ★ v3.6.1：`filterPassed`（默认 **false** = 保持旧行为）+ 站序/锚点。
 *                 开启后**剔除已越过上车站的车** ⇒ 全部过站时候选为空 ⇒
 *                 调用方能如实提示「候选中没车（错过班次）」（`NOTE_NO_VEHICLES`）。
 */
export function rankBoardingVehicles(
  vehicles: TrackVehicle[],
  boardMain: string,
  boardPos?: { lng: number; lat: number } | null,
  opts?: {
    filterPassed?: boolean;
    stopMains?: string[] | null;
    anchor?: BoardAnchor | null;
  },
): TrackVehicle[] {
  const board = mainOf(boardMain);
  const score = (v: TrackVehicle): number => {
    if (v.atStation?.code && mainOf(v.atStation.code) === board) return 0;
    if (v.interval?.from?.code && mainOf(v.interval.from.code) === board) return 1;
    if (boardPos) {
      const dx = (v.lng - boardPos.lng) * 111320 * Math.cos((boardPos.lat * Math.PI) / 180);
      const dy = (v.lat - boardPos.lat) * 111320;
      return 2 + Math.hypot(dx, dy) / 100000; // 距离作次级项（除大数，不改变分组序）
    }
    return 3;
  };
  return [...vehicles]
    .filter((v) => v.status === "moving" || v.status === "stopping" || v.status === "terminal")
    .filter(
      (v) =>
        !opts?.filterPassed ||
        !passedBoardOf({
          vehicle: v,
          stopMains: opts.stopMains,
          boardPos,
          anchor: opts.anchor,
        }),
    )
    .sort((a, b) => score(a) - score(b));
}

/**
 * 把「当前位置」投影到乘车段 polyline（GCJ-02）的**最近顶点**。
 * 供两种用途：① 已驶过路段切割（`slice(0, idx+1)`）② 判断投影是否可信（`dist` ≤ 容差才切线）。
 */
export function cutAt(poly: LL[], pos: { lng: number; lat: number }): { idx: number; dist: number } {
  if (!poly.length) return { idx: -1, dist: Number.POSITIVE_INFINITY };
  const r = nearestOnPath(poly, pos);
  return { idx: r.idx, dist: r.distM };
}

/**
 * 投影可信容差（米）：超过则**冻结**上次进度（隧道/漂移时宁可不更新，不画错）。
 *
 * ⚠️ 本常量**当前无消费者**（灰线已改用 `monotonicCut` 的 60m 门）。
 *    anomaly 判定另有硬编码 250（`src/lib/nav/boarding-detect.ts:473`），
 *    **两者语义尚未统一**；统一属独立改造，勿顺手合并。
 */
export const CUT_TOLERANCE_M = 250;

/* ══════════════════ 已驶过灰线：**单调游标**（T7 · 2026-10-30） ══════════════════
 *
 * ── 为什么需要（现场症状的根因，见调查结论）────────────────────────────────
 *   `nearestOnPath` 是「最近**顶点**」且对**整条** `colored` 线性扫描，**没有任何
 *   "沿里程单调"约束**。澳门多条线路往返同路 / 环线 / 掉头 / 绕转盘 ⇒ 折线在空间上
 *   **折回自己**（实测责任重合段的空间间距仅 0~40m，沿线却相隔数百米到十几公里）。
 *   GPS 落在两遍之间时，`idx` 就在两遍之间**任意跳**：
 *     · 跳到**近**的一遍 ⇒ 灰线从几公里**缩成几十米**（= 「蓝点旁一小撇」）；
 *     · 跳到**远**的一遍 ⇒ 灰线**多画几公里**。
 *   ⚠️ 关键：那两遍空间上只差几十米 ⇒ **蓝点看着完全正常**，用户只能看到"线不对"。
 *
 * ── 判据（顺序即优先级，任一不过 → **冻结**上一帧，绝不清空）────────────────
 *   ① 横向：**真垂距** `perpDistM(...) > TRAVELED_SNAP_MAX_M` → `bad-snap`
 *      ★ 与蓝点吸附门（`youDot` 的 60m）**同源** —— 两套容差（60 vs 250）
 *        作用在同一投影上，正是"蓝点飞到线外、灰线照画"缺口的来源；
 *      ★★ **绝不能用 `cut.dist`**（到最近顶点的距离）：顶点间距中位 19.4m / p90 71.9m，
 *        段中点时该值会**系统性高估**真垂距（实测中位 1.3m、p90 16.5m、p99 68.6m，
 *        `> 2×真垂距+3m` 占 12.3%）⇒ 拿它当 60m 门会**误拒 12% 的合法帧**，
 *        把「灰线画错」换成「灰线老是卡住」。`cut.dist` 只作 `reason` 的诊断量，不判 accept。
 *   ② 回退：`idx < prev.idx - TRAVELED_BACK_IDX` → `backward`
 *      ★ **长间隔放行**（`> TRAVELED_STALE_MS` 与 ④ 成对豁免）—— 切后台 2 分钟 /
 *        车已掉头时若照判回退，灰线会**永久冻死**；
 *   ③ 增速：沿线上行 ≤ `MAX_SPEED_MPS × elapsed + 120` → 否则 `too-fast`；
 *   ④ 不缩短：`lenM < prev.lenM - 1` → `shrink`（「缩成一小撇」的最后一道闸）。
 */

/** 「已驶过灰线」游标（跨帧记忆；纯数据，不含 DOM / 不含 React） */
export interface MonoCutState {
  /** 上一帧采纳的顶点下标 */
  idx: number;
  /** 上一帧采纳的「已驶过沿线里程」（米；= `pathLenM(poly.slice(0, idx+1))`） */
  lenM: number;
  /** 采纳时刻（ms）——拒帧**不更新**，让 `elapsed` 持续累积（否则 too-fast 永不解除） */
  ts: number;
}

export type MonoCutReason = "first" | "ok" | "bad-snap" | "backward" | "too-fast" | "shrink";

export interface MonoCutResult {
  /** 采纳后的下标（拒帧时为 `prev.idx`；首帧拒帧为 -1） */
  idx: number;
  /** 采纳后的已驶过里程（米；拒帧时为 `prev.lenM`） */
  lenM: number;
  accept: boolean;
  reason: MonoCutReason;
  /**
   * 诊断量（**不参与 accept/reject**）：
   *   · `verPerp` = 真垂距（判定实际用的就是这个）；
   *   · `verVertex` = `cutAt` 的「到最近顶点距离」（量化高估值，留作 QA 对比量化误差）；
   *   · `projIdx` / `projLenM` = **被拒时**本帧投影本来会落到的位置
   *     （`idx`/`lenM` 在拒帧时返回 `prev`，看不出真实投影在哪 —— QA 判「定位偏了 vs 算法判错了」
   *      必须靠这两个量；accept 时与 `idx`/`lenM` 相等）。
   */
  diag: { verPerp: number; verVertex: number; projIdx: number; projLenM: number };
}

/**
 * 灰线横向吸附门（米）——**与蓝点 `YOU_SNAP_MAX_M` 同值**。
 * ⚠️ 不是 `CUT_TOLERANCE_M(250)`：250 是「这个定位可信吗」的语义（anomaly 判定仍用它），
 *    而「能不能据此画已驶过路段」必须和蓝点一样严，否则两者会分离出缺口。
 */
export const TRAVELED_SNAP_MAX_M = 60;
/** 沿线上行速度上限（m/s）——澳门公交最高远低于 20（= 72km/h），留足余量 */
export const TRAVELED_MAX_SPEED_MPS = 20;
/** 长间隔放行阈值（ms）——超过则**成对豁免**回退与不缩短（切后台 / 掉头后不冻死） */
export const TRAVELED_STALE_MS = 60_000;
/** 回退容忍格数（抖动）；超过即判投影跳变 */
export const TRAVELED_BACK_IDX = 2;
/** 长度缩短容忍（米）；超过即判投影跳变 */
export const TRAVELED_SHRINK_EPS_M = 1;

/**
 * 点到折线第 `idx` 号顶点相邻两段（`idx-1→idx`、`idx→idx+1`）的**真实垂距**（米），取较小者。
 *
 * ── 为什么不能拿 `nearestOnPath().distM` 代替（本项目的关键坑）──────────────
 *   `nearestOnPath` 返回的是「到最近**顶点**」的距离，**不是**到线段的垂距。
 *   GPS 落在两顶点中间时，该值 = √(垂距² + 半段长²) ⇒ **系统性偏大**
 *   （顶点间距中位 19.4m / p90 71.9m）。实测：真垂距 25m 的点在段中点会被算成 ~55m。
 *   ⇒ 任何「这个定位离线多近」的门槛都必须用本函数，否则量化误差会吃掉容差。
 *
 * ── 实现口径 ────────────────────────────────────────────────────────────
 *   · 局部平面近似与 `distM` 完全一致（`dLat·111320`、`dLng·111320·cos(lat)`）；
 *   · 只查 `idx` 相邻两段：`nearestOnPath` 已保证 `idx` 是本折线上最近的顶点，
 *     真实垂足**必然**落在这两段内（否则那个端点就不是最近顶点）；
 *   · 端点退化（`idx` 为首/末顶点，只有一段）时只算存在的那一段；
 *   · 段长为 0（重复顶点）⇒ 退化为点距；`poly` 空 / `idx` 越界 ⇒ `Infinity`。
 */
export function perpDistM(poly: LL[], idx: number, p: { lng: number; lat: number }): number {
  if (!poly.length || idx < 0 || idx >= poly.length) return Number.POSITIVE_INFINITY;
  const latMid = ((poly[idx][1] + p.lat) / 2) * (Math.PI / 180);
  const kx = 111320 * Math.cos(latMid);
  const ky = 111320;
  const px = p.lng * kx;
  const py = p.lat * ky;

  /** 点到单段的垂距（垂足超出段内 ⇒ 退化为到近端距离） */
  const segDist = (ai: number, bi: number): number => {
    const ax = poly[ai][0] * kx;
    const ay = poly[ai][1] * ky;
    const bx = poly[bi][0] * kx;
    const by = poly[bi][1] * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    if (!(l2 > 0)) return Math.hypot(px - ax, py - ay); // 重复顶点
    let t = ((px - ax) * dx + (py - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  let best = Number.POSITIVE_INFINITY;
  if (idx > 0) best = Math.min(best, segDist(idx - 1, idx));
  if (idx + 1 < poly.length) best = Math.min(best, segDist(idx, idx + 1));
  return best === Number.POSITIVE_INFINITY ? segDist(idx, idx) : best;
}

/**
 * 单调游标切割（纯函数）。
 * @param poly 乘车段彩段（GCJ-02，`colored`）
 * @param pos  本帧原始定位（GCJ-02）
 * @param prev 上一帧**采纳**的游标（null = 首帧）
 * @param now  本帧时刻（ms）
 */
export function monotonicCut(
  poly: LL[],
  pos: { lng: number; lat: number },
  prev: MonoCutState | null,
  now: number,
): MonoCutResult {
  const cut = cutAt(poly, pos);
  const cum = cumDistM(poly);
  /** 截至第 i 顶点的沿线里程（越界 → 0） */
  const lenAt = (i: number): number => (i >= 0 && i < cum.length ? cum[i] : 0);
  /**
   * ★ 横向判定用 **真垂距**，不用 `cut.dist`（到最近顶点的距离）。
   *   理由见本段顶部 ★★ 与 `perpDistM` 的 JSDoc：顶点量化会让 `cut.dist` 系统性高估
   *   （段中点真垂距 25m → `cut.dist` ≈ 55m），拿它当 60m 门会误拒约 12% 的合法帧。
   */
  const perp = perpDistM(poly, cut.idx, pos);
  const snapOk = cut.idx >= 0 && perp <= TRAVELED_SNAP_MAX_M;
  const diag = {
    verPerp: perp,
    verVertex: cut.dist,
    projIdx: cut.idx,
    projLenM: lenAt(cut.idx),
  };

  // ① 首帧：没有任何历史可对照 ⇒ 只判横向
  if (!prev) {
    return snapOk
      ? { idx: cut.idx, lenM: lenAt(cut.idx), accept: true, reason: "first", diag }
      : { idx: -1, lenM: 0, accept: false, reason: "first", diag };
  }

  // ② 横向（与蓝点同门；真垂距）
  if (!snapOk) return { idx: prev.idx, lenM: prev.lenM, accept: false, reason: "bad-snap", diag };

  const deltaMs = Math.max(0, now - prev.ts);
  const elapsed = deltaMs / 1000;
  /**
   * ★ 长间隔 ⇒ **同时豁免「回退」（③）与「不缩短」（④）**。
   *   ⚠️ 必须**成对**豁免，这不是可选优化：`cum` 单调递增 ⇒
   *      `idx` 回退 **⟺** `lenM` 变小（数学等价）。
   *      只豁免 ③ 而不豁免 ④ ⇒ 第 ④ 步会在同一帧立刻把它拦回来 ⇒
   *      "跨帧放行"**形同虚设**，用户切后台 2 分钟 / 车已掉头后灰线**永久冻死**。
   *   代价：恢复的那一帧灰线可能变短一次。但此时中间已经 60s+ 没有帧，
   *        用户看不到"连续缩短"的过程，而"永久冻死"是不可恢复的错误 —— 取后者。
   */
  const stale = deltaMs > TRAVELED_STALE_MS;

  // ③ 回退 —— **长间隔放行**（否则切后台 / 掉头后永久冻死）
  if (!stale && cut.idx < prev.idx - TRAVELED_BACK_IDX) {
    return { idx: prev.idx, lenM: prev.lenM, accept: false, reason: "backward", diag };
  }

  // 增速：沿线上行米数（= `pathLenM(poly.slice(prev.idx, cut.idx+1))`，累积里程差等价且无切片分配）
  const upM = cut.idx > prev.idx ? cum[cut.idx] - cum[prev.idx] : 0;
  if (upM > TRAVELED_MAX_SPEED_MPS * elapsed + 120) {
    return { idx: prev.idx, lenM: prev.lenM, accept: false, reason: "too-fast", diag };
  }

  // ④ 不缩短 —— 「缩成一小撇」的最后一道闸（换腿后游标残留 / 几何变更都会在此被拦）
  const lenM = lenAt(cut.idx);
  if (!stale && lenM < prev.lenM - TRAVELED_SHRINK_EPS_M) {
    return { idx: prev.idx, lenM: prev.lenM, accept: false, reason: "shrink", diag };
  }

  return { idx: cut.idx, lenM, accept: true, reason: "ok", diag };
}

/**
 * ★ 本批（需求⑤ / AC-43/44）：**段内位置比** `frac ∈ [0,1]`（纯函数，`07 §d.2`）。
 *
 * 用途：把「用户沿线里程 `dNow`」在「第 `i0` 站 → 第 `i1` 站」区间内插值 ⇒ 纵条骑线浮标
 *   `youAt.frac`（**仅视觉插值**，不参与 `passedIdx/atIdx/nextIdx` 判定）。
 * · `cum` 为 `cumDistM(colored)` 累积里程（与顶点等长）；
 * · `i0 < 0` / `i1 <= i0` / 区间零长（两站重合）⇒ 恒 0（点贴站）；
 * · 越界在函数内 clamp（`07 §d.4`）。
 */
export function fracBetween(cum: number[], i0: number, i1: number, dNow: number): number {
  if (i0 < 0 || i1 <= i0) return 0;
  const a = cum[i0];
  const b = cum[i1];
  if (!(b > a)) return 0;
  return Math.max(0, Math.min(1, (dNow - a) / (b - a)));
}

/**
 * 「快/慢多少分」文案口径（下车提醒与换乘行共用）：
 * 负 = 更快（「快 N 分」）、正 = 更慢（「慢 N 分」）、0 = 「时长相当」。
 */
export function fmtDelta(deltaMin: number): string {
  const d = Math.round(deltaMin);
  if (d < 0) return `快 ${-d} 分`;
  if (d > 0) return `慢 ${d} 分`;
  return "时长相当";
}
