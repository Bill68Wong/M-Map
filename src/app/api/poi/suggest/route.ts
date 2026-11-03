/**
 * POI 搜索建议 API（src/app/api/poi/suggest/route.ts，v1.3.0 · T02）
 *
 * GET/POST `/api/poi/suggest?q=<关键字>&mode=type|enter&lat=&lng=`
 *   · `mode=type`（默认）—— **打字阶段**：只查本地别名库，**0 高德配额**、秒回。
 *   · `mode=enter`       —— **回车阶段**：本地优先；本地无带坐标命中才调高德（消耗配额）。
 * 返回 `PoiSuggestResponse`（有坐标候选 `results` / 无坐标本地命中 `pending` / 灰字提示 `hint`+`hintText`）。
 *
 * ── 公开性（★ 必做，R-10）─────────────────────────────────────────────
 *   本端点是**公众搜索**的入口，必须匿名可用。v3.6.0 起 `src/proxy.ts` 已**全站公开**
 *   （口令门与 `PUBLIC_PREFIXES` 白名单一并拆除）⇒ 本端点天然可用，**不要再往任何白名单加东西**。
 *   若将来恢复上锁，本端点必须重新登记，否则公众搜不了。
 *
 * ── 不阻塞 ────────────────────────────────────────────────────────────
 *   DB / 高德任何失败都**收敛为空结果**（HTTP 200，不 5xx），保证下拉区不炸。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §2.A / §2.A.6 / §2.E（公开性口径）。
 */
import { NextRequest, NextResponse } from "next/server";
import { suggest } from "@/lib/nav/poi-search";
import type { PoiSuggestResponse } from "@/lib/nav/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_Q_LEN = 50;
const NO_STORE = { "Cache-Control": "no-store" } as const;

const numOrUndef = (v: string | null): number | undefined => {
  if (v === null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function emptyResp(mode: "type" | "enter"): PoiSuggestResponse {
  return { mode, results: [], pending: [], quotaConsumed: 0 };
}

/** 解析入参（GET 用 query；POST 先 query 再 body 兜底） */
async function parseParams(
  req: NextRequest,
): Promise<{ q: string; mode: "type" | "enter"; lat?: number; lng?: number; forceAmap: boolean }> {
  const sp = req.nextUrl.searchParams;
  let q = sp.get("q") ?? "";
  let modeRaw = sp.get("mode");
  let lat = numOrUndef(sp.get("lat"));
  let lng = numOrUndef(sp.get("lng"));
  // ★ 修复包 v2.2.1-B7：显式「强制走高德」开关（点「点搜索确认」行时由前端下发）
  let forceAmap = sp.get("forceAmap") === "1" || sp.get("forceAmap") === "true";

  if (req.method === "POST") {
    try {
      const body = (await req.json()) as Record<string, unknown> | null;
      if (body && typeof body === "object") {
        if (!q && typeof body.q === "string") q = body.q;
        if (!modeRaw && typeof body.mode === "string") modeRaw = body.mode;
        if (lat === undefined && typeof body.lat === "number") lat = body.lat;
        if (lng === undefined && typeof body.lng === "number") lng = body.lng;
        if (!forceAmap && (body.forceAmap === true || body.forceAmap === 1)) forceAmap = true;
      }
    } catch {
      /* 无 body / 非法 JSON → 忽略，用 query */
    }
  }

  return {
    q: q.trim().slice(0, MAX_Q_LEN),
    mode: modeRaw === "enter" ? "enter" : "type",
    lat,
    lng,
    forceAmap,
  };
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const { q, mode, lat, lng, forceAmap } = await parseParams(req);

  if (!q) return NextResponse.json(emptyResp(mode), { headers: NO_STORE });

  // ⚠️ lat/lng 约定为 **GCJ-02**（与高德/别名库一致）。若客户端给的是 WGS84，仅轻微影响排序
  //    （澳门 GCJ 偏移约 600m，对下拉候选排序影响很小；精确转换在定位层统一处理）。
  const userPos = lat !== undefined && lng !== undefined ? { lat, lng } : undefined;

  try {
    const r = await suggest(q, { mode, userPos, forceAmap });
    return NextResponse.json(r, { headers: NO_STORE });
  } catch (e) {
    // 不阻塞：搜索失败也返回 200 空结果，避免下拉区报错
    console.error("[poi/suggest]", (e as Error)?.message ?? e);
    return NextResponse.json(emptyResp(mode), { headers: NO_STORE });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
