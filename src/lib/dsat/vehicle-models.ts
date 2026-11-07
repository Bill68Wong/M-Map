/**
 * 车队编号 → 车型 静态标定表（src/lib/dsat/vehicle-models.ts）
 *
 * ── 用途 ──────────────────────────────────────────────────────────────
 *   DSAT 实时接口只给 `busPlate`（车牌）与 `busCode`（车队编号），**不给车型名**。
 *   本模块把「车队编号」解析成「型号 / 类别 / 来源 / 置信度」，供 `vehicle_plates`
 *   入库标定（`src/lib/dsat/vehicle-plates.ts`）。
 *
 *   ⚠️ UI 只显车队编号（如 `HE380`），**不显**长型号名（主人 2026-10-30 拍板）。
 *      型号入库是为了将来使用与校准，不是给人看的。
 *
 * ⚠️ 本表是**静态标定数据**，非实时来自 DSAT。新福利区段来自官网（官方）；澳巴区段
 *    来自社区维基车队表（**非官方，时效性存疑，需定期校对**）。`busType` 的 1/2
 *    含义由「与大巴/中巴车长对拍」推得，DSAT 无官方文档。
 *
 * ── 来源口径（★ 按行标注，不要整表合并）─────────────────────────────────
 *   · `official-transmac`：新福利官网车型页 `transmac.com.mo/en/?p=1865` **原文区段**。
 *     2026-10-30 逐条核对，该页**只给出 4 个带型号代码的编号段**：
 *       HE57-76 → KLQ6956GHEV · HE33-56 → KLQ6116GHEV · YE01-YE02 → ZK6116SHEVPG
 *       · HE601-640 → KLQ6756GHEV
 *     另有一段 `HE241-384 → KLQ6106GHEV1 / KLQ6106GHEV2`（**两型号并列，官网未给拆分点**），
 *     以及 `HE81-HE140 / HE141-HE200`（2022 年 11.3m，官网只说康明斯/玉柴两种，**未给型号代码**）。
 *   · `wiki-transmac`：维基百科「澳門新福利公共汽車」现役车队表（**非官方**）。
 *     该表比官网细（把 HE241-384 拆成 241-346 / 347-384），但属社区维护、**可能滞后**
 *     ⇒ 置信度 medium。
 *   · `tcm-community`：澳巴区段来自社区车队资料（**非官方**）。E3212 / E3220 / E3225
 *     三台已由逐车登记记录独立佐证为 `LCK6113SHEVG`，但**整段未逐台核对** ⇒ medium。
 *
 * ── 硬规则：查不到就返回 null，绝不猜 ──────────────────────────────────
 *   型号错了比没有型号更坏：`vehicle_plates.model` 会被当作校准依据。
 *   已知空洞（**刻意留空，不要用"推测"填**）：
 *     · `HE81-200`：官网未给型号代码，仅按燃料类型对应两个候选，为避免误标 120 台故留空。
 *       原文只说 2022 年 11.3m 增程巴士有两种（HE81-140 康明斯 / HE141-200 玉柴），
 *       款式行写「KLQ6116GHEV2 / KLQ6116GHEV1」是**两个车型号并列、靠位置对应**，
 *       并未逐段指明「哪段是哪个」。两源对同一区间的对应关系也不能互相印证
 *       ⇒ 一旦标反就是 60 台批量错标，且错得看不出来。**宁缺勿错。**
 *     · `HE06-HE07`：未见任何车队表收录。
 *     · 澳巴 `E5xxx` / `E1xxx` 等新批次与旧段：无区段资料（回填实测确实采到 E1154/E2121 等）。
 */
/**
 * 运营商。`transmac` = 新福利（車隊色 Blue）、`tcm` = 澳巴（Orange）。
 * 定义在此（而非 vehicle-plates.ts）是为了避免两模块循环依赖。
 */
export type Company = "transmac" | "tcm";

/** 型号标定结果（`vehicle_plates` 的 model* 四列同形） */
export interface VehicleModelInfo {
  /** 型号代码，如 `KLQ6106GHEV2`（不含厂商名、不含 EV 后缀） */
  model: string;
  /** 大巴 / 中巴 / 小巴 */
  category: string;
  /** 来源标识，见文件头「来源口径」 */
  source: string;
  /** high（官网逐段）/ medium（社区车队表）/ low / none */
  confidence: string;
}

interface Segment extends VehicleModelInfo {
  prefix: string;
  /** 编号数字段下界（含） */
  from: number;
  /** 编号数字段上界（含） */
  to: number;
  /** 标定备注（车长、出处细节、或该段为何单独列出） */
  note: string;
}

/** 新福利官网车型页（标定基准页） */
const SRC_OFFICIAL = "official-transmac";
/** 维基「澳門新福利公共汽車」现役车队表 */
const SRC_WIKI_TRANSMAC = "wiki-transmac";
/** 澳巴社区车队资料 */
const SRC_TCM = "tcm-community";

/**
 * 区段表。**匹配顺序即优先级**：前缀相同、数字区间不重叠，故顺序无歧义，
 * 但新增区段时仍应把更窄的段放前面（例如将来细化 HE03-05 与 HE08-10）。
 */
const SEGMENTS: readonly Segment[] = [
  // ── 新福利 · 官网原文区段（3 条，confidence high）────────────────────
  {
    prefix: "HE",
    from: 57,
    to: 76,
    model: "KLQ6956GHEV",
    category: "中巴",
    source: SRC_OFFICIAL,
    confidence: "high",
    note: "9.55m 增程电动 · 官网原文「車號: HE57-76 / 款式: KLQ6956GHEV」（2026-10-30 核对）",
  },
  {
    prefix: "HE",
    from: 33,
    to: 56,
    model: "KLQ6116GHEV",
    category: "大巴",
    source: SRC_OFFICIAL,
    confidence: "high",
    note: "11.36m 增程电动 · 官网原文「車號: HE33-56 / 款式: KLQ6116GHEV」",
  },
  {
    prefix: "YE",
    from: 1,
    to: 2,
    model: "ZK6116SHEVPG",
    category: "大巴",
    source: SRC_OFFICIAL,
    confidence: "high",
    note: "11.38m 宇通增程电动 · 官网原文「車號: YE01-YE02 / 款式: ZK6116SHEVPG」",
  },
  {
    prefix: "HE",
    from: 601,
    to: 640,
    model: "KLQ6756GHEV",
    category: "小巴",
    source: SRC_OFFICIAL,
    confidence: "high",
    note: "7.59m 增程电动小巴 · 官网原文「Bus Number: HE601-640 / Type: KLQ6756GHEV」。维基把该段拆成 601-635(2024.01)/636-640(2024.08) 两批，型号相同故合并",
  },

  // ── 新福利 · 维基车队表（confidence medium）──────────────────────────
  {
    prefix: "HE",
    from: 347,
    to: 384,
    model: "KLQ6106GHEV2",
    category: "中巴",
    source: SRC_WIKI_TRANSMAC,
    confidence: "medium",
    // ★ 为什么是 medium 而不是 high（关键，勿随手改）：
    //   官网原文只给**合并区间**「車號: HE241-384 / 款式: KLQ6106GHEV1 / KLQ6106GHEV2」
    //   —— 两种型号列在同一个编号段里，**官网没说 347 这个分界**。
    //   下面 347 的拆分来自维基逐段表，并由 fotobus 逐车登记佐证了 HE241~HE275 = GHEV1
    //   （佐证到 275，未逐台核到 384）。故取值可用、置信度只能是 medium。
    note: "10.499m（2024.11）· 与 GHEV1 大致相同 · ★ HE380 落此段（主人点名样例）",
  },
  {
    prefix: "HE",
    from: 241,
    to: 346,
    model: "KLQ6106GHEV1",
    category: "中巴",
    source: SRC_WIKI_TRANSMAC,
    confidence: "medium",
    note: "10.499m（2023.12）· 移除车顶整流罩、降低车身 · 官网仅给 HE241-384 合并段，此拆分来自维基",
  },
  {
    prefix: "HE",
    from: 201,
    to: 240,
    model: "KLQ6106GHEV",
    category: "中巴",
    source: SRC_WIKI_TRANSMAC,
    confidence: "medium",
    note: "10m（2022.12）· HE201/HE202 原编号为 HE197/HE198（改号史，勿按原号反查）",
  },
  {
    prefix: "HE",
    from: 1,
    to: 2,
    model: "KLQ6109GQHEV5",
    category: "大巴",
    source: SRC_WIKI_TRANSMAC,
    confidence: "medium",
    note: "10.87m（2018.07）· 因超限重禁行嘉乐庇总督大桥",
  },
  {
    prefix: "HE",
    from: 3,
    to: 5,
    model: "KLQ6109GQHEV5",
    category: "大巴",
    source: SRC_WIKI_TRANSMAC,
    confidence: "medium",
    note: "10.88m（2020.12）· 原属银河娱乐",
  },
  {
    prefix: "HE",
    from: 8,
    to: 10,
    model: "KLQ6109GQHEV5",
    category: "大巴",
    source: SRC_WIKI_TRANSMAC,
    confidence: "medium",
    // HE06/HE07 不在车队表内 ⇒ 单独成段，不用 HE03-10 把它们"顺带"覆盖
    note: "10.88m（2020.12）· 与 HE03-05 同型；HE06/HE07 无资料，故本段从 8 起",
  },
  {
    prefix: "DH",
    from: 1,
    to: 3,
    model: "KLQ6755GABEVR",
    category: "小巴",
    source: SRC_WIKI_TRANSMAC,
    confidence: "medium",
    note: "7.5m 纯电（2026.01）· 新福利首批纯电动巴士",
  },
  {
    prefix: "ZE",
    from: 1,
    to: 5,
    model: "LCK6759SHEVG",
    category: "小巴",
    source: SRC_WIKI_TRANSMAC,
    confidence: "medium",
    note: "7.59m 中通（2023.10）· 规格与澳巴购入版本大致相同",
  },
  {
    prefix: "ZE",
    from: 6,
    to: 7,
    model: "LCK6980SHEVG",
    category: "中巴",
    source: SRC_WIKI_TRANSMAC,
    confidence: "medium",
    note: "9.77m 中通（2023.10）",
  },

  // ── 澳巴 · 社区车队资料（confidence medium）──────────────────────────
  {
    prefix: "E",
    from: 3204,
    to: 3264,
    model: "LCK6113SHEVG",
    category: "大巴",
    source: SRC_TCM,
    confidence: "medium",
    // 整段未逐台核对：E3212 / E3220 / E3225 已由逐车登记记录独立佐证同型号，
    // 其余编号依社区区段表。若将来发现段内混入其他型号，应拆段而非改整段。
    note: "11.3m 中通增程电动 · 仅 E3212/E3220/E3225 已逐台佐证，整段未全核",
  },
];

/**
 * 车队编号拆成「字母前缀 + 数字」（`HE380` → `HE` / `380`）；不匹配返回 null。
 *
 * ★ 2026-11-07 导出（原为模块私有 `parseCode`）：`src/lib/vehicle/model-shared.ts`
 *   需要用它区分 `unknown_code`（格式对、车不在库）与 `unparsable`（格式就拆不开）。
 *   拆解口径必须**只有一份** —— 若那里另外写一条正则，两处对 `HE 380` / `he380`
 *   的处理迟早分叉，而症状是"接口说车号解析不了，区段表却认得"。
 */
export function parseBusCode(busCode: string): { prefix: string; num: number } | null {
  const s = String(busCode ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  const m = /^([A-Z]+)(\d+)$/.exec(s);
  if (!m) return null;
  const num = Number(m[2]);
  if (!Number.isFinite(num)) return null;
  return { prefix: m[1], num };
}

/**
 * busCode 前缀 → 运营商。
 * 取**完整字母段**再匹配，故 `YE01`/`ZE01` 不会被单字母 `E` 规则误判成澳巴。
 */
export function companyOf(busCode: string): Company | null {
  const p = parseBusCode(busCode);
  if (!p) return null;
  switch (p.prefix) {
    case "HE": // 海格/苏州金龙主力车队
    case "HL": // 新福利编号（主人口径，样本尚未见）
    case "YE": // 宇通
    case "ZE": // 中通（新福利购入）
    case "DH": // 苏州金龙纯电小巴
    case "R": // 三菱扶桑 Rosa 小巴（R262-R370）
      return "transmac";
    case "E": // 澳巴 E 系列
      return "tcm";
    default:
      return null;
  }
}

/** busCode → 型号标定；区段表查不到返回 null（**绝不猜**） */
export function modelOf(busCode: string): VehicleModelInfo | null {
  const p = parseBusCode(busCode);
  if (!p) return null;
  for (const seg of SEGMENTS) {
    if (seg.prefix !== p.prefix) continue;
    if (p.num < seg.from || p.num > seg.to) continue;
    return {
      model: seg.model,
      category: seg.category,
      source: seg.source,
      confidence: seg.confidence,
    };
  }
  return null;
}

/** 诊断用：区段表快照（只读，供脚本打印覆盖范围） */
export function segmentTable(): readonly Segment[] {
  return SEGMENTS;
}
