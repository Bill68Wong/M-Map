/**
 * 搜索「澳门严格限定」门禁（scripts/test-poi-macau-filter.ts · 2026-11-12）
 *
 * ── 守的是什么 ────────────────────────────────────────────────────────
 *   本应用**只服务澳门**：搜索下拉里不允许出现其他城市/地区的结果。
 *   准入判据集中在 `src/lib/amap/poi.ts#classifyMacau`（三分类：macau / foreign / unknown），
 *   `toResults`（高德归一）与 `poi-search#filterMacau`（合并前二次过滤）**共用同一函数**。
 *   本脚本锁死三件事：
 *     ① 三分类的**边界**（谁留、谁剔、谁算归属不明）；
 *     ② 过滤记账**不重不漏**（`total = kept + foreign + unknown + noCoord`，且样本有界）；
 *     ③ 两道闸的**幂等性**（`filterMacau` 不重复计数，否则报告里的「过滤条数」会翻倍）。
 *
 * ── 为什么必须断言「无任何地理标识 ⇒ unknown」────────────────────────────
 *   旧口径对这类条目是**保留**（注释理由："避免误杀"），但它同时是唯一能让非澳门条目
 *   穿过 adcode 闸门的形态。实测依据（2026-11-12）：
 *     · 10 个澳门本地词 × (place/text + inputtips) 共 288 条结果，**无 adcode 者 0 条**
 *       ⇒ 被"避免误杀"保护的对象是空集；
 *     · `inputtips("珠机城轨")` 恰好返回 adcode/district 全空的裸条目。
 *   ⇒ 翻转成「隐藏」既不放走脏条目，也不误杀真澳门结果。
 *
 * ── 反向自证（手工做，不入断言）────────────────────────────────────────
 *   把 `classifyMacau` 的 `no_signal` 分支改成 `{verdict:"macau"}`，下面第 ③、⑤ 组必红；
 *   把 `toResults` 里 `stats.foreign++` 删掉，第 ⑤ 组必红。
 *
 * 运行：npm run test:poi-macau（已入 `verify` 链）
 */
import {
  classifyMacau,
  isMacauRow,
  isNameCityConflict,
  newPoiFilterStats,
  tipsToResults,
  type AmapTip,
} from "../src/lib/amap/poi";
import { filterMacau } from "../src/lib/nav/poi-search";
import { POI_FILTER_SAMPLE_MAX, type PoiSearchResult } from "../src/lib/nav/types";

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

type Row = Parameters<typeof classifyMacau>[0];
const verdict = (o: Row) => classifyMacau(o).verdict;
const reason = (o: Row) => classifyMacau(o).reason;

console.log("═══ 搜索地区过滤：澳门严格限定（全离线，0 高德配额）═══\n");

// ── ① adcode 闸门：澳门 820000 + 8 个下辖区放行，邻市出局 ────────────────
console.log("── ① adcode 闸门 ──");
assert(verdict({ name: "新葡京", adcode: "820000" }) === "macau", "820000（澳门省级）⇒ macau");
for (const d of ["820001", "820002", "820003", "820004", "820005", "820006", "820007", "820008"]) {
  assert(verdict({ name: "某地点", adcode: d }) === "macau", `${d}（澳门辖区）⇒ macau`);
}
assert(verdict({ name: "珠海长隆海洋王国", adcode: "440402" }) === "foreign", "440402（珠海）⇒ foreign");
assert(verdict({ name: "某地点", adcode: "442000" }) === "foreign", "442000（中山）⇒ foreign");
assert(verdict({ name: "某地点", adcode: "440100" }) === "foreign", "440100（广州）⇒ foreign");
assert(verdict({ name: "某地点", adcode: "810000" }) === "foreign", "810000（香港）⇒ foreign");
assert(reason({ name: "某地点", adcode: "440402" }) === "adcode_foreign", "依据应标为 adcode_foreign");
assert(reason({ name: "某地点", adcode: "820003" }) === "adcode_macau", "依据应标为 adcode_macau");

// ── ② 名称判据：境外线路名无条件出局；城市名前缀**只在无 adcode 时**生效 ──────
console.log("\n── ② 名称判据（★ adcode 优先，城市名前缀不得凌驾属地）──");
assert(
  verdict({ name: "珠机城轨" }) === "foreign" && reason({ name: "珠机城轨" }) === "name_foreign",
  "「珠机城轨」裸条目（无 adcode）⇒ foreign / name_foreign",
);
assert(verdict({ name: "广珠城际", adcode: "820000" }) === "foreign", "「广珠城际」即使 adcode 澳门 ⇒ foreign（线路名凌驾 adcode）");
assert(verdict({ name: "广深港高铁", adcode: "820002" }) === "foreign", "「广深港高铁」⇒ foreign");
assert(verdict({ name: "珠海长隆海洋王国", adcode: "440402" }) === "foreign", "「珠海长隆…」adcode 440402 ⇒ foreign");
assert(
  verdict({ name: "珠海海洋王国度假酒店", adcode: "820002", district: "花王堂区" }) === "macau",
  "「珠海海洋王国度假酒店」adcode 820002 ⇒ macau（实测坐标 113.55095,22.19823 在澳门半岛）",
);
assert(
  isNameCityConflict({ name: "珠海海洋王国度假酒店" }) && !isNameCityConflict({ name: "澳門半島酒店" }),
  "名称冲突检测：仅名称像外地时才标注（属地仍按 adcode 判澳门）",
);

// ★ 回归防线：这些**全是澳门本地店**，店名带外地字样，绝不能因为名字被删
console.log("\n── ②-b 澳门本地「外市字样」店铺不得误杀（实测样本）──");
const localWithForeignName: [string, string][] = [
  ["中山新村", "820005"],
  ["中山车行", "820005"],
  ["中山美食(台山中街)", "820001"],
  ["广州街", "820004"],
  ["广州酒家(华富大厦店)", "820005"],
  ["香港佳佳甜品(氹仔店)", "820006"],
  ["香港通讯", "820005"],
];
for (const [n, ad] of localWithForeignName) {
  assert(verdict({ name: n, adcode: ad }) === "macau", `「${n}」（adcode ${ad}，澳门本地店）⇒ macau，不误杀`);
}
assert(verdict({ name: "中山新村" }) === "foreign", "同名但**无 adcode** ⇒ foreign（名称兜底仍生效）");
assert(verdict({ name: "澳門半島酒店", adcode: "820001" }) === "macau", "「澳門…」正常放行（不误伤本地名）");

// ── ③ 无 adcode 兜底：行政区文字含「澳」放行；有外地文字 ⇒ foreign；全空 ⇒ unknown ──
console.log("\n── ③ 无 adcode 兜底（★ 2026-11-12 由「保留」翻转为「隐藏」）──");
assert(verdict({ name: "某站", district: "澳门特别行政区风顺堂区" }) === "macau", "district 含「澳」⇒ macau");
assert(verdict({ name: "某店", cityname: "澳门特别行政区" }) === "macau", "cityname 含「澳」⇒ macau");
assert(verdict({ name: "Macau Tower", district: "Macau" }) === "macau", "district=Macau ⇒ macau");
assert(reason({ name: "某站", district: "澳门特别行政区" }) === "text_macau", "依据应标为 text_macau");
assert(verdict({ name: "某地点" }) === "unknown", "无 adcode 且无行政区文字 ⇒ unknown（旧口径会保留）");
assert(reason({ name: "某地点" }) === "no_signal", "依据应标为 no_signal");
assert(verdict({ name: "某地点", district: "珠海市香洲区" }) === "foreign", "district=珠海 ⇒ foreign");
assert(reason({ name: "某地点", district: "珠海市香洲区" }) === "text_foreign", "依据应标为 text_foreign");
assert(isMacauRow({ name: "某地点" }) === false, "布尔兼容层：unknown 不得被当成澳门放行");

// ── ④ 与 filterMacau 口径一致（两处同源，不允许漂移）────────────────────
console.log("\n── ④ toResults / filterMacau 同源一致性 ──");
const mk = (name: string, adcode?: string, district?: string): PoiSearchResult => ({
  source: "amap-text",
  name,
  adcode,
  district,
  lng: 113.55,
  lat: 22.19,
  kind: "poi",
  // 与坐标同算可得；本脚本只关心地区分类，距离固定值即可（`distM` 自 2026-11-13 起必填，无距离用 null）
  distM: null,
  score: 100,
});
const fixture = [
  mk("澳門新葡京", "820001"),
  mk("珠海长隆", "440402"),
  mk("珠海海洋王国度假酒店", "820002"),
  mk("珠机城轨"),
  mk("无标识条目"),
  mk("某站", undefined, "澳门特别行政区大堂区"),
];
const kept = filterMacau(fixture).map((r) => r.name);
assert(kept.length === 3, `filterMacau 只保留 3 条（实际 ${kept.length} 条：${kept.join(" / ")}）`);
assert(kept.includes("澳門新葡京"), "保留澳门本地条目");
assert(kept.includes("某站"), "保留「无 adcode 但 district 含澳」条目");
assert(kept.includes("珠海海洋王国度假酒店"), "保留 adcode 属澳门的条目（名称冲突≠非澳门，只标注）");
assert(!kept.includes("珠海长隆"), "剔除珠海条目");
assert(!kept.includes("珠机城轨"), "剔除境外线路名条目");
assert(!kept.includes("无标识条目"), "剔除无任何地理标识的条目");
for (const r of fixture) {
  assert(
    (filterMacau([r]).length === 1) === (classifyMacau(r).verdict === "macau"),
    `filterMacau 与 classifyMacau 判定一致：「${r.name}」`,
  );
}

// ── ⑤ 过滤记账：total = kept + foreign + unknown + noCoord，且样本有界 ────
console.log("\n── ⑤ 过滤记账（报告不重不漏）──");
// 造 1 组覆盖五种去向的原始行：澳门 1 条 / 名称冲突但属澳门 1 条 / 非澳门 3 条 / 无坐标 1 条
const rawTips: AmapTip[] = [
  { name: "澳門新葡京", adcode: "820001", location: "113.543,22.190" },
  { name: "珠海海洋王国度假酒店", adcode: "820002", location: "113.55095,22.19823" },
  { name: "珠海长隆海洋王国", adcode: "440402", location: "113.535,22.110" },
  // 名称**不**以城市开头、只靠 adcode 判非澳门的形态（验证 adcode_foreign 分支也会进样本）
  { name: "长隆海洋王国", adcode: "440402", location: "113.535,22.110" },
  { name: "珠机城轨" },
  { name: "某无形地点", adcode: "820003" }, // 有 adcode 澳门、但无坐标
];
const stats = newPoiFilterStats();
const out = tipsToResults(rawTips, { source: "amap-inputtips", query: "新葡京", stats });
assert(stats.total === 6, `total 应为 6（实际 ${stats.total}）`);
assert(stats.kept === 2, `kept 应为 2（实际 ${stats.kept}）`);
assert(stats.foreign === 3, `foreign 应为 3（实际 ${stats.foreign}）`);
assert(stats.unknown === 0, `unknown 应为 0（实际 ${stats.unknown}）`);
assert(stats.noCoord === 1, `noCoord 应为 1（实际 ${stats.noCoord}），且不得与 foreign 混计`);
assert(
  stats.total === stats.kept + stats.foreign + stats.unknown + stats.noCoord,
  "total 必须等于 kept + foreign + unknown + noCoord（不重不漏）",
);
assert(out.length === 2, "返回值结构不变：只给保留项（含名称冲突条目）");
assert(
  stats.samples.length === 3 && stats.samples.every((s) => s.verdict === "foreign"),
  "剔除样本应记录 3 条，且 verdict 标 foreign",
);
assert(
  stats.samples.some((s) => s.reason === "name_foreign") && stats.samples.some((s) => s.reason === "adcode_foreign"),
  "样本应带判定依据（name_foreign / adcode_foreign 两种都要有）",
);
assert(
  stats.suspects.length === 1 &&
    stats.suspects[0].name === "珠海海洋王国度假酒店" &&
    stats.suspects[0].verdict === "suspect" &&
    stats.suspects[0].reason === "name_conflict",
  "名称与属地冲突的条目**保留**但进 suspects（供人工确认）",
);
assert(
  !stats.samples.some((s) => s.name === "珠海海洋王国度假酒店"),
  "冲突条目不得同时出现在剔除样本里（保留与剔除互斥）",
);

// 归属不明必须被**标注**（能核对），而不是静悄悄消失
const st2 = newPoiFilterStats();
tipsToResults([{ name: "某裸地点", location: "113.55,22.19" }], { source: "amap-inputtips", stats: st2 });
assert(st2.unknown === 1, "无任何地理标识、但有坐标 ⇒ 计入 unknown");
assert(
  st2.samples.length === 1 && st2.samples[0].verdict === "unknown" && st2.samples[0].reason === "no_signal",
  "归属不明条目必须出现在样本里（带 reason=no_signal），供人工确认",
);

// 样本有界：不能因为结果多就把响应撑大
const many: AmapTip[] = Array.from({ length: POI_FILTER_SAMPLE_MAX + 8 }, (_, i) => ({
  name: `珠海某处${i}`,
  adcode: "440402",
  location: "113.55,22.19",
}));
const st3 = newPoiFilterStats();
tipsToResults(many, { source: "amap-text", stats: st3 });
assert(st3.foreign === many.length, `计数不封顶：${many.length} 条全计入（实际 ${st3.foreign}）`);
assert(
  st3.samples.length === POI_FILTER_SAMPLE_MAX,
  `样本封顶 ${POI_FILTER_SAMPLE_MAX} 条（实际 ${st3.samples.length}）`,
);

// 幂等：第二道闸不得重复计数（否则报告的「过滤条数」会翻倍）
const idem = tipsToResults(rawTips, { source: "amap-text", stats: newPoiFilterStats() });
assert(filterMacau(idem).length === idem.length, "filterMacau 对已过闸结果不再剔除（幂等，不重复计数）");

console.log(`\n═══ 合计 ${pass + fail} 条：PASS ${pass} / FAIL ${fail} ═══`);
console.log(fail === 0 ? "✅ 全部通过" : "❌ 有失败");
process.exit(fail === 0 ? 0 : 1);
