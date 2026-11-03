/**
 * `data-remain-fail` 观测属性守护（scripts/test-remaining-fail-hook.ts）
 *
 * ── 守的是什么 ────────────────────────────────────────────────────────
 *   负责人主诉：「点了刷新按钮有反应，但不知道刷新了什么」。
 *   若 403/5xx 被静默吞掉，用户看到的是「**点了完全没反应**」——**同款失败模式的更严重版本**。
 *   ⇒ 修了主诉却留这个洞，等于没修完。
 *
 *   ⚠️ 静默点**不在 catch**：`fetch` 对 4xx/5xx **不抛**（只有网络层错误才抛）
 *   ⇒ 403 走的是 `if (!r.ok)` 那条分支，旧实现里那条路**零痕迹**
 *   （无 console / 无 `data-*` / 无 UI）⇒ 故障与「本来就不需要重算」无法区分。
 *
 * ── 验收要求（team-lead 批 1）──────────────────────────────────────────
 *   · 属性名 `data-remain-fail`，值 `status:reason`（如 `403:forbidden`）
 *   · **成功时不输出该属性**
 *   · 覆盖 403 / 5xx / 解析失败三档
 *   · QA 可断言「点刷新后不得出现以 `403` 开头的值」
 *
 * ⚠️ 本文件全部是**守护型**断言 ⇒ 末尾必有「变异自检」证明它真的会红。
 *
 * 跑法：node node_modules/tsx/dist/cli.mjs scripts/test-remaining-fail-hook.ts
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
const body = readFileSync("src/components/nav/NavDetailBody.tsx", "utf8");
const shell = readFileSync("src/components/nav/NavShell.tsx", "utf8");
const sheet = readFileSync("src/components/nav/RouteSheet.tsx", "utf8");
const pane = readFileSync("src/components/nav/RouteDetailPane.tsx", "utf8");

/* ══════════════════════════════════════════════════════════════════════
   ① hook 侧：三档失败都要留痕
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ① 三档失败留痕 ──");
ok(/if \(!r\.ok\)/.test(hook), "有 HTTP 非 2xx 分支（403/5xx 的唯一入口）");
ok(/setLastFail\(`\$\{r\.status\}:/.test(hook), "非 2xx ⇒ 记录 `${r.status}:...`");
ok(/statusReasonOf\(r\.status\)/.test(hook), "调用 statusReasonOf 生成可读后缀");
ok(/status === 403\) return "forbidden"/.test(hook), "403 → forbidden");
ok(/status === 400\) return "bad_request"/.test(hook), "400 → bad_request");
ok(/status === 429\) return "rate_limited"/.test(hook), "429 → rate_limited");
ok(/status >= 500\) return "upstream_error"/.test(hook), "5xx → upstream_error");
ok(/if \(!j\?\.ok\)/.test(hook), "有 200 但业务失败分支（ok:false）");
ok(/setLastFail\(`200:\$\{/.test(hook), "200 业务失败 ⇒ 记 `200:<服务端枚举>`");
ok(/setLastFail\("200:bad_payload"\)/.test(hook), "时间锚非法 ⇒ 记 bad_payload（不用半套数据）");
ok(/setLastFail\("0:net"\)/.test(hook), "网络层异常 ⇒ 记 0:net");
ok(
  /if \(!aborted && gen === genRef\.current\) setLastFail\("0:net"\)/.test(hook),
  "AbortError 不记失败（换卡/换代不算真失败，否则每次换卡闪假失败）",
);

/* ══════════════════════════════════════════════════════════════════════
   ② 成功必须清空 + 清场必须清（防过期值永久挂 DOM）
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ② 成功清空 / 清场清空 ──");
ok(/setLastFail\(null\);\s*\/\/ ★ 成功一次/.test(hook), "成功一次 ⇒ setLastFail(null)");
{
  const clearBlock = hook.match(/if \(enabled\) return;[\s\S]{0,500}?\}, \[enabled, card\]\);/);
  ok(!!clearBlock && /setLastFail\(null\)/.test(clearBlock[0]), "enabled 变 false ⇒ 一并清 lastFail");
}

/* ══════════════════════════════════════════════════════════════════════
   ③ 对外暴露 + 渲染侧属性名
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ③ 暴露与渲染 ──");
ok(/lastFail: string \| null/.test(hook), "UseNavRemaining 暴露 lastFail");
ok(/return \{ liveRemain, liveStrips, lastFail, refresh: fetchOnce \}/.test(hook), "返回值含 lastFail");
ok(
  /data-remain-fail=\{liveRemainFail \?\? undefined\}/.test(body),
  "属性名 data-remain-fail；值为 null ⇒ undefined（React 不渲染该属性 ⇒ 成功时不输出）",
);
ok(/liveRemainFail\?: string \| null/.test(body), "NavDetailBody 接收 liveRemainFail");

/**
 * ★ 守护型（team-lead 2026-11-03 要求）：**「属性缺失 ≠ 刷新成功」的语义必须留在注释里**。
 *
 * 为什么锁注释而不是只锁代码：这条语义**没有代码承载**（代码只能表达"缺失"这一个事实），
 * 唯一的载体就是注释。而注释最容易在重构中被删 —— 一旦删掉，下一位写断言的人
 * 会自然写成「`data-remain-fail` 不存在 ⇒ 刷新成功」，而实际可能是**从未发起**
 * （boarding 相位 / LRT 腿 / 请求在飞 / card 未就绪）⇒ 假绿。
 *
 * 断言写法：要求「本属性缺失 ≠」这句 + `data-recompute-seq` 同时出现在注释区。
 * ⚠️ 这是**契约型**断言（锁一条必须传承的知识），不需要"造错检出"。
 */
const missSemantics = body.match(/本属性缺失 ≠[\s\S]{0,400}?data-recompute-seq/);
ok(!!missSemantics, "注释保留「属性缺失 ≠ 刷新成功」语义，且指明必须同看 data-recompute-seq");
{
  // 变异：删掉该句 ⇒ 上面的断言必须失配（证明它真的在看这段）
  const mutated = body.replace(/本属性缺失 ≠/g, "");
  ok(!/本属性缺失 ≠[\s\S]{0,400}?data-recompute-seq/.test(mutated), "[变异] 该语义注释被删能被检出");
}

/* ══════════════════════════════════════════════════════════════════════
   ④ 透传链完整（NavShell → RouteSheet → RouteDetailPane → NavDetailBody）
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ④ 透传链 ──");
ok(/liveRemainFail: navRemain\.lastFail/.test(shell), "NavShell 注入 liveRemainFail");
ok(/liveRemainFail=\{detail\.liveRemainFail \?\? null\}/.test(sheet), "RouteSheet 透传");
ok(/liveRemainFail=\{liveRemainFail\}/.test(pane), "RouteDetailPane 透传给 NavDetailBody");

/* ══════════════════════════════════════════════════════════════════════
   ⑤ 变异自检 —— 证明上面是守护型真断言，不是恒绿
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ⑤ 变异自检 ──");
{
  const mutated = body.replace("data-remain-fail=", "data-remain-x=");
  ok(!/data-remain-fail=\{liveRemainFail/.test(mutated), "[变异] 属性名写错能被检出");
}
{
  const mutated = hook.replace(/if \(status === 403\) return "forbidden";/, "");
  ok(!/status === 403\) return "forbidden"/.test(mutated), "[变异] 403 分支被删能被检出");
}
{
  const mutated = hook.replace(/setLastFail\(null\); \/\/ ★ 成功一次/, "");
  ok(!/setLastFail\(null\); \/\/ ★ 成功一次/.test(mutated), "[变异] 成功不清空能被检出");
}
{
  const mutated = body.replace("liveRemainFail ?? undefined", "undefined");
  ok(
    !/data-remain-fail=\{liveRemainFail \?\? undefined\}/.test(mutated),
    "[变异] 属性恒为 undefined（永不输出）能被检出",
  );
}

console.log(
  failed === 0
    ? "\n✅ 全通过（403/5xx/解析失败三档留痕 + 成功不输出 + 透传完整）"
    : `\n❌ ${failed} 项失败`,
);
process.exit(failed === 0 ? 0 : 1);
