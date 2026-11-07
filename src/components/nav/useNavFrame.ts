"use client";

/**
 * 取景指令 hook（src/components/nav/useNavFrame.ts，2026-09-25 · v2.14 · 07 §5.3 / AC-17）
 *
 * ── 解决什么 ──────────────────────────────────────────────────────────
 *   旧实现把取景意图做成 `view` 的可变对象，依赖 `snap`（面板档位）⇒ **换档/拖动会重取景**。
 *   本 hook 改为**显式指令**：只有 `pickPoint / go / openDetail / contextClose` 等**显式意图**
 *   才调用 `frame()`（tick 自增）；拖面板**不调用** ⇒ 拖动与落定后地图不动。
 *
 * ── 落定后仅被遮挡时微调 ──────────────────────────────────────────────
 *   `reframeOnSettle(slotTopPx)`：只在「上次为 fit-box 且新槽比上次更靠下（更遮挡）」时，
 *   用同一 box 重新取景一次；否则**不动**。
 *
 * ⚠️ NavMap 侧仍自算 fit（禁 `setBounds`/`setFitView`）——本 hook 只负责「何时下令」。
 */
import { useCallback, useRef, useState } from "react";

export type FrameMode = "dest-center-top" | "fit-two" | "fit-box" | "none";

export interface FrameBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export interface FrameCmd {
  mode: FrameMode;
  box?: FrameBox;
  slotTopPx?: number;
  /**
   * ★ v3.6.0 S5（步行跟随）：顶部被占高度（= safe-top + `--walkturn-h`）。
   * 与 `insetBottomPx` 任一存在时，`NavMap` 走"中带"算法（顶部横幅 + 底部面板两侧都占）；
   * **都不传 ⇒ 旧路径一行不改**（recommend/detail 取景不受影响）。
   */
  insetTopPx?: number;
  /** ★ v3.6.0 S5：底部被占高度（= 面板顶边 `topsPx[detentIndex]`） */
  insetBottomPx?: number;
  /**
   * ★ 2026-11-06（修复批 #6b）：**显式意图 ⇒ 解除让位锁**（默认 `false`，不传即旧行为）。
   *
   * ── 为什么需要 ──────────────────────────────────────────────────────────
   *   `NavMap` 有「让位锁」：用户一旦拖过 / 缩放过地图（`followState = "free"`），
   *   **一切自动取景都被跳过**（防止 GPS / 面板落定把用户刚摆好的视野夺走）。
   *   但「用户**主动选中**一条班次」是**显式意图**，不是自动行为 ——
   *   而真实路径恰恰是「先缩放/拖动地图找车，再点班次」⇒ 此时让位锁必然为 `free`
   *   ⇒ 不加这个开关，班次取景会被**静默跳过**：不报错、不提示，用户看到的还是原视野
   *   （= 需求没实现，且没有任何信号告诉你）。
   *
   * ── 与既有行为的一致性 ────────────────────────────────────────────────
   *   · 定位键（`locateTick`）本来就是这么做的：先 `setFollowState("follow")` 再居中；
   *   · 线路查看模式的取景**直接走相机**（`setBounds` / `setZoomAndCenter`），
   *     本来就不受让位锁约束 ⇒ 班次取景要与它同权，才谈得上「同一配方」。
   *   ⇒ **只有显式选择类指令会带 `force`**。不要给 GPS / 面板落定 / 数据到达类
   *     取景加 `force` —— 那等于废掉让位锁本身。
   */
  force?: boolean;
}

/** 交给 `NavMap` 的 `view` prop（含 tick：同模式连续触发也生效） */
export interface FrameView extends FrameCmd {
  tick: number;
}

export interface UseNavFrame {
  /** 传给 `NavMap` 的 `view` */
  view: FrameView;
  /** 显式下令取景（pickPoint / go / openDetail / contextClose） */
  frame: (c: FrameCmd) => void;
  /** 面板档位落定后：仅被遮挡时微调（拖动中不调用） */
  reframeOnSettle: (slotTopPx: number) => void;
}

export function useNavFrame(): UseNavFrame {
  const [view, setView] = useState<FrameView>({ mode: "none", tick: 0 });
  const tickRef = useRef(0);
  const lastRef = useRef<FrameCmd | null>(null);

  const frame = useCallback((c: FrameCmd) => {
    lastRef.current = c;
    tickRef.current += 1;
    setView({ ...c, tick: tickRef.current });
  }, []);

  const reframeOnSettle = useCallback(
    (slotTopPx: number) => {
      const last = lastRef.current;
      if (!last || last.mode !== "fit-box" || !last.box) return;
      // 仅「新槽更靠下（面板更高 ⇒ 更遮挡）」时才微调；否则不动（拖动/落定后地图保持）
      if (last.slotTopPx != null && slotTopPx <= last.slotTopPx + 4) return;
      frame({ ...last, slotTopPx });
    },
    [frame],
  );

  return { view, frame, reframeOnSettle };
}
