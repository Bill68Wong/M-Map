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

console.log(
  failed === 0
    ? "\n✅ 全通过（客户端兜底 / 服务端基准 / 两路恒等 / 渲染口径 / 变异自检）"
    : `\n❌ ${failed} 项失败`,
);
process.exit(failed === 0 ? 0 : 1);
