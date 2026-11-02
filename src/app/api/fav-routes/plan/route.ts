/**
 * POST /api/fav-routes/plan —— 按「组合内预设路线」批量算实时方案并排序
 * （2026-09-22 新增）
 *
 * ── 解决什么 ──────────────────────────────────────────────────────────
 *   产品口径：「点组合卡后参与排序的，**只有该组合内已预设好的方案**，
 *   不再使用高德模型与本地模型」。
 *
 *   实现方式：把库里的每条预设路线转成 **`chain`（自定义站链）** 后交给 `planNav` ——
 *   `chain` 非空即 `chainMode = true`，引擎**按链约束枚举、完全不调高德**（见 `nav-service.ts`）
 *   ⇒ 候选集恰好 = 预设路线，**从源头消除高德/本地模型候选** ✓
 *
 * ── 为什么做成批量接口 ────────────────────────────────────────────────
 *   横琴一例就有 13 条预设。若由前端逐条打 `/api/nav?chain=…` ⇒ 手机端 13 次往返，
 *   且服务端每次都要重载静态索引。本接口在**一次请求内**顺序算完全部路线再统一排序，
 *   复用同一次 `planNav` 的静态缓存 ⇒ 明显更快、也不会打爆函数配额。
 *
 * ⚠️ 逐条算 ≠ 合并算：**不能把 13 条并成一条链**（那会把结构相同的路线合并成一张卡，
 *    而产品要求**分开排序、分开显示**）。
 *
 * 只读接口（不改库）。
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { planNav } from "@/lib/nav/nav-service";
import type { ChainStep } from "@/lib/nav/combo-params";
import type { NavPoint } from "@/lib/nav/types";
import { API_ERROR, errorResponse } from "@/lib/http/errors";
import { MAX_FAV_BODY_BYTES, readJsonLimited } from "@/lib/http/body-limit";
import {
  FAV_BUCKET_CAPACITY,
  FAV_QPS,
  RATE_BUCKET,
  acquireToken,
} from "@/lib/amap/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SLUGS = new Set(["home", "school", "gate", "hengqin"]);

interface Seg {
  kind: "walk" | "ride" | "transfer" | "cross_border";
  phase?: "out" | "in";
  route?: string;
  kind2?: "bus" | "lrt";
  board?: string;
  alight?: string;
  boardLabel?: string;
  alightLabel?: string;
  at?: string;
  label?: string;
}

interface Body {
  fromSlug?: string;
  toSlug?: string;
  /** 终点坐标（GCJ-02）—— 由前端带过来（组合里的目的地 POI 坐标） */
  origin?: { lng: number; lat: number; label?: string; kind?: string; code?: string };
  dest?: { lng: number; lat: number; label?: string; kind?: string; code?: string };
  limit?: number;
}

/**
 * `segs`（库里的分段结构）→ `ChainStep[]`（引擎要的站链）。
 *
 * 规则：第 1 段乘车的上车站 = `board` 节点（routes = [该线]）；
 *      中间每段乘车的上车站 = `transfer` 节点（`routes` = 该段线路）；
 *      最后一段乘车的下车站 = `alight` 节点。
 *      `walk` / `cross_border` 段不参与（首末步行由 `planNav` 用起终点自行计算）。
 */
function segsToChain(segs: Seg[]): ChainStep[] {
  const rides = segs.filter((s) => s.kind === "ride" && s.route);
  if (!rides.length) return [];
  const steps: ChainStep[] = [];
  rides.forEach((r, i) => {
    steps.push({
      kind: i === 0 ? "board" : "transfer",
      code: r.board,
      label: r.boardLabel ?? r.board ?? "",
      routes: [r.route as string],
    });
  });
  const last = rides[rides.length - 1];
  steps.push({ kind: "alight", code: last.alight, label: last.alightLabel ?? last.alight ?? "" });
  return steps;
}

export async function POST(req: Request) {
  try {
    // ★ v3.6.0（S2）护栏：`fav` 令牌桶 + 请求体 ≤ 16KB（本接口一次算 13 条链、耗时近 9s，
    //   是最该限流的一个；与另两个收藏写接口共用同一桶配额）
    const rl = await acquireToken(RATE_BUCKET.fav, FAV_QPS, FAV_BUCKET_CAPACITY);
    if (!rl.ok) {
      return errorResponse(API_ERROR.rate_limited, undefined, { "Retry-After": "1" });
    }
    const parsed = await readJsonLimited<Body>(req, MAX_FAV_BODY_BYTES);
    if (!parsed.ok) {
      return errorResponse(API_ERROR.bad_request, parsed.reason === "tooLarge" ? 413 : 400);
    }
    const body = parsed.value;
    const { fromSlug, toSlug, origin, dest } = body ?? {};
    if (!fromSlug || !toSlug || !SLUGS.has(fromSlug) || !SLUGS.has(toSlug)) {
      return errorResponse(API_ERROR.bad_request);
    }
    if (!origin || !dest) {
      return errorResponse(API_ERROR.bad_request);
    }

    const pool = getPool();
    const rows = (
      await pool.query(
        `SELECT route_key, name, route_labels, segs
           FROM favorite_routes
          WHERE from_slug = $1 AND to_slug = $2 AND is_active
          ORDER BY sort_order, id`,
        [fromSlug, toSlug],
      )
    ).rows as { route_key: string; name: string; segs: Seg[] }[];

    if (!rows.length) {
      return NextResponse.json({ ok: true, cards: [], presetTotal: 0, note: "no_preset" });
    }

    const originPoint: NavPoint = {
      kind: (origin.kind as NavPoint["kind"]) ?? "station",
      label: origin.label ?? "出发地",
      lng: origin.lng,
      lat: origin.lat,
      ...(origin.code ? { code: origin.code } : {}),
    };
    const destPoint: NavPoint = {
      kind: (dest.kind as NavPoint["kind"]) ?? "place",
      label: dest.label ?? "目的地",
      lng: dest.lng,
      lat: dest.lat,
      ...(dest.code ? { code: dest.code } : {}),
    };

    /** 逐条按链计算（`chain` 模式 = 按链约束、不调高德） */
    const cards: unknown[] = [];
    const failed: { routeKey: string; reason: string }[] = [];

    // ★ 分批并行（2026-09-22 三次实测调优，结论已定）：
    //   串行 13 条 ≈ 8.9s · 分 4 条一批 ≈ **9.0s** · 全部 13 条并发 ≈ **12.1s**（反而更慢）
    //   ⇒ 说明瓶颈**不在并发度**：每条链都要独立查 DSAT 实时报站，13 路齐发时相互争抢
    //     （上游限流 + 函数冷启动），加大并发只会更糟。
    //   ⇒ 取 4 条一批为最优实测点。**9 秒是这个链路的实际下限**；
    //     真要提速需做层间缓存（`unstable_cache` 缓存原始行）或收敛预设条数，属后续优化项。
    const CHUNK = 4;
    type Row = (typeof rows)[number];
    type Res = { r: Row; card: { summary?: string; totalMin?: number } | null; reason: string | null };

    for (let i = 0; i < rows.length; i += CHUNK) {
      const batch = rows.slice(i, i + CHUNK);
      const done = await Promise.all(
        batch.map(async (r): Promise<Res> => {
          const chain = segsToChain(Array.isArray(r.segs) ? r.segs : []);
          if (chain.length < 2) return { r, card: null, reason: "chain_too_short" };
          try {
            const res = await planNav(pool, { origin: originPoint, dest: destPoint, chain, limit: 1 });
            const card = res.cards?.[0];
            if (!card) return { r, card: null, reason: res.emptyReason ?? "no_candidate" };
            // ★ 覆盖 summary：chain 模式下引擎给的是通用文案（「本地补充」），
            //   而本页要显示**该预设路线的线路名**（如「26 → 25B」）—— 这正是它存在的意义。
            return { r, card: { ...card, summary: r.name }, reason: null };
          } catch (e) {
            // ★ v3.6.0（S2）：失败原因**不回显异常原文**（原实现 `e.message.slice(0,120)`），
            //   细节进服务端日志；对外只留固定码，客户端据此提示「这条预设算不出来」
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[api/fav-routes/plan] ${r.route_key} 计算失败：`, msg);
            return { r, card: null, reason: "plan_failed" };
          }
        }),
      );
      for (const d of done) {
        if (d.card) cards.push({ ...d.card, presetKey: d.r.route_key });
        else failed.push({ routeKey: d.r.route_key, reason: d.reason ?? "unknown" });
      }
    }

    // ★ 排序：总用时升序（与全站 `/nav` 卡片同口径）—— 这就是产品要的「按预设排序」
    (cards as { totalMin?: number }[]).sort((a, b) => (a.totalMin ?? 1e9) - (b.totalMin ?? 1e9));

    return NextResponse.json({
      ok: true,
      cards,
      presetTotal: rows.length,
      failed,
      /** 数据来源说明（前端可显示，便于用户知道「这页只排预设」） */
      source: "preset-chain",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/fav-routes/plan] 失败：", msg);
    // ★ v3.6.0（S2）：异常原文只进服务端日志（原实现 `msg.slice(0,300)` 会回显 SQL/表名）
    return errorResponse(API_ERROR.upstream_error);
  }
}
