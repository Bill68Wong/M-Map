/**
 * 迁移 v4.1.0：区间时长口径修正（db/migrate-v4100-hop-basis.ts）
 *
 * 用法：
 *   npm run db:migrate-v4100                      # dry-run（只探测，不写库）
 *   npm run db:migrate-v4100 -- --apply --allow-prod
 *
 * ── 本迁移加什么（三列 + 一个索引，全部 IF NOT EXISTS，幂等）────────────
 *   ① `segment_samples.run_minutes`  NUMERIC NULL
 *      纯行驶时长（分）= `minutes − dwell_b_min`。**仅 depart 口径有 dwell**，
 *      故 arrive / terminal 口径的行留 NULL（不猜）。
 *      用途：中途总站（站名含總站且不在首末位）的邻接对，乘客实际要的是「开过去的时间」，
 *      不是「含司机休息的离开口径」——26 路 C656→C654/3 实测 minutes 2.6 / run 0.85。
 *   ② 索引 `segment_samples_hop_basis (route_code, from_main, to_main, arrive_kind)`
 *      查询/核对形态 = 按线路 + 邻接对 + 口径取样本（含新增的 `arrive_kind='terminal'`）。
 *   ③ `segment_stats.p50_run_minutes` NUMERIC NULL
 *      预聚合层的纯行驶 p50（lookupHop 直接读；为 NULL ⇒ 回退到 p50_minutes，行为不变）。
 *
 * ── 为什么必须会话模式 5432 ────────────────────────────────────────────
 *   `.env` 的 `DATABASE_URL` 指向 Supabase pooler 的 **6543（事务模式）**：
 *   同一批 DDL 里「ALTER TABLE → 紧接着查 information_schema 复核」会落到不同后端，
 *   看到不一致快照 ⇒ 假红/漏判。5432 是同一台 pooler 的会话模式（整条连接固定一个后端）。
 *   本文件用 `new pg.Client`（单连接）+ 端口改写，不走 Pool。
 *
 * ── 边界 ──────────────────────────────────────────────────────────────
 *   · 只加列 / 索引 / 注释，**不改任何既有列、不重写数据、不删样本**；
 *   · 默认 dry-run：只打印将执行的 DDL + 现状探针；
 *   · 三态（幂等）：缺失 ⇒ 新建；已存在 ⇒ 跳过并 NOTICE；索引同名但定义不同 ⇒ 保留并告警。
 */
import { Client } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 ⇒ 下面会提示 */
}

const APPLY = process.argv.includes("--apply");
const target = process.argv[2] as "local" | "cloud" | undefined;
const connStr =
  target === "cloud"
    ? process.env.DATABASE_URL
    : target === "local"
      ? process.env.DATABASE_URL_LOCAL
      : (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL);

/** 连接串 → **会话模式**（仅端口确实是 6543 时改写；本地/直连原样返回） */
function sessionUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.port === "6543") u.port = "5432";
    return u.toString();
  } catch {
    return url;
  }
}

export const DDL: { label: string; sql: string }[] = [
  {
    label: "segment_samples.run_minutes（纯行驶时长，可空）",
    sql: `ALTER TABLE segment_samples ADD COLUMN IF NOT EXISTS run_minutes NUMERIC`,
  },
  {
    label: "segment_samples 口径索引（route, from_main, to_main, arrive_kind）",
    sql: `CREATE INDEX IF NOT EXISTS segment_samples_hop_basis
            ON segment_samples (route_code, from_main, to_main, arrive_kind)`,
  },
  {
    label: "segment_stats.p50_run_minutes（预聚合纯行驶 p50，可空）",
    sql: `ALTER TABLE segment_stats ADD COLUMN IF NOT EXISTS p50_run_minutes NUMERIC`,
  },
  {
    label: "列注释 · segment_samples.run_minutes",
    sql: `COMMENT ON COLUMN segment_samples.run_minutes IS
      '纯行驶时长（分）= minutes − dwell_b_min。仅 arrive_kind=''depart'' 且 dwell_b_min 非空的行有值；
       arrive / terminal 口径留 NULL（没有终点站停站数据，不猜）。
       用途：中途总站（站名含總站/总站且不在首末位）的邻接对，用纯行驶而不是含司机休息的 minutes。'`,
  },
  {
    label: "列注释 · segment_stats.p50_run_minutes",
    sql: `COMMENT ON COLUMN segment_stats.p50_run_minutes IS
      '纯行驶分钟 p50（扣终点站停站）。仅当邻接对属于该线路的「中途总站」时被 lookupHop 优先采用；
       其余情况一律用 p50_minutes（含正常停站，行为不变）。'`,
  },
];

/** 现状探针（只读）：列 / 索引是否存在 + 新口径样本数 */
async function probe(client: Client) {
  const col = async (table: string, column: string) =>
    Number(
      (
        await client.query(
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
          [table, column],
        )
      ).rows[0]?.n ?? 0,
    ) > 0;
  const idx = async (name: string) =>
    Number(
      (
        await client.query(
          `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='public' AND indexname=$1`,
          [name],
        )
      ).rows[0]?.n ?? 0,
    ) > 0;
  const ss = await col("segment_samples", "run_minutes");
  const ix = await idx("segment_samples_hop_basis");
  const sr = await col("segment_stats", "p50_run_minutes");
  console.log("\n── 现状探针（只读）──");
  console.log(`  segment_samples.run_minutes          ${ss ? "已存在" : "缺失"} ${ss ? "⇒ 跳过" : "⇒ 将 ADD COLUMN"}`);
  console.log(`  segment_samples_hop_basis 索引        ${ix ? "已存在" : "缺失"} ${ix ? "⇒ 跳过" : "⇒ 将 CREATE INDEX"}`);
  console.log(`  segment_stats.p50_run_minutes        ${sr ? "已存在" : "缺失"} ${sr ? "⇒ 跳过" : "⇒ 将 ADD COLUMN"}`);

  const byKind = (
    await client.query(
      `SELECT arrive_kind, count(*)::int AS n FROM segment_samples GROUP BY 1 ORDER BY 1`,
    )
  ).rows as { arrive_kind: string; n: number }[];
  console.log(
    `  样本口径分布：${byKind.map((r) => `${r.arrive_kind}=${r.n}`).join(" · ") || "（空表）"}`,
  );
  if (ss) {
    const r = (
      await client.query(
        `SELECT count(*) FILTER (WHERE run_minutes IS NOT NULL)::int AS with_run,
                count(*) FILTER (WHERE arrive_kind='terminal')::int AS term
           FROM segment_samples`,
      )
    ).rows[0] as { with_run: number; term: number } | undefined;
    console.log(`  已有 run_minutes 的行 ${r?.with_run ?? 0} · terminal 样本 ${r?.term ?? 0}`);
  }
}

async function main() {
  if (!connStr) {
    console.error("❌ 未找到连接串：请先在 .env 配置 DATABASE_URL（参照 .env.example）");
    process.exit(1);
    return;
  }
  const sUrl = sessionUrl(connStr);
  console.log(`目标库：${sUrl.replace(/:[^:@/]+@/, ":****@")}`);
  console.log(`连接模式：${sUrl === connStr ? "原样（非 6543 池）" : "会话模式 5432（原串为事务池 6543）"}`);
  console.log(APPLY ? "模式：APPLY（会写库）" : "模式：DRY-RUN（不写库，只探测）");
  console.log("=".repeat(72));

  const client = new Client({
    connectionString: sUrl,
    ssl: connStr.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  client.on("notice", (n) => console.log(`      [notice] ${String(n.message).trim()}`));
  await client.connect();
  // 生产库会被平台间歇性置为只读 ⇒ 会话级显式 off（与 migrate-v3800 一致）
  await client.query("SET default_transaction_read_only = off");

  try {
    await probe(client);

    console.log("\n── 将执行的 DDL ──\n");
    for (const [i, step] of DDL.entries()) {
      console.log(`  ${String(i + 1).padStart(2)}. ${step.label}`);
      if (!APPLY) console.log(`${step.sql.replace(/^/gm, "      ")}\n`);
      else await client.query(step.sql);
    }
    if (APPLY) console.log("\n  ✅ 全部 DDL 已执行（IF NOT EXISTS ⇒ 可重复执行）");

    if (!APPLY) {
      console.log("\nDRY-RUN 结束：**未写库**。确认无误后加 `--apply --allow-prod` 重跑。");
      return;
    }

    console.log("\n" + "=".repeat(72));
    await probe(client);
    console.log("\n✅ APPLY 结束。下一步：");
    console.log("  1) node scripts/track-derive.mjs ...        （产出 rawTerminalSamples）");
    console.log("  2) npm run db:segsamples -- --apply         （写 terminal / run_minutes）");
    console.log("  3) npm run db:segments -- cloud --allow-prod --from=both （重算 segment_stats）");
  } finally {
    await client.end();
  }
}

// 仅直接执行时跑；被测试 import 时只导出 DDL
const invokedDirectly = (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("migrate-v4100-hop-basis.ts");
if (invokedDirectly) {
  main().catch((e) => {
    console.error("❌ 迁移失败：", e);
    process.exit(1);
  });
}
