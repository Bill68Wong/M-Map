"use client";

/**
 * 车辆匹配 · 里程样本维护与调用壳（src/components/nav/vehicle-match-run.ts，★ v3.7.0 S3）
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────
 *   `useRideTracking` 已 1400+ 行。匹配需要「跨帧状态」（用户里程环 + 车牌→车辆里程环 +
 *   排除名单），这些是**纯数据搬运**，与 React 无关 ⇒ 抽出来既能让 hook 只加十几行，
 *   也能在 `.verify/` 里脱离浏览器直接单测。
 *
 * ── 三条纪律（都来自 `match-vehicle.ts` 的契约，别在这里改判据）──────────
 *   1. **不做跨调用累积**：每次 `run()` 都拿整个 90s 窗口重算，绝不复用上一次的 `logL`
 *      （窗口在相邻两次 12s 调用间高度重叠，复用 = 同一批帧被重复计入 = 静默误锁）；
 *   2. **样本与算法同源（含 `colored`）**：车辆里程一律用
 *      `vehicleMileOf(v, mains, ladder, colored)` 计算 —— **必须与 `matchVehicle` 内部完全同参**。
 *      ⚠️ 反过来曾经的写法（这里**不传** `colored`）是一个陷阱，别改回去：
 *      算法侧对「无 `progress` 也无 `atStation`」的车靠**同轴投影**拿里程（约 4% 的车），
 *      而录制侧若不传 `colored` ⇒ 这些车的样本恒为 `dM: null` ⇒ `inWindow` 全滤掉 ⇒
 *      历史只剩当帧 1 条 ⇒ `frames = 1` ⇒ 被 `gate:frames` 拦下 ⇒ **永远只能 low**。
 *      净效果是「跳过原因从 `skip:no-mile` 换成 `gate:frames`」，覆盖率一点没涨。
 *   3. **没有样本就不垫假数据**：算不出 `dM` 的车仍照实写 `dM: null`（由 `inWindow` 过滤），
 *      **不**用 0 或插值冒充（那会让 S1 的残差凭空变小）。
 *
 * ⚠️ `MATCH_VEHICLE_ENABLED` 默认 **false**：本模块在关闭时**一次也不会被调用**，
 *    调用方要自己先用开关短路（见 `useRideTracking` 的接线处）。
 */
import {
  MATCH_MEDIUM_MIN_FRAMES,
  MATCH_S4_WINDOW_MS,
  MATCH_WINDOW_MS,
  matchVehicle,
  type MatchInput,
  type MatchResult,
  type MileSample,
} from "@/lib/nav/match-vehicle";
import { vehicleMileOf } from "@/lib/nav/match-mile";
import type { LL } from "@/lib/nav/route-overview";
import type { LrtLadder } from "@/lib/nav/lrt-progress";
import type { TrackVehicle } from "@/lib/nav/track";

/** 历史保留上限：S4 窗口（120s）与证据窗口（90s）取大，再多留一格抖动余量 */
const KEEP_MS = MATCH_S4_WINDOW_MS + 15_000;

export interface RunArgs {
  /** 本段乘车折线；`null` = 无几何 ⇒ 不判 */
  colored: LL[] | null;
  /** 站点里程阶梯（`buildLrtLadder`）；`null` = 尚未就绪 ⇒ 不判 */
  ladder: LrtLadder | null;
  /** 与 `ladder.ladder` 下标对齐的站主码 */
  stopMains: string[];
  /** 本帧**该线路该方向全部在途车**（不是只有上车站那几辆） */
  vehicles: TrackVehicle[];
  /** 用户沿线里程（`advanceLrt` 的 `distNow`）；`null` = 不可信/无锚 */
  dUser: number | null;
  nowMs: number;
  /** 最新定位精度（米） */
  userAccuracyM?: number | null;
  /** 显式覆盖开关（灰度 / 单测）；缺省读 `MATCH_VEHICLE_ENABLED` */
  enabled?: boolean;
}

export interface VehicleMatcher {
  /** 新的一帧用户定位（`dM` 已知才记；未知也记一条 `dM:null` 供窗口判断） */
  noteUser: (ts: number, dM: number | null) => void;
  /** 「不是这辆」：本段生命周期内累积排除（算法不变量：不得复用被排除的车牌） */
  exclude: (plate: string) => void;
  /** 车辆帧到达时调用一次（12s 一次；**不要**每帧 GPS 都调） */
  run: (args: RunArgs) => MatchResult;
  /** 本段最近一次结果（`null` = 还没跑过） */
  last: () => MatchResult | null;
  /** 换段 / 重置时清空（排除名单与历史一起清 — 它们只对本段有效） */
  reset: () => void;
}

export function createVehicleMatcher(): VehicleMatcher {
  let userHist: MileSample[] = [];
  const vehHist = new Map<string, MileSample[]>();
  let excluded: string[] = [];
  let lastResult: MatchResult | null = null;
  /** 每辆车上一次写入的时刻（避免同一 `nowMs` 重复写） */
  const lastVehTs = new Map<string, number>();

  const prune = (arr: MileSample[], nowMs: number): MileSample[] =>
    arr.filter((s) => s.ts <= nowMs && nowMs - s.ts <= KEEP_MS);

  return {
    noteUser(ts, dM) {
      const prev = userHist[userHist.length - 1];
      // 同一时刻只留一条（GPS 节流后同一 ts 不会重复，但重订阅瞬间可能撞上）
      if (prev && prev.ts === ts) userHist[userHist.length - 1] = { ts, dM };
      else userHist.push({ ts, dM });
      userHist = prune(userHist, ts);
    },

    exclude(plate) {
      if (plate && !excluded.includes(plate)) excluded.push(plate);
    },

    run(args) {
      const now = args.nowMs;
      userHist = prune(userHist, now);
      /* ① 先把本帧车辆里程记进历史（与 `matchVehicle` 内部同入参，见文件头纪律 2） */
      if (args.ladder && args.stopMains.length >= 2) {
        for (const v of args.vehicles) {
          if (lastVehTs.get(v.plate) === now) continue;
          // 与 `matchVehicle`（`match-score.ts` 的 `scoreVehicle`）**同参**：必须带 colored，
          // 否则那 ~4% 无 progress/atStation 的车永远只有当帧 1 样本 ⇒ 恒被 gate:frames 拦下
          const dM = vehicleMileOf(v, args.stopMains, args.ladder, args.colored ?? []);
          const arr = prune(vehHist.get(v.plate) ?? [], now);
          arr.push({ ts: now, dM });
          vehHist.set(v.plate, arr);
          lastVehTs.set(v.plate, now);
        }
        /* 清掉早就离开本线的车的记忆（否则 90s 后回来的同车牌会带着陈旧序列） */
        for (const [plate, arr] of vehHist) {
          if (!arr.length || now - arr[arr.length - 1]!.ts > KEEP_MS) vehHist.delete(plate);
        }
      }

      /* ② 组装输入并调用（`enabled` 原样透传：关闭 ⇒ 算法自己返回 low，不产生副作用） */
      /** 空阶梯（几何/阶梯未就绪时用）—— 结构与 `LrtLadder` 一致，让硬门 `g1` 去否决 */
      const EMPTY_LADDER: LrtLadder = { path: [], ladder: [], valid: [] };
      const input: MatchInput = {
        colored: args.colored ?? [],
        ladder: args.ladder ?? EMPTY_LADDER,
        dUser: args.dUser,
        userSpeedKmh: null, // 由 `userHistory` 推算（避免与 GPS 原始速度口径打架）
        vehicles: args.vehicles,
        excludedPlates: excluded,
        nowMs: now,
        stopMains: args.stopMains,
        userAccuracyM: args.userAccuracyM ?? undefined,
        userHistory: userHist,
        vehicleHistory: Object.fromEntries(vehHist),
        enabled: args.enabled,
      };
      const res = matchVehicle(input);
      lastResult = res;
      return res;
    },

    last: () => lastResult,

    reset() {
      userHist = [];
      vehHist.clear();
      lastVehTs.clear();
      excluded = [];
      lastResult = null;
    },
  };
}

/**
 * `medium` 是否可用（★ v3.7.0 复核）：
 *   `match-vehicle.ts` 目前的 medium 分支**只判 `logL` 与 `score`**，
 *   `MATCH_MEDIUM_MIN_FRAMES`（=2）虽已定义却**未被读取** ⇒ 单帧即可出 medium。
 *   单帧 medium 会把「停靠在站的车」靠 `atStation` 里程锁成「我的车」，而契约明确
 *   **medium 不得据以报站** ⇒ 调用侧必须先按帧数门再决定认不认。
 *   （根因在后端那侧，已上报；此处是调用方兜底，不是绕过判据。）
 */
export function usableMedium(res: MatchResult): boolean {
  return res.confidence === "medium" && res.frames >= MATCH_MEDIUM_MIN_FRAMES && res.plate != null;
}

export { MATCH_WINDOW_MS };
