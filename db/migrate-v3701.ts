/**
 * 迁移 v3.7.1：通琴号站点「同物理点」互相关联
 *
 * ── 起因 ──────────────────────────────────────────────────────────────
 *   通琴号的站名里，①②③ 是 App 的「上/下车点」标记。同一地点的两个上下车点
 *   会被拆成两条记录（如「澳门科技大学南门（新濠天地）① / ②」），坐标只差 1 米。
 *   两条记录**都必须保留**（不同班次方向用到不同标号），但上层需要知道
 *   「这两条其实是同一个物理位置」，否则界面上会出现重复站点。
 *
 * ── 方案：加自引用外键 `same_place_group` ──────────────────────────────
 *   同一个物理点的多条记录共享同一个「组 id」（= 该组第一条记录的 id）。
 *   单条独立站点此列为 NULL。
 *
 *   为什么不用「多对多关联表」：
 *     本场景是**等价关系**（互相同点、传递），用组 id 一列即可表达，
 *     查询也简单（`WHERE same_place_group = X`）；关联表会引入不必要的连接。
 *
 *   为什么不删重复记录：
 *     ①② 是不同班次的上/下车点标记，删掉会丢失「哪个班次在哪个点上下客」的信息。
 *
 * ── 幂等 ──────────────────────────────────────────────────────────────
 *   `ADD COLUMN IF NOT EXISTS` + `UPDATE ... WHERE`（按站名精确匹配，可重复执行）。
 *
 * 用法：
 *   npm run db:migrate-v3701                              # dry-run
 *   npm run db:migrate-v3701 -- --apply --allow-prod      # 执行
 *   npm run db:migrate-v3701 -- --apply --drop --allow-prod  # 撤销（仅删列）
 */
import { Pool } from "pg";

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
const OUT = "D:/Projects/University/Studio/musttoukou/.verify/migrate-v3701.out.txt";

/**
 * 同物理点分组（负责人逐条确认后加入）
 *
 * 每条 = 一组站名的完整列表；执行时取该组内**最小 id 那条**作为组 id。
 * 只写负责人明确确认过的组；未确认的（横琴检察院、新濠锋、银河酒店、保利）留待后续。
 */
const SAME_PLACE_GROUPS: { names: string[]; note: string }[] = [
  {
    names: ["澳门科技大学南门（新濠天地）①", "澳门科技大学南门（新濠天地）②"],
    note: "负责人 2026-11-05 21:40 确认：①② 为同一物理位置的两个上/下车点（坐标仅差 1 m）",
  },
];

const main = async () => {
  say("=".repeat(64));
  say(`通琴号站点「同物理点」关联 · migrate-v3701 · ${APPLY ? "APPLY" : "DRY-RUN"}`);
  say("=".repeat(64));

  // 1) 列是否存在
  const colExists =
    (
      await q(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='tqh_stations' AND column_name='same_place_group'`,
      )
    ).length > 0;
  say("");
  say(`[1] 列 same_place_group：${colExists ? "已存在" : "不存在"}`);

  // 2) 预检每组站名都存在
  say("");
  say("[2] 预检分组站名");
  const resolved: { groupId: number; names: { id: number; name: string }[]; note: string }[] = [];
  let preOk = true;
  for (const g of SAME_PLACE_GROUPS) {
    const rows = await q(`SELECT id, name FROM tqh_stations WHERE name = ANY($1::text[]) ORDER BY id`, [g.names]);
    const found = rows.map((r) => ({ id: Number(r.id), name: String(r.name) }));
    const missing = g.names.filter((n) => !found.some((f) => f.name === n));
    if (missing.length) {
      say(`    ❌ 组「${g.names[0]}…」缺少站名：${missing.join("、")}`);
      preOk = false;
      continue;
    }
    const groupId = Math.min(...found.map((f) => f.id));
    say(`    ✅ 组 ${groupId}：${found.map((f) => `${f.id}=${f.name}`).join(" · ")}`);
    resolved.push({ groupId, names: found, note: g.note });
  }

  if (!APPLY) {
    say("");
    say("[3] DRY-RUN：未执行任何 DDL / DML。执行请加 --apply --allow-prod");
    return;
  }
  if (!preOk) {
    say("");
    say("预检失败 ⇒ 拒绝执行。");
    process.exitCode = 1;
    return;
  }

  // 3) DROP
  if (DROP) {
    say("");
    say("[3] DROP：删除 same_place_group 列");
    await q(`ALTER TABLE tqh_stations DROP COLUMN IF EXISTS same_place_group`);
    say("    已删除");
    return;
  }

  // 4) DDL
  say("");
  say("[3] 加列");
  if (!colExists) {
    await q(`ALTER TABLE tqh_stations ADD COLUMN same_place_group INT`);
    say("    ok  ADD COLUMN same_place_group INT");
  } else say("    跳过（已存在）");

  await q(
    `COMMENT ON COLUMN tqh_stations.same_place_group IS
       '★同一物理点的分组 id = 组内最小站 id。同组的多个记录是同地点的不同上/下车点（①②③），必须都保留；单条独立站点为 NULL'`,
  );
  say("    ok  COMMENT");

  await q(
    `CREATE INDEX IF NOT EXISTS idx_tqh_stations_place_group ON tqh_stations (same_place_group)
       WHERE same_place_group IS NOT NULL`,
  );
  say("    ok  CREATE INDEX（部分索引，仅非 NULL）");

  // 5) 写入分组
  say("");
  say("[4] 写入分组");
  let updated = 0;
  for (const g of resolved) {
    for (const n of g.names) {
      await q(`UPDATE tqh_stations SET same_place_group = $1, updated_at = now() WHERE id = $2`, [
        g.groupId,
        n.id,
      ]);
      updated += 1;
    }
    say(`    组 ${g.groupId} 已标记 ${g.names.length} 条（${g.note}）`);
  }
  say(`    共更新 ${updated} 条`);

  // 6) 复核
  say("");
  say("[5] 复核");
  const rows = await q(
    `SELECT id, name, same_place_group, lng, lat
       FROM tqh_stations
      WHERE same_place_group IS NOT NULL
      ORDER BY same_place_group, id`,
  );
  rows.forEach((r) =>
    say(`    [组 ${r.same_place_group}] id=${r.id}  ${r.name}  (${r.lng},${r.lat})`),
  );

  const nullCnt = await q(`SELECT count(*)::int AS n FROM tqh_stations WHERE same_place_group IS NULL`);
  const grpCnt = await q(
    `SELECT count(DISTINCT same_place_group)::int AS n FROM tqh_stations WHERE same_place_group IS NOT NULL`,
  );
  say(`    独立站点（NULL）${(nullCnt[0] as { n: number }).n} 条 · 分组 ${(grpCnt[0] as { n: number }).n} 个`);

  // 7) 组内自检：同组必须是「两边都有值」且组 id 确实是组内最小
  const bad = await q(
    `SELECT g.same_place_group, min(g.id) AS mn, count(*)::int AS c
       FROM tqh_stations g
      WHERE g.same_place_group IS NOT NULL
      GROUP BY g.same_place_group
     HAVING min(g.id) <> g.same_place_group`,
  );
  say(bad.length === 0 ? "    ✅ 组 id 均等于组内最小 id" : `    ❌ ${bad.length} 个组 id 不等于最小 id`);

  say("");
  say("完成。");
};

/* tsx 以 CJS 打包，不支持顶层 await ⇒ IIFE */
void (async () => {
  try {
    await main();
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    try {
      const fs = await import("node:fs");
      fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    } catch {
      /* 日志写失败不影响结果 */
    }
    await pool.end();
  }
})();
