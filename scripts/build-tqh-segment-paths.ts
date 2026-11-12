/**
 * 通琴号 · 相邻有向站对离线算路（CLI 编排，scripts/build-tqh-segment-paths.ts）
 *
 * 用法：
 *   npm run db:build-tqh-paths                        # dry-run（默认，只读，不调高德）
 *   npm run db:build-tqh-paths -- --stats              # 只统计已落库的几何
 *   npm run db:build-tqh-paths -- --apply --allow-prod # 真算 + 真写
 *
 * ── 为什么几何必须离线算（Spec §6.1 / OD-04 / 架构 ADR-001）──────────────
 *   80 个班次 843 条站序 → 763 次相邻关系，**去重后仅 302 个有向站对**
 *   （跨班次复用率 60.4%）。算一次落 `tqh_segment_paths`，请求期
 *   `/api/tqh/trip-path` 只做一次 LEFT JOIN，**零外部调用**。
 *   放进请求路径的话：高德配额用尽会静默返回空 ⇒「时好时坏且不报错」。
 *
 * ── 本文件只负责「怎么调用」────────────────────────────────────────────
 *   取数/算路/落库的实现全在 `scripts/lib/tqh-segment.ts`（含三条硬口径的说明：
 *   不转坐标 · 走现有 3 QPS 令牌桶 · 失败降级不造假）。CLI 只做：
 *   命令行解析 → 口径核对 → 三种模式 → 报告，**不碰 SQL 与 HTTP 细节**。
 *
 * ── 幂等 ────────────────────────────────────────────────────────────────
 *   `ON CONFLICT (from_station_id, to_station_id, profile) DO UPDATE`。
 *   重跑 = 全量重算（Spec §7.3：每季度主动全量一次），无需先清表。
 *
 * ⚠️ 本脚本只写 `tqh_segment_paths`，不建表。表由 `db:migrate-v3702` 负责。
 */
import fs from "node:fs";
import { AMAP_QPS } from "../src/lib/amap/rate-limit";
import { TQH_SEGMENT_PROFILE } from "../src/lib/tqh/types";
import {
  type Pair,
  type SegRow,
  fetchDriving,
  loadExisting,
  loadPairCounts,
  loadPairs,
  straightRow,
  upsertSegment,
} from "./lib/tqh-segment";
import { getPool } from "../src/lib/db";

try {
  // ★ 2026-11-12 修：原硬编码作者机路径 ⇒ 读 cwd/.env。
  process.loadEnvFile();
} catch {
  /* 没有 .env：连接串缺失会在建池时报可读错误 */
}

const APPLY = process.argv.includes("--apply");
const STATS_ONLY = process.argv.includes("--stats");
/** 实测去重口径（Spec §6.1）：763 次相邻关系 → 302 个有向站对 */
const EXPECTED_PAIRS = 302;
/** 单次高德请求的往返耗时假设（3 QPS 下取 400ms 更保守，用于 dry-run 估时） */
const ASSUMED_RTT_MS = 400;
const OUT = ".verify/build-tqh-segment-paths.out.txt";

const out: string[] = [];
const say = (s = ""): void => {
  out.push(s);
  console.log(s);
};

/** 属地简写：`澳门` → `澳`、`横琴` → `琴`（与 UI 的「澳/琴」标签同口径） */
const sideTag = (s: string): string => (s === "澳门" ? "澳" : "琴");

/** 失败清单用的可读标签：`21「澳门科技大学南门…」澳 → 88「南迎客平台…」琴` */
const labelOf = (p: Pair): string =>
  `${p.from}「${p.fromName}」${sideTag(p.fromSide)} → ${p.to}「${p.toName}」${sideTag(p.toSide)}`;

async function statsMode(pairs: Pair[], existing: Map<string, { source: string }> | null): Promise<void> {
  say("");
  say("[--stats] 已落库几何统计");
  if (existing === null) {
    say("    tqh_segment_paths 不存在 ⇒ 0 行。先跑 npm run db:migrate-v3702（需负责人放行 --apply）");
    return;
  }
  const res = await getPool().query(
    `SELECT source,
            count(*)::int AS n,
            count(*) FILTER (WHERE polyline IS NULL)::int AS null_poly,
            min(distance_m) AS min_m, max(distance_m) AS max_m,
            round(avg(distance_m)::numeric, 0) AS avg_m,
            round(avg(jsonb_array_length(polyline))::numeric, 1) AS avg_pts,
            min(computed_at) AS min_at, max(computed_at) AS max_at
       FROM tqh_segment_paths WHERE profile = $1 GROUP BY source ORDER BY source`,
    [TQH_SEGMENT_PROFILE],
  );
  say(`    profile=${TQH_SEGMENT_PROFILE} · 站对数 ${pairs.length}`);
  /** pg 把 timestamptz 反序列化成 Date；直接 String() 会得到 `Fri Nov 06 2026 08:` 这种碎片 */
  const iso = (v: unknown): string => new Date(v as string).toISOString().slice(0, 19).replace("T", " ");
  for (const r of res.rows as Record<string, unknown>[]) {
    say(
      `    ${String(r.source).padEnd(18)} ${String(r.n).padStart(4)} 行 · polyline 空 ${r.null_poly} · ` +
        `距离 ${r.min_m}~${r.max_m} m（均 ${r.avg_m}）· 均点数 ${r.avg_pts} · ` +
        `${iso(r.min_at)} ~ ${iso(r.max_at)}`,
    );
  }
  say(`    覆盖率：${existing.size} / ${pairs.length}（${((existing.size / pairs.length) * 100).toFixed(1)}%）`);
}

async function dryRun(
  pairs: Pair[],
  existing: Map<string, { source: string }> | null,
  edges: number,
): Promise<void> {
  const pending = existing ? pairs.filter((p) => !existing.has(`${p.from}|${p.to}`)) : pairs;
  const estSec = Math.ceil((pairs.length * Math.max(1000 / AMAP_QPS, ASSUMED_RTT_MS)) / 1000);

  say("");
  say("[1] 待算段数");
  say(`    相邻关系 ${edges} 次 → 去重后有向站对 **${pairs.length}** 个（Spec 口径 ${EXPECTED_PAIRS}）`);
  say(`    新建 ${pending.length} 段 · 覆盖已有 ${pairs.length - pending.length} 段`);
  say(`    预计耗时 ≈ ${estSec} s（${pairs.length} 次 ÷ ${AMAP_QPS} QPS，按单次往返 ${ASSUMED_RTT_MS}ms 取大值）`);
  say(
    `    配额占用 ≈ ${pairs.length} 次（个人认证基础 LBS 15 万/月 ⇒ ${((pairs.length / 150000) * 100).toFixed(3)}%）`,
  );

  say("");
  say("[2] 直线距离哨兵（算路前确认没有 0 米 / 自环之类脏数据）");
  const byStraight = [...pairs].sort((a, b) => a.straightM - b.straightM);
  say(`    最短 3：${byStraight.slice(0, 3).map((p) => `${p.from}→${p.to} ${p.straightM}m`).join(" · ")}`);
  say(
    `    最长 3：${byStraight
      .slice(-3)
      .reverse()
      .map((p) => `${p.from}→${p.to} ${p.straightM}m`)
      .join(" · ")}`,
  );
  say(`    自环（from == to）：${pairs.filter((p) => p.from === p.to).length} 段`);
  say(`    跨口岸段（两侧属地不同）：${pairs.filter((p) => p.fromSide !== p.toSide).length} 段`);

  say("");
  say("[3] 已知失败清单（历史 --apply 留下的 straight-fallback 行）");
  if (existing === null) {
    say("    表不存在 ⇒ 无历史记录（首次算路，失败段数要 --apply 后才知道）");
  } else {
    const failed = pairs.filter((p) => existing.get(`${p.from}|${p.to}`)?.source === "straight-fallback");
    if (!failed.length) say("    无（全部为 amap-driving）");
    for (const p of failed) say(`    ${labelOf(p)}`);
  }
  say("");
  say("dry-run 结束：未调用高德、未写库。加 --apply --allow-prod 执行。");
}

async function applyMode(pairs: Pair[], existing: Map<string, { source: string }> | null): Promise<void> {
  if (existing === null) {
    throw new Error(
      "tqh_segment_paths 不存在。先建表（需负责人放行）：\n  npm run db:migrate-v3702 -- --apply --allow-prod",
    );
  }
  const t0 = Date.now();
  let okCount = 0;
  let rewritten = 0;
  let fbCount = 0;
  const fails: { label: string; infocode: string; info: string }[] = [];
  const snaps: { label: string; m: number }[] = [];
  const ratios: { label: string; ratio: number; drive: number; straight: number }[] = [];

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!;
    const existed = existing.has(`${p.from}|${p.to}`);
    const res = await fetchDriving(p);
    let row: SegRow;
    if (res.ok) {
      okCount++;
      if (existed) rewritten++;
      row = { from: p.from, to: p.to, polyline: res.polyline, distanceM: res.distanceM, durationS: res.durationS, source: "amap-driving" };
      snaps.push({ label: `${p.from}→${p.to}`, m: Math.max(res.snapStart, res.snapEnd) });
      if (p.straightM > 100) {
        ratios.push({ label: `${p.from}→${p.to}`, ratio: res.distanceM / p.straightM, drive: res.distanceM, straight: p.straightM });
      }
    } else {
      fbCount++;
      fails.push({ label: labelOf(p), infocode: res.infocode, info: res.info });
      row = straightRow(p);
    }
    await upsertSegment(row);

    if ((i + 1) % 25 === 0 || i + 1 === pairs.length) {
      const el = (Date.now() - t0) / 1000;
      say(
        `    [${String(i + 1).padStart(3)}/${pairs.length}] ok ${okCount} · 降级 ${fbCount} · ` +
          `已用 ${el.toFixed(0)}s · 剩余约 ${(((pairs.length - i - 1) * el) / (i + 1)).toFixed(0)}s`,
      );
    }
  }

  say("");
  say("[4] 结果");
  say(`    成功 ${okCount} 段（其中覆盖已有 ${rewritten}）· 失败降级 ${fbCount} 段 · 合计 ${pairs.length}`);
  say(`    耗时 ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  say("");
  say("[5] 失败清单（已写 straight-fallback 直线，前端画虚线）");
  if (!fails.length) say("    无");
  for (const f of fails) say(`    ${f.label} · infocode=${f.infocode} · ${f.info}`);

  const bad = snaps.filter((s) => s.m > 500).sort((a, b) => b.m - a.m);
  say("");
  say("[6] 坐标系健康（路径首末点 vs 输入点；正常 < 50m，> 500m 说明坐标系口径错了）");
  say(`    最大吸附 ${snaps.length ? Math.max(...snaps.map((s) => s.m)) : 0} m · 超 500m 的段 ${bad.length} 个`);
  for (const s of bad.slice(0, 5)) say(`    ${s.label} 吸附 ${s.m} m`);

  say("");
  say("[7] 绕路系数 top5（驾车米 ÷ 直线米；> 3 多为口岸单行/校区封闭道路，几何仍真实）");
  for (const r of ratios.sort((a, b) => b.ratio - a.ratio).slice(0, 5)) {
    say(`    ${r.label} ${r.drive}m / ${r.straight}m = ${r.ratio.toFixed(2)}×`);
  }
}

async function main(): Promise<void> {
  say("=".repeat(72));
  say(
    `通琴号段几何 · build-tqh-segment-paths · ${STATS_ONLY ? "--stats" : APPLY ? "APPLY" : "DRY-RUN"} · profile=${TQH_SEGMENT_PROFILE}`,
  );
  say("=".repeat(72));

  const pairs = await loadPairs();
  const counts = await loadPairCounts();
  if (pairs.length !== EXPECTED_PAIRS) {
    throw new Error(
      `站对数与 Spec 口径不符：实际 ${pairs.length}，期望 ${EXPECTED_PAIRS}（相邻关系 ${counts.edges} 次）。\n` +
        "  可能原因：① tqh_trip_stops 被重跑过（站序变了，需重新核对 763/302）\n" +
        "           ② 迁移 v3700 未完成 / 只灌了部分班次\n" +
        "  禁止直接硬跑 —— 口径变了要先回报确认。",
    );
  }
  say(`[0] 口径核对：${counts.edges} 次相邻关系 → ${pairs.length} 个有向站对 ✓ 与 Spec §6.1 一致`);

  const existing = await loadExisting();
  say(
    `[0] tqh_segment_paths：${existing === null ? "不存在（需 db:migrate-v3702）" : `已存在 · 当前 profile 行 ${existing.size}`}`,
  );

  if (STATS_ONLY) await statsMode(pairs, existing);
  else if (APPLY) await applyMode(pairs, existing);
  else await dryRun(pairs, existing, counts.edges);
}

void (async () => {
  try {
    await main();
  } catch (e) {
    console.error(`\n✗ ${(e as Error).message}`);
    out.push(`✗ ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    try {
      fs.mkdirSync(".verify", { recursive: true });
      fs.writeFileSync(OUT, out.join("\n") + "\n", "utf8");
    } catch {
      /* 日志写失败不影响结果 */
    }
    try {
      await getPool().end();
    } catch {
      /* 池未建立 */
    }
  }
})();
