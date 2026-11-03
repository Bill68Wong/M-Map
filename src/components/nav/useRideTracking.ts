"use client";

/**
 * 乘车追踪数据流（src/components/nav/useRideTracking.ts，v2.14 · 2026-09-25 重修）
 *
 * ── 状态机（全自动上车 + 安全网）─────────────────────────────────────
 *   ```
 *   off ──「开始导航」──▶ boarding ──〔自动：R1/R2/轻轨R2〕──▶ riding ──〔自动/手动 下车〕──▶
 *         （车人分离）        （锁定车辆+12s 轮询 | GPS 驱动）   ├─ 还有下一程 ⇒ 回 boarding
 *                                                               └─ 最后一程 ⇒ done
 *   纠错入口（riding 常驻）：我没上车（回 boarding）· 不是这辆（换车）· 我已下车（推进）
 *   ```
 *   · 车辆通道（权威）：12s 轮询 `/api/route-vehicles` → 进度 / 已驶过切割 / 提醒（有车牌）；
 *   · GPS 通道（新增 `userFix`）：上车判定 R2、地图蓝点、轻轨段 GPS 推算推进；
 *   · **对不上就冻结**（丢信号 / 站序对不上 ⇒ 冻结上次进度 + 提示，绝不乱跳）。
 *
 * 判据与安全网抽到 `lib/nav/boarding-detect.ts`；轻轨推进抽到 `lib/nav/lrt-progress.ts`（纯函数、可单测）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  anchorOf,
  cutAt,
  mainOf,
  monotonicCut,
  progressOf,
  rankBoardingVehicles,
  type BoardAnchor,
  type MonoCutState,
  type TrackProgress,
  type TrackVehicle,
} from "@/lib/nav/track";
import { advanceLrt, buildLrtLadder, type LrtLadder } from "@/lib/nav/lrt-progress";import { nearestOnPath } from "@/lib/nav/route-overview";
import { autoAlightOf } from "@/lib/nav/alight-detect";
import {
  ANOMALY_CONFIRM,
  ANOMALY_MIN_GAP_MS,
  autoBoardOf,
  anomalyOf,
  detectPausedOf,
  nextLegCooldownOf,
  type Anomaly,
  type FixLite,
} from "@/lib/nav/boarding-detect";
import type { LL, ColoredLeg, OverviewLegInput } from "@/lib/nav/route-overview";
import type { RecommendCard, SegmentStrip } from "@/lib/recommend/types";
import { COOLDOWN_VEHICLE_SEC, useCooldown } from "./useCooldown";
import type { VehicleLite } from "./VehicleMarker";
import type { UserFix } from "./useUserFix";
import { noteVehFail, noteVehFrame, retainVehTicker } from "./observe-hooks";
import { useResumeRefresh } from "./useResumeRefresh";
import { createVehicleMatcher, usableMedium } from "./vehicle-match-run";
import { MATCH_VEHICLE_ENABLED } from "@/lib/nav/match-vehicle";
import type { GeoState } from "./observe-hooks";
import { noteOfPausedGeo } from "./geo-note";

/** 轮询间隔（毫秒）——与官网地图 15s 刷新同量级 */
const POLL_MS = 12_000;
/** 连续丢信号判定（次）——达到即提示（进度保持冻结） */
const MISS_LIMIT = 3;
/** GPS 采样窗口保留时长（ms） */
const FIX_KEEP_MS = 90_000;
/**
 * ★ 本批：蓝点吸附到线路投影的最大距离（米）——对不上就冻结（Token `--you-snap-max`）
 * ⚠️ 该 CSS Token（`globals.css:7010`）**未接线**，改它不生效；值以此常量为准。
 */
const YOU_SNAP_MAX_M = 60;
/** ★ 本批：蓝点精度门（米）——超过视为不可信 ⇒ 冻结 */
const YOU_ACC_MAX_M = 150;
/** ★ 本批：自动下车瞬态反馈停留时长（ms） */
const JUST_ALIGHTED_MS = 5_000;
/**
 * ★ T3：已驶过灰线的**出线门槛**（两者同时满足才画）。
 *   · `MIN_TRAVELED_IDX = 2` ⇒ 至少 2 条完整线段（否则是蓝点旁的一小撇）；
 *   · `MIN_TRAVELED_M = 40`  ⇒ 累计 ≥40m（澳门市区两个站点间距约 150~300m，40m 约等于驶离上车站）。
 */
const MIN_TRAVELED_IDX = 2;
const MIN_TRAVELED_M = 40;

/* ── 文案（去 AI 化；06 §4 最终文案表）── */
const NOTE_NO_PROGRESS = "这段暂时看不到实时进度，请对照站名，快到了自己下车";
const NOTE_FROZEN_BUS = "暂时收不到这辆车的信号 · 位置停在上一站，恢复后会自动跟上";
const NOTE_NO_VEHICLES = "这条线现在查不到车 · 稍后再试，或直接点「我已上车」";
const NOTE_NO_VEHICLES_BOARD = "这条线现在查不到车 · 稍后再试，或直接点「我已上车」自己开始";
const NOTE_LRT_WEAK = "暂时收不到信号 · 位置停在上一站";
const NOTE_FETCH_FAIL = "车辆数据获取失败，稍后自动重试";
/**
 * ★ v3.6.0（AC-25a）：判定**事实上已停止**时的文案。
 *   为什么不能继续写「正在检测车辆」：GPS 拒权/长时间无帧时系统已不再判定，
 *   界面若仍说"正在检测"，用户会以为"车还没来"，实际是"我不看了"。
 */
/**
 * ★ v3.7.0 S2（AC2.3）：定位文案全部抽到 `geo-note.ts`（纯函数、可单测、过文案门禁）。
 *   `NOTE_GPS_UNAVAILABLE` 的「ok 兜底」分支也已在那里，本文件只调 `noteOfPausedGeo(geo)`。
 */

/**
 * ★ v3.7.0 S3：本轮车牌是怎么来的（观测钩子 `.nav-actions[data-board-match]` 的取值源）。
 *   `none`      = 还没锁上（或已退回等车态）；
 *   `auto`      = 系统自动锁定（**含**高置信与中置信两种，后者另由 `data-match-pending="1"` 区分）；
 *   `confirmed` = **用户确认**过某辆车 —— 当前**没有**这个界面，故该值不会出现；
 *   `corrected` = 用户点「不是这辆」后重锁；
 *   `manual`    = 用户手动标记上车 / 手动选车。
 *
 * ⚠️ 中置信**不得**占用 `confirmed`（team-lead 裁决）：`confirmed` 若同时代表
 *   「系统不确定（需纠错）」与「用户已确认（无需纠错）」，两件**语义相反**的事共用一个值，
 *   验收与排障都再分不开。故中置信 = `auto` + 独立属性 `data-match-pending="1"`。
 *   将来落地 Q5 轻确认时，`confirmed` 才被真正使用，两者永不打架。
 */
export type BoardMatch = "none" | "auto" | "confirmed" | "corrected" | "manual";
/** ★ v3.7.0 S3：匹配来源（常态；与 `BoardMatch` 事件语义正交，故必须是两个独立属性） */
export type MatchSource = "gps" | "gps+vehicle" | "vehicle" | "manual";

export type RidePhase = "off" | "boarding" | "riding" | "done";

/** ★ v3.4.0（进度模型）：本段「位置感知剩余」——服务端 progress 与客户端时间项融合后的结果 */
export interface RideSegProgress {
  segFrom: string;
  segTo: string;
  /** 区间内相对进度 0-1 */
  p: number;
  /** 融合后的本段剩余（秒）：w·D + (1−w)·max(md − u, 0) */
  segRemainSec: number;
}

/** ★ 本批（需求⑤）：地图蓝点（视觉层 = GPS 投影；`frozen` = 冻结不跳） */
export interface RideYouDot {
  lng: number;
  lat: number;
  src: "gps";
  /** 冻结（投影失败 / 精度差 / 无信号）——保留上次好点，不跳 */
  frozen: boolean;
  ts: number;
  /** 水平精度（米；投影点沿用最近一帧 GPS，供 `UserDotLayer` 复用 `UserFix` 形状） */
  accuracy: number;
}
/**
 * ★ 本批（需求⑤）：纵条用户点。
 * ★ v3.2.0（需求 6 / AC-78）：改为**事件驱动二值 + 驻留** —— `frac` 只有 `0`（停靠：贴 `afterIdx` 站）
 *   与 `0.5`（行驶中：锁 `afterIdx → afterIdx+1` **两站正中间**，不随进度微动）。移除连续插值。
 */
export interface RideYouAt {
  afterIdx: number;
  frac: number;
}

export interface RideTrackView {
  phase: RidePhase;
  legIndex: number;
  plate: string | null;
  prog: TrackProgress | null;
  alarm: "none" | "soon" | "now";
  traveled: LL[] | null;
  traveling: boolean;
  /**
   * ★ v3.6.0（AC-25a）：自动上车判定的**实际**状态。
   *   `on` = 有可信定位、判定进行中；`paused` = 拒权/超时/连续低精度 ⇒ **已停止判定**。
   *   只驱动文案与钩子（`.nav-actions[data-board-detect]`），不影响地图蓝点。
   */
  boardDetect: "on" | "paused";
  /**
   * ★ v3.6.0 S4：车辆刷新冷却剩余秒数（0 = 可刷新）。
   *   来源 = `useCooldown`（时间戳口径，5s）。**仅作用于车辆数据刷新**，
   *   不影响定位刷新 / 步行进度推进 / 步行路径重算。
   */
  refreshCoolingSec: number;
  note: string;
  candidates: { plate: string; hint: string }[];
  /** 本次 riding 是否由自动判定进入 */
  autoSwitched: boolean;
  /** 轻反馈文案（「已开始跟踪 51 路 · 车牌」/ 轻轨「已开始跟踪行程（线名）」） */
  autoNote: string;
  /** 进度来源（车辆 / GPS 驱动）——供来源标注与站条 */
  progressSource: "vehicle" | "gps";
  /**
   * ★ v3.7.0 S3（`data-board-match`）：车牌是怎么锁上的（**事件语义**，跃迁时可断言）。
   *   中置信也是 `auto`，另由 `matchPending`（`data-match-pending`）区分 —— 见 `BoardMatch` 注释。
   */
  boardMatch: BoardMatch;
  /**
   * ★ v3.7.0 S3（`data-match-source`）：匹配来源（**常态语义**）。
   *   与 `boardMatch` 是两个独立属性 —— 测试要求在「`none→auto` 跃迁瞬间」读本值，
   *   此刻必须是 `gps`/`gps+vehicle`；跃迁之后读到 `vehicle` 属正常后置状态。
   */
  matchSource: MatchSource;
  /**
   * ★ v3.7.0 S3（`data-match-pending`）：**中置信**（证据不足、只标注不据此报站）。
   *   与 `boardMatch="auto"` 配对使用；`confirmed` 留给将来的「用户确认」，不重载。
   */
  matchPending: boolean;
  /**
   * ★ v3.7.0 S3：中置信匹配出的车牌 —— 只展示（「车牌待确认」）。
   *   语义红线：此时 `plate` 仍为 `null` ⇒ `progressSource` 是 `gps`，报站读数**不**由它推出。
   */
  pendingPlate: string | null;
  /** 安全网检出 */
  anomaly: "none" | "not_boarded" | "alighted";
  /**
   * ★ v3.7.0 S2（D5 修复）：上次**车辆数据**帧时刻（ms）—— 新鲜度只认这一个。
   *
   * 旧字段 `lastUpdateTs` 被「车辆帧」与「GPS 帧」**双双写入**（`fetchFrame` 与 GPS effect），
   * 而读取方（`RouteSheet` 的「上次更新：N 秒前」）把它当车辆新鲜度用 ⇒ 车辆接口连续失败
   * 但 GPS 正常时，界面永远显示 0~3 秒（车辆坐标其实已 3 分钟没更新）。
   * 现在拆成两个字段并**删除旧名**（让 tsc 强制暴露所有读取点）：
   *   · `lastVehicleTs` —— **只有** `fetchFrame` 成功时写（`0` = 本次会话还没拿到过车辆帧）；
   *   · `lastFixTs`     —— **只有**用户定位帧采纳时写。
   * ⚠️ 任何「数据多久没更新」的 UI 只能读 `lastVehicleTs`。
   */
  lastVehicleTs: number;
  /** ★ v3.7.0 S2：上次**用户定位**帧时刻（ms）——「定位多久没动」只能读这个 */
  lastFixTs: number;
  /** ★ 本批：地图蓝点（riding 用投影点；非 riding = null ⇒ 宿主回落原始 GPS） */
  youDot: RideYouDot | null;
  /** ★ 本批：纵条段内插值用户点 */
  youAt: RideYouAt | null;
  /** ★ 本批：当前在显车辆（riding 按 plate 过滤 → 0/1 辆；AC-45/46） */
  mapVehicles: VehicleLite[];
  /** ★ v3.4.0（进度模型）：本段位置感知剩余（riding 且有 progress 时非空；否则 NavDetailBody 用逐跳兜底） */
  segProgress: RideSegProgress | null;
  /** ★ 本批：自动下车瞬态（`data-track-state='alighted'` 窗口） */
  justAlighted: boolean;
  onStart: () => void;
  onStop: () => void;
  onBoard: () => void;
  onRepick: (plate: string) => void;
  onAlight: () => void;
  onRefresh: () => void;
  onNotBoard: () => void;
  onNotArrive: () => void;
  onNotThisBus: () => void;
  onDismissAnomaly: () => void;
  /** ★ 本批：撤销自动下车（仅最后一次自动下车可撤销；AC-56） */
  onUndoAlight: () => void;
}

export interface UseRideTrackingOpts {
  card: RecommendCard | null;
  legs: ColoredLeg[];
  anchors: OverviewLegInput[] | null;
  strips: SegmentStrip[] | null;
  active: boolean;
  /**
   * ★ 一条导航流（T1）：**当前正在步行**（首段走站 / 末段走到目的地）。
   *
   * 与 `riding` **互斥**：步行活跃期间**不得自动上车**（`tryAuto` 直接返回）。
   * 为什么必须下传而不是靠调用方不渲染：自动上车由 12s 车辆轮询 + GPS 帧两个 effect 触发，
   * 调用方拦不住「已经在跑的定时器」—— 只有引擎内部早退才是真互斥
   * （旧版页面注释写着"步行中禁止 ride 自动上车"，但引擎根本没有这个入参）。
   * 手动「手动标记上车」不受影响（那是用户显式意图）。
   */
  walkActive?: boolean;
  /** ★ 新增：用户定位（GCJ-02；由 useUserFix 提供，只读） */
  userFix?: UserFix | null;
  /** ★ 新增：在用户手势内申请 GPS（useUserFix.start；开始导航 / 手动上车时调用） */
  onRequestGps?: () => void;
  /**
   * ★ v3.7.0 S2（AC2.3）：定位轴状态（`useUserFix` 的 `geo`）。
   *
   * 只用一处：候车态「判定已暂停」时**按它选文案** —— 拒权/无信号/超时三种情况
   * 用户要做的动作完全不同（去设置 / 走两步 / 再等），一句「定位不可用」说不清。
   * ⚠️ 它**不参与**任何判定逻辑（上车判定仍只看 `fixes`），只是文案分档的依据。
   */
  geo?: GeoState;
  /**
   * ★ v3.7.0 S3：**车辆匹配开关的调用侧覆盖**（缺省 = `MATCH_VEHICLE_ENABLED`，现为 `false`）。
   *
   * 为什么要有这个口子：总开关是**编译期常量**，真机灰度要验证「匹配是否真的锁对车」时
   * 不该改动库里的常量（那会让线上与测试环境的差异无从追溯）。这里留一个可传参的入口，
   * 灰度期由宿主（`NavShell`）传 `true`、验证完删掉那一行即可 —— 行为改动**在 diff 里可见**。
   * ⚠️ 关闭时（缺省）本引擎**一次都不判、也不多发请求**，行为与改前完全一致。
   */
  matchEnabled?: boolean;
}

function hintOf(v: TrackVehicle): string {
  if (v.atStation?.code) return `${v.atStation.code} 停靠中`;
  if (v.interval?.from?.code) return `${v.interval.from.code} → ${v.interval.to?.code ?? "?"}`;
  return "";
}

/**
 * ★ T7：已驶过灰线的**可观测钩子**（QA 用 `body[data-traveled]` 断言状态）。
 * 取值：`none | ok | frozen:bad-snap | frozen:backward | frozen:too-fast | frozen:shrink`。
 * ⚠️ 不复用 `data-walk-*`（那是步行三线，语义不同）。
 *
 * 另两个**诊断**属性（**不进 `data-traveled`**，否则状态枚举断言会变脆）：
 *   · `data-traveled-ver` = `perp:<真垂距>,<到最近顶点距离>` —— 横向判定实际用的度量 +
 *     量化高估值，供 QA 直接对比顶点量化误差；
 *   · `data-traveled-cut` = `<projIdx>,<projLenM>` —— **仅拒帧时写**，表示本帧投影
 *     「本来会落到哪」。拒帧时 `traveled` 返回的是 `prev`，没有它就分不清
 *     「定位真偏了」还是「算法判错了」。单位米、1 位小数；**accept 时移除**。
 */
function setTraveledAttr(
  v: string | null,
  diag?: { verPerp: number; verVertex: number; projIdx: number; projLenM: number },
  cut?: { idx: number; lenM: number } | null,
) {
  if (typeof document === "undefined") return;
  try {
    if (v == null) {
      document.body.removeAttribute("data-traveled");
      document.body.removeAttribute("data-traveled-ver");
      document.body.removeAttribute("data-traveled-cut");
      return;
    }
    document.body.setAttribute("data-traveled", v);
    if (diag) {
      document.body.setAttribute(
        "data-traveled-ver",
        `perp:${diag.verPerp.toFixed(1)},${diag.verVertex.toFixed(1)}`,
      );
    }
    // 只在拒帧传 `cut` ⇒ accept 时该属性被移除（避免每帧多一次 DOM 写入）
    if (cut) {
      document.body.setAttribute("data-traveled-cut", `${cut.idx},${cut.lenM.toFixed(1)}`);
    } else {
      document.body.removeAttribute("data-traveled-cut");
    }
  } catch {
    /* SSR / 只读 body —— 观测钩子失败不得影响导航 */
  }
}

export function useRideTracking(opts: UseRideTrackingOpts): RideTrackView {
  const {
    card,
    legs,
    anchors,
    strips,
    active,
    walkActive = false,
    userFix = null,
    onRequestGps,
    geo,
    matchEnabled = MATCH_VEHICLE_ENABLED,
  } = opts;
  /**
   * 匹配开关的**最新值镜像**：`fetchFrame` / 轮询 effect 都是长跑闭包，
   * 把开关塞进依赖会重建定时器（与 `walkActive` 同一类问题）⇒ 用 ref 保证「立刻生效且不抖动」。
   */
  const matchOnRef = useRef(matchEnabled);
  matchOnRef.current = matchEnabled;
  /**
   * ★ 一条导航流（T1）：步行活跃的**最新值镜像**。
   *   自动上车的两个触发源（12s 轮询 effect / GPS 帧 effect）都是长跑定时器，
   *   若把 `walkActive` 塞进它们的依赖，会在步行↔乘车切换时把定时器重建一遍；
   *   ref 镜像既保证「立刻生效」（下一帧读到新值），又不打断轮询。
   */
  const walkActiveRef = useRef(walkActive);
  walkActiveRef.current = walkActive;

  const [phase, setPhase] = useState<RidePhase>("off");
  const [legIndex, setLegIndex] = useState(0);
  const [plate, setPlate] = useState<string | null>(null);
  const [prog, setProg] = useState<TrackProgress | null>(null);
  const [alarm, setAlarm] = useState<"none" | "soon" | "now">("none");
  const [traveled, setTraveled] = useState<LL[] | null>(null);
  /**
   * ★ T7：灰线的**单调游标**（跨帧记忆；`null` = 本段首帧 / 刚被清空）。
   *   ⚠️ 拒帧时**不更新** ⇒ `elapsed` 持续累积，too-fast 才会自然解除、60s 后才会放行回退。
   */
  const traveledCurRef = useRef<MonoCutState | null>(null);
  /** 灰线是否**已经上屏**（决定 `data-traveled` 是 `ok/frozen:*` 还是 `none`） */
  const traveledShownRef = useRef(false);
  const [traveling, setTraveling] = useState(false);
  const [note, setNote] = useState("");
  const [candidates, setCandidates] = useState<{ plate: string; hint: string }[]>([]);
  const [autoSwitched, setAutoSwitched] = useState(false);
  const [autoNote, setAutoNote] = useState("");
  const [progressSource, setProgressSource] = useState<"vehicle" | "gps">("vehicle");
  const [anomaly, setAnomaly] = useState<Anomaly>("none");
  /**
   * ★ v3.7.0 S2：**两个独立的新鲜度时间戳**（D5）——
   *   `lastVehicleTs` 只有车辆帧写入、`lastFixTs` 只有定位帧写入。禁止合并回一个。
   */
  const [lastVehicleTs, setLastVehicleTs] = useState(0);
  const [lastFixTs, setLastFixTs] = useState(0);
  /**
   * ★ v3.7.0 S3：匹配态（`data-board-match` / `data-match-source` / 「车牌待确认」）。
   *   三者在 `switchToRiding` / `repick` / `onNotBoard` / 匹配命中处同步写入。
   */
  const [boardMatch, setBoardMatch] = useState<BoardMatch>("none");
  const [matchSource, setMatchSource] = useState<MatchSource>("gps");
  /** ★ 中置信：`boardMatch="auto"` + 本标记（不占用 `confirmed`，见 `BoardMatch` 注释） */
  const [matchPending, setMatchPending] = useState(false);
  const [pendingPlate, setPendingPlate] = useState<string | null>(null);
  /**
   * ★ v3.7.0 S3：车辆匹配器的跨帧状态（用户里程环 / 车牌→里程环 / 排除名单）。
   *   `useRef` + 惰性创建 ⇒ 不参与渲染，纯 12s 一次的计算。
   */
  const matcherRef = useRef<ReturnType<typeof createVehicleMatcher> | null>(null);
  if (matcherRef.current === null) matcherRef.current = createVehicleMatcher();
  /** ★ 本批：车辆帧序号（`mapVehicles` 随 12s 帧重算，AC-46） */
  const [listTick, setListTick] = useState(0);
  /** ★ 本批：站点里程阶梯版本（ladder 就绪后触发 `youAt` 重算） */
  const [ladderTick, setLadderTick] = useState(0);
  /** ★ 本批：自动下车瞬态（≤5s；`data-track-state='alighted'`） */
  const [justAlighted, setJustAlighted] = useState(false);
  /** ★ 本批：蓝点 / 纵条用户点 */
  const [youDot, setYouDot] = useState<RideYouDot | null>(null);
  const [youAt, setYouAt] = useState<RideYouAt | null>(null);
  /** ★ v3.4.0（进度模型）：本段位置感知剩余（帧驱动更新；riding 外恒 null） */
  const [segProgress, setSegProgress] = useState<RideSegProgress | null>(null);
  /** 本区间「首见」记录（u 的基准）——区间变化时重置；u0 用位置模型反推（中途打开也成立） */
  const segSeenRef = useRef<{ segKey: string; u0Sec: number; ts: number } | null>(null);

  const vehicleRef = useRef<TrackVehicle | null>(null);
  const missRef = useRef(0);
  const alarmRef = useRef<"none" | "soon" | "now">("none");
  const lockRef = useRef<{ release: () => Promise<void> } | null>(null);
  /** 本帧原始车辆（R1 判定 + 换车用） */
  const listRef = useRef<TrackVehicle[]>([]);
  /**
   * ★ T6：本帧原始车辆（**接口原样**，含站名 / `isLast` / `status`）—— 仅供 UI（地图图标 + 车辆卡）。
   *   与 `listRef`（逻辑用的瘦身结构）并存：位置判定只用 code，展示要 name，两者用途不同，别合并。
   */
  const listLiteRef = useRef<VehicleLite[]>([]);
  /**
   * ★ 候车「锚定车」（本段本次候车有效）：首次排名第一的那辆。
   *   用途：过站过滤的几何判据基准（`passedBoardOf` 需知道"锚定时它离上车站多近"），
   *   否则"距离变大"无法与"本来就在远处"区分。换腿 / 进入 riding / reset 时清空。
   */
  const anchorRef = useRef<BoardAnchor | null>(null);
  /** 最近 GPS 采样（R2 / 安全网用） */
  const fixesRef = useRef<FixLite[]>([]);
  /** 自动判定状态（冷却 / 单次） */
  const lastSwitchTsRef = useRef(0);
  const autoUsedRef = useRef(false);
  /** 轻轨 / GPS 推进状态 */
  const ladderRef = useRef<LrtLadder | null>(null);
  const lrtStateRef = useRef({ passedIdx: -1, computed: -1, dist: 0, ts: 0, badStreak: 0 });
  const stationMapRef = useRef<Map<string, { lng: number; lat: number }> | null>(null);
  /** 安全网确认累计 */
  const anomalyStreakRef = useRef(0);
  const lastAnomalyTsRef = useRef(0);
  /** 进入 riding 时的起点（判定「已推进 ≥1 站」） */
  const ridingStartIdxRef = useRef(-1);
  /** ★ 本批：最近一次「好蓝点」（投影失败 / 无信号 ⇒ 冻结不跳） */
  const lastGoodDotRef = useRef<RideYouDot | null>(null);
  /** ★ 本批：自动下车连续命中帧数 */
  const alightStreakRef = useRef(0);
  /** ★ 本批：自动上车连续命中帧数（多帧确认） */
  const boardStreakRef = useRef(0);
  /**
   * ★ v3.6.0（AC-25a）：自动判定是否已「事实上停止」。
   *   只影响**自动判定与文案**；地图蓝点走 `youDot` 自己的冻结逻辑，两者不合并。
   */
  const [boardPaused, setBoardPaused] = useState(false);
  /**
   * ★ v3.6.0：进入候车态的时刻 —— 供 `detectPausedOf` 的启动宽限用
   *   （避免"第一帧还没到"被误报成"定位不可用"）。
   */
  const boardingStartedAtRef = useRef<number | null>(null);
  /** ★ 本批：自动下车瞬态计时器 */
  const justAlightedTimerRef = useRef<number | null>(null);
  /** ★ 本批：自动下车撤销快照（仅最后一次自动下车可撤销） */
  const undoRef = useRef<{
    legIndex: number;
    phase: RidePhase;
    plate: string | null;
    prog: TrackProgress | null;
    traveled: LL[] | null;
    candidates: { plate: string; hint: string }[];
    progressSource: "vehicle" | "gps";
    ladder: LrtLadder | null;
    lrtState: { passedIdx: number; computed: number; dist: number; ts: number; badStreak: number };
  } | null>(null);
  /** ★ 本批：车辆帧顶层运营商（供 mapVehicles 涂装色） */
  const lastCompanyRef = useRef<string | null>(null);

  const stopMains = useMemo(() => {
    const s = strips?.[legIndex];
    return s ? s.stops.map((k) => mainOf(k.code)) : [];
  }, [strips, legIndex]);

  const boardAnchor = anchors?.[legIndex]?.board ?? null;
  const boardPos = useMemo(
    () => (boardAnchor ? { lng: boardAnchor.lng, lat: boardAnchor.lat } : null),
    [boardAnchor],
  );

  /**
   * ★ 在显车辆（`NavMap` 的 `vehicles` prop）。
   *
   * · `riding` + 有车牌 ⇒ 只显**当前这一辆**（AC-45/46：不干扰判断"我坐的车在哪"）；
   * · `boarding` ⇒ 显**本帧全部候选车**（★ v3.6.0 S4 新增）——
   *   否则候车态地图上的车只在开场拉一次、之后永远不动，
   *   「刷新」只更新下方列表，用户看到的是静止的车（最容易被当成"刷新没反应"）；
   * · 其他相位 ⇒ `[]`。
   *
   * 随 12s 帧（`listTick`）重算 ⇒ `VehicleLayer` 重定位（不是只拉一次）。
   *
   * ★ T6：**直接复用接口原样的 `VehicleLite`**（`listLiteRef`），不再从 `TrackVehicle` 反造。
   *   旧实现 `toLite()` 把 `interval.from.name` / `atStation.name` 写成 `""`、`isLast` 也没映射
   *   ⇒ 导航态点车辆后卡片只有站号没有站名、末班标记丢失（点击链路本来是通的，断在数据）。
   *   运营商涂装色仍是帧顶层字段（`lastCompanyRef`），注入方式不变。
   */
  const mapVehicles = useMemo<VehicleLite[]>(() => {
    if (phase !== "riding" && phase !== "boarding") return [];
    const lites = listLiteRef.current;
    const withCompany = (v: VehicleLite): VehicleLite => ({
      ...v,
      company: lastCompanyRef.current ?? v.company,
    });
    if (phase === "boarding") return lites.map(withCompany);
    /**
     * ★ v3.8.1 修复「导航时车辆图标消失」（因素 2）：**GPS 驱动段展示全部在途车**。
     *   巴士段 R2 自动上车只在 A1（车刚离站且唯一）时锁牌（`boarding-detect.ts` 的
     *   `lockedPlate = aux.strong ? aux.plate : null`），A2（车停靠/在途，多数实际场景）
     *   刻意不锁 ⇒ `source="gps"`、`plate=null` 的 riding 会话并不少见。
     *   旧逻辑此处返回 `[]` ⇒ 地图无车；且 S3 无牌轮询被 `MATCH_VEHICLE_ENABLED=false`
     *   挡着 ⇒ 帧也不更新，双重消失。系统不知道"哪辆是我的"，用户同样不知道——
     *   展示本线路全部在途车（与候车态同语义）比空白诚实。
     *   ⚠️ 必须与"步行段降频轮询"成对：无牌时帧靠它供给，只改这里没有数据可显。
     */
    if (!plate) return lites.map(withCompany);
    const v = lites.find((x) => x.plate === plate);
    return v ? [withCompany(v)] : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, plate, listTick]);

  /**
   * 更新 GPS 采样缓冲。
   *
   * ⚠️ **必须声明在下方「paused tick 主 effect」之前** —— 那里的新帧复评 effect
   *   会读 `fixesRef.current`；React 按声明顺序执行 effect，本 effect 若被排到后面，
   *   复评就会读到**上一帧**的数据，而且**不会报任何错**（ref 永远有值、只是旧）。
   *   纯顺序依赖、无类型保护，改动 effect 顺序时务必看这里。
   */
  useEffect(() => {
    if (!userFix) return;
    const arr = fixesRef.current.filter((f) => userFix.ts - f.ts <= FIX_KEEP_MS);
    arr.push({ lng: userFix.lng, lat: userFix.lat, accuracy: userFix.accuracy, ts: userFix.ts });
    fixesRef.current = arr;
  }, [userFix]);

  /**
   * ★ v3.6.0（AC-25a）：维护「判定是否已暂停」。
   *   · 5s 心跳：捕获「用户不再产生新帧」这条路径（60s 无帧 ⇒ paused），
   *     光靠 `userFix` 永远等不到。⚠️ 依赖**不含** `userFix` —— 否则 1.5~3s 就
   *     clear+set 一次 interval（功能对但属无谓抖动）。
   *   · 新帧复评：另用一个小 effect 调 `tickRef`，保持「帧到位立刻转 on」的响应，
   *     同时不重建 interval。
   *   · 启动宽限：`boardingStartedAtRef` 内的前 `BOARDING_START_GRACE_MS` 不判 paused。
   *   仅在候车态计算；离开候车态一律回到 `on`（不污染乘车/结束态）。
   */
  const pausedTickRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (phase !== "boarding" || !active) {
      pausedTickRef.current = () => {};
      setBoardPaused(false);
      return;
    }
    const tick = () => {
      const next = detectPausedOf(fixesRef.current, Date.now(), boardingStartedAtRef.current);
      setBoardPaused((v) => (v === next ? v : next));
    };
    pausedTickRef.current = tick;
    tick();
    const t = window.setInterval(tick, 5_000);
    return () => window.clearInterval(t);
  }, [phase, active]);

  /** 新帧到位 ⇒ 立即复评（不顺带重建上面的 interval） */
  useEffect(() => {
    if (phase !== "boarding" || !active) return;
    pausedTickRef.current();
  }, [phase, active, userFix]);

  /**
   * ★ T7：**唯一**的灰线清空出口 —— state / 游标 / 上屏标记 / 观测属性必须同生共死。
   *   漏清 ref 的后果：下一段沿用上一段的 `idx` ⇒ `shrink` 或 `backward` 会把每一帧都拒掉
   *   ⇒ 灰线在本段内**永久不出现**（比画错更难查）。
   */
  const clearTraveled = useCallback(() => {
    setTraveled(null);
    traveledCurRef.current = null;
    traveledShownRef.current = false;
    setTraveledAttr(null);
  }, []);

  const reset = useCallback(() => {
    setPhase("off");
    setLegIndex(0);
    setPlate(null);
    setProg(null);
    setAlarm("none");
    clearTraveled();
    setNote("");
    setCandidates([]);
    setAutoSwitched(false);
    setAutoNote("");
    setProgressSource("vehicle");
    setAnomaly("none");
    setLastVehicleTs(0);
    setLastFixTs(0);
    // ★ v3.7.0 S3：匹配态与匹配器历史一起清（排除名单只对本段有效）
    setBoardMatch("none");
    setMatchSource("gps");
    setMatchPending(false);
    setPendingPlate(null);
    matcherRef.current?.reset();
    vehicleRef.current = null;
    missRef.current = 0;
    alarmRef.current = "none";
    listRef.current = [];
    listLiteRef.current = []; // ★ T6：UI 侧车队同步清空（否则换腿瞬间闪一下上一腿的车）
    anchorRef.current = null; // ★ 锚定车只对「本段本次候车」有效
    ladderRef.current = null;
    lrtStateRef.current = { passedIdx: -1, computed: -1, dist: 0, ts: 0, badStreak: 0 };
    autoUsedRef.current = false;
    lastSwitchTsRef.current = 0;
    anomalyStreakRef.current = 0;
    ridingStartIdxRef.current = -1;
    // ★ 本批
    lastGoodDotRef.current = null;
    alightStreakRef.current = 0;
    boardStreakRef.current = 0;
    boardingStartedAtRef.current = null;
    undoRef.current = null;
    if (justAlightedTimerRef.current) {
      window.clearTimeout(justAlightedTimerRef.current);
      justAlightedTimerRef.current = null;
    }
    setJustAlighted(false);
    setYouDot(null);
    setYouAt(null);
    setListTick(0);
    setLadderTick(0);
  }, [clearTraveled]);

  useEffect(() => {
    if (!active) reset();
  }, [active, reset]);
  useEffect(() => {
    reset();
  }, [card, reset]);

  /** 震动（不支持则静默） */
  const buzz = useCallback((pattern: number | number[]) => {
    try {
      if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(pattern);
    } catch {
      /* ignore */
    }
  }, []);

  /* ── Wake Lock（手势内申请；切前台重申请；失败静默）── */
  const acquireWake = useCallback(async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
      };
      if (!nav.wakeLock) return;
      lockRef.current = await nav.wakeLock.request("screen");
    } catch {
      /* ignore */
    }
  }, []);
  const releaseWake = useCallback(() => {
    try {
      void lockRef.current?.release();
    } catch {
      /* ignore */
    }
    lockRef.current = null;
  }, []);
  useEffect(() => {
    if (phase === "off") return;
    const onVis = () => {
      if (document.visibilityState === "visible") void acquireWake();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [phase, acquireWake]);
  useEffect(() => () => releaseWake(), [releaseWake]);

  /** 轻轨 / 巴士 GPS 驱动的站坐标映射（一次性拉取并缓存） */
  const ensureStationMap = useCallback(async (): Promise<Map<string, { lng: number; lat: number }>> => {
    if (stationMapRef.current) return stationMapRef.current;
    const m = new Map<string, { lng: number; lat: number }>();
    try {
      const r = await fetch("/api/stations?include=lrt&v=2", { cache: "force-cache" });
      const j = (await r.json()) as { stations?: { code: string; lng: number; lat: number }[] };
      for (const s of j.stations ?? []) m.set(mainOf(s.code), { lng: s.lng, lat: s.lat });
    } catch {
      /* 失败 → 空表（推进降级为不推进） */
    }
    stationMapRef.current = m;
    return m;
  }, []);

  /** 建立本段站点里程阶梯（GPS 驱动推进用） */
  const ensureLadder = useCallback(async () => {
    const leg = legs[legIndex];
    if (!leg || leg.colored.length < 2) return;
    const map = await ensureStationMap();
    const stops = (strips?.[legIndex]?.stops ?? []).map((s) => map.get(mainOf(s.code)) ?? null);
    ladderRef.current = buildLrtLadder(leg.colored, stops);
    lrtStateRef.current = { passedIdx: -1, computed: -1, dist: 0, ts: 0, badStreak: 0 };
    setLadderTick((t) => t + 1); // 阶梯就绪 → 触发 youAt 重算
  }, [legs, legIndex, strips, ensureStationMap]);

  /** 拉一帧车辆数据 */
  const fetchFrame = useCallback(
    async (lockPlate: string | null): Promise<void> => {
      const leg = legs[legIndex];
      const dir = leg?.dir;
      if (!leg || !dir || leg.kind !== "bus") {
        if (leg?.kind !== "lrt") setNote(NOTE_NO_PROGRESS);
        return;
      }
      setTraveling(true);
      try {
        const r = await fetch(
          `/api/route-vehicles?code=${encodeURIComponent(leg.route)}&dir=${encodeURIComponent(dir)}&kind=bus&progress=1`,
          { cache: "no-store" },
        );
        const j = (await r.json()) as { vehicles?: VehicleLite[]; company?: string | null; fetchedAt?: string };
        const lites = j.vehicles ?? [];
        listLiteRef.current = lites; // ★ T6：UI 用（含站名 / 末班）
        const list: TrackVehicle[] = lites.map((v) => ({
          plate: v.plate,
          lat: v.lat,
          lng: v.lng,
          status: String(v.status ?? "unknown"),
          interval: v.interval ?? null,
          atStation: v.atStation ?? null,
          progress: v.progress ?? null,
        }));
        listRef.current = list;
        lastCompanyRef.current = j.company ?? null; // ★ 本批：帧顶层运营商（mapVehicles 涂装色）
        // ★ v3.7.0 S2：车辆帧时间戳（**唯一**写入点）+ 观测钩子 `data-veh` / `data-veh-age`
        //   `fetchedAt` 只作「帧标识」判断数据有没有真的更新（不做跨时钟减法，见 observe-hooks）
        setLastVehicleTs(Date.now());
        noteVehFrame(j.fetchedAt ?? null);
        setListTick((t) => t + 1); // ★ 本批：触发 mapVehicles 重算（AC-46）

        const boardMain = stopsBoard(strips, legIndex) || mainOf(anchors?.[legIndex]?.board?.code ?? "");
        if (!lockPlate) {
          /**
           * ══════════════════════════════════════════════════════════════════
           * ★ v3.7.0 S3（ADR C10）：**上车后才开始导航**的车辆匹配
           * ══════════════════════════════════════════════════════════════════
           * 为什么只能在这里接管：`riding` 且没有车牌时，既有链路只能走 GPS 推算
           * （`progressSource="gps"`）—— 地图上找不到自己坐的车、也报不了站。
           * 根因是**候选池口径**（`rankBoardingVehicles` 只取上车站附近），
           * 所以这里换成 `matchVehicle` 的池子（本线路本方向**全部在途车**）。
           *
           * 三条纪律：
           *   · **只在车辆帧到达时算**（12s 一次）；GPS 帧只喂历史样本，不跑算法；
           *   · **本分支不碰判定层** —— `if (!lockPlate)` 之下的候车「锚定 + 过站过滤」仍在
           *     `phase === "boarding"` 时原样执行（本分支只拦 `riding`）。
           *     前端对 `boarding-detect.ts` / `track.ts` 的改动 = **0 行**。
           *     ℹ️ `progress.ts` 本轮**被后端改过**（三源版本令牌 + TTL 分级：几何/里程 120s、
           *     跳时长 600s；对外行为不变）。它的意义：服务端 `p` 与客户端 `leg.colored`
           *     现在**必然同版本几何**（改道后令牌变、缓存键跟着变）⇒ 里程轴两边能对齐。
           *     这也是 `vehicleMileOf` 必须同传 `colored` 的另一半理由。
           *   · 开关 `MATCH_VEHICLE_ENABLED` 默认 false ⇒ 关闭时本段**直接 return**，
           *     行为与改前完全一致（不多发请求、不多算一次）。
           */
          if (phase === "riding") {
            if (!matchOnRef.current) return;
            const latestFix = fixesRef.current[fixesRef.current.length - 1] ?? null;
            const distNow = lrtStateRef.current;
            const res = matcherRef.current!.run({
              colored: leg.colored,
              ladder: ladderRef.current,
              stopMains,
              vehicles: list,
              // GPS 里程不可信（连续丢帧）⇒ 不当作锚，让算法自己的硬门否决
              dUser: distNow.dist > 0 && distNow.badStreak < 2 ? distNow.dist : null,
              nowMs: Date.now(),
              userAccuracyM: latestFix?.accuracy ?? null,
            });
            /** 供「不是这辆」翻候选：用本帧排名，别再依赖候车阶段留下的旧名单 */
            if (res.ranking.length) {
              const byPlate = new Map(list.map((x) => [x.plate, x]));
              setCandidates(
                res.ranking
                  .filter((r) => byPlate.has(r.plate))
                  .map((r) => ({ plate: r.plate, hint: hintOf(byPlate.get(r.plate)!) })),
              );
            }
            if (res.confidence === "high" && res.plate) {
              // 高置信：锁牌 + 进度改由车辆驱动（报站读数这才有依据）
              vehicleRef.current = list.find((x) => x.plate === res.plate) ?? null;
              missRef.current = 0;
              setPlate(res.plate);
              setPendingPlate(null);
              setMatchPending(false);
              setProgressSource("vehicle");
              setBoardMatch("auto");
              // 跃迁瞬间读到的来源必须是「定位+车辆」：匹配的证据本身就是用户自身位移
              setMatchSource("gps+vehicle");
              setNote("");
              setAutoNote(`已对上车辆 · ${res.plate}`);
            } else if (usableMedium(res)) {
              /**
               * 中置信：**只标注，不锁牌**（`plate` 保持 null）。
               *
               * ① 为什么不能设 `plate`：`plate` 一旦有值，轮询 effect 会走 `fetchFrame(plate)`
               *    ⇒ `progressOf` 从车牌推出报站值 ⇒ 违反契约「medium 不得据以报站」。
               *    所以用独立的 `pendingPlate` 只做**展示**，进度与报站继续走 GPS。
               * ② 为什么 `boardMatch` 是 `auto` 而不是 `confirmed`（team-lead 裁决）：
               *    `confirmed` 留给「用户确认」。若中置信占用它，同一个值会同时代表
               *    「系统不确定（可能需要纠错）」与「人已确认（无需纠错）」两件**相反**的事，
               *    将来做 Q5 轻确认时再也分不开 ⇒ 用独立 `matchPending`（`data-match-pending`）区分。
               */
              setPendingPlate(res.plate);
              setMatchPending(true);
              setBoardMatch("auto");
              setMatchSource("gps+vehicle");
            }
            return;
          }
          /**
           * ★ 候车『锚定 + 过站过滤』（纯逻辑在 `lib/nav/track.ts`，此处只接线）：
           *   ① 首帧没有锚 ⇒ 先锚定（取排序第一名），作为几何判据基准；
           *   ② `filterPassed: true` ⇒ 已驶过**上车站**的车不再算候选。
           *   为什么必须过滤：不过滤时用户等的车过站后仍留在候选里 ⇒ `ranked.length === 0`
           *   永不成立 ⇒「候选中没车 / 可能错过班次」提示永远不触发；且后车会顶到第一位，
           *   手动上车（`board()`）可能锁到后车。
           *   ⚠️ 判据是「有证据才判」（站序优先，无站序才用几何），不会误删没证据的车。
           */
          if (!anchorRef.current && list.length) {
            anchorRef.current = anchorOf(list, boardMain, boardPos, { nowMs: Date.now() });
          }
          const ranked = rankBoardingVehicles(list, boardMain, boardPos, {
            filterPassed: true,
            stopMains,
            anchor: anchorRef.current,
          });
          setCandidates(ranked.slice(0, 6).map((v) => ({ plate: v.plate, hint: hintOf(v) })));
          if (phase === "boarding") setNote(ranked.length ? "" : NOTE_NO_VEHICLES);
          return;
        }

        const v = list.find((x) => x.plate === lockPlate) ?? null;
        if (!v) {
          missRef.current += 1;
          if (missRef.current >= MISS_LIMIT) setNote(NOTE_FROZEN_BUS);
          return;
        }
        missRef.current = 0;
        setNote("");
        vehicleRef.current = v;

        // ★ v3.4.0（进度模型）：本段「位置感知剩余」——服务端 progress（坐标投影结果）
        //   与客户端「时间项」融合：fused = w·D + (1−w)·max(md − u, 0)。
        //   u 的获取：区间首见时用「位置模型反推」（u0 = md − D，中途打开也成立），此后按时间累积。
        const pr = v.progress ?? null;
        if (pr && pr.mdSec > 0) {
          const segKey = `${pr.segFrom}|${pr.segTo}`;
          const seen = segSeenRef.current;
          if (!seen || seen.segKey !== segKey) {
            segSeenRef.current = { segKey, u0Sec: Math.max(0, pr.mdSec - pr.remainSecD), ts: Date.now() };
          }
          const s0 = segSeenRef.current!;
          const uSec = s0.u0Sec + (Date.now() - s0.ts) / 1000;
          const fusedSec = pr.w * pr.remainSecD + (1 - pr.w) * Math.max(pr.mdSec - uSec, 0);
          setSegProgress({ segFrom: pr.segFrom, segTo: pr.segTo, p: pr.p, segRemainSec: fusedSec });
        } else {
          setSegProgress(null);
        }

        const p = progressOf(stopMains, v);
        if (p.kind === "at" || p.kind === "between") setProg(p);

        // ★ 本批（07 §c.4 裁定）：**视觉层（已驶过灰线 + 蓝点）一律用 GPS 切割**
        //   —— 车辆帧**不再**更新 `traveled`（逻辑层进度仍以车辆为权威）。
      } catch {
        /**
         * ★ v3.7.0 S2：**失败不清空** `listRef` / `listLiteRef`（D3/D7）——
         *   断网时保留上一帧车辆，UI 才有东西可显示（并靠
         *   `body[data-veh=failed|stale]` + `data-veh-age` 标注陈旧）。
         *   ⚠️ 此处**不得**写 `setLastVehicleTs` —— 失败不是新帧。
         */
        noteVehFail();
        setNote(NOTE_FETCH_FAIL);
      } finally {
        setTraveling(false);
      }
    },
    [legs, legIndex, strips, boardPos, stopMains, anchors, phase],
  );

  /* ── 自动上车判定 ── */
  const switchToRiding = useCallback(
    (nextPlate: string | null, source: "vehicle" | "gps") => {
      const leg = legs[legIndex];
      const route = leg?.route.replace(/^LRT-/, "") ?? "";
      const lrt = leg?.kind === "lrt";
      setPhase("riding");
      setPlate(nextPlate);
      setProgressSource(source);
      /**
       * ★ v3.7.0 S3：自动上车（R1/R2/轻轨）成功 = `auto`；来源按有无车牌投影
       *   —— 有牌 ⇒ `vehicle`（车辆信号参与且已锁定），无牌 ⇒ `gps`（纯定位推算）。
       *   ⚠️ 这一条**不是**匹配算法的分支（那是 `plate === null` 时的独立路径），
       *      两者互斥：能自动上车就不会走到匹配，反之匹配锁上后也不会再判上车。
       */
      setBoardMatch("auto");
      setMatchSource(nextPlate ? "vehicle" : "gps");
      setMatchPending(false); // 自动上车（R1/R2/轻轨）不是"中置信"，无待确认语义
      setPendingPlate(null);
      setAutoSwitched(true);
      setNote(source === "gps" ? "" : "");
      setAutoNote(
        lrt
          ? `已开始跟踪行程（${route}）`
          : nextPlate
            ? `已开始跟踪 ${route} 路 · ${nextPlate}`
            : `已开始跟踪 ${route} 路`,
      );
      lastSwitchTsRef.current = Date.now();
      autoUsedRef.current = true;
      ridingStartIdxRef.current = -1;
      anchorRef.current = null; // ★ 已上车 ⇒ 候车锚点作废（下一段候车重新锚定）
      missRef.current = 0;
      alarmRef.current = "none";
      setAlarm("none");
      setAnomaly("none");
      anomalyStreakRef.current = 0;
      boardStreakRef.current = 0; // ★ 本批：切换后清零多帧确认计数
      alightStreakRef.current = 0;
      // ★ 本批：**任何来源**都建一次站点里程阶梯（供纵条 youAt / 自动下车判定）
      ladderRef.current = null;
      void ensureLadder();
    },
    [legs, legIndex, ensureLadder],
  );

  const tryAuto = useCallback(() => {
    if (phase !== "boarding" || !active) return;
    /**
     * ★ v3.10.0 修复「上车后才点开始导航 ⇒ 卡步行段」（负责人反馈）。
     *
     * ── 旧版为什么会死锁（`if (walkActiveRef.current) return;`）──────────────
     *   v3.8.0 T1 把会话起点从「站在站台按开始导航」提前到「出门就开始走」⇒
     *   用户**在车上**点开始时也会先进入步行出发段（`walkSeg="out"`）。
     *   旧版此处硬封 ⇒ `autoBoardOf`（内含 `r2Of` 的速度判定）**永不执行**；
     *   而清步行段的唯一出口是 `walkFollow.phase === "arrived"`
     *   （`arrived(remainM)` = 沿步行路径走到终点 30m 内）⇒
     *   用户在车上不沿步行路径走 ⇒ 永不 arrived ⇒ 死锁：
     *   永远是步行段 + 横幅「已偏离路线 N 米」（提示正确但无用：用户不该走）。
     *
     * ── 放开后为何不会误判**步行**用户（三条同向收紧）────────────────────────
     *   ① **速度门 8 km/h** 是「步行 / 车速」的契约分界（`R2_SPEED_MIN_KMH_FLEX`，
     *      架构已双向实测：5.5 会把快走判成已上车，故取 8）——
     *      正常步行 5~6、快走 6~7 全部 < 8，`r2Of` 直接不命中；
     *   ② **位移门 60m** 使短时跑动无法命中：10 km/h 需连续沿线跑 21.6s、8 km/h 需 27s；
     *   ③ **步行段再扣 2 帧**（下方 `need + 2`）：把「跑步赶车」这类真实
     *      边缘场景所需持续时长再拉长约 3s。
     *   ⇒ 仅「持续高速沿线路移动」（= 在车上）能命中。
     *
     * ── 与 v3.8.1「步行段降频轮询」不冲突 ─────────────────────────────────
     *   那条改的是**拉车辆帧**的间隔（`schedule(walkActive ? POLL_MS*5 : 0)`），
     *   本条改的是**上车判定的准入**，两者独立。
     */
    const leg = legs[legIndex];
    if (!leg) return;
    /**
     * ⚠️ **时序假设（打包器/HMR 变更时重点复核）**：本函数是**纯查询 + 分支**，不写 state、
     *   不发请求；它依赖的是「被谁按什么顺序调用」，而不是自身内部顺序：
     *   ① 调用点只有两个 —— `userFix` 变化（3s 一帧）与候车轮询 `round()` 之后；
     *      两者都发生在 **React commit 之后**的 effect 里，因此读到的 `fixesRef.current` /
     *      `listRef.current` 是本轮已更新的值（ref 不受渲染时序影响）。
     *   ② `boardStreakRef.current` 的**跨帧累积**依赖"每帧恰好调用一次" ——
     *      若某次渲染周期内 tryAuto 被调用两次（HMR 重放 / StrictMode 双调用），
     *      streak 会**多加一次**，判定提前 1 帧（比漏判更危险的方向）。
     *   ③ 本函数在 `phase !== "boarding"` 时立即返回，因此 `switchToRiding` 后不会重入。
     *   ⇒ 升级后验证点：真机上连续 30s 导航，观察 `data-board-match` 是否在
     *     预期帧数（而非提前 1~2 帧）跳到 `auto`。
     */
    const boardMain = stopsBoard(strips, legIndex) || mainOf(anchors?.[legIndex]?.board?.code ?? "");
    const res = autoBoardOf({
      legKind: leg.kind,
      legDegraded: leg.degraded,
      colored: leg.colored,
      boardMain,
      boardPos,
      vehicles: listRef.current,
      fixes: fixesRef.current,
      lastSwitchTs: lastSwitchTsRef.current,
      nowMs: Date.now(),
      autoUsed: autoUsedRef.current,
      streak: boardStreakRef.current,
    });
    // ★ v3.6.0（架构 §3.1）：唯一切换条件 = `hit && streak >= need`（need 由 autoBoardOf 返回）。
    //   **删除**旧版 `res.reason === "r1"` 特权分支 —— 车辆信号不得单独触发上车。
    boardStreakRef.current = res.streak;
    if (!res.hit) return;
    /**
     * ★ v3.10.0：**步行段加严 2 帧**（详见函数头 ③）。
     *
     * 为什么是 2 而不是 1（实测数据，理想直线 + 完美精度的下界）：
     *   加严 1 帧只把所有触发统一延后 3s，「跑 10 km/h 跑 24s 后站着等车」仍在 30s 误判；
     *   加严 2 帧使该场景**不触发**（停下后平均速度跌回 8 以下），
     *   而真实乘车只慢一档：公交 20 km/h 18s→24s、30 km/h 15s→21s、堵车 12 km/h 24s→30s。
     *   ⇒ 用"公交切换慢 6s"换掉一档常见误判（10 km/h 跑 24s 正是典型赶车强度），划算。
     *   剩余唯一误判 = 12 km/h 连续跑 24s（约 80m 冲刺），属极端场景，由「我没上车」兜底。
     *
     * ⚠️ 清段后（`walkActive=false`）恢复原门槛，不影响站台候车的既有灵敏度。
     */
    const need = res.need + (walkActiveRef.current ? 2 : 0);
    if (res.streak >= need) {
      switchToRiding(res.plate, res.source);
    }
  }, [phase, active, legs, legIndex, strips, anchors, boardPos, switchToRiding]);

  /**
   * ★ v3.7.0 S2（D1）：**恢复补刷**的唯一挂载点。
   *
   * 两个轮询 effect（候车 / 乘车）各自把自己的「立刻打一帧并重置 12s 计时」函数登进
   * `resumeKickRef`；本 hook 在 `visibilitychange→visible` / `online` / `pageshow(persisted)`
   * 时调它一次（内部 2s 去抖，防「回前台三事件连发」造成请求风暴，AC2.5）。
   *
   * ⚠️ 这里**只增加"何时触发"的入口**，不改 `phase` 状态机与 `tryAuto` 的调用时机语义。
   */
  const resumeKickRef = useRef<(() => void) | null>(null);
  useResumeRefresh(
    useCallback(() => {
      resumeKickRef.current?.();
    }, []),
    active && (phase === "boarding" || phase === "riding"),
  );

  /* 候车态：拉候选（★ 本批：**12s 持续轮询**，非只拉一帧 —— 上车灵敏度，AC-56）；
     并在车辆帧到位时尝试自动切换。purpose 复用 `live_pos`（服务端只记账、不参与熔断）。 */
  useEffect(() => {
    if (phase !== "boarding" || !active || !legs[legIndex]) return;
    /**
     * ★ v3.8.1 修复「导航时车辆图标消失」（因素 1）：**步行段降频不停止**。
     *   会话起点从"站在站台上按开始导航"提前到"出门就开始走"⇒ 步行段动辄 3–10 分钟；
     *   若整段不轮询，`listLiteRef` 恒空 ⇒ 候车态地图全程零车（负责人线上反馈的根因之一）。
     *   降频为 60s 一帧：配额代价 = 10 分钟步行 10 次请求（旧版站台起 5 分钟即 25 次，仍净省）；
     *   且用户在步行段同样关心「要坐的车现在到哪了」——这不是纯等待时段。
     *   ⚠️ `tryAuto` 的 `walkActiveRef` 早退**保持不变**：人没到站不判上车，逻辑不受影响。
     *   走进站台后 `walkActive` 变 false ⇒ 本 effect 重跑 ⇒ 立刻拉一帧 + 恢复 12s 轮询。
     */
    let cancelled = false;
    let timer: number | null = null;
    /**
     * ★ v3.7.0 S2：**同一时刻只允许一帧在飞**。
     *   否则「定时器刚打出去 + 用户此刻回前台」会在几毫秒内连打两次
     *   （AC2.5 要求同源 2s 窗口内 ≤1 次）。
     */
    let inFlight = false;
    /** 一轮 = 拉帧 + 尝试自动上车（保持既有的串行顺序） */
    const round = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await fetchFrame(null);
      } finally {
        inFlight = false;
      }
      if (cancelled) return;
      tryAuto();
    };
    /**
     * ★ v3.7.0 S2：轮询改用 **setTimeout 链**而不是 `setInterval` ——
     *   恢复补刷时必须能"取消待触发的那一次 + 从此刻重新计 12s"，
     *   `setInterval` 做不到（会出现「刚补刷完 1 秒又自动打一次」）。
     */
    const schedule = (ms: number) => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void round().then(() => {
          if (!cancelled) schedule(POLL_MS);
        });
      }, ms);
    };
    const kick = () => {
      if (cancelled) return;
      void round().then(() => {
        if (!cancelled) schedule(POLL_MS); // 补刷后重置 12s
      });
    };
    // 步行段首发同样立即（用户点开始导航就该看到车），但后续间隔降到 60s（见上方 T1 修复说明）
    schedule(walkActive ? POLL_MS * 5 : 0);
    resumeKickRef.current = kick;
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      if (resumeKickRef.current === kick) resumeKickRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, active, legIndex, walkActive]);

  /* GPS 帧到位（节流）也尝试自动切换 */
  useEffect(() => {
    if (phase !== "boarding") return;
    tryAuto();
  }, [userFix, phase, tryAuto]);

  /* 轮询（riding 且有车牌）—— ★ v3.7.0 S2：同样接恢复补刷 */
  useEffect(() => {
    if (phase !== "riding" || !plate || !active) return;
    let cancelled = false;
    let timer: number | null = null;
    /** ★ v3.7.0 S2：同一时刻只允许一帧在飞（防「定时器 + 回前台补刷」双打，AC2.5） */
    let inFlight = false;
    const pull = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await fetchFrame(plate);
      } finally {
        inFlight = false;
      }
    };
    const schedule = (ms: number) => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (cancelled) return;
        void pull().then(() => {
          if (!cancelled) schedule(POLL_MS);
        });
      }, ms);
    };
    const kick = () => {
      if (cancelled) return;
      void pull().then(() => {
        if (!cancelled) schedule(POLL_MS);
      });
    };
    schedule(0);
    resumeKickRef.current = kick;
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      if (resumeKickRef.current === kick) resumeKickRef.current = null;
    };
  }, [phase, plate, active, fetchFrame]);

  /**
   * ★ v3.7.0 S3：**riding 但没有车牌时的轮询**（原实现此路径完全没有请求）。
   *
   * 没有它，匹配算法就是「有算法没数据」：`riding && !plate` 时既有的轮询 effect
   * 因 `!plate` 直接 return ⇒ 车辆帧永不更新 ⇒ `vehicleHistory` 永远只有 0~1 帧 ⇒
   * `frames` 到不了高置信门槛 ⇒ 永远锁不上（这正是架构评审说的「入口在、没接上」）。
   *
   * · 走 `fetchFrame(null)`：拿**该线路该方向全部在途车**（匹配的候选池口径），
   *   而不是上车站附近那几辆；`phase === "riding"` 分支里直接跑算法并 return，
   *   不会再进入候车的锚定/过站过滤逻辑；
   * · 只在开关打开时才轮询 —— 关闭时不多发一次请求（`MATCH_VEHICLE_ENABLED` 现为 false）；
   * · 同样接回前台/网络恢复补刷，也同样做「同一时刻只允许一帧在飞」。
   */
  useEffect(() => {
    /**
     * ★ v3.10.0：**「供数据」与「跑匹配」解耦**。
     *
     * 旧守卫是 `if (!matchOnRef.current || ...) return;` ⇒ 关闭匹配时整条轮询不跑，
     * 于是 **riding 且无牌** 时会话完全没有车辆请求（另一条有牌轮询因 `!plate` 也不跑）
     * ⇒ `listLiteRef` 停在步行段最后一帧 ⇒ `mapVehicles` 返回**过期坐标**
     * （车冻结在旧位置，比"没有车"更误导）。
     *
     * 现在：无牌 riding 一律轮询 —— 目的只是让 `listLiteRef` 持续更新（地图车能动）。
     * **匹配算法仍受 `MATCH_VEHICLE_ENABLED` 控制**：`fetchFrame` 内部
     * `if (phase === "riding") { if (!matchOnRef.current) return; }` 已经挡在算之前，
     * 且该 `return` 发生在 `listLiteRef.current = lites` **之后** ⇒ 数据已更新、匹配未跑。
     *
     * ⚠️ 代价（负责人已批准）：打破「关闭匹配时不多发请求」的既有约定 ——
     *    请求量与"开着匹配"时相同（同线路同方向，12s 一帧）。换来的是地图车不再冻结。
     */
    if (phase !== "riding" || plate || !active) return;
    let cancelled = false;
    let timer: number | null = null;
    let inFlight = false;
    const pull = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await fetchFrame(null);
      } finally {
        inFlight = false;
      }
    };
    const schedule = (ms: number) => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (cancelled) return;
        void pull().then(() => {
          if (!cancelled) schedule(POLL_MS);
        });
      }, ms);
    };
    const kick = () => {
      if (cancelled) return;
      void pull().then(() => {
        if (!cancelled) schedule(POLL_MS);
      });
    };
    schedule(POLL_MS); // 不抢首发：切到 riding 时刚拿到过一帧（候车轮询的最后一帧）
    resumeKickRef.current = kick;
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      if (resumeKickRef.current === kick) resumeKickRef.current = null;
    };
  }, [phase, plate, active, fetchFrame]);

  /**
   * ★ v3.7.0 S2：`data-veh` / `data-veh-age` 的心跳（单例、引用计数）。
   *   年龄必须每秒递增，否则「车辆数据已 5 分钟没更新」在钩子上永远看不出变化（AC2.4）。
   *
   *   ⚠️ 依赖只放 `active`（**不放 `phase`**）：boarding→riding 会让 phase 变，
   *   若挂在 phase 上就会「释放一次 + 重新持有」，导致属性被移除后要等下一帧
   *   （≤12s）才恢复 —— 上车瞬间 `data-veh` 消失会被测试判成「数据丢失」。
   *   导航态整体结束（`active=false`）才释放并清场。
   */
  useEffect(() => {
    if (!active) return;
    return retainVehTicker();
  }, [active]);

  /* GPS 驱动推进（无车牌 / 轻轨）：用 userFix 推站序进度；★ 视觉层（已驶过灰线）**一律 GPS 切割** */
  useEffect(() => {
    // ★ T7：非乘车态 ⇒ 移除观测属性（`clearTraveled` 走另一条路，这里兜的是「切阶段」）
    if (phase !== "riding" || !active) {
      setTraveledAttr(null);
      return;
    }
    if (!userFix) return;
    const leg = legs[legIndex];
    if (!leg) return;
    const gpsDriven = progressSource === "gps" || !plate;
    if (gpsDriven) {
      if (ladderRef.current) {
        const res = advanceLrt({
          prevPassedIdx: lrtStateRef.current.passedIdx,
          prevComputed: lrtStateRef.current.computed,
          prevDist: lrtStateRef.current.dist,
          prevTs: lrtStateRef.current.ts,
          badStreak: lrtStateRef.current.badStreak,
          ladder: ladderRef.current,
          fix: { lng: userFix.lng, lat: userFix.lat, accuracy: userFix.accuracy, ts: userFix.ts },
        });
        lrtStateRef.current = {
          passedIdx: res.passedIdx,
          computed: res.computed,
          dist: res.distNow,
          ts: res.ts,
          badStreak: res.badStreak,
        };
        if (res.progress.kind !== "lost") setProg(res.progress);
        if (res.frozen && res.badStreak >= 2) setNote(NOTE_LRT_WEAK);
        else if (!res.frozen && note === NOTE_LRT_WEAK) setNote("");
        /**
         * ★ v3.7.0 S3：把这一帧的用户沿线里程喂给匹配器（**只喂历史，不跑算法**）。
         *   `matchVehicle` 要「用户里程-时间」序列做逐帧比对与 S4，单点撑不住；
         *   算法本身 12s 一次、在车辆帧里跑（见 `fetchFrame` 的 riding 分支）。
         */
        if (matchOnRef.current) {
          matcherRef.current!.noteUser(userFix.ts, res.distNow > 0 ? res.distNow : null);
        }
      } else {
        void ensureLadder();
      }
    }
    // ★ 本批（07 §c.4 裁定）：视觉层（灰线）**与蓝点同源 = GPS 切割**（不再用车辆切割）。
    /**
     * ★ T3 修复「蓝点旁那条灰色一撇」：末点**吸附到投影顶点**（线从蓝点正下方出发），
     *   并要求「至少 2 段 + 累计 ≥40m」才出线。
     *
     * ★ T7（本批）：**单调游标**（`monotonicCut`）——T3 只解决了"末点用原始 GPS"，
     *   没解决"投影落在折回的另一遍"：
     *     · `74%` 的灰线错帧来自 `idx` 在空间重合的两遍之间跳（坍缩 / 多画）；
     *     · 那两遍空间只差 0~60m ⇒ **蓝点看着正常**，用户只看到"线变成一小撇"。
     *   现在：横向门与蓝点同值（60m）、回退/增速/缩短三重否决 ⇒ **拒帧即冻结，绝不清空**。
     */
    if (leg.colored.length >= 2 && !leg.degraded) {
      const now = Date.now();
      const r = monotonicCut(
        leg.colored,
        { lng: userFix.lng, lat: userFix.lat },
        traveledCurRef.current,
        now,
      );
      if (r.accept) {
        // 采纳才推进游标（拒帧不动 ts ⇒ elapsed 累积 ⇒ too-fast 会自然解除、60s 后放行回退）
        traveledCurRef.current = { idx: r.idx, lenM: r.lenM, ts: now };
        // 出线门槛：刚上车 idx 很小，画出来就是"蓝点旁的一小撇" ⇒ 宁可不画
        if (r.idx >= MIN_TRAVELED_IDX && r.lenM >= MIN_TRAVELED_M) {
          setTraveled(leg.colored.slice(0, r.idx + 1) as LL[]);
          traveledShownRef.current = true;
          setTraveledAttr("ok", r.diag);
        } else {
          setTraveledAttr("none", r.diag);
        }
      } else {
        // 冻结：保留上一帧灰线（clear 会让用户以为"进度丢了"）
        // ★ `data-traveled-cut` 只在拒帧写 —— 暴露"本来会落到哪"，QA 才分得清
        //   「定位真偏了」还是「算法判错了」。
        setTraveledAttr(
          traveledShownRef.current ? `frozen:${r.reason === "first" ? "bad-snap" : r.reason}` : "none",
          r.diag,
          { idx: r.diag.projIdx, lenM: r.diag.projLenM },
        );
      }
    }
    // ★ v3.7.0 S2（D5）：这里是 **GPS 帧** effect ⇒ 只能写定位时间戳。
    //   旧版在此写 `lastUpdateTs`（车辆新鲜度）⇒ 车辆接口失败时界面仍显示「刚刚更新」。
    setLastFixTs(Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userFix, phase, active, progressSource, plate, legs, legIndex]);

  /* 下车提醒（下一站 = 下车站 ⇒ soon；到站 ⇒ now；级别跃升时震一次） */
  useEffect(() => {
    if (phase !== "riding" || !prog || stopMains.length < 2) {
      setAlarm("none");
      alarmRef.current = "none";
      return;
    }
    const alightIdx = stopMains.length - 1;
    const next: "none" | "soon" | "now" =
      prog.atIdx === alightIdx ? "now" : prog.nextIdx === alightIdx ? "soon" : "none";
    setAlarm(next);
    if (next !== "none" && next !== alarmRef.current) {
      buzz(next === "now" ? [220, 80, 220] : [180, 80, 180]);
    }
    alarmRef.current = next;
  }, [phase, prog, stopMains, buzz]);

  /* 安全网：异常检出（连续 2 次 + 间隔 ≥45s 才显示） */
  useEffect(() => {
    if (phase !== "riding" || !legs[legIndex]) {
      setAnomaly("none");
      anomalyStreakRef.current = 0;
      return;
    }
    const leg = legs[legIndex];
    const latest = fixesRef.current[fixesRef.current.length - 1] ?? null;
    const projDistM =
      latest && leg.colored.length >= 2 ? cutAt(leg.colored, latest).dist : null;
    const advanced =
      progressSource === "gps"
        ? lrtStateRef.current.dist > 0
        : (prog?.passedIdx ?? -1) > 0;
    const a = anomalyOf({
      autoSwitched,
      progressSource,
      fixes: fixesRef.current,
      projDistM,
      advanced,
    });
    const now = Date.now();
    if (a === "none") {
      anomalyStreakRef.current = 0;
      if (anomaly !== "none") setAnomaly("none");
      return;
    }
    if (now - lastAnomalyTsRef.current >= ANOMALY_MIN_GAP_MS) {
      anomalyStreakRef.current += 1;
      lastAnomalyTsRef.current = now;
    }
    if (anomalyStreakRef.current >= ANOMALY_CONFIRM) setAnomaly(a);
  }, [phase, prog, userFix, anomaly, autoSwitched, progressSource, legs, legIndex]);

  /**
   * ★ 本批（需求⑤ / AC-40~44）：**蓝点 + 纵条用户点**（视觉层 = GPS 投影；逻辑层不动）。
   *   · 蓝点：`nearestOnPath` 吸附（≤60m）；投影失败 / accuracy>150 / 无信号 ⇒ **冻结不跳**；
   *   · 纵条：`youAt`（★ v3.2.0 二值 + 驻留）—— 停靠中贴节点（frac 0）/ 行驶中锁两站正中间（frac 0.5）。
   *   ⚠️ 两者**只作视觉**，不参与 `passedIdx/atIdx/nextIdx` 判定（避免两套口径打架）。
   */
  useEffect(() => {
    if (phase !== "riding" || !active) {
      lastGoodDotRef.current = null;
      setYouDot(null);
      setYouAt(null);
      return;
    }
    const leg = legs[legIndex];
    if (!leg || leg.colored.length < 2 || leg.degraded) {
      setYouDot(null);
      setYouAt(null);
      return;
    }

    // ── 蓝点（GPS 投影 + 冻结）──
    let dot: RideYouDot | null = null;
    if (userFix) {
      const accOk = !(Number.isFinite(userFix.accuracy) && userFix.accuracy > YOU_ACC_MAX_M);
      if (accOk) {
        const proj = nearestOnPath(leg.colored, { lng: userFix.lng, lat: userFix.lat });
        if (proj.distM <= YOU_SNAP_MAX_M) {
          const p = leg.colored[proj.idx];
          dot = { lng: p[0], lat: p[1], src: "gps", frozen: false, ts: userFix.ts, accuracy: userFix.accuracy };
          lastGoodDotRef.current = dot;
        }
      }
    }
    if (!dot && lastGoodDotRef.current) dot = { ...lastGoodDotRef.current, frozen: true };
    setYouDot(dot);

    // ── 纵条 youAt（★ v3.2.0 需求 6 / AC-78：**二值 + 驻留**，移除连续插值）──
    const lastIdx = stopMains.length - 1;
    if (!prog || lastIdx < 1) {
      setYouAt(null);
      return;
    }
    if (prog.atIdx !== null) {
      // 停靠中：点贴该站节点（frac = 0）
      setYouAt({ afterIdx: prog.atIdx, frac: 0 });
      return;
    }
    const i0 = prog.passedIdx;
    if (i0 < 0) {
      // 尚未到上车站
      setYouAt({ afterIdx: -1, frac: 0 });
      return;
    }
    // 行驶中：锁「两站正中间」（frac = 0.5）并**驻留** —— 不再随进度微动，
    //   ⇒ 数学上恒与两端节点等距，永不与之重叠（到站/新帧才更新以贴合节点）。
    setYouAt({ afterIdx: i0, frac: 0.5 });
  }, [phase, active, userFix, legs, legIndex, prog, stopMains, listTick, ladderTick]);

  /* ── 操作 ── */
  const start = useCallback(() => {
    setPhase("boarding");
    setLegIndex((i) => (card && i < card.rides.length ? i : 0));
    setNote("");
    setAutoSwitched(false);
    setAutoNote("");
    setAnomaly("none");
    // ★ v3.6.0（架构 §3.1）：**不再清零**冷却 —— 改为从"现在"起算，
    //   即「开始导航后 20s 内不做自动判定」。旧版清零 = 冷却形同不存在。
    autoUsedRef.current = false;
    lastSwitchTsRef.current = Date.now();
    boardStreakRef.current = 0;
    boardingStartedAtRef.current = Date.now(); // ★ 判定启动宽限起点（AC-25a 防首帧闪烁）
    onRequestGps?.(); // ★ 必须在用户手势内申请 GPS（开始导航）
    void acquireWake();
  }, [card, acquireWake, onRequestGps]);

  const stop = useCallback(() => {
    setPhase("off");
    setPlate(null);
    setProg(null);
    setAlarm("none");
    clearTraveled();
    setNote("");
    setCandidates([]);
    alarmRef.current = "none";
    releaseWake();
  }, [releaseWake, clearTraveled]);

  /** 手动上车（弱样式兜底）：锁定候选第 1 / 无候选 → 换车；轻轨 → GPS 驱动 */
  const board = useCallback(() => {
    void (async () => {
      const leg = legs[legIndex];
      if (!leg) return;
      if (leg.kind !== "bus" || !leg.dir) {
        switchToRiding(null, "gps");
        return;
      }
      setTraveling(true);
      try {
        const r = await fetch(
          `/api/route-vehicles?code=${encodeURIComponent(leg.route)}&dir=${encodeURIComponent(leg.dir)}&kind=bus`,
          { cache: "no-store" },
        );
        const j = (await r.json()) as { vehicles?: VehicleLite[] };
        const lites = j.vehicles ?? [];
        listLiteRef.current = lites; // ★ T6：UI 用（含站名 / 末班）
        const list: TrackVehicle[] = lites.map((v) => ({
          plate: v.plate,
          lat: v.lat,
          lng: v.lng,
          status: String(v.status ?? "unknown"),
          interval: v.interval ?? null,
          atStation: v.atStation ?? null,
        }));
        listRef.current = list;
        const boardMain = stopsBoard(strips, legIndex) || mainOf(anchors?.[legIndex]?.board?.code ?? "");
        /* 与轮询帧**同一套候选口径**（锚定 + 过站过滤），否则"手动上车"会锁到已过站的后车 */
        if (!anchorRef.current && list.length) {
          anchorRef.current = anchorOf(list, boardMain, boardPos, { nowMs: Date.now() });
        }
        const ranked = rankBoardingVehicles(list, boardMain, boardPos, {
          filterPassed: true,
          stopMains,
          anchor: anchorRef.current,
        });
        setCandidates(ranked.slice(0, 6).map((v) => ({ plate: v.plate, hint: hintOf(v) })));
        if (!ranked.length) {
          setNote(NOTE_NO_VEHICLES_BOARD);
          return;
        }
        setAutoSwitched(false);
        setAutoNote("");
        setPhase("riding");
        setPlate(ranked[0].plate);
        setProgressSource("vehicle");
        /* ★ v3.7.0 S3：用户显式标记上车 ⇒ `manual`（与自动判定的 `auto` 可区分） */
        setBoardMatch("manual");
        setMatchSource("manual");
        setMatchPending(false);
        setPendingPlate(null);
        ridingStartIdxRef.current = -1;
        setListTick((t) => t + 1);
        ladderRef.current = null;
        void ensureLadder(); // ★ 本批：手动上车也建阶梯（youAt / 自动下车）
      } catch {
        setNote("车辆数据获取失败，请稍后重试");
      } finally {
        setTraveling(false);
      }
    })();
  }, [legs, legIndex, strips, boardPos, anchors, stopMains, switchToRiding, ensureLadder]);

  const repick = useCallback((p: string) => {
    setPlate(p);
    setProgressSource("vehicle");
    /* ★ v3.7.0 S3：纠错后重锁 ⇒ `corrected`（测试据此断言「不是这辆」真的生效） */
    setBoardMatch("corrected");
    setMatchSource("vehicle");
    setMatchPending(false);
    setPendingPlate(null);
    missRef.current = 0;
    setNote("");
    setProg(null);
    clearTraveled();
    boardStreakRef.current = 0;
    lastSwitchTsRef.current = Date.now();
  }, [clearTraveled]);

  /**
   * 下车推进（手动 / 自动共用）。
   * @param auto 自动判定触发 —— `true` 时保存撤销快照 + 置瞬态 `justAlighted`（≤5s）
   */
  const doAlight = useCallback(
    (auto: boolean) => {
      const total = card?.rides.length ?? 1;
      if (auto) {
        // ★ 撤销快照（在推进**前**保存）
        undoRef.current = {
          legIndex,
          phase,
          plate,
          prog,
          traveled,
          candidates,
          progressSource,
          ladder: ladderRef.current,
          lrtState: { ...lrtStateRef.current },
        };
        setJustAlighted(true);
        if (justAlightedTimerRef.current) window.clearTimeout(justAlightedTimerRef.current);
        justAlightedTimerRef.current = window.setTimeout(() => {
          setJustAlighted(false);
          justAlightedTimerRef.current = null;
        }, JUST_ALIGHTED_MS);
      }
      setProg(null);
      clearTraveled();
      setAlarm("none");
      alarmRef.current = "none";
      setPlate(null);
      setAnomaly("none");
      setAutoSwitched(false);
      setAutoNote("");
      anomalyStreakRef.current = 0;
      vehicleRef.current = null;
      missRef.current = 0;
      /**
       * ★ S4 评审 advisory 2：换腿瞬间**必须清空上一腿的车队**。
       *   否则新一段的 boarding effect 跑起来之前，`mapVehicles` 会拿上一腿的车渲染 1 帧
       *   （表现为"换乘站台上闪一下别的线路的车"）。effect 后自愈，但仍该清。
       */
      listRef.current = [];
      listLiteRef.current = []; // ★ T6：UI 侧车队同步清空（换乘站台上闪别人车的同一处）
      anchorRef.current = null; // ★ 换腿 ⇒ 锚定车必须重取（每段站序不同，旧锚毫无意义）
      lastCompanyRef.current = null;
      ladderRef.current = null;
      lrtStateRef.current = { passedIdx: -1, computed: -1, dist: 0, ts: 0, badStreak: 0 };
      alightStreakRef.current = 0;
      boardStreakRef.current = 0;
      buzz([120, 60, 120]);
      if (legIndex + 1 < total) {
        setLegIndex((i) => i + 1);
        setPhase("boarding");
        autoUsedRef.current = false;
        /**
         * ★ 冷却复位：策略由 `nextLegCooldownOf` 决定（纯函数 + 有断言，别在这里内联判断）。
         *   默认**归零**（与 `start()` 的「不清零」相反，勿"统一"成 `Date.now()`）：
         *   下一段是全新行程（用户刚下车、就在换乘站台）⇒ 上车判定应**立刻可用**。
         *   唯一例外 = `auto && progressSource === "gps"`（GPS 源自动下车）⇒ 保留冷却，
         *   理由见 `nextLegCooldownOf` 的注释（无车牌可核、判错无法纠正）。
         *
         * 启动宽限另行打点（下一行）—— 两件事不冲突：宽限防"首帧未到的误报"，
         * 冷却决定"新段多久后才能被判上车"。
         */
        lastSwitchTsRef.current =
          nextLegCooldownOf({ auto, progressSource }) === "now" ? Date.now() : 0;
        boardingStartedAtRef.current = Date.now(); // ★ 下一段同样有启动宽限（防首帧闪烁）
        setNote("");
      } else {
        setPhase("done");
        releaseWake();
      }
    },
    [card, legIndex, phase, plate, prog, traveled, candidates, progressSource, buzz, releaseWake, clearTraveled],
  );

  /** 手动「我已下车」 */
  const alight = useCallback(() => doAlight(false), [doAlight]);

  /** ★ 本批：撤销自动下车（仅最后一次自动下车可撤销；撤销后清空快照） */
  const onUndoAlight = useCallback(() => {
    const u = undoRef.current;
    if (!u) return;
    undoRef.current = null;
    if (justAlightedTimerRef.current) {
      window.clearTimeout(justAlightedTimerRef.current);
      justAlightedTimerRef.current = null;
    }
    setJustAlighted(false);
    setLegIndex(u.legIndex);
    setPhase(u.phase);
    setPlate(u.plate);
    setProg(u.prog);
    setTraveled(u.traveled);
    /**
     * ★ T7：撤销恢复的是**点数组**，无法反推 `idx` ⇒ 游标置空。
     *   若沿用当前游标（属于已下车的那一段之后的状态）⇒ `shrink`/`backward` 会把后续每帧
     *   都拒掉 ⇒ 恢复后灰线永久不再增长。置空后下一帧走 `first` 重新锚定，最坏丢一帧。
     */
    traveledCurRef.current = null;
    traveledShownRef.current = !!u.traveled && u.traveled.length >= 2;
    setTraveledAttr(traveledShownRef.current ? "ok" : "none");
    setCandidates(u.candidates);
    setProgressSource(u.progressSource);
    setAlarm("none");
    alarmRef.current = "none";
    setAnomaly("none");
    anomalyStreakRef.current = 0;
    alightStreakRef.current = 0;
    boardStreakRef.current = 0;
    ladderRef.current = u.ladder;
    lrtStateRef.current = { ...u.lrtState };
    autoUsedRef.current = true; // 撤销后不再自动（防抖）
  }, []);

  /**
   * ★ v3.6.0 S4：车辆数据刷新的冷却（时间戳口径，5s）。
   *   **作用域局部** —— 只挡「巴士车辆数据刷新」，不影响定位刷新、
   *   步行进度推进、步行路径重算（各自独立成本，混用会误伤）。
   */
  const vehicleCooldown = useCooldown(COOLDOWN_VEHICLE_SEC);

  /**
   * ★ v3.6.0 S4：手动刷新（走**同一通道** `fetchFrame`，受 5s 冷却门控）。
   *   · 旧 `onRefresh` 直接调 `fetchFrame` ⇒ 连点即连发（后端成了唯一防线）；
   *   · 现在点下就起算冷却，与请求快慢无关（旧版「冷却」实为一次 HTTP 往返 ≈1s，
   *     用户看到的「一秒冷却一次」即由此而来）。
   *   ★ 评审阻断 ③：**轻轨段不进冷却** —— `fetchFrame` 对非 bus 腿直接 return（刷不出
   *     任何东西），进了冷却就是"给了一个什么都不会发生的倒计时"（设计 §2.6 明令禁用）。
   * @returns 是否真的发起了请求（`false` = 冷却中 / 非巴士段，被拦下）
   */
  const refreshNow = useCallback((): boolean => {
    if (vehicleCooldown.cooling) return false;
    /** 当前腿是否巴士：轻轨段刷新无意义 ⇒ 早退且**不 start 冷却** */
    const leg = legs[legIndex];
    const isBus = leg ? leg.kind === "bus" : false;
    if (!isBus) return false;
    if (phase === "riding" && plate) void fetchFrame(plate);
    else if (phase === "boarding") void fetchFrame(null);
    else return false;
    vehicleCooldown.start();
    return true;
  }, [vehicleCooldown, phase, plate, fetchFrame, legs, legIndex]);

  /** 兼容旧调用点：`onRefresh` = `refreshNow`（面板顶栏与品牌栏都用它） */
  const onRefresh = useCallback(() => {
    void refreshNow();
  }, [refreshNow]);

  /** 安全网纠错：「我没上车」→ 回等车（保留方案） */  const onNotBoard = useCallback(() => {
    setPhase("boarding");
    setPlate(null);
    /* ★ v3.7.0 S3：「我没上车」⇒ 匹配态归零（回等车态重新开始，历史与排除名单保留在本段内） */
    setBoardMatch("none");
    setMatchSource("gps");
    setMatchPending(false);
    setPendingPlate(null);
    setProg(null);
    clearTraveled();
    setAlarm("none");
    setAnomaly("none");
    setAutoSwitched(false);
    setAutoNote("");
    alarmRef.current = "none";
    anomalyStreakRef.current = 0;
    ladderRef.current = null;
    lastSwitchTsRef.current = Date.now();
    boardingStartedAtRef.current = Date.now(); // ★ 回到等车态同样有启动宽限
    autoUsedRef.current = true; // 冷却后再允许自动
  }, [clearTraveled]);

  /** 「还没到」→ 清除到站提醒，回乘车中 */
  const onNotArrive = useCallback(() => {
    setAlarm("none");
    alarmRef.current = "none";
    anomalyStreakRef.current = 0;
    setAnomaly("none");
  }, []);

  /** 「不是这辆」→ 换候选第 1（无候选 → 回等车） */
  const onNotThisBus = useCallback(() => {
    /**
     * ★ v3.7.0 S3：把当前车牌登记为「已排除」——匹配算法的不变量要求排除名单
     *   **不得复用**（同一段里被否掉的车不能再被选回来）。放在这里而不是 `repick` 里，
     *   因为 `repick` 也服务「手动选车」，那种情况不是否定。
     */
    if (plate) matcherRef.current?.exclude(plate);
    const cand = candidates.find((c) => c.plate !== plate) ?? null;
    if (cand) repick(cand.plate);
    else onNotBoard();
  }, [candidates, plate, repick, onNotBoard]);

  const onDismissAnomaly = useCallback(() => {
    setAnomaly("none");
    anomalyStreakRef.current = 0;
  }, []);

  /**
   * ★ 本批（需求⑨ / AC-55）：**全自动下车** effect。
   *   · 车辆源：车停靠本段下车站（多帧确认）；GPS 源：沿线里程越过下车站 ≥30m；
   *   · 环线（首尾同站）恒不判；冻结（丢信号 / 车辆丢失 3 帧 / 轻轨 badStreak≥2）不判；
   *   · 命中 ⇒ `doAlight(true)`（保存撤销快照 + 瞬态反馈）。
   */
  useEffect(() => {
    if (phase !== "riding" || !active) return;
    const leg = legs[legIndex];
    if (!leg) return;
    const stopMainsLocal = strips?.[legIndex]?.stops.map((s) => mainOf(s.code)) ?? [];
    const lastIdx = stopMainsLocal.length - 1;
    const loop = stopMainsLocal.length > 1 && stopMainsLocal[0] === stopMainsLocal[lastIdx];
    const frozen =
      progressSource === "vehicle" ? missRef.current >= MISS_LIMIT : lrtStateRef.current.badStreak >= 2;
    const dNow = progressSource === "gps" ? (lrtStateRef.current.dist > 0 ? lrtStateRef.current.dist : null) : null;
    const dAlightRaw = ladderRef.current ? ladderRef.current.ladder[lastIdx] : undefined;
    const dAlight = typeof dAlightRaw === "number" && Number.isFinite(dAlightRaw) ? dAlightRaw : null;
    const r = autoAlightOf({
      source: progressSource,
      lastIdx,
      atIdx: prog?.atIdx ?? null,
      passedIdx: prog?.passedIdx ?? -1,
      dNow,
      dAlight,
      loop,
      frozen,
      streak: alightStreakRef.current,
    });
    alightStreakRef.current = r.streak;
    if (r.hit) doAlight(true);
  }, [phase, active, prog, userFix, legIndex, progressSource, strips, legs, doAlight]);

  return {
    phase,
    legIndex,
    plate,
    prog,
    alarm,
    traveled,
    traveling,
    boardDetect: phase === "boarding" && boardPaused ? "paused" : "on",
    refreshCoolingSec: vehicleCooldown.sec,
    /**
     * ★ v3.6.0（AC-25a）：paused 时**强制覆盖**提示文案 —— 不能把"未判定"渲染成"正在检测"。
     *   放在返回值里派生（而非塞进 `note` state）：候车轮询会不断改写 `note`，
     *   写进 state 会被 `NOTE_NO_VEHICLES` / `NOTE_FETCH_FAIL` 覆盖掉。
     * ★ v3.7.0 S2（AC2.3）：再按**定位轴状态**分档 —— 拒权/无信号/超时三种情况用户要做的事
     *   完全不同（去设置 / 走两步 / 再等），一句「定位不可用」说不清。见 `noteOfPausedGeo`。
     */
    note: phase === "boarding" && boardPaused ? noteOfPausedGeo(geo) : note,
    candidates,
    autoSwitched,
    autoNote,
    progressSource,
    boardMatch,
    matchSource,
    matchPending,
    pendingPlate,
    anomaly,
    lastVehicleTs,
    lastFixTs,
    youDot,
    youAt,
    mapVehicles,
    justAlighted,
    segProgress: phase === "riding" ? segProgress : null,
    onStart: start,
    onStop: stop,
    onBoard: board,
    onRepick: repick,
    onAlight: alight,
    onRefresh,
    onNotBoard,
    onNotArrive,
    onNotThisBus,
    onDismissAnomaly,
    onUndoAlight,
  };
}

/** 兜底：从 strips 里取本段上车站主码 */
function stopsBoard(strips: SegmentStrip[] | null, legIndex: number): string {
  const s = strips?.[legIndex];
  return s?.stops?.[0]?.code ? mainOf(s.stops[0].code) : "";
}
