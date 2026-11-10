/**
 * 长停站判据的**对外契约**（src/lib/rebuild/long-stop-types.ts，v3.6.0）
 *
 * 为什么单独成文件：`LongStopPolicy` 是 `long-stop.ts` 与两个消费方
 * （`segment-stats.ts` / `scripts/build-hop-stats.ts`）之间的数据契约，
 * 字段会随判据门增加而增长。放在实现文件里会让那个文件越写越长（已逼近 300 行门禁），
 * 而契约本身是**只读接口**，与「怎么算」无关，独立成文件更清晰。
 *
 * ⚠️ 改这里等于改对外契约：新增门时同时更新 `SkipReason` 与 `LongStopPolicyStats`，
 *    并检查两个消费方的打印口径（`rebuild-segment-stats.ts` / `build-hop-stats.ts`）。
 */

/**
 * 站对被拦下的原因。
 *
 * ⚠️ **5 个枚举值里只有 3 个可达**，另 2 个是语义占位（结构上不会出现在
 *    `LongStopPolicy.skipPairs` 里）。写在这里是为了让「为什么没被排除」这件事有完整词表，
 *    避免下一个人以为「没出现在 skipPairs = 没被判过」。
 *
 * | 值 | 可达 | 原因 |
 * |---|---|---|
 * | `short` | ❌ 结构上不可达 | dwell < 阈值 的样本在 SQL 层就被 `WHERE COALESCE(dwell_b_min,0) >= LONG_STOP_MIN` 滤掉，**根本进不了判据**。它不是「门」，是候选集的定义。 |
 * | `mid-stop` | ❌ 不写入 skipPairs | 非总站在 `!terminus.has(mainOf(toMain))` 处直接 `continue`。它属于**候选集定义**（总站集合），不是运行期门；其数量由 `midStopPairs` **独立计数**。 |
 * | `headway-sync` | ✅ | 长停中位数 ≈ 该时段班距 ⇒ 计划性待发 |
 * | `insufficient` | ✅ | 逐桶 n < 5 或覆盖桶数 < 2 ⇒ 样本不足以判断 |
 * | `peak-crowded` | ✅ | 高峰占比 ≥ 0.8 ⇒ 排队 |
 *
 * ── 「什么情况下会变成可达」（被封存的路径，动到这些才需要改实现）────────────
 *   · `short`：**只有当有人把 `dwell ≥ LONG_STOP_MIN` 从 SQL 层挪进判据层时**才会可达。
 *     典型场景 = 做「阈值可调（3→2）」并选择在 JS 侧过滤。
 *     ⚠️ 届时**必须**把 `short` 真正写入 `skipPairs`，否则阈值调整会**静默失效**
 *        （新放进来的样本全部照排，因为没有任何分支给它们记账）。
 *   · `mid-stop`：**只有当总站集合改成「运行期判定」**（例如按线路动态算端点、
 *     而不是用 `terminus.ts` 预先算好的全澳并集）时才会写入 `skipPairs`。
 *     现状是全澳并集一次算好、O(1) 查表，没必要逐对记账。
 *
 * ── mid-stop 为什么必须**独立计数**而不是减法推导 ────────────────────────
 *   过去它被定义为 `candidatePairs − 各门命中 − 排除`，那等于「用减法定义自己」：
 *   任何「加了门却忘同步」的错误都会被减法**自动吸收** ⇒ 账永远平、
 *   数字静默变小却查不出来（2026-10-30 实测：把推导值代回恒等式**必成立**，属永真式）。
 *   ⇒ 现由 `midStopPairs` / `midStopStations` 在非总站分支**真数一遍**，
 *   并由 `build-hop-stats.ts` 断言 `候选 = 非总站 + 各门 + 排除`。
 *   只有独立计数，这道断言才有资格叫「自检」。
 */
export type SkipReason = "short" | "mid-stop" | "headway-sync" | "insufficient" | "peak-crowded";

/** 四计数 + 各门命中统计（供脚本并排打印） */
export interface LongStopPolicyStats {
  /** dwell ≥ 阈值的候选样本数 */
  candidates: number;
  /** 候选涉及的 (route, to_main) 站对数 */
  candidatePairs: number;
  /** 候选涉及的站点数（distinct to_main） */
  candidateStations: number;
  /** 真正判为「休息」→ 排除的样本数 */
  excludedSamples: number;
  /** 真正排除的站对数 */
  excludedPairs: number;
  /**
   * 非总站被短路掉的站对数 / 站数（**独立计数**，不是推导）。
   * ⚠️ 必须是真实计数：`build-hop-stats.ts` 用它做对账断言
   *    `候选 = 非总站 + insufficient + headway-sync + peak-crowded + 排除`。
   *    若改成减法推导，该断言退化为永真式，加门漏同步时不会报警。
   */
  midStopPairs: number;
  midStopStations: number;
  /** 各门拦下的站对数 / 站数（headway-sync / insufficient / peak-crowded） */
  headwaySyncPairs: number;
  headwaySyncStations: number;
  insufficientPairs: number;
  insufficientStations: number;
  peakCrowdedPairs: number;
  peakCrowdedStations: number;
  /** 门拦下（不排除）的样本数 */
  skippedSamples: number;
  /**
   * ★ v4.1.1 双档：dwell ∈ [3, 5) 且过全部门 → **只标记、仍进聚合**的样本数 / 站对数。
   * `markedPairs` 只数「**没有**排除档样本」的站对（与 `excludedPairs` 互斥），因此站对分区成立：
   *   `candidatePairs = midStopPairs + insufficientPairs + headwaySyncPairs + peakCrowdedPairs
   *                     + excludedPairs + markedPairs`  ← `build-hop-stats` 的对账断言用。
   * 样本层面则 `markedSamples` 与 `excludedSamples` 互斥且互补（同一站对可两种都有）。
   */
  markedSamples: number;
  markedPairs: number;
}
