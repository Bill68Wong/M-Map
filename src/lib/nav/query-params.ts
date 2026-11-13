/**
 * `/api/nav` 的 URL 参数解析（src/lib/nav/query-params.ts，v3.6.0）
 *
 * ── 为什么抽出来（这是一次真实事故的产物，改动前必读）────────────────────
 *   这两个函数原来写在 `src/app/api/nav/route.ts` 里。为让单测能直接调**真实现**
 *   （而不是复刻一份逻辑），我把 `numOf` 从 route 文件里 `export` 了出来 ——
 *   **`tsc --noEmit` 通过，但 `next build` 直接炸**：
 *
 *     .next/types/app/api/nav/route.ts:12:13
 *     Type error: Property 'numOf' is incompatible with index signature.
 *       Type '(...) => number | null' is not assignable to type 'never'.
 *
 *   ⚠️⚠️ **Next App Router 的 `route.ts` 只允许导出白名单内的名字**
 *      （`GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS` + `runtime` / `dynamic` / `preferredRegion` /
 *      `maxDuration` / `revalidate` / `fetchCache` / `dynamicParams` / `generateStaticParams`）。
 *      多导出一个辅助函数 ⇒ 生成 `.next/types` 时类型检查 FAIL ⇒ build worker 异常退出。
 *
 *   ⚠️⚠️ **`tsc --noEmit` 通过 ≠ `next build` 通过**：tsc 只按 tsconfig 里 include 的
 *      `.next/types` 下的 .ts 文件编译，不校验"route 文件的导出白名单"这个 Next 特有约束；
 *      那个检查发生在 build 的 `Linting and checking validity of types` 阶段。
 *      ⇒ 这类错误**只有 build 能抓到**，所以 `check-api-guards.ts` 加了静态扫描兜住它。
 *
 *   ⚠️ 另注：写注释时**别在本块里直接写 glob 的 `.next/types/` + 两个星号 + `/*.ts`** ——
 *      中间的 `星号+斜杠` 序列会提前闭合块注释，整段变成代码（v3.6.0 真的踩了，
 *      tsc 报了一串 `Expression expected`）。要写路径就拆开或加空格。
 *
 * ── 结论（以后写 route.ts 的纪律）──────────────────────────────────────
 *   任何「想在 route 里导出以便单测」的辅助函数，**一律放 lib/**，route 只 `import`。
 *   本文件就是按这条纪律建的。
 */
import type { NavPoint, NavPointKind } from "@/lib/nav/types";

/** 合法的点类型取值（`fromKind` / `toKind`） */
const KIND_VALUES: NavPointKind[] = ["gps", "poi", "station", "place"];

/**
 * 取一个必需的数字参数；**未提供 / 空串 / 纯空白 / 非数字 ⇒ `null`**。
 *
 * ── ★ v3.6.0：修一个存在很久的 bug（v1.4.0 起）────────────────────────────
 *   旧实现是 `const v = Number(sp.get(key)); return Number.isFinite(v) ? v : null;`
 *   而 **`Number(null) === 0`、`Number("") === 0`** ⇒ 「没传参数」被当成坐标 `0`，
 *   `pointOf()` 于是返回一个 `(lng=0, lat=0)` 的**看似合法**的点 ⇒ 上层那个
 *   `if (!origin || !dest) return 400` **永远进不去**，空请求会一路走完整 `planNav`。
 *
 *   后果（实测）：`GET /api/nav`（完全无参数）**200 + 1.54s**，`transitMs=1332` ——
 *   真的打了一次高德路径规划。这是**最省事的一种刷配额方式**（任何人都能刷），
 *   与 AC-50 是同一件事的两面：一面是写接口防护，一面是只读接口的**成本放大**。
 *
 * ── 为什么先挡字符串再做 Number ──────────────────────────────────────────
 *   `trim() === ""` 必须和 `null` 一起挡：`?fromLng=&fromLat=` 这种空值请求同样会变 0。
 *   ⚠️ 显式传 `"0"` **仍返回 `0`**（合法数字 0）—— 本函数是通用取数，
 *      不在这一层做「坐标是否在澳门」之类的**业务**判断（那会影响探针与跨岛测试）。
 */
export function numOf(sp: URLSearchParams, key: string): number | null {
  const raw = sp.get(key);
  if (raw === null || raw.trim() === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/**
 * 世界经纬度边界（角度制的物理上限，与坐标系统无关：GCJ-02 与 WGS84 同范围）。
 *
 * ⚠️ 这里是**物理范围**，不是「是否在澳门」的业务判断 —— 后者属 P6（bbox + `out_of_scope`），
 *    不要把两件事合并：本校验只负责「根本不是地球上的坐标」。
 */
export const COORD_LIMITS = { lng: 180, lat: 90 } as const;

/**
 * 经纬度是否落在世界坐标范围内（**含边界**）；`NaN` / `Infinity` 一律视为越界。
 *
 * ── ★ 2026-11-13（P5）：修「非法坐标被当成高德不可用」──────────────────────
 *   `numOf` 只挡「缺失 / 空串 / 非数字」，`Number("999")` 是有限数 ⇒ 原样通过。
 *   于是一个 `fromLat=999` 的请求会**一路走完整 `planNav`**：真打高德 → 上游返回失败
 *   → 归一成 `{ok:true, degraded:true, emptyReason:"amap_unavailable"}` + **HTTP 200**。
 *   排查方向被直接带偏（看起来像高德挂了/配额没了），实际是调用方传了不存在的坐标。
 *
 *   ⇒ 在进入业务逻辑之前按物理范围挡掉，回 `400 bad_request`。
 *   ⚠️ 不放 `numOf`：那个函数的注释明确它不做业务判断，且探针会显式传 `0` 做边界实验。
 */
export function coordInRange(lng: number, lat: number): boolean {
  return (
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    Math.abs(lng) <= COORD_LIMITS.lng &&
    Math.abs(lat) <= COORD_LIMITS.lat
  );
}

/**
 * 由查询串解析一端（起点 / 终点）；任一坐标缺失或非法 ⇒ `null`。
 *
 * `label` 缺省值按 `kind` 给（GPS 说「我的位置」，其余按起/终点位置说）。
 */
export function pointOf(sp: URLSearchParams, side: "from" | "to"): NavPoint | null {
  const lng = numOf(sp, `${side}Lng`);
  const lat = numOf(sp, `${side}Lat`);
  if (lng === null || lat === null) return null;
  const kindRaw = sp.get(`${side}Kind`)?.trim() ?? "";
  const kind: NavPointKind = (KIND_VALUES as string[]).includes(kindRaw) ? (kindRaw as NavPointKind) : "poi";
  return {
    kind,
    label: sp.get(`${side}Label`)?.trim() || (kind === "gps" ? "我的位置" : `${side === "from" ? "起點" : "終點"}`),
    lng,
    lat,
    code: sp.get(`${side}Code`)?.trim() || undefined,
  };
}
