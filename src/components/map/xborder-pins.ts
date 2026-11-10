/**
 * 跨境交通地标点（機場 1 + 碼頭 3）—— 地图首页专用静态表（需求 7）。
 *
 * ── 坐标系与来源（最容易踩的一处，先读完再动数）─────────────────────────
 *   地图是 **GCJ-02**（高德）。本表的 `lng` / `lat` 也是 **GCJ-02**，
 *   来源：**高德 place/text 检索到的「设施本体」POI**（2026-11-08 实测核实）。
 *   四点的依据（括号内是高德返回的地址 / typecode）：
 *     · `airport` 澳門國際機場 —— 凼仔岛伟龙马路（150104 机场）
 *     · `TP`      氹仔碼頭     —— 北安大马路（150000 交通设施）
 *     · `PE`      外港碼頭     —— 花地玛堂区海港前地（150301 港口码头）
 *     · `PI`      內港客運碼頭 —— 火船头街（150301 港口码头）
 *
 *   ⚠️ **不要**再从 `GET /api/stations?include=lrt&v=2` 抄坐标 —— 那接口给的是
 *      **站点**坐标（轻轨站 `1505xx` / 巴士站 `1507xx`），不是**设施本体**。
 *      本表旧版正是照抄了站点坐标，后果是：
 *        · `airport` 与轻轨「機場」站 `LRT-AP` 逐位重合（0.00m），pin 的
 *          `zIndex:140` 高于站点层（`XborderPinLayer.tsx:106`）⇒ 14px 圆点把
 *          轻轨站图标整颗盖住，用户在地图上看得见"机场"却看不见"機場站"；
 *        · `TP` / `PE` / `PI` 分别落在轻轨氹仔碼頭站 / 巴士站 M239 / 巴士站 M137 上
 *          （0.00m / 0.00m / 0.00m）。
 *      核对方式：拿本表坐标去高德 place/text 反查，应命中「澳門國際機場 / 氹仔客运码头 /
 *      外港客运码头 / 内港客运码头」这类**设施**，而不是「XX站 / XX碼頭(地铁站)」。
 *
 *   ⚠️ **不要改用数据库 `stations` 表的原始值**：那是 WGS84，与 GCJ-02 相差约 600m。
 *      600m 在 15 级 ≈ 一个街口，用户看到的是"机场标在马路上"。两路混用是本需求
 *      唯一的静默错误来源（不报错、不警告，只是整体偏移）。
 *
 * ── 为什么写死在表里，而不是运行时读 `NavMap` 的 `stationsRef` ───────────────
 *   1) `stationsRef`（`NavMap.tsx:402`）是 **ref**：赋值后只调 `render()` 画 AMap marker，
 *      **不触发 React 重渲染** ⇒ 把它当 prop 传下去，组件永远只见到首次的 `null`；
 *   2) 地标与站点是两套语义（地标常显、站点有 zoom 门，见 `XB_HIDE_BELOW_ZOOM` 的说明），
 *      耦合会让日后改站点门时误伤地标。
 *   代价：坐标是**快照**。设施本体不会天天挪，但填海 / 码头搬迁 / 重测仍可能变，
 *   变了要手动改（依据换成新的高德设施 POI，见上）。
 *   `code` 保留下来**只作标识与数据对账**：它是 `/api/stations` 的主码，可据此查
 *   该站点附近的 ETA / 班次；**它不是坐标来源**，别再拿它回 `/api/stations` 取坐标回填。
 */

/** 地标类别：机场 / 码头（`"airport"` **全小写**，与 `/cross-border/[station]` 路由白名单同字面量） */
export type XbPinKind = "airport" | "pier";

export interface XbPin {
  /** `/cross-border/<id>` 的 id —— 必须逐字命中 `xb-view.ts#stationName` 的白名单，错一个字母就是 404 */
  id: "airport" | "PE" | "TP" | "PI";
  /**
   * 站点码：`/api/stations` 里的主码（如 `LRT-AP` = 轻轨機場站）。
   * **只作标识与数据对账**（按它查该站点附近的班次/ETA）—— 不是坐标来源，
   * 坐标取的是设施本体，见文件头。
   */
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
    lng: 113.579393,
    lat: 22.154770,
  },
  {
    id: "TP",
    code: "LRT-TFT",
    name: "氹仔碼頭",
    sub: "客运码头 · 氹仔",
    kind: "pier",
    lng: 113.581164,
    lat: 22.161624,
  },
  {
    id: "PE",
    code: "M239",
    name: "外港碼頭",
    sub: "客运码头 · 澳门半岛",
    kind: "pier",
    lng: 113.563976,
    lat: 22.194488,
  },
  {
    id: "PI",
    code: "M137",
    name: "內港客運碼頭",
    sub: "客运码头 · 内港",
    kind: "pier",
    lng: 113.540401,
    lat: 22.191974,
  },
] as const;

/**
 * 详情页地址（入口直达「当日所有」粒度）。
 *
 * ⚠️ 路径是 `/cross-border/<id>`，**不是** `/xborder/...` —— 前者是仓库里真实存在的
 *   路由（`src/app/cross-border/[station]/page.tsx`），后者不存在（写上去就是 404）。
 *   `?after=day` 是**粒度**：地图入口要的是"今日全部班次"，不带它则落到 `after=now`
 *   （最近五班），与列表页入口的落地页不是同一屏。`[station]/page.tsx` 对**完全不带**
 *   `after` 的请求会重定向到 `?after=day`，但那是兜底，不代替这里显式写清楚。
 *   `?from=map` 也不是装饰：`[station]/page.tsx:61` 只在 `from === "map"` 时
 *   把关闭键指回 `/`；漏了它，用户看完点关闭会被扔到跨境列表页。
 *   断言见验收脚本：点链接后 `pathname === "/cross-border/PE"` 且
 *   `search === "?after=day&from=map"`。
 */
export const xbHref = (id: XbPin["id"]) => `/cross-border/${id}?after=day&from=map`;

/* ══════════════════════════════════════════════════════════════════════════
   聚合（需求 7 · 负责人裁定方案 A）
   ──────────────────────────────────────────────────────────────────────────
   聚合存在的理由只有一个：**两个图标快撞上时防误点**。14px 圆点 + 6px 视觉间隙
   ⇒ 圆心距 < 20px 时用户点到的可能是"看起来是一个点、实际是两个"的那个。
   一旦分得开，就**必须各自显示** —— 把两个真实设施合成一个点，用户会以为
   "机场和氹仔码头是一个地方"，那是信息损失，不是防误点。

   机场与氹仔码头（设施本体）实测相距 **779.3m**（`xbDistanceMeters` 复算，2026-11-08
   坐标）。换算成屏幕圆心距（2026-11-08 用 `amap.lngLatToContainer()` 实测）：
     · z12 起就已分得开（22.16px ≥ 20）；
     · 只有地图最小档 **z11**（11.08px）才真的重叠 ⇒ 只有该档合并。
   （旧坐标抄的是站点、与轻轨站逐位重合，相距只有 409.9m ⇒ z12 11.66px 会聚合。
     换成设施本体后聚合点从 z12 退到 z11 —— 这是坐标变准的正常结果，
     负责人 2026-11-08 裁定：**不合并，首屏各自显示**。）

   ⚠️ 阈值**不写死像素魔数**：用「当前缩放的地面分辨率」把真实间距换算成像素，
      再与「两点不重叠所需的最小视觉间距」比较。这样换地图尺寸/换 DPR/换圆点尺寸时
      阈值仍然成立，而不会出现"某天把点从 12px 调到 16px 却忘了改 13 这个数"。
   ══════════════════════════════════════════════════════════════════════════ */

/** 圆点直径（px）。**必须与 `globals.css` 的 `--xb-pin-size` 同值** —— 改一处要改两处。 */
export const XB_PIN_SIZE = 14;
/** 两点之间还需要留的视觉间隙（px），否则描边会贴在一起看起来像一个点 */
export const XB_PIN_GAP = 6;
/**
 * 聚合阈值（中心距，px）：**两个图标快撞上时才合并** = 直径 + 视觉间隙。
 *
 * 语义只有这一句，所以它必须写成公式而不是一个手调的数：
 * 圆点 14px + 间隙 6px ⇒ 圆心距 < 20px 才可能被看成"一个点"。
 * 把 20 调大（例如 24）等于"图标明明分得开也合并"，
 * 会把机场与氹仔客运码头这两个**真实存在、相距 779.3m 的设施**藏成一个点。
 *
 * 2026-11-08 用 `amap.lngLatToContainer()` 实测（**不是手算**）的圆心距与判定：
 *
 *   | zoom | 圆心距 | 阈值 20 |
 *   |---|---|---|
 *   | 11（地图最小档，`setZooms([11,19])`） | 11.08px | **聚合** |
 *   | 12 | 22.16px | 不聚合 |
 *   | 12.5（首屏默认） | 31.35px | 不聚合 |
 *   | 13 | 44.33px | 不聚合 |
 *
 *   ⇒ **只有 z11 聚合**；z12 起两个圆点已分开（22.16px），首屏 12.5 上间隙 17px，
 *     各自可见、各自可点。
 *
 * 换坐标 / 换圆点尺寸时的复算方法：`xbDistanceMeters` 得地面距离，
 * 再除以 `xbMetersPerPixel(lat, zoom)` 得像素中心距；只有 < 本值才该聚合。
 */
export const XB_CLUSTER_MAX_PX = XB_PIN_SIZE + XB_PIN_GAP;

/**
 * 缩放级别 z 下「每像素多少米」（Web 墨卡托，赤道周长 40075016.686m）。
 * 22.16°N 处：`res(z) ≈ 144964 / 2^z` m/px。
 */
export const xbMetersPerPixel = (lat: number, zoom: number) =>
  (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);

/** 两点地面距离（m，小范围等距圆柱近似 —— 800m 量级足够，无需 haversine） */
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
