"use client";

/**
 * 公共交通路线选择弹窗（src/components/nav/RouteLinesSheet.tsx，2026-09-22 新增）
 *
 * ── 形态（产品口径）───────────────────────────────────────────────────
 *   · **全屏弹窗**（不是独立页面 —— 用户明确要求：避免页面加载带来的卡顿感）；
 *   · **轻轨第一行**：3 张较宽的卡片，固定顺序 氹仔線 → 石排灣線 → 橫琴線；
 *   · **巴士在下**：**7 列网格**（390px 宽下每格约 50px，够放 `25AX` 这种 4 字符）；
 *   · 卡片 = **方形 + 线路主题色底 + 白色文字 + 不换行**；
 *   · ⚠️ **全部线路必须在标准手机屏内显示完，弹窗内不可滚动**（产品硬要求）
 *     ⇒ 尺寸按 390×844 标定：可用高 ≈ 700px，轻轨 1 行 + 巴士 14 行 × 40px ≈ 600px ✓
 *
 * ── 数据 ──────────────────────────────────────────────────────────────
 *   `GET /api/route-lines`（已按「数字优先 + 字母后缀 + N 垫底」排好序）。
 */
import { useEffect, useMemo, useState } from "react";
import Icon from "@/components/ui/Icon";
import { errorTextOf } from "@/lib/ui/error-text";

export interface RouteLineItem {
  code: string;
  kind: "bus" | "lrt";
  /** 展示文字（轻轨已去 `LRT-` 前缀） */
  label: string;
  color: string;
}

export interface RouteLinesSheetProps {
  onPick: (line: RouteLineItem) => void;
  onClose: () => void;
}

export default function RouteLinesSheet({ onPick, onClose }: RouteLinesSheetProps) {
  const [lines, setLines] = useState<RouteLineItem[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    /**
     * ★ v3.7.0（P2 · 去强缓存）：不再传 `cache: "force-cache"`。
     *   服务端已给 `/api/route-lines` 下发 `s-maxage` + 浏览器可见 `max-age` ⇒ 浏览器自己缓存；
     *   再叠 `force-cache` 会造成「两层缓存各管一段」，发版后拿不到新线路清单（同 09-21 事故）。
     *   URL 里既有的 `?v=` 保留（结构变更时的强制失效手段），但不新增手写版本号。
     */
    fetch("/api/route-lines")
      .then((r) => r.json())
      .then((j: { lines?: RouteLineItem[]; error?: string }) => {
        if (!alive) return;
        const list = Array.isArray(j.lines) ? j.lines : [];
        /**
         * ★ v3.6.0：降级时接口会返回 `{ lines: [], error: "upstream_error" }`。
         *   ① 有 error **且**清单为空 ⇒ 显示提示（过了 `errorTextOf`，不把枚举上屏）；
         *   ② 有 error 但清单**非空**（部分降级）⇒ **不报错**，照常展示已有线路，
         *      否则一次上游抖动就把整个面板变成错误态。
         */
        if (j.error && list.length === 0) setErr(errorTextOf(j.error));
        setLines(list);
      })
      .catch(() => {
        if (alive) {
          setErr("线路清单加载失败");
          setLines([]);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const lrt = useMemo(() => (lines ?? []).filter((l) => l.kind === "lrt"), [lines]);
  const bus = useMemo(() => (lines ?? []).filter((l) => l.kind !== "lrt"), [lines]);

  return (
    <div className="rl-sheet" role="dialog" aria-modal="true" aria-label="公共交通路线">
      <div className="rl-sheet__bar">
        <span className="rl-sheet__title">公共交通路线</span>
        <button type="button" className="rl-sheet__close" onClick={onClose} aria-label="关闭">
          <Icon name="close" size={20} />
        </button>
      </div>

      <div className="rl-sheet__body">
        {err && <p className="rl-sheet__hint t-label">{err}</p>}
        {!lines && <p className="rl-sheet__hint t-label">载入中…</p>}

        {lines && (
          <>
            {/* 轻轨行：3 张较宽卡片 */}
            <div className="rl-sheet__lrt">
              {lrt.map((l) => (
                <button
                  key={l.code}
                  type="button"
                  className="rl-chip rl-chip--lrt"
                  style={{ background: l.color }}
                  onClick={() => onPick(l)}
                  title={l.label}
                >
                  {l.label}
                </button>
              ))}
            </div>

            {/* 巴士：7 列网格 */}
            <div className="rl-sheet__bus">
              {bus.map((l) => (
                <button
                  key={l.code}
                  type="button"
                  className="rl-chip rl-chip--bus"
                  style={{ background: l.color }}
                  onClick={() => onPick(l)}
                  title={l.code}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
