/**
 * 轻轨/GPS 推进核心对拍（scripts/test-lrt-progress.ts，2026-11-04 新增）
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/test-lrt-progress.ts
 *
 * ── 为什么必须存在 ────────────────────────────────────────────────────
 *   `advanceLrt` 是「无牌 GPS 推进」（`useRideTracking.ts` 的 `gpsDriven` 分支）的
 *   **唯一推进核心**：可信门 / 速度门 / 迟滞 / 连续 2 帧一致 / 单帧最多 +1 站 / 冻结不跳，
 *   六条防跳站规则全在这一个函数里。而在本次新增之前它**全仓零断言**
 *   （`grep -rln "advanceLrt" . --include='*.ts' --include='*.mjs'` 只命中 5 个 src 消费文件），
 *   `.verify/` 里也只有 `buildLrtLadder` 被当 fixture 用、不校验输出。
 *   ⇒ 谁改坏它都不会变红。本脚本就是补这个洞。
 *
 * ── 覆盖（12 组，见 CASES 表）─────────────────────────────────────────
 *   G0  几何前置（cum 距离口径）—— 下游所有期望值都建在它上面，先自检
 *   G1a ladder 全 invalid ⇒ `passedIdx` 恒 -1，`kind` 仍是合法值
 *   G1b 站点集为空 ⇒ `kind="lost"`，但 `distNow` 仍有里程（QA 的 no-stops 形态）
 *   G2a 不可信帧：首帧 `frozen:false` / 第二帧 `frozen:true`，**prog 不得丢成 lost**
 *   G2b `fix=null` ⇒ 立即 `frozen:true`，prog 仍 `between`
 *   G3a **连续 2 帧 computed 一致才采纳**：首帧不前进、第二帧同值才 +1
 *   G3b **两帧异值不前进**；第三帧同值才前进
 *   G4  **单帧最多 +1 站**：跨 3 站跳跃 = +1（连做两帧 = +2，不是 +3）
 *   G5  速度门：1s 内 600m ⇒ 拒帧；同样位移给 60s ⇒ 放行（正反对照）
 *   G6a `buildLrtLadder`：`colored.length < 2` ⇒ `path:[]`、ladder 全 NaN、valid 全 false
 *   G6b 站点投影离路径 > `LRT_TOL_M` ⇒ 该站剔除
 *   G6c 站点乱序/重复/缺坐标 ⇒ 单调化剔除
 *
 * ⚠️ **纯合成几何，不连库、不联网**（导航引擎不能依赖网络才能验）。
 *    1m ≈ 1/111320 度纬；经度按 cos(lat) 折算 —— 与 `route-overview.distM` 同一口径，
 *    因此脚本里的「期望里程」与函数内部算出的 `cum` 一致到浮点误差级。
 *
 * ⚠️ **速度门是魔法数 80**（`lrt-progress.ts:153` `if (kmh > 80) return frozen(0);`），
 *    没有导出常量 ⇒ 本脚本 G5 直接引用 `SPEED_GATE_KMH`（本地常量）并把 80 写进断言详情，
 *    将来若把它提取成导出常量，**必须同步改这里**，否则本条会静默失配。
 */
import {
  advanceLrt,
  buildLrtLadder,
  LRT_ACC_MAX_M,
  LRT_H_MIN_M,
  LRT_TOL_M,
  type LrtAdvanceInput,
  type LrtLadder,
} from "../src/lib/nav/lrt-progress";
import { cumDistM, type LL } from "../src/lib/nav/route-overview";
import type { FixLite } from "../src/lib/nav/boarding-detect";

/* ══════════ 合成几何 ══════════ */

const LAT0 = 22.19;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos((LAT0 * Math.PI) / 180);
/** 平面米 → 点（原点 = (113.55, LAT0)） */
const ll = (xM: number, yM: number): LL => [113.55 + xM / M_PER_DEG_LNG, LAT0 + yM / M_PER_DEG_LAT];
/** 平面米 → `{lng,lat}`（`buildLrtLadder` 的站点入参形状，不是 `LL` 元组） */
const pt = (xM: number, yM: number): { lng: number; lat: number } => {
  const p = ll(xM, yM);
  return { lng: p[0], lat: p[1] };
};

/** 直线向北，每 `step` 米一个顶点（`nearestOnPath` 取**最近顶点** ⇒ 期望里程可精确控制） */
function straight(n: number, step: number): LL[] {
  const out: LL[] = [];
  for (let i = 0; i <= n; i++) out.push(ll(0, i * step));
  return out;
}

/** 25 个顶点、间距 100m ⇒ cum = 0,100,…,2400 */
const PATH = straight(24, 100);
const CUM = cumDistM(PATH);
/** 站点取顶点 0/2/4/6/8 ⇒ 站距 200m（0.25×200=50 < LRT_H_MIN_M ⇒ H 恒 60，期望值好算） */
const STOP_VERTICES = [0, 2, 4, 6, 8] as const;
/** 站点的期望沿线里程 */
const EXPECT_STOP_CUM = [0, 200, 400, 600, 800];

const stopAt = (v: number) => ({ lng: PATH[v][0], lat: PATH[v][1] });
const LADDER: LrtLadder = buildLrtLadder(
  PATH,
  STOP_VERTICES.map((v) => stopAt(v)),
);

/** 落在顶点 v 上的定位帧（`accuracy` 默认 10 ⇒ 远小于两道门） */
const fixAt = (v: number, ts: number, accuracy = 10): FixLite => ({
  lng: PATH[v][0],
  lat: PATH[v][1],
  accuracy,
  ts,
});

/** 状态构造器（缺省 = 未推进、无速度基准、无坏帧） */
function st(o?: Partial<LrtAdvanceInput>): LrtAdvanceInput {
  return {
    prevPassedIdx: -1,
    prevComputed: -1,
    prevDist: 0,
    prevTs: 0,
    badStreak: 0,
    ladder: LADDER,
    fix: null,
    ...o,
  };
}

/* ══════════ 断言框架（含 44c 分母） ══════════ */

let pass = 0;
let fail = 0;
let checks = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  checks++;
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `\n      ${detail}` : ""}`);
  } else {
    fail++;
    console.error(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

const r1 = (n: number) => Math.round(n * 10) / 10;

interface CaseDef {
  id: string;
  title: string;
  run: () => void;
}

/**
 * ★ 铁律 44c-②：用例表尺寸必须与「枚举出来的用例数」**显式相等**。
 *   加/删用例而忘改这里 ⇒ 立刻红（防「悄悄少跑几组还全绿」）。
 */
const EXPECTED_CASE_COUNT = 12;
/**
 * ★ 铁律 44c-②（检查级）：`ok()` 的**执行次数**必须等于枚举数。
 *   任何 `if` 把某条断言静默跳过、或某组提前 return，都会让计数变少 ⇒ 红。
 *   ⚠️ 改断言时同步改这里（它就是这层网的触发点，不是装饰）。
 */
const EXPECTED_CHECK_COUNT = 64;

const CASES: CaseDef[] = [
  /* ── G0 几何前置 ── */
  {
    id: "G0",
    title: "几何前置：站距 200m、cum 口径对齐（下游期望值的地基）",
    run: () => {
      const got = STOP_VERTICES.map((v) => CUM[v]);
      ok(
        got.every((d, i) => Math.abs(d - EXPECT_STOP_CUM[i]) < 0.5),
        "顶点 cum 与期望站距一致（每站 200m）",
        `实际 ${got.map((d) => r1(d)).join(" / ")} · 期望 ${EXPECT_STOP_CUM.join(" / ")}`,
      );
      ok(
        LADDER.ladder.length === STOP_VERTICES.length && LADDER.valid.every((v) => v),
        "5 个站全部有效（投影离路径 0m）",
        `ladder=${JSON.stringify(LADDER.ladder.map((d) => r1(d)))}`,
      );
      ok(
        LADDER.ladder.every((d, i) => Math.abs(d - EXPECT_STOP_CUM[i]) < 0.5),
        "ladder[i] 与期望站里程一致",
      );
      ok(LRT_H_MIN_M === 60 && LRT_TOL_M === 120 && LRT_ACC_MAX_M === 100, "常量取值锁定", `H_MIN=${LRT_H_MIN_M} TOL=${LRT_TOL_M} ACC_MAX=${LRT_ACC_MAX_M}`);
    },
  },

  /* ── G1a ladder 全 invalid ── */
  {
    id: "G1a",
    title: "ladder 全 invalid ⇒ passedIdx 恒 -1，kind 仍是合法值（不 NaN / 不 undefined）",
    run: () => {
      const ladder = buildLrtLadder(PATH, [null, null, null, null, null]);
      ok(ladder.valid.every((v) => v === false), "构造 ok：valid 全 false", `valid=${JSON.stringify(ladder.valid)}`);
      ok(ladder.ladder.length === 5, "构造 ok：站点数仍为 5（不是空表）", `len=${ladder.ladder.length}`);

      const a = advanceLrt(st({ ladder, fix: fixAt(8, 1_000) }));
      ok(a.passedIdx === -1, "第 1 帧：passedIdx 仍 -1（无有效站 ⇒ 无可推进）", `passedIdx=${a.passedIdx} computed=${a.computed}`);
      ok(a.progress.kind === "between", "第 1 帧：kind=between（不是 lost / 不是 undefined）", `kind=${a.progress.kind}`);
      ok(a.progress.nextIdx === 0, "第 1 帧：nextIdx=0（首站待过）", `nextIdx=${a.progress.nextIdx}`);

      const b = advanceLrt(
        st({ ladder, prevPassedIdx: a.passedIdx, prevComputed: a.computed, prevDist: a.distNow, prevTs: a.ts, fix: fixAt(20, 61_000) }),
      );
      ok(b.passedIdx === -1, "第 2 帧（走到更远处）：仍不推进（无有效站 ⇒ 恒 -1）", `passedIdx=${b.passedIdx} computed=${b.computed}`);
      ok(b.progress.kind === "between", "第 2 帧：kind 仍合法", `kind=${b.progress.kind}`);
    },
  },

  /* ── G1b 站点集为空 ── */
  {
    id: "G1b",
    title: "stops 为空 ⇒ kind=lost，但 distNow 仍有里程（QA 的 no-stops 形态：有里程无进度）",
    run: () => {
      const ladder = buildLrtLadder(PATH, []);
      ok(ladder.ladder.length === 0, "构造 ok：ladder 空表", `len=${ladder.ladder.length}`);
      const a = advanceLrt(st({ ladder, fix: fixAt(8, 1_000) }));
      ok(a.progress.kind === "lost", "kind=lost（lastIdx<0 ⇒ EMPTY）", `kind=${a.progress.kind}`);
      ok(a.progress.passedIdx === -1 && a.progress.nextIdx === null && a.progress.atIdx === null, "lost 的三元组全空", JSON.stringify(a.progress));
      ok(
        a.distNow > 700 && a.distNow < 900,
        "但 distNow 仍算出里程 ≈800m（⇒「有里程、无进度」是可观测状态，不是全黑）",
        `distNow=${r1(a.distNow)}`,
      );
    },
  },

  /* ── G2a 不可信帧 ── */
  {
    id: "G2a",
    title: "不可信帧（精度超限）：首帧 frozen:false / 次帧 frozen:true，prog 不得丢成 lost",
    run: () => {
      const base = st({ prevPassedIdx: 1, prevComputed: 1, prevDist: 200, prevTs: 0 });
      const f1 = advanceLrt({ ...base, fix: fixAt(8, 1_000, LRT_ACC_MAX_M + 50) });
      ok(f1.frozen === false, `首帧不冻结（badStreak 1<2）：frozen=${f1.frozen}`, `badStreak=${f1.badStreak}`);
      ok(f1.badStreak === 1, "首帧 badStreak=1", `badStreak=${f1.badStreak}`);
      ok(f1.progress.kind === "between", "首帧 prog 仍 between（不许丢成 lost）", `kind=${f1.progress.kind}`);
      ok(f1.passedIdx === 1, "首帧保留 prevPassedIdx=1", `passedIdx=${f1.passedIdx}`);

      const f2 = advanceLrt({ ...base, badStreak: f1.badStreak, fix: fixAt(8, 2_000, LRT_ACC_MAX_M + 50) });
      ok(f2.frozen === true, "次帧冻结（badStreak 累到 2）", `frozen=${f2.frozen} badStreak=${f2.badStreak}`);
      ok(f2.badStreak === 2, "次帧 badStreak=2", `badStreak=${f2.badStreak}`);
      ok(f2.progress.kind === "between", "次帧 prog 仍是 between（★ 这条就是「不许把已有 prog 丢成 lost」）", `kind=${f2.progress.kind}`);
      ok(f2.passedIdx === 1 && Math.abs(f2.distNow - 200) < 0.5, "次帧进度与里程都停在原地", `passedIdx=${f2.passedIdx} distNow=${r1(f2.distNow)}`);
    },
  },

  /* ── G2b fix 缺失 ── */
  {
    id: "G2b",
    title: "fix=null ⇒ 立即 frozen:true，prog 仍 between 且保留上帧",
    run: () => {
      const a = advanceLrt(st({ prevPassedIdx: 1, prevComputed: 1, prevDist: 200, fix: null }));
      ok(a.frozen === true, "frozen=true", `frozen=${a.frozen}`);
      ok(a.badStreak === 1, "badStreak 0→1", `badStreak=${a.badStreak}`);
      ok(a.progress.kind === "between" && a.passedIdx === 1, "prog 仍 between / passedIdx=1", `kind=${a.progress.kind} passedIdx=${a.passedIdx}`);
      ok(Math.abs(a.distNow - 200) < 0.5, "distNow 保持上帧 200m", `distNow=${r1(a.distNow)}`);
    },
  },

  /* ── G3a 连续 2 帧一致才采纳 ── */
  {
    id: "G3a",
    title: "连续 2 帧 computed 一致才采纳：首帧不前进、第二帧同值才 +1",
    run: () => {
      // 顶点 8 = 里程 800m ⇒ computed = max{i: 800 > ladder[i]+H(60)} = 3
      const a = advanceLrt(st({ fix: fixAt(8, 1_000) }));
      ok(a.computed === 3, "第 1 帧 computed=3（dNow 800 > 600+60）", `computed=${a.computed} distNow=${r1(a.distNow)}`);
      ok(a.passedIdx === -1, "第 1 帧**不**前进（computed ≠ prevComputed(-1)）", `passedIdx=${a.passedIdx}`);

      const b = advanceLrt(
        st({ prevPassedIdx: a.passedIdx, prevComputed: a.computed, prevDist: a.distNow, prevTs: a.ts, fix: fixAt(8, 2_000) }),
      );
      ok(b.computed === 3, "第 2 帧 computed 仍 3（与上帧一致）", `computed=${b.computed}`);
      ok(b.passedIdx === 0, "第 2 帧才前进，且只到 0（min(3, -1+1)）", `passedIdx=${b.passedIdx}`);
    },
  },

  /* ── G3b 两帧异值不前进 ── */
  {
    id: "G3b",
    title: "两帧 computed 异值 ⇒ 不前进；第三帧同值才前进",
    run: () => {
      const a = advanceLrt(st({ fix: fixAt(8, 1_000) })); // computed 3
      ok(a.computed === 3 && a.passedIdx === -1, "第 1 帧 computed=3 / 不前进", `computed=${a.computed} passedIdx=${a.passedIdx}`);

      // 顶点 4 = 400m ⇒ computed = max{i: 400 > ladder[i]+60} = 1（异值）
      const b = advanceLrt(
        st({ prevPassedIdx: a.passedIdx, prevComputed: a.computed, prevDist: a.distNow, prevTs: a.ts, fix: fixAt(4, 61_000) }),
      );
      ok(b.computed === 1, "第 2 帧 computed=1（与上帧 3 异值）", `computed=${b.computed}`);
      ok(b.frozen === false, "第 2 帧未被速度门拒（400m/60s ≈ 24km/h）", `frozen=${b.frozen}`);
      ok(b.passedIdx === -1, "第 2 帧**不**前进（异值不采纳）", `passedIdx=${b.passedIdx}`);

      const c = advanceLrt(
        st({ prevPassedIdx: b.passedIdx, prevComputed: b.computed, prevDist: b.distNow, prevTs: b.ts, fix: fixAt(4, 121_000) }),
      );
      ok(c.computed === 1 && c.passedIdx === 0, "第 3 帧同值 ⇒ 前进到 0", `computed=${c.computed} passedIdx=${c.passedIdx}`);
    },
  },

  /* ── G4 单帧最多 +1 站 ── */
  {
    id: "G4",
    title: "单帧最多前进 1 站：跨 3 站跳跃只 +1（连两帧 +2，不是 +3）",
    run: () => {
      // prevComputed 已是 3（模拟「前两帧已看到 computed=3，但 passedIdx 还停在 0」）
      const base = st({ prevPassedIdx: 0, prevComputed: 3, prevDist: 800, prevTs: 1_000 });
      const a = advanceLrt({ ...base, fix: fixAt(8, 2_000) });
      ok(a.computed === 3, "computed=3（可推 3 站）", `computed=${a.computed}`);
      ok(a.passedIdx === 1, "★ 只前进 1 站（实际不是 3）", `passedIdx=${a.passedIdx}`);

      const b = advanceLrt({ ...base, prevPassedIdx: a.passedIdx, prevTs: a.ts, fix: fixAt(8, 3_000) });
      ok(b.passedIdx === 2, "下一帧再 +1（累计 2，仍不是 3）", `passedIdx=${b.passedIdx}`);
    },
  },

  /* ── G5 速度门 ── */
  {
    id: "G5",
    title: "速度门：1s 内位移 600m ⇒ 拒帧；同样位移给 60s ⇒ 放行（正反对照）",
    run: () => {
      const base = st({ prevPassedIdx: 0, prevComputed: 0, prevDist: 200, prevTs: 1_000_000 });
      const fast = advanceLrt({ ...base, fix: fixAt(8, 1_001_000) }); // 600m / 1s = 2160 km/h
      ok(fast.frozen === true, "超速帧 ⇒ frozen=true", `frozen=${fast.frozen}（600m/1s = 2160km/h > 80）`);
      ok(fast.badStreak === 0, "拒帧把 badStreak 归 0（不是累加：这是「丢帧」不是「信号差」）", `badStreak=${fast.badStreak}`);
      ok(fast.passedIdx === 0 && fast.computed === 0, "超速帧不采纳（进度与 computed 都停在上帧）", `passedIdx=${fast.passedIdx} computed=${fast.computed}`);
      ok(Math.abs(fast.distNow - 200) < 0.5, "distNow 保持上帧 200m", `distNow=${r1(fast.distNow)}`);

      const slow = advanceLrt({ ...base, fix: fixAt(8, 1_060_000) }); // 同一位置，给 60s ⇒ 36km/h
      ok(slow.frozen === false, "同样位移给 60s ⇒ 不拒（正对照：门只拦超速）", `frozen=${slow.frozen}（600m/60s = 36km/h）`);
      ok(slow.computed === 3, "正常帧 computed 正常算出 3", `computed=${slow.computed}`);
    },
  },

  /* ── G6a colored 过短 ── */
  {
    id: "G6a",
    title: "buildLrtLadder：colored.length < 2 ⇒ path:[] + ladder 全 NaN + valid 全 false",
    run: () => {
      const ladder = buildLrtLadder([ll(0, 0)], [pt(0, 0), pt(0, 200), pt(0, 400)]);
      ok(ladder.path.length === 0, "path 为空数组（不是入参原样返回）", `path.length=${ladder.path.length}`);
      ok(ladder.ladder.length === 3, "ladder 长度 = 站点数 3", `len=${ladder.ladder.length}`);
      ok(ladder.ladder.every((d) => Number.isNaN(d)), "ladder 全 NaN", ladder.ladder.map((d) => String(d)).join(" / "));
      ok(ladder.valid.every((v) => v === false), "valid 全 false", JSON.stringify(ladder.valid));

      // 端到端：这样的 ladder 进 advanceLrt ⇒ path<2 ⇒ 冻结且 prog 不丢
      const a = advanceLrt(st({ ladder, prevPassedIdx: 0, prevComputed: 0, fix: fixAt(8, 1_000) }));
      ok(a.frozen === true && a.badStreak === 1, "进 advanceLrt ⇒ frozen（path.length<2）", `frozen=${a.frozen} badStreak=${a.badStreak}`);
      ok(a.progress.kind === "between" && a.passedIdx === 0, "且 prog 仍是 between / 保留 passedIdx", `kind=${a.progress.kind} passedIdx=${a.passedIdx}`);
    },
  },

  /* ── G6b 离路径过远 ── */
  {
    id: "G6b",
    title: "站点投影离路径 > LRT_TOL_M(120m) ⇒ 该站被剔除（valid false）",
    run: () => {
      const ladder = buildLrtLadder(PATH, [
        pt(0, 0), // 在路径上
        pt(300, 200), // 横向偏 300m > 120 ⇒ 剔除
        pt(0, 400), // 在路径上
      ]);
      ok(ladder.valid[0] === true && ladder.valid[2] === true, "两侧正常站有效", JSON.stringify(ladder.valid));
      ok(ladder.valid[1] === false, "偏移 300m 的站被剔除", `valid[1]=${ladder.valid[1]}`);
      ok(Number.isNaN(ladder.ladder[1]), "被剔除站的 ladder 保持 NaN（不是 0）", `ladder[1]=${ladder.ladder[1]}`);
      // 边界：恰好 < TOL 的站要保留（防把门写成 >=）
      const near = buildLrtLadder(PATH, [pt(0, 0), pt(LRT_TOL_M - 10, 200)]);
      ok(near.valid[1] === true, `偏移 ${LRT_TOL_M - 10}m（< TOL）⇒ 仍保留（门是 > 不是 ≥）`, `valid[1]=${near.valid[1]}`);
    },
  },

  /* ── G6c 乱序 / 重复 / 缺坐标 ── */
  {
    id: "G6c",
    title: "站点乱序/重复/缺坐标 ⇒ 单调化剔除（不许倒着算里程）",
    run: () => {
      const ladder = buildLrtLadder(PATH, [
        pt(0, 400), // 0 → 400m
        pt(0, 200), // 200m < 400m ⇒ 倒序，剔除
        pt(0, 400), // 重复（d <= prev）⇒ 剔除
        null, // 缺坐标 ⇒ 剔除
        pt(0, 600), // 正常前进
      ]);
      ok(ladder.valid[0] === true && Math.abs(ladder.ladder[0] - 400) < 0.5, "首站有效 = 400m", `valid=${ladder.valid[0]} d=${r1(ladder.ladder[0])}`);
      ok(ladder.valid[1] === false, "倒序站剔除", `valid[1]=${ladder.valid[1]}`);
      ok(ladder.valid[2] === false, "重复站剔除", `valid[2]=${ladder.valid[2]}`);
      ok(ladder.valid[3] === false, "缺坐标站剔除", `valid[3]=${ladder.valid[3]}`);
      ok(ladder.valid[4] === true && Math.abs(ladder.ladder[4] - 600) < 0.5, "后续正常站保留 = 600m", `valid=${ladder.valid[4]} d=${r1(ladder.ladder[4])}`);
    },
  },
];

/* ══════════ 执行 ══════════ */

console.log("\n═══ advanceLrt / buildLrtLadder 对拍 ═══");

/* ★ 铁律 44c-①：用例集合非空（空集合 = 等义于未验证 ⇒ 必须 FAIL 而非 PASS） */
ok(
  CASES.length > 0,
  "★ 44c-① 用例集合非空（0 个 = 等义于未验证）",
  CASES.length > 0 ? `枚举 ${CASES.length} 组` : "✗ 用例表为空 —— 本脚本什么也没验",
);

/* ★ 铁律 44c-②：集合尺寸 == 枚举数 */
ok(
  CASES.length === EXPECTED_CASE_COUNT,
  "★ 44c-② 用例表尺寸 == 枚举数（防悄悄少跑几组还全绿）",
  `实际 ${CASES.length} / 预期 ${EXPECTED_CASE_COUNT}`,
);

let executed = 0;
for (const c of CASES) {
  console.log(`\n【${c.id}】${c.title}`);
  executed++;
  try {
    c.run();
  } catch (e) {
    fail++;
    checks++;
    console.error(`  \x1b[31m✗\x1b[0m ${c.id} 抛异常：${(e as Error).message}`);
  }
}
ok(executed === CASES.length, "★ 44c-② 全部用例均被执行（无提前退出）", `执行 ${executed} / 枚举 ${CASES.length}`);

/**
 * ★ 铁律 44c-③：输出必须写明「实际比对 N / 预期 M」。
 * `EXPECTED_CHECK_COUNT` 是**总断言数（含本条自身）** ⇒ 比较时 `+1`
 * （`ok()` 是先判后自增，本条执行时它自己还没被计入）。
 */
ok(
  checks + 1 === EXPECTED_CHECK_COUNT,
  "★ 44c-③ 断言执行数 == 枚举数（防某条被 if 静默跳过）",
  `实际比对 ${checks + 1} / 预期 ${EXPECTED_CHECK_COUNT}`,
);

console.log(
  `\n────────────────────────────────────────\n通过 ${pass} · 失败 ${fail}\n实际比对 ${checks} / 预期 ${EXPECTED_CHECK_COUNT} · 用例 ${executed} / ${EXPECTED_CASE_COUNT}\n`,
);
if (fail > 0) process.exit(1);
