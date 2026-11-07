/**
 * 读写函数演练（scripts/check-xborder-store.ts）—— **在真实 Postgres 上跑一遍，然后整体回滚**
 *
 * ── 为什么需要这一步（没有它，SQL 只能靠人眼审）─────────────────────────
 *   手写的 6 条 SQL（INSERT/ON CONFLICT、UPDATE…void、SELECT、count、DELETE）里
 *   任何列名拼错、约束目标写错、`to_char` 格式写错，都**只在被真正调用那一刻才炸**
 *   —— 而那一刻用户已经在看弹窗了。而纯函数断言（`test-xborder-*.ts`）碰不到 SQL。
 *
 *   Postgres 的 DDL 是**事务性**的 ⇒ 可以：`BEGIN` → 建表 → 用线上同一份读写函数跑一轮
 *   → `ROLLBACK`。**零残留**：不留表、不留索引、不留注释、不留数据，连 BIGSERIAL 的序列
 *   也一起回滚。这是本项目里"验证 SQL 又不留痕"的唯一办法。
 *
 * ── 它实际抓到过什么（两次，都是会静默错的）─────────────────────────────
 *   ① `dayTotal` 误用了 `after=now` 的过滤条件 ⇒ 全部走完时 `dayTotal=0`，
 *      前端会把「今日已无离澳航班」说成「今日暂无航班安排」；
 *   ② `querySailings` 里 `scopeParams` 未定义（TS 没抓到的运行期错误）。
 *
 * ── 与 `npm run verify` 的关系 ────────────────────────────────────────
 *   **不进 verify**：它要连库（verify 必须离线可跑）。跑法与定位：
 *     `npm run check:xborder-store -- --allow-prod`（apply 迁移**之前**跑）
 *
 * ⚠️ 前提：`xborder_*` 两张表**不需要**已经存在 —— 本脚本自己在本事务内建。
 * ⚠️ 生产库可能被平台置为只读 ⇒ 与 `migrate-vehicle-plates.ts:49` 同处置：会话级 off。
 */
import { Pool } from "pg";
import { DDL } from "../db/migrate-v3800";
import { queryFlights, querySailings } from "../src/lib/cross-border/store";
import {
  cleanupXborder,
  upsertFlights,
  upsertSailings,
  voidMissingFlights,
  voidMissingSailings,
} from "../src/lib/cross-border/store-write";
import { classify, TERMINAL_KINDS } from "../src/lib/cross-border/status";
import { addDays, macauDate } from "../src/lib/cross-border/time";
import type { FlightUpsertRow, SailingUpsertRow, XbDir } from "../src/lib/cross-border/types";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 ⇒ 下面报错 */
}

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string) {
  if (ok) {
    pass++;
    console.log("  ✓ " + label);
  } else {
    fail++;
    console.error("  ✗ " + label);
  }
}

const connStr = process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL;

async function main() {
  if (!connStr) {
    console.error("❌ 未找到连接串：请在 .env 配置 DATABASE_URL");
    process.exit(1);
  }
  console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);
  console.log("模式：事务内演练（结束一律 ROLLBACK，零残留）\n");

  const pool = new Pool({
    connectionString: connStr,
    ssl: connStr.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    console.log("── ① 建表（本事务内，DDL 与 migrate-v3800 同源）──");
    for (const step of DDL) await client.query(step.sql);
    console.log(`  ✅ ${DDL.length} 条 DDL 全部通过\n`);

    // 把连接包装成 Pool 形状，喂给**线上同一份**读写函数
    const fakePool = {
      query: (sql: string, params?: unknown[]) => client.query(sql, params),
    } as unknown as Pool;

    const day = "2026-11-06"; // 固定日期：查询按日期作用域，不受"今天"影响
    const flight = (
      over: Partial<FlightUpsertRow> & { flightNo: string; schedTime: string },
    ): FlightUpsertRow => ({
      schedDate: day,
      direction: "dep",
      airlineRaw: "NX",
      placeRaw: "台北",
      gateRaw: null,
      statusRaw: "待航",
      statusKind: "unknown",
      // 默认行「待航」= unknown/非终态 ⇒ false。该字段**不落库**：
      // store-write.ts 的 INSERT 列清单里没有 is_terminal，读取侧由 store.ts 的
      // classify(status_raw) 现算（status_raw 才是唯一真相）。这里只为满足
      // FlightUpsertRow 的必填 boolean，且值必须与本行 status_raw 自洽。
      isTerminal: false,
      ...over,
    });
    const sailing = (over: Partial<SailingUpsertRow> = {}): SailingUpsertRow => ({
      sailDate: day,
      direction: "arr",
      pier: "TP",
      operatorRaw: "金光飛航",
      placeRaw: "香港",
      schedTime: "20:30",
      vesselRaw: "倫敦人名匯",
      vesselTypeRaw: "雙體高速船",
      gateRaw: null,
      statusRaw: "21:30 到達",
      statusKind: "arrived",
      // 「21:30 到達」+ direction=arr ⇒ classify("ferry","arr",...) = arrived/terminal=true。
      isTerminal: true,
      ...over,
    });

    console.log("── ② 读写演练 ──");
    const nF = await upsertFlights(
      [
        // 终态行（已起飞）—— after=now 必须剔除它
        flight({
          flightNo: "NX632",
          schedTime: "08:00",
          gateRaw: "16",
          statusRaw: "已啟航 08:20",
          statusKind: "departed",
          isTerminal: true, // 覆盖工厂默认：已啟航(离澳) = 终态，与 status_raw 自洽
        }),
        // 非终态行 —— 即使时刻是"计划 23:50"，也必须留在最近五班（裁决 1：不做时间硬过滤）
        flight({ flightNo: "NX999", schedTime: "23:50", placeRaw: "香港" }),
      ],
      fakePool,
    );
    check(nF === 2, `upsertFlights 写入 2 行（实际 ${nF}）`);

    const fNow = await queryFlights(
      { schedDate: day, direction: "dep", after: "now", limit: 5 },
      fakePool,
    );
    check(
      fNow.dayTotal === 2,
      `queryFlights(now) dayTotal=2（当日共几班，不随 after 变；实际 ${fNow.dayTotal}）`,
    );
    check(
      fNow.items.length === 1,
      `queryFlights(now) 剔除终态后 1 行（实际 ${fNow.items.length}）`,
    );
    check(
      fNow.items[0]?.flightNo === "NX999",
      `留下的那行是非终态 NX999（实际 ${fNow.items[0]?.flightNo}）`,
    );
    check(
      fNow.items[0]?.isTerminal === false,
      "NX999 的 isTerminal=false（由 status_raw 现算，不读库列）",
    );
    check(
      fNow.items[0]?.schedTime === "23:50",
      `schedTime 序列化为 HH:MM（实际 ${fNow.items[0]?.schedTime}）`,
    );
    check(
      fNow.items[0]?.schedDate === day,
      `schedDate 序列化为 YYYY-MM-DD（实际 ${fNow.items[0]?.schedDate}）`,
    );
    check(typeof fNow.items[0]?.id === "number", "id 由 bigint 字符串转成 number");
    check(
      typeof fNow.items[0]?.lastSeenAt === "string" &&
        (fNow.items[0]?.lastSeenAt ?? "").endsWith("+08:00"),
      "lastSeenAt 带 +08:00 偏移（前端据此算时差）",
    );

    const fDay = await queryFlights(
      { schedDate: day, direction: "dep", after: "day", limit: 200 },
      fakePool,
    );
    check(fDay.items.length === 2, `queryFlights(day) 含终态共 2 行（实际 ${fDay.items.length}）`);
    check(fDay.items[0]?.flightNo === "NX632", "day 分支按 sched_at 升序（08:00 在前）");

    // ── void 机制：正例 + 反例（15 分钟线是它唯一的正确性依赖）──
    const today = macauDate();
    const yesterday = addDays(today, -1) ?? today;
    const tomorrow = addDays(today, 1) ?? today;
    await upsertFlights(
      [
        flight({ schedDate: yesterday, flightNo: "NX1", schedTime: "12:00" }),
        flight({ schedDate: tomorrow, flightNo: "NX2", schedTime: "23:59" }),
      ],
      fakePool,
    );
    // 模拟"本轮没见过它们"
    await client.query(
      `UPDATE xborder_flights SET last_seen_at = now() - interval '1 hour'
        WHERE sched_date IN ($1::date, $2::date)`,
      [yesterday, tomorrow],
    );
    const now2 = new Date();
    const voidPast = await voidMissingFlights(
      { schedDate: yesterday, direction: "dep", roundStart: now2 },
      fakePool,
    );
    const voidFuture = await voidMissingFlights(
      { schedDate: tomorrow, direction: "dep", roundStart: now2 },
      fakePool,
    );
    check(voidPast === 0, `已过时刻的行**不被** void（15 分钟线；实际 ${voidPast}）`);
    check(voidFuture === 1, `未来行缺席本轮 ⇒ void 1 行（实际 ${voidFuture}）`);

    // 复活：又见到同一业务键 ⇒ voided_at 必须清空（否则该班在"当日所有"里永久缺失）
    await upsertFlights(
      [flight({ schedDate: tomorrow, flightNo: "NX2", schedTime: "23:59" })],
      fakePool,
    );
    const revived = (
      await client.query(
        `SELECT voided_at IS NULL AS ok FROM xborder_flights
          WHERE sched_date = $1::date AND direction='dep' AND flight_no='NX2'`,
        [tomorrow],
      )
    ).rows as { ok: boolean }[];
    check(revived[0]?.ok === true, "同一业务键再次出现 ⇒ voided_at 被清空（复活）");

    // ── 船：到港 5 列形态（无闸口）+ 终态剔除 ──
    const nS = await upsertSailings([sailing()], fakePool);
    check(nS === 1, `upsertSailings 写入 1 行（实际 ${nS}）`);
    const sNow = await querySailings(
      { sailDate: day, pier: "TP", direction: "arr", after: "now", limit: 5 },
      fakePool,
    );
    check(sNow.dayTotal === 1, `船 dayTotal=1（实际 ${sNow.dayTotal}）`);
    check(sNow.items.length === 0, `船（到港已到达）被剔除 ⇒ 0 行（实际 ${sNow.items.length}）`);
    const sDay = await querySailings(
      { sailDate: day, pier: "TP", direction: "arr", after: "day", limit: 200 },
      fakePool,
    );
    check(
      sDay.items.length === 1 && sDay.items[0]?.gate === null,
      "day 分支保留该行且 gate=null（到港无闸口列）",
    );
    check(sDay.items[0]?.vessel === "倫敦人名匯", "船名原文照录（含内部无空格形式）");
    const vS = await voidMissingSailings(
      { sailDate: day, pier: "TP", direction: "arr", roundStart: new Date() },
      fakePool,
    );
    check(vS === 0, `船：本轮刚写过 ⇒ void 0 行（实际 ${vS}）`);

    // ── ③ 终态判定一致性：写入侧 status_kind（SQL 谓词）↔ 读取侧 classify()（响应）──
    // 背景（负责人裁决）：is_terminal **不落库**，唯一真相源是 status_raw + classify()。
    //   但 status_kind 是上一轮 upsert 时算好落库的，after=now 的 SQL 用它剔除终态；
    //   响应的 isTerminal 却是读取时由 classify(status_raw) 现算的。
    //   两次计算之间若白名单改过，就会出现「响应说不是终态、SQL 已把它剔除」的静默矛盾。
    // ⇒ 下面比对的是**两个独立来源**：
    //     v.terminal（classify 规则表） === (status_kind ∈ TERMINAL_KINDS[source][dir])（SQL 谓词集合）
    //   刻意**不**断言 `isTerminal === classify(...).terminal` —— 那是同义反复，抓不到漂移。
    // ★ 必须覆盖 departed：它在 airport.dep 是终态、在 airport.arr / ferry.arr 不是终态。
    console.log("\n── ③ 终态判定一致性（status_kind 谓词 ↔ classify 现算）──");
    await upsertFlights(
      [
        flight({
          direction: "dep",
          flightNo: "TT101",
          schedTime: "06:00",
          statusRaw: "已啟航 06:20",
          statusKind: "departed",
          isTerminal: true,
        }),
        flight({
          direction: "dep",
          flightNo: "TT102",
          schedTime: "06:10",
          statusRaw: "停止登機",
          statusKind: "boarding_closed",
          isTerminal: false,
        }),
        flight({
          direction: "arr",
          flightNo: "TT103",
          schedTime: "06:20",
          statusRaw: "已啟航 預計到達 21:30",
          statusKind: "departed",
          isTerminal: false,
        }),
        flight({
          direction: "arr",
          flightNo: "TT104",
          schedTime: "06:30",
          statusRaw: "航班著陸 09:35",
          statusKind: "landed",
          isTerminal: true,
        }),
      ],
      fakePool,
    );
    await upsertSailings(
      [
        sailing({
          direction: "dep",
          pier: "PE",
          schedTime: "06:40",
          statusRaw: "18:03 啟航",
          statusKind: "departed",
          isTerminal: true,
        }),
        sailing({
          direction: "dep",
          pier: "PE",
          schedTime: "06:50",
          statusRaw: "待航",
          statusKind: "pending",
          isTerminal: false,
        }),
        sailing({
          direction: "arr",
          pier: "TP",
          schedTime: "07:00",
          statusRaw: "21:30 到達",
          statusKind: "arrived",
          isTerminal: true,
        }),
        sailing({
          direction: "arr",
          pier: "TP",
          schedTime: "07:10",
          statusRaw: "已啟航",
          statusKind: "departed",
          isTerminal: false,
        }),
      ],
      fakePool,
    );

    const readKinds = async (table: "xborder_flights" | "xborder_sailings") =>
      (
        await client.query(`SELECT direction, status_raw, status_kind FROM ${table}`)
      ).rows as { direction: XbDir; status_raw: string; status_kind: string }[];
    const combos = [
      { source: "airport" as const, rows: await readKinds("xborder_flights") },
      { source: "ferry" as const, rows: await readKinds("xborder_sailings") },
    ];
    let compared = 0;
    const departedVerdicts: string[] = [];
    for (const { source, rows } of combos) {
      for (const dir of ["dep", "arr"] as const) {
        const group = rows.filter((r) => r.direction === dir);
        const bad = group.filter((r) => {
          const v = classify(source, dir, r.status_raw);
          const sqlTerminal = TERMINAL_KINDS[source][dir].includes(r.status_kind);
          if (r.status_kind === "departed")
            departedVerdicts.push(`${source}.${dir}=${v.terminal}`);
          return v.terminal !== sqlTerminal;
        });
        check(
          bad.length === 0,
          `${source}.${dir} 终态一致性 ${group.length} 行全通过` +
            (bad.length
              ? `（不一致 ${bad.length} 行：${JSON.stringify(bad.slice(0, 3))}）`
              : ""),
        );
        compared += group.length;
      }
    }
    check(compared >= 8, `逐行比对了 ${compared} 行（≥ 8 行样本）`);
    check(
      departedVerdicts.includes("airport.dep=true") &&
        departedVerdicts.includes("airport.arr=false"),
      `departed 在 airport.dep=终态、airport.arr=非终态（实际 ${[...new Set(departedVerdicts)].join(", ")}）`,
    );

    // ── 清理边界 ──
    const cleaned = await cleanupXborder("1900-01-01", fakePool);
    check(
      cleaned.flights === 0 && cleaned.sailings === 0,
      `cleanup 边界 1900-01-01 ⇒ 不删任何行（实际 ${cleaned.flights}/${cleaned.sailings}）`,
    );
  } catch (e) {
    console.error("\n❌ 演练失败：", (e as Error).message);
    fail++;
  } finally {
    // 无论如何都回滚：本脚本绝不留下任何对象或数据
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
    console.log("\n↩ 已 ROLLBACK：库里不会留下任何对象与数据");
  }

  console.log(`\n结果：通过 ${pass} · 失败 ${fail}`);
  if (fail) {
    console.error("\n❌ 读写函数与预期不符 —— 先修代码，**别 apply 迁移**。");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
