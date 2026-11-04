/**
 * 一卡一个下车点（同线收敛 + 备选下车点）· 单测
 * （scripts/test-alight-converge.ts · 2026-11-04 · 需求 U9）
 *
 * ── 守的是什么 ────────────────────────────────────────────────────────
 *   ① 同一线路 + 同一上车站（主码）+ 同一下车站（主码）⇒ **最多 1 张卡**
 *      （原先 `[...new Set(...)]` 是字符串全等去重 ⇒ `C690/3`/`C690`/`C690/1` 各占一个名额）；
 *   ② 真正**不同**的下车点 ⇒ 各自 1 张卡（每个卡只有 1 个下车点），其余进详情页「另有 N 个下车点」；
 *   ③ 收敛**只在同一 route 内**：`25` 与 `25X` **视为两条线**（按完整线码，不是数字前缀），
 *      `25` 与 `26A` 跨线永不合并；
 *   ④ 代表站 === 该卡自己的 `rides[0].alight`（**不新增独立字段** ⇒ 结构上不可能「忘记同步 href」）；
 *   ⑤ 备选下车点上限 4（`ALIGHT_OTHERS_MAX`），且按主码去重、不跨线、不跨上车站。
 *
 * ⚠️ 断言里的「预期」是产品口径，不是「当前实现的输出」—— 禁止为变绿改预期。
 *
 * 运行：npm run test:alight-converge（= tsx scripts/test-alight-converge.ts）
 */
import type { OtherAlight, SeedLike } from "../src/lib/recommend/converge";
import { convergeByAlight, convergeKeyOf, otherAlightsOf } from "../src/lib/recommend/converge";
import { dedupeByMain } from "../src/lib/recommend/enumerate";
import { ALIGHT_OTHERS_MAX, RECOMMEND_LIMIT_DEFAULT } from "../src/lib/recommend/limits";
import { sortCards } from "../src/lib/recommend/model";
import type { RecommendCard } from "../src/lib/recommend/types";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    fail++;
    console.error("  ✗ " + msg);
  }
}
function assertEq<T>(got: T, want: T, msg: string) {
  assert(got === want, `${msg}（实际 ${String(got)} / 预期 ${String(want)}）`);
}

/** 造一张最小卡（收敛只读 `rides[0]` / `totalMin` / `walkIn.minutes`） */
function mkCard(planId: number, route: string, board: string, alight: string, totalMin: number, walkInMin = 6): RecommendCard {
  return {
    planId,
    totalMin,
    rides: [{ route, board, alight }],
    walkIn: { minutes: walkInMin },
  } as unknown as RecommendCard;
}

/** 造一条 seed（`otherAlightsOf` 只读 `planId` + `segments[0]`） */
function mkSeed(planId: number, route: string, board: string, alight: string): SeedLike {
  return { planId, segments: [{ route, board, alight }] };
}

const nameOf = new Map<string, string>([
  ["C690", "蝴蝶谷大馬路總站"],
  ["T363", "連貫公路/威尼斯人"],
  ["T367", "望德聖母灣馬路/連貫公路"],
  ["T999", "其他站"],
]);

console.log("一卡一个下车点 · 同线收敛与备选下车点单测\n");

// ── ① 同线同站（站台号不同）⇒ 1 张卡 ──
console.log("① 同线同站收敛");
{
  const a = mkCard(1, "25", "C690/1", "T363/1", 20);
  const b = mkCard(1, "25", "C690", "T363/2", 22);
  const c = mkCard(1, "25", "C690/3", "T363", 21);
  const out = convergeByAlight([a, b, c], "balanced");
  assertEq(out.length, 1, "同线同站（3 种站台写法）⇒ 收敛为 1 张卡");
  assertEq(convergeKeyOf(a), convergeKeyOf(b), "收敛键按主码归一（C690/1 ≡ C690，T363/1 ≡ T363）");
}

// ── ② 代表站选法（偏好三档）──
console.log("② 代表站选法");
{
  const quick = mkCard(1, "25", "C690/1", "T363/1", 20, 8);
  const near = mkCard(1, "25", "C690", "T363/2", 25, 3);
  const balanced = convergeByAlight([quick, near], "balanced");
  assertEq(balanced.length, 1, "balanced：仍只有 1 张");
  assertEq(balanced[0]!.totalMin, 20, "balanced ⇒ argmin(totalMin)（选 20 分那张）");
  const fewer = convergeByAlight([quick, near], "fewer_transfers");
  assertEq(fewer[0]!.totalMin, 20, "fewer_transfers ⇒ argmin(totalMin)");
  const lessWalk = convergeByAlight([quick, near], "less_walk");
  assertEq(lessWalk[0]!.walkIn.minutes, 3, "less_walk ⇒ argmin(walkMinutes)（选步行 3 分那张）");
}

// ── ③ 代表站 === rides[0].alight（结构性保证）──
console.log("③ 代表站必须就是该卡自己的 rides[0].alight");
{
  const out = convergeByAlight(
    [mkCard(1, "25", "C690/1", "T363/1", 20), mkCard(1, "25", "C690", "T363/2", 22)],
    "balanced",
  );
  const card = out[0]!;
  assertEq(card.rides[0]!.alight, "T363/1", "代表站 = 被选中那张卡的 rides[0].alight（不是另存字段）");
  assert(
    !Object.prototype.hasOwnProperty.call(card, "representativeAlight"),
    "卡片上**没有**新增「代表站」字段（用结构消灭「忘记同步 href」的复发路径）",
  );
}

// ── ④ 不同下车点 ⇒ 各自 1 张卡（一线两站 = 2 张，各只有 1 个下车点）──
console.log("④ 不同下车点不合并（一卡一个下车点）");
{
  const out = convergeByAlight(
    [mkCard(1, "25", "C690", "T363", 20), mkCard(1, "25", "C690", "T367", 23)],
    "balanced",
  );
  assertEq(out.length, 2, "同线但下车点不同 ⇒ 2 张卡");
  assert(
    out.every((c) => c.rides[0]!.alight === "T363" || c.rides[0]!.alight === "T367"),
    "两张卡各只带一个下车点",
  );
}

// ── ⑤ 跨线永不收敛 ──
console.log("⑤ 跨线边界");
{
  const out = convergeByAlight(
    [mkCard(1, "25", "C690", "T363", 20), mkCard(1, "25X", "C690", "T363", 21)],
    "balanced",
  );
  assertEq(out.length, 2, "25 与 25X **必须视为两条线**（按完整线码，不是数字前缀）⇒ 2 张卡");
  const out2 = convergeByAlight(
    [mkCard(1, "25", "C690", "T363", 20), mkCard(2, "26A", "C690", "T363", 22)],
    "balanced",
  );
  assertEq(out2.length, 2, "25 与 26A 跨线 ⇒ 2 张卡（收敛键带 route）");
}

// ── ⑥ 备选下车点（详情页「另有 N 个下车点」）──
console.log("⑥ 备选下车点");
{
  const seeds: SeedLike[] = [
    mkSeed(1, "25", "C690/1", "T363"),
    mkSeed(1, "25", "C690", "T367"), // 同一上车站（主码同）、不同下车点
    mkSeed(2, "25X", "C690", "T999"), // 跨线 ⇒ 不得混入
    mkSeed(1, "25", "T367", "T363"), // 不同上车站 ⇒ 不得混入
    mkSeed(1, "25", "C690/2", "T363/2"), // 与当前下车点主码相同 ⇒ 不得混入
  ];
  const others: OtherAlight[] = otherAlightsOf("25", "C690/1", "T363/1", seeds, nameOf);
  assertEq(others.length, 1, "备选只有 1 个（T367）：跨线/跨上车站/同站台写法全部排除");
  assertEq(others[0]!.code, "T367", "备选下车点 = T367");
  assertEq(others[0]!.label, "T367 望德聖母灣馬路/連貫公路", "备选展示文案 = 站码 + 站名");
  assertEq(others[0]!.planId, 1, "备选带上所属方案 id（详情页 URL 契约需要）");

  // 上限
  const many: SeedLike[] = ["T1", "T2", "T3", "T4", "T5", "T6"].map((a, i) => mkSeed(1, "25", "C690", a + (i + 100)));
  assertEq(many.length, 6, "构造 6 个不同下车点");
  assertEq(otherAlightsOf("25", "C690", "T363", many, nameOf).length, ALIGHT_OTHERS_MAX, "备选上限 = ALIGHT_OTHERS_MAX");
  assert(ALIGHT_OTHERS_MAX <= 4, "备选上限 ≤ 4（产品建议值，见 limits.ts）");
}

// ── ⑦ IMP7：收敛必须在 `slice(limit)` 之前 ──
console.log("⑦ IMP7 顺序：收敛 → sortCards → slice(limit)");
{
  const cards = [
    mkCard(1, "25", "C690/1", "T363/1", 20),
    mkCard(1, "25", "C690", "T363/2", 22),
    mkCard(1, "25X", "C690", "T363", 23),
  ];
  const out = convergeByAlight(cards, "balanced");
  assertEq(out.length, 2, "3 张候选 ⇒ 收敛后 2 张（被合并的那张不再占名额）");
  assert(out.length <= cards.length, "收敛后数量 ≤ 收敛前（先收敛再截前 N 才有效）");

  /**
   * ★ 验收判据（IMP7）：构造 8 张候选，其中 3 组是**同线同站重复**
   *   ⇒ 收敛后仍有 6 张 ⇒ `sortCards().slice(RECOMMEND_LIMIT_DEFAULT)` **必须取满 6 张**。
   * 反例（先 slice 再收敛）：slice(6) 会先拿到含重复的 6 张，收敛后只剩 4 张。
   */
  const dup = [
    // 三组「同线同站」重复（每组 2 张 ⇒ 收敛成 1 张）
    mkCard(1, "25", "C690/1", "T363/1", 20),
    mkCard(1, "25", "C690", "T363/2", 22),
    mkCard(2, "26A", "C690", "T363", 21),
    mkCard(2, "26A", "C690/1", "T363/1", 23),
    mkCard(3, "51A", "C690", "T374", 24),
    mkCard(3, "51A", "C690/2", "T374/1", 25),
    // 三张互不相同的单卡（保证收敛后仍有 6 个不同方案）
    mkCard(4, "MT4", "T360", "T400", 26),
    mkCard(5, "N2", "T360", "T401", 27),
    mkCard(6, "51", "C653", "T402", 28),
  ];
  assertEq(dup.length, 9, "夹具：9 张候选（3 组重复 + 3 张独有）⇒ 收敛后 6 个方案");
  const ordered = sortCards(convergeByAlight(dup, "balanced")).slice(0, RECOMMEND_LIMIT_DEFAULT);
  assertEq(ordered.length, 6, `收敛后 sortCards().slice(${RECOMMEND_LIMIT_DEFAULT}) 仍取满 ${RECOMMEND_LIMIT_DEFAULT} 张`);
  const keys = ordered.map(convergeKeyOf);
  assertEq(new Set(keys).size, keys.length, "取满的 6 张里没有收敛键重复");

  // 反例对照：先 slice 再收敛 ⇒ 取不满（证明这条断言真的能抓顺序错误）
  const wrong = convergeByAlight(sortCards(dup).slice(0, RECOMMEND_LIMIT_DEFAULT), "balanced");
  assert(
    wrong.length < RECOMMEND_LIMIT_DEFAULT,
    `反例对照：先 slice 再收敛只剩 ${wrong.length} 张（< ${RECOMMEND_LIMIT_DEFAULT}）⇒ 断言具备区分力`,
  );
}

// ── ⑧ IMP6：归一只用于键，展示值保留原始站台码 ──
console.log("⑧ IMP6 展示值不可抹平");
{
  assertEq(
    dedupeByMain(["C690", "C690/2"])[0]!,
    "C690/2",
    "去重后展示值 = 原始站台码 C690/2（**不得**抹平成 C690）",
  );
  assertEq(dedupeByMain(["C690/2", "C690"])[0]!, "C690/2", "顺序相反时同样保留 C690/2");
  assertEq(dedupeByMain(["C690/2", "C690/1"])[0]!, "C690/2", "两个都带站台号 ⇒ 稳定保留首个（C690/2）");
  const list = dedupeByMain(["C690/3", "C690", "C690/1", "T367", "T367/2"]);
  assertEq(list.length, 2, "5 个写法归一到 2 个物理站（C690 / T367）");
  assertEq(
    list.join(","),
    "C690/3,T367/2",
    "展示值保留各自**带站台号**的原始码（C690/3 / T367/2，不抹平成 C690 / T367）",
  );
  assertEq(dedupeByMain(["C690"]).length, 1, "无站台号时原样返回（不虚构站台号）");
}

console.log("\n" + (fail === 0 ? "✅ 全部通过" : "❌ 有失败") + "：pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
