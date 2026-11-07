#!/usr/bin/env node
/**
 * 推送前审核报告（铁律 56~59 · 2026-11-05 负责人立）
 *
 * 目的：把「推送前先审查」从口头纪律变成**机械可复现的清单**。
 *       输出「待推送文件清单 + 每个文件的分类与必要性 + 判定结论」，
 *       判定为 CONFIRM / BLOCK 时**不得推送**。
 *
 * 与 `check-commit-scope.mjs` 的分工：
 *   - `check-commit-scope.mjs` = 提交视角（暂存区），拦敏感内容与禁止类型，exit 0/1
 *   - `review-push.mjs`        = 推送视角（领先远端的全部提交），出清单 + 分类 + 必要性，exit 0/1/2
 *   两者共用 `scripts/lib/push-guard-rules.mjs` 的同一套规则，禁止各写一份。
 *
 * 用法：
 *   node scripts/review-push.mjs                    # 审查「将要推送」的全部提交（对比 origin/main）
 *   node scripts/review-push.mjs --staged           # 审查暂存区（提交前自查）
 *   node scripts/review-push.mjs --base <rev>       # 指定比较基线（默认 origin/main）
 *   node scripts/review-push.mjs --intent "本次改动目标一句话"
 *
 * 退出码：0 = PASS（可推送）· 1 = BLOCK（禁止推送）· 2 = CONFIRM（须人工确认后放行）
 *
 * 报告同时落到 `.verify/push-review-latest.md`（该目录已 gitignore，不入仓库）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ALLOW_FILES,
  ALLOW_DOCS,
  ALLOW_PREFIX,
  BLOCK_EXT,
  BLOCK_EXT_ALLOW,
  SENSITIVE,
  SELF_EXEMPT,
} from "./lib/push-guard-rules.mjs";

/** 大批量阈值：超过就必须人工确认（负责人要求「涉及大批量文件先暂停」） */
const MAX_FILES = 30;
/** 单文件体积阈值：超过提示是否该走 LFS 或放本地 */
const MAX_BYTES = 512 * 1024;
/** 报告落盘路径 */
const REPORT = ".verify/push-review-latest.md";

function git(args) {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], { encoding: "utf8" });
}

function parseArgs(argv) {
  const out = { staged: false, base: "origin/main", intent: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--staged") out.staged = true;
    else if (a === "--base") out.base = argv[++i] ?? out.base;
    else if (a === "--intent") out.intent = argv[++i] ?? "";
  }
  return out;
}

/** 取「状态 + 路径」列表；R/C 会展开成两条（旧路径记删除意图，新路径记新增） */
function collectChanges({ staged, base }) {
  const args = staged
    ? ["diff", "--cached", "--name-status", "--find-renames", "--diff-filter=ACMRD"]
    : ["diff", "--name-status", "--find-renames", "--diff-filter=ACMRD", `${base}...HEAD`];
  let raw = "";
  try {
    raw = git(args);
  } catch {
    return { rows: [], error: `无法执行 git ${args.join(" ")}（基线 ${base} 是否存在？）` };
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0][0];
    if (code === "R" || code === "C") {
      rows.push({ status: "D", path: parts[1] });
      rows.push({ status: "A", path: parts[2] });
    } else {
      rows.push({ status: code, path: parts[1] });
    }
  }
  return { rows, error: null };
}

/** 禁止类兜底：不看白名单，只看「这些东西永远不该进仓库」 */
const HARD_DENY = [
  { re: /(^|\/)\.env($|\.)/i, allow: /\.env\.example$/i, why: "本地环境配置（可能含凭据）" },
  { re: /(^|\/)node_modules\//i, why: "依赖目录（可重装）" },
  { re: /(^|\/)\.next(-[^/]*)?\//i, why: "构建产物（可重建）" },
  { re: /(^|\/)out\//i, why: "构建产物（可重建）" },
  { re: /(^|\/)\.vercel\//i, why: "Vercel 本地元数据" },
  { re: /(^|\/)backups?\//i, why: "备份目录" },
  { re: /(^|\/)\.verify\//i, why: "本地验证产物（gitignore 目录）" },
  { re: /(^|\/)\.workbuddy\//i, why: "项目内部记忆/工具目录（gitignore）" },
  { re: /\.(log|tmp|bak|orig|rej)$/i, why: "日志/临时/冲突残留" },
  { re: /(^|\/)\.DS_Store$/i, why: "系统文件" },
  { re: /\.tsbuildinfo$/i, why: "TypeScript 增量缓存" },
  { re: /\.(pem|key|crt|p12|pfx)$/i, why: "密钥/证书" },
  { re: /^data\/tracking\/(?!README\.md$)/i, why: "采集原始帧（体量大，只留本地）" },
  { re: /\.(jpg|jpeg|png|webp|gif|svg|pdf|zip|gz)$/i, allow: /^docs\/brand-export\//i, why: "二进制资产（非品牌导出目录不入库）" },
];

/** 分类 + 必要性说明；返回 { cat, necessity, level } */
function classify(file) {
  const deny = HARD_DENY.find((r) => r.re.test(file) && !(r.allow && r.allow.test(file)));
  if (deny) return { cat: "禁止入库", necessity: deny.why, level: "block" };

  const ext = BLOCK_EXT_ALLOW.has(file) ? null : BLOCK_EXT.find((e) => file.toLowerCase().endsWith(e));
  if (ext) return { cat: "禁止入库", necessity: `禁止的扩展名 ${ext}（二进制/备份）`, level: "block" };

  if (ALLOW_FILES.has(file)) return { cat: "配置", necessity: "构建/依赖/仓库配置", level: "ok" };
  if (ALLOW_DOCS.some((p) => file.startsWith(p))) {
    return { cat: file.startsWith("docs/decisions/") ? "架构决策记录" : "品牌资产", necessity: "业界惯例随代码提交的决策/正式资产", level: "ok" };
  }
  if (file.startsWith("src/")) return { cat: "源码", necessity: "功能改动本体", level: "ok" };
  if (file.startsWith("scripts/")) return { cat: "脚本/门禁", necessity: "验证或门禁工具", level: "ok" };
  if (file.startsWith(".githooks/")) return { cat: "脚本/门禁", necessity: "推送审核钩子（门禁本体）", level: "ok" };
  if (file.startsWith("db/")) return { cat: "数据/库脚本", necessity: "数据库结构或数据脚本", level: "ok" };
  if (file.startsWith("public/")) return { cat: "静态资源", necessity: "线上静态资源", level: "ok" };
  if (ALLOW_PREFIX.some((p) => file.startsWith(p))) return { cat: "源码", necessity: "功能改动本体", level: "ok" };
  if (file.startsWith("docs/")) {
    return { cat: "过程文档", necessity: "不在文档白名单：需说明为何必须公开（默认只留本地）", level: "confirm" };
  }
  return { cat: "未分类", necessity: "分类不明：需说明是什么、为何必须随本次改动提交", level: "confirm" };
}

function readIfText(file) {
  try {
    if (!existsSync(file)) return "";
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return "";
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const opts = parseArgs(process.argv.slice(2));
const { rows, error } = collectChanges(opts);
const scope = opts.staged ? "暂存区（提交前自查）" : `领先 ${opts.base} 的全部提交`;

const lines = [];
const push = (s = "") => lines.push(s);

push("# 推送前审核报告");
push("");
push(`- 审查范围：${scope}`);
push(`- 生成时间：${new Date().toISOString()}`);
push(`- 本次改动目标：${opts.intent || "**（未填写，须在对话中说明）**"}`);
push("");

if (error) {
  push(`## ❌ 无法取到改动清单`);
  push("");
  push(error);
  push("");
  push("结论：**BLOCK** —— 拿不到清单就不允许推送（铁律 56）。");
  writeFileSync(REPORT, lines.join("\n") + "\n", "utf8");
  console.log(lines.join("\n"));
  process.exit(1);
}

const sizeWarn = [];
const sensitiveHits = [];
const table = [];

for (const row of rows) {
  const c = classify(row.path);
  const isDelete = row.status === "D";
  let level = c.level;
  let necessity = c.necessity;

  if (isDelete) {
    // ★ 删除动作**永远不构成「禁止入库」**：它是在清理，不是在夹带。
    //   （首版把删除的 .png/.pptx 判成 block，导致「清理文档」这一正当动作被自己拦住。）
    //   分类名带「删除（原分类）」前缀，避免统计表里出现「禁止入库 195」这种与结论矛盾的数字。
    const catBefore = c.cat;
    c.cat = `删除（${catBefore}）`;
    level = catBefore === "禁止入库" ? "ok" : "confirm";
    necessity =
      catBefore === "禁止入库"
        ? "删除：清理本不该入库的文件（正向）"
        : "删除：需说明清理理由，并确认本地副本是否保留";
  } else if (level !== "block") {
    const text = SELF_EXEMPT.has(row.path) ? null : readIfText(row.path);
    if (text) {
      for (const { re, why } of SENSITIVE) {
        if (re.test(text)) {
          sensitiveHits.push(`${row.path} —— ${why}`);
          level = "block";
          break;
        }
      }
      if (statSync(row.path).size > MAX_BYTES) {
        sizeWarn.push(`${row.path} —— ${Math.round(statSync(row.path).size / 1024)} KB`);
      }
    }
  }
  if (!SELF_EXEMPT.has(row.path)) table.push({ ...row, ...c, level, necessity });
  else table.push({ ...row, ...c, level: "ok", necessity: "规则源自身（已显式豁免敏感扫描）" });
}

const statusLabel = { A: "新增", M: "修改", D: "删除" };
const CONSOLE_ROWS = 60;
push("## 一、待推送文件清单");
push("");
if (table.length === 0) {
  push("（空）没有任何待推送的文件。");
} else {
  push("| # | 状态 | 分类 | 文件 | 必要性说明 |");
  push("|---|---|---|---|---|");
  table.forEach((t, i) => {
    const flag = t.level === "block" ? " ⛔" : t.level === "confirm" ? " ❓" : "";
    const row = `| ${i + 1} | ${statusLabel[t.status] ?? t.status} | ${t.cat} | \`${t.path}\` | ${t.necessity}${flag} |`;
    // 控制台只打前 60 行，完整清单始终在报告文件里（避免刷屏后无人看）
    if (i < CONSOLE_ROWS || t.level === "block") push(row);
    else if (i === CONSOLE_ROWS) push(`| … | … | … | … | 其余 ${table.length - CONSOLE_ROWS} 行见报告文件 |`);
  });
}
push("");

const byCat = new Map();
for (const t of table) byCat.set(t.cat, (byCat.get(t.cat) ?? 0) + 1);
push("## 二、分类统计");
push("");
if (byCat.size === 0) push("（空）");
else {
  push("| 分类 | 文件数 |");
  push("|---|---|");
  for (const [cat, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) push(`| ${cat} | ${n} |`);
}
push("");

push("## 三、敏感内容扫描");
push("");
if (sensitiveHits.length === 0) push("✅ 新增/修改文件全部 0 命中（密钥、内部接口、鉴权签名、采集强度、连接串）。");
else {
  push("⛔ 以下文件命中敏感特征，**不得推送**：");
  push("");
  for (const h of sensitiveHits) push(`- ${h}`);
}
push("");

if (sizeWarn.length) {
  push("## 四、体积提示");
  push("");
  for (const s of sizeWarn) push(`- ${s}（超过 ${Math.round(MAX_BYTES / 1024)} KB，确认是否该走 LFS 或留本地）`);
  push("");
}

const blocks = table.filter((t) => t.level === "block");
const confirms = table.filter((t) => t.level === "confirm");
const tooMany = table.length > MAX_FILES;

push("## 结论");
push("");
if (blocks.length > 0) {
  push(`**BLOCK（禁止推送）** —— ${blocks.length} 个文件属于禁止入库类型，或命中敏感内容。`);
  push("");
  push("处理：从索引移除（`git rm --cached <file>`，本地副本保留）或改用忽略规则；**不得用 `--no-verify` 绕过**。");
} else if (confirms.length > 0 || tooMany) {
  push(`**CONFIRM（须人工确认后才可推送）**`);
  push("");
  if (tooMany) push(`- 文件数 ${table.length} 超过大批量阈值 ${MAX_FILES}：需说明这次为何必须动这么多文件，并确认没有夹带。`);
  if (confirms.length > 0) {
    // 按「分类 + 理由」归组：260 条同因删除不该刷成 260 行，但必须给出可核对的数量与样本
    const groups = new Map();
    for (const c of confirms) {
      const key = `${c.cat}｜${c.necessity}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c.path);
    }
    push(`- ${confirms.length} 个文件分类不明或不在白名单，需逐项说明必要性（按理由归组）：`);
    for (const [key, paths] of groups) {
      const [cat, why] = key.split("｜");
      push(`  - **${cat}**（${paths.length} 个）—— ${why}`);
      for (const p of paths.slice(0, 5)) push(`    - \`${p}\``);
      if (paths.length > 5) push(`    - …其余 ${paths.length - 5} 个见 \`.verify/push-review-latest.md\``);
    }
  }
  push("");
  push("处理：向负责人列出上面每一条的理由，得到明确确认后才可推送（铁律 56/58）。");
} else {
  push(`**PASS（可推送）** —— ${table.length} 个文件全部属于允许范围，0 敏感命中。`);
  push("");
  push("仍需在对话中说明「本次改动目标」，并按铁律 35 过六问风控、按铁律 34 核当日发布额度。");
}

const report = lines.join("\n") + "\n";
mkdirSync(dirname(join(process.cwd(), REPORT)), { recursive: true });
writeFileSync(join(process.cwd(), REPORT), report, "utf8");
console.log(report);
console.log(`（报告已写入 ${REPORT}）`);

process.exit(blocks.length > 0 ? 1 : confirms.length > 0 || tooMany ? 2 : 0);
