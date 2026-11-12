/**
 * /api/nav/remaining handler 级 smoke（临时探针，**非交付物**）
 *
 * ⚠️⚠️ **本文件不在 tsc 覆盖内**（根 tsconfig 的 `include` 用 `**` 通配，但 TypeScript glob
 *   **不匹配点目录** .verify/）⇒ 字段改名时需**手工核对**。它依赖的类型字段名（逐个列出）：
 *     RecommendCard: planId / summary / fromSlug / toSlug / totalMin / arriveAt
 *                    / walkOut{minutes,toLabel,level,estimated,samples,distanceM}
 *                    / walkIn{同上} / rides[] / transfers[] / hints / crossBorder
 *     RideLegView:   route / kind / board / alight / boardLabel / alightLabel
 *                    / minutes / hops / levels / waitMin / liveText / tier / tierText / tierHint
 *     RecStatic:     routeIdx{dirStops, nameOf}
 *     响应：          ok / remainingMin / arriveAt / recomputedAt / serverNowMs / strips[].rideMin
 *   长期值守已迁到 `scripts/`（tsc 会检查）；它**强依赖真实库**。
 *   ⚠️ **它就在 `verify` 链里**（`verify` → `test:remaining-all` → `test:remaining-route`），
 *      所以 **fail-closed（连库失败 exit 1）会让无库环境下整条 verify 链变红** —— 这是刻意取舍。
 *
 * 目的：跳过 HTTP 层，直接构造 `NextRequest` 调 `POST`，验证
 *   ① 无 Origin/Referer ⇒ 403（同源校验生效）
 *   ② 跨站 Origin ⇒ 403
 *   ③ 缺 card / legIndex 越界 / planId 非数值 ⇒ 400
 *   ④ 正常调用 ⇒ 200 + 三时间字段 + strips
 *   ⑤ 命中进程内微缓存 ⇒ recomputedAt 保持、serverNowMs 变新
 *   ⑥ 不同 OD 但同 planId 的卡 **不得** 互相命中（缓存键指纹回归）
 *
 * 跑法：node node_modules/tsx/dist/cli.mjs scripts/test-remaining-route.ts
 *
 * ── 为什么从 `.verify/` 迁到这里（2026-11-03 二轮）────────────────────────
 *   `.verify/` 被 `.gitignore:51` 忽略 ⇒ **不入库**，队友 checkout 看不到（前端就报了「文件不存在」）；
 *   且它不在 tsc 覆盖内（点目录不被 glob 匹配）⇒ 字段改名会静默腐坏。
 *   ⇒ 迁到 `scripts/`：入库、tsc 会检查、队友可直接跑。
 *   ⚠️ 它**强依赖真实库**（用真实 `route_stations` 造卡）。
 *   ★ 批 4 / T5 口径变更：连库失败原为「整体跳过、不判失败（exit 0）」，现改为 **fail-closed**
 *     （打印 `❌ 连库失败 ⇒ 判失败` 后 `exit 1`）。原因：`SKIP + exit 0` 是假绿出口 ——
 *     库不可达时整轮记 0 条并以 0 退出，会被人当「通过」，等于门禁不存在。
 *     ⚠️ **代价必须说清**：本脚本在 `verify` 链内（`test:remaining-all` 的成员之一），
 *        所以无库环境下**整条 verify 会红**。这是刻意的 —— 宁可红，也不给「0 条即通过」留口子。
 */
// ★ 2026-11-12 修：原为作者机绝对路径 `D:/Projects/University/Studio/musttoukou/.env` ⇒ 队友 checkout 后
//   本脚本在读 .env 时即 ENOENT，整条 verify 必红（判据：npm run verify 停在 test:remaining-route）。
//   改为无参 loadEnvFile()（读 cwd/.env），与 db/* 既有无参体例一致。
//   注意：这里用 try/catch **不削弱 fail-closed** —— .env 缺失 ⇒ DATABASE_URL 缺失 ⇒ 下方连库失败照样 exit 1。
try {
  process.loadEnvFile();
} catch {
  /* .env 不存在：交给下方连库失败路径判红 */
}

import { NextRequest } from "next/server";
import { POST } from "../src/app/api/nav/remaining/route";
import { getPool } from "../src/lib/db";
import { loadStatics, type RecStatic } from "../src/lib/recommend/query";
import type { RecommendCard } from "../src/lib/recommend/types";

let pass = 0;
let fail = 0;
/**
 * ★ 批 4 / T5（D）：⑤ 里 5 条不变量要求「两次请求落在同一个 2s 桶」。
 *   桶 = `Math.floor(nowMs / CACHE_TTL_MS)`（`route.ts:211`）⇒ 跨桶必 miss。
 *   **先把时钟对齐到桶内**（见 ③b），判据就变成确定性的。
 *   ⚠️ miss 直接由 :356 那条断言判 FAIL，**不设独立跳过计数** ——
 *     否则同一次 miss 会既记 FAIL 又记 SKIP（同一事件判两次）。
 */
const CACHE_TTL_MS = 2_000;
const CACHE_HEADROOM_MS = 1_500;
/** ③b 对齐后实测的桶余量（ms），仅用于诊断输出：区分「环境慢跨桶」还是「缓存真坏了」 */
let bucketRemMs = -1;
/** ④ 首次调用与 ⑤ 第二次调用的间隔（ms），同上 */
let cacheGapMs = -1;
/** ④ 首次调用时刻，供 ⑤ 算间隔 */
let firstCallAtMs = 0;

const round1 = (v: number): number => Math.round(v * 10) / 10;
const ok = (c: boolean, label: string, extra = "") => {
  if (c) {
    pass++;
    console.log(`  PASS  ${label}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.error(`  FAIL  ${label}${extra ? "  " + extra : ""}`);
  }
};

const HOST = "localhost:3000";

function reqWith(body: unknown, origin: string | null): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json", host: HOST };
  if (origin) headers.origin = origin;
  return new NextRequest(`http://${HOST}/api/nav/remaining`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** 用真实索引造一张单段卡（前 3 站），可控 planId */
function mkCard(st: RecStatic, planId: number, routeKey: string, minutes: number): RecommendCard {
  const [route] = routeKey.split("|") as [string, string];
  const stops = st.routeIdx.dirStops.get(routeKey)!;
  const board = stops[0]!;
  const alight = stops[2]!;
  return {
    planId,
    summary: "smoke",
    fromSlug: "home",
    toSlug: "school",
    totalMin: 30,
    arriveAt: Date.now() + 30 * 60_000,
    walkOut: { minutes: 3, toLabel: board, level: 1, estimated: false, samples: 5, distanceM: 200 },
    walkIn: { minutes: 2, toLabel: "目的地", level: 1, estimated: false, samples: 5, distanceM: 130 },
    rides: [
      {
        route,
        kind: "bus",
        board,
        alight,
        boardLabel: st.routeIdx.nameOf.get(board) ?? board,
        alightLabel: st.routeIdx.nameOf.get(alight) ?? alight,
        minutes,
        hops: 2,
        levels: [2, 2],
        waitMin: 3,
        liveText: "",
        tier: 3,
        tierText: "",
        tierHint: "",
      },
    ],
    transfers: [],
    hints: [],
    crossBorder: false,
  };
}

(async () => {
  console.log("═══ /api/nav/remaining handler smoke（连库；**库不可达则判失败**，fail-closed）═══\n");

  let st: RecStatic;
  let pool: ReturnType<typeof getPool>;
  try {
    process.loadEnvFile();
    pool = getPool();
    st = await loadStatics(pool);
  } catch (e) {
    // ★ 批 4 / T5：原写法 `SKIP + process.exit(0)` 是**假绿出口** —— 库不可达时整轮记 0 条并
    //   以 0 退出，CI 与 `verify` 都会当它通过，等于「门禁不存在」。改为 fail-closed。
    console.log(`  ❌ 连库失败（${(e as Error).message}）⇒ 判失败（fail-closed，不跳过）`);
    console.log(`\n═══ 合计 0 条：PASS 0 / FAIL 1（连库失败，非 SKIP）═══`);
    process.exit(1);
  }

  const keys = [...st.routeIdx.dirStops.keys()]
    .filter((k) => !k.startsWith("LRT-") && (st.routeIdx.dirStops.get(k)?.length ?? 0) >= 4)
    .sort();
  const keyA = keys[0]!;
  const keyB = keys[1] ?? keys[0]!;

  const cardA = mkCard(st, 1, keyA, 6);
  const cardB = mkCard(st, 1, keyB, 9); // ★ 同 planId、不同路线

  /* ① 无 Origin/Referer —— 并**证明那条 403 日志真的会打出来** */
  {
    /**
     * ⚠️ 为什么必须断言「日志打出来」而不只是断言「返回 403」：
     *
     *   客户端侧 **403 是完全静默的**（前端已核实、我复核确认）：
     *     `fetch` 对 4xx **不 throw** ⇒ 不走 `catch`
     *     ⇒ 走的是 `if (!j?.ok) return;`（`useNavRemaining.ts`）⇒ **连 catch 都不进**
     *     ⇒ 无 console / 无 data 属性 / 无 UI。
     *   更糟：`data-recompute-seq` 不涨也无法判定 —— 因为「本来就不需要重算」同样不涨
     *     ⇒ **故障表现与「没触发」完全无法区分**。
     *
     *   ⇒ 服务端这条 `console.warn` 是**线上唯一的可观测痕迹**。
     *     它一旦失效（例如被后来人删掉、或 logger 被收口），403 将变成
     *     「全量静默失败」——用户看到刷新毫无反应，日志里什么都没有。
     *   ⇒ 所以本断言锁的是「唯一的诊断通道还在」，而不只是「校验逻辑正确」。
     */
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map((a) => String(a)).join(" "));
    };
    let res: Response;
    try {
      res = await POST(reqWith({ card: cardA, legIndex: 0 }, null));
    } finally {
      console.warn = origWarn;
    }
    ok(res.status === 403, "无 Origin/Referer ⇒ 403（fail-closed）", `实际 ${res.status}`);
    const j = (await res.json()) as { error?: string };
    ok(j.error === "forbidden", "错误码 = forbidden（闭集内）", `实际 ${j.error}`);

    const hit = warns.find((w) => w.includes("[api/nav/remaining]") && w.includes("同源校验"));
    ok(!!hit, "★ 403 时**必须**打出诊断日志（客户端侧静默 ⇒ 这是唯一可观测痕迹）", hit ? `已打：${hit.slice(0, 90)}…` : "未打！");
    /**
     * ⚠️ 判据宽度纪律（前端提出，我采纳并据此收紧了这里的**标签**）：
     *   下面这两条只断言「字段名在日志里」，**不能**证明「能判断 host 不匹配」——
     *   因为平铺数组 `ownHosts=[a,b,c]` 同样含 `ownHosts=`。
     *   ⇒ 原标签写「否则无法判断是 host 不匹配还是缺 Origin」是**过度承诺**（标签声称的
     *     强于判据能保证的）。真正兑现该承诺的是**下一条**（要求出现 xfwd/host/url 来源名）。
     *   ⇒ 这里把标签改成它实际保证的事，避免下一个人以为"这条绿了就说明能诊断"。
     *     这与本轮我犯过的「注释承诺了能力、实现没兑现」是同一形态，只是发生在注释→标签之间。
     */
    ok(!!hit && hit.includes("ownHosts="), "  日志出现 ownHosts 字段（**仅证字段名存在**，格式是否可诊断看下一条）");
    // `origin=` 必须能与「缺失」区分：缺失时打 `<none>`，有值时打具体域名 —— 两者都含 `origin=`，
    //   故这里进一步要求**二者之一**出现，证明这个字段总是有可读取值。
    ok(
      !!hit && (hit.includes("origin=<none>") || /origin=[^\s<]/.test(hit)),
      "  日志的 origin 有可读取值（`<none>` 或具体域名，二者都能用于判断缺 Origin）",
      hit ? (hit.match(/origin=\S+/)?.[0] ?? "") : "",
    );
    /**
     * ★ 来源标签（前端提的可诊断性缺陷，已修）：
     *   旧实现把三个 host 平铺成 `["a","b","c"]` ⇒ 出事时**无法判断哪个 header 不匹配**，
     *   而"哪个"恰恰决定修哪里（xfwd=代理链注入 / host=上游覆盖 / url=nextUrl 被改写）。
     *   ⇒ 现要求日志里三个**来源名**都出现。一致时打 `(三方一致)` 单值形态，
     *     不一致时打 `{xfwd,host,url}` 结构 —— 两种形态都必须能看出谁是谁。
     */
    ok(
      !!hit && (hit.includes("xfwd") || hit.includes("三方一致")),
      "  ★ 日志带来源标签（xfwd/host/url 或显式「三方一致」）—— 否则无法判断修哪里",
      hit ? hit.match(/ownHosts=[^ ]*/)?.[0] ?? "" : "",
    );
    // 反向：日志不得泄露凭据/body/完整 URL（AC-50d 的精神）
    ok(
      !!hit && !hit.includes("cookie") && !hit.includes("authorization") && !hit.includes("http://"),
      "  日志不含凭据 / 完整 URL（只记 host 级信息）",
    );
    /**
     * 缺失的 header 必须**显式保留为 null**，不能被 `filter(Boolean)` 丢掉。
     *
     * 为什么这条是真断言（不是凑数）：如果丢掉，「该 header 不存在」与「该 header 存在且
     * 与别人相同」在日志里表现一致（都少一项）⇒ 而这两者的修法完全不同
     * （前者是平台没注入、后者是注入值不对）。
     *
     * 本地实况：`x-forwarded-host` 不存在 ⇒ `xfwd=null`；`host` 与 `nextUrl.host`
     * 都是 `localhost:3000` ⇒ 三方不一致 ⇒ 必然打结构化形态 ⇒ 日志里必须出现 `"xfwd":null`。
     */
    ok(
      !!hit && hit.includes('"xfwd":null'),
      "  缺失的 header 显式保留为 null（本地无 x-forwarded-host ⇒ 应见 \"xfwd\":null）",
      hit ? `ownHosts 段：${hit.match(/ownHosts=[^ ]*/)?.[0] ?? "<未匹配>"}` : "",
    );
  }

  /* ② 跨站 Origin */
  {
    const res = await POST(reqWith({ card: cardA, legIndex: 0 }, "https://evil.example.com"));
    ok(res.status === 403, "跨站 Origin ⇒ 403", `实际 ${res.status}`);
  }

  /* ③ 非法入参 */
  {
    const same = `http://${HOST}`;
    const cases: [string, unknown][] = [
      ["缺 card", { legIndex: 0 }],
      ["rides 为空", { card: { ...cardA, rides: [] }, legIndex: 0 }],
      ["legIndex 越界", { card: cardA, legIndex: 5 }],
      ["legIndex 非数值", { card: cardA, legIndex: "x" }],
      ["planId 非数值", { card: { ...cardA, planId: undefined }, legIndex: 0 }],
      ["segRemainSec 负数", { card: cardA, legIndex: 0, segRemainSec: -1 }],
      ["rides 元素非法", { card: { ...cardA, rides: [{ route: 1 }] }, legIndex: 0 }],
    ];
    for (const [label, body] of cases) {
      const res = await POST(reqWith(body, same));
      const j = (await res.json()) as { error?: string };
      ok(res.status === 400 && j.error === "bad_request", `${label} ⇒ 400 bad_request`, `实际 ${res.status}/${j.error}`);
    }
  }

  /* ③b ★ 批 4 / T5（D）：把时钟对齐到 2s 桶内，让 ⑤ 的微缓存判据变成**确定性**的。
   *
   *   为什么需要：⑤ 要证明「同一个 planId 在桶内命中缓存」。缓存键含
   *     `Math.floor(nowMs / CACHE_TTL_MS)`（route.ts:211）⇒ 两次请求一旦跨桶必 miss。
   *   原写法是「先打一次，睡 60ms 再打一次」——若第一次恰好落在桶尾，第二次就跨桶，
   *   概率约 60/2000 ≈ 3% ⇒ ⑤ 的 5 条断言随机不跑（覆盖静默丢失，还会被误当成「环境问题」）。
   *
   *   做法：若当前桶余量不足 `CACHE_HEADROOM_MS`，先等到下一桶开头 +20ms。
   *   之后 ④ 与 ⑤ 的两次请求都落在同一桶的前 ~200ms 内（余量 1.5s 以上）。
   *   ⇒ 于是 miss 已经是一个**确定性的失败**：直接由 ⑤ 的 `cacheHit && …` 那条判 FAIL，
   *     **不设独立跳过计数**（否则同一次 miss 会既记 FAIL 又记 SKIP，同一事件判两次）。
   */
  {
    const rem = CACHE_TTL_MS - (Date.now() % CACHE_TTL_MS);
    if (rem < CACHE_HEADROOM_MS) await new Promise((r) => setTimeout(r, rem + 20));
    // 对齐后**重新量一次**：这才是 ④/⑤ 两次请求真正可用的桶余量，收尾红行要打它（自诊用）。
    bucketRemMs = CACHE_TTL_MS - (Date.now() % CACHE_TTL_MS);
  }

  /* ④ 正常调用（★ U3 后 `segRemainSec` 与 `nextIdx` 必须成对：nextIdx = 基准站） */
  let firstRecomputedAt = 0;
  let firstRemaining = 0;
  let firstArriveAt = 0;
  {
    firstCallAtMs = Date.now();
    const res = await POST(reqWith({ card: cardA, legIndex: 0, segRemainSec: 150, nextIdx: 2 }, `http://${HOST}`));
    ok(res.status === 200, "正常调用 ⇒ 200", `实际 ${res.status}`);
    ok(res.headers.get("cache-control") === "no-store", "cache-control: no-store");
    const j = (await res.json()) as {
      ok: boolean;
      remainingMin: number;
      arriveAt: number;
      recomputedAt: number;
      serverNowMs: number;
      strips: { rideMin: number }[];
    };
    ok(j.ok === true, "ok:true");
    // nextIdx=2 = 下车站本身（基准站=下车点）⇒ 基准站之后 0 跳 ⇒ 剩余 = 150s/60 + 末段 2
    ok(j.remainingMin === 4.5, "remainingMin = 2.5 + 2 = 4.5（基准站=下车站）", `实际 ${j.remainingMin}`);
    ok(j.arriveAt === j.recomputedAt + 4.5 * 60_000, "arriveAt = recomputedAt + remainingMin×60000");
    ok(Array.isArray(j.strips) && j.strips[0]!.rideMin === 2.5, "strips[0].rideMin = 2.5（整份下发）", `实际 ${j.strips?.[0]?.rideMin}`);
    ok(typeof j.serverNowMs === "number", "serverNowMs 有值（供客户端算时钟偏移）");
    ok(!("patchedCard" in j) && !("card" in j), "★ 响应不含 patchedCard / card（防污染前端加总）");
    firstRecomputedAt = j.recomputedAt;
    firstRemaining = j.remainingMin;
    firstArriveAt = j.arriveAt;
  }

  /* ④b ★ U3 口径：只传 `segRemainSec`（基准站未知）⇒ 必须回落**该段全量静态分钟**，
   *     不得把它当整段（那会少算基准站之后的跳，正是本次修的缺陷本体）。
   *     ⚠️ 每次换一个 `planId`：微缓存键**刻意不含** `segRemainSec/nextIdx`（`route.ts:100-127`），
   *        同 planId 在同一个 2s 桶内会命中上一条的旧值 ⇒ 本条会验到别人的结果。
   */
  {
    const same = `http://${HOST}`;
    const soloCard = { ...cardA, planId: 990001 };
    const solo = (await (await POST(reqWith({ card: soloCard, legIndex: 0, segRemainSec: 150 }, same))).json()) as {
      remainingMin: number;
      strips: { rideMin: number; stops: { minToNext?: number }[] }[];
    };
    const staticMin = soloCard.rides[0]!.minutes; // 6
    ok(
      solo.strips[0]!.rideMin === staticMin,
      `只传 segRemainSec ⇒ 本段按静态 ${staticMin} 分（不是 150s/60 = 2.5）`,
      `实际 ${solo.strips[0]!.rideMin}`,
    );
    ok(
      solo.remainingMin === round1(staticMin + (soloCard.walkIn?.minutes ?? 0)),
      "  剩余 = 本段静态 + 末段步行（保守偏长，不双计）",
      `实际 ${solo.remainingMin}`,
    );
    // 基准站 = 中间站 ⇒ 剩余必须恰好多出「中间站 → 下车站」那一跳（站条同源，不另造数字）
    const hop2 = Number(solo.strips[0]!.stops[1]?.minToNext ?? 0);
    const mid = (await (
      await POST(reqWith({ card: { ...cardA, planId: 990002 }, legIndex: 0, segRemainSec: 150, nextIdx: 1 }, same))
    ).json()) as { remainingMin: number };
    ok(
      Math.abs(mid.remainingMin - round1(2.5 + hop2 + (cardA.walkIn?.minutes ?? 0))) <= 0.06,
      `基准站=中间站 ⇒ 剩余 = 2.5 + 第二跳 ${hop2} + 末段（严格大于下车站基准的 4.5）`,
      `实际 ${mid.remainingMin}`,
    );
  }

  /* ⑤ 微缓存命中的**不变量**（team-lead / 前端共同依赖的那条） */
  {
    await new Promise((r) => setTimeout(r, 60));
    const res = await POST(reqWith({ card: cardA, legIndex: 0, segRemainSec: 150, nextIdx: 2 }, `http://${HOST}`));
    cacheGapMs = Date.now() - firstCallAtMs;
    const j = (await res.json()) as {
      recomputedAt: number;
      serverNowMs: number;
      remainingMin: number;
      arriveAt: number;
    };
    // ★ 批 4 / T5（D）：原为 `if (…) { ok(true, …) }` —— 判据在外层 if，`ok(true)` 只是打勾，
    //   却被日志打成 PASS，审计者会当成独立断言。改为**把等值条件挪进断言本体**，
    //   并用同一个布尔量做分支（等值只判一次，不两处各判一次）。
    //   ⚠️ 标题只声明本条**真正验到**的东西：值域（有限 / >0 / 不晚于现在）。
    //      「保持原值」由 `cacheHit` 与下方 `if` 保证，不体现在本行标题里（免得标题宽于实测）。
    // ⚠️ 防回归（别「简化」掉它）：`cacheHit` 必须**同时**留在断言条件与 if 分支里。
    //   ⑤ 其余 4 条断言全在 if 内（miss 时一条不跑），⑥ 在 miss 时两张卡各自重算仍各对各的
    //   ⇒ 一旦把 `cacheHit` 从断言里摘掉，一次 miss 会变成「0 红 + 总数 57→53 + 日志全绿」：
    //   门禁悄悄退化却**不报任何错**（tsc/eslint 都看不见，且它看起来像「去掉重复判断」）。
    //   这不是「分母可变」，是**无兜底的假绿通道**。
    const cacheHit = j.recomputedAt === firstRecomputedAt;
    ok(
      cacheHit && Number.isFinite(j.recomputedAt) && j.recomputedAt > 0 && j.recomputedAt <= Date.now(),
      "命中微缓存：recomputedAt 保持原值且为合法过去时刻（cacheHit + 值域，同条判定）",
      // 自诊用：真红时一眼分辨「环境慢/DB 抖动导致跨桶」（桶余量 < 间隔）还是「缓存真坏了」
      // （桶余量远大于间隔却仍 miss）——不必再回来读代码。
      `cacheHit=${cacheHit} recomputedAt=${j.recomputedAt} 桶余量=${bucketRemMs}ms 间隔=${cacheGapMs}ms`,
    );
    if (cacheHit) {
      ok(j.serverNowMs > firstRecomputedAt, "命中微缓存：serverNowMs 已刷新为新时刻");
      ok(j.remainingMin === firstRemaining, "命中微缓存：remainingMin 复用（与 recomputedAt 成对）");
      ok(j.arriveAt === firstArriveAt, "命中微缓存：arriveAt 也保持原值（与 remainingMin **成对**，不得单刷）");
      // ★ 这是前端 staleSec 能算对的前提：三者同源同刻
      ok(
        j.arriveAt === j.recomputedAt + j.remainingMin * 60_000,
        "★ 恒等式 arriveAt === recomputedAt + remainingMin×60000 在命中缓存时仍成立",
        `残差 ${j.arriveAt - (j.recomputedAt + j.remainingMin * 60_000)}ms`,
      );
    }
  }

  /* ⑥ 缓存键指纹：同 planId 不同路线不得串数据 */
  {
    const resA = await POST(reqWith({ card: cardA, legIndex: 0, segRemainSec: 150, nextIdx: 2 }, `http://${HOST}`));
    const resB = await POST(reqWith({ card: cardB, legIndex: 0, segRemainSec: 150, nextIdx: 2 }, `http://${HOST}`));
    const a = (await resA.json()) as { strips: { route: string; alight: string }[] };
    const b = (await resB.json()) as { strips: { route: string; alight: string }[] };
    ok(
      a.strips[0]!.alight === cardA.rides[0]!.alight && b.strips[0]!.alight === cardB.rides[0]!.alight,
      "★ 同 planId、不同路线的两张卡各拿各的 strips（缓存键含路线指纹）",
      `A=${a.strips[0]!.route}>${a.strips[0]!.alight} B=${b.strips[0]!.route}>${b.strips[0]!.alight}`,
    );
  }

  /* ⑦ 前端实际会发的 null 组合（无进度时）—— 必须合法 */
  {
    const same = `http://${HOST}`;
    const combos: [string, Record<string, unknown>][] = [
      ["segRemainSec=null + nextIdx=null", { card: cardA, legIndex: 0, segRemainSec: null, nextIdx: null }],
      ["segRemainSec=null（不传 nextIdx）", { card: cardA, legIndex: 0, segRemainSec: null }],
      ["两者都不传", { card: cardA, legIndex: 0 }],
      ["segRemainSec=null + nextIdx=1", { card: cardA, legIndex: 0, segRemainSec: null, nextIdx: 1 }],
      ["segRemainSec=0（刚到站）", { card: cardA, legIndex: 0, segRemainSec: 0 }],
    ];
    for (const [label, body] of combos) {
      const res = await POST(reqWith(body, same));
      const j = (await res.json()) as { ok?: boolean; remainingMin?: number; strips?: unknown[] };
      ok(
        res.status === 200 && j.ok === true,
        `前端实发组合合法：${label} ⇒ 200`,
        `实际 ${res.status}`,
      );
      ok(
        Array.isArray(j.strips) && j.strips.length > 0,
        `  ⇒ strips 恒为非空数组（前端以 length>0 才采纳）`,
        `实际 ${Array.isArray(j.strips) ? j.strips.length : "非数组"}`,
      );
      ok(
        typeof j.remainingMin === "number" && j.remainingMin >= 0,
        `  ⇒ remainingMin 有限且 ≥0`,
        `实际 ${j.remainingMin}`,
      );
    }
  }

  /* ⑧ ★ 同 planId + 同路线指纹、但不同 OD（不同末段步行）—— 不得互相命中 */
  {
    const same = `http://${HOST}`;
    // 同 planId、同线路同上落站，只有 walkIn.minutes 与末段时长不同（模拟「→学校」vs「→学校隔壁」）
    const odA = { ...cardA, walkIn: { ...cardA.walkIn, minutes: 2 } };
    const odB = { ...cardA, walkIn: { ...cardA.walkIn, minutes: 11 } };
    const ra = (await (await POST(reqWith({ card: odA, legIndex: 0, segRemainSec: 150, nextIdx: 2 }, same))).json()) as {
      remainingMin: number;
    };
    const rb = (await (await POST(reqWith({ card: odB, legIndex: 0, segRemainSec: 150, nextIdx: 2 }, same))).json()) as {
      remainingMin: number;
    };
    ok(
      rb.remainingMin - ra.remainingMin === 9,
      "★ 同 planId + 同路线指纹、不同末段步行 ⇒ 剩余相差 9 分（未被缓存串）",
      `A=${ra.remainingMin} B=${rb.remainingMin} 差=${round1(rb.remainingMin - ra.remainingMin)}`,
    );
  }

  /* ⑧b ★ 防回归：`coveredByPolicy` 已删，不得被重新引入 */
  {
    /**
     * 背景（架构师发现、我核实并删除）：`route-policy.ts` 曾导出 `coveredByPolicy(pathname)`，
     * 注释写「供门禁脚本判定覆盖率」，但 **v3.6.0 S2 引入起就零消费方**（出生即死代码），
     * 且对 `/api/nav/remaining` 返回 false —— 而该路径**确实**已被策略覆盖（覆盖在 handler 内）。
     *
     * 为什么必须删而不是补上：补上会让它返回 true，一旦有人接进门禁当「已覆盖」判据，
     * 门禁就会**跳过 GUARD_CALLS 调用点扫描** ⇒ **假绿**。
     * 误报（false）会让人多查一遍；假绿（true）会让人**永远不再查** —— 后者更危险。
     *
     * 本断言守的是「不许把它加回来」：任何 `coveredByPolicy` 的重新出现都应该触发讨论，
     * 而不是作为"方便的小工具"被悄悄加回。
     */
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/lib/security/route-policy.ts", "utf8");
    /**
     * 判定必须三步剥干净，否则会**误报红**（架构师指出 —— 而误报红比漏报更糟：
     * 人会把断言改宽，然后真的重新引入时就不红了）。
     *
     *   ① 剥块注释   —— 否则会匹配到我们记录删除原因的那段说明；
     *   ② 剥行注释   —— 同上；
     *   ③ **剥字符串字面量** —— 否则若将来某处出现 `"coveredByPolicy"` 这样的字符串
     *      （报错文案 / fixture JSON / 断言自身的提示文本），也会被匹配到。
     *
     * 判据用**声明形态**而非「包含该词」：
     *   `export function coveredByPolicy` = 真的声明了；
     *   `提到 coveredByPolicy`              = 不算。
     * 这两者必须分开 —— 与「注释承诺 vs 实现兑现」是同一类区分。
     */
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, " ") // ① 块注释
      .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ") // ② 行注释
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""') // ③ 双引号字符串
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''") // ③ 单引号字符串
      .replace(/`(?:[^`\\]|\\.)*`/g, "``"); // ③ 模板字符串
    const redeclared = /\bexport\s+(?:async\s+)?(?:function|const|let|var)\s+coveredByPolicy\b/.test(codeOnly);
    ok(
      !redeclared,
      "★ `coveredByPolicy` 不得被重新引入（假绿风险：返回 true 会让门禁跳过调用点扫描）",
      redeclared ? "✗ 又出现了！" : "已彻底移除（注释/字符串均已剥离后再判定）",
    );
  }

  /* ⑧c ★ 跨端一致性：只保留**别人脚本没有的**两条（避免三处维护同一件事） */
  {
    /**
     * ⚠️ 分工声明（重要，先读再改）：
     *   本段的 `data-remain-fail` 相关守护**大部分已由另外两个脚本覆盖**，不要重复实现：
     *     · `scripts/test-remaining-fail-hook.ts` —— 属性名/JSX 输出/403·400·429·5xx 映射/
     *       成功清空/透传链（NavShell→RouteSheet→RouteDetailPane→NavDetailBody）+ **4 项变异自检**
     *     · `scripts/test-remaining-contract.ts` —— 请求体↔服务端字段、null 边界、恒等式 0ms、
     *       采纳策略、「非 2xx ⇒ 记录 data-remain-fail」+ **2 项变异自检**
     *   ⇒ 那两份比我这段更全面（且带变异自检），**不要在本文件重复**。
     *
     * 本段只留两条**它们没有**、且属于「跨端」性质的：
     *   ① 前端 reason 词表 ⊆ 服务端 `API_ERROR` 枚举 —— 上面两份都只看前端内部，
     *      没有对照服务端枚举。若服务端把 `forbidden` 改名，前端会打出 `403:forbidden`、
     *      服务端日志写新名，**两边永远对不上且都不报错**。
     *   ② `!r.ok` 判定必须在 `r.json()` **之前** —— 顺序反了 4xx 的 body 会被先解析，
     *      语义上仍是"留痕"，但抛错/吞掉的概率上升；这是纯顺序不变量，两份都没验。
     */
    const fs2 = await import("node:fs/promises");
    const hook = await fs2.readFile("src/components/nav/useNavRemaining.ts", "utf8");
    const errorsSrc = await fs2.readFile("src/lib/http/errors.ts", "utf8");
    /** 剥注释但**保留字符串**（词表就藏在字符串里；不能像 ⑧b 那样连字符串一起剥） */
    const stripCommentsKeepStrings = (src: string): string =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ");
    const hookCode = stripCommentsKeepStrings(hook);

    // ① 跨端词表一致（这是本段唯一无法被那两份替代的断言）
    const feReasons = [...hookCode.matchAll(/return\s+"([a-z_]+)"\s*;/g)].map((m) => m[1]!);
    const apiErrors = [...errorsSrc.matchAll(/^\s*([a-z_]+):\s*"([a-z_]+)",?\s*$/gm)].map((m) => m[2]!);
    const feUniq = [...new Set(feReasons)].sort();
    const apiUniq = [...new Set(apiErrors)].sort();
    const unknown = feUniq.filter((r) => !apiUniq.includes(r));
    ok(
      feUniq.length > 0 && unknown.length === 0,
      "★ 前端 reason 词表 ⊆ 服务端 API_ERROR 枚举（改名不会静默错配）",
      feUniq.length ? `前端=${feUniq.join(",")} | 服务端=${apiUniq.join(",")}` : "✗ 未解析到前端词表",
    );
    if (unknown.length) console.error(`        前端出现服务端没有的 reason：${unknown.join(",")}`);

    // ② ★ status → reason 的**对偶一致性**（词表断言只证"词存在"，证不了"映射对"）
    /**
     * 为什么词表 ⊆ 还不够：
     *   若前端把 403 映射成 `bad_request`（两个词都在枚举里），词表断言**照样绿**，
     *   但用户看到 `data-remain-fail="403:bad_request"`，而服务端日志写 `forbidden`
     *   ⇒ 两边说的不是同一个东西，且**没有任何报错**。
     * ⇒ 必须验**对偶**：服务端 `status → error` 与前端 `status → reason` 逐档一致。
     *
     * 服务端权威映射来自 `errors.ts#DEFAULT_STATUS`（`API_ERROR.forbidden → 403` 这种反向表），
     * 这里转成正向 `403 → "forbidden"` 再与前端 `statusReasonOf` 比对。
     */
    const statusPairs = [...errorsSrc.matchAll(/\[API_ERROR\.([a-z_]+)\]:\s*(\d{3}),/g)].map(
      (m) => [Number(m[2]), m[1]!] as [number, string],
    );
    /** 前端 `if (status === 403) return "forbidden";` → [403, "forbidden"] */
    const fePairs = [...hookCode.matchAll(/if\s*\(status\s*===\s*(\d{3})\)\s*return\s+"([a-z_]+)";/g)].map(
      (m) => [Number(m[1]), m[2]!] as [number, string],
    );
    /** 前端 `if (status >= 500) return "upstream_error";` → [500, "upstream_error"]（下界档） */
    const feRange = [...hookCode.matchAll(/if\s*\(status\s*>=\s*(\d{3})\)\s*return\s+"([a-z_]+)";/g)].map(
      (m) => [Number(m[1]), m[2]!] as [number, string],
    );
    const feMap = new Map<number, string>([...fePairs, ...feRange]);

    /**
     * ⚠️⚠️ 这里曾有一个**假绿**（前端发现、team-lead 批准后修复）。原实现：
     * ```ts
     * const mismatched = statusPairs.filter(([st, err]) => {
     *   const fe = feMap.get(st);
     *   return fe !== undefined && fe !== err;   // ← 提取失败被当成"不算错配"
     * });
     * ok(statusPairs.length >= 6 && mismatched.length === 0, ...)   // ← 分母恒 6
     * ```
     * 后果：正则**完全抓不到**（如有人把 `statusReasonOf` 重构成查表式）时
     * `feMap` 为空 ⇒ `mismatched` 为空 ⇒ **PASS，且详情仍宣称「6 档全部对齐」**。
     * 实测两种退化场景都恒绿：只抓到 1 档、以及 feMap 完全空。
     * 而 `fe !== undefined` 这个写法**业务上完全合理**（前端不必覆盖 6 档）
     * ——「合理性掩盖了它同时吞掉"提取失败"」，这是它最难被发现的原因。
     *
     * ── 修法：拆成两条，各自只做它能做的事 ──────────────────────────────
     *   本条（①）：**只对「实际提取到」的档位**比对；`checked.length` 进判据**且进输出**
     *     ⇒ 提取失败时 `checked.length` 变小 ⇒ 详情立刻显示「比对 1/9 档」或「0/9 档」，
     *       而不是继续声称"全部对齐"。**让事实自己浮出来，不依赖人去想到。**
     *   下一条（②）：独立的「可达集齐全」断言，用**尺寸相等**兜住"提取失败"
     *     ⇒ 两条互为兜底，任一条失效另一条仍会红。
     */
    const checked = statusPairs.filter(([st]) => feMap.has(st));
    const mismatched = checked.filter(([st, err]) => feMap.get(st) !== err);

    /**
     * ── ⓪ 提取有效性（**必须最先判**，team-lead 第 2 点）───────────────────
     * **提取到 0 档 ⇒ 判 FAIL，不是 PASS。**
     *   「没抓到」与「抓到了且都对」是两件事，前者等义于**未验证**。
     *   原实现在这一点上是绿的 —— 那是本轮最坏的一种假绿：
     *   不是"漏检"，是**"零检 + 主动报告全对"**。
     *
     * ── 为什么还要打印源码片段（team-lead 第 3 点）─────────────────────────
     *   正则失效时，改代码的人需要一眼分辨两件事：
     *     · 是我把写法改了（查表/switch/常量）⇒ 应该改断言提取方式；
     *     · 还是正则本身写错了 ⇒ 应该修正则。
     *   只报"提取到 0 档"分不清这两种，人得自己翻文件猜。
     *   ⇒ 打印**函数体片段**（前后各几行），让原因自己浮出来。
     */
    const feMapSize = feMap.size;
    const hookFnSnippet = (() => {
      const i = hookCode.indexOf("function statusReasonOf");
      if (i < 0) return "<未找到 function statusReasonOf —— 函数可能已改名或移出本文件>";
      /**
       * 只截到**函数体结束**（第一个行首 `}`），不要把后续函数也捎进来 ——
       * 片段里混进无关代码会让人误判"我改的是这里吗"。
       */
      const end = hookCode.indexOf("\n}", i);
      const body = end > i ? hookCode.slice(i, end + 2) : hookCode.slice(i, i + 420);
      return body.replace(/\s+/g, " ").trim();
    })();
    ok(
      feMapSize > 0,
      "★ ⓪ 提取有效性：前端 status→reason 映射**必须至少提取到 1 档**（0 档 = 等义于未验证）",
      feMapSize > 0
        ? `提取 ${feMapSize} 条`
        : `✗ 提取到 0 条 —— 正则失效或代码已重构，本断言无法验证任何东西。\n` +
          `        待匹配写法：if (status === 4xx) return "<reason>";  或  if (status >= 500) return "<reason>";\n` +
          `        实际源码片段：${hookFnSnippet}`,
    );

    ok(
      // ⚠️ 分母用 `checked.length`（实际比对量），不是 `statusPairs.length`（输入集合尺寸）
      //    三个数字全部进输出：**提取 N / 比对 M / 失败 K**
      mismatched.length === 0 && checked.length > 0,
      "★ ①契约档位对偶：**已提取到**的档位，其 reason 必须与服务端一致",
      `提取 ${feMapSize} 条 / 比对 ${checked.length} 档（共 ${statusPairs.length} 档）/ 失败 ${mismatched.length} 条` +
        (mismatched.length
          ? `；错配：${mismatched.map(([st, e]) => `${st} 服务端=${e} 前端=${feMap.get(st)}`).join("; ")}`
          : `；已比对档位 ${checked.map(([st]) => st).sort((a, b) => a - b).join(",")}`),
    );
    /**
     * 覆盖度必须按**本端点实际可达的状态集**判定，**不能**拿全局 `API_ERROR` 六枚举当契约。
     *
     * ⚠️ 我第一版就是这样写错的：要求前端覆盖全部 6 档 ⇒ **FAIL（4/6）**。
     *   但实核 `route.ts` 只 `引用` 了三个：`bad_request` / `forbidden` / `upstream_error`
     *   —— 它**从不返回** `unauthorized`(401) / `gone`(410) / `rate_limited`(429)。
     *   ⇒ 前端不映射 401/410 是**正确的**，错的是我的判据：把「全局枚举」当成「本端点契约」。
     *   那种断言会**逼前端加两档永远用不到的映射**（无用代码 + 误导后来人以为会返回）。
     *
     * ⇒ 正确做法：从 `route.ts` **程序化提取**实际用到的 `API_ERROR.*`，再要求前端覆盖这些。
     *   这样将来 route 若真的加了 `rate_limited`，本断言会自动要求前端同步 —— 自我维护。
     */
    const routeSrc = await fs2.readFile("src/app/api/nav/remaining/route.ts", "utf8");
    const reachable = [...new Set([...routeSrc.matchAll(/API_ERROR\.([a-z_]+)/g)].map((m) => m[1]!))].sort();
    /**
     * ⚠️ 键方向别搞反：`statusPairs` 是 `[status, error]`（status→error）。
     *    这里要「按 error 查 status」，所以必须 find 反向找，
     *    不能 `new Map(statusPairs).get(error)`（那会因键类型不同恒 undefined，
     *    且**判据会静默退化为"空数组 ⇒ 无缺失 ⇒ 永远绿"** —— 典型的假绿）。
     */
    const statusOfError = new Map<string, number>(statusPairs.map(([st, err]) => [err, st]));
    const reachableStatuses = reachable
      .map((e) => statusOfError.get(e))
      .filter((v): v is number => typeof v === "number");
    const missing = reachableStatuses.filter((st) => !feMap.has(st));
    const feCoveredReachable = reachableStatuses.filter((st) => feMap.has(st));

    // ── ②-A 防空：可达集本身必须非空、且每条都能在 DEFAULT_STATUS 里找到 ──
    /**
     * ⚠️ 这条**必须先于**下一条，否则下一条的"缺失项"可能因集合推导失败而为空
     *   （上一轮我就吃过这个：`Map` 键方向反 ⇒ 查到 undefined ⇒ 空集 ⇒ 「无缺失」⇒ 恒绿）。
     *   规则：**任何「先构造集合、再判断缺失」的断言，必须同时断言集合本身非空/尺寸正确。**
     */
    ok(
      reachable.length > 0 && reachableStatuses.length === reachable.length,
      "  ②-A 防空：可达集非空，且每项都能映射到状态",
      `可达 ${reachable.length} 个（${reachable.join(",")}）→ 映射成功 ${reachableStatuses.length} 个`,
    );

    // ── ②-B 前端可达集齐全：用**尺寸相等**判定，不用 `missing.length === 0` ──
    /**
     * ⚠️ 为什么必须用**尺寸相等**而不是「缺失项为空」：
     *   `missing.length === 0` 在**提取彻底失败**时也成立（`feCoveredReachable` 与 `missing`
     *   都是从 `feMap` 推出来的，`feMap` 空 ⇒ 两者同源退化）。
     *   ⇒ 必须再加一条**与被测集合同源无关**的尺寸约束：
     *     `feCoveredReachable.length === reachableStatuses.length`
     *   它同时约束住"提取到 0 档"与"提取到部分档"两种退化。
     *   （team-lead 原话：「断言 3 档齐全……防空断言：集合尺寸必须 === 3，不能只 every()」）
     */
    ok(
      reachableStatuses.length > 0 &&
        feCoveredReachable.length === reachableStatuses.length &&
        missing.length === 0,
      "★ ②-B 前端覆盖**本端点实际可达**的每一档（尺寸相等判定，非 only-missing）",
      `可达 ${reachableStatuses.length} 档 [${reachableStatuses.join(",")}] / 前端覆盖 ${feCoveredReachable.length} 档` +
        ` / 前端映射 ${[...feMap.keys()].sort((a, b) => a - b).join(",")}` +
        (missing.length ? `；缺 ${missing.join(",")}` : ""),
    );
    if (missing.length) console.error(`        前端缺这些可达状态：${missing.join(",")}`);

    // ③ 顺序不变量：`!r.ok` 必须在 `r.json()` 之前
    const okIdx = hookCode.indexOf("if (!r.ok)");
    const jsonIdx = hookCode.indexOf("await r.json()");
    ok(
      okIdx >= 0 && jsonIdx > okIdx,
      "★ `!r.ok` 判定在 `r.json()` 之前（4xx 不被 body 解析先吞）",
      okIdx >= 0 && jsonIdx > okIdx ? "顺序正确" : `ok@${okIdx} json@${jsonIdx}`,
    );
  }

  /* ⑨ 晚点场景不为负 */
  {
    const late = { ...cardA, arriveAt: Date.now() - 60 * 60_000, totalMin: 1 };
    const res = await POST(reqWith({ card: late, legIndex: 0, segRemainSec: 0 }, `http://${HOST}`));
    const j = (await res.json()) as { remainingMin: number };
    ok(j.remainingMin >= 0, "晚点/已过时点 ⇒ remainingMin ≥ 0（绝不出现负数）", `实际 ${j.remainingMin}`);
  }

  console.log(`\n═══ 合计 ${pass + fail} 条：PASS ${pass} / FAIL ${fail} ═══`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("smoke 失败：", (e as Error).stack ?? e);
  process.exit(1);
});
