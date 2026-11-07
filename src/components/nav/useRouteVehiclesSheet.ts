"use client";

/**
 * 站序弹窗 · 在途车辆取数（src/components/nav/useRouteVehiclesSheet.ts，2026-11-06 · #6）
 *
 * ── 为什么不能复用 `useRouteVehicles`（`NavShell` 那一个）────────────────
 *   那个 hook 是**线路查看模式的宿主状态机**：它自带 `picked / dirs / selected / 冷却 /
 *   回前台补刷 / 观测钩子心跳`，并与 `NavMap`（画线 → 回报 `dirs`）双向耦合。
 *   站序弹窗只需要「**一帧**车辆」，把它接进来会产生两条互相覆盖的数据源
 *   （弹窗刷新一次、地图刷新一次 ⇒ 谁最后返回谁生效，且冷却计时互相打架）。
 *   ⇒ 新建本 hook，**只做取数**，不持有任何跨组件状态。
 *
 * ── 三条硬纪律（负责人裁决）─────────────────────────────────────────────
 *   ① **无轮询**：只在「弹窗打开」与「用户点刷新」时各取一次（`enabled` 变化 / `reload()`
 *      自增 `nonce`）。没有 `setInterval`，没有 `setTimeout` 重试。
 *   ② **轻轨零请求**：`kind !== "bus"` 直接不取（含轻轨与通琴号：前者无实时源，后者是
 *      静态时刻表）。四条出口都清空数据 ⇒ 调用方拿不到车辆 ⇒ 一行图标都不画。
 *   ③ **并发 ≤ 3**：本 hook 一轮最多两个请求（方向判定 1 + 车辆 1），且**串行**
 *      （方向必须先知道才能请求车辆）。
 *
 * ── 方向从哪来（★ 最容易踩的坑；**主次关系**见下，别为省一次请求改坏）──────
 *   `/api/route-vehicles` 的 `dir` 是**必填**（缺省回 400），而站序弹窗的 props 里
 *   原本没有方向 ⇒ 三级口径：
 *     ① props 给了 `dir` ⇒ 直接用 —— **首选主路径**（宿主 `NavShell` 传
 *        `rv.picked?.dir ?? null` 即可零额外请求；补齐后本 hook 自动短路到 ①）；
 *     ② 没给 ⇒ 读 `/api/route-shapes?code=`（**静态几何**，服务端 `max-age=3600`，
 *        且 `NavMap` 选线时已请求过同一 URL ⇒ 实际多为浏览器缓存命中，0 网络），
 *        再用 `pickDirByStops()` 按**首末站**判方向。
 *        ⚠️ 这一级**只是省一次请求的优化，不是主路径** —— 它的价值在"少一次往返"，
 *           不在"判得更准"。
 *     ③ 判定不出（无走向数据 / 无 `stations` / 两方向同首末站）⇒ **不取车辆、不画图标**。
 *
 *   🚩🚩 **第 ③ 级是安全底线，不是"保守的兜底"，删了它就是 bug** 🚩🚩
 *      「判不出方向 ↑ 随便挑一个（如 `usable[0]`）」的代价是**静默选错**：
 *      反向车照样有车牌、有状态、有几站 ⇒ 界面上画出**看起来完全正常**的图标，
 *      但那是**反方向**的另外几辆车；用户读到「还有 12 站到终点」而实际只剩 2 站。
 *      这种错**不报错、不空白、不告警**，比"没有图标"坏得多 ——
 *      没图标 ⇒ 用户知道没数据；显示错的 ⇒ 用户信了。
 *      ⇒ 要更多图标，正确做法是补 ①（宿主传 `dir`）或 ② 的数据质量（补 `route_shapes`），
 *        **绝不是放宽 ③**。
 *
 * ── 缓存口径 ────────────────────────────────────────────────────────────
 *   · 车辆帧：`cache: "no-store"`（实时量，必须穿透缓存 —— 负责人明确要求）；
 *   · 走向：**不加 no-store**（静态几何，故意吃浏览器 `max-age`）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { errorTextOf } from "@/lib/ui/error-text";
import type { RouteShapesResp } from "@/lib/line/line-shared";
import type { VehicleLite } from "./VehicleMarker";
import { pickDirByStops } from "./stops-veh-marks";

/** `/api/route-vehicles` 的单车原始形状（只声明本站序弹窗用到的字段） */
interface RawVehicle {
  plate: string;
  busCode?: string;
  lat: number;
  lng: number;
  status?: string;
  isLast?: boolean;
  interval?: VehicleLite["interval"];
  atStation?: VehicleLite["atStation"];
  progress?: VehicleLite["progress"];
}

interface VehiclesResp {
  error?: string;
  company?: string;
  fetchedAt?: string;
  badCar?: string[];
  vehicles?: RawVehicle[];
}

const VALID_STATES = new Set(["moving", "stopping", "terminal", "unknown"]);

/**
 * 「线路码 → 方向」的记忆表（模块级）。
 * 走向是静态数据（服务端 1h 缓存），因此本表**不需要失效**；命中即可省掉一次
 * `route-shapes` 的 JSON 解析（冷启时那份 polyline 有几十 KB）。
 */
const dirMemo = new Map<string, string | null>();

export interface UseRouteVehiclesSheetArgs {
  /** 弹窗是否打开（关闭时**不取数**，并清空上一帧） */
  open: boolean;
  kind: "bus" | "lrt" | "tqh";
  lineCode: string;
  /** 宿主已知的方向（`0` / `1`）；`null`/不传 ⇒ 走 `route-shapes` 判定（见文件头） */
  dir?: string | null;
  /** 本方向站序的**主码**（顺序即站序）；用于方向判定与「图标挂哪一行」 */
  stopMains: string[];
}

export interface UseRouteVehiclesSheetResult {
  vehicles: VehicleLite[];
  fetchedAt: string | null;
  fetching: boolean;
  /** 用户可读的失败文案（空串 = 无错） */
  error: string;
  /** 本轮实际取数用的方向（`null` = 没取 / 判不出方向） */
  usedDir: string | null;
  /** 用户点刷新 / 需要重取时调用（**唯一**的重取入口，没有内部轮询） */
  reload: () => void;
}

/** 判方向：`/api/route-shapes` → `pickDirByStops`（失败返回 `null`，不抛） */
async function resolveDir(code: string, stopMains: string[]): Promise<string | null> {
  if (dirMemo.has(code)) return dirMemo.get(code) ?? null;
  try {
    // ⚠️ 不传 `cache: "no-store"`：静态几何，故意吃浏览器 max-age（见文件头「缓存口径」）
    const r = await fetch(`/api/route-shapes?code=${encodeURIComponent(code)}`);
    const j = (await r.json()) as RouteShapesResp;
    const dir = pickDirByStops(j.shapes, stopMains);
    // 只缓存**判出来的**方向：`null`（该线暂时没有走向数据）不进记忆表 ⇒
    // 服务端补录走向后，用户下一次打开弹窗就能恢复图标（否则本会话内永久失去）。
    if (dir) dirMemo.set(code, dir);
    return dir;
  } catch {
    // 网络失败**不写记忆表**（否则一次抖动会让该线在本会话内永久失去图标）
    return null;
  }
}

export function useRouteVehiclesSheet({
  open,
  kind,
  lineCode,
  dir,
  stopMains,
}: UseRouteVehiclesSheetArgs): UseRouteVehiclesSheetResult {
  const [vehicles, setVehicles] = useState<VehicleLite[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const [usedDir, setUsedDir] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  /** 请求序号：快速换线/换向时丢弃过期响应（否则旧线的车会落到新线的站表上） */
  const seqRef = useRef(0);
  /** 站序主码的镜像：供 effect 读取最新值而不把它加进依赖（避免每次 map 生成新数组就重取） */
  const stopMainsRef = useRef<string[]>(stopMains);
  stopMainsRef.current = stopMains;
  /** 依赖用的稳定串（`stopMains` 每次渲染都是新数组 ⇒ 直接用会无限重取） */
  const stopKey = stopMains.join(",");

  /**
   * 只有三种情况都不成立才取数：
   * ① 弹窗关着；② 不是巴士（轻轨无实时源 / 通琴号是静态时刻表）；③ 站序还没到
   * （没有站序 ⇒ 一辆车都落不下去，取回来也是空转，白打一次 DSAT）。
   */
  const enabled = open && kind === "bus" && stopMains.length > 0;

  useEffect(() => {
    const seq = ++seqRef.current; // 任何一次重跑都让在途响应作废

    if (!enabled) {
      // 关窗 / 轻轨 / 通琴号 ⇒ 清空（绝不显示上一帧的"幽灵车"）
      setVehicles([]);
      setFetchedAt(null);
      setError("");
      setUsedDir(null);
      setFetching(false);
      return;
    }

    let cancelled = false;
    setFetching(true);

    void (async () => {
      try {
        const d = dir || (await resolveDir(lineCode, stopMainsRef.current));
        if (cancelled || seq !== seqRef.current) return;
        if (!d) {
          /**
           * 🚩 第 ③ 级：**判不出方向 ⇒ 不取、不画**。
           * 这一行是安全底线，不是"保守"：`dir` 随便猜一个也能返回一堆车，界面上
           * 会画出看起来完全正常的图标，但那是**反方向**的车（静默选错，没人会发现）。
           * 反向车的「还有 N 站」比没有图标坏得多 ⇒ 任何"为了多显示图标"而放宽这里
           * 的改动都是 bug（详见文件头「方向从哪来」）。
           */
          setVehicles([]);
          setFetchedAt(null);
          setUsedDir(null);
          setError("");
          return;
        }
        setUsedDir(d);

        const r = await fetch(
          `/api/route-vehicles?code=${encodeURIComponent(lineCode)}&dir=${encodeURIComponent(d)}&kind=bus&progress=1`,
          { cache: "no-store" },
        );
        const j = (await r.json()) as VehiclesResp;
        if (cancelled || seq !== seqRef.current) return;

        if (j.error) {
          setError(errorTextOf(j.error));
          setVehicles([]);
          setFetchedAt(null);
          return;
        }

        const bad = new Set(j.badCar ?? []);
        const list: VehicleLite[] = (j.vehicles ?? []).map((v) => {
          const raw = String(v.status ?? "");
          return {
            plate: v.plate,
            // ⚠️ `?? undefined`（不是 null）：后端刻意让「缺键」表达缺席，这里保持同一语义
            busCode: v.busCode ?? undefined,
            lat: v.lat,
            lng: v.lng,
            status: bad.has(v.plate)
              ? "lost"
              : ((VALID_STATES.has(raw) ? raw : "unknown") as VehicleLite["status"]),
            isLast: !!v.isLast,
            interval: v.interval ?? null,
            atStation: v.atStation ?? null,
            progress: v.progress ?? null,
            company: j.company,
          };
        });
        setVehicles(list);
        setFetchedAt(j.fetchedAt ?? new Date().toISOString());
        setError("");
      } catch {
        if (cancelled || seq !== seqRef.current) return;
        // 网络/解析失败 ⇒ 空列表（不画图标），文案给用户看；**绝不**用假数据顶上
        setError("车辆位置获取失败");
        setVehicles([]);
        setFetchedAt(null);
      } finally {
        if (!cancelled && seq === seqRef.current) setFetching(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `stopKey` 而非 `stopMains`：后者每次渲染都是新数组（见上）
  }, [enabled, lineCode, dir, stopKey, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { vehicles, fetchedAt, fetching, error, usedDir, reload };
}
