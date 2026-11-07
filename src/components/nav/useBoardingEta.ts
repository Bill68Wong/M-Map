"use client";

/**
 * 候车实时到站（src/components/nav/useBoardingEta.ts，2026-11-06 · 修复批 #9）
 *
 * ── 解决什么（负责人 / QA 实测的失败现场）───────────────────────────────
 *   在**步行去上车站 / 站台候车**（`phase === "boarding"`）时点「刷新巴士数据」，
 *   网络里只有 `/api/nav/detail-body` + `/api/route-shapes`，**没有任何报站请求**
 *   ⇒ 屏上「还有 3 站 · 约 10 分」24 次采样（8.4s）恒定不变，刷新等于没刷。
 *   根因：唯一的实时通道 `useNavRemaining`（`/api/nav/remaining`）在 `boarding`
 *   **被刻意排除**（服务端算法假设用户已上车，会把当前段候车整段漏掉 —— 见
 *   `useNavRemaining.ts` 的 `enabled` 注释，那是**正确**的排除，不要改）。
 *
 * ── 所以这里另开一条**独立**通道（不要合并进 useNavRemaining）─────────────
 *   本 hook 只回答一个问题：**我要坐的那班车，现在还有几站 / 约几分钟到本站**。
 *   它复用站点信息卡已经在用的 `/api/station/eta`（见下），不新开 API。
 *
 * ── 接口与字段（全部复用，不自造）──────────────────────────────────────
 *   `GET /api/station/eta?code=<主码或站台码>`（`src/app/api/station/eta/route.ts`）
 *   · 入参 `code`：只取 `mainCodeOf(code)`（`:397`）⇒ 传站台码 `M9/2` 与主码 `M9` 等价；
 *   · 返回 `items[]`（`StationEtaItem`，`:65-112`）：**该主码下全部（线路 × 方向 × 站台）**
 *     —— 与 `useLazyEta.ts#pickItem` 的注释同一个坑：只按 `route` 匹配会取到**隔壁站台**的车；
 *   · 本 hook 取用的字段：`route` / `platform` / `stopsAway`（`:79`）/ `etaMin`（`:81`）/ `ok`（`:83`）；
 *   · `dir`/`dirLabel` 不足以定方向（`dirLabel` 只有终点站名，客户端没有站序索引），
 *     所以**方向用「站台码」来定**：上车站台码来自 `strips[0].stops[0].code`
 *     （`lib/nav/strips.ts:65-68` 的 `seg.segs[0][0]`，即**本段实际方向**的那个站台）。
 *     两方向站台码不同（`M9/2` vs `M9/4`）⇒ 精确命中即方向唯一。
 *   · **定不了方向就不猜**：站台码缺失且同线多方向命中 ⇒ 返回 `null`（宁可回落规划快照，
 *     也不能拿反向车的「还有 3 站」骗人 —— 这是本项目最典型的静默错值）。
 *
 * ── 三条硬纪律（与既有实时通道一致）────────────────────────────────────
 *   ① **不轮询**：只由 `refresh()` 触发（点刷新 / R4 的 40m 自动触发都在调用方，见 `NavShell`）。
 *      本文件**没有** `setInterval`、没有 `useEffect` 自发请求 —— 加进去就等于新增一条
 *      12~20s 的 DSAT 打点通道，与「DSAT_QPS 冻结」的风控口径冲突；
 *   ② `cache: "no-store"`（服务端自带 ~20s 进程内微缓存，见 `route.ts:63`，客户端不得再叠一层）；
 *   ③ **并发 ≤ 3**：本 hook 一次只发 **1** 条（单站查询），且新请求会 abort 在途请求
 *      ⇒ 天然满足；**轻轨零请求**（`kind !== "bus"` 直接返回 `null`，轻轨无实时车源）。
 *
 * ── 失败 / 无数据的口径（不要"兜底成 0"）────────────────────────────────
 *   网络异常、非 2xx、`ok:false`、该方向无在途车 ⇒ `live = null` + `lastFail` 留痕
 *   ⇒ 调用方回落 `card.rides[0].liveText`（规划快照）。**绝不**写「还有 0 站」。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { RecommendCard } from "@/lib/recommend/types";

/** 实时到站值（成功取数才有） */
export interface BoardingEtaLive {
  /** 还有几站（0 = 车已在本站站台） */
  stopsAway: number;
  /** 约几分钟（服务端已取整；恒 ≥ 0） */
  etaMin: number | null;
  /**
   * 展示文案：`还有 3 站 · 约 6 分`（与 `model.ts:557` 的 `liveText` 同一形状，
   * 单位用「分」以对齐导航信息行 —— 见 `NavDetailBody` 的 `minuteUnitOf`）。
   */
  text: string;
  /** 成功取数次数（观测钩子 `data-eta-seq` / `data-recompute-seq` 的真源） */
  seq: number;
  /** 命中的线路码（= `card.rides[0].route`） */
  route: string;
  /** 命中的站台码（`M9/2` 这类；用于排障「是不是隔壁站台」） */
  platform: string;
  /** 服务端响应生成时刻（ms）—— 仅排障用，不参与任何显示 */
  serverNowMs: number;
}

export interface UseBoardingEta {
  /** `null` = 没有可用实时值（未请求 / 失败 / 无在途车）⇒ 调用方回落规划快照 */
  live: BoardingEtaLive | null;
  /** 请求在飞（调用方的「重算」要用它避让：在飞时不要拿旧值算一遍） */
  fetching: boolean;
  /** 最近一次失败的形态（`"<status>:<reason>"`；成功一次即清空） */
  lastFail: string | null;
  /** 手动触发一次（用户点刷新 / R4 位移触发；**唯一**的请求入口） */
  refresh: () => void;
}

export interface UseBoardingEtaOpts {
  card: RecommendCard | null;
  /** 详情 pane 打开（关闭即不取数、并清空结果） */
  open: boolean;
  /**
   * **未上车**才为 `true`（`boarding` / `off`）。
   * ⚠️ 上车后必须转 `false`：那时「到本段下车站还有几站」由 `useNavRemaining` +
   *    `NavDetailBody` 的 `post` 行负责，两套同时开着必然互相盖。
   */
  enabled: boolean;
  /**
   * 上车站台码（`strips[0].stops[0].code`，如 `M9/2`）。
   * `null` ⇒ 回落 `card.rides[0].board` 的主码（方向只能靠「唯一命中」判定）。
   */
  boardPlatform: string | null;
}

/** 响应里本 hook 消费的子集（形状对齐 `src/app/api/station/eta/route.ts:65`） */
interface StationEtaItemLite {
  route?: string;
  platform?: string;
  stopsAway?: number | null;
  etaMin?: number | null;
  ok?: boolean;
  kind?: string;
}

interface StationEtaRespLite {
  serverNowMs?: number;
  items?: StationEtaItemLite[];
}

function statusReasonOf(status: number): string {
  if (status === 403) return "forbidden";
  if (status === 400) return "bad_request";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_error";
  return `http_${status}`;
}

/**
 * 从 `items[]` 里挑出**本线路 × 本方向（本上车站台）**的那一条。
 *
 * 三条规则（顺序即优先级，不要重排）：
 *   ① 站台码精确命中 ⇒ `ROUTE × PLATFORM` 双条件唯一确定方向（首选，见 `useLazyEta.ts#pickItem`）；
 *   ② 无站台码 ⇒ 按主码筛；**只剩一条**才用（多方向 ⇒ 定不了方向 ⇒ `null`，不猜）；
 *   ③ 命中多条（数据异常：同一站台同线重复）⇒ `null`。
 */
function pickBusItem(
  items: StationEtaItemLite[],
  route: string,
  platformHint: string | null,
  main: string,
): StationEtaItemLite | null {
  const ofRoute = items.filter((i) => i.route === route && i.kind !== "lrt");
  if (!ofRoute.length) return null;
  if (platformHint) {
    const exact = ofRoute.filter((i) => i.platform === platformHint);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null; // ③ 同站台多条 ⇒ 不猜
  }
  const byMain = ofRoute.filter((i) => mainCodeOf(String(i.platform ?? "")) === main);
  return byMain.length === 1 ? byMain[0] : null; // ② 唯一命中才用
}

export function useBoardingEta(opts: UseBoardingEtaOpts): UseBoardingEta {
  const { card, open, enabled, boardPlatform } = opts;

  const [live, setLive] = useState<BoardingEtaLive | null>(null);
  const [fetching, setFetching] = useState(false);
  const [lastFail, setLastFail] = useState<string | null>(null);

  /** 成功取数计数（渲染必须纯 ⇒ 用 ref 累加，再随结果一起进 state） */
  const seqRef = useRef(0);
  /** 请求代际：换卡 / 关面板 / 上车 ⇒ 作废旧响应 */
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const first = card?.rides[0] ?? null;
  /** 轻轨零请求：`null` = 本次不取数（含「不是巴士」这条） */
  const canFetch = open && enabled && !!card && !!first && first.kind === "bus";
  const route = first?.route ?? "";
  const boardMain = first?.board ? mainCodeOf(first.board) : "";
  const code = boardPlatform ?? boardMain;
  const platformHint = boardPlatform;

  /** 最新入参镜像（供**稳定**的 `refresh` 读取，避免回调身份每次变） */
  const inputRef = useRef({ canFetch, code, route, boardMain, platformHint });
  inputRef.current = { canFetch, code, route, boardMain, platformHint };

  const fetchOnce = useCallback(async (): Promise<void> => {
    const cur = inputRef.current;
    if (!cur.canFetch || !cur.code || !cur.route) return;

    const gen = ++genRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setFetching(true);

    try {
      const r = await fetch(`/api/station/eta?code=${encodeURIComponent(cur.code)}`, {
        cache: "no-store",
        signal: ac.signal,
      });
      if (gen !== genRef.current) return;
      if (!r.ok) {
        setLastFail(`${r.status}:${statusReasonOf(r.status)}`);
        setLive(null); // 失败 ⇒ 没有实时值（调用方回落快照），**保留旧值**才会撒谎
        return;
      }
      const j = (await r.json()) as StationEtaRespLite;
      if (gen !== genRef.current) return;
      const hit = pickBusItem(j?.items ?? [], cur.route, cur.platformHint, cur.boardMain);
      if (!hit) {
        setLastFail("200:no_item");
        setLive(null);
        return;
      }
      if (hit.ok === false) {
        setLastFail("200:line_not_ok");
        setLive(null);
        return;
      }
      const stopsAway = Number(hit.stopsAway);
      if (!Number.isFinite(stopsAway)) {
        // 该方向暂无在途车（`stopsAway === null`）—— 不是"还有 0 站"，是**没有车**
        setLastFail("200:no_bus");
        setLive(null);
        return;
      }
      const etaMinRaw = Number(hit.etaMin);
      const etaMin = Number.isFinite(etaMinRaw) ? Math.max(0, Math.round(etaMinRaw)) : null;
      const n = Math.max(0, Math.round(stopsAway));
      const text = etaMin == null ? `还有 ${n} 站` : `还有 ${n} 站 · 约 ${Math.max(1, etaMin)} 分`;

      seqRef.current += 1;
      setLive({
        stopsAway: n,
        etaMin: etaMin == null ? null : Math.max(1, etaMin),
        text,
        seq: seqRef.current,
        route: cur.route,
        platform: String(hit.platform ?? cur.code),
        serverNowMs: Number(j?.serverNowMs) || 0,
      });
      setLastFail(null);
    } catch {
      /** 主动 abort（换代）不算失败 —— 否则每次换卡都会闪一个假失败 */
      if (!ac.signal.aborted && gen === genRef.current) {
        setLastFail("0:net");
        setLive(null);
      }
    } finally {
      if (gen === genRef.current) setFetching(false);
    }
  }, []);

  /** 清场：关面板 / 上车 / 换卡 ⇒ 作废在途请求并清空结果（防「上一张卡的报站」） */
  useEffect(() => {
    if (canFetch) return;
    genRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setLive(null);
    setFetching(false);
    setLastFail(null);
  }, [canFetch, card]);

  return { live, fetching, lastFail, refresh: fetchOnce };
}
