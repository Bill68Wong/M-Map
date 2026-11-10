/**
 * 图层偏好单测（scripts/test-layer-prefs.ts，M2 · 需求 2）
 *
 * ── 五条必测（派工原文，逐条编号对应）────────────────────────────────────
 *   ① 空存储 → 默认值
 *   ② 部分键缺失 → 缺失键取默认
 *   ③ 非法 JSON → 整体默认
 *   ④ `reset` 后读回等于默认
 *   ⑤ `toilet` 默认必须为 `false`（**这条要能红**：把默认改成 true 立即失败）
 *   另加：非布尔丢弃、**读操作不写盘**（`seen` 只读不写）、`markSeen` 判重、SSR 守卫、
 *        写/读抛异常都不崩、写后回读一致、`reset` 真的把键删掉。
 *
 * ── 为什么自己 stub 而不是 jsdom ─────────────────────────────────────────
 *   `layer-prefs.ts` 只在**调用期**读 `window`，模块级零副作用 ⇒ 换掉 `globalThis.window`
 *   即可全量覆盖（同 `scripts/test-favorites-v3.ts` 的做法）。stub 同时挂
 *   `globalThis.localStorage`，无论实现读 `window.localStorage` 还是裸 `localStorage` 都成立。
 *
 * ── 跑法 ──────────────────────────────────────────────────────────────
 *   npx tsx scripts/test-layer-prefs.ts
 */
import {
  DEFAULT_LAYER_PREFS,
  LAYER_KEYS,
  LAYER_PREFS_EVENT,
  LAYER_STORAGE_KEY,
  isLayerStorageAvailable,
  isNewUser,
  loadLayerPrefs,
  markLayerPrefsSeen,
  resetLayerPrefs,
  saveLayerPrefs,
  type LayerPrefs,
} from "../src/lib/map/layer-prefs";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  | ${detail}` : ""}`);
};

/** 内存版 localStorage + 可观测的写次数 / 事件名 */
interface Stub {
  store: Map<string, string>;
  writes: string[];
  removes: string[];
  events: string[];
}

function makeWindow(stub: Stub, opts: { throwOnRead?: boolean; throwOnWrite?: boolean } = {}) {
  const ls = {
    getItem: (k: string) => {
      if (opts.throwOnRead) throw new Error("SecurityError");
      return stub.store.has(k) ? (stub.store.get(k) as string) : null;
    },
    setItem: (k: string, v: string) => {
      if (opts.throwOnWrite) throw new Error("QuotaExceededError");
      stub.store.set(k, v);
      stub.writes.push(k);
    },
    removeItem: (k: string) => {
      stub.store.delete(k);
      stub.removes.push(k);
    },
  };
  return {
    localStorage: ls,
    dispatchEvent: (e: { type?: string }) => {
      stub.events.push(String(e?.type ?? ""));
      return true;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

function install(stub: Stub, opts: { throwOnRead?: boolean; throwOnWrite?: boolean } = {}) {
  const g = globalThis as Record<string, unknown>;
  g.window = makeWindow(stub, opts);
  // 双挂：实现若读裸 `localStorage` 也能命中
  g.localStorage = (g.window as { localStorage: unknown }).localStorage;
}

function uninstall() {
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.localStorage;
}

function fresh(): Stub {
  return { store: new Map(), writes: [], removes: [], events: [] };
}

const sameAsDefault = (p: LayerPrefs) =>
  LAYER_KEYS.every((k) => p[k] === DEFAULT_LAYER_PREFS[k]) && p.seen === DEFAULT_LAYER_PREFS.seen;

/* ══════════════ ⑤（先跑，压舱石）默认值：4 开 1 关 + 公厕关 ══════════════ */
console.log("\n⑤ 默认值 —— toilet 必须为 false");
{
  // ⚠️ 这里刻意与**字面量 false** 比较，而不是与 `DEFAULT_LAYER_PREFS.toilet` 自比：
  //    把默认值误改成 true 时，拿常量自比的断言会「自己对着自己」永远绿。
  check("DEFAULT_LAYER_PREFS.toilet === false（公厕默认关）", DEFAULT_LAYER_PREFS.toilet === false, `实际 ${DEFAULT_LAYER_PREFS.toilet}`);
  check("DEFAULT_LAYER_PREFS.bus === true", DEFAULT_LAYER_PREFS.bus === true);
  check("DEFAULT_LAYER_PREFS.tqh === true", DEFAULT_LAYER_PREFS.tqh === true);
  check("DEFAULT_LAYER_PREFS.pier === true", DEFAULT_LAYER_PREFS.pier === true);
  check("DEFAULT_LAYER_PREFS.airport === true", DEFAULT_LAYER_PREFS.airport === true);
  check("DEFAULT_LAYER_PREFS.seen === false（全新用户）", DEFAULT_LAYER_PREFS.seen === false);
  check("4 开 1 关（逐个数）", LAYER_KEYS.filter((k) => DEFAULT_LAYER_PREFS[k]).length === 4);
  check("LAYER_KEYS 恰好 5 个", LAYER_KEYS.length === 5);
}

/* ══════════════════════════ ① 空存储 → 默认值 ══════════════════════════ */
console.log("\n① 空存储 → 默认值（**且不写盘**）");
{
  const stub = fresh();
  install(stub);
  const p = loadLayerPrefs();
  check("等于默认值", sameAsDefault(p), JSON.stringify(p));
  check("isNewUser(p) === true（seen=false 派生）", isNewUser(p) === true);
  check("store 里仍无该键", !stub.store.has(LAYER_STORAGE_KEY));
  check("写入次数 0", stub.writes.length === 0);
  check("remove 次数 0", stub.removes.length === 0);
  check("未派发任何事件", stub.events.length === 0);
  // 连读两次也不写（防「读顺手写 seen」）
  loadLayerPrefs();
  loadLayerPrefs();
  check("连读 3 次仍 0 写入（seen 只读不写）", stub.writes.length === 0);
}

/* ══════════════════════ ② 部分键缺失 → 缺失键取默认 ══════════════════════ */
console.log("\n② 部分键缺失 → 缺失键取默认");
{
  const stub = fresh();
  install(stub);
  // 老版本只存了 3 个键，且公厕被用户打开过
  stub.store.set(LAYER_STORAGE_KEY, JSON.stringify({ bus: false, toilet: true, seen: true }));
  const p = loadLayerPrefs();
  check("存了的 bus=false 生效", p.bus === false);
  check("存了的 toilet=true 生效", p.toilet === true);
  check("缺失的 tqh 回落默认 true", p.tqh === true);
  check("缺失的 pier 回落默认 true", p.pier === true);
  check("缺失的 airport 回落默认 true", p.airport === true);
  check("seen=true 生效 ⇒ isNewUser=false", p.seen === true && isNewUser(p) === false);
  check("读不写盘", stub.writes.length === 0 && stub.events.length === 0);
}

/* ══════════════════════════ ③ 非法 JSON → 整体默认 ══════════════════════════ */
console.log("\n③ 非法 JSON / 非对象 / 非布尔 → 回落");
{
  const stub = fresh();
  install(stub);
  stub.store.set(LAYER_STORAGE_KEY, "{ bus: tru"); // 坏 JSON
  check("坏 JSON ⇒ 整体默认", sameAsDefault(loadLayerPrefs()));
  check("坏 JSON ⇒ 原键未被覆盖", stub.store.get(LAYER_STORAGE_KEY) === "{ bus: tru");
  check("坏 JSON ⇒ 不写盘", stub.writes.length === 0);

  const stub2 = fresh();
  install(stub2);
  stub2.store.set(LAYER_STORAGE_KEY, "\"不是对象\"");
  check("非对象（字符串）⇒ 整体默认", sameAsDefault(loadLayerPrefs()));

  const stub3 = fresh();
  install(stub3);
  stub3.store.set(
    LAYER_STORAGE_KEY,
    JSON.stringify({ bus: "yes", tqh: 1, pier: null, airport: true, toilet: "true", seen: "true" }),
  );
  const p3 = loadLayerPrefs();
  check("非布尔逐个丢弃 ⇒ bus 回落 true", p3.bus === true);
  check("非布尔逐个丢弃 ⇒ tqh 回落 true", p3.tqh === true);
  check("非布尔逐个丢弃 ⇒ pier 回落 true", p3.pier === true);
  check("非布尔逐个丢弃 ⇒ toilet 回落 **false**（不是 \"true\" 真值）", p3.toilet === false);
  check("合法布尔保留 ⇒ airport=true", p3.airport === true);
  check("seen 非布尔 ⇒ false（当作没来过）", p3.seen === false);
}

/* ══════════════════════════ ④ reset 只复位开关、不动 seen ══════════════════════════ */
console.log("\n④ reset：开关回默认，`seen` 保留（**不删键**）");
{
  const stub = fresh();
  install(stub);
  saveLayerPrefs({ bus: false, tqh: false, pier: false, airport: false, toilet: true, seen: true });
  check("写入后回读一致", (() => {
    const p = loadLayerPrefs();
    return !p.bus && !p.tqh && !p.pier && !p.airport && p.toilet && p.seen;
  })());
  check("`must:layers` 事件已派发", stub.events.filter((e) => e === LAYER_PREFS_EVENT).length === 1);

  const r = resetLayerPrefs();
  check("reset 返回值：5 个开关 = 默认值", LAYER_KEYS.every((k) => r[k] === DEFAULT_LAYER_PREFS[k]), JSON.stringify(r));
  check("reset 返回值：`seen` 保留为 true（不动 onboarding 状态）", r.seen === true);
  check("reset 后键**仍存在**（不删键）", stub.store.has(LAYER_STORAGE_KEY));
  check("reset 派发了事件（同页订阅者能收到）", stub.events.filter((e) => e === LAYER_PREFS_EVENT).length === 2);
  const back = loadLayerPrefs();
  check("reset 后读回：开关 = 默认值", LAYER_KEYS.every((k) => back[k] === DEFAULT_LAYER_PREFS[k]), JSON.stringify(back));
  check("reset 后 toilet 回到 false", back.toilet === false);
  check("reset 前 seen=true ⇒ reset 后 isNewUser **仍为 false**", isNewUser(back) === false);
}

console.log("\n④-b reset 不得把 `seen=false` 洗成 true（能红：把 seen 写死 true 即失败）");
{
  const stub = fresh();
  install(stub);
  check("前提：全新用户 seen=false", loadLayerPrefs().seen === false);
  const r = resetLayerPrefs();
  check("reset 后 seen **仍为 false**", r.seen === false, `实际 ${r.seen}`);
  check("reset 后读回 seen 仍为 false", loadLayerPrefs().seen === false);
  check("reset 后仍是 isNewUser=true（首次提示不会被 reset 吃掉）", isNewUser(loadLayerPrefs()) === true);
  check("reset 后开关 = 默认 4 开 1 关", LAYER_KEYS.every((k) => loadLayerPrefs()[k] === DEFAULT_LAYER_PREFS[k]));
}

/* ══════════════════════════ ⑥ markSeen 判重 ══════════════════════════ */
console.log("\n⑥ markLayerPrefsSeen（面板首次打开）");
{
  const stub = fresh();
  install(stub);
  check("首次 ⇒ 返回 true", markLayerPrefsSeen() === true);
  const p = loadLayerPrefs();
  check("写盘内容 = 默认值 + seen:true（不动任何开关）", p.seen === true && p.toilet === false && p.bus === true);
  const writes = stub.writes.length;
  check("再次 ⇒ 返回 false（判重）", markLayerPrefsSeen() === false);
  check("再次 ⇒ 不重复写盘", stub.writes.length === writes);
}

/* ══════════════════════════ ⑦ SSR 守卫 ══════════════════════════ */
console.log("\n⑦ SSR 守卫（无 window）");
{
  uninstall();
  const p = loadLayerPrefs();
  check("默认值 + 不抛错", sameAsDefault(p));
  check("isLayerStorageAvailable() === false", isLayerStorageAvailable() === false);
  check("saveLayerPrefs 不抛错", (() => {
    try {
      saveLayerPrefs({ ...DEFAULT_LAYER_PREFS });
      return true;
    } catch {
      return false;
    }
  })());
  check("resetLayerPrefs 返回默认值", sameAsDefault(resetLayerPrefs()));
}

/* ══════════════════════════ ⑧ 抛异常不崩 ══════════════════════════ */
console.log("\n⑧ localStorage 抛异常（隐私模式 / 配额满）");
{
  const stub = fresh();
  install(stub, { throwOnWrite: true });
  check("写探针失败 ⇒ available=false", isLayerStorageAvailable() === false);
  check("saveLayerPrefs 不抛错", (() => {
    try {
      saveLayerPrefs({ bus: false, tqh: false, pier: false, airport: false, toilet: true, seen: true });
      return true;
    } catch {
      return false;
    }
  })());
  check("写失败 ⇒ store 为空", stub.store.size === 0);

  const stub2 = fresh();
  install(stub2, { throwOnRead: true });
  check("getItem 抛错 ⇒ 默认值", sameAsDefault(loadLayerPrefs()));
}

/* ══════════════════════════ ⑨ 默认对象不被污染 ══════════════════════════ */
console.log("\n⑨ 返回值是副本，不污染 DEFAULT_LAYER_PREFS");
{
  const stub = fresh();
  install(stub);
  const p = loadLayerPrefs();
  p.toilet = true;
  check("改返回值不影响常量", DEFAULT_LAYER_PREFS.toilet === false);
  check("再读仍是公厕关", loadLayerPrefs().toilet === false);
}

uninstall();
console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 存在失败"}：pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
