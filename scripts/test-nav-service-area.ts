/**
 * 澳门服务范围判定门禁（scripts/test-nav-service-area.ts · 2026-11-13 · P6）
 *
 * ── 为什么存在 ──────────────────────────────────────────────────────────
 *   ① 边界常量的**数据回归**：环是「高德官方 polyline 抄下来」的静态数据，
 *      手抖少一行、或将来有人"顺手简化一下"都会让判定静默偏移 —— 而偏移 100m
 *      的表现是「关闸被判不在澳门」，用户看到「目的地不在澳门」的胡话。
 *   ② **新枚举必须有文案**：`RouteResultPane` 的取值是
 *      `EMPTY_TEXT[data.emptyReason ?? "no_candidate"]`，缺一条会返回 `undefined`
 *      ⇒ 整块空白（无标题/无正文/无重试）。这是 P6 任务卡点名的"最容易漏的一步"，
 *      靠人肉 review 不可靠（枚举定义在 lib、文案在组件，改一处不会报错），
 *      所以用静态扫描把两个文件对起来。
 *
 * ⚠️ 直接 import 真实现，不复刻判定逻辑。复刻的测试只能证明"我以为的规则"。
 *
 * 跑法：`npm run test:nav-area`
 */
import { readFileSync } from "node:fs";
import {
  distToRingsM,
  inMacauServiceArea,
  MACAU_ADMIN_RINGS,
  MACAU_UNI_RINGS,
  SERVICE_AREA_PAD_M,
  SERVICE_AREA_RINGS,
} from "../src/lib/nav/macau-service-area";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string): void {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "OK  " : "FAIL"} ${label}`);
}

/** 判定断言（期望值与实测距离一起打印，失败时能直接看出差多少） */
function area(label: string, lng: number, lat: number, expected: boolean): void {
  const got = inMacauServiceArea(lng, lat);
  const d = distToRingsM(lng, lat, SERVICE_AREA_RINGS);
  const good = got === expected;
  if (good) pass++;
  else fail++;
  console.log(
    `${good ? "OK  " : "FAIL"} ${label.padEnd(20)} → ${got ? "IN " : "OUT"}  距边界 ${d.toFixed(0)}m` +
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
  /* 官方环首尾闭合：不闭合会把「出发点」当边界外，关闸/南端都会受影响 */
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

console.log("\n═══ ② 澳门境内必须 IN（含边界样本）═══");
area("关闸广场/巴士总站", 113.5491, 22.2153, true); // 官方环外 148m，靠容差
area("关闸边检大楼", 113.5485, 22.2145, true);
area("关闸以南165m", 113.5491, 22.2138, true);
area("大三巴", 113.5409, 22.1972, true);
area("氹仔市区", 113.556, 22.157, true);
area("机场", 113.5915, 22.1587, true);
area("路环市区", 113.556, 22.117, true);
area("黑沙海滩", 113.568, 22.108, true);
area("港珠澳大桥珠澳口岸人工岛", 113.581, 22.197, true); // 官方环 1
area("澳大横琴校区", 113.5459, 22.129, true); // adcode 440499 官方环
area("横琴口岸澳方区", 113.54486, 22.140725, true); // 手工环（高德无此行政区）

console.log("\n═══ ③ 范围外必须 OUT（P6 的核心归因场景）═══");
area("珠海长隆", 113.535, 22.11, false); // 任务卡样本：距边界 1639m
area("珠海拱北口岸", 113.549, 22.22, false); // 664m，与关闸只隔一条分界线
area("珠海横琴镇", 113.525, 22.13, false);
area("珠海吉大", 113.572, 22.256, false);
area("香港上环", 114.152, 22.287, false);
area("广州塔", 113.3245, 23.1066, false);

console.log("\n═══ ④ 容差语义（250m 的真实作用：收住关闸、不吞拱北/长隆）═══");
ok(SERVICE_AREA_PAD_M === 250, `容差常量 = 250m（实际 ${SERVICE_AREA_PAD_M}）`);
{
  // 关闸在官方环外 148m ⇒ 必须靠容差进来；关闸以北 278m ⇒ 必须被挡在外面。
  // 这一对是「容差不能太大也不能太小」的钉子：调大调小都会让其中一条红。
  const dNorth = distToRingsM(113.5491, 22.2165, SERVICE_AREA_RINGS);
  ok(
    dNorth > SERVICE_AREA_PAD_M && !inMacauServiceArea(113.5491, 22.2165),
    `关闸以北 ${dNorth.toFixed(0)}m > 容差 ⇒ OUT（容差没有失控）`,
  );
  const dGate = distToRingsM(113.5491, 22.2153, SERVICE_AREA_RINGS);
  ok(
    dGate < SERVICE_AREA_PAD_M && inMacauServiceArea(113.5491, 22.2153),
    `关闸广场 ${dGate.toFixed(0)}m < 容差 ⇒ IN（容差确实生效）`,
  );
  /* 与珠海侧留出的安全距离：容差若被误调大，长隆会先进来（1639m），拱北次之（664m） */
  ok(
    distToRingsM(113.549, 22.22, SERVICE_AREA_RINGS) - SERVICE_AREA_PAD_M > 300,
    "拱北口岸距边界超出容差 300m 以上（调大容差会先误伤它）",
  );
}

console.log("\n═══ ⑤ 非法输入与退化路径 ═══");
ok(!inMacauServiceArea(Number.NaN, 22.2), "NaN 经度 ⇒ false");
ok(!inMacauServiceArea(113.5, Number.POSITIVE_INFINITY), "Infinity 纬度 ⇒ false");
ok(distToRingsM(113.5, 22.2, []) === Infinity, "空环集 ⇒ 距离 Infinity（不返回 0 冒充「贴边」）");
ok(distToRingsM(113.5, 22.2, [[[113.5, 22.2]]]) === Infinity, "单点环（长度 <2）⇒ Infinity");

console.log("\n═══ ⑥ 新枚举必须有文案（P6 最容易漏的一步）═══");
{
  const typesSrc = readFileSync(new URL("../src/lib/nav/types.ts", import.meta.url), "utf8");
  const paneSrc = readFileSync(new URL("../src/components/nav/RouteResultPane.tsx", import.meta.url), "utf8");
  const block = typesSrc.match(/export type NavEmptyReason =([\s\S]*?);/);
  ok(!!block, "能定位 `NavEmptyReason` 联合类型");
  const members = block ? [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) : [];
  ok(members.length >= 4, `解析出 ${members.length} 个枚举成员：${members.join(" / ")}`);
  ok(members.includes("out_of_scope"), "`out_of_scope` 已加入枚举");
  for (const m of members) {
    // 文案表里必须是「键 + 冒号 + 对象」的形态，避免注释里出现同名字样就算过
    const has = new RegExp(`(^|[^\\w])${m}\\s*:\\s*\\{`, "m").test(paneSrc);
    ok(has, `EMPTY_TEXT 有 \`${m}\` 的文案（缺了会渲染成空白块）`);
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
