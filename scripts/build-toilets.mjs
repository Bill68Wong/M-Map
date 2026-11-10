#!/usr/bin/env node
/**
 * 公厕数据抓取与转换（scripts/build-toilets.mjs · M3 · 2026-11-10）
 *
 * ── 做什么 ────────────────────────────────────────────────────────────
 *   1. 从 data.gov.mo 下载「公共廁所」数据包（ZIP）
 *   2. 解出 `toliet.json`（源文件名就是 toliet，非笔误），**逐字节**存原始副本
 *   3. 校验（198 条 / 坐标可解析 / nameZh 非空），任一不满足即 exit 1
 *   4. 坐标 WGS84 → GCJ-02（**复用 `src/lib/amap/coord.ts` 的 wgs84ToGcj02，不另写**）
 *   5. 产出 `public/data/public-toilets.json`（含原始 WGS84 + 转换后 GCJ-02）
 *   6. 用 JSON 的 source/sourceName/provider/acquiredOn 回写
 *      `src/lib/map/toilet-attribution.ts` 的 GENERATED_META 区块（署名文案只此一处模板）
 *
 * ── 端点已知坑（实测）──────────────────────────────────────────────────
 *   `.../download/...?isNeedFile=1` 会**间歇返回 HTTP 200 + `{"msg":"內部錯誤","code":1}`**
 *   （实测 4 次里 3 次失败）。所以**不能只看 HTTP 状态**，必须校验 ZIP 魔数
 *   `PK\x03\x04` 且字节数合理；失败重试 ≥3 次（本脚本 8 次 + 退避），仍失败即 exit 1。
 *
 * ── 红线 ──────────────────────────────────────────────────────────────
 *   只写白名单文件：public/data/public-toilets.raw.json / public/data/public-toilets.json /
 *   src/lib/map/toilet-attribution.ts 的 GENERATED_META 区块。不碰数据库、不改其它源码。
 *
 * 运行：node scripts/build-toilets.mjs
 *       （Node ≥22；本脚本直接 import `.ts` 依赖，依赖 Node 原生类型剥离。）
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { wgs84ToGcj02 } from "../src/lib/amap/coord.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "public", "data");
const RAW_OUT = path.join(DATA_DIR, "public-toilets.raw.json");
const JSON_OUT = path.join(DATA_DIR, "public-toilets.json");
const ATTR_TS = path.join(ROOT, "src", "lib", "map", "toilet-attribution.ts");

const SOURCE_PAGE = "https://data.gov.mo/Detail?id=f6a9892d-7e16-49f0-bcd3-573d670cefe5";
const DOWNLOAD_URL =
  "https://api.data.gov.mo/document/download/f6a9892d-7e16-49f0-bcd3-573d670cefe5?isNeedFile=1&lang=TC";
const ENTRY_NAME = "toliet.json"; // 源包内文件名，勿「纠正」为 toilet
const EXPECT_COUNT = 198;
const EXPECT_ENTRY_BYTES = 176544;
const UA = "MMap-Macau-Bus-PWA/1.0 (non-commercial civic tech; build script)";
const MAX_ATTEMPTS = 8;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04

const die = (msg) => {
  console.error("✗ " + msg);
  process.exit(1);
};

const isZip = (buf) =>
  buf.length >= 4 &&
  buf[0] === ZIP_MAGIC[0] &&
  buf[1] === ZIP_MAGIC[1] &&
  buf[2] === ZIP_MAGIC[2] &&
  buf[3] === ZIP_MAGIC[3];

/** 下载 ZIP：校验魔数 + 字节数下限，失败退避重试（端点会间歇返回错误 JSON） */
async function downloadZip() {
  let lastReason = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(DOWNLOAD_URL, { headers: { "user-agent": UA } });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) {
        lastReason = `HTTP ${res.status}，${buf.length}B`;
      } else if (!isZip(buf)) {
        lastReason = `非 ZIP（HTTP ${res.status}，${buf.length}B，头部=${JSON.stringify(
          buf.slice(0, 60).toString("utf8"),
        )}）`;
      } else if (buf.length < 20_000) {
        lastReason = `ZIP 过小（${buf.length}B，期望 ≈29952B）`;
      } else {
        console.log(
          `  下载成功：attempt=${attempt}/${MAX_ATTEMPTS} HTTP=${res.status} bytes=${buf.length} sha256=${createHash(
            "sha256",
          )
            .update(buf)
            .digest("hex")}`,
        );
        return buf;
      }
    } catch (e) {
      lastReason = `网络错误：${e.message}`;
    }
    console.warn(`  attempt ${attempt}/${MAX_ATTEMPTS} 失败：${lastReason}`);
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  die(`连续 ${MAX_ATTEMPTS} 次未能取到有效 ZIP（最后原因：${lastReason}）—— 不产出空文件`);
}

/** 从 ZIP 中央目录取指定条目的原始解压字节（支持 method 0 store / 8 deflate） */
function extractEntry(zip, name) {
  // 1) 找 EOCD（End of Central Directory，签名 0x06054b50，可变注释 ⇒ 从尾部倒扫）
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) die("ZIP 结构异常：找不到 EOCD");
  const total = zip.readUInt16LE(eocd + 10);
  const cdOff = zip.readUInt32LE(eocd + 16);
  if (total === 0) die("ZIP 中央目录为空");

  // 2) 遍历中央目录找目标条目
  let p = cdOff;
  let found = null;
  for (let k = 0; k < total; k++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) die(`ZIP 中央目录第 ${k} 条签名异常 @${p}`);
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const uncompSize = zip.readUInt32LE(p + 24);
    const fnLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const cmtLen = zip.readUInt16LE(p + 32);
    const localOff = zip.readUInt32LE(p + 42);
    const fname = zip.slice(p + 46, p + 46 + fnLen).toString("utf8");
    if (fname === name) {
      found = { method, compSize, uncompSize, localOff };
      break;
    }
    p += 46 + fnLen + extraLen + cmtLen;
  }
  if (!found) {
    die(`ZIP 内找不到条目 ${JSON.stringify(name)}（包内可能改名，需人工确认）`);
  }

  // 3) 本地文件头（签名 0x04034b50）→ 数据起点
  const lh = found.localOff;
  if (zip.readUInt32LE(lh) !== 0x04034b50) die("ZIP 本地文件头签名异常");
  const lfnLen = zip.readUInt16LE(lh + 26);
  const lextraLen = zip.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + lfnLen + lextraLen;
  const comp = zip.slice(dataStart, dataStart + found.compSize);
  let raw;
  if (found.method === 0) raw = comp;
  else if (found.method === 8) raw = inflateRawSync(comp);
  else die(`不支持的 ZIP 压缩方法 ${found.method}`);
  if (raw.length !== found.uncompSize) {
    die(`解压后字节数不符：${raw.length} ≠ 中央目录声明 ${found.uncompSize}`);
  }
  return { raw, method: found.method, compSize: found.compSize, uncompSize: found.uncompSize };
}

/** location 形如 "22.211268,113.551493"（lat,lng）→ {lat,lng}；不可解析返回 null */
function parseLocation(loc) {
  if (loc === null || loc === undefined) return null;
  const s = String(loc).trim();
  if (!s) return null;
  const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

const strOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** 用 JSON 元数据回写署名常量的 GENERATED_META 区块（只改两标记之间） */
function regenAttributionMeta(meta) {
  if (!existsSync(ATTR_TS)) {
    die(`找不到 ${path.relative(ROOT, ATTR_TS)} —— 请先创建（含 GENERATED_META 区块标记）`);
  }
  const src = readFileSync(ATTR_TS, "utf8");
  const BEGIN = "// #region GENERATED_META";
  const END = "// #endregion GENERATED_META";
  const bi = src.indexOf(BEGIN);
  const ei = src.indexOf(END);
  if (bi < 0 || ei < 0 || ei < bi) {
    die(`toilet-attribution.ts 缺 GENERATED_META 区块标记（${BEGIN} … ${END}），拒绝写入以免破坏文件`);
  }
  const block =
    `${BEGIN} (generated by scripts/build-toilets.mjs —— 勿手改)\n` +
    `export const TOILET_META = {\n` +
    `  source: ${JSON.stringify(meta.source)},\n` +
    `  sourceName: ${JSON.stringify(meta.sourceName)},\n` +
    `  provider: ${JSON.stringify(meta.provider)},\n` +
    `  acquiredOn: ${JSON.stringify(meta.acquiredOn)},\n` +
    `} as const;\n`;
  const next = src.slice(0, bi) + block + src.slice(ei);
  if (next !== src) {
    writeFileSync(ATTR_TS, next, "utf8");
    console.log(`  已回写署名元数据 → ${path.relative(ROOT, ATTR_TS)}`);
  } else {
    console.log("  署名元数据未变化，跳过写入");
  }
}

async function main() {
  console.log("== 公厕数据抓取（data.gov.mo / 公共廁所）==");
  console.log(`  source: ${SOURCE_PAGE}`);

  const zip = await downloadZip();
  const { raw, method, compSize, uncompSize } = extractEntry(zip, ENTRY_NAME);
  console.log(`  解出 ${ENTRY_NAME}：method=${method} compSize=${compSize} rawBytes=${uncompSize}`);

  // ── 校验 1：字节数 + 是数组 + 长度 198 ──
  if (uncompSize !== EXPECT_ENTRY_BYTES) {
    console.warn(`  ⚠️ 原始字节数 ${uncompSize} ≠ 期望 ${EXPECT_ENTRY_BYTES}（数据集可能已更新）`);
  }
  let arr;
  try {
    arr = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    die(`toliet.json 不是合法 JSON：${e.message}`);
  }
  if (!Array.isArray(arr)) die("toliet.json 顶层不是数组");
  if (arr.length !== EXPECT_COUNT) die(`记录数 ${arr.length} ≠ 期望 ${EXPECT_COUNT}`);
  console.log(`  校验：记录数 ${arr.length} ✅`);

  // ── 逐字节保存原始副本 + sha256 ──
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(RAW_OUT, raw);
  const rawSha256 = createHash("sha256").update(raw).digest("hex");
  const rawBytes = raw.length;
  console.log(`  原始副本 → ${path.relative(ROOT, RAW_OUT)}（${rawBytes}B sha256=${rawSha256}）`);

  // ── 校验 2：nameZh 非空 + 坐标可解析 ──
  let coordOk = 0;
  let coordNull = 0;
  let nameEmpty = 0;
  const names = new Set();
  for (const r of arr) {
    const nameZh = strOrNull(r.nameZh);
    if (!nameZh) nameEmpty++;
    else names.add(nameZh);
    const p = parseLocation(r.location);
    if (p) coordOk++;
    else coordNull++;
  }
  if (nameEmpty > 0) die(`nameZh 为空 ${nameEmpty} 条（期望 0）`);
  if (coordNull !== 1) die(`坐标不可解析 ${coordNull} 条（期望仅 1 条 location=null）`);
  console.log(`  校验：nameZh 空=${nameEmpty} ✅；坐标可解析=${coordOk} / null=${coordNull} ✅`);
  console.log(`  校验：nameZh 去重后 ${names.size} 条（全不重复=${names.size === arr.length}）`);

  // ── 转换 + 组装 items（先不带 publicId）──
  let photoNull = 0;
  const items = arr.map((r) => {
    const p = parseLocation(r.location);
    const photo = strOrNull(r.photo);
    if (!photo) photoNull++;
    if (!p) {
      // location=null 的那 1 条：坐标全 null，保留在 items（前端跳过标点）
      return {
        nameTc: String(r.nameZh).trim(),
        address: strOrNull(r.addressZh),
        openingHours: strOrNull(r.openHourZh),
        tel: strOrNull(r.telZh),
        photo,
        latWgs84: null,
        lngWgs84: null,
        lat: null,
        lng: null,
        hasDwc: Boolean(r.hasDwc),
        hasFwc: Boolean(r.hasFwc),
        tempClose: Boolean(r.tempClose),
      };
    }
    const gcj = wgs84ToGcj02({ lat: p.lat, lng: p.lng });
    return {
      nameTc: String(r.nameZh).trim(),
      address: strOrNull(r.addressZh),
      openingHours: strOrNull(r.openHourZh),
      tel: strOrNull(r.telZh),
      photo,
      latWgs84: p.lat,
      lngWgs84: p.lng,
      lat: round6(gcj.lat),
      lng: round6(gcj.lng),
      hasDwc: Boolean(r.hasDwc),
      hasFwc: Boolean(r.hasFwc),
      tempClose: Boolean(r.tempClose),
    };
  });

  // ── publicId：稳定哈希（不按抓取顺序编号）─────────────────────────���──
  //   输入 = nameTc + 原始 WGS84 满精度坐标。撞键时按「名字 → 经度 → 纬度 → 原始行序」
  //   显式稳定排序，第 2+ 个追加 -2/-3 后缀（只依赖显式比较器，不赌 Array.sort 的隐式稳定性）。
  const baseDigest = (it) =>
    "PT-" +
    createHash("sha256")
      .update(`${it.nameTc}\u0000${it.latWgs84 ?? ""}\u0000${it.lngWgs84 ?? ""}`, "utf8")
      .digest("hex")
      .slice(0, 12)
      .toUpperCase();
  const groups = new Map();
  items.forEach((it, idx) => {
    const b = baseDigest(it);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(idx);
  });
  const publicIds = new Array(items.length);
  let collideGroups = 0;
  let collideSuffixed = 0;
  for (const [base, idxs] of groups) {
    if (idxs.length === 1) {
      publicIds[idxs[0]] = base;
      continue;
    }
    collideGroups++;
    const sorted = [...idxs].sort((a, c) => {
      const A = items[a];
      const C = items[c];
      return (
        A.nameTc.localeCompare(C.nameTc) ||
        (A.lngWgs84 ?? -1) - (C.lngWgs84 ?? -1) ||
        (A.latWgs84 ?? -1) - (C.latWgs84 ?? -1) ||
        a - c
      );
    });
    sorted.forEach((idx, k) => {
      publicIds[idx] = k === 0 ? base : `${base}-${k + 1}`;
      if (k > 0) collideSuffixed++;
    });
  }
  const finalItems = items.map((it, k) => ({ publicId: publicIds[k], ...it }));
  {
    const uniq = new Set(finalItems.map((x) => x.publicId));
    if (uniq.size !== finalItems.length) die(`publicId 撞键未解：唯一 ${uniq.size} / 总数 ${finalItems.length}`);
  }
  console.log(
    `  publicId：${finalItems.length} 条，撞键组 ${collideGroups}，追加后缀 ${collideSuffixed}，全局唯一 ✅`,
  );

  const nowIso = new Date().toISOString();
  const acquiredOn = nowIso.slice(0, 10);
  const out = {
    source: SOURCE_PAGE,
    sourceName: "公共廁所",
    provider: "市政署",
    acquiredOn,
    generatedAt: nowIso,
    recordCount: finalItems.length,
    rawSha256,
    rawBytes,
    sourceCoordSystem: "WGS84",
    coordSystem: "GCJ-02",
    transform: "wgs84ToGcj02() 见 src/lib/amap/coord.ts",
    derived: [
      "lat/lng = wgs84ToGcj02({lat:latWgs84, lng:lngWgs84})，保留 6 位小数（Math.round(x*1e6)/1e6，≈0.11m）",
      "latWgs84/lngWgs84 = 原始 location 解析值（WGS84，逐字节来源 public-toilets.raw.json）",
      "photo 空串 → null；location 为 null 的记录 lat/lng/latWgs84/lngWgs84 全为 null（保留在 items，前端跳过标点）",
      "重复坐标（13 组）不在数据层合并，留给前端处理",
    ],
    items: finalItems,
  };
  writeFileSync(JSON_OUT, JSON.stringify(out), "utf8");
  const outBytes = Buffer.byteLength(JSON.stringify(out));
  console.log(
    `  产出 → ${path.relative(ROOT, JSON_OUT)}（items=${finalItems.length}，photo=null ${photoNull} 条，${outBytes}B 紧凑）`,
  );

  // ── 回写署名常量 ──
  regenAttributionMeta({
    source: SOURCE_PAGE,
    sourceName: "公共廁所",
    provider: "市政署",
    acquiredOn,
  });

  console.log(`== 完成：acquiredOn=${acquiredOn} rawSha256=${rawSha256} ==`);
}

main().catch((e) => die(`未捕获异常：${e.stack || e.message}`));
