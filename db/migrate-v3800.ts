/**
 * 迁移 v3.8.0：跨境交通两张表（机场航班 / 三码头船班次）
 *
 * 用法：
 *   npm run db:migrate-v3800                                   # dry-run（只探测，不写库）
 *   npm run db:migrate-v3800 -- --apply --allow-prod            # 执行
 *   npm run db:migrate-v3800 -- --apply --drop --allow-prod     # 撤销（**只删本迁移的 2 张表**）
 *
 * ── 两条表为什么长这样（结论都来自实测，改之前先读契约）──────────────────
 *   ① `xborder_flights` 唯一键 `(sched_date, direction, flight_no, sched_time)`：
 *      同一航班号当日**既有离澳也有抵澳**（同一架飞机飞来回）⇒ `direction` 必须进键，
 *      否则第二程会 ON CONFLICT 覆盖第一程；同号当日两班在结构上也完全可能 ⇒ `sched_time` 进键。
 *   ② `xborder_sailings` 唯一键 `(sail_date, direction, pier, operator_raw, place_raw, sched_time)`：
 *      氹仔↔香港上環 由**两家公司共营**（单方向实测 22 班，金光 18 / 噴射 4）⇒
 *      同码头同分钟并列在结构上可能，`operator_raw` 必须进键；
 *      而**船名刻意不进键** —— 临时调船会让同一班变成两行（旧船名幽灵）。
 *
 * ── `voided_at`：含 `sched_time` 的键必然要付的代价 ──────────────────────
 *   上游改时刻 ⇒ 同一班变成两行（旧行永久留库），"当日所有"里会显示一个不存在的班次。
 *   故必须有失效标记，且**只对 `sched_at > now() - 15min` 的行判定**
 *   （滚动窗口会正常丢弃早已过去的班次；不划线就会把上午的班次全标死）。
 *   落地在 `src/lib/cross-border/store-write.ts#voidMissing*`，本文件只建列。
 *
 * ── 状态历史：**不建**历史表 ──────────────────────────────────────────
 *   状态文本自带事件时刻（`已啟航 08:20` / `16:32 啟航` / `預計 20:35 到達`）⇒
 *   历史表能提供的额外信息量接近于零。需求 5/6 也只显示当前状态。
 *   （项目刚删掉 14 张表，`db/schema.sql:8-14` 明确"别把任何一段加回来"。）
 *
 * ── ⚠️ 本迁移**故意不同步** `db/schema.sql` ───────────────────────────
 *   `schema.sql` 是"重建库的唯一真相源"，但这两张表的数据是**运行时累积的当日数据**：
 *   进 `schema.sql` 会让人误以为 `npm run db:schema` 能产出"当日所有"（不能，它是空的）。
 *   ⇒ 等 P3 稳定后再决定是否只把**建表段**（不含数据）补进去。
 *   **下一轮请勿"顺手补进 schema.sql"** —— 那会让 schema.sql 的语义变得模糊。
 *
 * ── 边界 ──────────────────────────────────────────────────────────────
 *   · 全部 `CREATE TABLE / INDEX IF NOT EXISTS`，`COMMENT ON` 幂等；**不触碰任何既有表**；
 *   · 默认 dry-run：不写库、只打印将执行的 DDL 与"表是否已存在"的探测结果；
 *   · `--drop` 只删本文件的 `TABLES` 常量里那两张，且必须先 `--apply`。
 */
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 ⇒ 下面会提示 */
}

const APPLY = process.argv.includes("--apply");
const DROP = process.argv.includes("--drop");
/**
 * `--verify-ddl`：把全部 DDL 在一个事务里跑一遍然后 **ROLLBACK**。
 *
 * 为什么需要它：`--apply` 之前没人能证明这堆 SQL 真的能过（语法/约束名冲突/
 * `COMMENT ON` 的目标写错，都只在执行那一刻才炸）。而 Postgres 的 DDL 是**事务性**的
 * ⇒ 可以"完整执行 + 完整回滚"，**零残留**：不留下表、不留下索引、不留下注释，
 * 连 `BIGSERIAL` 的序列也会一起回滚。
 * 它只短暂持有新建对象的 catalog 行（新表尚无并发访问者），是本项目里最安全的验证方式。
 */

const target = process.argv[2] as "local" | "cloud" | undefined;
const connStr =
  target === "cloud"
    ? process.env.DATABASE_URL
    : target === "local"
      ? process.env.DATABASE_URL_LOCAL
      : (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL);

/** 本迁移拥有的全部表（`--drop` 与复核据此；顺序 = 删除顺序，无外键故无所谓） */
export const TABLES = ["xborder_sailings", "xborder_flights"] as const;

export const DDL: { label: string; sql: string }[] = [
  {
    label: "xborder_flights 建表 + 唯一键 + CHECK",
    sql: `CREATE TABLE IF NOT EXISTS xborder_flights (
      id                BIGSERIAL PRIMARY KEY,

      -- 业务身份（唯一键四件套）：direction 区分离/抵（同号同日出往返两程），
      -- sched_time 区分同号当日两班，sched_date 是上游 date 字段（DD-MM-YYYY 解析后）
      sched_date        DATE        NOT NULL,
      direction         TEXT        NOT NULL,
      flight_no         TEXT        NOT NULL,
      sched_time        TIME        NOT NULL,

      -- 展示字段：原文照录，禁止改写（airline_raw 是 'NX' 这种两字码）
      airline_raw       TEXT,
      place_raw         TEXT,
      gate_raw          TEXT,
      status_raw        TEXT        NOT NULL DEFAULT '',

      -- 我方派生：只服务排序/着色/新鲜度，永不替换 status_raw
      sched_at          TIMESTAMPTZ NOT NULL,
      status_kind       TEXT        NOT NULL DEFAULT 'unknown',
      status_changed_at TIMESTAMPTZ,

      -- 生命周期
      first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      voided_at         TIMESTAMPTZ,

      CONSTRAINT xborder_flights_identity
        UNIQUE (sched_date, direction, flight_no, sched_time),
      CONSTRAINT xborder_flights_dir_chk CHECK (direction IN ('dep', 'arr')),
      CONSTRAINT xborder_flights_kind_chk CHECK (status_kind IN
        ('departed','boarding_closed','checkin_open','cancelled','delayed','landed','unknown'))
    )`,
  },
  {
    label: "xborder_flights 当日查询索引（部分索引：只索引未失效行）",
    sql: `CREATE INDEX IF NOT EXISTS ix_xborder_flights_day
            ON xborder_flights (sched_date, direction, sched_at)
            WHERE voided_at IS NULL`,
  },
  {
    label: "xborder_sailings 建表 + 唯一键 + CHECK",
    sql: `CREATE TABLE IF NOT EXISTS xborder_sailings (
      id                BIGSERIAL PRIMARY KEY,

      -- 业务身份（六件套）：operator 进键因同码头同分钟可能两家公司并列；
      -- 船名**不进键**（临时调船不该造出幽灵行）
      sail_date         DATE        NOT NULL,
      direction         TEXT        NOT NULL,
      pier              TEXT        NOT NULL,
      operator_raw      TEXT        NOT NULL,
      place_raw         TEXT        NOT NULL,
      sched_time        TIME        NOT NULL,

      -- 展示字段：原文照录（条款「均不可以修改任何內容」）
      vessel_raw        TEXT,
      vessel_type_raw   TEXT,
      gate_raw          TEXT,
      status_raw        TEXT        NOT NULL DEFAULT '',

      -- 我方派生
      sched_at          TIMESTAMPTZ NOT NULL,
      status_kind       TEXT        NOT NULL DEFAULT 'unknown',
      status_changed_at TIMESTAMPTZ,

      -- 生命周期
      first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      voided_at         TIMESTAMPTZ,

      CONSTRAINT xborder_sailings_identity
        UNIQUE (sail_date, direction, pier, operator_raw, place_raw, sched_time),
      CONSTRAINT xborder_sailings_dir_chk  CHECK (direction IN ('dep', 'arr')),
      CONSTRAINT xborder_sailings_pier_chk CHECK (pier IN ('PE', 'TP', 'PI')),
      CONSTRAINT xborder_sailings_kind_chk CHECK (status_kind IN
        ('departed','arrived','eta','pending','unknown'))
    )`,
  },
  {
    label: "xborder_sailings 当日查询索引",
    sql: `CREATE INDEX IF NOT EXISTS ix_xborder_sailings_day
            ON xborder_sailings (sail_date, pier, direction, sched_at)
            WHERE voided_at IS NULL`,
  },
  {
    label: "表注释（写清「上游是滚动窗口、本表靠累积补齐」）",
    sql: `COMMENT ON TABLE xborder_flights IS
      '澳门国际机场航班（离澳/抵澳同表，direction 区分）。上游为当日滚动窗口，早班会被移除 ⇒ 本表靠累积补齐"当日所有"。status_raw 原文照录，不得改写。'`,
  },
  {
    label: "列注释 · flights.voided_at",
    sql: `COMMENT ON COLUMN xborder_flights.voided_at IS
      '非空 = 曾有、后续采集在"未来窗口内"消失 ⇒ 判定为改时刻/改航线的旧行。仅未过期(sched_at > now - 15min)的行才可被 void，否则与滚动窗口正常丢弃混淆。'`,
  },
  {
    label: "列注释 · flights.status_changed_at",
    sql: `COMMENT ON COLUMN xborder_flights.status_changed_at IS
      '我方观测到状态变化的时刻，不是航班事件时刻（事件时刻已内嵌在 status_raw 文本里，如"已啟航 08:20"）。'`,
  },
  {
    label: "表注释 · sailings（条款要求原文照录）",
    sql: `COMMENT ON TABLE xborder_sailings IS
      '海事及水务局三码头船班次。条款要求"不可以修改任何内容" ⇒ *_raw 列原文照录，展示层直接渲染。sail_date 由采集时刻推出（上游无日期字段）。'`,
  },
  {
    label: "列注释 · sailings.pier",
    sql: `COMMENT ON COLUMN xborder_sailings.pier IS
      '存上游查询参数值 PE/TP/PI，不存中文名：官方自称（澳門外港/澳門氹仔/澳門內港）与产品文案（外港码头/氹仔码头/内港码头）不同，中文名交给前端映射，避免"我方改写官方名称"。'`,
  },
  {
    label: "列注释 · sailings.status_raw",
    sql: `COMMENT ON COLUMN xborder_sailings.status_raw IS
      '原文照录，含"16:32 啟航""預計 20:35 到達""待航""已啟航"等。禁止任何 replace/大小写/全半角转换。'`,
  },
];

async function main() {
  if (!connStr) {
    console.error("❌ 未找到连接串：请先在 .env 配置 DATABASE_URL（参照 .env.example）");
    process.exit(1);
    return;
  }
  console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);
  console.log(APPLY ? "模式：APPLY（会写库）" : "模式：DRY-RUN（不写库，只探测）");
  console.log("=".repeat(72));

  const pool = new Pool({
    connectionString: connStr,
    ssl: connStr.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  /**
   * ★ 生产库会被平台**间歇性**置为只读（`default_transaction_read_only = on`）。
   *   现象：`--verify-ddl` 时好时坏，报
   *   `cannot execute CREATE TABLE in a read-only transaction`。
   *   与 `db/migrate-vehicle-plates.ts:49` 同处置：会话级显式 off 覆盖。
   *   ⚠️ 这**不影响**本脚本默认的 dry-run —— 那条路径只有 SELECT，
   *      唯一的写动作在 `--apply` 与 `--verify-ddl`（后者整体 ROLLBACK）。
   */
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));

  try {
    const exists = async (t: string) =>
      ((
        await pool.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
          [t],
        )
      ).rowCount ?? 0) > 0;

    console.log("── 现状探测 ──\n");
    for (const t of TABLES)
      console.log(`  ${t.padEnd(20)} ${(await exists(t)) ? "已存在" : "不存在"}`);

    if (DROP) {
      console.log("\n── 撤销（--drop）──\n");
      for (const t of TABLES) {
        const sql = `DROP TABLE IF EXISTS ${t}`;
        if (!APPLY) {
          console.log(`  [dry-run] ${sql}`);
          continue;
        }
        await pool.query(sql);
        console.log(`  ✅ ${sql}`);
      }
    } else {
      console.log("\n── 将执行的 DDL ──\n");
      for (const [i, step] of DDL.entries()) {
        console.log(`  ${String(i + 1).padStart(2)}. ${step.label}`);
        if (!APPLY) console.log(`${step.sql.replace(/^/gm, "      ")}\n`);
        else await pool.query(step.sql);
      }
      if (APPLY) console.log("\n  ✅ 全部 DDL 已执行（IF NOT EXISTS ⇒ 可重复执行）");
    }

    console.log("\n" + "=".repeat(72));
    if (!APPLY) {
      console.log("DRY-RUN 结束：**未写库**。确认无误后加 `--apply --allow-prod` 重跑。");
    } else {
      // 复核：列数 + 约束 + 索引（不靠记忆，靠 information_schema）
      for (const t of TABLES) {
        if (!(await exists(t))) {
          console.log(`复核 ${t}：不存在（--drop 后正常）`);
          continue;
        }
        const cols = await pool.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
          [t],
        );
        const cons = await pool.query(
          `SELECT constraint_name FROM information_schema.table_constraints
            WHERE table_schema='public' AND table_name=$1 ORDER BY constraint_name`,
          [t],
        );
        const idx = await pool.query(
          `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname`,
          [t],
        );
        console.log(
          `复核 ${t}：${cols.rowCount} 列 · 约束 ${cons.rows.map((r) => (r as { constraint_name: string }).constraint_name).join(",")}` +
            ` · 索引 ${idx.rows.map((r) => (r as { indexname: string }).indexname).join(",")}`,
        );
      }
      console.log("\n✅ APPLY 结束。注意：本迁移**不同步** db/schema.sql（理由见文件头）。");
    }
  } finally {
    await pool.end();
  }
}

// 仅当本文件被**直接执行**时才跑 migrate；被 `scripts/check-xborder-store.ts` import 时
// 只导出 `DDL` / `TABLES`（这样 DDL 只有一份，演练与真实迁移不可能漂移）。
const invokedDirectly = (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("migrate-v3800.ts");
if (invokedDirectly) {
  main().catch((e) => {
    console.error("❌ 迁移失败：", e);
    process.exit(1);
  });
}
