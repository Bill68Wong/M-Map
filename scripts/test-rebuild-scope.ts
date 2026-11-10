/**
 * `test:rebuild-scope` —— segment_stats 的**样本口径**门禁（v4.2.0 / M1）
 *
 * ── 它守的是什么 ──────────────────────────────────────────────────────
 *   2026-11-09 负责人裁定：旧手工记录数据（通勤计时 timer / 自由记站 free）**彻底不参与**
 *   `segment_stats` 计算，生产只吃 `segment_samples.source='track'`（DSAT 报站帧自动采集）。
 *   本脚本把这条裁定变成**可执行判据**：口径一旦被改回 `both` / `samples` / `events`，
 *   或者有人把 WHERE 白名单拆掉，这里必须变红。
 *
 * ── 看到红先分诊（**两组故障的处置完全相反，别混**）──────────────────────
 *   | 红在哪 | 诊断词 | 含义 | 处置 |
 *   |---|---|---|---|
 *   | **A 组**（A1/A2/A3/B2） | `代码口径被拆` | 代码里的白名单/守卫/聚合路径被拆（`WHERE true`、`both`、`events`、`fromTable` 被改坏） | 查 `segment-stats.ts` 的 `whereSql`、`aggSamples` 分派与 cron 的 `sampleFrom`；**不要靠重跑重建去掩盖** |
 *   | **D 组**（D1/D2/D4） | `表被外部重写` | 本地代码是 track 口径，但表被**别人按旧口径**整表重写过 | 重跑一记重建（`npm run db:segments -- cloud --from=track`）；**不要改代码** |
 *   分诊能成立的根因：**A 组是「本地现算」的，D 组是「库里现状」的** ⇒ 两边不一致就说明
 *   不是同一次计算写的。这正是不把 9 条全写成「读库比对」的原因。
 *
 * ⚠️⚠️ **`&&` 短路 —— 「没看到 rebuild-scope 红」≠「它通过了」** ─────────────
 *   本脚本排在 `verify` 的**倒数第三**，前面还有 `test:data-chain`（含 `test:eta-basis`，
 *   同样读这张表）。表被洗回旧口径时 `eta-basis` 会**先红并把整条链短路**，本脚本
 *   根本轮不到执行 ⇒ 有人拿「verify 输出里没有 rebuild-scope 的 FAIL」当证据，
 *   会得出**反向结论**。要判断本脚本自己过没过，必须**单独跑** `npm run test:rebuild-scope`。
 *
 * ── 为什么「表被洗」会发生（2026-11-10 实测，`git show origin/main:…`）──────
 *   线上部署源 `origin/main`（当时 ahead 13 笔未推）与本工作区有四处硬差异：
 *   ① `segment-stats.ts` 里 `p50_run_minutes` **0 命中** ⇒ cron 写完该列必全 NULL；
 *   ② `cron/rebuild/route.ts:119` 仍是 `{ sampleFrom: "both" }` ⇒ 四张旧事件表混回、`pass` 档复活；
 *   ③ `long-stop.ts:60` 仍是单档 `LONG_STOP_MIN = 3` ⇒ 长停口径回退（51/25/26 那批漂移复现）；
 *   ④ `db/migrate-v4100-hop-basis.ts` 不在 `origin/main`。
 *   ⇒ cron 一跑，整表回到 **`15,504 行 / pass=64 / run 全 NULL`** 的旧形态 —— **这就是指纹**。
 *   ⚠️ 它是「部署态与本地的口径差」，不是数据错误，也不是本脚本能防住的：本脚本只能**发现**它。
 *
 * ── 为什么这些断言**不是恒真**（逐条给反例 + **各自守的故障面**）────────────
 *   ⚠️ 先读这段，别把 A 组当「白名单四重保护」：**只有 A1 守白名单**；
 *      A2 守「长停排除计数自洽」、A3 守「事件四表未被读」、B2 守「聚合后 stop 档非空」。
 *      四条各看一个**不同**的故障面，互不备份。
 *
 *   ① `bySource.track > 0 && bySource.timer === 0 && bySource.free === 0`
 *      —— 反例：把 `whereSql` 从 `WHERE source = 'track'` 改成 `WHERE true`（或干脆不传
 *         `sampleFrom`、回落 `events`），`bySource.timer` 立刻变成 243（实测库里
 *         `source='timer'` 正好 243 行）⇒ 必红。
 *      ⚠️ `track > 0` **必须留在 A1 自己身上**：只写 `timer===0 && free===0` 的话，
 *         一旦 dry 跑出「一条样本都没有」（库连上了但数据空、或口径 bug 把 track 也筛没了），
 *         两个 0 依然满足 ⇒ A1 **空跑全绿**。旧写法正是靠 A2 的 `track > 0` 才有区分力，
 *         等于把 A1 的命门寄在别人身上（2026-11-10 team-lead 审出）。
 *   ② `bySource.track + stats.longDwell === count(*) WHERE source='track'`
 *      —— 这条是**分母校验**：只断言 `timer===0` 有个假绿口子 —— 若 `segment_samples` 里
 *         track 行也被一并过滤掉（WHERE 写错成 `source='timer'`），bySource 会全 0 而
 *         `timer===0` 依然成立。加上「track 计数 + 长停排除数 = 库内 track 行数」就堵住了。
 *         ⚠️ 差值必须**恰好**是长停排除数（本次实测 10 条）：被判「终点站长停 = 司机休息」的
 *            样本在聚合前就 `continue` 掉了，`bySource` 统计的是**进入聚合**的样本。
 *   ③ `byKind.stop > 0`（**只此一条，刻意不含 `pass === 0`**）
 *      —— ⚠️ `segment-stats.ts` 的 `fromTable.push` 把 `arriveKind` **硬编码**为 `"stop"`，
 *         track 模式下 `byKind.pass` **构造上不可能非 0** ⇒ 断言 `pass === 0` 是**结构性恒真**，
 *         属于「看起来在守、其实守不住」的假绿通道（2026-11-10 team-lead 审出）。
 *         实测印证：把 WHERE 放宽成 `WHERE true` 时 B2 **不红**，原因正是那行硬编码。
 *         真正能拦「pass 档复活」的是库侧 **D1** —— pass 只可能来自**事件路径**
 *         （`both` / `events` 会产出甩站样本，重建前实测 64 行）。
 *   ④ `sessions === 0 && rides === 0 && samples === 0`
 *      —— 反例：口径含 events（`events` / `both`）时这三个必然 > 0（实测 260 会话 /
 *         987 事件）。这条同时防「为了好看而把计数伪造成历史值」。
 *   ⑤ 库侧三条：D1 `arrive_kind='pass'` 行数 === 0、D2 `count(*) === written`、
 *      D4 `p50_run_minutes` 非空 > 0
 *      —— D1/D2 的反例：cron 被改回 `both` 后跑一记，pass 行立刻回来（实测 64 行）、
 *         表里还是上一次 `both` 的结果（15504 行 ≠ 本次 track 计算 15386 行）。
 *         ⚠️ **D1 与 D4 会在同一故障下同时红**（被旧 cron 洗回时 `pass=64` 且 `run=0`），
 *         但它们看**不同列**、对其余故障面各自独立（例如只有 run 写入逻辑坏掉 ⇒ 只红 D4，
 *         pass 不会回来）⇒ 二者**不是互为备份**，别据此删掉其中一条。
 *         D4 只判 `> 0` + 打印实测值，**不锁精确值**（随采集增长，锁了会变成恒假门禁）。
 *         ⚠️ **本脚本因此要求「先按 track 口径重建过」**：重建前 ⑤ 必然红，这是设计，不是 flake。
 *         若你刚拉下代码还没重建，跑 `npm run db:segments -- cloud --from=track --allow-prod`。
 *
 * ── 为什么不硬编码「总行数 === 15386」──────────────────────────────────
 *   15386 是 2026-11-09 那次重建的**那一刻**的值；采集每天在跑，行数会随新样本增长
 *   （新增站对 ⇒ 新增分层键）。把它写成硬断言等于给自己埋一个「明天必红」的恒假门禁 ——
 *   恒假与恒真是同一类缺陷（判据没有区分力，只是红绿反了过来）。
 *   ⇒ 真正该锁的是**关系式**：`written === 表内行数` + 下界 `> 15000`。
 *     **下界（D3）不是冗余，它挡的是「自洽退化」**：如果表与计算**一起**退回 events 口径，
 *     `written` 与 `count(*)` 会同时等于 478 ⇒ **D2 是 `478 === 478`、照样通过**，
 *     只有 D3 的下界会红。所以分工是：D2 管「表与计算是否同源」，D3 管「同源的那份是不是错口径」。
 *   基线 15386 仅作**观测值打印**（附本次实测），不作断言。
 *
 * ── 变异取证（2026-11-09 实跑记录，原样粘贴，未润色）────────────────────
 *   变异：把 `segment-stats.ts` 的 `sampleFrom === "track" ? "WHERE source = 'track'"` 临时改成
 *         `"WHERE true"`（即白名单失效、全表读入），跑本脚本，红行原文：
 *     `  FAIL  A1 口径白名单：track 口径下 timer/free 必须为 0（旧手工记录不参与计算）  实际 timer=243 free=0 track=207158`
 *     （注：A1 的**标签文字**在同日后续加固中已改为「track > 0 且 timer/free 必须为 0」，
 *       红行内容照旧——那是同一条断言，只是把 `track > 0` 并进了本条。）
 *     `  FAIL  D2 表内行数 === 本次 track 口径计算出的行数（表必须是 track 口径的产物）  实际 15504 ≠ 期望 15441  （分层 10317 + 兜底）`
 *   ⚠️ 诚实记账 —— 同一次变异里**没红**的三条，以及为什么（不粉饰）：
 *     · `A2` 没红：它比的是 `bySource.track + longDwell === 库内 track 行数`，
 *       放宽 WHERE 只是**多读 timer 行**，track 那一项本身没变 ⇒ A2 对「白名单被放大」不敏感。
 *     · `B2` 没红：`fromTable` 一律硬写 `arriveKind:"stop"` ⇒ 放宽 WHERE 时 pass 仍是 0。
 *       （注：经 team-lead 2026-11-10 审，B2 **此后已不再断言** `pass === 0` —— 那是结构性恒真，
 *         见上方 ③；这条历史记录保留，是因为它正好印证了「硬编码使该断言失效」。）
 *     · `A3` 没红：`sessions`/`rides` 由 `withEvents` 控制，与 WHERE 无关。
 *     ⇒ 所以「口径被放大」这件事，真正的判别式只有 **A1**（`timer/free === 0`）；
 *       D2 提供第二重（行数 15386→15441 会与表内不符），但它在「尚未重建」时本来就是红的，
 *       不能单靠它。**A1 是这条裁定的主力断言，别把它重构成"只要 bySource 总和不变就算过"。**
 *   复原：`cp` 备份 → `diff -q` 逐字节一致（sha256 `e4dfb931…b7100`），无残留。
 *
 * ── 「空跑」变异取证（2026-11-10 实跑，验证 A1 不再半恒真）────────────────
 *   变异：把 `segment-stats.ts` 的 `? "WHERE source = 'track'"` 改成
 *         `? "WHERE source = 'no-such-source'"`（模拟「库连上了但一条样本都筛不出来」）。
 *   改前 A1 的条件是 `timer===0 && free===0` —— 这种空跑下 `timer=0 free=0` **照样 PASS**，
 *   它的区分力全靠 A2 的 `track > 0` 借来（team-lead 审出的假绿通道）。
 *   改后实跑，红行原文（`bySource={"timer":0,"free":0,"track":0} · written=0`）：
 *     `  FAIL  A1 口径白名单：track > 0 且 timer/free 必须为 0（旧手工记录不参与计算）…实际 timer=0 free=0 track=0`
 *     `  FAIL  B2 档位：track 口径聚合后 stop 档必须有样本…实际 stop=0 pass=0`
 *     `  FAIL  A2 / D2 / D3`（`0+0=0 vs 库内 207168`、`15386 ≠ 0`、`written=0 < 15000`）
 *   ⇒ **A1 现在自己就能挡住「空跑全绿」，不需要 A2 帮忙**；B2 也不再是结构恒真（`stop=0` 会红）。
 *
 * 跑法：`npm run test:rebuild-scope`（在 `verify` 链内）
 * 依赖：**真实库**（`DATABASE_URL`）。连库失败 ⇒ fail-closed（exit 1），与 `test-remaining-route` 同规。
 */
import { Pool } from "pg";
import { rebuildSegmentStats } from "../src/lib/rebuild/segment-stats";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 → 下面会报「未找到连接串」 */
}

let pass = 0;
let fail = 0;
const ok = (c: boolean, label: string, extra = "") => {
  if (c) {
    pass++;
    console.log(`  PASS  ${label}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.error(`  FAIL  ${label}${extra ? "  " + extra : ""}`);
  }
};
const assertEq = (actual: unknown, expected: unknown, label: string, extra = "") => {
  const c = actual === expected;
  ok(c, label, c ? extra : `实际 ${String(actual)} ≠ 期望 ${String(expected)}${extra ? "  " + extra : ""}`);
};

/** 2026-11-09 重建那一刻的实测基线（**仅打印，不断言** —— 见文件头说明） */
const BASELINE_ROWS = 15_386;
/** 表行数下界：口径误切回 `events` 时整表约 478 行（实测 14 条线路）⇒ 必然 < 15000 */
const MIN_ROWS = 15_000;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("❌ 未找到 DATABASE_URL（.env）⇒ 无法校验 segment_stats 口径，判失败（fail-closed）");
  process.exit(1);
}

const u = new URL(url);
u.port = "5432"; // 会话模式单连接（6543 是 transaction-mode pooler，长事务下不适合做校验）
const pool = new Pool({
  connectionString: u.toString(),
  ssl: { rejectUnauthorized: false },
  max: 1,
});

const one = async <T = number>(sql: string): Promise<T> => {
  const rows = (await pool.query(sql)).rows as Record<string, unknown>[];
  return rows[0] ? (Object.values(rows[0])[0] as T) : (undefined as unknown as T);
};

async function main() {
  console.log("\n═══ segment_stats 样本口径门禁（track-only）═══\n");

  /** 诊断词：A 组=本地现算，红 ⇒ 代码口径被拆；D 组=库里现状，红 ⇒ 表被外部重写（见文件头分诊表） */
  const DIAG_CODE = "｜诊断词：代码口径被拆";
  const DIAG_TABLE = "｜诊断词：表被外部重写";

  // ── A 组：dry 跑一遍 track 口径（不写库），看它到底吃了什么 ──
  const t0 = Date.now();
  const r = await rebuildSegmentStats(pool, { sampleFrom: "track", dry: true });
  const ms = Date.now() - t0;
  const dbTrack = await one<number>(`SELECT count(*)::int FROM segment_samples WHERE source = 'track'`);
  const dbTimer = await one<number>(`SELECT count(*)::int FROM segment_samples WHERE source = 'timer'`);

  console.log(
    `  ℹ️  dry(track) 耗时 ${ms}ms · bySource=${JSON.stringify(r.bySource)} · written=${r.written}（基线 ${BASELINE_ROWS}）`,
  );

  // A1 白名单：旧手工记录一律不参与。
  //   ⚠️ `track > 0` 必须在**本条**里，否则「dry 空跑」（一条样本都没有）时 timer/free 双 0
  //     也照样 PASS ⇒ 空跑全绿。见文件头 ① 的说明。
  ok(
    r.bySource.track > 0 && r.bySource.timer === 0 && r.bySource.free === 0,
    "A1 口径白名单：track > 0 且 timer/free 必须为 0（旧手工记录不参与计算）" + DIAG_CODE,
    `实际 timer=${r.bySource.timer} free=${r.bySource.free} track=${r.bySource.track}`,
  );
  // A2 分母校验：track 计数必须等于「库内 track 行数 − 被长停站策略排除的行数」（堵「全 0 也满足 A1」的假绿口子）
  //   ⚠️ 不能直接 `=== dbTrack`：`bySource` 统计的是**进入聚合**的样本，
  //     而被判为「终点站长停（司机休息）」的样本在聚合前就 `continue` 掉了（实测本次 10 条）。
  //     差值必须**恰好**等于 `stats.longDwell` —— 这条等式同时把「长停排除漏算/多算」也锁住了。
  ok(
    r.bySource.track > 0 && r.bySource.track + r.stats.longDwell === dbTrack,
    "A2 分母校验：bySource.track + 长停排除数 必须 === 库内 source='track' 行数" + DIAG_CODE,
    `实际 ${r.bySource.track} + ${r.stats.longDwell} = ${r.bySource.track + r.stats.longDwell} vs 库内 ${dbTrack}`,
  );
  // A3 旧路径必须一行都不读（三个计数如实为 0，不许伪造）
  ok(
    r.sessions === 0 && r.rides === 0 && r.samples === 0,
    "A3 旧事件路径空转：sessions / rides / 事件段样本 必须全为 0（不是「读了不用」）" + DIAG_CODE,
    `实际 ${r.sessions} 会话 / ${r.rides} 行程 / ${r.samples} 段`,
  );
  // B2 档位非空：track 口径聚合后必须有 stop 档样本。
  //   ⚠️ **刻意不断言 `pass === 0`**：`segment-stats.ts` 的 `fromTable.push` 把 `arriveKind`
  //      **硬编码**成 `"stop"` ⇒ track 模式下 pass 构造上不可能非 0，断言它等于**结构性恒真**
  //      （看起来在守、其实守不住）。pass 档复活是**事件路径**的事，由库侧 D1 负责拦。
  ok(
    r.byKind.stop > 0,
    "B2 档位：track 口径聚合后 stop 档必须有样本（pass 构造上恒 0，故不设判据）" + DIAG_CODE,
    `实际 stop=${r.byKind.stop} pass=${r.byKind.pass}（pass 仅打印，不参与判定）`,
  );

  // ── D 组：库侧现状（要求已按 track 口径重建过一次）──
  const dbRows = await one<number>(`SELECT count(*)::int FROM segment_stats`);
  const dbPass = await one<number>(`SELECT count(*)::int FROM segment_stats WHERE arrive_kind = 'pass'`);
  const dbAll = await one<number>(`SELECT count(*)::int FROM segment_stats WHERE arrive_kind = 'all'`);
  const dbRun = await one<number>(`SELECT count(*)::int FROM segment_stats WHERE p50_run_minutes IS NOT NULL`);

  // D1 表内不得再有 pass 档（重建前实测 64 行；cron 若改回 both 会立刻回来）
  assertEq(
    dbPass,
    0,
    "D1 表内无 pass 档行（口径若被改回 both，事件路径的甩站样本会立刻把它带回）" + DIAG_TABLE,
    `（表内 ${dbRows} 行）`,
  );
  // D2 表 = 本次 track 计算（口径不一致时这里会不等：both 的结果是 15504 行 ≠ track 的 15386）
  assertEq(
    dbRows,
    r.written,
    "D2 表内行数 === 本次 track 口径计算出的行数（表必须是 track 口径的产物）" + DIAG_TABLE,
    `（分层 ${r.layered} + 兜底）`,
  );
  // D3 下界：防「整表被写成旧 events 口径」（实测 478 行）
  ok(
    r.written >= MIN_ROWS,
    `D3 行数下界：written 必须 ≥ ${MIN_ROWS}（旧 events 口径实测仅 478 行 ⇒ 会红）` + DIAG_TABLE,
    `实际 ${r.written}`,
  );
  /**
   * D4 run 列填充 —— **一句话定位「表被洗」**。
   * 旧版 cron（`origin/main`）的 INSERT 列清单里没有 `p50_run_minutes` ⇒ 它整表重写后该列必然全 NULL。
   * 所以「非空行数 = 0」不是数据稀疏，而是**被外部按旧口径洗过**的强信号。
   *
   * 两组指纹并排（格式 = `max(updated_at) / 总行数 / run 非空行数`，2026-11-10 实测）：
   *   · **故障态**（旧 cron 洗回）：`2026-11-09T18:54:44Z / 15504 / 0`
   *   · **健康态**（本地 track 重建后）：`2026-11-10T11:10:11Z / 15386 / 15069`
   *   ⇒ 看到第一组 = 被旧 cron 洗回旧口径；看到第二组 = 重建后的正常态。
   *   ⚠️ **指纹只作注释里的对照，不作判据**：总行数与 run 非空行数都会随采集增长
   *      （新站对 ⇒ 新分层键 / 新站对 ⇒ 新 run 值），锁死就等于给自己埋一个「明天必红」的
   *      恒假门禁 —— 恒假与恒真是同一类缺陷（判据没有区分力，只是红绿反了过来）。
   *      它要抓的故障形态是「**整列归零**」，所以只判 `> 0`。
   */
  const dbRunMsg =
    dbRun > 0
      ? `实际 ${dbRun}（>0 即可；不锁精确值，随采集增长）`
      : "实际 0 ⇒ 表内 p50_run_minutes 非空行数 = 0 ⇒ 本表很可能被部署在旧版本的 cron 整表重写回旧口径（指纹 15504 / pass=64 / run=0），需重新执行 npm run db:segments -- cloud --from=track";
  ok(dbRun > 0, "D4 run 列填充：表内 p50_run_minutes 非空行数必须 > 0" + DIAG_TABLE, dbRunMsg);

  // ── E 组：判别力自证（证明 A1 不是恒真）──
  //   库里确有 243 行 source='timer'，它们是 A1 的「可被排除对象」。
  //   若某天有人把 timer 行删了，A1 就退化成恒真 —— 所以这里把「分母」显式锁住。
  ok(
    dbTimer > 0,
    "E1 判别力：库内确有 source='timer' 的手工留档行（A1 的排除对象存在 ⇒ 断言有区分力）",
    `实际 ${dbTimer} 行（应保持 243 左右；为 0 说明留档被删，A1 会退化为恒真）`,
  );
  ok(
    dbAll > 0,
    "E2 兜底行存在（arrive_kind='all'）：分层/兜底两类行都在，说明聚合链路完整",
    `实际 ${dbAll} 行`,
  );

  console.log(`\n═══ 合计 ${pass + fail} 条：PASS ${pass} / FAIL ${fail} ═══`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("❌ 门禁执行失败（fail-closed）：", e instanceof Error ? e.message : e);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
