/**
 * 迁移 v2.3.0（db/migrate-v2300.ts）—— 步行距离修正 D6：擎天匯 ⇄ 石排灣 400 → 450
 *
 * ── 起因（06 §4.10 / 07 §3.9 · 用户拍板 D6）────────────────────────────
 *   真源 = `station_walk_distance.distance_m`（行：`places.slug='home'` +
 *   `station_main='LRT-SPW'` + `zone IS NULL`），原值 400 m（2026-09-18 人工核实）。
 *   v2.3.0 统一改为 **450 m**。
 *
 * ── ★ 影响面（只此一档）────────────────────────────────────────────────
 *   `distance_m` **只被档 1（全力冲刺）的衰减模型 `tier1EffRatio` 消费**
 *   ⇒ 改它只影响「全力冲刺有机会赶上」这一档的判定，
 *     **不影响**卡面显示的「步行 X 分」（那个来自 `walk_times` 实测）。
 *
 * ── ★ 只动一行（硬约束）───────────────────────────────────────────────
 *   **僅** 改 `home` → `LRT-SPW`（擎天匯↔石排灣）这一条；
 *   `gate` → `M1`（關閘→M1，同为 400）**不动**（07 §3.9-6 边界裁定）。
 *   执行前先 SELECT 复核目标行，命中数 ≠ 1 即中止（防误改）。
 *
 * ── 幂等 ──────────────────────────────────────────────────────────────
 *   已是 450 时跳写（只报告）；可重复执行。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs db/migrate-v2300.ts            # dry-run（只读）
 *   node node_modules/tsx/dist/cli.mjs db/migrate-v2300.ts --apply     # 写生产库（先备份）
 *   node node_modules/tsx/dist/cli.mjs db/migrate-v2300.ts --revert    # 回滚（读备份）
 */
import fs from "node:fs";
import { Pool } from "pg";

// ★ 2026-11-12 修：原硬编码作者机绝对路径（BACKUP/OUT 均落在仓库根 .verify/）。
const ROOT = process.cwd();
const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BACKUP = `${ROOT}/.verify/distance-corrections-backup-v2300-lrt-spw.json`;
const OUT = `${ROOT}/.verify/migrate-v2300.out.txt`;

/** 唯一目标行：擎天匯（home）↔ 石排灣（LRT-SPW） */
const TARGET = { slug: "home", stationMain: "LRT-SPW" } as const;
const NEW_DISTANCE_M = 450;

process.loadEnvFile(`${ROOT}/.env`);
const u = new URL(process.env.DATABASE_URL!);
const pool = new Pool({
  host: u.hostname,
  port: Number(u.port || 5432),
  database: u.pathname.slice(1),
  user: u.username,
  password: decodeURIComponent(u.password || ""),
  ssl: { rejectUnauthorized: false },
});

const out: string[] = [];
const say = (s: string) => {
  out.push(s);
  console.log(s);
};

interface Row {
  id: number;
  place_id: number;
  station_main: string;
  zone: string | null;
  distance_m: string | null;
}

async function selectTarget(): Promise<Row[]> {
  const r = await pool.query(
    `SELECT sd.id, sd.place_id, sd.station_main, sd.zone, sd.distance_m
       FROM station_walk_distance sd
       JOIN places p ON p.id = sd.place_id
      WHERE p.slug = $1 AND sd.station_main = $2 AND COALESCE(sd.zone, '') = ''
      ORDER BY sd.id`,
    [TARGET.slug, TARGET.stationMain],
  );
  return r.rows as Row[];
}

/** 执行 UPDATE（只命中目标行；返回受影响行数） */
async function applyUpdate(): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const res = await c.query(
      `UPDATE station_walk_distance sd
          SET distance_m = $1, fetched_at = now(), snap_start_m = NULL, snap_end_m = NULL
         FROM places p
        WHERE sd.place_id = p.id AND p.slug = $2 AND sd.station_main = $3 AND COALESCE(sd.zone, '') = ''`,
      [NEW_DISTANCE_M, TARGET.slug, TARGET.stationMain],
    );
    await c.query("COMMIT");
    return res.rowCount ?? 0;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

async function main() {
  say(`模式：${REVERT ? "★ REVERT（回滚）" : APPLY ? "★ APPLY（写生产库）" : "DRY-RUN（只读）"}`);
  say(`目标库：${u.hostname} / ${u.pathname.slice(1)}`);
  say(`目标行：places.slug='${TARGET.slug}' + station_walk_distance.station_main='${TARGET.stationMain}'（zone NULL）`);
  say("");

  // ── REVERT：从备份恢复 ──
  if (REVERT) {
    if (!fs.existsSync(BACKUP)) {
      say(`🔴 找不到备份 ${BACKUP.split("/").pop()} —— 无法回滚`);
      await pool.end();
      fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
      process.exit(1);
    }
    const b = JSON.parse(fs.readFileSync(BACKUP, "utf8")) as { id: number; distance_m: string | null };
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const res = await c.query(`UPDATE station_walk_distance SET distance_m = $1, fetched_at = now() WHERE id = $2`, [
        b.distance_m,
        b.id,
      ]);
      await c.query("COMMIT");
      say(`② 已回滚 id=${b.id} → ${b.distance_m} m（影响 ${res.rowCount} 行）`);
    } catch (e) {
      await c.query("ROLLBACK");
      say(`🔴 回滚出错：${(e as Error).message}`);
      c.release();
      await pool.end();
      fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
      process.exit(1);
    }
    c.release();
    await pool.end();
    fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    return;
  }

  // ── ① 现状（改前 SELECT）──
  const before = await selectTarget();
  say("① 改前 SELECT（目标行）");
  if (!before.length) {
    say("   🔴 未命中目标行（期望正好 1 行）—— 中止，不做任何修改");
    await pool.end();
    fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    process.exit(1);
  }
  for (const r of before) {
    say(`   id=${r.id} place_id=${r.place_id} ${r.station_main} zone=${r.zone ?? "NULL"} distance_m=${r.distance_m}`);
  }
  if (before.length !== 1) {
    say(`   🔴 命中 ${before.length} 行（期望 1）—— 中止，防误改`);
    await pool.end();
    fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    process.exit(1);
  }
  const oldVal = Number(before[0].distance_m);
  say("");
  say(`   ${oldVal} m → ${NEW_DISTANCE_M} m`);

  if (!APPLY) {
    say("");
    say("（加 --apply 写库；加 --revert 回滚）");
    await pool.end();
    fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    return;
  }

  // ── ② 幂等：已是目标值则跳过 ──
  if (oldVal === NEW_DISTANCE_M) {
    say("");
    say(`② 已是 ${NEW_DISTANCE_M} m → 幂等跳过（不写）`);
  } else {
    // ③ 备份（原值）
    const backup = { id: before[0].id, slug: TARGET.slug, station_main: TARGET.stationMain, distance_m: before[0].distance_m, at: new Date().toISOString() };
    fs.writeFileSync(BACKUP, JSON.stringify(backup, null, 2), "utf8");
    say("");
    say(`② 已备份原值 → .verify/${BACKUP.split("/").pop()}（原值 ${before[0].distance_m}）`);

    // ④ 写库
    const n = await applyUpdate();
    say(`③ ✅ 已提交（影响 ${n} 行；fetch_at 更新、吸附距离清空）`);
    if (n !== 1) say(`   🔴 影响行数 ${n} ≠ 1，请人工核查`);
  }

  // ── ⑤ 改后复核 ──
  say("");
  say("④ 改后 SELECT（复核）");
  const after = await selectTarget();
  const ok = after.length === 1 && Number(after[0].distance_m) === NEW_DISTANCE_M;
  for (const r of after) {
    const good = Number(r.distance_m) === NEW_DISTANCE_M;
    say(`   ${good ? "✅" : "🔴"} id=${r.id} ${r.station_main} zone=${r.zone ?? "NULL"} distance_m=${r.distance_m}（目标 ${NEW_DISTANCE_M}）`);
  }

  // ── ⑥ 边界确认：關閘→M1 的 400 未被波及 ──
  const m1 = await pool.query(
    `SELECT sd.distance_m FROM station_walk_distance sd JOIN places p ON p.id = sd.place_id
      WHERE p.slug = 'gate' AND sd.station_main = 'M1' AND COALESCE(sd.zone, '') = ''`,
  );
  const m1v = (m1.rows as { distance_m: string }[])[0]?.distance_m;
  say("");
  say(`⑤ 边界确认：gate→M1 = ${m1v ?? "（无行）"} m（应仍为 400，**未改**）`);

  await pool.end();
  fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
  say("");
  say(ok ? `✅ v2.3.0 迁移完成（日志已写 ${OUT.split("/").pop()}）` : "🔴 复核未通过，请人工检查");
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
