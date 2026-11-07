"use client";

/**
 * 全屏搜索层（src/components/nav/SearchSheet.tsx，2026-09-22 搜索界面重构）
 *
 * ── 它取代了什么 ──────────────────────────────────────────────────────
 *   旧版是「可拖拽的底部抽屉 + 4 步引导（①选目的地 ②地图标定 ③选出发地 ④出发）」，
 *   每步高度不同、还要处理惯性吸附。新版按产品口径改为**模仿高德/谷歌地图的两态**：
 *     · **全屏**（本组件）—— 顶部输入条 + 中部结果列表，进来就是输状态；
 *     · **下半屏**（`RoutePanel`）—— 上半屏看地图，下半屏看起终点并能直接「出发」。
 *
 * ── 两段式搜索（沿用既有 `/api/poi/suggest` 口径，未改服务端）────────────
 *   · **打字**（防抖 300ms）→ `mode=type` —— **只返回巴士站/轻轨站**（本地库，0 配额、秒回）；
 *   · **点【搜索】按钮** → `mode=enter` —— **总是调高德**，结果里才会出现「地点」类；
 *   · ⚠️ 即使输入与本地站名相同/部分相同，**搜索按钮仍可点**（产品明确要求）——
 *     所以按钮的 disabled 只看「是否为空 / **点搜索是否在途**」，不看「是否已有本地命中」，
 *     ★ v3.1.1 #7 起**也不看打字预测是否在途**（否则输入后立刻点会被原生 disabled 吞掉）。
 *
 * ── ★ v3.6.0：线路分区（AC-40/41/43）与搜索态恢复（AC-45）──────────────
 *   · **线路分区在最顶部**，与「地点 / 站点」分区互不混排；点线路行 **不填起终点**
 *     （AC-41 明令：不得走旧 `/routes`、不得把线路当起终点）。
 *   · **无线路命中 ⇒ 分区不渲染**（AC-43：不留空标题、不报错）。
 *   · 从线路视图返回时用 `sessionStorage` 恢复**当前**搜索态（`q` + 结果列表）。
 *     ⚠️ 与「不记忆历史出发点」不冲突 —— 见 `SS_KEY` 上方的界线说明。
 *
 * ── ★ v3.6.1：点线路 **不跳页**，改在首页地图上打开（行为等价于右栏点线路）──────
 *   原实现 `router.push("/line/[code]")` 会打开独立全景页（整页卸载 + 重新加载）。
 *   现改为：**本组件调用 `onOpenLine(code)`**（由 `NavShell` 接到 `rv.pickLine`）⇒
 *   同一张地图、同一套线路视图 UI（底部线路标签 + 换向 + 刷新）、同一条返回路径。
 *   · 线路视图打开期间本层**不渲染但保持挂载**（`lineOpen`）⇒ `q`/`resp` 一个字节都不丢，
 *     退出线路视图即刻回到「搜索词与结果都在」的状态（不需要任何持久化）；
 *   · `/line/[code]` 独立页**保留**（别人分享的深链不能死），仅在 `onOpenLine` **缺失**时兜底。
 *
 * ── ★ v3.6.1：结果行的类型标签结构 ────────────────────────────────────────
 *   行首标签 = **类型**（「巴士线路」/「轻轨线路」/「公交站」/「地点」），与既有站点/地点
 *   行用的是**同一个** `ResultTag` 组件、同一个 `.ssheet__type` class（不为线路另造一套）；
 *   线路号则是紧跟其后的**线路色圆角标签**（`.linechip` ⇒ 底色取 `routes.color` 原值，
 *   字色**恒为白字**，见 R6）。即：`[巴士线路] [50] 在地图查看走向`。
 *
 * ── 与旧 `PoiSearchBox` 的差别 ────────────────────────────────────────
 *   旧组件是「输入框 + **下拉浮层**」，适合嵌在抽屉里；
 *   新版要「**全屏 + 结果直接铺满中部**」，下拉浮层那套定位/关闭逻辑不再适用，
 *   故本组件**自带输入与列表**，但**调用完全相同的接口与参数**（口径不漂移）。
 *
 * ⚠️ 文案一律**简体**；站名/线路名保留繁体原文。
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Icon from "@/components/ui/Icon";
import RouteStack from "@/components/RouteStack";
import { chipInkOf } from "@/lib/ui/chip-ink";
import { lineNameOf } from "@/lib/route-label";
import type { NavPoint, PoiKind, PoiSearchResult, PoiSuggestResponse, RouteSuggestion } from "@/lib/nav/types";
import type { RouteLineItem } from "./RouteLinesSheet";
import { useTqhLines } from "./tqh-lines";
import { hhmm, searchTrips, type TqhTrip } from "./tqh-model";

const DEBOUNCE_MS = 300;

/**
 * ★ v3.6.0（AC-45）：**同会话内**返回时恢复当前搜索态。
 *
 * ── 为什么必须持久化（这不是"可能"，是必然）──────────────────────────────
 *   只要点线路会让 `NavShell` 整棵卸载（走独立路由 `/line/[code]`），返回就是
 *   **重新 mount** ⇒ 纯内存的 `q`/`resp` 归零 ⇒ 输入框空、结果列表空。
 *
 * ★ v3.6.1：首页路径**已不再跳页**（`onOpenLine` ⇒ 本组件只隐藏、不卸载）
 *   ⇒ 这条持久化对**首页主路径已非必需**，但**必须保留**：
 *   ① 深链兜底路径（`onOpenLine` 缺失时仍走 `router.push`）依赖它；
 *   ② 用户从搜索层直接刷新 / 前进后退时也依赖它。
 *   ⚠️ 不要因为"现在不跳页了"就删掉这两段 —— 删了深链回归必挂。
 *
 * ── 为什么用 `sessionStorage` 而不是 `localStorage` ──────────────────────
 *   本文件头既有约束：**不记忆历史出发点**（产品 R5 明确不用 localStorage）——
 *   那条说的是「下次打开还记着你上次去哪儿」。而这里是「**同一会话内**返回时恢复
 *   当前这次搜索」，语义不同、也不跨会话（关 tab 即清）。
 *   ⇒ 界线：起终点选择**不存**（存了会出现"为什么它记得我上次去哪"）；
 *     只存 `q` + `resp` + `open` 这类**当前交互的中间态**。
 */
const SS_KEY = "mmap.search.v1";
/**
 * 「从 `/line` 返回」的**一次性**标记（★ v3.6.1 起**仅深链兜底路径**写入）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 *   返回后要**看到**「输入框仍是 26、结果列表仍在那」。只恢复 `q`/`resp` 不够 ——
 *   从 `/line` 返回时 `NavShell` 重新 mount，`stage` 会被算成 `map`/`panel`
 *   （取决于 URL），**搜索层根本没打开**，用户看到的是首页。
 *   ⇒ 跳转前打标记；NavShell mount 时若看到它，就把 `stage` 直接置为 `search`
 *     并**立即删除**（一次性）—— 这样刷新页面/新开 tab 都不会莫名弹搜索层。
 */
const SS_RETURN = "mmap.search.return";

/** 读回同会话搜索态；`editing` 不匹配（换了端点）⇒ 视为无（不把"搜出发地"的结果带到"搜目的地"） */
function readSaved(editing: "dest" | "from"): { q: string; resp: PoiSuggestResponse | null } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SS_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as { editing?: string; q?: string; resp?: PoiSuggestResponse | null };
    if (o.editing !== editing || !o.q) return null;
    return { q: o.q, resp: o.resp ?? null };
  } catch {
    return null;
  }
}

/** 写入（`q` 为空 ⇒ 清除：用户主动清空输入框就代表放弃了这次搜索） */
function writeSaved(editing: "dest" | "from", q: string, resp: PoiSuggestResponse | null): void {
  if (typeof window === "undefined") return;
  try {
    if (!q.trim()) {
      window.sessionStorage.removeItem(SS_KEY);
      return;
    }
    window.sessionStorage.setItem(SS_KEY, JSON.stringify({ editing, q, resp }));
  } catch {
    /* 隐私模式 / 配额满 ⇒ 静默降级（只是不恢复，不影响搜索本身） */
  }
}

/**
 * 结果行的**类型标签**种类（★ v3.6.1）。
 *
 * 前四种来自 `PoiKind`（有坐标的结果），后两种是线路结果（`RouteSuggestion`，无坐标）。
 * 合在一个联合类型里，是为了让**五种标签共用同一个组件、同一个 class** ——
 * 「巴士线路」既不是新标签体系，也不是新视觉语言，它就是既有「公交站 / 地点」标签的第五个取值。
 */
type ResultTagKind = PoiKind | "bus_route" | "lrt_route" | "tqh_trip";

/**
 * 类型标签文案（**唯一文案源** —— 行内标签只从这里取，杜绝两处各写一份）。
 * ⚠️ 线路两类**不做分区标题**（主人要的是行内结构），所以这里只服务行内标签。
 */
const TAG_TEXT: Record<ResultTagKind, string> = {
  station: "公交站",
  lrt_station: "轻轨站",
  place: "地点",
  poi: "地点",
  bus_route: "巴士线路",
  lrt_route: "轻轨线路",
  /** ★ 2026-11-05（通琴号 R7）：第三类交通方式的标签，与其余五种**同一个组件、同一个 class** */
  tqh_trip: "通琴号",
};

/**
 * 结果行类型标签（★ v3.6.1）。
 *
 * ── 为什么必须是一个组件 ────────────────────────────────────────────────
 *   主人原话：线路行的左侧标签**不是**线路号，而是「巴士线路 / 轻轨线路」四个字，
 *   **样式与「公交站」「地点」一致**。⇒ 五类标签一律走这里、一律 `.ssheet__type`，
 *   否则线路标签迟早被改成另一套字号/圆角/配色（那正是要修的病）。
 *
 * ── 为什么不给线路另加色调 ──────────────────────────────────────────────
 *   线路行紧跟着就有一个**线路色**圆角标签（`.linechip`）。若类型标签也上色，
 *   一行里两个彩色块互相抢眼（每屏强调色预算只有 2 处）⇒ 线路类型标签用中性底，
 *   站点类保留既有色调变体（`--station` / `--lrt_station`，**本轮未改**）。
 */
function ResultTag({ kind }: { kind: ResultTagKind }) {
  const variant =
    kind === "station"
      ? " ssheet__type--station"
      : kind === "lrt_station"
        ? " ssheet__type--lrt_station"
        : kind === "tqh_trip"
          ? " ssheet__type--tqh"
          : "";
  return <span className={`ssheet__type${variant}`}>{TAG_TEXT[kind]}</span>;
}

/**
 * ★ 2026-11-05（通琴号 R7 / AC-9）：**通琴号班次结果行**。
 *
 * 行内结构：`[通琴号][B6] 全称` + 副行 `往澳门 · 08:30 发车`。
 * · 标签走**同一个** `ResultTag`（不另造标签体系）；
 * · 标号 chip 用主题色底 + **白字**（负责人 §17-R1 裁决；`text-shadow` 与 `.rl-chip` 同值）；
 * · 动作是「在地图上查看这一班的走线」，与站点行的「设为目的地」完全不同 ⇒
 *   不与站点/地点混排（沿用线路分区的既有纪律）。
 */
function TqhResultRow({ trip, onOpen }: { trip: TqhTrip; onOpen: (t: TqhTrip) => void }) {
  const dep = hhmm(trip.departure_time);
  return (
    <button
      type="button"
      className="ssheet__item"
      data-tqh-trip={trip.trip_code}
      aria-label={`通琴号 ${trip.route_no}，${trip.direction}，${dep} 发车，${trip.line_full_name}，在地图上查看走向`}
      onClick={() => onOpen(trip)}
    >
      <ResultTag kind="tqh_trip" />
      <span className="tqh-no" aria-hidden="true">
        {trip.route_no}
      </span>
      <span className="ssheet__main">
        <span className="ssheet__name">{trip.line_full_name}</span>
        <span className="ssheet__addr t-muted">
          {trip.direction}
          {dep ? ` · ${dep} 发车` : ""}
        </span>
      </span>
      <Icon name="forward" size={16} />
    </button>
  );
}

/**
 * 「待确认」项的标签种类（★ v3.6.1）。
 *
 * `PoiPendingMatch.targetKind` 是后端给的自由字符串，而 `ResultTag` 只认联合类型
 * ⇒ 在这里收敛一次。
 *
 * ⚠️ **这里刻意不写 `LRT-` 前缀判断**：线路的权威种类只有一处 —— `resp.routes[].kind`
 *   （后端 `RouteSuggestion.kind`，`poi-search.ts` 的 `code.startsWith("LRT-")` 是**唯一**
 *   判定点）。而线路命中在 `poi-search.ts` 里是 `routes.push(...) + continue`，
 *   **永远不会进 `pending`** ⇒ 本函数的 `route` 取值只是一行**不可达**的防御性兜底，
 *   真出现了也不该由前端二次猜（多一套判定迟早与后端分叉）。
 */
function tagKindOfPending(p: { targetKind: string }): ResultTagKind {
  if (p.targetKind === "station" || p.targetKind === "lrt_station") return p.targetKind;
  /** 不可达（见上）：`pending` 只从 `station` / `lrt_station` 分支产生；写巴士仅为形状完整 */
  if (p.targetKind === "route") return "bus_route";
  if (p.targetKind === "place") return "place";
  return "poi";
}

/** 巴士站显示名带站码（`M1 關閘總站`）；轻轨站/地点用原名 */
function displayName(r: PoiSearchResult): string {
  if (r.kind === "station" && r.code && !r.name.startsWith(`${r.code} `)) {
    return `${r.code} ${r.name}`;
  }
  return r.name;
}

function toNavPoint(r: PoiSearchResult): NavPoint {
  const kind: NavPoint["kind"] =
    r.kind === "station" || r.kind === "lrt_station" ? "station" : r.kind === "place" ? "place" : "poi";
  const p: NavPoint = { kind, label: displayName(r), lng: r.lng, lat: r.lat };
  if (r.code) p.code = r.code;
  return p;
}

/** 结构类型（避免依赖收藏模块） */
export interface QuickPair {
  id: string;
  from: { kind: NavPoint["kind"]; label: string; lng: number; lat: number; code?: string };
  to: { kind: NavPoint["kind"]; label: string; lng: number; lat: number; code?: string };
}

export interface SearchSheetProps {
  /** 当前在编辑哪个端点 */
  editing: "dest" | "from";
  dest: NavPoint | null;
  from: NavPoint | null;
  userPos: { lng: number; lat: number } | null;
  colors: Record<string, string>;
  quickPairs: QuickPair[];
  onPick: (p: NavPoint, which: "dest" | "from") => void;
  onPickQuick: (from: NavPoint, to: NavPoint) => void;
  /**
   * ★ v3.6.1：点线路结果 ⇒ **由宿主在首页右栏打开线路视图**（URL 不变、不跳页）。
   *
   * 参数就是右栏所需的 `RouteLineItem`（`RouteLinesSheet.tsx` 的权威形状
   * `{ code, kind, label, color }`）——**字段映射在这里一次做完**，
   * 宿主只需 `onOpenLine={rv.pickLine}`，不必自己拼、也不必知道 `RouteSuggestion` 长什么样。
   *
   * ⚠️ 定义成**可选**：必填会逼收藏页等其他调用方实现一个空壳；
   *   未接线时退化为旧的 `/line/[code]` 深链（深链页保留给外部分享，行为不变）。
   */
  onOpenLine?: (line: RouteLineItem) => void;
  /**
   * ★ v3.6.1：线路视图是否已打开（宿主传 `!!rv.picked`）。
   *
   * 为 `true` 时本层**不渲染但保持挂载** —— 地图让出来给线路走向，而 `q`/`resp`
   * 这些搜索中间态一个都不丢；线路视图一关（`rv.picked` 变 null）本层立刻回到屏幕，
   * 搜索词与结果原样还在（这就是「返回后搜索面板还在」的实现方式，不依赖 sessionStorage）。
   *
   * ⚠️ 只有「宿主给了 `onOpenLine` 却没给本 prop」时才走兜底：点完线路立即 `onBack()`
   *   收起本层（并行开发期的保护，否则用户看到全屏搜索页顶在刚打开的线路上）。
   *   非 `undefined`（无论 true/false）时**一律由宿主决定收放**，本组件不越权关层。
   *
   * ⚠️⚠️ **硬约束（宿主必须遵守，写在这里是因为它不在本文件内）**：
   *   宿主必须让 `stage === "search"` **保持不变**。挂载条件是
   *   `{stage === "search" && <SearchSheet/>}`（`NavShell`）——**不要**用
   *   `setStage("map")` / `setStage("panel")` 来"收起"本层：那会**卸载**组件，
   *   `q`/`resp` 归零，与 `lineOpen` 的设计直接冲突。
   *   ⚠️ 破坏它**不会报错、不会白屏**，表现只是"返回后搜索词丢了"——典型的静默回归，
   *   只能靠这条注释留给下一个人。
   */
  lineOpen?: boolean;
  /**
   * ★ 2026-11-05（通琴号 R7）：点通琴号班次结果 ⇒ 宿主关搜索层、地图画该班次路径。
   *   未接线时该分区**不渲染**（不给出点了没反应的假按钮）。
   */
  onOpenTqhTrip?: (trip: TqhTrip) => void;
  /** 左上角返回（关闭全屏、回到半屏或地图） */
  onBack: () => void;
}

/** 球面距离（米）—— 与 `coord.ts#haversineM` 同口径；此处**内联**，避免客户端拉进服务端模块 */
/** 澳门行政区划词（用于地址清洗；**不含**「氹仔/路环」这类地名——它们可作为地址开头）
 * ★ 2026-09-27（用户口径）：搜索结果统一「地点名 + 地址（小字）」，不显示行政区划。 */
const MACAU_ZONE_WORDS =
  "澳门|澳門|花地玛堂区|花地瑪堂區|圣安多尼堂区|聖安多尼堂區|大堂区|大堂區|望德堂区|望德堂區|风顺堂区|風順堂區|嘉模堂区|嘉模堂區|圣方济各堂区|聖方濟各堂區|路氹填海区|路氹填海區";
const MACAU_ZONE_RE = new RegExp(`^(${MACAU_ZONE_WORDS})[·\\s]*`);

/**
 * 徽章文本（AC-40 / 设计 §2.4）：巴士显示线路码原文（`26` / `51A`）；
 * 轻轨走统一口径 `lineNameOf()` —— 剥 `LRT-` 前缀 **并做简→繁转换**（`LRT-氹仔线` → `氹仔線`）。
 *
 * ★ 2026-11-06（D-3 缺陷修复）：原先是 `raw.replace(/^LRT-/, "")`，只剥前缀不转字
 *   ⇒ 搜索结果里显示简体 `氹仔线`，与「全部线路」面板、`/line/*` 顶栏的繁体不一致。
 *   本函数还被 `rowLabel`（`aria-label`）复用 ⇒ 读屏也会念简体。
 *   **不要再就地写 replace**，一律走 `lineNameOf`（它对巴士码恒等，无副作用）。
 */
function chipTextOf(r: RouteSuggestion): string {
  const raw = (r.code ?? r.name ?? "").trim();
  return r.kind === "lrt" ? lineNameOf(raw) : raw;
}

/** 地址清洗：剥离区划前缀（最多 3 层）；清洗后为空 ⇒ 返回空串（该条目不显示地址行） */
function cleanAddr(a?: string | null): string {
  if (!a) return "";
  let s = a.trim();
  for (let i = 0; i < 3 && MACAU_ZONE_RE.test(s); i++) s = s.replace(MACAU_ZONE_RE, "");
  return s.replace(/[·\s]+$/g, "");
}

function distMeters(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const R = 6371008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * 线路结果行（★ v3.6.1 结构重做 · 设计 §2.8）
 *
 * ── 行内从左到右（主人逐字口径：「『巴士线路』『50』」）──────────────────
 *   `[类型标签]`  「巴士线路」/「轻轨线路」—— 与「公交站」「地点」同一个 `ResultTag`、
 *                 同一个 `.ssheet__type`（同字号/同圆角/同内距/同分隔线）；
 *   `[线路色标签]` 线路号/线名 —— `.linechip`，底色 = 该线 `routes.color`；
 *   `[→]`          行尾提示"点了会打开"。
 *   ⚠️ 行内**不放**说明文字：主人这一条只要求标签结构，多一段「在地图查看走向」
 *      会把线路号挤离左侧、每行也更啰嗦 ⇒ 该句只作为 `aria-label` 给读屏。
 *
 * ── 颜色口径（留痕，防"以为需求漏做"）──────────────────────────────────
 *   ★ 主人原话为「圆角**白字**」标签 —— **R6 裁决（2026-11-06）回到这里**：
 *     线路标签**一律白字 + 官方线路色底（不加深）**。
 *   ⚠️ 中间版本曾按设计 §2.4 走 `chipInkOf()` 对比度自适应（深底白字 / 浅底转深字），
 *     该方案已被 R6 **明确否决**：全库 59/95 条线路色按白字低于 AA，
 *     属**负责人已知并接受的登记偏差**，不得以「可读性」为由改回深字。
 *     补偿只允许加粗字重 + `text-shadow`（写在 `.linechip` 里，勿在 TSX 另加）。
 *
 * ── 为什么复用 `.ssheet__item` 而不是另建行样式 ──────────────────────────
 *   主人要求「样式与现有『公交站』『地点』一致（字号、颜色、**间距、分隔线**）」。
 *   `.ssheet__item` 就是站点/地点行的本体（min-height 52 / padding 10 14 / gap 8 /
 *   border-bottom 分隔线 / :active 反馈）⇒ 直接用它，分隔线天然对齐，零新增 CSS。
 *   ⚠️ **不能**再叠 `.line-result`（该类的 `border: 0` 曾把分隔线抹掉；本类已按
 *     M16 作为死代码删除，此句仅留作历史原因记录）。
 *
 * ── 无障碍 ──────────────────────────────────────────────────────────────
 *   整行是 `<button>`；行内已无说明文字 ⇒ `aria-label` 必须自带完整语意
 *   （读屏只念「50」两个字符不知所指，也不知道点了会发生什么）；
 *   线路号标签自身也带 `aria-label`（如「50 巴士线路」）。
 *
 * ⚠️ **根元素必须是原生 `<button>`（或 `<a>`），不得改成 `<div role="button">`**。
 *   hover / 按压回弹 / `focus-visible` / 触摸态四条反馈**全部**来自 `globals.css` 的
 *   `button` 原语（`:443` / `:449` / `:436`）与 `.ssheet__item:active`（`:4371`）；
 *   换成 div + role 后四态**一条都不生效**，而且**不报错、lint 也不报** —— 用户只会
 *   觉得"这张卡点不动"。（判据：行级可点击只查标签，不查样式。）
 */
function LineResultRow({
  r,
  color,
  onOpen,
}: {
  r: RouteSuggestion;
  color: string | undefined;
  onOpen: (r: RouteSuggestion) => void;
}) {
  /**
   * ★★ R6 裁决（2026-11-06）：线路标签**字色一律白字**（`globals.css` 的 `.linechip`），
   *   ⇒ 这里**不再内联注入 `color`**，也不再使用 `chipInkOf()` 的「浅底转深字 / 死带加深底色」。
   *   `chipInkOf()` 在本处只剩**一个用途**：判断底色是不是脏数据（非 6 位 hex）——
   *   是则 `tone === "fallback"`，交给 CSS 走「中性底 `--surface-2` + 深字 + 线路色小圆点」，
   *   那是**唯一**允许出现非白字的情形（底色已不是线路色）。
   *   ⚠️ 底色一律用 `routes.color` **原值**（`color` 变量），**不加深**（`chipInkOf` 的 bg 字段
   *      在死带分支会加深 14%，R6 明令禁止）。所以下面故意不写那个 bg 字段。
   *   ⚠️ 不要给这里补内联字色（`ink` 的 ink 字段）：内联会盖掉 CSS 的白字，浅底线路立刻退回深字。
   */
  const ink = chipInkOf(color);
  const chip = chipTextOf(r);
  const tagKind: ResultTagKind = r.kind === "lrt" ? "lrt_route" : "bus_route";
  const tagText = TAG_TEXT[tagKind];
  /**
   * 读屏整句：**线号本身不带「路」**（R5：线路标识只显示码本身）。
   *   ⚠️ 旧文案是「线号 + ` 路巴士线路`」拼接 —— 读屏会念「50 路巴士线路」，属全站第 4 处
   *   「XX路」残留（审计 §3-C5，不可见但可闻）。轻轨分支本来就不套「路」
   *   （「氹仔線路轻轨线路」不通），此处两边都收敛到「码 + 类型」。
   */
  const rowLabel =
    r.kind === "lrt" ? `${chip} 轻轨线路，在地图上查看走向` : `${chip} 巴士线路，在地图上查看走向`;
  return (
    <button type="button" className="ssheet__item" onClick={() => onOpen(r)} aria-label={rowLabel}>
      <ResultTag kind={tagKind} />
      <span
        className="linechip"
        style={{
          /* R6：底色 = 官方线路色原值（不加深）；脏底色 ⇒ undefined ⇒ 走 CSS 兜底分支 */
          background: ink.tone === "fallback" ? undefined : color,
          /**
           * ★ v3.6.1：`globals.css` 里 `.linechip` 的 **72px 固定列宽**是为**旧布局**服务的
           *   —— 那时线路号右边还有一列「线路名」，固定宽度才能保证名称左缘对齐。
           *   新布局中线路号是**紧跟类型标签的同行小标签**（`[巴士线路][50]`），
           *   行内已无名称列 ⇒ 固定列宽失去意义，改按内容撑开（34px 与设计的下限一致）；
           *   `marginRight:auto` 把行尾的箭头推到右边，避免整行挤在左侧。
           *   ⚠️ 只覆盖尺寸，圆角/字重/字色（白字 R6）/`data-chip-ink` 描边一律沿用既有 `.linechip`。
           */
          flex: "0 0 auto",
          width: "auto",
          minWidth: "34px",
          padding: "0 8px",
          marginRight: "auto",
        }}
        data-chip-ink={ink.tone}
        aria-label={`${chip} ${tagText}`}
      >
        {ink.dot && <span className="linechip__dot" style={{ background: ink.dot }} aria-hidden="true" />}
        <span className="linechip__text">{chip}</span>
      </span>
      <Icon name="forward" size={16} />
    </button>
  );
}

export default function SearchSheet({
  editing,
  dest,
  from,
  userPos,
  colors,
  quickPairs,
  onPick,
  onPickQuick,
  onOpenLine,
  lineOpen,
  onOpenTqhTrip,
  onBack,
}: SearchSheetProps) {
  const router = useRouter();
  /**
   * 输入框内容：**正在编辑的那个**端点为空（待输入），另一个显示已选值。
   * ★ v3.6.0（AC-45）：初始值从 `sessionStorage` 读 —— 从 `/line/[code]` 返回时
   *   `NavShell` 是**重新 mount**，纯内存 state 必然归零（见 `readSaved` 注释）。
   */
  const [q, setQ] = useState(() => readSaved(editing)?.q ?? "");
  /**
   * ★ v3.1.1 #7（真机反馈「输入后立刻点搜索可能不成功」）：
   *   原先用单个 `loading` 同时表示「打字预测请求」与「点搜索请求」，且 **按钮 `disabled={loading||…}`**
   *   ⇒ 打字触发的 300ms 防抖请求一发出，按钮就被禁用；用户紧接着点「搜索」时
   *   **原生 disabled 吞掉 click（onClick 根本不触发）** ⇒ 看着"点了没反应"。
   *   ⇒ 拆成 `busy`（区分 type / enter）：打字预测**不禁用**按钮，只有 enter 在途才禁用。
   */
  const [busy, setBusy] = useState<null | "type" | "enter">(null);
  const loading = busy !== null;
  /** ★ 并发保护：只认最后一次请求的响应（防「打字预测」的迟到响应覆盖「点搜索」的结果） */
  const reqIdRef = useRef(0);
  const [resp, setResp] = useState<PoiSuggestResponse | null>(() => readSaved(editing)?.resp ?? null);
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * ★ 附近站点推荐（**未输入时**显示 —— 就是产品说的「中间是推荐条，只列巴士/轻轨站点」）。
   * 数据来自 `GET /api/stations`（全量巴士站，带 GCJ-02 坐标，CDN 缓存 1h）
   * ⇒ 拉一次后**本地**按距离排序取前 12，交互过程中零请求。
   * 失败静默：不影响用户输入关键字搜索。
   */
  const [nearby, setNearby] = useState<{ code: string; name: string; lng: number; lat: number; distM: number }[]>([]);

  useEffect(() => {
    if (!userPos) {
      setNearby([]);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/stations");
        const j = (await r.json()) as { stations?: { code: string; name: string; lng: number; lat: number }[] };
        const list = (j.stations ?? [])
          .map((s) => ({ code: s.code, name: s.name, lng: s.lng, lat: s.lat, distM: Math.round(distMeters(userPos, s)) }))
          .sort((a, b) => a.distM - b.distM)
          .slice(0, 12);
        if (alive) setNearby(list);
      } catch {
        /* 网络失败 ⇒ 不显示推荐（不阻塞搜索） */
      }
    })();
    return () => {
      alive = false;
    };
  }, [userPos]);

  /**
   * 进入本层 → 聚焦输入框。
   *
   * ★ v3.6.0（AC-45）行为变更：**不再无条件清空**。
   *   旧实现每次 mount 都 `setQ("")`/`setResp(null)` ⇒ 从 `/line/[code]` 返回时
   *   用户刚搜的「26」和结果列表全没了（AC-45 直接不成立）。
   *   现在：同端点且 sessionStorage 有值 ⇒ **保留**（浏览器返回场景）；
   *         换了端点（from↔dest）⇒ 清空（不同端点的搜索意图不该串）。
   *   ⚠️ 这里**不读** sessionStorage：初始 state 已经读过了；此处只处理"editng 变化"。
   */
  useEffect(() => {
    const saved = readSaved(editing);
    if (!saved) {
      setQ("");
      setResp(null);
    }
    setErr("");
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [editing]);

  /** ★ AC-45：`q`/`resp` 每次变化都写回 sessionStorage（清空即删） */
  useEffect(() => {
    writeSaved(editing, q, resp);
  }, [editing, q, resp]);

  /**
   * 发起搜索。
   * @param mode      `type` = 打字阶段（只站点）· `enter` = 点搜索（含高德）
   * @param forceAmap 强制走高德（点「点搜索确认」行时用）
   * @returns 响应对象（供调用方判定/自动选中）；无关键字或失败 → null
   */
  async function query(
    keyword: string,
    mode: "type" | "enter",
    forceAmap = false,
  ): Promise<PoiSuggestResponse | null> {
    const s = keyword.trim();
    if (!s) {
      setResp(null);
      return null;
    }
    const id = ++reqIdRef.current; // ★ v3.1.1 #7：并发保护（只认最后一次）
    setBusy(mode);
    setErr("");
    try {
      const sp = new URLSearchParams({ q: s.slice(0, 50), mode });
      if (forceAmap) sp.set("forceAmap", "1");
      if (userPos) {
        sp.set("lat", String(userPos.lat));
        sp.set("lng", String(userPos.lng));
      }
      const res = await fetch(`/api/poi/suggest?${sp.toString()}`, { cache: "no-store" });
      const json = (await res.json()) as PoiSuggestResponse;
      // ★ 过期响应（已被更新的请求取代）⇒ **不写入 state**（避免旧结果覆盖新结果）
      if (id === reqIdRef.current) setResp(json);
      return json;
    } catch {
      if (id === reqIdRef.current) {
        setErr("搜索暂不可用，请稍后再试");
        setResp(null);
      }
      return null;
    } finally {
      if (id === reqIdRef.current) setBusy(null);
    }
  }

  function onInput(v: string) {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    // ★ 打字阶段只查本地站点（0 配额）；点【搜索】才联网
    timer.current = setTimeout(() => void query(v, "type"), DEBOUNCE_MS);
  }

  function runSearch() {
    if (timer.current) clearTimeout(timer.current);
    void query(q, "enter");
  }

  function pick(r: PoiSearchResult) {
    onPick(toNavPoint(r), editing);
  }

  /** 「点搜索确认」行：本地命中但无坐标 ⇒ 强制走高德拿坐标后自动选中第一条 */
  async function pickPending(name: string) {
    setQ(name);
    const json = await query(name, "enter", true);
    const top = json?.results?.[0];
    if (top) pick(top);
    else setErr("这条地点暂时确认不到坐标 · 换个说法试试");
  }

  const results = resp?.results ?? [];
  const pending = resp?.pending ?? [];
  const hint = resp?.hintText;
  /**
   * ★ v3.6.0（AC-40）：**线路分区**（独立于 `results`，不混排）。
   * `undefined`/空 ⇒ **整个分区不渲染**（AC-43：不留空标题、不报错）。
   * 分组：「巴士线路」/「轻轨线路」——按 `code` 前缀 `LRT-` 判定（与 `route-lines` 口径一致）。
   */
  const routeHits = resp?.routes ?? [];
  /** 分组直接用后端给的 `kind`（不从前缀猜 —— 后端 `RouteSuggestion.kind` 已是权威判定） */
  const busRoutes = routeHits.filter((r) => r.kind === "bus");
  const lrtRoutes = routeHits.filter((r) => r.kind === "lrt");

  /**
   * ★ 2026-11-05（通琴号 R7 / AC-9）：**本地过滤**出通琴号班次（按班次逐条，上限 80）。
   *   · 数据来自模块级缓存的 `/api/tqh/lines`（弹窗已经拉过 ⇒ 这里 0 请求）；
   *   · **不接** `/api/poi/suggest`（高德月配额 5,000 次），只在内存里过滤；
   *   · 未接线 `onOpenTqhTrip` ⇒ 分区不渲染（不给假按钮）。
   */
  const tqh = useTqhLines();
  const tqhHits = onOpenTqhTrip && q.trim() ? searchTrips(tqh.data.trips, q) : [];

  /**
   * ★ v3.6.1：线路结果 **不填起终点**（AC-41：不得把一条线路当成目的地塞进导航），
   * 且**不再跳页** —— 就地交给宿主在首页右栏打开（URL 不变）。
   *
   * 两条分支：
   *   ① `onOpenLine` 已接线 ⇒ 把 `RouteSuggestion` **显式映射**成右栏的 `RouteLineItem`
   *      后交出去（`kind` 用后端的 `r.kind`，**不从前缀猜**；`label` 复用 `chipTextOf`；
   *      `color` 取 `colors[code]`，缺色时给兜底色 —— **绝不把 undefined 塞进去**，
   *      `NavBrandBar` 是 `style={{ background: picked.color }}`，空串/undefined 会让
   *      白字落在透明底上（等于看不见））。
   *      **本分支不写 `SS_RETURN`**：那个标记的语义是"从 `/line` 返回时重开搜索层"
   *      （`NavShell` mount 时消费），不跳页还写会留下脏标记，下次刷新莫名弹搜索层。
   *   ② 未接线 ⇒ 保留旧的深链 `/line/[code]`（独立页留给外部分享链接）：
   *      跳转前打 `SS_RETURN` 一次性标记，返回时 `NavShell` 会重新打开本层。
   */
  function openLine(r: RouteSuggestion) {
    const code = (r.code ?? r.name ?? "").trim();
    if (!code) return;
    if (onOpenLine) {
      onOpenLine({
        code,
        kind: r.kind,
        label: chipTextOf(r),
        color: colors?.[code] || "var(--primary)",
      });
      // 并行开发期兜底：宿主只接了回调、没接 `lineOpen` ⇒ 收起本层，否则全屏搜索页会盖住刚打开的线
      if (lineOpen === undefined) onBack();
      return;
    }
    // 兜底：深链。线路码可能是中文（`LRT-氹仔线`）⇒ 必须编码，否则 URL 里出现裸中文（部分代理会 400）
    try {
      window.sessionStorage.setItem(SS_RETURN, "1");
    } catch {
      /* 隐私模式 ⇒ 只是不自动重开搜索层，不影响跳转 */
    }
    router.push(`/line/${encodeURIComponent(code)}`);
  }
  /** 另一个端点（非编辑中的那个）—— 用于双输入条时显示 */
  const other = editing === "from" ? dest : from;
  const otherLabel = other?.label ?? (editing === "from" ? "（未选）" : "我的位置");

  /**
   * ★ v3.6.1：线路视图打开期间 **什么都不渲染**，但**组件保持挂载**（关键）。
   *
   * · 必须"不渲染"：`.ssheet` 是 `position: fixed; inset: 0; z-index: 60` 的全屏层，
   *   留着它用户根本看不到地图上的线路走向（表现就是"点了没反应"）；
   * · 必须"保持挂载"：一卸载 `q`/`resp`/`busy` 全部归零 —— 而主人要求
   *   「从线路视图返回后，搜索面板与搜索词还在」。不卸载 ⇒ 天然满足，零持久化；
   * · 位置必须在**所有 hooks 之后**（否则 hooks 顺序会随 `lineOpen` 变化 ⇒ React 报错）。
   */
  if (lineOpen) return null;

  return (
    <section className="ssheet" role="dialog" aria-modal="true" aria-label="搜索地点">
      <header className="ssheet__top">
        <button type="button" className="ssheet__back" onClick={onBack} aria-label="返回">
          <Icon name="back" size={20} />
        </button>

        <div className="ssheet__fields">
          {/* ★ 2026-09-22：顺序为「**出发地在上、目的地在下**」（产品口径）。
              此前是「静态行（目的地）在上、输入行（出发地）在下」，与实际填写顺序相反。 */}
          <div className="ssheet__row ssheet__row--input">
            <span
              className={`ssheet__dot${editing === "from" ? " ssheet__dot--from" : " ssheet__dot--to"}`}
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              className="ssheet__inp"
              value={q}
              onChange={(e) => onInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  runSearch();
                }
              }}
              placeholder={editing === "from" ? "输入出发地" : "去哪儿？"}
              aria-label={editing === "from" ? "出发地" : "目的地"}
              inputMode="search"
            />
            {loading && <span className="ssheet__spin" aria-label="搜索中" />}
            {/* ★ 产品要求：输入与本地站名相同/部分相同时，**搜索按钮仍可点**。
                ★ v3.1.1 #7：**打字预测在途（busy==='type'）不禁用**，只有「点搜索」在途才禁用
                  ⇒ 输入后立即可点（修「点了没反应」）。 */}
            <button
              type="button"
              className="ssheet__go"
              onClick={runSearch}
              disabled={busy === "enter" || !q.trim()}
              title="搜索站点或地点"
            >
              搜索
            </button>
          </div>

          {/* 选出发地时：下方再显示**已定的目的地**（只读） */}
          {editing === "from" && (
            <div className="ssheet__row ssheet__row--static">
              <span className="ssheet__dot ssheet__dot--to" aria-hidden="true" />
              <span className="ssheet__static-text">{otherLabel}</span>
            </div>
          )}
        </div>
      </header>

      <div className="ssheet__body">
        {/* ── 尚未输入：推荐（只站点 / 常用地点对）── */}
        {!q.trim() && (
          <>
            {/* ★ 附近站点推荐 —— 产品口径：「中间是推荐条（巴士轻轨站点，无其他）」 */}
            {nearby.length > 0 && (
              <div className="ssheet__sect">
                <p className="ssheet__sect-title t-label" role="heading" aria-level={3}>
                  附近站点
                </p>
                {nearby.map((s) => (
                  <button
                    key={s.code}
                    type="button"
                    className="ssheet__item"
                    onClick={() =>
                      onPick(
                        { kind: "station", label: `${s.code} ${s.name}`.trim(), lng: s.lng, lat: s.lat, code: s.code },
                        editing,
                      )
                    }
                  >
                    <ResultTag kind="station" />
                    <span className="ssheet__main">
                      <span className="ssheet__name">{`${s.code} ${s.name}`.trim()}</span>
                    </span>
                    <span className="ssheet__dist">{s.distM} m</span>
                  </button>
                ))}
              </div>
            )}
            {quickPairs.length > 0 && (
              <div className="ssheet__sect">
                <p className="ssheet__sect-title t-label" role="heading" aria-level={3}>
                  常用
                </p>
                {quickPairs.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className="ssheet__pair"
                    onClick={() =>
                      onPickQuick(
                        { kind: f.from.kind, label: f.from.label, lng: f.from.lng, lat: f.from.lat, code: f.from.code },
                        { kind: f.to.kind, label: f.to.label, lng: f.to.lng, lat: f.to.lat, code: f.to.code },
                      )
                    }
                  >
                    <Icon name="origin" size={16} />
                    <span className="ssheet__pair-from">{f.from.label}</span>
                    <Icon name="arrowRight" size={16} />
                    <Icon name="destination" size={16} />
                    <span className="ssheet__pair-to">{f.to.label}</span>
                  </button>
                ))}
              </div>
            )}
            <p className="ssheet__tip t-label t-muted">
              输入关键字会列出巴士站 / 轻轨站；想找具体地点，点右侧「搜索」。
            </p>
          </>
        )}

        {/* ── 已输入：结果列表 ── */}
        {q.trim() && (
          <div className="ssheet__list">
            {/*
              ★★ v3.6.0（AC-40）：**线路分区在最顶部**，且与地点/站点分区**互不混排**。
              ★★ v3.6.1：**线路区不再有独立分区标题** ——
                主人原话是「搜索后**左侧的标签**不是线路标签，而是『巴士线路』…而线路标签在
                **它的右边**」⇒ 他要的是**行内**结构 `[巴士线路][50]`。行内已经说了类型，
                再在上面加一层同名标题就是同屏同一个词出现两次（噪音）⇒ 两个 `<h3>` 已删，
                巴士/轻轨的区分完全由行内标签承担，组间靠 `.ssheet__sect--routes` 的上内距留白。
                线路区与「地点/站点」区之间**仍有明确分界** —— 见下方 `--split` 那条分隔线。
              ── 为什么线路不能和站点混排 ────────────────────────────────────
                线路行的**动作**是「在地图上打开这条线」，站点行是「设为目的地」。
                混排会让两件不同的事长得一样，用户点了线路以为选了终点（AC-41 明令禁止）。
            */}
            {busRoutes.length > 0 && (
              <div className="ssheet__sect ssheet__sect--routes" data-route-sect="bus">
                {busRoutes.map((r) => (
                  <LineResultRow key={`r-bus-${r.code}`} r={r} color={colors?.[r.code]} onOpen={openLine} />
                ))}
              </div>
            )}
            {lrtRoutes.length > 0 && (
              <div className="ssheet__sect ssheet__sect--routes" data-route-sect="lrt">
                {lrtRoutes.map((r) => (
                  <LineResultRow key={`r-lrt-${r.code}`} r={r} color={colors?.[r.code]} onOpen={openLine} />
                ))}
              </div>
            )}

            {/*
              ★ 2026-11-05（通琴号 R7 / AC-9）：**通琴号分区** —— 按班次逐条，上限 80 条，
                不做聚合折叠（负责人裁决 4）。与线路分区并列、同样不与地点/站点混排：
                本区行的动作是「在地图上看这一班的走线」。
            */}
            {tqhHits.length > 0 && onOpenTqhTrip && (
              <div
                className="ssheet__sect ssheet__sect--routes"
                data-route-sect="tqh"
                data-tqh-count={tqhHits.length}
              >
                {tqhHits.map((t) => (
                  <TqhResultRow key={`t-${t.trip_code}`} trip={t} onOpen={onOpenTqhTrip} />
                ))}
              </div>
            )}

            {/*
              线路区 ⇄ 地点/站点区 的分界线（既有 class，未新增样式）。
              ★ v3.6.1：文案保持「地点 / 站点」不变 —— 它同时承担"另一类结果开始了"的分隔职责。
              ★ 2026-11-05：通琴号分区也计入（它同样是"非地点/站点"的结果）。
            */}
            {((routeHits.length > 0 || tqhHits.length > 0) && (results.length > 0 || pending.length > 0)) && (
              <p className="ssheet__sect-title ssheet__sect-title--split t-label" role="heading" aria-level={3}>
                地点 / 站点
              </p>
            )}

            {results.map((r, i) => {
              /* ★ 2026-09-27（用户口径）：两行布局——左列「地点名（大字）+ 地址（小字）」；右侧直线距离；
                 「高德」来源标签与行政区划不再展示（地址已剥离区划前缀）。 */
              const addr = cleanAddr(r.address);
              return (
                <button key={`${r.name}-${i}`} type="button" className="ssheet__item" onClick={() => pick(r)}>
                  <ResultTag kind={r.kind} />
                  <span className="ssheet__main">
                    <span className="ssheet__name">{displayName(r)}</span>
                    {addr && <span className="ssheet__addr t-muted">{addr}</span>}
                  </span>
                  {typeof r.distM === "number" && <span className="ssheet__dist">{r.distM} m</span>}
                </button>
              );
            })}

            {pending.map((p, i) => (
              <button
                key={`p-${p.name}-${i}`}
                type="button"
                className="ssheet__item ssheet__item--pending"
                onClick={() => void pickPending(p.name)}
                title="点「搜索」获取精确位置"
              >
                <ResultTag kind={tagKindOfPending(p)} />
                {p.targetKind === "route" ? (
                  <RouteStack codes={[p.name]} colorOf={(c) => colors?.[c] ?? null} />
                ) : (
                  <span className="ssheet__name">{p.name}</span>
                )}
                <span className="ssheet__badge ssheet__badge--soft">点搜索确认</span>
              </button>
            ))}

            {/* ★ 2026-11-05：有通琴号命中时也不算"找不到"（否则同一屏同时显示结果与空态） */}
            {!loading && !results.length && !pending.length && !tqhHits.length && (
              <p className="ssheet__empty t-muted">{hint ?? (err || "找不到这个地点 · 试试换个说法")}</p>
            )}
            {!!results.length && hint && <p className="ssheet__empty t-muted">{hint}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
