/**
 * 自动选线 · 类型与常量（src/lib/recommend/types.ts，v1.0.0）
 *
 * ⚠️ 纯类型 / 常量模块：**不得 import 任何含 pg 的模块** —— client 组件会间接引用
 *    （`RecommendCard` 等视图类型要传到客户端渲染）。服务端查询见 ./query.ts。
 */

/** 澳門科技大學校区（步行分组上下文；仅 school 侧有意义） */
export type SchoolZone = "B/C" | "N/O" | "R";

/** 澳門科技大學三座区（默认 N/O） */
export const SCHOOL_ZONES: { value: SchoolZone; label: string }[] = [
  { value: "B/C", label: "B/C 座" },
  { value: "N/O", label: "N/O 座" },
  { value: "R", label: "R 座" },
];
export const DEFAULT_ZONE: SchoolZone = "N/O";

/** 赶车 5 档：1 = 全力冲刺有机会赶上 … 5 = 爬过去都能赶上 */
export type CatchTier = 1 | 2 | 3 | 4 | 5;

/**
 * 固定开销（秒）：反应时间 + 起步加速 + 路口/电梯等待。
 * 作用：让 n 小时的各档绝对差自动收敛（短距离跑与走差别不大）—— 正是需求点。
 * ⚠️ 初值，待用历史「depart → wait_start」打点分布回归标定。
 */
export const OVERHEAD_SEC = 15;

/**
 * 各档相对「正常走」的**耗时比** = `基准速度 ÷ 该档速度`
 *
 * ── ★ 基准：正常走 = 1.4 m/s ──────────────────────────────────────────
 *   双重依据（2026-09-18 调研 + 实测）：
 *   1. **文献**：Bohannon & Andrews (2011) *Physiotherapy* 97(3):182-189（PMID 21820535，
 *      41 项研究 / 23,111 人 meta）—— 青壮年男性舒适步速 **1.36~1.43 m/s**；
 *      Andrews et al. (2022)（PMID 36528509，51,248 人）—— 范围 0.97~1.40，
 *      且**结论：步速不因地理区域而异** ⇒ 澳门人群可直接套用 ✓
 *   2. **本项目实测**：19 组真实样本（walk_times 实测分钟 × 高德步行距离）反算
 *      隐含速度**中位数 1.43 m/s** —— 与 Bohannon 的 1.43 **完全吻合** ✓
 *   ⇒ 取 1.4 m/s 为两者之间的稳妥值 ✓
 *
 * ── 各档速度与依据 ────────────────────────────────────────────────────
 *   档1 冲刺 **3.6 m/s**（13 km/h）—— ★ 取「**20~50 米冲刺的平均速度**」，不是峰值
 *         未训练成人**峰值**冲刺 4.5~5.8 m/s，但峰值只能维持 1~3 秒、且需 10~15 米加速；
 *         赶车实际跑 20~50 米 ⇒ 平均 ≈ 峰值的 75~80% ⇒ 3.5~4.4 m/s；
 *         再计**背包**（占体重 8~15%，约降 5%）⇒ 3.3~4.2 ⇒ 取保守侧 **3.6** ✓
 *         ⚠️ 曾误用峰值 5.0 m/s（ratio 0.28）—— **过于乐观** ✗
 *   档2 小跑 **2.0 m/s**（7.2 km/h）—— ★ 中文「小跑」= 快步小碎步，**不是慢跑**
 *         参照：快走上限 1.8 · 小跑 2.0~2.2 · 慢跑(jogging) 2.2~2.7
 *         计背包（-5%）⇒ 1.9~2.1 ⇒ 取 **2.0** ✓
 *         ⚠️ 曾误引「慢跑 2.5 m/s」（ratio 0.56）—— **引错了口径** ✗
 *   档3 正常 **1.4 m/s**（5.0 km/h）—— 见上（★ 含背包，因基准来自实测）
 *   档4 慢走 **1.0 m/s**（3.6 km/h）—— 慢走典型值
 *   档5 极慢 **0.7 m/s**（2.5 km/h）—— 极慢步速区间 0.6~0.9 的中位
 *         ⚠️ 原值 0.6 偏极端（已属步行障碍区间）
 *
 * ── ★ 背包负重的处理原则（重要）───────────────────────────────────────
 *   文献（负重占体重：<10% → 降 1~3% · 20% → 降 10~15%）；
 *   学生书包约 8~15% 体重 ⇒ 约降 **5%** ✓
 *   **但只对档 1、2 施加此修正** —— 因为**档 3/4/5 的基准来自本项目实测，
 *   而实测时主人本就背着书包** ⇒ 背包影响已包含在内，不可重复扣 ✗
 *
 * ── ⚠️ 口径提醒（避免双重计数）────────────────────────────────────────
 *   文献的「3~30m 舒适步速」**含起步加速**，论文自己警示短距离测量不可作标准。
 *   而 `catch-up.ts#requiredSec` 已用 `OVERHEAD_SEC = 15` 秒**单独扣除**起步/反应/等灯，
 *   ⇒ 本比值对应的应是「纯行走的稳态速度」✓
 *   稳态速度略高于 3~30m 平均值（约 +5~10%），此处**刻意取保守侧** ——
 *   与项目「能否赶上的判定一律用下限（往短了算）」的既有原则一致 ✓
 *
 * 📄 完整调研（含全部文献表与交叉验证）：`docs/步行速度五档-文献依据-20260918.md`
 */
export const SPEED_RATIO: Record<CatchTier, number> = {
  1: 0.39, // 3.6 m/s  全力冲刺（20~50m 平均 + 背包；★ 非峰值速度）
  2: 0.7, // 2.0 m/s  小跑（快步小碎步 + 背包；★ 不是「慢跑」）
  3: 1.0, // 1.4 m/s  ★ 基准：正常走（文献 1.36~1.43 + 本项目实测 1.43，已含背包）
  4: 1.4, // 1.0 m/s  慢慢走
  5: 2.0, // 0.7 m/s  极慢（原 2.5/0.6 偏极端）
};

/**
 * ★ 常速步行速度（米/分钟）= **84**（= 1.4 m/s × 60）—— v1.2.0
 *
 * 用途：把高德返回的**步行路径距离（米）**折成「常速基准分钟」写入 `walk_times.minutes`：
 *   `minutes = distance_m ÷ WALK_BASE_M_PER_MIN`
 *
 * 🚫🚫 **严禁用本常量之外的任何速度在这里折算** ——
 *   分档缩放**只在** `catch-up.ts#requiredSec` 做（那里会乘 `SPEED_RATIO`）；
 *   若在这里也按分档速度算，读端会再乘一次 ⇒ **双重缩档** ✗
 *
 * ⚠️ 必须与 `SPEED_RATIO[3] === 1` 的定义基准（1.4 m/s）保持一致，
 *    `src/lib/rebuild/walk-times.ts` 顶部有运行时断言守着这条。
 */
export const WALK_BASE_M_PER_MIN = 84;

/**
 * ★ 档 1（全力冲刺）的**随距离衰减**模型 —— v1.2.0
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 *   线性模型（一个 `SPEED_RATIO` 乘到底）隐含假设「3.6 m/s 能跑完全程」✗
 *   但 **磷酸原（PCr）系统只能撑 8~10 秒**（≈30 米）——
 *   之后糖酵解接管（速度降至峰值约 60%）、再之后有氧主导（约 50%）。
 *   ⇒ 距离越长，恒定速度的高估越严重（1000 米时约高估 90 秒）✗
 *
 * ── 模型：按「时间」分四段（不是「30 米断崖」）────────────────────────
 *   | 段位           | 时间窗      | 相对峰值 | 速度   | 该段可跑距离 |
 *   |----------------|------------|---------|-------|------------|
 *   | PCr（含加速）  | 0~8 s      | 85%     | 3.80  | ~30 m      |
 *   | PCr→糖酵解     | 8~30 s     | 80%     | 3.58  | ~79 m      |
 *   | **糖酵解主导** | **30~120 s** | **60%** | **2.68** | ~241 m   |
 *   | 有氧主导       | >120 s     | 50%     | 2.24  | 不限        |
 *
 *   ⚠️ 峰值取**保守侧**：由「0~8 秒段 = 3.80 m/s」反推约 4.47 m/s
 *      （而非文献中位的 5.15）—— 与项目「能否赶上的判定一律用下限」一致 ✓
 *
 *   ★ 校核：≤30 m 时得到 3.80 m/s，与线性基线 3.6 基本一致
 *     ⇒ **最常见的赶车场景（校门口跑到站台）几乎不受影响** ✓
 *
 * 📄 完整推导与三版模型对比：`docs/步行速度五档-文献依据-20260918.md` §9
 */
export const TIER1_SEGMENTS: { name: string; durSec: number; speedMps: number }[] = [
  { name: "PCr（含加速）", durSec: 8, speedMps: 3.8 },
  { name: "PCr→糖酵解", durSec: 22, speedMps: 3.58 }, // 8 → 30 秒
  { name: "糖酵解主导", durSec: 90, speedMps: 2.68 }, // 30 → 120 秒
  { name: "有氧主导", durSec: Infinity, speedMps: 2.24 }, // > 120 秒
];

/** 档 1 走完 `distanceM` 米所需的**纯行走秒数**（分段累计） */
export function sprintWalkSec(distanceM: number): number {
  if (!Number.isFinite(distanceM) || distanceM <= 0) return 0;
  let remain = distanceM;
  let t = 0;
  for (const seg of TIER1_SEGMENTS) {
    if (remain <= 0) break;
    const segMaxM = seg.durSec === Infinity ? Infinity : seg.durSec * seg.speedMps;
    const m = Math.min(remain, segMaxM);
    t += m / seg.speedMps;
    remain -= m;
  }
  return t;
}

/**
 * 档 1 的**有效速度比** = `基准速度 ÷ 该距离下的实际平均速度`。
 * 距离未知时退回线性基线值 `SPEED_RATIO[1]`（保持向后兼容）。
 */
export function tier1EffRatio(distanceM: number | null | undefined): number {
  if (distanceM == null || !Number.isFinite(distanceM) || distanceM <= 0) return SPEED_RATIO[1];
  const sec = sprintWalkSec(distanceM);
  if (sec <= 0) return SPEED_RATIO[1];
  const avgSpeed = distanceM / sec; // m/s
  return WALK_BASE_M_PER_MIN / 60 / avgSpeed;
}

/** 分档文案（固定话术，不用「推荐理由」标签） */
export const TIER_TEXT: Record<CatchTier, string> = {
  1: "全力冲刺有机会赶上",
  2: "小跑能赶上",
  3: "正常走能赶上",
  4: "慢慢走能赶上",
  5: "爬过去都能赶上",
};

// ★ v1.0.6：不再需要「本班赶不上，等下一班」文案 —— 赶不上的路线**整条不进候选**
//   （见 model.ts 首段：巴士两辆在途车都赶不上 / 轻轨首段赶不上 → 直接剔除）。
//   理由：若保留，卡片总用时里会掺一个「按班次间隔估」的等车值（轻轨更是直接用赶不上的
//   那班车算），数字偏小却没有依据 —— 与既定的「不用估算卡凑数」口径冲突。
//
// ★ v2.0.1（产品 2026-09-19 复拍板）：**确认不再引入 `TIER_TEXT_NEEDS_WAIT` / `needsWait`**。
//   · 卡片按【线路】组织：最近一班赶不上 ⇒ 该线**整条不显示**（原行为即正确）；
//   · 「后续车次」由 `altBuses`（v1.1.5，`RecommendCard.altBuses`）承担，无需单独文案。
//   · 工程上「字面实现 needsWait 必然丢步行出门段」的坑详见 `model.ts` 顶部 v2.0.1 说明。

/**
 * 轻轨表定逐跳时长（分钟）。
 * 来源：氹仔线表定「逐跳间隔」恒 2.0 分钟（5 对邻站 11 次实测 → 119~121 秒）。
 * ⚠️ 合规：这是派生值，UI 必须注明算法（见 /about）。
 *
 * ★ v3.2.0：**已降级为「未收录跳段」的兜底**（120 s/跳）—— 氹仔线乘车时长改由
 *   `LRT_HOP_SEC` 逐段求和（见 `model.ts`）；石排湾/横琴仍走 `LRT_RIDE_SEC_FIXED`。
 */
export const LRT_MIN_PER_HOP = 2.0;

/**
 * ★ v2.3.0（B5.2 · FIX-08.2）：**逐线固定乘车秒数**（覆盖「跳数 × 表定 2 分」的恒定口径）。
 *
 * 裁定（2026-09-20）：轻轨段**豁免「乘车分钟取整」**，保留秒级精度并以 `RideLegView.rideSecText`
 * 展示；**巴士段照常 `Math.round`**。
 * · 石排湾线 1 跳实测 ≈ **100 s**（1 分 40 秒）≠ 跳数×120s；
 * · 横琴线 1 跳 ≈ **135 s**（2 分 15 秒）；
 * · **氹仔线不在本表** ⇒ 取 `跳数 × LRT_MIN_PER_HOP × 60`（按整分展示，不下发 `rideSecText`）。
 *
 * ⚠️ 来源：`lrt_timetables` 表定逐跳 + `docs/轻轨氹仔线发车偏移分析-20260915.md`（石排湾 +2~+3s）。
 *    若 QA/数据侧在 DB 核到更精确秒值，替换本表即可（单一真源）。
 */
export const LRT_RIDE_SEC_FIXED: Record<string, number> = {
  "LRT-石排湾线": 100, // 1 分 40 秒
  "LRT-横琴线": 135, // 2 分 15 秒
};

/**
 * ★ v3.2.0（需求 3 / AC-71/72）：**氹仔线逐段乘车秒表**（站对索引）。
 *
 * ── key 域（★ 实施前已核对 `route_stations` / `lrt_api_stations.db_code`）──────────
 *   key = `${from}|${to}`，站码取 **本库 db_code**（`LRT-BAR` / `LRT-OCH` / …）——
 *   与 `RideSegment.hops`（来自 `RouteIndex.dirStops` = `route_stations.station_code`）**同域**。
 *   ⚠️ 注意：`lrt_station_biases.api_station` 用的是 motransportinfo **api 码**（`BAR`/`OCE`…），
 *      两者**不可混用**；本表刻意用 db_code：
 *      `OCE→LRT-OCH` · `JOC→LRT-JCK` · `STA→LRT-STD` · `COW→LRT-CWE` · `COE→LRT-LDE` ·
 *      `MUS→LRT-MUST` · `AIR→LRT-AP`。
 *
 * ── 值来源（`15-号 §三`「发→发」区间用时，主用多数模式列；P3 拍板三值已落定）──────
 *   正向（媽閣→氹仔碼頭）12 段合计 **1605 s**；反向（氹仔碼頭→媽閣）合计 **1570 s**。
 *   石排湾/横琴**不进本表**（走 `LRT_RIDE_SEC_FIXED`）。
 *   ⚠️ 合规：派生值（区间用时由实测反算），UI 注明算法（见 /about）。
 */
export const LRT_HOP_SEC: Record<string, number> = {
  // ── 正向（媽閣→氹仔碼頭，dir=api TFT）──
  "LRT-BAR|LRT-OCH": 285, // 媽閣→海洋（跨海段；旧口径按 120，本批主要修正来源）
  "LRT-OCH|LRT-JCK": 115, // 海洋→馬會
  "LRT-JCK|LRT-STD": 145, // 馬會→運動場
  "LRT-STD|LRT-PAK": 115, // 運動場→排角
  "LRT-PAK|LRT-CWE": 120, // 排角→路氹西
  "LRT-CWE|LRT-LOT": 135, // 路氹西→蓮花
  "LRT-LOT|LRT-UH": 100, // 蓮花→協和醫院
  "LRT-UH|LRT-EAG": 130, // 協和醫院→東亞運（打点 128·128·132·138 吻合）
  "LRT-EAG|LRT-LDE": 110, // 東亞運→路氹東（P3 拍板；打点 76·80·80·82 未采用）
  "LRT-LDE|LRT-MUST": 125, // 路氹東→科大（手记 522；另一记 130）
  "LRT-MUST|LRT-AP": 145, // 科大→機場
  "LRT-AP|LRT-TFT": 80, // 機場→氹仔碼頭（末段、无停站）
  // ── 反向（氹仔碼頭→媽閣，dir=api BAR）──
  "LRT-TFT|LRT-AP": 110, // 氹仔碼頭→機場
  "LRT-AP|LRT-MUST": 135, // 機場→科大
  "LRT-MUST|LRT-LDE": 140, // 科大→路氹東（P3 拍板；132 勘误后值；打点 138·139 吻合）
  "LRT-LDE|LRT-EAG": 100, // 路氹東→東亞運（打点 96·97·100 吻合）
  "LRT-EAG|LRT-UH": 130, // 東亞運→協和醫院（P3 拍板；打点 102·107·111 未采用）
  "LRT-UH|LRT-LOT": 105, // 協和醫院→蓮花
  "LRT-LOT|LRT-CWE": 125, // 蓮花→路氹西
  "LRT-CWE|LRT-PAK": 120, // 路氹西→排角
  "LRT-PAK|LRT-STD": 105, // 排角→運動場
  "LRT-STD|LRT-JCK": 130, // 運動場→馬會
  "LRT-JCK|LRT-OCH": 120, // 馬會→海洋
  "LRT-OCH|LRT-BAR": 250, // 海洋→媽閣（末段；跨海段）
};

/** ★ v3.2.0：氹仔线未收录跳段的兜底（秒）—— 对 AC-72 */
export const LRT_HOP_FALLBACK_SEC = 120;

/**
 * ★ v3.3.0（需求 5 / AC-106）：**轻轨站内步行距离常量**（米）。
 *
 * ── 为什么距离化 ──────────────────────────────────────────────────────
 *   轻轨的「进站→站台」「站台→出站」「站内换乘」此前或走实测均值 / 几何估算（本地链路无几何），
 *   或写死分钟 ⇒ 不同链路口径不一、且随速度档缩放时易**双重缩档**。改为**距离常量 ÷ 基准速度**
 *   （`WALK_BASE_M_PER_MIN = 84`）统一折算，缩放交给 `catch-up.ts#requiredSec` **单一负责**。
 *
 * ── 取值依据（2026-09-26 现场步测口径 · 官方站内动线）────────────────────
 *   · `inM` / `outM` = 168m（≈2min × 84）；
 *   · `transferByStation`：協和醫院 `LRT-UH` 336m（≈4min）· 蓮花 `LRT-LOT` 420m（≈5min）。
 *
 * ⚠️ **表化预留**：取值一律经 `lrtStationWalkM()` / `lrtTransferWalkM()`；
 *   日后改表（DB/配置）只改这两个函数体，调用方零改动。
 * ⚠️ 这是**派生值**（距离→分钟），合规须可溯源（UI 注明算法）。
 */
export const LRT_STATION_WALK = {
  /** 进站 → 站台（米）—— ★ 2026-09-27（用户口径）：1.5 分钟「正常走」等效（84 m/min × 1.5） */
  inM: 126,
  /** 站台 → 出站（米）—— 同口径（1.5 分钟正常走） */
  outM: 126,
  /** 站内换乘（按本库站主码，米） */
  transferByStation: { "LRT-UH": 336, "LRT-LOT": 420 } as Record<string, number>,
} as const;

/** 轻轨进出站步行距离（米）—— 表化预留接口（改表只改此函数体） */
export function lrtStationWalkM(kind: "in" | "out"): number {
  return kind === "in" ? LRT_STATION_WALK.inM : LRT_STATION_WALK.outM;
}

/** 轻轨站内换乘步行距离（米）；未收录该站 ⇒ null（调用方沿用原几何 / `transfer_walks`） */
export function lrtTransferWalkM(stationMain: string): number | null {
  const m = LRT_STATION_WALK.transferByStation[stationMain];
  return typeof m === "number" && m > 0 ? m : null;
}

/** 步行数据全落空时的常数兜底（分钟，1~2 站台距离） */
export const WALK_FALLBACK_MIN = 3.0;

/** 换乘步行兜底（分钟）：LRT-LOT 蓮花 无样本 → 暂用 3 分并在 UI 标「估算」 */
export const TRANSFER_FALLBACK_MIN = 3.0;

// ★ B4（需求 7 / AC-61）：**已废除**旧常量「第 2 段巴士等车恒 180s」（原 `= 360s ÷ 2`）。
//   换乘后第 2 段的等车改为**数据驱动**：按「到达换乘站的时刻」查 `route_frequency`
//   （`headway.ts#headwayAt`）取偏保守值 `(lo + 2·hi) / 3`；未命中 → 该线全时段班距中位数
//   （`headwayMedian`）→ 仍无 ⇒ 该段 `waitMin = null`（明示降级，禁止常量默认值）。
//   见 `model.ts` 第 2 段等车分支 与 `docs/迭代-导航优化-20260926/07-技术-接口与组件规格.md` §h。

/** 同场换乘（前后站在同一物理车站，如 T355/1 ↔ T355/2）→ 步行 0 */
export const SAME_FIELD_TRANSFER_MIN = 0;

/**
 * 巴士报时「区间」的相对系数（**显示与判定同源**：loSec 用于显示下限 + 赶车判定，hiSec 用于显示上限）。
 *
 * ★ v3.4.1 实测标定（推翻初值）：区间从 [1.00×, 1.25×] 改为 **[0.60×, 1.40×]**
 *   ——5.2 万条行程链模拟（.verify/_track-progress-11-accuracy.mjs · accuracy-report.txt）：
 *     实际/预测比值 P10/P50/P90 = 0.71 / 1.00 / 1.42；
 *     旧口径 [1.00, 1.25] 覆盖率仅 **34.7%**（47% 的情况「比下限还快」）；[0.60, 1.40] → **84.9%** ✓
 * ⚠️ loSec 兼作「能否赶上」判定的下限——降到 0.6× 后判定只会**更保守**（要求更早到站，宁误杀不放过）。
 * ⚠️ 逐跳样本是「离开口径」（run(A→B) + dwell_B），sum 本身非纯行驶——区间系数已含该口径。
 */
export const HOP_LO_FACTOR = 0.6;
export const HOP_HI_FACTOR = 1.4;

// ─────────────────────────── 枚举层 ───────────────────────────

/** 一条载具段（枚举产物，尚未算时长） */
export interface RideSegment {
  route: string;
  kind: "bus" | "lrt";
  board: string;
  alight: string;
  /** bus 必需：逐跳站码对（board → alight 行驶方向）；lrt 可为空（按跳数 × 表定） */
  hops: [string, string][];
  /**
   * ★ v2.3.0（B2）：**同一段内的并行可选线路**（同站上、同站下 → 渲染白斜杠 `/`）。
   *   本库线码，由 `bridgeLeg` 从 `AmapPlanLeg.parallelNames` 经 `routeCodeOf` 映射得到；
   *   本地枚举/链枚举不填（无并行线语义）。缺省 = 无并行线（渲染退化为「一段一码」）。
   */
  parallelRoutes?: string[];
}

/** 段间换乘（第 i 段 → 第 i+1 段） */
export interface TransferSegment {
  /** 前段下车点 */
  at: string;
  /** 后段上车站 */
  to: string;
  /** 同一物理车站（含 T355/1 ↔ T355/2 这类同场分台）→ 步行 0 */
  sameField: boolean;
}

/** 一条待算路线方案（＝一张卡里的一条路线方案） */
export interface OptionSeed {
  planId: number;
  summary: string;
  fromSlug: string;
  toSlug: string;
  /** 是否含跨境段（卡片须标「不含通关」） */
  crossBorder: boolean;
  /** 载具段（≥1） */
  segments: RideSegment[];
  /** 换乘（长度 = segments.length − 1） */
  transfers: TransferSegment[];
  /** 该方案的展示键（去重用）：route@board→alight 链 */
  key: string;
}

// ─────────────────────────── 数据索引（纯数据，server 构造） ───────────────────────────

/** 站序索引（一次 SQL 取全量站序；server 构造、纯数据传递） */
export interface RouteIndex {
  /** `${route}|${dir}` → 有序站码 */
  dirStops: Map<string, string[]>;
  /** `${route}|${dir}` → 站码 → 序号集合（三段式匹配用） */
  seqIdx: Map<string, Map<string, number[]>>;
  /** route → 该线的方向列表（按 dsat_dir 升序） */
  dirsOf: Map<string, string[]>;
  /** 站码 → 显示名（巴士「C653 金峰南岸」/ 轻轨「氹仔碼頭」） */
  nameOf: Map<string, string>;
  /** 邻接对 `mainCode(from)→mainCode(to)` → 拥有该邻接对的线路集合 */
  adjOwners: Map<string, Set<string>>;
}

/** segment_stats 行（读端最小列集） */
export interface SegmentStatRow {
  route_code: string;
  from_station: string;
  to_station: string;
  weekday: number;
  time_bucket: string;
  arrive_kind: string;
  avg_minutes: number | string;
  p50_minutes: number | string | null;
  samples: number;
}

/** walk_times 行（读端最小列集） */
export interface WalkTimeRow {
  place_id: number;
  station_code: string;
  zone: string | null;
  minutes: number | string | null;
  samples: number;
  /** ★ v1.2.0：高德步行路径距离（米）；NULL = 未知（此时档 1 退回线性） */
  distance_m?: number | string | null;
}

/**
 * ★ station_walk_distance 行（v1.2.0）
 * 与 `walk_times` **分层**存储：距离是「外部事实」（慢变、可增量抓），
 * minutes 是「派生值」。读端分开索引 —— 即使某组还没有实测样本，
 * 只要抓过距离，档 1 的衰减就能算 ✓
 */
export interface StationWalkDistanceRow {
  place_id: number;
  station_main: string;
  zone: string | null;
  distance_m: number | string;
}

/** transfer_walks 行（v1.0.0 新表） */
export interface TransferWalkRow {
  from_station: string;
  to_station: string;
  minutes: number | string;
  samples: number;
  source: string;
}

// ─────────────────────────── 实时层 ───────────────────────────

/** 一辆在途巴士 → 到用户站的「区间」（秒，自 now 起算；下限 = 往短了算） */
export interface BusArrival {
  /** 还有 N 站 */
  stopsAway: number;
  /** DSAT 挂载站码（调试/展示用） */
  atStation: string;
  /** 车辆当前状态：'0' = 已离挂载站驶向下一站（在区间中）；'1' = 停靠挂载站 */
  status: string | null;
  /** 到用户站的区间下限（秒）：区间中 → 该跳算 0 */
  loSec: number;
  /** 到用户站的区间上限（秒） */
  hiSec: number;
  /**
   * ★ v3.5.0：到用户站的**单值点估计**（秒）——依据（优先级）：
   *   ① 在途 + 位置可用（区间进度模型）→ 首跳位置剩余 + 后续静态跳；
   *   ② 在途无位置 → sum − 首跳×0.5（区间中点的期望）；
   *   ③ 在站停靠 → sum。
   * 显示层统一用 `etaTextOf`：估时车（estimated）走区间，其余走「约 X 分钟」单值。
   */
  etaSec?: number;
  /** ★ v3.5.0：true = 该值来自「未发车·班距估算」（无在途车）——显示保持「约 X~Y 分」 */
  estimated?: boolean;
  /** 区间下限对应的「跳数」（用于文案） */
  hopMin: number[];
}

/** 单车次实时视图（巴士） */
export interface BusLive {
  kind: "bus";
  route: string;
  /** true = 该方向无任何在途车（不在运营时间 → 整条方案排除） */
  empty: boolean;
  nearest: BusArrival | null;
  second: BusArrival | null;
  /**
   * ★ v1.1.4：第 **3 辆起**的候选（升序，可能为空数组）。`nearest` + `second` + `more`
   * = 「**还没到用户上车站**」的全部在途车，**不设条数上限**。
   *
   * 动机：原先只看 `nearest`/`second` 两辆 —— **两辆都赶不上就整条剔除**，
   * 实测高峰期「第 3 辆 3 分钟后到」的路线被白丢。
   * ⚠️ 已过站的车（`EtaBus.passed`，环线按绕一圈计）**不进池**：它们往往要等一整圈，
   *   留着会让「赶不上就整条剔除」名存实亡。
   * ⚠️ 放宽是**纯增益**：`service.ts` 是「按总用时升序取前 5」，等待更久的路线只会排到后面
   *   （要么填满空位、要么不显示），**不会挤掉更优的方案**。
   */
  more: BusArrival[];
  /**
   * ★ 2026-09-21 新增：**未发车时的等待时间估算**（仅当 `nearest`/`second`/`more` 全空时才给）。
   *
   * 解决什么（实测事故）：在**起点站**等车时，本方向的车「都已发出去」⇒
   * `empty = true` ⇒ 整条方案被剔除（例：26A 黑沙海灘 28 分直达被剔，只剩 70~83 分的绕路方案）。
   * 但此时**并非真的没车** —— 用「发车间隔（`route_frequency`）」+「已过站班车跑了多远」可反推
   * 下一班大约何时到。
   *
   * ⚠️ 一律是**区间**且**估算**（DSAT 不提供发车时刻表）⇒ UI 必须写「约 X 到 Y 分钟」。
   * ⚠️ 本字段**暂不参与排序**（主人选的两步走：先展示、观察准确性，再开排序）。
   */
  waitEstimate?: WaitEstimate;
}

/** 未发车线路的等待时间估算（区间，分钟） */
export interface WaitEstimate {
  /** 等待下限（分钟，≥0） */
  loMin: number;
  /** 等待上限（分钟，≥ loMin） */
  hiMin: number;
  /**
   * 估算依据：
   *   · `passed`  = 用**已过用户站的班车**反推「上一班何时经过」+ 发车间隔（较准）
   *   · `headway` = 无已过站班车可用 ⇒ **只用发车间隔**做保守区间 `[0, hi]`（较粗）
   */
  basis: "passed" | "headway";
  /** 诊断：命中的发车间隔区间（分钟） */
  headwayLo: number;
  headwayHi: number;
  /** 诊断：据上一班已过站班车推算出的「已过去时长」（分钟）；`basis='headway'` 时无 */
  sinceLastMin?: number;
  /** 诊断：命中的时段（如 `20:00-01:15`） */
  span: string;
}

/** 单车次实时视图（轻轨；时刻表本地算，无网络） */
export interface LrtLive {
  kind: "lrt";
  route: string;
  state: "running" | "before_first" | "after_last" | "no_data";
  /** 后续发车绝对毫秒（升序，含跨午夜续班；只保留未来若干班） */
  departures: number[];
  /** 发车时刻 'HH:MM'（与 departures 一一对应，供展示） */
  clocks: string[];
  /**
   * ★ v3.2.0：与 `departures` **一一对应**的「是否秒级精准」标记
   *   （氹仔线模式命中 / 石排湾·横琴线路级 → true；回落分钟级 → false）。
   *   缺省/长度不足时按 false 处理（分钟级窗口）。
   */
  precise?: boolean[];
  directionName: string | null;
  lineCode: string;
}

export type RouteLive = BusLive | LrtLive;

// ─────────────────────────── 视图（传到客户端） ───────────────────────────

/** 步行视图 */
export interface WalkLegView {
  minutes: number;
  /** 展示标签（如「C653 金峰南岸」） */
  toLabel: string;
  /** 命中层级：1 = (place,主码,zone) · 2 = (place,主码,NULL) · 3 = 该地点均值 · 4 = 全表均值 · 5 = 常数 */
  level: number;
  /** level ≥ 3 → UI 标「估算」 */
  estimated: boolean;
  samples: number;
  /**
   * ★ v1.2.0：该段步行路径距离（米）；`null` = 未知。
   * 来源 `station_walk_distance`（高德步行路径规划）。**仅用于档 1 的随距离衰减**，
   * 不参与 minutes 的计算（minutes 仍是实测均值 / 距离推算值）。
   */
  distanceM?: number | null;
}

/** 载具段视图 */
export interface RideLegView {
  route: string;
  kind: "bus" | "lrt";
  board: string;
  alight: string;
  boardLabel: string;
  alightLabel: string;
  /**
   * ★ v3.3.0（AC-103）：**轻轨段方向名**（终点站展示名，如 `氹仔碼頭`；前端渲染为 `{終點}方向`）。
   *   来源 = 该段线路的 `LrtLive.directionName`（`live.ts` 已下发）；巴士段为 `null`。
   */
  directionName?: string | null;
  /**
   * ★ v3.3.0（AC-105 营运判据）：该轻轨段的实时状态（取自 `LrtLive.state`）。
   *   仅轻轨段非空；`'running'` = **当前营运中**（有可赶班次）。轻轨优先**只认 running**，
   *   `before_first`（当日首班前）/`after_last`（已收车）/`no_data` 一律**不得**置顶（收班后只能赶
   *   次日首班 ⇒ 静默按常规排序）。巴士段 `undefined`。
   */
  lrtState?: "running" | "before_first" | "after_last" | "no_data";
  /** 车上用时（分钟） */
  minutes: number;
  /**
   * ★ v2.3.0（B5.2）：**轻轨固定乘车时长的秒级展示串**（`"1分40秒"` / `"2分15秒"`）。
   *   **仅轻轨且为固定秒数线**（`LRT_RIDE_SEC_FIXED`）时非空；巴士、氹仔线（跳数×120s）为 `undefined`。
   *   ⚠️ **仅展示**：排序 / 合计 / 赶车模型仍用 `minutes`（数值不因它改变）。
   *   前端取值规约：`r.kind === "lrt" && r.rideSecText ? r.rideSecText : \`${Math.round(r.minutes)} 分\``。
   */
  rideSecText?: string;
  /** 跳数 */
  hops: number;
  /**
   * ★ 修复包 v2.2.1-B2：**同一段内的并行可选线路**（同站上、同站下 → 渲染用白斜杠 `/`）。
   *
   * ⚠️ **生产者待接（已知阻塞）**：`src/lib/amap/transit.ts:230` 现只取 `segments[].bus.buslines[0]`
   * 作骨架、其余并行线被丢弃。要填充本字段，必须先把同段其余**高德线路名**经
   * 「高德线路名 → 本库线路码」的映射（服务端 `station_amap_map` / 路由别名，DB 支撑）转成
   * **本库码** —— 否则会把高德名当线路码渲染出**错误的彩色标签**，比不显示更糟。
   * 未接上之前**留空**：渲染层（`RouteStack` 的 `segments`）已就绪，空数组与当前行为**完全一致**。
   * 另：只保留线路名/上下站摘要，**不得保留 polyline**（02 §6 坑#2：会掉方案数）。
   */
  parallelRoutes?: string[];
  /** 各跳命中层级（bus；lrt 为空数组） */
  levels: number[];
  /** 本段等车（分钟，**已含在总用时内**；第 2 段起同样是真实推进值，不再恒 0） */
  waitMin: number;
  /**
   * 实时报站主文案。
   * ⚠️ 轻轨首段恒为 `""` —— 它的倒计时由 `<LrtEtaInline>`（客户端每秒重算）承担，
   *    服务端再下发一份冻结文案会让同一行出现两个数字（见 model.ts 注释）。
   * 第 2 段起：轻轨 = 「HH:MM 開出」（就是你会坐的那一班）；巴士 = 「按班次間隔估算」。
   */
  liveText: string;
  /**
   * 实时报站结构化数据（轻轨**首段**才有 → 客户端读秒用）。
   *
   * ★ v1.1.3 口径（保留）：班次以「走到站台之后」（`d > now + 步行分钟`）为主体——
   *   旧版原样下发全部班次，客户端取第一班 → 显示的是「马上就要开、但你还在路上」那班，
   *   与模型实际采用的那班不是同一趟（用户实测发现「显示的不是能赶上的班次」）。
   * ★ 2026-09-27（用户需求 2）：**数组首项放宽为「到达前最近一班」**（前班，含已发/赶不上者）——
   *   前班数据供客户端邻班区显示「前一班」；主班定位改用 `liveMainMs`（不再依赖「第一项」）。
   * ★ 2026-09-27（用户需求 1/3）：**第 2 段起同样下发**（换乘处报时 + 邻班显示），
   *   参照系 = 「到达换乘站 + 安全余量」；`liveMainMs` = 模型选中的那班。
   */
  liveDepartures?: number[];
  liveClocks?: string[];
  /**
   * ★ 2026-09-27（用户需求 2）：**本段主班时刻（ms）**——模型实际采用的那一班。
   *   客户端 `<LrtEtaInline>` 据此定位主班（`liveDepartures` 内早于它的项 = 「前一班」）；
   *   主班发车后客户端自动滚向后续班次（每秒重算）。
   */
  liveMainMs?: number;
  /**
   * ★ v3.2.0：与 `liveDepartures` 一一对应的「是否秒级精准」（首段与换乘后轻轨段均下发）。
   *   供 `<LrtEtaInline>` 统一窗口/文案（AC-68/69/70）：`secPrecise` →
   *   到站阈值逐线（氹仔 30s / 石排湾 120s / 横琴 60s）、归零保持 10s；
   *   否则按分钟级（窗口 30s、归零保持 30s）。
   *   缺省/长度不足 → 全部按 false（分钟级）安全回落。
   */
  livePrecise?: boolean[];
  /** 赶车档（仅首段有；第 2 段起恒 null） */
  tier: CatchTier | null;
  /** 档位文案（仅首段非空；第 2 段起为 ""） */
  tierText: string;
  /**
   * ★ v1.1.2：档位差额提示（如「需較常速快 2.5 分」）。
   *
   * 仅**首段**、且档位为 **1~2**（要比常速更快才赶得上）时非空。理由：
   * 卡面那一行「步行 X 分」显示的是**常速实测均值**，而顶部大字按该档速度算
   * → 可见项直接相加会比大字**大**（实测最多约 4 分钟）。大字没错，缺的是一句解释。
   * ⚠️ 字段挂在 `rides[0]`（档位属于首段载具），但**渲染在卡面第一行「步行」上**。
   */
  tierHint: string;
  /**
   * ★ v3.3.0（需求 5 / AC-107）：**赶车提示**（保守措辞）。
   *
   * 触发（`model.ts`）：**轻轨首段**且 `tier ∈ {1,2}`（正常档赶不上、提速档可赶上）且**有该班真实时刻**。
   * 文案：`走快一点可赶上 ${clock} 那班`（**禁「一定」**；无真实时刻不产出 ⇒ `undefined`）。
   * 渲染：`RecommendCard` 以 `<TierBadge>` 呈现；**只在方案卡**（不进导航站条）。
   * ★ v3.7.0 S4：本字段是**全站唯一还会渲染**的赶车胶囊内容（v3.7.0 起 `TierBadge`
   *   只认 `catchHint`，速度档文案 `tierText` 与档位色阶全部隐藏）。
   */
  catchHint?: string;
}

/** 换乘视图 */
export interface TransferView {
  at: string;
  atLabel: string;
  minutes: number;
  estimated: boolean;
  /** 同站台/同场 → 文案「同站台 · 无需步行」 */
  sameField: boolean;
  /**
   * ★ B4（需求 7）：**该换乘之后第 2 段的等车分钟**（＝下一段 `RideLegView.waitMin` 同值）。
   *
   * 口径：按「到达换乘站的时刻」查 `route_frequency`（`headwayAt`），取**偏保守**值
   *   `(lo + 2·hi) / 3`（见 `headway.ts#conservativeWaitMin`）；
   *   未命中 → 该线全时段班距中位数（`headwayMedian`）→ 仍无 ⇒ `null`（**明示降级，不得拍脑袋**）。
   * 缺省（`undefined`）＝ 该字段未参与本轮计算；`null` ＝ 数据缺失。
   */
  waitMin?: number | null;
  /**
   * ★ B4（需求 7）：换乘余量（分钟）—— 语义分两种，**仅在模式内可比**。
   *
   * ── 轻轨第 2 段 ⇒ **确定性余量** ────────────────────────────────────────
   *   `下一班发车时刻 − 到达换乘站时刻`（真实时刻表），恒 ≥ 0。
   *   ⚠️ 不保证 ≥ `TRANSFER_SAFETY_MIN(3)`：`need = cursor` 是刻意口径（2026-09-27 已证伪
   *   「`need = cursor + 3`」—— 那会让明明能赶上的早班被跳过）。
   *   **安全余量只进评分与文案，绝不进可行性筛选。**
   *
   * ── 巴士第 2 段 ⇒ **保守余量**（无班表，算不出真实间隔）──────────────────
   *   三档（与 `07` §h.3 对齐）：
   * ```
   * ① headwayAt 命中时段行  ⇒ max(0, 2·lo − hi)      // lo/hi = 到达换乘站时刻命中的班距区间
   * ② 未命中、中位数可用    ⇒ 0                       // 区间丢了 = 最不确定
   * ③ 连中位数都没有        ⇒ SLACK_NO_DATA           // 待测量，默认 0 ≈ tight
   * 同场换乘（sameField）   ⇒ **不写该字段**（undefined）
   * ```
   *   · 上界：`lo ≤ hi` 时 `2·lo − hi` 天然 `≤ lo`（实测全表无 `hi < lo` 脏行），
   *     无需额外夹取；代码里保留一次夹取仅作防御（对合法数据是恒等变换）。
   *   · 恒 ≥ 0 ⇒ 巴士换乘**永不判 `no`**，最差 `tight`（班距数据只能支持「不确定」，
   *     不支持「赶不上」）。推导与实测分布见 `./transfer-slack.ts`。
   *   · **同场换乘必须保持 `undefined`（不是 `0`）**：`0` 会走 `slack < 3 ⇒ tight`，
   *     把澳门最常见的同站台换乘全染红；且 A4 断言要靠 `undefined` 区分「同站台」与「无数据」。
   *     轻轨同场换乘仍写真实 `gapMin`（有班表 ⇒ 间隔可知，属既有线上行为，别为对称清空）。
   *
   * ── 两模式混用同一个 risk 公式的边界 ────────────────────────────────────
   *   `score.ts#costOf` 用 `risk = riskFactor × max(0, 3 − slack)` 消费两者 ⇒
   *   巴士方案与轻轨方案的 `cost` 差额**不可解释为「谁更靠谱」**。跨模式翻转只发生在
   *   `totalMin` 差 ≤1 分的并列区，且胜出方是轻轨（方向正确）。
   *   **`riskFactor ≤ PREF_ALPHA/2 = 5` 是安全边界**（当前 0.5），否则可行性会盖过换乘次数。
   *
   * ── H8 `data-transfer-feasible` 映射（`RecommendCard.tsx:52` 用 `== null`，勿收窄）──
   *   `null`/`undefined` ⇒ `yes`；`0` ⇒ `tight`；`(0,3)` ⇒ `tight`；`≥3` ⇒ `yes`；
   *   `<0` ⇒ `no` —— **代码上不可达**（轻轨 `gapMin`、巴士本字段均 ≥0），不得作告警依据。
   *   `slackMin = 0` 同时代表「真零余量」与「极端不确定」（P2 不做区分）⇒
   *   **任何文案都不得声称确定性**（禁「只剩 X 分」「很赶」「来不及」）。
   */
  slackMin?: number | null;
}

/**
 * ★ v1.1.5：**本班之外的后续班次**（卡内列出，不另开卡）。
 *
 * 用户口径（2026-09-16）：
 *   「如果第二辆还有很久到就没有意义 → 限制：坐这一班的话，**门到门总时长要不差于
 *     五张卡片方案中的第五张**；并且不止列后面一班，应列出**所有**满足该条件的车；
 *     车的右边标注**怎样能赶上的分档**。」
 *
 * 场景动机：本班要求冲刺（档 1~2）时，后面「正常走就能赶上」的车原本完全不展示
 *   → 不想跑的用户以为这条线没戏，转去选慢得多的方案。
 */
export interface AltBusView {
  /**
   * ★ v2.3.0（A3）：该后续班次所属**线路码**（并行线分组用 —— 同一显示卡下
   *   主干线 + 各 `parallelRoutes` 的后续班次合并下发，前端按 `route` 分组列出）。
   */
  route: string;
  /** 还有 N 站 */
  stopsAway: number;
  /** 「約 lo~hi 分」——服务端算好，与主行同口径（`rangeText`） */
  waitText: string;
  /** 赶这一班的档位（1~5，恒非 null —— 赶不上的已在服务端剔除） */
  tier: CatchTier;
  /** 档位文案（如「正常走能赶上」） */
  tierText: string;
  /** 若乘这一班，门到门总时长（分钟）——用于「不差于第五张卡」的筛选 */
  totalMin: number;
}

export interface RecommendCard {
  planId: number;
  summary: string;
  fromSlug: string;
  toSlug: string;
  /** 总用时（分钟，含等车；门到门） */
  totalMin: number;
  /** 预计到达时刻（ms） */
  arriveAt: number;
  walkOut: WalkLegView;
  walkIn: WalkLegView;
  rides: RideLegView[];
  transfers: TransferView[];
  /** 乘车提示（开发者模式关闭时点击卡片展开） */
  hints: string[];
  /** 是否跨境（标「不含通关」） */
  crossBorder: boolean;
  /**
   * ★ v1.1.5：本班之外的后续班次（已按「总时长 ≤ 第 5 张卡」筛过，按总时长升序）。
   * ⚠️ 由 `service.ts` 在排序取前 N **之后**回填 —— 因为筛选阈值依赖最终入选的第 5 张卡；
   *    `modelOption` 只能算出候选，无法知道阈值。
   */
  altBuses?: AltBusView[];
  /**
   * ★ v3.3.0（AC-105）：**轻轨优先已置顶**标记 —— 仅当 `/api/nav?lrtFirst=1` 生效
   *   且该卡为「命中并被置顶」的候选时为 `true`（前端据此显示「轻轨优先」角标；未触发不标）。
   */
  lrtPromoted?: boolean;
}

/* ══════════════════════════════════════════════════════════════════════════
   ★ v1.1.8：预测卡片**详情页**的视图类型（用户 2026-09-16 口径）
   · 站条 = 一趟一条；中间站默认收起；左侧线路主题色轨；中间站之间给模型预测行驶时间
   · 折叠栏 = 该站台**剩余所有可达线路**的报站（每条旁可链接到各自详情页）
   ══════════════════════════════════════════════════════════════════════════ */

/** 站条上的一个节点 */
export interface StripStop {
  code: string;
  /** 显示名（「C653 金峰南岸/金譽峰」；轻轨不带站号前缀） */
  label: string;
  /** 到下一站模型预测分钟（末站 = 0）；lrt 为表定逐跳值 */
  minToNext: number;
  /** 该跳的命中层级 1~6（≥3 = 估算/兜底 → UI 标「估算」）；末站 = 0 */
  level: number;
  /** 是否上车站 / 下车站（UI 默认展开这两端） */
  role: "board" | "alight" | "mid";
}

/** 一段载具的纵向站条（**一趟一条**） */
export interface SegmentStrip {
  route: string;
  kind: "bus" | "lrt";
  board: string;
  alight: string;
  boardLabel: string;
  alightLabel: string;
  /**
   * ★ v3.3.0（AC-103）：**本段方向名**（终点站展示名，如 `氹仔碼頭`；前端渲染 `{dirLabel}方向`）。
   *   仅轻轨段非空（取自 `RideLegView.directionName`）；巴士段 `null`。
   */
  dirLabel?: string | null;
  /**
   * ★ v3.3.0（AC-102）：**上车站实际可乘班车**（本库线码）。
   *   四规则（保守，宁回落主干不显错线）：① 主干**常速**可赶 → 主干；② 需提速才赶得上（`tier<3`）
   *   且 `altBuses` 有可赶并行线 → 取其中最早者；③ 无法判定 / 无并行线 / 数据缺失 → **回落主干**。
   *   前端 `boardRoute ?? strip.route` 消费。仅**首段**（上车站语义）有意义。
   */
  boardRoute?: string;
  /** 上车站 → 下车站的有序节点（含两端） */
  stops: StripStop[];
  /** 车上时长（**与 `card.rides[i].minutes` 同源同值** —— 同一串 hops + 同一个 lookupHop） */
  rideMin: number;
  /**
   * ★ v2.3.0（B5.2）：轻轨固定乘车时长的**秒级展示串**（`"1分40秒"` / `"2分15秒"`）。
   *   与 `RideLegView.rideSecText` **同源**（由它回填）：**仅固定秒数线非空**；
   *   巴士、氹仔线为 `undefined`（走原「X 分」）。**仅展示**，不影响 `rideMin`。
   */
  rideSecText?: string;
  /** 该段之后的换乘（最后一段为 null）—— 用户口径：巴士标上一趟终点 + 换乘站台；轻轨写明换乘步行时长 */
  transferAfter: TransferView | null;
  /**
   * ★ 2026-09-27（用户需求 3）：**换乘后一段（轻轨）的班次报时**——
   *   仅当下一段是轻轨且带班次数据时非空；供流程图（`NavStrip`）在换乘处渲染
   *   「换乘后线路」报时块（前端 `LrtEtaInline` 折叠式消费）。
   */
  nextLeg?: {
    route: string;
    /** 换乘后线路方向名（终点展示名，前端渲染 `{dirLabel}方向`） */
    dirLabel: string | null;
    liveDepartures: number[];
    liveClocks: string[];
    livePrecise?: boolean[];
    /** ★ 2026-09-27（用户需求 2）：换乘后线路的主班时刻（ms） */
    mainMs?: number;
  } | null;
}

/**
 * ★ 需求1 / 1-B′：`POST /api/nav/remaining` 的响应（**纯新增类型，不影响任何既有消费方**）。
 *
 * 用途：导航中点刷新时，**只在当前这条路线内**重算剩余时间（不重新规划、不切换路线）。
 * 服务端算法见 `src/lib/nav/remaining.ts`；本端点 0 次 DSAT、0 次高德。
 *
 * ⚠️ **为什么同时给三个时间字段**（少一个都会退化成老问题）：
 *   · `remainingMin` 是**相对快照** —— 命中服务端 2s 微缓存时会偏大，
 *     只能用于显示，**不得**当作倒计时真相；
 *   · `arriveAt` 是**绝对锚**（epoch ms）—— 客户端据此本地递减，免疫网络往返与缓存陈旧；
 *   · `serverNowMs` 是服务端当前时刻 —— 客户端算 `offsetMs = serverNowMs − Date.now()`
 *     后再用 `arriveAt − (Date.now() + offsetMs)`，即 `/api/station/eta` 的现成范式
 *     （该处注释记了这个坑：旧口径 `etaSec` 相对快照命中 20s 缓存时整体偏大）。
 *   · `recomputedAt` = 本次重算的基准时刻；命中微缓存时**早于** `serverNowMs`，
 *     客户端据此可知 `remainingMin` 的陈旧量（≤ 服务端 TTL）。
 */
export interface RemainingResponse {
  ok: true;
  /** 剩余门到门分钟（服务端已 clamp 到 ≥0，永不为负） */
  remainingMin: number;
  /** 预计到达时刻（epoch ms，绝对锚 —— 倒计时以此为准） */
  arriveAt: number;
  /** 本次重算的基准时刻（epoch ms；命中微缓存时 = 原重算时刻） */
  recomputedAt: number;
  /** 服务端当前时刻（epoch ms；供客户端算时钟偏移） */
  serverNowMs: number;
  /**
   * **整份**替换用的纵向站条（`buildStrips(patchedCard)` 产物）。
   * 其中 `rideMin` 已是「剩余」、`transferAfter.waitMin` 已按新到达时刻重估 ⇒
   * 顶部倒计时与纵条数字**同源同帧**，不会出现「上面在动、下面冻住」。
   */
  strips: SegmentStrip[];
}

/** 折叠栏里一行 = 该站台一条可达线路 */
export interface ReachReport {
  route: string;
  kind: "bus" | "lrt";
  boardLabel: string;
  alightLabel: string;
  /** 实时报站主文案（「還有 3 站 · 約 4~6 分」/「15:32 開出」） */
  liveText: string;
  /** 轻轨读秒用（与卡片首段同口径，只含「走到站台之后」的班次） */
  liveDepartures?: number[];
  liveClocks?: string[];
  /**
   * ★ v3.2.0：与 `liveDepartures` 一一对应的「是否秒级精准」（折叠栏同口径，AC-70）。
   *   供折叠栏读秒与站台卡窗口/文案**同源**；缺省/长度不足 → 全部按 false（分钟级）。
   */
  livePrecise?: boolean[];
  /** 该线在本站台的全部可行下车点 */
  alightCandidates: string[];
  /**
   * 门到门总时长（分钟）。
   * ⚠️ `null` 有**两种**成因，必须配合 `inPlan` 区分（v1.1.8 修正）：
   *    · `inPlan === false` → **该线不在任何在用方案表里**（没有 seed）→ 永远算不出总时长
   *    · `inPlan === true`  → 在方案表里，但**本轮没有在途车**（收车/不在营运时段）→ 暂时算不出
   *    两者在 UI 上文案不同（「未收錄於方案」vs「暫無實時車」），**不可混为一谈**。
   */
  minutes: number | null;
  /** 该线是否出现在在用方案表里（有 seed ⇒ 有实时车时就能算出门到门总时长） */
  inPlan: boolean;
  tier: CatchTier | null;
  tierText: string;
  /** 该线自己的详情页地址（`/card?...`）；无法定位时为 null */
  href: string | null;
  /** false = 本轮没拿到实时数据（超时 / 收车 / 不在营运时段） */
  live: boolean;
}

/**
 * ★ 2026-11-04（需求 U9）：**备选下车点**（同一条线、同一上车站，但下车站不同）。
 *
 * 只在**详情页**出现（`card.alightOthers`），**不进卡片列表** —— 卡片列表口径是
 * 「一卡一个下车点」（`converge.ts`）。点选后走同一份 URL 契约（`buildCardHref`）
 * 重新进详情 ⇒ 不需要新状态机。
 */
export interface AlightOption {
  /** 原始站码（带站台号，如 `C690/3`）—— URL 契约与命中四元组都用原始码 */
  code: string;
  /** 展示文案：`站码 站名` */
  label: string;
  /** 该下车点的详情页地址（`/card?...&alight=<code>`） */
  href: string;
}

/** `/api/card` 的完整返回 */
export interface CardDetailPayload {
  fromSlug: string;
  toSlug: string;
  zone: SchoolZone | null;
  /** 命中的那张卡（含 altBuses） */
  card: RecommendCard;
  colors: Record<string, string>;
  /** 每段载具的站条（一趟一条） */
  strips: SegmentStrip[];
  /** 折叠栏：该站台剩余所有可达线路（含本卡自己，按 minutes 升序、null 排最后） */
  reports: ReachReport[];
  /**
   * ★ 2026-11-04（U9）：同线同站的**其他**下车点（已排除当前这张卡的那个；上限见 `limits.ts`）。
   * 空数组 = 该线在这个上车站只有这一个下车点（常态）。
   */
  alightOthers: AlightOption[];
  /** 筛选阈值 = 第 N 张卡的总时长（用户口径「速度優於五張卡片最慢方案」） */
  thresholdMin: number;
  generatedAt: number;
  /** true = 折叠栏那一批实时数据整体超时/失败 → UI 应提示「實時報站暫不可用」 */
  liveDegraded: boolean;
}
