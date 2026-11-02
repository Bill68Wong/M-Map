"use client";

/**
 * 导航界面主体（src/components/nav/NavDetailBody.tsx，2026-09-25 · v2.14；★ 2026-09-26 修订）
 *
 * 取代 `RouteDetailBody`（Spec §7）；由 `RouteDetailPane` 渲染，两个消费方共用：
 *   · 主页链（`RouteSheet` → detail pane，注入 `track`）；
 *   · 收藏薄壳（`RouteDetailSheet`，`track=null` ⇒ 静态详情，行为同 v2.13）。
 *
 * ── ★ 2026-09-26 修订（需求③ / AC-32~36）────────────────────────────
 *   · 头部改 `.rc-dhead`（flex：左=总用时+到达，右=`RouteStack` **同行**；**去 `.card` 灰框**、
 *     仅保留下分割线）；**删除「估算」span**；
 *   · 下车横幅 / 自动上车 toast / 自动下车瞬态**迁至浮层**（`NavAlarmOverlay`，
 *     挂 `.route-sheet__pane` 内容层，滚动容器之外 ⇒ 不参与滚动、不推挤内容）；
 *   · 吸底操作条（`NavTrackBar`）**迁至面板根**（`.route-sheet__actions-slot`，见 `RouteSheet`）；
 *   · 换乘行「等车约 N 分」由 `NavStrip` 承担（数据缺 ⇒ 降级文案）。
 *
 * 结构（自上而下）：头部 → 步行/等车行 → 进度纵条（NavStrip）→ 下车步行行
 *   → 折叠区（StationReachFold）→ 来源脚注。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import NavStrip from "./NavStrip";
import StationReachFold from "./StationReachFold";
import type { FoldState } from "./useDetailBody";
import RouteStack from "@/components/RouteStack";
import { LrtEtaInline } from "@/components/LrtEta";
import { catchHintOf, directionNameOf, EtaText, Row, TierBadge, macauClock } from "@/components/RoutePieces";
import type { FavoriteEndpoint, PlanSnapshot, RouteSeg } from "@/lib/favorites/types";
import type { RecommendCard, SegmentStrip } from "@/lib/recommend/types";
import type { RideTrackView } from "./useRideTracking";
/* ★ v3.6.0 S5：步行预览（展开键 + 静态步骤列表） */
import WalkSegToggle from "@/components/walk/WalkSegToggle";
import WalkStepList, { distText } from "@/components/walk/WalkStepList";
import type { WalkPhase } from "@/components/walk/useWalkRoute";
import type { WalkStep } from "@/lib/walk/walk-shared";

/** 步行预览数据（首段）；未就绪时给最小形状，避免调用方每次造对象 */
export interface WalkPreview {
  phase: WalkPhase;
  steps: WalkStep[];
  /** 服务端原始 steps（`开始步行` 时交给跟随状态机，保证同一份几何） */
  serverSteps: WalkStep[];
  /** 几何真实总长（`stepsTotalM`）—— 显示/剩余计算都用它，**不用 totalDistM** */
  totalDistM: number;
  /** 预计步行分钟（= `totalDurationS / 60`，取整前） */
  totalMin: number;
}
const EMPTY_WALK_PREVIEW: WalkPreview = { phase: "idle", steps: [], serverSteps: [], totalDistM: 0, totalMin: 0 };

export interface NavDetailBodyProps {
  card: RecommendCard;
  /** 逐段站条（服务端 `buildStrips` 产物） */
  strips: SegmentStrip[];
  /** 第一程上车站台「其他线路」 */
  otherRoutes: string[];
  /** 其他线路实时报站文案（route → 文案） */
  foldLive: Record<string, string>;
  /**
   * ★ v3.7.0（C5）：折叠栏查询状态 —— **唯一**的「能不能说没有班次」的判据。
   *   缺省 `"idle"`（= 未查询 ⇒ 不显示「暂无到站信息」），宁可留空也不撒谎。
   */
  foldState?: FoldState;
  /** ★ v3.7.0（C5）：折叠栏首次展开时调用（按需取实时报站；幂等） */
  onLoadFold?: () => void;
  /** 折叠栏站台显示名（null 时不渲染折叠栏） */
  stationLabel: string | null;
  /** 线路码 → 主题色 */
  colors: Record<string, string>;
  /** 目的地展示名 */
  destLabel: string;
  /**
   * ★ v3.3.0（AC-115）：导航弹窗内**不设任何收藏入口** —— 原「收藏键」数据（`fav`）已随按钮一并移除。
   *   保留为可选仅作**向后兼容**（调用方仍在传），`NavDetailBody` 不再消费。
   */
  fav?: {
    from: FavoriteEndpoint;
    to: FavoriteEndpoint;
    query: string;
    fingerprint: string;
    snapshot: PlanSnapshot;
    route: RouteSeg[];
  } | null;
  /** 「本地推算」徽标 */
  degraded?: boolean;
  /** 导航追踪态（收藏薄壳传 null ⇒ 静态详情） */
  track?: RideTrackView | null;
  /** 目的地坐标（GCJ-02；可切换方案查询用） */
  destCoord?: { lng: number; lat: number } | null;
  /** 点「切换路线」→ 打开新方案导航 */
  onSwitchCard?: (card: RecommendCard, degraded: boolean) => void;
  /** ★ 全屏化（导航中收敛间距） */
  immersive?: boolean;
  /**
   * ★ v3.6.0 S5：进入步行跟随（用户显式点击「开始步行」）。
   * ★ T1：**两段都可**（`out` = 走到上车站 / `in` = 下车站走到目的地）——
   *   旧签名写死 `"out"`，导致末段步行入口是死代码（`NavShell` 的 `walkOds.in` 备好却没人调）。
   * 传 `undefined` ⇒ 本组件**不渲染**展开键（收藏页 `RouteDetailSheet` 无地图上下文，走这条）。
   */
  onWalkStart?: ((seg: "out" | "in", steps: WalkStep[]) => void) | null;
  /** 展开步骤时回调（调用方据此 `ensure()` 取数；命中缓存则零请求） */
  onWalkExpand?: (seg: "out" | "in") => void;
  /** 首段步行预览数据（由宿主 `useWalkRoute` 提供） */
  walkPreview?: WalkPreview;
  /** ★ T1：末段步行预览数据（下车站 → 目的地；缺省 = 不渲染末段入口） */
  walkInPreview?: WalkPreview;
}

export default function NavDetailBody({
  card,
  strips,
  otherRoutes,
  foldLive,
  /* ★ v3.7.0（C5）：折叠栏三态 —— 缺省 `idle`（未查询，不显示「暂无到站信息」） */
  foldState = "idle",
  onLoadFold,
  stationLabel,
  colors,
  destLabel,
  /* ★ v3.3.0（AC-115）：`fav` 不再消费（导航弹窗内无收藏入口）—— 保留 prop 以兼容调用方 */
  degraded = false,
  track = null,
  destCoord = null,
  onSwitchCard,
  immersive = false,
  onWalkStart,
  onWalkExpand,
  walkPreview = EMPTY_WALK_PREVIEW,
  walkInPreview = EMPTY_WALK_PREVIEW,
}: NavDetailBodyProps) {
  /**
   * ★ T1：步行步骤展开态（不记忆，父组件持有亦不落盘）。
   *   改为「哪一段展开中」而不是布尔 —— 首段/末段各一个入口，同时只允许展开一段
   *   （两段都展开会把面板滚成两屏，且用户当前只关心接下来要走的那段）。
   */
  const [walkOpen, setWalkOpen] = useState<"out" | "in" | null>(null);
  const colorOf = (c: string) => colors[c] ?? null;
  const first = card.rides[0];
  /** ★ v3.7.0 S4：只有真实时刻提示（`catchHint`）；速度档文案全站隐藏 */
  const firstHint = first ? catchHintOf(first) : { text: "", isHint: false };
  /** ★ v3.3.0（AC-102）：总览栏线路标签 = 与推荐卡同构的分段结构（含段内并行线） */
  const routeSegments = card.rides.map((r) => ({ codes: [r.route, ...(r.parallelRoutes ?? [])] }));
  const legIdx = track ? track.legIndex : 0;
  const trackStops = track && track.phase !== "off" ? (strips[legIdx]?.stops ?? []) : [];
  const stopLabel = (k: number | null): string =>
    k !== null && k >= 0 && k < trackStops.length ? trackStops[k].label : "";

  // ── ★ v3.4.0（量化 P1）：距下车站「约 X 分钟」──
  //  X = 沿站条从「下一站」到末站的逐跳值之和（服务端 lookupHop 产物，已随 P0 升级到时段口径）；
  //  帧与帧之间（12s 轮询）按真实流逝**本地递减**，数字不卡住；帧到达（key 变化）时重校准。
  const progKey = track && track.prog ? `${track.prog.passedIdx}|${track.prog.nextIdx}` : "";
  const etaBaseRef = useRef<{ key: string; min: number; ts: number } | null>(null);
  const [etaTick, setEtaTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setEtaTick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const etaBaseMin = useMemo(() => {
    // ★ v3.4.0（进度模型）：本段有「位置感知剩余」（服务端投影 + 客户端融合）→ 优先用它；
    //   否则回退为「沿站条逐跳求和」（纯静态口径）。
    const segSec = track?.segProgress?.segRemainSec;
    if (segSec != null && segSec >= 0) return segSec / 60;
    if (!track || !track.prog || trackStops.length < 2) return 0;
    const nextIdx = track.prog.nextIdx ?? Math.min(trackStops.length - 1, track.prog.passedIdx + 1);
    let sum = 0;
    for (let k = Math.max(0, nextIdx); k < trackStops.length - 1; k++) sum += trackStops[k]?.minToNext ?? 0;
    return sum;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progKey, trackStops, track?.segProgress?.segRemainSec, track?.segProgress?.segFrom, track?.segProgress?.segTo]);
  useEffect(() => {
    etaBaseRef.current = { key: `${progKey}|${Math.round(etaBaseMin * 10)}`, min: etaBaseMin, ts: Date.now() };
  }, [progKey, etaBaseMin]);
  const remainMin = useMemo(() => {
    const base = etaBaseRef.current;
    if (!base) return etaBaseMin;
    return Math.max(0, base.min - (Date.now() - base.ts) / 60_000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [etaTick, etaBaseMin, progKey]);
  const stopsAway = track && track.prog ? Math.max(0, trackStops.length - 1 - track.prog.passedIdx) : 0;
  /** ★ T4：末段步行的「到达站」是否与目的地同名（同名 ⇒ 不重复渲染；口径见行内注释） */
  const walkInTo = (card.walkIn.toLabel ?? "").trim();
  const showWalkInTo = walkInTo.length > 0 && walkInTo !== (destLabel ?? "").trim();

  /**
   * 展开/收起某段步行步骤。
   *
   * 含 S5 的**实测布局修复**（原先只服务首段，现两段共用同一套，避免两处漂移）：
   *   (a) 把**这一行**贴到滚动容器可视区顶部；
   *   (b) 按「行以下还剩多少可见空间」反算预览块高度上限。
   *
   * ⚠️ 两个必须避开的坑（都踩过）：
   *   ① 页面里有**两个** `.route-sheet__scroll`（recommend / detail 各一）⇒
   *      必须 `closest()` 从被点击的按钮向上找，**禁止 document.querySelector**；
   *   ② 滚动位移**不能用 `offsetTop` 相减** —— 嵌套定位下 offsetParent 不一致
   *      （实测只滚了 61px，应为 ~190px）。一律用 `getBoundingClientRect()`。
   *   ③ 可视底不是 `window.innerHeight` —— 详情 pane 有吸底操作条
   *      `.route-sheet__actions-slot`（实测 high 85px，z=20）；只按视口算会让预览块
   *      伸进去被盖住，命中测试落到「开始导航」按钮上（用户点「开始步行」误触「开始导航」）。
   */
  const toggleWalk = (seg: "out" | "in") => (ev: React.MouseEvent<HTMLButtonElement>) => {
    const next = walkOpen === seg ? null : seg;
    setWalkOpen(next);
    if (!next) return;
    onWalkExpand?.(next);
    const btn = ev.currentTarget;
    const row = btn.closest(".rc-row--walk") as HTMLElement | null;
    const box = row?.closest(".route-sheet__scroll") as HTMLElement | null;
    if (!row || !box) return;
    requestAnimationFrame(() => {
      const rowTop = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
      box.scrollTo({ top: Math.max(0, box.scrollTop + rowTop - 8) });

      const rowRect = row.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const slot = box.closest(".route-sheet")?.querySelector(".route-sheet__actions-slot") as HTMLElement | null;
      const slotTop = slot ? slot.getBoundingClientRect().top : Infinity;
      const visibleBottom = Math.min(boxRect.bottom, window.innerHeight, slotTop);
      const avail = visibleBottom - rowRect.bottom - 8 - 12;
      box.style.setProperty("--walkpreview-h", `${Math.max(140, Math.min(440, Math.round(avail)))}px`);
    });
  };

  /**
   * 步行预览块（首/末段共用）。
   * · 距离一律用 **`totalDistM`（= 服务端 `stepsTotalM`，几何真实总长）**，不是估算总长
   *   —— 中间步被丢弃时两者可差 30%~60%，用后者会与实际折线对不上；
   * · 失败态只给「直线距离 + 固定步速估算」，**绝不显示假的分步**（架构 §3.3 纪律 4）。
   */
  const walkPreviewBlock = (seg: "out" | "in", pv: WalkPreview, idPrefix: string) => {
    /** 该段的估算元信息（失败/骨架态用；数据来自 detail-body 已有字段 ⇒ 不等网络） */
    const meta = seg === "out" ? card.walkOut : card.walkIn;
    const metaText = [
      meta.distanceM ? `${Math.round(meta.distanceM)} 米` : "",
      meta.minutes ? `约 ${meta.minutes} 分钟` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <div className="rc-walkpreview">
        {pv.phase === "ready" ? (
          <>
            <WalkStepList
              steps={pv.steps}
              currentIdx={-1}
              idPrefix={idPrefix}
              longWalk={pv.totalDistM > 2500}
            />
            <div className="rc-walkpreview__foot">
              <button
                type="button"
                className="btn btn--outline btn--sm rc-walkpreview__go"
                onClick={() => onWalkStart?.(seg, pv.serverSteps)}
              >
                开始步行
              </button>
              {pv.totalDistM > 0 && (
                <span className="rc-walkpreview__go-meta">
                  全程 {distText(pv.totalDistM)} · 约 {Math.max(1, Math.round(pv.totalMin))} 分钟
                </span>
              )}
            </div>
          </>
        ) : pv.phase === "failed" ? (
          /* 降级：只给直线距离 + 固定步速估算，绝不显示假的分步（架构 §3.3 纪律 4） */
          <p className="rc-walkpreview__fallback t-label t-muted">
            步行路径暂时取不到{metaText ? ` · ${metaText}` : ""}
          </p>
        ) : (
          <p className="rc-walkpreview__sk t-label t-muted">
            {metaText || "步行距离估算中"}
            {" · 步骤载入中…"}
          </p>
        )}
      </div>
    );
  };

  return (
    <>
      {/* 头部：总用时 / 到达 + 线路标签**同行**（★ 去灰框、仅下分割线；删「估算」） */}
      <div className="rc-dhead">
        <div className="rc-dhead__l">
          <div className="rc-dhead__total">
            <span className="rc-total">{Math.round(card.totalMin)}</span>
            <span className="rc-total__unit">分</span>
          </div>
          <span className="rc-dhead__arrive">
            预计 <b>{macauClock(card.arriveAt)}</b> 到达
            {card.crossBorder && <span className="rc-warn"> · 不含通关</span>}
          </span>
        </div>
        <div className="rc-dhead__r">
          {/* ★ v3.3.0（AC-102）：与推荐卡**逐字同构** —— 每段 = 主干线 + 段内并行线（`parallelRoutes`）
              （改前只给主干线 ⇒ 推荐卡显示 `25/26`、进导航变 `25`，两处不一致）。 */}
          <RouteStack segments={routeSegments} colors={colors} size="sm" />
          {/* ★ v3.3.0（AC-115）：**导航弹窗内不设收藏入口**（用户明确）——
              原「收藏键」`<FavoriteButton kind="plan" entry="detail" …/>` 已删除。
              删除后 detail 头部右区仅剩线路标签（本总览栏）。收藏入口只在：
              ① 起终点页「收藏组合」；② 推荐弹窗顶部「收藏组合」；③ 搜索框右上角「收藏地点」。 */}
        </div>
      </div>

      {/* 步行 → 上车站；首段等车 */}
      <div className="rc-line">
        <Row
          dot="walk"
          main={
            <>
              步行{" "}
              <b className={card.walkOut.estimated ? "rc-val--est" : undefined}>{card.walkOut.minutes}</b> 分
              {" → "}
              {card.walkOut.toLabel}
            </>
          }
          /**
           * ★ v3.6.0 S5（设计 §2.1）：行右侧 44×44「步骤」展开键。
           * 展开后的 `.rc-walklist` **必须紧随该行**（Row 的兄弟节点）——
           * 塞进 `aside` 会落进 `.rc-row` 的 flex 行里被挤扁（S5 验收抓到过）。
           * 布局实测逻辑在 `toggleWalk()`（两段共用）。
           */
          aside={
            onWalkStart ? (
              <WalkSegToggle idPrefix="detail-out" open={walkOpen === "out"} onToggle={toggleWalk("out")} />
            ) : null
          }
        />
        {/* ★ v3.6.0 S5：展开的步骤列表（紧随「步行」行；预览态 currentIdx=-1 ⇒ 全部未走） */}
        {onWalkStart && walkOpen === "out" && walkPreviewBlock("out", walkPreview, "detail-out")}
        {first && (
          <Row
            dot="wait"
            main={
              first.kind === "lrt" && first.liveDepartures?.length ? (
                <LrtEtaInline
                  lineCode={first.route}
                  departuresMs={first.liveDepartures}
                  clocks={first.liveClocks}
                  /* ★ v3.2.0（AC-68/69）：逐班 secPrecise（`RideLegView.livePrecise`） */
                  precise={first.livePrecise}
                  state="running"
                  /* ★ v3.3.0（AC-103）：接通轻轨方向（改前恒传 null） */
                  directionName={directionNameOf(first)}
                  /* ★ 2026-09-27（用户需求 4）：导航 = 邻班区默认折叠、点击展开 */
                  neighbors="collapsed"
                  mainMs={first.liveMainMs}
                  tierCtx={{ walkMin: card.walkOut.minutes, walkDistM: card.walkOut.distanceM }}
                />
              ) : (
                <EtaText text={first.liveText || `等 ${Math.round(first.waitMin)} 分`} />
              )
            }
            /* ★ v3.7.0 S4：速度档文案全站隐藏；只在有真实时刻（`catchHint`）时渲染胶囊 */
            aside={
              firstHint.text ? <TierBadge tierText={firstHint.text} catchHint={firstHint.isHint} /> : null
            }
          />
        )}
      </div>

      {/* 距下车站还有 N 站（导航中；AC-02 站数刻度）· ★ v3.4.0：下方小字「约 X 分钟」 */}
      {track && track.phase === "riding" && track.prog && trackStops.length >= 2 && (
        <div className="nav-note-neutral nav-note-neutral--eta">
          <div className="nav-note__main">
            <span className="navstrip__badge">距离</span>
            距下车站还有 <b>{stopsAway}</b> 站
            {track.prog.nextIdx !== null && <> · 下一站 {stopLabel(track.prog.nextIdx)}</>}
          </div>
          <div className="nav-note__sub" data-eta-remain={Math.max(1, Math.round(remainMin))}>
            {stopsAway <= 1 ? "即将到站" : `约 ${Math.max(1, Math.round(remainMin))} 分钟`}
          </div>
        </div>
      )}

      {/* 进度纵条（一趟一条；导航中仅当前乘车段显示实时进度） */}
      <div className={`rc-strips${immersive ? " rc-strips--immersive" : ""}`}>
        {strips.map((strip, i) => (
          <NavStrip
            key={`${strip.route}-${strip.board}-${i}`}
            strip={strip}
            color={colorOf(strip.route)}
            last={i === strips.length - 1}
            nav={
              track && track.phase === "riding" && track.prog && i === track.legIndex
                ? {
                    passedIdx: track.prog.passedIdx,
                    nextIdx: track.prog.nextIdx,
                    atIdx: track.prog.atIdx,
                    alarm: track.alarm,
                    /* ★ 本批：段内插值用户点（AC-43/44）+ 观测钩子 data-nav-leg */
                    youAt: track.youAt,
                    legIndex: track.legIndex,
                  }
                : null
            }
            nextKind={strips[i + 1]?.kind ?? null}
            frozen={!!track && track.phase === "riding" && !!track.note}
          />
        ))}
      </div>

      {/*
        ★ T4：末段步行行**去重** —— `card.walkIn.toLabel` 在服务端 `model.ts` 里
        本来就等于 `destLabel`（`:334/371/387`），旧渲染 `步行 X 分 → 终点 → 终点` 每张详情都重一遍。
        这里判等则不渲染第二段：`步行 4 分 → 新馬路`。
        ⚠️ **不许改 `model.ts`** —— 卡片页 `CardDetailClient` 复用该字段当"到达站"文案。
      */}
      <div className="rc-line">
        <Row
          dot="walk"
          last
          main={
            <>
              步行{" "}
              <b className={card.walkIn.estimated ? "rc-val--est" : undefined}>{card.walkIn.minutes}</b> 分
              {" → "}
              {showWalkInTo && (
                <>
                  <b>{card.walkIn.toLabel}</b>
                  {" → "}
                </>
              )}
              {destLabel}
            </>
          }
          /**
           * ★ T1：末段步行入口（原来这里是**死代码** —— 全仓 `walk.onStart` 的类型写死 `"out"`，
           *   下车站这一行没有 aside，`walkOds.in` 备好却没人调）。
           * 结构与首段同构：44×44「步骤」展开键 + 紧随其后的预览块。
           */
          aside={
            onWalkStart ? (
              <WalkSegToggle
                idPrefix="detail-in"
                open={walkOpen === "in"}
                onToggle={toggleWalk("in")}
              />
            ) : null
          }
        />
        {onWalkStart && walkOpen === "in" && walkPreviewBlock("in", walkInPreview, "detail-in")}
      </div>

      {/* 上车站其他线路（线路为父、方案为子） */}
      {stationLabel && (
        <StationReachFold
          stationLabel={stationLabel}
          items={otherRoutes.map((r) => ({ route: r, live: foldLive[r] ?? "" }))}
          /* ★ v3.7.0（C5）：展开时才查；`foldState` 决定空值该怎么表达 */
          foldState={foldState}
          onLoadFold={onLoadFold}
          colors={colors}
          switchCtx={
            destCoord ? { card, dest: { lng: destCoord.lng, lat: destCoord.lat, name: destLabel } } : null
          }
          onOpenCard={onSwitchCard ? (c) => onSwitchCard(c, degraded) : undefined}
        />
      )}

      <div className="rc-foot">
        <span className="rc-hint t-muted">数据来源：澳门交通事务局（DSAT）· 高德地图</span>
      </div>
    </>
  );
}
