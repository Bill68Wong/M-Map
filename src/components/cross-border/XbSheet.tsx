"use client";

/**
 * 跨境交通 · 全屏班次页（src/components/cross-border/XbSheet.tsx，2026-11-07）
 *
 * 一个组件同时是需求 5 和需求 6 的那一屏（差别只有 `after`）：
 *   `after="now"` ⇒ 最近五班（列少两列，底部给「查看详细信息」）
 *   `after="day"` ⇒ 当日所有（含登机口/闸口，表头吸附 + 小时分组 + 「現在」游标 + 打开即定位）
 *
 * ── 四个板块（离澳/抵澳 × 五班/全量）为什么不是四个页面 ─────────────────
 *   设计稿 §7.5 明确「不要做 4 个复制粘贴页」：列模板由 `XbTable.tableSpec()` 一处决定，
 *   复制会立刻出现"机场抵澳那页忘了改列头"这种不一致。
 *
 * ── 空态必须说成三句不同的话 ───────────────────────────────────────────
 *   `emptyReason` 三值各有含义（见 `xb-view.ts#emptyCopy`）。**永不**用
 *   `items.length === 0` 猜文案 —— 那会把"我方还没采到"说成"今天没有船"。
 *
 * ── `stale` 不清表 ─────────────────────────────────────────────────────
 *   顶部一条「暂时无法更新（上游暂时取不到新数据…）」，表格照旧渲染。清表会把
 *   "更新失败"升级成"今天没有班次"，是最坏的一种降级。
 *
 * ── 合规两条硬线（碰了就违约，不是风格问题）────────────────────────────
 *   ① 状态 / 船名 / 地名 / 公司名 **原文照录**（本组件对 `status`/`place`/`vessel`
 *      只做 `|| 缺值兜底`，**没有任何** replace / 繁简转换 / 空格美化）；
 *   ② **不放「查看原文」外链**：海事局条款要求深链非首页需书面授权。
 *      底部那个「查看详细信息」是**站内**跳转（本屏 → 当日所有），不是外链。
 */

import { useCallback, useMemo, type KeyboardEvent } from "react";
import Icon from "@/components/ui/Icon";
import type { PierCode, XbAfter, XbDir } from "@/lib/cross-border/types";
import XbTable, { type XbTableItem } from "./XbTable";
import { XbEmpty, XbError, XbSkeleton, XbSource, XbStale } from "./XbBits";
import { useXbList } from "./useXbList";
import { emptyCopy, listUrl, macauParts, type XbKind } from "./xb-view";

export interface XbSheetProps {
  kind: XbKind;
  /** 船必填（三码头内容不同）；机场传 null */
  pier: PierCode | null;
  /** 站名（繁体专名：澳門國際機場 / 內港碼頭 …） */
  title: string;
  dir: XbDir;
  after: XbAfter;
  onDir: (d: XbDir) => void;
  /** 「查看详细信息」⇒ 同一路由切到当日所有（站内跳转） */
  onSeeAll: () => void;
  onClose: () => void;
}

export default function XbSheet({
  kind,
  pier,
  title,
  dir,
  after,
  onDir,
  onSeeAll,
  onClose,
}: XbSheetProps) {
  const url = useMemo(
    () =>
      listUrl(kind, {
        dir,
        after,
        pier,
        /* 需求 5 = 最近五班：`after=now&limit=5`。`day` 不传 limit ⇒ 用接口默认 200。 */
        limit: after === "now" ? 5 : undefined,
      }),
    [kind, dir, after, pier],
  );

  const { state, reload } = useXbList<XbTableItem>(url);

  const data = state.status === "ok" ? state.data : null;
  const now = macauParts(data?.serverNow);
  const items = data?.items ?? [];
  const what = kind === "airport" ? "航班" : "船班";

  /* 方向切换：键盘左右键（设计稿 §7.4 要求；40 行内实现成本低） */
  const onTabKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      onDir(dir === "dep" ? "arr" : "dep");
    },
    [dir, onDir],
  );

  return (
    <div className="xb-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <div className="xb-sheet__grab">
        <div className="xb-sheet__grip" />
      </div>

      <div className="xb-sheet__hd">
        <h1 className="xb-sheet__h">{title}</h1>
        <button type="button" className="xb-sheet__x" aria-label="关闭" onClick={onClose}>
          <Icon name="close" size={20} />
        </button>
      </div>

      {/*
        2026-11-07（负责人裁定「两行全删」）：原 `.xb-sheet__sub` 整块已删除 ——
        内容是「最近班次 / 跨境通行 · 現在 HH:MM · 今日剩餘 N 班 / 今日共 N 班」。
        ⚠️ 它与下面被删的 `XbSnap` 都不是骨架屏/吸顶的占位锚点：
          · 骨架屏 `XbSkeleton` 在 `.xb-sheet__body` **内部**渲染，与这里无兄弟关系；
          · 吸顶靠 `.xb-th--sticky` 的 `position: sticky` + 滚动容器，与上方节点数无关；
          · 标题行 `.xb-sheet__hd` 自带 `min-height: 44px`，不靠这一行撑高。
        ⇒ 直接删不塌。**代价**：正常态下屏上不再有任何"数据是几点钟的"提示（仅 `stale` 时
          由 `XbStale` 出现），恢复点见 `XbBits.tsx` 的 `XbStale` 上方注释。
      */}

      {/* 离澳 / 抵澳（需求 6 的「两大板块」；五班视图也保留，切换成本为零） */}
      <div className="xb-brd" role="tablist" aria-label="板块" onKeyDown={onTabKey}>
        <button
          type="button"
          role="tab"
          aria-selected={dir === "dep"}
          className={`xb-brd__t${dir === "dep" ? " is-on" : ""}`}
          onClick={() => onDir("dep")}
        >
          离澳
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={dir === "arr"}
          className={`xb-brd__t${dir === "arr" ? " is-on" : ""}`}
          onClick={() => onDir("arr")}
        >
          抵澳
        </button>
      </div>


      <div className="xb-sheet__body">
        {data?.stale && <XbStale />}

        {state.status === "loading" && <XbSkeleton rows={5} />}

        {state.status === "error" && <XbError onRetry={reload} what={what} />}

        {state.status === "ok" && items.length > 0 && (
          <XbTable
            kind={kind}
            dir={dir}
            after={after}
            items={items}
            nowMinutes={now?.minutes ?? null}
            today={now?.ymd ?? null}
            /* 只有「当日所有」需要打开即定位；五班视图滚走就等于没给用户看那 5 行 */
            autoScroll={after === "day"}
          />
        )}

        {state.status === "ok" && items.length === 0 && data && (
          <>
            {/* 空态保留表头：让用户确认"列定义没变、只是今天没有"，而不是整页变成一个空盒子 */}
            <XbTable
              kind={kind}
              dir={dir}
              after={after}
              items={[]}
              nowMinutes={null}
              today={now?.ymd ?? null}
            />
            <XbEmpty {...emptyCopy(data.emptyReason ?? "no_service_today", kind, dir)} />
          </>
        )}

        {data && <XbSource attribution={data.attribution} />}
      </div>

      {after === "now" && (
        <div className="xb-sheet__foot">
          {/* 站内跳转：本屏 → 当日所有。**不是**外链，见文件头合规第 ② 条 */}
          <button type="button" className="xb-link" onClick={onSeeAll}>
            查看详细信息
            <Icon name="arrowRight" size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
