"use client";

/**
 * 跨境交通页（`src/app/cross-border/page.tsx`，2026-11-07 · 需求 4）
 *
 * ── 需求原文 ────────────────────────────────────────────────────────────
 *   「跨境巴士分组内有通琴号卡片，点击跳转到首页-右边栏线路-通琴号，**操作不设返回**；
 *     客运港口含内港/外港/氹仔三张卡片，点击进新全屏页；机场含澳门国际机场一张卡片。」
 *
 * ── 三个分组，三种点击后果（这张页面唯一的复杂度）──────────────────────
 *   · 通琴號 ⇒ 回首页并直接展开右边栏通琴号板（`router.replace`，**不设返回**：
 *     它不是一个"子页"，是同一件事的另一个入口，进历史栈会制造假返回）；
 *   · 三码头 ⇒ `/cross-border/{PE|TP|PI}?after=day`（全屏班次页「当日所有」）；
 *   · 机场   ⇒ `/cross-border/airport?after=day`。
 *
 * ── 卡片右块的四条口径 ─────────────────────────────────────────────────
 *   ① 「下一班」用**接口 times**（`schedTime > serverNow` 且非终态的最小一条），
 *      不用浏览器时钟（两端时差会让"下一班"看起来少一班或多一班）；
 *   ② 取不到就 `--` 并降权，**不写「已收班」**（太吵，且"收班"是我们的推断不是上游状态）；
 *   ③ 副标题里的目的港来自 `PIER_ROUTE_HINT`（UI 说明性文字），
 *      **不是**表格里的数据值 —— 表格里的 `place` 必须原文直出；
 *   ④ 四个请求并行、只发一次（本页不轮询：政府接口不该被前端定时打）。
 */

import { useRouter } from "next/navigation";
import BottomNav from "@/components/BottomNav";
import Icon from "@/components/ui/Icon";
import { XbCard } from "@/components/cross-border/XbBits";
import { useXbList } from "@/components/cross-border/useXbList";
import type { XbTableItem } from "@/components/cross-border/XbTable";
import {
  AIRPORT_NAME,
  PIER_NAME,
  PIER_ROUTE_HINT,
  listUrl,
  macauParts,
  nextSailing,
} from "@/components/cross-border/xb-view";

/** 首页通琴号板的入口（设计稿 §7.5：`/?board=tqh&no=A1`，用 replace 不设返回） */
const TQH_HREF = "/?board=tqh&no=A1";

/** 一张卡片的派生数据（loading / error 都收敛成 `null`，卡片只负责显示） */
function cardInfo(
  state: ReturnType<typeof useXbList<XbTableItem>>["state"],
  hints: string,
): { sub: string; label: string; value: string | null } {
  if (state.status === "error") {
    /*
     * ★ 单卡失败**必须说出来**，且**不拖累整页**（四个 `useXbList` 各自独立状态）。
     *   为什么不能只留 `--`：用户会把"取不到"读成"今天没有下一班"——那是归因错误。
     *   为什么不做整页错误态：一张卡的上游挂了不代表另外三张也挂了，
     *   整页报错会让用户以为"跨境交通整个不可用"。
     */
    return { sub: `${hints} · 暂时取不到`, label: "下一班", value: null };
  }
  if (state.status === "loading") {
    /* 还没取到 ⇒ 副标题只给静态目的港，右块留 `--`（不占位、不编数字） */
    return { sub: hints, label: "下一班", value: null };
  }
  const now = macauParts(state.data.serverNow);
  const next = nextSailing(state.data.items, now?.minutes ?? null);
  return {
    sub: `${hints} · 今日 ${state.data.dayTotal} 班`,
    label: "下一班",
    value: next?.schedTime ?? null,
  };
}

/** 三个码头（顺序 = 设计稿 §01 的视觉顺序：內港 → 外港 → 氹仔） */
const PIERS = ["PI", "PE", "TP"] as const;

export default function CrossBorderPage() {
  const router = useRouter();

  /* 4 个请求：机场 + 三码头（都是「最近五班」的切片，只为拿 dayTotal 与下一班） */
  const air = useXbList<XbTableItem>(listUrl("airport", { dir: "dep", after: "now", limit: 5 }));
  const pi = useXbList<XbTableItem>(listUrl("ferry", { dir: "dep", after: "now", pier: "PI", limit: 5 }));
  const pe = useXbList<XbTableItem>(listUrl("ferry", { dir: "dep", after: "now", pier: "PE", limit: 5 }));
  const tp = useXbList<XbTableItem>(listUrl("ferry", { dir: "dep", after: "now", pier: "TP", limit: 5 }));
  const byPier = { PI: pi, PE: pe, TP: tp } as const;

  /*
   * 站码即路由段（`airport` / `PI` / `PE` / `TP`），不需要再带 kind 参数。
   * `?after=day`：从列表点进去要的是「当日所有」（需求 6），不是「最近五班」。
   * 不带时目标页会重定向到 `?after=day`（`[station]/page.tsx` 的兜底），
   * 但入口自己写清楚 ⇒ 少一次跳转、URL 与落地屏对得上。
   */
  const open = (station: string) => router.push(`/cross-border/${station}?after=day`);

  const airInfo = cardInfo(air.state, "离澳航班");

  return (
    <>
      <main className="xb-page">
        <div className="xb-hd">
          <h1 className="xb-hd__t">跨境交通</h1>
          {/* 更新时刻取机场响应的 serverNow（服务端时刻），不用浏览器时钟 */}
          <span className="xb-hd__m">
            {air.state.status === "ok" && macauParts(air.state.data.serverNow)
              ? `更新于 ${macauParts(air.state.data.serverNow)!.hm}`
              : "更新中"}
          </span>
        </div>

        {/* ── 跨境巴士 ── */}
        <section className="xb-grp">
          <h2 className="xb-grp__h">
            <Icon name="bus" size={16} />
            <span>跨境巴士</span>
            <span className="xb-grp__n">1</span>
          </h2>
          <div className="xb-grp__list">
            <XbCard
              icon="bus"
              title="通琴号"
              sub="往 澳门 / 横琴"
              endLabel={null}
              endChip="时刻表"
              onClick={() => router.replace(TQH_HREF)}
            />
          </div>
        </section>

        {/* ── 客运港口（三码头同形，靠地名标签区分）── */}
        <section className="xb-grp">
          <h2 className="xb-grp__h">
            <Icon name="ferryIcon" size={16} />
            <span>客运港口</span>
            <span className="xb-grp__n">3</span>
          </h2>
          <div className="xb-grp__list">
            {PIERS.map((p) => {
              const info = cardInfo(byPier[p].state, PIER_ROUTE_HINT[p]);
              return (
                <XbCard
                  key={p}
                  icon="ferryIcon"
                  title={PIER_NAME[p]}
                  sub={info.sub}
                  endLabel={info.label}
                  endValue={info.value}
                  onClick={() => open(p)}
                />
              );
            })}
          </div>
        </section>

        {/* ── 机场 ── */}
        <section className="xb-grp">
          <h2 className="xb-grp__h">
            <Icon name="planeIcon" size={16} />
            <span>机场</span>
            <span className="xb-grp__n">1</span>
          </h2>
          <div className="xb-grp__list">
            <XbCard
              icon="planeIcon"
              title={AIRPORT_NAME}
              sub={airInfo.sub}
              endLabel={airInfo.label}
              endValue={airInfo.value}
              onClick={() => open("airport")}
            />
          </div>
        </section>
      </main>
      <BottomNav />
    </>
  );
}
