"use client";

/**
 * 推荐列表数据 hook（src/components/nav/useRecommend.ts，2026-09-23 新增）
 *
 * 从 `RouteResultSheet` 抽出：`GET /api/nav?<query>` + 并发保护 + 同一 query 只自动拉一次。
 * 由 `RouteSheet`（宿主）持有，`RouteResultPane` 只负责渲染 ⇒ 宿主可据同一份数据渲染 peek 摘要。
 *
 * ── ★ v3.6.0 S4（需求 R3）：刷新 = 「只刷数字，不换路线」────────────────
 *   · `load(q, { nocache })` —— `reload({nocache:true})` 透传 `nocache=1`
 *     旁路服务端 `transit_cache`（`api/nav/route.ts` 已支持），保证拿到真·最新；
 *   · 结果经 `mergeCardsStable`（`merge-cards.ts`）合入：**保留旧顺序与结构**，
 *     只覆盖会变的数字；本轮已无对应的旧卡**直接丢弃**（保留会让列表随刷新膨胀）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RecommendCard } from "@/lib/recommend/types";
import type { PrefMode } from "@/lib/recommend/score";
import { errorTextOf } from "@/lib/ui/error-text";
import { clearSmoothMem } from "@/lib/eta-smooth";
import { mergeCardsStable } from "./merge-cards";

/**
 * 自动重拉的防抖窗口（ms）。
 * 5s 的取值理由：① 比一次 `/api/nav` 的 P90（冷态 8s 上限内、热态 ~1.5s）略长，
 * 面板开合抖动（收起又立刻打开）不会打出重复请求；② 远小于「数据开始不可信」的量级
 * （车辆 12s 一帧、到站读数秒级变化）⇒ 超过它就必须重拉，不能拿旧数字骗人。
 */
const LOAD_DEDUPE_MS = 5_000;

/** ★ 本批（需求⑧ / AC-52/53）：偏好档类型沿用后端 `score.ts`（唯一真源；避免跨层重复定义）。 */
export type { PrefMode };

export interface RecommendData {
  cards: RecommendCard[];
  colors: Record<string, string>;
  degraded: boolean;
  emptyReason: string | null;
  nearbyWalkMin: number | null;
  excluded: string[];
  missed: string[];
  fromSlug: string;
  toSlug: string;
}

interface NavResp {
  ok?: boolean;
  error?: string;
  cards?: RecommendCard[];
  colors?: Record<string, string>;
  degraded?: boolean;
  emptyReason?: string | null;
  nearbyWalkMin?: number | null;
  excluded?: string[];
  missed?: string[];
  fromSlug?: string;
  toSlug?: string;
}

export interface UseRecommend {
  phase: "idle" | "loading" | "ready" | "failed";
  data: RecommendData | null;
  err: string;
  /**
   * ★ v3.6.0 S4：刷新推荐。
   * @param opts.nocache `true` ⇒ 附 `nocache=1` 旁路服务端缓存（用户主动刷新时用）
   */
  reload: (opts?: { nocache?: boolean }) => void;
}

export function useRecommend(
  query: string,
  open: boolean,
  prefs: PrefMode = "balanced",
  /**
   * ★ v3.3.0（AC-105）：**轻轨优先**开关 —— 透传 `/api/nav?lrtFirst=1`（后端在 `rankItems` 之后、
   * `slice(limit)` 之前重排；未触发时静默、只重排不增删）。
   */
  lrtFirst = false,
): UseRecommend {
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [data, setData] = useState<RecommendData | null>(null);
  const [err, setErr] = useState("");
  /**
   * ★ v3.7.0（P1 · 负责人投诉的「同一个起终点不会再刷新」）—— 已加载标记改为**带时刻**。
   *
   * 旧实现 `loadedQueryRef.current === fullQuery ⇒ return` 里**没有任何时间因素**，而
   * `fullQuery` 由 `StepSheet.queryOf` 生成的**确定性字符串**（不含时间戳）；本 hook 又挂在
   * `RouteSheet` 内**不卸载**。后果（与负责人描述完全一致）：
   *   搜完 A→B、收起面板，20 分钟后再点同一 OD ⇒ **一个请求都不发**，
   *   屏幕上仍是 20 分钟前的车辆位置、到站站数、以及已经过去的到达时刻。
   *   （点刷新才对、F5 也对 —— 因为那两条路走的是 `reload()` / 重新挂载。）
   *
   * 现在：**同一个 q 且距上次加载 < 5s** 才跳过（纯防抖），**超过 5s 一律重拉**。
   *
   * ⚠️⚠️ **绝对不要把时间戳拼进 `fullQuery`**：它同时是 `mergedForRef` 的守卫键
   *   （`mergeCardsStable` 只对「同一批方案」成立）。掺时间 ⇒ merge 永不命中 ⇒
   *   列表每次整体替换、顺序乱跳、旧条件残留 —— 那正是 2026-10-29 commit `3b7096f`
   *   修掉的阻断缺陷。时间因素只能放在本 ref 里，不许进键。
   */
  const loadedAtRef = useRef<{ q: string; at: number } | null>(null);
  /**
   * ★★ S4 评审阻断 ①（**必须**，别简化成"prev 存在就 merge"）：
   *   merge 只对「**同一 query** 的刷新」成立。`prev` 的生命周期跨 OD、跨偏好、跨轻轨优先开关，
   *   无条件 merge 会造成三处**可见功能破坏**（架构已实测）：
   *     · 换目的地 ⇒ 旧目的地路线残留在最前（3 张变 6 张）；
   *     · 切偏好档 ⇒ 服务端已重排却被旧顺序覆盖 ⇒ 排序永久失效（AC-52/53）；
   *     · 切轻轨优先 ⇒ 未置顶 + 角标丢失（AC-105）。
   *   ⇒ 用**上一次真正发起的完整查询键**做守卫：同键才 merge，换键整体替换。
   *   键的来源 = `fullQuery`（含 from/to/zone + prefs + lrtFirst），`nocache` 不计入（它不改变语义）。
   */
  const mergedForRef = useRef<string | null>(null);
  /** 并发保护：只认最后一次请求的结果 */
  const reqIdRef = useRef(0);

  /** ★ 本批：query + `prefs` 组合键（偏好切换 ⇒ 重新拉取并重排）；
   *  ★ v3.3.0：并入 `lrtFirst`（开关切换 ⇒ 同样重拉重排）。 */
  /**
   * ★★ **query 键 = merge 守卫的判定依据**（见下方 `mergedForRef`）。
   *   ⇒ 凡是会改变「这批方案是哪一批」的输入，**必须**进本键，否则换值时会残留旧路线
   *     （表现：旧条件下的卡排在最前，且顺序被锁死）。
   *   ⚠️ **若将来接入「座区选择」（zone）**：`zone` 必须加进本键。
   *      `query` 目前只含 from/to 坐标，不含 zone —— 届时漏加 = 换座区仍显示旧座区的方案。
   */
  const fullQuery = query ? `${query}&prefs=${prefs}&lrtFirst=${lrtFirst ? 1 : 0}` : query;

  const load = useCallback(async (q: string, opts?: { nocache?: boolean }) => {
    const id = ++reqIdRef.current;
    loadedAtRef.current = { q, at: Date.now() };
    setPhase("loading");
    setErr("");
    try {
      // ★ v3.6.0 S4：`nocache=1` 旁路服务端 transit_cache（用户主动刷新才带）
      const url = opts?.nocache ? `/api/nav?${q}&nocache=1` : `/api/nav?${q}`;
      const res = await fetch(url, { cache: "no-store" });
      const j = (await res.json()) as NavResp;
      if (id !== reqIdRef.current) return;
      // ★ v3.6.0：`j.error` 是服务端枚举 ⇒ 先过 `errorTextOf`，`err` 会被 `RouteResultPane` 直接渲染
      if (!j.ok) throw new Error(j.error ? errorTextOf(j.error) : "加载失败");
      const nextCards = j.cards ?? [];
      /**
       * ★ v3.6.0 S4（只刷数字不换路线）+ 评审阻断 ①（query 守卫）：
       *   · **同一 query** 的刷新 ⇒ 以旧顺序为主轴合入，只覆盖会变的数字；
       *   · **query 变了**（换 OD / 切偏好 / 切轻轨优先）⇒ **整体替换**，
       *     否则服务端重排会被旧顺序覆盖、旧目的地的卡会残留在列表最前。
       */
      const sameQuery = mergedForRef.current === q;
      mergedForRef.current = q;
      /**
       * ★ v3.7.0（顺手项）：**OD 真的变了**才清一次报站平滑记忆。
       *   平滑记忆键是 `线路|车牌|等车站`（不含 OD）⇒ 两条行程共用同车同站时，
       *   后一条会继承前一条的封顶值（「还有 N 站」偏高且降不下来）。
       *   位置选择理由：这里正好有"query 是否变化"的判定（`sameQuery`），
       *   且每次加载只经过一次 ⇒ 不会频繁清空（同行程内的平滑不受影响）。
       */
      if (!sameQuery) clearSmoothMem();
      setData((prev) => ({
        cards: prev && sameQuery ? mergeCardsStable(prev.cards, nextCards) : nextCards,
        colors: j.colors ?? prev?.colors ?? {},
        degraded: !!j.degraded,
        emptyReason: j.emptyReason ?? null,
        nearbyWalkMin: j.nearbyWalkMin ?? null,
        excluded: j.excluded ?? [],
        missed: j.missed ?? [],
        fromSlug: j.fromSlug ?? "",
        toSlug: j.toSlug ?? "",
      }));
      setPhase("ready");
    } catch (e) {
      if (id !== reqIdRef.current) return;
      setErr((e as Error).message || "加载失败，请稍后再试");
      setPhase("failed");
    }
  }, []);

  /**
   * 打开时（含首次）拉取。
   * ★ v3.7.0（P1）：**同一 query 只在 5s 内免重拉**；超过 5s（含"收起面板 20 分钟后再点同一 OD"）
   *   一律重拉 —— 否则车辆位置/到站站数/到达时刻都会停在很久以前。见 `loadedAtRef` 的注释。
   */
  useEffect(() => {
    if (!open || !fullQuery) return;
    const prev = loadedAtRef.current;
    if (prev && prev.q === fullQuery && Date.now() - prev.at < LOAD_DEDUPE_MS) return;
    void load(fullQuery);
  }, [open, fullQuery, load]);

  return { phase, data, err, reload: (opts?: { nocache?: boolean }) => void load(fullQuery, opts) };
}
