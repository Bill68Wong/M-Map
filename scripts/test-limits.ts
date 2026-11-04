/**
 * 卡片张数同源断言（scripts/test-limits.ts · 2026-11-04 · 需求 U10）
 *
 * ── 守的是什么 ────────────────────────────────────────────────────────
 *   「取几张卡」是**跨 9 处**共用的同一个数字。只要有一处漏改，就会出现
 *   「首屏 6 张、刷新掉回 5 张」或「第 6 张卡点进去 `route_changed`（点了没反应）」。
 *   本脚本用两种手段守住：
 *     A. **常量值**：`RECOMMEND_LIMIT_DEFAULT` / `NAV_LIMIT_DEFAULT` 都必须 = 6，
 *        且**并存不合并**（两条链路是两个独立产品面，未来单方调参不应牵连对方）；
 *     B. **无残留字面量**：9 个引用点逐处按「该引用的常量」判定，并用 `git grep`
 *        扫全 `src/` 找 `?? 5` / `limit: 5` / `limit: "5"` 之类残留。
 *
 * ⚠️ 断言里的「预期」是产品口径（用户拍板 5 → 6），**禁止**为变绿改预期。
 *
 * 运行：npm run test:limits（= tsx scripts/test-limits.ts）
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RECOMMEND_LIMIT_DEFAULT, NAV_LIMIT_DEFAULT } from "../src/lib/recommend/limits";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    fail++;
    console.error("  ✗ " + msg);
  }
}
function assertEq<T>(got: T, want: T, msg: string) {
  assert(got === want, `${msg}（实际 ${String(got)} / 预期 ${String(want)}）`);
}

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

console.log("卡片张数同源断言（limits.ts · 9 处引用）\n");

// ── A. 常量值 + 并存不合并 ──
console.log("① 常量");
assertEq(RECOMMEND_LIMIT_DEFAULT, 6, "/recommend 链路默认张数 = 6");
assertEq(NAV_LIMIT_DEFAULT, 6, "/nav 链路默认张数 = 6");
{
  const src = read("src/lib/recommend/limits.ts");
  const declCount = (src.match(/export const (RECOMMEND|NAV)_LIMIT_DEFAULT/g) ?? []).length;
  assertEq(declCount, 2, "两个常量**并存**（不是 `NAV = RECOMMEND` 这种合并写法）");
  assert(
    !/NAV_LIMIT_DEFAULT\s*=\s*RECOMMEND_LIMIT_DEFAULT/.test(src),
    "NAV_LIMIT_DEFAULT 不得直接赋值成 RECOMMEND_LIMIT_DEFAULT（两条链路独立调参）",
  );
}

// ── B. 9 处引用逐处判定 ──
console.log("② 9 处引用（逐处给文件:常量）");
type Site = { file: string; must: string; mustNot?: RegExp; label: string };
const SITES: Site[] = [
  {
    file: "src/lib/recommend/service.ts",
    must: "input.limit ?? RECOMMEND_LIMIT_DEFAULT",
    mustNot: /input\.limit \?\? 5\b/,
    label: "service.ts（/recommend 编排默认值）",
  },
  {
    file: "src/lib/recommend/card.ts",
    must: "input.limit ?? RECOMMEND_LIMIT_DEFAULT",
    mustNot: /input\.limit \?\? 5\b/,
    label: "card.ts（详情页回查默认值）",
  },
  {
    file: "src/lib/recommend/card-link.ts",
    must: "p.limit ?? RECOMMEND_LIMIT_DEFAULT",
    mustNot: /p\.limit \?\? 5\b/,
    label: "card-link.ts（拼 href 默认值）",
  },
  {
    file: "src/lib/recommend/card-link.ts",
    must: ": RECOMMEND_LIMIT_DEFAULT;",
    mustNot: /const limit = limitRaw[^\n]*: 5;/,
    label: "card-link.ts（解析 href 默认值）",
  },
  {
    file: "src/app/recommend/page.tsx",
    must: "limit: RECOMMEND_LIMIT_DEFAULT",
    mustNot: /limit: 5\b/,
    label: "app/recommend/page.tsx（SSR 首屏）",
  },
  {
    file: "src/components/RecommendClient.tsx",
    must: "limit: String(RECOMMEND_LIMIT_DEFAULT)",
    mustNot: /limit: "5"/,
    label: "RecommendClient.tsx（刷新请求，**必须与 SSR 成对**）",
  },
  {
    file: "src/app/api/recommend/route.ts",
    must: ": RECOMMEND_LIMIT_DEFAULT;",
    mustNot: /: 5;/,
    label: "api/recommend/route.ts（接口默认值）",
  },
  {
    file: "src/app/api/nav/route.ts",
    must: ": NAV_LIMIT_DEFAULT;",
    mustNot: /: 5;/,
    label: "api/nav/route.ts（接口默认值，走 NAV 常量）",
  },
  {
    file: "src/lib/nav/nav-service.ts",
    must: "input.limit ?? NAV_LIMIT_DEFAULT",
    mustNot: /input\.limit \?\? 5\b/,
    label: "nav-service.ts（高德链路默认值，走 NAV 常量）",
  },
  // ⚠️ 第 10 处（原任务清单只列了 9 处）：`/nav` 的 **URL 参数解析**里也有同一份默认值，
  //   而且多一个「偏离默认值才写进查询串」的比较 —— 漏改这里会让页面按 5 张请求、
  //   接口按 6 张出卡（张数在这里被**悄悄压回** 5）。
  {
    file: "src/lib/nav/nav-params.ts",
    must: ": NAV_LIMIT_DEFAULT;",
    mustNot: /: 5;|!== 5\)/,
    label: "nav-params.ts（/nav URL 默认值 + 「偏离默认值才写」判断）",
  },
];

for (const s of SITES) {
  const src = read(s.file);
  assert(src.includes(s.must), `${s.label} ⇒ 引用常量（含 "${s.must}"）`);
  if (s.mustNot) assert(!s.mustNot.test(src), `${s.label} ⇒ 无残留字面量 ${String(s.mustNot)}`);
}

// ── C. P0：卡片链接必须带上当前 limit ──
console.log("③ P0：卡片链接带 limit（否则第 N 张卡点了没反应）");
{
  const cardSrc = read("src/components/RecommendCard.tsx");
  const call = cardSrc.slice(cardSrc.indexOf("buildCardHref({"), cardSrc.indexOf("});", cardSrc.indexOf("buildCardHref({")));
  assert(call.includes("limit"), "RecommendCard 的 buildCardHref 调用带 limit（P0 修复）");
  assert(/limit = RECOMMEND_LIMIT_DEFAULT/.test(cardSrc), "RecommendCard 的 limit 缺省 = RECOMMEND_LIMIT_DEFAULT");
  const listSrc = read("src/components/RecommendCards.tsx");
  assert(/limit=\{limit\}/.test(listSrc), "RecommendCards 把 limit 透传给每张卡");
  assert(/limit=\{RECOMMEND_LIMIT_DEFAULT\}/.test(read("src/components/RecommendClient.tsx")), "RecommendClient 下传 limit");
}

// ── D. git grep：全 src/ 无残留字面量 ──
console.log("④ git grep：全 src/ 残留扫描");
{
  const patterns = [
    { re: "\\?\\?[[:space:]]*5([^0-9]|$)", why: "「?? 5」空值兜底写法" },
    { re: "limit:[[:space:]]*5([^0-9]|$)", why: "「limit: 5」字面量" },
    { re: 'limit:[[:space:]]*"5"', why: '「limit: "5"」字面量' },
  ];
  for (const p of patterns) {
    let hits = "";
    try {
      hits = execSync(`git grep -n -E "${p.re}" -- src`, { cwd: ROOT, encoding: "utf8" });
    } catch {
      hits = ""; // 退出码 1 = 无命中（正常）
    }
    // 保守做法：`?? 5` 这类写法本身是合法的 JS（只是不该用在「张数」上），
    // 故只对「同一行同时出现 limit/LIMIT」的命中判红（避免误伤 `x ?? 5` 的其它语义）。
    // 只关心「与张数有关」的命中行（`?? 5` 也可能出现在别的语义里）
    const lines = hits
      .split("\n")
      .filter((l) => l.trim())
      .filter((l) => /limit|LIMIT|张|卡片|条/.test(l));
    assert(lines.length === 0, `${p.why} 无残留${lines.length ? "：" + lines.join(" | ") : ""}`);
  }
}

console.log("\n" + (fail === 0 ? "✅ 全部通过" : "❌ 有失败") + "：pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
