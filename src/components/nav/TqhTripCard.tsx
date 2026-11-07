"use client";

/**
 * 通琴号班次卡（src/components/nav/TqhTripCard.tsx，2026-11-05 · Spec R2）
 *
 * ── 两行结构（`03-UIUX.md` §6.1 + §17-R1 白字裁决）──────────────────────
 *   ```
 *   [A1线-上班线]                       ← 第 1 行：全称 15px/700，**单行不省略**
 *   [往横琴]                    [08:30发车]   ← 第 2 行：方向 / 计划发车时刻
 *   ```
 *
 * ── 为什么第 1 行绝不省略 ────────────────────────────────────────────────
 *   全部 80 条全称用 15px 排版时最坏上界 225px ≤ 最窄可用宽 260px（320px 屏），
 *   **一行必然放得下** ⇒ 加 `ellipsis` 等于给"将来会省略"发许可（`03-UIUX.md` §6.2）。
 *   守护断言：`data-name-len` + 验收脚本断言 `scrollWidth <= clientWidth + 1`（80 条全过，不抽样）。
 *   ⚠️ **标号不进第一行**（会挤掉 80px ⇒ 立刻破功）；标号由弹窗的选中态与站点弹窗顶部承担。
 *
 * ── 颜色（负责人 §17-R1 裁决：白字 + 主题色卡面）────────────────────────
 *   文字一律 `--tqh-on`（**恒 `#ffffff`**，深色主题也不翻），补偿手段只有两种：
 *   ① 字重 700；② 既有 `text-shadow: 0 1px 1px rgba(0,0,0,.18)`。
 *   白字在 `#ff58a6` 上实测 2.92:1（登记为已知偏差）⇒ **带文字的面不得用换色表达
 *   hover / 按压**，一律走项目统一状态层（`--press-on-color` @ 0.12）+ 形状通道（白环）。
 *
 * ⚠️ 根元素是原生 `<button>`：hover / 按压 / `focus-visible` / 触摸态四条反馈全部来自
 *   `globals.css` 的 button 原语与 `[data-pressed]`（`press-feedback.ts` 白名单含 `[data-press]`）。
 */
import { hhmm, type TqhTrip } from "./tqh-model";

export interface TqhTripCardProps {
  trip: TqhTrip;
  /** 是否正在地图上查看（站点弹窗打开时回写高亮） */
  selected?: boolean;
  onPick: (trip: TqhTrip) => void;
}

export default function TqhTripCard({ trip, selected = false, onPick }: TqhTripCardProps) {
  const name = trip.line_full_name || trip.route_no;
  const dep = hhmm(trip.departure_time);
  return (
    <button
      type="button"
      className="tqh-trip"
      data-press=""
      data-selected={selected ? "1" : undefined}
      data-name-len={name.length}
      aria-label={`${trip.route_no}，${trip.direction}，${dep ? `${dep} 发车，` : ""}${name}`}
      aria-current={selected ? "true" : undefined}
      onClick={() => onPick(trip)}
    >
      <span className="tqh-trip__name">{name}</span>
      <span className="tqh-trip__meta">
        <span className="tqh-trip__dir">{trip.direction}</span>
        {dep && <span className="tqh-trip__time">{dep}发车</span>}
      </span>
    </button>
  );
}
