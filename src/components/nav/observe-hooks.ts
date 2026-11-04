"use client";

/**
 * 观测钩子唯一写入口（src/components/nav/observe-hooks.ts，★ v3.7.0 S2 新增）
 *
 * ── 为什么单独一个模块 ────────────────────────────────────────────────
 *   同一批属性会被**两个 hook**（`useUserFix` · `useRideTracking` / `useRouteVehicles`）写，
 *   若各自 `document.body.setAttribute` 就会出现「谁后写谁赢」+ 每帧一次 DOM 写入。
 *   这里集中：① 单点写入；② 值未变不写（模块级 cache）；③ 失败静默（钩子坏了不得影响导航）。
 *
 * ── 契约（`docs/迭代-导航优化-20261102/03-测试-基线测量与场景复现.md` §3.4）──
 *   · `body[data-geo]`      = `ok | low_acc | stale | denied | unavailable | timeout`
 *     （**两个轴必须分开**：这里只管定位，车辆走 `data-veh`；**禁止合成 `data-net`**）
 *   · `body[data-veh]`      = `fresh | stale | failed | open`
 *   · `body[data-veh-age]`  = 距最后一帧**车辆**数据的整数秒（随停更递增、拿到新帧归零）
 *   · `body[data-user-fix]` = `"<ts>,<acc>"` —— **只写时间戳与精度，禁止写经纬度**
 *     （截图 / 共享屏幕 / 录屏都不外泄位置；坐标断言用 `.user-dot` 屏幕位移代替）
 *   · `body[data-you-dot]`  = `"<ts>,<acc>"` —— **交给渲染层的那个坐标**的时刻与精度
 *     （riding 期蓝点走 `youDot`，会冻结；与 `data-user-fix` 相减才能分辨
 *      「定位死了」与「定位活着但渲染层冻住」—— 详见 `setYouDotHook`）
 *
 * ── 阈值（Spec §5 锁定）────────────────────────────────────────────────
 *   · 车辆 stale：**30s**（约束：> 2×`POLL_MS`=24s 且 ≤90s，否则正常抖动会误报）
 *   · 定位 stale：**30s**；精度门 150m（与 `boarding-detect.R2_FIX_MAX_ACC_M` 同口径）
 *
 * ── ★ 需求5（2026-11-03）新增（本模块的第二职责：**新鲜度判定内核**）──────
 *   · `ROUND_TRIP_STALE_MS` / `shouldForceRefresh()` —— 墙钟哨兵阈值与判定（L2）；
 *   · `INFLIGHT_LEASE_MS` / `inflightGate()`        —— 「请求在飞」的租约制自愈门（L3）；
 *   · `registerVehSentinel(fn)`                     —— 把哨兵挂在**本模块既有的 1s 心跳**上。
 *   为什么放这里：这三件事的语义都是「这份观测数据还新鲜吗」，与 `data-veh` 的
 *   `stale` 判定同源同阈值；放这里可以断言「全仓只有一个 1s 定时器」（哨兵**不新建定时器**）。
 */

/** 定位轴状态（契约 6 值；`low_acc` 与 `stale` 正交，同时发生时 `low_acc` 优先） */
export type GeoState = "ok" | "low_acc" | "stale" | "denied" | "unavailable" | "timeout";
/** 车辆轴状态（契约 4 值） */
export type VehState = "fresh" | "stale" | "failed" | "open";

/** 定位「陈旧」阈值（ms）—— 曾拿到 fix 但超此值无新帧 ⇒ `stale` */
export const GEO_STALE_MS = 30_000;
/** 粗精度门（米）—— 超此值 ⇒ `low_acc`（与判定层 `R2_FIX_MAX_ACC_M` 一致） */
export const LOW_ACC_M = 150;
/** 车辆「陈旧」阈值（秒）—— 必须 > 24s（2×POLL_MS）且 ≤ 90s */
export const VEH_STALE_SEC = 30;
/** 车辆年龄心跳间隔（ms）—— 只用于 `data-veh-age` 递增与 stale 判定 */
const VEH_TICK_MS = 1_000;

/** 已写入值（避免每帧 `setAttribute`）；`null` = 该属性当前不存在 */
const written = new Map<string, string | null>();

function write(attr: string, value: string | null): void {
  if (typeof document === "undefined") return;
  if (written.get(attr) === value) return;
  try {
    if (value == null) document.body.removeAttribute(attr);
    else document.body.setAttribute(attr, value);
    written.set(attr, value);
  } catch {
    /* 只读 body / SSR —— 观测钩子失败不得影响导航 */
    written.delete(attr);
  }
}

/* ══════════ 维度 A · 用户定位 ══════════ */

/**
 * 定位轴状态判定（**纯函数**，供 `useUserFix` 与单测共用）。
 *
 * 取值优先级（测试契约）：`low_acc` 与 `stale` **正交**，同时发生时 **`low_acc` 优先**
 * ——「有数据但不准」比「没数据」更该显示精度圈。
 * 从未拿到 fix 时按 `GeolocationPositionError.code` 分档（1 拒权 / 3 超时 / 其余不可用），
 * 这是 AC2.3「三档文案必须互不相同」的数据前提。
 */
export function geoStateOf(
  input: { lastCbTs: number; accuracyM: number; errCode: number | null },
  nowMs: number = Date.now(),
): GeoState {
  if (input.lastCbTs > 0) {
    if (input.accuracyM > LOW_ACC_M) return "low_acc";
    if (nowMs - input.lastCbTs > GEO_STALE_MS) return "stale";
    return "ok";
  }
  if (input.errCode === 1) return "denied";
  if (input.errCode === 3) return "timeout";
  return "unavailable";
}

export function setGeoHook(state: GeoState): void {
  write("data-geo", state);
}

/** `"<ts>,<acc>"`（`ts` 整数 ms、`acc` 取整米）。**不写经纬度。** */
export function setUserFixHook(ts: number, accuracyM: number): void {
  if (!Number.isFinite(ts) || ts <= 0) return;
  const acc = Number.isFinite(accuracyM) ? Math.max(0, Math.round(accuracyM)) : 0;
  write("data-user-fix", `${Math.round(ts)},${acc}`);
}

/* ══════════ 维度 A′ · 导航蓝点（riding 视觉层） ══════════ */

/**
 * `body[data-you-dot]="<ts>,<acc>"` —— **实际交给渲染层的那个坐标**的采样时刻与精度。
 *
 * ── 解决什么（`data-user-fix` 顶不了）────────────────────────────────────
 *   `data-user-fix` 只证明「GPS 通道产出了一帧」。但 riding 期间蓝点渲染读的是
 *   `ride.youDot ?? userFixR.fix`，而 `youDot` 会**冻结**在上一好点
 *   （`useRideTracking` 的 `lastGoodDotRef`：accuracy>150m / 离线路>60m / 无 fix，
 *   `ROUTE_OVERVIEW` 的吸附又是**顶点**最近点，步长实测 ≈33m）。
 *   冻住时「GPS 在前进」与「蓝点不动」可以同时成立 ⇒ 只读 `data-user-fix` 分辨不出来。
 *
 * ── 为什么写 `ts` 而不是 `ageMs`（刻意的，不是笔误）──────────────────────
 *   写 `ageMs` 是**自刷新值**：本钩子只在坐标变化时被调用，通道一停更就不再执行，
 *   界面上会永久停在「最后一次算出的很小 age」⇒ 假绿（本项目「假绿五来源」之一）。
 *   写 `ts` 相反：读数方用 `Date.now() - ts` 自行计算，越停越旧，**无法自我满足**。
 *
 * ── 判读（两钩子相减，唯一正确用法）────────────────────────────────────
 *   · `data-user-fix` 前进 且 `data-you-dot` 落后 **>30s** ⇒ **渲染层冻住**（蓝点在卡，真问题）
 *   · 两者同步前进 ⇒ 渲染层在跟 ⇒ 此时蓝点静止 = 顶点量化 / 等红灯，**正确行为**
 *   · 两者都不前进 ⇒ 定位通道死（查 `data-geo` / `data-user-fix`，是另一套判据）
 *
 * ⚠️ 只写时间戳与精度，**禁止写经纬度**（截图/录屏/共享屏幕不外泄位置）。
 */
export function setYouDotHook(ts: number | null, accuracyM?: number): void {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) {
    write("data-you-dot", null);
    return;
  }
  const acc = typeof accuracyM === "number" && Number.isFinite(accuracyM) ? Math.max(0, Math.round(accuracyM)) : 0;
  write("data-you-dot", `${Math.round(ts)},${acc}`);
}

/* ══════════ 维度 B · 车辆数据 ══════════ */

/** 最后一帧**车辆**数据的到达时刻（ms；0 = 本次会话还没拿到过） */
let lastVehTs = 0;
/**
 * 上一帧的**服务端帧标识**（`fetchedAt`）。只做「是否同一帧」比较 ⇒ **不做跨时钟减法**。
 *
 * 为什么不直接用 `fetchedAt` 当 `lastVehTs`：那要拿服务端时刻减客户端 `Date.now()`，
 * 用户手机时钟偏快/偏慢时会算出负数或几十秒，`data-veh-age` 直接失真。
 * 改用「帧标识是否前进」：两次拿到**同一个 `fetchedAt`** ⇒ 数据没有更新 ⇒ **不重置年龄**
 * （测试 #16 用「接口恒返回同一旧 `fetchedAt`」注入停更时，age 仍会严格递增）。
 */
let lastFrameKey: string | null = null;
/** 最近一次请求是否成功（决定 `fresh` 还是 `failed`） */
let lastOk = false;
/**
 * 熔断窗口截止时刻（ms；0 = 不在熔断）。
 * ★ 为什么用"截止时刻"而不是布尔：`open` **不得一直挂着** —— 熔断窗口过了就自动
 *   降级为 `failed` / `stale`，否则界面会永远宣称"正在熔断"。任何一次成功帧也会清零它。
 */
let circuitUntilMs = 0;
/** 熔断窗口长度（ms）—— 只是兜底上界，真实窗口由触发方决定何时结束 */
const VEH_CIRCUIT_MS = 60_000;
/** 是否已发生过一次请求（没有请求就不写属性，避免启动瞬态被误判） */
let touched = false;
let ticker: number | null = null;
let holders = 0;
/**
 * ★ 需求5 L2：墙钟哨兵回调（由 `useRideTracking` 注册；`null` = 当前没有导航态在跑）。
 *   心跳每次 tick 调一次 —— 本模块只负责「每秒问一次」，判定与补刷入口都在注册方。
 */
let sentinel: (() => void) | null = null;

/** 优先级：熔断 open（窗口内）> 请求失败 failed > 超时未更新 stale > fresh */
function vehStateOf(ageSec: number): VehState {
  if (circuitUntilMs > Date.now()) return "open";
  if (!lastOk) return "failed";
  return ageSec > VEH_STALE_SEC ? "stale" : "fresh";
}

function ageSec(): number {
  return lastVehTs > 0 ? Math.max(0, Math.floor((Date.now() - lastVehTs) / 1000)) : 0;
}

function publishVeh(): void {
  if (!touched) return;
  const age = ageSec();
  write("data-veh-age", String(age));
  write("data-veh", vehStateOf(age));
}

/**
 * 拿到一帧车辆数据（**只有车辆帧可写**；GPS 帧禁止调本函数 —— 见 D5）。
 *
 * @param frameKey 服务端帧标识（`fetchedAt`；缺省 = 视为每帧都是新的）。
 *   与上一帧相同 ⇒ 数据其实没更新 ⇒ **不重置年龄**（这样「停更」能被 `stale` 抓到）。
 */
export function noteVehFrame(frameKey?: string | null): void {
  const key = frameKey ?? null;
  if (key == null || key !== lastFrameKey) {
    lastVehTs = Date.now();
    lastFrameKey = key;
  }
  lastOk = true;
  circuitUntilMs = 0; // ★ 成功帧 ⇒ 立刻退出 `open`（不允许停在熔断态）
  touched = true;
  publishVeh();
}

/**
 * 车辆请求失败。
 * @param circuitOpen `true` ⇒ 置 `open`（熔断中），窗口最长 `VEH_CIRCUIT_MS`；
 *   窗口过后自动降级为 `failed`/`stale`，**不会一直停在 `open`**。
 */
export function noteVehFail(circuitOpen = false): void {
  lastOk = false;
  circuitUntilMs = circuitOpen ? Date.now() + VEH_CIRCUIT_MS : 0;
  touched = true;
  publishVeh();
}

function tickVeh(): void {
  publishVeh();
  /**
   * ★ 需求5 L2（2026-11-03）：**墙钟哨兵**。
   *
   * ── 为什么必须长在心跳里 ─────────────────────────────────────────────
   *   事件矩阵（L1）在两种情况下必然失效：① 某容器连 `resume` 都不发（OEM 省电 / WebView 壳）；
   *   ② 事件迟到 14s（trace 实证）。哨兵是**唯一不依赖任何事件**的一层。
   *   它自己也会被 freeze 冻住 —— 它的价值不是"冻结期间发现"，而是
   *   **解冻后第一次 tick 立刻发现缺口**（判定写「现在 vs 上一帧」，不写「连续 N 次无变化」）。
   *
   * ── 为什么复用本心跳而**不新建定时器** ───────────────────────────────
   *   本心跳本来就每秒跑（`VEH_TICK_MS`），无新增 CPU / 功耗；且它已被导航态持有
   *   （`useRideTracking`）。新增一个 5s 定时器只会多一处需要自己证明"不会泄漏"的地方。
   *
   * ⚠️ **锚点绝不能用 `lastVehTs`**：它只在帧内容变化时才前移（见 `noteVehFrame`），
   *   车没动、`fetchedAt` 不变时它不前进 ⇒ 会把「数据没变」误判成「数据过期」，
   *   每 30s 白刷一次。锚点由注册方（`useRideTracking`）自己持有 —— 那是
   *   `fetchFrame` 里**无条件**写的时间戳（上一次**成功往返**的时刻），与内容无关。
   */
  try {
    sentinel?.();
  } catch {
    /* 哨兵失败不得影响观测心跳与 `data-veh` */
  }
}

/* ══════════ 需求5 · L2 墙钟哨兵 + L3 请求自愈门（判定内核，纯函数） ══════════ */

/**
 * 「距上一次**成功往返**多久算过期」（ms）—— 哨兵阈值。
 *
 * 取值理由：必须 **> 2×`POLL_MS`（24s）**，否则正常轮询的抖动（一次慢请求 + 一次调度）
 * 就会误触发补刷；30s 与观测契约 `VEH_STALE_SEC` 同值，读一个数就能对上「数据已过期」。
 */
export const ROUND_TRIP_STALE_MS = VEH_STALE_SEC * 1_000;

/**
 * 「请求在飞」的租约时长（ms）—— 超时即视为**泄漏**并强制放行。
 *
 * 为什么需要：`inFlight` 布尔在 freeze 场景下会永久 `true` —— `finally` 因整页冻结没执行，
 * 而解冻后第一个到达的补刷请求会被它当场吞掉 ⇒ 之后再无事件 ⇒ 永久冻结。
 * 时间戳口径把「布尔」变成「有期限的租约」，到点自愈。
 * 取 15s：`AbortSignal.timeout(8000)` 会在 8s 结束请求，15s 给了「超时 + 一次重试」的余量。
 */
export const INFLIGHT_LEASE_MS = 15_000;

/**
 * 哨兵判定（纯函数，可单测）。
 *
 * @param lastFrameAt 上一次**成功往返**的时刻（ms）。**`0` = 本次会话从未成功** ⇒ 必须
 *   立即算「过期」，不能因为是 0 就一直等（那等于"从没成功过就永远不重试"）。
 * @param lastKickAt  上一次哨兵补刷的时刻（ms，0 = 还没补刷过）—— 用于抑制风暴。
 * @param debounceMs  两次补刷之间的最小间隔（缺省 2s，与 `RESUME_DEBOUNCE_MS` 同值）。
 * @returns `stale` = 该补刷；`fresh` = 刚往返过；`debounced` = 过期但刚补过（等下一次）。
 */
export function shouldForceRefresh(o: {
  lastFrameAt: number;
  nowMs: number;
  staleMs?: number;
  lastKickAt?: number;
  debounceMs?: number;
}): "stale" | "fresh" | "debounced" {
  const staleMs = o.staleMs ?? ROUND_TRIP_STALE_MS;
  const debounceMs = o.debounceMs ?? 2_000;
  const gap = o.lastFrameAt > 0 ? o.nowMs - o.lastFrameAt : Number.POSITIVE_INFINITY;
  if (gap <= staleMs) return "fresh";
  const kickAt = o.lastKickAt ?? 0;
  if (kickAt > 0 && o.nowMs - kickAt < debounceMs) return "debounced";
  return "stale";
}

/**
 * 请求自愈门（纯函数，可单测）—— 三个轮询 effect 共用同一套语义。
 *
 * @param inflightSince 进入请求的时刻（ms）；**`0` = 空闲**。
 * @returns `blocked` = 仍在租约内，本次调用应放弃；`renewed` = **租约已过期**，
 *   视为泄漏已自愈 —— 调用方应把 `inflightSince` 重置为"现在"并**照常发起请求**。
 */
export function inflightGate(o: {
  inflightSince: number;
  nowMs: number;
  forceMs?: number;
}): { blocked: boolean; renewed: boolean } {
  const forceMs = o.forceMs ?? INFLIGHT_LEASE_MS;
  if (!o.inflightSince) return { blocked: false, renewed: false };
  if (o.nowMs - o.inflightSince < forceMs) return { blocked: true, renewed: false };
  return { blocked: false, renewed: true };
}

/**
 * 注册「墙钟哨兵回调」—— 每次心跳调一次（**每秒**），由注册方自己判断要不要补刷。
 *
 * 为什么让注册方判断而不是本模块判断：锚点（上次成功往返时刻）与补刷入口
 * （`resumeKickRef`，随阶段重建）都在 `useRideTracking` 的闭包里。本模块只负责
 * **"每秒问一次"** 这件事，不持有跨模块的第二份状态（少一份状态 = 少一处失真）。
 *
 * @returns 注销函数（在 `useEffect` 的 cleanup 里调用）
 */
export function registerVehSentinel(fn: () => void): () => void {
  sentinel = fn;
  return () => {
    if (sentinel === fn) sentinel = null;
  };
}

/**
 * 持有「车辆年龄心跳」——引用计数，单例定时器（导航态与线路查看模式可能同时持有）。
 * 最后一个持有者释放时清场（移除属性 + 归零），避免跨场景读到上一轮的值。
 *
 * @returns 释放函数（在 `useEffect` 的 cleanup 里调用）
 */
export function retainVehTicker(): () => void {
  if (typeof window === "undefined") return () => {};
  holders += 1;
  if (ticker == null) ticker = window.setInterval(tickVeh, VEH_TICK_MS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders > 0) return;
    if (ticker != null) {
      window.clearInterval(ticker);
      ticker = null;
    }
    lastVehTs = 0;
    lastFrameKey = null;
    lastOk = false;
    circuitUntilMs = 0;
    touched = false;
    write("data-veh", null);
    write("data-veh-age", null);
  };
}
