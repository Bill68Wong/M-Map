/**
 * 迁移 v3.7.2：`tqh_segment_paths`（通琴号相邻有向站对的离线路径几何）
 *
 * ── 这张表为什么必须存在（而不是请求时调高德）─────────────────────────
 *   通琴号一个班次最多 18 个站、80 个班次、763 次相邻关系（去重后 **302 个有向站对**）。
 *   请求期调高德驾车接口 ⇒ 每次点卡片都要等 1~2s 且烧配额；而且「同一站序复用同一几何」
 *   是 AC-5 的硬要求。⇒ 几何**离线算一次落库**，请求期只做一次 LEFT JOIN。
 *
 * ── 去重键只能是 (from, to, profile) ──────────────────────────────────
 *   **禁止**按 `route_no + direction` 聚合：实测 64 组 (route_no, direction) 装不下
 *   73 种真实站序，其中 8 组是「真不同路线」（几何差 259~3701 m）⇒ 按标号级 key 会画错路。
 *
 * ── 三态 + 幂等 ───────────────────────────────────────────────────────
 *   ① 表不存在            → CREATE（含主键 / CHECK / 索引 / COMMENT）
 *   ② 表存在但结构不全      → 只补缺失的列 / 索引 / 约束（不改已有列类型，避免静默丢数据）
 *   ③ 表存在且结构完整      → 报告「无变更」，不执行任何 DDL
 *   两种前态都可重复执行，第二次必然落到 ③。
 *
 * ── `profile` 为什么是一列而不是版本后缀表名 ──────────────────────────
 *   算法变更（如高德接口换版本、抓路策略改动）要能**并存**：老行留着给老客户端/回滚，
 *   新行用新 profile 写入。读端只认 `TQH_SEGMENT_PROFILE`（`src/lib/tqh/types.ts`），
 *   换版本 = 改一个常量 + 重跑离线脚本，不需要迁移。
 *
 * 用法：
 *   npm run db:migrate-v3702                                   # dry-run（默认，只读）
 *   npm run db:migrate-v3702 -- --apply --allow-prod            # 执行建表
 *   npm run db:migrate-v3702 -- --apply --drop --allow-prod     # 撤销（删表，几何可离线重算）
 *
 * ⚠️ 本迁移只建表结构，不写任何数据 —— 几何由离线脚本
 *    `scripts/build-tqh-segment-paths.ts` 抓取后写入。
 */
import { Pool } from "pg";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");
const DROP = process.argv.includes("--drop");
process.loadEnvFile("D:/Projects/University/Studio/musttoukou/.env");
const u = new URL(process.env.DATABASE_URL!);
const pool = new Pool({
  host: u.hostname,
  port: Number(u.port || 5432),
  database: u.pathname.slice(1),
  user: u.username,
  password: decodeURIComponent(u.password || ""),
  ssl: { rejectUnauthorized: false },
});

const q = async (s: string, a?: unknown[]) => (await pool.query(s, a)).rows as Record<string, unknown>[];
const out: string[] = [];
const say = (s: string) => {
  out.push(s);
  console.log(s);
};
const OUT = "D:/Projects/University/Studio/musttoukou/.verify/migrate-v3702.out.txt";

const TABLE = "tqh_segment_paths";

const hasTable = async (t: string) =>
  (
    await q(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t])
  ).length > 0;

/** 列名 → 是否 nullable（`data_type` 仅用于报告） */
const columnsOf = async (t: string) => {
  const rows = await q(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
      ORDER BY ordinal_position`,
    [t],
  );
  return rows as { column_name: string; data_type: string; is_nullable: "YES" | "NO" }[];
};

const indexNamesOf = async (t: string) =>
  (
    await q(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname`, [
      t,
    ])
  ).map((r) => String((r as { indexname: string }).indexname));

/**
 * 本迁移期望的列（口径 = Spec §6.1 的列表）。
 *
 * ⚠️ 时间列名是 **`computed_at`**，不是 `fetched_at`：Spec §6.1 列表明写
 *    `computed_at | timestamptz | 计算时间`，架构裁决 OD-04 也写「带 `profile` 与 `computed_at`」。
 *    （`fetched_at` 是 `station_walk_distance` 的列名，那张表本迭代被删，别混。）
 */
const COLUMNS: { name: string; ddl: string }[] = [
  { name: "from_station_id", ddl: "INT" },
  { name: "to_station_id", ddl: "INT" },
  { name: "profile", ddl: "TEXT" },
  { name: "polyline", ddl: "JSONB" },
  { name: "distance_m", ddl: "INT" },
  { name: "duration_s", ddl: "INT" },
  { name: "source", ddl: "TEXT" },
  { name: "computed_at", ddl: "TIMESTAMPTZ DEFAULT now()" },
];

const DDL = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
     from_station_id INT  NOT NULL REFERENCES tqh_stations(id) ON DELETE CASCADE,
     to_station_id   INT  NOT NULL REFERENCES tqh_stations(id) ON DELETE CASCADE,
     profile         TEXT NOT NULL,
     polyline        JSONB NOT NULL,
     distance_m      INT,
     duration_s      INT,
     source          TEXT NOT NULL,
     computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT ${TABLE}_pkey PRIMARY KEY (from_station_id, to_station_id, profile),
     CONSTRAINT ${TABLE}_source_chk CHECK (source IN ('amap-driving', 'straight-fallback')),
     CONSTRAINT ${TABLE}_distinct_stations_chk CHECK (from_station_id <> to_station_id)
   )`,
  `COMMENT ON TABLE ${TABLE} IS '通琴号相邻有向站对的离线路径几何（Spec §6.1 / OD-04）。唯一键 (from,to,profile)：禁止按 route_no+direction 聚合，会画错路；polyline=[[lng,lat],…] GCJ-02；source=amap-driving 或 straight-fallback（降级直线，不造假）'`,
  `COMMENT ON COLUMN ${TABLE}.profile IS '算法版本（如 driving-v1）。换版本=改 src/lib/tqh/types.ts#TQH_SEGMENT_PROFILE + 重跑离线脚本，老版本行并存可回滚'`,
  `COMMENT ON COLUMN ${TABLE}.polyline IS '[[lng,lat],…] GCJ-02（与 tqh_* 同系，勿再转）'`,
  `COMMENT ON COLUMN ${TABLE}.source IS 'amap-driving=高德驾车路径；straight-fallback=两点直线降级（前端画虚线）'`,
  `COMMENT ON COLUMN ${TABLE}.computed_at IS '计算时间。每季度复核一次（Spec OD-04 约束③）'`,
  `CREATE INDEX IF NOT EXISTS idx_tqh_segment_paths_profile ON ${TABLE} (profile)`,
];

const main = async () => {
  say("=".repeat(72));
  say(`通琴号段几何 · migrate-v3702 · ${APPLY ? (DROP ? "APPLY + DROP（撤销）" : "APPLY") : "DRY-RUN"}`);
  say("=".repeat(72));

  // ── 0) 前置：tqh_stations 必须存在（外键目标）──
  const stOk = await hasTable("tqh_stations");
  say("");
  say(`[0] 前置表 tqh_stations：${stOk ? "已存在" : "**缺失**"}`);
  if (!stOk && !DROP) {
    say("    ❌ 中止：请先执行 npm run db:migrate-v3700（建 tqh_stations / tqh_trips / tqh_trip_stops）。");
    say("       本迁移不做「顺带把上游表也建了」—— 那样两张迁移的 ownership 会重叠。");
    process.exitCode = 1;
    return;
  }

  // ── 撤销分支 ──
  if (DROP) {
    const exists = await hasTable(TABLE);
    say("");
    say(`[DROP] ${TABLE}：${exists ? "存在 → 将 DELETE 表" : "不存在 → 无需处理"}`);
    if (exists) {
      const n = Number((await q(`SELECT count(*)::int AS n FROM ${TABLE}`))[0].n);
      say(`    当前 ${n} 行几何。⚠️ 删表会丢掉离线算路结果（可由 scripts/build-tqh-segment-paths.ts 重算，但会重新消耗高德配额）。`);
    }
    if (!APPLY) {
      say("    （dry-run：未执行任何 DDL）");
      return;
    }
    await q(`DROP TABLE IF EXISTS ${TABLE}`);
    say("    ✅ 已删除");
    return;
  }

  // ── 三态判定 ──
  const exists = await hasTable(TABLE);
  say("");
  say(`[1] ${TABLE} 存在性：${exists ? "已存在" : "不存在"}`);

  if (!exists) {
    say("");
    say("[2] 状态判定：**① 不存在** ⇒ 将执行完整 CREATE（含主键 / CHECK / 索引 / COMMENT）");
    if (!APPLY) {
      say("");
      say("    计划执行的 DDL：");
      for (const s of DDL) say("      " + s.split("\n")[0].trim() + (s.includes("\n") ? " …" : ""));
      say("");
      say("    （dry-run：未执行任何 DDL。加 --apply 执行）");
      return;
    }
    say("");
    for (const s of DDL) await q(s);
    say("    ✅ CREATE 完成");
  } else {
    const cols = await columnsOf(TABLE);
    const names = new Set(cols.map((c) => c.column_name));
    const missing = COLUMNS.filter((c) => !names.has(c.name));
    const idx = await indexNamesOf(TABLE);
    const needProfileIdx = !idx.includes("idx_tqh_segment_paths_profile");
    const needPk = !idx.includes(`${TABLE}_pkey`);

    say("");
    say(`[2] 状态判定：${missing.length || needProfileIdx || needPk ? "**② 结构不全**" : "**③ 完整**"}`);
    say(`    现有列：${cols.map((c) => `${c.column_name}:${c.data_type}${c.is_nullable === "NO" ? "!" : ""}`).join(" · ")}`);
    say(`    现有索引：${idx.join(" · ") || "（无）"}`);
    if (missing.length) say(`    缺失列：${missing.map((c) => c.name).join(", ")}`);
    if (needPk) say(`    缺失：主键 ${TABLE}_pkey`);
    if (needProfileIdx) say(`    缺失：profile 索引`);

    if (!missing.length && !needProfileIdx && !needPk) {
      say("");
      say("    无变更。");
    } else {
      if (!APPLY) {
        say("");
        say("    计划执行：补齐上述缺失项（**不**改已有列类型，避免静默丢数据）");
        say("    （dry-run：未执行任何 DDL。加 --apply 执行）");
        return;
      }
      say("");
      for (const c of missing) {
        // ⚠️ 只加可空列：给非空列补 ADD COLUMN 会让既有行需要默认值，
        //    而本表既有行是真实几何 —— 猜一个默认值等于造假数据。
        await q(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS ${c.name} ${c.ddl.replace(" NOT NULL", "")}`);
        say(`    ✅ ADD COLUMN ${c.name}`);
      }
      if (needPk) {
        await q(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${TABLE}_pkey PRIMARY KEY (from_station_id, to_station_id, profile)`);
        say("    ✅ ADD PRIMARY KEY");
      }
      if (needProfileIdx) {
        await q(`CREATE INDEX IF NOT EXISTS idx_tqh_segment_paths_profile ON ${TABLE} (profile)`);
        say("    ✅ CREATE INDEX profile");
      }
    }
  }

  // ── 复核 ──
  say("");
  say("[3] 复核");
  const cols2 = await columnsOf(TABLE);
  const idx2 = await indexNamesOf(TABLE);
  const n = Number((await q(`SELECT count(*)::int AS n FROM ${TABLE}`))[0].n);
  say(`    列 ${cols2.length} 个：${cols2.map((c) => c.column_name).join(", ")}`);
  say(`    索引 ${idx2.length} 个：${idx2.join(", ")}`);
  say(`    行数：${n}${n === 0 ? "（空表 —— 几何待 scripts/build-tqh-segment-paths.ts 写入）" : ""}`);

  const colOk = COLUMNS.every((c) => cols2.some((x) => x.column_name === c.name));
  const pkOk = idx2.includes(`${TABLE}_pkey`);
  const idxOk = idx2.includes("idx_tqh_segment_paths_profile");
  const fkOk =
    (
      await q(
        `SELECT 1 FROM pg_constraint
          WHERE conrelid = $1::regclass AND contype = 'f'
          GROUP BY conrelid HAVING count(*) >= 2`,
        [`public.${TABLE}`],
      )
    ).length > 0;
  say(
    `    结构校验：列 ${colOk ? "✅" : "🔴"} · 主键 ${pkOk ? "✅" : "🔴"} · profile 索引 ${idxOk ? "✅" : "🔴"} · 外键×2 ${fkOk ? "✅" : "🔴"}`,
  );

  say("");
  say(APPLY ? "完成。" : "dry-run 结束（未执行 DDL）。");
};

/* tsx 以 CJS 打包，不支持顶层 await ⇒ 用 IIFE 包裹 */
void (async () => {
  try {
    await main();
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    try {
      fs.mkdirSync("D:/Projects/University/Studio/musttoukou/.verify", { recursive: true });
      fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    } catch {
      /* 日志写失败不影响迁移结果 */
    }
    await pool.end();
  }
})();
