"use client";

/**
 * 通琴号路径图层（src/components/nav/TqhPathLayer.tsx，2026-11-05 · Spec R3）
 *
 * ── 为什么是「段数组」而不是一条折线（`openapi.yaml` 的契约理由）───────
 *   前端要按 `status` 分色：`ok` 段画主题色实线，`missing` / `failed` 段画**直线虚线**。
 *   拼成一条就丢了分界信息（拼在客户端做，一次 flat，O(n)）。
 *
 * ── 几何来源与降级（不出假数据）────────────────────────────────────────
 *   `/api/tqh/trip-path` 的 `polyline` 是 **GCJ-02**，直喂地图，**不得再转**。
 *   `status != ok` ⇒ 用两端站点坐标连**直线虚线**（明确表达"这段没有实测走线"），
 *   `complete=false` 时界面提示「本班次部分路段暂未覆盖」，但**仍画图**（不整块隐藏）。
 *   ★ 请求期零高德调用：几何全来自离线预计算的 `tqh_segment_paths`。
 *
 * ── 复用口径（AC-5）───────────────────────────────────────────────────
 *   「同站序班次复用同一几何、不同站序不得复用」由**服务端按有向站对**保证；
 *   本文件只按 `trip_code` 取一套段，**不做任何跨班次缓存合并**。
 *
 * ⚠️ 颜色只有一个来源：`--tqh-accent`（读 resolved 值喂画布，`color-mix` 在自定义属性里
 *   读不到 resolved 值 ⇒ 地图相关 Token 落具体 hex，见 `design-tokens.css` 注释）。
 */
import { useEffect, useRef } from "react";
import { stationMapOf, type TqhSegment, type TqhStation } from "./tqh-model";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TqhPathLayerProps {
  map: any;
  amap: any;
  enabled: boolean;
  /** 段数组（null = 不画；`[]` = 清空） */
  segments: TqhSegment[] | null;
  /** 站点表（直线虚线降级时取两端坐标） */
  stations: TqhStation[] | null;
}

/** 读 CSS Token 的 resolved 值（画布 API 不认 `var()`） */
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

export default function TqhPathLayer({ map, amap, enabled, segments, stations }: TqhPathLayerProps) {
  const liveRef = useRef<any[]>([]);

  useEffect(() => {
    const clear = () => {
      for (const p of liveRef.current) {
        try {
          map?.remove?.(p);
        } catch {
          /* ignore */
        }
      }
      liveRef.current = [];
    };
    if (!enabled || !map || !amap || !segments) {
      clear();
      return clear;
    }
    if (segments.length === 0) {
      clear();
      return clear;
    }
    const solid = cssVar("--tqh-accent", "#ff58a6");
    const edge = cssVar("--tqh-map-edge", "rgba(15,23,32,0.42)");
    const byId = stationMapOf(stations ?? []);
    const made: any[] = [];
    for (const seg of segments) {
      const ok = seg.status === "ok" && Array.isArray(seg.polyline) && seg.polyline.length >= 2;
      let path: [number, number][] | null = ok ? (seg.polyline as [number, number][]) : null;
      if (!path) {
        // 降级：两端站点直线（没有实测走线就明说 —— 不自造平滑曲线）
        const a = byId.get(seg.from_station_id);
        const b = byId.get(seg.to_station_id);
        if (!a || !b) continue;
        path = [
          [a.lng, a.lat],
          [b.lng, b.lat],
        ];
      }
      try {
        const line = new amap.Polyline({
          path,
          // ★ 主题色纯色（禁渐变、禁发光）；虚线用深描边色降透明，明确"非实测走线"
          strokeColor: ok ? solid : edge,
          strokeWeight: ok ? 4 : 3,
          strokeOpacity: ok ? 0.95 : 0.55,
          strokeStyle: ok ? "solid" : "dashed",
          ...(ok ? {} : { strokeDasharray: [6, 6] }),
          lineJoin: "round",
          lineCap: "round",
          zIndex: 73, // > 路线总览彩段 72 < 站点 90
          bubble: false,
        });
        map.add(line);
        made.push(line);
      } catch {
        /* 单段失败不影响其余段 */
      }
    }
    liveRef.current = made;
    return clear;
  }, [enabled, map, amap, segments, stations]);

  return null;
}
