/**
 * 路线详情「本站台其他线路」数据构建（src/lib/nav/detail-fold.ts，2026-09-23 新增）
 *
 * 为什么独立成文件：详情体（纵向站条 + 折叠栏 + 实时报站）现在有**两个消费方** ——
 *   · `/nav/detail` 页面（SSR；直链 / 刷新场景）
 *   · `POST /api/nav/detail-body`（全屏详情弹窗；不重算整条 planNav）
 *   ⇒ 同一份逻辑放这里，避免两处实现漂移（页面改了、弹窗忘改）。
 *
 * ⚠️ **server-only**：依赖 `loadStatics` 的静态索引与 `fetchStationLive`（DSAT 实时）。
 *   客户端组件请走 `/api/nav/detail-body` 取数。
 *
 * 口径（与详情页 v1.3.0 完全一致）：
 *   · 「其他线路」= 该下车站台（主码）可达、且未被本方案用过的线路（最多 16 条）；
 *   · 实时报站：对每条线路取「经过本站的第一个方向」，以本站**下一站**为目的点查 DSAT
 *     （定方向 + 排除已过站车）→「还有 N 站 · 约 X~Y 分」；**轻轨不在本表**（时刻表制）；
 *     失败一律收敛为空，不阻塞。
 */
import type { Pool } from "pg";
import { nowBucketOfHolidayAware } from "@/lib/rebuild/holidays";
import { fetchStationLive } from "@/lib/recommend/live";
import { etaTextOf } from "@/lib/recommend/catch-up";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { RecStatic } from "@/lib/recommend/query";

/** 该主码站台**其他**可达线路（排除本卡已用的线路；按站序索引统计） */
export function otherRoutesAt(st: RecStatic, main: string, used: string[]): string[] {
  const usedSet = new Set(used);
  const out = new Set<string>();
  for (const [key, stops] of st.routeIdx.dirStops) {
    const route = key.split("|")[0];
    if (usedSet.has(route)) continue;
    for (const code of stops) {
      if (mainCodeOf(code) === main) {
        out.add(route);
        break;
      }
    }
  }
  return [...out].slice(0, 16);
}

/**
 * 「本站台其他线路」实时报站（**巴士**）：route → 文案（「还有 N 站 · 约 X~Y 分」）。
 * 轻轨不参与（时刻表制，非 DSAT）；失败一律收敛为空。
 */
export async function foldLiveAt(
  pool: Pool,
  st: RecStatic,
  stationMain: string,
  routes: string[],
  nowMs: number,
): Promise<Record<string, string>> {
  const nowBucket = await nowBucketOfHolidayAware(pool, nowMs);
  const jobs: { station: string; dest: string; routes: string[] }[] = [];
  const stopCodeOf: Record<string, string> = {};
  for (const r of routes) {
    if (r.startsWith("LRT-")) continue; // 轻轨无 DSAT 实时；折叠栏暂不含
    for (const d of st.routeIdx.dirsOf.get(r) ?? []) {
      const stops = st.routeIdx.dirStops.get(`${r}|${d}`) ?? [];
      const i = stops.findIndex((c) => mainCodeOf(c) === stationMain);
      if (i >= 0 && i + 1 < stops.length) {
        jobs.push({ station: stops[i], dest: stops[i + 1], routes: [r] });
        stopCodeOf[r] = stops[i];
        break;
      }
    }
  }
  if (!jobs.length) return {};
  const out: Record<string, string> = {};
  try {
    const live = await fetchStationLive(pool, jobs, st.routeIdx, st.segIdx, { nowBucket, nowMs });
    for (const r of Object.keys(stopCodeOf)) {
      const b = live.get(`${r}@${stopCodeOf[r]}`)?.nearest ?? null;
      out[r] = b ? `还有 ${b.stopsAway} 站 · ${etaTextOf(b)}` : "暂无班次信息";
    }
  } catch {
    /* 实时不可用 → 收敛为空（折叠栏仍显示线路标签） */
  }
  return out;
}

/**
 * 由「已算好的卡」直接组装折叠栏所需的三件套（页面与弹窗共用）：
 * `{ otherRoutes, foldLive, stationLabel }`。
 *
 * ★ 2026-09-24 重构（用户口径）：站台 = **第一程「上车站」**（原为末程下车站——「都搞错了」）。
 *   目的：用户在站台等车/没赶上本班时，可就地看**同一站台**还有哪些线路可换乘到目的地。
 * `card` 只用到 `rides[].route/board/boardLabel`（结构兼容 `RecommendCard`）。
 *
 * ★ v3.7.0（C5）：`opts.live = false` ⇒ **不查 DSAT**（`foldLive` 恒 `{}`），
 *   仅返回线路清单与站台名。**缺省 `true`** = 行为与改动前一字不差（不传 opts 的调用方零影响）。
 *   为什么要有这个开关：1.6KB 的折叠栏数据实测要 **3.1s**（`BUCKET_TIMEOUT_MS`），
 *   而折叠栏默认**折叠**、用户看不见 ⇒ 拿 3.1s 换一个不展示的内容，且它挡在
 *   `route-shapes` 前面把「开始导航」链拉到 3.8s（见 01-技术调研 §2.1）。
 *   当前唯一调用方 `POST /api/nav/detail-body` 显式传 `{ live: card 需要时 }`。
 */
export async function foldDataOfCard(
  pool: Pool,
  st: RecStatic,
  card: { rides: { route: string; board: string; boardLabel?: string }[] },
  nowMs: number,
  opts?: { live?: boolean },
): Promise<{
  otherRoutes: string[];
  foldLive: Record<string, string>;
  stationLabel: string | null;
}> {
  const firstRide = card.rides[0];
  const firstBoardMain = firstRide ? mainCodeOf(firstRide.board) : null;
  const otherRoutes = firstBoardMain ? otherRoutesAt(st, firstBoardMain, card.rides.map((r) => r.route)) : [];
  // ⚠️ 缺省 `live !== false` ⇒ 不传 opts 的调用方行为**一字不变**（页面 SSR 仍走实时）
  const wantLive = opts?.live !== false;
  const foldLive =
    firstBoardMain && wantLive ? await foldLiveAt(pool, st, firstBoardMain, otherRoutes, nowMs) : {};
  return {
    otherRoutes,
    foldLive,
    stationLabel: firstRide?.boardLabel ?? firstBoardMain ?? null,
  };
}
