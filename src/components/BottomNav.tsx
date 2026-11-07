"use client";

/**
 * 底部主导航（src/components/BottomNav.tsx，M Map 改版 S4）
 *
 * ── 结构（PRD §9 / 设计 E.1；★ v2.10.0 增第 3 个 tab）──────────────
 *   三个 Tab：**首页**（`/`）· **路线收藏**（`/favorites`）· **帮助**（`/help`）。
 *   · 高 `var(--tabbar-h)` + `env(safe-area-inset-bottom)`；顶边 1px 发丝线；**不透明底**（不用毛玻璃）；
 *   · 选中态：**双通道** —— ① 图标切**实心变体** ② 文字加粗；再叠**青花蓝**（不只靠颜色，利于色盲）；
 *   · 命中区：每 tab 半屏宽、高 ≥48px；
 *   · 收藏 tab 有内容时右下角一个 6px 强调色圆点（**不写数字**，避免「红点焦虑」）。
 *
 * ── 挂载策略（ADR-003）────────────────────────────────────────────────
 *   **页级组件**，只挂在首页 / 收藏页（`/about` 亦挂）；**不挂全局布局**
 *   （挂全局会波及 `/commute`、`/nav` 等旧页 → 大面积回归）。
 *
 * ⚠️ SSR 首帧 `useCombos` 恒为空 → 收藏圆点首帧不渲染（`mounted` 守卫，防 hydration 失败）。
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import Icon, { type IconName } from "@/components/ui/Icon";
import { useCombos } from "@/lib/favorites/useCombos";

interface TabDef {
  key: "home" | "favorites" | "crossBorder" | "help";
  href: string;
  label: string;
  /** 未选态图标（线性） */
  icon: IconName;
  /** 选中态图标（实心变体 —— 第二通道） */
  iconOn: IconName;
  match: (p: string) => boolean;
}

const TABS: TabDef[] = [
  {
    key: "home",
    href: "/",
    label: "首页",
    icon: "home",
    iconOn: "homeFilled",
    // 首页高亮：`/`（★ 2026-09-23：`/nav`、`/nav/detail` 已删除 ⇒ `startsWith("/nav")` 恒不命中，简化）
    match: (p) => p === "/",
  },
  {
    key: "favorites",
    href: "/favorites",
    /* ★ v3.3.0（AC-110）：「路线收藏」→「收藏」（收藏体系 = 组合 + 地点两类，不再是「路线」） */
    label: "收藏",
    icon: "bookmark",
    iconOn: "bookmarkFilled",
    match: (p) => p.startsWith("/favorites"),
  },
  {
    /**
     * ★ 2026-11-07（跨境交通 · 需求 4）：第 3 个 tab「跨境交通」。
     * 插在「收藏」与「帮助」之间 —— 数组顺序即视觉顺序（设计稿 §7.5）。
     * · 图标：`crossBorderIcon` → 选中切 `crossBorderFilledIcon`（同库 3.47.0 的
     *   `IconWorld` / `IconWorldFilled`），保留本组件「选中切实心」的第二通道；
     * · 样式零改动：`.bottom-nav__tab` 已是 `flex: 1` ⇒ 三个变四个自动等分
     *   （我一度想补 `.bottom-nav__icon { display: grid }`，那会压掉既有 `inline-flex`
     *    并让收藏红点位移，已放弃 —— 见 globals.css 本批分区里的说明）；
     * · `match` 用 `startsWith`：`/cross-border/[station]` 是本站的子路由，必须一起高亮。
     */
    key: "crossBorder",
    href: "/cross-border",
    label: "跨境交通",
    icon: "crossBorderIcon",
    iconOn: "crossBorderFilledIcon",
    match: (p) => p.startsWith("/cross-border"),
  },
  {
    // ★ v2.10.0：第 3 个 tab「帮助」（`/help`；旧 `/about` 已 308 重定向到此）
    // ★ v3.3.0（AC-109）：图标由「问号圆圈」改「手册」—— 原 `help-circle` 的问号圆点是**零长度段**，
    //   在 `strokeLinecap="butt"` 下不渲染（用户反馈「怪怪的」）；`book/bookFilled` 是同库原生
    //   线性/实心对 ⇒ **恢复选中态「切实心」第二通道**（设计 §1.4 方案 A）。
    key: "help",
    href: "/help",
    label: "帮助",
    icon: "book",
    iconOn: "bookFilled",
    match: (p) => p.startsWith("/help") || p.startsWith("/about"),
  },
];

export default function BottomNav() {
  const pathname = usePathname();
  const favs = useCombos();
  const hasFav = favs.mounted && favs.combos.length > 0;

  return (
    <nav className="bottom-nav" aria-label="主导航">
      {TABS.map((t) => {
        const active = t.match(pathname);
        return (
          <Link
            key={t.key}
            href={t.href}
            className={`bottom-nav__tab${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <span className="bottom-nav__icon">
              <Icon name={active ? t.iconOn : t.icon} size={24} />
              {t.key === "favorites" && hasFav && <span className="bottom-nav__dot" aria-hidden="true" />}
            </span>
            <span className="bottom-nav__label">{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
