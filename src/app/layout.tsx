import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import BrandSplash from "@/components/brand/BrandSplash";
import PressFeedback from "@/components/ui/press-feedback";
import "./globals.css";

/** 与 README 线上地址一致；`metadataBase` 只用于把相对 OG 图 URL 解析成绝对地址 */
const SITE_URL = "https://macaomap.vercel.app";

export const metadata: Metadata = {
  title: { default: "M Map", template: "%s · M Map" },
  description: "澳门巴士 / 轻轨全澳导航：全屏地图、路线收藏与实时报站",
  manifest: "/manifest.webmanifest",
  /**
   * ★ v3.0.0：OG / 分享卡元数据。
   *   · `metadataBase` 必须有 —— 否则 `images: ["/brand/og.png"]` 相对路径不会被解析成绝对地址，
   *     多数平台（微信 / X / FB）会取不到图。
   *   · OG 图固定深底（不随站点主题漂移），资产落 `public/brand/og.png`（`/brand` 已是 middleware
   *     公开前缀 ⇒ 免登记；**绝不**放 `public/` 根，否则线上 307 坏图）。
   *   · 版式源与自检：docs/迭代-v215-20260925/02-logo/final/OG-CARD.md（`check-og.mjs` 16 项全绿）。
   */
  metadataBase: new URL(SITE_URL),
  openGraph: {
    type: "website",
    siteName: "M Map",
    locale: "zh_CN",
    url: "/",
    title: "M Map · 澳门巴士／轻轨全澳导航",
    description:
      "输入起点与终点，给出步行 + 巴士／轻轨 + 换乘 + 实时到站的门到门方案，按总时长排序。",
    images: [
      { url: "/brand/og.png", width: 1200, height: 630, alt: "M Map · 澳门巴士与轻轨全澳导航" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "M Map · 澳门巴士／轻轨全澳导航",
    description:
      "输入起点与终点，给出步行 + 巴士／轻轨 + 换乘 + 实时到站的门到门方案，按总时长排序。",
    images: ["/brand/og.png"],
  },
  /**
   * ★ v2.15.0：品牌定稿（第五轮）——矢量 SVG 优先，PNG 兜底（16/32 供不支持 SVG 图标的浏览器）。
   *   apple-touch-icon 为满幅方角（iOS 自行切圆角），故不写 sizes 之外的任何 shape 提示。
   *   详见 docs/迭代-v215-20260925/02-logo/final/INTEGRATE.md §2。
   */
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  /**
   * ★ v2.4.1：**禁止整页缩放**（用户 2026-09-21 拍板：「理论上仅地图区域允许缩放」）。
   *
   * ⚠️ 此处**推翻了 v1.1.7 的决定**。原决定（见 `docs` 与 git 历史）是：站内有 12px 小字，
   *    光线差或年长用户读不到却放不大，违反 WCAG 1.4.4 的缩放要求，故放开到 5 倍。
   *    用户重新权衡后选择「交互稳定优先」，因为整页可缩放带来两个实际困扰：
   *      ① **搜索框聚焦时页面自动放大**（输入框字号 < 16px 触发浏览器行为）；
   *      ② 路线页滑动时**双指易误触发**缩放。
   *    **补偿（已落地）**：站内最小字号由 11px 提到 13px（见 `--text-xs`），
   *      降低对「放大读小字」的依赖。
   *    ⚠️ 地图自身的手势缩放**不受影响** —— 高德 JS API 自行监听 touch 事件处理缩放，
   *      与 viewport 的 `user-scalable` 无关。
   */
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F2F4F0" },
    { media: "(prefers-color-scheme: dark)", color: "#111318" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        {/* ★ v3.8.0 开屏覆盖层：挂根布局 ⇒ 任何整页加载（冷启动/刷新/深链/分享链接）都播一次；
            客户端路由因 layout 不重挂 ⇒ 结构性不播，无需任何已播标记。 */}
        <BrandSplash />
        <PressFeedback />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
