"use client";

/**
 * 公共厕所弹窗（M4 · 需求 3）—— 挂在 `.nav-card-overlay`（z90）里的那张卡。
 *
 * ── 标题（负责人逐字指定）──────────────────────────────────────────────
 *   `公共厕所-<設施名>`：前缀**简体**（本项目 UI 文案一律简体，见 `NavStrip` 的
 *   「下一站 / 停靠中 / 到站 / 下车」），连字符后直接接数据里的**繁體原名**——
 *   **不得转换、不得截断**（数据是官方繁体，转简体等于改政府原文）。
 *   ★ 2026-11-10 修正（2026-11-11 勘误举例）：源数据名串首带**设施编号**
 *   （`MM04 雀仔園街市地下`、`AM01 …`；198 条里 189 条是「编号+空格+名」、9 条是
 *   「编号直接接名」）。旧注释写的 `T8 雀仔園街市地下` 在数据中**不存在**：
 *   `T8` 真实对应 `T8 氹仔排角路公廁`，雀仔園那条是 `MM04`。⇒ 渲染时用
 *   `toiletDisplayName()` 剥掉编号，卡片只显示 `公共厕所-雀仔園街市地下`。
 *   **只在渲染层剥**，JSON 原文逐字保留（编号是官方数据取值，改文件等于改政府原文）。
 *
 * ── 标题排版（负责人 2026-11-10）────────────────────────────────────────
 *   要求「字号可以大一点，但**必须单行、不省略**」。⇒ 不用 `ellipsis`、不用折行；
 *   改为「短名固定 15px，长名按容器宽度自动降字号」：字符数由组件内联写入
 *   `--toilet-title-chars`，CSS 用 `min(15px, (100cqw - 按钮与间隙) / 字符数)` 折算。
 *   字符数按**码点**算且不区分全/半角 ⇒ 半角字符实际更窄，结论偏保守（只会更松，不会溢出）。
 *   实测容量依据见 `globals.css` 的 `.toilet-card` 段。
 *
 * ── 排版（负责人裁定 + 后端实测容量）──────────────────────────────────
 *   字段名与值**同一行**，**不省略号截断**；折行时新行**从值开始**（悬挂缩进）。
 *   实现：`grid-template-columns: <字段名列> 1fr`，值落在第二列 ⇒ 折行自然对齐值起点，
 *   **不用** `text-overflow: ellipsis`、**不用** `white-space: nowrap` 硬扛。
 *   容量依据：11px 字号下约 30 个全角字符一行，`openHourZh` 最长 46 字符 ⇒ 必然折行；
 *   地址同理（长地址 20+ 字）。所以**所有值列都按可折行渲染**，而不是只给开放时间开口子 ——
 *   若硬给地址 nowrap，它会溢出卡片（既裁不下也不许省略），比折行更糟。
 *
 * ── 照片 ──────────────────────────────────────────────────────────────
 *   `<img src>` 直连（已验证图片无 referrer / CORS 限制；`fetch` 反而拿不到）。
 *   加载失败 ⇒ 换成占位块，**不出现裂图图标**；无照片字段时整行不渲染。
 *
 * ── 免责/来源 ─────────────────────────────────────────────────────────
 *   卡片内**不放**任何来源/免责文案（署名统一放 `/about`，见 `toilet-attribution.ts`）。
 */
import { useState, type CSSProperties } from "react";
import Icon from "@/components/ui/Icon";
import SetPointActions from "./SetPointActions";
import { toiletDisplayName, type PublicToilet } from "@/lib/map/public-toilets";

export interface PublicToiletCardProps {
  toilet: PublicToilet;
  /** 导航语境（首页以外）⇒ 设点按钮整块不渲染（判定在 `SetPointActions` 内部） */
  navActive: boolean;
  onClose: () => void;
  onSetFrom: () => void;
  onSetTo: () => void;
}

/** 字段行变体：`tight` = 单行 + 降一档字号（地址）；`wrap` = 允许折行（仅开放时间） */
type RowVariant = "plain" | "tight" | "wrap";

/** 一个字段行（字段名固定列宽 ⇒ 值折行后自然悬挂缩进） */
function Row({ label, children, variant = "plain" }: { label: string; children: React.ReactNode; variant?: RowVariant }) {
  const v = variant === "plain" ? "" : ` toilet-card__v--${variant}`;
  return (
    <div className="toilet-card__row">
      <span className="toilet-card__k">{label}</span>
      <span className={`toilet-card__v${v}`}>{children}</span>
    </div>
  );
}

export default function PublicToiletCard({ toilet, navActive, onClose, onSetFrom, onSetTo }: PublicToiletCardProps) {
  const [imgFailed, setImgFailed] = useState(false);
  /** 标题只留设施名（源数据的 `T8` / `AM01` 之类设施编号在渲染层剥掉，JSON 原文不动） */
  const title = `公共厕所-${toiletDisplayName(toilet.nameTc)}`;
  /** 标题字符数（码点）⇒ 交给 CSS 按容器宽度折算字号，保证**单行且不省略** */
  const titleChars = [...title].length;

  return (
    <div className="nav-station-card toilet-card" role="dialog" aria-label={title} data-toilet-card="on">
      <div className="nav-station-card__head">
        <span
          className="nav-station-card__name"
          data-toilet-title="on"
          style={{ "--toilet-title-chars": String(titleChars) } as CSSProperties}
        >
          {title}
        </span>
        <button className="nav-station-card__close" type="button" aria-label="关闭" onClick={onClose}>
          <Icon name="close" size={20} />
        </button>
      </div>

      {/* 暂停开放 + 设施标记：都是「一眼要看见」的状态，放副行 */}
      {(toilet.tempClose || toilet.hasDwc || toilet.hasFwc) && (
        <p className="nav-station-card__meta toilet-card__tags">
          {toilet.tempClose && <span className="toilet-card__tag toilet-card__tag--warn">暂停开放</span>}
          {toilet.hasDwc && <span className="toilet-card__tag">伤健人士洗手间</span>}
          {toilet.hasFwc && <span className="toilet-card__tag">亲子/育婴洗手间</span>}
        </p>
      )}

      <div className="nav-station-card__list toilet-card__body">
        <Row label="地址" variant="tight">
          {toilet.address ?? "暂无地址"}
        </Row>
        <Row label="开放时间" variant="wrap">
          {toilet.openingHours ?? "暂无开放时间"}
        </Row>
        {toilet.photo && (
          <Row label="照片">
            {imgFailed ? (
              <span className="toilet-card__photo-fallback" data-toilet-photo="fallback">
                照片暂时无法显示
              </span>
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element --
                 数据源是政府站点外链（198 条），走 `next/image` 需要为每个域名配
                 `remotePatterns` 并承担图片优化费用；负责人裁定用 `<img src>` 直连
                 （已实测无 referrer / CORS 限制，`fetch` 反而取不到）。加载失败有占位，不裂图。 */
              <img
                className="toilet-card__photo"
                data-toilet-photo="img"
                src={toilet.photo}
                alt={`${toilet.nameTc} 照片`}
                loading="lazy"
                decoding="async"
                onError={() => setImgFailed(true)}
              />
            )}
          </Row>
        )}
      </div>

      <SetPointActions navActive={navActive} onSetFrom={onSetFrom} onSetTo={onSetTo} />
    </div>
  );
}
