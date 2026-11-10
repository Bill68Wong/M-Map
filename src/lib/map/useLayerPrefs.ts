"use client";

/**
 * 地图图层偏好 · React 绑定（src/lib/map/useLayerPrefs.ts，M2 · 需求 2）
 *
 * ── 模式（沿用项目既有范式，同 `src/lib/favorites/useFavorites.ts:3-18`）──────
 *   模块级读缓存 + **自定义事件订阅**（`must:layers`，同页即时同步）
 *   + 原生 `storage` 事件（跨标签同步）。**写一律经本模块 / `./layer-prefs`**，
 *   保证「写 → 广播 → 各订阅者回读」是一条链。本文件不做业务判定。
 *
 * ── SSR 水合守卫 ────────────────────────────────────────────────────────
 *   服务端读不到 `localStorage` ⇒ 首帧恒为 `DEFAULT_LAYER_PREFS` + `mounted: false`，
 *   `useEffect` 挂载后再读真值。消费方用 `mounted` 决定是否已可信任 `prefs`
 *   （首帧按默认值渲染，避免与真值不一致导致闪烁 / 水合告警）。
 *
 * ── `available === false`（隐私模式 / 存储被禁）──────────────────────────
 *   写会失败（`saveLayerPrefs` 内部吞掉异常）⇒ 本 hook **强制回读**，开关弹回原位，
 *   **不假装保存成功**。弹窗层按 `available` 给「本次设置不会记住」的提示。
 *
 * ⚠️ 边界同 `./layer-prefs`：**禁止 import 任何含 `pg` 的模块**（client 组件直接引用）。
 */
import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_LAYER_PREFS,
  LAYER_PREFS_EVENT,
  isLayerStorageAvailable,
  loadLayerPrefs,
  markLayerPrefsSeen,
  resetLayerPrefs,
  saveLayerPrefs,
  type LayerKey,
  type LayerPrefs,
} from "./layer-prefs";

/** 最近一次读取结果（300ms 内复用，避免同一帧多处调用反复 parse） */
let lastRead: LayerPrefs = { ...DEFAULT_LAYER_PREFS };
let lastReadAt = 0;

function readCached(force = false): LayerPrefs {
  const now = Date.now();
  if (!force && lastReadAt && now - lastReadAt < 300) return lastRead;
  lastRead = loadLayerPrefs();
  lastReadAt = now;
  return lastRead;
}

/*
 * 说明：本文件**不自己广播事件** —— 事件由 `./layer-prefs` 的 `saveLayerPrefs` /
 * `resetLayerPrefs` 唯一发射（写操作一律走那条路），避免同一变更派发两次导致重复 setState。
 */

/** 订阅偏好变化；返回取消订阅 */
export function subscribeLayerPrefs(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = () => cb();
  const onStorage = (e: StorageEvent) => {
    // `key === null` = 整库被清（`clear()`）⇒ 也要刷新
    if (e.key === null || e.key.startsWith("must.layers")) {
      lastReadAt = 0;
      cb();
    }
  };
  window.addEventListener(LAYER_PREFS_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(LAYER_PREFS_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

export interface UseLayerPrefs {
  /** 当前偏好（首帧 = 默认值；`mounted` 后为已记住的选择） */
  prefs: LayerPrefs;
  /** 是否已挂载（`false` = SSR 首帧） */
  mounted: boolean;
  /** `localStorage` 是否可用（`false` = 隐私模式 ⇒ 只读降级 + 提示「不会记住」） */
  available: boolean;
  /** 拨动单个图层开关（同时把 `seen` 置 true —— 能拨开关说明面板已打开过） */
  setLayer: (key: LayerKey, on: boolean) => void;
  /** 恢复默认（删键 ⇒ 4 开 1 关 + `seen: false`） */
  reset: () => void;
  /** 标记「面板已打开过」（首次打开时调一次；已标记则无操作） */
  markSeen: () => void;
}

export function useLayerPrefs(): UseLayerPrefs {
  const [prefs, setPrefs] = useState<LayerPrefs>(() => ({ ...DEFAULT_LAYER_PREFS }));
  const [mounted, setMounted] = useState(false);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    setMounted(true);
    setAvailable(isLayerStorageAvailable());
    setPrefs(readCached(true));
    return subscribeLayerPrefs(() => {
      lastReadAt = 0;
      setPrefs(readCached(true));
      setAvailable(isLayerStorageAvailable());
    });
  }, []);

  /**
   * 写一次后**强制回读**：这是「不假装成功」的关键 —— 隐私模式下 `setItem` 抛错，
   * 回读仍是原值（默认值）⇒ 开关弹回原位，而不是显示一个并未保存的状态。
   */
  const commit = useCallback((next: LayerPrefs) => {
    saveLayerPrefs(next);
    lastReadAt = 0;
    setPrefs(readCached(true));
    setAvailable(isLayerStorageAvailable());
  }, []);

  const setLayer = useCallback(
    (key: LayerKey, on: boolean) => {
      const next: LayerPrefs = { ...readCached(true), seen: true };
      next[key] = on;
      commit(next);
    },
    [commit],
  );

  const reset = useCallback(() => {
    resetLayerPrefs(); // 内部已删键 + 广播
    lastReadAt = 0;
    setPrefs(readCached(true));
    setAvailable(isLayerStorageAvailable());
  }, []);

  const markSeen = useCallback(() => {
    if (markLayerPrefsSeen()) {
      lastReadAt = 0;
      setPrefs(readCached(true));
    }
  }, []);

  return { prefs, mounted, available, setLayer, reset, markSeen };
}
