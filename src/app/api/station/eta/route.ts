/**
 * GET /api/station/eta?code=<主码> —— 某巴士站的**全部线路实时报站**（v2.1.0 · 站点信息卡）
 *
 * ── 定位（产品口径 2026-09-19）─────────────────────────────────────────
 *   首页地图点击巴士站 → 信息卡：站名 + 该站**所有线路**的实时到站 + 「设为起点/目的地」。
 *   本接口只负责**实时报站**部分（站名/坐标由 `/api/stations` 提供）。
 *
 * ── 口径（★ 复用既有唯一实现，不自创第三套）────────────────────────────
 *   · 站序/方向/站名来自 `loadStatics().routeIdx`（= `route_stations` 内存索引，含 `dsat_dir`）；
 *   · 实时车距走 `fetchStationLive`（`src/lib/recommend/live.ts`）——与详情页「本站台其他线路」
 *     **同一函数**（内部 `queryEta`（`src/lib/dsat/eta.ts`）+ 逐跳 `segment_stats` 算分钟，
 *     禁「站数 × 常数」）⇒ 与 `/nav/detail` 报站文案口径**完全一致**。
 *
 * ── 每条 (线路 × 方向) 的构造（同 `nav/detail` 的 `foldLiveAt`）───────────
 *   该主码在某方向站序的**下一个站**作为 `dest` —— 用来自动定方向、并把**已过站**的车排除。
 *   终点站（无「下一站」）⇒ 跳过该方向（车从这里发车，无「到站」语义）。
 *
 * ── 只做巴士 ──────────────────────────────────────────────────────────
 *   轻轨走时刻表（非 DSAT），与本卡口径不同 ⇒ **跳过 `LRT-*`**（产品口径「只做巴士站」）。
 *
 * ── 并发 / 超时 / 缓存 ────────────────────────────────────────────────
 *   · 并发由 `fetchStationLive` 管理（每桶 ≤6 条线，桶间并发）；本接口再加**整体 8s 超时**兜底；
 *   · 内存小缓存 ~20s，防信息卡被连点打爆 DSAT（force 不可用，卡片重开命中缓存即可）。
 *
 * ── 降级 ──────────────────────────────────────────────────────────────
 *   单线失败/timeout ⇒ 该线 `ok=false`（卡片显示「这条线路暂时取不到报站」），**不拖垮整体**；
 *   整体失败 ⇒ `items` 为空数组（前端显示「暂无报站」），绝不 500 阻塞地图。
 *
 * 幂等：只读（DSAT 实时 + 内存缓存），无副作用。
 */
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { nowBucketOfHolidayAware } from "@/lib/rebuild/holidays";
import {
  type BiasIndex,
  type BiasLineRow,
  type BiasStationRow,
  buildBiasIndex,
  emptyBiasIndex,
  fixDeparture,
} from "@/lib/lrt/apply-bias";
import { LRT_PATTERN_ROUTE_NO } from "@/lib/lrt/pattern";
import { loadStatics } from "@/lib/recommend/query";
import { fetchStationLive } from "@/lib/recommend/live";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { BusLive } from "@/lib/recommend/types";
import { API_ERROR, errorResponse } from "@/lib/http/errors";
import {
  DSAT_BUCKET_CAPACITY,
  DSAT_QPS,
  RATE_BUCKET,
  acquireToken,
} from "@/lib/amap/rate-limit";

/** 就近部署：Supabase 新加坡池化器 → sin1；pg/DSAT 需要 Node 运行时；请求期动态执行 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 整体超时兜底（毫秒）——超过即按「无实时数据」返回，不阻塞卡片 */
const TOTAL_TIMEOUT_MS = 8_000;
/** 内存缓存 TTL（毫秒）——防连点打爆 DSAT */
const CACHE_TTL_MS = 20_000;

interface StationEtaItem {
  /** 线路码 */
  route: string;
  /** 查询方向（我们库 `dsat_dir`；轻轨为终点站码） */
  dir: string;
  /**
   * ★ v2.3.0（FIX-07 落点）：该线在本站的**站台码**（如 `T373/1`）。
   *   前端据此按主编号 + 站台分组（`mainCodeOf(platform)` 得主编号）。
   *   内部链路上早已算出（`meta.push({ platform: stops[i] })`），此前**未返回**。
   */
  platform: string;
  /** 方向显示标签（如「往 關閘總站」） */
  dirLabel: string;
  /** 最近一辆车还有几站；null = 暂无在途车（轻轨恒为 null） */
  stopsAway: number | null;
  /** 最近一辆车约几分钟到站；null = 暂无在途车 */
  etaMin: number | null;
  /** false = 该线查询失败/超时（区别于「查询成功但暂无车」） */
  ok: boolean;
  /**
   * ★ 2026-09-22 轻轨专用：载具种类，前端据此切换文案
   *   （巴士说「还有 N 站 · 约 M 分」，轻轨说「下一班 HH:MM · M 分后」）。
   */
  kind: "bus" | "lrt";
  /** ★ 2026-09-22 轻轨专用：下一班发车时刻 `HH:MM`（**已含实测偏差修正**）；无班次 ⇒ null */
  nextAt?: string | null;
  /**
   * ★ v2.10.1 轻轨专用：**秒级剩余**（至实际发车时刻）。
   *   前端据此做逐秒倒计时（仅横琴线/石排湾线展示到秒；氹仔线只显示分钟）。
   */
  etaSec?: number | null;
  /**
   * ★ 2026-09-24 轻轨专用：**下一班发车的绝对时刻**（UTC 毫秒，已含实测偏差 `biasSec`）。
   *   前端据此用**设备时钟**直接倒计时（不受网络往返 / 服务端缓存延迟影响）。
   *   背景：旧口径 `etaSec` 是「服务端处理那一刻」的相对快照，命中 20s 缓存时会整体偏大
   *   （用户实测反馈「时间不准确」）⇒ 改为下发绝对时刻，客户端 `left = depMs − now()`。
   */
  depMs?: number | null;
  /** ★ v2.10.1 轻轨专用：该线实测偏差（秒），供透明披露/诊断 */
  biasSec?: number;
  /**
   * ★ v3.2.0 轻轨专用：**是否有秒级偏差数据**（氹仔线模式命中 / 石排湾·横琴线路级）。
   *   缺省/undefined **必须安全回落 false**（分钟级）—— 前端窗口判定据此（AC-68/69）。
   */
  secPrecise?: boolean;
  /** ★ v3.2.0 轻轨专用：氹仔线命中的站间模式串（未命中/非氹仔线 = null） */
  pattern?: string | null;
}

interface StationEtaResponse {
  code: string;
  fetchedAt: string;
  /**
   * ★ v2.14.0（§3.1）：**本次响应生成时的服务端 `Date.now()`**（UTC 毫秒）。
   *   客户端据此算设备时钟相对服务端的偏移 `offsetMs = serverNowMs − Date.now()`，
   *   再用 `depMs − (Date.now() + offsetMs)` 做**不受缓存 / 网络延迟影响**的倒计时。
   *   老客户端忽略本字段 ⇒ 无感降级为 `offsetMs = 0`（＝v2.13 现行为）。
   */
  serverNowMs: number;
  items: StationEtaItem[];
}

const g = globalThis as unknown as { __stationEtaCache?: Map<string, { ts: number; data: StationEtaResponse }> };
if (!g.__stationEtaCache) g.__stationEtaCache = new Map();

/** 剥掉站名里的「站码前缀」（`C653 金峰南岸` → `金峰南岸`） */
function stripCodePrefix(raw: string): string {
  return raw.replace(/^[A-Za-z]+\d+(?:\/\d+)?\s+/, "");
}

/** 超时包装：到点即拒（调用方按「无数据」处理） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * ★ 2026-09-22 新增：**轻轨站的报站**（走时刻表，不是 DSAT 实时）。
 *
 * 数据源 `lrt_timetables`：一行 = （站 × 线路 × 方向 × 日期类型）的**发车时刻表**
 *   · `route_no`：`TPL` 氹仔线 / `SPVL` 石排湾线 / `HQL` 横琴线
 *   · `direction`：该班车**开往的终点站码**（`BAR`妈阁 / `TFT`氹仔码头 / `SPV`石排湾 / `UH`协和医院 / `LOT`莲花 / `HQ`横琴）
 *   · `day_type`：`mon_thurs` / `fri` / `sat_sun_holiday`
 *   · `minutes`：`[{hour, minutes:[分...]}]` 当日发车时刻
 *
 * 产品口径（用户 2026-09-22）：
 *   · **换乘站两条线都要显示** —— 数据天然如此（莲花 `LOT` 有 TPL+HQL、协和医院 `UH` 有 TPL+SPVL）；
 *   · **非首末站显示双方向** —— 同样天然如此（首末站如妈阁只有 1 个方向）；
 *   · 故本函数**枚举该站全部 (线路 × 方向)**，不额外筛选。
 */
const LRT_ROUTE_NAME: Record<string, string> = {
  TPL: "LRT-氹仔线",
  SPVL: "LRT-石排湾线",
  HQL: "LRT-横琴线",
};

/**
 * ★ v3.2.0：**偏差索引**（逐站/逐模式 + 线路级兜底）。
 *
 * 轻轨读秒「唯一真源」= `lrt_station_biases`（逐站/逐模式）；`lrt_route_params.dep_bias_sec`
 * 保留为石排湾/横琴**线路级兜底**（两线单模式）。取用一律经 `fixDeparture`（与 `/api/lrt/eta` 同源）。
 *
 * ⚠️ 表尚未建 / 查询失败 → 返回**空索引** ⇒ 全量回落分钟级（行为同旧版），**不抛错**
 *    （保证代码与数据可分先后上线）。
 */
async function loadLrtBiasIndex(
  pool: ReturnType<typeof getPool>,
  apiStation: string,
): Promise<BiasIndex> {
  const empty = Promise.resolve({ rows: [] as unknown[] });
  try {
    const [bs, lp] = await Promise.all([
      pool
        .query(
          `SELECT route_code, direction, pattern, api_station, dep_bias_sec
             FROM lrt_station_biases WHERE api_station = $1`,
          [apiStation],
        )
        .catch(() => empty),
      pool.query(`SELECT route_code, dep_bias_sec FROM lrt_route_params`).catch(() => empty),
    ]);
    if (!bs.rows.length && !lp.rows.length) return emptyBiasIndex();
    return buildBiasIndex(bs.rows as BiasStationRow[], lp.rows as BiasLineRow[]);
  } catch {
    return emptyBiasIndex();
  }
}

/**
 * ★ v3.2.0：该站氹仔线的模式映射（`${direction}|${day_type}|${dep_min}` → 模式）。
 *
 * ⚠️ 键**必须含 direction**：同一站同一 (day_type, dep_min) 在**两个方向**上可能分属不同模式
 *    （QA 实测 `AIR fri dep_min=451` → dir=BAR 为 `13222222222`、dir=TFT 为 `42322213132`；
 *     全表 984 个跨方向不同模式的键）⇒ 缺 direction 会把两个方向折叠，取到「后写入方向」的模式，
 *     使另一方向的班次命中错模式 → `secPrecise=false` 静默降级（AC-63 违反）。
 *     ⚠️ 与 `next-departures.ts#loadBiasAndPatterns`（`AND direction=$3`）语义同源。
 * ⚠️ 表未建 → 空映射 ⇒ 模式判定全回落（分钟级），不抛错。
 */
async function loadLrtPatterns(
  pool: ReturnType<typeof getPool>,
  apiStation: string,
): Promise<Map<string, string>> {
  const patterns = new Map<string, string>();
  try {
    const pr = await pool.query(
      `SELECT direction, day_type, dep_min, pattern FROM lrt_station_patterns
        WHERE api_station = $1 AND route_no = $2`,
      [apiStation, LRT_PATTERN_ROUTE_NO],
    );
    for (const r of pr.rows as { direction: string; day_type: string; dep_min: number; pattern: string }[]) {
      patterns.set(`${r.direction}|${r.day_type}|${r.dep_min}`, r.pattern);
    }
  } catch {
    /* 表不存在 → 空映射 */
  }
  return patterns;
}

/** 秒级偏移（自当日 00:00 起）→ `HH:MM`（跨午夜按次日显示为 24+ 会溢出，这里取模 24h） */
function fmtHm(secOfDay: number): string {
  const s = ((secOfDay % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 站码 → 显示名（去掉「站」后缀，与全站口径一致） */
function lrtStationName(raw: string): string {
  return raw.replace(/站$/, "");
}

async function lrtItems(
  pool: ReturnType<typeof getPool>,
  main: string,
  nowMs: number,
): Promise<StationEtaItem[]> {
  // ① 我们的码（`LRT-BAR`）→ 轻轨 API 码（`BAR`）
  const stRow = (
    await pool.query(`SELECT api_id, name_tc FROM lrt_api_stations WHERE db_code = $1 LIMIT 1`, [main])
  ).rows[0] as { api_id: string; name_tc: string } | undefined;
  if (!stRow) return [];
  const apiStation = stRow.api_id;

  // ② 日期类型 + 当日分钟偏移（澳门时间 GMT+8）
  const macau = new Date(nowMs + 8 * 3_600_000);
  const dow = macau.getUTCDay(); // 0=周日
  const dayType = dow === 5 ? "fri" : dow === 0 || dow === 6 ? "sat_sun_holiday" : "mon_thurs";
  const nowMin = macau.getUTCHours() * 60 + macau.getUTCMinutes();

  // ③ 该站全部 (线路 × 方向)
  const rows = (
    await pool.query(
      `SELECT route_no, direction, day_type, first_min, last_min, minutes
         FROM lrt_timetables WHERE api_station = $1`,
      [apiStation],
    )
  ).rows as { route_no: string; direction: string; day_type: string; first_min: number; last_min: number; minutes: unknown }[];

  // 终点站显示名（`BAR` → 媽閣），用于「往 XXX」
  const nameRows = (
    await pool.query(`SELECT api_id, name_tc FROM lrt_api_stations`)
  ).rows as { api_id: string; name_tc: string }[];
  const nameOfApi = new Map(nameRows.map((r) => [r.api_id, lrtStationName(r.name_tc)]));

  // ★ v3.2.0：偏差索引（逐站/逐模式 + 线路级兜底）+ 氹仔线模式映射。
  //   新表不存在 → 空 ⇒ 全量回落分钟级（不抛错）。
  const biasIndex = await loadLrtBiasIndex(pool, apiStation);
  const patterns = await loadLrtPatterns(pool, apiStation);

  const byKey = new Map<string, { route_no: string; direction: string; minutes: unknown; first_min: number; last_min: number }>();
  for (const r of rows) {
    if (r.day_type !== dayType) continue;
    byKey.set(`${r.route_no}|${r.direction}`, r);
  }

  const items: StationEtaItem[] = [];
  /** 当日**秒级**偏移（偏差是秒级，故不能只用分钟） */
  const nowSec = nowMin * 60 + macau.getUTCSeconds();
  /**
   * ★ 2026-09-24：澳门当日 00:00 的 **UTC 毫秒**（绝对发车时刻的基准）。
   *   `nowMs + 8h` 的「日内毫秒」直接扣掉即得当日零点（不依赖任何时区 API）。
   */
  const dayStartMs = nowMs - ((nowMs + 8 * 3_600_000) % 86_400_000);

  for (const [key, r] of byKey) {
    const [routeNo, direction] = key.split("|");
    const route = LRT_ROUTE_NAME[routeNo] ?? routeNo;

    let blocks: { hour: number; minutes: number[] }[] = [];
    try {
      blocks = typeof r.minutes === "string" ? JSON.parse(r.minutes) : ((r.minutes as typeof blocks) ?? []);
    } catch {
      blocks = [];
    }

    /**
     * ★ v3.2.0：**逐班**经 `fixDeparture`（与 `/api/lrt/eta` 同一唯一出口）叠加偏差，
     *   取「（叠加后）仍在未来」的最近一班 —— 未命中模式/线路级偏差缺失 → 回落表定秒。
     *   偏差为负（石排湾 -5s）时，「该分钟内实际已开出」的班次不再被错报为下一班。
     */
    let best: { depMs: number; biasSec: number; secPrecise: boolean; pattern: string | null; tableSec: number } | null = null;
    if (nowMin <= r.last_min) {
      for (const b of blocks ?? []) {
        for (const m of b.minutes ?? []) {
          const depMin = b.hour * 60 + m;
          const pattern =
            routeNo === LRT_PATTERN_ROUTE_NO
              ? (patterns.get(`${direction}|${dayType}|${depMin}`) ?? null)
              : null;
          const fix = fixDeparture({
            lineCode: route,
            routeNo,
            directionApi: direction,
            apiStation,
            dayType,
            tableMin: depMin,
            dayStartMs,
            pattern,
            biasIndex,
          });
          if (fix.depMs <= nowMs) continue;
          if (!best || fix.depMs < best.depMs) {
            best = {
              depMs: fix.depMs,
              biasSec: fix.biasSec,
              secPrecise: fix.secPrecise,
              pattern: fix.pattern,
              tableSec: depMin * 60,
            };
          }
        }
      }
    }

    const nextSec = best ? best.tableSec + best.biasSec : null;
    const etaSec = best && nextSec !== null ? Math.max(0, nextSec - nowSec) : null;
    // 分钟级（向后兼容旧前端）：向上取整，避免「还有 0 分」却还没发车
    const etaMin = etaSec === null ? null : Math.ceil(etaSec / 60);
    // ★ 绝对发车时刻（含偏差，由 fixDeparture 产出）；前端读秒的唯一依据（设备时钟倒计时）
    const depMs = best ? best.depMs : null;

    items.push({
      route,
      dir: direction,
      platform: apiStation,
      dirLabel: `往 ${nameOfApi.get(direction) ?? direction}`,
      // 轻轨没有「还有几站」概念（时刻表制）⇒ 恒 null，前端据 `kind` 切文案
      stopsAway: null,
      etaMin,
      /** 秒级剩余（前端读秒用；氹仔线只显示分钟、横琴/石排湾显示到秒） */
      etaSec,
      /** 绝对发车时刻（UTC 毫秒）——设备时钟倒计时用 */
      depMs,
      /** 实际叠加偏差（秒）；未命中 = 0 */
      biasSec: best ? best.biasSec : 0,
      /** ★ v3.2.0：本班是否有秒级偏差数据（前端窗口/文案判定；缺省安全回落 false） */
      secPrecise: best ? best.secPrecise : false,
      /** ★ v3.2.0：氹仔线命中的站间模式串（未命中/非氹仔线 = null） */
      pattern: best ? best.pattern : null,
      ok: true,
      kind: "lrt",
      nextAt: nextSec === null ? null : fmtHm(nextSec),
    });
  }
  return items;
}

export async function GET(req: NextRequest) {
  // ★ v3.6.0（S2）：拆口令门后本接口公开（首页点站点卡就会调）⇒ 加 `dsat` 令牌桶出口限流
  //   （复用 `amap_rate_bucket` 表，无 DDL）。超桶 ⇒ 429 固定枚举 `rate_limited`，绝不 500。
  //   限流放在缓存之前：缓存省的是上游 DSAT 调用，省不了请求本身，而滥用面正是请求量。
  const rl = await acquireToken(RATE_BUCKET.dsat, DSAT_QPS, DSAT_BUCKET_CAPACITY);
  if (!rl.ok) {
    return errorResponse(API_ERROR.rate_limited, undefined, { "Retry-After": "1" });
  }

  const sp = req.nextUrl.searchParams;
  const code = sp.get("code")?.trim() ?? "";
  if (!code) {
    return errorResponse(API_ERROR.bad_request);
  }
  const main = mainCodeOf(code);
  const nowMs = Date.now();
  /**
   * ★ 2026-09-24：轻轨站**跳过内存缓存** —— 数据源是本地库（非 DSAT），查询廉价，
   *   且必须每次最新：① 发车时刻需按键滚动到「下一班」② `depMs` 绝对时刻不可陈旧。
   */
  const isLrt = main.startsWith("LRT-");

  // ① 内存缓存（连点保护；仅巴士 —— 保护 DSAT）
  const cached = g.__stationEtaCache!.get(main);
  if (!isLrt && cached && nowMs - cached.ts < CACHE_TTL_MS) {
    // ★ v2.14.0（§3.1）：命中缓存时 `cached.data.serverNowMs` 是**写入时刻**（偏旧）
    //   ⇒ 用当前 `nowMs` 覆盖，保证对时基准新鲜；其余字段复用缓存（不重打 DSAT）。
    return NextResponse.json(
      { ...cached.data, serverNowMs: nowMs },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  let items: StationEtaItem[] = [];
  try {
    const pool = getPool();

    // ★ 2026-09-22：**轻轨站**走时刻表分支（此前一律跳过 ⇒ 点轻轨站没有报站）
    if (main.startsWith("LRT-")) {
      items = await lrtItems(pool, main, nowMs);
    } else {
      const st = await loadStatics(pool);
      const idx = st.routeIdx;
      const nowBucket = await nowBucketOfHolidayAware(pool, nowMs);

      // ② 枚举该主码出现的全部 (线路 × 方向)，构造「本站 → 下一站」查询作业
      const jobs: { station: string; dest: string; routes: string[] }[] = [];
      const meta: { route: string; dir: string; platform: string; dirLabel: string }[] = [];
      for (const [key, stops] of idx.dirStops) {
        const [route, dir] = key.split("|");
        if (route.startsWith("LRT-")) continue; // 只做巴士（轻轨走时刻表，口径不同）
        const i = stops.findIndex((c) => mainCodeOf(c) === main);
        if (i < 0) continue;
        if (i + 1 >= stops.length) continue; // 终点站：无「下一站」定方向 → 跳过
        const platform = stops[i];
        const terminal = idx.nameOf.get(stops[stops.length - 1]) ?? stops[stops.length - 1];
        jobs.push({ station: platform, dest: stops[i + 1], routes: [route] });
        meta.push({ route, dir, platform, dirLabel: `往 ${stripCodePrefix(terminal)}` });
      }

      if (jobs.length) {
        // ③ 实时（复用 fetchStationLive：与详情页报站同一实现）；整体超时兜底
        const liveMap = await withTimeout(
          fetchStationLive(pool, jobs, idx, st.segIdx, { nowBucket, nowMs }),
          TOTAL_TIMEOUT_MS,
        ).catch((): Map<string, BusLive> => new Map());

        items = meta.map((m) => {
          const bl = liveMap.get(`${m.route}@${m.platform}`);
          const n = bl?.nearest ?? null;
          return {
            route: m.route,
            dir: m.dir,
            platform: m.platform,
            dirLabel: m.dirLabel,
            stopsAway: n ? n.stopsAway : null,
            // ★ v3.5.0：改用单值点估计 etaSec（含位置修正）；缺省回退区间中点（旧口径 loSec 在
            //   v3.4.1 区间重标定后 = 0.6×base，会系统性偏低——本处修正）
            etaMin: n
              ? Math.max(0, Math.round((n.etaSec ?? (n.loSec + n.hiSec) / 2) / 60))
              : null,
            ok: !!bl, // 有 BusLive = 查询成功（nearest 为空 = 该方向暂无在途车，仍算成功）
            kind: "bus" as const,
          };
        });
      }
    }
  } catch (e) {
    console.warn("[api/station/eta] 失败（收敛为空）：", (e as Error).message);
    items = [];
  }

  // ④ 按 etaMin 升序（暂无车排在最后）；同值按线路码稳定排序
  items.sort((a, b) => (a.etaMin ?? Number.POSITIVE_INFINITY) - (b.etaMin ?? Number.POSITIVE_INFINITY) || a.route.localeCompare(b.route));

  const data: StationEtaResponse = {
    code: main,
    fetchedAt: new Date(nowMs).toISOString(),
    serverNowMs: nowMs,
    items,
  };
  // ★ 2026-09-24：轻轨不写缓存（见上方 isLrt 说明）——保证时刻滚动与 depMs 新鲜
  if (!isLrt) g.__stationEtaCache!.set(main, { ts: nowMs, data });
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
