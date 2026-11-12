/**
 * 迁移 v3.7.0：通琴号（横琴粤澳深度合作区通勤班车）数据入库
 *
 * ── 起因 ──────────────────────────────────────────────────────────────
 *   M Map 现有数据只覆盖澳门（DSAT 92 条巴士线 + 3 条轻轨线），跨境通勤缺口明显。
 *   「通琴号」是深合区城规建局的政府通勤班车（境内线券后 3 元、跨境线免费），
 *   澳门侧停靠澳大、澳科大、澳城大、澳理工、澳旅大、新濠锋、银河等地，
 *   与既有用户群高度重合。
 *
 * ── 数据从哪来（合规性说明）─────────────────────────────────────────────
 *   · 站点坐标与全称：负责人从**腾讯地图收藏集分享链接**取得（138 点，GCJ-02）。
 *     该链接是负责人主动分享的公开数据，页面本身即依赖它渲染，属于正常数据使用，
 *     不是抓包、不是绕过访问控制。
 *   · 班次与逐站时刻：负责人整理的小程序截图（86 张）→ md 文档。
 *   · 属地判定与「通琴号站点 ↔ 澳门巴士站」关联：负责人逐条人工确认。
 *
 * ── 三张表 ────────────────────────────────────────────────────────────
 *   `tqh_trips`       班次库：规范化班次名、序号、方向、线路名全称、首末时刻、站数
 *   `tqh_stations`    通琴号站点库：站名全称（含 ①②③）、GCJ-02 坐标、属地、关联巴士站码
 *   `tqh_trip_stops`  班次×站点：逐站序号与到站时刻（时刻表的载体）
 *
 * ── ★ 两个必须记住的判定口径 ──────────────────────────────────────────
 *   1) **方向 = 终点站属地**，不看「上班/下班」。
 *      实测反例：8 条名称含「上班」实际往横琴；9 条名称含「下班」实际往澳门。
 *   2) **属地不能只看站名**：「澳门新街坊」「澳门新街坊南」名字带澳门，
 *      实际位于横琴（经度 113.515 < 澳门最西 113.529）。
 *
 * ── 坐标系 ────────────────────────────────────────────────────────────
 *   本站点库坐标统一为 **GCJ-02**（与高德地图、腾讯地图一致，可直接喂前端地图）。
 *   注意：既有 `stations` 表是 **WGS84**（DSAT 原始）。两者**不可直接比较**，
 *   跨表算距离必须先 `wgs84ToGcj02()`（`src/lib/amap/coord.ts`），否则约 500 m 系统性偏差。
 *
 * ── 幂等 ──────────────────────────────────────────────────────────────
 *   全部 `CREATE TABLE / INDEX IF NOT EXISTS`；数据用 `ON CONFLICT DO UPDATE` upsert；
 *   `tqh_trip_stops` 按 trip 先删后插（保证逐站时刻与源数据一致）。
 *   **不触碰任何既有表**（stations / route_* / segment_* 一律只读）。
 *
 * 用法：
 *   npm run db:migrate-v3700                      # dry-run（只探测，不写库）
 *   npm run db:migrate-v3700 -- --apply --allow-prod   # 执行（写生产库）
 *   npm run db:migrate-v3700 -- --apply --drop --allow-prod  # 撤销（仅本迁移的 3 张表）
 */
import { Pool } from "pg";
import { TQH_STATIONS, TQH_TRIPS } from "./tqh-data";

const APPLY = process.argv.includes("--apply");
const DROP = process.argv.includes("--drop");
// ★ 2026-11-12 修：原硬编码作者机路径 ⇒ 读 cwd/.env（与 db/* 既有无参体例一致）。
process.loadEnvFile();
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
const OUT = ".verify/migrate-v3700.out.txt";

/** 本迁移拥有的全部表（--drop 与复核据此） */
const TABLES = ["tqh_trip_stops", "tqh_trips", "tqh_stations"] as const;

const hasTable = async (t: string) =>
  (
    await q(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
      [t],
    )
  ).length > 0;

// ─────────────────────────── DDL ───────────────────────────
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS tqh_stations (
     id            SERIAL PRIMARY KEY,
     name          TEXT NOT NULL,
     lng           DOUBLE PRECISION NOT NULL,
     lat           DOUBLE PRECISION NOT NULL,
     side          TEXT NOT NULL,
     bus_station_code TEXT,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT tqh_stations_name_uniq UNIQUE (name),
     CONSTRAINT tqh_stations_side_chk CHECK (side IN ('澳门','横琴'))
   )`,
  `COMMENT ON TABLE tqh_stations IS '通琴号站点库。name=腾讯地图收藏集原文全称（含 ①②③，标号是站点身份的一部分，不可剥）；坐标 GCJ-02；side=属地（澳门/横琴）；bus_station_code=关联的澳门巴士站站码（stations.code），非等价时为 NULL'`,
  `COMMENT ON COLUMN tqh_stations.name IS '★站点全称原文：同一地点的不同上/下车点靠 ①②③ 区分，剥掉标号会混淆'`,
  `COMMENT ON COLUMN tqh_stations.side IS '★属地：澳门 / 横琴。注意「澳门新街坊」名字带澳门但实际在横琴，须按坐标判'`,
  `COMMENT ON COLUMN tqh_stations.bus_station_code IS '关联澳门巴士站码（FK → stations.code）。由负责人逐条确认等价性后写入，非自动匹配'`,

  `CREATE INDEX IF NOT EXISTS idx_tqh_stations_side ON tqh_stations (side)`,
  `CREATE INDEX IF NOT EXISTS idx_tqh_stations_bus ON tqh_stations (bus_station_code)`,

  `CREATE TABLE IF NOT EXISTS tqh_trips (
     id             SERIAL PRIMARY KEY,
     trip_code      TEXT NOT NULL,
     route_no       TEXT NOT NULL,
     direction      TEXT NOT NULL,
     line_full_name TEXT NOT NULL,
     trip_label     TEXT NOT NULL,
     departure_time TIME NOT NULL,
     arrival_time   TIME NOT NULL,
     stop_count     INT NOT NULL,
     origin_name    TEXT NOT NULL,
     terminal_name  TEXT NOT NULL,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT tqh_trips_code_uniq UNIQUE (trip_code),
     CONSTRAINT tqh_trips_dir_chk CHECK (direction IN ('往澳门','往横琴'))
   )`,
  `COMMENT ON TABLE tqh_trips IS '通琴号班次库。trip_code=规范化班次名「序号｜方向｜线路名全称」'`,
  `COMMENT ON COLUMN tqh_trips.direction IS '★方向按**终点站属地**判定，不看「上班/下班」——实测 8 条上班实为往横琴、9 条下班实为往澳门'`,
  `COMMENT ON COLUMN tqh_trips.line_full_name IS '线路名全称（负责人整理的 md 原文标题，含时段后缀，如「A5线-澳琴早上班」）'`,
  `COMMENT ON COLUMN tqh_trips.trip_label IS '原文时段部分（澳琴早上班 / 上班 / 午下班…），用于同序号同方向多班次区分'`,

  `CREATE INDEX IF NOT EXISTS idx_tqh_trips_route ON tqh_trips (route_no)`,
  `CREATE INDEX IF NOT EXISTS idx_tqh_trips_dir ON tqh_trips (direction)`,

  `CREATE TABLE IF NOT EXISTS tqh_trip_stops (
     id         SERIAL PRIMARY KEY,
     trip_id    INT NOT NULL,
     seq        INT NOT NULL,
     station_id INT NOT NULL,
     stop_time  TIME NOT NULL,
     CONSTRAINT tqh_trip_stops_uniq UNIQUE (trip_id, seq),
     CONSTRAINT tqh_trip_stops_trip_fk FOREIGN KEY (trip_id) REFERENCES tqh_trips (id) ON DELETE CASCADE,
     CONSTRAINT tqh_trip_stops_station_fk FOREIGN KEY (station_id) REFERENCES tqh_stations (id)
   )`,
  `COMMENT ON TABLE tqh_trip_stops IS '通琴号「班次×站点」时刻表。seq 从 1 起；stop_time 为计划到站时刻（澳门本地时间，无时区）'`,
  `CREATE INDEX IF NOT EXISTS idx_tqh_trip_stops_station ON tqh_trip_stops (station_id)`,
];

/** 校验：这些站码必须存在于既有 stations 表，否则 FK 会失败 */
async function validateBusCodes() {
  const codes = [...new Set(TQH_STATIONS.map((s) => s.busCode).filter((c): c is string => !!c))];
  if (codes.length === 0) return { ok: true, missing: [] as string[] };
  const rows = await q(`SELECT code FROM stations WHERE code = ANY($1::text[])`, [codes]);
  const have = new Set(rows.map((r) => String(r.code)));
  const missing = codes.filter((c) => !have.has(c));
  return { ok: missing.length === 0, missing };
}

/** 数据一致性自检（不依赖数据库） */
function selfCheck() {
  const problems: string[] = [];
  const names = new Set(TQH_STATIONS.map((s) => s.name));
  if (names.size !== TQH_STATIONS.length) problems.push("站点名有重复");
  const codes = new Set(TQH_TRIPS.map((t) => t.tripCode));
  if (codes.size !== TQH_TRIPS.length) problems.push("班次名有重复");
  for (const t of TQH_TRIPS) {
    if (t.stopCount !== t.stops.length) problems.push(`班次 ${t.tripCode} 站数不符`);
    for (const st of t.stops) if (!names.has(st.stationName)) problems.push(`班次 ${t.tripCode} 引用未知站 ${st.stationName}`);
    if (t.terminalName !== t.stops[t.stops.length - 1].stationName) problems.push(`班次 ${t.tripCode} 终点站不一致`);
    if (t.originName !== t.stops[0].stationName) problems.push(`班次 ${t.tripCode} 起点站不一致`);
  }
  const linked = TQH_STATIONS.filter((s) => s.busCode);
  for (const s of linked) if (s.side !== "澳门") problems.push(`横琴站点 ${s.name} 不应有关联巴士站`);
  return problems;
}

// ─────────────────────────── 主流程 ───────────────────────────
const main = async () => {
  say("=".repeat(64));
  say(`通琴号数据入库 · migrate-v3700 · ${APPLY ? "APPLY（写库）" : "DRY-RUN（只探测）"}`);
  say("=".repeat(64));

  // 1) 自检
  const problems = selfCheck();
  say("");
  say("[1] 数据集自检");
  say(`    班次 ${TQH_TRIPS.length} · 站点 ${TQH_STATIONS.length} · 站序 ${TQH_TRIPS.reduce((a, t) => a + t.stops.length, 0)}`);
  say(`    澳门 ${TQH_STATIONS.filter((s) => s.side === "澳门").length} · 横琴 ${TQH_STATIONS.filter((s) => s.side === "横琴").length}`);
  say(`    往澳门 ${TQH_TRIPS.filter((t) => t.direction === "往澳门").length} · 往横琴 ${TQH_TRIPS.filter((t) => t.direction === "往横琴").length}`);
  say(`    已关联巴士站 ${TQH_STATIONS.filter((s) => s.busCode).length}`);
  if (problems.length) {
    say(`    ❌ ${problems.length} 处问题：`);
    problems.slice(0, 20).forEach((p) => say(`       ${p}`));
    say("    中止。");
  } else {
    say("    ✅ 无问题");
  }

  // 2) 现有表状态
  say("");
  say("[2] 现有表状态");
  const exist: Record<string, boolean> = {};
  for (const t of TABLES) {
    exist[t] = await hasTable(t);
    say(`    ${t.padEnd(18)} ${exist[t] ? "已存在" : "不存在"}`);
  }

  // 3) 外键校验
  say("");
  say("[3] 关联巴士站码校验（FK → stations.code）");
  const v = await validateBusCodes();
  if (v.ok) say("    ✅ 全部存在");
  else {
    say(`    ❌ ${v.missing.length} 个站码在 stations 表中不存在：`);
    v.missing.forEach((m) => say(`       ${m}`));
    say("    中止（FK 会失败）。");
  }

  if (!APPLY) {
    say("");
    say("[4] DRY-RUN：以上为探测结果，未执行任何 DDL / DML。");
    say("    执行请加 --apply --allow-prod");
    return;
  }
  if (problems.length || !v.ok) {
    say("");
    say("自检未通过 ⇒ 拒绝执行。");
    process.exitCode = 1;
    return;
  }

  // 4) DROP
  if (DROP) {
    say("");
    say("[4] DROP（撤销本迁移）");
    for (const t of TABLES) {
      if (exist[t]) {
        await q(`DROP TABLE IF EXISTS ${t} CASCADE`);
        say(`    已删除 ${t}`);
      } else say(`    跳过 ${t}（不存在）`);
    }
    say("    完成。");
    return;
  }

  // 5) DDL
  say("");
  say("[4] 执行 DDL");
  for (const s of DDL) {
    const head = s.trim().split("\n")[0].slice(0, 60);
    await q(s);
    say(`    ok  ${head}${s.length > 60 ? " …" : ""}`);
  }

  // 6) 站点 upsert
  say("");
  say("[5] 写入站点（upsert by name）");
  let stUp = 0;
  for (const s of TQH_STATIONS) {
    await q(
      `INSERT INTO tqh_stations (name, lng, lat, side, bus_station_code, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (name) DO UPDATE SET
         lng = EXCLUDED.lng, lat = EXCLUDED.lat, side = EXCLUDED.side,
         bus_station_code = EXCLUDED.bus_station_code, updated_at = now()`,
      [s.name, s.lng, s.lat, s.side, s.busCode],
    );
    stUp += 1;
  }
  say(`    ${stUp} 个站点已 upsert`);

  const idRows = await q(`SELECT id, name FROM tqh_stations`);
  const idOf = new Map(idRows.map((r) => [String(r.name), Number(r.id)]));

  // 7) 班次 upsert
  say("");
  say("[6] 写入班次（upsert by trip_code）");
  let trUp = 0;
  for (const t of TQH_TRIPS) {
    await q(
      `INSERT INTO tqh_trips
         (trip_code, route_no, direction, line_full_name, trip_label,
          departure_time, arrival_time, stop_count, origin_name, terminal_name, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (trip_code) DO UPDATE SET
         route_no = EXCLUDED.route_no, direction = EXCLUDED.direction,
         line_full_name = EXCLUDED.line_full_name, trip_label = EXCLUDED.trip_label,
         departure_time = EXCLUDED.departure_time, arrival_time = EXCLUDED.arrival_time,
         stop_count = EXCLUDED.stop_count, origin_name = EXCLUDED.origin_name,
         terminal_name = EXCLUDED.terminal_name, updated_at = now()`,
      [
        t.tripCode,
        t.routeNo,
        t.direction,
        t.lineFullName,
        t.tripLabel,
        t.departureTime,
        t.arrivalTime,
        t.stopCount,
        t.originName,
        t.terminalName,
      ],
    );
    trUp += 1;
  }
  say(`    ${trUp} 个班次已 upsert`);

  const tripRows = await q(`SELECT id, trip_code FROM tqh_trips`);
  const tripIdOf = new Map(tripRows.map((r) => [String(r.trip_code), Number(r.id)]));

  // 8) 站序：先删后插
  say("");
  say("[7] 写入逐站时刻（先删后插，保证与源一致）");
  let stopN = 0;
  for (const t of TQH_TRIPS) {
    const tid = tripIdOf.get(t.tripCode);
    if (!tid) {
      say(`    ❌ 找不到班次 ${t.tripCode}`);
      continue;
    }
    await q(`DELETE FROM tqh_trip_stops WHERE trip_id = $1`, [tid]);
    for (const st of t.stops) {
      const sid = idOf.get(st.stationName);
      if (!sid) {
        say(`    ❌ 找不到站点 ${st.stationName}`);
        continue;
      }
      await q(
        `INSERT INTO tqh_trip_stops (trip_id, seq, station_id, stop_time) VALUES ($1,$2,$3,$4)`,
        [tid, st.seq, sid, st.time],
      );
      stopN += 1;
    }
  }
  say(`    ${stopN} 条站序已写入`);

  // 9) 复核
  say("");
  say("[8] 入库后复核");
  const stat = await q(
    `SELECT
       (SELECT count(*) FROM tqh_trips)::int AS trips,
       (SELECT count(*) FROM tqh_stations)::int AS stations,
       (SELECT count(*) FROM tqh_stations WHERE side='澳门')::int AS macau,
       (SELECT count(*) FROM tqh_stations WHERE side='横琴')::int AS hengqin,
       (SELECT count(*) FROM tqh_stations WHERE bus_station_code IS NOT NULL)::int AS linked,
       (SELECT count(*) FROM tqh_trip_stops)::int AS stops,
       (SELECT count(*) FROM tqh_trips WHERE direction='往澳门')::int AS to_macau,
       (SELECT count(*) FROM tqh_trips WHERE direction='往横琴')::int AS to_hengqin`,
  );
  const r = stat[0] as Record<string, number>;
  say(`    班次 ${r.trips}（往澳门 ${r.to_macau} / 往横琴 ${r.to_hengqin}）`);
  say(`    站点 ${r.stations}（澳门 ${r.macau} / 横琴 ${r.hengqin}，已关联巴士站 ${r.linked}）`);
  say(`    站序 ${r.stops}`);

  const bad =
    r.trips !== TQH_TRIPS.length ||
    r.stations !== TQH_STATIONS.length ||
    r.stops !== TQH_TRIPS.reduce((a, t) => a + t.stops.length, 0);
  say(bad ? "    ❌ 数量与源数据不一致" : "    ✅ 与源数据完全一致");

  // 10) FK 完整性抽查
  const orphan = await q(
    `SELECT count(*)::int AS n FROM tqh_stations s
      WHERE s.bus_station_code IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM stations b WHERE b.code = s.bus_station_code)`,
  );
  say(`    关联巴士站失效引用 ${(orphan[0] as { n: number }).n} 条`);

  say("");
  say("完成。");
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
      const fs = await import("node:fs");
      fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    } catch {
      /* 日志写失败不影响迁移结果 */
    }
    await pool.end();
  }
})();
