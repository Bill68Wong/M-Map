# route_changed 改动前基线（R0）

> 迭代：导航修复批次（2026-11-04） · 执行：产品经理（许清楚） · 用途：为 PRD `AC-9.15`（收敛后 `route_changed` 发生率不得上升）提供**改动前基线**
> 数据文件：同目录 `route-changed-baseline-20261104.json`
> **只读**：本次仅 SELECT + 调用现有纯逻辑，**未改 `src/`、未 build、未提交、未写库**。

---

## 0. 结论摘要

| # | 结论 | 强度 |
|---|---|---|
| 1 | **主口径基线 = 0 次失败 / 42 个采样点（0.00%）**；失败 OD 数 = 0 | 实测 |
| 2 | ⇒ **`AC-9.15` 的正确形态是「收敛后必须为 0」**，不是「≤ 基线率」。基线为 0 时两者等价于同一要求，但**必须写成"必须为 0"**，否则"≤0%"这种表述后人会误读为允许极小概率 | 由 #1 推出 |
| 3 | 另有一条**不属于本基线**的失败：**真实链路（href 内 `limit=5`）3 次失败 / 42 = 7.14%**，全部集中在 `home→school` 三个座区的**第 6 张卡**。这是 U10 的 limit bug（`RecommendCard` 点击不传 limit），由 `AC-10.3` 覆盖 | 实测 |
| 4 | **M2（缓存过期重算漂移）本次未观测到**（force 复算全部 ok），但**机制存在**（`card.ts:78-85` 重算 + `service.ts:30` 10s TTL）⇒ **不得断言"永远为 0"** | 诚实标注 |
| 5 | **R5（站台未归一）静态确认存在 10 处**，涉及 `C690/1` vs `C690/3`、`M9/3` vs `M9/4` 等；但本次运行时快照**未触发**（相关线在采样时段已 `excluded`） | 静态核查 |
| 6 | **未达「≥20 组 OD、四类各≥4」**：有效 OD 只有 **6** 个（库里仅 4 个 `places`），transfer 类样本仅 **1** 个。理由是数据物理限制，不是采样方法问题（详见 §4） | 诚实标注 |

---

## 1. 取样条件（可复跑）

| 项 | 值 |
|---|---|
| 版本 | `b72a85c`（= 线上版本，`git rev-parse --short HEAD` 实测） |
| 工作区 | `git status --porcelain \| grep -c "src/"` = **0**（采样时 `src/` 干净，基线有效） |
| 采样时刻 | **澳门时间 2026-11-04（周三）22:39**（DB `now() AT TIME ZONE 'Asia/Macau'` 实测） |
| 时段性质 | 巴士营运时段内（多数线运营至 01:15）⇒ 满足「必须在营运时段采」 |
| `LIMIT` | **6**（与改后目标值同值，避免测成 limit bug） |
| `prefs` | 默认 `balanced`（未传） |
| 采样方式 | 纯 Node（`node --env-file=.env ./node_modules/tsx/dist/cli.mjs .verify/_r0-baseline.ts`），**不需要浏览器** |

### 1.1 复跑命令

```bash
# 前提：HEAD 仍是 b72a85c 且 src/ 无改动（否则基线失效）
git rev-parse --short HEAD          # 期望 b72a85c
git status --porcelain | grep -c "src/"   # 期望 0

# 观测澳门时刻（报告里必须记，因为基线是时点快照、不可事后复现）
node --env-file=.env -e "const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});p.query(\"SELECT to_char(now() AT TIME ZONE 'Asia/Macau','YYYY-MM-DD HH24:MI') t\").then(r=>{console.log(r.rows[0].t);return p.end()})"

# 取样（输出到 .verify/_r0-out.json）
node --env-file=.env ./node_modules/tsx/dist/cli.mjs .verify/_r0-baseline.ts > .verify/_r0-out.json
```

> ⚠️ **基线不可事后复现**：`service.ts:88-91` 明确写「`nowMs` 可注入，但巴士是 DSAT 实时数据、无法伪造」。改后复测必须**也在营运时段**，否则不可比。

---

## 2. 主口径结果（`limit` 同值 6）

| 指标 | 值 |
|---|---|
| 采样点（卡级） | **42** |
| 失败（`route_changed`） | **0** |
| **失败率** | **0.00%** |
| 失败 OD 数 | **0** |
| 失败归因分布 | `M1a（limit 不一致）` = 0 · `M1b（四元组不匹配）` = 0 · `M2（缓存重算漂移）` = 0 |

**按类别**（按**每张卡**判定，互斥；优先级 `overnight > lrt > transfer > direct`）：

| 类别 | 采样点 | 失败 |
|---|---|---|
| direct（单段） | 26 | 0 |
| transfer（换乘，非轻轨） | **1** | 0 |
| lrt（含轻轨段） | 8 | 0 |
| overnight（`nowMs` 注入 01:00） | 7 | 0 |

### 2.1 为什么主口径能是 0（不是运气）

`cardDetail` 内部复用 `recommend()` 与它的 **10s 缓存**（`card.ts:78-85`）。本脚本在 `recommend` 之后**紧密相邻**地调 `cardDetail(limit=6)` ⇒ 命中同一份缓存 ⇒ `rec.cards` 与首屏完全同源 ⇒ `find`（`card.ts:89-92`）必然成功。
**这意味着 0 的前提是「与首屏同源」**，跨缓存窗口后 M2 可能非零。见 §3。

---

## 3. 两条不属于主口径的观测（必须分开记，否则会量错）

### 3.1 真实链路失败：3 / 42 = 7.14%（属 U10，不属 AC-9.15）

用**真实点击链路**（`buildCardHref` 不传 `limit` ⇒ href 内 `limit=5`）调用，得到 **3 次失败**：

| OD | 座区 | 第几张卡 | 路线 | 说明 |
|---|---|---|---|---|
| home→school | B/C | 第 6 张 | 21A | 首屏按 6 张出，href 里写 `limit=5` ⇒ detail 只取 5 张 ⇒ 第 6 张定位不到 |
| home→school | N/O | 第 6 张 | 21A | 同上 |
| home→school | R | 第 6 张 | 21A | 同上 |

**归因**：`M1a-limit-mismatch` —— 这正是 PRD §5.2 记录的 **P0 回归**（`RecommendCard.tsx:158-169` 不传 limit → `card-link.ts:39` 默认 5 → `card.ts:75` 取 5 张）。
**处理**：由 `AC-10.3`（点第 6 张卡必须能进详情）覆盖；**不计入 `AC-9.15` 基线**（否则会把 U10 的 bug 算成收敛的负担）。

> 这条实测也**独立验证了 PRD §5.2 的推断**：出发前我只按代码推断「第 6 张必然失败」，现在有 3 个真实样本作为证据。

### 3.2 M2（缓存过期重算）未观测到，但机制存在

对每组的**首卡与末卡**额外跑 `cardDetail(force=true)`（绕过缓存重算），结果**全部 ok**。

| 项 | 结论 |
|---|---|
| 本次观测 | M2 = 0 |
| 机制是否存在 | **存在**：`cardDetail` 每次调 `recommend`（`card.ts:78-85`），缓存 TTL 10s（`service.ts:30`）；过期后重算排序可能不同 ⇒ 同一四元组落到 limit 之外 |
| 设计上是否已知 | **是**：`error-text.ts:40` 的文案「这条路线现在的班次变了，暂时算不出来」就是为这个场景写的 |
| 因此 | **不得断言「永远为 0」**。正确表述：「本时点观测为 0；M2 类不可排除」 |

---

## 4. 覆盖范围与限制（**未达取样要求，必须如实标注**）

### 4.1 有效 OD 只有 6 个（要求 ≥20）

| 项 | 实测 |
|---|---|
| `places` 表条数 | **4**（`home` / `school` / `hengqin` / `gate`） |
| 理论有向 OD 上限 | 4 × 3 = **12** |
| active plans 覆盖的有向 OD | **6**：`home→school`、`school→home`、`home→gate`、`gate→home`、`home→hengqin`、`hengqin→home` |
| 含 zone / 时段变体的取样组 | **12** |
| 卡级采样点 | **42** |

**结论**：**达不到「≥20 组 OD」**。这是**数据物理限制**（库里只有 4 个地点、14 个 active plans），不是采样方法问题。
要满足 20 组 OD，必须先往 `places` + `commute_plans` 增数据 —— 属**写库操作**，超出本次只读范围，需另行授权。

### 4.2 transfer 类只有 1 个样本（要求 ≥4）

| 项 | 实测 |
|---|---|
| 真正的巴士换乘方案 | **仅 `home→hengqin` #17**（`bus → transfer → bus`） |
| 该组在 22:39 的结果 | 2 张卡：`26`（换乘，归 transfer）+ `LRT-石排湾线`（归 lrt） |
| ⇒ transfer 采样点 | **1** |

**结论**：transfer 类**统计上无意义**（n=1）。原因同上：换乘方案本身只有 1 个，且 22:39 时段部分线已收班。

### 4.3 overnight 类说明

`nowMs` 注入澳门 2026-11-04 01:00（`Date.parse("2026-11-03T17:00:00Z")`），此时 25 末段（`20:00–01:15`）与 N3（`00:00–06:00`）仍在运营。
⚠️ **缓存 key 不含 `nowMs`**（`service.ts:112`：`from|to|zone|limit|prefs`）⇒ 每组注入前必须 `clearRecommendCache()`，否则会拿到上一次真实时刻的结果。脚本已处理（`_r0-baseline.ts` 内 `if (c.nowMs) clearRecommendCache()`）。
卡片数偏少属预期（巴士实时不可伪造，`service.ts:88-91`）。

### 4.4 R5 在运行时未触发（但静态确认存在）

| 项 | 结果 |
|---|---|
| 运行时检测（同 `route` + 同 `mainCodeOf(board)` 出多张卡） | **0 处** |
| 原因 | 采样时段 22:39，涉及 R5 的线（`51B`、`25AX` 等）已 `excluded`（探针实测 `excluded= 50,26A,N3,51B,25AX`）⇒ 实例没进结果 |
| 静态核查（复刻 `boardsOf`/`alightsOf` 三源合并 + `new Set` 字符串全等去重） | **10 处命中** |

**R5 静态命中明细（全部）**：

| plan | seq | 线路 | 字段 | 主码 | 同主码的不同写法 |
|---|---|---|---|---|---|
| 4 | 2 | `51A` | board | `C690` | `C690/1`、`C690/3` |
| 4 | 2 | `51B` | board | `C690` | `C690/2`、`C690/3` |
| 4 | 2 | `25AX` | board | `C690` | `C690/2`、`C690/3` |
| 28 | 2 | `51B` | board | `C690` | `C690/2`、`C690/3` |
| 28 | 2 | `25AX` | board | `C690` | `C690/2`、`C690/3` |
| 28 | 2 | `25AX` | alight | `M9` | `M9/3`、`M9/4` |
| 33 | 3 | `25AX` | board | `M9` | `M9/3`、`M9/4` |
| 33 | 3 | `25AX` | alight | `C690` | `C690/2`、`C690/3` |
| 33 | 3 | `51B` | alight | `C690` | `C690/2`、`C690/3` |
| 33 | 3 | `59` | board | `M9` | `M9/2`、`M9/4` |

**根因（代码位置）**：`enumerate.ts:202`（`boardsOf` 返回）与 `:215`（`alightsOf` 返回）用的是 `[...new Set(out.filter(Boolean))]` —— **字符串全等去重**，未做 `mainCodeOf` 归一 ⇒ `C690/1` 与 `C690/3` 都保留 ⇒ 各生成一条 seed。

---

## 5. 判据形态结论（本项目要的那句判定）

> **基线 = 0 ⇒ `AC-9.15` 应写成「收敛后必须为 0」。**

依据四条：

1. **主口径实测 0/42**，失败 OD 数 0 ⇒ 按"形态由实测决定"的原则，落在「必须为 0」这一支。
2. **为什么不写「≤ 基线率 + 不新增种类」**：基线率为 0 时，"≤0%" 与 "必须为 0" 在数学上等价，但**表述上不等价**——「≤ 基线率」会被后来人读成"允许极小概率失败"，从而给回归开口子。基线为 0 时必须用**绝对表述**。
3. **但必须带两个限定条件**（否则断言不可执行）：
   - **限定 A：同源前提** —— 复测必须与首屏在**同一缓存窗口（10s）内**调用 `cardDetail`，否则测的是 M2 而非收敛影响；
   - **限定 B：时点条件** —— 复测必须在**巴士营运时段**采（基线是 22:39 快照，不可事后复现）。
4. **M2 类不可排除** ⇒ 若复测出现失败且 `force` 也失败、非 force 成功，应归为 M2，**单独计数**，不得直接判 `AC-9.15` 失败；反之若**非 force 就失败**，即判失败。

### 5.1 建议落进 Spec 的可执行表述

```
AC-9.15（P0）
Given  同一批 OD 样本（≥ 本基线 12 组 / 42 采样点）、巴士营运时段、limit 同值 6
When   对每张卡用 buildCardHref 生成的真实 href 参数调 cardDetail（不清缓存，与首屏同源）
Then   route_changed 次数 = 0（绝对表述，不是"≤基线率"）
       且失败 OD 集合 ⊆ 基线失败 OD 集合（基线为空集 ⇒ 必须为空）
例外   force=true 复算失败而首次成功者，归 M2 单独计数，不计入本断言
```

---

## 6. 对架构师两项提议的产品侧回应

### 6.1 R5（站台归一去重）—— 确认是真缺陷，产品侧表现与验收项已补

**产品侧表现（用户会看到什么）**：同一条线在**同一个站群的不同站台**各出一张卡。例如 `51A` 在 `C690/1` 与 `C690/3` 各一张 ⇒ 用户会问「同一趟车为什么有两条？我该去哪个站台等？」。这是**比"多一张卡"更糟**的困惑：它让人怀疑数据准确性。

**与 R2 的关系（关键判断）**：我在 PRD §4.5 给 R2 的判定键是 `(mainCodeOf(board), route, fromSlug, toSlug)` —— **已用 `mainCodeOf` 而非字符串**。⇒ **R2 落地会自动覆盖 R5 的 board 情形**（`C690/1` 与 `C690/3` 主码相同、线路相同 ⇒ 收敛为 1 张）。
但**不能只靠"自动覆盖"**，因为：
- 若实现时 R2 偷懒用字符串比较，R5 就漏了（这是"看起来做了、其实没做"的典型）；
- `alight` 情形（`M9/3` vs `M9/4`）由 R3 覆盖，但 R3 只保证"进备选"，不保证"不重复出卡"。

⇒ **建议新增 AC-9.17（已写入 PRD）**：显式断言 R2 的判定键用 `mainCodeOf`，并以本次 10 处静态命中作为固定回归用例。

**架构师说的"同站最多出 5 张卡"**：本次静态核查未复现出"5 张"这个具体数字（因为要结合该 OD 下实际有几条线可解出逐跳）。我**不对这个数字背书**，只确认「同线同站群多站台各出一张」这个**机制**存在，且有 10 处数据实例。若他要写"5 张"进 Spec，建议补出该 OD 的实测卡片列表。

### 6.2 「收敛按偏好选代表」—— 我确认**不需要**产品侧说明

架构师的方案：`balanced` / `fewer_transfers` 取最快、`less_walk` 取步行最少。

**我确认 team-lead 的判断成立**，理由三条：

1. **偏好切换是用户主动动作，推荐跟着变是符合心智的**。用户点了「少走路」，期望就是"给我走路少的方案"；下车站变了正是这个期望的**兑现**，不是意外。
2. **href 同源自动同步**（架构师已确认）⇒ **不会出现"卡面 T363、详情 T367"这类不一致**。这消除了唯一需要文案解释的风险（即"点进去和看到的不是一回事"）。
3. **不需要额外提示的成本更低**：任何提示（如"下车站已变更"toast）都会让一个**正常行为**看起来像**异常告警**，反而增加困惑。

**但有一条前置要求**（不是文案，是行为）：切偏好时必须**整体替换列表**，不得走 `mergeCardsStable` 的部分合并。依据：`merge-cards.ts:28-34` 已写明「换 OD / 切偏好 / 切轻轨优先 ⇒ **必须整体替换**」，否则旧顺序会覆盖服务端重排 ⇒ **排序永久失效**。这条已在代码里有守卫（`mergedForRef`），我确认它必须被保持。

---

## 7. 未验证 / 不可验证清单

| 项 | 状态 | 怎么补 |
|---|---|---|
| ≥20 组 OD | **未达成（6 组）** | 需往 `places`/`commute_plans` 增数据（写库，需授权） |
| transfer 类 ≥4 样本 | **未达成（1 个）** | 同上；或等换乘方案增加 |
| M2（缓存重算漂移）真实发生率 | **本时段为 0，机制存在** | 需跨缓存窗口（>10s）连续采样，或专门构造班次跳变时段 |
| R5 的运行时卡片列表 | **枚举层已实测（2 张→1 张），运行时未触发** | 在 `51B`/`25AX` 运营时段（白天）重采一次；夜间它们被 excluded |
| 「同站最多 5 张卡」 | **已被本报告推翻（实测 2 张）** | 见 §8 |
| 跨午夜类的出卡数 | 偏少属预期 | 巴士实时不可伪造；如需补，只能用轻轨覆盖 |

---

## 8. 本基线**未**覆盖什么（v1.5 新增，按 team-lead 要求单列）

> 本节的作用是**防止把这份基线当成"全量已验证"**。以下四项都不在本基线覆盖范围内，任何引用本基线的结论都不得外推到它们身上。

### 8.1 transfer 类：n=1，**无统计意义**

| 项 | 实情 |
|---|---|
| 采样点 | **1 个**（`home→hengqin` 的 `26` 换乘卡） |
| 为什么这么少 | `active plans` 里**真正的巴士换乘方案只有 1 个**（`home→hengqin` #17：`bus → transfer → bus`）；22:39 时段部分线收班后只剩 1 张换乘卡 |
| 因此**不能**说什么 | ❌「换乘方案的 `route_changed` 基线为 0」 ❌「换乘类收敛无风险」 |
| 因此**可以**说什么 | ✅「在本时点的 1 个换乘样本上观测到 0 次失败」（仅此而已） |
| 补的前提 | 往 `places`/`commute_plans` **增数据**（写库，需另行授权）。**不得**因 n=1 就把 transfer 类从验收里删除 |

### 8.2 OD 仅 6 组（要求 ≥20）

| 项 | 实情 |
|---|---|
| 有效有向 OD | **6**：`home→school`、`school→home`、`home→gate`、`gate→home`、`home→hengqin`、`hengqin→home` |
| 物理上限 | `places` 表仅 **4** 条 ⇒ 最多 12 个有向 OD；14 个 `active plans` 只覆盖 6 个 |
| 含变体 | 12 组（座区 ×3 + 跨午夜 ×2 变体）/ 42 卡级采样点 |
| 因此**可以**说什么 | ✅「基线为 0」这个结论成立——**0 是绝对下界，样本再多也不会更小** |
| 因此**不能**说什么 | ❌「已覆盖全澳网络」 ❌「每类 OD 都验证过」 |
| 补的前提 | 同上（写库授权） |

### 8.3 R5 运行时未触发（因收班）

| 项 | 实情 |
|---|---|
| 涉及的线 | `25AX`（`mon_fri 06:00-09:00 / 16:00-19:00`）、`51B`（`mon_sat …-20:00`） |
| 采样时刻 | 澳门 22:39 / 22:5x ⇒ **均已收班** ⇒ 运行时被判 `excluded` |
| 结果 | 运行时快照**看不到** R5 实例（探针实测 `excluded= 50,26A,N3,51B,25AX`） |
| 已补的替代证据 | **枚举层**实测（`optionsFor` 纯函数、确定性）：`home→gate` 的 `25AX`、`gate→home` 的 `25AX`/`51B` 各 **2 条 seed → 1 条** |
| 因此**不能**说什么 | ❌「运行时卡片数已实测为 2」——枚举层 ≠ 运行时 |
| 补的前提 | **白天**在 `25AX`/`51B` 营运时段重采（对应 PRD AC-9.17b） |

**一条附带发现（推翻了此前的推测）**：R5 的重复**只在 alight 侧会增卡**（因为 `alightsOf` 是全量展开成 seed）；**board 侧零影响**（`enumerate.ts:263` 只取 `boardsOf(...)[0]`，而重复项从不是首项）。
⇒ 架构师推算的「同一物理站最多 5 张卡」**不可复现**；实测为 **2 张**。数字以本节为准。

### 8.4 改了 `limit` 之后的基线会失效

| 项 | 实情 |
|---|---|
| 本基线口径 | `limit` = **6**（与改后目标同值），这条设计是刻意的 |
| 但 | 一旦 `/recommend` 或 `/nav` 的默认张数再变（不是 6），**本基线不能直接复用** |
| 复测要求 | 要么同值 6 重跑，要么重新测一份基线 |
| 相关 | §3.1 已单列「真实链路 limit=5」的 3 次失败，那是 U10 的 bug，**不属本基线** |

---

## 附录 A · 交付物与命令输出

**文件**
- `docs/迭代-导航修复-20261104/route-changed-baseline-20261104.json`（完整逐条数据，含 `r5StaticCheck` / `scopeLimits` / `verdict`）
- 本文件 `route-changed-baseline-20261104.md`
- 取样脚本（临时探针，非交付物）：`.verify/_r0-baseline.ts`、`.verify/_r0-probe.ts`

**关键输出片段**

```
macau= 2026-11-04 22:39   head= b72a85c   limit= 6
distinctOd= 6  home→school / school→home / home→gate / gate→home / home→hengqin / hengqin→home
odCases(含 zone/时段变体)= 12   totalSamples= 42
主口径 limit=6 : hits= 0    rate= 0        hitOd= 0
真实链路 limit=5: hits= 3    rate= 0.0714   realHitOd= ["home→school|B/C","home→school|N/O","home→school|R"]
byCategory= {"direct":{"samples":26,"hits":0,"hitsReal":3},"transfer":{"samples":1,"hits":0,"hitsReal":0},
             "lrt":{"samples":8,"hits":0,"hitsReal":0},"overnight":{"samples":7,"hits":0,"hitsReal":0}}
byFailKind(主)= {"M1a":0,"M1b":0,"M2":0}    byRealFailKind= {"M1a":0,"M1b":0,"M2":3}
r5StaticCheck.hits= 10
```

**探针首轮输出（证明 href 内 limit=5 与 R5 站台差异同时存在）**

```
cards= 6 candidates= 11 excluded= 50,26A,N3,51B,25AX
  plan=1 route=25  board=C653   alight=T363/2 totalMin=25.3
  plan=9 route=LRT-石排湾线 board=LRT-SPW alight=LRT-UH totalMin=24.4
  plan=4 route=51  board=C690/3 alight=T429   totalMin=31.0
  plan=4 route=51A board=C690/1 alight=T374   totalMin=35.4
  plan=1 route=26  board=C653   alight=T374   totalMin=44.2
  plan=1 route=21A board=C653   alight=T363/1 totalMin=49.6
href= /card?from=home&to=school&plan=1&route=25&board=C653&alight=T363%2F2&zone=N%2FO&rank=1&limit=5
                                                    ↑ limit=5（首屏是 6）—— M1a 的证据
detail ok= true strips=1 reports=6
```

**R5 静态核查输出片段**

```
=== R5 命中（合并后同主码多写法）: 10 ===
 plan4  seq2 route=51A  board  main=C690 forms=["C690/1","C690/3"]
 plan4  seq2 route=51B  board  main=C690 forms=["C690/2","C690/3"]
 plan28 seq2 route=25AX alight main=M9   forms=["M9/3","M9/4"]
 plan33 seq3 route=59   board  main=M9   forms=["M9/2","M9/4"]
 ...
```

## 附录 B · 代码依据

| 事实 | 位置 |
|---|---|
| `route_changed` 唯一产生点 | `src/lib/recommend/card.ts:93`（`find` 返回 undefined） |
| 四元组命中判据 | `card.ts:89-92` |
| 详情页内部重算 | `card.ts:78-85`（复用 `recommend` + 10s 缓存） |
| 默认 limit = 5 | `card.ts:75`、`card-link.ts:39`、`:65` |
| 点击不传 limit | `src/components/RecommendCard.tsx:158-169` |
| 缓存 TTL / key 不含 nowMs | `src/lib/recommend/service.ts:30`、`:112` |
| `nowMs` 可注入但巴士不可伪造 | `service.ts:88-91` |
| `route_changed` 文案（设计上已知失败路径） | `src/lib/ui/error-text.ts:40` |
| **R5 根因**：字符串全等去重 | `src/lib/recommend/enumerate.ts:202`、`:215` |
| 切偏好必须整体替换 | `src/components/nav/merge-cards.ts:28-34` |
| `mainCodeOf` | `src/lib/recommend/segment-lookup.ts`（`enumerate.ts:18` 导入） |

## 附录 C · 长期断言脚本（v1.5 新增）

**脚本**：`scripts/test-card-limit-consistency.ts`（已进 `scripts/`，随仓库演进；`.verify/` 下的临时探针仅作本轮一次性证据）

### 建议加入 `package.json`（**由 team-lead 统一收口，我未修改 `package.json`**）

在 `"scripts"` 内加入一行（放在既有 `test:*` 群组附近即可）：

```json
"check:card-limit": "tsx scripts/test-card-limit-consistency.ts"
```

调用方式：

```bash
npm run check:card-limit                 # 默认口径（优先读 RECOMMEND_LIMIT_DEFAULT，缺失则兜底 6）
PAGE_LIMIT=5 npm run check:card-limit    # 指定口径（用于证明断言本身没坏）
```

⚠️ 该脚本需要 `DATABASE_URL`（走 `--env-file` 或 CI 环境变量），且**结论与时点相关**（巴士实时不可伪造）⇒ CI 里跑建议固定在营运时段，或只作为发布前手动门禁。

### 双向验证输出（判据有效性证据）

**A. 默认口径（`PAGE_LIMIT`=6，来自 `RECOMMEND_LIMIT_DEFAULT`）⇒ 应当红**

```
────────────────────────────────────────────────────────────────────────
卡片 limit 同源一致性断言（scripts/test-card-limit-consistency.ts）
PAGE_LIMIT = 6（来源：RECOMMEND_LIMIT_DEFAULT）
HEAD       = b72a85c
────────────────────────────────────────────────────────────────────────
样本：12 组 · 38 张卡
失败：38（A1 38 · A2 0）
   [A1-href-limit] home→school zone=B/C rank=1/5 route=25 C653>T363/2
       页面 limit=6 但 href limit=5 ⇒ 该卡在详情页必然找不回（第 1 张）
   ...
FAIL —— 「首屏出几张卡」与「href 按几张回查」不一致（或卡点不开）。
修复方向：两处共用单一常量 `RECOMMEND_LIMIT_DEFAULT`，且点击时把当前 limit 透传给 buildCardHref。
```

**B. `PAGE_LIMIT=5` ⇒ 应当绿（证明不是假红）**

```
PAGE_LIMIT = 5（来源：env PAGE_LIMIT）
样本：12 组 · 38 张卡
失败：0（A1 0 · A2 0）
PASS —— 首屏卡数与 href limit 同源，且每张卡都能回查。
```

### 关键观察：**常量已建，调用点一个都没接**

| 检查 | 结果 |
|---|---|
| `src/lib/recommend/limits.ts` | **已存在**，含 `RECOMMEND_LIMIT_DEFAULT = 6`、`NAV_LIMIT_DEFAULT = 6`、`ALT_BUSES_MAX = 3` |
| `grep -rn RECOMMEND_LIMIT_DEFAULT src/` | **只命中定义本身 1 处** ⇒ **9 处调用点尚未接入** |
| 后果 | 页面口径已按 6 算、href 仍写 5 ⇒ **A1 全量红**（38/38） |

⇒ 若把"常量建好"误判为"改完"，这条会持续红。这也是 A1 存在的意义：它抓的正是**"建了常量但没接"**这个半成品状态。

### A2 为何当前是 0 失败（不代表没问题，是**潜伏**）

本次采样时 `home→school` 只有 **5** 张卡（较 22:39 时点的 6 张少 1 张，因时段推进有线路收班）⇒ `href limit=5` 恰好覆盖全部 5 张 ⇒ A2 全过。
**但 A1 已判定"两处口径不同源"**：一旦某 OD 真出满 6 张（如 22:39 时点），A2 立即复现失败——这正是 §3.1 记录的 3 个真实样本（`home→school` B/C、N/O、R 的第 6 张卡 `21A`）。
⇒ **A2 是条件性触发，A1 是必然触发**。两条都要留。

### 三态证据（完整判据有效性链，v1.5 补记）

三次运行的代码状态**不同**，因此结论不同——这恰好证明断言的判定力：

| # | 时刻（澳门） | 代码状态 | `PAGE_LIMIT` | 结果 | 说明 |
|---|---|---|---|---|---|
| **A** | ~22:44 | `limits.ts` 已建常量，但 **`grep RECOMMEND_LIMIT_DEFAULT src/` 只命中定义本身 1 处**（9 处调用点未接） | 6（读常量） | **FAIL · A1 38/38 · exit 1** | 页面口径按 6、href 仍写 5 ⇒ 全量不同源 |
| **B** | ~22:46 | 同上 | 5（env 覆盖） | **PASS · 0/38 · exit 0** | 两处都是 5 ⇒ 绿。**证明 A 的红不是脚本写坏** |
| **C** | **22:48:39** | 实现方已接入调用点（`page.tsx:56`、`api/recommend/route.ts:48`、`RecommendCard.tsx:91` 默认参数等） | 6（读常量） | **PASS · 0/42 · exit 0** | 同源已建立，且每张卡都能回查 |

**这张表的用法**：A 与 B 说明**判据有区分力**（同代码、只改口径，红绿互换）；C 说明**修复确实生效**（不是靠改测试绕过）。

⚠️ **C 的口径声明**：C 跑的是**工作区当前代码**（含队友未提交改动），不代表示已发布状态；且 A/C 两次的卡片总数不同（38 vs 42）是**时段推进**造成的（巴士实时数据随时段变化），不是修复导致的。
