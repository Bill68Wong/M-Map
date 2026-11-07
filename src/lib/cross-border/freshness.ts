/**
 * 新鲜度 + 单飞（src/lib/cross-border/freshness.ts · 契约 §3.2 / §3.3）
 *
 * ── 为什么不建"采集时刻表" ─────────────────────────────────────────────
 *   `MAX(last_seen_at)` 本身就等于"上次成功采集时刻"（每轮 upsert 必刷新它）。
 *   而且它有**天然的正确降级**：上游失败 ⇒ 本轮无 upsert ⇒ `max` 停在旧值
 *   ⇒ TTL 判定自然变 stale。零额外逻辑、零额外表、失败路径不需要额外处理。
 *
 * ── 为什么用 `pg_try_advisory_lock`（会话级）而不是项目里既有的 `_xact_` 版本 ──
 *   采集要跨多个 `await`（fetch → parse → upsert），**不能**长时间占着一个事务
 *   （Supabase 事务池会把长事务当成异常）。`pg_advisory_xact_lock` 是事务级，
 *   会随事务提交释放，包不住这段流程。
 *   而 `try` 版本拿不到锁就**立即返回**（单飞），不是排队 —— 符合"宁可这一轮不采，
 *   也不让用户等"：另一个实例正在采，我直接读库就行。
 *   ⚠️ 会话级锁必须由**同一条连接**解锁，故这里 `pool.connect()` 独占客户端并在
 *      `finally` 里 `pg_advisory_unlock` + `release`（连接回收时锁也会随之释放，双保险）。
 *
 * ── 为什么"不采"也是一种成功 ────────────────────────────────────────────
 *   `refresh*` 把**上游/解析/写库**的异常收进 `ok:false` 返回值，不抛；
 *   但"连不上数据库"这类连接层异常仍会上抛（此时连旧数据也读不到，只能由路由整体兜底）。
 *   路由统一用 `tryRefresh()` 包一层，再按"有没有旧数据"决定 503 还是 `stale:true`
 *   —— 这个判断是**路由的职责**，不该由采集层替它决定。
 */
import type { Pool } from "pg";
import { fetchAirportFlights } from "./airport/fetch";
import { parseAirportFlights } from "./airport/parse";
import { fetchFerryPage } from "./ferry/fetch";
import { parseFerrySailings } from "./ferry/parse";
import {
  upsertFlights,
  upsertSailings,
  voidMissingFlights,
  voidMissingSailings,
} from "./store-write";
import { macauDate } from "./time";
import type { PierCode, XbDir } from "./types";

/**
 * 采集间隔上限（秒）：**决定的不是"多久抓一次"，而是"多久内复用已抓的"**。
 *   机场 120s：上游平台标注 5 分钟更新，120s 让"最近五班"的边界滞后 ≤ 2min，可接受。
 *   船　 60s：官方页面 `<meta refresh=30>` 是给浏览器看的节拍；我方 60s 更克制
 *           （本项目的采集强度有过事故，见 `docs/复盘-GitHub封号事故-20261028.md`）。
 */
export const REFRESH_TTL_SEC = { airport: 120, ferry: 60 } as const;

/** 超过 TTL 的多少倍就判 `stale:true`（前端显示"暂时无法更新"） */
const STALE_FACTOR = 2;

export interface RefreshOutcome {
  /** 是否真的尝试了拉取（false = 还新鲜 / 别人正在采） */
  attempted: boolean;
  /** 拉取并落库是否成功（只有 attempted=true 时有意义） */
  ok: boolean;
  /** 失败原因（只进服务端日志；不回客户端） */
  error?: string;
  /** 本轮写入了多少行（诊断用） */
  written?: number;
  /** 被标失效的行数（诊断用） */
  voided?: number;
}

/** 某作用域的上次成功采集时刻；从未采集过 ⇒ null */
export async function lastSeenAtOf(
  scope:
    | { table: "flights"; schedDate: string; direction: XbDir }
    | { table: "sailings"; sailDate: string; pier: PierCode; direction: XbDir },
  pool: Pool,
): Promise<Date | null> {
  const sql =
    scope.table === "flights"
      ? `SELECT max(last_seen_at) AS at FROM xborder_flights
          WHERE sched_date = $1::date AND direction = $2`
      : `SELECT max(last_seen_at) AS at FROM xborder_sailings
          WHERE sail_date = $1::date AND pier = $2 AND direction = $3`;
  const params =
    scope.table === "flights"
      ? [scope.schedDate, scope.direction]
      : [scope.sailDate, scope.pier, scope.direction];
  const res = await pool.query(sql, params);
  const at = (res.rows[0] as { at: Date | null } | undefined)?.at ?? null;
  return at === null ? null : new Date(at);
}

/**
 * 是否过期到必须提示"暂时无法更新"。
 * 从未成功采集过（null）**不算 stale** —— 那是 `emptyReason='not_yet_collected'` 的语义，
 * 两者混用会让前端同时显示"数据获取中"和"暂时无法更新"。
 */
export function isStale(fetchedAt: Date | null, ttlSec: number, now = Date.now()): boolean {
  if (fetchedAt === null) return false;
  return now - fetchedAt.getTime() > ttlSec * STALE_FACTOR * 1000;
}

/** 单飞执行：拿到锁才跑，拿不到立即返回（不排队） */
async function withAdvisoryLock<T>(
  key: string,
  pool: Pool,
  fn: () => Promise<T>,
): Promise<{ acquired: boolean; value?: T }> {
  const client = await pool.connect();
  try {
    const lock = await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [key]);
    if (!(lock.rows[0] as { ok: boolean } | undefined)?.ok) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [key]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/**
 * 机场：必要时拉取并落库。
 *
 * 顺序（契约 §2.9）：新鲜 ⇒ 跳过 → 抢锁 → 拉 → 解析 → upsert → void 缺席行。
 *
 * 异常边界：**上游/解析/写库的异常都被收进 `ok:false`**（不抛）。只有"连不上数据库"
 * 这类连接层异常会继续上抛 —— 那种情况连旧数据也读不到，必须由路由整体兜底
 * （路由用 `tryRefresh()` 包一层，再决定 503）。
 */
export async function refreshFlightsIfStale(
  direction: XbDir,
  schedDate: string,
  pool: Pool,
): Promise<RefreshOutcome> {
  const fetchedAt = await lastSeenAtOf({ table: "flights", schedDate, direction }, pool);
  const fresh =
    fetchedAt !== null && Date.now() - fetchedAt.getTime() < REFRESH_TTL_SEC.airport * 1000;
  if (fresh) return { attempted: false, ok: true };

  const { acquired, value } = await withAdvisoryLock(
    `xborder:airport:${direction}`,
    pool,
    async () => {
      // ⚠️ roundStart 必须在 fetch **之前**取：它是 void 判定里"本轮见过"的分界线
      const roundStart = new Date();
      try {
        const raw = await fetchAirportFlights(direction);
        const rows = parseAirportFlights(raw, direction, roundStart);
        const written = await upsertFlights(rows, pool);
        const voided = await voidMissingFlights({ schedDate, direction, roundStart }, pool);
        return { ok: true, written, voided, error: undefined };
      } catch (e) {
        const error = (e as Error).message ?? String(e);
        console.error(`[xborder] airport ${direction} 采集失败：${error}`);
        return { ok: false, written: 0, voided: 0, error };
      }
    },
  );

  if (!acquired) return { attempted: false, ok: true };
  return { attempted: true, ...value! };
}

/** 船：同机场，作用域多一个 `pier`（这也是锁键的粒度） */
export async function refreshSailingsIfStale(
  pier: PierCode,
  direction: XbDir,
  sailDate: string,
  pool: Pool,
): Promise<RefreshOutcome> {
  const fetchedAt = await lastSeenAtOf({ table: "sailings", sailDate, pier, direction }, pool);
  const fresh =
    fetchedAt !== null && Date.now() - fetchedAt.getTime() < REFRESH_TTL_SEC.ferry * 1000;
  if (fresh) return { attempted: false, ok: true };

  const { acquired, value } = await withAdvisoryLock(
    `xborder:ferry:${pier}:${direction}`,
    pool,
    async () => {
      const roundStart = new Date();
      try {
        const html = await fetchFerryPage(pier, direction);
        const rows = parseFerrySailings(html, pier, direction, roundStart);
        const written = await upsertSailings(rows, pool);
        const voided = await voidMissingSailings({ sailDate, pier, direction, roundStart }, pool);
        return { ok: true, written, voided, error: undefined };
      } catch (e) {
        const error = (e as Error).message ?? String(e);
        console.error(`[xborder] ferry ${pier}/${direction} 采集失败：${error}`);
        return { ok: false, written: 0, voided: 0, error };
      }
    },
  );

  if (!acquired) return { attempted: false, ok: true };
  return { attempted: true, ...value! };
}

/**
 * 兜住**连接层**异常（DB 不可达等），供路由包在 `refresh*` 外层。
 * 与 `refresh*` 内部对上游异常的 catch 互补：一个管"上游坏了"，一个管"库坏了"。
 */
export async function tryRefresh(
  label: string,
  fn: () => Promise<RefreshOutcome>,
): Promise<RefreshOutcome> {
  try {
    return await fn();
  } catch (e) {
    const error = (e as Error).message ?? String(e);
    console.error(`[xborder] 采集入口异常 ${label}：${error}`);
    return { attempted: true, ok: false, error };
  }
}

/** 当日澳门日期（供路由/调用方统一口径，避免各自 `new Date()` 后各算一次） */
export const todayInMacau = (): string => macauDate();
