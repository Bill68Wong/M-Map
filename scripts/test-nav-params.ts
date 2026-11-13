/**
 * `numOf` 参数解析单测（scripts/test-nav-params.ts · v3.6.0）
 *
 * ── 为什么存在 ──────────────────────────────────────────────────────────
 *   `/api/nav` 长期把「没传参数」当成坐标 `(0, 0)`：
 *   `Number(null) === 0`、`Number("") === 0`，而 `Number.isFinite(0)` 为真
 *   ⇒ `pointOf()` 返回一个**看似合法**的点 ⇒ 400 分支永远进不去
 *   ⇒ 空请求走完整 `planNav`（实测 200 + 1.54s，真的打了一次高德）。
 *   这个 bug 活了很久（v1.4.0 起）没有任何断言兜住，所以补这个文件。
 *
 * ⚠️ 直接 import **真实现**（`numOf` 已从 route 移到 `lib/nav/query-params.ts`），
 *    不是复刻逻辑 —— 复刻的测试只能证明"我以为的规则"，实现改了它照样绿。
 * ⚠️ **不要**从 `src/app/api/nav/route.ts` import：route 文件只允许导出 Next 白名单
 *    名字（HTTP 方法 + runtime/dynamic 等），多导出一个函数会让 `next build` 在
 *    类型检查阶段直接失败（详见 `lib/nav/query-params.ts` 文件头）。
 *
 * 跑法：`node node_modules/tsx/dist/cli.mjs scripts/test-nav-params.ts`
 *      （或 `npm run test:nav-params`）
 */
import { coordInRange, numOf } from "../src/lib/nav/query-params";

let fail = 0;
let pass = 0;

/** 断言 `numOf` 的返回（用 `Object.is` 区分 `0` 与 `null`） */
function eq(sp: URLSearchParams, key: string, expected: number | null, label: string): void {
  const actual = numOf(sp, key);
  const ok = Object.is(actual, expected);
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${label}  → ${JSON.stringify(actual)}` +
      (ok ? "" : `  (期望 ${JSON.stringify(expected)})`),
  );
}

const q = (s: string) => new URLSearchParams(s);

console.log("═══ numOf 参数解析（v3.6.0 修复的 0,0 bug）═══\n");

/* ── ① 必须返回 null 的五种"不算提供"── */
console.log("── ① 未提供 / 空 / 空白 ⇒ null（否则会被当成 0）──");
eq(q(""), "fromLng", null, "完全无该参数（sp.get() = null）");
eq(q("fromLng="), "fromLng", null, "空串 `fromLng=`");
eq(q("fromLng=%20%20"), "fromLng", null, "纯空白 `fromLng='  '`");
eq(q("fromLng=abc"), "fromLng", null, "非数字 `abc`");
eq(q("fromLng=NaN"), "fromLng", null, "字面量 `NaN`");

/* ── ② 合法数字必须原样返回 ───────────────────────────────────────────── */
console.log("\n── ② 合法数字原样返回 ──");
eq(q("fromLng=113.5432"), "fromLng", 113.5432, "小数 `113.5432`");
eq(q("fromLng=-113.5"), "fromLng", -113.5, "负数 `-113.5`");
eq(q("fromLng=0"), "fromLng", 0, "**显式 `0` 仍返回 0**（不把合法 0 当缺失）");
eq(q("fromLng=00113.5"), "fromLng", 113.5, "前导零 `00113.5`");
eq(q("fromLng=%20113.5%20"), "fromLng", 113.5, "两侧带空格 `' 113.5 '`（Number 能容错）");

/* ── ③ Infinity 不是合法坐标 ──────────────────────────────────────────── */
console.log("\n── ③ 非有限值 ⇒ null ──");
eq(q("fromLng=Infinity"), "fromLng", null, "`Infinity`");
eq(q("fromLng=-Infinity"), "fromLng", null, "`-Infinity`");

/* ── ④ 关键回归：整组空参数时 pointOf 的四次取值全为 null ──────────────── */
console.log("\n── ④ 回归：`?fromLng=&fromLat=&toLng=&toLat=` 四个全 null（旧版会得 0）──");
{
  const sp = q("fromLng=&fromLat=&toLng=&toLat=");
  const all = [numOf(sp, "fromLng"), numOf(sp, "fromLat"), numOf(sp, "toLng"), numOf(sp, "toLat")];
  const ok = all.every((v) => v === null);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "OK  " : "FAIL"} 四值 = ${JSON.stringify(all)}${ok ? "" : "  (期望全 null)"}`);
}

/* ── ⑤ P5：世界坐标范围校验 ────────────────────────────────────────────── */
console.log("\n── ⑤ coordInRange（P5：非法坐标必须 400，不能伪装成「高德不可用」）──");
function inr(lng: number, lat: number, expected: boolean, label: string): void {
  const actual = coordInRange(lng, lat);
  const ok = actual === expected;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}  → ${actual}` + (ok ? "" : `  (期望 ${expected})`));
}
inr(113.5491, 22.2153, true, "澳门关闸坐标");
inr(113.5432, 22.1987, true, "澳门半岛坐标");
inr(113.5491, 999, false, "`fromLat=999`（P5 事故样本）");
inr(181, 22.2153, false, "`fromLng=181` 越经度上限");
inr(113.5491, 90.0001, false, "纬度 90.0001 越界（超 0.0001 也要拦）");
inr(180, 90, true, "**边界 (180, 90) 合法**（含边界）");
inr(-180, -90, true, "**边界 (-180, -90) 合法**（含边界）");
inr(0, 0, true, "`(0, 0)` 在物理范围内 ⇒ 放行（是否在澳门属 P6，不在此处拦）");
inr(Number.NaN, 22.2, false, "`NaN` 越界");
inr(113.5, Number.POSITIVE_INFINITY, false, "`Infinity` 越界");

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
