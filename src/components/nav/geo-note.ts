"use client";

/**
 * 定位状态 → 说明文案（src/components/nav/geo-note.ts，★ v3.7.0 S2 · AC2.3）
 *
 * ── 为什么必须分档 ────────────────────────────────────────────────────
 *   负责人的原始诉求里有一条「**无法继续获取用户实时定位**」。只说「定位不可用」时，
 *   用户不知道该做哪件事 —— 而三种情况要做的动作**完全不同**：
 *     · 权限没开 ⇒ 只有「去设置里允许」能解决（在现场怎么走都没用）；
 *     · 没信号   ⇒ 走到开阔处就会恢复（去设置里看也看不出问题）；
 *     · 超时     ⇒ 系统会自己再要一次，等一下就好。
 *   所以文案必须各自点到那个动作，且**三者互不相同**（测试按语义词断言，不绑字面）。
 *
 * ── 两档「不是错误」的，别混进去 ────────────────────────────────────────
 *   · `low_acc`（精度差但仍有位置）⇒ 导航照常工作，只是判定门槛达不到；
 *   · `stale`（30s 无新帧）⇒ 数据稍旧。
 *   这两档**不得**用「不可用 / 失败 / 无法」这类警报词吓用户，只陈述事实 + 给出下一步。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   纯函数、无 React、无副作用 ⇒ 可被 `.verify/` 直接单测（文案改动必须过文案门禁）。
 *   ⚠️ 本模块的字符串会**直接上屏**，改字前先跑 `.verify/check-ui-copy.mjs`（43 禁用词）。
 */
import type { GeoState } from "./observe-hooks";

/** 判定暂停、且定位轴处于 `ok`（暂停与定位无关）时的兜底句 */
export const NOTE_GPS_UNAVAILABLE = "定位不可用 · 自动上车判断已暂停，上车后请点「手动标记上车」";

/** 权限被拒（`GeolocationPositionError.code === 1`）—— 语义词「设置」 */
export const NOTE_GEO_DENIED = "定位权限没开 · 到系统「设置」里允许定位后自动恢复，也可上车后点「手动标记上车」";
/** 无信号 / 位置不可用（`code === 2`：隧道、室内、地下停车场）—— 语义词「信号」 */
export const NOTE_GEO_WEAK = "暂时收不到定位信号 · 走到开阔处会自动恢复，也可上车后点「手动标记上车」";
/** 取位超时（`code === 3`）—— 语义词「重试」 */
export const NOTE_GEO_TIMEOUT = "定位超时，正在自动重试 · 也可上车后点「手动标记上车」";
/** 精度差但仍能用（**不是错误**）：不用警报词，只陈述事实 */
export const NOTE_GEO_LOW_ACC = "定位精度偏低 · 暂时无法自动判断上车，上车后请点「手动标记上车」";
/** 长时间无新帧（**不是错误**）：数据稍旧，同样只陈述事实 */
export const NOTE_GEO_STALE = "定位有一会儿没更新 · 暂时无法自动判断上车，上车后请点「手动标记上车」";

const BY_GEO: Record<GeoState, string> = {
  denied: NOTE_GEO_DENIED,
  unavailable: NOTE_GEO_WEAK,
  timeout: NOTE_GEO_TIMEOUT,
  low_acc: NOTE_GEO_LOW_ACC,
  stale: NOTE_GEO_STALE,
  ok: NOTE_GPS_UNAVAILABLE,
};

/**
 * 候车态「判定已暂停」时该说哪句。
 * @param geo `useUserFix` 的 `geo`；`undefined`（旧调用方/未接线）⇒ 兜底原句
 */
export function noteOfPausedGeo(geo: GeoState | undefined): string {
  return geo ? BY_GEO[geo] : NOTE_GPS_UNAVAILABLE;
}
