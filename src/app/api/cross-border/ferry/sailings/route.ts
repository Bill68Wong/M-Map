/**
 * GET /api/cross-border/ferry/sailings —— 三码头船班次（离港 / 到港）
 *
 * 结构、`after` 语义、空态/stale、缓存头、限流全部与
 * `../airport/flights/route.ts` 同构（同一份契约 §2.3 / §2.5 / §2.7），差异只有三处：
 *
 *   ① 必填 `pier`（`PE` 外港 / `TP` 氹仔 / `PI` 内港），它同时是采集与查询的作用域；
 *   ② 缓存 30s（上游页面 `<meta refresh=30>`，我方取同值；机场是 60s）；
 *   ③ 署名文本用海事局那套（**必须含官方自称「澳門特別行政區海事及水務局」**），
 *      且展示文本一律上游原文 —— 条款「均不可以修改任何內容」。
 *
 * ⚠️ 本端点**不提供**任何到 `departure.aspx` / `arrival.aspx` 的外链：
 *   海事局条款允许直连首页，连非首页需事前书面授权。可对外链接只有 `links.ts` 的
 *   `MARINE_HOME`（首页），且链接文字必须是官方名称。
 *
 * ⚠️ route 只装配：不放业务逻辑、不 export 辅助函数（Next `.next/types` 白名单）。
 */
import { NextRequest, NextResponse } from "next/server";
import { acquireToken } from "@/lib/amap/rate-limit";
import { marineAttribution } from "@/lib/cross-border/attribution";
import {
  isStale,
  lastSeenAtOf,
  refreshSailingsIfStale,
  REFRESH_TTL_SEC,
  todayInMacau,
  tryRefresh,
} from "@/lib/cross-border/freshness";
import { parseAfter, parseDir, parseLimit, parsePier } from "@/lib/cross-border/params";
import { buildListResponse, CACHE_HEADERS } from "@/lib/cross-border/respond";
import { querySailings } from "@/lib/cross-border/store";
import { macauIso } from "@/lib/cross-border/time";
import { getPool } from "@/lib/db";
import { API_ERROR, errorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** 与机场共用同一个出口桶（同一个用户在同一个弹窗家族里操作，分开计数没有意义） */
const RL_BUCKET = "xborder";
const RL_QPS = 5;
const RL_BURST = 20;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const pier = parsePier(sp.get("pier"));
  const dir = parseDir(sp.get("dir"));
  const after = parseAfter(sp.get("after"));
  const limit = parseLimit(sp.get("limit"));
  if (!pier || !dir || !after || limit === null) return errorResponse(API_ERROR.bad_request);

  const rl = await acquireToken(RL_BUCKET, RL_QPS, RL_BURST);
  if (!rl.ok) return errorResponse(API_ERROR.rate_limited, 429, { "Retry-After": "1" });

  const pool = getPool();
  const sailDate = todayInMacau();
  const scope = `ferry/${pier}/${dir} ${sailDate}`;

  try {
    const refresh = await tryRefresh(scope, () =>
      refreshSailingsIfStale(pier, dir, sailDate, pool),
    );

    const fetchedAt = await lastSeenAtOf(
      { table: "sailings", sailDate, pier, direction: dir },
      pool,
    );
    const { items, dayTotal } = await querySailings(
      { sailDate, pier, direction: dir, after, limit },
      pool,
    );

    if (!refresh.ok && fetchedAt === null) {
      console.error(`[xborder] ${scope} 无旧数据且采集失败：${refresh.error ?? "unknown"}`);
      return errorResponse(API_ERROR.upstream_error, 503);
    }

    const stale = isStale(fetchedAt, REFRESH_TTL_SEC.ferry) || (refresh.attempted && !refresh.ok);

    const payload = buildListResponse({
      items,
      dayTotal,
      after,
      serverNow: macauIso(),
      dataFetchedAt: fetchedAt === null ? null : macauIso(fetchedAt),
      stale,
      attribution: marineAttribution(fetchedAt),
      scope,
    });

    return NextResponse.json(payload, {
      headers: stale ? CACHE_HEADERS.stale : CACHE_HEADERS.ferry,
    });
  } catch (e) {
    console.error(`[xborder] ${scope} 查询失败：`, (e as Error).message);
    return errorResponse(API_ERROR.upstream_error);
  }
}
