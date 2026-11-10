"use client";

/**
 * 首页导航壳（src/components/nav/NavShell.tsx）
 *
 * ── 2026-09-23 交互改版（Spec v2.12.0「谷歌地图式弹窗」）──────────────────
 *   状态机（单一 `RouteSheet` 宿主）：
 *
 *   ```
 *   map（全屏地图）
 *      │ 点搜索框
 *      ▼
 *   search（SearchSheet）
 *      │ 选点
 *      ▼
 *   panel（RoutePanel，半屏可出发）
 *      │ 点「出发」
 *      ▼
 *   sheet{ open, pane:'recommend', detent:'full' }   // 推荐默认 full
 *      │ 点卡片（当帧切 pane + full→half 动画 + 骨架）
 *      ▼
 *   sheet{ open, pane:'detail', detent:'half' }      // 上半屏 = 路线总览
 *      │ 上拖 → full ／ 下拖 → peek
 *      └ 关闭/返回/peek 下拉越过 → pane:'recommend', detent:'full'
 *                                   │ peek 下拉越过 / X
 *                                   ▼
 *                              panel（回可出发态；无 OD → map）
 *   ```
 *
 * ── 铁律（沿用 + 本轮）────────────────────────────────────────────────
 *   · ★ **不记忆**出发点（产品 R5）；收藏是**用户显式意图**，故允许；
 *   · 「出发」→ 面板内规划（★ 坐标 **GCJ-02**），**不整页跳转**；
 *   · 地图失败**不阻塞**：搜索/列表/详情照常；
 *   · ★ **面板与卡片一律挂在 `.nav-map-wrap` 之外** —— wrap 是 `position:fixed; z-index:0`
 *     的**层叠上下文**，挂进去会被底部 chrome 压住（Spec AC-13 的历史教训）；
 *   · ★ **非模态**：无 scrim，露出的地图带可拖/可点；点地图空白**不关闭**面板；
 *   · ★ 取景**全部自算**（`fit-box`），**禁用** `setBounds`/`setFitView`（会撑到珠海）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Icon from "@/components/ui/Icon";
import NavMap from "./NavMap";
import NavBrandBar from "./NavBrandBar";
import AlightBanner from "./AlightBanner";
import PinDiag from "./PinDiag";
import NavSearchBarSlot from "./NavSearchBarSlot";
/* ★ v3.6.0 S5：步行导航（预取 + 跟随状态机 + 顶部横幅） */
import { useWalkRoute, WALK_RELOAD_MAX } from "@/components/walk/useWalkRoute";
import { useWalkFollow } from "@/components/walk/useWalkFollow";
import WalkTurnBanner from "@/components/walk/WalkTurnBanner";
import type { WalkStep } from "@/lib/walk/walk-shared";
import { distM } from "@/lib/nav/route-overview";
import { remainFromIdxOf, segRemainSecOf } from "@/lib/nav/track";

/** 稳定的空 steps 引用（避免每次渲染新建数组 ⇒ 触发 hook 内部 effect 重跑） */
const EMPTY_WALK_STEPS: WalkStep[] = [];
/** 顶部跟随横幅高度（px）—— 与 `--walkturn-h` 同值，取景中带计算用（改多行须同步上调） */
const WALKTURN_H = 64;

/* ══════════════════════════════════════════════════════════════════════════
   ★ 修复批 #10（2026-11-06）：候车期「自动重算赶车档」的三条阈值（R4 裁决）
   ─────────────────────────────────────────────────────────────────────────
   三条**同时**满足才自动重算（点刷新那次不看这三条，必算）：
     ① 位移 ≥ `CATCH_RECALC_MIN_MOVE_M`；
     ② 距上次重算 ≥ `CATCH_RECALC_MIN_GAP_MS`；
     ③ 定位精度 ≤ `CATCH_RECALC_MAX_ACC_M`。

   ── 为什么是 40m（依据，不是拍脑袋）─────────────────────────────────────
     步行段 σ ≈ 10m（`coarse: false`，见本文件 `useUserFix` 调用处的 I0 注释：
     粗定位 σ ≈ 50m 已全程关闭）⇒ 3σ = 30m 是**噪声下限**，低于它"位移"可能全是抖动。
     取 40m = 3σ + 余量 ⇒ 一次自动重算至少覆盖 4 个 σ 的真实移动。
   ── 为什么是 20s ──────────────────────────────────────────────────────
     与既有节拍对齐：车辆帧 `POLL_MS = 12s`、`/api/station/eta` 服务端微缓存 20s
     （`route.ts:63`）。取 20s ⇒ 最多 3 次/分，且**不会穿透**服务端缓存（不会白打 DSAT）。
   ── 为什么是 30m 精度 ─────────────────────────────────────────────────
     3σ 判据的同一口径：精度差于 30m 时"位移 ≥ 40m"无法与噪声区分 ⇒ 宁可不算
     （保持上一次结论，比拿噪声重算出一个跳变的档位更诚实）。
   ══════════════════════════════════════════════════════════════════════════ */
const CATCH_RECALC_MIN_MOVE_M = 40;
const CATCH_RECALC_MIN_GAP_MS = 20_000;
const CATCH_RECALC_MAX_ACC_M = 30;

/** 实时赶车档的空态（稳定引用，避免每次渲染换新对象） */
const CATCH_LIVE_IDLE: { tier: CatchTier | null; text: string; seq: number } = {
  tier: null,
  text: "",
  seq: 0,
};
import RouteLinesSheet from "./RouteLinesSheet";
import LineStopsSheet from "./LineStopsSheet";
/** ★ 2026-11-06（修复批 #4/#5a）：澳门巴士 / 轻轨的线路站序三档弹窗（前端 C 产出） */
import RouteStopsSheet from "./RouteStopsSheet";
import TqhStationCard from "./TqhStationCard";
import { loadTqhTripPath, useTqhLines } from "./tqh-lines";
import {
  sharedBusMainCodes,
  stationMapOf,
  tqhEntriesAtBusStation,
  tqhEntriesAtStations,
  tripsOfRouteNo,
  tripStationIds,
  type TqhSegment,
  type TqhStation,
  type TqhTrip,
} from "./tqh-model";
import RoutePanel from "./RoutePanel";
import RouteSheet from "./RouteSheet";
import SearchSheet, { type QuickPair } from "./SearchSheet";
import StationCard, { type StationCardStation } from "./StationCard";
import VehicleCard from "./VehicleCard";
import { queryOf } from "./StepSheet";
import { useRouteVehicles } from "./useRouteVehicles";
import { useRouteOverview } from "./useRouteOverview";
import { useRideTracking, type RidePhase, type RideTrackView } from "./useRideTracking";
/**
 * ★ U2（2026-11-04）：赶车标签的**单向锁存**下发通道。
 *
 * 为什么是 Context 而不是 prop 透传：值要穿 `RouteSheet` → `RouteDetailPane` → `NavDetailBody`
 * 三层，而中间两份文件本轮不在改动范围（同一工作区还有别的成员在改）。
 * Context 只依赖 React 树，不依赖中间的传参写法。
 * ⚠️ 值本身必须由**本文件（会话层）**持有：放 `NavDetailBody` 会随面板重挂载丢状态
 *   （peek → detail 回来标签又出现）。
 */
import { CatchTagLatchContext, BoardingLiveContext, type BoardingLiveValue } from "./NavDetailBody";
/**
 * ★ 2026-11-05：「人确实在车上」判据（`riding` 语义变更后的唯一判据真源）。
 *   与 `NavDetailBody.infoMode` **必须**共用同一份——两边各写一套必然漂。
 */
import { gaveUpBusOfRide, ridingRealOfRide } from "./riding-real";
import { useNavRemaining } from "./useNavRemaining";
/**
 * ★ 修复批 #9（2026-11-06）：**候车期**的实时报站通道（未上车时 `/api/nav/remaining` 被刻意排除，
 *   见 `useNavRemaining.ts` 的 `enabled` 注释 —— 那是正确的排除，本 hook 是**另一条**通道）。
 */
import { useBoardingEta } from "./useBoardingEta";
/** ★ 修复批 #10（2026-11-06）：候车期「怎样走才能赶上」的实时重算（纯函数 + 单点算法） */
import { catchUpLive } from "@/lib/nav/catch-up-live";
/** ★ 修复批 #10：档位重算要用的常速步行速度 —— 唯一来源是 `WALK_BASE_M_PER_MIN`（= 84），不许自造 */
import { WALK_BASE_M_PER_MIN, type CatchTier } from "@/lib/recommend/types";
/** ★ 修复批 #10：剩余步行米数（未跟随态也能算）—— 与步行横幅/地图三线**同一个**投影函数 */
import { progressOnPath } from "@/lib/walk/follow";
import { useUserFix } from "./useUserFix";
import { useNavFrame, type FrameBox } from "./useNavFrame";
/* ★ 步行路径重算的防连点冷却（现成常量，勿新写数字） */
import { COOLDOWN_WALK_SEC, useCooldown } from "./useCooldown";
import {
  detentIndex,
  detentTopsPx,
  readSafeBottomPx,
  readSafeTopPx,
  tqhDetentTopsPx,
  type Detent,
} from "./sheet-detents";
import { unionBox } from "@/lib/nav/route-overview";
import { mainOf } from "@/lib/nav/track";
/** ★ 修复批 #7：线路标签统一口径（巴士 `26` / 轻轨官方繁体 `氹仔線`，都不带中文后缀） */
import { lineNameOf } from "@/lib/route-label";
import { useCombos } from "@/lib/favorites/useCombos";
import { endpointOf } from "@/lib/favorites/types";
import type { RecommendCard } from "@/lib/recommend/types";
import type { NavPoint } from "@/lib/nav/types";
/** ★ 2026-11-06（#5a）：站序接口响应类型（纯 type，无 pg 依赖） */
import type { RouteStopsOk, RouteStopsResp } from "@/lib/line/line-shared";
import XborderCard from "@/components/map/XborderCard";
import { xbPinById } from "@/components/map/xborder-pins";
/* ★ M4（需求 2/3/5/6）：图层偏好 + 图层面板 + 公厕弹窗 */
import { useLayerPrefs } from "@/lib/map/useLayerPrefs";
import type { PublicToilet } from "@/lib/map/public-toilets";
import type { XbPinKind } from "@/components/map/xborder-pins";
import LayerSheet from "./LayerSheet";
import PublicToiletCard from "./PublicToiletCard";

const MY_LOCATION = "我的位置";
/**
 * 「从 `/line` 返回时重开搜索层」的一次性标记（与 `SearchSheet.SS_RETURN` **同一个 key**）。
 * 只有一个消费点：下面 `stage` 的 `useState` 初始化函数（读到即删）。
 */
const SS_SEARCH_RETURN = "mmap.search.return";
/**
 * ★ 2026-11-06（修复批 #3）：**稳定空集** —— 「通琴号标全隐」的白名单值。
 * 必须是模块级常量：`TqhStationLayer` 的 `plan` 用它做依赖，每次新建 Set 会无谓重建 marker。
 */
const EMPTY_ID_SET: ReadonlySet<number> = new Set<number>();
/**
 * ★ 2026-11-06（修复批 #6）：**稳定空集**（字符串版）—— 「巴士站全隐」的白名单值。
 * 同上：`NavMap` 的巴士站点图层把它放进 effect 依赖，必须是模块级常量。
 */
const EMPTY_CODE_SET: ReadonlySet<string> = new Set<string>();
/** 底层舞台：全屏地图 / 全屏搜索 / 半屏可出发 */
type Stage = "map" | "search" | "panel";

export interface NavShellProps {
  jsKey: string;
  /** ★ AC-16：自定义地图样式 ID（隐藏底图自带公交站点）；缺省 = 用高德默认样式 */
  mapStyleId?: string;
  colors?: Record<string, string>;
  /** 由「地点对收藏」带入的起点（收藏页回放用） */
  initialFrom?: NavPoint | null;
  /** 由「地点对收藏」带入的目的地 */
  initialTo?: NavPoint | null;
  /**
   * ★ 需求 4：URL `?board=tqh` ⇒ 首帧就打开「公共交通路线」弹窗并落在**通琴号板块**。
   *
   * ⚠️ 只做"落到板块"这一件事，**不自动选中任何班次**（不弹 A1 站序面板）。
   *   配套：`?no=A1` 这个参数**首页侧完全不接**（见 `page.tsx` 的口径注释）——
   *   调用方那个 `no` 是历史遗留，不要为了"物尽其用"在这里复活它。
   */
  initialBoard?: boolean;
}

export default function NavShell({
  jsKey,
  mapStyleId = "",
  colors = {},
  initialFrom = null,
  initialTo = null,
  initialBoard = false,
}: NavShellProps) {
  /** 定位点（GCJ-02）；null = 尚未定位/定位失败 */
  const [userPos, setUserPos] = useState<{ lng: number; lat: number } | null>(null);
  /**
   * ★ T8（P0 修复 · 2026-10-31）：`useUserFix` 的产出镜像 —— 作为「当前位置」的**第二来源**。
   *
   * ── 为什么需要（现场 P0）─────────────────────────────────────────────
   *   蓝点与「当前位置」本来是**两条互不相通的链路**：
   *     · 蓝点 `userFix={userFixR.fix}` ⇒ **有值**（所以 `data-userdot=blue`）；
   *     · `myLocation ← userPos ← onLocate ← NavMap.runLocate`（高德定位）
   *       ⇒ 在高德定位未回调 / 失败时**恒 null** ⇒ `fromPoint` 为 null ⇒
   *         `canGo` 恒 false ⇒ **「出发」永久置灰**，且 `RoutePanel` 显示「选择出发地」。
   *   症状：用户看得见自己在哪，却点不了出发。
   *
   * ── 为什么是 state 而不是直接读 `userFixR.fix` ─────────────────────────
   *   ⚠️ **`userFixR` 声明在 :284，而 `myLocation` 在 :189** —— 直接引用会命中
   *      `const` 的 TDZ，运行时报 `ReferenceError`。此处用「状态 + 靠后 effect 同步」
   *      跨过这个顺序约束，**不要**把它"简化"成就地读 `userFixR.fix`。
   */
  const [fixPos, setFixPos] = useState<{ lng: number; lat: number } | null>(null);
  const [from, setFrom] = useState<NavPoint | null>(initialFrom);
  const [to, setTo] = useState<NavPoint | null>(initialTo);
  const [station, setStation] = useState<StationCardStation | null>(null);
  /**
   * ★ 需求 7：跨境地标小窗的选中组（机场 / 码头）。
   * `null` = 没开；`[id]` = 单点；`[idA, idB]` = 聚合点两行。
   * 与 `station` / `tqhStation` **互斥**：三者共用 `.nav-card-overlay`，
   * 同一时刻只应有一张卡（点地标时由 `onXborderPinClick` 顺手清掉另两个）。
   */
  const [xbPinIds, setXbPinIds] = useState<string[] | null>(null);

  /** 底层舞台（带 initialTo 时直接进「半屏可出发」= 与旧版一致） */
  /**
   * ★ v3.6.0（AC-45）：从 `/line/[code]` 返回时**重新打开搜索层**。
   *
   * 只恢复输入内容不够 —— 这里若还是 `map`/`panel`，用户看到的是首页，
   * 得自己再点一次进搜索才看到「26」，那就不是"返回后它还在"。
   * 标记由 `SearchSheet.openLine` 在跳转前写入、**读到即删**（一次性）：
   *   · 刷新页面 / 新开 tab ⇒ 标记不存在 ⇒ 行为不变（不会莫名弹搜索层）；
   *   · 正常从 `/line` 返回 ⇒ 直接进 `search`，`SearchSheet` 再从 `SS_KEY` 读回 `q`/`resp`。
   * ⚠️ 这段必须在 `useState` 的初始化函数里同步读（不能放 effect）—— 否则首帧会先闪一下地图。
   */
  const [stage, setStage] = useState<Stage>(() => {
    if (typeof window !== "undefined") {
      try {
        if (window.sessionStorage.getItem(SS_SEARCH_RETURN) === "1") {
          window.sessionStorage.removeItem(SS_SEARCH_RETURN);
          return "search";
        }
      } catch {
        /* 隐私模式 ⇒ 退化为原行为 */
      }
    }
    return initialTo ? "panel" : "map";
  });
  /** 全屏搜索态正在编辑哪个端点 */
  const [editing, setEditing] = useState<"dest" | "from">("dest");
  /** 重新定位触发计数（右上定位按钮） */
  const [locateTick, setLocateTick] = useState(0);
  /** ★ v3.3.0（AC-93）：`?diag=pin` 钉诊断浮层开关（仅带参为真；客户端读 URL） */
  const [diagPin, setDiagPin] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setDiagPin(new URLSearchParams(window.location.search).get("diag") === "pin");
  }, []);

  /**
   * 路线查看模式（选线路看实时车辆）；`picked` 非空 ⇒ 地图画该线 + 底部主题色标签。
   */
  /**
   * ★ 需求 4：弹窗**在不在 DOM** 的开关。`?board=tqh` ⇒ 首帧即为 `true`。
   *
   * 为什么只改初值、不新增第二套状态：`RouteLinesSheet` 的 `board` 是它自己的
   * `useState(defaultBoard)`（`RouteLinesSheet.tsx:65`）⇒ 只要本开关初始为真，
   * 弹窗首帧就在，且带着下面传下去的 `defaultBoard` 直接落在通琴号板块。
   * 用户之后手动开关弹窗走既有逻辑，不受 URL 影响（有意如此，`board` 不是"我在看哪一屏"）。
   */
  const [lineSheet, setLineSheet] = useState(Boolean(initialBoard));
  const rv = useRouteVehicles();
  const favs = useCombos();

  /* ══ 通琴号（TQH）会话状态 ══════════════════════════════════════════════
     一次只可能"看一班" ⇒ 单个 `tqhTrip` 就够，不需要 tripCode 集合。
       · `tqhStopsOpen` 与 `tqhTrip` 分开：三档弹窗可被拖到 peek（只留头部一行），
         但**班次没变**（地图上的线与高亮必须还在）；
       · `tqhStation` 只装**纯通琴号站**（无关联巴士站）的卡片；关联巴士站走既有
         `station`（`StationCard`）在其下方追加通琴号块 —— 同一物理站位只开一张卡。

     ⚠️ ★ 2026-11-06（修复批 #6 · P0）：**首屏就拉**（`useTqhLines(true)`，见 :296）。
        旧口径是「打开选线弹窗 / 已选班次才拉」（`lineSheet || !!tqhTrip`）——
        后果是**全新打开首页时 `tqh.data.stations` 恒空 ⇒ 地图上一个通琴号站都没有**，
        必须先开一次路线详情再关掉（触发过一次 `lineSheet`）站点才出现，正是负责人报的现象。
        负责人裁决「进首页就加载」：46KB 单飞一次 + 模块级缓存，弹窗 / 搜索 / 站卡 / 站序
        四处共享同一份（切板块 0 请求），代价只落在**首次进入 /nav** 的一次请求。 */
  const [tqhTrip, setTqhTrip] = useState<TqhTrip | null>(null);
  const [tqhPath, setTqhPath] = useState<TqhSegment[] | null>(null);
  const [tqhStopsOpen, setTqhStopsOpen] = useState(false);
  /**
   * ★ 2026-11-06（修复批 #1 / R1）：纯通琴号站卡片现在可以代表**同物理点合并组**
   *   （`same_place_group` 已批 1 组：澳科大南门 ①②，地图只画 1 个标）。
   *   ⇒ 存「本次点中的一整组站」而不是单个站；弹窗内按原站各自成组。
   */
  const [tqhStation, setTqhStation] = useState<{ stations: TqhStation[] } | null>(null);
  const [safeBottom] = useState(() => readSafeBottomPx());
  /**
   * ★ 2026-11-06（修复批 #6 · P0「通琴号站点首页不显示」）：入参恒 `true`。
   *
   * 旧写法 `useTqhLines(lineSheet || !!tqhTrip)` 把「数据是否加载」绑在**交互**上
   * ⇒ 首页从没打开过选线弹窗时 `stations` 为空 ⇒ 地图上没有通琴号站（负责人报的 P0）。
   * 负责人裁决「进首页就加载」⇒ 恒 true；失败重试一次的策略在 hook 内（见 `tqh-lines.ts`）。
   */
  const tqh = useTqhLines(true);
  const tqhReload = tqh.reload;
  /** 通琴号站全量镜像（供稳定回调按 id 反查站对象，不进依赖数组） */
  const tqhStationsRef = useRef<TqhStation[]>([]);
  tqhStationsRef.current = tqh.data.stations;

  /* ── ★ 2026-09-23：单一 RouteSheet 宿主状态 ── */
  const [rsOpen, setRsOpen] = useState(false);
  const [pane, setPane] = useState<"recommend" | "detail">("recommend");
  const [snap, setSnap] = useState<Detent>("full");
  /** ★ 2026-09-25：导航阶段镜像（决定 GPS 节流 15s/30s 与全屏化） */
  const [ridePhase, setRidePhase] = useState<RidePhase>("off");
  const [detailCard, setDetailCard] = useState<{ card: RecommendCard; degraded: boolean } | null>(null);
  /** 面板状态镜像（供稳定回调读取最新值，避免闭包过期） */
  const rsOpenRef = useRef(rsOpen);
  rsOpenRef.current = rsOpen;

  /** 视口尺寸 + 安全区（档位 px 现算） */
  const [winH, setWinH] = useState(0);
  const [safeTop] = useState(() => readSafeTopPx());
  useEffect(() => {
    const onResize = () => setWinH(window.innerHeight);
    onResize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);
  const topsPx = useMemo(() => detentTopsPx(winH || 844, safeTop), [winH, safeTop]);

  /* ── 通琴号派生值（全部 useMemo：地图两层的 effect 依赖它们，引用必须稳）── */
  /** 该班次经过的站 id ⇒ 站点图层「本线白环 / 其余降透明」；null = 不进入高亮态 */
  const tqhActiveIds = useMemo(() => (tqhTrip ? tripStationIds(tqhTrip) : null), [tqhTrip]);
  /** 地图站点：数据到位才传，否则 null（图层空转，不画 0 个点也算一次清理） */
  const tqhMapStations = useMemo(
    () => (tqh.data.stations.length ? tqh.data.stations : null),
    [tqh.data.stations],
  );
  /** 同标号全部班次（换向在客户端就地选，不额外请求） */
  const tqhSiblings = useMemo(
    () => (tqhTrip ? tripsOfRouteNo(tqh.data.trips, tqhTrip.route_no) : []),
    [tqhTrip, tqh.data.trips],
  );
  /**
   * 关联巴士站（有 `bus_station_code`）⇒ 在**既有**站卡下方追加的通琴号分组。
   * ★ 2026-11-06（#2）：改为**按通琴号站逐个成组**（`通琴号-<站名>`），一个主码可能有多个
   *   通琴号站（`M172` → F/G 两个站台；`T429` → 3 个）⇒ 不再合并成一坨。
   */
  const tqhEntriesForStation = useMemo(
    () => (station ? tqhEntriesAtBusStation(tqh.data.trips, tqh.data.stations, station.code) : []),
    [station, tqh.data.trips, tqh.data.stations],
  );
  /** 纯通琴号站卡片的分组（合并组 ⇒ 组内每个站各自成组，R1）—— 站对象已随 `tqhStation` 带齐 */
  const tqhEntriesForTqhStation = useMemo(
    () => (tqhStation ? tqhEntriesAtStations(tqh.data.trips, tqhStation.stations) : []),
    [tqhStation, tqh.data.trips],
  );

  /**
   * 选班次 ⇒ 取该班次逐段几何。
   * ★ 换班次时**先清空**再取：AC-5 明确「不同站序不得复用同一几何」，
   *   保留上一班的线会出现"线还是旧的、点已经变了"的错配帧。
   * ★ 取不到（网络/接口失败）⇒ `null` ⇒ 不画线，但站点高亮与站序列表照常（不阻塞浏览）。
   */
  useEffect(() => {
    if (!tqhTrip) {
      setTqhPath(null);
      return;
    }
    let alive = true;
    setTqhPath(null);
    void loadTqhTripPath(tqhTrip.trip_code).then((p) => {
      if (!alive) return;
      setTqhPath(p.segments.length ? p.segments : null);
    });
    return () => {
      alive = false;
    };
  }, [tqhTrip]);

  /** 面板打开期间隐藏搜索框（200ms 淡出，`prefers-reduced-motion` 瞬切） */
  useEffect(() => {
    if (rsOpen) document.body.setAttribute("data-sheet", "open");
    else document.body.removeAttribute("data-sheet");
    return () => document.body.removeAttribute("data-sheet");
  }, [rsOpen]);

  const onLocate = useCallback((pos: { lng: number; lat: number } | null) => setUserPos(pos), []);

  /**
   * ★ T8：**当前位置的唯一来源**。
   *
   * 优先级 = `fixPos`（持续订阅的浏览器 GPS）→ `userPos`（高德一次性定位）。
   *
   * ⚠️ **顺序不能反过来**（不要写成 `userPos ?? fixPos`）：
   *   `userPos` 是 `onLocate` 的**一次性快照**、**不带时间戳**；`fixPos` 来自
   *   `useUserFix` 的 watcher（`maximumAge: 0`，1.5–10s 持续刷新）。
   *   若让 `userPos` 优先，则"点过一次定位"之后它就**永久压住**后续 GPS 更新 ⇒
   *   起点钉 / `fromPoint` 会钉在一个可能是几分钟前的旧坐标上，且**永不纠正**。
   *   反过来：GPS 被拒/超时 ⇒ `fixPos` 为 null ⇒ 自动回落 `userPos`（高德仍可用）。
   *
   * 两者都是**稳定引用**（各自 useState），`??` 只返回其中之一 ⇒ `myPos` 不产生新对象
   * ⇒ 下游（`RoutePanel` / `originArg`）不会"每帧新对象"抖动。
   */
  const myPos = fixPos ?? userPos;
  const myLocation: NavPoint | null = useMemo(
    () => (myPos ? { kind: "gps", label: MY_LOCATION, lng: myPos.lng, lat: myPos.lat } : null),
    [myPos],
  );
  /**
   * 最新位置的 **ref 镜像** —— 供 `freezeOrigin()` 在「用户点下按钮那一刻」读到最新坐标。
   *
   * ⚠️ 为什么不用依赖数组：`freezeOrigin` 被 `startSession`（useCallback）等闭包捕获，
   *   若靠依赖把 GPS 每帧坐标带进去，会**每次定位都重建 `startSession`**
   *   ⇒ 详情面板整棵子树每秒重渲染。用 ref 既保证"点的瞬间是最新值"，又不产生依赖抖动
   *   （与本文件 `walkActiveRef` / `navActiveRef` 同一套既有模式）。
   */
  const myPosRef = useRef(myPos);
  myPosRef.current = myPos;
  /**
   * ★ P0：`body[data-userpos]` —— **QA 区分「真定位」与「兜底」的唯一手段**。
   *   · `amap`     = 高德定位成功（`userPos` 有值，第一层生效）；
   *   · `fallback` = 高德失败/超时，用浏览器 GPS（`fixPos`）顶上（第二层兜底）；
   *   · `none`     = 两者都没有（此时蓝点也不显示，说"无法定位"才诚实）。
   *   本轮之前这两层在界面上**完全无法区分** —— 所以"定位到底修好没有"没法验收。
   */
  useEffect(() => {
    const state = userPos ? "amap" : fixPos ? "fallback" : "none";
    document.body.setAttribute("data-userpos", state);
  }, [userPos, fixPos]);
  /**
   * ══════════════════════════════════════════════════════════════════════
   * ★ T2：**起点钉 = 本次行程的固定锚点**，不跟着定位走
   * ══════════════════════════════════════════════════════════════════════
   * 病根链路（已核实）：点定位 → `NavMap.runLocate` → `onLocate` → `setUserPos`
   *   → `myLocation` → `fromPoint` → `originArg`【起点钉被挪】；同时 `resultQuery`
   *   跟着变 ⇒ 回推荐 pane 会按新起点**重拉整表**（用户看到的是"我点了个定位，路线全变了"）。
   *
   * 现口径：
   *   · 用户显式选的 `from` ⇒ 直接用（本来就恒定）；
   *   · 只有「用我的位置出发」时，才在 **规划(出发)/开始导航那一刻** 把坐标快照进
   *     `originAnchor` 并固定；此后定位按钮**只**做「视野居中 + 蓝点更新」；
   *   · 关面板 / 重选起终点 ⇒ 锚点释放（下次规划重新快照）。
   */
  const [originAnchor, setOriginAnchor] = useState<NavPoint | null>(null);
  const fromPoint = from ?? originAnchor ?? myLocation;

  /** 冻结起点（幂等；有显式 `from` 时无需锚点） */
  function freezeOrigin() {
    /** ★ T8：读 ref 最新值（不是 `userPos` state）—— 否则 GPS 已成为当前位置时锚点永远不冻结 */
    const p = myPosRef.current;
    if (from || originAnchor || !p) return;
    setOriginAnchor({ kind: "gps", label: MY_LOCATION, lng: p.lng, lat: p.lat });
  }
  /** 释放锚点（关面板 / 重选起终点 / 换 OD） */
  function releaseOrigin() {
    setOriginAnchor(null);
  }
  const canGo = !!fromPoint && !!to;
  /** 推荐/详情共用查询串（与 `/nav` URL 同口径） */
  const resultQuery = fromPoint && to ? queryOf(fromPoint, to) : "";
  const odLabel = fromPoint && to ? `${fromPoint.label} → ${to.label}` : "";

  /** 取景额外纳入的点（起点/终点）—— useMemo 稳定引用 */
  const ovExtra = useMemo(() => {
    const pts: { lng: number; lat: number }[] = [];
    if (fromPoint) pts.push({ lng: fromPoint.lng, lat: fromPoint.lat });
    if (to) pts.push({ lng: to.lng, lat: to.lat });
    return pts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromPoint?.lng, fromPoint?.lat, to?.lng, to?.lat]);

  /**
   * ★ 本批（需求① / 坑：dest/origin 行内字面量 → 取景 effect 每次重渲染重跑）：
   *   把传给 `NavMap` 的 `dest`/`origin` 换成 **useMemo 稳定引用**，
   *   避免每次 NavShell 重渲染都产生新对象、触发下游 OD 标记 effect 抖动。
   */
  const destArg = useMemo(
    () => (to ? { lng: to.lng, lat: to.lat, label: to.label } : null),
    [to],
  );
  /**
   * ★ v3.2.0（需求 5 / AC-76 · P4 裁定）：起点钉以 **`fromPoint`（= `from ?? 我的位置`）** 为准 ——
   *   改前 `from = null`（起点为「我的位置」）时 `originArg = null` ⇒ `NavMap` **从不创建红钉**
   *   （严格复现用户「全程没见过红钉」）。改为 `fromPoint` ⇒ 起点=我的位置时也画红钉（与蓝点组合）。
   *   依赖用 `fromPoint?.lng/lat` ⇒ 坐标不变则不产生新对象，避免下游 OD 标记 effect 抖动。
   */
  const originArg = useMemo(
    () => (fromPoint ? { lng: fromPoint.lng, lat: fromPoint.lat, label: fromPoint.label } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fromPoint?.lng, fromPoint?.lat],
  );

  /** ★ 路线总览数据流（仅 detail pane 打开时启用） */
  const ov = useRouteOverview(
    pane === "detail" ? detailCard?.card ?? null : null,
    rsOpen && pane === "detail",
    ovExtra,
  );

  /** ★ 2026-09-25：导航态（detail pane 打开） */
  const navActive = rsOpen && pane === "detail";
  /** 导航态镜像（供稳定回调读取最新值，避免闭包过期 —— 点击不中断，AC-47/48） */
  const navActiveRef = useRef(navActive);
  navActiveRef.current = navActive;

  /**
   * ★ 2026-11-06（修复批 #1）：**双色巴士标集合**（主码）。
   *
   * 带 `bus_station_code` 的通琴号站不再单独画 marker ⇒ 通琴号信息改挂到巴士站标上：
   * `NavMap` 给命中集合的巴士 marker 染「左蓝右粉」。实测 41 站 → 35 站台码 → **33 主码**
   * （`/api/stations` 按主码去重，`M172/15`+`/16`、`T551/1`+`/2` 各共用一个蓝点）。
   * 数据未到位 ⇒ `null` ⇒ 巴士层保持原样（降级安全）。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * ★ 2026-11-08（负责人裁定）：**导航态一律不染色**
   * ══════════════════════════════════════════════════════════════════════════
   * 导航模式（`navActive`）下通琴号的站点视觉必须**全部消失**。这 33 个双色巴士标
   * 与下面 96 个纯通琴号标是**同一类视觉**（同一条线的两种呈现），只隐一半等于没隐：
   * 屏幕上会留下「左蓝右粉」的巴士点——它们既不是纯巴士站（改过色），
   * 也不是通琴号站（没有独立 marker），是最难解释的第三种东西。
   *
   * ⇒ 导航态返回 `null`（`NavMap` 的契约：`null` = 不染，见 `NavMap.tsx:1397` 的
   *   `!!tqhSharedBusCodes && …`），与 `tqhSegments={navActive ? null : tqhPath}`
   *   （本文件 :2328）**同口径**。退出导航 ⇒ 依赖变化 ⇒ 站点图层重建 ⇒ 双色自动恢复。
   *
   * ⚠️ 本 memo **必须排在 `navActive` 之后**：`navActive` 是 `const`，提前引用会命中 TDZ
   *    （这也是它不再和 `tqhSiblings` 挨着放的原因）。
   */
  const tqhSharedCodes = useMemo<ReadonlySet<string> | null>(
    () =>
      navActive ? null : tqh.data.stations.length ? sharedBusMainCodes(tqh.data.stations) : null,
    [navActive, tqh.data.stations],
  );

  /**
   * ★ 本批（需求② / AC-29~31）：**站点白名单**（主码）。
   *   导航/路线查看模式 ⇒ 本程各腿站点**并集**（`ov.body.strips`，`mainOf` 归一）；
   *   空集保护：`size > 0` 才过滤（否则折成 `null` ⇒ 不过滤）。
   */
  const lineStops = useMemo<ReadonlySet<string> | null>(() => {
    if (!(rsOpen && pane === "detail")) return null;
    const set = new Set<string>();
    for (const strip of ov.body?.strips ?? []) for (const s of strip.stops) set.add(mainOf(s.code));
    return set.size > 0 ? set : null;
  }, [rsOpen, pane, ov.body]);

  /**
   * ★ 2026-11-06（修复批 #3）：**通琴号站点白名单**（与上面 `lineStops` 并列的第二个白名单）。
   * 优先级（顺序即语义，不要重排）：
   *   ① **导航态**（`navActive` = rsOpen && pane==='detail'）⇒ **空集** ⇒ 96 个通琴号标**全部隐藏**；
   *   ② 通琴号班次详情（`tqhTrip`）⇒ 本班站点；
   *   ③ 巴士/轻轨线路详情（`rv.picked`）⇒ **空集** ⇒ 通琴号标全部隐藏
   *      （R2：其余站点「含其它通琴号站、其它巴士站」一律隐藏）；
   *   ④ 其余（浏览）⇒ `null` = 不过滤。
   * ⚠️ 空集必须是**稳定引用**（`EMPTY_ID_SET`）：`TqhStationLayer` 的 `plan` 依赖它，
   *    每次新建 Set 都会重建 96 个 marker。
   * ⚠️ 必须放在 `navActive` 之后：`navActive` 是 `const`，提前引用会命中 TDZ。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * ★ 2026-11-08（负责人裁定）：**导航态传空集 ⇒ 全部隐藏 —— 作废当年的 R2 裁决**
   * ══════════════════════════════════════════════════════════════════════════
   * 背景：优先级 ① 原先写的是 `return null`（= 不过滤），依据 2026-11-06 的 R2
   *   「导航模式现有白名单逻辑不动」。`null` 与「不过滤」在 `TqhStationLayer` 里是
   *   **同一个值**，于是导航态把 96 个通琴号站一个不落地全画了出来 —— 这是当年
   *   **显式裁决**的结果，不是漏写；本次由负责人明确改判为「导航模式下这些图标全部隐藏」，
   *   故 R2 那一条**作废**，改为返回 `EMPTY_ID_SET`。
   *
   * ⇒ 现口径：导航态 / 班次详情 / 巴士轻轨线详情，通琴号标一律**不建 marker**
   *   （`TqhStationLayer` 是数据层过滤，不是 `display:none`）；
   *   只有**浏览态**（`null`）才画全量 96 个。
   *
   * ⚠️ **不要把它改回 `null`**：那会让 96 个通琴号标在导航态重新出现（实测读数），
   *   而导航态本就只该看见本程路线上的站；同批的双色巴士标（`tqhSharedCodes`）
   *   也一起按导航态收掉了，两边必须同进同退，否则屏幕上可能仍留着「左蓝右粉」孤点。
   * ⚠️ 次序仍然重要：① 只把「导航态」从 `null` 换成空集，**没有**改动 ②③④ 的相对顺序，
   *   班次详情与本线详情的既有行为逐字不变。
   */
  const tqhWhitelist = useMemo<ReadonlySet<number> | null>(() => {
    if (navActive) return EMPTY_ID_SET;
    if (tqhTrip) return tripStationIds(tqhTrip);
    if (rv.picked) return EMPTY_ID_SET;
    return null;
  }, [navActive, tqhTrip, rv.picked]);

  /**
   * ★ 2026-11-06（#1 配套 / #3）：**本班次经过、但已被吸进巴士双色标的站**（主码）。
   *
   * 为什么需要：通琴号班次详情里 7 个站可能有 1 个是「关联巴士站」——它的独立 marker
   * 已按 #1 取消（改由巴士双色标代表）⇒ 若不给那个巴士标加白环，用户会觉得"这班少了一站"。
   * `NavMap` 命中该集合的巴士标加 `.nav-map__station--tqh-onroute`（只加环不改色）。
   * 无班次视图 ⇒ `null`（不加环，与改前一致）。
   */
  const tqhActiveBusCodes = useMemo<ReadonlySet<string> | null>(() => {
    if (!tqhTrip) return null;
    const byId = new Map(tqh.data.stations.map((s) => [s.id, s]));
    const set = new Set<string>();
    for (const st of tqhTrip.stops) {
      const s = byId.get(st.station_id);
      const code = String(s?.bus_station_code ?? "").trim();
      if (code) set.add(/^[A-Za-z]+\d+/.exec(code)?.[0] ?? code);
    }
    return set.size ? set : null;
  }, [tqhTrip, tqh.data.stations]);

  /**
   * ★ 2026-11-06（修复批 #6 · P0「通琴号路线模式未隐藏其它站点」）：**巴士站点层的白名单**。
   *
   * ── 病根 ────────────────────────────────────────────────────────────────
   *   上面 `tqhWhitelist` 只控制**通琴号图层** ⇒ 进班次查看模式（`tqhTrip` 非空）时，
   *   通琴号的其它站被过滤掉了，但**巴士站点层完全没有过滤** ⇒ 满屏巴士站还在。
   *
   * ── 现口径（负责人裁决「全部隐藏」）──────────────────────────────────────
   *   · 导航态（`navActive`）⇒ `null` = 不管 —— 巴士层白名单另有其道（`lineStops` /
   *     本线 `routeStops`），R2 已明确「导航模式既有白名单逻辑不动」，本轮不许改；
   *   · 非班次模式 ⇒ `null` = 不管（浏览 / 线路详情的既有行为一字不改）；
   *   · 班次模式 ⇒ **只留本班次关联的巴士主码**（`tqhActiveBusCodes`：本班有站被吸进
   *     双色标的那些。它们必须留下，否则用户会觉得「这班少了一站」）；
   *   · 班次模式 + 本班没有任何关联巴士站 ⇒ `EMPTY_CODE_SET`（**空集**）⇒ 巴士站全隐。
   *   ⇒ 效果：只剩「本班经过的通琴号整圆标 + 关联巴士双色标」，退出即恢复。
   *
   * ⚠️ 空集/单例都必须是**稳定引用**（空集走模块级常量）：`NavMap` 把它放进站点图层的
   *    effect 依赖，每次新建 Set 会把全量巴士 marker 重建一遍。
   */
  const tqhBusWhitelist = useMemo<ReadonlySet<string> | null>(() => {
    if (navActive) return null;
    if (!tqhTrip) return null;
    return tqhActiveBusCodes ?? EMPTY_CODE_SET;
  }, [navActive, tqhTrip, tqhActiveBusCodes]);

  /**
   * ★ v3.2.0（需求 4/7 / AC-74/79）：GPS 通道 —— **`enabled` 扩到「地图页常开」**（浏览/选点/选路线/导航
   *   全程只要有定位就显示蓝点）；采纳间隔按档位：riding **1.5s** / 候车（detail 非 riding）**1.5s**（v3.11 起，
   *   原 3s）/ 浏览 **10s**；`maximumAge: 0` ⇒ 只用新鲜坐标（避免陈旧点导致蓝点/读数跳变）。
   *
   *   ⚠️ **只作用于用户侧 GPS**：与 DSAT 巴士请求没有任何关系（巴士侧 `DSAT_QPS` 冻结不动，风控要求）。
   */
  const gpsIntervalMs = ridePhase === "riding" ? 1_500 : navActive ? 1_500 : 10_000;
  /**
   * ★ I0（2026-11-04）：`coarse` **全程关闭**（原为「候车期开粗定位」，本轮改掉）。
   *
   * ── 为什么必须关（根因，不是口味）──────────────────────────────────────
   *   `coarse = true` ⇒ `enableHighAccuracy: false` + `maximumAge: 30s`
   *   （`useUserFix.ts:187-189`）⇒ 单点 σ ≈ **50m**。
   *   而「用户是否上车」靠**位置变化**判定（相对距离斜率）：σ=50m 时算斜率需要
   *   ~45 秒才有足够信噪比；σ≈10m（高精度）时 5 帧 / 6 秒即可。
   *   ⇒ 候车期用粗定位，正是「正常上车却锁不到车牌」的根因。
   *
   * ── 代价（用户已知并接受）──────────────────────────────────────────────
   *   候车期耗电与发热增加。这是明确接受的交换：判定要准。
   *
   * ── 采样间隔的改动史（读代码前先看这段，别只看到两个变量就动手）──────────
   *   · 上一轮 **只改 `coarse`（精度档），间隔刻意不动** —— 目的是让「耗电变多」这件事
   *     能归因到单一变量（同批动两个变量，事后没人说得清是哪一条造成的）。
   *   · **本轮（v3.11）按负责人裁决把候车期间隔 3s → 1.5s**（`gpsIntervalMs`）。
   *     原因：负责人原话「判定延迟 15~25 秒**不接受**，我希望一上车没多久就匹配成功」。
   *     上车判定看相对距离斜率的**样本帧数**（5 帧）：3s 采样要 12s 才凑够帧数，
   *     1.5s 采样只需 6s ⇒ 这是延迟的主要来源之一。
   *   · 代价：候车期定位回调频率翻倍，耗电/发热**进一步**上升，负责人已知并接受。
   *   · 边界：**只动用户侧 GPS**；巴士侧 `DSAT_QPS` 冻结不动（风控要求，不许跟着加频）。
   *
   * ⚠️ 不要顺手「优化」成 `navActive ? 3_000 : 10_000` 之类的写法 —— 本轮这条**已经按裁决
   *   动过了**（1_500），下次要动它请先读完上面两条代价，并与负责人确认，不要再"顺手调"。
   */
  const userFixR = useUserFix({
    enabled: true,
    intervalMs: gpsIntervalMs,
    maximumAge: 0,
    coarse: false,
  });

  /**
   * ★ T8（P0）：把 `useUserFix` 的坐标镜像进 `fixPos`，让它成为「当前位置」的备用来源。
   *
   * · 位置在 `userFixR` **之后** —— 这是唯一能满足声明顺序（`userFixR` :284 晚于
   *   `myLocation` :189）又不需要挪动任何 hook 的写法；
   * · **去重**：坐标未变则返回原引用 ⇒ 不触发重渲染（GPS 静止时零成本）；
   * · **不覆盖 `userPos`**：高德定位（`onLocate`）仍保留为回落来源；
   *   优先级见 `myPos` 处注释（`fixPos` 优先，因为它带 `maximumAge:0` 持续刷新，
   *   而 `userPos` 是一次性快照、无时间戳）。
   */
  useEffect(() => {
    const f = userFixR.fix;
    if (!f) return;
    setFixPos((cur) => (cur && cur.lng === f.lng && cur.lat === f.lat ? cur : { lng: f.lng, lat: f.lat }));
  }, [userFixR.fix]);

  /**
   * ★ T1：**当前步行段**（null = 不在步行段）。
   *   声明位置**必须早于** `useRideTracking` —— 引擎要拿 `walkActive` 决定**拉车辆帧的间隔**
   *   （步行段放慢到 `POLL_MS × 5`）。
   *
   * ⚠️⚠️ **`walkActive` 不是「自动上车」的互斥门**（2026-11-05 核实，此前多处注释写反了）：
   *   本文件历来的说法是「步行中禁止自动上车 / 真互斥」，但 `tryAuto` 的守卫只有
   *   `phase !== "boarding" || !active` 与 `!leg` —— **从来没有 `walkActive` 早退**。
   *   它真正的两个作用点只有：
   *     ① 本文件渲染层：`track: walkActive ? null : trackView`（步行段不渲染车相关 UI）；
   *     ② `useRideTracking`：`schedule(walkActive ? POLL_MS * 5 : 0)`（放慢拉帧）。
   *   ⇒ 别再把「互斥」当既成事实往下传：**「车到站即切 riding」这类新判据如果不看用户位移，
   *     必须自己带门**（否则「人在去站台路上」会被判成已上车）。这条由该判据的实现方负责。
   */
  const [walkSeg, setWalkSeg] = useState<"out" | "in" | null>(null);
  /** 步行段活跃（**不做上车判定互斥**，只决定「不渲染 track」与「放慢拉车辆帧」；见上方注释） */
  const walkActive = walkSeg !== null;
  /**
   * ★ 步行重算的观测标记（`auto|manual` + 序号）。
   *   声明位置**早于** `endWalk()` / 换段 effect —— 它们都要把标记归零，
   *   否则下一次进入步行段会把上一段的 `manual:N` 原样带出来（观测量失真）。
   */
  const [recalcKind, setRecalcKind] = useState<"auto" | "manual" | "">("");
  const [recalcSeq, setRecalcSeq] = useState(0);
  /** 本段是否已经用过「自动重算」（额度语义：自动 1 + 手动 1，自动不得吃掉手动的份额） */
  const autoRecalcRef = useRef(false);
  /** ★ 2026-09-24：乘车追踪（自动上车 + 安全网 + 轻轨 GPS 推进） */
  const ride = useRideTracking({
    card: pane === "detail" ? detailCard?.card ?? null : null,
    legs: ov.legs,
    anchors: ov.body?.legs ?? null,
    strips: ov.body?.strips ?? null,
    active: navActive,
    /**
     * ⚠️ **不是**「引擎内 `tryAuto` 早退」——`tryAuto` 没有 `walkActive` 判断（2026-11-05 核实）。
     *   本参数唯一作用是让引擎把拉车辆帧的间隔放慢到 `POLL_MS × 5`（`schedule(walkActive ? …)`）。
     *   ⇒ `walkActive` 决定**拉帧节拍**，不决定**能不能自动上车**。
     */
    walkActive,
    userFix: userFixR.fix,
    onRequestGps: userFixR.start,
    /**
     * ★ v3.7.0 S2（AC2.3）：定位轴状态只用于**候车暂停时的文案分档**
     *   （拒权 → 去设置 / 无信号 → 走两步 / 超时 → 再等），不参与任何判定。
     */
    geo: userFixR.geo,
  });

  /** 阶段镜像（GPS 节流用；避免 userFix↔ride 循环依赖） */
  useEffect(() => {
    setRidePhase(ride.phase);
  }, [ride.phase]);

  /* ══════════════════════════════════════════════════════════════════════
     ★ U2（2026-11-04）：**赶车标签的单向锁存**「本次导航是否已经上过车」
     ─────────────────────────────────────────────────────────────────────
     ── 为什么不能用「当前 phase」判（两次历史缺陷各用一个错判据）──────────
       · 缺陷 #1（标签被全删）：`startSession("out")` 在用户按下「开始导航」时
         **同时**做两件事 —— `rideStart()` 进 `boarding` **且** `setWalkSeg("out")`
         （见下方 `startSession`）。⇒「步行去车站」这一路上 `ride.phase` 已经是
         `boarding`、而 `navPhase` 是 `walk`。任何「`boarding` ⇒ 已到站 ⇒ 隐藏标签」
         的写法，都会在用户刚出门时把标签抹掉 —— 而那正是最需要它的时刻。
       · 缺陷 #2（上车后仍在显示）：只按「有没有导航」判，没有「已上车」这个**单向事实**
         ⇒ riding 时、乃至下车后的末段步行（`navPhase` 又回到 `walk`）都还在显示。
     故用**单向锁存**：一旦进入过 `riding` 即置位，此后任何 phase 变化（下车 / 末段步行）
     都无权让它复活。

     ── 三条实现纪律 ──────────────────────────────────────────────────
       ① 自动判定与手动「我已上车」**一视同仁**：两者产物都是 `ride.phase === "riding"`。
          区别对待 = 缺陷 #2 原样复发（手动上车后标签还在）。
       ② 置位写在**渲染期**（单向、幂等），不是为了省一次 effect —— 而是为了
          「进入 riding 的**那一次 commit** 里标签就已不在 DOM」。改成 effect 置位会让
          那一帧仍渲染标签（截图与屏幕阅读器都能抓到）。
       ③ 复位只有「会话边界」与用户显式撤回（见 `resetCatchLatch` 的调用点）。
     ══════════════════════════════════════════════════════════════════════ */
  const hasEnteredRiding = useRef(false);
  /** 复位后强制一次重渲染（计数本身无业务含义；只在复位路径自增） */
  const [, bumpCatchLatch] = useState(0);
  /**
   * ★ 2026-11-05：锁存条件从「进入 riding」收紧为「**人确实在车上**」。
   *
   * 为什么必须改：负责人裁决「车停靠上车站即切 riding」（`be-plate` f009c9a 已实现）之后，
   *   `riding` 的语义变成「**车到了**」，而用户此刻可能还在 50 米外跑。若仍按「进入 riding」
   *   锁存，「小跑能赶上」会在**最需要它的那一刻**消失 —— 这是当初缺陷 #1 的同类问题
   *   （把「车到了」当成「人上车了」）。
   *
   * 判据收在 `riding-real.ts#ridingRealOfRide`（纯函数 + 单测直测）：
   *   · `station` 切入 + 位置证据未到 ⇒ **不锁存**（标签保留）；
   *   · 位置证据到达 / `position` 切入 / 手动「我已上车」⇒ 立即锁存。
   * ⚠️ **同一个判据必须同时用于 `infoMode`**（`NavDetailBody`）—— 只改这里不够：
   *   信息行的 `post` 分支会抢在锁存之前顶掉 `pre`，标签住在 `pre` 里 ⇒ 照样消失。
   *
   * ── 「这班没赶上」兜底（2026-11-05 · 治上面那个滞留缺口）──────────────────
   *   `station` 切入后若位置证据**始终不到**（车来了没挤上），`ridingReal` 恒假 ⇒
   *   标签会一直显示「小跑能赶上」。用物理信号兜：**车已明显驶离上车站** ⇒ 认定没赶上
   *   ⇒ **解除锁存**（标签恢复可用），并**不加任何提示文案**（「没赶上」是新概念，
   *   要不要说属设计侧判断，本批不引入新 UI）。
   *
   *   ⚠️ 两个判据**天然互斥**，不要"优化"成一个：
   *     `ridingReal` = `enteredVia !== "station" || boardedByPosition`
   *     `gaveUp`     = `enteredVia === "station" && !boardedByPosition && 车已走远`
   *     ⇒ `ridingReal && gaveUp` 永远为假，故下面两行的先后顺序不影响结果。
   *   ⚠️ 解除是**安全的**：`station + 无证据` 期间 `ridingReal` 恒假 ⇒ 不会被立刻重新置位，
   *     不存在"解除→立刻锁存→界面闪烁"的循环。车若倒回站附近 ⇒ `gaveUp` 转假 ⇒
   *     锁存保持解除、标签继续显示（正是期望：还有机会）。
   */
  const ridingRealNow = ridingRealOfRide(ride);
  if (ridingRealNow) hasEnteredRiding.current = true;
  if (gaveUpBusOfRide(ride)) hasEnteredRiding.current = false;
  /**
   * 锁存复位（唯一入口）。
   * ⚠️ 复位点必须是**显式**的（事件 / 会话边界），不要在渲染期靠 phase 反推复位 ——
   *   那等于把「当前 phase」重新变成判据，缺陷 #1/#2 会一起复活。
   */
  const resetCatchLatch = useCallback(() => {
    if (!hasEnteredRiding.current) return;
    hasEnteredRiding.current = false;
    bumpCatchLatch((n) => n + 1);
  }, []);

  /**
   * ★ 2026-11-03（需求 1）：**剩余行程服务端重算通道**（顶部总时长 / 到达时刻 / 纵条 同源）。
   *
   * 触发方式 = 「车辆帧到达时随取」+「用户点刷新时随取」，**不做独立轮询**：
   *   · `frameTs` 传 `ride.lastVehicleTs`（每成功一帧车辆数据变一次，`POLL_MS = 12_000`）
   *     ⇒ 天然搭在既有节拍上，零新增定时器；
   *   · 该端点走本地静态索引（亚毫秒、不打 DSAT）⇒ 这个频率成本可忽略。
   *
   * ⚠️ 与 `ov.reload()` 是**两条独立通道**：本通道只 merge 数据、不置 `loading`，
   *   因此不会让 `useRouteOverview` 清 `legs`/`box`（否则地图彩段重画、取景被放弃）。
   */
  const navRemain = useNavRemaining({
    card: pane === "detail" ? detailCard?.card ?? null : null,
    open: rsOpen && pane === "detail",
    phase: ride.phase,
    legIndex: ride.legIndex,
    /**
     * ★ U3：`segRemainSec` 是「到**基准站**的首跳剩余」，且**必须与 `nextIdx` 成对**。
     *   · 停靠态（`ride.stoppedAtStation`）**显式传 0** —— 不用 `segProgress` 缺失推停靠
     *     （那只是"车丢了"，见 `lib/nav/track.ts#segRemainSecOf`）；
     *   · 成对才能算准：服务端/本地的公式都是 `segRemainSec/60 + 基准站之后逐跳`。
     */
    segRemainSec: segRemainSecOf(ride.stoppedAtStation, ride.segProgress?.segRemainSec ?? null),
    /**
     * ★ U3：**基准站**下标，不是「下一站」下标。
     *   停靠态的 `ride.prog.nextIdx` 指向「所停站的**下一站**」，用它起算会整跳漏掉
     *   「所停站 → 下一站」（用户停在 C 站还要 C→D + D→E，系统只算 D→E）。
     */
    nextIdx: remainFromIdxOf(ride.prog),
    frameTs: ride.lastVehicleTs,
  });
  /**
   * 稳定引用（`useNavRemaining` 内 `refresh` 是 `useCallback([])`、身份恒定）。
   * 单独取出来是为了让下面 `reloadRemain` 的依赖数组干净 —— `navRemain` 本体每次渲染都是
   * 新对象，放进依赖会让回调身份每帧变（本项目 `fix` 死循环那条老教训）。
   */
  const navRemainRefresh = navRemain.refresh;
  /** ★ 修复批 #9：车辆帧刷新（步行段 `track` 为 `null` ⇒ `RouteSheet` 调不到它，见 `reloadRemain`） */
  const rideRefresh = ride.onRefresh;

  /* ══════════════════════════════════════════════════════════════════════
     ★ T1 · 一条导航流（步行出发段 → 乘车 → 步行到达段）
     ─────────────────────────────────────────────────────────────────────
     改版前是**两套互不相通的状态机**：`walkSeg`（步行）与 `RidePhase`（乘车），
     且步行**只有入口没有出口**（全仓没有一处 `setWalkSeg(null)`），末段入口还是死代码。
     现在用一个**当前段游标**把它们串起来（不新造 orchestrator 类）：

       `currentLeg` =  walkSeg==="out" ⇒ 步行出发段
                   |  walkSeg==="in"  ⇒ 步行到达段
                   |  ride.phase∈{boarding,riding} ⇒ 乘车段
                   |  其余 ⇒ 无

     推进规则（全自动，用户不再需要点「开始步行」）：
       ① 「开始导航」/「开始步行(首段)」⇒ 冻结起点 + 乘车引擎进 boarding + 进入步行出发段；
       ② 走到上车站（`walkFollow.phase==="arrived"`）⇒ 交出步行段 ⇒ 乘车 UI 恢复
          （`track` 恢复渲染、拉车辆帧回到 12s 档）。**不是**「放开自动上车」——它从未被挡（见下）；
       ③ 最后一程下车（`ride.phase==="done"`）⇒ 自动进入步行到达段；
       ④ 到达目的地 ⇒ 横幅转「已到达」，由「结束导航」收尾。
     **互斥（如实说明）**：`walkActive` **不构成上车判定的互斥门** —— `tryAuto` 的守卫只有
       `phase !== "boarding" || !active` 与 `!leg`，从来没有 `walkActive` 早退（此前注释写反了，
       2026-11-05 核实）。它的真实作用只有「步行段不渲染 track」与「放慢拉车辆帧」两处。
       真正的互斥来自**写入侧清场**：`ride.phase === "riding"` 时本文件有 effect 主动 `endWalk()`，
       把出发段步行收掉（见下方「进入 riding 后必须清掉出发段步行」）。
       ⇒ 「车到站即切 riding」这类不看用户位移的新判据，**必须自己带门**。
     **AC-08a 预算（新口径）**：预取 2 次（首/末各 1）+ 重算 2 次（自动 1 / 手动 1）
       ⇒ 单次导航 `/api/walk-route` 上限 **4** 次（旧注释写 ≤2 已过时）。
     ══════════════════════════════════════════════════════════════════════ */
  /**
   * ★ AC-08a：首段步行的**起点快照**（只在没有显式起点时用，且**只冻结一次**）。
   *   旧实现直接读 `userFixR.fix` ⇒ GPS 每帧变 ⇒ 缓存 key 每帧变 ⇒ **每帧一次**
   *   `/api/walk-route`（"预取 2 次"的上限当场破掉）。改成一次性快照后 key 恒定。
   */
  const [walkStart, setWalkStart] = useState<{ lng: number; lat: number } | null>(null);
  useEffect(() => {
    if (walkStart || fromPoint || !userFixR.fix) return;
    setWalkStart({ lng: userFixR.fix.lng, lat: userFixR.fix.lat });
  }, [walkStart, fromPoint, userFixR.fix]);

  /**
   * 两段步行的 OD：
   *   · `out`（走到上车站）：起点 = 用户起点（`fromPoint`，无则用一次性快照）→ 首段 `board`；
   *   · `in`（下车站走到目的地）：末段 `alight` → 终点 `to`。
   * 只有在 **detail pane 且几何就绪** 时才成立（否则没有站点锚点可去）。
   */
  /**
   * ★ P0（2026-10-31）：**零距离步行不发请求**。
   *
   * ── 现象 ──────────────────────────────────────────────────────────────
   *   末段步行出现 `fromLng=...2669719 / toLng=...266972`（差在小数点后第 12 位，
   *   实际约 **0 米**）⇒ 打上游拿回错误 ⇒ `/api/nav/walk` **500**。
   *   触发场景：下车点与目的地几乎重合（GPS 抖动 / 站点就在目的地门口）。
   *
   * ── 为什么前端也要拦（后端已修，不是重复劳动）────────────────────────
   *   后端已改为「< 1m 返回 200 + 空路线」，但**前端拦掉能省一次往返**：
   *   这条路径每次进详情都会预取，白白消耗一次配额，且 500 时还会闪一下 failed。
   *   阈值与后端**同值 1 米**（刻意不放大：2 米仍会真打上游并返回 1 个 step，
   *   「真走两步」的需求不能被吞）。
   *
   * ── 置 null 之后发生什么（已逐条核对）───────────────────────────────
   *   · `useWalkRoute`：`key === ""` ⇒ 不发请求，该段停在 `idle`（合法的「无需步行」）；
   *   · `hasWalkIn = false` ⇒ 末段推进 effect `if (!hasWalkIn) return` ⇒ **不会进 walk-in 段**；
   *   · 若用户此刻**正处在** walk-in（OD 在导航中变得重合）⇒
   *     `walkSeg === "in" && !hasWalkIn` ⇒ `endWalk()` —— 本来就没得走，这是对的；
   *   · 详情页步行行：`NavDetailBody` 的 T4 去重（`walkIn.toLabel === destLabel`）
   *     本就覆盖这个场景，无需改它。
   */
  const WALK_ZERO_M = 1;

  const walkOds = useMemo(() => {
    const legs = ov.body?.legs ?? [];
    if (!legs.length || !to) return { out: null, in: null };
    const startPt = fromPoint ?? walkStart;
    const firstBoard = legs[0]?.board;
    const lastAlight = legs[legs.length - 1]?.alight;
    /** 起终点重合（< 1m）⇒ 视为「无需步行」，不发请求（见上方注释） */
    const tooClose = (a: { lng: number; lat: number }, b: { lng: number; lat: number }) =>
      distM([a.lng, a.lat], [b.lng, b.lat]) < WALK_ZERO_M;
    return {
      out:
        startPt && firstBoard && !tooClose(startPt, firstBoard)
          ? { from: { lng: startPt.lng, lat: startPt.lat }, to: { lng: firstBoard.lng, lat: firstBoard.lat } }
          : null,
      in:
        lastAlight && to && !tooClose(lastAlight, to)
          ? { from: { lng: lastAlight.lng, lat: lastAlight.lat }, to: { lng: to.lng, lat: to.lat } }
          : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ov.body?.legs, to?.lng, to?.lat, fromPoint?.lng, fromPoint?.lat, walkStart?.lng, walkStart?.lat]);

  /** 预取首/末两段（AC-08a：预取只有这 2 次；重算另有 2 次预算，见文件头） */
  const walkRoute = useWalkRoute(walkOds);
  const hasWalkOut = !!walkOds.out;
  const hasWalkIn = !!walkOds.in;
  const activeWalk = walkSeg === "out" ? walkRoute.out : walkSeg === "in" ? walkRoute.in : null;

  /**
   * ★ P0（2026-10-31）：**`fix` 必须是稳定引用**，否则 `useWalkFollow` 死循环。
   *
   * ── 病根（一句话）────────────────────────────────────────────────────
   *   `useWalkFollow` 里那个"每帧推进"的 effect 依赖 `fix`，而它内部**无条件**
   *   `setProgress(next)`（`progressOnPath` 每次返回新对象）⇒
   *     `fix` 新引用 → effect 跑 → setState 新对象 → 重渲染 → `fix` 又是新引用 → …
   *   这就是 React「Maximum update depth exceeded」的字面含义：
   *   **某个依赖每次渲染都变**。
   *
   * ── 为什么写在这里而不是在 `useWalkFollow` 里塞 ref ─────────────────────
   *   塞 ref 只是把"上游每渲染新建对象"这件事藏起来，别处还会犯。
   *   在这里 `useMemo` + **原始值依赖**，是在**源头**消灭新引用（`??` 不产生新对象，
   *   但 `{ lng, lat, accuracy }` 字面量会）。
   */
  const walkFix = useMemo(
    () =>
      userFixR.fix
        ? { lng: userFixR.fix.lng, lat: userFixR.fix.lat, accuracy: userFixR.fix.accuracy }
        : null,
    // 依赖放**原始值**：`userFixR.fix` 这个对象本身也可能每帧新建
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userFixR.fix?.lng, userFixR.fix?.lat, userFixR.fix?.accuracy],
  );

  /** 跟随状态机（GPS 帧驱动；`following=false` 时为预览/空态，不判定位） */
  const walkFollow = useWalkFollow({
    steps: activeWalk?.steps ?? EMPTY_WALK_STEPS,
    stepsTotalM: activeWalk?.stepsTotalM ?? 0,
    fix: walkFix,
    following: walkSeg !== null && (activeWalk?.phase === "ready"),
  });

  /**
   * `donePath`：用户**真实走过的累积轨迹**。
   * 每帧把当前定位追加到末尾，**偏航重算后不清空、不重置**（设计 §2.3 切分规则）。
   * 与 `now/ahead` 可能几何不同源 —— "灰线与新绿线接续但不完全共线"是正确行为。
   */
  const donePathRef = useRef<[number, number][]>([]);
  const [walkVersion, setWalkVersion] = useState(0);
  const walkStepsKey = `${walkSeg ?? ""}|${activeWalk?.steps.length ?? 0}`;
  useEffect(() => {
    // 换段 ⇒ 轨迹重新累积（同一段内不重置）
    donePathRef.current = [];
    setWalkVersion((v) => v + 1);
    // 重算标记同理：额度按「段」计，换段即归零
    setRecalcKind("");
    setRecalcSeq(0);
    autoRecalcRef.current = false;
  }, [walkStepsKey]);
  /**
   * ★ T3：`donePath` 只在**步行段真正在跟随**时追加。
   *   旧版只要 `walkSeg` 非空就每帧追加（无 phase 门）⇒ 路线还没就绪、或已到达之后，
   *   GPS 仍在往轨迹里塞点，灰线越拖越长且与当前步几何无关。
   */
  useEffect(() => {
    if (!walkSeg || !userFixR.fix) return;
    if (activeWalk?.phase !== "ready") return;
    if (walkFollow.phase === "preview") return;
    const p: [number, number] = [userFixR.fix.lng, userFixR.fix.lat];
    const last = donePathRef.current[donePathRef.current.length - 1];
    // 去抖：与上一点重合（<1 米）就不追加，避免轨迹里塞满重复顶点
    if (last && Math.abs(last[0] - p[0]) < 1e-5 && Math.abs(last[1] - p[1]) < 1e-5) return;
    donePathRef.current = [...donePathRef.current, p];
    setWalkVersion((v) => v + 1);
  }, [userFixR.fix, walkSeg, activeWalk?.phase, walkFollow.phase]);

  /* ══════════════════════════════════════════════════════════════════════
     ★ 修复批 #9 / #10（2026-11-06）：**候车实时通道**的计数与基线
     ─────────────────────────────────────────────────────────────────────
     为什么这几行必须写在 `endWalk` **之前**：收段（到达上车站 / 结束导航）时
     「本段已重算几次」必须归零 —— 与 `data-walk-recalc` 完全同一个道理
     （`data-walk-*` 残留会让断言把"已结束"读成"还在走"，本批新增的属性同理）。
     ══════════════════════════════════════════════════════════════════════ */
  /** 实时赶车档（`tier === null` / `text === ""` ⇒ `NavDetailBody` 回落规划快照） */
  const [catchLive, setCatchLive] = useState<{ tier: CatchTier | null; text: string; seq: number }>(
    CATCH_LIVE_IDLE,
  );
  /** 最近一次重算的触发者（观测钩子 `body[data-catch-why]`：`refresh` / `walk`） */
  const [catchWhy, setCatchWhy] = useState<"refresh" | "walk" | "">("");
  /** 「要求重算」的意图计数（→1 才开始算；换段/退出归零 ⇒ 在途响应自动作废） */
  const [catchIntent, setCatchIntent] = useState(0);
  /** 成功重算计数（渲染必须纯 ⇒ ref 累加，再随结果进 state） */
  const catchSeqRef = useRef(0);
  /**
   * 上一次重算的**基线**（`at` = 发起时刻，`remainM` = 当时的剩余步行米数）。
   * ⚠️ 基线在**发起时**写，而不是「算完时」写：否则请求失败那条路上 `last` 永远不更新，
   *   40m 的判据会**每帧成立** ⇒ 变成每帧一次 DSAT 请求（比轮询更糟）。
   */
  const lastCatchRef = useRef<{ at: number; remainM: number } | null>(null);

  /** 重算状态归零（唯一出口：收段 / 结束会话） */
  const resetCatchLive = useCallback(() => {
    catchSeqRef.current = 0;
    lastCatchRef.current = null;
    setCatchLive(CATCH_LIVE_IDLE);
    setCatchWhy("");
    setCatchIntent(0);
    if (typeof document !== "undefined") {
      document.body.removeAttribute("data-catch-recalc");
      document.body.removeAttribute("data-catch-why");
    }
  }, []);

  /**
   * ★ T1：**收步行段**（真出口用）。
   *   必须一次清干净三件：`walkSeg`（横幅/折线/取景）、`donePathRef`（累积轨迹）、
   *   `body[data-walk-*]`（e2e 观测钩子 —— 残留会让断言把"已结束"读成"还在走"）。
   *   `useWalkFollow` 在 `following=false` 时也会自清，这里是**双保险**。
   */
  const endWalk = useCallback(() => {
    setWalkSeg(null);
    donePathRef.current = [];
    setWalkVersion((v) => v + 1);
    if (typeof document !== "undefined") {
      document.body.removeAttribute("data-walk-step");
      document.body.removeAttribute("data-walk-off");
      document.body.removeAttribute("data-walk-acc");
      document.body.removeAttribute("data-walk-recalc"); // 重算次数是"本段"的，换段/退出必须归零
    }
    setRecalcKind("");
    setRecalcSeq(0);
    autoRecalcRef.current = false;
    /** ★ 修复批 #9/#10：候车实时重算的计数同属「本段」，一起归零（含 DOM 钩子） */
    resetCatchLive();
  }, [resetCatchLive]);

  /* ══════════════════════════════════════════════════════════════════════
     ★ 修复批 #9（2026-11-06）：**候车期实时报站**（未上车时唯一有效的实时通道）
     ─────────────────────────────────────────────────────────────────────
     ── 为什么不能复用 `useNavRemaining`（再强调一次，别合并）───────────────
       服务端 `remaining.ts` 假设「用户已在 `legIndex` 段的车上」
       （`rides[legIndex].waitMin` 视为已发生、不计入剩余，下游循环从 `legIndex+1` 起）
       ⇒ 在 boarding 调用会**漏掉当前段候车（典型 3~9 分钟）**，显示比实际偏短。
       所以 `useNavRemaining` 的 `enabled` 排除 boarding 是**对的**，别改它。
     ── 本通道只回答一件事：我要坐的这班车，现在还有几站 / 约几分到本站 ──────
       数据源 = `/api/station/eta`（站点信息卡在用，`fetchStationLive` 与详情页报站同源）。
     ── 站台码从哪来（方向判定的唯一依据）────────────────────────────────
       `ov.body.strips[0].stops[0].code` —— 服务端 `buildStrips` 用 `segmentsOf()` 解析出的
       **本段实际方向**的首站（`lib/nav/strips.ts:65-68`），形如 `M9/2`；
       两方向站台码不同 ⇒ 与 `items[].platform` 精确比对即可定方向。
       （只按 `route` 匹配会取到隔壁站台/反向车的「还有 3 站」——`useLazyEta.ts` 踩过。）
     ══════════════════════════════════════════════════════════════════════ */
  /** 上车站台码（`null` ⇒ hook 回落 `card.rides[0].board` 主码，方向只能靠唯一命中判） */
  const boardPlatform = ov.body?.strips?.[0]?.stops?.[0]?.code ?? null;
  /**
   * 「还没上车」= 候车/步行去站（`boarding`）或尚未开始（`off`）。
   * ⚠️ 上车后必须关：那时「到本段下车站」由 `post` 行 + `useNavRemaining` 负责，
   *   两条通道同时开着必然互相盖（本项目「两个真相」型缺陷的老配方）。
   */
  const boardEtaEnabled = !hasEnteredRiding.current && ride.phase !== "riding" && ride.phase !== "done";

  const boardingEta = useBoardingEta({
    card: pane === "detail" ? detailCard?.card ?? null : null,
    open: rsOpen && pane === "detail",
    enabled: boardEtaEnabled,
    boardPlatform,
  });
  const boardingEtaRefresh = boardingEta.refresh;
  const boardingEtaFetching = boardingEta.fetching;
  const boardingEtaLive = boardingEta.live;
  const boardingEtaSeq = boardingEtaLive?.seq ?? 0;
  const boardingEtaMin = boardingEtaLive?.etaMin ?? null;

  /**
   * ★ 修复批 #10（2026-11-06）：**剩余步行米数**（从用户实时位置到上车站，沿步行路径）。
   *
   * 三档取值（全部复用既有实现，不新造几何）：
   *   ① 正在跟随出发段 ⇒ `walkFollow.progress.remainM`（与地图三线/横幅同源，带单调 + 死区）；
   *   ② 其余情况（预览 / 已收段 / 尚未开始）⇒ 用**同一个** `progressOnPath` 现投影一次；
   *   ③ 连步行几何都没有（导航未取到 `/api/walk-route`）⇒ `null`（判不出来 ⇒ 不重算，保持快照）。
   *
   * ⚠️ 为什么不用「用户到站台的直线距离」：直线 ≤ 路径 ⇒ 剩余步行时间被**低估** ⇒
   *   档位偏乐观（乘客被告知"慢慢走也能赶上"而实际要跑）。宁可 `null` 走回落。
   * ⚠️ `progressOnPath` 在无定位/低精度时返回**全程米数**（保守侧）—— 正是想要的：
   *   定不到位置就当作"还没开始走"，不会凭空乐观。
   */
  const walkOutSteps = walkRoute.out.steps;
  const walkOutTotalM = walkRoute.out.stepsTotalM;
  const followingOut = walkSeg === "out" && walkFollow.phase === "following";
  const followingRemainM = walkFollow.progress.remainM;
  const followingLowAcc = walkFollow.progress.lowAccuracy;
  const walkRemainM = useMemo(() => {
    if (!walkOutSteps.length || !(walkOutTotalM > 0)) return null;
    if (followingOut && !followingLowAcc) return Math.max(0, followingRemainM);
    return Math.max(0, progressOnPath(walkOutSteps, walkOutTotalM, walkFix, null).remainM);
  }, [walkOutSteps, walkOutTotalM, followingOut, followingLowAcc, followingRemainM, walkFix]);
  /** 供回调/effect 读取最新剩余米数（它们不能把每帧变化的数放进依赖） */
  const walkRemainRef = useRef<number | null>(walkRemainM);
  walkRemainRef.current = walkRemainM;

  /** 重算门（与 `boardEtaEnabled` 同源；`catchGateRef` 供稳定回调读取） */
  const catchGate = boardEtaEnabled && (detailCard?.card.rides[0]?.kind ?? "bus") === "bus";
  const catchGateRef = useRef(catchGate);
  catchGateRef.current = catchGate;

  /**
   * **唯一**的重算入口（点刷新 / R4 位移触发共用）。
   *
   * 做三件事（顺序有意义）：
   *   ① 写基线（`lastCatchRef`）—— 必须在**发起时**写，见 `lastCatchRef` 注释；
   *   ② 意图 +1 —— 让「等报站回来」的那次 effect 知道这次刷新要算；
   *   ③ 触发一次报站请求 —— 重算必须吃**新的**到站分钟，否则等于用旧数据换个说法。
   */
  const triggerCatch = useCallback(
    (why: "refresh" | "walk") => {
      if (!catchGateRef.current) return;
      lastCatchRef.current = { at: Date.now(), remainM: walkRemainRef.current ?? -1 };
      setCatchWhy(why);
      setCatchIntent((n) => n + 1);
      boardingEtaRefresh();
    },
    [boardingEtaRefresh],
  );

  /**
   * 重算执行点（**唯一**）：等报站落地（或确认这次没拿到新值）后再算。
   *
   * 为什么不在 `triggerCatch` 里直接算：`triggerCatch` 里只有**上一轮**的到站分钟，
   * 拿它算出来的档位与刷新前同源 ⇒ 又变成「刷新前后一字未变」（本批要修的就是这个）。
   * `boardingEtaFetching` 在依赖里：请求在飞时不算，落地/flip 之后各算一次。
   *   · 成功 ⇒ `etaSeq` 变 ⇒ 用新到站分钟算；
   *   · 失败 ⇒ `fetching` 变 false、`etaSeq` 不变 ⇒ 用最近一次有效值 + 当前剩余距离算
   *     （「点刷新必算一次」的兜底，档位仍随走得越近而变）。
   */
  useEffect(() => {
    if (catchIntent === 0) return;
    if (boardingEtaFetching) return;
    if (!catchGate) return;
    if (boardingEtaMin == null) return; // 无报站 ⇒ 保持现状（回落规划快照），不硬算
    const remainM = walkRemainRef.current;
    if (remainM == null) return; // 无步行几何 ⇒ 同上
    const r = catchUpLive({
      remainWalkM: remainM,
      walkSpeedMPerMin: WALK_BASE_M_PER_MIN,
      etaMin: boardingEtaMin,
    });
    catchSeqRef.current += 1;
    setCatchLive({ tier: r.tier, text: r.text, seq: catchSeqRef.current });
  }, [catchIntent, boardingEtaSeq, boardingEtaFetching, boardingEtaMin, catchGate]);

  /**
   * R4 自动重算：**位移 ≥ 40m ∧ 距上次 ≥ 20s ∧ accuracy ≤ 30m**（三条阈值见文件头常量）。
   * 依赖里刻意放每帧都会变的 `walkRemainM` / `accuracy` —— 三条守卫都很便宜，
   *   且**真正发起**的那一步（`triggerCatch`）会写基线 + 立刻把 `fetching` 置真
   *   ⇒ 不会在同一段位移里重复触发。
   */
  const fixAccuracy = userFixR.fix?.accuracy ?? null;
  useEffect(() => {
    if (!catchGate) return;
    if (boardingEtaFetching) return; // 在飞 ⇒ 等这一轮（也防重复触发）
    if (walkSeg !== "out") return; // 只有「走向上车站」这段有意义
    if (walkFollow.phase !== "following") return; // 预览态没有可信位移
    const last = lastCatchRef.current;
    if (!last) return; // 基线由「点刷新」建立：没刷过就不自动算（不发无谓请求）
    const remainM = walkRemainM;
    if (remainM == null) return;
    if (fixAccuracy == null || fixAccuracy > CATCH_RECALC_MAX_ACC_M) return; // ③
    if (Date.now() - last.at < CATCH_RECALC_MIN_GAP_MS) return; // ②
    if (Math.abs(last.remainM - remainM) < CATCH_RECALC_MIN_MOVE_M) return; // ①
    triggerCatch("walk");
  }, [
    catchGate,
    boardingEtaFetching,
    walkSeg,
    walkFollow.phase,
    walkRemainM,
    fixAccuracy,
    triggerCatch,
  ]);

  /**
   * 观测钩子 `body[data-catch-recalc="<N>"]` / `body[data-catch-why="refresh|walk"]`。
   *
   * ── 为什么**同名双写** `data-walk-recalc`（兼容层，读完再改）────────────────
   *   验收脚本（`.verify/qa-w22-refresh9.mjs` 等）目前按 `body[data-walk-recalc]` 读「有没有重算」，
   *   本批要修的 #10 就是「刷新前后标签一字未变，`data-walk-recalc` 也没出现」。
   *   但那个属性**已被另一个语义占用**：`/api/walk-route` 的**路径重算额度**
   *   （本文件上方 `data-walk-recalc` 写入点，格式 `auto|manual:N`）。
   *   ⇒ 折中且不破坏原义的做法：
   *     · **原义优先**：属性已是 `auto…` / `manual…` ⇒ 本 effect **不写**（那次路径重算才是它的本义）；
   *     · 其余情况（本段没发生过路径重算）⇒ 写入本批的重算次数，供既有脚本读到值；
   *     · 无论哪种情况，`data-catch-recalc` 都是本批次数的**权威**来源。
   *   ⚠️ 不要改成「无条件覆盖」：那会让「自动/手动各 1 次」的额度断言读到赶车次数。
   */
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (catchLive.seq <= 0) return;
    document.body.setAttribute("data-catch-recalc", String(catchLive.seq));
    if (catchWhy) document.body.setAttribute("data-catch-why", catchWhy);
    const budget = document.body.getAttribute("data-walk-recalc");
    if (!budget || (!budget.startsWith("auto") && !budget.startsWith("manual"))) {
      document.body.setAttribute("data-walk-recalc", String(catchLive.seq));
    }
  }, [catchLive.seq, catchWhy]);

  /**
   * ★ 修复批 #9 / #10（2026-11-06）：**「刷新巴士数据」= 四条通道一起取**（缺一条就是旧缺陷）。
   *
   *   ① `navRemainRefresh()` —— `POST /api/nav/remaining`（全程剩余 / 到达时刻 / 纵条）；
   *      ⚠️ 该通道在 `boarding` **不取数**（服务端算法假设已上车），这是**正确**的，
   *      所以候车期点刷新时它安静地什么也不做 —— 由 ②③④ 补上「这一屏到底刷新了什么」。
   *   ② `rideRefresh()` —— 车辆帧（`/api/route-vehicles`）。
   *      ⚠️ 缺它的时候（**本次 QA 现场**）：步行段给详情面板传的是 `track: null`
   *      （见下方渲染处 `track: walkActive ? null : trackView`），而 `RouteSheet` 的刷新只调
   *      `detail.track?.onRefresh` ⇒ 步行段点刷新**从不拉车辆帧** ⇒ 地图上 0 个 `.vbus-wrap`。
   *      这里显式补一次（内部 5s 冷却门控 + 轻轨段早退，连点在 `cooling` 处被拦，不会双发：
   *      乘车态下 `RouteSheet` 先调 `track.onRefresh` 起冷却，本次调用随即返回 false）。
   *   ③④ 见 `triggerCatch`：候车报站（`/api/station/eta`，本批 #9 的修复点）+ 赶车档重算（#10）。
   *      它自带门（`catchGate`）：已在车上 ⇒ 直接返回，不会多发一个请求。
   *
   * 为什么包一层而不是直接把 `navRemain.refresh` 传下去：`RouteSheet` 的 `reloadRemain`
   *   是**唯一**的点击出口（`RouteSheet.tsx:363`），且它不在本批改动范围 ⇒ 只能在这层合流。
   */
  const reloadRemain = useCallback(() => {
    navRemainRefresh();
    rideRefresh();
    triggerCatch("refresh");
  }, [navRemainRefresh, rideRefresh, triggerCatch]);

  /**
   * ★ 本批（QA 钩子 · 负责人已批准）：**跳过步行段**的自动化入口。
   *
   * ── 为什么需要 ──────────────────────────────────────────────────────────
   *   步行段给 `RouteSheet` 传的是 `track: walkActive ? null : trackView`（见下方渲染处）
   *   ⇒ `NavTrackBar` 不挂载 ⇒ 自动化若要「等 `data-nav-phase=boarding` 出现」，
   *   在步行段内**必然超时**。该现象已定性为**非回归**（版本溯源见 `c93e849` / `0e50f81`）。
   *   本钩子让 e2e 主动收掉步行段，从而真正跑到乘车态去验断言。
   *
   * ── 纪律（四条，缺一不可）──────────────────────────────────────────────
   *   ① **仅非生产**：`process.env.NODE_ENV` 在 Next 构建期被内联 ⇒ 生产包里这段是死代码
   *      （同款先例：`src/lib/security/internal-token.ts:27`、`src/app/api/cron/rebuild/route.ts:64`）；
   *   ② **不整体覆盖 `window.__qa`**：用展开合并，避免踩掉别人挂的键；
   *   ③ **卸载即摘键**：只删自己那一项，其余原样保留；
   *   ④ **不改任何产品行为**：唯一效果是把**已有**的 `endWalk` 暴露出去，注册/注销零副作用。
   *
   * ⚠️ 不要在这里做「模拟到达目的地」之类的副作用 —— 钩子只做跳段，判定一律交给真实引擎。
   */
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as { __qa?: Record<string, unknown> };
    w.__qa = { ...(w.__qa ?? {}), forceWalkArrived: endWalk };
    /**
     * ★ M4（P1 收口 · team-lead 已批准）：`__qa.getEndpoints()` —— **只读**回吐当前起终点。
     *
     * ── 为什么需要 ──────────────────────────────────────────────────────────
     *   「跨境聚合态的两条设施行是否**各用自己**的坐标」这件事，界面上完全看不出来
     *   （两行都点得动、都跳、pageerror=0）。唯一能暴露「两条行共用一份坐标」的办法
     *   就是把真正被设进 `from` / `to` 的 `lng/lat` 读出来做数值比对。
     *   设点后不会立刻发算路请求（还差另一个端点）⇒ 抓网络请求这条路走不通（实测 0 个 POST）。
     *
     * ── 纪律（同 `forceWalkArrived`，四条缺一不可）────────────────────────────
     *   ① 仅非生产；② 展开合并 `window.__qa`；③ 卸载摘键；④ **只读**，零副作用 ——
     *      它只读 state，不 setState、不触发算路、不改任何行为。
     */
    w.__qa = {
      ...(w.__qa ?? {}),
      getEndpoints: () => ({
        from: from ? { lng: from.lng, lat: from.lat, label: from.label } : null,
        to: to ? { lng: to.lng, lat: to.lat, label: to.label } : null,
      }),
    };
    return () => {
      const cur = w.__qa;
      if (!cur) return;
      const next = { ...cur };
      delete next.forceWalkArrived;
      delete next.getEndpoints;
      w.__qa = next;
    };
  }, [endWalk, from, to]);

  /**
   * ★ v3.10.0：**进入 riding 后必须清掉「出发段」步行**（`walkSeg === "out"`）。
   *
   * ── 为什么需要这条（补的是既有结构性漏洞）────────────────────────────────
   *   `startSession` 里有一个**反向 gate**：`if (ridePhaseNow === "riding") return;`
   *   —— 它只防"再次进入步行段"，防不住"已经并存的残留"。
   *   而 `switchToRiding` 只切 `phase`，**不碰 `walkSeg`**（那是本文件的 state）。
   *   ⇒ 一旦上车判定在步行段内成功（v3.10.0 解除硬封后这成为可能；手动点
   *     「手动标记上车」也一样），就会出现「riding + 步行横幅并存」：
   *     横幅让用户"下车走"，而车正在开 —— 正是本文件 `startSession` 注释里记的
   *     "车上又开始步行"老问题，只是入口从"再点开始步行"变成了"自动判定成功"。
   *
   * ── 为什么只清 `"out"` 不清 `"in"` ─────────────────────────────────────
   *   末段步行（`"in"`）是 `ride.phase === "done"` 之后才进入的（见下方 `startSession`
   *   的推进链 / 末段推进 effect），与 riding 不可能并存；无条件清 null 反而会误杀。
   *   ⚠️ 这里刻意不写具体行号：旧的 `:697` 已漂移，行号式引用**每次改动都会失效**。
   *
   * 顺带解决 team-lead 关心的**次生损害**：死锁期间偏航会自动烧掉"本段唯一一次
   * 自动重算额度"（`:663-671`）。本 effect 在判定成功的第一时间就 `endWalk()`
   * ⇒ `autoRecalcRef` 归零 + 偏航横幅卸载 ⇒ 不会再为一段"本不该走的路"烧额度。
   *
   * ⚠️ **时序假设（打包器/HMR 变更时重点复核）**：本 effect 依赖
   *   「`ride.phase` 从 `boarding` 变 `riding` 的那次 commit 之后，`walkSeg` 仍是 `"out"`」
   *   —— 即两个 state 分属不同组件（`useRideTracking` / 本文件），它们的更新会被 React
   *   在**同一次或相邻两次** commit 里刷新。若打包器/HMR 导致顺序变化，本 effect 仍会
   *   在最终状态稳定后的某次 commit 被触发（依赖数组含两者）⇒ 幂等、不会漏。
   *   ⇒ 升级后验证点：车上点「开始导航」，确认切换后**没有**步行横幅残留。
   */
  useEffect(() => {
    if (ride.phase !== "riding") return;
    if (walkSeg !== "out") return;
    endWalk();
  }, [ride.phase, walkSeg, endWalk]);

  /**
   * ★ T1：**开始/推进一条导航会话**（唯一入口语义）。
   *   · `seg="out"` ⇒ 冻结起点 + 乘车引擎进 boarding + 立刻进入步行出发段（顶栏直接出行走指令，
   *     用户不必再点一次「开始步行」）；
   *   · ⚠️ **v3.10.0 起 `tryAuto` 不再因步行段早退** —— 上车判定在步行段内就会跑
   *     （`useRideTracking.tryAuto` 的守卫现在只有 `if (phase !== "boarding" || !active) return;`；
   *      旧的「`walkActive` ⇒ 早退」已被删除，`walkActive` 现在只影响拉车辆帧的间隔
   *      `schedule(walkActive ? POLL_MS * 5 : 0)`）。
   *     ⇒ 进入 riding 后由本文件上方那个 effect **清掉出发段步行**（`walkSeg === "out"`），
   *       避免「riding + 步行横幅并存」。
   *     ⇒ 旧注释「乘车引擎在 `walkActive` 期间不会自动上车」自 v3.10.0 起**与实际相反**，特此改写。
   */
  /** 引擎入口/出口的稳定引用（`ride` 每次渲染都是新对象，直接进依赖会让下面的回调恒变） */
  const rideStart = ride.onStart;
  const rideStop = ride.onStop;
  const ridePhaseNow = ride.phase;
  const startSession = useCallback(
    (seg: "out" | "in" = "out") => {
      /**
       * ★ 反向 gate：**已经在车上就不允许再进步行段**。
       *   否则详情页的「开始步行」能在 riding 中被点开 ⇒ `walkSeg` 与 `riding` 并存，
       *   横幅让用户"下车走"，而车还在开（这正是"车上又开始步行"的老问题）。
       */
      if (ridePhaseNow === "riding") return;
      freezeOrigin(); // ★ T2：起点锚点在此刻固定
      if (seg === "out" && ridePhaseNow === "off") {
        rideStart();
        /**
         * ★ U2 复位点①：**会话开始**（`ride.phase` 恰好从 `off` 起步的那一刻）。
         *   放在与 `rideStart()` 同一个分支里 —— 二者必须同生同灭，否则会出现
         *   「新会话仍带着上一次的锁存 ⇒ 标签永不显示」（锁存是单向的，自己不会消）。
         */
        resetCatchLatch();
      }
      walkRoute.ensure(seg);
      setWalkSeg(seg);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ridePhaseNow, rideStart, resetCatchLatch, walkRoute.ensure, userPos, from, originAnchor],
  );

  /**
   * ★ T1：真出口 —— 结束导航（同时收步行段与乘车引擎）
   * ★ U2 复位点②：**结束导航**（用户点「结束导航」/ 面板关闭走同一条路）。
   *   不复位的话，下一次导航（哪怕是同一条路线重新开始）永远不显示赶车标签。
   */
  const endSession = useCallback(() => {
    endWalk();
    rideStop();
    resetCatchLatch();
  }, [endWalk, rideStop, resetCatchLatch]);

  /* ══════════════════════════════════════════════════════════════════════
     ★ 步行路径「重算」通道（偏航自动 1 次 + 手动 1 次 = 预取 2 + 重算 2 = 上限 4）
     ─────────────────────────────────────────────────────────────────────
     · **额度**：唯一来源 = `useWalkRoute.reloadLeft(seg)`（内部与 `reload` 计数器同源）。
       本地不另起一套计数 —— 两套必然漂移（观测 `data-walk-recalc` 也读这个值）。
     · **防连点**：现成常量 `COOLDOWN_WALK_SEC = 3`（`useCooldown.ts:28` 注释早就写着
       "步行路径重算（偏航/手动）…S5 接入用"，一直没接）。**不要**另写 8 秒之类的数字
       —— 会和偏航阈值混成一个数，以后没人分得清。
     · **自动触发**：偏航确认（连续帧）后自动重算一次；用完转「可重新选择路线」文案，
       连按钮都不渲染（点了发不出请求＝假按钮）。
     ══════════════════════════════════════════════════════════════════════ */
  const walkRecalcCd = useCooldown(COOLDOWN_WALK_SEC);
  const walkRecalcStart = walkRecalcCd.start;
  const walkRecalcCooling = walkRecalcCd.cooling;

  /** 本段剩余重算次数（0 = 额度用尽 ⇒ 走降级文案） */
  const walkReloadLeft = walkSeg ? walkRoute.reloadLeft(walkSeg) : 0;
  const walkReloadOut = walkActive && walkReloadLeft <= 0;

  /** 重算唯一入口（自动/手动共用冷却与额度） */
  const recalcWalk = useCallback(
    (kind: "auto" | "manual"): boolean => {
      if (!walkSeg) return false;
      if (walkRecalcCooling) return false;
      if (walkRoute.reloadLeft(walkSeg) <= 0) return false;
      walkRoute.reload(walkSeg);
      walkRecalcStart();
      setRecalcKind(kind);
      setRecalcSeq((n) => n + 1);
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [walkSeg, walkRecalcCooling, walkRecalcStart, walkRoute.reload, walkRoute.reloadLeft],
  );

  /**
   * 偏航确认 ⇒ **自动重算最多 1 次/段**（额度语义：自动 1 + 手动 1）。
   * ⚠️ 依赖只放**原始值**：`walkFollow` 是每帧新对象，放进依赖会让本 effect 每帧重跑，
   *   冷却一过就再烧一次额度（用户站着不动也能把两次全耗在"自动"上）。
   *   `autoRecalcRef` 是「本段自动次数」的唯一闸，换段/退出时归零。
   */
  const walkOffRoute = walkFollow.offRoute;
  const recoverWalk = walkFollow.recover;
  useEffect(() => {
    if (!walkActive || !walkOffRoute) return;
    if (walkRecalcCooling) return; // 冷却中 ⇒ 等冷却结束再试（**不烧**自动额度）
    if (autoRecalcRef.current) return;
    autoRecalcRef.current = true;
    if (recalcWalk("auto")) recoverWalk(); // 已重算 ⇒ 撤掉偏航态，横幅回转弯指令
  }, [walkActive, walkOffRoute, walkRecalcCooling, recalcWalk, recoverWalk]);

  /** 观测钩子：`body[data-walk-recalc="auto|manual:N"`（N = 已用次数，**与额度同源**） */
  const reloadLeftFn = walkRoute.reloadLeft;
  useEffect(() => {
    if (!walkActive || !recalcKind) return;
    const used = walkSeg ? WALK_RELOAD_MAX - reloadLeftFn(walkSeg) : 0;
    document.body.setAttribute("data-walk-recalc", `${recalcKind}:${used}`);
  }, [walkActive, recalcKind, recalcSeq, walkSeg, reloadLeftFn]);

  /**
   * ① 走到上车站 ⇒ 交出步行段。
   *   目的：把步行的**显示态**与**拉帧节拍**交还给乘车侧（`track` 恢复渲染、12s 轮询恢复）。
   *   ⚠️ **不是**「互斥解除 ⇒ 自动上车恢复」—— `walkActive` 从来不挡自动上车（见上方核实）。
   */
  useEffect(() => {
    if (walkSeg !== "out") return;
    if (walkFollow.phase !== "arrived") return;
    endWalk();
  }, [walkSeg, walkFollow.phase, endWalk]);

  /** ② 最后一程下车 ⇒ 自动进入「步行到达段」（末段入口不再是死代码） */
  const ensureWalkRoute = walkRoute.ensure;
  useEffect(() => {
    if (walkSeg) return;
    if (ride.phase !== "done") return;
    if (!hasWalkIn) return;
    if (walkRoute.in.phase === "failed") return;
    /* 从没请求过（预取被中止等）⇒ 补一次；这是**该 key 的首次请求**，不占重算预算 */
    if (walkRoute.in.phase === "idle") ensureWalkRoute("in");
    setWalkSeg("in");
  }, [walkSeg, ride.phase, hasWalkIn, walkRoute.in.phase, ensureWalkRoute]);

  /**
   * ③ 步行路线取不到（或 OD 不存在）⇒ **必须放弃该步行段**：
   *   否则 `walkActive` 恒 true ⇒ 步行横幅一直挂着、`track` 恒为 `null`（车相关 UI 全不出）
   *   ⇒ 用户既看不到横幅也看不到车（卡在中间态）。
   *   ⚠️ 不是「`tryAuto` 永久早退」造成的死锁 —— `tryAuto` 不含 `walkActive` 判断（见上方核实）。
   */
  useEffect(() => {
    if (walkSeg === "out" && (!hasWalkOut || walkRoute.out.phase === "failed")) endWalk();
    else if (walkSeg === "in" && (!hasWalkIn || walkRoute.in.phase === "failed")) endWalk();
  }, [walkSeg, hasWalkOut, hasWalkIn, walkRoute.out.phase, walkRoute.in.phase, endWalk]);

  /**
   * 会话是否在跑（= 有过一次「开始导航」且还没结束）。
   * 用于：地图上的步行走廊 ghost（整条路线常驻）、以及判断「当前段」。
   */
  const sessionLive = ride.phase !== "off" || walkSeg !== null;
  /** 当前段（观测钩子 `body[data-nav-legkind]` 用；文案/横幅由各段自己渲染） */
  const legKind: "walk-out" | "walk-in" | "ride" | "off" =
    walkSeg === "out"
      ? "walk-out"
      : walkSeg === "in"
        ? "walk-in"
        : ride.phase === "boarding" || ride.phase === "riding"
          ? "ride"
          : "off";
  useEffect(() => {
    if (legKind === "off") document.body.removeAttribute("data-nav-legkind");
    else document.body.setAttribute("data-nav-legkind", legKind);
    return () => document.body.removeAttribute("data-nav-legkind");
  }, [legKind]);

  /** 每段步行的完整几何（地图 ghost + 取景用；`steps` 引用稳定 ⇒ 只在换段/重算时重算） */
  const walkOutPath = useMemo(() => walkRoute.out.steps.flatMap((s) => s.polyline), [walkRoute.out.steps]);
  const walkInPath = useMemo(() => walkRoute.in.steps.flatMap((s) => s.polyline), [walkRoute.in.steps]);

  /**
   * ★ T1（需求 3）：**地图上始终画着完整分段路线**。
   *   · 正在跟随的那段走 `walk` 三线（done/now/ahead，有进度）；
   *   · 另一段走 ghost（没走 = 绿细线 / 已过 = 灰细线；★ v3.8.1 需求 6 实线化）——
   *     旧版末段步行**从未渲染过**（`walkSeg==="in"` 之前没人设，且三线只画当前段）。
   * ★ v3.8.1（需求 6）：**解除 `!sessionLive` 门控** —— 未开始导航（会话未建）时也画
   *   两段步行走廊，用户在看路线详情时就能看到要走哪两段路，而不是一片空白地图。
   *   离开 detail ⇒ 传 `null` ⇒ 0ms 全清；ghost tone 未导航时为 `ahead`（绿，`ride.phase==="off"`）。
   *   ⚠️ AC-08a 预算豁免已批（多画两条静态折线的 JS 开销）。
   */
  const walkGhosts = useMemo(() => {
    if (!rsOpen || pane !== "detail") return null;
    const out: { key: string; path: [number, number][]; tone: "ahead" | "done" }[] = [];
    if (walkOutPath.length >= 2 && walkSeg !== "out") {
      out.push({ key: "out", path: walkOutPath, tone: ride.phase !== "off" ? "done" : "ahead" });
    }
    if (walkInPath.length >= 2 && walkSeg !== "in") {
      out.push({ key: "in", path: walkInPath, tone: "ahead" });
    }
    return out.length ? out : null;
  }, [rsOpen, pane, walkOutPath, walkInPath, walkSeg, ride.phase]);

  /** ★ 2026-09-25：取景指令化（AC-17） */
  const { view, frame, reframeOnSettle } = useNavFrame();
  /** 当前档位镜像（取景指令读取用；避免 snap 进入 effect 依赖） */
  const snapRef = useRef<Detent>(snap);
  snapRef.current = snap;

  /**
   * ★ T1：取景外包框 = 乘车段几何 ∪ **两段步行几何** ∪ 起终点。
   *   为什么要把步行并进来：改版前 `ov.box` 只包含乘车彩段 + 起终点，
   *   而末段步行的终点可能落在框外（下车站在框角落时），用户看不到"还要走多远"。
   *   仍一律**自算 fit-box**（禁 `setBounds`/`setFitView`）。
   */
  const frameBox = useMemo(() => {
    const base = pane === "detail" ? ov.box ?? (ovExtra.length >= 2 ? unionBox([], ovExtra) : null) : null;
    if (!base) return null;
    if (!sessionLive) return base;
    const extraPaths = [walkOutPath, walkInPath].filter((p) => p.length >= 2);
    if (!extraPaths.length) return base;
    return unionBox([...ov.legs.map((l) => l.colored), ...extraPaths], ovExtra) ?? base;
  }, [pane, ov.box, ov.legs, ovExtra, sessionLive, walkOutPath, walkInPath]);

  /**
   * 取景意图：仅在 **显式状态变化**（打开面板 / 切 pane / 换 OD / 换舞台）时下令。
   * ⚠️ **不依赖 `snap`** ⇒ 拖面板 / 换档不重取景（AC-17）；落定后仅被遮挡时经
   *    `reframeOnSettle` 微调一次。
   */
  useEffect(() => {
    const slot = topsPx[Math.min(topsPx.length - 1, Math.max(0, detentIndex(snapRef.current)))];
    if (rsOpen) {
      const box =
        pane === "detail"
          ? frameBox
          : ovExtra.length >= 2
            ? unionBox([], ovExtra)
            : null;
      /**
       * ★ v3.6.0 S5：步行跟随时**顶部有横幅、底部有面板 ⇒ 两侧都占**，
       *   必须用新的 `insetTopPx` / `insetBottomPx`（中带算法）；
       *   非步行态**不传这两个新参** ⇒ 走旧路径，取景行为一字不改。
       */
      if (box) {
        if (walkActive) {
          frame({
            mode: "fit-box",
            box,
            slotTopPx: slot,
            insetTopPx: safeTop + WALKTURN_H,
            insetBottomPx: slot,
          });
        } else {
          frame({ mode: "fit-box", box, slotTopPx: slot });
        }
      } else frame({ mode: "none" });
      return;
    }
    if (stage === "panel") frame({ mode: from ? "fit-two" : to ? "dest-center-top" : "none" });
    else frame({ mode: "none" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rsOpen, pane, frameBox, ovExtra, stage, from, to, walkActive, safeTop]);

  /**
   * ★ v3.2.0（Spec §2/§3 · AC-84）：`body[data-nav-phase]` **五值**（页面级导航阶段钩子）——
   *   `off` / `recommend` / `detail` / **`walk`（★ v3.6.0 S5 新增第四态）** / `riding`。
   *   ⚠️ 与 `.nav-actions[data-nav-phase]`（NavTrackBar，值为**乘车 phase**）语义不同，勿混用；
   *      旧布尔 `body[data-nav="riding"]` **废弃**（底导隐藏规则已改选择器，见 globals.css）。
   *   ⚠️ `walk` 与 `riding` **互斥**：步行跟随优先（用户已显式进入），且两者入口互相隐藏。
   */
  const navPhase: "off" | "recommend" | "detail" | "walk" | "riding" = !rsOpen
    ? "off"
    : pane === "recommend"
      ? "recommend"
      : /**
         * ★ `walk` 必须让位给 `riding`（`walkActive && ride.phase !== "riding"`）：
         *   写入侧**没有**「互斥门」（`walkActive` 不参与 `tryAuto`，见上方核实），只有
         *   「进入 riding 后 `endWalk()`」的清场 effect —— 而**自动上车是异步触发**，
         *   必然存在「riding 已开始、`walkSeg` 尚未清」的帧窗口。
         *   那一帧若判 `walk`，整页会按步行态渲染（底导隐藏、横幅压住），表现就是
         *   「车都开了还让我走去车站」。⇒ 这道**显示层**门是清场 effect 替代不了的。
         * ⚠️ `walk` 这个**取值本身必须保留**（`globals.css` 的
         *   `body[data-nav-phase="walk"] .bottom-nav` 与 e2e 都依赖它）。
         */
        walkActive && ride.phase !== "riding"
        ? "walk"
        : ride.phase === "riding"
          ? "riding"
          : "detail";
  useEffect(() => {
    document.body.setAttribute("data-nav-phase", navPhase);
    return () => document.body.removeAttribute("data-nav-phase");
  }, [navPhase]);

  /**
   * ★ v3.2.0（需求 4 / AC-74）：**打开地图页即申请一次定位**（触发权限弹窗）。
   *   拒权 / 失败 ⇒ `denied` 置位但不抛错：页面**不空白**、默认视野与搜索照常、仅不显示蓝点（AC-75）。
   *   `startFix` 经 `useCallback([doWatch])` 恒稳定 ⇒ 该 effect 只在 mount 跑一次。
   */
  const startFix = userFixR.start;
  useEffect(() => {
    startFix();
  }, [startFix]);

  /**
   * ★ v3.2.0（需求 8 / AC-81）：页面级下车横幅的下车站名（与面板内 `NavAlarmOverlay` 同口径：
   *   本腿纵条末站 → 该腿 `alightLabel` → 首腿 `alightLabel`）。
   */
  const alarmLabel = useMemo(() => {
    const card = detailCard?.card;
    if (!card) return "";
    const li = ride.legIndex ?? 0;
    const stops = ov.body?.strips?.[li]?.stops ?? [];
    return (
      (stops.length ? stops[stops.length - 1].label : "") ||
      card.rides[li]?.alightLabel ||
      card.rides[0]?.alightLabel ||
      ""
    );
  }, [detailCard?.card, ride.legIndex, ov.body]);

  /* ── 舞台操作 ── */
  function openSearch(which: "dest" | "from") {
    setEditing(which);
    setStage("search");
  }
  function backFromSearch() {
    setStage(to ? "panel" : "map");
  }
  /**
   * ★ T7（本轮 P0 修复）：**这里不许释放起点锚点**。
   *
   * 旧实现无条件 `releaseOrigin()`，于是「只改目的地」（`which === "dest"`）也会把
   * 起点锚点清掉 ⇒ 下一帧 GPS 更新后 `fromPoint = from ?? originAnchor ?? myLocation`
   * 直接落到 `myLocation` ⇒ **起点钉跟着定位跑**（T2 修掉的那个 bug 从后门复活）。
   *
   * 现口径：
   *   · `which === "from"` ⇒ `from` 被设成**具体点**（非 GPS），`from` 优先级最高，
   *     锚点天然被遮蔽，**不需要**释放（留着也不会被读到）；
   *   · `which === "dest"` ⇒ 起点根本没变，更不该释放。
   *   · 「退回可出发态」的释放**只有 `contextClose` 的 else 分支**这一个定义点。
   */
  function pickPoint(p: NavPoint, which: "dest" | "from") {
    if (which === "dest") setTo(p);
    else setFrom(p);
    setStage("panel");
  }

  const router = useRouter();
  /**
   * ★ v3.6.1：「查看全部站点」→ `/line/[code]` 深链页（品牌栏线路标签旁的小键）。
   *
   * · 只在「从搜索进入线路视图」时打 `SS_RETURN` 一次性标记：返回首页时 `stage` 的初始化
   *   函数会重开搜索层，搜索词与结果一起回来（该标记读到即删，刷新/新开 tab 不受影响）；
   * · 从「公共交通路线」弹窗选的线路**不打标**（返回时不该莫名弹出搜索层）；
   * · 用 SPA 跳转（`router.push`，与 `SearchSheet` 深链兜底同一写法），不 hard reload。
   */
  function openAllStops(code: string) {
    try {
      if (stage === "search") window.sessionStorage.setItem(SS_SEARCH_RETURN, "1");
    } catch {
      /* 隐私模式 ⇒ 只是不自动重开搜索层，不影响跳转 */
    }
    router.push(`/line/${encodeURIComponent(code)}`);
  }

  /** ★ 出发 → 打开推荐面板（full 档；不整页跳转） */
  function go() {
    if (!fromPoint || !to) return;
    freezeOrigin(); // ★ T2：规划那一刻冻结起点（此后点定位不再改起点钉 / resultQuery）
    setDetailCard(null);
    setPane("recommend");
    setSnap("full");
    setRsOpen(true);
  }

  /** ★ 点卡片：**当帧**切 detail pane + 降档动画（不等待接口，先骨架） */
  function openDetail(card: RecommendCard, degraded: boolean) {
    freezeOrigin(); // ★ T2：进导航同样冻结（从推荐列表点卡片也算"开始这次行程"）
    /**
     * ★ T1：换方案 ⇒ 旧的步行段几何作废，必须先收（含「换乘站台切过去」这条路径）。
     *   不收的话旧步行段会带进新卡：横幅还挂着上一条路线的走向、`track` 恒 `null`
     *   （车相关 UI 全不出），且拉帧节拍停在步行档（60s）。
     *   ⚠️ 不是「自动上车被判互斥永久挡住」—— `walkActive` 不参与 `tryAuto`（见上方核实）。
     */
    endWalk();
    /**
     * ★ U2 复位点③：**换一条路线 / 换方案**（点另一张卡、或在详情里「切过去」）。
     *   这是**另一趟行程**：上一趟的「已上车」是过去时，对本趟没有意义。
     *   不复位 ⇒ 点第二张卡时标签仍然隐身（用户会以为"这条路线没有赶车提示"）。
     */
    resetCatchLatch();
    setDetailCard({ card, degraded });
    setPane("detail");
    setSnap("half");
  }

  /** ★ contextual 关闭：推荐→关面板（回可出发态）；详情→回推荐列表 */
  function contextClose() {
    if (pane === "detail") {
      /**
       * ★ T1/T5：**离开详情 = 结束本次导航会话**，步行必须一起收干净。
       *   旧版只切 pane：`walkSeg` 谁也不清（全仓没有一处 `setWalkSeg(null)`）⇒
       *   横幅、折线、`data-walk-*` 全留在界面上，底栏还照给「开始导航」
       *   （因为 `walkActive && phase==="ready"` 根本不看面板开合）。
       *   乘车侧本来就是这样：`navActive` 变 false ⇒ `useRideTracking` 自 reset。
       *
       * ★ U2 复位点④：**离开详情（会话结束）** —— 与上一行的"乘车引擎自 reset"对齐：
       *   引擎都归 zero 了，锁存若不复位就会比引擎活得更久 ⇒ 下次导航标签永不出现。
       */
      endWalk();
      resetCatchLatch();
      setPane("recommend");
      setSnap("full");
    } else {
      releaseOrigin(); // ★ T2：回到可出发态 ⇒ 释放起点锚点
      setRsOpen(false);
      setStage(to ? "panel" : "map");
    }
  }

  /** ★ 面板换档落定：更新档位；仅「被遮挡」时微调取景一次（AC-17） */
  function onDetent(d: Detent) {
    setSnap(d);
    reframeOnSettle(topsPx[Math.min(topsPx.length - 1, Math.max(0, detentIndex(d)))]);
  }

  /**
   * 点地图上的站/车 → 打开卡片。
   * ★ 本批（需求⑥ / AC-47/48）：**导航态点击不中断** —— 导航中（`navActive`）只开卡片浮层，
   *   **不清空面板**；非导航态保持原行为（同 Google Maps，卡片 z90 > 面板 z70）。
   */
  const onStationClick = useCallback((s: StationCardStation) => {
    setTqhStation(null); // 两个浮层互斥：同屏两张卡会互相遮挡
    setStation(s);
    if (rsOpenRef.current && !navActiveRef.current) {
      setRsOpen(false);
      setStage("map");
    }
  }, []);

  /**
   * ★ 2026-11-05（通琴号 R4）：点地图上的通琴号站点。
   *
   * ★ 2026-11-06（#1 / R1）口径变更：
   *   · 带 `bus_station_code` 的 41 个通琴号站**已经没有自己的 marker** ——
   *     它们由巴士层的**双色标**代表，点那个标走的是 `onStationClick`（巴士卡 + 底部通琴号分组）。
   *   · 本回调现在只服务**纯通琴号站**（97 个，合并组后 96 个标），可能是
   *     `same_place_group` 合并组（`ids.length > 1`，当前只有澳科大南门 ①②）
   *     ⇒ 卡片里按原站各自成组。
   * 两条路径都**不进入导航/路线态**，只关掉公交路线弹窗（否则卡片被 z70 面板压住）。
   */
  const onTqhStationClick = useCallback((s: TqhStation, ids: number[]) => {
    const all = tqhStationsRef.current;
    const list = ids
      .map((id) => all.find((x) => x.id === id))
      .filter((x): x is TqhStation => !!x);
    setStation(null);
    setTqhStation({ stations: list.length ? list : [s] });
    if (rsOpenRef.current && !navActiveRef.current) {
      setRsOpen(false);
      setStage("map");
    }
  }, []);

  /**
   * ★ 2026-11-05（通琴号 R3）：选一张班次卡。
   * 顺序即验收口径（AC-5）：**关弹窗 → 地图出线**。同时退出「巴士线路查看模式」，
   * 两套路径同屏会被读成"这班车也走那条巴士线"。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * ★ 2026-11-06（修复批 #6c · 互斥 bug）：**导航进行中禁止跳班次视图**
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ── 病根（已核实可达，不是理论问题）──────────────────────────────────────
   *   下面这个守卫此前**只有** `onPickLineFromCard` 有，`pickTqhTrip` 没有 ——
   *   而两者出现在**同一张站点卡**上（`StationCard` 的线路行 / 底部的通琴号分组）
   *   ⇒ 用户体验是「导航中点『巴士 26』没反应（有意设计），点『通琴号 A1』直接跳走」。
   *   不报错、不崩，只是**同一张卡片里一行禁用、另一行不禁用** ——
   *   这正是「沉默逻辑错误」的教科书形态：行为不一致，且没有任何视觉暗示。
   *
   * ── 为什么这条路真的走得通（三条入口逐一验过）──────────────────────────
   *   · 品牌栏「查看路线」→ 选线弹窗：`NavBrandBar` 在 `navMode` 时整块不渲染 ⇒ 不可达；
   *   · 顶部搜索条 → 通琴号板块：面板打开时 `body[data-sheet="open"] .nav-searchbar`
   *     是 `pointer-events:none` ⇒ 不可达；
   *   · **地图站点标 → 卡片 → 班次行：可达**。站点卡挂在 `.nav-card-overlay`（z90），
   *     高于导航面板 `RouteSheet`（z70）⇒ 导航中点半屏地图带上的站点标，卡片照常弹出；
   *     而导航态下 `onStationClick` / `onTqhStationClick` 的守卫是
   *     「`rsOpen && !navActive` 才关面板」⇒ 导航态**故意保持面板**，卡片与面板同屏。
   *   ⇒ 且这条路**极易误触**：导航态 `tqhWhitelist` 返回 `null`（R2 裁决）⇒
   *     地图上本来就画着全部通琴号标，随手点一个就进卡片。
   *
   * ── 选中后本来会发生什么（四件事，两处与 #2 相反）──────────────────────
   *   ① 通琴号层反转成「全画」：`tqhWhitelist` 的 `navActive` 分支先命中 ⇒ 96 个标全留、
   *      只有非本班站降透明（#2 要的是「只剩本班站」）；
   *   ② `TqhPathLayer`（z73）把班次线画在导航彩段（z72）**之上** ⇒ 屏幕上两条线，
   *      用户会以为那是他正在坐的车；
   *   ③ `LineStopsSheet`（z76）整屏盖住导航面板（z70）⇒ 「还要几站 / 下车提醒」全被埋掉；
   *   ④ 巴士层不受影响（`tqhBusWhitelist` 的 `navActive` 分支也返回 `null`）。
   *
   * ── 现口径 ──────────────────────────────────────────────────────────────
   *   与 `onPickLineFromCard` **逐字同形**：同一个裁决（导航中禁止跳另一套线路视图）
   *   就该用同一个守卫，审查时一眼可比。
   *   ⚠️ **只加守卫不够** —— 视觉禁用（`pickTripDisabled`）必须一起给，否则问题从
   *     「跳走」变成「点了没反应」，只是换了个形态（同样是沉默逻辑错误）。
   *     禁用位由 `StationCard` / `TqhStationCard` 的 `pickTripDisabled` 承载。
   */
  const pickTqhTrip = useCallback(
    (t: TqhTrip) => {
      if (navActiveRef.current) return;
      setLineSheet(false);
      setStation(null);
      setTqhStation(null);
      rv.exitLine();
      setTqhTrip(t);
      setTqhStopsOpen(true);
    },
    [rv],
  );

  /** 关闭站序弹窗 = 退出该班次的线路视图（清地图路径 + 站点高亮） */
  const closeTqhStops = useCallback(() => {
    setTqhStopsOpen(false);
    setTqhTrip(null);
  }, []);

  /**
   * ★ 2026-11-06（修复批 #4 / R3）：**站点卡里的线路行 → 进该线路的查看模式**。
   *
   * 只做「触发与传参」，弹窗本体由前端 C 的 `RouteStopsSheet` 提供：
   * 打开它所需的唯一状态就是 `rv.picked`（`{code, kind, label, color, dir}`），
   * 所以这里**不新增宿主 state** —— C 的组件用 `open={!!rv.picked}` + `line={rv.picked}` 即可。
   *
   * 三条纪律：
   *   ① **导航进行中禁止跳走**（与「导航态点击不中断」一致）；`StationCard` 侧同时给视觉禁用态，
   *      这里再兜一道，保证「点击无跳转、无报错」；
   *   ② 与通琴号班次视图互斥（两套路径同屏会被读成"这班车也走那条巴士线"）；
   *   ③ `label` 走 `lineNameOf()`：巴士 `26`（无「路」）/ 轻轨 `氹仔線`（官方繁体专名，R7）。
   */
  const onPickLineFromCard = useCallback(
    (code: string, kind: "bus" | "lrt") => {
      if (navActiveRef.current) return;
      setStation(null);
      setTqhStation(null);
      setLineSheet(false);
      setTqhStopsOpen(false);
      setTqhTrip(null);
      rv.pickLine({ code, kind, label: lineNameOf(code), color: colors[code] ?? "" });
    },
    [rv, colors],
  );

  const onMapClick = useCallback(() => {
    setStation(null);
    setTqhStation(null);
    /* ★ 需求 7：点地图空白处也收起地标卡（与另两张卡同一口径） */
    setXbPinIds(null);
    /* ★ M4（需求 6）：点地图空白处关图层面板。
       ⚠️ 刻意**不 return、不 stopPropagation** —— 上面三条清卡行为必须照常执行；
       面板只是个浮层，关它不该改变"点地图 = 收起所有卡片"的既有语义。 */
    setToilet(null);
    setLayerSheet(false);
  }, []);

  /** 车辆点击：打开车辆卡 + 收起面板（导航态不清面板） */
  const onVehicleClick = useCallback(
    (v: Parameters<typeof rv.selectVehicle>[0], count: number) => {
      rv.selectVehicle(v, count);
      if (rsOpenRef.current && !navActiveRef.current) {
        setRsOpen(false);
        setStage("map");
      }
    },
    [rv],
  );

  /** 常用 = **收藏组合**（排除已停用），按最近使用取前 3 */
  const quickPairs: QuickPair[] = favs.mounted
    ? [...favs.combos]
        .filter((c) => !c.disabled)
        .sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt))
        .slice(0, 3)
        .map((c) => ({ id: c.id, from: c.from, to: c.to }))
    : [];

  /** detail pane 打开时，总览取代「路线查看线」与其车辆 */
  const detailActive = rsOpen && pane === "detail";

  /**
   * ★ T1：**会话级追踪视图** —— 唯一改动是把 `onStart/onStop` 换成整条导航流的入口/出口：
   *   · `onStart`（吸底「开始导航」）⇒ `startSession("out")`：冻结起点 + 乘车进 boarding
   *     + 直接进入步行出发段（顶栏立刻出行走指令，用户不必再点「开始步行」）；
   *   · `onStop`（「结束导航」）⇒ `endSession()`：步行段 + 乘车引擎 + 观测钩子一起收。
   * 其余字段原样透传（面板/纵条/卡片都按原契约读）。
   *
   * ★ U2 复位点⑤：**用户点「我没上车」** —— 这是锁存的**唯一用户侧复位入口**（设计 §3.2）。
   *   语义 = 「我刚才那次上车判定作废」⇒ 标签必须按候车态重新出现。
   *   ⚠️ 必须在**同一个 handler 里**先复位再调引擎的 `onNotBoard`：引擎会 `setPhase("boarding")`
   *   并清 `boardMatch`，两者同帧生效才不会出现"回等车了但标签还是不显示"。
   */
  const trackView: RideTrackView = useMemo(
    () => ({
      ...ride,
      onStart: () => startSession("out"),
      onStop: endSession,
      onNotBoard: () => {
        resetCatchLatch();
        ride.onNotBoard();
      },
    }),
    [ride, startSession, endSession, resetCatchLatch],
  );

  /**
   * ★ T6：**导航态车辆卡的元信息**。
   *   根因：导航态 `rv`（`useRouteVehicles`）**从未 fetch** ⇒ `rv.fetchedAt` 恒 null、
   *   `rv.picked` 恒 null ⇒ 点车辆后卡片没有线路标签、数据时间显示「—」。
   *   这里改用**当前 ride 段**的线路码 / 线色 / 最近一次车辆帧时刻。
   *   ⚠️ 不动 `/api/route-vehicles` 契约（`useRideTracking` 侧只把站名与末班补对）。
   */
  const navVehMeta = useMemo(() => {
    if (!detailActive) return null;
    const leg = detailCard?.card.rides[ride.legIndex] ?? null;
    if (!leg) return null;
    return {
      /**
       * ★ 修复批 #7（R5/R7）：**线路标签只显示线号** —— 去掉「路」后缀。
       * 统一走 `lineNameOf()`：巴士 `26` / `25B`（无「路」）、轻轨 `氹仔線`（官方繁体专名）。
       * ⚠️ R5 的靶子是「`26 路` 这种码 + 量词后缀」；`氹仔線` 是不可拆的官方专名 ⇒ 合规。
       *   （本行原来轻轨分支是 `轻轨 氹仔线`：多了中文前缀 + 简体「线」，与 `RouteStack`
       *     的 `氹仔線` 两种写法并存 —— 一并按 R7 收敛成 `lineNameOf`。）
       */
      label: lineNameOf(leg.route),
      color: colors[leg.route],
      // ★ v3.7.0 S2（D5）：车辆卡上的「数据时间」只能取**车辆帧**时刻
      fetchedAt: ride.lastVehicleTs > 0 ? new Date(ride.lastVehicleTs).toISOString() : null,
    };
  }, [detailActive, detailCard, ride.legIndex, ride.lastVehicleTs, colors]);

  /* ══ ★ 2026-11-06（修复批 #4 / #5a）：线路站序弹窗的**宿主取数** ══════════
     `RouteStopsSheet`（前端 C）是**纯受控无请求**组件：它只吃 `stops / 线号 / 方向 / 档位`。
     ⇒ 站序由本文件取（`GET /api/route-stops?code&dir`，静态数据 `s-maxage=3600`）。

     三条口径：
       ① `rv.picked.dir` 由 `NavMap` 读 `/api/route-shapes` 后回报，**首帧可能为空** ⇒
          先按「无 dir」取（服务端选第一方向），dir 到位后自动重取一次（换了方向必须重取，
          **禁止 `stops.reverse()`** —— 两方向站数与站台码都不同）；
       ② 失败就空列表（弹窗只剩顶部行），不给假数据；
       ③ 与导航面板 / 选线弹窗**互斥**（见下方挂载点的 `open` 条件）。

     ★ 为什么用「快照 + open 开关」而不是条件渲染（前端 C 的明确要求）：
       `useSnapSheet` 关闭态把 `translateY` 推到 `100dvh`（`useSnapSheet.ts:354`）+
       `globals.css:9651` 的 `transform` 过渡 ⇒ **元素留在 DOM 才有收起动画**；
       卸载 = 硬闪一下消失。安全性也已核过：关闭态整体移出视口 + `inert`
       ⇒ 不占命中区、不可聚焦，不会与导航面板抢点击。
     ⚠️ 因此快照**关闭时不清空**（要留最后一帧给动画），换线时才整体替换。 */
  const [stopsSheet, setStopsSheet] = useState<{
    kind: "bus" | "lrt";
    code: string;
    color: string | null;
    directionLabel: string;
    stops: RouteStopsOk["stops"];
  } | null>(null);
  const [stopsDetent, setStopsDetent] = useState<Detent>("half");
  /* ★ M4：图层偏好的**唯一真相**（地图图层与图层面板都读它；面板内部另有一份订阅实例，
     二者通过 `must:layers` 事件同步 ⇒ 拨开关后地图立刻跟） */
  const layers = useLayerPrefs();
  /** ★ M4：图层面板开关（挂在 `.nav-map-wrap` 之外，见 JSX 注释） */
  const [layerSheet, setLayerSheet] = useState(false);
  /** ★ M4：当前打开的公厕卡（null = 未打开） */
  const [toilet, setToilet] = useState<PublicToilet | null>(null);
  /**
   * ★ M4（缺陷修复）：站点/公厕图层的缩放门状态（由 `NavMap` 回写）。
   * 默认 `ok: true` ⇒ 首帧不闪提示；拿到真实 zoom 前也不该吓用户。
   */
  const [mapZoom, setMapZoom] = useState<{ ok: boolean; zoom: number }>({ ok: true, zoom: 0 });
  /**
   * ★ M4（需求 6）：码头 / 机场分开控制 —— 必须 `useMemo`：
   *   这个 Set 进 `XborderPinLayer` 的 effect 依赖，每次渲染新建会全量重建 marker。
   */
  const xborderKinds = useMemo(() => {
    const s = new Set<XbPinKind>();
    if (layers.prefs.pier) s.add("pier");
    if (layers.prefs.airport) s.add("airport");
    return s;
  }, [layers.prefs.pier, layers.prefs.airport]);
  const pickedCode = rv.picked?.code ?? null;
  const pickedDir = rv.picked?.dir ?? null;

  /**
   * ★ 2026-11-06（同线换向实测）：**「换向」不是「换线」，档位不得回弹**。
   *
   * `useRouteVehicles.reverse()` 的实现是 `setPicked({ ...cur, dir: other })`（`useRouteVehicles.ts:208`）
   * ⇒ **对象身份变了、`code` 不变**，而本 effect 的依赖正是 `[rv.picked]` ⇒ 换向也会跑一遍。
   * 若在此无条件 `setStopsDetent("half")`，用户在全屏看站序、点一下「换向」，
   * 面板会**自己缩回半屏**（`useSnapSheet` 按 half 顶边重绘 translateY，260ms 可见下坠）。
   * ⇒ 只有「身份键（kind+code）变化」或「关掉再打开同一个站序」才回 `half`；
   *    单纯换向（身份键不变）保留用户当前的档位。
   *
   * ⚠️ 站序**仍清空**（换向后旧方向的站不允许留在屏上 —— 那才是真正的错配），
   *    方向文案同步回「方向待定」，由 ② 取回新方向的站序后再落定。
   *
   * 🚩🚩 **为什么用「身份键」而不是 `dir`（后来者必看，否则极可能把人改回去）** 🚩🚩
   *   本 effect 的整个存在理由 = 「换了一条线 ⇒ 身份字段要换成新的」。
   *   而 **`dir` 变化恰恰是唯一「不该重置档位」的场景**（同一条线换向，用户还在看同一张站表）。
   *   ⇒ 判据必须是 `kind:code`（身份），**绝不能**把 `dir` 算进去：
   *     · 把 `dir` 加进比较键 ⇒ 换向也判为"换线" ⇒ 面板下坠回 half（就是本轮修掉的 bug，复发）；
   *     · 把 `dir` 加进依赖数组（`[rv.picked, pickedDir]`）⇒ 换向多跑一次本 effect ⇒ 同上，
   *       且会额外再清空一次站序（多闪一次空态）。
   *   ⇒ `dir` 只归 ②（取数 effect）管。**两个 effect 的分工就是这么切的，别合并。**
   */
  const stopsKeyRef = useRef<string | null>(null);

  /** ① 打开 / 换线：立刻换掉身份字段（站序先清空，等 ② 填），档位回 `half` */
  useEffect(() => {
    const p = rv.picked;
    const key = p ? `${p.kind}:${p.code}` : null;
    const prevKey = stopsKeyRef.current;
    stopsKeyRef.current = key; // 关闭也要记账（否则「关掉再开同一条线」不会被判为重开）
    if (!p) return; // 关闭 ⇒ 保留最后一帧（收起动画要元素在位）
    setStopsSheet({
      kind: p.kind,
      code: p.code,
      color: p.color || null,
      directionLabel: "方向待定",
      stops: [],
    });
    if (prevKey !== key) setStopsDetent("half"); // 换线 / 重开 ⇒ 回默认档；同线换向 ⇒ 不动档位
  }, [rv.picked]);

  /** ② 取站序（`dir` 到位后重取一次；只写回仍属于当前线路的快照，防串台） */
  useEffect(() => {
    if (!pickedCode) return;
    let alive = true;
    const qs = new URLSearchParams({ code: pickedCode });
    if (pickedDir) qs.set("dir", pickedDir);
    fetch(`/api/route-stops?${qs}`)
      .then(async (r) => {
        if (r.status === 404) return null; // 线路已不存在 ⇒ 不给假站序
        if (!r.ok) return null;
        return (await r.json()) as RouteStopsResp;
      })
      .then((j) => {
        if (!alive) return;
        const ok = j && j.ok ? j : null;
        setStopsSheet((prev) =>
          prev && prev.code === pickedCode
            ? {
                ...prev,
                directionLabel: ok?.label ? `往 ${ok.label.to}` : "方向待定",
                stops: ok?.stops ?? [],
              }
            : prev,
        );
      })
      .catch(() => {
        /* 静默：弹窗只剩顶部行（不编造假站序） */
      });
    return () => {
      alive = false;
    };
  }, [pickedCode, pickedDir]);

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ★ 2026-11-06（#5a 收尾）：**给地图的取景避让**
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `stopsSheetOn` = 站序弹窗「应当打开」的唯一口径（选着线 + 无导航态 + 无选线弹窗）。
   *   与挂载条件**有意不同**：挂载还要多一个 `stopsSheet` 快照（它由 effect 在下一批建立，
   *   会晚一帧）。取景若等快照就会漏掉第一次 —— 而「第一次打开」正是必须取景的那次。
   *   ⇒ 挂载用 `stopsSheet && stopsSheetOn`，取景用 `stopsSheetOn`（早一帧，正好）。
   *
   * `stopsSheetTopsPx`：三档顶边，**与弹窗自己算顶边用同一个函数**
   *   （`tqhDetentTopsPx`，peek 档是 `winH−(96+safeBottom)` 而非导航口径的 80vh）。
   *   ⇒ 弹窗画在哪，取景槽就避到哪。本文件因此**不出现任何档位像素常量**。
   */
  const stopsSheetOn = !!rv.picked && !navActive && !lineSheet;
  const stopsSheetTopsPx = useMemo(
    () => tqhDetentTopsPx(winH || 844, safeTop, safeBottom),
    [winH, safeTop, safeBottom],
  );
  /**
   * ⚠️ 只在**打开**时给值；其余场景 `null` ⇒ `NavMap` 走原 `setBounds` 路径（观感零变化）。
   *   值随档位变化，但 `NavMap` 只读进 ref、**不进取景 effect 依赖** ⇒ 拖档不重新取景
   *   （取景时机仍是 打开 / 换线 / 换向，见 `NavMap.tsx` 的 `stopsInsetTopRef`）。
   */
  const stopsInsetTop = stopsSheetOn
    ? (stopsSheetTopsPx[detentIndex(stopsDetent)] ?? null)
    : null;

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ★ 2026-11-06（修复批 #6b · #2 的需求补完）：**选中班次 ⇒ 视野装下整条班次线**
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ── 为什么必须有（这不是新增需求）──────────────────────────────────────
   *   #2 的原话是「选中一条路线时，该路线以外的所有站点隐藏，**仅展示该线途径的站点**」。
   *   而首屏视野 ≈ 12.4 级、定位后 ≈ 14.47 级，都**低于**站点显示阈值
   *   （`STATION_MIN_ZOOM = 15`）⇒ 选班次后只看到一条路径线、**一个站点都没有**，
   *   「仅展示该线途径的站点」当场不成立（用户读到的是"这班车没有站"）。
   *   ⇒ 取景是 #2 的组成部分，不是可选项。
   *
   * ── 怎么复用既有取景（**不新写算法**）──────────────────────────────────
   *   走 `useNavFrame()` 的 `frame({ mode:"fit-box", box, slotTopPx })` —— 与
   *   `RoutePanel` / 详情 pane 取景**同一条**已验证路径（`NavMap.applyView` 自算 zoom +
   *   `panBy`，禁 `setBounds`/`setFitView`，见 `NavMap.tsx:944-1000`）。
   *   ⇒ 本文件不出现任何 zoom 公式、也不碰相机。
   *
   * ── 槽位（遮挡）口径 ───────────────────────────────────────────────────
   *   `slotTopPx` 取 `tqhDetentTopsPx(...)[detentIndex("half")]` —— 与 `LineStopsSheet`
   *   **同一个函数**算顶边（该弹窗的初始档就是 `half`），与线路查看的 `stopsInsetTop`
   *   完全同源。
   *   ★ 为什么固定用 `half` 而不是弹窗当前档：`LineStopsSheet` 的 `detent` 是它**内部**
   *     state，宿主读不到；而三档像素是**升序**（full 96~128 < half 50vh < peek 80vh），
   *     `half` 的槽比 `peek` 更小 ⇒ 按 `half` 装下的内容在 `peek` 档**必然仍在可见区**，
   *     绝不会被压住。宁可多缩一点，也不为了"刚好"去读一个跨组件的内部状态。
   *
   * ── 只在「刚选中」fit 一次（不许反复纠正）──────────────────────────────
   *   `tqhFitRef` 记「本会话这一班已经装过的框」，两条闸门：
   *     ① `code` 变了（选了**另一班** / 换向）⇒ 该 fit；
   *     ② 同一班但**新框超出了已装框** ⇒ 该 fit 一次（真实原因只有一个：路径几何比站点
   *        包围盒更大——站先到、逐段几何后到，这是数据到位的补正，不是抖动）。
   *   ⇒ 用户自己拖地图 / 缩放**永不触发** refit（与 `useNavFrame` 的既有纪律一致）。
   *
   * ── 退出班次模式不强制复位 ─────────────────────────────────────────────
   *   只把 ref 清空（下次选班重新计），**不下任何取景指令** —— 用户拖到哪就是哪，
   *   与 `contextClose` / `exitLine` 的既有约定一致。
   */
  const tqhFitBox = useMemo<FrameBox | null>(() => {
    const trip = tqhTrip;
    if (!trip) return null;
    const byId = stationMapOf(tqh.data.stations);
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    const push = (lng: number, lat: number) => {
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    };
    // ① 站点（先到；数据已随首屏加载，所以第一次 fit 就有框）
    for (const st of trip.stops) {
      const s = byId.get(st.station_id);
      if (s) push(s.lng, s.lat);
    }
    // ② 逐段几何（后到；比站点包围盒更贴真实走向，用于「补正」那一次 refit）
    for (const seg of tqhPath ?? []) for (const p of seg.polyline ?? []) push(p[0], p[1]);
    if (!Number.isFinite(minLng)) return null;
    return { minLng, minLat, maxLng, maxLat };
  }, [tqhTrip, tqhPath, tqh.data.stations]);

  /** 班次弹窗 `half` 档顶边（px）—— 取景槽的上边界，与弹窗自己算顶边同一个函数 */
  const tqhFitSlotTop = useMemo(
    () => tqhDetentTopsPx(winH || 844, safeTop, safeBottom)[detentIndex("half")],
    [winH, safeTop, safeBottom],
  );

  /** 已装过的框（`code` + box）；退出班次模式即清空 */
  const tqhFitRef = useRef<{ code: string; box: FrameBox } | null>(null);

  useEffect(() => {
    const code = tqhTrip?.trip_code ?? null;
    if (!code) {
      tqhFitRef.current = null; // 退出班次模式：清闸门，**不下取景指令**（不复位）
      return;
    }
    /**
     * ★ 导航态**不取景**：面板打开期间镜头归 `frameBox` / `stopsInsetTop` 那条链
     *   （`RouteSheet` 的档位取景是已验收行为）。这里若也插一手，会出现
     *   「进详情的同时地图又跳一次」——两个意图抢镜头，谁后跑谁生效，结果不可预测。
     *   为什么这个分支真实可达：导航前就选了班次时 `tqhTrip` 仍在，而该班次的
     *   逐段几何可能在导航**开始之后**才返回 ⇒ `tqhFitBox` 变引用 ⇒ 本 effect 重跑。
     *   ⚠️ 不清 `tqhFitRef`：退出导航后若框仍未被覆盖，应当补装一次（闸门语义不变）。
     */
    if (navActiveRef.current) return;
    if (!tqhFitBox) return; // 站与几何都还没有 ⇒ 等数据，不乱取景
    const last = tqhFitRef.current;
    const covered =
      !!last &&
      last.code === code &&
      last.box.minLng <= tqhFitBox.minLng &&
      last.box.minLat <= tqhFitBox.minLat &&
      last.box.maxLng >= tqhFitBox.maxLng &&
      last.box.maxLat >= tqhFitBox.maxLat;
    if (covered) return; // 已经装下 ⇒ 不再纠正（用户拖动后更不会被打断）
    tqhFitRef.current = { code, box: tqhFitBox };
    /**
     * `force: true` —— 选中班次是**显式意图**，必须解除让位锁（`followState="free"`）。
     * 不加的话：真实路径是「先缩放/拖动地图找车 → 再点班次」，此时锁必然为 `free`
     * ⇒ 取景被静默跳过、视野不动、零提示（需求未实现却无任何信号）。
     * 语义与定位键（`locateTick` → `setFollowState("follow")`）一致；
     * 线路查看模式本来就是直接走相机、不受锁约束 ⇒ 两者同权才谈得上「同一配方」。
     */
    frame({ mode: "fit-box", box: tqhFitBox, slotTopPx: tqhFitSlotTop, force: true });
    /* 依赖用 `navActive`（布尔原值）而不是 `navActiveRef`（ref 变了不触发 effect）——
       导航**结束**时要重新评估一次，否则「导航期间攒下的未装框」永远等不到补装。 */
  }, [tqhTrip?.trip_code, tqhFitBox, tqhFitSlotTop, frame, navActive]);

  /**
   * ★ 修复批 #9 / #10（2026-11-06）：下发给 `NavDetailBody` 的**候车实时值**。
   *   `eta` = 候车报站（`null` ⇒ 该组件回落 `card.rides[0].liveText`）；
   *   `catch*` = 实时赶车档（`null` / `""` ⇒ 回落 `card.rides[0].tierText`）。
   * 值只在「报站落地 / 重算完成」时换引用 ⇒ 不会因为每帧 GPS 抖动让详情层跟着重渲染。
   */
  const boardingLiveValue = useMemo<BoardingLiveValue>(
    () => ({
      eta: boardingEtaLive
        ? {
            text: boardingEtaLive.text,
            stopsAway: boardingEtaLive.stopsAway,
            etaMin: boardingEtaLive.etaMin,
            seq: boardingEtaLive.seq,
          }
        : null,
      catchTier: catchLive.tier,
      catchText: catchLive.text,
      catchSeq: catchLive.seq,
    }),
    [boardingEtaLive, catchLive],
  );

  return (
    /**
     * ★ U2：**锁存下发通道**（见上方 `hasEnteredRiding` 块注释）。
     *   包住整棵子树而不是只包 `RouteSheet`：`NavDetailBody` 在 `RouteSheet` 里面，
     *   中间还隔着 `RouteDetailPane`，Context 不受中间层传参写法影响。
     *   ⚠️ 值在渲染期读取（`hasEnteredRiding.current`）——它与「进入 riding 的那次 commit」
     *     同帧，故标签在**同一次 commit** 里就已从 DOM 移除。
     *
     * ★ 修复批 #9/#10：里面再包一层 `BoardingLiveContext`（候车实时值的下发通道）。
     *   同一种模式、同一层挂载点 —— 中间两层（`RouteSheet` / `RouteDetailPane`）不在本批范围，
     *   加 prop 要改它们，走 Context 只依赖 React 树。
     */
    <CatchTagLatchContext.Provider value={hasEnteredRiding.current}>
    <BoardingLiveContext.Provider value={boardingLiveValue}>
    {/* ⚠️ 下面这段 `<section>` 及其子树的缩进**刻意保持原样**（不给 Provider 再加一级）——
        包一层 Provider 若要全局重排缩进，会把整块 300 行 JSX 变成"全文件改动"，
        审查时看不出真正的语义改动。结构仍以标签为准：Provider > section > … */}
    <section className="nav-shell nav-shell--full">
      <div className="nav-map-wrap">
        <NavMap
          jsKey={jsKey}
          mapStyleId={mapStyleId}
          className="nav-map--full"
          dest={destArg}
          origin={originArg}
          view={view}
          locateTick={locateTick}
          onLocate={onLocate}
          onStationClick={onStationClick}
          onMapClick={onMapClick}
          /**
           * ★ 需求 7：跨境地标圆点。
           *   · `!navActive`：**导航 / 步行态不画** —— 那时地图要装路线与转向，
           *     地标属于"看地图找机场"的场景，混进导航只会增加误点；
           *   · 点地标时先清掉另两张卡：三者共用 `.nav-card-overlay`，不清就是两张卡叠着。
           */
          showXborderPins={!navActive}
          /* ★ M4（需求 6）：码头 / 机场分别由图层开关控制（聚合本身仍在全量地标上算） */
          xborderKinds={xborderKinds}
          /* ★ M4（需求 2/3）：巴士站点 / 公共厕所图层开关（默认 4 开 1 关，来自图层偏好） */
          showBusStations={layers.prefs.bus}
          /**
           * ★ 需求 3（负责人原话：「只在首页地图显示，导航时隐藏」）：
           *   这里承载**两件事** —— 用户偏好 × **相位门**。
           *   用 `navPhase === "off"`（全站统一的「非首页地图」口径，与 `navMode`
           *   `NavShell.tsx:2448` 同一判据），**不用 `navActive`**：后者是
           *   `rsOpen && pane === "detail"`，推荐层下仍为 false ⇒ 得到「推荐面板开着、
           *   公厕照样显示」，违反需求。
           *   ⚠️ 改名提醒：本 prop 不是「用户偏好」，是「此刻该不该画」。
           */
          showToilets={layers.prefs.toilet && navPhase === "off"}
          /* ★ 用「值相同则返回原对象」的写法：`NavMap` 的 render 会在 zoomend/moveend 反复跑，
             每次都 new 一个对象会让父组件无限重渲染（React 只按引用比较）。 */
          onStationZoomChange={(ok, zoom) => setMapZoom((p) => (p.ok === ok && p.zoom === zoom ? p : { ok, zoom }))}
          onToiletClick={(t) => {
            /* 与另两张卡同一口径：先清同类卡，三者共用 `.nav-card-overlay` */
            setStation(null);
            setTqhStation(null);
            setXbPinIds(null);
            rv.closeVehicle();
            setToilet(t);
          }}
          onXborderPinClick={(ids) => {
            setStation(null);
            setTqhStation(null);
            rv.closeVehicle();
            setXbPinIds(ids);
          }}
          /* ★ v2.10.0：路线查看模式 + 实时车辆；★ 2026-09-23：detail pane 打开时让位给总览 */
          routeLine={detailActive ? null : rv.picked}
          onRouteDirs={rv.reportDirs}
          /* ★ 2026-11-06（#5a 收尾）：站序弹窗打开时，取景避开它盖住的那半屏（关闭 ⇒ null = 原行为） */
          stopsInsetTop={stopsInsetTop}
          /**
           * ★ v3.6.0 S4（需求 R3 · 候车态地图车辆实时化）：
           *   detail pane 一律用 `ride.mapVehicles` —— 它由 12s 车辆帧驱动，
           *   候车态返回**本帧全部候选车**（riding 时只返回当前这辆）。
           *   旧版候车态用 `ov.vehicles`（进 detail 时**一次性**拉取）⇒ 地图上的车永远不动，
           *   「刷新」只更新下方列表，用户会当成"刷新没反应"。
           *   ⚠️ 因此 `useRouteOverview` 不再拉车（车辆只有一个来源 = `useRideTracking`）。
           */
          vehicles={detailActive ? ride.mapVehicles : rv.vehicles}
          onVehicleClick={onVehicleClick}
          /* ★ 2026-09-23：路线总览（灰底线 + 彩段） */
          overview={detailActive ? ov.legs : null}
          /* ★ v3.6.0 S5：步行三线（done/now/ahead）—— `walkSeg` 为空 ⇒ 传 null ⇒ 地图 0ms 移除 */
          walk={
            walkActive && activeWalk?.phase === "ready"
              ? {
                  steps: activeWalk.steps,
                  currentIdx: Math.max(0, walkFollow.currentIdx),
                  ratio: walkFollow.progress.ratio,
                  donePath: donePathRef.current,
                }
              : null
          }
          walkVersion={walkVersion}
          /**
           * ★ P0：上层是否已有可用定位 —— 供 `NavMap` 决定**要不要说"无法定位"**。
           *   高德定位失败但浏览器 GPS 有值时，蓝点/出发都正常，说"无法定位"就是假话。
           */
          hasExternalPos={!!myPos}
          /* ★ T1（需求 3）：**非当前段的步行走廊常驻**（细虚线；已走完转灰）——
             末段步行在此之前从未在地图出现过。会话结束/离开 detail ⇒ `null` ⇒ 0ms 全清。 */
          walkGhosts={walkGhosts}
          /* ★ v3.2.0（需求 4 / AC-74）：**蓝点任何时候显示** —— 导航态用 GPS 投影点（`youDot`）回落原始
             GPS；**浏览/选点/选路线态也回落原始 GPS**（原先非 detail 态传 `null` ⇒ 浏览时不显示蓝点，
             违反 AC-74）。拒权/未获定位 ⇒ `userFixR.fix = null` ⇒ 蓝点不显示、页面照常（AC-75）。 */
          userFix={detailActive ? (ride.youDot ?? userFixR.fix) : userFixR.fix}
          traveled={detailActive && ride.phase === "riding" ? ride.traveled : null}
          /* ★ 本批（需求②）：站点白名单（导航模式仅显示本线路站点） */
          lineStops={detailActive ? lineStops : null}
          /* ★ v3.2.0（需求 7 / AC-80）：蓝点移动插值时长 = 采样间隔；仅 ≤5s 才插值（浏览 10s ⇒ 0） */
          userDotSmoothMs={gpsIntervalMs <= 5_000 ? gpsIntervalMs : 0}
          /* ★ 2026-11-05（通琴号 R3/R4）：站点层 + 路径层。
             三者同源（`useTqhLines` 的模块级缓存）⇒ 切板块/点站点 0 请求。
             `tqhSegments` 为 null ⇒ 路径层清空（关站序弹窗时即刻收线，不留残影）。
             ══════════════════════════════════════════════════════════════════
             ★ 2026-11-06（修复批 #6c）：**导航态一律不画班次路径线**（`navActive` ⇒ null）
             ══════════════════════════════════════════════════════════════════
             为什么：`TqhPathLayer` 的 z73 **高于**导航彩段（`overview` z72）⇒ 若两者同屏，
               班次线会压在「我这次行程要坐的那几段」之上，用户会以为那就是他正在坐的车。
               屏幕上不该有第二条路径线。
             为什么必须在这里关（而不是指望上游不产生 `tqhPath`）：`tqhPath` 是
               `tqhTrip` 的派生数据，而「导航前就选了班次」这条路径**合法存在**
               （`tqhTrip` 在导航开始时不被清，见 R2「导航态通琴号一个字不改」）
               ⇒ 只能在这一处按 `navActive` 掐掉渲染，不动数据、不动状态。
             ⚠️ 只掐 `tqhSegments`（视觉层）；`tqhPath` 本体仍保留 —— 取景包围盒要用它
               （见 `tqhFitBox`），且退出导航后线要能立刻回来，不需要重新请求。
             ⚠️ 渲染层只认 `navActive`（`rsOpen && pane==='detail'`）；`detailActive` 与之同义，
               但本文件既有约定以 `navActive` 为准，别为了"统一"改成另一个。 */
          tqhStations={tqhMapStations}
          tqhActiveIds={tqhActiveIds}
          tqhSegments={navActive ? null : tqhPath}
          /* ★ 2026-11-06（修复批 #1）：双色巴士标集合（通琴号关联站不再单独成标）；
             `null` = 不染 —— 导航态恒 `null`（2026-11-08 裁定，与 tqhSegments 同口径） */
          tqhSharedBusCodes={tqhSharedCodes}
          /* ★ 2026-11-06（#1 配套）：本班次经过、但已并入巴士标的站 ⇒ 巴士标加白环 */
          tqhActiveBusCodes={tqhActiveBusCodes}
          /* ★ 2026-11-06（修复批 #6 · P0）：班次模式下**巴士站点层**的白名单
             （只留关联巴士主码；空集 = 巴士站全隐；`null` = 不管，导航态/浏览态行为不变） */
          tqhBusWhitelist={tqhBusWhitelist}
          /* ★ 2026-11-06（修复批 #3）：通琴号站点白名单
             （`null` = 不过滤 = 仅浏览态；导航态传空集 ⇒ 全隐，2026-11-08 裁定） */
          tqhWhitelist={tqhWhitelist}
          onTqhStationClick={onTqhStationClick}
        />

        {/* 品牌栏（三栏网格）：左=空 · 中=换向键+线路标签 · 右=竖排按钮组（导航态右列隐藏，AC-84） */}
        <NavBrandBar
          picked={
            rv.picked
              ? { label: rv.picked.label, color: rv.picked.color, kind: rv.picked.kind, code: rv.picked.code }
              : null
          }
          canReverse={rv.canReverse}
          cooldownSec={rv.cooldownSec}
          onReverse={rv.reverse}
          onExitLine={rv.exitLine}
          onRefresh={rv.refresh}
          onOpenLines={() => setLineSheet(true)}
          /* ★ v3.3.0（AC-100）：首页定位按钮（右列原位）；导航态整列隐藏 ⇒ 由浮动 FAB 承担 */
          onLocate={() => setLocateTick((t) => t + 1)}
          /* ★ v3.2.0（需求 10 / AC-84）：导航语境（data-nav-phase ≠ off）⇒ 隐藏「查看路线」与「M Map logo」 */
          navMode={navPhase !== "off"}
          /* ★ v3.6.1：「查看全部站点」⇒ `/line/[code]` 深链页（保留为可达入口，不是孤儿页） */
          onOpenAllStops={openAllStops}
          /* ★ M4（需求 5）：图层面板入口（右栏最上；导航态由 NavBrandBar 内部隐藏） */
          onOpenLayers={() => setLayerSheet(true)}
        />

        {/* 顶置搜索条 + 提示条槽（★ v3.6.0 AC-54：收藏带入横幅及其专用 props 已删除） */}
        <NavSearchBarSlot
          stage={stage}
          to={to}
          error={!!rv.error}
          onOpenSearch={() => openSearch("dest")}
        />
      </div>

      {/* ★ v3.2.0（需求 11 / AC-85）+ v3.3.0（AC-100）：**定位两模式**（`data-locate-pos` 冻结钩子）
          · `off`（首页默认地图）⇒ **不渲染浮动层**，定位按钮在品牌栏右列原位（`bar`）；
          · `!=off`（recommend/detail/riding）⇒ 浮动层（`float`）随面板档位上下避让
            （`--sheet-y-anim` bottom 公式），品牌栏整列隐藏 ⇒ **两模式互斥、不重叠**。 */}
      {navPhase !== "off" && (
        <button
          type="button"
          className="nav-locate-fab"
          data-locate-fab="on"
          data-locate-pos="float"
          aria-label="定位到我的位置"
          title="定位到我的位置"
          onClick={() => setLocateTick((t) => t + 1)}
        >
          <Icon name="locate" size={20} />
        </button>
      )}

      {/* ★ v3.2.0（需求 8 / AC-81/82）：**页面级顶部下车横幅** —— 独立于面板，fixed + 安全区，
          z94（> 面板 70 / > 车卡浮层 90），落位公式见 globals.css `.nav-alarm--top`（07 §3.4）。 */}
      {ride.phase === "riding" && ride.alarm !== "none" && (
        <div className="nav-alarm--top" data-alarm-pos="top" data-alarm={ride.alarm}>
          <AlightBanner alarm={ride.alarm} destLabel={alarmLabel} />
        </div>
      )}

      {/* ★ M4（需求 5/6）：图层面板 —— 必须挂在 `.nav-map-wrap` **之外**：
          `.nav-shell--full .nav-map-wrap` 是 `position:fixed; z-index:0`，挂进去会被那个
          堆叠上下文困住，被 z70 的半屏面板盖死。打开即 half 档（几何取 `detentTopsPx`），
          点面板外地图由 `onMapClick` 关闭（不吞掉原有清卡行为）。 */}
      <LayerSheet
        open={layerSheet}
        onClose={() => setLayerSheet(false)}
        winH={winH}
        safeTop={safeTop}
        zoomOk={mapZoom.ok}
        zoom={mapZoom.zoom}
      />

      {/* ★ 卡片浮层（车卡/站卡）—— 挂在 wrap **之外**，`.nav-card-overlay`（fixed z90）
          ⇒ 面板打开时点地图带上的车/站，卡片不被面板（z70）压住。 */}
      {(station || rv.selected || tqhStation || xbPinIds || toilet) && (
        <div className="nav-card-overlay">
          {/* ★ M4（需求 3）：公厕卡 —— 与另三张共用同一个 `.nav-card-overlay`（z90）。
              点 pin 时上面几个状态已被清空 ⇒ 实际同屏只有它一张。 */}
          {toilet && (
            <PublicToiletCard
              toilet={toilet}
              navActive={navActive}
              onClose={() => setToilet(null)}
              onSetFrom={() => {
                setFrom(toiletToNavPoint(toilet));
                setToilet(null);
                setStage("panel");
              }}
              onSetTo={() => {
                setTo(toiletToNavPoint(toilet));
                setToilet(null);
                setStage("panel");
              }}
            />
          )}
          {/* ★ 需求 7：跨境地标卡（机场/码头；聚合点为两行链接）。
              放在最前：点地标时上面三个状态已被清空，实际同屏只有它一张。 */}
          {xbPinIds && (
            <XborderCard
              ids={xbPinIds}
              onClose={() => setXbPinIds(null)}
              /* ★ M4（需求 4）：逐条设施设点 —— 每条用**自己**的坐标（`xbPinById`） */
              navActive={navActive}
              onSetFrom={(id) => {
                const pin = xbPinById(id);
                if (!pin) return;
                setFrom({ kind: "place", label: pin.name, lng: pin.lng, lat: pin.lat });
                setXbPinIds(null);
                setStage("panel");
              }}
              onSetTo={(id) => {
                const pin = xbPinById(id);
                if (!pin) return;
                setTo({ kind: "place", label: pin.name, lng: pin.lng, lat: pin.lat });
                setXbPinIds(null);
                setStage("panel");
              }}
            />
          )}
          {station && (
            <StationCard
              station={station}
              colors={colors}
              /* ★ M4（需求 4）：导航态不渲染设点按钮（判定在 SetPointActions 内部） */
              navActive={navActive}
              onClose={() => setStation(null)}
              onSetFrom={() => {
                setFrom(stationToNavPoint(station));
                setStation(null);
                setStage("panel");
              }}
              onSetTo={() => {
                setTo(stationToNavPoint(station));
                setStation(null);
                setStage("panel");
              }}
              /**
               * ★ 通琴号 R4：**只在该站位确实有通琴号班次时**传。
               *   传空数组会渲染一句「本站暂无通琴号班次」——对纯巴士站是噪音。
               * ★ 2026-11-06（#2）：改为按通琴号站逐个成组（组名 `通琴号-<站名>`）。
               */
              tqh={
                tqhEntriesForStation.length
                  ? {
                      entries: tqhEntriesForStation,
                      phase: tqh.phase,
                      activeTripCode: tqhTrip?.trip_code ?? null,
                      onPickTrip: pickTqhTrip,
                      /* ★ 2026-11-06（#6c）：与 `pickLineDisabled` 同源同值 ——
                         同一张卡片上两套「跳走」入口必须同步禁用，否则一行禁一行不禁 = 沉默逻辑错误 */
                      pickTripDisabled: navActive,
                    }
                  : null
              }
              /* ★ 2026-11-06（#4）：点线路行 → 进该线路查看；导航进行中禁用 */
              onPickLine={onPickLineFromCard}
              pickLineDisabled={navActive}
            />
          )}
          {/* ★ 通琴号 R4：纯通琴号站的独立卡片（合并组 ⇒ 一组站，R1）；做完即返回地图 */}
          {tqhStation && (
            <TqhStationCard
              stations={tqhStation.stations}
              entries={tqhEntriesForTqhStation}
              phase={tqh.phase}
              activeTripCode={tqhTrip?.trip_code ?? null}
              onPickTrip={pickTqhTrip}
              /* ★ 2026-11-06（#6c）：导航态禁用班次行（与 `StationCard` / 线路行同一口径） */
              pickTripDisabled={navActive}
              /* ★ M4（需求 4）：设点 —— 合并组取代表站坐标（同一物理点，结果等价） */
              navActive={navActive}
              onSetFrom={
                tqhStation?.stations[0]
                  ? () => {
                      const st = tqhStation.stations[0];
                      setFrom({ kind: "place", label: st.name, lng: st.lng, lat: st.lat });
                      setTqhStation(null);
                      setStage("panel");
                    }
                  : undefined
              }
              onSetTo={
                tqhStation?.stations[0]
                  ? () => {
                      const st = tqhStation.stations[0];
                      setTo({ kind: "place", label: st.name, lng: st.lng, lat: st.lat });
                      setTqhStation(null);
                      setStage("panel");
                    }
                  : undefined
              }
              onClose={() => setTqhStation(null)}
            />
          )}
          {rv.selected && (
            <VehicleCard
              vehicle={rv.selected.vehicle}
              count={rv.selected.count}
              /* ★ T6：导航态取 ride 侧的线路/帧时刻（导航态 `rv` 从未 fetch ⇒ 旧值恒 null） */
              fetchedAt={navVehMeta ? navVehMeta.fetchedAt : rv.fetchedAt}
              lineLabel={navVehMeta ? navVehMeta.label : rv.picked?.label}
              lineColor={navVehMeta ? navVehMeta.color : rv.picked?.color}
              onClose={rv.closeVehicle}
            />
          )}
        </div>
      )}

      {/*
        ★ v3.6.0 S5：**顶部步行跟随横幅** —— 页面级 `fixed`，**必须挂在 `.nav-map-wrap` 之外**。
        wrap 是层叠上下文，挂进去会永远低于底部 chrome（项目为这个先后踩过两次，
        见本文件 `:34-36` 的注释）。四态一条横幅，绝不叠两条。
      */}
      {walkActive && activeWalk?.phase === "ready" && (
        <WalkTurnBanner
          state={
            walkFollow.phase === "arrived"
              ? "arrive"
              : walkFollow.offRoute
                ? "off"
                : walkFollow.lowAccuracy
                  ? "manual"
                  : "turn"
          }
          text={activeWalk.steps[walkFollow.currentIdx]?.text}
          sub={activeWalk.steps[walkFollow.currentIdx]?.sub}
          turn={activeWalk.steps[walkFollow.currentIdx]?.turn ?? "straight"}
          /* 横幅显示**本步剩余米**（不是全程 → 否则"右转"配"还剩 800 米"会让人以为走错） */
          distM={(() => {
            const s = activeWalk.steps[walkFollow.currentIdx];
            if (!s) return 0;
            const geom = s.cumM.length ? s.cumM[s.cumM.length - 1] - s.cumM[0] : s.distM;
            return Math.max(0, geom - walkFollow.progress.doneInStepM);
          })()}
          offM={walkFollow.offM}
          destLabel={to?.label}
          /**
           * ★ 额度用尽（本段重算 0 次）⇒ 换成定稿降级文案，并且**不渲染按钮**
           *   （点了发不出请求 = 假按钮）。文案里不出现「失败/错误/超时/额度/配额/接口」等词。
           */
          offText={walkReloadOut ? "步行路段暂时无法更新，可重新选择路线" : undefined}
          onRecover={
            walkReloadOut
              ? undefined
              : () => {
                  /* 手动重算走统一入口（同一把 3s 冷却 + 同一份额度）；无论发没发出去都撤偏航态 */
                  recalcWalk("manual");
                  walkFollow.recover();
                }
          }
          onRetry={() => userFixR.start?.()}
        />
      )}

      {/*
        ★ T1：**步行段的真出口**（页面级 `fixed`，必须挂在 `.nav-map-wrap` 之外）。
        为什么不复用面板吸底条：
          · 步行段 `RouteSheet` 的 `track` 传 `null` ⇒ 吸底条不渲染（否则会出现与当前段无关的
            「开始导航 / 手动标记上车」）；
          · 面板拖到 peek 时吸底条会被摘要层压住 —— 出口不能依赖面板状态。
        点击 = `endSession()`：`walkSeg` / `donePath` / `data-walk-*` / 乘车引擎一起收。
      */}
      {walkActive && (
        <button type="button" className="nav-walk-exit" data-walk-exit="on" onClick={endSession}>
          <Icon name="close" size={16} />
          结束导航
        </button>
      )}

      {/* 公共交通路线全屏选择弹窗（必须在 wrap 之外） */}
      {lineSheet && (
        <RouteLinesSheet
          onPick={(l) => {
            rv.pickLine(l);
            setLineSheet(false);
          }}
          onPickTrip={pickTqhTrip}
          activeTripCode={tqhTrip?.trip_code ?? null}
          /* 已在地图上查看某班次时再打开弹窗 ⇒ 直接落回通琴号板块（不用重找标号） */
          /**
           * ★ 需求 4：`?board=tqh` 优先于"当前是否正看着某班"。
           * 缺省（两者皆假）由被调方自己的 `defaultBoard = "bus"` 兜底 —— 这里不写第三套逻辑。
           */
          defaultBoard={initialBoard || tqhTrip ? "tqh" : "bus"}
          onClose={() => setLineSheet(false)}
        />
      )}

      {/*
        ★ 2026-11-05（通琴号 R5）：站序三档弹窗。
        必须挂在 `.nav-map-wrap` **之外** —— 与 `RouteSheet` 同理：wrap 是固定定位的
        层叠上下文，挂进去会被底部 chrome 压住（项目为这个先后踩过两次）。
        `winH / safeTop / safeBottom` 由宿主给：档位顶边一律运行时现算，不写死 px。
      */}
      {tqhTrip && (
        <LineStopsSheet
          open={tqhStopsOpen}
          trip={tqhTrip}
          stations={tqh.data.stations}
          siblings={tqhSiblings}
          onSwitchTrip={setTqhTrip}
          onClose={closeTqhStops}
          onRefresh={tqhReload}
          winH={winH}
          safeTop={safeTop}
          safeBottom={safeBottom}
        />
      )}

      {/*
        ════════════════════════════════════════════════════════════════════════
        ★ 2026-11-06（修复批 #4/#5 · R3）**前端 C 的接入点** —— `RouteStopsSheet`
        ════════════════════════════════════════════════════════════════════════

        【触发链路（已完成，不要改）】
          `StationCard` 的线路行 → `onPickLineFromCard(code, kind)`
            → `rv.pickLine({ code, kind, label: lineNameOf(code), color })`
            → 地图画该线走向 + 顶部线路 chip + `rv.picked` 非空
          ⇒ **宿主不新增任何 state**：C 的弹窗以 `rv.picked` 为唯一打开依据（导航态已被
            `StationCard`/`onPickLineFromCard` 双向拦住，不会跳走）。

        【props 契约（已按前端 C 的 `RouteStopsSheet.tsx` 落地，见下方真实挂载）】
          `open`            = `!!rv.picked`（**只管收合动画**；「是否在 DOM 里」由 `stopsSheet` 存在 +
                              `!navActive && !lineSheet` 决定 —— 两者分工见挂载点注释）
          `kind`            = `rv.picked.kind`（`bus` | `lrt`；通琴号仍走 `LineStopsSheet`）
          `lineCode`        = `rv.picked.code`（巴士 `26` / 轻轨 `LRT-氹仔线`）
          `directionLabel`  = `往 <终点站>`（来自 `/api/route-stops` 的 `label.to`）
          `firstTime`       = `null` —— `/api/route-stops` **不下发首班时刻**，该项自动不渲染
          `stops`           = 宿主取好的站序（`RouteStopsOk.stops`）
          `detent`/`onDetentChange` = 宿主持有的三档（换线重置 `half`）
          `onClose`         = `rv.exitLine`（清线 / 清车 / 清 chip）
          `onRefresh`       = `rv.refresh`（轻轨内部早退，无实时）
          `onFlipDirection` = `rv.canReverse ? rv.reverse : null`（null ⇒ `aria-disabled` + toast）
          `color`/`winH`/`safeTop`/`safeBottom` = 线路色 + 现算几何

        ⚠️ **TODO（已知缺口 · 已报负责人 2026-11-06，本轮不修）「方向加载中」被说成「无对向方向」**
          `rv.canReverse = dirs.length > 1`，而 `dirs` 由 `NavMap` 读 `/api/route-shapes` 后
          **异步**回报（`useRouteVehicles.ts:256` + `reportDirs`）。⇒ shapes 到达前的窗口期
          `dirs = []` ⇒ `canReverse = false` ⇒ 若用户此刻点「换向」，弹窗会 toast
          **「這條線暫無對向方向」**——这句话是**假的**（只是还没加载完）。
          窗口 = 一次 route-shapes 请求（本地缓存命中时几乎为零，冷启可达数百毫秒）。
          根治要动组件契约（把「未知」与「单向」分开：例如 `onFlipDirection` 允许 `undefined`
          = 加载中，另出一句「方向加载中」）⇒ **收口前不引入契约变更**，只登记。
          ⚠️ 将来若改为「加载中禁用按钮」，仍然**不得隐藏**换向键（隐藏会让关闭键左移，
             这是"点不到关闭"的经典复发路径，见 `RouteStopsSheet.tsx:47-48`）。

        【三条硬约束（源自 Spec §5 与既有事故记录）】
          ① 必须挂在 `.nav-map-wrap` **之外**（wrap 是层叠上下文，挂进去会被底部 chrome 压住）；
          ② 拖拽一律走 `useSnapSheet`（`--sheet-y-anim` 命令式写入），不要自写 pointer 逻辑；
          ③ 报站（第二阶段 #5b）必须继承 `useLazyEta` 六条硬约束（视口 ±1 屏 / 并发 ≤3 /
             静默 250ms / 队列 ≤8 / 硬闸 ≤30 / **轻轨零请求**）—— 整线预取会打穿 DSAT。

        ⚠️ 还有一处**取景**要一并处理：`NavMap` 在 `routeLine` effect 里用了
          `map.setBounds(...)`（与「取景禁用 setBounds」铁律的既有例外），
          加了半屏弹窗后它会盖住线的下半段 ⇒ 需要改用带 inset 的 fit（参考 `useNavFrame`）。
          ⇒ 该处属 `NavMap.tsx`（我的文件），C 提需求、我改。

        互斥判定：三者同屏会互相压（站序弹窗 z77 vs 导航面板 z70 vs 选线弹窗全屏）⇒
          导航态（`navActive`）与选线弹窗（`lineSheet`）打开时**不渲染**本站序弹窗的元素
          （不是只加 `open=false`：`useSnapSheet` 关闭态仍占 DOM，仍会吃 pointer 事件）。
        ════════════════════════════════════════════════════════════════════════ */}
      {/*
        【挂载条件 = 两条约束的交集（不是二选一）】
          ① 快照 `stopsSheet` 存在 ⇒ 至少打开过一次 ⇒ **元素留在 DOM**（收起动画要 `open` 驱动，
             不能靠卸载 —— `useSnapSheet` 关闭态把 translateY 推到 100dvh，见 `:1556-1561`）；
          ② `!navActive && !lineSheet` ⇒ 导航态 / 选线弹窗打开时**根本不挂**（不是 `open=false`：
             关闭态仍占 DOM，靠 `inert` 挡命中不挡层叠，见 `:1956-1958`）。
        ⇒ 组合后语义：`open` 只表示「用户是否还选着这条线」，收合交给 `useSnapSheet`；
          「是否存在于 DOM」由互斥条件决定。二者不重叠、也不互相削弱。
        【全部读快照】`kind / code / color / directionLabel / stops` 一律取自 `stopsSheet`，
          不再读 `rv.picked`（换线瞬间 `rv.picked` 已变而站序还是上一帧 ⇒ 会错配）。
      */}
      {stopsSheet && stopsSheetOn && (
        <RouteStopsSheet
          /* ← 收起动画交给 open，不再用外部 `&&` 当开关 */
          open={!!rv.picked}
          kind={stopsSheet.kind}
          lineCode={stopsSheet.code}
          directionLabel={stopsSheet.directionLabel}
          firstTime={null}
          stops={stopsSheet.stops}
          detent={stopsDetent}
          onDetentChange={setStopsDetent}
          onClose={rv.exitLine}
          onRefresh={stopsSheet.kind === "bus" ? () => rv.refresh() : undefined}
          onFlipDirection={rv.canReverse ? () => rv.reverse() : null}
          color={stopsSheet.color}
          winH={winH}
          safeTop={safeTop}
          safeBottom={safeBottom}
        />
      )}

      {/* ★ 单一三档面板宿主（推荐 ⇄ 详情；必须在 wrap 之外） */}
      <RouteSheet
        open={rsOpen}
        pane={pane}
        detent={snap}
        topsPx={topsPx}
        onDetentChange={onDetent}
        onContextClose={contextClose}
        odLabel={odLabel}
        query={resultQuery}
        colors={colors}
        fav={fromPoint && to ? { from: endpointOf(fromPoint), to: endpointOf(to) } : null}
        immersive={ride.phase === "riding"}
        /**
         * ★ T1：步行入口 + **两段**预览（首段 / 末段）。
         * ★ v3.9.0：`onStart` 字段已删——「开始步行」按钮（唯一消费方）已由负责人裁定删除，
         *   步行进入只走「开始导航」的 `startSession("out")`（同一条会话入口）；
         *   自动推进 ①~④ 不变（出发⇒步行出发段、到站⇒上车、下车⇒步行到达段）。
         *   `onExpand` 保留：详情页「步骤」展开键仍按需取数。
         */
        walk={{
          onExpand: (seg) => walkRoute.ensure(seg),
          /** ★ 正在跟随（walk 态）⇒ RouteSheet 据此禁 peek */
          active: walkActive,
          preview: {
            phase: walkRoute.out.phase,
            steps: walkRoute.out.steps,
            serverSteps: walkRoute.out.steps,
            totalDistM: walkRoute.out.stepsTotalM,
            totalMin: walkRoute.out.totalDurationS / 60,
          },
          previewIn: {
            phase: walkRoute.in.phase,
            steps: walkRoute.in.steps,
            serverSteps: walkRoute.in.steps,
            totalDistM: walkRoute.in.stepsTotalM,
            totalMin: walkRoute.in.totalDurationS / 60,
          },
        }}
        detail={
          detailCard && to
            ? {
                card: detailCard.card,
                degraded: detailCard.degraded,
                destLabel: to.label,
                phase: ov.phase,
                body: ov.body,
                /* ★ v3.6.0 S4：观测钩子改用唯一车辆来源（`ov.vehicles` 已删除） */
                vehicles: ride.mapVehicles.length,
                reload: ov.reload,
                /** ★ v3.7.0（C5）：折叠栏「本站台其他线路」展开才查实时报站（首包省 ~3s） */
                foldState: ov.foldState,
                onLoadFold: ov.loadFold,
                /**
                 * ★ 2026-09-24：导航追踪态 + 可切换方案上下文。
                 * ★ T1：**步行段活跃时传 `null`** ——
                 *   ① 吸底操作条的 `NavTrackBar` 只认 `RidePhase`，步行中它会给
                 *      「开始导航 / 手动标记上车」这类与当前段无关的键（需求 6 点名的残留）；
                 *   ② 步行段的唯一出口是页面级「结束导航」按钮（见下方 `nav-walk-exit`），
                 *      不依赖面板，面板被拖到 peek 也不会丢。
                 * 乘车/候车段照旧传 `trackView`（`onStart/onStop` 已包成会话级）。
                 */
                track: walkActive ? null : trackView,
                destCoord: { lng: to.lng, lat: to.lat },
                onSwitchCard: openDetail,
                /**
                 * ★ 2026-11-03（需求 1）：**服务端重算的剩余行程**。
                 *   · `liveRemain` ⇒ 顶部总时长 / 到达时刻 / peek 摘要（①②⑧ 同源）；
                 *   · `liveStrips` ⇒ **整份替换**纵条（不上补丁）⇒ 与顶部同源，整屏一致；
                 *   · `reloadRemain` ⇒ 用户点刷新时随取一次（与车辆帧随取同一条通道）。
                 *   ⚠️ `liveStrips` 只替换纵条，`body.legs`（地图几何）一个字节都不动。
                 */
                liveRemain: navRemain.liveRemain,
                liveStrips: navRemain.liveStrips,
                liveRemainFail: navRemain.lastFail,
                /**
                 * ★ 修复批 #9 / #10（2026-11-06）：**点刷新 = 四条通道一起取**
                 *   （剩余行程 / 车辆帧 / 候车报站 / 赶车档重算 —— 见 `reloadRemain` 的块注释）。
                 *   改前这里只传 `navRemain.refresh`，而它在候车期（boarding）**不取数**
                 *   ⇒ QA 实测「点了刷新只有 detail-body + route-shapes 两个请求」，
                 *      屏上「还有 3 站 · 约 10 分」24 次采样恒定不变、地图 0 个车辆标。
                 *   现在由 `reloadRemain`（本文件）合流。
                 */
                reloadRemain,
              }
            : null
        }
        onOpenDetail={openDetail}
      />

      {/* ── 全屏搜索层 ── */}
      {stage === "search" && (
        <SearchSheet
          editing={editing}
          dest={to}
          from={from}
          userPos={userPos}
          colors={colors}
          quickPairs={quickPairs}
          onPick={pickPoint}
          onPickQuick={(f, t) => {
            setFrom(f);
            setTo(t);
            setStage("panel");
          }}
          onBack={backFromSearch}
          /**
           * ★ v3.6.1（fe-search 定稿契约）：
           * · `onOpenLine` 参数是右栏的 `RouteLineItem` 本体（`{code,kind,label,color}`），
           *   映射与兜底色都在 `SearchSheet.openLine` 内做完 ⇒ 这里直接传 `rv.pickLine` 引用；
           * · `lineOpen` **必须一起传**：为真时 SearchSheet `return null` 但**保持挂载**
           *   （`q`/`resp` 一个字节不丢），退出线路视图（`rv.exitLine`）后搜索词原样回来；
           * · ⚠️ **不要 `setStage`** —— `stage==="search"` 是 SearchSheet 的挂载条件，
           *   切走即卸载，AC-45「返回后搜索词还在」当场失效。
           */
          lineOpen={!!rv.picked}
          onOpenLine={rv.pickLine}
          /**
           * ★ 2026-11-05（通琴号 R7）：搜索结果里点一条班次 ⇒ 关搜索层 → 回地图看该班次。
           * `setStage("map")` 必须在 pick 之前：搜索层是 `stage==="search"` 的挂载条件，
           * 不切走它就一直盖着地图（与 `onOpenLine` 的 `lineOpen` 机制不同，
           * 通琴号没有"线路视图"这一层中间态，直接给最终形态）。
           */
          onOpenTqhTrip={(t) => {
            setStage("map");
            pickTqhTrip(t);
          }}
        />
      )}

      {/* ── 半屏起终点面板 ──
          ★ 2026-09-24：面板（RouteSheet）打开期间**整体隐藏**——否则它在 z55 持续渲染，
          推荐面板被拖到 peek 档（只占底部）时，会从面板后方露出（用户实测反馈）。 */}
      {stage === "panel" && !rsOpen && (
        <RoutePanel
          dest={to}
          from={from}
          /**
           * ★ T8（P0）：传 **`myPos`** 而不是 `userPos`。
           *   `RoutePanel` 用这个 prop 自建「我的位置」行（`RoutePanel.tsx:59-61`）——
           *   传 `userPos` 时高德定位没回来就恒为 null ⇒ 行显示「选择出发地」，
           *   即使 `canGo` 已被修好，用户看到的仍是"起点没定"。
           */
          userPos={myPos}
          canGo={canGo}
          going={false}
          query={resultQuery}
          onGo={go}
          onTapFrom={() => openSearch("from")}
          onTapDest={() => openSearch("dest")}
        />
      )}

      {/* ★ v3.3.0（AC-93 · ADR-102）：`?diag=pin` 起终点钉诊断浮层 —— **生产默认不渲染** */}
      {diagPin && <PinDiag />}
    </section>
    </BoardingLiveContext.Provider>
    </CatchTagLatchContext.Provider>
  );
}

/** 站点 → NavPoint（`kind='station'`，label 带站码，与 POI 搜索口径一致） */
function stationToNavPoint(s: StationCardStation): NavPoint {
  return { kind: "station", label: `${s.code} ${s.name}`.trim(), lng: s.lng, lat: s.lat, code: s.code };
}

/**
 * ★ M4：公厕 → 导航端点。
 * `kind: "place"` + **GCJ-02** 坐标（`PublicToilet.lat/lng` 已是换算后的展示坐标，
 * 再调 `wgs84ToGcj02()` 会偏 ~600m）。标签用「公共厕所-繁體名」，与弹窗标题同口径。
 */
function toiletToNavPoint(t: PublicToilet): NavPoint {
  return { kind: "place", label: `公共厕所-${t.nameTc}`, lng: t.lng as number, lat: t.lat as number };
}
