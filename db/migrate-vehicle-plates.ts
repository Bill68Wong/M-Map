/**
 * 迁移：新建 `vehicle_plates`（车牌 ↔ 车队编号 ↔ 车型）
 * 用法：npm run db:migrate-vehicle-plates -- cloud --allow-prod
 *
 * ── 解决什么（2026-10-30 主人拍板「车牌-车型对应数据入库」）──────────────
 *   DSAT 报站/位置接口每帧都白送 `busPlate` + `busCode`（+`busType`），但此前只在
 *   内存里用一次就丢。落表后才有「见到车牌 → 它是什么车」的稳定答案，也为将来
 *   按型号做运力/校准分析留底。
 *
 * ── 为什么 plate 是主键 ───────────────────────────────────────────────
 *   查询入口是车牌；一车一牌一编号，plate 唯一。`bus_code` 只建普通索引（反查/统计）。
 *
 * ── 为什么 `busType` 存 TEXT 而不是 int ───────────────────────────────
 *   存 DSAT 原值（'1'|'2'）**不做语义翻译** —— 1=大巴 / 2=中巴·小巴 这个含义是
 *   由「与车长对拍」推得的（DSAT 无官方文档），换算逻辑留在代码里（`vehicle-models.ts`），
 *   将来口径被推翻时只需改代码、不必迁移存量。
 *
 * ⚠️ 只建表 + 索引，**不碰任何既有表**；可重复执行（IF NOT EXISTS）。
 * ⚠️ 本迁移不回填数据。
 * ⚠️ 2026-11-06：回填脚本 `scripts/backfill-vehicle-plates.ts` 已随 `bus_snapshots` 表删除
 *    （Spec §6.2 / OD-07 同批下线，其历史播种源就是 bus_snapshots）—— 别再按旧命令去跑，
 *    命令已不存在。空表补数据只能靠后续实时抓取。
 */
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const target = process.argv[2] as "local" | "cloud" | undefined;
const connStr =
  target === "cloud"
    ? process.env.DATABASE_URL
    : target === "local"
      ? process.env.DATABASE_URL_LOCAL
      : ((process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL) || process.env.DATABASE_URL);

if (!connStr) {
  console.error("❌ 未找到连接串：请先在 .env 配置（参照 .env.example）");
  process.exit(1);
}
console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);

async function main() {
  const pool = new Pool({
    connectionString: connStr,
    ssl: connStr?.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  // 生产库会被间歇性置为只读 ⇒ 会话级显式 off 覆盖（与 migrate-v3400 / v3600 一致）
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));

  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS vehicle_plates (
         plate            TEXT PRIMARY KEY,
         bus_code         TEXT,
         company          TEXT,
         bus_type         TEXT,
         model            TEXT,
         model_category   TEXT,
         model_source     TEXT,
         model_confidence TEXT,
         first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
         last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
         calibrated_at    TIMESTAMPTZ
       )`,
    );
    console.log("✅ vehicle_plates 表已就绪");

    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_vehicle_plates_bus_code ON vehicle_plates(bus_code)`,
    );
    console.log("✅ 索引 idx_vehicle_plates_bus_code 已就绪");

    await pool.query(
      `COMMENT ON TABLE vehicle_plates IS
       '车牌 ↔ DSAT 车队编号 ↔ 车型 静态标定。由采集链路顺手 upsert（同一次 DSAT 响应已含 busPlate/busCode，零额外请求）。
        model* 四列来自 src/lib/dsat/vehicle-models.ts 的静态区段表，model 为 NULL 表示"该编号批次无资料"（不是"没采到"）。'`,
    );
    await pool.query(
      `COMMENT ON COLUMN vehicle_plates.bus_type IS
       'DSAT busType 原值（1|2），不做语义翻译。1=大巴 / 2=中巴·小巴 由与车长对拍推得，DSAT 无官方文档。'`,
    );
    await pool.query(
      `COMMENT ON COLUMN vehicle_plates.model_confidence IS
       'high=官网原文区段 / medium=社区车队表或非官方来源 / low / none。model 非空但 confidence=medium 时，用前需校对。'`,
    );
    await pool.query(
      `COMMENT ON COLUMN vehicle_plates.calibrated_at IS
       '该行 model* 最近一次被静态对照表写入的时间；纯观察（未查到型号）不更新此列。'`,
    );
    console.log("✅ 列注释已写入");

    // 复核：列数应为 11（8 业务列 + 3 时间列）
    const cols = (
      await pool.query(
        `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'vehicle_plates'
          ORDER BY ordinal_position`,
      )
    ).rows as { column_name: string; data_type: string }[];
    console.log(`\n复核：vehicle_plates 共 ${cols.length} 列`);
    console.log(cols.map((c) => `  · ${c.column_name.padEnd(18)} ${c.data_type}`).join("\n"));

    const n = (await pool.query(`SELECT count(*)::int AS n FROM vehicle_plates`)).rows[0] as { n: number };
    console.log(`当前行数：${n.n}${n.n === 0 ? "（空表，下一步回填）" : ""}`);

    if (n.n === 0) {
      console.log(`\n下一步：空表只能靠后续实时抓取补数据`);
      console.log(`  （历史播种脚本 backfill-vehicle-plates 已于 2026-11-06 随 bus_snapshots 表删除）`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
