/**
 * 卡片 limit 同源一致性断言（scripts/test-card-limit-consistency.ts · 2026-11-04）
 *
 * ── 它守的是什么（一句话）──────────────────────────────────────────────
 *   「**列表页出几张卡，卡片链接就必须按几张卡回查**」。
 *
 * ── 为什么必须脚本化（这正是一个已经发生过的 P0）───────────────────────
 *   `/recommend` 首屏由 `recommend({limit})` 出卡；点卡片时走
 *   `buildCardHref()`（`src/lib/recommend/card-link.ts:28-40`），而
 *   `RecommendCard.tsx:158-169` 点击时**不传 limit** ⇒ href 里写的是
 *   `card-link.ts:39` 的缺省 5。
 *   详情页 `cardDetail()` 用 href 里的 limit 重新 `recommend()`（`card.ts:75-85`）
 *   ⇒ 只要首屏 limit > 5，**第 6 张卡必然 `route_changed`**（`card.ts:89-93`），
 *   页面表现是「点了没反应」。
 *
 *   ⚠️ 这个缺陷**无法被类型检查、单测、或读代码发现**：两处各自都"正确"，
 *      错的是**同一个概念的取值不一致**。所以只能靠跨模块的运行时断言守住。
 *
 * ── 判定（两条，都必须过）──────────────────────────────────────────────
 *   A1 同源：每张卡的 `href` 内 `limit` 参数 === 页面请求的 limit
 *   A2 可点：用该 `href` 的真实参数调 `cardDetail()`，必须 `ok === true`
 *
 *   A1 先失败就报 A1（根因更上游），A1 过了再看 A2。
 *
 * ── 用法 ───────────────────────────────────────────────────────────────
 *   npm run check:card-limit                 # 用默认（见 §PAGE_LIMIT 解析）
 *   PAGE_LIMIT=5 npm run check:card-limit    # 指定口径（用于证明断言本身没坏）
 *
 * ── PAGE_LIMIT 解析顺序（为什么不是写死）──────────────────────────────
 *   1. 环境变量 `PAGE_LIMIT`（显式指定，优先级最高）；
 *   2. `src/lib/recommend/limits.ts` 的 `RECOMMEND_LIMIT_DEFAULT`
 *      （**修复后应该存在的单一常量**；存在即以此为准）；
 *   3. 兜底 **6**（= U10 的目标值）。
 *   ⇒ 修复前跑会落在 3（→ 断言红）；修复后自动走 2（→ 断言绿），无需改脚本。
 *
 * ── 只读声明 ───────────────────────────────────────────────────────────
 *   仅 SELECT + 调用现有纯/查询逻辑。**不写库、不改文件**。
 *
 * ── 时段声明（重要）────────────────────────────────────────────────────
 *   巴士是 DSAT 实时数据、**无法伪造**（`service.ts:88-91`）⇒ 本脚本的结论
 *   是**时点相关**的：深夜跑会因大量线路收班而样本变少。复测请与基线同时段
 *   （见 `docs/迭代-导航修复-20261104/route-changed-baseline-20261104.md`）。
 */
import { getPool } from "@/lib/db";
import { recommend, clearRecommendCache } from "@/lib/recommend/service";
import { cardDetail } from "@/lib/recommend/card";
import { buildCardHref } from "@/lib/recommend/card-link";
import type { SchoolZone } from "@/lib/recommend/types";

/* ══════════════════════════════════════════════════════════════════════════
 * PAGE_LIMIT 解析
 * ══════════════════════════════════════════════════════════════════════════ */

/** 兜底值：U10 的目标（首屏 6 张）。修复后应由 RECOMMEND_LIMIT_DEFAULT 取代。 */
const FALLBACK_PAGE_LIMIT = 6;

async function resolvePageLimit(): Promise<{ value: number; source: string }> {
  const env = Number(process.env.PAGE_LIMIT);
  if (Number.isFinite(env) && env > 0) {
    return { value: Math.trunc(env), source: "env PAGE_LIMIT" };
  }
  try {
    // 修复后应存在；不存在时 import 抛错 ⇒ 落兜底（不视为失败）
    const mod = (await import("@/lib/recommend/limits")) as { RECOMMEND_LIMIT_DEFAULT?: number };
    if (typeof mod.RECOMMEND_LIMIT_DEFAULT === "number") {
      return { value: mod.RECOMMEND_LIMIT_DEFAULT, source: "RECOMMEND_LIMIT_DEFAULT" };
    }
  } catch {
    /* 常量尚未建立 ⇒ 走兜底 */
  }
  return { value: FALLBACK_PAGE_LIMIT, source: "FALLBACK（U10 目标值）" };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 样本集
 * ──────────────────────────────────────────────────────────────────────────
 * 覆盖 4 类 OD，与基线报告保持一致（`route-changed-baseline-20261104.md`）。
 * 含座区与跨午夜变体 —— 座区会改变步行分钟 ⇒ 排序可能变 ⇒ 卡片顺序变。
 * ══════════════════════════════════════════════════════════════════════════ */

interface Case {
  od: string;
  from: string;
  to: string;
  zone: SchoolZone | null;
  /** 注入时刻（跨午夜类用）；**每组前必须 clearRecommendCache**，见 §缓存陷阱 */
  nowMs?: number;
}

/** 澳门 2026-11-04（周三）01:00 = UTC+8 ⇒ 前一日 17:00Z */
const MACAU_0100 = Date.parse("2026-11-03T17:00:00Z");

const CASES: Case[] = [
  { od: "home→school", from: "home", to: "school", zone: "B/C" },
  { od: "home→school", from: "home", to: "school", zone: "N/O" },
  { od: "home→school", from: "home", to: "school", zone: "R" },
  { od: "school→home", from: "school", to: "home", zone: "B/C" },
  { od: "school→home", from: "school", to: "home", zone: "N/O" },
  { od: "school→home", from: "school", to: "home", zone: "R" },
  { od: "home→gate", from: "home", to: "gate", zone: null },
  { od: "gate→home", from: "gate", to: "home", zone: null },
  { od: "home→hengqin", from: "home", to: "hengqin", zone: null },
  { od: "hengqin→home", from: "hengqin", to: "home", zone: null },
  // 跨午夜：25 末段 20:00–01:15、N3 00:00–06:00 仍在运营
  { od: "home→school", from: "home", to: "school", zone: "N/O", nowMs: MACAU_0100 },
  { od: "school→home", from: "school", to: "home", zone: "N/O", nowMs: MACAU_0100 },
];

/* ══════════════════════════════════════════════════════════════════════════
 * 主流程
 * ══════════════════════════════════════════════════════════════════════════ */

interface Fail {
  kind: "A1-href-limit" | "A2-unclickable";
  od: string;
  zone: string | null;
  rank: number;
  cardsCount: number;
  route: string;
  board: string;
  alight: string;
  hrefLimit: number;
  detail: string;
}

async function main() {
  const pool = getPool();
  const pageLimit = await resolvePageLimit();

  console.log("─".repeat(72));
  console.log("卡片 limit 同源一致性断言（scripts/test-card-limit-consistency.ts）");
  console.log(`PAGE_LIMIT = ${pageLimit.value}（来源：${pageLimit.source}）`);
  console.log(`HEAD       = ${process.env.GIT_HEAD ?? "(未注入)"}`);
  console.log("─".repeat(72));

  const fails: Fail[] = [];
  let totalCards = 0;

  for (const c of CASES) {
    // ★ 缓存陷阱：service.ts:112 的 key = from|to|zone|limit|prefs，**不含 nowMs**
    //   跨午夜注入若不清缓存，会拿到上一次真实时刻的结果 ⇒ 测试假通过。
    if (c.nowMs) clearRecommendCache();

    const r = await recommend(pool, {
      fromSlug: c.from, toSlug: c.to, zone: c.zone,
      limit: pageLimit.value, nowMs: c.nowMs,
    });
    const cards = r.cards;
    totalCards += cards.length;

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]!;
      const f = card.rides[0];
      if (!f) continue;

      // 真实链路：RecommendCard 点击**不传 limit** ⇒ 走 card-link.ts:39 缺省
      const href = buildCardHref({
        from: c.from, to: c.to, zone: c.zone,
        plan: card.planId, route: f.route, board: f.board, alight: f.alight, rank: i + 1,
      });
      const hrefLimit = Number(new URL(href, "http://x").searchParams.get("limit"));

      // ── A1 同源 ──
      if (hrefLimit !== pageLimit.value) {
        fails.push({
          kind: "A1-href-limit", od: c.od, zone: c.zone, rank: i + 1,
          cardsCount: cards.length, route: f.route, board: f.board, alight: f.alight,
          hrefLimit,
          detail: `页面 limit=${pageLimit.value} 但 href limit=${hrefLimit} ⇒ 该卡在详情页必然找不回（第 ${i + 1} 张）`,
        });
      }

      // ── A2 可点（用 href 的真实参数）──
      const d = await cardDetail(pool, {
        fromSlug: c.from, toSlug: c.to, zone: c.zone, limit: hrefLimit,
        planId: card.planId, route: f.route, board: f.board, alight: f.alight,
        nowMs: c.nowMs,
      });
      if (!d.ok) {
        fails.push({
          kind: "A2-unclickable", od: c.od, zone: c.zone, rank: i + 1,
          cardsCount: cards.length, route: f.route, board: f.board, alight: f.alight,
          hrefLimit,
          detail: `cardDetail 返回 ${d.error}（href limit=${hrefLimit}，页面 limit=${pageLimit.value}）`,
        });
      }
    }
    console.error(`  [od] ${c.od} zone=${c.zone ?? "-"} cards=${cards.length}`);
  }

  /* ── 输出 ── */
  console.log("─".repeat(72));
  console.log(`样本：${CASES.length} 组 · ${totalCards} 张卡`);
  console.log(`失败：${fails.length}（A1 ${fails.filter((x) => x.kind === "A1-href-limit").length} · A2 ${fails.filter((x) => x.kind === "A2-unclickable").length}）`);

  if (fails.length) {
    console.log("─".repeat(72));
    console.log("失败明细：");
    for (const x of fails) {
      console.log(`  [${x.kind}] ${x.od} zone=${x.zone ?? "-"} rank=${x.rank}/${x.cardsCount} route=${x.route} ${x.board}>${x.alight}`);
      console.log(`      ${x.detail}`);
    }
    console.log("─".repeat(72));
    console.log(
      "FAIL —— 「首屏出几张卡」与「href 按几张回查」不一致（或卡点不开）。\n" +
        "修复方向：两处共用单一常量 `RECOMMEND_LIMIT_DEFAULT`，且点击时把当前 limit 透传给 buildCardHref。",
    );
    await pool.end();
    process.exit(1);
  }

  console.log("─".repeat(72));
  console.log("PASS —— 首屏卡数与 href limit 同源，且每张卡都能回查。");
  await pool.end();
}

main().catch((e) => {
  console.error("FAIL（脚本异常）", e);
  process.exit(2);
});
