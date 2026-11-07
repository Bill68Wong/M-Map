# ADR-119：机器绑定型门禁不得进入 `npm run verify` 链

## Status

Accepted（2026-11-07 · 迭代批次 `docs/迭代-跨境交通-20261106/`）

> 本 ADR 只记录「一条门禁为什么被移出强制链」的判据与处置，不复述焦点门禁本身的
> 断言内容（那是 `scripts/check-vehicle-model-focus.mjs` 与 QA 报告的实现细节）。
> 文中行号以落盘时工作区为准；脚本在实测后补过环境前提注释，行号若漂移以文件头注释为准。

## Context（背景）

`npm run verify`（`package.json:49`）是交付前的强制门禁链：链上任一项失败，整链即红，
交付不得放行。本轮实测发现该链末位的 `npm run test:vehicle-model-focus` 是一条**机器绑定型**
检查——它依赖「作者本机的绝对路径」与「未被版本控制的前置文件」：

- `playwright-core` 既不在本项目 `node_modules`，也不在 `package.json` 的
  dependencies / devDependencies 中；
- 该脚本通过 `.verify/qa2-lib.mjs` 间接加载 `playwright-core`，而该文件
  `.gitignore:51` 被 `/.verify/` 整体忽略，干净克隆上根本不存在；
- `.verify/qa2-lib.mjs` 自身硬编码了作者本机的绝对路径，并以
  `channel: "chrome"` 依赖本机已安装的 Chrome。

后果是确定的：这条门禁在作者本机可跑（21/21 绿），但在干净克隆 / CI 上必然抛
「找不到 playwright-core」，使 `npm run verify` 末位固定变红，整链不可用。一条只能在一台
机器上通过的检查，不构成门禁——它只是那台机器上的一个脚本。本 ADR 据此定判据并落处置。

## ① Decision — 我们选了什么

**一、把机器绑定型门禁从强制链中摘出。**
从 `verify` 链移除 ` && npm run test:vehicle-model-focus`，链条由 24 项变为 23 项，
末位变为 `npm run test:xborder-ui`（`package.json:49`）。此改动使干净克隆 / CI 上的
`verify` 可全绿，不再被一条不可移植的检查固定拖红。

**二、脚本本身保留，改为按需独立执行。**
`npm run test:vehicle-model-focus`（`package.json:121`）**不删除**。它仍可在具备
`playwright-core` 与本机 Chrome 的机器上单独运行，其结论照常可作为验收报告的证据。
摘出的是「每次 verify 必须通过的硬性前置」，不是「检查本身」。

**三、在脚本头声明环境前提。**
`scripts/check-vehicle-model-focus.mjs:1-7` 补环境前提注释：依赖 `playwright-core` 与本机
Chrome（`launch` 的 `channel: "chrome"`）；`playwright-core` 未锚定在 devDependencies、
`.verify/qa2-lib.mjs` 被 `.gitignore:51` 忽略；故不在 `npm run verify` 链内，须单独执行。
脚本头写明前提，是让下一个在此机器上找不到依赖的人，第一眼就知道「这是环境缺失，不是代码坏了」。

## ② Alternatives considered — 为什么不是另一个（含被否方案的具体代价）

**被否方案一：门禁发现问题就跳过（或「失败不计入」）。**
这会让门禁失去意义。本 ADR 选择的「摘出」与之有本质区别：

- 「摘出」是**构建期的静态分工**：在 `package.json` 的脚本定义里，把这条检查永久分派到
  「按需独立执行」的位置，链上根本没有它；谁在什么机器上跑 `verify`，行为都一致。
- 「发现问题就跳过」是**运行期的动态放行**：门禁仍在链上，只是这次失败被忽略——它使
  「红」可以随时被解释成「跳过」，是假绿的直接来源。

被摘出的门禁仍保留可执行脚本，且其结论被记入验收报告作为证据，只是不再作为每次 verify 的
硬门；它没有获得「可以失败而不被看见」的豁免权，只是不再出席每次强制集合。

**被否方案二：把 `playwright-core` 加进 devDependencies。**
不解决问题。`playwright-core` 不自带浏览器二进制，`launch()` 仍走
`channel: "chrome"` 去找本机已安装的 Chrome；问题只是从「缺包」挪到「缺浏览器」，
CI 上照样红。加包会让 `npm install` 多一个依赖、少一条报错，但门禁的可移植性没有改善。

**被否方案三：用环境变量开关决定这条门禁是否执行 / 是否放行。**
这会让门禁根据运行环境自行决定要不要通过，是「门禁自我豁免」，属假绿来源。判据很简单：
一条门禁若能在「环境不具备」时选择不执行，它就不再是门禁，而是建议。
（注：脚本 `loadChromium()` 里确有 `PLAYWRIGHT_CORE` 这一环境变量分支，但它是指定
`playwright-core` 的**模块路径**，不是「是否放行」的开关——设了它仍需该模块存在且可用；
缺依赖时脚本照样抛错。二者语义不同，不构成本条被否方案的例外。）

**被否方案四：把 `.verify/qa2-lib.mjs` 提交入库，让干净克隆也有这个文件。**
不解决问题。该文件是「只读验收公共库」，内容硬编码了作者本机的绝对路径
（`file:///C:/Users/<user>/...`）与 `OUT` 本机目录；即使入库，换一台机器路径即失效，
检查仍会在 `import` 一步挂掉。且 `.verify/` 被 `.gitignore:51` 整体忽略，零星放行单个
文件会破坏「验收产物不入库」的既有约定。

## ③ Consequences — 后果、遗留风险与重评条件

**正面后果：**
- `npm run verify` 在干净克隆 / CI 上恢复可全绿（23 项），不再被不可移植检查固定拖红。
- 焦点门禁的检查能力不丢失：脚本保留，按需可跑，结论仍能进验收报告。

**负面后果与遗留风险：**
- 该焦点检查不再随每次 `verify` 强制执行，存在「被遗忘」的风险。缓解方式：把它列入
  验收报告的必跑清单，由 QA 在每次交付前手动执行并在报告中留痕，而不是依赖链的自动触发。
- 它是「移出」而非「修复」，可移植性问题本身仍在；只是不再阻塞主链。

**恢复为强制门禁的前置条件（本迭代不做，三项需同时满足）：**
1. 在 devDependencies 锚定 `playwright-core`（版本固定，不依赖传递依赖）；
2. 提供跨平台浏览器安装步骤（如 `npx playwright install chromium`，不依赖本机 Chrome）；
3. 去掉 `.verify/qa2-lib.mjs` 对绝对路径的依赖（改由环境变量或包解析定位）。

**重评触发：**
- 上述三项前置满足后，可评估把 `test:vehicle-model-focus` 重新并入 `verify` 链。
- CI 若引入受控的浏览器环境（容器内预装 Chromium），可重评第 2 项是否仍必要。

## ④ Evidence — 本轮实测（可直接引用）

1. `ls -d node_modules/playwright-core` 无输出 ⇒ `playwright-core` 不在本项目
   `node_modules` 内，也不在 `package.json` 的 dependencies / devDependencies 中
   （`package.json:130-149` 实测确认）。
2. `scripts/check-vehicle-model-focus.mjs` 的 `loadChromium()` 优先
   `await import("../.verify/qa2-lib.mjs")`（主控实测时位于 `:104`；补环境前提注释后
   当前位于 `:110`，其前另有 `PLAYWRIGHT_CORE` 路径直传分支）。
3. `.verify/qa2-lib.mjs:2-4` 硬编码
   `file:///C:/Users/<user>/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js`
   （原文含作者本机用户名，此处置为 `<user>` 脱敏）；同文件 `launch()` 用
   `channel: "chrome"`（`:12`）⇒ 依赖本机已安装的 Chrome。
4. `git check-ignore -v .verify/qa2-lib.mjs` → `.gitignore:51:/.verify/` ⇒ 该 lib 不入库，
   干净克隆上不存在。
5. 结论：`npm run test:vehicle-model-focus` 在作者机器可跑（21/21），在干净克隆 / CI 上
   必然抛「找不到 playwright-core」，使 `npm run verify` 末位固定变红。
6. 现行 `package.json:49` 的 `verify` 链共 24 项（处置前），末位即该门禁；处置后为 23 项，
   末位 `npm run test:xborder-ui`。

## 判据沉淀（可复用形状）

> **一个检查若依赖「作者本机的绝对路径」或「未被版本控制的前置文件」，则它不构成门禁，
> 只能算本机脚本。这类检查必须移出强制链，并在脚本头声明环境前提。**

拆开成三条可操作判据：

1. **可移植性判据**：`git clone` 到干净目录后，不安装任何非版本控制的文件，能否直接通过？
   不能，则不是门禁。
2. **依赖判据**：它的全部依赖是否都在 `package.json` 显式锚定、且不含本机绝对路径？
   否则不是门禁。
3. **分工判据**：需要额外环境的检查，应在脚本层声明前提、在文档层列入手动清单，
   由人按环境触发——而不是让每次 `verify` 都替它买单。

## Related ADRs

- ADR-117：凭证扫描与入库纪律。本 ADR 的落盘同样沿用「写入前先扫、0 命中才写」的执行顺序。
- ADR-118：同一类「用结构消灭不可靠形态」的判定架构决策；本 ADR 属工程门禁治理，
  与判定架构无耦合，仅共享「可见性与可恢复性优先」的取舍取向。
- ADR-116：采集与验收链路的相邻决策。
