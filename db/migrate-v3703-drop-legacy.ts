/**
 * 迁移 v3.7.3：删除 14 张旧表（通琴号迭代 · 负责人 2026-11-06 最终裁决）
 *
 * ── 这不是「清理」，是不可逆的数据销毁 ────────────────────────────────
 *   先读 `docs/迭代-通琴号-20261105/05-Spec.md` §6.2 / §6.2.1 / §6.2.2 再动这个脚本。
 *   执行顺序（Spec 锁死，不得调换）：
 *     ① `npm run db:backup` 产出可校验 dump  →  ② 导出待删表（本脚本自动做）
 *     →  ③ 部署不依赖这些表的代码  →  ④ 最后 drop（本脚本 --apply）
 *
 * ── 三态 + 幂等 ───────────────────────────────────────────────────────
 *   ① 14 张表全在          → 执行导出 + 删表
 *   ② 部分存在             → 只处理存在的那几张（其余记「已删除，跳过」）
 *   ③ 全不存在             → 无变更（第二次跑必然是 ③）
 *
 * ── 默认 dry-run ──────────────────────────────────────────────────────
 *   不带 `--apply`：**只读**。报告每张表的实际行数、指向它们的外键、
 *   计划执行顺序。这一步可以随便跑，不写一个字节。
 *
 * ── `--apply` 会先导出，再删 ─────────────────────────────────────────
 *   `backups/legacy-drop-20261106/` 下每张表三个文件：
 *     `<table>.csv`                —— 全量数据（CSV，可被 Excel/psql 直接读）
 *     `<table>.schema.sql`         —— 结构（`--drop` 撤销时据此重建空壳）
 *     `<table>.data.sql`           —— 数据（`pg_dump --data-only` 的 SQL 文本）
 *   并写 `_manifest.json`（行数、字节数、导出行数三方对齐）——
 *   **导出行数 ≠ SQL 行数就中止，不删任何表**。
 *
 * ── `--drop` 是撤销，且只能重建空壳 ──────────────────────────────────
 *   `--apply --drop`：按 `*.schema.sql` 重放建表语句并恢复两条外键。
 *   ⚠️ 数据**不会**回来 —— 要真恢复只有一条路：`pg_restore backups/2026-11-06.dump`。
 *
 * 用法：
 *   npm run db:migrate-v3703                                    # dry-run（只读）
 *   npm run db:migrate-v3703 -- --apply --allow-prod             # 导出 + 删表
 *   npm run db:migrate-v3703 -- --apply --drop --allow-prod      # 撤销（只重建空壳）
 */
import { Pool } from "pg";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const APPLY = process.argv.includes("--apply");
const DROP = process.argv.includes("--drop");
const ROOT = "D:/Projects/University/Studio/musttoukou";
process.loadEnvFile(path.join(ROOT, ".env"));
const CONN = process.env.DATABASE_URL!;
const u = new URL(CONN);
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
const OUT = path.join(ROOT, ".verify", "migrate-v3703.out.txt");
const BACKUP_DIR = path.join(ROOT, "backups", "legacy-drop-20261106");
/** 必须已存在的基线备份（Spec AC-10：备份先行） */
const BACKUP_BASELINE = path.join(ROOT, "backups", "2026-11-06.dump");

/**
 * 待删 14 张表（Spec §6.2 表格逐行）。`rows` 是裁决时的实测行数，
 * 只用于报告「与裁决快照是否一致」，**不参与**任何判定。
 *
 * ⚠️ 顺序 = 删表顺序：子表在前、父表在后（`plan_legs` → `commute_plans`；
 *    `place_coords` / `station_walk_distance` / `commute_plans` → `places`）。
 *    刻意**不用** `DROP TABLE ... CASCADE` —— CASCADE 会连带删掉没被点名的主，
 *    而这里每一条都必须在报告里说得清。
 */
const LEGACY: { table: string; rows: number; why: string }[] = [
  { table: "edit_audit", rows: 0, why: "从未写入过的审计表（0 行）" },
  { table: "shadow_diff_report", rows: 32, why: "影子对照离线表；读路径已于 2026-09-19 移除（Spec OD-07）" },
  { table: "route_stations_bak_20260919", rows: 2870, why: "备份表（bak_20260919）" },
  { table: "route_stations_bak_20261030", rows: 2922, why: "备份表（bak_20261030）" },
  { table: "routes_bak_20261030", rows: 100, why: "备份表（bak_20261030）" },
  { table: "stations_bak_20260919", rows: 613, why: "备份表（bak_20260919）" },
  { table: "ride_crowd", rows: 59, why: "拥挤度采集；计时链已 410 下线" },
  { table: "bus_snapshots", rows: 4080, why: "车队快照写入点；/api/dsat/grab 已 410" },
  { table: "place_coords", rows: 6, why: "坐标已内联进 place-ids.ts#PLACE_COORDS" },
  { table: "favorite_routes", rows: 41, why: "旧服务端收藏；/api/fav-routes* 已 410，现收藏走 localStorage" },
  { table: "station_walk_distance", rows: 37, why: "距离档位；walk_times.distance_m 全 NULL 已降级（Spec 已接受）" },
  { table: "plan_legs", rows: 131, why: "旧推荐链方案腿（子表，先删）" },
  { table: "commute_plans", rows: 33, why: "旧推荐链方案（Spec §6.2.2 整链下线）" },
  { table: "places", rows: 4, why: "预设地点；4 行已固化成 place-ids.ts 常量（父表，最后删）" },
];

/** 需要在删表**之前**先摘掉的外键（Spec §6.2.1 点名两条；保留 walk_times 表与数据） */
const KNOWN_FKS: { table: string; constraint: string; why: string }[] = [
  { table: "walk_times", constraint: "walk_times_place_id_fkey", why: "保留 walk_times 20 行，只去外键" },
  { table: "timer_sessions", constraint: "timer_sessions_plan_id_fkey", why: "保留 timer_sessions，只去外键" },
];

// ─────────────────────────── 工具 ───────────────────────────
const hasTable = async (t: string) =>
  (
    await q(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t])
  ).length > 0;

const countOf = async (t: string) => Number((await q(`SELECT count(*)::int AS n FROM "${t}"`))[0].n);

const sizeOf = async (t: string) =>
  String((await q(`SELECT pg_size_pretty(pg_total_relation_size($1::regclass)) AS s`, [`public.${t}`]))[0].s);

/** 指向「待删集合」内的表、但自身**不在**待删集合内的外键 —— 必须先摘掉才能删父表 */
const externalFks = async (): Promise<{ table: string; constraint: string; target: string }[]> => {
  const rows = await q(
    `SELECT c.conrelid::regclass::text AS tbl, c.conname AS name, c.confrelid::regclass::text AS ref
       FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.confrelid::regclass::text = ANY($1::text[])
      ORDER BY 1, 2`,
    [LEGACY.map((l) => `public.${l.table}`)],
  );
  const dropSet = new Set(LEGACY.map((l) => `public.${l.table}`));
  return rows
    .map((r) => ({ table: String(r.tbl), constraint: String(r.name), target: String(r.ref) }))
    .filter((r) => !dropSet.has(r.table));
};

/** pg_dump / psql 定位（与 db/backup.ps1 同口径） */
function findPgTool(name: "pg_dump" | "psql"): string | null {
  const fromEnv = process.env.PG_DUMP_PATH;
  if (fromEnv && fs.existsSync(path.dirname(fromEnv))) {
    const p = path.join(path.dirname(fromEnv), `${name}.exe`);
    if (fs.existsSync(p)) return p;
  }
  const candidates = [
    `D:/Development/Databases/PostgreSQL/bin/${name}.exe`,
    `C:/Program Files/PostgreSQL/18/bin/${name}.exe`,
    `C:/Program Files/PostgreSQL/17/bin/${name}.exe`,
    `C:/Program Files/PostgreSQL/16/bin/${name}.exe`,
    `C:/Program Files/PostgreSQL/15/bin/${name}.exe`,
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** CSV 单元转义（值里可能有逗号/引号/换行：摘要、JSON 列） */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

interface ManifestEntry {
  table: string;
  existed: boolean;
  rowsSql: number;
  rowsCsv: number;
  csvBytes: number;
  schemaSqlBytes: number;
  dataSqlBytes: number;
  rowsMatch: boolean;
}

// ─────────────────────────── 主流程 ───────────────────────────
const main = async () => {
  say("=".repeat(76));
  say(`删除 14 张旧表 · migrate-v3703 · ${APPLY ? (DROP ? "APPLY + DROP（撤销：只重建空壳）" : "APPLY") : "DRY-RUN（只读）"}`);
  say("=".repeat(76));

  // ── 撤销分支 ──
  if (DROP) {
    say("");
    say("⚠️⚠️ 撤销只能重建**空壳**：表结构回来，数据不会回来。");
    say(`     真要恢复数据：pg_restore --no-owner --no-privileges --dbname=<连接串> ${path.relative(ROOT, BACKUP_BASELINE)}`);
    if (!fs.existsSync(BACKUP_DIR)) {
      say(`     ❌ 找不到 ${path.relative(ROOT, BACKUP_DIR)} —— 没有 schema 快照可重放，中止。`);
      process.exitCode = 1;
      return;
    }
    const psql = findPgTool("psql");
    if (!psql) {
      say("     ❌ 找不到 psql.exe（设 PG_DUMP_PATH 或装 PostgreSQL 客户端），中止。");
      process.exitCode = 1;
      return;
    }
    say("");
    for (const l of LEGACY) {
      const f = path.join(BACKUP_DIR, `${l.table}.schema.sql`);
      if (!fs.existsSync(f)) {
        say(`  · ${l.table.padEnd(30)} 无 schema 快照 → 跳过（无法重建）`);
        continue;
      }
      if (!APPLY) {
        say(`  · ${l.table.padEnd(30)} 将重放 ${path.basename(f)}`);
        continue;
      }
      // --no-psqlrc + 不因单条失败中止（表已存在时 CREATE 会报错，不影响其它表）
      const r = spawnSync(psql, ["--no-psqlrc", `--dbname=${CONN}`, "-v", "ON_ERROR_STOP=0", "-f", f], {
        encoding: "utf8",
      });
      say(`  · ${l.table.padEnd(30)} ${r.status === 0 ? "✅ 空壳已重建" : `⚠️ psql 退出码 ${r.status}`}`);
    }
    if (APPLY) {
      say("");
      say("恢复两条外键（Spec §6.2.1 摘掉的那两条）：");
      for (const fk of KNOWN_FKS) {
        try {
          if (fk.constraint === "walk_times_place_id_fkey") {
            await q(`ALTER TABLE walk_times ADD CONSTRAINT walk_times_place_id_fkey
                     FOREIGN KEY (place_id) REFERENCES places(id)`);
          } else {
            await q(`ALTER TABLE timer_sessions ADD CONSTRAINT timer_sessions_plan_id_fkey
                     FOREIGN KEY (plan_id) REFERENCES commute_plans(id)`);
          }
          say(`  · ${fk.constraint} ✅`);
        } catch (e) {
          say(`  · ${fk.constraint} ⚠️ 未恢复：${(e as Error).message.split("\n")[0]}`);
        }
      }
      say("");
      say("完成（空壳）。⚠️ 数据仍需 pg_restore 才能回来。");
    } else {
      say("");
      say("dry-run 结束（未执行任何 DDL）。");
    }
    return;
  }

  // ── 现状盘点 ──
  say("");
  say("[1] 现状（实际值以库为准；「裁决快照」列仅用于核对是否漂移）");
  say(`    ${"表".padEnd(30)} ${"存在".padEnd(5)} ${"实际行数".padStart(8)} ${"裁决快照".padStart(8)} ${"体积".padStart(10)}`);
  const present: typeof LEGACY = [];
  for (const l of LEGACY) {
    const ok = await hasTable(l.table);
    if (!ok) {
      say(`    ${l.table.padEnd(30)} ${"否".padEnd(5)} ${"-".padStart(8)} ${String(l.rows).padStart(8)} ${"-".padStart(10)}`);
      continue;
    }
    const n = await countOf(l.table);
    const sz = await sizeOf(l.table);
    present.push(l);
    const drift = n !== l.rows ? ` ← 与快照差 ${n - l.rows}` : "";
    say(`    ${l.table.padEnd(30)} ${"是".padEnd(5)} ${String(n).padStart(8)} ${String(l.rows).padStart(8)} ${sz.padStart(10)}${drift}`);
  }

  say("");
  if (!present.length) {
    say("[2] 三态判定：**③ 全不存在** ⇒ 无变更（本迁移已执行过）");
    say("");
    say("完成（无变更）。");
    return;
  }
  say(`[2] 三态判定：**${present.length === LEGACY.length ? "① 全在" : `② 部分存在（${present.length}/${LEGACY.length}）`}**`);

  // ── 必须先摘掉的外键 ──
  say("");
  say("[3] 删表前必须先摘掉的外键（保留被引用表的数据）");
  const ext = await externalFks();
  if (!ext.length) say("    （无）");
  for (const e of ext) {
    const known = KNOWN_FKS.find((k) => k.constraint === e.constraint);
    say(`    · ${e.table} → ${e.target}  CONSTRAINT ${e.constraint}${known ? `  【Spec §6.2.1 点名：${known.why}】` : "  ⚠️ 未在 Spec 点名清单内，本脚本仍会摘掉"}`);
  }
  // Spec 点名的两条即使没被 externalFks 命中也要报告（可能已不存在）
  for (const k of KNOWN_FKS) {
    if (!ext.some((e) => e.constraint === k.constraint)) {
      say(`    · ${k.table} CONSTRAINT ${k.constraint}：当前不存在（已摘或从未建）`);
    }
  }

  // ── 保留下来的表：删完必须仍然完好 ──
  say("");
  say("[4] 删完必须仍然完好的表（Spec §6.2.1 断言）");
  for (const t of ["walk_times", "timer_sessions", "timer_events", "tqh_stations", "segment_stats"]) {
    if (!(await hasTable(t))) {
      say(`    · ${t.padEnd(18)} **不存在**（本迁移不创建它，仅作对照）`);
      continue;
    }
    say(`    · ${t.padEnd(18)} ${String(await countOf(t)).padStart(6)} 行`);
  }

  // ── 计划 ──
  say("");
  say("[5] 计划执行顺序（子表在前、父表在后；**不使用 CASCADE**）");
  present.forEach((l, i) => say(`    ${String(i + 1).padStart(2)}. DROP TABLE ${l.table.padEnd(30)} ${l.why}`));

  if (!APPLY) {
    say("");
    say("dry-run 结束（未写一个字节）。加 --apply 执行导出 + 删表。");
    return;
  }

  // ── 前置：基线备份必须存在（Spec AC-10）──
  say("");
  say("[6] 前置校验：基线备份");
  if (!fs.existsSync(BACKUP_BASELINE)) {
    say(`    ❌ 找不到 ${path.relative(ROOT, BACKUP_BASELINE)}。先跑 npm run db:backup —— 备份先行是 AC-10 的硬要求，中止。`);
    process.exitCode = 1;
    return;
  }
  const baselineBytes = fs.statSync(BACKUP_BASELINE).size;
  say(`    ✅ ${path.basename(BACKUP_BASELINE)}：${baselineBytes.toLocaleString()} B`);
  if (baselineBytes < 1024 * 1024) {
    say("    ❌ 基线备份小于 1MB，不像一份完整 dump，中止。");
    process.exitCode = 1;
    return;
  }

  // ── 导出 ──
  const pgDump = findPgTool("pg_dump");
  say("");
  say(`[7] 导出到 ${path.relative(ROOT, BACKUP_DIR)}${pgDump ? "" : "（⚠️ 未找到 pg_dump：将只产出 CSV，跳过 .sql 快照）"}`);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const manifest: ManifestEntry[] = [];
  for (const l of present) {
    const res = await pool.query(`SELECT * FROM "${l.table}"`);
    const cols = res.fields.map((f) => f.name);
    const lines: string[] = [cols.join(",")];
    for (const row of res.rows as Record<string, unknown>[]) {
      lines.push(cols.map((c) => csvCell(row[c])).join(","));
    }
    const csvPath = path.join(BACKUP_DIR, `${l.table}.csv`);
    fs.writeFileSync(csvPath, lines.join("\n") + "\n", "utf8");
    const rowsSql = await countOf(l.table);

    let schemaBytes = 0;
    let dataBytes = 0;
    if (pgDump) {
      const schemaPath = path.join(BACKUP_DIR, `${l.table}.schema.sql`);
      const dataPath = path.join(BACKUP_DIR, `${l.table}.data.sql`);
      const rs = spawnSync(
        pgDump,
        ["--no-owner", "--no-privileges", "--schema-only", `--table=public.${l.table}`, `--dbname=${CONN}`, `--file=${schemaPath}`],
        { encoding: "utf8" },
      );
      const rd = spawnSync(
        pgDump,
        ["--no-owner", "--no-privileges", "--data-only", `--table=public.${l.table}`, `--dbname=${CONN}`, `--file=${dataPath}`],
        { encoding: "utf8" },
      );
      if (rs.status !== 0 || rd.status !== 0) {
        say(`    ❌ ${l.table}：pg_dump 失败（schema=${rs.status} data=${rd.status}）→ 中止，未删任何表`);
        say(`       ${(rs.stderr || rd.stderr || "").trim().split("\n")[0]}`);
        process.exitCode = 1;
        return;
      }
      schemaBytes = fs.statSync(schemaPath).size;
      dataBytes = fs.statSync(dataPath).size;
    }

    const entry: ManifestEntry = {
      table: l.table,
      existed: true,
      rowsSql,
      rowsCsv: res.rows.length,
      csvBytes: fs.statSync(csvPath).size,
      schemaSqlBytes: schemaBytes,
      dataSqlBytes: dataBytes,
      rowsMatch: rowsSql === res.rows.length,
    };
    manifest.push(entry);
    say(
      `    · ${l.table.padEnd(30)} SQL ${String(rowsSql).padStart(5)} 行 / CSV ${String(entry.rowsCsv).padStart(5)} 行` +
        ` ${entry.rowsMatch ? "✅ 一致" : "🔴 **不一致**"}` +
        ` · csv ${entry.csvBytes} B` +
        (pgDump ? ` · schema ${schemaBytes} B · data ${dataBytes} B` : ""),
    );
  }

  fs.writeFileSync(
    path.join(BACKUP_DIR, "_manifest.json"),
    JSON.stringify({ at: new Date().toISOString(), baseline: path.basename(BACKUP_BASELINE), baselineBytes, entries: manifest }, null, 2),
    "utf8",
  );

  // 行数不一致 ⇒ 不删。这是唯一能挡住「导出成功但内容截断」的闸门。
  const mismatch = manifest.filter((m) => !m.rowsMatch);
  if (mismatch.length) {
    say("");
    say(`    🔴 ${mismatch.length} 张表导出行数与库内行数不一致（${mismatch.map((m) => m.table).join(", ")}）→ 中止，未删任何表。`);
    process.exitCode = 1;
    return;
  }
  say(`    ✅ 14 张表导出完成，行数全部一致（manifest 见 _manifest.json）`);

  // ── 摘外键 ──
  say("");
  say("[8] 摘掉外键");
  for (const e of ext) {
    await q(`ALTER TABLE ${e.table} DROP CONSTRAINT IF EXISTS ${e.constraint}`);
    say(`    ✅ ${e.table} DROP CONSTRAINT ${e.constraint}`);
  }
  // Spec 点名的两条兜底（即便上方未命中）
  for (const k of KNOWN_FKS) {
    const r = await q(
      `SELECT 1 FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`,
      [`public.${k.table}`, k.constraint],
    );
    if (r.length) {
      await q(`ALTER TABLE ${k.table} DROP CONSTRAINT IF EXISTS ${k.constraint}`);
      say(`    ✅ ${k.table} DROP CONSTRAINT ${k.constraint}（点名兜底）`);
    }
  }

  // ── 删表 ──
  say("");
  say("[9] 删表");
  const dropped: string[] = [];
  for (const l of present) {
    await q(`DROP TABLE IF EXISTS "${l.table}"`);
    const gone = !(await hasTable(l.table));
    if (gone) dropped.push(l.table);
    say(`    ${gone ? "✅" : "🔴"} DROP TABLE ${l.table}`);
  }

  // ── 复核 ──
  say("");
  say("[10] 复核");
  const stillThere: string[] = [];
  for (const l of LEGACY) if (await hasTable(l.table)) stillThere.push(l.table);
  say(`    被删 14 表仍存在：${stillThere.length ? "🔴 " + stillThere.join(", ") : "✅ 0 张"}`);
  const wtOk = await hasTable("walk_times");
  const wtN = wtOk ? await countOf("walk_times") : -1;
  say(`    walk_times：${wtOk ? `✅ 保留，${wtN} 行` : "🔴 **不存在**"}`);
  const tsOk = await hasTable("timer_sessions");
  say(`    timer_sessions：${tsOk ? `✅ 保留，${await countOf("timer_sessions")} 行` : "🔴 **不存在**"}`);

  say("");
  say(`完成：删除 ${dropped.length} 张表，导出在 ${path.relative(ROOT, BACKUP_DIR)}/`);
  if (stillThere.length) process.exitCode = 1;
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
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    } catch {
      /* 日志写失败不影响迁移结果 */
    }
    await pool.end();
  }
})();
