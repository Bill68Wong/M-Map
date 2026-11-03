/**
 * 路由策略常量（src/lib/security/route-policy.ts，v3.6.0 · S2）
 *
 * ── 为什么单独成文件（不是为了好看）──────────────────────────────────
 *   这些常量有两类消费者：
 *     ① 运行时 —— `src/proxy.ts` 用它决定 308 / 410 / 403；
 *     ② 门禁脚本 —— `scripts/check-api-guards.ts` 用它判断「哪些写接口已被覆盖」。
 *   若脚本靠正则从 `proxy.ts` 里抠字面量，则代码一改写法（换数组名、拆常量、
 *   改成 `includes`）脚本就静默失效 —— **一直绿的假门禁比没有门禁更危险**。
 *   ⇒ 唯一口径：两边 `import` 同一份，脚本内**禁止**出现任何字面量白名单。
 *
 * ── 改动须知 ──────────────────────────────────────────────────────────
 *   本文件被 runtime 与 scripts 共用，**不得** import 任何 server-only / pg 模块，
 *   否则脚本在纯 node 环境下 import 失败（只允许纯常量与纯函数）。
 */

/**
 * ① 本次下线的页面（前缀匹配，含子路径）→ **308 永久重定向到首页**。
 *
 * ⚠️ 用户裁决（2026-10-29）：采集/计时类页面**全部下线**，不留任何入口。
 *    `/finish` 一并下线：它只服务于计时会话收尾，会话接口已 410，
 *    留着就是一张「提交必然失败」的空白页。
 */
export const PAGE_RETIRED = ["/timer", "/records", "/stats", "/free", "/finish"] as const;

/**
 * ② 退役接口（前缀匹配）→ **410 Gone**。
 *
 * 放在中间件而非逐个 route 的收益：17 个 handler 零改动、不会漏、将来恢复只删一行。
 *
 * ⚠️⚠️ 若要恢复任一接口，**必须先解决主键可枚举问题**：
 *   `timer_sessions.id` / `free_rides.id` 都是 SERIAL 自增，
 *   公开后可按 1,2,3… 顺序扫描 ⇒ 等于把真实出行记录放到公网可扫。
 */
export const GONE_PREFIXES = ["/api/timer", "/api/free"] as const;

/**
 * ③ 保留下来的公开写接口（同源校验）——跨站或来源不明 ⇒ **403**。
 *
 * 这些是**产品功能本身**（收藏页要写入），不能关；靠同源 + 体积上限 + 限流三重护栏。
 */
export const SAME_ORIGIN_PREFIXES = ["/api/fav-routes"] as const;

/** 会改数据的 HTTP 方法（只有这些需要同源校验；GET 保持公开只读） */
export const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** 写方法集合（便于 `has()` 查询） */
export const WRITE_METHOD_SET: ReadonlySet<string> = new Set(WRITE_METHODS);

/**
 * 前缀匹配：`p` 本身或其子路径
 * （`/api/free` 命中 `/api/free/start`，但**不**命中 `/api/freezer`）
 */
export function underPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * 该路径是否属于「已被策略覆盖的写接口」——供门禁脚本判定覆盖率。
 *
 * 注意：这里只回答「是否在已知策略集合内」，**不**代表该接口真有防护实现。
 * 真正的防护校验（令牌 / 限流调用）由 `scripts/check-api-guards.ts` 逐个文件扫描。
 */
export function coveredByPolicy(pathname: string): boolean {
  return underPrefix(pathname, GONE_PREFIXES) || underPrefix(pathname, SAME_ORIGIN_PREFIXES);
}
