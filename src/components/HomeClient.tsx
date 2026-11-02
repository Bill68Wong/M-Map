"use client";

/**
 * 旧首页（v1.0.0：方向卡直达自动选线结果）—— 现由 `/commute` 承载
 *
 * v0.13.x → v1.0.0 的入口变更：点方向卡不再进「路线选择页」，而是直接进
 * `/recommend`，由服务端在 2 秒内算出**最快 5 条门到门路线**，首页卡片即最终产物。
 *
 * ★ 修复包 v2.2.1（第 5 条）· v3.6.0 收尾：
 *   · **移除全部旧功能入口**（通勤记录 `/records` · 统计 `/stats` · 自由记站 `/free` ·
 *     继续计时 `/timer/*`）—— v3.6.0 起这些页面**已下线**（middleware 308 回首页），
 *     对应接口 `/api/timer*`、`/api/free*` 一律 **410 Gone**；
 *   · **开发者模式整体移除**（`DevModeToggle` / `DevGate` / `CardDevActions` 与 `lib/dev-mode.ts`
 *     已于 v3.6.0 删除，访问口令门同时拆除）。
 *
 * 座区在这里选（`<ZonePicker/>`）：下车后走到 B/C、N/O、R 哪一座，步行时间差得远，
 * 所以它是**必要输入**，随方向卡一起带进 `/recommend`。
 */
import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import ZonePicker, { useZone } from "./ZonePicker";
import { HOME_SLUG, PAIR_ORDER, PLACE_SHORT, dirLabel, type PlanRow, type ActiveSession } from "@/lib/home-plans-shared";

export default function HomeClient({
  plans,
  dbError,
}: {
  plans: PlanRow[];
  /** 保留（`/commute` 仍按原契约传入）；本页已不再展示「继续计时」入口 */
  active: ActiveSession | null;
  dbError: string | null;
}) {
  const router = useRouter();
  const [zone, setZone] = useZone();

  /**
   * ★ v3.1.1 #5：数据加载失败的**原始错误只进控制台**（供排查），不渲染给用户
   *   （界面只给「服务暂未就绪」这类用户语言）。
   */
  useEffect(() => {
    if (dbError) console.error("[commute] 方案数据加载失败：", dbError);
  }, [dbError]);

  if (dbError) {
    return (
      <main className="page">
        {/* ★ v3.0.0 品牌更名：产品名「MUST登校」→「M Map」；★ v3.8.0 起取消中文品牌名，统一「M Map」 */}
        <h1 className="h-headline" style={{ marginBottom: 8 }}>
          M Map
        </h1>
        <p className="t-error t-body" style={{ marginBottom: 12 }}>
          服务暂未就绪
        </p>
        {/* ★ v3.1.1 #5（文案门禁）：**不再把初始化命令/原始错误渲染给用户**
            （旧文案含 `配置 .env → npm run db:schema → db:seed`）；原始错误改走控制台日志。 */}
        <p className="t-label t-muted" style={{ lineHeight: 1.6 }}>
          数据暂时无法加载，请稍后重试。
        </p>
      </main>
    );
  }

  // 方向对行：擎天匯 ⇄ school / hengqin / gate（按 PAIR_ORDER；无任何方案的 place 不显示）
  const rows = PAIR_ORDER.map((other) => ({
    other,
    out: plans.filter((p) => p.from_slug === HOME_SLUG && p.to_slug === other),
    back: plans.filter((p) => p.from_slug === other && p.to_slug === HOME_SLUG),
  })).filter((r) => r.out.length > 0 || r.back.length > 0);

  const dirCard = (from: string, to: string, count: number, delayMs: number) => (
    <button
      className="press-card anim-fade-up"
      // v1.0.0：直达自动选线（座区随行；服务端只在涉及澳門科技大學的方向使用它）
      onClick={() => router.push(`/recommend?from=${from}&to=${to}&zone=${encodeURIComponent(zone)}`)}
      style={{ minHeight: 82, animationDelay: `${delayMs}ms` }}
      aria-label={`${dirLabel(from, to)}，${count} 条路线，查看最快路线`}
    >
      <span
        className="pc-inner"
        style={{
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 3,
          justifyContent: "center",
        }}
      >
        <span
          style={{
            fontSize: 15,
            fontWeight: 650,
            letterSpacing: 0.2,
            lineHeight: 1.35,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {PLACE_SHORT[from] ?? from}
          <span aria-hidden style={{ opacity: 0.55, fontSize: 13, flexShrink: 0 }}>
            →
          </span>
          {PLACE_SHORT[to] ?? to}
        </span>
        <span className="t-label t-muted">看最快路线 →</span>
      </span>
    </button>
  );

  return (
    <main className="page">
      <header style={{ marginBottom: 16, padding: "4px 2px" }}>
        {/* 品牌名「M Map」（★ v3.8.0 起取消中文品牌名，统一「M Map」） */}
        <h1 className="h-headline">M Map</h1>
        <p className="t-label t-muted" style={{ marginTop: 2 }}>
          选方向 → 立刻看到最快路线
        </p>
      </header>

      {/* v0.13.x：方向对分行 —— 左去程（擎天匯→地点）、右回程（地点→擎天匯） */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {rows.map((r) => (
          <section key={r.other}>
            <h2 className="group-title">
              {PLACE_SHORT[HOME_SLUG]} ⇄ {PLACE_SHORT[r.other]}
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {r.out.length > 0
                ? dirCard(HOME_SLUG, r.other, r.out.length, 0)
                : <span className="t-label t-muted" style={{ display: "flex", alignItems: "center" }}>暂无去程方案</span>}
              {r.back.length > 0
                ? dirCard(r.other, HOME_SLUG, r.back.length, 40)
                : <span className="t-label t-muted" style={{ display: "flex", alignItems: "center" }}>暂无回程方案</span>}
            </div>
          </section>
        ))}
      </div>

      {/* 座区：影响涉及澳門科技大學的方向 */}
      <div style={{ marginTop: 22 }}>
        <ZonePicker value={zone} onChange={setZone} />
      </div>

      <div
        className="t-label t-muted"
        style={{
          marginTop: "auto",
          paddingTop: 20,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          opacity: 0.9,
        }}
      >
        <p style={{ margin: 0 }}>
          数据来源：澳门交通事务局 ·{" "}
          {/* ★ v1.1.7：纯文字链接原热区仅 ~20px 高，走路时基本点不中 → .link-hit 撑到 44px */}
          <Link href="/about" className="link-hit" style={{ color: "var(--primary)" }}>
            关于本专案
          </Link>
        </p>
      </div>
    </main>
  );
}
