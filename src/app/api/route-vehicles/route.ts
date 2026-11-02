/**
 * GET /api/route-vehicles?code=26&dir=0 —— 某巴士线路**当前方向的在途车辆**（v2.10.0 新增）
 *
 * ── 定位（Spec §5.1）───────────────────────────────────────────────────
 *   M Map「路线查看模式」选中一条巴士线后，把在途车画在地图上（手动刷新 + 10s 冷却）。
 *   本接口只负责**车辆数据**：坐标 + 车牌 + 状态 + 行驶区间 + 运营商配色。
 *
 * ── 坐标口径（★ 极易踩坑）──────────────────────────────────────────────
 *   DSAT 位置接口给的是 **WGS84**；高德地图用 **GCJ-02**。本接口在**服务端**统一
 *   经 `wgs84ToGcj02` 转换后输出（前端**不再转**）——口径与 `/api/stations` 一致，
 *   转换算法已与高德官方逐点比对（最大差 0.32m，见 src/lib/amap/coord.ts）。
 *
 * ── 为什么要**并行发两个 DSAT 请求**（不是合并）─────────────────────────
 *   位置接口（`/routestation/location`）只给「每辆车 lat/lng」，**不含站序**；
 *   报站接口（`/routestation/bus`）只给「挂载站 + status」，**不含坐标**。
 *   两者结构上互为补集，批量实测也证明**无法合并**（docs/DSAT巴士接口调研.md §2.5.6/§2.5.7）。
 *   ⇒ 只能 `Promise.all` 各发一趟（各自独立超时），再按 `busPlate` 合并。
 *   （实测并行墙钟 68ms，串行 451ms。）
 *
 * ── 降级（AC-08）──────────────────────────────────────────────────────
 *   · **报站失败**：仍返回车辆（坐标 + 车牌来自位置接口），`interval:null` / `status:"unknown"`；
 *     ★ v3.6.1：`busCode` 随之**整体缺席**（该字段只存在于报站接口，见 `Vehicle.busCode` 注释）。
 *   · **位置失败**：无坐标可落点 ⇒ `vehicles: []`；
 *   · 超时 / 异常**一律收敛为空数组**，**绝不 500**（参照 `/api/station/eta` 的容错写法）。
 *
 * ── 轻轨（AC-02）──────────────────────────────────────────────────────
 *   DSAT 是巴士系统、**无轻轨数据**（Spec §3 实测穷尽）⇒ `LRT-*` 直接返回空数组 + `note:"lrt_no_vehicle"`，不调 DSAT、不报错。
 *
 * ── 风控 ──────────────────────────────────────────────────────────────
 *   两处 DSAT 调用均以 `purpose="live_pos"` 记账 —— 只记账、**不参与熔断判定**
 *   （像 recommend 一样）。否则用户连点刷新一旦失败就撞开全局熔断，
 *   会把计时器的自动车距快照一起静默 30 分钟（见 src/lib/risk.ts）。
 *
 * 只读接口，无副作用。
 * ⚠️ 本文件已满载 300 行（门禁上限）：新增逻辑请抽到 `src/lib/nav/dsat-fields.ts` 或另建模块，勿在此堆积。
 */
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { API_ERROR } from "@/lib/http/errors";
import { attachProgress, type VehicleProgress } from "@/lib/nav/progress";
import { getBusLocations, getBusPositions } from "@/lib/dsat/client";
import { wgs84ToGcj02 } from "@/lib/amap/coord";
import { recordVehiclePlatesAsync } from "@/lib/dsat/vehicle-plates";
// 站码/数值/超时归一：与 `/api/station/eta` 共用同一份实现（原为两处逐字重复）
import { withTimeout, numOrNull, mainCode, stripCodePrefix } from "@/lib/nav/dsat-fields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** 整体超时兜底（毫秒）：两个 DSAT 调用各自另有超时，这里再兜一层，到点按「无数据」返回 */
const TOTAL_TIMEOUT_MS = 6_000;

interface StopRef {
  code: string;
  name: string;
}

interface Vehicle {
  plate: string;
  busType: string | null;
  /**
   * ★ v3.6.1 新增：**车队编号**（DSAT `busCode`，如 `HE380`/`E3222`）。UI 在车牌行居右
   * 显示编号角标（主人需求：「在巴士车牌那一行居右制作…如标签 HE380」）。
   *
   * ⚠️ 契约（只增不改）：取不到就**整个键省略**，不输出 `null`/空串（避免误判"有编号但为空"）。
   *   型号名映射在库里（`vehicle_plates`）；**本接口只吐编号**，不吐型号名。
   *
   * ⚠️⚠️ **不可假设恒定存在**（实测约 99.6%，非 100%）：坐标与编号来自两个**独立并行**
   *   接口（location 给坐标 / bus 给编号，见文件头），某车在「位置已上报、报站未挂上」的
   *   瞬间即「有坐标无编号」—— 两轮全量扫描 743 车次中 3 例（约 0.4%），**下一帧即恢复**。
   *   ⇒ 前端须写 `v.busCode && <Badge/>`；用 `!== null` 会把 `undefined` 判成有值 → 空角标。
   *   也**不要**加骨架屏/占位：约 99.6% 的正常情况会被白占一块空白。
   */
  busCode?: string;
  /** GCJ-02 纬度 */
  lat: number;
  /** GCJ-02 经度 */
  lng: number;
  /** ★ v3.6.0：`speed` 已从出口删除（DSAT 该字段延迟极大、不可信，不做任何参考） */
  status: "moving" | "stopping" | "terminal" | "unknown";
  isLast: boolean;
  interval: { from: StopRef; to: StopRef } | null;
  atStation: StopRef | null;
  /** ★ v3.4.0：区间进度（`?progress=1` 时填充；详见 src/lib/nav/progress.ts） */
  progress?: VehicleProgress;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const code = sp.get("code")?.trim() ?? "";
  const dir = sp.get("dir")?.trim() ?? "";
  const kindParam = sp.get("kind")?.trim() ?? "";

  // ① 参数校验（缺参数 = 客户端错误，返回 400）
  // ★ v3.6.0（AC-50d）：`error` 只允许六枚举。`useRouteVehicles` 已用
  //   `errorTextOf(j.error)` 翻译 ⇒ 旧中文串会被当未知值回落到通用文案。
  if (!code) {
    return NextResponse.json({ error: API_ERROR.bad_request }, { status: 400 });
  }
  if (dir !== "0" && dir !== "1") {
    return NextResponse.json({ error: API_ERROR.bad_request }, { status: 400 });
  }

  const fetchedAt = new Date().toISOString();
  const headers = { "Cache-Control": "no-store" };

  try {
    // ② 线路元数据（color/company/kind）—— 前端画线/图标要用；轻轨分支也要
    let kind: "bus" | "lrt" = code.startsWith("LRT-") || kindParam === "lrt" ? "lrt" : "bus";
    let color: string | null = null;
    let company: string | null = null;
    try {
      const r = await getPool().query(
        `SELECT kind, color, company FROM routes WHERE code = $1 LIMIT 1`,
        [code],
      );
      const row = r.rows[0] as { kind?: string; color?: string | null; company?: string | null } | undefined;
      if (row) {
        kind = row.kind === "lrt" ? "lrt" : "bus";
        color = row.color ?? null;
        company = row.company ?? null;
      }
    } catch (e) {
      console.warn("[api/route-vehicles] routes 元数据查询失败（继续）：", (e as Error).message);
    }

    // ③ 轻轨：无车辆数据 ⇒ 直接返回空 + note，绝不碰 DSAT
    if (kind === "lrt" || code.startsWith("LRT-")) {
      return NextResponse.json(
        {
          code,
          dir,
          kind: "lrt",
          fetchedAt,
          color,
          company,
          lastBusPlate: null,
          badCar: [],
          vehicles: [],
          note: "lrt_no_vehicle",
        },
        { headers },
      );
    }

    // ④ 并行发两个 DSAT 请求（各自独立超时；整体再兜一层）
    const [locRes, posRes] = await withTimeout(
      Promise.all([getBusLocations(code, dir), getBusPositions(code, dir, "live_pos")]),
      TOTAL_TIMEOUT_MS,
    ).catch((): [null, null] => [null, null]);

    const locData = locRes?.ok ? locRes.data : undefined;
    const posData = posRes?.ok ? posRes.data : undefined;
    const stationBlocks = posData?.routeInfo ?? [];

    // ⑤ 站点名表：优先取位置接口自带的 stationInfoList（含站名，无需额外查库）
    const nameOf = new Map<string, string>();
    for (const s of locData?.stationInfoList ?? []) {
      if (!s?.stationCode || !s?.stationName) continue;
      const main = mainCode(String(s.stationCode));
      if (!nameOf.has(main)) nameOf.set(main, stripCodePrefix(String(s.stationName)));
    }

    const stopRef = (raw: string): StopRef => {
      const main = mainCode(raw);
      return { code: main, name: nameOf.get(main) ?? main };
    };

    // ⑥ 挂载站索引：车牌 → { 站序, 站码, status, 车队编号 }
    //    status '1' = 停靠挂载站；'0' = 已离挂载站、正驶向下一站（挂载站=刚离的站，非下一站）
    //    ★ `busCode`（车队编号）只在这里出现（位置接口不含它），故与挂载信息一起收进索引，
    //      供 §⑧ 的 vehicle_plates 标定使用 —— 同一次响应白送，不额外发请求。
    const mountOf = new Map<string, { idx: number; code: string; status: string; busCode: string | null }>();
    for (let i = 0; i < stationBlocks.length; i++) {
      const code0 = stationBlocks[i].staCode != null ? String(stationBlocks[i].staCode) : "";
      for (const bus of stationBlocks[i].busInfo ?? []) {
        const plate = String(bus.busPlate ?? "").trim();
        if (!plate) continue;
        mountOf.set(plate, {
          idx: i,
          code: code0,
          status: String(bus.status ?? ""),
          busCode: bus.busCode != null ? String(bus.busCode).trim() : null,
        });
      }
    }

    const lastBusPlateRaw = locData?.lastBusPlate ?? posData?.lastBusPlate ?? null;
    const lastBusPlate = lastBusPlateRaw != null ? String(lastBusPlateRaw).trim() : null;
    const lastIdx = stationBlocks.length - 1;

    // ⑦ 按 busPlate 合并：以**位置接口**为基（有坐标才画得出点），报站信息按车牌补齐
    const vehicles: Vehicle[] = [];
    for (const b of locData?.busInfoList ?? []) {
      const plate = String(b.busPlate ?? "").trim();
      const lat = numOrNull(b.latitude);
      const lng = numOrNull(b.longitude);
      if (!plate || lat === null || lng === null) continue;

      // 服务端坐标转换 WGS84 → GCJ-02
      const gcj = wgs84ToGcj02({ lat, lng });

      let status: Vehicle["status"] = "unknown";
      let interval: { from: StopRef; to: StopRef } | null = null;
      let atStation: StopRef | null = null;

      const m = mountOf.get(plate);
      if (m) {
        if (m.status === "1") {
          // 停靠中：在首/末站 ⇒ 总站待发（terminal），否则普通停靠（stopping）
          atStation = stopRef(m.code);
          status = m.idx === 0 || m.idx === lastIdx ? "terminal" : "stopping";
        } else if (m.status === "0") {
          // 已离挂载站、驶向下一站 ⇒ 区间 = 挂载站 → 下一站
          status = "moving";
          const next = stationBlocks[m.idx + 1];
          if (next?.staCode != null) interval = { from: stopRef(m.code), to: stopRef(String(next.staCode)) };
        }
      }

      // ★ v3.6.1：车队编号（来自报站接口的 `busCode`）。取不到 ⇒ 该键整个不出现。
      //   刻意不用 `busCode: undefined` 占位 —— JSON.stringify 本会省略 undefined，
      //   但显式条件展开更能表达「缺席是语义」这一意图，也避免将来序列化方式变化时行为漂移。
      const busCode = m?.busCode && m.busCode !== "" ? m.busCode : null;

      vehicles.push({
        plate,
        busType: b.busType != null ? String(b.busType) : null,
        ...(busCode ? { busCode } : {}),
        lat: gcj.lat,
        lng: gcj.lng,
        status,
        isLast: !!lastBusPlate && plate === lastBusPlate,
        interval,
        atStation,
      });
    }

    // ⑦-c 车牌 ↔ 车队编号 ↔ 车型 标定入库（2026-10-30 主人拍板「对应数据入库」）：
    //   同一次响应已含 busPlate/busCode/busType ⇒ **零额外请求**，只是把本会丢的对应关系存下。
    //   即发即忘（after()）：任何失败只 warn，不影响也不拖慢车辆位置返回。
    recordVehiclePlatesAsync(
      vehicles.map((v) => ({
        plate: v.plate,
        busCode: mountOf.get(v.plate)?.busCode ?? null,
        busType: v.busType,
      })),
    );

    let note: string | undefined;
    if (!locData) note = "dsat_locations_unavailable";
    else if (!posData) note = "dsat_positions_unavailable"; // 降级：仅坐标+车牌，区间/状态留空

    // ⑦-b ★ v3.4.0：区间进度（`?progress=1`）——坐标投影 → 相对进度 p + 位置模型剩余。
    //   任何一环缺失（无几何/无里程/无时长）→ 该车不带 progress 字段（调用方降级用逐跳）。
    if (sp.get("progress") === "1" && vehicles.length) {
      try {
        await attachProgress(getPool(), code, dir, vehicles);
      } catch (e) {
        console.warn("[api/route-vehicles] progress 计算失败（忽略）：", (e as Error).message);
      }
    }

    return NextResponse.json(
      {
        code,
        dir,
        kind: "bus",
        fetchedAt,
        color,
        company,
        lastBusPlate,
        badCar: locData?.badCar ?? [],
        vehicles,
        ...(note ? { note } : {}),
      },
      { headers },
    );
  } catch (e) {
    // 任何未预期异常 → 收敛为空数组，绝不 500 阻塞地图
    console.warn("[api/route-vehicles] 失败（收敛为空）：", (e as Error).message);
    return NextResponse.json(
      {
        code,
        dir,
        kind: "bus",
        fetchedAt,
        color: null,
        company: null,
        lastBusPlate: null,
        badCar: [],
        vehicles: [],
        note: "internal_error",
      },
      { headers },
    );
  }
}
