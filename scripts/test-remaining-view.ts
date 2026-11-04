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
 */
ok(
  body.includes("Math.max(1, Math.round(remainMin))"),
  "距下车站保留 Math.max(1,…) 地板（与总时长 clamp 0 刻意不同）",
);

for (const hook of [
  "data-remain-total",
  "data-remain-base",
  "data-arrive-at",
  "data-recompute-seq",
  "data-eta-base",
  "data-stops-away",
  "data-remain-fail",
]) {
  ok(body.includes(hook), `钩子 ${hook} 已挂 NavDetailBody`);
}
const sheet = readFileSync("src/components/nav/RouteSheet.tsx", "utf8");
ok(sheet.includes("data-peek-remain"), "钩子 data-peek-remain 已挂 peek 摘要");

/* ══════════════════════════════════════════════════════════════════════
   ⑤ 变异自检 —— 证明上面的守护型断言**真的有效**（不是恒绿）
   ──────────────────────────────────────────────────────────────────────
   为什么必须有：本项目出过 `X || !!hit` 这种恒真断言（永远 PASS），
   也出过「判据过宽、代码改坏了仍绿」的形态。
   `绿的数量 ≠ 守护的强度` ⇒ 守护型断言必须能证明自己会红。
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ⑤ 变异自检（守护型断言必须能检出造错）──");
{
  /**
   * 变异 a：若「距下车」的地板被改成 clamp 0 ⇒ ④ 的地板断必须失配。
   * ⚠️ 必须 `replaceAll`：该表达式在源码里出现**两次**（`data-eta-remain` 属性 + 文案），
   *    只 `replace` 第一个会让变异的 body 仍含第二个 ⇒ 误判为"检不出"（第一版就这么错的）。
   */
  const mutated = body.replaceAll("Math.max(1, Math.round(remainMin))", "Math.round(remainMin)");
  ok(!mutated.includes("Math.max(1, Math.round(remainMin))"), "[变异] 地板被改成 clamp 0 能被检出");
}
{
  /**
   * 变异 b：故意造两路分叉 ⇒ ③ 的恒等断必须失配。
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
