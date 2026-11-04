# 07 · QA — 开屏播放条件与边界 · EARS 验收（v4.1 · 版本门废除后重写）

> 角色：测试工程师（严过关）。承接 `06-产品-开屏播放条件与边界.md`（v2 定稿）§6 移交项：P1~P10 转 EARS。
> 契约源：**06-产品-开屏播放条件与边界.md**（唯一产品口径）· 05-设计-开屏与加载动画-规格.md（视觉与动画）· 02 附录 A5（观测契约）。
> 状态：**v4.1 = 版本门废除后的新口径 + 三处裁定落地**（P1c 路由不播 / P7 钩子契约批准 / §5.4 裁定闭环）；实现正在改造（当前源码仍为 5 态 + cookie 门），代码落地即跑。

## 0. 口径变更（v3 → v4）

| v3（已作废） | v4（现行） |
|---|---|
| 版本门 = cookie `mmap.splash.ver`，服务端 SSR 判定 | **无版本门**：每次页面加载都播，SSR 恒直出 |
| 五态 | **五态保留**（PM 定稿，06 §2 P8 为准）：`playing/skipped/done/reduced/blocked`。`blocked` = **挂载边界标记**（仅 `pageshow.persisted` bfcache 还原写入，本次播放作废），**不参与优先级链**、**机验不可达 ⇒ 不写机验断言**（归真机）。优先级链仅约束同一挂载实例内的终态竞争 |
| 预置/读值走 `context.addCookies` / `context.cookies()` | **零预置**：前置条件归零，断言只依赖 `body[data-splash-state]` + `[data-splash-root]` |
| S2/S3/S4/S7/S8（播不播的分支、cookie 被禁模拟） | **整段删除**；改为 P1（必播）/ P2（暖启动不播）/ P10（防回潮） |
| 07 §1 = 模拟配方唯一真相源（cookie 头剥离等） | **该指向作废**（无 cookie 可模拟）；仅保留方法论：**模拟必须禁掉实现真正走的那条路** |

> 旧文档引用已更新：原 `06-产品-开屏触发机制-验收标准.md` **已删除**，一切引用指向 `06-产品-开屏播放条件与边界.md`。

## 1. 观测契约与模拟手段

| 项 | 手段 | 说明 |
|---|---|---|
| 状态钩子 | `body[data-splash-state]` ∈ **五值** `playing/skipped/done/reduced/blocked`，**其中仅 4 值机验可达** | 值域与互斥见 P8；`blocked` 依赖真实 bfcache（headless 不可靠）⇒ **不断言它**，观测到则记录并归真机 |
| 容器钩子 | `document.querySelector('[data-splash-root]')` | 双条件断言必配：容器必须真移除 |
| 首屏节点（P5） | `.nav-shell` + `.nav-map-wrap`（现状选择器）+ `body[data-vehicle-layer]` | 用于「动画层存在时首屏已在 DOM」的时序断言 |
| **加载态钩子（P7）** | **契约三属性**：`[data-loader-root]`（容器）+ **`[data-loader-mode]`**（`loop`/`static`）+ **`[data-loader-slot]`**（`boot`/`request`）。**禁用 `data-loader-state`**（组件 `!active` 时 `return null` ⇒ 属性恒 `"loading"`，断它永远绿）。**`[data-loader-root]` 会出现两个节点**（中心位 + 内联位）⇒ 断言**必须指定 slot**，否则计数含混 | 见 §5.1；**P7 标 `blocked`**（非 pending）——`BrandRouteLoader` 零引用，屏幕上不会有加载态，今天不可能通过，且原因不在断言 |
| reduced-motion | `page.emulateMedia({ reducedMotion: "reduce" })` | P4 |
| 慢网（P7） | `page.route` 延迟首屏关键请求（如 `/api/**`）> 动画时长 | P7 |
| 暖启动（P2） | bfcache：`goBack()`/`goForward()` + **哨兵验证**（见 §5.2） | P2 |
| 防回潮（P10） | cookie（`context.cookies()`）+ localStorage（`page.evaluate` 全量键快照）**加载前后 diff** | P10 |

**[项目纪律]** 全部定位走 `data-*` 钩子，禁止样式类（03-测试文档验收门纪律）；容器存在性断言一律**双条件**（状态值 **且** 容器移除）。
**[方法论]** 凡需"禁用某能力"的模拟，必须禁掉**实现真正走的那条路**（v3 遗留教训：门在服务端读请求头时，禁 JS `document.cookie` 测不到真路径）。v4 无 cookie 机制，此条暂无用武之地，保留作通则。

## 2. EARS 验收标准（P1~P10）

| 编号 | EARS 验收标准 | 断言方式 | 状态 |
|---|---|---|---|
| P0 | 每例前置守卫：任何用例 setup 完成后，**覆盖层不得残留**（`[data-splash-root] === null`）。 | 每个用例开头断言。**这条能点亮一个隐蔽缺陷**：dev 模式 StrictMode 双调用 effect 时，第二遍记 `blocked` 就 return ⇒ 监听与兜底计时器不重建 ⇒ `gone` 恒 false ⇒ 覆盖层 960ms 后视觉消失但**仍在 DOM 且 `pointer-events` 未禁**，吞掉全站点击。现象是"元素点不动"，极易误判成选择器写错。 | 可写 |
| P1 | When 页面加载（新标签 / 刷新 / 深链 / PWA 冷启动任一），系统必须播放动画：`data-splash-state` 经 `playing` 到终态 `done` 或 `skipped`，且 `[data-splash-root]` 峰值恰为 1、最终移除。 | 新 context 加载 + MutationObserver 记录序列与 root 峰值/移除；**刷新路径**再 `reload()` 一次，两次都必须播（覆盖"连续刷新不做冷却"）。 | 可写，待实现 |
| P1d | When **深链**进入内页（`/help`、`/line/xxx`、`/card/...` 等），系统必须播放动画（挂载点 `layout.tsx` ⇒ 深链同样加载，且 06 §1「含外部链接/分享链接进入 ⇒ 播」）。 | `page.goto(BASE + "/help")` → 断 ①`rootSeenAt !== null`（容器出现过）②序列含 `playing` 且终态 ∈ TERMINAL。 | 可写，待实现 |
| P1b | When 连续快速刷新（不防抖、不冷却），系统必须每次都播。 | 同一 page `reload()` 两次（间隔 <1s），两次加载各自观测到 `rootSeenAt !== null`。 | 可写，待实现 |
| P1c | When **客户端路由**切换（`/favorites` 底导回 `/`、`/help` ↔ `/`、收藏组合回放回 `/` 等，页面未重载），系统**不得**播放开屏。 | **不断特定值**（挂 `layout.tsx` 后组件实例不变、不重挂 ⇒ state 保持整页加载时的终态，不新增写入）。断两件**合取**：①全程 `playing` 只出现 1 次（= 首次整页加载那次）②回首页后 `[data-splash-root]` 不存在。缺一不可：只断①漏视觉遮挡；只断②会在「组件压根没渲染」时空转。另附 `navigation.type !== 'reload'` 佐证未整页重载。 | 可写，待实现 |
| P2 | When 暖启动（bfcache 前进/后退还原），系统**不得**重播：`[data-splash-root]` 不出现、状态序列无新的 `playing`。 | 哨兵闸门 + 断言（详见 §5.2）：①`window.__sentinel` 前后同值（证明 JS 未重跑）②回来无新 root ③`navigation.type === 'back_forward'`。**哨兵不同值 ⇒ 判 SKIP（本次非真 bfcache），不判 PASS/FAIL。** | 可写但**预期 SKIP**（headless bfcache 不稳定，归真机） |
| P3 | When 播放中点击任意处，系统必须在 ≤120ms 内淡出并**移除**容器，`data-splash-state === "skipped"`，首屏立即可交互。 | 真实 click 事件（capture 阶段 `performance.now()`）为基准 → MutationObserver 记录移除时间；断 ①`skipped` ②root === null ③≤120ms（失败输出实际 ms）④`elementFromPoint` 命中下层。 | 可写，待实现 |
| P4 | When `prefers-reduced-motion` 开启，系统必须直接渲染**完整末帧**（无位移动画），`data-splash-state === "reduced"`，容器按正常时机移除。 | `emulateMedia({reducedMotion:"reduce"})` → 加载 → 断 ①终态 `reduced`（**严格不是 done**）②序列从未出现 `done` ③容器移除 ④**末帧完整性**（见 P4b，不可省）。 | 可写，待实现 |
| P4b | **末帧完整性（防 D1 假绿）**：全局杀开关只压 `animation-duration`、**不清 `animation-delay`** ⇒ 各元素仍在自己的 delay 到点才跳末帧。开屏钉子 delay=600ms ⇒ 0–600ms 画面是**缺钉子的 logo**，而 ①②③ 全绿。必须在容器移除前取 computed style 断完整性。 | 在 `reduced` 态记录后、约 700ms 处取：①钉 `transform` 含 `matrix(1,`（**不是** `matrix(0,`）②路线 `strokeDashoffset ≈ 0` ③涟漪 `opacity ≈ 0` ④光点 `opacity ≈ 0` 或 `transform` 含 `0.35`。修复前钉为 `scale(0)`、修复后 `scale(1)` ⇒ 恰好能区分。 | 可写，待实现 |
| P5 | 全程：动画**不得推迟首屏内容渲染**。动画层存在期间，首屏（地图容器 + 底部面板结构）必须已在 DOM 中渲染完毕；禁止"等动画播完才挂载首屏"。 | 在 `[data-splash-root]` 存在的**同一时刻**采样：`.nav-shell` 与 `.nav-map-wrap` 已存在（`count > 0`）。用 MutationObserver 在 root 首次出现的那次回调内取快照（不是事后查）。 | 可写，待实现 |
| P6 | When 动画结束或跳过（`done`/`skipped`），系统必须 ≤100ms 内首屏可交互，且动画层不得残留。 | 状态进入终态瞬间打点 → 轮询 `elementFromPoint` 命中下层且无 root → 断言 ≤100ms + root === 0。 | 可写，待实现 |
| P7 | When 首屏内容就绪时间 > 动画时长（慢网），动画结束后必须由加载态接住，**不得出现"动画播完、屏幕空白/静止无反馈"**。 | `page.route` 延迟首屏关键请求 > 960ms → 等 `done` → 断 ①`[data-loader-root]` 存在 ②动画层已移除（职责交接完成，`[data-splash-root] === null`）③内容就绪后加载态容器消失。**禁止**用 `.brand-loader` 样式类定位。 | **阻塞于实现**（钩子契约已批准，见 §5.1）；未落地前 SKIP 并注明，**不降级为弱断言** |
| P7c | When **跳过**开屏（P3 快捷路径）→ Then 开屏容器撤走后，`.nav-map__cover` **第一帧就必须有完整内容**：既有图标又有文案。 | 点击后每 16ms 采样：断「`[data-splash-root]` 消失后每一帧，`cover` 若存在则**同时**满足 ①`children.length > 0` ②`textContent.trim().length > 0` ③`querySelector('svg') !== null`」。③ 专防「只有文案没图标」（= 被否掉的方案 1 形态）。 | **已知缺陷，实测红**（见 §5.5） |
| P7d | 全程：`.nav-map__cover` 内 `.brand-loader__label` 的**水平中心位置不得跳动**。 | 加载期间连续采样 `label.getBoundingClientRect()`，断 `cx` 极差 < 2px。**专抓「文案跳位」**——`children.length > 0` 抓不到（内容不空）、穿透守卫抓不到（不遮挡）、残留守卫抓不到（没有残留）。这是被否掉的方案 1 的真实副作用（文案 cx 195→223，右移 28px）。 | 可写（方案 2 落地后应绿） |
| P8 | 全程 `data-splash-state` **机验可达值** ⊆ `{playing, skipped, done, reduced}`，并满足优先级 `skipped > done > reduced > playing`（reduced 下正常结束记 `reduced`，跳过一律记 `skipped`）。`blocked` 为挂载边界标记（仅 bfcache），机验不可达、**不设断言**。 | 逐挂载实例审计：①可达值域 ⊆ 四值 ②无优先级倒退 ③`reduced` 不得变 `done` ④`skipped`/`done` 为终态后不再变更。若观测到 `blocked`：**不判红**，记录并归真机（依赖 bfcache）。 | 可写，待实现 |
| P8s | **静态守卫（防回潮，正确形式）**：开屏组件源码**不得使用持久化媒介**记录已播：`localStorage` / `sessionStorage` / `document.cookie` 一律禁止（模块级内存变量合法——随 document 销毁，不影响"每次加载都播"）。**断言前必须剥离注释**（源码注释里写有"不用 sessionStorage"之类说明，直接 grep 会误报）。 | 剥注释后正则：`/localStorage/`、`/sessionStorage/`、`/document\.cookie/` 三者均不得命中。另：`blocked` 应**仅在 bfcache 路径**写入（`pageshow.persisted`），**不得**用于客户端路由或频次拦截——`blocked` 保留但只有这一个合法写入点。 | 可写 |
| P8b | **`blocked` 去留的决策留痕（重要教训）**：本项在本轮被反复裁决共 5 次（保留→删除→保留→删除→**最终保留 5 值**）。根因不是偏好反复，而是**挂载点（page.tsx ↔ layout.tsx）在变**——挂 page 时组件会重挂、需要标记拦截；挂 layout 时不重挂、但 **bfcache 还原仍是独立的 blocked 写入点**。最终口径：挂 layout + 保留 `blocked`（仅 bfcache）。教训：**枚举值去留必须绑定「代码里有无真实写入路径」，不能靠推演**。 | 不单独设断言；P8 已把可达值域收为 4 值、blocked 归真机 | 已定稿 |
| P9 | 全程动画层存在时全页唯一实例。 | `querySelectorAll('[data-splash-root]').length ≤ 1`，播放期间多次采样取峰值。 | 可写，待实现 |
| P10 | **负向断言（防回潮）**：页面加载完成后，cookie 与 localStorage 中**不得新增任何"开屏/splash"相关键**；加载前后快照无可归因于开屏的变化。 | 加载前 `context.cookies()` + localStorage 全键快照 → 加载并播完 → 再取快照 → diff：①不得出现键名含 `splash`/`mmap.splash` 的项 ②cookie 数量与值不变（同 context 内）。 | 可写，待实现 |

## 2.5 运行环境要求（影响判读，必读）

| 项 | 要求 | 原因 |
|---|---|---|
| **必须 production build**（`next build && next start`） | 是 | 本项目未显式设 `reactStrictMode`，App Router 缺省开启 ⇒ `next dev` 下 effect 双调用，触发 P0 描述的"覆盖层残留吞点击"缺陷。**dev 下的点击类失败是假象**，不得当作产品缺陷。 |
| 只读 | 是 | 全部 GET，无写入接口。 |
| 不打线上 | 是 | 线上为旧版，且避免配额/统计污染。 |

## 3. 失败排查备忘（先查实现，再判缺陷）

| 现象 | 先查什么 |
|---|---|
| P1 刷新后没播 | 是否有残留的"会话已播"标记（sessionStorage/模块级变量）——06 §3 明确「不加本次会话已播标记」 |
| P2 判 SKIP 而非 PASS | 哨兵值变了 ⇒ 说明是重载不是 bfcache 还原，属**测试环境限制**，不是缺陷；改真机验 |
| P5 红 | 首屏节点是否被 `Suspense`/动态 import 推迟到动画结束后才渲染（这正是 P5 要防的） |
| P6 偶发超 100ms | 输出实际 ms，区分 CI 冷启动抖动（React 卸载是微任务级，正常应在几十 ms） |
| P7 无法判 | 加载态无 `data-*` 钩子 ⇒ 属**可测性缺口**，报实现补钩子，不要用样式类凑（样式类会被改版重命名） |
| P8 出现 `blocked` 在**段中** | `blocked` 合法位置只有「新挂载段首」与「bfcache 打断段尾」。出现在段中（如 `playing→done→blocked→done` 同一挂载内）视为异常，需查是否有第三个赋值点 |
| P10 发现 splash 键 | 版本门回潮，**直接打回**（06 §3「不做版本门」是硬边界） |

## 4. 自动化 vs 真机

| 归类 | 项 |
|---|---|
| 可自动化（Playwright） | P1 / P1b / **P1c** / P3 / P4 / P5 / P6 / P8 / P9 / P10 |
| 条件自动化（bfcache 生效则自动，否则 SKIP） | P2 |
| **阻塞于实现钩子** | P7（`[data-loader-root]` + `[data-loader-mode]` 契约已批准，待落地） |
| 必须真机 | iOS 主屏 PWA 暖启动是否走 bfcache（06 §5.1）· 各浏览器下拉刷新是否完整加载（06 §5.2）· 真机 reduced-motion |

## 5. 已裁定结论 / 待实现配合

### 5.1 P7 依赖的加载态钩子（**契约已批准**，待实现落地）

02 附录 A5 已登记、已派前端：

```
<div class="brand-loader" role="status" aria-live="polite"
     data-loader-root="1" data-loader-mode="loop">
```

- `[data-loader-root]`：加载态容器存在性（P7 断言点，随生灭）
- `[data-loader-mode]`：`loop`（当前只有循环变体）；若设计侧采纳「末帧→加载态」改静态呼吸，会增加 `static`

**在实现落地前 P7 保持阻塞**（不降级为「body 非空」——那在「动画播完一片空白」时也会绿，属假绿）。**禁止**用 `.brand-loader` 样式类定位（项目纪律 + 改版会断）。

### 5.2 P2 暖启动的可测性（我的判断）

headless Chromium 的 bfcache 常不生效，`goBack()` 很可能走完整重载。若直接断言"不播"，会**红得毫无意义**（红的是环境，不是代码）。因此本用例设一道**哨兵闸门**：

1. 切走前 `window.__sentinel = Math.random()`；
2. `goBack()` 回来后读：**同值 ⇒ 真 bfcache 还原**，继续断言"无新 root、无新 playing"；**不同值 ⇒ 本次是重载**，判 **SKIP**（标注"环境未走 bfcache，需真机"）；
3. 辅证：`performance.getEntriesByType('navigation')[0].type === 'back_forward'`。

**我不用** `dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))` 伪造——那只验 handler 分支，验不到"还原后 DOM 真没容器"，属假绿。

### 5.3 "暖启动不留痕"我的结论：**同意 06 口径，不加显式值**

理由：暖启动时 bfcache 还原的是**已移除容器后**的 DOM，动画层本就不存在，"不播"是**免费**的、无需任何状态表达。若真写一个值，反而要求暖启动时挂载动画层组件去写它——与"不播"自相矛盾。故 P2 只断"容器不出现 + 无新 playing"，不依赖任何状态值。

### 5.4 客户端路由回首页：**已裁定「不播」**（PM 2026-11-02，06 §1 已补）

裁定三条理由（06 原文）：①内页切换时首屏数据多在内存/缓存、地图常秒开，播 960ms 是**纯推迟到达**，与"优化等待"初衷相反；②一次使用内来回切底导 4~6 次，频率远高于冷启动，**这才是真正会腻的场景**；③客户端路由不产生页面加载，"每次页面加载都播"天然推出"客户端路由不播"。

**落地方式**：靠**挂载位置**实现（`splash` 不进客户端路由的重挂载路径），**不靠**会话标记压制——06 §3 已明文禁止"为了实现路由不播而加会话标记"（会同时撞 P10 与"不做频次控制"）。→ 断言见 **P1c**。

**衍生边界（P1c 与 P7 不互相污染的关键）**：从收藏点组合「回放」回首页会真的发规划请求，那时要遮的是**请求等待**，由**加载态 `[data-loader-root]`** 承担。职责划分：**开屏遮应用启动（页面加载），加载态遮请求等待（客户端路由/数据请求）**——两个钩子各管一段，断言不得混用。

### 5.5 P7c 已知缺陷：跳过路径下 `.nav-map__cover` 空容器 ~146ms

**实测（2026-11-02，3.6.1 构建，`BUILD_ID=a_cKeoNg8vGJk7fYs7-uE`）**，从点击跳到地图就绪的逐帧采样：

```
+0ms    root=1  cover=1  kids=0  textLen=0    ← 空容器（此刻被开屏遮着，不可见）
+132ms  root=0  cover=1  kids=0  textLen=0    ← 开屏撤走，露出**纯色空容器**
+278ms  root=0  cover=1  kids=1  textLen=6    ← 「地图加载中…」才出现
+411ms  root=0  cover=0                       ← 地图就绪，cover 消失
```
⇒ **开屏撤走后有约 146ms 是「有容器、无内容」**（容器高 656px，有 `--surface-dim` 背景，所以不是白屏，但没有任何加载指示）。

**根因（不是 bug 而是两套机制的时间轴错配）**：
- `BrandRouteLoader` 内部有 `GATE_MS = 300` 门控（`visible` 为 false 时 `return null`），设计目的是「地图 >300ms 才就绪才显示，避免快路径闪烁」；
- `.nav-map__cover` 一进 `phase === "loading"` 就渲染（含背景色），但子节点要等门控到点；
- **正常路径**：开屏 960ms 才撤走 ⇒ 300ms 门早已到点 ⇒ 无缝，缺陷从不暴露；
- **跳过路径**：用户 ~100ms 跳过 ⇒ 开屏 132ms 撤走，门还没到 ⇒ **空窗**。

**修复选项（给实现方，我不定方案）**：
- A. 文案不受门控（文字比动画轻量，"地图加载中…"闪一下优于纯色块）—— 改动最小；
- B. 门控起点改绑「开屏是否仍在」（开屏遮着的时段不计入 300ms 预算）—— 语义最准，但引入耦合；
- C. 接受 146ms（低于常见感知阈值 300ms，且非白屏）—— 需产品确认。

**已裁定（设计师 2026-11-02）：采用方案 2 —— `GATE_MS = slot === "map-cover" ? 0 : 300`。**

方案 1（文案不受门控）被**实测否掉**：`.brand-loader` 是 `flex-direction: row` + 整体居中，300ms 后插入 48px 图标会让整组重新居中 ⇒ **文案中心 cx 195 → 223，右移 28px**。空窗是"没有东西"，跳位是"东西动了"，后者更糟（人眼对位移远敏感于静态缺失）。故新增 **P7d** 专守此点。

**两条护栏（改 `GATE_MS` 前必读）**：
- **`map-cover` slot 的 `GATE_MS` 必须为 0**：任何 > 0 的值都会在**跳过路径**重开空窗（空窗时长 ≈ `GATE_MS − 跳过时刻`）。
- **`request` slot 的 `GATE_MS = 300` 不得改小**：那里没有"容器已出现"的前置信号，门控是防快路径闪烁的唯一手段。
- 两 slot 语义不同，组件内应有一句注释写明，否则后人会以为是同一个参数。

**定级（共识）**：**P2**（非 P0/P1）。cover 有 `--surface-dim` 底色不是白屏；147ms 远低于 Doherty 400ms 阈值；且仅在"主动跳过"这条少数路径可见。

**定位纪律的一个例外（P7c 用 `.nav-map__cover` 而非 `[data-loader-root]`，是有意的）**：
架构师已否决新增 `data-cover-root` 钩子，理由是 `map-cover` 门控为 0 ⇒ loader 与 cover 同帧生灭 ⇒ 二者等价。**这个等价只在系统正确时成立**——而 P7c 的职责恰恰是抓两者的**失同步**（GATE_MS=300 时代 cover 有、loader 无，正是 P7c 抓到的那个缺陷）。若把 P7c 的检测器换成 `[data-loader-root]`，失同步复现时 root 也不存在 ⇒ 断言"通过"⇒ **恒真，抓不到它本来要抓的 bug**。
⇒ 原则补全：**当断言的目的就是验证两个机制的同步性时，检测器必须独立于被验证方**。P7c 保留 cover 侧定位（样式类），P7d 的 label 量几何同理（同"取样式值"范畴）。**此例外已经架构师确认对齐**（2026-11-02 回执：原话「你的盲区指认是准确的」，并把「让被告兼任法官」原样收进 08，与「钩子最小化」并列成对；其否决条件清单里 "cover 存在但 loader 不存在" 的场景**历史上真实发生过**，即 P7c 抓到的那个）。

**QA 判断**：不按 P0/P1 定级（146ms 且无白屏、无内容跳变）；但**必须留断言**，否则将来门控参数改动会让空窗变长而无人察觉。

## 6. 与旧版（v3）的用例映射

| 旧 | 新 | 说明 |
|---|---|---|
| S1 首次播放 | **P1** | 语义由"cookie 缺失"改为"任意加载" |
| S2 日常启动不播 | 删除 → **P10** | 反转为防回潮负向断言 |
| S3 major 重播 / S4 minor 不播 | 删除 | 版本门作废 |
| S5 跳过 | **P3** | 不变 |
| S6 reduced | **P4** | 不变 |
| S6b fill-mode both | 保留（并入 P4 静态校验） | 杀开关下防跳回初始帧 |
| S7 中断不重播 | 删除 → **P1b** | 反转为"连续刷新每次都播" |
| S8 cookie 被禁 | 删除 | 无 cookie 机制 |
| S9 唯一实例 | **P9** | 不变 |
| S10 五态审计 | **P8** | 保留五值，`blocked` 改语义为「本次挂载未播放」 |
| S11 `@supports not (offset-path)` | 保留（P4 的静态伴随项） | 浏览器能力降级，与门无关 |
| — | **P2 / P5 / P6 / P7** | 新增：暖启动、不推迟首屏、≤100ms 可交互、慢网接加载态 |
| — | **P1c** | 新增（PM 裁定）：客户端路由不播——职责划归挂载位置，不靠会话标记 |
