/**
 * 逐跳累加口径 · 真实库验收（scripts/test-eta-basis.ts，v4.1.0）
 *
 * ── 2026-11-09 负责人裁定（本文件的判据）────────────────────────────────
 *   `p50_minutes` = 离开B − 离开A = **行驶 + B 站停站**。怎么用取决于这一跳是不是**末跳**：
 *     · **中间跳**（B 不是本次下车站）⇒ 车真的停、乘客继续坐 ⇒ 停站是**真实等待** ⇒ `total`；
 *     · **末跳**（B = 本次下车站）⇒ 乘客到 B 就下车，停站发生在下车之后 ⇒ `run`（纯行驶）。
 *   `lookupHop(..., { final })` 默认 `false`（中间跳）；末跳必须显式 `final:true`。
 *   `rideOfHops` 自动把最后一跳标为末跳。
 *
 * 用法：npm run test:eta-basis [-- cloud|local]   （只读，不改库）
 *   默认取 `DATABASE_URL_CLOUD_SESSION ?? DATABASE_URL_LOCAL ?? DATABASE_URL`。
 *
 * 实测基准（桶 `day`，C656 → C653，「路環警察訓練營-2」→「金峰南岸/金譽峰」）：
 *   ★ 批 1 · S-06：25 / 26 的 `C656→C654` 中间跳有**司机休息证据**（dwells ≥5 分样本），
 *     停站右偏、p50 系统性偏乐观 ⇒ 该跳「到站时间」改用 `avg_minutes`。
 *     目标值来自 #14 两份独立实跑（data-engineer R1/R2 + qa-engineer V1/V2）互证，
 *     本批一次落地、一次验收；26A 与 3 路不在特判集合内，读数不变。
 *   | 线路 | 中间跳 C656→C654 | 末跳 C654→C653 | 正确合计 |
 *   | 25   | total 2.4 (avg)  | run 0.9        | 3.3      |
 *   | 26   | total 2.1 (avg)  | run 0.917      | 3.017    |  ← 断言目标 3.02；实跑 3.017
 *   | 26A  | total 1.3        | run 1.0        | 2.3      |  ← 不在特判集合，不动
 *
 * 分解自洽（G10）：25 = 2.4 + 0.9 = 3.3；⑨ 的 `hopMin=[2.4,0.9]` 与 `sum=3.3` 同步。
 *
 * ⑧⑨ 另覆盖实时层的 `toBusArrival`（车 → **候车站**）：候车站同样是「到达点」，
 *   最后一跳用 `run`（2026-11-09 同一裁定），见脚本内注释。
 */
import { Client } from "pg";
import { buildSegmentIndex, lookupHop, rideOfHops } from "../src/lib/recommend/segment-lookup";
import { toBusArrival } from "../src/lib/recommend/live";
import type { EtaBus } from "../src/lib/dsat/eta";
import type { RouteIndex, SegmentStatRow } from "../src/lib/recommend/types";

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
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-9;

async function main() {
  const target = process.argv[2] as "local" | "cloud" | undefined;
  const raw =
    target === "local"
      ? process.env.DATABASE_URL_LOCAL
      : target === "cloud"
        ? process.env.DATABASE_URL_CLOUD_SESSION ?? process.env.DATABASE_URL
        : (process.env.DATABASE_URL_CLOUD_SESSION ?? process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL);
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

  try {
    const rows = (await client.query(
      `SELECT route_code, from_station, to_station, weekday, time_bucket, arrive_kind,
              avg_minutes, p50_minutes, samples, p50_run_minutes
         FROM segment_stats`,
    )).rows as unknown as SegmentStatRow[];
    const idx = buildSegmentIndex(rows);
    console.log(`\n  segment_stats ${rows.length} 行（真实库）· 桶=day · C656 → C653`);

    console.log("\n① 中间跳 C656→C654（final:false）⇒ total（S-06：司机休息站对取 avg 2.4）");
    {
      const h = lookupHop(idx, "25", "C656", "C654", "day", { final: false });
      ok(h.basis === "total" && h.minutes !== null && near(h.minutes, 2.4, 0.06), `25 ⇒ ${h.basis} ${h.minutes} ≈ 2.4`, JSON.stringify(h));
    }

    console.log("\n② 同一跳作为末跳（final:true）⇒ run");
    {
      const h = lookupHop(idx, "25", "C656", "C654", "day", { final: true });
      ok(h.basis === "run" && h.minutes !== null && near(h.minutes, 0.8, 0.06), `25 ⇒ ${h.basis} ${h.minutes} ≈ 0.8`, JSON.stringify(h));
    }

    console.log("\n③ 末跳 C654→C653（final:true）⇒ run");
    {
      const h = lookupHop(idx, "25", "C654", "C653", "day", { final: true });
      ok(h.basis === "run" && h.minutes !== null && near(h.minutes, 0.9, 0.06), `25 ⇒ ${h.basis} ${h.minutes} ≈ 0.9`, JSON.stringify(h));
    }

    console.log("\n④ 25 路两跳合计 = 2.4 + 0.9 ≈ 3.3（容差 ±0.06）");
    {
      const r = rideOfHops(idx, "25", [["C656", "C654"], ["C654", "C653"]], "day");
      ok(near(r.minutes, 3.3, 0.06), `minutes=${Math.round(r.minutes * 10) / 10} ≈ 3.3（levels=${r.levels.join("/")}）`);
    }

    console.log("\n⑤ 26 / 26A 同款两跳（26 实跑 3.017、断言目标 3.02；26A 不动）");
    {
      const r26 = rideOfHops(idx, "26", [["C656", "C654"], ["C654", "C653"]], "day");
      ok(near(r26.minutes, 3.02, 0.06), `26 minutes=${Math.round(r26.minutes * 100) / 100} ≈ 3.02（实跑 3.017 = 2.1 + 0.917；levels=${r26.levels.join("/")}）`);
      const r26a = rideOfHops(idx, "26A", [["C656", "C654"], ["C654", "C653"]], "day");
      // ★ S-06 收紧（铁律 52 红→绿已验，见 test:tolerance-guard）：
      //   原 ±0.15 系早期 25/26/26A 三线统一写法遗留，非低样本/高波动需要。
      //   26A day 桶样本 52/45、stddev 0.35/0.57 为三线最小（26 是 31/30、stddev 1.45；
      //   25 是 87/85、stddev 1.38/1.01），合计 2.3=1.3+1.0 精确整数 ⇒ 收紧到 ±0.06 余量充足（取证 2026-11-09T08:21:55Z）。
      ok(near(r26a.minutes, 2.3, 0.06), `26A minutes=${Math.round(r26a.minutes * 100) / 100} ≈ 2.3（levels=${r26a.levels.join("/")}）`);
    }

    console.log("\n⑥ 只有一站（目的站就是 C654）：末跳即唯一跳 ⇒ run 0.8（不得变成 total）");
    {
      const r = rideOfHops(idx, "25", [["C656", "C654"]], "day");
      ok(near(r.minutes, 0.8, 0.06), `minutes=${Math.round(r.minutes * 10) / 10} ≈ 0.8（levels=${r.levels.join("/")}）`);
    }

    console.log("\n⑦ p50_run_minutes 缺失时回退 total（真实行：3 路 M118→M239，run=NULL）");
    {
      const h = lookupHop(idx, "3", "M118", "M239", "day", { final: true });
      ok(h.basis === "total" && h.minutes !== null && near(h.minutes, 1.6, 0.06), `3 路末跳 ⇒ ${h.basis} ${h.minutes}（回退成功、不报错）`, JSON.stringify(h));
      // 对照：同一行确实没有 run 列
      const r0 = rows.find(
        (x) => x.route_code === "3" && x.from_station === "M118" && x.to_station.startsWith("M239") && x.weekday === -1 && x.time_bucket === "day" && x.arrive_kind === "stop",
      );
      ok(r0 != null && (r0.p50_run_minutes === null || r0.p50_run_minutes === undefined), "该行 p50_run_minutes 确为 NULL");
    }

    /**
     * ⑧⑨ `toBusArrival` —— 车 → **候车站**的 ETA（实时层）。
     * 2026-11-09 裁定：**候车站也是「到达点」**（乘客在这里等车，到站后的停站发生在他上车
     * 过程里，不是他要等的等待）⇒ 最后一跳必须用 `run`。
     * 用真实 `segment_stats` 构建的 `segIdx` + 最小 `RouteIndex`（`e.hops` 已给出，
     * 不走「按站序本地展开」的降级路径）。
     */
    const emptyRouteIdx: RouteIndex = {
      dirStops: new Map(),
      seqIdx: new Map(),
      dirsOf: new Map(),
      nameOf: new Map(),
      adjOwners: new Map(),
    };
    const etaOf = (hops: [string, string][]): EtaBus => ({
      plate: null,
      stopsAway: hops.length,
      atStation: hops[0]![0],
      atStationName: "測試站",
      status: "1", // 停靠挂载站 ⇒ etaSec = Σ hopMin
      hops,
    });

    console.log("\n⑧ 车在 C656、候车站 C654（唯一跳即末跳）⇒ run 0.8，不是 total 2.4");
    {
      const a = toBusArrival(emptyRouteIdx, idx, "25", "0", etaOf([["C656", "C654"]]), "day");
      const sum = Math.round(a.hopMin.reduce((x, y) => x + y, 0) * 100) / 100;
      ok(a.hopMin.length === 1 && near(a.hopMin[0]!, 0.8, 0.06), `hopMin=${JSON.stringify(a.hopMin)}，末跳=run 0.8`, `etaSec=${a.etaSec}`);
      ok(near(sum, 0.8, 0.06), `合计=${sum} ≈ 0.8（若用 total 会是 2.4）`);
      // ★ S-05：etaSec 由「只打印」升级为独立断言（0.8 分 ⇒ 48 秒，口径切换不影响末跳）
      //   etaSec 类型可选 ⇒ 显式判空本身即「该字段必须存在」的断言，兼过 tsc strict
      ok(a.etaSec != null && near(a.etaSec, 48, 1), `etaSec=${a.etaSec} ≈ 48（0.8 分 × 60）`);
    }

    console.log("\n⑨ 车在 C656、候车站 C653（两跳）⇒ 2.4(total) + 0.9(run) = 3.3");
    {
      const a = toBusArrival(emptyRouteIdx, idx, "25", "0", etaOf([["C656", "C654"], ["C654", "C653"]]), "day");
      const sum = Math.round(a.hopMin.reduce((x, y) => x + y, 0) * 100) / 100;
      ok(
        a.hopMin.length === 2 && near(a.hopMin[0]!, 2.4, 0.06) && near(a.hopMin[1]!, 0.9, 0.06),
        `hopMin=${JSON.stringify(a.hopMin)}（中间跳 total 2.4、末跳 run 0.9）`,
        `etaSec=${a.etaSec}`,
      );
      ok(near(sum, 3.3, 0.06), `合计=${sum} ≈ 2.4 + 0.9 = 3.3`);
      // ★ S-05：独立断言 etaSec 与区间（3.3 分 ⇒ 198 秒；loSec/hiSec = round(198×0.6/1.4)）
      ok(a.etaSec != null && near(a.etaSec, 198, 1), `etaSec=${a.etaSec} ≈ 198（3.3 分 × 60）`);
      ok(a.loSec === 119 && a.hiSec === 277, `区间 loSec/hiSec=${a.loSec}/${a.hiSec} ≈ 119/277`);
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
