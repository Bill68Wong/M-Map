/**
 * 车型规格库 · **共享类型**（src/lib/vehicle/model-shared.ts）
 *
 * ── 为什么类型要单独成文件（和 `src/lib/line/line-shared.ts` 同一个理由）──
 *   这套类型要被**三个不同的运行时**同时使用：
 *     ① 接口 `GET /api/vehicle-model`（Node runtime）；
 *     ② `db/migrate-bus-models.ts`（建表灌数据）与 `scripts/report-vehicle-model-coverage.ts`；
 *     ③ `scripts/test-vehicle-model.ts`（单测，**不连库**）。
 *   三者必须逐字符同一口径 —— 否则「迁移脚本说覆盖 361 台、接口实际只认 355 台」
 *   这种事会静默发生，而且没人会去核对。故本文件**零依赖**：
 *   不 import `pg`、不 import `next`，只放类型（逻辑在同目录 `model-resolve.ts`）。
 *
 * ── ★ 本文件描述的是一条关键设计决定：为什么主键不是 `model_code` ────────
 *   需求原文给的表设计是 `model_code TEXT PRIMARY KEY`。实测**三处碰撞**，
 *   主键必须是「运营商 × 车号区间 × 型号」这个三元组，理由见 `model-resolve.ts#specKeyOf`。
 *   一句话：**同型号 ≠ 同规格**，型号代码不承载运营商的配置差异。
 *
 * ── ★ 另一条硬规则：绝不跨运营商借规格 ──────────────────────────────────
 *   `KLQ6116GHEV` 在新福利是 24+1 座 / 57 企位，在澳巴是 25 座 / 55 企位。
 *   新福利另有一批 `LCK6759SHEVG`（ZE01-07）**没有规格资料** —— 此时返回
 *   `no_spec`（型号已知、规格未知），**不能**回落到澳巴同型号那行。
 *   借来的座位数看起来「很合理」，但它是错的，且错得没有痕迹。
 */

/* ══════════════════════════════════════════════════════════════════════
 * 类型
 * ══════════════════════════════════════════════════════════════════════ */

/** 车型规格行（与 `bus_models` 表列一一对应，驼峰命名） */
export interface BusModelSpec {
  /** 主键：`<company>:<车型代码>` 或 `<company>:<前缀><起>-<止>:<车型代码>`，见 `specKeyOf()` */
  specKey: string;
  /** 型号代码，**与 `vehicle_plates.model` 同值**（如 `KLQ6116GHEV2`） */
  modelCode: string;
  /** 运营商：`transmac` 新福利 / `tcm` 澳巴（与 `vehicle_plates.company` 同枚举） */
  company: string;
  /** 厂商：海格 / 中通 / 宇通（同一运营商可有多家厂商，故独立于 company） */
  maker: string | null;
  /** 弹窗「车型」那一行显示的整串中文（负责人原文，不重排、不简写） */
  displayName: string;
  /** 乘客座位数（`+` 前的数字，**不含司机**） */
  seats: number | null;
  /** 座位原始写法（`26+1` / `15`），保留是为了让 `seats` 可被逐条复核 */
  seatsRaw: string | null;
  /** 企位 */
  standing: number | null;
  /** 轮椅位 */
  wheelchair: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  /** 款式后缀（澳巴原文的 `A/T`）；`A/T` 属款式不属型号，故不放进 `modelCode` */
  style: string | null;
  /** 车号字母前缀（`HE` / `E` / `DH` / `HL` / `YE`）；无区间的车型为 null */
  busCodePrefix: string | null;
  /** 车号数字区间下界（含）；无区间为 null */
  busCodeFrom: number | null;
  /** 车号数字区间上界（含）；无区间为 null */
  busCodeTo: number | null;
  /**
   * 车号区间**原文写法**（`DH01-DH03` / `HE81-140`）。
   * 数值化的 `from/to` 便于比较，原文则便于与来源逐字核对 ——
   * 两者都要：`DH01-DH03` 与 `DH1-3` 语义相同，但只有前者能贴进复核工单。
   */
  busCodeRangeRaw: string | null;
  /** 差异说明 / 出处细节 */
  remark: string | null;
  /** 来源标识：`official-transmac` / `tcm-community` / … */
  source: string | null;
  /** 置信度：`high` / `medium` */
  confidence: string | null;
}

/**
 * 解析失败的原因（**互斥**，前端可据此决定文案）。
 *
 * - `unknown_code`：车号格式正常但库里没有这台车（`vehicle_plates` 无此 `bus_code`）
 * - `no_model`    ：车在库里，但型号未知 —— 澳巴 273 台 + 未收录批次属这一类
 * - `unparsable`  ：车号既不在库、格式也拆不开（如纯数字 `6009`），不是"没资料"而是"不是车号"
 * - `no_spec`     ：**型号已知、规格未知**（2026-11-07 新增第 4 态）。
 *   例：新福利 `ZE01-07` 是 `LCK6759SHEVG`，但该型号的规格只录了澳巴那批
 *   （14 座 / 25 企位），**不能借用** ⇒ 只回型号代码，不回座位/尺寸。
 *   把它并进 `no_model` 会丢掉"型号其实知道"这个有用信息；并进成功态则等于编数据。
 */
export type VehicleModelReason = "no_spec" | "no_model" | "unknown_code" | "unparsable";

/** 弹窗要用的车型载荷（`displayName` 为 null 表示该型号无规格资料，前端只显示代码） */
export interface VehicleModelPayload {
  code: string;
  displayName: string | null;
  maker: string | null;
  seats: number | null;
  seatsRaw: string | null;
  standing: number | null;
  wheelchair: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  style: string | null;
  source: string | null;
  confidence: string | null;
}

/**
 * 接口返回体（`ok` 由 route 补在最外层，这里只管业务字段）
 *
 * ── ★ 为什么 `category` 在**外层**而不是放进 `VehicleModelPayload` ────────
 *   「类别」与「型号规格」是**两个独立的已知程度**，不是同一层信息：
 *     · 型号未知（`reason:"no_model"`，`model:null`）的车**仍然有类别** ——
 *       实测 354 台的 `vehicle_plates.bus_type` 是有值的，显示的应是
 *       「车型：资料未公开 + 类别：大巴」；
 *     · 若把 `category` 塞进 payload，`model:null` 时它一定跟着变成 null，
 *       那 354 台的 `bus_type` 兜底就白做了（档② 会退化到档③）。
 *   ⇒ 外层字段的生命周期独立于 `model`：任何分支都可以有值。
 *   `no_spec`（型号已知、规格未知）同理 —— 类别与座位数无关。
 */
export interface VehicleModelResult {
  busCode: string;
  /** `transmac` / `tcm`；车号都拆不开时为 null */
  company: string | null;
  /**
   * 车辆类别（中文，由 `vehicle_plates.bus_type` 翻译）：`大巴` / `中巴`。
   * null = **不知道**（该车不在库、库里 `bus_type` 为空、或码值不在已知值域内）。
   * ⚠️ 未知码**不回落到「其它」/「未知」** —— 那是编数据，见 `model-resolve.ts#busTypeLabelOf`。
   */
  category: string | null;
  /** 型号从哪来：`db`=`vehicle_plates.model` / `range`=车号区间反推 / null=未知 */
  via: "db" | "range" | null;
  model: VehicleModelPayload | null;
  /** null 表示完全成功（有型号且规格齐全） */
  reason: VehicleModelReason | null;
}
