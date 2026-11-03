import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

/** 构建期版本单字符串（唯一来源 = package.json；DSAT UA 同源）。经 env 注入 ⇒ 服务端/客户端同值。 */
const APP_VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version as string;

const nextConfig: NextConfig = {
  /**
   * ★ v3.8.0：`NEXT_PUBLIC_APP_VERSION` 供开屏版本门（`src/lib/splash/version.ts`）与
   *   `body[data-app-version]` 只读钩子使用 —— 架构要求「不存在第二个版本来源」，
   *   故从 package.json 注入而不是各处手写。
   */
  env: { NEXT_PUBLIC_APP_VERSION: APP_VERSION },
  /**
   * ★ 2026-09-24：构建目录可被 `NEXT_DIST_DIR` 覆盖（缺省 = 默认 `.next`，线上零影响）。
   *   动机：本机 `.next` 目录树在构建进程被强杀后出现过 NTFS 级异常状态——
   *   `next build` 会固定卡在 `EPERM: open '.next/trace'`（清目录/换环境均复现）；
   *   ⇒ 本地构建与启动统一改用全新目录绕开。⚠️ Vercel 端未设该变量 ⇒ 行为与既有完全一致。
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",
  /**
   * ⚠️ Next 16 起 `next build` 默认使用 **Turbopack**（不再需要 `--turbopack`）。
   *   本仓**没有**自定义 `webpack` 配置 ⇒ 不会触发「有 webpack 配置时 build 失败」的保护。
   *   升级实测（2026-11-03）：Turbopack 下 `pg` 外部化行为与 webpack **完全一致**
   *   （两者产物 `nft.json` 中 `pg` 相关路径均为 828 条）⇒ **无需** `serverExternalPackages`，
   *   不要为了"保险"添加未经验证的配置。
   *
   *   已删除原先的空 `experimental: {}`（Next 16 下无内容，留着只会误导）。
   *
   * DSAT 接口仅由服务端调用，无需跨域配置
   */
  async rewrites() {
    return [
      // ★ v1.3.0 高德 JS API 安全代理（设计 §2.D）
      //   公开 URL 保持设计要求的 `/_AMapService/*`；但 **Next App Router 把「下划线开头」
      //   的文件夹视为私有文件夹、不参与路由** ⇒ 无法直接在 `src/app/_AMapService/` 放 route。
      //   ⇒ 处理器实际放在 `/api/amap-service`，这里把它「暴露」为 `/_AMapService`。
      //   浏览器设 `_AMapSecurityConfig.serviceHost = location.origin + '/_AMapService'`，
      //   高德 JS 的所有服务请求即打到本代理（密钥/安全码只在服务端拼接，不下发浏览器）。
      { source: "/_AMapService/:path*", destination: "/api/amap-service/:path*" },
    ];
  },
};

export default nextConfig;
