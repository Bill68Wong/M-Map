/**
 * 同线同站收敛（src/lib/recommend/converge.ts，2026-11-04 新增 · 需求 U9）
 *
 * ── 要解决的问题 ──────────────────────────────────────────────────────
 *   `enumerate.ts` 对**每个下车点各展开一条独立 seed**（`enumerate.ts:265-266`），
 *   再叠加「每个上下车站台写法各一条」⇒ 同一条线可能拿到 3~5 个名额，
 *   而它们说的是**同一件事**（同一趟车、同一条线、同一物理上下车点）。
 *
 *   业界对照：高德把多条线放进 `segments[].bus.buslines[]`（**段内数组**），
 *   但**方案级仍是一方案一上下车点**；Google 的 `transit_details.line` 是单值。
 *   五家全是「择优」而非「穷举」——我们现状是穷举 ⇒ 收窄成「一卡一个下车点」。
 *
 * ── 已拍板的边界（不要顺手扩大）───────────────────────────────────────
 *   · 段内并列（L1，`RouteStack` 的白斜杠）**保留**；
 *   · 卡级「跨下车站合并」**不做**（那是另一件事，会改写卡面语义）；
 *   · 收敛**只在同一 `route` 内**发生，跨线永不收敛：
 *       `25` 与 `26A` 必须 2 张卡；`25` 与 `25X` **必须视为两条线**
 *       （按完整线码，不是数字前缀 —— 否则会把真实更优方案并掉）。
 *
 * ── 收敛键 vs 命中四元组（**刻意不同，不要统一**）─────────────────────
 *   · 命中四元组（`card.ts#cardDetail` / `card-link.ts`）= `planId + route + board + alight`
 *     ⇒ 用途是「**精确定位到那张卡**」⇒ 必须用**原始站码**；
 *   · 收敛键 = `route | mainCodeOf(board) | mainCodeOf(alight)`
 *     ⇒ 用途是「**判断是否同一方案**」⇒ 必须**归一**（`C690/3 ≡ C690`，同站多台是同一物理位置）。
 *
 * ── 结构性保证（最重要）───────────────────────────────────────────────
 *   代表站就是被保留下来的那张卡的 `rides[0].alight` **本身**，**不新增独立字段**。
 *   ⇒ 「选了代表站但忘了同步 href」这类 bug 在结构上不可能发生
 *     （不需要靠注释提醒，也不需要额外的同步代码）。
 */
import { ALIGHT_OTHERS_MAX } from "./limits";
import { mainCodeOf } from "./segment-lookup";
import type { PrefMode } from "./score";
import type { RecommendCard } from "./types";

/** 收敛键：同线 + 同上车点（主码）+ 同下车点（主码） */
export function convergeKeyOf(card: RecommendCard): string {
  const r0 = card.rides[0];
  if (!r0) return "";
  return `${r0.route}|${mainCodeOf(r0.board)}|${mainCodeOf(r0.alight)}`;
}

/**
 * 组内代表卡选法（按用户偏好）。
 *   · `less_walk` ⇒ `argmin(walkIn.minutes)`（少步行档关心的是「下车后少走」，不是总时长）；
 *   · `balanced` / `fewer_transfers` ⇒ `argmin(totalMin)`。
 * 同值时保持**先出现者**（`Array#sort` 稳定语义 ⇒ 结果可复现）。
 */
function betterThan(a: RecommendCard, b: RecommendCard, mode: PrefMode): boolean {
  if (mode === "less_walk") {
    if (a.walkIn.minutes !== b.walkIn.minutes) return a.walkIn.minutes < b.walkIn.minutes;
    return a.totalMin < b.totalMin;
  }
  return a.totalMin < b.totalMin;
}

/**
 * 把「同线同上下车站（按主码）」的多张卡收敛成一张。
 *
 * ⚠️ 必须在 `sortCards` **之前**、`slice(limit)` **之前**调用：
 *   先 slice 再收敛等于「被收敛的卡已经占掉名额」⇒ 收敛白做。
 *
 * @param cards 已建模的全部卡（未排序也可）
 * @param mode  用户偏好档（决定代表站选法）
 * @returns 新数组（不改入参）；保序 = 组内首次出现的位置，内容 = 该组代表卡
 */
export function convergeByAlight(cards: RecommendCard[], mode: PrefMode = "balanced"): RecommendCard[] {
  const best = new Map<string, RecommendCard>();
  for (const c of cards) {
    const k = convergeKeyOf(c);
    if (!k) continue;
    const cur = best.get(k);
    if (!cur || betterThan(c, cur, mode)) best.set(k, c);
  }
  const out: RecommendCard[] = [];
  const emitted = new Set<string>();
  for (const c of cards) {
    const k = convergeKeyOf(c);
    if (!k || emitted.has(k)) continue;
    emitted.add(k);
    const pick = best.get(k);
    if (pick) out.push(pick);
  }
  return out;
}

/** 备选下车点（纯数据；`href` 由调用方用 `buildCardHref` 拼，本模块不碰 URL 契约） */
export interface OtherAlight {
  /** 原始站码（带站台号）—— 与命中四元组同域 */
  code: string;
  /** 展示文案：`站码 站名` */
  label: string;
  /** 该下车站所属方案 id（同一上车站的不同下车站同属一个方案腿） */
  planId: number;
  /** 上车站原始站码 */
  board: string;
}

/** 取 seeds 的最小结构（只读，便于单测用合成数据） */
export interface SeedLike {
  planId: number;
  segments: readonly { route: string; board: string; alight: string }[];
}

/**
 * ★ 2026-11-04（U9）：**同线同站的其他下车点**（详情页「另有 N 个下车点」）。
 *
 * 为什么从 seeds 反推而不是给卡片加字段：`enumerate.ts` 已把每个下车点各展开成一条 seed，
 * 所以「这条线在这个上车站能下哪些站」在 seeds 里是现成的；而卡片**不新增字段**
 * （代表站就是 `card.rides[0].alight` 本身 ⇒ 结构上不可能「忘记同步 href」）。
 *
 * 口径：
 *   · 只在**同一 route + 同一上车站（主码）**内收集 —— 跨线永不合并（`25` 与 `25X` 是两条线）；
 *   · 按 `mainCodeOf` 归一去重（`C690/3 ≡ C690`），并排除当前这张卡的下车点；
 *   · `max` 上限（默认 `ALIGHT_OTHERS_MAX`，产品建议值见 limits.ts）。
 */
export function otherAlightsOf(
  route: string,
  board: string,
  alight: string,
  seeds: readonly SeedLike[],
  nameOf: { get(code: string): string | undefined },
  max: number = ALIGHT_OTHERS_MAX,
): OtherAlight[] {
  const boardMain = mainCodeOf(board);
  const seen = new Set<string>([mainCodeOf(alight)]);
  const out: OtherAlight[] = [];
  for (const s of seeds) {
    const g0 = s.segments[0];
    if (!g0 || g0.route !== route) continue;
    if (mainCodeOf(g0.board) !== boardMain) continue;
    const k = mainCodeOf(g0.alight);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      code: g0.alight,
      label: `${g0.alight} ${nameOf.get(g0.alight) ?? ""}`.trim(),
      planId: s.planId,
      board: g0.board,
    });
    if (out.length >= max) break;
  }
  return out;
}
