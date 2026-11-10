"use client";

/**
 * 跨境地标小窗（需求 7）—— 点地图上的机场 / 码头圆点后弹出。
 *
 * ── 一个组件两种数据长度（负责人裁定）──────────────────────────────────
 *   `ids.length === 1` ⇒ 单个地标：标题 + 副行 + 一行「查看详细信息」
 *   `ids.length === 2` ⇒ 聚合点：标题 + 副行 + **两行**（机场一行、码头一行），
 *     各自链到自己那一页。两行都必须是 `<a href>`（不是 onClick + router.push）——
 *     理由见下方 `xbHref` 的注释。
 *
 * ── 为什么复用 `.nav-card-overlay` 容器而不复用 `StationCard` 本体 ──────────
 *   容器（`globals.css` 的 `.nav-card-overlay`：fixed / 左右 16px / z90 / max-height 62dvh）
 *   是**同屏浮层的位置与层叠契约**，复用它能保证与站卡/车卡视觉语言一致（需求原话）。
 *   但 `StationCard` 本体不能复用：它的 `props.station` 是站点模型，且挂载后会请求
 *   `/api/stations/<code>/eta` —— 机场/码头没有巴士 ETA，塞进去等于每次点开都打一个
 *   必然失败的请求（多一条噪声错误，还会被误当成后端故障）。
 */

import Icon from "@/components/ui/Icon";
import SetPointActions from "@/components/nav/SetPointActions";
import { xbHref, xbPinById } from "./xborder-pins";

interface XborderCardProps {
  /** 该组包含的地标 id（聚合点 2 个，单点 1 个） */
  ids: string[];
  onClose: () => void;
  /** ★ M4（需求 4）：导航语境 ⇒ 设点按钮整块不渲染（判定在 `SetPointActions` 内部） */
  navActive?: boolean;
  /**
   * ★ M4（需求 4）：**逐条设施**设点。回调收到的是该条地标的 `id`，宿主用
   * `xbPinById(id)` 取它**自己的**坐标 —— 聚合态两条各用自己的，不存在「取最近一个」。
   */
  onSetFrom?: (id: string) => void;
  onSetTo?: (id: string) => void;
}

export default function XborderCard({ ids, onClose, navActive = false, onSetFrom, onSetTo }: XborderCardProps) {
  const pins = ids.map(xbPinById).filter((p): p is NonNullable<typeof p> => !!p);
  /* 脏 id（理论上进不来）⇒ 不渲染半张空卡，直接交还给宿主的下次渲染 */
  if (!pins.length) return null;

  const isCluster = pins.length > 1;
  const title = isCluster ? pins.map((p) => p.name).join(" · ") : pins[0].name;
  const sub = isCluster ? "两个地点相邻，分别查看班次" : pins[0].sub;

  return (
    <div className="nav-xborder-card" role="dialog" aria-modal="false" aria-label={title}>
      <div className="nav-xborder-card__hd">
        <h2 className="nav-xborder-card__title">{title}</h2>
        <button type="button" className="nav-xborder-card__close" onClick={onClose} aria-label="关闭">
          <Icon name="close" size={20} />
        </button>
      </div>
      <p className="nav-xborder-card__sub">{sub}</p>

      <div className="nav-xborder-card__rows">
        {pins.map((p) => (
          /*
           * ★ M4（需求 4）：每条设施 = 「链接行 + 它自己的设点按钮」。
           *   为什么把 `<a>` 包进 `<div>` 而不是把按钮塞进 `<a>`：`<button>` 不能嵌在 `<a>`
           *   里（无效 HTML，点击会同时触发跳转）。设点按钮放在链接**下方**，各自独立。
           */
          <div className="nav-xborder-card__item" key={p.id} data-xb-item={p.id}>
            {/**
             * 必须是真正的 `<a href>`：整页跳转、地址栏变化、浏览器返回键可用（需求原话
             * 「整页替换、网址要变」）。用 `router.push` 也能换页，但会丢掉"这是链接"的
             * 全部语义（新标签打开、右键、无障碍读屏的都读作 link）。
             * `?from=map` 不可省：目标页只在 `from === "map"` 时把关闭键指回首页。
             */}
            <a className="nav-xborder-card__row" href={xbHref(p.id)} data-xb-go={p.id}>
              <span className="nav-xborder-card__row-main">
                <span className="nav-xborder-card__row-name">{p.name}</span>
                <span className="nav-xborder-card__row-sub">{p.sub}</span>
              </span>
              <span className="nav-xborder-card__row-action">{isCluster ? "查看班次" : "查看详细信息"}</span>
            </a>
            {onSetFrom && onSetTo && (
              /* 聚合态两条各用**自己**的坐标（p 就是这一条的 XbPin） */
              <SetPointActions
                navActive={navActive}
                onSetFrom={() => onSetFrom(p.id)}
                onSetTo={() => onSetTo(p.id)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
