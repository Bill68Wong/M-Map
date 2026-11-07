/**
 * 船班次 HTML → 待入库行（src/lib/cross-border/ferry/parse.ts · 纯函数）
 *
 * ── 上游结构（2026-11-06 实测原样，别凭印象改）───────────────────────────
 *   <table class='item_table table-striped'>
 *   <tr><th>航班</th><th>目的港</th><th>狀態</th><th>閘口</th><th>船名(船種)</th><th>船務公司</th></tr>
 *   <tr>
 *   <td>18:00</td>
 *   <td>香港</td>
 *   <td  style='color:green;' >18:03 啟航</td>
 *   <td>6</td>
 *   <td>宇航 2007<br>豪華雙體船</td>
 *   <td>噴射飛航<br><img width=70 src='images/feh80.jpg'></td>
 *   </tr>
 *   …
 *   </table>
 *   到港页只有 **5 列**（`航班·啟航港·狀態·船名(船種)·船務公司`，**无闸口**）。
 *
 * ── ★ 一个实测发现：页面**跨午夜**，且用"时刻回退"表达"换日"─────────────
 *   23:51 采集到的真实序列是：`17:00 … 23:00`（今日已啟航）→ `07:30 08:30 09:00 待航`。
 *   23 点不可能还有"07:30 待航"的今日班次 ⇒ 那 3 行是**次日**的早班。
 *   契约 §1.4 原本把"跨午夜"标为**未验证**；本文件按实测证据实现：
 *   逐行比较时刻的当日分钟数，**出现回退即判定换日**（该行及其后所有行 `sail_date + 1`）。
 *   ⚠️ 这条规则依赖"上游按时间顺序输出"，而**不是**按日期分块 —— 该前提已由实测快照支撑，
 *      但若上游将来改成"两天混排乱序"，这条规则会失效。
 *      兜底手段：`warnOnSuspiciousDates()` 会对"时刻已过 > 2 小时且状态仍非终态"的行
 *      打 warn（真正晚点的班次会误报，故只记日志、不改数据）。
 *
 * ── 合规：文本**只 trim，不改任何字符** ──────────────────────────────────
 *   海事局条款「均不可以修改任何內容」「必須確保所複製的內容準確」。
 *   ⇒ `status_raw` / `vessel_raw` / `vessel_type_raw` / `place_raw` / `operator_raw`
 *     全部原样落库。本文件里**唯一**允许的文本加工是：
 *       ① 去 HTML 标签（`<br>` / `<img>` 是页面排版，不是内容）；
 *       ② 每个文本片段两侧 `trim()`（判空用，条款允许的边界内）；
 *       ③ `&amp;` 等 HTML 实体的**还原**（还原才是"准确"，不还原等于把显示层的转义写进库）；
 *       ④ 破损标记兜底（CodeQL #7/#8，2026-11-07 裁定）：未闭合注释/脚本按浏览器容错
 *          吃到串尾；产物中残留的裸 `<` 一律清除 —— 正常页面无此字符，字符级等值断言不受影响。
 *   ⚠️ `scripts/test-xborder-compliance.ts` 用固定样例做**字符级等值**断言。
 *
 * ── 失败即抛（绝不返回"空数组"冒充"今天没船"）──────────────────────────
 *   以下情形一律抛错（契约 §2.5 第 1 条：静默返回空数组会与"台风停航"混淆）：
 *   找不到表格 / 表头文字对不上 / 数据行列数不等于表头列数 / 航班列不是 `HH:MM` /
 *   目的港或公司为空。**唯一**允许返回空数组的情形是：表头校验通过、但没有任何数据行
 *   —— 那是"当日确实一班都没有"（未排班 / 停航），语义真实且要靠 `emptyReason` 表达。
 */
import { hhMmToMinutes, addDays, macauDate } from "../time";
import { classify, warnOnStatusDrift } from "../status";
import type { PierCode, SailingUpsertRow, XbDir } from "../types";

const TABLE_RE = /<table[^>]*class=['"]item_table[^'"]*['"][^>]*>([\s\S]*?)<\/table>/i;
const ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const TD_RE = /<td[^>]*>([\s\S]*?)<\/td>/gi;
const TH_RE = /<th[^>]*>([\s\S]*?)<\/th>/gi;
/**
 * 危险块整删（CodeQL #7/#8 的共用净化入口，**两处必须同一份手法**）：
 *   ① `<script>` / `<style>` 整块删除 —— 成对 + **未闭合兜底**（吃到串尾）；
 *   ② HTML 注释删除 —— 成对 + **未闭合兜底**。
 * 根因：旧实现是「多步逐步 replace」且注释只删成对，CodeQL 判
 * `Incomplete multi-character sanitization`（残留 `<script` / 未闭合 `<!--`）。
 * 未闭合兜底的语义 = 浏览器对损坏标记的容错（注释/脚本吃到串尾）：
 * 结构性内容被吃掉时由调用方的结构校验（表头/列数）抛错，**绝不静默出数据**。
 * ASP.NET 页面常有被注释掉的表格/季节模块残留，若不剥离，`TABLE_RE` 可能匹配到
 * 注释里的一份"模板表格"（静默错数据，比抛错糟得多）—— 成对注释删除同时治它。
 */
function dropDangerousBlocks(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*$/i, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!--[\s\S]*$/g, "");
}

/** 表头（等于列定义；对不上就是页面改版，必须炸） */
const HEADERS: Record<XbDir, readonly string[]> = {
  dep: ["航班", "目的港", "狀態", "閘口", "船名(船種)", "船務公司"],
  arr: ["航班", "啟航港", "狀態", "船名(船種)", "船務公司"],
};

/**
 * 失败即抛。必须是 `function` 声明：TS 的 never-返回控制流收窄只认函数声明
 * （`const fail = (m): never => {}` 不会被收窄，`if (!x) fail()` 之后 x 仍是可选值）。
 */
function fail(msg: string): never {
  throw new Error(`[xborder] ferry parse: ${msg}`);
}

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/**
 * 单元格 → 文本行数组（去标签、还原实体、逐行 trim、丢空行）。
 *
 * `船名(船種)` 与 `船務公司` 都是"同格不同行"（`名字<br>类型/logo`），
 * 故统一折成行数组，由调用方按位置取。
 */
function cellLines(html: string): string[] {
  const noTags = dropDangerousBlocks(html)
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z]+;|&#39;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    // 终点兜底（CodeQL 认可的口径）：产物**零 `<` 残留**。实体还原可能产生 `<`
    // （`&lt;` / `&#60;`），按负责人 2026-11-07 裁定清除 —— 船名/状态是纯文本展示
    // 字段，不依赖 `<` 语义；正常页面不含此字符，字符级等值断言不受影响。
    .replace(/</g, "");
  return noTags
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * 解析整页。
 *
 * @param html        上游页面 HTML
 * @param pier        码头码（PE/TP/PI）—— 由请求参数决定，**不从页面文字反推**
 * @param direction   `dep`(离港) / `arr`(到港)
 * @param collectedAt 采集时刻（决定 `sail_date` 基准日）
 */
export function parseFerrySailings(
  html: string,
  pier: PierCode,
  direction: XbDir,
  collectedAt: Date = new Date(),
): SailingUpsertRow[] {
  const table = TABLE_RE.exec(dropDangerousBlocks(html));
  if (!table) fail("找不到 class='item_table' 的表格（页面改版或拿到错误页）");
  const body = table[1];
  const rows = [...body.matchAll(ROW_RE)];
  if (rows.length === 0) fail("表格里没有任何 <tr>（连表头都没有）");

  // ── 表头校验：列名不一致 ⇒ 页面改版，立刻炸（比"解析出 0 行"有用一万倍）──
  const headerCells = [...rows[0][1].matchAll(TH_RE)].map((m) => cellLines(m[1]).join(" "));
  const expect = HEADERS[direction];
  const headerOk =
    headerCells.length === expect.length && headerCells.every((h, i) => h === expect[i]);
  if (!headerOk)
    fail(
      `表头与预期不符：实际 ${JSON.stringify(headerCells)} / 预期 ${JSON.stringify(expect)}` +
        `（pier=${pier} dir=${direction}）`,
    );

  const baseDate = macauDate(collectedAt);
  const out: SailingUpsertRow[] = [];
  /** 跨午夜偏移：出现时刻回退 ⇒ +1 天（见文件头「实测发现」） */
  let dayOffset = 0;
  let prevMinutes = -1;
  let wrapped = false;

  for (const [, inner] of rows.slice(1)) {
    const cells = [...inner.matchAll(TD_RE)].map((m) => cellLines(m[1]));
    if (cells.length !== expect.length)
      fail(
        `数据行列数 ${cells.length} ≠ 表头列数 ${expect.length}：` +
          JSON.stringify(cells.map((c) => c.join("/"))),
      );

    const hhmm = cells[0].join("");
    const minutes = hhMmToMinutes(hhmm);
    if (minutes === null) fail(`航班列不是 HH:MM：${JSON.stringify(cells[0])}`);

    // 时刻回退 ⇒ 换日（同分钟重复是合法的，用严格小于判定）
    if (prevMinutes >= 0 && minutes < prevMinutes) {
      dayOffset += 1;
      wrapped = true;
    }
    prevMinutes = minutes;

    const sailDate = addDays(baseDate, dayOffset);
    if (!sailDate) fail(`sail_date 计算失败：base=${baseDate} offset=${dayOffset}`);

    // 列位置：到港页没有「閘口」列，故用方向分支取下标（不硬编码同一个数字）
    const isDep = direction === "dep";
    const placeRaw = cells[1].join(" ");
    const statusRaw = cells[2].join("\n"); // 状态列实测无换行；join 只为兜底
    const gateRaw = isDep ? cells[3].join(" ") || null : null;
    const vesselCell = cells[isDep ? 4 : 3];
    const operatorRaw = cells[isDep ? 5 : 4].join(" ");

    const verdict = classify("ferry", direction, statusRaw);
    if (!placeRaw) fail(`目的港/啟航港为空：${JSON.stringify(cells)}`);
    if (!operatorRaw) fail(`船務公司为空：${JSON.stringify(cells)}`);

    out.push({
      sailDate,
      direction,
      pier,
      operatorRaw,
      placeRaw,
      schedTime: hhmm,
      vesselRaw: vesselCell[0] ?? null,
      vesselTypeRaw: vesselCell[1] ?? null,
      gateRaw,
      statusRaw,
      statusKind: verdict.kind as SailingUpsertRow["statusKind"],
      isTerminal: verdict.terminal,
    });
  }

  if (wrapped)
    console.warn(
      `[xborder] ferry ${pier}/${direction}: 检测到跨午夜（部分行 sail_date=${addDays(baseDate, 1)}）`,
    );
  if (out.length === 0)
    console.warn(`[xborder] ferry ${pier}/${direction}: 表头正常但 0 行（未排班/停航？）`);

  warnOnStatusDrift("ferry", direction, out);
  return out;
}
