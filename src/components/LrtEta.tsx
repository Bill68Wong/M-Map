"use client";

/**
 * 轻轨时刻表报站卡（src/components/LrtEta.tsx）v0.15.2
 * 与巴士 LiveEta 同位置同视觉：只显示「下一班 / 再下一班」，无整日时刻表。
 * 数据链路：/api/lrt/eta（本地算）→ 一次拉取当日该站该线该方向时刻，
 *   之后客户端按绝对发车时刻（depMs）本地每秒重算倒计时——秒级不依赖网络。
 *
 * 口径（★ v3.2.0 修订 · 需求 1/2 · AC-66/68/69/70）：
 *   - **窗口**：`现正到达 ⇔ depMs - pre ≤ now ≤ depMs + post`（闭区间）。
 *     `pre` 逐线（氹仔 0:30 / 石排湾 2:00 / 横琴 1:00）；`post` **逐班**（有秒级读秒 10s / 无读秒 30s）。
 *   - **有秒级读秒的班次**（`secPrecise`）→ 窗口内一行「**现正到达 · X 分 Y 秒**」；窗口外「还有 X 分 Y 秒」。
 *     归零后（保持期）保留 lead「现正到达」，数值槽 `visibility:hidden` 占位 ⇒ **零布局位移**。
 *   - **无读秒的氹仔班次** → 窗口内大字切「现正到达」flash；窗口外「下一班 X 分钟」。
 *   - 站台报时卡与推荐卡（`LrtEtaInline`）**同一文案结构 / 同源窗口**（AC-70）。
 *   - **合规备注**（AC-66）：站台卡底部放完整句（小字、不换行）；紧凑处（推荐卡）放「推算」小角标。
 *   - 轻轨一律用「现正到达」；「即将进站」是巴士（DSAT 实时车距）专属文案。
 *   - 滚动：超过下一班发车时刻 + 该班保持期后自动落到再下一班（同数据，无请求）。
 *   - 空态：首班前/已收车/无数据 文案与 LiveEta 空态同风格。
 *   - 日切（澳门 0 点）自动重新拉取（服务班别/日期已变）。
 */
import RouteStack from "./RouteStack";
import Icon from "./ui/Icon";
import { pickCatchTier } from "@/lib/recommend/catch-up";
import { TierBadge } from "./RoutePieces";
import { TIER_TEXT, type CatchTier } from "@/lib/recommend/types";
import { useCallback, useEffect, useRef, useState } from "react";

/** 秒级读秒线路：石排湾线/横琴线（班次稀疏，倒计时需精确到秒）；
 *  氹仔线班次密仍按整分显示。码内含简/繁写法兜底匹配 */
const tickSecLine = (code: string) =>
  code.includes("石排") || code.includes("横琴") || code.includes("橫琴");

interface LrtDeparture {
  clock: string; // 'HH:MM'
  depMs: number; // 绝对毫秒时刻（D 00:00 + 偏移；★ v3.2.0 = fixDeparture 叠加偏差后的值）
  /** ★ v3.2.0（AC-63/65）：该班是否已叠加秒级偏差（true = 有秒级读秒）。缺省/undefined ⇒ 一律按 false 处理 */
  secPrecise?: boolean;
}

interface LrtEtaData {
  ok: boolean;
  error?: string;
  state: "running" | "before_first" | "after_last" | "no_data";
  lineCode: string;
  directionName: string | null;
  dayType: string;
  serviceDay: string; // 'YYYY-MM-DD'（澳门）
  firstClock: string | null;
  lastClock: string | null;
  departures: LrtDeparture[];
  serverNow: string;
}

/**
 * ★ v3.2.0（需求 2 / AC-68/69/70）：**逐线 `pre` + 逐班 `post`** 的到站窗口模型。
 *
 * 判定式：**现正到达 ⇔ `depMs - pre ≤ now ≤ depMs + post`**（★ **闭区间，含边界**）。
 *   · **`pre` 逐线**（进入「现正到达」的提前量）：氹仔 0:30 · 石排湾 2:00 · 横琴 1:00；
 *   · **`post` 逐班**（归零后「现正到达」保持时长）：有秒级读秒（`secPrecise`）**10s**；否则 **30s**；
 *   · ⚠️ 窗口**只作用于到站判定与显示**，**不改** `depMs`（绝对发车时刻，已含偏差）。
 */
const LRT_PRE_SEC: Record<string, number> = {
  "LRT-氹仔线": 30_000,
  "LRT-石排湾线": 120_000,
  "LRT-横琴线": 60_000,
};

/** 未知/新增线路的兜底 `pre`（沿用「氹仔」整分档的 30s 提前量） */
const LRT_PRE_FALLBACK = 30_000;

/** 归零后「现正到达」保持时长：有秒级读秒 10s / 无读秒 30s（AC-69） */
const postOf = (secPrecise: boolean) => (secPrecise ? 10_000 : 30_000);

/** 取该线的 `pre`（对简/繁「橫琴/横琴」等写法做包含式兜底匹配） */
function preOf(lineCode: string): number {
  const exact = LRT_PRE_SEC[lineCode];
  if (exact != null) return exact;
  const key = Object.keys(LRT_PRE_SEC).find((k) => {
    const bare = k.replace(/^LRT-/, "");
    return lineCode.includes(bare) || lineCode === bare;
  });
  if (key) return LRT_PRE_SEC[key];
  // 秒级线（石排湾/横琴的繁体写法）优先
  if (tickSecLine(lineCode)) return LRT_PRE_SEC["LRT-横琴线"];
  return LRT_PRE_FALLBACK;
}

/** 该班是否按秒级读秒（`secPrecise` 缺省 ⇒ 一律 false，AC-69 注解） */
const isPrecise = (d: LrtDeparture) => d.secPrecise === true;

/** 选「当前要展示的班次」= 第一个**窗口尚未结束**的班次（`depMs + post(该班) ≥ now`） */
function pickNext(dep: LrtDeparture[], nowMs: number): LrtDeparture | null {
  if (!dep.length) return null;
  return dep.find((d) => d.depMs + postOf(isPrecise(d)) >= nowMs) ?? null;
}

/** 该班是否处于「现正到达」窗口（★ 闭区间，含边界） */
function inArrivalWindow(d: LrtDeparture, nowMs: number, pre: number, post: number): boolean {
  return nowMs >= d.depMs - pre && nowMs <= d.depMs + post;
}

/** 「X 分 Y 秒」（两处统一：站台卡大字 / 推荐卡行内） */
const secText = (totalSec: number) => `${Math.floor(totalSec / 60)} 分 ${totalSec % 60} 秒`;

/** 澳门自然日 ymd（GMT+8，本地纯算） */
function macauYmd(ms: number): string {
  const d = new Date(ms + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

export default function LrtEta({
  station,
  route,
  dest,
  refreshKey = 0,
  onRemainChange,
  routeColors,
}: {
  station: string;
  /** 本库线路码（LRT-氹仔线…）；调用方已按段解析好（effRoute 取 LRT 项） */
  route: string;
  dest?: string | null;
  /** 父级关键打点后递增 → 重新拉取（对齐 LiveEta 刷新节奏） */
  refreshKey?: number;
  /** 下一班剩余毫秒变化回调（TimerWizard 自动写 wait_snapshot 用；null=无下一班） */
  onRemainChange?: (remainMs: number | null) => void;
  /** v0.20.1：线路色（线路名标签取色） */
  routeColors?: Record<string, string>;
}) {
  const [data, setData] = useState<LrtEtaData | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldownSec, setCooldownSec] = useState(0);
  // v0.15.1：秒级读秒渲染节拍（+1 强制以最新 nowMs 重算；石排湾/横琴线「还有 X 分 Y 秒」实时滚动）
  const [, setNowTick] = useState(0);
  const reqId = useRef(0);
  const cooldownUntil = useRef(0);
  const serverOffsetMs = useRef(0);
  const lastReportedRemain = useRef<number | null>(null);

  const fetchEta = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    cooldownUntil.current = Date.now() + 10_000;
    setCooldownSec(10);
    try {
      const qs = new URLSearchParams({ station, route });
      if (dest) qs.set("dest", dest);
      const res = await fetch(`/api/lrt/eta?${qs.toString()}`, { cache: "no-store" });
      const body = (await res.json()) as LrtEtaData;
      if (id !== reqId.current) return;
      if (!res.ok || !body.ok) {
        setData({ ok: false, error: body.error ?? "获取失败", state: "no_data", lineCode: route, directionName: null, dayType: "", serviceDay: "", firstClock: null, lastClock: null, departures: [], serverNow: new Date().toISOString() });
        return;
      }
      serverOffsetMs.current = Date.parse(body.serverNow) - Date.now();
      setData(body);
    } catch {
      if (id === reqId.current) {
        setData({ ok: false, error: "网络异常", state: "no_data", lineCode: route, directionName: null, dayType: "", serviceDay: "", firstClock: null, lastClock: null, departures: [], serverNow: new Date().toISOString() });
      }
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [station, route, dest]);

  // 挂载 / 参数 / 打点刷新
  const prevKey = useRef(refreshKey);
  useEffect(() => {
    fetchEta();
  }, [fetchEta]);
  useEffect(() => {
    if (refreshKey !== prevKey.current) {
      prevKey.current = refreshKey;
      fetchEta();
    }
  }, [refreshKey, fetchEta]);

  // 冷却读秒（与 LiveEta 手感一致）
  useEffect(() => {
    if (cooldownSec <= 0) return;
    const t = setInterval(() => {
      const left = Math.ceil((cooldownUntil.current - Date.now()) / 1000);
      setCooldownSec(left <= 0 ? 0 : left);
    }, 500);
    return () => clearInterval(t);
  }, [cooldownSec]);

  // 本地每秒重算：下一/再下一剩余、跨班滚动、日切重拉、onRemainChange 上报
  useEffect(() => {
    if (!data) return;
    const report = () => {
      const nowMs = Date.now() + serverOffsetMs.current;
      const dep = data.departures;
      if (dep.length === 0) {
        if (lastReportedRemain.current !== null) {
          lastReportedRemain.current = null;
          onRemainChange?.(null);
        }
        return;
      }
      // ★ v3.2.0：与显示同口径 —— 逐线 pre + 逐班 post（闭区间）；窗口内仍返回该班（不提前滚）
      const nxtDep = pickNext(dep, nowMs);
      if (!nxtDep) {
        if (lastReportedRemain.current !== null) {
          lastReportedRemain.current = null;
          onRemainChange?.(null);
        }
        return;
      }
      const remainMs = nxtDep.depMs - nowMs;
      if (remainMs !== lastReportedRemain.current) {
        lastReportedRemain.current = remainMs;
        onRemainChange?.(remainMs);
      }
    };
    report(); // 数据就绪立即上报一次（不等首跳）
    const tick = setInterval(() => {
      const nowMs = Date.now() + serverOffsetMs.current;
      const dep = data.departures;
      const lastDep = dep[dep.length - 1];
      // ★ v3.2.0：末班判据改为「末班 + 该班保持期」——避免 10s 保持期内过早重拉（AC-69）
      if (dep.length > 0 && lastDep.depMs + postOf(isPrecise(lastDep)) - nowMs <= 0) {
        // 末班也已开出（含保持期）→ 重拉（跨日/换班表后旧数据失效）
        fetchEta();
        return;
      }
      // 澳门日切 → 重拉（班别/日期变化）
      if (data.serviceDay && macauYmd(nowMs) !== data.serviceDay) {
        fetchEta();
        return;
      }
      report();
      // v0.15.1：运行中每秒 tick 一次 → 秒级倒计时与「下一班→再下一班」到点滚动即时生效
      if (data.state === "running") setNowTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(tick);
  }, [data, fetchEta, onRemainChange]);

  const manualRefresh = () => {
    if (Date.now() < cooldownUntil.current) return;
    fetchEta();
  };

  // —— 渲染 ——
  const nowMs = data ? Date.now() + serverOffsetMs.current : 0;
  // ★ v3.2.0：逐线 pre（闭区间）；班次选择 = 第一个「窗口尚未结束」的班次（depMs + post(该班) ≥ now）
  const pre = preOf(data?.lineCode || route || "");
  const nxtDep = data ? pickNext(data.departures, nowMs) : null;
  const sndDep = (() => {
    if (!data || !nxtDep) return null;
    const i = data.departures.indexOf(nxtDep);
    return data.departures[i + 1] ?? null;
  })();
  const remainMs = nxtDep ? nxtDep.depMs - nowMs : null;
  /** 该班是否按秒级读秒（缺省 false） */
  const precise = !!nxtDep && isPrecise(nxtDep);
  /** 现正到达 ⇔ `depMs - pre ≤ now ≤ depMs + post(该班)`（闭区间，含边界） */
  const arriving = !!nxtDep && inArrivalWindow(nxtDep, nowMs, pre, postOf(precise));
  /** 归零保持期（已过发车时刻、仍在 post 窗口内）⇒ 数值槽占位不显 */
  const held = arriving && !!nxtDep && nowMs >= nxtDep.depMs;
  /** 无秒可读时（无读秒窗口内 / 有读秒归零期）用有限次脉动提示 */
  const flash = arriving && (!precise || held);
  // floor：60_000ms 整恰好 60s（1 分 0 秒）；<60s 时不会出现「0 分 60 秒」（ceil 陷阱）
  const totalSec = remainMs != null ? Math.max(0, Math.floor(remainMs / 1000)) : null;

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString("zh-CN", {
      timeZone: "Asia/Macau",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  return (
    <div className="card anim-fade-up" style={{ padding: "12px 14px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <p
          className="h-title"
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <Icon name="lrt" size={20} /> 实时到站{" "}
          <RouteStack codes={[route]} colorOf={(c) => routeColors?.[c]} size="sm" />
        </p>
        <button
          className="btn btn--text btn--sm"
          onClick={manualRefresh}
          disabled={loading || cooldownSec > 0}
          aria-label="刷新轻轨到站"
        >
          <span className={loading ? "anim-spin" : ""} style={{ display: "inline-block" }}>
            <Icon name="refresh" size={20} />
          </span>{" "}
          {loading ? "刷新中…" : cooldownSec > 0 ? `${cooldownSec}s` : "刷新"}
        </button>
      </div>

      {!data ? (
        <p className="t-body t-muted">获取中…</p>
      ) : !data.ok ? (
        <p className="t-body t-muted" style={{ lineHeight: 1.7 }}>
          轻轨时刻暂不可用 · {data.error}
        </p>
      ) : data.state !== "running" ? (
        <p className="t-body t-muted" style={{ lineHeight: 1.7, textAlign: "center", marginTop: 4 }}>
          {data.state === "before_first" && data.firstClock
            ? `首班 ${data.firstClock} 开出${data.directionName ? ` · 往${data.directionName}` : ""}`
            : data.state === "after_last" && data.lastClock
              ? `今日已收车 · 末班 ${data.lastClock}`
              : data.state === "before_first"
                ? "尚未开出首班"
                : data.state === "after_last"
                  ? "今日已收车"
                  : "该方向暂无时刻数据"}
        </p>
      ) : !nxtDep ? (
        <p className="t-body t-muted" style={{ lineHeight: 1.7, textAlign: "center", marginTop: 4 }}>
          该方向暂无时刻数据
        </p>
      ) : (
        <div style={{ marginTop: 2 }}>
          {/* ★ v3.2.0（需求 2 / AC-68~70）：**一行式**「现正到达 · X 分 Y 秒」。
              有秒级读秒：窗口内一行 lead + 数值；归零保持期保留 lead、数值槽 `visibility:hidden` 占位
              ⇒ **零布局位移**。无读秒氹仔班次：窗口内大字切「现正到达」（有限次脉动）。 */}
          <p
            className={`t-accent eta-big${flash ? " eta-big--flash" : ""}`}
            style={{ textAlign: "center", margin: "4px 0 0" }}
          >
            {arriving ? (
              precise ? (
                <>
                  <span className="eta-big__lead">现正到达</span>
                  <span className="eta-big__sep" style={held ? { visibility: "hidden" } : undefined}>
                    ·
                  </span>
                  <span
                    className="eta-big__num"
                    style={held ? { visibility: "hidden" } : undefined}
                  >
                    {secText(totalSec ?? 0)}
                  </span>
                </>
              ) : (
                "现正到达"
              )
            ) : precise ? (
              <span className="eta-big__num">还有 {secText(totalSec ?? 0)}</span>
            ) : (
              `下一班 ${Math.max(0, Math.floor((remainMs ?? 0) / 60_000))} 分钟`
            )}
          </p>
          {/* 副行：方向 + 绝对时刻 */}
          <p
            className="t-label t-muted"
            style={{ textAlign: "center", lineHeight: 1.5, marginTop: 2 }}
          >
            {/* ★ v3.3.0（AC-103）：方向文案统一为「{終點}方向」（改前为「往{終點}」） */}
            {data.directionName ? `${data.directionName}方向 · ` : ""}
            {nxtDep.clock} 开出
          </p>
          {/* 再下一班 */}
          {sndDep && (
            <p
              className="t-label t-muted"
              style={{ textAlign: "center", lineHeight: 1.5, marginTop: 4 }}
            >
              再下一班{" "}
              {Math.max(0, Math.floor((sndDep.depMs - nowMs) / 60_000))} 分钟 · {sndDep.clock}
            </p>
          )}
        </div>
      )}

      {data?.ok && data.serverNow && (
        <p className="t-label t-muted" style={{ marginTop: 8 }}>
          更新于 {fmtTime(data.serverNow)} · 时刻表来源 澳門輕軌
        </p>
      )}
      {/* ★ v3.2.0（AC-66 · 合规备注）：完整句 · 小字 · 不换行（站台卡；紧凑处见 `LrtEtaInline` 的「推算」角标） */}
      {data?.ok && (
        <p className="eta-note">报时数据通过澳门轻轨时刻表推算，仅供参考，请以实际为准</p>
      )}
    </div>
  );
}

/**
 * ★ v1.0.0 自动选线专用：**内联轻轨报时**（不自取数据、零网络）。
 *
 * 与上方 `LrtEta` 的差别只有一个 —— 数据来源：
 *   · `LrtEta`：自己 fetch `/api/lrt/eta`（计时页用，可手动刷新）
 *   · 本组件：直接消费**服务端算好并随卡片下发的** `departuresMs` / `clocks`
 *     （`RideLegView.liveDepartures` / `liveClocks`）→ SSR 出卡后不再有任何请求；
 *     客户端只做每秒本地读秒，滚动到下一班也是纯本地（同数据）。
 *
 * 口径与 `LrtEta` **完全一致**（★ v3.2.0 起）：复用同一套 `pickNext` / `preOf` / `postOf` 窗口与
 * 「现正到达 · X 分 Y 秒」/「还有 X 分 Y 秒」/「下一班 X 分钟」文案策略 ——
 * 只是不显示卡片外壳与刷新按钮；紧凑处（AC-66）以「推算」小角标替代完整备注句。
 */
export function LrtEtaInline({
  lineCode,
  departuresMs,
  clocks,
  precise,
  state,
  directionName,
  neighbors,
  mainMs,
  tierCtx,
}: {
  /** 本库线路码（决定 `pre`：氹仔 0:30 / 石排湾 2:00 / 横琴 1:00） */
  lineCode: string;
  departuresMs?: number[];
  clocks?: string[];
  /** ★ v3.2.0（AC-68/69）：逐班 `secPrecise`（来自 `RideLegView.livePrecise`，与 `departuresMs` 一一对应） */
  precise?: boolean[];
  state?: "running" | "before_first" | "after_last" | "no_data";
  directionName?: string | null;
  /**
   * ★ 2026-09-27（用户需求 2/4）：邻班区模式——
   *   `"expanded"`：直接列出「前一班（如有）/ 后一班」；`"collapsed"`：默认折叠、点击展开；
   *   缺省 = 不渲染邻班区。邻班 = 主班在 `departuresMs` 中的前/后一项（前班须未发车）。
   */
  neighbors?: "expanded" | "collapsed";
  /**
   * ★ 2026-09-27（用户需求 2）：**主班时刻（ms）**（`RideLegView.liveMainMs`）——
   *   `liveDepartures` 内早于它的项 = 「前一班」；缺省时退回「数组首项」旧行为。
   */
  mainMs?: number;
  /**
   * ★ 2026-09-27（用户需求 2）：邻班「怎样走才能赶上」的档位上下文——
   *   有值时每班附 `TierBadge`（档位 = `pickCatchTier(walkMin, 该班剩余秒, walkDistM)`；
   *   全档不可及 → 「赶不上」）。`walkMin` = 到上车站的步行分钟（卡级 `walkOut.minutes`）。
   *   ★ v3.9.0（需求 3 拍板 C）：恢复 S4 删掉的徽章渲染（本组件消费方全为方案卡场景）。
   */
  tierCtx?: { walkMin: number; walkDistM?: number | null };
}) {
  const [, tick] = useState(0);
  /**
   * ★ v1.0.6：挂载门控。
   * 本组件在 render 期直接读 `Date.now()` —— 服务端渲染时读到的是**服务器时间**，
   * 客户端接管时读到的是**手机时间**，两者差 1~2 秒 → 文本必然对不上（水合告警 + 闪字）。
   * 挂载前统一渲染占位符，挂载后再交给每秒 tick 的真实读数。
   * 这不影响「每秒重算」这条口径 —— 只是把**首帧**让给占位符。
   */
  const [mounted, setMounted] = useState(false);
  /** ★ 2026-09-27（用户需求 4）：折叠式邻班区开合（默认收起） */
  const [openN, setOpenN] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const dep: LrtDeparture[] = (departuresMs ?? []).map((ms, i) => ({
    depMs: ms,
    clock: clocks?.[i] ?? "",
    secPrecise: precise?.[i] === true,
  }));

  if (state && state !== "running") {
    return (
      <span className="rc-live rc-live--dim">
        {state === "before_first" ? "首班前" : state === "after_last" ? "今日已收车" : "暂无时刻"}
      </span>
    );
  }
  if (!dep.length) return <span className="rc-live rc-live--dim">暂无时刻</span>;
  if (!mounted) return <span className="rc-live rc-live--dim">—</span>;

  const nowMs = Date.now();
  const pre = preOf(lineCode);
  // ★ 2026-09-27（用户需求 2）：主班定位改用 `mainMs`（模型选中那班）——
  //   数组首项现含「前班」（可能赶不上/已发），不能再以「首个未发车」当主班；
  //   主班发车后自动滚向后续班次（`slice(maIdx)` 内找首个未发车）。
  const maIdxRaw = mainMs != null ? dep.findIndex((d) => d.depMs === mainMs) : -1;
  const maIdx = maIdxRaw >= 0 ? maIdxRaw : 0;
  const nxt = dep.slice(maIdx).find((d) => d.depMs > nowMs) ?? null;
  // ★ v3.2.0：窗口内 = 「现正到达」；整日无后续班次 → 今日已收车
  if (!nxt) return <span className="rc-live rc-live--dim">今日已收车</span>;
  const remainMs = nxt.depMs - nowMs;
  const precise0 = isPrecise(nxt);
  const arriving = inArrivalWindow(nxt, nowMs, pre, postOf(precise0));
  const held = arriving && nowMs >= nxt.depMs;
  const totalSec = Math.max(0, Math.floor(remainMs / 1000));
  // ★ 2026-09-27（用户需求 2）：邻班 = 主班在班次数组中的前/后一项（前班须**未发车**才显示）
  const idx = dep.findIndex((d) => d.depMs === nxt.depMs);
  const prevDep = idx > 0 ? dep[idx - 1] : null;
  // ★ 2026-09-27（用户需求 2）：前班**一律显示**（含「要提速才赶得上」与「刚已发车」两类——
  //   用户明确「赶不上的前班车也允许显示」）；仅「主班已是数组首项」时才省略。
  const prevOk = !!prevDep;
  const nextDep = idx >= 0 && idx + 1 < dep.length ? dep[idx + 1] : null;
  const hasNeighbors = prevOk || !!nextDep;
  /** 单行邻班（★ 需求 3：实时读秒；已发车照常显示；档位标签或「赶不上」） */
  const neighborRow = (label: string, d: LrtDeparture) => {
    const remainSec = Math.floor((d.depMs - nowMs) / 1000);
    const gone = remainSec <= 0;
    const tier =
      tierCtx && !gone ? pickCatchTier(tierCtx.walkMin, remainSec, tierCtx.walkDistM ?? null) : null;
    return (
      <span className="rc-neighbor" key={d.depMs}>
        <span className="rc-neighbor__when">
          {label} ·{" "}
          {gone ? (
            "已发车"
          ) : d.secPrecise ? (
            <>还有 {secText(remainSec)}</>
          ) : remainSec < 60 ? (
            "即将"
          ) : (
            `${Math.floor(remainSec / 60)} 分钟`
          )}
        </span>
        {/*
          ★ v3.9.0（需求 3 拍板 C）：恢复邻班「怎样走才能赶上」档位徽章（S4 删除）。
          本组件的 tierCtx 消费方**全部是方案卡场景**（推荐卡/导航详情/计卡详情）；
          导航站条（NavStrip）不传 tierCtx ⇒ 恢复不影响站条/到站后的隐藏口径。
          ⚠️ 「赶不上」**保留**：它绑的是该班**真实开出时刻** + 步行所需时间，
          属于「时间提示」，不是速度档文案。判据：`tier === null` = 连冲刺都赶不上。
        */}
        {tierCtx &&
          !gone &&
          (tier ? (
            <TierBadge tier={tier} tierText={TIER_TEXT[tier as CatchTier]} />
          ) : (
            <span className="rc-neighbor__miss">赶不上</span>
          ))}
      </span>
    );
  };
  return (
    <span className="rc-live">
      {/* ★ 2026-09-27（用户需求 5）：主行独立（角标同主行）；「方向 · 开出时刻」另起小字行 */}
      <span className="rc-live__main">
        {arriving ? (
          precise0 ? (
            <>
              <span className="rc-live__lead">现正到达</span>
              {" · "}
              <span
                className="rc-live__time"
                style={held ? { visibility: "hidden" } : undefined}
              >
                {secText(totalSec)}
              </span>
            </>
          ) : (
            "现正到达"
          )
        ) : precise0 ? (
          <>
            还有 <span className="rc-live__time">{secText(totalSec)}</span>
          </>
        ) : (
          `下一班 ${Math.max(0, Math.floor(remainMs / 60_000))} 分钟`
        )}
        {/* ★ v3.2.0（AC-66）：紧凑处「推算」小角标（灰 = 系统推算，与实色读数区分） */}
        <span className="rc-est-badge">推算</span>
      </span>
      <span className="rc-live__sub">
        {/* ★ v3.3.0（AC-103）：方向文案统一为「{終點}方向」；空值整段省略（不留 `·`） */}
        {directionName ? `${directionName.endsWith("方向") ? directionName : `${directionName}方向`} · ` : ""}
        {nxt.clock} 开出
      </span>
      {/* ★ 2026-09-27（用户需求 2/4）：邻班区 —— 推荐卡=展开；导航=默认折叠、点击展开 */}
      {neighbors === "expanded" && hasNeighbors && (
        <span className="rc-neighbors">
          {prevOk && neighborRow("前一班", prevDep!)}
          {nextDep && neighborRow("后一班", nextDep)}
        </span>
      )}
      {neighbors === "collapsed" && hasNeighbors && (
        <span className="rc-neighbors rc-neighbors--fold">
          <button
            type="button"
            className="rc-neighbors__toggle"
            onClick={() => setOpenN((v) => !v)}
            aria-expanded={openN}
          >
            前后班次
            <span className={`rc-neighbors__caret${openN ? " is-open" : ""}`} aria-hidden="true">
              <Icon name="caretDown" size={16} />
            </span>
          </button>
          {openN && (
            <span className="rc-neighbors__list">
              {prevOk && neighborRow("前一班", prevDep!)}
              {nextDep && neighborRow("后一班", nextDep)}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
