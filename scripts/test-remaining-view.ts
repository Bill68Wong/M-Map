/**
 * 剩余时间派生 · 纯函数回归（scripts/test-remaining-view.ts）
 *
 * ── 这个文件解决什么（从 `.verify/` 迁入的原因）──────────────────────────
 *   原来三个断言脚本放在 `.verify/_check-remaining-*.mjs`：
 *     · `.verify/` 被 `.gitignore:51` 忽略 ⇒ **不入库**，别人 clone 出来没有；
 *     · TypeScript glob **不匹配点目录** ⇒ **不在 tsc 覆盖内** ⇒ 字段/签名改名时不会报警；
 *     · 更要命的是 `.mjs` **无法 import TS** ⇒ 旧脚本只能\*\*「复刻实现」\*\*再做断言
 *       ⇒ 一旦有人改了 `remaining-view.ts` 而没同步复刻，**测的就不是线上那份代码**。
 *   本项目已有前科：`.verify/p7-2-strips.ts` 与 `verify-b2-b5.ts` 因 `weekday → nowBucket`
 *   改名而 `TS2353` 静默腐坏了很久没人发现。
 *   ⇒ 迁到 `scripts/` 后**直接 import 真实函数**，断言对象与线上代码是同一个。
 *
 * ── 断言三分法（决定哪条需要「造错检出」）──────────────────────────────
 *   · **守护型**（防将来改坏）  ⇒ 必须验证「造错能检出」，见文件末尾「变异自检」段
 *   · **描述型**（记录当前行为）⇒ 天然满足，不需要额外造错
 *   · **契约型**（锁外部接口）  ⇒ 推荐验证
 *
 * ── 跑法 ──────────────────────────────────────────────────────────────
 *   node node_modules/tsx/dist/cli.mjs scripts/test-remaining-view.ts
 */
import { readFileSync } from "node:fs";
import {
  ARRIVE_OVERDUE_TEXT,
  REMAIN_ARRIVED_TEXT,
  legRemainMinOf,
  remainOf,
  remainServedOf,
  remainTotalMinOf,
} from "../src/lib/nav/remaining-view";
import {
  progressOf,
  remainFromIdxOf,
  segRemainSecOf,
  stopsAwayOf,
  type TrackProgress,
  type TrackVehicle,
} from "../src/lib/nav/track";

let failed = 0;
const ok = (cond: boolean, name: string, detail = ""): void => {
  if (cond) console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};

const MIN = 60_000;
const T0 = 1_700_000_000_000;

/* ══════════════════════════════════════════════════════════════════════
   ① remainOf —— 客户端兜底分支（无服务端结果时）
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ① remainOf（客户端兜底）──");
ok(REMAIN_ARRIVED_TEXT === "即将到达", "归零文案 = 即将到达", REMAIN_ARRIVED_TEXT);
ok(ARRIVE_OVERDUE_TEXT === "预计已过", "超时文案 = 预计已过", ARRIVE_OVERDUE_TEXT);

ok(remainOf(T0 + 30 * MIN, T0).totalMin === 30, "t=0 时剩余 == 规划总时长（30 分）");
ok(remainOf(T0 + 30 * MIN, T0 + 10 * MIN).totalMin === 20, "走 10 分后剩 20 分");

const late = remainOf(T0, T0 + 5 * MIN);
ok(late.totalMin === 0, "超时 ⇒ totalMin 被 clamp 到 0（不出现 -5）", String(late.totalMin));
ok(late.overdue === true, "超时 ⇒ overdue=true（渲染「预计已过」）");
ok(late.arrived === true, "超时 ⇒ arrived=true（渲染「即将到达」而非「0 分」）");

ok(remainOf(T0 + 0.2 * MIN, T0).arrived === true, "剩 12 秒 ⇒ 四舍五入 0 分 ⇒ 切「即将到达」");
ok(remainOf(T0 + 0.6 * MIN, T0).arrived === false, "剩 36 秒 ⇒ 仍显示 1 分（不提前跳到站）");

const bad = remainOf(Number.NaN, T0);
ok(bad.totalMin === 0 && !Number.isNaN(bad.totalMin), "非法 arriveAt ⇒ 0 且不产生 NaN");

ok(remainTotalMinOf(late) === 0, "remainTotalMinOf 对负值仍返回 0（双保险）");
ok(remainTotalMinOf(remainOf(T0 + 30 * MIN, T0)) === 30, "remainTotalMinOf 取整正确");

/* ══════════════════════════════════════════════════════════════════════
   ② remainServedOf —— 服务端分支（扣缓存陈旧 + 响应后流逝）
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ② remainServedOf（服务端基准，含缓存陈旧扣除）──");
const SN = 1_700_000_000_000;

ok(
  remainServedOf({ remainingMin: 20, serverNowMs: SN, staleSec: 0, arriveAtMs: SN + 20 * MIN, nowMs: SN })
    .totalMin === 20,
  "无陈旧·刚收到 ⇒ 20 分",
);

const stale2 = remainServedOf({
  remainingMin: 20, serverNowMs: SN, staleSec: 2, arriveAtMs: SN + 20 * MIN, nowMs: SN,
});
ok(
  Math.abs(stale2.totalMin - (20 - 2 / 60)) < 1e-9,
  "缓存陈旧 2s ⇒ 扣成 19.967 分（不偏大）",
  `实际=${stale2.totalMin.toFixed(4)}`,
);

const elapse5 = remainServedOf({
  remainingMin: 20, serverNowMs: SN, staleSec: 0, arriveAtMs: SN + 20 * MIN, nowMs: SN + 5 * MIN,
});
ok(Math.abs(elapse5.totalMin - 15) < 1e-9, "响应后过 5 分 ⇒ 剩 15 分", `实际=${elapse5.totalMin}`);

const both = remainServedOf({
  remainingMin: 20, serverNowMs: SN, staleSec: 2, arriveAtMs: SN + 20 * MIN, nowMs: SN + 5 * MIN,
});
ok(
  Math.abs(both.totalMin - (15 - 2 / 60)) < 1e-9,
  "陈旧 2s + 流逝 5 分 ⇒ 14.967 分",
  `实际=${both.totalMin.toFixed(4)}`,
);

const over = remainServedOf({
  remainingMin: 2, serverNowMs: SN, staleSec: 0, arriveAtMs: SN + 2 * MIN, nowMs: SN + 30 * MIN,
});
ok(over.totalMin === 0, "严重超时 ⇒ clamp 到 0（无负数）");
ok(over.overdue === true && over.arrived === true, "严重超时 ⇒ overdue + arrived 双真");

/**
 * 守护型：`staleSec` 传负数时**不得把剩余算大**。
 * 服务端理论上不会发负数，但一旦有人把 `Math.max(0, staleSec)` 去掉，
 * 负数会变成"加时间" —— 用户会看到剩余比实际更多。这条守的就是那个 `Math.max`。
 */
const negStale = remainServedOf({
  remainingMin: 20, serverNowMs: SN, staleSec: -99, arriveAtMs: SN + 20 * MIN, nowMs: SN,
});
ok(negStale.totalMin === 20, "staleSec 负数 ⇒ 按 0 处理（不会把剩余算大）", `实际=${negStale.totalMin}`);

ok(
  remainServedOf({ remainingMin: 99, serverNowMs: SN, staleSec: 0, arriveAtMs: SN + 7 * MIN, nowMs: SN })
    .arriveAtMs === SN + 7 * MIN,
  "arriveAtMs 原样透传（不被 remainingMin 影响）",
);

ok(
  remainServedOf({
    remainingMin: Number.NaN, serverNowMs: SN, staleSec: 0, arriveAtMs: SN, nowMs: SN,
  }).totalMin === 0,
  "remainingMin=NaN ⇒ 0（不产生 NaN）",
);

/* ══════════════════════════════════════════════════════════════════════
   ③ 契约型：两条派生路径【恒等】
   ──────────────────────────────────────────────────────────────────────
   后端保证 `arriveAt === recomputedAt + remainingMin × 60000`（残差恒 0ms，
   因为 arriveAt 是由四舍五入后的 remainingMin 反推的）。代入即得：
     remainingMin − staleSec/60 − (now − serverNow)/60
       = remainingMin − (now − recomputedAt)/60000
       = (arriveAt − now)/60000
   ⇒ 两条路**恒等**（不是"近似"）。

   为什么要锁：一旦服务端把 remainingMin 改成整分钟取整、或改 arriveAt 算法，
   两条路分叉 ⇒ 用户会同时看到「顶部剩余」和「peek 摘要」两个不同数字
   （本项目踩过的「两个真相」）。本段一旦红，说明必须同步两处口径。
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ③ 契约：remainServedOf ≡ remainOf（恒等）──");
const RECOMPUTED = 1_700_000_000_000;
/** 由「重算基准时刻」造一组自洽输入（arriveAt 由 remainingMin 反推，与服务端同构） */
function pairOf(remainingMin: number, staleSec: number, elapsedMin: number) {
  const serverNowMs = RECOMPUTED + staleSec * 1000;
  const arriveAtMs = RECOMPUTED + remainingMin * MIN;
  const nowMs = serverNowMs + elapsedMin * MIN;
  const A = remainServedOf({ remainingMin, serverNowMs, staleSec, arriveAtMs, nowMs }).totalMin;
  const B = remainOf(arriveAtMs, nowMs).totalMin;
  return { A, B, diff: Math.abs(A - B) };
}

for (const s of [0, 2, 10]) {
  for (const e of [0, 5, 60]) {
    const { A, B, diff } = pairOf(20, s, e);
    // 容差 1 分：remainingMin 可能被服务端四舍五入到 1 位小数
    ok(diff < 1, `stale=${s}s elapsed=${e}min ⇒ A=${A.toFixed(3)} B=${B.toFixed(3)}`, `Δ=${diff.toFixed(4)}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   ③b legRemainMinOf —— 「到下车站还有几分钟」的唯一口径（U3）
   ──────────────────────────────────────────────────────────────────────
   与服务端 `remaining.ts` 的当前腿剩余**必须同式**：
     legRemain = segRemainSec/60 + Σ minToNext[pivotIdx .. 倒数第二站]
   否则顶部「总时长」与竖条「还有几分钟」会在切换瞬间各说一个数。
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ③b legRemainMinOf（本段剩余的唯一口径）──");
{
  // 站条：[A1, A2, A3]，两跳各 4 分
  const hops = [4, 4, 0];
  ok(
    legRemainMinOf({ segRemainSec: 120, pivotIdx: 1, minToNext: hops, legMinutes: 8 }) === 6,
    "首跳 2 分 + 基准站 A2 之后 4 分 = 6（不是 2）",
    String(legRemainMinOf({ segRemainSec: 120, pivotIdx: 1, minToNext: hops, legMinutes: 8 })),
  );
  ok(
    legRemainMinOf({ segRemainSec: 0, pivotIdx: 1, minToNext: hops, legMinutes: 8 }) === 4,
    "停靠 A2（seg=0，基准站=所停站）⇒ 4 分（含「A2→A3」这一跳）",
  );
  ok(
    legRemainMinOf({ segRemainSec: 0, pivotIdx: 2, minToNext: hops, legMinutes: 8 }) === 0,
    "停靠下车站 ⇒ 0",
  );
  ok(
    legRemainMinOf({ segRemainSec: 120, pivotIdx: null, minToNext: hops, legMinutes: 8 }) === 8,
    "只有 segRemainSec（基准站未知）⇒ 回落整段 8（保守偏长，不拿 2 当整段）",
  );
  ok(
    legRemainMinOf({ segRemainSec: null, pivotIdx: 1, minToNext: hops, legMinutes: 8 }) === 4,
    "只有基准站 ⇒ 逐跳累加 4",
  );
  ok(
    legRemainMinOf({ segRemainSec: null, pivotIdx: null, minToNext: hops, legMinutes: 8 }) === 8,
    "两者都没有 ⇒ 整段 8",
  );
  ok(
    legRemainMinOf({ segRemainSec: -1, pivotIdx: null, minToNext: hops, legMinutes: 8 }) === 8,
    "负 segRemainSec 视为无效 ⇒ 整段 8（不产生负数）",
  );
  // 变异自检：若把「只看 segRemainSec」的旧口径写回去，第一条必失配
  {
    const oldImpl = (seg: number | null, legMin: number) => (seg != null && seg >= 0 ? seg / 60 : legMin);
    ok(oldImpl(120, 8) !== 6, "[变异] 旧口径（seg/60 当整段）能被 6 分这条检出", `旧口径给 ${oldImpl(120, 8)}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   ④ 渲染侧口径（跨文件契约，读源码字符串）
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ④ 渲染侧：两处地板语义刻意不同 + 观测钩子齐全 ──");
const body = readFileSync("src/components/nav/NavDetailBody.tsx", "utf8");

/**
 * 守护型：④「距下车还有几分钟」保留 `Math.max(1, …)` 地板。
 * 与顶部总时长的 clamp 0 **刻意不同**：写「还有 0 分钟」读起来像已到站，
 * 会与到站提醒（`alarm === "now"` 的「已到站」）抢语义。
 * 若有人"统一"成 clamp 0，这条立刻红。
 *
 * ⚠️ 地板表达式的变量在 U4 收口时改过名（`remainMin` → `alightMin`，取自 `legRemainMinOf`），
 *   **地板本身没变**。抽成常量 `ALIGHT_FLOOR` 同时供 ④ 与 ⑤ 变异自检，避免两处各写一遍
 *   ⇒ 一处改名就只剩一处能跟上（上一轮就是这么退化成假绿的）。
 */
const ALIGHT_FLOOR = "Math.max(1, Math.round(alightMin))";
ok(
  body.includes(ALIGHT_FLOOR),
  "距下车站保留 Math.max(1,…) 地板（与总时长 clamp 0 刻意不同）",
  body.includes(ALIGHT_FLOOR) ? ALIGHT_FLOOR : "✗ 未找到该表达式（地板被改 / 变量又改名了？）",
);

for (const hook of [
  "data-remain-total",
  "data-remain-base",
  "data-arrive-at",
  "data-recompute-seq",
  "data-eta-base",
  "data-eta-remain",
  "data-eta-scope",
  "data-stops-away",
  "data-nav-info",
  "data-nav-info-h",
  "data-nav-next-station",
  "data-nav-remain-min",
  "data-remain-fail",
]) {
  ok(body.includes(hook), `钩子 ${hook} 已挂 NavDetailBody`);
}
const sheet = readFileSync("src/components/nav/RouteSheet.tsx", "utf8");
ok(sheet.includes("data-peek-remain"), "钩子 data-peek-remain 已挂 peek 摘要");

/* ══════════════════════════════════════════════════════════════════════
   ④b 信息行钩子的**语义**（不是"名字存在"）
   ──────────────────────────────────────────────────────────────────────
   为什么必须单独一段：上面那个 `for` 循环只证「名字出现过」，
   而本轮就出过「名字在、语义变」（`data-eta-base` 从"本地校准锚点"变成"显示值"）。
   源码级能锁的是**写法**（属性怎么输出、谁喂它）；DOM 级的读法纪律见 ⑤ 末尾 ⚠️ 条。
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ④b 信息行钩子语义（同源一处 + 「不显示」用不输出表达）──");
{
  /** ① 三个分钟钩子必须由**同一个** `remainMin` 参数喂（口径分裂才是历史缺陷的成因） */
  const sameSource = [
    /data-eta-remain=\{remainMin == null \? undefined : remainMin\}/,
    /data-eta-base=\{remainMin == null \? undefined : remainMin\}/,
    /data-nav-remain-min=\{remainMin == null \? undefined : String\(remainMin\)\}/,
  ];
  for (const re of sameSource) {
    ok(re.test(body), `分钟钩子由同一参数喂：${re.source.slice(0, 28)}…`);
  }
  /** ② `data-nav-remain-min` 在「不显示」时**整个属性不输出**（不是 `""`、不是 `0`）*/
  ok(
    /data-nav-remain-min=\{remainMin == null \? undefined :/.test(body),
    "data-nav-remain-min 不显示 ⇒ 属性不输出（DOM 侧须用 hasAttribute 判，不能比 \"\" 或 0）",
  );
  /** ③ 口径声明：`alight`（上车后，到下车）/ `board`（上车前，车辆到本站）—— 两者刻意不同 */
  ok(
    /data-eta-scope=\{mode === "post" \? "alight" : "board"\}/.test(body),
    "data-eta-scope 随形态切换 alight / board（上车前不是「到下车」）",
  );
  ok(
    /data-nav-next-station=\{nextStationOn \? "1" : "0"\}/.test(body),
    "data-nav-next-station 取 \"1\"/\"0\"（主行是否存在）",
  );
  /** ④ 调用侧只传**一个**表达式：post 传 `shownAlightMin`、pre 传 `null`（pre 的分钟是「车辆到本站」）*/
  ok(/remainMin=\{shownAlightMin\}/.test(body), "post 态三个钩子共用 `shownAlightMin`（勿拆回多份）");
  ok(/remainMin=\{null\}/.test(body), "pre 态不输出分钟（避免与「车辆到本站」混成假口径）");
  /** ⑤ 高度钩子必须 `setAttribute` + 卸载 `removeAttribute`（否则陈旧值会永久挂 DOM）*/
  ok(
    /el\.setAttribute\("data-nav-info-h"/.test(body) && /removeAttribute\("data-nav-info-h"\)/.test(body),
    "data-nav-info-h 写入 + 卸载清理成对",
  );
  /**
   * ⑥ **口径来源**锁：到下车分钟必须来自 `legRemainMinOf`（与服务端同式），
   *   而不是重新退回「`segRemainSec/60` 当整段」或「读 `liveStrips.rideMin`」。
   */
  ok(/legRemainMinOf\(\{/.test(body), "到下车分钟来自 legRemainMinOf（与服务端同式）");
  ok(!/liveStrips\?\.\[legIdx\]\?\.rideMin/.test(body), "不再把 liveStrips.rideMin 当到下车分钟（请求失败会卡住）");
  /**
   * ⑦ **站数口径来源**锁：必须走 `track.ts#stopsAwayOf`（停靠态不再多算 1 站）。
   *   为什么落在源码级：站数是渲染期表达式，没有独立纯函数入口可喂；
   *   而它的两处旧写法（`lastIdx − passedIdx` 多算 1、复用 `remainFromIdxOf` 少算 1）
   *   都能靠这一条挡住 —— 语义回归由 `test-remaining.ts` ⑭ ⑤ 段用真实 `progressOf` 锁。
   */
  ok(
    /const stopsAway = stopsAwayOf\(track\?\.prog \?\? null, trackStops\.length - 1\)/.test(body),
    "站数来自 stopsAwayOf（停靠态正确、行驶态不少算 1）",
  );
  ok(!/trackStops\.length - 1 - track\.prog\.passedIdx/.test(body), "站数不再按「已过站数」算（停靠态会多 1）");
}

/* ══════════════════════════════════════════════════════════════════════
   ⑤ 变异自检 —— 证明上面的守护型断言**真的有效**（不是恒绿）
   ──────────────────────────────────────────────────────────────────────
   为什么必须有：本项目出过 `X || !!hit` 这种恒真断言（永远 PASS），
   也出过「判据过宽、代码改坏了仍绿」的形态。
   `绿的数量 ≠ 守护的强度` ⇒ 守护型断言必须能证明自己会红。

   ⚠️⚠️ **变异自检本身也会退化成假绿**（本轮实况）：上一版变异 a 写的是
   `ok(!mutated.includes("<旧表达式>"))` —— 源码一改名，`replaceAll` 就什么都不做
   ⇒ `mutated === body` ⇒ `!includes(...)` **恒真** ⇒ 永远 PASS 且证明不了任何事。
   ⇒ 纪律：**每条变异断言必须带「变异真的发生了」的前置条件**（`body.includes(原文)`），
     否则整条判失败。下面每条都按这个写。
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ⑤ 变异自检（守护型断言必须能检出造错，且变异必须真的发生）──");
{
  /**
   * 变异 a：把「距下车」地板改成 clamp 0 ⇒ ④ 的地板断必须失配。
   * `replaceAll` 保留（无害）；**前置条件 `body.includes(ALIGHT_FLOOR)` 才是防退化的关键**。
   */
  const mutated = body.replaceAll(ALIGHT_FLOOR, "Math.round(alightMin)");
  ok(
    body.includes(ALIGHT_FLOOR) && !mutated.includes(ALIGHT_FLOOR),
    "[变异] 地板被改成 clamp 0 能被检出（且证明变异真的发生）",
    body.includes(ALIGHT_FLOOR) ? "" : "✗ 变异无效：源码里没有该表达式",
  );
}
{
  /** 变异 b：`data-nav-remain-min` 改成「不显示时输出 0」⇒ ④b 的「属性不输出」断必须失配 */
  const from = 'data-nav-remain-min={remainMin == null ? undefined : String(remainMin)}';
  const mutated = body.replaceAll(from, 'data-nav-remain-min={String(remainMin ?? 0)}');
  ok(
    body.includes(from) && !/data-nav-remain-min=\{remainMin == null \? undefined :/.test(mutated),
    "[变异] 「不显示 ⇒ 不输出属性」被改成输出 0 能被检出",
    body.includes(from) ? "" : "✗ 变异无效：源码里没有该表达式",
  );
}
{
  /** 变异 c：`data-eta-scope` 固定成 alight（丢掉上车前那一档）⇒ ④b 的 scope 断必须失配 */
  const from = 'data-eta-scope={mode === "post" ? "alight" : "board"}';
  const mutated = body.replaceAll(from, 'data-eta-scope="alight"');
  ok(
    body.includes(from) && !/data-eta-scope=\{mode === "post" \? "alight" : "board"\}/.test(mutated),
    "[变异] scope 丢掉 board 档能被检出（否则上车前会被当成「到下车」）",
    body.includes(from) ? "" : "✗ 变异无效：源码里没有该表达式",
  );
}
{
  /**
   * ⚠️ DOM 级断言的纪律（本脚本读的是源码，做不了 DOM 断言，故在此登记，防止后来人写错）：
   *   · `data-nav-remain-min` 不显示时**整个属性不存在** ⇒ Playwright 用
   *     `locator.getAttribute(...) === null` / `hasAttribute`，**不能**拿 `""` 或 `0` 比；
   *   · 赶车标签 `data-tag` 隐藏时**节点不存在** ⇒ 必须 `expect(locator).toHaveCount(0)`，
   *     **不能**用 `toBeHidden()`（它对 `opacity: 0` 也通过 —— 那正是要防的假绿）；
   *   · `data-nav-info-h` 在 effect 里写、卸载移除，首帧 paint 后一两帧才出现 ⇒
   *     必须 `waitForSelector('[data-nav-info-h]')` 或轮询，**不要** `evaluate` 立刻读。
   */
}
{
  /**
   * 变异 d：故意造两路分叉 ⇒ ③ 的恒等断必须失配。
   * ⚠️ **不能**用 `pairOf()` 造：它是"自洽构造"（arriveAt 由 remainingMin 反推）
   *    ⇒ 传任何 remainingMin 两路都一致，Δ 恒 0（第一版就这么错的）。
   *    必须显式让 `arriveAt` 与 `remainingMin` 不匹配。
   */
  const serverNowMs = RECOMPUTED;
  const arriveAtMs = RECOMPUTED + 20 * MIN; // 到达时刻仍按「20 分」
  const A = remainServedOf({ remainingMin: 18, serverNowMs, staleSec: 0, arriveAtMs, nowMs: serverNowMs })
    .totalMin; // 只有 18 分
  const B = remainOf(arriveAtMs, serverNowMs).totalMin; // 20 分
  ok(Math.abs(A - B) >= 1, "[变异] 两路分叉 2 分能被检出（证明容差 1 分不过宽）", `Δ=${Math.abs(A - B).toFixed(3)}`);
}
{
  // 变异 c：若 `staleSec` 的 Math.max 被去掉 ⇒ 负数会"加时间" ⇒ ② 的负数断必须失配
  const withoutClamp = (staleSec: number) => 20 * 60 - staleSec; // 去掉 Math.max(0, …)
  ok(withoutClamp(-99) / 60 !== 20, "[变异] staleSec 负数未被 clamp 能被检出", `会算成 ${withoutClamp(-99) / 60} 分`);
}

/* ══════════════════════════════════════════════════════════════════════
   ⑥ 信息行三数自洽（停靠 / 行驶 × 边界）—— 2026-11-04 新增
   ─────────────────────────────────────────────────────────────────────
   信息行同帧显示三个数，**锚站刻意不同**（差 1 是语义必然，不是错位）：
     · `data-stops-away`     还有几站下车：`at` → `atIdx`；`between` → `passedIdx`
       （「站数」**含**正在开往的那一站 ⇒ 锚「所在 / 刚离开的站」）
     · `data-nav-remain-min` 到下车还有几分钟：`at` → `atIdx`；`between` → `nextIdx`
       （「分钟」量的是「到那一站还剩多久」⇒ 锚「区间终点站」）
     · `data-eta-scope`      上车后 `alight` / 上车前 `board`（board 态**不带**分钟）
   **本段存在的理由：这是本批最容易被下一个人"统一"掉的地方。**
     谁把两个 pivot 合并成一个，下面「不变量 2」与两条变异断言立刻红。
   ⚠️ 只用**真实 `progressOf` 产物**喂入（不手搓 `TrackProgress`）——
     手搓对象测不出真实状态机的边界，本项目已因此错过一次（be-remaining 的实测教训）。
   ⚠️ `alarm` 判据在组件里是**内联表达式**（无导出函数）⇒ 本段只能**复刻**，
     故另用源码字符串锁住复刻（见下方「复刻锁定」），防止复刻与线上漂移。
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ⑥ 信息行三数自洽（真实 progressOf × 停靠/行驶 × 边界）──");
{
  const MAINS = ["M100", "M200", "M300", "M400"];
  const LAST = MAINS.length - 1; // 3
  /** 逐跳分钟（末站 0）：刻意取三个**不相等**的值 —— 相等时"算错跳数"会恰好漏判 */
  const HOP = [3, 4, 5, 0];
  const LEG_MIN = HOP[0] + HOP[1] + HOP[2]; // 12

  // ── 用官方数据形状（`TrackVehicle`）构造，再交给真实 `progressOf` 产出进度 ──
  const veh = (patch: Partial<TrackVehicle>): TrackVehicle => ({
    plate: "MZ-00-00",
    lat: 22.2,
    lng: 113.5,
    status: "moving",
    interval: null,
    atStation: null,
    ...patch,
  });
  const at = (code: string) => veh({ status: "stopping", atStation: { code } });
  const run = (from: string, to: string) =>
    veh({ status: "moving", interval: { from: { code: from }, to: { code: to } } });

  /**
   * 复刻信息行的三数派生（与 `NavDetailBody` / `NavShell` 的**真实接线**一一对应）：
   *   `stopsAway` ← `stopsAwayOf`；`pivotIdx` ← `remainFromIdxOf`；
   *   `min` ← `legRemainMinOf`；`shown` ← 地板 `Math.max(1, round)`；`alarm` ← 引擎内联式。
   * `rawSegSec` 传**组件实际看到的** `segProgress.segRemainSec`（停靠帧该值为 null，
   * 因为 `useRideTracking` 在车辆无 `progress` 时把 `segProgress` 置 null）。
   */
  const deriveRow = (p: TrackProgress, rawSegSec: number | null) => {
    const stopsAway = stopsAwayOf(p, LAST);
    const pivotIdx = remainFromIdxOf(p);
    const min = legRemainMinOf({
      segRemainSec: rawSegSec,
      pivotIdx,
      minToNext: HOP,
      legMinutes: LEG_MIN,
    });
    const shown = Math.max(1, Math.round(min));
    const alarm = p.atIdx === LAST ? "now" : p.nextIdx === LAST ? "soon" : "none";
    return { stopsAway, pivotIdx, min, shown, alarm };
  };

  const P_AT_BOARD = progressOf(MAINS, at("M100/1")); // 原始站码带站台后缀 ⇒ 顺带验证 mainOf 归一
  const P_AT_MID1 = progressOf(MAINS, at("M200"));
  const P_AT_MID2 = progressOf(MAINS, at("M300"));
  const P_AT_ALIGHT = progressOf(MAINS, at("M400"));
  const P_RUN_FIRST = progressOf(MAINS, run("M100", "M200"));
  const P_RUN_LAST = progressOf(MAINS, run("M300", "M400"));
  /**
   * ★ 「已过站」：车从**本段下车站**开走（`interval.from = M400`）。
   *   `progressOf` 走 ② 分支：`passedIdx = 3`、`toIdx` 不在本段站序 ⇒ `nextIdx = null`。
   *   这是**真实会发生的状态**（用户没下车 / 错过站），必须进表 —— 否则「站数 = 0」会被
   *   误认为「只可能出现在已到站」（本批我一度就是这么以为的，fe-nav-ui 复核时也这么以为）。
   */
  const P_RUN_PAST = progressOf(MAINS, run("M400", "M900"));
  const P_LOST = progressOf(MAINS, null);
  const P_UNKNOWN = progressOf(MAINS, at("Z999")); // 不在本段站序

  ok(
    P_AT_BOARD.kind === "at" && P_AT_BOARD.atIdx === 0,
    "前置：站台后缀 `M100/1` 经 mainOf 归一到上车站（否则下面整张表都不可信）",
    `kind=${P_AT_BOARD.kind} atIdx=${P_AT_BOARD.atIdx}`,
  );
  ok(P_UNKNOWN.kind === "unknown", "前置：站序外的站码 ⇒ unknown（不是「在起点站」）", P_UNKNOWN.kind);
  ok(P_LOST.kind === "lost", "前置：无车辆帧 ⇒ lost", P_LOST.kind);

  // ── 四态 × 边界，逐格钉死「期望值」──
  // 行格式：[名称, 进度, 组件看到的 segRemainSec, 期望站数, 期望分钟, 期望 alarm]
  const CASES: Array<[string, TrackProgress, number | null, number | null, number, string]> = [
    ["停靠上车站", P_AT_BOARD, null, 3, 12, "none"],
    ["停靠中间站 1", P_AT_MID1, null, 2, 9, "none"],
    ["停靠中间站 2（下车站前站）", P_AT_MID2, null, 1, 5, "soon"],
    ["停靠下车站", P_AT_ALIGHT, null, 0, 0, "now"],
    ["行驶第一段 M100→M200（无位置模型）", P_RUN_FIRST, null, 3, 9, "none"],
    ["行驶最后一段 M300→M400（无位置模型）", P_RUN_LAST, null, 1, 0, "soon"],
    ["行驶第一段 + 位置模型剩 120s", P_RUN_FIRST, 120, 3, 11, "none"],
    ["已过站（车驶离下车站 M400→M900）", P_RUN_PAST, null, 0, 0, "none"],
    ["丢信号（lost）", P_LOST, null, null, 12, "none"],
    ["站序对不上（unknown）", P_UNKNOWN, null, null, 12, "none"],
  ];
  for (const [name, p, rawSeg, wantAway, wantMin, wantAlarm] of CASES) {
    const d = deriveRow(p, rawSeg);
    ok(d.stopsAway === wantAway, `${name}：还有几站 = ${String(wantAway)}`, `实际 ${String(d.stopsAway)}`);
    ok(Math.abs(d.min - wantMin) < 1e-9, `${name}：到下车分钟 = ${wantMin}`, `实际 ${d.min}`);
    ok(d.alarm === wantAlarm, `${name}：alarm = ${wantAlarm}`, `实际 ${d.alarm}`);
  }

  // ── 跨态不变量（本段的核心价值）──
  const rows = CASES.map(([name, p, rawSeg]) => ({ name, d: deriveRow(p, rawSeg) }));

  /**
   * 不变量 1（拆成正反两个方向，**别合并**）：
   *   1a 已到站（`alarm="now"`）⇒ 站数必然是 0 —— 硬方向，任何实现都必须满足；
   *   1b 站数 0 但 `alarm≠"now"` ⇒ **只允许「已过站」这一种解释**（车已驶离下车站）。
   *      ⚠️ 这里**不能**写成双向 `(站数===0) ⟺ alarm="now"`：那条断言在本批我一度写成双向，
   *      只是因为表里**没有「已过站」这一行**才侥幸全绿 —— 一旦补上真实状态立刻红。
   *      双向写法会把一个真实存在的状态判成"不该出现"，属于**用断言掩盖现实**。
   *      「已过站」时次行的文案是**已知缺口**（当前会渲染「还有 0 站下车 · 约 1 分」），
   *      是否改成「已过站 · 请下车」属产品裁决，见下方 §已知缺口 的登记断言。
   */
  ok(
    rows.every(({ d }) => d.alarm !== "now" || d.stopsAway === 0),
    "不变量 1a：已到站（alarm=now）⇒ 站数必为 0",
    rows.filter(({ d }) => d.alarm === "now" && d.stopsAway !== 0).map((r) => r.name).join(","),
  );
  {
    const zeroNotNow = rows.filter(({ d }) => d.stopsAway === 0 && d.alarm !== "now");
    ok(
      zeroNotNow.every(({ name }) => name.includes("已过站")),
      "不变量 1b：站数 0 且 alarm≠now ⇒ 只能是「已过站」（不得由其它状态产出）",
      zeroNotNow.map((r) => `${r.name}(alarm=${r.d.alarm})`).join(",") || "本表无此状态",
    );
  }

  /**
   * 不变量 2：`alarm=soon`（底栏「即将到达」）**必须且只能**伴随「还有 1 站」。
   * ⚠️ 注意命题方向：写成「站数 ≥1 ⇒ 不得 soon」是**错的** ——
   *   行驶 M300→M400（下车站 400）时站数 1 且 soon，这是**正确且必要**的组合
   *   （1 站 + 即将到达 = 同一件事的两种说法）。真正要禁的是「还有 2 站」+「即将到达」。
   */
  ok(
    rows.every(({ d }) => d.alarm !== "soon" || d.stopsAway === 1),
    "不变量 2：alarm=soon ⇒ 还有 1 站（禁「还有 2 站 + 即将到达」同屏）",
    rows.filter(({ d }) => d.alarm === "soon" && d.stopsAway !== 1).map((r) => r.name).join(","),
  );

  /**
   * 不变量 3：站数只有三种合法值 —— `null`（进度不可用）/ `≥1` / `0`；
   *   且 `0` 必属「已到站」或「已过站」（见不变量 1a/1b），**不得**由其它状态产出。
   */
  ok(
    rows.every(({ d }) => d.stopsAway === null || d.stopsAway >= 1 || d.stopsAway === 0),
    "不变量 3：站数 ∈ {null} ∪ {≥1} ∪ {0}（0 的两种解释由 1a/1b 分别锁死）",
  );

  /** 不变量 4：无位置模型的帧，到下车分钟必须落在 [0, 整段静态分钟]（不出现负数 / 超过整段） */
  ok(
    rows
      .filter(({ name }) => !name.includes("位置模型剩"))
      .every(({ d }) => d.min >= 0 && d.min <= LEG_MIN + 1e-9),
    "不变量 4：无位置模型时 0 ≤ 到下车分钟 ≤ 整段静态分钟",
  );

  /**
   * 不变量 5（U3 的核心）：**停靠态的分钟必须从「所停站」起算**。
   * 停靠 M200（idx 1）⇒ 9 = HOP[1]+HOP[2]，即含「M200→M300」那一跳。
   * 若从 `nextIdx`(2) 起算 ⇒ 只剩 5 ⇒ **整跳漏掉 4 分钟**（这就是 U3 修的"进站瞬间数字掉一截"）。
   */
  const dMid1 = deriveRow(P_AT_MID1, null);
  const wrongFromNextIdx = legRemainMinOf({
    segRemainSec: 0,
    pivotIdx: P_AT_MID1.nextIdx,
    minToNext: HOP,
    legMinutes: LEG_MIN,
  });
  ok(
    dMid1.min === HOP[1] + HOP[2] && wrongFromNextIdx === HOP[2],
    "不变量 5（U3）：停靠态从所停站起算（含所停站→下一站），从 nextIdx 起算会整跳少算",
    `正确 ${dMid1.min} / 错误 ${wrongFromNextIdx}`,
  );

  /**
   * 不变量 6：两条「停靠」路径**同值** ——
   *   前端组件看到 `segProgress=null`（车无 `progress`）；服务端拿到 `segRemainSecOf(true, x)=0`。
   *   二者喂进同一个 `legRemainMinOf` 必须得到同一个数，否则顶部（服务端）与信息行（前端）会打架。
   */
  ok(
    legRemainMinOf({ segRemainSec: null, pivotIdx: 2, minToNext: HOP, legMinutes: LEG_MIN }) ===
      legRemainMinOf({ segRemainSec: segRemainSecOf(true, 999), pivotIdx: 2, minToNext: HOP, legMinutes: LEG_MIN }),
    "不变量 6：停靠态「seg 缺失」与「seg 显式 0」同值（前端 / 服务端两条路径不打架）",
  );

  /** 不变量 7：进度不可用（lost / unknown）⇒ 不猜位置：站数 null、分钟回落到整段（偏长） */
  ok(
    [deriveRow(P_LOST, null), deriveRow(P_UNKNOWN, null)].every(
      ({ stopsAway, shown }) => stopsAway === null && shown === LEG_MIN,
    ),
    "不变量 7：lost / unknown ⇒ 站数 null + 分钟回落整段（不猜「在起点站」）",
  );

  /** 边界：单站卡（站序 1 个）—— 站数必须 null（不写「还有 0 站」），且已到站 */
  {
    const single = ["M100"];
    const p = progressOf(single, at("M100"));
    const away = stopsAwayOf(p, single.length - 1);
    ok(
      away === null && p.atIdx === 0,
      "边界：单站卡（站序 <2）⇒ 站数 null、进度仍是 at（不崩、不写 0 站）",
      `away=${String(away)} atIdx=${String(p.atIdx)}`,
    );
  }

  /* ── 变异断言：证明上面两条不变量**能检出"统一 pivot"这个诱惑** ── */
  {
    /** 错误实现：站数复用「分钟」的基准站（`remainFromIdxOf`） */
    const unified = (p: TrackProgress) => LAST - (remainFromIdxOf(p) ?? 0);
    ok(
      unified(P_AT_MID2) === stopsAwayOf(P_AT_MID2, LAST),
      "[变异] 「统一 pivot」在停靠态**恰好正确**（所以它看起来诱人）",
      `统一 ${unified(P_AT_MID2)} / 正确 ${stopsAwayOf(P_AT_MID2, LAST)}`,
    );
    ok(
      unified(P_RUN_LAST) === 0 && stopsAwayOf(P_RUN_LAST, LAST) === 1 && deriveRow(P_RUN_LAST, null).alarm === "soon",
      "[变异] 但它在行驶末段错 1 站 ⇒ 会写出「还有 0 站下车」+「即将到达」同屏（本批踩过的坑）",
      `统一 ${unified(P_RUN_LAST)} / 正确 ${stopsAwayOf(P_RUN_LAST, LAST)}`,
    );
  }

  /* ── 接线与「复刻锁定」（源码字符串；防组件侧把口径改回去 / 防复刻漂移）── */
  {
    const navDetail = readFileSync("src/components/nav/NavDetailBody.tsx", "utf8");
    const rideEngine = readFileSync("src/components/nav/useRideTracking.ts", "utf8");

    ok(
      navDetail.includes("stopsAwayOf(track?.prog ?? null, trackStops.length - 1)"),
      "接线：站数来自 stopsAwayOf（不是 lastIdx − passedIdx）",
    );
    ok(navDetail.includes("remainFromIdxOf(track?.prog ?? null)"), "接线：分钟基准站来自 remainFromIdxOf");
    ok(navDetail.includes("legRemainMinOf({"), "接线：分钟走 legRemainMinOf（与服务端同式）");
    ok(
      navDetail.includes('data-eta-scope={mode === "post" ? "alight" : "board"}'),
      "接线：scope 只有 alight / board 两值",
    );
    const preIdx = navDetail.indexOf('mode="pre"');
    const nullIdx = navDetail.indexOf("remainMin={null}");
    ok(
      preIdx >= 0 && nullIdx > preIdx,
      "接线：board 态不输出到下车分钟（pre 分支传 remainMin={null}）",
      `pre@${preIdx} nullRemain@${nullIdx}`,
    );
    ok(
      navDetail.includes('if (track?.alarm === "now") return "本站下车";'),
      "接线：已到站时次行提前返回「本站下车」，不会落到「还有 0 站」分支",
    );
    /**
     * ★ 「已过站」这一对的**代码形状**守卫（与文案场景互补，不重复）。
     *
     * ── 为什么要在这里锁（而不是只靠 `scripts/test-nav-info-consistency.ts`）───
     *   那个文件覆盖的是**行为场景**（错过站 / 到站 / 各态文案），但它对
     *   `postSub` 的实现方式是**复刻**（组件里的表达式没有导出成函数）⇒
     *   组件侧的 `missedStop` 定义被改坏（例如漏掉 `alarm` 条件）时，它**看不见**。
     *   ⇒ 这里只锁两条**组件源码里的形状**，两条合起来才是「同值不同义」的完整护栏。
     *
     * ⚠️ 判据一律**先剥注释再匹配**：组件注释里本来就有「按已过站数算」「stopsAway === 0」这类
     *   **说明性文字**（解释另一种错误公式），按字面匹配会假红/假绿。
     */
    const codeOnly = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    const subStart = navDetail.indexOf("const postSub = useMemo(");
    const subEnd = subStart >= 0 ? navDetail.indexOf("}, [infoMode", subStart) : -1;
    const subCode = subStart >= 0 && subEnd > subStart ? codeOnly(navDetail.slice(subStart, subEnd)) : "";
    const hasMissedEarly = subCode !== "" && /if\s*\(\s*missedStop\s*\)\s*return/.test(subCode);
    ok(
      hasMissedEarly,
      "接线：postSub 对「已过站」有提前返回（车驶离下车站不落到「还有 0 站」句式）",
      subCode === ""
        ? "✗ 未能定位 postSub 函数体（函数被改名/重构？本断言因此无法判定）"
        : hasMissedEarly
          ? "已确认 missedStop 提前返回"
          : "未见 missedStop 提前返回 ⇒ 车驶离下车站会渲染「还有 0 站下车」",
    );
    /**
     * ★ 最要紧的一条：`missedStop` 的判据必须**同时**含两个条件。
     *   正常到站（`alarm="now"`）与已过站**共用 `stopsAway === 0` 这一个值，语义相反**；
     *   只看站数就会把「到了，请下车」说成「已过站」—— 比原来的「还有 0 站」更严重的错。
     */
    {
      const mStart = navDetail.indexOf("const missedStop =");
      const mLine = mStart >= 0 ? codeOnly(navDetail.slice(mStart, navDetail.indexOf("\n", mStart))) : "";
      ok(
        /stopsAway\s*===\s*0/.test(mLine) && /alarm\s*===\s*"none"/.test(mLine),
        "接线：missedStop 判据同时含「站数 0」与「alarm=none」（防把到站说成坐过站）",
        mLine.trim() || "✗ 未找到 const missedStop 定义",
      );
    }
    ok(
      rideEngine.includes('prog.atIdx === alightIdx ? "now" : prog.nextIdx === alightIdx ? "soon" : "none"'),
      "复刻锁定：alarm 判据与引擎内联表达式逐字一致（改了这里必须同步本脚本）",
    );
  }
}

console.log(
  failed === 0
    ? "\n✅ 全通过（客户端兜底 / 服务端基准 / 两路恒等 / 渲染口径 / 变异自检 / 三数自洽）"
    : `\n❌ ${failed} 项失败`,
);
process.exit(failed === 0 ? 0 : 1);
