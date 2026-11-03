"use client";

/**
 * 路线总览数据流 hook（src/components/nav/useRouteOverview.ts，2026-09-23 新增）
 *
 * ── 职责（技术方案 §3.4）────────────────────────────────────────────────
 *   进入 detail pane 时并行取数并组装几何，供 `NavMap` 的 `overview` prop 绘制：
 *     (a) `POST /api/nav/detail-body`（含 `legs` 几何锚点）；
 *     (b) 各 distinct route 的 `GET /api/route-shapes`（polyline，GCJ-02）。
 *   完成后：`buildColoredLegs(legs, shapesByRoute)` → `ColoredLeg[]` + 取景外包框 `box`。
 *
 * ── ★ v3.6.0 S4：**本 hook 不再拉车辆** ────────────────────────────────
 *   原先这里还顺手拉各巴士段的 `route-vehicles`（(c) 段），但只在「进 detail」时拉**一次**
 *   ⇒ 候车态地图上的车永远静止，「刷新」只更新列表不更新地图。
 *   现在车辆**唯一来源 = `useRideTracking.mapVehicles`**（12s 帧驱动，候车态返回全部候选）。
 *   ⇒ 不要在这里重新引入车辆请求，否则又会出现两个来源、两套刷新节奏。
 *
 * ── 降级铁律（永不阻塞地图）────────────────────────────────────────────
 *   · 单段 shapes 缺失 / 超容差 / 切割失败 ⇒ 该段 `degraded`（整线着色），其余照常；
 *   · detail-body 整体失败 ⇒ `legs=[]`（地图退回 OD 取景），详情 pane 自行显示失败 + 重试。
 *
 * ⚠️ 轻轨段无实时车辆（`route-vehicles` 对 `LRT-*` 返回空）—— 与本节无关，车辆已不在此处取。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildColoredLegs,
  unionBox,
  type ColoredLeg,
  type RouteShapeLite,
} from "@/lib/nav/route-overview";
import type { RecommendCard } from "@/lib/recommend/types";
import { useDetailBody, type DetailBody, type FoldState } from "./useDetailBody";

export interface OverviewBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export interface UseRouteOverview {
  phase: "idle" | "loading" | "ready" | "failed";
  /** detail-body（strips / 折叠栏 / legs）；失败时非空但 strips 为空 */
  body: DetailBody | null;
  /** 切割后的乘车段（供 NavMap 绘制） */
  legs: ColoredLeg[];
  /** 取景外包框（彩段 + 起终点）；无几何时为 null */
  box: OverviewBox | null;
  reload: () => void;
  /**
   * ★ v3.7.0（C5）：折叠栏按需查询的透传（`useDetailBody` 的同一份）。
   *   宿主（`RouteSheet` / `NavShell`）必须把它一直传到 `StationReachFold`，
   *   否则首包 `foldLive={}` 会被渲染成「暂无到站信息」（把"没查"说成"没有班次"）。
   */
  loadFold: () => void;
  foldState: FoldState;
}

/**
 * @param card   当前详情的卡（null = 无）
 * @param open   是否处于 detail pane（false = 清空几何）
 * @param extra  取景额外纳入的点（起点 / 终点）；**调用方需 useMemo 稳定引用**
 */
export function useRouteOverview(
  card: RecommendCard | null,
  open: boolean,
  extra?: { lng: number; lat: number }[],
): UseRouteOverview {
  const detail = useDetailBody(card, open);
  const [legs, setLegs] = useState<ColoredLeg[]>([]);
  const [box, setBox] = useState<OverviewBox | null>(null);
  const [geomReady, setGeomReady] = useState(false);
  const seqRef = useRef(0);

  const legsInput = detail.body?.legs ?? null;
  /** 稳定 key：distinct route 列表（legs 顺序稳定） */
  const routeKey = useMemo(
    () => (legsInput ? [...new Set(legsInput.map((l) => l.route))].join("|") : ""),
    [legsInput],
  );

  useEffect(() => {
    // 关闭 / 未就绪 → 清空几何（退出 detail 时 NavMap 逐个 remove）
    if (!open || !card || detail.phase !== "ready" || !legsInput) {
      seqRef.current++;
      setLegs([]);
      setBox(null);
      setGeomReady(false);
      return;
    }
    const id = ++seqRef.current;
    const routes = routeKey ? routeKey.split("|") : [];

    void (async () => {
      // (b) 各 route 的 shapes（并行）
      // ★ v3.7.0（P2 · 去强缓存）：不再传 `cache: "force-cache"` —— 服务端已下发
      //   `s-maxage` + 浏览器可见 `max-age`，浏览器会按 HTTP 语义自己缓存；
      //   再叠 `force-cache` 就是两层缓存互相遮蔽（2026-09-21 事故同形）。
      const entries = await Promise.all(
        routes.map(async (code): Promise<[string, RouteShapeLite[]]> => {
          try {
            const r = await fetch(`/api/route-shapes?code=${encodeURIComponent(code)}`);
            const j = (await r.json()) as {
              shapes?: {
                dir?: string;
                polyline: string;
                startStop?: string | null;
                endStop?: string | null;
                /** ★ 4-B−：本方向站序（主码、`seq` 升序）。缺省/空 ⇒ 下游回落旧逻辑 */
                stations?: { code: string; seq: number }[] | null;
              }[];
            };
            const shapes: RouteShapeLite[] = (j.shapes ?? []).map((s) => ({
              dir: s.dir,
              polyline: s.polyline,
              startStop: s.startStop ?? null,
              endStop: s.endStop ?? null,
              /**
               * ★ 4-B−（需求 4）**必须透传**，否则 `pickTripPair` 恒读到 `undefined`
               *   ⇒ 整条「站序感知配对」是死代码（每段都 `return base`）= 线上无任何改善。
               *   这正是本轮 P0 的成因：`route-overview.ts` 算法写好了，但这里把字段丢了。
               *   老缓存响应没有该字段 ⇒ `?? null` ⇒ 下游走「逐字节等价」的回落路径。
               */
              stations: s.stations ?? null,
            }));
            return [code, shapes];
          } catch {
            return [code, []];
          }
        }),
      );
      if (id !== seqRef.current) return;
      const shapesByRoute: Record<string, RouteShapeLite[]> = Object.fromEntries(entries);

      // 组装几何 + 取景框
      const built = buildColoredLegs(legsInput, shapesByRoute);
      const paths = built.map((l) => l.colored).filter((a) => a.length >= 2);
      setLegs(built);
      setBox(unionBox(paths, extra));
      setGeomReady(true);
      // ★ v3.6.0 S4：车辆不在此处取 —— 唯一来源 = `useRideTracking.mapVehicles`（见文件头）
    })();
    // extra 由调用方 useMemo 稳定
  }, [open, card, detail.phase, legsInput, routeKey, extra]);

  return {
    phase: !open
      ? "idle"
      : detail.phase === "failed"
        ? "failed"
        : geomReady
          ? "ready"
          : "loading",
    body: detail.body,
    legs,
    box,
    reload: detail.reload,
    /** ★ v3.7.0（C5）：折叠栏按需查询透传 */
    loadFold: detail.loadFold,
    foldState: detail.foldState,
  };
}
