"use client";

/**
 * 跨境交通 · 列表取数（src/components/cross-border/useXbList.ts，2026-11-07）
 *
 * ── 一次打开只请求一次，无轮询 ──────────────────────────────────────────
 *   `cache: "no-store"`：政府接口数据每 5 分钟变，缓存旧表比空表更糟
 *   （用户会照着旧时刻去赶船）。轮询**不做** —— 会拿用户的流量去打政府接口，
 *   刷新由用户点「重试」或重新进入触发。
 *
 * ── 状态机三态（`loading | error | ok`）──────────────────────────────────
 *   `ok` 里还有两种"看起来空"的情况（`items` 为空 / `stale`），但那**不是错误**，
 *   是数据语义 ⇒ 交给 UI 用 `emptyReason` / `stale` 分别说人话（见 `xb-view.ts#emptyCopy`）。
 *   把"没有班次"渲染成"加载失败"是本批最容易犯的归因错误。
 *
 * ── 竞态 ───────────────────────────────────────────────────────────────
 *   `url` 变化（切离澳/抵澳）⇒ 旧请求 `abort()`，且用 `alive` 再兜一道：
 *   abort 之后仍可能有已排队的 `.then` 微任务，`alive=false` 让它无法写状态。
 *   否则"点抵澳、回来的却是离澳的表"这种错会静默发生（表里有数据，只是不是这一屏的）。
 */

import { useCallback, useEffect, useState } from "react";
import type { XbListResponse } from "@/lib/cross-border/types";

export type XbLoad<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; data: XbListResponse<T> };

export interface XbListHook<T> {
  state: XbLoad<T>;
  /** 用户点「重试」时调用（唯一的手动重取入口） */
  reload: () => void;
}

export function useXbList<T>(url: string): XbListHook<T> {
  const [state, setState] = useState<XbLoad<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    setState({ status: "loading" });

    void (async () => {
      try {
        const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
        if (!alive) return;
        /* `4xx/5xx` 一律 error。注意契约 §2.5：空态是 **200 + items:[]**，
           所以这里拿到非 2xx 一定是真错误，不存在"用状态码表示空"的情况。 */
        if (!res.ok) {
          setState({ status: "error" });
          return;
        }
        const body = (await res.json()) as XbListResponse<T>;
        if (!alive) return;
        if (body.ok !== true) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ok", data: body });
      } catch (e) {
        if (!alive) return;
        /* AbortError = 我们自己取消的（切板块/卸载），不是失败 */
        if ((e as Error)?.name === "AbortError") return;
        setState({ status: "error" });
      }
    })();

    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [url, nonce]);

  return { state, reload };
}
