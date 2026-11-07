/**
 * 响应装配（src/lib/cross-border/respond.ts）—— 纯函数，把"三态空"与"stale"落成契约
 *
 * 路由只做：校验参数 → 采集 → 查询 → **调本文件** → 序列化。
 * 空态判定放这里而不是路由，是为了能被 `scripts/test-xborder-status.ts` 直接断言
 * （路由文件 import 了 `next/server`，跑不进纯脚本）。
 *
 * ── 空态三值（契约 §2.5，必须能区分"三种空"）────────────────────────────
 *   `not_yet_collected`    `dayTotal === 0 && dataFetchedAt === null` ⇒ **我方**还没采到
 *   `no_service_today`     `dayTotal === 0 && dataFetchedAt !== null` ⇒ 采到了，真的没有班次
 *   `none_remaining_today` `dayTotal > 0 && items === 0`（且 `after=now`）⇒ 今天有班，都走完了
 *
 * ── 三条边界规则（少一条前端就会出现"1 条"和"0 条"文案打架）─────────────
 *   ① `items.length > 0` ⇒ **整个字段缺席**（不是给 null）—— 少一次 `??` 判断，
 *      也避免"有数据却带 emptyReason"这种自相矛盾的响应。
 *   ② `after=day` **永远不出现** `none_remaining_today`：`day` 不过滤终态，
 *      `dayTotal > 0` 必然 `items.length > 0`。若出现，说明终态过滤被误加到了 `day` 分支。
 *   ③ 上面的"不可能"分支一旦真的发生，**不掩盖**：`console.error` 把上下文打全。
 *      这里刻意不用 warn —— 它是内部不变量被破坏，不是上游波动。
 */
import type { XbAfter, XbEmptyReason, XbListResponse } from "./types";

/** 判定空态原因；`items` 非空时返回 undefined（字段缺席） */
export function resolveEmptyReason(args: {
  itemCount: number;
  dayTotal: number;
  after: XbAfter;
  dataFetchedAt: string | null;
  /** 仅用于错误日志定位是哪个端点/作用域，不参与判定 */
  scope: string;
}): XbEmptyReason | undefined {
  const { itemCount, dayTotal, after, dataFetchedAt, scope } = args;
  if (itemCount > 0) return undefined;

  if (dayTotal === 0) {
    // 从未采到 vs 采到了但没有 —— 这两句话对用户是完全不同的（一个是我们的故障）
    return dataFetchedAt === null ? "not_yet_collected" : "no_service_today";
  }

  if (after === "now") return "none_remaining_today";

  // 不可达：day 分支下 dayTotal>0 必有 items。真到了这里说明过滤条件被改坏。
  console.error(
    `[xborder] 响应装配异常 scope=${scope} after=day 但 dayTotal=${dayTotal} 且 items=0` +
      `（说明 day 分支被误加了过滤条件）`,
  );
  return "no_service_today";
}

/** 组装列表响应（`items` 由调用方决定；本函数不碰 IO） */
export function buildListResponse<T>(args: {
  items: T[];
  dayTotal: number;
  after: XbAfter;
  serverNow: string;
  dataFetchedAt: string | null;
  stale: boolean;
  attribution: XbListResponse<T>["attribution"];
  scope: string;
}): XbListResponse<T> {
  const emptyReason = resolveEmptyReason({
    itemCount: args.items.length,
    dayTotal: args.dayTotal,
    after: args.after,
    dataFetchedAt: args.dataFetchedAt,
    scope: args.scope,
  });
  const out: XbListResponse<T> = {
    ok: true,
    items: args.items,
    dayTotal: args.dayTotal,
    after: args.after,
    serverNow: args.serverNow,
    dataFetchedAt: args.dataFetchedAt,
    stale: args.stale,
    attribution: args.attribution,
  };
  if (emptyReason) out.emptyReason = emptyReason;
  return out;
}

/**
 * 响应头（契约 §2.7）。**必须同时给 `max-age`**：
 * 只写 `s-maxage` 时 Vercel 会把它从浏览器可见头里剥掉
 * （本项目在 `api/tqh/lines/route.ts` 与 `api/route-lines/route.ts` 各记过一次这个坑）。
 *
 * `stale:true` 必须 `no-store`：否则"暂时无法更新"这个**临时**状态会被边缘节点缓存固化，
 * 上游恢复了用户还看到旧状态。
 */
export const CACHE_HEADERS = {
  airport: { "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300" },
  ferry: { "Cache-Control": "public, max-age=30, s-maxage=30, stale-while-revalidate=120" },
  stale: { "Cache-Control": "no-store" },
} as const;
