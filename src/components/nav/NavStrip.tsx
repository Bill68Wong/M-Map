"use client";

/**
 * 进度纵条（src/components/nav/NavStrip.tsx，2026-09-25 · v2.14 · 06 §2.2 / 07 §4.2）
 *
 * ── 与卡片页旧站条的边界（已作废，仅留档）─────────────────────────────
 *   卡片页站条 `@/components/card/StationStrip` 已随 v3.6.0 删除（目录都不存在了）；
 *   纵轴**逐站分钟**已随需求 7（2026-11-09）整块删除。**导航侧**用本组件：
 *   · 导航中**强制展开**（逐站可见，无收起键）；静态（`nav=null`）保留折叠键；
 *   · **四态新口径**（AC-07，不只靠颜色）：
 *       已过 = 灰 + 行末对勾；当前停靠 = 蓝加粗 + 「停靠中」；
 *       下一站 = 蓝加粗 + 「下一站」胶囊；下车站 = **站名品牌绿**（圆点仍线路色）+「下车」；
 *       到站 = 砖红加粗 + 脉动；
 *   · **用户点（★ 本批改造，AC-43/44）**：**删除「您在这里」整行**；改为
 *     `youAt = { afterIdx, frac }` 驱动 —— 停靠中 ⇒ `is-at` 节点即用户点（纯 CSS）；
 *     行驶中 ⇒ `.navstrip__youmark` 骑线浮标（`--you-frac` 段内插值）。
 *
 * ── 排版纪律（06 §4.5）────────────────────────────────────────────────
 *   同一信息不折行（nowrap）、禁省略号截断。
 */
import { Fragment, useState } from "react";
import RouteStack from "@/components/RouteStack";
import { dirTextOf } from "@/components/RoutePieces";
import { LrtEtaInline } from "@/components/LrtEta";
import Icon from "@/components/ui/Icon";
import type { SegmentStrip } from "@/lib/recommend/types";

/** 导航追踪态（null = 静态展示） */
export interface StripNav {
  /** 已**完全驶过**的最后一站下标（-1 = 一站未过） */
  passedIdx: number;
  /** 下一站下标（null = 未知） */
  nextIdx: number | null;
  /** 当前停靠站下标（null = 行驶中或未知） */
  atIdx: number | null;
  /** 下车提醒级别：none / soon（下一站是下车站）/ now（已到下车站） */
  alarm: "none" | "soon" | "now";
  /**
   * ★ v3.2.0（需求 6 / AC-78）：**二值 + 驻留用户点**。
   *   `frac = 0` ⇒ 点贴 `afterIdx` 站节点（停靠中）；`frac = 0.5` ⇒ 锁 `afterIdx → afterIdx+1`
   *   **两站正中间**并驻留（行驶中，不随进度微动）。`afterIdx = -1` ⇒ 尚未到上车站。`null` ⇒ 不显示。
   */
  youAt?: { afterIdx: number; frac: number } | null;
  /** ★ 本批：观测钩子 `data-nav-leg` 取值（当前乘车段下标，由宿主透传） */
  legIndex?: number;
}

/**
 * ★ 本批（需求⑦ / AC-49/61）：换乘行「等车约 N 分」—— `TransferView.waitMin`（后端 `model.ts` 落地）；
 *   暂缺（`null` / `undefined`）⇒ **降级文案**「等车时长待确认」（不得拍脑袋设默认值）。
 */

export default function NavStrip({
  strip,
  color,
  last,
  nav = null,
  frozen = false,
  nextKind = null,
}: {
  strip: SegmentStrip;
  /** 该线路主题色 */
  color?: string | null;
  /** 是否为行程最后一段（决定换乘行是否渲染） */
  last?: boolean;
  /** 导航追踪态（仅当前乘车段传入） */
  nav?: StripNav | null;
  /** 冻结态（丢信号：「位置停在上一站」；标签转 muted、停止脉动） */
  frozen?: boolean;
  /** ★ 本批：下一段载具种类（换乘行「等车」来源徽标用：轻轨=按时刻表 / 巴士=按班距估） */
  nextKind?: "bus" | "lrt" | null;
}) {
  const [openManual, setOpenManual] = useState(false);
  const open = openManual || !!nav;
  const rail = color ?? "var(--accent)";
  const stops = strip.stops;
  /**
   * ★ v3.3.0（AC-102）：上车站行标签 = **实际可乘的那班**（四规则；服务端派生 `boardRoute`）。
   *   ①② 主干能赶 → 主干；赶不上 → `altBuses` 最早可赶并行线（**均已在服务端判定**）；
   *   ③④ `boardRoute` 缺失 / 无法判定 → **回落主干**（`strip.route`）⇒ **不会显错线**。
   */
  const boardRoute = strip.boardRoute ?? strip.route;
  /** ★ v3.3.0（AC-103）：轻轨段方向（`{終點}方向`）；空值 ⇒ 不渲染（巴士段 `dirLabel = null`） */
  const dirText = dirTextOf(strip.dirLabel);
  const lastK = stops.length - 1;
  const mids = stops.filter((s) => s.role === "mid").length;
  const board = stops[0];
  const alight = stops[stops.length - 1];
  /**
   * ⚠️ 2026-11-09（需求 7）：`level` 在**本组件里只剩这一处消费** —— 折叠键「车上约 X 分」
   *   的 `rc-val--est` 标注（渲染见下方 `est ? "rc-val--est" : undefined`）。
   *   `stops[].level` 与已删除的逐站「x 分」**同源同一字段**，删完逐站标签后它看起来像孤儿，
   *   ⇒ **勿随逐站标签一并清理**（删掉不会红任何断言，只会静默丢掉「这是估算值」的标记）。
   */
  const est = stops.some((s) => s.role === "mid" && s.level >= 3);
  /*
   * ★ 2026-11-06（P0 · 删导航冗余行）：**原 `rideText` / `passedCount` 已随「车上约 N 分 · 已过 n 站」
   *   整行删除**（负责人明确：不做替代文案、不区分模式）。
   *
   *   ── 为什么删（不要照旧稿加回来）────────────────────────────────────
   *   该行与**紧邻的站行**重复表达同一件事，且在导航态（`open` 强制 true）里永远显示 ⇒
   *   变成一条恒定噪音：`已过 n 站` 是站行本色的复述（`is-passed` 已用灰 + 对勾表达），
   *   `车上约 N 分` 是折叠键上已有的信息（见下方 `rc-strip__toggle` —— **那一条保留**）。
   *   ⚠️ 折叠键的「途经 N 站 · 车上约 X 分」**不属于本行**，不要顺手删。
   *
   *   `SegmentStrip.rideMin` / `rideSecText` 仍是折叠键与详情层的输入，未被移除。
   */

  /** 追踪态 class（附在各站节点上） */
  const stateCls = (k: number): string => {
    if (!nav) return "";
    if (k === lastK) return nav.alarm === "now" ? " is-alight-now" : " is-alight";
    if (nav.atIdx !== null && k === nav.atIdx) return " is-at";
    if (k <= nav.passedIdx) return " is-passed";
    if (nav.nextIdx !== null && k === nav.nextIdx) return " is-next";
    return "";
  };

  /** 换乘行（本批：披露「等车约 N 分」；数据缺失 ⇒ 降级标注） */
  const transfer = strip.transferAfter;
  const waitMin = transfer?.waitMin ?? null;
  const waitSrc = waitMin != null ? (nextKind === "lrt" ? "按时刻表" : "按班距估") : null;

  const row = (k: number, end: boolean) => {
    const s = stops[k];
    const cls = `navstrip__row${end ? " is-end" : ""}${stateCls(k)}`;
    const segPassed = !!nav && k <= nav.passedIdx;
    const isAt = !!nav && nav.atIdx !== null && k === nav.atIdx;
    const isAlightNow = !!nav && k === lastK && nav.alarm === "now";
    const isAlight = !!nav && k === lastK && nav.alarm !== "now";
    const isNext = !!nav && nav.nextIdx !== null && k === nav.nextIdx && k !== lastK;
    const passed = !!nav && k <= nav.passedIdx && !isAt && !isAlight && !isAlightNow;
    return (
      <div className={cls} key={`s-${k}`}>
        <span className={`navstrip__seg${segPassed ? " is-passed" : ""}`} />
        <span className="navstrip__dot" />
        <span className="navstrip__label">
          {k === 0 && <RouteStack codes={[boardRoute]} colorOf={() => rail} />}
          {isNext && <span className="navstrip__badge">下一站</span>}
          {k === lastK ? <b>{s.label}</b> : s.label}
          {isAt && <span className="navstrip__sub">停靠中</span>}
          {k === lastK && isAlightNow && <span className="navstrip__sub">到站</span>}
          {k === lastK && isAlight && <span className="navstrip__sub">下车</span>}
          {/* ★ v3.3.0（AC-103）：轻轨方向上车站行右侧（`margin-left:auto` 右对齐，不与站名抢位） */}
          {k === 0 && dirText && <span className="navstrip__dir">{dirText}</span>}
          {/*
           * ★ 2026-11-09（需求 7 · 负责人裁定）：**逐站「x 分」整块已删除**（含「—」兜底占位），
           *   不论追踪态还是静态一律不显示（理由：高德、谷歌都不显示这种逐站耗时）。
           *   ── 删的是展示，不是数据（不要连坐删字段）────────────────────────
           *   `SegmentStrip.stops[].minToNext` / `minToNextEst` / `level` 三个字段仍然下发且仍被消费：
           *     · 顶部「还有 n 站下车 · 约 x 分」← `NavDetailBody` 用 `minToNextEst` 累加；
           *     · 折叠键「途经 N 站 · 车上约 X 分」← `strip.rideMin` / `rideSecText`；
           *     · 折叠键的「估算」标记 ← 本行以上 `est`（读 `stops[].level`）。
           *   ⚠️ 不要为了「补回信息密度」把它加回来；也不要改成 `display:none` 的假隐藏。
           */}
        </span>
        {passed && (
          <span className="navstrip__check" aria-hidden="true">
            <Icon name="check" size={16} />
          </span>
        )}
        {/* ★ v3.2.0：行驶中骑线浮标（挂在 row(afterIdx) 内；--you-frac 由 JS 写 **0（停靠）或 0.5（行驶中点）**）。
            停靠中（atIdx !== null）由 CSS 复用 is-at 节点，不渲染本浮标。 */}
        {nav && nav.youAt && nav.atIdx === null && nav.youAt.afterIdx === k && (
          <span
            className="navstrip__youmark"
            style={{ ["--you-frac" as string]: String(nav.youAt.frac) }}
            aria-hidden="true"
          />
        )}
      </div>
    );
  };

  return (
    <div
      className={`navstrip${frozen ? " is-frozen" : ""}`}
      style={{ ["--strip-color" as string]: rail }}
      /* ★ 本批：观测钩子 H5 —— 仅当前乘车段（有 nav）写 data-nav-leg */
      data-nav-leg={nav && nav.legIndex != null ? String(nav.legIndex) : undefined}
    >
      {/* ★ 2026-11-06：原「车上约 N 分 · 已过 n 站」整行已按负责人要求删除（见上方 `est` 后的注释） */}

      {board && row(0, true)}      {/* 中间站：静态时默认收起；导航中强制展开 */}
      {mids > 0 && !open && (
        <button className="rc-strip__toggle" onClick={() => setOpenManual(true)} aria-expanded={false}>
          途经 <b>{mids}</b> 站 · 车上约{" "}
          <b className={est ? "rc-val--est" : undefined}>
            {strip.kind === "lrt" && strip.rideSecText ? strip.rideSecText : `${Math.round(strip.rideMin)} 分`}
          </b>
          <span className="rc-strip__caret">
            <Icon name="caretDown" size={16} />
          </span>
        </button>
      )}

      {mids > 0 &&
        open &&
        stops.map((s, k) =>
          s.role !== "mid" ? null : (
            <Fragment key={`m-${s.code}-${k}`}>{row(k, false)}</Fragment>
          ),
        )}

      {mids > 0 && open && !nav && (
        <button className="rc-strip__toggle rc-strip__toggle--collapse" onClick={() => setOpenManual(false)}>
          收起中间站{" "}
          <span className="rc-strip__caret">
            <Icon name="caretUp" size={16} />
          </span>
        </button>
      )}

      {alight && row(lastK, true)}

      {!last && transfer && (
        <div className="rc-strip__transfer">
          <Icon name="expandVertical" size={16} />
          {transfer.sameField ? (
            <>同站台换乘 · 无需步行</>
          ) : (
            <>
              换乘 {transfer.atLabel} · 步行{" "}
              <b className={transfer.estimated ? "rc-val--est" : undefined}>{transfer.minutes}</b> 分
              {" · "}
              {waitMin != null ? (
                <>
                  等车约 <b className="rc-strip__wait-n">{Math.round(waitMin)}</b> 分
                </>
              ) : (
                <span className="rc-strip__wait-none">等车时长待确认</span>
              )}
              {waitSrc && <span className="nav-actions__src">{waitSrc}</span>}
            </>
          )}
        </div>
      )}

      {/* ★ 2026-09-27（用户需求 3）：换乘处 —— 换乘后线路的班次报时（折叠式邻班，点击展开） */}
      {!last && transfer && strip.nextLeg && (
        <div className="navstrip__xfer">
          <span className="navstrip__xfer-line">
            换乘后
            <RouteStack codes={[strip.nextLeg.route]} colorOf={() => rail} />
          </span>
          <LrtEtaInline
            lineCode={strip.nextLeg.route}
            departuresMs={strip.nextLeg.liveDepartures}
            clocks={strip.nextLeg.liveClocks}
            precise={strip.nextLeg.livePrecise}
            state="running"
            directionName={strip.nextLeg.dirLabel}
            neighbors="collapsed"
            mainMs={strip.nextLeg.mainMs}
          />
        </div>
      )}
    </div>
  );
}
