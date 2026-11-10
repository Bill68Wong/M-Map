/**
 * 邻接站对主码级中位时长生成（scripts/build-hop-stats.ts）
 * 用法：npm run db:hop-stats -- cloud --allow-prod
 *
 * 从 segment_samples（全量追踪样本）聚合出 `route_hop_stats`：
 *   主码级（from_main→to_main）× 全周口径的 p50/avg 秒数 —— 进度模型的「md」。
 *   ⚠️ 全周不分时段（实测：进度模型里时段分层反而 +0.012 分——调研报告 §8 负结果）。
 *
 * 幂等：TRUNCATE 后全量重写。
 *
 * ★ v3.6.0：排除「终点站长停站」样本。**判据本体在 `src/lib/rebuild/long-stop.ts`（单一源）**，
 *   本脚本只负责：取策略 → 拼 SQL 谓词 → 聚合 → 打印四个并排数字。
 *   ★ v4.1.1 **双档**：dwell_B ≥ 5 分（排除档）∧ 终点站 ∈ 全澳总站 ∪点盘 ∧ 未被前置门拦下 → 排除；
 *          dwell_B ∈ [3, 5) 只标记（`long_stop=true`），**仍进 p50/avg**。
 *          实测：旧单档 3 分排掉 114 条，其中 136/186 候选落在 3~4 分（总站正常上落客）→ 改后约 15 条。
 *   排除后 md 的语义 = **正常情况下的区间期望（含正常停站），不覆盖司机休息**；
 *   乘客若上到一辆要歇的车，ETA 会低估——数据源限制，不是 bug。
 *   `run_sec`（若列存在）是**诊断列**（纯行驶，扣 dwell），**禁止**用于 ETA。
 *
 * ── `--dry`（v4.1.1）──────────────────────────────────────────────
 *   只算不写：照常打印四个并排数字 + 落盘排除明细，但**不 TRUNCATE、不 INSERT**。
 *   改判据/改阈值时先跑它看数，确认后再正式写。
 *
 * ── 写入 = 单事务（v4.1.2）────────────────────────────────────────
 *   `TRUNCATE` 与 `INSERT` 包在同一个 `BEGIN … COMMIT`（会话模式 5432 的 `pg.Client`）。
 *   旧实现是两条自动提交语句：INSERT 一失败，表就永久空着，而它是线上 ETA 的 `md` 来源。
 *   现在失败 ROLLBACK + 非零退出，表回到重写前的状态。
 *
 * ── 旧口径复现（排长停前的 md，随时可查，本表不另存 legacy 列）──────────────
 *   ⚠️ 必须带 `minutes BETWEEN 0.1 AND 20`（旧窗口）与 `from_main <> to_main`，
 *      漏掉任一条就不是旧口径而是另一个数。
 *   SELECT route_code, from_main, to_main,
 *          percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes*60) AS legacy_p50_sec,
 *          avg(minutes*60)                                        AS legacy_avg_sec,
 *          count(*)::int                                           AS legacy_samples
 *     FROM segment_samples
 *    WHERE source='track' AND from_main <> to_main AND minutes BETWEEN 0.1 AND 20
 *    GROUP BY route_code, from_main, to_main;
 */
import { Client, Pool } from "pg";
import fs from "node:fs";
import path from "node:path";
import {
  LONG_STOP_EXCLUDE_MIN,
  LONG_STOP_MARK_MIN,
  MIN_BUCKET_KINDS,
  MIN_DWELL_SAMPLES,
  PEAK_SHARE_MAX,
  POLICY_NOTE,
  TERMINUS_SQL,
  loadLongStopPolicy,
} from "../src/lib/rebuild/long-stop";
import type { LongStopPolicy } from "../src/lib/rebuild/long-stop";
import { getHolidays, macauDayOf } from "../src/lib/rebuild/holidays";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const target = process.argv[2] as "local" | "cloud" | undefined;
/** ★ v4.1.1：`--dry` = 只算不写（TRUNCATE + 全量重写是破坏性操作，改判据时必须能先看数） */
const dry = process.argv.includes("--dry");
const connStr =
  target === "cloud"
    ? process.env.DATABASE_URL
    : target === "local"
      ? (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL)
      : ((process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL) || process.env.DATABASE_URL);

/** 分母口径（与 --from=both 的 segment_stats 同源同窗） */
const DENOM_WHERE = `source = 'track' AND from_main <> to_main AND minutes BETWEEN 0.1 AND 20`;

/**
 * 会话模式连接串（v4.1.2）。
 *
 * Supabase 的 6543 是 **transaction-mode pooler**：每条事务可能落在不同后端，
 * 会话级设置（`SET …`）与「同一连接」的语义都不保证。写入事务用 5432（会话模式直连）。
 * 本地库（5432 / 无端口）不动。
 */
function sessionConnStr(url: string): string {
  const u = new URL(url);
  if (u.port === "6543") u.port = "5432";
  return u.toString();
}

async function main() {
  if (!connStr) {
    console.error("❌ 未找到连接串");
    process.exit(1);
  }
  console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);
  const pool = new Pool({ connectionString: connStr });
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));
  const q = async <T = Record<string, unknown>>(sql: string, args?: unknown[]) =>
    (await pool.query(sql, args)).rows as T[];

  try {
    // ★ v3.6.0：dwell_b_min 列由 db/migrate-v3600.ts 增加；迁移未执行时降级（不排除，行为同旧版）
    const hasDwell =
      Number(
        (await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_name='segment_samples' AND column_name='dwell_b_min'`,
        ))[0]?.n ?? 0,
      ) > 0;
    if (!hasDwell) {
      console.log("⚠️ segment_samples.dwell_b_min 不存在（迁移未跑）→ 本次**不**排除长停站样本");
    }

    // ── 判据（单一源）：总站集合 + 各道前置门拦下的站对 ──
    // ⚠️ `isHoliday` 必填：必须与 segment-stats 的分桶口径一致（节假日按周末同款），
    //    否则节假日在工作日会被算成高峰，peak-crowded 占比虚高。
    const holidays = await getHolidays(pool);
    const policy: LongStopPolicy = hasDwell
      ? await loadLongStopPolicy(q, (ms) => holidays.has(macauDayOf(ms)))
      : {
          terminus: new Set<string>(),
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
    const terminus = [...policy.terminus];
    const skipPairs = [...policy.skipPairs.keys()];

    // 一致性断言（JS 版总站集合 vs SQL 版，逐元素对拍；两处口径必须一致）
    if (hasDwell) {
      const sqlTerm = new Set((await q<{ m: string }>(TERMINUS_SQL)).map((r) => r.m));
      const onlyJs = terminus.filter((m) => !sqlTerm.has(m));
      const onlySql = [...sqlTerm].filter((m) => !policy.terminus.has(m));
      console.log(
        `🔍 总站集合对拍（JS vs SQL）：JS ${terminus.length} · SQL ${sqlTerm.size} · 仅 JS 有 ${onlyJs.length} · 仅 SQL 有 ${onlySql.length}` +
          (onlyJs.length || onlySql.length ? ` ⚠️ ${[...onlyJs, ...onlySql].slice(0, 8).join(",")}` : " ✅"),
      );
    }

    // 排除谓词（参数化，不拼字符串）
    // ★ v4.1.1 双档：只有 dwell ≥ **排除档 5 分** 才排除；3~4 分是总站正常上落客，只标记（long_stop）。
    const EXCL = `(COALESCE(dwell_b_min, 0) >= ${LONG_STOP_EXCLUDE_MIN}
                    AND to_main = ANY($1::text[])
                    AND NOT ((route_code || '|' || to_main) = ANY($2::text[])))`;
    const denomParams = [terminus, skipPairs];

    const before = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM route_hop_stats`))[0]!;

    // ── 四个并排数字（题面要求）──────────────────────────────────────
    if (hasDwell) {
      const denom = (
        await q<{ denom: number }>(`SELECT count(*)::int AS denom FROM segment_samples WHERE ${DENOM_WHERE}`)
      )[0]!.denom;
      const excl = (
        await q<{
          n: number;
          pairs: number;
          stations: number;
        }>(
          `SELECT count(*)::int AS n,
                  count(DISTINCT route_code || '|' || to_main)::int AS pairs,
                  count(DISTINCT to_main)::int AS stations
             FROM segment_samples
            WHERE ${DENOM_WHERE} AND ${EXCL}`,
          denomParams,
        )
      )[0]!;
      // ★ v4.1.1 双档：标记档（3 ≤ dwell < 5，**仍进** p50/avg，只在 segment_samples.long_stop 上有标记）
      const marked = (
        await q<{ n: number; pairs: number }>(
          `SELECT count(*)::int AS n,
                  count(DISTINCT route_code || '|' || to_main)::int AS pairs
             FROM segment_samples
            WHERE ${DENOM_WHERE}
              AND COALESCE(dwell_b_min, 0) >= ${LONG_STOP_MARK_MIN}
              AND COALESCE(dwell_b_min, 0) <  ${LONG_STOP_EXCLUDE_MIN}
              AND to_main = ANY($1::text[])
              AND NOT ((route_code || '|' || to_main) = ANY($2::text[]))`,
          denomParams,
        )
      )[0]!;
      const st = policy.stats;
      const pct = (x: number) => `${((x / Math.max(denom, 1)) * 100).toFixed(2)}%`;
      console.log(`\n════ 长停站排除 · 四个并排数字 ════`);
      console.log(`  判据：${POLICY_NOTE}`);
      console.log(`  分母口径：${DENOM_WHERE}`);
      console.log(`  分母样本数        ${denom}`);
      console.log(`  ① 排除样本数      ${excl.n}  （占分母 ${pct(excl.n)}）`);
      console.log(`  ② 受影响站对数    ${excl.pairs}  （其中 ${excl.stations} 个不同站点）`);
      console.log(`  ③ insufficient 站数   ${st.insufficientStations}  （被门拦下 ⇒ **不排除**）`);
      console.log(`  ④ insufficient 站对数 ${st.insufficientPairs}  （被门拦下 ⇒ **不排除**）`);
      console.log(
        `  ⑤ 只标记不排除    ${marked.n} 条 / ${marked.pairs} 站对` +
          `（${LONG_STOP_MARK_MIN} ≤ dwell < ${LONG_STOP_EXCLUDE_MIN} 分，总站正常上落客 ⇒ **仍进 p50/avg**，仅 long_stop=true）`,
      );
      console.log(
        `  附：peak-crowded 门拦下 ${st.peakCrowdedPairs} 个站对 / ${st.peakCrowdedStations} 个站点（高峰聚集=排队 ⇒ 不排除）`,
      );
      console.log(
        `  附：headway-sync 门拦下 ${st.headwaySyncPairs} 个站对 / ${st.headwaySyncStations} 个站点（计划性待发 ⇒ 不排除）` +
          (st.headwaySyncPairs === 0 ? " ← 本门本次 0 命中（不影响结果）" : ""),
      );
      // ── 对账断言：候选 = 非总站 + 各门 + 排除（**必须用独立计数的 midStopPairs**）──
      //
      // ⚠️ 这里绝不能用「减法推导」的 midStopPairs。若 `midStopPairs := candidatePairs − 其余各项`，
      //    那么 `各项之和` 恒等于 `candidatePairs`，断言退化为**永真式**——将来加第五道门
      //    却忘了同步计数时，减法会自动把它吸收进 midStopPairs，账平、不报错、数字静默变小。
      //    （2026-10-30 实测验证过：把推导值代回恒等式，无论漏计多少都成立。）
      //    ⇒ `long-stop.ts` 在非总站分支**真数** `midStopPairs`，本断言才有意义。
      const accounted =
        st.midStopPairs +
        st.insufficientPairs +
        st.headwaySyncPairs +
        st.peakCrowdedPairs +
        st.excludedPairs +
        // ★ v4.1.1：仅标记档（3≤dwell<5）的站对也是「过了门但不排除」的一类，必须计入分区，
        //   否则加了双档后断言会永远差一个「只标记」的数目。
        st.markedPairs;
      if (accounted !== st.candidatePairs) {
        console.error(
          `❌ 站对账不平：候选 ${st.candidatePairs} ≠ 已计 ${accounted}（差 ${st.candidatePairs - accounted}）`,
        );
        console.error(
          "   多半是新增了一道门但没同步计数 / 没写进 midStopPairs——请同时检查 long-stop.ts 与 LongStopPolicyStats",
        );
        process.exitCode = 1;
      }
      console.log(
        `  附：候选长停样本 ${st.candidates} · 候选站对 ${st.candidatePairs} · 非总站不排 ${st.midStopPairs} 个站对（${st.midStopStations} 站，独立计数）`,
      );
      console.log(
        `  附：对账 候选 ${st.candidatePairs} = 非总站 ${st.midStopPairs} + insufficient ${st.insufficientPairs}` +
          ` + headway-sync ${st.headwaySyncPairs} + peak-crowded ${st.peakCrowdedPairs} + 排除 ${st.excludedPairs}` +
          ` + 仅标记 ${st.markedPairs}` +
          ` ⇒ ${accounted} ${accounted === st.candidatePairs ? "✅ 平" : "❌ 不平"}`,
      );
      console.log(
        `  附：门槛 MIN_DWELL_SAMPLES=${MIN_DWELL_SAMPLES} / MIN_BUCKET_KINDS=${MIN_BUCKET_KINDS} / PEAK_SHARE_MAX=${PEAK_SHARE_MAX}` +
          `（经验阈值、非文献值；改它等于改排除面，须重跑 P7 对照）`,
      );

      // ── 被排除样本的**明细落盘**（v4.1.1）─────────────────────────────
      // 为什么必须落盘：旧版只打印「长停站排除 114 条」一个汇总数字，**没有任何 route / 站对 /
      // 时刻信息** ⇒ 无法审计「这 114 条到底该不该排」。阈值从 3 改到 5 之后更必须能逐条核对。
      // 目录 `.verify/`（gitignore）——这是审计证据，不参与运行时。
      const detail = await q<{
        route_code: string;
        from_main: string;
        to_main: string;
        dwell: number;
        observed_at: string;
        plate: string | null;
      }>(
        `SELECT route_code, from_main, to_main, dwell_b_min::float8 AS dwell, observed_at, plate
           FROM segment_samples
          WHERE ${DENOM_WHERE} AND ${EXCL}
          ORDER BY dwell_b_min DESC, route_code, to_main`,
        denomParams,
      );
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const outDir = path.resolve(process.cwd(), ".verify");
      fs.mkdirSync(outDir, { recursive: true });
      const tsv = path.join(outDir, `long-stop-excluded-${stamp}.tsv`);
      const head = ["route_code", "from_main", "to_main", "dwell_b_min", "observed_at", "plate", "reason"];
      const lines = [head.join("\t")];
      for (const r of detail)
        lines.push(
          [
            r.route_code,
            r.from_main,
            r.to_main,
            Number(r.dwell).toFixed(2),
            new Date(r.observed_at).toISOString(),
            r.plate ?? "",
            `dwell>=${LONG_STOP_EXCLUDE_MIN}分 ∧ 终点∈全澳总站 ∧ 未命中前置门 ⇒ 排除出 p50/avg`,
          ].join("\t"),
        );
      fs.writeFileSync(tsv, lines.join("\n") + "\n", "utf8");
      console.log(`  📄 排除明细已落盘：${path.relative(process.cwd(), tsv)}（${detail.length} 行）`);
    }

    // ── 写入 ──
    const hasRunSec =
      Number(
        (await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_name='route_hop_stats' AND column_name='run_sec'`,
        ))[0]?.n ?? 0,
      ) > 0;
    if (!hasRunSec) console.log("⚠️ route_hop_stats.run_sec 不存在（迁移未跑）→ 不写诊断列");

    const runSecSel =
      hasRunSec && hasDwell
        ? `,\n             avg(GREATEST(minutes - COALESCE(dwell_b_min, 0), 0) * 60) AS run_sec`
        : hasRunSec
          ? `,\n             NULL::double precision AS run_sec`
          : "";
    const cols = `route_code, from_main, to_main, p50_sec, avg_sec, samples${hasRunSec ? ", run_sec" : ""}`;
    if (dry) {
      // ★ v4.1.1：`--dry` = 只算不写。TRUNCATE + 全量重写是破坏性的，验证改动时必须能先看数。
      const willWrite = (
        await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM (
             SELECT 1 FROM segment_samples
              WHERE ${DENOM_WHERE} ${hasDwell ? `AND NOT ${EXCL}` : ""}
              GROUP BY route_code, from_main, to_main) t`,
          hasDwell ? denomParams : [],
        )
      )[0]!.n;
      console.log(`\n[--dry] 跳过写入：将得到 ${willWrite} 行（当前 ${before.n} 行）——未 TRUNCATE、未写库`);
    } else {
      // ── 全量重写：TRUNCATE + INSERT **必须同一个事务**（v4.1.2）───────────────
      // 旧实现是 `await pool.query(TRUNCATE)` 之后再 `await pool.query(INSERT)`，两条自动提交语句：
      // 一旦 INSERT 失败（锁超时 / 连接断 / 磁盘满），表就**永久停在空表**状态 ——
      // 而 route_hop_stats 是线上 ETA 的 md 来源，空表等于全站「剩余时间」一起消失。
      // ⇒ 现在包在 BEGIN … COMMIT 里：失败 ROLLBACK，表回到重写前的样子。
      //
      // ⚠️ 必须用**会话模式**（5432）的 `pg.Client`，不能复用上面的 Pool：
      //    Supabase 的 6543 是 **transaction-mode pooler**，会话级特性（如
      //    `SET default_transaction_read_only`）与连接的绑定关系由连接池决定；
      //    重建这种「一锤子」操作走直连，语义最简单、也便于排查。
      const t0 = Date.now();
      const client = new Client({ connectionString: sessionConnStr(connStr!) });
      await client.connect();
      try {
        await client.query("SET default_transaction_read_only = off");
        await client.query("BEGIN");
        const pre = (
          await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM route_hop_stats`)
        ).rows[0]!.n;
        console.log(`\n── 重建 route_hop_stats（单事务，会话模式）──`);
        console.log(`  ① TRUNCATE 前      ${pre} 行`);
        await client.query(`TRUNCATE route_hop_stats`);
        const res = await client.query(
          `INSERT INTO route_hop_stats (${cols})
       SELECT route_code, from_main, to_main,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes * 60) AS p50_sec,
              avg(minutes * 60) AS avg_sec,
              count(*)::int AS samples${runSecSel}
         FROM segment_samples
        WHERE ${DENOM_WHERE}
          ${hasDwell ? `AND NOT ${EXCL}` : ""}
        GROUP BY route_code, from_main, to_main
       ON CONFLICT (route_code, from_main, to_main) DO UPDATE
         SET p50_sec = EXCLUDED.p50_sec, avg_sec = EXCLUDED.avg_sec,
             samples = EXCLUDED.samples, updated_at = now()${hasRunSec ? ",\n             run_sec = EXCLUDED.run_sec" : ""}`,
          hasDwell ? denomParams : [],
        );
        const inTx = (
          await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM route_hop_stats`)
        ).rows[0]!.n;
        console.log(`  ② INSERT 后（事务内）${res.rowCount} 行写入 · 表内 ${inTx} 行`);
        await client.query("COMMIT");
        const post = (
          await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM route_hop_stats`)
        ).rows[0]!.n;
        console.log(`  ③ COMMIT 后       ${post} 行 · 耗时 ${Date.now() - t0} ms`);
      } catch (e) {
        // ROLLBACK 失败也不能吞掉原始错误（吞了会让人以为表已恢复）
        try {
          await client.query("ROLLBACK");
          console.log("  ↩ 已 ROLLBACK，route_hop_stats 保持重写前的状态");
        } catch (re) {
          console.error("  ❌ ROLLBACK 失败，请立刻用 backups/ 的备份恢复：", (re as Error).message);
        }
        throw e;
      } finally {
        await client.end();
      }
    }
    if (hasDwell)
      console.log("   md 语义：正常情况下的区间期望（含正常停站），**不覆盖司机休息**——乘客若上到要歇的车，ETA 会低估");
    const stat = (
      await q<{ n: number; routes: number; total: number }>(
        `SELECT count(*)::int AS n, count(DISTINCT route_code)::int AS routes, sum(samples)::int AS total FROM route_hop_stats`,
      )
    )[0]!;
    console.log(`  行 ${stat.n} · 线路 ${stat.routes} · 样本合计 ${stat.total}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
