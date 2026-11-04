/**
 * scripts/test-geo-resume.ts —— ★ v3.12「用户定位切后台回前台」自愈判定回归
 *
 * ── 这个文件解决什么（为什么不能只靠真机人肉测）────────────────────────
 *   本次 bug 的根因是一行**无法被任何既有断言触达**的早退：
 *     `if (!startedRef.current || watchRef.current == null) return;`（旧 `useUserFix.ts:237`）
 *   ⇒ 「订阅句柄已被清掉」被当成"无事可做"，于是「清掉之后没有任何事件回来」就永久无定位。
 *   这类**沉默状态机错误**不抛异常、不打日志，真机上表现为"卡住"，但没人能说出卡在哪一步。
 *   ⇒ 把判定抽成纯函数 `geoRecoveryOf()`（`src/components/nav/useUserFix.ts`），
 *     在本文件里直接 import **线上那一份**做真值表对拍（不复制实现）。
 *
 * ── 断言三分法 ────────────────────────────────────────────────────────
 *   · **守护型**（防将来改坏）⇒ 末尾「变异自检」段必须证明"造错能被检出"；
 *   · **描述型**（记录当前行为）⇒ 本文件 §③ 是描述型，附明确警告，不是守护型；
 *   · **契约型**（锁外部接口）⇒ §② 锁「回前台 3s 出帧」所依赖的阈值关系。
 *
 * ── 跑法（铁律 17：npx 本机可能静默失效 ⇒ 直喂 tsx CLI 实体）───────────
 *   node node_modules/tsx/dist/cli.mjs scripts/test-geo-resume.ts
 *
 * ⚠️ 覆盖边界（如实登记）：本文件只测**判定表**。`watchPosition` 到底会不会在
 *    某机型后台后"假活"、探针能不能秒回 —— **只能真机验**，见 PR 报告「未解决」段。
 */
import { geoRecoveryOf, type GeoRecoveryPlan } from "../src/components/nav/useUserFix";
import { geoStateOf } from "../src/components/nav/observe-hooks";

let failed = 0;
const ok = (cond: boolean, name: string, detail = ""): void => {
  if (cond) console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};

const NOW = 1_900_000_000_000;
const S = 1_000;

/** 默认基线：已 start、句柄在、刚拿到帧（健康） */
const base = {
  nowMs: NOW,
  started: true,
  hasWatch: true,
  permDenied: false,
  sinceRebuildMs: 60 * S,
  lastCbTs: NOW - 1 * S,
  dogBaseTs: NOW - 60 * S,
  visible: true,
  activityProven: false,
};
const plan = (p: Partial<typeof base>): GeoRecoveryPlan => geoRecoveryOf({ ...base, ...p });

/* ══════════════════════════════════════════════════════════════════════
   ① 死锁形态 ①：句柄已清（hidden 时 stopWatch）但收不到 visible
      —— 旧实现看门狗在此**每一拍都 return**，永久无订阅
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ① 句柄为 null（旧实现永久死锁）──");
ok(
  plan({ hasWatch: false, lastCbTs: NOW - 600 * S, visible: true }) === "subscribe",
  "句柄 null + 前台 ⇒ subscribe（旧实现返回 none ⇒ 永久卡住）",
);
ok(
  plan({ hasWatch: false, lastCbTs: 0, visible: true }) === "subscribe",
  "句柄 null + 从未成功过 + 前台 ⇒ subscribe（不是「等 20s」）",
);
ok(
  plan({ hasWatch: false, visible: true, activityProven: true }) === "subscribe",
  "句柄 null + 无可见性但用户刚碰了页面 ⇒ subscribe（WebView 壳兜底）",
);
ok(
  plan({ hasWatch: false, visible: false, activityProven: false }) === "none",
  "句柄 null + 确实在后台 ⇒ none（不在后台重订阅，省电；回前台另有 5 条事件）",
);

/* ══════════════════════════════════════════════════════════════════════
   ② 死锁形态 ②：句柄在、订阅死 —— 稳态 12s 阈值（原 20s）
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ② 句柄在但数据停（稳态假死阈值 12s）──");
ok(
  plan({ lastCbTs: NOW - 25 * S, dogBaseTs: NOW - 25 * S }) === "rebuild",
  "25s 无帧 ⇒ rebuild（旧实现要等满 20s 且被 resume 重置过还要再等；现在 12s）",
);
ok(
  plan({ lastCbTs: NOW - 12 * S, dogBaseTs: NOW - 12 * S }) === "none",
  "恰好 12s ⇒ none（阈值是严格大于，边界不上报）",
);
ok(
  plan({ lastCbTs: NOW - 12 * S - 1, dogBaseTs: NOW - 12 * S - 1 }) === "rebuild",
  "12.001s ⇒ rebuild（边界另一侧）",
);
ok(
  plan({ lastCbTs: NOW - 4 * S, dogBaseTs: NOW - 4 * S }) === "none",
  "4s 无帧 ⇒ none（室内正常抖动不得被误判成假死）",
);
ok(
  plan({ lastCbTs: NOW - 60 * S, dogBaseTs: NOW - 60 * S, visible: false }) === "rebuild",
  "句柄在 + 长时间无帧 + 后台 ⇒ 仍 rebuild（后台期间巡检解冻后第一拍就能发现）",
);

/* ══════════════════════════════════════════════════════════════════════
   ③ 反风暴：不许把"刚订阅还没出帧"当成假死
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ③ 反风暴（重建冷却 / 刚订阅宽限）──");
ok(
  plan({ lastCbTs: NOW - 60 * S, sinceRebuildMs: 1 * S }) === "none",
  "1s 前刚重建过 ⇒ none（否则 2s 巡检会把冷启动打断成死循环）",
);
ok(
  plan({ lastCbTs: NOW - 60 * S, sinceRebuildMs: -1 }) === "rebuild",
  "本次会话从未重建 + 60s 无帧 ⇒ rebuild（首次假死必须能救）",
);
ok(
  plan({ lastCbTs: 0, dogBaseTs: NOW - 5 * S }) === "none",
  "刚订阅 5s、还没拿到第一帧 ⇒ none（GPS 冷启动有物理耗时，不是假死）",
);

/* ══════════════════════════════════════════════════════════════════════
   ④ 门禁：未 start / 已拒权 —— 不许"好心重试"
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ④ 门禁（未请求 / 已拒权）──");
ok(plan({ started: false, hasWatch: false }) === "none", "未 start ⇒ none（权限申请必须用户手势）");
ok(plan({ started: false, hasWatch: false, activityProven: true }) === "none", "未 start + 用户点页面 ⇒ none");
ok(plan({ permDenied: true, hasWatch: false }) === "none", "已拒权 ⇒ none（重订阅只会再报一次错）");
ok(
  plan({ permDenied: true, lastCbTs: NOW - 600 * S }) === "none",
  "已拒权 + 久无帧 ⇒ none（解除拒权标记只能由 resume / 用户改设置触发）",
);

/* ══════════════════════════════════════════════════════════════════════
   ⑤ 变异自检：把旧实现的判定**原样复刻**，证明上面 ① 的断言确实能抓到它
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ⑤ 变异自检（旧实现的死锁必须被检出）──");
{
  /** 旧 useUserFix.ts:236-245 的判定（20s + 句柄为 null 直接 return） */
  const oldPlan = (o: typeof base): GeoRecoveryPlan => {
    if (!o.started) return "none";
    if (!o.hasWatch) return "none"; // ★ 旧实现的致命早退
    if (o.permDenied) return "none";
    const anchor = Math.max(o.lastCbTs, o.dogBaseTs);
    return o.nowMs - anchor > 20_000 ? "rebuild" : "none";
  };
  const deadlock = { ...base, hasWatch: false, lastCbTs: NOW - 600 * S, visible: true };
  ok(oldPlan(deadlock) === "none", "[变异] 旧判定在「句柄为 null + 前台」时返回 none（死锁复现）");
  ok(geoRecoveryOf(deadlock) === "subscribe", "[变异] 新判定在同一输入下返回 subscribe（差异可检出）");

  const slow = { ...base, lastCbTs: NOW - 15 * S, dogBaseTs: NOW - 15 * S };
  ok(oldPlan(slow) === "none", "[变异] 旧判定 15s 无帧不动（要等 20s）");
  ok(geoRecoveryOf(slow) === "rebuild", "[变异] 新判定 15s 即重建（恢复速度提升可检出）");
}

/* ══════════════════════════════════════════════════════════════════════
   ⑥ 描述型（**不是守护型**）：`data-geo` 不能当作"卡住"的判据
      —— 这里把当前契约钉下来，避免有人拿 `data-geo !== "stale"` 当验收标准
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ⑥ 描述型：观测钩子能/不能证明什么 ──");
ok(
  geoStateOf({ lastCbTs: NOW - 600 * S, accuracyM: 200, errCode: null }, NOW) === "low_acc",
  "【当前行为】彻底停更 10 分钟但上帧精度 200m ⇒ data-geo 仍是 low_acc（不是 stale）",
);
ok(
  geoStateOf({ lastCbTs: NOW - 600 * S, accuracyM: 30, errCode: null }, NOW) === "stale",
  "【当前行为】精度 30m 且停更 10 分钟 ⇒ data-geo = stale",
);
console.log(
  "  ⚠️ 结论：data-geo 的 low_acc 优先于 stale ⇒ **「data-geo !== 'stale'」不能证明定位活着**；\n" +
    "     验收判据必须以 body[data-user-fix] 的 ts 是否**严格前进**为准（见 PR 报告 §5）。",
);

console.log(
  failed === 0
    ? "\n✅ 全通过（句柄 null 自愈 / 稳态 12s / 反风暴 / 门禁 / 变异自检 / 钩子能力边界）"
    : `\n❌ ${failed} 项失败`,
);
process.exit(failed === 0 ? 0 : 1);
