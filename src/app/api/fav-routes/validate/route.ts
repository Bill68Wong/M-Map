/**
 * POST /api/fav-routes/validate —— 保存前的**逻辑漏洞校验**（2026-09-22 新增）
 *
 * ── 为什么需要 ────────────────────────────────────────────────────────
 *   产品口径：用户在流程图里改了站点/换乘后，**保存前**必须判断有没有漏洞，
 *   有矛盾就**拒绝保存**、留在编辑界面。典型矛盾（产品原话）：
 *     「上车站需要换乘才能开到下车站，但用户没有在流程图中设置换乘」
 *
 * ── 校验规则（逐条）──────────────────────────────────────────────────
 *   ① **结构**：至少一段乘车；首段前应有 `walk(out)`，末段后应有 `walk(in)`
 *      （⚠️ 缺失只作为**提示**，不拒绝 —— 用户可能故意不要首末步行）
 *   ② **站点非空**：每段 `ride` 必须有 `board` 与 `alight`
 *   ③ **顺向可达（核心）**：`board → alight` 必须能在该线路的某个方向上**按站序顺向**走通
 *      —— 走不通说明「这段车到不了」，必须补换乘或改站 ✗
 *   ④ **换乘衔接**：相邻两段 `ride` 之间必须有 `transfer` 段，
 *      且 `transfer.at` 同时等于前段 `alight` 与后段 `board`
 *      —— 否则就是「下车后凭空出现在另一条线上」✗
 *   ⑤ **线路存在**：`route` 必须在本库线路集合内
 *
 * 只读接口（不写库）。
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { loadStatics } from "@/lib/recommend/query";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import { API_ERROR, errorResponse } from "@/lib/http/errors";
import { MAX_FAV_BODY_BYTES, readJsonLimited } from "@/lib/http/body-limit";
import {
  FAV_BUCKET_CAPACITY,
  FAV_QPS,
  RATE_BUCKET,
  acquireToken,
} from "@/lib/amap/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

interface Seg {
  kind: "walk" | "ride" | "transfer" | "cross_border";
  phase?: "out" | "in";
  route?: string;
  board?: string;
  alight?: string;
  at?: string;
  label?: string;
}

interface Body {
  segs?: Seg[];
}

export async function POST(req: Request) {
  try {
    // ★ v3.6.0（S2）护栏：`fav` 令牌桶 + 请求体 ≤ 16KB（与 `/api/fav-routes` 同一套，
    //   三个收藏写接口共用配额，避免"绕开最严那个"）
    const rl = await acquireToken(RATE_BUCKET.fav, FAV_QPS, FAV_BUCKET_CAPACITY);
    if (!rl.ok) {
      return errorResponse(API_ERROR.rate_limited, undefined, { "Retry-After": "1" });
    }
    const parsed = await readJsonLimited<Body>(req, MAX_FAV_BODY_BYTES);
    if (!parsed.ok) {
      return errorResponse(API_ERROR.bad_request, parsed.reason === "tooLarge" ? 413 : 400);
    }
    const body = parsed.value;
    const segs = Array.isArray(body?.segs) ? body.segs : [];
    const errors: string[] = [];
    const warnings: string[] = [];

    const rides = segs.filter((s) => s.kind === "ride");
    if (!rides.length) errors.push("这条路线没有任何乘车段");

    // ② 站点非空
    for (const [i, r] of rides.entries()) {
      if (!r.board || !r.alight) errors.push(`第 ${i + 1} 段乘车缺少上车站或下车站`);
      if (r.board && r.alight && mainCodeOf(r.board) === mainCodeOf(r.alight)) {
        errors.push(`第 ${i + 1} 段乘车的上车站与下车站相同（${r.board}）`);
      }
    }

    // ① 结构提示（不拒绝）
    const firstRideIdx = segs.findIndex((s) => s.kind === "ride");
    if (firstRideIdx > 0) {
      const head = segs.slice(0, firstRideIdx);
      if (!head.some((s) => s.kind === "walk" && (s.phase ?? "out") === "out")) {
        warnings.push("首段乘车前没有「出发地 → 上车站」的步行段");
      }
    }
    const lastRideIdx = segs.map((s) => s.kind).lastIndexOf("ride");
    if (lastRideIdx >= 0 && lastRideIdx < segs.length - 1) {
      const tail = segs.slice(lastRideIdx + 1);
      if (!tail.some((s) => s.kind === "walk" && s.phase === "in")) {
        warnings.push("末段乘车后没有「下车站 → 目的地」的步行段");
      }
    }

    // ③ + ⑤ 顺向可达 & 线路存在
    const st = await loadStatics(getPool());
    const valid = new Set<string>(st.routeIdx.dirsOf.keys());
    for (const [i, r] of rides.entries()) {
      if (!r.route) {
        errors.push(`第 ${i + 1} 段乘车没有线路名`);
        continue;
      }
      if (!valid.has(r.route)) {
        errors.push(`第 ${i + 1} 段乘车的线路「${r.route}」不在本库线路集合内`);
        continue;
      }
      if (!r.board || !r.alight) continue;
      // 在任一方向上找「顺向」路径（逐跳相邻）
      //
      // ⚠️ 踩坑（实测 2026-09-22）：**环线站码会重复出现** —— 例如 26 号线单向循环，
      //    主码 `T355` 在站序里出现两次（位序 34 的 `T355/1` 与位序 45+ 的 `T355/2`）。
      //    最初用 `indexOf()` 只取**首次出现** ⇒ 拿 `T355(34)` 与 `C653(43)` 比较，
      //    得出「C653 在 T355 之后 ⇒ 不可达」的**误报** ✗
      //    实际 `C653(43) → C692 → C689/1 → T355/2` 完全顺向可达 ✓
      //    ⇒ 必须对 `board` 的**每个出现位置**分别往后找 `alight`。
      let reachable = false;
      for (const dir of st.routeIdx.dirsOf.get(r.route) ?? []) {
        const stops = st.routeIdx.dirStops.get(`${r.route}|${dir}`) ?? [];
        const codes = stops.map((s) => mainCodeOf(s));
        const bCode = mainCodeOf(r.board);
        const aCode = mainCodeOf(r.alight);
        for (let i = 0; i < codes.length && !reachable; i++) {
          if (codes[i] !== bCode) continue;
          for (let j = i + 1; j < codes.length; j++) {
            if (codes[j] === aCode) {
              reachable = true;
              break;
            }
          }
        }
        if (reachable) break;
      }
      if (!reachable) {
        errors.push(
          `第 ${i + 1} 段「${r.route}」无法从 ${r.board} 顺向开到 ${r.alight}` +
            `（该线下行方向不经过，或需换乘）—— 请在中间加换乘站，或改上/下车站`,
        );
      }
    }

    // ④ 换乘衔接
    let prevRide: Seg | null = null;
    let transferBetween: Seg | null = null;
    for (const s of segs) {
      if (s.kind === "transfer") {
        transferBetween = s;
        continue;
      }
      if (s.kind !== "ride") continue;
      if (prevRide) {
        if (!transferBetween) {
          errors.push(
            `「${prevRide.route}」与「${s.route}」之间没有换乘段 —— ` +
              `下车后无法凭空换到另一条线，请在 ${prevRide.alight ?? "?"} 添加换乘`,
          );
        } else {
          const at = mainCodeOf(transferBetween.at ?? "");
          const pa = mainCodeOf(prevRide.alight ?? "");
          const nb = mainCodeOf(s.board ?? "");
          if (at && pa && at !== pa) {
            errors.push(`换乘站 ${transferBetween.at} 与前一段的下车站 ${prevRide.alight} 不一致`);
          }
          if (at && nb && at !== nb) {
            errors.push(`换乘站 ${transferBetween.at} 与后一段的上车站 ${s.board} 不一致`);
          }
        }
      }
      prevRide = s;
      transferBetween = null;
    }

    return NextResponse.json({ ok: errors.length === 0, errors, warnings });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/fav-routes/validate] 失败：", msg);
    // ★ v3.6.0（S2）：异常原文只进服务端日志（原实现会回显 `msg.slice(0,200)` 给客户端）
    return NextResponse.json({ ok: false, error: API_ERROR.upstream_error, errors: [], warnings: [] }, { status: 500 });
  }
}
