/**
 * 站间时长「原始样本」入库（共享层，v1.3.0）
 *
 * 从 CLI 脚本 scripts/import-segment-samples.ts 抽取的核心逻辑，接受 pool 的纯函数，
 * 与项目既有 rebuild 逻辑同构（共享层 + CLI 两层），以便日后供 Vercel Cron 复用：
 *   · CLI：npm run db:segsamples [-- --apply]
 *   · （预留）API：/api/cron/* 定时把当天采集产物入库
 *
 * ── 两条数据源 → 同一张表 `segment_samples` ────────────────────────────
 *   ① `source='track'` 自动采集：读 `data/tracking/*-derived.json` 顶层的
 *      `rawDepartSamples`（离开口径）+ `rawTerminalSamples`（★ v4.1.0 末站口径，
 *      `arrive_kind='terminal'`）。两条流**并列写入**，`kind` 原样透传 —— 不再硬编码。
 *      字段映射：route→route_code · dir(字符串)→dir(smallint) · plate→plate · from→from_main ·
 *      to→to_main · fromSta→from_station · toSta→to_station · fromIdx→from_idx · minutes→minutes ·
 *      t(毫秒)→observed_at · kind→arrive_kind · 文件名(label)→run_label ·
 *      minutes−dwellMin→run_minutes（★ v4.1.0，仅 depart 口径有 dwell）。
 *      ★ weekday / time_bucket 由 observed_at 按**澳门时区**推算 —— **复用**
 *        segment-stats.ts 导出的 `macauParts` / `bucketOf`，不另起一套口径。
 *   ② `source='timer'` 手动实测：由 segment-stats.ts 的事件路径（timer_sessions + timer_events）
 *      产出的原始段样本，口径与之**完全一致**；run_label 固定 'timer'，dir/plate/from_idx 为 NULL。
 *
 * ⚠️ **到达口径（`rawArriveSamples`）当前刻意不入库**：派生器只把它做成诊断聚合，
 *    历史产物里也没有该数组。若将来入库，必须同时让 `segment_stats` 的聚合按
 *    `arrive_kind` 过滤，否则同一跳会被 depart + arrive 各算一遍（均值漂移）。
 *    本批只做**纯增量**：新写入的 terminal 样本落在原先结构性无样本的末站跳上，
 *    不会与已有 depart 样本同键重叠（派生器已保证：非环线末站有 depart 时不再造 terminal 样本）。
 *
 * ⚠️ **跨站口径（`rawSpannedSamples`，v4.1.1）同样刻意不入库**：它的 minutes 含中间站的全部停站，
 *    与「邻接段」不是同一个量。而 `segment_stats` / `route_hop_stats` / 长停判据三者都直接
 *    `SELECT ... FROM segment_samples` **不按 arrive_kind 过滤** ⇒ 一旦入库就会污染邻接段 p50/avg
 *    （历史上放宽 `d===1` 曾造出 σ=75.7 秒的假区间）。要启用必须先做两件事：
 *    ① 三处聚合加 `arrive_kind <> 'spanned'` 过滤；② 按 `minutes/(spanned_stations+1)` 分摊到子段，
 *    且**仅在子段完全无样本时**兜底。本批不做，明细留在 derived.json 里供事后核对。
 *
 * ── 轮级质量闸（v4.1.1）──────────────────────────────────────────────
 *   `run_label` 命中 `test|selftest|smoke|debug`、或单轮有效样本数 < `MIN_RUN_SAMPLES`（50）
 *   → **整轮跳过**，并把 label / 样本数 / 原因落盘到 `.verify/run-gate-skipped-<时间戳>.tsv`。
 *   依据与「为什么是 50」见 `MIN_RUN_SAMPLES` 上方注释（57 轮分布 1 → 1,613 之间是断崖）。
 *
 * ── 幂等 ──────────────────────────────────────────────────────────────
 *   唯一约束 + `ON CONFLICT DO NOTHING`（重复导入同一轮/同一样本不会翻倍）。
 *
 * ── 批量写 + 事务 ──────────────────────────────────────────────────────
 *   逐行 INSERT 在「跨区域 Vercel→Supabase」场景下会把「行数 × 往返延迟」累积成总耗时并撞
 *   maxDuration（详见 src/lib/rebuild/transfer-walks.ts:249 与 segment-stats.ts:544 的注释），
 *   故一律 `UNNEST` 一次多行、整体包在 `BEGIN/COMMIT` 里。
 *
 * ── 滚动窗口 ──────────────────────────────────────────────────────────
 *   写完后删除「不属于最近 keepRuns 轮」的 `source='track'` 行；`source='timer'` **永不删除**。
 */
import fs from "node:fs";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { rebuildSegmentStats, macauParts, mainCode } from "./segment-stats";
import { bucketOfRoute } from "./buckets";

/** 段样本口径——**取值域的唯一真相源**（DB 列 `segment_samples.arrive_kind`）。
 *  · depart   = 离开口径（离 B − 离 A，含终点站停站 dwell_B）——主口径
 *  · arrive   = 到达口径（到 B − 到 A）——对照口径，当前不入库（见文件头说明）
 *  · terminal = **末站口径**（到达末站 − 离开倒数第二站）——v4.1.0 新增，纯增量
 */
export const ARRIVE_KINDS = ["depart", "arrive", "terminal"] as const;
export type ArriveKind = (typeof ARRIVE_KINDS)[number];

/** 归一：未知值一律退回主口径 `depart`（老产物可能没有 kind 字段） */
export function normalizeArriveKind(v: unknown): ArriveKind {
  return (ARRIVE_KINDS as readonly string[]).includes(String(v)) ? (String(v) as ArriveKind) : "depart";
}

/** 一条待入库的原始样本（与 segment_samples 列对齐） */
export interface SegmentSampleRow {
  run_label: string;
  route_code: string;
  dir: number | null;
  plate: string | null;
  from_main: string;
  to_main: string;
  from_station: string;
  to_station: string;
  from_idx: number | null;
  minutes: number;
  /** ★ 计时口径（`depart` | `arrive` | `terminal`），**不是** segment_stats 的 stop/pass */
  arrive_kind: ArriveKind;
  /** ★ v1.2.0：终点站停站时长（分）。离开口径下 minutes = run(A→B) + dwell_B，
   *  dwell_b_min 即 dwell_B。老产物 / timer 样本没有这一项 → NULL。 */
  dwell_b_min?: number | null;
  /** ★ v4.1.0：纯行驶时长（分）= minutes − dwell_b_min。仅 depart 口径且有 dwell 时有值，
   *  到达 / terminal 口径留 NULL（没有终点站停站数据，不猜）。 */
  run_minutes?: number | null;
  /** ★ v1.2.0：dwell_B ≥ 长停站阈值（默认 3 分）→ 该样本的 minutes 含停站，非纯行驶 */
  long_stop?: boolean;
  source: "track" | "timer";
  observed_at: Date;
  weekday: number;
  time_bucket: string;
}

/** 单轮导入统计 */
export interface RunStat {
  runLabel: string;
  read: number;
  inserted: number;
  skipped: number;
}

/** ★ v4.1.1：被**轮级质量闸**跳过的轮（不静默：既进返回值也落盘） */
export interface RunSkip {
  runLabel: string;
  samples: number;
  reason: string;
}

/**
 * ── 轮级质量闸（v4.1.1）────────────────────────────────────────────
 * 背景（实测 57 轮 / 202,790 条有效样本）：`segment_samples` 里混进了两类不该进来的轮 ——
 *   · `selftest-e`：测试标签，1 条样本
 *   · `20260919-234737`：1 分钟的秒断轮（进程刚起就停），1 条样本
 * 这类轮的样本数只有个位数，一旦被 `route_hop_stats` 当「该跳唯一样本」就会变成 p50（ETA 直接错），
 * 而它们的**标签**又看不出问题（后者长得跟正常轮次一模一样）⇒ 只能靠样本数兜底。
 *
 * 阈值取 50 的依据（不是拍脑袋）：57 轮的样本数分布为
 *   min 1 · p10 2,861 · p25 3,113 · 中位 3,705 · max 5,122，且 **< 50 的只有 2 轮（都是上面那两类）**，
 *   第 3 小的轮是 1,613 条 —— 1 → 1,613 之间是完全空的断崖 ⇒ 50 不会误杀任何正常轮。
 *   （若将来出现 40~60 条的正常短轮，应改用「相对中位数」判据：`< median/10`。）
 */
export const RUN_LABEL_SKIP_RE = /test|selftest|smoke|debug/i;
/** 单轮有效样本数下限（低于它视为「异常短轮」）。见上面的分布依据。 */
export const MIN_RUN_SAMPLES = 50;

/** ★ 批 1 · U-01（v4.1.2）：单轮运行元数据。
 *  由 `track-derive.mjs` 从 `<label>-meta.json` 透传进 `derived.json` 顶层 `runMeta`。
 *  · `aborted=null` = 正常跑完整个窗口；非 null = 中止原因（硬熔断 / 信号中断）。
 *  · `metaAvailable=false`（或整个对象读不到）= 「未知」⇒ 放行 + 计数 + WARN，不 fail-closed。
 *  · `durationMin` / `plannedMinutes` 只落字段，**不参与判据**（次级判据未启用，避免误杀
 *    `--minutes=10` 的合法短轮；负责人裁定「只落字段不判」）。
 */
export interface RunMeta {
  aborted: string | null;
  metaAvailable: boolean;
  durationMin: number | null;
  rounds: number | null;
  plannedMinutes: number | null;
}

/** 轮级闸启用 `aborted` 判据的最小 `schemaVersion`。
 *  ★ 分歧②裁定 (a)：**闸仅对 `schemaVersion>=2` 的新轮生效，存量轮维持现状**。
 *    依据（只读实跑）：存量 `20260914-093900` 轮 3,176 条已在库且贡献 59 路 T317→M9
 *    标杆 1/49 条；剔除它 ⇒ `samples 49→48`、`p50_sec 824.76→837.39`，会破坏 G3 锚点。
 *    存量 57 个 `derived.json` 顶层实测均无 `schemaVersion`/`runMeta` ⇒ 自动走「维持现状」。
 */
export const RUN_GATE_MIN_SCHEMA = 2;

/** 把 derived.json 顶层的 `runMeta` 归一成 `RunMeta`（脏字段一律退回安全值）。 */
export function normalizeRunMeta(v: unknown): RunMeta | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const f = (x: unknown): number | null => {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };
  return {
    aborted: o.aborted === null || o.aborted === undefined ? null : String(o.aborted),
    metaAvailable: o.metaAvailable === true,
    durationMin: f(o.durationMin),
    rounds: f(o.rounds),
    plannedMinutes: f(o.plannedMinutes),
  };
}

/** 从 `<dataDir>/<label>-meta.json` 读运行元数据（存量 derived 无 `runMeta` 时的兼容回查）。
 *  只读、不连库；读不到返回 `null`（调用方按「未知」放行 + 计数 + WARN）。
 */
export function readRunMeta(dataDir: string, label: string): RunMeta | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, `${label}-meta.json`), "utf8")) as {
      aborted?: string | null;
      durationMin?: number;
      cfg?: { minutes?: number };
      totals?: { rounds?: number };
    };
    return {
      aborted: j.aborted === null || j.aborted === undefined ? null : String(j.aborted),
      metaAvailable: true,
      durationMin: Number.isFinite(Number(j.durationMin)) ? Number(j.durationMin) : null,
      rounds: Number.isFinite(Number(j.totals?.rounds)) ? Number(j.totals?.rounds) : null,
      plannedMinutes: Number.isFinite(Number(j.cfg?.minutes)) ? Number(j.cfg?.minutes) : null,
    };
  } catch {
    return null;
  }
}

export interface GateResult {
  pass: boolean;
  reason: string;
  /** true = `meta` 读不到 ⇒ 放行但必须计入 unknownMeta 并打 WARN（防静默） */
  unknownMeta: boolean;
}

/** ★ U-01 轮级质量闸（**纯函数、不连库、无副作用**，供 `scripts/test-run-gate.ts` 直接 import）。
 *  判据顺序：既有 `RUN_LABEL_SKIP_RE` / `MIN_RUN_SAMPLES` 两闸（对所有轮生效，行为不变）
 *            → (a) 仅 `schemaVersion>=2` 的新轮加跑 `aborted` 判据，存量轮直接放行
 *            → `meta==null` 放行 + `unknownMeta=true`
 *            → `meta.aborted!=null` 拒绝（**只过滤导入，不删库内既有行**）
 */
export function gateRun(
  b: { label: string; rows: number; schemaVersion: number | null; runMeta: RunMeta | null },
  fallbackMeta: RunMeta | null,
): GateResult {
  const reasons: string[] = [];
  if (RUN_LABEL_SKIP_RE.test(b.label)) reasons.push(`run_label 命中 ${RUN_LABEL_SKIP_RE}（测试/调试轮）`);
  if (b.rows < MIN_RUN_SAMPLES) reasons.push(`样本数 ${b.rows} < 门槛 ${MIN_RUN_SAMPLES}`);
  if (reasons.length) return { pass: false, reason: reasons.join(" · "), unknownMeta: false };

  const isNew = b.schemaVersion !== null && b.schemaVersion >= RUN_GATE_MIN_SCHEMA;
  if (!isNew) return { pass: true, reason: "", unknownMeta: false };

  const meta = b.runMeta ?? fallbackMeta;
  if (meta === null || meta.metaAvailable === false) {
    return { pass: true, reason: "", unknownMeta: true };
  }
  if (meta.aborted !== null) {
    return { pass: false, reason: `aborted: ${meta.aborted}`, unknownMeta: false };
  }
  return { pass: true, reason: "", unknownMeta: false };
}

export interface ImportResult {
  dry: boolean;
  /** 逐轮（track 文件）统计，按观测时间从新到旧 */
  runs: RunStat[];
  /** 手动实测导入统计（单批） */
  timer: RunStat;
  totals: { read: number; inserted: number; skipped: number };
  /** 滚动窗口删除的行数 */
  windowDeleted: number;
  /** 说明：未传 --apply 时 windowDeleted 为「将要删除」的估算 */
  keepRuns: number;
  /** ★ v4.1.1：被轮级质量闸跳过的轮（dry 与 apply 都会算出来并落盘） */
  skippedRuns: RunSkip[];
  db: {
    total: number;
    bySource: Record<string, number>;
    topRuns: [string, number][];
  };
}

export interface ImportOpts {
  /** true = 只统计不写库（默认 CLI 行为） */
  dry?: boolean;
  /** 只导入最近 N 轮 track（默认全部） */
  runs?: number;
  /** 单文件导入（覆盖目录扫描） */
  fromFile?: string;
  /** 采集产物目录（默认 <cwd>/data/tracking） */
  dataDir?: string;
  /** 滚动窗口保留轮数（默认 30；<=0 表示不清理） */
  keepRuns?: number;
  /** 是否导入手动实测 timer（默认 true） */
  timer?: boolean;
  /** 日志回调 */
  log?: (s: string) => void;
}

const DEFAULT_DATA_DIR = () => path.resolve(process.cwd(), "data/tracking");

/**
 * 读取单个 derived.json，解析出 track 原始样本 + 该轮最大观测时刻（用于排序/滚动窗口）。
 *
 * ★ run_label 取 **JSON 顶层的 `label` 字段**，不是文件名 ✗ —— 因为文件名规则并不统一：
 *   多数是 `YYYYMMDD-HHMMSS`（15 字符，如 `20260918-213415`），但 `r10-day-1646` /
 *   `r11-day-1724` / `r12-day-1800` / `selftest-e` 这些轮次**不是时间戳格式**。
 *   而 JSON 里的 `label` 由派生器（track-derive.mjs）写入、与产物一一对应，最稳。
 *   （文件名去 `-derived.json` 后缀仅作**兜底**，正常情况下不会用到。）
 */
function readTrackFile(file: string): {
  label: string;
  rows: SegmentSampleRow[];
  maxT: number;
  /** ★ U-01：新格式 derived.json 带 schemaVersion/runMeta；存量 57 轮两字段皆缺省 ⇒ null */
  schemaVersion: number | null;
  runMeta: RunMeta | null;
} {
  const j = JSON.parse(fs.readFileSync(file, "utf8")) as {
    label?: string;
    schemaVersion?: number;
    runMeta?: unknown;
    rawDepartSamples?: Record<string, unknown>[];
    /** ★ v1.4.0：末站口径样本（到达末站 − 离开倒数第二站） */
    rawTerminalSamples?: Record<string, unknown>[];
  };
  const label = String(j.label ?? path.basename(file).replace(/-derived\.json$/, ""));
  const schemaVersion =
    j.schemaVersion !== undefined && Number.isFinite(Number(j.schemaVersion))
      ? Number(j.schemaVersion)
      : null;
  const runMeta = normalizeRunMeta(j.runMeta);
  const raw = [
    ...(Array.isArray(j.rawDepartSamples) ? j.rawDepartSamples : []),
    ...(Array.isArray(j.rawTerminalSamples) ? j.rawTerminalSamples : []),
  ];
  const rows: SegmentSampleRow[] = [];
  let maxT = -Infinity;
  for (const s of raw) {
    const t = Number(s.t);
    if (!Number.isFinite(t)) continue; // 缺时刻的样本无法分层，丢弃（采集产物中不应出现）
    const d = new Date(t);
    const mp = macauParts(d);
    if (t > maxT) maxT = t;
    const kind = normalizeArriveKind(s.kind);
    const dwell =
      s.dwellMin === null || s.dwellMin === undefined || !Number.isFinite(Number(s.dwellMin))
        ? null
        : Number(s.dwellMin);
    // ★ v4.1.0：纯行驶 = minutes − dwell_B，只在 depart 口径且有 dwell 时成立
    const run =
      kind === "depart" && dwell !== null && Number.isFinite(Number(s.minutes))
        ? Math.max(0, Number(s.minutes) - dwell)
        : null;
    rows.push({
      run_label: label,
      route_code: String(s.route),
      dir: s.dir === null || s.dir === undefined ? null : Number(s.dir),
      plate: s.plate === null || s.plate === undefined ? null : String(s.plate),
      from_main: String(s.from),
      to_main: String(s.to),
      from_station: String(s.fromSta),
      to_station: String(s.toSta),
      from_idx: s.fromIdx === null || s.fromIdx === undefined ? null : Number(s.fromIdx),
      minutes: Number(s.minutes),
      arrive_kind: kind,
      // ★ v1.2.0：派生器（track-derive v1.2.0+）随样本落盘 dwell_B；老产物没有 → undefined → NULL
      dwell_b_min: dwell,
      run_minutes: run,
      long_stop: s.longStop === true,
      source: "track",
      observed_at: d,
      weekday: mp.weekday,
      time_bucket: bucketOfRoute(mp.weekday, mp.hour),
    });
  }
  return { label, rows, maxT: Number.isFinite(maxT) ? maxT : -Infinity, schemaVersion, runMeta };
}

/** 列出采集产物文件（排除位置分片；derived.json 才是样本产物） */
function listDerivedFiles(dataDir: string, fromFile?: string): string[] {
  if (fromFile) {
    const f = path.resolve(fromFile);
    if (!fs.existsSync(f)) throw new Error(`--from-file 不存在：${f}`);
    return [f];
  }
  if (!fs.existsSync(dataDir)) throw new Error(`采集产物目录不存在：${dataDir}`);
  return fs
    .readdirSync(dataDir)
    .filter((f) => f.endsWith("-derived.json"))
    .sort()
    .map((f) => path.join(dataDir, f));
}

/** 由事件路径产出的**手动实测**段样本（口径与 segment-stats.ts 完全一致） */
async function collectTimerRows(pool: Pool): Promise<SegmentSampleRow[]> {
  const r = await rebuildSegmentStats(pool, { dry: true });
  return r.rawSamples
    .filter((s) => s.source === "timer")
    .map((s) => {
      const mp = macauParts(new Date(s.t));
      return {
        run_label: "timer",
        route_code: s.route,
        dir: null, // 手动实测：方向可为 NULL
        plate: null,
        from_main: mainCode(s.from),
        to_main: mainCode(s.to),
        from_station: s.from,
        to_station: s.to,
        from_idx: null,
        minutes: s.minutes,
        arrive_kind: "depart", // 事件路径即「离开口径」（见 segment-stats.ts 文件头定案）
        dwell_b_min: null,
        run_minutes: null, // 事件路径没有 dwell_B 直测（无终点站停站数据）⇒ 纯行驶不可得
        long_stop: false,
        source: "timer" as const,
        observed_at: new Date(s.t),
        weekday: s.weekday,
        time_bucket: bucketOfRoute(mp.weekday, mp.hour), // ★ v3.4.0：统一口径重算
      };
    });
}

/** UNNEST 批量 UPSERT（ON CONFLICT DO NOTHING）；返回实际插入行数
 *  ★ v1.2.0：`dwell_b_min` / `long_stop` 两列由 db/migrate-v3600.ts 增加。
 *  迁移**尚未执行**时（生产库只读窗口 / 未报批）本函数仍可工作 —— 自动降级为不写入这两列，
 *  避免「代码先上、迁移未跑」直接把入库打挂。列存在性每次进程只查一次（缓存）。
 */
let _dwellCols: boolean | null = null;
async function hasDwellColumns(client: PoolClient): Promise<boolean> {
  if (_dwellCols !== null) return _dwellCols;
  const r = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'segment_samples' AND column_name IN ('dwell_b_min','long_stop')`,
  );
  _dwellCols = Number((r.rows[0] as { n: number } | undefined)?.n ?? 0) >= 2;
  return _dwellCols;
}

/** ★ v4.1.0：`run_minutes` 列（db/migrate-v4100-hop-basis.ts 增加）；迁移未跑时降级不写 */
let _runCol: boolean | null = null;
async function hasRunColumn(client: PoolClient): Promise<boolean> {
  if (_runCol !== null) return _runCol;
  const r = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'segment_samples' AND column_name = 'run_minutes'`,
  );
  _runCol = Number((r.rows[0] as { n: number } | undefined)?.n ?? 0) > 0;
  return _runCol;
}

async function insertBatch(client: PoolClient, rows: SegmentSampleRow[]): Promise<number> {
  if (!rows.length) return 0;
  const withDwell = await hasDwellColumns(client);
  const withRun = await hasRunColumn(client);
  // ★ v3.6.0 修复（沉默逻辑错误，2026-10-30 实测）：原实现 `ON CONFLICT ... DO NOTHING`，
  //   而「重跑派生 → 重新导入」产生的 8 元组唯一键（run_label, source, route_code, dir, plate,
  //   from_station, to_station, observed_at）**与库内既有行完全相同**（同一批原始帧 ⇒ 同一时刻）
  //   ⇒ 每一行都被判「重复」跳过，`dwell_b_min` 永远是 NULL。
  //   实测证据：单轮 APPLY 读到 3361 / 入库 0 / 跳过 3361，而新产物含 dwellMin 3361 条。
  //   后果不是报错而是**静默无效**：migrate-v3600 的说明写「重跑派生并导入后 dwell 才有值」，
  //   但只改导入不改冲突策略，这条链路永远走不通。
  //   ⇒ 有 dwell 列时改为 DO UPDATE，且**只更新 dwell 两列**（其余列本就相同，不动可避免误伤）；
  //     旧产物没有 dwellMin（EXCLUDED 为 NULL）时用 COALESCE 保住库内已有值，不会被抹掉。
  //   ⚠️ DO UPDATE 下 PostgreSQL 禁止同一条语句命中同一行两次 ⇒ 先按唯一键去重。
  const dedup = new Map<string, SegmentSampleRow>();
  for (const r of rows) {
    const k = [r.run_label, r.source, r.route_code, r.dir, r.plate, r.from_station, r.to_station, r.observed_at.getTime()].join("|");
    dedup.set(k, r); // 保留最后一条（同键同内容，取谁都一样）
  }
  const list = [...dedup.values()];
  if (list.length !== rows.length) {
    console.log(`  ⚠️ 批内同键重复 ${rows.length - list.length} 条（DO UPDATE 不允许一条语句命中同一行两次）→ 已去重`);
  }
  rows = list;
  const baseCols = `run_label, route_code, dir, plate, from_main, to_main, from_station, to_station,
        from_idx, minutes, arrive_kind, source, observed_at, weekday, time_bucket`;
  const baseTypes = `$1::text[], $2::text[], $3::smallint[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::text[], $9::smallint[], $10::numeric[], $11::text[], $12::text[],
                   $13::timestamptz[], $14::smallint[], $15::text[]`;
  // 可选列：按迁移是否已执行逐个追加（列序 / 占位符序 / 参数序**同源构造**，不做手写编号）
  const extraCols: string[] = [];
  const extraTypes: string[] = [];
  const extraArgs: unknown[][] = [];
  let p = 16;
  if (withDwell) {
    extraCols.push("dwell_b_min", "long_stop");
    extraTypes.push(`$${p++}::numeric[]`, `$${p++}::boolean[]`);
    extraArgs.push(
      rows.map((r) => r.dwell_b_min ?? null),
      rows.map((r) => r.long_stop ?? false),
    );
  }
  if (withRun) {
    extraCols.push("run_minutes");
    extraTypes.push(`$${p++}::numeric[]`);
    extraArgs.push(rows.map((r) => r.run_minutes ?? null));
  }
  const cols = extraCols.length ? `${baseCols}, ${extraCols.join(", ")}` : baseCols;
  const types = extraTypes.length ? `${baseTypes}, ${extraTypes.join(", ")}` : baseTypes;
  const args: unknown[] = [
    rows.map((r) => r.run_label),
    rows.map((r) => r.route_code),
    rows.map((r) => r.dir),
    rows.map((r) => r.plate),
    rows.map((r) => r.from_main),
    rows.map((r) => r.to_main),
    rows.map((r) => r.from_station),
    rows.map((r) => r.to_station),
    rows.map((r) => r.from_idx),
    rows.map((r) => r.minutes),
    rows.map((r) => r.arrive_kind),
    rows.map((r) => r.source),
    rows.map((r) => r.observed_at),
    rows.map((r) => r.weekday),
    rows.map((r) => r.time_bucket),
    ...extraArgs,
  ];
  const updateSets = [
    ...(withDwell
      ? [
          "dwell_b_min = COALESCE(EXCLUDED.dwell_b_min, segment_samples.dwell_b_min)",
          "long_stop   = COALESCE(EXCLUDED.long_stop, segment_samples.long_stop)",
        ]
      : []),
    ...(withRun ? ["run_minutes = COALESCE(EXCLUDED.run_minutes, segment_samples.run_minutes)"] : []),
  ];
  const onConflict = updateSets.length ? `DO UPDATE SET ${updateSets.join(", ")}` : `DO NOTHING`;
  const res = await client.query(
    `INSERT INTO segment_samples (${cols})
     SELECT ${cols.replace(/\n\s*/g, " ")}
       FROM UNNEST(${types})
            AS x(${cols.replace(/\n\s*/g, " ")})
     ON CONFLICT (run_label, source, route_code, dir, plate, from_station, to_station, observed_at)
     ${onConflict}
     RETURNING 1`,
    args,
  );
  return res.rowCount ?? 0;
}

/** 滚动窗口清理结果 */
export interface TrimResult {
  /** 本次删除的行数 */
  deleted: number;
  /** 删除后剩余 track 行数 */
  remaining: number;
  /** 删除后剩余 track 轮数 */
  remainingRuns: number;
}

/**
 * 滚动窗口清理（★ 可复用：CLI 与 Vercel Cron 共用）：
 * 只保留最近 `keepRuns` 轮 `source='track'` 的原始样本，删除更老的轮次；
 * `source='timer'`（手动实测）**永不删除** ✗。
 *
 * 幂等（可重复调用）；独立事务；返回 {deleted, remaining, remainingRuns} 供调用方打印。
 * 若 keepRuns<=0 表示不清理（仅回报现状）。
 *
 * @param pool 连接池
 * @param keepRuns 保留的最近轮数（默认 30）
 */
export async function trimSegmentSampleWindow(pool: Pool, keepRuns = 30): Promise<TrimResult> {
  const stat = async () =>
    (
      await pool.query(
        `SELECT count(*)::int AS n, count(DISTINCT run_label)::int AS runs
           FROM segment_samples WHERE source='track'`,
      )
    ).rows[0] as { n: number; runs: number };

  let deleted = 0;
  if (keepRuns > 0) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // 保留集 = 观测时刻最新的 keepRuns 个轮次（按每轮 max(observed_at) 排序）
      const keep = await client.query(
        `SELECT run_label FROM (
            SELECT run_label, max(observed_at) AS m FROM segment_samples
             WHERE source = 'track' GROUP BY run_label
          ) s ORDER BY m DESC LIMIT $1`,
        [keepRuns],
      );
      const labels = keep.rows.map((r: { run_label: string }) => r.run_label);
      if (labels.length) {
        const del = await client.query(
          `DELETE FROM segment_samples WHERE source = 'track' AND run_label <> ALL($1::text[])`,
          [labels],
        );
        deleted = del.rowCount ?? 0;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      client.release();
      throw e;
    }
    client.release();
  }
  const s = await stat();
  return { deleted, remaining: Number(s.n), remainingRuns: Number(s.runs) };
}

/**
 * 把采集/手动原始样本导入 `segment_samples`。
 *
 * @param pool 生产库连接池
 * @param opts 见 ImportOpts（dry 默认 false，调用方应显式控制）
 * @returns 逐轮统计 + 总览
 */
export async function importSegmentSamples(pool: Pool, opts: ImportOpts = {}): Promise<ImportResult> {
  const dry = !!opts.dry;
  const keepRuns = opts.keepRuns ?? 30;
  const withTimer = opts.timer !== false;
  const log = opts.log ?? (() => {});

  // ── ① 收集 track 原始样本（按轮聚合，记录每轮最大观测时刻用于排序）──
  const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR();
  const files = listDerivedFiles(dataDir, opts.fromFile);
  interface RunBucket {
    label: string;
    rows: SegmentSampleRow[];
    maxT: number;
    schemaVersion: number | null;
    runMeta: RunMeta | null;
  }
  let buckets: RunBucket[] = files.map((f) => {
    const { label, rows, maxT, schemaVersion, runMeta } = readTrackFile(f);
    return { label, rows, maxT, schemaVersion, runMeta };
  });
  // ★ v4.1.1 + U-01：轮级质量闸 —— 测试标签轮 / 异常短轮 / 新轮 aborted **直接跳过**
  //   （不静默：明细落盘 + 进返回值）。为什么必须在这里拦：这两类轮各自只有 1 条样本，
  //   进库后会被 route_hop_stats 当成「该跳的唯一样本」→ p50 = 那一秒的值 → ETA 直接错。
  //   ★ U-01（分歧②裁定 (a)）：aborted 判据**仅对 schemaVersion>=2 的新轮**生效，
  //     存量 57 轮维持现状（依据：剔除存量 20260914-093900 会破坏 824.76/49 锚点）。
  //     闸只做内存过滤，**不删、不 UPDATE 库内既有行**，也不触发任何派生表重建。
  const skippedRuns: RunSkip[] = [];
  const passed: RunBucket[] = [];
  const unknownMetaLabels: string[] = [];
  for (const b of buckets) {
    // 仅新轮才回查 meta（存量轮完全不碰 meta，行为零变化）
    const fallbackMeta =
      b.schemaVersion !== null && b.schemaVersion >= RUN_GATE_MIN_SCHEMA
        ? readRunMeta(dataDir, b.label)
        : null;
    const g = gateRun(
      { label: b.label, rows: b.rows.length, schemaVersion: b.schemaVersion, runMeta: b.runMeta },
      fallbackMeta,
    );
    if (g.unknownMeta) unknownMetaLabels.push(b.label);
    if (g.pass) {
      passed.push(b);
      continue;
    }
    skippedRuns.push({ runLabel: b.label, samples: b.rows.length, reason: g.reason });
  }
  const gatedOut = buckets.length - passed.length;
  buckets = passed;
  if (unknownMetaLabels.length) {
    log(
      `⚠️ ${unknownMetaLabels.length} 个新轮读不到 runMeta/meta，按「未知」放行并计数（不 fail-closed）：` +
        ` ${unknownMetaLabels.join(", ")}`,
    );
  }
  if (gatedOut) {
    // 落盘（`.verify/` 是 gitignore 的审计目录）：只有日志会被刷掉，文件不会
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outDir = path.resolve(process.cwd(), ".verify");
    fs.mkdirSync(outDir, { recursive: true });
    const tsv = path.join(outDir, `run-gate-skipped-${stamp}.tsv`);
    fs.writeFileSync(
      tsv,
      ["run_label\tsamples\treason", ...skippedRuns.map((s) => `${s.runLabel}\t${s.samples}\t${s.reason}`)].join("\n") + "\n",
      "utf8",
    );
    log(
      `🚧 轮级质量闸：跳过 ${gatedOut} 轮（label 命中 ${RUN_LABEL_SKIP_RE} / 样本数 < ${MIN_RUN_SAMPLES} / 新轮 aborted）` +
        ` → 明细 ${path.relative(process.cwd(), tsv)}`,
    );
    for (const s of skippedRuns) log(`   · ${s.runLabel}（${s.samples} 条）：${s.reason}`);
  }
  // 只取最近 N 轮（按观测时刻新→旧）
  buckets.sort((a, b) => b.maxT - a.maxT);
  const allRuns = buckets.length;
  if (opts.runs && opts.runs > 0) buckets = buckets.slice(0, opts.runs);

  const trackTotal = buckets.reduce((a, b) => a + b.rows.length, 0);
  log(
    `📂 采集产物：${files.length} 个文件 · 闸后 ${allRuns} 轮（跳过 ${gatedOut}）· ` +
      `本次导入最近 ${buckets.length} 轮 · track 原始样本 ${trackTotal} 条`,
  );

  // ── ② 收集 timer 原始样本 ──
  const timerRows = withTimer ? await collectTimerRows(pool) : [];
  log(`📂 手动实测：timer 原始样本 ${timerRows.length} 条`);

  const runs: RunStat[] = buckets.map((b) => ({
    runLabel: b.label,
    read: b.rows.length,
    inserted: 0,
    skipped: 0,
  }));
  const timerStat: RunStat = { runLabel: "timer", read: timerRows.length, inserted: 0, skipped: 0 };

  let windowDeleted = 0;
  const totals = { read: trackTotal + timerRows.length, inserted: 0, skipped: 0 };

  // ── ③ 写库（dry 时只统计「将插入的读入量」）──
  if (!dry) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        const ins = await insertBatch(client, b.rows);
        runs[i].inserted = ins;
        runs[i].skipped = b.rows.length - ins;
      }
      if (timerRows.length) {
        const ins = await insertBatch(client, timerRows);
        timerStat.inserted = ins;
        timerStat.skipped = timerRows.length - ins;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      client.release();
      throw e;
    }
    client.release();
    // ★ 滚动窗口：入库后**独立事务**清理（与插入解耦，便于 Cron 单独复用同一函数）
    const tr = await trimSegmentSampleWindow(pool, keepRuns);
    windowDeleted = tr.deleted;
  } else {
    // dry：按「库内该轮/该源已存在多少」预估将插入 / 将跳过（唯一约束命中即跳过）
    const ex = await pool.query(
      `SELECT source, run_label, count(*)::int AS n FROM segment_samples GROUP BY source, run_label`,
    );
    const have = new Map<string, number>();
    for (const r of ex.rows as { source: string; run_label: string; n: number }[])
      have.set(`${r.source}|${r.run_label}`, r.n);
    for (const stat of runs) {
      const already = have.get(`track|${stat.runLabel}`) ?? 0;
      stat.skipped = Math.min(stat.read, already);
      stat.inserted = stat.read - stat.skipped;
    }
    const timerAlready = have.get("timer|timer") ?? 0;
    timerStat.skipped = Math.min(timerStat.read, timerAlready);
    timerStat.inserted = timerStat.read - timerStat.skipped;
    // 滚动窗口预估：库内 track 轮数 + 本次新增轮数 − keepRuns
    const trackRuns = (await pool.query(
      `SELECT count(DISTINCT run_label)::int AS n FROM segment_samples WHERE source='track'`,
    )).rows[0]?.n ?? 0;
    const newRuns = buckets.filter((b) => !have.has(`track|${b.label}`)).length;
    windowDeleted = keepRuns > 0 ? Math.max(0, Number(trackRuns) + newRuns - keepRuns) : 0;
  }

  for (const stat of runs) {
    totals.inserted += stat.inserted;
    totals.skipped += stat.skipped;
  }
  totals.inserted += timerStat.inserted;
  totals.skipped += timerStat.skipped;

  // ── ④ 总览（写库后 / dry 均以库现状为准）──
  const totalRow = await pool.query(`SELECT count(*)::int AS n FROM segment_samples`);
  const srcRows = await pool.query(`SELECT source, count(*)::int AS n FROM segment_samples GROUP BY source`);
  const runRows = await pool.query(
    `SELECT run_label, count(*)::int AS n FROM segment_samples
      WHERE source='track' GROUP BY run_label ORDER BY n DESC, run_label LIMIT 5`,
  );
  const bySource: Record<string, number> = {};
  for (const r of srcRows.rows as { source: string; n: number }[]) bySource[r.source] = r.n;

  return {
    dry,
    runs,
    timer: timerStat,
    totals,
    windowDeleted,
    keepRuns,
    skippedRuns,
    db: {
      total: Number(totalRow.rows[0]?.n ?? 0),
      bySource,
      topRuns: (runRows.rows as { run_label: string; n: number }[]).map((r) => [r.run_label, r.n]),
    },
  };
}
