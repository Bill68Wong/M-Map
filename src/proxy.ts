import { NextRequest, NextResponse } from "next/server";
import { API_ERROR, errorResponse } from "@/lib/http/errors";
import { isSameOrigin } from "@/lib/security/same-origin";
import {
  GONE_PREFIXES,
  PAGE_RETIRED,
  SAME_ORIGIN_PREFIXES,
  WRITE_METHOD_SET,
  underPrefix,
} from "@/lib/security/route-policy";

/**
 * 路由中间件 · ★ v3.6.0（S2）：**全站公开** + 旧链接兜底 + 退役接口 410
 *
 * ── 这一版删掉了什么（为什么删）────────────────────────────────────────
 *   v3.5.5 的 middleware 是一套 **fail-closed 口令门**：除白名单外的页面/接口一律要
 *   `ACCESS_PASSWORD`（未配则生产环境也拒绝，只有本地开发放行）。它解决了「数据页别公开」，
 *   但代价是每新增一个 API 都要记得登记白名单 —— 项目为此**踩过三次**（`/api/fav-routes`、
 *   `/api/route-*`、`/api/route-vehicles` 都曾因漏登记在生产直接 401）。用户 2026-10-29 裁决：
 *   采集/开发类页面**整体下线**，站点**公开不宣传** ⇒ 口令门失去存在理由，整段拆除。
 *   ⚠️ 本文件**不再读取 `ACCESS_PASSWORD`**（生产环境仍配着该变量，改为不读，
 *      避免「代码与运维必须同步」的隐性依赖）。
 *
 * ── 现在只做三件事 ───────────────────────────────────────────────────
 *   ① 已删除页面的旧链接 308 兜底（`/nav`、`/nav/detail` → 首页）；
 *   ② 本次下线页面 308 → 首页（`PAGE_RETIRED`，含子路径，如 `/timer/12`、`/free/history`）；
 *   ③ 退役接口 410 Gone（`GONE_PREFIXES`，一处覆盖 17 个 route handler，逐条不漏）。
 *   另外对**保留下来的公开写接口** `/api/fav-routes*` 做同源校验（AC-50c：跨站 403）。
 *
 * ── 鉴权矩阵的落点（拆门后的真问题）──────────────────────────────────
 *   拆门 ≠ 全都不设防。写接口按风险分级处置，**不在本文件**的两类见各自 route：
 *   · A1 `POST /api/dsat/grab`（写采集库 + 触发 DSAT）→ Bearer `GRAB_TOKEN`
 *     （`src/lib/security/internal-token.ts`，未通过 401）；
 *   · A4 `/api/fav-routes*`（保留功能的公开写）→ 本文件同源校验 403 +
 *     route 内 16KB 体积上限（413）+ `fav` 令牌桶（429）。
 *
 * ── 若要重新上锁（保留可恢复的设计记录，不是保留代码）──────────────────
 *   1. 新增 `PUBLIC_PAGES` / `PUBLIC_PREFIXES` / `PUBLIC_FILES` 三级白名单与 `isPublic()`；
 *   2. 在 `middleware()` 末尾恢复「读 cookie `mx_auth` vs `ACCESS_PASSWORD`」判定，
 *      未通过时页面 307 → `/login`、`/api/*` 401；
 *   3. 恢复 `/login` 页与 `/api/auth` 路由（本版已删，见 git 历史 v3.5.5）。
 *   完整取舍与回滚方式见 `docs/decisions/ADR-106-拆除访问口令门.md`。
 */

/**
 * ①~③ 三段策略常量已抽到 `src/lib/security/route-policy.ts`。
 *
 * ⚠️ **不要在本文件重新定义**这些常量：门禁脚本 `scripts/check-api-guards.ts`
 *    必须 import 同一份才能保证「脚本检查的集合 = 运行时生效的集合」。
 *    在这里复制一份字面量，等于让脚本与实际行为悄悄分叉（脚本恒绿但没覆盖）。
 *
 * 具体含义见 route-policy.ts 的注释（PAGE_RETIRED / GONE_PREFIXES / SAME_ORIGIN_PREFIXES）。
 */

/**
 * ⚠️ Next 16 起 `middleware` 文件约定被**弃用并改名为 `proxy`**（官方版本历史：
 *   「v16.0.0 Middleware is deprecated and renamed to Proxy」）。本文件随之改名，
 *   导出函数也由 `middleware` 改为 `proxy`。
 *
 *   运行时差异：`proxy` 固定跑 **Node.js runtime 且不可配置**（不再支持 edge）。
 *   本文件只用到 `NextRequest` / `NextResponse` / `nextUrl` 与纯同步判定，
 *   **不依赖任何 edge 专有能力** ⇒ 改名无行为风险。
 *
 *   `config.matcher` 语义不变，继续生效。
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ── ① /nav、/nav/detail 已删除（功能并入首页全屏弹窗）→ 308 回首页 ──
  //   ⚠️ 必须放在其余判定之前：旧链接对谁都应回首页，不能被后面的规则改写目标。
  //   ⚠️ query 保留（首页要用 fromLng…&toLng… 预填起终点），仅删除已废弃的 `plan`。
  if (pathname === "/nav" || pathname === "/nav/detail") {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.searchParams.delete("plan");
    return NextResponse.redirect(url, 308);
  }

  // ── ② 本次下线页面 → 308 回首页（query 一并丢弃：这些页面不再有语义）──
  if (underPrefix(pathname, PAGE_RETIRED)) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url, 308);
  }

  // ── ③ 退役接口 → 410 Gone（固定文案，不含任何内部信息）──
  if (underPrefix(pathname, GONE_PREFIXES)) {
    return errorResponse(API_ERROR.gone);
  }

  // ── ④ 公开写接口：同源校验（AC-50c）──
  //   浏览器跨站 fetch 会带 `Origin`；缺失（脚本/旧客户端）或跨站 ⇒ 一律 403。
  if (WRITE_METHOD_SET.has(req.method) && underPrefix(pathname, SAME_ORIGIN_PREFIXES)) {
    if (!isSameOrigin(req)) return errorResponse(API_ERROR.forbidden);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
