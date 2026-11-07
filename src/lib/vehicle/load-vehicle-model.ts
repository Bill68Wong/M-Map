/**
 * 车型规格取数（src/lib/vehicle/load-vehicle-model.ts）
 *
 * ── 分层位置 ──────────────────────────────────────────────────────────
 *   `api/vehicle-model/route.ts`（只校验参数 + 组装响应）
 *     → 本文件（**唯一**能碰 `pg` 的一层：查 `vehicle_plates` + `bus_models`）
 *       → `model-resolve.ts`（纯判定，零依赖）
 *   route 里**不允许**写 SQL（`route-vehicles/route.ts` 已 299 行满载，且本项目
 *   route 有导出白名单约束，辅助函数一律只能放 lib）。
 *
 * ── 为什么一次把 `bus_models` 整表取回来 ───────────────────────────────
 *   该表**只有十几行**、内容静态、命中率 100%（每次都要按区间挑行）。
 *   用三条精确 SQL 反而更慢也更难保证口径一致：
 *   「型号已知」与「型号未知」两条分支各自拼 WHERE，很容易写着写着就分叉
 *   （典型症状：一条分支忘了带 company 过滤 ⇒ 悄悄跨运营商借规格）。
 *   整表取 + 纯函数判定 ⇒ **只有一套判定逻辑**，且与迁移脚本 / 单测逐字符相同。
 *   实测代价：单表 17 行的全表扫描 ≈ 一次索引点查，可忽略。
 *
 * ── ★ 为什么主查询要分「按 plate」和「按 bus_code」两条路（v3.8.0）───────
 *   `plate` 是 `PRIMARY KEY`（`db/migrate-vehicle-plates.ts:57`）；
 *   `bus_code` 只是**普通索引**（同文件 `:73` 的 `CREATE INDEX`，**非 UNIQUE**）。
 *   ⇒ 按 `bus_code` 查**物理上可能返回多行**，取哪行由 PG 决定（VACUUM / 更新后会变）。
 *   后果：同一台车今天显示 A 车型、明天显示 B 车型，**不报错、不留痕**。
 *   今天 667 台恰好每个 `bus_code` 只有一行，纯属数据巧合 ——
 *   **规格是「plate 是主键，bus_code 从来不是数据库承诺的唯一键」**，不能靠巧合运行。
 *   ⇒ 有 `plate` 就走主键点查（不可能多行，也不需要排序语义）；
 *     只有 `code` 时（新车第一帧：前端手上只有 DSAT 的 `busCode`）走索引查询，
 *     **必须**给确定性排序，见下方 `ORDER BY plate` 的注释。
 *
 * `server-only`：含 `pg`，客户端组件禁止 import。
 */
import type { Pool } from "pg";
import { getPool } from "@/lib/db";
import { modelOf, parseBusCode } from "@/lib/dsat/vehicle-models";
import { normalizePlate } from "@/lib/dsat/vehicle-plates";
import type { BusModelSpec, VehicleModelResult } from "./model-shared";
import { normalizeBusCode, resolveVehicleModel } from "./model-resolve";

/** `bus_models` 的读取列（与 `BusModelSpec` 一一对应，顺序无关） */
const SPEC_COLS = `spec_key, model_code, company, maker, display_name,
  seats, seats_raw, standing, wheelchair, length_mm, width_mm, height_mm,
  style, bus_code_prefix, bus_code_from, bus_code_to, bus_code_range_raw,
  remark, source, confidence`;

interface SpecDbRow {
  spec_key: string;
  model_code: string;
  company: string;
  maker: string | null;
  display_name: string;
  seats: number | null;
  seats_raw: string | null;
  standing: number | null;
  wheelchair: number | null;
  length_mm: number | null;
  width_mm: number | null;
  height_mm: number | null;
  style: string | null;
  bus_code_prefix: string | null;
  bus_code_from: number | null;
  bus_code_to: number | null;
  bus_code_range_raw: string | null;
  remark: string | null;
  source: string | null;
  confidence: string | null;
}

const toSpec = (r: SpecDbRow): BusModelSpec => ({
  specKey: r.spec_key,
  modelCode: r.model_code,
  company: r.company,
  maker: r.maker,
  displayName: r.display_name,
  seats: r.seats,
  seatsRaw: r.seats_raw,
  standing: r.standing,
  wheelchair: r.wheelchair,
  lengthMm: r.length_mm,
  widthMm: r.width_mm,
  heightMm: r.height_mm,
  style: r.style,
  busCodePrefix: r.bus_code_prefix,
  busCodeFrom: r.bus_code_from,
  busCodeTo: r.bus_code_to,
  busCodeRangeRaw: r.bus_code_range_raw,
  remark: r.remark,
  source: r.source,
  confidence: r.confidence,
});

/** `vehicle_plates` 里本接口用到的那几列 */
interface PlateRow {
  plate: string;
  bus_code: string | null;
  model: string | null;
  company: string | null;
  bus_type: string | null;
}

const PLATE_COLS = `plate, bus_code, model, company, bus_type`;

/**
 * 车号 / 车牌 → 车型规格。
 *
 * 取数顺序（与 `resolveVehicleModel` 的判定顺序一致）：
 *   1. `vehicle_plates` 取一行：`plate` 有值 ⇒ 主键点查；未命中且 `code` 有值 ⇒ 按 `bus_code` 兜底
 *   2. `bus_models` 整表（十几行）
 *   3. 纯函数判定（库里的型号 → `modelOf()` 区段表 → 规格库自带区间 → 三/四态兜底）
 *
 * ⚠️ `bus_models` 表不存在时**不抛 500**：降级为「只有型号、没有规格」
 *   （`specs: []`）。理由：本接口是给弹窗补充信息的增强项，
 *   因为一次没跑的迁移就让弹窗整块失败，收益为负。
 *
 * @param input.plate 车牌（`?plate=`，主键；未归一，函数内部会大写+去空白）
 * @param input.code  车队编号（`?code=`，未归一）。两者都给时 **plate 优先**
 * @param pool        便于测试注入；默认取全局池
 */
export async function loadVehicleModel(
  input: { plate?: string | null; code?: string | null },
  pool: Pool = getPool(),
): Promise<VehicleModelResult> {
  const plateKey = normalizePlate(input.plate);
  const codeKey = normalizeBusCode(input.code ?? "");

  // ── 1① 主键点查：`WHERE plate = $1` 物理上不可能多行 ⇒ 不需要 ORDER BY / LIMIT 语义
  let plateRow: PlateRow | undefined;
  if (plateKey) {
    const byPlate = await pool.query(`SELECT ${PLATE_COLS} FROM vehicle_plates WHERE plate = $1`, [
      plateKey,
    ]);
    plateRow = (byPlate.rows[0] as PlateRow | undefined) ?? undefined;
  }

  // ── 1② 车牌未命中（或没给车牌）才按 `bus_code` 兜底 —— 新车第一帧的兼容路径。
  //      `bus_code` 只有普通索引 ⇒ **可能多行**，故必须给确定性排序：
  //        · 不用 `last_seen_at DESC`：它的语义是"上次有人查了它所在线路的时间"，
  //          实测 206 台（30.9%）超过 7 天未更新，用它排序会选到已退役的车；
  //        · 不用 `calibrated_at DESC`：它只在有型号时才写（`vehicle-plates.ts:156`），
  //          是 `model` 有无的镜像（264 有值 / 403 NULL），不承载"活跃度"；
  //        · 用 `ORDER BY plate`：**纯确定性，不伪装任何语义**。多行时选哪行不重要
  //          （同车号多行本身是脏数据），重要的是**每次都选同一行**。
  if (!plateRow && codeKey) {
    const byCode = await pool.query(
      `SELECT ${PLATE_COLS} FROM vehicle_plates WHERE bus_code = $1 ORDER BY plate LIMIT 1`,
      [codeKey],
    );
    plateRow = (byCode.rows[0] as PlateRow | undefined) ?? undefined;
  }

  /**
   * 响应用的 `busCode`：**以行里的 `bus_code` 为准**，绝不回显请求参数。
   * 按 `plate` 命中时请求里根本没有 `code`，用参数会让返回体的 `busCode` 变成空串。
   * 行里 `bus_code` 为空（该车没采到编号）时回落用请求的 `code` —— 这是唯一还能反推
   * 型号的线索（前端既然同时给了 plate + code，就说明它认为两者同属一台车），
   * 且不落库、只影响本次响应；两者都没有才是空串。
   */
  const busCode = normalizeBusCode(plateRow?.bus_code ?? "") || codeKey;

  let specs: BusModelSpec[] = [];
  try {
    const specRes = await pool.query(`SELECT ${SPEC_COLS} FROM bus_models`);
    specs = (specRes.rows as SpecDbRow[]).map(toSpec);
  } catch (e) {
    // 表未建 / 权限不足 ⇒ 降级（不是致命错误，见函数注释）
    console.warn("[vehicle-model] bus_models 读取失败，降级为无规格：", (e as Error).message);
  }

  return resolveVehicleModel({
    busCode,
    foundInDb: !!plateRow,
    dbModel: plateRow?.model ?? null,
    dbCompany: plateRow?.company ?? null,
    dbBusType: plateRow?.bus_type ?? null,
    // 复用既有静态区段表（`src/lib/dsat/vehicle-models.ts`），不在本模块重写区间逻辑
    rangeModel: parseBusCode(busCode) ? (modelOf(busCode)?.model ?? null) : null,
    specs,
  });
}
