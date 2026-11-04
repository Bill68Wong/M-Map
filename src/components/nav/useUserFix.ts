"use client";

/**
 * 用户实时定位通道（src/components/nav/useUserFix.ts，2026-11-04 · v3.12 · 07 §2）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   `navigator.geolocation.watchPosition` → **WGS84 → GCJ-02** → 节流为 `userFix` 序列；
 *   驱动地图蓝点、走向车站距离、上车判定 R2、安全网佐证（**不参与站序进度**）。
 *
 * ── 关键实现要点 ──────────────────────────────────────────────────────
 *   · **节流**：回调到达时若 `ts - lastAccept < intervalMs` 则暂存 `pending`；
 *     到达阈值时采纳（尾帧不丢、又不高频 setState）；
 *   · `intervalMs` 经 ref 读取 ⇒ **不重订阅** watchPosition（重订阅会丢监听 + 二次权限）；
 *   · ★ v3.2.0（AC-79）：`maximumAge`（默认 **0**）经 ref 读取 —— 导航态只用新鲜坐标；
 *   · **权限申请＝用户手势**：由调用方在「开始导航」onClick 内调用 `start()`；
 *     （★ 例外见下方 v3.12 §3：**已授权**时不申请权限、只复用授权，不会弹框）
 *   · 页面隐藏 → `clearWatch`；可见 → **重建订阅 + 主动探测**（★ v3.12 改写，见下）；
 *   · 卸载 → `clearWatch` 兜底。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★ v3.12（2026-11-04）「切后台回前台，用户位置卡住不动」修复
 * ══════════════════════════════════════════════════════════════════════
 *
 * ── 1. 根因：**「订阅已死」有两种形态，旧实现只覆盖了一种** ──────────────
 *   设 `S = startedRef`、`W = watchRef`、`P = permDeniedRef`。旧代码里能建立订阅的
 *   入口只有 5 个：`start()` / `visibilitychange→visible` / `pageshow(persisted)` /
 *   看门狗 / `coarse` 切换。于是有两个**永久死锁**可达状态：
 *
 *   ① **`S=true, W=null`（句柄已清但没人重建）**
 *      `hidden` 分支执行 `stopWatch()` ⇒ `W=null`。若此时**收不到 `visible`**，
 *      看门狗第一行 `if (!startedRef.current || watchRef.current == null) return;`
 *      ⇒ **每一拍都直接 return**，永远不重建 ⇒ 永久无订阅。
 *      （本仓 `observe-hooks.ts:183-187` 自己就写了「某容器连 resume 都不发（OEM 省电 /
 *        WebView 壳）」「事件迟到 14s（trace 实证）」—— 这不是假想场景。）
 *
 *   ② **`S=true, W≠null`（句柄在、订阅死）+ 刚被 `resume()` 重置过基准**
 *      `resume()` 把 `dogBaseRef` 设为 now ⇒ 看门狗的 `base` 被刷新 ⇒ 必须**再等满
 *      `WATCH_IDLE_MS=20s`** 才救场。而 `doWatch()` 的 `if (watchRef.current != null) return;`
 *      又让任何"想重建"的调用方**直接空转返回**。⇒ 用户感受＝回来 20 秒不动。
 *
 *   ③ 附带：`P=true`（曾报 code 1）时看门狗 `return`，而 `P` **只有 `resume()` 会清**
 *      ⇒ 用户去系统设置里打开定位后，若那一次 `visible` 也丢了，永远不再重试。
 *
 * ── 2. 修法：用**结构**消灭复发路径（不是加注释提醒）────────────────────
 *   · **唯一订阅入口** `subscribe()`：函数体第一句就是 `stopWatch()` ⇒ **幂等**，
 *     调用一次＝"保证恰好一条活订阅"，彻底删掉 `if (watchRef != null) return` 这个
 *     「以为还活着」的猜测。所有恢复路径都调它，没有第二条创建订阅的代码。
 *   · **唯一采纳入口** `accept(pos)`：`watchPosition` 回调与 `getCurrentPosition` 探针
 *     **共用**同一段 `WGS84→GCJ-02`（★ **只转一次**）+ 同一段节流 ⇒ 新增数据源
 *     不可能引入二次转换。
 *   · **三层恢复**，从"贵"到"便宜"：
 *       ① `resume(reason)`（可见性/pageshow/focus）：**无条件重建订阅 + 立刻探针**；
 *       ② `nudge(reason)`（online / pointerdown / touchstart）：**只探针**，不拆订阅；
 *       ③ 2s 巡检（原 2s flush + 5s 看门狗合并）：由纯函数 `geoRecoveryOf()`
 *          判断 `subscribe / rebuild / none` —— **句柄为 null 也要重建**（旧实现的最大漏洞）。
 *   · **事件矩阵补齐**：`visibilitychange` · `pageshow`（★ **不再要求 `persisted`**）·
 *     `window.focus` · `online` · `pointerdown`/`touchstart`（用户碰到页面＝铁证在前台，
 *     专治"`visibilityState` 卡在 hidden、事件全丢"的 WebView 壳）。
 *
 * ── 3. `enabled` 语义修复（★ 行为变更，已回报）────────────────────────
 *   旧版 `enabled=true` **只阻止停止，从不建立订阅** ⇒ 不调 `start()` 的调用方
 *   （如 `FavoritesClient`）拿不到任何定位。新增 `AUTO_ARM_IF_GRANTED`：
 *   `navigator.permissions.query({name:'geolocation'})==='granted'` 时才自动订阅 ——
 *   **已授权 ⇒ 不会弹权限框**，仍然遵守「申请权限必须用户手势」的铁律。
 *   iOS Safari 的 Permissions API 不支持 geolocation ⇒ query reject ⇒ 本路径 no-op（行为不变）。
 *
 * ── 4. 恢复速度目标（写进代码，便于以后回归比较）────────────────────────
 *   · 回前台 → **≤3s 内出现新帧**（探针 `getCurrentPosition` 常见 0.2~1.5s 返回）；
 *   · 探针没回 ⇒ 2s 巡检判 `rebuild`，最坏 **≤12s+2s** 兜底（旧实现 20s 起）；
 *   · 硬件冷启动（GPS 重锁）是物理下限，本 hook **不再人为叠加 20s 盲区**。
 *
 * ── 5. 安全红线 ────────────────────────────────────────────────────────
 *   `body[data-user-fix]="ts,acc"` 只写时间戳与精度，**禁止写经纬度**（截图/录屏不外泄）。
 * ⚠️ 坐标铁律：GPS 返回 WGS84 必须转 GCJ-02；**禁止**与 `AMap.Geolocation`（已 GCJ-02）混用。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { wgs84ToGcj02 } from "@/lib/amap/coord";
import { geoStateOf, setGeoHook, setUserFixHook, type GeoState } from "./observe-hooks";

/** 用户实时定位（GCJ-02；已由 wgs84ToGcj02 转换） */
export interface UserFix {
  lng: number;
  lat: number;
  /** 水平精度（米） */
  accuracy: number;
  /** 采样时刻（设备时钟 ms） */
  ts: number;
}

export interface UseUserFixResult {
  fix: UserFix | null;
  /** 定位不可用（拒权 / 超时 / 失败）—— 供降级链读取 */
  denied: boolean;
  /**
   * ★ v3.7.0：距最后一次**成功回调**的毫秒数（0 = 还没拿到过）。
   *   供 UI 判断「位置可能已过期」。为不拖累宿主重渲染，按 **5s 粒度**更新
   *   （30s 陈旧判定不受影响），且不新增逐秒定时器 —— 挂在既有的 2s 尾帧 flush 上。
   */
  ageMs: number;
  /** ★ v3.7.0：定位轴状态（= `body[data-geo]` 的取值，见 `observe-hooks.ts`） */
  geo: GeoState;
  /** 在用户手势内调用：申请权限并开始订阅 */
  start: () => void;
  stop: () => void;
}

/**
 * 巡检节拍（ms）—— ★ v3.12：与既有 2s 尾帧 flush **合用一个定时器**
 * （原为 flush 2s + 看门狗 5s 两条）。全局定时器更少，且判据只有一处。
 */
const TICK_MS = 2_000;
/**
 * 稳态判「监听假死」的空窗阈值（ms）。
 * ★ v3.12：**20_000 → 12_000**。20s 是用户可感知的"卡住"（原 Spec §5 取值）；
 *   12s 仍 > 2×riding 采样（3s）+ 一次 `timeout:10s` 的余量，不会误判。
 */
const WATCH_IDLE_MS = 12_000;
/**
 * 主动探测（`getCurrentPosition`）的 `timeout`（ms）。
 * 必须远小于 watch 的 `timeout: 10_000`：回前台要**尽快有结论**（成或败），
 * 而不是再等 10s。取 1.5s 是为了「有缓存定位时秒回、无缓存时立刻失败交给 watch」。
 */
const PROBE_TIMEOUT_MS = 1_500;
/**
 * 两次「拆了重建」之间的最小间隔（ms）—— 防重建风暴。
 * 若某机型 `watchPosition` 本身就是坏的，巡检每 2s 一拍会在 12s 后才重建，
 * 这个 3s 门只是给「事件连发」（focus+visible+pageshow 同帧触发）兜底。
 */
const MIN_REBUILD_GAP_MS = 3_000;
/**
 * 判「订阅还健康」的空窗（ms）—— 仅用于「用户点了页面」(nudge) 是否值得探针。
 * 取 4s：> 最大采样间隔里的 riding 1.5s，又 < 用户可感知的"卡住"。
 */
const HEALTHY_MS = 4_000;
/**
 * 回前台时「同一次返回」的去重窗口（ms）。
 * 一次返回常**同时**触发 `focus` + `visibilitychange` + `pageshow`（同帧或相隔几十 ms），
 * 若三次都拆订阅，会把正在进行的 GPS 冷启动打断 3 次（clearWatch 会丢弃未完成的首帧）。
 * 500ms 内的重复 `resume()` 只补一次探针，不再拆重建。
 */
const RESUME_DEDUPE_MS = 500;
/**
 * 粗定位的 `maximumAge`（ms）。
 * 候车期允许复用 30s 内的系统缓存坐标（快出点、省电）；乘车期不得复用（会跳）。
 */
const COARSE_MAX_AGE_MS = 30_000;
/**
 * ★ v3.12：已授权时是否自动建立订阅（见文件头 §3）。
 * 置 `false` 即完全退回旧行为（只由 `start()` 建立订阅）。
 */
const AUTO_ARM_IF_GRANTED = true;

/** 2s 巡检的动作（纯函数产出，见 `geoRecoveryOf`） */
export type GeoRecoveryPlan = "none" | "subscribe" | "rebuild";

/**
 * ★ v3.12：**定位订阅自愈判定**（纯函数，供 2s 巡检与单测共用）。
 *
 * 为什么必须是纯函数：这三个分支的正确性决定了「回前台到底能不能恢复」，
 * 而它以前以 `if (watchRef.current == null) return;` 的形式写在定时器回调里，
 * **无法被任何测试触达**（只能真机人肉测）—— 于是 bug 活了两个版本。
 *
 * 判定顺序（每一句都对应一个曾经的真实故障）：
 *   1. `!started` ⇒ 没被要求定位（调用方还没 `start()`），什么都不做；
 *   2. `permDenied` ⇒ 明确拒权：重订阅只会再报一次错（等 `resume()` 清标记）；
 *   3. **句柄为 null**：
 *      · 前台 ⇒ `subscribe`（★ 旧实现在这里 `return`，正是永久死锁的根因）；
 *      · 后台 ⇒ `none`（后台定位被浏览器禁掉，重订阅只烧电；回到前台时有 5 条事件兜底）；
 *   4. 句柄在 ⇒ 看「最后一帧 / 上次订阅」的较晚者，超过阈值即 `rebuild`（拆了重订）。
 *
 * @param sinceRebuildMs 距上次「重建订阅」的毫秒数（`-1` = 本次会话从未重建）
 * @param lastCbTs      最后一次**成功回调**时刻（0 = 从未成功）
 * @param dogBaseTs     最后一次**建立订阅**时刻（0 = 从未订阅）
 * @param visible       `document.visibilityState === "visible"`
 * @param activityProven 是否有"用户刚碰了页面"的铁证（pointerdown / focus / online）
 */
export function geoRecoveryOf(o: {
  nowMs: number;
  started: boolean;
  hasWatch: boolean;
  permDenied: boolean;
  sinceRebuildMs: number;
  lastCbTs: number;
  dogBaseTs: number;
  visible: boolean;
  activityProven: boolean;
  idleMs?: number;
}): GeoRecoveryPlan {
  if (!o.started || o.permDenied) return "none";
  const fg = o.visible || o.activityProven;
  if (!o.hasWatch) return fg ? "subscribe" : "none";
  if (o.sinceRebuildMs >= 0 && o.sinceRebuildMs < MIN_REBUILD_GAP_MS) return "none";
  const anchor = Math.max(o.lastCbTs, o.dogBaseTs);
  const idle = anchor > 0 ? o.nowMs - anchor : Number.POSITIVE_INFINITY;
  return idle > (o.idleMs ?? WATCH_IDLE_MS) ? "rebuild" : "none";
}

export function useUserFix(opts: {
  enabled: boolean;
  intervalMs: number;
  /**
   * ★ v3.2.0（AC-79）：`watchPosition` 的 `maximumAge`（ms）。
   *   默认 **0** = 只用新鲜坐标（导航中避免陈旧坐标导致读数跳变）；浏览态可放宽。
   */
  maximumAge?: number;
  /**
   * ★ v3.7.0 S2：候车期**粗定位**（`maximumAge=30s` + 关闭高精度）。
   *   `false`（缺省）= 维持既有行为（`maximumAge=0` + 高精度）⇒ **riding 必须走 false**。
   *   ⚠️ 切换会重建订阅（`watchPosition` 的 options 只在订阅时生效）；
   *   已授权状态下 `clearWatch` + 再 `watchPosition` **不会**重弹权限框。
   */
  coarse?: boolean;
}): UseUserFixResult {
  const { enabled, intervalMs, maximumAge = 0, coarse = false } = opts;
  const [fix, setFix] = useState<UserFix | null>(null);
  const [denied, setDenied] = useState(false);
  const [ageMs, setAgeMs] = useState(0);
  const [geo, setGeo] = useState<GeoState>("unavailable");

  const watchRef = useRef<number | null>(null);
  const lastAcceptRef = useRef(0);
  const pendingRef = useRef<UserFix | null>(null);
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;
  const maxAgeRef = useRef(maximumAge);
  maxAgeRef.current = maximumAge;
  const coarseRef = useRef(coarse);
  coarseRef.current = coarse;
  const startedRef = useRef(false);
  /** 最后一次**成功回调**的时刻（ms）—— `ageMs` / `stale` 的唯一基准，绝不因重订阅而前移 */
  const lastCbRef = useRef(0);
  /** 最后一次**建立订阅**的时刻（ms）—— 巡检基准之一（另一是 `lastCbRef`） */
  const dogBaseRef = useRef(0);
  /** 最后一次**拆了重建**的时刻（ms；0 = 从未）—— 防重建风暴（巡检判据） */
  const lastRebuildAtRef = useRef(0);
  /** 最后一次**回前台恢复**的时刻（ms；0 = 本次会话还没回来过）—— 只用于同一次返回的事件去重 */
  const lastResumeAtRef = useRef(0);
  /** 最后一帧精度（米）—— 只管 `low_acc` 判定，不参与渲染 */
  const accRef = useRef(0);
  /** 最近一次 `GeolocationPositionError.code`（1 拒权 / 2 不可用 / 3 超时） */
  const errCodeRef = useRef<number | null>(null);
  /** 用户明确拒权 ⇒ 巡检不再重订阅（重订阅只会立刻再报一次错） */
  const permDeniedRef = useRef(false);
  /** `ageMs` 的 5s 分桶（值未变不 setState） */
  const ageBucketRef = useRef(-1);
  /** 已生效的 `coarse`（用于只在切换时重建订阅） */
  const appliedCoarseRef = useRef(coarse);

  /**
   * 定位轴状态：`low_acc` 与 `stale` 正交，同时发生时 **`low_acc` 优先**（测试契约）。
   * 判定本身是纯函数（`observe-hooks.geoStateOf`），本处只喂 ref 值。
   */
  const geoOf = useCallback(
    (): GeoState =>
      geoStateOf({ lastCbTs: lastCbRef.current, accuracyM: accRef.current, errCode: errCodeRef.current }),
    [],
  );

  /** 把 `ageMs` / `geo` 同步出去（含 body 钩子）。由 2s 巡检与错误回调调用。 */
  const publish = useCallback(() => {
    const age = lastCbRef.current > 0 ? Date.now() - lastCbRef.current : 0;
    const bucket = Math.floor(age / 5_000);
    if (bucket !== ageBucketRef.current) {
      ageBucketRef.current = bucket;
      setAgeMs(age);
    }
    const g = geoOf();
    setGeo((cur) => (cur === g ? cur : g));
    setGeoHook(g);
  }, [geoOf]);

  const stopWatch = useCallback(() => {
    if (watchRef.current != null) {
      try {
        navigator.geolocation.clearWatch(watchRef.current);
      } catch {
        /* ignore */
      }
      watchRef.current = null;
    }
  }, []);

  /**
   * ★ v3.12：**唯一的坐标采纳入口**（watch 回调 + 探针共用）。
   *
   * ⚠️ 这里是全仓唯一 `wgs84ToGcj02` 调用点 ⇒ **坐标只转一次**这条铁律靠结构保证，
   *    而不是靠"新增数据源时记得别转第二次"。
   * ⚠️ `ts` 用**采纳时刻**（本机时钟），不用 `pos.timestamp` —— 与 `ageMs`/`stale`
   *    同源，避免两次不同基准的减法（设备时钟与浏览器时钟可能不同步）。
   */
  const accept = useCallback((pos: GeolocationPosition) => {
    const c = pos.coords;
    accRef.current = Number.isFinite(c.accuracy) ? c.accuracy : 100;
    lastCbRef.current = Date.now();
    errCodeRef.current = null;
    const g = wgs84ToGcj02({ lat: c.latitude, lng: c.longitude });
    const f: UserFix = { lng: g.lng, lat: g.lat, accuracy: accRef.current, ts: lastCbRef.current };
    pendingRef.current = f;
    if (f.ts - lastAcceptRef.current >= intervalRef.current) {
      lastAcceptRef.current = f.ts;
      setFix(f);
      pendingRef.current = null;
      setUserFixHook(f.ts, f.accuracy);
    }
  }, []);

  /** 失败**不清空** `fix`：蓝点停在最后已知位置（D4） */
  const onGeoError = useCallback(
    (err: GeolocationPositionError | null) => {
      errCodeRef.current = err?.code ?? 2;
      if (errCodeRef.current === 1) permDeniedRef.current = true;
      setDenied(true);
      publish();
    },
    [publish],
  );

  /**
   * ★ v3.12：**唯一的订阅入口，且幂等**。
   *
   * 第一句 `stopWatch()` 是这次修复的结构核心：调用方不需要（也无法）判断
   * "现在有没有一条活订阅"，`subscribe()` 一律**先拆干净再建** ⇒ 不可能出现
   * 「句柄非 null 但订阅已死」被当成"无需处理"的状态。
   * 已授权时 `clearWatch + watchPosition` **不会**重弹权限框（只丢监听，不丢授权）。
   */
  const subscribe = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setDenied(true);
      return;
    }
    stopWatch();
    const coarseNow = coarseRef.current;
    appliedCoarseRef.current = coarseNow;
    const now = Date.now();
    dogBaseRef.current = now;
    lastRebuildAtRef.current = now;
    try {
      watchRef.current = navigator.geolocation.watchPosition(accept, onGeoError, {
        enableHighAccuracy: !coarseNow,
        timeout: 10_000,
        maximumAge: coarseNow ? COARSE_MAX_AGE_MS : maxAgeRef.current,
      });
      setDenied(false);
    } catch {
      watchRef.current = null;
      setDenied(true);
    }
  }, [accept, onGeoError, stopWatch]);

  /**
   * ★ v3.12：**主动探测**（`getCurrentPosition` 一次性取帧）。
   *
   * 为什么必须有：`watchPosition` 在后台挂起后，句柄"看起来还活着"但不再回调；
   * 重建后也可能要等 GPS 重新锁星。`getCurrentPosition` 是**另一条 API 路径**，
   * 系统有缓存/网络定位时常常 0.2~1.5s 就返回 ⇒ 这是"回前台多快能看到蓝点动"
   * 决定性的一层。失败不动 `fix`（沿用 D4：停在最后已知位置）。
   */
  const probe = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    try {
      navigator.geolocation.getCurrentPosition(accept, onGeoError, {
        enableHighAccuracy: !coarseRef.current,
        timeout: PROBE_TIMEOUT_MS,
        maximumAge: 0,
      });
    } catch {
      /* 探测失败不影响 watch 通道 */
    }
  }, [accept, onGeoError]);

  /**
   * ★ v3.12：**第一层恢复** —— 「我们刚从后台/别处回来」。
   *
   * 与旧实现的差别（这是 20s 盲区的直接来源）：
   *   · 旧：重置基准 → `doWatch()`（句柄非 null 就 return）→ 只能等 20s 看门狗；
   *   · 新：`subscribe()`（无条件拆了重建，句柄死活无关）→ 立刻 `probe()` ⇒ 秒级出帧。
   *   · **不再重置 `dogBaseRef` 来"保护"刚回来的订阅** —— 那正是掩盖假死的写法；
   *     现在"刚订阅"由 `subscribe()` 自己写基准，巡检判据看 `max(lastCb, dogBase)`。
   */
  const resume = useCallback(() => {
    if (!enabled || !startedRef.current) return;
    lastAcceptRef.current = 0;
    /**
     * ⚠️ 必须清 `pending`：后台期间暂存的尾部帧是**后台之前的旧坐标**，
     *    回前台后若被 flush 当新帧采纳，蓝点会先跳回旧位置（用户看到的是"又卡一下"）。
     */
    pendingRef.current = null;
    permDeniedRef.current = false; // 用户可能刚在系统设置里打开了定位
    errCodeRef.current = null;
    const now = Date.now();
    if (lastResumeAtRef.current > 0 && now - lastResumeAtRef.current < RESUME_DEDUPE_MS) {
      // 同一次返回的第二个/第三个事件：订阅刚重建过，只补探针，别再拆（会打断冷启动首帧）
      probe();
      publish();
      return;
    }
    lastResumeAtRef.current = now;
    subscribe();
    probe();
    publish();
  }, [enabled, subscribe, probe, publish]);

  /**
   * ★ v3.12：**第二层恢复** —— 廉价诱因（网络恢复 / 用户触碰页面）。
   * 只探测、不拆订阅：避免"每点一下地图就重建一次 watchPosition"。
   * `pointerdown`/`touchstart` 的价值：它是"用户确实在前台"的**铁证**，
   * 专治 WebView 壳里 `document.visibilityState` 卡在 `hidden`、事件全丢的情况。
   */
  const nudge = useCallback(() => {
    if (!enabled || !startedRef.current) return;
    if (permDeniedRef.current) return;
    const fresh = lastCbRef.current > 0 && Date.now() - lastCbRef.current < HEALTHY_MS;
    if (fresh) return;
    probe();
  }, [enabled, probe]);

  const start = useCallback(() => {
    startedRef.current = true;
    lastAcceptRef.current = 0;
    subscribe();
    probe();
  }, [subscribe, probe]);

  const stop = useCallback(() => {
    startedRef.current = false;
    stopWatch();
    pendingRef.current = null;
    setFix(null);
  }, [stopWatch]);

  /** enabled=false（离开导航态）⇒ 停订阅、清 fix */
  useEffect(() => {
    if (!enabled) {
      stopWatch();
      pendingRef.current = null;
      setFix(null);
    }
  }, [enabled, stopWatch]);

  /**
   * ★ v3.12：已授权时自动建立订阅（见文件头 §3）。
   * 只复用已有授权，**不申请权限** ⇒ 不会弹框，不违反「权限申请＝用户手势」。
   * iOS Safari 的 Permissions API 不含 geolocation ⇒ reject ⇒ 静默 no-op（行为与旧版一致）。
   */
  useEffect(() => {
    if (!AUTO_ARM_IF_GRANTED || !enabled) return;
    let cancelled = false;
    try {
      if (typeof navigator === "undefined") return;
      const perms = navigator.permissions;
      if (!perms?.query) return;
      void perms
        .query({ name: "geolocation" as PermissionName })
        .then((st) => {
          if (cancelled || st.state !== "granted" || startedRef.current) return;
          startedRef.current = true;
          subscribe();
          publish();
        })
        .catch(() => {
          /* 不支持 / 被策略拒绝 ⇒ 退回"只由 start() 建立订阅" */
        });
    } catch {
      /* ignore */
    }
    return () => {
      cancelled = true;
    };
  }, [enabled, subscribe, publish]);

  /**
   * ★ v3.12：**第三层恢复（兜底）** —— 2s 巡检。
   * 一个定时器干三件事：尾帧 flush（保证"到达阈值"的 pending 被采纳）· `publish()` ·
   * `geoRecoveryOf()` 自愈判定。合并的原因：判据只有一处，节拍只有一处，
   * 不可能出现"flush 还在跑但看门狗被谁清掉了"这种半死状态。
   */
  useEffect(() => {
    if (!enabled) return;
    publish(); // 挂载即同步一次（否则 `data-geo` 在新会话里会缺值）
    const tick = window.setInterval(() => {
      // ── ① 尾帧 flush ──
      const p = pendingRef.current;
      if (p && p.ts - lastAcceptRef.current >= intervalRef.current) {
        lastAcceptRef.current = p.ts;
        setFix(p);
        pendingRef.current = null;
        setUserFixHook(p.ts, p.accuracy);
      }
      // ── ② 观测钩子 ──
      publish();
      // ── ③ 自愈判定 ──
      const now = Date.now();
      const plan = geoRecoveryOf({
        nowMs: now,
        started: startedRef.current,
        hasWatch: watchRef.current != null,
        permDenied: permDeniedRef.current,
        sinceRebuildMs: lastRebuildAtRef.current > 0 ? now - lastRebuildAtRef.current : -1,
        lastCbTs: lastCbRef.current,
        dogBaseTs: dogBaseRef.current,
        visible: typeof document !== "undefined" && document.visibilityState === "visible",
        activityProven: false,
      });
      if (plan === "subscribe") {
        subscribe();
        probe();
      } else if (plan === "rebuild") {
        lastAcceptRef.current = 0;
        subscribe();
        probe();
      }
    }, TICK_MS);
    return () => window.clearInterval(tick);
  }, [enabled, publish, subscribe, probe]);

  /**
   * ★ v3.12：**恢复事件矩阵** —— 5 条来源全部汇入同两个入口，没有第三条重建路径。
   *
   *   ① `visibilitychange→visible`：标准路径；`→hidden` 时停订阅（省电，回前台一定重建）。
   *   ② `pageshow`：★ **不再要求 `e.persisted`** —— PWA 切后台通常**不进 bfcache**，
   *      `persisted` 恒 false ⇒ 旧写法在独立模式下几乎永不触发（D9 的另一半）。
   *   ③ `window.focus`：桌面切窗 / 部分 Android WebView 只发 focus 不发 visibilitychange。
   *   ④ `online`：网络恢复 ⇒ 网络定位 provider 恢复（只探针）。
   *   ⑤ `pointerdown` / `touchstart`：用户碰到页面 = 铁证在前台（只探针，不拆订阅）。
   */
  useEffect(() => {
    if (!enabled) return;
    const onVis = () => {
      if (document.visibilityState === "visible") resume();
      else {
        stopWatch();
        pendingRef.current = null;
      }
    };
    const onPageShow = () => resume();
    const onFocus = () => resume();
    const onOnline = () => nudge();
    const onActivity = () => nudge();
    const passive = { capture: true, passive: true } as const;
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    window.addEventListener("pointerdown", onActivity, passive);
    window.addEventListener("touchstart", onActivity, passive);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pointerdown", onActivity, passive);
      window.removeEventListener("touchstart", onActivity, passive);
    };
  }, [enabled, resume, nudge, stopWatch]);

  /** 候车 ↔ 乘车切换 `coarse` ⇒ 重建订阅（options 只在订阅时生效） */
  useEffect(() => {
    if (appliedCoarseRef.current === coarse) return;
    if (!startedRef.current) {
      appliedCoarseRef.current = coarse;
      return;
    }
    lastAcceptRef.current = 0;
    subscribe();
  }, [coarse, subscribe]);

  /** 卸载兜底 */
  useEffect(() => () => stopWatch(), [stopWatch]);

  return { fix, denied, ageMs, geo, start, stop };
}
