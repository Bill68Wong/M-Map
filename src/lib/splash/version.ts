/**
 * 开屏动画 · 构建版本（src/lib/splash/version.ts，v3.8.0 终版）
 *
 * ── 版本门已废除（负责人裁定，v3.8.0 终版）───────────────────────────────
 *   开屏动画 = **每次冷启动/页面加载都播**（原始需求原文：「趁首页地图还在加载的时候
 *   利用开屏动画优化用户体验」）。此前 PM 口径的「高频工具会腻 ⇒ 版本门低频播放」已作废，
 *   cookie `mmap.splash.ver` / `majorOf` / `shouldPlaySplashServer` / `writeSplashRecords`
 *   **全部移除**。
 *
 *   [禁止] 不要因为「每次播会腻」再把版本门加回来——那是产品决策，已由负责人裁定为每次播。
 *   [禁止] 不要用 sessionStorage 做「本会话已播」——同一 tab 内 F5 会保留 sessionStorage，
 *      会破坏「连续两次硬刷新都要播」这条验收（见 BrandSplash 的模块级标记）。
 *
 * ── 保留：一个只读观测钩子 ──────────────────────────────────────────────
 *   `body[data-app-version]`（构建期静态注入，无动态渲染、无 hydration 副作用）。
 *   验收脚本用它对照/记录版本，**但不参与任何门判定**。
 */

/**
 * 当前构建版本。来源 = `next.config.ts` 把 `package.json` 的 `version` 注入
 * `NEXT_PUBLIC_APP_VERSION`（服务端与客户端同源读这个值；不要在别处再读 package.json）。
 */
export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";
