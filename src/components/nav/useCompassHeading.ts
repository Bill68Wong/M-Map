"use client";

/**
 * 朝向传感器通道（src/components/nav/useCompassHeading.ts，★ 2026-11-12 · F1）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   `deviceorientation(absolute)` / iOS `webkitCompassHeading`
 *     → 倾斜补偿求"用户面朝方向"（`lib/compass/heading.ts`）
 *     → 环形低通平滑 → 以 ≤30fps 提交给 React（供地图箭头旋转）。
 *
 * ── 三条必须做对的事 ──────────────────────────────────────────────────
 *   ① **权限必须在用户手势的同步栈内申请**：iOS 13+ 的
 *      `DeviceOrientationEvent.requestPermission()` 若在 `await` 之后或定时器里调用，
 *      会直接 reject（且不弹框）。⇒ `requestAccess()` 由调用方在 onClick 里**同步**调用，
 *      本 hook 绝不自动申请（自动申请 = 静默失败 + 用户以为坏了）。
 *   ② **只接受能证明"绝对朝向"的帧**：`deviceorientation` 的 `alpha` 是相对值
 *      （随页面加载归零），拿它当罗盘会让箭头永远指向加载瞬间的方向。
 *      只认：`deviceorientationabsolute` 事件 / `ev.absolute === true` / iOS `webkitCompassHeading`。
 *   ③ **提交频率与噪声都要压**：传感器 50~60Hz，直接 setState 会让整棵导航树每帧重渲染。
 *      这里用 rAF 合并 + 变化不足 0.5° 不提交（平滑器已带死区，这里是第二道闸）。
 *
 * ── 生命周期 ──────────────────────────────────────────────────────────
 *   · 未授权 / 无传感器 ⇒ 不挂监听，`status` 说明原因；
 *   · 页面隐藏 ⇒ 摘监听（省电，传感器在后台本就停发）；可见 ⇒ 重新挂上；
 *   · 卸载 ⇒ 摘监听 + 取消 rAF + 清 `body` 钩子（残留会让 e2e 误判）。
 *
 * ── 观测钩子 ──────────────────────────────────────────────────────────
 *   `body[data-compass]` = `idle|unsupported|needs_permission|denied|listening|poor`
 *   只写状态，**不写角度**（与 `data-user-fix` 同一口径：不把可定位信息留在 DOM）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createHeadingSmoother,
  headingFromOrientation,
  headingJitterDeg,
  headingQualityOf,
  screenAngleDeg,
  type HeadingQuality,
  type HeadingSample,
} from "@/lib/compass/heading";

/** 通道状态（供 UI 决定是否显示"按正北显示"之类的提示） */
export type CompassStatus =
  | "idle" // 还没开启（未申请权限）
  | "unsupported" // 本机/本浏览器没有方向传感器
  | "needs_permission" // iOS：需要用户手势触发授权
  | "denied" // 用户拒绝
  | "listening" // 正在收帧
  | "poor"; // 有帧但质量不足（磁扰/精度差）

export interface UseCompassHeadingResult {
  /** 平滑后的朝向（0 = 北，顺时针）；无可用朝向时 null */
  heading: number | null;
  /** 质量判定（`ok` 之外都不可用于画箭头） */
  quality: HeadingQuality;
  status: CompassStatus;
  /**
   * 申请权限并开始收帧。**必须在用户手势的同步栈内调用**。
   * @returns 是否成功开启（false ⇒ 调用方走降级链，不要重试）
   */
  requestAccess: () => Promise<boolean>;
  /** 停止收帧（离开步行态时调用；不会撤销系统授权） */
  stop: () => void;
}

/** 无帧看门狗的等待时长（ms）：授权后这么久还没任何帧 ⇒ 判本机无传感器 */
const NO_FRAME_TIMEOUT_MS = 3_000;
/** 质量样本窗口（ms） */
const QUALITY_WINDOW_MS = 1_000;
/** 提交阈值（度）：小于此变化不触发 React 更新 */
const COMMIT_EPS_DEG = 0.5;
/** 质量样本上限（10Hz × 1s，够判离散度且不会无限增长） */
const SAMPLE_MAX = 24;

/**
 * iOS 专有字段（TS 的 `DeviceOrientationEvent` 不含）。
 * 用交叉类型而不是 `extends` —— 新版 lib.dom 里 `absolute` 已是必填布尔，
 * `extends` 把可选属性再声明一次会报 TS2430。
 */
type WebkitOrientationEvent = DeviceOrientationEvent & {
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
};

type DeviceOrientationCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied" | "default">;
};

/** 安全取用 `DeviceOrientationEvent`（SSR / 老浏览器没有） */
function orientationCtor(): DeviceOrientationCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { DeviceOrientationEvent?: DeviceOrientationCtor }).DeviceOrientationEvent;
  return ctor ?? null;
}

export function useCompassHeading(opts: { enabled: boolean }): UseCompassHeadingResult {
  const { enabled } = opts;

  const [heading, setHeading] = useState<number | null>(null);
  const [quality, setQuality] = useState<HeadingQuality>("invalid");
  const [status, setStatus] = useState<CompassStatus>("idle");

  /** 是否已获授权并进入收帧态（`enabled` 之外的第二道门） */
  const [armed, setArmed] = useState(false);

  const smootherRef = useRef(createHeadingSmoother());
  const samplesRef = useRef<HeadingSample[]>([]);
  const pendingRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastCommitRef = useRef<number | null>(null);
  const frameSeenRef = useRef(false);
  const screenAngleRef = useRef(0);
  const qualityRef = useRef<HeadingQuality>("invalid");
  const noFrameTimerRef = useRef<number | null>(null);

  /** 清掉"无帧看门狗" */
  const clearNoFrameTimer = useCallback(() => {
    if (noFrameTimerRef.current != null) {
      window.clearTimeout(noFrameTimerRef.current);
      noFrameTimerRef.current = null;
    }
  }, []);

  /** 停止收帧：摘状态、清缓存（不撤销系统授权） */
  const stop = useCallback(() => {
    setArmed(false);
    setHeading(null);
    setStatus((s) => (s === "denied" || s === "unsupported" || s === "needs_permission" ? s : "idle"));
    smootherRef.current.reset();
    samplesRef.current = [];
    lastCommitRef.current = null;
    frameSeenRef.current = false;
    clearNoFrameTimer();
  }, [clearNoFrameTimer]);

  /** 申请权限（用户手势内同步调用） */
  const requestAccess = useCallback(async (): Promise<boolean> => {
    const ctor = orientationCtor();
    if (!ctor) {
      setStatus("unsupported");
      return false;
    }
    if (typeof ctor.requestPermission === "function") {
      try {
        // ⚠️ 这一行必须在本函数的同步栈里（调用方 onClick 直接调本函数）
        const res = await ctor.requestPermission();
        if (res !== "granted") {
          setStatus("denied");
          return false;
        }
      } catch {
        // Safari 在非手势栈 / 非 HTTPS 下会抛 —— 一律按"拒绝"处理，绝不反复弹框
        setStatus("denied");
        return false;
      }
    }
    screenAngleRef.current = screenAngleDeg();
    frameSeenRef.current = false;
    smootherRef.current.reset();
    samplesRef.current = [];
    setArmed(true);
    setStatus("listening");
    return true;
  }, []);

  /* ── 监听 + 平滑 + 提交 ─────────────────────────────────────────────── */
  useEffect(() => {
    if (!enabled || !armed) return;

    const commit = (deg: number) => {
      pendingRef.current = deg;
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const v = pendingRef.current;
        if (v == null) return;
        const prev = lastCommitRef.current;
        // 第二道噪声闸：变化不足 0.5° 不触发重渲染（平滑器死区已挡掉大部分）
        if (prev != null && Math.abs(((v - prev + 540) % 360) - 180) < COMMIT_EPS_DEG) return;
        lastCommitRef.current = v;
        setHeading(v);
      });
    };

    const onOrient = (ev: DeviceOrientationEvent) => {
      const we = ev as WebkitOrientationEvent;
      const wk = typeof we.webkitCompassHeading === "number" ? we.webkitCompassHeading : null;
      const absolute = ev.type === "deviceorientationabsolute" || we.absolute === true;
      // ② 相对 alpha 无意义（随页面加载归零）⇒ 只认绝对来源
      if (wk == null && !absolute) return;

      const ts = Number.isFinite(ev.timeStamp) && ev.timeStamp > 0 ? ev.timeStamp : performance.now();
      const raw = headingFromOrientation({
        alpha: ev.alpha,
        beta: ev.beta,
        gamma: ev.gamma,
        webkitCompassHeading: wk,
        screenAngleDeg: screenAngleRef.current,
      });
      if (raw == null) return;

      if (!frameSeenRef.current) {
        frameSeenRef.current = true;
        clearNoFrameTimer();
      }

      // 质量：iOS 用系统精度字段；Android 用 1s 窗口离散度
      const now = ts;
      const buf = samplesRef.current;
      buf.push({ deg: raw, ts: now });
      while (buf.length > SAMPLE_MAX) buf.shift();
      const recent = buf.filter((s) => now - s.ts <= QUALITY_WINDOW_MS);
      const q = headingQualityOf(
        typeof we.webkitCompassAccuracy === "number" ? we.webkitCompassAccuracy : null,
        headingJitterDeg(recent),
      );
      if (q !== qualityRef.current) {
        qualityRef.current = q;
        setQuality(q);
        setStatus(q === "ok" ? "listening" : "poor");
      }

      commit(smootherRef.current.push(raw, ts));
    };

    /** 屏幕旋转变化 ⇒ 更新缓存角度并清平滑（避免横竖屏切换时箭头先偏一下再回来） */
    const onScreenChange = () => {
      screenAngleRef.current = screenAngleDeg();
      smootherRef.current.reset();
      lastCommitRef.current = null;
    };

    window.addEventListener("deviceorientationabsolute", onOrient as EventListener);
    window.addEventListener("deviceorientation", onOrient as EventListener);
    window.addEventListener("orientationchange", onScreenChange);
    window.screen?.orientation?.addEventListener?.("change", onScreenChange);

    // ③ 授权后 3s 无帧 ⇒ 本机没有可用的绝对朝向源（桌面浏览器常见）
    clearNoFrameTimer();
    noFrameTimerRef.current = window.setTimeout(() => {
      noFrameTimerRef.current = null;
      if (!frameSeenRef.current) setStatus("unsupported");
    }, NO_FRAME_TIMEOUT_MS);

    /** 页面隐藏 ⇒ 摘监听（传感器后台停发，留着只烧电） */
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        window.removeEventListener("deviceorientationabsolute", onOrient as EventListener);
        window.removeEventListener("deviceorientation", onOrient as EventListener);
      } else {
        window.addEventListener("deviceorientationabsolute", onOrient as EventListener);
        window.addEventListener("deviceorientation", onOrient as EventListener);
        // 回前台第一帧可能就是旧值，清掉平滑基准重新起步
        smootherRef.current.reset();
        lastCommitRef.current = null;
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      window.removeEventListener("deviceorientationabsolute", onOrient as EventListener);
      window.removeEventListener("deviceorientation", onOrient as EventListener);
      window.removeEventListener("orientationchange", onScreenChange);
      window.screen?.orientation?.removeEventListener?.("change", onScreenChange);
      document.removeEventListener("visibilitychange", onVis);
      clearNoFrameTimer();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pendingRef.current = null;
    };
  }, [enabled, armed, clearNoFrameTimer]);

  /** 离开步行态 ⇒ 收干净（`enabled=false`） */
  useEffect(() => {
    if (enabled) return;
    setArmed(false);
    setHeading(null);
    setQuality("invalid");
    smootherRef.current.reset();
    samplesRef.current = [];
    lastCommitRef.current = null;
    frameSeenRef.current = false;
  }, [enabled]);

  /** `body[data-compass]` 观测钩子（只写状态，不写角度） */
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.setAttribute("data-compass", status);
    return () => document.body.removeAttribute("data-compass");
  }, [status]);

  /** 卸载兜底 */
  useEffect(
    () => () => {
      if (typeof document !== "undefined") document.body.removeAttribute("data-compass");
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return { heading, quality, status, requestAccess, stop };
}
