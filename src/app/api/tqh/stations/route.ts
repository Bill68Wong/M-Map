/**
 * GET /api/tqh/stations —— 138 个通琴号站点（v3.9.0 新增）
 *
 * 与 `/api/tqh/lines` 的 `stations` 字段**完全相同**（同一个序列化函数
 * `src/lib/tqh/query.ts#loadTqhStations` 内部复用 `toStation`），这是 openapi.yaml 的硬要求。
 * 独立成端点的理由：只画站点图层（R3）而不进弹窗时，不必拉 80 个班次。
 *
 * ⚠️ **不做坐标转换**。`tqh_stations.lng/lat` 已是 GCJ-02（腾讯地图收藏集原生），
 *    原样输出。这与 `/api/stations`（库内 WGS84、出口转 GCJ-02）**口径相反** ——
 *    是本方案最容易被后来者「顺手统一」而写错的一处（写错的表现是约 500 m 系统偏差）。
 *
 * 只读 GET。缓存口径同 `/api/tqh/lines`（静态数据，双层缓存）。
 */
import { NextResponse } from "next/server";
import { API_ERROR } from "@/lib/http/errors";
import { loadTqhStations } from "@/lib/tqh/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const CACHE_HEADER = {
  "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
};

export async function GET() {
  try {
    const payload = await loadTqhStations();
    return NextResponse.json(payload, { headers: CACHE_HEADER });
  } catch (e) {
    console.error("[api/tqh/stations] 失败：", (e as Error).message);
    return NextResponse.json(
      { stations: [], error: API_ERROR.upstream_error },
      { status: 500 },
    );
  }
}
