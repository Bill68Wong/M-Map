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
 *
 * ── 阈值（Spec §5 锁定）────────────────────────────────────────────────
 *   · 车辆 stale：**30s**（约束：> 2×`POLL_MS`=24s 且 ≤90s，否则正常抖动会误报）
 *   · 定位 stale：**30s**；精度门 150m（与 `boarding-detect.R2_FIX_MAX_ACC_M` 同口径）
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
