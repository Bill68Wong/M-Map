/**
 * POST /api/nav/remaining —— 导航中「只重算时间、不重新规划路线」（需求1 · 1-B′）
 *
 * ── 解决什么 ──────────────────────────────────────────────────────────
 *   导航中点刷新时，`card.totalMin` / `card.arriveAt` 是**规划时刻的快照**
 *   （`model.ts:817/879`），走了 20 分钟仍显示「19.3 分」；纵条「车上约 N 分」
 *   也来自同一份快照（`strips.ts:134`）⇒ 顶部与纵条一起冻住。
 *   本端点**在当前这条路线内**重算剩余时间并**整形整份 `strips`**，
 *   不重新规划、不切换路线、不提示更快方案（产品已拍板口径）。
 *
 * ── 入参 / 出参 ────────────────────────────────────────────────────────
 *   入：`{ card, legIndex, segRemainSec?, nextIdx?, clientNowMs? }`
 *     · `card` 与 `/api/nav` 响应的 `cards[]` 元素同构（前端已持有，直接回传）
 *     · `legIndex` 当前所在载具段下标；`segRemainSec` 本段区间剩余秒数（可 null）
 *     · `nextIdx` 本段「下一站」在站条里的下标（仅 `segRemainSec` 缺失时用于精确回退）
 *     · `clientNowMs` **只用于日志诊断**，不参与计算（服务端时钟为准）
 *   出：`{ ok, remainingMin, arriveAt, recomputedAt, serverNowMs, strips }`
 *     · `strips` = `buildStrips(patchedCard, ctx)` 的**整份**产物（替换前端现有那份）
 *     · `patchedCard` **绝不下发** —— 前端若存回 state 会污染
 *       `RecommendCard.tsx:143` 的 `rides.slice(1).reduce(waitMin)` 加总
 *
 * ── 为什么必须同时给 `arriveAt` + `recomputedAt` + `serverNowMs` ─────────
 *   `/api/station/eta` 踩过这个坑并给了正解（`station/eta/route.ts:114-120`）：
 *   相对快照（`etaSec`）命中缓存时会整体偏大，用户实测反馈「时间不准确」。
 *   ⇒ **相对值（`remainingMin`）只用于显示，绝对锚（`arriveAt`）才是倒计时真相**：
 *     客户端算 `offsetMs = serverNowMs − Date.now()`，再用
 *     `left = arriveAt − (Date.now() + offsetMs)` ⇒ 免疫网络往返与缓存陈旧。
 *   `recomputedAt` = 本次重算的基准时刻；命中进程内微缓存时它**早于** `serverNowMs`，
 *   客户端据此可知 `remainingMin` 的陈旧量（≤ `CACHE_TTL_MS`）。
 *
 * ── 红线（硬约束，不是优化建议）────────────────────────────────────────
 *   **0 次 DSAT、0 次高德。** 本文件只 `loadStatics` / `loadHeadway` 读**已缓存**的静态索引。
 *   实测热路径单次计算亚毫秒（`lookupHop` 0.0006ms / `headwayAt` 0.0012ms / `buildStrips` ≈0.009ms）。
 *   **不许**改成「服务端自取车辆帧」：2 次 DSAT × 高频轮询会打满 `DSAT_QPS=3` 的**全局单桶**
 *   （约 7 并发用户），且新 purpose 不进 `skipBreaker` 会撞开全局熔断、静默计时器 30 分钟。
 *
 * ── 鉴权 / 限流 ────────────────────────────────────────────────────────
 *   中间件已按 ADR-106 拆口令门 ⇒ 本路径无需白名单登记；同源校验（AC-50c 同款）在 handler 内做。
 *   ⚠️ **不用** `acquireToken()`：它一次 GET/UPDATE 事务（含 `pg_advisory_xact_lock`）在生产
 *   实测约 230ms（`dsat/client.ts:45`）⇒ 会把亚毫秒端点直接打穿，属净负收益。
 *   真限流由「进程内 2s 微缓存去重」承担（见下），只挡「轮询与手动刷新撞一起」的重复请求。
 *
 * 只读接口，无副作用（不写库、不写缓存到 DB）。
 */
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { isSameOrigin } from "@/lib/security/same-origin";
import { loadStatics } from "@/lib/recommend/query";
import { loadHeadway, type HeadwayIndex } from "@/lib/recommend/headway";
import { nowBucketOfHolidayAware } from "@/lib/rebuild/holidays";
import { buildStrips } from "@/lib/nav/strips";
import { recomputeRemaining } from "@/lib/nav/remaining";
import { logSameOriginReject } from "@/lib/nav/remaining-log";
import type { RecommendCard, RemainingResponse } from "@/lib/recommend/types";
import { API_ERROR, errorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * 进程内微缓存 TTL（ms）。
 *
 * 目的**不是**提速（热路径本来就是亚毫秒），而是合并「12s 自动轮询 + 手动刷新」撞在一起的重复请求。
 * ⚠️ 取 2s 而不是更长：`remainingMin` 是相对快照，陈旧量直接等于 TTL；且客户端以
 * `arriveAt` 绝对锚为准，2s 陈旧只影响首帧显示。
 */
const CACHE_TTL_MS = 2_000;
/**
 * 微缓存容量上限（条）。
 *
 * ★ 硬约束：**必须有上限 + 淘汰**。现存 6 处 `globalThis` 缓存（`__switchPlansCache` 等）
 *   全是裸 `Map.set`、只判 `ts` 是否命中、旧条目永不删除 —— 那些键空间有限所以侥幸无害，
 *   但本端点是**高频**调用，键里又带随时段变化的桶值 ⇒ 无上限就是单调增长的内存泄漏。
 */
const CACHE_MAX = 200;

/**
 * 缓存里存的就是完整响应 + `ts`（写入时刻，供 TTL/淘汰判定）。
 * `recomputedAt` 已含在 `RemainingResponse` 里 —— 命中缓存时它保持写入时的旧值，
 * 而 `serverNowMs` 在出站前用当前时刻覆盖 ⇒ 客户端可算 `serverNowMs − recomputedAt`
 * 得到「这份 `remainingMin` 已过时多久」。两个字段都要，不能只留一个。
 */

/**
 * 微缓存键：**方案身份 + 段号 + 时间桶**。
 *
 * ⚠️⚠️ **不能只用 `planId`**（这是我第一版的真缺陷）：
 *   `planId` 是「该方案在**本次** `planNav` 结果里的序号」（`OptionSeed.planId`），
 *   不同 OD / 不同用户的两次规划**会有相同 `planId`**（例如都是 `1`）⇒
 *   同一 2s 桶内 A 的卡会命 B 的缓存，**静默串数据**（比没有缓存糟得多）。
 *   ⇒ 必须再拼一份**路线指纹**（每段的 `route:board>alight`），它标识「这条具体路线」，
 *     且**不含任何进度字段**（不进 `segRemainSec` / `nextIdx` / `passedIdx`）。
 *
 * ⚠️ 为什么指纹里放 `route/board/alight` 是安全的外层键、不算「键空间膨胀」：
 *   这三者共同决定「哪条路线」，一次规划里只有个位数种取值，**不随行程变化**；
 *   而 `segRemainSec`（连续值）/ `passedIdx`（每站一跳就变）才是会单调增长的那类，
 *   它们**一律不进键**（裁决 B）。
 */
function cardKeyOf(card: RecommendCard): string {
  const chain = card.rides.map((r) => `${r.route}:${r.board}>${r.alight}`).join("\u2192");
  /**
   * 静态时间摘要 —— 补掉「同线路同上下站、但不同 OD」的串数据窄口子。
   *
   * 场景（前端提出、我确认成立）：「家→学校」与「家→学校隔壁」可能用**同一条线、同一上落站**
   * ⇒ `planId` 与 `route:board>alight` 指纹**完全相同**，但末段步行/换乘步行不同
   * ⇒ 剩余时间不同。若只凭 `planId|指纹` 做键，2s 内会被另一张卡命中，`remainingMin` 静默偏差。
   *
   * ⚠️ 这里只能放**卡的静态属性**（一次规划内恒定、不随行程变化）：
   *     `rides[].minutes` / `transfers[].minutes` / `walkIn.minutes` 都是规划值，
   *     客户端**始终回传未打补丁的原卡**（前端只 `setLiveStrips(j.strips)`，不碰 card）
   *     ⇒ 它们在整段行程内稳定，进键不会膨胀。
   * ⚠️ **仍然不得**放入 `segRemainSec` / `nextIdx` / `passedIdx`（连续或每站跳变 ⇒ 键空间单调增长）。
   *     代价：同一张卡在 2s 桶内换了 `segRemainSec` 会命中旧值 —— 那是**设计意图**
   *     （合并重复请求），陈旧量 ≤ `CACHE_TTL_MS` 由客户端 `staleSec` 扣掉。
   *
   * 效果：静态时间摘要**恰好把「有害命中」和「无害命中」分开** ——
   *   摘要不同 ⇒ 不命中（正确）；摘要相同 ⇒ 两张卡的下游时间轴本就一致，
   *   命中只差 ≤2s 的 `segRemainSec`，无害。
   */
  const staticTimes = [
    ...card.rides.map((r) => r.minutes),
    ...(card.transfers ?? []).map((t) => t.minutes),
    card.walkIn?.minutes ?? 0,
  ].join(",");
  return `${card.planId}|${chain}|${staticTimes}`;
}

const g = globalThis as unknown as {
  __navRemainingCache?: Map<string, { ts: number; data: RemainingResponse }>;
};
if (!g.__navRemainingCache) g.__navRemainingCache = new Map();

/**
 * 写入微缓存（**受容量约束**）。
 * 淘汰顺序：先删已过期 → 仍超限则按 Map 插入序删除最旧（Map 迭代序 = 插入序，等价 FIFO/LRU 近似）。
 */
function cachePut(key: string, data: RemainingResponse, nowMs: number): void {
  const m = g.__navRemainingCache!;
  if (m.size >= CACHE_MAX) {
    for (const [k, v] of m) if (nowMs - v.ts >= CACHE_TTL_MS) m.delete(k);
    while (m.size >= CACHE_MAX) {
      const oldest = m.keys().next();
      if (oldest.done) break;
      m.delete(oldest.value);
    }
  }
  m.set(key, { ts: nowMs, data });
}

/** 浅校验一条载具段（与 `detail-body` 同口径：只认 route / board / alight 为字符串） */
function rideOk(r: unknown): boolean {
  const x = r as { route?: unknown; board?: unknown; alight?: unknown } | null;
  return (
    !!x && typeof x.route === "string" && typeof x.board === "string" && typeof x.alight === "string"
  );
}

export async function POST(req: NextRequest) {
  // ── ① 同源校验（AC-50 认可的防护调用；纯 header 比较，0 次 DB）──
  //   放最前：省掉非法请求的 JSON 解析与连接占用。
  if (!isSameOrigin(req)) {
    // 403 诊断日志抽到 `@/lib/nav/remaining-log`（route 有 300 行硬门禁 + 可复用 + 可单测）。
    // ⚠️ 这条日志是**线上唯一可观测痕迹**（客户端 403 全程静默，详见该模块头注释）——
    //    `scripts/test-remaining-route.ts` ① 段有断言守着它，不要删、不要加 dev-only 门控。
    logSameOriginReject("[api/nav/remaining]", req);
    return errorResponse(API_ERROR.forbidden);
  }

  // ── ② 解析 + 校验（任何非法 → 400，不静默降级）──
  let body: {
    card?: RecommendCard;
    legIndex?: unknown;
    segRemainSec?: unknown;
    nextIdx?: unknown;
    clientNowMs?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse(API_ERROR.bad_request);
  }

  const card = body?.card;
  if (!card || !Array.isArray(card.rides) || !card.rides.length) return errorResponse(API_ERROR.bad_request);
  if (!card.rides.every(rideOk)) return errorResponse(API_ERROR.bad_request);
  // `planId` 是缓存键的一部分 ⇒ 必须是有限数值（缺失时键会退化成 `undefined|…`，
  //   让不同卡互相命中）。真实卡恒有值，故拒绝而非兜底。
  const planId = Number(card.planId);
  if (!Number.isFinite(planId)) return errorResponse(API_ERROR.bad_request);

  const legIndex = Number(body?.legIndex);
  if (!Number.isFinite(legIndex) || legIndex < 0 || legIndex >= card.rides.length) {
    return errorResponse(API_ERROR.bad_request);
  }
  const rawSegSec = body?.segRemainSec;
  const segRemainSec =
    rawSegSec === null || rawSegSec === undefined || rawSegSec === "" ? null : Number(rawSegSec);
  if (segRemainSec !== null && (!Number.isFinite(segRemainSec) || segRemainSec < 0)) {
    return errorResponse(API_ERROR.bad_request);
  }
  const rawNextIdx = body?.nextIdx;
  const nextIdx = rawNextIdx === null || rawNextIdx === undefined ? null : Number(rawNextIdx);
  if (nextIdx !== null && !Number.isFinite(nextIdx)) return errorResponse(API_ERROR.bad_request);

  const nowMs = Date.now();
  // 缓存键：`方案指纹（不含任何进度字段）| 段号 | 2s 时间桶`。
  //   ⚠️ **不得**把 `segRemainSec` / `nextIdx` / `passedIdx` 放进键：它们是连续值或
  //     每站一跳就变的量，进键等于「每次必 miss + 每次新增一条」⇒ 键空间随行程单调增长
  //     且让缓存退化成内存泄漏源。宁可命中率低一点。
  const ckey = `${cardKeyOf(card)}|${Math.trunc(legIndex)}|${Math.floor(nowMs / CACHE_TTL_MS)}`;
  const hit = g.__navRemainingCache!.get(ckey);
  if (hit && nowMs - hit.ts < CACHE_TTL_MS) {
    /**
     * 命中缓存。**只刷 `serverNowMs`，其余三个时间字段一律保持写入时的原值。**
     *
     * ⚠️⚠️ **不变量（改这里之前先读完）**：
     *   · `recomputedAt` **必须**保持写入时的旧值 —— 它是「这份 `remainingMin` 算出来的时刻」。
     *     客户端用 `staleSec = (serverNowMs − recomputedAt)/1000` 扣掉这段陈旧；
     *     若这里把它也刷成 `nowMs`，`staleSec` 会**恒为 0** ⇒ 陈旧扣除**静默失效**、
     *     `remainingMin` 退回「命中缓存即偏大 ≤2s」的老问题，且**没有任何报错**。
     *   · `arriveAt` / `remainingMin` **必须成对保持**（两者来自同一次重算）。
     *     去 `compute` 段看：`arriveAt` 是由 `remainingMin` 反推的 ⇒ 二者恒满足
     *     `arriveAt === recomputedAt + remainingMin × 60_000`（残差 0ms，
     *     由 `scripts/test-remaining.ts` ⑫ 段 8 个用例锁定）。
     *     若只刷其中一个，前端「总时长」与「到达时刻」会在同一屏上互相打架。
     *   · 也就是说：这是**方案 (a)「arriveAt 与 remainingMin 一起缓存」**，不是
     *     (b)「用当前时刻 + 旧 remainingMin 重算 arriveAt」。(b) 会破坏上述恒等式。
     */
    return NextResponse.json(
      { ...hit.data, serverNowMs: nowMs },
      { headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const pool = getPool();
    const st = await loadStatics(pool);
    const nowBucket = await nowBucketOfHolidayAware(pool, nowMs);
    // 单段卡没有「下游候车」可重估 ⇒ 跳过 loadHeadway（省冷路径 3 条 SQL）
    const headway: HeadwayIndex | null =
      card.rides.length > 1 ? await loadHeadway(pool) : null;

    const { remainingMin, arriveAtMs, patchedCard } = recomputeRemaining(
      { routeIdx: st.routeIdx, segIdx: st.segIdx, nowBucket, headway },
      { card, legIndex, segRemainSec, nextIdx, nowMs },
    );

    const strips = buildStrips(patchedCard, {
      routeIdx: st.routeIdx,
      segIdx: st.segIdx,
      nameOf: st.routeIdx.nameOf,
      nowBucket,
    });

    const data: RemainingResponse = {
      ok: true,
      remainingMin,
      arriveAt: arriveAtMs,
      recomputedAt: nowMs,
      serverNowMs: nowMs,
      strips,
    };
    cachePut(ckey, data, nowMs);
    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    // ★ 异常原文只进服务端日志（AC-50d：响应体不得含内部信息）
    //   `clientNowMs` 一并落日志：它与服务端 `nowMs` 的差可用来排查设备时钟偏移
    //   （这是该入参**唯一**的用途 —— 它不参与任何计算，见文件头「入参」）。
    const clientNowMs = Number(body?.clientNowMs);
    console.error(
      "[api/nav/remaining] 失败：",
      (e as Error).message,
      `planId=${planId} legIndex=${Math.trunc(legIndex)}`,
      Number.isFinite(clientNowMs) ? `clientSkewMs=${Math.round(clientNowMs - nowMs)}` : "clientSkewMs=?",
    );
    return errorResponse(API_ERROR.upstream_error);
  }
}
