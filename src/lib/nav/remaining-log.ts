/**
 * 同源校验失败（403）诊断日志（src/lib/nav/remaining-log.ts，需求1 · 1-B′）
 *
 * ── 为什么单独一个模块 ──────────────────────────────────────────────────
 *   ① `route.ts` 有 **300 行硬门禁**（本项目代码组织规范）。把这段带完整因果说明的
 *      日志逻辑留在 handler 内会把文件顶到 314 行；
 *   ② 这段逻辑**值得被复用到其它自做同源校验的端点**（当前只有 `/api/nav/remaining`），
 *      放在 route 里就复制不开；
 *   ③ 它是**纯函数级**逻辑（只读 req 的 header + nextUrl，无副作用除 console.warn），
 *      可以被断言脚本直接调用验证，不必构造假 Response。
 *
 * ── 为什么这条日志是「唯一可观测痕迹」（不是夸张）──────────────────────
 *   客户端侧 403 **全程静默**（前端核实、我复核）：`fetch` 对 4xx **不 throw**
 *   ⇒ 不走 `catch`，而走 `if (!j?.ok) return;` ⇒ 无 console / 无 `data-*` / 无 UI。
 *   更糟：`data-recompute-seq` 不涨**也无法用于判定**，因为「本来就不需要重算」同样不涨
 *   ⇒ **故障表现与「没触发」完全无法区分**。
 *   ⇒ 这条日志是线上唯一能区分两者的东西。它被删/被收口 ⇒ 彻底不可诊断。
 *
 * ── 为什么必须带来源标签（1 行设计，但决定这条日志有没有用）───────────
 *   失败场景永远是「三个来源不一致」。若只打 `["a.com","b.com","c.com"]` 平铺数组，
 *   运维**无法判断**是哪个 header 不匹配 —— 而"哪个"恰恰决定修哪里：
 *     · `xfwd` 不同 ⇒ 代理链注入了外部域名（正常，但也说明 origin 侧取错）
 *     · `host` 不同 ⇒ 上游覆盖了 Host（Vercel 配置问题）
 *     · `url`  不同 ⇒ `nextUrl` 被改写成内部部署域名（**最可能的一种**）
 *   ⇒ 打结构化对象 `{xfwd, host, url}`，一眼看出谁跟谁不一致。
 *
 * ── 为什么值要 `?? null` 而不是 `filter(Boolean)` 丢掉 ─────────────────
 *   丢掉会让「缺失」与「与别人相同」变成同一种表现（都少一项）。
 *   而**缺失本身**就是关键信息（`isSameOrigin` 里 `if (!srcHost) return false` 是另一条分支，
 *   与「有 origin 但不匹配」是完全不同的修法）。显式 `null` 才能区分二者。
 *
 * ⚠️ 只记 host 级信息（**不含**完整 URL / cookie / body / 任何凭据），
 *    不进响应体（AC-50d：响应体只允许六枚举）。
 *
 * 纯函数：只读入参、只 `console.warn`，不读时钟、不查库。
 */
import type { NextRequest } from "next/server";

/** 三个 host 来源的原始值（`null` = 该 header 不存在） */
export interface OwnHosts {
  /** `x-forwarded-host`（多级代理时可能是逗号列表，这里保留原值不做解析） */
  xfwd: string | null;
  /** `host` */
  host: string | null;
  /** `req.nextUrl.host`（Vercel 上可能被改写成内部部署域名） */
  url: string | null;
}

/** 取三个 host 来源（**不丢 null**，见模块头说明） */
export function ownHostsOf(req: NextRequest): OwnHosts {
  return {
    xfwd: req.headers.get("x-forwarded-host"),
    host: req.headers.get("host"),
    url: req.nextUrl.host || null,
  };
}

/** 三方是否完全一致（含「都没取到」这种异常一致） */
export function hostsAgree(h: OwnHosts): boolean {
  return h.xfwd === h.host && h.host === h.url;
}

/**
 * 把 host 来源渲染成**一行可诊断**字符串。
 *
 * 一致时只打一个值（省日志行，也避免「三个重复值」被误读成三个不同 host ——
 * 本地测试就恒为 `["localhost:3000","localhost:3000"]`，正是这个歧义）；
 * 不一致时打结构化对象，一眼看出谁跟谁不同。
 */
export function formatOwnHosts(h: OwnHosts): string {
  if (hostsAgree(h)) return `ownHosts=${JSON.stringify(h.url)}(三方一致)`;
  return `ownHosts=${JSON.stringify({ xfwd: h.xfwd, host: h.host, url: h.url })}`;
}

/**
 * 打一条 403 诊断日志（`console.warn`，**无条件执行** —— 不要加 `if (isDev)` 之类的门控，
 * 那会让线上重新变成完全不可诊断）。
 *
 * @param scope 调用方标识（如 `"[api/nav/remaining]"`），便于多端点共用时区分来源
 */
export function logSameOriginReject(scope: string, req: NextRequest): OwnHosts {
  const h = ownHostsOf(req);
  console.warn(
    `${scope} 同源校验拒绝（403）：`,
    formatOwnHosts(h),
    `origin=${req.headers.get("origin") ?? "<none>"}`,
    `referer=${req.headers.get("referer") ? "<set>" : "<none>"}`,
  );
  return h;
}
