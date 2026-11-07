"use client";

/**
 * 线路站序三档弹窗（src/components/nav/RouteStopsSheet.tsx，2026-11-06 · 问题 #5a）
 *
 * ── 为什么需要它（`00-负责人裁决.md` R3）──────────────────────────────────
 *   「澳门巴士线路、轻轨线路、通琴号班次，三者交互完全一致」⇒ **同一个组件**服务三族，
 *   不再跳 `/line/[code]` 独立页（该页保留为深链兜底，不删）。宿主（`NavShell`）把
 *   `kind` + 该线站序喂进来即可，**本组件不发任何请求**（数据获取留在宿主）。
 *
 * ── 结构（与 `LineStopsSheet` 同构，逐项对齐）────────────────────────────
 *   ```
 *   section.lst-sheet                              position:fixed（三档位移走 transform）
 *     ├ .lst-sheet__handle                         固定，不随内容滚；起拖区
 *     │   ├ .lst-sheet__grip
 *     │   └ .lst-sheet__head  [线号 chip] [方向/终点] [· 首班时刻]  [换向][刷新][关闭]
 *     ├ .lst-sheet__body                           唯一滚动容器
 *     │   └ <LineStopList>                         复用现有纵条（左 rail + 节点 + 站名 + 澳/琴）
 *     └ .lst-sheet__toast                          aria-disabled 键的原因提示（3s）
 *   ```
 *
 * ── 三档几何：**只复用，不自造常量** ─────────────────────────────────────
 *   `tqhDetentTopsPx(winH, safeTop, safeBottom)`：
 *   ```
 *   full = clamp(max(safeTop + 44, 12vh), 96, 128)
 *   half = 50vh
 *   peek = winH − (96 + safeBottom)      ← 可见 = 抓手带 24 + 行 44 + 呼吸 28 + 安全区
 *   ```
 *   ⚠️ peek **不能**用 `80vh`（导航口径，可见 20% ≈ 169px 放「摘要+指标」）：
 *      本站序弹窗的 peek 只放**顶部一行**，用 80vh 会拖出半屏空白。
 *   ⚠️ peek 可见 96px 里 handle 占约 66px（8+4+6+44+4）⇒ 余 30px 会露出**半行站点**。
 *      故 `detent === "peek"` 时给 `__body` 打 `visibility:hidden`（保留占位 ⇒ 无重排、
 *      无半行、且不可聚焦）。
 *      ★ 2026-11-06：该规则**已交 CSS**（`globals.css` 的
 *        `.lst-sheet[data-route-stops-kind][data-detent="peek"] .lst-sheet__body`），
 *        本文件**不再写内联 `visibility`**；`aria-hidden` 仍由 JSX 显式输出
 *        （`visibility` 虽不进 a11y 树，但显式声明才是可读的意图，不靠 CSS 副作用兜）。
 *
 * ── 顶部行（顺序锁死，逐项有理由）────────────────────────────────────────
 *   `[线号] 方向/终点 · 首班时刻   [换向][刷新][关闭]`
 *   · **线号**：白字 + 线路主题色底（R6 裁决：**一律白字**，禁止自适应墨色；底色保持官方色
 *     不加深）。复用 `.lst-sheet__no`（13px·700 + `text-shadow`，与通琴号同一视觉语汇，
 *     **不自创第二套 chip 形态** —— R5：图标视觉定稿前任何人不得自改）。
 *     底色经 CSS 变量 `--lst-no-bg` 注入（**不锁死 `background`**：以后想加渐变/暗色补偿
 *     只改 CSS）；字色恒由 `.lst-sheet__no` 的 `var(--tqh-on)` = 白（R6）。
 *   · **时刻**：11px / `flex:none` / `tabular-nums` / **永不被省略** —— 它是「这是哪一班 /
 *     哪个时刻表」的判别位。⚠️ 它必须是**独立 flex 项**，不能嵌在方向 `span` 里，
 *     否则 `flex:none` 不生效、会被父级 ellipsis 一起截掉（通琴号踩过的坑）。
 *   · **方向**：`flex:0 1 auto` + `min-width:0`（可让位，正常不触发）。
 *   · **三键**：视觉 34×34 + 命中 44×44（子 span `inset:-5px`，真实盒子 ⇒ 可被断言量到，
 *     比 `::after` 更利于自动化）。间距 10（= 5+5）⇒ 相邻命中区**刚好相接不重叠**。
 *   · **关闭键位置恒定**：换向 / 刷新**永不隐藏**（无对向 / 无刷新时用 `aria-disabled` +
 *     点击出 toast）—— 隐藏会让关闭键左移，是"点不到关闭"的经典复发路径。
 *
 * ── ★ 2026-11-06（#6）：纵条四态巴士图标 + 巴士信息卡（本轮新增）────────
 *   · 取数：`useRouteVehiclesSheet`（**只在弹窗打开/点刷新时各取一帧**，无轮询；
 *     轻轨与通琴号**零请求**；`cache:"no-store"`；串行 ≤2 请求）；
 *   · 四态映射：`stops-veh-marks.ts`（判据 / 优先级 / `frac` 降级都写在那个文件头）；
 *   · 数据不到位（无车 / 请求失败 / 判不出方向 / 站码对不上）⇒ `vehOf` 返回 `null`
 *     ⇒ **一行图标都不出现**（绝不放占位图标，那是伪造实时的最坏形态）；
 *   · ⚠️ 2026-11-07 修复：**环线首末同站**（同一主码在站序里出现两次）⇒ 图标只画在
 *     「该主码首次出现」那一行（`stops-veh-marks.ts#gateRows`），末行不重复画；
 *     同时 `data-veh-count` 改成**实际画出的图标数**（原为唯一主码数，环线时会少 1）。
 *   · 点图标 ⇒ `.nav-card-overlay`（fixed z90 > 本弹窗 z77）里的 `<VehicleCard>`：
 *     车牌 / 运营商 / 状态 / 到终点还有几站；点卡片外或 Esc 关闭；打开时把该行
 *     `scrollIntoView({ block: "center" })` ⇒ 不被底部卡片压住。
 *
 * ── 本轮仍**不做**（第二阶段）──────────────────────────────────────────
 *   · 实时报站：`etaOf` 恒 `idle`（DOM 输出 `data-eta="idle"`，不渲染「—」、零请求）；
 *   · 换向的真实逻辑（只渲染按钮；`onFlipDirection` 为 null ⇒ `aria-disabled` + toast）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Icon from "@/components/ui/Icon";
import LineStopList from "@/components/line/LineStopList";
import type { EtaState } from "@/components/line/useLazyEta";
import { mainOf, type LineStop } from "@/lib/line/line-shared";
import { lineNameOf } from "@/lib/route-label";
import VehicleCard from "./VehicleCard";
import { companyLabel, normalizeCompany } from "./VehicleMarker";
import { buildVehMarks, gateRows, type VehMark } from "./stops-veh-marks";
import { useRouteVehiclesSheet } from "./useRouteVehiclesSheet";
import { COOLDOWN_TQH_SEC, COOLDOWN_VEHICLE_SEC, useCooldown } from "./useCooldown";
import { useSnapSheet } from "./useSnapSheet";
import {
  DETENTS,
  detentIndex,
  readSafeBottomPx,
  readSafeTopPx,
  tqhDetentTopsPx,
  type Detent,
} from "./sheet-detents";

/** 线路族：澳门巴士 / 轻轨 / 通琴号（R3：三者共用本弹窗） */
export type RouteStopsKind = "bus" | "lrt" | "tqh";

/** 站序一行（**宿主给**，组件不自己取数） */
export interface RouteStopsStop {
  /** 站台码（如 `M95/3`）；通琴号用站 id 的字符串 */
  code: string;
  /** 站名（繁体原文，不做简繁转换） */
  name: string;
  /** 通琴号属地小标签；其余族传 null / 不传 ⇒ 不渲染（DOM 与既有线一致） */
  side?: "澳门" | "横琴" | null;
  /** 可选：服务端站序（缺省按数组下标 +1） */
  seq?: number;
  /** 可选：GCJ-02 坐标（第二阶段「点站定位」用；本轮不消费） */
  lat?: number | null;
  lng?: number | null;
}

export interface RouteStopsSheetProps {
  /** 面板是否打开（关闭态仍渲染 —— 收起过渡需要元素在位 ⇒ 由 `useSnapSheet` 推出视口） */
  open: boolean;
  kind: RouteStopsKind;
  /**
   * 线路码：`bus` = `26` / `25AX` / `N3`（**纯数字字母，禁「路」**）；
   * `lrt` = `LRT-氹仔線`（`LRT-` 前缀会被剥掉，R7 用官方繁体线名）；
   * `tqh` = 通琴号标号 `B6`。
   */
  lineCode: string;
  /** 方向或终点名（顶部行第二项，如 `往 筷子基` / `往横琴`） */
  directionLabel: string;
  /** 首班时刻（`HH:MM`）；无则 null ⇒ 该项不渲染 */
  firstTime: string | null;
  /** 站序（宿主按线路 + 方向取好再传） */
  stops: RouteStopsStop[];
  /** 当前档（受控 —— 宿主持有，切线路时可重置） */
  detent: Detent;
  onDetentChange: (d: Detent) => void;
  onClose: () => void;
  /** 刷新；**不传 ⇒ 刷新键 `aria-disabled` + 点击 toast**（不给死键，也不隐藏） */
  onRefresh?: () => void;
  /** 换向；**null ⇒ 无对向方向** ⇒ `aria-disabled` + 点击 toast（不是原生 disabled：需可聚焦可点） */
  onFlipDirection?: (() => void) | null;
  /**
   * 线路主题色（`routes.color`）。缺省回落 `var(--primary)`（与 `RouteStack` 同口径）。
   * ⚠️ 只改**底色**，字色恒白（R6）；底色**不加深、不降饱和**。
   */
  color?: string | null;
  /**
   * 视口几何。**宿主给**（`NavShell` 已为其它面板读过安全区，避免重复探针）；
   * 全不传则本组件自量（含 resize / 转屏重算）—— 保证可独立挂载与单测。
   */
  winH?: number;
  safeTop?: number;
  safeBottom?: number;
  /**
   * ★ 2026-11-06（#6）：本方向 `dsat_dir`（`0` / `1`）。
   *
   * `/api/route-vehicles` **必填** `dir`（缺省 400），而本组件原本完全没有方向概念 ⇒
   *   · 宿主传了（推荐：`dir={rv.picked?.dir ?? null}`）⇒ **零额外请求**；
   *   · 宿主没传（当前 `NavShell` 即如此）⇒ 本组件内部读 `/api/route-shapes` 判方向
   *     （见 `useRouteVehiclesSheet.ts` 文件头「方向从哪来」），多半命中浏览器缓存。
   *   · 判不出 ⇒ 不取车辆、不画图标（**绝不猜方向**：猜错=把另一方向的车画到这张站表上）。
   * ⚠️ 纯可选新增，不传的行为与「没有实时车辆」等价 ⇒ 既有调用方零改动可编译。
   */
  dir?: string | null;
}

/**
 * toast 停留时长（= `--toast-dur`）
 *
 * ⚠️ 三键的尺寸/命中区/间距**已全部交给 CSS**（2026-11-06 前端 A 落地）：
 *   · 视觉 34×34 → `.lst-sheet__iconbtn--sm`
 *   · 命中 44×44 → `.lst-sheet__iconbtn__hit`（子元素，非 `::after`：可被 `getBoundingClientRect()` 量到）
 *   · 间距 10     → `.lst-sheet[data-route-stops-kind] .lst-sheet__acts { gap:10px }`
 *   本文件因此**不再有 `BTN_VISUAL` / `HIT_INSET` / `ACT_GAP` 常量**，避免"内联压过类"
 *   导致 CSS 变死规则。数值依据保留在这里作口径说明（不参与计算，故不触发 unused 告警）：
 *   34 + 5×2 = 44（WCAG 2.5.5）；gap 10 = 5×2 ⇒ 相邻命中区**刚好相接、不重叠**
 *   （若 gap < 10 会重叠，边缘落点会命中错误的键 —— 这是间距取 10 而不是 8 的唯一理由）。
 */
const TOAST_MS = 3000;

/**
 * ★ 2026-11-06（负责人裁决）：本面板 z-index = **77**，比 `.lst-sheet` 的 76 高 1 档。
 *
 * ※ **这是迁移期临时值，不是永久层级**（负责人 2026-11-06 明确要求写死这句话）。
 *    存在理由只有一个：`LineStopsSheet`（通琴号，76）**已在线上且正被 `NavShell` 引用**，
 *    此刻把它降档会撞前端 B 的接入工作 ⇒ 让新建的让路。
 *    **P1 把通琴号改成 `kind="tqh"` 薄壳（两份 shell 合一）之后，两者应统一到同一个
 *    z-index，并删掉本常量**（届时本组件就是唯一站序弹窗，77 立刻退化为没人敢动的魔数）。
 *
 * 为什么不能与通琴号同处 76：
 *   `RouteStopsSheet`（澳门巴士 / 轻轨）与 `LineStopsSheet`（通琴号）**根类相同**
 *   （都吃 `.lst-sheet`，定位 `fixed` 且全屏 100dvh）⇒ 若同处 76，层叠顺序退化为
 *   **DOM 挂载先后**：两者若因宿主状态重叠而同时打开，后挂的盖住前者，但前者**仍然
 *   占着满屏 100dvh 的命中区**（透明部分也吃 pointer 事件），表现为「看见 A 却点不到 A」。
 *   暂给 77 ⇒ **行为确定**：谁后开谁在上，且不依赖两个组件在 `NavShell` 里的 JSX 顺序
 *   （那份顺序会随重构变动，把正确性押在它上面是脆的）。
 *
 * 为什么不反向「让 `LineStopsSheet` 降到 75」：
 *   它是**已在线上、正在被前端 B 引用**的通琴号弹窗；让新建的让路，比改已在线的安全。
 *
 * ⚠️ 不是「互斥挂载」的替代品：同一时刻仍**只应打开一个**（互斥判定归 `NavShell`）。
 *   77 只保证「万一两个都在，行为可预测」，不保证「两个都在也正确」。
 * ⚠️ 合法区间 = **(76, 90)**：不得越过 90（车卡 / 站卡浮层必须能盖住站序弹窗）或
 *   退到 70 以下（路线选择弹窗必须先选完才开它）。
 *
 * ★ 核对口径（2026-11-06 复核，避免下一个人被 CSS 里的数字带偏）────────────
 *   `globals.css` 的 `.lst-sheet { z-index: 76 }` 是**基础类的值，不是本组件的生效值**。
 *   本组件把 77 通过**内联** `zIndex` 写在 `<section>` 上（见下方 return 里的 `style`），
 *   内联特异性高于任何类选择器 ⇒ **本弹窗实际 = 77**。
 *   「CSS 是 76 ⇒ 说明已经和通琴号统一了」是**错的推论**：两者仍差 1 档，
 *   只是因为宿主互斥（同一时刻只开一个），这 1 档平时观察不到。
 */
const SHEET_Z_INDEX = 77;
/* ↑ P1 待删：通琴号改为 `kind="tqh"` 薄壳后，本常量应删除、层级交回 `.lst-sheet`。
   刻意保留成具名常量（而非裸 77）就是为了让 `grep SHEET_Z_INDEX` 一次找齐收口点。 */

/** 无对向方向时的原因文案（按族区分 —— 用户看到的是"为什么点不动"，不是"错误"） */
const FLIP_DISABLED_TEXT: Record<RouteStopsKind, string> = {
  bus: "这条线暂无对向方向",
  lrt: "这条线暂无对向班次",
  tqh: "本班次仅单向运行",
};

/** 本轮无报站 ⇒ 恒 `idle`（`LineStopRow` 对 idle 渲染空白，不画「—」、不画骨架） */
const etaIdle = (): EtaState => ({ phase: "idle", text: null });
/**
 * 空图标表（稳定引用）：
 * 轻轨 / 通琴号 / 无车 ⇒ 恒用这一份 ⇒ `vehOf` 恒 `null` ⇒ **一行图标都不渲染**
 * （`LineStopRow` 的「不传 `veh` ⇒ 零 DOM 变化」契约在 `LineStopList` 层同样成立）。
 */
const EMPTY_MARKS: ReadonlyMap<string, VehMark> = new Map();

export default function RouteStopsSheet({
  open,
  kind,
  lineCode,
  directionLabel,
  firstTime,
  stops,
  detent,
  onDetentChange,
  onClose,
  onRefresh,
  onFlipDirection,
  color,
  winH,
  safeTop,
  safeBottom,
  dir = null,
}: RouteStopsSheetProps) {
  const sheetRef = useRef<HTMLElement | null>(null);

  /* ── 几何：宿主给了就用宿主的；没给就自量（挂载 + resize + 转屏）────────── */
  const [autoGeo, setAutoGeo] = useState({ h: 0, top: 0, bottom: 0 });
  const needGeo = winH == null || safeTop == null || safeBottom == null;
  useEffect(() => {
    if (!needGeo) return;
    const read = () => {
      setAutoGeo({
        h: typeof window === "undefined" ? 0 : window.innerHeight,
        top: readSafeTopPx(),
        bottom: readSafeBottomPx(),
      });
    };
    read();
    window.addEventListener("resize", read);
    window.addEventListener("orientationchange", read);
    return () => {
      window.removeEventListener("resize", read);
      window.removeEventListener("orientationchange", read);
    };
  }, [needGeo]);

  const vh = winH ?? autoGeo.h;
  const vTop = safeTop ?? autoGeo.top;
  const vBottom = safeBottom ?? autoGeo.bottom;
  /** ★ 唯一几何计算点（`sheet-detents.ts`）—— 本文件不出现任何档位像素常量 */
  const topsPx = useMemo(() => tqhDetentTopsPx(vh, vTop, vBottom), [vh, vTop, vBottom]);

  /**
   * 当前档位顶边（**落定值**）→ 内联 `--lst-top`，由 CSS 把 `.lst-sheet__body` 夹到
   * 「档位顶边 → 视口底」这一段**真实可见**的高度（见 `globals.css` 的同名变量说明）。
   *
   * ── 为什么必须有它（2026-11-07 · P1 滚动缺陷的根因）────────────────────────
   *   `.lst-sheet` 是 `top:0 + height:100dvh`，靠 `translateY(档位顶边)` 下移 ⇒ 盒子
   *   在 half 档实际占 **422 → 1266**（下边界溢出屏幕 422px），而 `__body` 是 `flex:1`
   *   ⇒ 它以为自己高 778px，屏幕却只看得到 356px。两个后果：
   *     ① `scrollIntoView({block:"center"})` 把行居中到**容器中心 ≈ 877**（屏外）；
   *     ② **滚动到底也够不到最后 422px 的内容**（永远看不见最后几行）。
   *   把顶边喂给 CSS 后 `max-height: calc(100dvh - var(--lst-top) - var(--lst-head-h))`
   *   ⇒ body 底边正好落在视口底（844），①②同时消失。
   *
   * ⚠️ **只写落定值**：不要改成跟随 `--sheet-y-anim`（拖动期每帧变）——那样每帧都要重算
   *    `max-height` ⇒ 整棵列表每帧重排，正是本项目 2026-09-25 修过的「拖弹窗地图抖」。
   *   拖动期的视觉补偿走 CSS 的 `[data-dragging="on"]` 分支（见 globals.css）。
   */
  const topPx = Math.round(topsPx[detentIndex(detent)] ?? 0);

  /**
   * 头部（抓手 + 顶行）**实测**高度 → `--lst-head-h`。
   * 缺省 66px 只作兜底（8 padding + 4 grip + 6 margin + 44 head + 4 padding，与今天实测一致）；
   * 量一次的意义：日后头部多一行（如首班时刻在 320px 宽下换行）时，body 的夹取会**自动跟随**；
   * 写死 66 会**静默**把 body 顶出屏幕底 —— 本轮的缺陷原样复发且无任何报错。
   */
  const handleRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sheetRef.current;
    const h = handleRef.current;
    if (!el || !h) return;
    const write = () => el.style.setProperty("--lst-head-h", `${Math.round(h.offsetHeight)}px`);
    write();
    if (typeof ResizeObserver === "undefined") return; // 老浏览器：留一次实测值已够（不变形）
    const ro = new ResizeObserver(write);
    ro.observe(h);
    return () => ro.disconnect();
  }, []);

  const snap = useSnapSheet({
    open,
    detent,
    topsPx,
    onDetentChange,
    onDismiss: onClose,
    dismissible: true,
    sheetRef,
  });

  /* ── 刷新冷却：通琴号是静态时刻表（3s 防连点）；巴士/轻轨打实时接口（车辆级 5s）── */
  const { sec: cdSec, cooling, start: cdStart, reset: cdReset, remainingSec } = useCooldown(
    kind === "tqh" ? COOLDOWN_TQH_SEC : COOLDOWN_VEHICLE_SEC,
  );
  /** 换线路 / 换族 ⇒ 上一轮的冷却不该带过来（`reset` 是稳定引用，不会自激） */
  useEffect(() => {
    cdReset();
  }, [lineCode, kind, cdReset]);

  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(""), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [toast]);

  /**
   * 换线路 / 重开面板 ⇒ 清上一轮的 toast 与滚动位置。
   * 不清滚动位置的话，从 26 路（滚到第 30 站）切到 2 路（共 12 站）会直接停在半空。
   */
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setToast("");
    if (open && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [open, lineCode, kind]);

  /* ══ ★ 2026-11-06（#6）：纵条四态巴士图标 + 巴士信息卡 ═══════════════════════
     数据链：`useRouteVehiclesSheet`（一帧真实在途车）
        → `buildVehMarks`（四态 + frac + 一行一图标的取舍，纯函数）
        → `LineStopList.vehOf`（本组件只做查表）
        → `LineStopRow.veh`（渲染层，四态外观与 `--veh-frac` 夹取都在那边）
     没有车 / 请求失败 / 判不出方向 ⇒ 查表返回 `null` ⇒ **一行图标都不画**。
     ═══════════════════════════════════════════════════════════════════════════ */
  /* ── 站序 → `LineStop[]`（复用 `LineStopList` / `LineStopRow`，零改动）────
     ⚠️ 在 `stopMains` / `gateRows` **之前**：行级闸门的键就是这里产出的 `seq`
        ⇒ 「图标画在哪一行」与「这一行怎么渲染」**同源**（改口径只需改这一处）。 */
  const lineKind = kind === "lrt" ? ("lrt" as const) : ("bus" as const);
  const rows: LineStop[] = useMemo(
    () =>
      stops.map((s, i) => ({
        seq: s.seq ?? i + 1,
        code: s.code,
        name: s.name,
        kind: lineKind,
        lat: s.lat ?? null,
        lng: s.lng ?? null,
        mileM: null, // 无里程投影 ⇒ 不参与任何计算（第二阶段插值前须先跑里程任务）
      })),
    [stops, lineKind],
  );

  /** 本方向站序的**主码**序列（图标挂行 / 方向判定 / 「还有几站」的唯一口径） */
  const stopMains = useMemo(() => stops.map((s) => mainOf(s.code)), [stops]);

  const {
    vehicles: liveVehicles,
    fetchedAt: vehFetchedAt,
    error: vehError,
    usedDir: vehDir,
    reload: reloadVeh,
  } = useRouteVehiclesSheet({ open, kind, lineCode, dir, stopMains });

  const vehMarks = useMemo(
    () => (kind === "bus" ? buildVehMarks(stopMains, liveVehicles) : EMPTY_MARKS),
    [kind, stopMains, liveVehicles],
  );

  /**
   * ★ 行级图标闸门（`gateRows`）：环线首末同站 ⇒ 同一辆车只画在**首次出现**的那一行。
   *
   * ── 为什么 `vehMarks` 之外还要这一层（2026-11-07 修复的真实 bug）───────────
   *   `vehMarks` 的键是**主码** ⇒ 一站一份（`buildVehMarks` 的多车策略保证）。
   *   但渲染是按**行**（`stop.code` = 站台码）来的 ⇒ 直接用 `vehMarks.get(main)` 查表，
   *   **同一个主码出现在几行，就在几行各画一个图标**。
   *   **环线**（如 26 路）首末同站，站序里同一站出现两次（`load-route-stops.ts` 文件头
   *   明写「环线首尾同站出现两次」）⇒ 首末两行主码相同 ⇒ 同一辆车被画两个图标。
   *   实测症状：`data-veh-count=4`（唯一主码数）而 `.lp-stop__veh` 元素 = 5。
   *   ⚠️ 纯静默错误：不报错、不空屏，只是同一台车在图上出现两次 ⇒ 用户误读成
   *      「有两辆车在首站待发」。比不显示更坏。
   *
   * ── 修法与口径 ─────────────────────────────────────────────────────────
   *   只给**首次出现**那行画（环线 = 首行/出发端）；末行（绕回来的同一节点）不重复画，
   *   与 `LineStopList` 首末站都实心的口径不冲突（那是节点视觉，这是车辆数据）。
   *   判据与脏数据防线（重复 `seq` 丢弃、`code` 二次核对）都在 `gateRows` 里，
   *   本文件只查表 ⇒ 渲染路径与 `LineStopList` 的 `vehOf(stop)` 一一对应。
   */
  const rowMarks = useMemo(() => gateRows(rows, vehMarks), [rows, vehMarks]);

  const vehOf = useCallback(
    (stop: LineStop) => {
      const entry = rowMarks.get(stop.seq);
      // `code` 核对：`seq` 若撞车（脏数据）也不能把 A 行的图标画到 B 行上（错位 = 静默错版）
      return entry && entry.code === stop.code ? entry.mark : null;
    },
    [rowMarks],
  );

  /**
   * **实际画出的图标数**（= DOM 里 `.lp-stop__veh` 的元素数）。
   * ⚠️ 不要改回 `vehMarks.size`：那是**唯一主码数**，环线首末同站时会比真实图标数少 1
   *    ⇒ QA 的「`data-veh-count` 与元素数不符」会原样复发（那个数量不符正是本轮的 bug 症状）。
   *    本值遍历的就是 `vehOf` 的同一张表 ⇒ **口径同源，不可能再漂**。
   */
  const drawnCount = useMemo(() => {
    let n = 0;
    for (const e of rowMarks.values()) if (e.mark) n += 1;
    return n;
  }, [rowMarks]);

  /**
   * 观测钩子 `data-veh-src`（给 QA / 自动化用，**不是**用户可见状态）：
   *   `off`      轻轨 / 通琴号 —— 无实时车辆源，零请求
   *   `failed`   请求失败 ⇒ 不画图标
   *   `live`     **实际画出了图标**（`data-veh-count` = 图标个数 = DOM 里 `.lp-stop__veh` 的个数）
   *   `unplaced` 拿到了车但一辆都落不到本线站序（方向判错 / 站码口径不一致）—— 排查用
   *   `none`     接口正常但当前无在途车（DSAT 深夜常见）
   * ⚠️ `live` 的判据用 `drawnCount`（实际画出的个数）而不是 `vehMarks.size`（唯一主码数）：
   *    两者在环线首末同站这种"有 mark 但一行都不画"的极端情形下会分叉，
   *    那时声称 `live` 却没有图标，QA 无法判断是"没车"还是"画不出来"。
   */
  const vehSrc =
    kind !== "bus"
      ? "off"
      : vehError
        ? "failed"
        : drawnCount > 0
          ? "live"
          : liveVehicles.length > 0
            ? "unplaced"
            : "none";

  /** 行元素登记表（`scrollIntoView` 要真 DOM；`LineStopRow.registerEl` 的签名不变） */
  const rowEls = useRef(new Map<string, HTMLElement>());
  const registerRowEl = useCallback((code: string, el: HTMLElement | null) => {
    if (el) rowEls.current.set(code, el);
    else rowEls.current.delete(code);
  }, []);

  /** 当前打开的巴士信息卡（`null` = 不显示） */
  const [busCard, setBusCard] = useState<VehMark | null>(null);
  const busCardRef = useRef<HTMLDivElement | null>(null);
  /** 这张卡片是从**哪一行**的图标打开的（滚动的目标行 = 用户刚点的行，不是"卡片中心"） */
  const cardRowCode = useRef<string | null>(null);

  /** 换线 / 换族 / 关窗 ⇒ 一定关卡片（否则上一条线的车信息会留在新站表上） */
  useEffect(() => {
    setBusCard(null);
  }, [lineCode, kind, open]);

  const openBusCard = useCallback(
    (stop: LineStop) => {
      const mark = vehMarks.get(mainOf(stop.code));
      if (!mark) return;
      /** 再点同一个图标 = 收起（按车牌判定：刷新后对象会换新，但仍是同一台车） */
      if (busCard && busCard.vehicle.plate === mark.vehicle.plate) {
        setBusCard(null);
        return;
      }
      cardRowCode.current = stop.code;
      setBusCard(mark);
    },
    [vehMarks, busCard],
  );

  /**
   * 卡片挂载后做两件事，**顺序不能反**（2026-11-07 · P1 修复）：
   *
   *   ① 量卡片**遮挡带**（卡片顶边 → 视口底）→ 写 `--lst-card-h`。CSS 拿它做 body 的
   *      `padding-bottom` 与 `scroll-padding-bottom`：
   *        · `padding-bottom` 让**列表最后几行也滚得到卡片上沿之上**（没有这段留白，
   *          最后几行永远贴在容器底 844，正好被卡片 626~836 盖住 ⇒ 验收判据做不到）；
   *        · `scroll-padding-bottom` 让 `scrollIntoView` 的「可视区」缩到卡片上沿为止
   *          —— 否则 `block:"center"` 会把行居中到**滚动容器几何中心 ≈ 666**，
   *          而卡片顶边在 626 ⇒ 行仍然落在卡片里（只修容器高度是**不够**的）。
   *      量的是「视口底 − 卡片顶边」而不是 `offsetHeight`：卡片自身还带着距底内距
   *      （`bottom: calc(--space-2 + --safe-bottom)`），只量高度会**少算那一段**，
   *      最后一行就正好卡在卡片上沿、余量为 0。
   *   ② 再滚行（`block:"center"` 在新的可视区里居中 ⇒ 行落在卡片上方）。
   *
   * ⚠️⚠️ **不能量 `getBoundingClientRect().top`**（2026-11-07 真机实测修正，别再改回去）：
   *   卡片入场有 `fade-up`（`translateY(8px) → 0`），本 effect 在**动画第一帧**就跑，
   *   此刻 top 比最终位置**低 8px** ⇒ 遮挡带少算 8px。而 CSS 的 `padding-bottom` 里另有
   *   `+ var(--space-2)`(8px)，两个 8px 恰好相互抵消 —— 表面上只差 0.05px（亚像素），
   *   实际是**两处错误互相掩盖**：谁把 `--space-2` 调成别的值，末行立刻被压住。
   *   ⇒ 改为量 `rect.height`（`transform: translateY` **不改变 height**，与动画无关）
   *   + `Math.ceil`（rect 高度带小数：210.05 若取整成 210，末行与卡片相切时报 `overlapPx > 0`）。
   *   两者合起来 ⇒ `--lst-card-h` = 卡片高度向上取整；CSS 再加 `space-2 + safe` 恰等于遮挡带。
   * 卡片关闭 ⇒ 变量归 0 ⇒ 留白/滚动内距同时复原（不留永久空白）。
   */
  useEffect(() => {
    const sheet = sheetRef.current;
    const card = busCardRef.current;
    /**
     * 遮挡带 = `safe-bottom + 卡片高度 + space-2`（= 滚动容器可见底边 → 卡片顶边）。
     * ⚠️ 不用 `window.innerHeight`：iOS 折叠工具栏时 innerHeight 与视觉视口会差几十像素，
     *    差在「少数」方向就会让最后一行重新被压住。卡片底边是 `fixed` 定位在
     *    `calc(--space-2 + --safe-bottom)`，所以「高度」就能完整推出遮挡带。
     * ⚠️ 不用 `rect.top`：会把 8px 入场动画偏移算进去（见上方长注释）。
     * ⚠️ 不用 `offsetHeight`：它把 210.05 取整成 210，留下 0.05px 缺口
     *    （末行与卡片相切时 `overlapPx > 0`）。`rect.height` + `Math.ceil` 才是「宁可多留 1px」。
     */
    const cardH = card ? Math.ceil(card.getBoundingClientRect().height) : 0;
    sheet?.style.setProperty("--lst-card-h", `${Math.max(0, cardH)}px`);
    if (!busCard) return;

    const el = cardRowCode.current ? rowEls.current.get(cardRowCode.current) : null;
    if (!el || typeof el.scrollIntoView !== "function") return;
    const reduce =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }, [busCard]);

  /**
   * 点卡片外 / 按 Esc ⇒ 关卡片。
   * ⚠️ 用**冒泡阶段的 `click`** 而不是 `pointerdown`：`LineStopRow` 的图标 `onClick`
   *    已 `stopPropagation()` ⇒ 图标点击不会冒到这里 ⇒ 不会出现「刚打开就被自己的
   *    打开手势关掉」；而点列表空白处 / 顶部三键仍会冒上来 ⇒ 正常关闭。
   */
  useEffect(() => {
    if (!busCard) return;
    const onDocClick = (e: MouseEvent) => {
      if (!busCardRef.current?.contains(e.target as Node)) setBusCard(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBusCard(null);
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [busCard]);

  /** 「到终点」文案：只有本组件持有全长站序 ⇒ 算在这里，`VehicleCard` 只负责渲染 */
  const endName = stops.length ? stops[stops.length - 1].name : "";
  const busCardEndText = !busCard
    ? null
    : busCard.toEndStops <= 0
      ? `已到终点${endName ? `（${endName}）` : ""}`
      : `还有 ${busCard.toEndStops} 站${endName ? `到 ${endName}` : ""}`;

  /* ── 顶部行三键（永不隐藏；不能用的键 = `aria-disabled` + toast）───────── */
  const onFlip = useCallback(() => {
    if (!onFlipDirection) {
      setToast(FLIP_DISABLED_TEXT[kind]);
      return;
    }
    onFlipDirection();
  }, [onFlipDirection, kind]);

  const onRefreshClick = useCallback(() => {
    if (!onRefresh) {
      setToast("当前线路暂不支持刷新");
      return;
    }
    // 事件回调里读时间戳（页面隐藏时 250ms 计时器被节流，`cooling` 会停在旧值）
    if (remainingSec() > 0) return;
    cdStart();
    onRefresh();
    /**
     * ★ #6：本弹窗有**自己的**车辆帧（与地图层那一份互不干扰，见 hook 文件头）⇒
     * 刷新必须同时重取，否则「点刷新只有地图上的车变了、纵条图标不动」。
     * 轻轨不取（`kind !== "bus"` ⇒ hook 内部也是空转，这里省一次无意义的重渲染）。
     */
    if (kind === "bus") reloadVeh();
  }, [onRefresh, remainingSec, cdStart, reloadVeh, kind]);

  /* ── 「澳 / 琴」小标签的查表口径（`LineStopRow` 只吃 `sideOf(stop)`） */
  const sideByCode = useMemo(() => {
    const m = new Map<string, "澳门" | "横琴">();
    for (const s of stops) if (s.side) m.set(s.code, s.side);
    return m;
  }, [stops]);
  const sideOf = useCallback((stop: LineStop) => sideByCode.get(stop.code), [sideByCode]);

  /** 空数组稳定引用（避免每次渲染新建 Map ⇒ 换乘列重算） */
  const noLines = useMemo(() => new Map<string, string[]>(), []);

  /** 线号文案：轻轨剥 `LRT-` 且转官方繁体（R7）、巴士原样（禁「路」）、通琴号标号原样 */
  const chipText = lineNameOf(lineCode) || lineCode;
  const chipBg = color || "var(--primary)";
  /** peek 只见顶部一行 ⇒ 内容区隐藏（保留占位，不产生重排、不可聚焦） */
  const bodyHidden = detent === "peek";

  return (
    <>
      <section
        ref={(el) => {
          sheetRef.current = el;
        }}
        className="lst-sheet"
      data-detent={detent}
      data-open={open ? "on" : "off"}
      data-dragging={snap.dragging ? "on" : "off"}
      /* ── 观测钩子（自动化断言用，名称固定）── */
      data-route-stops-kind={kind}
      data-line-code={lineCode}
      data-peek-body={bodyHidden ? "hidden" : "shown"}
      /* ★ #6：纵条图标的**数据状态**（`off|failed|live|unplaced|none`，语义见 `vehSrc`）
         + 图标个数（= 实际画出的 `.lp-stop__veh` 个数，环线首末同站不重复计）+ 本次取数方向 */
      data-veh-src={vehSrc}
      data-veh-count={String(drawnCount)}
      data-veh-dir={vehDir ?? ""}
      aria-hidden={!open}
      inert={!open ? true : undefined}
      aria-label={`${chipText} ${directionLabel} 站序`}
      /* z-index 由内联给（见文件头 `SHEET_Z_INDEX` 的长注释）—— 不改 globals.css 的
         `.lst-sheet{z-index:76}`，因为那份属于通琴号弹窗（前端 A 的 CSS 域） */
      style={
        {
          /* 当前档位顶边（落定值）—— CSS 用它把滚动容器夹到真实可见高度，见 `topPx` 的长注释 */
          "--lst-top": `${topPx}px`,
          "--sheet-y-anim": `${Math.round(snap.translateY)}px`,
          zIndex: SHEET_Z_INDEX,
        } as CSSProperties
      }
    >
      <div
        ref={handleRef}
        className="lst-sheet__handle"
        onPointerDown={snap.onPointerDown}
        onPointerMove={snap.onPointerMove}
        onPointerUp={snap.onPointerUp}
        onPointerCancel={snap.onPointerUp}
      >
        <span className="lst-sheet__grip" aria-hidden="true" />
        <div className="lst-sheet__head" role="group" aria-label={`${chipText} ${directionLabel}`}>
          {/*
            线号：白字（R6）+ 官方线路色底 + **外描边**。
            ── 为什么不用 `.linechip`（负责人提的方案 2）────────────────────────
            `.linechip` 在 `globals.css` 有**两份同名定义**，第二份（`:8805`，尺寸属性胜）
            铁定 `flex:0 0 72px; width:72px; font-size:11px; text-overflow:ellipsis`：
              ① 72px 定宽 ⇒ 顶部行放不下「方向 + 时刻 + 三键」（它本是搜索结果列表的定宽列）；
              ② 11px 属 XS 档，而本位置按 `02-线路图标审计与方案.md` §4.3.0 判据应是
                 **S 档 13px**（同排的 `.lst-sheet__dir` 就是 13px）⇒ 用它会与通琴号线号
                 **不等大**，反而制造新的不一致；
              ③ `.linechip` 依赖 `chipInkOf()`，而 Spec #7 断言是「`chipInkOf` 不再用于线路标签」；
              ④ `text-overflow:ellipsis` 与 §4.2「线号不得省略」直接冲突。
            ⇒ 仍用 `.lst-sheet__no`（§4.3 明确把「站序弹窗标号」定为 S 档的承载类），
              只把**底色**经 `--lst-no-bg` 交出（不继承通琴号粉 `--tqh-accent`）。
              待 `ui/LineChip.tsx`（审计 §4.1 的 ③ 号唯一出口，**目前尚未创建**）落地后，
              本处与通琴号一并迁过去 —— 那时才真正「全部走同一个组件」。

            ── 外描边 ────────────────────────────────────────────────────────
            解决的问题：氹仔線 `#93d50a` 这类浅底在**白面板**上，块的边界会与 `--surface`
            糊在一起（R6 已接受该色白字仅 1.79:1，但**块的边界**仍须可辨）。
            只用 `0 0 0 1px var(--border)`（发丝线 token，随主题变）——
            ⚠️ 这是**块的边界线**，不是 R6 禁止的「发光描边」：零模糊、无光晕、不改底色、
               不降饱和、不参与文字对比度（白字对比度仍是已登记偏差）。
            内层细线直接用既有 token `--hairline-inset`（= `inset 0 0 0 1px rgba(255,255,255,.22)`，
            `:root` 唯一一处定义，与 `.route-stack__seg` 同款）——
            **不在 TSX 里另抄一份 rgba 字面量**：抄了就是「新造色值」，
            以后改 token 时这处会静默不跟随。
          */}
          <span
            className="lst-sheet__no"
            style={
              {
                /* 只交"用哪个色"给 CSS（前端 A 的 ④ 规则读 `--lst-no-bg`）；字色仍由
                   `.lst-sheet__no` 的 `var(--tqh-on)` = #fff 决定（R6 白字不得改） */
                "--lst-no-bg": chipBg,
                /* 外描边（见上方说明）：块的边界线，零模糊、不改底色。
                   内层 = 既有 token；外层 = `--border`。**均为 Token，无字面色值。** */
                boxShadow: "var(--hairline-inset), 0 0 0 1px var(--border)",
              } as CSSProperties
            }
            aria-hidden="true"
          >
            {chipText}
          </span>
          {/* 方向可省略（让位给时刻与三键）；时刻自带「 · 」前缀，与搜索卡副行同一语汇 */}
          <span className="lst-sheet__dir">{directionLabel}</span>
          {firstTime && <span className="lst-sheet__time"> · {firstTime}</span>}
          {/* 三键：尺寸/命中区/间距全部由 CSS 接管（见文件头 `TOAST_MS` 上方的说明） */}
          <span className="lst-sheet__acts">
            <button
              type="button"
              className="lst-sheet__iconbtn lst-sheet__iconbtn--sm"
              aria-label="切换方向"
              aria-disabled={onFlipDirection ? undefined : "true"}
              data-inert-reason={onFlipDirection ? undefined : "no-opposite"}
              onClick={onFlip}
            >
              <Icon name="exchange" size={20} />
              <span className="lst-sheet__iconbtn__hit" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`lst-sheet__iconbtn lst-sheet__iconbtn--sm${cooling ? " is-cooling" : ""}`}
              aria-label="刷新站序"
              aria-disabled={onRefresh ? (cooling ? "true" : undefined) : "true"}
              data-inert-reason={onRefresh ? undefined : "no-refresh"}
              onClick={onRefreshClick}
            >
              <Icon name="refresh" size={20} />
              {cooling && <span className="lst-sheet__cd">{cdSec}</span>}
              <span className="lst-sheet__iconbtn__hit" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="lst-sheet__iconbtn lst-sheet__iconbtn--sm"
              aria-label="关闭"
              data-role="close"
              onClick={onClose}
            >
              <Icon name="close" size={20} />
              <span className="lst-sheet__iconbtn__hit" aria-hidden="true" />
            </button>
          </span>
        </div>
      </div>

      <div
        ref={bodyRef}
        className="lst-sheet__body"
        /* ⚠️ 不写内联 `visibility`：peek 档的隐藏由 CSS 的
           `[data-route-stops-kind][data-detent="peek"] .lst-sheet__body` 接管
           （内联会把它压成死规则）。`aria-hidden` 必须留着 —— 它是显式声明，
           不能因为「`visibility:hidden` 恰好也不进 a11y 树」就一起删。 */
        aria-hidden={bodyHidden ? true : undefined}
      >
        {rows.length > 0 ? (
          /* 纵条：rail + 节点 + 站名（+ #6 的四态巴士图标；无车时 `vehOf` 恒 null ⇒ 零 DOM 变化） */
          <LineStopList
            stops={rows}
            color={chipBg}
            etaOf={etaIdle}
            registerEl={registerRowEl}
            linesOfStation={noLines}
            lineCode={lineCode}
            sideOf={sideOf}
            vehOf={vehOf}
            onOpenBusCard={openBusCard}
          />
        ) : (
          <p className="lst-sheet__empty">暂无站序数据</p>
        )}
      </div>

      {toast && (
        <p className="lst-sheet__toast" role="status">
          {toast}
        </p>
      )}
    </section>

    {/*
      ★ #6 巴士信息卡：**必须挂在本 `<section>` 之外**（不是"顺手写进去"）——
        `.lst-sheet` 自身是满屏 fixed 容器且带 `transform`（`--sheet-y-anim`），
        卡片若放进去：① 会跟着档位位移被拖出视口（half 档时 sect 底边在 150% 处）；
        ② `position: fixed` 也会被祖先 `transform` 变成"相对该祖先"。
      因此与 `NavShell` 的车卡/站卡同款：用**既有的** `.nav-card-overlay`
        （fixed / `z-index: 90` / 自带 surface + 边框 + `max-height:62dvh` 滚动）。

      ── 层叠：90 **高于**本弹窗，这是"能盖住它"的充要条件 ──────────────────
      ⚠️⚠️ **`globals.css` 里 `.lst-sheet` 写的是 `z-index: 76`，但那不是本组件的
          实际生效值**：本组件在 `<section>` 上**内联**了 `zIndex: SHEET_Z_INDEX`（= 77，
          见文件头 `SHEET_Z_INDEX` 的长注释）。内联 > 类 ⇒ **本弹窗实际 = 77**。
          见到 CSS 里的 76 就按 76 推层叠，会得出错误的结论（差 1 档正好跨过 76/77 边界，
          容易把「卡片能不能盖住」推反）。
          现状口径：**卡片 90 > 本弹窗 77（内联）> 通琴号 76（CSS）**。
          P1 通琴号并入 `kind="tqh"` 后删 `SHEET_Z_INDEX` ⇒ 本弹窗回落到 CSS 的 76，
          届时这里应改成「90 > 76」，且两者同档需要重新确认（见该常量注释的互斥说明）。

      `open &&` 是硬条件：弹窗收起时本卡片也必须一起消失（它不在 `inert` 的子树里）。
    */}
    {open && busCard && (
      <div
        className="nav-card-overlay"
        ref={busCardRef}
        /* QA 抓手：卡片开着时能定位到「是哪辆车的卡」 */
        data-bus-card="route-stops"
        data-plate={busCard.vehicle.plate}
        data-veh-state={busCard.state}
        /*
          ★ 2026-11-06：**内联 `bottom` 已删** —— 改由 CSS 接管（`globals.css` 的
            `.nav-card-overlay[data-bus-card="route-stops"]`，取值同为
            `calc(var(--space-2) + var(--safe-bottom))`，迁移期零视觉变化）。
          为什么必须交给 CSS 而不是留着内联：
            `.nav-card-overlay` 的基础 `bottom` 含 `var(--tabbar-h)`（64px，为**地图页**
            底栏留的）；站序弹窗是满屏面板、没有底栏 ⇒ 内联/变体规则都要把它压回安全区。
            内联的坏处是**特异性最高**（内联 > 任何类）⇒ 以后主题/`prefers-reduced-motion`/
            设备方向调整想改这个值时，CSS 一律覆盖不动，只能回来改 TSX。
          ⚠️ 本元素**不再有任何 `style`**：若将来要再加内联，先看这条注释 —— 站序弹窗
             的浮层几何已全部 Token 化在 CSS 里，加内联就是把它重新锁死。
        */
      >
        <VehicleCard
          vehicle={busCard.vehicle}
          fetchedAt={vehFetchedAt}
          lineLabel={chipText}
          lineColor={chipBg}
          company={busCard.vehicle.company ? companyLabel(normalizeCompany(busCard.vehicle.company)) : null}
          stopsAwayText={busCardEndText}
          onClose={() => setBusCard(null)}
        />
      </div>
    )}
  </>
  );
}

/** 档位顺序（供宿主断言用；与 `DETENTS` 同源 —— 不新造第二份） */
export const RSS_DETENTS = DETENTS;
