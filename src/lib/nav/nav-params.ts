/**
 * `/nav` 与 `/nav/detail` 的 URL 参数解析（src/lib/nav/nav-params.ts，v1.3.0 · T04）
 *
 * 契约（与 T03 的 `/api/nav` 一致）：**坐标一律 GCJ-02**。
 *   `fromLng fromLat toLng toLat`（必填）· `fromLabel toLabel`（选填展示名）
 *   `fromKind toKind`（gps|poi|station|place）· `fromCode toCode`（place slug 等）
 *   `zone`（B/C|N/O|R）· `limit`（默认 `NAV_LIMIT_DEFAULT`）· `plan`（详情页用：定位某张卡）
 *
 * ★ v2.3.0：追加**可选** `chain` / `walk` / `tiers`（编码 `encodeURIComponent(JSON.stringify(...))`）
 *   —— 承载用户自定义站链与步行参数；此处置于**宽松解析**（非法即视为缺省）。
 *   ⚠️ `query` 仍**不含**这三者（保持 v2.2.0 逐字节一致；组合把它们作为独立字段保存/转发）。
 *
 * 纯函数（无 pg / 无 next 依赖）—— 服务端组件与任何地方都能用。
 */
import { NAV_LIMIT_DEFAULT } from "@/lib/recommend/limits";
import { SCHOOL_ZONES, type SchoolZone } from "@/lib/recommend/types";
import { decodeChain, decodeTiers, decodeWalk, type ChainStep, type TierOverride, type WalkOverride } from "./combo-params";
import type { NavPoint, NavPointKind } from "./types";

export interface NavUrlParams {
  origin: NavPoint;
  dest: NavPoint;
  zone: SchoolZone | null;
  limit: number;
  /** 规范化的查询串（**原样转发**到详情页与刷新请求用；不含 `plan`） */
  query: string;
  /** 详情页：目标卡片 planId（无则不填） */
  planId?: number;
  /** ★ v2.3.0：可选自定义站链（缺省 = 自动选线） */
  chain?: ChainStep[];
  /** ★ v2.3.0：两段步行覆盖（缺省 = 系统算） */
  walk?: WalkOverride;
  /** ★ v2.3.0：五档覆盖（缺省 = 系统默认） */
  tiers?: TierOverride;
}

const KIND_VALUES: NavPointKind[] = ["gps", "poi", "station", "place"];
const ZONE_VALUES = SCHOOL_ZONES.map((z) => z.value) as string[];

type SP = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

function num(sp: SP, key: string): number | null {
  const raw = first(sp[key]);
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function point(sp: SP, side: "from" | "to"): NavPoint | null {
  const lng = num(sp, `${side}Lng`);
  const lat = num(sp, `${side}Lat`);
  if (lng === null || lat === null) return null;
  const kindRaw = (first(sp[`${side}Kind`]) ?? "").trim();
  const kind: NavPointKind = (KIND_VALUES as string[]).includes(kindRaw)
    ? (kindRaw as NavPointKind)
    : "poi";
  const label = (first(sp[`${side}Label`]) ?? "").trim() || (side === "from" ? "起点" : "终点");
  const code = (first(sp[`${side}Code`]) ?? "").trim() || undefined;
  return { kind, label, lng, lat, code };
}

/** 解析；必填坐标缺失/非法 → null（调用方 redirect 回首页） */
export function parseNavParams(sp: SP): NavUrlParams | null {
  const origin = point(sp, "from");
  const dest = point(sp, "to");
  if (!origin || !dest) return null;

  const zoneRaw = (first(sp.zone) ?? "").trim();
  const zone: SchoolZone | null = ZONE_VALUES.includes(zoneRaw) ? (zoneRaw as SchoolZone) : null;

  // ★ 2026-11-04（U10）：默认张数与 `/api/nav` 同源（`limits.ts`）——
  //   否则「页面按 5 张请求、接口按 6 张出卡」会在这里悄悄把张数压回 5。
  const limitRaw = num(sp, "limit");
  const limit = limitRaw !== null && limitRaw > 0 ? Math.min(20, Math.trunc(limitRaw)) : NAV_LIMIT_DEFAULT;

  const spOut = new URLSearchParams({
    fromLng: String(origin.lng),
    fromLat: String(origin.lat),
    toLng: String(dest.lng),
    toLat: String(dest.lat),
    fromLabel: origin.label,
    toLabel: dest.label,
    fromKind: origin.kind,
    toKind: dest.kind,
  });
  if (origin.code) spOut.set("fromCode", origin.code);
  if (dest.code) spOut.set("toCode", dest.code);
  if (zone) spOut.set("zone", zone);
  // 只在**偏离默认值**时才写进查询串（与上面同一个常量 ⇒ 改默认值不会漏改这里）
  if (limit !== NAV_LIMIT_DEFAULT) spOut.set("limit", String(limit));

  const planRaw = num(sp, "plan");
  const planId = planRaw !== null ? Math.trunc(planRaw) : undefined;

  // ★ v2.3.0：可选出行参数（宽松解析；非法/缺省 → 不填）
  const chainRaw = first(sp.chain)?.trim();
  const dc = chainRaw ? decodeChain(chainRaw) : null;
  const chain = dc && dc.ok ? dc.chain : undefined;
  const walkRaw = first(sp.walk)?.trim();
  const dw = walkRaw ? decodeWalk(walkRaw) : null;
  const walk = dw && dw.ok ? dw.walk : undefined;
  const tiersRaw = first(sp.tiers)?.trim();
  const dt = tiersRaw ? decodeTiers(tiersRaw) : null;
  const tiers = dt && dt.ok ? dt.tiers : undefined;

  return { origin, dest, zone, limit, query: spOut.toString(), planId, chain, walk, tiers };
}
