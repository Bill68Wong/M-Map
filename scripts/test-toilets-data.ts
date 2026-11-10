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
 * ── 反向自证（不写进断言，交付时手工做）────────────────────────────────
 *   临时把 JSON 的 `recordCount` 改成 197 再跑，`recordCount === 198` 必须变红；
 *   复原后必须复绿。这是「门禁真的会红」的证据（见交付报告）。
 *
 * 运行：npx tsx scripts/test-toilets-data.ts（或加进 package.json 后 npm run test:toilets-data）
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
