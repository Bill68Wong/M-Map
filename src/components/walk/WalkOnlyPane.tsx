"use client";

/**
 * 独立步行导航面板（src/components/walk/WalkOnlyPane.tsx，2026-11-12 · P1-b）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 *   `too_close`（起点与目的地过近）的结论是「建议直接步行」，但当时没有任何公交方案
 *   ⇒ 方案里的 `walkSeg = "out" | "in"` 两段步行都不存在 ⇒ **现有步行状态机无从触发**。
 *   用户被劝去走路，却点不到任何步行导航，流程就断在这里。
 *
 * ── 与现有步行链路的关系（刻意不复用状态机）────────────────────────────
 *   · **复用**：`useWalkRoute`（取几何，宿主调用）、`WalkStepList`（步骤渲染，经 `WalkPane`）；
 *   · **不复用**：`useWalkFollow`。它已有一份实例绑在 NavShell 的 ride 状态机上
 *     （boarding / riding / 自动推进），在 main 上再挂第二份会与既有实例抢同一批 effect；
 *     完整跟随 + 语音属 `feat/walk-follow-local` 分支的在研范围，等合流后统一。
 *   ⇒ 本面板是**静态分步**：地图画全量折线 + 步骤列表 + 手动上一步/下一步。
 *
 * ── 显示口径 ───────────────────────────────────────────────────────────
 *   · 剩余米 = 全线总长 − 当前步起点累计（`cumStartM`），与 `WalkPane` 同源；
 *   · 到达（`currentIdx >= steps.length`）⇒ 传 `arrived` 让步骤列表淡出，只留横幅；
 *   · 取数失败 ⇒ 只给「直线距离 + 固定步速估算 + 重试」，**绝不编造分步**（沿用
 *     `useWalkRoute.ts` 文件头的「绝不猜测」纪律）。
 */
import Icon from "@/components/ui/Icon";
import WalkPane from "./WalkPane";
import { useEffect, useState } from "react";
import type { WalkStep } from "@/lib/walk/walk-shared";
import type { WalkPhase } from "./useWalkRoute";

export interface WalkOnlyPaneProps {
  /** 目的地展示名（面板头一行） */
  destLabel: string;
  phase: WalkPhase;
  steps: WalkStep[];
  /** 全线几何总长（米） */
  totalDistM: number;
  /** 预计总时长（秒） */
  totalDurationS: number;
  /** `phase === "failed"` 时的可上屏原因 */
  err: string;
  onRetry: () => void;
  onClose: () => void;
}

export default function WalkOnlyPane({
  destLabel,
  phase,
  steps,
  totalDistM,
  totalDurationS,
  err,
  onRetry,
  onClose,
}: WalkOnlyPaneProps) {
  // 手动步进索引：0 = 站在起点。到达后允许等于 steps.length（供 `arrived` 判定）
  const [currentIdx, setCurrentIdx] = useState(0);
  const [showAll, setShowAll] = useState(false);

  // 换目的地（OD 变化）⇒ 索引归零，避免沿用到上一条路线的第 N 步
  const firstCum = steps[0]?.cumStartM ?? 0;
  useEffect(() => {
    setCurrentIdx(0);
    setShowAll(false);
  }, [destLabel, firstCum]);

  const cur = steps[Math.min(currentIdx, Math.max(0, steps.length - 1))];
  const remainM = Math.max(0, totalDistM - (cur?.cumStartM ?? 0));
  const arrived = phase === "ready" && steps.length > 0 && currentIdx >= steps.length;
  const minutes = Math.max(1, Math.round(totalDurationS / 60));

  return (
    <div className="walkonly">
      <div className="walkonly__head">
        <div style={{ minWidth: 0 }}>
          <p className="t-label t-muted" style={{ margin: 0 }}>
            步行前往
          </p>
          <p className="h-title" style={{ margin: "2px 0 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {destLabel}
          </p>
          {phase === "ready" && steps.length > 0 ? (
            <p className="t-label t-muted" style={{ margin: "4px 0 0" }}>
              全程 <b>{Math.round(totalDistM)}</b> 米 · 约 <b>{minutes}</b> 分钟
            </p>
          ) : null}
        </div>
        <button type="button" className="btn btn--text btn--sm" onClick={onClose} aria-label="结束步行导航">
          <Icon name="close" size={20} />
        </button>
      </div>

      {phase === "loading" || phase === "idle" ? (
        <p className="t-body t-muted" style={{ padding: "8px 0" }}>
          正在获取步行路线…
        </p>
      ) : null}

      {phase === "failed" ? (
        <div className="rc-empty rc-empty--neutral" style={{ marginTop: 4 }}>
          <p className="h-title">步行路线暂时取不到</p>
          <p className="t-body t-muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
            {err || "请检查网络后重试"}
            {totalDistM > 0 ? ` · 直线约 ${Math.round(totalDistM)} 米（按常速估算）` : ""}
          </p>
          <button type="button" className="btn btn--outline btn--sm" onClick={onRetry} style={{ marginTop: 10 }}>
            重试
          </button>
        </div>
      ) : null}

      {phase === "ready" && steps.length > 0 ? (
        <>
          {arrived ? (
            <p className="t-body" style={{ margin: "10px 0", fontWeight: 600 }}>
              已到达目的地
            </p>
          ) : null}
          <WalkPane
            phase={arrived ? "arrived" : "preview"}
            steps={steps}
            currentIdx={Math.min(currentIdx, steps.length)}
            remainM={remainM}
            offRoute={false}
            offM={0}
            /* 本面板不吃 GPS 跟随 ⇒ 恒出「上一步/下一步」，由用户自己推进 */
            lowAccuracy
            showAll={showAll}
            onToggleAll={() => setShowAll((v) => !v)}
            onPrev={() => setCurrentIdx((i) => Math.max(0, i - 1))}
            onNext={() => setCurrentIdx((i) => Math.min(steps.length, i + 1))}
            longWalk={totalDistM > 1500}
          />
        </>
      ) : null}
    </div>
  );
}
