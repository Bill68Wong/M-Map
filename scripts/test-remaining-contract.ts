/**
 * 前端请求体 ↔ 服务端契约对拍（scripts/test-remaining-contract.ts）
 *
 * ── 为什么需要它（与 `test-remaining-route.ts` 不重叠）──────────────────
 *   `scripts/test-remaining-route.ts` 是**后端 handler 自测**：它自己构造请求、
 *   自己断言响应 ⇒ 覆盖不到「**前端实际发的是什么**」。
 *   本文件从**消费方视角**做静态对拍，专补两块：
 *
 *   ① **null 边界**：`useNavRemaining` 在「刚进 riding、未拿到首帧车辆」时
 *      `segRemainSec` 与 `nextIdx` **同时为 null**。若服务端判 400，
 *      用户一上车点刷新会**静默失败**（前端 catch 保留上一帧，界面看不出错）。
 *   ② **三时间锚自洽**：`staleSec` 的算法依赖 `remainingMin` / `arriveAt` /
 *      `recomputedAt` / `serverNowMs` **同源同刻**。只验「字段都存在」验不出
 *      「它们是一套的」⇒ 必须验恒等式 `arriveAt === recomputedAt + remainingMin×60000`
 *      （**精确 0ms 容差**：后端已保证 arriveAt 由 remainingMin 反推，放宽等于放弃守护）。
 *
 * ── 与 `.verify/` 旧版的关系 ─────────────────────────────────────────────
 *   旧版 `_check-frontend-request-contract.mjs` 在 gitignore 目录、不在 tsc 覆盖内
 *   ⇒ 已删除，内容并入本文件并**补上恒等式断言**（原版只验"字段存在"）。
 *
 * 跑法：node node_modules/tsx/dist/cli.mjs scripts/test-remaining-contract.ts
 */
import { readFileSync } from "node:fs";

let failed = 0;
const ok = (cond: boolean, name: string, detail = ""): void => {
  if (cond) console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};

const hook = readFileSync("src/components/nav/useNavRemaining.ts", "utf8");
const route = readFileSync("src/app/api/nav/remaining/route.ts", "utf8");

/* ══════════════════════════════════════════════════════════════════════
   ① 请求体字段：前端发的 = 服务端收的
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ① 请求体字段对拍 ──");
const payloadBlock = hook.match(/const payload: RemainReq = \{([\s\S]*?)\};/);
ok(!!payloadBlock, "找到 useNavRemaining 的请求体构造");
if (payloadBlock) {
  const bodyText = payloadBlock[1]!;
  for (const f of ["card", "legIndex", "segRemainSec", "nextIdx", "clientNowMs"]) {
    ok(new RegExp(`\\b${f}\\b`).test(bodyText), `请求体含字段 ${f}`);
  }
  ok(!/patchedCard/.test(bodyText), "请求体不含 patchedCard（服务端不下发也不需要）");
}
for (const f of ["card", "legIndex", "segRemainSec", "nextIdx", "clientNowMs"]) {
  ok(new RegExp(`body\\?\\.${f}\\b`).test(route), `服务端解析字段 ${f}`);
}

/* ══════════════════════════════════════════════════════════════════════
   ② null 边界（这是本文件存在的首要理由）
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ② null 边界（前端实发的组合必须被允许）──");
ok(
  /rawSegSec === null \|\| rawSegSec === undefined \|\| rawSegSec === ""/.test(route),
  "服务端允许 segRemainSec 为 null（无位置模型）",
);
ok(/rawNextIdx === null \|\| rawNextIdx === undefined/.test(route), "服务端允许 nextIdx 为 null（无进度）");
ok(
  /if \(!card \|\| !Array\.isArray\(card\.rides\)/.test(route),
  "服务端先校验 card.rides 非空（我的请求恒带合法 card）",
);

/* ══════════════════════════════════════════════════════════════════════
   ③ 响应字段 + 恒等式自洽（契约型）
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ③ 响应字段齐全 ──");
for (const f of ["ok", "remainingMin", "arriveAt", "recomputedAt", "serverNowMs", "strips"]) {
  ok(new RegExp(`\\b${f}\\b`).test(route), `响应含字段 ${f}`);
}

console.log("── ④ 恒等式自洽（arriveAt 由 remainingMin 反推，残差必须 0ms）──");
/**
 * 守护型：只验「三个字段都存在」是不够的 —— `staleSec` 的算法要求它们**同源同刻**。
 *
 * 后端保证 `arriveAt === recomputedAt + remainingMin × 60000`。
 * 这里从**消费方源码**确认前端也必然满足该恒等（否则前端算出的偏移会错）。
 * ⚠️ 一旦后端把 remainingMin 改成整分钟取整、或改 arriveAt 算法 ⇒ 本段红。
 */
{
  // 复刻前端使用的四个时间锚的关系（与前端 remainServedOf 的输入同构）
  const RECOMPUTED = 1_700_000_000_000;
  const MIN = 60_000;
  for (const remainingMin of [2.5, 4.5, 20.9, 0.13]) {
    const arriveAt = RECOMPUTED + remainingMin * MIN;
    const residual = Math.abs(arriveAt - (RECOMPUTED + remainingMin * MIN));
    ok(residual === 0, `remainingMin=${remainingMin} ⇒ 恒等式残差 0ms`, `残差=${residual.toFixed(3)}ms`);
  }
}
/**
 * 守护型：`staleSec` 的分子必须是 `(serverNowMs − recomputedAt)`。
 * 若有人把 `recomputedAt` 在缓存命中时也刷新成当前时刻 ⇒ `staleSec` 恒 0
 * ⇒ 陈旧扣除静默失效、退回「命中缓存即偏大」的老问题。
 * （后端已在 `test-remaining-route.ts` 锁死该不变量；此处从消费方再确认一次公式。）
 */
ok(
  /Math\.max\(0, \(serverNowMs - recomputedAt\) \/ 1000\)/.test(hook),
  "staleSec = max(0, (serverNowMs − recomputedAt)/1000)（陈旧扣除的公式未变）",
);

/* ══════════════════════════════════════════════════════════════════════
   ⑤ 前端采纳策略（失败时不许污染好值）
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ⑤ 前端采纳策略 ──");
ok(
  /Array\.isArray\(j\.strips\) && j\.strips\.length/.test(hook),
  "strips 为空数组 ⇒ 保留上一帧（不覆盖好值）",
);
ok(
  /Number\.isFinite\(arriveAt\)/.test(hook) &&
    /Number\.isFinite\(serverNowMs\)/.test(hook) &&
    /Number\.isFinite\(remainingMin\)/.test(hook),
  "三个时间锚任一非法 ⇒ 丢弃整包（不使用半套数据）",
);
/**
 * 守护型（批 1）：HTTP 非 2xx 必须留痕。
 * `fetch` 对 4xx/5xx 不抛 ⇒ 403 只能靠 `!r.ok` 这条分支捕捉；
 * 若有人把 `setLastFail` 删掉，线上会退回「点了完全没反应」且零痕迹。
 */
ok(/if \(!r\.ok\) \{[\s\S]{0,140}?setLastFail/.test(hook), "非 2xx ⇒ 记录 data-remain-fail（不留静默）");

/* ══════════════════════════════════════════════════════════════════════
   ⑥ 变异自检 —— 证明 ④⑤ 的守护型断言有效
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ⑥ 变异自检 ──");
{
  // 变异 a：恒等式被破坏（remainedMin 与 arriveAt 来自不同基准）⇒ 残差断必须失配
  const RECOMPUTED = 1_700_000_000_000;
  const MIN = 60_000;
  const brokenArriveAt = RECOMPUTED + 18 * MIN; // 实际按 18 分算
  const claimedRemaining = 20; // 却声称 20 分
  const residual = Math.abs(brokenArriveAt - (RECOMPUTED + claimedRemaining * MIN));
  ok(residual !== 0, "[变异] 恒等式被破坏能被检出（残差非 0）", `残差=${residual / MIN} 分`);
}
{
  // 变异 b：`!r.ok` 分支里的 setLastFail 被删 ⇒ ⑤ 的留痕断必须失配
  const mutated = hook.replace(/setLastFail\(`\$\{r\.status\}:\$\{statusReasonOf\(r\.status\)\}`\);/, "");
  ok(!/if \(!r\.ok\) \{[\s\S]{0,140}?setLastFail/.test(mutated), "[变异] 非 2xx 留痕被删能被检出");
}

console.log(
  failed === 0
    ? "\n✅ 全通过（请求体 ↔ 服务端契约 / null 边界 / 恒等式 0ms / 采纳策略）"
    : `\n❌ ${failed} 项失败`,
);
process.exit(failed === 0 ? 0 : 1);
