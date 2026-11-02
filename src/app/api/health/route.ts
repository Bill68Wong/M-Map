/**
 * GET /api/health —— 部署健康检查 + 缓存观测（v3.6.1 · ★ v3.7.0 扩 `cache` 段与 `?warm=1`）
 *
 * ── 用途 ──────────────────────────────────────────────────────────────
 *   外部（uptime 探测 / 团队成员 / 运维 / 验收脚本）**只读**判定四件事：
 *     ① 服务活着；
 *     ② `unstable_cache` 的跨实例 Data Cache **是否真的在写** ——
 *        静态 payload 超 Next 单条 2MB 上限时生产是 `console.warn` + 静默跳过
 *        （不抛错不 500），只看日志永远发现不了。详见 `src/lib/recommend/query.ts` 的观测段；
 *     ③ 缓存体积是否**接近**上限（`oversize-warning`，见 RL9）；
 *     ④ 进程内站序索引的年龄（「改了站序但没发版」的可观测性）。
 *
 * ── `?warm=1`（v3.7.0）────────────────────────────────────────────────
 *   Serverless 会把 health 派到**另一个没装载过静态数据**的实例 ⇒ 缺省读到的永远是
 *   `status: "not-run"`（不是故障，是「这台实例还没干活」）。
 *   带 `warm=1` 时在**同一请求内**先 `await loadStatics()`（+ `loadRouteIndex()`）再读观测，
 *   于是拿到的是**真的装载结果**。判据（QA 用）：
 *     `cache.staticRows.status === "ok"` 且 `sizeBytes ∈ [0.8MB, 2MB)`。
 *   ⚠️ 缺省（不带 `warm`）**不装载**：health 必须保持「无依赖也能 200」，
 *      否则库一抖 uptime 探测就全红。
 *
 * ── 字段口径（只增不改）────────────────────────────────────────────────
 *   `ok`          —— 服务存活（既有字段，语义不变）
 *   `staticCache` —— 既有观测对象原样透出（含 `probe` 往返探针；语义不变）
 *   `cache`       —— v3.7.0 新增的**摘要视图**（验收脚本读这一段）：
 *     · `staticRows`      `{ status, sizeBytes, limitBytes, fallbackUsed }`（读 `__staticCacheObs`）
 *     · `transitCacheTtl` `TRANSIT_CACHE_TTL_SEC`（Spec R4 要求保持 60）
 *     · `regions`         `VERCEL_REGION`；**读不到就 `"unknown"`，不猜测**
 *     · `routeIndexAgeSec` 进程内站序索引年龄（秒）；从未装载 ⇒ `null`（不是 0）
 *     · `warmRequested` / `warmError` 本次是否要求预热、以及预热失败原因（不掩盖失败）
 *
 * ── 鉴权 / 门禁 ───────────────────────────────────────────────────────
 *   公开只读（GET，无凭据、无写库；`warm=1` 只读库）。v3.6.0 起 middleware 全站公开、
 *   无 API 白名单 ⇒ 无需登记。响应**不含任何内部信息**（无密钥状态、无连接串、无 SQL）。
 *
 * ── 缓存 ──────────────────────────────────────────────────────────────
 *   `Cache-Control: no-store`：这是诊断端点，缓存它等于让观测失真。
 */
import { getStaticCacheObs, loadStatics } from "@/lib/recommend/query";
import { TRANSIT_CACHE_TTL_SEC } from "@/lib/amap/transit";
import { getPool } from "@/lib/db";
import { loadRouteIndex, routeIndexAgeSecOf } from "@/lib/dsat/route-index";
import { versionDriftOf, type VersionDrift } from "@/lib/nav/progress-freshness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 本请求实际执行的函数区域。
 * Vercel 在运行时注入 `VERCEL_REGION`（如 `hkg1`）；本地 / 非 Vercel 环境没有 ⇒ `"unknown"`。
 * ⚠️ 不要用 `vercel.json` 的 `regions` 反推：部署配置在运行时不可读，硬编码等于编造。
 */
function regionsOf(): string[] | "unknown" {
  const r = (process.env.VERCEL_REGION ?? "").trim();
  return r ? [r] : "unknown";
}

export async function GET(req: Request) {
  const warmRequested = new URL(req.url).searchParams.get("warm") === "1";
  let warmError: string | null = null;
  let versionDrift: VersionDrift | null = null;

  if (warmRequested) {
    try {
      // 顺序装载：静态行（含段统计）→ 站序索引 → 两表版本漂移。都只为让下面的观测有意义。
      const pool = getPool();
      await loadStatics(pool);
      await loadRouteIndex(pool);
      /**
       * ★ v3.7.0（AC5.7）：`route_shapes` 与 `route_station_mileage` 的版本漂移。
       * 漂移超 1 小时 ⇒ 大概率「改了道但没跑 `npm run db:station-mileage`」，
       * 此时 `p` 的分母是旧值、车辆会被钉在区间端点 ⇒ 匹配算法偏差可达一整段。
       * **只在 warm 下查**：health 必须保持「无依赖也能 200」（uptime 探测用裸端点）。
       */
      versionDrift = await versionDriftOf(pool);
    } catch (e) {
      // 预热失败**不改变状态码**（health 仍要能回答「服务活着」），但要如实回报，
      // 否则「预热失败」会被读成「缓存正常」——又是一种把未观测当正常的错误。
      warmError = e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120);
    }
  }

  const staticCache = await getStaticCacheObs();
  return Response.json(
    {
      ok: true,
      /** 当前进程静态数据的 Data Cache 状态（既有字段，原样保留） */
      staticCache,
      /** ★ v3.7.0：缓存口径摘要（验收脚本读这一段） */
      cache: {
        staticRows: {
          status: staticCache.status,
          sizeBytes: staticCache.sizeBytes,
          limitBytes: staticCache.limitBytes,
          fallbackUsed: staticCache.fallbackUsed,
        },
        transitCacheTtl: TRANSIT_CACHE_TTL_SEC,
        regions: regionsOf(),
        /** 进程内站序索引年龄（秒）；null = 本实例还没装载过（不是 0） */
        routeIndexAgeSec: routeIndexAgeSecOf(),
        /** 两表版本漂移（仅 `warm=1` 时计算；null = 未查或查询失败，不编造 0） */
        versionDrift,
        warmRequested,
        warmError,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
