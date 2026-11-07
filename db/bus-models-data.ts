/**
 * 车型规格库的**数据源**（db/bus-models-data.ts）
 *
 * ── 这份数据从哪来、为什么长这样 ────────────────────────────────────────
 *   全部来自**负责人提供的原文**（2026-11-07）：新福利车型页给「车号区间 + 车型显示名 +
 *   型号代码 + 座位/企位 + 长宽高」；澳巴车型页给「车型显示名 + 型号代码（带 A/T 款式）+
 *   座位/企位/轮椅位」，但**不给车号区间**。
 *
 * ── 三条录入纪律（每条都对应一次真实的错法）──────────────────────────────
 *   ① **照录原文，不补"看起来合理"的值**。
 *      例：`HE601-640` / `DH01-03` 官网写 `15 pax`，**没有 +1** ⇒ `seats=15`，
 *      绝不为了「和其他行统一」写成 `15+1`（那会凭空造出一个司机位）。
 *   ② **并列的多个值按「位置一一对应」拆开，不并列堆在一行**。
 *      例：`HE81-140 / HE141-200` 对应 `KLQ6116GHEV2 / KLQ6116GHEV1`、`26+1 / 27+1`、
 *      `3340 / 3300`。负责人明确裁定「按位置一一对应」⇒ 必须拆成两行，
 *      而不是"官网没给拆分点所以合并成一行"（合并后 60 台车会拿到 50% 错的座位数）。
 *   ③ **型号里的 `A/T` 是款式不是型号** ⇒ 剥到 `style` 列。
 *      `vehicle_plates.model` 里存的是不含 `A/T` 的纯代码，主键若带后缀就永远对不上。
 *
 * ── 与既有 `src/lib/dsat/vehicle-models.ts` 的关系 ───────────────────────
 *   那份表是「车号区间 → 型号代码」（只回答"是什么型号"），本表是「型号+运营商+区间 →
 *   规格」（回答"多少座、多长"）。两者**不重复也不冲突**：
 *   `modelOf()` 未收录的批次（HE81-200、HL01-02）在 `model_source` 注释里是**刻意留空**
 *   （当时只有两个候选、无拆分依据，宁缺勿错）。现在负责人给了拆分依据，
 *   故这些区间只在本表出现，由接口的「规格库自带区间」分支覆盖。
 *   ⚠️ 本表**不改** `vehicle_models.ts` 的 SEGMENTS，也不回写 `vehicle_plates`
 *     —— 那两处的口径变更应单独评估（会影响后续采集写入的 `model*` 四列）。
 *
 * ── 复核方式 ──────────────────────────────────────────────────────────
 *   `scripts/test-vehicle-model.ts` 会对本文件做结构自检（区间不重叠、座位数与原文一致、
 *   前缀与运营商自洽、主键唯一）；`db/migrate-bus-models.ts` 会再对库做一遍。
 */
import type { BusModelSpec } from "../src/lib/vehicle/model-shared";
import { specKeyOf } from "../src/lib/vehicle/model-resolve";

/** 内部构造辅助：把 `specKey` 由三要素推导出来，避免手写出错 */
function spec(s: Omit<BusModelSpec, "specKey">): BusModelSpec {
  return { specKey: specKeyOf(s), ...s };
}

const OFFICIAL_TRANSMAC = "official-transmac";
const TCM_COMMUNITY = "tcm-community";

/**
 * 全部规格行（17 行 / 15 款型号 / 2 家运营商）。
 *
 * 排序：先新福利（按车号区间升序的语义分组），后澳巴。顺序不影响查询（主键查），
 * 只影响迁移日志的可读性。
 */
export const BUS_MODEL_SPECS: readonly BusModelSpec[] = [
  /* ─────────── 新福利（transmac）· 官方原文，含车号区间 ─────────── */

  // HE81-140 / HE141-200：官网两行并列，负责人裁定按位置一一对应
  spec({
    modelCode: "KLQ6116GHEV2",
    company: "transmac",
    maker: "海格",
    displayName: "海格 增程式電動巴士（11.3米大巴）(2022)",
    seats: 26,
    seatsRaw: "26+1",
    standing: 56,
    wheelchair: null,
    lengthMm: 11360,
    widthMm: 2500,
    heightMm: 3340,
    style: null,
    busCodePrefix: "HE",
    busCodeFrom: 81,
    busCodeTo: 140,
    busCodeRangeRaw: "HE81-140",
    remark:
      "2022 年批次。官网两行并列（HE81-140 / HE141-200，型号 GHEV2 / GHEV1），" +
      "负责人 2026-11-07 裁定「按位置一一对应」即拆分依据 ⇒ HE81-140 → GHEV2、车高 3340。",
    source: OFFICIAL_TRANSMAC,
    confidence: "high",
  }),
  spec({
    modelCode: "KLQ6116GHEV1",
    company: "transmac",
    maker: "海格",
    displayName: "海格 增程式電動巴士（11.3米大巴）(2022)",
    seats: 27,
    seatsRaw: "27+1",
    standing: 56,
    wheelchair: null,
    lengthMm: 11360,
    widthMm: 2500,
    heightMm: 3300,
    style: null,
    busCodePrefix: "HE",
    busCodeFrom: 141,
    busCodeTo: 200,
    busCodeRangeRaw: "HE141-200",
    remark:
      "2022 年批次。按位置一一对应（见 HE81-140 行）⇒ HE141-200 → GHEV1、车高 3300。" +
      "该段与 HE81-140 唯一差别就是车高与座位数，不能合并。",
    source: OFFICIAL_TRANSMAC,
    confidence: "high",
  }),

  // HE241-384：官网给合并段 + 两个型号并列，拆分点无官方口径
  spec({
    modelCode: "KLQ6106GHEV1",
    company: "transmac",
    maker: "海格",
    displayName: "海格 增程式電動巴士（10.499米中巴）",
    seats: 25,
    seatsRaw: "25+1",
    standing: 40,
    wheelchair: null,
    lengthMm: 10499,
    widthMm: 2500,
    heightMm: 3200,
    style: null,
    busCodePrefix: "HE",
    busCodeFrom: 241,
    busCodeTo: 384,
    busCodeRangeRaw: "HE241-384",
    remark:
      "官网只给合并段 HE241-384（型号 GHEV1 / GHEV2 并列），**未给拆分点**；" +
      "型号与尺寸按原文并列顺序对应（GHEV1 → 车高 3200 / GHEV2 → 3155）。" +
      "维基把该段拆成 241-346 = GHEV1、347-384 = GHEV2，方向与本对应一致（可作旁证，非官方）。",
    source: OFFICIAL_TRANSMAC,
    confidence: "high",
  }),
  spec({
    modelCode: "KLQ6106GHEV2",
    company: "transmac",
    maker: "海格",
    displayName: "海格 增程式電動巴士（10.499米中巴）",
    seats: 25,
    seatsRaw: "25+1",
    standing: 40,
    wheelchair: null,
    lengthMm: 10499,
    widthMm: 2500,
    heightMm: 3155,
    style: null,
    busCodePrefix: "HE",
    busCodeFrom: 241,
    busCodeTo: 384,
    busCodeRangeRaw: "HE241-384",
    remark:
      "同 HE241-384 合并段；GHEV2 → 车高 3155（与 GHEV1 的 3200 不同，其余规格相同）。" +
      "★ 注意与 HE81-140 的 KLQ6116GHEV2 是**两个不同车型**（11.3m 大巴 vs 10.499m 中巴），" +
      "靠车号区间区分 —— 这也是主键必须含区间的第二个原因。",
    source: OFFICIAL_TRANSMAC,
    confidence: "high",
  }),

  spec({
    modelCode: "KLQ6106GHEV",
    company: "transmac",
    maker: "海格",
    displayName: "海格 增程式電動巴士（10米中巴）",
    seats: 22,
    seatsRaw: "22+1",
    standing: 39,
    wheelchair: null,
    lengthMm: 10000,
    widthMm: 2500,
    heightMm: 3300,
    style: null,
    busCodePrefix: "HE",
    busCodeFrom: 201,
    busCodeTo: 240,
    busCodeRangeRaw: "HE201-240",
    remark: "HE201/HE202 原编号为 HE197/HE198（改号史，勿按原号反查）。",
    source: OFFICIAL_TRANSMAC,
    confidence: "high",
  }),
  spec({
    modelCode: "KLQ6956GHEV",
    company: "transmac",
    maker: "海格",
    displayName: "海格 增程式電動巴士 (9.5米中巴)",
    seats: 22,
    seatsRaw: "22+1",
    standing: 39,
    wheelchair: null,
    lengthMm: 9550,
    widthMm: 2500,
    heightMm: 3325,
    style: null,
    busCodePrefix: "HE",
    busCodeFrom: 57,
    busCodeTo: 76,
    busCodeRangeRaw: "HE57-76",
    remark: "显示名原文的括号是半角且带空格（`(9.5米中巴)`），与其他行不同 —— 照录未统一。",
    source: OFFICIAL_TRANSMAC,
    confidence: "high",
  }),
  spec({
    modelCode: "KLQ6116GHEV",
    company: "transmac",
    maker: "海格",
    displayName: "海格 增程式電動巴士（11.3米）",
    seats: 24,
    seatsRaw: "24+1",
    standing: 57,
    wheelchair: null,
    lengthMm: 11360,
    widthMm: 2500,
    heightMm: 3339,
    style: null,
    busCodePrefix: "HE",
    busCodeFrom: 33,
    busCodeTo: 56,
    busCodeRangeRaw: "HE33-56",
    remark:
      "★ 与澳巴的 KLQ6116GHEV（25 座 / 55 企位 / 轮椅位 1）是**同型号不同规格**：" +
      "新福利这批 24+1 座、57 企位、无轮椅位。跨运营商借用规格就是错的，故主键含 company。",
    source: OFFICIAL_TRANSMAC,
    confidence: "high",
  }),
  spec({
    modelCode: "KLQ6756GHEV",
    company: "transmac",
    maker: "海格",
    displayName: "海格 增程式電動巴士（7.59米小巴）",
    seats: 15,
    seatsRaw: "15",
    standing: 26,
    wheelchair: null,
    lengthMm: 7590,
    widthMm: 2100,
    heightMm: 2910,
    style: null,
    busCodePrefix: "HE",
    busCodeFrom: 601,
    busCodeTo: 640,
    busCodeRangeRaw: "HE601-640",
    remark: "官网原文 `15 pax`，**无 +1**（不设司机位标注）⇒ seats=15，未补成 15+1。",
    source: OFFICIAL_TRANSMAC,
    confidence: "high",
  }),
  spec({
    modelCode: "KLQ6755GABEVR",
    company: "transmac",
    maker: "海格",
    displayName: "海格 純電動巴士（7.59米小巴）",
    seats: 15,
    seatsRaw: "15",
    standing: 26,
    wheelchair: null,
    lengthMm: 7590,
    widthMm: 2100,
    heightMm: 2910,
    style: null,
    busCodePrefix: "DH",
    busCodeFrom: 1,
    busCodeTo: 3,
    busCodeRangeRaw: "DH01-DH03",
    remark: "新福利首批纯电动巴士（纯电，非增程）。官网原文 `15 pax`，同上未补 +1。",
    source: OFFICIAL_TRANSMAC,
    confidence: "high",
  }),
  spec({
    modelCode: "KLQ6186GHEV",
    company: "transmac",
    maker: "海格",
    displayName: "海格鉸接增程式超長大巴（18米）",
    seats: 44,
    seatsRaw: "44+1",
    standing: 85,
    wheelchair: null,
    lengthMm: 18000,
    widthMm: 2500,
    heightMm: 3300,
    style: null,
    busCodePrefix: "HL",
    busCodeFrom: 1,
    busCodeTo: 2,
    busCodeRangeRaw: "HL01-02",
    remark: "铰接（ articulated ）18 米超长车。显示名原文「海格鉸接…」中部无空格，照录。",
    source: OFFICIAL_TRANSMAC,
    confidence: "high",
  }),
  spec({
    modelCode: "ZK6116SHEVPG",
    company: "transmac",
    maker: "宇通",
    displayName: "宇通 增程式電動巴士 (三門)",
    seats: 26,
    seatsRaw: "26+1",
    standing: 55,
    wheelchair: null,
    lengthMm: 11380,
    widthMm: 2500,
    heightMm: 3300,
    style: null,
    busCodePrefix: "YE",
    busCodeFrom: 1,
    busCodeTo: 2,
    busCodeRangeRaw: "YE01-YE02",
    remark: "新福利车队里唯一的宇通批次（三门）。",
    source: OFFICIAL_TRANSMAC,
    confidence: "high",
  }),

  // HE01-02 / HE03-08：同型号 KLQ6109GQHEV5 但两批配置不同 ⇒ 必须按区间拆行
  spec({
    modelCode: "KLQ6109GQHEV5",
    company: "transmac",
    maker: "海格",
    displayName: "海格 增程式電動巴士 (10.8米)",
    seats: 26,
    seatsRaw: "26+1",
    standing: 30,
    wheelchair: null,
    lengthMm: 10870,
    widthMm: 2480,
    heightMm: 3245,
    style: null,
    busCodePrefix: "HE",
    busCodeFrom: 1,
    busCodeTo: 2,
    busCodeRangeRaw: "HE01-02",
    remark:
      "★ 与 HE03-08 是**同运营商同型号但不同配置**（26+1 座 / 30 企位 / 车高 3245），" +
      "故主键必须含区间 —— `(model_code, company)` 复合主键在这里同样会吃掉一批。" +
      "2018.07 批次，因超限重禁行嘉乐庇总督大桥。",
    source: OFFICIAL_TRANSMAC,
    confidence: "high",
  }),
  spec({
    modelCode: "KLQ6109GQHEV5",
    company: "transmac",
    maker: "海格",
    displayName: "海格 增程式電動巴士 (10.8米)",
    seats: 30,
    seatsRaw: "30+1",
    standing: 40,
    wheelchair: null,
    lengthMm: 10880,
    widthMm: 2480,
    heightMm: 3332,
    style: null,
    busCodePrefix: "HE",
    busCodeFrom: 3,
    busCodeTo: 8,
    busCodeRangeRaw: "HE03-08",
    remark:
      "★ 与 HE01-02 同型号不同配置（30+1 座 / 40 企位 / 车高 3332）。本行按官网覆盖 03-08，" +
      "含 HE06/HE07（维基车队表未收录该两台，故此处是它们唯一的规格来源）。" +
      "⚠️ 维基把 10.88m 段写成 HE03-05 与 HE08-10，官网写 HE03-08 ⇒ HE09/HE10 落在" +
      "「型号已知（KLQ6109GQHEV5）但区间对不上任何一行」的歧义区，接口会回 `no_spec`（不猜）。",
    source: OFFICIAL_TRANSMAC,
    confidence: "high",
  }),

  /* ─────────── 澳巴（tcm）· 官网无车号区间，只能按型号匹配 ─────────── */

  spec({
    modelCode: "LCK6113SHEVG",
    company: "tcm",
    maker: "中通",
    displayName: "中通 增程式電動巴士11.3米",
    seats: 25,
    seatsRaw: "25",
    standing: 56,
    wheelchair: 1,
    lengthMm: null,
    widthMm: null,
    heightMm: null,
    style: "A/T",
    busCodePrefix: null,
    busCodeFrom: null,
    busCodeTo: null,
    busCodeRangeRaw: null,
    remark:
      "澳巴官网车型页**不给车号区间** ⇒ 只能按型号匹配（`busCodePrefix` 全 null）。" +
      "型号代码沿用 `tcm-community` 已入库标定（E3204-3264，其中 E3212/E3220/E3225 有逐车登记佐证）；" +
      "座位/企位/轮椅位为负责人提供的澳巴车型页原文，我未二次核验 ⇒ confidence=medium。" +
      "原文型号带 `A/T` 款式后缀，已剥离至 style 列。",
    source: TCM_COMMUNITY,
    confidence: "medium",
  }),
  spec({
    modelCode: "KLQ6116GHEV",
    company: "tcm",
    maker: "海格",
    displayName: "海格 增程式電動巴士11.3米",
    seats: 25,
    seatsRaw: "25",
    standing: 55,
    wheelchair: 1,
    lengthMm: null,
    widthMm: null,
    heightMm: null,
    style: "A/T",
    busCodePrefix: null,
    busCodeFrom: null,
    busCodeTo: null,
    busCodeRangeRaw: null,
    remark:
      "澳巴的 KLQ6116GHEV 与新福利 HE33-56 同型号但规格不同（这里 25 座 / 55 企位 / 轮椅位 1）。" +
      "⚠️ 澳巴目前**没有任何一台车**在 `vehicle_plates` 里被标定为该型号（E 段仅 33 台 LCK6113SHEVG），" +
      "故本行是**前瞻性占位**：等澳巴这批车上线采集并标定后立刻可用。切勿因此认为已覆盖。",
    source: TCM_COMMUNITY,
    confidence: "medium",
  }),
  spec({
    modelCode: "LCK6980SHEVG",
    company: "tcm",
    maker: "中通",
    displayName: "中通 增程式電動巴士9.8米",
    seats: 22,
    seatsRaw: "22",
    standing: 40,
    wheelchair: 1,
    lengthMm: null,
    widthMm: null,
    heightMm: null,
    style: "A/T",
    busCodePrefix: null,
    busCodeFrom: null,
    busCodeTo: null,
    busCodeRangeRaw: null,
    remark: "同 LCK6113SHEVG 的口径（无车号区间 / A/T 属款式 / 规格未二次核验）。",
    source: TCM_COMMUNITY,
    confidence: "medium",
  }),
  spec({
    modelCode: "LCK6759SHEVG",
    company: "tcm",
    maker: "中通",
    displayName: "中通 增程式電動巴士7.5米",
    seats: 14,
    seatsRaw: "14",
    standing: 25,
    wheelchair: 0,
    lengthMm: null,
    widthMm: null,
    heightMm: null,
    style: "A/T",
    busCodePrefix: null,
    busCodeFrom: null,
    busCodeTo: null,
    busCodeRangeRaw: null,
    remark:
      "wheelchair=0 是**原文的 0**（不是缺数据）⇒ 存 0 不存 null。" +
      "★ 新福利 ZE01-07 也是 LCK6759SHEVG，但本行属澳巴，**不得**被新福利车借用" +
      "（接口对 ZE 段回 no_spec，不回这里的 14 座）。",
    source: TCM_COMMUNITY,
    confidence: "medium",
  }),
];

/** 按 spec_key 取规格（迁移脚本与单测用） */
export function specByKey(key: string): BusModelSpec | undefined {
  return BUS_MODEL_SPECS.find((s) => s.specKey === key);
}
