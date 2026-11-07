/**
 * POST /api/nav/switch-plans —— 详情页「本站台其他线路 · 可切换方案」（2026-09-24 新增）
 *
 * ── 解决什么 ──────────────────────────────────────────────────────────
 *   用户在导航详情页看到「当前方案从 S 站坐 25 路」时，想知道**同一站台**还能坐别的哪条线、
 *   各自门到门要多久。服务端枚举「从 S 站出发、首程线路 ≠ 当前线路」的组合，
 *   逐个建模成**完整 RecommendCard** —— 前端拿到即可直接打开新导航界面（不重算）。
 *
 * ── 本文件只负责「编排」────────────────────────────────────────────────
 *   解析/校验 → **在飞合流** → 限流 → 出站 JSON。
 *   业务计算（枚举/建模/实时）全在 `src/lib/nav/switch-plans-compute.ts`
 *   （口径、坐标系、降级值清单见该文件头注释）。
 *
 * ── ★ 2026-11-06（问题 #6 · 杜绝实时巴士导航数据走缓存）────────────────────
 *   **删除了原有的 20s 进程内响应缓存**。它缓存的是 `plans[].card` —— 已算好的
 *   **实时数字**（`liveText`「还有 N 站」/ `waitMin` / `totalMin` / `altBuses`）。
 *   20s 是 DSAT 自身 5s 粒度的 4 倍，也是「车辆 12s 一帧」的可感知量级
 *   ⇒ 详情页关掉再点开（同一站台同一目的地）会看到 20s 前的到站读数，用户会判定「走的缓存」。
 *
 *   替代防护 = **在飞合流**（in-flight coalescing）：同一 `ckey` 的请求若**正在进行**，
 *   后来的请求直接等同一份 Promise；**Promise 一旦落地即从表里删掉**
 *   ⇒ 「已完成的旧结果永不复用」，不存在「数据陈旧」的窗口，只合并真正的重复在途请求。
 *
 *   ⚠️ 三条实测得出的硬约束（写错任何一条，合流都等于不存在）：
 *     ① **登记必须同步完成**，不能放在任何 `await` 之后。实测：把
 *        `inflight.set()` 放在 `await acquireToken()` 之后时，4 个并发同键请求
 *        **全部**看到空表 → DSAT 调用量正好 4 倍（76 行 vs 单请求 19 行）。
 *        现在的写法是「先建 Promise（其内部才 await 限流）→ 立刻登记」，单线程下
 *        第二个请求进入时必然能看见它。
 *     ② **合流的返回值必须带 HTTP 状态**，不能只共享 `SwitchPlansResponse`：
 *        限流 429 也要能让每个等待者拿到 429，而不是被抹成一个成功响应。
 *     ③ 落地即删（`finally` + 身份比对），且**绝不缓存结果** —— 存结果就退化成缓存，
 *        那就回到「20s 前的到站读数」这个已被负责人明确否决的行为。
 *
 *   为什么敢把令牌桶放在合流之后：被合并的请求**不新增任何 DSAT 负载**，
 *   `RATE_BUCKET.dsat` 应该只对「真正新增的工作」计数。不同 key 的请求照旧各扣一枚
 *   令牌 ⇒ 滥用面没有被放大（实测限流仍在：第 5 个不同 key 的突发会被 3 QPS × 容量 30 卡住）。
 *
 * 幂等：只读（本地索引 + DSAT 实时），无副作用、不落库。
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import type { RecommendCard } from "@/lib/recommend/types";
import { computeSwitchPlans, type SwitchPlansResponse } from "@/lib/nav/switch-plans-compute";
import { API_ERROR, errorResponse } from "@/lib/http/errors";
import { DSAT_BUCKET_CAPACITY, DSAT_QPS, RATE_BUCKET, acquireToken } from "@/lib/amap/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export type { SwitchPlanItem, SwitchPlansResponse } from "@/lib/nav/switch-plans-compute";

/** 合流单元 = 「最终要写回去的 HTTP 结果」（状态码必须一起共享，见文件头 ②） */
interface SwitchWork {
  status: number;
  body: object;
  headers: Record<string, string>;
}

/**
 * 在飞请求表（键 = `上车站|dest|当前首程线路`）。
 *
 * ⚠️ **只存 Promise，不存结果** —— 落地即删。存结果就退化成缓存。
 * ⚠️ 必须有上限：键空间小（站点 × 目的地 × 首程线路），但匿名可调，不能无界增长。
 */
const INFLIGHT_MAX = 100;
const g = globalThis as unknown as {
  __switchPlansInflight?: Map<string, Promise<SwitchWork>>;
};
if (!g.__switchPlansInflight) g.__switchPlansInflight = new Map();

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  // ── ① 解析 + 校验（非法 → 400）──
  let body: { card?: RecommendCard; dest?: { lng?: unknown; lat?: unknown; name?: unknown } };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse(API_ERROR.bad_request);
  }
  const card = body?.card;
  if (!card || !Array.isArray(card.rides) || !card.rides.length) {
    return errorResponse(API_ERROR.bad_request);
  }
  for (const r of card.rides) {
    if (!r || typeof r.route !== "string" || typeof r.board !== "string" || typeof r.alight !== "string") {
      return errorResponse(API_ERROR.bad_request);
    }
  }
  const dLng = Number(body?.dest?.lng);
  const dLat = Number(body?.dest?.lat);
  if (!Number.isFinite(dLng) || !Number.isFinite(dLat)) {
    return errorResponse(API_ERROR.bad_request);
  }
  const destName = typeof body?.dest?.name === "string" ? body.dest.name.trim() : "";

  // ── ② 在飞合流（不做任何按时间的复用；登记同步完成，见文件头 ①）──
  const ckey = `${card.rides[0].board}|${dLng.toFixed(4)}|${dLat.toFixed(4)}|${card.rides[0].route}`;
  const inflight = g.__switchPlansInflight!;
  const running = inflight.get(ckey);
  if (running) {
    // 同一刻已有同键请求在算 ⇒ 共享它的结果（不新开 DSAT 批次，也不返回任何旧数据）
    const w = await running;
    return NextResponse.json(w.body, { status: w.status, headers: { ...NO_STORE, ...w.headers } });
  }

  // ── ③ 计算单元（限流在其内部；Promise 一建好就登记，任何 await 之前）──
  const work: Promise<SwitchWork> = (async (): Promise<SwitchWork> => {
    // 限流：本接口是全站**最高的匿名放大面** —— 一次请求经 `fetchLive` 打出多个 DSAT 桶，
    //   实测约 19~25 次 DSAT 调用。与 `/api/station/eta`、`/api/nav/detail-body` 共用
    //   `dsat` 桶（复用 `amap_rate_bucket`，无 DDL）。
    const rl = await acquireToken(RATE_BUCKET.dsat, DSAT_QPS, DSAT_BUCKET_CAPACITY);
    if (!rl.ok) {
      return {
        status: 429,
        body: { ok: false, error: API_ERROR.rate_limited },
        headers: { "Retry-After": "1" },
      };
    }
    const data: SwitchPlansResponse = await computeSwitchPlans(getPool(), {
      card,
      dest: { lng: dLng, lat: dLat, name: destName },
    });
    return { status: 200, body: data, headers: {} };
  })();

  if (inflight.size >= INFLIGHT_MAX) {
    const oldest = inflight.keys().next();
    if (!oldest.done) inflight.delete(oldest.value);
  }
  inflight.set(ckey, work);
  try {
    const w = await work;
    return NextResponse.json(w.body, { status: w.status, headers: { ...NO_STORE, ...w.headers } });
  } finally {
    // 落地即删：同一键的下一次请求**必然重算**（这就是「不复用旧结果」的结构性保证）
    if (inflight.get(ckey) === work) inflight.delete(ckey);
  }
}
