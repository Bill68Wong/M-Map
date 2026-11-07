"use client";

/**
 * 站序列表（src/components/line/LineStopList.tsx，v3.6.0 · S6）
 *
 * ── 职责边界 ────────────────────────────────────────────────────────────
 *   只负责「把站序渲染成 <ol>」，报站数据由 `useLazyEta` 提供、换乘信息由调用方
 *   算好传进来。保持本文件在 100 行内，方便单看「列表结构」而不被网络逻辑淹没。
 *
 * ── 序号为什么不显示 ────────────────────────────────────────────────────
 *   设计 §2.8：90 余站每行带序号会让列表变成表格。顺序靠**竖线串联 + 首末站实心**表达。
 *
 * ── 首末站判定 ──────────────────────────────────────────────────────────
 *   `index === 0 || index === total - 1` —— 前端自算，**不需要接口给标记**。
 *   （26 路这类环线首末同站，两端都是实心，视觉上正好表达「绕回来了」。）
 */
import LineStopRow, { type LineStopVeh } from "./LineStopRow";
import type { EtaState } from "./useLazyEta";
import { mainOf, type LineStop } from "@/lib/line/line-shared";
import { lineNameOf } from "@/lib/route-label";

export interface LineStopListProps {
  stops: LineStop[];
  color: string;
  /** 取某站报站三态 */
  etaOf: (code: string) => EtaState;
  /** 登记 DOM（懒加载用） */
  registerEl: (code: string, el: HTMLElement | null) => void;
  /** 主码 → 该站停靠的全部线路码（用于算换乘）；未加载完时为空 Map */
  linesOfStation: Map<string, string[]>;
  /** 本线线路码（算换乘时排除自己） */
  lineCode: string;
  /**
   * ★ 2026-11-05（通琴号 R6）：每站的**属地**（`澳` / `琴` 小标签的数据源）。
   *   只有通琴号站序弹窗传；**不传 ⇒ 每行 `side` 为 undefined ⇒ DOM 与改前一致**。
   */
  sideOf?: (stop: LineStop) => "澳门" | "横琴" | undefined;
  /**
   * ★ 2026-11-06（#5c）：每站的**巴士图标状态**（四态）。
   *   只有 `RouteStopsSheet` 的 bus/lrt 族传；**不传 ⇒ 每行 `veh` 为 undefined
   *   ⇒ 不渲染图标元素 ⇒ DOM 与改前逐字节一致**（`/line/[code]` 页与通琴号弹窗零回归）。
   */
  vehOf?: (stop: LineStop) => LineStopVeh | null | undefined;
  /** ★ 2026-11-06（#5c）：点巴士图标 → 开巴士信息弹窗；不传 ⇒ 图标非交互（不做死键） */
  onOpenBusCard?: ((stop: LineStop, veh: LineStopVeh) => void) | null;
}

/** 换乘列最多显示的线路条数（设计 §2.8：最多列 3 条） */
const MAX_XFER = 3;

export default function LineStopList({
  stops,
  color,
  etaOf,
  registerEl,
  linesOfStation,
  lineCode,
  sideOf,
  vehOf,
  onOpenBusCard,
}: LineStopListProps) {
  return (
    <ol className="lp-list">
      {stops.map((stop, i) => {
        // 换乘 = 该主码停靠的线路里去掉本线，最多 3 条
        // ★ 2026-11-06（D-1）：换乘码走 `lineNameOf()` —— 否则轻轨会显示 `换乘 LRT-横琴线`
        //   （带内部码前缀 + 简体），与面板/顶栏的 `橫琴線` 不一致。`lineNameOf` 对巴士码恒等，无副作用。
        const all = linesOfStation.get(mainOf(stop.code)) ?? [];
        const xfer = all.filter((l) => l !== lineCode).slice(0, MAX_XFER).map(lineNameOf);
        const veh = vehOf?.(stop) ?? null;
        return (
          <LineStopRow
            key={`${stop.seq}-${stop.code}`}
            stop={stop}
            index={i}
            total={stops.length}
            color={color}
            eta={etaOf(stop.code)}
            xfer={xfer}
            registerEl={registerEl}
            side={sideOf?.(stop)}
            veh={veh}
            onOpenBusCard={veh && onOpenBusCard ? (v) => onOpenBusCard(stop, v) : null}
          />
        );
      })}
    </ol>
  );
}
