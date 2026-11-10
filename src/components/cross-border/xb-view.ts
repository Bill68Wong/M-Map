/**
 * 跨境交通 · 视图派生（src/components/cross-border/xb-view.ts，2026-11-07）
 *
 * ── 为什么派生逻辑单独成文件、且全是纯函数 ────────────────────────────
 *   这一批最容易出错、又最不容易被发现的三件事全在这里：
 *     ① **时刻**：`serverNow` 是 ISO（带 `+08:00`），`schedTime` 是裸 `HH:MM`。
 *        混用浏览器时区 ⇒ 午夜前后差 1 小时、跨日判断错。**一律走澳门固定 +8**；
 *     ② **终态/置灰**：只许用服务端算好的 `isTerminal`。`statusKind === "departed"`
 *        在离澳是终态、在抵澳是"在途马上到"（架构师 §2.10）—— 拿它推终态会把整块
 *        抵澳板灰掉，而"抵澳板空着"看起来完全正常，没人会报 bug；
 *     ③ **空态文案**：三值 `emptyReason` 各是一句话，靠 `items.length === 0` 猜必然错。
 *   纯函数 ⇒ 断言脚本（`scripts/check-xborder-ui.tsx`）能直接喂数据跑，不需要浏览器。
 *
 * ── 时间口径：**一律澳门 +8**，不看浏览器时区 ──────────────────────────
 *   `serverNow` 形如 `2026-11-07T09:56:00+08:00`。取"墙上的钟"要的是澳门本地时刻，
 *   而 `new Date(iso).getHours()` 给的是**设备时区**的小时 ⇒ 出差/改时区就错。
 *   故统一：`Date.parse` → `+8h` → 用 `getUTC*` 读 ⇒ 与设备时区无关。
 */

import type {
  AirportStatusKind,
  FerryStatusKind,
  PierCode,
  XbAfter,
  XbDir,
  XbEmptyReason,
} from "@/lib/cross-border/types";

/* ══════════════════════════════════════════════════════════════════════
 * 时间
 * ══════════════════════════════════════════════════════════════════════ */

const MACAU_OFFSET_MS = 8 * 3_600_000;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** ISO → 澳门本地 `{ ymd, hm, minutes }`；不可解析则返回 null（调用方决定降级文案） */
export function macauParts(iso: string | null | undefined): {
  ymd: string;
  hm: string;
  minutes: number;
} | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + MACAU_OFFSET_MS);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return {
    ymd: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    hm: `${pad2(h)}:${pad2(m)}`,
    minutes: h * 60 + m,
  };
}

/** `HH:MM` → 当日分钟数；格式不符返回 null（**不猜、不补零修复**） */
export function hmToMinutes(hm: string | null | undefined): number | null {
  if (!hm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * 表里显示的「计划时刻」。
 *
 * · 本日 ⇒ 只显示 `HH:MM`（日期对"今日"无信息量，还白吃 44px 列宽）；
 * · 跨日 ⇒ 拼 `MM-DD HH:MM`（住不上"今日"时，藏日期才是错的）。
 * @param today 澳门本地 `YYYY-MM-DD`（来自 `serverNow`，**不是** `new Date()`）
 */
export function displaySched(schedDate: string, schedTime: string, today: string | null): string {
  if (!today || schedDate === today) return schedTime;
  return `${schedDate.slice(5)} ${schedTime}`;
}

/* ══════════════════════════════════════════════════════════════════════
 * 状态 → 颜色（**永不**改文本）
 * ══════════════════════════════════════════════════════════════════════ */

type AnyStatusKind = AirportStatusKind | FerryStatusKind;

/**
 * 状态单元格的 class。
 *
 * ── 颜色表（设计稿 v1.1 §04 权威映射，逐行实现，别凭直觉改）──────────────
 *   离澳 `已啟航 HH:MM`            departed        terminal  ⇒ `--muted`
 *   离澳 `停止登機`                boarding_closed !terminal ⇒ `--warn`
 *   离澳 `櫃檯 A10-A12 已開放`     checkin_open    !terminal ⇒ `--fg`（不着色）
 *   离澳 `航班延誤至 HH:MM`        delayed         !terminal ⇒ `--warn`
 *   离澳 `航班更改時間 HH:MM`      rescheduled     !terminal ⇒ `--warn` + 虚线（见下）
 *   离澳 `已取消` / 抵澳 `航班取消` cancelled       terminal  ⇒ `--danger`
 *   **抵澳 `已啟航 預計到達 HH:MM` departed        !terminal ⇒ `--fg`（绝不要 muted）**
 *   抵澳 `航班著陸 HH:MM`          landed          terminal  ⇒ `--muted`
 *
 * ── 为什么「置灰」只看 `isTerminal`，不看 `statusKind` ──────────────────
 *   同一个 `departed`：离澳 = 已飞走（该降权）；抵澳 = 已从始发地起飞、**马上落地**
 *   （必须正常显示，全灰掉就等于把抵澳板最关键的 4 行做没）。
 *   而"抵澳板灰成一片"看起来跟"今晚没有航班进港"一模一样 —— 无人会报这个 bug。
 *
 * ── 为什么「取消」不走 `--past` ────────────────────────────────────────
 *   负责人裁决 2：取消**进**最近五班，且状态要能看清。降权是为了"让位"，不是为了"藏起来"。
 *
 * ── `rescheduled` 与 `delayed` 同为 `--warn`，靠**下划虚线**区分 ─────────
 *   两者都是"行程受影响、但不是终态"，配色同档（`--warn`）是设计稿的语义分组；
 *   但文字上必须能分辨 —— 延误是"晚点"，改期是"换了钟点"，后者按原时刻去会误机。
 *   虚线是**非颜色通道**：色觉障碍用户同样能分辨（只靠颜色深浅区分两个橙色不可靠）。
 *   具体样式在 `globals.css#.xb-st--rescheduled`。
 */
export function statusClass(kind: AnyStatusKind | string, isTerminal: boolean): string {
  if (kind === "cancelled") return "xb-st--danger";
  if (kind === "delayed") return "xb-st--warn";
  if (kind === "rescheduled") return "xb-st--warn xb-st--rescheduled";
  /* 停止登機（正在关闸）不是终态，但对赶飞机的人是"最紧急的提示"⇒ 与延误同档 */
  if (kind === "boarding_closed") return "xb-st--warn";
  return isTerminal ? "xb-st--past" : "";
}

/* ══════════════════════════════════════════════════════════════════════
 * 状态文本：绝大多数**原文直出**，两个「需要我方给话术」的形态除外
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 上游字面量 `"0"` ⇒ 显示「待定」。
 *
 * ── 它是什么（2026-11-07 实证，见 `.verify/flight-status-corpus.md`）──────
 *   · 是**上游原始值**，不是空串、不是我方解析产物（原始响应里就是 `"status": "0"`）；
 *   · 语义 = **已计划、尚未进入任何流程**：白天快照 42 行 `"0"` 在 8 小时后
 *     39 行转成 `航班著陸 HH:MM` / `已啟航 HH:MM` / `航班延誤`，余 4 行为 22:00 后晚班；
 *   · 后端自 v4.1 起把它归 `statusKind="pending"`（非终态，行保留）。
 *
 * ── 为什么改掉旧的「—」+「未能识别」脚注 ─────────────────────────────
 *   旧实现把 `"0"` 当"我方认不出"，显示破折号并在表下挂"未能识别，共 N 班"。
 *   两个问题：① 白天离澳/抵澳各 40% 的行都是它 ⇒ 一屏破折号像渲染故障；
 *   ② 归因是错的 —— 我们读懂了它，它是"还没开始"，不是"没读懂"。
 *   ⇒ 换成确定的产品文案「待定」。
 */
const STATUS_PENDING = "0";
const STATUS_PENDING_LABEL = "待定";

/**
 * `航班更改時間 HH:MM` ⇒ 「时刻变更 HH:MM」。
 *
 * ── 为什么这里**要**改写措辞（与"原文直出"的其余状态不同）──────────────
 *   · 项目语种是简体，而上游这句是繁体叙述（`更改時間`），直接原样显示会与全站
 *     文案不一致；负责人 2026-11-08 裁定统一为「时刻变更」。
 *   · 机场侧**无"不得修改"条款**（该条款属海事局，见 `airport/parse.ts:55` 注释
 *     "机场侧无「不得修改」条款"）⇒ 展示层归一不违约。
 *   · `status` 字段在库里与接口里**仍是原文** `航班更改時間 13:10`（`status_raw` 不改）；
 *     本函数只决定屏幕上那 12px 的一格怎么显示。想核对原文随时能查。
 *
 * ── ⚠️ 时刻必须保留 ─────────────────────────────────────────────────
 *   新时刻是用户唯一要的行动信息；只写「时刻变更」四个字等于把信息删掉。
 *   故捕获 `HH:MM` 原样拼回。`航班更改時間`（无时刻）**不匹配**本规则、原文直出，
 *   由后端落 unknown（漂移探针会看见），我们不在前端猜。
 *
 * ⚠️ 与 `status.ts` 的 `^航班更改時間\s+\d{1,2}:\d{2}$` 是**两条独立表达式**：
 *    这边只管"怎么显示"，那边管"归哪一类"。漂移的最坏后果是显示回原文（可读、仍着色），
 *    不会静默出错；`check-xborder-ui.tsx` 有逐字断言钉住本文件的输出。
 */
const RESCHEDULED_RE = /^航班更改時間\s*(\d{1,2}:\d{2})$/;
const RESCHEDULED_LABEL = "时刻变更";

export interface StatusCell {
  /** 屏幕上显示的文本（已知状态一律是 `status_raw` 原文） */
  text: string;
}

/**
 * 状态单元格内容。
 *
 * ── 空值口径：为什么是「状态未识别」而不是「資料未公開」────────────────
 *   「資料未公開」是在说**上游没公开** —— 那是归因，而我们并不知道是不是真没公开
 *   （上游可能返回了空串、返回了我们白名单里没有的词）。
 *   「未識別」只陈述**我方认知边界**，永远不会错。
 *   这条不是措辞洁癖：将来有人排查"为什么某班没状态"，
 *   看到「未識別」会来查我们的白名单；看到「未公開」会去问机场 —— **前者才是正确方向**。
 *   ⚠️ `vessel` 为空仍用「资料未公开」（船名确实是"上游没给"，与本条不同）。
 */
export function statusCell(status: string): StatusCell {
  const raw = status ?? "";
  if (raw.trim() === STATUS_PENDING) return { text: STATUS_PENDING_LABEL };
  const re = RESCHEDULED_RE.exec(raw.trim());
  if (re) return { text: `${RESCHEDULED_LABEL} ${re[1]}` };
  if (!raw.trim()) return { text: "状态未识别" };
  return { text: raw };
}

/* ══════════════════════════════════════════════════════════════════════
 * 表格：平铺行 + 「現在」游标（**无小时分组**，2026-11-07 起）
 * ══════════════════════════════════════════════════════════════════════ */

/** 表格里的一格（渲染时不区分航班/船：两者的列模板由调用方给） */
export interface XbRow {
  id: number;
  schedTime: string;
  schedDate: string;
  isTerminal: boolean;
  statusKind: string;
}

/**
 * 表格节点：只有「数据行」与「現在游标」两种（2026-11-07 取消小时分组后）。
 *
 * ⚠️ 原 `{ kind: "hour"; hour; count }` 成员**已删除**，不要加回来。
 *   它当年只为"按小时切片"存在；分组取消后既无产出方也无消费方。
 *   曾经留着它的唯一理由是 `scripts/check-xborder-ui.tsx` 在 `x.kind === "hour"`
 *   上做类型层比较（删了会 TS2367）——QA 已把该脚本改成 `String(x.kind)`（见其
 *   L127 注释与 L146 `kindsOf`），这道锁已经解开，故连同 `hourLabel()` 一并删净。
 */
export type XbNode<R extends XbRow> =
  | { kind: "row"; row: R }
  | { kind: "now"; minutes: number };

/**
 * 把**已按 `schedTime` 升序**的行编成「行 + 現在游标」的线性序列（**平铺，无分组**）。
 *
 * ── 2026-11-07：取消小时分组（负责人裁定）─────────────────────────────
 *   原实现按 `Math.floor(minutes / 60)` 切「08 時 / 3 班」两种节点；`hourLabel()` /
 *   `closeHour()` / `hour` 节点类型已**一并删除**。现在表格是一条连续的班次列表，
 *   定位只剩两件：**表头吸附**（`.xb-th--sticky`）与**「現在」游标**。
 *   ⚠️ 取消分组**不影响吸附**：小时分组节点当年也不是 `position: sticky`，吸附的祖先
 *      一直是滚动容器 `.xb-sheet__body`（`overflow-y: auto`），与兄弟节点数量无关。
 *
 * ── 为什么游标要插进序列里而不是叠一个绝对定位的横线 ──────────────────
 *   游标要参与文档流：① 它自己占一行高度，滚动时不会盖住行文字；
 *   ② 「打开即定位」只需 `scrollIntoView` 到它；③ 表头吸附与它互不干扰。
 *   绝对定位的横线在 70+ 行的滚动里既会漂又会压字。
 *
 * ── 为什么 now 之后还要继续渲染 ────────────────────────────────────────
 *   「当日所有」= 一条不漏（负责人否决了"只看未出發"筛选）⇒ 游标只是**定位锚**，
 *   不是过滤线。游标之后的行照样渲染。
 *
 * @param items 当日全量（调用方保证按 `schedTime` 升序）
 * @param nowMinutes 澳门本地"现在"的分钟数（`null` ⇒ 不插游标，例如 `serverNow` 不可解析）
 */
export function buildTableNodes<R extends XbRow>(
  items: R[],
  nowMinutes: number | null,
): XbNode<R>[] {
  const out: XbNode<R>[] = [];
  let nowPlaced = false;

  for (const row of items) {
    const min = hmToMinutes(row.schedTime);

    /* 游标：第一条「时刻 >= now」的行**之前**；找不到就落在末尾。
       时刻不可解析的行不参与判定（不猜），与改前一致。 */
    if (!nowPlaced && nowMinutes != null && (min == null ? false : min >= nowMinutes)) {
      out.push({ kind: "now", minutes: nowMinutes });
      nowPlaced = true;
    }
    out.push({ kind: "row", row });
  }

  if (!nowPlaced && nowMinutes != null) out.push({ kind: "now", minutes: nowMinutes });
  return out;
}

/** 当日剩余班数（**非终态**计数；卡片的「今日剩餘 N 班」与游标文案共用） */
export function remainingCount(items: XbRow[]): number {
  return items.reduce((n, r) => (r.isTerminal ? n : n + 1), 0);
}

/** 「下一班」：当日、`schedTime > now` 且非终态的最小一条；没有则 null（**不编文案**） */
export function nextSailing<R extends XbRow>(
  items: R[],
  nowMinutes: number | null,
): R | null {
  if (nowMinutes == null) return null;
  let best: R | null = null;
  let bestMin = Number.POSITIVE_INFINITY;
  for (const r of items) {
    if (r.isTerminal) continue;
    const m = hmToMinutes(r.schedTime);
    if (m == null || m <= nowMinutes) continue;
    if (m < bestMin) {
      bestMin = m;
      best = r;
    }
  }
  return best;
}

/* ══════════════════════════════════════════════════════════════════════
 * 空态文案（三值，各一句话）
 * ══════════════════════════════════════════════════════════════════════ */

export type XbKind = "airport" | "ferry";

/**
 * 三种"空"必须说成三句不同的话 —— 它们对用户的意义完全不同：
 *   `none_remaining_today` 今天还有，但剩下的都走完了（**正常**，深夜常态）
 *   `no_service_today`     今天本来就没有（台风停航 / 未排班）
 *   `not_yet_collected`    **我方**还没采到（用户的手机没问题，是我们的问题）
 * 把三者说成同一个"暂无数据"，等于把"我们没有数据"说成"世界上没有这件事"。
 */
export function emptyCopy(
  reason: XbEmptyReason,
  kind: XbKind,
  dir: XbDir,
): { title: string; body: string } {
  const what = kind === "airport" ? "航班" : "船班";
  /**
   * 2026-11-07（负责人裁定）：三港口与机场**一律**用「离澳 / 抵澳」，方向词不再按
   * 交通方式分叉（改前码头侧走「離港 / 到港」，与机场侧「離澳 / 抵澳」两套并存）。
   * 同日第二道裁决：我们自己写的界面文案**统一简体** ⇒ 这里取值是「离澳 / 抵澳」。
   *
   * ── 同日第三道裁决（**纠正**上面那条备注里的误列，2026-11-07）───────────────
   *   本条注释原先写着"别把 `資料未公開` / `暫時無法更新` 一起改"，把这两个串当成了
   *   上游原文 —— **那是错的，现已推翻**：上游给的是 `null` / 空串，这几字是**我们
   *   自己填进去的兜底文案**（零插值、不含任何上游字面量）。两者已一并改简体：
   *     · `XbTable.tsx#ABSENT`  ⇒「资料未公开」
   *     · `XbBits.tsx#XbStale`  ⇒「暂时无法更新」
   *   判据只有一条：**这个字是我们打出来的，还是接口给的。**
   *   ⚠️ 真正**保持繁体、一个字都不许改**的是"上游字面量直出"那部分 —— 即
   *      `statusCell()` 的 `return { text: raw }`，以及 `place` / `flightNo` /
   *      `vessel` / `operator` 这类原样透传字段。例：`已啟航` / `停止登機` /
   *      `航班著陸` / `航班延誤至 15:10` / `櫃檯 A10-A12 已開放`。
   *      见到这些繁体**不是漏改的残留，是正确状态**，别"为了看起来一致"去转简体。
   * `kind` 仍参与 `what`（航班 / 船班）与下面 `no_service_today` 的 body 分支，**别一起删**。
   */
  const place = dir === "dep" ? "离澳" : "抵澳";

  if (reason === "none_remaining_today") {
    return {
      title: `今日已无${place}${what}`,
      body: "今天班次已全部出发。明日的班次会在采集到之后自动出现。",
    };
  }
  if (reason === "no_service_today") {
    return {
      title: `今日暂无${what}安排`,
      body:
        kind === "airport"
          ? "上游今日没有排班（台风停航或临时调整）。这是上游的状态，不是查询失败。"
          : "上游今日没有排班（恶劣天气停航或临时调整）。这是上游的状态，不是查询失败。",
    };
  }
  return {
    title: "数据获取中",
    body: "我们还没成功取到今天的班次（不是没有班次）。稍后重试即可，也可以下拉刷新。",
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 码头 / 方向 / 查询串
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 三码头的**官方专名**（繁体，与仓库既有口径一致：站点名「氹仔碼頭」即用繁体）。
 * ⚠️ 这是 UI 说明性文字，**不是**数据值 —— 数据值（`place`）必须原文直出，不经过本表。
 */
export const PIER_NAME: Record<PierCode, string> = {
  PI: "內港碼頭",
  PE: "外港碼頭",
  TP: "氹仔碼頭",
};

/**
 * 三码头各自的目的港概览（设计稿 §01 卡片副标题用；**上游没给就不能编**，见 `pierHint` 注释）
 *
 * ⚠️ 语种判据（2026-11-07 负责人口径，与上方 `PIER_NAME` **不同**，别把两者对齐）：
 *    这三个值是**我方硬编码的目的地名**，既非上游返回、也不在 `PIER_NAME`/`AIRPORT_NAME`
 *    那族官方专名里 ⇒ **一律简体**（`珠海湾仔`，不是 `珠海灣仔`）。
 *    判据仍是那一句：**这个字是我们打出来的，还是接口给的。**
 */
export const PIER_ROUTE_HINT: Record<PierCode, string> = {
  PI: "珠海湾仔",
  PE: "香港 / 深圳蛇口",
  TP: "香港 / 深圳蛇口",
};

export const AIRPORT_NAME = "澳門國際機場";

/** 站名（`/cross-border/[station]` 的 `station` 参数 → 中文专名） */
export function stationName(station: string): string | null {
  if (station === "airport") return AIRPORT_NAME;
  const up = station.toUpperCase();
  if (up === "PE" || up === "TP" || up === "PI") return PIER_NAME[up];
  return null;
}

/** 列表接口的 URL（4 个界面共用；`after=now&limit=5` = 需求 5，`after=day` = 需求 6） */
export function listUrl(
  kind: XbKind,
  opts: { dir: XbDir; after: XbAfter; pier?: PierCode | null; limit?: number },
): string {
  const qs = new URLSearchParams();
  if (kind === "ferry") {
    // 船：`pier` 必填（三个码头内容不同，见设计裁决记录 §二）
    qs.set("pier", opts.pier ?? "PI");
  }
  qs.set("dir", opts.dir);
  qs.set("after", opts.after);
  if (opts.limit != null) qs.set("limit", String(opts.limit));
  return `/api/cross-border/${kind === "airport" ? "airport/flights" : "ferry/sailings"}?${qs.toString()}`;
}
