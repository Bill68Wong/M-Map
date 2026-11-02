"use client";

/**
 * 详情页折叠栏 · 「上车站其他线路」（src/components/nav/StationReachFold.tsx，v2.14）
 *
 * ── 结构（线路为父、方案为子；2026-09-25 二轮修订 · 07 §4.6）────────────
 *   父行 = 首程线路标签（`plan.route`，单独一行、`--surface-2` 微底）；
 *   子行 = 该线路的可切换方案（`[plan.card, ...(plan.siblings ?? [])]`，后端已按 `totalMin` 升序）
 *          ，左侧树形连线缩进；子行 = 线路标签串 · 总用时 · 快慢差 · 「切换路线」。
 *   排序：**有方案组置顶**（组间按组内最快 `totalMin` 升序）；无方案线路在分隔线下按数字-字母序一行一条。
 *
 * 数据：`POST /api/nav/switch-plans`（懒加载：展开时才查；失败静默降级为纯列表）。
 * ⚠️ 站名/线路名用**繁体**，界面文案用**简体**。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import RouteStack from "@/components/RouteStack";
import Icon from "@/components/ui/Icon";
import { sortRouteOptions } from "@/lib/route-label";
import { fmtDelta } from "@/lib/nav/track";
import type { RecommendCard } from "@/lib/recommend/types";

export interface ReachFoldItem {
  route: string;
  /** 实时报站文案（空串 = **没有数据或还没查** —— 必须结合 `foldState` 才能说结论） */
  live: string;
}

/** 折叠栏查询状态（与 `useDetailBody.FoldState` 同构；此处单独声明避免展示层依赖数据层实现） */
export type ReachFoldState = "idle" | "loading" | "loaded" | "failed";

/** `POST /api/nav/switch-plans` 的 `plans[]` 子集（客户端消费） */
interface SwitchPlanLite {
  route: string;
  chainRoutes: string[];
  totalMin: number;
  deltaMin: number;
  card: RecommendCard;
  /** ★ 新增可选：组内其余方案（top-2~3，`totalMin` 升序） */
  siblings?: RecommendCard[];
}

export default function StationReachFold({
  stationLabel,
  items,
  colors,
  switchCtx = null,
  onOpenCard,
  /**
   * ★ v3.7.0（C5）：折叠栏实时报站改为**展开时才查**（服务端首包不再查 DSAT，省 ~3s）。
   *   `foldState` 是「能不能说没有班次」的唯一判据 —— 缺省 `idle`（未查询）；
   *   若调用方漏传，宁可留空也不显示「暂无到站信息」（把"没查"说成"没有"是更糟的错误）。
   */
  foldState = "idle",
  onLoadFold,
}: {
  stationLabel: string;
  items: ReachFoldItem[];
  colors: Record<string, string>;
  switchCtx?: { card: RecommendCard; dest: { lng: number; lat: number; name?: string } } | null;
  onOpenCard?: (card: RecommendCard) => void;
  foldState?: ReachFoldState;
  onLoadFold?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [plans, setPlans] = useState<SwitchPlanLite[]>([]);
  const [planPhase, setPlanPhase] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const keyRef = useRef("");
  const seqRef = useRef(0);
  /** 回调镜像：`onLoadFold` 每次渲染可能换引用，但不该因此重复触发取数 */
  const onLoadFoldRef = useRef(onLoadFold);
  onLoadFoldRef.current = onLoadFold;

  /**
   * ★ v3.7.0（C5）：**展开才请求**（按需的全部意义就在这）。
   *
   * 幂等放在数据层（`useDetailBody.loadFold` 内有"同卡只问一次"的守卫），
   * 这里**不重复实现**：折叠→再展开会再调一次，但已被守卫吃掉，不会产生第二个请求。
   * 这样换卡后（本组件的 `open` 若还开着）也不会被本地旧标记锁死。
   * ⚠️ 不要挪到渲染期或折叠按钮 onClick 之外 —— 展开前预取就失去按需意义。
   */
  useEffect(() => {
    if (!open) return;
    onLoadFoldRef.current?.();
  }, [open]);

  useEffect(() => {
    if (!open || !switchCtx) return;
    const first = switchCtx.card.rides[0];
    const key = `${first?.board ?? ""}|${first?.route ?? ""}|${switchCtx.card.totalMin}|${switchCtx.dest.lng.toFixed(5)},${switchCtx.dest.lat.toFixed(5)}`;
    if (keyRef.current === key) return;
    keyRef.current = key;
    const id = ++seqRef.current;
    setPlanPhase("loading");
    setPlans([]);
    fetch("/api/nav/switch-plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ card: switchCtx.card, dest: switchCtx.dest }),
    })
      .then((r) => r.json())
      .then((j: { ok?: boolean; plans?: SwitchPlanLite[] }) => {
        if (id !== seqRef.current) return;
        if (j?.ok) {
          setPlans(Array.isArray(j.plans) ? j.plans : []);
          setPlanPhase("ready");
        } else {
          setPlanPhase("failed");
        }
      })
      .catch(() => {
        if (id === seqRef.current) setPlanPhase("failed");
      });
  }, [open, switchCtx]);

  const baseTotalMin = switchCtx?.card.totalMin ?? 0;

  /** 有方案组：组间按「组内最快 totalMin」升序 */
  const sortedPlans = useMemo(() => {
    const fast = (p: SwitchPlanLite) => {
      const all = [p.card, ...(p.siblings ?? [])];
      return Math.min(...all.map((c) => c.totalMin));
    };
    return [...plans].sort((a, b) => fast(a) - fast(b) || a.route.localeCompare(b.route));
  }, [plans]);
  const planRoutes = useMemo(() => new Set(sortedPlans.map((p) => p.route)), [sortedPlans]);

  /** 其余线路：一行一条，按数字-字母顺序 */
  const restItems = useMemo(() => {
    const byRoute = new Map(items.map((it) => [it.route, it]));
    const order = sortRouteOptions(items.map((it) => it.route).filter((r) => !planRoutes.has(r)));
    return order.map((r) => byRoute.get(r)!).filter(Boolean);
  }, [items, planRoutes]);

  /**
   * ★ v3.7.0（C5）：**三态渲染**（原来 `it.live || "暂无到站信息"` 会把"没查"说成"没有班次"）。
   *
   *   · 有文案            ⇒ 照常显示（时间提示一律保留）；
   *   · `loading`         ⇒ 「正在获取…」（有反馈，不下结论）；
   *   · `loaded` 且为空   ⇒ 这时候才**允许**说「暂无到站信息」（确实查过、确实没有）；
   *   · `idle` / `failed` ⇒ **留空**（没查过 / 查失败 ⇒ 我们不知道，不编结论）。
   *
   * ⚠️ 判据是「查没查」(`foldState`)，不是「数据是否为空」—— 别退化回 `||`。
   */
  const liveTextOf = (live: string): string => {
    if (live) return live;
    if (foldState === "loading") return "正在获取…";
    if (foldState === "loaded") return "暂无到站信息";
    return "";
  };

  if (!items.length) return null;

  return (
    <div className="rc-fold">
      <button className="rc-fold__head" type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        上车站其他线路 · <b>{items.length}</b> 条
        <span className="rc-strip__caret">
          <Icon name={open ? "caretUp" : "caretDown"} size={16} />
        </span>
      </button>
      {open && (
        <div className="rc-fold__body">
          <span className="t-label t-muted" style={{ display: "block", marginBottom: 6 }}>
            {stationLabel}
          </span>

          {switchCtx && planPhase === "loading" && (
            <p className="t-label t-muted" style={{ margin: "2px 0 8px" }}>
              正在看看还有哪些走法…
            </p>
          )}

          {/* 有方案组（置顶）：线路为父 · 方案为子 */}
          {sortedPlans.length > 0 && (
            <>
              <span className="nav-fold-group-label">可切换路线</span>
              {sortedPlans.map((p) => {
                const children = [p.card, ...(p.siblings ?? [])];
                return (
                  <div className="nav-plan-group" key={p.route}>
                    <div className="nav-fold-parent">
                      <RouteStack codes={[p.route]} colorOf={(c) => colors[c] ?? null} size="sm" />
                    </div>
                    {children.map((c, ci) => {
                      const delta = Math.round(c.totalMin - baseTotalMin);
                      return (
                        <div className="nav-plan-sub" key={`${p.route}-${ci}`}>
                          <span className="nav-plan-sub__main">
                            <RouteStack
                              segments={c.rides.map((r) => ({
                                codes: [r.route, ...(r.parallelRoutes ?? [])],
                              }))}
                              colorOf={(code) => colors[code] ?? null}
                              size="sm"
                            />
                            <span className="nav-plan-sub__time">
                              <b>{Math.round(c.totalMin)}</b> 分
                            </span>
                            {delta !== 0 && (
                              <span
                                className={`nav-plan-sub__delta${delta < 0 ? " is-fast" : " is-slow"}`}
                              >
                                {delta < 0 ? "↑ " : "↓ "}
                                {fmtDelta(delta)}
                              </span>
                            )}
                          </span>
                          {onOpenCard && (
                            <button
                              type="button"
                              className="nav-plan-sub__go"
                              onClick={() => onOpenCard(c)}
                              aria-label={`切换到 ${c.rides.map((r) => r.route).join(" 换乘 ")} 方案`}
                            >
                              切换
                              <Icon name="forward" size={16} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </>
          )}

          {/* 其余线路（纯列表：线路标签 + 实时报站） */}
          {restItems.length > 0 && (
            <>
              <span className="nav-fold-group-label is-sep">其余线路</span>
              {restItems.map((it) => (
                <div className="nav-fold-lrow" key={it.route}>
                  <RouteStack codes={[it.route]} colorOf={(c) => colors[c] ?? null} size="sm" />
                  {/* ★ v3.7.0（C5）：三态由 `liveTextOf` 统一判定（未查询/失败 ⇒ 留空，不撒谎） */}
                  <span className="nav-fold-lrow__live">{liveTextOf(it.live)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
