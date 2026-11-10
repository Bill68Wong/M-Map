"use client";

/**
 * 图层面板（M4 · 需求 5/6）—— 右栏按钮点开的半屏面板。
 *
 * ── 几何：复用三档面板的 `half`，不新造一套 ───────────────────────────────
 *   `top` 直接取 `detentTopsPx(winH, safeTop)[detentIndex("half")]`（= 50vh），
 *   与推荐 / 详情 / 站序面板**同一个几何来源** ⇒ 三档面板换阈值时这里自动跟。
 *   为什么不做拖拽三档：本面板只有 5 行 + 2 个组标题，`peek` 档放不下、
 *   `full` 档留白过半屏；拖拽只会带来「拖到半空」的破面。**打开即 half，不提供档位**。
 *
 * ── 挂载位置（踩错就白干）────────────────────────────────────────────────
 *   `.nav-shell--full .nav-map-wrap` 是 `position:fixed; z-index:0`（`globals.css:2919`）
 *   ⇒ 本面板必须挂在 `NavShell` 里 `.nav-map-wrap` **之外**的兄弟位置，
 *   否则会被那个堆叠上下文困住、被 z70 的半屏面板压住。
 *
 * ── 开关的「一眼可辨」──────────────────────────────────────────────────
 *   不靠颜色微差：选中 = 实心方块 + 白色对钩，未选中 = 空心描边；同时 `aria-checked`
 *   与文案粗细一起变。色盲/强光下也能分辨。
 *
 * ── 首次标记 ───────────────────────────────────────────────────────────
 *   面板**第一次打开**时调一次 `markSeen()`（`seen` 只在这里与 `setLayer` 里置位）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/components/ui/Icon";
import { detentIndex, detentTopsPx, type Detent } from "./sheet-detents";
import { useSnapSheet } from "./useSnapSheet";
import { TOILET_ATTRIBUTION } from "@/lib/map/toilet-attribution";
import { LAYER_KEYS, type LayerKey } from "@/lib/map/layer-prefs";
import { useLayerPrefs } from "@/lib/map/useLayerPrefs";

/** 分组（负责人指定两组与顺序） */
const GROUPS: { title: string; keys: LayerKey[] }[] = [
  { title: "公共交通站点", keys: ["bus", "tqh", "pier", "airport"] },
  { title: "公共设施", keys: ["toilet"] },
];

/** 图层名的简体文案（UI 一律简体；数据名是繁體，两者不要混） */
const LABELS: Record<LayerKey, string> = {
  bus: "巴士站点",
  tqh: "通琴号站点",
  pier: "码头",
  airport: "机场",
  toilet: "公共厕所",
};

export interface LayerSheetProps {
  open: boolean;
  onClose: () => void;
  /** 视口高（px）；缺省按 844 退化，与 `detentTopsPx` 同口径 */
  winH?: number;
  safeTop?: number;
  /**
   * ★ M4（缺陷修复）：站点/公厕图层当前**是否达到缩放阈值**（由 `NavMap` 回写）。
   * 未达标时在面板里给出提示 —— 否则用户在 zoom 12.5 拨开公厕，屏幕上什么都不变，
   * 会判定「开关坏了」（实测真实症状，见 `.verify/probe-toilet-pins.py`）。
   */
  zoomOk?: boolean;
  /** 当前 zoom（仅用于提示文案，展示到小数点后 1 位） */
  zoom?: number;
}

export default function LayerSheet({ open, onClose, winH = 0, safeTop = 0, zoomOk = true, zoom = 0 }: LayerSheetProps) {
  const { prefs, available, setLayer, reset, markSeen } = useLayerPrefs();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  /**
   * ★ P2（需求 5/6 · team-lead 已批）：三档可拖，接 `useSnapSheet`。
   *
   * ── DOM 模型必须与 `RouteSheet` 一致（这是第一版失败的原因）──────────────
   *   `useSnapSheet` 的位移模型 = 「面板**全高**（`top:0;height:100dvh`）+ `translateY = topsPx[detent]`」。
   *   第一版我把「`bottom:0` + `max-height:62dvh` + `top=topsPx`」和它混用 ⇒ 双向偏移、
   *   面板被推出一屏（实测 Playwright 点不到第一行）。
   *   ⇒ 现在改成：面板占满全高，**只靠 `translateY` 定位**，内部自己滚动。
   */
  const [detent, setDetent] = useState<Detent>("half");
  const topsPx = useMemo(() => detentTopsPx(winH || 844, safeTop), [winH, safeTop]);
  const onDetentChange = useCallback((d: Detent) => setDetent(d), []);
  const sheet = useSnapSheet({
    open,
    detent,
    topsPx,
    onDetentChange,
    onDismiss: onClose,
    /* 图层面板不是全屏流：拉到最低档不整体拖没（关闭仍走 Esc / 点地图 / 再点按钮） */
    dismissible: false,
    sheetRef: panelRef,
  });

  /* 首次打开 ⇒ 标记已初始化（只写一次，内部判重） */
  useEffect(() => {
    if (!open || !mounted) return;
    markSeen();
  }, [open, mounted, markSeen]);

  useEffect(() => setMounted(true), []);

  /* Esc 关闭 + 打开时把焦点移进面板（无障碍基线，与其它浮层一致） */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => panelRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;

  /* 只用于观测属性（真定位由 translateY 完成） */
  const top = topsPx[detentIndex(detent)];

  return (
    <div className="layer-sheet" data-layer-sheet="on">
      {/* 遮罩：点空白即关（面板外的地图点击由 NavShell 的 onMapClick 兜底） */}
      <button className="layer-sheet__scrim" type="button" aria-label="关闭图层面板" onClick={onClose} />
      <div
        className="layer-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-label="图层"
        tabIndex={-1}
        ref={panelRef}
        onPointerDown={sheet.onPointerDown}
        onPointerMove={sheet.onPointerMove}
        onPointerUp={sheet.onPointerUp}
        style={{ ["--sheet-y-anim" as string]: `${Math.round(sheet.translateY)}px` }}
        data-layer-sheet-top={Math.round(top)}
        data-detent={detent}
      >
        {/* 抓手：拖它换档（3 档：full / half / peek） */}
        <div className="layer-sheet__grab" aria-hidden="true" />

        <div className="layer-sheet__head">
          <span className="layer-sheet__title">图层</span>
          <button className="nav-station-card__close" type="button" aria-label="关闭" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>

        {GROUPS.map((g) => (
          <section className="layer-sheet__group" key={g.title}>
            <h3 className="layer-sheet__group-title">{g.title}</h3>
            {g.keys.map((k) => {
              const on = prefs[k];
              return (
                <button
                  key={k}
                  type="button"
                  className={`layer-row${on ? " is-on" : ""}`}
                  role="switch"
                  aria-checked={on}
                  data-layer-key={k}
                  data-layer-on={on ? "1" : "0"}
                  onClick={() => setLayer(k, !on)}
                >
                  <span className="layer-row__box" aria-hidden="true">
                    {on && <Icon name="check" size={16} />}
                  </span>
                  <span className="layer-row__label">{LABELS[k]}</span>
                </button>
              );
            })}
          </section>
        ))}

        {/*
          缩放未达标提示（只管「为什么看不到图标」，不改变开关语义）。
          ⚠️ 文案**刻意不出现「15 级 / 12 级 / 当前 x 级」**（team-lead 2026-11-10 裁定）：
             「级」是开发者概念，用户看不懂；且阈值一改文案就得跟着改（脆）。
             用户只需要知道「要放大」——放大到能看见他自然会停。
             具体数字只留在 `data-layer-zoom-hint` 的 dev 观测与 `__qa` 里，不进 UI。
        */}
        {!zoomOk && (
          <p className="layer-sheet__hint" data-layer-zoom-hint="on" data-layer-zoom={zoom > 0 ? zoom.toFixed(1) : undefined}>
            放大地图后才会显示站点与公厕图标
          </p>
        )}

        <div className="layer-sheet__foot">
          <button className="btn btn--outline btn--sm" type="button" onClick={reset} data-layer-reset="on">
            恢复默认
          </button>
          {!available && (
            <p className="layer-sheet__hint" data-layer-readonly="on">
              无痕/隐私模式下本次设置不会被记住
            </p>
          )}
          {/* 公厕数据署名（需求 3 的合规位；不许删） */}
          <p className="layer-sheet__attr" data-toilet-attribution="on">
            {TOILET_ATTRIBUTION}
          </p>
        </div>
      </div>
    </div>
  );
}

/** 供宿主断言：面板包含的图层键（与 `LAYER_KEYS` 同源，防漂移） */
export const LAYER_SHEET_KEYS = LAYER_KEYS;
