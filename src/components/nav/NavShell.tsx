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

/** 稳定的空 steps 引用（避免每次渲染新建数组 ⇒ 触发 hook 内部 effect 重跑） */
const EMPTY_WALK_STEPS: WalkStep[] = [];
/** 顶部跟随横幅高度（px）—— 与 `--walkturn-h` 同值，取景中带计算用（改多行须同步上调） */
const WALKTURN_H = 64;
import RouteLinesSheet from "./RouteLinesSheet";
import RoutePanel from "./RoutePanel";
import RouteSheet from "./RouteSheet";
import SearchSheet, { type QuickPair } from "./SearchSheet";
import StationCard, { type StationCardStation } from "./StationCard";
import VehicleCard from "./VehicleCard";
import { queryOf } from "./StepSheet";
import { useRouteVehicles } from "./useRouteVehicles";
import { useRouteOverview } from "./useRouteOverview";
import { useRideTracking, type RidePhase, type RideTrackView } from "./useRideTracking";
import { useUserFix } from "./useUserFix";
import { useNavFrame } from "./useNavFrame";
/* ★ 步行路径重算的防连点冷却（现成常量，勿新写数字） */
import { COOLDOWN_WALK_SEC, useCooldown } from "./useCooldown";
import { detentIndex, detentTopsPx, readSafeTopPx, type Detent } from "./sheet-detents";
import { unionBox } from "@/lib/nav/route-overview";
import { mainOf } from "@/lib/nav/track";
import { useCombos } from "@/lib/favorites/useCombos";
import { endpointOf } from "@/lib/favorites/types";
import type { RecommendCard } from "@/lib/recommend/types";
import type { NavPoint } from "@/lib/nav/types";

const MY_LOCATION = "我的位置";
/**
 * 「从 `/line` 返回时重开搜索层」的一次性标记（与 `SearchSheet.SS_RETURN` **同一个 key**）。
 * 只有一个消费点：下面 `stage` 的 `useState` 初始化函数（读到即删）。
 */
const SS_SEARCH_RETURN = "mmap.search.return";
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
}

export default function NavShell({
  jsKey,
  mapStyleId = "",
  colors = {},
  initialFrom = null,
  initialTo = null,
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
  const [lineSheet, setLineSheet] = useState(false);
  const rv = useRouteVehicles();
  const favs = useCombos();

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
   * ★ v3.2.0（需求 4/7 / AC-74/79）：GPS 通道 —— **`enabled` 扩到「地图页常开」**（浏览/选点/选路线/导航
   *   全程只要有定位就显示蓝点）；采纳间隔按档位：riding **1.5s** / 候车（detail 非 riding）**3s** / 浏览 **10s**；
   *   `maximumAge: 0` ⇒ 只用新鲜坐标（避免陈旧点导致蓝点/读数跳变）。
   */
  const gpsIntervalMs = ridePhase === "riding" ? 1_500 : navActive ? 3_000 : 10_000;
  /**
   * ★ v3.7.0 S2（#11 / S2「候车期粗定位」）：`coarse` **只在候车期**开 ——
   *   候车时允许复用 30s 内的系统缓存坐标（出点快、省电）；**乘车期必须 `false`**
   *   （riding 要新鲜高精度坐标，否则蓝点/报站读数会跳）。浏览态维持既有 `maximumAge: 0`。
   */
  const userFixR = useUserFix({
    enabled: true,
    intervalMs: gpsIntervalMs,
    maximumAge: 0,
    coarse: navActive && ridePhase !== "riding",
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
   *   声明位置**必须早于** `useRideTracking` —— 乘车引擎要拿 `walkActive` 做互斥门控
   *   （步行中禁止自动上车），否则两个引擎会同时跑（旧版注释声称互斥，实际没有入参）。
   */
  const [walkSeg, setWalkSeg] = useState<"out" | "in" | null>(null);
  /** 步行段活跃（与乘车互斥；下传 `useRideTracking` 做真实门控） */
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
    /** ★ T1：步行活跃 ⇒ 引擎内 `tryAuto` 早退（真互斥，不是靠调用方不渲染） */
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
       ② 走到上车站（`walkFollow.phase==="arrived"`）⇒ 交出步行段 ⇒ 乘车引擎放开自动上车；
       ③ 最后一程下车（`ride.phase==="done"`）⇒ 自动进入步行到达段；
       ④ 到达目的地 ⇒ 横幅转「已到达」，由「结束导航」收尾。
     **互斥落地**：`walkActive` 下传 `useRideTracking`（引擎内 `tryAuto` 早退），
       不再只靠注释说"步行中禁止自动上车"。
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
  }, []);

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
   *   末段步行（`"in"`）是 `ride.phase === "done"` 之后才由 `:697` 进入的，
   *   与 riding 不可能并存；无条件清 null 反而会误杀。
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
   *   · 乘车引擎在 `walkActive` 期间**不会自动上车**（`useRideTracking.tryAuto` 早退）。
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
      if (seg === "out" && ridePhaseNow === "off") rideStart();
      walkRoute.ensure(seg);
      setWalkSeg(seg);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ridePhaseNow, rideStart, walkRoute.ensure, userPos, from, originAnchor],
  );

  /** ★ T1：真出口 —— 结束导航（同时收步行段与乘车引擎） */
  const endSession = useCallback(() => {
    endWalk();
    rideStop();
  }, [endWalk, rideStop]);

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

  /** ① 走到上车站 ⇒ 交出步行段（互斥解除 ⇒ 自动上车立刻恢复） */
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
   *   否则 `walkActive` 恒 true，`tryAuto` 永久早退 ⇒ 用户既看不到横幅也不能自动上车（死锁）。
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
         *   写入侧已做互斥（`walkActive` 下 `tryAuto` 早退 + 步行段 `track` 传 `null`），
         *   但**自动上车是异步触发**，仍存在「riding 已开始、walkSeg 尚未清」的帧窗口 ——
         *   那一帧若判 `walk`，整页会按步行态渲染（底导隐藏、横幅压住），表现就是
         *   「车都开了还让我走去车站」。这道显示层门是写入侧互斥**替代不了**的。
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
     *   不收的话 `walkActive` 会带进新卡的乘车引擎 ⇒ 自动上车被判互斥永久挡住。
     */
    endWalk();
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
       */
      endWalk();
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
    setStation(s);
    if (rsOpenRef.current && !navActiveRef.current) {
      setRsOpen(false);
      setStage("map");
    }
  }, []);
  const onMapClick = useCallback(() => setStation(null), []);

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
   */
  const trackView: RideTrackView = useMemo(
    () => ({ ...ride, onStart: () => startSession("out"), onStop: endSession }),
    [ride, startSession, endSession],
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
      label: leg.kind === "lrt" ? `轻轨 ${leg.route.replace(/^LRT-/, "")}` : `${leg.route} 路`,
      color: colors[leg.route],
      // ★ v3.7.0 S2（D5）：车辆卡上的「数据时间」只能取**车辆帧**时刻
      fetchedAt: ride.lastVehicleTs > 0 ? new Date(ride.lastVehicleTs).toISOString() : null,
    };
  }, [detailActive, detailCard, ride.legIndex, ride.lastVehicleTs, colors]);

  return (
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
          /* ★ v2.10.0：路线查看模式 + 实时车辆；★ 2026-09-23：detail pane 打开时让位给总览 */
          routeLine={detailActive ? null : rv.picked}
          onRouteDirs={rv.reportDirs}
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

      {/* ★ 卡片浮层（车卡/站卡）—— 挂在 wrap **之外**，`.nav-card-overlay`（fixed z90）
          ⇒ 面板打开时点地图带上的车/站，卡片不被面板（z70）压住。 */}
      {(station || rv.selected) && (
        <div className="nav-card-overlay">
          {station && (
            <StationCard
              station={station}
              colors={colors}
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
          onClose={() => setLineSheet(false)}
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
  );
}

/** 站点 → NavPoint（`kind='station'`，label 带站码，与 POI 搜索口径一致） */
function stationToNavPoint(s: StationCardStation): NavPoint {
  return { kind: "station", label: `${s.code} ${s.name}`.trim(), lng: s.lng, lat: s.lat, code: s.code };
}
