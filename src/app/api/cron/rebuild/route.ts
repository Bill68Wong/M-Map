/**
 * GET/POST /api/cron/rebuild —— 派生数据定时重算（v0.25.0，v1.0.0 加第三步）
 *
 * 背景：segment_stats（站间时长）、walk_times（步行时长）、transfer_walks（换乘步行）是从原始样本
 * 算出的**派生表**，此前只能手动跑 `npm run db:segments` / `db:walktimes` / `db:transferwalks`
 * 才会更新 —— 新样本进来后派生值会停留在上次运行命令的时刻。本路由把重算自动化，由 Vercel Cron
 * 每日触发（见 vercel.json），保证派生数据跟着样本走。
 *
 * ⚠️ 「原始样本」**逐表不同**（v4.2.0 起）：
 *   · `segment_stats` ← **只** `segment_samples.source='track'`（DSAT 报站帧自动采集）；
 *     **不读** timer_sessions / timer_events / free_rides / free_ride_events 四张旧表。
 *   · `walk_times` / `transfer_walks` ← **仍读** `timer_events` 等旧表（它们没有 track 版样本）。
 *   ⇒ 不要一刀切成「本路由不读事件表」—— 只有站间时长这一项换了口径。
 *
 * 实现要点：直接 import src/lib/rebuild/* 的共享函数，**不** execFile 调 .ts 脚本。
 *   原因：① tsx 在 devDependencies，Vercel 生产构建不装；
 *        ② Serverless 只打包被 import 的模块，.ts 脚本文件不会进函数产物。
 *   连库用 src/lib/db 的 getPool()（生产自动指向 DATABASE_URL = Supabase）。
 *
 * 鉴权：Vercel Cron 请求带 `Authorization: Bearer $CRON_SECRET`。
 *   配了 CRON_SECRET → 必须匹配；未配 → 仅在非 production 放行（本地调试）。
 *   （middleware 已把本路径加入白名单，不走口令门，见 src/proxy.ts）
 *
 * 安全：重算本身幂等（清表后全量重算）；仍加内存锁避免重叠执行，
 *   并按顺序串行各步骤（都读 segment_samples / 事件表，串行避免连接竞争）。
 *
 * ★ v4.2.0（2026-11-09 负责人裁定）：segment_stats 口径改为 **`sampleFrom: "track"`**
 *   —— 只吃 `segment_samples.source='track'` 的自动采集样本。旧手工记录（timer / free）
 *   只留档、不参与计算。**不要再改回 `both`**：`both` 会把四张旧事件表重新混进来
 *   （历史上它就是"新旧合并"口径，v1.3.0~v4.1.x 的生产值）。
 *   ⇒ 改口径只需改这一处；生效时点为「下次 18:00 cron」或「手动 CLI 重建」。
 * ★ 2026-09-27：滚动窗口清理**已关闭**（`trimSegmentSampleWindow(pool, 0)` ⇒ 只回报不删除）。
 *   原行为为「只保留最近 30 轮 track」（timer 永不删）；关闭原因 = 用户要求「保留所有轮」。
 *   如需恢复窗口，把下面的 0 改回具体轮数（如 100），并同步 `import-segment-samples.ts` 的默认值。
 *
 * 幂等：可重复调用。
 */
import { NextRequest, NextResponse } from "next/server";
import { cleanupXborder } from "@/lib/cross-border/store-write";
import { addDays, macauDate } from "@/lib/cross-border/time";
import { getPool } from "@/lib/db";
import { rebuildSegmentStats } from "@/lib/rebuild/segment-stats";
import { trimSegmentSampleWindow } from "@/lib/rebuild/segment-samples";
import { rebuildTransferWalks } from "@/lib/rebuild/transfer-walks";
import { rebuildWalkTimes } from "@/lib/rebuild/walk-times";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Vercel Hobby 计划函数上限 60s；三个重算当前合计数秒，数据长大后仍有余量 */
export const maxDuration = 60;

/** 进程内互斥：同实例并发请求直接拒绝，不排队（避免雪崩）。
 *  ⚠️ 用「时间戳 + 过期」而非布尔：若某次执行被 maxDuration 掐断或进程被回收，
 *  finally 不会执行 —— 布尔锁会永久卡在 true 让端点彻底失联（v0.25.0 实测踩到）。
 *  超过 STALE_MS 视为陈旧锁，自动放行。 */
let runningSince = 0;
const STALE_MS = 5 * 60_000;
const isLocked = () => runningSince !== 0 && Date.now() - runningSince < STALE_MS;

interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  summary: Record<string, unknown>;
  err?: string;
}

/** 鉴权：Vercel Cron 带 Bearer CRON_SECRET */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // 未配密钥：仅本地 debug 放行，生产环境拒绝（防公开触发）
    return process.env.NODE_ENV !== "production";
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth === `Bearer ${secret}`) return true;
  // 兼容手动触发（带上 ?key=）
  return req.nextUrl.searchParams.get("key") === secret;
}

/** 跑一个重算步骤，吞掉异常转为 ok=false（不中断另一步骤） */
async function step(name: string, fn: () => Promise<Record<string, unknown>>): Promise<StepResult> {
  const t0 = Date.now();
  try {
    const summary = await fn();
    return { name, ok: true, ms: Date.now() - t0, summary };
  } catch (e) {
    return {
      name,
      ok: false,
      ms: Date.now() - t0,
      summary: {},
      err: String(e instanceof Error ? e.message : e).slice(0, 1000),
    };
  }
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }
  if (isLocked()) {
    return NextResponse.json({ error: "上一次重算仍在进行", running: true }, { status: 409 });
  }

  runningSince = Date.now();
  const t0 = Date.now();
  try {
    const pool = getPool();
    const results: StepResult[] = [];

    // 顺序执行：各步骤都读 timer_events / segment_samples，串行可避免 DB 连接竞争
    // ⓪ 滚动窗口：**自动清理已关闭**（2026-09-27 用户要求「保留所有轮」）——
    //    keepRuns=0 ⇒ trim 只回报现状、**不删除任何行**（timer 本就不删）。
    //    ⚠️ 若未来需要重新启用窗口（如容量/性能考量），把 0 改回具体轮数即可（如 100）。
    //    保留此步骤是为了让返回体继续报告剩余轮数（监控用）。
    results.push(
      await step("segment_samples_window", async () => {
        const r = await trimSegmentSampleWindow(pool, 0);
        return { deleted: r.deleted, remaining: r.remaining, remainingRuns: r.remainingRuns };
      }),
    );
    // ① segment_stats：★ v4.2.0 口径 `sampleFrom="track"`（只吃自动采集，旧手工表不参与）。
    //    改回 `both` 会让四张旧事件表重新混进来 —— 见文件头 v4.2.0 段落，勿动。
    results.push(
      await step("segment_stats", async () => {
        const r = await rebuildSegmentStats(pool, { sampleFrom: "track" });
        return {
          sessions: r.sessions,
          rides: r.rides,
          samples: r.samples,
          written: r.inserted,
          pairs: r.pairs.length,
        };
      }),
    );
    results.push(
      await step("walk_times", async () => {
        const r = await rebuildWalkTimes(pool);
        return {
          scanned: r.scanned,
          collected: r.collected,
          valid: r.valid,
          inserted: r.inserted,
          totalSamples: r.totalSamples,
        };
      }),
    );
    // v1.0.0 第三步：换乘步行（alight → wait_start）—— 供自动选线的换乘方案计时
    results.push(
      await step("transfer_walks", async () => {
        const r = await rebuildTransferWalks(pool);
        return {
          scanned: r.scanned,
          collected: r.collected,
          valid: r.valid,
          inserted: r.inserted,
          totalSamples: r.totalSamples,
        };
      }),
    );

    // v3.8.0 第四步：跨境交通两张表的保留窗口清理（`xborder_flights` / `xborder_sailings`）。
    //   保留 `sched_date >= 澳门当日 - 2`：需求只显示当日，留 2 天是为了排查
    //   "昨天为什么是空表"。**复用本 cron 槽位**——Hobby 每个 job 每天只能触发一次，
    //   为此新增一个 cron 只会多一个失败点，零收益（契约 §1.7）。
    //   ⚠️ 边界用**澳门日期**算，不用 SQL 的 `current_date`：Supabase 会话时区是 UTC，
    //      在澳门 00:00–08:00 之间 `current_date` 会比澳门日期早一天（详见 store-write.ts）。
    results.push(
      await step("xborder_cleanup", async () => {
        const before = addDays(macauDate(), -2);
        if (!before) throw new Error("澳门日期计算失败");
        const r = await cleanupXborder(before, pool);
        return { before, flights: r.flights, sailings: r.sailings };
      }),
    );

    const allOk = results.every((r) => r.ok);
    return NextResponse.json(
      {
        ok: allOk,
        totalMs: Date.now() - t0,
        results,
      },
      { status: allOk ? 200 : 500 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 1000) },
      { status: 500 },
    );
  } finally {
    runningSince = 0;
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
