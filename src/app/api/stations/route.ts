/**
 * GET /api/stations —— 全量**站点**列表（v2.1.0 · 首页/导航页地图站点图层）
 *
 * ── 定位（产品口径 2026-09-19；v2.10.0 扩展）────────────────────────────
 *   首页地图在**放大到阈值后**显示屏幕内的站点。前端一次性拉全量站点并缓存，
 *   移动/缩放时只在**本地**做视野裁剪 —— 交互过程中**零请求** ⇒ 完全不卡。
 *
 * ── 输出 ──────────────────────────────────────────────────────────────
 *   `{ stations: { code(主码), name(繁体), lat, lng, kind, lines, colors, color?, color2? }[] }`
 *   · `kind`：`include=lrt` 时含轻轨行，否则**只取巴士站**（产品口径）。
 *   · 按【主码】去重（同站多站台 `M9/2·M9/3` 合成一个圆点）。
 *
 * ── ★ v2.10.0 新增字段（线路色随站点下发；Spec §8 / AC-10）──────────────
 *   设计铁律：**线路色是数据，绝不写进 CSS**（CSS 只写渐变/形状的**结构**）。
 *   · `lines`  ：该站停靠的线路码（去重；如 `["LRT-氹仔线","LRT-石排湾线"]` 或 `["26","50"]`）
 *   · `colors` ：与 `lines` **一一对应**的 `routes.color`（仅保留非空色，顺序与 `lines` 对齐）
 *   · `color`  ：**轻轨站**主色（`--c1`）—— 单线站取该线色；换乘站按 Spec §8 取 c1
 *   · `color2` ：**换乘站**第二色（`--c2`）—— 仅蓮花 / 協和醫院
 *   ⚠️ 颜色**只能**来自 `routes.color`（数据）；本文件仅编码「换乘站 c1/c2 用哪条线」的**顺序**，
 *      颜色本身仍查库 ⇒ 满足 P0「禁止硬编码颜色」。
 *   ⚠️ 前端 `NavMap` 读的是 `color` / `color2`（单数字段），`lines`/`colors` 为对齐口径的旁路数据。
 *
 * ── ★ 坐标系铁律（§0-5）───────────────────────────────────────────────
 *   库内 `stations` 是 **WGS84**（DSAT 原始），高德地图要 **GCJ-02** ⇒ 在服务端
 *   用 `wgs84ToGcj02()` 转换后再返回（前端**不再**转换）。澳门适用 GCJ-02，已实测（coord.ts）。
 *
 * ── 缓存 ──────────────────────────────────────────────────────────────
 *   站点 / 线路色静态、低频变更 ⇒ 响应头 `s-maxage=3600`（CDN/边缘缓存 1h）。
 *
 * 幂等：只读，无副作用。
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { wgs84ToGcj02 } from "@/lib/amap/coord";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import { API_ERROR } from "@/lib/http/errors";

/** 就近部署：Supabase 新加坡池化器 → sin1；pg 需要 Node 运行时；请求期动态执行 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

interface StationPoint {
  /** 我们库【主码】（已去站台后缀） */
  code: string;
  /** 站名（繁体官方原文） */
  name: string;
  /** 经度（**GCJ-02**，高德地图可直接用） */
  lng: number;
  /** 纬度（GCJ-02） */
  lat: number;
  /** ★ 2026-09-22：载具种类 —— 前端据此区分巴士站 / 轻轨站（`include=lrt` 时才有轻轨行） */
  kind: "bus" | "lrt";
  /** ★ v2.10.0：该站停靠的线路码（去重） */
  lines: string[];
  /** ★ v2.10.0：与 `lines` 一一对应的线路色（`routes.color`） */
  colors: string[];
  /** ★ v2.10.0：**轻轨站**主色（`--c1`；换乘站按 Spec §8 取 c1） */
  color?: string;
  /** ★ v2.10.0：换乘站第二色（`--c2`；仅蓮花 / 協和醫院） */
  color2?: string;
}

/**
 * ★ v2.10.0：换乘站的 `color`/`color2` = 哪条线的色 —— **严格按 Spec §8 的顺序**。
 * ⚠️ 这里只编码**线路码的顺序**（谁当 c1），**颜色本身仍取 `routes.color`**（颜色是数据）。
 *   · 蓮花（`LRT-LOT`）：斜切 —— 左下橫琴紅（c1）/ 右上氹仔綠（c2）
 *   · 協和醫院（`LRT-UH`）：水平切 —— 上氹仔綠（c1）/ 下石排灣紫（c2）
 */
const LRT_TRANSFER_ORDER: Record<string, [string, string]> = {
  "LRT-LOT": ["LRT-横琴线", "LRT-氹仔线"],
  "LRT-UH": ["LRT-氹仔线", "LRT-石排湾线"],
};

export async function GET(req: Request) {
  try {
    // ★ 2026-09-22：新增可选参数 `include=lrt`（含轻轨）。
    //   为什么不默认带上：本接口原先被**首页地图站点图层**使用，口径是「只标巴士站」
    //   （产品 2026-09-19 拍板）；直接改成含轻轨会**改变首页既有表现**。
    //   ⇒ 用参数区分：首页不传（保持原样），导航页传 `include=lrt`（新需求：地图要有轻轨站）。
    const includeLrt = new URL(req.url).searchParams.get("include") === "lrt";
    const kinds = includeLrt ? `kind IN ('bus','lrt')` : `kind = 'bus'`;

    const pool = getPool();

    // ★ v2.10.0：两条查询**并行**（独立、无依赖）。
    //   ① 站点本体（原有）；② 站点↔线路色（新增，联表 `route_stations` → `routes`）。
    //   ⚠️ ②**单独 catch**（失败降级为「无线路色」）—— 站点图层比颜色重要，绝不让它拖垮整体 500。
    //   ⚠️ ② 一次查出全部（约 500 行 / 去重后更少），**绝不放进循环**（防 N+1）。
    const [res, colorRes] = await Promise.all([
      pool.query(
        `SELECT code, name_tc, lat, lng, kind
           FROM stations
          WHERE ${kinds} AND lat IS NOT NULL AND lng IS NOT NULL`,
      ),
      pool
        .query(
          `SELECT rs.station_code, r.code AS route_code, r.color
             FROM route_stations rs
             JOIN routes r ON r.id = rs.route_id
            WHERE r.is_active`,
        )
        .catch((e: unknown) => {
          console.warn("[api/stations] 线路色查询失败（lines/colors 置空）：", (e as Error).message);
          return { rows: [] as Record<string, unknown>[] };
        }),
    ]);

    // ── 内存聚合：主码 → 该站线路（去重；`routes.color` 为空的一对**整对丢弃**，保证 lines/colors 对齐）──
    const linesByMain = new Map<string, [string, string][]>(); // main → [[routeCode, color], ...]
    {
      const acc = new Map<string, Map<string, string>>();
      for (const row of colorRes.rows as Record<string, unknown>[]) {
        const rawCode = String(row.station_code ?? "");
        const routeCode = String(row.route_code ?? "");
        const color = row.color != null ? String(row.color).trim() : "";
        if (!rawCode || !routeCode || !color) continue; // 过滤 null/空色
        const main = mainCodeOf(rawCode);
        let m = acc.get(main);
        if (!m) {
          m = new Map();
          acc.set(main, m);
        }
        if (!m.has(routeCode)) m.set(routeCode, color);
      }
      // 线路码字典序 ⇒ 输出稳定（缓存友好）
      for (const [main, m] of acc) {
        linesByMain.set(
          main,
          [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])),
        );
      }
    }

    // 按【主码】去重（同站多站台合成一个点）；保留首个非空站名。
    const byMain = new Map<string, StationPoint>();
    for (const r of res.rows as Record<string, unknown>[]) {
      const rawCode = String(r.code ?? "");
      if (!rawCode) continue;
      const main = mainCodeOf(rawCode);
      const lat = Number(r.lat);
      const lng = Number(r.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const prev = byMain.get(main);
      const name = String(r.name_tc ?? "") || prev?.name || "";
      const kind: "bus" | "lrt" = String(r.kind ?? "bus") === "lrt" ? "lrt" : "bus";
      // ★ WGS84 → GCJ-02（前端直接喂高德地图，不再转换）
      const gcj = wgs84ToGcj02({ lat, lng });

      const pairs = linesByMain.get(main) ?? [];
      const lines = pairs.map((p) => p[0]);
      const colors = pairs.map((p) => p[1]);

      // ★ v2.10.0：**轻轨站**才下发 color/color2（巴士站恒为青花蓝，由 CSS 决定，不需要数据）
      let color: string | undefined;
      let color2: string | undefined;
      if (kind === "lrt" && pairs.length) {
        const colorOfRoute = (rc: string) => pairs.find((p) => p[0] === rc)?.[1];
        const order = LRT_TRANSFER_ORDER[main];
        const o1 = order ? colorOfRoute(order[0]) : undefined;
        const o2 = order ? colorOfRoute(order[1]) : undefined;
        if (o1 && o2) {
          // 换乘站：严格按 Spec §8 的 c1/c2 顺序
          color = o1;
          color2 = o2;
        } else if (pairs.length === 1) {
          color = pairs[0][1]; // 单线站：取该线色
        } else {
          // 兜底（名义不符或多线）：按字典序取前两色
          color = pairs[0][1];
          if (pairs.length > 1) color2 = pairs[1][1];
        }
      }

      byMain.set(main, { code: main, name, lng: gcj.lng, lat: gcj.lat, kind, lines, colors, color, color2 });
    }

    const stations = [...byMain.values()].sort((a, b) => a.code.localeCompare(b.code));
    return NextResponse.json(
      { stations },
      { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/stations] 失败：", msg);
    // ★ v3.6.0（S2）：保留 `stations: []` 数组形状（客户端按 j.stations 取值），只把 error 换成枚举。
    return NextResponse.json({ stations: [], error: API_ERROR.upstream_error }, { status: 500 });
  }
}
