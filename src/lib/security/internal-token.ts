/**
 * 内部运维接口令牌（src/lib/security/internal-token.ts，v3.6.0 S2）
 *
 * ── 背景 ──────────────────────────────────────────────────────────────
 *   `POST /api/dsat/grab` 会**写采集表**并**触发 DSAT 实时请求**。v3.5.5 以前它靠
 *   `proxy.ts` 的 fail-closed 口令门顺带保护；v3.6.0 拆门后若不同批加鉴权，
 *   等于当天在公网开一个「谁都能刷 DSAT + 污染采集库」的洞（风控红线）。
 *
 * ── 口径（与 `api/cron/rebuild/route.ts:59-70` 同构）──────────────────
 *   · 配了 `GRAB_TOKEN` ⇒ 必须匹配 `Authorization: Bearer <token>`；
 *   · 未配 ⇒ **仅非生产放行**（本地调试），生产 environment **一律拒绝**（fail-closed）；
 *   · 不支持 `?key=`（URL 里的密钥会进访问日志与浏览器历史，写接口不收这个口子）。
 *
 * ⚠️ 失败原因**不回给客户端**（连「是否配置了 token」都不透露）—— 调用方只看到统一的
 *    `unauthorized`。判定细节只进服务端日志（见调用方）。
 */

/**
 * 请求是否携带正确的内部令牌。
 *
 * @param req 只要有 `headers` 即可（Edge/Node 通用）
 */
export function hasInternalToken(req: { headers: { get(name: string): string | null } }): boolean {
  const secret = process.env.GRAB_TOKEN;
  if (!secret) {
    // 未配令牌：仅本地开发放行；生产环境拒绝（防公开触发）
    return process.env.NODE_ENV !== "production";
  }
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}
