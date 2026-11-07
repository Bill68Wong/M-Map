#!/usr/bin/env node
/**
 * 腾讯地图「收藏集分享」→ 站点坐标登记表
 *
 * ★ 这是本项目**最高效的取坐标路径**（2026-11-05 负责人发现）：
 *   腾讯地图 App 支持「分享收藏集」，生成一个分享链接；链接里的 `favPois` token
 *   对应服务端一份**公开可读的分享数据**。前端页面就是靠它渲染的，所以读它不是绕过访问控制。
 *
 * 链路（实测还原，勿重复研究）：
 *   分享页 https://map.wap.qq.com/online/h5-share/favoriteShare.html?favPois=<token>&...
 *     └─ 前端 bundle 里 getFavoriteSharePois() 调：
 *        POST https://mmapgwh.map.qq.com/shortlink/stol
 *        body {"data":"<token>"}
 *        ← { code:0, msg:"", data:"<JSON 字符串>" }
 *        data 解析后是 POI 数组，每条：
 *          name                            站名（含 ①②③ 标号）
 *          latLng.longitude / latLng.latitude   坐标（GCJ-02）
 *          point.mLongitudeE6 / mLatitudeE6     坐标（整数微度，可交叉校验）
 *          addr / nickName / editTime           地址 / 备注 / 收藏时间
 *
 * 用法：
 *   node scripts/fetch-fav-share.mjs "<分享链接或 favPois token>"
 *   node scripts/fetch-fav-share.mjs "<链接>" --merge .workbuddy/research/通琴号-站点坐标登记.json
 *   node scripts/fetch-fav-share.mjs "<链接>" --out .verify/tqh/fav.json    # 只存原始 JSON
 *
 * 坐标系：腾讯地图 = GCJ-02，与小程序一致，直接可用。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ENDPOINT = "https://mmapgwh.map.qq.com/shortlink/stol";

/** 从分享链接或裸 token 中提取 favPois */
function extractToken(input) {
  const s = input.trim();
  if (!s) return null;
  // 完整链接：取 favPois= 参数（可能被 URL 编码）
  const m = s.match(/[?&]favPois=([^&]+)/i);
  if (m) return decodeURIComponent(m[1]);
  // 裸 token：形如 _645507c718a8768eed03db35ffacfdf3
  if (/^_?[0-9a-f]{16,}$/i.test(s)) return s;
  return null;
}

/** 校验坐标：澳门/横琴一带 */
const BOX = { minLat: 21.8, maxLat: 22.4, minLng: 113.2, maxLng: 113.8 };
const inBox = (lat, lng) => lat >= BOX.minLat && lat <= BOX.maxLat && lng >= BOX.minLng && lng <= BOX.maxLng;

async function fetchShare(token) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      referer: "https://map.wap.qq.com/",
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.47",
    },
    body: JSON.stringify({ data: token }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(`接口返回 code=${json.code} msg=${json.msg || "(空)"}`);
  if (typeof json.data !== "string") return json.data ?? [];
  return JSON.parse(json.data);
}

/** POI → 统一结构 */
function toStation(p) {
  const ll = p.latLng ?? {};
  let lng = Number(ll.longitude);
  let lat = Number(ll.latitude);
  // 兜底：整数微度
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    const pt = p.point ?? {};
    if (Number.isFinite(Number(pt.mLongitudeE6)) && Number.isFinite(Number(pt.mLatitudeE6))) {
      lng = Number(pt.mLongitudeE6) / 1e6;
      lat = Number(pt.mLatitudeE6) / 1e6;
    }
  }
  return {
    name: String(p.name ?? p.title ?? "").trim(),
    lng,
    lat,
    addr: String(p.addr ?? ""),
    note: String(p.nickName ?? ""),
    editTime: p.editTime ?? null,
  };
}

const argvAll = process.argv.slice(2);
const mergeIdx = argvAll.indexOf("--merge");
const outIdx = argvAll.indexOf("--out");
const mergeTarget = mergeIdx === -1 ? null : (argvAll[mergeIdx + 1] ?? null);
const outTarget = outIdx === -1 ? null : (argvAll[outIdx + 1] ?? null);
const positional = argvAll.filter((a, i) => {
  if (a === "--merge" || a === "--out") return false;
  if (mergeIdx !== -1 && i === mergeIdx + 1) return false;
  if (outIdx !== -1 && i === outIdx + 1) return false;
  return true;
});

if (mergeTarget && !/\.json$/i.test(mergeTarget)) {
  console.error(`拒绝写入：--merge 目标必须以 .json 结尾（收到 "${mergeTarget}"）`);
  process.exit(1);
}
if (outTarget && !/\.json$/i.test(outTarget)) {
  console.error(`拒绝写入：--out 目标必须以 .json 结尾（收到 "${outTarget}"）`);
  process.exit(1);
}

const rawInput = positional.join(" ");
const token = extractToken(rawInput);
if (!token) {
  console.error(
    "用法：node scripts/fetch-fav-share.mjs \"<腾讯地图收藏集分享链接>\" [--merge <登记表.json>] [--out <原始.json>]\n" +
      "链接形如：https://map.wap.qq.com/online/h5-share/favoriteShare.html?favPois=_xxxx&...",
  );
  process.exit(1);
}

let pois;
try {
  pois = await fetchShare(token);
} catch (e) {
  console.error(`取数据失败：${e.message}`);
  console.error("可能原因：① 分享链接已失效（收藏集被取消分享或过期）；② 网络不通；③ 接口变更。");
  process.exit(1);
}

if (!Array.isArray(pois) || pois.length === 0) {
  console.error("接口返回空列表——请确认收藏集里确实有点位。");
  process.exit(1);
}

const all = pois.map(toStation);
const good = all.filter((s) => Number.isFinite(s.lng) && Number.isFinite(s.lat) && inBox(s.lat, s.lng));
const bad = all.filter((s) => !good.includes(s));
const named = good.filter((s) => s.name.length > 0);

if (outTarget) {
  mkdirSync(dirname(outTarget), { recursive: true });
  writeFileSync(outTarget, JSON.stringify({ token, fetchedAt: new Date().toISOString(), pois }, null, 2), "utf8");
}

console.log(
  JSON.stringify(
    {
      token,
      total: all.length,
      validCoord: good.length,
      named: named.length,
      outOfBox: bad.length,
      preview: good.slice(0, 5).map((s) => ({ name: s.name, lng: s.lng, lat: s.lat })),
    },
    null,
    2,
  ),
);

if (bad.length) {
  console.error(`\n⚠️ ${bad.length} 条坐标越界或缺失，已跳过：`);
  for (const b of bad.slice(0, 10)) console.error(`  ${b.name || "(无名称)"} → ${b.lng},${b.lat}`);
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
  const RANK = { "official-share": 3, "official-favshare": 3, manual: 2, "poi-derived": 1 };
  let added = 0;
  let updated = 0;
  for (const s of named) {
    const i = reg.stations.findIndex((x) => norm(x.name) === norm(s.name));
    const next = {
      name: s.name,
      lng: Number(s.lng.toFixed(6)),
      lat: Number(s.lat.toFixed(6)),
      source: "official-favshare",
      accuracy_m: 5,
      verified_at: new Date().toISOString(),
      note: s.note ? `收藏集备注：${s.note}` : undefined,
    };
    if (i === -1) {
      reg.stations.push(next);
      added += 1;
    } else if ((RANK[next.source] ?? 0) >= (RANK[reg.stations[i].source] ?? 0)) {
      reg.stations[i] = { ...reg.stations[i], ...next };
      updated += 1;
    }
  }
  reg._更新时间 = new Date().toISOString();
  writeFileSync(mergeTarget, JSON.stringify(reg, null, 2) + "\n", "utf8");
  console.error(`[merge] 新增 ${added} · 更新 ${updated} · 登记表共 ${reg.stations.length} 条 → ${mergeTarget}`);
}
