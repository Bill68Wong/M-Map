/**
 * 车型卡（无叉弹窗）的键盘与焦点约束 —— src/components/nav/model-card-focus.ts
 *
 * 为什么从 VehicleModelCard.tsx 抽出来：
 *   这一段是纯 DOM 行为，却是「无叉」弹窗唯一保证键盘用户不被困住的通道。
 *   放在组件里只能靠真机手工验；独立成模块后，
 *   scripts/check-vehicle-model-focus.mjs 会把本文件编译后注入真实浏览器 fixture，
 *   对「焦点入卡 / Tab 不逃出 / iframe 内 Esc / 关闭归还」逐条下断言。
 *
 * 旧实现的三个缺口（QA4 实测见 docs/迭代-问题修复-20261106/09-车号标签弹窗验收.md §2 ④）：
 *   1. 焦点锁只在父 document 的 focusin 冒泡阶段做事后拉回 ⇒ Tab 会瞬时逃进
 *      高德那个全屏 javascript:void(0) iframe（Tab×12 逃出 6 次）。
 *   2. Esc 只监听父 document ⇒ 焦点停在 iframe 内时，键盘事件在另一个 document
 *      里派发，父 document 根本不在传播路径上（不是「没冒泡」），卡片关不掉。
 *   3. 焦点归还在另一个 effect 的 cleanup 里，与 focusin 监听的移除顺序互相依赖。
 *
 * 本模块的对策：
 *   - keydown 的 capture 阶段拦 Tab：卡内没有可 Tab 后代时直接 preventDefault，
 *     把焦点留在卡本身，从源头不产生「逃出」这个状态（不是事后补救）。
 *   - 同一套 keydown/focusin 监听镜像到页面上所有同源 iframe 的 contentDocument，
 *     并用 MutationObserver 覆盖地图 SDK 后续新建的 iframe。
 *   - dispose() 里先摘全部监听、再归还焦点，顺序写死在同一处，
 *     不依赖 React 的 effect cleanup 次序。
 *
 * 注意：本模块不碰 iframe 的任何属性（不改 pointer-events / tabIndex / src）。
 * 它解决的是「事件发生在哪个 document」，不是把 iframe 从页面里屏蔽掉。
 */

export interface ModelCardFocusGuard {
  /** 幂等。关闭弹窗前必须调用：摘监听 + 归还焦点 */
  dispose(): void;
}

export interface ModelCardFocusOptions {
  /** 已挂载且可见的弹窗根节点（tabIndex=-1） */
  card: HTMLElement;
  /** 关闭后焦点归还目标（触发角标）；不在文档里则跳过 */
  restoreTo?: HTMLElement | null;
  /** Esc 回调（组件用它关弹窗） */
  onEscape: () => void;
}

/** 卡内可参与 Tab 序列的后代；card 自身是 tabIndex=-1，不在其中 */
const TABABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function installModelCardFocusGuard({
  card,
  restoreTo = null,
  onEscape,
}: ModelCardFocusOptions): ModelCardFocusGuard {
  let disposed = false;
  const attached = new Set<Document>();

  const pullBack = () => {
    if (disposed) return;
    if (document.activeElement !== card) card.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (disposed) return;
    if (e.key === "Escape") {
      e.preventDefault();
      /* 保留原行为：一次 Esc 只关这一层，别让面板自己的 Esc 一起响应 */
      e.stopPropagation();
      onEscape();
      return;
    }
    if (e.key !== "Tab") return;

    const items = Array.from(card.querySelectorAll<HTMLElement>(TABABLE)).filter(
      (el) => el.tabIndex >= 0 && el.getAttribute("aria-hidden") !== "true",
    );
    if (items.length === 0) {
      /* 本卡只有文本与 span.vcode，没有可 Tab 后代。
         不 preventDefault 的话浏览器会把焦点交给下一个可 Tab 元素 —— 实测就是全屏 iframe。 */
      e.preventDefault();
      pullBack();
      return;
    }
    /* 将来卡里加了按钮/链接时的标准首尾循环，别写死「永远只有 card」 */
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === card)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onFocusIn = (e: FocusEvent) => {
    if (disposed) return;
    /* 不能用 instanceof Node：iframe 内的 target 属于另一个 realm，
       跨 realm 的 instanceof 恒为 false，会把「已在卡内」误判成逃出。
        duck typing + contains 在两个 realm 下都成立。 */
    const t = e.target as Node | null;
    if (t && typeof t.nodeType === "number" && card.contains(t)) return;
    pullBack();
  };

  const attach = (doc: Document) => {
    if (attached.has(doc)) return;
    doc.addEventListener("keydown", onKeyDown, true);
    doc.addEventListener("focusin", onFocusIn, true);
    attached.add(doc);
  };

  const syncFrames = () => {
    if (disposed) return;
    document.querySelectorAll("iframe").forEach((frame) => {
      try {
        const doc = frame.contentDocument;
        if (doc && doc !== document) attach(doc);
      } catch {
        /* 跨域 iframe 取不到 contentDocument：它内部的键盘事件无法镜像，
           但焦点落到 iframe 元素本身时父文档的 focusin 仍会把它拉回。 */
      }
    });
  };

  attach(document);
  syncFrames();

  /* 地图 SDK 可能在弹窗打开之后才插入/替换 iframe */
  const observer = new MutationObserver(syncFrames);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  /* 打开即焦点入卡。调用方必须保证此刻 card 已挂载且 visibility 不是 hidden */
  pullBack();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      attached.forEach((doc) => {
        doc.removeEventListener("keydown", onKeyDown, true);
        doc.removeEventListener("focusin", onFocusIn, true);
      });
      attached.clear();
      /* 顺序不能反：先摘监听，再归还焦点；否则 focusin 会把焦点拉回正在卸载的卡 */
      if (restoreTo?.isConnected) restoreTo.focus();
    },
  };
}
