/**
 * 搜索缓存「跨位置重算」门禁（scripts/test-poi-cache-rescore.ts · 2026-11-13）
 *
 * ── 守的是什么 ────────────────────────────────────────────────────────
 *   进程内搜索缓存原来把 `PoiSearchResult[]` 整个存下来，而其中的 `distM` / `score`
 *   是按**下单那一刻的用户位置**预算好的 ⇒ 在关闸搜「议事亭前地」得到 2601m，
 *   走到氹仔（真实 5706m）再搜同一个词，命中缓存后仍显示 2601m，排序也还是关闸的位置。
 *
 *   修法：缓存只存「裸 POI + 位置无关分 `relBase`」，命中后按当前位置重算。
 *   本脚本锁死四件事：
 *     ① 距离确实按**当前**位置重算（跨位置不再串味）；
 *     ② 分数 = 位置无关分 + 当前距离加成，且随距离单调下降；
 *     ③ 调用方没给位置时 `distM` **清零**，不得沿用他处算出的旧值；
 *     ④ 同位置往返精确还原（写入拆分与命中重算是同一公式的可逆对），
 *        且重算不改写缓存里的裸对象。
 *
 * ── 为什么必须断言 ③ ──────────────────────────────────────────────────
 *   `opts.userPos` 是可选的：前端在未定位时会不传。此时若沿用缓存里的 `distM`，
 *   结果会凭空出现一个「距离 5706 米」但没有位置的排序依据，比不显示更糟。
 *
 * 全离线，0 高德配额。
 */
import { haversineM } from "../src/lib/amap/coord";
import { dirProxBonus } from "../src/lib/amap/poi";
import { rescoreCachedRows, toCachedRows } from "../src/lib/nav/poi-search";
import type { PoiSearchResult } from "../src/lib/nav/types";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log("  PASS  " + msg);
  } else {
    fail++;
    console.error("  FAIL  " + msg);
  }
}

/** 关闸（M1 附近）与氹仔码头 —— 两点相距约 6km，足以暴露串味 */
const AT_BORDER = { lat: 22.2153, lng: 113.5491 };
const AT_TAIPA = { lat: 22.163, lng: 113.559 };
/** 议事亭前地（澳门半岛中心） */
const MAISON = { lat: 22.19349, lng: 113.53945 };

const mk = (
  name: string,
  ll: { lat: number; lng: number },
  distM: number | undefined,
  score: number,
): PoiSearchResult => ({
  source: "amap-text",
  name,
  lng: ll.lng,
  lat: ll.lat,
  kind: "poi",
  distM,
  score,
});

console.log("═══ 搜索缓存：跨位置重算（全离线，0 高德配额）═══\n");

// ── ① 跨位置：同一个词，两个位置的距离必须各自正确 ──────────────────────
console.log("── ① 跨位置不再串味 ──");
const d1 = Math.round(haversineM(AT_BORDER, MAISON));
const atBorderResult = mk("议事亭前地", MAISON, d1, 900 + dirProxBonus(d1));
const rows = toCachedRows([atBorderResult]);

const r1 = rescoreCachedRows(rows, AT_BORDER);
const r2 = rescoreCachedRows(rows, AT_TAIPA);
/** 期望值由坐标实算得出，不写死量级 —— 坐标一改，断言自动跟着走 */
const expectFromTaipa = Math.round(haversineM(AT_TAIPA, MAISON));

assert(r1[0].distM === d1, `关闸：沿用同一位置重算后 distM 不变（${r1[0].distM}）`);
assert(
  r2[0].distM === expectFromTaipa,
  `氹仔：等于按该坐标实算的直线距离（${r2[0].distM} / 期望 ${expectFromTaipa}）`,
);
assert(
  (r2[0].distM ?? 0) > (r1[0].distM ?? 0) * 1.4,
  `氹仔距离显著大于关闸（${r2[0].distM} vs ${r1[0].distM}）`,
);

// ── ② 分数 = 位置无关分 + 当前距离加成 ────────────────────────────────
console.log("\n── ② 分数随当前位置变化 ──");
assert(r1[0].score > r2[0].score, `关闸更近 ⇒ 分数更高（${r1[0].score} > ${r2[0].score}）`);
assert(
  Math.abs(r1[0].score - r2[0].score - (dirProxBonus(d1) - dirProxBonus(r2[0].distM))) < 1e-9,
  "两次分数差 = 两次距离加成之差（同一 relBase，无其他项参与）",
);
assert(r1[0].name === "议事亭前地", "名称等位置无关字段原样保留");

// ── ③ 无位置：distM 必须清零，不得沿用旧值 ────────────────────────────
console.log("\n── ③ 未传位置时不残留旧距离 ──");
const r3 = rescoreCachedRows(rows);
assert(r3[0].distM === undefined, `无 userPos ⇒ distM 为 undefined（实际 ${String(r3[0].distM)}）`);
assert(
  r3[0].score === atBorderResult.score - dirProxBonus(d1),
  "无位置时不加距离加成（分数回落到 relBase）",
);

// ── ④ 排序随位置翻转 ─────────────────────────────────────────────────
console.log("\n── ④ 排序按当前位置重排 ──");
/** A 贴着关闸、B 贴着氹仔；两者 relBase 相同 ⇒ 排序完全由距离决定 */
const nearBorder = { lat: AT_BORDER.lat + 0.0009, lng: AT_BORDER.lng }; // 约 100m
const nearTaipa = { lat: AT_TAIPA.lat + 0.0009, lng: AT_TAIPA.lng };
const dA = Math.round(haversineM(AT_BORDER, nearBorder));
const dB = Math.round(haversineM(AT_BORDER, nearTaipa));
const twoRows = toCachedRows([
  mk("A 关闸旁", nearBorder, dA, 500 + dirProxBonus(dA)),
  mk("B 氹仔旁", nearTaipa, dB, 500 + dirProxBonus(dB)),
]);
const orderAtBorder = rescoreCachedRows(twoRows, AT_BORDER).map((r) => r.name);
const orderAtTaipa = rescoreCachedRows(twoRows, AT_TAIPA).map((r) => r.name);
assert(orderAtBorder[0] === "A 关闸旁", `关闸侧排序：A 在前（${orderAtBorder.join(" / ")}）`);
assert(orderAtTaipa[0] === "B 氹仔旁", `氹仔侧排序：B 在前（${orderAtTaipa.join(" / ")}）`);

// ── ⑤ 同位置往返精确还原 + 不改写缓存 ────────────────────────────────
console.log("\n── ⑤ 往返一致性与缓存不被改写 ──");
const back = rescoreCachedRows(rows, AT_BORDER);
assert(back[0].score === atBorderResult.score, "同位置重算 ⇒ 分数与写入时完全一致（可逆）");
assert(rows[0].poi.distM === d1, "重算不改写缓存里的裸对象（distM 仍是写入时的值）");
const x1 = JSON.stringify(rescoreCachedRows(twoRows, AT_TAIPA));
const x2 = JSON.stringify(rescoreCachedRows(twoRows, AT_TAIPA));
assert(x1 === x2, "同一输入连续两次重算结果一致（幂等）");
assert(rescoreCachedRows([], AT_BORDER).length === 0, "空缓存行 ⇒ 空结果，不抛错");

console.log(`\n═══ 合计 ${pass + fail} 条：PASS ${pass} / FAIL ${fail} ═══`);
console.log(fail === 0 ? "✅ 全部通过" : "❌ 有失败");
process.exit(fail === 0 ? 0 : 1);
