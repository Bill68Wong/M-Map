import { NextRequest, NextResponse } from "next/server";
import { queryEta, type EtaBus } from "@/lib/dsat/eta";
import { getPool } from "@/lib/db";
import { nowBucketOfHolidayAware } from "@/lib/rebuild/holidays";
import { loadStatics } from "@/lib/recommend/query";
import { headwayAt, loadHeadway } from "@/lib/recommend/headway";
import { collectMoving, fetchLocSegments, toBusArrival } from "@/lib/recommend/live";
import { API_ERROR, errorResponse } from "@/lib/http/errors";
import {
  DSAT_BUCKET_CAPACITY,
  DSAT_QPS,
  RATE_BUCKET,
  acquireToken,
} from "@/lib/amap/rate-limit";

/** 就近部署：Supabase 新加坡池化器 → sin1 */

/**
 * GET /api/dsat/eta?station=T358&routes=26,51A&dir=0&dest=C688[&force=1]
 * 实时车距（薄封装，核心逻辑在 src/lib/dsat/eta.ts 与自动快照共用）
 * 5s 缓存已内置于 queryEta（按 站|线路|dir|dest 聚合；v0.8.1 10s → 5s）
 * force=1：系统打点（depart/wait_start/alight）绕过缓存直查并回写；手动刷新不带
 *
 * ★ v3.6.0（S2）：拆除口令门后本接口**公开可调**（它是导航详情的报站数据源），
 *   因此加**出口限流**（`dsat` 令牌桶，复用 `amap_rate_bucket` 表，无 DDL）——
 *   否则任何人可借本站消耗 DSAT 配额。超桶 ⇒ 429（固定枚举 `rate_limited`）。
 */
export async function GET(req: NextRequest) {
  // 限流放在最前（含缓存命中）：缓存省的是上游调用，不是请求本身，公开接口的滥用面是请求量。
  const rl = await acquireToken(RATE_BUCKET.dsat, DSAT_QPS, DSAT_BUCKET_CAPACITY);
  if (!rl.ok) {
    return errorResponse(API_ERROR.rate_limited, undefined, { "Retry-After": "1" });
  }

  const sp = req.nextUrl.searchParams;
  const station = sp.get("station")?.trim() ?? "";
  const routesParam = sp.get("routes")?.trim() ?? "";
  const dir = sp.get("dir")?.trim() || "0";
  const dest = sp.get("dest")?.trim() || "";
  const force = sp.get("force") === "1";

  if (!station || !routesParam) {
    return errorResponse(API_ERROR.bad_request);
  }
  const routes = routesParam
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, 6); // 最多 6 条（与 queryEta/fleet-snapshot 上限一致；横琴 6 线方案不再截断）
  if (routes.length === 0) {
    return errorResponse(API_ERROR.bad_request);
  }

  // v0.20.9：可选「按线路指定站台」smap=26:M9/2,51:M9/4（合并卡各线站台不同）
  const smapParam = sp.get("smap")?.trim() ?? "";
  let stationByRoute: Record<string, string> | undefined;
  if (smapParam) {
    stationByRoute = {};
    for (const pair of smapParam.split(",")) {
      const [r, st] = pair.split(":");
      if (r && st) stationByRoute[r.trim()] = st.trim();
    }
  }
  const data = await queryEta(station, routes, dir, dest, force, stationByRoute);

  // ★ v3.5.0：「还有 N 站」全面量化——对在途/在站车补单值「约 X 分钟」（含区间进度位置修正）。
  //   整体 try/catch：任何一环失败 → 只返回原 data（旧行为，前端自动降级不显示分钟）。
  try {
    const pool = getPool();
    const st = await loadStatics(pool);
    const nowBucket = await nowBucketOfHolidayAware(pool, Date.now());
    const results = data.results as unknown as {
      route: string;
      ok: boolean;
      dir?: string;
      nearest?: EtaBus;
      second?: EtaBus;
      rest?: EtaBus[];
      eta?: unknown;
      eta2?: unknown;
      waitLo?: number;
      waitHi?: number;
    }[];
    const moving = collectMoving(results);
    const locOf = await fetchLocSegments(pool, moving);
    for (const r of results) {
      if (!r.ok || !r.nearest) continue;
      const plate = r.nearest.plate ?? null;
      r.eta = toBusArrival(
        st.routeIdx,
        st.segIdx,
        r.route,
        r.dir ?? dir,
        r.nearest,
        nowBucket,
        plate ? (locOf.get(`${r.route}|${plate}`) ?? null) : null,
      );
      if (r.second) {
        const p2 = r.second.plate ?? null;
        r.eta2 = toBusArrival(
          st.routeIdx,
          st.segIdx,
          r.route,
          r.dir ?? dir,
          r.second,
          nowBucket,
          p2 ? (locOf.get(`${r.route}|${p2}`) ?? null) : null,
        );
      }
    }
    // ★ v3.5.1：**未发车量化**——无在途车的线路按「发车间隔」估「下一班约 X~Y 分」
    //   （口径与 estimateWait 降级一致：下界未知 → [0, 间隔上限]；Interval 表缺失则该线不出估算）
    const hwIdx = await loadHeadway(pool);
    const nowMs2 = Date.now();
    for (const r of results) {
      if (!r.ok || r.nearest) continue;
      const hit = headwayAt(hwIdx, r.route, nowMs2);
      if (hit) {
        r.waitLo = 0;
        r.waitHi = hit.hi;
      }
    }
  } catch {
    /* 量化增强失败 → 保持原响应（前端不显示分钟） */
  }

  return NextResponse.json(data);
}
