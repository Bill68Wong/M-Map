/**
 * 「中途总站」判据测试（scripts/test-mid-terminus.ts，v4.1.0）
 * 用法：npm run test:mid-terminus -- cloud   （只读 SELECT；new Client() 直连 5432 会话模式、不经 db-guard、无生产确认门）
 *
 * ── 计数口径（S-04 精化：别把「SQL 原始行」当「主码键」）─────────────
 *   `MID_TERMINUS_SQL` **原始输出 28 行**：同一物理站的不同站台号会各占一行
 *     （`2A|M2/1` 与 `2A|M2/2`）。`loadMidTerminusKeys()` 经 `mainOf` 归一到主码后
 *     这两行合成 `2A|M2` ⇒ **27 个 (线路, 站) 主码键**；`EXPECTED` 恒等于它（27 项）。
 *   ⚠️ 后人若把 SQL 输出的 28 直接当成「应有 28 个键」会误判为漏检，故这里同时
 *     保留两个数字并写明归一关系 —— 不是简单把注释里的 28 改成 27。
 *
 * 断言三件事：
 *   ① 归一后的 **27 个 (线路, 站) 主码键全部命中**（`loadMidTerminusKeys`，SQL 版）；
 *   ② 首/末位的總站**不被误判**（26 路 M95/3、59 路 C654/1、51 路 C690/3 …）；
 *   ③ 运行时用的**纯函数版**（`buildMidTerminusKeys`，输入 = route_stations 聚合行 + stations
 *      站名）与 SQL 版**逐元素相等** —— 两处判据一旦分叉，线上会「看着实现了却查不到」。
 *
 * ⚠️ 27 项主码键清单只存在于**本测试**（回归基线，源自 SQL 原始 28 行归一）。
 *    **实现里不许硬编码**：线路调整后清单必须跟着数据走，而不是让代码记着一份会过期的表。
 */
import { Client } from "pg";
import {
  MID_TERMINUS_SQL,
  buildMidTerminusKeys,
  loadMidTerminusKeys,
  nameIsTerminus,
} from "../src/lib/rebuild/mid-terminus";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 ⇒ 下面会提示 */
}

/** 27 个归一后的主码键（SQL 原始 28 行含站台号，`M2/1`+`M2/2`→`M2`）——
 *  测试基线，不是实现判据；项数必须与 `loadMidTerminusKeys()` 归一结果相等。 */
const EXPECTED = [
  "15T|C690", "16|M20", "16S|M20", "17|M1", "1A|M26", "21A|C654", "25|C654", "26|C654",
  "26A|C654", "27|M1", "27|M2", "27|M209", "29|M18", "2A|M2", "30|M1", "34|M1", "34|M18",
  "3A|M1", "50|C654", "51A|M1", "6A|M147", "8|M209", "8A|M209", "9A|M18", "AP1|M1",
  "N3|C654", "N5|C690",
];

/** 首/末位的總站 —— 必须**不**在中途集合里 */
const NOT_MID = [
  "26|M95",   // 26 路首站 = 末站（M95/3 迴圈總站）
  "59|C654",  // 59 路末站（C654/1）
  "51|C690",  // 51 路首 = 末（C690/3）
  "10|M1",    // 10 路末站（M1/2）—— 關閘總站
  "30|M20",   // 30 路末站（M20/6）—— 青洲坊總站
];

let failed = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failed++;
};

async function main() {
  const target = process.argv[2] as "local" | "cloud" | undefined;
  const raw =
    target === "cloud"
      ? process.env.DATABASE_URL
      : target === "local"
        ? process.env.DATABASE_URL_LOCAL
        : (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL);
  if (!raw) {
    console.error("❌ 未找到连接串（.env 的 DATABASE_URL / DATABASE_URL_LOCAL）");
    process.exit(1);
  }
  const u = new URL(raw);
  if (u.port === "6543") u.port = "5432"; // DDL 口径一致：会话模式
  const client = new Client({
    connectionString: u.toString(),
    ssl: raw.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  const q = async (sql: string, args?: unknown[]) => (await client.query(sql, args)).rows as Record<string, unknown>[];

  try {
    const sqlKeys = await loadMidTerminusKeys((sql) => q(sql));
    const have = new Set(sqlKeys);

    console.log(`\n① SQL 版判据：命中 ${have.size} 个 (线路, 站) 对`);
    for (const k of EXPECTED) ok(have.has(k), `命中 ${k}`);
    ok(have.size === EXPECTED.length, `集合大小 = ${EXPECTED.length}`, `实际 ${have.size}`);
    const extra = [...have].filter((k) => !EXPECTED.includes(k));
    if (extra.length) console.log(`  ℹ️ 清单外新增：${extra.join(", ")}（数据变更请同步测试基线）`);

    console.log(`\n② 首/末位的總站不得误判`);
    for (const k of NOT_MID) ok(!have.has(k), `不误判 ${k}`);

    console.log(`\n③ 纯函数版（运行时路径）与 SQL 版逐元素相等`);
    const stopsRows = (
      await q(
        `SELECT r.code AS route, rs.dsat_dir AS dir,
                array_agg(rs.station_code ORDER BY rs.seq) AS stops
           FROM route_stations rs JOIN routes r ON r.id = rs.route_id
          WHERE r.kind = 'bus'
          GROUP BY r.code, rs.dsat_dir`,
      )
    ).map((r) => ({ route: String(r.route), stops: (r.stops as string[]) ?? [] }));
    const stationRows = await q(`SELECT code, name_tc FROM stations`);
    const nameOf = new Map(stationRows.map((r) => [String(r.code), (r.name_tc as string | null) ?? null]));
    const pure = buildMidTerminusKeys(stopsRows, nameOf);
    const onlySql = [...have].filter((k) => !pure.has(k));
    const onlyPure = [...pure].filter((k) => !have.has(k));
    ok(onlySql.length === 0 && onlyPure.length === 0,
      `纯函数 ${pure.size} ≡ SQL ${have.size}`,
      onlySql.length || onlyPure.length ? `仅SQL ${onlySql.slice(0, 5).join(",")} · 仅纯函数 ${onlyPure.slice(0, 5).join(",")}` : "");

    console.log(`\n④ 站名判据`);
    ok(nameIsTerminus("聯生圓形地總站") && nameIsTerminus("青洲总站"), "繁/简两种写法都命中");
    ok(!nameIsTerminus("關閘廣場"), "普通站名不命中");

    // 数据快照（人工核对用）
    const snap = await q(
      `SELECT route, station_code FROM (${MID_TERMINUS_SQL}) x ORDER BY route, station_code`,
    ).then((rs) => rs.slice(0, 5).map((r) => `${r.route}|${r.station_code}`).join(" · "));
    console.log(`\n  快照（前 5）：${snap}`);
  } finally {
    await client.end();
  }

  console.log(failed ? `\n❌ ${failed} 条断言失败` : `\n✅ 全部断言通过`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("❌ 测试失败：", e);
  process.exit(1);
});
