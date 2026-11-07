"use client";

/**
 * 跨境交通 · 全屏班次页的客户端壳（`StationClient.tsx`，2026-11-07）
 *
 * 只做三件事：**方向 state**、**两个跳转**、把参数原样交给 `XbSheet`。
 * 取数/渲染/空态全在 `XbSheet`（那才是可复用的那层）。
 *
 * ── 为什么 `dir` 放本地 state 而 `after` 放 URL ─────────────────────────
 *   · `after` 是**用户可感知的"我在看哪一屏"**（五班 / 当日所有）⇒ 进 URL，
 *     返回键能回去，分享链接也带得住；
 *   · `dir`（离澳/抵澳）是同一屏内的**板块切换**，切它不该产生历史记录
 *     （否则用户按三次返回还在这一页，这是移动端最常见的"返回失灵"体感）。
 *   ⇒ 两者不同待遇是刻意的，不是不一致。
 *
 * ── 关闭口径 ───────────────────────────────────────────────────────────
 *   **从哪来的就回哪**（2026-11-07 需求 8）：
 *     · `from="list"`（缺省，跨境交通列表点卡片进来）⇒ `router.push("/cross-border")`；
 *     · `from="map"`（地图首页的机场/港口小窗进来）⇒ `router.push("/")`。
 *   一律用 `push` 不用 `router.back()`：从分享链接直接进来时没有 back 可退
 *   （会退到浏览器新标签页）。来路不明 ⇒ 默认回列表，旧链接 / 分享链接都不会炸。
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { PierCode, XbAfter, XbDir } from "@/lib/cross-border/types";
import XbSheet from "@/components/cross-border/XbSheet";
import type { XbKind } from "@/components/cross-border/xb-view";

export interface StationClientProps {
  kind: XbKind;
  pier: PierCode | null;
  /** 站名（繁体专名，服务端已解析好） */
  title: string;
  /** 回跳用的站码（`airport` / `PE` / `TP` / `PI`） */
  station: string;
  after: XbAfter;
  /** 来路：`list`（跨境交通列表，缺省）或 `map`（地图首页小窗）。只影响关闭键去向。 */
  from: XbEntryFrom;
}

/** 来路白名单（服务端已归一化，这里只做类型收口） */
export type XbEntryFrom = "map" | "list";

export default function StationClient({
  kind,
  pier,
  title,
  station,
  after,
  from,
}: StationClientProps) {
  const router = useRouter();
  const [dir, setDir] = useState<XbDir>("dep");

  /**
   * 站内跳转的 URL 构造：**必须带上 `from`**，否则「五班 → 当日所有」这一步会把来路
   * 丢掉，之后再点关闭就回到列表页（地图进来的人被弹到另一个页面）。
   * `from=list` 是缺省值 ⇒ 不写进 URL，保持旧链接形态（`?after=day`）。
   */
  const href = useCallback(
    (nextAfter: XbAfter) => {
      const p = new URLSearchParams({ after: nextAfter });
      if (from === "map") p.set("from", "map");
      return `/cross-border/${station}?${p.toString()}`;
    },
    [station, from],
  );

  /* 关闭：从哪来的就回哪 */
  const onClose = useCallback(
    () => router.push(from === "map" ? "/" : "/cross-border"),
    [router, from],
  );

  /**
   * 「查看详细信息」= 同一路由切到当日所有（站内跳转；**不是**外链，见 XbSheet 文件头）。
   * ★ 设计稿 v1.1 定案：与通琴号卡一起列为「不设返回」的两处之一 ⇒ 用 `replace`，
   *   按返回键不该回到"五班"那一屏（用户感知里它是**同一件事的展开**，不是新开一层）。
   */
  const onSeeAll = useCallback(() => router.replace(href("day")), [router, href]);

  return (
    <XbSheet
      kind={kind}
      pier={pier}
      title={title}
      dir={dir}
      after={after}
      onDir={setDir}
      onSeeAll={onSeeAll}
      onClose={onClose}
    />
  );
}
