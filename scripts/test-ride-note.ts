/**
 * 乘车态「无进度」提示判定 · 纯函数回归（scripts/test-ride-note.ts，2026-11-03 新增）
 *
 * ── 这个文件守什么 ──────────────────────────────────────────────────────
 *   `src/lib/nav/ride-note.ts` 决定「无牌巴士拿不到进度时，用户看到哪句话」，
 *   以及 `body[data-ladder-state]` 的量测取值。两者都是**对外承诺**：
 *     · 文案错了 ⇒ 用户不知道该自己点「我已下车」（A-1 的真实危害是坐过站）；
 *     · 有牌时误报 ⇒ 文案一闪即失，比不提示更糟；
 *     · 钩子取值集变了 ⇒ QA 的浏览器断言（量测触发率）静默失效。
 *
 * ── 为什么放在 `scripts/` 而非 `.verify/` ────────────────────────────────
 *   `.verify/` 被 `.gitignore` 忽略且**不在 tsc 覆盖内**，`.mjs` 也无法 import TS
 *   ⇒ 只能复刻实现（本项目已有腐化前科，见 `test-remaining-view.ts` 头注）。
 *   本文件**直接 import 真实函数**，断言对象与线上代码是同一个。
 *
 * ── 铁律 44c 四项（缺一条即视为"为了绿而放松判据"）─────────────────────
 *   ① 用例集合必须非空（空集会让 `every()` 恒真）→ 见 M1/M4；
 *   ② 集合尺寸必须等于枚举出的分支数 → 见 M2/M4/N2；
 *   ③ 输出必须写明「实际比对 N / 预期 M」→ 见文件末尾；
 *   ④ 全用**正向**断言（断言"应该返回什么"），禁 `x || !!x`；
 *      用正则从源码提取信息处，**提取失败必须判红** → 见 G1/G6。
 *
 * ── 跑法 ────────────────────────────────────────────────────────────────
 *   npm run test:ride-note
 *   （= `tsx scripts/test-ride-note.ts`，cwd 必须是仓库根）
 */
import { readFileSync } from "node:fs";
import {
  NOTE_NO_GEOMETRY,
  NOTE_NO_STOPS,
  ladderStateOf,
  rideNoteOf,
  type LadderState,
} from "../src/lib/nav/ride-note";

let failed = 0;
/** 实际执行的断言条数（末尾与预期条数对账，少跑/漏跑即红） */
let compared = 0;
const ok = (cond: boolean, name: string, detail = ""): void => {
  compared++;
  if (cond) console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
  else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};

/* ══════════════════════════════════════════════════════════════════════
   枚举出的分支数（三张表 + 守卫 + 自检，末尾逐项对账）
   ══════════════════════════════════════════════════════════════════════ */
/** `rideNoteOf` 的 5 条分支（文件头注的分支表） */
const NOTE_BRANCHES = 5;
/** `ladderStateOf` 的 4 个取值 */
const LADDER_STATES = 4;
/** 边界值用例（"刚好够" 的一侧，防判据写成 `<=` / `<` 混淆） */
const BOUNDARY_CASES = 4;
/** 源码级守卫条数 */
const GUARD_COUNT = 7;
/** 集合自检条数（M1/M2/M3/M4/M5/M5b） */
const META_COUNT = 6;

/* ══════════════════════════════════════════════════════════════════════
   ① `rideNoteOf` —— 5 条分支，一条一个用例
   ══════════════════════════════════════════════════════════════════════ */
interface NoteCase {
  id: string;
  why: string;
  input: { phase: string; hasPlate: boolean; coloredLen: number; stopsLen: number };
  expect: string | null;
}

const NOTE_CASES: NoteCase[] = [
  {
    id: "R1",
    why: "分支①：非 riding（候车）⇒ 不出文案",
    input: { phase: "boarding", hasPlate: false, coloredLen: 0, stopsLen: 0 },
    expect: null,
  },
  {
    id: "R2",
    why: "分支②：有牌 ⇒ 一律 null（下一帧自愈，绝不误报）",
    input: { phase: "riding", hasPlate: true, coloredLen: 0, stopsLen: 0 },
    expect: null,
  },
  {
    id: "R3",
    why: "分支③：无几何 ⇒ 无轨迹文案（含「我已下车」）",
    input: { phase: "riding", hasPlate: false, coloredLen: 1, stopsLen: 9 },
    expect: NOTE_NO_GEOMETRY,
  },
  {
    id: "R4",
    why: "分支④：有几何但站条只有 1 站 ⇒ 无站序文案（含「留意」）",
    input: { phase: "riding", hasPlate: false, coloredLen: 40, stopsLen: 1 },
    expect: NOTE_NO_STOPS,
  },
  {
    id: "R5",
    why: "分支⑤：几何与站条都够 ⇒ null（正常态不打扰）",
    input: { phase: "riding", hasPlate: false, coloredLen: 40, stopsLen: 9 },
    expect: null,
  },
];

console.log("── ① rideNoteOf：5 条分支 ──");
for (const c of NOTE_CASES) {
  const actual = rideNoteOf(c.input);
  ok(actual === c.expect, `[${c.id}] ${c.why}`, `实际=${JSON.stringify(actual)}`);
}

/* ══════════════════════════════════════════════════════════════════════
   ② `ladderStateOf` —— 4 个取值，一个取值一个用例
   ══════════════════════════════════════════════════════════════════════ */
interface LadderCase {
  id: string;
  why: string;
  input: { phase: string; coloredLen: number; stopsLen: number };
  expect: LadderState;
}

const LADDER_CASES: LadderCase[] = [
  {
    id: "L1",
    why: "非乘车态 ⇒ idle",
    input: { phase: "off", coloredLen: 0, stopsLen: 0 },
    expect: "idle",
  },
  {
    id: "L2",
    why: "几何 < 2 点 ⇒ no-geometry",
    input: { phase: "riding", coloredLen: 1, stopsLen: 9 },
    expect: "no-geometry",
  },
  {
    id: "L3",
    why: "站条 < 2 站 ⇒ no-stops",
    input: { phase: "riding", coloredLen: 40, stopsLen: 1 },
    expect: "no-stops",
  },
  {
    id: "L4",
    why: "几何与站条都够 ⇒ built",
    input: { phase: "riding", coloredLen: 2, stopsLen: 2 },
    expect: "built",
  },
];

console.log("── ② ladderStateOf：4 个取值（含对外契约取值集）──");
for (const c of LADDER_CASES) {
  ok(ladderStateOf(c.input) === c.expect, `[${c.id}] ${c.why}`, `期望=${c.expect}`);
}

/* ══════════════════════════════════════════════════════════════════════
   ③ 边界值 —— 「2 点 / 2 站」是"够"的下界（防判据写成 `<=` 或 `< 3`）
   ══════════════════════════════════════════════════════════════════════ */
interface BoundaryCase {
  id: string;
  why: string;
  input: { phase: string; hasPlate: boolean; coloredLen: number; stopsLen: number };
  expect: string | null;
}

const BOUNDARY: BoundaryCase[] = [
  {
    id: "B1",
    why: "coloredLen=2 且 stopsLen=2 ⇒ 恰好在「够」的下界 ⇒ null",
    input: { phase: "riding", hasPlate: false, coloredLen: 2, stopsLen: 2 },
    expect: null,
  },
  {
    id: "B2",
    why: "coloredLen=2（几何刚好够）但 stopsLen=1 ⇒ 落到站序判据",
    input: { phase: "riding", hasPlate: false, coloredLen: 2, stopsLen: 1 },
    expect: NOTE_NO_STOPS,
  },
  {
    id: "B3",
    why: "phase=off + 无几何 ⇒ 仍为 null（非乘车态不提示）",
    input: { phase: "off", hasPlate: false, coloredLen: 0, stopsLen: 0 },
    expect: null,
  },
  {
    id: "B4",
    why: "phase=done + 无几何 ⇒ 仍为 null（已到达不再提示）",
    input: { phase: "done", hasPlate: false, coloredLen: 0, stopsLen: 0 },
    expect: null,
  },
];

console.log("── ③ 边界值（下界两侧 + 三档 phase）──");
for (const c of BOUNDARY) {
  ok(rideNoteOf(c.input) === c.expect, `[${c.id}] ${c.why}`);
}

/* ══════════════════════════════════════════════════════════════════════
   ④ 源码级守卫（接线 + 时序坑 + 钩子契约 + 上屏链路）
   ══════════════════════════════════════════════════════════════════════ */
const TRACK_SRC = readFileSync("src/components/nav/useRideTracking.ts", "utf8");
const BAR_SRC = readFileSync("src/components/nav/NavTrackBar.tsx", "utf8");

/** 提取 `ensureLadder` 的完整函数体（`useCallback(async () => { … }, [deps])`） */
function ensureLadderBody(src: string): string | null {
  const m = /const ensureLadder = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[/.exec(src);
  return m ? m[1] : null;
}

const GUARDS: { id: string; name: string; pass: boolean; detail?: string }[] = [
  (() => {
    /**
     * G1：返回处的 note 合流必须**经过 `geomNote`**。
     * 若有人把 `geomNote ?? note` 改回 `note`，文案就再也不会出现在提示行里。
     *
     * ⚠️ 为什么用「正则跨行窗口」而不是「按行找含 `noteOfPausedGeo` 的行」：
     *   首版按行找，命中的是**上方注释**里那句 `noteOfPausedGeo(geo)` ⇒ 拿注释当代码，
     *   同时 Prettier 一旦把该表达式折行，按行匹配就会假红。窗口式对折行免疫。
     *   **提取失败仍然判红**（`detail` 写明失败原因，条件里带上 `!= null`）。
     */
    const m = /note:\s*phase === "boarding"[\s\S]{0,220}?geomNote \?\? note/.exec(TRACK_SRC);
    return {
      id: "G1",
      name: "note 派生合流经过 geomNote（改回纯 note 即红）",
      pass: m != null,
      detail:
        m == null
          ? "提取失败：未在返回处找到 `note: … ? noteOfPausedGeo(geo) : (geomNote ?? note)` 形态"
          : m[0].replace(/\s+/g, " ").slice(0, 96),
    };
  })(),
  {
    /**
     * G2：`rideNoteOf` 必须**真的接在 `geomNote` 上**（import + 赋值形态）。
     *
     * ⚠️ 首版只查 `TRACK_SRC.includes("rideNoteOf({")` ⇒ 注释里写一句同样的代码就能过，
     *   标题说「已接线」而判据只能证明「这个词出现过」（五类假绿的 **④ 类：标签比判据强**）。
     *   现在锚定**赋值形态**，与 G1（合流经 `geomNote`）咬合成一条链：
     *     import → `const geomNote = rideNoteOf({…})` → `geomNote ?? note`
     */
    id: "G2",
    name: "rideNoteOf 已 import 并赋值给 geomNote",
    pass:
      TRACK_SRC.includes('from "@/lib/nav/ride-note"') &&
      /const geomNote = rideNoteOf\(\{/.test(TRACK_SRC),
  },
  {
    /**
     * G3：`ladderStateOf` 的产物必须赋给 `ladderState`，且该变量真的喂进 `setLadderHook`
     * （只赋值不喂等于没接）。标题**不承诺 import** —— 那由 G2 的模块路径断言覆盖。
     */
    id: "G3",
    name: "ladderStateOf 已赋值给 ladderState 且喂进 setLadderHook",
    pass:
      /const ladderState = ladderStateOf\(\{/.test(TRACK_SRC) &&
      /setLadderHook\(ladderState, coloredLen\)/.test(TRACK_SRC),
  },
  {
    /**
     * G4/G5：钩子属性名是**对外契约**，改名会让 QA 断言静默失效。
     *
     * ⚠️ 首版判据是 `TRACK_SRC.includes('"data-ladder-state"')` ⇒ 两类错法都抓不到：
     *   ① 删掉 `setAttribute` 那一行、只留 `removeAttribute`（同一个字面量还在）；
     *   ② **值表达式接错**（`String(coloredLen)` 误写成 `String(stopsLen)`）——
     *      这正是本批最该防的「接线错」，`includes` 对它完全无感。
     *   ⇒ 现在锚定**完整写入形态（含值表达式）**，这两类必红。
     *   **刻意不做 `dataset.xxx =` 的兼容**：为未发生的重构写兼容只会让正则变宽、判别力下降；
     *   真重构时这里红一次、顺手改正则，且**变更是可见的**（与 ⑤c-1 白名单同一哲学）。
     */
    id: "G4",
    name: "data-ladder-state 以 setAttribute(…, state) 写入",
    pass: /setAttribute\(\s*["']data-ladder-state["']\s*,\s*state\s*\)/.test(TRACK_SRC),
  },
  {
    id: "G5",
    name: "data-colored-len 以 setAttribute(…, String(coloredLen)) 写入",
    pass: /setAttribute\(\s*["']data-colored-len["']\s*,\s*String\(\s*coloredLen\s*\)\s*\)/.test(
      TRACK_SRC,
    ),
  },
  (() => {
    /**
     * G6：**时序坑守卫**。`switchToRiding` 里 `setPlate` 尚未提交时 `ensureLadder` 就会跑，
     * 若在建梯函数体内直接 `setNote(...)`，有牌场景会先闪出文案再消失。
     * 一旦有人把这个写法加回去，这一条立刻红。
     */
    const body = ensureLadderBody(TRACK_SRC);
    return {
      id: "G6",
      name: "ensureLadder 体内不含 setNote（时序坑：会闪）",
      pass: body != null && !body.includes("setNote"),
      detail: body == null ? "提取失败：未匹配到 ensureLadder 函数体" : `函数体 ${body.length} 字符`,
    };
  })(),
  {
    /**
     * G7：文案必须真的能上屏 —— `NavTrackBar` 在 `.nav-track__note` **同一个元素内**渲染 `note`。
     * 只改 hook 不改组件 ⇒ 判定对了但用户看不到，等于没修。
     *
     * ⚠️ 首版是 `includes("nav-track__note") && includes("{note}")`：两者各自存在就过，
     *   哪怕 `{note}` 渲染在别处（标题承诺「渲染 .nav-track__note 且接收 note」，判据承诺不了）。
     *   现在要求同元素内出现 `{note}`（窗口 160 字符，容忍 Prettier 折行）。
     */
    id: "G7",
    name: "NavTrackBar 在 .nav-track__note 元素内渲染 note",
    pass: /className="nav-track__note[^"]*"[\s\S]{0,160}?\{note\}/.test(BAR_SRC),
  },
];

console.log("── ④ 源码级守卫（接线 / 时序坑 / 钩子契约 / 上屏链路）──");
for (const g of GUARDS) ok(g.pass, `[${g.id}] ${g.name}`, g.detail);

/* ══════════════════════════════════════════════════════════════════════
   ⑤ 集合自检（铁律 44c ①②：非空 + 尺寸 == 枚举分支数）
   ══════════════════════════════════════════════════════════════════════ */
console.log("── ⑤ 集合自检（空集会令 every() 恒真 ⇒ 必须先自证非空）──");
ok(NOTE_CASES.length > 0, "[M1] rideNoteOf 用例集合非空", `n=${NOTE_CASES.length}`);
ok(
  NOTE_CASES.length === NOTE_BRANCHES,
  "[M2] rideNoteOf 用例数 == 枚举分支数",
  `实际=${NOTE_CASES.length} / 预期=${NOTE_BRANCHES}`,
);
ok(
  BOUNDARY.length === BOUNDARY_CASES && BOUNDARY.length > 0,
  "[M3] 边界用例数 == 声明数且非空",
  `实际=${BOUNDARY.length} / 预期=${BOUNDARY_CASES}`,
);
{
  /**
   * M4：`ladderStateOf` 的用例**必须覆盖全部 4 个取值**且一条不多。
   * 只看条数不够 —— 4 条用例都测 `idle` 也能凑够 4。
   *
   * ⚠️ 也不能只看 `seen.size === 4`：若将来 `LadderState` 扩成 5 值，4 条用例
   *   照样能凑出 4 个"不同取值"却漏掉某一档 ⇒ 这里显式列出**期望取值集**并查缺。
   */
  const seen = new Set(LADDER_CASES.map((c) => c.expect));
  const EXPECTED_STATES: LadderState[] = ["built", "no-geometry", "no-stops", "idle"];
  const missing = EXPECTED_STATES.filter((s) => !seen.has(s));
  ok(
    LADDER_CASES.length === LADDER_STATES && seen.size === LADDER_STATES && missing.length === 0,
    "[M4] ladderStateOf 用例数 == 4 且四个取值全覆盖（缺一即红）",
    `用例=${LADDER_CASES.length} 去重取值=${seen.size} 缺=${missing.join(",") || "无"}`,
  );
}
{
  /**
   * M5：文案契约 —— 两句都必须给出可执行下一步，且彼此不同（防被统一成一句）。
   *
   * ⚠️ 为什么要先落到 `string` 再比：两个常量都是**字面量类型**，直接
   * `NOTE_NO_GEOMETRY !== NOTE_NO_STOPS` 会被 TS 判成 `TS2367`（类型无交集，
   * 编译器已经知道恒真）。这里的意图是**守住"将来被改成同一句"这个改动**，
   * 所以要保留运行期比较 ⇒ 显式拓宽类型，而不是删掉这条断言。
   */
  const geoText: string = NOTE_NO_GEOMETRY;
  const stopText: string = NOTE_NO_STOPS;
  ok(
    geoText.includes("我已下车") && stopText.includes("留意") && geoText !== stopText,
    "[M5] 文案契约：无几何含「我已下车」· 无站序含「留意」· 两者不相同",
    `几何=${geoText.length}字 站序=${stopText.length}字`,
  );
}
{
  /**
   * M5b：只做「id 唯一」的护栏 —— 重复 id 会让上面的逐条 PASS 看起来更多，
   * 掩盖"某条分支其实没测"的事实。
   *
   * ⚠️ 标题**不得**写「防重复凑数」：内容重复但 id 不同的用例，这条抓不到
   *   （那是 M2 的职责 —— 条数对不上）。这里只承诺「同 id 不被重复覆盖」。
   */
  const ids = new Set(NOTE_CASES.map((c) => c.id));
  ok(
    ids.size === NOTE_CASES.length,
    "[M5b] 用例 id 唯一（防同 id 重复覆盖；内容重复由 M2 抓）",
    `去重=${ids.size}`,
  );
}

/* ══════════════════════════════════════════════════════════════════════
   ⑥ 条数对账（铁律 44c ③）
   ══════════════════════════════════════════════════════════════════════ */
const EXPECTED_TOTAL =
  NOTE_BRANCHES + LADDER_STATES + BOUNDARY_CASES + GUARD_COUNT + META_COUNT;
console.log(`\n实际比对 ${compared} / 预期 ${EXPECTED_TOTAL}`);
if (compared !== EXPECTED_TOTAL) {
  failed++;
  console.log(
    `  FAIL  比对条数与预期不符（少跑/漏跑：有断言被删，或 META_COUNT / GUARD_COUNT 未同步）`,
  );
}
if (GUARDS.length !== GUARD_COUNT) {
  failed++;
  console.log(`  FAIL  守卫条数与声明不符：实际=${GUARDS.length} / 预期=${GUARD_COUNT}`);
}

console.log(
  failed === 0
    ? "\n✅ 全通过（5 分支 / 4 状态 / 边界值 / 源码守卫 / 集合自检 / 条数对账）"
    : `\n❌ ${failed} 项失败`,
);
process.exit(failed === 0 ? 0 : 1);
