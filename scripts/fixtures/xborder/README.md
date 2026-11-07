# xborder fixtures · 来源与性质（**读这张表再改断言**）

这些文件的作用是让「解析器 / 终态判定 / 合规字符级等值」三类断言**不联网也能跑**，
从而进 `npm run verify`。它们的**真实性等级不同**，不要混为一谈：

| 文件 | 真实性 | 说明 |
|---|---|---|
| `ferry-dep-PE.html` | **真实快照（逐字节）** | 2026-11-06 23:51（澳门时间）抓 `departure.aspx?local=PE&port=ALL`（HTTP 200 / 整页 180483 字节）的 `item_table` 区块原文。**10 条数据行**：首行 `17:00`，末尾 3 条为次日早班「待航」。三个脚本按磁盘实际文件名读取（此前按小写名读只在 Windows 大小写不敏感下成立，已统一）。 |
| `ferry-arr-tp.html` | **真实快照（逐字节）** | 2026-11-06 23:2x 抓 `arrival.aspx?local=TP&port=ALL`（HTTP 200 / 179930 字节）。8 条数据行，**无闸口列**。 |
| `airport-dep.json` | **真实快照（逐字节）** | 2026-11-07 01:17:50 +08:00 抓 `listDepartureFlight/CHINESE`（HTTP 200 / `application/json;charset=UTF-8` / **11362 字节** / sha256 `8d5a3718342aed8d…`），`Buffer` 原样落盘。**65 条**。 |
| `airport-arr.json` | **真实快照（逐字节）** | 同上抓 `listArrivalFlight/CHINESE`（HTTP 200 / **10050 字节** / sha256 `9223d9d08e5a54a9…`）。**66 条**，响应**无 `gate` 字段**。 |
| `airport-dep-coverage.json` / `airport-arr-coverage.json` | **历史重建样本（非原始响应），已不被任何测试读取** | 交换前的按实测状态分布重建件（72 / 73 条）。§2.10.5 覆盖率断言已改为 `test-xborder-status.ts` 的内联 `KNOWN_STATUSES` 样本表、与 fixture 解耦。保留仅为 `\u0000` 证据可复现（`airport-dep-coverage.json:494`），待确认后删除。 |

## 覆盖率断言为什么不数 fixture

2026-11-07 01:17 的真实响应状态分布实测为：

```
dep 65 条：{"0":63, "已取消":2}   → parse 后 statusKind {"unknown":63,"cancelled":2}
arr 66 条：{"0":64, "航班取消":2} → parse 后 statusKind {"unknown":64,"cancelled":2}
```

凌晨航班尚未激活，上游几乎只给字面量 `0`。旧写法靠「数 fixture 里各 `status_kind` 的行数」
（72/73 条、unknown 精确 0/6）来守白名单 —— 换成这份快照后，8 种已知状态文本几乎都不出现，
**白名单即使被删光也能全绿**。这不是断言太严，是断言挂错了载体。

⇒ 裁决：**覆盖率断言与 fixture 解耦**。`test-xborder-status.ts` 内联 `KNOWN_STATUSES`
（15 条实测状态文本 × 独立硬编码的期望 `kind` / `terminal`），逐条直接断言 `classify()` 输出；
期望值刻意不从 `status.ts#TABLES` 自动导出（那会变成「拿实现测实现」，断言永远绿）。
漏哪条红哪条，且完全不受上游某时刻数据形态影响。⇒ **fixture 从此可以自由换**。

`test-xborder-parse.ts` 只读 `airport-{dep,arr}.json` 验结构（DD-MM 日期/时刻、`gate=0` 归一、
字段映射、原文照录）；`test-xborder-compliance.ts` 只读船 fixture 验字符级等值。

真实快照字段集合（实测，可用来验「上游是否改版」）：

- dep：`time/airline/destination/flightNo/gate/status/date` 各 65 次；`date` 全为 `07-11-2026`；3 条 `gate="0"`，0 条空串。
- arr：`time/airline/origin/flightNo/status/date` 各 66 次（**无 `gate`**）；`date` 全为 `07-11-2026`。

首行真实值（断言以此为准）：

- `airport-dep.json`：`{"time":"07-11 08:00","airline":"NX","destination":"台北","flightNo":"NX632","gate":"10","status":"0","date":"07-11-2026"}` → 解析后 `schedDate=2026-11-07 / schedTime=08:00 / gateRaw="10" / statusRaw="0"`。
- `airport-arr.json`：`{"time":"07-11 10:10","airline":"NX","origin":"台中","flightNo":"NX671","status":"0","date":"07-11-2026"}` → 解析后 `placeRaw="台中" / gateRaw=null / statusRaw="0"`。

⚠️ 跨午夜容差：`test-xborder-*.ts` 的 `AT` 固定为 `2026-11-06T23:20:00+08:00`（船件的采集时段）。
机场件是次日 01:17，`parseUpstreamDate` 的 ±1 天容差正好覆盖这一真实场景；
**不要**为了机场件单独改 `AT`，否则船件的「当日 / 次日」换日断言会整体位移一天。

⚠️ 采集凭证：`.env` **已配置** `AACM_APPCODE`（`.gitignore:71` 命中，不入库）。
上述两次 GET 用 `Authorization: APPCODE <值>` 完成，凭据不写死、不打印、不入 fixture。

⚠️ 上游瞬时脏字节：2026-11-07 01:08 的首轮采集里，`listArrivalFlight` 响应曾含 `\u0000`，
Postgres 以 `invalid byte sequence for encoding "UTF8": 0x00` 拒绝该批 INSERT ⇒ 该轮 `dir=arr` 返回 503。
01:10 与 01:17 的捕获实测 `NUL 字节 = 0`。同类脏字节以 **6 字符 JSON 转义序列**形式见于
`airport-dep-coverage.json:494`（`JSON.parse` 后 row#55 的 status 含 1 个 U+0000）；
文件原始字节里 NUL 计数为 0。属上游瞬时数据，不是我方生成。

## 真实快照里的一个额外发现（已成实现依据）

`ferry-dep-PE.html` 在 **23 点档**同时含有 `17:00–23:00`（已啟航）与 `07:30 / 08:30 / 09:00`（待航）。
23 点不可能还有「07:30 待航」的当日班次 ⇒ 后者是**次日**早班，页面用「时刻回退」表达换日。
`src/lib/cross-border/ferry/parse.ts` 的换日规则即由这份证据支撑（契约 §1.4 原把跨午夜标为「未验证」）。
换日之前的当日行现在是 **7 条**（不是旧快照的 6 条）。
