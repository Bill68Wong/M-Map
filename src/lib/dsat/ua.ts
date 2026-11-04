/**
 * DSAT 请求的 User-Agent（合规自证，v0.27.3）
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────
 * 2026-09-14 实测：本项目对 DSAT 的请求此前**未设 UA**，Node 默认发 `user-agent: node`
 * → 对 WAF / 运维而言是「我是脚本」的明牌，却**无法识别是谁**、出事也找不到人。
 *
 * ── 写法约定（要改先读 docs/数据来源合规备忘-20260914.md §七 #1）──
 *   · 产品名/版本  → 便于对方把同类流量归组、判断是哪一代行为
 *   · `(+URL)`     → RFC 9110 惯例，表示「说明地址」；想了解或想联系，点一下就到
 *   · `personal non-commercial` → 直接对应 DSAT 使用條款的「非商業用途」措辞
 *
 * ── 四条禁忌 ───────────────────────────────────────────────────────
 *   ❌ 不伪装成浏览器（`Mozilla/5.0…`）——一旦被识破，性质就从「透明的小客户端」
 *      变成「故意隐瞒的爬虫」，且与我们真实的行为特征（无 Referer、恒定节律）自相矛盾
 *   ❌ 不写 bot / crawler / spider / scraper —— 很多 WAF 见词即拦；而且我们**本来就不是**
 *      搜索引擎爬虫 —— 准确的描述是「M Map 客户端」（这是「更准确」而非「更隐蔽」）。
 *      产品标识 = **`M-Map`**（2026-11-04 起按负责人要求改名；旧标识已全仓废止，
 *      沿革见 `git log -- src/lib/dsat/ua.ts` 与 docs/数据来源合规备忘-20260914.md）。
 *      为什么是 `M-Map` 而不是 `M Map`：UA 里的产品标识（product token）按 RFC 9110 §5.6.2
 *      （原 RFC 7230 §3.2.6）必须是 `token`，**不允许空格**——写成 `M Map` 会被解析成
 *      `M` 与 `Map` 两个独立 token（语义变味），也可能被 WAF 判为畸形请求。
 *      ⇒ 品牌名带空格只出现在**给人看**的地方（窗口标题 `run-collect.bat`、界面文案）；
 *        HTTP 头里一律 `M-Map`。
 *      `personal non-commercial` 用途声明**保持不变**（对应 DSAT 使用條款的「非商業用途」）。
 *      ⚠️ 该标识自 v0.27.3 起曾长期充当对 DSAT／WAF 的稳定识别记号；**改名会重置对方的
 *      流量归组与追溯** —— 这是负责人 2026-11-04 明确要求的取舍，不是无意改串。
 *      改动范围：本文件 + `scripts/track-collect.mjs`（脚本刻意不 import src/）两处必须同步，
 *      且**旧串不得在任何 src/scripts 文件里残留**（含注释），否则 `git grep` 门禁失效。
 *   ❌ 不放中文 / emoji —— HTTP 头历史上是 latin-1，非 ASCII 可能乱码或被服务器拒收
 *   ❌ 不放个人邮箱 / 姓名 —— UA 会被对方与中间设备完整记录且公开可见；改用项目网址，
 *      真正的联系方式留在我们自己能控制的页面（「關於」页）上
 *
 * 版本号随 `package.json` 自动同步，避免发版后忘记更新而写死在旧版本。
 */
import pkg from "../../../package.json";

/** 项目说明页（对外可识别的身份入口） */
export const DSAT_PROJECT_URL = "https://macaomap.vercel.app";

/**
 * 唯一的 DSAT 请求 UA。
 * 采集脚本 `scripts/track-collect.mjs` 刻意不 import src/，故在那里内联复刻同一格式——
 * 改格式时**两处都要改**（2026-11-04 的产品标识改名即是两处同改）。
 */
export const DSAT_UA = `M-Map/${pkg.version} (+${DSAT_PROJECT_URL}; personal non-commercial)`;
