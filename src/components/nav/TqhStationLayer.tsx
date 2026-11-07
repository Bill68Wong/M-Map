"use client";

/**
 * 通琴号站点图层（src/components/nav/TqhStationLayer.tsx，2026-11-05 · Spec R4；
 * ★ 2026-11-06 修复批 #1 / #3 / R1 重写绘制口径）
 *
 * ── 画什么（本轮口径变更，勿按旧注释实施）────────────────────────────────
 *   · **只画「纯通琴号站」**（`bus_station_code` 为空）：12×12 整圆
 *     `--tqh-map-solid`（#ff58a6）。
 *   · **带 `bus_station_code` 的通琴号站不再单独画 marker** —— 那是问题 #1 的根因
 *     （巴士层在同一物理位置另有自己的点 ⇒ 同地两个标）。它们的通琴号信息改挂到
 *     **巴士站标**上：`NavMap` 给命中集合的巴士 marker 染**左蓝右粉**
 *     （见 `tqh-model.ts#sharedBusMainCodes` 与 `globals.css .nav-map__station--tqh-shared`）。
 *   · **同物理点分组（`same_place_group`，R1 已批 1 组）合并成 1 个 marker**：
 *     代表站 = 组内 `id` 最小者（坐标偏差 1.0 m），卡片内按原站 ①/② 各自成组。
 *
 *   实测（2026-11-06 只读查库）：138 站 = **97 纯通琴号站** + 41 带 `bus_station_code`；
 *   97 里有 1 组同物理点（澳科大南门①②）⇒ **本层实际画 96 个 marker**。
 *   （Spec 原文写的「103 纯站」与算术不符：138 − 41 = 97。以数据为准。）
 *
 * ── 白名单（修复批 #3 / R2）────────────────────────────────────────────
 *   `whitelist` 非空 ⇒ **白名单外不创建 marker**（与巴士层 `NavMap:1127-1132` 同口径，
 *   是数据层过滤而不是 `opacity`/`display` 隐藏）。
 *   · `null` = 不过滤（浏览态 / 导航态 —— 导航态行为按 R2 保持不变）；
 *   · **空集** = 全隐（线路详情是巴士/轻轨线时，通琴号标必须一起消失）；
 *   · 非空集 = 只看这些站（通琴号班次详情 = 本班站点）。
 *
 * ── 高亮 / 降级（§7.4）─────────────────────────────────────────────────
 *   查看某班次时：该班次经过的站加白环（`--tqh-onroute`），其余降为 0.42 透明度
 *   —— **只降透明、不改背景**。实现上**原地改 className**（DOM content），不重建 marker。
 *
 * ── 缩放门（★ 2026-11-06 修复批 #6 · P0）──────────────────────────────
 *   本层**自己不算阈值**：`enabled` 由 `NavMap` 传入，取值为
 *   「地图就绪 **且** `zoom >= minZoom`」——其中 `minZoom` 就是**巴士站点图层**
 *   在同一场景下用的那个常量（常规 `STATION_MIN_ZOOM` / 路线·导航档 `STATION_MIN_ZOOM_ROUTE`），
 *   且由**同一次 `render()` 调用**算出（`NavMap` 的 `stationZoomOk`）。
 *   ⇒ 慢慢拉远时通琴号站与巴士站**同时消失**（阈值以下 `clear()` 走 `map.remove()`，
 *   不是 `visibility:hidden`）；放大过阈值时同时出现。
 *   ⚠️ 绝对不要在本文件里另写一个 15 —— 那会变成两份真相，必然与巴士层漂移。
 *
 * ⚠️ 颜色一律走 CSS 类（`--tqh-map-*` Token）；本文件零硬编码色值。
 * ⚠️ 清理必须 `map.remove(marker)`，与 `VehicleLayer` / `TrackLayer` 同一纪律。
 */
import { useEffect, useMemo, useRef } from "react";
import { samePlaceGroupsOf, type TqhStation } from "./tqh-model";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TqhStationLayerProps {
  /** 高德地图实例（未就绪传 null） */
  map: any;
  /** 高德命名空间（`Pixel` / `Marker` 构造器） */
  amap: any;
  enabled: boolean;
  stations: TqhStation[] | null;
  /** 当前班次经过的站 id（null = 不高亮、不降级） */
  activeIds?: ReadonlySet<number> | null;
  /**
   * ★ 修复批 #3：站点白名单（通琴号站 `id`）。
   * `null` = 不过滤；空集 = 全隐；非空 = 只画集合内的站。
   */
  whitelist?: ReadonlySet<number> | null;
  /** 点站点：`ids` = 该 marker 覆盖的全部通琴号站 id（同物理点合并组 > 1 项） */
  onStationClick?: (s: TqhStation, ids: number[]) => void;
  /**
   * ★ 2026-11-06（修复批 #6）：**已绘 marker 数**回传（观测钩子用）。
   * 宿主据此写 `data-tqh-station-count`（QA 断言「96」/「阈值以下 = 0」）。
   * ⚠️ 只上报，宿主不得用它驱动 state（会成为渲染环）。
   */
  onCount?: (n: number) => void;
}

interface Rec {
  marker: any;
  /** DOM content（原地改 className ⇒ 切高亮/重建白名单零闪烁） */
  el: HTMLDivElement;
  station: TqhStation;
  ids: number[];
}

/** 一个待绘制的站点 marker（同物理点合并后） */
export interface TqhMarkerPlan {
  /** 代表站（同物理点组内 `id` 最小者；坐标来源） */
  station: TqhStation;
  /** 该 marker 覆盖的全部通琴号站 id（单站时 = `[station.id]`） */
  ids: number[];
}

/**
 * 绘制清单（导出供验收脚本断言「96」）。
 *
 * 三条口径，缺一不可：
 *   ① **跳过**带 `bus_station_code` 的站（41 个）—— 它们由巴士层的双色标代表（#1）；
 *   ② 同 `same_place_group` 合并为 1 个点，代表站取组内 `id` 最小者（R1，仅 1 组）；
 *   ③ 其余逐站 1 个点（97 − 1 = **96**）。
 */
export function stationMarkersOf(stations: TqhStation[]): TqhMarkerPlan[] {
  const groups = samePlaceGroupsOf(stations);
  const emitted = new Set<number>(); // 已作为合并组首个成员画过的组 id
  const out: TqhMarkerPlan[] = [];
  for (const s of stations) {
    // ① 有关联巴士站码 ⇒ 不画独立标（信息挂在巴士站的双色标上）
    if (String(s.bus_station_code ?? "").trim()) continue;
    const g = s.same_place_group;
    if (typeof g === "number") {
      if (emitted.has(g)) continue; // ② 同组只画一次
      emitted.add(g);
      const members = groups.get(g) ?? [s];
      const rep = members[0]; // 组内 id 最小（samePlaceGroupsOf 已升序）
      out.push({ station: rep, ids: members.map((m) => m.id) });
      continue;
    }
    out.push({ station: s, ids: [s.id] });
  }
  return out;
}

export default function TqhStationLayer({
  map,
  amap,
  enabled,
  stations,
  activeIds = null,
  whitelist = null,
  onStationClick,
  onCount,
}: TqhStationLayerProps) {
  const liveRef = useRef<Map<number, Rec>>(new Map());
  const cbRef = useRef(onStationClick);
  cbRef.current = onStationClick;
  /** ★ 计数回传（放 ref ⇒ 宿主换回调不重建 marker） */
  const countRef = useRef(onCount);
  countRef.current = onCount;

  /**
   * ★ 白名单在 **plan 层**过滤（而不是建完 marker 再 `display:none`）：
   *   ① 与巴士层「白名单外不创建 marker」同口径（R2 / AC-29）；
   *   ② plan 引用变化 ⇒ 下方 effect 重建，**退出过滤时标记自然恢复全量**。
   */
  const plan = useMemo(() => {
    if (!stations) return [];
    const all = stationMarkersOf(stations);
    if (!whitelist) return all; // null = 不过滤
    return all.filter((p) => p.ids.some((id) => whitelist.has(id)));
  }, [stations, whitelist]);

  /** 建 / 清 marker（只在 stations、白名单或地图实例变化时重跑） */
  useEffect(() => {
    const live = liveRef.current;
    const clear = () => {
      for (const [, rec] of live) {
        try {
          map?.remove?.(rec.marker);
        } catch {
          /* ignore */
        }
      }
      live.clear();
    };
    if (!enabled || !map || !amap || plan.length === 0) {
      clear();
      // ★ 观测钩子：阈值以下 / 白名单清空 / 地图未就绪 ⇒ 已绘 marker 数 = 0
      countRef.current?.(0);
      return clear;
    }
    for (const { station, ids } of plan) {
      if (live.has(station.id)) continue;
      try {
        const el = document.createElement("div");
        el.className = "nav-map__station nav-map__station--tqh";
        el.setAttribute("data-tqh-station", String(station.id));
        if (ids.length > 1) el.setAttribute("data-tqh-merged", ids.join(","));
        el.setAttribute("title", station.name);
        /**
         * ★ 点击**直接绑在 content 元素上**（不再只靠 `marker.on("click")`）。
         *
         * 实测（2026-11-05 · 390×844 真浏览器）：`content` 传 **DOM 元素**（而非 HTML
         * 字符串，本层为了原地改 className 必须传元素）时，元素自身的 DOM click 正常到达，
         * 但 `marker.on("click")` **不触发** —— 高德 2.0 的 marker 事件依赖它对
         * string content 生成的内部节点；换成外部 DOM 元素后这条通道静默失效
         * （既有巴士站图层传的是字符串，所以那边没问题）。
         *
         * 两条纪律：
         *   ① `stopPropagation()` —— 否则 click 继续冒泡到地图容器，地图自身的 `click`
         *      会同时触发（宿主 `onMapClick` 会立刻把刚打开的卡片清掉 = 闪一下就没了）；
         *   ② `bubble: false` —— 同向的第二道保险（不让 marker 事件冒泡给地图）。
         * 只拦 `click`：拖拽走的是 pointerdown/move/up，地图平移缩放不受影响。
         */
        const onDomClick = (ev: MouseEvent) => {
          ev.stopPropagation();
          cbRef.current?.(station, ids);
        };
        el.addEventListener("click", onDomClick);
        const marker = new amap.Marker({
          position: [station.lng, station.lat],
          content: el, // ★ DOM 元素（非字符串）⇒ 可原地改 className
          offset: new amap.Pixel(-6, -6), // 12 的一半 ⇒ 居中
          zIndex: 91, // > 巴士站 90 / < 轻轨 95
          bubble: false,
        });
        map.add(marker);
        live.set(station.id, { marker, el, station, ids });
      } catch {
        /* 单点失败不影响其余 */
      }
    }
    countRef.current?.(live.size);
    return clear;
  }, [enabled, map, amap, plan]);

  /** 高亮/降级：只改 className（零重建、零闪烁） */
  useEffect(() => {
    const live = liveRef.current;
    for (const [, rec] of live) {
      const base = "nav-map__station nav-map__station--tqh";
      if (!activeIds) {
        rec.el.className = base;
        continue;
      }
      // 合并组：组内任一站在本班次就算「本班次经过」
      const on = rec.ids.some((id) => activeIds.has(id));
      rec.el.className = `${base}${on ? " nav-map__station--tqh-onroute" : " nav-map__station--tqh-dim"}`;
    }
  }, [activeIds, plan, enabled]);

  return null;
}
