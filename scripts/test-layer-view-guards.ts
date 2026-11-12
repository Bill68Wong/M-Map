/**
 * 图层显隐静态门禁（scripts/test-layer-view-guards.ts，2026-11-11 · 发版补检查题）
 *
 * ── 守的是什么 ────────────────────────────────────────────────────────
 *   独立验收判定：33 段门禁对「需求 1 路线查看模式隐藏公厕」「需求 2 删地图下方中栏」
 *   **零覆盖**，属「无门禁保护的窄证明」。本脚本用静态结构断言把两条需求的落点锁住，
 *   并对「不要影响弹窗正常运作」这条红线设守护判据。
 *
 * ── 判据总数：共 20 条 ─────────────────────────────────────────────────
 *   19 条结构判据（A1~A6 / B7~B9 / C10~C14 / D15~D19）
 *   + 1 条分母自证 E20（注册数守恒 + 每条注册判据都实际产出 PASS/FAIL）。
 *   打印的「合计 N 条」直接取同一份注册表的长度 ⇒ 加了判据却没跑会立刻显形。
 *
 * ── 防假绿口径 ────────────────────────────────────────────────────────
 *   · 只读磁盘上的真实源码；不 import 生产模块、不连库、不跑被测脚本。
 *   · 用结构正则 +「必须含 / 必须不含」双向判据，**不硬编码整行快照做相等比较**
 *     （那样「名字对、值错」也会绿）。
 *   · 文件不存在 / 读不到 ⇒ 内容按空处理，相关判据默认失败，不跳过。
 *   · 每条失败信息都带具体文件路径与「缺了什么」，便于分诊。
 *
 * 跑法：npm run test:layer-view-guards（在 verify 链末尾，第 34 段）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 相对路径集中登记：失败信息直接引用这里，避免各处拼错路径 */
const F = {
  navShell: "src/components/nav/NavShell.tsx",
  navMap: "src/components/nav/NavMap.tsx",
  toiletLayer: "src/components/nav/PublicToiletLayer.tsx",
  brandBar: "src/components/nav/NavBrandBar.tsx",
  stopsSheet: "src/components/nav/RouteStopsSheet.tsx",
  useVehicles: "src/components/nav/useRouteVehicles.ts",
} as const;

type FileKey = keyof typeof F;

/** 结构判据的期望数量（不含分母自证 E20 本身） */
const STRUCTURAL_EXPECTED = 19;

let pass = 0;
let fail = 0;
/** 每条判据执行时登记一次，用于分母自证 */
const registered: string[] = [];

const cache = new Map<FileKey, string>();

/** 读不到 = 空串，相关判据默认失败；同时在 stderr 留一条诊断，不跳过、不 exit(0) */
function srcOf(key: FileKey): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let text = "";
  try {
    text = readFileSync(path.join(ROOT, F[key]), "utf8");
  } catch (e) {
    console.error(`  NOTE  ${F[key]} 读取失败（${e instanceof Error ? e.message : String(e)}），相关判据默认判失败`);
  }
  cache.set(key, text);
  return text;
}

/** 取第一条命中结构的行；没有命中返回空串（由调用方的「必须含」判据判红） */
function lineOf(text: string, re: RegExp): string {
  return text.split(/\r?\n/).find((l) => re.test(l)) ?? "";
}

/**
 * 注册并执行一条判据。
 * @param id     判据编号（A1…E20），红行里带它便于定位
 * @param label  判据说明
 * @param cond   判据结果
 * @param detail 失败时的「文件路径 + 缺了什么」
 */
function check(id: string, label: string, cond: boolean, detail: string): void {
  registered.push(id);
  if (cond) {
    pass++;
    console.log(`  PASS  ${id}  ${label}`);
  } else {
    fail++;
    console.error(`  FAIL  ${id}  ${label}  →  ${detail}`);
  }
}

function main(): void {
  console.log("\n═══ 图层显隐静态门禁（需求 1 / 需求 2）═══\n");

  // ── A 组 · 公厕隐藏条件（6 条） ──
  const shell = srcOf("navShell");
  const showLine = lineOf(shell, /showToilets=\{/);
  const routeLine = lineOf(shell, /const routeViewOn\s*=/);

  check("A1", "showToilets 行含 !routeViewOn（路线查看模式隐藏门）", /!routeViewOn/.test(showLine),
    `${F.navShell} 的 showToilets= 行缺 '!routeViewOn'（或该行不存在）`);
  check("A2", "showToilets 行同时保留 layers.prefs.toilet 与 navPhase === \"off\"（既有两道门未被替换）",
    /layers\.prefs\.toilet/.test(showLine) && /navPhase === "off"/.test(showLine),
    `${F.navShell} 的 showToilets= 行缺 'layers.prefs.toilet' 或 'navPhase === "off"'`);
  check("A3", "routeViewOn 定义行含 !!rv.picked 与 !!tqhTrip（两种路线查看态都在内）",
    /!!rv\.picked/.test(routeLine) && /!!tqhTrip/.test(routeLine),
    `${F.navShell} 的 const routeViewOn 行缺 '!!rv.picked' 或 '!!tqhTrip'（或该行不存在）`);
  check("A4", "routeViewOn 定义行不得含 lineSheet（选线弹窗不算路线查看模式）",
    routeLine.length > 0 && !/lineSheet/.test(routeLine),
    `${F.navShell} 的 const routeViewOn 行出现了 'lineSheet'，或该行不存在`);
  check("A5", "routeViewOn 定义行不得含 stopsSheetOn（会抖动且不含通琴号）",
    routeLine.length > 0 && !/stopsSheetOn/.test(routeLine),
    `${F.navShell} 的 const routeViewOn 行出现了 'stopsSheetOn'，或该行不存在`);
  check("A6", "navPhase 五值联合类型字面量仍在（防改写相位定义影响下游）",
    /const navPhase:\s*"off"\s*\|\s*"recommend"\s*\|\s*"detail"\s*\|\s*"walk"\s*\|\s*"riding"/.test(shell),
    `${F.navShell} 缺 'const navPhase: "off" | "recommend" | "detail" | "walk" | "riding"' 结构`);

  // ── B 组 · 下游清理链路（3 条） ──
  const navMap = srcOf("navMap");
  check("B7", "NavMap 的 enabled= 行含 showToilets（绘制门仍接同一开关）",
    /enabled=\{[^}]*\bshowToilets\b/.test(navMap),
    `${F.navMap} 的 enabled= 结构缺 'showToilets'`);
  check("B8", "NavMap 的 active= 行含 showToilets（加载门仍接同一开关）",
    /active=\{[^}]*\bshowToilets\b/.test(navMap),
    `${F.navMap} 的 active= 结构缺 'showToilets'`);

  const layer = srcOf("toiletLayer");
  const hasRemove = /map\.remove\(/.test(layer);
  const hasEnabledDep = /},\s*\[[^\]]*\benabled\b[^\]]*\]\s*\)/.test(layer);
  check("B9", "PublicToiletLayer 清理函数含 map.remove 且 effect 依赖数组含 enabled（关闭时引脚会被清掉）",
    hasRemove && hasEnabledDep,
    `${F.toiletLayer} 缺 ${!hasRemove ? "map.remove( 调用" : ""}${!hasRemove && !hasEnabledDep ? " 与 " : ""}${!hasEnabledDep ? "依赖数组中的 enabled" : ""}`);

  // ── C 组 · 中栏删除完整性（5 条，全部「必须不含」） ──
  const bar = srcOf("brandBar");
  const banned: { id: string; label: string; re: RegExp; what: string }[] = [
    { id: "C10", label: "NavBrandBar 不含 nav-linechip", re: /nav-linechip/, what: "'nav-linechip'" },
    { id: "C11", label: "NavBrandBar 不含 nav-rev", re: /nav-rev/, what: "'nav-rev'" },
    { id: "C12", label: "NavBrandBar 不含 nav-brandbar__mid", re: /nav-brandbar__mid/, what: "'nav-brandbar__mid'" },
    { id: "C13", label: "NavBrandBar 不含 nav-brandbar__left", re: /nav-brandbar__left/, what: "'nav-brandbar__left'" },
    { id: "C14", label: "NavBrandBar 不含 onOpenAllStops / data-open-all-stops",
      re: /onOpenAllStops|data-open-all-stops/, what: "'onOpenAllStops' 或 'data-open-all-stops'" },
  ];
  for (const b of banned) {
    check(b.id, b.label, bar.length > 0 && !b.re.test(bar),
      `${F.brandBar} 文件为空/读不到，或仍含有 ${b.what}`);
  }

  // ── D 组 · 弹窗功能守护（5 条） ──
  check("D15", "NavShell 保留 onClose={rv.exitLine}（站序弹窗关闭链）",
    /onClose=\{rv\.exitLine\}/.test(shell),
    `${F.navShell} 缺 'onClose={rv.exitLine}'`);
  check("D16", "NavShell 保留 onFlipDirection={rv.canReverse（站序弹窗换向链）",
    /onFlipDirection=\{rv\.canReverse/.test(shell),
    `${F.navShell} 缺 'onFlipDirection={rv.canReverse'`);

  const sheet = srcOf("stopsSheet");
  check("D17", "RouteStopsSheet 保留 data-role=\"close\"（关闭键观测钩子）",
    /data-role="close"/.test(sheet),
    `${F.stopsSheet} 缺 'data-role="close"'`);
  check("D18", "RouteStopsSheet 保留 chipText（线路名展示）",
    /\bchipText\b/.test(sheet),
    `${F.stopsSheet} 缺 'chipText'`);

  const vehicles = srcOf("useVehicles");
  check("D19", "useRouteVehicles 保留 reverse 与 exitLine 定义（防连坐删）",
    /const reverse\s*=\s*useCallback/.test(vehicles) && /const exitLine\s*=\s*useCallback/.test(vehicles),
    `${F.useVehicles} 缺 'const reverse = useCallback' 或 'const exitLine = useCallback'`);

  // ── E 组 · 分母自证（1 条） ──
  const structuralCount = registered.length;
  check("E20", "分母守恒：19 条结构判据全部注册，且每条注册判据都实际产出 PASS/FAIL",
    structuralCount === STRUCTURAL_EXPECTED && pass + fail === structuralCount,
    `结构判据注册数 ${structuralCount} ≠ 期望 ${STRUCTURAL_EXPECTED}，或 pass+fail=${pass + fail} ≠ 注册数 ${structuralCount}`);

  console.log(`\n═══ 合计 ${registered.length} 条：PASS ${pass} / FAIL ${fail} ═══`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
