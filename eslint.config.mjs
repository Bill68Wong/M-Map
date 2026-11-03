import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * ESLint 10 + eslint-config-next 16（v3.10.0 · Next 16 升级）
 *
 * ── 为什么不再用 FlatCompat ────────────────────────────────────────────
 *   `eslint-config-next@16` 已改成**原生 flat 配置**：`package.json` 的 `exports`
 *   指向 `dist/*.js`，而 `dist/index.js` / `dist/core-web-vitals.js` 的末尾是
 *   `module.exports = config`，且 `config` **本身就是数组**。
 *   ⇒ 旧写法 `new FlatCompat().extends("next/core-web-vitals")` 吃的是 eslintrc 风格的
 *     `plugin:xxx/recommended` 字符串，对导出数组会失效 ⇒ 必须直接 import 展开。
 *
 * ── ⚠️ 覆盖对象的 `files` 作用域不能省（实测踩过的坑）─────────────────
 *   `eslint-config-next@16` 把插件（`react` / `react-hooks` / `import` / `jsx-a11y` /
 *   `@next/next` / `@typescript-eslint`）注册在**带 `files` 的配置对象**里，而不是
 *   无条件对象里。所以任何想覆盖这些插件规则的配置块**必须声明同样的 `files`**，
 *   否则 ESLint 10 直接报：
 *     A configuration object specifies rule "react-hooks/xxx", but could not find plugin "react-hooks".
 *   这条不是笔误 —— 删掉 `files` 即可复现。
 */
const FILES = ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"];

/**
 * ── 为什么关掉 13 条 React Compiler 规则（另 1 条保留 + 经典两条保留）──
 *   `eslint-plugin-react-hooks@7`（Next 16 连带升级 5.2.0 → 7.1.1）把 `recommended`
 *   从「2 条经典规则」扩成「2 条经典 + 14 条 React Compiler 规则」，且 compiler 规则
 *   **默认是 error**。
 *
 *   升级前实测（HEAD 92a8912，未关任何规则）：**97 条 error / 0 warning**，
 *   全部来自 compiler 规则，分布：
 *     react-hooks/refs                 43  ← 多为「服务端时钟差补偿」在渲染期读 ref
 *     react-hooks/set-state-in-effect  42  ← 多为「挂载即拉数据」的 setState
 *     react-hooks/purity               10  ← 渲染期调 Date.now() / Math.random()
 *     react-hooks/static-components     2  ← 渲染期创建组件（**这 2 条是真问题，已单独修**）
 *
 *   其中 95 条属「既有设计 vs Compiler 保守假设」的冲突（例：用 ref 存服务器时钟偏移，
 *   对单调递增的偏移量实际没有并发渲染风险），逐条修等于为满足 lint 重写数据获取与
 *   时钟补偿架构，收益低、风险高。**这 97 条与本次安全升级无关**（是 compiler 规则
 *   新增的判定，不是漏洞），故按团队决定关闭，仅保留经典两条。
 *
 *   关闭后实测：**0 error / 0 warning** ⇒ 现有代码在 `rules-of-hooks` 与
 *   `exhaustive-deps` 两条经典规则上是干净的，这两条继续守着。
 *
 *   **例外**：`react-hooks/static-components` 保留为 `error` —— 它是唯一在本仓
 *   抓到**真缺陷**的一条（`TimerWizard` 的 `ZoneLocked` 定义在 render 内并以
 *   `<ZoneLocked />` 挂载 ⇒ 每次渲染都重建组件类型、子树状态被重置）。该处已修复
 *   （提升到模块级），全仓实测在此规则下 0 违规，故继续用它守着。
 *
 *   ⚠️ 不要为了"少几行"删掉这个块：删掉即恢复 97 条 error，`npm run lint` 直接红。
 */
const reactCompilerRulesOff = {
  name: "local/react-compiler-rules-off",
  files: FILES,
  rules: {
    // 以下 13 条为 React Compiler 规则（v7 新增），评估后关闭（理由见上方块注释）
    // ↑ 唯一保留开启的 compiler 规则：它在升级实测中抓到真问题（TimerWizard 的
    //   `ZoneLocked` 定义在 render 内），已在 commit 中提升到模块级修复。
    "react-hooks/static-components": "error",
    "react-hooks/use-memo": "off",
    "react-hooks/preserve-manual-memoization": "off",
    "react-hooks/incompatible-library": "off",
    "react-hooks/immutability": "off",
    "react-hooks/globals": "off",
    "react-hooks/refs": "off",
    "react-hooks/set-state-in-effect": "off",
    "react-hooks/error-boundaries": "off",
    "react-hooks/purity": "off",
    "react-hooks/set-state-in-render": "off",
    "react-hooks/unsupported-syntax": "off",
    "react-hooks/config": "off",
    "react-hooks/gating": "off",
    // 以下 2 条是经典规则，**必须保留**
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
  },
};

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTs,
  reactCompilerRulesOff,
  {
    // 约定：以 `_` 开头的形参/变量表示「有意不使用」（如 textOn(_hex) 统一白色后不再读入参），
    // 交给规则忽略，避免用无意义的 void 语句压制告警
    files: FILES,
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // `.cjs` 就是 CommonJS 文件，`require()` 是它的正常写法 ⇒ 关闭该规则
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // 以下目录都属于「不进仓库的本地/过程产物」，不参与 lint —— 否则 `npm run lint`
    // 会被上千条无关告警淹没，失去「守门」的意义：
    //   `.verify/`   = 本地验证草稿（探测脚本大量使用 any）
    //   `.workbuddy/`= 研究过程文件（含接口逆向分析，已 gitignore）
    //   `data/`      = 采集产物
    //   `next-env.d.ts` = Next 自动生成（已 gitignore），其中的 triple-slash 是框架产物
    ignores: [
      "node_modules/**",
      ".next*/**", // .next 及一切 distDir 变体（如构建备用目录 .next-v213）——构建产物不参与 lint
      "out/**",
      "build/**",
      "backups/**",
      ".verify/**",
      ".workbuddy/**",
      "docs/**", // 文档目录：设计过程资产与生成器脚本（非产品代码），与 .verify 同性质、不计入产品门禁
      "data/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
