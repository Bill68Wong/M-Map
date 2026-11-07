/**
 * 终态判定 · 方向敏感白名单（src/lib/cross-border/status.ts · 契约 §2.10）
 *
 * ── 这个文件存在的唯一理由 ────────────────────────────────────────────
 *   `after=now`（"该时刻后最近五班"）的正确性**完全**取决于"什么算已走完"。
 *   上游状态列是**自由文本**，任何 `includes('已啟航')` 式的包含判定，都会在
 *   上游改一个字后**静默失效** —— 不报错、不告警，只是永远不命中，
 *   表现为"最近五班永远是当日最早的 5 班"。这种故障没人会报 bug，
 *   只会被当成"数据没更新"（契约 §2.10 开篇原话）。
 *   ⇒ 用**逐条正则白名单**（匹配得到/匹配不到都是可断言的），不用包含判断。
 *
 * ── 三条反直觉事实（写错任何一条都是用户可见的错）──────────────────────
 *   ① `已啟航` 在**离澳**是终态（飞机已飞走，用户赶不上）；
 *      在**抵澳**恰恰是"马上到"（`已啟航 預計到達 21:30`）⇒ **必须显示**。
 *      两者共用一个终态判定 ⇒ 抵澳板会把所有即将落地的航班全部隐藏，
 *      而抵澳板空着"看起来很正常"，用户会以为今晚没有航班进港。
 *      ⇒ 判定必须按 (源, 方向) 分表，**不能按状态字面全局判**。
 *   ② 取消有两种写法：离澳 `已取消`、抵澳 `航班取消`。只匹配一个会漏掉整类。
 *   ③ 抵澳有 6 条字面量 `0`（既非状态也非空串）。把"空串"和"未知"当同一件事
 *      的实现会在这里判错 —— 故 `0` 必须走 unknown 且**行保留**。
 *
 * ── 未知兜底方向：非终态（宁可多显示，不可漏显示）────────────────────┬──
 *   归为终态 ⇒ 未知状态被静默剔除 ⇒ 用户看不到某班且无任何提示，**不可恢复**；
 *   归为非终态 ⇒ 最坏是 5 个位置里混进一条已走的班次，用户看一眼时刻就知道。
 *
 * ⚠️ **SQL 侧的终态集合必须与这里同源**（`TERMINAL_KINDS`）。两处各写一份必然漂移，
 *    而漂移的症状是"分类说已走、SQL 没剔除"，同样静默。故：
 *      · SQL 用 `TERMINAL_KINDS[source][dir]` 拼 `status_kind <> ALL($n)`；
 *      · `scripts/test-xborder-status.ts` 断言"该集合里的每个 kind，classify 真的会
 *        在对应 (source,dir) 产出且 terminal=true"（反向也断言非终态集合）。
 */
import type { AirportStatusKind, FerryStatusKind, XbDir } from "./types";

/** 判定结果：kind 用于着色/排序；terminal 决定 `after=now` 是否剔除 */
export interface StatusVerdict {
  kind: AirportStatusKind | FerryStatusKind;
  terminal: boolean;
}

interface Rule {
  re: RegExp;
  v: StatusVerdict;
}

/**
 * 机场 · 离澳。终态 = 已走（起飞 / 取消）。
 * `航班著陸` 在离澳页理论上不出现，防御性保留（数据异常时不该把它塞进"最近五班"）。
 */
const AIRPORT_DEP: readonly Rule[] = [
  { re: /^已啟航\s+\d{2}:\d{2}$/, v: { kind: "departed", terminal: true } },
  { re: /^航班著陸\s+\d{2}:\d{2}$/, v: { kind: "landed", terminal: true } },
  { re: /^(已取消|航班取消)$/, v: { kind: "cancelled", terminal: true } },
  { re: /^停止登機$/, v: { kind: "boarding_closed", terminal: false } },
  {
    re: /^櫃檯\s+[A-Z]?\d+(?:-[A-Z]?\d+)?\s*已開放$/,
    v: { kind: "checkin_open", terminal: false },
  },
  // 前缀匹配（不是精确匹配）：实测只见到 2 条、确切格式未穷举（`航班延誤至 HH:MM` vs
  // `航班延誤…` 两份文档写法不同）⇒ 容忍后续任意内容，比写死一个可能不存在的格式安全。
  { re: /^航班延誤/, v: { kind: "delayed", terminal: false } },
];

/** 机场 · 抵澳。终态 = 已到（着陆 / 取消）；**"已从始发地起飞"不是终态** */
const AIRPORT_ARR: readonly Rule[] = [
  { re: /^航班著陸\s+\d{2}:\d{2}$/, v: { kind: "landed", terminal: true } },
  { re: /^(已取消|航班取消)$/, v: { kind: "cancelled", terminal: true } },
  { re: /^已啟航\s+預計到達\s+\d{2}:\d{2}$/, v: { kind: "departed", terminal: false } },
];

/** 船 · 离港 */
const FERRY_DEP: readonly Rule[] = [
  { re: /^\d{2}:\d{2}\s*啟航$/, v: { kind: "departed", terminal: true } },
  { re: /^待航$/, v: { kind: "pending", terminal: false } },
  // 本轮实测**未出现**取消/延误样本 ⇒ 不凭空造映射，走 unknown 兜底（行保留、状态原样显示）
];

/** 船 · 到港 */
const FERRY_ARR: readonly Rule[] = [
  { re: /^\d{2}:\d{2}\s*到達$/, v: { kind: "arrived", terminal: true } },
  { re: /^預計\s*\d{2}:\d{2}\s*到達$/, v: { kind: "eta", terminal: false } },
  // ← 关键：`已啟航`（无时刻，对方港已开出、尚未抵达）**不是终态**
  { re: /^已啟航$/, v: { kind: "departed", terminal: false } },
  // ★ `待航` 在**到港页也会出现**（2026-11-06 真实快照 `arrival.aspx?local=TP`：8 行里 4 行是它）。
  //   契约 §2.10.3 的 FERRY_ARR 初版漏了这一条（调研 A.3 的词表里有，白名单抄漏了）；
  //   漏掉的后果是这 4 行全部 unknown —— 虽然仍会显示（未知兜底=非终态），但着色与排序都拿不到
  //   正确归类，且漂移探针会误报 50%。**别删**：`scripts/test-xborder-status.ts` 有断言钉住。
  { re: /^待航$/, v: { kind: "pending", terminal: false } },
];

const TABLES: Record<"airport" | "ferry", Record<XbDir, readonly Rule[]>> = {
  airport: { dep: AIRPORT_DEP, arr: AIRPORT_ARR },
  ferry: { dep: FERRY_DEP, arr: FERRY_ARR },
};

/**
 * 唯一入口：按 (source, direction) 分表匹配，**首个命中即返回**，都不中 ⇒ unknown/非终态。
 *
 * @param raw 上游状态原文。内部**只 `trim()`**（判空/对齐用），不改任何字符
 *            —— 海事局条款「均不可以修改任何內容」，写入侧同理。
 */
export function classify(source: "airport" | "ferry", dir: XbDir, raw: string): StatusVerdict {
  const text = String(raw ?? "").trim();
  for (const row of TABLES[source][dir]) if (row.re.test(text)) return row.v;
  return { kind: "unknown", terminal: false };
}

/**
 * SQL 侧要剔除的 `status_kind` 集合（与 `classify()` 同源，禁止另写一份）。
 *
 * 为什么不是"从 classify 反推"：`classify` 是"文本 → kind"，SQL 里只有 kind，
 * 需要的是"kind 集合"。两者必须一致，靠 `test-xborder-status.ts` 的双向断言守住。
 *
 * ⚠️ 注意 `departed` 同时出现在 airport.dep（终态）与 airport.arr/ferry.arr（非终态）——
 *    所以**不能**用"全局终态 kind 集合"，必须按 (source, dir) 取。
 */
export const TERMINAL_KINDS: Record<"airport" | "ferry", Record<XbDir, readonly string[]>> = {
  airport: { dep: ["departed", "landed", "cancelled"], arr: ["landed", "cancelled"] },
  ferry: { dep: ["departed"], arr: ["arrived"] },
};

/**
 * 未知状态占比超过该阈值 ⇒ 记 `console.warn`（运行时漂移探针）。
 * 取 0.20 的理由：抵澳 6 条字面量 `0` 稳定占 6/73 ≈ 8%，留足余量；
 * 真出现上游换文案（如 62 条 `航班著陸` 全变新写法）会立刻超过 20%。
 */
export const UNKNOWN_DRIFT_THRESHOLD = 0.2;

/**
 * 漂移探针：**只写日志，不加响应字段、不打扰用户**。
 *
 * 日志样例必须带 `status_raw` 原文 —— 否则看到告警还得回库翻才知道上游改成了什么。
 */
export function warnOnStatusDrift(
  source: "airport" | "ferry",
  dir: XbDir,
  rows: readonly { statusRaw: string; statusKind: string }[],
): void {
  if (rows.length === 0) return;
  const unknown = rows.filter((r) => r.statusKind === "unknown");
  const ratio = unknown.length / rows.length;
  if (ratio <= UNKNOWN_DRIFT_THRESHOLD) return;
  const samples = [...new Set(unknown.map((r) => JSON.stringify(r.statusRaw)))].slice(0, 5);
  console.warn(
    `[xborder] status drift: ${unknown.length}/${rows.length} unknown (${(ratio * 100).toFixed(0)}%) ` +
      `source=${source} dir=${dir} 样例=${samples.join(", ")}`,
  );
}
