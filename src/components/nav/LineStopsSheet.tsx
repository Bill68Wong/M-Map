"use client";

/**
 * 通琴号 · 站点列表三档弹窗（src/components/nav/LineStopsSheet.tsx，2026-11-05 · Spec R5/R6）
 *
 * ── 复用既有三档机制（`03-UIUX.md` §8.1：hook 一行不改）────────────────
 *   `useSnapSheet` 已把「档位顶边像素数组 `topsPx`」作为入参 ⇒ 通琴号只传自己的三个顶边：
 *   ```
 *   full = clamp(max(safeTop+44, 12vh), 96, 128)   大半屏：顶部一行 + 站序全列表
 *   half = 50vh                                    半屏
 *   peek = winH − (96 + safeBottom)                小半：**只有顶部一行**
 *   ```
 *   ★ peek 的**可见高 96 + 安全区**是本迭代唯一覆写的几何值（导航 peek 是 80vh，
 *     因为它要放摘要 + 指标；这里只放一行）。`tqhDetentTopsPx()` 是唯一计算点。
 *
 * ── 顶部行（§8.2 + §17-R5 授权加发车时刻）──────────────────────────────
 *   `[A1]  往横琴 发车时间：08:30   [换向][刷新][叉]`
 *   · 标号 chip：`--tqh-accent` 底 / `--tqh-on` 白字 / 高 24 / 13px **700**（白字须加粗）；
 *   · 时刻：该班 `departure_time`（**计划时刻，不是实时**）/ 11px / `--meta` /
 *     `tabular-nums` / **`flex: none` 不许省略**（它才是「这是哪一班」的判别位：
 *     同「标号,方向」下存在 2 套站序，只显示标号+方向分不清）；
 *     ★ 2026-11-06（#4）：文案由「 · 08:30」改为「发车时间：08:30」（显式标签，
 *       乘客不必猜这个时刻是什么）；`data-time-label="departure"` 是 QA 钩子。
 *   · 方向：13px `--muted` / `flex: 0 1 auto` + `min-width:0`（可省略，正常不触发）；
 *   · 三键 44×44，间距 8；关闭键位置**恒定**（换向键不隐藏 —— 6 个单向标号用
 *     `aria-disabled` + 点击 toast 说明原因，隐藏会让关闭键左移 52px）。
 *
 * ── 纵条（§17-R4 裁决：**不做巴士图标、不做巴士信息弹窗**）────────────
 *   只留 rail + 节点（样式统一，不区分已过/当前/未到），站名后加「澳 / 琴」小标签。
 *   因此不存在"车在哪"的语义 ⇒ 也**没有**伪装实时的风险面。
 *   ★ 2026-11-08：每站追加**计划时刻**（`.lp-stop__time`，来自 `tqh_trip_stops.stop_time`）。
 *     它是时刻表里的计划值，不是报站 ⇒ 文案只有 `HH:MM`，禁止「还有 N 分钟」类措辞。
 *     此前这一列在映射时被丢弃，行内 `data-eta` 又恒 `none` ⇒ 整列全是「—」。
 *
 * ── 刷新冷却（§8.4 / §14-R5）─────────────────────────────────────────
 *   通琴号是静态班次表 ⇒ 独立常量 `COOLDOWN_TQH_SEC`（3s），**不复用车辆冷却**。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/ui/Icon";
import LineStopList from "@/components/line/LineStopList";
import { COOLDOWN_TQH_SEC, useCooldown } from "./useCooldown";
import { useSnapSheet } from "./useSnapSheet";
import { DETENTS, detentIndex, tqhDetentTopsPx, type Detent } from "./sheet-detents";
import { hhmm, stationMapOf, type TqhStation, type TqhTrip } from "./tqh-model";
import type { LineStop } from "@/lib/line/line-shared";

export interface LineStopsSheetProps {
  open: boolean;
  trip: TqhTrip | null;
  stations: TqhStation[];
  /** 同标号全部班次（换向在客户端就地选，不额外请求） */
  siblings: TqhTrip[];
  /** 换向选定的下一班（宿主写回 `tripCode`） */
  onSwitchTrip: (trip: TqhTrip) => void;
  /** 关闭 = 退出该班次的线路视图（清地图路径 + 站点高亮） */
  onClose: () => void;
  /** 重取班次表（宿主：`useTqhLines().reload`） */
  onRefresh: () => void;
  winH: number;
  safeTop: number;
  safeBottom: number;
}

/** 换向选班：同标号下**反向**且发车时刻最接近当前一班的（无则 null） */
function oppositeTripOf(trip: TqhTrip, siblings: TqhTrip[]): TqhTrip | null {
  const others = siblings.filter((t) => t.trip_code !== trip.trip_code && t.direction !== trip.direction);
  if (!others.length) return null;
  const min = (t: TqhTrip) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t.departure_time ?? ""));
    return m ? Number(m[1]) * 60 + Number(m[2]) : Number.MAX_SAFE_INTEGER;
  };
  const cur = min(trip);
  return others.slice().sort((a, b) => Math.abs(min(a) - cur) - Math.abs(min(b) - cur))[0] ?? null;
}

export default function LineStopsSheet({
  open,
  trip,
  stations,
  siblings,
  onSwitchTrip,
  onClose,
  onRefresh,
  winH,
  safeTop,
  safeBottom,
}: LineStopsSheetProps) {
  const [detent, setDetent] = useState<Detent>("half");
  const sheetRef = useRef<HTMLElement | null>(null);
  const topsPx = useMemo(() => tqhDetentTopsPx(winH, safeTop, safeBottom), [winH, safeTop, safeBottom]);

  /**
   * ★ 2026-11-07（P1 修复）：当前档位顶边（**落定值**）→ 内联 `--lst-top`。
   *
   * 与 `RouteStopsSheet` 同一个缺陷、同一个修法：`.lst-sheet` 是 `top:0 + height:100dvh`
   * 靠 `translateY(顶边)` 下移 ⇒ 盒子在 half 档占 422 → 1266（溢出屏幕 422px），
   * 而 `__body` 的 `flex:1` 让它以为有 778px 高 ⇒ **列表最后 422px 永远滚不到**。
   * 本弹窗没有「点击行滚动」的交互，所以一直没暴露，但滚动到底同样够不到最后几行。
   *
   * ⚠️ 只写落定值（不要跟 `--sheet-y-anim` 逐帧走，那会让列表每帧重排 ⇒ 拖动掉帧）。
   */
  const topPx = Math.round(topsPx[detentIndex(detent)] ?? 0);

  /**
   * 头部（抓手 + 顶行）**实测**高度 → `--lst-head-h`；CSS 用它把 body 夹到
   * `100dvh - 顶边 - 头部`（缺省 66px 兜底：8 + 4 grip + 6 + 44 + 4）。
   */
  const handleRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sheetRef.current;
    const h = handleRef.current;
    if (!el || !h) return;
    const write = () => el.style.setProperty("--lst-head-h", `${Math.round(h.offsetHeight)}px`);
    write();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(write);
    ro.observe(h);
    return () => ro.disconnect();
  }, []);

  const snap = useSnapSheet({
    open,
    detent,
    topsPx,
    onDetentChange: setDetent,
    onDismiss: onClose,
    dismissible: true,
    sheetRef,
  });

  const cd = useCooldown(COOLDOWN_TQH_SEC);
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(""), 3000); // = --toast-dur
    return () => window.clearTimeout(t);
  }, [toast]);

  /** 打开 / 换班次 ⇒ 回到默认档 half（peek 是从 half 往下拖的临时态） */
  useEffect(() => {
    if (open) setDetent("half");
  }, [open, trip?.trip_code]);

  /** 换向：单向标号 → 不换向，弹 3s 原因（禁用外观 + 可点，不用原生 disabled） */
  const onReverse = useCallback(() => {
    if (!trip) return;
    const next = oppositeTripOf(trip, siblings);
    if (!next) {
      setToast(trip.direction === "往澳门" ? "本线路仅往澳门方向" : "本线路仅往横琴方向");
      return;
    }
    onSwitchTrip(next);
  }, [trip, siblings, onSwitchTrip]);

  const onRefreshClick = useCallback(() => {
    // 事件回调里读时间戳（后台节流时 `cd.sec` 会停在旧值，见 `useCooldown.remainingSec` 注释）
    if (cd.remainingSec() > 0) return;
    cd.start();
    onRefresh();
  }, [cd, onRefresh]);

  const stationById = useMemo(() => stationMapOf(stations), [stations]);
  const stops: LineStop[] = useMemo(() => {
    if (!trip) return [];
    return trip.stops.map((st) => {
      const s = stationById.get(st.station_id);
      return {
        seq: st.seq,
        // 通琴号没有巴士站台码 ⇒ 用站 id 的字符串做行 key（`data-stop-code` 仅作标识）
        code: String(st.station_id),
        name: s ? s.name : String(st.station_id),
        kind: "bus" as const,
        lat: s ? s.lat : null,
        lng: s ? s.lng : null,
        mileM: null,
      };
    });
  }, [trip, stationById]);

  const sideOf = useCallback(
    (stop: LineStop) => stationById.get(Number(stop.code))?.side,
    [stationById],
  );

  /**
   * ★ 2026-11-08：逐站**计划时刻**（`HH:MM`）—— 以通琴号站 `id` 为键。
   *
   * ── 数据链路（本来一路都有，是前端映射时丢的）────────────────────────────
   *   `tqh_trip_stops.stop_time`（`TIME NOT NULL`，库内注释「计划到站时刻」）
   *     → `/api/tqh/lines`（`src/lib/tqh/query.ts` 的 `to_char(stop_time,'HH24:MI:SS')`）
   *     → `TqhStop.stop_time`（`tqh-model.ts:44`）
   *     → **此处**（此前 `stops` 映射只取 `seq`/`station_id`，这一列被丢掉）
   *     → `LineStopRow` 的 `.lp-stop__time`。
   *   实测 A1｜往澳门：07:30 / 07:40 / 07:43 / 08:15 / 08:25 / 08:27 / 08:32 —— 逐站不同。
   *
   * ⚠️ 是**计划时刻表**，不是实时报站；文案只有 `HH:MM` 本身（不得出现「还有 N 分钟」）。
   */
  const plannedTimeOf = useMemo(() => {
    const m = new Map<number, string>();
    for (const st of trip?.stops ?? []) {
      const t = hhmm(st.stop_time);
      if (t) m.set(st.station_id, t);
    }
    return (stop: LineStop) => m.get(Number(stop.code)) ?? null;
  }, [trip]);

  /** 时刻（计划发车；`HH:MM`）—— 顶部行与 aria-label 共用同一份 */
  const dep = hhmm(trip?.departure_time);
  /** 单向判定口径：该标号在 `tqh_trips` 里 `distinct direction === 1`（§8.5，不用"大概一半"这类模糊描述） */
  const singleDirection = new Set(siblings.map((t) => t.direction)).size <= 1;
  const rowLabel = trip ? `${trip.route_no}，${trip.direction}${dep ? `，${dep} 发车` : ""}` : "";

  // 空数组稳定引用（避免 `LineStopList` 每次渲染都因新 Map 而重算换乘列）
  const noLines = useMemo(() => new Map<string, string[]>(), []);
  const noopRegister = useCallback(() => {}, []);
  /**
   * 通琴号**无实时报站**（静态班次表）⇒ eta 恒 `idle`：`data-eta="idle"` 照常输出到 DOM
   * （三态契约不变），但 `LineStopRow` 对 `idle` **渲染空白**（不画「—」、不画骨架）。
   * 计划时刻**追加**在同一个右对齐格内（`.lp-stop__time`，见 `plannedTimeOf`）——
   * 通琴号的报站列本来就恒空，这一列正好用来放计划时刻，不额外吃站名宽度。
   *
   * ★ 2026-11-08：原为 `{ phase: "none" }` ⇒ 每行都渲染一个「—」，被误读成"时刻缺失"。
   *   `none` 的语义是「该站确认无车」（报站口径），而通琴号的问题从来没有实时源，
   *   用 `none` 既误导又制造了整列「—」。与 `RouteStopsSheet.tsx:219` 的 `etaIdle` 同口径。
   * ⚠️ 旧注释写的「报站列由 CSS 在本层隐藏」是**假的** —— `globals.css` 只隐藏
   *   `.lp-page[data-kind="lrt"]`（:8866），通琴号 `.lst-sheet` 没有任何隐藏规则。
   *   故必须靠 `idle` 让这一列留白，而不是指望一条不存在的 CSS。
   */
  const etaIdle = useCallback(() => ({ phase: "idle" as const, text: null }), []);

  if (!trip) return null;

  return (
    <section
      ref={(el) => {
        sheetRef.current = el;
      }}
      className="lst-sheet"
      data-detent={detent}
      data-open={open ? "on" : "off"}
      data-dragging={snap.dragging ? "on" : "off"}
      data-tqh-trip={trip.trip_code}
      data-direction={trip.direction}
      aria-hidden={!open}
      inert={!open ? true : undefined}
      aria-label={`通琴号 ${trip.route_no} 站序`}
      style={
        {
          /* 当前档位顶边（落定值）—— CSS 用它把滚动容器夹到真实可见高度，见 `topPx` 注释 */
          "--lst-top": `${topPx}px`,
          "--sheet-y-anim": `${Math.round(snap.translateY)}px`,
        } as React.CSSProperties
      }
    >
      <div
        ref={handleRef}
        className="lst-sheet__handle"
        onPointerDown={snap.onPointerDown}
        onPointerMove={snap.onPointerMove}
        onPointerUp={snap.onPointerUp}
        onPointerCancel={snap.onPointerUp}
      >
        <span className="lst-sheet__grip" aria-hidden="true" />
        <div className="lst-sheet__head" role="group" aria-label={rowLabel}>
          <span className="lst-sheet__no" aria-hidden="true">
            {trip.route_no}
          </span>
          {/*
            ★ 方向与时刻是**两个并列的 flex 项**（§17-R5）：
              · 方向 `flex: 0 1 auto` + `min-width:0` + ellipsis（可让位）；
              · 时刻 `flex: none` + `white-space:nowrap`（**永不被省略**）。
            ⚠️ 时刻**不能嵌在方向 span 里**：那样它就不是 flex 项，`flex:none` 不生效，
               且会被父级 `text-overflow: ellipsis` 一起截掉 —— 它是「这是哪一班」的判别位
               （同（标号,方向）下存在 2 套站序），被截掉等于丢信息。
            分隔符 ` · `（前后各一空格）挂在时刻前面，与搜索卡副行同一语汇。
          */}
          <span className="lst-sheet__dir">{trip.direction}</span>
          {/*
            ★ 2026-11-06（修复批 #4）：「 · HH:MM」→「发车时间：HH:MM」。
              理由：点号分隔的时刻对普通乘客是**哑谜**（看不出这是发车时刻还是到站时刻，
              也看不出是计划还是实时）；显式标签把「这是本班的计划发车时间」说清楚。
            ⚠️ 只改**通琴号**（本文件）。`RouteStopsSheet`（澳门巴士/轻轨）的 `firstTime`
              当前恒 `null`（`/api/route-stops` 不下发首班时刻 = 已知缺口 G1）⇒ 那里
              仍是「 · 」写法但**永不渲染**，本轮不动（改了也没有可见效果，反而制造假一致）。
            ⚠️ `data-time-label` 是 QA 的断言钩子（固定值 `departure`）：文字再改，
              自动化靠属性仍能定位到「这是发车时间那一格」。
          */}
          {dep && (
            <span className="lst-sheet__time" data-time-label="departure">
              发车时间：{dep}
            </span>
          )}
          <span className="lst-sheet__acts">
            <button
              type="button"
              className="lst-sheet__iconbtn"
              aria-label="切换方向"
              aria-disabled={singleDirection ? "true" : undefined}
              data-inert-reason={singleDirection ? "single-direction" : undefined}
              onClick={onReverse}
            >
              <Icon name="exchange" size={20} />
            </button>
            <button
              type="button"
              className={`lst-sheet__iconbtn${cd.cooling ? " is-cooling" : ""}`}
              aria-label="刷新班次"
              aria-disabled={cd.cooling ? "true" : undefined}
              onClick={onRefreshClick}
            >
              <Icon name="refresh" size={20} />
              {cd.cooling && <span className="lst-sheet__cd">{cd.sec}</span>}
            </button>
            <button type="button" className="lst-sheet__iconbtn" aria-label="关闭" onClick={onClose}>
              <Icon name="close" size={20} />
            </button>
          </span>
        </div>
      </div>

      <div className="lst-sheet__body">
        {/* ★ 纵条：rail + 节点 + 站名 +「澳 / 琴」标签（§17-R4）。
            报站列恒留白（无实时源，`etaIdle`）；每站**计划时刻**由 `plannedTimeOf`
            追加进同一个右对齐格（`.lp-stop__time`）⇒ 不新增列、不挤站名宽度。 */}
        <LineStopList
          stops={stops}
          color="var(--tqh-accent)"
          etaOf={etaIdle}
          plannedTimeOf={plannedTimeOf}
          registerEl={noopRegister}
          linesOfStation={noLines}
          lineCode=""
          sideOf={sideOf}
        />
      </div>

      {toast && (
        <p className="lst-sheet__toast" role="status">
          {toast}
        </p>
      )}
    </section>
  );
}

/** 档位顺序（供宿主断言用；与 `DETENTS` 同源） */
export const LST_DETENTS = DETENTS;
