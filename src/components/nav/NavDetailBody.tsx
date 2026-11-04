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
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import NavStrip from "./NavStrip";
import StationReachFold from "./StationReachFold";
import type { FoldState } from "./useDetailBody";
import RouteStack from "@/components/RouteStack";
import { LrtEtaInline } from "@/components/LrtEta";
import { directionNameOf, EtaText, Row, TierBadge, macauClock } from "@/components/RoutePieces";
import Icon from "@/components/ui/Icon";
import type { FavoriteEndpoint, PlanSnapshot, RouteSeg } from "@/lib/favorites/types";
import type { RecommendCard, SegmentStrip } from "@/lib/recommend/types";
import {
  ARRIVE_OVERDUE_TEXT,
  REMAIN_ARRIVED_TEXT,
  remainOf,
  remainServedOf,
  remainTotalMinOf,
} from "@/lib/nav/remaining-view";
import type { RideTrackView } from "./useRideTracking";
/* ★ v3.6.0 S5：步行预览（展开键 + 静态步骤列表） */
import WalkSegToggle from "@/components/walk/WalkSegToggle";
import WalkStepList, { distText } from "@/components/walk/WalkStepList";
import type { WalkPhase } from "@/components/walk/useWalkRoute";
import type { WalkStep } from "@/lib/walk/walk-shared";

/**
 * ★ U2（2026-11-04）：**赶车标签的单向锁存** —— 值由会话层（`NavShell`）持有并下发。
 *
 * 为什么用 Context 而不是 prop：值要穿 `RouteSheet` → `RouteDetailPane` → 本组件三层，
 *   中间两层本轮不在改动范围（同一工作区还有别的成员在改文件）。
 * 为什么值**不能**放在本组件：面板重挂载（peek → detail）会丢 local state
 *   ⇒ 收起再展开，标签又回来了（设计 §3.6 点名的失败形态）。
 * 语义：`true` = 本次导航「**已经上过车**」⇒ 赶车标签一律**不渲染**（DOM 移除）。
 *   ⚠️ 它**不是**「当前是否在车上」—— 单向、不回退，见 `NavShell` 里那块块注释。
 */
export const CatchTagLatchContext = createContext(false);

/* ══════════════════════════════════════════════════════════════════════
   ★ U5（2026-11-04）：导航信息行的排版常量与派生逻辑
   ─────────────────────────────────────────────────────────────────────
   定高 52 = 上下 padding 5 × 2 + 主行 20 + 间隙 2 + 次行 20。
   两态（上车前单行 / 上车后两行）**共用这一个高度** ⇒ 状态切换零跳动，
   故**不写** `transition: height`（动画宽高属明令禁止的表现手法）。
   ⚠️ 设计与 `--nav-info-h` Token 同名，但 `globals.css` 本轮由他人改动（点击反馈批），
      故这里先用 TS 常量落地；Token 接线后把 `INFO_ROW_H` 换成 `var(--nav-info-h)` 即可
      （行高仍按 px 写死，保证 20 + 2 + 20 不被字体度量改写）。
   ══════════════════════════════════════════════════════════════════════ */
const INFO_ROW_H = 52;
const INFO_LINE_H = 20;

/**
 * ★ U4（写作纪律）：本行单位统一为「分」，不用「分钟」—— 本行是密集信息行，
 *   多一个全角字 = 14px，320px 视口下正好吃掉余量。
 *   文案源在 `src/lib/recommend/catch-up.ts`（`etaTextOf` 产「约 X 分钟」），那份文件本批不改，
 *   故在**渲染出口**归一：只影响这一条信息行，方案卡文案不受影响。
 */
function minuteUnitOf(text: string): string {
  return text.replace(/分钟/g, "分");
}

/**
 * ★ U5：站条节点 → 「站号 + 站名」。
 *   `StripStop.label` 对巴士**已含站号前缀**（`"C653 金峰南岸/金譽峰"`，见 `types.ts:772`），
 *   轻轨不含（`"氹仔碼頭"`）⇒ 必须拆开分别排版（站号 11px/`--meta`/tabular，站名 15px/600），
 *   否则站号会跟着站名一起放大，白吃 26px 宽度。
 *   优先用数据里的 `code`（平台码 `C653/3` 与显示主码可能不同），拆不出才回落正则。
 */
function splitStopLabel(stop: { code: string; label: string }): { code: string; name: string } {
  const label = stop.label.trim();
  const code = stop.code.trim();
  if (code && label.startsWith(code)) {
    const rest = label.slice(code.length).trim();
    if (rest) return { code, name: rest };
  }
  const m = /^([0-9A-Za-z]{1,6}(?:\/\d+)?)\s+(.+)$/.exec(label);
  return m ? { code: m[1], name: m[2] } : { code: "", name: label };
}

/**
 * 视口宽度（信息行的让位阶梯：≥375 / 360–374 / 320–359）。
 *
 * 为什么用 JS 而不是 CSS 媒体查询：`globals.css` 本轮由他人改动，不往同一个文件里加规则
 * （并发改同文件必冲突）。宽度只影响**字号与前缀显隐**，不影响结构，故代价可接受。
 * `0` = 尚未测量（SSR / 首帧）⇒ 调用方按主目标 390px 渲染；服务端与客户端首帧走同一个
 * 兜底值，所以不会水合不一致。
 */
function useViewportW(): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const read = () => setW(window.innerWidth);
    read();
    window.addEventListener("resize", read);
    window.addEventListener("orientationchange", read);
    return () => {
      window.removeEventListener("resize", read);
      window.removeEventListener("orientationchange", read);
    };
  }, []);
  return w;
}

/** 上车后主行：「前缀 + 站号 + 站名」（`prefix` 由相位决定：下一站 / 已到站 / 下车站） */
interface PostStation {
  prefix: string;
  code: string;
  name: string;
}

interface NavInfoRowProps {
  /** `pre` = 上车前单行；`post` = 上车后两行 */
  mode: "pre" | "post";
  /** 上车前左槽（车辆到本站的量化预期；轻轨分支传 `LrtEtaInline`） */
  preMain: ReactNode;
  /** 上车前右槽（赶车标签；`null` ⇒ DOM 里根本没有这个节点） */
  preAside: ReactNode;
  /** 上车后主行（`null` ⇒ 只剩次行，例如进度未知时连下车站都拿不到） */
  postStation: PostStation | null;
  /** 上车后次行（`null` ⇒ 不渲染该行，容器高度不变） */
  postSub: ReactNode;
  /** 观测钩子：上车后主行是否存在 */
  nextStationOn: boolean;
  /** 观测钩子：次行显示的分钟数（未显示 ⇒ 属性不输出） */
  remainMin: number | null;
  /** 观测钩子：到下车还有几站（未知 ⇒ 属性不输出） */
  stopsAway: number | null;
}

/**
 * 导航信息行（U5 两态布局 / U4 分钟口径 / U2 标签可见性）。
 *
 * 同一个 DOM 位置、同一个定高容器，**整行替换**两态内容：
 *   上车前 `[busStop] 还有 3 站 · 约 6 分      [小跑能赶上]`
 *   上车后 `[bus] 下一站  M220  黑沙環馬路`
 *          `      还有 4 站下车 · 约 9 分`
 * ⚠️ 是"整行替换"而不是"在等车行下面再插一块"：否则轻轨 `LrtEtaInline` 展开后的邻班行
 *   自带 `TierBadge`，会在乘车态泄漏；且「下一站」会与纵条 `.navstrip__badge` 重复两处。
 */
function NavInfoRow({
  mode,
  preMain,
  preAside,
  postStation,
  postSub,
  nextStationOn,
  remainMin,
  stopsAway,
}: NavInfoRowProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const vw = useViewportW() || 390;
  /**
   * 观测钩子 `data-nav-info-h`：**实测**高度（QA 断言「两态恒为 52」的物理依据）。
   * 用 `setAttribute` + 卸载清理（与本项目 `data-walk-*` 同一写法）。
   * ⚠️ 只测不写：高度由样式常量决定，本属性不得反过来驱动布局。
   * 用 `useEffect`（而不是 `useLayoutEffect`）：它只服务于自动断言，不参与绘制，
   *   没必要在 paint 前同步；`useLayoutEffect` 在 SSR 渲染时会打 "does nothing on the server" 警告。
   */
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    /* 用 `offsetHeight`（布局像素）而**不是** `getBoundingClientRect().height`：
       面板换档靠 `transform`，rect 会带着缩放/位移，读数就不再是"这一行有多高"。 */
    el.setAttribute("data-nav-info-h", String(Math.round(el.offsetHeight)));
    return () => el.removeAttribute("data-nav-info-h");
  }, [mode]);

  /** 站名字号：≥375 用 15px（主目标 390），360–374 降 14px（iPhone SE 竖屏边界） */
  const nameSize = vw >= 375 ? 15 : 14;
  /** 320–359px：隐藏「下一站」前缀（语义由纵条 `.navstrip__badge` 承担），先保站名完整 */
  const narrow = vw > 0 && vw < 360;

  return (
    <div
      ref={rowRef}
      className="rc-row rc-row--wait"
      /* 形态钩子：`pre` / `post`（断言"两态切换确实发生过"） */
      data-nav-info={mode}
      data-nav-next-station={nextStationOn ? "1" : "0"}
      data-nav-remain-min={remainMin == null ? undefined : String(remainMin)}
      /**
       * 口径声明 —— 需求 4 的核心断言：
       *   上车后本行的时间 = 车到**下车**（本段终点）的时长，不是「到下一站」。
       *   上车前是「车辆到本站」的预期，故 scope = `board`（两者刻意不同，勿统一）。
       *
       * `data-eta-*` / `data-stops-away` 是**旧名兼容**：既有 QA 脚本
       * （`.verify/_v310-remaining.mjs`、`scripts/test-remaining-view.ts`）按这些名字断言，
       * 本轮信息行合并后不能把它们静默删掉。它们与本行显示值**同源同一表达式**，
       * 不是第二套口径（口径分裂才是历史缺陷的成因）。
       */
      data-eta-scope={mode === "post" ? "alight" : "board"}
      data-eta-base={remainMin == null ? undefined : remainMin}
      data-eta-remain={remainMin == null ? undefined : remainMin}
      data-stops-away={stopsAway == null ? undefined : stopsAway}
      style={{
        /**
         * 定高 52（`INFO_ROW_H`）—— 两态共用 ⇒ 状态切换零跳动。
         * `post` 用 `height`（内容是确定的 20 + 2 + 20 + 10），`pre` 用 `minHeight`：
         *   · 巴士卡：内容 20 + 10 = 30 ⇒ 被 52 撑到 52，与 `post` 完全一致；
         *   · **轻轨卡的例外**：`LrtEtaInline` 自带「主行 + 方向·时刻 + 邻班折叠区」
         *     （`.rc-live` 是列布局，实测就比 52 高；用户展开「前后班次」还会再长），
         *     硬钉 52 会**裁掉**邻班区或让它压到下方纵条上。
         *     ⇒ 让位优先于定高（不截断、不重叠）。实测值照旧写进 `data-nav-info-h`，
         *       断言「两态恒 52」请用**巴士卡**，轻轨卡是已知例外。
         */
        minHeight: INFO_ROW_H,
        height: mode === "post" ? INFO_ROW_H : undefined,
        boxSizing: "border-box",
        /* 单行态垂直居中（上下各 16px 留白）；双行态贴顶，块高 42 = 20 + 2 + 20 */
        alignItems: mode === "pre" ? "center" : "flex-start",
      }}
    >
      {/* 引导图标只换形状不换色（两者同为 `--muted`）—— 避免"颜色承担状态" */}
      <span className="rc-dot rc-dot--wait" aria-hidden="true">
        <Icon name={mode === "pre" ? "busStop" : "bus"} size={16} />
      </span>

      <div style={{ flex: 1, minWidth: 0 }}>
        {/*
          入场淡入 150ms（`--dur-fast`）**只动 opacity**；退场 0ms —— `key` 随形态变化，
          旧内容在切换的那一帧就从 DOM 移除。
          ⚠️ 不做交叉淡出：旧文案「小跑能赶上」与新文案「下一站…」若共存 150ms，
             屏幕阅读器会读到两句互相矛盾的结论，且很可能读到旧的那句。
          `prefers-reduced-motion` 由全局规则兜底（`animation-duration: 0.01ms !important`
             压得过内联样式里的普通声明），无需在这里再判一次。
        */}
        <div
          key={mode}
          style={{
            animationName: "fade-in",
            animationDuration: "var(--dur-fast)",
            animationTimingFunction: "var(--ease-standard)",
            animationFillMode: "backwards",
          }}
        >
          {mode === "pre" ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                /* `minHeight` 而非 `height`：轻轨左槽是列布局（主行 + 方向·时刻 + 邻班区），
                   钉死 20px 会让它溢出到块外。巴士卡内容就是 20px，行为与定高一致。 */
                minHeight: INFO_LINE_H,
                whiteSpace: "nowrap",
              }}
            >
              <span
                style={{
                  /* `flex: 1` 把右槽（赶车标签）挤到行末 —— 与旧 `.rc-text`（flex:1）同一种对齐 */
                  flex: 1,
                  minWidth: 0,
                  fontSize: vw >= 360 ? 14 : 13,
                  lineHeight: `${INFO_LINE_H}px`,
                  color: "var(--fg-2)",
                }}
              >
                {preMain}
              </span>
              {preAside}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, height: INFO_LINE_H * 2 + 2 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 6,
                  height: INFO_LINE_H,
                  lineHeight: `${INFO_LINE_H}px`,
                  whiteSpace: "nowrap",
                }}
              >
                {postStation && (!narrow || postStation.prefix !== "下一站") && (
                  <span style={{ flex: "none", fontSize: 13, color: "var(--muted)" }}>{postStation.prefix}</span>
                )}
                {postStation?.code && (
                  /* 站号：11px / `--meta` / 等宽数字 / **不加括号**（括号占 30px 且不携带信息） */
                  <span
                    style={{
                      flex: "none",
                      fontSize: 11,
                      fontWeight: 500,
                      letterSpacing: "0.02em",
                      color: "var(--meta)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {postStation.code}
                  </span>
                )}
                {postStation?.name && (
                  /* 站名：全档禁止省略号截断（延续既有排版纪律）—— 靠让位阶梯保完整 */
                  <span style={{ flex: "none", fontSize: nameSize, fontWeight: 600, color: "var(--fg)" }}>
                    {postStation.name}
                  </span>
                )}
              </div>
              {postSub && (
                <div
                  style={{
                    height: INFO_LINE_H,
                    lineHeight: `${INFO_LINE_H}px`,
                    fontSize: 13,
                    color: "var(--muted)",
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap",
                  }}
                >
                  {postSub}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* 上车后右槽**刻意留空**：无赶车标签；空白让主行拿到全部宽度（正好容纳 17 字长站名） */}
    </div>
  );
}


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
   * ★ v3.9.0：~~进入步行跟随（用户显式点击「开始步行」）~~ **「开始步行」按钮已删除**
   *   （负责人 2026-11-03：主流程全自动推进——开始导航 ⇒ 直接进步行出发段、下车 ⇒ 自动
   *   进步行到达段——该按钮是冗余入口，且与「开始导航」双入口并存属重复按钮）。
   *   「步骤」展开键的门控改用 `onWalkExpand`（语义等价：导航详情传、收藏薄壳不传）。
   * ★ T1：**两段都可**（`out` = 走到上车站 / `in` = 下车站走到目的地）。
   * 传 `undefined` ⇒ 本组件**不渲染**展开键（收藏页 `RouteDetailSheet` 无地图上下文，走这条）。
   */
  onWalkExpand?: ((seg: "out" | "in") => void) | null;
  /** 首段步行预览数据（由宿主 `useWalkRoute` 提供） */
  walkPreview?: WalkPreview;
  /** ★ T1：末段步行预览数据（下车站 → 目的地；缺省 = 不渲染末段入口） */
  walkInPreview?: WalkPreview;
  /**
   * ★ 2026-11-03（需求 1）：**服务端重算的剩余行程**（`POST /api/nav/remaining` 产物）。
   *   缺省 `null` ⇒ 完全走客户端兜底（由 `card.arriveAt` 与当前时刻派生），首屏即刻可用。
   *
   *   为什么通过「绝对到达时刻 + 时钟偏移」传，而不是直接传相对分钟：
   *   相对值一过网络往返/服务端缓存就偏大（`/api/station/eta` 已踩过，见
   *   `src/app/api/station/eta/route.ts:120-125` 的 `serverNowMs` 注释）。传 `arriveAt`
   *   + `clockOffsetMs`，渲染时现算，**不受往返延迟影响**，也不会「每次跳一格」。
   */
  liveRemain?: {
    /** 服务端剩余分钟（相对）—— 总时长显示的唯一来源（**不用 arriveAt 反算**） */
    remainingMin: number;
    /** 服务端绝对到达时刻（ms）—— 到达时刻显示的唯一来源 */
    arriveAt: number;
    /** 服务端响应生成时刻（ms）—— 时间轴对齐 */
    serverNowMs: number;
    /** 缓存陈旧秒（命中微缓存时 `remainingMin` 已过时这么久）—— 必须扣掉，否则偏大 */
    staleSec: number;
    /** 客户端相对服务端的时钟偏移（ms）；0 = 无服务端结果 */
    clockOffsetMs: number;
    /** ★ 每次**真重算**自增 ⇒ 观测钩子 `data-recompute-seq`（区分「真重算」与「重渲染同一帧」） */
    seq: number;
  } | null;
  /**
   * ★ 2026-11-03（需求 1）：**服务端重算后的纵条**（整份 `SegmentStrip[]`）。
   *   有值 ⇒ **整份替换**静态 `strips` 传给 `NavStrip`（不是打补丁），保证
   *   「顶部总时长」与「纵条各段分钟」来自同一份数据 ⇒ 整屏一致。
   *
   *   ⛔ 红线：调用方只允许替换 `body.strips`，**绝不能碰 `body.legs`** ——
   *   否则 `useRouteOverview` 会走 `setLegs([])` + `setBox(null)`（`useRouteOverview.ts:84-89`），
   *   地图彩段被清空重画、取景被放弃，导航中视野会跳。
   */
  liveStrips?: SegmentStrip[] | null;
  /**
   * ★ 2026-11-03（批 1）：**最近一次剩余行程重算的失败形态**（`"403:forbidden"` 等）。
   *   `null`/缺省 ⇒ 最近一次成功或还没请求过 ⇒ 观测钩子 `data-remain-fail` **不输出**。
   *
   * ⚠️⚠️ **本属性缺失 ≠「刷新成功」**（写断言前必读）：
   *   缺失还可能是**从未发起**重算 —— `boarding` 相位（端点被刻意排除）/ LRT 腿 /
   *   请求在飞 / 面板刚开 `card` 未就绪。
   *   ⇒ 断言「刷新成功」**必须同时看 `data-recompute-seq` 递增**（它只在真重算成功时 +1）。
   *   只判「本属性不存在」= 把「没发起」误判成「成功了」，是典型的假绿。
   *
   *   为什么必须暴露到 DOM：负责人主诉是「点了刷新有反应但不知道刷新了什么」，
   *   而 403/5xx 会被静默吞掉（`fetch` 对 4xx 不抛 ⇒ 连 catch 都不进）⇒
   *   用户看到「点了完全没反应」= **同款失败模式的更严重版本**。
   *   有了这个属性，QA 可断言「点刷新后不得出现 `403:*`」，线上也可一眼看出是 403 还是 5xx。
   */
  liveRemainFail?: string | null;
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
  onWalkExpand,
  walkPreview = EMPTY_WALK_PREVIEW,
  walkInPreview = EMPTY_WALK_PREVIEW,
  liveRemain = null,
  liveStrips = null,
  liveRemainFail = null,
}: NavDetailBodyProps) {
  /**
   * ★ T1：步行步骤展开态（不记忆，父组件持有亦不落盘）。
   *   改为「哪一段展开中」而不是布尔 —— 首段/末段各一个入口，同时只允许展开一段
   *   （两段都展开会把面板滚成两屏，且用户当前只关心接下来要走的那段）。
   */
  const [walkOpen, setWalkOpen] = useState<"out" | "in" | null>(null);
  const colorOf = (c: string) => colors[c] ?? null;
  const first = card.rides[0];
  /**
   * ★ U5（2026-11-04）：原 `firstHint = catchHintOf(first)`（合并式：`catchHint` 优先、
   *   回落 `tierText`）在本组件**已废弃** —— 导航信息行右槽只用档位短词 `tierText`
   *   （带时刻的 `catchHint` 实占 165px，320px 下把左槽压到 86px 而溢出；左槽已表达同一件事）。
   *   ⚠️ 「合并式」仍用于**方案卡场景**（`RecommendCard` / `CardDetailClient`），未改动。
   */
  /** ★ v3.3.0（AC-102）：总览栏线路标签 = 与推荐卡同构的分段结构（含段内并行线） */
  const routeSegments = card.rides.map((r) => ({ codes: [r.route, ...(r.parallelRoutes ?? [])] }));
  const legIdx = track ? track.legIndex : 0;
  /**
   * 本段站序。用 `useMemo` 而**不是**条件表达式：`?? []` 每次渲染都会造一个新数组，
   * 下游 `useMemo`（`postStation` / `postSub`）的依赖就会"每帧都变" ⇒ 白跑 + lint 报警。
   * 站名/站号在 recompute 前后完全一致（服务端只改分钟），故静态 `strips` 足够。
   */
  const trackStops = useMemo(
    () => (track && track.phase !== "off" ? (strips[legIdx]?.stops ?? []) : []),
    [track, strips, legIdx],
  );

  /* ══════════════════════════════════════════════════════════════════════
     ★ U2 / U5（2026-11-04）：信息行形态 + 赶车标签可见性
     ─────────────────────────────────────────────────────────────────────
       · `riding` ⇒ `post`（两行：下一站 + 到下车时长）；
       · 已上过车但已不在车上（`done` / 末段步行 `walk`）⇒ **整行不渲染**：
         此时既不该说「等车还有几分钟」，也没有可说的「下一站」—— 留着就是过期结论；
       · 其余（未开始 / 步行去站 / 候车）⇒ `pre`（单行）。
     ⚠️ `riding` 放在锁存**前面**只是兜底：两者由 `NavShell` 在同一次 commit 里写入，
        正常不会打架；万一将来 Context 的下发时序变了，也不会把乘车态渲染成候车态。
     ⚠️ 不要在这里用 `ride.phase === "boarding"` 判「已到站」，那正是历史缺陷 #1 的成因
        （「步行去车站」一路上 `ride.phase` 已经是 `boarding`）。

     ── ⚠️ 显式待办：**换乘候车期（第二程 boarding）不渲染信息行**───────────
       现象：下第一程车、在换乘站台等第二程时（锁存已置位 + `phase === "boarding"`），
             本行整块消失。**这是 v3.11 的刻意取舍，不是漏做**，别当缺陷"修"回去。
       ① 为什么不能直接复用 `pre` 行：`pre` 行的左槽硬绑 `card.rides[0]`，
          换乘期拿它会显示**第一程**的等车 ETA —— 那是错数据，宁可不显示
          （底栏「等待上车 · 站名」与纵条仍在，不是死路）。
       ② 要支持需要：把 `pre` 行改成按 `legIdx` 取 `card.rides[legIdx]`，
          并把上车站名同步成 `card.rides[legIdx]` 对应的那一站（现在写死第一程）。
       ③ 另一个前置条件：U2 规定赶车标签「进入 riding 起至本次导航结束前永不复活」，
          所以换乘期的 `pre` 行**必须**继续受 `showTag` 约束（只补数据，别顺手把标签放回来）。
     ══════════════════════════════════════════════════════════════════════ */
  const hasEnteredRiding = useContext(CatchTagLatchContext);
  const riding = track?.phase === "riding";
  const infoMode: "pre" | "post" | "none" = riding ? "post" : hasEnteredRiding ? "none" : "pre";
  /**
   * 赶车标签是否允许渲染（**唯一判据 = 锁存**，与布局形态解耦）。
   * 隐藏方式是**不渲染**（DOM 移除）：`opacity: 0` 对屏幕阅读器仍然可读，
   * 等于把错误结论从"看得见"变成"听得见"，且截图验收发现不了。
   */
  const showTag = !hasEnteredRiding;

  /* ══════════════════════════════════════════════════════════════════════
     ★ U4（2026-11-04）：**到下车（本段终点）剩余分钟 —— 全界面唯一口径**
     ─────────────────────────────────────────────────────────────────────
     ⛔ 旧实现（`etaBaseMin`）在 `segProgress` 可用时直接用 `segRemainSec / 60` ——
        那是「到**下一站**」的时长（`segFrom → segTo` 是相邻两站之间的区间），
        漏掉了 `nextIdx` 之后到下车点的所有跳 ⇒ 数字系统性偏小。这就是需求 4 的根因。

     ① **服务端优先**：`liveStrips` 是服务端 `buildStrips(patchedCard)` 的产物，
        其 `rideMin` = `patchedCard.rides[legIndex].minutes` = 服务端 `curRemainMin`
        （公式正是 `segRemainSec / 60 + hopMinutesFrom(pivotIdx)`，即「到下车」）。
     ② 服务端值不可用（请求未返回 / 首帧 / 该段无重算）⇒ 回落**整段静态时长**
        `card.rides[legIndex].minutes`：保守偏长，宁可让用户早到，不谎报更短。
     ③ ⛔ 不再自己按「到下一站」重算，也不做本地秒级递减 —— 每 12s 车辆帧到达时
        服务端重算并整份替换纵条，数字随之重校准（与顶部「全程剩余」同一节拍）。
     ══════════════════════════════════════════════════════════════════════ */
  const alightMin = useMemo(() => {
    const served = liveStrips?.[legIdx]?.rideMin;
    if (served != null && Number.isFinite(served) && served >= 0) return served;
    const full = card.rides[legIdx]?.minutes;
    return full != null && Number.isFinite(full) && full >= 0 ? full : null;
  }, [liveStrips, legIdx, card.rides]);
  /** 显示值：地板 1 分（写「约 0 分」读起来像已到站，会与到站提醒抢语义 —— 沿用既有口径） */
  const shownAlightMin = alightMin == null ? null : Math.max(1, Math.round(alightMin));
  /** 到下车还有几站（`null` = 进度未知 / 站序不足两站：不写「还有 0 站」，那是假精确） */
  const stopsAway =
    track?.prog && trackStops.length >= 2
      ? Math.max(0, trackStops.length - 1 - track.prog.passedIdx)
      : null;

  /**
   * 上车后主行「要盯的那一站」：到站提醒已在响（`alarm === "now"`）⇒ 当前停靠站；
   * 其余 ⇒ 下一站。两者都取不到（无车辆帧 / 冻结到 lost）⇒ 退回「下车站」，不猜「下一站」。
   */
  const watchIdx = track?.prog
    ? track.alarm === "now"
      ? (track.prog.atIdx ?? track.prog.nextIdx)
      : track.prog.nextIdx
    : null;
  const postStation = useMemo<PostStation | null>(() => {
    const at = (k: number | null) =>
      k !== null && k >= 0 && k < trackStops.length ? splitStopLabel(trackStops[k]) : null;
    const hit = at(watchIdx);
    if (hit) return { prefix: track?.alarm === "now" ? "已到站" : "下一站", ...hit };
    const last = trackStops.length ? splitStopLabel(trackStops[trackStops.length - 1]) : null;
    return last ? { prefix: "下车站", ...last } : null;
  }, [watchIdx, trackStops, track?.alarm]);

  /** 上车后次行：`还有 n 站下车 · 约 x 分`（缺哪半句就省哪半句，**不补零、不写"约 0 分"**） */
  const postSub = useMemo(() => {
    if (infoMode !== "post") return null;
    /* 已到下车站 ⇒ 去掉时间子句（此刻「约 x 分」必然为 0，写出来像故障） */
    if (track?.alarm === "now") return "本站下车";
    const parts: string[] = [];
    if (stopsAway != null) parts.push(`还有 ${stopsAway} 站下车`);
    if (shownAlightMin != null) parts.push(`约 ${shownAlightMin} 分`);
    return parts.length ? parts.join(" · ") : null;
  }, [infoMode, track?.alarm, stopsAway, shownAlightMin]);

  /**
   * 15s 心跳：**只服务顶部「全程剩余」的时钟重算**（`remainNowMs`）。
   * ⚠️ U4 之后它**不再**驱动「到下车分钟」—— 那个数字来自服务端重算（见 `alightMin`），
   *   `data-eta-remain` 的旧语义「本地每 15s 递减」随之作废（同源同值，不再独立递减）。
   */
  const [etaTick, setEtaTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setEtaTick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  /* ══════════════════════════════════════════════════════════════════════
     ★ 2026-11-03（需求 1）：全程剩余 / 到达时刻「活」起来
     ─────────────────────────────────────────────────────────────────────
     改造前 `card.totalMin` / `card.arriveAt` 是**规划时快照**，永不重算：
     总时长永远停在规划那一刻，到达时刻是个死时刻（时间在走它不动）。
     现在改为**现算**，任何一次渲染（含刷新）都自洽。

     ── 两个入口，按有无服务端结果分流（契约见 team-lead 冻结版）──────
       · 有服务端结果（`liveRemain`）⇒ `remainServedOf`：
           **总时长 = `remainingMin` 基准**（扣缓存陈旧 + 扣响应后流逝）；
           **到达时刻 = `arriveAt` 绝对锚**。两条独立，**不用 arriveAt 反算总时长**。
       · 无服务端结果 ⇒ `remainOf(card.arriveAt, now)` 兜底（首帧 / 请求失败 / 非乘车段）。

     · 当前时刻：`Date.now() + clockOffsetMs`（本地时间映射到服务端时间轴）；
       ⚠️ **禁止渲染期直接 `Date.now()`**（`useCooldown.ts:15` 项目纪律）⇒ 取在
       `useMemo` 里，且**只由既有 15s `etaTick` 驱动**（不新增第二个定时器）。
     · 两条语义红线（刻意不同，勿"统一"）见 `src/lib/nav/remaining-view.ts` 头注。
     ══════════════════════════════════════════════════════════════════════ */
  const clockOffsetMs = liveRemain?.clockOffsetMs ?? 0;
  /** 服务端时间轴上的"现在"（无服务端结果时等于本地时间） */
  const remainNowMs = useMemo(
    () => Date.now() + clockOffsetMs,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [etaTick, clockOffsetMs],
  );
  const remain = useMemo(
    () =>
      liveRemain
        ? remainServedOf({
            remainingMin: liveRemain.remainingMin,
            serverNowMs: liveRemain.serverNowMs,
            staleSec: liveRemain.staleSec,
            arriveAtMs: liveRemain.arriveAt,
            nowMs: remainNowMs,
          })
        : remainOf(card.arriveAt, remainNowMs),
    [liveRemain, remainNowMs, card.arriveAt],
  );
  /** 全程剩余（整数分钟，已 clamp ≥0 —— **绝不出现 "-3 分"**） */
  const remainTotalMin = remainTotalMinOf(remain);
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
              {/* ★ v3.9.0：「开始步行」按钮已删（负责人 2026-11-03）——主流程全自动推进
                  （NavShell `startSession`），此按钮是与「开始导航」重复的第二入口。
                  步骤列表与「全程 · 时间」摘要保留。 */}
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
      {/* 头部：总用时 / 到达 + 线路标签**同行**（★ 去灰框、仅下分割线；删「估算」）
          ★ 2026-11-03（需求 1）：总用时改**剩余**（clamp ≥0，归零切「即将到达」）；
            到达时刻用权威值（服务端重算 → 回落规划值），overdue 时标「预计已过」。
            ⛔ 两处必须与 peek 摘要（`RouteSheet`）同源同次 —— 只改一处会让面板
               收起到 peek 后数字变回规划值（本项目已踩过的「两个真相」缺陷）。 */}
      <div
        className="rc-dhead"
        data-remain-total={remainTotalMin}
        /* ★ 2026-11-03：**服务端 `remainingMin` 原值**（未扣 tick 递减的校准锚点；无服务端结果时不输出）。
           为什么需要它：`data-remain-total` 是每秒随 `nowMs` 递减的**显示值**，
           QA 拿它做「刷新后变小了多少」的断言会被 15s tick 的噪声干扰；
           本属性给的是服务端那一帧的原始基准 ⇒ 差值断言干净可复现。
           ⚠️ 与 `data-eta-base` 是**两个不同指标**（前者=全程①，后者=本段④），勿混。 */
        data-remain-base={liveRemain ? Math.round(liveRemain.remainingMin * 10) / 10 : undefined}
        data-arrive-at={Math.round(remain.arriveAtMs)}
        data-recompute-seq={liveRemain?.seq ?? 0}
        /* ★ 2026-11-03（批 1）：失败留痕。**成功时不输出该属性**（`undefined` 即不渲染）。
           QA 断言：点刷新后不得出现以 `403` 开头的值。
           ⚠️⚠️ **本属性缺失 ≠「刷新成功」**：也可能是**从未发起** ——
                 · `boarding` 相位（本端点被刻意排除，见 `useNavRemaining` 的 `enabled`）
                 · LRT 腿（`refreshScope === "lrt"`，车辆帧与剩余重算都不产生新值）
                 · 请求还在飞（首帧未回）
                 · 面板刚打开、`card` 尚未就绪
           ⇒ **断言「刷新成功」必须同时看 `data-recompute-seq` 递增**（它只在真重算成功时 +1）。
             只判「本属性不存在」会把「没发起」误判成「成功了」—— 典型的假绿。 */
        data-remain-fail={liveRemainFail ?? undefined}
      >
        <div className="rc-dhead__l">
          <div className="rc-dhead__total">
            {remain.arrived ? (
              <span className="rc-total rc-total--arrived">{REMAIN_ARRIVED_TEXT}</span>
            ) : (
              <>
                <span className="rc-total">{remainTotalMin}</span>
                <span className="rc-total__unit">分</span>
              </>
            )}
          </div>
          <span className="rc-dhead__arrive">
            {remain.overdue ? (
              <>
                {ARRIVE_OVERDUE_TEXT} <b>{macauClock(remain.arriveAtMs)}</b>
              </>
            ) : (
              <>
                预计 <b>{macauClock(remain.arriveAtMs)}</b> 到达
              </>
            )}
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
            onWalkExpand ? (
              <WalkSegToggle idPrefix="detail-out" open={walkOpen === "out"} onToggle={toggleWalk("out")} />
            ) : null
          }
        />
        {/* ★ v3.6.0 S5：展开的步骤列表（紧随「步行」行；预览态 currentIdx=-1 ⇒ 全部未走） */}
        {onWalkExpand && walkOpen === "out" && walkPreviewBlock("out", walkPreview, "detail-out")}
        {/*
          ★ U5（2026-11-04）：**导航信息行** —— 就在原「等车行」这个 DOM 位置，**整行替换**两态。
            上车前：`[busStop] 还有 3 站 · 约 6 分            [小跑能赶上]`
            上车后：`[bus] 下一站  M220  黑沙環馬路`
                    `      还有 4 站下车 · 约 9 分`
            两态容器同为 52px ⇒ 切换零跳动（不做 height 过渡）。
          ⚠️ 必须"整行替换"而不是"在等车行下面再插一块"：
             · 轻轨 `LrtEtaInline` 的邻班区（`neighbors="collapsed"` 展开后）自带 `TierBadge`，
               乘车态若还留着等车行，赶车标签会从邻班行**泄漏**回来；
             · 「下一站」会出现两处（本行一处 + 纵条 `.navstrip__badge` 一处）。
          ⚠️ `infoMode === "none"`（已上过车但已不在车上）⇒ **整行不渲染**：既不该说「等车还有几分钟」，
             也没有可说的「下一站」，留着就是过期结论。
        */}
        {infoMode === "pre" && first && (
          <NavInfoRow
            mode="pre"
            preMain={
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
                /* 无实时数据 ⇒ 「等车约 X 分」：有"约"字，不谎称精确 */
                <EtaText text={minuteUnitOf(first.liveText || `等车约 ${Math.round(first.waitMin)} 分`)} />
              )
            }
            preAside={
              /**
               * ★ U2（2026-11-04）：**赶车标签的唯一判据 = 锁存**（`showTag`）。
               *   `showTag === false` ⇒ 返回 `null` ⇒ **DOM 里不存在这个节点**。
               *   ⛔ 禁止改成 `opacity: 0` / `visibility: hidden`：那对屏幕阅读器仍然可读，
               *      等于把「小跑能赶上」这句过期结论从"看得见"变成"听得见"，而且截图验收发现不了。
               *
               * ★ 右槽只用**档位短词** `tierText`（≤9 全角），**不用带时刻的 `catchHint`**：
               *   `走快一点可赶上 14:32 那班` 实占 165px，320px 下把左槽压到 86px 而溢出；
               *   而且左槽已经表达了同一件事（轻轨分支的时刻由 `LrtEtaInline` 提供）。
               *   ⚠️ 影响面仅本行：方案卡（`RecommendCard` / `CardDetailClient`）继续用合并式。
               */
              showTag && first.tierText ? (
                <span data-tag="on" style={{ flex: "none" }}>
                  <TierBadge tier={first.tier} tierText={first.tierText} />
                </span>
              ) : null
            }
            postStation={null}
            postSub={null}
            nextStationOn={false}
            remainMin={null}
            stopsAway={null}
          />
        )}
        {infoMode === "post" && (
          <NavInfoRow
            mode="post"
            preMain={null}
            preAside={null}
            postStation={postStation}
            postSub={postSub}
            nextStationOn
            remainMin={shownAlightMin}
            stopsAway={stopsAway}
          />
        )}
      </div>

      {/* ★ U5（2026-11-04）：原 `.nav-note-neutral--eta` 块（「距离」徽标 + 距下车站还有 N 站 +
          小字「约 X 分钟」）**已并入上方导航信息行并删除**。
          · 不删会让「下一站」出现两处（本行 + 纵条 `.navstrip__badge`，`NavStrip.tsx:131`）；
          · 它的两条观测钩子（`data-stops-away` / `data-eta-base` / `data-eta-remain`）已
            **原值迁移**到信息行上（同一表达式），既有 QA 脚本无需改写。
          · 它的时间口径是「到下一站」（`segRemainSec/60`），与需求 4 的「到下车」相反 ——
            留着就是两个互相打架的真相，这正是本轮要消灭的东西。 */}

      {/* 进度纵条（一趟一条；导航中仅当前乘车段显示实时进度）
          ★ 2026-11-03（需求 1）：`liveStrips`（服务端重算后的整份纵条）**优先于**静态 `strips`。
            ⇒ 顶部「全程剩余」与纵条「车上约 N 分 / 等车约 N 分」来自同一份重算数据 ⇒ 整屏一致。
            ⚠️ 这里是**整份替换**、不改 `NavStrip` 渲染逻辑；`key` 仍按路线+上下车站拼，
               因此组件的 `open` 展开态不会因替换而丢失。 */}
      <div className={`rc-strips${immersive ? " rc-strips--immersive" : ""}`}>
        {(liveStrips ?? strips).map((strip, i, arr) => (
          <NavStrip
            key={`${strip.route}-${strip.board}-${i}`}
            strip={strip}
            color={colorOf(strip.route)}
            last={i === arr.length - 1}
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
            nextKind={arr[i + 1]?.kind ?? null}
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
            onWalkExpand ? (
              <WalkSegToggle
                idPrefix="detail-in"
                open={walkOpen === "in"}
                onToggle={toggleWalk("in")}
              />
            ) : null
          }
        />
        {onWalkExpand && walkOpen === "in" && walkPreviewBlock("in", walkInPreview, "detail-in")}
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
