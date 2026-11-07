"use client";

/**
 * 车辆信息卡（src/components/nav/VehicleCard.tsx，v2.10.0；★ v3.6.1 降级态）
 *
 * ── 内容（Spec AC-06；★ v3.6.0 AC-20 起不再含「车速」）────────────────
 *   状态 / 当前站 / 下一站 / 行驶区间（站号+站名 → 站号+站名）/ 车牌 / 末班 / 数据时间。
 *
 * ★ v3.6.0（AC-20）：DSAT 的 `speed` 延迟极大、不可信 ⇒ 卡片**不再展示任何速度数值**
 *   （原「N km/h」行已删除；接口出口与前端类型也同步删除该字段，避免复活）。
 *
 * ── ★ v3.6.1：缺数据时**不许只显示一个「—」**──────────────────────────────
 *   车卡是用户点开才看的详情，出现一整行破折号等于"这卡坏了"。三处降级口径：
 *     · 区间未知 ⇒ 「站名未知 · 以车牌为准」（明确告诉他"还能靠车牌认车"，而不是留白）；
 *     · 数据时间未知 ⇒ 值位显示「未知」（右侧不再出现孤立破折号）；
 *     · 状态未知 ⇒ `VEHICLE_STATE_LABEL` 兜底「状态未知」（既有行为，未改）。
 *
 * ── ★ v3.6.1：新增两个**可选**站信息槽（供上层按可用性填）─────────────────
 *   `atStation`（当前停靠站）· `nextStop`（下一站）。
 *   · **未传 ⇒ 完全保持 v3.6.0 的行结构**（零视觉变化）——本组件被多处复用，
 *     不能因为"另一名成员要补数据"就把所有调用方的卡片都改成四行；
 *   · `atStation` 传了 ⇒ 画「当前站」行（比原来塞在区间行里的「停靠 XX」更清楚）；
 *   · `nextStop` 传了且**没有精确区间**才画「下一站」行 —— `interval.to` 本身就是下一站，
 *     两者同时画就是同一件事说两遍。
 *
 * ── ★ 2026-11-06（#6 站序弹窗）：再加两个**可选**槽位（同一条纪律：不传 = 零变化）──
 *   `company`（运营商：澳巴 / 新福利）· `stopsAwayText`（距终点还有几站，文案由调用方算）。
 *   · 两者**只有站序弹窗里的巴士卡**会传（负责人要求那张卡给「车牌、运营商、状态、
 *     还有几站」四件事）；地图车卡（`NavShell`）不传 ⇒ 行结构与 v3.6.1 完全一致。
 *   · 只复用既有 `.nav-vehicle-card__row / __k / __v` ⇒ **零新增 CSS**。
 *
 * ── 设计裁定（设计师已论证，务必遵守）────────────────────────────────
 *   「行驶区间」**只表方向**：实心点 →（虚线）→ 空心点。
 *   **不做「已行进进度」填充** —— 接口只给 from→to，画进度是**伪造精度**。
 *
 * ── 落位 ──────────────────────────────────────────────────────────────
 *   复用站点信息卡 `.nav-station-card` 的绝对定位/层级（z-index 30），
 *   只补行与状态徽标样式（见 globals.css `.nav-vehicle-card__*`）。
 *   ⚠️ 新增行**一律复用既有 `__row` / `__k` / `__v`**，不新增尺寸/间距规格。
 */
import Icon from "@/components/ui/Icon";
import { VEHICLE_STATE_LABEL, type VehicleLite } from "./VehicleMarker";

/** 站点引用（与 `VehicleLite.atStation` / `interval.to` 同形，避免上层再定义一套） */
export interface VehicleStopRef {
  code: string;
  name: string;
}

export interface VehicleCardProps {  vehicle: VehicleLite;
  /** 合并组内车辆数（>1 时提示） */
  count?: number;
  /** 数据取得时间（ISO 字符串，来自响应 `fetchedAt`） */
  fetchedAt?: string | null;
  /**
   * ★ v2.10.1（用户口径）：车牌前的**线路主题色标签**用。
   *   `lineLabel` = 线路名（如「26」/「氹仔线」）；`lineColor` = 该线主题色。
   */
  lineLabel?: string;
  lineColor?: string;
  /**
   * ★ v3.6.1：当前停靠站（**可选**；不传则回落 `vehicle.atStation`，都没有就不画该行）。
   */
  atStation?: VehicleStopRef | null;
  /** ★ v3.6.1：下一站（**可选**；不传或已有精确区间时不画该行）。 */
  nextStop?: VehicleStopRef | null;
  /**
   * ★ 2026-11-06（#6 站序弹窗）：**运营商**（`澳巴` / `新福利`，已由调用方归一成中文）。
   *   不传 ⇒ 与 v3.6.1 的行结构**逐字节一致**（本卡被地图车卡/站序弹窗共用，
   *   不能因为一处要补信息就把所有调用方都改成多一行）。
   *   ⚠️ 只有站序弹窗里的巴士卡传它 —— 负责人明确要求那张卡显示运营商
   *      （地图车卡自 v2.10.1 起按用户口径「运营商不再显示」，那条口径不变）。
   */
  company?: string | null;
  /**
   * ★ 2026-11-06（#6 站序弹窗）：**距本方向终点还有几站**的一句话（如「还有 3 站到 氹仔碼頭」）。
   *   由调用方算好（它才知道站序全长），本卡只负责渲染一行 —— 计算不进展示组件。
   */
  stopsAwayText?: string | null;
  onClose: () => void;
}

/**
 * ISO → 澳门时间 HH:MM（UTC+8；卡片是交互后才挂载的客户端组件，无 SSR 水合问题）
 * @returns `null` = 没有可用时间（调用方显示「未知」，**不要**显示破折号）
 */
function macauHm(iso?: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 站名一行文本（站号 + 站名；站名缺失时只给站号，仍比空白有用） */
function stopText(s: VehicleStopRef): string {
  return s.name ? `${s.code} ${s.name}` : s.code;
}

export default function VehicleCard({
  vehicle,
  count = 1,
  fetchedAt = null,
  lineLabel,
  lineColor,
  atStation,
  nextStop,
  company = null,
  stopsAwayText = null,
  onClose,
}: VehicleCardProps) {
  const state = vehicle.status;
  const stateLabel = VEHICLE_STATE_LABEL[state] ?? "状态未知";
  const interval = vehicle.interval;
  /**
   * 当前站：props 优先（上层可能有更准的报站数据），其次 `vehicle.atStation`。
   * 两者都是 `{code,name}`，同一个渲染分支。
   */
  const at = atStation ?? vehicle.atStation ?? null;
  /**
   * 下一站：**有精确区间时不画** —— 区间行右侧那一段（`interval.to`）就是下一站，
   * 再画一行「下一站 X」等于同一事实说两遍。
   */
  const next = interval ? null : (nextStop ?? null);
  /**
   * 当前站行是否渲染：`at` 有值 **且** 区间行没有把它说掉。
   * 停靠中的车常常 `interval.from.code === atStation.code`（刚离站/正在站上），
   * 那时再来一行「当前站 X」就是把同一事实说两遍 ⇒ 只在区间覆盖不到它时才画。
   */
  const showAt = !!at && !(interval && (interval.from.code === at.code || interval.to.code === at.code));
  /**
   * 区间行是否渲染：三条判定，避免"自相矛盾"和"重复说"。
   *   · 有精确区间 ⇒ 画（正常路径）；
   *   · 没有任何站信息 ⇒ 画（此行承担降级文案「站名未知 · 以车牌为准」）；
   *   · 只有当前站/下一站 ⇒ **不画**（上面两行已说清位置，再补一句"区间未知"是噪音）。
   */
  const showInterval = !!interval || (!at && !next);
  const fetchedHm = macauHm(fetchedAt);

  return (
    <section
      className="nav-station-card nav-vehicle-card"
      role="dialog"
      /**
       * ★ v3.6.1：可见文字只有编号（`HE380`），读屏只念一串字母等于没信息
       *   ⇒ 语义由容器承担（第 13 项验收：应念「车辆 AA7312，车队编号 HE380」）。
       */
      aria-label={`车辆 ${vehicle.plate}${vehicle.busCode ? `，车队编号 ${vehicle.busCode}` : ""}`}
    >
      <div className="nav-station-card__head">
        <span className="nav-station-card__name nav-vehicle-card__title">
          {/* ★ v2.10.1：车牌**前**加线路名主题色标签（用户口径）；运营商不再显示 */}
          {lineLabel && (
            <span
              className="nav-vehicle-card__line"
              style={{ background: lineColor ?? "var(--primary)" }}
            >
              {lineLabel}
            </span>
          )}
          {/* ★ v3.6.1：澳门车牌标签（黑底黄字，md 档）。
              `nav-vehicle-card__plate` 保留 ⇒ 仍负责标题行内的 flex 定位；
              视觉全部由 `.plate` 提供。无 aria：`section` 已有 `aria-label={车辆 ${plate}}`。 */}
          <span className="plate plate--md nav-vehicle-card__plate">{vehicle.plate}</span>
          {/*
            ★ v3.6.1：车队编号角标（`HE380`）。顺序 `[线路][车牌][编号][末班]` 不可调 ——
            车牌与编号同指**一台车**，相邻才有归属感；末班是**状态**，放最外。
            ⚠️ 判据必须是 `vehicle.busCode && …`：后端刻意让缺字段**整个键不存在**，
              写成 `busCode !== null` 会因 `undefined !== null` 成立而渲染出空角标。
          */}
          {vehicle.busCode && (
            <span className="vcode" title="车队编号">
              {vehicle.busCode}
            </span>
          )}
          {vehicle.isLast ? (
            <span className="nav-vehicle-card__last" title="末班车" aria-label="末班车">
              末班
            </span>
          ) : null}
        </span>
        <button
          type="button"
          className="nav-station-card__close"
          aria-label="关闭车辆信息"
          title="关闭"
          onClick={onClose}
        >
          <Icon name="close" size={20} />
        </button>
      </div>

      <div className="nav-vehicle-card__rows">
        {/* 状态 */}
        <div className="nav-vehicle-card__row">
          <span className="nav-vehicle-card__k t-label">状态</span>
          <span className="nav-vehicle-card__state" data-state={state}>
            {stateLabel}
          </span>
        </div>

        {/* ★ v3.6.0（AC-20）：原「车速 km/h」行已删除 —— 该字段延迟极大、不可信，不再作为任何参考 */}

        {/* ★ 2026-11-06（#6）：运营商（只有站序弹窗的巴士卡传；不传则整行不存在） */}
        {company && (
          <div className="nav-vehicle-card__row">
            <span className="nav-vehicle-card__k nav-vehicle-card__k--nowrap t-label">
              <Icon name="bus" size={16} /> 运营商
            </span>
            <span className="nav-vehicle-card__v">{company}</span>
          </div>
        )}

        {/* ★ 2026-11-06（#6）：距终点还有几站（文案由调用方算，见 `stopsAwayText`） */}
        {stopsAwayText && (
          <div className="nav-vehicle-card__row">
            <span className="nav-vehicle-card__k nav-vehicle-card__k--nowrap t-label">
              <Icon name="destination" size={16} /> 到终点
            </span>
            <span className="nav-vehicle-card__v">{stopsAwayText}</span>
          </div>
        )}

        {/* ★ v3.6.1：当前站（拿不到就不画这一行，绝不显示占位破折号） */}
        {showAt && at && (
          <div className="nav-vehicle-card__row">
            <span className="nav-vehicle-card__k nav-vehicle-card__k--nowrap t-label">
              <Icon name="busStop" size={16} /> 当前站
            </span>
            <span className="nav-vehicle-card__v">{stopText(at)}</span>
          </div>
        )}

        {/* ★ v3.6.1：下一站（仅在无精确区间时出现，避免与区间行重复） */}
        {next && (
          <div className="nav-vehicle-card__row">
            <span className="nav-vehicle-card__k nav-vehicle-card__k--nowrap t-label">
              <Icon name="forward" size={16} /> 下一站
            </span>
            <span className="nav-vehicle-card__v">{stopText(next)}</span>
          </div>
        )}

        {/*
          ★ v2.10.1（用户口径）：**区间改为两行**（站号+站名 ‖ 站号+站名）
          —— 原先横向排一行，长站名会把后半段挤成省略号（如「T354 氹仔…」）✗
          两行后每段独占一行、可完整显示；中间用竖线分隔，方向感仍保留。
          ⚠️ 仍**不做「已行进进度」填充**（接口只给 from→to，画进度是伪造精度）。
          ★ v3.6.1：站信息全缺时给**有意义的降级文案**（原为一个孤立「—」）。
        */}
        {showInterval && (
          <div className="nav-vehicle-card__row nav-vehicle-card__row--stack">
            <span className="nav-vehicle-card__k t-label">
              <Icon name="route-2" size={16} /> 区间
            </span>
            <span className="nav-vehicle-card__interval2">
              {interval ? (
                <>
                  <span className="nav-vehicle-card__seg">{`${interval.from.code} ${interval.from.name}`}</span>
                  <span className="nav-vehicle-card__pipe" aria-hidden="true" />
                  <span className="nav-vehicle-card__seg">{`${interval.to.code} ${interval.to.name}`}</span>
                </>
              ) : (
                <span className="nav-vehicle-card__seg">站名未知 · 以车牌为准</span>
              )}
            </span>
          </div>
        )}

        {/* 数据时间（★ 标签强制不换行 —— 原先窄屏下「数据时间」四字会拆行） */}
        <div className="nav-vehicle-card__row">
          <span className="nav-vehicle-card__k nav-vehicle-card__k--nowrap t-label">
            <Icon name="timer" size={16} /> 数据时间
          </span>
          <span className="nav-vehicle-card__v">{fetchedHm ?? "未知"}</span>
        </div>
      </div>

      {/* 合并组提示（★ v3.6.1：区间缺失的说明已上移到区间行，此处不再重复） */}
      {count > 1 && <p className="nav-vehicle-card__note t-label">{`此处合并显示 ${count} 辆车。`}</p>}
    </section>
  );
}
