/**
 * 车型卡焦点门禁 —— scripts/check-vehicle-model-focus.mjs
 *
 * 运行：npm run test:vehicle-model-focus（= node scripts/check-vehicle-model-focus.mjs）
 * 环境前提：需 playwright-core + 本机 Chrome（launch channel: "chrome"）；
 *   playwright-core 未锚定在 devDependencies，.verify/qa2-lib.mjs 被 .gitignore:51 忽略；
 *   故不在 npm run verify 链内（干净克隆 / CI 必抛「找不到 playwright-core」），须单独执行。
 *
 * ── 为什么必须用真浏览器 ───────────────────────────────────────────────
 *   判据 1/2/3 全是 DOM 焦点与键盘默认行为，尤其
 *     「全屏 javascript:void(0) iframe 参与 Tab 序列」与
 *     「iframe 内键盘事件不进父 document 的传播路径」
 *   这两点，纯函数 / 正则 / 注册表式检查都测不出来，只会写出永远绿的断言。
 *
 *   运行时证据见 .verify/_fe-focus-diag.out.txt（.verify/_fe-focus-diag.mjs 产出）：
 *     [E1] javascript:void(0) iframe 同源可访问（contentDocument.readyState=complete），
 *          且跨 realm `body instanceof Node === false` ⇒ 镜像监听可行、instanceof 判据不可靠。
 *     [E2] 焦点在 iframe 内按 Escape/Tab：命中只有 IFRAME-WIN / IFRAME-DOC 的 capture+bubble，
 *          父 document / 父 window 一条都没收到 ⇒ **不是「不冒泡」，是父文档根本不在传播路径上**
 *          （capture 也收不到；纠正 QA4 报告 §4 的措辞）。
 *     [E3] 焦点从卡片进入 iframe 内部：父 document 的 focusin/focus **零次派发**，
 *          只有 IFRAME-DOC 收到 ⇒ 旧实现「父文档 focusin 事后拉回」在那一刻完全没被调用，
 *          这解释了 QA 的 [C1] IFRAME 停留 / [C2] 又被拉回。
 *     [E4] 无 guard 时 Tab 序列 anchor → IFRAME → BODY 循环 ⇒ iframe 确实参与 Tab 序列。
 *     [E5] 在 iframe document 的处理器里跨 realm 调 card.focus() 有效（IFRAME → DIV#card）。
 *     [E6] iframe 内 Tab 的 preventDefault 只能阻止焦点继续移动，焦点**仍停在 iframe 内**
 *          ⇒ 必须 preventDefault + pullBack 同时做，单靠拦键不满足 inCard=true。
 *
 * ── 测的是真源码 ───────────────────────────────────────────────────────
 *   用项目已锚定的 typescript（transpileModule）把
 *   src/components/nav/model-card-focus.ts 转成 CommonJS，再包一层 IIFE 注入页面，
 *   fixture 里调用的 installModelCardFocusGuard 与组件用的是同一个函数。
 *   ⚠️ 不用 esbuild：它只是 tsx 的传递依赖（0.28.2），未在 devDependencies 锚定，
 *      依赖树一变门禁就会以「找不到模块」的方式挂掉（幻觉依赖）。
 *
 * ── 反向对照（参考 scripts/check-xborder-ui.tsx 的「真渲染 + 假名字渲染空串」）──
 *   [B] 把 [A] 的 9 条**区分性断言原样**跑在「旧策略」上，要求**全部变红**。
 *   旧策略逐条对应 QA4 §4 描述的旧实现：打开时不移入焦点、keydown 只装父 document、
 *   只处理 Escape 不拦 Tab、focusin 事后拉回、dispose 不归还焦点。
 *   fixture 把 card 排在 iframe 之前，使 Tab 从 card 出发第一个命中就是 iframe，
 *   从而真实重现「Tab 逃出 / 焦点停在 IFRAME / 该状态下 Esc 失效」。
 *   若哪天有人把真实现改回旧策略，[B] 会立刻报 FAIL，而不是悄悄全绿。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = path.join(ROOT, "src", "components", "nav", "model-card-focus.ts");

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${msg}`);
  } else {
    fail++;
    console.error(`  FAIL  ${msg}`);
  }
}

/** 与 QA 环境同构：一枚角标、一张卡、一个全屏 javascript:void(0) iframe。
 *  card 排在 iframe **之前** ⇒ 从 card 按 Tab 第一个可 Tab 元素就是 iframe（见 [E4]）。 */
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<button id="anchor" class="vcode" data-bus-code="E3420" data-bus-code-chip="">E3420</button>
<div id="card" data-vehicle-model-card="" role="dialog" aria-modal="true" tabindex="-1"
     style="position:fixed;left:8px;top:40px;width:300px">车号 E3420 / 车型 / 款式 / 坐位</div>
<iframe id="map" src="javascript:void(0)" style="position:fixed;left:0;top:0;width:375px;height:603px;border:0"></iframe>
</body></html>`;

/**
 * 旧策略，仅用于反向对照。它不是「随便写个坏实现」，而是逐条对应 QA4 报告
 * §4「疑似根因」描述的那个实现：
 *   · 打开时不移入焦点 ⇒ 判据 1 失效
 *   · keydown 只装父 document、只处理 Escape、不拦 Tab ⇒ 判据 2/3 失效
 *   · focusin 只在父 document 冒泡阶段事后拉回 ⇒ 焦点进 iframe 时零次派发（[E3]）
 *   · dispose 不归还焦点 ⇒ 判据 4 失效
 */
const LEGACY = `
window.__legacyGuard = function ({ card, onEscape }) {
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    onEscape();
  };
  document.addEventListener("keydown", onKey, true);
  const onFocusIn = (e) => {
    if (e.target instanceof Node && card.contains(e.target)) return;
    card.focus();
  };
  document.addEventListener("focusin", onFocusIn);
  return {
    dispose() {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn);
    },
  };
};`;

async function loadChromium() {
  if (process.env.PLAYWRIGHT_CORE) {
    const pw = await import(process.env.PLAYWRIGHT_CORE);
    return pw.chromium ?? pw.default?.chromium;
  }
  try {
    /* 与 .verify/qa2-lib.mjs 共用同一份 playwright-core，避免在 scripts/ 里
       再硬编码一次本机绝对路径 */
    const lib = await import("../.verify/qa2-lib.mjs");
    return lib.chromium;
  } catch (e) {
    try {
      const pw = await import("playwright-core");
      return pw.chromium ?? pw.default?.chromium;
    } catch {
      throw new Error(
        "找不到 playwright-core：请设置 PLAYWRIGHT_CORE，或确认 .verify/qa2-lib.mjs 可用。" +
          ` 原始错误：${e.message}`,
      );
    }
  }
}

const active = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return {
      isCard: a === document.getElementById("card"),
      inCard: !!a?.closest?.("[data-vehicle-model-card]"),
      tag: a?.tagName ?? null,
      id: a?.id ?? null,
    };
  });

async function scenario(page, guardJs, mode) {
  await page.setContent(FIXTURE, { waitUntil: "load" });
  /* javascript:void(0) 的 contentDocument 需要先就绪，否则 syncFrames 首轮会漏掉它 */
  await page
    .waitForFunction(() => !!document.getElementById("map")?.contentDocument, null, { timeout: 5000 })
    .catch(() => {});
  await page.addScriptTag({ content: guardJs });
  await page.addScriptTag({ content: LEGACY });
  await page.evaluate((m) => {
    /* 地图 iframe 内部有可聚焦内容，Tab 才能把焦点送进 iframe **内部**（[E3] 的前提） */
    const inner = document.getElementById("map")?.contentDocument;
    if (inner?.body) inner.body.tabIndex = 0;

    window.__esc = 0;
    window.__leak = 0;
    /* 面板级冒泡监听：用于守护「Esc 只关一层」不回归 —— capture 里
       stopPropagation 生效时这里必须一次都收不到 */
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") window.__leak += 1;
    });

    const card = document.getElementById("card");
    const anchor = document.getElementById("anchor");
    const install =
      m === "good" ? window.MCFocus.installModelCardFocusGuard : window.__legacyGuard;
    window.__guard = install({
      card,
      restoreTo: anchor,
      onEscape: () => {
        window.__esc += 1;
      },
    });
  }, mode);

  /* 判据 1：打开即焦点入卡 */
  const open = await active(page);

  /* 判据 2：Tab×12，一次都不许逃出（含 iframe） */
  const escapes = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const s = await active(page);
    if (!s.inCard || s.tag === "IFRAME") escapes.push({ i: i + 1, tag: s.tag, id: s.id });
  }

  /* 判据 3a：焦点在卡内时 Esc */
  await page.evaluate(() => document.getElementById("card").focus());
  const e0 = await page.evaluate(() => window.__esc);
  await page.keyboard.press("Escape");
  const escFromCard = (await page.evaluate(() => window.__esc)) > e0;

  /* 判据 3b：QA 的复现路径 —— 用 Tab 把焦点送进 iframe，再按 Esc */
  await page.evaluate(() => document.getElementById("card").focus());
  let reachedIframe = false;
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const s = await active(page);
    if (s.tag === "IFRAME") {
      reachedIframe = true;
      break;
    }
  }
  const e1 = await page.evaluate(() => window.__esc);
  await page.keyboard.press("Escape");
  const escFromIframe = (await page.evaluate(() => window.__esc)) > e1;

  /* 判据 3c：焦点确实在 iframe 内部时，iframe document 上派发的 Esc 仍要能关。
     CDP 的 keyboard.press 是异步的，而新实现的 focusin 会同步把焦点拉回卡，
     所以用 **iframe document 内同步派发的真实 KeyboardEvent**（走真实 DOM 传播路径，
     target=body、bubbles=true）来覆盖「按 Esc 那一瞬间焦点还在 iframe 内」。
     [E2] 证明这条路径不含父 document ⇒ 只有镜像监听能接住。 */
  const innerEsc = await page.evaluate(() => {
    const d = document.getElementById("map")?.contentDocument;
    if (!d?.body?.dispatchEvent || !d.defaultView?.KeyboardEvent) {
      return { ready: false, fired: false };
    }
    const before = window.__esc;
    d.body.tabIndex = 0;
    d.body.focus();
    const focusedInside = d.activeElement === d.body;
    d.body.dispatchEvent(
      new d.defaultView.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    return {
      ready: true,
      fired: window.__esc > before,
      focusedInside,
      parentActive: document.activeElement?.tagName ?? null,
    };
  });

  /* 程序性把焦点塞进 iframe 内部：新实现应立刻拉回卡（[E5] 跨 realm focus 有效） */
  const pullBack = await page.evaluate(() => {
    const d = document.getElementById("map")?.contentDocument;
    if (!d?.body) return { ready: false, pulled: false };
    d.body.tabIndex = 0;
    d.body.focus();
    return { ready: true, pulled: document.activeElement?.id === "card" };
  });

  /* 地图 SDK 在弹窗打开之后才插入的 iframe */
  await page.evaluate(() => {
    const f = document.createElement("iframe");
    f.id = "map2";
    f.setAttribute("src", "javascript:void(0)");
    f.style.cssText = "position:fixed;left:0;top:0;width:200px;height:200px;border:0";
    document.body.appendChild(f);
  });
  await page
    .waitForFunction(() => document.getElementById("map2")?.contentDocument?.readyState === "complete", null, {
      timeout: 5000,
    })
    .catch(() => {});
  const dyn = await page.evaluate(() => {
    const d = document.getElementById("map2")?.contentDocument;
    if (!d?.body) return { ready: false, pulled: false };
    d.body.tabIndex = 0;
    d.body.focus();
    return { ready: true, pulled: document.activeElement?.id === "card" };
  });

  /* 判据 4：dispose 后焦点归还触发角标 */
  await page.evaluate(() => window.__guard.dispose());
  const restored = await page.evaluate(() => {
    const a = document.activeElement;
    return {
      isAnchor: a === document.getElementById("anchor"),
      code: a?.getAttribute?.("data-bus-code") ?? null,
      tag: a?.tagName ?? null,
    };
  });
  const escLeak = await page.evaluate(() => window.__leak);

  return {
    open, escapes, escFromCard, reachedIframe, escFromIframe, innerEsc,
    pullBack, dyn, restored, escLeak,
  };
}

/** 区分性断言：真实现必须全绿，旧策略必须全红。两边用的是**同一组**判据。 */
function distinguishing(r) {
  return [
    ["打开后 activeElement 就是卡片（判据 1）", r.open.isCard === true],
    ["Tab×12 逃出 0 次（判据 2，含 iframe）", r.escapes.length === 0],
    ["Tab 根本到不了 iframe（从源头不产生逃出）", r.reachedIframe === false],
    ["Tab 送进 iframe 后 Esc 仍可关（判据 3 条件性失效）", r.escFromIframe === true],
    ["iframe document 内派发的 Esc 被镜像监听接住（判据 3 硬路径）", r.innerEsc.ready && r.innerEsc.fired],
    ["塞进 iframe 内部的焦点被拉回卡", r.pullBack.ready && r.pullBack.pulled],
    ["弹窗打开后新建的 iframe 同样被覆盖（MutationObserver）", r.dyn.ready && r.dyn.pulled],
    ["dispose 后焦点归还触发角标（判据 4）", r.restored.isAnchor === true],
    ["归还目标就是那枚 .vcode 角标 E3420", r.restored.code === "E3420"],
  ];
}

async function main() {
  const chromium = await loadChromium();
  const src = await readFile(MODULE, "utf8");
  const js = ts.transpileModule(src, {
    fileName: "model-card-focus.ts",
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      isolatedModules: true,
      strict: true,
    },
  }).outputText;
  /* transpileModule 产出 CommonJS（exports.xxx = ...），包一层 IIFE 暴露到
     window.MCFocus，等价于 esbuild 的 format:iife + globalName。 */
  const code = `window.MCFocus = (function () {
    var module = { exports: {} };
    var exports = module.exports;
${js}
    return module.exports;
  })();`;

  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-proxy-server", "--proxy-bypass-list=*", "--disable-features=Translate"],
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } });
    const page = await ctx.newPage();

    console.log("\n[A] 真实现：installModelCardFocusGuard（9 条区分性断言须全绿）");
    const good = await scenario(page, code, "good");
    for (const [name, ok] of distinguishing(good)) assert(ok, name);
    /* 回归保护：这两条在旧策略下也可能绿，但守护的是已判 PASS 的行为 */
    assert(good.escFromCard, "回归保护：焦点在卡内时 Esc 可关（③ 正常路径）");
    assert(good.escLeak === 0, "回归保护：Esc 不泄漏到面板级冒泡监听（③「只关一层」）");
    console.log(`  [诊断] 真实现 Tab 逃出=${good.escapes.length} 次；reachedIframe=${good.reachedIframe}；iframe 内 Esc=${good.innerEsc.fired}；escLeak=${good.escLeak}`);

    console.log("\n[B] 反向对照：旧策略（同一组 9 条断言须全红，证明能变红）");
    const legacy = await scenario(page, code, "legacy");
    for (const [name, ok] of distinguishing(legacy)) assert(!ok, `会变红 · ${name}`);
    assert(legacy.escFromCard, "旧策略在卡内 Esc 仍可关（证明失效精确定位在 iframe 场景）");
    console.log(`  [诊断] 旧策略 Tab 逃出=${legacy.escapes.length} 次 ${JSON.stringify(legacy.escapes.slice(0, 4))}；reachedIframe=${legacy.reachedIframe}；iframe 内 Esc=${legacy.innerEsc.fired}`);
  } finally {
    await browser.close();
  }

  console.log(`\n结果：通过 ${pass} · 失败 ${fail}`);
  if (fail) {
    console.error("车型卡焦点门禁未通过：真实现有缺口，或反向对照已不再能变红（断言退化成永远绿）。");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("门禁自身异常（不是断言失败）：", e);
  process.exit(1);
});
