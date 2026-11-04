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
  distToBoardM,
  mainOf,
  monotonicCut,
  progressOf,
  rankBoardingVehicles,
  type BoardAnchor,
  type MonoCutState,
  type TrackProgress,
  type TrackVehicle,
} from "@/lib/nav/track";
import { advanceLrt, buildLrtLadder, type LrtLadder } from "@/lib/nav/lrt-progress";
import { cumDistM, distM, nearestOnPath } from "@/lib/nav/route-overview";
import { autoAlightOf } from "@/lib/nav/alight-detect";
import { ladderStateOf, rideNoteOf, type LadderState } from "@/lib/nav/ride-note";
import {
  ANOMALY_CONFIRM,
  ANOMALY_MIN_GAP_MS,
  AUTO_TRIES_PER_LEG,
  autoBoardOf,
  anomalyOf,
  candAtStopOf,
  detectPausedOf,
  nextLegCooldownOf,
  positionEvidenceOf,
  type Anomaly,
  type BoardEvidence,
  type CandAtStop,
  type FixLite,
} from "@/lib/nav/boarding-detect";
import type { VehFrame } from "@/lib/nav/follow-frames";
import type { LL, ColoredLeg, OverviewLegInput } from "@/lib/nav/route-overview";
import type { RecommendCard, SegmentStrip } from "@/lib/recommend/types";
import { COOLDOWN_VEHICLE_SEC, useCooldown } from "./useCooldown";
import type { VehicleLite } from "./VehicleMarker";
import type { UserFix } from "./useUserFix";
import { inflightGate, noteVehFail, noteVehFrame, registerVehSentinel, retainVehTicker, setYouDotHook, shouldForceRefresh } from "./observe-hooks";
import { useResumeRefresh } from "./useResumeRefresh";
import { createVehicleMatcher, usableMedium } from "./vehicle-match-run";
import { MATCH_VEHICLE_ENABLED } from "@/lib/nav/match-vehicle";
import type { GeoState } from "./observe-hooks";
import { noteOfPausedGeo } from "./geo-note";

/** 轮询间隔（毫秒）——与官网地图 15s 刷新同量级 */
const POLL_MS = 12_000;
/**
 * ★ 需求5 L3：单次车辆请求的超时（ms）。
 *
 * 为什么必须有：`fetch` 本身**没有超时**。熄屏整页冻结时请求可能永远不 settle ⇒
 * 它的 `finally` 不执行 ⇒ 「请求在飞」这个标记永久为真 ⇒ 解冻后所有补刷被吞。
 * 8s 的依据：正常往返 < 1s（同城 API），8s 已远超任何"慢但活着"的情况，
 * 又把「悬挂」变成「确定失败」——失败会走 `noteVehFail` 且允许下一轮立刻重试。
 */
const FETCH_TIMEOUT_MS = 8_000;

/**
 * ★ 需求5 L2：哨兵补刷的最小间隔（ms）—— 防「请求持续失败」时的每秒重试风暴。
 * 取值 > `FETCH_TIMEOUT_MS` 的语义面：一次补刷从发出到确定失败最多 8s，
 * 8s 内不再补第二次，避免请求叠在同一个悬挂请求上。
 */
const SENTINEL_KICK_MIN_MS = 8_000;

/**
 * ★ 需求6：三区判别的两个几何门（米）。
 *   · `BOARD_NEAR_M = 40`：到上车站的**直线**距离在此内 ⇒ 视为「已到站/刚上车」；
 *   · `BOARD_ALONG_CLEAR_M = 60`：沿线上车站起算的**沿线**里程超此值 ⇒ 视为「已随车离开」。
 * 二者与既有判定阈值（速度门 8km/h、位移门 60m、45s 窗口）**没有任何关系，也不得联动调整**。
 */
const BOARD_NEAR_M = 40;
const BOARD_ALONG_CLEAR_M = 60;
/** ★ 需求6：区②（仍在走近站台）的加严帧数 —— 每帧 3s ⇒ 精确等价 +6.0s（不是 3s） */
const BOARD_WALK_EXTRA_FRAMES = 2;
/** 连续丢信号判定（次）——达到即提示（进度保持冻结） */
const MISS_LIMIT = 3;
/** GPS 采样窗口保留时长（ms） */
const FIX_KEEP_MS = 90_000;
/**
 * ★ I-3：车辆帧历史保留条数（8 条 ≈ 96s，覆盖 12s 轮询 + 一次恢复补刷）。
 *   与 `FIX_KEEP_MS` 同量级：`followFramesOf` 的窗口上限 30s，8 条足够两端内插。
 */
const VEH_HIST_KEEP = 8;
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

/**
 * ★ 2026-11-05：**本次 riding 是靠什么进入的**（`RideTrackView.enteredVia`）。
 *
 * 为什么必须与 `boardedByPosition` 分开成两个量（不能合成一个布尔）：
 *   停站判据上线后，「进入 riding」不再等价于「人已在车上」——
 *   车一到站就切，用户可能还在跑。消费方（赶车标签锁存）要的条件是
 *   「进入 riding **且** 有位置证据（或用户手动确认）」，而不是「进入 riding」。
 *   · `station`  = 车停靠用户上车站（**无**位置证据）
 *   · `position` = r2 / 跟车斜率判据（**有**位置证据）
 *   · `manual`   = 用户点「我已上车」（用户本人断言，视同证据充分）
 */
export type BoardEntry = "station" | "position" | "manual";

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
  /**
   * ★ 2026-11-04（设计 §2.10）：**停站期候选车牌** —— 「来的是哪辆车」。
   *
   * 与 `candidates` 的区别（**不要互相替代**）：
   *   · `candidates` = 候车候选**列表**（最多 6 条，含 `hint` 文案），供"手动标记上车"选车；
   *   · `candAtStop` = 仅回答「**现在能不能确定地指出一辆**」：
   *       `unique`（正停本站且只有 1 辆）/ `strong`（刚离站且 ≤60m）才给车牌；
   *       `ambiguous`（停 2 辆以上 / 证据矛盾）/ `none` ⇒ 车牌为 `null` ⇒ 界面不显示。
   *
   * ⚠️ 它**不含**相位与新鲜度语义：`null` = 本帧没算（未到候车期 / 非巴士段），
   *    「帧已过期 ⇒ 不显示」由消费方按 `lastVehicleTs` 判（见 `NavDetailBody.candViewOf`）。
   *    这样纯函数层只管几何、展示层只管时间，两边不互相污染。
   */
  candAtStop: CandAtStop | null;
  /** 本次 riding 是否由自动判定进入 */
  autoSwitched: boolean;
  /**
   * ★ 2026-11-05：本次 riding 的**进入方式**（`null` = 不在 riding）。见 `BoardEntry`。
   * ⚠️ 消费方（赶车标签锁存）**不得**只用本字段决定隐藏，必须与 `boardedByPosition` 配合：
   *   车停靠上车站就切 riding 之后，人可能还在跑，此时隐藏赶车标签会在最需要它的时候消失
   *   （负责人裁决：「加上位置证据再隐藏」）。
   */
  enteredVia: BoardEntry | null;
  /**
   * ★ 2026-11-05：**位置证据是否已到达**（本次 riding 内一旦为真不再回退）。
   *   `enteredVia === "station"` 时它从 `false` 起，随用户移动、r2 或跟车斜率判据成立后
   *   **在进入 riding 之后**翻真 —— 这才是「可以隐藏赶车标签」的时刻。
   */
  boardedByPosition: boolean;
  /**
   * ★ 2026-11-05：**参照车距上车站的直线距离（米）**；`null` = 无参照车（无牌）或未知。
   *
   * 用途：给「`enteredVia === "station"` 但用户其实没上车」的滞留风险做兜底 ——
   *   车已驶离上车站足够远而 `boardedByPosition` 仍未成立 ⇒ 可判"没上这班车"。
   * ⚠️ 直线距离（非沿线里程）；⚠️ 无牌时恒 `null`，**不要**当 0 或 Infinity 用。
   * ⚠️ 阈值由消费方定，本引擎不给建议值（避免判定层把自己的口径渗进展示层）。
   */
  refVehDistToBoardM: number | null;
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
  /**
   * ★ U3：车辆帧**明确停靠**在本段某站（`prog.kind === "at"` 且 `status === "stopping"`）。
   *
   * 语义只有一个：**本帧「到下一站（基准站）」的首跳剩余已经走完** ⇒ `/api/nav/remaining`
   * 的 `segRemainSec` 必须显式传 `0`（见 `lib/nav/track.ts#segRemainSecOf`）。
   * ⚠️ 不要用 `segProgress === null` 代替：那同时意味着「车丢了」，当停靠用会把剩余算成 0。
   */
  stoppedAtStation: boolean;
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

/**
 * ★ 本批（A-1 / C2 触发率量测）：**阶梯状态**观测钩子。
 *
 *   · `body[data-ladder-state]` ∈ `built | no-geometry | no-stops | idle`
 *     —— **对外承诺的契约**，QA 浏览器断言直接读它，**不得改名 / 不得改取值集**；
 *   · `body[data-colored-len]` = 当前腿几何点数（整数串）—— 用来回答
 *     「离能建梯还差几个点」，单看 `no-geometry` 分不出差 0 还是差 1。
 *
 * `state === null` ⇒ 两个属性**一起摘除**（组件卸载 / 会话结束），
 * 避免下一轮会话读到上一轮的陈旧值。
 */
function setLadderHook(state: LadderState | null, coloredLen: number) {
  if (typeof document === "undefined") return;
  try {
    if (state == null) {
      document.body.removeAttribute("data-ladder-state");
      document.body.removeAttribute("data-colored-len");
      return;
    }
    document.body.setAttribute("data-ladder-state", state);
    document.body.setAttribute("data-colored-len", String(coloredLen));
  } catch {
    /* SSR / 只读 body —— 观测钩子失败不得影响导航 */
  }
}

/**
 * ★ I-3（2026-11-04）：**上车判定诊断**观测钩子（QA 用 `body[...]` 断言）。
 *
 * 为什么必须新增：既有 `data-board-match` / `data-match-source` 只能表达「锁没锁上牌」，
 * 无法区分三种完全不同的失败：
 *   ① **没机会**（无候选车 / 车没动）        ⇒ `data-board-evidence=none|station`
 *   ② **有机会但没锁上**（多车歧义）        ⇒ `data-board-evidence=station` + `data-plate-state=none`
 *   ③ **判上了但 UI 没显示**（渲染链路问题）⇒ `data-plate-state=locked` + `data-plate-ts`
 *
 * 取值：
 *   · `data-plate-state`   ∈ `none | locked` —— 「本帧**有没有可锁的牌**」：
 *      `none` = 没机会（无候选车）或多车歧义锁不上；`locked` = 有牌可锁。
 *      是否**真的**落库看 `data-plate-ts`（有值 = 已进入乘坐态并锁牌，两者成对出现）。
 *   · `data-board-evidence`∈ `slope | r2 | station | none`（本帧**最强可用证据**，≠ 一定命中）
 *   · `data-follow-slope`  = 相对距离斜率（m/s，2 位小数）—— **本根因的直接观测量**：
 *      ≈0 = 与车同步（已上车）；≈3.3 = 在站台、车在开走。**无样本时该属性不存在**（不是写 0）
 *   · `data-plate-ts`      = 锁牌时刻（epoch ms）—— 用来核对「判定与锁牌是否同帧」
 *
 * ⚠️ 成对写入 / 清理：`v == null` ⇒ 四个属性**一起摘除**；调用点在
 *    `tryAuto`（每帧写）与「phase 落到 off/done / 组件卸载」（清）。`boarding`/`riding`
 *    期间**不**清 —— 否则切到 riding 的那一瞬间就把「锁上了」擦掉，钩子等于没加。
 *    与 `setLadderHook` 同一纪律（不得让下一轮会话读到上一轮的陈旧值）。
 */
function setBoardDiagAttr(
  v: { plateState: "none" | "locked"; evidence: BoardEvidence; slope: number | null; plateTs: number | null } | null,
) {
  if (typeof document === "undefined") return;
  try {
    if (v == null) {
      document.body.removeAttribute("data-plate-state");
      document.body.removeAttribute("data-board-evidence");
      document.body.removeAttribute("data-follow-slope");
      document.body.removeAttribute("data-plate-ts");
      return;
    }
    document.body.setAttribute("data-plate-state", v.plateState);
    document.body.setAttribute("data-board-evidence", v.evidence);
    if (v.slope == null) document.body.removeAttribute("data-follow-slope");
    else document.body.setAttribute("data-follow-slope", v.slope.toFixed(2));
    if (v.plateTs == null) document.body.removeAttribute("data-plate-ts");
    else document.body.setAttribute("data-plate-ts", String(Math.round(v.plateTs)));
  } catch {
    /* SSR / 只读 body —— 观测钩子失败不得影响导航 */
  }
}

/**
 * ★ 需求5 L3：超时信号（有则用，无则退化为"没有信号"）。
 *
 * 为什么不直接在调用点写 `AbortSignal.timeout(ms)`：Safari 16 以下 / 部分 WebView 没有
 * 这个静态方法，直接调会抛 `TypeError` 并被外层 `catch` 吞成"请求失败"——
 * 那样连一次请求都发不出去，比不设超时更糟。这里显式探测后再用。
 */
function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    const Sig = typeof AbortSignal !== "undefined" ? AbortSignal : null;
    if (Sig && typeof Sig.timeout === "function") return Sig.timeout(ms);
  } catch {
    /* 老引擎：无超时，靠 inflight 租约 + 哨兵兜底 */
  }
  return undefined;
}

/**
 * ★ 需求6（2026-11-03）：上车判定**需要多少连续命中帧** —— 三区判别（纯函数，可单测）。
 *
 * ── 为什么不再看 `walkActive` 这个**状态** ────────────────────────────
 *   上一版（`92a8912`）为了防「沿公交线路跑步/骑行被误判成乘车」，写成
 *   `need + (walkActive ? 2 : 0)`。两个问题：
 *     ① 实测代价是**精确 +6.0 秒**（不是注释里写的 3s —— 那是把 2 帧当 1 帧算错了）；
 *     ② 它只在「上车那一刻人还在步行段」才生效。正常走到站台（`arrived` 先触发、
 *        `walkSeg` 已清空）时 `+2` **根本不生效**，而赶车提前上车 / 定位精度冻结导致
 *        `arrived` 不来 / 走偏导致 `remainM` 冻结 —— 这三种场景 `walkActive` 都判不准。
 *   ⇒ 真正的判据不是状态，是**位置**：人到上车站的沿线距离。
 *
 * ── 三区（`colored[0]` 恒为上车站，这是既有契约）──────────────────────
 *   ```
 *   区① 已到站/刚上车： dToBoard ≤ 40m                        ⇒ need = 基准（不加严）
 *   区② 仍在走近站台：  dToBoard > 40m 且 alongM < 60m          ⇒ need = 基准 + 2
 *   区③ 已随车离开：    alongM ≥ 60m                           ⇒ need = 基准（不死锁）
 *   ```
 *   人还没到站时**不在** `colored` 上（colored 从上车站开始）⇒ 投影被钳到 `idx=0`、
 *   `alongM≈0` ⇒ 落区②，正是"跑步赶车"要加严的那一类；一旦沿线里程过了 60m，
 *   说明人已在线路下游（是在车上，不是走路赶车）⇒ 退回基准，不再额外罚 6 秒。
 *
 * ⚠️ 只改「帧数」这一个自由度：速度门 8km/h / 位移门 60m / 45s 窗口、以及
 *   `res.need`（2 或 3，由车辆佐证决定）**一个都不动** —— 那些常量已被双向实测过。
 *
 * @param baseNeed `autoBoardOf` 返回的 `need`（有车辆佐证 2 / 纯定位 3）
 * @param colored  本段乘车区间折线（`colored[0]` = 上车站）
 * @param boardPos 上车站坐标（缺省 ⇒ 无法分区 ⇒ 按基准，宁快不慢）
 * @param fix      最新一帧用户定位（缺省 ⇒ 同上）
 */
export function boardNeedOf(o: {
  baseNeed: number;
  colored: LL[];
  boardPos: { lng: number; lat: number } | null;
  fix: { lng: number; lat: number } | null;
}): number {
  const { baseNeed, colored, boardPos, fix } = o;
  if (!fix || !boardPos || colored.length < 2) return baseNeed;
  const dToBoard = distM([fix.lng, fix.lat], [boardPos.lng, boardPos.lat]);
  if (dToBoard <= BOARD_NEAR_M) return baseNeed; // 区①
  // 只有在"还没到站"时才需要付投影代价（区①占多数帧 ⇒ 常见路径零额外开销）
  const proj = nearestOnPath(colored, fix);
  const cum = cumDistM(colored);
  const alongM = cum[Math.min(proj.idx, cum.length - 1)] ?? 0;
  if (alongM >= BOARD_ALONG_CLEAR_M) return baseNeed; // 区③
  return baseNeed + BOARD_WALK_EXTRA_FRAMES; // 区②
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
  const [phase, setPhase] = useState<RidePhase>("off");
  const [legIndex, setLegIndex] = useState(0);
  const [plate, setPlate] = useState<string | null>(null);
  const [prog, setProg] = useState<TrackProgress | null>(null);
  /**
   * ★ U3：本帧车辆是否**明确停靠在**本段某站（供 `/api/nav/remaining` 的 `segRemainSec` 用）。
   *
   * ── 为什么必须是独立信号，不能拿 `segProgress` 缺失代替 ──────────────────
   *   `attachProgress` 只给 `status === "moving"` 的车挂 `progress`（`progress.ts:201`），
   *   而 `segProgress === null` 同时覆盖「车停靠中」「车数据丢了」「几何/里程表缺行」三种情况。
   *   拿缺失当停靠 ⇒ 把「丢车」也说成「到站」，剩余时间被**静默**算成 0。
   *
   * ── 取值条件（刻意比 `v.atStation` 严一格）────────────────────────────
   *   `progOfFrame.kind === "at"` **且** `v.status === "stopping"`：
   *   · `kind === "at"` 已含「`atStation` 命中**本段站序**」这一必要条件 ——
   *     直接用 `!!v.atStation` 会把「停在本段站序之外的站」（如已驶过的上车站后方）也算进来；
   *   · `status` 再排除 `terminal`（总站待发还没进入本次行程）。
   */
  const [stoppedAtStation, setStoppedAtStation] = useState(false);
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
  /**
   * ★ 2026-11-04（设计 §2.10）：停站期候选车牌（只回答"能不能确定地指出一辆"）。
   *   `null` = 本帧没算（未到候车期 / 非巴士段 / 已清场）；「帧过期 ⇒ 不显示」由消费方判。
   */
  const [candAtStop, setCandAtStop] = useState<CandAtStop | null>(null);
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
  /** ★ 2026-11-05：本次 riding 的进入方式（`null` = 不在 riding）。见 `BoardEntry`。 */
  const [enteredVia, setEnteredVia] = useState<BoardEntry | null>(null);
  /**
   * ★ 2026-11-05：**位置证据是否已成立**（本次 riding 内的当前值）。
   *   一旦为真就不再回退（证据一旦获得不会消失），也**不再重复计算**（省投影开销）。
   */
  const [boardedByPosition, setBoardedByPosition] = useState(false);
  /**
   * ★ 2026-11-05：**参照车距上车站的直线距离（米）**（`RideTrackView.refVehDistToBoardM`）。
   *
   * ── 为什么需要它（fe-nav-ui 报的滞留风险）──────────────────────────────
   *   `enteredVia === "station"` 切进 riding 后，若用户其实**没上车**（车来了但没挤上），
   *   则 `boardedByPosition` 永不翻真 ⇒ 赶车标签会一直显示「小跑能赶上」= 新的滞留缺陷。
   *   兜底判据不能靠"自创时间阈值"，要用物理信号：**车已驶离上车站足够远，位置证据却仍未成立
   *   ⇒ 用户没上这班车**。
   *
   * ── 量本身怎么来的（不是临时造的）────────────────────────────────────
   *   用**现成**的 `track.ts#distToBoardM(v, boardPos)`（线路几何已有，`boardPos`
   *   来自 `anchors[legIndex].board`，同一个值候车期就在用）+ 已锁的参照车 `vehicleRef`。
   *   ⇒ 零新增几何计算、零新增请求，只在既有 `fetchFrame` 的 riding 分支里多算一次 `hypot`。
   *
   * ⚠️ **直线距离，不是沿线里程**。对「是否已驶离」这个单调判断够用（绕路时直线仍单调增），
   *   但**不要**拿它当"车走了多远"的精确值用。
   * ⚠️ **无牌 riding（多车歧义）时恒为 `null`** —— 参照车未知，如实留空，不猜。
   *   消费方遇到 `null` 时应视为「本兜底判据不可用」，**不要**当成 0 或 Infinity。
   */
  const [refVehDistToBoardM, setRefVehDistToBoardM] = useState<number | null>(null);
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
  /**
   * ★ I-3（I1）：**车辆帧历史**（每次成功往返 push 一条，只留末尾 `VEH_HIST_KEEP` 条）。
   *   用途：`followFramesOf` 要在「两帧车辆快照之间」内插出 `v(t)`，把车辆里程对齐到
   *   用户定位的时间戳；没有这段历史，`d(t)` 会按车速锯齿增长 ⇒ 斜率判据恒失效。
   */
  const vehHistRef = useRef<VehFrame[]>([]);
  /** 自动判定状态（冷却 / 本腿剩余次数） */
  const lastSwitchTsRef = useRef(0);
  /**
   * ★ I-3（I4）：本腿**剩余**自动判定次数（初值 `AUTO_TRIES_PER_LEG = 2`）。
   *   为什么不再是布尔：旧版点一次「我没上车」就把本段自动判定**永久关闭**
   *   （`autoUsedRef.current = true` 之后 boarding 期间无任何复位路径，注释却写
   *   「冷却后再允许自动」—— 承诺了代码没有的东西）。现在每次自动上车消耗 1 次，
   *   用户仍可纠正 2 次；用尽后只剩手动/纠错入口（如实，不假装还能自动）。
   */
  const autoUsedLeftRef = useRef(AUTO_TRIES_PER_LEG);
  /** ★ I-3：锁牌时刻（`data-plate-ts` 的值源；`0` = 当前无牌） */
  const plateLockedTsRef = useRef(0);
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
  /**
   * ★ 需求5 L2：**上一次成功往返**（请求发出 → 拿到可解析的响应体）的时刻。
   *
   * ⚠️ 这是哨兵的**唯一锚点**，三条纪律：
   *   ① 必须**无条件**写（成功即写），与"帧内容有没有变化"无关 —— 若拿
   *      `observe-hooks` 的 `lastVehTs` 当锚点，车没动时它不前进，会把「数据没变」
   *      误判成「数据过期」，每 30s 白刷一次；
   *   ② 初值**必须**是 `Date.now()`（不能 0）—— 否则首个心跳立刻判定"从未成功"并补刷；
   *   ③ 失败**不写**（失败不是往返），这样哨兵才能在持续失败后继续重试。
   */
  const lastRoundTripAtRef = useRef(Date.now());
  /** ★ 需求5 L2：上次哨兵补刷时刻（0 = 还没补过）—— 抑制"请求持续失败 ⇒ 每秒补刷"风暴 */
  const lastSentinelKickAtRef = useRef(0);

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
    setEnteredVia(null); // ★ 2026-11-05：会话重置（否则下一段带着上一段的进入方式）
    setBoardedByPosition(false);
    setRefVehDistToBoardM(null);
    matcherRef.current?.reset();
    vehicleRef.current = null;
    missRef.current = 0;
    alarmRef.current = "none";
    listRef.current = [];
    listLiteRef.current = []; // ★ T6：UI 侧车队同步清空（否则换腿瞬间闪一下上一腿的车）
    anchorRef.current = null; // ★ 锚定车只对「本段本次候车」有效
    ladderRef.current = null;
    lrtStateRef.current = { passedIdx: -1, computed: -1, dist: 0, ts: 0, badStreak: 0 };
    vehHistRef.current = []; // ★ I-3：车辆帧历史随会话一起清（跨段混用的内插毫无意义）
    autoUsedLeftRef.current = AUTO_TRIES_PER_LEG;
    plateLockedTsRef.current = 0;
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
    /** ★ 观测钩子同步清空：`reset()` 可能不伴随 `active` 变化（如换 `card`），
     *  只靠下方 effect 的分支清理会留下上一段的 `data-you-dot`（过期钩子型假绿）。 */
    setYouDotHook(null);
    setListTick(0);
    setLadderTick(0);
    /** ★ 2026-11-04：停站期候选车牌也要清 —— 否则换卡/回等车后会带着上一段的「来车」 */
    setCandAtStop(null);
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
          /**
           * ★ 需求5 L3：`AbortSignal.timeout(8000)` 把「悬挂的请求」变成「确定失败」。
           *   没有它，freeze 期间的请求可能永不 settle ⇒ `finally` 不执行 ⇒ 见 `INFLIGHT_LEASE_MS`。
           * ⚠️ 老 Safari（<16）没有 `AbortSignal.timeout` ⇒ 取不到就不传（行为回退到改前，
           *   仍有 L2 哨兵与 15s 租约兜底，不会因此永久冻结）。
           */
          { cache: "no-store", signal: timeoutSignal(FETCH_TIMEOUT_MS) },
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
        /**
         * ★ I-3：记一帧车辆快照（供 `followFramesOf` 在「两帧之间」内插，把车辆里程
         *   对齐到用户定位的时间戳）。只留末尾 `VEH_HIST_KEEP` 条 —— 与 `fixesRef`
         *   的 `FIX_KEEP_MS` 同量级，足够覆盖 30s 拟合窗 + 一次恢复补刷。
         */
        const hist = vehHistRef.current;
        hist.push({ ts: Date.now(), vehicles: list });
        if (hist.length > VEH_HIST_KEEP) hist.splice(0, hist.length - VEH_HIST_KEEP);
        // ★ v3.7.0 S2：车辆帧时间戳（**唯一**写入点）+ 观测钩子 `data-veh` / `data-veh-age`
        //   `fetchedAt` 只作「帧标识」判断数据有没有真的更新（不做跨时钟减法，见 observe-hooks）
        setLastVehicleTs(Date.now());
        /**
         * ★ 需求5 L2：**成功往返**锚点（无条件写，与 `fetchedAt` 是否变化无关）。
         *   紧挨 `setLastVehicleTs` 放，因为两者是同一件事的两个读法：
         *   前者给 UI 说「车辆数据几秒前更新」，后者给哨兵说「上次拿到响应是几秒前」。
         */
        lastRoundTripAtRef.current = Date.now();
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
          /**
           * ★ 2026-11-04（设计 §2.10）：「来的是哪辆车」。
           *
           * ⚠️ **必须传未过滤的 `list`**，不能传上面的 `ranked`：
           *   `ranked` 带了 `filterPassed: true`（已驶过上车站的车**被剔除**）——
           *   而 `strong`（刚从上车站开走）恰恰就是"已驶过"的那一类，过滤后它必不存在
           *   ⇒ `strong` 这一档会永久失效（只剩 `unique`）。
           *   这里要的是「此刻能不能确定地指出一辆来车」，与"候选池要不要剔除过站车"是两件事。
           *
           * 只在候车期算：其它相位本行不渲染，算了也是白算，且会留下过期值。
           */
          setCandAtStop(phase === "boarding" ? candAtStopOf(list, boardMain, boardPos) : null);
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
        /**
         * ★ 2026-11-05：更新「参照车距上车站」—— 只在**已锁牌**的 riding 帧里更新。
         *   无牌时 `vehicleRef` 为 null ⇒ 走不到这里 ⇒ 该值保持上次（切牌后 `repick` 会重算）。
         *   ⚠️ 必须在 `vehicleRef.current = v` 之后：本行用的就是这一帧的坐标。
         */
        setRefVehDistToBoardM(distToBoardM(v, boardPos));

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
        if (p.kind === "at" || p.kind === "between") {
          setProg(p);
          /**
           * ★ U3：停靠信号**与本帧进度同批写入**（两者必须成对，否则会出现
           *   「`prog` 还是上一帧的行驶态、`stoppedAtStation` 已是本帧的停靠」这种撕裂，
           *   下游会把「基准站 = 区间终点」和「首跳剩余 = 0」拼在一起，凭空少算一跳）。
           */
          setStoppedAtStation(p.kind === "at" && v.status === "stopping");
        }

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
    /**
     * @param entry ★ 2026-11-05：**这次 riding 是靠什么进入的**（决定赶车标签何时可隐藏）
     *   `station`  = 车停靠用户上车站（无位置证据 —— 车到了，人可能还在跑）
     *   `position` = r2 / 跟车斜率判据（有位置证据）
     *   `manual`   = 用户点「我已上车」
     */
    (nextPlate: string | null, source: "vehicle" | "gps", entry: BoardEntry = "position") => {
      const leg = legs[legIndex];
      const route = leg?.route.replace(/^LRT-/, "") ?? "";
      const lrt = leg?.kind === "lrt";
      setPhase("riding");
      setEnteredVia(entry);
      /**
       * ★ 位置证据：`position` 进入的当场就为真；`station` 进入的从 false 起，
       *   之后由「riding 期间位置判据」effect 在证据到达时翻真（**进入 riding 之后才翻转**）。
       */
      setBoardedByPosition(entry === "position");
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
      plateLockedTsRef.current = nextPlate ? Date.now() : 0; // ★ I-3：`data-plate-ts`
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
     *   ③ **区②（仍在走近站台）再扣 2 帧**（`boardNeedOf` 三区判别）：
     *      把「跑步赶车」这类真实边缘场景所需持续时长再拉长 **+6.0s**
     *      （3s/帧 × 2 帧 —— 旧注释写"约 3s"是算错的）。
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
      stopMains, // ★ I-3：锁牌的 L-b 判据（车已在本段站序内前移）
      vehicles: listRef.current,
      vehFrames: vehHistRef.current, // ★ I-3：车辆帧历史（斜率判据要两端内插）
      fixes: fixesRef.current,
      lastSwitchTs: lastSwitchTsRef.current,
      nowMs: Date.now(),
      autoLeft: autoUsedLeftRef.current,
      /**
       * ★ 2026-11-05：`walkActive` 门 —— **必需**。`phase === "boarding"` 在步行段期间
       *   就已成立（`NavShell.tsx:449-451`），而 `tryAuto` 里没有 walkActive 早退
       *   （`NavShell.tsx:407-412/:429` 声称的「真互斥」从未实现）。
       *   停站判据刻意不看用户位移 ⇒ 不带门会把「人在去站台路上」判成已上车。
       */
      walkActive,
      streak: boardStreakRef.current,
    });
    /**
     * ★ I-3：把本帧诊断写入 `body[data-plate-state|data-board-evidence|data-follow-slope|data-plate-ts]`。
     *   放在 `!res.hit` 早退**之前** —— 否则「没判上」时这些属性永远不更新，
     *   三种失败（没机会 / 有机会没锁上 / 锁上了没显示）又混成一种。
     */
    setBoardDiagAttr({
      plateState: res.plate ? "locked" : "none",
      evidence: res.evidence,
      slope: res.followSlope,
      plateTs: plateLockedTsRef.current || null,
    });
    // ★ v3.6.0（架构 §3.1）：唯一切换条件 = `hit && streak >= need`（need 由 autoBoardOf 返回）。
    //   **删除**旧版 `res.reason === "r1"` 特权分支 —— 车辆信号不得单独触发上车。
    boardStreakRef.current = res.streak;
    if (!res.hit) return;
    /**
     * ★ 需求6（2026-11-03）：加严判据从「`walkActive` **状态**」换成「人到上车站的**位置**」。
     *
     * ── 旧版（`92a8912`）实测代价与失效面 ────────────────────────────────
     *   `need + (walkActive ? 2 : 0)` 的实际代价是 **+6.0 秒**（3s/帧 × 2 帧；旧注释写"约 3s"
     *   是把 2 帧当成 1 帧算错了）。更关键的是**它只在"上车那一刻人还在步行段"才生效**：
     *   正常走到站台（`arrived` 先触发、`walkSeg` 已清空）时 `+2` 根本不生效 ——
     *   而 `walkActive` 判不准的三种场景（赶车提前上车 / 定位精度冻结导致 `arrived` 不来 /
     *   走偏导致 `remainM` 冻结）恰恰是最需要正确加严或放松的地方。
     *
     * ── 新版：三区判别（详见 `boardNeedOf`）─────────────────────────────
     *   区① `dToBoard ≤ 40m`（已到站/刚上车）⇒ 基准 ⇒ **恢复 v3.8.0 的响应速度**；
     *   区② `dToBoard > 40m 且 alongM < 60m`（仍在走近站台）⇒ 基准 + 2（防跑步误判）；
     *   区③ `alongM ≥ 60m`（人已在线路下游）⇒ 基准 ⇒ **不死锁**。
     *   ⚠️ 速度门 8km/h / 位移门 60m / 45s 窗口**一个都没动**（那些常量已被双向实测过）。
     */
    const fixNow = fixesRef.current[fixesRef.current.length - 1] ?? null;
    const need = boardNeedOf({
      baseNeed: res.need,
      colored: leg.colored,
      boardPos,
      fix: fixNow ? { lng: fixNow.lng, lat: fixNow.lat } : null,
    });
    if (res.streak >= need) {
      /**
       * ★ I-3（I4）：每次**自动**判定成立消耗 1 次（初值 2），不再把本段自动判定一刀封死。
       *   配合 `onNotBoard` 的 20s 冷却 ⇒ 「误判 → 点我没上车 → 还能再自动判一次」。
       *   ⚠️ 扣次数放在这里（而不是 `switchToRiding` 里）：手动「我已上车」（`board()`）
       *   走的是同一个 `switchToRiding`，那不属于自动判定，不该扣。
       */
      autoUsedLeftRef.current = Math.max(0, autoUsedLeftRef.current - 1);
      /**
       * `evidence === "atstop"` ⇒ 停站判据（无位置证据）；其余（r2 / slope）⇒ 有位置证据。
       * ⚠️ 两者对消费方的差别是**赶车标签能否立刻隐藏**：停站进入时车刚到，人可能还在跑，
       *    必须等位置证据到达（`boardedByPosition` 翻真）才隐藏。
       */
      switchToRiding(res.plate, res.source, res.evidence === "atstop" ? "station" : "position");
    }
  }, [phase, active, legs, legIndex, strips, anchors, boardPos, stopMains, walkActive, switchToRiding]);

  /**
   * ★ v3.7.0 S2（D1）：**恢复补刷**的唯一挂载点。
   *
   * 两个轮询 effect（候车 / 乘车）各自把自己的「立刻打一帧并重置 12s 计时」函数登进
   * `resumeKickRef`；本 hook 在五个恢复入口（`visibilitychange→visible` / **`resume`** /
   * **`focus`** / `online` / `pageshow`）时调它一次（内部 2s 去抖，防连发造成请求风暴，AC2.5）。
   * 需求5 起事件矩阵扩到五个，理由见 `useResumeRefresh.ts` 文件头（WebAPK 上 `resume` 是
   * 唯一确定会到的那一个）。
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

  /**
   * ★ 需求5 L2：**墙钟哨兵**—— 唯一不依赖任何事件的自愈层。
   *
   * ── 它补的是哪条缝 ────────────────────────────────────────────────────
   *   L1（事件矩阵）依赖"事件会到"。trace 已证：某些容器连 `resume` 都可能不发，
   *   且 `visibilitychange` 迟到 14s。哨兵只看**墙钟**：
   *   「现在」减「上次成功往返」超 `ROUND_TRIP_STALE_MS`（30s）⇒ 立刻补刷一次。
   *
   * ── 三条实现纪律（都踩过坑，别简化）──────────────────────────────────
   *   ① **不新建定时器**：复用 `observe-hooks` 里那个单例 1s 心跳（`retainVehTicker`，
   *      导航态已在上方持有）⇒ 零新增 CPU / 功耗，也零新增泄漏面；
   *   ② **锚点 = `lastRoundTripAtRef`**，不是 `observe-hooks` 的 `lastVehTs` ——
   *      后者只在帧内容变化时前移，用它会把「车没动」误判成「数据过期」，每 30s 白刷；
   *   ③ **补刷自身要限频**（`SENTINEL_KICK_MIN_MS`）：请求持续失败时锚点不前进，
   *      若不限频就会变成"每秒一次"的请求风暴。8s > 单次超时 8s 的量级，
   *      保证不把第二个请求叠在同一个悬挂请求上。
   *
   * ⚠️ 只重置**网络态**（补刷一次 + `inflightSince` 由租约自愈），
   *   绝不重置 `boardStreakRef` / 判定累积 —— 那会让上车判定重新等 3 帧（+9s），
   *   等于用需求6 的 P0 换需求5 的 P0。
   */
  useEffect(() => {
    if (!active) return;
    // 进入导航态即以「现在」为锚点：否则页面开着 20 分钟后再开始导航，首帧就被判过期
    lastRoundTripAtRef.current = Date.now();
    lastSentinelKickAtRef.current = 0;
    return registerVehSentinel(() => {
      const now = Date.now();
      const verdict = shouldForceRefresh({
        lastFrameAt: lastRoundTripAtRef.current,
        nowMs: now,
        lastKickAt: lastSentinelKickAtRef.current,
        debounceMs: SENTINEL_KICK_MIN_MS,
      });
      if (verdict !== "stale") return;
      lastSentinelKickAtRef.current = now;
      resumeKickRef.current?.();
    });
  }, [active]);

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
     *   ⚠️ `tryAuto` 已**不再**因步行段早退（v3.10.0 起放开）；需求6 之后它的加严判据
     *      是**几何三区**（`boardNeedOf`），与"是否还在步行段"这个状态无关。
     *   走进站台后 `walkActive` 变 false ⇒ 本 effect 重跑 ⇒ 立刻拉一帧 + 恢复 12s 轮询。
     */
    let cancelled = false;
    let timer: number | null = null;
    /**
     * ★ v3.7.0 S2：**同一时刻只允许一帧在飞**。
     *   否则「定时器刚打出去 + 用户此刻回前台」会在几毫秒内连打两次
     *   （AC2.5 要求同源 2s 窗口内 ≤1 次）。
     *
     * ★ 需求5 L3：布尔改为**时间戳租约**（`0` = 空闲）。布尔在 freeze 场景下会永久为真
     *   （`finally` 因整页冻结没执行）⇒ 解冻后第一个补刷被当场吞掉 ⇒ 永久冻结。
     *   租约超 `INFLIGHT_LEASE_MS`（15s）即视为泄漏已自愈（`inflightGate` 纯函数判定）。
     */
    let inflightSince = 0;
    /** 一轮 = 拉帧 + 尝试自动上车（保持既有的串行顺序） */
    const round = async () => {
      if (inflightGate({ inflightSince, nowMs: Date.now() }).blocked) return;
      inflightSince = Date.now(); // 首飞 / 租约过期强制重置，都从此刻重新计时
      try {
        await fetchFrame(null);
      } finally {
        inflightSince = 0; // ★ 无条件归零：成功 / 超时 / abort / 异常四条路径都走这里
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

  /**
   * ★ 2026-11-05：**riding 期间判「位置证据是否到达」**（供 `RideTrackView.boardedByPosition`）。
   *
   * ── 为什么必须有这个 effect ──────────────────────────────────────────────
   *   停站判据（`atBoardStopOf`）让 riding 的语义从「人已在车上」变成「车到了，人可能还在跑」。
   *   赶车标签的锁存条件因此从「进入 riding」改为「进入 riding **且** 有位置证据（或手动）」——
   *   负责人裁决：「加上位置证据再隐藏」。而位置证据只能在**进入 riding 之后**才出现
   *   （用户随车移动若干秒后 r2 / 跟车斜率才成立）⇒ 必须在 riding 期间持续判。
   *   旧代码里 `autoBoardOf` 只在 boarding 跑（`tryAuto` 早退），所以没有现成的量可用。
   *
   * ── 三条纪律 ────────────────────────────────────────────────────────────
   *   ① **一次性**：`boardedByPosition` 一旦为真立刻 return，不再重复计算
   *      （`r2Of` 要对窗内每帧做全折线投影，不设这道闸会每 3s 白烧一次）；
   *   ② **不回退**：证据一旦获得不会消失，故只 `setTrue`、从不 `setFalse`
   *      （换腿/重置才清，见 `doAlight` / `reset`）；
   *   ③ **不参与任何判定**：本 effect 只写一个观测字段，**不**影响 `prog` / `alarm` / `plate`，
   *      避免把"展示层需求"渗进判定链路。
   */
  useEffect(() => {
    if (phase !== "riding" || !active || boardedByPosition) return;
    const leg = legs[legIndex];
    if (!leg) return;
    const ok = positionEvidenceOf({
      legKind: leg.kind,
      colored: leg.colored,
      fixes: fixesRef.current,
      vehFrames: vehHistRef.current,
      plate,
    });
    if (ok) setBoardedByPosition(true);
  }, [phase, active, userFix, plate, legs, legIndex, boardedByPosition]);

  /* 轮询（riding 且有车牌）—— ★ v3.7.0 S2：同样接恢复补刷 */
  useEffect(() => {
    if (phase !== "riding" || !plate || !active) return;
    let cancelled = false;
    let timer: number | null = null;
    /** ★ v3.7.0 S2：同一时刻只允许一帧在飞（防「定时器 + 回前台补刷」双打，AC2.5） */
    /** ★ 需求5 L3：同 `round()` —— 时间戳租约，超 15s 视为泄漏并放行 */
    let inflightSince = 0;
    const pull = async () => {
      if (inflightGate({ inflightSince, nowMs: Date.now() }).blocked) return;
      inflightSince = Date.now();
      try {
        await fetchFrame(plate);
      } finally {
        inflightSince = 0;
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
    /** ★ 需求5 L3：时间戳租约（`0` = 空闲；超 15s 视为泄漏并放行） */
    let inflightSince = 0;
    const pull = async () => {
      if (inflightGate({ inflightSince, nowMs: Date.now() }).blocked) return;
      inflightSince = Date.now();
      try {
        await fetchFrame(null);
      } finally {
        inflightSince = 0;
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
        if (res.progress.kind !== "lost") {
          setProg(res.progress);
          /**
           * ★ U3：定位推算**推不出**「车辆明确停靠」这个显式信号（本节刻意不用"缺失/推算"判停靠），
           *   故此处一律归 false —— 否则上一次车辆帧留下的 `true` 会跟着 GPS 帧继续生效。
           */
          setStoppedAtStation(false);
        }
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
      setYouDotHook(null);
      setYouAt(null);
      return;
    }
    const leg = legs[legIndex];
    if (!leg || leg.colored.length < 2 || leg.degraded) {
      setYouDot(null);
      setYouDotHook(null);
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
    /**
     * ★ 观测钩子：把**实际交给渲染层的坐标时刻**写出去（含冻结时那份旧 `ts`）。
     *   `dot.ts` 在 live 时等于 `userFix.ts`（与 `data-user-fix` 同源）、冻结时停在
     *   上一好点 ⇒ 两个属性一相减就能分辨「定位死了」与「渲染层冻住」。
     *   ⚠️ 不写经纬度；格式与 `data-user-fix` 一致（`ts,acc`）。
     */
    setYouDotHook(dot ? dot.ts : null, dot ? dot.accuracy : undefined);

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

  /**
   * ★ 观测钩子 `data-you-dot` 的**卸载清场**（独立 effect，非上面那条 effect 的 cleanup）。
   *
   * 为什么必须独立一条：上面那条 effect 每次依赖变化都会跑 cleanup，挂在它上面等于
   * 「每次换帧清一次」，语义错。这里要表达的是**「组件生命周期 = 钩子生命周期」**：
   * 只要 `useRideTracking` 活着，`data-you-dot` 就合法；一旦卸载（用户跳去 `/help`、
   * `/line/[code]` 等，`reset()` 也不会跑），属性必须消失。
   *
   * 不清的后果（实测可达）：`document.body` 上残留上一次的值，语义仍是"渲染层有坐标"
   * ⇒ 跳页后的 QA 用例读到幽灵钩子，会误判整只钩子不可信并弃用它（过期钩子型假绿）。
   */
  useEffect(() => () => setYouDotHook(null), []);

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
    autoUsedLeftRef.current = AUTO_TRIES_PER_LEG; // ★ I-3：次数按「每次开始导航」重置
    plateLockedTsRef.current = 0;
    vehHistRef.current = [];
    setEnteredVia(null); // ★ 2026-11-05
    setBoardedByPosition(false);
    setRefVehDistToBoardM(null);
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
        /**
         * ★ 2026-11-05：手动上车 ⇒ `manual`（用户本人断言已在车上）。
         *   `boardedByPosition` 置真：手动是**用户明确确认**，消费方无需等位置证据。
         */
        setEnteredVia("manual");
        setBoardedByPosition(true);
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
    /**
     * ★ 2026-11-05：「不是这辆」换车 —— **不动** `enteredVia` / `boardedByPosition`：
     *   换的是"哪辆车"，不是"怎么进入 riding"。位置证据（r2 / 跟车斜率）证明的是
     *   「用户随线路在移动」，与锁到哪辆车无关，故无需重判、也不应回退。
     */
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
      setEnteredVia(null); // ★ 2026-11-05：换腿 ⇒ 重新计「怎么进的」
      setBoardedByPosition(false);
      setRefVehDistToBoardM(null);
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
      vehHistRef.current = []; // ★ I-3：换腿 ⇒ 车辆帧历史作废（新段几何/方向都不同）
      plateLockedTsRef.current = 0;
      alightStreakRef.current = 0;
      boardStreakRef.current = 0;
      buzz([120, 60, 120]);
      if (legIndex + 1 < total) {
        setLegIndex((i) => i + 1);
        setPhase("boarding");
        autoUsedLeftRef.current = AUTO_TRIES_PER_LEG; // ★ I-3：下一段是全新行程，次数重置
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
    /**
     * 撤销自动下车 = 用户否定了这次自动推进 ⇒ 本腿不再自动判（防抖）。
     * ★ I-3：落地为「把剩余次数清零」，与改前 `autoUsedRef = true` 行为等价（**不是**回归）。
     */
    autoUsedLeftRef.current = 0;
    vehHistRef.current = []; // ★ I-3：撤销跨越了「下一段」，车辆帧历史已不可比
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
    plateLockedTsRef.current = 0;
    boardStreakRef.current = 0;
    lastSwitchTsRef.current = Date.now();
    boardingStartedAtRef.current = Date.now(); // ★ 回到等车态同样有启动宽限
    /**
     * ★ 2026-11-05（team-lead 裁决）：**退还 1 次**自动判定次数。
     *
     * 为什么必须退：停站判据把「切 riding」变成**每来一班车触发一次**的高频事件，
     *   而高峰期用户等 3~4 班是常态。若不退，2 次用完后再也不自动切
     *   （旧 r2/slope 判据下很少触发，2 次够用；现在不够了）。
     * ⚠️ 只退还、**不放成无限**：以 `AUTO_TRIES_PER_LEG` 为上限，
     *   防某个异常循环里「切→退→切」无限打转。
     * 语义：用户说「我没上车」是**合法信号**（车到了但他没上），不是失败重试。
     */
    autoUsedLeftRef.current = Math.min(AUTO_TRIES_PER_LEG, autoUsedLeftRef.current + 1);
    /**
     * ★ I-3（I4）：**不再**永久关闭本段自动判定。
     *
     * 旧版这行是 `autoUsedRef.current = true;  // 冷却后再允许自动` —— 注释承诺了
     * 代码里不存在的路径：`boarding-detect` 的硬门读它即整段不再判，而全仓只在
     * 「开始导航」「换腿」两处复位，boarding 期间**没有任何**复位入口 ⇒
     * 用户纠正一次之后，本段再也无法自动判定（注释与实现相反）。
     *
     * 现在：点「我没上车」本身**不扣次数**（扣的是那次自动上车），只起 20s 冷却
     * （`lastSwitchTsRef` 已置为现在）防抖 ⇒ 冷却后仍可再自动判 —— 次数由
     * `autoUsedLeftRef`（初值 2）如实记账，用尽后如实不再自动。
     */
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

  /* ══════════════════════════════════════════════════════════════════════
     ★ 本批（A-1 / C2）：无进度提示 + 触发率量测（判定逻辑见
     `src/lib/nav/ride-note.ts` 头注，本文件只做「取输入 → 调它 → 用返回值」）
     ─────────────────────────────────────────────────────────────────────
     背景：无牌巴士有两种**结构性**缺失（几何 < 2 点 / 站条 < 2 站）⇒ `prog` 永远为空
     ⇒ 到站横幅、震动、自动下车**一起静默失效**（`alarm` 门与 `autoAlightOf` 都以
     `prog` 为输入）。本批只加提示与量测，**不改任何判定逻辑**。

     ── 为什么用「派生」而不是在建梯处 `setNote(...)`（踩过的时序坑）─────────
       `switchToRiding` 尾部先 `setPlate(nextPlate)` 再 `void ensureLadder()`，
       在同一个回调里读 `plate` 读到的**还是旧值 null**（state 尚未提交）。
       若在建梯处直接 `setNote(文案)`，有牌场景会**先闪一下再消失**。
       派生在本函数返回时求值 ⇒ 必然用本帧已提交的 `plate` ⇒ 结构上不可能误报。

     ── 与既有 note 写入点不打架（本批**不新增任何 `setNote` 调用点**）───────
       只在返回处做一次优先级合流：
         paused 定位文案（boarding 专用，更高）> geomNote > 既有瞬时 note
       ① 为什么 geomNote 排在 `note` 之前：无牌 riding 里 `NOTE_FETCH_FAIL`
          （车辆数据获取失败）一旦写入，**没有任何代码路径会清空它** —— 清空点
          `setNote("")` 在锁牌分支里，无牌根本走不到。若让 `note` 优先，
          一条永不消失的瞬时提示会永久顶掉结构性说明。
       ② 为什么不会盖掉更具体的因：`NOTE_FROZEN_BUS`（车辆丢失）与
          `NOTE_NO_VEHICLES` 都只在锁牌/候车分支产生，而锁牌 ⇒ `hasPlate` ⇒
          `geomNote` 恒 null ⇒ 两者不可能同时出现。
     ══════════════════════════════════════════════════════════════════════ */
  const coloredLen = legs[legIndex]?.colored?.length ?? 0;
  const stopsLenNow = strips?.[legIndex]?.stops?.length ?? 0;
  const geomNote = rideNoteOf({
    phase,
    hasPlate: !!plate,
    coloredLen,
    stopsLen: stopsLenNow,
  });
  const ladderState = ladderStateOf({ phase, coloredLen, stopsLen: stopsLenNow });

  useEffect(() => {
    setLadderHook(ladderState, coloredLen);
  }, [ladderState, coloredLen]);
  /** 卸载即摘属性 —— 否则下一轮会话会读到上一轮的陈旧值 */
  useEffect(() => () => setLadderHook(null, 0), []);

  /**
   * ★ I-3：**上车判定诊断钩子的清理**（与 `tryAuto` 里的写入成对）。
   *   · `boarding` / `riding` 期间**保留** —— 关键就在这里：判上牌的那一帧写的是
   *     `data-plate-state=locked` + `data-plate-ts`，若切到 riding 就立刻摘掉，
   *     QA 永远观察不到「锁上了」，本钩子就白加了；riding 期间值冻结在最后一次判定帧。
   *   · `off` / `done`（会话结束）⇒ 四个属性一起摘除，避免下一轮读到陈旧值。
   *   ⚠️ 依赖只放 `phase`：值是 `tryAuto` 每帧写的，这里只负责「何时清」。
   */
  useEffect(() => {
    if (phase === "boarding" || phase === "riding") return;
    setBoardDiagAttr(null);
  }, [phase]);
  useEffect(() => () => setBoardDiagAttr(null), []);

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
    note: phase === "boarding" && boardPaused ? noteOfPausedGeo(geo) : (geomNote ?? note),
    candidates,
    candAtStop,
    autoSwitched,
    enteredVia,
    boardedByPosition,
    refVehDistToBoardM,
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
    /** ★ U3：非乘车态一律 false（不把上一段的停靠结论带到新一段） */
    stoppedAtStation: phase === "riding" && stoppedAtStation,
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
