"use client";

/**
 * 详情「弹窗体」数据 hook（src/components/nav/useDetailBody.ts，2026-09-23 新增）
 *
 * ── 为什么单独成 hook ──────────────────────────────────────────────────
 *   `POST /api/nav/detail-body` 有**两个消费方**：
 *     · `RouteSheet` 的详情 pane（主页「出发 → 推荐 → 详情」）；
 *     · 收藏页 `RouteDetailSheet` 薄壳（无地图上下文）。
 *   抽成 hook ⇒ 两处共用同一份取数/降级口径，防漂移。
 *
 * ── 契约 ──────────────────────────────────────────────────────────────
 *   入参：`card`（列表已算好的卡，含步行 / 换乘 / 到达时刻），`open`（仅 open 时拉取）。
 *   出参：`phase` / `body`（strips + 其他线路 + 折叠栏 + ★legs 几何锚点）/ `reload`。
 *   降级：接口失败 ⇒ `phase="failed"`（详情体显示「加载失败 + 重试」），**不阻塞地图/总览**。
 *
 * ⚠️ `card` 直传（不经过 planId 重算）⇒ 「点哪张显示哪张」，从根上消除「点 51 显示 56」。
 */
import { useEffect, useRef, useState } from "react";
import type { RecommendCard, SegmentStrip } from "@/lib/recommend/types";
import type { OverviewLegInput } from "@/lib/nav/route-overview";

/** `detail-body` 响应体（客户端消费子集） */
export interface DetailBody {
  strips: SegmentStrip[];
  otherRoutes: string[];
  /**
   * 线路码 → 「还有 N 站 · 约 X 分钟」。
   * ★ v3.7.0（C5）：**首包恒为空对象**（服务端缺省不查 DSAT）；展开折叠栏时调 `loadFold()`
   *   单独取一次后合并进来。空对象 = **未查询**，不等于「该站没有班次」
   *   ⇒ 渲染必须看 `foldState`，**不得**用 `live || "暂无到站信息"` 兜底。
   */
  foldLive: Record<string, string>;
  stationLabel: string | null;
  /** ★ 新增：逐段几何锚点（与 `card.rides` 一一对应、同序；GCJ-02） */
  legs: OverviewLegInput[];
}

/**
 * ★ v3.7.0（C5）：折叠栏「查没查」的四态 —— **判据是"是否已查询"，不是"数据是否为空"**。
 *
 *   · `idle`    从未查询（用户还没展开折叠栏）⇒ UI **不得**显示「暂无到站信息」
 *   · `loading` 正在查 ⇒ 可显示「正在获取…」
 *   · `loaded`  查完了 ⇒ 此时 `foldLive[route]` 缺失/空串才**允许**说「暂无到站信息」
 *   · `failed`  查失败 ⇒ 仍然**不知道**有没有班次 ⇒ 不显示任何结论（静默降级为纯列表）
 *
 * ⚠️ 这四种状态的存在意义就是防止「把没查说成没有班次」这类**沉默错误**
 *   （比空白更糟：用户会据此判断「这条线今天不跑了」）。别退化成 `live || "…"`。
 */
export type FoldState = "idle" | "loading" | "loaded" | "failed";

export interface UseDetailBody {
  phase: "loading" | "ready" | "failed";
  body: DetailBody | null;
  /** 失败重试：+1 触发重新拉取 */
  reload: () => void;
  /** ★ v3.7.0（C5）：按需取折叠栏实时报站（折叠栏展开时调一次；只合并 `foldLive`） */
  loadFold: () => void;
  /** ★ v3.7.0（C5）：折叠栏查询状态（渲染三/四态文案的唯一判据） */
  foldState: FoldState;
}

const EMPTY: DetailBody = { strips: [], otherRoutes: [], foldLive: {}, stationLabel: null, legs: [] };

export function useDetailBody(card: RecommendCard | null, open: boolean): UseDetailBody {
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [body, setBody] = useState<DetailBody | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [foldState, setFoldState] = useState<FoldState>("idle");
  const seqRef = useRef(0);
  const foldAskedRef = useRef(false);

  useEffect(() => {
    if (!open || !card) return;
    const id = ++seqRef.current;
    foldAskedRef.current = false; // 换卡 / 重试 ⇒ 折叠栏实时需重新按需获取
    setFoldState("idle"); // ★ 换卡 ⇒ 回到「未查询」，绝不把上一张卡的查询状态带过来
    setPhase("loading");
    fetch("/api/nav/detail-body", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      // ★ v3.7.0（C5）：`fold:false` ⇒ 服务端不查 DSAT（首包快 ~3s）；折叠栏由 `loadFold` 单独取
      body: JSON.stringify({ card, fold: false }),
    })
      .then((r) => r.json())
      .then((j: { ok?: boolean; error?: string } & Partial<DetailBody>) => {
        if (id !== seqRef.current) return;
        if (!j?.ok) throw new Error(j?.error ?? "detail_failed");
        setBody({
          strips: Array.isArray(j.strips) ? j.strips : [],
          otherRoutes: Array.isArray(j.otherRoutes) ? j.otherRoutes : [],
          foldLive: j.foldLive ?? {},
          stationLabel: j.stationLabel ?? null,
          legs: Array.isArray(j.legs) ? j.legs : [],
        });
        setPhase("ready");
      })
      .catch(() => {
        if (id !== seqRef.current) return;
        setBody(EMPTY);
        setPhase("failed");
      });
  }, [card, open, reloadTick]);

  return {
    phase,
    body,
    reload: () => setReloadTick((t) => t + 1),
    /**
     * ★ v3.7.0（C5）：折叠栏实时报站按需拉取（**只合并 `foldLive`**，不动 strips/legs）。
     * 幂等：`foldAskedRef` ⇒ 同一张卡只请求一次（含「正在飞」时的重复展开）。
     * 失败静默：状态置 `failed`（**不是** `loaded`）—— 折叠栏不显示任何"有没有班次"的结论。
     */
    loadFold: () => {
      if (foldAskedRef.current || !card) return;
      foldAskedRef.current = true;
      setFoldState("loading");
      fetch("/api/nav/detail-body", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ card, fold: true }),
      })
        .then((r) => r.json())
        .then((j: { ok?: boolean; foldLive?: Record<string, string> }) => {
          if (!j?.ok) {
            setFoldState("failed");
            return;
          }
          setBody((b) => (b ? { ...b, foldLive: j.foldLive ?? {} } : b));
          setFoldState("loaded");
        })
        .catch(() => {
          /* 实时不可用 ⇒ failed：保持空对象，折叠栏不显示报站、也不编造「暂无班次」 */
          setFoldState("failed");
        });
    },
    foldState,
  };
}
