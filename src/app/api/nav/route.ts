/**
 * GET /api/nav —— 全澳导航 JSON 接口（v1.3.0 提案 · T03）
 *
 * 输入：起点/终点的 **GCJ-02** 坐标（`fromLng,fromLat,toLng,toLat`），可带展示名与类型。
 * 输出：与旧版 `/api/recommend` **同构**的 `cards`（`RecommendCard[]`）→ T04 直接复用渲染。
 *
 * ★ 坐标系（铁律）：**传入坐标必须已是 GCJ-02**（用户 GPS 在定位层转好 / POI 来自高德）。
 *   本接口**不做** WGS84 转换（内部只在「本地图枚举的近站比较」时把 GCJ→WGS 用于比对）。
 *
 * 参数：
 *   `fromLng` `fromLat` `toLng` `toLat`（必填，GCJ-02）
 *   `fromLabel` `toLabel`（选填，展示名）· `fromKind` `toKind`（gps|poi|station|place）
 *   `fromCode` `toCode`（选填，如 place slug：home/school/hengqin/gate）
 *   `zone`（B/C|N/O|R）· `limit`（默认 `NAV_LIMIT_DEFAULT`）
 *   · `nocache=1` —— ★ 2026-11-06（问题 #6）语义已收窄：主调用**本来就每次真实调高德**，
 *     本参数现在表示「**连失败兜底也不要读** `transit_cache`」（宁失败不给旧拓扑）。
 *   `prefs`（可选：`balanced` 默认 | `fewer_transfers` | `less_walk`；**非法值回落 `balanced`**）
 *   `lrtFirst`（可选：`1`/`true` ⇒ **轻轨优先**置顶；**非法值回落 false**，不 400 —— v3.3.0 · AC-105）
 *
 * ★ v2.3.0（07 §2.1 / 05-Spec §5 修订）：追加**可选**参数 `chain` / `walk` / `tiers`
 *   （编码一律 `encodeURIComponent(JSON.stringify(<结构>))`）—— 承载用户自定义站链与步行参数。
 *   **缺省（不传）行为与 v2.2.0 完全一致**（向后兼容硬约束）；参数存在但非法 → 400。
 *
 * 鉴权：v3.6.0 起 middleware **全站公开**（口令门与白名单已拆）⇒ 本接口匿名可调。
 * 幂等：只写 `transit_cache`（缓存，属正常）、`dsat_call_logs`（记账，属正常）。
 *
 * ── ★ 2026-11-06（问题 #6 · 杜绝实时巴士数据走缓存）──────────────────────
 *   · 高德 transit：**每次请求都真实调用**（`stats.transitFromCache` 正常恒 false）；
 *     `transit_cache` 只在真实调用**两次都失败**时兜底读拓扑，此时
 *     `stats.transitCacheFallback = true`、`stats.transitFromCache = true` —— 两者必须一起看：
 *       `fromCache=true & cacheFallback=false` ⇒ 不该出现的组合（说明有回退路径在读缓存）
 *       `fromCache=true & cacheFallback=true`  ⇒ 高德此刻不可用（查配额/网络，不是正常态）
 *   · DSAT 报站：`live.ts#queryBusBucket` 用 `force=true` **穿透 5s 进程缓存** ⇒
 *     `generatedAt`（及 cards 里的实时字段）就是本次请求真实取数时刻，可直接当「数据时刻」展示。
 *   · 静态索引（`recommend/query.ts`）60s 内复用，但**不含任何实时字段**（见 04-缓存排查.md C4）。
 *   · 全链路上游 `fetch` 均 `cache:"no-store"`（`amap/transit.ts:554`、`dsat/client.ts:130`），
 *     本路由自身也是 `no-store` + `force-dynamic` ⇒ 不存在浏览器/CDN/Next Data Cache 的中间层。
 */
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { planNav } from "@/lib/nav/nav-service";
import { decodeChain, decodeTiers, decodeWalk, type ChainStep, type TierOverride, type WalkOverride } from "@/lib/nav/combo-params";
import { pointOf } from "@/lib/nav/query-params";
import { NAV_LIMIT_DEFAULT } from "@/lib/recommend/limits";
import { parsePrefs } from "@/lib/recommend/score";
import { SCHOOL_ZONES, type SchoolZone } from "@/lib/recommend/types";
import { API_ERROR, errorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ZONE_VALUES = SCHOOL_ZONES.map((z) => z.value);

// ⚠️ 参数解析（`numOf` / `pointOf`）已移到 `src/lib/nav/query-params.ts`。
//   **不要**把它们放回本文件并 export —— route.ts 只允许导出白名单名字
//   （HTTP 方法 + runtime/dynamic 等配置），多导出一个辅助函数会让 `next build`
//   在生成 `.next/types` 时类型检查失败（`tsc --noEmit` 抓不到，见该文件头注释）。

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const origin = pointOf(sp, "from");
  const dest = pointOf(sp, "to");
  if (!origin || !dest) {
    // ★ v3.6.0（AC-50d）：`error` 只允许六枚举。`useRecommend` 已用 `errorTextOf(j.error)`
    //   翻译后渲染 ⇒ 回枚举才是与前端契约一致（旧中文串会被当未知值回落）。
    return NextResponse.json(
      { ok: false, error: API_ERROR.bad_request },
      { status: 400 },
    );
  }

  const zoneParam = sp.get("zone")?.trim();
  const zone: SchoolZone | null = (ZONE_VALUES as string[]).includes(zoneParam ?? "")
    ? (zoneParam as SchoolZone)
    : null;

  const limitRaw = Number(sp.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(20, Math.trunc(limitRaw)) : NAV_LIMIT_DEFAULT;
  const noCache = sp.get("nocache") === "1" || sp.get("nocache") === "true";

  // ★ v2.3.0：可选参数 `chain` / `walk` / `tiers`——存在但非法 → 400（不静默降级）
  let chain: ChainStep[] | undefined;
  let walk: WalkOverride | undefined;
  let tiers: TierOverride | undefined;
  const chainRaw = sp.get("chain");
  if (chainRaw !== null) {
    const d = decodeChain(chainRaw);
    if (!d.ok) return NextResponse.json({ ok: false, error: d.error }, { status: 400 });
    chain = d.chain;
  }
  const walkRaw = sp.get("walk");
  if (walkRaw !== null) {
    const d = decodeWalk(walkRaw);
    if (!d.ok) return NextResponse.json({ ok: false, error: d.error }, { status: 400 });
    walk = d.walk;
  }
  const tiersRaw = sp.get("tiers");
  if (tiersRaw !== null) {
    const d = decodeTiers(tiersRaw);
    if (!d.ok) return NextResponse.json({ ok: false, error: d.error }, { status: 400 });
    tiers = d.tiers;
  }

  // ★ B4（需求 8）：可选参数 `prefs`（balanced | fewer_transfers | less_walk）。
  //   ⚠️ 与 `chain/walk/tiers` 不同：**非法值回落 `balanced`**（不 400）—— 见 07 §i.4。
  const prefs = parsePrefs(sp.get("prefs"));

  // ★ v3.3.0（AC-105）：可选参数 `lrtFirst`（`=1` 或 `=true`）—— **轻轨优先**置顶开关。
  //   ⚠️ 与 `chain/walk/tiers` 不同：**非法值回落 false**（不 400）—— fail-safe，不确定不置顶。
  const lrtFirstRaw = (sp.get("lrtFirst") ?? "").trim().toLowerCase();
  const lrtFirst = lrtFirstRaw === "1" || lrtFirstRaw === "true";

  try {
    const r = await planNav(getPool(), { origin, dest, zone, limit, noCache, chain, walk, tiers, prefs, lrtFirst });
    return NextResponse.json(
      {
        ok: true,
        fromSlug: r.fromSlug,
        toSlug: r.toSlug,
        degraded: r.degraded,
        emptyReason: r.emptyReason ?? null,
        // ★ 2026-11-12（P1）：补透传。`handleRecommend` 一直在读这个字段
        //   （`useRecommend.ts:178` → `RouteResultPane.tsx:153` 的「步行约 X 分钟」），
        //   但服务端从未下发 ⇒ 那句文案自上线起恒不显示（恒 null 的死代码）。
        nearbyWalkMin: r.nearbyWalkMin ?? null,
        generatedAt: new Date(r.generatedAt).toISOString(),
        count: r.cards.length,
        cards: r.cards,
        colors: r.colors,
        excluded: r.excluded,
        missed: r.missed,
        skipped_by_schedule: r.skipped_by_schedule,
        holiday_fallback: r.holiday_fallback,
        provenance: r.provenance,
        stats: r.stats,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/nav] 失败：", msg);
    // ★ v3.6.0（S2）信息外泄收口：原实现把 `msg.slice(0, 500)` 回给客户端，异常原文
    //   可能含 SQL 片段 / 表名 / 环境线索。拆口令门后全站公开，一律改为固定枚举，
    //   细节只留在上面那条服务端日志里。
    return errorResponse(API_ERROR.upstream_error);
  }
}
