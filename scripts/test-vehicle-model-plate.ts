/**
 * `?plate=` / `?code=` 取数断言（scripts/test-vehicle-model-plate.ts）
 *
 * ── 守的是什么 ────────────────────────────────────────────────────────
 *   `load-vehicle-model.ts` 是全链路**唯一**碰 `pg` 的一层，也是**唯一**决定
 *   「取哪一行 `vehicle_plates`」的地方。取错行的后果不是报错，是**同一台车
 *   今天显示 A 车型、明天显示 B 车型，且不留痕**：
 *
 *   ① `plate` 是 PRIMARY KEY，`bus_code` 只是普通索引（`db/migrate-vehicle-plates.ts:57` vs `:73`）
 *      ⇒ 按 `bus_code` 查**物理上可能多行**，必须靠 SQL 给确定性排序；
 *   ② `plate` 与 `code` 都给时**必须 `plate` 优先**，否则前端传了主键却按索引查；
 *   ③ 响应里的 `busCode` 必须是**行里的 `bus_code`**，不能回显请求参数
 *      （按 plate 查时请求里根本没有 code，回显就成了空串）；
 *   ④ `bus_type` 要一路透到 `category`，否则档②「无型号但有类别」的 354 台又退化。
 *
 * ── 为什么不连数据库 ──────────────────────────────────────────────────
 *   真库只会在"数据恰好唯一"时通过 —— 而这套逻辑要防的**恰恰是数据不唯一**。
 *   故用内存桩替换 `Pool`：桩能稳定造出「同 `bus_code` 两行」这种真库上罕见的状态，
 *   这是真库做不到的。⇒ 本脚本进 `npm run verify`（不需要 .env、不需要已跑迁移）。
 *
 *   ⚠️ 排序的**确定性由 PG 保证**，内存桩复现不了 ⇒ 这部分断言落在 **SQL 契约**上
 *      （必须含 `ORDER BY plate` / `LIMIT 1`，且**不得**出现 `last_seen_at` /
 *      `calibrated_at`）。这不是"贴着实现写"：那两个列名一旦出现就是**语义错误**
 *      （前者是"上次有人查它所在线路的时间"、后者是 model 有无的镜像），
 *      断言它们不出现，正是防"看起来很合理"的排序替换。
 *
 * 运行：npm run test:vehicle-model-plate
 */
import type { Pool } from "pg";
import { BUS_MODEL_SPECS } from "../db/bus-models-data";
import type { BusModelSpec } from "../src/lib/vehicle/model-shared";
import { loadVehicleModel } from "../src/lib/vehicle/load-vehicle-model";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    fail++;
    console.error("  ✗ " + msg);
  }
}
function assertEq<T>(got: T, want: T, msg: string) {
  assert(got === want, `${msg}（实际 ${String(got)} / 预期 ${String(want)}）`);
}

/* ══════════════════════════════════════════════════════════════════════
 * 内存桩 Pool
 * ══════════════════════════════════════════════════════════════════════ */

/** 桩里的一行 `vehicle_plates`（= 本接口真正读到的列） */
interface Row {
  plate: string;
  bus_code: string | null;
  model: string | null;
  company: string | null;
  bus_type: string | null;
}

const toSpecRow = (s: BusModelSpec) => ({
  spec_key: s.specKey,
  model_code: s.modelCode,
  company: s.company,
  maker: s.maker,
  display_name: s.displayName,
  seats: s.seats,
  seats_raw: s.seatsRaw,
  standing: s.standing,
  wheelchair: s.wheelchair,
  length_mm: s.lengthMm,
  width_mm: s.widthMm,
  height_mm: s.heightMm,
  style: s.style,
  bus_code_prefix: s.busCodePrefix,
  bus_code_from: s.busCodeFrom,
  bus_code_to: s.busCodeTo,
  bus_code_range_raw: s.busCodeRangeRaw,
  remark: s.remark,
  source: s.source,
  confidence: s.confidence,
});

interface Call {
  sql: string;
  params: unknown[];
}

/**
 * 造一个只认这 3 条 SQL 的桩池。
 *
 * 桩**故意不实现** `ORDER BY`：它把多行原样返回、由 SQL 的 `LIMIT 1` 语义决定取哪行
 * —— 若实现漏写 `ORDER BY plate`，真库上会随机取，桩这边断言的是 SQL 文本（见文件头）。
 */
function stubPool(plan: { byPlate: Record<string, Row>; byCode: Record<string, Row[]> }) {
  const calls: Call[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    const s = String(sql);
    calls.push({ sql: s, params });
    if (/FROM vehicle_plates WHERE plate = \$1/.test(s)) {
      const row = plan.byPlate[String(params[0])];
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/FROM vehicle_plates WHERE bus_code = \$1/.test(s)) {
      // 多行时按 plate 升序交付 —— **模拟 `ORDER BY plate`**，
      // 但真正保证确定性的是被测 SQL 里那半句（见 [E] 组断言）
      const rows = [...(plan.byCode[String(params[0])] ?? [])].sort((a, b) =>
        a.plate.localeCompare(b.plate),
      );
      return { rows: rows.slice(0, 1), rowCount: rows.length };
    }
    if (/FROM bus_models/.test(s)) return { rows: BUS_MODEL_SPECS.map(toSpecRow), rowCount: 17 };
    throw new Error("桩池收到预期外的 SQL：" + s);
  };
  return { pool: { query } as unknown as Pool, calls };
}

const row = (over: Partial<Row> & { plate: string }): Row => ({
  bus_code: null,
  model: null,
  company: null,
  bus_type: null,
  ...over,
});

const plateCalls = (calls: Call[]) => calls.filter((c) => /vehicle_plates/.test(c.sql));
const codeCall = (calls: Call[]) => plateCalls(calls).find((c) => /bus_code = \$1/.test(c.sql));

async function main() {
  console.log("车型取数断言（load-vehicle-model.ts · 五组）\n");

  /* ══════════════════════════════════════════════════════════════
   * A. `plate` 优先于 `code`
   * ══════════════════════════════════════════════════════════════ */
  console.log("A. plate 优先");
  {
    const { pool, calls } = stubPool({
      byPlate: {
        "AA-77-59": row({
          plate: "AA-77-59",
          bus_code: "HE247",
          model: "KLQ6106GHEV1",
          company: "transmac",
          bus_type: "2",
        }),
      },
      byCode: {
        E9999: [
          row({ plate: "BB-00-01", bus_code: "E9999", model: "LCK6113SHEVG", company: "tcm" }),
        ],
      },
    });
    const r = await loadVehicleModel({ plate: "AA-77-59", code: "E9999" }, pool);
    assertEq(
      r.busCode,
      "HE247",
      "两者都给 ⇒ 用 plate 那行（busCode = 行里的 HE247，不是入参 E9999）",
    );
    assertEq(r.model?.code, "KLQ6106GHEV1", "两者都给 ⇒ 型号取自 plate 那行");
    assertEq(r.via, "db", "两者都给 ⇒ via=db");
    assertEq(r.company, "transmac", "两者都给 ⇒ 运营商取自 plate 那行");
    assertEq(r.category, "中巴", "两者都给 ⇒ 类别取自 plate 那行的 bus_type");
    assertEq(
      plateCalls(calls).length,
      1,
      "两者都给且 plate 命中 ⇒ 只为 plate 发 1 条查询（不再查 code）",
    );
    assertEq(plateCalls(calls)[0].params[0], "AA-77-59", "查询参数是 plate（不是 code）");
  }

  // 车牌归一：小写 + 空白也要命中（与 `vehicle-plates.ts#normalizePlate` 同口径）
  {
    const { pool } = stubPool({
      byPlate: { "AA-77-59": row({ plate: "AA-77-59", bus_code: "HE247", model: "KLQ6106GHEV1" }) },
      byCode: {},
    });
    const r = await loadVehicleModel({ plate: " aa-77-59 ", code: null }, pool);
    assertEq(r.busCode, "HE247", "车牌大小写/空白归一后命中（aa-77-59 ⇒ AA-77-59）");
  }

  /* ══════════════════════════════════════════════════════════════
   * B. `plate` 未命中 ⇒ 回落 `code`（新车第一帧的兼容路径）
   * ══════════════════════════════════════════════════════════════ */
  console.log("\nB. plate 未命中回落 code");
  {
    const { pool, calls } = stubPool({
      byPlate: {},
      byCode: {
        E2122: [row({ plate: "AA-77-59", bus_code: "E2122", company: "tcm", bus_type: "1" })],
      },
    });
    const r = await loadVehicleModel({ plate: "ZZ-99-99", code: "e2122" }, pool);
    assertEq(r.busCode, "E2122", "plate 未命中 ⇒ 走 code，busCode 归一为大写");
    assertEq(
      r.reason,
      "no_model",
      "plate 未命中 + code 命中且无型号 ⇒ no_model（不是 unknown_code）",
    );
    assertEq(r.category, "大巴", "类别随行透出（bus_type='1'）");
    assertEq(plateCalls(calls).length, 2, "先查 plate（未命中）再查 code ⇒ 共 2 条查询");
    assertEq(codeCall(calls)?.params[0], "E2122", "第 2 条查询参数是 code");
  }

  /* ══════════════════════════════════════════════════════════════
   * C. 两者都未命中 ⇒ unknown_code（四态不得混）
   * ══════════════════════════════════════════════════════════════ */
  console.log("\nC. 两者都未命中");
  {
    const { pool } = stubPool({ byPlate: {}, byCode: {} });
    const r = await loadVehicleModel({ plate: "ZZ-99-99", code: "E1167" }, pool);
    assertEq(r.reason, "unknown_code", "都未命中 + 车号格式对 ⇒ unknown_code");
    assertEq(r.model, null, "都未命中 ⇒ model 为 null");
    assertEq(r.via, null, "都未命中 ⇒ via 为 null");
    assertEq(r.category, null, "都未命中 ⇒ 类别为 null（车都不在库，不知道类别）");
    assertEq(r.busCode, "E1167", "都未命中 ⇒ busCode 仍是入参（前端据此显示车号）");
  }

  /* ══════════════════════════════════════════════════════════════
   * D. 行里 `bus_code` 为空
   * ══════════════════════════════════════════════════════════════ */
  console.log("\nD. 行 bus_code 为空的回落");
  {
    const { pool } = stubPool({
      byPlate: { "AA-77-59": row({ plate: "AA-77-59", bus_code: null, bus_type: "1" }) },
      byCode: {},
    });
    const r = await loadVehicleModel({ plate: "AA-77-59" }, pool);
    assertEq(r.busCode, "", "只给 plate 且行里无车号 ⇒ busCode 空串（不编一个）");
    assertEq(r.reason, "no_model", "此时仍在库（foundInDb=true）⇒ no_model 而不是 unknown_code");
    assertEq(r.category, "大巴", "行里无车号不影响类别");
  }
  {
    // 行里无车号但请求同时给了 code ⇒ 用 code 反推区间，这是唯一还能拿到型号的线索
    const { pool } = stubPool({
      byPlate: { "AA-77-59": row({ plate: "AA-77-59", bus_code: null, bus_type: "1" }) },
      byCode: {},
    });
    const r = await loadVehicleModel({ plate: "AA-77-59", code: "dh01" }, pool);
    assertEq(r.busCode, "DH01", "行里无车号 + 给了 code ⇒ busCode 回落入参 code");
    assertEq(r.via, "range", "回落的车号仍可走区间反推 ⇒ via=range");
    assertEq(r.model?.code, "KLQ6755GABEVR", "DH01 反推型号正确");
    assertEq(r.category, "大巴", "类别仍来自行");
  }

  /* ══════════════════════════════════════════════════════════════
   * E. SQL 契约：确定性排序 + 参数化
   * ══════════════════════════════════════════════════════════════ */
  console.log("\nE. SQL 契约（确定性 / 参数化）");
  {
    const { pool, calls } = stubPool({
      byPlate: {},
      byCode: { HE247: [row({ plate: "AA-77-59", bus_code: "HE247" })] },
    });
    await loadVehicleModel({ code: "HE247" }, pool);

    const byCode = codeCall(calls);
    assert(!!byCode, "按 code 查询确实发出了 SQL");
    const sql = byCode?.sql ?? "";
    assert(
      /ORDER BY plate/.test(sql),
      "bus_code 查询必须 `ORDER BY plate`（唯一索引 ⇒ 多行时靠它定序）",
    );
    assert(/LIMIT 1/.test(sql), "bus_code 查询必须 `LIMIT 1`");
    assert(
      !/last_seen_at/.test(sql),
      "bus_code 查询**不得**用 last_seen_at 排序（语义是「上次被查所在线路」，会选到退役车）",
    );
    assert(
      !/calibrated_at/.test(sql),
      "bus_code 查询**不得**用 calibrated_at 排序（它是 model 有无的镜像，不承载活跃度）",
    );
    assert(/\$1/.test(sql), "查询参数化（$1），不拼字符串");
    assert(!sql.includes("HE247"), "SQL 文本里不得出现用户输入（防注入）");

    const byPlate = plateCalls(calls).find((c) => /WHERE plate = \$1/.test(c.sql));
    assert(!byPlate, "只给 code 时**不应**为 plate 发空查询");
  }
  {
    // 主键点查不需要排序语义：多写 ORDER BY 会让人误以为"这里可能多行"
    const { pool, calls } = stubPool({
      byPlate: { "AA-77-59": row({ plate: "AA-77-59", bus_code: "HE247" }) },
      byCode: {},
    });
    await loadVehicleModel({ plate: "AA-77-59" }, pool);
    const sql = plateCalls(calls)[0]?.sql ?? "";
    assert(/WHERE plate = \$1/.test(sql), "按 plate 走主键等值查询");
    assert(!/ORDER BY/i.test(sql), "主键点查不带 ORDER BY（加了会误导「这里可能多行」）");
    assert(!/LIMIT/i.test(sql), "主键点查不需要 LIMIT");
  }

  /* ══════════════════════════════════════════════════════════════
   * F. `bus_models` 读失败必须降级而不是 500
   * ══════════════════════════════════════════════════════════════ */
  console.log("\nF. bus_models 读失败降级");
  {
    const calls: Call[] = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        const s = String(sql);
        calls.push({ sql: s, params });
        if (/FROM vehicle_plates WHERE plate/.test(s))
          return {
            rows: [row({ plate: "AA-77-59", bus_code: "HE247", model: "KLQ6106GHEV1" })],
            rowCount: 1,
          };
        if (/FROM bus_models/.test(s)) throw new Error('relation "bus_models" does not exist');
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;

    const r = await loadVehicleModel({ plate: "AA-77-59" }, pool);
    assertEq(
      r.model?.code,
      "KLQ6106GHEV1",
      "bus_models 读失败 ⇒ 仍回型号（降级为「只有型号、没有规格」）",
    );
    assertEq(r.reason, "no_spec", "无规格 ⇒ no_spec（不谎报成功）");
    assertEq(r.model?.seats, null, "无规格 ⇒ 座位为 null（不编）");
  }

  console.log(`\n结果：通过 ${pass} · 失败 ${fail}`);
  if (fail) {
    console.error("\n❌ 取数逻辑与预期不符 —— 每条 ✗ 都是一次「同一台车显示出不同车型」的现场。");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
