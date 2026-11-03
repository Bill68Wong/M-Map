/**
 * 共享展示原语（src/components/RoutePieces.tsx，v1.1.8）
 *
 * 从 `RecommendCard.tsx` 抽出的三件套 —— 详情页要用同一套东西，
 * 不抽就只能复制粘贴（两份会漂移）。
 *
 * ⚠️ 本文件**不写 `"use client"`**：三个都是纯展示（无 hooks、无事件），
 *    server component 与 client component 都能直接 import。
 */
import Icon from "@/components/ui/Icon";
import type { CatchTier } from "@/lib/recommend/types";

/** 澳门时刻 HH:MM（与服务端 hhmm 同口径：+8h 后取当日余秒） */
export function macauClock(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * ★ v3.3.0（AC-107）：取本段「赶车提示」文案 —— `RideLegView.catchHint`（带时刻变体）**优先**，
 * 回落既有 `tierText`。合并式：同一 `TierBadge` 胶囊同时承载档位色与「可赶上 HH:MM」。
 *
 * ★ v3.9.0（需求 3 · 负责人拍板 C「恢复原样」）：**恢复 S4 删掉的 `tierText` 回落**。
 *   S4（v3.8.0）把回落删掉后，巴士段（从无 `catchHint`）的赶车标签整体消失——
 *   负责人裁定恢复方案卡上的显示（知情选择与 S4 原拍板「隐藏档位词」存在张力，已记录在案）。
 *   范围仅限**方案卡场景**（推荐卡/详情卡，用户到站前）；导航态/站条/到站后的隐藏**保留**。
 */
export function catchHintOf(leg: { tierText?: string; catchHint?: string }): {
  text: string;
  isHint: boolean;
} {
  return { text: leg.catchHint ?? leg.tierText ?? "", isHint: !!leg.catchHint };
}

/**
 * ★ v3.3.0（AC-103）：轻轨段**方向**（终点站名，如「氹仔碼頭」）。
 * 数据源 `RideLegView.directionName`（已落地；上游 `LrtLive.directionName`）。
 */
export function directionNameOf(leg: { route?: string; directionName?: string | null }): string | null {
  return leg.directionName ?? null;
}

/**
 * ★ v3.3.0（AC-105）：本卡是否被「轻轨优先」置顶。
 * 数据源 `RecommendCard.lrtPromoted`（**唯一产生点** = `applyLrtPriority` 命中回写；
 *   `!enabled` 时早返回、字段不置 ⇒ `undefined`）。`=== true` 判定 ⇒ 未触发时**绝不误标**
 *   （符合设计「未触发静默」口径）。
 */
export function lrtPromotedOf(card: { planId?: number; lrtPromoted?: boolean }): boolean {
  return card.lrtPromoted === true;
}

/**
 * ★ v3.3.0（AC-103）：方向文案 —— 统一格式 **`{終點}方向`**（繁体地名原样 + 简体功能词）。
 * 幂等：若调用方已给 `…方向` 则不重复追加；空值 ⇒ `null`（整段省略，不显示空壳）。
 */
export function dirTextOf(name?: string | null): string | null {
  if (!name) return null;
  return name.endsWith("方向") ? name : `${name}方向`;
}

/**
 * 赶车分档徽章（★ v3.9.0 需求 3 · 负责人拍板 C：**恢复 S4 删除前的原样**）
 *
 * ── 恢复史（三层口径叠代，读代码前先看这段）──────────────────────────
 *   · v1.0.6~v3.2.0：5 档配色徽章（`rc-tier--{tier}`），文案 = `TIER_TEXT`（「小跑能赶上」等）。
 *   · v3.3.0（AC-107）：合并式 —— 轻轨段的「走快一点可赶上 HH:MM 那班」（`catchHint`）优先，
 *     回落档位文案；同一胶囊承载。
 *   · v3.7.0 S4（v3.8.0 上线）：按当时拍板删档位词与色阶 —— **执行过头**：回落分支一并删除，
 *     巴士段（从无 catchHint）的赶车标签整体蒸发。
 *   · ★ v3.9.0：负责人裁定**恢复原样**（本版）。知情选择与 S4 原拍板存在张力，已记录在案。
 *     范围仅限**方案卡场景**（推荐卡/详情卡/计卡详情，用户到站前）；
 *     导航态/站条/到站后的隐藏是负责人原始需求，保留不动。
 *
 * 观测钩子：渲染出来即 `data-catch-hint="on"`（仅当承载的是带时刻的 catchHint 变体；
 *   档位词回落不算「赶车提示时刻」——与 S4 前语义一致）。
 */
export function TierBadge({
  tier,
  tierText,
  catchHint = false,
}: {
  tier: CatchTier | null;
  tierText: string;
  catchHint?: boolean;
}) {
  if (tier === null || !tierText) return null;
  return (
    <span className={`rc-tier rc-tier--${tier}`} data-catch-hint={catchHint ? "on" : undefined}>
      {tierText}
    </span>
  );
}

/**
 * 报站文案高亮（修复包 v2.2.1 · 第 4 条）
 *
 * 把「还有 **N** 站」里的站数 N、以及「**即将到站**」用 `<b>` + 青花蓝（`.t-accent`）突出 ——
 * 「还有几站」是通勤决策的关键数字，扫描时应第一眼可见。
 * 其余文案原样透传（轻轨「HH:MM 開出」、巴士第 2 段起「按班次间隔推算」等）。
 *
 * ⚠️ 只高亮「数字 + 站」这一处（不误伤「约 4~6 分」里的数字）。
 */
export function EtaText({ text }: { text: string }) {
  const parts = text.split(/(\d+(?=\s*站)|即将到站)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^\d+$/.test(p) || p === "即将到站" ? (
          <b className="t-accent" key={i}>
            {p}
          </b>
        ) : (
          p
        ),
      )}
    </>
  );
}

/** 时间线一行：圆点 + 竖线 + 内容
 *
 * ★ v2.4.1：新增 `"sub"` 形态 —— **附属行**（无图标、内容缩进到与主行文字左对齐）。
 *   用途：用户新卡片规范里「还有 N 站 · 约多少时间」是**上一行（上车站）的附属信息**，
 *   不是独立节点 ⇒ 不该再给一个巴士站图标（那会看起来像"又到了一次站"）。
 */
export function Row({
  dot,
  main,
  aside,
  last,
}: {
  dot: "walk" | "wait" | "ride" | "transfer" | "sub";
  main: React.ReactNode;
  aside?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={`rc-row rc-row--${dot}${last ? " rc-row--last" : ""}`}>
      <span className={`rc-dot rc-dot--${dot}`} aria-hidden="true">
        {dot === "walk" ? (
          <Icon name="walk" size={16} />
        ) : dot === "wait" ? (
          <Icon name="busStop" size={16} />
        ) : dot === "transfer" ? (
          <Icon name="expandVertical" size={16} />
        ) : null /* ride / sub：无图标 */}
      </span>
      <span className="rc-text">{main}</span>
      {aside}
    </div>
  );
}
