/**
 * GET /api/recommend —— 自动选线 JSON 接口（v1.0.0）
 *
 * 用途：① `/recommend` 页的「刷新」按钮（带 force=1 穿透 10s 缓存）
 *      ② 只读探针 / 性能压测（拿结构化 stats 核对桶数与 DSAT 调用数）
 *
 * 参数：`from` `to`（place slug：home / school / hengqin / gate）
 *      `zone`（B/C | N/O | R，默认 N/O）· `limit`（默认 `RECOMMEND_LIMIT_DEFAULT`）· `force=1`（绕过缓存）
 *
 * ⚠️ 函数区域：v3.7.0（ADR C1）起由**项目级** `vercel.json: "regions": ["hkg1"]` 决定
 *    （原 `preferredRegion = "sin1"` 是 route 段配置，Hobby 下不生效、真身 iad1 ⇒ 已清理）。
 *    要改区域改 `vercel.json`，**不要**在这里加回 `preferredRegion` —— 那只会误导后来人。
 *
 * 鉴权：v3.6.0 起 middleware **全站公开**（口令门已拆）⇒ 本接口匿名可调，靠 CDN/内存缓存
 *   与上游令牌桶控量，无需凭据。
 * 幂等只读：本接口不写任何表（DSAT 调用会记 `dsat_call_logs`，属正常记账）。
 */
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { RECOMMEND_LIMIT_DEFAULT } from "@/lib/recommend/limits";
import { recommend } from "@/lib/recommend/service";
import { parsePrefs } from "@/lib/recommend/score";
import { DEFAULT_ZONE, SCHOOL_ZONES, type SchoolZone } from "@/lib/recommend/types";
import { API_ERROR } from "@/lib/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 预算 0.5~1.5s；留足余量（Hobby 上限 60s） */
export const maxDuration = 30;

const ZONE_VALUES = SCHOOL_ZONES.map((z) => z.value);

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from")?.trim();
  const to = sp.get("to")?.trim();
  if (!from || !to) {
    // ★ v3.6.0（AC-50d）：`error` 只允许六枚举（前端 `errorTextOf` 负责翻译）
    return NextResponse.json({ error: API_ERROR.bad_request }, { status: 400 });
  }

  const zoneParam = sp.get("zone")?.trim();
  const zone: SchoolZone = (ZONE_VALUES as string[]).includes(zoneParam ?? "")
    ? (zoneParam as SchoolZone)
    : DEFAULT_ZONE;

  const limitRaw = Number(sp.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(20, Math.trunc(limitRaw)) : RECOMMEND_LIMIT_DEFAULT;
  const force = sp.get("force") === "1" || sp.get("force") === "true";

  // ★ B4（需求 8）：可选参数 `prefs`（balanced | fewer_transfers | less_walk）；
  //   **非法值回落 `balanced`**（不 400）。
  const prefs = parsePrefs(sp.get("prefs"));

  try {
    const r = await recommend(getPool(), { fromSlug: from, toSlug: to, zone, limit, force, prefs });
    return NextResponse.json(
      {
        ok: true,
        from: r.fromSlug,
        to: r.toSlug,
        zone: r.zone,
        cached: r.cached,
        generatedAt: new Date(r.generatedAt).toISOString(),
        count: r.cards.length,
        cards: r.cards,
        colors: r.colors,
        excluded: r.excluded,
        missed: r.missed,
        // ★ 2026-11-04（U8）：因「不在运营窗口 ∧ 无车」被隐藏的线路（诊断位，与上两位并列）
        skipped_by_schedule: r.skipped_by_schedule,
        stats: r.stats,
      },
      // 结果本身有 10s 缓存，但**响应必须不缓存**（刷新语义由 force 控制）
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/recommend] 失败：", msg);
    return NextResponse.json({ ok: false, error: API_ERROR.upstream_error }, { status: 500 });
  }
}
