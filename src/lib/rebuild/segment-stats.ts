/**
 * 站间时长统计重算（共享层，v0.25.0）
 *
 * 从 CLI 脚本 scripts/rebuild-segment-stats.ts 抽取的核心逻辑，做成接受 pool 的纯函数，
 * 供两处复用：
 *   · CLI：npm run db:segments -- local|cloud（本地 / 手动）
 *   · API：GET /api/cron/rebuild（Vercel Cron 每日自动）
 * 抽取原因：Serverless 函数只打包被 import 的模块，无法 execFile 调 .ts 脚本。
 *
 * ── 端点口径（v0.22.0）────────────────────────────────────────────
 * 能当「站点时刻端点」并以真实时刻参与时长计算的：
 *   · station_arrive / stop_arrive —— 停靠，有时刻
 *   · station_pass  / stop_pass   —— 甩站没停，乘客点按钮时车正经过站台，时刻真实
 *   · board                        —— 上车时刻（= 上车站发车时刻）
 *   · alight                       —— 下车时刻（= 下车站到达时刻）
 * 不能当端点：
 *   · station_skip / stop_skip    —— 「忘记打卡」补点，无真实到站时刻，
 *                                    仅用于 UI 推进进度，永不进入时长样本
 *     （排除后其前后两点自然被判为「跨站」，即不会产出错误段）
 *
 * ── 口径（★ 2026-09-13 定案 = **离开口径**）────────────────────────
 * 打点时刻的真实含义 = 「**关好门、准备起步**」= 车辆**离开**该站的时刻，故段时长：
 *     t(离 B) − t(离 A) = run(A→B) + **dwell_B**
 *   → 差里含的是**终点站**的停站，**不含起点站**的停站。
 * 依据：docs/口径核查报告-20260913.md（证据：打点瞬间目标车 status=1 / speed≈3 / stops_away=0）。
 * ⚠️ 本文件此前把口径写成「到达口径（差里只含**起点站**停站）」——**那是错的**，待此注释即修正；
 *    两口径之差 = dwell_A − dwell_B，实测均值 ≈0、σ≈21 秒（量级不足以让数据失效）。
 *
 * ── 分档（arrive_kind）───────────────────────────────────────────
 * 由 `kindOfStart`（**起点站**的事件类型）分档：stop = 起点停靠 / pass = 起点甩站。
 *   ⚠️ 该分档的推理来自旧的「到达口径」（起点停站 → 计入差里），**与定案口径不自洽**：
 *      离开口径下计入差里的是 dwell_B —— 起点站停不停**不影响**结果；
 *      真正该区分「含停站 / 接近纯行驶」的是**终点站 B**（B 甩站 → 无 dwell_B → 接近纯行驶）。
 *      → **行为未改**（改动会影响 ETA），仅如实记录，待单独评估（同报告 §5.2）。
 *   all —— 合并兜底
 * （board 作为起点归 stop 档：上客本身即停站。）
 *
 * ── 分层（★ v3.4.0 升级）────────────────────────────────────────
 * weekday=-1 + time_bucket ∈ {am_work|am_weekend|day|pm|night}（`bucketOfRoute` 新五桶，
 *   从观测时刻重算）+ arrive_kind（stop|pass）
 * 另写 weekday=-1 / time_bucket='all' 的兜底行（kind 分层 + 合并）。
 * 依据：docs/量化方案-导航站间时长-20260927.md §6（实验⑦a~⑦c 数据驱动推导）。
 *
 * ── 样本来源（★ v4.2.0：生产口径 = `track`）────────────────────────
 * 见函数内 `sampleFrom` 的四态表。要点：
 *   · **生产（cron / CLI 显式指定）只吃 `segment_samples.source='track'`（自动采集）**；
 *   · 旧手工记录（`timer` / `free` 事件四表）**不再参与**计算，但**表与行保留不删**（可离线对拍）；
 *   · 口径是**白名单**：新增采集源必须在 `SegmentSample["source"]` 与 WHERE 分派处显式登记，
 *     否则聚合时直接抛错（防「静默混入 + bySource 变 NaN」）。
 */
import type { Pool } from "pg";
import { bucketOf, bucketOfRoute, macauParts } from "./buckets";
import { getHolidays, macauDayOf } from "./holidays";
import { LONG_STOP_EXCLUDE_MIN, loadLongStopPolicy, shouldExcludeLongStop } from "./long-stop";
import type { LongStopPolicy } from "./long-stop";

/**
 * ★ v3.6.0：长停站判据已抽到 `./long-stop.ts`（单一源，与 build-hop-stats 共用）。
 *   此处 re-export 保持既有导入路径不变。
 */
export { LONG_STOP_MIN, LONG_STOP_MARK_MIN, LONG_STOP_EXCLUDE_MIN } from "./long-stop";

/**
 * ★ v3.4.0：`bucketOf` / `macauParts` 已迁移至 `./buckets`（零依赖共享层）——
 *   此处 re-export 保持既有消费方（导入脚本等）的导入路径不变。
 */
export { bucketOf, macauParts } from "./buckets";

/** 站码主码归一（剥掉站台号后缀：C690/3 → C690）。★ 导出供入库脚本复用，勿另起一套。 */
export const mainCode = (code: string) => /^[A-Za-z]+\d+/.exec(code)?.[0] ?? code;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** 归一化后的站点事件类型 */
type Kind = "arrive" | "pass" | "skip" | "board" | "alight" | "pre";
const NORM: Record<string, Kind> = {
  station_arrive: "arrive",
  station_pass: "pass",
  station_skip: "skip",
  stop_arrive: "arrive",
  stop_pass: "pass",
  stop_skip: "skip",
  board: "board",
  alight: "alight",
  depart: "pre",
  wait_start: "pre",
};
/** 可作站间段端点（有真实时刻）*/
const ENDPOINT = new Set<Kind>(["arrive", "pass", "board", "alight"]);
/** 起点站的停站类型 → arrive_kind 档位 */
const kindOfStart = (k: Kind) => (k === "pass" ? "pass" : "stop");
/** ★ v3.6.0：终点站的停站类型 → arrive_kind 档位（离开口径下**这才是自洽的那个**）
 *  离开口径 minutes = run + dwell_B ⇒ 差里含的是**终点站**的停站：
 *    B 甩站（pass）→ 无 dwell_B → 接近纯行驶 → "pass" 档
 *    B 停靠（arrive/board/alight）→ 含 dwell_B → "stop" 档
 *  默认仍走 kindOfStart（行为不变，见 opts.arriveKindMode），切换需显式传 "dest"。
 *  ⚠️ **不要与「排除 dwell ≥ LONG_STOP_EXCLUDE_MIN」同时启用**：两者治的是同一个病（终点站停站）。
 *     叠加后 stop 档（终点站停靠）里的长停已被排掉 → stop 与 pass（甩站≈纯行驶）趋同 →
 *     segment-lookup 里 L1/L2 优先取 stop 档的分层失去区分度，白留复杂度。
 *     本期结论：只上「排 dwell」，本开关保持 origin 观察一期，切换前先量两档是否仍有差异。 */
const kindOfEnd = (k: Kind) => (k === "pass" ? "pass" : "stop");

/** ★ v3.6.0 / v4.1.1：长停站**双档** ——
 *  · 标记档 `LONG_STOP_MARK_MIN=3` 分：dwell_B ≥ 3 → 入库端写 `long_stop=true`（只说明「含停站」）；
 *  · 排除档 `LONG_STOP_EXCLUDE_MIN=5` 分：dwell_B ≥ 5 **且终点站是总站** 的样本判为「含司机休息」，
 *    从时长聚合中排除。
 *  依据（实测 57 轮 / 202,790 条 track 样本）：186 条终点站长停候选里 **136 条（73%）落在 3~4 分**
 *  —— 那是总站正常上落客，只有 15 条（8%）≥5 分才像真休息。单档 3 分一刀切会误排 114 条。
 *    · 26 路 C654 聯生圓形地總站 dwell 最大 7.75 分，C656→C654 有 27.8% 样本 ≥3 分、avg 2.64/p50 1.67；
 *    · 25 路同段（25 也停该总站）n=206，avg 2.45→1.81。
 *  ⚠️ **只对总站生效**（longStopScope 默认 "terminus"）。中途大站的长挂站**不排**，因为那是真实排队：
 *     实测 M233（東北大馬路/東華）37 轮内 176 段 ≥3 分、90 辆车、p90 5.9 分（早晚高峰），
 *     排掉会让 ETA 低估乘客实际等待。总站休息则发生在乘客下车之后，不影响到达。
 *     一刀切排除（scope="any"）会多排 ~0.37% 样本、波及 306 个站对，仅有诊断价值。
 *  ⚠️ 排除后的口径语义 = 「**正常情况下的区间期望，不覆盖司机休息**」。乘客若恰好上到一辆要歇的车，
 *     ETA 会低估——这是数据源限制，不是 bug；改动前请先看 db/migrate-v3600.ts 的列注释。
 *  ⚠️ 判据本体（阈值 / 总站集合 / 计划性待发豁免）在 `./long-stop.ts`，**不要在本文件另写一套**。
 */

interface Pt {
  code: string;
  t: Date;
  kind: Kind;
}
export interface SegmentSample {
  route: string;
  from: string;
  to: string;
  weekday: number;
  bucket: string;
  arriveKind: "stop" | "pass";
  minutes: number;
  /** 来源：timer = 通勤计时；free = 自由记站；track = 追踪采集（读自 segment_samples） */
  source: "timer" | "free" | "track";
  /** 观测时刻（毫秒）。事件路径取起点站事件时刻；供 segment_samples 入库保留原始时间。 */
  t: number;
  /** ★ v3.6.0：终点站停站时长（分）。仅 track 样本可能有值（dwell_b_min 列）；事件路径为 null。 */
  dwell?: number | null;
  /** ★ v3.6.0：dwell ≥ LONG_STOP_MIN → 该样本的 minutes 含长时间停站 */
  longStop?: boolean;
}

export interface SegmentPairStat {
  /** route|from|to */
  key: string;
  stop: number[];
  pass: number[];
}

/**
 * ★ v4.2.0：样本来源口径（四态）。
 *   `track` = **生产口径**：只吃 `segment_samples.source = 'track'`（自动采集）。
 *   ⚠️ 白名单而非黑名单 —— 将来新增任何采集源都**不会**自动混进来，必须在此显式放行。
 */
export type SegmentSampleFrom = "events" | "samples" | "both" | "track";

export interface SegmentRebuildResult {
  /** 源会话 / 行程数 */
  sessions: number;
  rides: number;
  /** 提取到的段样本总数 */
  samples: number;
  bySource: { timer: number; free: number; track: number };
  byKind: { stop: number; pass: number };
  /** 丢弃统计 */
  stats: {
    head: number;
    tail: number;
    redirect: number;
    sameStation: number;
    zeroGap: number;
    unmatched: number;
    cross: number;
    reverse: number;
    /** 跨线回退成功回收的段（本线站序解不出，但该邻接对属另一条线） */
    recovered: number;
    /** ★ v3.6.0：因「终点站长停站」（dwell_B ≥ LONG_STOP_MIN）被排除的样本数 */
    longDwell: number;
  };
  /** ★ v3.6.0：长停站排除策略的计数（候选 / 排除 / 各前置门拦下的站数与站对数） */
  longStopPolicy?: LongStopPolicy["stats"];
  /** 写入行数（dry 时为 0） */
  written: number;
  /** 分层行数（不含兜底） */
  layered: number;
  /** 按线路样本数 */
  routeCount: [string, number][];
  /** 可反推停站耗时的区间 */
  pairs: SegmentPairStat[];
  /** 有 ≥2 次样本的区间（按样本数降序，已排序） */
  rep: SegmentPairStat[];
  inserted: number;
  /** 事件路径产出的**原始**段样本（供 segment_samples 入库复用；dry 时同样产出） */
  rawSamples: SegmentSample[];
  /** 本次实际参与聚合的样本来源（由 opts.sampleFrom 决定） */
  sampleFrom: SegmentSampleFrom;
}

export async function rebuildSegmentStats(
  pool: Pool,
  opts: {
    dry?: boolean;
    sampleFrom?: SegmentSampleFrom;
    /** ★ v3.6.0：arrive_kind 分档依据 —— "origin"=起点站（默认，行为不变）· "dest"=终点站（与离开口径自洽） */
    arriveKindMode?: "origin" | "dest";
    /** ★ v3.6.0：长停站排除范围 —— "terminus"=仅总站（默认）· "any"=所有站点（含中途拥堵，会低估 ETA） */
    longStopScope?: "terminus" | "any";
  } = {},
): Promise<SegmentRebuildResult> {
  const dry = !!opts.dry;
  const arriveKindMode = opts.arriveKindMode ?? "origin";
  /**
   * 「样本来源」口径（v1.3.0 两态 → v4.2.0 四态）。
   *
   *   | 值        | 读什么                                                    | 用途 |
   *   |-----------|-----------------------------------------------------------|------|
   *   | `events`  | 只读 DB 事件四表（timer_sessions/timer_events/free_rides/free_ride_events） | 旧行为（v1.3.0 前的口径） |
   *   | `samples` | 只读 `segment_samples` **全表**（含 `source='timer'` 的手工留档行）        | 诊断 / 对拍 |
   *   | `both`    | 事件四表 + `segment_samples` 中 `source <> 'timer'` 的行                 | 历史对照（v1.3.0~v4.1.x 的生产口径） |
   *   | `track`   | 只读 `segment_samples` 中 `source = 'track'` 的行，**完全不读事件四表**   | ★ 生产口径（v4.2.0 起） |
   *
   * ★ 为什么 `track` 是**白名单**而不是「`<> 'timer'` 黑名单」：
   *   黑名单口径下，将来任何新增采集源（例如以后接入官方数据、或 third-party 补充样本）
   *   都会**自动**混进生产统计而无人察觉；白名单则要求「显式放行一项」，改口径必须改代码 + 过门禁。
   *   历史手工样本（`timer` 243 行）**保留在表里不删**，只是不参与计算（可随时离线对拍）。
   *
   * ⚠️ `samples` 口径会把 `source='timer'` 的留档行读进来 —— 那是**诊断用**，不是生产值。
   */
  const sampleFrom = opts.sampleFrom ?? "events";
  const q = async (sql: string, args?: unknown[]) =>
    (await pool.query(sql, args)).rows as Record<string, unknown>[];

  // ================= ① 站序索引 =================
  const routeRows = await q(
    `SELECT r.code AS route, rs.dsat_dir, rs.seq, rs.station_code
       FROM route_stations rs JOIN routes r ON r.id = rs.route_id
      ORDER BY r.code, rs.dsat_dir, rs.seq`,
  );
  const seqIdx = new Map<string, Map<string, number[]>>();
  for (const r of routeRows) {
    const key = `${r.route}|${r.dsat_dir}`;
    if (!seqIdx.has(key)) seqIdx.set(key, new Map());
    const m = seqIdx.get(key)!;
    const code = r.station_code as string;
    if (!m.has(code)) m.set(code, []);
    m.get(code)!.push(r.seq as number);
  }
  const seqsOf = (m: Map<string, number[]>, code: string): number[] => {
    const exact = m.get(code);
    if (exact?.length) return [...exact].sort((a, b) => a - b);
    const p = mainCode(code);
    const out: number[] = [];
    for (const [k, v] of m) if (k === p || mainCode(k) === p) out.push(...v);
    return [...new Set(out)].sort((a, b) => a - b);
  };

  // ============ ①-b 全澳邻接键索引（v0.26.1 修 bug #23） ============
  // 键 = mainCode(from)→mainCode(to)，值 = 拥有该邻接对的线路集合。
  // 用途：同一会话内跨线打点（换乘到另一条线）的后段，在「会话自身 route_code」
  // 的站序里必然解不出（seqsOf 命中失败）→ 原来是直接丢弃。
  // 现按站码反查归属线路，用那条线的站序复核后接受该样本。
  // 依据：邻接区间本身可跨线路共享（段的物理含义 = 从 A 站开到 B 站的时长）。
  const dirsByRoute = new Map<string, string[]>();
  const adjOwners = new Map<string, Set<string>>();
  {
    let prevKey = "";
    let prevCode = "";
    for (const r of routeRows) {
      const key = `${r.route}|${r.dsat_dir}`;
      if (key !== prevKey) {
        const rt = r.route as string;
        if (!dirsByRoute.has(rt)) dirsByRoute.set(rt, []);
        dirsByRoute.get(rt)!.push(r.dsat_dir as string);
        prevKey = key;
        prevCode = "";
      }
      const code = r.station_code as string;
      if (prevCode) {
        const adj = `${mainCode(prevCode)}→${mainCode(code)}`;
        if (!adjOwners.has(adj)) adjOwners.set(adj, new Set());
        adjOwners.get(adj)!.add(r.route as string);
      }
      prevCode = code;
    }
  }

  // ================= ② 读两套源事件（★ v4.2.0：仅 events / both 口径才读） =================
  /**
   * ★ v4.2.0：`track` / `samples` 口径**一行都不读**这四张旧表。
   *   为什么用「先判口径再读」而不是「读完再过滤」：
   *     ① 语义上 —— 旧表（人工计时 / 自由记站）在生产口径下**不参与**，不是"读了不用"；
   *     ② 成本上 —— 省掉 4 次往返（含 `ANY($1::int[])` 大数组参数）。
   *   ⇒ 四个变量在非事件口径下恒为空数组，下游 ③ 段两个循环自然空转，
   *     `sessions` / `rides` 两个计数如实为 0（**不要伪造**成历史值）。
   */
  const withEvents = sampleFrom === "events" || sampleFrom === "both";
  let sessions: Record<string, unknown>[] = [];
  let timerEv: Record<string, unknown>[] = [];
  let freeRides: Record<string, unknown>[] = [];
  let freeEv: Record<string, unknown>[] = [];
  if (withEvents) {
    sessions = await q(
      `SELECT id, route_code, dsat_dir, weekday, time_bucket, started_at
         FROM timer_sessions
        WHERE deleted_at IS NULL AND NOT COALESCE(is_test, false) AND route_code IS NOT NULL
        ORDER BY id`,
    );
    timerEv = sessions.length
      ? await q(
          `SELECT session_id AS rid, event_type, station_code, recorded_at
             FROM timer_events
            WHERE session_id = ANY($1::int[]) AND station_code IS NOT NULL
            ORDER BY session_id, recorded_at, seq`,
          [sessions.map((s) => s.id as number)],
        )
      : [];
    freeRides = await q(
      `SELECT id, route_code, dsat_dir, started_at
         FROM free_rides
        WHERE deleted_at IS NULL AND NOT COALESCE(is_test, false) AND route_code IS NOT NULL
        ORDER BY id`,
    );
    freeEv = freeRides.length
      ? await q(
          `SELECT free_ride_id AS rid, event_type, station_code, recorded_at
             FROM free_ride_events
            WHERE free_ride_id = ANY($1::int[]) AND station_code IS NOT NULL
            ORDER BY free_ride_id, seq, recorded_at`,
          [freeRides.map((r) => r.id as number)],
        )
      : [];
  }

  // ================= ③ 会话/行程 → 站点时间线 =================
  const rank = (k: Kind) =>
    k === "board" || k === "alight" ? 3 : k === "arrive" || k === "pass" || k === "skip" ? 2 : 1;

  /** 把原始事件折成「同一站码连续事件合并」的站点时间线 */
  function toPoints(rows: Record<string, unknown>[]): Pt[] {
    const pts: Pt[] = [];
    for (const e of rows) {
      const kind = NORM[e.event_type as string];
      if (!kind) continue;
      const code = e.station_code as string;
      const t = new Date(e.recorded_at as string);
      const last = pts[pts.length - 1];
      if (last && last.code === code) {
        if (rank(kind) > rank(last.kind)) {
          last.t = t;
          last.kind = kind;
        }
        continue;
      }
      pts.push({ code, t, kind });
    }
    return pts;
  }

  /** 以某条站序提取段样本 */
  function extract(
    route: string,
    pts: Pt[],
    m: Map<string, number[]>,
    weekday: number,
    bucket: string,
    source: "timer" | "free",
  ): { samples: SegmentSample[]; st: Record<string, number> } {
    const samples: SegmentSample[] = [];
    const st = {
      ok: 0,
      head: 0,
      tail: 0,
      sameStation: 0,
      zeroGap: 0,
      unmatched: 0,
      cross: 0,
      reverse: 0,
      recovered: 0,
      longDwell: 0,
    };
    // skip 不参与，直接过滤（其前后点会变成跨站，从而被丢弃）
    const seq = pts.filter((p) => p.kind !== "skip");

    /** 在给定站序索引里解析相邻站对：命中且相邻返回下标，否则 null */
    const resolve = (
      mm: Map<string, number[]>,
      aCode: string,
      bCode: string,
      minFrom: number,
    ): { x: number; y: number } | null => {
      const sa = seqsOf(mm, aCode);
      const sb = seqsOf(mm, bCode);
      if (!sa.length || !sb.length) return null;
      let best: { x: number; y: number } | null = null;
      for (const x of sa) {
        if (x < minFrom) continue;
        for (const y of sb) {
          if (y <= x) continue;
          if (!best || y - x < best.y - best.x) best = { x, y };
        }
      }
      if (!best || best.y - best.x !== 1) return null;
      return best;
    };

    let lastSeq = -1;
    for (let i = 0; i + 1 < seq.length; i++) {
      const a = seq[i];
      const b = seq[i + 1];
      if (!ENDPOINT.has(a.kind) || !ENDPOINT.has(b.kind)) continue;
      if (mainCode(a.code) === mainCode(b.code)) {
        st.sameStation++;
        continue; // 同站不同台 = 换乘/站内停留
      }
      const minutes = (b.t.getTime() - a.t.getTime()) / 60000;
      if (minutes <= 0.05) {
        st.zeroGap++;
        continue;
      }
      // ① 先用当前线路站序解析
      let hitRoute: string | null = null;
      let hitX = -1;
      const own = resolve(m, a.code, b.code, lastSeq);
      if (own) {
        hitRoute = route;
        hitX = own.x;
      } else {
        // ② 跨线回退：按站码反查「哪些线路站序含该邻接对」（v0.26.1 修 #23）
        //    场景：一个会话里换乘到另一条线，后段不属于会话的 route_code。
        //    接受条件同样要求「在该线路站序里严格相邻」——若会话漏记了中间站，
        //    在那条线的站序里也不会相邻，因此不会产出错误的长段。
        const owners = adjOwners.get(`${mainCode(a.code)}→${mainCode(b.code)}`);
        if (owners) {
          for (const owner of owners) {
            if (owner === route) continue;
            for (const d of dirsByRoute.get(owner) ?? []) {
              const om = seqIdx.get(`${owner}|${d}`);
              if (!om) continue;
              const r2 = resolve(om, a.code, b.code, -1);
              if (r2) {
                hitRoute = owner;
                hitX = r2.x;
                st.recovered++;
                break;
              }
            }
            if (hitRoute) break;
          }
        }
      }
      if (!hitRoute) {
        const sa = seqsOf(m, a.code);
        const sb = seqsOf(m, b.code);
        if (!sa.length || !sb.length) st.unmatched++;
        else if (Math.min(...sb) < Math.min(...sa)) st.reverse++;
        else st.cross++;
        continue;
      }
      lastSeq = hitX;
      st.ok++;
      if (a.kind === "board") st.head++;
      if (b.kind === "alight") st.tail++;
      samples.push({
        route: hitRoute,
        from: a.code,
        to: b.code,
        weekday,
        bucket,
        arriveKind: arriveKindMode === "dest" ? kindOfEnd(b.kind) : kindOfStart(a.kind),
        minutes: r1(minutes),
        source,
        t: a.t.getTime(),
      });
    }
    return { samples, st };
  }

  const samples: SegmentSample[] = [];
  const stats = {
    head: 0, tail: 0, redirect: 0,
    sameStation: 0, zeroGap: 0, unmatched: 0, cross: 0, reverse: 0, recovered: 0, longDwell: 0,
  };

  /** 对一个行程跑两个方向，取顺向解更多的那个 */
  function runOne(
    route: string,
    pts: Pt[],
    dsatDir: string | null,
    weekday: number,
    bucket: string,
    source: "timer" | "free",
  ) {
    if (pts.length < 2) return;
    const d0 = dsatDir ?? "0";
    let bestRun: { samples: SegmentSample[]; st: Record<string, number> } | null = null;
    let usedDir = d0;
    for (const d of [d0, d0 === "0" ? "1" : "0"]) {
      const m = seqIdx.get(`${route}|${d}`);
      if (!m) continue;
      const run = extract(route, pts, m, weekday, bucket, source);
      if (!bestRun || run.st.ok > bestRun.st.ok) {
        bestRun = run;
        usedDir = d;
      }
    }
    if (!bestRun) return;
    if (usedDir !== d0) stats.redirect++;
    samples.push(...bestRun.samples);
    for (const k of [
      "head",
      "tail",
      "sameStation",
      "zeroGap",
      "unmatched",
      "cross",
      "reverse",
      "recovered",
      "longDwell",
    ] as const)
      stats[k] += bestRun.st[k] ?? 0;
  }

  /** ★ v4.2.0：非事件口径下恒为 0（`track` 不读旧表 ⇒ 如实报 0，不沿用历史值） */
  let sessionCount = 0;
  let rideCount = 0;
  if (withEvents) {
    const byTimer = new Map<number, Record<string, unknown>[]>();
    for (const e of timerEv) {
      const rid = e.rid as number;
      if (!byTimer.has(rid)) byTimer.set(rid, []);
      byTimer.get(rid)!.push(e);
    }
    for (const s of sessions) {
      const rows = byTimer.get(s.id as number) ?? [];
      if (rows.length < 2) continue;
      sessionCount++;
      const pts = toPoints(rows);
      const base: Date = pts[0]?.t ?? new Date(s.started_at as string);
      const mp = macauParts(base);
      runOne(
        s.route_code as string,
        pts,
        (s.dsat_dir as string | null) ?? null,
        (s.weekday as number | null) ?? mp.weekday,
        (s.time_bucket as string | null) ?? bucketOf(mp.hour),
        "timer",
      );
    }

    const byFree = new Map<number, Record<string, unknown>[]>();
    for (const e of freeEv) {
      const rid = e.rid as number;
      if (!byFree.has(rid)) byFree.set(rid, []);
      byFree.get(rid)!.push(e);
    }
    for (const r of freeRides) {
      const rows = byFree.get(r.id as number) ?? [];
      if (rows.length < 2) continue;
      rideCount++;
      const pts = toPoints(rows);
      const base: Date = pts[0]?.t ?? new Date(r.started_at as string);
      const mp = macauParts(base);
      runOne(
        r.route_code as string,
        pts,
        (r.dsat_dir as string | null) ?? null,
        mp.weekday,
        bucketOf(mp.hour),
        "free",
      );
    }
  }

  // ============ ③-b 合并 segment_samples 原始样本（sampleFrom = 'samples' | 'both' | 'track'）============
  // 从 segment_samples 读回**追踪采集**的原始样本，倒进同一条聚合管线（同口径：按
  // (route, from_station, to_station, weekday, time_bucket, arrive_kind) 分层）。
  // ⚠️ 键的对齐：segment_samples 同时存主码(from_main)与站台码(from_station)；此处用
  //    **站台码 from_station / to_station** —— 与事件路径（timer_events.station_code）以及
  //    现有 segment_stats.from_station/to_station 的口径**完全一致**（现有实现即用站台码）。
  // ⚠️ arrive_kind 档位：采集样本的起点站均为「DSAT status=1 停靠 → 翻 0 离开」，
  //    无「甩站」概念 → 一律归 **stop** 档（与手动「停靠」样本同档，优先被 lookupHop 的 L1/L2 取用）。
  let aggSamples: SegmentSample[] = samples;
  /** ★ v3.6.0：因终点站长停站被排除的 track 样本数（写入 stats.longDwell） */
  let trackLongDwell = 0;
  /**
   * ★ v4.1.0：`(route|from_station|to_station)` → 纯行驶分钟 p50（`minutes − dwell_B`）。
   *   仅 depart 口径且有 dwell 的样本参与（到达/末站口径没有对方站的停站数据，留 NULL）。
   *   ⚠️ 这里**不做长停站排除**：扣掉 dwell_B 之后「长停」已经被减掉了，
   *      排除它反而会把「司机休息」这一段的纯行驶样本丢掉。
   */
  const runP50 = new Map<string, number>();
  // ★ v3.6.0：长停站策略计数（仅 samples/both/track 路径加载；events 路径无 dwell 数据，保持 undefined）
  let longStopPolicyStats: LongStopPolicy["stats"] | undefined;
  if (sampleFrom !== "events") {
    // ★ v3.6.0：dwell_b_min 列由 db/migrate-v3600.ts 增加；迁移未执行时降级为 NULL（不阻塞重算）
    const dwellCol = Number(
      (
        await q(
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_name='segment_samples' AND column_name='dwell_b_min'`,
        )
      )[0]?.n ?? 0,
    ) > 0;
    /**
     * ★ v4.2.0：口径 → WHERE 的分派（**白名单**见函数顶部 `sampleFrom` 说明）。
     *   `both`    → 排除法（历史口径，行为与 v1.3.0~v4.1.x 完全一致）
     *   `track`   → 白名单：只放行 `source = 'track'`（生产口径）
     *   `samples` → 全表（诊断/对拍，会把 `source='timer'` 的手工留档行也读进来）
     */
    const whereSql =
      sampleFrom === "both"
        ? "WHERE source <> 'timer'"
        : sampleFrom === "track"
          ? "WHERE source = 'track'"
          : "";
    const tableRows = await q(
      `SELECT route_code, from_station, to_station, weekday, time_bucket, minutes, observed_at,
              arrive_kind, source,
              ${dwellCol ? "dwell_b_min" : "NULL::numeric AS dwell_b_min"}
         FROM segment_samples
        ${whereSql}`,
    );
    // ★ v3.6.0：终点站集合（任一线路某方向的 seq=1 或 seq=max）——长停站排除**只对总站生效**。
    //   为什么不能一刀切排除所有 dwell≥3：实测中途大站 M233（東北大馬路/東華）在 37 轮里
    //   有 176 段 ≥3 分挂站、涉及 90 辆车、p90 5.9 分（早晚高峰）——那是**真实排队/拥堵**，
    //   是乘客实际要等的时间，排掉会让 ETA 低估。总站休息则发生在**乘客下车之后**，不会推迟到达。
    // ★ v3.6.0：判据本体（总站集合 + 前置门 headway-sync / insufficient）在 `./long-stop.ts`
    //   —— **不要在本文件另写一套**。此处只按策略判定并累计计数。
    // ⚠️ 必须传 `isHoliday`：判据里的分桶要与本文件 ④ 段（`bucketOfRoute(..., holidays.has(...))`）
    //    **口径一致**，否则同一样本在两处落在不同桶（节假日在工作日会被判据算成高峰）。
    //    `getHolidays` 有模块级缓存（TTL 6h），此处提前加载不影响成本，下方 ④ 段复用同一变量。
    const holidays = await getHolidays(pool);
    const policy = await loadLongStopPolicy(q, (ms) => holidays.has(macauDayOf(ms)));
    longStopPolicyStats = policy.stats;
    const longStopScope = opts.longStopScope ?? "terminus";
    const fromTable: SegmentSample[] = [];
    /** ★ v4.1.0：纯行驶样本（depart ∧ dwell 已知）——与长停排除**无关**，独立聚合 */
    const runBuckets = new Map<string, number[]>();
    /** ★ v4.2.0：`segment_samples.source` 的合法取值（与 `SegmentSample["source"]` 同源） */
    const KNOWN_SOURCES = new Set<SegmentSample["source"]>(["timer", "free", "track"]);
    for (const r of tableRows) {
      /**
       * ★ v4.2.0：`source` 透传（以前硬写 `"track"`，因为 SELECT 没取该列）。
       * ⚠️ 遇到未知来源**必须抛错**：`bySource[s.source]++` 会把未知键写成 `NaN` 并
       *    **静默**通过（`bySource.track` 仍是正常数），门禁与日志都看不出来。
       *    抛错在这里，等于强制「新增采集源 → 显式登记到类型 + 白名单」这一动作。
       */
      const src = r.source as SegmentSample["source"] | null | undefined;
      if (src === null || src === undefined || !KNOWN_SOURCES.has(src))
        throw new Error(
          `segment_samples.source 出现未知取值 ${JSON.stringify(src)}` +
            `（合法：${[...KNOWN_SOURCES].join(" / ")}）—— 新增采集源必须先登记到 SegmentSample["source"]`,
        );
      const dwell =
        r.dwell_b_min === null || r.dwell_b_min === undefined ? null : Number(r.dwell_b_min);
      // ★ v4.1.0：纯行驶 = minutes − dwell_B（仅离开口径有终点站停站数据）。
      //   到达 / 末站口径的 `dwell_b_min` 为 NULL ⇒ 不参与（留 NULL，不猜）。
      if (String(r.arrive_kind) === "depart" && dwell !== null && Number.isFinite(dwell)) {
        const run = Number(r.minutes) - dwell;
        if (Number.isFinite(run) && run >= 0) {
          const rk = `${r.route_code}|${r.from_station}|${r.to_station}`;
          if (!runBuckets.has(rk)) runBuckets.set(rk, []);
          runBuckets.get(rk)!.push(run);
        }
      }
      // ★ v3.6.0：终点站长停站（dwell_B ≥ 阈值 ∧ 命中排除面）→ minutes 含司机休息，
      //   不参与时长聚合（否则 C656→C654 这类段的均值被系统性抬高）。
      //   ★ v4.1.1：阈值改**双档** —— 排除档 5 分（`LONG_STOP_EXCLUDE_MIN`），
      //   3~4 分（总站正常上落客）只由入库端写 `long_stop=true` 标记，**不再排除**。
      //   scope="any" 是**诊断开关**（含中途拥堵，会低估 ETA），生产默认 "terminus"。
      const isLongStop =
        longStopScope === "any"
          ? dwell !== null && dwell >= LONG_STOP_EXCLUDE_MIN
          : shouldExcludeLongStop(String(r.route_code), mainCode(r.to_station as string), dwell, policy);
      if (isLongStop) {
        trackLongDwell++;
        continue;
      }
      fromTable.push({
        route: r.route_code as string,
        from: r.from_station as string,
        to: r.to_station as string,
        weekday: r.weekday as number,
        bucket: r.time_bucket as string,
        arriveKind: "stop",
        minutes: Number(r.minutes),
        source: src,
        t: new Date(r.observed_at as string).getTime(),
        dwell,
        longStop: false,
      });
    }
    // ★ v4.2.0：`track` 与 `samples` 一样**只用表内样本**（不叠加事件路径的 `samples`）。
    //   `track` 口径下事件路径本就空转（`withEvents=false`），此处显式并列是为了让
    //   「哪些口径含事件样本」在代码里一眼可见，而不是靠上游空数组隐式成立。
    aggSamples =
      sampleFrom === "samples" || sampleFrom === "track" ? fromTable : [...samples, ...fromTable];
    // ★ v4.1.0：每对邻接站一条 p50_run_minutes（与分层/方向无关：lookupHop 按主码取用）
    for (const [k, v] of runBuckets) {
      const a = [...v].sort((x, y) => x - y);
      const n = a.length;
      const med = n % 2 ? a[(n - 1) / 2]! : r1((a[n / 2 - 1]! + a[n / 2]!) / 2);
      runP50.set(k, med);
    }
  }
  stats.longDwell = trackLongDwell;
  // ================= ④ 聚合 =================
  // ★ v3.4.0：分层键升级为「-1 | bucketOfRoute 新五桶 | kind」——
  //   桶从**观测时刻重算**（events 与 samples 两路统一口径；不信任样本携带的 bucket 值）。
  //   不再生成 weekday 精确行（实验⑦b/⑦c：星期维度无增益、周一可并入工作日池）。
  const keys = new Map<string, number[]>(); // route|from|to|weekday|bucket|kind -> minutes[]
  // ★ v3.5.5：澳门公众假期集合（lrt_holidays——分桶的「节假日按周末同款」判定；缓存 TTL 6h）
  //   ⚠️ 判据段（`loadLongStopPolicy` 之前）也取了一次；`getHolidays` 是**模块级缓存**（TTL 6h），
  //      两次调用拿到的是同一个 Set、零 DB 往返 ⇒ 两处口径必然一致，不会静默漂移。
  const holidays = await getHolidays(pool);
  const push = (route: string, from: string, to: string, w: number, b: string, k: string, min: number) => {
    const key = `${route}|${from}|${to}|${w}|${b}|${k}`;
    if (!keys.has(key)) keys.set(key, []);
    keys.get(key)!.push(min);
  };
  for (const s of aggSamples) {
    const mp = macauParts(new Date(s.t));
    // ★ v3.5.5：节假日按周末同款处理（澳门公众假期 ≈ 周末形态——数据源 lrt_holidays）
    const b2 = bucketOfRoute(mp.weekday, mp.hour, holidays.has(macauDayOf(s.t)));
    push(s.route, s.from, s.to, -1, b2, s.arriveKind, s.minutes); // 新桶 + 档位
    push(s.route, s.from, s.to, -1, "all", s.arriveKind, s.minutes); // 兜底 + 档位
    push(s.route, s.from, s.to, -1, "all", "all", s.minutes); // 兜底 + 合并
  }

  const p50 = (v: number[]) => {
    const a = [...v].sort((x, y) => x - y);
    const n = a.length;
    return n % 2 ? a[(n - 1) / 2] : r1((a[n / 2 - 1] + a[n / 2]) / 2);
  };
  const avg = (v: number[]) => r1(v.reduce((x, y) => x + y, 0) / v.length);

  const rows: (string | number | null)[][] = [];
  for (const [key, v] of keys) {
    const [route, from, to, w, b, k] = key.split("|");
    // ★ v4.1.0：纯行驶 p50（无 dwell 数据的对 ⇒ null，查询端按「无值」处理）
    const run = runP50.get(`${route}|${from}|${to}`) ?? null;
    rows.push([route, from, to, Number(w), b, k, avg(v), p50(v), v.length, run]);
  }

  // ================= ⑤ 写入 =================
  let inserted = 0;
  if (dry) {
    // 跳过写入
  } else {
    const client = await pool.connect();
    try {
      // ★ v4.1.0：`p50_run_minutes` 由 db/migrate-v4100-hop-basis.ts 增加。
      //   迁移未跑时降级为不写该列（不阻塞重算，查询端读到 NULL = 行为同旧版）。
      const hasRunCol =
        Number(
          (
            await client.query(
              `SELECT count(*)::int AS n FROM information_schema.columns
                WHERE table_name='segment_stats' AND column_name='p50_run_minutes'`,
            )
          ).rows[0]?.n ?? 0,
        ) > 0;
      await client.query("BEGIN");
      await client.query("DELETE FROM segment_stats");
      // 🚨 必须批量写：逐行 INSERT 会让「行数 × 单次跨区域往返」累积成总耗时。
      // Vercel 函数默认在 iad1（美东）、Supabase 在 ap-southeast-1（新加坡），
      // 单次往返约 230ms → 354 行 ≈ 80s，直接超过 maxDuration=60s 被掐断
      // （症状：ECONNRESET + 互斥锁卡死）。UNNEST 把全部行压成一次往返。
      if (rows.length) {
        const runCols = hasRunCol ? ", p50_run_minutes" : "";
        const runSel = hasRunCol ? ", $10::numeric[]" : "";
        const runAlias = hasRunCol ? ", runp" : "";
        await client.query(
          `INSERT INTO segment_stats
             (route_code, from_station, to_station, weekday, time_bucket, arrive_kind,
              avg_minutes, p50_minutes, samples, updated_at${runCols})
           SELECT r, f, t, w, b, k, a, p, s, now()${hasRunCol ? ", runp" : ""}
             FROM UNNEST($1::text[], $2::text[], $3::text[], $4::smallint[], $5::text[],
                         $6::text[], $7::numeric[], $8::numeric[], $9::int[]${runSel})
                  AS x(r, f, t, w, b, k, a, p, s${runAlias})`,
          [
            rows.map((r) => r[0]),
            rows.map((r) => r[1]),
            rows.map((r) => r[2]),
            rows.map((r) => r[3]),
            rows.map((r) => r[4]),
            rows.map((r) => r[5]),
            rows.map((r) => r[6]),
            rows.map((r) => r[7]),
            rows.map((r) => r[8]),
            ...(hasRunCol ? [rows.map((r) => r[9])] : []),
          ],
        );
      }
      await client.query("COMMIT");
      inserted = rows.length;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // ================= ⑥ 汇总（返回结构化结果，打印交给调用方） =================
  const bySource = { timer: 0, free: 0, track: 0 };
  for (const s of aggSamples) bySource[s.source]++;
  const byKind = { stop: 0, pass: 0 };
  for (const s of aggSamples) byKind[s.arriveKind]++;

  const routeCountMap = new Map<string, number>();
  for (const s of aggSamples) routeCountMap.set(s.route, (routeCountMap.get(s.route) ?? 0) + 1);

  const cmp = new Map<string, { stop: number[]; pass: number[] }>();
  for (const s of aggSamples) {
    const k = `${s.route}|${s.from}|${s.to}`;
    let bucket = cmp.get(k);
    if (!bucket) {
      bucket = { stop: [], pass: [] };
      cmp.set(k, bucket);
    }
    bucket[s.arriveKind].push(s.minutes);
  }
  const pairs: SegmentPairStat[] = [...cmp.entries()]
    .filter(([, v]) => v.stop.length && v.pass.length)
    .map(([key, v]) => ({ key, stop: v.stop, pass: v.pass }));
  const rep: SegmentPairStat[] = [...cmp.entries()]
    .filter(([, v]) => v.stop.length + v.pass.length >= 2)
    .sort((a, b) => b[1].stop.length + b[1].pass.length - (a[1].stop.length + a[1].pass.length))
    .map(([key, v]) => ({ key, stop: v.stop, pass: v.pass }));

  const fallback = [...keys.keys()].filter((k) => k.includes("|-1|all|")).length;

  return {
    sessions: sessionCount,
    rides: rideCount,
    samples: samples.length,
    bySource,
    byKind,
    stats,
    longStopPolicy: longStopPolicyStats,
    written: rows.length,
    layered: rows.length - fallback,
    routeCount: [...routeCountMap.entries()],
    pairs,
    rep,
    inserted,
    rawSamples: samples,
    sampleFrom,
  };
}

/** 求均值（供 CLI 报告复用） */
export const segAvg = (v: number[]) => r1(v.reduce((x, y) => x + y, 0) / v.length);
