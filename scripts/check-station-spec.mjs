#!/usr/bin/env node
/**
 * 站标规格门禁（check-station-spec.mjs）
 *
 * ── 为什么存在 ─────────────────────────────────────────────────────────────
 * 2026-11-06 用户反馈 #3：「路线查看模式下指定线路的经停站的站标与正常站标不同，
 * 会有一层白色粗边」。根因不是"某个值写错了"，而是**同一类站标存在两套规格**：
 * 常态 11px / 1.5px 描边 / 1px 外圈，路线模式被 `--onroute` 覆盖成 16px / 2px / 1.5px
 * （轻轨 13→18px），于是「同一颗站，换个模式就变形」。
 *
 * 修完之后要防的是**再犯**：将来任何人为「让人分辨本线站」而放大/加粗某类站标，
 * 都会立刻重新制造第二套规格。本脚本把「规格只有一套」写成可复跑的机器断言。
 *
 * ── 判据（三条不变量）────────────────────────────────────────────────────
 * ① **基准锚定**：`.nav-map__station` / `--lrt` / `--tqh` 三个基准的
 *    width / height / border-width / box-shadow 必须等于 EXPECT 常量。
 *    ⇒ 连"把全体站标一起改大"也拦得住（要改必须显式改本脚本，属设计决策）。
 * ② **`--onroute` 不得声明任何盒模型属性**：尺寸/描边/圆角/外圈/位移全部禁止。
 *    本线站在屏幕上靠「白名单只建本线站」区分，不靠外观。
 * ③ **降级态（`--dim` 族）只许变小**：width/height/border-width 不得超基准，
 *    `box-shadow` 只许 `none`（不得借降级态偷偷加环）。
 * ④ **通琴号关联站：双色保留，白环不得存在**（2026-11-07 需求 #3 终版口径）。
 *    关联站（`.nav-map__station--tqh-shared.nav-map__station--tqh-onroute`）**不得**再有任何
 *    `box-shadow` / `border-*` 一类"加粗白环"的声明 —— 它的箱线必须与首页普通巴士站
 *    **逐字符相同**（1.5px 白描边 + `0 0 0 1px rgba(15,23,32,.42)`）。
 *    原来的口径是"必须有双色环"，已于本轮反转：用户说的「白色粗边」= 11px 盒 + 1.5px
 *    白描边 + 2px 纯白环（白厚 3.5px），**环本身就是缺陷**，不是识别手段。
 *    ⚠️ 但**双色不能跟着一起没了**：关联站与普通站的区别现在由
 *    `.nav-map__station--tqh-shared` 的 `linear-gradient`（左右两半异色）承担
 *    ⇒ 另设一条**独立**断言锁 `background` 的两个色停。
 *    两条断言**故意不合并**：红的时候要能立刻分出"环回来了"还是"双色被抹了"，
 *    这两种的修法正好相反（删声明 vs 补回 background）。
 *
 * ── 用法 ───────────────────────────────────────────────────────────────────
 *   npm run test:station-spec                          # 校验真实 src/app/globals.css
 *   node scripts/check-station-spec.mjs --self-test    # 自证有效（注入违规必须报红）
 *   node scripts/check-station-spec.mjs --css <path>   # 校验指定文件
 *
 * 退出码：0 = 全部 PASS/WARN；1 = 存在 FAIL（已挂 `npm run verify` 链）。
 *
 * ── ★ 2026-11-07：从 `.verify/` 迁入 `scripts/`（**这是本次迁移的重点**）───────
 *   原位置 `.verify/check-station-spec.mjs` 被 `.gitignore:51` 整目录忽略
 *   ⇒ **不在版本库** ⇒ 别人 clone 下来没有这个文件，且 `package.json` / git hooks
 *   里没有任何一处执行它。后果：本脚本"存在"但**从来不是门禁**，只是一份
 *   "某人某次跑过的记录"。
 *   迁入 `scripts/` 后才真正进入 `npm run verify` 链（见 package.json 的
 *   `test:station-spec`）。判断「有没有门禁」必须看**执行链**，不能只看代码里
 *   有没有断言常量 —— 这个错本项目犯过两次：
 *     · `check-route-ink.ts` 引用了一个从不存在的模块（跑就报错，长期无人知）；
 *     · 本脚本在 `.verify/` 里躺了 1 天，被当成"有门禁守着"。
 *
 * ── ⚠️ 依赖声明（诚实登记，别当成理所当然）────────────────────────────────
 *   `postcss` **不是** package.json 的直接依赖，是经 `next` 传递进来的
 *   （当前实装 8.5.32，且根 `package.json` 的 `overrides` 里钉了版本）。
 *   万一哪天 next 不再带 postcss，本脚本会**明确报错并说清怎么修**，
 *   不会静默跳过（见下方 resolvePostcss()）。
 */
import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/**
 * 解析 postcss（**传递依赖**，见文件头「依赖声明」）。
 * 不用裸 `require("postcss")`：那样缺失时的报错是 `MODULE_NOT_FOUND: postcss`，
 * 看不出"是本门禁要它"还是"别的什么要它"，也没有修复指引。
 */
/** 目标 CSS 的相对路径（唯一口径；`--css` 可覆盖） */
const CSS_REL = "src/app/globals.css";

function resolvePostcss() {
  try {
    return require("postcss");
  } catch {
    console.error("[FAIL] 本门禁需要 `postcss` 解析 CSS，但当前 node_modules 里找不到它。");
    console.error("       它不是直接依赖，是经 `next` 传递安装的（根 package.json 的 overrides 钉了版本）。");
    console.error("       修复：npm install（或 npm install --no-save postcss@^8.5.32）。");
    console.error("       ⚠️ 不要为了让本门禁「能跑」而删掉解析逻辑 —— 那就退化成「CSS 说什么都对」。");
    process.exit(1);
  }
}
const postcss = resolvePostcss();

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * 仓库根。两种来源，**显式**而不靠"碰巧对"：
 *   ① 从仓库根调用（`npm run verify` / `node scripts/...`）⇒ cwd 就是根；
 *   ② 从别处调用（绝对路径、或 `cd scripts && node check-station-spec.mjs`）
 *      ⇒ 退回「本文件上一级」。
 * 判据是 cwd 下**真的存在** `src/app/globals.css`（不是猜）。
 * ⚠️ 从 `.verify/` 迁过来时这里最容易出隐性 bug：`.verify/x.mjs` 与
 *    `scripts/x.mjs` 距仓库根**同为**一层 ⇒ 旧的 `dirname(HERE)` **碰巧仍然对**，
 *    于是"迁完照样绿"，掩盖了它依赖自身位置这件事。现在显式判 cwd。
 *
 * ★★ 2026-11-07（fe-css2）补：**ROOT 必须自证，不许静默兜底** ─────────────
 *   上面那条三元表达式只做"选择"，**没有做断言**：若两个候选都指不到仓库根，
 *   它会带着一个错的 ROOT 一路往下跑，最后在读文件时才失败。
 *   失败信息是 `ENOENT: no such file or directory` —— 看的人第一反应是
 *   "globals.css 没了"，而不是"你 cd 错了"。更坏的情况：机器上**碰巧**
 *   有个同相对路径的文件 ⇒ 静默校验了**别人的** CSS 并报绿（假绿，无人怀疑）。
 *   ⇒ 现在改成：候选逐个试、用 `statSync().isFile()` 确认是**文件**，
 *     全都不成立就**立刻退出并列出所有试过的路径** + 怎么修。
 *     `--css <path>` 显式指定时跳过本段（用户已经说清要看哪个文件）。
 */
function resolveRootOrDie() {
  /* 用 Set 去重：cwd 与 HERE 的祖先链在从仓库内调用时**必然重叠**，
     不去重会让失败信息里同一路径打印两遍（看的人会以为试了更多地方）。 */
  const cands = new Set();
  /* ① cwd 及其最多 6 级祖先（支持在任意子目录里调用） */
  let d = process.cwd();
  for (let i = 0; i < 6; i++) {
    cands.add(d);
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  /* ② 本文件所在目录及其祖先 */
  d = HERE;
  for (let i = 0; i < 6; i++) {
    cands.add(d);
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  const tried = [];
  for (const c of cands) {
    const p = join(c, CSS_REL);
    try {
      /* 必须 `isFile()`：同名**目录**也会让 existsSync 为真 ⇒ 又会静默走错 */
      if (statSync(p).isFile()) return { root: c, css: p };
    } catch {
      /* 不存在 / 无权限 ⇒ 继续试下一个 */
    }
    tried.push(p);
  }
  console.error("═══ [FATAL] 找不到仓库根 ══════════════════════════════════════════");
  console.error(`本脚本需要一个包含 \`${CSS_REL}\` 的目录作为仓库根。以下路径都不是文件：`);
  for (const p of tried) console.error(`  ✗ ${p}`);
  console.error("");
  console.error("怎么修（任选其一）：");
  console.error("  · cd 到仓库根再跑：      npm run test:station-spec");
  console.error("  · 或直接指定要校验的文件： node scripts/check-station-spec.mjs --css <path/to/globals.css>");
  console.error("");
  console.error("⛔ 刻意**不**在失败时兜底成 dirname(HERE)：那会带着错的路径继续跑，");
  console.error("   一旦机器上碰巧存在同相对路径的文件，就会静默校验别人的 CSS 并报绿。");
  process.exit(1);
}
/* `--css <path>` 显式指定 ⇒ 不需要 ROOT（用户已说清看哪个文件） */
const __argv0 = process.argv.slice(2);
const __cssIdx0 = __argv0.indexOf("--css");
const ROOT = __cssIdx0 >= 0 && __argv0[__cssIdx0 + 1] ? null : resolveRootOrDie().root;

/* ══════════════════════════════════════════════════════════════════════════
   基准常量（EXPECT）
   ⚠️ 这些数字是**设计规格**，不是脚本实现细节。若确属设计变更（负责人拍板），
      请同步修改本段并在 PR/报告中写明理由；不要让脚本"自动跟随" CSS ——
      那样就退化成"CSS 说什么都对"，门禁失去意义。
   ══════════════════════════════════════════════════════════════════════════ */
const EXPECT = {
  baseBus: {
    width: "11px",
    height: "11px",
    borderWidth: "1.5px",
    shadow: "0 0 0 1px rgba(15, 23, 32, 0.42)",
  },
  baseLrt: {
    width: "13px",
    height: "13px",
    borderWidth: "1.5px",
    shadow: "0 0 0 1px rgba(15, 23, 32, 0.42)",
    // 特征差异（圆角方点）在 border-radius，**不在**本门禁范围 —— 允许不同
  },
  baseTqh: {
    width: "12px",
    height: "12px",
    borderWidth: "1.5px",
    shadow: "0 0 0 1px var(--tqh-map-edge)",
    // 描边色是 var(--tqh-on)，属 Token 差异，不参与宽窄判定
  },
};

/** `--onroute` 禁止声明的属性（任何一条出现即「第二套规格」） */
const FORBIDDEN_ON_ONROUTE = [
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "border",
  "border-width",
  "border-radius",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "box-shadow",
  "outline",
  "outline-offset",
  "transform",
  "scale",
  "zoom",
  "margin",
  "padding",
  "inset",
];

/* ── 值归一化（让 `rgba(15,23,32,.42)` 与 `rgba(15, 23, 32, 0.42)` 相等） ── */
function normVal(v) {
  return String(v)
    .toLowerCase()
    .replace(/!\s*important/g, "")
    .replace(/(?<![\d.])\.(\d)/g, "0.$1") // .42 → 0.42
    .replace(/\s+/g, "")
    .trim();
}
const normSel = (s) => String(s).replace(/\s+/g, "");

/** 严格解析 `Npx`；无法解析返回 null（var()/calc()/auto 等一律 null） */
function px(v) {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v ?? "").trim().toLowerCase());
  return m ? Number(m[1]) : null;
}

/** 规则命中：按**逗号分离后的单个选择器**精确比较（避开 `[data-pressed]` 之类近似名） */
function findRules(root, selector) {
  const target = normSel(selector);
  const out = [];
  root.walkRules((r) => {
    let sels;
    try {
      sels = r.selectors; // postcss 自动按顶层逗号拆分
    } catch {
      sels = [r.selector];
    }
    if (sels.some((s) => normSel(s) === target)) out.push(r);
  });
  return out;
}

/** 合并同一选择器在多处出现时的声明（后者胜，与浏览器层叠一致） */
function mergedDecls(rules) {
  const m = new Map();
  const where = [];
  for (const r of rules) {
    where.push(`${r.source?.start?.line ?? "?"}`);
    r.each((n) => {
      if (n.type === "decl") m.set(n.prop.toLowerCase(), String(n.value).trim());
    });
  }
  return { decls: m, lines: where };
}

/** `border-width`：优先显式，其次从 `border` 简写里捞长度值 */
function borderWidthOf(decls) {
  if (decls.has("border-width")) return decls.get("border-width");
  if (decls.has("border")) {
    const tok = String(decls.get("border")).trim().split(/\s+/);
    const w = tok.find((t) => px(t) !== null || /^(thin|medium|thick)$/i.test(t));
    if (w) return w;
  }
  return null;
}

const show = (v) => (v === null || v === undefined ? "(未声明)" : v);
/** 展示用压平：多行/多空格的值压成一行，否则输出会被换行撕开 */
const flat = (v) => (v === null || v === undefined ? "(未声明)" : String(v).replace(/\s+/g, " ").trim());

/* ══════════════════════════════════════════════════════════════════════════
   校验主体
   ══════════════════════════════════════════════════════════════════════════ */
function check(cssText, label) {
  const root = postcss.parse(cssText, { from: label });
  const lines = [];
  let fails = 0;
  let warns = 0;

  const emit = (status, id, sel, detail) => {
    if (status === "FAIL") fails += 1;
    if (status === "WARN") warns += 1;
    lines.push(`[${status}] ${id.padEnd(18)} ${sel}${detail ? ` —— ${detail}` : ""}`);
  };

  /** 锚定：基准三兄弟必须等于 EXPECT */
  const checkAnchor = (id, sel, expect) => {
    const { decls, lines: at } = mergedDecls(findRules(root, sel));
    if (decls.size === 0) {
      emit("FAIL", id, sel, "基准规则缺失（CSS 里找不到该选择器）");
      return null;
    }
    const got = {
      width: decls.get("width") ?? null,
      height: decls.get("height") ?? null,
      borderWidth: borderWidthOf(decls),
      shadow: decls.get("box-shadow") ?? null,
    };
    const bad = [];
    if (got.width !== expect.width) bad.push(`width ${show(got.width)} ≠ 锚定 ${expect.width}`);
    if (got.height !== expect.height) bad.push(`height ${show(got.height)} ≠ 锚定 ${expect.height}`);
    if (normVal(show(got.borderWidth)) !== normVal(expect.borderWidth))
      bad.push(`border-width ${show(got.borderWidth)} ≠ 锚定 ${expect.borderWidth}`);
    if (normVal(show(got.shadow)) !== normVal(expect.shadow))
      bad.push(`box-shadow ${show(got.shadow)} ≠ 锚定 ${expect.shadow}`);

    const detail = `width=${flat(got.width)} height=${flat(got.height)} border=${flat(got.borderWidth)} shadow=${flat(got.shadow)}（源行 ${at.join("/")}）`;
    if (bad.length) emit("FAIL", id, sel, `${detail} ⇒ ${bad.join("；")}`);
    else emit("PASS", id, sel, detail);
    return got;
  };

  /** `--onroute` 禁用盒模型属性 */
  const checkForbidden = (id, sel) => {
    const rules = findRules(root, sel);
    if (rules.length === 0) {
      emit("PASS", id, sel, "规则不存在（已删除 / 从未出现）—— 符合「不放大、不加粗」");
      return;
    }
    const badProps = [];
    const okProps = [];
    for (const r of rules) {
      r.each((n) => {
        if (n.type !== "decl") return;
        const p = n.prop.toLowerCase();
        if (FORBIDDEN_ON_ONROUTE.includes(p)) badProps.push(`${p}: ${n.value}`);
        else okProps.push(`${p}: ${n.value}`);
      });
    }
    if (badProps.length) {
      emit(
        "FAIL",
        id,
        sel,
        `声明了盒模型属性 ⇒ ${badProps.join("；")}｜本线站不得与常态站标有任何尺寸/描边/外圈差异`,
      );
    } else {
      emit("PASS", id, sel, `仅声明非盒模型属性（${okProps.join("；") || "无"}），不构成第二套规格`);
    }
  };

  /** 降级态：只许变小，不许加环 */
  const checkShrinkOnly = (id, sel, refGot, refLabel) => {
    const rules = findRules(root, sel);
    if (rules.length === 0) {
      emit("WARN", id, sel, "规则不存在（若已随重构删除请同步本脚本）");
      return;
    }
    if (!refGot) {
      emit("FAIL", id, sel, `参照基准 ${refLabel} 不可用（先修基准再判本节）`);
      return;
    }
    const { decls } = mergedDecls(rules);
    const got = {
      width: decls.get("width") ?? null,
      height: decls.get("height") ?? null,
      borderWidth: borderWidthOf(decls),
      shadow: decls.get("box-shadow") ?? null,
    };
    const bad = [];
    for (const key of ["width", "height", "borderWidth"]) {
      if (got[key] === null) continue; // 未声明 = 继承基准，合法
      const g = px(got[key]);
      const b = px(refGot[key]);
      if (g === null) {
        bad.push(`${key} ${got[key]} 不可解析（禁止 var()/calc() —— 门禁无法判定宽窄）`);
      } else if (b === null) {
        bad.push(`${key}：基准 ${refLabel}.${key} 不可解析`);
      } else if (g > b) {
        bad.push(`${key} ${got[key]} > 基准 ${refGot[key]}`);
      }
    }
    if (got.shadow !== null && normVal(got.shadow) !== "none") {
      bad.push(`box-shadow ${got.shadow}（降级态不得加外圈，只许 none 或继承）`);
    }
    const detail = `width=${flat(got.width)} height=${flat(got.height)} border=${flat(got.borderWidth)} shadow=${flat(got.shadow)}`;
    if (bad.length) emit("FAIL", id, sel, `${detail} ⇒ ${bad.join("；")}`);
    else if (got.width === null && got.height === null && got.borderWidth === null && got.shadow === null) {
      emit("PASS", id, sel, "无任何盒模型声明（例如仅 opacity），天然不可能放大 ✓");
    } else emit("PASS", id, sel, `${detail}（均 ≤ 基准 ${refLabel}）`);
  };

  /** 通琴号关联站：**双色保留、加粗白环不得存在**（两条独立断言，见不变量 ④ 与下方说明）
   *
   *  (a) 白环：为什么用「禁声明集合」而不是「把 box-shadow 计算值逐字符对比」
   *      本脚本是 postcss 静态解析，**不跑级联**，拿不到真正的"计算值"（那是浏览器的事）。
   *      但有一个等价且**更强**的判据：凡是可能命中该元素的规则里，盒模型/环声明一条都不许有。
   *        · 覆盖集合为空 ⇒ 计算值必然来自基类 `.nav-map__station` ⇒ 与普通站逐字符相同；
   *        · 而"只比 box-shadow 字符串"会**漏掉**用 `border-width: 2px` / `outline` 造出来的
   *          同样的粗边 —— #3 用户看到的就是「1.5px 描边 + 2px 纯白环 = 白厚 3.5px」，
   *          两条通道（border 与 box-shadow）都能造，只堵一条等于没堵。
   *      ⇒ 选"禁声明集合"。这是**故意比字符串比更严**，不是更宽。
   *
   *  (b) 双色：正向锁 `.nav-map__station--tqh-shared` 的 `background` 必须是
   *      `linear-gradient` 且同时含 `var(--accent)`（左半·澳门巴士站）与
   *      `var(--tqh-map-half)`（右半·通琴号）。少一个色停 = 圆点变单色，关联站在地图上消失。
   */
  const checkTqhRingGuard = () => {
    /* ── (a-1) 谁可能命中「关联站」：选择器同时含 --tqh-shared 与 --tqh-onroute（顺序不限）── */
    const scanForbidden = (id, label, pred) => {
      const hits = [];
      let matched = 0;
      root.walkRules((r) => {
        let sels;
        try {
          sels = r.selectors;
        } catch {
          sels = [r.selector];
        }
        if (!sels.some((s) => pred(normSel(s)))) return;
        matched += 1;
        r.each((n) => {
          if (n.type === "decl" && FORBIDDEN_ON_ONROUTE.includes(n.prop.toLowerCase())) {
            hits.push(`${n.prop}: ${flat(n.value)}（源行 ${r.source?.start?.line ?? "?"}）`);
          }
        });
      });
      const sel = label;
      if (hits.length) {
        emit(
          "FAIL",
          id,
          sel,
          `声明了盒模型/环属性 ⇒ 又造出第二套规格（#3 的粗白边正是这样回来的）：${hits.join("；")}`,
        );
      } else {
        emit(
          "PASS",
          id,
          sel,
          matched
            ? `命中 ${matched} 条规则、其中**零条**盒模型/环声明 ⇒ 计算值全部来自基类 .nav-map__station，与普通站逐字符一致`
            : `CSS 里无该选择器的规则 ⇒ 计算值全部来自基类 .nav-map__station，与普通站逐字符一致`,
        );
      }
    };

    scanForbidden(
      "TQH-RING-SHARED",
      "关联站 --tqh-shared.--tqh-onroute（33 个双色标）",
      (s) => /--tqh-shared/.test(s) && /--tqh-onroute/.test(s),
    );
    scanForbidden(
      "TQH-RING-SINGLE",
      "纯通琴号站 --tqh-onroute（96 个，**不含** --tqh-shared）",
      (s) => /--tqh-onroute/.test(s) && !/--tqh-shared/.test(s),
    );

    /* ── (b) 双色载体（正向）：这是关联站唯一的可辨识特征，抹掉它等于关联站消失 ── */
    const dualRules = findRules(root, ".nav-map__station--tqh-shared");
    const { decls: dualDecls, lines: dualAt } = mergedDecls(dualRules);
    const bg = dualDecls.get("background") ?? dualDecls.get("background-image") ?? null;
    const v = normVal(show(bg));
    const miss = [];
    if (dualRules.length === 0) miss.push("规则缺失（`.nav-map__station--tqh-shared` 找不到）");
    if (!/linear-gradient\(/.test(v)) miss.push("background 不是 linear-gradient");
    if (!/var\(--accent\)/.test(v)) miss.push("缺左半色停 `var(--accent)`（澳门巴士站·青花蓝）");
    if (!/var\(--tqh-map-half\)/.test(v)) miss.push("缺右半色停 `var(--tqh-map-half)`（通琴号·主题色）");
    if (miss.length) {
      emit(
        "FAIL",
        "TQH-DUAL",
        ".nav-map__station--tqh-shared",
        `双色载体不完整 ⇒ ${miss.join("；")}（background=${flat(bg)}，源行 ${dualAt.join("/") || "?"}）`,
      );
    } else {
      emit(
        "PASS",
        "TQH-DUAL",
        ".nav-map__station--tqh-shared",
        `双色载体在：${flat(bg)}（源行 ${dualAt.join("/")}）`,
      );
    }
  };

  /* ── 逐条断言 ───────────────────────────────────────────────────────── */
  lines.push(`── 基准锚定（设计规格常量，改需负责人拍板）──`);
  const baseBus = checkAnchor("BASE-BUS", ".nav-map__station", EXPECT.baseBus);
  const baseLrt = checkAnchor("BASE-LRT", ".nav-map__station--lrt", EXPECT.baseLrt);
  const baseTqh = checkAnchor("BASE-TQH", ".nav-map__station--tqh", EXPECT.baseTqh);

  lines.push(`── 路线查看模式：本线站必须与常态站标一致 ──`);
  checkForbidden("NO-ONROUTE", ".nav-map__station--onroute");
  checkForbidden("NO-LRT-ONROUTE", ".nav-map__station--lrt.nav-map__station--onroute");

  lines.push(`── 降级态（--dim 族）：只许变小，不许加环 ──`);
  checkShrinkOnly("DIM", ".nav-map__station--dim", baseBus, "BASE-BUS");
  checkShrinkOnly("LRT-DIM", ".nav-map__station--lrt.nav-map__station--dim", baseLrt, "BASE-LRT");
  checkShrinkOnly("TQH-DIM", ".nav-map__station--tqh-dim", baseTqh, "BASE-TQH（附加）");

  lines.push(`── 通琴号关联站：双色保留、加粗白环不得存在 ──`);
  checkTqhRingGuard();

  /* ── 兜底扫描：任何 `*--onroute` 选择器都不得声明盒模型属性 ─────────── */
  lines.push("── 兜底扫描（覆盖将来新增的 *--onroute 组合选择器）──");
  const sweepHits = [];
  root.walkRules((r) => {
    let sels;
    try {
      sels = r.selectors;
    } catch {
      sels = [r.selector];
    }
    /* ★ 2026-11-07 两处修正（这条兜底原先比它自己声称的**窄得多**）：
       ① 原写法在这里排除了 `--tqh-onroute`（因为当年那条环是"合规"的）⇒ 现已取消排除；
       ② **更要命的**：原来的匹配式是 `/--onroute/`，而 `.nav-map__station--tqh-onroute`
          里根本**不含**子串 `--onroute`（"h-onroute" 只有一个连字符）⇒ `--tqh-onroute`
          整族从来没被兜底扫到过。改成 `/--[a-z-]*onroute/` 才能覆盖
          `--onroute` / `--tqh-onroute` / `--lrt-onroute` 全族。
       （自证用例 5/6/7 就是靠"期望 SWEEP 报红却报不出来"把这个洞抓出来的。） */
    const hitSels = sels.filter((s) => /--[a-z-]*onroute/.test(s));
    if (!hitSels.length) return;
    const bad = [];
    r.each((n) => {
      if (n.type === "decl" && FORBIDDEN_ON_ONROUTE.includes(n.prop.toLowerCase())) {
        bad.push(`${n.prop}: ${n.value}`);
      }
    });
    if (bad.length) sweepHits.push(`${hitSels.join(", ")} ⇒ ${bad.join("；")}`);
  });
  if (sweepHits.length) {
    emit("FAIL", "SWEEP", "*--onroute（全部）", sweepHits.join(" ｜ "));
  } else {
    emit("PASS", "SWEEP", "*--onroute（全部）", "无任何选择器借 --onroute 声明盒模型属性");
  }

  /* ── 结构完整性（顺带兜住"改崩了"）──────────────────────────────────── */
  const braceOpen = (cssText.match(/{/g) || []).length;
  const braceClose = (cssText.match(/}/g) || []).length;
  if (braceOpen !== braceClose) {
    emit("FAIL", "SYNTAX", "(全文件)", `花括号不配平：{ ${braceOpen} 个 vs } ${braceClose} 个`);
  } else {
    emit("PASS", "SYNTAX", "(全文件)", `花括号配平 ${braceOpen}/${braceClose}，postcss 解析通过`);
  }

  /* ── 空规则（删除声明后留下的空块）────────────────────────────────── */
  const emptyRules = [];
  root.walkRules((r) => {
    const declCount = (r.nodes || []).filter((n) => n.type === "decl").length;
    if (declCount === 0) emptyRules.push(r.selector.replace(/\s+/g, " ").trim());
  });
  if (emptyRules.length) {
    emit("FAIL", "EMPTY-RULE", "（全文件）", `发现无任何声明的规则块（应整块删除）：${emptyRules.join(" | ")}`);
  } else {
    emit("PASS", "EMPTY-RULE", "（全文件）", "无声明为空的规则块");
  }

  return { lines, fails, warns };
}

/* ══════════════════════════════════════════════════════════════════════════
   自证有效（--self-test）
   做法：构造一份「全部合规」的 FIXTURE（先验证它 0 FAIL），再逐条注入违规，
   要求**对应断言的 id 必须报 FAIL**。注入抓不到 = 门禁是废纸。
   ══════════════════════════════════════════════════════════════════════════ */
const FIXTURE = `
.nav-map__station{width:11px;height:11px;border-radius:50%;border:1.5px solid #fff;box-shadow:0 0 0 1px rgba(15,23,32,.42);}
.nav-map__station--lrt{width:13px;height:13px;border-radius:3px;border:1.5px solid #fff;box-shadow:0 0 0 1px rgba(15,23,32,.42);}
.nav-map__station--tqh{width:12px;height:12px;border-radius:50%;border:1.5px solid var(--tqh-on);box-shadow:0 0 0 1px var(--tqh-map-edge);}
.nav-map__station--dim{width:8px;height:8px;border-width:1px;opacity:.45;box-shadow:none;}
.nav-map__station--lrt.nav-map__station--dim{width:11px;height:11px;border-radius:3px;opacity:.42;}
.nav-map__station--tqh-dim{opacity:.42;}
.nav-map__station--tqh-shared{background:linear-gradient(90deg,var(--accent) 0 50%,var(--tqh-map-half) 50% 100%);}
`;

const SELF_CASES = [
  {
    name: "FIXTURE 自身必须 0 FAIL（否则后面的注入实验全部无意义）",
    css: FIXTURE,
    expectFailIds: [],
  },
  {
    name: "注入 #3 原样回归：--onroute 放大到 16px + 描边 2px + 外圈 1.5px",
    css:
      FIXTURE +
      `\n.nav-map__station--onroute{width:16px;height:16px;border-width:2px;box-shadow:0 0 0 1.5px rgba(15,23,32,.4);}`,
    expectFailIds: ["NO-ONROUTE", "SWEEP"],
  },
  {
    name: "注入轻轨回归：--lrt.--onroute 放大到 18px",
    css: FIXTURE + `\n.nav-map__station--lrt.nav-map__station--onroute{width:18px;height:18px;border-radius:4px;}`,
    expectFailIds: ["NO-LRT-ONROUTE", "SWEEP"],
  },
  {
    name: "注入降级态反向：--dim 反而变大到 16px",
    css: FIXTURE + `\n.nav-map__station--dim{width:16px;height:16px;}`,
    expectFailIds: ["DIM"],
  },
  {
    name: "注入通琴号粗边回归（单类）：白环落到 96 个纯通琴号站上",
    css: FIXTURE + `\n.nav-map__station--tqh-onroute{box-shadow:0 0 0 2px var(--tqh-on),0 0 0 3px var(--tqh-map-edge);}`,
    expectFailIds: ["TQH-RING-SINGLE", "SWEEP"],
  },
  {
    name: "注入 #3 原样回归（双类）：关联站的 2px 纯白环加回来",
    css:
      FIXTURE +
      `\n.nav-map__station--tqh-shared.nav-map__station--tqh-onroute{box-shadow:0 0 0 2px var(--tqh-on),0 0 0 3px var(--tqh-map-edge);}`,
    expectFailIds: ["TQH-RING-SHARED", "SWEEP"],
  },
  {
    /* 这条专门证明"禁声明集合"比"只比 box-shadow 字符串"更严：
       这里**没有任何 box-shadow**，粗边是靠 border-width 造出来的 ⇒ 只比字符串会漏，本条必须红。 */
    name: "注入 border 通道粗边（不写 box-shadow）：关联站 border-width 2px",
    css: FIXTURE + `\n.nav-map__station--tqh-shared.nav-map__station--tqh-onroute{border-width:2px;}`,
    expectFailIds: ["TQH-RING-SHARED", "SWEEP"],
  },
  {
    name: "注入双色被抹：关联站 background 换成单色 ⇒ 圆点变单色、关联站在地图上消失",
    css: FIXTURE + `\n.nav-map__station--tqh-shared{background:var(--tqh-map-solid);}`,
    expectFailIds: ["TQH-DUAL"],
  },
  {
    name: "注入基准漂移：把全体巴士站标改成 20px",
    css: FIXTURE + `\n.nav-map__station{width:20px;height:20px;}`,
    expectFailIds: ["BASE-BUS"],
  },
  {
    name: "注入空规则：删光声明的残留空块",
    css: FIXTURE + `\n.nav-map__station--ghost{}`,
    expectFailIds: ["EMPTY-RULE"],
  },
];

function selfTest() {
  console.log("═══ 自证有效（--self-test）══════════════════════════════════════════");
  let bad = 0;
  for (const [i, c] of SELF_CASES.entries()) {
    const { lines, fails } = check(c.css, `<self-test#${i + 1}>`);
    const failedIds = [
      ...new Set(
        lines
          .filter((l) => l.startsWith("[FAIL]"))
          .map((l) => l.replace(/^\[FAIL\]\s+/, "").split(/\s+/)[0]),
      ),
    ];
    const missing = c.expectFailIds.filter((id) => !failedIds.includes(id));
    const unexpected = c.expectFailIds.length === 0 ? failedIds : [];
    const ok = missing.length === 0 && unexpected.length === 0;
    if (!ok) bad += 1;
    console.log(`\n${ok ? "[OK  ]" : "[BAD ]"} 用例 ${i + 1}：${c.name}`);
    console.log(`        期望报红 id = ${c.expectFailIds.length ? c.expectFailIds.join(", ") : "(无，应全绿)"}`);
    console.log(`        实测报红 id = ${failedIds.length ? failedIds.join(", ") : "(无)"}  | 总 FAIL 数 = ${fails}`);
    if (missing.length) console.log(`        ❌ 漏抓：${missing.join(", ")} —— 门禁在此项失效`);
    if (unexpected.length) console.log(`        ❌ 误报：${unexpected.join(", ")} —— FIXTURE 本身不合规`);
  }
  console.log("\n──────────────────────────────────────────────────────────────────────");
  console.log(
    bad === 0
      ? `自测通过：${SELF_CASES.length}/${SELF_CASES.length} 用例符合预期 ⇒ 门禁确实抓得到违规`
      : `自测失败：${bad}/${SELF_CASES.length} 用例不符合预期 ⇒ 门禁不可信，先修脚本`,
  );
  return bad === 0 ? 0 : 1;
}

/* ══════════════════════════════════════════════════════════════════════════
   入口
   ══════════════════════════════════════════════════════════════════════════ */
const argv = process.argv.slice(2);
if (argv.includes("--self-test")) {
  process.exit(selfTest());
}

const cssIdx = argv.indexOf("--css");
const cssPath = cssIdx >= 0 && argv[cssIdx + 1] ? resolve(argv[cssIdx + 1]) : join(ROOT, CSS_REL);

let cssText;
try {
  cssText = readFileSync(cssPath, "utf8");
} catch (e) {
  console.error(`读取失败：${cssPath}\n${e.message}`);
  process.exit(1);
}

console.log("═══ 站标规格门禁 ════════════════════════════════════════════════════");
console.log(`目标：${cssPath}`);
console.log(`不变量：① 基准锚定 ② --onroute 零盒模型声明 ③ --dim 只许变小 ④ 通琴号关联站：双色保留 / 白环不得存在`);
console.log("──────────────────────────────────────────────────────────────────────");

let result;
try {
  result = check(cssText, cssPath);
} catch (e) {
  console.error(`[FAIL] SYNTAX (全文件) —— postcss 解析失败：${e.message}`);
  process.exit(1);
}

for (const l of result.lines) console.log(l);

console.log("──────────────────────────────────────────────────────────────────────");
console.log(
  `总结论：${result.fails === 0 ? "PASS" : "FAIL"} —— FAIL ${result.fails} 项 / WARN ${result.warns} 项 / 共 ${result.lines.length} 条断言`,
);
if (result.fails > 0) {
  console.log("⇒ 站标规格被打破：本线站/降级态不得引入第二套尺寸或描边。");
  console.log("⇒ 若确属设计变更，请先找负责人拍板，再同步修改本脚本顶部 EXPECT 常量。");
}
process.exit(result.fails === 0 ? 0 : 1);
