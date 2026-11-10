/**
 * 追踪式计时派生器（scripts/track-derive.mjs）
 *
 * 作用：把 scripts/track-collect.mjs 落盘的**原始帧**还原成站间时长样本。
 *
 * ── 两个口径都算（本脚本的核心价值）────────────────────────────────
 *   离开口径  t(离 B) − t(离 A) = run + dwell_B   ← **与手动打点 / 现有 segment_stats 同口径（主口径）**
 *   到达口径  t(到 B) − t(到 A) = dwell_A + run   ← 仅供对照，无消费方
 *   两者相差 dwell_B − dwell_A。原始帧同时含 `status='1'`（停靠）与 `'0'`（已离站），
 *   所以一次采集两种都能算，**口径定案前不需要重采**。
 *
 *   实测口径定案（2026-09-13 首轮 30 分钟，与云端 segment_stats 对照 227~239 段）：
 *   离开口径 平均绝对差 **34 秒**（σ45）＜ 到达 39 秒（σ57）＜ 纯行驶 63 秒（σ53）
 *   → 主口径 = 离开口径。
 *
 * ── 状态机（status 语义）──────────────────────────────────────────
 *   '1' = 停靠挂载站；'0' = 已离站、驶向下一站
 *   到达时刻 = 该站首次出现 status='1' 的时刻
 *   离开时刻 = 该站首次由 '1' 翻成 '0' 的时刻
 *   ⚠️ **压缩键必须含 `idx`**：车辆驻站期间 idx 会「静默重锚」（终点掉头换方向 / API 重定位车辆），
 *      只按 (status, main) 合并会把重锚前后的帧并成一组、组的 idx 停在**首帧** →
 *      随后的 depart 事件带过期 idx → 骗过下面「严格相邻」过滤 → 造出横跨驻留期的**假区间**。
 *      （2026-09-13 首轮实测：σ 75.7 秒 / 最大 960 秒的假样本，修后 σ 33 秒 / 最大 370 秒）
 *      另加护栏：只接受 `s0 帧 idx === s1 帧 idx` 的 depart。
 *   状态缺口 = s1@X → s1@Y（跨站且**没有** s0 帧）→ X 的离开时刻不可测，
 *              X→Y 这一段必须整段丢弃（这是「长驻站/总站待发」的典型症状）。
 *
 * ── 三重过滤 + 一道聚合护栏（宁丢不错）─────────────────────────────
 *   ① 严格相邻：两次事件的站序下标差必须 === 1（差 > 1 说明中间站没采到 → 不是邻接区间）
 *      ★ v4.1.1：差 > 1 不再**丢弃**，改为产出独立的 `spanned` 口径样本（见下节）。
 *   ② 无状态缺口：起点站的离开时刻必须真实测到
 *   ③ 时长合理：0.1 ~ 20 分钟之外一律丢弃并计入异常清单
 *   ④ **同键一致性护栏（聚合层，2026-09-13 后新增）**：同一键 n≥OUT_MIN_N 时，
 *      样本 > max(p50×OUT_MULT, p50+OUT_FLOOR_MIN 分) 判为可疑 → 从均值剔除（原值保留可回溯）。
 *      治「站外长时间停留」：司机休息/待發 期间 API 仍保留上一站且 status='0'（实测连挂 138 帧
 *      ≈ 11.4 分钟）→ ①②③ 全拦不住，「s0 持续时长」也判不出来（真实跨海段同样长 s0）。
 *      真实长区间不会误伤：同键多样本彼此一致 → p50 大 → 阈值随之上抬（`M9→T316` 全组 9.6~12.7 分，
 *      阈值 36 分，零命中）。参数可用 `--outlier-mult` / `--outlier-floor` / `--outlier-min-n` 覆盖。
 *      ★ v4.1.1：键**含 route_code**（`--outlier-scope=route` 默认）。旧口径是跨线路共享键
 *      （`from|to|weekday|bucket`），实测 185 条命中里 183 条所在键跨多条线路、166 条本线样本
 *      占比 ≤50% —— 拿别的线的分布判本线，92% 是误判（典型：59 路 `C654→C653` 8.83 分被判异常，
 *      而该键混了 6 条线、p50 只有 1.25 分、本线只占 18%）。`--outlier-scope=shared` 仅用于对照复现。
 *
 * ── 跨站段（spanned，v4.1.1 纯增量）────────────────────────────────
 *   相邻事件对站序差 d > 1 = 车辆真实跨过了 d−1 个站（用户实测「跳站」是正常运营行为：
 *   甩站 / 区间车 / 漏采）。全库 5,869 段跨 2 站 + 935 段跨 ≥3 站，**历史上被整段静默丢弃**。
 *   现在产出 `arrive_kind='spanned'` 的独立样本流（落盘 `rawSpannedSamples`），并记 `spanned_stations = d−1`。
 *   ⚠️ **spanned 绝不进 depart 主查询**：它的 minutes 里含中间站的全部停站，与邻接段不同源；
 *      历史上放宽 `d===1` 曾造出 σ=75.7 秒的假区间。要用它补缺，必须按
 *      `minutes / (spanned_stations + 1)` 分摊到子段、且**仅在子段完全无样本时**兜底 —— 本批不做。
 *   d ≤ 0 的两种子类分开统计：`wrap`（环线闭合 / 终点掉头，车辆回到线首 idx ≤ 1，|d| 通常 ≈ N−1）
 *   与 `reverse`（真正的站序回退，异常）。
 *
 * ── 输出 ──
 *   <out>/<label>-derived.json          结构化样本（按共享键 / 按线路键聚合）
 *   <out>/<label>-derived-report.txt    人读报告（含与 segment_stats 真值的对照）
 *
 * ── 输入（v1.1.0 起要分清两类分片）────────────────────────────────
 *   ✅ `<stamp>-partNN.jsonl.gz`      报站分片：含 `veh`（挂载站 + status）→ **本脚本的唯一输入**
 *   ⛔ `<stamp>-loc-partNN.jsonl.gz`  位置分片：只含 `cars`（经纬度 + 速度），**没有挂载站/status**
 *      ⇒ 本脚本**两道排除**：① `resolveFiles` 用 `${label}-part` 前缀（位置分片撞不上）
 *        ② `loadFrames` 按**帧本身** `kind === "loc"` 剔除（对 `--in=<glob>` 也生效）
 *      ⚠️ 绝不能改用「文件名含 -loc-」判断 —— 标签若叫 `smoke-loc`，报站分片也含 `-loc-`，会把自己排掉。
 *
 * ── 用法 ──
 *   node scripts/track-derive.mjs --label=20260913-0700
 *   node scripts/track-derive.mjs --in=data/tracking/<label>-part*.jsonl.gz --truth=cloud
 *   node scripts/track-derive.mjs --label=x --truth=local   # 与本地影子库真值对照
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(process.cwd());
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (!hit) return d;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : "true";
};
const CFG = {
  label: arg("label", ""),
  inGlob: arg("in", ""),
  out: path.resolve(ROOT, arg("out", "data/tracking")),
  truth: arg("truth", "none"),          // none | local | cloud
  minSamples: Number(arg("min-samples", "1")),
  plan: path.resolve(ROOT, arg("plan", "data/tracking/poll-plan.json")),
  /** ★ v4.1.1：同键护栏的分组口径 —— route（默认，本线自成一组）| shared（旧口径，跨线路共享，仅对照） */
  outlierScope: arg("outlier-scope", "route"),
};

const MIN_MINUTES = 0.1;
const MAX_MINUTES = 20;

// ★ 批 2 · U-05：丢弃/截断诊断的**三域原因码**（唯一真相源，任何诊断记录必带其一）。
//   为什么必须分三域（批 1 查明的教训）：批 1 实跑证明「370 秒天花板」是**数据源侧**把车从
//   DSAT 响应列表移除（改 ramp/minutes/interval 无效），而「同 idx 离开护栏」「s1→s1 缺口」
//   是**我们派生端护栏**主动丢弃（规则可评估）。二者混成一笔 → 会重蹈「拿放宽护栏去修数据源
//   天花板」的旧假说。诊断流把两类分开记，读的人一眼能看出「这条是本可以要回、那条是要不回」。
const DISCARD_REASONS = {
  // ── 数据源侧观测上限（改采集参数/护栏都挽不回；只能靠数据源或更长窗口）──
  SOURCE_PLATE_REMOVED: "source.plateRemoved",        // 车在段末下一轮从 DSAT 响应消失（批 1 · 16 抽检 15/16）
  SOURCE_REANCHOR_TO_HEAD: "source.reanchorToHead",   // 车重锚到 idx=0/1（批 1 · 1/16）
  SOURCE_WINDOW_END: "source.windowEnd",              // 段末贴近采集窗口末尾（1094 条中约 55 条 ≈5.0%）
  // ── 派生端护栏主动丢弃（可评估放宽；放宽前须证明不污染 ETA）──
  GUARD_SAME_IDX_DEPART: "guard.sameIdxDepart",       // extractEvents() 只接受同 idx 的 1→0，否则丢 depart
  GUARD_S1_TO_S1_GAP: "guard.s1ToS1Gap",              // 状态缺口（s1→s1 跨站）→ 相邻段整段丢弃
  GUARD_NOT_ADJACENT: "guard.notAdjacent",            // segments()：d≤0 真回退 / 同站重复
  GUARD_DURATION_OUT_OF_RANGE: "guard.durationOutOfRange", // segments()：时长越界（<0.1 或 >20 分）
  GUARD_MIN_SERIES_FRAMES: "guard.minSeriesFrames",   // 序列帧数 <3，不跑状态机
  // ── 产出侧截断 / 中止 ──
  OUTPUT_ABORTED_ROUND: "output.abortedRound",        // 整轮中止（runMeta.aborted≠null）
  OUTPUT_TOPN_SLICE: "output.topNSlice",              // longStopGuard.stops/attaches 旧 slice(0,2000) 截断
};
const DISCARD_REASON_SET = new Set(Object.values(DISCARD_REASONS));
/** 诊断 reason 必须落在三域表内（防止后人随手写 `discarded:true` 之类无法归类的值）。 */
const assertReason = (r) => {
  if (!DISCARD_REASON_SET.has(r)) throw new Error(`未知 discardReason: ${String(r)}（必属 DISCARD_REASONS 三域）`);
  return r;
};

// ── 长时间停站（dwell）参数（v1.2.0，2026-10 长停站调研后新增）────────────
// 背景：离开口径 t(离B) − t(离A) = run(A→B) + **dwell_B**，即差里含的是**终点站**的停站。
//   ⇒ 终点站是总站/司机休息点时，dwell_B 可达数分钟，单靠 `MAX_MINUTES=20` 拦不住
//     （实测 26 路 C654 聯生圓形地總站 dwell 最大 7.75 分，对应段 C656→C654 42% 样本 ≥3 分）。
//   本脚本**不再猜**：从状态机直接量出每段的 dwell_B（= 到达首帧 → 离开首帧），
//   随样本一起落盘（`dwellMin` / `longStop`），由聚合层决定排除或单列。
//   同时把「status='0' 期间仍挂在同一站」的长挂载（司机休息期 API 不换站的已知行为）
//   单独统计，用于区分「总站休息」与「路段本身很长」——这是同键护栏判不出的那一类。
const LONG_STOP_MIN = Number(arg("long-stop", "3"));   // dwell_B ≥ 此值 → 标记 longStop
const LONG_ATTACH_MIN = Number(arg("long-attach", "3")); // status='0' 单站连挂 ≥ 此值 → 计入长挂载候选

// ── 同键一致性护栏参数（2026-09-13 第二轮实测后新增，可用 --outlier-* 覆盖）──
const OUT_MULT = Number(arg("outlier-mult", "3"));       // 超过 p50 的倍数 → 可疑
const OUT_FLOOR_MIN = Number(arg("outlier-floor", "2")); // 且至少超 p50 这么多分钟（防小 p50 误判）
const OUT_MIN_N = Number(arg("outlier-min-n", "5"));     // 同键样本数 ≥ N 才启用（样本太少判不出）

const mainCode = (c) => /^[A-Za-z]+\d+/.exec(String(c ?? ""))?.[0] ?? String(c ?? "");
const p2 = (n) => String(n).padStart(2, "0");
function bucketOf(h) {
  if (h >= 7 && h < 10) return "am_peak";
  if (h >= 10 && h < 17) return "day";
  if (h >= 17 && h < 20) return "pm_peak";
  return "night";
}
/** 澳门时间分量 */
function macauParts(ms) {
  const d = new Date(ms + 8 * 3600e3);
  return { weekday: d.getUTCDay(), hour: d.getUTCHours(), hhmm: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` };
}

const out = [];
const L = (s) => { out.push(s); console.log(s); };

// ════════════════ 1. 读原始帧 ════════════════

function resolveFiles() {
  if (CFG.inGlob) {
    const dir = path.dirname(path.resolve(ROOT, CFG.inGlob));
    const base = path.basename(CFG.inGlob);
    const re = new RegExp("^" + base.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f));
  }
  if (!CFG.label) throw new Error("必须给 --label=<stamp> 或 --in=<glob>");
  return fs.readdirSync(CFG.out)
    // ★ v1.1.0：位置分片名是 `<stamp>-loc-partNN.jsonl.gz`，**不会**命中 `${label}-part` 前缀，
    //   所以这个前缀过滤天然就是对的。
    //   ⚠️ 绝对不要改用「文件名含 -loc-」这类子串判断！实测踩过：
    //      标签一旦叫 `smoke-loc`，报站分片 `smoke-loc-part01.jsonl.gz` 也含 `-loc-`
    //      → 报站分片被自己误排除（0 分片）。**唯一可靠的区分在帧层面：`kind === "loc"`**（见 loadFrames）。
    .filter((f) => f.startsWith(`${CFG.label}-part`) && f.endsWith(".jsonl.gz"))
    .sort()
    .map((f) => path.join(CFG.out, f));
}

/** ★ 批 1 · U-01：读本轮 `<label>-meta.json`，把中止/时长信息透传进 derived.json。
 *  · `--in=<glob>` 时 meta 在分片所在目录（不是 CFG.out，那是产物输出目录）；否则在 CFG.out。
 *  · 只读、失败返回 null（derived 里落 metaAvailable:false ⇒ 入库闸按「未知」放行 + WARN）。
 *  · 不 import pg、不连库；`--truth=none`（默认）本来就提前 return。
 */
function loadRunMeta(files, label) {
  const dir = CFG.inGlob ? path.dirname(files[0]) : CFG.out;
  const n = (x) => {
    const v = Number(x);
    return Number.isFinite(v) ? v : null;
  };
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, `${label}-meta.json`), "utf8"));
    return {
      aborted: m.aborted === null || m.aborted === undefined ? null : String(m.aborted),
      metaAvailable: true,
      durationMin: n(m.durationMin),
      rounds: n(m.totals && m.totals.rounds),
      plannedMinutes: n(m.cfg && m.cfg.minutes),
    };
  } catch {
    return {
      aborted: null,
      metaAvailable: false,
      durationMin: null,
      rounds: null,
      plannedMinutes: null,
    };
  }
}

function loadFrames(files) {
  const frames = [];
  let bad = 0, locSkipped = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f);
    let text;
    try { text = zlib.gunzipSync(buf).toString("utf8"); }
    catch { bad++; L(`  ⚠️ ${path.basename(f)} 解压失败（进程被强杀时的残片），已跳过`); continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let fr;
      try { fr = JSON.parse(line); } catch { bad++; continue; }
      // ★ v1.1.0：位置帧（`kind === "loc"`）只有经纬度、**没有 veh**（挂载站 + status），
      //   喂进状态机只会污染统计 → 按**帧本身**剔除（不看文件名，因为标签可能自带 `-loc`）。
      if (fr?.kind === "loc") { locSkipped++; continue; }
      frames.push(fr);
    }
  }
  if (locSkipped) L(`  ⏭ 已剔除 ${locSkipped} 个位置帧（kind=loc，仅含经纬度、无挂载站/status）`);
  return { frames, bad };
}

// ════════════════ 2. 状态机 ════════════════

/** 单辆车（一条 series）→ 到达序列 / 离开序列 / 状态缺口 */
function extractEvents(series) {
  // 压缩连续同状态。
  // ⚠️ 键必须含 idx（详见文件头「状态机」注）：只按 (status, main) 合并会把 idx 重锚前后的帧
  //    并成一组、组的 idx 停在首帧 → 后续 depart 带过期 idx → 造出横跨驻留期的假区间。
  const comp = [];
  for (const s of series) {
    const last = comp[comp.length - 1];
    if (last && last.status === s.status && last.main === s.main && String(last.idx) === String(s.idx)) {
      last.lastT = s.t; last.n++;
    } else comp.push({ status: s.status, main: s.main, sta: s.sta, idx: s.idx, firstT: s.t, lastT: s.t, n: 1 });
  }
  const arrive = [], depart = [], gaps = [], sameIdxDepart = [];
  let lastS1 = null, departed = false;
  for (const c of comp) {
    if (c.status === "1") {
      if (!lastS1 || lastS1.main !== c.main) arrive.push({ main: c.main, sta: c.sta, idx: c.idx, t: c.firstT, endT: c.lastT, holdMs: c.lastT - c.firstT });
      lastS1 = c;
      departed = false;
    } else if (c.status === "0") {
      // 护栏：只接受「同一 idx」上的 1→0。idx 变了 = 车辆被重锚（掉头 / 换方向），
      // 该站的离开时刻不可信 → 丢弃该 depart（否则会生成跨驻留期的假区间）。
      const accepted = lastS1 && !departed && lastS1.main === c.main && String(lastS1.idx) === String(c.idx);
      if (accepted) {
        depart.push({ main: lastS1.main, sta: lastS1.sta, idx: lastS1.idx, t: c.firstT, holdMs: lastS1.lastT - lastS1.firstT + (c.firstT - lastS1.lastT) });
        departed = true;
      } else {
        // ★ 批 2 · U-05：被「同 idx 1→0」护栏拒绝的 depart —— 以前**静默丢弃**，现记诊断（供可见性）。
        sameIdxDepart.push({
          main: c.main, sta: c.sta, idx: String(c.idx), t: c.firstT,
          lastMain: lastS1 ? lastS1.main : null,
          lastIdx: lastS1 ? String(lastS1.idx) : null,
          detail: !lastS1 ? "无前置到达" : departed ? "重复离开" : lastS1.main !== c.main ? "站不同" : "idx 不同(重锚)",
        });
      }
    }
  }
  // 状态缺口：s1 → s1 跨站（该站离开时刻不可测）
  for (let i = 1; i < comp.length; i++)
    if (comp[i - 1].status === "1" && comp[i].status === "1" && comp[i - 1].main !== comp[i].main)
      gaps.push({ at: comp[i - 1].main, idx: comp[i - 1].idx, nextMain: comp[i].main, t: comp[i].firstT });
  return { arrive, depart, gaps, comp, sameIdxDepart };
}

/** 由事件序列产出段样本：严格相邻 + 正常时长
 *  ⚠️ 只有**离开口径**的 b 事件带 `holdMs`（= 到站首帧 → 离站首帧 = 该站 dwell）。
 *     到达口径的 holdMs 语义不同（仅 s1 区间，不含到离站之间的间隔），故不参与 dwell 标记。
 *
 *  ★ v4.1.1：站序差 d 分三档处理，**不再是「非 1 即丢」**——
 *    · d === 1 → 邻接段 → `ok`（depart / arrive 主口径，行为不变）
 *    · d > 1   → 跨站段 → `spanned`（标注 spanned_stations = d−1 后保留；供诊断，不进主查询）
 *    · d ≤ 0   → `wrap`（环线闭合 / 终点掉头：车辆回到**线首两站** idx ≤ 1）与 `reverse`（真回退，异常）分开
 *  @param {{ withDwell?: boolean }} opts
 *  @returns {{ ok, spanned, dropAdj, dropDur, wrap, reverse }}
 */
function segments(evs, { withDwell = false } = {}) {
  const ok = [], spanned = [], dropAdj = [], dropDur = [];
  /** 环线闭合 / 终点掉头的计数与明细（**不再算进「异常回退」**） */
  const wrap = [], reverse = [];
  for (let i = 1; i < evs.length; i++) {
    const a = evs[i - 1], b = evs[i];
    const d = b.idx - a.idx;

    if (d === 1) {
      const minutes = (b.t - a.t) / 60000;
      const rec = { from: a.main, to: b.main, fromSta: a.sta, toSta: b.sta, fromIdx: a.idx, minutes, t: a.t };
      if (withDwell) {
        const dwellMin = Math.max(0, (b.holdMs ?? 0) / 60000);
        rec.dwellMin = Math.round(dwellMin * 100) / 100;
        rec.longStop = dwellMin >= LONG_STOP_MIN;
      }
      if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) { dropDur.push({ ...rec, reason: minutes < MIN_MINUTES ? `过短 ${minutes.toFixed(2)} 分` : `过长 ${minutes.toFixed(2)} 分` }); continue; }
      ok.push(rec);
      continue;
    }

    if (d > 1) {
      // ── 跨站段：整段保留为诊断样本（历史行为是整段丢弃）────────────
      const minutes = (b.t - a.t) / 60000;
      const rec = {
        from: a.main, to: b.main, fromSta: a.sta, toSta: b.sta,
        fromIdx: a.idx, toIdx: b.idx,
        /** 跨过了几个中间站（跨 2 站 = 中间夹 1 站）*/
        spanned_stations: d - 1,
        minutes, t: a.t,
      };
      if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
        dropDur.push({ ...rec, reason: minutes < MIN_MINUTES ? `过短 ${minutes.toFixed(2)} 分` : `过长 ${minutes.toFixed(2)} 分` });
        continue;
      }
      spanned.push(rec);
      continue;
    }

    // ── d ≤ 0：两种完全不同的情况必须分开 ───────────────────────────
    const rec = { from: a.main, to: b.main, fromIdx: a.idx, toIdx: b.idx, d, minutes: (b.t - a.t) / 60000, t: a.t };
    // 环线闭合 / 终点掉头：车辆收尾时 idx 从末段**回到线首**。
    //   · 实测 51 路 C688(18) → C690(0)，d = −18（回到首站）
    //   · 另有大量 `→ idx 1`：车辆在首站停靠帧恰好没采到，回绕后第一个观测点是首站后一站
    //     （全库 toIdx=1 有 2,274 条，占回退样本的 59%）⇒ 只看 `b.idx === 0` 会漏掉一半以上。
    //   ⇒ 判据 = 回到线首两站（b.idx ≤ 1）**且是大幅回退**（d ≤ −3）。
    //     d ∈ [−2, 0] 的小幅回退即使是 toIdx=0 也不算回绕（那是真正的站序错乱，必须留证据）。
    // 「末站→首站」的收尾段已由 terminal 口径单独产出（terminalSegments），这里只计数、不造样本。
    const isWrap = b.idx <= 1 && d <= -3;
    if (isWrap) {
      wrap.push({ ...rec, head: b.idx === 0 });
    } else {
      // 真正的站序回退 / 同站重复事件 —— 异常，保留在异常清单里等人工核查
      reverse.push({ ...rec, reason: d === 0 ? "同站重复(0)" : `站序回退(${d})` });
      dropAdj.push({ from: a.main, to: b.main, reason: d === 0 ? "同站重复(0)" : `站序回退(${d})`, t: a.t });
    }
  }
  return { ok, spanned, dropAdj, dropDur, wrap, reverse };
}

// ════════════════ 2-b. 末站口径（v1.4.0）════════════════
//
// 负责人定案：**末站行驶时间 = 到达末站时刻 − 离开倒数第二站时刻**。
// 末站若套用「离开 − 离开」会要求末站也有 depart 事件 —— 而终到车停住后退出服务/被重锚，
// 永远不产生 depart(末站) ⇒ 该跳**结构性无样本**，UI 回退到「该线平均每跳」。
// 实测 59 路回程 `T317 → M9/2`（7,171 m 跨海）因此显示「2 分」（真值 10~11 分）。
//
// ⚠️ 为什么独立函数、不在 `segments()` 里加分支：`segments()` 的 `d !== 1` 判据是
//    183k 条 depart/arrive 样本的共同基础，动它等于重算全库。这里是**纯增量**：
//    · 非环线：`arrive(idx N-1) − depart(idx N-2)`（N = 计划站数，idx 0 基）
//    · 环线（首站=末站）：`arrive(idx 0) − depart(idx N-2)`
//      —— 环线的最后一站与首站是**同一物理站**，车辆收尾时 idx 由 N-2 直接回到 0
//      （实测 51 路：C688(idx18) → C690(idx0)，`d = −18`，被 `segments()` 当「回退」丢弃）。
//    两者共同点：**起点 = idx N-2 的 depart，终点 = 末站的 arrive**，因此统一实现。
function terminalSegments(arrive, depart, spec) {
  const ev = [
    ...arrive.map((e) => ({ k: "arrive", idx: Number(e.idx), e })),
    ...depart.map((e) => ({ k: "depart", idx: Number(e.idx), e })),
  ].sort((a, b) => a.e.t - b.e.t);
  const ok = [];
  for (let i = 1; i < ev.length; i++) {
    const a = ev[i - 1], b = ev[i];
    if (a.k !== "depart" || a.idx !== spec.prevIdx) continue;
    if (b.k !== "arrive" || b.idx !== spec.termIdx) continue;
    ok.push({
      from: a.e.main, to: b.e.main, fromSta: a.e.sta, toSta: b.e.sta,
      fromIdx: a.idx, toIdx: b.idx,
      minutes: (b.e.t - a.e.t) / 60000, t: a.e.t,
      loop: spec.loop,
    });
  }
  return ok;
}


// ════════════════ 3. 聚合 ════════════════

function agg(list) {
  if (!list.length) return null;
  const v = list.map((x) => x.minutes).sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return {
    n: v.length,
    avg: Math.round(mean * 100) / 100,
    p50: Math.round(v[Math.floor(v.length / 2)] * 100) / 100,
    min: Math.round(v[0] * 100) / 100,
    max: Math.round(v[v.length - 1] * 100) / 100,
  };
}

// ── 同键一致性护栏（核心）─────────────────────────────────────────────
// 治「站外长时间停留造假长区间」：司机休息/待發 期间，API 仍保留上一站且 status='0'
// （第二轮实测 s0 连挂 138 帧 ≈ 11.4 分钟）→ idx 严格 +1、无状态缺口、时长未越界，
// **解析层的三道过滤全拦不住**；连「s0 持续时长」也判不出来（真实跨海段同样长 s0）。
//
// 唯一可靠判据 = **同一共享键上其余样本是否一致**：
//   阈值 thr = max(p50 × OUT_MULT, p50 + OUT_FLOOR_MIN 分钟)，且该键样本数 ≥ OUT_MIN_N 才启用。
//   超阈样本 → 标记 suspicious、从均值剔除，但**原值保留在 json / 报告里可回溯**（绝不静默丢弃）。
//
// 为什么不会误伤真实跨海长区间：它们同键多样本且彼此一致 → p50 本身就大 → 阈值随之上抬。
//   实测 `M9→T316` 全组 9.58~12.74 分（p50 12.0）→ 阈值 36 分，零命中。
//   而被判可疑的 `M144→M76` 是「同键 p50 2.83，孤立 11.90」→ 阈值 8.49，精确命中。
function splitOutliers(list) {
  const v = list.map((x) => x.minutes).sort((a, b) => a - b);
  if (v.length < OUT_MIN_N) return { kept: list, outliers: [], thr: null, p50: null };
  const p50 = v[Math.floor(v.length / 2)];
  const thr = Math.max(p50 * OUT_MULT, p50 + OUT_FLOOR_MIN);
  const kept = [], outliers = [];
  for (const x of list) (x.minutes > thr ? outliers : kept).push(x);
  return { kept, outliers, thr, p50 };
}

/** 按分组键找可疑样本 → { flagged:Set, list:[] }
 *
 *  ★ v4.1.1：键含 `route_code`（`scope="route"`，默认）。
 *    旧口径（`scope="shared"`，= `from|to|weekday|bucket`）把**不同线路的同一物理区间**并成一组：
 *    邻接段的时长确实可以跨线路共享，但**司机休息/甩站/区间车**这些运营事件是**分线路**的 ——
 *    59 路在 C654 总站待发 8.83 分，被 25/26/26A/50/21A 的 1~1.3 分样本压低 p50 后判成异常。
 *    实测：旧口径 185 条命中里 183 条所在键跨多条线路、166 条本线占比 ≤50%（92% 误判）。
 *    保留 `shared` 分支**只为对照复现**（报告里同时给出改前/改后），不参与剔除。
 */
function flagOutliers(samples, { scope = "route" } = {}) {
  const groups = new Map();
  for (const s of samples) {
    const mp = macauParts(s.t);
    const tail = `${s.from}|${s.to}|${mp.weekday}|${bucketOf(mp.hour)}`;
    const k = scope === "route" ? `${s.route}|${tail}` : tail;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const flagged = new Set();
  const list = [];
  for (const [k, g] of groups) {
    const { outliers, thr, p50 } = splitOutliers(g);
    for (const o of outliers) {
      flagged.add(o); // 用对象身份标记，便于从原集合里过滤
      list.push({ key: k, scope, route: o.route, dir: o.dir, plate: o.plate, minutes: o.minutes, p50, thr, n: g.length, t: o.t });
    }
  }
  list.sort((a, b) => b.minutes - a.minutes);
  return { flagged, list };
}

// ════════════════ 4. 真值（DB）════════════════

async function loadTruth() {
  if (CFG.truth === "none") return null;
  try { process.loadEnvFile(path.join(ROOT, ".env")); } catch { /* 无 .env */ }
  const conn = CFG.truth === "cloud" ? process.env.DATABASE_URL : (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL);
  if (!conn) { L(`⚠️ --truth=${CFG.truth} 但未找到连接串，跳过对照`); return null; }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: conn, max: 1, ssl: conn.includes("supabase") ? { rejectUnauthorized: false } : undefined });
  const r = await pool.query(
    `SELECT route_code, from_station, to_station, weekday, time_bucket, arrive_kind, avg_minutes, samples
       FROM segment_stats`,
  );
  await pool.end();
  const map = new Map(); // (fromMain|toMain) -> samples[]
  for (const row of r.rows) {
    const k = `${mainCode(row.from_station)}|${mainCode(row.to_station)}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  L(`📚 真值已载入：segment_stats ${r.rows.length} 行（${CFG.truth}）`);
  return map;
}

// ════════════════ 5. 主流程 ════════════════

async function main() {
  const files = resolveFiles();
  if (!files.length) throw new Error(`没找到分片：label=${CFG.label} in=${CFG.inGlob}`);
  const label = CFG.label || path.basename(files[0]).replace(/-part\d+\.jsonl\.gz$/, "");
  // ★ U-01：透传本轮运行元数据（aborted / durationMin / rounds / plannedMinutes）
  const runMeta = loadRunMeta(files, label);

  L(`════ 追踪式计时派生 · ${label} ════`);
  if (runMeta.aborted !== null) L(`⚠️ 本轮 aborted（${runMeta.aborted}）：样本照常落盘供诊断，但入库闸会整轮拒入`);
  else if (!runMeta.metaAvailable) L(`⚠️ 未读到 ${label}-meta.json：runMeta.metaAvailable=false，入库闸按「未知」放行并计数`);
  L(`分片 ${files.length} 个：${files.map((f) => path.basename(f)).join(" ")}`);
  const { frames, bad } = loadFrames(files);
  const okFrames = frames.filter((f) => f.ok);
  L(`帧 ${frames.length}（成功 ${okFrames.length} · 失败 ${frames.length - okFrames.length} · 解析失败 ${bad}）`);

  if (!okFrames.length) { L("无有效帧，终止。"); fs.writeFileSync(path.join(CFG.out, `${label}-derived-report.txt`), out.join("\n"), "utf8"); return; }

  const t0 = Math.min(...okFrames.map((f) => f.t));
  const t1 = Math.max(...okFrames.map((f) => f.t));
  const rounds = Math.max(...okFrames.map((f) => f.round));
  const intervalSec = Math.round((t1 - t0) / Math.max(1, rounds) / 100) / 10;
  const mp0 = macauParts(t0), mp1 = macauParts(t1);
  L(`时段 ${new Date(t0).toISOString()} ~ ${new Date(t1).toISOString()}（澳门 ${mp0.hhmm}~${mp1.hhmm}）`);
  L(`轮次 ${rounds} · 实际间隔 ≈ ${intervalSec}s · 线路数 ${new Set(okFrames.map((f) => f.route)).size}`);
  L(`车辆观测 ${okFrames.reduce((a, f) => a + (f.veh?.length ?? 0), 0)} 车次`);
  L("");

  // 站序（用于核查 idx→站码 是否与计划一致）
  let planSeq = {};
  try { planSeq = JSON.parse(fs.readFileSync(CFG.plan, "utf8"))?.plan ?? []; } catch { /* 可选 */ }
  const seqByRoute = new Map();
  for (const p of planSeq) if (p.seq) for (const [d, s] of Object.entries(p.seq)) if (Array.isArray(s)) seqByRoute.set(`${p.code}|${d}`, s);

  /**
   * 末站口径的站序规格（v1.4.0）。
   * @returns `{ prevIdx, termIdx, loop, n }`；无计划站序 / 站数 < 2 ⇒ null（不猜）
   *
   * idx 为 **0 基**（`seqByRoute` 数组下标；实测 `seq[v.idx] === v.sta`）。
   *   · 非环线：末站 = idx N-1，倒数第二站 = idx N-2
   *   · 环线（首站 = 末站）：末站与首站是同一物理站，车辆收尾时 idx 由 N-2 **回到 0**
   *     （实测 51 路 C688(18) → C690(0)，`d = −18`）⇒ 终点 idx = 0
   */
  const terminalSpecOf = (map, route, dir) => {
    const seq = map.get(`${route}|${dir}`);
    if (!seq || seq.length < 2) return null;
    const n = seq.length;
    const loop = mainCode(seq[0]) === mainCode(seq[n - 1]);
    return { prevIdx: n - 2, termIdx: loop ? 0 : n - 1, loop, n };
  };

  // ── 组装每辆车的时间序列 ──
  const series = new Map(); // route|dir|plate -> [{t,idx,sta,main,status}]
  let idxMismatch = 0;
  for (const f of okFrames) {
    for (const v of f.veh ?? []) {
      const k = `${f.route}|${f.dir}|${v.plate}`;
      if (!series.has(k)) series.set(k, []);
      const seq = seqByRoute.get(`${f.route}|${f.dir}`);
      if (seq && seq[v.idx] != null && String(seq[v.idx]) !== String(v.sta)) idxMismatch++;
      series.get(k).push({ t: f.t, idx: v.idx, sta: v.sta, main: v.main ?? mainCode(v.sta), status: v.status });
    }
  }
  // ★ 批 2 · U-05：帧数 <3 的序列跑不了状态机（原来静默 filter 掉），现记诊断
  const usable = [];
  const minFramesDropped = [];
  for (const [k, s] of series.entries()) {
    if (s.length >= 3) usable.push([k, s]);
    else minFramesDropped.push({ k, n: s.length });
  }
  L(`车辆序列 ${series.size} 条（≥3 帧可用于状态机的 ${usable.length} 条）`);
  if (idxMismatch) L(`⚠️ 站序不一致 ${idxMismatch} 次（计划缓存的站序与实际返回不符，可能改道；仅告警不影响时长）`);
  L("");

  // ── 逐车跑状态机 ──
  const depSamples = [], arrSamples = [];
  /** ★ v1.4.0：末站口径样本（纯增量；与上面两套流并列，互不影响） */
  const termSamples = [];
  const termCovered = new Set();   // 产出过末站样本的 route|dir
  const termSpecs = new Set();     // 有计划站序、可做末站口径的 route|dir
  let termNoArrive = 0;            // 有 spec 但该车没有末站到达事件（数据缺失，跳过）
  let termHasDepart = 0;           // 非环线末站有 depart ⇒ 已由离开口径覆盖，不重复造样本
  const allGaps = [], allDropAdj = [], allDropDur = [];
  /** ★ 批 2 · U-05：被「同 idx 1→0」护栏丢弃的 depart（诊断用） */
  const allSameIdxDepart = [];
  /** ★ v4.1.1：跨站段样本（`arrive_kind='spanned'`）—— 纯增量，**不进** depart/arrive 主口径聚合 */
  const spannedSamples = [];
  /** ★ v4.1.1：d ≤ 0 的两个子类（环线闭合/掉头 vs 真回退），分开计数 */
  const allWrap = [], allReverse = [];
  const longStops = [];      // status='1' 长停站（真停靠；总站休息/长时间上落客）
  const longAttaches = [];   // status='0' 长挂载（车已离站但 API 仍挂该站 → 休息期/异常）
  let nArr = 0, nDep = 0;
  for (const [k, s] of usable) {
    const [route, dir] = k.split("|");
    s.sort((a, b) => a.t - b.t);
    const { arrive, depart, gaps, comp, sameIdxDepart } = extractEvents(s);
    nArr += arrive.length; nDep += depart.length;
    for (const g of gaps) allGaps.push({ route, dir, plate: k.split("|")[2], ...g });
    for (const d of sameIdxDepart) allSameIdxDepart.push({ route, dir, plate: k.split("|")[2], ...d });
    // ── 长停站识别（两类，均按「同站同状态连续帧」的实测起止时刻计算）──
    for (const c of comp) {
      const holdMin = (c.lastT - c.firstT) / 60000;
      const lim = c.status === "1" ? LONG_STOP_MIN : LONG_ATTACH_MIN;
      if (holdMin < lim) continue;
      const rec = {
        route, dir, plate: k.split("|")[2], main: c.main, sta: c.sta, idx: c.idx,
        status: c.status, holdMin: Math.round(holdMin * 100) / 100, frames: c.n,
        t: c.firstT,
        // ★ 批 2 · U-05：段末行为判定用 —— 是否贴窗口末 / 是否本序列最后一段
        lastT: c.lastT,
        isLastComp: comp[comp.length - 1] === c,
      };
      (c.status === "1" ? longStops : longAttaches).push(rec);
    }
    const seqLen = seqByRoute.get(`${route}|${dir}`)?.length ?? 0;
    if (seqLen && s[0].idx >= seqLen) allGaps.push({ route, plate: k.split("|")[2], at: s[0].main, idx: s[0].idx, nextMain: "(站序越界)", t: s[0].t });
    for (const [evs, sink, tag] of [[depart, depSamples, "depart"], [arrive, arrSamples, "arrive"]]) {
      const { ok, spanned, dropAdj, dropDur, wrap, reverse } = segments(evs, { withDwell: tag === "depart" });
      for (const r of ok) sink.push({ route, dir, plate: k.split("|")[2], ...r, kind: tag });
      // ★ v4.1.1：跨站段保留为独立诊断流（src 标出它来自 depart 还是 arrive 事件序列）
      for (const r of spanned) spannedSamples.push({ route, dir, plate: k.split("|")[2], ...r, kind: "spanned", src: tag });
      for (const r of wrap) allWrap.push({ route, dir, plate: k.split("|")[2], kind: tag, ...r });
      for (const r of reverse) allReverse.push({ route, plate: k.split("|")[2], kind: tag, ...r });
      for (const r of dropAdj) allDropAdj.push({ route, dir, plate: k.split("|")[2], kind: tag, ...r });
      for (const r of dropDur) allDropDur.push({ route, dir, plate: k.split("|")[2], kind: tag, ...r });
    }

    // ── 末站口径（v1.4.0，纯增量）────────────────────────────────────
    const spec = terminalSpecOf(seqByRoute, route, dir);
    if (spec) {
      termSpecs.add(`${route}|${dir}`);
      const hasDepartAtTerm = depart.some((e) => Number(e.idx) === spec.termIdx);
      if (!spec.loop && hasDepartAtTerm) {
        // 末站有离开事件 ⇒ 这一跳已由 depSamples 覆盖；再加 arrive 口径会重复计数
        termHasDepart++;
      } else {
        const raw = terminalSegments(arrive, depart, spec);
        if (!raw.length) termNoArrive++;
        for (const r of raw) {
          if (r.minutes < MIN_MINUTES || r.minutes > MAX_MINUTES) {
            allDropDur.push({
              route, plate: k.split("|")[2], kind: "terminal", ...r,
              reason: r.minutes < MIN_MINUTES ? `过短 ${r.minutes.toFixed(2)} 分` : `过长 ${r.minutes.toFixed(2)} 分`,
            });
            continue;
          }
          termSamples.push({ route, dir, plate: k.split("|")[2], ...r, kind: "terminal" });
          termCovered.add(`${route}|${dir}`);
        }
      }
    }
  }
  L(`事件：到达 ${nArr} · 离开 ${nDep} · 状态缺口 ${allGaps.length} 处（→ 相邻段整段丢弃）`);
  L(`段样本：离开口径 ${depSamples.length} · 到达口径 ${arrSamples.length}`);
  // ★ v4.1.1：跨站段（不再丢弃）+ d ≤ 0 两个子类
  const spanBy2 = spannedSamples.filter((s) => s.spanned_stations === 1).length;
  const spanBy3 = spannedSamples.length - spanBy2;
  L(`跨站段（spanned，纯增量诊断流）：${spannedSamples.length} 段（跨 2 站 ${spanBy2} · 跨 ≥3 站 ${spanBy3}）` +
    ` —— 已保留并落盘，**不进** depart/arrive 主查询`);
  L(`站序非递增：环线闭合/终点掉头（wrap）${allWrap.length} 处` +
    `（回到首站 idx0 ${allWrap.filter((r) => r.head).length} · 回到 idx1 ${allWrap.filter((r) => !r.head).length}，首站帧漏采）` +
    ` · 真回退/reverse ${allReverse.length} 处` +
    `（大幅回退但未回线首 ${allReverse.filter((r) => r.d <= -3).length} · 相邻小回退/同站 ${allReverse.filter((r) => r.d > -3).length}，其中 d=0 ${allReverse.filter((r) => r.d === 0).length}）`);
  L(`末站口径（v1.4.0，纯增量）：${termSamples.length} 段 · 覆盖 ${termCovered.size}/${termSpecs.size} 个线路方向` +
    `（末站已有 depart → 不重复造 ${termHasDepart} 车次 · 无末站到达事件 ${termNoArrive} 车次）`);
  L(`丢弃：站序不邻接 ${allDropAdj.length} · 时长越界 ${allDropDur.length}`);
  const longStopSamples = depSamples.filter((s) => s.longStop).length;
  L(`长停站：dwell_B ≥ ${LONG_STOP_MIN} 分的段 ${longStopSamples}/${depSamples.length}` +
    `（含终到站休息；status='1' 长停 ${longStops.length} 处 · status='0' 长挂载 ${longAttaches.length} 处）`);
  L("");

  // ── 聚合：共享键 / 线路键 ──
  function buildKeys(samples) {
    const byShared = new Map(), byRoute = new Map();
    for (const s of samples) {
      const mp = macauParts(s.t);
      const bucket = bucketOf(mp.hour);
      const ks = `${s.from}|${s.to}|${mp.weekday}|${bucket}`;
      const kr = `${s.route}|${s.from}|${s.to}|${mp.weekday}|${bucket}`;
      if (!byShared.has(ks)) byShared.set(ks, []);
      byShared.get(ks).push(s);
      if (!byRoute.has(kr)) byRoute.set(kr, []);
      byRoute.get(kr).push(s);
    }
    const pack = (m) => {
      const o = {};
      for (const [k, list] of m) { const a = agg(list); if (a && a.n >= CFG.minSamples) o[k] = a; }
      return o;
    };
    return { byShared: pack(byShared), byRoute: pack(byRoute) };
  }
  // ── 同键一致性护栏：剔除「站外长时间停留」造出的假长区间（原值保留，可回溯）──
  // ★ v4.1.1：同时算「旧口径（跨线路共享键）」与「新口径（含 route）」——
  //   前者**只用于报告对照**（改前/改后），剔除一律用后者。
  const depFlagShared = flagOutliers(depSamples, { scope: "shared" });
  const arrFlagShared = flagOutliers(arrSamples, { scope: "shared" });
  const depFlag = flagOutliers(depSamples, { scope: CFG.outlierScope });
  const arrFlag = flagOutliers(arrSamples, { scope: CFG.outlierScope });
  const depClean = depSamples.filter((s) => !depFlag.flagged.has(s));
  const arrClean = arrSamples.filter((s) => !arrFlag.flagged.has(s));
  L(`🧹 同键一致性护栏：离开口径可疑 ${depFlag.list.length}/${depSamples.length} 条 · ` +
    `到达口径可疑 ${arrFlag.list.length}/${arrSamples.length} 条（阈值 max(p50×${OUT_MULT}, p50+${OUT_FLOOR_MIN} 分)，同键 n≥${OUT_MIN_N} 启用）`);
  L(`   口径 ${CFG.outlierScope}（键${CFG.outlierScope === "route" ? "含 route_code" : "不含 route_code，跨线路共享"}）` +
    ` · 对照：旧口径 shared 命中 离开 ${depFlagShared.list.length} / 到达 ${arrFlagShared.list.length} 条`);
  L("");

  const depAgg = buildKeys(depClean);
  const arrAgg = buildKeys(arrClean);

  // 双口径对照（同一段两口径的差 = dwell_B − dwell_A）；用**护栏后**样本，避免假区间污染
  const dPairs = new Map();
  for (const s of depClean) { const k = `${s.route}|${s.from}|${s.to}`; if (!dPairs.has(k)) dPairs.set(k, { d: [], a: [] }); dPairs.get(k).d.push(s.minutes); }
  for (const s of arrClean) { const k = `${s.route}|${s.from}|${s.to}`; if (dPairs.has(k)) dPairs.get(k).a.push(s.minutes); }
  const dualDiffs = [];
  for (const [k, v] of dPairs) {
    if (!v.d.length || !v.a.length) continue;
    dualDiffs.push({ key: k, dep: v.d.reduce((a, b) => a + b, 0) / v.d.length, arr: v.a.reduce((a, b) => a + b, 0) / v.a.length, n: Math.min(v.d.length, v.a.length) });
  }

  // ── 与真值对照 ──
  const truth = await loadTruth();
  const compares = [];
  if (truth) {
    const seen = new Map(); // route|from|to -> {mins:[], truth:[]}
    for (const s of depClean) {
      const k = `${s.route}|${s.from}|${s.to}`;
      if (!seen.has(k)) seen.set(k, { mins: [], rows: truth.get(`${s.from}|${s.to}`) ?? [] });
      seen.get(k).mins.push(s.minutes);
    }
    for (const [k, v] of seen) {
      if (!v.rows.length) continue;
      const [route, from, to] = k.split("|");
      const tMean = v.rows.filter((r) => r.arrive_kind !== "all" && r.weekday !== -1);
      const use = tMean.length ? tMean : v.rows;
      const tw = use.reduce((a, r) => a + Number(r.avg_minutes) * r.samples, 0) / use.reduce((a, r) => a + r.samples, 0);
      const tn = use.reduce((a, r) => a + r.samples, 0);
      const mine = v.mins.reduce((a, b) => a + b, 0) / v.mins.length;
      compares.push({ route, from, to, mine, truth: tw, diff: mine - tw, nMine: v.mins.length, nTruth: tn });
    }
    compares.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  }

  // ════ 报告 ════
  const depSharedN = Object.keys(depAgg.byShared).length;
  L("═".repeat(64));
  L("## 一、样本规模");
  L(`  离开口径（与手动打点同口径）：${depSamples.length} 段样本 · ${depSharedN} 个唯一邻接键`);
  L(`  到达口径（与 segment_stats 同口径）：${arrSamples.length} 段样本 · ${Object.keys(arrAgg.byShared).length} 个唯一邻接键`);
  L(`  末站口径（到达末站 − 离开倒数第二站）：${termSamples.length} 段样本 · ` +
    `${new Set(termSamples.map((s) => `${s.from}|${s.to}`)).size} 个唯一邻接键 · ` +
    `覆盖 ${termCovered.size}/${termSpecs.size} 个线路方向`);
  L(`  跨站口径（spanned，诊断用，**不进主查询**）：${spannedSamples.length} 段样本 · ` +
    `跨 2 站 ${spanBy2} · 跨 ≥3 站 ${spanBy3}（明细见 rawSpannedSamples）`);
  L(`  🧹 护栏后净样本：离开 ${depClean.length} · 到达 ${arrClean.length}` +
    `（剔除「站外长时间停留」假区间：离开 ${depFlag.list.length} · 到达 ${arrFlag.list.length}，原值保留在 derived.json / 第六节）`);
  const bucketCount = {};
  for (const s of depSamples) { const b = bucketOf(macauParts(s.t).hour); bucketCount[b] = (bucketCount[b] ?? 0) + 1; }
  L(`  时段分布：${Object.entries(bucketCount).map(([k, v]) => `${k}=${v}`).join("  ") || "—"}`);
  L("");

  L("## 二、双口径内部一致性（差 = dwell_B − dwell_A，理论均值应≈0；护栏后样本）");
  if (dualDiffs.length) {
    const diffs = dualDiffs.map((x) => (x.dep - x.arr) * 60);
    const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - m) ** 2, 0) / diffs.length);
    L(`  可对照 ${dualDiffs.length} 段：均值差 ${m.toFixed(1)} 秒 · 标准差 ${sd.toFixed(1)} 秒 · 绝对值最大 ${Math.max(...diffs.map(Math.abs)).toFixed(0)} 秒`);
    for (const x of dualDiffs.sort((a, b) => Math.abs(b.dep - b.arr) - Math.abs(a.dep - a.arr)).slice(0, 5))
      L(`    ${x.key}：离开 ${x.dep.toFixed(2)} 分 vs 到达 ${x.arr.toFixed(2)} 分 → 差 ${((x.dep - x.arr) * 60).toFixed(0)} 秒（n=${x.n}）`);
  } else L("  （无同段双口径样本）");
  L("");

  L("## 三、样本最多的段（离开口径 Top 20 · 护栏后）");
  const top = Object.entries(depAgg.byShared).sort((a, b) => b[1].n - a[1].n).slice(0, 20);
  L(`  ${"共享键(from|to|wd|bucket)".padEnd(34)} ${"n".padStart(4)} ${"均值".padStart(7)} ${"p50".padStart(7)} ${"min".padStart(7)} ${"max".padStart(7)}`);
  for (const [k, a] of top) L(`  ${k.padEnd(34)} ${String(a.n).padStart(4)} ${String(a.avg).padStart(7)} ${String(a.p50).padStart(7)} ${String(a.min).padStart(7)} ${String(a.max).padStart(7)}`);
  L("");

  if (truth) {
    L(`## 四、与 segment_stats 真值对照（按站码归一 + 样本加权；--truth=${CFG.truth}；护栏后样本）`);
    if (!compares.length) L("  （无交集）");
    else {
      const ad = compares.map((c) => Math.abs(c.diff));
      const mad = ad.reduce((a, b) => a + b, 0) / ad.length;
      const signed = compares.reduce((a, c) => a + c.diff, 0) / compares.length;
      const within = (th) => compares.filter((c) => Math.abs(c.diff) <= th).length;
      L(`  可对照 ${compares.length} 段 · 平均绝对差 ${mad.toFixed(2)} 分（${(mad * 60).toFixed(0)} 秒）`);
      L(`  平均符号差 ${signed.toFixed(2)} 分（${(signed * 60).toFixed(0)} 秒）→ ${Math.abs(signed) < 0.15 ? "无系统性偏差" : "⚠️ 存在系统性偏差"}`);
      L(`  |差|≤0.5 分：${within(0.5)}/${compares.length} · ≤1 分：${within(1)}/${compares.length} · ≤2 分：${within(2)}/${compares.length}`);
      L(`  偏差最大的 10 段：`);
      for (const c of compares.slice(0, 10))
        L(`    ${c.route}路 ${c.from}→${c.to}：追踪 ${c.mine.toFixed(2)} 分 | 真值 ${c.truth.toFixed(2)} 分 | 差 ${c.diff >= 0 ? "+" : ""}${c.diff.toFixed(2)} 分（n追=${c.nMine} n真=${c.nTruth}）`);
    }
    L("");
  }

  L("## 五、异常与缺口清单");
  L(`  状态缺口 ${allGaps.length} 处（该站离开时刻不可测）`);
  for (const g of allGaps.slice(0, 15)) L(`    ${g.route}路 ${g.plate} @ ${g.at}(i${g.idx}) → 直接跳到 ${g.nextMain}  ${macauParts(g.t).hhmm}`);
  if (allGaps.length > 15) L(`    …另 ${allGaps.length - 15} 处`);
  L(`  站序非递增：环线闭合/终点掉头 ${allWrap.length} 处（**不属于异常**，收尾段由 terminal 口径覆盖）` +
    ` · 真回退/同站 ${allReverse.length} 处（异常；原口径会把两者混成一个数字）`);
  L(`  跨站段 ${spannedSamples.length} 段（跨 2 站 ${spanBy2} · 跨 ≥3 站 ${spanBy3}）→ 已保留为 spanned 诊断流，不再丢弃`);
  L(`  时长越界 ${allDropDur.length} 段（含 spanned 口径越界 ${allDropDur.filter((d) => d.spanned_stations != null).length} 段）`);
  for (const d of [...allDropDur].sort((a, b) => b.minutes - a.minutes).slice(0, 8))
    L(`    ${d.kind === "depart" ? "离开口径" : d.kind === "terminal" ? "末站口径" : d.spanned_stations != null ? "跨站口径" : "到达口径"} ${d.route}路 ${d.from}→${d.to} = ${d.minutes.toFixed(2)} 分（${d.reason}）`);
  L("");

  L("## 六、同键一致性护栏命中（站外长时间停留 → 假长区间）");
  L(`  规则：同一键 n≥${OUT_MIN_N} 时，样本 > max(p50×${OUT_MULT}, p50+${OUT_FLOOR_MIN} 分) 判为可疑 → 从均值剔除（原值保留在 derived.json）`);
  L(`  分组键口径：${CFG.outlierScope} —— ${CFG.outlierScope === "route" ? "route|from|to|weekday|bucket（本线自成一组）" : "from|to|weekday|bucket（跨线路共享，旧口径）"}`);
  L(`  改前/改后对照：旧口径命中 离开 ${depFlagShared.list.length} / 到达 ${arrFlagShared.list.length} 条 → 新口径 离开 ${depFlag.list.length} / 到达 ${arrFlag.list.length} 条`);
  if (!depFlag.list.length && !arrFlag.list.length) L("  无命中");
  else {
    for (const x of depFlag.list.slice(0, 30))
      L(`    离开 ${x.route}路 ${x.key}：${x.minutes.toFixed(2)} 分 vs 同键 n=${x.n} p50 ${x.p50.toFixed(2)}（阈值 ${x.thr.toFixed(2)}）· ${x.plate} ${macauParts(x.t).hhmm}`);
    if (depFlag.list.length > 30) L(`    …另 ${depFlag.list.length - 30} 条（离开口径，明细见 derived.json outlierGuard.departCandidates）`);
    for (const x of arrFlag.list.slice(0, 20))
      L(`    到达 ${x.route}路 ${x.key}：${x.minutes.toFixed(2)} 分 vs 同键 n=${x.n} p50 ${x.p50.toFixed(2)}（阈值 ${x.thr.toFixed(2)}）· ${x.plate}`);
  }
  L(`  ⚠️ 同键样本 < ${OUT_MIN_N} 时护栏不启用（样本太少判不出一致性）→ 这类键的极端值见第三节 max 列，必要时人工核查`);
  L("");

  // ── 七、长时间停站（dwell_B）────────────────────────────────────────
  // 与第六节的区别：第六节治「同键里孤立偏大」；本节是**直接量出来的停站**，
  // 不依赖同键样本数，因此单轮/单样本也能判（n=1 的键同样有效）。
  L("## 七、长时间停站识别（dwell_B = 到站首帧 → 离站首帧；离开口径的差里含此值）");
  const byStation = new Map(); // route|main|status -> {n, max, sum, frames}
  for (const x of [...longStops.map((x) => ({ ...x, status: "1" })), ...longAttaches]) {
    const k = `${x.route}|${x.main}|${x.status}`;
    if (!byStation.has(k)) byStation.set(k, { n: 0, max: 0, sum: 0 });
    const a = byStation.get(k);
    a.n++; a.sum += x.holdMin; if (x.holdMin > a.max) a.max = x.holdMin;
  }
  const stationRows = [...byStation.entries()]
    .map(([k, v]) => ({ k, ...v, avg: v.sum / v.n }))
    .sort((a, b) => b.n - a.n);
  if (!stationRows.length) L("  无命中");
  else {
    L(`  按（线路 × 站点 × status）聚合，共 ${stationRows.length} 组；前 20 组：`);
    L(`  ${"线路|站点|st".padEnd(20)} ${"n".padStart(5)} ${"均值".padStart(6)} ${"最大".padStart(6)}`);
    for (const r of stationRows.slice(0, 20))
      L(`  ${r.k.padEnd(20)} ${String(r.n).padStart(5)} ${r.avg.toFixed(2).padStart(6)} ${r.max.toFixed(2).padStart(6)}`);
    if (stationRows.length > 20) L(`  …另 ${stationRows.length - 20} 组`);
    L(`  判读：status='1' 长停 = 车真实停在站台（总站休息 / 长时间上落客）；`);
    L(`        status='0' 长挂载 = 车已离站但 API 仍挂该站（司机休息期不换站的已知行为，见文件头 ④）。`);
    L(`        后者在段层面表现为「该站 → 下一站」时长被拉长，且同键护栏可能判不出（真实长路段同样长）。`);
  }
  L("");

  // ── 落盘 ──
  // ★ 批 2 · U-05：独立诊断流（全量、带三域 discardReason），**另写** `<label>-diagnostics.json`，
  //   绝不进 `<label>-derived.json` 的 rawDepartSamples/rawTerminalSamples（不污染 ETA）。
  //   文件名**不以 `-derived.json` 结尾** ⇒ segment-samples.ts 的 listDerivedFiles()
  //   （`endsWith("-derived.json")`）扫不到，入库端永远不会把它当样本轮。
  const windowObj = { from: new Date(t0).toISOString(), to: new Date(t1).toISOString() };
  const WINDOW_EDGE_MS = 3 * intervalSec * 1000; // 段末距窗口尾 ≤3 个采样间隔 → 视为「贴窗口末」
  const diagnostics = [];
  const pushDiag = (reason, rec) => {
    diagnostics.push({
      discardReason: assertReason(reason),
      label,
      route: rec.route ?? null, dir: rec.dir ?? null, plate: rec.plate ?? null,
      main: rec.main ?? rec.at ?? null, sta: rec.sta ?? null, idx: rec.idx ?? null,
      status: rec.status ?? null, holdMin: rec.holdMin ?? null, frames: rec.frames ?? null,
      t: rec.t ?? null, window: windowObj,
      ...(rec.detail ? { detail: rec.detail } : {}),
      ...(rec.kind ? { kind: rec.kind } : {}),
      ...(rec.lastT !== undefined ? { lastT: rec.lastT } : {}),
    });
  };
  // guard.* —— 派生端护栏主动丢弃
  for (const m of minFramesDropped) {
    const [route, dir, plate] = m.k.split("|");
    pushDiag(DISCARD_REASONS.GUARD_MIN_SERIES_FRAMES, { route, dir, plate, frames: m.n });
  }
  for (const x of allSameIdxDepart) pushDiag(DISCARD_REASONS.GUARD_SAME_IDX_DEPART, x);
  for (const x of allGaps) pushDiag(DISCARD_REASONS.GUARD_S1_TO_S1_GAP, x);
  for (const x of allDropAdj) pushDiag(DISCARD_REASONS.GUARD_NOT_ADJACENT, x);
  for (const x of allDropDur) pushDiag(DISCARD_REASONS.GUARD_DURATION_OUT_OF_RANGE, x);
  // source.reanchorToHead —— 车重锚到线首（wrap 且 head）
  for (const x of allWrap.filter((r) => r.head)) pushDiag(DISCARD_REASONS.SOURCE_REANCHOR_TO_HEAD, x);
  // 长停全量（source.windowEnd / source.plateRemoved / output.topNSlice 三分）
  const sortedStops = [...longStops].sort((a, b) => b.holdMin - a.holdMin);
  const sortedAttaches = [...longAttaches].sort((a, b) => b.holdMin - a.holdMin);
  const truncatedCount = { stops: Math.max(0, sortedStops.length - 2000), attaches: Math.max(0, sortedAttaches.length - 2000) };
  const classifyHold = (r) => {
    if (r.lastT !== undefined && r.lastT >= t1 - WINDOW_EDGE_MS) return DISCARD_REASONS.SOURCE_WINDOW_END;
    if (r.isLastComp) return DISCARD_REASONS.SOURCE_PLATE_REMOVED;
    // 中部完整结束的常规长停：不是「被丢弃」，而是「旧 slice(0,2000) 会限制、现全量留在诊断文件」
    return DISCARD_REASONS.OUTPUT_TOPN_SLICE;
  };
  for (const r of [...sortedStops, ...sortedAttaches]) pushDiag(classifyHold(r), r);
  // output.abortedRound —— 整轮中止
  if (runMeta.aborted !== null) pushDiag(DISCARD_REASONS.OUTPUT_ABORTED_ROUND, { t: t0 });
  const diagByReason = {};
  for (const d of diagnostics) diagByReason[d.discardReason] = (diagByReason[d.discardReason] ?? 0) + 1;

  const derived = {
    label,
    generatedAt: new Date().toISOString(),
    // ★ U-01：schemaVersion>=2 才启用 aborted 轮级闸；存量 57 轮无此字段 ⇒ 自动维持现状（裁定 (a)）
    schemaVersion: 2,
    runMeta,
    source: { files: files.map((f) => path.basename(f)), frames: frames.length, okFrames: okFrames.length, rounds, intervalSec },
    window: { from: new Date(t0).toISOString(), to: new Date(t1).toISOString(), macau: `${mp0.hhmm}~${mp1.hhmm}` },
    counts: {
      vehicleSeries: series.size, usableSeries: usable.length,
      arriveEvents: nArr, departEvents: nDep,
      statusGaps: allGaps.length,
      departSamples: depSamples.length, arriveSamples: arrSamples.length,
      // ★ v1.4.0：末站口径（到达末站 − 离开倒数第二站）；纯增量，不改上面两套流
      terminalSamples: termSamples.length,
      terminalCoverage: { dirs: termCovered.size, specs: termSpecs.size },
      terminalSkipped: { hasDepart: termHasDepart, noArrive: termNoArrive },
      cleanSamples: { depart: depClean.length, arrive: arrClean.length },
      outliers: { depart: depFlag.list.length, arrive: arrFlag.list.length },
      // ★ v4.1.1：护栏口径对照（shared = 旧口径，仅用于证明改前/改后）
      outliersByScope: {
        scope: CFG.outlierScope,
        route: { depart: depFlag.list.length, arrive: arrFlag.list.length },
        shared: { depart: depFlagShared.list.length, arrive: arrFlagShared.list.length },
      },
      // ★ v4.1.1：跨站段（不再丢弃）+ d≤0 的两个子类
      spannedSamples: spannedSamples.length,
      spannedByCrossed: { two: spanBy2, threePlus: spanBy3 },
      adjacencyBackwards: {
        wrap: allWrap.length,
        wrapToHead: allWrap.filter((r) => r.head).length,
        wrapToHeadNext: allWrap.filter((r) => !r.head).length,
        reverse: allReverse.length,
        reverseBigSpan: allReverse.filter((r) => r.d <= -3).length,
        reverseSmall: allReverse.filter((r) => r.d > -3).length,
        reverseSameIdx: allReverse.filter((r) => r.d === 0).length,
      },
      dropped: { notAdjacent: allDropAdj.length, durationOutOfRange: allDropDur.length },
      // ★ v1.2.0：长停站（dwell_B ≥ LONG_STOP_MIN 的段）与两类原始长停事件
      longStopSamples,
      longStops: longStops.length,
      longAttaches: longAttaches.length,
    },
    longStopGuard: {
      thresholdMin: LONG_STOP_MIN,
      attachThresholdMin: LONG_ATTACH_MIN,
      note: "dwell_B 已随每个离开口径样本落盘（dwellMin / longStop）；明细已移至 <label>-diagnostics.json（全量、带 discardReason），本处只留旧 slice(0,2000) 会截掉的条数",
      byStation: stationRows,
      // ★ 批 2 · U-05：去掉 slice(0,2000) —— 明细全量写诊断文件；这里只留「旧 slice 会截掉多少」，
      //   便于判断该轮是否发生过截断（当前 57 轮实测量级 198/472，远小于 2000 ⇒ truncatedCount=0）。
      truncatedCount,
      stopsTotal: sortedStops.length,
      attachesTotal: sortedAttaches.length,
    },
    outlierGuard: {
      rule: { mult: OUT_MULT, floorMin: OUT_FLOOR_MIN, minN: OUT_MIN_N },
      /** ★ v4.1.1：分组键含 route_code（本线自成一组）；shared = 旧口径，仅对照 */
      scope: CFG.outlierScope,
      note: "同键一致性护栏：剔除「站外长时间停留」造成的假长区间；原值保留在 rawDepartSamples 与下方清单中",
      departCandidates: depFlag.list,
      arriveCandidates: arrFlag.list,
      /** 旧口径（跨线路共享键）命中 —— **仅用于对照**，不参与剔除 */
      sharedScopeCandidates: { depart: depFlagShared.list, arrive: arrFlagShared.list },
    },
    depart: depAgg,
    arrive: arrAgg,
    dualDiff: dualDiffs,
    truthCompare: compares,
    anomalies: {
      gaps: allGaps,
      notAdjacent: allDropAdj,
      durationOutOfRange: allDropDur,
      /** ★ v4.1.1：环线闭合/终点掉头（**不是异常**；收尾段由 terminal 口径覆盖） */
      wrap: allWrap,
      /** ★ v4.1.1：真正的站序回退 / 同站重复（异常，需人工核查） */
      reverse: allReverse,
    },
    rawDepartSamples: depSamples,
    // ★ v1.4.0：末站口径原始样本（`arrive_kind='terminal'`）。
    //   与 rawDepartSamples 并列；入库端（src/lib/rebuild/segment-samples.ts）写入时按 kind 透传。
    rawTerminalSamples: termSamples,
    // ★ v4.1.1：跨站段原始样本（`arrive_kind='spanned'`，带 spanned_stations）。
    //   ⚠️ **刻意不入库**：segment_stats / route_hop_stats / 长停判据都直接读 segment_samples
    //      全表（不按 arrive_kind 过滤），入库会把这些「含中间站停站」的时长混进邻接段 p50/avg。
    //      要启用必须先给上述三处加 arrive_kind 过滤 + 子段分摊（见文件头「跨站段」一节）。
    rawSpannedSamples: spannedSamples,
  };
  fs.writeFileSync(path.join(CFG.out, `${label}-derived.json`), JSON.stringify(derived, null, 2), "utf8");
  fs.writeFileSync(path.join(CFG.out, `${label}-derived-report.txt`), out.join("\n") + "\n", "utf8");
  // ★ 批 2 · U-05：独立诊断文件（全量、带三域 reason；runMeta 写头供 output.abortedRound 判定）。
  //   文件名以 `-diagnostics.json` 结尾，**不是** `-derived.json` ⇒ 入库端 listDerivedFiles() 扫不到。
  const diagnosticsDoc = {
    label,
    generatedAt: new Date().toISOString(),
    schemaVersion: 2,
    runMeta,
    source: derived.source,
    window: windowObj,
    reasonDomains: {
      source: Object.values(DISCARD_REASONS).filter((r) => r.startsWith("source.")),
      guard: Object.values(DISCARD_REASONS).filter((r) => r.startsWith("guard.")),
      output: Object.values(DISCARD_REASONS).filter((r) => r.startsWith("output.")),
    },
    counts: { total: diagnostics.length, byReason: diagByReason },
    records: diagnostics,
  };
  fs.writeFileSync(path.join(CFG.out, `${label}-diagnostics.json`), JSON.stringify(diagnosticsDoc, null, 2), "utf8");
  L(`产物：${label}-derived.json · ${label}-derived-report.txt · ${label}-diagnostics.json（诊断 ${diagnostics.length} 条）`);
}

main().catch((e) => {
  out.push(`❌ FATAL ${e?.stack || e?.message}`);
  try { fs.writeFileSync(path.join(CFG.out, `${CFG.label || "derive"}-derived-report.txt`), out.join("\n") + "\n", "utf8"); } catch { /* 尽力 */ }
  console.error(e);
  process.exit(1);
});
