# ADR-113：点击反馈沿用现有 CSS 按压体系，不引入 ripple

## Status

Proposed（2026-11-04，待 team-lead 裁决；对应负责人需求 U11「全项目用户操作点击体验升级」）

## Background

负责人要求「让用户在点击任何按钮时都有舒适的按键反馈，主要参照 YouTube 的触摸操作反馈」。

架构盘点后的第一个事实是：**本项目已有一套成熟、设计良好的全局按压系统**，U11 的合理形态是「补齐缺口 + 收口纪律」，
不是「新建一套 ripple」。证据（均在 `src/app/globals.css`）：

| 能力 | 位置 | 现状 |
|---|---|---|
| 触摸优化基元 | `:468-480` | `button, .btn, .btn--undo` 统一挂 `-webkit-tap-highlight-color: transparent` / `touch-action: manipulation` / `user-select: none` |
| 按压/释放双曲线 | `:472-479`、`:493-508` | `transform` 走释放曲线（`--dur-release` 240ms + `--spring-release` overshoot）；其余属性走按压曲线（`--dur-press` 90ms） |
| 按下态 | `:495-508` | `transform: scale(0.96)` + `filter: var(--state-active)`（`brightness(0.9)`，暗色 `1.16`，`:259-260`/`:333-334`） |
| `:active` 覆盖 | 27 条选择器行 | 覆盖 19 个类名 |
| 已知 fill-mode 坑 | `:1171-1176` | 已修：`.anim-fade-up` 用 `backwards` 不用 `both`，否则动画 to 帧的 transform 会压住 `:active` 缩放 |

盘点缺口（`node docs/迭代-导航修复-20261104/scan-click-feedback.mjs src/app/globals.css`，可复跑）：

```
cursor:pointer 规则数 = 57 · 含 :active 的选择器行数 = 27 · 缺口候选 = 45
```

但 45 个缺口里**大多数是 `<button>`**（自动继承全局 `button:active` 兜底 ⇒ 有反馈）。
逐个判定标签后（`resolve-click-tags.mjs`），**真缺口只有 4 类**：`.nav-brand`、`.link-hit`、`.rc-report__link`、`.route-sheet__peek`、`.help-faq__q`
（`.fav-sheet__scrim` 是遮罩，按惯例不加，列入白名单）。

这**不是新问题**：v1.1.7 已踩过一次同型坑（`:456-467` 注释：「站内大量按钮其实是 `<a class="btn">` … ⇒ 这些元素点了毫无反馈」）——
当时只把 `.btn` 类补上了，**没补非 `.btn` 的链接**。

### 三个真实缺陷

1. **非 button 可点击元素零反馈**（上述 4 类）。
2. **`prefers-reduced-motion` 的形变抑制是「发现一处补一处」**：现有**三个**独立块 —— `:541-553`（全局 `*` + `button:active`）、
   `:1755-1759`（`.rc:active`，因为 `.rc` 是 div 不吃 button 规则）、`:2707-2711`（`.nav-locate-fab`）。
   `.rc` 需要单独补块这件事本身就说明：非 button 的形变类元素**不在**全局覆盖内。
3. **reduced-motion 下唯一生效的反馈通道（`filter` 颜色变化）没有验收断言守着**。
   将来若有人把 `filter` 换成 `transform`（为了"更跟手"），reduced-motion 用户会**完全失去反馈**。

## Decision

### 1. 沿用现有 CSS 按压体系，不引入 Material ripple

给 4 类真缺口补 `:active` 规则，复用既有 token（`--dur-press` / `--state-active`），**不新增颜色字面量**。

不引 ripple 的四条理由：

1. **系统已建成且是设计过的**（双曲线 + 状态层 + 已修过的 fill-mode 坑）。推倒换 ripple 是负收益 —— 缺的只是 4 处覆盖和 1 条纪律。
2. **「跟手」这件事已经由 `touch-action: manipulation`（`:471`）做到了**。团队要的「YouTube 那种跟手」，在本项目里主要就是**按压态即时出现**：
   90ms 曲线 + `scale(0.96)` + `filter` 加深，按下后 ≤16ms 即可见。**ripple 提供的是装饰，不是跟手。**
3. **ripple 与既有 `overflow:hidden` 容器、密集 z-index 表的冲突面大于收益**（z 表已排到 68~130）。
4. **reduced-motion 下 ripple 必须全禁** ⇒ 维护两套反馈；CSS 方案在 reduced-motion 下天然只剩 `filter`，正好符合「保留最小可见反馈」。

若负责人坚持要 ripple 的视觉：**只接 2~3 处大目标**（路线大卡 `.rc`、底部导航），绝不全量接 ——
全量接等于给每个列表行加一次 DOM 操作 + 一次裁剪排查。

### 2. 顺序硬约束：先收口 reduced-motion，再补反馈

**U11-1（收口）必须先于 U11-2（补反馈）。**

理由：现有形变抑制按选择器逐个补（3 个块）。若先给 `.nav-brand` 等加 `transform`，就多出 4 个需要各自补 reduced-motion 块的元素 ——
**扩大了这个洞**。收口方式：用一条 `:where(...):active { transform: none }` 承载全部形变抑制，
使新增元素**自动**被覆盖，而不是要求实现者记得补第四块。

这与 ADR-111（未走段两套参数）是同一原则：**一个语义一组参数，差异只允许用"程度"表达，不允许按元素各自实现。**

### 3. 五条硬边界（实现者不得自行取舍）

| # | 边界 | 验收 |
|---|---|---|
| H1 | 必须支持 `prefers-reduced-motion: reduce`：关形变、**保留最小可见反馈** | P-4 |
| H2 | 不得引入新 npm 依赖 | `package.json`/`package-lock.json` 零 diff |
| H3 | 不得用 emoji 作图标 | `git grep -nP "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]"` 0 命中 |
| H4 | 不得阻塞主线程（若用 JS ripple 首帧 ≤16ms） | 选 CSS 方案天然满足（零 JS） |
| H5 | 不得改变命中范围与层级 | P-5（rect 四值不变）+ z 表：`ghost 68 < done 69 < ahead 70 < 彩段 72 < now 73 < 站点 90/95 < pin 110/120 < 蓝点 128 < 车辆 130` |

### 4. 可机器验收判据

| # | 判据 | 形式 |
|---|---|---|
| P-1 | 覆盖率 | `resolve-click-tags.mjs` 的「真缺口」段落**为空**（白名单：`.fav-sheet__scrim`） |
| P-2 | 按下态可断言 | `:active` 时 `transform` 或 `filter` 至少一项非默认值（移动端用 `page.touchscreen.tap()` + 读 computed style，不用 hover） |
| P-3 | 时长契约 | computed `transition-duration` === token（90ms / 240ms，**容差 0**），防有人改成 300ms+ 让反馈变"黏" |
| P-4 | reduced-motion 契约 | reduce 下：① 所有可点元素 `transform` 计算值 ∈ {`none`, `matrix(1,0,0,1,0,0)`}；② 按压时 `filter` ≠ 默认值（证明最小反馈仍在） |
| P-5 | 命中范围不变 | 改动前后同组选择器 `getBoundingClientRect()` 四值**完全相等** |
| P-6 | 无新依赖 / 无 emoji | H2 / H3 的 grep |
| P-7 | 无布局抖动 | 按下前后**父**元素 rect 四值完全相等 |
| P-8 | 纪律收口（防回归） | `prefers-reduced-motion` 块**数量不得增加**；形变抑制由单一规则承载 |

## Consequences

正面：

- 工作量最小：4~5 条 `:active` 规则 + 1 条收口规则。回滚 = 删掉对应行。
- 零新增依赖、零 JS、零合成层压力 —— 长列表（站点列表、推荐卡列表）无额外开销。
- 顺带修掉一个**既有的无障碍缺口**：非 button 链接/卡片完全没有按压反馈（v1.1.7 遗留）。
- reduced-motion 从「三个补块」收口成一条规则后，**新元素自动被覆盖**，不再依赖"记得补"。

负面（均已承接）：

- 视觉上不如 ripple「华丽」。这是明确取舍：本项目的「跟手」目标是**按压态即时出现**，不是装饰动效。
- `filter: brightness()` 在部分低端机上是非合成属性，可能触发重绘。但既有系统已用它（`:490`/`:495-508`），
  且覆盖范围是单个元素而非整页 ⇒ 风险与现状相同，不因本改动增加。
- 收口 `:where(...)` 的优先级为 0，需确认它能压过各元素的 `transform: scale(...)`。
  **待验证**：`:where()` 优先级为 0，实际可能压不住 `.rc:active { transform: scale(0.96) }`（`:1254`）。
  ⇒ 收口规则可能需要写成 `:root:active` 组合或提高特异度；**这一点必须在实现时先写一条最小验证用例确认**，
  不允许凭印象选写法（本 ADR 只登记"必须收口"这个约束，具体写法由实现者验证后定）。

## Related ADRs

- ADR-111（未走段两套参数）：同一原则 —— 一个语义一组参数。本 ADR 的收口对象是「形变抑制」，其对象是「未走线样式」。
- ADR-109 / ADR-110 / ADR-112：同批「同一概念多处实现」病灶的其他实例。
