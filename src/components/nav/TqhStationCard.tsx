"use client";

/**
 * 通琴号 · 站点卡片与「按方向分组的班次列表」（src/components/nav/TqhStationCard.tsx，2026-11-05）
 *
 * ── 两个导出，一个语义（负责人裁决 5）──────────────────────────────────
 *   · `TqhStationTrips`：按**方向分组**（往澳门 / 往横琴，组序固定）的班次行，
 *     组内按**计划发车时刻**升序。两处复用：
 *       ① 点**通琴号专用站** → 独立卡片（`TqhStationCard`）；
 *       ② 点**关联巴士站** → 原巴士卡片（`StationCard`）**下方追加**这一块（无报站信息）。
 *   · `TqhStationCard`：独立卡片外壳（复用 `.nav-station-card` 的既有卡片语汇，
 *     不另造一套视觉）。
 *
 * ── ★ 2026-11-06（修复批 #1 / R1）：同物理点合并组 ──────────────────────
 *   `same_place_group` 已批的 1 组（`澳门科技大学南门（新濠天地）①` + `②`，间距 1.0 m）
 *   在地图上**只画一个标** ⇒ 卡片要能承载**多个通琴号站**：
 *     · 标题 = 组内站名去掉圈码后的共同名（`mergedTitleOf`），单站时就是站名本身；
 *     · **body 按原站各自成组**（①、② 不混在一起，R1 原文），组头 = 该站完整站名；
 *     · 单站（`entries.length === 1`）⇒ **不渲染分组容器**，DOM 与改前一致（零回归）。
 *
 * ── 为什么没有报站 ────────────────────────────────────────────────────
 *   通琴号是**静态时刻表**（官方无实时数据源）。这里只出现「计划发车时刻」，
 *   任何「还有 N 分钟 / 即将发车 / 实时」字样都属幻觉文案，禁止。
 *
 * ── 颜色 ──────────────────────────────────────────────────────────────
 *   标号 chip 走主题色底 + 白字（`--tqh-accent` / `--tqh-on`，与弹窗标号同款），
 *   `text-shadow` 与 `.rl-chip` 同值（唯一允许的两种补偿之一）。
 */
import Icon from "@/components/ui/Icon";
import {
  hhmm,
  mergedTitleOf,
  type TqhSide,
  type TqhStation,
  type TqhStationEntry,
  type TqhStationGroup,
  type TqhTrip,
} from "./tqh-model";

const DIR_ORDER: TqhStationGroup["direction"][] = ["往澳门", "往横琴"];

export interface TqhStationTripsProps {
  groups: TqhStationGroup[];
  /** 地图上正在查看的班次（行高亮） */
  activeTripCode?: string | null;
  onPickTrip: (trip: TqhTrip) => void;
  /** 加载中 / 失败（上层数据阶段） */
  phase?: "loading" | "ready" | "failed";
  /**
   * ★ 2026-11-06（修复批 #6c）：**导航进行中 ⇒ 班次行不可选**（视觉禁用 + 点击无动作）。
   *
   * 为什么需要（与 `StationCard` 的 `pickLineDisabled` **同一套**理由与实现）：
   *   导航中禁用「跳线路查看」（#4 裁决），若通琴号班次行不禁用，同一张卡片里就会出现
   *   「一行点了没反应、另一行点了直接跳走」—— 不报错、不崩，只是行为不一致，
   *   且没有任何视觉暗示，属沉默逻辑错误。
   *
   * ⚠️ 三条硬约束（照抄线路行的既有做法，别另造一套）：
   *   ① **不用原生 `disabled`** —— 原生禁用会吃掉点击事件、焦点也不可预期；
   *      这里保留按钮语义，只加 `aria-disabled` + `tabIndex={-1}` + 行内视觉降级；
   *   ② **不隐藏行** —— 隐藏会让卡片高度跳变，与「导航中点开站卡只是想看一眼」的意图冲突；
   *   ③ 点击必须**无报错、无跳转**（`onClick` 里早退，而不是让异常冒泡）。
   */
  disabled?: boolean;
}

export function TqhStationTrips({
  groups,
  activeTripCode = null,
  onPickTrip,
  phase = "ready",
  disabled = false,
}: TqhStationTripsProps) {
  if (phase === "loading") return <p className="tqh-trips__hint t-label t-muted">读取通琴号班次…</p>;
  if (phase === "failed") return <p className="tqh-trips__hint t-label t-muted">通琴号班次暂时取不到</p>;
  if (groups.length === 0) return <p className="tqh-trips__hint t-label t-muted">本站暂无通琴号班次</p>;

  return (
    <div className="tqh-trips">
      {DIR_ORDER.map((dir) => {
        const g = groups.find((x) => x.direction === dir);
        if (!g || g.trips.length === 0) return null;
        return (
          <div className="tqh-trips__group" key={dir} data-direction={dir}>
            <p className="tqh-trips__head t-label">
              {dir}
              <span className="tqh-trips__count">{g.trips.length} 班</span>
            </p>
            {g.trips.map((t) => (
              <button
                key={t.trip_code}
                type="button"
                className="tqh-row"
                data-press=""
                data-selected={activeTripCode === t.trip_code ? "1" : undefined}
                /* 观测钩子：QA 据此断言「导航中班次行确实被禁用」（与线路行 `data-line-pick` 同族命名） */
                data-trip-pick={disabled ? "disabled" : "on"}
                aria-disabled={disabled ? "true" : undefined}
                /* 禁用时移出 Tab 序列（与 `StationCard` 线路行 `tabIndex: pickDisabled ? -1 : 0` 同口径） */
                tabIndex={disabled ? -1 : undefined}
                aria-label={`${t.route_no}，${t.direction}，${hhmm(t.departure_time)} 发车，${t.line_full_name}`}
                /**
                 * 行内视觉降级（不新增 CSS 规则 —— 与线路行 `style={…}` 同一写法）：
                 *   `cursor: not-allowed` 是「知道可点但当前不行」的标准语义；
                 *   `opacity: 0.45` 与线路行禁用态**同一个值**（两处不能各挑一个数）。
                 * 高亮态（`data-selected`）不改 —— 禁用不等于"没选中"，别把状态也抹掉。
                 */
                style={disabled ? { cursor: "not-allowed", opacity: 0.45 } : undefined}
                onClick={() => {
                  if (disabled) return; // ← 无跳转、无报错（不是吞异常，是明确的早退）
                  onPickTrip(t);
                }}
              >
                <span className="tqh-row__no" aria-hidden="true">
                  {t.route_no}
                </span>
                <span className="tqh-row__name">{t.line_full_name}</span>
                <span className="tqh-row__time">{hhmm(t.departure_time)}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export interface TqhStationCardProps {
  /**
   * 该 marker 代表的通琴号站（1..n）。
   * `> 1` = `same_place_group` 合并组（当前只有澳科大南门 ①②）。
   */
  stations: TqhStation[];
  /** 与 `stations` 一一对应的方向分组（`tqhEntriesAtStations` 产出） */
  entries: TqhStationEntry[];
  activeTripCode?: string | null;
  onPickTrip: (trip: TqhTrip) => void;
  onClose: () => void;
  phase?: "loading" | "ready" | "failed";
  /**
   * ★ 2026-11-06（修复批 #6c）：**导航进行中 ⇒ 班次行禁用**（宿主传 `navActive`）。
   * 语义与实现见 `TqhStationTripsProps.disabled`。缺省 `false` ⇒ DOM 与改前一致。
   */
  pickTripDisabled?: boolean;
}

/** 侧标（澳 / 琴）：取代表站 */
function sideOf(stations: TqhStation[]): TqhSide {
  return stations[0]?.side === "横琴" ? "横琴" : "澳门";
}

export default function TqhStationCard({
  stations,
  entries,
  activeTripCode = null,
  onPickTrip,
  onClose,
  phase = "ready",
  pickTripDisabled = false,
}: TqhStationCardProps) {
  const count = entries.reduce((n, e) => n + e.groups.reduce((m, g) => m + g.trips.length, 0), 0);
  const title = mergedTitleOf(stations);
  const side = sideOf(stations);
  const merged = stations.length > 1;

  return (
    <div className="nav-station-card nav-station-card--tqh" role="dialog" aria-label={`通琴号站点 ${title}`}>
      <div className="nav-station-card__head">
        <span className="nav-station-card__name">
          <span className={`nav-side-tag nav-side-tag--${side === "横琴" ? "hq" : "mo"}`} aria-label={`${side}侧`}>
            {side === "横琴" ? "琴" : "澳"}
          </span>{" "}
          {title}
        </span>
        <button className="nav-station-card__close" type="button" aria-label="关闭" onClick={onClose}>
          <Icon name="close" size={20} />
        </button>
      </div>

      {phase === "ready" && count > 0 && (
        <p className="nav-station-card__meta">通琴号 · {count} 个班次</p>
      )}

      <div className="nav-station-card__list">
        {/*
          加载 / 失败 / 无班次：只出一条降级文案（`TqhStationTrips` 自带，不含实时/分钟字样）。
        */}
        {phase !== "ready" || !entries.length ? (
          <TqhStationTrips
            groups={[]}
            onPickTrip={onPickTrip}
            phase={phase}
            disabled={pickTripDisabled}
          />
        ) : merged ? (
          /*
            合并组 ⇒ 按原站（①/②）各自成组（R1）；单站 ⇒ 直接出方向分组，不套分组容器
            （DOM 与改前一致，避免给 96 个纯通琴号站引入无意义的框）。
          */
          entries.map((e) => (
            <div className="st-group" key={e.station.id} data-tqh-station-group={e.station.id}>
              <div className="st-group__head">
                <span className="st-group__code">{e.station.name}</span>
              </div>
              <TqhStationTrips
                groups={e.groups}
                activeTripCode={activeTripCode}
                onPickTrip={onPickTrip}
                phase="ready"
                disabled={pickTripDisabled}
              />
            </div>
          ))
        ) : (
          entries.map((e) => (
            <TqhStationTrips
              key={e.station.id}
              groups={e.groups}
              activeTripCode={activeTripCode}
              onPickTrip={onPickTrip}
              phase="ready"
              disabled={pickTripDisabled}
            />
          ))
        )}
      </div>
    </div>
  );
}
