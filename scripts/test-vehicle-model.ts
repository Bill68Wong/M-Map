/**
 * 车型规格解析断言（scripts/test-vehicle-model.ts）
 *
 * ── 守的是什么 ────────────────────────────────────────────────────────
 *   `GET /api/vehicle-model` 的判定逻辑是**纯函数**（`src/lib/vehicle/model-shared.ts`），
 *   不连库就能测。本脚本把它最容易错、错了又看不出来的几点钉死：
 *
 *   ① **区间优先于型号**：`KLQ6106GHEV2` 在 HE81-140 是 11.3m 大巴（26+1 座 / 高 3340），
 *      在 HE241-384 是 10.499m 中巴（25+1 座 / 高 3155）。只按型号取，必然有一半车错。
 *   ② **不跨运营商借规格**：新福利 ZE01-07 是 `LCK6759SHEVG`，库里只有澳巴那批的规格
 *      （14 座 / 25 企位）。必须回 `no_spec`，**不能**把 14 座挂到新福利车上。
 *   ③ **`15 pax` 不补 +1**：`HE601-640` / `DH01-03` 的座位是 15，不是 15+1。
 *   ④ **四态互斥**：`null` / `no_spec` / `no_model` / `unknown_code` / `unparsable`
 *      一旦混了，前端文案就会说错话（"没资料" vs "没这台车" 是两种完全不同的提示）。
 *   ⑤ **数据集结构**：主键唯一、区间不重叠、前缀与运营商自洽、`seats` 与原文一致。
 *   ⑥ **`foundInDb=false` 不得短路反推**（F 组）：新车第一帧落库发生在响应之后，
 *      旧实现的提前 return 让 17% 可反推车型一律退化成"资料未公开"。
 *   ⑦ **类别独立于型号**（G 组）：`no_model` 档仍要能显示大巴 / 中巴，
 *      未知码一律 null（不造「其它」这种占位词）。
 *
 * ⚠️ 本脚本**不连数据库**（迁移没跑也能过），所以可进 `npm run verify`。
 *
 * 运行：npm run test:vehicle-model
 */
import { BUS_MODEL_SPECS } from "../db/bus-models-data";
import type { ResolveInput } from "../src/lib/vehicle/model-resolve";
import {
  busTypeLabelOf,
  normalizeBusCode,
  pickSpec,
  resolveVehicleModel,
  specKeyOf,
  specsInRange,
} from "../src/lib/vehicle/model-resolve";

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

const SPECS = BUS_MODEL_SPECS;

/** 便捷构造解析输入（默认"车在库"） */
function input(over: Partial<ResolveInput> & { busCode: string }): ResolveInput {
  return {
    foundInDb: true,
    dbModel: null,
    dbCompany: null,
    dbBusType: null,
    rangeModel: null,
    specs: SPECS,
    ...over,
  };
}

console.log("车型规格解析断言（model-resolve.ts · 七组）\n");

/* ══════════════════════════════════════════════════════════════════
 * A. 数据集结构
 * ══════════════════════════════════════════════════════════════════ */
console.log("A. 数据集结构");
assertEq(SPECS.length, 17, "规格行数 = 17（15 款型号 × 运营商/区间变体）");
assertEq(new Set(SPECS.map((s) => s.specKey)).size, SPECS.length, "spec_key 无重复");
assertEq(new Set(SPECS.map((s) => s.modelCode)).size, 15, "去重后 15 款型号代码");
assertEq(SPECS.filter((s) => s.company === "transmac").length, 13, "新福利 13 行");
assertEq(SPECS.filter((s) => s.company === "tcm").length, 4, "澳巴 4 行");
assertEq(SPECS.filter((s) => s.busCodeFrom !== null).length, 13, "有车号区间 13 行");

for (const s of SPECS) {
  const m = /^(\d+)/.exec(s.seatsRaw ?? "");
  assertEq(
    s.seats,
    m ? Number(m[1]) : null,
    `${s.specKey} 的 seats 与原文「${s.seatsRaw ?? "null"}」一致`,
  );
}

// 区间互不重叠（同运营商 + 同前缀 + **同型号**）。
// ⚠️ 键必须带 modelCode：HE241-384 同时被 KLQ6106GHEV1 与 GHEV2 两行占用是**设计如此**
//    （官网就给合并段 + 两个型号并列），不算重叠；真正要禁止的是同型号的两段互相压盖。
const groups = new Map<string, typeof SPECS>();
for (const s of SPECS) {
  if (s.busCodeFrom === null) continue;
  const k = `${s.company}|${s.busCodePrefix}|${s.modelCode}`;
  groups.set(k, [...(groups.get(k) ?? []), s]);
}
let overlap = 0;
for (const rows of groups.values()) {
  const sorted = [...rows].sort((a, b) => (a.busCodeFrom ?? 0) - (b.busCodeFrom ?? 0));
  for (let i = 1; i < sorted.length; i++)
    if ((sorted[i].busCodeFrom ?? 0) <= (sorted[i - 1].busCodeTo ?? 0)) overlap++;
}
assertEq(overlap, 0, "同运营商同前缀同型号的区间互不重叠");

// 但「同段两型号」确实存在 ⇒ 该段内如果型号未知，接口必须回不了型号（而不是随便挑一个）
assertEq(
  specsInRange(SPECS, "HE300", "transmac").length,
  2,
  "HE300 落在 HE241-384 合并段 ⇒ 命中 2 行（GHEV1 / GHEV2）",
);
assertEq(
  resolveVehicleModel(input({ busCode: "HE300", dbModel: null, dbCompany: "transmac" })).reason,
  "no_model",
  "HE300 型号未知且区间内两型号并列 ⇒ no_model（不猜）",
);

assertEq(
  SPECS.filter((s) => s.style === "A/T").length,
  4,
  "澳巴 4 行的 A/T 款式已剥进 style 列（不在 modelCode 里）",
);
assertEq(
  SPECS.every((s) => !s.modelCode.includes("A/T") && !s.modelCode.includes(" ")),
  true,
  "model_code 均为纯代码（无 A/T、无空格）",
);

/* ══════════════════════════════════════════════════════════════════
 * B. 车号归一与主键格式
 * ══════════════════════════════════════════════════════════════════ */
console.log("\nB. 车号归一与主键格式");
assertEq(normalizeBusCode(" he247 "), "HE247", "去空白 + 大写");
assertEq(normalizeBusCode("HE 247"), "HE247", "中间空白也去掉");
assertEq(normalizeBusCode(null), "", "null → 空串");
assertEq(
  specKeyOf({
    company: "transmac",
    busCodePrefix: "HE",
    busCodeFrom: 81,
    busCodeTo: 140,
    modelCode: "KLQ6116GHEV2",
  }),
  "transmac:HE81-140:KLQ6116GHEV2",
  "有区间的主键格式",
);
assertEq(
  specKeyOf({
    company: "tcm",
    busCodePrefix: null,
    busCodeFrom: null,
    busCodeTo: null,
    modelCode: "LCK6113SHEVG",
  }),
  "tcm:LCK6113SHEVG",
  "无区间的主键格式",
);

/* ══════════════════════════════════════════════════════════════════
 * C. 区间优先 + 同型号不同规格
 * ══════════════════════════════════════════════════════════════════ */
console.log("\nC. 区间优先（同型号不同规格必须分开）");
const he247 = resolveVehicleModel(
  input({ busCode: "HE247", dbModel: "KLQ6106GHEV1", dbCompany: "transmac" }),
);
assertEq(he247.reason, null, "HE247 完整命中");
assertEq(he247.via, "db", "HE247 via=db");
assertEq(he247.model?.seats, 25, "HE247 座位 25");
assertEq(he247.model?.heightMm, 3200, "HE247 车高 3200（GHEV1）");
assertEq(he247.model?.displayName, "海格 增程式電動巴士（10.499米中巴）", "HE247 显示名");

const he380 = resolveVehicleModel(
  input({ busCode: "HE380", dbModel: "KLQ6106GHEV2", dbCompany: "transmac" }),
);
assertEq(he380.model?.heightMm, 3155, "HE380 车高 3155（同为 GHEV2 型号但属 241-384 段）");
assertEq(
  he380.model?.displayName,
  he247.model?.displayName,
  "HE380 与 HE247 显示名相同（同段同款不同配置，靠区间分规格）",
);

// 关键反例：KLQ6106GHEV2 在 HE100 应是 11.3m 大巴（3340），不能被 241-384 那行抢走
const he100 = resolveVehicleModel(
  input({ busCode: "HE100", rangeModel: "KLQ6116GHEV2", dbCompany: "transmac" }),
);
assertEq(he100.via, "range", "HE100 走区间反推（modelOf 未收录 81-200）");
assertEq(he100.model?.heightMm, 3340, "HE100 车高 3340（11.3 米大巴那行）");
assertEq(he100.model?.seats, 26, "HE100 座位 26（26+1）");
assertEq(he100.model?.standing, 56, "HE100 企位 56");

const he180 = resolveVehicleModel(
  input({ busCode: "HE180", rangeModel: "KLQ6116GHEV1", dbCompany: "transmac" }),
);
assertEq(he180.model?.seatsRaw, "27+1", "HE180 座位原文 27+1（位置对应 HE141-200）");
assertEq(he180.model?.heightMm, 3300, "HE180 车高 3300");

// 同型号同运营商两批配置：HE01-02 vs HE03-08
const he01 = resolveVehicleModel(
  input({ busCode: "HE01", dbModel: "KLQ6109GQHEV5", dbCompany: "transmac" }),
);
assertEq(he01.model?.seatsRaw, "26+1", "HE01 座位 26+1");
assertEq(he01.model?.heightMm, 3245, "HE01 车高 3245");
const he05 = resolveVehicleModel(
  input({ busCode: "HE05", dbModel: "KLQ6109GQHEV5", dbCompany: "transmac" }),
);
assertEq(he05.model?.seatsRaw, "30+1", "HE05 座位 30+1");
assertEq(he05.model?.heightMm, 3332, "HE05 车高 3332");

// 歧义不猜：HE09/HE10 在官网区间(03-08)之外、维基区间(08-10)之内 ⇒ no_spec
const he09 = resolveVehicleModel(
  input({ busCode: "HE09", dbModel: "KLQ6109GQHEV5", dbCompany: "transmac" }),
);
assertEq(he09.reason, "no_spec", "HE09 区间对不上两行 ⇒ no_spec（不猜座位数）");
assertEq(he09.model?.code, "KLQ6109GQHEV5", "HE09 仍回型号代码");
assertEq(he09.model?.seats, null, "HE09 不回座位数");

/* ══════════════════════════════════════════════════════════════════
 * D. 不跨运营商借规格
 * ══════════════════════════════════════════════════════════════════ */
console.log("\nD. 不跨运营商借规格");
const e3206 = resolveVehicleModel(
  input({ busCode: "E3206", dbModel: "LCK6113SHEVG", dbCompany: "tcm" }),
);
assertEq(e3206.reason, null, "E3206 完整命中");
assertEq(e3206.model?.seats, 25, "E3206 座位 25");
assertEq(e3206.model?.standing, 56, "E3206 企位 56");
assertEq(e3206.model?.wheelchair, 1, "E3206 轮椅位 1");
assertEq(e3206.model?.style, "A/T", "E3206 款式 A/T 从 style 列取");

// 新福利 HE33-56 的 KLQ6116GHEV 是 24+1/57，绝不能被澳巴那行（25/55/1）覆盖
const he40 = resolveVehicleModel(
  input({ busCode: "HE40", dbModel: "KLQ6116GHEV", dbCompany: "transmac" }),
);
assertEq(he40.model?.seatsRaw, "24+1", "HE40 座位 24+1（新福利自己的规格）");
assertEq(he40.model?.standing, 57, "HE40 企位 57");
assertEq(he40.model?.wheelchair, null, "HE40 无轮椅位（澳巴那行才是 1）");

// 澳巴无编号段 ⇒ 只能按型号匹配
assertEq(
  pickSpec(SPECS, { modelCode: "KLQ6116GHEV", company: "tcm", busCode: "E1999" })?.specKey,
  "tcm:KLQ6116GHEV",
  "澳巴无区间车型按型号命中",
);

// ZE01-07：型号是 LCK6759SHEVG，但规格只录了澳巴那批 ⇒ no_spec
const ze01 = resolveVehicleModel(
  input({ busCode: "ZE01", dbModel: "LCK6759SHEVG", dbCompany: "transmac" }),
);
assertEq(ze01.reason, "no_spec", "ZE01 不借澳巴的 14 座规格");
assertEq(ze01.model?.code, "LCK6759SHEVG", "ZE01 仍回型号代码");
assertEq(ze01.model?.seats, null, "ZE01 座位为 null（不编）");
assertEq(ze01.via, "db", "ZE01 via=db（型号来自 vehicle_plates.model）");

/* ══════════════════════════════════════════════════════════════════
 * E. 四态互斥 + 其它边界
 * ══════════════════════════════════════════════════════════════════ */
console.log("\nE. 四态互斥与边界");
const noModel = resolveVehicleModel(input({ busCode: "E2122", dbModel: null, dbCompany: "tcm" }));
assertEq(noModel.reason, "no_model", "E2122 车在库但型号未知 ⇒ no_model");
assertEq(noModel.model, null, "no_model 时 model 为 null");
assertEq(noModel.via, null, "no_model 时 via 为 null");

const unknown = resolveVehicleModel(input({ busCode: "HE999", foundInDb: false }));
assertEq(unknown.reason, "unknown_code", "HE999 不在库 ⇒ unknown_code");
assertEq(unknown.via, null, "unknown_code 时 via 为 null");

const unparsable = resolveVehicleModel(input({ busCode: "6009", foundInDb: false }));
assertEq(unparsable.reason, "unparsable", "纯数字车号且不在库 ⇒ unparsable");

// 纯数字车号在库（19 台）→ 不是"拆不开"而是"型号未知"
const digitsInDb = resolveVehicleModel(input({ busCode: "6009", dbModel: null, dbCompany: null }));
assertEq(digitsInDb.reason, "no_model", "纯数字车号在库 ⇒ no_model（不是 unparsable）");

// 规格库自带区间补 modelOf 的空洞：HL01-02
const hl01 = resolveVehicleModel(input({ busCode: "HL01", dbModel: null, dbCompany: "transmac" }));
assertEq(hl01.via, "range", "HL01 由规格库区间反推");
assertEq(hl01.model?.code, "KLQ6186GHEV", "HL01 型号");
assertEq(hl01.model?.seatsRaw, "44+1", "HL01 座位 44+1");
assertEq(hl01.model?.lengthMm, 18000, "HL01 车长 18000");

// 15 pax 不补 +1
const he601 = resolveVehicleModel(
  input({ busCode: "HE601", dbModel: "KLQ6756GHEV", dbCompany: "transmac" }),
);
assertEq(he601.model?.seatsRaw, "15", "HE601 座位原文 15（未补 +1）");
assertEq(he601.model?.seats, 15, "HE601 座位 15");
const dh01 = resolveVehicleModel(
  input({ busCode: "DH01", dbModel: "KLQ6755GABEVR", dbCompany: "transmac" }),
);
assertEq(dh01.model?.seatsRaw, "15", "DH01 座位原文 15");
assertEq(dh01.model?.displayName, "海格 純電動巴士（7.59米小巴）", "DH01 显示名（纯电，非增程）");

// 区间重叠时 pickSpec 必须放弃（而不是取第一条）
const fakeOverlap = [
  ...SPECS,
  {
    ...SPECS[0],
    specKey: "transmac:HE100-200:KLQ6116GHEV2",
    busCodeFrom: 100,
    busCodeTo: 200,
  },
];
assertEq(
  pickSpec(fakeOverlap, { modelCode: "KLQ6116GHEV2", company: "transmac", busCode: "HE120" }),
  null,
  "区间重叠 ⇒ 返回 null（不取第一条）",
);
assertEq(
  specsInRange(fakeOverlap, "HE120", "transmac").length,
  2,
  "specsInRange 如实返回重叠的 2 行",
);

// 承运商未知时：全库唯一才用
assertEq(
  pickSpec(SPECS, { modelCode: "ZK6116SHEVPG", company: null, busCode: "YE01" })?.specKey,
  "transmac:YE1-2:ZK6116SHEVPG",
  "company 未知但全库唯一 ⇒ 命中",
);
assertEq(
  pickSpec(SPECS, { modelCode: "KLQ6116GHEV", company: null, busCode: "XX1" }),
  null,
  "company 未知且两行同型号 ⇒ null（不猜是哪家）",
);

/* ══════════════════════════════════════════════════════════════════
 * F. `foundInDb=false` 不再短路反推（P0 回归哨兵）
 *
 * ── 守的是什么 ────────────────────────────────────────────────────
 *   落库发生在 `recordVehiclePlatesAsync()` 的 `after()` 回调里
 *   （`src/lib/dsat/vehicle-plates.ts:204`）—— 即**响应发出之后**。
 *   ⇒ 新车**第一次**被点开时 `foundInDb` 必为 `false`，而 `rangeModel`
 *     在 `load-vehicle-model.ts` 里**已经算好传进来了**。
 *   旧实现第一句 `if (!input.foundInDb) return {via:null, model:null, …}`
 *   把 ② / ②-b 两条反推分支全部截断 ⇒ 17%（93 / 547）可反推车型的车
 *   第一帧一律退化成「资料未公开」，第二帧才正常。
 *
 * ⚠️ 这几条断言的作用不是"证明现在对"，而是**任何人把那个 if 加回去，这里必红**。
 * ══════════════════════════════════════════════════════════════════ */
console.log("\nF. 未入库车仍可反推（!foundInDb 短路回归）");

// ② `modelOf()` 区段表反推（新车第一帧：HE180 在线路里被点到，库里还没有它）
const nfRange = resolveVehicleModel(
  input({ busCode: "HE180", foundInDb: false, rangeModel: "KLQ6116GHEV1" }),
);
assertEq(nfRange.reason, null, "未入库 + rangeModel 已知 ⇒ 完整命中（不是 unknown_code）");
assertEq(nfRange.via, "range", "未入库 + rangeModel 已知 ⇒ via=range");
assertEq(nfRange.model?.seats, 27, "未入库 + rangeModel 已知 ⇒ 座位 27（27+1）");
assertEq(nfRange.model?.code, "KLQ6116GHEV1", "未入库 + rangeModel 已知 ⇒ 型号正确");

// ②-b 规格库自带区间反推（`modelOf()` 未收录的批次也必须在未入库时可达）
const nfSpec = resolveVehicleModel(input({ busCode: "DH01", foundInDb: false, rangeModel: null }));
assertEq(nfSpec.reason, null, "未入库 + 落在 DH01-03 区间 ⇒ 完整命中（走 ②-b）");
assertEq(nfSpec.via, "range", "未入库 + 规格库区间唯一 ⇒ via=range");
assertEq(nfSpec.model?.code, "KLQ6755GABEVR", "未入库 + DH01 ⇒ 型号 KLQ6755GABEVR");
assertEq(nfSpec.model?.seatsRaw, "15", "未入库 + DH01 ⇒ 座位原文 15（未补 +1）");

// 确实推不出 ⇒ 才回到 unknown_code（这才是这个分支的唯一用途）
const nfUnknown = resolveVehicleModel(input({ busCode: "E1167", foundInDb: false }));
assertEq(nfUnknown.reason, "unknown_code", "未入库 + 完全推不出（E1167）⇒ unknown_code");
assertEq(nfUnknown.via, null, "未入库 + 推不出 ⇒ via 为 null");
assertEq(nfUnknown.model, null, "未入库 + 推不出 ⇒ model 为 null");

// 格式都拆不开 ⇒ unparsable（不是"没资料"）
const nfDigits = resolveVehicleModel(input({ busCode: "6009", foundInDb: false }));
assertEq(nfDigits.reason, "unparsable", "未入库 + 纯数字 6009 ⇒ unparsable");

// 回归：`foundInDb=true` 的四态与优先级**逐条不变**，尤其①不得被②抢走
const dbWinsOverRange = resolveVehicleModel(
  input({
    busCode: "HE247",
    dbModel: "KLQ6106GHEV1",
    dbCompany: "transmac",
    rangeModel: "KLQ6116GHEV2",
  }),
);
assertEq(dbWinsOverRange.via, "db", "库里标定优先于区间反推（重排优先级不得把 order 调反）");
assertEq(
  dbWinsOverRange.model?.heightMm,
  3200,
  "库里标定的 GHEV1 车高 3200（未被 rangeModel 覆盖）",
);

/* ══════════════════════════════════════════════════════════════════
 * G. 类别翻译（`bus_type` → `category`）
 *
 * ── 为什么这一组必须存在 ──────────────────────────────────────────
 *   降级链档②「无型号但有类别」实测有 354 台：车型显示「资料未公开」，
 *   但**类别**（大巴 / 中巴）是知道的，必须显示出来。
 *   `category` 放在 `VehicleModelResult` 外层而不是 payload 里，正是为了
 *   `model:null` 时它还能有值 —— 若它跟着 model 一起变 null，档② 直接退化，
 *   那 354 台的 `bus_type` 兜底就白做了。
 *   同时守住反向：**未知码不许回落到「其它」/「未知」**（那是编数据）。
 * ══════════════════════════════════════════════════════════════════ */
console.log("\nG. 类别翻译（bus_type → category）");
assertEq(busTypeLabelOf("1"), "大巴", "'1' ⇒ 大巴");
assertEq(busTypeLabelOf("2"), "中巴", "'2' ⇒ 中巴");
assertEq(busTypeLabelOf(" 1 "), "大巴", "两侧空白容忍（归一后仍认）");
assertEq(busTypeLabelOf(null), null, "null ⇒ null");
assertEq(busTypeLabelOf(undefined), null, "undefined ⇒ null");
assertEq(busTypeLabelOf(""), null, "空串 ⇒ null");
assertEq(busTypeLabelOf("9"), null, "未知码 '9' ⇒ null（不回落到「其它」/「未知」）");
assertEq(busTypeLabelOf("3"), null, "未知码 '3' ⇒ null");

// 档②：型号未知但类别已知 —— 这是 category 放外层的**唯一理由**
const noModelTyped = resolveVehicleModel(
  input({ busCode: "E2122", dbModel: null, dbCompany: "tcm", dbBusType: "1" }),
);
assertEq(noModelTyped.reason, "no_model", "E2122 型号未知 ⇒ no_model");
assertEq(noModelTyped.model, null, "no_model 时 model 为 null");
assertEq(noModelTyped.category, "大巴", "no_model 时 category 仍有值（档② 不退化）");

// 完整命中时类别也要在
const fullTyped = resolveVehicleModel(
  input({ busCode: "HE247", dbModel: "KLQ6106GHEV1", dbCompany: "transmac", dbBusType: "2" }),
);
assertEq(fullTyped.reason, null, "HE247 完整命中");
assertEq(fullTyped.category, "中巴", "完整命中时 category = 中巴");

// no_spec 档：型号已知、规格未知，类别与座位数无关 ⇒ 照样有值
const noSpecTyped = resolveVehicleModel(
  input({ busCode: "ZE01", dbModel: "LCK6759SHEVG", dbCompany: "transmac", dbBusType: "2" }),
);
assertEq(noSpecTyped.reason, "no_spec", "ZE01 ⇒ no_spec");
assertEq(noSpecTyped.category, "中巴", "no_spec 档 category 仍有值");

// 不跨档泄漏：车不在库 ⇒ 不知道类别；未知码也不许造一个占位词出来
const unknownTyped = resolveVehicleModel(
  input({ busCode: "HE999", foundInDb: false, dbBusType: null }),
);
assertEq(unknownTyped.reason, "unknown_code", "HE999 ⇒ unknown_code");
assertEq(unknownTyped.category, null, "unknown_code 档 category 为 null（车都不在库，不知道类别）");

// 反推档（via=range）也必须带上类别，否则前端按 via 分支渲染时会丢这一格
const rangeTyped = resolveVehicleModel(
  input({ busCode: "HE180", foundInDb: false, rangeModel: "KLQ6116GHEV1", dbBusType: "1" }),
);
assertEq(rangeTyped.via, "range", "HE180 ⇒ via=range");
assertEq(rangeTyped.category, "大巴", "via=range 时 category 仍有值");

console.log(`\n结果：通过 ${pass} · 失败 ${fail}`);
if (fail) {
  console.error("\n❌ 车型解析判定与预期不符 —— 上面每条 ✗ 都是一次「弹窗会显示错规格」的现场。");
  process.exit(1);
}
