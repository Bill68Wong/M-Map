/**
 * 全站唯一图标出口（src/components/ui/Icon.tsx，M Map 改版 S6）
 *
 * ── 为什么自研包装（Spec §7 工程方案锁定）────────────────────────────
 *   全站**只从 `<Icon>` 出图标** —— 单一入口、单一风格真源：
 *     · 内部**固定** `stroke={2}` / `strokeLinecap="butt"` / `strokeLinejoin="miter"`
 *       （方向 A「站牌」= 2px 方头方角）；
 *     · `size` 限**联合类型** `16 | 20 | 24` 三档，**不得混用**（§8）；
 *     · 24 viewBox、`fill="none"`、`stroke="currentColor"`（随文字色）。
 *   风格不依赖「CSS 继承的偶然性」（另在 globals.css 加 `.mm-icon` 兜底）。
 *
 * ── 图标库 ────────────────────────────────────────────────────────────
 *   `@tabler/icons-react@3.47.0`（MIT · Spec §4 锁定）。**全项目不混用其它库**。
 *   ⚠️ 已源码核对：`createReactComponent` 把 `strokeLinecap/Join` 写在其默认属性里，
 *      再把调用方 `...rest` spread 在其后 ⇒ **props 覆盖生效**（双路径验证的第二条）。
 *
 * ⚠️ 纯展示（无 hooks / 事件）；标 `"use client"` 以兼容 Server Component 引用
 *    （`@tabler/icons-react` 内部用 `forwardRef`，标为客户端组件是 Next.js 的标准安全做法）。
 */
"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  IconArrowForwardUp,
  IconArrowRight,
  IconArrowsExchange,
  IconArrowsLeftRight,
  IconArrowsUpDown,
  IconBook,
  IconBookFilled,
  IconBookmark,
  IconBookmarkFilled,
  IconBus,
  IconBusStop,
  IconChartBar,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircle,
  IconCircleCheck,
  IconClipboardText,
  IconClock,
  IconCurrentLocation,
  IconDownload,
  /* ★ 2026-11-07（跨境交通）：港口分组 / 卡片 + 机场分组 / 卡片 —— Tabler 同库 3.47.0 */
  IconFerry,
  IconPlane,
  IconWorld,
  IconWorldFilled,
  IconGauge,
  IconHome,
  IconHomeFilled,
  IconListDetails,
  IconLock,
  IconMapPin,
  IconPlayerPlay,
  IconRefresh,
  IconRoute2,
  IconSearch,
  IconTrash,
  IconArrowBackUp,
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowUp,
  IconDots,
  IconFlag,
  IconGripVertical,
  IconPencil,
  IconPinned,
  IconPlus,
  IconTrain,
  IconWalk,
  IconX,
} from "@tabler/icons-react";

/** ★ 仅此三档，不得混用（§8） */
export type IconSize = 16 | 20 | 24;

/**
 * ★ v3.3.0（AC-109 · 设计师裁决「方案 B」）：**修正版线性 info**。
 *
 * 与 Tabler `IconInfoCircle` **逐字同几何**（外圈 + i 的竖笔 + i 的点），**唯一差异**：
 * 把 Tabler 的**零长度段**点（`M12 9h.01`）改为 `<circle r=1 fill="currentColor">`。
 *
 * 为什么不用 `strokeLinecap="round"` 修那条 path：本项目图标门禁
 * `.verify/audit-icon-dots.mjs` 的判据正是「**零长度段**」（butt cap 下不渲染 ⇒ 点丢失）。
 * 用 `<circle>` 实现圆点 ⇒ 该图标**天然零长度段 = 0**，门禁**无需为它开特例**（门禁强度不被削弱），
 * 视觉上与 Tabler 的 round-cap 圆点**完全一致**（半径 = strokeWidth / 2 = 1）。
 */
function IconInfoCircleLinear({
  size = 20,
  stroke = 2,
  className,
  ...rest
}: {
  size?: number;
  stroke?: number;
  className?: string;
  [k: string]: unknown;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      className={`mm-icon${className ? ` ${className}` : ""}`}
      {...rest}
    >
      <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" />
      <path d="M11 12h1v4h1" />
      <circle cx="12" cy="9" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 语义名 → 图标组件（唯一映射表；★ v3.3.0 起含 1 个项目内联件 `IconInfoCircleLinear`） */
const REGISTRY: Record<string, any> = {
  /* 导航 / 主流程 */
  search: IconSearch,
  locate: IconCurrentLocation,
  home: IconHome,
  homeFilled: IconHomeFilled,
  bookmark: IconBookmark,
  bookmarkFilled: IconBookmarkFilled,
  /* ★ v3.3.0（AC-109）：/help 底导图标 —— 由「问号圆圈」改「手册」（Tabler 同库线性/实心对，
     隐喻更贴切「使用指南 + 合规说明」；且**零长度段 = 0**）。 */
  book: IconBook,
  bookFilled: IconBookFilled,
  origin: IconCircle,
  destination: IconMapPin,
  pin: IconMapPin,
  swap: IconArrowsLeftRight,
  /* ★ v2.10.0（实时巴士）：换向（区别于 swap —— swap 语义是起终点互换） */
  exchange: IconArrowsExchange,
  /* 载具 / 步行 */
  walk: IconWalk,
  bus: IconBus,
  /** 轻轨（Tabler 3.47 无 Tram，用 Train —— 语义即「轨道交通」） */
  lrt: IconTrain,
  busStop: IconBusStop,
  /* 动作 / 状态 */
  back: IconChevronLeft,
  forward: IconChevronRight,
  close: IconX,
  check: IconCheck,
  arrive: IconCircleCheck,
  play: IconPlayerPlay,
  refresh: IconRefresh,
  skip: IconArrowForwardUp,
  arrowRight: IconArrowRight,
  caretDown: IconChevronDown,
  caretUp: IconChevronUp,
  expandVertical: IconArrowsUpDown,
  /* 数据 / 工具（旧版功能页）
     ★ v3.3.0（AC-109）：`records` 原用 `IconClipboardList` —— 其**项目符号 = 零长度段**（`l.01 0`），
        在 `strokeLinecap="butt"`（本项目固定）下不渲染 ⇒ 图标「缺项目符号」。改 `IconClipboardText`：
        同语义（清单/记录）、**无零长度段**（06 §1.11「改用无零长度段的等价图标」）。 */
  records: IconClipboardText,
  stats: IconChartBar,
  timer: IconClock,
  trash: IconTrash,
  lock: IconLock,
  download: IconDownload,
  /* ★ S3（08 §C.6 图标增补）：组合卡 / 编排编辑器用（Tabler 同库，stroke=2 方头方角不变） */
  add: IconPlus,
  edit: IconPencil,
  more: IconDots,
  dragHandle: IconGripVertical,
  pinTop: IconPinned,
  undo: IconArrowBackUp,
  /* ★ v2.10.0（实时巴士 + 帮助页）：车辆信息卡 / 帮助页 / FAQ 用（Tabler 同库，stroke=2 不变） */
  gauge: IconGauge,
  "route-2": IconRoute2,
  /* ★ v3.3.0（AC-109）· 零长度段根治（butt cap 下「点」不渲染）：
     · `help-circle`（帮助页分区图标）→ `IconBook`（与底导 help 语义统一；零长度段 0）
     · `info-circle`（到站横幅「i」· **安全级元素，图标须完整**）→ `IconInfoCircleLinear`
       （**项目内联 · 方案 B**：保持全站**线性**语汇，仅把零长度段的点改为 `<circle>` ⇒ 完整可见）
     · `list` → `IconListDetails`（原 `IconList` 的项目符号 = 零长度段 ×3）
     ⚠️ 除内联件外均为 Tabler **同库 3.47.0**（不混库），size/stroke 风格不变。 */
  "help-circle": IconBook,
  "info-circle": IconInfoCircleLinear,
  list: IconListDetails,
  /* ── ★ v3.6.0 S5（步行导航）：转向 / 到达 / 偏航 ────────────────────────
     · 转向四态与 `WalkTurn`（`lib/walk/walk-shared.ts`）一一对应 ——
       **不得**在组件里另用字符箭头（「←」「→」）代替，否则视觉与描边风格两端分裂；
     · `uturn` 复用 `undo`（IconArrowBackUp 的几何就是回转箭头）；
     · 全部 Tabler 3.47.0 同库、stroke=2 方头方角、**零长度段 = 0**（过 audit-icon-dots 门禁）。 */
  turnStraight: IconArrowUp,
  turnLeft: IconArrowLeft,
  turnRight: IconArrowRight,
  /** 到达旗（设计 §2.2 `walkArrive`） */
  walkArrive: IconFlag,
  /** 偏航警示（设计 §2.2 `alertTriangle`） */
  alertTriangle: IconAlertTriangle,
  /* ── ★ 2026-11-07（跨境交通 · 设计稿 05 §7.2 图标清单）───────────────────
     4 个语义名，全部 Tabler **同库 3.47.0**（不混库）、stroke=2 方头方角：
       · `crossBorderIcon` / `crossBorderFilledIcon`：底导第 4 个 tab（地球；实心变体 =
         选中态的第二通道，与 home/bookmark/book 的「切实心」惯例一致）；
       · `ferryIcon`：客运港口分组头 + 三张码头卡（內港 / 外港 / 氹仔 同形 ——
         设计稿 §7.2 明确「三码头靠 11px 地名标签区分，图形级区分在 16/20px 不可行」）；
       · `planeIcon`：机场分组头 + 机场卡 + 午夜空态。
     ⚠️ 设计稿**刻意不用** `IconPlaneDeparture`：它由「机身弧 + 跑道横线」两条路径组成，
        20px/2px 下整体读成船体，与 `IconFerry`（上舱 + 下横线）几乎同形（实测放大 4 倍
        仍无法区分）。同理不用 `IconMoonStars` / `IconAlertTriangle` 做空态（两者含
        **零长度段**，在 `strokeLinecap="butt"` 下点/收尾不渲染，见 `.verify/audit-icon-dots.mjs`）。
     ⚠️ 这 4 个名字若拼错，`Icon` 会**静默 `return null`**（不报错、只是没有图标）
        ⇒ 断言脚本 `scripts/check-xborder-ui.tsx` 逐名渲染并断言产出的 `<svg>` 非空。 */
  crossBorderIcon: IconWorld,
  crossBorderFilledIcon: IconWorldFilled,
  ferryIcon: IconFerry,
  planeIcon: IconPlane,
};

export type IconName = keyof typeof REGISTRY;

export interface IconProps {
  /** 语义名（见 REGISTRY；未知名 → 不渲染） */
  name: IconName | string;
  /** 尺寸（★ 仅 16 / 20 / 24） */
  size?: IconSize;
  className?: string;
  /** 无障碍名（给了则不再标 aria-hidden） */
  "aria-label"?: string;
  /** 其余原样透传到 `<svg>` */
  [key: string]: unknown;
}

export default function Icon({ name, size = 20, className, ...rest }: IconProps) {
  const Cmp = REGISTRY[name as string];
  if (!Cmp) return null;
  const labeled = !!rest["aria-label"];
  return (
    <Cmp
      size={size}
      stroke={2}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      className={`mm-icon${className ? ` ${className}` : ""}`}
      aria-hidden={labeled ? undefined : true}
      focusable={false}
      {...rest}
    />
  );
}
