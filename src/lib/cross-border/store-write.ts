/**
 * 写库入口（src/lib/cross-border/store-write.ts）—— **全模块唯一会写 xborder_* 的文件**
 *
 * ── 为什么写、读分成两个文件（与契约 §1.10 的一处偏离，理由在此）──
 *   §1.10 只列了 `store.ts`。实测两边加起来约 500 行（含必要注释），塞一个文件必然破
 *   「单文件 ≤300 行」硬门禁。故拆为：
 *     · 本文件 = upsert / void / cleanup（**写**）；
 *     · `store.ts` = 当日查询与行映射（**读**）。
 *   写入口仍只有本文件一个 —— "唯一写库入口"这条设计意图不变。
 *
 * ── 三条与本文件绑定的正确性依赖 ────────────────────────────────────────
 *   ① **`voided_at` 只能标"未来或刚过"的行**（`sched_at > now() - 15min`）。
 *      上游是滚动窗口，会正常丢弃早已过去的班次；不划线的话，每次采集都会把
 *      上午的班次全标成失效 ⇒ "当日所有"直接被清空。这条线是本机制唯一的正确性依赖。
 *   ② **用 `last_seen_at < roundStart` 表达"本轮没见过它"**，不再额外拼 `NOT IN (业务键)`。
 *      两者等价（只有本轮的 upsert 会把 `last_seen_at` 推到 `now() > roundStart`），
 *      而 `last_seen_at` 写法在并发/重试下更安全（不会误杀"本轮见了但写入晚"的行）。
 *   ③ **upsert 必须 `voided_at = NULL`**（复活）。改回原时刻的班次会被重新见到，
 *      若不清空失效标记，它会在"当日所有"里永久缺失。
 *
 * ── 为什么把 `status_changed_at` 写在 upsert 的 CASE 里 ──────────────────
 *   它是**我方观测到状态变化**的时刻（不是航班事件时刻 —— 事件时刻已内嵌在状态文本里，
 *   如 `已啟航 08:20`）。放在 SQL 里用 `IS DISTINCT FROM` 比较，可以避免
 *   "先查一轮、再在应用层比较、再写回"这种两次往返且并发下会算错的写法。
 */
import type { Pool } from "pg";
import { macauStampToUtc } from "./time";
import type { FlightUpsertRow, SailingUpsertRow, XbDir, PierCode } from "./types";

/** 每批行数：10 参数/行 × 200 = 2000，远低于 PG 的 65535 参数上限 */
const BATCH = 200;

/** `sched_at` 合成：日期 + 时刻按澳门本地解释（UTC+8）。解析阶段已校验过合法性 */
function schedAtOf(date: string, hhmm: string): Date {
  const d = macauStampToUtc(date, hhmm);
  if (!d) throw new Error(`[xborder] 非法日期时刻：${date} ${hhmm}`);
  return d;
}

/**
 * upsert 航班。幂等：同业务键重复写入只更新展示列与 `last_seen_at`。
 *
 * @returns 实际写入/更新的行数
 */
export async function upsertFlights(rows: readonly FlightUpsertRow[], pool: Pool): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values: unknown[] = [];
    const tuples: string[] = [];
    chunk.forEach((r, idx) => {
      const b = idx * 10;
      tuples.push(
        `($${b + 1}::date,$${b + 2},$${b + 3},$${b + 4}::time,$${b + 5},$${b + 6},` +
          `$${b + 7},$${b + 8},$${b + 9}::timestamptz,$${b + 10})`,
      );
      values.push(
        r.schedDate,
        r.direction,
        r.flightNo,
        r.schedTime,
        r.airlineRaw,
        r.placeRaw,
        r.gateRaw,
        r.statusRaw,
        schedAtOf(r.schedDate, r.schedTime),
        r.statusKind,
      );
    });

    const res = await pool.query(
      `INSERT INTO xborder_flights
         (sched_date, direction, flight_no, sched_time, airline_raw, place_raw, gate_raw,
          status_raw, sched_at, status_kind)
       VALUES ${tuples.join(",")}
       ON CONFLICT (sched_date, direction, flight_no, sched_time) DO UPDATE SET
         airline_raw       = EXCLUDED.airline_raw,
         place_raw         = EXCLUDED.place_raw,
         -- 上游会把闸口撤回成空（登机口调整中）⇒ 已分配过的值不要被空值抹掉
         gate_raw          = COALESCE(EXCLUDED.gate_raw, xborder_flights.gate_raw),
         status_changed_at = CASE
                               WHEN xborder_flights.status_raw IS DISTINCT FROM EXCLUDED.status_raw
                               THEN now() ELSE xborder_flights.status_changed_at
                             END,
         status_raw        = EXCLUDED.status_raw,
         status_kind       = EXCLUDED.status_kind,
         last_seen_at      = now(),
         voided_at         = NULL`,
      values,
    );
    written += res.rowCount ?? 0;
  }
  return written;
}

/** upsert 船班次。语义同 `upsertFlights`，键换六件套 */
export async function upsertSailings(
  rows: readonly SailingUpsertRow[],
  pool: Pool,
): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values: unknown[] = [];
    const tuples: string[] = [];
    chunk.forEach((r, idx) => {
      const b = idx * 12;
      tuples.push(
        `($${b + 1}::date,$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6}::time,` +
          `$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11}::timestamptz,$${b + 12})`,
      );
      values.push(
        r.sailDate,
        r.direction,
        r.pier,
        r.operatorRaw,
        r.placeRaw,
        r.schedTime,
        r.vesselRaw,
        r.vesselTypeRaw,
        r.gateRaw,
        r.statusRaw,
        schedAtOf(r.sailDate, r.schedTime),
        r.statusKind,
      );
    });

    const res = await pool.query(
      `INSERT INTO xborder_sailings
         (sail_date, direction, pier, operator_raw, place_raw, sched_time,
          vessel_raw, vessel_type_raw, gate_raw, status_raw, sched_at, status_kind)
       VALUES ${tuples.join(",")}
       ON CONFLICT (sail_date, direction, pier, operator_raw, place_raw, sched_time) DO UPDATE SET
         -- 船名/船种可能临时更换（调船）：列会变，但**不进唯一键**，故这里正常更新
         vessel_raw        = COALESCE(EXCLUDED.vessel_raw, xborder_sailings.vessel_raw),
         vessel_type_raw   = COALESCE(EXCLUDED.vessel_type_raw, xborder_sailings.vessel_type_raw),
         gate_raw          = COALESCE(EXCLUDED.gate_raw, xborder_sailings.gate_raw),
         status_changed_at = CASE
                               WHEN xborder_sailings.status_raw IS DISTINCT FROM EXCLUDED.status_raw
                               THEN now() ELSE xborder_sailings.status_changed_at
                             END,
         status_raw        = EXCLUDED.status_raw,
         status_kind       = EXCLUDED.status_kind,
         last_seen_at      = now(),
         voided_at         = NULL`,
      values,
    );
    written += res.rowCount ?? 0;
  }
  return written;
}

/**
 * 把"本轮没再见到"的未来航班标为失效（改时刻 / 改航线留下的旧行）。
 *
 * @param roundStart 本轮采集的**开始时刻**。`last_seen_at < roundStart` ⇒ 本轮没见过。
 * @returns 被标失效的行数
 */
export async function voidMissingFlights(
  args: { schedDate: string; direction: XbDir; roundStart: Date },
  pool: Pool,
): Promise<number> {
  const res = await pool.query(
    `UPDATE xborder_flights SET voided_at = now()
      WHERE voided_at IS NULL
        AND sched_date = $1::date
        AND direction  = $2
        AND sched_at   > now() - interval '15 minutes'
        AND last_seen_at < $3::timestamptz`,
    [args.schedDate, args.direction, args.roundStart],
  );
  return res.rowCount ?? 0;
}

/** 同上，船版（多一个 `pier` 作用域） */
export async function voidMissingSailings(
  args: { sailDate: string; pier: PierCode; direction: XbDir; roundStart: Date },
  pool: Pool,
): Promise<number> {
  const res = await pool.query(
    `UPDATE xborder_sailings SET voided_at = now()
      WHERE voided_at IS NULL
        AND sail_date = $1::date
        AND pier      = $2
        AND direction = $3
        AND sched_at  > now() - interval '15 minutes'
        AND last_seen_at < $4::timestamptz`,
    [args.sailDate, args.pier, args.direction, args.roundStart],
  );
  return res.rowCount ?? 0;
}

/**
 * 保留窗口清理：删掉 `keepDays` 天之前的行（挂在既有每日 cron 末尾）。
 *
 * ⚠️ **不用 `current_date`**：它是"数据库会话时区的今天"，Supabase/Vercel 是 UTC，
 *    在澳门 00:00–08:00 之间 `current_date` 比澳门日期**早一天**。清理因此会多删/少删一天。
 *    保留窗口只有 2–3 天，差一天不影响正确性，但"口径随部署时区变化"是隐性的坑，
 *    故这里由调用方传入**澳门日期**算出的边界。
 *
 * @param beforeDate 形如 `2026-11-04`：删除 `sched_date < beforeDate` 的行
 */
export async function cleanupXborder(
  beforeDate: string,
  pool: Pool,
): Promise<{ flights: number; sailings: number }> {
  const f = await pool.query(`DELETE FROM xborder_flights  WHERE sched_date < $1::date`, [
    beforeDate,
  ]);
  const s = await pool.query(`DELETE FROM xborder_sailings WHERE sail_date  < $1::date`, [
    beforeDate,
  ]);
  return { flights: f.rowCount ?? 0, sailings: s.rowCount ?? 0 };
}
