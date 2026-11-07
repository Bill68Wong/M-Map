/**
 * 通琴号段几何 · 取数与算路（scripts/lib/tqh-segment.ts）
 *
 * 被 `scripts/build-tqh-segment-paths.ts`（CLI 编排）import。**不含任何 CLI 逻辑**
 * （不读 argv、不打印、不 exit）：把「怎么算」和「怎么调用」分开，各管一层。
 *
 * ── 三条硬口径（与 CLI 文件头同源，改一处必改另一处）────────────────────
 *   ① **不做坐标转换**：`tqh_stations.lng/lat` 本身就是 GCJ-02。
 *      这里**故意不 import** `toAmapCoords()` —— 那是给 `stations` 表（WGS84）用的，
 *      拿过来会把 GCJ-02 二次加偏，整批几何偏 500 米级。
 *   ② **限速走现有令牌桶**，用 `transit` 桶而**不新建桶**：高德「基础 LBS · 路径规划」
 *      是**按 Key 全局 3 QPS**，新建桶等于把它拆成两份预算。
 *   ③ **失败不造假**：单段失败 → `source='straight-fallback'` + 两点直线、
 *      `duration_s = NULL`（直线折分钟就是造假）。Spec OD-04 约束④。
 */
import { fmtAmapLngLat, haversineM } from "../../src/lib/amap/coord";
import { RATE_BUCKET, acquireWithWait } from "../../src/lib/amap/rate-limit";
import { getPool } from "../../src/lib/db";
import { TQH_SEGMENT_PROFILE } from "../../src/lib/tqh/types";

/** v3 版驾车路径。OD-02 实测：status=1 / infocode=10000 / polyline 默认返回，不依赖 show_fields */
const ENDPOINT = "https://restapi.amap.com/v3/direction/driving";
const REQ_TIMEOUT_MS = 8_000;
/** Key/配额/参数类错误 ⇒ 整批中止（见文件头） */
const FATAL_INFOCODES = new Set(["10001", "10002", "10003", "10005", "10044"]);
/**
 * 并发超限 ⇒ **退避重试**，不降级（实测踩过，2026-11-06 本地演练）：
 *   首次演练只靠令牌桶（qps=3 / capacity=6）跑 302 段，有 6 段返回
 *   `10021 CUQPS_HAS_EXCEEDED_THE_LIMIT` / `10022 CGQPS_HAS_EXCEEDED_THE_LIMIT`。
 *   根因：令牌桶管**平均速率**，容量 6 允许一次性放行 6 个 ⇒ 同一秒并发数超了 3。
 *   这不是「该区域无路网」（那是 `20003`）⇒ ① 加 `MIN_GAP_MS` 治并发；
 *   ② 这两个码**重试**。若当普通失败降级，会把 6 段真实路网永久写成直线。
 */
const RETRY_INFOCODES = new Set(["10021", "10022"]);
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 800;
/**
 * 两次请求之间的最小间隔（毫秒）—— **并发量**约束，不是平均速率约束。
 *
 * 🚨 依据：高德个人认证「基础 LBS 服务」的并发上限为 **3**（同一秒内最多 3 个请求在途，
 *   与项目 `client.ts` 的实测记录同口径）。这里取 400ms 间隔（每秒 2.5 个）留余量；
 *   串行 + 400ms ⇒ 任一时刻在途请求恒为 1，不会触发 `10021/10022`。
 */
const MIN_GAP_MS = 400;
/** 单次取令牌最长等待；超时是限速器/库的问题，不是上游无路 ⇒ 抛错而非降级 */
const TOKEN_WAIT_MS = 30_000;

let lastReqAt = 0;
/** 请求起点串行间隔（模块级；本脚本单进程串行调用，无需跨进程） */
async function throttle(): Promise<void> {
  const wait = MIN_GAP_MS - (Date.now() - lastReqAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReqAt = Date.now();
}

/** 一个相邻有向站对（坐标 GCJ-02 原值） */
export interface Pair {
  from: number;
  to: number;
  fromName: string;
  fromSide: string;
  fromLng: number;
  fromLat: number;
  toName: string;
  toSide: string;
  toLng: number;
  toLat: number;
  /** 两点直线距离（米）—— 只用于降级几何与绕路系数，**不当路程用** */
  straightM: number;
}

/** 待写入的一段几何 */
export interface SegRow {
  from: number;
  to: number;
  polyline: [number, number][];
  distanceM: number;
  durationS: number | null;
  source: "amap-driving" | "straight-fallback";
}

/** 算路结果（成功带几何，失败带 infocode 供失败清单） */
export type DriveResult =
  | { ok: true; polyline: [number, number][]; distanceM: number; durationS: number; snapStart: number; snapEnd: number }
  | { ok: false; infocode: string; info: string };

export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * 全部相邻有向站对（`lead()` 按班次取下一站）。
 *
 * 去重口径：`SELECT DISTINCT (station_id, lead(station_id))` ⇒ Spec §6.1 的 **302**。
 * ⚠️ **禁止**改成按 `(route_no, direction)` 聚合：实测 64 组装不下 73 种真实站序，
 *    其中 8 组是真不同路线（几何差 259–3701 m），按标号级 key 会在地图上画错路。
 */
export async function loadPairs(): Promise<Pair[]> {
  const res = await getPool().query(
    `WITH adj AS (
       SELECT DISTINCT station_id AS f,
              lead(station_id) OVER (PARTITION BY trip_id ORDER BY seq) AS t
         FROM tqh_trip_stops
     )
     SELECT a.f AS from_id, a.t AS to_id,
            f.name AS from_name, f.side AS from_side, f.lng AS from_lng, f.lat AS from_lat,
            t.name AS to_name,   t.side AS to_side,   t.lng AS to_lng,   t.lat AS to_lat
       FROM adj a
       JOIN tqh_stations f ON f.id = a.f
       JOIN tqh_stations t ON t.id = a.t
      WHERE a.t IS NOT NULL
      ORDER BY a.f, a.t`,
  );

  return (res.rows as Record<string, unknown>[]).map((r) => {
    const fromLng = Number(r.from_lng);
    const fromLat = Number(r.from_lat);
    const toLng = Number(r.to_lng);
    const toLat = Number(r.to_lat);
    return {
      from: Number(r.from_id),
      to: Number(r.to_id),
      fromName: String(r.from_name),
      fromSide: String(r.from_side),
      fromLng,
      fromLat,
      toName: String(r.to_name),
      toSide: String(r.to_side),
      toLng,
      toLat,
      straightM: Math.round(haversineM({ lng: fromLng, lat: fromLat }, { lng: toLng, lat: toLat })),
    };
  });
}

/** 相邻关系总数与去重数（只用于报告，核对 763 / 302） */
export async function loadPairCounts(): Promise<{ edges: number; directed: number }> {
  const res = await getPool().query(
    `WITH adj AS (
       SELECT station_id AS f, lead(station_id) OVER (PARTITION BY trip_id ORDER BY seq) AS t
         FROM tqh_trip_stops
     )
     SELECT count(*) FILTER (WHERE t IS NOT NULL)::int AS edges,
            count(DISTINCT (f, t)) FILTER (WHERE t IS NOT NULL)::int AS directed
       FROM adj`,
  );
  return res.rows[0] as { edges: number; directed: number };
}

/**
 * 已落库的行（key = `from|to`）。
 *
 * 表不存在返回 `null`（而不是抛错）—— 建表前的 dry-run 仍要能给出「待写 302 段」的计划。
 */
export async function loadExisting(): Promise<Map<string, { source: string; computedAt: string }> | null> {
  try {
    const res = await getPool().query(
      `SELECT from_station_id, to_station_id, source, computed_at
         FROM tqh_segment_paths WHERE profile = $1`,
      [TQH_SEGMENT_PROFILE],
    );
    const m = new Map<string, { source: string; computedAt: string }>();
    for (const r of res.rows as {
      from_station_id: number;
      to_station_id: number;
      source: string;
      computed_at: Date | string;
    }[]) {
      m.set(`${r.from_station_id}|${r.to_station_id}`, {
        source: r.source,
        computedAt: new Date(r.computed_at).toISOString(),
      });
    }
    return m;
  } catch (e) {
    if ((e as { code?: string }).code === "42P01") return null; // relation does not exist
    throw e;
  }
}

/** 调一段驾车路径（入参坐标已是 GCJ-02，原样送出） */
export async function fetchDriving(p: Pair): Promise<DriveResult> {
  const key = (process.env.AMAP_KEY ?? "").trim();
  if (!key) {
    throw new Error("缺少 AMAP_KEY：在 .env 配置（高德控制台 → 应用管理 → Key 平台选「Web服务」）");
  }
  const o = { lng: p.fromLng, lat: p.fromLat };
  const d = { lng: p.toLng, lat: p.toLat };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle();
    const token = await acquireWithWait(RATE_BUCKET.transit, TOKEN_WAIT_MS);
    if (!token.ok) {
      throw new Error(
        "取不到限速令牌（30s 超时）：这不是上游无路，而是限速器或库异常。" +
          "整批中止，避免把全部段静默写成直线降级。",
      );
    }

    const r = await requestOnce(o, d, key);
    if (r.ok) return r;
    // 并发超限是**我们自己打太快**，不是数据问题 ⇒ 退避重试；重试用尽才降级
    if (!RETRY_INFOCODES.has(r.infocode) || attempt === MAX_ATTEMPTS) return r;
    await new Promise((res) => setTimeout(res, attempt * RETRY_BACKOFF_MS));
  }
  // 循环必然在内部 return；这里只是让类型收敛
  return { ok: false, infocode: "unreachable", info: "重试循环异常退出" };
}

/** 单次请求 + 解析（不含重试/限速；由 `fetchDriving` 编排） */
async function requestOnce(
  o: { lng: number; lat: number },
  d: { lng: number; lat: number },
  key: string,
): Promise<DriveResult> {
  const qs = new URLSearchParams({ origin: fmtAmapLngLat(o), destination: fmtAmapLngLat(d), key });

  let json: {
    status?: string;
    info?: string;
    infocode?: string;
    route?: { paths?: { distance?: string; duration?: string; steps?: { polyline?: string }[] }[] };
  };
  try {
    const res = await fetch(`${ENDPOINT}?${qs}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    json = await res.json();
  } catch (e) {
    return { ok: false, infocode: "fetch_error", info: (e as Error).message };
  }

  const infocode = String(json.infocode ?? "?");
  const info = String(json.info ?? "unknown");
  if (FATAL_INFOCODES.has(infocode)) {
    throw new Error(
      `高德返回致命错误 infocode=${infocode}（${info}）⇒ 整批中止。` +
        "继续跑只会把 302 段全部写成直线降级，看起来像跑完了、实际全是假几何。",
    );
  }

  const path = json.route?.paths?.[0];
  const raw = (path?.steps ?? []).map((s) => s.polyline ?? "").join(";");
  const pts: [number, number][] = [];
  for (const seg of raw.split(";")) {
    if (!seg) continue;
    const [lngS, latS] = seg.split(",");
    const lng = Number(lngS);
    const lat = Number(latS);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const pt: [number, number] = [round6(lng), round6(lat)];
    const last = pts[pts.length - 1];
    if (last && last[0] === pt[0] && last[1] === pt[1]) continue; // 去掉 step 边界的重复点
    pts.push(pt);
  }

  const dist = Number(path?.distance ?? 0);
  if (json.status !== "1" || pts.length < 2 || !Number.isFinite(dist) || dist <= 0) {
    return { ok: false, infocode, info: `${info}（status=${json.status ?? "?"}, points=${pts.length}）` };
  }

  return {
    ok: true,
    polyline: pts,
    distanceM: Math.round(dist),
    durationS: Math.round(Number(path?.duration ?? 0)) || 0,
    snapStart: Math.round(haversineM({ lng: pts[0]![0], lat: pts[0]![1] }, o)),
    snapEnd: Math.round(haversineM({ lng: pts[pts.length - 1]![0], lat: pts[pts.length - 1]![1] }, d)),
  };
}

/** 两点直线降级几何（`duration_s` 由调用方置 NULL） */
export function straightRow(p: Pair): SegRow {
  return {
    from: p.from,
    to: p.to,
    polyline: [
      [round6(p.fromLng), round6(p.fromLat)],
      [round6(p.toLng), round6(p.toLat)],
    ],
    distanceM: p.straightM,
    durationS: null,
    source: "straight-fallback",
  };
}

/** 幂等写一段（唯一键 `(from, to, profile)` ⇒ 重跑覆盖，不产生第二行） */
export async function upsertSegment(row: SegRow): Promise<void> {
  await getPool().query(
    `INSERT INTO tqh_segment_paths
       (from_station_id, to_station_id, profile, polyline, distance_m, duration_s, source, computed_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, now())
     ON CONFLICT (from_station_id, to_station_id, profile)
     DO UPDATE SET polyline    = EXCLUDED.polyline,
                   distance_m  = EXCLUDED.distance_m,
                   duration_s  = EXCLUDED.duration_s,
                   source      = EXCLUDED.source,
                   computed_at = now()`,
    [row.from, row.to, TQH_SEGMENT_PROFILE, JSON.stringify(row.polyline), row.distanceM, row.durationS, row.source],
  );
}
