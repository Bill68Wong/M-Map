/**
 * 联生圆形地总站（C654）入向隔离测试（scripts/test-c654-isolation.ts，v4.1.0）
 * 用法：npm run test:c654-isolation -- cloud   （只读 SELECT；new Client() 直连 5432 会话模式、不经 db-guard、无生产确认门）
 *
 * 背景（负责人裁定）：25 / 26 路在 C654 的长停是司机休息。按 2026-11-09 新口径
 * （「是否末跳」决定口径）：中间跳取含休息的 `total`，末跳取 `run`；但这两条线的入向样本
 * 不得进入跨线邻接池（L4/L5），免得被同样经过 C654 的 50 / 26A / 21A / N3 当作普通中间跳
 * 取用（它们的乘客不在 C654 等司机休息）。见 `CROSS_ROUTE_EXCLUDED`。
 *
 * 断言四件事（全部基于真实 `segment_stats` 构建索引）：
 *   ① 隔离生效：`byAdj("C656|C654")` 不含 25 / 26 的行；
 *      **另有两条负向断言**：`51|M9`（關閘廣場）不在排除表、也不在 `midTerminus` ——
 *      该站虽同样有长停（3 条 dwell ≥5 分，最长 5.99 分），但**尚无司机休息证据**
 *      （站名不含總站、10 条线共用，更像口岸排队），负责人裁定不隔离。
 *      这两条是**防误加**的锁：后人看到「51 在 M9 也长停」就顺手加进隔离表时，测试会红。
 *   ② 本线不受影响：25 / 26 的 `C656→C654` 仍命中 L1~L3；作为**末跳**（`final:true`，
 *      即目的站就是 C654）时 `basis === "run"`（2026-11-09 口径：由「是否末跳」决定）；
 *   ③ 其他线拿不到 25/26 的值：50 / 26A / 21A 用自己的 L1~L3 行；
 *      真正落到 L4/L5 的线路（N3）其**来源行** `route_code` 不属于 {25,26}；
 *   ④ 出向仍共享：`byAdj("C654|C653")` 仍含 25 / 26 的行。
 *
 * ⚠️ 第 ③ 条为何不写成「返回值 ≠ 25/26 的 p50_run_minutes」：
 *    实测 25 / 26 / 50 / 26A / 21A 在 C654 的 `p50_run_minutes` **全部 = 0.8 分**
 *    （pure-run 就在 1 分钟内），数值相等无法区分来源 ⇒ 改成更强的**来源行**判据
 *    （L4/L5 选中的那行 `route_code` 必须不属于 {25,26}）+ `byAdj` 结构判据。
 *    这不是放宽，是换成能真正区分「拿了谁的样本」的断言。
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import {
  CROSS_ROUTE_EXCLUDED,
  buildSegmentIndex,
  lookupHop,
  mainCodeOf,
} from "../src/lib/recommend/segment-lookup";
import { loadMidTerminusKeys } from "../src/lib/rebuild/mid-terminus";
import type { SegmentStatRow } from "../src/lib/recommend/types";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 ⇒ 下面会提示 */
}

let failed = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failed++;
};

/**
 * 复刻 `segment-lookup.ts#pickRow` 的选行规则（同名判据 + 门槛 + 取样本最多者），
 * 用于回答「L4/L5 到底取了哪一条线路的样本」。
 */
const pickedRow = (
  rows: SegmentStatRow[] | undefined,
  pred: (r: SegmentStatRow) => boolean,
  minSamples: number,
): SegmentStatRow | null => {
  const hit = (rows ?? []).filter((r) => pred(r) && r.samples >= minSamples);
  if (!hit.length) return null;
  hit.sort((a, b) => b.samples - a.samples);
  return hit[0] ?? null;
};

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 落 L4/L5 时选中行的来源线路；未命中返回 null */
function poolSourceRoute(
  idx: ReturnType<typeof buildSegmentIndex>,
  key: string,
  bucket: string,
  level: number,
): string | null {
  const adj = idx.byAdj.get(key);
  const r =
    level === 4
      ? pickedRow(adj, (x) => x.weekday === -1 && x.time_bucket === bucket && x.arrive_kind === "stop", 5)
      : level === 5
        ? pickedRow(adj, () => true, 1)
        : null;
  return r?.route_code ?? null;
}

async function main() {
  const target = process.argv[2] as "local" | "cloud" | undefined;
  const raw =
    target === "cloud"
      ? process.env.DATABASE_URL
      : target === "local"
        ? process.env.DATABASE_URL_LOCAL
        : (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL);
  if (!raw) {
    console.error("❌ 未找到连接串（.env 的 DATABASE_URL / DATABASE_URL_LOCAL）");
    process.exit(1);
  }
  const u = new URL(raw);
  if (u.port === "6543") u.port = "5432"; // 只用会话模式，避免事务池干扰
  const client = new Client({
    connectionString: u.toString(),
    ssl: raw.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  const q = async (sql: string) => (await client.query(sql)).rows as Record<string, unknown>[];

  try {
    const rows = (await q(
      `SELECT route_code, from_station, to_station, weekday, time_bucket, arrive_kind,
              avg_minutes, p50_minutes, samples, p50_run_minutes
         FROM segment_stats`,
    )) as unknown as SegmentStatRow[];
    const midTerminus = await loadMidTerminusKeys((sql) => q(sql));
    const idx = buildSegmentIndex(rows, { midTerminus });

    console.log(`\n  segment_stats ${rows.length} 行 · midTerminus ${midTerminus.size} 项`);

    console.log(`\n① 隔离生效：byAdj("C656|C654") 不含 25 / 26`);
    const pool = idx.byAdj.get("C656|C654") ?? [];
    const routesInPool = [...new Set(pool.map((r) => r.route_code))].sort();
    ok(pool.length > 0, `跨线池非空（${pool.length} 行）`, `routes=${routesInPool.join(",")}`);
    ok(pool.every((r) => r.route_code !== "25"), "池中无 25 路行");
    ok(pool.every((r) => r.route_code !== "26"), "池中无 26 路行");
    ok(routesInPool.some((x) => ["50", "26A", "21A"].includes(x)), "池中仍有其他线路可用（50/26A/21A）");
    // 负向断言（负责人 2026-11-09 边界裁定）：51 在 M9 的长停机制不明，不得隔离
    ok(!CROSS_ROUTE_EXCLUDED.has("51|M9"), "51|M9 不在排除表（负责人裁定：无休息证据，不隔离）");
    ok(!midTerminus.has("51|M9"), "51|M9 不在 midTerminus（站名不含總站）");

    console.log(`\n② 本线不受影响：25 / 26 的 C656→C654 仍走 L1~L3，末跳 basis=run`);
    ok(midTerminus.has("25|C654"), "midTerminus 含 25|C654");
    ok(midTerminus.has("26|C654"), "midTerminus 含 26|C654");
    for (const route of ["25", "26"]) {
      const key = `${route}|C656|C654`;
      const own = idx.byRoute.get(key) ?? [];
      ok(own.length > 0, `${route} 的 byRoute("${key}") 仍有 ${own.length} 行（本线数据未被误删）`);
      for (const bucket of ["day", "all", "night", "am_work", "pm", "am_weekend"]) {
        // ★ 2026-11-09：末跳（目的站 = C654）才取 run；中间跳取 total（含司机休息的真实等待）。
        const h = lookupHop(idx, route, "C656", "C654", bucket, { final: true });
        ok(
          h.level >= 1 && h.level <= 3 && h.basis === "run" && h.minutes !== null,
          `${route}@${bucket} → L${h.level} basis=${h.basis} minutes=${h.minutes}`,
          JSON.stringify(h),
        );
      }
    }

    console.log(`\n③ 其他线拿不到 25/26 的值`);
    // 50 / 26A / 21A：本线有全周样本（L2 必中），取值与自己的 byRoute 行一致
    for (const route of ["50", "26A", "21A"]) {
      // ★ 按末跳取（目的站 = C654），比对 `p50_run_minutes`；语义与来源判据不变。
      const h = lookupHop(idx, route, "C656", "C654", "day", { final: true });
      const ownRun = num(
        (idx.byRoute.get(`${route}|C656|C654`) ?? [])
          .filter((r) => r.weekday === -1 && r.time_bucket === "all" && r.arrive_kind === "stop")
          .sort((a, b) => b.samples - a.samples)[0]?.p50_run_minutes,
      );
      ok(h.level >= 1 && h.level <= 3, `${route} 命中本线层级（L${h.level}），不从跨线池取`, JSON.stringify(h));
      ok(
        ownRun !== null && h.minutes === Math.round(ownRun * 10) / 10,
        `${route} minutes=${h.minutes} ≡ 本线 p50_run=${ownRun}`,
      );
    }
    // N3 在本站没有任何 segment_stats 行 ⇒ 必然落 L4/L5：来源行不得是 25/26
    // ⚠️ 这是**数据基线**断言：若日后 N3 在 C654 有了自己的样本（落 L1~L3），
    //    「必然落跨线层」会失败 —— 属数据变更，请复核后调整基线，不要直接删断言。
    for (const bucket of ["day", "all", "night", "am_work", "pm", "am_weekend"]) {
      const h = lookupHop(idx, "N3", "C656", "C654", bucket);
      const src = poolSourceRoute(idx, "C656|C654", bucket, h.level);
      ok(h.level === 4 || h.level === 5, `N3@${bucket} 落在跨线层（L${h.level}）`, JSON.stringify(h));
      ok(
        src !== null && src !== "25" && src !== "26",
        `N3@${bucket} → L${h.level}，跨线来源线路 = ${src ?? "（null）"}`,
      );
      ok(h.minutes !== null && h.minutes > 0, `N3@${bucket} 仍有可用值 ${h.minutes}`);
    }

    console.log(`\n④ 出向仍共享：byAdj("C654|C653") 仍含 25 / 26`);
    const out = idx.byAdj.get("C654|C653") ?? [];
    const outRoutes = [...new Set(out.map((r) => r.route_code))].sort();
    ok(out.some((r) => r.route_code === "25"), "出向池含 25 路行（未误伤）", `routes=${outRoutes.join(",")}`);
    ok(out.some((r) => r.route_code === "26"), "出向池含 26 路行（未误伤）");
    // 25 / 26 出向的 key 必须仍带 C654：确认只排入向
    const out25 = (idx.byAdj.get("C654|C653") ?? []).filter((r) => r.route_code === "25");
    ok(
      out25.length > 0 && out25.every((r) => mainCodeOf(r.from_station) === "C654"),
      `25 的行都在 from=C654 一侧（${out25.length} 行）`,
    );

    console.log(`\n  快照 byAdj("C656|C654") routes = ${routesInPool.join(",") || "（空）"}`);
    console.log(`  快照 byAdj("C654|C653") routes = ${outRoutes.join(",") || "（空）"}`);

    // ── ⑤ S-11：测试副本 pickedRow ≡ 生产 pickRow 选行规则（对钉；不加 export、零 src/ 改动）──
    console.log("\n⑤ S-11：副本 pickedRow ≡ 生产 pickRow（源码文本锁 + 运行时自证）");
    {
      // 生产 pickRow 未导出（零 src/ 约束）⇒ 用**源码文本断言**锁规则，防「生产改了规则、副本没跟上」的静默分叉。
      const srcPath = path.resolve(process.cwd(), "src/lib/recommend/segment-lookup.ts");
      const src = fs.readFileSync(srcPath, "utf8");
      const m = /const pickRow = \(([\s\S]*?)\n\};/.exec(src);
      const body = m ? m[0] : "";
      ok(body.length > 0, "源码文本断言：能抽取到生产 pickRow 函数体", body ? "" : "（抽取失败）");
      const hasThreshold = /samples\s*>=\s*minSamples/.test(body);
      const hasSort = /sort\(\s*\(a,\s*b\)\s*=>\s*b\.samples\s*-\s*a\.samples\s*\)/.test(body);
      ok(hasThreshold, "生产 pickRow 含门槛 `r.samples >= minSamples`（与副本一致）");
      ok(hasSort, "生产 pickRow 含排序 `b.samples - a.samples`（取样本最多者，与副本一致）");
      if (!hasThreshold || !hasSort) {
        console.log("  试图匹配的源码片段：\n  " + (body.slice(0, 400) || src.slice(0, 300)));
      }
      // 运行时自证：副本 pickedRow 行为 = 规则定义（门槛 + 取样本最多者）
      const demo: SegmentStatRow[] = [
        { route_code: "X", from_station: "A", to_station: "B", weekday: -1, time_bucket: "all", arrive_kind: "stop", avg_minutes: 1, p50_minutes: 1, samples: 5, p50_run_minutes: null },
        { route_code: "X", from_station: "A", to_station: "B", weekday: -1, time_bucket: "all", arrive_kind: "stop", avg_minutes: 1, p50_minutes: 1, samples: 12, p50_run_minutes: null },
        { route_code: "X", from_station: "A", to_station: "B", weekday: -1, time_bucket: "all", arrive_kind: "stop", avg_minutes: 1, p50_minutes: 1, samples: 3, p50_run_minutes: null },
      ];
      const picked = pickedRow(demo, () => true, 5);
      ok(picked?.samples === 12, "运行时：副本 pickedRow 取样本最多者（12，非 5/3）", `${picked?.samples}`);
      ok(pickedRow([demo[2]], () => true, 5) === null, "运行时：副本 pickedRow 门槛生效（3<5 ⇒ null）");
    }
  } finally {
    await client.end();
  }

  console.log(failed ? `\n❌ ${failed} 条断言失败` : `\n✅ 全部断言通过`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error("❌ 测试失败：", e);
  process.exit(1);
});
