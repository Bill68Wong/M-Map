"use client";

/**
 * 通琴号板块（src/components/nav/TqhBoard.tsx，2026-11-05 · Spec R1/R2）
 *
 * ── 栅格（负责人 §17-R3 裁决，不可推翻）────────────────────────────────
 *   · **7 列 / 6 行**：35 个标号按「字母族各自起新行」排布
 *     （A 5 个 → 1 行余 2 格 · B 21 个 → 3 行满 · C 4 个 → 1 行余 3 格 · D 5 个 → 1 行余 2 格）；
 *   · 总高 `6×44 + 5×4 = 284px`；**行末留空，不补位、不居中、不拉伸**；
 *   · 族内**数值序**（`B1 … B9 B10 … B21`）——字典序会给出 `B1 B10 B11 … B2`（历史坑）。
 *
 * ── 换行怎么实现（为什么不用「每族一个 row 容器」）─────────────────────
 *   给每族**第一个**标号写 `grid-column-start: 1`。CSS Grid 的自动排布遇到
 *   「列号被显式指定且 ≤ 已占列」时必然另起一行 ⇒ 零额外 DOM、零 flex 数学，
 *   也不会出现 `.rl-sheet__bus` 那种 `w-[calc(33%-1rem)]` 的百分比裂缝。
 *   断言（AC-2）：`A1 / B1 / C1 / D1` 的 `offsetLeft` 必须等于行首偏移，行数 = 6。
 *
 * ── 未选标号时下方是**纯留白**（需求原文）──────────────────────────────
 *   不是"空态"：不放引导文案、不放空图标、不放骨架。
 *   ⇒ `.tqh-trip-list` **不存在于 DOM**（AC-3 断言：未选标号时该节点数为 0）。
 *   只有「选了标号但确实没有班次」才进空态（`busStop` 24 + 一句原因）。
 */
import Icon from "@/components/ui/Icon";
import TqhTripCard from "./TqhTripCard";
import { groupRouteNos, tripsOfRouteNo, type TqhTrip } from "./tqh-model";

export interface TqhBoardProps {
  trips: TqhTrip[];
  phase: "loading" | "ready" | "failed";
  error: string;
  /** 当前选中的标号（`null` = 未选，下方留白） */
  selected: string | null;
  /** 地图上正在查看的班次码（卡片高亮用） */
  activeTripCode?: string | null;
  onSelect: (routeNo: string) => void;
  onPickTrip: (trip: TqhTrip) => void;
  onRetry: () => void;
  /** 隐藏板（切到澳门板块时置 true）：只切可见性，不卸载 */
  hidden?: boolean;
}

export default function TqhBoard({
  trips,
  phase,
  error,
  selected,
  activeTripCode = null,
  onSelect,
  onPickTrip,
  onRetry,
  hidden = false,
}: TqhBoardProps) {
  const families = groupRouteNos(trips);
  const list = selected ? tripsOfRouteNo(trips, selected) : [];

  return (
    <div
      className="rl-pane rl-pane--tqh"
      data-board="tqh"
      aria-hidden={hidden}
      inert={hidden ? true : undefined}
    >
      {phase === "failed" && (
        <div className="rl-pane__state">
          <p className="rl-sheet__hint">{error || "通琴号班次表加载失败"}</p>
          <button type="button" className="rl-retry" onClick={onRetry}>
            重试
          </button>
        </div>
      )}
      {phase === "loading" && <p className="rl-sheet__hint">载入中…</p>}

      {phase === "ready" && (
        <>
          {/*
            标号栅格：7 列；每族首个标号强制落列 1 ⇒ 自然换行。
            行末空位**留空**（不补位），让"字母族的边界"一眼可读。
          */}
          <div className="rl-board rl-board--tqh" role="group" aria-label="通琴号线路标号">
            {families.map((fam) =>
              fam.routeNos.map((no, i) => {
                const on = selected === no;
                return (
                  <button
                    key={no}
                    type="button"
                    className="rl-chip rl-chip--tqh"
                    style={i === 0 ? { gridColumnStart: 1 } : undefined}
                    data-tqh-no={no}
                    data-family-first={i === 0 ? "1" : undefined}
                    aria-pressed={on}
                    aria-label={`${no} 线${on ? "（已选中）" : ""}`}
                    onClick={() => onSelect(no)}
                  >
                    {no}
                  </button>
                );
              }),
            )}
          </div>

          {/* 未选标号 ⇒ 什么都不渲染（纯留白，.tqh-trip-list 不在 DOM） */}
          {selected && (
            <div className="tqh-trip-list" data-route-no={selected}>
              {list.length === 0 ? (
                <div className="tqh-trip-list__empty">
                  <Icon name="busStop" size={24} />
                  <p>该标号暂无可显示的班次</p>
                </div>
              ) : (
                list.map((t) => (
                  <TqhTripCard
                    key={t.trip_code}
                    trip={t}
                    selected={activeTripCode === t.trip_code}
                    onPick={onPickTrip}
                  />
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
