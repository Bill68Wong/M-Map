/**
 * 推送/提交守卫的**唯一规则源**
 *
 * 为什么集中：`check-commit-scope.mjs`（提交视角，看暂存区）与
 * `review-push.mjs`（推送视角，看领先远端的全部提交）必须用同一套
 * 「允许路径 / 禁止类型 / 敏感特征」。各写一份就会漂移——
 * 一处放宽、另一处仍严，最终两道门都不可信（铁律 44b 假绿来源之「双份判定」）。
 *
 * ⚠️ 本文件**必然包含敏感词字面量**（正则源就在这儿），扫描自己一定命中，
 * 因此由 `SELF_EXEMPT` 显式豁免。豁免范围保持最小：只此一个文件（铁律 46）。
 */

/** 允许进入仓库的路径前缀（`.githooks/` = 推送审核钩子，属门禁工具本体） */
export const ALLOW_PREFIX = ["src/", "public/", "scripts/", "db/", ".githooks/"];

/**
 * 允许进入仓库的文档白名单（2026-11-05 文档清理后确立）。
 * 除这些之外的 docs/ 文件均视为内部过程文档，只留本地，不进公开仓库。
 */
export const ALLOW_DOCS = ["docs/decisions/ADR-", "docs/brand-export/"];

/** 允许进入仓库的单文件（构建配置 / 依赖清单 / 入口说明） */
export const ALLOW_FILES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "next.config.ts",
  "eslint.config.mjs",
  "vercel.json",
  ".gitignore",
  ".gitattributes",
  ".env.example",
  "README.md",
  "next-env.d.ts",
]);

/** 扩展名硬拦截：二进制大件 / 备份 / 环境文件 */
export const BLOCK_EXT = [".pptx", ".mp4", ".mov", ".dump", ".sql", ".gz", ".zip"];

/**
 * `BLOCK_EXT` 的显式豁免（**必须由门禁侧枚举，不得由被检文件自证**）。
 *
 * 只有一条，理由必须写清：`db/schema.sql` 是**建表结构单一真源**，自仓库建立起就是
 * 已跟踪的纯文本文件，且**必须与迁移脚本同批提交**（新增表不更新 schema.sql 会在换机器
 * 跑 `db:schema` 时缺表）。`.sql` 进 BLOCK_EXT 的初衷是拦 `backups/` 下的**数据 dump**
 * （含真实数据、体积大），与该文件无关 —— 若不豁免，等于要求提交迁移却不许提交结构定义，
 * 长期结果是 schema.sql 与库悄悄分叉。
 *
 * ⚠️ 新增条目前先问：它是不是「已跟踪的纯文本结构/契约文件」？是数据快照一律不加。
 */
export const BLOCK_EXT_ALLOW = new Set(["db/schema.sql"]);

/** 敏感内容特征：命中即硬拦（这些是「绕过访问控制」的说明书特征） */
export const SENSITIVE = [
  { re: /macauweb/i, why: "DSAT 内部接口路径" },
  { re: /getRouteAndCompanyList|getRouteData\.html/i, why: "DSAT 未公开接口名" },
  { re: /genToken|token\s*=\s*md5|md5\(qs\)/i, why: "DSAT 鉴权签名实现" },
  { re: /签名算法|已破解|已逆向|逆向非公开接口|抓包破解/i, why: "逆向分析描述" },
  { re: /次\s*\/\s*秒|次\/秒|req\/s/i, why: "采集强度指标（易被判异常使用）" },
  { re: /DATABASE_URL\s*=\s*postgres/i, why: "疑似真实数据库连接串" },
  { re: /\beyJ[A-Za-z0-9_-]{20,}\b/, why: "疑似 JWT / Token 明文" },
  { re: /sbp_[A-Za-z0-9]{20,}/, why: "疑似 Supabase 密钥" },
];

/**
 * 自身豁免：规则文件里就含这些字面量，扫自己必然误报。
 * 扩大这张表 = 削弱门禁，新增条目必须在注释里写明「为什么它自己也含敏感字面量」。
 */
export const SELF_EXEMPT = new Set(["scripts/lib/push-guard-rules.mjs"]);
