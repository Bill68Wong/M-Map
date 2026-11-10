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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
  // ★ S-02：门禁侧**独立枚举**的豁免清单（照 check-api-guards.ts ALLOWLIST 形态，逐条打印 文件:行 + 理由）。
  //   为什么不放宽正则：豁免是门禁上唯一的洞，必须「点到具体 文件:行」才可核验；
  //   放宽 pattern 会连带放过将来新加的第 5、第 6 行（本批就是靠这条把既有红「精确收口」而非放绿）。
  const EXEMPT: { file: string; line: number; reason: string }[] = [
    { file: "src/app/cross-border/page.tsx", line: 77, reason: "跨境班次「最近五班」切片（air），与 NAV/RECOMMEND 卡片张数常量语义不同" },
    { file: "src/app/cross-border/page.tsx", line: 78, reason: "跨境班次「最近五班」切片（ferry-PI），语义同上" },
    { file: "src/app/cross-border/page.tsx", line: 79, reason: "跨境班次「最近五班」切片（ferry-PE），语义同上" },
    { file: "src/app/cross-border/page.tsx", line: 80, reason: "跨境班次「最近五班」切片（ferry-TP），语义同上" },
  ];
  const exemptKey = (file: string, line: number) => EXEMPT.find((e) => e.file === file && e.line === line);

  // git grep 封装：**只把退出码 1（无命中）当空**；其余退出码（2+ = 出错）一律上抛给判据判红，
  //   绝不 `2>/dev/null` 吞掉 —— 否则「命令坏了/不在仓库」会被误当「无残留 ⇒ 绿」（S-02 硬要求）。
  // ★ 批 4 / T7：**必须用 execFileSync + 数组参数（不过 shell）**。
  //   旧写法 `execSync(`git grep -n -E "${re}" -- ${target}`)` 把正则拼进 shell 命令行，
  //   P3 的 `limit:[[:space:]]*"5"` 含双引号 ⇒ shell 吃掉内层引号，正则退化成
  //   `limit:[[:space:]]*5`（与 P2 命中集合完全相同）⇒ P3 既零独立覆盖、又打不到自己的靶子。
  //   ★ 单一执行路径：模式自证（下面 4b）**必须复用本函数**，否则「正则活着」与「执行路径不吃引号」
  //     会变成两套互不校验的东西 —— 把本函数改回 shell 模板串时自证却仍绿，等于自证白做。
  const grep = (
    re: string,
    target: string,
    opts?: { cwd?: string; noIndex?: boolean },
  ): { exit: number; out: string; err: string } => {
    const args = ["grep", ...(opts?.noIndex ? ["--no-index"] : []), "-n", "-E", re, "--", target];
    try {
      const out = execFileSync("git", args, {
        cwd: opts?.cwd ?? ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { exit: 0, out, err: "" };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { exit: typeof err.status === "number" ? err.status : -1, out: err.stdout ?? "", err: err.stderr ?? "" };
    }
  };

  // ★ 已知命中探针：拿一个**必然存在**的字面量扫一次，证明 git grep 本身可用。
  //   若探针命中 0 ⇒ 扫描器失效（命令错 / 不在 git 仓库）⇒ 后面所有「无残留」都是假绿。
  //   为什么这条不可省：「命令不存在」与「无命中」**同为退出码 1**，所以下面三条模式里
  //   `r.exit !== 0 && r.exit !== 1` 那条分支**天生抓不到命令坏掉** —— 本探针是唯一拦截点。
  {
    const probe = grep("RECOMMEND_LIMIT_DEFAULT", "src/lib/recommend/limits.ts");
    assert(
      probe.exit === 0 && probe.out.trim().length > 0,
      `已知命中探针：扫描器能命中真实字面量${probe.out.trim() ? "" : `（退出码 ${probe.exit}${probe.err ? "：" + probe.err.split("\n")[0] : ""}）`}`,
    );
  }
  // ★ 批 4 / T7：单文件探针只能证明「文件内能命中」，证明不了「目录遍历可用」（`-- src` 是目录）。
  //   补一条目录级探针，堵住「只扫了单文件 / 目录参数解析坏掉」这类假绿。
  {
    const dir = grep("RECOMMEND_LIMIT_DEFAULT", "src");
    const lines = dir.out.split("\n").filter((l) => l.trim());
    const files = new Set(lines.map((l) => l.split(":")[0]));
    assert(
      dir.exit === 0 && lines.length > 0 && files.size >= 2,
      `目录级探针：git grep 能遍历 src/ 并跨多文件命中（行数 ${lines.length} / 文件数 ${files.size}，要求 行数>=1 且 文件数>=2）`,
    );
  }

  // ★ 夹具行常量：自证用 `===` 精确比对整行，**不用 includes**。
  //   为什么：`"limit: 50"` 也 `includes("limit: 5")` ⇒ 若用包含判据，P2 拿错行也能过，
  //   只剩负向对照单点挡住（单点防护）。精确相等把这个洞彻底关掉。
  const FIXTURE_LINES = [
    'const a = f({ limit: "5" });', // 下标 0 —— P3 靶子
    "const b = g({ limit: 5 });", // 下标 1 —— P2 靶子
    "const c = h({ n: v ?? 5 });", // 下标 2 —— P1 靶子
    "const d = k({ limit: 50 });", // 下标 3 —— 负向对照：不得被任何「5」的模式命中
  ];
  const patterns = [
    { re: "\\?\\?[[:space:]]*5([^0-9]|$)", why: "「?? 5」空值兜底写法", at: 2 },
    { re: "limit:[[:space:]]*5([^0-9]|$)", why: "「limit: 5」字面量", at: 1 },
    { re: 'limit:[[:space:]]*"5"', why: '「limit: "5"」字面量', at: 0 },
  ];

  // ★ 批 4 / T7：**模式自证**——每条正则必须在夹具上真的命中自己声明的靶子。
  //   没有这一层，「无残留」是一条永不失败的断言（判据在、靶子打不到）。
  //   ⚠️ 自证必须走 git grep（POSIX ERE），**不能用 `new RegExp(re)`**：三条正则都用了
  //     `[[:space:]]` 这个 POSIX 字符类，**JS RegExp 不支持**（会被解析成字符集 `[[:space:]`
  //     再跟一个字面 `]`）⇒ JS 侧验证会得出「意图正则也打不到靶子」的错误结论。
  //   ⚠️ 夹具必须放 os.tmpdir() 且用**相对路径** + `cwd=夹具目录`：给绝对路径 git 会报
  //     「outside repository」并 exit 128（`--no-index` 也救不了跨盘外的绝对路径）。
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mmap-limits-"));
    try {
      fs.writeFileSync(path.join(tmp, "fixture.ts"), FIXTURE_LINES.join("\n"), "utf8");
      const hitIn = (re: string): string[] => {
        const r = grep(re, "fixture.ts", { cwd: tmp, noIndex: true });
        if (r.exit === 1) return []; // 1 = 无命中 ⇒ 没打中靶子，由下面的断言判红
        if (r.exit !== 0) throw new Error(`夹具扫描失败（git grep 退出码 ${r.exit}）：${r.err.split("\n")[0]}`);
        return r.out.trim().split("\n").filter(Boolean);
      };
      const hitBodies: string[] = [];
      for (const p of patterns) {
        const h = hitIn(p.re);
        const body = h.map((l) => l.replace(/^fixture\.ts:\d+:/, "").trim());
        // 精确相等（不是 includes）：命中行必须**整行等于**该模式声明的夹具行。
        assert(
          h.length === 1 && body[0] === FIXTURE_LINES[p.at],
          `模式自证：${p.why} 在夹具上命中且只命中自己的靶子（期望整行 "${FIXTURE_LINES[p.at]}"；命中 ${h.length} 行${body.length ? "：" + body.join(" | ") : "（0 命中 ⇒ 本条「无残留」是死断言）"}）`,
        );
        hitBodies.push(...body);
      }
      assert(
        patterns.length === new Set(patterns.map((p) => p.re)).size,
        `三条正则互不相同（防同一条被复制两份充当覆盖；实际 ${new Set(patterns.map((p) => p.re)).size}/${patterns.length}）`,
      );
      // ★ 验收判据按**内容**，不按行号：行号是夹具布局的函数，凑个行序就能让断言退化成自证。
      assert(
        hitBodies.length === patterns.length && new Set(hitBodies).size === patterns.length,
        `三条模式命中集合两两交集为空（各命中不同内容行；实际 ${hitBodies.length} 行 / 去重 ${new Set(hitBodies).size} 行）`,
      );
      assert(
        hitBodies.length === patterns.length && hitBodies.every((b) => b !== FIXTURE_LINES[3]),
        `limit: 50 被三模式命中 0 行（负向对照，整行精确比对；实际命中 ${hitBodies.filter((b) => b === FIXTURE_LINES[3]).length} 行）`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  for (const p of patterns) {
    const r = grep(p.re, "src");
    if (r.exit !== 0 && r.exit !== 1) {
      assert(false, `${p.why} 扫描失败（git grep 退出码 ${r.exit}${r.err ? "：" + r.err.split("\n")[0] : ""}）——不得静默当无命中`);
      continue;
    }
    const hits = r.exit === 0 ? r.out : "";
    // 保守做法：`?? 5` 这类写法本身是合法的 JS（只是不该用在「张数」上），
    // 故只对「同一行同时出现 limit/LIMIT/张/卡片/条」的命中判红（避免误伤 `x ?? 5` 的其它语义）；
    // 再按 EXEMPT 的「文件:行」精确豁免（豁免之外的第 5 行仍会红）。
    const lines = hits
      .split("\n")
      .filter((l) => l.trim())
      .filter((l) => /limit|LIMIT|张|卡片|条/.test(l))
      .filter((l) => {
        const m = /^([^:]+):(\d+):/.exec(l);
        return m ? !exemptKey(m[1], Number(m[2])) : true;
      });
    assert(lines.length === 0, `${p.why} 无残留${lines.length ? "：" + lines.join(" | ") : ""}`);
  }

  // 豁免清单逐条打印理由（不是静默跳过）
  console.log("  ── 豁免清单（逐条打印 文件:行 + 理由）──");
  for (const e of EXEMPT) console.log(`  SKIP  ${e.file}:${e.line}  ${e.reason}`);
}

console.log("\n" + (fail === 0 ? "✅ 全部通过" : "❌ 有失败") + "：pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
