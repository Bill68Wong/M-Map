/**
 * 迁移：新建 `bus_models`（车型规格库）并灌入负责人提供的车型数据
 *
 * ── 解决什么 ──────────────────────────────────────────────────────────
 *   `vehicle_plates` 只有 `model`（型号代码，如 `KLQ6106GHEV1`），没有「这台车多少座、
 *   多长」。而弹窗要显示的是「海格 增程式電動巴士（10.499米中巴）」这一整行中文 +
 *   座位/企位/尺寸。本表把「型号 → 规格」补齐，主键为
 *   `spec_key = <运营商>:<车号区间>:<型号代码>`（为什么不能只用型号代码，见
 *   `src/lib/vehicle/model-shared.ts#specKeyOf` 的三处碰撞说明）。
 *
 * ── 幂等与安全 ────────────────────────────────────────────────────────
 *   · `CREATE TABLE / INDEX IF NOT EXISTS`；数据 `ON CONFLICT (spec_key) DO UPDATE`；
 *   · **默认 dry-run**：不加 `--apply` 只打印探测结果，一行都不写；
 *   · `--drop`（与 `--apply` 同时用）只删本迁移建的这 1 张表，`CASCADE` 仅作用于本表；
 *   · ⚠️ **不碰 `vehicle_plates`**：本迁移对它是纯只读（只做交叉核对）。
 *     型号回填是另一条链路（`src/lib/dsat/vehicle-plates.ts` 采集时顺手写），
 *     不要在这里"顺手"回填 —— 那会让一次建表迁移变成一次批量数据变更。
 *
 * ── 跑法 ──────────────────────────────────────────────────────────────
 *   npm run db:migrate-bus-models                                   # dry-run（只探测）
 *   npm run db:migrate-bus-models -- cloud --allow-prod             # 同上，显式指向线上库
 *   npm run db:migrate-bus-models -- cloud --apply --allow-prod     # 执行（写库）
 *   npm run db:migrate-bus-models -- cloud --apply --drop --allow-prod   # 撤销
 *
 *   ⚠️ `--allow-prod` 由 `scripts/db-guard.ts` 校验（目标非本地库时必须显式加）。
 *      dry-run 也要加，因为守卫判的是**连到哪**，不是"写不写"——这是有意的：
 *      连生产库读一遍同样应当是一次明确决定。
 *
 * 覆盖率数字不在这里打印：请跑 `npm run report:vehicle-model-coverage`
 * （它用与接口**同一份**纯函数统计，避免两处口径分叉）。
 */
import { Pool } from "pg";
import { BUS_MODEL_SPECS } from "./bus-models-data";
import { companyOf } from "../src/lib/dsat/vehicle-models";
import type { BusModelSpec } from "../src/lib/vehicle/model-shared";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const DROP = argv.includes("--drop");
const targetArg = argv.find((a) => a === "cloud" || a === "local") as "cloud" | "local" | undefined;

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 ⇒ 下面会提示缺连接串 */
}

const connStr =
  targetArg === "cloud"
    ? process.env.DATABASE_URL
    : targetArg === "local"
      ? process.env.DATABASE_URL_LOCAL
      : process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL;

if (!connStr) {
  console.error("未找到连接串：请先在 .env 配置 DATABASE_URL（参照 .env.example）");
  process.exit(1);
}

const pool = new Pool({
  connectionString: connStr,
  ssl: connStr.includes("supabase") ? { rejectUnauthorized: false } : undefined,
});
// 生产库会被间歇性置为只读 ⇒ 会话级显式 off 覆盖（与 migrate-v3400 / v3700 一致）
pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));

const q = async (sql: string, args?: unknown[]) => (await pool.query(sql, args)).rows as Record<string, unknown>[];

const out: string[] = [];
const say = (s = "") => {
  out.push(s);
  console.log(s);
};

/* ══════════════════════════════════════════════════════════════════════
 * DDL
 * ══════════════════════════════════════════════════════════════════════ */
const DDL = [
  `CREATE TABLE IF NOT EXISTS bus_models (
     spec_key         TEXT PRIMARY KEY,
     model_code       TEXT NOT NULL,
     company          TEXT NOT NULL,
     maker            TEXT,
     display_name     TEXT NOT NULL,
     seats            INTEGER,
     seats_raw        TEXT,
     standing         INTEGER,
     wheelchair       INTEGER,
     length_mm        INTEGER,
     width_mm         INTEGER,
     height_mm        INTEGER,
     style            TEXT,
     bus_code_prefix  TEXT,
     bus_code_from    INTEGER,
     bus_code_to      INTEGER,
     bus_code_range_raw TEXT,
     remark           TEXT,
     source           TEXT,
     confidence       TEXT,
     updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT bus_models_company_chk CHECK (company IN ('transmac','tcm')),
     CONSTRAINT bus_models_range_chk CHECK (
       (bus_code_prefix IS NULL AND bus_code_from IS NULL AND bus_code_to IS NULL)
       OR (bus_code_prefix IS NOT NULL AND bus_code_from IS NOT NULL AND bus_code_to IS NOT NULL
           AND bus_code_from >= 0 AND bus_code_from <= bus_code_to)
     ),
     CONSTRAINT bus_models_seats_chk CHECK (
       (seats IS NULL OR seats >= 0) AND (standing IS NULL OR standing >= 0)
       AND (wheelchair IS NULL OR wheelchair >= 0)
     ),
     CONSTRAINT bus_models_dim_chk CHECK (
       (length_mm IS NULL OR length_mm > 0)
       AND (width_mm IS NULL OR width_mm > 0)
       AND (height_mm IS NULL OR height_mm > 0)
     )
   )`,
  `COMMENT ON TABLE bus_models IS
     '车型规格库：型号 → 显示名/座位/企位/轮椅位/长宽高。主键 spec_key = <运营商>:<车号区间>:<型号代码>。
      为什么不用 model_code 作主键：同型号不同规格真实存在三处（跨运营商 KLQ6116GHEV、同运营商不同批次 KLQ6109GQHEV5、
      同显示名两型号 KLQ6106GHEV1/V2）⇒ 单列主键会让后灌的行静默覆盖前面的行。
      只读参考表，由 db/migrate-bus-models.ts 灌入；接口 GET /api/vehicle-model 消费。'`,
  `COMMENT ON COLUMN bus_models.spec_key IS
     '主键。格式 company:PREFIXfrom-to:MODEL 或 company:MODEL（无车号区间时）。由 model-shared.ts#specKeyOf 生成，勿手写。'`,
  `COMMENT ON COLUMN bus_models.model_code IS
     '型号代码，与 vehicle_plates.model 同值（如 KLQ6106GHEV1）。不含厂商名、不含 A/T 款式后缀。'`,
  `COMMENT ON COLUMN bus_models.company IS
     '运营商：transmac=新福利 / tcm=澳巴，与 vehicle_plates.company 同枚举。★ 不可跨运营商借用规格。'`,
  `COMMENT ON COLUMN bus_models.seats IS
     '乘客座位数（原文 + 前的数字，不含司机）。seats_raw 保留原文如 26+1，便于逐条复核。'`,
  `COMMENT ON COLUMN bus_models.seats_raw IS
     '座位原文写法。HE601-640 / DH01-03 官网写 15 pax（无 +1），故为 15 而非 15+1。'`,
  `COMMENT ON COLUMN bus_models.style IS
     '款式后缀（澳巴原文 A/T）。A/T 属款式不属型号，故不并入 model_code。'`,
  `COMMENT ON COLUMN bus_models.bus_code_from IS
     '车号数字区间下界（含）。三列 bus_code_prefix/from/to 要么全空（澳巴：官网不给编号段），要么全有。'`,
  `COMMENT ON COLUMN bus_models.bus_code_range_raw IS
     '车号区间原文写法（DH01-DH03 / HE81-140）。数值化的 from/to 便于比较，原文便于与来源逐字核对 —— 两者都要。'`,
  `CREATE INDEX IF NOT EXISTS idx_bus_models_model_code ON bus_models (model_code)`,
  `CREATE INDEX IF NOT EXISTS idx_bus_models_company ON bus_models (company)`,
  // 防"同一运营商同一型号同一区间"被写进两行（spec_key 已能防，这条防 spec_key 被人手改错）
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bus_models_natural_uniq ON bus_models (
     model_code, company,
     COALESCE(bus_code_prefix, ''), COALESCE(bus_code_from, -1), COALESCE(bus_code_to, -1)
   )`,
] as const;

const TABLE = "bus_models";

/* ══════════════════════════════════════════════════════════════════════
 * 数据集自检（不连库）
 * ══════════════════════════════════════════════════════════════════════ */
function selfCheck(specs: readonly BusModelSpec[]): string[] {
  const problems: string[] = [];

  // ① 主键唯一
  const keys = new Set<string>();
  for (const s of specs) {
    if (keys.has(s.specKey)) problems.push(`spec_key 重复：${s.specKey}`);
    keys.add(s.specKey);
  }

  for (const s of specs) {
    const tag = `[${s.specKey}]`;

    // ② seats 与原文一致（seatsRaw 前导数字必须等于 seats）
    if (s.seatsRaw === null) {
      if (s.seats !== null) problems.push(`${tag} seats=${s.seats} 但缺 seats_raw（无法复核）`);
    } else {
      const m = /^(\d+)/.exec(s.seatsRaw);
      if (!m) problems.push(`${tag} seats_raw 无法解析：${s.seatsRaw}`);
      else if (s.seats === null || Number(m[1]) !== s.seats)
        problems.push(`${tag} seats_raw=${s.seatsRaw} 与 seats=${s.seats} 不一致`);
    }

    // ③ 区间三列全空或全有；原文写法必填且与数值一致
    const rangeCols = [s.busCodePrefix, s.busCodeFrom, s.busCodeTo];
    const filled = rangeCols.filter((v) => v !== null).length;
    if (filled !== 0 && filled !== 3) problems.push(`${tag} 区间三列必须全空或全有（当前 ${filled}/3）`);
    if (s.busCodeFrom !== null && s.busCodeTo !== null && s.busCodeFrom > s.busCodeTo)
      problems.push(`${tag} 区间下界 > 上界`);
    if (filled === 3) {
      if (!s.busCodeRangeRaw) problems.push(`${tag} 有区间但缺原文写法（bus_code_range_raw）`);
      else {
        const nums = s.busCodeRangeRaw.match(/\d+/g)?.map(Number) ?? [];
        if (nums.length !== 2 || nums[0] !== s.busCodeFrom || nums[1] !== s.busCodeTo)
          problems.push(
            `${tag} 区间原文「${s.busCodeRangeRaw}」与数值 ${s.busCodeFrom}-${s.busCodeTo} 不一致`,
          );
      }
    } else if (s.busCodeRangeRaw !== null) {
      problems.push(`${tag} 无区间却有原文写法「${s.busCodeRangeRaw}」`);
    }

    // ④ 前缀与运营商自洽（HE/DH/HL/YE 属新福利，E 属澳巴）
    if (s.busCodePrefix !== null) {
      const byPrefix = companyOf(`${s.busCodePrefix}1`);
      if (byPrefix !== s.company)
        problems.push(`${tag} 前缀 ${s.busCodePrefix} 判定属 ${byPrefix ?? "(未知)"}，与 company=${s.company} 不符`);
    }

    // ⑤ 必填项
    if (!s.displayName?.trim()) problems.push(`${tag} display_name 为空`);
    if (!s.source) problems.push(`${tag} source 为空`);
    if (!s.confidence) problems.push(`${tag} confidence 为空`);
    if (s.wheelchair !== null && s.wheelchair < 0) problems.push(`${tag} wheelchair 为负`);
  }

  // ⑥ 同运营商同型号的区间不得重叠（重叠会让接口无法唯一判定）
  const groups = new Map<string, BusModelSpec[]>();
  for (const s of specs) {
    if (s.busCodeFrom === null) continue;
    const k = `${s.company}|${s.busCodePrefix}|${s.modelCode}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  for (const [k, rows] of groups) {
    const sorted = [...rows].sort((a, b) => (a.busCodeFrom ?? 0) - (b.busCodeFrom ?? 0));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if ((cur.busCodeFrom ?? 0) <= (prev.busCodeTo ?? 0))
        problems.push(`区间重叠：${k} ${prev.specKey} 与 ${cur.specKey}`);
    }
  }

  return problems;
}

/* ══════════════════════════════════════════════════════════════════════
 * 主流程
 * ══════════════════════════════════════════════════════════════════════ */
async function main() {
  say("=".repeat(72));
  say(`bus_models 车型规格库 · migrate-bus-models · ${APPLY ? "APPLY（写库）" : "DRY-RUN（只探测）"}`);
  say("=".repeat(72));
  say(`目标库：${connStr!.replace(/:[^:@/]+@/, ":****@")}`);

  // [1] 数据集自检
  say();
  say("[1] 数据集自检（不连库）");
  const problems = selfCheck(BUS_MODEL_SPECS);
  const byCompany = { transmac: 0, tcm: 0 };
  for (const s of BUS_MODEL_SPECS) byCompany[s.company as "transmac" | "tcm"] += 1;
  const withRange = BUS_MODEL_SPECS.filter((s) => s.busCodeFrom !== null).length;
  say(`    规格行 ${BUS_MODEL_SPECS.length}（新福利 ${byCompany.transmac} / 澳巴 ${byCompany.tcm}）`);
  say(`    其中有车号区间 ${withRange} 行 · 无区间 ${BUS_MODEL_SPECS.length - withRange} 行（澳巴官网不给编号段）`);
  say(`    型号代码去重后 ${new Set(BUS_MODEL_SPECS.map((s) => s.modelCode)).size} 款`);
  if (problems.length) {
    say(`    发现 ${problems.length} 处问题：`);
    problems.forEach((p) => say(`      - ${p}`));
  } else {
    say("    无问题");
  }

  // [2] 目标表状态
  say();
  say("[2] 目标表状态");
  const exists =
    (
      await q(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [TABLE])
    ).length > 0;
  say(`    ${TABLE.padEnd(12)} ${exists ? "已存在" : "不存在（本次将新建）"}`);
  if (exists) {
    const before = (await q(`SELECT count(*)::int AS n FROM ${TABLE}`))[0].n as number;
    say(`    现有行数     ${before}`);
  }

  // [3] 与 vehicle_plates 交叉核对（只读）
  say();
  say("[3] 与 vehicle_plates 交叉核对（本迁移不改它，仅只读核对）");
  const vpOk =
    (await q(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='vehicle_plates'`))
      .length > 0;
  if (!vpOk) {
    say("    vehicle_plates 不存在 ⇒ 跳过（本迁移仅建表，不依赖它）");
  } else {
    const vpTotal = (await q(`SELECT count(*)::int AS n FROM vehicle_plates`))[0].n as number;
    const withModel = (await q(`SELECT count(model)::int AS n FROM vehicle_plates`))[0].n as number;
    say(`    vehicle_plates 共 ${vpTotal} 台，其中 model 非空 ${withModel} 台`);

    const pairs = await q(
      `SELECT model, company, count(*)::int AS n
         FROM vehicle_plates
        WHERE model IS NOT NULL
        GROUP BY 1, 2 ORDER BY 3 DESC`,
    );
    const uncovered: string[] = [];
    for (const r of pairs) {
      const model = String(r.model);
      const company = r.company === null ? null : String(r.company);
      const has = BUS_MODEL_SPECS.some((s) => s.modelCode === model && (!company || s.company === company));
      if (!has) uncovered.push(`${model} / ${company ?? "(company 为空)"} · ${r.n} 台`);
    }
    if (uncovered.length === 0) {
      say("    全部已标定的 (型号, 运营商) 组合都在本数据集内");
    } else {
      say(`    ${uncovered.length} 个组合型号已知但**无规格**（接口会回 no_spec，不跨运营商借用）：`);
      uncovered.forEach((u) => say(`      - ${u}`));
    }
  }

  // [4] 计划写入
  say();
  say("[4] 计划 upsert（ON CONFLICT (spec_key) DO UPDATE）");
  for (const s of BUS_MODEL_SPECS) {
    const range = s.busCodeRangeRaw ?? "—";
    say(
      `      ${s.specKey.padEnd(34)} ${range.padEnd(10)} ${s.seatsRaw ?? "—"}座/${s.standing ?? "—"}企` +
        `${s.wheelchair === null ? "" : `/${s.wheelchair}轮`}  ${s.displayName}`,
    );
  }

  if (!APPLY) {
    say();
    say("[5] DRY-RUN：以上为探测结果，未执行任何 DDL / DML。");
    say("    执行请加 --apply（目标非本地库还需 --allow-prod）");
    say("    覆盖率数字请跑：npm run report:vehicle-model-coverage");
    return;
  }
  if (problems.length) {
    say();
    say("自检未通过 ⇒ 拒绝执行（先修数据集）。");
    process.exitCode = 1;
    return;
  }

  // [5] DROP
  if (DROP) {
    say();
    say("[5] DROP（撤销本迁移）");
    if (exists) {
      await q(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      say(`    已删除 ${TABLE}`);
    } else {
      say(`    跳过（${TABLE} 不存在）`);
    }
    say("    完成。");
    return;
  }

  // [5] DDL
  say();
  say("[5] 执行 DDL");
  for (const stmt of DDL) {
    const head = stmt.trim().split("\n")[0].slice(0, 64);
    await q(stmt);
    say(`    ok  ${head}${stmt.length > 64 ? " …" : ""}`);
  }

  // [6] 灌数据
  say();
  say("[6] 写入规格行");
  for (const s of BUS_MODEL_SPECS) {
    await q(
      `INSERT INTO ${TABLE}
         (spec_key, model_code, company, maker, display_name, seats, seats_raw, standing, wheelchair,
          length_mm, width_mm, height_mm, style, bus_code_prefix, bus_code_from, bus_code_to,
          bus_code_range_raw, remark, source, confidence, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now())
       ON CONFLICT (spec_key) DO UPDATE SET
         model_code = EXCLUDED.model_code, company = EXCLUDED.company, maker = EXCLUDED.maker,
         display_name = EXCLUDED.display_name, seats = EXCLUDED.seats, seats_raw = EXCLUDED.seats_raw,
         standing = EXCLUDED.standing, wheelchair = EXCLUDED.wheelchair,
         length_mm = EXCLUDED.length_mm, width_mm = EXCLUDED.width_mm, height_mm = EXCLUDED.height_mm,
         style = EXCLUDED.style, bus_code_prefix = EXCLUDED.bus_code_prefix,
         bus_code_from = EXCLUDED.bus_code_from, bus_code_to = EXCLUDED.bus_code_to,
         bus_code_range_raw = EXCLUDED.bus_code_range_raw,
         remark = EXCLUDED.remark, source = EXCLUDED.source, confidence = EXCLUDED.confidence,
         updated_at = now()`,
      [
        s.specKey,
        s.modelCode,
        s.company,
        s.maker,
        s.displayName,
        s.seats,
        s.seatsRaw,
        s.standing,
        s.wheelchair,
        s.lengthMm,
        s.widthMm,
        s.heightMm,
        s.style,
        s.busCodePrefix,
        s.busCodeFrom,
        s.busCodeTo,
        s.busCodeRangeRaw,
        s.remark,
        s.source,
        s.confidence,
      ],
    );
  }
  say(`    ${BUS_MODEL_SPECS.length} 行已 upsert`);

  // [7] 复核
  say();
  say("[7] 入库后复核");
  const cols = await q(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [TABLE],
  );
  say(`    列数 ${cols.length}：${cols.map((c) => c.column_name).join(", ")}`);

  const stat = (
    await q(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE company='transmac')::int AS transmac,
              count(*) FILTER (WHERE company='tcm')::int AS tcm,
              count(*) FILTER (WHERE bus_code_from IS NOT NULL)::int AS with_range,
              count(DISTINCT model_code)::int AS models
         FROM ${TABLE}`,
    )
  )[0];
  say(
    `    行数 ${stat.total}（新福利 ${stat.transmac} / 澳巴 ${stat.tcm}）· 有区间 ${stat.with_range} · 型号 ${stat.models} 款`,
  );

  const expect = {
    total: BUS_MODEL_SPECS.length,
    transmac: byCompany.transmac,
    tcm: byCompany.tcm,
    with_range: withRange,
    models: new Set(BUS_MODEL_SPECS.map((s) => s.modelCode)).size,
  };
  const bad = (Object.keys(expect) as (keyof typeof expect)[]).filter((k) => Number(stat[k]) !== expect[k]);
  say(bad.length === 0 ? "    与数据集完全一致" : `    不一致字段：${bad.join(", ")}`);
  if (bad.length) process.exitCode = 1;

  const idx = await q(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY 1`,
    [TABLE],
  );
  say(`    索引 ${idx.length} 个：${idx.map((r) => r.indexname).join(", ")}`);
  say();
  say("完成。");
}

void (async () => {
  try {
    await main();
  } catch (e) {
    console.error("✗", e);
    process.exitCode = 1;
  } finally {
    try {
      const fs = await import("node:fs");
      fs.mkdirSync(".verify", { recursive: true });
      fs.writeFileSync(".verify/migrate-bus-models.out.txt", out.join("\n") + "\n", "utf8");
    } catch {
      /* 日志写失败不影响迁移结果 */
    }
    await pool.end();
  }
})();
