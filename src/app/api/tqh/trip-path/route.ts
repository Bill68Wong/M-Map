/**
 * GET /api/tqh/trip-path?trip_code=… —— 单个班次的逐段路径几何（v3.9.0 新增）
 *
 * ── 为什么返回「段数组」而不是一条拼好的折线 ─────────────────────────────
 *   前端要按段状态分两种画法：`ok` 画主题色实线，`missing` / `failed` 画虚线直连。
 *   拼成一条就丢了分界信息。拼接在客户端做（一次 flat，O(n)）。
 *
 * ── 几何从哪来（请求期零外部调用）──────────────────────────────────────
 *   `tqh_segment_paths`（离线脚本按「相邻站对有向去重」预生成；763 次相邻关系
 *   去重后 302 个有向站对，跨班次复用率 60.4%）。**绝不在这里调高德**：
 *   高德月配额用尽时会静默返回空，放在请求路径上会造成「时好时坏且不报错」。
 *
 * ── 状态码约定 ────────────────────────────────────────────────────────
 *   · 参数缺失 / 超过 64 字符 → 400（`bad_request`）
 *   · trip_code 查不到        → 404（`bad_request`，值必须落六值闭集）
 *   · 数据层不可用            → 500（`upstream_error`）
 *   用状态码区分「不存在」与「服务故障」，沿用 `/api/route-stops` 的既有做法。
 *
 * ── ⚠️ trip_code 的全角竖线（本接口最大的坑）────────────────────────────
 *   `trip_code` 形如 `A1｜往澳门｜A1线-上班线`，竖线是**全角 `｜`（U+FF5C）**。
 *   实测 `SELECT position('|' in trip_code) FROM tqh_trips` 全为 0 ⇒ 库里没有一条
 *   用 ASCII `|`。若写 `/[|]/` 之类的 ASCII 字符类校验，会把**全部合法输入**判非法。
 *
 *   ⇒ 本接口**只做长度与空值校验，不做字符集正则**。需要的是「长度上限防滥用」，
 *      不是「格式猜测」；字符集一旦收紧，新班次命名（含括号/圈号/横线）就可能被误杀。
 */
import { NextRequest, NextResponse } from "next/server";
import { API_ERROR, errorResponse } from "@/lib/http/errors";
import { findTqhTripId, loadTqhTripPath } from "@/lib/tqh/query";
import { TQH_TRIP_CODE_MAX_LEN } from "@/lib/tqh/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** 几何是离线预计算的静态事实，可长缓存（7 天 SWR 兜住「恰好过期」的那一次） */
const CACHE_HEADER = {
  "Cache-Control": "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
};

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("trip_code");
  const tripCode = (raw ?? "").trim();

  if (!tripCode || tripCode.length > TQH_TRIP_CODE_MAX_LEN) {
    return errorResponse(API_ERROR.bad_request);
  }

  try {
    const tripId = await findTqhTripId(tripCode);
    if (tripId === null) return errorResponse(API_ERROR.bad_request, 404);

    const payload = await loadTqhTripPath(tripId, tripCode);
    return NextResponse.json(payload, { headers: CACHE_HEADER });
  } catch (e) {
    console.error("[api/tqh/trip-path] 失败：", (e as Error).message);
    // 保留数组形状（前端按 segments 取值），只回固定枚举
    return NextResponse.json(
      { segments: [], complete: false, error: API_ERROR.upstream_error },
      { status: 500 },
    );
  }
}
