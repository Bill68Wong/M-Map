/**
 * GET /api/cross-border/airport/flights —— 澳门国际机场航班（离澳 / 抵澳）
 *
 * ── 一个端点覆盖两条需求的两种切片（契约 §2.1，别拆成两条路径）──────────
 *   需求 5 · 最近五班离澳：`?dir=dep&after=now&limit=5`
 *   需求 6 · 当日所有　　：`?dir=dep`（`after` 默认 `day`，`limit` 默认 200）
 *   同一个资源集合的两种切片，差别只有"起点"与"截断"。拆两条路径必然复制
 *   入参校验 / 排序口径 / 字段归一 / 缓存策略四份逻辑，然后漂移。
 *
 * ── `after` 的语义（负责人裁决 1）─────────────────────────────────────
 *   `now` = 当日全量**先剔除终态**（已起飞/已降落/已取消），再按 `sched_at` 升序取前 `limit`。
 *   ⚠️ **不是**时间过滤。`08:00` 延误到 `20:00` 的航班在 19:00 打开时**必须还在列表里**
 *      —— 它的 `sched_at` 已过但航班没走。若这里（或 SQL 里）出现 `sched_at > now()`，
 *      就是把负责人裁决实现错了。
 *
 * ── 状态：三态空 + stale 降级（契约 §2.5 / §2.6）───────────────────────
 *   · 空态一律 `200 + items: [] + emptyReason`（三值枚举），**永不 204**；
 *   · 上游失败但**有旧数据** ⇒ `200 + stale:true`（响应头 `no-store`）；
 *   · 上游失败且**无任何旧数据** ⇒ `503 upstream_error`。
 *   `error` 字段只用 `API_ERROR` 六值闭集，不新增字符串。
 *
 * ── 缓存（契约 §2.7）──────────────────────────────────────────────────
 *   机场 60s；`max-age` 与 `s-maxage` **必须同时给**（只给 `s-maxage` 会被 Vercel
 *   从浏览器可见头剥掉，本项目踩过两次）。`stale:true` 的响应改 `no-store`。
 *   响应体带 `serverNow`：前端必须用它算"还有几分钟"，不能用浏览器时钟
 *   —— 缓存 TTL 会让 `now` 最多滞后 60s，两端时钟差会让"最近五班"看起来少一班。
 *
 * ── 出口限流 ──────────────────────────────────────────────────────────
 *   复用既有 `amap_rate_bucket`（`bucket` 列是纯 TEXT 主键，无 CHECK 约束 ⇒ 可加新桶名，
 *   已核实）。本端点是只读 GET，限流目的**不是**防资金损失，而是"别让人借本站刷政府接口"。
 *   参数取 5 QPS / 突发 20：一个弹窗同时开机场 + 三码头也够用；真被刷时 429 能挡住放大。
 *
 * ⚠️ route 只装配：不放业务逻辑、**不 export 任何辅助函数**
 *   （Next 的 `.next/types` 导出白名单会让 `next build` 失败，而 `tsc` 抓不到 —— 本项目踩过）。
 */
import { NextRequest, NextResponse } from "next/server";
import { acquireToken } from "@/lib/amap/rate-limit";
import { airportAttribution } from "@/lib/cross-border/attribution";
import {
  isStale,
  lastSeenAtOf,
  refreshFlightsIfStale,
  REFRESH_TTL_SEC,
  todayInMacau,
  tryRefresh,
} from "@/lib/cross-border/freshness";
import { parseAfter, parseDir, parseLimit } from "@/lib/cross-border/params";
import { buildListResponse, CACHE_HEADERS } from "@/lib/cross-border/respond";
import { queryFlights } from "@/lib/cross-border/store";
import { macauIso } from "@/lib/cross-border/time";
import { getPool } from "@/lib/db";
import { API_ERROR, errorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 上游 fetch 超时 10s + 库往返，留 5s 余量 */
export const maxDuration = 15;

/** 出口限流桶（与高德配额桶共用表，靠 bucket 值区分；见文件头） */
const RL_BUCKET = "xborder";
const RL_QPS = 5;
const RL_BURST = 20;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const dir = parseDir(sp.get("dir"));
  const after = parseAfter(sp.get("after"));
  const limit = parseLimit(sp.get("limit"));
  // 任一参数非法 ⇒ 400（**不静默纠正**：`limit=999` 被悄悄改成 200 会让调用方以为拿到全部）
  if (!dir || !after || limit === null) return errorResponse(API_ERROR.bad_request);

  const rl = await acquireToken(RL_BUCKET, RL_QPS, RL_BURST);
  if (!rl.ok) return errorResponse(API_ERROR.rate_limited, 429, { "Retry-After": "1" });

  const pool = getPool();
  const schedDate = todayInMacau();
  const scope = `airport/${dir} ${schedDate}`;

  try {
    // 1) 必要时采集（新鲜则跳过；别的实例在采则跳过）。永不因采集失败而中断响应
    const refresh = await tryRefresh(scope, () => refreshFlightsIfStale(dir, schedDate, pool));

    // 2) 新鲜度（= max(last_seen_at)）与数据
    const fetchedAt = await lastSeenAtOf({ table: "flights", schedDate, direction: dir }, pool);
    const { items, dayTotal } = await queryFlights(
      { schedDate, direction: dir, after, limit },
      pool,
    );

    // 3) 彻底没有数据且本轮采集失败 ⇒ 503（这一层区分是"空态"还是"上游挂了"的关键）
    if (!refresh.ok && fetchedAt === null) {
      console.error(`[xborder] ${scope} 无旧数据且采集失败：${refresh.error ?? "unknown"}`);
      return errorResponse(API_ERROR.upstream_error, 503);
    }

    // `stale` = 数据超过 TTL 的 2 倍 **或** 本轮试过但失败了（后者保证"暂时无法更新"能显示出来，
    // 否则一次失败的采集在 2 个 TTL 内看不出来，用户以为一切正常）
    const stale = isStale(fetchedAt, REFRESH_TTL_SEC.airport) || (refresh.attempted && !refresh.ok);

    const payload = buildListResponse({
      items,
      dayTotal,
      after,
      serverNow: macauIso(),
      dataFetchedAt: fetchedAt === null ? null : macauIso(fetchedAt),
      stale,
      // ⚠️ 署名由服务端下发（唯一真相），前端不得硬编码
      attribution: airportAttribution(fetchedAt),
      scope,
    });

    return NextResponse.json(payload, {
      headers: stale ? CACHE_HEADERS.stale : CACHE_HEADERS.airport,
    });
  } catch (e) {
    console.error(`[xborder] ${scope} 查询失败：`, (e as Error).message);
    return errorResponse(API_ERROR.upstream_error);
  }
}
