/**
 * 地图图层偏好 · 纯存储层（src/lib/map/layer-prefs.ts，M2 · 需求 2）
 *
 * ── 语义（负责人裁定）────────────────────────────────────────────────────
 *   图层开关**记住用户上次选择**；默认值 = 四条公共交通图层开、**公厕关**
 *   （198 个公厕点全亮会把地图糊住）。默认值只在「从没选过」时生效。
 *
 * ── `seen` 的语义（别乱写）───────────────────────────────────────────────
 *   `seen: false` ⇒ 这个用户**从没打开过图层面板、也从未拨过开关** ⇒ 消费方按默认值渲染，
 *   并可据此做「首次自动展开 / 一次性提示」。
 *   `seen: true` 由**用户动作**产生：首次打开图层面板（`markLayerPrefsSeen`）或首次拨动
 *   任一开关（`useLayerPrefs().setLayer`）。
 *   ⚠️ `loadLayerPrefs()` **只读不写** —— 读的时候顺手把 `seen` 写成 true，等于「第一次
 *      渲染就把首次态吃掉」，提示永远不会出现。这条是硬约束（自测②会红）。
 *
 * ── 校验纪律（逐键，不做整体抛弃）────────────────────────────────────────
 *   · 键缺失 ⇒ 该键回落默认值（老版本只存了 4 个键也能用）；
 *   · 值非布尔 ⇒ 丢弃该键、回落默认（手改键塞 `"yes"` / `1` / `null` 不会把开关搞成真值）；
 *   · JSON 解析失败 / 非对象 ⇒ **整体**回落默认；
 *   · 以上任何一种情况都**不写盘**（不自愈、不覆盖，留痕便于排查）。
 *   ⚠️ 版本号**只放在键名里**（`must.layers.v1`），payload 不再带 `version` 字段 ——
 *      结构要变就换键名，避免「键名 v1、payload 里写 v2」这种半迁移态。
 *
 * ── 边界（同 `src/lib/favorites/v3.ts` 的纪律）────────────────────────────
 *   ⚠️ 纯 localStorage 模块：**禁止 import 任何含 `pg` 的模块**（client 组件直接引用，
 *      一旦牵连数据库依赖，客户端打包会直接炸）。⇒ 本文件**零 import**。
 *      存储可用性探针刻意自带一份，不复用 `@/lib/favorites/storage`（跨特性耦合，
 *      且那边还牵连收藏 schema）。
 */

/** 五个图层开关的键（顺序即 UI 建议顺序：巴士 → 通琴号 → 码头 → 机场 → 公厕） */
export type LayerKey = "bus" | "tqh" | "pier" | "airport" | "toilet";

/**
 * 偏好（**没有** `version` 字段，版本记在键名里）。
 * `seen` = 是否已被用户动作初始化过；其余 5 个键 = 各图层是否显示。
 */
export type LayerPrefs = Record<LayerKey, boolean> & { seen: boolean };

/** 全部图层键（有序；弹窗渲染、默认值遍历与自测共用，避免各处手写数组漂移） */
export const LAYER_KEYS: readonly LayerKey[] = ["bus", "tqh", "pier", "airport", "toilet"];

/** 存储键（版本在键名里） */
export const LAYER_STORAGE_KEY = "must.layers.v1";

/** 同页变更广播事件（跨标签走原生 `storage` 事件） */
export const LAYER_PREFS_EVENT = "must:layers";

/**
 * 默认值：巴士/通琴号/码头/机场 开，**公厕关**；`seen: false`（= 全新用户）。
 * ⚠️ **只读约定**：消费方不得修改本对象；需要可写副本时用 `loadLayerPrefs()`（内部返回副本）。
 */
export const DEFAULT_LAYER_PREFS: LayerPrefs = {
  bus: true,
  tqh: true,
  pier: true,
  airport: true,
  toilet: false,
  seen: false,
};

/** 造一份默认值副本（避免把模块级常量对象泄漏给外部改） */
function defaultPrefs(): LayerPrefs {
  return { ...DEFAULT_LAYER_PREFS };
}

/** 「从没初始化过」= `seen === false`。等价于旧稿的 `isNewUser`，只是从 `seen` 直接派生。 */
export function isNewUser(p: LayerPrefs): boolean {
  return !p.seen;
}

/**
 * `localStorage` 是否可用（写探针 + 立即移除；隐私模式 / 被策略禁用返回 `false`）。
 */
export function isLayerStorageAvailable(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const probe = "__mm_layers_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** 逐键校验：只认布尔，其余一律回落默认（含 `seen`） */
function sanitize(raw: unknown): LayerPrefs {
  const out = defaultPrefs();
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  for (const k of LAYER_KEYS) {
    const v = o[k];
    if (typeof v === "boolean") out[k] = v;
  }
  if (typeof o.seen === "boolean") out.seen = o.seen;
  return out;
}

/**
 * 读偏好（**只读，绝不写盘**）。
 * - 服务端（无 `window`）⇒ 默认值（首帧用它渲染，等 `mounted` 再换真值）
 * - 键不存在 / JSON 坏 / 非对象 / 字段类型不对 ⇒ 对应层级的默认值
 */
export function loadLayerPrefs(): LayerPrefs {
  if (typeof window === "undefined") return defaultPrefs();
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(LAYER_STORAGE_KEY);
  } catch {
    // 隐私模式下 `getItem` 本身也可能抛
    return defaultPrefs();
  }
  if (raw == null) return defaultPrefs();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[layers] 偏好解析失败（已忽略，不覆盖原数据）");
    return defaultPrefs();
  }
  return sanitize(parsed);
}

/** 广播同页订阅者（`storage` 事件负责跨标签） */
function emit(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(LAYER_PREFS_EVENT));
}

/**
 * 写偏好（逐键归一后落盘）。
 * 失败（隐私模式 / 配额满 / 非浏览器）只 `console.warn`，**不抛错、不崩页面**。
 */
export function saveLayerPrefs(p: LayerPrefs): void {
  if (typeof window === "undefined") return;
  const next = sanitize(p);
  try {
    window.localStorage.setItem(LAYER_STORAGE_KEY, JSON.stringify(next));
  } catch (e) {
    console.warn("[layers] 偏好写入失败（本次不记住）：", e instanceof Error ? e.message : e);
    return;
  }
  emit();
}

/**
 * 恢复默认：把**五个开关**写回默认值（4 开 1 关），**但保留 `seen`**。
 *
 * ⚠️ 为什么不删键 / 为什么不动 `seen`（负责人 2026-11-10 裁定）：
 *   `seen` 记录的是「**本浏览器有没有打开过图层面板**」，与「五个开关各是什么」是**两件事**。
 *   「恢复默认」只该复位开关；若连 `seen` 一起清掉，老用户点一次恢复默认，
 *   下次进来又被当成新用户弹首次提示 —— 典型的**状态串味**。
 *   ⇒ 先把读到的 `seen` 原样写回，再广播。
 */
export function resetLayerPrefs(): LayerPrefs {
  const cur = loadLayerPrefs();
  const next: LayerPrefs = { ...defaultPrefs(), seen: cur.seen };
  saveLayerPrefs(next); // 内部含 try/catch + 广播
  return next;
}

/**
 * 标记「已初始化」—— 图层面板**第一次打开**时调用一次。
 * 已经 `seen: true` ⇒ 直接返回 `false`，不产生多余写盘与事件（自测⑥判重）。
 */
export function markLayerPrefsSeen(): boolean {
  const cur = loadLayerPrefs();
  if (cur.seen) return false;
  saveLayerPrefs({ ...cur, seen: true });
  return true;
}
