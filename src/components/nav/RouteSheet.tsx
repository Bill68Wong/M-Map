"use client";

/**
 * 单宿主三档面板（src/components/nav/RouteSheet.tsx，2026-09-23 新增）
 *
 * ── 架构决策（技术方案 §2.1）────────────────────────────────────────────
 *   **单一 Bottom Sheet 宿主 + 内容切换（列表 ⇄ 详情）**，而非两个独立全屏弹窗叠加
 *   （叠加会出现「推荐层露在详情层之上」的怪异层叠 + 手势冲突）。收益：
 *     · 高度联动是一条 `transform`，最平滑；
 *     · **列表 pane 常驻不卸载** ⇒ 保滚动位置、秒回；
 *     · 消除双层高度打架。
 *
 * ── 三档（§2.2）────────────────────────────────────────────────────────
 *   `full`（近全屏，推荐默认）/ `half`（下半屏，详情默认）/ `peek`（20% 收起档）。
 *   吸附与关闭链路见 `useSnapSheet`（逐对阈值、flick 跨档、peek 越界关闭）。
 *
 * ── 关闭链路（§2.3.1）──────────────────────────────────────────────────
 *   · 推荐 pane：X / peek 下拉 → **关闭面板**（回半屏可出发 / 无 OD 回全屏地图）；
 *   · 详情 pane：X / 返回箭头 / peek 下拉 → **回推荐列表**（`full`，保滚动）。
 *   语义由 `onContextClose` 统一承担（调用方按 pane 决定）。
 *
 * ── 内容切换（先动后填，PM §2.3）────────────────────────────────────────
 *   点卡片**当帧**切 pane + 启动 `full→half` 动画 + 骨架；详情数据并行拉取（动画不被网络阻塞）。
 *
 * ⚠️ 挂载位置：必须挂在 `.nav-map-wrap` **之外**（层叠上下文，Spec AC-13 教训）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import Icon from "@/components/ui/Icon";
import ComplianceBar from "@/components/nav/ComplianceBar";
import FavoriteButton from "@/components/favorites/FavoriteButton";
import RouteStack from "@/components/RouteStack";
import { macauClock } from "@/components/RoutePieces";
import BottomSheet from "./BottomSheet";
import NavAlarmOverlay from "./NavAlarmOverlay";
import NavTrackBar from "./NavTrackBar";
import RouteDetailPane from "./RouteDetailPane";
import RouteResultPane from "./RouteResultPane";
import { useRecommend, type PrefMode } from "./useRecommend";
import { COOLDOWN_RECOMMEND_SEC, useCooldown } from "./useCooldown";
import { useSnapSheet } from "./useSnapSheet";
import type { DetailBody, FoldState } from "./useDetailBody";
import type { RideTrackView } from "./useRideTracking";
import { DETENTS, detentIndex, type Detent } from "./sheet-detents";
import type { FavoriteEndpoint } from "@/lib/favorites/types";
import type { RecommendCard } from "@/lib/recommend/types";

export interface RouteSheetDetail {
  card: RecommendCard;
  degraded: boolean;
  destLabel: string;
  phase: "idle" | "loading" | "ready" | "failed";
  body: DetailBody | null;
  /** 该详情当前在途车辆数（观测钩子 `data-live` 用） */
  vehicles: number;
  reload: () => void;
  /**
   * ★ v3.7.0（C5）：折叠栏「本站台其他线路」的实时报站改为**展开时才查**（首包省 ~3s）。
   *   `foldState` = 三/四态判据（`idle/loading` 不得显示「暂无到站信息」）；
   *   `onLoadFold` = 折叠栏首次展开时调用（幂等，宿主 `useRouteOverview` 透传）。
   */
  foldState?: FoldState;
  onLoadFold?: () => void;
  /** ★ 2026-09-24：导航追踪态（宿主注入；缺省 = 静态详情） */
  track?: RideTrackView | null;
  /** ★ 目的地坐标（可切换方案查询用） */
  destCoord?: { lng: number; lat: number } | null;
  /** ★ 点「切过去」→ 打开新方案导航 */
  onSwitchCard?: (card: RecommendCard, degraded: boolean) => void;
}

export interface RouteSheetProps {
  open: boolean;
  pane: "recommend" | "detail";
  detent: Detent;
  /** 各档顶边像素（升序，与 DETENTS 对齐） */
  topsPx: number[];
  onDetentChange: (d: Detent) => void;
  /** contextual 关闭：推荐→关面板；详情→回推荐（调用方按 pane 决定） */
  onContextClose: () => void;
  odLabel: string;
  query: string;
  colors: Record<string, string>;
  fav?: { from: FavoriteEndpoint; to: FavoriteEndpoint } | null;
  detail?: RouteSheetDetail | null;
  onOpenDetail: (card: RecommendCard, degraded: boolean) => void;
  /** ★ v3.6.0 S5：步行跟随相关（宿主提供，见 NavShell 的 walk 装配） */
  walk?: {
    /** ★ T1：进入跟随（`out` = 走到上车站 · `in` = 下车站走到目的地）。
     *  ★ v3.9.0：`onStart` 字段已删——「开始步行」按钮删除后无消费方；
     *  步行进入只走「开始导航」的 `startSession("out")`（全自动推进①~④不变）。 */
    onExpand: (seg: "out" | "in") => void;
    preview: import("./NavDetailBody").WalkPreview;
    /** ★ T1：末段步行预览（下车站 → 目的地） */
    previewIn?: import("./NavDetailBody").WalkPreview;
    /** ★ 是否**正在跟随**（walk 态）—— 决定是否禁 peek */
    active?: boolean;
  } | null;
  /** ★ 2026-09-25：全屏化（导航中隐藏底导、收敛间距） */
  immersive?: boolean;
}

export default function RouteSheet({
  open,
  pane,
  detent,
  topsPx,
  onDetentChange,
  onContextClose,
  odLabel,
  query,
  colors,
  fav = null,
  detail = null,
  onOpenDetail,
  walk = null,
  immersive = false,
}: RouteSheetProps) {
  // 推荐列表数据（列表 pane 常驻；同一 query + prefs 只自动拉一次）
  /** ★ 本批（需求⑧ / AC-52/53）：三档偏好（默认综合） */
  const [pref, setPref] = useState<PrefMode>("balanced");
  /** ★ v3.3.0（AC-105）：轻轨优先开关（与三档**正交**的独立布尔；同一行右侧） */
  const [lrtFirst, setLrtFirst] = useState(false);
  const rec = useRecommend(query, open && pane === "recommend", pref, lrtFirst);

  /* ── ★ 本批：详情吸底操作条（`.nav-actions` 移出滚动容器 → 挂面板根）所需派生值 ── */
  const dTrack = detail?.track ?? null;
  const dStrips = detail?.body?.strips ?? null;
  const dLegIdx = dTrack?.legIndex ?? 0;
  const dLegRide = detail?.card.rides[dLegIdx] ?? null;
  const dFirst = detail?.card.rides[0] ?? null;
  const dTrackStops = dStrips?.[dLegIdx]?.stops ?? [];
  const dRouteLabel = dLegRide
    ? dLegRide.kind === "lrt"
      ? `轻轨 ${dLegRide.route.replace(/^LRT-/, "")}`
      : `${dLegRide.route} 路`
    : "";
  const dLrt = dLegRide?.kind === "lrt";
  /**
   * ★★ S4 评审阻断 ③：**刷新作用域**。
   *   `fetchFrame` 对非巴士腿直接 return（刷不出任何东西）⇒ 轻轨段点刷新
   *   若仍进冷却，就是"给了一个什么都不会发生的冷却"（设计 §2.6 特意禁用该反模式）。
   *
   * ★★ S4 复验阻断（语域过宽）：**推荐 pane 恒 `"bus"`** —— 整表重查（`/api/nav`）
   *   与车辆数据无关，不做「追踪腿」意义上的刷新。
   *   ⚠️ 旧实现按「首卡首段是否轻轨」归零 scope ⇒ 若首卡是轻轨，推荐 pane 的
   *      `data-cooldown` 变 `off`、`paneCoolingVisible` 归 0，但 `recCooldown` **仍在跑**
   *      ⇒ **冷却在跑但视觉静默 = 点了没反应**（正是用户原投诉的翻版）。
   *   ⇒ 只有 detail pane 才按当前追踪腿的 `kind` 判定。
   */
  const refreshScope: "bus" | "lrt" =
    pane === "recommend"
      ? "bus" /* 推荐 pane 恒 bus：整表重查不依赖车辆数据；若按首卡类型归零 ⇒ 冷却在跑但视觉静默 */
      : detail?.card?.rides?.[detail.track?.legIndex ?? 0]?.kind === "lrt"
        ? "lrt"
        : "bus";
  /**
   * 新鲜度（AC-24）：每秒重算「上次更新：N 秒前」。
   * ★ v3.7.0 S2（D5）：**只读 `lastVehicleTs`**（车辆帧专用）—— 旧字段被 GPS 帧污染，
   *   车辆接口失败而 GPS 正常时会永远显示 0~3 秒（静默算错，不是崩溃）。
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (dTrack?.phase !== "riding") return;
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [dTrack?.phase]);
  const dFreshSec =
    dTrack && dTrack.lastVehicleTs > 0
      ? Math.max(0, Math.floor((nowMs - dTrack.lastVehicleTs) / 1000))
      : null;

  /** 详情吸底操作条（挂面板根 `.route-sheet__actions-slot`） */
  const detailActions: ReactNode =
    pane === "detail" && detail && dTrack ? (
      <NavTrackBar
        phase={dTrack.phase}
        routeLabel={dRouteLabel}
        boardLabel={dLegRide?.boardLabel ?? dFirst?.boardLabel ?? ""}
        alightLabel={
          (dTrackStops.length ? dTrackStops[dTrackStops.length - 1].label : "") ||
          dLegRide?.alightLabel ||
          dFirst?.alightLabel ||
          ""
        }
        plate={dTrack.plate}
        source={dTrack.progressSource === "gps" ? "gps" : dTrack.plate ? "vehicle" : "manual"}
        alarm={dTrack.alarm}
        lrt={dLrt}
        traveling={dTrack.traveling}
        coolingSec={dTrack.refreshCoolingSec}
        refreshScope={refreshScope}
        boardDetect={dTrack.boardDetect}
        anomaly={dTrack.anomaly}
        note={dTrack.note}
        freshSec={dFreshSec}
        justAlighted={dTrack.justAlighted}
        /* ★ v3.7.0 S3：匹配态四件套（`data-board-match` / `data-match-source` / `data-match-pending` / 待确认车牌） */
        boardMatch={dTrack.boardMatch}
        matchSource={dTrack.matchSource}
        matchPending={dTrack.matchPending}
        pendingPlate={dTrack.pendingPlate}
        onStart={dTrack.onStart}
        onBoard={dTrack.onBoard}
        onAlight={dTrack.onAlight}
        onRepick={dTrack.onNotThisBus}
        onRefresh={dTrack.onRefresh}
        onStop={dTrack.onStop}
        onNotBoard={dTrack.onNotBoard}
        onNotArrive={dTrack.onNotArrive}
      />
    ) : null;

  /**
   * ★ v3.2.0（需求 12 / AC-86/87/88）：头部按钮重构 —— **左上双态 + 右上情境化刷新**。
   *   · 左上（两 pane 均渲染）：`recommend` ⇒ 关闭面板；`detail`/`riding` ⇒ 返回推荐列表；同调 `onContextClose()`。
   *   · 右上：`recommend` ⇒ 重查推荐；`detail`/`riding` ⇒ 刷新巴士数据；busy 自旋 + `aria-disabled`。
   *   ⚠️ 用 `aria-disabled`（非原生 disabled）：本栏是**拖动把手**，原生 disabled 按钮会**吞掉 pointerdown**
   *      ⇒ 在把手区形成死区、破坏拖拽；`aria-disabled` + 点击守卫即可防重复点击且保留无障碍语义。
   */
  const refreshBusy = pane === "recommend" ? rec.phase === "loading" : detail?.phase === "loading";
  /**
   * ★ v3.6.0 S4：**推荐列表刷新的 5s 冷却**（口径表：每次 ≈1 次高德 transit + 9~13 个 DSAT 桶，
   *   成本最高）。旧版只有 `refreshBusy`（HTTP 往返 ≈1s）⇒ 用户可「一秒刷一次」，既重复扣配额
   *   又让列表数字高频跳动。detail/riding 的刷新冷却在 `useRideTracking.refreshNow` 内。
   */
  const recCooldown = useCooldown(COOLDOWN_RECOMMEND_SEC);
  const recCoolingSec = recCooldown.sec;

  /**
   * ★★ S4 评审阻断 ②：**顶栏刷新键的冷却必须按当前 pane 取**。
   *   旧实现顶栏视觉只接 `recCoolingSec`（推荐冷却），于是：
   *     · boarding 态 —— 冷却其实在 `refreshNow` 里生效，但顶栏永远 idle
   *       （而且候车态吸底条**没有**刷新键，顶栏是唯一入口）⇒ 点第 2 次起**静默无反应**；
   *     · riding 态 —— 顶栏 idle，倒计时却在吸底条（用户不知道该看哪个）。
   *   这正是用户原话「刷新没反应」的翻版：冷却从 1s 变 5s，但反馈丢了。
   */
  const paneCoolingSec = pane === "recommend" ? recCoolingSec : (detail?.track?.refreshCoolingSec ?? 0);

  /** 轻轨段刷新永不进冷却（也永不显示倒计时） */
  const paneCoolingVisible = refreshScope === "bus" ? paneCoolingSec : 0;

  /**
   * ★ v3.6.0 S4：推荐 pane 的刷新改走 `reload({ nocache: true })` ——
   *   用户主动点刷新时不接受服务端 `transit_cache` 的旧结果；
   *   自动首载/切换偏好仍走缓存（`load` 不带 nocache），省配额。
   *   列表合并在 `useRecommend` 内完成（`mergeCardsStable`），此处无需关心。
   */
  const onRefreshClick = () => {
    if (refreshBusy) return;
    if (pane === "recommend") {
      if (recCooldown.cooling) return; // ★ 5s 冷却门（与 UI 的 aria-disabled 双重保障）
      rec.reload({ nocache: true });
      recCooldown.start();
      return;
    }
    if (detail?.track?.onRefresh) detail.track.onRefresh();
    else detail?.reload?.();
  };

  /**
   * ★ 2026-09-25：`.route-sheet` 根 ref —— 供 `useSnapSheet` 拖动期**命令式**写 `--sheet-y-anim`
   *   （不逐帧 `setState` ⇒ 不再占满主线程 ⇒ 地图渲染循环不被饿死，「拖动时地图抖动」落定）。
   */
  const sheetRef = useRef<HTMLElement | null>(null);

  /**
   * ★ v3.6.0 S5：**walk 态禁 peek**（设计要求：强制 half、允许 full、禁 peek ——
   *   peek 会把"当前步"藏掉）。
   *   · `walkActive` 时只允许 `full` + `half`；其余 pane **不传**该参 ⇒ 行为一行不变；
   *   · 进 walk 时若停在 peek ⇒ 立即 snap 到 half（不能停在 peek）；
   *   · 退出 walk **不强制跳档**（用户拖到哪就是哪），但恢复完整三档（下面 effect 自然生效）。
   */
  const walkActive = pane === "detail" && !!walk?.active;
  const allowedDetents = walkActive ? (["full", "half"] as Detent[]) : undefined;

  const snap = useSnapSheet({
    open,
    detent,
    topsPx,
    sheetRef,
    onDetentChange,
    allowedDetents,
    onDismiss: onContextClose,
    /**
     * ★ 2026-09-24（用户实测反馈·二轮）：**两个 pane 统一禁用**「最低档继续下拉关闭」——
     *   拉到底一律硬停/回弹，不再"整体拖没"（详情层此前下拉会退回推荐页，用户要求一致硬停）。
     *   关闭途径：推荐层 = bar 的 X / peek 关闭键；详情层 = bar 返回箭头 / peek 关闭键（= 回推荐）。
     */
    dismissible: false,
  });

  /**
   * ★ v3.6.0 S5：进 walk 时若停在 peek ⇒ **立即 snap 到 half**（peek 会把当前步藏掉）。
   *   退出 walk **不强制跳档** —— 用户拖到哪就是哪；只是恢复完整三档（`allowedDetents` 变 undefined）。
   *   ⚠️ 依赖只放 `walkActive`：若依赖 `detent`，用户手动拖到 half 也会反复触发（虽幂等但不必要）。
   */
  useEffect(() => {
    if (!walkActive) return;
    if (detent === "peek") onDetentChange("half");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walkActive]);

  /** peek 点整区 → 回该 pane 的默认档（推荐→full / 详情→half） */
  const defaultDetent: Detent = pane === "detail" ? "half" : "full";

  /** ★ 观测钩子 `data-phase`：当前 pane 的数据阶段（loading|ready|empty|failed） */
  const phase: "loading" | "ready" | "empty" | "failed" =
    pane === "detail"
      ? !detail
        ? "loading"
        : detail.phase === "failed"
          ? "failed"
          : detail.phase === "ready"
            ? "ready"
            : "loading"
      : rec.phase === "failed"
        ? "failed"
        : rec.phase === "ready"
          ? rec.data && rec.data.cards.length === 0
            ? "empty"
            : "ready"
          : "loading";

  /**
   * ★ 观测钩子 `data-live`：实时班次状态（on|none|ended）——供 AC-14 自动化断言。
   * 口径：在途车 > 0 ⇒ `on`；否则按**澳门时间**（UTC+8）近似服务时段（06:00–23:59）
   * 判定 `none`（未发车）或 `ended`（已收班）。⚠️ 无「收班」显式字段，此为近似口径。
   */
  const macauHour = new Date(Date.now() + 8 * 3_600_000).getUTCHours();
  const inService = macauHour >= 6 && macauHour <= 23;
  const live: "on" | "none" | "ended" =
    (detail?.vehicles ?? 0) > 0 ? "on" : detail?.phase === "ready" && !inService ? "ended" : "none";

  /** 推荐 peek 摘要（最快方案的时长 + 线路 chips + 共 N 條） */
  const recSummary =
    rec.data && rec.data.cards.length
      ? (() => {
          const fastest = [...rec.data.cards].sort((a, b) => a.totalMin - b.totalMin)[0];
          return {
            min: Math.round(fastest.totalMin),
            routes: fastest.rides.map((r) => r.route),
            count: rec.data.cards.length,
          };
        })()
      : null;

  return (
    <BottomSheet
      sectionRef={sheetRef}
      open={open}
      pane={pane}
      detent={detent}
      phase={phase}
      live={live}
      dragging={snap.dragging}
      translateY={snap.translateY}
      layoutY={snap.layoutY}
      ariaLabel={`路线面板 ${odLabel}`}
      onPointerDown={snap.onPointerDown}
      onPointerMove={snap.onPointerMove}
      onPointerUp={snap.onPointerUp}
      onPeekTap={() => onDetentChange(defaultDetent)}
      peekTapGuard={snap.tapOk}
      onDismiss={onContextClose}
      pref={pref}
      actions={detailActions}
      bar={
        <>
          {/* 左上（双态 · 两 pane 均渲染）：recommend ⇒ 关闭面板；detail/riding ⇒ 返回推荐列表。
              aria-label / title 随 pane 切换（读屏正确性；AC-86）。 */}
          <button
            type="button"
            className="route-sheet__iconbtn"
            onClick={onContextClose}
            aria-label={pane === "recommend" ? "关闭面板" : "返回推荐列表"}
            title={pane === "recommend" ? "关闭面板" : "返回推荐列表"}
          >
            <Icon name="back" size={20} />
          </button>
          <span className="route-sheet__od t-label">{odLabel}</span>
          {/* 收藏（仅 recommend 栏；位于刷新按钮左侧） */}
          {/* ★ v3.3.0（AC-115）：推荐弹窗顶部「收藏组合」chip（图标 + 文字，与起终点页**同一常量**） */}
          {pane === "recommend" && fav && <FavoriteButton from={fav.from} to={fav.to} />}
          {/* 右上：情境化刷新（AC-87）——recommend 重查推荐 / detail·riding 刷新巴士数据。
              ★ v3.6.0 S4：**加 5s 时间戳冷却**（口径见 useCooldown）。
                旧版只有 `refreshBusy`（= HTTP 往返 ≈1s）⇒ 表现为「一秒冷却一次」。 */}
          <button
            type="button"
            className={`route-sheet__iconbtn${refreshBusy || paneCoolingVisible > 0 ? " is-cooling" : ""}`}
            data-refresh-scope={pane === "recommend" ? "recommend" : "detail"}
            /* ★ S4 阻断 ③：观测钩子 —— `off` = 该段刷不出任何东西（轻轨），永不进冷却 */
            data-cooldown={refreshScope === "bus" ? "on" : "off"}
            onClick={onRefreshClick}
            aria-disabled={refreshBusy || paneCoolingVisible > 0 || undefined}
            aria-busy={refreshBusy || undefined}
            aria-label={
              paneCoolingVisible > 0
                ? `刷新，${paneCoolingVisible} 秒后可再次刷新`
                : refreshBusy
                  ? "刷新中"
                  : pane === "recommend"
                    ? "刷新路线推荐"
                    : "刷新巴士数据"
            }
            title={
              paneCoolingVisible > 0
                ? `${paneCoolingVisible} 秒后可再次刷新`
                : refreshBusy
                  ? "刷新中"
                  : pane === "recommend"
                    ? "刷新路线推荐"
                    : "刷新巴士数据"
            }
          >
            <Icon name="refresh" size={20} />
            {paneCoolingVisible > 0 && (
              <span className="route-sheet__cd" aria-hidden="true">
                {paneCoolingVisible}
              </span>
            )}
          </button>
        </>
      }
      peek={
        pane === "detail" && detail ? (
          <div className="sheet-peek-summary" data-variant="detail">
            <p className="sheet-peek__od">{odLabel}</p>
            <div className="sheet-peek__metric">
              <span className="sheet-peek__big">
                {Math.round(detail.card.totalMin)}
                <span className="sheet-peek__unit">分</span>
              </span>
              {detail.card.rides.length > 1 && (
                <span className="sheet-peek__meta">换乘 {detail.card.rides.length - 1} 次</span>
              )}
              <RouteStack codes={detail.card.rides.map((r) => r.route)} colors={colors} size="sm" />
              <span className="sheet-peek__meta">{macauClock(detail.card.arriveAt)} 抵达</span>
              <Icon name="caretUp" size={20} className="sheet-peek__chev" />
            </div>
          </div>
        ) : (
          <div className="sheet-peek-summary" data-variant="recommend">
            <p className="sheet-peek__od">{odLabel}</p>
            <div className="sheet-peek__metric">
              {recSummary ? (
                <>
                  <span className="sheet-peek__big">
                    {recSummary.min}
                    <span className="sheet-peek__unit">分</span>
                  </span>
                  <RouteStack codes={recSummary.routes} colors={colors} size="sm" />
                  <span className="sheet-peek__meta">共 {recSummary.count} 條</span>
                </>
              ) : (
                <span className="sheet-peek__meta">
                  {rec.phase === "loading" ? "正在规划…" : "暂无可用路线"}
                </span>
              )}
              <Icon name="caretUp" size={20} className="sheet-peek__chev" />
            </div>
          </div>
        )
      }
    >
      {/* 推荐列表 pane：常驻不卸载（opacity 切换 ⇒ 保滚动位置） */}
      <div className="route-sheet__pane" data-pane="recommend" aria-hidden={pane !== "recommend"}>
        <div className="route-sheet__scroll">
          {/* ★ 本批（需求⑧ / AC-52/53）：三档偏好（唯一入口 = 推荐列表顶部）
              ★ v3.3.0（AC-105）：轻轨优先开关与三档**同一行右侧**（独立布尔，与排序正交） */}
          <PrefSwitch
            value={pref}
            onChange={setPref}
            lrtFirst={lrtFirst}
            onLrtFirst={setLrtFirst}
          />
          <RouteResultPane
            phase={rec.phase}
            data={rec.data}
            err={rec.err}
            onRetry={rec.reload}
            onCardOpen={onOpenDetail}
          />
          <ComplianceBar />
        </div>
      </div>

      {/* 详情 pane（总览段数观测钩子的归属是**地图 canvas**（NavMap），此处不重复挂 ⇒ 免 QA 选择器歧义） */}
      <div className="route-sheet__pane" data-pane="detail" aria-hidden={pane !== "detail"}>
        {/* ★ 本批（需求③）：自动上车 toast / 自动下车瞬态 —— 浮层（滚动容器之外）；
            ★ v3.2.0（需求 8）：**下车横幅已迁出**（页面级 `.nav-alarm--top`，由 NavShell 承载）。 */}
        {detail && <NavAlarmOverlay track={detail.track ?? null} />}
        <div className="route-sheet__scroll">
          {detail && (
            <RouteDetailPane
              card={detail.card}
              colors={colors}
              destLabel={detail.destLabel}
              odLabel={odLabel}
              fav={fav ? { from: fav.from, to: fav.to, query } : null}
              degraded={detail.degraded}
              phase={detail.phase === "idle" ? "loading" : detail.phase}
              body={detail.body}
              reload={detail.reload}
              /* ★ v3.7.0（C5）：折叠栏按需查询（三态判据 + 取数入口） */
              foldState={detail.foldState}
              onLoadFold={detail.onLoadFold}
              track={detail.track ?? null}
              destCoord={detail.destCoord ?? null}
              onSwitchCard={detail.onSwitchCard}
              immersive={immersive}
              /**
               * ★ 一体化（用户反馈 2026-10-31）：**进入导航后不得再有手动步行入口**。
               *   传 `null` ⇒ `NavDetailBody` 的「步骤」展开键与步行预览块整块消失 ——
               *   阶段切换由系统驱动（出发→自动 walk-out，到站→自动上车，下车→自动 walk-in）。
               *   ★ v3.9.0：未开始导航时的「开始步行」按钮也已删（负责人 2026-11-03，
               *   与「开始导航」重复）——`onWalkStart` prop 整链移除，本 prop 同时承担
               *   原按钮与展开键两条链路的门控（语义不变：active 时整块消失）。
               *   「结束导航」不受影响（页面级 `.nav-walk-exit` / track 的结束按钮）。
               */
              onWalkExpand={walk?.active ? null : walk?.onExpand}
              walkPreview={walk?.preview}
              walkInPreview={walk?.previewIn}
            />
          )}
        </div>
      </div>
    </BottomSheet>
  );
}

/** 档位列表（供调用方循环/校验；值即 DETENTS） */
export { DETENTS, detentIndex };

/* ── ★ 本批（需求⑧ / AC-52/53）：三档偏好 segment（唯一入口 = 推荐列表顶部）──
   图标 = **内联线性 SVG**（16px / stroke 2 / currentColor，与 Tabler 同描边风格；无 emoji）。
   ⚠️ v3.1.1 #5：解释行**禁用开发术语**（不得出现 cost / 权重 / 系数 / 参数名等代码语）。 */
const PREF_OPTS: { value: PrefMode; label: string; icon: ReactNode }[] = [
  {
    value: "balanced",
    label: "推荐",
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3.5l2.6 5.27 5.9.86-4.25 4.14 1 5.86L12 16.9l-5.25 2.73 1-5.86L3.5 9.63l5.9-.86z" />
      </svg>
    ),
  },
  {
    value: "fewer_transfers",
    label: "少换乘",
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 8h13l-3-3" />
        <path d="M20 16H7l3 3" />
      </svg>
    ),
  },
  {
    value: "less_walk",
    label: "少步行",
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M13 4.5a1 1 0 1 0 1.4 1.4A1 1 0 0 0 13 4.5z" />
        <path d="M8 21l2.6-3.6" />
        <path d="M17 21l-2.3-3.6-2.7-1.9.6-3.5" />
        <path d="M11 11.6L13 9l2.6.7 2.1 2" />
        <path d="M13 9l-2.4-2.3H8" />
      </svg>
    ),
  },
];

const PREF_HINT: Record<PrefMode, ReactNode> = {
  balanced: (
    <>
      排序依据：<b>用时</b> · 换乘 · 步行
    </>
  ),
  fewer_transfers: (
    <>
      排序依据：优先看 <b>换乘次数</b>，再看用时
    </>
  ),
  less_walk: (
    <>
      排序依据：优先看 <b>步行总量</b>，再看用时
    </>
  ),
};

/**
 * 路线偏好三档 + ★ v3.3.0（AC-105）轻轨优先开关。
 * 布局（03 §5 修订 4）：**三档与开关同一行横排** —— 三档 `flex:1 1 0`（`nowrap` 不折行），
 * 开关 `flex:none` 固定在右侧；说明行（既有）不动。
 * 开关语义 = `role="switch"` + `aria-checked`（独立布尔，非第四档）；点标签文字也可切换。
 */
function PrefSwitch({
  value,
  onChange,
  lrtFirst,
  onLrtFirst,
}: {
  value: PrefMode;
  onChange: (v: PrefMode) => void;
  lrtFirst: boolean;
  onLrtFirst: (v: boolean) => void;
}) {
  return (
    <div className="pref-switch">
      <div className="pref-switch__row">
        <div className="pref-switch__seg" role="group" aria-label="路线偏好">
          {PREF_OPTS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`pref-switch__opt${value === o.value ? " is-on" : ""}`}
              aria-pressed={value === o.value}
              onClick={() => onChange(o.value)}
            >
              {o.icon}
              <span>{o.label}</span>
            </button>
          ))}
        </div>
        {/* 轻轨优先（开关）—— 开：轨道 `--accent` + 旋钮左移；双通道（非仅靠颜色） */}
        <button
          type="button"
          className="lrt-switch"
          role="switch"
          aria-checked={lrtFirst}
          aria-label="轻轨优先"
          onClick={() => onLrtFirst(!lrtFirst)}
        >
          <span className="lrt-switch__label">轻轨优先</span>
          <span className="lrt-switch__track" aria-hidden="true">
            <span className="lrt-switch__knob" />
          </span>
        </button>
      </div>
      <p className="pref-switch__hint">{PREF_HINT[value]}</p>
    </div>
  );
}
