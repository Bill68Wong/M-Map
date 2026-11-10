/**
 * 基准读数锁（scripts/test-benchmark-readings.ts · S-09 · 批 3 建 / 批 4 T6 重写数值层）
 * 用法：npm run test:benchmark-readings    （连库**只读**；5432 会话模式单连接）
 *
 * ── 守的是什么 ────────────────────────────────────────────────────────
 *   59 路 `T317 → M9`（跨海）是「末跳纯行驶」裁定的**标杆跳**：它是全库「到达末站 − 离开
 *   倒数第二站」口径下最长的真实行驶段。本脚本把它的**实跑读数**写死成断言，任何重建/迁移
 *   把口径改坏，这里第一时间红 —— 而不用等线上 ETA 明显错才反查。
 *
 * ── 批 4 / T6：为什么改成「锁原始样本 + 固定时间窗」────────────────────
 *   `route_hop_stats` / `segment_stats` **只有 `updated_at`（重建时刻）**，没有数据侧时间列
 *   ⇒ 「固定时间窗」只能锁在 `segment_samples.observed_at` 上。
 *   也正因为如此，本脚本**不再直接锁派生表的产出数值**：派生表随采集增长必然漂移，
 *   精确锁等于「每天红一次」。改为：
 *     · 数值层 = 原始窗口（`observed_at < CUTOFF`，写死，**绝不用 now()**）+ 精确锁；
 *     · 派生表只锁**关系/结构**：派生 ≡ 原始窗口（同口径）、samples 只增（下限）、两表不可混用。
 *
 * ── 目标值全部来自实跑（2026-11-09T09:05Z 基线，禁推算）──────────────
 *   原始窗口 n=49 / p50_sec=824.76 / avg_sec=855.564489795918（实跑原串 855.5644897959183660，
 *   末位 3673 是转述误差；断言用 ±0.01 容差，两者等价），
 *   窗口内 max(observed_at)=2026-11-07T02:59:32.919Z（信息打印，不作断言：随采集前进）。
 *   原始 day 桶（澳门 hour ∈ [9,16)）n=16 / p50_min=14.27。
 *
 * ── 容差 0.05 的来由（**唯一允许的写法方向：正向**）──────────────────
 *   `segment_stats.p50_minutes` 是 `numeric(5,1)`，只存 1 位小数：
 *   824.76 / 60 = 13.746 ⇒ 落库被截成 **13.7** ⇒ |Δ| = **0.046**，余量只剩 0.004。
 *   ⚠️ 文件头原来那句「禁止 `!near(p50_sec/60, all_p50, 0.05)`」说的是**取反形式恒红**
 *      （actual 恒等于真值，取反后必然成立 ⇒ 断言必红），**不是**禁止正向比较。两者别搞混。
 *
 * ⚠️ DB 不可达必须 **fail-closed**（exit 1），不得静默跳过当绿。
 * ⚠️ 本脚本**只读**：所有 SQL 必须 SELECT（下面 `q()` 有硬守卫）。
 */
import { Client } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 可选；无连接串会在下面 fail-closed */
}

const ROUTE = "59";
const FROM = "T317";
const TO = "M9";
const RH_WHERE = `route_code='${ROUTE}' AND from_main='${FROM}' AND to_main='${TO}'`;
const SS_WHERE = `route_code='${ROUTE}' AND split_part(from_station,'/',1)='${FROM}' AND split_part(to_station,'/',1)='${TO}'`;

// ── 固定时间窗（写死；早于任何未来样本 ⇒ 不随采集漂移）──
const CUTOFF = "TIMESTAMPTZ '2026-11-09 17:05:00+08'";
const DENOM = "source='track' AND from_main <> to_main AND minutes BETWEEN 0.1 AND 20";
const RAW_WHERE = `${RH_WHERE} AND ${DENOM} AND observed_at < ${CUTOFF}`;
/** 实跑 2026-11-09T09:05Z，**禁推算** */
const RAW_BASE = { n: 49, p50_sec: 824.76, avg_sec: 855.564489795918 };
/** 澳门时区 day 桶（与 `bucketOfRoute` 的 hour ∈ [9,16) 一致） */
const MACAU_DAY = `EXTRACT(HOUR FROM (observed_at AT TIME ZONE 'Asia/Macau')) >= 9 AND EXTRACT(HOUR FROM (observed_at AT TIME ZONE 'Asia/Macau')) < 16`;

let failed = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failed++;
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-9;

async function main() {
  const rawConn =
    process.env.DATABASE_URL_CLOUD_SESSION ?? process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL;
  if (!rawConn) {
    console.error("❌ 无连接串（fail-closed，不静默跳过）");
    process.exit(1);
  }
  const u = new URL(rawConn);
  if (u.port === "6543") u.port = "5432"; // 只用会话模式（事务池多语句无一致视图）
  const client = new Client({
    connectionString: u.toString(),
    ssl: rawConn.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  try {
    await client.connect();
  } catch (e) {
    console.error("❌ DB 不可达（fail-closed）", (e as Error)?.message ?? e);
    process.exit(1);
  }
  const q = async (sql: string): Promise<Record<string, unknown>[]> => {
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error("READ-ONLY GUARD: 非 SELECT");
    return (await client.query(sql)).rows as Record<string, unknown>[];
  };

  try {
    console.log(`\n基准读数锁（${ROUTE} 路 ${FROM}→${TO}，只读 5432 会话模式；固定窗 observed_at < 2026-11-09 17:05+08）`);

    // ── ① 原始窗口（数值层的唯一真源）──
    console.log("\n  ── ① 原始样本窗口（segment_samples，固定 CUTOFF）──");
    const rawRow =
      (
        await q(
          `SELECT count(*) AS n,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes*60) AS p50_sec,
                  avg(minutes)*60 AS avg_sec,
                  max(observed_at) AS max_obs
             FROM segment_samples WHERE ${RAW_WHERE}`,
        )
      )[0] ?? {};
    ok(Number(rawRow.n) === RAW_BASE.n, `①-1 原始窗口 n === 49（固定窗，精确）`, `${rawRow.n}`);
    ok(
      near(Number(rawRow.p50_sec), RAW_BASE.p50_sec, 0.01),
      `①-2 原始窗口 p50_sec === 824.76（±0.01s）`,
      `${rawRow.p50_sec}`,
    );
    ok(
      near(Number(rawRow.avg_sec), RAW_BASE.avg_sec, 0.01),
      `①-3 原始窗口 avg_sec === 855.564489795918（±0.01s）`,
      `${rawRow.avg_sec}`,
    );
    console.log(`    （信息，不作断言）窗口内最晚样本 max(observed_at) = ${rawRow.max_obs}`);

    const rawDay =
      (
        await q(
          `SELECT count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes) AS p50_min
             FROM segment_samples WHERE ${RAW_WHERE} AND ${MACAU_DAY}`,
        )
      )[0] ?? {};

    // ── ② 主关系：派生表 ≡ 原始窗口 ──
    console.log("\n  ── ② route_hop_stats ≡ 原始窗口（同口径）──");
    const rh = await q(`SELECT p50_sec, samples, run_sec, avg_sec FROM route_hop_stats WHERE ${RH_WHERE}`);
    ok(rh.length > 0, `②-1 分母：route_hop_stats 命中行 > 0`, `${rh.length}`);
    ok(rh.length === 1, `②-2 命中行数 === 1（该跳唯一）`, `${rh.length}`);
    const r0 = rh[0] ?? {};
    ok(
      near(Number(r0.p50_sec), Number(rawRow.p50_sec), 0.01),
      `②-3 派生 p50_sec ≡ 原始窗口 p50_sec（±0.01s；口径未被重建改坏）`,
      `${r0.p50_sec} vs ${rawRow.p50_sec}`,
    );
    ok(
      Number(r0.samples) >= RAW_BASE.n,
      `②-4 派生 samples >= ${RAW_BASE.n}（下限：派生随采集只增，不锁精确值）`,
      `${r0.samples}`,
    );

    // ── ③ 4a：segment_stats 与原始窗口的关系锁（全部关系式，不锁具体数值）──
    console.log("\n  ── 4a：segment_stats ↔ 原始窗口（关系式；容差 0.05 见文件头）──");
    const ss = await q(
      `SELECT time_bucket, arrive_kind, weekday, p50_minutes, avg_minutes, samples, p50_run_minutes
         FROM segment_stats WHERE ${SS_WHERE}`,
    );
    const pick = (tb: string, ak: string) =>
      ss.find((r) => r.time_bucket === tb && r.arrive_kind === ak && Number(r.weekday) === -1);
    const allRow = pick("all", "stop");
    const dayRow = pick("day", "stop");
    // 4a-1：all 层 p50 ≡ 原始 p50_sec/60
    ok(
      !!allRow && near(Number(allRow.p50_minutes), Number(rawRow.p50_sec) / 60, 0.05),
      `4a-1 all 层 p50_minutes ≡ 原始 p50_sec/60（±0.05 = numeric(5,1) 截断 0.046 + 余量 0.004）`,
      allRow ? `${allRow.p50_minutes} vs ${(Number(rawRow.p50_sec) / 60).toFixed(3)}` : "缺行",
    );
    // 4a-2：all 层 avg ≡ 原始 avg_sec/60
    ok(
      !!allRow && near(Number(allRow.avg_minutes), Number(rawRow.avg_sec) / 60, 0.05),
      `4a-2 all 层 avg_minutes ≡ 原始 avg_sec/60（±0.05）`,
      allRow ? `${allRow.avg_minutes} vs ${(Number(rawRow.avg_sec) / 60).toFixed(3)}` : "缺行",
    );
    // 4a-3：day 层是真子集 + p50 ≡ 原始 day 桶 p50
    ok(
      !!allRow &&
        !!dayRow &&
        Number(rawDay.n) > 0 &&
        Number(dayRow.samples) > 0 &&
        Number(dayRow.samples) <= Number(allRow.samples) &&
        near(Number(dayRow.p50_minutes), Number(rawDay.p50_min), 0.05),
      `4a-3 day 层是真子集（0 < samples <= all 层）且 p50_minutes ≡ 原始 day 桶 p50_min（±0.05）`,
      dayRow ? `${dayRow.samples}/${allRow?.samples}；${dayRow.p50_minutes} vs ${rawDay.p50_min}（n=${rawDay.n}）` : "缺行",
    );
    // 4a-4：长尾关系（avg > p50 且差 >= 0.1）——不再依赖 13.7/14.3 的具体数值巧合
    ok(
      !!allRow && Number(allRow.avg_minutes) > Number(allRow.p50_minutes) && Number(allRow.avg_minutes) - Number(allRow.p50_minutes) >= 0.1,
      `4a-4 all 层 avg_minutes > p50_minutes 且差 >= 0.1（长尾关系，非数值巧合）`,
      allRow ? `avg ${allRow.avg_minutes} / p50 ${allRow.p50_minutes}` : "缺行",
    );
    // 4a-5（已删）：曾有 `ok(… || allRow.time_bucket !== dayRow.time_bucket)` —— 桶名由 pick 硬编码不同
    //   ⇒ 恒真、零检测力。「数值相等但来源不同」是**溯源事实**，运行期拿两个值比不出来；
    //   两条来源已分别由 4a-2（钉 raw.avg_sec/60）与 4a-3（钉 rawDay.p50_min）独立锚定。

    // ── ④ 4b：p50_run_minutes 与 run_sec（诊断列）──
    console.log("\n  ── 4b：p50_run_minutes 与 run_sec（诊断列）──");
    const allLayer = ss.filter((r) => r.time_bucket === "all");
    ok(
      allLayer.length >= 2 && allLayer.some((r) => r.arrive_kind === "all"),
      `4b-1 all 层行数 >= 2 且含 arrive_kind='all' 合并行（不锁精确 2 行）`,
      `${allLayer.length} 行：${allLayer.map((r) => String(r.arrive_kind)).join(",")}`,
    );
    ok(
      allLayer.length > 0 && allLayer.every((r) => r.p50_run_minutes === null),
      `4b-2 all 层 p50_run_minutes 全 NULL（terminal-only 结构事实，保留精确）`,
      allLayer.map((r) => String(r.p50_run_minutes)).join(","),
    );
    // ★ run_sec 是**诊断列**（build-hop-stats.ts:18），禁止用于 ETA —— ETA 只认 p50_sec。
    ok(
      near(Number(r0.run_sec), Number(r0.avg_sec), 1e-9) && near(Number(r0.avg_sec), Number(rawRow.avg_sec), 0.01),
      `4b-3 run_sec ≡ avg_sec（恒等式）且 route_hop_stats.avg_sec ≡ 原始窗口 avg_sec（±0.01；run_sec 是诊断列，禁用于 ETA）`,
      `${r0.run_sec} / ${r0.avg_sec} vs ${rawRow.avg_sec}`,
    );

    // ── ⑤ 4c：两表不可混用（列集合锁 / 单位锁 / 层级锁）──
    console.log("\n  ── 4c：两表结构锁（不可混用）──");
    const cols = await q(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('route_hop_stats','segment_stats')`,
    );
    const rhCols = new Set(cols.filter((c) => c.table_name === "route_hop_stats").map((c) => c.column_name));
    const ssCols = new Set(cols.filter((c) => c.table_name === "segment_stats").map((c) => c.column_name));
    ok(rhCols.has("p50_sec") && !ssCols.has("p50_sec"), `4c-1 列集合锁：p50_sec 只在 route_hop_stats（segment_stats 无同名）`);
    ok(ssCols.has("p50_minutes") && !rhCols.has("p50_minutes"), `4c-2 列集合锁：p50_minutes 只在 segment_stats（route_hop_stats 无同名）`);
    ok(
      Number(r0.p50_sec) > 100 && Number(allRow?.p50_minutes ?? 0) < 100,
      `4c-3 单位锁：p50_sec(秒)>100 vs p50_minutes(分)<100`,
      `${r0.p50_sec} vs ${allRow?.p50_minutes}`,
    );
    const cnt = (
      await q(
        `SELECT (SELECT count(*) FROM route_hop_stats WHERE ${RH_WHERE}) AS rh_n, (SELECT count(*) FROM segment_stats WHERE ${SS_WHERE}) AS ss_n`,
      )
    )[0];
    ok(
      Number(cnt.rh_n) === 1 && Number(cnt.ss_n) >= 2,
      `4c-4 层级锁：route_hop_stats 该跳 ROWCOUNT=1 vs segment_stats >= 2（跳级 vs 分层，不锁精确 7）`,
      `${cnt.rh_n}/${cnt.ss_n}`,
    );
  } finally {
    await client.end();
  }

  console.log(failed ? `\n❌ ${failed} 条断言失败` : `\n✅ 全部断言通过（原始窗口锁 49/824.76/855.564 + 派生关系锁 4a/4b/4c）`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("❌ 测试失败：", e);
  process.exit(1);
});
