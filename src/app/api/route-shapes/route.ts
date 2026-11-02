/**
 * GET /api/route-shapes?code=26 —— 某条线路的**走向**（地图画线用）
 * （2026-09-22 新增）
 *
 * ── 数据来源 ──────────────────────────────────────────────────────────
 *   `route_shapes`（离线由 `scripts/fetch-route-shapes.ts` 从高德 `/v3/bus/linename` 抓取）。
 *   ⚠️ **不在请求期查高德** —— 高德有 QPS 限流且月配额用尽会**静默返回空**，
 *      放在请求路径上会导致「时好时坏、且不报错」，故一律读库。
 *
 * ── 坐标口径（★ 极易踩坑）──────────────────────────────────────────────
 *   · `route_shapes.polyline` = **GCJ-02**（高德原生）——**直接**喂高德地图，**不要再转**！
 *   · 而 `stations` 表是 **WGS84**（`/api/stations` 出口才转 GCJ-02）。
 *   ⇒ 两者来源不同、**不可混用**：画线用本接口的点，画站点用 `/api/stations` 的点。
 *
 * ── 双方向 ────────────────────────────────────────────────────────────
 *   一条线路可能有 2 个方向（`dsat_dir` = 0/1）⇒ `shapes` 数组返回多条，
 *   前端按产品口径**两个方向都画**（不同质感）或按需选择。
 *
 * 只读接口。
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { API_ERROR } from "@/lib/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * ★ v3.7.0（缓存专项）：本接口是**纯几何**（走向折线 + 本线站点码集合），不含任何实时量
 *   （无车辆位置 / 无到站剩余 / 无等待时长）⇒ 符合缓存红线，允许 CDN 与浏览器双层缓存。
 *
 * ⚠️ **必须同时给 `max-age`**：只写 `s-maxage` 时 Vercel 会把它从**浏览器可见头**里剥掉，
 *   前端拿不到浏览器缓存 ⇒ 只能退回 `fetch(..., { cache: "force-cache" })` ——
 *   那正是现存 3 处 `force-cache` 违规的成因。给了 `max-age` 后缓存只在一层管。
 */
const CACHE_HEADER = {
  "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
};
/**
 * 「本线没有走向数据」的缓存头：**故意短**。
 * 空结果是**可修复状态**（跑一次 `npm run fetch:route-shapes` 就有）⇒ 缓存 1 小时会让
 * 新补的走向在最久 1 小时内不可见；60s 足够挡住重复请求，又不掩盖数据补录。
 */
const EMPTY_HEADER = { "Cache-Control": "public, max-age=60, s-maxage=60" };

interface Row {
  route_code: string;
  kind: string;
  dsat_dir: string;
  polyline: string;
  points: number;
  start_stop: string | null;
  end_stop: string | null;
  min_lng: number | null;
  min_lat: number | null;
  max_lng: number | null;
  max_lat: number | null;
}

export async function GET(req: Request) {
  try {
    const code = new URL(req.url).searchParams.get("code")?.trim() ?? "";
    // ★ v3.6.0（AC-50d）：`error` 只允许六枚举。
    //   ⚠️ 此处**不能**用 `errorResponse()` —— 那会丢掉 `shapes: []` 数组形状，
    //      而客户端把 `shapes` 当地图图层数据源（字段消失 = 白屏，空数组 = 不画线）。
    if (!code) return NextResponse.json({ shapes: [], error: API_ERROR.bad_request }, { status: 400 });

    const pool = getPool();
    const [shapesRes, routeRes, stopsRes] = await Promise.all([
      pool.query(
        `SELECT route_code, kind, dsat_dir, polyline, points, start_stop, end_stop,
                min_lng, min_lat, max_lng, max_lat
           FROM route_shapes WHERE route_code = $1 ORDER BY dsat_dir`,
        [code],
      ),
      pool.query(`SELECT code, kind, color FROM routes WHERE code = $1 LIMIT 1`, [code]),
      // ★ 2026-09-22：本线**站点码集合**（供地图做「本线站点 vs 其他站点」的样式区分）
      //   ⚠️ 只返回**主码**（去站台后缀）——地图上同名站台合成一个点
      pool.query(
        `SELECT DISTINCT s.code
           FROM route_stations rs
           JOIN routes r ON r.id = rs.route_id
           JOIN stations s ON s.code = rs.station_code
          WHERE r.code = $1`,
        [code],
      ),
    ]);

    const rows = shapesRes.rows as Row[];
    const route = routeRes.rows[0] as { code: string; kind: string; color: string | null } | undefined;
    /** 站台码 → 主码（客户端 `mainCodeOf` 同口径的简化版：剥 `/N` 后缀） */
    const stopMain = (raw: string) => raw.replace(/\/\d+$/, "");
    const stops = [...new Set((stopsRes.rows as { code: string }[]).map((r) => stopMain(r.code)))];

    if (!rows.length) {
      return NextResponse.json(
        {
          code,
          kind: route?.kind ?? "bus",
          color: route?.color ?? null,
          shapes: [],
          stops,
          note: "no_shape",
        },
        { headers: EMPTY_HEADER },
      );
    }

    return NextResponse.json(
      {
        code,
        kind: route?.kind === "lrt" ? "lrt" : "bus",
        color: route?.color ?? "#276299",
        stops,
        shapes: rows.map((r) => ({
          dir: r.dsat_dir,
          polyline: r.polyline,
          points: r.points,
          startStop: r.start_stop,
          endStop: r.end_stop,
          bounds: [r.min_lng, r.min_lat, r.max_lng, r.max_lat],
        })),
      },
      { headers: CACHE_HEADER },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/route-shapes] 失败：", msg);
    // ★ v3.6.0（S2）：保留 `shapes: []` 数组形状（客户端按 j.shapes 取值），只把 error 换成枚举。
    return NextResponse.json({ shapes: [], error: API_ERROR.upstream_error }, { status: 500 });
  }
}
