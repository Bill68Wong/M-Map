/**
 * 首页 = 全屏地图 + 分步搜索（src/app/page.tsx，M Map 改版 S2 重构）
 *
 * ── 本次改造（Spec R1/R2/R4）───────────────────────────────────────────
 *   · **全屏地图**（`fixed`；底部让出「底部导航」带，保证高德 Logo/审图号可见）；
 *   · 顶部浮层 = 品牌字标 `M Map` + 定位按钮 + 目的地搜索条（点开分步弹层）；
 *   · **移除**旧大标题「澳门出行」与「通勤计时（旧版）」首页入口（旧计时改由 `/about` 进入）；
 *   · 底导两 tab（首页 / 路线收藏）。
 *
 * ── 地点对收藏回放（PRD §7.5 / 02 §2.3）───────────────────────────────
 *   `/favorites` 点「地点对」→ `/?<query>` → 本页解析出起终点**预填**，进入「可出发」态
 *   （**不自动跳结果页**，由用户确认后点「出发」）。
 *
 * ── 保留的能力 ────────────────────────────────────────────────────────
 *   · 地图懒加载、失败不阻塞（§Q7）；站点图层、实时报站信息卡；「起点不记忆」（R5）。
 */
import BottomNav from "@/components/BottomNav";
import NavShell from "@/components/nav/NavShell";
import { getPool } from "@/lib/db";
import { parseNavParams } from "@/lib/nav/nav-params";
import type { NavPoint } from "@/lib/nav/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 线路码 → 主题色（供搜索结果/收藏的线路标签渲染，§11.6） */
async function loadRouteColors(): Promise<Record<string, string>> {
  try {
    const res = await getPool().query(`SELECT code, color FROM routes WHERE color IS NOT NULL`);
    const m: Record<string, string> = {};
    for (const r of res.rows as { code: string; color: string }[]) m[r.code] = r.color;
    return m;
  } catch {
    return {};
  }
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // ★ JS Key 由服务端以 prop 传入（JS Key 本身可公开；安全密钥只在 /_AMapService 代理里）
  const jsKey = (process.env.AMAP_JS_KEY ?? "").trim();
  // ★ AC-16：自定义地图样式 ID（隐藏底图自带公交站点）；**空字符串 = 用默认样式（降级安全）**
  const mapStyleId = (process.env.AMAP_MAP_STYLE_ID ?? "").trim();
  const colors = await loadRouteColors();

  // ★ v3.8.0 开屏动画已上移到根 `layout.tsx`（挂本页会让深链进内页/分享链接整页加载不播）。
  //   本页不再参与开屏逻辑，也不读 cookie。

  // 地点对收藏回放：URL 带 `fromLng…&toLng…` → 预填起终点（进「可出发」态）
  const sp = await searchParams;
  const parsed = parseNavParams(sp);
  const initialFrom: NavPoint | null = parsed?.origin ?? null;
  let initialTo: NavPoint | null = parsed?.dest ?? null;
  /**
   * 单值取名（`?a=1&a=2` 取首个）。
   *
   * ⚠️ 原先这行只声明在下面 `if (!initialTo)` 的**块作用域**里；需求 4 要在块外读 `board`
   *    ⇒ 必须提到块外。不要改回块内（块内声明在块外不存在 ⇒ `tsc` 直接报
   *    `Cannot find name 'first'`，而不是运行期才炸）。
   */
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  /**
   * ★ 需求 4：`/cross-border` 的「通琴号」卡用 `/?board=tqh&no=A1` 指向首页的通琴号板块。
   *
   * ── 改前为什么"点了没反应"──────────────────────────────────────────────
   *   本页只解析 `from` / `to*`（`parseNavParams` + 下面单独解「只有终点」的形态）
   *   ⇒ `board` / `no` 一路无人读取，被静默丢弃。
   *
   * ── 口径（负责人裁定，逐条落地）──────────────────────────────────────
   *   · `board` **严格相等**白名单：只认 `"tqh"`；未知值 / 空值一律当没传 ——
   *     不做前缀匹配、不做包含匹配（与 `/cross-border` 的 `from` 同口径）。
   *   · `no` **完全不接**：落点只到「公共交通路线 → 通琴号板块」，
   *     **不自动选中/弹出 A1 站序面板**。故此处既不读 `no`，也不向 `NavShell` 透传
   *     —— 连 `const _no = …` 这种占位都不留（`eslint.config.mjs` 的
   *     `no-unused-vars` 只豁免 `^_` 参数、不豁免变量，留着会让 lint 红）。
   *   · 兜底由 `RouteLinesSheet` 自己的 `defaultBoard = "bus"` 承担。
   */
  const tqhBoard = first(sp.board) === "tqh";
  /**
   * ★ v3.3.0（AC-116 · 收藏地点回放）：**仅 `to…`** 的 URL（起点留空 ⇒ 首页默认「我的位置」）。
   * `parseNavParams` 要求 from/to 同时存在 ⇒ 这里单独解析「只有终点」的形态，
   * 让「点地点卡 = 首页式选点（目的地已设、不自动规划）」成立。
   */
  if (!initialTo) {
    const toLng = Number(first(sp.toLng));
    const toLat = Number(first(sp.toLat));
    if (Number.isFinite(toLng) && Number.isFinite(toLat) && toLng !== 0 && toLat !== 0) {
      const kindRaw = first(sp.toKind);
      const kind = (["gps", "poi", "station", "place"].includes(kindRaw) ? kindRaw : "poi") as NavPoint["kind"];
      const code = first(sp.toCode) || undefined;
      initialTo = { kind, label: first(sp.toLabel) || "终点", lng: toLng, lat: toLat, code };
    }
  }

  return (
    <>
      <NavShell
        jsKey={jsKey}
        mapStyleId={mapStyleId}
        colors={colors}
        initialFrom={initialFrom}
        initialTo={initialTo}
        initialBoard={tqhBoard}
      />
      {/* ★ v2.10.0：底部合规条**已从地图页移除**（内容迁至 `/help`），
          既解决「选线路弹窗被底部遮挡」，也避免与底导重复。
          `/nav`、`/nav/detail`、`/favorites` 仍各自保留合规条（未受影响）。 */}
      <div className="home-chrome">
        <BottomNav />
      </div>
    </>
  );
}
