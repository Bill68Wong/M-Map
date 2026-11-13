/**
 * 澳门服务范围判定门禁（scripts/test-nav-service-area.ts · 2026-11-13 · P6）
 *
 * ── 为什么存在 ──────────────────────────────────────────────────────────
 *   ① 边界常量的**数据回归**：环是「高德官方 polyline 抄下来」的静态数据，
 *      手抖少一行、或将来有人"顺手简化一下"都会让判定静默偏移。
 *   ② **容差不能靠感觉调**：容差调大 ⇒ 珠海湾仔口岸这类一水之隔的点被吞进来（用户搜珠海
 *      路线却得到"已收班"）；调小 ⇒ 站在填海地块边缘的澳门用户被判"不在澳门"。
 *      第 ④ 段用一对构造点把这个区间钉死。
 *   ③ **手工环必须零容差**：横琴口岸围网外 45m 就是珠海横琴镇，给容差等于把对岸算成澳门。
 *   ④ **入境口岸必须自己在服务范围内**：起点界外时会被锚到口岸，若口岸本身判 OUT，
 *      锚完立刻又被 `out_of_scope` 拒掉 —— 两个功能互相打架，且只在特定坐标才复现。
 *   ⑤ **新枚举必须有文案**：`RouteResultPane` 的取值是
 *      `EMPTY_TEXT[data.emptyReason ?? "no_candidate"]`，缺一条会返回 `undefined`
 *      ⇒ 整块空白（无标题/无正文/无重试）。这是 P6 任务卡点名的"最容易漏的一步"。
 *
 * ⚠️ 直接 import 真实现，不复刻判定逻辑。复刻的测试只能证明"我以为的规则"。
 * ⚠️ 坐标全部取自**高德 POI 实测**（抓取日期 2026-11-13，GCJ-02），不是估的 ——
 *    本文件历史上曾经用估值写过"关闸在环外 148m"，实测差了 ~500m，据此推出的 250m 容差
 *    也是错的。要改样本，先 `place/text` 查真实坐标。
 *
 * 跑法：`npm run test:nav-area`
 */
import { readFileSync } from "node:fs";
import {
  distToRingsM,
  HAND_DRAWN_AREA_RINGS,
  inMacauServiceArea,
  MACAU_ADMIN_RINGS,
  MACAU_ENTRY_POINTS,
  MACAU_UNI_RINGS,
  nearestEntryPoint,
  OFFICIAL_AREA_RINGS,
  SERVICE_AREA_PAD_M,
  SERVICE_AREA_RINGS,
} from "../src/lib/nav/macau-service-area";
import { HENGQIN_PORT_RING, isInsideRings } from "../src/lib/amap/district";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string): void {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "OK  " : "FAIL"} ${label}`);
}

/**
 * 判定断言。
 * ⚠️ 打印的「距环」对**环内点**是「到边界的距离」（不是"超出多少"）——
 *   `distToRingsM` 不区分内外，环内点同样有值。判断内外只看第二列。
 */
function area(label: string, lng: number, lat: number, expected: boolean): void {
  const got = inMacauServiceArea(lng, lat);
  const d = distToRingsM(lng, lat, OFFICIAL_AREA_RINGS);
  const good = got === expected;
  if (good) pass++;
  else fail++;
  console.log(
    `${good ? "OK  " : "FAIL"} ${label.padEnd(22)} → ${got ? "IN " : "OUT"}  距官方环 ${d.toFixed(0)}m` +
      (good ? "" : `  (期望 ${expected ? "IN" : "OUT"})`),
  );
}

console.log("═══ ① 环数据完整性（高德官方 820000 + 440499 + 横琴口岸手工环）═══");
{
  const n = (rs: { length: number }[]) => rs.reduce((a, r) => a + r.length, 0);
  ok(MACAU_ADMIN_RINGS.length === 2, `澳门官方环 2 个（实际 ${MACAU_ADMIN_RINGS.length}）`);
  ok(n(MACAU_ADMIN_RINGS) === 93, `澳门官方环 93 点（实际 ${n(MACAU_ADMIN_RINGS)}）`);
  ok(MACAU_UNI_RINGS.length === 1, `澳大横琴校区环 1 个（实际 ${MACAU_UNI_RINGS.length}）`);
  ok(n(MACAU_UNI_RINGS) === 17, `澳大环 17 点（实际 ${n(MACAU_UNI_RINGS)}）`);
  ok(SERVICE_AREA_RINGS.length === 4, `合集 4 环（2 官方主环 + 1 澳大 + 1 横琴口岸）`);
  /* 官方环 / 手工环必须真的分开：容差只给前者，混在一起就又变回"对岸被吞"的老 bug */
  ok(OFFICIAL_AREA_RINGS.length === 3, `官方组 3 环（不含手工环，实际 ${OFFICIAL_AREA_RINGS.length}）`);
  ok(
    HAND_DRAWN_AREA_RINGS.length === 1 && HAND_DRAWN_AREA_RINGS[0] === HENGQIN_PORT_RING,
    "手工组 1 环，且就是 district.ts 那个常量（没有偷偷复制一份）",
  );
  const closed = [MACAU_ADMIN_RINGS[0], MACAU_ADMIN_RINGS[1], MACAU_UNI_RINGS[0]].every((r) => {
    const a = r[0];
    const b = r[r.length - 1];
    return a[0] === b[0] && a[1] === b[1];
  });
  ok(closed, "三个官方环首尾闭合（首点 === 末点）");
  ok(
    SERVICE_AREA_RINGS.every((r) => r.length >= 3),
    "每环 ≥3 点（射线法的前提）",
  );
}

console.log("\n═══ ② 澳门境内必须 IN（高德 POI 实测坐标）═══");
/**
 * 这批是"容差原本想兜住"的点：实测**全部在官方环内**，一个都不靠容差。
 * 所以下面除了断言 IN，还单独断言 `isInsideRings` —— 若哪天有人"优化"环数据把它们挤出界，
 * 「靠 200m 容差兜着」仍会让 IN 通过，而这条会红，把问题暴露在正确的层级上。
 */
const MACAU_POIS: [string, number, number][] = [
  ["关闸总站", 113.553795, 22.212162],
  ["关闸边检大楼", 113.554346, 22.213468],
  ["青洲", 113.542904, 22.208333],
  ["青洲坊总站", 113.54873, 22.209044],
  ["青茂口岸", 113.547051, 22.210112],
  ["澳门旅游塔", 113.54158, 22.176748],
  ["妈阁庙", 113.536382, 22.183266],
  ["沙梨头海边街", 113.545212, 22.200083],
  ["澳门科学馆", 113.562083, 22.183351],
  ["外港客运码头", 113.563976, 22.194488],
  ["氹仔客运码头", 113.581164, 22.161624],
  ["澳门国际机场", 113.579393, 22.15477],
  ["九澳村", 113.585561, 22.129818],
  ["黑沙海滩", 113.574432, 22.115768],
  ["竹湾海滩", 113.564554, 22.110201],
  ["石排湾郊野公园", 113.560371, 22.122465],
  ["路环市区", 113.557559, 22.115009],
  ["港珠澳大桥澳门口岸", 113.581181, 22.19875],
  ["澳大横琴校区", 113.5459, 22.129],
  ["横琴口岸澳门口岸区", 113.550074, 22.137827],
];
for (const [n, a, b] of MACAU_POIS) area(n, a, b, true);
{
  /* 横琴口岸澳门口岸区是**飞地**（地理在珠海，靠手工环进来的），距官方环 450m，
     天然不在官方环内 ⇒ 单独排除，否则这条断言变成"永远红"，随即被人无视。 */
  const officialOnly = MACAU_POIS.filter(([n]) => n !== "横琴口岸澳门口岸区");
  ok(
    officialOnly.every(([, a, b]) => isInsideRings(a, b, OFFICIAL_AREA_RINGS)),
    `上列 ${officialOnly.length} 个澳门本土 POI **全部在官方环内**（不靠 200m 容差兜底）`,
  );
  ok(
    !isInsideRings(113.550074, 22.137827, OFFICIAL_AREA_RINGS),
    "横琴口岸澳门口岸区确实在官方环外（否则上一条的排除就该删掉）",
  );
}

console.log("\n═══ ③ 范围外必须 OUT（P6 的核心归因场景）═══");
area("珠海长隆", 113.535, 22.11, false); // 任务卡样本，距官方环 1639m
area("珠海拱北口岸", 113.549, 22.22, false); // 664m，与关闸只隔一条分界线
area("珠海湾仔口岸", 113.5335, 22.1915, false); // 440m，一水之隔（最近的珠海 POI）
area("珠海横琴镇", 113.538, 22.142, false); // ★ 距**手工环** 45m：本次修的就是它
area("珠海横琴金融岛", 113.529, 22.142, false);
area("珠海吉大", 113.572, 22.256, false);
area("香港上环", 114.152, 22.287, false);
area("广州塔", 113.3245, 23.1066, false);

console.log("\n═══ ④ 容差语义（200m：兜得住边角、吞不进对岸）═══");
ok(SERVICE_AREA_PAD_M === 200, `容差常量 = 200m（实际 ${SERVICE_AREA_PAD_M}）`);
{
  /* 构造点：取澳门环最南顶点，向正南（外海方向）平移若干米。
     这一对是「容差不能太大也不能太小」的钉子 —— 调大调小都会让其中一条红。 */
  const south = MACAU_ADMIN_RINGS[0].reduce((a, b) => (b[1] < a[1] ? b : a));
  const at = (m: number) => ({ lng: south[0], lat: south[1] - m / 110540 });
  const p100 = at(100);
  const p250 = at(250);
  ok(
    inMacauServiceArea(p100.lng, p100.lat),
    `环外 100m（构造点）⇒ IN（容差确实生效，兜住填海地块边缘）`,
  );
  ok(
    !inMacauServiceArea(p250.lng, p250.lat),
    `环外 250m ⇒ OUT（容差没有失控）`,
  );
  /* 真实对岸样本：湾仔口岸 440m 必须在外，余量 = 440 − 200 = 240m */
  const dw = distToRingsM(113.5335, 22.1915, OFFICIAL_AREA_RINGS);
  ok(
    dw > SERVICE_AREA_PAD_M,
    `珠海湾仔口岸 ${dw.toFixed(0)}m > 容差 ${SERVICE_AREA_PAD_M}m（调大容差会先误伤它）`,
  );
  const dg = distToRingsM(113.549, 22.22, OFFICIAL_AREA_RINGS);
  ok(dg - SERVICE_AREA_PAD_M > 300, `拱北口岸 ${dg.toFixed(0)}m，离容差边界还有 300m 以上`);
}

console.log("\n═══ ⑤ 手工环零容差（窄水道判在内的根因）═══");
{
  /* 珠海横琴镇距**手工环**45m。旧实现把手工环也并入 `distToRingsM(...) <= PAD`，
     于是它被 250m 容差吞进来 ⇒ 搜珠海路线仍得到"已收班"。现在必须 OUT。 */
  const dHand = distToRingsM(113.538, 22.142, HAND_DRAWN_AREA_RINGS);
  ok(dHand > 0 && dHand < 60, `珠海横琴镇距手工环 ${dHand.toFixed(0)}m（< 60m，正是被吞的那类）`);
  ok(!inMacauServiceArea(113.538, 22.142), "珠海横琴镇 ⇒ OUT（手工环不吃容差）");
  /* 反面：手工环**内部**必须 IN，否则"收紧"收过头，把澳方口岸区也关掉了 */
  ok(inMacauServiceArea(113.550074, 22.137827), "横琴口岸澳门口岸区（手工环内）⇒ IN");
  ok(
    distToRingsM(113.550074, 22.137827, OFFICIAL_AREA_RINGS) > SERVICE_AREA_PAD_M,
    "澳方口岸区距官方环 > 容差 ⇒ 它只能是靠手工环进来的（证明第 ② 条链没断）",
  );
}

console.log("\n═══ ⑥ 入境口岸（起点界外时的锚点）═══");
{
  ok(MACAU_ENTRY_POINTS.length === 6, `6 个入境口岸（实际 ${MACAU_ENTRY_POINTS.length}）`);
  ok(
    MACAU_ENTRY_POINTS.every((p) => p.name && Number.isFinite(p.lng) && Number.isFinite(p.lat)),
    "每个口岸都有名称与有限坐标",
  );
  /* ★ 关键：口岸必须自己在服务范围内。否则「锚到口岸」→「口岸判 OUT」互相打架 */
  for (const p of MACAU_ENTRY_POINTS) {
    ok(inMacauServiceArea(p.lng, p.lat), `口岸「${p.name}」自身在服务范围内`);
  }
  const nameOf = (lng: number, lat: number) => nearestEntryPoint(lng, lat).name;
  ok(nameOf(113.535, 22.11) === "横琴口岸", `珠海长隆 → 横琴口岸（实际 ${nameOf(113.535, 22.11)}）`);
  ok(nameOf(113.549, 22.22) === "关闸", `珠海拱北 → 关闸（实际 ${nameOf(113.549, 22.22)}）`);
  ok(
    ["外港客运码头", "氹仔客运码头", "港珠澳大桥口岸"].includes(nameOf(114.152, 22.287)),
    `香港上环 → 海路/桥口岸（实际 ${nameOf(114.152, 22.287)}）`,
  );
}

console.log("\n═══ ⑦ 非法输入与退化路径 ═══");
ok(!inMacauServiceArea(Number.NaN, 22.2), "NaN 经度 ⇒ false");
ok(!inMacauServiceArea(113.5, Number.POSITIVE_INFINITY), "Infinity 纬度 ⇒ false");
ok(distToRingsM(113.5, 22.2, []) === Infinity, "空环集 ⇒ 距离 Infinity（不返回 0 冒充「贴边」）");
ok(distToRingsM(113.5, 22.2, [[[113.5, 22.2]]]) === Infinity, "单点环（长度 <2）⇒ Infinity");

console.log("\n═══ ⑧ 枚举 ↔ 文案一致（P6 最容易漏的一步）═══");
{
  const typesSrc = readFileSync(new URL("../src/lib/nav/types.ts", import.meta.url), "utf8");
  const paneSrc = readFileSync(new URL("../src/components/nav/RouteResultPane.tsx", import.meta.url), "utf8");
  const block = typesSrc.match(/export type NavEmptyReason =([\s\S]*?);/);
  ok(!!block, "能定位 `NavEmptyReason` 联合类型");
  const members = block ? [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) : [];
  ok(members.length >= 4, `解析出 ${members.length} 个枚举成员：${members.join(" / ")}`);
  ok(members.includes("out_of_scope"), "`out_of_scope` 已加入枚举");
  /* 死枚举防回潮：no_cover 从无生产点下发，已于 P6 收尾删除。
     若有人把它加回来，必须同时给生产点与文案 —— 这条断言逼他面对这件事。 */
  ok(!members.includes("no_cover"), "`no_cover` 未被加回枚举（死枚举已清理）");
  for (const m of members) {
    const has = new RegExp(`(^|[^\\w])${m}\\s*:\\s*\\{`, "m").test(paneSrc);
    ok(has, `EMPTY_TEXT 有 \`${m}\` 的文案（缺了会渲染成空白块）`);
  }
  /* 兜底：取值处必须带 `?? no_candidate`，否则将来新增枚举忘了配文案会白屏 */
  ok(
    /\?\?\s*EMPTY_TEXT\.no_candidate/.test(paneSrc),
    "取值处有 `?? EMPTY_TEXT.no_candidate` 兜底（枚举漂移不白屏）",
  );
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
