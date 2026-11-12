"use client";

/* eslint-disable @typescript-eslint/no-explicit-any --
 * AMap 没有随包的 TS 类型（`window.AMap` 是运行时注入的）⇒ map / amap / marker 一律按 `any`。
 * 全仓图层（`XborderPinLayer` / `TqhStationLayer` / `VehicleLayer` / `TrackLayer` / `UserDotLayer`）
 * 同一口径；若将来引入 `@types/amap-js-api`，应**一起**替换，不要只改一层造出两套类型。 */

/**
 * 公共厕所图层（M4 · 需求 3）—— 在地图上画 198 个「WC」方形 pin，点开公厕弹窗。
 *
 * ── 与既有图层同一形态 ──────────────────────────────────────────────────
 *   受控组件：`map` / `amap` 由 `NavMap` 在 `phase === "ready"` 后传入；卸载时逐个
 *   `map.remove(marker)` 收尾（**不泄漏 AMap marker**，与 `XborderPinLayer` 同纪律）。
 *   回调一律走 ref（宿主每次渲染都会新建内联函数，直接进 effect 依赖会全量重建 marker）。
 *
 * ── 懒加载（负责人裁定：静态 JSON、默认关闭、打开才拉）──────────────────
 *   **只在 `enabled` 为 true 时才 `loadPublicToilets()`**；数据层自带模块级 Promise 缓存
 *   ⇒ 开关反复拨动只发一次请求。失败**静默降级**（地图照常可用），只留一条可诊断的
 *   `console.warn`；不把一次网络抖动钉死成永久失败（数据层 catch 里已清缓存，可重试）。
 *
 * ── 坐标：**已是 GCJ-02**，严禁再转换 ───────────────────────────────────
 *   `public-toilets.json` 的 `lat`/`lng` 是构建脚本用 `wgs84ToGcj02()` 换好的展示坐标；
 *   再转一次会**偏移约 600 米**（地图上公厕会落到海里）。`latWgs84`/`lngWgs84` 只作留档，
 *   **本文件一行都不要读它们**。
 *
 * ── 缩放：由宿主门控，不要在这里自己拍数字 ───────────────────────────────
 *   `enabled` 由 `NavMap` 传入 `phase==="ready" && showToilets && stationZoomOk`，
 *   其中 `stationZoomOk` 与巴士站点层**同一个** `minZoom`（浏览 15 / 路线·导航 12）
 *   —— 单一真相，别在本地另写一个 15（那会变成两份阈值，必然漂移）。
 *
 * ── 只首页渲染 ─────────────────────────────────────────────────────────
 *   导航态由宿主不传 `enabled`（与通琴号「导航态隐藏全部站点图标」同一口径）。
 */
import { useEffect, useRef, useState } from "react";
import { loadPublicToilets, toiletDisplayName, type PublicToilet } from "@/lib/map/public-toilets";

/**
 * 方形 pin 边长（px）。负责人裁定：**方形 + 白色「WC」**，边长按「WC 看得清」定。
 * 取 **14px**：真实高德底图（深色建筑块 / 绿地 / 道路线）上 13px 的 WC 处于可辨认边缘，
 * 实拍 dsf=3 截图后按 team-lead「辨认不了就升到 14px，不用再问」的授权上调。
 * 该值必须与 `globals.css` 的 `.nav-map__toilet { width/height }` 一致（offset 用它算一半）。
 */
export const TOILET_PIN_SIZE = 14;

interface PublicToiletLayerProps {
  /** AMap.Map 实例（就绪后传入；未就绪传 null） */
  map: any | null;
  /** AMap 命名空间（构造 Marker / Pixel 用） */
  amap: any | null;
  /**
   * 总开关（**只管绘制**）：`phase==="ready" && showToilets && stationZoomOk`。
   * 缩放不达标时 `enabled=false` ⇒ 不画 pin（与站点层同生同灭）。
   */
  enabled: boolean;
  /**
   * ★ 缺陷修复（M4，2026-11-10）：**数据加载**开关，比 `enabled` 宽一档 ——
   * `phase==="ready" && showToilets`（**不看缩放**）。
   *
   * 为什么必须拆开：首页初始 `zoom = 12.5`，而站点层阈值是 15
   * ⇒ 若把「加载」也绑在 `enabled` 上，用户拨开公厕开关后**连 fetch 都不会发**
   *   （实测：`.nav-map__toilet` = 0 且 `public-toilets.json` 零请求），
   *   既看不到 pin 也拿不到任何提示，只能怀疑「开关坏了」。
   * 拆开后：拨开关即拉数据（198 条一次性到位，模块级缓存 ⇒ 只发一次），
   *   放大地图到阈值以上时 pin **立刻出现**（不用再等一轮请求）。
   */
  active?: boolean;
  /** 点某个公厕 pin ⇒ 宿主开弹窗 */
  onPick?: (toilet: PublicToilet) => void;
  /** 观测钩子：当前已绘 pin 数（供真浏览器验收断言；不做业务逻辑） */
  onCount?: (n: number) => void;
}

const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export default function PublicToiletLayer({ map, amap, enabled, active = enabled, onPick, onCount }: PublicToiletLayerProps) {
  const markersRef = useRef<any[]>([]);
  const pickRef = useRef(onPick);
  const countRef = useRef(onCount);
  /** 模块级缓存之外再留一层组件内状态：数据到位后触发重绘 */
  const [items, setItems] = useState<PublicToilet[] | null>(null);

  useEffect(() => {
    pickRef.current = onPick;
  }, [onPick]);
  useEffect(() => {
    countRef.current = onCount;
  }, [onCount]);

  /* ── 懒加载：`active`（不看缩放）就拉一次；`enabled` 只管画 ── */
  useEffect(() => {
    if (!active || items) return;
    let cancelled = false;
    loadPublicToilets()
      .then((file) => {
        if (cancelled) return;
        setItems(file.items);
      })
      .catch((err) => {
        // 静默降级：地图其余部分照常可用；留一条可诊断日志（不乱抛、不弹 toast）
        console.warn("[toilets] 公厕数据加载失败，图层本次为空：", err instanceof Error ? err.message : err);
      });
    return () => {
      cancelled = true;
    };
  }, [active, items]);

  /* ── 建 / 清 marker ── */
  useEffect(() => {
    if (!enabled || !map || !amap || !items) return;
    let cancelled = false;

    const clear = () => {
      for (const m of markersRef.current) {
        try {
          map.remove(m);
        } catch {
          /* ignore：地图已销毁 */
        }
      }
      markersRef.current = [];
    };

    const draw = () => {
      clear();
      if (cancelled) return;
      /**
       * ★ 重复坐标处理（data-engineer 契约：**13 组重复坐标，数据层刻意不合并**；
       *   实测最大同点 **9 条**，分布 `[9,6,4,4,4,3,3,3,2,2,2,2,2]`，合计 46 条 ⇒ 原样画会有
       *   8 个 pin 永久点不到）。
       *
       * 做法：组内按**向日葵（黄金角）螺旋**错开 —— `r = 10·√i`、`θ = i·137.5°`，
       *   「避免重叠且分布均匀」的标准解法，且**确定性**（不用随机）。
       *
       * ⚠️ 稳定性（data-engineer 明确要求）：偏移量必须**只由 `publicId` 决定**，
       *   不能由渲染顺序/数组下标决定 —— 否则数据源一更新变了序，同一公厕就跳到别处。
       *   ⇒ 组内成员**先按 `publicId` 字典序排序**再取序号，偏移预计算成
       *     `publicId → {dx,dy}` 的 Map，绘制时只查表。
       *
       * 偏移只作用于 `offset`（像素），**不动真实坐标** ⇒ 弹窗与「设为起点」拿到的仍是原值。
       * 已知边界（data-engineer 提示、可接受）：两个不同同点组若相距 < 28px，螺旋可能互相穿插。
       */
      const GOLDEN = 2.399963229728653; // 137.5°
      const offsetByPublicId = new Map<string, { dx: number; dy: number }>();
      const byCoord = new Map<string, PublicToilet[]>();
      for (const t of items) {
        if (t.lat == null || t.lng == null) continue;
        const k = `${t.lat},${t.lng}`;
        const arr = byCoord.get(k);
        if (arr) arr.push(t);
        else byCoord.set(k, [t]);
      }
      for (const arr of byCoord.values()) {
        if (arr.length === 1) {
          offsetByPublicId.set(arr[0].publicId, { dx: 0, dy: 0 });
          continue;
        }
        /* 稳定序：按 publicId 字典序（不含渲染顺序 / 下标） */
        const sorted = [...arr].sort((a, b) => (a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0));
        sorted.forEach((t, i) => {
          if (i === 0) {
            offsetByPublicId.set(t.publicId, { dx: 0, dy: 0 });
            return;
          }
          /* ⚠️ 半径**封顶 24px**（team-lead 2026-11-10 约束）：i=8 时 10·√8≈28.3 会越界，
             封顶后仍能分辨 9 个 13px 方 pin，且不会把「同一栋楼」的点甩到隔壁街区。 */
          const r = Math.min(24, 10 * Math.sqrt(i));
          const ang = i * GOLDEN;
          offsetByPublicId.set(t.publicId, { dx: Math.round(Math.cos(ang) * r), dy: Math.round(Math.sin(ang) * r) });
        });
      }

      let n = 0;
      for (const t of items) {
        // location 为 null 的记录没有坐标 ⇒ 不画（数据层已置 null，不要当 0 处理）
        if (t.lat == null || t.lng == null) continue;
        const label = `公共厕所-${toiletDisplayName(t.nameTc)}`;
        const { dx, dy } = offsetByPublicId.get(t.publicId) ?? { dx: 0, dy: 0 };
        const marker = new amap.Marker({
          position: [t.lng, t.lat],
          content: `<div class="nav-map__toilet" role="button" tabindex="-1" data-toilet-pin="${esc(t.publicId)}" aria-label="${esc(label)}" title="${esc(label)}">WC</div>`,
          /* 方形 pin 居中：offset 取边长一半的相反数（与 CSS 的 13px 一致），再叠重坐标错位 */
          offset: new amap.Pixel(-TOILET_PIN_SIZE / 2 + dx, -TOILET_PIN_SIZE / 2 + dy),
          /* 压在站点（默认 100 段）之下、线路之上：点在站点/地标下面时不抢点击 */
          zIndex: 95,
          extData: { id: t.publicId },
        });
        marker.on("click", () => {
          const hit = items.find((x) => x.publicId === t.publicId);
          if (hit) pickRef.current?.(hit);
        });
        map.add(marker);
        markersRef.current.push(marker);
        n++;
      }
      countRef.current?.(n);
    };

    draw();
    /* 只跟 zoomend：本层不做视口裁剪（198 个 DOM marker 远少于巴士层 400+ 的量级），
       平移不需要重绘。若将来数据量涨到千级，再照巴士层加 moveend 节流裁剪。 */
    map.on("zoomend", draw);

    return () => {
      cancelled = true;
      try {
        map.off("zoomend", draw);
      } catch {
        /* ignore */
      }
      clear();
      countRef.current?.(0);
    };
  }, [map, amap, enabled, items]);

  return null;
}
