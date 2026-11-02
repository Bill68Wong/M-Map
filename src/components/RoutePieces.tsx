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

/** 澳门时刻 HH:MM（与服务端 hhmm 同口径：+8h 后取当日余秒） */
export function macauClock(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * ★ v3.3.0（AC-107）→ ★ v3.7.0 S4 收紧：取本段「赶车提示」文案。
 *
 * 旧版是「`catchHint` 优先、回落 `tierText`」的**合并式**；v3.7.0 起速度档文案全站隐藏
 * （见 `TierBadge`），回落分支已无渲染出口 ⇒ 这里**只返回 `catchHint`**：
 *   · `text` 为空 = 本段没有真实到站时刻 ⇒ 调用方不渲染任何胶囊（AC4.2 不臆造时刻）；
 *   · `isHint` 保留（调用方 JSX 与测试钩子仍按它判断）。
 */
export function catchHintOf(leg: { tierText?: string; catchHint?: string }): {
  text: string;
  isHint: boolean;
} {
  return { text: leg.catchHint ?? "", isHint: !!leg.catchHint };
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
 * 赶车提示胶囊（★ v3.7.0 S4 收敛为**只显示真实时刻**）
 *
 * ── 为什么删掉 `tier` ──────────────────────────────────────────────────
 *   负责人按**内容**定的口径：「保留一切时间，隐藏的是『全力冲刺有机会赶上 / 小跑能赶上 /
 *   正常走能赶上』这类文案标签」。⇒ 本组件只剩一种可渲染内容：`catchHint`
 *   （带真实时刻的「走快一点可赶上 HH:MM 那班」）。
 *
 *   · 判据必须是 `catchHint`（是否赶车提示），**不是** `tier !== null` ——
 *     否则会把「可赶上 HH:MM」一起隐藏掉（AC4.1 / AC4.2）；
 *   · **档位色阶一并去掉**：`rc-tier--{tier}` 若留着，等于把被删掉的信息挪进颜色通道，
 *     色觉障碍用户反而失去兜底（AC4.4）。故 `tier` 参数**整体移除**，
 *     让任何调用方都无法再传档位、也无法再拿到档位颜色。
 *   · 保留 `.rc-tier` 基础样式（中性底色胶囊）：它是「时刻提示」的容器，不是档位编码。
 *
 * 观测钩子：渲染出来即 `data-catch-hint="on"`（测试用它定位胶囊后断言文案里无速度档词）。
 */
export function TierBadge({ tierText, catchHint = false }: { tierText: string; catchHint?: boolean }) {
  if (!catchHint || !tierText) return null;
  return (
    <span className="rc-tier" data-catch-hint="on">
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
