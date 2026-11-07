/**
 * 预设地点常量（src/lib/recommend/place-ids.ts，2026-11-06 通琴号迭代）
 *
 * ── 为什么要把 `places` 表变成常量 ────────────────────────────────────
 *   `places` 只有 4 行（家 / 学校 / 横琴口岸 / 关闸），却是 5 条外键的父表。
 *   本迭代删表时保留 `walk_times`（20 行实测数据），但必须去掉它的外键，
 *   于是「place_id → slug」这层映射不能再靠 JOIN 得到 —— 改为代码常量。
 *
 *   实测行（删表前快照，2026-11-06）：
 *     id=1 home「擎天匯 T8」· id=2 school「澳科大」
 *     id=3 hengqin「橫琴口岸（澳方口岸 / 橫琴站）」· id=7 gate「關閘（拱北口岸）」
 *
 * ⚠️ **id 不能重新编号**：`walk_times.place_id` 与 `timer_sessions` 历史数据里
 *    存的就是这几个值，改号等于把所有历史步行样本指到错误地点（静默错，不报错）。
 *
 * ── 为什么要带 `WALK_OD_PAIRS` 与 `PLACE_WALK_STATIONS` ────────────────
 *   离线重建（`rebuild/walk-times.ts`、`rebuild/walk-candidates.ts`）原本从
 *   `commute_plans` + `plan_legs` 推导「某地点可能走到哪些站」。这两张表本批删除，
 *   推导结果已固化成下面的常量（生成口径 = 删表前的真实数据，可逐值复核）。
 *
 *   固定 6 个 OD 对 = 家 ⇄ 学校 / 横琴口岸 / 关闸，正是原 14 条生效方案覆盖的全部方向。
 *   `planIds` 是历史 `timer_sessions.plan_id` 的归属表 —— 计时链已 410 下线、
 *   不会再产生新会话，故这份映射**永久冻结**，不存在「新方案要补进来」的问题。
 *
 * 本文件是纯常量 + 纯函数，**不得** import pg / server-only 模块。
 */

/** place_id → slug（**逐字对应删表前的库内值**，不可重排） */
export const PLACE_SLUG_BY_ID: Readonly<Record<number, string>> = {
  1: "home",
  2: "school",
  3: "hengqin",
  7: "gate",
} as const;

/** slug → place_id（反向查表） */
export const PLACE_ID_BY_SLUG: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(PLACE_SLUG_BY_ID).map(([id, slug]) => [slug, Number(id)]),
) as Readonly<Record<string, number>>;

/** slug → 展示短名（原 `home-plans-shared.ts#PLACE_SHORT`，随该文件迁到此处） */
export const PLACE_SHORT: Readonly<Record<string, string>> = {
  home: "擎天匯",
  school: "澳門科技大學",
  hengqin: "橫琴口岸",
  gate: "關閘（拱北口岸）",
} as const;

/**
 * slug → 库内原名（**删表前 `places.name` 原值逐字快照**，2026-11-06）。
 *
 * 为什么不能直接用 `PLACE_SHORT`：两者口径不同 —— `PLACE_SHORT` 是**界面上要短的**，
 * 这里是**别名库里要全的**。`scripts/seed-poi-aliases.ts` 会把本值本身也灌成一条
 * 「官方名」别名（weight 1.3），换成短名会静默丢掉「擎天匯 T8」「橫琴口岸（澳方口岸 / 橫琴站）」
 * 这类能命中的长写法。
 */
export const PLACE_NAME_BY_SLUG: Readonly<Record<string, string>> = {
  home: "擎天匯 T8",
  school: "澳科大",
  hengqin: "橫琴口岸（澳方口岸 / 橫琴站）",
  gate: "關閘（拱北口岸）",
} as const;

/** 起点 place（宿舍/擎天匯）slug */
export const HOME_SLUG = "home";

/** 澳門科技大學的三个校区座别 —— 三栋不同建筑 = 三个不同目的地，各算一组步行 */
export const SCHOOL_ZONES = ["B/C", "N/O", "R"] as const;
export type SchoolZone = (typeof SCHOOL_ZONES)[number];

/** 地点坐标（**WGS84**，原 `place_coords` 6 行原值；与 `stations` 同系，勿转 GCJ） */
export interface PlaceCoordConst {
  place_id: number;
  zone: string | null;
  lat: number;
  lng: number;
  source: string;
}

export const PLACE_COORDS: readonly PlaceCoordConst[] = [
  { place_id: 1, zone: null, lat: 22.1301754167269, lng: 113.55910051177, source: "amap-search" },
  { place_id: 2, zone: "B/C", lat: 22.1516655436928, lng: 113.565888869934, source: "amap-search" },
  { place_id: 2, zone: "N/O", lat: 22.1519150877303, lng: 113.566924771965, source: "amap-search" },
  { place_id: 2, zone: "R", lat: 22.1533878587671, lng: 113.569342969761, source: "amap-search" },
  { place_id: 3, zone: null, lat: 22.1404104628081, lng: 113.545310246236, source: "amap-search" },
  { place_id: 7, zone: null, lat: 22.2159084090932, lng: 113.549140497853, source: "amap-search" },
] as const;

/** 一个固定 OD 对（含起点侧/到点侧的候选站**主码**） */
export interface WalkOdPair {
  from: number;
  to: number;
  /** 历史 `timer_sessions.plan_id` 归属（冻结：计时链已下线，不再产生新会话） */
  planIds: readonly number[];
  /** 起点侧候选站主码（出发地 → 上车站） */
  start: readonly string[];
  /** 到点侧候选站主码（下车站 → 目的地） */
  end: readonly string[];
}

/**
 * 固定 6 个 OD 对（删表前从 `commute_plans` × `plan_legs` 推导后固化）。
 * 口径与原实现一致：walk 腿 seq 极值 → 该侧载具段的 board/alight 候选 ∪ route_meta 的 board/alight/to。
 */
export const WALK_OD_PAIRS: readonly WalkOdPair[] = [
  {
    from: 1,
    to: 2,
    planIds: [1, 2, 3, 4, 6, 8, 9, 25, 36, 37],
    start: ["C653", "C689", "C690", "LRT-SPW"],
    end: ["LRT-LDE", "LRT-MUST", "T363", "T367", "T374", "T400", "T429"],
  },
  {
    from: 2,
    to: 1,
    planIds: [10, 13, 14, 15, 16, 21, 22, 23, 24],
    start: ["LRT-LDE", "LRT-MUST", "T373", "T417"],
    end: ["C652", "C688", "C690", "LRT-SPW"],
  },
  {
    from: 1,
    to: 3,
    planIds: [17, 18],
    start: ["C653", "LRT-SPW"],
    end: ["LRT-HQ", "T560"],
  },
  {
    from: 3,
    to: 1,
    planIds: [19, 20],
    start: ["LRT-HQ", "T560"],
    end: ["C652", "LRT-SPW"],
  },
  {
    from: 1,
    to: 7,
    planIds: [26, 27, 28, 29, 30],
    start: ["C653", "C689", "C690"],
    end: ["M1", "M9"],
  },
  {
    from: 7,
    to: 1,
    planIds: [31, 32, 33, 34, 35],
    start: ["M1", "M9"],
    end: ["C652", "C688", "C690"],
  },
] as const;

/**
 * place_id → 该地点可能步行到达的站点**主码**集合。
 * = 上面 6 个 OD 对里「作为起点」与「作为终点」的候选站并集去重。
 */
export const PLACE_WALK_STATIONS: Readonly<Record<number, readonly string[]>> = {
  1: ["C652", "C653", "C688", "C689", "C690", "LRT-SPW"],
  2: ["LRT-LDE", "LRT-MUST", "T363", "T367", "T373", "T374", "T400", "T417", "T429"],
  3: ["LRT-HQ", "T560"],
  7: ["M1", "M9"],
} as const;

/** `plan_id` → 所属 OD 对（未收录返回 null；调用方应跳过而不是猜） */
export function odPairOfPlanId(planId: number): WalkOdPair | null {
  for (const p of WALK_OD_PAIRS) {
    if (p.planIds.includes(planId)) return p;
  }
  return null;
}
