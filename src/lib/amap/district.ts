/**
 * 澳门行政区边界封装（src/lib/amap/district.ts，M Map 改版 S1）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   用高德官方 `AMap.DistrictSearch`（extensions:'all'，adcode `820000`）取澳门
 *   行政区边界环（GCJ-02），并算出：
 *     ① `rings`        —— 澳门官方环（供域外遮罩「镂空」用）
 *     ② `exclaveRings` —— 横琴口岸澳方管辖区官方环（adcode `440499`，可选）
 *     ③ `bounds`       —— **外扩后**的 bbox（供 `setLimitBounds` / `setBounds`）
 *   取不到时**必须降级**为兜底矩形，**绝不抛错、绝不阻塞**底图/搜索/定位（§1.4 降级原则）。
 *
 * ── 合规（§1.2）──────────────────────────────────────────────────────
 *   · 边界**只取自高德官方行政区数据**，**不自绘**、不引入境外数据源；
 *   · 本模块**不落库、不写 localStorage**（合规待复核项 V5）——
 *     「仅内存 / sessionStorage」由调用方决定，本模块只返回内存对象；
 *   · bbox 是「可视/可拖范围」的**矩形约束**，**不在地图上画边界线**，合规。
 *
 * ── 实测（V3 探针，2026-09-20，无头 Chrome 真机）──────────────────────
 *   · V1 ✅ `search('820000', {level:'province'})` → `complete`，返回 boundaries；
 *   · V2 ✅ 环数 = **2**（澳门半岛 83 点 + 路氹 10 点）；
 *   · bbox = `113.533314~113.603872 / 22.106214~22.214074`；
 *   · V6 ✅ `search('440499')` 返回「澳门大学横琴校区(由澳门实施管辖)」及其官方环。
 *
 * ⚠️ 坐标：`DistrictSearch` 返回**已是 GCJ-02**，与地图 / `NavPoint` 口径一致，**不再转换**。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

/** 经纬度 bbox（经度/纬度各取 min/max） */
export interface MacauBounds {
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
}

/** 一个环：[lng, lat] 点列（GCJ-02） */
export type Ring = [number, number][];

export interface MacauDistrict {
  /** 澳门行政区边界环（GCJ-02，官方数据）—— 遮罩的「洞」 */
  rings: Ring[];
/**
 * 横琴口岸澳方管辖区官方环（GCJ-02）—— 一并镂空用。
 * 取不到时为空数组（此时该区域会被压暗，按 §1.4 ② 的口径）。
 * ★ v3.6.1：此处并入 `HENGQIN_PORT_RING`（手工环，高德无此 adcode）——
 *   所以 district 成功分支下**永不为空**；「SDK 440499 拿不到」另有 console.warn。
 */
  exclaveRings: Ring[];
  /** 外扩后的 bbox（覆盖澳门 + 横琴口岸澳方管辖区）—— 供 setLimitBounds / setBounds */
  bounds: MacauBounds;
  /** 数据来源：`district` = 高德官方边界；`fallback` = 兜底矩形 */
  source: "district" | "fallback";
}

/** 澳门 adcode（省级） */
export const MACAU_ADCODE = "820000";
/** 横琴口岸澳方管辖区 adcode（在高德行政区划里属广东） */
export const HENGQIN_EXCLAVE_ADCODE = "440499";

/**
 * 横琴口岸澳方口岸区官方环（**手工数据，非高德行政区划**）。
 *
 * ⚠️ 高德行政区划**无此实体**（2026-10-30 实测：REST 搜「横琴口岸」「粤澳深度合作区」均 0 命中；
 *    adcode 440499 只覆盖澳大横琴校区，其环 bbox `lat 22.1176~22.1340`，而横琴口岸 8 站
 *    全部在 `lat 22.1407~22.1413` —— **环北侧外约 780m**，即便 440499 被镂空口岸依然被遮）。
 *
 * 来源与精度：
 *   · 锚点 = 库内 DSAT 实测站坐标（`stations` 表自带 lat/lng）：
 *     LRT-HQ `113.54486,22.140725` 与 T560/1~7，站 bbox `lng 113.5449~113.5463 · lat 22.1407~22.1413`；
 *   · 顶点 = 公开地图目测级（**±100m**，只用于遮罩镂空，不用于任何计算/判定）；
 *   · 标定日期 **2026-10-30**。若口岸围网范围变化需人工更新。
 *
 * ⚠️ 环**不要画大**：北/东边一旦盖到横琴内地一侧，遮罩会反过来把内地区域镂空（漏出非澳门区）。
 */
export const HENGQIN_PORT_RING: Ring = [
  [113.54, 22.135],
  [113.543, 22.135],
  [113.548, 22.136],
  [113.551, 22.138],
  [113.552, 22.143],
  [113.548, 22.147],
  [113.542, 22.147],
  [113.538, 22.144],
];

/**
 * 兜底矩形（DistrictSearch 失败时使用）。
 * 取值 = 实测 bbox（113.5333~113.6039 / 22.1062~22.2141）外扩约 0.05°（≈5km），
 * 保证「仅范围限制」降级版依然把视角收敛在澳门一带，不露出珠三角。
 */
export const MACAU_FALLBACK_BOUNDS: MacauBounds = {
  minLng: 113.48,
  maxLng: 113.66,
  minLat: 22.05,
  maxLat: 22.27,
};

/**
 * bbox 外扩量（度）。实测 bbox 已把横琴口岸澳方管辖区包住
 * （站 bbox `lng 113.5449~113.5463 · lat 22.1407~22.1413`，DSAT 实测；2026-10-30 起由
 *  `HENGQIN_PORT_RING` 手工环并入 unionBounds，北到 `22.147`，仍在澳门主环 bbox `22.214` 之内），
 * 此处再外扩 0.012°（≈1.3km）留出余量，避免边缘站点/定位点被 `setLimitBounds` 卡边。
 */
const BBOX_PAD = 0.012;

/** 边界查询超时（ms）：超时即降级（不阻塞底图） */
const DISTRICT_TIMEOUT_MS = 6000;

/** 单点 → [lng, lat]（兼容高德返回数组或 LngLat 对象两种形态） */
function toPair(p: any): Ring[number] | null {
  if (Array.isArray(p) && p.length >= 2) {
    const lng = Number(p[0]);
    const lat = Number(p[1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }
  if (p && typeof p === "object") {
    const lng = Number(p.lng);
    const lat = Number(p.lat);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }
  return null;
}

/** 原始 boundaries（number[][][]）→ Ring[]（过滤无效点/空环） */
function normalizeRings(boundaries: any): Ring[] {
  if (!Array.isArray(boundaries)) return [];
  const out: Ring[] = [];
  for (const raw of boundaries) {
    if (!Array.isArray(raw)) continue;
    const ring: Ring = [];
    for (const p of raw) {
      const pair = toPair(p);
      if (pair) ring.push(pair);
    }
    if (ring.length >= 3) out.push(ring);
  }
  return out;
}

/** 多环 → bbox */
function bboxOf(rings: Ring[]): MacauBounds | null {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return null;
  return { minLng, maxLng, minLat, maxLat };
}

/** 合并两个 bbox（任一为 null 时取另一个） */
function unionBounds(a: MacauBounds | null, b: MacauBounds | null): MacauBounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minLng: Math.min(a.minLng, b.minLng),
    maxLng: Math.max(a.maxLng, b.maxLng),
    minLat: Math.min(a.minLat, b.minLat),
    maxLat: Math.max(a.maxLat, b.maxLat),
  };
}

/** bbox 外扩（供 setLimitBounds/setBounds，确保可视 ⊆ bounds） */
export function padBounds(b: MacauBounds, pad = BBOX_PAD): MacauBounds {
  return {
    minLng: b.minLng - pad,
    maxLng: b.maxLng + pad,
    minLat: b.minLat - pad,
    maxLat: b.maxLat + pad,
  };
}

/**
 * 遮罩外圈大矩形（远大于澳门，配合 minZoom 保证任何合法缩放/拖动都不露边）。
 *
 * ★ 绕向与形态**照搬 V3 探针已实测通过的形状**（`[[112.0,20.6],[115.1,20.6],[115.1,23.7],[112.0,23.7]]`），
 *   此处按 bbox 中心动态生成同一取向（右下→右上→左上→左下），外扩 ±1.6°（≈160km）。
 *   V3 实测：`contains(澳门)=false`（洞生效）、`contains(珠海)=true`（被压暗）。
 */
export function maskOuterRing(bounds: MacauBounds): Ring {
  const cx = (bounds.minLng + bounds.maxLng) / 2;
  const cy = (bounds.minLat + bounds.maxLat) / 2;
  const d = 1.6;
  return [
    [cx - d, cy - d],
    [cx + d, cy - d],
    [cx + d, cy + d],
    [cx - d, cy + d],
  ];
}

/**
 * 点是否落在**任一**环内（射线法 / ray casting）。
 *
 * 用途：判断定位点是否在「澳门行政区范围（含横琴口岸澳方管辖区）」内 ——
 *   ① 在范围内 → 允许把地图 `setZoomAndCenter` 到定位点；
 *   ② 在范围外 → **不移动地图**（保持澳门视野），蓝点按真实坐标如实落位（§1.4 ④）。
 * 环来自高德官方数据（GCJ-02），与定位点同口径。
 */
export function isInsideRings(lng: number, lat: number, rings: Ring[]): boolean {
  for (const ring of rings) {
    if (ring.length < 3) continue;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/** 在 `timeoutMs` 内跑一个 Promise；超时/抛错一律 resolve 为 null（降级用） */
function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, timeoutMs);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(v);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

/** 单次 DistrictSearch 查询 → 原始 boundaries（失败/超时 → null） */
function searchBoundaries(AMap: any, adcode: string, timeoutMs: number): Promise<Ring[] | null> {
  return new Promise<Ring[] | null>((resolve) => {
    let done = false;
    const finish = (v: Ring[] | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      AMap.plugin(
        "AMap.DistrictSearch",
        () => {
          try {
            const ds = new AMap.DistrictSearch({
              // 澳门特别行政区为省级；用 province，失败由超时/兜底接管
              level: "province",
              subdistrict: 0,
              extensions: "all", // ★ 必须 all，否则不返回 boundaries
            });
            ds.search(adcode, (status: string, result: any) => {
              clearTimeout(timer);
              if (status !== "complete") return finish(null);
              const b = result?.districtList?.[0]?.boundaries;
              finish(normalizeRings(b));
            });
          } catch {
            clearTimeout(timer);
            finish(null);
          }
        },
        // 插件加载失败
        () => {
          clearTimeout(timer);
          finish(null);
        },
      );
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

/**
 * 取澳门行政区边界 + 横琴口岸澳方管辖区环。
 *
 * **永不抛错**：任何失败（插件加载失败 / 超时 / 无 boundaries）→ `source:'fallback'`
 * 并返回兜底矩形 + 空环数组（调用方据此走「仅范围限制」降级）。
 */
export async function loadMacauDistrict(AMap: any, timeoutMs = DISTRICT_TIMEOUT_MS): Promise<MacauDistrict> {
  try {
    if (!AMap) throw new Error("AMap 未就绪");
    // 澳门主环 + 澳方管辖区环**并行**取（澳方管辖区失败不影响主流程）
    const [macauRingsFirst, exclaveRings] = await Promise.all([
      searchBoundaries(AMap, MACAU_ADCODE, timeoutMs),
      withTimeout(searchBoundaries(AMap, HENGQIN_EXCLAVE_ADCODE, timeoutMs), timeoutMs),
    ]);

    // ★ 2026-11-04：移动端弱网实测，插件加载 + 首次查询偶发超过 6s ⇒ 一次失败即**永久无遮罩**
    //   （桌面端网络快，不复现）。失败后隔 1s 重试一次；仍失败才走 fallback。
    let macauRings = macauRingsFirst;
    if (!macauRings || !macauRings.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      macauRings = await searchBoundaries(AMap, MACAU_ADCODE, timeoutMs);
    }

    if (!macauRings || !macauRings.length) {
      // ⚠️ fallback 分支**故意不带** HENGQIN_PORT_RING：
      //    遮罩绘制条件是 `dist.rings.length && fill`（NavMap）——rings 为空时整个遮罩不画
      //    （data-map-mask=off，全亮），此时 exclaveRings 根本不会被消费；
      //    若带了，将来谁把绘制条件改成「rings 空也画局部遮罩」，path=[outer,手工环]
      //    会变成「全世界除横琴口岸外全暗」的灾难遮罩。
      return { rings: [], exclaveRings: [], bounds: { ...MACAU_FALLBACK_BOUNDS }, source: "fallback" };
    }

    const exclave = exclaveRings ?? [];
    // ★ 静默失效观测：440499 的环**只存在于 JS SDK**（REST 版 poly 为空，2026-10-30 实测）。
    //   SDK 通道一旦拿不到（插件失败/超时/数据变更），澳大校区会重新被遮罩压暗且**不报错**
    //   ——手工环只能救横琴口岸，救不了澳大。这里必须喊出来。
    if (!exclave.length)
      console.warn(
        "[district] exclaveRings(SDK 440499) 为空——澳大横琴校区将无法镂空（横琴口岸由手工环兜底不受影响）",
      );
    // 手工环并入：镂空面 = 澳大校区（官方环）+ 横琴口岸（手工环）
    const exclaveAll = [...exclave, HENGQIN_PORT_RING];
    const merged = unionBounds(bboxOf(macauRings), bboxOf(exclaveAll)) ?? MACAU_FALLBACK_BOUNDS;
    return {
      rings: macauRings,
      exclaveRings: exclaveAll,
      bounds: padBounds(merged),
      source: "district",
    };
  } catch {
    return { rings: [], exclaveRings: [], bounds: { ...MACAU_FALLBACK_BOUNDS }, source: "fallback" };
  }
}
