"use client";

/**
 * 跨境交通 · 小组件集（src/components/cross-border/XbBits.tsx，2026-11-07）
 *
 * 本文件只放**无状态/低状态**的展示件，四个界面共用：
 *   `XbSource`（合规署名）· `XbStale`（降级条）· `XbFlag`（资料完整性）
 *   `XbEmpty`（空态）· `XbSkeleton` · `XbError`（错误 + 重试）· `XbCard`（入口卡）
 *
 * ── 三条不写在代码里就会写错的规矩 ─────────────────────────────────────
 *   ① **署名只渲染接口给的 `attribution.text`**，一个字符都不硬编码。
 *      硬编码 = 两份真相：条款改措辞时后端改了、前端没改，页面就是错的。
 *      （`text` 自带「資料來源：」前缀，本文件**不再**重复加，见 `attribution.ts`。）
 *   ② **`stale` 不清表**：继续显示旧数据 + 顶部一条「暂时无法更新（上游暂时取不到新数据…）」。
 *      清表等于把"更新失败"升级成"今天没有班次"。
 *   ③ **错误文案不归因到用户**：`XbError` 只说"取不到"，不写"请检查网络"
 *      （可能是上游挂了、也可能是我们采集挂了，用户无从判断）。
 */

import type { ReactNode } from "react";
import Icon from "@/components/ui/Icon";
import type { XbAttribution } from "@/lib/cross-border/types";

/* ── 合规署名（不可省、不可折叠；机场与船用两套文本，由后端下发）── */
export function XbSource({ attribution }: { attribution: XbAttribution }) {
  return (
    <div className="xb-src">
      <Icon name="info-circle" size={16} />
      <div>
        <span>
          {attribution.text}
          {" · "}
          <span className="nw">{`取得日期 ${attribution.acquiredOn}`}</span>
        </span>
      </div>
    </div>
  );
}

/* ── 降级条（`stale === true`）：**配着旧表一起显示**，不替代表格 ──────────
   ⚠️ 2026-11-07（负责人裁定）：原「數據時刻 …／以下為該時刻的快照」常驻行（`XbSnap`）
      **已整块删除**。删除的代价必须记住：`stale` 只覆盖"服务端取不到新数据"，
      而"用户在这屏停留 10 分钟、数据不 stale 但已旧"从此**没有任何时间提示**。
      ⇒ 若将来还要恢复"这是几点钟的快照"，重建点就是这里（不要塞进 `.xb-stale`：
        那是另一件事，混成一句会让两种"旧"再也分不开）。 */
export function XbStale() {
  return (
    <p className="xb-stale" role="status">
      <Icon name="info-circle" size={16} />
      {/* ★ 整句**一个字都是我们打的**，故整句简体（2026-11-07 语种裁决终版）：
          本组件**无 props**，上游只贡献一个 `stale: boolean`，句子里**零插值** ——
          没有任何一个字来自接口。判据：**这个字是我们打出来的，还是接口给的。**
          ⚠️ 我曾把开头「暫時無法更新」误列为"上游原话"，那是错的、已推翻；
             上游原文照录的是 `status` / `place` / `vessel` / `operator` 那几个字段
             （见 `xb-view.ts#statusCell` 的 `return { text: raw }`），不在这句里。 */}
      <span>暂时无法更新（上游暂时取不到新数据，以下是上次成功取得的内容）</span>
    </p>
  );
}

/* ── 资料完整性提示（滚动窗口导致早班缺失；只在确认缺失时由调用方渲染）── */
export function XbFlag({ children }: { children: ReactNode }) {
  return (
    <p className="xb-flag" role="status">
      <Icon name="info-circle" size={16} />
      <span>{children}</span>
    </p>
  );
}

/* ── 空态：标题 + 一句解释（三值文案由 `emptyCopy()` 给，不在这里 if）── */
export function XbEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="xb-empty">
      <Icon name="planeIcon" size={24} className="xb-empty__ic" />
      <h3 className="xb-empty__t">{title}</h3>
      <p className="xb-empty__b">{body}</p>
    </div>
  );
}

/* ── 载入骨架（不做跳动动画：避免"每次刷新都在闪"，`prefers-reduced-motion` 天然安全）── */
export function XbSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="xb-sk" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div className="xb-sk__row" key={i}>
          <span className="xb-sk__b" style={{ width: `${28 + ((i * 7) % 18)}%` }} />
          <span className="xb-sk__b" style={{ width: `${16 + ((i * 5) % 12)}%` }} />
          <span className="xb-sk__b" style={{ width: "18%" }} />
        </div>
      ))}
    </div>
  );
}

/* ── 错误 + 重试（重试是唯一出口；文字不猜原因）── */
export function XbError({ onRetry, what }: { onRetry: () => void; what: string }) {
  return (
    <div className="xb-err" role="alert">
      <p className="xb-err__t">{`${what}暂时取不到`}</p>
      <p className="xb-err__b">可能是上游（政府接口）或我们的采集出了问题，稍后可以重试。</p>
      <button type="button" className="xb-retry" onClick={onRetry}>
        <Icon name="refresh" size={16} />
        重试
      </button>
    </div>
  );
}

/* ── 入口卡（跨境交通页；整块可点 = 命中区 ≥64px）── */
export interface XbCardProps {
  icon: "bus" | "ferryIcon" | "planeIcon";
  title: string;
  sub: string;
  /** 右块的说明字（如「下一班」）。`null` ⇒ 不渲染右块 */
  endLabel?: string | null;
  /** 右块的值（如 `18:55`）。`null` ⇒ 显示 `--` 并降权（**不写「已收班」**：太吵） */
  endValue?: string | null;
  /**
   * 右块的徽标（如「時刻表」）。用于**没有实时源**的卡片：
   * `endLabel`/`endValue` 回答不了「下一班几点」，与其摆一个 `--` 让人读成"已收班"，
   * 不如直说这里只有时刻表。与 `endLabel` 一样，传 `null`/不传 ⇒ 整块不渲染。
   */
  endChip?: string | null;
  onClick: () => void;
}

export function XbCard({ icon, title, sub, endLabel, endValue, endChip, onClick }: XbCardProps) {
  return (
    <button type="button" className="xb-card" onClick={onClick}>
      <span className="xb-card__ic">
        <Icon name={icon} size={20} />
      </span>
      <span className="xb-card__main">
        <span className="xb-card__t">{title}</span>
        <span className="xb-card__s">{sub}</span>
      </span>
      {endLabel && (
        <span className="xb-card__end">
          <span className="xb-card__lab">{endLabel}</span>
          <span className="xb-card__val" style={endValue ? undefined : { color: "var(--meta)" }}>
            {endValue ?? "--"}
          </span>
        </span>
      )}
      {endChip && (
        <span className="xb-card__end">
          <span className="xb-chip">{endChip}</span>
        </span>
      )}
      <Icon name="forward" size={20} className="xb-card__chev" />
    </button>
  );
}
