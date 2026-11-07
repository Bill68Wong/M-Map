/**
 * GET /api/vehicle-model?plate=AA-77-59  或  ?code=HE247 —— 车 → 车型规格
 *
 * ── 用途 ──────────────────────────────────────────────────────────────
 *   地图上点一台车，弹窗里那行「车型」要显示成
 *   「海格 增程式電動巴士（11.3米大巴）(2022)」而不是 `KLQ6116GHEV2`。
 *   本接口把「车牌 / 车队编号 → 车型显示名 + 类别 + 座位 / 企位 / 尺寸」这条链路一次答完。
 *
 * ── 入参：`?plate=` 主键优先，`?code=` 兜底 ────────────────────────────
 *   · `plate`（车牌）：`vehicle_plates` 的 **PRIMARY KEY** ⇒ 点查、不可能多行。**推荐**。
 *   · `code`（车队编号，如 `HE247`）：只是**普通索引**，物理上可能对应多行。
 *     保留它是为「新车第一帧」：落库在响应发出后的 `after()` 里
 *     （`src/lib/dsat/vehicle-plates.ts:204`），前端此刻手上只有 DSAT 给的 `busCode`。
 *   · 两者都给 ⇒ **`plate` 优先**；`plate` 查不到才回落 `code`。
 *   · 两者都没有 / 超长 ⇒ 400 `bad_request`。
 *
 * ── 返回值（四态，`reason` 为判别式）────────────────────────────────────
 *   成功（`reason: null`）
 *     `{ ok:true, busCode:"HE247", company:"transmac", category:"中巴", via:"db",
 *        model:{ code:"KLQ6106GHEV1", displayName:"海格 增程式電動巴士（10.499米中巴）",
 *                seats:25, seatsRaw:"25+1", standing:40, wheelchair:null,
 *                lengthMm:10499, widthMm:2500, heightMm:3200, … }, reason:null }`
 *   - `reason:"no_spec"`    型号已知、**规格未知** ⇒ `model.code` 有值，其余为 null
 *                           （例：新福利 ZE01-07 的 LCK6759SHEVG 只录了澳巴那批规格，
 *                             不跨运营商借用）
 *   - `reason:"no_model"`   车在库、型号未知 ⇒ `model:null`、`via:null`
 *                           （澳巴 273 台属这一类）——★ 此时 `category` **仍可能有值**，
 *                              弹窗显示「车型：资料未公开 + 类别：大巴」
 *   - `reason:"unknown_code"` 车号格式正常但库里没这台车（`category` 通常为 null）
 *   - `reason:"unparsable"`   车号格式拆不开（如纯数字 `6009`）
 *   `via` 标明型号来源：`db`=`vehicle_plates.model` / `range`=车号区间反推 / `null`=未知。
 *   `category`（`大巴` / `中巴`）**独立于 `model`**：型号未知时仍可为非 null，
 *   未知码一律 null（不回落到「其它」这类占位词）。
 *
 * ── 为什么不缓存 ──────────────────────────────────────────────────────
 *   `vehicle_plates` 每帧采集都在更新（型号标定随新车入库变化），
 *   响应固定 `Cache-Control: no-store`。本接口本身只是两条点查/小表扫描，
 *   单次开销远小于被 CDN 缓存住旧型号的代价。
 *
 * ── 边界 ──────────────────────────────────────────────────────────────
 *   · 只读，无副作用，不写库；
 *   · 缺两个参数 / 任一超长 ⇒ 400 `bad_request`（AC-50d 六枚举内）；
 *   · 库异常 ⇒ 500 `upstream_error`，**不把异常原文/ SQL 回给客户端**（只进服务端日志）；
 *   · 路由不在 `GONE_PREFIXES` / `SAME_ORIGIN_PREFIXES` 内（`src/lib/security/route-policy.ts`），
 *     GET 属只读，AC-50 写接口门禁不覆盖。
 *
 * ⚠️ route 里不放业务逻辑、不 export 辅助函数（Next 的 `.next/types` 导出白名单会让
 *    `next build` 失败，而 `tsc --noEmit` 抓不到 —— 本项目已踩过一次）。
 *    取数在 `src/lib/vehicle/load-vehicle-model.ts`，判定在 `model-resolve.ts`。
 */
import { NextRequest, NextResponse } from "next/server";
import { API_ERROR, errorResponse } from "@/lib/http/errors";
import { loadVehicleModel } from "@/lib/vehicle/load-vehicle-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

/** 车队编号长度上限：现有最长 5 字符（`HE601`），留足余量后取 20，防超长串打到 SQL */
const MAX_CODE_LEN = 20;

/** 车牌长度上限：现有最长 8 字符（`AA-77-59`），同样留余量取 20 */
const MAX_PLATE_LEN = 20;

const HEADERS = { "Cache-Control": "no-store" } as const;

export async function GET(req: NextRequest) {
  const plate = (req.nextUrl.searchParams.get("plate") ?? "").trim();
  const code = (req.nextUrl.searchParams.get("code") ?? "").trim();
  if ((!plate && !code) || plate.length > MAX_PLATE_LEN || code.length > MAX_CODE_LEN)
    return errorResponse(API_ERROR.bad_request);

  try {
    // 两者都给时 plate 优先（主键点查），loadVehicleModel 内部才做 code 兜底
    const r = await loadVehicleModel({ plate, code });
    return NextResponse.json({ ok: true, ...r }, { headers: HEADERS });
  } catch (e) {
    console.error("[api/vehicle-model] 查询失败：", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: API_ERROR.upstream_error },
      { status: 500, headers: HEADERS },
    );
  }
}
