/**
 * 路线总耗时模型（src/lib/recommend/model.ts，v1.0.6）
 *
 * 门到门链条（全部从「现在」串行推进）：
 *   T_total = walkOut(出发地→上车站)
 *           + Σ_k [ wait_k + ride_k + transfer_k ]
 *           + walkIn(下车站→目的地)
 *
 * 关键口径：
 *   · `ride`（巴士）= 逐跳累加 `segment_stats`（**离开口径** = t(离B) − t(离A) = run + dwell_B）
 *   · `ride`（轻轨）= 氹仔线 `LRT_HOP_SEC` 逐段累加（未收录跳回落 120s）；石排湾/横琴走固定秒数
 *   · `wait_1`：巴士取 DSAT 实时「区间下限」；**无在途车 → 整条方案排除**（不在运营时间）
 *   · `wait_2+`：**按「到达换乘站的时刻」取班次**（轻轨查时刻表本地算；巴士按间隔 ÷ 2 估）
 *     —— 不能用「现在最近的在途车」，否则换乘方案总耗时被系统性低估
 *   · `transfer`：同场（站码相同且非轻轨）= 0；轻轨站内换乘读 `transfer_walks`
 *
 * ★ v1.0.6 三处修正（线上只读取证实测倒逼）： *   ① **首段赶不上 → 整条剔除**（`ctx.missed`），不再退回「班距÷2」估算卡。
 *      旧行为：巴士两辆在途车都赶不上 → 等车按 180s 估、卡面却写「还有 0 站 · 约 0 分」
 *      + 徽章「本班赶不上」→ 自相矛盾且总用时偏小；轻轨更是**直接用赶不上的那班车**算总用时。
 *   ② **第 2 段起的等车分钟真正回填**：旧代码在 push 本段后才去写 `rides[i + 1]`，
 *      而那一刻下标 `i+1` 尚不存在 → 赋值恒为 no-op（`nx` 永远 undefined）→
 *      第 2 段等车**计入了总用时却显示 0**，卡面加总对不上（线上实测缺 2~11 分钟）。
 *      现在改为「先算出来、下一轮 push 时写进去」。
 *   ③ **轻轨首段的赶车档判据参照修正**（详见 `catch-up.ts` 顶部注释）。
 *
 * ⚠️⚠️ ★ v2.0.1（产品 2026-09-19 **复**拍板）：**明确不做「首段赶不上 → 出下一班（needsWait）」**。
 *   背景：曾一度把本条 ①「首段赶不上 → 整条剔除」改成「取全池 `loSec` 最小的下一班 + `needsWait: true`」
 *   （文件版本曾标 v1.4.0），**本轮已整条回退**，恢复本文件头 ① 的原行为。回退依据两条：
 *
 *   ① **产品澄清（口径）**：卡片本就**按【线路】组织** ——
 *      · 最近一班赶不上 ⇒ 该线路**整条不显示**（原行为即正确）；
 *      · 「后续车次」的需求**早已由 `altBuses` 满足**（见 `ModeledOption.alts` 及
 *        `service.ts` 在排序取前 N 后回填）—— 卡内会列出**该线路的后续车次**，
 *        筛选口径 = 「总时长 ≤ 前 N 张卡里最差方案」。
 *      ⇒ 无需 `needsWait` 这套额外机制。
 *
 *   ② **工程发现（上一轮实测倒逼，仍有效——后人若要重做请先读）**：
 *      **字面实现 `needsWait` 必然丢「步行出门」段**。原因：某班「赶不上」时，DSAT 常报其
 *      `loSec` **早于**「你走到站台的时刻」（车就在你上车站 / 总站待发，`stopsAway = 0`）。
 *      若照旧把上车时刻设为「**车到站时刻**」（`now + loSec`），总用时会把 `walkOut` 整段吞掉
 *      ⇒ 卡面偏小，且与「需等下一班」自相矛盾（正是 ① 当年要剔除它的同一体感）。
 *      为修这一点，不得不把上车时刻**下夹到 `cursor`**（你到站时刻）——时间轴语义随即变复杂、
 *      且与「能赶上 ⇒ 上车时刻 = 车到站时刻」的口径分叉。**得不偿失**：既有「剔除 + `altBuses`」
 *      更简单、语义更单一，且已满足产品全部诉求 ⇒ 故回退。
 *
 *   ★ 结论：**保留本条 ①「首段赶不上 → 整条剔除」不动**；「后续车次」一律走 `altBuses`。
 *
 * ⚠️ zone（澳門科技大學座区）判据是 `slug === "school"`，**与方向无关** ——
 *    去程的 `walkIn` 与回程的 `walkOut` 都会吃到它（`walk_times` 本来就是
 *    `(place, 站主码, zone)` 合并键、不分出发/到达）。
 *
 * ──────────────────── ★ v1.1.3 两处修正（用户实测倒逼）────────────────────
 *   ① **轻轨首段的发车表只下发「你走得到的那几班」**：旧版把全部班次交给客户端读秒，
 *      客户端取第一班 → 显示的是「马上就要开、但人还在路上」那班，与 `waitMin`
 *      自相矛盾（实测步行 4.6 分却显示「1.8 分后开」）。现按 `> cursor` 过滤。
 *   ② **巴士两辆候选改取「到站更早」的那辆**：见 `pickBoardable` 注释 ——
 *      `eta.ts` 的排序不区分 `status`，旧写法会选中实际更晚的车。**只改本模型，不动 `eta.ts`**。
 */
import { PLACE_SHORT } from "@/lib/home-plans-shared";
import { hhmmOf } from "@/lib/lrt/eta";
import type { AmapPlanSeed, WalkResolver } from "@/lib/nav/types";
import { etaTextOf, pickCatchTier, tierHintOf, tierTextOf, waitRangeText, type TierSpeedOverride } from "./catch-up";
import { conservativeWaitMin, headwayAt, headwayMedian, SLACK_NO_DATA, type HeadwayIndex } from "./headway";
import { scheduleGate, type ScheduleHideReason } from "./schedule";
import { cmpByPref, PREF_DEFAULTS, type Prefs } from "./score";
import { mainCodeOf, rideOfHops, type SegmentIndex } from "./segment-lookup";
import { busTransferSlackMin, slackTierSink } from "./transfer-slack";
import {
  LRT_HOP_FALLBACK_SEC,
  LRT_HOP_SEC,
  LRT_RIDE_SEC_FIXED,
  TRANSFER_FALLBACK_MIN,
  WALK_BASE_M_PER_MIN,
  WALK_FALLBACK_MIN,
  lrtStationWalkM,
  lrtTransferWalkM,
  type AltBusView,
  type BusArrival,
  type BusLive,
  type CatchTier,
  type OptionSeed,
  type RecommendCard,
  type RideLegView,
  type RideSegment,
  type RouteLive,
  type SchoolZone,
  type TransferSegment,
  type TransferView,
  type TransferWalkRow,
  type WalkLegView,
  type WalkTimeRow,
  StationWalkDistanceRow,
} from "./types";

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** ★ v2.3.0（B5.2）：秒 → 「M分S秒」（`100 → "1分40秒"`、`135 → "2分15秒"`）。 */
function fmtRideSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}秒`;
  return r === 0 ? `${m}分` : `${m}分${r}秒`;
}

// ─────────────────────────── 步行索引 ───────────────────────────

export interface WalkIndex {
  /** `placeId|main|zone` → 行（zone 空串表示 NULL） */
  byKey: Map<string, WalkTimeRow>;
  /**
   * ★ v1.2.0：`placeId|main|zone` → 高德步行距离（米）
   * 与 byKey **独立** —— 来自 station_walk_distance；即使该组没有实测样本也能有距离 ✓
   */
  distByKey: Map<string, number>;
  /** placeId → 该地点全行样本加权均值 */
  byPlace: Map<number, number>;
  /** 全表样本加权均值 */
  global: number | null;
}

export function buildWalkIndex(rows: WalkTimeRow[], dists: StationWalkDistanceRow[] = []): WalkIndex {
  const byKey = new Map<string, WalkTimeRow>();
  const agg = new Map<number, { sum: number; n: number }>();
  let gs = 0;
  let gn = 0;
  for (const r of rows) {
    const m = num(r.minutes);
    if (m === null || m <= 0) continue;
    const w = Math.max(1, r.samples);
    byKey.set(`${r.place_id}|${mainCodeOf(r.station_code)}|${r.zone ?? ""}`, r);
    const a = agg.get(r.place_id) ?? { sum: 0, n: 0 };
    a.sum += m * w;
    a.n += w;
    agg.set(r.place_id, a);
    gs += m * w;
    gn += w;
  }
  const byPlace = new Map<number, number>();
  for (const [k, v] of agg) if (v.n > 0) byPlace.set(k, v.sum / v.n);
  // ★ v1.2.0：距离索引（独立于 walk_times）
  const distByKey = new Map<string, number>();
  for (const d of dists) {
    const v = num(d.distance_m);
    if (v === null || v <= 0) continue;
    distByKey.set(`${d.place_id}|${d.station_main}|${d.zone ?? ""}`, v);
  }
  return { byKey, distByKey, byPlace, global: gn > 0 ? gs / gn : null };
}

export interface WalkLookup {
  minutes: number;
  /** 1 = (place,主码,zone) 2 = (place,主码,NULL) 3 = 该地点均值 4 = 全表均值 5 = 常数 */
  level: 1 | 2 | 3 | 4 | 5;
  samples: number;
  /** ★ v1.2.0：该段步行距离（米）；null = 未知（档 1 退回线性）。与 level 无关，独立查 */
  distanceM: number | null;
}

/** 步行回退链（非 school 侧 zone 必须传 null） */
export function lookupWalk(
  idx: WalkIndex,
  placeId: number,
  station: string,
  zone: SchoolZone | null,
): WalkLookup {
  const main = mainCodeOf(station);
  // ★ v1.2.0：距离独立于 minutes 的回退链 —— 先精确（含座区），再退回不分座区
  //   （距离来自 station_walk_distance，即使该组没有实测样本也可能有 ✓）
  const distanceM =
    idx.distByKey.get(`${placeId}|${main}|${zone ?? ""}`) ?? idx.distByKey.get(`${placeId}|${main}|`) ?? null;

  const r1 = idx.byKey.get(`${placeId}|${main}|${zone ?? ""}`);
  const v1 = r1 ? num(r1.minutes) : null;
  if (v1 !== null && v1 > 0) return { minutes: v1, level: 1, samples: r1!.samples, distanceM };

  const r2 = idx.byKey.get(`${placeId}|${main}|`);
  const v2 = r2 ? num(r2.minutes) : null;
  if (v2 !== null && v2 > 0) return { minutes: v2, level: 2, samples: r2!.samples, distanceM };

  const p = idx.byPlace.get(placeId);
  if (p !== undefined) return { minutes: p, level: 3, samples: 0, distanceM };

  if (idx.global !== null) return { minutes: idx.global, level: 4, samples: 0, distanceM };

  return { minutes: WALK_FALLBACK_MIN, level: 5, samples: 0, distanceM };
}

// ─────────────────────────── 换乘步行索引 ───────────────────────────

export interface TransferInfo {
  minutes: number;
  samples: number;
  source: string;
  /** true = 无实测样本，常量兜底（UI 标「估算」） */
  estimate: boolean;
}

export type TransferIndex = Map<string, TransferInfo>;

export function buildTransferIndex(rows: TransferWalkRow[]): TransferIndex {
  const m: TransferIndex = new Map();
  for (const r of rows) {
    const v = num(r.minutes);
    if (v === null || v < 0) continue;
    m.set(`${mainCodeOf(r.from_station)}|${mainCodeOf(r.to_station)}`, {
      minutes: v,
      samples: r.samples,
      source: r.source,
      estimate: false,
    });
  }
  return m;
}

export function transferMinutes(idx: TransferIndex, from: string, to: string): TransferInfo {
  const hit = idx.get(`${mainCodeOf(from)}|${mainCodeOf(to)}`);
  if (hit) return hit;
  return { minutes: TRANSFER_FALLBACK_MIN, samples: 0, source: "fallback", estimate: true };
}

// ─────────────────────────── 模型上下文 ───────────────────────────

export interface ModelContext {
  /** 现在（ms）—— 一律「现在出发」 */
  nowMs: number;
  segIdx: SegmentIndex;
  walkIdx: WalkIndex;
  transferIdx: TransferIndex;
  /** place slug → id */
  placeIds: Record<string, number>;
  /** 站码 → 显示名（巴士带站号前缀） */
  nameOf: Map<string, string>;
  /** 澳門科技大學座区（★ 只要**任一侧**是 school 就生效，与出发/到达方向无关） */
  zone: SchoolZone | null;
  /**
   * ★ v2.4.1：**目的地的展示名**（如「澳門科技大學（B/C 座）」、任意 POI 名）。
   *
   * 为什么需要它：末段步行（`walkIn`）的终点文案必须写**目的地**而不是下车站，
   * 而目的地名**不能靠 slug 反查** —— 全澳导航链路对非预设地点会把它兜底成
   * `"place"`（见 `nav-service.ts#slugOf`），`PLACE_SHORT["place"]` 查不到，
   * 结果会把 slug 原文 `"place"` 直接印到卡片上（实测已复现）。
   * ⇒ 由调用方（导航 / 推荐服务）显式传入真实地名；缺省时回落 `placeLabelOf(slug)`。
   */
  destLabel?: string;
  /** route → 实时视图 */
  live: Map<string, RouteLive>;
  /**
   * ★ B4（需求 7）：**发车间隔索引**（`route_frequency`，`headway.ts#loadHeadway` 产物）。
   *
   * 用途：**第 2 段起巴士等车**按「到达换乘站的时刻」查 `headwayAt` 取偏保守值
   *   `(lo + 2·hi)/3`（见 §h.1）；未命中 → `headwayMedian`（该线全时段中位数）→ 仍无 ⇒ `null`。
   * **缺省**（undefined）⇒ 第 2 段巴士等车按「无数据」处理（`waitMin = null`，明示降级）——
   *   不再回落到写死常量（旧「第 2 段巴士等车恒 180s」已废除，AC-61）。
   */
  headway?: HeadwayIndex;
  /** 被排除的线路（无在途车 / 已收车 / 站序缺失）→ 静默剔除计数器 */
  excluded: string[];
  /**
   * ★ v1.0.6：因「**首段赶不上**」被剔除的线路（与 `excluded` 分开记账）。
   * 分开的理由：UI 要能区分「这条线现在没车」与「这班你赶不上」——
   * 合成一个数组会让文案与诊断都失真。
   */
  missed: string[];
  /**
   * ★ 2026-11-04（U8）：「因运营时间且无车」被隐藏的线路 —— 与 `excluded` / `missed` **并列**记账。
   *
   * 为什么必须单独一位：`excluded` 是「无在途车 / 已收车 / 站序缺失」的粗粒度计数器，
   *   把本类剔除混进去就**不可观测**了（属静默变更，违反「可观测变更」约定）。
   *   记录 `{route, boardMain, reason}`：`boardMain` 归一（`C690/3 → C690`）便于按站聚合。
   *
   * ⚠️ 可选字段：`contextFor()` 统一提供数组；个别诊断脚本手写 `ModelContext` 时不强制。
   */
  skippedBySchedule?: { route: string; boardMain: string; reason: ScheduleHideReason }[];
  /** ★ v3.4.0：查询时段桶（bucketOfRoute 五桶之一）——替代旧 todayWeekday（星期维度已废弃） */
  nowBucket: string;
  /**
   * ★ v1.3.0（全澳导航接缝，设计 §C.8）：**可选**的步行解析器。
   *
   * 有则 `walkView` 用它（任意 POI 场景：首末步行 = **高德几何（短距修正后）÷84**）；
   * **无则走原 `walkIdx`（`walk_times` 实测）** ⇒ **旧链路零变化** ✓。
   * ⚠️ 由 `nav-service.ts` 按方案注入（每个方案的步行段各不相同）。
   */
  walkResolver?: WalkResolver;
  /**
   * ★ v2.3.0（`/api/nav` 可选参数 `tiers`）：**组合级五档覆盖**。
   *   有则 `pickCatchTier` / `tierHintOf` 用它替换默认 `SPEED_RATIO`（07 §2.5）；
   *   **无则走默认常量** ⇒ 自动选线链路零变化 ✓。
   */
  tierOverride?: TierSpeedOverride;
}

const labelOf = (ctx: ModelContext, code: string): string => ctx.nameOf.get(code) ?? code;

/**
 * 从实时视图里挑「能赶上的最早一班」（判据用**区间下限**，往短了算）。
 *
 * ★ v1.1.3：改为在**两辆都可能赶上**时取 `loSec` 更小的那辆（= 到站更早）。
 *   旧写法取列表序第一个，而 `eta.ts` 的 `inTransit` 只按 `stopsAway` 排序、
 *   **不区分 `status`** —— 同站同站数时「已离站驶向下一站」(status=0，第 1 跳已算 0)
 *   其实比「仍停靠该站」(status=1，含第 1 跳) **更早到**，却可能被排在后面
 *   → 旧行为会选中更晚的那辆（等更久，且档位偏保守）。
 *   ⚠️ 只改本模型内部，**不动 `eta.ts`**（那是计时/开发者模式共用的，改它会波及计时）。
 *
 * ★ v1.1.4：候选从**两辆放宽到五辆**（`nearest` + `second` + `lv.more`，见 `types.ts#BusLive`）。
 *   结论先行：这是**纯增益**——`service.ts` 按总用时升序取前 5，等待更久的路线只会排到后面
 *   （填满空位或不显示），**不会挤掉更优的方案**。放宽只是把「前两辆都赶不上 → 整条剔除」
 *   的路线救回来（改由第 3~5 辆兜底）。
 *
 * @returns null = 前五辆在途车都赶不上 → 调用方**整条剔除**该方案（v1.0.6）
 */
function pickBoardable(lv: BusLive, walkMin: number, walkDistM?: number | null, ov?: TierSpeedOverride): BusArrival | null {
  let best: BusArrival | null = null;
  for (const cand of [lv.nearest, lv.second, ...(lv.more ?? [])]) {
    if (!cand) continue;
    if (pickCatchTier(walkMin, cand.loSec, walkDistM, ov) === null) continue;
    if (!best || cand.loSec < best.loSec) best = cand;
  }
  return best;
}

// ─────────────────────────── 主模型 ───────────────────────────

/**
 * 步行视图。
 * @param dir 'out'（起点→上车站）/ 'in'（下车站→目的地）
 */
function walkView(ctx: ModelContext, slug: string, station: string, dir: "out" | "in"): WalkLegView {
  /**
   * ★ v2.4.1 修复（用户实测：「下车站之后的步行显示成『步行 → 车站』，应为『步行 → 终点』」）
   *
   * `toLabel` 必须**按方向**取名字：
   *   · `out`（出发地 → 上车站）→ 这段步行走向**车站** ⇒ 车站名；
   *   · `in` （下车站 → 目的地）→ 这段步行走向**目的地** ⇒ `placeLabelOf(slug)`（学校侧带座区）。
   *
   * ❌ 原实现两条分支都取车站侧（`info.toLabel` 与 `labelOf(ctx, station)` **都是车站名**），
   *   故末行渲染为「步行 5 分 → C653 金峰南岸」而非目的地。
   * ⚠️ 目的地名**优先取 `ctx.destLabel`**（调用方传入的真实地名），
   *   仅在缺省时才回落 `placeLabelOf(slug)` —— 因为导航链路的 slug 可能是 `"place"` 这类
   *   兜底值，直接查表会把 slug 原文印上卡片（实测复现过 `步行 6 分 → place`）。
   */
  const destName = dir === "in" ? ctx.destLabel || placeLabelOf(ctx, slug) : null;

  // ★ v3.3.0（AC-106）：**轻轨站**的进/出站步行**按距离常量折算**（不写死分钟）——
  //   dir="out"（出发地→上车站）= 进站 ⇒ `inM`；dir="in"（下车站→目的地）= 出站 ⇒ `outM`。
  //   分钟 = 米 ÷ 基准速度（84）；**分档缩放由 `catch-up.ts#requiredSec` 单一负责**（此处禁再乘 SPEED_RATIO）。
  // ⚠️ 2026-09-27 修正（线上实测：「石排灣→科大」的走協和卡步行显示 2 分/168 米，实际 ~1.3km）：
  //   「站内进/出站常量」**必须叠加在站外真实步行之上**，**不得替换**站外段——
  //   石排灣站→協和站 的站外步行曾因本分支被整体吞掉（石排灣线 100 秒车程 vs 走路 1.3km）。
  //   结构：站外步行（`ctx.walkResolver` 真实几何；无 ⇒ 0，覆盖「起点=本站」场景）＋ 站内常量。
  if (station.startsWith("LRT-")) {
    const inDoorM = lrtStationWalkM(dir === "out" ? "in" : "out");
    let outMin = 0;
    let outMet = 0;
    let outEst = false;
    if (ctx.walkResolver) {
      const info = dir === "out" ? ctx.walkResolver.out(mainCodeOf(station)) : ctx.walkResolver.in(mainCodeOf(station));
      outMin = info.minutes;
      outMet = info.distanceM ?? 0;
      outEst = info.estimated;
    }
    const meters = Math.round(outMet) + inDoorM;
    return {
      minutes: Math.round((outMin + inDoorM / WALK_BASE_M_PER_MIN) * 10) / 10,
      toLabel: destName || labelOf(ctx, station),
      // level 语义：站外为几何（估否随源）；站内为常量 ⇒ 无站外数据时 level 2（有常量依据）
      level: outEst ? 3 : 2,
      estimated: outEst,
      samples: 0,
      distanceM: meters,
    };
  }

  // ★ v1.3.0 接缝：有 walkResolver（全澳导航）→ 用高德几何（短距修正后 ÷84）
  if (ctx.walkResolver) {
    const info = dir === "out" ? ctx.walkResolver.out(mainCodeOf(station)) : ctx.walkResolver.in(mainCodeOf(station));
    return {
      minutes: Math.round(info.minutes * 10) / 10,
      toLabel: destName || info.toLabel || labelOf(ctx, station),
      level: info.estimated ? 3 : 1,
      estimated: info.estimated,
      samples: info.samples,
      distanceM: info.distanceM ?? null,
    };
  }
  const pid = ctx.placeIds[slug];
  // ⚠️ 判据只看「这个 place 是不是学校」，**不看它是起点还是终点** ——
  //    `walk_times` 是 (place, 站主码, zone) 合并键、不分出发/到达口径，
  //    所以「去学校」与「从学校出发」两侧都该吃同一个座区样本。
  const zone: SchoolZone | null = slug === "school" ? (ctx.zone ?? null) : null;
  const r = lookupWalk(ctx.walkIdx, pid ?? -1, station, zone);
  return {
    // 取一位小数：样本均值是原始浮点（5.8388888888888895），直接上屏破坏可读性
    minutes: Math.round(r.minutes * 10) / 10,
    toLabel: destName || labelOf(ctx, station),
    level: r.level,
    estimated: r.level >= 3,
    samples: r.samples,
    distanceM: r.distanceM, // ★ v1.2.0：档 1 随距离衰减用
  };
}

/** place 展示名：学校侧带上座区（起点/终点都用它，保证两个方向都能看到座区） */
function placeLabelOf(ctx: ModelContext, slug: string): string {
  if (slug === "school" && ctx.zone) return `澳門科技大學（${ctx.zone} 座）`;
  return PLACE_SHORT[slug] ?? slug;
}

/**
 * `modelOption` 的产物：卡 + 本班之外的候选班次。
 *
 * ★ v1.1.5：为什么要把「候选班次」带出来 —— 卡内要列出后续班次，但**筛选阈值**
 *   （「坐这一班的总时长不差于第 5 张卡」）只有等 `service.ts` 排完序取完前 N 才知道，
 *   所以这里只负责**算出**，筛选留给 service。
 */
export interface ModeledOption {
  card: RecommendCard;
  /** 本班之外的、能赶上的候选班次（含各自的门到门总时长与档位），按总时长升序 */
  alts: AltBusView[];
}

/**
 * 把一条候选方案算成一张卡。
 * @returns null = 该方案被排除：
 *   · 无在途车 / 已收车 / 站序缺失 → 记入 `ctx.excluded`
 *   · ★ v1.0.6 **首段赶不上** → 记入 `ctx.missed`（两者分开记账，UI 文案才能说实话）
 */
export function modelOption(seed: OptionSeed, ctx: ModelContext): ModeledOption | null {
  const nowMs = ctx.nowMs;
  const segs = seed.segments;
  const first = segs[0];

  /**
   * ★ 2026-11-04（U8）**运营时间 × 实时车 双证据闸门** —— 落点就在这里（两条链路唯一汇合点）。
   *
   * 为什么不在 `enumerate.ts` 拦：`optionsFor` 在 `fetchLive` **之前**调用
   *   （`service.ts:127` vs `:134`），那一刻没有任何实时上下文，**物理上判不了可乘性**。
   * `modelOption` 是本地枚举链路（`/recommend`）与高德链路（`/api/nav`，含 sibling 建模）
   *   的共同入口 ⇒ 改这一处，下游 3 个渲染器 + 站条 + 收藏快照自动一致。
   *
   * 判定口径与十二格边界表见 `./schedule.ts`：隐藏需要「不在运营窗口」**且**「无车」两份证据。
   * 这里只拦**首段**（整条方案能否成立由首段决定）；段内并行标签另由 `keepParallel()` 过滤。
   */
  if (first.kind === "bus") {
    const gate = scheduleGate(ctx.headway, ctx.live, first.route, nowMs);
    if (gate.hide) {
      // 同时记 `excluded`：本类剔除在语义上就是「已收车」⇒ 空状态文案（`no_live`）不能失真
      ctx.excluded.push(first.route);
      ctx.skippedBySchedule?.push({
        route: first.route,
        boardMain: mainCodeOf(first.board),
        reason: gate.reason ?? "closed_none",
      });
      return null;
    }
  }

  /**
   * ★ 2026-11-04（U8）：段内并行线用**同一谓词**过滤。
   *
   * 原始 bug 的可观测形态就在这一层：凌晨 N3 已收车、卡片列表里也早被「无实车且无估算」挡住，
   *   但 `parallelRoutes` 是 `enumerate.ts` 静态算出来的（**不读运营时间、不读实时车**）
   *   ⇒ 早上 07:00 的卡片标签里仍会出现 N3 这个不可能存在的选项。
   */
  const keepParallel = (list: string[] | undefined): string[] | undefined => {
    if (!list?.length) return list;
    return list.filter((r) => !scheduleGate(ctx.headway, ctx.live, r, nowMs).hide);
  };

  // ── 步行到上车站 ──
  const wOut = walkView(ctx, seed.fromSlug, first.board, "out");
  const walkOutMs = wOut.minutes * 60_000;

  const rides: RideLegView[] = [];
  const transfers: TransferView[] = [];
  /** 「到达上车站」的时刻（ms）—— 首段等车以它为基准 */
  let cursor = nowMs + walkOutMs;

  // ── 第 1 段：等车（DSAT 实时 / 轻轨时刻表）──
  // ★ v1.0.6：首段赶不上 → **整条剔除**（不再退回估算）。
  let boardAtMs: number;
  let waitMin0: number;
  let tier: CatchTier;
  let liveText: string;
  let liveDepartures: number[] | undefined;
  let liveClocks: string[] | undefined;
  /** ★ v3.2.0：与 `liveDepartures` 一一对应的秒级精准标记（首段轻轨透传 `LrtLive.precise`） */
  let livePrecise: boolean[] | undefined;
  /** ★ 2026-09-27（用户需求 2）：本段**主班时刻**（ms）——前端据此定位主班，数组内早于它的项 = 「前一班」 */
  let liveMainMs: number | undefined;
  /** ★ 2026-09-27（用户需求 1）：**后续段**（换乘后轻轨）的班次数据——由上一轮换乘块备好 */
  let liveDeparturesNext: number[] | undefined;
  let liveClocksNext: string[] | undefined;
  let livePreciseNext: boolean[] | undefined;
  let liveMainMsNext: number | undefined;
  /** ★ v3.3.0（AC-107）：首段轻轨的保守赶车提示（档 1/2 且有真实时刻时产出；否则 undefined） */
  let lrtCatchHint: string | undefined;
  /**
   * ★ v1.1.5：首段巴士的**全部可赶候选**（本班 + 后续），供卡内列出后续班次用。
   * 轻轨不填（其后续班次由 `liveDepartures` 表达）。
   */
  let busPool: BusArrival[] = [];
  /** 本班（从 `busPool` 里挑出的那一辆）—— 用于在算「后续班次」时排除它自己 */
  let chosenBus: BusArrival | null = null;

  if (first.kind === "bus") {
    const lv = ctx.live.get(first.route);
    if (!lv || lv.kind !== "bus") {
      ctx.excluded.push(first.route);
      return null;
    }
    if (lv.empty) {
      // ★ 2026-09-21 新增：本方向**无任何在途车** —— 不再一律剔除。
      //
      //   实测事故：在**起点站**等车时，本方向的车都已发出去 ⇒ `empty` ⇒ 整条方案被剔
      //   （26A 黑沙海灘的 28 分直达被剔，只剩 70~83 分的绕路方案）。
      //   现在若「未发车估算」（发车间隔 ＋ 已过站班车反推）可用，就用它继续出卡；
      //   估算不可用（该线此刻无班次基准，如 N2 白天 / 15T 平日）⇒ 维持旧行为（剔除）。
      const est = lv.waitEstimate;
      if (!est) {
        ctx.excluded.push(first.route);
        return null;
      }
      // 等待时间取**区间上限**（产品口径 2026-09-21：宁可信其长，别让用户错过车）
      boardAtMs = nowMs + est.hiMin * 60_000;
      // 未发车 ⇒ 不涉及「赶车档位」，按常速（档 3；SPEED_RATIO[3] === 1）
      tier = 3;
      liveText = `未发车 · ${waitRangeText(est.loMin, est.hiMin)}`;
      // 无实车可列 ⇒ 后续班次留空（卡片不展示 altBuses）
      busPool = [];
      chosenBus = null;
      waitMin0 = Math.max(0, (boardAtMs - cursor) / 60_000);
    } else {
      busPool = [lv.nearest, lv.second, ...(lv.more ?? [])].filter((x): x is BusArrival => x !== null);
      const chosen = pickBoardable(lv, wOut.minutes, wOut.distanceM, ctx.tierOverride);
      chosenBus = chosen;
      const t0 = chosen ? pickCatchTier(wOut.minutes, chosen.loSec, wOut.distanceM, ctx.tierOverride) : null;
      if (!chosen || t0 === null) {
        // 最近两辆在途车都赶不上（连冲刺也不行）→ 不显示这张卡。
        // 旧行为是「按班距 ÷ 2 估一个等车值」，但卡面同时又写「还有 0 站 · 约 0 分」
        // 与「本班赶不上」→ 三个数字互相打架，且总用时偏小会把它排到很前面。
        ctx.missed.push(first.route);
        return null;
      }
      boardAtMs = nowMs + chosen.loSec * 1000;
      tier = t0;
      liveText = `还有 ${chosen.stopsAway} 站 · ${etaTextOf(chosen)}`;
      waitMin0 = Math.max(0, (boardAtMs - cursor) / 60_000);
    }
  } else {
    const lv = ctx.live.get(first.route);
    if (!lv || lv.kind !== "lrt" || lv.state !== "running") {
      ctx.excluded.push(first.route);
      return null;
    }
    const depIdx = lv.departures.findIndex((d) => d > cursor);
    if (depIdx < 0) {
      ctx.excluded.push(first.route);
      return null;
    }
    const depMs = lv.departures[depIdx];
    boardAtMs = depMs;
    waitMin0 = Math.max(0, (depMs - cursor) / 60_000);
    // ★ 判据必须取「**从现在起**车还有多久到站」（与巴士侧的 `chosen.loSec` 同语义）。
    //   旧代码误传 `waitMin0 * 60`（= 你走完站台后才剩的余量）→ 参照系错位 →
    //   档位系统性偏保守，实测把「正常走能赶上」误报成「本班赶不上」。
    const t0 = pickCatchTier(wOut.minutes, (depMs - nowMs) / 1000, wOut.distanceM, ctx.tierOverride);
    if (t0 === null) {
      // 连冲刺都赶不上这一班 → 整条剔除（旧行为是直接用这班车算总用时 → 必然低估）
      ctx.missed.push(first.route);
      return null;
    }
    tier = t0;
    // ★ v3.3.0（AC-107）：档 1/2 = 正常速赶不上、提速档可赶上 ⇒ 生产**保守**赶车提示。
    //   仅在**有真实时刻**（`lv.clocks`）时产出；措辞保守（禁「一定」）。
    if ((t0 === 1 || t0 === 2) && lv.clocks[depIdx]) {
      lrtCatchHint = `走快一点可赶上 ${lv.clocks[depIdx]} 那班`;
    }
    // ★ 首段倒计时**只由客户端**每秒重算（`<LrtEtaInline>` 消费 `liveDepartures`）：
    //   服务端再下发一份冻结文案，同一行就会出现两个数字 —— 而且两者参照系不同
    //   （冻结那份用 `cursor` = 你走到站台的时刻，客户端那份用「现在」）→ 会互相矛盾。
    liveText = "";
    // ★★ v1.1.3：下发给客户端的发车表**必须从「你能赶上的那一班」开始**。
    //   旧写法原样下发 `lv.departures`（含**早于你到达站台**的班次）→ 客户端取第一班做倒计时
    //   → 显示的是「马上就要开、但你还在路上」的那班，与 `waitMin`（按 `cursor` 之后第一班算）
    //     自相矛盾。实测：步行出门 4.6 分，却显示「1.8 分后开」→ 用户怀疑「显示的不是能赶上的班次」。
    //   现在只下发 `> cursor` 的班次，客户端的第一班 ≡ 模型用的那一班。
    // ★ 2026-09-27（用户需求 2）：**前班（到达站台前最近一班）一并下发**——
    //   用户口径「前面一班车（如有）……赶不上的前班车也允许显示」⇒ 保留 `cursor` 前最近一班；
    //   客户端以 `liveMainMs` 定位主班，数组内早于主班的项即「前一班」。
    const stamped = lv.departures.map((d, k) => ({ d, c: lv.clocks[k] ?? "", p: lv.precise?.[k] ?? false }));
    const beforeWalk = stamped.filter((x) => x.d <= cursor).slice(-1);
    const afterWalk = stamped.filter((x) => x.d > cursor);
    const chain = [...beforeWalk, ...afterWalk];
    liveDepartures = chain.map((x) => x.d);
    liveClocks = chain.map((x) => x.c);
    // ★ v3.2.0：与班次同步过滤 —— 首段轻轨的秒级精准标记（供 `<LrtEtaInline>` 窗口/文案）
    livePrecise = chain.map((x) => x.p);
    liveMainMs = depMs;
  }

  cursor = boardAtMs;

  // ── 逐段：行驶 + 换乘 + 下一段等车 ──
  // ★ v1.0.6：等车分钟必须写进**它自己那一段**。
  //   旧写法是 push 完本段后去改 `rides[i + 1]`，而那一刻下标 `i+1` 还不存在
  //   （数组长度恰好是 `i + 1`，合法索引只到 `i`）→ `nx` 恒为 `undefined` → 整个
  //   回填块是**静默死代码** → 第 2 段起等车计入总用时却显示 0，卡面加总对不上。
  //   现在改成「**先算出来、下一轮 push 时直接写进去**」，顺序与旧版完全一致。
  let waitNext = waitMin0;
  let liveTextNext = liveText;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const waitMin = waitNext;
    const legText = liveTextNext;

    // ★ v2.3.0（B5.2）/ ★ v3.2.0（需求 3 / AC-71/72）：轻轨乘车秒数
    //   · 石排湾/横琴：`LRT_RIDE_SEC_FIXED`（100 / 135 s，单跳）；
    //   · 氹仔线：`LRT_HOP_SEC` **逐段求和**（站对索引，db_code 域）；未收录跳段回落 120 s/跳。
    let rideSecText: string | undefined;
    let ride: { minutes: number; levels: number[] };
    if (seg.kind === "lrt") {
      const lrtSec =
        LRT_RIDE_SEC_FIXED[seg.route] ??
        seg.hops.reduce((s, [f, t]) => s + (LRT_HOP_SEC[`${f}|${t}`] ?? LRT_HOP_FALLBACK_SEC), 0);
      ride = { minutes: lrtSec / 60, levels: [] };
      // 仅「固定秒数线」（石排湾/横琴）下发秒级展示串；氹仔线维持整分展示（不下发）
      if (LRT_RIDE_SEC_FIXED[seg.route] !== undefined) rideSecText = fmtRideSec(lrtSec);
    } else {
      ride = rideOfHops(ctx.segIdx, seg.route, seg.hops, ctx.nowBucket);
    }
    cursor += ride.minutes * 60_000;

    // ★ v3.3.0（AC-103）：轻轨段方向名（终点站展示名）—— 取自该段线路的 `LrtLive.directionName`；
    //   巴士段为 null。供前端渲染 `{終點}方向`（推荐卡副行 / 导航站条）。
    const segLv = ctx.live.get(seg.route);
    const segDirectionName = seg.kind === "lrt" && segLv?.kind === "lrt" ? segLv.directionName : null;
    // ★ v3.3.0（AC-105）：轻轨段实时状态（供轻轨优先判「当前营运中」；bus 段 undefined）
    const segLrtState = seg.kind === "lrt" && segLv?.kind === "lrt" ? segLv.state : undefined;

    rides.push({
      route: seg.route,
      kind: seg.kind,
      board: seg.board,
      alight: seg.alight,
      boardLabel: labelOf(ctx, seg.board),
      alightLabel: labelOf(ctx, seg.alight),
      directionName: segDirectionName,
      lrtState: segLrtState,
      // ★ B5.2：轻轨保留秒级精度（不取整）；巴士照常 1 位小数
      minutes: seg.kind === "lrt" ? ride.minutes : Math.round(ride.minutes * 10) / 10,
      rideSecText,
      // ★ B2：段内并行线（渲染白斜杠）
      // ★ U8：过「运营窗口 ∧ 实时车」谓词 —— 标签里不得出现已收班且无车的线
      parallelRoutes: keepParallel(seg.parallelRoutes),
      hops: seg.hops.length,
      levels: ride.levels,
      waitMin: Math.round(waitMin * 10) / 10,
      liveText: legText,
      /* ★ 2026-09-27（用户需求 1）：每段都带班次数据 —— 首段用本轮变量、后续段用换乘块备好的 */
      liveDepartures: i === 0 ? liveDepartures : liveDeparturesNext,
      liveClocks: i === 0 ? liveClocks : liveClocksNext,
      livePrecise: i === 0 ? livePrecise : livePreciseNext,
      liveMainMs: i === 0 ? liveMainMs : liveMainMsNext,
      // ★ v3.3.0（AC-107）：首段轻轨的保守赶车提示（仅档 1/2 且有时刻时非空）
      catchHint: i === 0 ? lrtCatchHint : undefined,
      tier: i === 0 ? tier : null,
      tierText: i === 0 ? tierTextOf(tier) : "",
      // ★ v1.1.2：档 1~2（要比常速更快）时补一句「需較常速快 X 分」——
      //   卡面那一行「步行 X 分」是**常速实测均值**，而总用时按该档速度算
      //   ⇒ 可见项直接相加会比顶部大字大。大字没错，缺的是这句解释。
      //   字段挂在 rides[0]，但渲染在卡面第一行「步行」上（差额正出在那一行）。
      tierHint: i === 0 ? tierHintOf(wOut.minutes, tier, wOut.distanceM, ctx.tierOverride) : "",
    });

    if (i + 1 >= segs.length) break;

    // ── 换乘步行 ──
    const tr = seed.transfers[i];
    const next = segs[i + 1];
    if (tr?.sameField) {
      transfers.push({
        at: seg.alight,
        atLabel: labelOf(ctx, seg.alight),
        minutes: 0,
        estimated: false,
        sameField: true,
      });
    } else {
      // ★ v3.3.0（AC-106）：**轻轨站内换乘**按距离常量折算（協和 336m / 蓮花 420m）；
      //   未收录该站 ⇒ 沿用原口径（高德几何 / `transfer_walks`）。分钟 = 米 ÷ 84（缩放交 catch-up）。
      const lrtTrM = lrtTransferWalkM(mainCodeOf(seg.alight)) ?? lrtTransferWalkM(mainCodeOf(next.board));
      const info =
        lrtTrM !== null
          ? {
              minutes: Math.round((lrtTrM / WALK_BASE_M_PER_MIN) * 10) / 10,
              samples: 0,
              source: "lrt-const",
              estimate: false,
            }
          : transferMinutes(ctx.transferIdx, seg.alight, next.board);
      cursor += info.minutes * 60_000;
      transfers.push({
        at: seg.alight,
        atLabel: labelOf(ctx, seg.alight),
        minutes: info.minutes,
        estimated: info.estimate,
        sameField: false,
      });
    }

    // ── 下一段等车：按「到达换乘站的时刻」取班次 ──
    // ★ v1.0.6：结果只写进 `waitNext` / `liveTextNext`（局部变量），由**下一轮**
    //   在 push 那一段时一并写入 —— 旧代码在这里直接改 `rides[i + 1]`，而下标 `i+1`
    //   此刻还不存在 → 赋值静默失效 → 第 2 段等车「算了却看不到」。
    //   ⚠️ `cursor` 的推进顺序与旧版完全一致，因此**总用时数值不变**，只是卡面显示补全。
    // ★ B4（需求 7）：第 2 段等车同时写进**刚 push 的换乘项** `transfers[i]`
    //   （= `transfers[transfers.length - 1]`），供卡面明细对账（AC-61）。
    const transferCur = transfers[transfers.length - 1];
    if (next.kind === "lrt") {
      const lv = ctx.live.get(next.route);
      if (!lv || lv.kind !== "lrt" || lv.state !== "running") {
        ctx.excluded.push(next.route);
        return null;
      }
      // ★ B4 顺延闸门（§h.3）：取「到达换乘站」之后**能赶上**的第一班；
      //   赶不上最近一班 ⇒ 顺延到能赶上的下一班（并计入等待）；
      //   末班（无后续）→ 剔除该换乘方案。
      // ★ 2026-09-27（用户口径）：**轻轨换乘不再叠加安全余量**——缓冲已由
      //   「进站等效距离（1.5 min）」与「换乘步行（協和 4 / 蓮花 5 min）」承担，
      //   旧值 `need = cursor + TRANSFER_SAFETY_MIN`（+3 min）会让明明能赶上的早班被跳过
      //   ⇒ 现直接以精算到达时刻（`cursor` = 到站 + 换乘步行）作为选班起点。
      const need = cursor;
      const depMs = lv.departures.find((d) => d >= need);
      if (depMs === undefined) {
        ctx.excluded.push(next.route);
        return null;
      }
      const gapMin = Math.max(0, (depMs - cursor) / 60_000);
      waitNext = gapMin;
      cursor = depMs;
      // ★ 2026-09-27（用户需求 1/2）：备好**下一段**的班次数据（参照 = `need`：到达换乘站 + 安全余量）——
      //   前班（need 前最近一班）一并带上（同首段口径）；`liveMainMsNext` = 模型选中的那班。
      {
        const stampedN = lv.departures.map((d, k) => ({ d, c: lv.clocks[k] ?? "", p: lv.precise?.[k] ?? false }));
        const chainN = [
          ...stampedN.filter((x) => x.d < need).slice(-1),
          ...stampedN.filter((x) => x.d >= need),
        ];
        liveDeparturesNext = chainN.map((x) => x.d);
        liveClocksNext = chainN.map((x) => x.c);
        livePreciseNext = chainN.map((x) => x.p);
        liveMainMsNext = depMs;
      }
      // 轻轨第 2 段拿到的是**真实班次时刻** → 文案用绝对时刻（就是你会坐的那一班）
      liveTextNext = `${hhmmOf(((depMs + 8 * 3_600_000) % 86_400_000) / 1000)} 开出`;
      if (transferCur) {
        /**
         * `slackMin` = 到站→发车 的**真实间隔**（确定性值，来自真实班次时刻表）。
         * ⚠️ 不保证 ≥ `TRANSFER_SAFETY_MIN`：`need = cursor` 时可能刚好差 10 秒（`gap ∈ [0,3)`）
         *    ⇒ `data-transfer-feasible` 记 `tight`，这是正确表达，不要用「+3 分钟安全余量」去修
         *    （2026-09-27 已证伪：加 3 分钟会跳过明明能赶上的早班）。
         * ⚠️ **仅在模式内可比**：巴士第 2 段是「保守余量」（无班表），与本值不同语义，
         *    两者喂同一个 risk 公式时不构成「轻轨 vs 巴士 谁更靠谱」的结论。见 `./transfer-slack.ts`。
         */
        transferCur.waitMin = Math.round(gapMin * 10) / 10;
        transferCur.slackMin = Math.round(gapMin * 10) / 10;
      }
    } else {
      // ★ B4（需求 7 / AC-61）：巴士第 2 段**无逐车/时刻表** ⇒ 按「到达换乘站的时刻」
      //   查 `route_frequency`（`headwayAt`），取**偏保守**值 `(lo + 2·hi)/3`；
      //   未命中 → 该线全时段班距中位数（`headwayMedian`）→ 仍无 ⇒ `null`（**明示降级**）。
      //   ⚠️ **不再回落写死常量**（旧「第 2 段巴士等车恒 180s」已废除，AC-61）。
      let waitBusMin: number | null = null;
      /** ★ 需求 7：命中的班距区间（用于算保守余量；走了中位数/无数据降级则为 null） */
      let busHit: ReturnType<typeof headwayAt> = null;
      if (ctx.headway) {
        busHit = headwayAt(ctx.headway, next.route, cursor);
        if (busHit) waitBusMin = conservativeWaitMin(busHit);
        else waitBusMin = headwayMedian(ctx.headway, next.route) ?? headwayMedian(ctx.headway);
      }
      if (waitBusMin !== null) {
        waitNext = waitBusMin;
        cursor += waitBusMin * 60_000;
        liveTextNext = "按班次间隔推算";
      } else {
        // 数据缺失 ⇒ **不计等待、不拍脑袋设默认值**（卡面明示「等车时间暂无数据」）
        waitNext = 0;
        liveTextNext = "等车时间暂无数据";
      }
      if (transferCur) {
        transferCur.waitMin = waitBusMin === null ? null : Math.round(waitBusMin * 10) / 10;
        /**
         * ★ 需求 7（v3.6.1）：巴士第 2 段的换乘余量（**原为 `null` ⇒ 风险项恒 0**）。
         *
         * 旧行为的事故：`slackMin = null` + `score.ts` 的「null 不加风险项」
         *   ⇒ 「40 秒换乘」与「8 分钟从容换乘」在 `cost` 上**完全相同**
         *   ⇒ 极限换乘方案可以排到第一（用户投诉的「不合理换乘也能排第一」）。
         *
         * ── **三档取值**（与 `07` §h.3 对齐；散写会被后来人合并成一个兜底值）──
         * ```
         * ① headwayAt 命中时段行     ⇒ slackMin = max(0, 2·lo − hi)   ← 保守余量
         * ② 未命中、中位数可用       ⇒ slackMin = 0                    ← 区间丢了 = 最不确定
         * ③ 连中位数都没有           ⇒ slackMin = SLACK_NO_DATA        ← 待测量，默认 0 ≈ tight
         * 同场换乘（sameField）       ⇒ **不写该字段**（undefined ⇒ H8 = yes）
         * ```
         * · 档 ② 取 `0` 而不是沿用中位数：中位数把 `lo/hi` 丢了，不确定性未知 ⇒
         *   按「不确定按风险处理」的团队原则走 `tight` 侧。
         * · 档 ③ 取 `SLACK_NO_DATA`（而非 `null`）：若取 `null` 会**比档 ② 更宽松**，
         *   属「数据越少越不告警」的逻辑倒挂；其唯一托底是上面那句卡面文案
         *   `liveTextNext = "等车时间暂无数据"`，文案一旦被删/改渲染，静默乐观就回来了。
         * ⚠️ 档 ③ 的 `SLACK_NO_DATA` **取值待测量**（`scripts/compare-slack-impact.ts`），
         *    不是定稿值，改它属调参（会改 cost 与排序）。
         * · 同场换乘**必须保持 `undefined`**（不是 `0`）：`0` 会走 `slack < 3 ⇒ tight`，
         *   把澳门最常见的同站台换乘全染红；而 A4 断言要靠 `undefined` 区分
         *   「同站台」与「无数据」。
         *   ⚠️ 不对称是**刻意**的：**轻轨**同场换乘仍写真实 `gapMin`（有班表 ⇒ 间隔可知，
         *   即便同站台也要赶上那一班）；**巴士**同场换乘不写（没有班表 ⇒ 0 步行不提供
         *   任何时序信息）。别为了"对称好看"把轻轨那侧也清空 —— 那是既有线上行为。
         *
         * ── 调参红线 ────────────────────────────────────────────────────
         * 单次换乘 risk 硬上界 = `riskFactor(0.5) × safetyMin(3) = 1.5` 分，
         * 而 `PREF_ALPHA = 10` 分/换乘 ⇒ risk 恒 < α 项的 **15%**，不可能淹没 cost；
         * **`riskFactor ≤ α/2 = 5` 是安全边界**（当前 0.5，10 倍余量），超过 5 会让
         * 「可行性」盖过「换乘次数」这个更硬的判据。
         *
         * ⚠️ 该值**不参与 `waitMin`/`totalMin`** —— 总用时口径一个字节都没变，
         *   只有 `cost` / 排序 / 风险字段变化。**安全余量只进评分与文案，
         *   绝不进可行性筛选**（`need = cursor` 那处 2026-09-27 已因误杀早班被修复）。
         */
        const r1 = (x: number) => Math.round(x * 10) / 10;
        if (transferCur.sameField) {
          // 同场换乘（巴士）：同站台、0 步行 ⇒ 不写 slackMin（保持 undefined ⇒ H8 = yes）
          slackTierSink.on?.({ tier: "sameField", route: next.route, slackMin: null });
        } else if (busHit) {
          transferCur.slackMin = r1(busTransferSlackMin(busHit));
          slackTierSink.on?.({
            tier: "hit",
            route: next.route,
            slackMin: transferCur.slackMin,
            lo: busHit.lo,
            hi: busHit.hi,
          });
        } else if (waitBusMin !== null) {
          // 档 ②：中位数可用 ⇒ 区间已丢，按最不确定处理
          transferCur.slackMin = 0;
          slackTierSink.on?.({ tier: "median", route: next.route, slackMin: 0 });
        } else {
          // 档 ③：连中位数都没有 ⇒ SLACK_NO_DATA（待测量，默认 0）
          transferCur.slackMin = r1(SLACK_NO_DATA);
          slackTierSink.on?.({ tier: "noData", route: next.route, slackMin: transferCur.slackMin });
        }
      }
    }
  }

  // ── 下车后步行到目的地 ──
  const last = segs[segs.length - 1];
  const wIn = walkView(ctx, seed.toSlug, last.alight, "in");
  cursor += wIn.minutes * 60_000;

  const totalMin = Math.max(0, (cursor - nowMs) / 60_000);

  // ── 乘车/换乘提示（开发者模式关闭时点击卡片展开）──
  // ★ v1.0.6：起点侧若是学校，指引里也写出发座区（否则「标题有座区、指引没有」会让人怀疑没生效）
  const hints: string[] = [];
  hints.push(
    seed.fromSlug === "school" && ctx.zone
      ? `从澳門科技大學（${ctx.zone} 座）步行出发，在 ${labelOf(ctx, first.board)} 上车，乘 ${first.route}`
      : `在 ${labelOf(ctx, first.board)} 上车，乘 ${first.route}`,
  );
  for (let i = 0; i + 1 < segs.length; i++) {
    const t = transfers[i];
    const next = segs[i + 1];
    hints.push(
      t?.sameField
        ? `到 ${labelOf(ctx, segs[i].alight)} 下车，同站台换乘 ${next.route}`
        : `到 ${labelOf(ctx, segs[i].alight)} 下车，步行 ${t?.minutes ?? TRANSFER_FALLBACK_MIN} 分换乘 ${next.route}`,
    );
  }
  hints.push(`到 ${labelOf(ctx, last.alight)} 下车，步行 ${wIn.minutes} 分到${placeLabelOf(ctx, seed.toSlug)}`);
  if (seed.crossBorder) hints.push("跨境行程：通关时间未计入总用时");

  // ── ★ v1.1.5：本班之外的后续班次 ──
  // 「上车之后到目的地」的固定耗时（车上 + 换乘 + 末段步行）—— 对本线任何一班都相同，
  // 所以只需算一次：后续班次的到达时刻 = 现在 + 该班 loSec + restMs。
  // ⚠️ 近似说明：多段路线里，第 2 段起的等车是按**本班**的到达时刻定的
  //   （巴士第 2 段恒用「班距 ÷ 2」估 → 与本班无关，精确；轻轨第 2 段取「到达后第一班」
  //    → 换成更晚的首段车时可能赶上更晚的一班 → 该 alt 的总时长会略偏乐观）。
  //   本字段只用于「值不值得列出来」的展示筛选，不参与排序与主数字，故接受此近似。
  const alts: AltBusView[] = [];
  if (first.kind === "bus" && busPool.length) {
    const restMs = cursor - boardAtMs; // cursor 此刻已是「最终到达时刻」
    // ★ v1.1.6：按 `loSec` 去重 —— DSAT 常把**同一站台的多辆车**一起上报（如 M172/16 三辆），
    //   同站同状态的车算出**完全相同**的 loSec ⇒ 行内容一模一样 ⇒ 卡面出现重复行，纯噪声。
    //   同时跳过与**本班** loSec 相同者（乘它到达时刻不变，列出来没有任何新信息）。
    const seenSec = new Set<number>([chosenBus?.loSec ?? -1]);
    for (const b of busPool) {
      if (b === chosenBus) continue; // 本班已在主行展示过
      if (seenSec.has(b.loSec)) continue; // 到达时刻与本班或已列出的某辆相同 → 无新信息
      const t = pickCatchTier(wOut.minutes, b.loSec, wOut.distanceM, ctx.tierOverride);
      if (t === null) continue; // 赶不上的后车不列（列了也没用）
      seenSec.add(b.loSec);
      alts.push({
        // ★ v2.3.0（A3）：打上所属线路码（并行线后续班次合并后按 route 分组）
        route: first.route,
        stopsAway: b.stopsAway,
        waitText: etaTextOf(b),
        tier: t,
        tierText: tierTextOf(t),
        totalMin: Math.round(((b.loSec * 1000 + restMs) / 60_000) * 10) / 10,
      });
    }
    alts.sort((a, b) => a.totalMin - b.totalMin);
  }

  return {
    card: {
      planId: seed.planId,
      summary: seed.summary,
      fromSlug: seed.fromSlug,
      toSlug: seed.toSlug,
      totalMin: Math.round(totalMin * 10) / 10,
      arriveAt: cursor,
      walkOut: wOut,
      rides,
      transfers,
      walkIn: wIn,
      hints,
      crossBorder: seed.crossBorder,
    },
    alts,
  };
}

/**
 * 方案排序（B4 / 需求 8）：按用户偏好三档（`cmpByPref`），缺省 `balanced`（cost 升序）。
 * 无 `prefs` ⇒ 等价于原来的「综合」档（cost = totalMin + α·换乘 + (β−1)·步行 + 风险）。
 * ⚠️ 偏好**不进** `switch-plans`（其组内仍按 `totalMin`，见 `switch-plans-shared`）。
 */
export function sortCards(cards: RecommendCard[], prefs: Prefs = PREF_DEFAULTS.balanced): RecommendCard[] {
  return [...cards].sort((a, b) => cmpByPref(a, b, prefs));
}

/* ══════════════════════════════════════════════════════════════════════════
   ★ v1.3.0：全澳导航适配层（设计 §C.8）—— 「高德骨架 → OptionSeed」
   ──────────────────────────────────────────────────────────────────────────
   把高德方案的**乘车段站序**注入 `segments[].hops`，即可让**旧 `modelOption`**
   原样计算（逐跳 `lookupHop` / 等车 / 赶车档 / 实时文案）—— **不改 `modelOption` 签名**。
   首末步行不走这里，而是由 `ModelContext.walkResolver` 注入（见 `walkView`）。
   ⚠️ 与 `segments` **一一对应**地保留**映射失败段**（hops 为空）—— 便于
      `recompute.patchAmapFallback` 按同一索引把高德时长补进去。
   ══════════════════════════════════════════════════════════════════════════ */

export interface AmapSeedMeta {
  /** 合成 planId（高德方案用 1..N；本地候选请用 ≥900000） */
  planId: number;
  summary: string;
  fromSlug: string;
  toSlug: string;
  crossBorder?: boolean;
}

/**
 * 高德骨架 → `OptionSeed`。
 *
 * @returns null = 无乘车段（无法建模）
 */
export function amapPlanToSeed(seed: AmapPlanSeed, meta: AmapSeedMeta): OptionSeed | null {
  const segments: RideSegment[] = [];
  for (const leg of seed.legs) {
    // 线路名认不出（mappedRoute=null）→ 用占位 route（该段无实时/无段统计 → 后续回落高德时长；
    //   若它是**首段**，`modelOption` 因取不到实时而整条剔除 —— 属预期，见 nav-service 注释）
    const route = leg.mappedRoute ?? `__amap_${leg.kind}`;
    const board = leg.mappedBoard ?? leg.amapBoard.name;
    const alight = leg.mappedAlight ?? leg.amapAlight.name;
    segments.push({
      route,
      kind: leg.kind,
      board,
      alight,
      hops: leg.mappedHops ?? [],
      // ★ v2.3.0（B2）：段内并行线（仅高德腿有；本地/链枚举不填）
      ...(leg.parallelRoutes?.length ? { parallelRoutes: leg.parallelRoutes } : {}),
    });
  }
  if (!segments.length) return null;

  const transfers: TransferSegment[] = [];
  for (let i = 0; i + 1 < segments.length; i++) {
    const a = segments[i];
    const b = segments[i + 1];
    // 换乘口径由 `recompute.overlayTransferIndex` 决定（sameField 恒 false →
    // 让 `model.ts#transferMinutes` 走「注入的方案级换乘索引」而非写死 0）
    transfers.push({ at: a.alight, to: b.board, sameField: false });
  }

  const key = segments.map((s) => `${s.route}@${mainCodeOf(s.board)}>${mainCodeOf(s.alight)}`).join("|");
  return {
    planId: meta.planId,
    summary: meta.summary,
    fromSlug: meta.fromSlug,
    toSlug: meta.toSlug,
    crossBorder: meta.crossBorder ?? false,
    segments,
    transfers,
    key,
  };
}
