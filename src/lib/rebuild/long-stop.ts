/**
 * 长停站（dwell）排除策略 —— **单一源**（src/lib/rebuild/long-stop.ts，v3.6.0）
 *
 * 为什么单独成文件：`segment-stats.ts`（重算 segment_stats）与 `scripts/build-hop-stats.ts`
 * （重算 route_hop_stats）都要判「哪些样本含司机休息」。两处各写一套判据 → 一旦分叉**不会报错**，
 * 只会让两张派生表对「什么是长停站」理解不同，最终表现成「进度模型排了、推荐卡没排」这类极难查的错。
 * ⇒ 判据、阈值、SQL 片段全部放这里，两处 import。
 *
 * ── 判据（按优先级；前三道是**前置门**：命中即 skip ⇒ 不排除）────────────────
 *   ① 候选：dwell_B ≥ LONG_STOP_MARK_MIN（默认 3 分）—— dwell_B 来自 track-derive 直测
 *      （到站首帧 → 离站首帧）。离开口径 minutes = run(A→B) + dwell_B，故长 dwell 会让段时长虚高。
 *      ★ v4.1.1：3 分是**标记档**（`long_stop=true`，只说明「含停站」）；**排除档**是 5 分（见下 ⑤）。
 *   ② **站点是总站**：任一线路某方向的 seq=1 或 seq=max（全澳并集，不是「本线端点」）
 *      ⚠️ 为什么用并集而非 (route, 站) 对级：C654 聯生圓形地是 59 路总站、却是 25/26/26A/50/21A 的**中途站**，
 *         而这正是要修的样例（26 路在此休息）。实测：status=1 且 ≥3 分的 11,182 段里，
 *         「别线总站/本线中途」233 段（2.1%），Top 组为 25|C654 48、51|M9 48、26|C654 25、17|M1 13、
 *         3A|M1 8 —— **全是真实总站待发**。若改成对级，会把这 233 段（含目标 bug）全部漏掉。
 *   ③ 门 `headway-sync`：长停中位数 / **该时段**班距 ∈ [0.7, 1.3] → 计划性待发（调度让车等着对齐发车时刻）
 *      → **不排除**（宁可多算等待，不可少算）。班距取 `route_frequency` 该时段的最大 `freq_hi`；
 *      时段划分见 ④。
 *   ④ 门 `insufficient`：**每个参与比较的分桶各自 n ≥ MIN_DWELL_SAMPLES（5）**，且至少覆盖
 *      MIN_BUCKET_KINDS（2）个分桶 —— 否则样本不足以判断「是不是计划性待发」→ **不排除**。
 *      ⚠️ 分母是**每个分桶各自**，不是全站合计：合计 40 条但全在高峰，同样判不出非高峰基线。
 *   ⑤ 通过 ①~④ 的样本再按 **dwell 分档**（v4.1.1 双档）：
 *      · dwell ≥ `LONG_STOP_EXCLUDE_MIN`（5 分）→ 「司机休息 / 长时间待发」→ **排除**
 *      · dwell ∈ [3, 5) → 总站正常上落客 → **只标记，仍进聚合**
 *      （单档 3 分一刀切的实测代价：186 条候选里 136 条落在 3~4 分被误排 —— 见 `LONG_STOP_MARK_MIN` 注释）
 *
 * ── 「时段」口径（必须用这一套，**禁止手写小时区间**）──────────────────────
 *   用 `./buckets.ts` 的现行分桶 `bucketOfRoute`：
 *     高峰 peak   = `am_work`（工作日 07:00-09:00）∪ `pm`（16:00-20:00，**含周末**）
 *     非高峰      = `day`（09-16）∪ `night`（20-07）∪ `am_weekend`（周末 07-09）
 *   旧的 `am_peak` / `pm_peak`（`bucketOf`）仅兼容保留，**不得用于本判据**。
 *   实现方式：`KIND_HOURS` 由**枚举 0~23 时反查 `bucketOfRoute`** 得出，而不是在此写死 7/9/16/20 ——
 *   分桶口径一旦调整（比如 pm 改成 16-21），本判据自动跟随，不会静默漂移。
 *   行为学依据（降阈值前先复验）：司机休息与时段无关（C654 散布 09:47~23:16，含深夜）；
 *   排队与高峰强相关（M233 東北大馬路/東華 集中在 07:59~08:12 / 14:13 / 16:03，90 辆不同车）。
 *
 * ── 阈值性质（诚实标注）──────────────────────────────────────────────
 *   MIN_DWELL_SAMPLES=5 / MIN_BUCKET_KINDS=2 / PEAK_SHARE_MAX=0.8 是**经验阈值、非文献值**；
 *   改它等于改排除面（改的是「哪些站被排除」而不是「怎么算中位数」），须重跑 P7 对照再上线。
 *
 * ── 文件拆分（v3.6.0）──────────────────────────────────────────────
 *   本文件只管「该不该排除」的编排（阈值 + 门）。
 *   · 总站集合（站序 SQL / 归一 / terminusMains）→ `./terminus.ts`
 *   · 峰/非峰归类（kindOfBucket / KIND_HOURS）→ `./buckets.ts`（与五桶同源同改）
 *   两者均在此 re-export，既有 `from "./long-stop"` 的导入无需改动。
 */
import { KIND_HOURS, kindOfBucket, macauParts } from "./buckets";
import type { BucketKind } from "./buckets";
// 峰/非峰归类住在 `./buckets.ts`（与五桶同源同改）；总站集合住在 `./terminus.ts`。
// 两者均 re-export，保持既有导入路径不变。
export { KIND_HOURS, kindOfBucket } from "./buckets";
export type { BucketKind } from "./buckets";
// 总站集合层（站序 SQL / 归一 / terminusMains）拆到 `./terminus.ts`（单一职责 + 300 行门禁）。
// 此处 re-export 保持既有消费方（build-hop-stats / check-terminus-parity）的导入路径不变。
import { ROUTE_SEQ_SQL, mainOf, terminusMains } from "./terminus";
import type { RouteStopSeqRow } from "./terminus";
import type { LongStopPolicyStats, SkipReason } from "./long-stop-types";
export { ROUTE_SEQ_SQL, TERMINUS_SQL, mainOf, terminusMains } from "./terminus";
export type { RouteStopSeqRow } from "./terminus";

/**
 * ── 双档阈值（v4.1.1）────────────────────────────────────────────────
 *   ① **标记档** `LONG_STOP_MARK_MIN = 3`：dwell_B ≥ 3 分 → 该样本 `long_stop = true`，
 *      **只标记、不排除**出 p50/avg。语义 =「这一跳的时长里含停站，不是纯行驶」。
 *   ② **排除档** `LONG_STOP_EXCLUDE_MIN = 5`：dwell_B ≥ 5 分才**排除**出聚合。
 *
 * 为什么必须双档（实测 57 轮 / 202,790 条样本）：
 *   186 条终点站长停候选里 **136 条（73%）落在 3~4 分钟** —— 那是**总站上落客**（正常运营），
 *   只有 15 条（8%）≥5 分才像「司机休息 / 长时间待发」。单档 3 分一刀切把 114 条排除掉，
 *   等于把总站正常的上下客时间从 p50 里抹掉 → ETA 系统性偏短。⇒ 3 分标记、5 分排除。
 *   ⚠️ 红线：`EXCLUDE_MIN` **不得 ≤ 3**（那等于不排除）；两个阈值都不许为了「数字好看」下调。
 */
export const LONG_STOP_MARK_MIN = 3;
/** 真正排除出聚合的门槛（分钟）。改动 = 改排除面，须重跑 P7 对照。 */
export const LONG_STOP_EXCLUDE_MIN = 5;
/** @deprecated 旧名（单档时代）。**= 标记档 3 分，只可用于「标记」，绝不可用于排除判据**。
 *  排除请用 `LONG_STOP_EXCLUDE_MIN`。保留此别名只为不破坏既有 import。 */
export const LONG_STOP_MIN = LONG_STOP_MARK_MIN;
/** 「计划性待发」豁免区间：长停中位数 / 班距 */
export const LAYOVER_RATIO_LO = 0.7;
export const LAYOVER_RATIO_HI = 1.3;
/** ★ 经验阈值、非文献值；改它等于改排除面，须重跑 P7 对照 */
export const MIN_DWELL_SAMPLES = 5;
/** ★ 经验阈值、非文献值；参与比较的分桶至少覆盖几个 */
export const MIN_BUCKET_KINDS = 2;
/**
 * 门 `peak-crowded`：长停样本在高峰时段的占比 ≥ 此值 ⇒ 判为「排队/拥堵」而非「司机休息」⇒ **不排除**。
 *
 * 方向别写反：**高峰占比高是「不排」的理由**。司机休息与时段无关（实测 C654 散布 09:47~23:16，含深夜），
 * 才会摊到非高峰；而排队跟着早/晚高峰走（实测 M233 東北大馬路/東華 集中在 07:59~08:12 / 14:13 / 16:03）。
 * 若写成「≥0.8 ⇒ 排除」，会把真实排队全删掉 → ETA 变短 → 用户到站车已走。
 *
 * ★ 经验阈值、非文献值；改动等于改排除面。
 */
export const PEAK_SHARE_MAX = 0.8;


// 契约类型在 `./long-stop-types.ts`（改那里等于改对外契约）；此处 re-export 保持导入路径不变
export type { LongStopPolicyStats, SkipReason } from "./long-stop-types";

export interface LongStopPolicy {
  /** 总站主码集合（判据 ②） */
  terminus: Set<string>;
  /** 被前置门拦下的站对：`route|to_main` → 原因 */
  skipPairs: Map<string, SkipReason>;
  stats: LongStopPolicyStats;
}

type Q = (sql: string, args?: unknown[]) => Promise<Record<string, unknown>[]>;

const median = (v: number[]) => {
  if (!v.length) return NaN;
  const a = [...v].sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
};

/**
 * 读取长停站排除策略（总站集合 + 前置门拦下的站对），供两处聚合共用。
 * 表/列不存在时降级为空策略（不排除），不阻塞重算。
 *
 * @param isHoliday 观测时刻 → 是否澳门公众假期。**必填、无默认值**。
 *   ⚠️ 为什么必填而不是 `= () => false`：漏传会让节假日在工作日被算成 `am_work`（高峰），
 *      而 `segment-stats.ts` 的分桶（`bucketOfRoute(..., holidays.has(...))`）把它算成
 *      `am_weekend`（非高峰）⇒ **同一个样本在两处落在不同桶**，`peak-crowded` 的占比虚高。
 *      实测影响：6 条节假日样本 / 4 个总站站对 / 0 个判定翻转（当前无影响），
 *      但「口径不一致」本身就是下一次改动会踩的坑。
 *      设成必填后，TS 会在编译期强制每个调用方显式表态，不会再有静默漂移。
 */
export async function loadLongStopPolicy(
  q: Q,
  isHoliday: (ms: number) => boolean,
): Promise<LongStopPolicy> {
  const empty: LongStopPolicy = {
    terminus: new Set(),
    skipPairs: new Map(),
    stats: {
      candidates: 0,
      candidatePairs: 0,
      candidateStations: 0,
      excludedSamples: 0,
      excludedPairs: 0,
      midStopPairs: 0,
      midStopStations: 0,
      headwaySyncPairs: 0,
      headwaySyncStations: 0,
      insufficientPairs: 0,
      insufficientStations: 0,
      peakCrowdedPairs: 0,
      peakCrowdedStations: 0,
      skippedSamples: 0,
      markedSamples: 0,
      markedPairs: 0,
    },
  };
  try {
    const seqRows = (await q(ROUTE_SEQ_SQL)) as unknown as RouteStopSeqRow[];
    const terminus = terminusMains(seqRows);

    // 候选长停样本（含观测时刻 —— 时段必须从真实时刻判，不信样本携带的 time_bucket）
    // ★ v4.1.1：候选集用**标记档**（≥3 分）→ 才能同时数出「只标记」与「真排除」两档；
    //   排除与否在下面的判据里按 `LONG_STOP_EXCLUDE_MIN` 分流，**不再由 SQL 一刀切**。
    const rows = (await q(
      `SELECT route_code, to_main, dwell_b_min::float8 AS dwell, observed_at
         FROM segment_samples
        WHERE source = 'track' AND COALESCE(dwell_b_min, 0) >= $1`,
      [LONG_STOP_MARK_MIN],
    )) as unknown as { route_code: string; to_main: string; dwell: number; observed_at: string }[];
    if (!rows.length) return { ...empty, terminus };

    // 班距（route_frequency，排除 special 专线表）：每线 × 每分桶类别 → 该类别覆盖时段内的最大 freq_hi
    const freq = (await q(
      `SELECT route_code, from_min::int AS from_min, to_min::int AS to_min, freq_hi::int AS freq_hi
         FROM route_frequency WHERE day_type <> 'special'`,
    )) as unknown as { route_code: string; from_min: number; to_min: number; freq_hi: number }[];
    const headway = new Map<string, { peak?: number; nonpeak?: number }>();
    for (const f of freq) {
      const cur = headway.get(f.route_code) ?? {};
      for (const kind of ["peak", "nonpeak"] as BucketKind[]) {
        const hit = [...KIND_HOURS[kind]].some((h) => f.from_min < (h + 1) * 60 && f.to_min > h * 60);
        if (hit) cur[kind] = Math.max(cur[kind] ?? 0, f.freq_hi);
      }
      headway.set(f.route_code, cur);
    }

    // 按 (route, to_main) × 分桶类别 聚合。
    // ⚠️ **时段一律从 `observed_at` 现算，禁止读 `segment_samples.time_bucket` 列**。
    //    该列是**新旧桶混装**：老行由旧代码写入（`am_peak` 7-10 / `pm_peak` 17-20 / day / night），
    //    新行由新代码写入（五桶 `am_work`/`am_weekend`/`day`/`pm`/`night`）。
    //    2026-10-30 实测该列分布：day 70181 · night 56616 · pm 20156 · am_peak 19439 · pm_peak 16694，
    //    而 `am_work`/`am_weekend` **一条都没有** ⇒ 直接读列会把 7-9 点的高峰样本
    //    全算成非高峰，`peak-crowded` 门的占比会系统性偏低（等于门失效）。
    //    `macauParts(observed_at)` 才是唯一正确入口（它内部做 GMT+8 偏移）。
    const byPair = new Map<string, Map<BucketKind, { dwells: number[]; hitsTerminus: boolean }>>();
    for (const r of rows) {
      const t = new Date(r.observed_at);
      const mp = macauParts(t);
      // ★ 与 `segment-stats.ts` 的分桶口径**逐字一致**：节假日按「周末同款」处理
      const kind = kindOfBucket(mp.weekday, mp.hour, isHoliday(t.getTime()));
      const key = `${r.route_code}|${r.to_main}`;
      if (!byPair.has(key)) byPair.set(key, new Map());
      const m = byPair.get(key)!;
      if (!m.has(kind)) m.set(kind, { dwells: [], hitsTerminus: terminus.has(mainOf(r.to_main)) });
      const cell = m.get(kind)!;
      cell.dwells.push(Number(r.dwell));
      cell.hitsTerminus = terminus.has(mainOf(r.to_main));
    }

    const skipPairs = new Map<string, SkipReason>();
    let excludedSamples = 0;
    let skippedSamples = 0;
    let excludedPairs = 0;
    /** ★ v4.1.1：dwell ∈ [MARK_MIN, EXCLUDE_MIN) 且过门 → 只标记、仍进聚合 */
    let markedSamples = 0;
    let markedPairs = 0;
    const seq = { hw: 0, ins: 0, pk: 0 };
    const st = { hw: new Set<string>(), ins: new Set<string>(), pk: new Set<string>() };
    // ★ 非总站**独立计数**（不做减法推导）：供 build-hop-stats 做对账断言。
    //   用减法推导的话，「加了门却忘同步」会被减法自动吸收 ⇒ 账永远平、查不出问题。
    let midStopPairs = 0;
    const midStopStations = new Set<string>();

    for (const [key, m] of byPair) {
      const route = key.slice(0, key.indexOf("|"));
      const toMain = key.slice(key.indexOf("|") + 1);
      const cells = [...m.entries()];
      const total = cells.reduce((a, [, c]) => a + c.dwells.length, 0);
      // 判据 ②：非总站 → 不进排除面（真实排队/中途大站，排了会低估 ETA）
      if (!terminus.has(mainOf(toMain))) {
        midStopPairs++;
        midStopStations.add(mainOf(toMain));
        continue;
      }

      // 门 ③ headway-sync：任一参与分桶的「长停中位数 / 该时段班距」落在 [0.7, 1.3] → 计划性待发
      const hw = headway.get(route);
      let sync = false;
      let hwMissing = false;
      for (const [kind, c] of cells.filter(([, c]) => c.dwells.length > 0)) {
        const band = (hw?.[kind] ?? 0) > 0 ? hw![kind]! : 0;
        if (!band) {
          hwMissing = true;
          continue;
        }
        const ratio = median(c.dwells) / band;
        if (ratio >= LAYOVER_RATIO_LO && ratio <= LAYOVER_RATIO_HI) sync = true;
      }
      // 班距缺失 = 无法排除「计划性待发」这一解释 → 同样不排除（宁可多算等待）
      if (sync || hwMissing) {
        skipPairs.set(key, "headway-sync");
        seq.hw++;
        st.hw.add(mainOf(toMain));
        skippedSamples += total;
        continue;
      }

      // 门 ④ insufficient：**每个参与比较的分桶各自** n ≥ 5，且覆盖 ≥ 2 个分桶。
      //   分母是逐格、不是全站合计：合计 40 条但全在高峰时，
      //   「高峰 vs 非高峰」的比较没有分母，算出来的占比是噪声。
      const participating = cells.filter(([, c]) => c.dwells.length > 0);
      const minN = participating.length ? Math.min(...participating.map(([, c]) => c.dwells.length)) : 0;
      if (participating.length < MIN_BUCKET_KINDS || minN < MIN_DWELL_SAMPLES) {
        skipPairs.set(key, "insufficient");
        seq.ins++;
        st.ins.add(mainOf(toMain));
        skippedSamples += total;
        continue;
      }

      // 门 ⑤ peak-crowded：长停集中在高峰 ⇒ 排队/拥堵 ⇒ **不排除**。
      //   ⚠️ 方向：≥0.8 是「不排」的理由，不是「排」的理由（见 PEAK_SHARE_MAX 注释）。
      const peakN = participating.find(([kind]) => kind === "peak")?.[1].dwells.length ?? 0;
      const peakShare = total ? peakN / total : 0;
      if (peakShare >= PEAK_SHARE_MAX) {
        skipPairs.set(key, "peak-crowded");
        seq.pk++;
        st.pk.add(mainOf(toMain));
        skippedSamples += total;
        continue;
      }

      // ★ v4.1.1：双档分流 —— 过门的站对里，只有 dwell ≥ EXCLUDE_MIN 的样本被排除；
      //   [MARK_MIN, EXCLUDE_MIN) 的样本**只标记不排除**（总站正常上落客，排掉会让 ETA 偏短）。
      //   按**样本**拆，不按站对拆：同一站对可能既有 3.5 分（上落客）也有 6 分（司机休息）。
      let exclN = 0;
      let markN = 0;
      for (const [, c] of cells) {
        for (const d of c.dwells) {
          if (d >= LONG_STOP_EXCLUDE_MIN) exclN++;
          else markN++;
        }
      }
      if (exclN) {
        excludedSamples += exclN;
        excludedPairs++;
      }
      if (markN) {
        markedSamples += markN;
        // ⚠️ 只统计「**没有**排除档样本」的站对 —— 这样站对的分区才是互斥的：
        //    候选 = 非总站 + 各门 + 排除 + 仅标记（`build-hop-stats` 的对账断言依赖它）。
        //    既有 3.5 分又有 6 分的站对算「排除」，它的 3.5 分样本只体现在 markedSamples 里。
        if (!exclN) markedPairs++;
      }
    }

    const pairs = new Set(rows.map((r) => `${r.route_code}|${r.to_main}`));
    return {
      terminus,
      skipPairs,
      stats: {
        candidates: rows.length,
        candidatePairs: pairs.size,
        candidateStations: new Set(rows.map((r) => mainOf(r.to_main))).size,
        excludedSamples,
        excludedPairs,
        midStopPairs,
        midStopStations: midStopStations.size,
        headwaySyncPairs: seq.hw,
        headwaySyncStations: st.hw.size,
        insufficientPairs: seq.ins,
        insufficientStations: st.ins.size,
        peakCrowdedPairs: seq.pk,
        peakCrowdedStations: st.pk.size,
        skippedSamples,
        markedSamples,
        markedPairs,
      },
    };
  } catch {
    return empty;
  }
}

/** 长停样本是否应被排除（唯一判据入口，两处聚合都必须调它）
 *  ★ v4.1.1：门槛用**排除档** 5 分。3~4 分是总站正常上落客 —— 只由 `long_stop` 标记（入库端写），
 *  不在这里排除。 */
export function shouldExcludeLongStop(
  route: string,
  toMain: string,
  dwell: number | null,
  policy: Pick<LongStopPolicy, "terminus" | "skipPairs">,
): boolean {
  if (dwell === null || !(dwell >= LONG_STOP_EXCLUDE_MIN)) return false;
  if (!policy.terminus.has(mainOf(toMain))) return false;
  if (policy.skipPairs.has(`${route}|${toMain}`)) return false;
  return true;
}

/** 供脚本打印（保持两处日志一致） */
export const POLICY_NOTE =
  `dwell≥${LONG_STOP_EXCLUDE_MIN}分**排除** / ≥${LONG_STOP_MARK_MIN}分仅标记 ∧ 终点站∈全澳总站 ∪点盘` +
  ` ∧ 非计划性待发(中位/该时段班距∉[${LAYOVER_RATIO_LO},${LAYOVER_RATIO_HI}])` +
  ` ∧ 分桶充分(每桶n≥${MIN_DWELL_SAMPLES}且≥${MIN_BUCKET_KINDS}桶) ∧ 非高峰聚集(高峰占比<${PEAK_SHARE_MAX})`;
