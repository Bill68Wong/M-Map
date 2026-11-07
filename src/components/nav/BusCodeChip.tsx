"use client";

/**
 * 车号角标（src/components/nav/BusCodeChip.tsx，2026-11-07 · 需求 #8）
 *
 * ── 为什么抽成共用件（而不是两处各写一个 onClick）──────────────────────
 *   车号角标有**两个渲染点**且必须行为一致：
 *     · `VehicleCard.tsx`（车辆卡标题行 → 车队编号）；
 *     · `NavTrackBar.tsx`（导航吸底状态行，车牌右边，带 `data-bus-code` 观测属性）。
 *   只给其中一处挂点击 = 半截功能（用户在另一处点不动，且看起来"应该能点"）。
 *   ⇒ 视觉与交互都收敛到本文件，`.vcode` 从此**只有这一个产出点**。
 *
 * ── 视觉：**不新造样式** ────────────────────────────────────────────────
 *   复用 `globals.css` 的 `.vcode`（`globals.css:5618`）：透明底 + `--muted` 字 +
 *   500 字重 + 11px，与车牌（实心黑）形成主次。此前它是 `<span>`，现在换成
 *   `<button type="button" className="vcode">`：
 *     · 全局 `button` reset（`globals.css:493`）给了 `cursor: pointer` /
 *       `-webkit-tap-highlight-color: transparent` / `touch-action: manipulation`；
 *     · 全局 `button:focus-visible`（`globals.css:531`）给了 `outline: 2px solid
 *       var(--primary)` ⇒ 键盘可达**开箱即有焦点环**，不需要为本件补 CSS。
 *   ⇒ 从 `<span>` 变 `<button>` 视觉零变化（`.vcode` 的 padding/border/字体全部照旧），
 *     只多了「可点 / 可 Tab / 有语义」三件事。
 *
 * ── ⚠️ 已知取舍（已登记 backlog，不是漏做）───────────────────────────────
 *   **触摸目标约 24px，低于 WCAG 44×44**；放大需重新核算底栏宽度预算，
 *   见 `globals.css` 的 `.nav-actions__spacer.nav-actions__right` 注释
 *   （320px 屏下「车牌 + 车号 + 右槽」一切组合都已临界，单方面放大角标会连锁压掉右槽）。
 *   保持现状的两条理由（负责人 2026-11-07 裁定）：
 *     ① 底栏空间实测已临界，放大是全局连锁而不是局部改动；
 *     ② 角标是**次要入口**（主要入口是车辆卡），点不中的代价是「没看到车型」而非「操作出错」。
 *   ⚠️ 若将来要达标，**不要**在 CSS 里加 `padding`/`::after` 扩命中区了事 ——
 *      那会让底栏宽度预算再次失衡；正确做法是先重新核算 `.nav-actions__staterow` 的可用宽。
 *
 * ── 点击语义 ───────────────────────────────────────────────────────────
 *   打开「车型信息卡」（`VehicleModelCard`，**无叉**，点外部/Esc 关闭）。
 *   · 无查询键（`code` 与 `plate` 都空）⇒ 不弹（弹出来必然是空卡）；
 *   · 再点自己 = 收起（`aria-expanded` 同步）；
 *   · 点另一处角标 ⇒ 旧的自动关（`VehicleModelCard` 里的模块级单例守卫）。
 */
import { useCallback, useRef } from "react";
import VehicleModelCard, { useVehicleModelCard } from "./VehicleModelCard";

export interface BusCodeChipProps {
  /** 车队编号（如 `HE247`）；空/undefined ⇒ 不渲染，不留空位 */
  code?: string | null;
  /** 车牌（`vehicle_plates` 主键，查询优先用它）；无则弹窗拿不到最权威的键 */
  plate?: string | null;
  /**
   * 视觉变体：底栏窄（默认 `sm`）/ 卡内 `md`。
   * ⚠️ 当前 `.vcode` 只有**一套**规格（两个渲染点实测同尺寸），故本 prop 只落成
   *    `data-size` 观测属性，**不输出任何 class**（不造没有规则的空类名）。
   *    将来真要分档时，在此加 `vcode--md` 并在 globals.css 补一条即可。
   */
  size?: "sm" | "md";
  /** 触发元素额外 class（`.vcode` 之外的可选追加） */
  className?: string;
}

export default function BusCodeChip({
  code,
  plate = null,
  size = "sm",
  className,
}: BusCodeChipProps) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const { open, toggle, close } = useVehicleModelCard();

  const onClick = useCallback(() => {
    /* 两个键都没有 ⇒ 查询无从下手：不弹空卡，也不留"点了没反应"的疑惑外观
       （正常情况下一定至少有一个：`code` 就是这枚角标的文本，`plate` 由调用方必传） */
    if (!code && !plate) return;
    toggle();
  }, [code, plate, toggle]);

  if (!code) return null; // `.vcode:empty { display:none }` 之外的第二道防线：不留空位

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`vcode${className ? ` ${className}` : ""}`}
        /* ★ 既有观测属性：`NavTrackBar` 的 QA 断言按 `.vcode[data-bus-code]` 取（改名会静默打断断言） */
        data-bus-code={code}
        data-bus-code-chip=""
        data-size={size}
        title="车队编号"
        aria-label={`车队编号 ${code}，点击查看车型资料`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={onClick}
      >
        {code}
      </button>
      {open && (
        /* 按 `open` 挂载 ⇒ 每次打开都是新实例：不闪旧数据、旧响应也无法覆盖新弹窗 */
        <VehicleModelCard
          busCode={code}
          plate={plate}
          anchorRef={btnRef}
          onClose={close}
        />
      )}
    </>
  );
}
