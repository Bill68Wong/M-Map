"use client";

/**
 * 公共交通路线弹窗 · 双板块（src/components/nav/RouteLinesSheet.tsx，2026-11-05 改版）
 *
 * ── 形态（Spec R1 / `03-UIUX.md` §3）────────────────────────────────────
 *   ```
 *   .rl-sheet                       position:fixed; inset:0; flex column（全屏，非独立页）
 *     ├─ .rl-sheet__bar             flex:none ⇒ 顶部天然固定
 *     │    ├─ .rl-tabs              44 高（36 段 + 4 内距）/ 两段等宽 / bg --surface-2
 *     │    │    ├─ tab[data-board=bus]  「澳门公共交通路线」（≤359px 降级「澳门路线」）
 *     │    │    └─ tab[data-board=tqh]  「通琴号」
 *     │    └─ .rl-sheet__close      视觉 34 / 命中 44（::after inset:-5px）
 *     └─ .rl-sheet__panes           flex:1; min-height:0; position:relative
 *          ├─ .rl-pane--bus   absolute inset:0（澳门：3 轻轨 + 97 巴士 / **8 列**）
 *          └─ .rl-pane--tqh   absolute inset:0（通琴号：7 列 35 标号 + 班次卡）
 *   ```
 *
 * ── 「零延迟」的具体定义（AC-1）────────────────────────────────────────
 *   ① **两板常驻 DOM**，只切 `aria-hidden` / `visibility` / `pointer-events` / `inert`；
 *      **禁止 `display:none`**（会重置 scrollTop）、**禁止条件渲染 / `key` 重建**；
 *   ② 打开时**并行预取** `/api/route-lines` 与 `/api/tqh/lines` ⇒ 切板块 **0 请求**。
 *
 * ── 配色（负责人裁决）──────────────────────────────────────────────────
 *   · 澳门段选中：`--brand-green` #0b6e4f + 白字（6.25:1）——**不动 `--accent`**（青花蓝）；
 *   · 通琴号段选中：`--tqh-accent` #ff58a6 + `--tqh-on` 白字（2.92:1，登记已知偏差，
 *     补偿只有「700 字重 + 既有 text-shadow」两种）；
 *   · 带文字的面**不得**用换色表达 hover / 按压（白字静止态已是最差一档）⇒ 走状态层。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "@/components/ui/Icon";
import { errorTextOf } from "@/lib/ui/error-text";
import TqhBoard from "./TqhBoard";
import { useTqhLines } from "./tqh-lines";
import type { TqhTrip } from "./tqh-model";

export interface RouteLineItem {
  code: string;
  kind: "bus" | "lrt";
  /** 展示文字（轻轨已去 `LRT-` 前缀） */
  label: string;
  color: string;
}

export type Board = "bus" | "tqh";

export interface RouteLinesSheetProps {
  onPick: (line: RouteLineItem) => void;
  /** 点通琴号班次卡（宿主：关弹窗 → 地图画该班次路径 + 开站点弹窗） */
  onPickTrip?: (trip: TqhTrip) => void;
  onClose: () => void;
  /** 首屏板块（缺省澳门，需求指定） */
  defaultBoard?: Board;
  /** 地图上正在查看的通琴号班次（卡片高亮；不传则不高亮） */
  activeTripCode?: string | null;
}

export default function RouteLinesSheet({
  onPick,
  onPickTrip,
  onClose,
  defaultBoard = "bus",
  activeTripCode = null,
}: RouteLinesSheetProps) {
  const [board, setBoard] = useState<Board>(defaultBoard);
  const [lines, setLines] = useState<RouteLineItem[] | null>(null);
  const [err, setErr] = useState("");
  /** 通琴号板块选中标号（null = 未选 ⇒ 下方留白） */
  const [routeNo, setRouteNo] = useState<string | null>(null);

  /* ── 澳门板块：/api/route-lines（与通琴号**并行**预取，切板块 0 请求）── */
  useEffect(() => {
    let alive = true;
    /**
     * ★ 不传 `cache: "force-cache"`：服务端已下发 `max-age` + `s-maxage`，
     *   再叠一层强制缓存会造成「两层缓存各管一段」，发版后拿不到新线路清单（09-21 事故）。
     */
    fetch("/api/route-lines")
      .then((r) => r.json())
      .then((j: { lines?: RouteLineItem[]; error?: string }) => {
        if (!alive) return;
        const list = Array.isArray(j.lines) ? j.lines : [];
        // 有 error 但清单非空（部分降级）⇒ 不报错，照常展示
        if (j.error && list.length === 0) setErr(errorTextOf(j.error));
        setLines(list);
      })
      .catch(() => {
        if (!alive) return;
        setErr("线路清单加载失败");
        setLines([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  /* ── 通琴号板块：模块级单飞缓存，首帧直接出内容 ── */
  const tqh = useTqhLines();

  const lrt = useMemo(() => (lines ?? []).filter((l) => l.kind === "lrt"), [lines]);
  const bus = useMemo(() => (lines ?? []).filter((l) => l.kind !== "lrt"), [lines]);

  const pickTrip = useCallback(
    (t: TqhTrip) => {
      onPickTrip?.(t);
    },
    [onPickTrip],
  );

  return (
    <div className="rl-sheet" role="dialog" aria-modal="true" aria-label="公共交通路线">
      <div className="rl-sheet__bar">
        {/* ★ 顶栏在滚动容器之外 + flex:none ⇒ 天然「固定不随内容滚动」，不需要 sticky */}
        <div className="rl-tabs" role="tablist" aria-label="交通方式">
          <button
            type="button"
            role="tab"
            className="rl-tab"
            data-board="bus"
            aria-selected={board === "bus"}
            aria-controls="rl-pane-bus"
            onClick={() => setBoard("bus")}
          >
            <span className="rl-tab__long">澳门公共交通路线</span>
            {/* ≤359px 屏降级（全称 116px > 段宽 114px），aria-label 保留全称 */}
            <span className="rl-tab__short" aria-hidden="true">
              澳门路线
            </span>
          </button>
          <button
            type="button"
            role="tab"
            className="rl-tab"
            data-board="tqh"
            aria-selected={board === "tqh"}
            aria-controls="rl-pane-tqh"
            onClick={() => setBoard("tqh")}
          >
            通琴号
          </button>
        </div>
        <button type="button" className="rl-sheet__close" onClick={onClose} aria-label="关闭">
          <Icon name="close" size={20} />
        </button>
      </div>

      <div className="rl-sheet__panes">
        {/* ── 澳门板（8 列；两板常驻，只切可见性）── */}
        <div
          id="rl-pane-bus"
          className="rl-pane rl-pane--bus"
          data-board="bus"
          aria-hidden={board !== "bus"}
          inert={board !== "bus" ? true : undefined}
        >
          {err && <p className="rl-sheet__hint t-label">{err}</p>}
          {!lines && <p className="rl-sheet__hint t-label">载入中…</p>}

          {lines && (
            <>
              {/* 轻轨第一行：3 张较宽卡片（固定顺序由接口给） */}
              <div className="rl-board rl-board--lrt">
                {lrt.map((l) => (
                  <button
                    key={l.code}
                    type="button"
                    className="rl-chip rl-chip--lrt"
                    style={{ background: l.color }}
                    onClick={() => onPick(l)}
                    title={l.label}
                  >
                    {l.label}
                  </button>
                ))}
              </div>

              {/* 巴士：**8 列**（负责人 §17-R2 裁决；390px 下格宽 40.5px，12 行 572px 一屏放下） */}
              <div className="rl-board rl-board--bus" data-board-grid="bus">
                {bus.map((l) => (
                  <button
                    key={l.code}
                    type="button"
                    className="rl-chip rl-chip--board"
                    style={{ background: l.color }}
                    /* 4 字符标号（`25AX` / `701X`）降一档字号，避免 320/360 屏贴边 */
                    data-long={l.label.length >= 4 ? "1" : undefined}
                    onClick={() => onPick(l)}
                    title={l.code}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* ── 通琴号板（7 列 35 标号 + 班次卡；同样常驻）── */}
        <TqhBoard
          hidden={board !== "tqh"}
          trips={tqh.data.trips}
          phase={tqh.phase}
          error={tqh.error}
          selected={routeNo}
          activeTripCode={activeTripCode}
          onSelect={(no) => setRouteNo((cur) => (cur === no ? null : no))}
          onPickTrip={pickTrip}
          onRetry={tqh.reload}
        />
      </div>
    </div>
  );
}
