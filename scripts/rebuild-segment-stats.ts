/**
 * 站间时长统计重建（scripts/rebuild-segment-stats.ts）
 * 用法：npm run db:segments -- [local|cloud] [--dry] [--from=track|events|samples|both] [--allow-prod]
 *
 * 核心逻辑在 src/lib/rebuild/segment-stats.ts（v0.25.0 抽取，
 * 供 CLI 与 /api/cron/rebuild 共用，避免两套口径漂移）。
 * 本文件仅负责：连库、调共享函数、打印人类可读报告。
 *
 * ★ v4.2.0 口径四态（默认仍是 events = 无参兜底，**生产必须显式传 `--from=track`**）：
 *   track          = 只吃 `segment_samples.source='track'`（自动采集）★ **生产口径**
 *   events         = 只读 DB 事件四表（timer_sessions/timer_events/free_rides/free_ride_events）
 *   samples        = 只读 segment_samples **全表**（诊断/对拍 —— ⚠️ 会读入 243 行 source='timer' 手工留档）
 *   both           = 事件四表 + segment_samples 中 source<>'timer'（v1.3.0~v4.1.x 的历史生产口径）
 *   ⚠️ 口径是**白名单**：`track` 只放行 track，将来新增采集源必须显式登记，否则共享层抛错。
 *
 * **可重复运行**（派生表，每次清空后重算）。口径细节见共享模块顶部注释。
 */
import { Pool } from "pg";
import { rebuildSegmentStats, segAvg } from "../src/lib/rebuild/segment-stats";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const dry = process.argv.includes("--dry");
const target = ((process.argv[2] ?? "cloud") as "local" | "cloud");
const fromArg = process.argv.find((a) => a.startsWith("--from="))?.split("=").slice(1).join("=");
const sampleFrom = (fromArg as "events" | "samples" | "both" | "track" | undefined) ?? "events";
if (!["events", "samples", "both", "track"].includes(sampleFrom))
  throw new Error(`--from 只能是 track|events|samples|both（收到 ${fromArg}）`);
// ★ v3.6.0：arrive_kind 分档依据（默认 origin = 起点站，行为不变；dest = 终点站，与离开口径自洽）
const kindArg = process.argv.find((a) => a.startsWith("--kind="))?.split("=").slice(1).join("=");
const arriveKindMode = (kindArg as "origin" | "dest" | undefined) ?? "origin";
if (!["origin", "dest"].includes(arriveKindMode))
  throw new Error(`--kind 只能是 origin|dest（收到 ${kindArg}）`);

// ★ v4.2.0：**默认值与生产口径不一致**的显式告警。
//   `?? "events"` 只是无参兜底；生产口径是 `--from=track`（只吃自动采集的 segment_samples）。
//   漏传参数会静默把整表换成「只看手工事件」的旧口径（写入前先 `DELETE FROM segment_stats`）。
//   这条告警出现在**执行那一刻**，比写在注释里更能拦住人。
if (sampleFrom === "events" && !dry) {
  console.warn("⚠️  sampleFrom=events：只读 timer_sessions / free_rides（实测 478 行 / 14 条线路），");
  console.warn("    既不读 segment_samples，也不读自动采集样本 ⇒ 这是**旧口径**。");
  console.warn("    生产口径是 --from=track。若确认要做历史对照，请显式接受这次整表替换。");
}
if (sampleFrom === "samples" && !dry) {
  console.warn("⚠️  sampleFrom=samples：读 segment_samples **全表**，");
  console.warn("    包含 243 行 `source='timer'` 的**人工计时留档**（生产口径已排除它们）⇒");
  console.warn("    本口径仅用于诊断/对拍，**不要**拿它当线上值。生产请用 --from=track。");
}
if (sampleFrom === "both" && !dry) {
  console.warn("⚠️  sampleFrom=both：四张旧事件表 + segment_samples(≠timer) 的历史合并口径，");
  console.warn("    仅作对照。生产口径自 v4.2.0 起是 --from=track。");
}
console.log(`▶ 口径：sampleFrom=${sampleFrom} · arrive_kind=${arriveKindMode} · dry=${dry}`);
const dbUrl = target === "cloud" ? process.env.DATABASE_URL : (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL);
if (!dbUrl) throw new Error(`未找到 ${target === "cloud" ? "DATABASE_URL" : "DATABASE_URL_LOCAL"}`);
const u = new URL(dbUrl);
const pool = new Pool({
  host: u.hostname,
  port: Number(u.port || 5432),
  database: u.pathname.slice(1),
  user: u.username,
  password: decodeURIComponent(u.password || ""),
  ...(target === "cloud" ? { ssl: { rejectUnauthorized: false } } : {}),
});

async function main() {
  const r = await rebuildSegmentStats(pool, { dry, sampleFrom, arriveKindMode });
  const { stats } = r;

  if (dry) console.log(`[--dry] 跳过写入（${target}）`);
  console.log(`✅ segment_stats ${dry ? "（未写入）" : "已重算"}（${target}，样本来源=${r.sampleFrom}，arrive_kind 依据=${arriveKindMode}）`);
  console.log(`   源：通勤计时 ${r.sessions} 会话 + 自由记站 ${r.rides} 行程 → 事件段样本 ${r.rawSamples.length}`);
  console.log(`   来源分布：timer ${r.bySource.timer} · free ${r.bySource.free} · track ${r.bySource.track}`);
  console.log(`   头段 ${stats.head} · 末段 ${stats.tail} · 方向重判 ${stats.redirect} 个行程`);
  console.log(
    `   丢弃：同站不同台 ${stats.sameStation} · 0 分钟重复点击 ${stats.zeroGap} · ` +
      `站码未匹配 ${stats.unmatched} · 跨站（中间漏打/忘打卡） ${stats.cross} · 反向 ${stats.reverse}`,
  );
  console.log(
    `   跨线回退回收 ${stats.recovered} 段（本线站序解不出，但该邻接对属另一条线 → 按站码反查归属）`,
  );
  console.log(
    `   长停站排除 ${stats.longDwell} 条（终点站 dwell_B ≥ 3 分 → minutes 含司机休息/长时间上落客）`,
  );
  if (r.longStopPolicy) {
    const p = r.longStopPolicy;
    const pct = ((x: number) => `${((x / Math.max(p.candidates, 1)) * 100).toFixed(1)}%`)(stats.longDwell);
    console.log(
      `   长停判据明细：候选 ${p.candidates} 条 / ${p.candidatePairs} 站对 → 排除 ${stats.longDwell} 条（占候选 ${pct}）· ` +
        `门拦下：insufficient ${p.insufficientPairs} 站对（${p.insufficientStations} 站）· ` +
        `headway-sync ${p.headwaySyncPairs} 站对（${p.headwaySyncStations} 站，本门本次 ${p.headwaySyncPairs === 0 ? "0 命中、不影响结果" : "有命中"}）· ` +
        `peak-crowded ${p.peakCrowdedPairs} 站对（${p.peakCrowdedStations} 站，本门本次 ${p.peakCrowdedPairs === 0 ? "0 命中、不影响结果" : "有命中"}）`,
    );
  }
  console.log(
    `   档位：stop（起点停靠，含停站）${r.byKind.stop} · pass（起点甩站，≈纯行驶）${r.byKind.pass}`,
  );
  console.log(`   写入 ${r.written} 行（分层 ${r.layered} + 兜底）`);

  console.log("   按线路：", r.routeCount.map(([k, v]) => `${k}(${v})`).join(" "));

  // 停站耗时反推：同一 (route, from, to) 同时有 stop 与 pass 样本
  console.log(`\n   可反推停站耗时的区间（同时有停靠/甩站样本）：${r.pairs.length} 个`);
  for (const p of r.pairs)
    console.log(
      `     ${p.key}  停靠 ${segAvg(p.stop)} 分（${p.stop.length}） − 甩站 ${segAvg(p.pass)} 分（${p.pass.length}） ≈ 停站 ${(
        Math.round((segAvg(p.stop) - segAvg(p.pass)) * 10) / 10
      )} 分`,
    );

  console.log(`\n   有 ≥2 次样本的区间 ${r.rep.length} 个，前 10：`);
  for (const p of r.rep.slice(0, 10)) {
    const all = [...p.stop, ...p.pass];
    console.log(
      `     ${p.key}  共 ${all.length} 次: ${all.join(" / ")}  均值 ${segAvg(all)}  停靠 ${p.stop.length} / 甩站 ${p.pass.length}`,
    );
  }

  await pool.end();
}

main().catch((e) => {
  console.error("重建失败：", e);
  process.exit(1);
});
