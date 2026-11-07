/**
 * 跨境交通地标点（機場 1 + 碼頭 3）—— 地图首页专用静态表（需求 7）。
 *
 * ── 坐标系（最容易踩的一处，先读完再动数）────────────────────────────────
 *   地图是 **GCJ-02**（高德）。本表的 `lng` / `lat` 也是 **GCJ-02**，
 *   来源：`GET /api/stations?include=lrt&v=2` —— 该接口在服务端把库里存的 WGS84
 *   转成 GCJ-02 再下发（见 `src/app/api/stations/route.ts` 的转换调用）。
 *
 *   ⚠️ **不要改用数据库 `stations` 表的原始值**：那是 WGS84，与 GCJ-02 相差约 600m。
 *      600m 在 15 级 ≈ 一个街口，用户看到的是"机场标在马路上"。两路混用是本需求
 *      唯一的静默错误来源（不报错、不警告，只是整体偏移）。
 *      核对方式：`curl '/api/stations?include=lrt&v=2' | grep -o '"code":"LRT-AP"[^}]*'`
 *      与下表逐位比对（2026-11-07 实测一致）。
 *
 * ── 为什么写死在表里，而不是运行时读 `NavMap` 的 `stationsRef` ───────────────
 *   1) `stationsRef`（`NavMap.tsx:402`）是 **ref**：赋值后只调 `render()` 画 AMap marker，
 *      **不触发 React 重渲染** ⇒ 把它当 prop 传下去，组件永远只见到首次的 `null`；
 *   2) 地标与站点是两套语义（地标常显、站点有 zoom 门，见 `XB_HIDE_BELOW_ZOOM` 的说明），
 *      耦合会让日后改站点门时误伤地标。
 *   代价：坐标是**快照**。若上游站点坐标变更（搬迁/重测），这里要手动跟。
 *   为此每个点都保留 `code`：它才是权威标识，坐标只是可用的缓存，
 *   比对脚本可按 `code` 重新取一遍。
 */

/** 地标类别：机场 / 码头（`"airport"` **全小写**，与 `/cross-border/[station]` 路由白名单同字面量） */
export type XbPinKind = "airport" | "pier";

export interface XbPin {
  /** `/cross-border/<id>` 的 id —— 必须逐字命中 `xb-view.ts#stationName` 的白名单，错一个字母就是 404 */
  id: "airport" | "PE" | "TP" | "PI";
  /** 站点码：`/api/stations` 里的主码（权威标识，坐标变了按它重取） */
  code: string;
  /** 主标题：**上游专名，保持原文（繁体）** —— 这是数据，不是我方文案 */
  name: string;
  /** 副行：我方文案，**简体** */
  sub: string;
  kind: XbPinKind;
  /** GCJ-02 经度（来源见文件头） */
  lng: number;
  /** GCJ-02 纬度（来源见文件头） */
  lat: number;
}

export const XB_PINS: readonly XbPin[] = [
  {
    id: "airport",
    code: "LRT-AP",
    name: "澳門國際機場",
    sub: "国际航班 · 澳门",
    kind: "airport",
    lng: 113.57966794543093,
    lat: 22.156405719144136,
  },
  {
    id: "TP",
    code: "LRT-TFT",
    name: "氹仔碼頭",
    sub: "客运码头 · 氹仔",
    kind: "pier",
    lng: 113.57888934315038,
    lat: 22.160042154042625,
  },
  {
    id: "PE",
    code: "M239",
    name: "外港碼頭",
    sub: "客运码头 · 澳门半岛",
    kind: "pier",
    lng: 113.56249943182107,
    lat: 22.19442698727288,
  },
  {
    id: "PI",
    code: "M137",
    name: "內港客運碼頭",
    sub: "客运码头 · 内港",
    kind: "pier",
    lng: 113.54072689568436,
    lat: 22.191460172289577,
  },
] as const;

/**
 * 详情页地址。
 *
 * ⚠️ 路径是 `/cross-border/<id>`，**不是** `/xborder/...` —— 前者是仓库里真实存在的
 *   路由（`src/app/cross-border/[station]/page.tsx`），后者不存在（写上去就是 404）。
 *   `?from=map` 也不是装饰：`[station]/page.tsx:70` 只在 `from === "map"` 时
 *   把关闭键指回 `/`；漏了它，用户看完点关闭会被扔到跨境列表页。
 *   断言见验收脚本：点链接后 `pathname === "/cross-border/PE"` 且 `search === "?from=map"`。
 */
export const xbHref = (id: XbPin["id"]) => `/cross-border/${id}?from=map`;

/* ══════════════════════════════════════════════════════════════════════════
   聚合（需求 7 · 负责人裁定方案 A）
   ──────────────────────────────────────────────────────────────────────────
   机场（`LRT-AP`）与氹仔码头（`LRT-TFT`）实测相距 ≈ 411m：
   在 zoom 12 只隔 ≈ 12px、zoom 13 ≈ 23px，而圆点直径 14px ⇒ 低倍时两个圆**必然重叠**，
   用户点到的可能是"看起来是一个点、实际是两个"的那个 —— 这是静默的误操作来源。
   ⇒ 低倍时合并成一个**聚合点**（点开小窗里给两行链接），放大到足够分开后自动拆开。

   ⚠️ 阈值**不写死像素魔数**：用「当前缩放的地面分辨率」把真实间距换算成像素，
      再与「两点不重叠所需的最小视觉间距」比较。这样换地图尺寸/换 DPR/换圆点尺寸时
      阈值仍然成立，而不会出现"某天把点从 12px 调到 16px 却忘了改 13 这个数"。
   ══════════════════════════════════════════════════════════════════════════ */

/** 圆点直径（px）。**必须与 `globals.css` 的 `--xb-pin-size` 同值** —— 改一处要改两处。 */
export const XB_PIN_SIZE = 14;
/** 两点之间还需要留的视觉间隙（px），否则描边会贴在一起看起来像一个点 */
export const XB_PIN_GAP = 6;
/** 不重叠所需的中心距（px） */
export const XB_CLUSTER_MAX_PX = XB_PIN_SIZE + XB_PIN_GAP;

/**
 * 缩放级别 z 下「每像素多少米」（Web 墨卡托，赤道周长 40075016.686m）。
 * 22.16°N 处：`res(z) ≈ 144964 / 2^z` m/px。
 */
export const xbMetersPerPixel = (lat: number, zoom: number) =>
  (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);

/** 两点地面距离（m，小范围等距圆柱近似 —— 400m 量级足够，无需 haversine） */
export function xbDistanceMeters(a: XbPin, b: XbPin): number {
  const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (a.lng - b.lng) * 111320 * Math.cos(midLat);
  const dy = (a.lat - b.lat) * 110540;
  return Math.hypot(dx, dy);
}

/**
 * 允许聚合的点对（负责人裁定：**只有机场 ↔ 氹仔码头这一对会聚合**）。
 * 写成显式清单而不是"全表两两比较"：另外两个码头相隔 2km+，永远到不了阈值，
 * 但显式清单能让"为什么只有这一对"这句话落在代码里，而不是靠读者自己算。
 */
const XB_CLUSTER_PAIRS: readonly (readonly [XbPin["id"], XbPin["id"]])[] = [["airport", "TP"]];

/** 渲染单元：单点或聚合点（聚合点取两点**中点**，由负责人裁定） */
export interface XbGroup {
  /** `data-xb-cluster` 的值（`"airport+TP"`）；单点 = `null`（此时用 `data-xb-pin`） */
  clusterKey: string | null;
  /** 该组包含的地标 id（1 个 = 单点，2 个 = 聚合） */
  ids: XbPin["id"][];
  lng: number;
  lat: number;
}

/**
 * 按缩放级别把 4 个地标分成渲染单元。
 *
 * 纯函数（无 DOM / 无 map）：便于单测与在浏览器控制台直接复算，
 * 也是验收断言 `[data-xb-cluster]` / `[data-xb-pin]` 计数关系的依据。
 */
export function groupXbPins(zoom: number): XbGroup[] {
  const merged = new Set<XbPin["id"]>();
  const groups: XbGroup[] = [];

  for (const [aId, bId] of XB_CLUSTER_PAIRS) {
    const a = XB_PINS.find((p) => p.id === aId);
    const b = XB_PINS.find((p) => p.id === bId);
    if (!a || !b) continue;
    const midLat = (a.lat + b.lat) / 2;
    const pxDist = xbDistanceMeters(a, b) / xbMetersPerPixel(midLat, zoom);
    if (pxDist <= XB_CLUSTER_MAX_PX) {
      merged.add(a.id);
      merged.add(b.id);
      groups.push({
        clusterKey: `${a.id}+${b.id}`,
        ids: [a.id, b.id],
        lng: (a.lng + b.lng) / 2,
        lat: midLat,
      });
    }
  }

  for (const p of XB_PINS) {
    if (merged.has(p.id)) continue;
    groups.push({ clusterKey: null, ids: [p.id], lng: p.lng, lat: p.lat });
  }
  return groups;
}

/** id → 表项（卡片按 id 取标题/副行/链接时用；找不到返回 null，调用方须处理） */
export const xbPinById = (id: string): XbPin | null => XB_PINS.find((p) => p.id === id) ?? null;
