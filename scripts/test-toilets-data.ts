/**
 * 公厕静态数据门禁（scripts/test-toilets-data.ts · M3 · 2026-11-10）
 *
 * ── 守的是什么 ────────────────────────────────────────────────────────
 *   `public/data/public-toilets.json` 是**生成物**（`scripts/build-toilets.mjs`）。
 *   一旦数据源更新、脚本改错、或有人手改 JSON，前端轻则少标点、重则坐标全偏。
 *   本脚本对它做「结构 + 数量 + 坐标 + 完整性 + 来源元数据」五类断言。
 *
 * ── 为什么 rawSha256 要跟原始文件实际哈希比 ─────────────────────────────
 *   只信 JSON 里自称的 `rawSha256` 等于「自己证明自己」。必须**独立**对
 *   `public/data/public-toilets.raw.json` 现算 sha256 再比对，才能证明派生文件
 *   确实源自那份原始字节。
 *
 * ── ★ 2026-11-11：为什么要补「逐值锁」（qa 变异验收击穿后的必修项）──────
 *   原 4b 的 4 条断言只守「输出**有没有变**」，不守「变得**对不对**」：
 *     · mutant1 `toiletDisplayName` 恒返回原串 ⇒ 2 条红（能挡）；
 *     · mutant2 `toiletDisplayName` 恒返回 `"厕所"` ⇒ **33 条全绿、EXIT=0（击穿）**
 *       —— 198 个名字全变成同一个词，恰好满足「非空 / 不以编号开头 / 与原串不同 / 原文仍带编号」。
 *   ⇒ 4c 新增：① **独立参考实现**逐条算出 expected，再逐值比对（分母 = items.length）；
 *     ② 若干**写死的锚点值**（实读 JSON，防「两个实现一起被改坏」）；
 *     ③ 护栏反例（站台码不得误剥）。三者都不调用被测函数自己验自己。
 *
 * ── 反向自证（不写进断言，交付时手工做）────────────────────────────────
 *   临时把 JSON 的 `recordCount` 改成 197 再跑，`recordCount === 198` 必须变红；
 *   复原后必须复绿。2026-11-11 另做两次函数级变异：恒返回原串（mutant1）与
 *   恒返回 `"厕所"`（mutant2）都必须变红；红行原文与 `diff -q` 还原自证见交付报告。
 *
 * 运行：npx tsx scripts/test-toilets-data.ts（或加进 package.json 后 npm run test:toilets-data）
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { toiletDisplayName } from "../src/lib/map/public-toilets";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JSON_PATH = path.join(ROOT, "public", "data", "public-toilets.json");
const RAW_PATH = path.join(ROOT, "public", "data", "public-toilets.raw.json");

const MACAU_BBOX = { latMin: 22.1, latMax: 22.23, lngMin: 113.52, lngMax: 113.6 };

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

interface Toilet {
  publicId: string;
  nameTc: string;
  address: string | null;
  openingHours: string | null;
  tel: string | null;
  photo: string | null;
  latWgs84: number | null;
  lngWgs84: number | null;
  lat: number | null;
  lng: number | null;
  hasDwc: boolean;
  hasFwc: boolean;
  tempClose: boolean;
}
interface ToiletFile {
  source: string;
  sourceName: string;
  provider: string;
  acquiredOn: string;
  generatedAt: string;
  recordCount: number;
  rawSha256: string;
  rawBytes: number;
  items: Toilet[];
}

console.log("== 公厕静态数据门禁 ==");
console.log("  文件：" + path.relative(ROOT, JSON_PATH));

assert(existsSync(JSON_PATH), "派生 JSON 存在");
assert(existsSync(RAW_PATH), "原始副本 raw.json 存在");

if (!existsSync(JSON_PATH) || !existsSync(RAW_PATH)) {
  console.error("\n❌ 缺文件，终止：" + "pass=" + pass + " fail=" + fail);
  process.exit(1);
}

const rawBuf = readFileSync(RAW_PATH);
const rawSha = createHash("sha256").update(rawBuf).digest("hex");

let data: ToiletFile;
try {
  data = JSON.parse(readFileSync(JSON_PATH, "utf8")) as ToiletFile;
} catch (e) {
  console.error("  ✗ 派生 JSON 解析失败：" + (e as Error).message);
  process.exit(1);
}

// ── 1. 来源元数据 ──
assert(typeof data.source === "string" && /^https?:\/\//.test(data.source), "source 非空且是 URL");
assert(typeof data.sourceName === "string" && data.sourceName.length > 0, "sourceName 非空");
assert(typeof data.provider === "string" && data.provider.length > 0, "provider 非空");
assert(/^\d{4}-\d{2}-\d{2}$/.test(String(data.acquiredOn)), "acquiredOn 是 YYYY-MM-DD");
assert(
  typeof data.generatedAt === "string" && !Number.isNaN(Date.parse(String(data.generatedAt))),
  "generatedAt 是合法时间戳",
);

// ── 2. 数量 ──
assertEq<number>(data.recordCount, 198, "recordCount === 198");
assertEq<number>(data.items.length, 198, "items.length === 198");
assertEq<number>(data.recordCount, data.items.length, "recordCount 与 items.length 一致");

// ── 3. 坐标 ──
const withCoord = data.items.filter((x) => x.lat !== null && x.lng !== null);
const nullCoord = data.items.filter((x) => x.lat === null && x.lng === null);
assertEq<number>(withCoord.length, 197, "有效坐标 197 条");
assertEq<number>(nullCoord.length, 1, "location=null 的 1 条坐标全 null");

const badGcj = data.items.filter(
  (x) =>
    x.lat !== null &&
    x.lng !== null &&
    (x.lat < MACAU_BBOX.latMin ||
      x.lat > MACAU_BBOX.latMax ||
      x.lng < MACAU_BBOX.lngMin ||
      x.lng > MACAU_BBOX.lngMax),
);
assertEq<number>(badGcj.length, 0, "GCJ-02 坐标全部落在澳门范围（22.10~22.23 / 113.52~113.60）");

const badWgs = data.items.filter(
  (x) =>
    x.latWgs84 !== null &&
    x.lngWgs84 !== null &&
    (x.latWgs84 < MACAU_BBOX.latMin ||
      x.latWgs84 > MACAU_BBOX.latMax ||
      x.lngWgs84 < MACAU_BBOX.lngMin ||
      x.lngWgs84 > MACAU_BBOX.lngMax),
);
assertEq<number>(badWgs.length, 0, "WGS84 原始坐标全部落在澳门范围");

// 有坐标的记录必须两套坐标都齐（不许只填一半）
const halfCoord = data.items.filter(
  (x) => (x.lat === null) !== (x.lng === null) || (x.latWgs84 === null) !== (x.lngWgs84 === null),
);
assertEq<number>(halfCoord.length, 0, "无「只填 lat 不填 lng」的半套坐标");

// ── 4. 相片 / 名称 ──
const photoOk = data.items.filter((x) => x.photo !== null && /^https?:\/\//.test(x.photo));
const photoNull = data.items.filter((x) => x.photo === null);
assertEq<number>(photoOk.length, 193, "photo 非空且是 URL 的 193 条");
assertEq<number>(photoNull.length, 5, "photo 为 null 的 5 条");

const emptyName = data.items.filter((x) => !x.nameTc || !x.nameTc.trim());
assertEq<number>(emptyName.length, 0, "nameTc 全部非空");
const names = new Set(data.items.map((x) => x.nameTc));
assertEq<number>(names.size, 198, "nameTc 全不重复（去重后 198）");

// ── 4b. 卡片标题剥离设施编号（`toiletDisplayName`，2026-11-10 负责人要求）──
//   规则：卡片标题 = `公共厕所-<剥掉串首编号的名字>`（如 `MM04 雀仔園街市地下` → `雀仔園街市地下`）。
//   剥离**只在渲染层**做：编号是官方数据取值，改数据文件等于改政府原文。
//   这里守双向：① 剥离后不再带编号且非空；② JSON 原文**仍带**编号（证明没反向污染数据）。
const CODE_PREFIX = /^[A-Z]{1,3}\d{1,3}[ \u3000]*\S/;
const displayed = data.items.map((x) => toiletDisplayName(x.nameTc));
assertEq<number>(displayed.filter((n) => n.length > 0).length, 198, "剥离编号后标题全部非空");
assertEq<number>(displayed.filter((n) => CODE_PREFIX.test(n)).length, 0, "剥离后不再以设施编号开头");
assertEq<number>(
  displayed.filter((n, i) => n !== data.items[i].nameTc).length,
  198,
  "198 条全部被剥掉编号（期望值写死 198；分母不是 items.length）",
);
assertEq<number>(
  data.items.filter((x) => /^[A-Z]{1,3}\d{1,3}/.test(x.nameTc)).length,
  198,
  "JSON 原文仍保留设施编号（数据文件未被改写）",
);

// ── 4c. 逐值锁（2026-11-11 补；堵 mutant2「恒返回同一个词」的全绿击穿）──
/**
 * ★ **独立参考实现** —— 全文**不调用** `toiletDisplayName`，三处写法都刻意不同：
 *   ① 用 `exec` 取「串首编号 + 空白」的整段 head（被测函数是单条正则 + 捕获组）；
 *   ② 用 `slice(head.length)` 从原串上切掉（被测函数返回捕获组 m[1]）；
 *   ③ 防误伤用**显式字符表 Set + charAt** 判（被测函数用正则负向前瞻）。
 *   ⇒ 它不是「被测函数的镜像」，而是同一份规格的第二份实现；若有人把两份一起改坏，
 *     下面写死的锚点值会红。参考实现与被测函数**互不 import**，也没有共享常量。
 */
const REFERENCE_PUNCT = new Set([
  "/", "／", ",", "，", "、", ".", "．", ":", "：", ";", "；",
  "(", ")", "（", "）", "[", "]", "【", "】", "-", "–", "—", "_",
]);
const referenceDisplayName = (nameTc: string): string => {
  const head = /^[A-Z]{1,3}\d{1,3}[ \u3000]*/u.exec(nameTc)?.[0];
  if (!head) return nameTc;
  const rest = nameTc.slice(head.length);
  const first = rest.charAt(0);
  // 空串 / 标点开头 / 空白开头 ⇒ 不是「编号 + 名字」，回落原文
  if (!rest || REFERENCE_PUNCT.has(first) || /\s/u.test(first)) return nameTc;
  return rest;
};

/** ① 198 条逐值对拍：分母用 `data.items.length`，打印实测一致条数 */
const expected = data.items.map((x) => referenceDisplayName(x.nameTc));
const valueMismatches = data.items
  .map((x, i) => ({ i, raw: x.nameTc, got: displayed[i], want: expected[i] }))
  .filter((o) => o.got !== o.want);
assertEq<number>(
  data.items.filter((_, i) => displayed[i] === expected[i]).length,
  data.items.length,
  `逐值锁：displayed[i] === 独立参考 expected[i]（分母 = items.length = ${data.items.length}）`,
);
if (valueMismatches.length) {
  console.error("    不一致示例（最多 3 条）：" + JSON.stringify(valueMismatches.slice(0, 3)));
}

/** ② 锚点逐值锁：值全部实读 `public/data/public-toilets.json` 后写死，两条实现都必须命中 */
const ANCHOR_VALUES = [
  { raw: "MM04 雀仔園街市地下", want: "雀仔園街市地下", why: "编号+空格（189 条型）" },
  { raw: "C18路環黑沙兵房路臨時公廁", want: "路環黑沙兵房路臨時公廁", why: "编号直连（9 条型）" },
  { raw: "GC02九澳活動中心(九澳村路觀音廟前地)", want: "九澳活動中心(九澳村路觀音廟前地)", why: "直连且名字含括号" },
  { raw: "LT01氹仔沙崗市政墳場公廁", want: "氹仔沙崗市政墳場公廁", why: "LT 系列（qa 清单里的 LT01/02/03 是三条独立记录）" },
];
for (const a of ANCHOR_VALUES) {
  const exists = data.items.some((x) => x.nameTc === a.raw);
  assert(
    exists && referenceDisplayName(a.raw) === a.want && toiletDisplayName(a.raw) === a.want,
    `锚点逐值锁 [${a.why}] ${a.raw} → ${a.want}（JSON 有此原文 + 两份实现都等于写死值）`,
  );
}

/**
 * ③ 护栏反例：编号后紧跟标点 ⇒ 是站台码/复合码，不是设施编号，**原样返回不剥**。
 *   ⚠️ 只锁这一类。`A1 大堂` / `M2 澳門站` / `AP1 碼頭` 与真实 189 条构造上完全相同，
 *      不可能只挡它们而不误伤真实数据，故不设「不剥」断言（见被测函数注释的边界说明）。
 */
const NO_STRIP = [
  { raw: "M2/1 關閘總站", why: "站台码：编号后紧跟 /" },
  { raw: "M1/2 關閘", why: "站台码：编号后紧跟 /" },
  { raw: "AP1, 碼頭", why: "编号后紧跟逗号" },
];
for (const s of NO_STRIP) {
  assert(
    toiletDisplayName(s.raw) === s.raw && referenceDisplayName(s.raw) === s.raw,
    `防误伤 [${s.why}] ${s.raw} 两份实现都原样返回（实测 toiletDisplayName → ${JSON.stringify(toiletDisplayName(s.raw))}）`,
  );
}

// ── 5. 完整性 + publicId ──
assertEq<number>(data.items.length, 198, "items 条数校验（重复确认）");
const pids = new Set(data.items.map((x) => x.publicId));
assertEq<number>(pids.size, 198, "publicId 全局唯一且数量 === 198");
assert(
  data.items.every((x) => /^PT-[0-9A-F]{12}(-\d+)?$/.test(x.publicId)),
  "publicId 全部符合 PT-<12位大写十六进制>（撞键可带 -N 后缀）",
);
// 兜底：撞键处理后仍必须严格递增（后缀 -2 只能紧跟同 base，不得出现无名后缀）
const suffixOk = data.items.every((x) => {
  const m = /^(PT-[0-9A-F]{12})-(\d+)$/.exec(x.publicId);
  return !m || Number(m[2]) >= 2;
});
assert(suffixOk, "publicId 后缀若存在必须 ≥ 2（base 自身不带 -1）");

// ── 5b. 字段名双份一致（JSON ↔ TS 接口，防漂移）──
const EXPECT_ITEM_KEYS = [
  "address",
  "hasDwc",
  "hasFwc",
  "lat",
  "latWgs84",
  "lng",
  "lngWgs84",
  "nameTc",
  "openingHours",
  "photo",
  "publicId",
  "tel",
  "tempClose",
].sort();
const EXPECT_META_KEYS = [
  "acquiredOn",
  "coordSystem",
  "derived",
  "generatedAt",
  "items",
  "provider",
  "rawBytes",
  "rawSha256",
  "recordCount",
  "source",
  "sourceCoordSystem",
  "sourceName",
  "transform",
].sort();
const gotMetaKeys = Object.keys(data).sort();
assert(
  JSON.stringify(gotMetaKeys) === JSON.stringify(EXPECT_META_KEYS),
  `顶层字段名与接口完全一致（多/少都得红）`,
);
if (JSON.stringify(gotMetaKeys) !== JSON.stringify(EXPECT_META_KEYS)) {
  console.error("    顶层实际：" + JSON.stringify(gotMetaKeys));
  console.error("    顶层预期：" + JSON.stringify(EXPECT_META_KEYS));
}
const itemKeyDrift = data.items
  .map((x, i) => ({ i, keys: Object.keys(x).sort() }))
  .filter((o) => JSON.stringify(o.keys) !== JSON.stringify(EXPECT_ITEM_KEYS));
assertEq<number>(itemKeyDrift.length, 0, "每条 item 字段名与接口完全一致（13 键，无多无少）");
if (itemKeyDrift.length) {
  console.error("    漂移示例：" + JSON.stringify(itemKeyDrift.slice(0, 3)));
}

// ── 6. raw 完整性（独立算哈希，不信自称）──
assertEq<string>(String(data.rawSha256), rawSha, "rawSha256 与 raw.json 实际哈希一致");
assertEq<number>(Number(data.rawBytes), rawBuf.length, "rawBytes 与 raw.json 实际字节数一致");
let rawArr: unknown;
try {
  rawArr = JSON.parse(rawBuf.toString("utf8"));
} catch (e) {
  rawArr = null;
  console.error("  ✗ raw.json 解析失败：" + (e as Error).message);
}
assert(Array.isArray(rawArr), "raw.json 是数组");
assertEq<number>(Array.isArray(rawArr) ? rawArr.length : -1, 198, "raw.json 记录数 198");

console.log("\n" + (fail === 0 ? "✅ 全部通过" : "❌ 有失败") + "：pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
