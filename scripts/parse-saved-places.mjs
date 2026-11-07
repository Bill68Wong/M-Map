#!/usr/bin/env node
/**
 * 解析「腾讯地图收藏夹导出文件」→ 站点坐标登记表
 *
 * 场景：负责人在腾讯地图 PC 网页版「我的收藏」导出地点列表，文件格式未知
 *       （可能是 txt / csv / tsv / kml / gpx / 甚至从表格另存的 xlsx 转 csv）。
 *       本脚本自动识别常见形态，抽出「名称 + 经纬度」，并可并入登记表。
 *
 * 用法：
 *   node scripts/parse-saved-places.mjs <导出文件路径>
 *   node scripts/parse-saved-places.mjs <文件> --merge .workbuddy/research/通琴号-站点坐标登记.json
 *   cat 导出.txt | node scripts/parse-saved-places.mjs
 *
 * 坐标系：腾讯地图导出的坐标是 GCJ-02（与小程序一致），直接可用。
 *
 * 支持的形态：
 *   1) CSV / TSV，带表头（含 名称/name、经度/lng/lon、纬度/lat 任一组合）
 *   2) CSV / TSV，无表头（自动找「两个相邻的小数，其中一个在 113.x，另一个在 22.x」）
 *   3) 纯文本行：「名称 113.5,22.1」「名称,113.5,22.1」「113.5,22.1 名称」
 *   4) KML：<Placemark><name>…</name><coordinates>lng,lat,0</coordinates></Placemark>
 *   5) GPX：<wpt lat="22.1" lon="113.5"><name>…</name></wpt>
 */

import { stdin as input } from "node:process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

/** 澳门 / 横琴一带的合理范围，用于剔除误识别 */
const BOX = { minLat: 21.8, maxLat: 22.4, minLng: 113.2, maxLng: 113.8 };

function inBox(lat, lng) {
  return lat >= BOX.minLat && lat <= BOX.maxLat && lng >= BOX.minLng && lng <= BOX.maxLng;
}

/** 数字对 → 判定哪个是纬度（22.x）哪个是经度（113.x），与书写顺序无关 */
function normalizePair(a, b) {
  const cands = [
    { lat: a, lng: b },
    { lat: b, lng: a },
  ];
  for (const c of cands) if (inBox(c.lat, c.lng)) return c;
  return null;
}

const NUM = String.raw`-?\d{1,3}\.\d{3,}`;

/** KML */
function parseKml(text) {
  const out = [];
  const re = /<Placemark\b[\s\S]*?<\/Placemark>/gi;
  for (const m of text.match(re) ?? []) {
    const name = (m.match(/<name>([\s\S]*?)<\/name>/i)?.[1] ?? "").trim();
    const coordRaw = m.match(/<coordinates>([\s\S]*?)<\/coordinates>/i)?.[1] ?? "";
    // KML 坐标是 lng,lat[,alt]
    const c = coordRaw.trim().split(/\s+/)[0];
    const parts = c.split(",").map(Number);
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      const p = normalizePair(parts[1], parts[0]);
      if (p) out.push({ name: name || null, lng: p.lng, lat: p.lat, from: "kml" });
    }
  }
  return out;
}

/** GPX */
function parseGpx(text) {
  const out = [];
  for (const m of text.match(/<wpt\b[^>]*>[\s\S]*?<\/wpt>/gi) ?? []) {
    const lat = Number(m.match(/\blat=["']([-\d.]+)["']/i)?.[1]);
    const lon = Number(m.match(/\blon=["']([-\d.]+)["']/i)?.[1]);
    const name = (m.match(/<name>([\s\S]*?)<\/name>/i)?.[1] ?? "").trim();
    if (Number.isFinite(lat) && Number.isFinite(lon) && inBox(lat, lon)) {
      out.push({ name: name || null, lng: lon, lat, from: "gpx" });
    } else if (Number.isFinite(lon) && Number.isFinite(lat)) {
      const p = normalizePair(lat, lon);
      if (p) out.push({ name: name || null, lng: p.lng, lat: p.lat, from: "gpx(swapped)" });
    }
  }
  return out;
}

/** 带表头的 CSV/TSV */
function parseTable(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = lines[0].includes("\t") ? "\t" : lines[0].includes(",") ? "," : null;
  if (!sep) return [];

  const head = lines[0].split(sep).map((s) => s.trim().replace(/^["']|["']$/g, ""));
  const idx = {
    name: head.findIndex((h) => /名称|名字|地点|站名|name|title|地址/i.test(h)),
    lng: head.findIndex((h) => /经度|經度|^lng$|^lon$|longitude/i.test(h)),
    lat: head.findIndex((h) => /纬度|緯度|^lat$|latitude/i.test(h)),
    coord: head.findIndex((h) => /坐标|經緯|经纬|coord|location/i.test(h)),
  };

  // ★ 判据：表头必须至少命中一个字段关键字，否则这不是表，是「无表头的纯文本」。
  //   曾踩坑：`澳门科技大学东门（轻轨站） 113.5,22.1` 里含逗号 ⇒ sep 误判为 ","，
  //   于是第一条数据被当成表头吞掉，名称也丢了。交给 parseLines 处理才对。
  if (idx.name < 0 && idx.lng < 0 && idx.lat < 0 && idx.coord < 0) return [];

  const out = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(sep).map((s) => s.trim().replace(/^["']|["']$/g, ""));
    const name = idx.name >= 0 ? cells[idx.name] : null;
    let lng = idx.lng >= 0 ? Number(cells[idx.lng]) : NaN;
    let lat = idx.lat >= 0 ? Number(cells[idx.lat]) : NaN;

    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      // 退化：从整行里找数字对，并把数字对之外的部分当名称
      const pair = line.match(new RegExp(String.raw`(${NUM})\s*[,;\s]\s*(${NUM})`));
      if (!pair) continue;
      const p = normalizePair(Number(pair[1]), Number(pair[2]));
      if (!p) continue;
      lng = p.lng;
      lat = p.lat;
      if (!name) {
        const guess = line.replace(pair[0], "").replace(/[,\t]+/g, " ").replace(/\s+/g, " ").trim();
        if (guess.length >= 2) out.push({ name: guess, lng, lat, from: "table(guess-name)" });
        else out.push({ name: null, lng, lat, from: "table" });
        continue;
      }
    } else {
      const p = normalizePair(lat, lng);
      if (!p) continue;
      lng = p.lng;
      lat = p.lat;
    }
    out.push({ name: name || null, lng, lat, from: "table" });
  }
  return out;
}

/** 纯文本逐行 */
function parseLines(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const pair = line.match(new RegExp(String.raw`(${NUM})\s*[,;\s]\s*(${NUM})`));
    if (!pair) continue;
    const p = normalizePair(Number(pair[1]), Number(pair[2]));
    if (!p) continue;
    // 名称 = 去掉数字对之后剩下的部分
    const name = line.replace(pair[0], "").replace(/[,\t]+/g, " ").replace(/\s+/g, " ").trim();
    out.push({ name: name || null, lng: p.lng, lat: p.lat, from: "line" });
  }
  return out;
}

function dedupe(list) {
  const seen = new Map();
  for (const x of list) {
    const key = `${x.name ?? ""}|${x.lng.toFixed(6)}|${x.lat.toFixed(6)}`;
    if (!seen.has(key)) seen.set(key, x);
  }
  return [...seen.values()];
}

// ── 主流程 ──
const argvAll = process.argv.slice(2);
const mergeIdx = argvAll.indexOf("--merge");
const mergeTarget = mergeIdx === -1 ? null : (argvAll[mergeIdx + 1] ?? null);
const positional = argvAll.filter((a, i) => {
  if (a === "--merge") return false;
  if (mergeIdx !== -1 && i === mergeIdx + 1) return false;
  return true;
});

if (mergeTarget && !/\.json$/i.test(mergeTarget)) {
  console.error(`拒绝写入：--merge 目标必须以 .json 结尾（收到 "${mergeTarget}"）`);
  process.exit(1);
}

let text;
let sourceLabel;
if (positional.length > 0) {
  const p = positional[0];
  if (!existsSync(p)) {
    console.error(`文件不存在：${p}`);
    process.exit(1);
  }
  text = readFileSync(p, "utf8");
  sourceLabel = p;
} else {
  const chunks = [];
  for await (const c of input) chunks.push(c);
  text = Buffer.concat(chunks).toString("utf8");
  sourceLabel = "stdin";
}

text = text.replace(/^\uFEFF/, "");

let parsed = [];
const tried = [];
if (/<Placemark/i.test(text)) {
  parsed = parseKml(text);
  tried.push("kml");
} else if (/<wpt\b/i.test(text)) {
  parsed = parseGpx(text);
  tried.push("gpx");
} else {
  const t = parseTable(text);
  tried.push("table");
  if (t.length) parsed = t;
  if (!parsed.length) {
    parsed = parseLines(text);
    tried.push("line");
  }
}

parsed = dedupe(parsed);
const withName = parsed.filter((x) => x.name && x.name.length >= 2);

console.log(
  JSON.stringify(
    {
      source: sourceLabel,
      triedParsers: tried,
      total: parsed.length,
      withName: withName.length,
      parsed,
    },
    null,
    2,
  ),
);

if (parsed.length === 0) {
  console.error(
    "\n未解析出任何坐标。请确认：\n" +
      "  ① 导出文件里是否包含经纬度列（若只有名称，需要换一种导出方式或改用分享链接）\n" +
      "  ② 或把文件前 10 行贴给我，我按实际格式适配",
  );
  process.exit(1);
}

if (mergeTarget) {
  let reg = { stations: [] };
  try {
    reg = JSON.parse(readFileSync(mergeTarget, "utf8"));
  } catch {
    /* 新建 */
  }
  if (!Array.isArray(reg.stations)) reg.stations = [];
  const norm = (s) => (s ?? "").replace(/\s+/g, "");
  let added = 0;
  let updated = 0;
  for (const x of withName) {
    const i = reg.stations.findIndex((s) => norm(s.name) === norm(x.name));
    const next = {
      name: x.name,
      lng: Number(x.lng.toFixed(6)),
      lat: Number(x.lat.toFixed(6)),
      source: "official-export",
      accuracy_m: 5,
      verified_at: new Date().toISOString(),
      note: `腾讯地图收藏夹导出（${x.from}）`,
    };
    if (i === -1) {
      reg.stations.push(next);
      added += 1;
    } else {
      reg.stations[i] = { ...reg.stations[i], ...next };
      updated += 1;
    }
  }
  reg._更新时间 = new Date().toISOString();
  writeFileSync(mergeTarget, JSON.stringify(reg, null, 2) + "\n", "utf8");
  console.error(
    `[merge] 新增 ${added} · 更新 ${updated} · 登记表共 ${reg.stations.length} 条 → ${mergeTarget}`,
  );
}
