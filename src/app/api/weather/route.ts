/**
 * GET /api/weather —— 澳門地球物理氣象局（SMG）官方氣象數據（v4.1.0 · 4.1 官方數據源接入）
 *
 * ── 為什麼是「一個接口聚合六份 XML」────────────────────────────────────
 *   六份上游文檔同源同域同更新節奏，前端（首頁天氣條 / 警告橫幅）幾乎總是同時要簡報 +
 *   警告；拆六個路由 = 六次往返 + 六份緩存頭各寫一遍。聚合成一份後：
 *     · 前端一次請求拿到全部，失敗粒度靠 `errors` 字段表達（見下）；
 *     · 上游仍是六份獨立文檔，**各按自己的更新頻率緩存**（警告 90s、預報 30min）。
 *
 * ── 緩存：為什麼是 `unstable_cache` 而不是 `preferredRegion` / 響應頭 ────
 *   本項目已在 Vercel Hobby 上實測：`preferredRegion` 不生效（函數仍可能落在遠端 region）。
 *   正解是 **Data Cache**（`unstable_cache`）：跨實例、跨冷啟動，且 TTL 可逐段設定。
 *   TTL 依據：
 *     · 簡報 / 分站觀測 **300s** —— 上游每小時更新（實測 `SysPubdate` 整點後幾分鐘），
 *       5 分鐘遠快於上游節奏，不會讀到明顯過期的數據，又能把上游請求壓到 12 次/小時；
 *     · 暴雨 / 熱帶氣旋 **90s / 120s** —— 這是**安全信息**，寧可多打上游也不能晚；
 *       90s 對「信號剛發出」的場景足夠（用戶刷新一次就能看到）；
 *     · 預報 / 七日預報 **1800s** —— 上游每日只更新數次（實測 21:00 檔）。
 *
 * ── 失敗契約（不許假綠）─────────────────────────────────────────────────
 *   · 六段**全失敗** ⇒ HTTP 502 + `{ ok:false, error:"upstream_error" }`（錯誤碼閉集見
 *     `src/lib/http/errors.ts`）；
 *   · **部分失敗** ⇒ HTTP 200 + `ok:true` + `degraded:true` + `errors` 逐段列出失敗段名
 *     （值恆為 `upstream_error`）。失敗段的數據字段為 `null`：
 *     ⚠️ 前端**必須先看 `errors`**，`warnings.rainstorm === null` 的語義是「不知道」，
 *        不是「沒有警告」—— 把它渲染成「現時沒有暴雨警告」是安全事故。
 *   · 失敗結果**不進 Data Cache**：`unwrap` 在上游失敗時拋錯，`unstable_cache` 不緩存
 *     被拒絕的 Promise ⇒ 下一次請求會重新打上游，上游恢復即自愈（90s 內）。
 *
 * ── 合規（四紅線：註明來源 + 日期）─────────────────────────────────────
 *   響應恆帶 `source` / `sourceUrl` / `publishedAt`（上游 `SysPubdate`，非我方時鐘）。
 */
import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";
import { API_ERROR, errorResponse } from "@/lib/http/errors";
import {
  SMG_SOURCE,
  fetchActualWeather,
  fetchForecast,
  fetchRainstormWarning,
  fetchSevenDayForecast,
  fetchTyphoonWarning,
  fetchWeatherBrief,
  type SmgResult,
} from "@/lib/weather/smg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 各段 TTL（秒）。理由见文件头「緩存」一节，改之前先读那段 */
const TTL = {
  brief: 300,
  actual: 300,
  rainstorm: 90,
  typhoon: 120,
  forecast: 1800,
  sevenDay: 1800,
} as const;

/**
 * 把 `SmgResult` 的失敗形態轉成異常，讓 `unstable_cache` **不緩存失敗**。
 * 失敗的 detail 只進日誌（可能含上游狀態碼等內部信息）。
 */
function unwrap<T>(r: SmgResult<T>): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`);
  return r.data;
}

const getBrief = unstable_cache(async () => unwrap(await fetchWeatherBrief()), ["smg-brief-v1"], {
  revalidate: TTL.brief,
  tags: ["smg-weather"],
});
const getActual = unstable_cache(async () => unwrap(await fetchActualWeather()), ["smg-actual-v1"], {
  revalidate: TTL.actual,
  tags: ["smg-weather"],
});
const getRainstorm = unstable_cache(
  async () => unwrap(await fetchRainstormWarning()),
  ["smg-rainstorm-v1"],
  { revalidate: TTL.rainstorm, tags: ["smg-weather-warning"] },
);
const getTyphoon = unstable_cache(async () => unwrap(await fetchTyphoonWarning()), ["smg-typhoon-v1"], {
  revalidate: TTL.typhoon,
  tags: ["smg-weather-warning"],
});
const getForecast = unstable_cache(async () => unwrap(await fetchForecast()), ["smg-forecast-v1"], {
  revalidate: TTL.forecast,
  tags: ["smg-weather"],
});
const getSevenDay = unstable_cache(
  async () => unwrap(await fetchSevenDayForecast()),
  ["smg-7day-v1"],
  { revalidate: TTL.sevenDay, tags: ["smg-weather"] },
);

/** 逐段取數；失敗返回 null 並記日誌（不讓一段失敗炸掉其餘五段） */
async function take<T>(name: string, load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (e) {
    console.error(`[api/weather] ${name} 取數失敗：`, (e as Error).message);
    return null;
  }
}

const CACHE_HEADER = {
  "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
};

export async function GET() {
  const [brief, observation, rainstorm, typhoon, forecast, sevenDay] = await Promise.all([
    take("brief", getBrief),
    take("observation", getActual),
    take("rainstorm", getRainstorm),
    take("typhoon", getTyphoon),
    take("forecast", getForecast),
    take("sevenDay", getSevenDay),
  ]);

  // 六段全掛 ⇒ 沒有任何可交付的數據。502 而不是 200 空殼（假綠比失敗更危險）。
  if (
    brief === null &&
    observation === null &&
    rainstorm === null &&
    typhoon === null &&
    forecast === null &&
    sevenDay === null
  ) {
    console.error("[api/weather] 六段全部失敗，返回 502");
    return errorResponse(API_ERROR.upstream_error, 502);
  }

  // 只列出**失敗**的段；全部成功時該字段缺席（前端少一次判空）
  const errors: Record<string, string> = {};
  if (brief === null) errors.brief = API_ERROR.upstream_error;
  if (observation === null) errors.observation = API_ERROR.upstream_error;
  if (rainstorm === null) errors.rainstorm = API_ERROR.upstream_error;
  if (typhoon === null) errors.typhoon = API_ERROR.upstream_error;
  if (forecast === null) errors.forecast = API_ERROR.upstream_error;
  if (sevenDay === null) errors.sevenDay = API_ERROR.upstream_error;
  const degraded = Object.keys(errors).length > 0;

  const payload = {
    ok: true as const,
    degraded,
    /** 四紅線要求：來源必須隨數據下發 */
    source: SMG_SOURCE.name,
    sourceUrl: SMG_SOURCE.url,
    /** 本響應的裝配時刻（服務端時鐘）。因有 Data Cache，數據最多比它舊 TTL 秒 */
    fetchedAt: new Date().toISOString(),
    /** 上游發佈時刻（`SysPubdate`），取簡報優先、其次分站；皆缺則 null */
    publishedAt: brief?.publishedAt ?? observation?.publishedAt ?? null,
    brief,
    observation,
    warnings: { rainstorm, typhoon },
    forecast,
    sevenDay,
    ...(degraded ? { errors } : {}),
  };

  return NextResponse.json(payload, { headers: CACHE_HEADER });
}
