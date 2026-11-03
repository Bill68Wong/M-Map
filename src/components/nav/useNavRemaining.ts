"use client";

/**
 * 导航剩余行程 · 服务端重算通道（src/components/nav/useNavRemaining.ts，★ 2026-11-03 新增）
 *
 * ── 解决什么 ──────────────────────────────────────────────────────────
 *   `card.totalMin` / `card.arriveAt` 是**规划时刻快照**（`model.ts:817/878/879`），
 *   纵条各段分钟同源（`strips.ts:134` `rideMin: ride.minutes`）⇒ 顶部与纵条**一起冻住**。
 *   本 hook 调 `POST /api/nav/remaining` 拿「重算后的剩余时间 + 整份纵条」，
 *   使刷新（及车辆帧推进）时**整屏数字一起动**。
 *
 * ── 三条硬纪律（违反任一条都会退化成旧问题）──────────────────────────
 *   ① **不做独立 5s 轮询** —— 本 hook 只在「车辆帧到达」时随取一次
 *      （`frameTs` = `RideTrackView.lastVehicleTs`，每次成功车辆帧变一次，
 *      `POLL_MS = 12_000`）⇒ 天然搭在既有节拍上，**零新增轮询**。
 *      服务端该端点走本地静态索引（`lookupHop` / `headwayAt` / `buildStrips`，
 *      实测亚毫秒、**不打 DSAT**）⇒ 这个频率成本可忽略。
 *   ② **绝不把 `phase` 置 `loading`** —— 这是独立通道，只 merge 数据。
 *      若借用 `detail.reload()`，`useRouteOverview.ts:84-89` 会 `setLegs([])`+`setBox(null)`
 *      ⇒ 地图彩段清空重画、取景被放弃，导航中视野会跳。
 *   ③ **只换 `strips`，绝不碰 `legs`** —— 调用方拿到 `liveStrips` 后整份替换纵条即可；
 *      `body.legs` 是地图几何，与时间无关，碰了就是 ② 的坑。
 *
 * ── 为什么传 `arriveAt` 而不是只传相对分钟 ──────────────────────────────
 *   相对值一过网络往返 / 服务端缓存就偏大（`/api/station/eta/route.ts:120-125` 已踩过并
 *   给了正解）。本 hook 收 `serverNowMs` 后算 `offsetMs = serverNowMs − 接收时刻`，
 *   渲染侧用 `arriveAt` 绝对锚现算 ⇒ **免疫往返延迟与缓存陈旧**，也不「每次跳一格」。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RecommendCard, SegmentStrip } from "@/lib/recommend/types";
import type { RidePhase } from "./useRideTracking";

/** 服务端重算结果的**客户端视图**（供 `NavDetailBody` / `RouteSheet` 消费） */
export interface NavRemainLive {
  /**
   * 服务端算出的剩余分钟（相对基准）—— **总时长显示的唯一来源**。
   * ⚠️ 不要用 `arriveAt − now` 反算总时长：那会绕过服务端时钟锚（team-lead 冻结契约）。
   */
  remainingMin: number;
  /** 服务端**绝对**到达时刻（ms）—— **到达时刻显示的唯一来源**（走 `macauClock`） */
  arriveAt: number;
  /** 服务端响应生成时刻（服务端 `Date.now()`，ms）—— 时间轴对齐用 */
  serverNowMs: number;
  /**
   * 缓存陈旧秒 = `(serverNowMs − recomputedAt) / 1000`。
   * 服务端有进程内微缓存（`route.ts:150-161`）：命中时 `recomputedAt` 早于 `serverNowMs`
   * ⇒ 这份 `remainingMin` 已过时这么多，**不扣就会偏大**。
   */
  staleSec: number;
  /** 客户端相对服务端的时钟偏移（ms）= `serverNowMs − 接收时刻` ⇒ 把本地时间映射到服务端时间轴 */
  clockOffsetMs: number;
  /** 每次成功重算自增 ⇒ 观测钩子 `data-recompute-seq`（区分「真重算」与「重渲染同一帧」） */
  seq: number;
}

export interface UseNavRemaining {
  /** 服务端重算值；`null` = 还没有结果（或当前阶段无需重算）⇒ 上层走客户端兜底 */
  liveRemain: NavRemainLive | null;
  /** 服务端重算后的整份纵条（整份替换静态 `strips`；`null` = 无） */
  liveStrips: SegmentStrip[] | null;
  /**
   * ★ 2026-11-03（批 1）：**最近一次失败的形态**（`"<status>:<reason>"`，如 `"403:forbidden"`）。
   *   成功一次即清空 ⇒ 观测钩子 `data-remain-fail` **成功时不输出**。
   *
   * ── 为什么必须有它（负责人主诉的同一类失败模式）───────────────────────
   *   负责人原话：「点了刷新按钮有反应，但不知道刷新了什么」。
   *   若 403/5xx 被静默吞掉，用户看到的是「**点了完全没反应**」——**同款失败模式的更严重版本**。
   *   ⇒ 修了主诉却留这个洞，等于没修完。
   *
   * ⚠️ 静默点**不在 `catch`**：`fetch` 对 4xx/5xx **不抛**（只有网络层错误才抛），
   *   所以 403 走的是 `if (!j?.ok) return;` 那条路，连 `catch` 都不进。
   *   旧实现里这条路**零痕迹**（无 console / 无 `data-*` / 无 UI）
   *   ⇒ 故障表现与「本来就不需要重算」完全无法区分，是最难排查的一类。
   *
   *   现在分三档记录：`4xx|5xx`（HTTP 非 2xx）、`0:parse`（响应不是合法 JSON）、
   *   `0:net`（网络层异常）。`status` 取 0 表示「没有 HTTP 状态码」。
   */
  lastFail: string | null;
  /** 手动触发一次（用户点刷新时随取 —— 与车辆帧随取同一条通道） */
  refresh: () => void;
}

export interface UseNavRemainingOpts {
  card: RecommendCard | null;
  /** 只在详情 pane 打开时取数 */
  open: boolean;
  /**
   * 乘车阶段。**只有 `riding` 会取数**（`boarding` 排除，原因见下方 `enabled` 注释）：
   *   `off`（未开始）/ `boarding`（未上车）/ `done`（已到达）都不请求。
   */
  phase: RidePhase;
  /** 当前腿下标（`RideTrackView.legIndex`） */
  legIndex: number;
  /** 当前腿位置感知剩余秒（`RideTrackView.segProgress?.segRemainSec`）；`null` = 无位置模型 */
  segRemainSec: number | null;
  /** 下一站下标（`RideTrackView.prog?.nextIdx`）；`null` = 无进度 */
  nextIdx: number | null;
  /**
   * 车辆帧时刻（`RideTrackView.lastVehicleTs`）。
   * 每成功一帧车辆数据变一次 ⇒ 本 hook 借此**搭在既有 12s 节拍上**，不自建定时器。
   */
  frameTs: number;
}

/** 请求体（与 `src/app/api/nav/remaining/route.ts` 的解析严格对齐） */
interface RemainReq {
  card: RecommendCard;
  legIndex: number;
  segRemainSec: number | null;
  nextIdx: number | null;
  clientNowMs: number;
}

/** 响应体（客户端消费子集） */
interface RemainRes {
  ok?: boolean;
  error?: string;
  remainingMin?: number;
  arriveAt?: number;
  recomputedAt?: number;
  serverNowMs?: number;
  strips?: SegmentStrip[];
}

/**
 * ★ 2026-11-03（批 1）：HTTP 状态码 → 短原因词（观测钩子 `data-remain-fail` 的可读后缀）。
 * 只覆盖本端点会出现的档位；其余落 `http_<code>`，保留原始数字以免丢失信息。
 */
function statusReasonOf(status: number): string {
  if (status === 403) return "forbidden";
  if (status === 400) return "bad_request";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_error";
  return `http_${status}`;
}

export function useNavRemaining(opts: UseNavRemainingOpts): UseNavRemaining {
  const { card, open, phase, legIndex, segRemainSec, nextIdx, frameTs } = opts;

  const [liveRemain, setLiveRemain] = useState<NavRemainLive | null>(null);
  const [liveStrips, setLiveStrips] = useState<SegmentStrip[] | null>(null);
  /** ★ 批 1：最近一次失败（`"<status>:<reason>"`；`null` = 最近一次成功或还没请求过） */
  const [lastFail, setLastFail] = useState<string | null>(null);

  /** 成功重算计数 —— `seq` 的真相（渲染必须纯 ⇒ 用 ref 累加，再随结果一起进 state） */
  const seqRef = useRef(0);
  /** 请求代际：换卡 / 换腿 / 关闭时作废旧响应（防「旧卡结果盖住新卡」） */
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * ★ 2026-11-03（需求 1）：**只在 `riding` 取数**，`boarding` 明确排除。
   *
   * ── 为什么 boarding 必须排除（这是真错，不是边界美学）─────────────────
   *   服务端算法（`src/lib/nav/remaining.ts:41`）明示：**「本模块假设用户已在
   *   `legIndex` 段的车上 ⇒ `rides[legIndex].waitMin` 视为已发生、不计入剩余」**
   *   —— 证据：下游循环从 `legIndex + 1` 起（`:236`），当前腿的 `waitMin` 永不累加。
   *   ⇒ 在 `boarding`（人还在站台等车）调用，会把**当前段候车（典型 3~9 分钟）整段漏掉**，
   *     显示比实际**偏短** —— 用户看着「还有 5 分到」，实际还得先等 8 分钟车。
   *
   *   而 boarding 期不重算是**安全的**：此时行程一分钟都还没消耗，
   *   `card.totalMin` / `card.arriveAt`（规划快照）本来就等于真实剩余；
   *   且「距离下车站还有几分钟」（④）走的是 `segProgress` + `etaTick` 的本地递减，
   *   与该端点无关 ⇒ 不受影响。
   *
   * ── 为什么不是「让服务端把 waitMin 也算进去」（方案 B）────────────────
   *   那要扩契约加 `boarded?: boolean`，且服务端需同时支持「已上车 / 未上车」两套时间轴；
   *   而 boarding 期本就有准确值可用 ⇒ 为一个不需要的场景扩契约不划算。
   *   （后端也已倾向方案 A，见其 2026-11-03 报告。）
   */
  const enabled = open && !!card && phase === "riding";

  /**
   * 最新入参镜像：供**稳定**的 `fetchOnce` 读取。
   * 为什么不把入参放进 `fetchOnce` 的依赖 —— `segRemainSec` 每帧都在变，
   * 会让回调身份每帧重建 ⇒ effect 反复触发 ⇒ 变成"自己造了一个高频轮询"。
   */
  const inputRef = useRef({ card, enabled, legIndex, segRemainSec, nextIdx });
  inputRef.current = { card, enabled, legIndex, segRemainSec, nextIdx };

  const fetchOnce = useCallback(async (): Promise<void> => {
    const cur = inputRef.current;
    if (!cur.enabled || !cur.card) return;

    const gen = ++genRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const payload: RemainReq = {
      card: cur.card,
      legIndex: cur.legIndex,
      segRemainSec: cur.segRemainSec,
      nextIdx: cur.nextIdx,
      clientNowMs: Date.now(),
    };

    try {
      const r = await fetch("/api/nav/remaining", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        signal: ac.signal,
        body: JSON.stringify(payload),
      });
      if (gen !== genRef.current) return; // 已被更新的请求/语境取代
      /**
       * ★ 2026-11-03（批 1）：**HTTP 层失败必须留痕**。
       *   `fetch` 对 4xx/5xx **不抛**（只有网络层错误才进 catch）⇒ 这是 403 的唯一入口。
       *   之前这里直接 `return`，导致 403 全程零痕迹、与「不需要重算」无法区分。
       */
      if (!r.ok) {
        setLastFail(`${r.status}:${statusReasonOf(r.status)}`);
        return;
      }
      const j = (await r.json()) as RemainRes;
      if (gen !== genRef.current) return;
      if (!j?.ok) {
        // 200 但业务失败（服务端 `{ok:false,error}`）—— 同样留痕，reason 取服务端枚举
        setLastFail(`200:${typeof j?.error === "string" ? j.error : "not_ok"}`);
        return;
      }

      const arriveAt = Number(j.arriveAt);
      const serverNowMs = Number(j.serverNowMs);
      const remainingMin = Number(j.remainingMin);
      const recomputedAt = Number(j.recomputedAt);
      // 缺任一绝对锚 / 相对基准 ⇒ 视为失败（**不**用半套数据兜底：那会把「缓存陈旧」再引回来）
      if (!Number.isFinite(arriveAt) || !Number.isFinite(serverNowMs) || !Number.isFinite(remainingMin)) {
        setLastFail("200:bad_payload");
        return;
      }

      /**
       * 时钟偏移：`serverNowMs` 是**响应生成时刻**，收到时已过 ~RTT/2。
       * 沿用项目既有口径（`/api/station/eta` 的 `serverNowMs`）把它当作"接收时刻的服务端时间"，
       * 误差为单向 RTT/2（澳门 11ms 量级，可忽略），好处是**不需要额外握手**。
       */
      const clockOffsetMs = serverNowMs - Date.now();
      /**
       * 缓存陈旧：命中微缓存时 `recomputedAt` 早于 `serverNowMs` ⇒ `remainingMin` 已过时。
       * 缺失/非法（老响应）⇒ 0（视为无陈旧，与「无缓存」同）。
       */
      const staleSec =
        Number.isFinite(recomputedAt) && recomputedAt > 0
          ? Math.max(0, (serverNowMs - recomputedAt) / 1000)
          : 0;

      seqRef.current += 1;
      setLiveRemain({ remainingMin, arriveAt, serverNowMs, staleSec, clockOffsetMs, seq: seqRef.current });
      // 整份纵条：服务端已用「修补过时间的 card」调过 `buildStrips` ⇒ 与顶部同源
      setLiveStrips(Array.isArray(j.strips) && j.strips.length ? j.strips : null);
      setLastFail(null); // ★ 成功一次 ⇒ 清空失败态（观测钩子随之消失）
    } catch {
      /**
       * 网络层异常（断网 / DNS / 主动 abort）。
       * ⚠️ `AbortError` 是**我们自己换代取消**造成的，不是真失败 ⇒ **不记**（否则每次换卡都会闪一个假失败）。
       * 其余（真断网）记 `0:net` —— 保留上一帧好值，但让 QA / 运维看得到。
       */
      const aborted = ac.signal.aborted;
      if (!aborted && gen === genRef.current) setLastFail("0:net");
      /* 静默保留上一帧好值（与车辆帧「失败不清空」一致，见 observe-hooks 头注） */
    }
  }, []);

  /**
   * ★ 触发点①：**车辆帧到达时随取**（搭 12s 节拍，零新增轮询）。
   * 依赖里刻意只放 `frameTs` / `legIndex` / `enabled` / `card`：
   *   · `frameTs` 变 = 拿到新帧 ⇒ 该重算了；
   *   · `legIndex` 变 = 换腿 ⇒ 剩余结构变了；
   *   · `card` 变 = 换方案 ⇒ 必须重算（旧结果属于另一条路线）。
   */
  useEffect(() => {
    if (!enabled) return;
    void fetchOnce();
  }, [enabled, frameTs, legIndex, card, fetchOnce]);

  /**
   * 清场：关闭面板 / 离开 riding / 换卡 ⇒ 作废在途请求并清空结果。
   * 不清场会留下「上一张卡的剩余时间」——正是本项目反复出现的「两个真相」型缺陷。
   */
  useEffect(() => {
    if (enabled) return;
    genRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setLiveRemain(null);
    setLiveStrips(null);
    /**
     * ★ 批 1：失败态也要清。
     *   否则「上车时 403 一次」→ 下车 → 退出详情，`data-remain-fail="403:forbidden"`
     *   会**永久挂在 DOM 上**，QA 断言与线上排障都会被这个过期值误导。
     */
    setLastFail(null);
  }, [enabled, card]);

  return { liveRemain, liveStrips, lastFail, refresh: fetchOnce };
}
