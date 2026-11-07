/**
 * 车型规格 · **纯解析逻辑**（src/lib/vehicle/model-resolve.ts）
 *
 * ── 与 model-shared.ts 的分工 ──────────────────────────────────────────
 *   `model-shared.ts` 只放类型（表结构 / 四态原因 / 接口载荷）；本文件放判定（车号归一、
 *   主键生成、候选行挑选、四态裁决）。**零依赖**（不 import pg / next）⇒ 接口、迁移脚本、
 *   单测共用**同一份**实现 —— 这是「覆盖率数字与线上行为一致」的唯一保证。
 *   ★ 两个关键设计决定：① 主键 =「运营商 × 车号区间 × 型号」（同型号不同规格有三处真实碰撞）；
 *   ② **绝不跨运营商借规格**（借来的座位数「看起来很合理」，但它是错的且无痕迹）。
 */
import { companyOf, parseBusCode, type Company } from "@/lib/dsat/vehicle-models";
import type { BusModelSpec, VehicleModelPayload, VehicleModelResult } from "./model-shared";

/* ══════════════════════════════════════════════════════════════════════
 * 公共小工具
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 车号归一：大写 + 去全部空白。
 * 与 `vehicle-plates.ts#normalizePlate` 同口径 —— 只做这两件事，
 * **不猜分隔符、不补零**（`HE7` 与 `HE007` 是两台不同的车，改写就造出库里不存在的键）。
 */
export function normalizeBusCode(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/\s+/g, "");
}

/**
 * 生成规格主键。
 *
 * ── ★ 为什么主键必须是它（三处真实碰撞，全部按原设计会静默丢数据）──────
 *   ① **跨运营商同码**：`KLQ6116GHEV` 在新福利（HE33-56）是 24+1 座 / 57 企位 /
 *      11360×2500×3339，在澳巴是 25 座 / 55 企位 / 轮椅位 1。
 *      以 `model_code` 为主键 ⇒ 后灌的澳巴覆盖新福利（或反之），**没有报错**。
 *   ② **同运营商同码不同配置**：`KLQ6109GQHEV5` 在新福利有两批 ——
 *      HE01-02（26+1 座 / 30 企位 / 10870×2480×3245）与
 *      HE03-08（30+1 座 / 40 企位 / 10880×2480×3332）。
 *      ⇒ 连 `(model_code, company)` 也不够，复合主键同样会吃掉一批。
 *   ③ **同显示名覆盖两个型号**：`KLQ6106GHEV1` 与 `KLQ6106GHEV2` 共用
 *      「海格 增程式電動巴士（10.499米中巴）」，但车高不同（3200 / 3155）。
 *      它们型号代码不同、互不冲突，但说明**显示名也不能当键**。
 *
 *   ⇒ 数据的真实身份是「**运营商 × 车号区间 × 型号代码**」。把这三者显式拼成
 *     `spec_key` 作主键，就得到：确定性（同输入同输出）、可读（日志/告警里一眼认得出）、
 *     可直接 `ON CONFLICT (spec_key) DO UPDATE`（不需要表达式唯一索引那种别扭写法）。
 *
 * @example
 *   specKeyOf({company:"transmac", busCodePrefix:"HE", busCodeFrom:81, busCodeTo:140, modelCode:"KLQ6116GHEV2"})
 *   // → "transmac:HE81-140:KLQ6116GHEV2"
 *   specKeyOf({company:"tcm", busCodePrefix:null, busCodeFrom:null, busCodeTo:null, modelCode:"LCK6113SHEVG"})
 *   // → "tcm:LCK6113SHEVG"
 */
export function specKeyOf(s: {
  company: string;
  busCodePrefix: string | null;
  busCodeFrom: number | null;
  busCodeTo: number | null;
  modelCode: string;
}): string {
  const code = normalizeBusCode(s.modelCode);
  const hasRange = s.busCodePrefix !== null && s.busCodeFrom !== null && s.busCodeTo !== null;
  if (!hasRange) return `${s.company}:${code}`;
  return `${s.company}:${normalizeBusCode(s.busCodePrefix!)}${s.busCodeFrom}-${s.busCodeTo}:${code}`;
}

/** 型号代码比较口径（大小写不敏感、去空白） */
function isSameModel(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeBusCode(a ?? "") === normalizeBusCode(b ?? "");
}

/**
 * 车号 → 命中的规格行（按**区间**匹配，可能 0 条 / 多条）。
 * 多条 = 区间表有重叠（数据错误），调用方**不得**取第一条了事。
 */
export function specsInRange(
  specs: readonly BusModelSpec[],
  busCode: string,
  company: string | null,
): BusModelSpec[] {
  const p = parseBusCode(busCode);
  if (!p) return [];
  return specs.filter(
    (s) =>
      (!company || s.company === company) &&
      s.busCodePrefix !== null &&
      normalizeBusCode(s.busCodePrefix) === p.prefix &&
      s.busCodeFrom !== null &&
      s.busCodeTo !== null &&
      p.num >= s.busCodeFrom &&
      p.num <= s.busCodeTo,
  );
}

/**
 * 候选规格行里挑出**唯一正确**的一行；挑不出（0 条或歧义）就返回 null —— **绝不猜**。
 *
 * 判定顺序（每一步都要求"唯一"，任一步出现歧义立即放弃）：
 *   ① 同运营商 + 同型号 + **车号落在区间内** —— 最可靠，能区分 HE01-02 与 HE03-08
 *   ② 同运营商 + 同型号 + **无区间**那行（澳巴这类"官网只给型号不给编号段"的车型）
 *      ⚠️ 此步要求**运营商已知**：不知道是哪家时，"全库只有一行无区间"不代表这台车属那家
 *   ③ 同运营商 + 同型号 只剩一行
 *   ④ 否则 null
 *
 * ⚠️ 若 `company` 给定而该运营商下没有这款车的规格 ⇒ 直接 null，
 *    **不允许**回落到另一运营商的同型号（见文件头「绝不跨运营商借规格」）。
 */
export function pickSpec(
  specs: readonly BusModelSpec[],
  input: { modelCode: string; company: string | null; busCode: string },
): BusModelSpec | null {
  const sameModel = specs.filter((s) => isSameModel(s.modelCode, input.modelCode));
  if (!sameModel.length) return null;

  const scope = input.company ? sameModel.filter((s) => s.company === input.company) : sameModel;
  if (!scope.length) return null;

  // ① 区间精确命中
  const p = parseBusCode(input.busCode);
  if (p) {
    const hit = scope.filter(
      (s) =>
        s.busCodePrefix !== null &&
        normalizeBusCode(s.busCodePrefix) === p.prefix &&
        s.busCodeFrom !== null &&
        s.busCodeTo !== null &&
        p.num >= s.busCodeFrom &&
        p.num <= s.busCodeTo,
    );
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) return null; // 区间重叠 ⇒ 数据错误，不猜
  }

  // ② 无区间行唯一（**必须已知运营商才允许**）
  //    为什么加这个前置条件：无区间行存在的原因正是"来源不给编号段"（澳巴）。
  //    若运营商未知就凭"全库唯一"取它，等于赌这台车属于那家 —— 一旦赌错，
  //    座位数会错得毫无痕迹（KLQ6116GHEV 两家分别是 24+1 与 25）。
  if (input.company) {
    const noRange = scope.filter((s) => s.busCodePrefix === null);
    if (noRange.length === 1) return noRange[0];
  }

  // ③ 唯一剩下的一行
  if (scope.length === 1) return scope[0];

  return null;
}

/** 规格行 → 接口载荷；`spec` 为 null 时只回型号代码（其余字段全 null，不编） */
export function toModelPayload(code: string, spec: BusModelSpec | null): VehicleModelPayload {
  return {
    code: normalizeBusCode(code),
    displayName: spec?.displayName ?? null,
    maker: spec?.maker ?? null,
    seats: spec?.seats ?? null,
    seatsRaw: spec?.seatsRaw ?? null,
    standing: spec?.standing ?? null,
    wheelchair: spec?.wheelchair ?? null,
    lengthMm: spec?.lengthMm ?? null,
    widthMm: spec?.widthMm ?? null,
    heightMm: spec?.heightMm ?? null,
    style: spec?.style ?? null,
    source: spec?.source ?? null,
    confidence: spec?.confidence ?? null,
  };
}

/**
 * DSAT `busType` → 中文类别。
 *
 * ── 值域依据 ──────────────────────────────────────────────────────────
 *   `src/lib/dsat/types.ts:66-72` 只有 `busType?: string`（原始字符串，无枚举）；
 *   `db/migrate-vehicle-plates.ts` 的列注释与 `vehicle-plates.ts#normalizeBusType`
 *   都只认 `'1'` / `'2'`（落库前已把脏值归一成 null）。实测全库只有这两个值。
 *   ⇒ `'1'`=大巴 / `'2'`=中巴。这是**与车长对拍推得**的口径，DSAT 无官方文档。
 *
 * ⚠️ **未知码返回 null，不回落到「未知」/「其它」/「-」**。
 *    有值就必须是真的；猜一个占位词会让前端把它当事实显示出去，
 *    而它既无法追溯也无法被推翻 —— 那是编数据（见 `model-shared.ts#VehicleModelResult.category`）。
 *
 * @param raw `vehicle_plates.bus_type` 原值（'1' | '2' | 脏值 | null）
 * @returns `"大巴"` / `"中巴"` / `null`
 */
export function busTypeLabelOf(raw: string | null | undefined): string | null {
  switch (String(raw ?? "").trim()) {
    case "1":
      return "大巴";
    case "2":
      return "中巴";
    default:
      return null;
  }
}

/** 解析输入（与数据库解耦，便于单测直接构造） */
export interface ResolveInput {
  busCode: string;
  /** `vehicle_plates` 里是否有这台车 */
  foundInDb: boolean;
  /** `vehicle_plates.model`（可能为空串/null） */
  dbModel: string | null;
  /** `vehicle_plates.company` */
  dbCompany: string | null;
  /**
   * `vehicle_plates.bus_type` 原值（'1' | '2' | null）。
   * 与 `foundInDb` 同源 ⇒ 车不在库时调用方传 null，类别自然为 null（不跨档泄漏）。
   */
  dbBusType: string | null;
  /** `modelOf(busCode)?.model` —— 既有静态区段表的结论（可空） */
  rangeModel: string | null;
  /** 全部规格行（表只有十几行，整表取即可） */
  specs: readonly BusModelSpec[];
}

/**
 * 车号 → 车型规格的**唯一判定入口**。
 *
 * 优先级（与需求书一致，**顺序即优先级，不要调换**）：
 *   1. `vehicle_plates.model` 非空 ⇒ 用库里的型号（`via:"db"`）
 *   2. 否则用车号区间反推（`via:"range"`）：先 `modelOf()`，再规格库自带的区间
 *   3. 都不行 ⇒ `no_model`（在库）/ `unknown_code`（不在库但格式对）/ `unparsable`（格式错）
 *
 * ── ★ 这里曾有一个把近 19% 可反推车号白白扔掉的短路（已修，勿回退）─────────
 *   原实现第一句是 `if (!input.foundInDb) return { via:null, model:null, reason:… }`
 *   —— 新车**第一次**被点开时必然走这条路：落库发生在 `recordVehiclePlatesAsync()`
 *   的 `after()` 回调里（`src/lib/dsat/vehicle-plates.ts:204`），即**响应发出之后**。
 *   ⇒ 反推分支（②/②-b）永远到不了，第二帧才正常 —— 用户看到的是"闪一下才出车型"。
 *   实测（2026-11-06 生产库，`npm run report:vehicle-model-coverage` 原样输出）：规格库
 *   13 个区间穷举出**唯一**车号 403 个（⚠️ 不是 547 —— `HE241-384` 被 `KLQ6106GHEV1` /
 *   `GHEV2` 两行共用，按区间宽度直接相加会重复计入 144 个：403 + 144 = 547），其中 328 个
 *   在 `vehicle_plates`、**75 个（18.6%）不在**。修前这 75 个全部退化 `unknown_code`，
 *   修后 403/403 都能返回型号。
 *
 *   修法不是"先查区间再查库"（库里的标定**必须**优先于静态区段表 —— 它是逐车校正过的），
 *   而是**把 `foundInDb` 从"前置闸门"降级为"只影响兜底 reason"**：① / ② / ②-b 对两种
 *   情形一视同仁，只有最后一步的 reason 才分叉。`foundInDb=false` 时 ① 天然不可达
 *   （`dbModel` 与它同源，必为 null），不需要特判。
 *
 * ⚠️ 纯函数：**不连库、不打日志**。DB 读取在 `load-vehicle-model.ts`。
 */
export function resolveVehicleModel(input: ResolveInput): VehicleModelResult {
  const busCode = normalizeBusCode(input.busCode);
  const parsed = parseBusCode(busCode);
  const company: string | null =
    input.dbCompany ?? (parsed ? (companyOf(busCode) as Company | null) : null);
  // 类别与型号是两条独立的已知程度 ⇒ 所有分支都带同一个值，不随 reason 变化
  const category = busTypeLabelOf(input.dbBusType);

  // ① 库里已标定的型号（最高优先级：逐车校正过的标定胜过静态区段表）
  const dbModel = normalizeBusCode(input.dbModel ?? "") || null;
  if (dbModel) {
    const spec = pickSpec(input.specs, { modelCode: dbModel, company, busCode });
    return {
      busCode,
      company,
      category,
      via: "db",
      model: toModelPayload(dbModel, spec),
      reason: spec ? null : "no_spec",
    };
  }

  // ② 既有静态区段表（src/lib/dsat/vehicle-models.ts#modelOf）
  const rangeModel = normalizeBusCode(input.rangeModel ?? "") || null;
  if (rangeModel) {
    const spec = pickSpec(input.specs, { modelCode: rangeModel, company, busCode });
    return {
      busCode,
      company,
      category,
      via: "range",
      model: toModelPayload(rangeModel, spec),
      reason: spec ? null : "no_spec",
    };
  }

  // ②-b 规格库自带的区间（补 `modelOf()` 未收录的批次，如 HE81-200 / HL01-02）
  const hits = specsInRange(input.specs, busCode, company);
  if (hits.length === 1) {
    return {
      busCode,
      company,
      category,
      via: "range",
      model: toModelPayload(hits[0].modelCode, hits[0]),
      reason: null,
    };
  }

  // ③ 推不出型号 —— 只有到这里才需要区分"车在不在库"（前面的判定与它无关）
  return {
    busCode,
    company,
    category,
    via: null,
    model: null,
    reason: input.foundInDb ? "no_model" : parsed ? "unknown_code" : "unparsable",
  };
}
