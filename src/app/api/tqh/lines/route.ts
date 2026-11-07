/**
 * GET /api/tqh/lines —— 通琴号全部 80 个班次 + 138 个站点（v3.9.0 新增）
 *
 * ── 为什么班次与站点一次返回 ────────────────────────────────────────────
 *   80 班次 × 平均 10.54 站 = 843 条站序，实测 JSON 约 46 KB（gzip ≈ 8 KB），
 *   比既有 `/api/stations`（619 站全量）还小。一次返回后：
 *     · R1/R2 路线弹窗通琴号板块 = 纯内存切换，切板块 0 请求；
 *     · R4 站点卡按 direction 分组 = 客户端 group；
 *     · R6 站名后「澳 / 琴」标签 = 直接读 `stations[].side`；
 *     · R7 搜索按班次逐条 = 客户端过滤，**不接 `/api/poi/suggest`**（搜索配额仅 5000/月）。
 *
 * ── 硬约束 ────────────────────────────────────────────────────────────
 *   · 只读 GET，无写库、无副作用；
 *   · **请求期零高德调用**（几何不在这里，在 `/api/tqh/trip-path` 查库）；
 *   · **不做坐标转换**：`tqh_stations.lng/lat` 已是 GCJ-02，原样输出。
 *
 * ── 缓存 ──────────────────────────────────────────────────────────────
 * 班次表一年变几次，属静态数据 ⇒ CDN + 浏览器双层缓存。
 * ⚠️ 必须**同时**给 `max-age` 与 `s-maxage`：只写 `s-maxage` 时 Vercel 会把它从
 *    浏览器可见头里剥掉，前端只能退回 `force-cache`，造成两层缓存各管一段。
 */
import { NextResponse } from "next/server";
import { API_ERROR } from "@/lib/http/errors";
import { loadTqhLines } from "@/lib/tqh/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const CACHE_HEADER = {
  "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
};

export async function GET() {
  try {
    const payload = await loadTqhLines();
    return NextResponse.json(payload, { headers: CACHE_HEADER });
  } catch (e) {
    console.error("[api/tqh/lines] 失败：", (e as Error).message);
    // 保留数组形状（前端按 trips/stations 取值），错误码落在六值闭集内。
    // 通琴号板块降级不影响澳门板块 —— 两者数据源与请求都独立。
    return NextResponse.json(
      { trips: [], stations: [], error: API_ERROR.upstream_error },
      { status: 500 },
    );
  }
}
