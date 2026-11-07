#!/usr/bin/env node
/**
 * 从「地图/微信位置分享链接」里提取经纬度，并可并入站点坐标登记表
 *
 * 用途：负责人在微信里只能分享定位链接、看不到坐标时，把链接原样粘过来，
 *       本脚本解析出经纬度、站名与坐标系。纯本地正则 + 仅白名单域名联网，不上传任何数据。
 *
 * 用法：
 *   node scripts/parse-location-link.mjs "<url 或 坐标>"
 *   node scripts/parse-location-link.mjs              # 从 stdin 读多行（可一次粘多条）
 *   node scripts/parse-location-link.mjs --merge .workbuddy/research/xxx.json   # 解析并并入登记表
 *
 * 坐标系判定：
 *   - 高德 / 腾讯 / 微信位置消息 → GCJ-02（可直接用于本项目）
 *   - Google Maps / 苹果地图 / GPS 原始 → WGS84（需偏移修正后使用）
 *   - OpenStreetMap → WGS84；百度 → BD-09
 *
 * 输出：JSON { parsed: [...], failed: [...] }
 */

import { stdin as input } from "node:process";
import { readFileSync, writeFileSync } from "node:fs";

/** 已知中国境内城市的粗略经纬度框，用于「顺序反了」的自证 */
const CHINA_BOX = { minLat: 18, maxLat: 54, minLng: 73, maxLng: 135 };
/** 横琴/澳门一带的收紧框，用于优先级判定 */
const HENGQIN_BOX = { minLat: 22.05, maxLat: 22.25, minLng: 113.35, maxLng: 113.65 };

function inBox(lat, lng, b) {
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

/**
 * 按已知参数名提取。
 * 关键：**参数名决定顺序**，不要凭数值大小猜。
 * 注意两家厂商的「裸坐标参数」顺序相反：
 *   腾讯 URI `marker=coord:lat,lng`（纬度在前）
 *   腾讯 H5   `?coord=lng,lat`（经度在前，实测 2026-11-05）
 */
const PATTERNS = [
  // ?lat=22.137&lng=113.515  或  &lat=..&lon=..
  { re: /[?&](?:lat|latitude|mlat|y)=(-?\d{1,3}\.\d{3,})[^&]*&(?:lng|lon|long|longitude|mlng|x)=(-?\d{1,3}\.\d{3,})/i, order: "latlng" },
  { re: /[?&](?:lng|lon|long|longitude|mlng|x)=(-?\d{1,3}\.\d{3,})[^&]*&(?:lat|latitude|mlat|y)=(-?\d{1,3}\.\d{3,})/i, order: "lnglat" },
  // 微信位置消息 XML：<location_x>纬度</location_x> … <location_y>经度</location_y>
  { re: /<location_x>(-?\d{1,3}\.\d{3,})<\/location_x>[\s\S]*?<location_y>(-?\d{1,3}\.\d{3,})<\/location_y>/i, order: "latlng", crs: "GCJ-02", crsWhy: "微信位置消息（腾讯坐标）" },
  // 腾讯 URI API：marker=coord:22.137061,113.515627;title:xxx  （纬度在前，冒号形态）
  { re: /coord:(-?\d{1,3}\.\d{3,}),(-?\d{1,3}\.\d{3,})/i, order: "latlng", crs: "GCJ-02", crsWhy: "腾讯 URI API" },
  // 腾讯 H5 POI 详情页：?coord=113.573418,22.147409 （经度在前，等号形态）
  { re: /[?&]coord=(-?\d{1,3}\.\d{3,}),(-?\d{1,3}\.\d{3,})/i, order: "lnglat", crs: "GCJ-02", crsWhy: "腾讯地图 H5 POI 详情（coord 参数，经度在前）" },
  // ?location=22.137,113.515   （腾讯系：纬度在前）
  { re: /[?&]location=(-?\d{1,3}\.\d{3,}),(-?\d{1,3}\.\d{3,})/i, order: "latlng" },
  // ?position=113.515,22.137   （高德：经度在前）
  { re: /[?&]position=(-?\d{1,3}\.\d{3,}),(-?\d{1,3}\.\d{3,})/i, order: "lnglat" },
  // ?centercoord= / ?center= / ?ll= / ?point= / ?coords=
  { re: /[?&](?:centercoord|center|ll|point|coords?)=(-?\d{1,3}\.\d{3,}),(-?\d{1,3}\.\d{3,})/i, order: "lnglat" },
  // ?q=22.137,113.515 或 ?query= / ?address=
  { re: /[?&](?:q|query|address)=(-?\d{1,3}\.\d{3,}),(-?\d{1,3}\.\d{3,})/i, order: "latlng" },
  // 路径里 @lat,lng,17z（Google Maps 风格）
  { re: /@(-?\d{1,3}\.\d{3,}),(-?\d{1,3}\.\d{3,})/, order: "latlng" },
  // 纯文本 "22.137061, 113.515627"
  { re: /^\s*(-?\d{1,3}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})\s*$/, order: "latlng" },
];

/** 域名 → 坐标系 */
const HOST_HINTS = [
  { re: /amap\.com|gaode\.com|高德/i, crs: "GCJ-02", why: "高德系" },
  { re: /map\.qq\.com|apis\.map\.qq\.com|腾讯地图/i, crs: "GCJ-02", why: "腾讯系（微信内置地图同源）" },
  { re: /weixin\.qq\.com|weixin110|mp\.weixin\.qq\.com/i, crs: "GCJ-02", why: "微信域名（位置消息走腾讯坐标）" },
  { re: /google\.[a-z.]+\/maps|maps\.google/i, crs: "WGS84", why: "Google Maps" },
  { re: /openstreetmap\.org|osm\.org/i, crs: "WGS84", why: "OpenStreetMap" },
  { re: /apple\.com\/maps|maps\.apple/i, crs: "WGS84", why: "Apple 地图" },
  { re: /baidu\.com|百度地图/i, crs: "BD-09", why: "百度系（需 BD-09→GCJ-02）" },
];

function parseOne(raw) {
  const raw0 = raw.trim();
  if (!raw0) return null;
  // URL 参数里的逗号常被编码成 %2C（腾讯 H5 详情页就是这样）⇒ 先解码再匹配。
  // 解码失败（畸形 % 序列）不致命，退回原文即可，不要因此丢整条链接。
  let decoded = raw0;
  try {
    decoded = decodeURIComponent(raw0);
  } catch {
    /* 保持原文 */
  }
  const text = decoded;

  for (const { re, order, crs: patternCrs, crsWhy: patternCrsWhy } of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    let a = Number(m[1]);
    let b = Number(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;

    let lat = order === "latlng" ? a : b;
    let lng = order === "latlng" ? b : a;
    let swapped = false;

    // 自证：若 (lat,lng) 落在中国框外而 (lng,lat) 落在框内 ⇒ 顺序判反了
    if (!inBox(lat, lng, CHINA_BOX) && inBox(lng, lat, CHINA_BOX)) {
      [lat, lng] = [lng, lat];
      swapped = true;
    }
    if (!inBox(lat, lng, CHINA_BOX)) continue;

    // 坐标系优先级：pattern 自带（如微信 XML / 腾讯 coord）> 域名线索 > 未判定
    const hint = HOST_HINTS.find((h) => h.re.test(text));
    const crs = patternCrs ?? hint?.crs ?? "未判定（按 GCJ-02 处理，请人工确认来源）";
    const crsWhy = patternCrsWhy ?? hint?.why ?? null;
    const inHengqin = inBox(lat, lng, HENGQIN_BOX);

    // 站名：从常见参数里取（腾讯 H5 的 n=、通用的 name= / title= / q= 等），已是解码后文本
    const nameHit = text.match(/[?&](?:n|name|title|keyword|q)=([^&]+)/i);
    const name = nameHit ? nameHit[1].trim() : null;
    // 去掉圈码与多余空白，保留原文以便人工核对
    const nameClean = name ? name.replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, "").trim() : null;

    return {
      raw: text.length > 160 ? text.slice(0, 160) + "…" : text,
      name: nameClean,
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      coord: `${lat.toFixed(6)},${lng.toFixed(6)}`,
      // 本项目统一 LngLat 写法（GCJ-02）：lng,lat
      lngLat: `${lng.toFixed(6)},${lat.toFixed(6)}`,
      crs,
      crsWhy,
      swapped,
      inHengqin,
    };
  }
  return null;
}

/**
 * 短链展开：高德/腾讯「分享→复制链接」给的是 surl.amap.com / t.cn 这类短链，
 * 真实坐标在被重定向到的长 URL 或落地页里。
 * 仅对**已知地图域名**发请求（白名单），避免变成任意 URL 抓取器。
 */
const SHORTLINK_ALLOW = /^https?:\/\/(surl\.amap\.com|amap\.com|uri\.amap\.com|t\.cn|url\.cn|map\.qq\.com|apis\.map\.qq\.com|weixin\.qq\.com)\//i;

async function expandShortLink(url) {
  if (!SHORTLINK_ALLOW.test(url)) return null;
  try {
    const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0" } });
    const body = await res.text();
    // 有些落地页把坐标放在 <meta> 或内联 JSON 里，长 URL 里也常带
    return { finalUrl: res.url, body: body.slice(0, 200_000) };
  } catch {
    return null;
  }
}

const argvAll = process.argv.slice(2);

// 先剥离开关与其参数，剩下的才是「待解析的链接」。
// ★ 2026-11-05 实测踩坑（两次，第二次造成实际损坏）：
//   ① 若不过滤，`--merge <path>` 会被当成一条链接，导致 lines=["--merge …"]、
//      stdin 被完全忽略，表现为「合并 0 条」的假成功；
//   ② 取路径必须从**同源数组**取。曾误写 `process.argv[mergeIdx + 1]`，
//      而 process.argv 前有 node 与脚本路径两个元素（索引差 2），
//      结果把登记表 JSON 写进了脚本自身，脚本被覆盖成 515 字节。
//   ⇒ 现统一用 argvAll 定位，并用「目标必须以 .json 结尾」做硬校验兜底。
const mergeIdx = argvAll.indexOf("--merge");
const mergeTarget = mergeIdx === -1 ? null : (argvAll[mergeIdx + 1] ?? null);
const args = argvAll.filter((a, i) => {
  if (a === "--merge") return false;
  if (mergeIdx !== -1 && i === mergeIdx + 1) return false;
  return true;
});

if (mergeIdx !== -1 && !mergeTarget) {
  console.error("--merge 需要一个 JSON 文件路径");
  process.exit(1);
}
if (mergeTarget && !/\.json$/i.test(mergeTarget)) {
  console.error(`拒绝写入：--merge 目标必须以 .json 结尾（收到 "${mergeTarget}"）。`);
  console.error("这道校验是为了防止误把脚本/源码当成登记表覆盖掉。");
  process.exit(1);
}

let lines = [];
if (args.length > 0) {
  lines = [args.join(" ")];
} else {
  const chunks = [];
  for await (const c of input) chunks.push(c);
  lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
}

const out = [];
const failed = [];

for (const l of lines) {
  if (!l.trim()) continue;
  let r = parseOne(l);

  // 首轮没解出且看着像短链 ⇒ 展开再试（长 URL 与页面正文都过一遍）
  if (!r) {
    const expanded = await expandShortLink(l.trim());
    if (expanded) {
      r = parseOne(expanded.finalUrl) || parseOne(expanded.body);
      if (r) r.raw = `${r.raw}（已展开短链）`;
    }
  }

  if (r) out.push(r);
  else failed.push(l.trim().slice(0, 120));
}

/**
 * --merge <registry.json>：把解析结果并入站点坐标登记表。
 * 合并规则：按站名去重（忽略空白）；同名则**官方来源覆盖推算来源**，同来源则更新。
 */
if (mergeTarget) {
  let reg = { stations: [] };
  try {
    reg = JSON.parse(readFileSync(mergeTarget, "utf8"));
  } catch {
    // 文件不存在或损坏 ⇒ 新建
  }
  if (!Array.isArray(reg.stations)) reg.stations = [];
  const RANK = { "official-share": 3, manual: 2, "poi-derived": 1 };
  const norm = (s) => (s ?? "").replace(/\s+/g, "");
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const r of out) {
    if (!r.name) {
      skipped += 1;
      continue;
    }
    const src = r.crs === "GCJ-02" ? "official-share" : "poi-derived";
    const i = reg.stations.findIndex((s) => norm(s.name) === norm(r.name));
    const next = {
      name: r.name,
      lng: r.lng,
      lat: r.lat,
      source: src,
      accuracy_m: src === "official-share" ? 5 : 200,
      verified_at: new Date().toISOString(),
    };
    if (i === -1) {
      reg.stations.push(next);
      added += 1;
    } else if ((RANK[src] ?? 0) >= (RANK[reg.stations[i].source] ?? 0)) {
      reg.stations[i] = { ...reg.stations[i], ...next };
      updated += 1;
    } else {
      skipped += 1;
    }
  }
  reg._更新时间 = new Date().toISOString();
  writeFileSync(mergeTarget, JSON.stringify(reg, null, 2) + "\n", "utf8");
  console.error(
    `[merge] 新增 ${added} · 更新 ${updated} · 跳过 ${skipped} · 登记表共 ${reg.stations.length} 条 → ${mergeTarget}`,
  );
}

console.log(JSON.stringify({ parsed: out, failed }, null, 2));

if (out.length === 0) {
  console.error(
    "\n未解析出坐标。请确认：① 链接是否完整（含 ? 与参数）；② 是否被聊天软件截断；③ 可改用「导航→高德地图」路径直接看经纬度。",
  );
  process.exit(1);
}
