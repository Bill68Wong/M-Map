/**
 * 覆盖率实测：667 台车里，有几台能返回**完整车型规格**（scripts/report-vehicle-model-coverage.ts）
 *
 * ── 为什么必须脚本化、且必须复用接口的判定函数 ──────────────────────────
 *   「覆盖率」是产品体感的唯一量化口径（弹窗里能不能显示车型），而它**最容易报错**。
 *   本项目已立过规矩（见 `src/lib/dsat/vehicle-plates.ts` 文件头五条）：
 *   只贴脚本原样输出、必须带日期与样本量、给比例必须连分母一起给。
 *   若本脚本自己写一份"型号有没有值"的粗统计，就会与接口的真实判定分叉
 *   （接口还要过 `pickSpec` 的唯一性/运营商过滤，ZE 段会掉到 `no_spec`）——
 *   那种"看起来 369 台，实际只有 363 台"的偏差，正是要被消除的东西。
 *   ⇒ 本脚本对每一行调用**接口同一个** `resolveVehicleModel()`，只统计它的返回值。
 *
 * ── 只读 ──────────────────────────────────────────────────────────────
 *   全程 `default_transaction_read_only = on`，不改任何表。未跑迁移也能用：
 *   `bus_models` 不存在时自动回落到 `db/bus-models-data.ts`（并在输出里明确标注）。
 *
 * ── 跑法 ──────────────────────────────────────────────────────────────
 *   npm run report:vehicle-model-coverage
 *   npm run report:vehicle-model-coverage -- cloud --allow-prod   # 显式指向线上库
 */
import { Pool } from "pg";
import { BUS_MODEL_SPECS } from "../db/bus-models-data";
import { modelOf, parseBusCode } from "../src/lib/dsat/vehicle-models";
import {
  type BusModelSpec,
  type VehicleModelReason,
  type VehicleModelResult,
} from "../src/lib/vehicle/model-shared";
import { resolveVehicleModel } from "../src/lib/vehicle/model-resolve";

const argv = process.argv.slice(2);
const targetArg = argv.find((a) => a === "cloud" || a === "local") as "cloud" | "local" | undefined;

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 ⇒ 下面会提示 */
}

const connStr =
  targetArg === "cloud"
    ? process.env.DATABASE_URL
    : targetArg === "local"
      ? process.env.DATABASE_URL_LOCAL
      : (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL);

if (!connStr) {
  console.error("未找到连接串：请先在 .env 配置 DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({
  connectionString: connStr,
  ssl: connStr.includes("supabase") ? { rejectUnauthorized: false } : undefined,
});
// 只读会话：本脚本只统计，绝不允许写
pool.on("connect", (c) => c.query("SET default_transaction_read_only = on"));

interface PlateRow {
  bus_code: string | null;
  model: string | null;
  company: string | null;
  bus_type: string | null;
}

/** 车号前缀分组（与需求书的分组一致；纯数字单列一类） */
function prefixOf(busCode: string): string {
  const m = /^([A-Z]+)/.exec(busCode);
  if (m) return m[1];
  if (/^\d+$/.test(busCode)) return "(纯数字)";
  return "(其它)";
}

const REASON_LABEL: Record<VehicleModelReason, string> = {
  no_spec: "型号已知/规格未知",
  no_model: "型号未知",
  unknown_code: "车号不在库",
  unparsable: "车号拆不开",
};

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log("=".repeat(72));
  console.log(`车型规格覆盖率实测 · ${today}`);
  console.log("=".repeat(72));
  console.log(`目标库：${connStr!.replace(/:[^:@/]+@/, ":****@")}`);

  // ── 规格来源：优先读已建好的 bus_models，未建则回落到静态数据集 ──
  let specs: readonly BusModelSpec[] = BUS_MODEL_SPECS;
  let specSource = `静态数据集 db/bus-models-data.ts（${BUS_MODEL_SPECS.length} 行）`;
  const hasTable = (
    await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='bus_models'`,
    )
  ).rowCount;
  if (hasTable) {
    const r = await pool.query(
      `SELECT spec_key, model_code, company, maker, display_name, seats, seats_raw, standing, wheelchair,
              length_mm, width_mm, height_mm, style, bus_code_prefix, bus_code_from, bus_code_to, bus_code_range_raw,
              remark, source, confidence FROM bus_models`,
    );
    const rows = r.rows as Record<string, unknown>[];
    if (rows.length > 0) {
      specs = rows.map((x) => ({
        specKey: String(x.spec_key),
        modelCode: String(x.model_code),
        company: String(x.company),
        maker: (x.maker as string | null) ?? null,
        displayName: String(x.display_name),
        seats: (x.seats as number | null) ?? null,
        seatsRaw: (x.seats_raw as string | null) ?? null,
        standing: (x.standing as number | null) ?? null,
        wheelchair: (x.wheelchair as number | null) ?? null,
        lengthMm: (x.length_mm as number | null) ?? null,
        widthMm: (x.width_mm as number | null) ?? null,
        heightMm: (x.height_mm as number | null) ?? null,
        style: (x.style as string | null) ?? null,
        busCodePrefix: (x.bus_code_prefix as string | null) ?? null,
        busCodeFrom: (x.bus_code_from as number | null) ?? null,
        busCodeTo: (x.bus_code_to as number | null) ?? null,
        busCodeRangeRaw: (x.bus_code_range_raw as string | null) ?? null,
        remark: (x.remark as string | null) ?? null,
        source: (x.source as string | null) ?? null,
        confidence: (x.confidence as string | null) ?? null,
      }));
      specSource = `数据库 bus_models（${rows.length} 行）`;
    } else {
      specSource = `数据库 bus_models 为空 ⇒ 回落静态数据集（${BUS_MODEL_SPECS.length} 行）`;
    }
  } else {
    specSource = `bus_models 未建 ⇒ 回落静态数据集（${BUS_MODEL_SPECS.length} 行）`;
  }
  console.log(`规格来源：${specSource}`);

  const plates = (await pool.query(`SELECT bus_code, model, company, bus_type FROM vehicle_plates`))
    .rows as PlateRow[];
  console.log(`样本：vehicle_plates ${plates.length} 台（${today} 实测）`);

  // ── 逐台按接口同一口径判定 ──
  const results: { busCode: string; prefix: string; r: VehicleModelResult }[] = plates.map((p) => {
    const busCode = String(p.bus_code ?? "")
      .toUpperCase()
      .replace(/\s+/g, "");
    const r = resolveVehicleModel({
      busCode,
      foundInDb: true,
      dbModel: p.model,
      dbCompany: p.company,
      dbBusType: p.bus_type,
      rangeModel: parseBusCode(busCode) ? (modelOf(busCode)?.model ?? null) : null,
      specs,
    });
    return { busCode, prefix: prefixOf(busCode), r };
  });

  // ── 总体 ──
  const total = results.length;
  const full = results.filter((x) => x.r.reason === null).length;
  const byReason = new Map<VehicleModelReason, number>();
  for (const x of results)
    if (x.r.reason) byReason.set(x.r.reason, (byReason.get(x.r.reason) ?? 0) + 1);
  const viaDb = results.filter((x) => x.r.via === "db").length;
  const viaRange = results.filter((x) => x.r.via === "range").length;

  console.log("\n── 总计 ──");
  console.log(
    `  可返回完整车型规格 ${full} / ${total} 台（${((full / total) * 100).toFixed(1)}%）`,
  );
  console.log(`    其中型号来自 vehicle_plates.model  ${viaDb} 台（via=db）`);
  console.log(`    其中型号由车号区间反推            ${viaRange} 台（via=range）`);
  if (byReason.size) {
    console.log(`  不可返回完整规格 ${total - full} 台：`);
    for (const [k, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1]))
      console.log(`    ${k.padEnd(13)} ${String(n).padStart(4)} 台  （${REASON_LABEL[k]}）`);
  }

  /* ══════════════════════════════════════════════════════════════════
   * 区间可穷举车号全集（含尚未入库的新车）—— 衡量「!foundInDb 短路」的爆炸半径
   *
   * ── 为什么上面的「总计」看不到这个缺口 ─────────────────────────────
   *   上面的统计只遍历 `vehicle_plates`（667 行），而漏掉的那批车**恰恰不在表里**：
   *   落库在响应发出后的 `after()` 里（`src/lib/dsat/vehicle-plates.ts:204`），
   *   新车第一次被点开时必然 `foundInDb=false`。所以缺口只能从**规格库区间反推**
   *   出全集来量：把 13 个区间里的车号逐个穷举，再分成「已在库 / 未入库」两组。
   *
   * ── 修前口径为什么不另写一份实现 ────────────────────────────────────
   *   旧代码与新代码**只差一件事**：`!foundInDb` 的提前 return。
   *   对**在库**车号两者逐字符等价 ⇒ 「修前能返回型号」= 把同一份判定结果
   *   过滤成 `foundInDb=true` 再数。这里不重写判定，避免"报告口径与接口分叉"
   *   （那正是本脚本文件头要消除的东西）。
   * ══════════════════════════════════════════════════════════════════ */
  const ranged = specs.filter(
    (s) => s.busCodePrefix !== null && s.busCodeFrom !== null && s.busCodeTo !== null,
  );
  const rangeKeys = new Set<string>();
  for (const s of ranged)
    for (let n = s.busCodeFrom!; n <= s.busCodeTo!; n++) rangeKeys.add(`${s.busCodePrefix}${n}`);

  /** 库里的车号 → 行（按 `parseBusCode` 归一后的键，避免 `HA01` / `HA1` 被当成两台） */
  const platesByKey = new Map<string, PlateRow>();
  for (const p of plates) {
    const bc = String(p.bus_code ?? "")
      .toUpperCase()
      .replace(/\s+/g, "");
    const parsed = parseBusCode(bc);
    if (parsed && !platesByKey.has(`${parsed.prefix}${parsed.num}`))
      platesByKey.set(`${parsed.prefix}${parsed.num}`, p);
  }

  let inDbN = 0;
  let beforeModel = 0;
  let afterModel = 0;
  let afterFull = 0;
  for (const key of rangeKeys) {
    const p = platesByKey.get(key);
    const r = resolveVehicleModel({
      busCode: key,
      foundInDb: !!p,
      dbModel: p?.model ?? null,
      dbCompany: p?.company ?? null,
      dbBusType: p?.bus_type ?? null,
      rangeModel: modelOf(key)?.model ?? null,
      specs,
    });
    if (p) inDbN++;
    // 修前：`!foundInDb` 一律 unknown_code ⇒ 只有在库车号可能拿到型号
    if (p && r.model) beforeModel++;
    if (r.model) afterModel++;
    if (r.reason === null) afterFull++;
  }

  const rt = rangeKeys.size;
  const pct = (a: number) => `${((a / rt) * 100).toFixed(1)}%`;
  console.log("\n── 规格库区间可穷举的车号全集（含尚未入库的新车）──");
  console.log(`  ${ranged.length} 个区间穷举出唯一车号 ${rt} 个`);
  console.log(`    已在 vehicle_plates  ${inDbN} 个`);
  console.log(`    尚未入库（新车第一帧） ${rt - inDbN} 个`);
  console.log(
    `  修前「能返回型号」 ${beforeModel} / ${rt}（${pct(beforeModel)}）   ← !foundInDb 提前 return`,
  );
  console.log(
    `  修后「能返回型号」 ${afterModel} / ${rt}（${pct(afterModel)}）   ← 反推分支可达（其中完整规格 ${afterFull}）`,
  );
  console.log(
    `  净增 ${afterModel - beforeModel} 个车号（${pct(afterModel - beforeModel)}），` +
      `这批车原先第一帧显示「资料未公开」、第二帧才正常`,
  );
  if (afterModel !== rt) {
    console.log(
      `  ⚠️ 仍有 ${rt - afterModel} 个车号反推不出型号（多为区间内两型号并列的合并段）——` +
        `回 no_model 是**正确**行为，不是缺口`,
    );
  }

  // ── 按车号前缀分组（分子分母逐项给出，便于复核）──
  console.log("\n── 按车号前缀分组 ──");
  console.log("  前缀        总数   完整规格  仅型号(no_spec)  型号未知(no_model)");
  const prefixes = [...new Set(results.map((x) => x.prefix))].sort((a, b) => {
    if (a === "(纯数字)") return 1;
    if (b === "(纯数字)") return -1;
    return a.localeCompare(b);
  });
  for (const p of prefixes) {
    const rows = results.filter((x) => x.prefix === p);
    const f = rows.filter((x) => x.r.reason === null).length;
    const ns = rows.filter((x) => x.r.reason === "no_spec").length;
    const nm = rows.filter((x) => x.r.reason === "no_model").length;
    console.log(
      `  ${p.padEnd(10)} ${String(rows.length).padStart(5)} ${String(f).padStart(9)} ${String(ns).padStart(15)} ${String(nm).padStart(18)}`,
    );
  }

  // ── 一致性自检：各组之和必须等于总数（防止分类漏行）──
  const sumAll = prefixes.reduce((a, p) => a + results.filter((x) => x.prefix === p).length, 0);
  const sumFull = prefixes.reduce(
    (a, p) => a + results.filter((x) => x.prefix === p && x.r.reason === null).length,
    0,
  );
  console.log(
    `\n  校验：分组台数之和 ${sumAll} / 总数 ${total}；分组完整规格之和 ${sumFull} / 完整规格 ${full}`,
  );
  if (sumAll !== total || sumFull !== full) {
    console.error("  分组求和与总计不一致 ⇒ 分类有漏行，本报告的百分比不可用。");
    process.exitCode = 1;
  }

  // ── 型号分布（已标定的）──
  console.log("\n── 已标定型号分布（型号 → 台数 / 规格是否命中）──");
  const modelCount = new Map<string, { n: number; spec: number }>();
  for (const x of results) {
    const code = x.r.model?.code;
    if (!code) continue;
    const cur = modelCount.get(code) ?? { n: 0, spec: 0 };
    cur.n += 1;
    if (x.r.model?.displayName) cur.spec += 1;
    modelCount.set(code, cur);
  }
  for (const [code, v] of [...modelCount.entries()].sort((a, b) => b[1].n - a[1].n))
    console.log(`  ${code.padEnd(16)} ${String(v.n).padStart(4)} 台 · 规格命中 ${v.spec}`);

  // ── 样例（人工抽查用）──
  console.log("\n── 样例 ──");
  // 每类挑一个有代表性的车号（HE601 / HE180 实测不在库，故用 HE602 / HE141）
  // `DH02` 专测「新车第一帧」：它大概率不在 vehicle_plates，但 DH01-03 区间能唯一反推
  const samples = [
    "HE247",
    "HE380",
    "HE100",
    "HE141",
    "HE602",
    "DH02",
    "HL01",
    "YE01",
    "HE09",
    "E3206",
    "E2122",
    "ZE01",
    "6009",
  ];
  for (const s of samples) {
    const hit = results.find((x) => x.busCode === s);
    const r =
      hit?.r ??
      resolveVehicleModel({
        busCode: s,
        foundInDb: false,
        dbModel: null,
        dbCompany: null,
        dbBusType: null,
        // 与接口同一口径（`load-vehicle-model.ts` 传的就是这个表达式）
        rangeModel: parseBusCode(s) ? (modelOf(s)?.model ?? null) : null,
        specs,
      });
    const label = r.reason ? REASON_LABEL[r.reason] : "完整";
    const dims =
      r.model?.lengthMm && r.model?.widthMm && r.model?.heightMm
        ? `${r.model.lengthMm}×${r.model.widthMm}×${r.model.heightMm}`
        : "—";
    console.log(
      `  ${s.padEnd(7)} via=${String(r.via).padEnd(5)} ${label.padEnd(9)} ` +
        `${r.model?.code ?? "—"} | ${r.model?.displayName ?? "—"} | ${r.model?.seatsRaw ?? "—"}座/${r.model?.standing ?? "—"}企 | ${dims}`,
    );
  }

  console.log("\n完成（本脚本只读，未修改任何表）。");
}

main()
  .catch((e) => {
    console.error("✗", e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
