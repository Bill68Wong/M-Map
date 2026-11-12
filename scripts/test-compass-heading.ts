/**
 * 朝向内核单测（scripts/test-compass-heading.ts，★ 2026-11-12 · F1）
 *
 * ── 为什么这些断言必须存在（每条都对应一个"真机上才发现就晚了"的坑）──────
 *   ① 倾斜补偿：`alpha` 是逆时针、且竖持时 +Y 投影为 0 ⇒
 *      直接 `360 - alpha` 在竖持/倾斜时会整体偏；这里用平放与竖持两种姿态交叉锁死；
 *   ② 换轴连续性：|beta| 跨 45° 时参考轴从 +Y 换成 -Z，若两式不等价箭头会"跳一下"；
 *   ③ 最短弧：350°→10° 必须走 +20°，绝不能 -340°（视觉是一整圈倒转）；
 *   ④ 死区 / 角速度上限：静置不能抖，磁扰不能一帧转 180°；
 *   ⑤ 抖动度：**匀速转身不能被判成磁扰**（用"相对首样本偏差"就会踩这个坑）。
 *
 * ── 跑法 ──────────────────────────────────────────────────────────────
 *   npx tsx scripts/test-compass-heading.ts
 *   纯离线、无 DOM、无传感器 ⇒ 可进 `verify` 链。
 */
import {
  COURSE_MIN_SPEED_MPS,
  HEADING_DEADBAND_DEG,
  HEADING_MAX_RATE_DEG_S,
  createHeadingSmoother,
  headingFromOrientation,
  headingJitterDeg,
  headingQualityOf,
  normalizeDeg,
  pickHeadingMode,
  shortestDeltaDeg,
} from "../src/lib/compass/heading";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  | ${detail}` : ""}`);
};

/** 角度近似相等（容差 0.01°） */
const near = (a: number | null, b: number, eps = 0.01) => a != null && Math.abs(shortestDeltaDeg(b, a)) < eps;

/* ══════════════════════════ ① 角度基础 ══════════════════════════ */
console.log("\n① 归一化与最短弧");
{
  check("normalizeDeg(370) = 10", normalizeDeg(370) === 10);
  check("normalizeDeg(-10) = 350", normalizeDeg(-10) === 350);
  check("normalizeDeg(NaN) = 0（不返回 NaN 污染下游）", normalizeDeg(Number.NaN) === 0);
  check("shortestDeltaDeg(350,10) = +20（向右转）", shortestDeltaDeg(350, 10) === 20);
  check("shortestDeltaDeg(10,350) = -20（向左转）", shortestDeltaDeg(10, 350) === -20);
  check("shortestDeltaDeg(0,180) = 180", shortestDeltaDeg(0, 180) === 180);
  check("shortestDeltaDeg(0,181) = -179（走另一侧）", shortestDeltaDeg(0, 181) === -179);
}

/* ══════════════════════════ ② 倾斜补偿 ══════════════════════════ */
console.log("\n② 倾斜补偿（平放 / 竖持 / 换轴连续性）");
{
  const flat = (alpha: number) => headingFromOrientation({ alpha, beta: 0, gamma: 0, screenAngleDeg: 0 });
  check("平放 alpha=0 ⇒ 正北 0", near(flat(0), 0), `${flat(0)}`);
  check("平放 alpha=90 ⇒ 西 270", near(flat(90), 270), `${flat(90)}`);
  check("平放 alpha=270 ⇒ 东 90", near(flat(270), 90), `${flat(270)}`);
  check("平放 alpha=45 ⇒ 315", near(flat(45), 315), `${flat(45)}`);

  const upright = (alpha: number) => headingFromOrientation({ alpha, beta: 90, gamma: 0, screenAngleDeg: 0 });
  check("竖持 beta=90, alpha=0 ⇒ 正北 0", near(upright(0), 0), `${upright(0)}`);
  check("竖持 beta=90, alpha=270 ⇒ 东 90", near(upright(270), 90), `${upright(270)}`);

  // ③ 换轴连续性：|beta| 跨 45° 边界，两种参考轴必须同解（γ=0 时恒等）
  let maxJump = 0;
  for (let alpha = 0; alpha < 360; alpha += 15) {
    const a = headingFromOrientation({ alpha, beta: 44.99, gamma: 0, screenAngleDeg: 0 });
    const b = headingFromOrientation({ alpha, beta: 45.01, gamma: 0, screenAngleDeg: 0 });
    const d = a != null && b != null ? Math.abs(shortestDeltaDeg(a, b)) : 999;
    if (d > maxJump) maxJump = d;
  }
  check("跨 45° 换轴不跳变（24 个角度最大偏差 < 0.5°）", maxJump < 0.5, `max=${maxJump.toFixed(4)}°`);

  // 姿态退化：alpha 缺失 ⇒ 必须 null，不能当正北
  check(
    "alpha 缺失 ⇒ null（不得返回 0 冒充正北）",
    headingFromOrientation({ beta: 0, gamma: 0, screenAngleDeg: 0 }) === null,
  );
  check(
    "alpha=NaN ⇒ null",
    headingFromOrientation({ alpha: Number.NaN, beta: 0, gamma: 0, screenAngleDeg: 0 }) === null,
  );
}

/* ══════════════════════════ ③ 屏幕旋转 / iOS ══════════════════════════ */
console.log("\n③ 屏幕旋转与 iOS 专用字段");
{
  check(
    "横屏 90° ⇒ 航向 +90（alpha=0 时 0→90）",
    near(headingFromOrientation({ alpha: 0, beta: 0, gamma: 0, screenAngleDeg: 90 }), 90),
  );
  check(
    "iOS webkitCompassHeading 直接采用",
    near(headingFromOrientation({ webkitCompassHeading: 45, screenAngleDeg: 0 }), 45),
  );
  check(
    "iOS webkitCompassHeading + 横屏补偿",
    near(headingFromOrientation({ webkitCompassHeading: 45, screenAngleDeg: 90 }), 135),
  );
  check(
    "webkitCompassHeading 优先于 alpha（两者同时存在时）",
    near(headingFromOrientation({ alpha: 180, webkitCompassHeading: 45, screenAngleDeg: 0 }), 45),
  );
}

/* ══════════════════════════ ④ 平滑器 ══════════════════════════ */
console.log("\n④ 平滑：首帧 / 死区 / 最短弧 / 限速");
{
  const s = createHeadingSmoother();
  check("首帧直接采用（不做渐变，否则进入导航时箭头会从 0 甩过来）", s.push(350, 1000) === 350);

  // 350 → 10：必须朝 +20 方向小步移动，而不是朝 -340
  const v1 = s.push(10, 1016);
  const d1 = shortestDeltaDeg(350, v1);
  check("350→10 沿最短弧前进（0 < 增量 < 20）", d1 > 0 && d1 < 20, `v=${v1.toFixed(2)} 增量=${d1.toFixed(2)}°`);

  // 死区：微小变化不推动
  const before = s.value as number;
  const v2 = s.push(normalizeDeg(before + HEADING_DEADBAND_DEG * 0.5), 1032);
  check("死区内（<1.2°）不更新 ⇒ 静置不抖", v2 === before, `${before.toFixed(3)} → ${v2.toFixed(3)}`);

  // 限速：1ms 内跳 180°，单帧步长不得超过 maxRate×dt
  const s2 = createHeadingSmoother();
  s2.push(0, 1000);
  const v3 = s2.push(180, 1001);
  check(
    "磁扰跳变被角速度上限拦住（1ms 内步长 ≤ 0.54°）",
    Math.abs(v3) <= (HEADING_MAX_RATE_DEG_S * 1) / 1000 + 1e-6,
    `v=${v3.toFixed(3)}`,
  );

  // 快速转身：delta > 25° 时用更小时间常数（跟手）
  const s3 = createHeadingSmoother();
  s3.push(0, 1000);
  const fast = s3.push(60, 1016);
  const slowRef = createHeadingSmoother({ fastDeltaDeg: 999 });
  slowRef.push(0, 1000);
  const slow = slowRef.push(60, 1016);
  check("快速转身比常规更跟手（同一输入前进更多）", fast > slow, `fast=${fast.toFixed(2)} slow=${slow.toFixed(2)}`);

  // 非法输入不破坏状态
  const s4 = createHeadingSmoother();
  s4.push(120, 1000);
  check("NaN 帧被忽略、保留上一值", s4.push(Number.NaN, 1016) === 120);
  s4.reset();
  check("reset 后回到 null", s4.value === null);
}

/* ══════════════════════════ ⑤ 抖动度与质量 ══════════════════════════ */
console.log("\n⑤ 抖动度（key：匀速转身不得被判成磁扰）");
{
  const noisy = [
    { deg: 0, ts: 0 },
    { deg: 4, ts: 100 },
    { deg: -3, ts: 200 },
    { deg: 2, ts: 300 },
    { deg: 0, ts: 400 },
  ].map((s) => ({ ...s, deg: normalizeDeg(s.deg) }));
  check("静止噪声 ⇒ 抖动度大（≥15°）", headingJitterDeg(noisy) >= 15, `${headingJitterDeg(noisy).toFixed(1)}°`);

  const turning = [0, 10, 20, 30].map((deg, i) => ({ deg, ts: i * 100 }));
  check("匀速转身 0→30 ⇒ 抖动度≈0", headingJitterDeg(turning) < 0.01, `${headingJitterDeg(turning).toFixed(2)}°`);

  const turnAcrossZero = [350, 355, 0, 5].map((deg, i) => ({ deg, ts: i * 100 }));
  check("跨 0° 的匀速转身 ⇒ 抖动度≈0", headingJitterDeg(turnAcrossZero) < 0.01, `${headingJitterDeg(turnAcrossZero).toFixed(2)}°`);

  check("样本不足 3 条 ⇒ 0（无从判断按稳定处理）", headingJitterDeg([{ deg: 0, ts: 0 }, { deg: 40, ts: 100 }]) === 0);

  check("iOS 精度 -1 ⇒ invalid", headingQualityOf(-1, 0) === "invalid");
  check("iOS 精度 40 ⇒ poor", headingQualityOf(40, 0) === "poor");
  check("iOS 精度 10 ⇒ ok（抖动度不参与，避免转身时误判）", headingQualityOf(10, 200) === "ok");
  check("无精度字段 + 抖动 40 ⇒ poor", headingQualityOf(null, 40) === "poor");
  check("无精度字段 + 抖动 5 ⇒ ok", headingQualityOf(null, 5) === "ok");
}

/* ══════════════════════════ ⑥ 降级链 ══════════════════════════ */
console.log("\n⑥ 降级链：compass → course → north");
{
  check(
    "罗盘 ok ⇒ compass（即使有行进方向）",
    pickHeadingMode({ compassHeading: 90, quality: "ok", courseDeg: 180, speedMps: 3 }) === "compass",
  );
  check(
    "罗盘 poor + 行进中 ⇒ course",
    pickHeadingMode({ compassHeading: 90, quality: "poor", courseDeg: 180, speedMps: 3 }) === "course",
  );
  check(
    "罗盘 poor + 静止 ⇒ north（静止的 course 无意义）",
    pickHeadingMode({ compassHeading: 90, quality: "poor", courseDeg: 180, speedMps: 0.3 }) === "north",
  );
  check(
    "无罗盘 + 无航向 ⇒ north",
    pickHeadingMode({ compassHeading: null, quality: "invalid", courseDeg: null, speedMps: null }) === "north",
  );
  check(
    `速度门限 = ${COURSE_MIN_SPEED_MPS}m/s：略低于门限不算行进`,
    pickHeadingMode({
      compassHeading: null,
      quality: "invalid",
      courseDeg: 90,
      speedMps: COURSE_MIN_SPEED_MPS - 0.05,
    }) === "north",
  );
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 存在失败"}：pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
