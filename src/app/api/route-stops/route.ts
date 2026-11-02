/**
 * GET /api/route-stops —— 线路站点全景页的**站序**数据源（v3.6.0 · S6）
 *
 * 用途（架构 §4.1.2 / AC-42a）：`/line/[code]` 全线站序 = 站名 + GCJ-02 坐标 + 沿线里程
 * + 首末站。**报站不进本接口** —— 实时到站由前端逐站懒加载 `/api/station/eta`（单页
 * ≤30 请求、并发 ≤3、轻轨零请求）。分开的理由很实在：站序几小时不变（能长缓存），
 * 报站 20 秒就旧（不能缓存）；混在一起等于两个都只能短缓存。
 *
 * ★ 取数逻辑已抽到 `src/lib/line/load-route-stops.ts`（与 `/line/[code]` 服务端组件共用）：
 *   · 本文件只做**参数校验 + 响应映射**，不重复 SQL；
 *   · 也**不能**在这里 `export` 辅助函数 —— Next 的 `.next/types` 导出白名单检查会让
 *     `next build` 直接失败，而 `tsc --noEmit` **抓不到**（本项目踩过一次，见 ADR 记录）。
 *
 * 缓存 `public, s-maxage=3600`（静态数据，同 `/api/stations`）。**公开只读**；
 * `/api/route-stops` 是新前缀但口令门已于 S2 拆除 ⇒ 无需登记；若将来恢复上锁，
 * **必须**把它加进白名单，否则线上 401。
 */
import { NextRequest, NextResponse } from "next/server";
import { loadRouteStops } from "@/lib/line/load-route-stops";
import { API_ERROR, errorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const CACHE_HEADER = { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=600" };

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const code = (sp.get("code") ?? "").trim();
  const dirParam = (sp.get("dir") ?? "").trim();
  if (!code || code.length > 40) return errorResponse(API_ERROR.bad_request);

  try {
    const r = await loadRouteStops(code, dirParam);
    if (!r.ok) {
      // ★ 状态码用 404（前端靠**状态码**区分「线路不存在 ⇒ 空态」vs「服务端故障 ⇒ 重试」），
      //   但 `error` 必须落在 AC-50d 的六值闭集内。
      //   ⚠️ 旧实现回 `"route_not_found"` —— 那是**第七个**枚举值，破了闭集（S6 评审阻断 ③）。
      if (r.reason === "not_found") return errorResponse(API_ERROR.bad_request, 404);
      console.error("[api/route-stops] 取数失败");
      return NextResponse.json({ stops: [], error: API_ERROR.upstream_error }, { status: 500 });
    }
    return NextResponse.json(r.data, { headers: CACHE_HEADER });
  } catch (e) {
    console.error("[api/route-stops] 失败：", (e as Error).message);
    // 保留空数组形状（消费方按 stops 取值），只把 error 换成固定枚举
    return NextResponse.json({ stops: [], error: API_ERROR.upstream_error }, { status: 500 });
  }
}
