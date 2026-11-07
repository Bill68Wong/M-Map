/**
 * /help —— 帮助与合规（src/app/help/page.tsx，v2.10.0）
 *
 * ── 这一页是**条款义务的落地**，不是装饰 ───────────────────────────────
 *   依据 `docs/数据来源合规备忘-20260914.md`：澳门特别行政区交通事务局（DSAT）网站使用条款
 *   （2009-10-28）明确：
 *     #3 非商业用途可复制再发布，必须注明内容由交通事务局提供 + 获得内容的日期；
 *     #5 禁止任何商业性用途（需书面授权）；
 *     #6 不得对内容作任何修改；
 *     #7 数字可再运算统计出新数字，但公布时必须指出来源 + 说明计算方法。
 *   自动选线 / 到站推算正是 #7 所说的「对官方数字再运算得出的新数字」⇒ 本页即其披露。
 *
 * ── 结构（Spec §7 锁定）──────────────────────────────────────────────
 *   ① 数据来源与合规（**置顶、不可折叠**；沿用旧 /about 六节，保留全部仍有效内容）
 *   ② 使用说明（3 步纵列，复用 `.rc-row` 纵向轨语言）
 *   ③ FAQ 手风琴（原生 `<details>`：零 JS、键盘可访问、默认全收）
 *
 * ── ★ v2.10.0 两处合规内容修订（原 /about 已过时）──────────────────────
 *   · 轻轨时间**由「逐跳 2 分钟」改为**「分线不同」（石排灣線 1'40" / 橫琴線 2'15" / 氹仔線约 2 分钟）；
 *   · 数据来源**补上**新增两类：线路走向（高德 `/v3/bus/linename`）、
 *     车辆实时经纬度（DSAT `/routestation/location`）。
 *
 * ── ★ 2026-11-04 合规复核：三处**事实性错误**已更正（负责人指出其中一处）──────
 *   ① 「站间行驶时间…全部来自本人实地打点」→ **错**。实际主数据源是**对 DSAT 报站帧的自动采集**
 *      （`scripts/track-collect.mjs` 每 5 秒轮询挂载站/status → `track-derive.mjs` 按「离开口径」
 *       还原站间时长 → `segment_samples.source='track'` → `build-hop-stats.ts` 聚合）。
 *      实测占比：track **183,086** 条 vs 人工计时（timer）**243** 条 ⇒ 人工样本仅作交叉校验。
 *   ② 「位置不会上传到服务器保存，也不会…分享给第三方」→ **错**。`/api/nav` 以坐标为入参
 *      （`fromLng/fromLat/toLng/toLat`），并按 `odKeyOf()`（`amap/transit.ts:396-414`）把
 *      「起点坐标｜终点坐标｜时间」写入 `transit_cache.od_key`；规划本身还会把坐标发给
 *      **高德路径规划接口**（`amap/transit.ts:449`）。已改为如实披露「会发送/会随缓存留存」。
 *   ③ 「无实测样本的按地图直线距离经验系数推算」→ **错**。实际回退链是
 *      「同地点其他站点均值 → 全表均值 → 固定值」（`recommend/model.ts:165-191` 的 5 档）；
 *      距离（`station_walk_distance`）只用于赶车分档（`tier1EffRatio`），**不换算成分钟**。
 *
 *   ⚠️ 遗留待办（需改代码，不在本次文案修订范围）：离线抓取类数据（线路走向/轻轨时刻表/步行样本/
 *      步行距离）的**逐项取得日期**尚未上屏，仅在库内（`route_shapes.fetched_at`、
 *      `walk_times.measured_at`、`station_walk_distance.fetched_at`、`lrt_route_params.measured_on`）。
 *      条款 #3 要求「註明獲得內容的日期」，建议后续以构建期常量或读库方式逐项展示。
 *
 * ⚠️ 繁体仅用于**机构/官方专有名称与地名**（交通事務局 / 澳門輕軌 / 氹仔線 …）；
 *    其余行文一律简体。
 */
import Link from "next/link";
import Icon from "@/components/ui/Icon";
import BottomNav from "@/components/BottomNav";
import { DSAT_UA } from "@/lib/dsat/ua";

export const metadata = {
  title: "帮助与合规",
  description: "数据来源、计算方法、使用说明与常见问题",
};

const P = ({ children }: { children: React.ReactNode }) => <p className="help-p">{children}</p>;

const UL = ({ items }: { items: React.ReactNode[] }) => (
  <ul className="help-ul">
    {items.map((it, i) => (
      <li key={i}>{it}</li>
    ))}
  </ul>
);

export default function HelpPage() {
  const macau = new Date(Date.now() + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const today = `${macau.getUTCFullYear()}-${p(macau.getUTCMonth() + 1)}-${p(macau.getUTCDate())}`;

  const faqs: { q: string; a: React.ReactNode }[] = [
    {
      q: "为什么地图上看不到车辆？",
      a: (
        <>
          在途车辆只在该线路的<b>路线查看模式</b>下显示，且仅限<b>巴士</b>线路。请点右侧「公共交通路线」选一条巴士
          线路进入查看；轻轨线路没有实时车辆数据（见下一条）。
        </>
      ),
    },
    {
      q: "为什么轻轨没有车辆图标？",
      a: (
        <>
          车辆位置来自澳门交通事務局的<b>巴士</b>报站系统，官方<b>不提供轻轨车辆的实时位置</b>。因此轻轨只显示线路走向与
          站点，不显示在途车辆——这是数据源限制，不是故障。
        </>
      ),
    },
    {
      q: "车辆位置多久更新一次？为什么要手动刷新？",
      a: (
        <>
          为了避免持续轮询给官方接口带来压力，本服务<b>不做自动轮询</b>：进入线路或换向时会自动取一次，之后由你手动
          点「刷新」更新。刷新有 <b>10 秒冷却</b>（按钮显示剩余秒数），自动刷新与手动刷新共用同一冷却计时。
        </>
      ),
    },
    {
      q: "车辆位置和时间准确吗？",
      a: (
        <>
          坐标来自官方上报，本服务把 WGS84 转成地图坐标系（GCJ-02）后如实呈现；车速、状态与行驶区间为官方原始
          字段。GPS 存在固有误差，位置仅供参考，请以现场为准。
        </>
      ),
    },
    {
      q: "換乘站的图标为什么是两种颜色？",
      a: (
        <>
          蓮花站与協和醫院站是<b>换乘站</b>，一枚图标同时代表两条线路 ⇒ 用<b>双色切分</b>表达（斜切 / 水平切），
          并把「形状」作为第一区分手段（巴士=圆点、轻轨=方点），不只依赖颜色。
        </>
      ),
    },
    {
      q: "数据来自哪里？是否修改过原始内容？",
      a: (
        <>
          见上方「数据来源与合规」。          站名、线路名、站序等均为官方原始数据，本服务<b>原样展示、不作任何修改</b>；
          所有推算值都以「约」「≈」「推算」等措辞与官方原始数值区分，不与官方数据混淆，也不代表官方版本或经官方认可。
        </>
      ),
    },
  ];

  return (
    <main className="page page--with-nav">
      <header className="rc-top">
        <Link href="/" className="btn btn--text btn--sm">
          <Icon name="back" size={20} />
          返回
        </Link>
      </header>

      <h1 className="h-headline" style={{ margin: "6px 0 4px" }}>
        帮助与合规
      </h1>
      <p className="t-label t-muted" style={{ marginBottom: 4 }}>
        M Map · 澳門巴士／轻轨全澳导航
      </p>

      {/* ── ① 数据来源与合规（置顶 · 不可折叠）── */}
      <section className="card help-sec" style={{ padding: "16px 16px 18px" }}>
        <h2 className="help-h2">
          <Icon name="info-circle" size={20} />
          数据来源与合规
        </h2>

        <h3 className="help-h2" style={{ fontSize: "var(--text-md)", marginTop: 14 }}>
          一、非商业声明
        </h3>
        <P>
          本专案为<b>个人学业 / 作品用途</b>，不收取任何费用、不投放广告、不进行任何形式的商业利用。
          专案与其数据仅供本人通勤参考。
        </P>
        <P>
          注意：交通事務局使用条款（更新日期 <b>2009-10-28</b>）明确禁止未经书面授权的商业性用途。
          若未来考虑任何形式的变现，将先取得官方书面授权。
        </P>

        <h3 className="help-h2" style={{ fontSize: "var(--text-md)", marginTop: 14 }}>
          二、数据来源与取得日期
        </h3>
        <UL
          items={[
            <>
              <b>实时报站数据</b>：澳門特別行政區交通事務局（DSAT）巴士报站接口。
              本页生成于 <b>{today}</b>（澳門时间）；画面上显示的「更新于 HH:MM」即为该次取得内容的时刻。
            </>,
            <>
              <b>车辆实时经纬度</b>：DSAT 车辆位置接口（<code>/routestation/location</code>），
              经本服务转为地图坐标系后展示。
            </>,
            <>
              <b>线路走向</b>：高德地图线路检索接口（<code>/v3/bus/linename</code>），
              离线抓取线路几何后存库，请求期不再访问高德。
            </>,
            <>
              <b>轻轨时刻表</b>：澳門輕軌公开时刻数据（经 motransportinfo 取得），班次按官方时刻表推算。
            </>,
            <>
              <b>通琴号（横琴口岸跨境班车）</b>：线路标号、班次、站点与站序来自通琴号公布的时刻表，
              经整理后入库；班次与时刻均为<b>静态时刻表</b>（计划发车 / 计划到达），
              本服务<b>不提供其到站预报、车辆位置或拥挤度</b>，界面上的时刻一律不是实时数据。
              线路走线由高德路径接口离线计算后存库，请求期不再访问高德。
            </>,
            <>
              <b>站间行驶时间</b>：官方<b>未发布</b>站间用时数据。本服务对 DSAT 公开的实时报站数据做
              <b>自动采集</b>（轮询车辆的「挂载站」与「停靠／已离站」状态），按「离开上一站 → 离开下一站」
              的口径还原每个相邻站对的用时，取同站对中位数后入库。<b>属推算值，不是官方数据</b>；
              本人少量计时样本仅用于交叉校验，不构成主要数据来源。
            </>,
            <>
              <b>步行时间</b>：官方同样<b>未发布</b>。推荐页使用本人在若干地点实测的步行样本均值
              （澳門科技大學按校区座别分组）；样本不足时依次退回「同地点均值 → 全表均值 → 固定值」，
              详见下方「五、推算数值的计算方法」。全澳导航的<b>首末段步行时长</b>则由
              <b>高德路径规划接口</b>实时返回。
            </>,
            <>
              <b>地图底图与路线规划（全澳导航）</b>：本服务来源于<b>高德地图</b>（AutoNavi）。导航的候选路线、
              首末段步行几何由高德路径规划接口提供；地图底图由高德 JS API 绘制。
              本服务对其<strong>原始数据不作修改</strong>，仅在此之上做时间重算与排序。
            </>,
          ]}
        />

        <P>
          说明：<b>实时类</b>数据（巴士报站、车辆位置）的取得日期即为画面上「更新于 HH:MM」的时刻；
          <b>离线抓取类</b>数据（线路走向、轻轨时刻表、步行样本与步行距离）的取得日期<b>逐项不同</b>，
          均记录在项目的数据同步记录中，如需核对可通过下方专案网址联系。
        </P>

        <h3 className="help-h2" style={{ fontSize: "var(--text-md)", marginTop: 14 }}>
          三、位置用途说明
        </h3>
        <P>
          全澳导航需要取得你的位置，用途<b>仅限于计算路线</b>：坐标会作为路径规划请求的起点，
          <b>发送到本服务与高德路径规划接口（第三方）</b>；为减少重复请求，服务端会按
          「起点坐标｜终点坐标｜时间」缓存规划结果，因此起终点坐标会随该缓存一并留存。
          该缓存<b>不绑定账号、不含其他个人资料</b>，也不用于任何其他目的。
        </P>
        <P>
          推荐页（「家 → 学校」等固定方向）<b>不使用你的位置</b>，只按预设地点名计算，因此无需定位授权。
        </P>
        <P>你可以在浏览器／系统设置中随时关闭定位授权；关闭后仍可<b>手动选择出发地</b>使用本功能。</P>

        <h3 className="help-h2" style={{ fontSize: "var(--text-md)", marginTop: 14 }}>
          四、不对原始内容作任何修改
        </h3>
        <P>
          站名、线路名、站序等均为官方原始数据，本专案<b>原样展示、不作任何修改</b>。所有推估值均以
          「约」「≈」「推算」等措辞与官方原始数值区分，不与官方数据混淆，亦不代表官方版本或经官方认可。
        </P>

        <h3 className="help-h2" style={{ fontSize: "var(--text-md)", marginTop: 14 }}>
          五、推算数值的计算方法
        </h3>
        <P>
          「还有 N 站 ≈ 还要 X 分钟」、「最快路线」、「赶车分档」都是
          <b>由官方数字再运算得出的新数字</b>，计算方法如下：
        </P>
        <UL
          items={[
            <>
              <b>还有几站 → 几分钟</b>：用 DSAT 提供的「车辆挂载站」与用户等车站的站序差（即 N 站），
              把 N 个相邻区间<b>逐跳累加</b>，每跳取同站对的实测中位数（<b>不乘单一常数</b>）。
            </>,
            <>
              <b>车上时间</b>：站间实测统计值。口径为「关好门准备起步」至下站同一状态（含到站停靠）。
            </>,
            <>
              <b>步行时间</b>：同一地点↔站点的实测样本均值；澳門科技大學不同校区座别分开统计。
              <b>无实测样本</b>时依次退回「同地点其他站点均值 → 全表均值 → 固定值」，
              <b>不是</b>按直线距离换算。步行<b>距离</b>只用于判断「需要走多快才赶得上」（赶车分档），
              不直接换算成分钟。
            </>,
            <>
              <b>轻轨时间（分线不同）</b>：按各线实测的<b>单区间乘车用时</b>推算 ——
              石排灣線 <b>1 分 40 秒</b>、橫琴線 <b>2 分 15 秒</b>、氹仔線约 <b>2 分钟</b>；
              并在报站时刻上叠加各线的<b>发车偏差</b>实测值（石排灣線 −5 秒、橫琴線 +40 秒）。
            </>,
            <>
              <b>赶车分档</b>：以「正常走」为基准档（第 3 档），按冲刺／小跑／慢走／爬行的速度比推算所需时间，
              再与报时下限比较得出五个档位。
            </>,
            <>
              <b>换乘步行</b>：下车打点到「到达换乘站台开始等车」的实测间隔（已扣除等车时间）。
            </>,
            <>
              <b>候选路线的取舍</b>：只列出「以正常步速能赶上首班车」的路线。赶不上的路线<b>不列入候选</b>
              （不显示带推算等车时间的替代结果）；换乘后仍取「到达换乘站时刻之后的第一班」。
            </>,
          ]}
        />
        <P>
          注意：上述数值<b>均为推算值，可能有误差</b>，亦可能因路况、班次调整而失效。请以现场实际情况为准。
          跨境的行程<b>不计通关时间</b>。
        </P>

        <h3 className="help-h2" style={{ fontSize: "var(--text-md)", marginTop: 14 }}>
          六、联络与自动化请求说明
        </h3>
        <P>本专案的自动化请求会主动亮明身份，User-Agent 为：</P>
        <p
          className="t-label"
          style={{
            marginTop: 8,
            padding: "8px 10px",
            borderRadius: "var(--r-field)",
            background: "var(--surface-dim)",
            wordBreak: "break-all",
            lineHeight: 1.6,
          }}
        >
          {DSAT_UA}
        </p>
        <P>
          请求全程<b>只读</b>（不写入、不注册、不登录），维持恒定低频节律，并具备失败降频与熔断退出机制。
          若官方认为该访问方式有任何不妥，请通过下列网址告知，将立即调整或停止。
        </P>
        <P>
          专案网址：
          <a href="https://macaomap.vercel.app" style={{ color: "var(--primary)" }}>
            macaomap.vercel.app
          </a>
        </P>
      </section>

      {/* ── ② 使用说明（3 步纵列，复用 `.rc-row` 纵向轨语言）── */}
      <section className="card help-sec" style={{ padding: "16px 16px 18px" }}>
        <h2 className="help-h2">
          <Icon name="list" size={20} />
          使用说明
        </h2>
        <div className="rc-line help-steps">
          <div className="rc-row">
            <span className="rc-dot">1</span>
            <span className="rc-text">
              点顶部搜索框「去哪儿？」选好<b>目的地</b>。
            </span>
          </div>
          <div className="rc-row">
            <span className="rc-dot">2</span>
            <span className="rc-text">
              点右侧「公共交通路线」选一条线路，地图进入<b>路线查看模式</b>：本线站点放大、其余站点转灰。
              <span className="rc-sub">
                巴士线路会显示<b>在途车辆</b>；用「刷新」更新位置、「换向」切换行驶方向（两个方向共用同一冷却计时）。
              </span>
            </span>
          </div>
          <div className="rc-row rc-row--last">
            <span className="rc-dot">3</span>
            <span className="rc-text">
              回到面板点「出发」进入导航；结果页会给出「还有 N 站 ≈ 还要几分钟」等预估。
            </span>
          </div>
        </div>
      </section>

      {/* ── ③ FAQ 手风琴（原生 `<details>`：零 JS、键盘可访问、默认全收）── */}
      <section className="card help-sec" style={{ padding: "16px 16px 18px", marginBottom: 24 }}>
        <h2 className="help-h2">
          <Icon name="help-circle" size={20} />
          常见问题
        </h2>
        <div className="help-faq">
          {faqs.map((f, i) => (
            <details key={i} className="help-faq__item">
              <summary className="help-faq__q">
                <span className="help-faq__q-text">{f.q}</span>
                <span className="help-faq__caret" aria-hidden="true">
                  <Icon name="caretDown" size={16} />
                </span>
              </summary>
              <div className="help-faq__a t-body">{f.a}</div>
            </details>
          ))}
        </div>
      </section>

      <BottomNav />
    </main>
  );
}
