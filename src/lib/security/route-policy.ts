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
 *
 * ⚠️ 2026-11-06（通琴号迭代 · 旧推荐链下线）：`/commute`、`/recommend`、`/card`
 *    随 14 张表同批下线。三者都是旧「通勤方案」概念的页面：数据源
 *    `commute_plans` / `plan_legs` / `places` 本批删除，页面不删就是必然 500 的空白页。
 *    产品上它们也早已无导航入口（`BottomNav` 只有 `/` `/favorites` `/help`）。
 */
export const PAGE_RETIRED = [
  "/timer",
  "/records",
  "/stats",
  "/free",
  "/finish",
  "/commute",
  "/recommend",
  "/card",
] as const;

/**
 * ② 退役接口（前缀匹配）→ **410 Gone**。
 *
 * 放在中间件而非逐个 route 的收益：17 个 handler 零改动、不会漏、将来恢复只删一行。
 *
 * ⚠️⚠️ 若要恢复任一接口，**必须先解决主键可枚举问题**：
 *   `timer_sessions.id` / `free_rides.id` 都是 SERIAL 自增，
 *   公开后可按 1,2,3… 顺序扫描 ⇒ 等于把真实出行记录放到公网可扫。
 *
 * ⚠️ 2026-11-06（旧推荐链下线）：`/api/plans`、`/api/recommend`、`/api/card`、
 *    `/api/fav-routes`、`/api/dsat/grab` 一并退役。前四个的数据源
 *    （`commute_plans` / `plan_legs` / `places` / `favorite_routes`）本批删除；
 *    `/api/dsat/grab` 的写点 `bus_snapshots` 本批删除。
 *    对应 route 目录已同时删除 —— 410 是给**书签/旧客户端**的兜底，
 *    不是让它们继续被新代码调用。
 */
export const GONE_PREFIXES = [
  "/api/timer",
  "/api/free",
  "/api/plans",
  "/api/recommend",
  "/api/card",
  "/api/fav-routes",
  "/api/dsat/grab",
] as const;

/**
 * ③ 保留下来的公开写接口（同源校验）——跨站或来源不明 ⇒ **403**。
 *
 * 这些是**产品功能本身**（收藏页要写入），不能关；靠同源 + 体积上限 + 限流三重护栏。
 *
 * ⚠️ 2026-11-06：`/api/fav-routes` 已整体退役（进 `GONE_PREFIXES`，410），
 *    故从本常量移除。留着会让「同源校验覆盖范围」与「实际可达接口」分叉 ——
 *    中间件里 410 判定在前，同源判定永远走不到，属**看起来在防护、实际零作用**的假条目。
 *    当前为空：本批之后**不再有任何保留下来的公开写接口**。
 */
export const SAME_ORIGIN_PREFIXES = [] as const;

/**
 * ④ **在 handler 内自做同源校验**的写接口（`isSameOrigin()` 直接在 route 里调，不经中间件）。
 *
 * 为什么单独记一份而不是并进 `SAME_ORIGIN_PREFIXES`：中间件那条规则会**额外**要求
 * `acquireToken()` 两件套（AC-50 A4）。而下列端点是**纯计算、0 外部调用**，
 * 加一次令牌桶事务等于给亚毫秒端点凭空挂上约 230ms 的 DB 往返（实测值见
 * `dsat/client.ts:45`）⇒ 属净负收益。它们只需要「挡住别的网站替用户发请求」。
 *
 * ⚠️ **本常量是「登记/文档」，刻意不被任何代码消费**（`proxy.ts` 不读它、
 *    `check-api-guards.ts` 也不读它 —— 后者靠扫描 handler 内是否出现
 *    `isSameOrigin(` 之类的调用点来判定，见 `GUARD_CALLS`）。
 *    刻意不消费的理由：一旦让门禁读它，就等于给这些路径开了一条「声明即豁免」的洞；
 *    而现状是门禁**逐个 handler 验证真调用**，更严。新增路径请同步更新本清单，
 *    否则「登记」会与实际分叉（这份清单的唯一价值就是让人能一眼看全）。
 */
export const HANDLER_SAME_ORIGIN_PATHS = [
  /** 需求1 / 1-B′：导航中重算剩余时间（只读静态索引 + 内存计算，0 DSAT / 0 高德） */
  "/api/nav/remaining",
] as const;

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

/* ══════════════════════════════════════════════════════════════════════════
 * ⚠️ 已删除：`coveredByPolicy(pathname)`（2026-11-03，需求1 · 1-B′ 收尾）
 *
 * 它曾导出 `underPrefix(GONE_PREFIXES) || underPrefix(SAME_ORIGIN_PREFIXES)`，
 * 注释写「供门禁脚本判定覆盖率」—— 但**从 v3.6.0 S2 引入起就零消费方**（出生即死代码），
 * 且在本文件新增 `HANDLER_SAME_ORIGIN_PATHS` 后，它的语义已与设计意图**不一致**
 * （对 `/api/nav/remaining` 返回 false，而该路径**确实**已被策略覆盖 —— 只是覆盖在
 * handler 内而非中间件）。
 *
 * ── 为什么是「删」而不是「补上画像 ④」────────────────────────────────
 *   补上会让它返回 true。一旦将来有人把它接进 `check-api-guards.ts` 当「已覆盖」判据，
 *   门禁就会**跳过 `GUARD_CALLS` 的调用点扫描** ⇒ 产出**假绿**（"已覆盖"但实际没防护）。
 *   这比它现在"误报未覆盖"更危险：误报会让人多查一遍，假绿会让人**永远不再查**。
 *   ⇒ 一个函数如果需要"用之前先读三段注释才安全"，它就不该存在。
 *
 * ── 将来若真需要"策略覆盖查询"（不是门禁通过判据）────────────────────
 *   请**按层级**返回，不要压成一个 boolean：
 *     `coverageOf(pathname): { middleware: boolean; handler: boolean }`
 *   并把「门禁是否通过」留给 `GUARD_CALLS` 的**实际调用点扫描** —— 那才是唯一可信判据
 *   （见本文件 `HANDLER_SAME_ORIGIN_PATHS` 注释与 `check-api-guards.ts` 规则 ③）。
 *   压成 boolean 必然再次丢掉"覆盖在哪一层"这个关键信息，也就是这次出问题的根源。
 * ══════════════════════════════════════════════════════════════════════════ */
