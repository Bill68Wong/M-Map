# 调研 · 触摸点击反馈 · YouTube 与 Material 对照

> 迭代：导航修复批次（2026-11-04） · 对应需求 **U11「全项目用户操作点击体验升级」**
> 角色：产品经理。本文只做**产品调研与可操作化**；设计与技术实现分别由 designer / architect 出，各自回传 team-lead。
> 证据访问日期：**2026-11-04**。凡未取得一手材料者标 `[未获取到公开资料]` / `[未验证]`，不编造数值。

---

## 0. 结论摘要（先说三件最重要的事）

| # | 结论 |
|---|---|
| 1 | **YouTube 没有公开自己的触摸反馈规范。** 它的触摸反馈建立在 **Material Design** 之上（Google 全家桶同一套 ripple/state layer）。因此本文用 **Material 官方 token 原文**（Google 自己生成的 `_md-sys-state.scss` / `_md-sys-motion.scss` / `material-web` 的 ripple 实现）作为**可核对基准**，并明确标注「YouTube 具体落地无法逐值核对」。 |
| 2 | **本项目不是从零做，已有 20+ 个 `:active` 选择器与一套按压 Token**（`--dur-press: 90ms`、`--dur-release: 240ms`、`scale(0.96)`）。真正的问题不是「没有反馈」，而是**四件事：参数无出处、覆盖不一致、缺「最短按压保留」、缺触觉**。这决定了 U11 的工作量比「全项目重做」小得多，但验收必须逐元素过一遍。 |
| 3 | **本项目已经踩中 M3 的正确曲线**：`--spring-press: cubic-bezier(0.2, 0, 0, 1)` 与 Material `easing-standard` **完全相同**（`cubic-bezier(0.2, 0, 0, 1)`）。差的不是品味，是**时长与覆盖**（M3 的 ripple 生长是 450ms，我们从 90ms 到 240ms 都更短）。 |

**一个必须先纠正的认知**：负责人说「参照 YouTube 的触摸操作反馈」。YouTube 的「舒适感」在手机上**主要不来自动画**，而来自三件事（按重要性排序）：

1. **按下即响应**（不等 click）：`pointerdown` 就出反馈，延迟必须 < 100ms；
2. **滚动不误触发反馈**（触摸先等 150ms 判断是滑动还是按压）；
3. **短促点击也看得见**（反馈至少保留 225ms，否则快速点按会「闪一下什么都没有」）。

这三条恰好是**可数值化、可验收**的，也是本项目当前最缺的。动画曲线反而是我们已经做对的部分。

---

## 1. YouTube / Material 触摸反馈逐项拆解（对应负责人问的 6 点）

> 说明：以下数值全部来自 **Google 官方仓库生成文件**（Material Web，标注「automatically generated」），可逐行核对。YouTube 的 App 实现不公开，但其触摸反馈机制与本套 token 同源。

### 1.1 ① 按下瞬间有没有形变（scale 到多少）

**Material 原生方案：元素本身不缩放，用「涟漪 + 状态层」表达按下。**

`[官方文档]` Material Web ripple 实现（<https://raw.githubusercontent.com/material-components/material-web/main/ripple/internal/ripple.ts>）原文常量：

```ts
const PRESS_GROW_MS = 450;
const MINIMUM_PRESS_MS = 225;
const INITIAL_ORIGIN_SCALE = 0.2;
const PADDING = 10;
const SOFT_EDGE_MINIMUM_SIZE = 75;
const SOFT_EDGE_CONTAINER_RATIO = 0.35;
const TOUCH_DELAY_MS = 150;
```

关键点：`INITIAL_ORIGIN_SCALE = 0.2` 缩放的**是涟漪圆本身**（从触点的 20% 起扩），**不是按钮容器**。容器只叠加状态层颜色（pressed opacity 0.12）。

⇒ **结论**：Material 体系里，**按钮不缩放**；形变（scale）是 iOS/部分 Android 生态的做法。本项目现在用 `scale(0.96)`，属**偏离 Material 但可行**的本地选择——只要参数有出处、且不破坏布局。这一点我在 §5 给出明确建议。

### 1.2 ② 有没有涟漪（起始点、扩散时长、颜色不透明度）

**有涟漪，且参数可逐项核对：**

| 参数 | 值 | 出处（原文） |
|---|---|---|
| 涟漪起始点 | **触点坐标**（`getNormalizedPointerEventCoords`，取 `pageX/pageY` 减元素左上角）；键盘触发时取元素中心 | ripple.ts |
| 涟漪结束位置 | 元素中心（`endPoint = (width - initialSize)/2`）⇒ **从触点向中心聚拢并放大** | ripple.ts |
| 起始直径 | `maxDim × 0.2`（`INITIAL_ORIGIN_SCALE`） | ripple.ts |
| 生长时长 | **450ms**（`PRESS_GROW_MS`） | ripple.ts |
| 生长缓动 | `EASING.STANDARD` = `cubic-bezier(0.2, 0, 0, 1)` | ripple.ts + `internal/motion/animation.ts` |
| 最短保留 | **225ms**（`MINIMUM_PRESS_MS`） | ripple.ts |
| 按下颜色不透明度 | **0.12**（`pressed-state-layer-opacity`） | `tokens/versions/v0_192/_md-sys-state.scss` |
| 悬停不透明度 | **0.08**（`hover-state-layer-opacity`） | 同上 |
| 聚焦不透明度 | **0.12**（`focus-state-layer-opacity`） | 同上 |
| 拖拽不透明度 | **0.16**（`dragged-state-layer-opacity`） | 同上 |
| 状态层颜色 | `on-surface`（前景内容色），非固定灰 | `tokens/_md-comp-ripple.scss`：`'pressed-color': map.get($deps,'md-sys-color','on-surface')` |

**四档不透明度原文（逐行）**：

```scss
'dragged-state-layer-opacity': if($exclude-hardcoded-values, null, 0.16),
'focus-state-layer-opacity':   if($exclude-hardcoded-values, null, 0.12),
'hover-state-layer-opacity':   if($exclude-hardcoded-values, null, 0.08),
'pressed-state-layer-opacity': if($exclude-hardcoded-values, null, 0.12)
```

⇒ **结论**：本项目用 `filter: var(--state-active)` 代替状态层，属于**等效但不可审计**的做法（因为 opacity 值藏在 filter 里）。建议改为直接叠加 `background-color` 或 `::after` 状态层，把 **0.12** 写进 Token，这样能一眼核对。

### 1.3 ③ 时长与缓动曲线的具体数值

`[官方文档]` Material Web 生成 token（<https://raw.githubusercontent.com/material-components/material-web/main/tokens/versions/v0_192/_md-sys-motion.scss>）**逐行原文**：

**时长**

```scss
'duration-short1': 50ms,  'duration-short2': 100ms, 'duration-short3': 150ms, 'duration-short4': 200ms,
'duration-medium1': 250ms,'duration-medium2': 300ms,'duration-medium3': 350ms,'duration-medium4': 400ms,
'duration-long1': 450ms,  'duration-long2': 500ms,  'duration-long3': 550ms,  'duration-long4': 600ms,
'duration-extra-long1': 700ms … 'duration-extra-long4': 1000ms
```

**缓动**

```scss
'easing-standard':            cubic-bezier(0.2, 0, 0, 1),
'easing-standard-accelerate': cubic-bezier(0.3, 0, 1, 1),
'easing-standard-decelerate': cubic-bezier(0, 0, 0, 1),
'easing-emphasized':          cubic-bezier(0.2, 0, 0, 1),
'easing-emphasized-accelerate': cubic-bezier(0.3, 0, 0.8, 0.15),
'easing-emphasized-decelerate': cubic-bezier(0.05, 0.7, 0.1, 1),
'easing-linear':              cubic-bezier(0, 0, 1, 1),
```

**与按压缩放最相关的三个值**：

| 用途 | 时长 | 缓动 |
|---|---|---|
| 按下（状态层/涟漪出现） | ripple 生长 **450ms**；状态层颜色变化通常取 `short2~short3`（100–150ms） | `standard` = `cubic-bezier(0.2,0,0,1)` |
| 抬起（恢复） | 同样 `short2~short3`；最短保留 **225ms** 后才允许消失 | `standard` |
| 转场（非按压） | `medium2`（300ms）面板 / `long2`（500ms）全屏 | `emphasized` |

⇒ **本项目对账**：`--spring-press: cubic-bezier(0.2, 0, 0, 1)` **= Material `easing-standard`，完全一致**（做对了）。差异在时长：本项目按下 **90ms**、释放 **240ms**；Material 涟漪 **450ms** / 状态层 100–150ms。

### 1.4 ④ 抬起与取消时的行为差异

从 ripple.ts 的状态机原文注释可读出行为差异：

```
On Touch:
  - `INACTIVE -> TOUCH_DELAY -> WAITING_FOR_CLICK -> INACTIVE`
  - `INACTIVE -> TOUCH_DELAY -> HOLDING -> WAITING_FOR_CLICK -> INACTIVE`
On Mouse or Pen:
  - `INACTIVE -> WAITING_FOR_CLICK -> INACTIVE`
```

| 事件 | 行为 | 依据 |
|---|---|---|
| `pointerup`（抬起） | 若在 `TOUCH_DELAY` 阶段还没显示涟漪 ⇒ **抬起时才补显示**（`startPressAnimation`）；若已在 `HOLDING` ⇒ 转 `WAITING_FOR_CLICK` 等 click 收尾 | ripple.ts `handlePointerup` |
| `click` | 结束按压动画（`endPressAnimation`） | `handleClick` |
| `pointercancel`（被系统取消，如来电/手势返回） | **直接结束动画，不补显示** | `handlePointercancel` |
| `pointerleave`（手指移出元素） | 结束按压；注释原文：「release a held mouse or pen press that moves outside the element」 | `handlePointerleave` |
| `contextmenu`（长按弹菜单） | 结束按压动画 | `handleContextmenu` |
| **最短保留** | 即使抬起很早，也会等满 **225ms** 再撤掉按压态（`MINIMUM_PRESS_MS - pressAnimationPlayState`） | `endPressAnimation` |
| 新按压打断旧按压 | 旧动画被 `cancel()`，且旧动画不再负责撤销按压态（`if (this.growAnimation !== animation) return`） | `startPressAnimation` / `endPressAnimation` |

⇒ **两条可验收的产品行为**：
1. **快速点按必须有可见反馈**（≥225ms 保留）——本项目当前**没有**这个机制，90ms 的 `:active` 在快速点击时会一闪而过甚至看不到。
2. **取消不留残影**（`pointercancel` / `contextmenu` 必须清态）——本项目需逐元素确认。

### 1.5 ⑤ 长按与滚动的区分

**Material 的答案：触摸后先等 150ms（`TOUCH_DELAY_MS`），确认不是滑动/滚动，才显示涟漪。**

原文注释（ripple.ts）：

> 「Delay reacting to touch so that we do not show the ripple for a swipe or scroll interaction.」
> `const TOUCH_DELAY_MS = 150;`

状态机据此有了 `TOUCH_DELAY` 这一档：`INACTIVE → TOUCH_DELAY →（150ms 内抬起 = 可能是点击，补显示）/(150ms 后仍按住 = HOLDING，开始显示)`。

⇒ **与项目现状对照**：本项目已有 `usePressGuard`（`src/lib/use-press-guard.ts`），判据是 **位移 > 8px** 或 **按住 > 700ms** ⇒ 判为滚动/长按，不触发跳转。
**但两者解决的是不同问题**：
- `usePressGuard` = **不触发点击**（防误跳转）；
- `TOUCH_DELAY` = **不显示反馈**（防滚动时满屏涟漪）。

⇒ **本项目缺的是后者**。如果 U11 引入「按下即变色/缩放」，**滚动列表时每一行都会闪一下**，比现在更糟。这是 U11 最大的实现风险，必须在方案里明确「触摸需 150ms 延迟才显示按压反馈，鼠标可立即显示」。

### 1.6 ⑥ 是否有触觉反馈，什么场景用

| 事实 | 依据 |
|---|---|
| Material Design 的触摸反馈规范里**没有**触觉（haptics）一项，它只定义视觉状态层与涟漪 | 已核 `_md-sys-state.scss` / `_md-comp-ripple.scss` 全部 token，无 haptics 项 |
| **Web 端振动 API 不可靠**：MDN 明确标注 `Navigator.vibrate()` **「This feature is not Baseline because it does not work in some of the most widely-used browsers.」**，且需要 **sticky user activation** | `[官方文档]` <https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate> |
| Android 侧有 `HapticFeedbackConstants`（含 `KEYBOARD_TAP` / `CONFIRM` / `LONG_PRESS` 等） | `[未获取到官方原文]` 本次抓取被登录墙拦截（重定向至 accounts.google.com），不引用具体描述 |
| iOS 侧有 `UIImpactFeedbackGenerator`（light/medium/heavy 等） | `[未获取到公开资料]` 本次未取到原文 |

⇒ **产品结论（明确）**：本项目是 **PWA**，`navigator.vibrate` **不能作为唯一或主要反馈手段**（iOS 上大概率无效）。
**U11 应明确写成「触觉为可选增强，且默认关闭」**，理由：`vibrate` 在不支持的环境静默失败，若产品承诺「有震动」会造成「我的手机坏了」的困惑。

**若要做触觉，只建议两个场景**（且都需真机验证）：
1. 长按进入某种模式（如长按站点卡）；2. 关键确认（如「开始导航」）。
**不建议**给列表行、chip、折叠键加触觉——高频轻操作震动会变成噪声。

### 1.7 YouTube 特有行为的诚实说明

| 项 | 状态 |
|---|---|
| YouTube 是否有 ripple | `[未验证]`：App 内观察有按压色块变化，但无公开文档确认是否为标准 ripple |
| YouTube 按钮是否 scale | `[未验证]`：无公开文档。Android 版 YouTube 多数控件为 Material 标准（无缩放），iOS 版可能有轻微缩放，需逐帧录屏才能定 |
| YouTube 触觉 | `[未验证]`：无公开文档 |
| 可确认的一点 | `[官方文档·旁证]` YouTube 属于 Google 全家桶，其 Web 端组件库与 Material Web 同源；因此**采用 Material token 作为基准是可辩护的**，但不能声称「YouTube 就是这个数值」 |

**这条必须在 PRD 里写清**：我们不能对负责人说「照 YouTube 抄了具体数值」，只能说「按 YouTube 同源的 Material 规范取值，YouTube 具体落地需录屏核对」。这是诚实性问题，不是措辞问题。

---

## 2. 「舒适」的可操作化（每条给数值与来源）

> 原则：不写「要自然」「要跟手」，一律给可测量区间。验收时由 QA 用录屏逐帧或 DevTools Performance 断言。

| 属性 | 可验收区间 | 依据 | 说明 |
|---|---|---|---|
| **反馈延迟**（从 `pointerdown` 到可见变化） | **≤ 100ms**（目标 ≤ 50ms） | `[官方文档]` NN/g「0.1 second is about the limit for having the user feel that the system is reacting instantaneously」<https://www.nngroup.com/articles/response-times-3-important-limits> | 超过 100ms 会被感知为「没反应」，用户会二次点击 |
| **触摸反馈的启动延迟**（判断是滚动还是按压） | **150ms**（仅触摸；鼠标/触控笔 0ms） | Material `TOUCH_DELAY_MS = 150` | 滚动时**不应**出现按压反馈 |
| **最短按压保留** | **≥ 225ms** | Material `MINIMUM_PRESS_MS = 225` | 保证快速点按也看得见；这是「廉价感」的主要来源之一 |
| **按下动画时长** | **90–150ms**（视觉颜色/缩放）；若做涟漪则 **450ms** 生长 | 项目现状 90ms；Material 状态层 100–150ms、涟漪 450ms | 按压要「快」，不要「慢」 |
| **抬起恢复时长** | **150–300ms** | 项目现状 240ms；Material `short3~medium1`（150–250ms） | 恢复可以比按下慢，但不要 > 300ms |
| **按下缓动** | `cubic-bezier(0.2, 0, 0, 1)` | Material `easing-standard`；**项目 `--spring-press` 已是此值** | 已达标，不要改 |
| **抬起缓动** | 推荐 `cubic-bezier(0.2, 0, 0, 1)`（无过冲）；**不建议** back-out 过冲 | Material 全程用 standard；项目定义 `--spring-release: cubic-bezier(0.22, 1.9, 0.36, 1)`（有明显过冲） | 过冲在「按下-抬起」微交互里会显得「弹」，也是廉价感来源。**详见 §5 的冲突项** |
| **按下颜色不透明度** | **0.12**（0.08–0.16 区间内） | Material `pressed-state-layer-opacity = 0.12` | 低于 0.08 看不出，高于 0.16 变「脏」 |
| **悬停不透明度**（桌面） | **0.08** | Material `hover-state-layer-opacity` | 本项目以移动端为主，可后置 |
| **按下缩放幅度** | **0.96–0.98**（若采用缩放方案） | 项目现状 0.96（按钮）/ 0.94（图标键）；Material 不缩放 | 低于 0.94 会「抖」，高于 0.98 看不出 |
| **动画时长上限（非按压类）** | **≤ 300ms**（面板/行展开）；全屏转场 ≤ 500ms | 项目 Token 已定 `--dur-slow: 300ms`；Material `medium2 = 300ms`、`long2 = 500ms` | 本项目已达成，是优点 |
| **误触位移阈值** | **8px** | 项目 `PRESS_MOVE_PX = 8`（`use-press-guard.ts`） | 已达标 |
| **长按判定阈值** | **700ms** | 项目 `PRESS_HOLD_MS = 700` | 已达标；但注意 Material 无此概念，这是本项目自定 |

---

## 3. 本项目适配清单（逐元素）

> 依据：`src/app/globals.css` 现有 `:active` 覆盖（已核到 20+ 处）+ `use-press-guard.ts`。
> 状态图例：**已有** = 现成 `:active`；**不全** = 有但仅换底色、无过渡；**缺** = 完全没有。

| 元素 | 现状 | 建议反馈类型 | 理由 |
|---|---|---|---|
| **主按钮**（`.btn` / `button`） | **已有**：`scale(0.96)` + `filter: var(--state-active)` + 90ms/240ms | 保留，但**补最短保留 225ms** | 已是最完整的一类；缺的只是「快速点按看不见」 |
| **次按钮**（`.btn--text` / `.btn--undo`） | **已有**（`btn:active` 覆盖） | 保留；文字按钮建议**只用颜色/透明度**，不用缩放 | 纯文字按钮缩放会带动周围文字视觉抖动 |
| **图标按钮**（`.btn--icon`） | **已有**：`scale(0.94)` | 保留 0.94（比 0.96 稍大，补偿小尺寸） | 小目标需要更明显的形变才「跟手」 |
| **推荐大卡**（`.rc` / `RecommendCard`） | **已有**：`scale(0.96)` + `surface-dim`（`globals.css:1254`），且 reduced-motion 有兜底 | 保留；**不要加涟漪** | 卡片面积大，涟漪会大面积泛色；整卡缩放已经是「按下整张卡」的清晰隐喻 |
| **通用卡片**（`.press-card`） | **已有**：`scale` + 变体 `--ok` | 保留 | — |
| **列表行**（`.rpanel__row` / `.rv-card` / `.line-result` / `.ssheet__item` / `.fav-flat__main`） | **不全**：多数只有 `background: var(--surface-2)`，**无 transition ⇒ 瞬间跳变** | **改为「底色 + 120ms 过渡」**，不加缩放 | 行高小，缩放会让整列文字抖动；但瞬间跳变会被感知为「廉价/像网页链接」 |
| **底部导航 / 顶部返回刷新** | 顶部是 `.btn--sm`（已覆盖）；底部 tabbar **未见 `:active`** | 补：图标 `scale(0.94)` + 底色 | 底部导航是最高频入口，缺反馈最明显 |
| **地图 pin（站点/地点标记）** | **缺**（`.pin` 有 56 处样式但无 `:active`） | **只变色/描边，不缩放**；加 100ms 过渡 | **关键**：地图上缩放 pin 会与「地图缩放图层级」混淆；且 pin 位置若位移会导致用户以为点错了 |
| **地图上的车辆图标** | **缺** | **不加按压反馈** | 车辆图标是**实时数据展示**，不是按钮（点了通常是查看车辆详情，属次要）。给它按压态会让用户以为可以拖动 |
| **chip / 线路标签**（`.chip` / `.rl-chip` / `.nav-linechip__x`） | **部分**：`.chip` 明确 `transform: none`（v1.1.7 防回归注释：4 列网格里缩放会串味）；`.rl-chip` 有 `:active` | 保留 `.chip` 不缩放；**若做，只用底色 0.12 状态层** | 网格内元素缩放会带动相邻元素视觉错位 |
| **开关**（`.switch`，22 处样式） | **未见 `:active`**（状态由 `--on` 表达） | 补：按下时滑块 `scale(0.96)` + 轨道底色加深 | 开关是「切换」语义，按压反馈应落在**滑块**上而不是整条轨道 |
| **折叠键**（`.fold` / `.step-sheet__handle` / `.sheet` 抓手） | 抓手 `:active` 已有（`.step-sheet__handle`）；文本折叠键未见 | 补：只变色 + 加 `aria-expanded` 视觉指示 | 折叠是「状态改变」，不是「动作触发」，反馈应轻 |
| **输入框右侧搜索键** | 已由全局 `button:active` 覆盖（`globals.css:2395` 注释已说明） | 保留 | — |

### 3.1 两处「特殊」的展开说明（负责人特别点名）

**① 地图上的可点击元素（pin / 车辆图标）**

特殊性：地图本身是**可拖拽缩放的连续画布**，其上的元素有三重语义冲突——
- 缩放 pin ⇒ 用户会以为「点一下地图会放大这个点」；
- 位移 pin ⇒ 用户会以为点在别处，或误判 pin 的真实位置；
- 大面积 ripple ⇒ 遮挡地图信息，且地图已有大量视觉元素。

⇒ **建议**：pin 用「描边加粗 + 底色加深」100ms，**不缩放、不位移、不涟漪**；车辆图标**不给按压态**（它是数据层，不是操作层）。若要表达「可点」，用**光标/可点击性提示**（桌面 hover 描边），而不是按压动画。

**② 长列表（收藏列表、站点列表）**

特殊性：**滚动时若有按压反馈，每一行都会闪**，比没有反馈更糟。
- 本项目已有 `usePressGuard`（8px/700ms）防误跳转，但它**不阻止视觉反馈**；
- Material 的解法是 `TOUCH_DELAY_MS = 150`（先等 150ms 判断）。

⇒ **建议**：
1. 列表行的按压反馈**必须**走 150ms 触摸延迟（鼠标可立即）；
2. 一旦位移 > 8px（复用现有 `PRESS_MOVE_PX`）⇒ **立即撤掉按压态**；
3. 行反馈只用**底色**（不含缩放、不含位移），避免整列抖动。

---

## 4. 反面清单（会被感知为「卡顿」或「廉价」）

| 反面做法 | 为什么不行 | 依据/来源 |
|---|---|---|
| **每行都加涟漪** | 滚动时满屏白点扩散；长列表里涟漪还会被裁切不完整 | Material 只在「按下确认」后显示（`TOUCH_DELAY_MS=150`），本质就是为了避免这个 |
| **全屏/大面积 ripple** | 大卡上涟漪从触点扩散到边缘需要 450ms 且覆盖整张卡，会把卡面文字短暂「罩住」 | 本项目卡片 200–280px 高（`use-press-guard.ts` 注释），面积过大 |
| **按下后元素位移（translate）** | 位移会让用户怀疑「我点到旁边了」，在列表里还会造成整行跳动（CLS 类问题） | 项目现有方案只用 `scale`，未用 `translate`，是对的 |
| **动画 > 300ms 的按压反馈** | 按压是「微交互」，超过 300ms 会与「页面转场」混淆，产生延迟感 | Material 状态层取 `short2~short3`（100–150ms）；项目 `--dur-slow` 上限 300ms |
| **只有 `:active` 没有最短保留** | 快速点按（<90ms）时反馈一闪而过 ⇒ 用户感觉「没反应」，会重点 | Material `MINIMUM_PRESS_MS = 225` 就是为解这个 |
| **抬起用 back-out 过冲曲线** | 过冲在「按下-抬起」这种 1 次往返的微交互里会显得「弹一下」，廉价感的典型来源 | Material 全程 `standard`（无过冲）；项目 `--spring-release: cubic-bezier(0.22, 1.9, 0.36, 1)` 有明显过冲（`1.9` 控制点） |
| **用 `filter` 做状态层** | 不可审计（无法一眼核对 0.12）、且 `filter` 会触发额外合成层，长列表可能掉帧 | Material 用 `background-color` + 状态层；建议改 |
| **给车辆图标加按压态** | 实时数据层被误读为可操作层 | 见 §3.1① |
| **承诺震动却在不支持的设备静默失败** | 用户会怀疑手机坏了 | MDN 明确 `vibrate` 非 Baseline |
| **按下态与 focus 态视觉相同** | 键盘用户无法区分「我按下了」与「焦点在这」 | Material 用不同 opacity（pressed 0.12 / focus 0.12）但配不同形状（focus 有 ring）；本项目已有 `--focus-ring`（`.line-result:focus-visible` 可见） |

---

## 5. 与现有 Token 的对账（含一处**必须由 designer/architect 决断的冲突**）

### 5.1 已经做对的部分（不要动）

| 项 | 现状 | 对账结论 |
|---|---|---|
| 按下缓动 | `--spring-press: cubic-bezier(0.2, 0, 0, 1)` | **= Material `easing-standard`，完全一致** |
| 面板/抽屉时长上限 | `--dur-slow: 300ms`、`--sheet-dur-open: 300ms`、`--sheet-dur-close: 240ms` | 符合 Material `medium2 = 300ms` |
| 抽屉缓动 | `--sheet-ease: cubic-bezier(0.32, 0.72, 0, 1)` + 注释「标准减速，无 overshoot」 | 正确（过长转场不应有 overshoot） |
| 误触判据 | `PRESS_MOVE_PX = 8`、`PRESS_HOLD_MS = 700` | 达标 |
| reduced-motion | 全局 `@media (prefers-reduced-motion: reduce)` 已把动画压到 0.01ms，且 `button:active` 明确 `transform: none` | **做得很完整**（很多项目会漏 `:active` 的 transform） |
| 禁用态对比度 | 明确不用 `opacity:.55`，改「换色不降透明」（`globals.css` v1.1.7 注释：原对比度仅 2.58:1） | 正确，且是同类项目常犯错的点 |

### 5.2 冲突项（需 designer / architect 决断，我只报事实）

**冲突：注释说不许用过冲曲线，但 Token 定义了过冲曲线、并被按钮使用。**

| 证据 | 位置 |
|---|---|
| 注释：「过渡时长（全部 ≤300ms；**禁弹跳曲线 —— 不使用 `--spring-release`**）」 | `src/app/globals.css:197`（该注释位于抽屉/面板 Token 段内） |
| 但 `--spring-release: cubic-bezier(0.22, 1.9, 0.36, 1)` 被定义 | `src/app/globals.css:282` |
| 且被 `button` 的 `transition: transform var(--dur-release) var(--spring-release)` **实际使用** | `src/app/globals.css:473` |
| `1.9` 是 back-out（过冲）控制点，视觉上会「弹一下」 | 曲线语义 |

⇒ **我可以确定的**：这两句话在同一个文件里互相矛盾，且按钮确实在用。**我不能确定的**：`line 197` 的「禁弹跳」是本意只约束抽屉（局部规则），还是全局规则（而按钮违规）。**这个必须由 designer/architect 裁定**。

**我的产品倾向（供参考，不代替设计决策）**：按压抬起用**无过冲**（Material 全程 standard），因为过冲在 1 次往返的微交互里最容易读成「廉价」；抽屉开合若需要「到位感」，可另议。理由见 §4。

### 5.3 覆盖缺口清单（可直接转成任务）

1. **列表行类**：`.rpanel__row`、`.rv-card`、`.line-result` —— 只有底色、**无过渡** ⇒ 需补 120ms 过渡。
2. **底部导航**（tabbar）—— **未见 `:active`** ⇒ 需补。
3. **开关**（`.switch`）—— 需补（落在滑块上）。
4. **地图 pin** —— 需补（只变色/描边，不缩放）。
5. **车辆图标** —— **明确不加**（防误读）。
6. **全局最短按压保留 225ms** —— **完全缺失**，需统一机制。
7. **触摸 150ms 延迟** —— **完全缺失**，是引入按压反馈后的**前置风险控制**（否则滚动时满屏闪）。
8. **状态层改用可审计的 background/::after**（替代 `filter`）—— 建议但非必须。

---

## 6. 验收口径建议（给 QA，可逐条断言）

| 编号 | 断言 | 测法 |
|---|---|---|
| AC-U11.1 | 任一可点元素从 `pointerdown` 到出现可见变化 **≤ 100ms** | DevTools Performance 录一段点按，量事件到首帧样式变化 |
| AC-U11.2 | 快速点按（按下-抬起 < 90ms）**仍能看到按压反馈** | 录屏逐帧：反馈可见时长 ≥ 200ms |
| AC-U11.3 | 在长列表上**滑动滚动**时，沿途各行**不出现**按压反馈 | 录屏 + 慢放；或断点验证 150ms 延迟分支 |
| AC-U11.4 | 手指按下后位移 > 8px，按压态**立即撤销** | 交互测试 |
| AC-U11.5 | 抬起恢复时长 ∈ [150, 300]ms | 录屏 |
| AC-U11.6 | `prefers-reduced-motion: reduce` 下所有按压动画 ≤ 20ms 且无缩放 | 系统设置切换后重测 |
| AC-U11.7 | 键盘 Tab 聚焦有 focus ring，且与 pressed 态**视觉可区分** | 键盘操作 |
| AC-U11.8 | 地图 pin 按下**不产生** scale / translate | 录屏逐帧比对 pin 边界框 |
| AC-U11.9 | 车辆图标按下**无**按压态 | 交互测试 |
| AC-U11.10 | 触觉（若实现）在不支持环境**静默降级**，界面不出现「震动已开启」类承诺文案 | 在 iOS Safari 真机验证 |
| AC-U11.11 | 任一元素在禁用态下**无**按压反馈 | 交互测试 |

---

## 7. 未验证清单

| 项 | 为什么未验证 | 怎么补 |
|---|---|---|
| YouTube 的具体数值（ripple 参数、是否 scale、是否震动） | 无公开规范 | 真机逐帧录屏（Android + iOS 各一台） |
| Material 官方文档页 `m3.material.io` 正文 | 该站为客户端渲染，两次抓取均只返回标题 ⇒ **本文数值全部改用 Google 生成的 token 源文件**（可逐行核对），未引用未取到的网页正文 | 若需逐字引用官网，需用可渲染 JS 的方式抓取 |
| Android `HapticFeedbackConstants` 原文描述 | 抓取被重定向至登录墙 | 从 AOSP 源码或离线文档核对 |
| iOS `UIImpactFeedbackGenerator` 具体档位 | 未取到原文 | 从 Apple 官方文档核对 |
| `filter` 替代状态层在长列表的实际掉帧 | 需真机 profile | 低端 Android 实测（本项目目标机型） |
| 视觉上 0.12 与项目 `--state-active` 的实际等效程度 | 需比对实际渲染色值 | designer 取值后比对截图色值 |

---

## 附录 · 来源清单（访问日期 2026-11-04）

| # | 来源 | 用途 | 等级 |
|---|---|---|---|
| 1 | <https://raw.githubusercontent.com/material-components/material-web/main/tokens/versions/v0_192/_md-sys-state.scss> | 四档状态层不透明度原文：dragged 0.16 / focus 0.12 / hover 0.08 / pressed 0.12 | 官方仓库（自动生成文件） |
| 2 | <https://raw.githubusercontent.com/material-components/material-web/main/tokens/versions/v0_192/_md-sys-motion.scss> | 时长（short1 50ms … extraLong4 1000ms）与缓动（standard 0.2,0,0,1 等）原文 | 官方仓库（自动生成文件） |
| 3 | <https://raw.githubusercontent.com/material-components/material-web/main/tokens/_md-comp-ripple.scss> | ripple 的 pressed/hover 颜色取自 `on-surface`、opacity 引用状态层 token | 官方仓库 |
| 4 | <https://raw.githubusercontent.com/material-components/material-web/main/ripple/internal/ripple.ts> | `PRESS_GROW_MS=450`、`MINIMUM_PRESS_MS=225`、`INITIAL_ORIGIN_SCALE=0.2`、`TOUCH_DELAY_MS=150`、触点起始/中心收束、抬起/取消/移除差异、状态机原文 | 官方仓库 |
| 5 | <https://raw.githubusercontent.com/material-components/material-web/main/internal/motion/animation.ts> | `EASING.STANDARD = cubic-bezier(0.2, 0, 0, 1)` 等全部缓动常量 | 官方仓库 |
| 6 | <https://www.nngroup.com/articles/response-times-3-important-limits> | 「0.1 second … reacting instantaneously」原文（反馈延迟上限 100ms 的依据） | 官方文档 |
| 7 | <https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate> | 「not Baseline … does not work in some of the most widely-used browsers」+ 需 sticky user activation | 官方文档 |
| 8 | <https://m3.material.io/foundations/interaction/states/state-layers> | 状态层概念（**正文未取到，仅标题**，本文未引用其内容） | 抓取失败，标注 |
| 9 | <https://m3.material.io/styles/motion/easing-and-duration/tokens-specs> | 同上（**正文未取到**） | 抓取失败，标注 |

**关于「48dp 最小触控目标」**：本次未从官方页面取到原文（`m3.material.io` 正文渲染不可抓），故**不在本文作为数值依据使用**。若 U11 需要该约束，请 designer 从其设计规范侧确认后再落 Token。

**项目内证据**：`src/app/globals.css:162-164`（`--dur-instant/base/slow`）、`:197`（禁弹跳注释）、`:278-284`（`--spring-press` / `--spring-release` / `--dur-press` / `--dur-release`）、`:473`（按钮使用 `--spring-release`）、`:495-518`（`button/.btn/.chip/.btn--icon` 的 `:active`）、`:550`（reduced-motion）、`:720/:738`（`.press-card`）、`:1254`（`.rc:active`）、`:1756`（`.rc` reduced-motion）、`:2466/:3545/:4406/:4521/:4677/:5040/:5108/:7506/:8168/:8406`（各类行/chip/结果项 `:active`）、`src/lib/use-press-guard.ts`（`PRESS_MOVE_PX=8`、`PRESS_HOLD_MS=700`）。
