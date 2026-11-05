#!/usr/bin/env node
/**
 * 提交范围门禁（决策 D1 · 2026-10-28）
 *
 * 目的：仓库只承载「跑起来需要的东西」。数据调研/逆向分析/内部复盘/路演材料
 *       一律留在本地，不进公开仓库。
 *
 * 用法：
 *   node scripts/check-commit-scope.mjs              # 检查已 staged 的文件（pre-commit 钩子调用）
 *   node scripts/check-commit-scope.mjs --all        # 检查工作区全部未忽略文件（体检）
 *   SCOPE_ENFORCE=1 git commit ...                   # 非白名单目录也硬拦（默认只警告）
 *
 * 退出码：0 = 通过；1 = 命中硬拦截（敏感内容）
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import {
  ALLOW_PREFIX,
  ALLOW_DOCS,
  ALLOW_FILES,
  BLOCK_EXT,
  SENSITIVE,
  SELF_EXEMPT,
} from "./lib/push-guard-rules.mjs";

/** 规则（允许路径 / 禁止类型 / 敏感特征）集中在 `scripts/lib/push-guard-rules.mjs`，
 *  与 `scripts/review-push.mjs` 共用同一份，禁止各写一套（会漂移成两个都不可信的门）。
 *  `SELF_EXEMPT` 亦由该文件导出，本脚本不再自行维护豁免名单。 */

function isAllowed(file) {
  if (ALLOW_FILES.has(file)) return true;
  if (ALLOW_DOCS.some((p) => file.startsWith(p))) return true;
  return ALLOW_PREFIX.some((p) => file.startsWith(p));
}

function stagedFiles() {
  try {
    // core.quotepath=false：中文路径保持 UTF-8 原文，否则会被加引号转义成 \xxx，
    // 导致白名单匹配与敏感词扫描对中文文件双双失效（2026-11-05 变异自证发现）。
    const out = execFileSync("git", ["-c", "core.quotepath=false", "diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
      encoding: "utf8",
    });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function workingFiles() {
  try {
    const out = execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
    });
    return [...new Set(out.split("\n").map((s) => s.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function readText(file) {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return "";
    if (statSync(file).size > 400 * 1024) return ""; // 大文件不读全文
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const enforceScope = process.env.SCOPE_ENFORCE === "1";
const files = process.argv.includes("--all") ? workingFiles() : stagedFiles();

if (files.length === 0) {
  console.log("[scope] 无待检查文件，通过。");
  process.exit(0);
}

const hardBlocks = [];
const softWarns = [];

for (const f of files) {
  const lower = f.toLowerCase();
  const ext = BLOCK_EXT.find((e) => lower.endsWith(e));
  if (ext) hardBlocks.push(`${f} —— 禁止入库的二进制/备份类型（${ext}）`);
  if (lower.includes("/.env") || lower === ".env" || lower.startsWith(".env.")) {
    if (!lower.endsWith(".env.example")) hardBlocks.push(`${f} —— 环境文件（凭据）不得入库`);
  }

  if (!isAllowed(f)) softWarns.push(`${f} —— 不在白名单（src/ public/ scripts/ db/ + 构建配置 + README）`);

  if (SELF_EXEMPT.has(f)) continue;

  const text = readText(f);
  if (!text) continue;
  for (const { re, why } of SENSITIVE) {
    if (re.test(text)) hardBlocks.push(`${f} —— ${why}（命中 ${re.source}）`);
  }
}

if (softWarns.length) {
  console.log("\n[scope] ⚠️ 以下文件不在提交白名单内（决策 D1）：");
  for (const w of softWarns) console.log("  · " + w);
  if (enforceScope) hardBlocks.push(...softWarns.map((w) => w + " [SCOPE_ENFORCE=1]"));
}

if (hardBlocks.length) {
  console.log("\n[scope] ❌ 提交被拦截：");
  for (const b of hardBlocks) console.log("  · " + b);
  console.log("\n处理方式：把这些内容移到本地目录（docs/ .verify/ .workbuddy/ 均已被 .gitignore 覆盖），");
  console.log("或确属必要文件时把它们加入 scripts/check-commit-scope.mjs 的白名单。");
  console.log("临时绕过：git commit --no-verify（不建议）。\n");
  process.exit(1);
}

console.log(`[scope] ✅ 通过（检查 ${files.length} 个文件）`);
