/**
 * 跨境交通 · 全屏班次页（`src/app/cross-border/[station]/page.tsx`，2026-11-07 · 需求 5 / 6）
 *
 * ── 为什么一个路由服务四个站 ────────────────────────────────────────────
 *   `airport` / `PE`（外港）/ `TP`（氹仔）/ `PI`（内港）四者结构完全同构，
 *   差别只有「标题 + 是否要 `pier` 参数 + 列模板」三处（列模板由 `XbTable` 判 `dir`/`after`）。
 *   设计稿 §7.5 明确要求**不要**做 4 个复制页 —— 复制出来的第 3 天就会有人漏改一处。
 *
 * ── 三种粒度用同一个路由的两种形态 ──────────────────────────────────────
 *   `/cross-border/airport`            ⇒ `after=now`（最近五班，需求 5）
 *   `/cross-border/airport?after=day`  ⇒ `after=day`（当日所有，需求 6）
 *   用 query 而不是两个路由：**同一屏的两种粒度**，用 URL 表达"我现在看的是哪一种"，
 *   浏览器返回键天然可用（比自持 state 更少 bug）。
 *
 * ── 站名不认识 ⇒ 404，不是空态 ─────────────────────────────────────────
 *   `notFound()`：URL 打错是**路由错误**，与"今天没有船"是两件事。
 *   若把它渲染成空态，用户会以为这个码头今天停航。
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { PierCode } from "@/lib/cross-border/types";
import { stationName } from "@/components/cross-border/xb-view";
import StationClient from "./StationClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PageProps {
  /** Next 15+：`params` 是 Promise（同步访问会在 build 时报错） */
  params: Promise<{ station: string }>;
  searchParams: Promise<{ after?: string; from?: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { station } = await params;
  const name = stationName(station);
  return {
    title: name ? `${name} · 即时班次` : "跨境交通",
    /* 实时班次页不进索引：内容按分钟变，索引里只会留下过期的时刻 */
    robots: { index: false, follow: false },
  };
}

export default async function Page({ params, searchParams }: PageProps) {
  const { station } = await params;
  const sp = await searchParams;

  const name = stationName(station);
  if (!name) notFound();

  const isAirport = station === "airport";
  const pier: PierCode | null = isAirport ? null : (station.toUpperCase() as PierCode);
  const after = sp.after === "day" ? "day" : "now";
  /**
   * 来路（需求 8 · 关闭键「从哪来的就回哪」）：
   *   `?from=map` ⇒ 关闭回 `/`（地图首页的机场/港口小窗进来）；
   *   缺省 / 任何其它值 ⇒ 关闭回 `/cross-border`（列表进来，**向后兼容旧链接**）。
   * 只认字面量 `"map"`：白名单比黑名单安全 —— 将来加新来路时，未知值落到"回列表"
   * 这个安全默认，而不是莫名其妙跳到某个页面。
   */
  const from = sp.from === "map" ? "map" : "list";

  return (
    <StationClient
      kind={isAirport ? "airport" : "ferry"}
      pier={pier}
      title={name}
      station={isAirport ? "airport" : (pier as PierCode)}
      after={after}
      from={from}
    />
  );
}
