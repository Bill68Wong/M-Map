"use client";

/**
 * 跨境交通 · 班次表（src/components/cross-border/XbTable.tsx，2026-11-07）
 *
 * 一套表格同时服务两个需求，靠**列模板**区分（设计稿 §07 的数值表）：
 *   需求 5「最近五班」= 10 行以内 ⇒ `tbl-air4` / `tbl-sea3`（不含登机口/闸口）
 *   需求 6「当日所有」= 70+ 行   ⇒ `tbl-air5` / `tbl-sea4` / `tbl-sea5`（含登机口/闸口）
 * 列宽是**设计稿逐像素给的**，不要重排：状态列拿的是剩余空间（`1fr`），
 * 因为它是唯一可能两行（`已啟航 08:20`）的单元格。
 *
 * ── 70+ 行在 390px 里不迷路的两件套（设计稿 §04 的核心解法）──────────────
 *   ① 表头 `position: sticky` 吸附在弹窗顶部；
 *   ② 「現在」游标（1px 强调色横线）+ **打开即定位**到它。
 *   ⚠️ 2026-11-07（负责人裁定）：**小时分组已取消**（原第 ② 件「08 時 / 3 班」），
 *      表格改为平铺。取消分组不影响吸附 —— `.xb-hr` 当年也不是 sticky。
 *   ⚠️ 不做筛选、不做虚拟滚动、不做滚动劫持（设计稿 §7.4 / 负责人否决了"只看未出发"）。
 *
 * ── 表头与单元格一律不换行、不省略（2026-11-07）───────────────────────
 *   `globals.css` 的 `.xb-th` / `.xb-c` 都补了 `white-space: nowrap`；
 *   列宽按**最长真实文案**给足，总宽超出容器时由 `.xb-sheet__body` 横向滚动。
 *   **禁止**改回 `text-overflow: ellipsis` 或缩字号来"凑进屏"：省略是永久丢信息。
 *
 * ── 语义：CSS Grid 排的表**必须**显式补 role ─────────────────────────────
 *   原生 `<table>` 的语义在 grid 布局下不存在了。补 `role="table"/"row"/"columnheader"/"cell"`，
 *   文档流顺序 = 视觉顺序（不用 CSS `order` 重排，否则读屏顺序会与看到的不一致）。
 *
 * ── 已出发 ≠ 失效 ───────────────────────────────────────────────────────
 *   终态行只把**文字**降为 `--muted`（`xb-c--dim` / `xb-st--past`），**不整行置灰、不加删除线**
 *    —— 整行置灰会被读成"这班作废了"，而它其实只是"已经走了"。
 *   判断"是不是终态"**只许用 `isTerminal`**（方向敏感，见 `xb-view.ts#statusClass` 的长注释）。
 */

import { useEffect, useRef } from "react";
import type { XbAfter, XbDir } from "@/lib/cross-border/types";
import {
  buildTableNodes,
  displaySched,
  statusCell,
  statusClass,
  type XbKind,
  type XbRow,
} from "./xb-view";

/** 上游没给的值：统一口径（与车型卡一致），**不留空单元格** */
const ABSENT = "资料未公开";

/* 窄屏表头短名（稿 320 档：`10 / .04em（短名：到达·出发）`）。
   ⚠️ 键必须与 `tableSpec()` 里 heads 的**真实字符串**逐一对应（dep / arr 两个方向都要覆盖）；
      漏一个方向 ⇒ 该方向窄屏仍渲染全名。代码里的真实字符串共 10 个：
      航班号 / 到达地 / 出发地 / 计划出发 / 计划到达 / 状态 / 登机口 / 闸口 / 船名 / 船务公司
   ⚠️ 短名不是省宽手段：该列轨道下限由正文 `深圳蛇口`(44.00) 决定，与表头长短无关。
   ⚠️ 不要用 `::before { content }` 替换文本（部分读屏不读 CSS 生成内容，会丢字）。 */
const SHORT_HEAD: Record<string, string> = {
  到达地: "到达", // dep 第 2 格（air4/air5/sea3/sea5）
  出发地: "出发", // arr 第 3 格（air4/sea3/sea4）
  计划出发: "出发", // dep 第 3 格（air4/air5/sea3/sea5）
  计划到达: "到达", // arr 第 4 格（air4/sea3/sea4）
};

/**
 * 列模板类名。
 *
 * ⚠️ 2026-11-07 起，**船侧三个模板名里的数字不再等于列数**（各 +1 了「船务公司」）：
 *   `tbl-sea3` = 4 列（五班）、`tbl-sea4` = 5 列（抵澳全量）、`tbl-sea5` = 6 列（离澳全量）。
 *   为什么**不**跟着改成 `sea4/sea5/sea6`：一是会与既有 `sea4`/`sea5` 撞名、二是设计稿
 *   §04 的「sea5 = 离港全量」口径会被改义。名字保持"指哪个界面"，数字的意义作废。
 *   ⇒ `scripts/check-xborder-ui.tsx` 那条「表头数 = 类名末位数字」的断言因此失效，
 *      需由 QA 改为按实际列数表（该脚本不在本批可改范围）。
 */
type Cols = "tbl-air4" | "tbl-air5" | "tbl-sea3" | "tbl-sea4" | "tbl-sea5";

/**
 * 表头：船务公司（2026-11-07 新增列）。
 *
 * ── 语种为何是简体 ────────────────────────────────────────────────────
 *   本文件 `heads` 数组里既有 5 组表头**全是简体**（航班号 / 到达地 / 计划出发 /
 *   状态 / 登机口 / 闸口），新增一格必须与同数组一致，否则同一行表头里混两种字形。
 *   全站语种（繁体 vs 简体）整体是混用的（数据类偏繁、界面类偏简），**未裁定统一**；
 *   若裁定改繁体，**只需改这一个字符串**为 `"船務公司"`：列宽 72px 是 4 字 + 余量，
 *   繁简同宽，无需联动 CSS。
 */
const HEAD_OPERATOR = "船务公司";

/**
 * 列模板 + 表头文案。
 *
 * ── 「五班视图为什么没有登机口列」的依据是**需求原文**，不是设计稿 ────────
 *   需求 5 逐字：「机场的显示为**航班号 + 到达地 + 计划出发（时间）+ 状态**」
 *   —— **四个字段，没有登机口**。所以 `after=now` 必须是 4 列。
 *   当日所有（需求 6）只写「表格形式呈现当日所有」，没限字段；已有数据不展示是浪费
 *   ⇒ `after=day`（且 `dir=dep`）才加登机口/闸口那一列。
 *   抵澳侧上游根本没有这个字段 ⇒ arr 永远不加。
 *
 *   ⚠️ 别把依据写成「设计稿的 tbl-air4 同时用在两处」那种**间接推断**：
 *      需求不变则结论不变，设计稿一调就失效。判断依据要挂在最稳的那层。
 */
export function tableSpec(
  kind: XbKind,
  dir: XbDir,
  after: XbAfter,
): { cls: Cols; heads: string[] } {
  if (kind === "airport") {
    if (dir === "dep" && after === "day") {
      return { cls: "tbl-air5", heads: ["航班号", "到达地", "计划出发", "状态", "登机口"] };
    }
    return {
      cls: "tbl-air4",
      heads: [
        "航班号",
        dir === "dep" ? "到达地" : "出发地",
        dir === "dep" ? "计划出发" : "计划到达",
        "状态",
      ],
    };
  }
  /* 船 · 最近五班：**预览分支也必须看 `dir`**（2026-11-07 P1 修复）。
     ── 缺陷原貌 ──
       本分支曾写死 `["船名", HEAD_OPERATOR, "到达地", "计划出发"]`，而 `dir` 判断在
       `after === "now"` 之后 ⇒ `ferry/arr/now` 走这里，表头说「去哪」，行内第 3 格却是
       **出发地**、第 4 格是**计划到达**（抵澳全量 `tbl-sea4` 的表头正是这么写的）。
       页面不报错，属**沉默语义错误**：用户看「从哪来」会被读成「去哪」。
     ── 口径 ──
       类名与轨道数**一律不动**（仍是 `tbl-sea3` / 4 轨，负责人裁定最近五班不加状态列），
       只按方向换第 3、4 个表头文案，与 `tbl-sea4`（arr）／`tbl-sea5`（dep）的语义一致。 */
  if (after === "now") {
    return {
      cls: "tbl-sea3",
      heads:
        dir === "dep"
          ? ["船名", HEAD_OPERATOR, "到达地", "计划出发"]
          : ["船名", HEAD_OPERATOR, "出发地", "计划到达"],
    };
  }
  if (dir === "dep") {
    return {
      cls: "tbl-sea5",
      heads: ["船名", HEAD_OPERATOR, "到达地", "计划出发", "状态", "闸口"],
    };
  }
  return { cls: "tbl-sea4", heads: ["船名", HEAD_OPERATOR, "出发地", "计划到达", "状态"] };
}

/** 表格里携带的额外字段（各端点自己的载荷，故意放宽以免与后端类型耦合过死） */
export interface XbTableItem extends XbRow {
  flightNo?: string;
  vessel?: string | null;
  /**
   * 船务公司**上游原文**（`xborder_sailings.operator_raw`，接口已在下发）。
   * 只有船侧有；机场侧不传 ⇒ `tableSpec` 也就不给机场模板这一列。
   */
  operator?: string | null;
  place: string;
  gate?: string | null;
  status: string;
}

export interface XbTableProps<R extends XbTableItem> {
  kind: XbKind;
  dir: XbDir;
  after: XbAfter;
  items: R[];
  /** 澳门本地「现在」的分钟数（来自 `serverNow`；`null` ⇒ 不画游标） */
  nowMinutes: number | null;
  /** 澳门本地今日 `YYYY-MM-DD`（来自 `serverNow`） */
  today: string | null;
  /** 打开即定位到「現在」游标（只有全屏页要；五班卡视图不要，那会把列表滚走） */
  autoScroll?: boolean;
}

export default function XbTable<R extends XbTableItem>({
  kind,
  dir,
  after,
  items,
  nowMinutes,
  today,
  autoScroll = false,
}: XbTableProps<R>) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const spec = tableSpec(kind, dir, after);
  const nodes = buildTableNodes(items, nowMinutes);

  /* 打开即定位：滚到「現在」游标（`block: center` ⇒ 上游几行留给上下文）。
     `prefers-reduced-motion` 下用瞬间跳转（设计稿 §7.4 明确要求）。 */
  useEffect(() => {
    if (!autoScroll || nowMinutes == null) return;
    const el = boxRef.current?.querySelector<HTMLElement>("[data-xb-now]");
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }, [autoScroll, nowMinutes, items.length]);

  const total = items.length;

  return (
    <>
    {/*
      `aria-rowcount` 算法（2026-11-07 复核，取消分组后**仍为 `total + 1`**）：
        · `role="table"` 下 `aria-rowcount` 数的是**可被读屏当作 row 的元素**；
        · 表头 1 行（`role="row"`，第 173 行）+ 数据行 `total` 行 ⇒ `total + 1`；
        · 「現在」游标是 `role="presentation"`（下表 `node.kind === "now"` 分支），**不计**；
        · 旧版小时分组是 `aria-hidden="true"`，当年也**不计** ⇒ 删掉它不改变这个值。
      ⚠️ 空表也仍渲染表头 ⇒ `total=0` 时必须是 1，`total + 1` 正好。
    */}
    <div className={`xb-tbl ${spec.cls}`} ref={boxRef} role="table" aria-rowcount={total + 1}>
      <div className="xb-th xb-th--sticky" role="row">
        {spec.heads.map((h, i) => {
          const short = SHORT_HEAD[h];
          return (
            <span
              key={h}
              role="columnheader"
              className={short ? "xb-th__c xb-th__c--short" : "xb-th__c"}
              aria-label={i === 0 ? `${h}，列定义` : h} /* 全名常驻 aria-label：两档读屏一致 */
            >
              <span className="xb-th__full" aria-hidden="true">{h}</span>
              {short ? <span className="xb-th__short" aria-hidden="true">{short}</span> : null}
            </span>
          );
        })}
      </div>

      {nodes.map((node, idx) => {
        if (node.kind === "now") {
          const hh = String(Math.floor(node.minutes / 60)).padStart(2, "0");
          const mm = String(node.minutes % 60).padStart(2, "0");
          return (
            <div className="xb-now" key={`now-${idx}`} data-xb-now="" role="presentation">
              <span className="xb-now__t">{`現在 ${hh}:${mm}`}</span>
              <span className="xb-now__l" />
            </div>
          );
        }

        const r = node.row;
        const dim = r.isTerminal ? " xb-c--dim" : "";
        const when = displaySched(r.schedDate, r.schedTime, today);
        /* 状态**原文直出**（唯一例外：占位字面量 `"0"` ⇒ 「待定」，见 `statusCell`） */
        const st = statusCell(r.status);
        /* 有状态列吗？只看表头里有没有「状态」——列模板是唯一真相，不在渲染处再判方向 */
        const hasStatus = spec.heads.includes("状态");
        const hasGate = spec.heads.includes("登机口") || spec.heads.includes("闸口");
        /* 船务公司列（只有船侧模板有；机场模板的 heads 里不含它） */
        const hasOperator = spec.heads.includes(HEAD_OPERATOR);

        /* 单元格顺序 = 列模板顺序，改一处必须两处一起改（head 与 cell 必须同序） */
        const cells = [
          /* ① 航班号 / 船名 */
          <span key="a" role="cell" className={`xb-c xb-c--num${dim}`}>
            {kind === "airport" ? r.flightNo || ABSENT : r.vessel || ABSENT}
          </span>,
          /* ② 船务公司（上游原文；缺值用与船名同款的「资料未公开」，不留空单元格） */
          ...(hasOperator
            ? [
                <span key="op" role="cell" className={`xb-c${dim}`}>
                  {r.operator || ABSENT}
                </span>,
              ]
            : []),
          /* ③ 到达地 / 出发地（上游原文） */
          <span key="b" role="cell" className={`xb-c${dim}`}>
            {r.place}
          </span>,
          /* ④ 计划时刻（本日只给 HH:MM；跨日才拼 MM-DD） */
          <span key="c" role="cell" className={`xb-c xb-c--num${dim}`}>
            {when}
          </span>,
        ];

        if (hasStatus) {
          /* ⑤ 状态：颜色只做冗余通道，文本是真相（取消 --danger 不被置灰吃掉；
                `pending`（上游 `0`）非终态 ⇒ 无色不着灰，文字「待定」 */
          cells.push(
            <span
              key="d"
              role="cell"
              className={`xb-c xb-c--st ${statusClass(r.statusKind, r.isTerminal)}`}
            >
              {st.text}
            </span>,
          );
        }

        if (hasGate) {
          /* ⑥ 登机口 / 闸口（仅「当日所有 + 离澳」）：38/40px 窄列放不下 5 个汉字，
                故空值用「—」而不是「資料未公開」——这是本页唯一允许的破折号，
                理由是列宽物理限制 + 它不属需求 5 的四个必填字段。 */
          cells.push(
            <span key="e" role="cell" className={`xb-c xb-c--num xb-c--ctr${dim}`}>
              {r.gate || "—"}
            </span>,
          );
        }

        return (
          <div className="xb-tr" key={r.id} role="row">
            {cells}
          </div>
        );
      })}
    </div>
    </>
  );
}
