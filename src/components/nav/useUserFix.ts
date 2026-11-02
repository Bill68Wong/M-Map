"use client";

/**
 * 用户实时定位通道（src/components/nav/useUserFix.ts，2026-09-25 · v2.14 · 07 §2）
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
 *   · **页面隐藏** → `clearWatch`；可见 → 重订阅并重置节流计时；
 *   · 卸载 → `clearWatch` 兜底。
 *
 * ── ★ v3.7.0 S2（导航稳定性 D2 / D4 / #11）────────────────────────────
 *   1. **看门狗**：每 5s 巡检，`20s` 无新回调即判定「监听还在但再也不报位置」
 *      （iOS Safari 从后台回来的典型症状）⇒ `stopWatch()` 后重新 `doWatch()`；
 *   2. **回前台重置基准**：`visibilitychange→visible` / `pageshow(persisted)` 时除重订阅外
 *      **必须重置看门狗基准**，否则刚回来就被判假死、白清一次监听；
 *   3. **失败不清空**：`error` 回调（含 `denied`）只置状态，**保留最后一帧 `fix`**
 *      —— 断网/失锁时蓝点停在最后已知位置，用户看到的是「停住」而不是「消失」（D4）；
 *   4. **候车期粗定位**：`coarse=true` ⇒ `maximumAge=30s` + `enableHighAccuracy=false`
 *      （省电、出点更快）；**乘车（riding）必须传 `false`**（只用新鲜高精度坐标）；
 *   5. 新增 `ageMs` 与 `geo`；钩子 `body[data-geo]` / `body[data-user-fix]="ts,acc"`
 *      由 `observe-hooks` 统一写（**不写经纬度**，避免截图/录屏外泄位置）。
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

/** 看门狗巡检间隔（ms） */
const WATCH_MS = 5_000;
/** 判定「监听假死」的空窗阈值（ms）—— Spec §5 锁定 20s */
const WATCH_IDLE_MS = 20_000;
/**
 * 粗定位的 `maximumAge`（ms）。
 * 候车期允许复用 30s 内的系统缓存坐标（快出点、省电）；乘车期不得复用（会跳）。
 */
const COARSE_MAX_AGE_MS = 30_000;

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
  /** 最后一次**订阅**的时刻（ms）—— 看门狗基准（重订阅/回前台都要重置它） */
  const dogBaseRef = useRef(0);
  /** 最后一帧精度（米）—— 只管 `low_acc` 判定，不参与渲染 */
  const accRef = useRef(0);
  /** 最近一次 `GeolocationPositionError.code`（1 拒权 / 2 不可用 / 3 超时） */
  const errCodeRef = useRef<number | null>(null);
  /** 用户明确拒权 ⇒ 看门狗不再重订阅（重订阅只会立刻再报一次错） */
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

  /** 把 `ageMs` / `geo` 同步出去（含 body 钩子）。由 2s flush 定时器与错误回调调用。 */
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

  const doWatch = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setDenied(true);
      return;
    }
    if (watchRef.current != null) return;
    const coarseNow = coarseRef.current;
    try {
      dogBaseRef.current = Date.now();
      watchRef.current = navigator.geolocation.watchPosition(
        (pos) => {
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
        },
        (err) => {
          // ★ 失败**不清空** `fix`：蓝点停在最后已知位置（D4）
          errCodeRef.current = err?.code ?? 2;
          if (errCodeRef.current === 1) permDeniedRef.current = true;
          setDenied(true);
          publish();
        },
        {
          enableHighAccuracy: !coarseNow,
          timeout: 10_000,
          maximumAge: coarseNow ? COARSE_MAX_AGE_MS : maxAgeRef.current,
        },
      );
      setDenied(false);
    } catch {
      setDenied(true);
    }
  }, [publish]);

  const start = useCallback(() => {
    startedRef.current = true;
    doWatch();
  }, [doWatch]);

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
   * 尾帧 flush（保证「到达阈值」的 pending 被采纳）+ **看门狗巡检**。
   * 两者共用同一个 effect 的清理函数；节流下限由 `lastAccept` 守。
   */
  useEffect(() => {
    if (!enabled) return;
    publish(); // 挂载即同步一次（否则 `data-geo` 在新会话里会缺值）
    const flush = window.setInterval(() => {
      const p = pendingRef.current;
      if (p && p.ts - lastAcceptRef.current >= intervalRef.current) {
        lastAcceptRef.current = p.ts;
        setFix(p);
        pendingRef.current = null;
        setUserFixHook(p.ts, p.accuracy);
      }
      publish();
    }, 2_000);
    const dog = window.setInterval(() => {
      if (!startedRef.current || watchRef.current == null) return;
      if (permDeniedRef.current) return; // 已拒权：重订阅不会有新帧，只等用户去设置里开
      const base = Math.max(lastCbRef.current, dogBaseRef.current);
      if (Date.now() - base <= WATCH_IDLE_MS) return;
      // 假死：监听句柄还在、但再也不报位置 ⇒ 换一条订阅（iOS 回前台最典型）
      stopWatch();
      lastAcceptRef.current = 0;
      doWatch(); // doWatch 内部会把 `dogBaseRef` 重置为此刻 ⇒ 新订阅有一段新的观察期
    }, WATCH_MS);
    return () => {
      window.clearInterval(flush);
      window.clearInterval(dog);
    };
  }, [enabled, publish, stopWatch, doWatch]);

  /** 页面可见性 / bfcache 还原：隐藏 → 停；可见（或 pageshow.persisted）→ **重置基准**后重订阅 */
  useEffect(() => {
    if (!enabled) return;
    const resume = () => {
      lastAcceptRef.current = 0;
      permDeniedRef.current = false; // 用户可能刚从系统设置里打开了定位
      errCodeRef.current = null;
      dogBaseRef.current = Date.now(); // ★ 必须先重置：否则"刚回来"就被看门狗判假死
      doWatch();
      publish();
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        if (startedRef.current) resume();
      } else {
        stopWatch();
      }
    };
    const onPageShow = (e: PageTransitionEvent) => {
      // ★ D9：iOS「加入主屏」独立模式 / bfcache 还原只发 pageshow，不发 visibilitychange
      if (e.persisted && startedRef.current) resume();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [enabled, doWatch, stopWatch, publish]);

  /** 候车 ↔ 乘车切换 `coarse` ⇒ 重建订阅（options 只在订阅时生效） */
  useEffect(() => {
    if (appliedCoarseRef.current === coarse) return;
    appliedCoarseRef.current = coarse;
    if (!startedRef.current) return;
    stopWatch();
    lastAcceptRef.current = 0;
    doWatch();
  }, [coarse, doWatch, stopWatch]);

  /** 卸载兜底 */
  useEffect(() => () => stopWatch(), [stopWatch]);

  return { fix, denied, ageMs, geo, start, stop };
}
