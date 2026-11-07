"use client";

/**
 * 车型信息卡（src/components/nav/VehicleModelCard.tsx，2026-11-07 · 需求 #8）
 *
 * ── 它解决什么 ─────────────────────────────────────────────────────────
 *   车号（`HE247`）只是**车队编号**，用户看不出这是台什么车。
 *   点车号标签 ⇒ 弹出这张小卡，四行把「车号 / 车型 / 款式 / 坐位」一次答完。
 *   `HE1`(26 座) 与 `HE3`(30 座) 的 `modelCode` 与 `displayName` **逐字相同**
 *   ⇒ 坐位行是**唯一区分点**，不可省（四行是下界，不是上限）。
 *
 * ── 无叉弹窗：这是负责人明确要求，不是漏做 ────────────────────────────
 *   负责人原话：「弹出一个**没有叉叉**的小窗，**点击任意非弹窗显示范围的内容关闭弹窗**」。
 *   ⇒ 本组件**不提供任何关闭按钮**。可关闭的三条路径：
 *     ① 点弹窗以外任何位置（`pointerdown` + `closest('[data-vehicle-model-card]')` 判据，
 *        **不按坐标**判 —— 坐标判定在 `position: fixed` 与缩放/滚动下会漂）；
 *     ② `Esc`；
 *     ③ 点另一个车号标签（模块级单例 `claimModelCard` 会让旧的自动关掉）。
 *   ⚠️ 「无叉」**必须**配齐无障碍三件套，否则等于把键盘用户关在弹窗里：
 *      `role="dialog"` + `aria-modal="true"` + 打开时焦点移入 / 关闭后焦点归还触发元素
 *      （`.vcode` 那个 `<button>`）。这是「无叉」的必要配套，不是额外工作量。
 *
 * ── 定位：为什么锚在触发元素上方、为什么必须 portal ──────────────────
 *   底栏（`.nav-actions`）就在屏幕底，弹窗贴底会**叠在状态行上**（用户要读的车号/状态
 *   全被自己盖住）。故锚点 = 触发元素的 `getBoundingClientRect()`：
 *   · 上方空间够（≥140px）⇒ 卡片**底边**贴在触发元素顶端上方 8px（向上长，不需要
 *     预先知道卡片高度 —— 这正是选 `bottom` 而不是 `top` 的原因）；
 *   · 上方不够 ⇒ 翻到下方，并把 `max-height` 压到视口内。
 *   ⚠️ **必须 `createPortal` 到 `document.body`**：两个触发点的祖先都带
 *      `transform`（`.route-sheet` 的档位位移 / `.nav-card-overlay` 的入场动画），
 *      而带 `transform` 的祖先会把 `position: fixed` 的包含块改成自己 ⇒ 卡片会跟着
 *      面板拖动一起漂。挂到 `body` 后坐标恒为视口坐标。
 *   ⚠️ 滚动/缩放时重算（`scroll` 用 capture 抓所有滚动容器）：`scroll` 之外的
 *      位移（如拖拽面板档位）由「点外部即关」兜住 —— 拖拽必然先产生 `pointerdown`。
 *
 * ── 五档渲染（确定性映射，不写状态机）────────────────────────────────────
 *   ① 齐全      `model` 非空        ⇒ 车号 / 车型 / 款式 / 坐位（+ 类别不渲染）
 *   ② 无型号有类别  `model` 空 + `category` 有 ⇒ 车号 / 车型「资料未公开」/ 类别
 *   ③ 全无      `model` 空 + `category` 空   ⇒ 车号 / 车型「资料未公开」
 *   ④ 请求失败  HTTP 失败 / `ok:false` ⇒ **不弹窗**、静默（不弹错误提示：用户无法行动）
 *   ⑤ `unknown_code` / `unparsable`   ⇒ 同 ④，不弹窗
 *   行数随档变化是预期（①4 行 / ②3 行 / ③2 行），**不补占位行凑齐**。
 *   ⚠️ 档① 内 `model.seats === null`（如 `HE10`，`reason:"no_spec"`）⇒ 坐位行**保留**，
 *      值位写「资料未公开」。
 *   ⚠️ 口径差异（已闭合）：team-lead 的摘要曾把档① 写成「5 行」，但**五档表本身**与负责人
 *      原文的字段清单都是 4 项（车号/车型/款式/坐位，类别行「不渲染」）⇒ 按 4 行实现；
 *      team-lead 2026-11-07 已确认「4 行对、摘要写错（错把档② 的类别行算进档①）」。别再改回 5 行。
 *
 * ── 尺寸：卡宽上限 368px + 款式行**恒可折行**（2026-11-07 需求 2 实测修订）──
 *   定宽依据改为**最长真实文案**（不是型号名）：全库最长 `displayName` =
 *   `海格 增程式電動巴士（11.3米大巴）(2022)`，真页面 15px 字体下实测 **286px**
 *   （旧注释按 13px 估 259px、且算式未扣 1.5px×2 边框，均已纠正 —— 详见
 *   `CARD_MAX_W` 上方的实测算式）。
 *   ⇒ 取值：**省略永不出现**，款式行在任何宽度都可折行（`overflow-wrap: anywhere`）；
 *     ≥382px 屏（390 主力机型 ✓）一行放下，更窄屏退化成两行。详见 `WRAP_STYLE`。
 *   ★ 2026-11-07 负责人已采纳此改法，并明确「两条冲突时不省略优先」。
 *
 * ── 文案纪律 ───────────────────────────────────────────────────────────
 *   空值统一「资料未公开」，整行**不消失**。禁词：`系统` / `暂无数据` / `加载失败` /
 *   `未知` / `N/A` / `--` —— 这些都在把「这台车没录资料」说成「你手机出问题了」。
 *
 * ── 两个 `code` 别接反（最容易犯且不报错）───────────────────────────────
 *   车号 = `result.busCode`（**外层**）· 车型 = `result.model.code`（内层）。
 *   接反的表现是车号行显示型号代码，编译通过、页面不崩、只是错 —— 典型沉默逻辑错误。
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { installModelCardFocusGuard, type ModelCardFocusGuard } from "./model-card-focus";

/* ══════════════════════════════════════════════════════════════════════
 * 单例守卫：屏幕上同时只允许一张车型卡
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 为什么放在**模块作用域**而不是 context：
 *   两个触发点（车辆卡 `VehicleCard` 里的角标 / 吸底状态行 `NavTrackBar` 里的角标）
 *   分属两棵互不相邻的子树，而它们的共同宿主（`NavShell` / `RouteSheet`）不在本批可改范围。
 *   若不加守卫：A 开着时点 B ⇒ A 的「点外部即关」因 B 的角标属于 `[data-bus-code-chip]`
 *   而跳过 ⇒ 屏幕上叠两张卡。单例是这里最小侵入的正确解。
 */
let active: { id: string; close: () => void } | null = null;

/** 认领「当前唯一打开的那张」；已有别的卡开着 ⇒ 先把它的 close 调掉 */
export function claimModelCard(id: string, close: () => void) {
  const prev = active;
  active = { id, close };
  if (prev && prev.id !== id) prev.close();
}

/** 归还（只归还自己那张，避免把后来者的登记清掉） */
export function releaseModelCard(id: string) {
  if (active?.id === id) active = null;
}

/* ══════════════════════════════════════════════════════════════════════
 * 接口契约（GET /api/vehicle-model）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 只声明**本卡用到的**字段。
 * 为什么不 import `@/lib/vehicle/model-shared`：那张表本批正由后端同批改动（新增 `category`），
 * 直接引用会在对方半成品状态下把本文件一起编译红；这里按已裁决的契约取子集，
 * 且 `category` 声明为**可选** ⇒ 后端未落地时只是少一行「类别」，不会崩。
 * 语义与 `VehicleModelResult` 逐字段一致（已对读 `model-shared.ts`）。
 */
interface ApiModelPayload {
  code: string;
  displayName: string | null;
  seats: number | null;
  confidence: "high" | "medium" | null;
}

interface ApiResult {
  ok?: boolean;
  busCode?: string;
  company?: string | null;
  via?: "db" | "range" | null;
  /** 档② 的类别行（外层，**不是** `model` 里的字段） */
  category?: string | null;
  model?: ApiModelPayload | null;
  reason?: "no_spec" | "no_model" | "unknown_code" | "unparsable" | null;
}

/* ══════════════════════════════════════════════════════════════════════
 * 渲染映射（纯函数，可单测）
 * ══════════════════════════════════════════════════════════════════════ */

/** 空值文案：全卡唯一口径。**整行不消失** —— 消失会让用户以为"这车就只有三行信息" */
const UNPUBLISHED = "资料未公开";

export interface VehicleModelRow {
  key: "busCode" | "model" | "style" | "seats" | "category";
  label: string;
  value: string;
  /** 车号行：值以 `.vcode` 标签形式呈现（负责人要求「车号值显示为标签形式，其余为文字」） */
  asChip?: boolean;
  /** 款式行：唯一允许折行的行（其余三行严格不换行；折行不是省略，见 `WRAP_STYLE`） */
  wrappable?: boolean;
  /** 款式行尾极小「参考」标注（仅 `confidence === "medium"`） */
  ref?: boolean;
}

/**
 * 五档 → 行（确定性映射；`reason` 里的 ④⑤ 两档由调用方在取数阶段就拦掉，不进这里）。
 *
 * ⚠️ **纯数字车号（`6009`）会走档②，不是档⑤** —— 别以为 `unparsable` 分支坏了。
 *   `parseBusCode` 拆不开纯数字，但 `6009` 这串**在 `vehicle_plates` 里真有行**
 *   ⇒ `foundInDb = true`、`dbModel` 为空、区间也推不出 ⇒ 服务端判 `no_model`（车在库、型号未知）。
 *   而 `unparsable` 的前提是**车都不在库**（`foundInDb = false` 且格式也拆不开）⇒ 那种才是档⑤、不弹窗。
 *   两者在 UI 上的差别只有一件事：`no_model` **弹窗**（值位「资料未公开」），`unparsable` **不弹窗**。
 *   实测样本：`6009`（牌 MX1931，category「大巴」⇒ 3 行）、`ZZZZ9`（不在库 ⇒ 不弹窗）。
 *
 * @param r 接口返回体（`model` / `category` 决定档位）
 * @param fallbackBusCode 接口没回 `busCode` 时用本地已知的车号兜底（角标上的那串一定是对的）
 */
export function deriveVehicleModelRows(
  r: ApiResult,
  fallbackBusCode: string,
): VehicleModelRow[] {
  const rows: VehicleModelRow[] = [
    { key: "busCode", label: "车号", value: r.busCode || fallbackBusCode, asChip: true },
  ];

  const m = r.model;
  if (m) {
    /* 档①：齐全（车型行取 `model.code` = 型号代码，**不是**车号） */
    rows.push({ key: "model", label: "车型", value: m.code || UNPUBLISHED });
    rows.push({
      key: "style",
      label: "款式",
      /* `no_spec` 的型号只有代码、没有显示名 ⇒ 值位「资料未公开」，行保留 */
      value: m.displayName || UNPUBLISHED,
      wrappable: true,
      /* 中置信：不删行、只在行尾标注「参考」（`--text-2xs` + `--meta`，见交付报告 CSS） */
      ref: m.confidence === "medium",
    });
    rows.push({
      key: "seats",
      label: "坐位",
      /* ★ 不可省：`HE1`(26) 与 `HE3`(30) 的 `modelCode` + `displayName` 逐字相同 */
      value: m.seats == null ? UNPUBLISHED : String(m.seats),
    });
    return rows;
  }

  /* 档②/③ 共同：车型行值位「资料未公开」 */
  rows.push({ key: "model", label: "车型", value: UNPUBLISHED });
  /* 档②：有类别 ⇒ 多一行「类别」；档③：没有 ⇒ 两行收工（不补占位行） */
  if (r.category) rows.push({ key: "category", label: "类别", value: r.category });
  return rows;
}

/* ══════════════════════════════════════════════════════════════════════
 * 定位
 * ══════════════════════════════════════════════════════════════════════ */

/* ★ 2026-11-07（需求 2 · 定宽依据改为「最长真实文案」）：340 → 368。
 *
 * ── 定宽依据（真浏览器实测，Chromium 156 · 3510 生产构建 · 与本卡同构夹具逐串量宽）──
 *   之前按「型号名」估宽是**错口径**：678 辆车里 413 台（60.9%）`model` 为空，
 *   走的是车型行「资料未公开」；但真正的**最长文案**在款式行（`displayName`），
 *   与型号是否为空无关 —— 有型号的 265 台全部命中本表。
 *   实测各字段内容宽（值列字体实际 **15px**，不是旧注释写的 13px —— 见下方旧账）：
 *     · 款式 286（`海格 增程式電動巴士（11.3米大巴）(2022)`，全库 14 个唯一 displayName 最长）
 *     · 款式+「参考」标注 210.5（medium 置信那 4 条的 displayName 都短于全库最长 ⇒ 不约束）
 *     · 车型 120（`KLQ6109GQHEV5`，15 个 modelCode 最长）
 *     · 车号（.vcode 徽章）49.6 ｜ 类别/「资料未公开」等 ≤75
 *   ⇒ 约束项 = 款式行 286px。
 *
 * ── 算式（含边框，修正旧账）────────────────────────────────────────────
 *   值列可用宽 = 卡宽 − 24(内距 `--space-3`×2) − **2(边框 `--frame-w` 1.5×2)**
 *               − 44(标签列) − 10(列间距)。
 *   旧注释「375 ⇒ 262 / 360 ⇒ 266 / 320 ⇒ 226」**没扣边框**，且把字体当 13px
 *   （实测 `.nav-vehicle-card__v` 在真页面是 15px）。按实测修正：
 *     · 340 卡 ⇒ 值列 260 < 286 ⇒ **连 375 屏都放不下**（旧注释声称"刚好放得下"是错的）
 *     · 368 卡 ⇒ 值列 288 ≥ 286 ⇒ 最长款式单行放下，还留 2px 余量
 *   368 是否超屏？可用卡宽 = 屏宽 − 16(EDGE×2)：
 *     · 390 屏（主力机型）⇒ 374 ≥ 368 ⇒ 单行 ✓
 *     · 375/360/320 屏 ⇒ 359/344/304 < 368 ⇒ `measure()` 自动封顶到屏宽，
 *       款式行走 `WRAP_STYLE` 折两行 —— **折行不是省略**（负责人裁决：省略更不可接受）。
 *   （若负责人接受"这一列在窄屏折行"，368 就是终值；想连 375 也单行做不到 —— 需要 382px 屏。）
 */
const CARD_MAX_W = 368;
/** 与触发元素的间距 */
const GAP = 8;
/** 距视口边的最小留白 */
const EDGE = 8;
/** 上方至少要有这么高才向上展开；否则翻到下方（四行卡实测约 120px） */
const MIN_SPACE_ABOVE = 140;

/**
 * 值列在「款式」行的折行写法 —— **折行不是省略**。
 *
 * ── 为什么本卡的值列要单独一套（不直接用 `.nav-vehicle-card__v` 的 nowrap）──────
 *   实测最长 `displayName` = `海格 增程式電動巴士（11.3米大巴）(2022)`，
 *   真页面 15px 字体下 **286px**（见 `CARD_MAX_W` 上方注释的实测算式）。
 *   值列可用宽 = 卡宽 − 24(内距) − 2(边框) − 44(标签列) − 10(列间距)：
 *     · 390px 屏 ⇒ 368 卡 ⇒ 288px —— 一行放得下；
 *     · 375/360/320px 屏 ⇒ 卡被 `measure()` 封顶到 359/344/304 ⇒ 值列
 *       279/264/224px —— **放不下**。
 *   若沿用 nowrap + `text-overflow: ellipsis`，这些屏会显示成 `海格 增程式電動…`
 *   —— 负责人两条硬要求（「不省略」「一行显示完不分行」）里**省略更不可接受**：
 *   省略是永久丢信息，折行只是占两行。
 *   ⇒ 款式行恒可折行（`overflow-wrap: anywhere` ⇒ 长串能断），
 *     ≥382px 屏实际是一行（390 主力机型 ✓），更窄的屏才退化成两行。
 *
 * ── 为什么写成内联属性而不是新 class ────────────────────────────────────
 *   `globals.css` 需与主控确认空档后再动（`.nav-vehicle-card__v` 的 ellipsis 清理
 *   排在同一文件）。本卡所有视觉 delta 都走**内联布局属性 + Token 变量**
 *   （仓内既有先例：`VehicleCard.tsx` 的 `style={{ background: lineColor ?? "var(--primary)" }}`）。
 *   这里没有任何写死的颜色值，全是布局。
 */
const WRAP_STYLE: CSSProperties = {
  whiteSpace: "normal",
  textOverflow: "clip",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
  lineHeight: 1.35,
};

/**
 * 标签列宽：44px。
 * `.nav-vehicle-card__row` 的 84px 是给车辆卡那批 **4 字标签**（当前站 / 数据时间 / 运营商）定的；
 * 本卡标签全是 2 字（车号 / 车型 / 款式 / 坐位 / 类别）⇒ 44px 足够，且多出来的 40px
 * 直接给到值列 —— 这是上面那条「25 字款式能否一行放得下」的关键预算。
 */
const ROW_STYLE: CSSProperties = { gridTemplateColumns: "44px 1fr" };

/**
 * 款式行尾的「参考」极小标注（仅 `confidence === "medium"`；`high` / `null` 不加）。
 * 颜色走 Token（`--meta`），字号走 `--text-2xs` —— 唯一允许的字面色在本项目是 `#fff`/`#000`，
 * 这里一个都没有。语义：这批规格来自社区/非官方来源，**标注而不是删行**。
 */
const REF_STYLE: CSSProperties = {
  marginLeft: 6,
  fontSize: "var(--text-2xs)",
  color: "var(--meta)",
  whiteSpace: "nowrap",
};

/** 纯布局，无任何颜色：颜色全部来自 `.nav-card-overlay` / `.nav-vehicle-card__*` / `.vcode` */
function measure(anchor: HTMLElement): CSSProperties {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(CARD_MAX_W, vw - EDGE * 2);
  /* 左边缘对齐触发元素，但整卡必须留在视口内（底栏角标常靠右） */
  const left = Math.max(EDGE, Math.min(r.left, vw - EDGE - width));
  const spaceAbove = r.top - GAP - EDGE;

  if (spaceAbove >= MIN_SPACE_ABOVE) {
    /* 向上长：底边贴触发元素顶端上方 GAP。用 bottom 而非 top ⇒ 不必预知卡片高度 */
    return {
      left,
      width,
      right: "auto",
      top: "auto",
      bottom: Math.round(vh - r.top + GAP),
      maxHeight: Math.round(spaceAbove),
    };
  }
  return {
    left,
    width,
    right: "auto",
    bottom: "auto",
    top: Math.round(r.bottom) + GAP,
    maxHeight: Math.round(Math.max(80, vh - r.bottom - GAP - EDGE)),
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 组件
 * ══════════════════════════════════════════════════════════════════════ */

export interface VehicleModelCardProps {
  /** 角标上的车号（本地已知；接口没回 `busCode` 时兜底，且用作 `aria-labelledby` 的文本） */
  busCode: string;
  /** 车牌（**查询优先键**：`plate` 是 `vehicle_plates` 的主键，唯一；`code` 只是普通索引） */
  plate?: string | null;
  /**
   * 触发元素（定位锚点 + 关闭后焦点归还目标）。
   * 传 **ref 对象**而不是元素本身：本组件在 `open` 时才挂载，若在上层渲染期读
   * `ref.current` 会拿到 `null`（首帧）。在 effect 里读 ref 才是正确时机。
   */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

/** 一行：标签列 + 值列（复用车辆卡的 `__row/__k/__v` 三件套，不造第二套栅格） */
function Row({
  label,
  valueId,
  wrap,
  children,
}: {
  label: string;
  /** 车号行的值位 id —— `aria-labelledby` 指向它（弹窗的无障碍名就是车号） */
  valueId?: string;
  /** 值位允许折行（仅款式行，见 `WRAP_STYLE`） */
  wrap?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="nav-vehicle-card__row" style={ROW_STYLE}>
      <span className="nav-vehicle-card__k t-label">{label}</span>
      <span
        id={valueId}
        className="nav-vehicle-card__v"
        style={wrap ? WRAP_STYLE : undefined}
      >
        {children}
      </span>
    </div>
  );
}

export default function VehicleModelCard({
  busCode,
  plate = null,
  anchorRef,
  onClose,
}: VehicleModelCardProps) {
  const uid = useId();
  const titleId = `${uid}-buscode`;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const guardRef = useRef<ModelCardFocusGuard | null>(null);
  const focusedOnce = useRef(false);
  const onCloseRef = useRef(onClose);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [pos, setPos] = useState<CSSProperties | null>(null);

  /* ── 取数：只在打开时请求一次（无轮询、无重试计时器）──────────────────
     · `cache: "no-store"`：型号标定随采集在变，缓存旧型号还不如不显示；
     · 竞态：本组件由 `BusCodeChip` **按 open 条件挂载** ⇒ 每次打开都是新实例、
       新状态，旧响应**物理上无法**写进新弹窗；`AbortController` 只负责
       卸载时把飞行中的请求掐掉（避免无意义的上游压力）；
     · 档④/⑤：静默关闭。不给任何错误提示 —— 「资料没收录」不是用户能处理的事。 */
  useEffect(() => {
    const qs = new URLSearchParams();
    if (plate) qs.set("plate", plate);
    if (busCode) qs.set("code", busCode);
    if (!plate && !busCode) {
      onClose();
      return;
    }

    const ctrl = new AbortController();
    let alive = true;

    void (async () => {
      try {
        const res = await fetch(`/api/vehicle-model?${qs.toString()}`, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!alive) return;
        if (!res.ok) {
          onClose(); // 档④
          return;
        }
        const body = (await res.json()) as ApiResult;
        if (!alive) return;
        if (body.ok !== true) {
          onClose(); // 档④
          return;
        }
        if (body.reason === "unknown_code" || body.reason === "unparsable") {
          onClose(); // 档⑤：连车号都不认，弹一张只有车号的空卡毫无意义
          return;
        }
        setResult(body);
      } catch (e) {
        if (!alive) return;
        /* `AbortError` = 用户已经关掉了，什么都不做（不是错误） */
        if ((e as Error)?.name === "AbortError") return;
        onClose(); // 断网 / 超时 / JSON 解析失败：同档④，静默
      }
    })();

    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [plate, busCode, onClose]);

  const rows = useMemo(
    () => (result ? deriveVehicleModelRows(result, busCode) : null),
    [result, busCode],
  );

  /* ── 定位 ───────────────────────────────────────────────────────────── */
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!rows || !anchor) return;
    const apply = () => setPos(measure(anchor));
    apply();
    window.addEventListener("resize", apply);
    /* capture：底栏/卡片内部还有可滚动祖先，冒泡的 scroll 抓不到 */
    window.addEventListener("scroll", apply, true);
    return () => {
      window.removeEventListener("resize", apply);
      window.removeEventListener("scroll", apply, true);
    };
  }, [rows, anchorRef]);

  /* ── 打开即焦点入卡 + 焦点约束 + Esc（无叉弹窗的必备配套）─────────────────
     安装时机必须是「卡片 DOM 已挂载 且 定位已就绪」：
       · 首渲染 result=null ⇒ rows=null ⇒ 下面的 `if (!rows) return null`，卡片根本
         不在 DOM 里；旧实现在挂载时的 effect 里 `cardRef.current?.focus()` 静默失败，
         且 [anchorRef] 依赖不变、rows 到达后不重跑 ⇒ 焦点永远留在角标上；
       · 定位未就绪时 style 带 visibility:hidden，hidden 元素也无法聚焦。
     故依赖 [rows, pos]，且用 focusedOnce 保证只装一次：pos 会随 resize/scroll
     变化，若因此反复 dispose，焦点会被反复归还给角标。 */
  useLayoutEffect(() => {
    if (!rows || !pos || focusedOnce.current) return;
    const card = cardRef.current;
    if (!card) return;
    focusedOnce.current = true;
    guardRef.current = installModelCardFocusGuard({
      card,
      restoreTo: anchorRef.current,
      onEscape: () => onCloseRef.current(),
    });
  }, [rows, pos, anchorRef]);

  /* onClose 用 ref 透传：guard 只装一次，不能让闭包锁死旧回调 */
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  /* 卸载（关闭）时统一 dispose：摘监听 → 归还焦点。
     单独放依赖 [] 的 effect，避免上面的 effect 因 pos 变化重跑而误归还。 */
  useEffect(
    () => () => {
      guardRef.current?.dispose();
      guardRef.current = null;
    },
    [],
  );

  /* 点外部即关（`closest` 判据，不按坐标）；「车号角标」自身除外 —— 交给它 toggle */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest("[data-vehicle-model-card]")) return;
      if (t.closest("[data-bus-code-chip]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  /* Esc 与焦点锁已统一由 `installModelCardFocusGuard` 接管（model-card-focus.ts）：
     它同时在主文档与同源 iframe 文档上装 capture 监听，从 keydown 阶段拦住 Tab，
     解决「焦点进 iframe 后瞬时逃出 / Esc 收不到」这两个同源缺陷。 */

  if (!rows) return null; // 取数中 / 档④⑤：屏上什么都不出现

  return createPortal(
    <div
      ref={cardRef}
      /* `.nav-card-overlay` 提供容器视觉（底色/描边/圆角/阴影/内距/z-90 基准）；定位由内联覆盖 */
      className="nav-card-overlay"
      data-vehicle-model-card=""
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={{ position: "fixed", zIndex: 92, ...(pos ?? { visibility: "hidden" }) }}
    >
      {/* `marginTop: 0`：`.nav-vehicle-card__rows` 的 10px 上边距是给「标题行之后」留的，
          本卡没有标题行（四行即全部内容）⇒ 归零，让上下内距回到 `.nav-card-overlay` 的对称 12px */}
      <div className="nav-vehicle-card__rows" style={{ marginTop: 0 }}>
        {rows.map((row) => (
          <Row
            key={row.key}
            label={row.label}
            valueId={row.asChip ? titleId : undefined}
            wrap={row.wrappable}
          >
            {row.asChip ? (
              /* 车号：**标签形式**（复用 `.vcode`，与地图卡片/底栏同一视觉）。
                 ⚠️ 这里**不能**用 `<BusCodeChip>`：那会变成"点标签再弹一张卡"的嵌套弹窗。 */
              <span className="vcode">{row.value}</span>
            ) : (
              row.value
            )}
            {row.ref && <span style={REF_STYLE}>参考</span>}
          </Row>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/* ══════════════════════════════════════════════════════════════════════
 * 内部 hook：给 `BusCodeChip` 用的开合状态（含单例登记与清理）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 车号角标的开合状态机（很小，但放这里是为了让 `claim/release` 与弹窗同源）。
 * @returns `open` 是否开着 · `toggle` 点角标 · `close` 外部/自身关闭 · `id` 单例身份
 */
export function useVehicleModelCard() {
  const id = useId();
  const [open, setOpen] = useState(false);

  const close = useCallback(() => {
    releaseModelCard(id);
    setOpen(false);
  }, [id]);

  /* ⚠️ 副作用（关掉别处那张）**不能**放进 `setOpen` 的 updater 里：
     React 严格模式下 updater 会被调用两次 ⇒ 「关别人」会执行两遍（且是渲染期副作用）。 */
  const toggle = useCallback(() => {
    if (open) {
      close();
      return;
    }
    claimModelCard(id, close); // 先把别处开着的那张关掉
    setOpen(true);
  }, [open, id, close]);

  /* 卸载兜底：开着被卸载（比如换车导致整卡重挂）⇒ 别把单例登记留成悬垂引用 */
  useEffect(() => () => releaseModelCard(id), [id]);

  return { open, toggle, close, id };
}
