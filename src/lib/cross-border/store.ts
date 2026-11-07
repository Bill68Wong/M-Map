/**
 * 读取与序列化（src/lib/cross-border/store.ts）
 *
 * 写库在 `store-write.ts`（唯一写入口）。本文件只读：一条 count + 一条取行，
 * 并行发出（同一连接池内两条独立连接，耗时叠加为 1 次）。
 *
 * ── 三条与查询口径绑定的决定 ────────────────────────────────────────────
 *   ① **`after=now` 的过滤条件只有终态**，`WHERE sched_at > now()` 一行都没有。
 *      这是负责人裁决 1 的落地（契约 §2.1.1）：时刻已过但**没走**的班次（延误）
 *      必须留在"最近五班"里，否则用户在 19:00 打开会发现 08:00 那班"消失"了。
 *      ⇒ 若将来有人加回时间谓词，`scripts/test-xborder-status.ts` 的
 *        「`TERMINAL_KINDS` 与 `classify()` 同源」断言抓不到，但契约 §6 步骤 6
 *        的 fixture 场景会红（A 必须出现）。
 *   ② **`dayTotal` 与 `items` 用同一组过滤条件**（除终态与 limit），否则会出现
 *      "items 有 3 条、dayTotal 说 0 条"这种前端文案打架。
 *   ③ **日期列一律在 SQL 里 `to_char` 成字符串**。`node-pg` 默认把 `DATE` 解析成
 *      本地时区的 `Date` 对象，服务器时区一变（UTC ↔ +08:00）就会**差一天**；
 *      转成字符串是唯一与部署环境无关的读法。时刻同理（`TIME` 默认给 `HH:MM:SS`）。
 */
import type { Pool } from "pg";
import { classify, TERMINAL_KINDS } from "./status";
import { macauIso } from "./time";
import type {
  AirportStatusKind,
  FerryStatusKind,
  PierCode,
  XbAfter,
  XbAirportFlight,
  XbDir,
  XbFerrySailing,
} from "./types";

/** 读取结果：`dayTotal` = 当日该作用域全量行数（含已走、不含 voided） */
export interface DayResult<T> {
  items: T[];
  dayTotal: number;
}

const FLIGHT_COLS = `id, direction, flight_no, airline_raw, place_raw, gate_raw, status_raw,
  to_char(sched_date, 'YYYY-MM-DD') AS sched_date, to_char(sched_time, 'HH24:MI') AS sched_time,
  status_changed_at, first_seen_at, last_seen_at`;

const SAILING_COLS = `id, pier, direction, vessel_raw, vessel_type_raw, operator_raw, place_raw,
  to_char(sail_date, 'YYYY-MM-DD') AS sail_date, to_char(sched_time, 'HH24:MI') AS sched_time,
  gate_raw, status_raw, status_changed_at, first_seen_at, last_seen_at`;

/** 只把必需字段声明出来：SQL 里多取一列不该让这里静默忽略（故显式列全） */
interface FlightRow {
  id: string | number;
  direction: string;
  flight_no: string;
  airline_raw: string | null;
  place_raw: string;
  gate_raw: string | null;
  status_raw: string;
  sched_date: string;
  sched_time: string;
  status_changed_at: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
}

interface SailingRow {
  id: string | number;
  pier: string;
  direction: string;
  vessel_raw: string | null;
  vessel_type_raw: string | null;
  operator_raw: string;
  place_raw: string;
  sail_date: string;
  sched_time: string;
  gate_raw: string | null;
  status_raw: string;
  status_changed_at: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : typeof v === "string" ? v : macauIso(v);

const toFlight = (r: FlightRow, dir: XbDir): XbAirportFlight => {
  // ★ kind 与 terminal 都在读取时由**同一条白名单**算出（`status_raw` 才是真相）。
  //   库里的 `status_kind` 只服务 SQL 谓词（每轮 upsert 会刷新它）。
  //   若两处各算一次，就会出现"响应说不是终态、SQL 已把它剔除"的静默矛盾。
  const v = classify("airport", dir, r.status_raw);
  return {
    id: Number(r.id),
    direction: dir,
    flightNo: r.flight_no,
    airline: r.airline_raw,
    place: r.place_raw,
    schedDate: r.sched_date,
    schedTime: r.sched_time,
    gate: r.gate_raw,
    status: r.status_raw,
    statusKind: v.kind as AirportStatusKind,
    isTerminal: v.terminal,
    statusChangedAt: iso(r.status_changed_at),
    firstSeenAt: iso(r.first_seen_at) ?? "",
    lastSeenAt: iso(r.last_seen_at) ?? "",
  };
};

const toSailing = (r: SailingRow, dir: XbDir): XbFerrySailing => {
  const v = classify("ferry", dir, r.status_raw);
  return {
    id: Number(r.id),
    pier: r.pier as PierCode,
    direction: dir,
    vessel: r.vessel_raw,
    vesselType: r.vessel_type_raw,
    operator: r.operator_raw,
    place: r.place_raw,
    schedDate: r.sail_date,
    schedTime: r.sched_time,
    gate: r.gate_raw,
    status: r.status_raw,
    statusKind: v.kind as FerryStatusKind,
    isTerminal: v.terminal,
    statusChangedAt: iso(r.status_changed_at),
    firstSeenAt: iso(r.first_seen_at) ?? "",
    lastSeenAt: iso(r.last_seen_at) ?? "",
  };
};

/**
 * 当日航班。
 *
 * @param args.after `day` = 全量；`now` = 剔除终态后按 `sched_at` 升序取前 `limit`
 */
export async function queryFlights(
  args: { schedDate: string; direction: XbDir; after: XbAfter; limit: number },
  pool: Pool,
): Promise<DayResult<XbAirportFlight>> {
  const scope = [`sched_date = $1::date`, `direction = $2`, `voided_at IS NULL`];
  const scopeParams: unknown[] = [args.schedDate, args.direction];

  const filter = [...scope];
  const filterParams = [...scopeParams];
  if (args.after === "now") {
    filterParams.push(TERMINAL_KINDS.airport[args.direction]);
    filter.push(`status_kind <> ALL($${filterParams.length}::text[])`);
  }

  // ⚠️ count 用 **scope**（不含终态过滤）而不是 `filter`：
  //   `dayTotal` 的语义是"当日共几班"（含已走），前端文案「今日共 N 班」靠它；
  //   若跟着 after=now 一起剔终态，全部走完时 dayTotal=0 ⇒ 前端会把
  //   「今日已无离澳航班」(none_remaining_today) 说成「今日暂无航班安排」(no_service_today)。
  //   —— 这个错误由 `db/migrate-v3800.ts --verify-ddl` 的读写演练抓出来（它跑真实 SQL）。
  const countSql = `SELECT count(*)::int AS n FROM xborder_flights WHERE ${scope.join(" AND ")}`;
  const rowsSql = `SELECT ${FLIGHT_COLS} FROM xborder_flights
                    WHERE ${filter.join(" AND ")}
                    ORDER BY sched_at ASC, flight_no ASC
                    LIMIT $${filterParams.length + 1}`;

  const [countRes, rowsRes] = await Promise.all([
    pool.query(countSql, scopeParams),
    pool.query(rowsSql, [...filterParams, args.limit]),
  ]);

  return {
    dayTotal: Number((countRes.rows[0] as { n: number } | undefined)?.n ?? 0),
    items: (rowsRes.rows as FlightRow[]).map((r) => toFlight(r, args.direction)),
  };
}

/** 当日某码头某方向的船班次。语义同 `queryFlights` */
export async function querySailings(
  args: { sailDate: string; pier: PierCode; direction: XbDir; after: XbAfter; limit: number },
  pool: Pool,
): Promise<DayResult<XbFerrySailing>> {
  const scope = [`sail_date = $1::date`, `pier = $2`, `direction = $3`, `voided_at IS NULL`];
  const scopeParams: unknown[] = [args.sailDate, args.pier, args.direction];
  const filter = [...scope];
  const filterParams: unknown[] = [...scopeParams];
  if (args.after === "now") {
    filterParams.push(TERMINAL_KINDS.ferry[args.direction]);
    filter.push(`status_kind <> ALL($${filterParams.length}::text[])`);
  }

  // count 用 scope（同 flights 的理由：dayTotal 是"当日共几班"，不随 after 变化）
  const countSql = `SELECT count(*)::int AS n FROM xborder_sailings WHERE ${scope.join(" AND ")}`;
  // 同分钟多班时用 operator/place 兜第二、第三键，保证两次请求顺序一致（前端 diff 不抖）
  const rowsSql = `SELECT ${SAILING_COLS} FROM xborder_sailings
                    WHERE ${filter.join(" AND ")}
                    ORDER BY sched_at ASC, operator_raw ASC, place_raw ASC
                    LIMIT $${filterParams.length + 1}`;

  const [countRes, rowsRes] = await Promise.all([
    pool.query(countSql, scopeParams),
    pool.query(rowsSql, [...filterParams, args.limit]),
  ]);

  return {
    dayTotal: Number((countRes.rows[0] as { n: number } | undefined)?.n ?? 0),
    items: (rowsRes.rows as SailingRow[]).map((r) => toSailing(r, args.direction)),
  };
}
