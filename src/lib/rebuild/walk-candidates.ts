/**
 * 步行需求组的统一枚举（src/lib/rebuild/walk-candidates.ts，v1.2.0）
 *
 * ── 这个模块解决什么问题 ──────────────────────────────────────────────
 *   `walk_times` 的聚合键是 **(place, 站码主码, zone)**。但「到底有哪些组」这件事
 *   在两个地方都要用：
 *     · `walk-times.ts`  —— 从实测样本聚合出 minutes
 *     · `walk-distances.ts` —— 给这些组去高德抓距离
 *   两边必须**枚举出同一套键**，否则抓了距离却对不上聚合键、白干活。
 *   ⇒ 抽到这个模块，两边共用一份真相源。
 *
 * ── 需求组为什么只有几十个而不是 595 × 4 × 3 ─────────────────────────
 *   只枚举「读端真的会查的那些组合」—— 来源已固化为 `place-ids.ts#WALK_OD_PAIRS`（原为 `commute_plans` + `plan_legs`）
 *   上下车候选集（三处汇总，见下），再按 place 展开 zone。
 *   绝不枚举全部 595 个站点。
 *
 * ── 候选集来自三处（与 walk-times.ts v0.28.0 口径一致，必须同步）────────
 *   ① walk 腿自身的 `to_station`（起点侧）/ `from_station`（到点侧）
 *   ② veh 腿的 `board_candidates` / `alight_candidates` 两列
 *   ③ veh 腿 `route_meta` 中每条备选线路的 `board` / `alight` / `to`
 *   ⚠️ 「首段/末段 walk」只比较 `leg_kind='walk'` 的腿的 seq 极值 ——
 *      不能用所有腿的极值（跨境方案的 cross_border 腿会把步行腿挤出极值位）。
 *
 * ── 站码主码归一 ──────────────────────────────────────────────────────
 *   `C690/3 → C690`、`M9/2 → M9` —— 同台多线站台是**同一物理位置**、步行时长一致，
 *   样本与距离都必须合并成一行（与读端 `segment-lookup.ts#mainCodeOf` 口径一致）。
 */
import type { Pool } from "pg";
import { PLACE_ID_BY_SLUG, PLACE_SLUG_BY_ID, WALK_OD_PAIRS } from "@/lib/recommend/place-ids";

/** 站码主码归一：剥掉站台号后缀（C690/3 → C690、M9/2 → M9、T376/1 → T376） */
export const mainCode = (c: string): string => /^[A-Za-z]+\d+/.exec(c)?.[0] ?? c;

/** 澳門科技大學的三个校区座别 —— **三栋不同建筑 = 三个不同目的地**，各算一组 */
export const SCHOOL_ZONES = ["B/C", "N/O", "R"] as const;
export type SchoolZone = (typeof SCHOOL_ZONES)[number];

export interface WalkNeed {
  placeId: number;
  placeSlug: string;
  /** 站码主码（C690、T363），与 walk_times 聚合键一致 */
  stationMain: string;
  /** 'B/C' | 'N/O' | 'R'；非澳門科技大學 place 恒为 null */
  zone: string | null;
  /**
   * 该主码下**真实存在的站台码列表**（如 ['C690/1','C690/2','C690/3']）
   * —— `walk_times.station_code` 有 FK 指向 `stations(code)`，而 stations 里
   *    只有带站台号的行、**没有主码行**，所以落库必须用这些值。
   */
  stationCodes: string[];
}

/**
 * 枚举全部「步行需求组」= (place, 站码主码, zone) 的去重集合
 *
 * @param onlyActivePlaces **已失效**（2026-11-06）：`places` 表已删，地点集合改由
 *   `place-ids.ts#PLACE_SLUG_BY_ID` 常量给出，四个地点都是原 `is_active = true` 的行。
 *   保留参数只为不破坏既有调用签名。
 */
export async function enumerateWalkNeeds(
  pool: Pool,
  opts: { onlyActivePlaces?: boolean } = {},
): Promise<WalkNeed[]> {
  // ★ 2026-11-06：`places` / `commute_plans` / `plan_legs` 三表已删（Spec §6.2），本模块**不再读库推导**。
  //   地点表与候选站集全部来自 `@/lib/recommend/place-ids`（`WALK_OD_PAIRS` 等常量）。
  //   与 `walk-times.ts#rebuildWalkTimes` 必须保持同一口径：两边枚举不出同一套键 ⇒ 抓了距离却对不上聚合键、白干活。
  void opts.onlyActivePlaces; // 保留签名为兼容旧调用；常量里 4 个地点均为原 `is_active = true` 行
  const schoolId = PLACE_ID_BY_SLUG.school;
  /** 地点 id → slug（常量表反查；未收录的 id 不存在，故无需兜底分支） */
  const slugOf = new Map<number, string>(
    Object.entries(PLACE_SLUG_BY_ID).map(([id, slug]) => [Number(id), slug as string]),
  );

  /** (地点 id → 主码集合) */
  const byPlace = new Map<number, Set<string>>();
  const add = (placeId: number, code: string) => {
    const m = mainCode(code);
    let s = byPlace.get(placeId);
    if (!s) {
      s = new Set();
      byPlace.set(placeId, s);
    }
    s.add(m);
  };
  // 起点侧 = `pair.start`（出发地 → 上车站），到点侧 = `pair.end`（下车站 → 目的地）。
  // ⚠️ 这两个数组已是「三处候选源的并集」的固化结果（见 place-ids.ts 头部），**不要**
  //    再按「只取首个」之类的方式收窄：那会把動態下车点的距离永远抓不到。
  for (const pair of WALK_OD_PAIRS) {
    for (const c of pair.start) add(pair.from, c);
    for (const c of pair.end) add(pair.to, c);
  }

  // ── 主码 → 真实站台码列表（落库用；FK 指向 stations.code）──
  const stationRows = (
    await pool.query(`
    SELECT code,
           COALESCE(substring(code from '^[A-Za-z]+[0-9]+'), code) AS main
      FROM stations
     WHERE code IS NOT NULL
  `)
  ).rows as { code: string; main: string }[];
  const codesOfMain = new Map<string, string[]>();
  for (const r of stationRows) {
    const a = codesOfMain.get(r.main);
    if (a) a.push(r.code); else codesOfMain.set(r.main, [r.code]);
  }

  // ── 展开 zone 维度 ──
  const needs: WalkNeed[] = [];
  for (const [placeId, mains] of byPlace) {
    const slug = slugOf.get(placeId) ?? "?";
    const zones: (string | null)[] = placeId === schoolId ? [...SCHOOL_ZONES] : [null];
    for (const stationMain of [...mains].sort()) {
      const stationCodes = codesOfMain.get(stationMain);
      if (!stationCodes?.length) continue; // 站表里不存在这个主码 → 跳过（FK 会拦）
      for (const zone of zones) {
        needs.push({ placeId, placeSlug: slug, stationMain, zone, stationCodes: [...stationCodes].sort() });
      }
    }
  }
  // 稳定排序（便于 diff 与报告）
  needs.sort(
    (a, b) =>
      a.placeSlug.localeCompare(b.placeSlug) ||
      a.stationMain.localeCompare(b.stationMain) ||
      String(a.zone ?? "").localeCompare(String(b.zone ?? "")),
  );
  return needs;
}
