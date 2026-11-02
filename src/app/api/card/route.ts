/**
 * 预测卡片详情数据接口（src/app/api/card/route.ts，v1.1.8）
 *
 * 为什么单独开一个接口（而不是让详情页复用 `/api/recommend`）：
 *   详情页要的三块数据里，只有「命中卡」在 `/api/recommend` 里，
 *   另外两块是**列表页没有的新数据**：
 *     · 该站台**所有**可达线路的实时报站（可能含方案表外的线，如 C653 的 N3、C690/3 的 N5）
 *     · 每段载具的**逐站站序 + 逐跳预测时长**（供纵向站条）
 *   一趟拿齐 = 详情页不依赖前一页、不冻结数据、可分享可刷新。
 *
 * ⚠️ 与 `/api/recommend` 同规格：nodejs / force-dynamic。函数区域由项目级
 *    `vercel.json: "regions": ["hkg1"]`（v3.7.0 · ADR C1）决定，勿在 route 里写 `preferredRegion`。
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { cardDetail } from "@/lib/recommend/card";
import { parseCardQuery } from "@/lib/recommend/card-link";
import { API_ERROR } from "@/lib/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const sp = Object.fromEntries(new URL(req.url).searchParams) as Record<string, string>;
  const p = parseCardQuery(sp);
  if (!p) {
    // ★ v3.6.0（AC-50d）：`error` 只允许六枚举。前端 `CardDetailClient` 已用
    //   `errorTextOf(j.error)` 翻译 ⇒ 回枚举正是它现在的期望（旧中文串会回落成通用文案）。
    return NextResponse.json({ ok: false, error: API_ERROR.bad_request }, { status: 400 });
  }
  try {
    const r = await cardDetail(getPool(), {
      fromSlug: p.from,
      toSlug: p.to,
      zone: p.zone,
      limit: p.limit,
      planId: p.plan,
      route: p.route,
      board: p.board,
      alight: p.alight,
      force: sp.force === "1",
    });
    if (!r.ok) {
      // 200 + 错误码：客户端据此显示「返回自動選線」，而不是当成网络故障
      return NextResponse.json({ ok: false, error: r.error }, { status: 200, headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({ ok: true, ...r.data }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // ★ v3.6.0（S2）信息外泄收口：异常原文只进服务端日志，客户端只拿固定枚举。
    //   前端负责把枚举翻成用户语言（`src/lib/ui/error-text.ts`），枚举值本身不上屏。
    console.error("[api/card] 详情计算失败：", msg);
    return NextResponse.json({ ok: false, error: API_ERROR.upstream_error }, { status: 200, headers: { "cache-control": "no-store" } });
  }
}
