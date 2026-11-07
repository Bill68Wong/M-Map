"use client";

/**
 * POI 搜索框（src/components/nav/PoiSearchBox.tsx，v1.3.0 · T04；v2.0.1 改「搜索按钮」交互）
 *
 * ── 两段式搜索（设计 §2.A.6 / R5 · ★ 搜索优化 2026-09-21 修订）──────────
 *   · **打字**（防抖 300ms）→ `/api/poi/suggest?mode=type` —— **本地别名库，0 配额**、秒回；
 *     下拉候选**只有巴士站 / 轻轨站**（服务端已过滤线路名与地点类，见 `suggestLocal`）。
 *   · **点【搜索】按钮** → `/api/poi/suggest?mode=enter` —— **总是**调高德，
 *     与本地结果合并返回（旧版「本地已有命中就短路」已废止，见 `poi-search.ts` 文件头）。
 *   ★ 【7②】v2.0.1：**主入口从「回车」改为「输入框右侧的搜索按钮」**（产品口径）。
 *     键盘 Enter **仍可用**（对桌面端友好），但按钮是显式入口。
 *
 * ── 结果呈现（★【7①】v2.0.1）──────────────────────────────────────────
 *   · 每条结果标**类型徽章**：「公交站」/「轻轨站」/「地点」——让用户知道这是**站点**而非想去的地点；
 *     ⚠️ 「地点」徽章现在只出现在**点搜索后的高德结果**里（打字阶段的下拉已不含地点类候选）；
 *   · 巴士站名带**站编号**（`M1 關閘總站`）；
 *   · 界面文案一律**简体**；站名/线路名保留繁体原文。
 *
 * ── 界面约定 ──────────────────────────────────────────────────────────
 *   · **不记忆**出发点（产品 R5 明确：不用 localStorage）。
 *   · 交互反馈（§11.1/§11.2）：键入即上屏 + focus 描边；防抖后下拉区**行内 loading**；
 *     搜索按钮按压回弹（全局 `button:active` spring）；失败/无匹配给**行内灰字**（不整屏）。
 */
import { useEffect, useRef, useState } from "react";
import RouteStack from "@/components/RouteStack";
import type { NavPoint, PoiKind, PoiSearchResult, PoiSuggestResponse } from "@/lib/nav/types";

export interface PoiSearchBoxProps {
  /** 输入框标签（简体，如「起点」「目的地」） */
  label: string;
  value: NavPoint | null;
  onChange: (p: NavPoint) => void;
  /** 用户当前位置（GCJ-02）——仅用于结果排序 */
  userPos?: { lng: number; lat: number } | null;
  /** 线路码 → 主题色（用于「线路候选」行渲染 `.route-stack`，§11.6） */
  colors?: Record<string, string>;
  placeholder?: string;
  autoFocus?: boolean;
}

const DEBOUNCE_MS = 300;

/** ★ 【7①】结果类型徽章文案（简体）——明确「这是公交站 / 轻轨站 / 地点」 */
const TYPE_LABEL: Record<PoiKind, string> = {
  station: "公交站",
  lrt_station: "轻轨站",
  place: "地点",
  poi: "地点",
};

/** 结果的显示名：**巴士站**带站编号（`M1 關閘總站`）；轻轨站/地点用原名（轻轨码 LRT-* 不展示） */
function displayName(r: PoiSearchResult): string {
  if (r.kind === "station" && r.code && !r.name.startsWith(`${r.code} `)) {
    return `${r.code} ${r.name}`;
  }
  return r.name;
}

function toNavPoint(r: PoiSearchResult): NavPoint {
  return {
    kind: r.kind === "station" || r.kind === "lrt_station" ? "station" : r.kind === "place" ? "place" : "poi",
    label: displayName(r),
    lng: r.lng,
    lat: r.lat,
    code: r.code,
  };
}

export default function PoiSearchBox({
  label,
  value,
  onChange,
  userPos,
  colors,
  placeholder,
  autoFocus,
}: PoiSearchBoxProps) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<PoiSuggestResponse | null>(null);
  const [err, setErr] = useState<string>("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 点击外部关闭
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // ★ v2.1.0：外部设点（地图信息卡「设为起点/目的地」等）→ 同步到输入框显示。
  //   缺口背景：输入框显示的是**内部状态 `q`**，而外部传入的 `value`（NavPoint）原先
  //   从不写入 `q`（只有组件内部 pick()/onInput() 会更新）—— v1.3.0 只有「内部选择」
  //   一条路径故未暴露；#3 新增「地图设点」这条**外部设点**路径后缺口显现。
  //   `value` 为 null 时不覆盖（保留用户正在输入的内容）。
  // ★ 守卫：仅当外部 label 变化时才同步（避免「用户输入中被父组件重渲染覆盖」）。
  const lastSyncedLabelRef = useRef<string | null>(null);
  useEffect(() => {
    if (!value) return;
    if (lastSyncedLabelRef.current === value.label) return;
    lastSyncedLabelRef.current = value.label;
    setQ(value.label);
  }, [value]);

  /**
   * 搜索。
   * @param forceAmap ★ 修复包 v2.2.1-B7：强制走高德（跳过服务端「本地已有带坐标命中就短路」）
   * @returns 响应对象（供调用方判定/自动选中）；无关键字或失败 → null
   */
  async function query(
    keyword: string,
    mode: "type" | "enter",
    forceAmap = false,
  ): Promise<PoiSuggestResponse | null> {
    const s = keyword.trim();
    if (!s) {
      setResp(null);
      setOpen(false);
      return null;
    }
    setLoading(true);
    setErr("");
    try {
      const sp = new URLSearchParams({ q: s.slice(0, 50), mode });
      if (forceAmap) sp.set("forceAmap", "1");
      if (userPos) {
        sp.set("lat", String(userPos.lat));
        sp.set("lng", String(userPos.lng));
      }
      const res = await fetch(`/api/poi/suggest?${sp.toString()}`, { cache: "no-store" });
      const json = (await res.json()) as PoiSuggestResponse;
      setResp(json);
      setOpen(true);
      return json;
    } catch {
      setErr("搜索暂不可用，请稍后再试");
      setOpen(true);
      return null;
    } finally {
      setLoading(false);
    }
  }

  function onInput(v: string) {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void query(v, "type"), DEBOUNCE_MS);
  }

  /** ★ 【7②】点【搜索】按钮（或回车）：走「本地优先 + 高德兜底」 */
  function runSearch() {
    if (timer.current) clearTimeout(timer.current);
    void query(q, "enter");
  }

  function pick(r: PoiSearchResult) {
    onChange(toNavPoint(r));
    setQ(displayName(r));
    setOpen(false);
  }

  /**
   * ★ 修复包 v2.2.1-B7（FIX-10）：点「点搜索确认」行 —— 本地命中但**无坐标**。
   *
   * 旧实现用**同一个查询串**再发一次 `mode=enter`，而服务端规则是「本地已有**带坐标**命中
   * 就短路、不调高德」——该查询恒有本地带坐标命中（如 M70/M71）⇒ 高德**永不触发**、
   * 返回逐字节相同、`setQ(name)` 又把输入设成同一文本 ⇒ **点击表现为完全无反应**（目的地从未写入）。
   *
   * 现改为：**强制走高德**（`forceAmap=1`）→ 拿到坐标后**自动选中最佳一条** ⇒ 一次点击即写入目的地。
   * 高德也无结果 → 保留下拉并给行内灰字提示（不再静默无反应）。
   */
  async function pickPending(name: string) {
    setQ(name);
    const json = await query(name, "enter", true);
    const top = json?.results?.[0];
    if (top) {
      pick(top);
      return;
    }
    setErr("这条地点暂时确认不到坐标 · 换个说法试试");
  }

  const results = resp?.results ?? [];
  const pending = resp?.pending ?? [];
  const hint = resp?.hintText;

  return (
    <div className="nav-sbox" ref={boxRef}>
      <label className="nav-sbox__label t-label">{label}</label>
      <div className={`nav-sbox__field${open ? " nav-sbox__field--open" : ""}`}>
        <input
          className="inp nav-sbox__inp"
          value={q}
          onChange={(e) => onInput(e.target.value)}
          onFocus={() => q.trim() && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              runSearch();
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={placeholder ?? `输入目的地`}
          autoFocus={autoFocus}
          aria-label={label}
          inputMode="search"
        />
        {loading && <span className="nav-sbox__spin" aria-label="搜索中" />}
        {/* ★ 【7②】输入框右侧的搜索按钮（主入口）；Enter 仍可用（桌面友好） */}
        <button
          type="button"
          className="nav-sbox__go"
          onClick={runSearch}
          disabled={loading || !q.trim()}
          aria-label={`${label}搜索`}
          title="搜索站点或地点"
        >
          搜索
        </button>
      </div>

      {open && (
        <div className="nav-sbox__drop">
          {results.map((r, i) => (
            <button key={`${r.name}-${i}`} type="button" className="nav-sbox__row" onClick={() => pick(r)}>
              {/* ★ 【7①】类型徽章：公交站 / 轻轨站 / 地点 */}
              <span className={`nav-sbox__type nav-sbox__type--${r.kind}`}>{TYPE_LABEL[r.kind] ?? "地点"}</span>
              <span className="nav-sbox__name">{displayName(r)}</span>
              {/* ★ v3.3.0（AC-104）：来源字串去「来自」→ 仅「高德」；搜索结果**不显示区名**（district 不渲染） */}
              {r.source !== "local" && <span className="nav-sbox__badge">高德</span>}
              {r.address && <span className="nav-sbox__meta t-muted">{r.address}</span>}
              {typeof r.distM === "number" && <span className="nav-sbox__meta t-muted">{r.distM} m</span>}
            </button>
          ))}
          {pending.map((p, i) => (
            <button
              key={`p-${p.name}-${i}`}
              type="button"
              className="nav-sbox__row nav-sbox__row--pending"
              onClick={() => pickPending(p.name)}
              title="点「搜索」获取精确位置"
            >
              {/* ★ 搜索优化（2026-09-21）：pending 现在只可能是「无坐标的站点」
                  ⇒ 徽章按真实类型渲染，不再硬编码「地点」 */}
              <span className={`nav-sbox__type nav-sbox__type--${p.targetKind}`}>
                {TYPE_LABEL[p.targetKind as PoiKind] ?? "站点"}
              </span>
              {/*
                * ⚠️ **本分支不可达**（2026-11-06 实证，勿据此排工期）：
                *   `poi-search.ts:159-174` 把 `targetKind === "route"` 的命中**先分流到独立分区
                *   `routes`**，随后 `continue`；`:183` 又只放行 `station` / `lrt_station` 进 `pending`。
                *   ⇒ `pending[].targetKind` 的值域**不含 `route`**，这里永远不会渲染。
                *
                *   保留原因（两条，缺一不可）：
                *   ① **类型收窄**：`pending` 的元素类型仍含 `route`，删掉分支 `tsc` 会报可能为 undefined；
                *   ② **防将来可达**：若哪天 `poi-search` 改回把 route 放进 `pending`，此处必须能显示线号。
                *
                *   与 `SearchSheet.tsx:213/218` 的同类防御**同一口径** —— 那边有「不可达」说明，
                *   这边此前没有，看代码的人会以为可达并「修」出一个假 bug。
                */}
              {p.targetKind === "route" ? (
                <RouteStack codes={[p.name]} colorOf={(c) => colors?.[c] ?? null} />
              ) : (
                <span className="nav-sbox__name">{p.name}</span>
              )}
              <span className="nav-sbox__badge nav-sbox__badge--soft">点搜索确认</span>
            </button>
          ))}
          {!loading && !results.length && !pending.length && (
            <p className="nav-sbox__hint t-muted">{hint ?? (err || "找不到这个地点 · 试试换个说法")}</p>
          )}
          {!!results.length && hint && <p className="nav-sbox__hint t-muted">{hint}</p>}
        </div>
      )}
    </div>
  );
}
