/**
 * 线路站点全景页（src/app/line/[code]/page.tsx，v3.6.0 · S6）
 *
 * ── 定位（AC-41 / AC-42）────────────────────────────────────────────────
 *   从线路搜索结果点进来的一次性全景页（**不是**旧 `/routes`，那个已下线）。
 *   回答三个问题：这条线**怎么走**、**有哪些站**、**车到哪了**。
 *
 * ── 为什么在服务端直出站序 ──────────────────────────────────────────────
 *   站序是静态数据（`s-maxage=3600` 级别），服务端组件**直接调 lib 取库**，
 *   避免「页面 → 自己的 HTTP 接口 → 库」多一次跨洲往返（项目在 iad1→新加坡的
 *   冷启动上踩过这个坑，见 `recommend/query.ts` 文件头的实测链）。
 *   报站则交给客户端逐站懒加载（20 秒就旧，不能随页面直出）。
 *
 * ── 取数复用 ────────────────────────────────────────────────────────────
 *   `loadRouteStops()` 与 `GET /api/route-stops` **同一份实现**
 *   （`src/lib/line/load-route-stops.ts`）。客户端切方向时走接口，首屏走这里。
 *
 * ── 404 口径 ────────────────────────────────────────────────────────────
 *   线路码不存在 ⇒ `notFound()`（Next 的 404 页）。与接口的 404 语义对齐：
 *   「线路不存在」是**空态**，不是错误；前端不该显示重试。
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadRouteStops } from "@/lib/line/load-route-stops";
import LineClient from "./LineClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

interface PageProps {
  /** Next 15：`params` 是 Promise（同步访问会在 build 时报错） */
  params: Promise<{ code: string }>;
  searchParams: Promise<{ dir?: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { code } = await params;
  const decoded = safeDecode(code);
  // 不查库（避免与页面重复一次 DB 往返）；标题用线路码即可，够用于分享卡片
  return {
    title: `${decoded} 线路站点 · MUST登校`,
    description: `查看 ${decoded} 的全线站序、线路走向与实时到站`,
  };
}

/** `%E6%B0%B9...` → 原文；解码失败时原样返回（不因脏 URL 崩页） */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export default async function LinePage({ params, searchParams }: PageProps) {
  const [{ code }, sp] = await Promise.all([params, searchParams]);
  // App Router 已对动态段解码一次，但 `LRT-氹仔线` 这类含中文的码在部分链路里
  // 仍是百分号编码 ⇒ 再安全解一次（幂等，纯 ASCII 码不受影响）。
  const decoded = safeDecode(code);
  if (!decoded || decoded.length > 40) notFound();

  const dir = (sp.dir ?? "").trim();
  let r;
  try {
    r = await loadRouteStops(decoded, dir);
  } catch (e) {
    // 库侧故障：抛给 Next 的 error boundary（不吞成 404，否则用户以为是「没这条线」）
    console.error("[line/page] 取站序失败：", (e as Error).message);
    throw e;
  }
  if (!r.ok) {
    if (r.reason === "not_found") notFound();
    throw new Error("线路站序暂时取不到");
  }

  return <LineClient initial={r.data} />;
}
