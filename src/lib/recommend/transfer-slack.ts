/**
 * 换乘「保守余量」计算（src/lib/recommend/transfer-slack.ts，需求 7 · v3.6.1 新增）
 *
 * ── 这个文件解决什么问题 ──────────────────────────────────────────────
 *   第 2 段是**巴士**时，我们没有逐车时刻表（DSAT 只给在途车，没有班表）⇒
 *   换乘可行性的「余量」（`TransferView.slackMin`）原本是 `null`。
 *   而 `score.ts#costOf` 明写「`slackMin === null` ⇒ 不加风险项」
 *   ⇒ **30 秒换乘零惩罚**，「不合理换乘也能排第一」的根因就在这里。
 *
 * ── 三档取值（★ 与 `docs/迭代-导航优化-20260926/07` §h.3 对齐，别只实现第 1 档）──
 *   ```
 *   ① headwayAt 命中时段行      ⇒ slackMin = max(0, 2·lo − hi)
 *   ② 未命中、中位数可用        ⇒ slackMin = 0                （区间丢了 = 最不确定）
 *   ③ 连中位数都没有            ⇒ slackMin = SLACK_NO_DATA     （待测量，默认 0 ≈ tight）
 *   同场换乘（sameField）        ⇒ **不写该字段**（undefined ⇒ H8 = yes，见下）
 *   ```
 *   本文件只负责 ①；②③ 在 `model.ts` 的三档 if/else 里赋值（因为要读 `headwayMedian`）。
 *
 * ── 语义边界（**必读，改动前先看这段**）────────────────────────────────
 *   · 轻轨的 `slackMin` 是**确定性余量**：`下一班发车时刻 − 到达换乘站时刻`（真实时刻表）。
 *   · 巴士的 `slackMin` 是**保守余量**：由班距区间推出的「时序确定度」，**不是真实间隔**。
 *   ⇒ 两者喂同一个 `risk = 0.5 × max(0, 3 − slack)` 公式，
 *     **风险项只在同模式内可比**（巴士 vs 巴士、轻轨 vs 轻轨）。
 *     跨模式翻转只发生在 `totalMin` 差 ≤1 分的并列区，且胜出方是轻轨（方向正确）。
 *
 * ── `slackMin = 0` 的双重含义（P2 **不做区分**）──────────────────────────
 *   `0` 同时代表「真的零余量」与「极端不确定」，H8 `data-transfer-feasible` 两者都派生
 *   `tight`。要区分得新增 `uncertain` 字段 —— 属契约变更，v3.7 再说。
 *   ⇒ 因此**任何文案都不得声称确定性**（禁「只剩 X 分」「很赶」「来不及」）。
 *
 * ── H8 `data-transfer-feasible` 映射（`RecommendCard.tsx:52`，别改成 `=== null`）──
 *   | `slackMin` | H8 |
 *   |-----------|-----|
 *   | `null` / `undefined`（未参与计算 / 同场换乘） | `yes` |
 *   | `0` | `tight` |
 *   | `(0, 3)` | `tight` |
 *   | `≥ 3` | `yes` |
 *   | `< 0` | `no` —— **代码上不可达**（轻轨 `gapMin ≥ 0`、巴士本节恒 `≥ 0`），不许当告警依据 |
 *
 * ── 调参红线（PM 会按这个审）─────────────────────────────────────────────
 *   单次换乘 risk 硬上界 = `riskFactor(0.5) × safetyMin(3) = 1.5` 分，
 *   而 `PREF_ALPHA = 10` 分/换乘（`score.ts:45`）⇒ risk 恒 < α 项的 **15%**，
 *   不可能淹没 cost。**`riskFactor ≤ α/2 = 5` 是安全边界**（当前 0.5，10 倍余量）；
 *   超过 5 会让「换乘可行性」盖过「换乘次数」这个更硬的判据。
 *
 * ⚠️ 本模块**不参与** `totalMin` 的任何计算。改这里只会改 `cost` / 排序 / 风险字段。
 * ⚠️ client-safe 纯模块：只 import 类型，不 import 任何含 pg 的运行时模块。
 */
import type { HeadwayHit } from "./headway";

/**
 * 主公式中「区间宽度」的权重（可审计常量）。
 *
 * `base = max(0, W × lo − hi)`，`W = 2` 为架构师冻结值：
 *   · `W = 1` ⇒ `lo − hi ≤ 0` 恒成立 ⇒ 全部为 0（等于没做，无法区分）；
 *   · `W = 2` ⇒ 只有「宽度不到下限一半」的窄区间才拿到余量；
 *   · `W = 3` ⇒ 过宽，几乎全部行都拿满余量（等于没罚）。
 * 实测（2026-10-30，`route_frequency` 507 行非 special，`2·lo − hi` 分布）：
 *   `= 0 及以下` 43 行（8.5%）· `1~2` 59 行（11.6%）· `≥ 3` 405 行（79.9%）；
 *   含「被罚行」的线路 34 条。
 *
 * ⚠️ 已否掉的替代方案：把 slack **夹到 `lo`**（反例：宽桶 lo=8/hi=25 夹到 8 > 3 ⇒ risk 仍 0，
 *   等于没护栏）。`2·lo − hi` 在 `lo ≤ hi` 时天然 `≤ lo`，无需另夹。
 */
export const BUS_SLACK_SPREAD_WEIGHT = 2;

/**
 * 桶尾截断开关（★ 默认 **关闭** = 与冻结公式 `max(0, 2·lo − hi)` 完全一致）。
 *
 * ── 它想解决什么 ──────────────────────────────────────────────────────
 *   `route_frequency` 是**运营商时段表**（实测 507 行、时段宽 50~1080 分、中位 300 分），
 *   桶内**不含相位**（不知道上一班何时发出）⇒「第一趟晚到 8 分钟、刚好错过第二班」
 *   在桶内**物理上不可知**。桶内唯一合法时序信息 = **到达点距时段尾的余量**：
 *   距时段结束不足一个 `hi` 时，「你等的下一班」可能已按**下一时段**的班距发出。
 *
 * ── 为什么默认关 ──────────────────────────────────────────────────────
 *   架构师冻结的实现契约是纯 `max(0, 2·lo − hi)`（不带到达时刻），`07` 文档与 PM 的
 *   A4 断言都按它写。默认关 = **代码与文档逐字一致**，避免再一次口径分叉。
 *   打开后 `slack = min(base, toMin − arrivalMin)`，使「同一桶内不同到达时刻」产生不同
 *   风险值（这正是「桶内盲区」唯一能不动物理粒度的修法），代价是偏离文档公式。
 *   ⇒ **开关权在主控**。原决策依据是 `scripts/compare-slack-impact.ts` 的实测差异，
 *   ★ 2026-11-06：该脚本已删，**复测入口已移除** —— 打开前请参考 git 历史重建对比脚本。
 */
export const SLACK_SPAN_EDGE_ENABLED = false;

/** 巴士换乘余量的三段拆解（诊断/对拍用；只有 `value` 进 `slackMin`） */
export interface BusSlackParts {
  /** 主口径 `max(0, W·lo − hi)` */
  base: number;
  /** 桶尾截断后的上限（`Infinity` = 不受桶尾约束）；`SLACK_SPAN_EDGE_ENABLED=false` 时恒 Infinity */
  boundaryCap: number;
  /** 距时段结束的分钟（跨午夜已对齐；可能为 0） */
  minsToSpanEnd: number;
  /** 最终余量 = `min(base, boundaryCap)`，恒 ≥ 0 */
  value: number;
}

/**
 * 巴士换乘「保守余量」明细（档 ①）。
 * @param hit `headwayAt()` 的命中结果（含 `fromMin/toMin/arrivalMin`，供桶尾截断用）
 */
export function busSlackPartsOf(hit: HeadwayHit): BusSlackParts {
  const lo = Math.max(0, hit.lo);
  const hi = Math.max(0, hit.hi);

  // ⚠️ 表内实测无 `hi < lo` 脏行（2026-10-30 全表 = 0 行）；此夹取仅作防御，
  //    对合法数据是恒等变换（`lo ≤ hi` ⇒ `2·lo − hi ≤ lo`）。
  const base = Math.max(0, Math.min(BUS_SLACK_SPREAD_WEIGHT * lo - hi, lo));

  const minsToSpanEnd = Math.max(0, hit.toMin - hit.arrivalMin);
  const boundaryCap = !SLACK_SPAN_EDGE_ENABLED
    ? Number.POSITIVE_INFINITY
    : minsToSpanEnd >= hi
      ? Number.POSITIVE_INFINITY
      : minsToSpanEnd;

  return { base, boundaryCap, minsToSpanEnd, value: Math.min(base, boundaryCap) };
}

/**
 * 巴士换乘「保守余量」（分钟，档 ①）——写进 `TransferView.slackMin`。
 *
 * ⚠️ 恒 ≥ 0 ⇒ 巴士换乘**永不判 `no`**（`slackMin < 0` 才判 no），最差只到 `tight`。
 *    这是刻意的：班距数据只能支持「不确定」，不支持「赶不上」。
 */
export function busTransferSlackMin(hit: HeadwayHit): number {
  return busSlackPartsOf(hit).value;
}

/* ══════════════════════════════════════════════════════════════════════════
   ★ 诊断钩子（**默认空实现，零行为影响**）：供对比脚本统计三档命中情况。
   ──────────────────────────────────────────────────────────────────────────
   为什么需要：档 ③（连 `headwayMedian` 都没有）的占比只能在实际赋值处统计，
   事后从卡片反推不出来（`slackMin=0` 三档都可能产生）。
   为什么不做成 `ModelContext` 字段：那会扩模型上下文契约；这里是一个可选的旁路
   sink，生产环境没人注册 ⇒ 只是 3 次空函数调用。
   ══════════════════════════════════════════════════════════════════════════ */
/**
 * 档位标签（诊断用）：
 * · `hit` 档 ①（命中时段行 → `max(0, 2·lo − hi)`）
 * · `median` 档 ②（中位数兜底 → `0`）
 * · `noData` 档 ③（无任何班距数据 → `SLACK_NO_DATA`，待测量）
 * · `sameField` 同场换乘（**不写该字段** ⇒ `undefined` ⇒ H8 `yes`），单列出来才数得清
 */
export type SlackTier = "hit" | "median" | "noData" | "sameField";

export interface SlackTierSample {
  tier: SlackTier;
  route: string;
  /** `sameField` 档为 `null`（无语义） */
  slackMin: number | null;
  /** 档 ① 才有 */
  lo?: number;
  hi?: number;
}

export const slackTierSink: { on?: (s: SlackTierSample) => void } = {};
