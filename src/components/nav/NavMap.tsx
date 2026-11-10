"use client";

/**
 * 导航地图（src/components/nav/NavMap.tsx，v1.3.0 · T04；★ M Map 改版 S1 增「澳门范围」）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   · 高德 JS API 2.0 底图（`amap-loader`，懒加载，`ssr:false` 由调用方保证）；
 *   · ★【S1 新增】**只显示澳门**：`setLimitBounds`（拖动限制）+ `setZooms([11,19])`（缩放收敛）
 *     + `setBounds`（初始视野 = 澳门全境）+ **域外遮罩**（大矩形镂空澳门，半透明压暗）。
 *     边界取自高德官方 `AMap.DistrictSearch`（见 `src/lib/amap/district.ts`，**不自绘**）。
 *     **降级原则**：边界/遮罩任一环节失败 → 回落到「仅范围限制 + 兜底矩形」，**绝不阻塞**底图/搜索/定位。
 *   · 标记：用户位置蓝点 + 目的地图标；
 *   · ★ 巴士站点图层：地图就绪后一次性拉 `/api/stations` 并缓存（ref），仅 `zoom >= STATION_MIN_ZOOM`
 *     时渲染**屏幕内**站点（`getBounds()` 裁剪），拉远即清空；`zoomend`/`moveend`（~150ms throttle）。
 *     点击站点 → `onStationClick`（信息卡）。移除点务必 `map.remove()` 清理，防泄漏。
 *   · ★ **地图失败不阻塞**：JS 加载失败/缺 Key/初始化异常 → 静态占位 + 「重试」，
 *     **搜索/出卡/详情完全不受影响**（产品已拍，§Q7）。
 *
 * ── 定位（★ 02 §1.4 ④ 裁定）──────────────────────────────────────────
 *   · 定位点在**澳门范围内** → `setZoomAndCenter(zoomForAcross(lat,w), [lng,lat])`（沿用「横向 5km」）；
 *   · 定位点在**澳门范围外** → **不移动地图**（保持澳门视野），蓝点按真实 GCJ-02 坐标如实落位；
 *   · 定位失败 → 停在澳门视野 + 现有提示（「无法定位 · 请手动选择出发点」）。
 *
 * ── 观测钩子（无副作用，供自动化验收）────────────────────────────────
 *   `data-nav-zoom` · `data-nav-z` · `data-station-count` · ★ `data-limit-bounds`(=on|off)
 *   · ★ `data-limit-bounds-src`(=district|fallback) · ★ `data-map-mask`(=on|off)
 *
 * ⚠️ 坐标：`Geolocation({ convert:true })` 的 `position` **已是 GCJ-02，不再转换**。
 * ⚠️ 文案：界面文案一律**简体**（站名/线路名才用繁体）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import BrandRouteLoader from "@/components/brand/BrandRouteLoader";
import { isInsideRings, loadMacauDistrict, maskOuterRing, padBounds, type MacauDistrict } from "@/lib/amap/district";
import { type ColoredLeg, type LL } from "@/lib/nav/route-overview";
import { loadAMap } from "./amap-loader";
/* ★ v3.3.0（AC-92 · ADR-102）：起终点钉内联 SVG 单一真源 */
import { PIN_SVG_DEST, PIN_SVG_ORIGIN } from "@/lib/nav/pin-svg";
import {
  fitGapPx,
  maskFill,
  MASK_OPACITY,
  MAX_ZOOM,
  MIN_ZOOM,
  panelTopPx,
  zoomForAcross,
} from "./nav-map-fit";
import { drawOverview } from "./nav-map-overview";
import {
  clearWalkGhosts,
  clearWalkLayers,
  ensureWalkLayers,
  readWalkStyle,
  splitStepByRatio,
  syncWalkGhosts,
  type WalkGhost,
  type WalkGhostRec,
  type WalkLayers,
} from "./nav-map-walk";
import type { WalkStep } from "@/lib/walk/walk-shared";
import { lrtTransferVariantOf } from "./lrt-transfer";
import TrackLayer from "./TrackLayer";
import UserDotLayer from "./UserDotLayer";
import VehicleLayer from "./VehicleLayer";
import TqhStationLayer from "./TqhStationLayer";
import TqhPathLayer from "./TqhPathLayer";
import XborderPinLayer from "@/components/map/XborderPinLayer";
import type { XbPinKind } from "@/components/map/xborder-pins";
import PublicToiletLayer from "./PublicToiletLayer";
import type { PublicToilet } from "@/lib/map/public-toilets";
import type { TqhSegment, TqhStation } from "./tqh-model";
import type { VehicleLite } from "./VehicleMarker";
import type { UserFix } from "./useUserFix";

/* eslint-disable @typescript-eslint/no-explicit-any */
const MACAU_CENTER = { lng: 113.558, lat: 22.155 }; // 全澳门视角中心（§D.1）
/** 初始 zoom（地图创建占位用；district 就绪后由 setBounds 接管） */
const INIT_ZOOM = 12;

/**
 * 站点图层显示阈值：`zoom < STATION_MIN_ZOOM` 时不显示任何站点（拉远即清空）。
 * · 2026-09-22：16 → 15（用户反馈「要放得很大站点才显示出来」）。
 * ★ 2026-09-23：15 → **14**（用户拍板）——要求「打开定位后的默认视野就要能看到站点」。
 *   实测定位完成后的视野 ≈ 14.47 级 ⇒ 阈值取 14 时定位完成即显示，不必手动放大；
 *   而全澳总览（≈12.4 级）仍不显示，避免整屏 470+ 站点糊在街区细节上。
 * ★ v3.1.1（真机反馈 #3）：14 → **15**（用户反馈「站点太密集」）。
 *   定位完成后视野 ≈ 14.47 **< 15** ⇒ 打开时**不显示**站点、轻微放大一档才出现（正是本次诉求）；
 *   全澳总览（12.4）与首页默认视野都更干净。
 *   ⚠️ 这**推翻了 2026-09-23「打开定位就要看到站点」的旧拍板**（两者不可兼得），
 *     属 12 文档 §D 的既定取舍（用户已真机确认取 15）。
 */
const STATION_MIN_ZOOM = 15;
/**
 * ★ 2026-09-22：**路线查看模式下的站点阈值**（比常规低一档）。
 *   为什么需要：进入路线模式会 `setBounds` 把视野缩到「装下整条线」，
 *   跨全澳的长线（如 26 号）实测落到 zoom ≈ 12~13，**低于常规阈值** ⇒ 站点图层整体不显示
 *   ⇒ 看不到「本线站点高亮」的效果 ✗ ⇒ 路线模式下放宽到 12。
 * ★ v3.1.1：**保持 12 不动**（不可提高到 13 —— 长线 `setBounds` 后落在 **12.x**，
 *   `12.3 < 13` ⇒ 整层站点不显示，正是 2026-09-22 记录过的坑）；
 *   且本批需求②「非本线不渲染」后路线模式最多只剩十几~二十几个点，**不会密集**，无需提阈值。
 */
const STATION_MIN_ZOOM_ROUTE = 12;
/** 视图事件节流（毫秒）：`zoomend`/`moveend` 高频触发，节流后再裁剪/渲染 */
const STATION_REFRESH_THROTTLE_MS = 150;

/** 空车辆数组的**稳定引用** —— 用作 prop 默认值，避免每次渲染产生新引用触发 effect 抖动 */
const NO_VEHICLES: VehicleLite[] = [];

/** `/api/stations` 一条站点（坐标 **GCJ-02**，服务端已转好） */
export interface StationPointLite {
  code: string;
  name: string;
  lng: number;
  lat: number;
  /** ★ 2026-09-22：载具种类（仅带 `include=lrt` 时轻轨行才出现；缺省视为巴士） */
  kind?: "bus" | "lrt";
  /**
   * ★ v2.10.0：轻轨站**线路主题色**（`--c1`）—— 来自 `/api/stations`（源头 `routes.color`）。
   *   单线站 = 该线色；换乘站按 Spec §8 取 c1。**仅轻轨站下发**（巴士站恒为青花蓝，走 CSS）。
   *   颜色是**数据** ⇒ 只以行内 CSS 变量注入，绝不写进 CSS。
   */
  color?: string;
  /** ★ v2.10.0：换乘站**第二线路色**（`--c2`）—— 仅蓮花（`LRT-LOT`）/ 協和醫院（`LRT-UH`） */
  color2?: string;
  /** ★ v2.10.0：该站停靠的线路码（去重；`/api/stations` 旁路数据，当前前端未消费） */
  lines?: string[];
  /** ★ v2.10.0：与 `lines` 一一对应的线路色（`/api/stations` 旁路数据，当前前端未消费） */
  colors?: string[];
}

export interface NavMapProps {
  /** Web 端（JS API）Key（服务端以 prop 传入） */
  jsKey: string;
  /**
   * ★ AC-16：**自定义地图样式 ID**（高德控制台创建，用于隐藏底图**自带**的公交站点图标；
   *   我们自己的站点图层是独立 marker，不受影响）。
   *   缺省 / 空串 ⇒ **不传 `mapStyle`，用高德默认样式（与现状逐字节一致，降级安全）**。
   *   ⚠️ 样式须与 `jsKey` 同属一个开发者账号，否则不生效。
   */
  mapStyleId?: string;
  /** 目的地图标（用户选定 POI 后）；★ S2：设为该点后地图**居中**到目的地 */
  dest?: { lng: number; lat: number; label: string } | null;
  /**
   * ★ 2026-09-22 新增：**出发地标记**（选完出发地后与目的地同时显示）。
   *   与 `dest` 同构；两者都有时可配合 `view.mode='fit-two'` 自动适配两点。
   */
  origin?: { lng: number; lat: number; label: string } | null;
  /**
   * ★ 2026-09-22 新增：**视口指令**（搜索重构用）。
   *
   * 为什么要它：新版搜索弹窗**覆盖在地图上**（下半屏被遮住）。
   *   若仍按「容器中心」居中，标记会落进被遮住的下半屏 ⇒ 用户看不见 ✗
   *   所以需要两种特殊取景：
   *     · `dest-center-top`：目的地放在 **上半屏正中央**（弹窗半屏时用）
   *     · `fit-two`       ：出发地 + 目的地 **都在视野内**（自动缩放 + 居中）
   *   `tick` 变化即重新取景（同一模式重复触发也生效）。
   *
   * ★ 2026-09-23：扩展 `fit-box`（面板三档取景）——
   *   把外包框 `box` 适配进「面板顶边以上的可视槽」（`slotTopPx`）。
   *   ⚠️ **禁用 `setBounds` / `setFitView`**（本项目 `setLimitBounds(澳門)` 场景下会被撑到
   *   珠海斗门、zoom 掉到最小）⇒ 一律复用 `fit-two` 的自算逻辑（反推 zoom + panBy）。
   */
  view?:
    | {
        mode: "dest-center-top" | "fit-two" | "fit-box" | "none";
        tick: number;
        /** fit-box：待装下的经纬度外包框（面板顶边以上区域） */
        box?: { minLng: number; minLat: number; maxLng: number; maxLat: number };
        /** fit-box：可视槽底边像素（= 当前档面板顶边） */
        slotTopPx?: number;
        /**
         * ★ v3.6.0 S5（步行跟随）：顶部被占高度（= 安全区 + `--walkturn-h`）。
         *   与 `insetBottomPx` 任一存在 ⇒ 走"中带"算法；**都不传时行为完全不变**。
         */
        insetTopPx?: number;
        /** ★ v3.6.0 S5：底部被占高度（= 面板顶边 `topsPx[detentIndex]`） */
        insetBottomPx?: number;
        /**
         * ★ 2026-11-06（修复批 #6b）：**显式意图 ⇒ 解除让位锁**（缺省 = 旧行为）。
         * 只有「用户主动选中某条班次线」会传；自动取景（GPS / 面板落定）**一律不传**。
         * 语义与类型定义见 `useNavFrame.ts#FrameCmd.force`（两处必须同口径）。
         */
        force?: boolean;
      }
    | null;
  /** 定位回调：成功给 GCJ-02 坐标；失败给 null */
  onLocate?: (pos: { lng: number; lat: number } | null) => void;
  /** 点击巴士站点回调（信息卡）——坐标 GCJ-02 */
  onStationClick?: (s: StationPointLite) => void;
  /** 点击地图空白处（S2：用于收起站点信息卡） */
  onMapClick?: (pos: { lng: number; lat: number }) => void;
  /** 地图就绪后回传「读地图中心」的函数（S2 分步弹层第 2 步「用这个点」用） */
  onMapReady?: (probe: () => { lng: number; lat: number } | null) => void;
  /**
   * ★ 2026-09-22 新增：**路线查看模式**。
   *   非空 ⇒ 地图上画出该线路的走向（`route_shapes`，GCJ-02），并把该线站点放大高亮、
   *   其他站点变灰变小；视野**自动装下整条线**。传 `null` 即退出该模式（清线恢复原样）。
   */
  routeLine?: { code: string; kind: "bus" | "lrt"; label: string; color: string; dir?: string } | null;
  /**
   * ★ v2.10.0：`NavMap` 读到 `/api/route-shapes` 后**回报该线路可用方向**（`dsat_dir`）。
   *   上层据此判定单向（`length<=1` ⇒ 无换向按钮）并补齐 `routeLine.dir`。
   */
  onRouteDirs?: (dirs: string[]) => void;
  /**
   * ★ 2026-11-06（修复批 #4/#5a 收尾）：**线路站序弹窗的顶边像素**（px，从屏幕顶部算）。
   *
   *   · 非空 ⇒ 线路取景把包围盒装进「弹窗顶边**以上**」的槽（**自算** zoom + `panBy`，
   *     与 `fit-box` 同一配方，见下方取景处的长注释）；
   *   · `null` / 不传 ⇒ **原行为一字不改**（`setBounds(b, true, [40,40,40,40])`）。
   *
   * ⚠️ 只在本弹窗**打开**时由宿主给值；关闭 / 导航态 / 选线弹窗 / 详情 pane 时宿主传 `null`
   *   ⇒ 那些场景走原路径（别把「既有例外」泛化成统一路径：线路查看模式现在的观感是验收过的）。
   * ⚠️ **值来源**：宿主的 `tqhDetentTopsPx(winH, safeTop, safeBottom)[detentIndex(detent)]`
   *   —— 与弹窗自己的档位顶边**同一个函数**，不要在任一侧另算。
   * ⚠️ 本值**不进取景 effect 的依赖**（见 `stopsInsetTopRef`）：拖档换档不重新取景，
   *   否则每拖一档地图就跳一次。取景时机仍是「打开 / 换线 / 换向」。
   */
  stopsInsetTop?: number | null;
  /** ★ v2.10.0：该线路当前方向的在途车辆（空数组 = 无车/非巴士） */
  vehicles?: VehicleLite[];
  /** ★ v2.10.0：点击车辆图标（含合并组内的其余车辆） */
  onVehicleClick?: (vehicle: VehicleLite, count: number) => void;
  /**
   * ★ 2026-09-23：**路线总览**（详情 pane 用）。
   *   非空 ⇒ 逐段画「灰底线（区间外 z68）+ 彩段（乘车区间 z72）」；起终点 pin 由 `origin/dest`
   *   另行绘制。`null` ⇒ 逐个 `map.remove()` 清理（复用 routeLine 清理模式）。
   *   几何由 `useRouteOverview` 算好（`buildColoredLegs`）；`color=null` 回落 `--accent`。
   */
  overview?: ColoredLeg[] | null;
  /**
   * ★ v3.6.0 S5：**步行跟随三线**（done / now / ahead）。`null` ⇒ 三条全部移除。
   * `donePath` 由调用方累积（偏航重算后不清空）；`currentIdx` + `ratio` 决定 now/ahead 切分。
   */
  walk?: {
    steps: WalkStep[];
    currentIdx: number;
    /** 米级进度 0~1（**不要**用步级索引推地图几何，见设计 §2.3 细节 5） */
    ratio: number;
    /** 已走过的累积轨迹（GCJ-02） */
    donePath: [number, number][];
  } | null;
  /** 步行线的重画版本号（ratio 变化但对象引用不变时也能刷新） */
  walkVersion?: number;
  /**
   * ★ P0（2026-10-31）：**上层是否已有可用定位**（`!!myPos`）。
   *
   * 高德 `Geolocation` 失败（桌面浏览器常见：走 IP 粗定位、或 key/域名未授权）时，
   * 本组件会挂「无法定位 · 请手动选择出发点」。但上层还有 `useUserFix` 的浏览器 GPS
   * 兜底 —— 此时蓝点在正确位置、`出发` 可点、能正常规划，
   * **再说"无法定位"就是假话**（与"缺口要诚实"正好相反）。
   * ⇒ 有外部位置时**什么都不说**，真定不到才说。不做"定位较慢"之类的中性话术。
   */
  hasExternalPos?: boolean;
  /**
   * ★ 一条导航流：**非当前段的步行走廊**（`nav-map-walk.ts#syncWalkGhosts`）。
   *
   * 为什么与 `walk` 分开：`walk`（三线）只在「正在跟随这一段」时存在，
   *   而末段/首段的**完整走廊**要在整条导航过程中一直画着（否则乘车途中看不到
   *   「下车后还要走多远」）。两者互斥（当前段走三线、其余段走 ghost），不重复画。
   * `null` / `[]` ⇒ 0ms 全部移除。
   */
  walkGhosts?: WalkGhost[] | null;
  /**
   * ★ 2026-09-25：**导航追踪 · 用户定位蓝点（人）**。
   *   非空 ⇒ 画蓝点（原生 marker z128 < 车辆 130）；`null` ⇒ 移除（拒权/无信号/上车重合）。
   */
  userFix?: UserFix | null;
  /**
   * ★ 2026-09-24：**导航追踪 · 已驶过路段**（灰实线 polyline，z74 —— 压在乘车彩段 72 之上）。
   *   路径 = 乘车段 polyline 由车辆/GPS 实时投影切割所得（`useRideTracking`）；`null` ⇒ 不画。
   */
  traveled?: LL[] | null;
  /**
   * 重新定位触发计数（右上定位按钮）—— 变化时重跑一次定位并（范围内）居中。
   * 初始为 0 时不触发（首屏定位由 `init()` 负责）。
   */
  locateTick?: number;
  /**
   * ★ 本批新增（需求② 站点过滤 / AC-29~31）：**站点白名单（主码）**。
   *   非空 ⇒ 仅渲染集合内站点（路线查看 / 导航模式由宿主计算）；
   *   `null` / 空集 ⇒ 不过滤（回落到常规「本线高亮 / 其他变灰」逻辑）。
   */
  lineStops?: ReadonlySet<string> | null;
  /**
   * ★ v3.2.0（需求 7 / AC-80）：蓝点移动插值时长（ms，= 采样间隔）。
   *   `0`（缺省）= 瞬移；riding 1500 / 候车 1500（>5s 采样必为 0）。透传给 `UserDotLayer`。
   *   ⚠️ 语义变更（需求 9）：左下「回到我的位置」按钮已**彻底移除** ——
   *     让位锁（`followState`/`free`）、双击恢复 `restore()`、定位键重跑**全部保留**。
   */
  userDotSmoothMs?: number;
  /**
   * ★ 2026-11-05（通琴号 Spec R3/R4）：**第三类交通方式的地图图层**。
   *
   * · `tqhStations` 非空 ⇒ 画通琴号站点（★ 2026-11-06 起只有 **96 个纯通琴号站整圆**，
   *   带 `bus_station_code` 的 41 站不再单独成标，改由 `tqhSharedBusCodes` 把巴士标染双色）；
   * · `tqhActiveIds` 非空 ⇒ 该班次经过的站高亮、其余降透明（**只降透明不改背景**）；
   * · `tqhSegments` 非空 ⇒ 按段画主题色实线 / 缺段直线虚线（几何全部离线预计算，零高德调用）。
   * 三者**互不依赖**：只传站点也能看图层；`null` ⇒ 对应图层 0ms 清空。
   */
  tqhStations?: TqhStation[] | null;
  tqhActiveIds?: ReadonlySet<number> | null;
  tqhSegments?: TqhSegment[] | null;
  /**
   * ★ 2026-11-06（修复批 #1）：**双色巴士标**集合。
   *
   * 命中的巴士站 marker 改用「左半青花蓝 `--accent` / 右半通琴号粉 `--tqh-map-half`」硬停渐变
   * （复用 `globals.css .nav-map__station--tqh-shared`，**零新增 CSS**）—— 因为带
   * `bus_station_code` 的通琴号站**不再单独画 marker**（`TqhStationLayer` 已跳过 41 个），
   * 通琴号信息改挂在这里。
   *
   * 传入的是**主码集合**（`sharedBusMainCodes`，实测 33 个）：`/api/stations` 只下发主码，
   * 35 个站台码塌成 33 个点。兼容按完整站台码传（下方判据两种都认）。
   * `null` / 缺省 ⇒ 不染（与改前逐字节一致，降级安全）。
   */
  tqhSharedBusCodes?: ReadonlySet<string> | null;
  /**
   * ★ 2026-11-06（修复批 #1 配套）：**本班次经过、但已被吸进巴士标的站**（主码集合）。
   *
   * 为什么需要：通琴号班次详情里，本班 7 个站可能有 1 个是「关联巴士站」——
   * 它的独立 marker 已被取消（改由巴士双色标代表），若不给那个巴士标加环，
   * 用户会觉得「这班少了一站」。这些站命中 ⇒ 巴士标加白环（复用
   * `.nav-map__station--tqh-onroute`，**只加形状不改色**，双色结构不会被吃掉）。
   * `null` ⇒ 不加环（浏览 / 非通琴号视图）。
   */
  tqhActiveBusCodes?: ReadonlySet<string> | null;
  /**
   * ★ 2026-11-06（修复批 #6 · P0「通琴号路线模式未隐藏其它站点」）：**巴士站点层的白名单**。
   *
   * 三态（顺序即语义）：
   *   · `null` / 缺省 ⇒ **不接管**，巴士层走既有 `lineStops` → 本线 `routeStops` 逻辑
   *     （浏览 / 线路详情 / 导航态行为与改前逐字节一致）；
   *   · **非空集** ⇒ 只渲染集合内的巴士站（主码；兼容完整站台码），其余一概不建 marker；
   *   · **空集** ⇒ 巴士站**全隐**（班次里没有任何关联巴士站时的正确结果）。
   *
   * ⚠️ 判据必须是 `!= null`（不能用真值判断空集会被漏掉，`Set` 实例恒为 truthy，
   *   但语义上要写成「null 才是不接管」，否则后来人改成 `Array` 就会踩空）。
   */
  tqhBusWhitelist?: ReadonlySet<string> | null;
  /**
   * ★ 2026-11-06（修复批 #3 / R2）：**通琴号站点白名单**（站 `id`）。
   * `null` = 不过滤（浏览 / 导航态，行为与改前一致）；空集 = 全隐；非空 = 只留这些站。
   */
  tqhWhitelist?: ReadonlySet<number> | null;
  /** 点通琴号站点（纯通琴号站 → 通琴号卡片；`ids` > 1 表示同物理点合并组） */
  onTqhStationClick?: (s: TqhStation, ids: number[]) => void;
  /**
   * ★ 需求 7：是否画「跨境地标」圆点（机场 1 + 码头 3）。
   *
   * 与站点层**刻意无关**：站点层受 `STATION_MIN_ZOOM`（浏览 15）门控，
   * 而地标要"首页就能看到机场在哪"⇒ 常显，重叠交给聚合处理
   * （`xborder-pins.ts#groupXbPins`）。别把它塞进 `stationZoomOk`。
   */
  showXborderPins?: boolean;
  /**
   * ★ M4（需求 6）：码头 / 机场**分开**控制。
   * `null`/缺省 ⇒ 全显示（与改前行为一致）；传集合 ⇒ 只显示其中 `kind`。
   * 聚合仍在全量 `XB_PINS` 上算（详见 `XborderPinLayer` 的同名 prop 注释）。
   * ⚠️ 传入的 Set 必须**记忆化**（`useMemo`）：它进 `XborderPinLayer` 的 effect 依赖，
   *   每次渲染新建会全量重建 marker。
   */
  xborderKinds?: ReadonlySet<XbPinKind> | null;
  /**
   * ★ M4（需求 3）：公共厕所图层开关。默认 **关**（198 个点全开会糊住地图）。
   * 与巴士/通琴号站点层**共用同一个** `stationZoomOk`（浏览 15 / 路线·导航 12）——
   * 单一真相，别在这里另写阈值。
   */
  showToilets?: boolean;
  /** ★ M4：点公厕 pin ⇒ 宿主开弹窗 */
  onToiletClick?: (toilet: PublicToilet) => void;
  /**
   * ★ M4（缺陷修复）：把「站点/公厕图层此刻是否达到缩放阈值」连同当前 zoom 回写给宿主。
   * 用途：图层面板据此提示「放大到 15 级后才显示图标」——否则用户在 zoom 12.5 拨开公厕，
   * 屏幕上什么都不会变，只能怀疑开关坏了（实测就是这个症状）。
   */
  onStationZoomChange?: (ok: boolean, zoom: number) => void;
  /**
   * ★ M4（需求 2）：巴士站点图层开关。默认 `true` ⇒ 行为与改前**逐字节一致**
   * （关掉时走 `clearAll()`，是数据层不建 marker，不是 `visibility:hidden`）。
   */
  showBusStations?: boolean;
  /** ★ 需求 7：点地标 / 聚合点 ⇒ 宿主开小窗（参数 = 该组地标 id，1 个或 2 个） */
  onXborderPinClick?: (ids: string[]) => void;
  /** 附加类名（承载全屏布局） */
  className?: string;
}

export default function NavMap({
  jsKey,
  mapStyleId = "",
  dest,
  origin,
  view,
  onLocate,
  onStationClick,
  onMapClick,
  onMapReady,
  locateTick = 0,
  className = "",
  routeLine = null,
  onRouteDirs,
  stopsInsetTop = null,
  vehicles = NO_VEHICLES,
  onVehicleClick,
  overview = null,
  walk = null,
  walkVersion = 0,
  hasExternalPos = false,
  walkGhosts = null,
  userFix = null,
  traveled = null,
  lineStops = null,
  userDotSmoothMs = 0,
  tqhStations = null,
  tqhActiveIds = null,
  tqhSegments = null,
  tqhSharedBusCodes = null,
  tqhActiveBusCodes = null,
  tqhBusWhitelist = null,
  tqhWhitelist = null,
  onTqhStationClick,
  showXborderPins = false,
  xborderKinds = null,
  showToilets = false,
  onToiletClick,
  onStationZoomChange,
  showBusStations = true,
  onXborderPinClick,
}: NavMapProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  /**
   * ★ M4：巴士站点图层开关的 ref 副本 —— `render()` 是被 `zoomend`/`moveend` 节流调用的
   * 回调，闭包里的 prop 可能滞后一帧；用 ref 让「刚拨开关就重绘」永远读到最新值。
   */
  const showBusRef = useRef(showBusStations);
  showBusRef.current = showBusStations;
  /** ★ M4：站点图层 `render()` 的句柄（供「拨开关立即重绘」用；见该 effect 里的赋值） */
  const renderRef = useRef<(() => void) | null>(null);
  /** ★ M4：缩放阈值回写回调（走 ref，避免进 render() 的闭包依赖导致全量重建） */
  const zoomCbRef = useRef(onStationZoomChange);
  useEffect(() => {
    zoomCbRef.current = onStationZoomChange;
  }, [onStationZoomChange]);

  /* ★ M4：巴士站点开关拨动 ⇒ 立即重绘（不等下一次 zoomend/moveend） */
  useEffect(() => {
    renderRef.current?.();
  }, [showBusStations]);


  /** `.nav-map` 根元素（写观测钩子：data-map-follow / data-map-zoom / …） */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  /** 高德命名空间（供右上定位按钮重跑定位） */
  const amapRef = useRef<any>(null);
  const userMarkerRef = useRef<any>(null);
  const destMarkerRef = useRef<any>(null);
  /** ★ 2026-09-22：出发地标记（与目的地图标同构） */
  const originMarkerRef = useRef<any>(null);
  const maskRef = useRef<any>(null);
  const locatedRef = useRef(false);
  /** 澳门边界结果（ref；供定位「是否在澳门内」判定） */
  const districtRef = useRef<MacauDistrict | null>(null);
  /** 是否已应用范围限制（setLimitBounds 成功） */
  const boundsAppliedRef = useRef(false);
  /** 定位早于边界就绪时的暂存坐标（+ 是否显式意图） */
  const pendingLocateRef = useRef<{ pos: { lng: number; lat: number }; focus: boolean } | null>(null);
  /** 最近一次成功定位坐标（mepin 重建用） */
  const lastLocatePosRef = useRef<{ lng: number; lat: number } | null>(null);
  /** 全量站点（一次拉取，ref 缓存）与已渲染标记（code → marker） */
  const stationsRef = useRef<StationPointLite[] | null>(null);
  const stationMarkersRef = useRef<Map<string, any>>(new Map());
  /** ★ v3.6.0 S5：步行三线（done/now/ahead）的 Polyline 句柄 */
  const walkLayersRef = useRef<WalkLayers>({ donePath: null, nowPath: null, aheadPath: null });
  /** ★ 一条导航流：非当前段的步行走廊（ghost，按 key 增量 diff） */
  const walkGhostRef = useRef<Map<string, WalkGhostRec>>(new Map());
  /**
   * ★ 2026-09-22 路线查看模式：
   *   · `routePolylinesRef` 当前画的线（退出时逐个 remove）；
   *   · `routeStopsRef` **本线站点主码集合**（站点图层据此切样式：本线高亮 / 其他变灰）。
   *   ⚠️ 集合为空表示**不在路线模式** —— 站点样式回落到常规。
   */
  const routePolylinesRef = useRef<unknown[]>([]);
  const routeStopsRef = useRef<Set<string>>(new Set());
  /** ★ 2026-09-23：路线总览的 polyline（灰底 z68 + 彩段 z72）；退出 detail 时逐个 remove */
  const overviewPolylinesRef = useRef<unknown[]>([]);
  /** 路线模式切换后触发站点图层重建（marker 的样式在创建时决定，必须重建才生效） */
  const [stationRebuildTick, setStationRebuildTick] = useState(0);
  /**
   * ★ 2026-11-06（修复批 #6 · P0「通琴号站点缩放比例与巴士站不一致」）：
   * **站点是否达到当前场景的显示阈值**（`zoom >= minZoom`）。
   *
   * 唯一计算点 = 巴士站点图层的 `render()`（它本来就算 `minZoom`）；本状态只是把
   * 「这一帧达没达标」原样转给 `TqhStationLayer` 的 `enabled` ——
   * 两层共用**同一个常量、同一次计算、同一时刻**，⇒ 慢慢拉远时同时消失、放大时同时出现。
   * ⚠️ 不要在 `TqhStationLayer` 里另写一个 15（那会变成两份真相，必然漂移）。
   */
  const [stationZoomOk, setStationZoomOk] = useState(false);
  /** 阈值判定镜像（只在**跳变**时 setState，避免 zoomend 高频 setState 抖动整棵 NavMap） */
  /**
   * ★ M4：初值取 `null`（三态）而不是 `false` —— 若初值是 `false`，而本次算出的 `zoomOk`
   * 也是 `false`（首页默认 zoom 12.5 就是这种情况）⇒ 「没变化」⇒ **回调永远不触发**，
   * 宿主拿不到真实缩放状态，面板提示就永远不显示（实测踩过）。
   * 用 `null` 保证**第一次计算必定算作变化**，宿主一定收到一次真值。
   */
  const zoomOkRef = useRef<boolean | null>(null);
  /**
   * ★ 观测钩子（修复批 #6）：通琴号站点图层的**已绘 marker 数**写到 `.nav-map` 根。
   *
   * 为什么不自己数 DOM：marker 增减有两条路径（建 / `clear`），而图层是唯一真相 ⇒
   * 由它上报最准。这是 QA 断言「首页 96 个纯站」「缩到 14 级 ⇒ 0」的唯一手段
   * （既有 `data-tqh-shared-count` 只覆盖双色巴士标，不覆盖通琴号整圆标）。
   * ⚠️ 只写 DOM 属性（不 setState）⇒ 零重渲染成本。
   */
  const onTqhStationCount = useCallback((n: number) => {
    rootRef.current?.setAttribute("data-tqh-station-count", String(n));
  }, []);
  /** 点击回调放进 ref：避免 prop 变化导致图层重新绑定事件 */
  const onStationClickRef = useRef<NavMapProps["onStationClick"]>(undefined);
  const onMapClickRef = useRef<NavMapProps["onMapClick"]>(undefined);
  const onMapReadyRef = useRef<NavMapProps["onMapReady"]>(undefined);
  /** ★ v2.10.0：方向回报回调（放进 ref，避免图层重建） */
  const onRouteDirsRef = useRef<NavMapProps["onRouteDirs"]>(undefined);
  /**
   * ★ 2026-11-06（#5a 收尾）：站序弹窗顶边的实时镜像（渲染期同步赋值，同 `viewRef` 口径）。
   *
   * 为什么是 ref 而不是 effect 依赖：
   *   线路取景 effect 的依赖是 `[routeLine, applyCamera]` —— **只在打开 / 换线 / 换向时跑**。
   *   若把 `stopsInsetTop` 加进依赖，用户每拖一档（half→full→peek）都会重跑整个 effect
   *   （重新 `fetch` route-shapes + 重新取景）⇒ 地图跟着手指跳。用 ref 则：
   *   **触发时机不变，但取景那一刻读到的是最新档位**（取景在 `await fetch` 之后发生，
   *   宿主同一批里已经把档位落定，ref 必然已是最新值）。
   */
  const stopsInsetTopRef = useRef<number | null>(stopsInsetTop);
  stopsInsetTopRef.current = stopsInsetTop;
  /**
   * ★ 2026-09-22：`view` 的实时镜像。
   * 为什么需要：`applyLocateView` 是 `useCallback([])`（空依赖，避免定位回调重绑），
   *   拿不到最新的 `view`；而**定位是异步的**，它常在 view 取景之后完成 ⇒ 又把地图拉回
   *   「我的位置」居中 ⇒ 把目的地的取景覆盖掉（实测：标记掉进被弹窗遮住的下半屏）。
   *   ⇒ 用 ref 让定位逻辑知道「当前有外部取景意图」，有则**不再抢镜头**。
   */
  const viewRef = useRef<NavMapProps["view"]>(null);
  viewRef.current = view;
  /**
   * ★ 本批新增（需求① 取景稳定化 / AC-25~28 / 58 / 59）：
   *   · `destRef` / `originRef`：取景 effect **依赖收敛为 `[view.tick, phase]`** 后，
   *     程序化取景从 ref 读最新 OD（渲染期同步赋值，参照既有 `viewRef`）；
   *   · `followState` / `followRef`：让位锁状态机（`follow` ⇄ `free`）；
   *   · `programmaticRef`：程序化相机调用打标（区分手势 zoomstart 与程序 zoomstart）；
   *   · `lastCmdRef`：最后一次取景意图（恢复按钮/双击重放用）。
   */
  const destRef = useRef<NavMapProps["dest"]>(null);
  destRef.current = dest;
  const originRef = useRef<NavMapProps["origin"]>(null);
  originRef.current = origin;
  const [followState, setFollowState] = useState<"follow" | "free">("follow");
  const followRef = useRef(followState);
  followRef.current = followState;
  const programmaticRef = useRef(false);
  const lastCmdRef = useRef<NavMapProps["view"]>(null);

  /** 让位锁观测钩子（H1）：无副作用，仅 `setAttribute` */
  useEffect(() => {
    rootRef.current?.setAttribute("data-map-follow", followState);
  }, [followState]);

  /**
   * ★ 程序化相机调用**唯一打标入口**（§a.1）：`setZoomAndCenter` / `panBy` / `setBounds`
   *   一律包在本函数内 ⇒ `zoomstart` 中判 `programmaticRef.current` 即可区分
   *   「手势缩放」与「程序缩放」（350ms 覆盖动画时长）。
   */
  const applyCamera = useCallback((fn: () => void) => {
    programmaticRef.current = true;
    try {
      fn();
    } finally {
      window.setTimeout(() => {
        programmaticRef.current = false;
      }, 350);
    }
  }, []);

  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");

  /**
   * ★ M4（QA 钩子 · team-lead 已批准）：`window.__qa.setMapZoom(z)` —— 编程设定缩放。
   *
   * ── 为什么需要 ──────────────────────────────────────────────────────────
   *   本地 Playwright 环境里 AMap **不响应滚轮也不响应双击**（实测 6 次滚轮 + 4 次双击后
   *   `data-map-zoom` 仍是 12.5），而站点/公厕图层的缩放门阈值是 15 ⇒ 真浏览器验收
   *   无法把地图推到阈值以上，「放大后 pin 出现」这一段就验不了。
   *   `setZoom` 是**编程接口**，不走手势链路 ⇒ 不受该环境限制。
   *
   * ── 纪律（四条，逐字照抄先例 `NavShell.tsx` 的 `forceWalkArrived`，缺一不可）──────
   *   ① **仅非生产**：`process.env.NODE_ENV` 在 Next 构建期内联 ⇒ 生产包里是死代码；
   *   ② **不整体覆盖 `window.__qa`**：展开合并，避免踩掉别人挂的键；
   *   ③ **卸载即摘键**：只删自己那一项，其余原样保留；
   *   ④ **不改任何产品行为**：唯一效果是把**已有**的 `map.setZoom` 暴露出去，注册/注销零副作用。
   *
   * ⚠️ 不要在这里顺手做「设置图层开关」「模拟点击」之类的事 —— 钩子只暴露既有能力。
   */
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (phase !== "ready") return;
    const map = mapRef.current;
    if (!map) return;
    const w = window as unknown as { __qa?: Record<string, unknown> };
    w.__qa = { ...(w.__qa ?? {}), setMapZoom: (z: number) => map.setZoom(z) };
    return () => {
      const cur = w.__qa;
      if (!cur) return;
      const next = { ...cur };
      delete next.setMapZoom;
      w.__qa = next;
    };
  }, [phase]);
  const [note, setNote] = useState<string>("");
  /**
   * ★ P0：**定位失败用布尔状态，不用文案反查**。
   *   之前是失败时直接 `setNote("无法定位…")` ⇒ 一旦 `hasExternalPos` 稍后才变 true
   *   （高德先失败、浏览器 GPS 后到，实测就是这个顺序），那句提示会**永久挂着**，
   *   而页面其实完全可用 —— 用户看到"无法定位"却能正常出发。
   *   ⇒ 失败只记布尔；展示文案在渲染处**派生**（条件实时求值，位置一到立刻消失）。
   */
  const [locateFailed, setLocateFailed] = useState(false);
  const [locating, setLocating] = useState(false);

  /**
   * 定位落在澳门范围内 → 居中到定位点（横向 5km）；范围外 → 不移动地图。
   * 蓝点无论如何都按真实坐标落位。
   * @param focus 显式意图（点定位键）——`true` 时**跳过**「有 view 意图则不抢镜头」守卫，强制居中。
   */
  const applyLocateView = useCallback((pos: { lng: number; lat: number }, focus = false) => {
    const map = mapRef.current;
    const canvas = canvasRef.current;
    if (!map) return;
    const dist = districtRef.current;
    const inMacau = dist
      ? isInsideRings(pos.lng, pos.lat, [...dist.rings, ...dist.exclaveRings])
      : true; // 边界未知时按旧行为（居中）
    if (inMacau) {
      // ★ 2026-09-22：定位成功 ⇒ **清掉「无法定位」提示**（此前只设不清，定位恢复后提示仍挂着）
      setNote("");
      canvas?.setAttribute("data-locate-ok", "on");
      // ★ 2026-09-22：若调用方正在做**外部取景**（搜索弹窗要求「目的地居上半屏」或「两点适配」），
      //   定位**不再抢镜头** —— 否则异步定位完成后会把地图拉回「我的位置」居中，
      //   覆盖掉刚做好的取景（实测：标记因此掉进被弹窗遮住的下半屏）。蓝点照常落位。
      // ★ 本批：显式意图（focus=true，点定位键）⇒ 跳过该守卫，强制居中。
      if (!focus && viewRef.current && viewRef.current.mode !== "none") {
        canvas?.setAttribute("data-locate-skip-view", "on");
        return;
      }
      const w: number = map.getSize?.()?.width ?? (typeof window !== "undefined" ? window.innerWidth : 390);
      const z = zoomForAcross(pos.lat, w);
      try {
        applyCamera(() => map.setZoomAndCenter(z, [pos.lng, pos.lat]));
        canvas?.setAttribute("data-nav-zoom", String(z));
      } catch {
        /* 视角设置失败不影响底图 */
      }
    } else {
      // ★ 范围外：不自动移出（保持澳门视野）；蓝点如实落位（可能落在视野之外）
      canvas?.setAttribute("data-locate-outside", "on");
    }
  }, [applyCamera]);

  /**
   * 跑一次定位（首屏 + 右上定位按钮共用）。
   * 范围内 → 居中到定位点；范围外 → 不移动地图（保持澳门视野）；蓝点如实落位。
   */
  const runLocate = useCallback(
    (opts?: { focus?: boolean }) => {
      const AMap = amapRef.current;
      const map = mapRef.current;
      if (!AMap || !map) return;
      const focus = opts?.focus === true;
      const geo = new AMap.Geolocation({ enableHighAccuracy: true, timeout: 10_000, convert: true });
      setLocating(true);
      geo.getCurrentPosition((status: string, result: any) => {
        setLocating(false);
        if (status === "complete" && result?.position) {
          // ★ position 已是 GCJ-02（convert:true）→ 不再转换
          const pos = { lng: result.position.lng, lat: result.position.lat };
          locatedRef.current = true;
          lastLocatePosRef.current = pos;
          setLocateFailed(false); // ★ P0：定位成功 ⇒ 失败标记归零（与下方 setNote("") 同源）
          canvasRef.current?.removeAttribute("data-locate-outside");
          // ★ 本批：GPS 实时蓝点（UserDotLayer）存在时，**不再创建 mepin**（单一点，AC-40/41）。
          if (!userFix && mapRef.current) {
            if (userMarkerRef.current) userMarkerRef.current.setPosition([pos.lng, pos.lat]);
            else {
              userMarkerRef.current = new AMap.Marker({
                position: [pos.lng, pos.lat],
                content: '<div class="nav-map__mepin" aria-label="我的位置"></div>',
                offset: new AMap.Pixel(-9, -9),
                zIndex: 110,
              });
              mapRef.current.add(userMarkerRef.current);
            }
          }
          if (boundsAppliedRef.current) applyLocateView(pos, focus);
          else pendingLocateRef.current = { pos, focus }; // 边界未就绪 → 暂存，就绪后再决定
          onLocate?.(pos);
        } else {
          /**
           * ★ 定位失败 → 停在澳门视野（不重设视角）。
           * ★ P0：只记**布尔**，不写文案 —— 展示在渲染处派生（见 `noteText`）。
           *   因为高德可能先失败、浏览器 GPS 后到（实测就是这个顺序），
           *   若在此写死文案，`hasExternalPos` 变 true 后那句"无法定位"会永久挂着，
           *   而页面其实完全可用 ⇒ 用户看到"无法定位"却能出发 = 假话。
           */
          setLocateFailed(true);
          onLocate?.(null);
        }
      });
    },
    [applyLocateView, onLocate, userFix],
  );

  const init = useCallback(async () => {
    setPhase("loading");
    setNote("");
    try {
      if (!jsKey) throw new Error("缺少 AMAP_JS_KEY");
      const AMap = await loadAMap(jsKey, ["AMap.Geolocation", "AMap.DistrictSearch"]);
      amapRef.current = AMap;
      if (!canvasRef.current) return;
      // 先建图（放澳门中心，避免白屏）——边界就绪后再收敛视野。
      // ★ 2026-09-22 交互手感优化（用户反馈「操作要更丝滑舒适」）：
      //   · `rotateEnable:false` / `pitchEnable:false` —— 手机双指极易误触旋转与倾斜，
      //     转歪之后用户很难掰回来；这是公交导航，本就不需要 3D 视角 ⇒ 直接禁掉。
      //   · `keyboardEnable:false` —— 键盘方向键会平移地图，**与页面输入框抢按键**
      //     （在搜索框里按方向键会莫名挪地图）；移动端也用不到键盘操作 ⇒ 禁掉。
      //   · `animateEnable:true` / `jogEnable:true` —— 显式开启视图动画与惯性平移，
      //     拖拽后带惯性滑行，手感更顺。
      const map = new AMap.Map(canvasRef.current, {
        zoom: INIT_ZOOM,
        center: [MACAU_CENTER.lng, MACAU_CENTER.lat],
        viewMode: "2D",
        // ★ AC-16：隐藏底图自带的公交站点图标（走自定义样式）；未配置 ⇒ 用默认样式（降级安全）
        ...(mapStyleId ? { mapStyle: `amap://styles/${mapStyleId}` } : {}),
        resizeEnable: true,
        rotateEnable: false,
        pitchEnable: false,
        keyboardEnable: false,
        animateEnable: true,
        jogEnable: true,
      });
      mapRef.current = map;
      setPhase("ready");
      canvasRef.current?.setAttribute("data-nav-zoom", String(INIT_ZOOM));

      // ── ★ S1：澳门范围（限制 + 收敛 + 遮罩；异步，不阻塞）──
      const canvas = canvasRef.current;
      void (async () => {
        try {
          const dist = await loadMacauDistrict(AMap);
          if (mapRef.current !== map) return; // 已卸载/重建 → 丢弃结果
          districtRef.current = dist;
          const b = dist.bounds;
          const bounds = new AMap.Bounds([b.minLng, b.minLat], [b.maxLng, b.maxLat]);
          // ★ 2026-11-04：限界再外扩 0.05°（≈5.5km）。手机屏窄，原 1.3km 余量在海岸/角落放大时
          //   视野会顶出界 ⇒ AMap 把缩放卡住（实测「某些角落放不大」）；外扩后域外仍由遮罩压暗。
          const lb = padBounds(b, 0.05);
          map.setLimitBounds(new AMap.Bounds([lb.minLng, lb.minLat], [lb.maxLng, lb.maxLat])); // ① 拖不出澳门
          map.setZooms([MIN_ZOOM, MAX_ZOOM]); // ② 拉不远
          applyCamera(() => map.setBounds(bounds)); // ③ 首屏 = 澳门全境（程序化，打标）
          boundsAppliedRef.current = true;
          canvas?.setAttribute("data-limit-bounds", "on");
          canvas?.setAttribute("data-limit-bounds-src", dist.source);
          canvas?.setAttribute("data-nav-zoom", String(map.getZoom?.() ?? ""));

          // ④ 域外遮罩（有大矩形 + 澳门官方环即画；填充恒为深色，见 `maskFill`）
          const fill = maskFill();
          if (dist.rings.length) {
            try {
              // ★ 2026-11-04：遮罩**只挖澳门主环**，不再挖横琴口岸 / 澳大横琴校区两块飞地。
              //   用户反馈「横琴口岸和澳门大学右侧那一点点黑的」不美观 —— 飞地环与主环之间的
              //   窄缝会露出小块暗斑；去掉飞地镂空后，整个域外压暗连成一片，视觉更干净。
              //   飞地不受影响：站点 marker 在遮罩之上（zIndex 90+），定位判定仍用
              //   `dist.exclaveRings`（见 `applyLocateView`）。
              const path = [maskOuterRing(b), ...dist.rings];
              maskRef.current = new AMap.Polygon({
                path,
                fillColor: fill,
                fillOpacity: MASK_OPACITY,
                strokeOpacity: 0,
                zIndex: 50, // 低于站点/定位/目的地标记（90+），避免压住可点元素
                bubble: false, // 不参与事件冒泡（镂空部分不触发事件）
              });
              map.add(maskRef.current);
              canvas?.setAttribute("data-map-mask", "on");
            } catch {
              canvas?.setAttribute("data-map-mask", "off");
            }
          } else {
            canvas?.setAttribute("data-map-mask", "off");
          }

          // 边界就绪前已拿到的定位 → 此刻再决定是否居中
          if (pendingLocateRef.current) {
            const p = pendingLocateRef.current;
            pendingLocateRef.current = null;
            applyLocateView(p.pos, p.focus);
          }
        } catch {
          // 连 setLimitBounds 都失败 → 完全降级（不阻塞任何功能）
          canvas?.setAttribute("data-limit-bounds", "off");
          canvas?.setAttribute("data-map-mask", "off");
        }
      })();

      // ── 地图中心读取器（供分步弹层第 2 步「用这个点」）──
      onMapReadyRef.current?.(() => {
        try {
          const c = mapRef.current?.getCenter?.();
          const lng = c?.getLng?.() ?? c?.lng;
          const lat = c?.getLat?.() ?? c?.lat;
          if (typeof lng === "number" && typeof lat === "number") return { lng, lat };
        } catch {
          /* ignore */
        }
        return null;
      });

      // ── 定位（★ S1：范围内才居中；范围外如实落位、不移动地图）──
      runLocate();
    } catch (e) {
      setPhase("failed");
      setNote((e as Error)?.message ?? "地图加载失败");
      onLocate?.(null);
    }
  }, [jsKey, mapStyleId, runLocate, applyLocateView, onLocate, applyCamera]);

  useEffect(() => {
    void init();
    return () => {
      try {
        mapRef.current?.destroy?.();
      } catch {
        /* ignore */
      }
      mapRef.current = null;
      userMarkerRef.current = null;
      destMarkerRef.current = null;
      originMarkerRef.current = null;
      maskRef.current = null;
      districtRef.current = null;
      boundsAppliedRef.current = false;
      pendingLocateRef.current = null;
      lastLocatePosRef.current = null;
      // ★ 本批：卸载/重建（jsKey 变）→ 让位锁与程序化打标复位
      setFollowState("follow");
      programmaticRef.current = false;
      lastCmdRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jsKey]);

  // ── 容器尺寸变化（全屏化 / 横竖屏）→ 地图 resize（防白屏/错位，风险 #2）──
  useEffect(() => {
    if (phase !== "ready") return;
    const onResize = () => {
      try {
        mapRef.current?.resize?.();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    // 布局稳定后再 resize 一次（全屏容器接管后尺寸才确定）
    const t = setTimeout(onResize, 200);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      clearTimeout(t);
    };
  }, [phase]);

  // ── 目的地标记 + ★ S2：居中到目的地（异步，不阻塞）──
  useEffect(() => {
    const AMap = typeof window !== "undefined" ? window.AMap : undefined;
    const map = mapRef.current;
    if (!map || !AMap || phase !== "ready") return;
    try {
      if (!dest) {
        if (destMarkerRef.current) {
          map.remove(destMarkerRef.current);
          destMarkerRef.current = null;
        }
        return;
      }
      const pos = [dest.lng, dest.lat];
      if (destMarkerRef.current) destMarkerRef.current.setPosition(pos);
      else {
        destMarkerRef.current = new AMap.Marker({
          position: pos,
          // ★ v3.3.0（AC-92 · ADR-102）：**内联 SVG**（不再经「外链文件 + CSS background + filter」）
          //   类名 `.nav-map__destpin` 保留（QA 选择器不失效）。
          content: '<div class="nav-map__destpin" aria-hidden="true">' + PIN_SVG_DEST + "</div>",
          // ★ v2.15：新终点钉 20×26，钉尖在底边中点 ⇒ offset y 取 -26（全高），
          //   令钉尖精确锚定坐标点（旧址 -20 是歪水滴的凑数值，会让尖浮在点上方）。
          offset: new AMap.Pixel(-10, -26),
          title: dest.label,
          zIndex: 120,
        });
        map.add(destMarkerRef.current);
      }
      // ★ S2「地图标定」：选完目的地 → 居中到该点（限制范围内自动收敛）
      // ★ 2026-09-22：若调用方给了 `view`（新版搜索弹窗），取景改由下面的 view effect 统一负责
      //   —— 因为那时需要「居上半屏」或「适配两点」，不能简单 setCenter。不传 `view` 时保持原行为。
      // ★ 本批：`free` 让位锁生效时**不抢镜头**（用户此后不再被打断，AC-27）。
      if (!view && followRef.current !== "free") {
        try {
          applyCamera(() => map.setCenter(pos));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 标记失败不影响底图 */
    }
  }, [dest, phase, view, applyCamera]);

  // ── ★ 2026-09-22 新增：**出发地标记**（选完出发地后与目的地同时显示）──
  useEffect(() => {
    const AMap = typeof window !== "undefined" ? window.AMap : undefined;
    const map = mapRef.current;
    if (!map || !AMap || phase !== "ready") return;
    try {
      if (!origin) {
        if (originMarkerRef.current) {
          map.remove(originMarkerRef.current);
          originMarkerRef.current = null;
        }
        return;
      }
      const pos = [origin.lng, origin.lat];
      if (originMarkerRef.current) originMarkerRef.current.setPosition(pos);
      else {
        originMarkerRef.current = new AMap.Marker({
          position: pos,
          // ★ v3.3.0（AC-92 · ADR-102 · 硬口径）：**内联 SVG 红钉**（`#B4342A`）——
          //   起点语义恒由红钉承载（含「起点 = 我的位置」），**不得以蓝点替代**；类名保留。
          content: '<div class="nav-map__originpin" aria-hidden="true">' + PIN_SVG_ORIGIN + "</div>",
          // ★ v3.1.1 #4：由 18px 圆点改为钉形（20×26，钉尖在底边中点）⇒ offset 同终点钉
          //   （-10, -26 = -w/2, -h）令**钉尖**精确锚定坐标点。
          offset: new AMap.Pixel(-10, -26),
          title: origin.label,
          zIndex: 110,
        });
        map.add(originMarkerRef.current);
      }
    } catch {
      /* 标记失败不影响底图 */
    }
  }, [origin, phase]);

  /**
   * ★ 2026-09-22 新增：**视口取景**（新版搜索弹窗覆盖在地图上时用）。
   * 为什么需要独立的取景函数：新版弹窗是**覆盖层**（下半屏遮住地图）。
   *   若沿用「容器中心居中」，标记会落进被遮住的下半屏 ⇒ 用户看不见 ✗
   *   ⇒ `dest-center-top` 把视口上移 1/4 屏；`fit-two` 自算让两点都落在上半屏。
   *
   * ★ 本批（需求① / AC-59）：抽出 **`applyView(cmd)` —— 唯一相机入口**。
   *   只被两处调用：① 取景 effect（`view.tick` 变化）；② 恢复按钮 / 双击地图 `restore()`。
   *   **严禁**在任何数据 effect（总览绘制 / 站点图层 / 车辆 / OD 标记）中调用。
   *   所有 `setZoomAndCenter` / `panBy` 一律经 `applyCamera` 打标（区分手势/程序缩放）。
   */
  const applyView = useCallback(
    (cmd: NavMapProps["view"]) => {
      const map = mapRef.current;
      if (!map || !cmd || cmd.mode === "none") return;
      const dest = destRef.current;
      const origin = originRef.current;
      const winH = typeof window !== "undefined" ? window.innerHeight : 800;

      if (cmd.mode === "dest-center-top") {
        if (!dest) return;
        try {
          // ★ 关键点：`immediately=true`（第 3 参）**关掉缩放动画**。
          //   踩坑记录（三次尝试）：
          //     ① `setZoomAndCenter` 默认带动画，紧随的 `panBy` 被动画中断 ⇒ 标记停在下半屏；
          //     ② 改用 `setFitView` + 45% 底部留白 ⇒ 改善但仍偏下；
          //     ③ 留白提到 70% ⇒ **过度矫正，标记被推出视野**。
          //   ⇒ 正解：先**无动画**居中，再平移固定比例 —— 可控且可预期。
          const size = map.getSize?.() ?? { width: 390, height: winH };
          const h: number = size.height ?? winH;
          /**
           * ★ 2026-09-24：改按**真实遮挡区**取景 —— 读 RoutePanel（`.rpanel`）真实顶边，
           *   把点从整屏中心抬到「面板上方可见区」的中心；读不到（桌面右栏 / 异常）⇒
           *   回落旧口径「上移 1/5 屏」。
           */
          const panelTop = panelTopPx(h);
          applyCamera(() => {
            map.setZoomAndCenter(16, [dest.lng, dest.lat], true);
            map.panBy(0, panelTop !== null ? Math.round(h / 2 - panelTop / 2) : Math.round(h * 0.2));
          });
        } catch {
          /* ignore */
        }
        return;
      }

      if (cmd.mode === "fit-two") {
        if (!origin || !dest) return;
        /**
         * ★ 2026-09-22 二次修复「选完出发地后地图跑到珠海/西边」。
         *
         * 前一版用 `setFitView(overlays, …)` + 等 marker 就绪重试 —— **实测仍然失效**：
         *   取景后 zoom 掉到最小值 11（= 一屏 27.6km），中心跑到珠海斗门/黄杨山一带 ✗
         *   （`setFitView` 内部会参考 `setLimitBounds` 与遮罩范围，在这个「底图限制在澳门」
         *     的场景下把视野撑到了极限。）
         *
         * 现改为**完全自算**，不依赖任何 marker 或 fitView：
         *   ① 中心 = 两点中点；
         *   ② 由经纬跨度**反推 zoom**（留 1.25 倍余量），可用像素 = **未被面板遮挡的区域**；
         *   ③ `setZoomAndCenter(..., immediately=true)` 无动画落位，再 `panBy` 把中点抬到
         *      「可见槽中心」。
         * ★ 2026-09-24：可用高度由「写死半屏」改为 **RoutePanel 真实顶边**（读不到回落半屏）。
         */
        try {
          const centerLat = (origin.lat + dest.lat) / 2;
          const centerLng = (origin.lng + dest.lng) / 2;
          const size = map.getSize?.() ?? { width: 390, height: 700 };
          // 可用视野：宽留 50px/侧（marker 宽约 30px + 呼吸位）；高 = 面板顶边以上，留 20px 呼吸位
          const availW = Math.max(80, size.width - 100);
          const panelTop = panelTopPx(size.height);
          const slotTop = panelTop !== null ? panelTop : Math.round(size.height / 2);
          const availH = Math.max(80, slotTop - 20);
          // 两点跨度 × 1.25：让两点占据可用区的大部分（取 2.8 会太保守 ⇒ zoom 被压到 11）
          const lngSpan = Math.max(Math.abs(origin.lng - dest.lng) * 1.25, 1e-5);
          const latSpan = Math.max(Math.abs(origin.lat - dest.lat) * 1.25, 1e-5);
          const zx = Math.log2((360 * availW) / (256 * lngSpan));
          const zy = Math.log2(
            (360 * availH) / (256 * latSpan * Math.cos((centerLat * Math.PI) / 180)),
          );
          // 下限 12：跨全澳的远距离 OD 也至少能看清陆地方位；上限 16：两点很近时不要怼到街景级
          const z = Math.max(12, Math.min(16, Math.floor(Math.min(zx, zy))));
          applyCamera(() => {
            map.setZoomAndCenter(z, [centerLng, centerLat], true);
            // 把「两点中点」从整屏中心抬到「可见槽中心」；回落口径 = 上移 1/4 屏
            map.panBy(
              0,
              panelTop !== null ? Math.round(size.height / 2 - panelTop / 2) : Math.round(size.height / 4),
            );
          });
          canvasRef.current?.setAttribute("data-nav-zoom", String(z));
          canvasRef.current?.setAttribute("data-view-mode", "fit-two-selfcalc");
        } catch {
          /* ignore */
        }
        return;
      }

      /**
       * ★ 2026-09-23：`fit-box` —— 把外包框适配进「面板顶边以上的可视槽」（自算，禁 setBounds）。
       * `slotTopPx` = 当前档面板顶边像素（full≈12vh / half=50vh / peek=80vh）；
       * 复用 `fit-two` 的反推 zoom 逻辑（宽/高按可用区，留呼吸位），再把框中心抬到「顶部槽中心」。
       * ★ 2026-09-24：呼吸边距接上设计 Token `--map-fit-gap`（此前悬空未接线；回落 20）。
       *
       * ★ v3.6.0 S5：**新增 `insetTopPx` / `insetBottomPx`**（步行跟随两侧都占：
       *   顶部 `.walkturn` 横幅 + 底部面板）。两者任一存在 ⇒ 走"中带"算法；
       *   **都不传时旧路径一字不改**（recommend/detail 取景完全不受影响）。
       *   ⚠️ 不要改用 `map.setFitView`：本文件 `:694-708` 有实测记录 ——
       *   `setFitView` 在 `setLimitBounds(澳門)` 下会把 zoom 打到 11、中心跑到珠海斗门。
       */
      if (cmd.mode === "fit-box") {
        const box = cmd.box;
        if (!box) return;
        try {
          const size = map.getSize?.() ?? { width: 390, height: 700 };
          const gap = fitGapPx();
          const hasInset = cmd.insetTopPx != null || cmd.insetBottomPx != null;
          const insetTop = Math.max(0, Math.round(cmd.insetTopPx ?? 0));
          const insetBottom = Math.max(0, Math.round(cmd.insetBottomPx ?? 0));
          /** 旧口径：可视槽顶边（= 面板顶边）；新口径：中带高/中心 */
          const slotTop = Math.max(80, Math.round(cmd.slotTopPx ?? size.height * 0.12));
          const centerLat = (box.minLat + box.maxLat) / 2;
          const centerLng = (box.minLng + box.maxLng) / 2;
          // 可用区：宽留 50px/侧；高按「顶边以上区域」或「中带」
          const availW = Math.max(80, size.width - 100);
          const availH = hasInset
            ? Math.max(80, size.height - insetTop - insetBottom - gap * 2)
            : Math.max(80, slotTop - gap * 2);
          const lngSpan = Math.max((box.maxLng - box.minLng) * 1.25, 1e-5);
          const latSpan = Math.max((box.maxLat - box.minLat) * 1.25, 1e-5);
          const zx = Math.log2((360 * availW) / (256 * lngSpan));
          const zy = Math.log2(
            (360 * availH) / (256 * latSpan * Math.cos((centerLat * Math.PI) / 180)),
          );
          const z = Math.max(12, Math.min(16, Math.floor(Math.min(zx, zy))));
          applyCamera(() => {
            map.setZoomAndCenter(z, [centerLng, centerLat], true);
            if (hasInset) {
              /** 中带中心（屏坐标 y）：把框中心从整屏中心平移到中带中心 */
              const midY = insetTop + (size.height - insetTop - insetBottom) / 2;
              map.panBy(0, Math.round(size.height / 2 - midY));
            } else {
              // 框中心：从整屏中心（size.height/2）抬到「顶部槽中心」（slotTop/2）
              map.panBy(0, Math.round(size.height / 2 - slotTop / 2));
            }
          });
          canvasRef.current?.setAttribute("data-nav-zoom", String(z));
          canvasRef.current?.setAttribute("data-view-mode", "fit-box-selfcalc");
        } catch {
          /* ignore */
        }
      }
    },
    [applyCamera],
  );

  /** 恢复入口：回到跟随 + 重放最后一次取景意图（§a.4） */
  const restore = useCallback(() => {
    setFollowState("follow");
    const cmd = lastCmdRef.current ?? viewRef.current;
    if (cmd && cmd.mode !== "none") applyView(cmd);
  }, [applyView]);

  /**
   * 取景 effect（★ 依赖收敛为 `[view.tick, phase]`；`dest/origin` 改 ref 读）：
   *   · **让位锁**（AC-59 核心）：`free` 态**跳过一切自动取景**（含 `frame()` 指令）；
   *   · 记录最后一次意图（`lastCmdRef`）供 `restore()` 重放。
   */
  const viewTick = view?.tick ?? 0;
  useEffect(() => {
    const cmd = viewRef.current;
    if (!cmd || cmd.mode === "none") return;
    lastCmdRef.current = cmd;
    if (phase !== "ready") return;
    /**
     * ★ 2026-11-06（修复批 #6b）：`cmd.force` = **显式意图**（选中某条班次线），
     *   与定位键（`locateTick` 里 `setFollowState("follow")`）同权 ⇒ **解除让位锁后取景**。
     *
     * 不放行会怎样：用户先缩放/拖动地图找车（⇒ 锁变 `free`），再点班次 ⇒
     *   取景被本行静默跳过，视野纹丝不动、无任何提示 = 需求未实现却零信号。
     * ⚠️ 只有显式选择类指令带 `force`（见 `FrameCmd.force` 注释）；
     *   GPS / 面板落定 / 数据到达类取景**一律不带** —— 否则让位锁形同废纸。
     */
    if (followRef.current === "free" && !cmd.force) return; // ★ 让位锁：free 态跳过自动取景
    if (cmd.force) setFollowState("follow");
    applyView(cmd);
  }, [viewTick, phase, applyView]);

  /**
   * ★ 本批：让位锁事件注册（dragstart / zoomstart / dblclick）。
   *   · `dragstart` 恒为用户行为 ⇒ free；
   *   · `zoomstart` 仅当**非程序化**（`programmaticRef`）时 ⇒ free；
   *   · `dblclick` ⇒ `restore()`（辅助恢复入口）。
   */
  useEffect(() => {
    if (phase !== "ready") return;
    const map = mapRef.current;
    if (!map) return;
    const onDragStart = () => setFollowState("free");
    const onZoomStart = () => {
      if (!programmaticRef.current) setFollowState("free");
    };
    const onDblClick = () => restore();
    map.on("dragstart", onDragStart);
    map.on("zoomstart", onZoomStart);
    map.on("dblclick", onDblClick);
    return () => {
      try {
        map.off("dragstart", onDragStart);
        map.off("zoomstart", onZoomStart);
        map.off("dblclick", onDblClick);
      } catch {
        /* ignore */
      }
    };
  }, [phase, restore]);

  /**
   * ★ 本批：观测钩子 H2 `data-map-zoom`（**实时**实测 zoom；AC-25/26/59 跨刷新比对）。
   *   ⚠️ 与既有 `data-nav-zoom`（程序设定值）语义不同，勿混用。
   */
  useEffect(() => {
    if (phase !== "ready") return;
    const map = mapRef.current;
    if (!map) return;
    const write = () => {
      try {
        rootRef.current?.setAttribute("data-map-zoom", String(map.getZoom()));
      } catch {
        /* ignore */
      }
    };
    write();
    map.on("zoomend", write);
    return () => {
      try {
        map.off("zoomend", write);
      } catch {
        /* ignore */
      }
    };
  }, [phase]);

  /**
   * ★ 本批（需求⑤ / AC-40/41）：GPS 实时蓝点存在时**移除 mepin**（两者不并存）；
   *   蓝点消失（拒权/无信号）且已定位过 ⇒ 用最近坐标**重建 mepin**。
   */
  useEffect(() => {
    if (phase !== "ready") return;
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map) return;
    try {
      if (userFix) {
        if (userMarkerRef.current) {
          map.remove(userMarkerRef.current);
          userMarkerRef.current = null;
        }
        return;
      }
      const pos = lastLocatePosRef.current;
      if (locatedRef.current && pos && !userMarkerRef.current && AMap) {
        userMarkerRef.current = new AMap.Marker({
          position: [pos.lng, pos.lat],
          content: '<div class="nav-map__mepin" aria-label="我的位置"></div>',
          offset: new AMap.Pixel(-9, -9),
          zIndex: 110,
        });
        map.add(userMarkerRef.current);
      }
    } catch {
      /* ignore */
    }
  }, [userFix, phase]);

  // ★ 同步点击回调到 ref（避免回调变化导致图层重建）
  useEffect(() => {
    onStationClickRef.current = onStationClick;
  }, [onStationClick]);
  useEffect(() => {
    onMapClickRef.current = onMapClick;
  }, [onMapClick]);

  // ★ 同步「地图中心读取器」回调到 ref
  useEffect(() => {
    onMapReadyRef.current = onMapReady;
  }, [onMapReady]);

  // ★ 同步「方向回报」回调到 ref
  useEffect(() => {
    onRouteDirsRef.current = onRouteDirs;
  }, [onRouteDirs]);
  // ★ 车辆点击回调直接交给 `VehicleLayer`（原生化层自管 ref），此处不再缓存

  // ★ 定位按钮（品牌栏原位 / 导航态浮动）：locateTick 变化 → **立即聚焦 + 后台刷新**
  //   ★ 本批：点定位键 = **显式意图** ⇒ 先恢复跟随，再强制居中（`focus: true`，AC-27）
  //   ★ v3.3.0（AC-101）：**先**用「最近一次已知位置」立即居中（不等待新 fix）；
  //     无已知位置（冷启动 / 首次定位尚未返回）⇒ 只走 `runLocate`（其 `setLocating(true)` 即加载态）。
  useEffect(() => {
    if (locateTick > 0) {
      setFollowState("follow"); // 恢复跟随（让位锁解除）
      const known =
        lastLocatePosRef.current ?? (userFix ? { lng: userFix.lng, lat: userFix.lat } : null);
      if (known) applyLocateView(known, true); // 立即聚焦（不等新 fix）
      runLocate({ focus: true }); // 后台刷新（到达后用更准坐标再校正一次）
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locateTick]);

  // ── 地图空白处点击（S2 分步搜索「地图标定」）──
  useEffect(() => {
    if (phase !== "ready") return;
    const map = mapRef.current;
    if (!map) return;
    const onClick = (e: any) => {
      const lng = e?.lnglat?.getLng?.() ?? e?.lnglat?.lng;
      const lat = e?.lnglat?.getLat?.() ?? e?.lnglat?.lat;
      if (typeof lng === "number" && typeof lat === "number") onMapClickRef.current?.({ lng, lat });
    };
    map.on("click", onClick);
    return () => {
      try {
        map.off("click", onClick);
      } catch {
        /* ignore */
      }
    };
  }, [phase]);

  // ── ★ 巴士站点图层（仅阈值内、仅视野内）──
  useEffect(() => {
    if (phase !== "ready") return;
    const AMap = typeof window !== "undefined" ? window.AMap : undefined;
    const map = mapRef.current;
    if (!map || !AMap) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

    const clearAll = () => {
      for (const [, mk] of stationMarkersRef.current) {
        try {
          map.remove(mk);
        } catch {
          /* ignore */
        }
      }
      stationMarkersRef.current.clear();
    };

    const render = () => {
      if (cancelled) return;
      try {
        const zoom = typeof map.getZoom === "function" ? map.getZoom() : 0;
        // ★ 无副作用观测钩子（同 `data-nav-zoom` 传统）：自动化验收读取实际生效的 zoom
        canvasRef.current?.setAttribute("data-nav-z", String(zoom));
        // ★ 本批（需求② / AC-29~31）：**站点白名单**
        //   · 宿主在路线查看 / 导航模式传入 `lineStops`（各腿站点并集）；
        //   · 空集保护：`lineStops` 空 ⇒ 折成 null（不过滤）；路线模式回落 `routeStopsRef`。
        /**
         * ★ 2026-11-06（修复批 #6 · P0「通琴号路线模式未隐藏其它站点」）：
         * **通琴号班次模式的白名单优先级最高**，直接接管本图层的过滤口径。
         *
         * 病根：`tqhWhitelist` 只过滤通琴号图层 ⇒ 进班次查看后通琴号其它站消失了，
         *   巴士层却完全没过滤 ⇒ 满屏巴士站还在（负责人报的 P0）。
         * 现口径（负责人裁决「全部隐藏」）：班次模式下白名单 = 本班关联巴士主码；
         *   本班没有关联巴士站 ⇒ **空集** ⇒ 一个都不建（`Set` 实例恒 truthy，
         *   ⇒ 下面的 `white && !white.has(...)` 会全部 `continue`，最终
         *   「移出视野」清理段把已有 marker 全部 remove —— 与拉远清空同口径）。
         * 不接管（`null`）时**逐字节保持**既有 `lineStops` → `routeStops` 逻辑。
         */
        const tqhOnly = tqhBusWhitelist != null;
        const white = tqhOnly
          ? tqhBusWhitelist
          : lineStops && lineStops.size > 0
            ? lineStops
            : routeStopsRef.current.size > 0
              ? routeStopsRef.current
              : null;
        // ★ 观测钩子 H3：站点图层过滤态（nav=白名单 / route=本线 / tqh=通琴号班次 / all=不过滤）
        //   ⚠️ 契约（07 §1.1/§1.2）：**唯一挂载点 = `.nav-map` 根**（选择器 `.nav-map[data-station-layer]`）
        //   ★ 2026-11-06（#6）：新增第 4 个取值 `tqh`（**追加**，不改既有三值语义）——
        //     QA 用它区分「班次模式接管了巴士层」与「既有白名单」。
        rootRef.current?.setAttribute(
          "data-station-layer",
          tqhOnly
            ? "tqh"
            : lineStops && lineStops.size > 0
              ? "nav"
              : routeStopsRef.current.size > 0
                ? "route"
                : "all",
        );
        // ★ 2026-09-22：路线模式下阈值放宽（否则长线缩到全澳后站点全消失，看不到高亮）
        // ★ 本批：导航模式（白名单）同样放宽 —— 详情 fit-box 常在 zoom≈13 ⇒ 沿用路线档阈值
        /**
         * ══════════════════════════════════════════════════════════════════════
         * ★ 2026-11-06（修复批 #6b · #2 取景配套）：通琴号班次模式归入 `routeMode`
         * ══════════════════════════════════════════════════════════════════════
         *
         * ── ① 为什么 `tqhBusWhitelist != null` 要算进 `routeMode` ──────────────
         *   它**只在通琴号班次模式下非空**（导航态 / 浏览态都折成 `null`，
         *   见 `NavShell` 的 `tqhBusWhitelist` 派生注释）⇒ 判据天然只命中该场景，
         *   不会把阈值效应泄漏到别的模式。
         *
         * ── ② 这不是「为班次模式放宽阈值」，而是「同类场景取同一档」─────────────
         *   本常量的语义是「**需要装下整条线路**时的站点阈值」。班次取景
         *   （`NavShell` 的 `tqhFitBox` → `frame({mode:"fit-box"})`）与线路查看模式
         *   **是同一类场景**：都要把一条线整条装进视野，`fit-box` 的 clamp 下限 12
         *   ⇒ 落点必然 12~13。两者用同一档（`STATION_MIN_ZOOM_ROUTE`）是一致性，
         *   **不是给通琴号开的特例**。
         *   反过来说：若这里保留 15，就变成"班次模式需要 15 级才看得到站"，
         *   而它自己的取景恰好把它放在 12~13 ⇒ 自相矛盾。
         *
         * ── ③ 与 #5 的「统一比例尺」不冲突（关键的不变量没破）──────────────────
         *   #5 要的是「**同一缩放级别下两者同生同灭**」。两层用的仍是**同一个
         *   `minZoom`、同一次 `render()` 计算**（下行 `zoomOk` 单一真相）
         *   ⇒ 不变量一条没破；变的只是「本场景取哪一档」——而这本来就是
         *   巴士层早已存在的机制（线路查看模式 2026-09-22 就从 15 改到了 12，
         *   理由同为「`setBounds` 装下整条线后 zoom 掉到 12~13」）。
         *
         * ── ④ 密度安全（已核算，不是"应该没问题"）───────────────────────────
         *   班次模式下巴士层白名单只剩「本班关联巴士主码」（实测个位数，
         *   典型 0~2 个）；通琴号层只剩本班站点（典型 5~9 个）
         *   ⇒ 12 级不可能糊成一片（与路线模式白名单后的结论同向）。
         *
         * ══════════════════════════════════════════════════════════════════════
         * ⚠️⚠️ 改这一行之前**必须先读完 ②**：
         *   把 12 改回 15（或把 `tqhBusWhitelist != null` 从 `routeMode` 删掉）⇒
         *   **班次取景会静默失效**：`frame()` 照常执行、`data-view-mode` 照常写、
         *   地图照常缩放 —— 但**一个站点都不显示**。不报错、不警告，
         *   用户看到的是"这班车没有站"，排查时也只会怀疑取景算法（而它是对的）。
         *   ⇒ 这是「改了 A 却坏在 B」的典型形态：症状与原因不在同一层。
         *   **要动它请连带跑一遍真浏览器验收：选一个班次 ⇒ 站点必须可见。**
         * ══════════════════════════════════════════════════════════════════════
         */
        const routeMode =
          routeStopsRef.current.size > 0 ||
          (!!lineStops && lineStops.size > 0) ||
          tqhBusWhitelist != null;
        const minZoom = routeMode ? STATION_MIN_ZOOM_ROUTE : STATION_MIN_ZOOM;
        /**
         * ★ 2026-11-06（修复批 #6 · P0「通琴号站点缩放比例与巴士站不一致」）：
         * **把「本次判据是否达标」回写给 `TqhStationLayer`** —— 同一常量、同一次计算、同一时刻。
         *
         * 为什么不是让通琴号图层自己算：那会变成两份真相（它既不知道 `routeMode`，
         *   也有自己的事件时机）⇒ 慢慢拉远时会出现「一个先消失、一个后消失」。
         * 这里 `minZoom` 已经是本场景生效的阈值（路线/导航档 12，常规 15），
         *   `zoomOk` 就是巴士层**此刻**用不用画点的同一个布尔值 ⇒ 两层必然同生同灭。
         *
         * ⚠️ 只为**跳变**触发一次 setState（ref 去重）：`render()` 在 `zoomend`/`moveend`
         *   节流后高频执行，逐帧 setState 会让整个 `NavMap` 抖动。
         */
        const zoomOk = zoom >= minZoom;
        if (zoomOkRef.current !== zoomOk) {
          zoomOkRef.current = zoomOk;
          setStationZoomOk(zoomOk);
        }
        /* ★ M4：每次 render 都回写（不限「变化」）—— 否则提示里的「当前 x 级」会停在首次
           判定的那一帧（实测显示 12.2，而地图已是 12.5）。
           父侧用「值相同返回原对象」的 setState，所以这里频繁调用不会引起重渲染。 */
        zoomCbRef.current?.(zoomOk, zoom);
        if (!zoomOk) {
          clearAll(); // 拉远：清空（产品口径）
          return;
        }
        /**
         * ★ M4（需求 2）：图层开关关掉巴士站点 ⇒ **不建 marker**（数据层过滤）。
         * 位置刻意放在 `zoomOk` 回写**之后**：`stationZoomOk` 是通琴号/公厕图层共用的
         * 缩放真相，不能因为「巴士关了」就把别人的层一起关掉。
         */
        if (!showBusRef.current) {
          clearAll();
          return;
        }
        const data = stationsRef.current;
        if (!data) return;
        const bounds = typeof map.getBounds === "function" ? map.getBounds() : null;
        if (!bounds) return;
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const visible = new Set<string>();
        const stationMain = (c: string) => /^[A-Za-z]+\d+/.exec(String(c ?? ""))?.[0] ?? String(c ?? "");
        for (const s of data) {
          // ★ 白名单外 ⇒ **不创建 marker**（数据层过滤，非 opacity/display 隐藏；AC-29）
          if (white && !white.has(stationMain(s.code))) continue;
          if (s.lat < sw.lat || s.lat > ne.lat || s.lng < sw.lng || s.lng > ne.lng) continue;
          visible.add(s.code);
          if (stationMarkersRef.current.has(s.code)) continue;
          // ★ 2026-09-22：轻轨站与巴士站**样式区分**（产品要求）；
          // ★ v2.10.0：改为「**形状优先**」——
          //   巴士 = 实心青花蓝圆 Ø10；轻轨 = **线路主题色方** 13×13 r3；
          //   换乘站（蓮花 / 協和醫院）= 双色切分。
          //   颜色是**数据**：直接取 `/api/stations` 的 `color/color2`（源头 `routes.color`），
          //   一律以**行内 CSS 变量**注入 —— CSS 里只写渐变**结构**（禁止硬编码线路色）。
          //   切法（斜切/水平切）是**形状结构**、非数据 ⇒ 查 `lrt-transfer.ts`。
          const isLrt = s.kind === "lrt";
          let cutCls = "";
          let styleAttr = "";
          if (isLrt) {
            const c1 = s.color;
            const c2 = s.color2;
            if (c1) styleAttr = ` style="--c1:${esc(c1)}${c2 ? `;--c2:${esc(c2)}` : ""}"`;
            const variant = c2 ? lrtTransferVariantOf(s.code) : undefined;
            if (variant) cutCls = variant === "diag" ? " lrt-cut-diag" : " lrt-cut-half";
          }
          // ★ 2026-09-22 路线查看模式：本线站点高亮、其他站点变灰变小（「一眼分辨」）
          /**
           * ★ 2026-11-06（修复批·裁决 A 方案 2）：**「本线站」不再用类名，改用 `data-on-route="1"`**。
           *
           * 为什么：`globals.css` 那边已把 `.nav-map__station--onroute` 的样式**整块删除**
           *   （用户口径「指定线路的经停站站标与正常站标不同，会有一层白色粗边」）⇒
           *   这个类名变成**零样式死钩子**。死钩子比没钩子更危险：后来人看到类名还在，
           *   很容易往里加样式，立刻重回「两种站标」——正是本次 #3 的病根。
           * ⇒ 语义保留（「本线站」仍是可观测事实），载体换成**属性**（属性不会被误当样式入口）。
           *
           * 「本线 vs 其它」如何仍可分辨：路线模式下 marker 白名单已按本线站点建点
           *   （`white = routeStopsRef`），屏幕上本来就只有本线站；`--dim` 继续承担
           *   「同主码不同站台」的降级态（**该分支不动**）。
           * ⚠️ 不要改成 `data-on-route` 之外的新类名，也不要在 CSS 里补回样式。
           */
          const inRoute = routeStopsRef.current.size > 0;
          const isOnRoute = inRoute && routeStopsRef.current.has(s.code);
          const routeCls = inRoute && !isOnRoute ? " nav-map__station--dim" : "";
          const onRouteAttr = isOnRoute ? ' data-on-route="1"' : "";
          /**
           * ★ 2026-11-06（修复批 #1）：**双色巴士标**。
           *
           * 命中 `tqhSharedBusCodes` 的巴士站 = 同一物理位置也有通琴号站 ⇒ 用
           * 「左半 `--accent`（青花蓝）/ 右半 `--tqh-map-half`（通琴号粉）」**硬停**渐变，
           * 类名复用 `TqhStationLayer` 当年为半圆标的 `.nav-map__station--tqh-shared`
           * （`globals.css` 现有规则，`linear-gradient(90deg … 0 50%, … 50% 100%)`）
           * ⇒ **本轮零新增 CSS**。
           *
           * 判据同时认「主码」和「完整站台码」：`/api/stations` 下发的是主码
           * （`M172/1…/17` 塌成一个 `M172`），而 `bus_station_code` 是站台码 ⇒
           * 调用方传主码集即可；万一传完整码也不漏。
           *
           * ⚠️ 形状仍由 `.nav-map__station`（11px 圆 + 1.5px 白描边）承载，
           *   本类只换 `background`（CSS 里位置在 2593 之后 ⇒ 覆盖生效）；
           *   `--dim` 的灰底同理被覆盖 —— 降级态改为「保留双色 + 缩到 8px + 0.45 透明」，
           *   与轻轨「非本线不抹线路色」的历史结论同向（`globals.css:5508` 注释）。
           */
          const tqhShared =
            !!tqhSharedBusCodes &&
            (tqhSharedBusCodes.has(s.code) || tqhSharedBusCodes.has(stationMain(s.code)));
          const sharedCls = tqhShared ? " nav-map__station--tqh-shared" : "";
          /**
           * ★ 2026-11-06（#1 配套）：本班次经过的关联站（已吸进本标的那些）⇒ 加白环。
           * 只加 `box-shadow` 环、不改 background ⇒ 双色结构与时序高亮互不吃掉。
           */
          const tqhOnTrip =
            !!tqhActiveBusCodes &&
            (tqhActiveBusCodes.has(s.code) || tqhActiveBusCodes.has(stationMain(s.code)));
          const tripCls = tqhOnTrip ? " nav-map__station--tqh-onroute" : "";
          const cls = `nav-map__station${isLrt ? " nav-map__station--lrt" : ""}${cutCls}${routeCls}${sharedCls}${tripCls}`;
          const marker = new AMap.Marker({
            position: [s.lng, s.lat],
            content: `<div class="${cls}" data-code="${esc(s.code)}"${onRouteAttr}${tqhShared ? ' data-tqh-shared="1"' : ""}${tqhOnTrip ? ' data-tqh-on-trip="1"' : ""}${styleAttr} title="${esc(s.name)}"></div>`,
            /**
             * ★ v2.10.1：站点盒尺寸**分类型**（巴士 11px / 轻轨 13px，见 globals.css）
             *   ⇒ 居中偏移各取一半（-5.5 / -6.5），否则小圆点会偏离真实坐标约 1px。
             *
             * ══════════════════════════════════════════════════════════════════
             * ★ 2026-11-06：**已知偏差（改前既有、已核算、明示不修）—— 不要再重算一遍**
             * ══════════════════════════════════════════════════════════════════
             * 全仓站点 offset 只有这一处，值恒为 `-5.5`（巴士）/ `-6.5`（轻轨），
             * 按**常态盒宽**算的一半 —— 而 `--dim` 态会把盒子改小（CSS 里写死 8 / 11）：
             *
             *   | 态 | 盒宽 | 用的 offset | 锚点落在中心的偏移 |
             *   |---|---|---|---|
             *   | 巴士常态 `.nav-map__station` | 11px | -5.5 | 0（精确居中）|
             *   | 轻轨常态 `--lrt` | 13px | -6.5 | 0（精确居中）|
             *   | 巴士 `--dim` | 8px | -5.5 | 偏**左上** 1.5px |
             *   | 轻轨 `--lrt.--dim` | 11px | -6.5 | 偏**左上** 1.0px |
             *
             * （`box-sizing: border-box`，11/13 已含 1.5px 白描边 ⇒ 11/2=5.5、13/2=6.5 精确。）
             *
             * ── 为什么不按盒宽动态算（一行就能"修"）────────────────────────────
             *   `--dim` 的盒宽是**写死在 globals.css** 的（8 / 11）。TSX 若再抄一遍
             *   `const box = dim ? (isLrt ? 11 : 8) : isLrt ? 13 : 11`，就产生了**第二份定义**：
             *   哪天 CSS 改尺寸，这里会**静默**偏掉，而且没有任何编译期/测试信号。
             *   ⇒ 判断标准：**「1px 不可见」 vs 「第二份定义」，后者更贵。**
             *     宁可留一个已知的小偏差，也不制造第二个真相。（负责人 2026-11-06 裁决采纳。）
             *
             * ⚠️ 将来若非要修：前置条件是**先让 CSS 侧把盒宽以 CSS 变量导出**
             *   （如 `--station-box` / `--station-box-dim`），JS 读变量、CSS 读同一变量
             *   ⇒ 保持单一真相；**不要**在 TSX 里手抄像素值。
             */
            offset: new AMap.Pixel(isLrt ? -6.5 : -5.5, isLrt ? -6.5 : -5.5),
            zIndex: isLrt ? 95 : 90,
          });
          marker.on("click", () => onStationClickRef.current?.(s));
          map.add(marker);
          stationMarkersRef.current.set(s.code, marker);
        }
        // 移出视野的点：逐个 remove 清理（防泄漏）
        for (const [code, mk] of [...stationMarkersRef.current]) {
          if (visible.has(code)) continue;
          try {
            map.remove(mk);
          } catch {
            /* ignore */
          }
          stationMarkersRef.current.delete(code);
        }
      } catch {
        /* 图层失败不影响底图 */
      } finally {
        // ★ 无副作用观测钩子：无论走哪个分支，都回写当前已渲染站点数（拉远/清空后 = 0）
        canvasRef.current?.setAttribute("data-station-count", String(stationMarkersRef.current.size));
        /**
         * ★ 2026-11-06（修复批 #1）：**双色巴士标数量**（验收钩子）。
         * 直接数 DOM 属性（`data-tqh-shared="1"`）而不是维护额外计数器 ——
         * marker 的增删有两条路径（本 effect 的可见集合 / `dropStationMarkers`），
         * DOM 是唯一不会漂的真相。查询只在节流后的 render 末尾执行一次，成本可忽略。
         */
        canvasRef.current?.setAttribute(
          "data-tqh-shared-count",
          String(canvasRef.current.querySelectorAll('[data-tqh-shared="1"]').length),
        );
      }
    };

    /**
     * ★ M4：暴露给外部 effect —— 图层开关拨动时要**立即**按新状态重绘，
     * 否则用户要等到下一次 `zoomend` / `moveend` 才看到变化（一次都不动就永远不变）。
     */
    renderRef.current = render;

    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        render();
      }, STATION_REFRESH_THROTTLE_MS);
    };

    map.on("zoomend", schedule);
    map.on("moveend", schedule);

    // 一次性拉全量站点（ref 缓存；失败静默，不影响其他功能）
    // ★ 2026-09-22：带 `include=lrt` —— 导航页地图需要**巴士 + 轻轨**两种站点
    //   （首页那个图层仍是不带参数的「只巴士」，口径各自独立、互不影响）。
    if (!stationsRef.current) {
      /**
       * ★ v2.10.1：URL 加**版本参数** `v=2` —— 强制让此前的缓存失效。
       *
       * 为什么必须加：v2.10.0 起 `/api/stations` 才开始下发线路色（`color/color2`），
       * 但旧版响应已被**浏览器 HTTP 缓存 + CDN** 存下（`cache-control: public`），
       * 而本请求用的是 `cache: "force-cache"`（最激进：宁可用过期副本也不发请求）
       * ⇒ 实测出现「轻轨站显示成巴士同色」——因为 `--c1` 缺失，CSS 回落到 `var(--primary)` ✗
       *
       * 加 `v=2` 后 URL 变化 ⇒ 旧缓存自然失效；之后 `force-cache` 仍是快速路径。
       * ⚠️ 以后 `/api/stations` 的**响应结构再变**时，把这个版本号 +1 即可。
       */
      fetch("/api/stations?include=lrt&v=2", { cache: "force-cache" })
        .then((r) => r.json())
        .then((j: { stations?: StationPointLite[] }) => {
          if (cancelled) return;
          stationsRef.current = Array.isArray(j.stations) ? j.stations : [];
          render();
        })
        .catch(() => {
          console.warn("[NavMap] 站点列表加载失败（站点图层不可用，不影响其他功能）");
          stationsRef.current = [];
          /**
           * ★ 2026-11-06（修复批 #6）：**失败也必须跑一次 `render()`** ——
           *   这不是"顺手补一行"，而是一条**跨功能的连带失效**的唯一堵口，改动前请先读完因果链：
           *
           * ```
           *   /api/stations（巴士/轻轨站点）500
           *     └─ 本图层 render() 从未执行
           *          └─ 缩放门 stationZoomOk 永久停在初值 false   ← 本轮新增的状态
           *               └─ <TqhStationLayer enabled={… && stationZoomOk}> 恒为 false
           *                    └─ 通琴号图层永远 clear() ⇒ **地图上一个通琴号站都没有**
           * ```
           *   ⇒ 用户报的症状是「**通琴号不显示**」，根因却是**澳门巴士接口挂了**。
           *     这类「A 功能坏掉 B 功能」的连带故障是最难排查的一种（看通琴号的代码
           *     一万遍也找不到原因，因为它本身的代码没错，结论取决于别人的请求成败）。
           *
           *   ⇒ 结论：**缩放门必须挂在一个"无论数据成败都会跑"的地方**，即本 catch 也要
           *     `render()`。`stationsRef.current = []` 后 `render()` 走完整分支：
           *     不建任何巴士 marker、`data-station-count` 归零、**缩放门与观测钩子按真实
           *     zoom 落定** ⇒ 通琴号层照常显示（它的数据来自 `/api/tqh/lines`，与本请求无关）。
           *
           *   ⚠️ 重构时若把缩放门挪到「站点数据就绪之后」，本行会被当成多余的而删掉 ——
           *     一旦删掉，上面那条因果链立刻复活。要挪就一起挪，别只删这行。
           */
          render();
        });
    } else {
      render();
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      try {
        map.off("zoomend", schedule);
        map.off("moveend", schedule);
      } catch {
        /* ignore */
      }
      clearAll();
    };
    /**
     * ★ 2026-09-23 修复：依赖数组补上 `phase`。
     *
     * 回归史：v2.9.0 为「路线模式重建站点图层」把依赖从 `[phase]` 改成了 `[stationRebuildTick]`，
     *   而本 effect 开头有 `if (phase !== "ready") return;` —— 组件挂载时 phase 仍是 "loading"，
     *   执行即 return；等地图就绪（phase → "ready"）时 **effect 不会重跑**（依赖没变）
     *   ⇒ **普通地图模式下站点图层从未启动**（拉近拉远都不显示；线上实测 `data-station-count` 恒为 null）。
     *   之所以一直没暴露：进出「路线查看模式」会触发 `stationRebuildTick` 重建，站点侥幸显示过一次。
     * ⇒ 补回 `phase`：loading → ready 时重新执行，图层正常启动。
     *
     * ★ 本批：依赖补 `lineStops` —— 白名单变化（进入/退出导航）时重建站点图层
     *   （marker 的「建/不建」在创建时决定，必须重建才生效）。
     * ★ 2026-11-06（修复批 #1）：依赖再补 `tqhSharedBusCodes` / `tqhActiveBusCodes` ——
     *   双色与白环同样是**创建时**写进 content 字符串的，集合变化必须重建才生效。
     * ★ 2026-11-06（修复批 #6 · P0）：再补 `tqhBusWhitelist` —— 它是**另一个白名单入口**
     *   （通琴号班次模式接管过滤），且优先级高于 `lineStops`；不进依赖 ⇒ 进出班次查看
     *   模式时巴士层不会重建 ⇒ 该隐藏的巴士站留着（正是本次 P0 的形态之一）。
     */
  }, [phase, stationRebuildTick, lineStops, tqhSharedBusCodes, tqhActiveBusCodes, tqhBusWhitelist]);

  /**
   * ★ 2026-09-22：**路线查看模式** —— 画线 + 站点区分 + 自动装下整条线。
   *
   * 数据 `GET /api/route-shapes?code=`（读 `route_shapes`，离线抓取的高德真实走向）：
   *   · 坐标是 **GCJ-02**（高德原生）⇒ **直接**喂地图，**不做任何转换**
   *     （⚠️ 与库内 `stations` 的 WGS84 不同源，但 `/api/stations` 出口已转 GCJ-02，
   *       所以本页两组数据在同一坐标系里，可直接叠加）；
   *   · 双方向线路返回多条 `shapes`（带 `dir` = `dsat_dir`）⇒ **只画当前方向**
   *     （`shapes.filter(s => s.dir === routeLine.dir)`）；未指定 `dir` 时按第一个方向渲染，
   *     并通过 `onRouteDirs` 把可用方向回报给上层（判定单向/双向 + 补齐 `dir`）。
   *
   * 站点区分（产品口径「一眼分辨」）：★ 2026-11-06 起**本线站与常态站标像素级一致**
   *   （放大/加粗白边的规则已按用户口径整块删除）⇒ 本线站只打 `data-on-route="1"` 观测属性；
   *   其他站 → `--dim`（灰小）保留。见 :1288 那段注释。
   * 视野：按**当前方向** line 的包围盒 `setBounds`（换向时重算，Spec AC-11）。
   */
  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap) return;

    const clearLines = () => {
      for (const p of routePolylinesRef.current) {
        try {
          map.remove(p as never);
        } catch {
          /* ignore */
        }
      }
      routePolylinesRef.current = [];
    };
    /** 清空站点 marker ⇒ 下一次 render 会用新样式重建 */
    const dropStationMarkers = () => {
      for (const [, mk] of stationMarkersRef.current) {
        try {
          map.remove(mk);
        } catch {
          /* ignore */
        }
      }
      stationMarkersRef.current.clear();
      setStationRebuildTick((t) => t + 1);
    };

    // 退出路线模式：清线 + 站点样式回落
    if (!routeLine) {
      clearLines();
      /* 清掉线路取景的观测钩子（否则退出后仍挂着上一条线的 inset 值，断言会读到脏数据） */
      canvasRef.current?.removeAttribute("data-route-inset-top");
      if (routeStopsRef.current.size > 0) {
        routeStopsRef.current = new Set();
        dropStationMarkers();
      }
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        /**
         * ★ v3.7.0（P2 · 去强缓存）：**不再传 `cache: "force-cache"`**。
         *   服务端已给 `/api/route-shapes` 下发 `Cache-Control: public, s-maxage=3600,
         *   stale-while-revalidate=86400`（浏览器可见 `max-age`）⇒ 浏览器按 HTTP 语义自己缓存。
         *   再叠一层 `force-cache` = 「两层缓存各管一段、谁也不知道哪层旧」，
         *   与 2026-09-21 那次「收藏页进导航拿到旧数据、刷新才生效」的事故同形。
         *   ⚠️ 只改 `cache` 这一个选项，不要动调用结构（引用稳定性见下方 effect 依赖）。
         */
        const r = await fetch(`/api/route-shapes?code=${encodeURIComponent(routeLine.code)}`);
        const j = (await r.json()) as {
          color?: string;
          stops?: string[];
          shapes?: { dir?: string; polyline: string; bounds: [number, number, number, number] }[];
        };
        if (cancelled || mapRef.current !== map) return;

        clearLines();
        const color = j.color ?? routeLine.color ?? "#276299";
        const shapes = j.shapes ?? [];

        // ★ v2.10.0：回报该线路**可用方向**（上层判定单向/双向 + 补齐 `routeLine.dir`）
        const allDirs = [...new Set(shapes.map((s) => s.dir).filter((d): d is string => !!d))];
        onRouteDirsRef.current?.(allDirs);

        // ★ v2.10.0：**只画当前方向**（Spec §5.2）。
        //   根因：旧实现 `for (const s of shapes)` 把两个方向**全画**了。
        //   未指定 `dir` 时按第一个方向渲染（上层随后会补上，行为一致）。
        const dir = routeLine.dir ?? allDirs[0];
        const shown = dir ? shapes.filter((s) => s.dir === dir) : shapes;

        for (const s of shown) {
          const path = s.polyline
            .split(";")
            .map((p) => p.split(",").map(Number))
            .filter((a) => a.length === 2 && a.every(Number.isFinite)) as [number, number][];
          if (path.length < 2) continue;
          const pl = new AMap.Polyline({
            path,
            strokeColor: color,
            strokeWeight: 6,
            strokeOpacity: 0.92,
            lineJoin: "round",
            lineCap: "round",
            showDir: true,
            zIndex: 70,
          });
          map.add(pl);
          routePolylinesRef.current.push(pl);
        }

        routeStopsRef.current = new Set(j.stops ?? []);

        // 视野：装下**当前方向**的线（按已选方向的包围盒重算，Spec AC-11）
        if (shown.length) {
          const lngs: number[] = [];
          const lats: number[] = [];
          for (const s of shown) {
            if (!Array.isArray(s.bounds) || s.bounds.length !== 4) continue;
            lngs.push(s.bounds[0], s.bounds[2]);
            lats.push(s.bounds[1], s.bounds[3]);
          }
          if (lngs.length) {
            try {
              const minLng = Math.min(...lngs);
              const maxLng = Math.max(...lngs);
              const minLat = Math.min(...lats);
              const maxLat = Math.max(...lats);
              const b = new AMap.Bounds([minLng, minLat], [maxLng, maxLat]);

              /**
               * ══════════════════════════════════════════════════════════════════
               * ★ 2026-11-06（#5a 收尾）**站序弹窗打开时的带 inset 取景**
               * ══════════════════════════════════════════════════════════════════
               *
               * 【为什么需要】站序弹窗（z77，`fixed` 全屏 100dvh）从 `half`（50vh）起，
               *   盖住下半屏。原来线路取景把包围盒居中装进**整屏** ⇒ 线的下半段永远压在
               *   弹窗底下，用户只看得到半条线（而"整条线"正是这个弹窗的唯一上下文）。
               *
               * 【怎么改】`insetTopPx` 非空 ⇒ 把包围盒装进 `0 … insetTopPx` 这条**槽**
               *   （自算 zoom + `panBy` 把框中心抬到槽中心），与 `fit-box` 同一配方。
               *   `insetTopPx` 为空 ⇒ **原路径一字不动**（`setBounds` + 40px 四周，
               *   线路查看模式现在的观感是验收过的，不能被我顺手改掉）。
               *
               * 【为什么**不**用 `setBounds` 的 `avoid` 参数避让（三层理由，负责人 2026-11-06 裁决保留自算）】
               *   ① 决定性：`avoid` 四格顺序**官方文档自相矛盾** —— 参考手册 / DT 的 JSDoc 写「上下左右」，
               *      全站示例却按 CSS 口径 `[上,右,下,左]` 传。我要的「只避底部」恰好落在两种读法
               *      结论不同的 index=2 上：押错 = 底部避让变右侧避让，线被挤成竖条，**不报错、只在真机可见**
               *      ⇒ 手上没有任何手段能证伪它，只能赌。不赌。
               *   ② 不拿两个未验证的东西相乘：`setBounds` 本身在本项目已被怀疑（`:155-156` 铁律，
               *      全项目只剩一处在用），再给它叠一个未证实的参数语义，风险是乘出来的。
               *   ③ 自算**不是新增一处 `setBounds` 例外**（本段不调用 `setBounds`）⇒ 铁律未被放宽；
               *      且与线上已跑的 `fit-box`（`:891-932`）逐行同源，那边验过的结论直接继承。
               *      **能用已验证的路径，就不为省几行去赌未验证的参数。**
               * ⚠️ 将来若要换回 `setBounds + avoid`，**前置条件是先在真机确认 avoid 的四格顺序**，
               *    并用真机截图证明「只避底部」。仅凭文档/示例不足以开工。
               *
               * 【值来源】`stopsInsetTop` ← 宿主 `tqhDetentTopsPx(...)[detentIndex(detent)]`
               *   （与弹窗自己算顶边**同一个函数**）⇒ 弹窗画在哪，槽就避到哪；
               *   本文件**不出现任何档位常量**（`96` / `50vh` 之类）。
               *
               * 【为什么读 ref 不读 prop】见 `stopsInsetTopRef`：拖档不重新取景，
               *   否则每拖一档地图就跳一次。取景时机仍是 打开 / 换线 / 换向。
               *
               * 【zoom 区间 12~16】与 `fit-box` 同值。**下限 12 在这里是实测硬需求**，
               *   依据与算式写在下方 `clamp` 处（实测最长线 10.9km ⇒ 半屏槽需要 `zy≈12.21`），
               *   不要把它当成"跟 fit-box 抄来的数字"再顺手调大。
               */
              const insetTopPx = stopsInsetTopRef.current;
              if (insetTopPx == null) {
                applyCamera(() => map.setBounds(b, true, [40, 40, 40, 40]));
              } else {
                const size = map.getSize?.() ?? { width: 390, height: 700 };
                const gap = fitGapPx();
                /** 可用槽：宽留 50px/侧（同 fit-box）；高 = 弹窗顶边以上，再让出呼吸位 */
                const slotTop = Math.max(80, Math.round(insetTopPx));
                const availW = Math.max(80, size.width - 100);
                const availH = Math.max(80, slotTop - gap * 2);
                const centerLng = (minLng + maxLng) / 2;
                const centerLat = (minLat + maxLat) / 2;
                /** 1.25 = 留白系数（与 fit-box 同：包围盒四周再放 12.5%） */
                const lngSpan = Math.max((maxLng - minLng) * 1.25, 1e-5);
                const latSpan = Math.max((maxLat - minLat) * 1.25, 1e-5);
                const zx = Math.log2((360 * availW) / (256 * lngSpan));
                const zy = Math.log2(
                  (360 * availH) / (256 * latSpan * Math.cos((centerLat * Math.PI) / 180)),
                );
                /**
                 * 夹取 12~16。**下限 12 是本处的硬需求，不是抄 `fit-box` 的** —— 依据（实测真库
                 * `route_stations` 全量包围盒，2026-11-06）：跨度最大的是 `26A` 南北 **10.9km**
                 * （次之 `25` 10.8 / `26` 10.3 / `59` 10.0 / `73` 9.9），在 half 档槽
                 * （屏高 844 ⇒ `slotTop=422`，`gap=20` ⇒ `availH=382`）里需要
                 * `zy = log2(360×382 / (256×1.25×latSpan×cosφ)) ≈ 12.21`
                 * ⇒ **12 档刚好装下；谁把它提到 13，最长的几条线就会溢出一条街**（= 本轮要修的同一个病）。
                 * 上限 16：短线（2~3 站）别怼到街景级。
                 * ⚠️ full / peek 档槽 ≤128px，整线装不进去也不需要（那两档地图本就被收起），
                 *   夹在 12 只保证地图仍可读、框中心仍对齐槽中心。
                 */
                const z = Math.max(12, Math.min(16, Math.floor(Math.min(zx, zy))));
                applyCamera(() => {
                  map.setZoomAndCenter(z, [centerLng, centerLat], true);
                  /** 把框中心从整屏中心上移到槽中心（屏坐标 y = slotTop/2） */
                  map.panBy(0, Math.round(size.height / 2 - slotTop / 2));
                });
                canvasRef.current?.setAttribute("data-nav-zoom", String(z));
                canvasRef.current?.setAttribute("data-view-mode", "route-inset-selfcalc");
                canvasRef.current?.setAttribute("data-route-inset-top", String(slotTop));
              }
            } catch {
              /* ignore */
            }
          }
        }

        dropStationMarkers();
      } catch {
        /* 静默：画不出线不影响底图 */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [routeLine, applyCamera]);

  /**
   * ★ 2026-09-23：**路线总览绘制**（详情 pane）。
   * 绘制主体已抽到 `nav-map-overview.ts#drawOverview`（§5.3 拆分）；本 effect 只管生命周期
   * （进入 detail 画一次；退出 detail / 非 ready → 逐个 `map.remove()` 清理 + 观测钩子归零）。
   */
  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap) return;

    const clearOverview = () => {
      for (const p of overviewPolylinesRef.current) {
        try {
          map.remove(p as never);
        } catch {
          /* ignore */
        }
      }
      overviewPolylinesRef.current = [];
    };

    // 非 ready / 无总览 → 清空；★ 显式置 0（契约语义：0 = 不可绘 / 未就绪 ⇒ QA 可稳定断言）
    if (phase !== "ready" || !overview || !overview.length) {
      clearOverview();
      canvasRef.current?.setAttribute("data-overview-legs", "0");
      return;
    }

    clearOverview();
    const { polylines, drawn } = drawOverview(map, AMap, overview);
    overviewPolylinesRef.current = polylines;
    canvasRef.current?.setAttribute("data-overview-legs", String(drawn));
    return () => clearOverview();
  }, [overview, phase]);

  /**
   * ★ 2026-09-23：**在途车辆**改由原生标记层承担（`VehicleLayer`，见其文件头说明）。
   * 旧的「React 覆盖层 + lngLatToContainer 每帧 setState」已删除 ——
   *   它在拖拽时落后地图一帧、且每帧触发一次 React 协调 ⇒ 视觉「飘」。
   * 原生化后位置由地图引擎驱动，**拖拽期零 JS**；合并仅在数据刷新 + `moveend`/`zoomend`
   *   （节流 120ms）重算。`zIndex:130` 保证「车压站点/pin」视觉不变。
   */

  /**
   * ★ v3.6.0 S5：**步行三种路**（done / now / ahead，三条独立 Polyline）。
   *
   * · 版本号 `walkTick` 用于"每帧 ratio 变了也要重画"，故不把整个 walk 对象塞进依赖；
   * · 进入 `riding`/离开 walk 时调用方把 `walk` 传 `null` ⇒ 本 effect **0ms 全部 remove**
   *   （不做淡出）：把"步行线与乘车彩段共存"的窗口直接消掉，避免踩 z 层级的坑。
   * · 切分与样式全在 `nav-map-walk.ts`（纯函数，可对拍）——本 effect 只管生命周期。
   */
  /**
   * ★ P0（2026-10-31）：`walk` 是调用方**每渲染新建的对象字面量**
   *   （`NavShell.tsx` `walk={{ steps, currentIdx, ratio, donePath }}`）⇒
   *   若把 `walk` 放进 effect 依赖，就是「每次渲染都重画」：
   *   先 `clearWalk`（remove 三条）再重建，配合空 `path` ⇒ AMap 抛 `Polyline path`。
   *   这正是本文件注释早先写的"不把整个 walk 对象塞进依赖"——代码与注释不一致，现修正。
   *   ⇒ 几何本体从 **ref** 读，依赖只用**原始值**（含 `walkVersion` 兜"同值改内容"）。
   */
  const walkRef = useRef(walk);
  walkRef.current = walk;
  const walkLive = !!walk && walk.steps.length > 0;
  const walkStepsLen = walk?.steps.length ?? 0;
  const walkCurIdx = walk?.currentIdx ?? -1;
  const walkRatio = walk?.ratio ?? 0;

  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap) return;

    const clearWalk = () => {
      walkLayersRef.current = clearWalkLayers(map as never, walkLayersRef.current);
    };

    const w = walkRef.current;
    if (!w || !w.steps.length) {
      clearWalk();
      canvasRef.current?.removeAttribute("data-walk-paths");
      canvasRef.current?.removeAttribute("data-walk-layers");
      return;
    }

    const style = readWalkStyle(document.documentElement);
    /**
     * `donePath`：**累积轨迹**（调用方给），不参与切分；偏航重算后仍保留。
     * `nowPath`：当前步按 `ratio` 切开后的**后半**（还没走的那截）。
     * `aheadPath`：当前步之后的所有步（整段）。
     */
    const idx = Math.max(0, Math.min(w.currentIdx, w.steps.length - 1));
    const { remaining } = splitStepByRatio(w.steps[idx], w.ratio);
    const ahead = w.steps.slice(idx + 1).flatMap((s) => s.polyline);
    const paths = { done: (w.donePath ?? []) as [number, number][], now: remaining, ahead };

    // ★ 建层时带 seed ⇒ 空几何的层**不会被创建**（避免 `Polyline path`）
    let ensureErr = "";
    try {
      walkLayersRef.current = ensureWalkLayers(
        map as never,
        (AMap.Polyline as unknown) as never,
        style,
        walkLayersRef.current,
        paths,
      );
    } catch (e) {
      // ★ 自检：建层失败必须在钩子里可见（否则真机上表现为"没线"却查不出原因）
      ensureErr = String((e as Error)?.message ?? e).slice(0, 80);
    }
    const L = walkLayersRef.current;

    /**
     * ★ 增量 `setPath`（**不再先清后建**）+ **空则移除**：
     *   高德对空 `path` 直接抛错；且"最后一步的 ahead"必然为空数组 ——
     *   这是 `Polyline path` 报错的主要来源（一次导航可刷出数百条）。
     */
    const apply = (layer: typeof L.donePath, path: [number, number][]) => {
      if (!layer) return null;
      if (path.length < 2) {
        map.remove(layer as never);
        return null;
      }
      layer.setPath(path as never);
      return layer;
    };
    L.donePath = apply(L.donePath, paths.done);
    L.nowPath = apply(L.nowPath, paths.now);
    L.aheadPath = apply(L.aheadPath, paths.ahead);

    canvasRef.current?.setAttribute(
      "data-walk-paths",
      `${paths.done.length}/${remaining.length}/${ahead.length}`,
    );

    /**
     * ★ 真机自检钩子（`canvas[data-walk-layers]`，2026-10-31）：
     *   回答"步行线到底是**没画**还是**画了看不见**"—— 这两者修法完全不同，必须先分清。
     *
     * 取值格式（每层 `层名:点数@色/w宽/z层级`，缺失层进 `missed:`，建层异常进 `err:`）：
     *   `done:2@#8c93a0/w5/z69 | now:6@#0b6e4f/w6/z73 | ahead:9@#0b6e4f/w6/z70`
     *   ⚠️ U1（2026-11-04）起 now/ahead 共用未走段语义组：w 均为 6（原 now 7 / ahead 5），
     *      两者只剩 z（73/70）与 showDir 不同；op 不进本字符串。
     *   `… | missed:done,ahead`            ← 该画（≥2 点）但没建/被移除
     *   `… | err:Get property 'add' …`     ← ensureWalkLayers 抛错（AMap 层面失败）
     *
     * ⚠️ 只读，不参与任何绘制判定；加这个钩子**没有改动任何绘制逻辑**。
     */
    const layerDesc = (
      name: string,
      layer: typeof L.donePath,
      path: [number, number][],
      st: { color: string; weight: number; z: number },
    ): string | null => (layer ? `${name}:${path.length}@${st.color}/w${st.weight}/z${st.z}` : null);
    const parts = [
      layerDesc("done", L.donePath, paths.done, style.done),
      layerDesc("now", L.nowPath, paths.now, style.now),
      layerDesc("ahead", L.aheadPath, paths.ahead, style.ahead),
    ].filter((s): s is string => !!s);
    const missed = (["done", "now", "ahead"] as const).filter((name) => {
      const path = paths[name];
      const layer = name === "done" ? L.donePath : name === "now" ? L.nowPath : L.aheadPath;
      return path.length >= 2 && !layer; // 该画但没画出来
    });
    const wl = [...parts, missed.length ? `missed:${missed.join(",")}` : "", ensureErr ? `err:${ensureErr}` : ""]
      .filter(Boolean)
      .join(" | ");
    canvasRef.current?.setAttribute("data-walk-layers", wl);
    // ⚠️ 不再 `return clearWalk`：cleanup 会造成"每次依赖变化先 remove 再重建"。
    //    卸载清理由下方独立的 unmount effect 负责。
  }, [walkLive, walkStepsLen, walkCurIdx, walkRatio, walkVersion]);

  /** 卸载兜底：三线只在卸载时清一次（正常路径走增量 setPath / 空则 remove） */
  useEffect(() => {
    return () => {
      const map = mapRef.current;
      if (map) walkLayersRef.current = clearWalkLayers(map as never, walkLayersRef.current);
    };
  }, []);

  /**
   * ★ 一条导航流：**非当前段的步行走廊**（ghost）。
   *
   * 与上面三线 effect **各自独立**：三线只在「正在跟随这一段」时存在，ghost 覆盖
   *   「其余段」（未走的绿细虚线 / 已走完的灰细虚线）。两者由调用方保证互斥
   *   （`NavShell` 不把当前跟随段同时放进来），所以不会在同一段上叠两遍。
   * 依赖 `walkGhosts` 引用（调用方 `useMemo` 稳定）+ `walkVersion`（同引用改内容也能刷新）。
   */
  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap) return;

    const clear = () => {
      walkGhostRef.current = clearWalkGhosts(map as never, walkGhostRef.current);
      canvasRef.current?.removeAttribute("data-walk-ghosts");
    };

    if (!walkGhosts || !walkGhosts.length) {
      clear();
      return;
    }

    const style = readWalkStyle(document.documentElement);
    walkGhostRef.current = syncWalkGhosts(
      map as never,
      (AMap.Polyline as unknown) as never,
      style,
      walkGhostRef.current,
      walkGhosts,
    );
    canvasRef.current?.setAttribute("data-walk-ghosts", String(walkGhostRef.current.size));

    /* ⚠️ **不返回清理函数**：本 effect 的价值就是「增量 diff、不重建折线」，
       每次依赖变化都先清后建会闪一下（三线 effect 那样做是因为它每帧都重画）。
       离场时由上面的 `clear()` 分支与 `map.destroy()` 负责，无泄漏。 */
  }, [walkGhosts, walkVersion]);

  /**
   * ★ P0：最终展示的提示文案 = 通用 `note`（地图加载失败等）**或** 定位失败文案。
   *   定位文案**在此实时求值**：`hasExternalPos` 一旦变 true（浏览器 GPS 到位）就自动消失。
   *   ⇒ 不需要"定位恢复后清提示"的反向逻辑，也就不会再出现"永久挂着"。
   */
  const noteText = note || (locateFailed && !hasExternalPos ? "无法定位 · 请手动选择出发点" : "");

  return (
    <div
      ref={rootRef}
      className={`nav-map ${className}`}
      /* ★ 观测钩子（契约唯一名称）：data-map = ok|failed（地图可用性；区别于画布上的 data-map-mask） */
      data-map={phase === "failed" ? "failed" : phase === "ready" ? "ok" : undefined}
      /* ★ 本批观测钩子：H1 由 effect 写、H2/H3 由事件与 render() 写；此处直接派生
         H4 data-userdot（蓝点存在性）/ H9 data-vehicle-shown（在显车辆数）。 */
      data-userdot={userFix ? "blue" : "none"}
      data-vehicle-shown={String(vehicles.length)}
    >
      <div ref={canvasRef} className="nav-map__canvas" />
      {/*
        ★ 2026-11-05（通琴号 R3/R4）：路径层在站点层**之前**渲染 ⇒ z73 < 站点 90/91/96，
          站点永远压在线之上（线上压点会读成"点没画出来"）。
          两层各自管「建 / 清」，均以 `map.remove()` 收尾（与 VehicleLayer 同一纪律）；
          `enabled` 绑 `phase==="ready"`，地图未就绪时传 null 实例 ⇒ 两层都空转不发请求。
      */}
      <TqhPathLayer
        map={phase === "ready" ? mapRef.current : null}
        amap={phase === "ready" ? amapRef.current : null}
        enabled={phase === "ready"}
        segments={tqhSegments}
        stations={tqhStations}
      />
      <TqhStationLayer
        map={phase === "ready" ? mapRef.current : null}
        amap={phase === "ready" ? amapRef.current : null}
        /* ★ 2026-11-06（修复批 #6 · P0）：`enabled` 叠加**与巴士层同一个缩放门** ——
           `stationZoomOk` 由巴士层的 `render()` 用同一 `minZoom` 算出（见 :1188 附近），
           ⇒ 同一缩放级别下两层同生同灭。阈值以下 `enabled=false` ⇒ 图层 `clear()`
           走 `map.remove()`，**不是** `visibility:hidden`（与巴士层同口径）。 */
        enabled={phase === "ready" && stationZoomOk}
        stations={tqhStations}
        activeIds={tqhActiveIds}
        whitelist={tqhWhitelist}
        onStationClick={onTqhStationClick}
        /* ★ 观测钩子：已绘通琴号 marker 数（96 = 全量纯站；0 = 阈值以下/被白名单清空） */
        onCount={onTqhStationCount}
      />
      {/* ★ 需求 7：跨境地标（机场 1 + 码头 3）。**刻意不接 `stationZoomOk`**：
          地标要首页低倍就可见，站点门（15）会让它永远不显示；重叠由聚合解决。
          详见 `xborder-pins.ts#groupXbPins` 与 `XborderPinLayer` 头部注释。 */}
      <XborderPinLayer
        map={phase === "ready" ? mapRef.current : null}
        amap={phase === "ready" ? amapRef.current : null}
        enabled={phase === "ready" && showXborderPins}
        visibleKinds={xborderKinds}
        onPick={onXborderPinClick}
      />
      {/* ★ M4（需求 3）：公共厕所图层 —— 与站点层**同一个**缩放门（`stationZoomOk`），
          默认关、开启时才拉数据（`loadPublicToilets` 自带 Promise 缓存）。
          坐标已是 GCJ-02，图层里不再换算（二次转换会偏 ~600m）。 */}
      <PublicToiletLayer
        map={phase === "ready" ? mapRef.current : null}
        amap={phase === "ready" ? amapRef.current : null}
        /* 绘制：与站点层同一个缩放门；加载：只看开关（`active`），见该组件的 props 注释 */
        enabled={phase === "ready" && showToilets && stationZoomOk}
        active={phase === "ready" && showToilets}
        onPick={onToiletClick}
      />
      {/* ★ 2026-09-23：在途巴士图标（**原生 AMap.Marker** + DOM content；拖拽期零 JS） */}
      <VehicleLayer
        map={phase === "ready" ? mapRef.current : null}
        amap={phase === "ready" ? amapRef.current : null}
        enabled={phase === "ready"}
        vehicles={vehicles}
        onVehicleClick={onVehicleClick}
      />
      {/* ★ 2026-09-24：导航追踪（已驶过路段灰实线 z74）；★ 2026-09-25：「您」拆为蓝点 */}
      <TrackLayer
        map={phase === "ready" ? mapRef.current : null}
        amap={phase === "ready" ? amapRef.current : null}
        enabled={phase === "ready"}
        traveled={traveled}
      />
      {/* ★ 2026-09-25：用户定位蓝点（人，z128 < 车辆 130）；★ v3.2.0：带移动插值时长（AC-80） */}
      <UserDotLayer
        map={phase === "ready" ? mapRef.current : null}
        amap={phase === "ready" ? amapRef.current : null}
        enabled={phase === "ready"}
        fix={userFix}
        smoothMs={userDotSmoothMs}
      />
      {/* ★ v3.2.0（需求 9 / AC-83）：左下「回到我的位置」按钮**已删除** ——
          让位锁（followState=free 跳过自动取景，见上方 `if (followRef.current === "free")`）、
          双击恢复 `restore()`、定位键重跑**全部保留**（「定位」能力由页面级 `.nav-locate-fab` 承担）。 */}
      {phase === "loading" && (
        <div className="nav-map__cover">
          {/* ★ v3.8.0：48px 小 M 循环动画（含内部 >300ms 门控：地图快就绪则不闪）。
              `active` 绑**真实地图加载信号** phase，不绑开屏状态 ——
              绑开屏会让「开屏撤走 → 300ms 门到点」之间出现空窗，正是要避免的。
              ★ a11y：文案必须**作为 `label` 传入**（落在组件内 `role="status" aria-live="polite"`
                里）。若留在组件外的 span，live region 内容为空 ⇒ 屏幕阅读器什么都不播，
                且「定位中…」→「地图加载中…」的切换也听不到（静默缺陷，视觉全绿）。
                字号一致（--fs-label = 13px），视觉零变化。 */}
          <BrandRouteLoader active size={48} slot="map-cover" label={locating ? "定位中…" : "地图加载中…"} />
        </div>
      )}
      {phase === "failed" && (
        <div className="nav-map__cover nav-map__cover--fail">
          <p className="h-title">地图暂不可用</p>
          <p className="t-label t-muted">搜索与路线结果不受影响</p>
          <button className="btn btn--outline btn--sm" type="button" onClick={() => void init()}>
            重试
          </button>
          {note && <p className="t-label t-muted">{note}</p>}
        </div>
      )}
      {phase === "ready" && noteText && <div className="nav-map__note t-label">{noteText}</div>}
    </div>
  );
}
