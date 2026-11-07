"use client";

/* eslint-disable @typescript-eslint/no-explicit-any --
 * AMap 没有随包的 TS 类型（`window.AMap` 是运行时注入的），因此 map / amap / marker
 * 一律按 `any` 处理。这不是偷懒：全仓所有图层（`TqhStationLayer` / `VehicleLayer` /
 * `TrackLayer` / `UserDotLayer`）同一个口径，第 47 行都是同一条 disable。
 * 若哪天引入 `@types/amap-js-api`，应**一起**替换这几层，不要只改一层造成两套类型。 */

/**
 * 跨境地标图层（需求 7）—— 在地图上画机场 / 码头圆点，低倍时把互相重叠的一对合成聚合点。
 *
 * ── 与既有图层的关系 ────────────────────────────────────────────────────
 *   形态与 `TqhStationLayer` / `VehicleLayer` 一致：受控组件，`map` / `amap` 由 `NavMap`
 *   在 `phase === "ready"` 后传入，卸载时 `map.remove()` 清理（**不泄漏 AMap marker**）。
 *
 * ── 为什么本层**没有**站点图层的 zoom 门 ─────────────────────────────────
 *   站点层浏览态要 zoom ≥ 15（`NavMap.tsx:87 STATION_MIN_ZOOM`），因为全澳 400+ 站点
 *   低倍会糊成一片。本层只有 4 个地标，且在低倍本身就是"地标"语义
 *   （用户先看"机场在哪"，再放大地看细节）⇒ 常显。
 *   遮挡风险由**聚合**承担（见 `xborder-pins.ts#groupXbPins`），而不是由"藏起来"承担：
 *   藏起来会让用户在低倍完全找不到机场，与需求「首页显示机场、港口」直接冲突。
 *   ⚠️ 将来若要给它加门，别照抄站点的 15 —— 那会让聚合逻辑永远触发不了
 *      （聚合只在低倍成立），等于把聚合代码变成死码。
 */

import { useEffect, useRef } from "react";
import { groupXbPins, XB_PIN_SIZE, xbPinById } from "./xborder-pins";

interface XborderPinLayerProps {
  /** AMap.Map 实例（`NavMap` 就绪后传入；未就绪传 null） */
  map: any | null;
  /** AMap 命名空间（构造 Marker / Pixel 用） */
  amap: any | null;
  /** 总开关（未就绪 / 不该显示时 false） */
  enabled: boolean;
  /** 点圆点 / 聚合点 ⇒ 交回宿主开小窗（参数 = 该组包含的地标 id） */
  onPick?: (ids: string[]) => void;
  /** 观测钩子：当前已绘单元数（供验收断言；不做业务逻辑） */
  onCount?: (groups: number) => void;
}

const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export default function XborderPinLayer({ map, amap, enabled, onPick, onCount }: XborderPinLayerProps) {
  const markersRef = useRef<any[]>([]);
  /* 回调走 ref：宿主每次渲染都会新建内联函数，直接进 effect 依赖会导致全量重建 marker */
  const pickRef = useRef(onPick);
  const countRef = useRef(onCount);
  useEffect(() => {
    pickRef.current = onPick;
  }, [onPick]);
  useEffect(() => {
    countRef.current = onCount;
  }, [onCount]);

  useEffect(() => {
    if (!enabled || !map || !amap) return;
    let cancelled = false;

    const clear = () => {
      for (const m of markersRef.current) {
        try {
          map.remove(m);
        } catch {
          /* 地图已销毁时 remove 会抛，忽略 */
        }
      }
      markersRef.current = [];
    };

    /** 按当前 zoom 重算聚合 ⇒ 重建。只有 ≤4 个 marker，重建比增量维护更不容易错。 */
    const draw = () => {
      if (cancelled) return;
      clear();
      const zoom = typeof map.getZoom === "function" ? map.getZoom() : 0;
      const groups = groupXbPins(zoom);

      for (const g of groups) {
        const pins = g.ids.map(xbPinById).filter((p): p is NonNullable<typeof p> => !!p);
        if (!pins.length) continue;

        const isCluster = pins.length > 1;
        /**
         * 语义：这是"可点的地标"，不是站点 ⇒ `role="button"` + `aria-label`。
         * 不用 `.nav-map__station`：那是站点（11/13px、圆形/方形、有 ETA 语义），
         * 复用会让「站标只有一套规格」那条门禁与视觉口径同时变模糊。
         */
        const label = isCluster
          ? `${pins.map((p) => p.name).join("与")}（聚合），查看班次`
          : `${pins[0].name}，查看班次`;
        const cls = `nav-map__xbpin${isCluster ? " nav-map__xbpin--cluster" : pins[0].kind === "airport" ? " nav-map__xbpin--air" : " nav-map__xbpin--pier"}`;
        /* 断言属性：聚合用 data-xb-cluster（值为 ids 拼串），单点用 data-xb-pin（值为 id） */
        const attr = isCluster
          ? ` data-xb-cluster="${esc(g.clusterKey ?? "")}"`
          : ` data-xb-pin="${esc(pins[0].id)}"`;

        const marker = new amap.Marker({
          position: [g.lng, g.lat],
          content: `<div class="${cls}"${attr} role="button" tabindex="-1" aria-label="${esc(label)}" title="${esc(pins.map((p) => p.name).join(" / "))}">${
            isCluster ? `<span class="nav-map__xbpin__count">${pins.length}</span>` : ""
          }</div>`,
          /* 圆点居中：offset 取半径的相反数（与 CSS 的 --xb-pin-size 一致，见其注释） */
          offset: new amap.Pixel(-XB_PIN_SIZE / 2, -XB_PIN_SIZE / 2),
          /* 地标压在站点之上（站点未显式设 zIndex ⇒ 默认 100 段），避免被站点标盖住 */
          zIndex: 140,
          extData: { ids: g.ids },
        });
        marker.on("click", () => pickRef.current?.(g.ids));
        map.add(marker);
        markersRef.current.push(marker);
      }
      countRef.current?.(groups.length);
    };

    draw();
    /* 只监听 zoomend：聚合只随**缩放**变化，平移不改变像素间距 ⇒ moveend 无须监听 */
    map.on("zoomend", draw);

    return () => {
      cancelled = true;
      try {
        map.off("zoomend", draw);
      } catch {
        /* ignore */
      }
      clear();
    };
  }, [map, amap, enabled]);

  return null;
}
