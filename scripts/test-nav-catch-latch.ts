/**
 * 「人确实在车上」判定的回归（scripts/test-nav-catch-latch.ts，★ 2026-11-05 新增）
 *
 * ── 这个文件守什么 ─────────────────────────────────────────────────────
 *   2026-11-05 起 `riding` 的语义从「人已在车上」变成「车到了」（车停靠上车站即切 riding）。
 *   赶车标签的可见性与信息行形态**必须**按「人确实在车上」判，而不是按「进入 riding」判。
 *   判定收在 `src/components/nav/riding-real.ts#ridingRealOf`（纯函数，本文件直接 import，
 *   断言的就是线上那一份 —— 不复刻）。
 *
 * ── 为什么单独一个文件（而不是塞进 test-nav-info-consistency.ts）──────────
 *   后者当时正被另一路收口（候选车牌渲染层），且那部分随后被负责人裁决撤除。
 *   本判定与信息行形态**正交**（不依赖候选车牌），独立成文件后两边互不牵连。
 *
 * ── 跑法 ──────────────────────────────────────────────────────────────
 *   npx tsx scripts/test-nav-catch-latch.ts
 */
import { readFileSync } from "node:fs";
import { ridingRealOf } from "../src/components/nav/riding-real";

let failed = 0;
const ok = (cond: boolean, name: string, detail = ""): void => {
  if (cond) console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};

/* ══════════════════════════════════════════════════════════════════════
   ① 判据表（唯一，不接受第二种解释）
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ① ridingRealOf 判据表 ──");
{
  ok(
    ridingRealOf({ phase: "station" as never, entry: "station", posEvidence: false }) === false,
    "前置自检：phase 不是 riding 时一律 false（用非法值确认 Guard 先于 entry 判断）",
  );

  ok(
    ridingRealOf({ phase: "riding", entry: "station", posEvidence: false }) === false,
    "★ 核心：车到站切入（station）且**无**位置证据 ⇒ **false**（人在跑，标签必须保留）",
  );
  ok(
    ridingRealOf({ phase: "riding", entry: "station", posEvidence: true }) === true,
    "车到站切入 + 位置证据已到 ⇒ true（可以隐藏）",
  );
  ok(
    ridingRealOf({ phase: "riding", entry: "position", posEvidence: false }) === true,
    "位置判据切入（position）⇒ true（进入本身即证据，不等 posEvidence）",
  );
  ok(
    ridingRealOf({ phase: "riding", entry: "manual", posEvidence: false }) === true,
    "手动「我已上车」（manual）⇒ true（用户本人断言，视同证据充分）",
  );

  ok(
    ridingRealOf({ phase: "off", entry: null, posEvidence: false }) === false &&
      ridingRealOf({ phase: "boarding", entry: null, posEvidence: false }) === false &&
      ridingRealOf({ phase: "done", entry: null, posEvidence: false }) === false,
    "非 riding 三相（off / boarding / done）一律 false",
  );

  /**
   * 防御分支：`riding` 却没有进入方式（`null`/`undefined`）。
   * 退回**旧行为（true = 隐藏）**，理由见 `riding-real.ts` 的注释：
   *   选「不隐藏」时，一旦某条进入路径漏写进入方式，标签会**永久滞留**（比缺陷 #2 更难发现）。
   * ⚠️ 这条是"选了哪个方向"，不是"哪个方向正确"——所以注释必须写清理由，否则后人会想改。
   */
  ok(
    ridingRealOf({ phase: "riding", entry: null, posEvidence: false }) === true &&
      ridingRealOf({ phase: "riding", entry: undefined, posEvidence: false }) === true,
    "防御：riding 但进入方式缺失 ⇒ 退回旧行为 true（隐藏），不新增滞留路径",
  );
}

/* ══════════════════════════════════════════════════════════════════════
   ② 变异自检（证明上面的判据不是恒值）
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ② 变异自检（判据必须能检出「只看 entering riding」这个诱惑）──");
{
  /** 错误实现：只看是否在 riding（= 本批要修的那个 bug 本身） */
  const naive = (i: { phase: string }) => i.phase === "riding";
  ok(
    naive({ phase: "riding" }) === true &&
      ridingRealOf({ phase: "riding", entry: "station", posEvidence: false }) === false,
    "[变异] 「只看 entering riding」与正确判据在 station+无证据 时**结论相反** ⇒ 可检出",
  );
  ok(
    naive({ phase: "riding" }) === ridingRealOf({ phase: "riding", entry: "position", posEvidence: false }),
    "[变异] 但在 position 进入时两者同值 ⇒ 说明**只改这一种情况测不出来**（所以必须穷举四种进入方式）",
  );
}

/* ══════════════════════════════════════════════════════════════════════
   ③ 接线锁：两个调用点必须都走同一个判据（防"只改一处"复发）
   ──────────────────────────────────────────────────────────────────────
   本批真实踩过的坑：只改锁存、没改 `infoMode` ⇒ 车到站那帧 `infoMode` 仍无条件变 post，
   标签照样消失（而赶车标签就住在 pre 分支里）。
   ⇒ 收两条源码形状锁：两处都必须出现 `ridingRealOf(`。
   ⚠️ 源码字符串断言**必须先剥注释**（本项目的既有教训：注释里会出现同一个词，
      不剥会把"注释怎么写"当成"代码做什么"）。
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ③ 接线锁（两处必须共用同一判据）──");
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const navShell = strip(readFileSync("src/components/nav/NavShell.tsx", "utf8"));
  const navDetail = strip(readFileSync("src/components/nav/NavDetailBody.tsx", "utf8"));

  ok(navShell.includes("ridingRealOfRide("), "接线①：NavShell（锁存）走 `ridingRealOf`");
  ok(navDetail.includes("ridingRealOfRide("), "接线②：NavDetailBody（infoMode）走 `ridingRealOf`");
  /**
   * 反向守卫：`infoMode` 里**不得**再直接写 `riding ?` ——
   * 那就是"无条件优先"的老写法，一旦回退，标签会在车到站那帧消失且没人发现。
   */
  ok(
    !/const infoMode[^\n]*=\s*riding\s*\?/.test(navDetail),
    "接线③：`infoMode` 不得退回「`riding ?` 无条件优先」的老写法",
  );
}

console.log(
  failed === 0
    ? "\n✅ 全通过（ridingReal 判据表 / 变异自检 / 两处接线锁）"
    : `\n❌ ${failed} 项失败`,
);
process.exit(failed === 0 ? 0 : 1);
