"use client";

/**
 * 吸底操作条（src/components/nav/NavTrackBar.tsx，2026-09-25 · v2.14 · 06 §2.1 / AC-16/24）
 *
 * 结构：状态行 = `● 状态 · 车牌(+车号)` + 右侧「即将到达 / 新鲜度」
 * （★ 本批 AC-33：**去掉重复的「下一站」** —— 下一站唯一来源 = 纵条 `.navstrip__badge`）；
 * 按钮行 = 主按钮（我已下车）+ 文字纠错（不是这辆 / 还没到）。
 *
 * ★ 2026-11-07（修复批 #7，负责人原话「导航时底栏车牌的右边」）：
 *   ① 车牌右侧追加**车队编号角标**（`.vcode`，如 `HE247`）—— 与车辆卡
 *      （`VehicleCard.tsx:172-176`）**同一套 class**，不另造第二套视觉；
 *      数据由 `busCode` prop 传入（`plate` 与 `busCode` 相同时**只渲染一个**，理由见渲染处注释）。
 *   ② 右槽文案来源改为**三态显式**（`soon` → 即将到达 / `now` → 留空 / `none` → 新鲜度），
 *      并把「本次右槽用的是哪一路来源」暴露为 `data-nav-right` ——
 *      修复前 `alarm` 的取值在 DOM 上**完全不可观测**（见 `NavDetailBody.tsx:265` 的既有记录：
 *      「`alarm` 本身不在 DOM 上（引擎内联表达式，无导出、无属性），QA 读不到」）
 *      ⇒ 「快下车不显示即将到达」无法区分是**数据层没到 `soon`** 还是**展示层没渲染**。
 * ★ 2026-11-03（负责人拍板）：**底栏刷新键已删** —— 与面板右上刷新键（`RouteSheet` 头部）
 *   同调 `refreshNow`、共享同一 5s 冷却，属纯重复入口。刷新唯一入口 = 面板右上。
 * ★ 2026-11-03（负责人拍板）：**三种来源标签（依据车辆位置 / 实时定位 / 手动）全部删除**
 *   —— 用户明确不要这类标签，AC-23 作废。进度来源仍由数据层 `progressSource` 承担
 *   （驱动 5 处业务判定，见 `useRideTracking`），且 `data-match-source` 观测属性**保留**
 *   （QA 断言依赖，与已删的展示标签是两条独立链路）。
 *
 * 挂载：由 `RouteSheet` 渲染在 **`.route-sheet__actions-slot`**（面板根、`transform` 同上下文，
 * AC-58）；本组件只负责内容，不自持 `position: sticky`。
 *
 * 常驻纠错（07 §1.5）：安全网检出 `anomaly` 时**不静默** —— 状态行右侧中性提示 + 对应按钮高亮；
 * 手动通道始终可用（等车态「手动标记上车」弱样式）。
 *
 * 纪律：全 Token 上色；单行 nowrap；决策点 ≤4；新鲜度不占主按钮位。
 */
import type { ReactNode } from "react";
import BusCodeChip from "./BusCodeChip";
import type { RidePhase } from "./useRideTracking";

export interface NavTrackBarProps {
  phase: RidePhase;
  /** 当前段线路展示名（如「51 路」/「轻轨 石排灣線」） */
  routeLabel: string;
  /** 上车站显示名（等车态） */
  boardLabel: string;
  /** 下车站显示名 */
  alightLabel: string;
  plate: string | null;
  /**
   * ★ 修复批 #7（负责人原话「导航时底栏车牌的右边」）：**车队编号**（DSAT `busCode`，如 `HE247`）。
   *
   * · 与 `plate`（车牌，如 `AA-77-59`）同指**同一台车**，故必须紧贴车牌右侧（相邻才有归属感）；
   * · 取不到 / 无车牌时不渲染（不留空位）—— 判据用 `busCode && …`，**不要**写
   *   `busCode !== null`：后端刻意让缺字段**整个键不存在**，`undefined !== null` 会渲染空角标
   *   （同 `VehicleCard.tsx:169-171` 的既有教训）；
   * · 与 `plate` 相同 ⇒ 只渲染车牌那一个（见渲染处注释，避免 `HE247 HE247`）。
   */
  busCode?: string | null;
  alarm: "none" | "soon" | "now";
  /** 是否轻轨段（决定纠错入口） */
  lrt: boolean;
  /**
   * ★ v3.6.0（AC-25a）：自动上车判定实际状态。
   *   `paused`（拒权/超时/连续低精度）⇒ 文案必须说"已暂停"，**不得**再说"正在检测"。
   */
  boardDetect?: "on" | "paused";
  /** 安全网检出 */
  anomaly: "none" | "not_boarded" | "alighted";
  /** 状态提示（无车 / 丢信号 / 获取失败等；boarding/riding 可见） */
  note: string;
  /** 新鲜度（秒）；null = 不显示 */
  freshSec: number | null;
  /** ★ 本批：自动下车瞬态（用于 `data-track-state='alighted'`，AC-55/56） */
  justAlighted?: boolean;
  /**
   * ★ v3.7.0 S3 三个**独立**观测属性（事件 / 状态 / 置信，合并就无法断言跃迁）：
   *   `boardMatch` → `data-board-match`：`none|auto|confirmed|corrected|manual`
   *     （`confirmed` = **用户确认**，当前无此界面故不出现；断言挂 `none→auto` 那次回调）；
   *   `matchSource` → `data-match-source`：`gps|gps+vehicle|vehicle|manual`
   *     （稳态读到 `vehicle` 是正常后置值）；
   *   `matchPending` → `data-match-pending="1"`：**中置信**（证据不足，只标注不据此报站）。
   */
  boardMatch?: "none" | "auto" | "confirmed" | "corrected" | "manual";
  matchSource?: "gps" | "gps+vehicle" | "vehicle" | "manual";
  matchPending?: boolean;
  /** ★ v3.7.0 S3：中置信车牌 —— **只展示、不驱动报站**（`plate` 仍为 null，进度走 GPS） */
  pendingPlate?: string | null;
  onStart: () => void;
  onBoard: () => void;
  onAlight: () => void;
  onRepick: () => void;
  onStop: () => void;
  /** 「我没上车」（A1 纠错 → 回等车） */
  onNotBoard: () => void;
  /** 「还没到」（误报到站 → 回乘车中） */
  onNotArrive: () => void;
}

export default function NavTrackBar(props: NavTrackBarProps) {
  const {
    phase,
    routeLabel,
    boardLabel,
    alightLabel,
    plate,
    busCode = null,
    alarm,
    lrt,
    boardDetect = "on",
    anomaly,
    note,
    freshSec,
    justAlighted = false,
    boardMatch = "none",
    matchSource = "gps",
    matchPending = false,
    pendingPlate = null,
    onStart,
    onBoard,
    onAlight,
    onRepick,
    onStop,
    onNotBoard,
    onNotArrive,
  } = props;

  const isRiding = phase === "riding";
  /**
   * ★ v3.10.0：**自动判定进入 riding ⇒ 纠错入口用「我没上车」（而非「不是这辆」）**。
   *
   * 背景：v3.10.0 解除了步行段的上车判定硬封，用户在车上点「开始导航」时会由速度判定
   * 自动切入 riding。该判定可能因「沿公交线路跑步/骑行」误判（负责人已知悉并接受，
   * 条件是有回退入口）。
   *
   * 用 `boardMatch === "auto"` 作为判据是**精确**的，不是近似：
   *   · `switchToRiding`（自动路径）⇒ `setBoardMatch("auto")`；
   *   · 手动 `board()`（bus 且有候选车）⇒ 显式覆盖为 `"manual"` + `setAutoSwitched(false)`；
   *   ⇒ `"auto"` ⟺ 「本次 riding 由系统自动判定」。
   *
   * 语义上也更对：自动判定被否定时，用户要表达的是"这不是我上的车（整段判定作废）"
   * → `onNotBoard` 回等车；而"不是这辆（换候选）"只对手动选车有意义。
   */
  const correctAuto = anomaly !== "none" || boardMatch === "auto";
  /**
   * ★ 2026-11-03（负责人拍板）：**来源标签已删**（原 AC-23 的「依据车辆位置 / 实时定位 / 手动」
   *   三态展示）。原因：用户明确不要这类标签，且它与「新鲜度」「即将到达」抢同一行位置。
   *   注意三件事**没有**跟着删：
   *     · `useRideTracking.progressSource` —— 数据层，驱动 5 处业务判定（报站分派 / 下车冷却 /
   *       自动下车冻结判据 / 撤销恢复）；
   *     · `data-match-source` 属性（本组件下方）—— QA 断言依赖，与展示标签是两条独立链路；
   *     · `.nav-actions__src` 样式 —— 仍被 `anomalyHint` 与 `NavStrip` 的 `waitSrc` 消费。
   */

  // 左：状态文案
  let left: ReactNode = null;
  // 右：补充信息（紧急信息优先）
  let right: string | null = null;
  /**
   * ★ 修复批 #7：右槽来源（观测用，落到 `data-nav-right`）。修复前只能靠肉眼猜。
   *   `soon`=即将到达 / `board`=检测态 / `now`=已到站(按设计留空) / `fresh`=新鲜度 / `none`=无
   */
  let rightSrc: "soon" | "now" | "board" | "fresh" | "none" = "none";
  /**
   * ★ 修复批 #7：底栏要渲染的车号（`null` = 不渲染）。
   *   `busCode === plate` ⇒ 归 `null`（同一串字符不重复两遍），见渲染处注释。
   */
  const showCode = plate && busCode && busCode !== plate ? busCode : null;

  if (phase === "off") {
    left = <>准备出发</>;
    right = null;
  } else if (phase === "boarding") {
    left = (
      <>
        等待上车 · <b>{boardLabel}</b>
      </>
    );
    /**
     * ★ v3.6.0（AC-25a）：判定已停止时**不得**再写「正在检测车辆」——
     *   那会把"我不再看"渲染成"车还没来"。完整原因由下方 `note` 承担，
     *   这里只给最短状态词，避免同一句话在状态行/提示行/按钮行说三遍。
     */
    right = boardDetect === "paused" ? "已暂停" : "正在检测车辆";
    rightSrc = "board";
  } else if (phase === "riding") {
    if (alarm === "now") {
      left = (
        <>
          已到站 · <b>{alightLabel}</b>
        </>
      );
    } else {
      left = (
        <>
          乘车中 ·{" "}
          {/* ★ v3.6.1：有牌号 ⇒ 车牌标签；无牌号回落**线路名**（绝不能套车牌马甲，外层也别再套 `<b>`）。v3.7.0 S3：中置信（`plate` 为 null）⇒ 车牌 + 「待确认」；contract：medium 不得据以报站 */}
          {plate ? (
            <>
              <span className="plate plate--sm">{plate}</span>
              {/*
            ★ 修复批 #7（负责人原话「这个标签也要放在导航时底栏车牌的右边」）：
              车队编号角标 —— 复用车辆卡的 **`.vcode`**（定义 `globals.css:5618`，全局类，
              透明底 + `--muted` 字 + 500 字重 + 11px，视觉权重低于车牌），**不新造样式**。

            ⚠️ `plate === busCode ⇒ 不渲染`（负责人倾向，已采纳）：两者同指一台车时并排会出现
              `HE247 HE247` —— 同一串字符说两遍，既占宽（底栏单行、320px 更紧）又读起来像故障。
              保留哪一个：**车牌**（`.plate` 是强视觉，且它是进度/纠错的唯一标识）。
            ⚠️ 判据用 `showCode`（已归一化的 `string | null`），**不写** `busCode !== null`：
              后端让缺字段整个键不存在 ⇒ `undefined !== null` 为真 ⇒ 会渲染出空角标
              （同 `VehicleCard.tsx:169-171`）。

            ★ 2026-11-07（需求 #8）：本轮**挂上了点击** —— 原注释预留的「将来挂点击」
              已按当时的结论落地：命中区是**本角标自身**（共用件 `BusCodeChip` 内部的
              `<button type="button" className="vcode">`），**没有**挂到
              `.nav-actions__staterow`（那会把车牌/状态词一起变成点击区，且与按钮行语义打架）。
              点击 ⇒ 弹「车型信息卡」（无叉 · 点外部/Esc 关闭），与车辆卡里那枚角标同一行为。
              `data-bus-code={showCode}` 由 `BusCodeChip` 一并输出（QA 断言依赖，不能丢）。
          */}
              {showCode && <BusCodeChip code={showCode} plate={plate} />}
            </>
          ) : pendingPlate ? (
            <>
              <span className="plate plate--sm">{pendingPlate}</span>
              <span className="nav-actions__sub"> · 车牌待确认</span>
            </>
          ) : (
            <b>{routeLabel}</b>
          )}
          {!plate && lrt && <span className="nav-actions__sub"> · {routeLabel}</span>}
        </>
      );
    }
    /**
     * ★ 修复批 #7：右槽**三态显式**（原来只有 `soon` 一路，其余全部落到下面的新鲜度兜底）。
     *
     * 设计口径（`docs/改版-导航界面-20260925/06-设计-详细设计.md:118-124` 的五态表）：
     *   · 临近下车 ⇒ 右槽 `即将到达 M250 澳科大`；
     *   · 已到站   ⇒ 右槽 **`—`（留空）** —— 紧急信号已由左槽「已到站 · 站名」承担。
     * ⇒ `now` 必须显式置空并**阻止**新鲜度回落（见下方兜底条件的注释），
     *   否则「快下车那一刻」左下角刚说「已到站」，右下角却在报数据新鲜度。
     */
    right = alarm === "soon" ? `即将到达 ${alightLabel}` : null;
    rightSrc = alarm === "soon" ? "soon" : alarm === "now" ? "now" : "none";
  } else {
    left = <>已到达目的地</>;
  }

  /**
   * 新鲜度让位（仅 riding 且**无更紧急信息**时）。
   *
   * ★ 修复批 #7（负责人原话「快下车时不显示即将到达，仍显示上次刷新时间」）——
   *   本行是那句「仍显示上次刷新时间」的**唯一来源**，根因是「无更紧急信息」只判了
   *   **右槽自己**（`!right`），没判**左槽**：
   *     · `alarm === "now"`（车已停靠下车站 = 用户「快下车」的那一瞬）⇒ 左槽已写
   *       「已到站 · 站名」，右槽按设计**留空**（设计五态表 :123 该列就是「—」），
   *       但本行仍把「上次更新：N 秒前」塞进右槽 ⇒ 用户看到的是数据新鲜度，而不是临近下车信息。
   *   设计另一处同口径（同文件 :143）：「状态行右侧在**无更紧急信息时**显示 上次更新」——
   *   有「已到站」时显然不属于"无更紧急信息"。
   *   ⇒ 兜底条件收紧为 `alarm === "none"`：`soon`（已被即将到达占用）与 `now`（设计留空）
   *     都不再回落新鲜度。**未改任何阈值、未动 `alarm` 判据**（判据在 `useRideTracking`，
   *     属他人的文件；本次只在展示层按设计表把三态摆正）。
   */
  if (isRiding && alarm === "none" && !right && freshSec != null) {
    right = `上次更新：${freshSec} 秒前`;
    rightSrc = "fresh";
  }

  // 安全网提示（状态行内）
  const anomalyHint =
    anomaly === "not_boarded" ? "疑似还没上车" : anomaly === "alighted" ? "疑似已下车" : null;

  return (
    <div
      className="nav-actions"
      data-nav-phase={phase}
      data-track-state={justAlighted ? "alighted" : phase}
      data-board-detect={phase === "boarding" || phase === "off" ? boardDetect : undefined}
      /**
       * ★ 修复批 #7：把 `alarm` 与「右槽实际用的是哪一路来源」放上 DOM。
       *
       * 为什么必须加：`alarm` 原本是**引擎内联表达式**，DOM 上完全没有
       *   （`NavDetailBody.tsx:265` 已记录过这个缺口：「QA 读不到」）⇒ 用户报
       *   「快下车不显示即将到达」时，无法区分是
       *     ① 数据层 `alarm` 没变成 `soon`（车序/进度的锅），还是
       *     ② 展示层没渲染（本文件的锅）。
       * 命名取 `data-nav-alarm`（而非 `data-alarm`）：后者已被页面级下车横幅
       *   `.nav-alarm--top`（`NavShell.tsx:2352`）占用，同名会让「取唯一元素」的断言串味。
       */
      data-nav-alarm={alarm}
      data-nav-right={rightSrc}
      /**
       * ★ v3.7.0 S3：两个**独立**观测属性（一个事件、一个状态，合并就无法断言跃迁）。
       *   · `data-board-match` 取值 `none|auto|confirmed|corrected|manual`；
       *   · `data-match-source` 取值 `gps|gps+vehicle|vehicle|manual` ——
       *     `vehicle` 在**稳态**出现是正常的（锁牌后进度本就来自车辆）；
       *     断言只能挂在 `data-board-match` 由 `none → auto/confirmed` 的**那一次回调**里。
       */
      data-board-match={boardMatch}
      data-match-source={matchSource}
      data-match-pending={matchPending ? "1" : undefined}
    >
      <div className="nav-actions__staterow">
        <span className="nav-actions__dot" aria-hidden="true" />
        {left}
        {anomalyHint && <span className="nav-actions__src">{anomalyHint}</span>}
        {/*
          ★ 修复批 #7：右槽多挂一个 `nav-actions__right` 类 —— 纯占位，**当前 globals.css 里没有规则**
          （加类不改任何视觉）。用途：为「长站名在 320/375px 顶出面板」的修复留一个**只作用于右槽**的
          挂点（`.nav-actions__spacer` 还被按钮行的 `.nav-actions__hint` 复用，不能直接改那条规则）。
          配套 CSS 见交付报告（`.nav-actions__right { flex: 0 1 auto; min-width: 0; overflow: hidden;
          text-overflow: ellipsis; }`），需由主理人转交 globals.css 的属主落地。
        */}
        {right && <span className="nav-actions__spacer nav-actions__right">{right}</span>}
      </div>

      <div className="nav-actions__btnrow">
        {phase === "off" && (
          <button type="button" className="btn btn--primary btn--sm" onClick={onStart}>
            开始导航
          </button>
        )}

        {phase === "boarding" && (
          <>
            <button
              type="button"
              className={`btn btn--text btn--sm${anomaly === "not_boarded" ? " is-emph" : ""}`}
              onClick={anomaly === "not_boarded" ? onNotBoard : onBoard}
            >
              {anomaly === "not_boarded" ? "我没上车" : "手动标记上车"}
            </button>
            <span className="nav-actions__spacer nav-actions__hint">
              {boardDetect === "paused"
                ? "定位不可用，上车后请手动点左侧按钮"
                : "上车后自动开始跟踪"}
            </span>
            <button type="button" className="btn btn--text btn--sm" onClick={onStop}>
              结束导航
            </button>
          </>
        )}

        {phase === "riding" && (
          <>
            <button type="button" className="btn btn--primary btn--sm" onClick={onAlight}>
              {alarm === "now" ? "已下车" : "我已下车"}
            </button>
            {alarm === "soon" || alarm === "now" ? (
              <button type="button" className="btn btn--text btn--sm" onClick={onNotArrive}>
                还没到
              </button>
            ) : (
              !lrt && (
                /* ★ v3.10.0：`correctAuto` 见组件顶部派生（自动判定进入 ⇒ 「我没上车」） */
                <button
                  type="button"
                  className={`btn btn--text btn--sm${anomaly !== "none" ? " is-emph" : ""}`}
                  onClick={correctAuto ? onNotBoard : onRepick}
                >
                  {correctAuto ? "我没上车" : "不是这辆"}
                </button>
              )
            )}
          </>
        )}

        {phase === "done" && (
          <button type="button" className="btn btn--primary btn--sm" onClick={onStop}>
            结束导航
          </button>
        )}
      </div>

      {/* 状态提示（无车 / 丢信号 / 获取失败等；boarding/riding 可见，防「静默失败」） */}
      {(phase === "boarding" || phase === "riding") && note && (
        <p className="nav-track__note t-label" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
