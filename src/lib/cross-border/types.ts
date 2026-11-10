/**
 * 跨境交通 · 共享类型（src/lib/cross-border/types.ts）
 *
 * ── 为什么类型单独成文件 ────────────────────────────────────────────────
 *   同一套形状要被**三方**同时使用，且必须逐字符一致：
 *     ① 两个接口 `GET /api/cross-border/{airport/flights,ferry/sailings}`；
 *     ② 解析器（`airport/parse.ts` / `ferry/parse.ts`）与写库层（`store.ts`）；
 *     ③ 断言脚本（`scripts/test-xborder-*.ts`，**不连库、不联网**）。
 *   分别声明必然漂移，而漂移的症状是"接口说 5 条、前端拿到 4 条"这种无人报的静默错。
 *
 * ── 三条与合规绑定的类型决定（改类型前先读）─────────────────────────────
 *   ① 展示文本字段一律是**上游原文**（`place` / `status` / `vessel` / `operator`）。
 *      海事局条款「均不可以修改任何內容」⇒ 这些字段**不得**在代码里 replace/繁简转换。
 *      库里的列名带 `*_raw` 后缀就是为了让这件事在 schema 层看得见。
 *   ② `statusKind` 是**我方**派生枚举，只服务着色/排序；`status` 才是真相。
 *      接口**同时**给出两者，且 `isTerminal` 由服务端按（源, 方向）算好 ——
 *      不允许前端自己拿 `statusKind` 推终态（`departed` 在离/抵两向含义相反，见 `status.ts`）。
 *   ③ 空态用 `emptyReason` 三值枚举表达，**永不** 204（204 没有 body，装不下原因）。
 *
 * 零运行时依赖（只有 type/const），故纯解析脚本可以直接 import。
 */

/* ══════════════════════════════════════════════════════════════════════
 * 枚举
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 方向。**刻意用字符串 `dep`/`arr` 而不是 `0`/`1`**：
 * 项目巴士接口的 `dir` 是 `0`/`1`（上行/下行），语义完全不同。
 * 用字符串让"把巴士方向逻辑套到航班上"这个错误不可能静默发生。
 */
export type XbDir = "dep" | "arr";

/** 码头：上游 `local` 参数原值。存码不存中文名 —— 中文名交前端映射，避免"我方改写官方名称" */
export type PierCode = "PE" | "TP" | "PI";

/**
 * `after` 语义（负责人裁决 1，见契约 §2.1.1）：
 *   `day` = 当日全量（含终态）⇒ 需求 6
 *   `now` = 当日全量**先剔除终态**，再按 `sched_at` 升序取前 `limit` ⇒ 需求 5
 * ⚠️ **不是**时间硬过滤。`after=now` 分支里**不得**出现 `WHERE sched_at > now()`
 *   —— 否则「08:00 延误到 20:00」的班次会在 19:00 从列表消失，用户以为航班没了。
 */
export type XbAfter = "now" | "day";

/**
 * 机场状态派生枚举（CHECK 约束同值，见 `db/migrate-v3800.ts`）
 *
 * `pending` = 上游 `status` 为字面量 `"0"`：**已计划、尚未进入任何流程**，非终态。
 * 2026-11-07 实测追踪：白天快照 131 行里 42 行是 `"0"`，8 小时后 39 行转成
 * `航班著陸 HH:MM` / `已啟航 HH:MM` / `航班延誤`，余 4 行为 22:00 后的晚班。
 * ⇒ 它是合法占位值，不是我方"认不出"。故单列一个 kind，不落 `unknown`。
 *
 * `rescheduled` = 上游 `航班更改時間 HH:MM`：**时刻发生了变更**，非终态。
 * 与 `delayed`（延误）刻意**不合并**（负责人 2026-11-08 裁定）：
 *   · 延误 = 晚于原计划，原时刻基本仍可用；
 *   · 更改 = 时刻被改到另一个钟点（可晚可早），用户按原时刻去机场会直接误机。
 * 两者对用户的行动指令不同 ⇒ 前端文案与配色都必须分得开（见 `xb-view.ts#statusClass`）。
 * 首次实测于 2026-11-08 00:0x（上游当日 70 条里 1 条），此前从未出现过。
 */
export type AirportStatusKind =
  | "departed"
  | "boarding_closed"
  | "checkin_open"
  | "cancelled"
  | "delayed"
  | "landed"
  | "pending"
  | "rescheduled"
  | "unknown";

/** 船状态派生枚举（CHECK 约束同值） */
export type FerryStatusKind = "departed" | "arrived" | "eta" | "pending" | "unknown";

/**
 * 空态原因（三值）。前端据此选文案，**永不靠"数组为空"猜**：
 *   `none_remaining_today` 当日有班次，但剔除终态后一条不剩（深夜常态）
 *   `no_service_today`     采集成功，但当日确实一班都没有（台风停航 / 未排班）
 *   `not_yet_collected`    从未成功采集过（`dataFetchedAt === null`）—— 这是**我方**故障
 */
export type XbEmptyReason = "none_remaining_today" | "no_service_today" | "not_yet_collected";

/* ══════════════════════════════════════════════════════════════════════
 * 响应体
 * ══════════════════════════════════════════════════════════════════════ */

/** 合规署名（机场 = 数据开放平台义务；船 = 海事局条款义务。两套文本不可混用） */
export interface XbAttribution {
  /** 展示用署名原文 */
  text: string;
  /** 取得内容的日期（澳门本地 `YYYY-MM-DD`，合规硬要求） */
  acquiredOn: string;
}

/** 两个端点共用的列表响应外壳（`items` 元素由各端点细化） */
export interface XbListResponse<T> {
  ok: true;
  items: T[];
  /** 当日该 (dir[,pier]) 全量行数（含已过时刻、不含 voided），用于"今日共 N 班" */
  dayTotal: number;
  after: XbAfter;
  /** 服务端当前时刻，ISO 8601 带 +08:00 偏移。前端据此算"还有几分钟"，**不要用浏览器时钟** */
  serverNow: string;
  /** 上次**成功**采集时刻（`max(last_seen_at)`）；从未成功为 null */
  dataFetchedAt: string | null;
  /** true = `dataFetchedAt` 已超出新鲜度窗口的 2 倍 ⇒ 前端必须显示"暂时无法更新" */
  stale: boolean;
  attribution: XbAttribution;
  /** `items.length > 0` 时**整个字段缺席**（不是给 null），减少前端 `??` 判断 */
  emptyReason?: XbEmptyReason;
}

export interface XbAirportFlight {
  id: number;
  direction: XbDir;
  flightNo: string;
  airline: string | null;
  /** 原文：destination(离) / origin(抵)。**不做繁简转换** */
  place: string;
  /** `YYYY-MM-DD`（澳门本地） */
  schedDate: string;
  /** `HH:MM`（需求 5 的"计划出发"就是它，**不是** `sched_at`，不带日期） */
  schedTime: string;
  /** 仅 dep 有值；arr 恒 null（上游抵澳无登机口字段） */
  gate: string | null;
  /** 原文照录，可能为空串（上游实测有 0 字符），arr 侧可能是字面量 `0` */
  status: string;
  statusKind: AirportStatusKind;
  /** 是否已走完（起飞/降落/取消）。**方向敏感**，服务端算好；前端只许据此置灰/排序 */
  isTerminal: boolean;
  /** 我方观测到状态变化的时刻；null = 自首次见到起未变过 */
  statusChangedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface XbFerrySailing {
  id: number;
  pier: PierCode;
  direction: XbDir;
  /** 船名原文（需求 5 要显示的第一个字段）；待航时上游为空 ⇒ null */
  vessel: string | null;
  vesselType: string | null;
  /** 船务公司原文 */
  operator: string;
  /** 原文：目的港(离) / 啟航港(到) */
  place: string;
  schedDate: string;
  schedTime: string;
  /** 仅 dep 有值（arr 页无闸口列） */
  gate: string | null;
  status: string;
  statusKind: FerryStatusKind;
  isTerminal: boolean;
  statusChangedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/* ══════════════════════════════════════════════════════════════════════
 * 内部：解析产物（服务端内部流通，不进 HTTP 响应）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 解析器 → 写库层的一行（机场）。
 *
 * 与响应类型的差别：这里是**待 upsert 的行**，用 `schedDate`(`YYYY-MM-DD`) + `schedTime`(`HH:MM`)
 * 表达业务唯一键的两段，日期时刻的时区合成（`sched_at`）由写库层统一算 ——
 * 解析器不碰 `Date` 的时区换算，避免"两处各算一次、算法不同"。
 */
export interface FlightUpsertRow {
  schedDate: string;
  direction: XbDir;
  flightNo: string;
  schedTime: string;
  airlineRaw: string | null;
  placeRaw: string;
  gateRaw: string | null;
  statusRaw: string;
  statusKind: AirportStatusKind;
  /**
   * 终态（**读取时**由 `classify()` 现算，见 `store.ts#toFlight`）。
   * ⚠️ **不落库**：DDL 与 `store-write.ts` 的 INSERT 列清单里都没有 `is_terminal` 列。
   *    落库的 `status_kind` 只服务 SQL 谓词（`after=now` 剔除终态），每轮 upsert 刷新；
   *    响应里的 `isTerminal` 由 `status_raw` + `status.ts#classify` 现算 —— 唯一真相源。
   *    读取时现算比写入时算好落库更抗白名单变更：白名单一改，历史行自动按新规则算，
   *    落库列反而要全表回填。代价是写入与读取之间若改了白名单会两处漂移，
   *    由 `scripts/check-xborder-store.ts` 的「终态判定一致性」断言逐行守着。
   */
  isTerminal: boolean;
}

/** 解析器 → 写库层的一行（船） */
export interface SailingUpsertRow {
  sailDate: string;
  direction: XbDir;
  pier: PierCode;
  operatorRaw: string;
  placeRaw: string;
  schedTime: string;
  vesselRaw: string | null;
  vesselTypeRaw: string | null;
  gateRaw: string | null;
  statusRaw: string;
  statusKind: FerryStatusKind;
  /** 终态（同机场：读取时由 `classify()` 现算，不落库；`status_kind` 落库只服务 SQL 谓词） */
  isTerminal: boolean;
}
