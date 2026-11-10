"use client";

/**
 * 巴士站点信息卡（src/components/nav/StationCard.tsx，v2.1.0；★ 修复包 v2.2.1-B4 多台站分组）
 *
 * ── 定位（产品口径 2026-09-19）─────────────────────────────────────────
 *   首页地图点击巴士站 → 浮层卡片：**站名（繁体）+ 该站所有线路的实时报站**
 *   + 「设为起点 / 设为目的地」（联动上方搜索框）。可关闭。
 *
 * ── 标题 / 副行 / 分组（2026-11-06 修复批 #2，Spec §3 #2）──────────────
 *   · 标题 = **「澳门巴士站标号 + 站名」**（`T355 蓮花路停車場`）；
 *     轻轨站不显示 `LRT-XXX`（产品 2026-09-22 口径，保留）；
 *   · 副行 = **只写「N 条线路」**（旧版那个「N 个分组 · 」的计数前缀已按 Spec 删除 ——
 *     用户不需要先读一个分组数才知道下面为什么分块）；
 *   · 站台分组组名 = **`含站台后缀的标号-站名`**（半角连字符，保留子码斜杠）：
 *     `T355/1-蓮花路停車場`、`M172/1-亞馬喇前地`；
 *     ⚠️ 「站台名」取 `/api/station/eta` 的 `platformName`（若后端下发），
 *        否则回落**主站名**。实测 `stations.name_tc` 在同一主码下的各站台**同名**
 *        （`M172/1` 与 `M172/16` 都叫 `亞馬喇前地`）⇒ 现阶段产出即 `M172/1-亞馬喇前地`。
 *   · 每个分组 = **发丝线框 + `--radius-card`、无阴影**（不做"卡中卡"投影堆叠）；
 *   · 分组按子码升序，组内沿用接口的报站升序；分组 >3 时第 3 组起折叠；
 *   · **单分组（或无 `platform` 字段）→ 不显示分组容器与子码行**（向后兼容）。
 *
 *   ⚠️ 子码里的 `/` 是**分组号**的一部分，**绝不套线路标签的墨色组胶囊**
 *      （08 §D.2：否则会被读成"T373 或 1 两条线"）—— 故组名只用等宽同色连写。
 *
 * ── 通琴号分组（2026-11-06 修复批 #2 / R1）─────────────────────────────
 *   同一物理站位的通琴号班次是**本卡的最后几个分组**（不是另一张卡）：
 *   · 组名 `通琴号-<通琴号站名>`，**不显示巴士标号**；
 *   · 一个主码可能对应多个通琴号站（`M172` → `亚马喇前地F站台` + `G站台`）⇒ 各成一組；
 *   · 组内仍按方向（往澳门 / 往横琴）+ 计划发车时刻排列（沿用 `TqhStationTrips`）；
 *   · 通琴号是**静态时刻表** ⇒ 块内不得出现「还有 N 分钟 / 实时」字样；
 *   · 通琴号分组**不计入**站台分组（副行只报巴士线路数）。
 *
 * ── 线路行可点（2026-11-06 修复批 #4）──────────────────────────────────
 *   报站行 = 「点站点 → 点线路 → 进该线路查看」（弹窗由前端 C 的 `RouteStopsSheet` 提供）。
 *   · **导航进行中禁用**（`pickLineDisabled`）：视觉禁用 + 点击无跳转、无报错；
 *   · 用 `role="button"` + `tabIndex` 而不是 `<button>` —— 行样式（`.nav-station-card__row`）
 *     是 flex 布局且未做 button 重置，改标签会带出浏览器默认底色/边框；
 *   · 行内是文本 + `RouteStack`，无嵌套按钮 ⇒ 不需要拦冒泡。
 *
 * ── 数据 ──────────────────────────────────────────────────────────────
 *   · 站名/坐标由调用方（NavShell，来自 `/api/stations`）传入；
 *   · 报站列表 `fetch('/api/station/eta?code=…')`（进入卡片时拉一次；含加载/失败态）；
 *     ★ `platform` 字段由 `/api/station/eta` 返回（贝洛奇 v2.3.0）——**按"可能存在"消费**。
 *
 * ── 降级 ──────────────────────────────────────────────────────────────
 *   接口失败/空 ⇒ 就地提示「暂无报站」，**不阻塞**设为起点/目的地与搜索、出发。
 *
 * ★ 站名/线路名用**繁体**，界面文案用**简体**（§6.2）。
 * ★ 报站的**站数 N** 与「**即将到站**」用 `<b>` + 青花蓝突出（与卡片报站行同款）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import RouteStack from "@/components/RouteStack";
import Icon from "@/components/ui/Icon";
import SetPointActions from "./SetPointActions";
import { EtaText } from "@/components/RoutePieces";
import { TqhStationTrips } from "./TqhStationCard";
import type { TqhStationEntry, TqhTrip } from "./tqh-model";

export interface StationCardStation {
  /** 主码 */
  code: string;
  /** 站名（繁体） */
  name: string;
  /** 经度（GCJ-02） */
  lng: number;
  /** 纬度（GCJ-02） */
  lat: number;
}

/** `/api/station/eta` 一条（与后端 `StationEtaItem` 对应） */
interface EtaItem {
  route: string;
  dir: string;
  /** ★ B4：本站台码（如 `T373/1`）；旧版接口可能不返回 → 缺省时退化为单分组 */
  platform?: string;
  /**
   * ★ 2026-11-06（修复批 #2）：该站台**站名**（后端可选下发）。
   * 未下发 ⇒ 回落主站名（实测同主码下各站台 `name_tc` 相同，视觉无差别）。
   */
  platformName?: string;
  dirLabel: string;
  stopsAway: number | null;
  etaMin: number | null;
  ok: boolean;
  /** ★ 2026-09-22：载具种类（缺省按巴士，兼容旧接口） */
  kind?: "bus" | "lrt";
  /** ★ 2026-09-22 轻轨专用：下一班发车时刻 `HH:MM`（**已含实测偏差修正**） */
  nextAt?: string | null;
  /** ★ v2.10.1 轻轨专用：秒级剩余（服务端算出该值那一刻的快照；新接口已由 depMs 取代） */
  etaSec?: number | null;
  /** ★ 2026-09-24 轻轨专用：下一班**发车绝对时刻**（UTC 毫秒，已含偏差）。
   *   倒计时 = `depMs − 设备时钟`（不再折算服务端时基 ⇒ 缓存/网络延迟不影响读数） */
  depMs?: number | null;
  /** ★ v2.10.1 轻轨专用：该线实测偏差（秒） */
  biasSec?: number;
}

interface EtaResponse {
  code: string;
  fetchedAt: string;
  /** ★ 2026-09-25：本次响应生成时的服务端 Date.now()（设备时钟对时；老接口无 → offset=0 降级） */
  serverNowMs?: number;
  items: EtaItem[];
}

/** 站码主码归一（剥站台后缀：`T373/1` → `T373`）。
 *  ⚠️ 故意**本地内联**：`@/lib/recommend/segment-lookup` 是 server-only（含 pg），
 *     客户端组件不能 import（`poi-search.ts` 也是同样做法的本地副本）。 */
function mainCodeOf(code: string): string {
  return /^[A-Za-z]+\d+/.exec(code)?.[0] ?? code;
}

/**
 * 轻轨「还有多久」文案（★ 2026-09-24 改为「绝对发车时刻 + 设备时钟」）。
 *
 *   · **氹仔线**（班次密）→「下一班还有 X 分」—— 不显示秒
 *   · **横琴线 / 石排湾线**（班次疏）→「下一班还有 X 分 XX 秒」—— 逐秒递减
 *
 * ★ 2026-09-24（用户拍板，替代 baseMs 方案）：服务端下发 `depMs`（**发车绝对时刻**，
 *   已含线路实测偏差）⇒ 倒计时直接 `depMs − 设备时钟`：
 *   · 完全不受网络往返 / 服务端 20s 缓存延迟影响（旧 `etaSec` 快照命中缓存时会整体偏大）；
 *   · 不依赖服务端时钟（手机与服务器时钟差不再影响读数）。
 * 降级：老接口无 `depMs` 时退回 `etaSec` 快照（宁简勿错）。
 * 不再显示「下一班 HH:MM」这种绝对时刻（用户口径：只要「还有多久」）。
 */
function lrtEtaText(it: EtaItem, nowMs: number, offsetMs = 0): string {
  if (it.depMs == null && it.etaMin === null) return "今日已收班";
  const withSec = /石排湾|横琴/.test(it.route);
  // ★ 首选：绝对时刻（depMs）—— 设备时钟 + 服务端对时偏移
  if (it.depMs != null) {
    const left = Math.max(0, Math.floor((it.depMs - (nowMs + offsetMs)) / 1000));
    if (left <= 0) return "即将开出";
    const m = Math.floor(left / 60);
    if (!withSec) return m <= 0 ? "即将开出" : `下一班还有 ${m} 分`;
    return `下一班还有 ${m} 分 ${String(left % 60).padStart(2, "0")} 秒`;
  }
  // 降级：老接口（无 depMs）→ etaSec 快照；再无则分钟级
  if (it.etaSec == null) {
    return (it.etaMin ?? 0) <= 0 ? "即将开出" : `下一班还有 ${it.etaMin} 分`;
  }
  const left = Math.max(0, it.etaSec);
  if (left <= 0) return "即将开出";
  const m = Math.floor(left / 60);
  if (!withSec) return m <= 0 ? "即将开出" : `下一班还有 ${m} 分`;
  return `下一班还有 ${m} 分 ${String(left % 60).padStart(2, "0")} 秒`;
}

/**
 * 报站内容（简体）。
 * · 巴士：ok=false→取不到；无车→暂无班次信息；0 站→即将到站；否则「还有 N 站 · 约 M 分」
 * · **轻轨**：时刻表制，显示「下一班还有 …」（见 `lrtEtaText`）
 * ★ 站数 N 与「即将到站」由 `<EtaText>` 加粗 + 青花蓝（通勤决策的关键数字，第一眼可见）。
 */
function etaNode(it: EtaItem, nowMs: number, offsetMs = 0) {
  if (it.kind === "lrt") {
    // ★ 2026-09-25：倒计时以「设备时钟 + 服务端对时偏移」对「绝对发车时刻 depMs」递减
    return <EtaText text={lrtEtaText(it, nowMs, offsetMs)} />;
  }
  if (!it.ok) return <>这条线路暂时取不到报站</>;
  if (it.stopsAway === null) return <>暂无班次信息</>;
  return (
    <EtaText text={it.stopsAway === 0 ? "即将到站" : `还有 ${it.stopsAway} 站 · 约 ${it.etaMin ?? 0} 分`} />
  );
}

/** 分组上限：超过则折叠其余（08 §D.2） */
const MAX_GROUPS = 3;

export default function StationCard({
  station,
  colors,
  onClose,
  onSetFrom,
  onSetTo,
  onPickLine,
  pickLineDisabled = false,
  navActive = false,
  tqh = null,
}: {
  station: StationCardStation;
  colors: Record<string, string>;
  onClose: () => void;
  onSetFrom: () => void;
  onSetTo: () => void;
  /**
   * ★ M4（需求 4）：导航语境 ⇒ 「设为起点/目的地」整块不渲染。
   * 判定在 `SetPointActions` 内部（唯一判定点），本组件只是把宿主状态透传下去 ——
   * 不要在调用点再写一遍 `!navActive &&`，否则新增弹窗必然漏判。
   */
  navActive?: boolean;
  /**
   * ★ 2026-11-06（修复批 #4 / R3）：点报站行 ⇒ 进入该线路的查看模式。
   * 弹窗本体由前端 C 的 `RouteStopsSheet` 提供，本组件只负责**触发与传参**
   * （`code` = 线路码 `26` / `LRT-氹仔线`；`kind` 决定是否走轻轨零请求分支）。
   * 不传 ⇒ 行不可点（DOM 与改前一致，零回归）。
   */
  onPickLine?: (code: string, kind: "bus" | "lrt") => void;
  /**
   * ★ 修复批 #4：**导航进行中**（`navActive`）⇒ 禁用跳线路（与「导航态点击不中断」一致）。
   * 视觉禁用 + 点击无跳转、无报错（不做原生 `disabled`，行不是 button）。
   */
  pickLineDisabled?: boolean;
  /**
   * ★ 2026-11-05（通琴号 R4 · 负责人裁决 5）：**关联巴士站**在同一张卡片下方追加通琴号班次。
   *
   * 口径：站点卡是「这个物理站位有什么车」的答案，通琴号既是同站位的第三类交通方式，
   * 就不该另开一张卡（用户要来回切两个浮层才能比较）。**只追加、不改既有报站区**：
   * 通琴号是静态时刻表，无报站 ⇒ 块内不出现任何「还有 N 分钟 / 实时」字样。
   * ★ 2026-11-06（#2）：改为**最底部的分组**（组名 `通琴号-<站名>`），按通琴号站逐个成组。
   * 不传（`null`）⇒ DOM 与改前逐字节一致（澳门纯巴士站零回归）。
   */
  tqh?: {
    entries: TqhStationEntry[];
    phase: "loading" | "ready" | "failed";
    activeTripCode?: string | null;
    onPickTrip: (trip: TqhTrip) => void;
    /**
     * ★ 2026-11-06（修复批 #6c）：**导航进行中 ⇒ 通琴号班次行禁用**（宿主传 `navActive`）。
     *
     * 为什么必须与 `pickLineDisabled` 同时存在：两者在同一张卡片上，
     *   只禁用线路行会得到「巴士 26 点了没反应、通琴号 A1 点了直接跳走」——
     *   不报错、不崩，只是行为不一致且无视觉暗示（沉默逻辑错误的教科书形态）。
     * 实现统一由 `TqhStationTrips` 承担（`aria-disabled` + 行内 `opacity/cursor`，
     *   **不用原生 `disabled`**），本组件只做透传 ⇒ 视觉与线路行同一套口径。
     * 缺省 `false` ⇒ DOM 与改前一致（零回归）。
     */
    pickTripDisabled?: boolean;
  } | null;
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [items, setItems] = useState<EtaItem[]>([]);
  const [showAllGroups, setShowAllGroups] = useState(false);
  /**
   * ★ 2026-09-22：秒级倒计时的时钟。
   *   **只在需要逐秒刷新时才起定时器**（轻轨含 `depMs`，或列表里出现「石排湾线 / 横琴线」），
   *   否则每秒重渲染纯属浪费。
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const needSec = items.some(
      (it) => it.kind === "lrt" && (it.depMs != null || /石排湾|横琴/.test(it.route)),
    );
    if (!needSec) return;
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [items]);

  /** ★ 2026-09-24：非首屏的「静默重拉」序号（发车到点后滚动到下一班用；不闪加载态） */
  const [reloadTick, setReloadTick] = useState(0);
  /** ★ 2026-09-25：静默重拉进行中（显示「正在获取下一班…」） */
  const [reloading, setReloading] = useState(false);
  const lastAutoRefetchRef = useRef(0);
  /** ★ 2026-09-25：服务端对时偏移（ms；正 = 设备慢）；存 ref，**不参与秒表依赖**（避免每秒重置） */
  const offsetRef = useRef(0);
  /** items 实时镜像（静默重拉时判断是否需要加载态） */
  const itemsRef = useRef<EtaItem[]>([]);
  itemsRef.current = items;
  /** 最近一次取数对应的站码（站码变化 ⇒ 非静默，防串台） */
  const lastCodeRef = useRef("");

  /**
   * ★ 2026-09-25：**发车到点自动重拉** —— 倒计时归零（对时后）即拉，滚动到「下一班」。
   *   轻轨站服务端已跳过缓存（每次都是最新时刻表）；护栏降为 1500ms（07 §3.3）。
   */
  useEffect(() => {
    if (phase !== "ready") return;
    const off = offsetRef.current;
    const passed = items.some((it) => it.kind === "lrt" && it.depMs != null && nowMs + off >= it.depMs);
    if (!passed) return;
    if (Date.now() - lastAutoRefetchRef.current < 1_500) return;
    lastAutoRefetchRef.current = Date.now();
    setReloadTick((t) => t + 1);
  }, [items, nowMs, phase]);

  useEffect(() => {
    let alive = true;
    /**
     * ★ 2026-09-24：静默重拉（同站、已有数据、非首屏）不闪加载态、不清空列表；
     *   站码变化 / 首屏仍按原口径显示加载态。
     */
    const codeChanged = lastCodeRef.current !== station.code;
    lastCodeRef.current = station.code;
    const silent = !codeChanged && reloadTick > 0 && itemsRef.current.length > 0;
    if (!silent) {
      setPhase("loading");
      setItems([]);
      setShowAllGroups(false);
    } else {
      setReloading(true);
    }
    fetch(`/api/station/eta?code=${encodeURIComponent(station.code)}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<EtaResponse>)
      .then((j) => {
        if (!alive) return;
        // ★ 对时：offsetMs = serverNowMs − Date.now()（旧接口无字段 → 保持 0，等价 v2.13）
        if (Number.isFinite(j.serverNowMs ?? NaN)) offsetRef.current = (j.serverNowMs as number) - Date.now();
        setItems(Array.isArray(j.items) ? j.items : []);
        setPhase("ready");
        setReloading(false);
      })
      .catch(() => {
        if (!alive) return;
        setReloading(false);
        if (!silent) setPhase("failed");
      });
    return () => {
      alive = false;
    };
  }, [station.code, reloadTick]);

  const main = mainCodeOf(station.code);
  /**
   * ★ 2026-09-22：**轻轨站**（主码 `LRT-` 前缀）。
   *   产品要求（用户反馈）：轻轨站**不要显示 `LRT-XXX` 这种码**，只显示繁体中文站名；
   *   巴士站保持「主码 + 站名」—— 那是用户认站的依据（`M123` / `T373`）。
   */
  const isLrt = station.code.startsWith("LRT-");

  /** 按 `platform` 聚合为站台分组；无 `platform` → 退化成「单组」（不画框、不显子码） */
  const groups = useMemo(() => {
    const map = new Map<string, { platform: string; platformName: string; items: EtaItem[] }>();
    for (const it of items) {
      const p = (it.platform ?? "").trim();
      const key = p || "__single__";
      if (!map.has(key)) {
        map.set(key, {
          platform: p,
          // ★ #2：站台名优先用接口下发的 `platformName`，否则回落主站名（见文件头说明）
          platformName: (it.platformName ?? "").trim(),
          items: [],
        });
      }
      map.get(key)!.items.push(it);
    }
    // 分组按子码升序（`/1` 前 `/2` 后）；组内沿用接口的报站升序
    return [...map.values()].sort((a, b) =>
      a.platform.localeCompare(b.platform, "zh-Hant", { numeric: true }),
    );
  }, [items]);

  const multiGroup = groups.length > 1;
  const shownGroups = multiGroup && !showAllGroups ? groups.slice(0, MAX_GROUPS) : groups;
  const restGroups = groups.length - shownGroups.length;

  const lineCount = new Set(items.map((i) => `${i.route}|${i.dir}`)).size;
  const allFailed = phase === "ready" && !items.length;

  /** 站台分组组名：`<含站台后缀的标号>-<站名>`（半角连字符；无站台码时只用主码兜底） */
  const groupNameOf = (g: { platform: string; platformName: string }): string => {
    const name = g.platformName || station.name;
    if (!g.platform) return name;
    return name ? `${g.platform}-${name}` : g.platform;
  };

  /** 线路行可点（#4）；导航态禁用 ⇒ 视觉禁用 + 无跳转 */
  const canPick = !!onPickLine;
  const pickDisabled = !canPick || pickLineDisabled;
  const pickOf = (it: EtaItem) => () => {
    if (pickDisabled || !onPickLine) return;
    onPickLine(it.route, it.kind === "lrt" ? "lrt" : "bus");
  };

  const rowOf = (it: EtaItem) => (
    <div
      className="nav-station-card__row"
      key={`${it.route}-${it.dir}`}
      {...(canPick
        ? {
            role: "button",
            tabIndex: pickDisabled ? -1 : 0,
            "aria-disabled": pickDisabled ? "true" : undefined,
            "aria-label": `查看 ${it.route}${it.dirLabel ? `（${it.dirLabel}）` : ""} 的线路站点`,
            "data-line-pick": pickDisabled ? "disabled" : "on",
            onClick: pickOf(it),
            onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
              if (pickDisabled) return;
              if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
                e.preventDefault();
                pickOf(it)();
              }
            },
          }
        : {})}
      style={canPick ? { cursor: pickDisabled ? "not-allowed" : "pointer", opacity: pickDisabled ? 0.45 : undefined } : undefined}
    >
      <RouteStack codes={[it.route]} colorOf={(c) => colors[c] ?? null} size="sm" />
      <span className="nav-station-card__dir t-label t-muted">{it.dirLabel}</span>
      <span className="nav-station-card__eta t-label">
        {it.kind === "lrt" && reloading
          ? "正在获取下一班…"
          : etaNode(it, nowMs, offsetRef.current)}
      </span>
    </div>
  );

  return (
    <div className="nav-station-card" role="dialog" aria-label={`站点 ${station.name}`}>
      <div className="nav-station-card__head">
        <span className="nav-station-card__name">
          {/* ★ 2026-09-22：轻轨站**不显示主码**（`LRT-SPW` 这类），只显示中文站名 */}
          {!isLrt && <span className="nav-station-card__code">{main}</span>}
          {station.name ? `${isLrt ? "" : " "}${station.name}` : ""}
        </span>
        <button className="nav-station-card__close" type="button" aria-label="关闭" onClick={onClose}>
          <Icon name="close" size={20} />
        </button>
      </div>

      {/* 副行：★ #2 —— 多站台时**只报线路数**（分组计数前缀已删） */}
      {phase === "ready" && items.length > 0 && (
        <p className="nav-station-card__meta">{lineCount} 条线路</p>
      )}

      <div className="nav-station-card__list">
        {phase === "loading" && <p className="t-label t-muted">读取报站中…</p>}
        {phase === "failed" && <p className="t-label t-muted">暂无报站</p>}
        {allFailed && <p className="t-label t-muted">暂无报站</p>}

        {phase === "ready" &&
          shownGroups.map((g) => {
            const rows = g.items.map((it) => rowOf(it));
            // ★ 单分组（或无 platform）→ 不显示分组容器与子码行（向后兼容）
            if (!multiGroup) return <div key="single">{rows}</div>;
            const dirs = new Set(g.items.map((i) => i.dirLabel));
            return (
              <div className="st-group" key={g.platform || "__single__"}>
                <div className="st-group__head">
                  {/* ★ 组名 = `标号/子码-站名`；`/` 是分组号，不套线路胶囊 */}
                  <span className="st-group__code">{groupNameOf(g)}</span>
                  {dirs.size === 1 && <span className="st-group__dir">{g.items[0].dirLabel}</span>}
                </div>
                {rows}
              </div>
            );
          })}

        {restGroups > 0 && (
          <button type="button" className="st-group__fold" onClick={() => setShowAllGroups(true)}>
            展开其余 {restGroups} 个分组
            <Icon name="caretDown" size={16} />
          </button>
        )}

        {/*
          ★ 通琴号分组（#2 / R1）：**最底部**，每个通琴号站一组，组名 `通琴号-<站名>`，无标号。
          `data-tqh-append="1"` 为既有观测钩子（保留在组上，存在性判据不变）。
          加载/失败态复用 `TqhStationTrips` 的降级文案（不出现实时/分钟字样）。
        */}
        {tqh &&
          (tqh.phase !== "ready" ? (
            <p className="tqh-trips__hint t-label t-muted" data-tqh-append="1">
              {tqh.phase === "loading" ? "读取通琴号班次…" : "通琴号班次暂时取不到"}
            </p>
          ) : (
            tqh.entries.map((e) => (
              <div className="st-group" key={`tqh-${e.station.id}`} data-tqh-append="1">
                <div className="st-group__head">
                  <span className="st-group__code">通琴号-{e.station.name}</span>
                </div>
                <TqhStationTrips
                  groups={e.groups}
                  phase="ready"
                  activeTripCode={tqh.activeTripCode ?? null}
                  onPickTrip={tqh.onPickTrip}
                  disabled={tqh.pickTripDisabled ?? false}
                />
              </div>
            ))
          ))}
      </div>

      {/* ★ M4（需求 4）：设点按钮统一由 `SetPointActions` 渲染（导航态整块不渲染） */}
      <SetPointActions navActive={navActive} onSetFrom={onSetFrom} onSetTo={onSetTo} />
    </div>
  );
}
