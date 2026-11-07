"use client";

/**
 * 通琴号（TQH）· 数据获取与模块级缓存（src/components/nav/tqh-lines.ts，2026-11-05）
 *
 * ── 为什么是模块级缓存 ───────────────────────────────────────────────────
 *   弹窗（`RouteLinesSheet`）、搜索（`SearchSheet`）、站点卡片、站序弹窗**四处**都要同一份
 *   `{trips, stations}`。若各自 fetch：
 *     · 切板块时要等第二份请求 ⇒ 违反 AC-1「切板块 0 网络请求」；
 *     · 46 KB JSON 反复传输（服务端已给 `max-age=3600`，但多个组件同时打仍会并发多次）。
 *   ⇒ 一个 Promise 单飞 + 模块级 memo，**整个会话只发一次**；`reload()` 走显式强制。
 *
 * ── 缓存口径 ────────────────────────────────────────────────────────────
 *   · **不传 `cache: "force-cache"`**（项目教训：两层缓存各管一段，发版后拿不到新数据，
 *     见 `RouteLinesSheet` 2026-09 事故注释）；浏览器按服务端 `max-age` 自己缓存；
 *   · `version` 变化只影响「是否需要丢弃 memo」——本文件单飞一次，不比对 URL 版本
 *     （`openapi.yaml` 明确：**不要把版本号塞进 URL**）。
 *
 * ── 降级 ────────────────────────────────────────────────────────────────
 *   失败只影响通琴号板块（`phase="failed"` + 文案），**澳门板块与其数据链一字不动**。
 *
 * ── ★ 2026-11-06（修复批 #6 · P0「首页看不到通琴号站」）───────────────────
 *   hook 的 `auto` 语义从「由交互驱动」改为「进页面即拉」（宿主恒传 `true`，见 NavShell）。
 *   根因是旧口径「打开选线弹窗 / 选班次才拉」⇒ 首页 `stations` 恒空 ⇒ 地图上没有站。
 *   同时补一条**一次性轻量重试**：首次失败 2s 后再试一次（**不是轮询**，全程最多 2 次）——
 *   首页加载时上游/网络抖一下就永久没有站点，用户没有任何可见的补救入口。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { errorTextOf } from "@/lib/ui/error-text";
import type { TqhLinesResponse, TqhTripPathResponse } from "./tqh-model";

const EMPTY: TqhLinesResponse = { version: "", trips: [], stations: [] };

/**
 * ★ 首次失败后的重试延迟（ms）。
 * 只重试**一次**：这是「首页冷启动 + 上游抖动」的兜底，不是可用性机制 ——
 * 真故障要靠 UI 上的刷新键（`reload()`）由用户显式重试，绝不做定时轮询。
 */
const TQH_RETRY_MS = 2_000;

let memo: TqhLinesResponse | null = null;
let inflight: Promise<TqhLinesResponse> | null = null;

/** 读缓存（同步；用于首帧直接出内容，不闪"载入中"） */
export function tqhLinesMemo(): TqhLinesResponse | null {
  return memo;
}

/**
 * 取全量（trips + stations）。
 * @param force `true` ⇒ 忽略 memo 与在途请求，重新打网（同一 URL 无副作用）。
 */
export function loadTqhLines(force = false): Promise<TqhLinesResponse> {
  if (!force && memo) return Promise.resolve(memo);
  if (!force && inflight) return inflight;
  const p = fetch("/api/tqh/lines")
    .then(async (r) => {
      const j = (await r.json()) as TqhLinesResponse;
      const data: TqhLinesResponse = {
        version: typeof j.version === "string" ? j.version : "",
        trips: Array.isArray(j.trips) ? j.trips : [],
        stations: Array.isArray(j.stations) ? j.stations : [],
        error: j.error,
      };
      /**
       * ★ 有 `error` **且**清单为空 ⇒ 视为失败（不写缓存，下次还能重试）；
       *   有 `error` 但清单非空（部分降级）⇒ 照常缓存并展示 —— 一次上游抖动
       *   不该把整个板块变成错误态（与 `/api/route-lines` 同口径）。
       */
      if (data.error && data.trips.length === 0) {
        throw new Error(errorTextOf(data.error));
      }
      memo = data;
      return data;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

export type TqhPhase = "loading" | "ready" | "failed";

export interface UseTqhLines {
  data: TqhLinesResponse;
  phase: TqhPhase;
  /** 用户可读文案（已过 `errorTextOf`，不把英文枚举上屏） */
  error: string;
  /** 强制重取（刷新键 / 3s 冷却由调用方控制） */
  reload: () => void;
}

/** 共享数据 hook（四处在用；首帧读 memo ⇒ 无 loading 闪动） */
export function useTqhLines(auto = true): UseTqhLines {
  const [data, setData] = useState<TqhLinesResponse>(() => memo ?? EMPTY);
  const [phase, setPhase] = useState<TqhPhase>(() => (memo ? "ready" : "loading"));
  const [error, setError] = useState("");
  /** 请求序号：只认最后一次（快速连点刷新不串台） */
  const seqRef = useRef(0);
  /** ★ 一次性重试闸门（见下方 effect；true 后不再安排第二次） */
  const retriedRef = useRef(false);

  const run = useCallback((force: boolean) => {
    const seq = ++seqRef.current;
    const cached = tqhLinesMemo();
    if (cached && !force) {
      setData(cached);
      setPhase("ready");
      setError("");
      return;
    }
    setPhase(cached ? "ready" : "loading");
    loadTqhLines(force)
      .then((d) => {
        if (seq !== seqRef.current) return;
        setData(d);
        setPhase("ready");
        setError("");
      })
      .catch((e: Error) => {
        if (seq !== seqRef.current) return;
        // 有旧数据时保留旧数据（只提示），避免"刷新一下整板空了"
        setError(e?.message || "通琴号班次表加载失败");
        setPhase(tqhLinesMemo() ? "ready" : "failed");
      });
  }, []);

  useEffect(() => {
    if (!auto) return;
    run(false);
  }, [auto, run]);

  /**
   * ★ 2026-11-06（修复批 #6 · P0）：**首次失败后 2s 重试一次**（闸门只开一次，不轮询）。
   *
   * 为什么不能用 `run` 自引用来做（`run` 里 `setTimeout(() => run(true))`）：
   *   `run` 是 `useCallback`，自引用在闭包解析期拿不到自己（TDZ），只能靠 ref 绕；
   *   而 `phase === "failed"` 本来就精确表达「没有缓存 + 上一次失败」——
   *   用 effect 观察它更直白，且**卸载时 `clearTimeout` 自动兜住**（不会对已卸载组件 setState）。
   *
   * 边界：
   *   · 重试成功 ⇒ `phase` 转 `ready` ⇒ 本 effect 不再命中；
   *   · 重试再失败 ⇒ `retriedRef` 已置位 ⇒ 不产生第二次定时器（**最多 2 次请求**）；
   *   · 有旧数据（`phase` 保持 `ready`）⇒ 不进此分支（抖动不重拉，与上方 catch 口径一致）。
   */
  useEffect(() => {
    if (!auto || phase !== "failed" || retriedRef.current) return;
    retriedRef.current = true;
    const t = setTimeout(() => run(true), TQH_RETRY_MS);
    return () => clearTimeout(t);
  }, [auto, phase, run]);

  return { data, phase, error, reload: useCallback(() => run(true), [run]) };
}

/* ─────────────────────────── 单班次路径 ─────────────────────────── */

const pathMemo = new Map<string, TqhTripPathResponse>();
const pathInflight = new Map<string, Promise<TqhTripPathResponse>>();

/**
 * 取某班次的逐段几何。`trip_code` 含**全角竖线** ⇒ 必须整体 `encodeURIComponent`。
 * 失败返回 `{segments: []}`（调用方据 `segments.length === 0` 提示"路径暂不可用"，
 * 但**站点列表与卡片不受影响**）。
 */
export function loadTqhTripPath(tripCode: string): Promise<TqhTripPathResponse> {
  const key = String(tripCode ?? "");
  if (!key) return Promise.resolve({ trip_code: "", segments: [] });
  const hit = pathMemo.get(key);
  if (hit) return Promise.resolve(hit);
  const pend = pathInflight.get(key);
  if (pend) return pend;
  const p = fetch(`/api/tqh/trip-path?trip_code=${encodeURIComponent(key)}`)
    .then(async (r) => {
      const j = (await r.json()) as TqhTripPathResponse;
      const data: TqhTripPathResponse = {
        trip_code: j.trip_code ?? key,
        version: j.version,
        segments: Array.isArray(j.segments) ? j.segments : [],
        complete: !!j.complete,
        error: j.error,
      };
      // 只有拿到段才缓存（空结果多半是 404/500，下次进同一班次还应能重试）
      if (data.segments.length > 0) pathMemo.set(key, data);
      return data;
    })
    .catch(() => ({ trip_code: key, segments: [] }) as TqhTripPathResponse)
    .finally(() => {
      if (pathInflight.get(key) === p) pathInflight.delete(key);
    });
  pathInflight.set(key, p);
  return p;
}
