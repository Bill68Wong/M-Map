/**
 * GET /api/nav/walk —— 步行分步路径（v3.6.0 · S5）
 *
 * ── 用途 ──────────────────────────────────────────────────────────────
 *   详情页「步行预览」折叠态 + 进入跟随后的分步指引。**只服务前端**，无业务写入。
 *
 * ── 参数 ──────────────────────────────────────────────────────────────
 *   **主用** `fromLng` `fromLat` `toLng` `toLat`（必填，**GCJ-02**）。
 *   `oLng` `oLat` `dLng` `dLat` 为**架构文档 §4.1.1 的旧写法**，保留兼容；
 *   **新代码不得再用**（两套都传时以 `from*` / `to*` 为准，不合并、不猜测）。
 *   保留旧名的唯一理由：让前端照哪份文档实现都能通，少一次"联调才发现字段名不一致"。
 *   `origin` `dest`（可选，起终点显示名）—— **仅用于日志**，不参与计算、不回显。
 *
 * ── 鉴权 ──────────────────────────────────────────────────────────────
 *   **公开只读**（GET，无凭据）。路径落在既有 `/api/nav` 前缀内 ⇒ 无需改 middleware
 *   （口令门已于 S2 拆除；即便将来恢复上锁，`/api/nav` 也是白名单前缀）。
 *   限流在 `walking.ts` 内（`walking` 令牌桶，3 QPS 全 Key 共享）—— **不在此重复取桶**，
 *   否则一次请求扣两枚令牌。
 *
 * ── 缓存 ──────────────────────────────────────────────────────────────
 *   `Cache-Control: no-store`：几何随用户位置变，且服务端**刻意不做缓存**
 *   （理由见 `walking.ts` 文件头「为什么绝不缓存」）。客户端 5 分钟内存缓存同 OD。
 *
 * ── 错误体口径（★ 以 AC-50d 为准）──────────────────────────────────────
 *   固定六枚举：`bad_request`(**400**) · `rate_limited`(**429**) · `upstream_error`(**500**)。
 *   ⚠️ 状态码以 `lib/http/errors.ts#DEFAULT_STATUS` 为准（`upstream_error` = **500**，
 *      不是 502 —— 本注释旧版写成 502 与代码漂了，已按代码更正）。
 *   ⚠️⚠️ **架构文档 §4.1.1 的「502 + 高德 `info`」已作废，勿按旧文档改回。**
 *      理由：AC-50d 是硬约束（响应体不含内部信息），而高德 `info` 会带
 *      `INVALID_USER_KEY` 这类串 —— 等于把**密钥状态**告诉调用方。
 *      高德 `info` / `infocode` 只进服务端 `console.warn`（并区分「无路网 20003」与「服务/配置故障」）。
 *   零距离/极短距离（< 1m）**不属错误**，返回 `ok:true` + 空 `steps`，不打上游。
 */
import { NextRequest } from "next/server";
import { fetchWalkingSteps } from "@/lib/amap/walking";
import { API_ERROR, errorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** 取一个必填坐标；缺失/非有限/越界 ⇒ null */
function coordOf(v: string | null, limit: number): number | null {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return n;
}

/**
 * 取坐标参数：**主用 `primary`**，缺失时退回架构文档 §4.1.1 的旧短名 `legacy`。
 * ⚠️ 旧名只为兼容保留，新代码不得再用（见文件头「参数」段）。
 */
function pick(sp: URLSearchParams, primary: string, legacy: string): string | null {
  const a = sp.get(primary);
  if (a !== null && a.trim() !== "") return a;
  return sp.get(legacy);
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  // 主用 fromLng/fromLat/toLng/toLat；oLng/oLat/dLng/dLat 为架构文档 §4.1.1 的旧写法，
  // 保留兼容，**新代码不得再用**（两套都传时以 from*/to* 为准）。
  const fromLng = coordOf(pick(sp, "fromLng", "oLng"), 180);
  const fromLat = coordOf(pick(sp, "fromLat", "oLat"), 90);
  const toLng = coordOf(pick(sp, "toLng", "dLng"), 180);
  const toLat = coordOf(pick(sp, "toLat", "dLat"), 90);

  if (fromLng === null || fromLat === null || toLng === null || toLat === null) {
    // 不区分"缺哪个参数"—— 参数名属内部契约，回给客户端只会变成泄漏面
    return errorResponse(API_ERROR.bad_request);
  }

  // 零距离/极短距离**不打上游**：高德对 from==to 返回错误，映射过来就是 500，
  // 而业务语义上「不需要走」不是错误 ⇒ 直接回一条空路线，前端不必为此走 failed 分支。
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(toLat - fromLat);
  const dLng = toRad(toLng - fromLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.sin(dLng / 2) ** 2;
  const distM = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  if (distM < 1) {
    return Response.json(
      {
        ok: true,
        steps: [],
        totalDistM: 0,
        stepsTotalM: 0,
        totalDurationS: 0,
        distanceM: 0,
        durationS: 0,
        polyline: "",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const r = await fetchWalkingSteps(
    { lng: fromLng, lat: fromLat },
    { lng: toLng, lat: toLat },
  );

  if (!r.ok) {
    if (r.error === "rate_limited") {
      return errorResponse(API_ERROR.rate_limited, undefined, { "Retry-After": "1" });
    }
    if (r.error === "no_key") {
      // 服务端未配 AMAP_KEY 属运维问题，对外仍是 upstream_error（不暴露环境变量名）
      console.error("[api/nav/walk] 未配置 AMAP_KEY");
      return errorResponse(API_ERROR.upstream_error);
    }
    return errorResponse(API_ERROR.upstream_error);
  }

  return Response.json(
    {
      ok: true,
      steps: r.steps,
      totalDistM: r.totalDistM,
      // ★ 几何链末值：前端算「还有 N 米」**必须**用 `stepsTotalM − doneM`
      //   （`totalDistM` 含被丢弃的步，用它永远到不了 0 —— 见 walk-shared 的类型注释）
      stepsTotalM: r.stepsTotalM,
      totalDurationS: r.totalDurationS,
      // ── 兼容别名（架构 §4.1.1 的字段名）──
      // **主用 `totalDistM` / `totalDurationS`**；`distanceM` / `durationS` 仅为兼容旧契约，
      // **前端应读主字段**（新代码不得读别名）。两者恒等，不存在"哪个更权威"的歧义。
      distanceM: r.totalDistM,
      durationS: r.totalDurationS,
      /** 全线几何（`lng,lat;...`），供只需画一条线、不关心分步的消费方 */
      polyline: r.steps
        .flatMap((s) => s.polyline)
        .map(([lng, lat]) => `${lng},${lat}`)
        .join(";"),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
