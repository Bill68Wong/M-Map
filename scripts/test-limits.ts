/**
 * 卡片张数同源断言（scripts/test-limits.ts · 2026-11-04 需求 U10 · 2026-11-06 通琴号迭代瘦身）
 *
 * ── 守的是什么 ────────────────────────────────────────────────────────
 *   「取几张卡」是跨多处共用的同一个数字。只要有一处漏改，就会出现
 *   「首屏 6 张、刷新掉回 5 张」或「第 N 张卡点进去 `route_changed`（点了没反应）」。
 *   本脚本用两种手段守住：
 *     A. **常量值**：`RECOMMEND_LIMIT_DEFAULT` / `NAV_LIMIT_DEFAULT` 都必须 = 6，
 *        且**并存不合并**（两条链路是两个独立产品面，未来单方调参不应牵连对方）；
 *     B. **无残留字面量**：每个存活引用点逐处按「该引用的常量」判定，并用 `git grep`
 *        扫全 `src/` 找 `?? 5` / `limit: 5` / `limit: "5"` 之类残留。
 *
 * ── 2026-11-06 瘦身（旧推荐链下线）────────────────────────────────────
 *   原 10 处引用点里，`/recommend` 链路（`service.ts` / `card.ts` / `card-link.ts` /
 *   `app/recommend/page.tsx` / `RecommendClient.tsx` / `api/recommend/route.ts`）随
 *   Spec §6.2.2 整体删除 ⇒ 对应断言改为**删除**，而不是放宽成「文件不存在也算过」。
 *   留一个「文件不在就跳过」的分支等于给门禁开洞：将来误删任何一处都静默变绿。
 *   现存活 6 处：`/nav` 三处（接口 / 服务 / URL 解析）+ 卡片侧三处（`card-href` /
 *   `RecommendCard` / `RecommendCards`）。
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

console.log("卡片张数同源断言（limits.ts · 6 处引用）\n");

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

// ── B. 6 处引用逐处判定 ──
console.log("② 6 处引用（逐处给文件:常量）");
type Site = { file: string; must: string; mustNot?: RegExp; label: string };
const SITES: Site[] = [
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
  // ⚠️ 容易被当成「第 9 处之外」而漏掉：`/nav` 的 **URL 参数解析**里也有同一份默认值，
  //   而且多一个「偏离默认值才写进查询串」的比较 —— 漏改这里会让页面按 5 张请求、
  //   接口按 6 张出卡（张数在这里被**悄悄压回** 5）。
  {
    file: "src/lib/nav/nav-params.ts",
    must: ": NAV_LIMIT_DEFAULT;",
    mustNot: /: 5;|!== 5\)/,
    label: "nav-params.ts（/nav URL 默认值 + 「偏离默认值才写」判断）",
  },
  {
    file: "src/lib/recommend/card-href.ts",
    must: "p.limit ?? RECOMMEND_LIMIT_DEFAULT",
    mustNot: /p\.limit \?\? 5\b/,
    label: "card-href.ts（拼 href 默认值）",
  },
  {
    file: "src/components/RecommendCard.tsx",
    must: "limit = RECOMMEND_LIMIT_DEFAULT",
    mustNot: /limit = 5\b/,
    label: "RecommendCard.tsx（单卡 limit 缺省值）",
  },
  {
    file: "src/components/RecommendCards.tsx",
    must: "limit = RECOMMEND_LIMIT_DEFAULT",
    mustNot: /limit = 5\b/,
    label: "RecommendCards.tsx（列表 limit 缺省值）",
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
  const at = cardSrc.indexOf("buildCardHref({");
  assert(at >= 0, "RecommendCard 仍调用 buildCardHref（兜底跳转）");
  const call = at >= 0 ? cardSrc.slice(at, cardSrc.indexOf("});", at)) : "";
  assert(call.includes("limit"), "RecommendCard 的 buildCardHref 调用带 limit（P0 修复）");
  const listSrc = read("src/components/RecommendCards.tsx");
  assert(/limit=\{limit\}/.test(listSrc), "RecommendCards 把 limit 透传给每张卡");
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
    const lines = hits
      .split("\n")
      .filter((l) => l.trim())
      .filter((l) => /limit|LIMIT|张|卡片|条/.test(l));
    assert(lines.length === 0, `${p.why} 无残留${lines.length ? "：" + lines.join(" | ") : ""}`);
  }
}

console.log("\n" + (fail === 0 ? "✅ 全部通过" : "❌ 有失败") + "：pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
