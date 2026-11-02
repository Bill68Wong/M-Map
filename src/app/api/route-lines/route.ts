/**
 * GET /api/route-lines —— 全部线路清单（「公共交通路线」弹窗的数据源）
 * （2026-09-22 新增）
 *
 * ── 用途 ──────────────────────────────────────────────────────────────
 *   全屏弹窗：**轻轨 3 条排第一行**（氹仔線 → 石排灣線 → 橫琴線），
 *   下面是 97 条巴士（**数字优先 + 字母后缀**，夜班 N 开头垫底）。
 *   每条带**主题色**（`routes.color`）供卡片底色。
 *
 * ── 排序规则（产品口径 2026-09-22）────────────────────────────────────
 *   1. 轻轨永远在最前，固定顺序：氹仔線 < 石排灣線 < 橫琴線
 *   2. 巴士：
 *      · 纯数字线（`1`/`26`/`102`）按**数值**升序；
 *      · 带字母后缀的（`1A`/`25AX`/`51B`）排在同数字之后（`1` → `1A` → `2` …）；
 *      · `N` 开头的夜班线（`N1`/`N6`）**垫底**（用户口径）。
 *   3. 其余（异常码）排最后，按字典序。
 *
 * 只读接口（不写库）。
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { API_ERROR } from "@/lib/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * ★ v3.7.0（缓存专项）：本接口是**线路元数据**（码 / kind / 展示名 / 主题色），
 *   不含任何实时量（无车辆、无到站时刻）⇒ 符合缓存红线，允许 CDN 与浏览器双层缓存。
 *
 * ⚠️ **必须同时给 `max-age`**：只写 `s-maxage` 时 Vercel 会把它从浏览器可见头里剥掉，
 *   前端拿不到浏览器缓存 ⇒ 只能退回 `force-cache`（现存违规的成因）。缓存只应在一层管。
 */
const CACHE_HEADER = {
  "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
};

interface Row {
  code: string;
  kind: string;
  color: string | null;
  company: string | null;
}

/** 排序键：`[组, 主数, 后缀]` —— 组 0=轻轨 / 1=数字巴士 / 2=N 夜班 / 3=其他 */
function sortKey(code: string, kind: string): [number, number, string, string] {
  if (kind === "lrt") {
    const order = { "LRT-氹仔线": 0, "LRT-石排湾线": 1, "LRT-横琴线": 2 } as Record<string, number>;
    return [0, order[code] ?? 9, "", code];
  }
  if (/^N/i.test(code)) {
    const m = /^N(\d+)(.*)$/i.exec(code);
    return [2, m ? Number(m[1]) : 9999, m?.[2] ?? "", code];
  }
  const m = /^(\d+)(.*)$/.exec(code);
  if (m) return [1, Number(m[1]), m[2], code];
  return [3, 9999, "", code];
}

export async function GET() {
  try {
    const res = await getPool().query(
      `SELECT code, kind, color, company FROM routes WHERE is_active`,
    );
    const rows = res.rows as Row[];
    rows.sort((a, b) => {
      const ka = sortKey(a.code, a.kind);
      const kb = sortKey(b.code, b.kind);
      for (let i = 0; i < 4; i++) {
        if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
      }
      return 0;
    });
    return NextResponse.json(
      {
        lines: rows.map((r) => ({
          code: r.code,
          kind: r.kind === "lrt" ? "lrt" : "bus",
          // 轻轨标签去掉 `LRT-` 前缀（与站点卡口径一致：只显示中文名）
          label: r.kind === "lrt" ? r.code.replace(/^LRT-/, "") : r.code,
          color: r.color ?? "#276299",
        })),
      },
      { headers: CACHE_HEADER },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/route-lines] 失败：", msg);
    // ★ v3.6.0（S2）：保留 `lines: []` 数组形状（客户端按 j.lines 取值），只把 error 换成枚举。
    return NextResponse.json({ lines: [], error: API_ERROR.upstream_error }, { status: 500 });
  }
}
