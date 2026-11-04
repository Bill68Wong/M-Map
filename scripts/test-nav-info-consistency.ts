/**
 * 导航信息行「三数同帧自洽」回归（scripts/test-nav-info-consistency.ts，2026-11-04 新增）
 *
 * ── 这个文件守什么 ─────────────────────────────────────────────────────
 *   信息行（`NavDetailBody` 的两态布局）同帧显示三个数，**锚站刻意不同**：
 *
 *   | 钩子 | 含义 | `at` 锚 | `between` 锚 |
 *   |---|---|---|---|
 *   | `data-stops-away`     | 还有几站下车 | `atIdx`   | `passedIdx`（**含**正在开往的站） |
 *   | `data-nav-remain-min` | 到下车几分钟 | `atIdx`   | `nextIdx`（**不含**那一跳） |
 *   | `data-eta-scope`      | 口径标记     | —         | 上车后 `alight` / 上车前 `board` |
 *
 *   「站数」与「分钟」差 1 是**语义必然**，不是错位：
 *     · 站数问「还要经过几站」⇒ 含正在开往的那一站；
 *     · 分钟问「到那一站还剩多久」⇒ 量到那一站为止，不含那一跳。
 *   ⇒ **本文件存在的唯一目的**：将来有人想「统一成一个 pivot」时立刻红。
 *     本批已真实发生过一次（`lastIdx − remainFromIdxOf` 在行驶末段少算 1 站，
 *     会写出「还有 0 站下车」+ 底栏「即将到达」同屏）。
 *
 * ── 纪律（照 `test-remaining-view.ts` 的三分法）────────────────────────
 *   · **只用真实 `progressOf` 产物**喂入，**不手搓 `TrackProgress`** ——
 *     手搓对象测不出真实状态机的边界（本项目已因此错过一次）。
 *   · 「守护型」断言必须配**变异自检**（证明造错能检出），否则可能是恒绿。
 *   · `alarm` 判据在引擎里是**内联表达式**（无导出函数）⇒ 本文件只能**复刻**，
 *     故另用源码字符串锁住复刻（§5），防止复刻与线上漂移。
 *
 * ── 跑法 ──────────────────────────────────────────────────────────────
 *   npx tsx scripts/test-nav-info-consistency.ts
 */
import { readFileSync } from "node:fs";
import {
  progressOf,
  remainFromIdxOf,
  segRemainSecOf,
  stopsAwayOf,
  type TrackProgress,
  type TrackVehicle,
} from "../src/lib/nav/track";
import { legRemainMinOf } from "../src/lib/nav/remaining-view";
import { CAND_STRONG_MAX_M, candAtStopOf } from "../src/lib/nav/boarding-detect";
import { candViewOf } from "../src/components/nav/cand-view";
import { VEH_STALE_SEC } from "../src/components/nav/observe-hooks";

let failed = 0;
const ok = (cond: boolean, name: string, detail = ""): void => {
  if (cond) console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};

/* ══════════════════════════════════════════════════════════════════════
   夹具：本段站序 4 站 + 逐跳分钟（**刻意取三个互不相等的值**）
   ──────────────────────────────────────────────────────────────────────
   若逐跳值都相等（如全 3 分），「算错跳数」会恰好得到同一个和 ⇒ 漏判。
   本批踩过的坑正是"少算一跳/多算一跳"，必须让每一跳可区分。
   ══════════════════════════════════════════════════════════════════════ */
const MAINS = ["M100", "M200", "M300", "M400"];
const LAST = MAINS.length - 1; // 3
const HOP = [3, 4, 5, 0]; // 末站无 minToNext
const LEG_MIN = HOP[0] + HOP[1] + HOP[2]; // 12

/**
 * 站条节点（`StripStop` 的两列：`code` + `label`）。
 * `label` 刻意写成「站号 + 空格 + 站名」——这正是服务端 `buildStrips` 给巴士段的形状
 * （`types.ts` 里 `label` 注释：`C653 金峰南岸/金譽峰`），`splitStopLabel()` 就是按它拆的。
 */
const STOPS = MAINS.map((code, k) => ({ code, name: `測試站${k + 1}` }));

/** 按真实 `TrackVehicle` 形状造帧（再由**真实** `progressOf` 产出进度） */
const veh = (patch: Partial<TrackVehicle>): TrackVehicle => ({
  plate: "MZ-00-00",
  lat: 22.2,
  lng: 113.5,
  status: "moving",
  interval: null,
  atStation: null,
  ...patch,
});
const atVeh = (code: string) => veh({ status: "stopping", atStation: { code } });
const runVeh = (from: string, to: string) =>
  veh({ status: "moving", interval: { from: { code: from }, to: { code: to } } });

/**
 * 复刻信息行的三数派生 —— 与产品代码**逐条对应的真实接线**：
 *   `stopsAway` ← `stopsAwayOf(prog, lastIdx)`
 *   `pivotIdx`  ← `remainFromIdxOf(prog)`
 *   `min`       ← `legRemainMinOf({ segRemainSec, pivotIdx, minToNext, legMinutes })`
 *   `shown`     ← 地板 `Math.max(1, round(min))`（写「约 0 分」会与到站提醒抢语义）
 *   `alarm`     ← 引擎内联式（§6 用源码字符串锁住复刻）
 *   `missed` / `sub` ← 次行文案分支（见下）
 *
 * ── 「已过站」与「已到站」：**同值不同义**，这是本文件守住的最重要一对 ──
 *   两者都 `stopsAway === 0`，但 `alarm` 相反（`none` vs `now`），文案必须相反：
 *     · `now`  ⇒「本站下车」（到了）
 *     · `none` ⇒「已过站 / 请在下一站下车」（坐过站了）
 *   若判据漏掉 `alarm`，会把**正常到站**说成坐过站 —— 比原来的「还有 0 站」更严重的错。
 *   §5 的变异断言专门证明这条能检出。
 *
 * @param rawSegSec 组件**实际看到的** `track.segProgress?.segRemainSec`：
 *   停靠帧必为 `null`（车辆无 `progress` ⇒ `useRideTracking` 置 `segProgress=null`），
 *   行驶帧取决于有没有位置模型 —— 这正是"前端两档 / 服务端一档"的分叉点。
 */
const deriveRow = (p: TrackProgress | null, rawSegSec: number | null, legIdx = 0, rideCount = 2) => {
  const stopsAway = stopsAwayOf(p, LAST);
  const pivotIdx = remainFromIdxOf(p);
  const min = legRemainMinOf({
    segRemainSec: rawSegSec,
    pivotIdx,
    minToNext: HOP,
    legMinutes: LEG_MIN,
  });
  const shown = Math.max(1, Math.round(min));
  const alarm = !p
    ? "none"
    : p.atIdx === LAST
      ? "now"
      : p.nextIdx === LAST
        ? "soon"
        : "none";
  /**
   * 次行文案分支（复刻 `NavDetailBody.postSub` 的分支顺序，**顺序本身就是契约**）：
   *   missed → 已过站 → 已到站(now) → 「还有 n 站下车 · 约 x 分」
   * 次行两档按「本行程是否还有后续程」分：`legIdx < rides.length - 1` ⇒ 要换乘。
   */
  const missed = stopsAway === 0 && alarm === "none";
  const hasNextLeg = legIdx < rideCount - 1;
  const sub = missed
    ? hasNextLeg
      ? "请在下一站下车"
      : "请下车"
    : alarm === "now"
      ? "本站下车"
      : [
          stopsAway != null ? `还有 ${stopsAway} 站下车` : "",
          shown != null ? `约 ${shown} 分` : "",
        ]
          .filter(Boolean)
          .join(" · ") || null;
  /**
   * 主行（`NavDetailBody.postStation`）：已过站时**前缀翻转、站号站名仍是被错过的那一站**。
   * 设计定稿要求「过站前后同一组站号站名逐字不变」⇒ 这里用下车站（`lastIdx`），
   * 而非 `watchIdx`（过站时 `nextIdx === null`，取不到）。
   */
  const main = missed
    ? { prefix: "已过站", code: STOPS[LAST].code, name: STOPS[LAST].name, prefixTone: "fg2" as const }
    : null;
  return {
    stopsAway,
    pivotIdx,
    min,
    shown,
    alarm,
    missed,
    sub,
    main,
    /** `data-nav-missed` 的实际输出（`"1"` 或 `undefined`＝属性不输出） */
    missedAttr: missed ? ("1" as const) : undefined,
    kind: p?.kind ?? null,
    passedIdx: p?.passedIdx ?? -1,
  };
};

/* ══════════════════════════════════════════════════════════════════════
   ① 前置：确认真实产物形状（这步不通过，后面整张表都不可信）
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ① 前置：真实 progressOf 产物形状 ──");

const P_AT_BOARD = progressOf(MAINS, atVeh("M100/1")); // 带站台后缀 ⇒ 顺带验证 mainOf 归一
const P_AT_MID1 = progressOf(MAINS, atVeh("M200"));
const P_AT_MID2 = progressOf(MAINS, atVeh("M300"));
const P_AT_ALIGHT = progressOf(MAINS, atVeh("M400"));
const P_RUN_FIRST = progressOf(MAINS, runVeh("M100", "M200"));
const P_RUN_LAST = progressOf(MAINS, runVeh("M300", "M400"));
const P_RUN_PAST = progressOf(MAINS, runVeh("M400", "M500")); // 车已从本段下车站开走
const P_LOST = progressOf(MAINS, null);
const P_UNKNOWN = progressOf(MAINS, atVeh("Z999")); // 站码不在本段站序

ok(
  P_AT_BOARD.kind === "at" && P_AT_BOARD.atIdx === 0 && P_AT_BOARD.passedIdx === -1,
  "停靠上车站：at / atIdx=0 / passedIdx=-1（站台后缀 M100/1 已由 mainOf 归一）",
  `kind=${P_AT_BOARD.kind} atIdx=${String(P_AT_BOARD.atIdx)} passedIdx=${P_AT_BOARD.passedIdx}`,
);
ok(
  P_AT_MID1.kind === "at" && P_AT_MID1.atIdx === 1 && P_AT_MID1.passedIdx === 0,
  "停靠中间站：at / atIdx=1 / passedIdx=0（**停靠态 passedIdx = atIdx − 1**，这是旧 off-by-one 的成因）",
  `atIdx=${String(P_AT_MID1.atIdx)} passedIdx=${P_AT_MID1.passedIdx}`,
);
ok(
  P_RUN_LAST.kind === "between" && P_RUN_LAST.passedIdx === 2 && P_RUN_LAST.nextIdx === 3,
  "行驶末段 M300→M400：between / passedIdx=2 / nextIdx=3",
  `passedIdx=${P_RUN_LAST.passedIdx} nextIdx=${String(P_RUN_LAST.nextIdx)}`,
);
ok(
  P_RUN_PAST.kind === "between" && P_RUN_PAST.passedIdx === 3 && P_RUN_PAST.nextIdx === null,
  "**错过站** M400→M500：between / passedIdx=lastIdx / nextIdx=**null**（下一站在本段站序之外）",
  `passedIdx=${P_RUN_PAST.passedIdx} nextIdx=${String(P_RUN_PAST.nextIdx)}`,
);
ok(P_UNKNOWN.kind === "unknown", "站序外的站码 ⇒ unknown（不猜「在起点站」）", P_UNKNOWN.kind);
ok(P_LOST.kind === "lost", "无车辆帧 ⇒ lost", P_LOST.kind);

/* ══════════════════════════════════════════════════════════════════════
   ② 四态 × 边界：逐格钉死「站数 / 分钟 / alarm」的期望值
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ② 四态 × 边界（期望值逐格钉死）──");
{
  // [名称, 进度, 组件看到的 segRemainSec, 期望站数, 期望分钟, 期望 alarm]
  const CASES: Array<[string, TrackProgress | null, number | null, number | null, number, string]> = [
    ["停靠上车站", P_AT_BOARD, null, 3, 12, "none"],
    ["停靠中间站 1", P_AT_MID1, null, 2, 9, "none"],
    ["停靠中间站 2（下车站前一站）", P_AT_MID2, null, 1, 5, "soon"],
    ["停靠下车站", P_AT_ALIGHT, null, 0, 0, "now"],
    ["行驶第一段 M100→M200（无位置模型）", P_RUN_FIRST, null, 3, 9, "none"],
    ["行驶末段 M300→M400（无位置模型）", P_RUN_LAST, null, 1, 0, "soon"],
    ["行驶第一段 + 位置模型剩 120s", P_RUN_FIRST, 120, 3, 11, "none"],
    ["错过站（车已从下车站开走）", P_RUN_PAST, null, 0, 0, "none"],
    ["丢信号（lost）", P_LOST, null, null, 12, "none"],
    ["站序对不上（unknown）", P_UNKNOWN, null, null, 12, "none"],
    ["进度未就绪（prog=null）", null, null, null, 12, "none"],
  ];

  for (const [name, p, rawSeg, wantAway, wantMin, wantAlarm] of CASES) {
    const d = deriveRow(p, rawSeg);
    ok(d.stopsAway === wantAway, `${name}：还有几站 = ${String(wantAway)}`, `实际 ${String(d.stopsAway)}`);
    ok(Math.abs(d.min - wantMin) < 1e-9, `${name}：到下车分钟 = ${wantMin}`, `实际 ${d.min}`);
    ok(d.alarm === wantAlarm, `${name}：alarm = ${wantAlarm}`, `实际 ${d.alarm}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   ③ 跨态不变量（本文件的核心价值）
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ③ 跨态不变量（同帧不得自相矛盾）──");
{
  const rows = [
    ["停靠上车站", P_AT_BOARD, null],
    ["停靠中间站 1", P_AT_MID1, null],
    ["停靠中间站 2", P_AT_MID2, null],
    ["停靠下车站", P_AT_ALIGHT, null],
    ["行驶第一段", P_RUN_FIRST, null],
    ["行驶末段", P_RUN_LAST, null],
    ["错过站", P_RUN_PAST, null],
  ].map(([name, p, rawSeg]) => ({
    name: name as string,
    d: deriveRow(p as TrackProgress, rawSeg as number | null),
  }));

  /**
   * 不变量 1（**已按实测修正**）：「还有 0 站」有**两个**合法状态，不是一个。
   *   a) 已到下车站（`at` 停在 `lastIdx`）⇒ `alarm = "now"`；
   *   b) 已过下车站（`between` 且 `passedIdx = lastIdx`，`nextIdx = null`）⇒ `alarm = "none"`，
   *      即用户**错过站**、车正在驶离 —— 这帧确实会渲染「还有 0 站下车」。
   *      旧公式 `lastIdx − passedIdx` 在该状态下同样给 0，**不是本轮引入的回归**。
   * ⇒ 真正要禁的是第三种：`stopsAway === 0 && alarm === "none" && 未过站`。
   */
  const zeroRows = rows.filter(({ d }) => d.stopsAway === 0);
  ok(
    zeroRows.every(
      ({ d }) => d.alarm === "now" || (d.kind === "between" && d.passedIdx >= LAST),
    ),
    "不变量 1：「还有 0 站」只有两个合法状态 —— 已到站(now) / 已过站(between 且 passedIdx≥lastIdx)",
    zeroRows.map((r) => `${r.name}[alarm=${r.d.alarm},passed=${r.d.passedIdx}]`).join(" "),
  );
  ok(
    rows.every(({ d }) => !(d.stopsAway === 0 && d.alarm === "none" && d.passedIdx < LAST)),
    "不变量 1b：禁止 `0 站 + alarm=none + 未过站`（那是真缺陷：明明还有站却写 0）",
    rows
      .filter(({ d }) => d.stopsAway === 0 && d.alarm === "none" && d.passedIdx < LAST)
      .map((r) => r.name)
      .join(","),
  );

  /**
   * 不变量 2（**命题方向已修正**）：`alarm === "soon"` ⟺ `stopsAway === 1`。
   *
   * ⚠️ 派工单原写「`stopsAway >= 1` 时 `alarm` 不得是 `soon`」——**该命题不成立，本文件不实现它**：
   *   `句` 行驶末段 M300→M400（下车站 = M400）时站数 = 1、`alarm = "soon"`，
   *   这与底栏「即将到达」是**同一件事的两种说法**（还有 1 站 = 马上到）。
   *   若按原命题断言，会把**正确行为**判红。
   *   真正要禁的是「还有 2 站」+「即将到达」同屏 ⇒ 写成「soon ⇒ 站数必须恰为 1」。
   */
  ok(
    rows.filter(({ d }) => d.alarm === "soon").every(({ d }) => d.stopsAway === 1),
    "不变量 2：alarm=soon ⇒ 站数恰为 1（禁「还有 2 站 + 即将到达」同屏）",
    rows
      .filter(({ d }) => d.alarm === "soon" && d.stopsAway !== 1)
      .map((r) => `${r.name}(away=${String(r.d.stopsAway)})`)
      .join(","),
  );

  /** 不变量 3：站数取值集合受限（null / ≥1 / 0 且属于上面两个合法状态之一） */
  ok(
    rows.every(({ d }) => d.stopsAway === null || d.stopsAway >= 1 || d.alarm === "now" || d.passedIdx >= LAST),
    "不变量 3：站数 ∈ {null} ∪ {≥1} ∪ {0 且(已到站 或 已过站)}",
  );

  /** 不变量 4：无位置模型时分钟必须落在 [0, 整段静态分钟]（不出现负数 / 超过整段） */
  ok(
    rows.every(({ d }) => d.min >= 0 && d.min <= LEG_MIN + 1e-9),
    "不变量 4：无位置模型时 0 ≤ 到下车分钟 ≤ 整段静态分钟（12）",
    rows.filter(({ d }) => d.min < 0 || d.min > LEG_MIN).map((r) => `${r.name}=${r.d.min}`).join(","),
  );

  /** 不变量 5：行驶态的分钟**不含**正在开往那一跳的整跳（`seg` 缺失时退化为「基准站→末站」） */
  ok(
    deriveRow(P_RUN_LAST, null).min === 0 && deriveRow(P_RUN_FIRST, null).min === HOP[1] + HOP[2],
    "不变量 5：行驶态从区间终点站起算（无位置模型 ⇒ 基准站→末站的逐跳和）",
    `末段 ${deriveRow(P_RUN_LAST, null).min} / 第一段 ${deriveRow(P_RUN_FIRST, null).min}`,
  );
}

/* ══════════════════════════════════════════════════════════════════════
   ④ 停靠态口径（U3）与两路同值
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ④ 停靠态口径（U3）：分钟从「所停站」起算，两路同值 ──");
{
  /**
   * 不变量 6：停靠 M300（idx 2）⇒ 分钟 = HOP[2] = 5，**含**「M300→M400」这一跳。
   * 若从 `nextIdx`(3) 起算 ⇒ 0 ⇒ 整跳少算 5 分（这就是 U3 修的"进站瞬间数字掉一截"）。
   */
  const right = deriveRow(P_AT_MID2, null).min;
  const wrong = legRemainMinOf({ segRemainSec: 0, pivotIdx: P_AT_MID2.nextIdx, minToNext: HOP, legMinutes: LEG_MIN });
  ok(
    right === HOP[2] && wrong === 0,
    "不变量 6（U3）：停靠态从所停站起算（含所停站→下一站）；从 nextIdx 起算会整跳少算",
    `正确 ${right} / 错误 ${wrong}`,
  );

  /**
   * 不变量 7：**前端 / 服务端两条路径必须同值** ——
   *   前端组件看到 `segProgress = null`（车无 `progress`）；
   *   服务端拿到 `segRemainSecOf(stoppedAtStation=true, x) = 0`。
   * 二者喂进同一个 `legRemainMinOf` 必须得到同一个数，否则顶部与信息行会打架。
   */
  ok(
    legRemainMinOf({ segRemainSec: null, pivotIdx: 2, minToNext: HOP, legMinutes: LEG_MIN }) ===
      legRemainMinOf({
        segRemainSec: segRemainSecOf(true, 999),
        pivotIdx: 2,
        minToNext: HOP,
        legMinutes: LEG_MIN,
      }),
    "不变量 7：停靠态「seg 缺失(前端)」与「seg 显式 0(服务端)」同值",
  );

  /** 不变量 8：进度不可用（lost / unknown / null）⇒ 不猜位置：站数 null、分钟回落整段（偏长） */
  ok(
    [deriveRow(P_LOST, null), deriveRow(P_UNKNOWN, null), deriveRow(null, null)].every(
      ({ stopsAway, shown }) => stopsAway === null && shown === LEG_MIN,
    ),
    "不变量 8：lost / unknown / prog=null ⇒ 站数 null + 分钟回落整段（不猜「在起点站」）",
  );

  /** 边界：单站卡（站序 1 个）—— 站数必须 null（不写「还有 0 站」），进度仍是 at */
  const single = ["M100"];
  const p1 = progressOf(single, atVeh("M100"));
  ok(
    stopsAwayOf(p1, single.length - 1) === null && p1.kind === "at" && p1.atIdx === 0,
    "边界：单站卡（站序 <2）⇒ 站数 null、进度仍 at（不崩、不写 0 站）",
    `away=${String(stopsAwayOf(p1, single.length - 1))} atIdx=${String(p1.atIdx)}`,
  );
}

/* ══════════════════════════════════════════════════════════════════════
   ④b 「已过站」文案与三义真相表（`stopsAway===0` 的三种语义）
   ──────────────────────────────────────────────────────────────────────
   三行**共用 `stopsAway === 0` 这一个值**，语义完全不同：
     | stops-away | alarm | nav-missed | 语义 |
     |---|---|---|---|
     | 0 | now  | 不存在 | 已到站（车停在下车站） |
     | 0 | soon | 不存在 | 即将到站（正开往下车站区间内） |
     | 0 | none | `"1"`  | 已过站（坐过站了） |
   漏掉 `alarm` 条件 ⇒ 把「到了，请下车」错说成「已过站」，比原来的「还有 0 站」更严重。
   ⚠️ 同时守一条硬约束：**只换文案，不换数值** ——
     `data-stops-away` 仍为 `0`、`data-nav-remain-min` 仍按原表达式有值。
     钩子是给机器验的、文案是给人看的；混改会让一批验「数值口径」的断言集体失配。
   ⚠️ 另守一条设计定稿理由：四种前缀**等宽（3 全角）** ⇒ 过站前后零水平重排。
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ④b 「已过站」文案 + 三义真相表（只换文案，数值钩子不动）──");
{
  const missed = deriveRow(P_RUN_PAST, null); // 车已从下车站开走（本段非最后一程 ⇒ 要换乘）
  const missedLast = deriveRow(P_RUN_PAST, null, 1, 2); // 同上，但本段是最后一程
  const arrived = deriveRow(P_AT_ALIGHT, null); // 正常到站（车停在下车站）
  const soonRow = deriveRow(P_AT_MID2, null); // 即将到达（还有 1 站，下车站=下一站）
  const midRide = deriveRow(P_AT_MID2, null); // 同上，文案断言复用

  ok(
    missed.stopsAway === 0 && missed.alarm === "none",
    "前置：错过站态 = 站数 0 且 alarm=none",
    `away=${String(missed.stopsAway)} alarm=${missed.alarm}`,
  );

  /* ── 三义真相表：`data-nav-missed` 只在第三行出现 ── */
  ok(
    arrived.alarm === "now" && arrived.stopsAway === 0 && arrived.missedAttr === undefined,
    "三义表·已到站：stops-away=0 + alarm=now ⇒ **无** data-nav-missed",
    String(arrived.missedAttr),
  );
  ok(
    soonRow.alarm === "soon" && soonRow.stopsAway === 1 && soonRow.missedAttr === undefined,
    "三义表·即将到达（还有 1 站）⇒ 站数 1、**无** data-nav-missed",
    `away=${String(soonRow.stopsAway)} attr=${String(soonRow.missedAttr)}`,
  );
  ok(
    missed.missedAttr === "1",
    "三义表·已过站：stops-away=0 + alarm=none ⇒ data-nav-missed=\"1\"",
    String(missed.missedAttr),
  );
  ok(
    new Set([arrived, missed]).size === 2 &&
      [arrived, missed].every((r) => r.stopsAway === 0) &&
      arrived.missedAttr !== missed.missedAttr,
    "三义表·**同值不同义**：两态 stops-away 都是 0，但 data-nav-missed 必须一个是 undefined、一个是 \"1\"",
  );

  /* ── 主行：前缀翻转，站号站名逐字不变 ── */
  ok(
    missed.main?.prefix === "已过站" &&
      missed.main?.code === STOPS[LAST].code &&
      missed.main?.name === STOPS[LAST].name,
    "主行 = 「已过站 + 下车站站号 + 下车站站名」（取 lastIdx，不取 nextIdx —— 过站时 nextIdx 为 null）",
    `${String(missed.main?.prefix)} ${String(missed.main?.code)} ${String(missed.main?.name)}`,
  );
  ok(missed.main?.prefixTone === "fg2", "主行前缀色提一档（--muted → --fg-2）");
  /**
   * 设计定稿的核心理由：四种前缀等宽 ⇒ 前缀槽宽度恒定 ⇒ 站名零水平重排。
   * 这条是**可机验**的（字数），且一旦有人把「已过站」改成「已过站了」就会红 —— 值得守。
   */
  {
    const prefixes = ["已过站", "下一站", "已到站", "下车站"];
    ok(
      prefixes.every((s) => [...s].length === 3),
      "设计定稿：四种前缀同为 3 全角 ⇒ 前缀槽等宽、过站前后站名零水平重排",
      prefixes.map((s) => `${s}(${[...s].length})`).join(" "),
    );
  }

  /* ── 次行两档：还有后续程 / 本段即最后一程 ── */
  ok(
    missed.missed === true && missed.sub === "请在下一站下车",
    "错过站·还有后续程 ⇒ 次行「请在下一站下车」",
    String(missed.sub),
  );
  ok(
    missedLast.sub === "请下车",
    "错过站·本段是最后一程（下车站即终点）⇒ 次行「请下车」（不写「请在下一站下车」以免让人以为还要再坐一段）",
    String(missedLast.sub),
  );
  ok(
    !/还有\s*\d+\s*站/.test(String(missed.sub)) && !/\d+\s*分/.test(String(missed.sub)),
    "错过站次行**不含**「还有 n 站」句式、**不含**分钟子句（是不渲染，不是隐藏）",
    String(missed.sub),
  );

  /** 正常到站：文案必须是「本站下车」，不能被「已过站」抢走 */
  ok(
    arrived.missed === false && arrived.sub === "本站下车",
    "正常到站（alarm=now）⇒ 仍走「本站下车」，**不得**被已过站抢走",
    String(arrived.sub),
  );
  /** 正常行驶：仍保留站数与分钟两个子句 */
  ok(
    midRide.missed === false && /还有 1 站下车/.test(String(midRide.sub)) && /约 5 分/.test(String(midRide.sub)),
    "正常行驶（还有 1 站）⇒ 文案仍为「还有 1 站下车 · 约 5 分」",
    String(midRide.sub),
  );

  /**
   * 硬约束：改文案**不得**顺手改数值 —— 三个钩子的取值来源必须与改前逐字节一致。
   * 错过站态：`data-stops-away` 仍是 `0`（不是 null/负数/新值）、`data-nav-remain-min` 仍有值。
   */
  ok(
    missed.stopsAway === 0 && missed.shown != null && missed.shown === Math.max(1, Math.round(missed.min)),
    "错过站态：data-stops-away 仍为 0、data-nav-remain-min 仍按原表达式有值（文案改动没改坏数值）",
    `away=${missed.stopsAway} remain=${String(missed.shown)}`,
  );
}

/* ══════════════════════════════════════════════════════════════════════
   ⑤ 变异自检：证明上面的不变量真能检出造错
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ⑤ 变异自检（不变量与文案判据必须能检出造错）──");
{
  /** 错误实现：站数复用「分钟」的基准站（`remainFromIdxOf`） */
  const unified = (p: TrackProgress) => LAST - (remainFromIdxOf(p) ?? 0);

  ok(
    unified(P_AT_MID2) === stopsAwayOf(P_AT_MID2, LAST),
    "[变异] 「统一 pivot」在**停靠态恰好正确** ⇒ 所以它看起来诱人（这一步不红才算变异有效）",
    `统一 ${unified(P_AT_MID2)} / 正确 ${String(stopsAwayOf(P_AT_MID2, LAST))}`,
  );
  ok(
    unified(P_RUN_LAST) === 0 && stopsAwayOf(P_RUN_LAST, LAST) === 1 && deriveRow(P_RUN_LAST, null).alarm === "soon",
    "[变异] 但它在**行驶末段少算 1 站** ⇒ 会写出「还有 0 站下车」+「即将到达」同屏（本批真实踩过的坑）",
    `统一 ${unified(P_RUN_LAST)} / 正确 ${String(stopsAwayOf(P_RUN_LAST, LAST))}`,
  );

  /**
   * 变异 2：错误实现「进度不可用时写 0 而不是 `null`」（最现实的写法：`?? 0`）。
   * 它会造出 `stopsAway === 0 && alarm === "none" && 未过站` —— 正是不变量 1b 要禁的组合。
   *
   * ⚠️ 实测记录（别改成"锚站错位"那类变异，它造不出这个组合）：
   *   本文件试过 `LAST − (atIdx + 1)`、`LAST − (passedIdx + 1)`、`LAST − remainFromIdxOf`
   *   三种锚站错位，**都得不出 `0 + none + 未过站`** —— 因为「站数 = 0」⟺「锚站 = lastIdx」，
   *   而锚站取自 `atIdx` / `nextIdx` 时，锚站 = lastIdx 恰好就是 `alarm` 读的那两个字段 ⇒
   *   `alarm` 必然是 `now` 或 `soon`。⇒ 这类错位只会造成「±1 站」（由不变量 2 / 变异 1 抓），
   *   不会造成「假 0 站」。假 0 站的唯一现实来源是**把"不知道"当成 0**。
   */
  const sloppy = (p: TrackProgress | null) => stopsAwayOf(p, LAST) ?? 0;
  const lostAway = sloppy(P_LOST);
  ok(
    lostAway === 0 && deriveRow(P_LOST, null).alarm === "none" && P_LOST.passedIdx < LAST,
    "[变异] 把「不知道」写成 0（`?? 0`）⇒ 造出「0 站 + alarm=none + 未过站」⇒ 不变量 1b 可检出",
    `错值 ${lostAway}`,
  );

  /**
   * 变异 3（本轮新增，最重要）：把「已过站」判据里的 `alarm === "none"` 漏掉
   * ⇒ **正常到站也会被说成坐过站**。
   *
   * 为什么这条必须存在：`已到站`（`alarm="now"`）与 `已过站`（`alarm="none"`）
   * 共用 `stopsAway === 0` 这**一个值**，语义却完全相反。只看站数就套「已过站」，
   * 会把「到了，请下车」错说成「你坐过站了」——比原来的「还有 0 站」更严重的错，
   * 且用户会据此不下车。这类"同值不同义"是本项目反复踩的坑，故用变异钉死。
   */
  const missedWithoutAlarm = (away: number | null) => away === 0;
  ok(
    missedWithoutAlarm(deriveRow(P_AT_ALIGHT, null).stopsAway) === true &&
      deriveRow(P_AT_ALIGHT, null).alarm === "now",
    "[变异] 漏掉 `alarm === \"none\"` ⇒ 正常到站(alarm=now)也会被判成已过站 ⇒ 文案断言可检出",
    `正常到站 away=${String(deriveRow(P_AT_ALIGHT, null).stopsAway)} alarm=${deriveRow(P_AT_ALIGHT, null).alarm}`,
  );
  ok(
    deriveRow(P_AT_ALIGHT, null).missed === false &&
      deriveRow(P_AT_ALIGHT, null).sub === "本站下车" &&
      deriveRow(P_RUN_PAST, null).missed === true,
    "[变异] 正确判据下两态分开：到站 → missed=false（本站下车）/ 过站 → missed=true",
  );
}

/* ══════════════════════════════════════════════════════════════════════
   ⑥ 接线与「复刻锁定」（源码字符串）
   ──────────────────────────────────────────────────────────────────────
   两个目的：
     1. 防组件侧把口径改回去（例如又用 `lastIdx − passedIdx`、或 board 态带上分钟）；
     2. 防**本文件的复刻**与线上实现漂移 —— `alarm` 是引擎内联表达式、没有导出函数，
        只能复刻，故用源码字符串把它钉住。
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ⑥ 接线与复刻锁定（源码字符串）──");
{
  const navDetail = readFileSync("src/components/nav/NavDetailBody.tsx", "utf8");
  const rideEngine = readFileSync("src/components/nav/useRideTracking.ts", "utf8");

  ok(
    navDetail.includes("stopsAwayOf(track?.prog ?? null, trackStops.length - 1)"),
    "接线：站数来自 stopsAwayOf（不是 lastIdx − passedIdx）",
  );
  ok(
    navDetail.includes("remainFromIdxOf(track?.prog ?? null)"),
    "接线：分钟基准站来自 remainFromIdxOf",
  );
  ok(navDetail.includes("legRemainMinOf({"), "接线：分钟走 legRemainMinOf（与服务端同式）");
  ok(
    navDetail.includes('data-eta-scope={mode === "post" ? "alight" : "board"}'),
    "接线：scope 只有 alight / board 两值",
  );
  {
    /**
     * `scope === "board"` 时 `data-nav-remain-min` **必须不存在**：
     * 上车前的分钟是「车到**本站**」，与「到下车」不是同一个量，混用就是假口径。
     * 实现方式：`pre` 分支传 `remainMin={null}` ⇒ 属性整个不输出。
     */
    const preIdx = navDetail.indexOf('mode="pre"');
    const preNullIdx = navDetail.indexOf("remainMin={null}");
    const postIdx = navDetail.indexOf('mode="post"');
    const postValIdx = navDetail.indexOf("remainMin={shownAlightMin}");
    ok(
      preIdx >= 0 && preNullIdx > preIdx && postIdx > preNullIdx && postValIdx > postIdx,
      "接线：board 态传 remainMin={null}（属性不输出）/ post 态传真实值",
      `pre@${preIdx} preNull@${preNullIdx} post@${postIdx} postVal@${postValIdx}`,
    );
  }
  ok(
    navDetail.includes('if (track?.alarm === "now") return "本站下车";'),
    "接线：alarm=now 时次行提前返回「本站下车」，不会落到「还有 0 站」分支",
  );
  ok(
    rideEngine.includes('prog.atIdx === alightIdx ? "now" : prog.nextIdx === alightIdx ? "soon" : "none"'),
    "复刻锁定：alarm 判据与引擎内联表达式逐字一致（改了那里必须同步本脚本）",
  );

  /**
   * 「已过站」文案的接线锁定（2026-11-04 设计定稿）：
   *   ① 文案抽成常量（设计侧改词只改一处，不在 JSX 里散写）；
   *   ② 判据**必须**同时含 `stopsAway === 0` 与 `alarm === "none"`（漏后者会把到站说过站）；
   *   ③ `alarm === "now"` 的「本站下车」分支必须仍在（否则正常到站失去文案）；
   *   ④ 主行**必须带**下车站的站号站名（设计定稿：过站前后站号站名逐字不变、只有前缀翻转）。
   */
  ok(
    navDetail.includes('const MISSED_STOP_PREFIX = "已过站"') &&
      navDetail.includes('const MISSED_STOP_SUB_TRANSFER = "请在下一站下车"') &&
      navDetail.includes('const MISSED_STOP_SUB_ARRIVE = "请下车"'),
    "接线：已过站三段文案抽成常量（设计侧改词只改一处）",
  );
  ok(
    /const missedStop = infoMode === "post" && stopsAway === 0 && track\?\.alarm === "none";/.test(navDetail),
    "接线：已过站判据 = post 且 stopsAway===0 且 alarm===\"none\"（三个条件缺一不可）",
  );
  ok(
    navDetail.includes("if (missedStop) {") &&
      navDetail.indexOf("if (missedStop) {") < navDetail.indexOf('if (track?.alarm === "now") return "本站下车";'),
    "接线：次行分支顺序 = 已过站 在 已到站 之前（顺序即契约，到站不得被过站抢占）",
  );
  ok(
    navDetail.includes("const alight = trackStops.length ? splitStopLabel(trackStops[trackStops.length - 1]) : null;") &&
      navDetail.includes("{ prefix: MISSED_STOP_PREFIX, ...alight, prefixTone: \"fg2\" }"),
    "接线：已过站主行带下车站站号站名 + 前缀色提一档（取 lastIdx，非 nextIdx）",
  );
  ok(
    navDetail.includes("data-nav-missed={missed ? \"1\" : undefined}"),
    "接线：data-nav-missed 仅在已过站输出 \"1\"，其余不输出（undefined，不是 \"\" 也不是 \"0\"）",
  );
  ok(
    /legIdx < card\.rides\.length - 1 \? MISSED_STOP_SUB_TRANSFER : MISSED_STOP_SUB_ARRIVE/.test(navDetail),
    "接线：次行两档 = 还有后续程 ⇒ 请在下一站下车 / 最后一程 ⇒ 请下车",
  );

  /**
   * ★ 事故防线（2026-11-04 实际发生过一次，必须机械拦截）：
   *   `df1409d` 把另一路正在做的**变异版**判据一起提交进了仓库 ——
   *   `const missedStop = infoMode === "post" && stopsAway === 0; // MUTATION: 漏掉 alarm 条件`
   *   ⇒ 正常到站（`alarm="now"`）会被说成「已过站」。
   *   成因：两方同时改同一文件 + 一方在文件上做"改坏→跑→改回"的变异实测 + 整文件 `git add`。
   *
   *   下面两条是**零成本的机械防线**：
   *   ① 源码里**不得出现 `MUTATION` 字样** —— 变异代码的标记必须被看见（它在 diff 里是明文）；
   *   ② 判据行必须**同时**含两个条件 —— 单独一条正则锁不住"少了一个 &&"，因为
   *      `&& stopsAway === 0;` 也能被宽正则放过，故拆成「含 stopsAway 条件」+「含 alarm 条件」两条分别断言。
   *
   *   ⚠️ 为什么不靠行为断言兜住：`deriveRow()` 是**本文件的复刻**，它自己写着正确的判据
   *   ⇒ 组件里判据被改坏时，行为断言**仍然全绿**（测的是复刻，不是组件）。这也是本事故能溜过
   *   81 条断言的原因。行为断言与源码形状锁**必须成对**存在。
   */
  ok(
    !navDetail.includes("MUTATION") && !rideEngine.includes("MUTATION"),
    "防线①：源码不得留 `MUTATION` 字样（变异实测的「改坏」必须改回再提交）",
    navDetail.includes("MUTATION") ? "NavDetailBody 命中" : rideEngine.includes("MUTATION") ? "useRideTracking 命中" : "",
  );
  {
    /** 取出判据那一行（只取首个 `const missedStop =` 那句，避免误命中注释里引用的同名字符串） */
    const judgeLine = /const missedStop = [^;\n]+;/.exec(navDetail)?.[0] ?? "";
    ok(
      judgeLine.includes("stopsAway === 0"),
      "防线②a：missedStop 判据含「站数 0」条件",
      judgeLine || "未找到判据行",
    );
    ok(
      judgeLine.includes('alarm === "none"'),
      "防线②b：missedStop 判据含「alarm === \"none\"」条件（漏它 ⇒ 正常到站会被说成已过站）",
      judgeLine || "未找到判据行",
    );
    ok(
      judgeLine.includes('alarm === "none"') && judgeLine.includes("stopsAway === 0"),
      "防线②c：两个条件**同时**在（`df1409d` 就是少了这一个 &&）",
      judgeLine,
    );
  }
}

/* ══════════════════════════════════════════════════════════════════════
   ⑦ 停站期候选车牌（★ 2026-11-04 · 设计 §2.10）
   ──────────────────────────────────────────────────────────────────────
   两层判定，**都直接 import 线上那一份**（不复刻）：
     · `candAtStopOf`（`lib/nav/boarding-detect.ts`）—— 只管几何
     · `candViewOf`（`components/nav/cand-view.ts`）—— 只管相位/新鲜度
   设计红线：**只有 `unique` / `strong` 才给车牌**；`ambiguous` 绝不在多辆里替用户挑一辆；
   帧过期（>30s）必须不显示 —— 过期车牌比没有更危险（用户会去拦一辆已开走的车）。
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ⑦ 停站期候选车牌（几何判定 + 展示判定）──");
{
  const POS = { lng: 113.5, lat: 22.2 };
  const veh = (patch: Partial<TrackVehicle>): TrackVehicle => ({
    plate: "MZ-00-00",
    lat: 22.2,
    lng: 113.5,
    status: "moving",
    interval: null,
    atStation: null,
    ...patch,
  });
  const atStop = (code: string, plate: string) =>
    veh({ plate, status: "stopping", atStation: { code } });
  const justLeft = (from: string, to: string, plate: string) =>
    veh({ plate, status: "moving", interval: { from: { code: from }, to: { code: to } } });

  /* ── ① 几何判定矩阵 ── */
  const uniq = candAtStopOf([atStop("M1", "MB1001")], "M1", POS);
  ok(
    uniq.state === "unique" && uniq.plate === "MB1001",
    "几何·停靠本站恰 1 辆 ⇒ unique + 给车牌",
    JSON.stringify(uniq),
  );

  const amb2 = candAtStopOf([atStop("M1", "MB1001"), atStop("M1", "MB1002")], "M1", POS);
  ok(
    amb2.state === "ambiguous" && amb2.plate === null,
    "几何·停靠本站 2 辆 ⇒ ambiguous + **不给车牌**（绝不在多辆里替用户挑一辆）",
    JSON.stringify(amb2),
  );

  const strongNear = candAtStopOf([justLeft("M1", "M2", "MB2001")], "M1", POS);
  ok(
    strongNear.state === "strong" && strongNear.plate === "MB2001",
    "几何·刚离站且距站 0m ⇒ strong + 给车牌",
    JSON.stringify(strongNear),
  );

  /** 0.01° 纬度 ≈ 1113m ⇒ 必然 > CAND_STRONG_MAX_M(60) */
  const strongFar = candAtStopOf([{ ...justLeft("M1", "M2", "MB2002"), lat: 22.21 }], "M1", POS);
  ok(
    strongFar.state === "none" && strongFar.plate === null && (strongFar.distM ?? 0) > CAND_STRONG_MAX_M,
    "几何·刚离站但距站 >60m ⇒ none（`interval.from` 只说明「上一跳从你的站出发」，不说明现在离多远）",
    JSON.stringify(strongFar),
  );

  const noPos = candAtStopOf([justLeft("M1", "M2", "MB2003")], "M1", null);
  ok(
    noPos.state === "none" && noPos.plate === null,
    "几何·无上车站坐标 ⇒ none（判不了远近就**不说**，不拿 0/Infinity 凑）",
    JSON.stringify(noPos),
  );

  const conflict = candAtStopOf([atStop("M1", "MB1001"), justLeft("M1", "M2", "MB2004")], "M1", POS);
  ok(
    conflict.state === "ambiguous" && conflict.plate === null,
    "几何·strong 与 weak 指向不同车（证据矛盾）⇒ ambiguous + 不给车牌",
    JSON.stringify(conflict),
  );

  ok(
    candAtStopOf([], "M1", POS).state === "none" && candAtStopOf([], "", POS).state === "none",
    "几何·无车 / 无上车站码 ⇒ none",
  );

  /* ── ② 展示判定矩阵 ── */
  const V_BASE = {
    boarding: true,
    latched: false,
    legKind: "bus" as const,
    lastVehicleTs: 1_000_000,
    nowMs: 1_000_000 + 5_000, // 帧龄 5s ⇒ fresh
  };
  const candUnique = { state: "unique" as const, plate: "MB1001" };
  const candAmbig = { state: "ambiguous" as const, plate: null };
  const candNone = { state: "none" as const, plate: null };

  ok(
    candViewOf({ ...V_BASE, cand: candUnique }).state === "unique" &&
      candViewOf({ ...V_BASE, cand: candUnique }).plate === "MB1001",
    "展示·候车期 + 帧新鲜 + unique ⇒ 显示车牌",
  );
  ok(
    candViewOf({ ...V_BASE, cand: { state: "strong", plate: "MB2001" } }).state === "strong",
    "展示·strong 同样显示",
  );
  ok(
    candViewOf({ ...V_BASE, cand: candAmbig }).state === "ambiguous" &&
      candViewOf({ ...V_BASE, cand: candAmbig }).plate === null,
    "展示·ambiguous ⇒ **不显示车牌**（但保留独立档位供 QA 断言）",
  );
  /**
   * ⚠️ 上一条用 `plate: null` 喂进去，**即使实现漏判也恒绿**（空断言）。
   *   这里按"敌意输入"再测一遍：判定层若**同时**给出 `ambiguous` 与一个车牌
   *   （实现改坏、或将来有人加分支），展示层也必须把车牌丢掉。
   *   这才是"只有 unique/strong 才给车牌"的真断言。
   */
  ok(
    candViewOf({ ...V_BASE, cand: { state: "ambiguous", plate: "MB9999" } }).plate === null,
    "展示·敌意输入：`ambiguous` 却带着车牌 ⇒ 展示层必须丢掉（不能「判定说歧义、界面照显示」）",
  );
  ok(
    candViewOf({ ...V_BASE, cand: { state: "none", plate: "MB9999" } }).plate === null,
    "展示·敌意输入：`none` 却带着车牌 ⇒ 展示层必须丢掉",
  );
  ok(
    candViewOf({ ...V_BASE, cand: candNone }).state === "none" &&
      candViewOf({ ...V_BASE, cand: null }).state === "none",
    "展示·none（判定层 none / 本帧没算）⇒ 不显示",
  );

  /* 四条"不适用"⇒ off：轻轨 / 非候车期 / 已上过车 / 无卡 */
  ok(
    candViewOf({ ...V_BASE, legKind: "lrt", cand: candUnique }).state === "off",
    "展示·轻轨段 ⇒ off（时刻表制，没有「来车车牌」这个概念）",
  );
  ok(candViewOf({ ...V_BASE, boarding: false, cand: candUnique }).state === "off", "展示·非候车期 ⇒ off");
  ok(
    candViewOf({ ...V_BASE, latched: true, cand: candUnique }).state === "off",
    "展示·已上过车 ⇒ off（否则会让用户去拦一辆自己已经坐上的车）",
  );
  ok(candViewOf({ ...V_BASE, legKind: null, cand: candUnique }).state === "off", "展示·无卡 ⇒ off");

  /* 新鲜度：30s 边界两侧必须不同（过期车牌比没有更危险） */
  const STALE_MS = VEH_STALE_SEC * 1_000;
  ok(
    candViewOf({ ...V_BASE, nowMs: V_BASE.lastVehicleTs + STALE_MS, cand: candUnique }).state === "unique",
    `展示·帧龄恰 ${VEH_STALE_SEC}s ⇒ 仍 fresh（边界含等号）`,
  );
  ok(
    candViewOf({ ...V_BASE, nowMs: V_BASE.lastVehicleTs + STALE_MS + 1, cand: candUnique }).state === "stale" &&
      candViewOf({ ...V_BASE, nowMs: V_BASE.lastVehicleTs + STALE_MS + 1, cand: candUnique }).plate === null,
    `展示·帧龄 ${VEH_STALE_SEC}s + 1ms ⇒ stale + **不显示车牌**`,
  );
  ok(
    candViewOf({ ...V_BASE, lastVehicleTs: 0, cand: candUnique }).state === "stale",
    "展示·`lastVehicleTs === 0`（本次会话还没拿到过车辆帧）⇒ stale（不能把「从没查过」当「刚刚查过」）",
  );

  /* ── ③ 接线与形状锁（源码字符串）── */
  const navDetailNow = readFileSync("src/components/nav/NavDetailBody.tsx", "utf8");
  const candViewSrc = readFileSync("src/components/nav/cand-view.ts", "utf8");

  ok(
    navDetailNow.includes('data-cand-state={mode === "pre" ? candState : undefined}'),
    "接线：`data-cand-state` **只在 pre 输出**（post 形态没有「来车」概念）",
  );
  ok(
    navDetailNow.includes('data-cand-plate={mode === "pre" && candPlate ? candPlate : undefined}'),
    "接线：`data-cand-plate` 只在真有车牌时输出（无车牌 ⇒ 属性不存在，不是空串）",
  );
  ok(
    !/data-plate=|data-plate-state=|data-match-pending=\{.*cand/.test(
      navDetailNow.slice(navDetailNow.indexOf("data-cand-state") - 400, navDetailNow.indexOf("data-cand-state")),
    ),
    "接线·红线：候选车牌**不复用** `data-plate` / `data-plate-state` / `data-match-pending`",
  );
  ok(
    navDetailNow.includes("height: mode === \"post\" || (mode === \"pre\" && !!candPlate) ? INFO_ROW_H : undefined"),
    "接线：`pre` 出现候选车牌时**定高 52**（5+20+2+20+5），与 post 一致",
  );
  ok(
    navDetailNow.includes("alignItems: mode === \"pre\" && !candPlate ? \"center\" : \"flex-start\""),
    "接线：有候选车牌时行改 flex-start（否则图标会垂直居中到两行之间）",
  );
  ok(
    navDetailNow.includes("<Icon name={mode === \"pre\" ? \"busStop\" : \"bus\"} size={16} />"),
    "接线：图标保持 busStop（换成 bus = 暗示状态跃迁，此处没有跃迁）",
  );
  ok(
    navDetailNow.includes(">来车</span>") && navDetailNow.includes("letterSpacing: \"0.02em\""),
    "接线：次行文案 = 「来车」+ 车牌（等宽数字 + 0.02em 字距）",
  );
  ok(
    !/className="plate plate--sm"[\s\S]{0,200}\{candPlate\}/.test(navDetailNow),
    "接线·红线：候选车牌**不用** `.plate` 样式类（黑底黄字 = 「已确认上车」，会读成已经上车）",
  );
  ok(
    candViewSrc.includes("if (legKind !== \"bus\") return { state: \"off\""),
    "cand-view：轻轨/无卡在函数第一道就 off（不靠下游兜）",
  );
  /**
   * ⚠️ 这两条**必须先在剥掉注释的代码上判**：
   *   本文件的注释里就写着「**不做**防抖」「**不在渲染期直接 `Date.now()`**」——
   *   按词面 `!includes(...)` 断言会把**正确的注释**判红（第一版连红两次，同一类错）。
   *   源码字符串断言的通病：**注释与代码共享词面**。凡断言"不出现某机制"，
   *   一律先剥注释，否则测的是"注释怎么写"而不是"代码做什么"。
   */
  const candCodeOnly = candViewSrc
    .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
    .replace(/^\s*\/\/.*$/gm, ""); // 行注释
  ok(
    !candCodeOnly.includes("setTimeout") && !candCodeOnly.includes("setInterval"),
    "cand-view·红线：代码里无 `setTimeout/setInterval`（不做防抖 / 不做记忆窗口，靠源头条件收紧）",
  );
  ok(
    !candCodeOnly.includes("Date.now("),
    "cand-view·纯函数：代码里不读时钟（`nowMs` 由调用方注入，测试可喂任意时刻）",
  );
}

console.log(
  failed === 0
    ? "\n✅ 全通过（三数同帧自洽 / 停靠·行驶·错过站·异常四类边界 / 变异自检 / 接线锁定 / 候选车牌）"
    : `\n❌ ${failed} 项失败`,
);
process.exit(failed === 0 ? 0 : 1);
