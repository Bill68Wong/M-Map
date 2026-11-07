"use client";

/**
 * 线路全景页 · 客户端外壳（src/app/line/[code]/LineClient.tsx，v3.6.0 · S6）
 *
 * ── 分工 ────────────────────────────────────────────────────────────────
 *   `page.tsx`（服务端）已直出**首屏站序**（省一次自我 HTTP 往返），本文件负责
 *   三件纯客户端的事：**方向切换 / 懒加载报站 / 换乘列**。
 *
 * ── ★★ 坑①：两方向**不是反转**，必须重新请求 ────────────────────────────
 *   设计文档 §2.8 原写「切换后列表顺序反转」—— **实测不成立**。以 `1` 路为例：
 *     · `dir=0` 16 站 · `dir=1` 13 站（**站数都不同**）
 *     · 共享站台码仅 **2/16**，同下标同站码 **0** 个
 *   原因：往返走**不同侧的站台**，每个方向有自己的站台码。
 *   ⇒ 切方向必须 `GET /api/route-stops?dir=X` 重新取，**禁止** `stops.reverse()`，
 *     也**禁止**假设两方向站数相同。
 *
 * ── ★★ 坑③：轻轨零请求是**前端责任** ────────────────────────────────────
 *   `/api/station/eta?code=LRT-*` 后端是**支持**的（实测 200、返回时刻表），
 *   所以「轻轨不发报站请求」只能靠 `useLazyEta` 内部 `kind === "lrt"` 直接 return。
 *   同时**渲染层仍要输出** `data-eta="none"` + 页面级「暂无实时车辆数据」提示条（AC-46）。
 *
 * ── ★★ 坑④：换乘数据只有 `/api/stations`（~103KB）───────────────────────
 *   不新增接口：**复用首页 NavMap 已用 `force-cache` 拉过的同一个 URL**
 *   （`NavMap.tsx:1089` 的 `/api/stations?include=lrt&v=2`）⇒ 浏览器缓存直接命中，
 *   实际网络成本≈0。**URL 必须与它逐字一致**（含 `v=2`），否则就是另一条缓存键。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Icon from "@/components/ui/Icon";
import LineMapPane from "@/components/line/LineMapPane";
import LineStopList from "@/components/line/LineStopList";
import { useLazyEta } from "@/components/line/useLazyEta";
import {
  chipLabelOf,
  type LineShape,
  type RouteShapesResp,
  type RouteStopsResp,
  type RouteStopsOk,
  type StationsResp,
} from "@/lib/line/line-shared";
import { chipInkOf } from "@/lib/ui/chip-ink";
import { errorTextOf } from "@/lib/ui/error-text";

/** 与首页 NavMap 共用的站点大包 URL（**逐字一致**，否则缓存键不同） */
const STATIONS_URL = "/api/stations?include=lrt&v=2";

export interface LineClientProps {
  /** 服务端直出的首屏数据 */
  initial: RouteStopsOk;
}

export default function LineClient({ initial }: LineClientProps) {
  const router = useRouter();
  const [data, setData] = useState<RouteStopsOk>(initial);
  const [busy, setBusy] = useState(false);
  /**
   * ★ v3.6.0（AC-41 配套）：错误**分两类**，因为用户的下一步动作不同：
   *   · `notfound` —— 这条线路**不存在**（输错码 / 已停运）。
   *     给「重试」等于骗用户"再等等就好了"，而再试一万次也不会有 ⇒ 只给**返回搜索**。
   *   · `error` —— 服务真的挂了（500/502），重试是有意义的。
   *
   * 后端在 `/api/route-stops` 特意**保留 404 状态码**就是为这个区分留的口子
   * （见该 route 文件头「HTTP 语义」）。只按 `!r.ok` 一律译成「稍后再试」会把两者压平，
   * 属于把"可恢复"与"不可恢复"混为一谈。
   */
  const [err, setErr] = useState<{ kind: "notfound" | "error"; text: string } | null>(null);

  const [shapes, setShapes] = useState<LineShape[]>([]);
  const [mapLoading, setMapLoading] = useState(true);
  const [linesOfStation, setLinesOfStation] = useState<Map<string, string[]>>(new Map());

  const { code, kind, color, dirs, dir, label, stops } = data;
  const isLrt = kind === "lrt";
  const canRev = dirs.length > 1;
  /**
   * ★★ R6 裁决（2026-11-06）：线路标签**一律白字 + 官方线路色底（不加深）**。
   *
   *   ── 这里原本是什么（别照旧稿改回去）──────────────────────────────
   *   原为「行内注入 `chip` 的 bg 作底色 + ink 作字色」，即按 `chipInkOf()` **对比度自适应**：
   *   · 字色取 `chip` 的 ink 字段 ⇒ 浅底线路（`tone === "dark"`，如氹仔线 `#93d50a` 1.79:1、
   *     澳巴 `#C26D32` 3.80:1）转**深字**，与其余 4 族的白字不一致；
   *   · 底色取 `chip` 的 bg 字段 ⇒ 死带分支（`chip-ink.ts:87`）是 `mixBlack(raw, 14%)` = **加深底色**。
   *   两者都被 R6 明确否决。
   *
   *   ── 现在 ──────────────────────────────────────────────────────
   *   `chipInkOf()` 在本处**只剩一个用途**：判断底色是不是脏数据（非 6 位 hex）。
   *   · 脏数据 ⇒ `tone === "fallback"` ⇒ 不内联底色，交给 CSS 的
   *     `[data-chip-ink="fallback"]`（中性底 `--surface-2` + 深字 + 线路色小圆点）；
   *   · 正常 ⇒ 底色用 `color` **原值**（不加深），字色交给 `.linechip` 的 `#fff`。
   *   ⚠️ **不要**把字色改回内联（`chip` 的 ink 字段）—— 内联会盖掉 CSS 白字。
   *   ⚠️ **不要**把底色改回 `chip` 的 bg 字段 —— 死带线路（如石排湾 `#8a66c3`，L=0.1885）会被加深 14%。
   *   ⚠️ 补偿只走 `.linechip` 里的字重 + `text-shadow`，勿在 TSX 另加（R6 唯一允许的两种手段）。
   */
  const chip = useMemo(() => chipInkOf(color), [color]);

  /* ── 走向（线路级，与方向无关；只取一次）────────────────────────────── */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`/api/route-shapes?code=${encodeURIComponent(code)}`, { cache: "no-store" });
        const j = (await r.json()) as RouteShapesResp;
        if (alive) setShapes(j.shapes ?? []);
      } catch {
        if (alive) setShapes([]); // 取不到 ⇒ 走降级提示，不白屏
      } finally {
        if (alive) setMapLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [code]);

  /* ── 换乘列（复用 103KB 大包；force-cache 命中首页已拉过的那份）──────── */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(STATIONS_URL, { cache: "force-cache" });
        const j = (await r.json()) as StationsResp;
        if (!alive) return;
        const m = new Map<string, string[]>();
        for (const s of j.stations ?? []) {
          if (s.code && s.lines?.length) m.set(s.code, s.lines);
        }
        setLinesOfStation(m);
      } catch {
        /* 取不到 ⇒ 不显示换乘列（不阻塞站序与报站） */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* ── 报站懒加载（坑②③⑤⑥ 全在 hook 内守）─────────────────────────── */
  const { etaOf, registerEl } = useLazyEta(stops, code, kind);

  /* ── 切方向：**重新请求**，绝不 reverse（坑①）──────────────────────── */
  const nextDir = dirs[(dirs.indexOf(dir) + 1) % dirs.length] ?? dir;
  const switching = useRef(false);
  const switchDir = useCallback(async () => {
    if (!canRev || switching.current) return;
    switching.current = true;
    setBusy(true);
    setErr(null);
    try {
      const qs = new URLSearchParams({ code, dir: nextDir });
      const r = await fetch(`/api/route-stops?${qs}`, { cache: "no-store" });
      /** ★ 404 = 该方向不存在（或线路已停运）⇒ **不可恢复**，与「服务故障」分开报 */
      if (r.status === 404) {
        setErr({ kind: "notfound", text: "找不到这条线路" });
        return;
      }
      if (!r.ok) throw new Error(errorTextOf("upstream_error"));
      const j = (await r.json()) as RouteStopsResp;
      if (!j.ok) throw new Error(errorTextOf(j.error));
      setData(j);
      // 设计 §2.8：切向后滚动位置回到顶部
      window.scrollTo({ top: 0, behavior: "auto" });
    } catch (e) {
      setErr({
        kind: "error",
        text: e instanceof Error ? e.message : errorTextOf("upstream_error"),
      });
    } finally {
      setBusy(false);
      switching.current = false;
    }
  }, [canRev, code, nextDir]);

  const dirText = label ? `往 ${label.to}` : `方向 ${dir}`;

  return (
    <div className="lp-page" data-kind={kind}>
      {/* ── 顶栏（sticky）── */}
      <header className="lp-head">
        <button className="lp-head__back" type="button" onClick={() => router.back()} aria-label="返回">
          <Icon name="back" size={20} />
        </button>
        <div className="lp-head__title">
          <span
            className="linechip"
            data-chip-ink={chip.tone}
            /* R6：底色用官方线路色**原值**（脏底色 ⇒ undefined ⇒ 走 CSS 兜底分支）；字色不内联 */
            style={{ background: chip.tone === "fallback" ? undefined : color }}
          >
            {chip.dot && <i className="linechip__dot" style={{ background: chip.dot }} aria-hidden="true" />}
            {chipLabelOf(code, kind)}
          </span>
          <span className="lp-head__sub">
            {dirText} · 共 {stops.length} 站
          </span>
        </div>
        {canRev && (
          <button
            className="lp-head__rev"
            type="button"
            onClick={() => void switchDir()}
            aria-label="切换方向"
            aria-busy={busy}
            data-busy={busy ? "1" : undefined}
          >
            <Icon name="exchange" size={20} />
          </button>
        )}
      </header>

      {/* ── 走向小图（无 shape ⇒ 降级提示，坑⑤）── */}
      <LineMapPane
        routeCode={code}
        shapes={shapes}
        dir={dir}
        color={color}
        stops={stops}
        loading={mapLoading}
      />

      {/* ── 轻轨提示条（AC-46：隐藏报站列时本提示条**仍须存在**）── */}
      {isLrt && <p className="lp-notice">暂无实时车辆数据</p>}

      {err && (
        <div className="lp-notice lp-notice--err" role="alert">
          <p className="lp-notice__txt">{err.text}</p>
          {/*
            ★ 两类错误的动作**必须不同**：
              · notfound ⇒ 不提供「重试」（再试也没用），只给「返回搜索」重新选线路；
              · error    ⇒ 给「重试」，但**不做自动轮询**（避免故障时疯狂打后端）。
          */}
          <div className="lp-notice__acts">
            {err.kind === "error" && (
              <button type="button" className="btn btn--outline btn--sm" onClick={() => void switchDir()}>
                重试
              </button>
            )}
            <button
              type="button"
              className="btn btn--text btn--sm"
              onClick={() => {
                // 回搜索层（不是浏览器后退：用户可能是直接输 URL 进来的，后退会退出站点）
                router.push("/");
              }}
            >
              返回搜索
            </button>
          </div>
        </div>
      )}

      {/* ── 站序 ── */}
      <LineStopList
        stops={stops}
        color={color}
        etaOf={etaOf}
        registerEl={registerEl}
        linesOfStation={linesOfStation}
        lineCode={code}
      />

      <p className="lp-foot">
        线路数据来自交通事务局，实时到站仅供参考
      </p>
    </div>
  );
}
