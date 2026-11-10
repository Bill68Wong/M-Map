/**
 * SMG 氣象數據接入斷言（scripts/test-weather-sm.ts · v4.1.0 · 4.1 官方數據源接入）
 *
 * ── 這份腳本釘住什麼 ────────────────────────────────────────────────────
 *   ① **離線夾具**：六份 2026-11-07 23:4x 抓到的真實響應（逐字內聯，僅截斷記錄數）
 *      必須解析出正確字段。上游改版時，這裡會先紅 —— 而不是等前端渲染出空白。
 *   ② **暴雨警告的布爾位**：`Inforce` `0` → false、非 0 → true。這是安全語義，
 *      讀錯方向（把生效讀成未生效）比讀不出來更糟，故四種取值逐一斷言。
 *   ③ **fail-closed**：畸形 XML / 根節點不對 / 缺必填字段 ⇒ **必須失敗**，
 *      不許返回「空但 200」。用 `data:` URL 走完整的 fetch→decode→parse 鏈路驗證。
 *   ④ **編碼**：中文不得出現 U+FFFD（�）。解錯編碼的表現是一片 �，而 � 會被當正文渲染。
 *   ⑤ **聯網實測**：六個端點各自 HTTP 200 + 可解析 + 關鍵字段非空。這數據免費公開，
 *      允許實連；實連失敗會讓腳本紅 —— 那是**真實的**上游故障，不該被跳過。
 *
 * ⚠️ 斷言的數值是**快照值**（氣溫 24℃ 之類）。它們代表「夾具沒被悄悄改過」，
 *    不是「現在的氣溫應該是 24℃」。聯網段的數值斷言只用範圍與非空，不用等值。
 *
 * 運行：npm run test:weather-sm
 */
import {
  SMG_URL,
  fetchRainstormWarning,
  fetchWeatherBrief,
  normalizeSmgStamp,
  parseActualWeather,
  parseForecast,
  parseRainstormWarning,
  parseSevenDayForecast,
  parseTyphoonWarning,
  parseWeatherBrief,
} from "../src/lib/weather/smg";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    fail++;
    console.error("  ✗ " + msg);
  }
}
function assertEq<T>(got: T, want: T, msg: string) {
  assert(got === want, `${msg}（實際 ${JSON.stringify(got)} / 預期 ${JSON.stringify(want)}）`);
}
function assertThrows(fn: () => unknown, re: RegExp, msg: string) {
  try {
    fn();
    assert(false, `${msg}（未拋錯）`);
  } catch (e) {
    const m = (e as Error).message;
    assert(re.test(m), `${msg}（拋出的信息：${m}）`);
  }
}
/** 輸出文本裡不得有替換字符（解錯編碼的典型證據） */
function assertNoMojibake(value: unknown, msg: string) {
  assert(!JSON.stringify(value).includes("\uFFFD"), msg);
}

/* ══════════════════════════════════════════════════════════════════════
 * 離線夾具（真實響應，非手寫）
 * ══════════════════════════════════════════════════════════════════════ */
const FIX_BRIEF = `<?xml version="1.0" encoding="UTF-8" ?>
<ActualWeatherBrief>
<System>
<SysAuthor>DINF</SysAuthor>
<SysPubdate>2026-11-07 22:56</SysPubdate>
<SysLanguage>0</SysLanguage>
</System>
<Custom>
<ValidFor>2026-11-07 23:00</ValidFor>
<Temperature>
<MeasureUnit>°C</MeasureUnit>
<Type>3</Type>
<Value>24</Value>
</Temperature>
<Humidity>
<MeasureUnit>%</MeasureUnit>
<Type>3</Type>
<Value>84</Value>
</Humidity>
<WindSpeed>
<MeasureUnit>km/h</MeasureUnit>
<Type>3</Type>
<Value>18</Value>
<WindSpeedDescription>三級</WindSpeedDescription>
</WindSpeed>
<WindDirection>
<MeasureUnit>°</MeasureUnit>
<Type>3</Type>
<Value>ENE</Value>
<WindDescription>東北偏東</WindDescription>
</WindDirection>
<Temperature>
<MeasureUnit>°C</MeasureUnit>
<Type>8</Type>
<Value>28</Value>
</Temperature>
<Temperature>
<MeasureUnit>°C</MeasureUnit>
<Type>9</Type>
<Value>23</Value>
</Temperature>
<Icon>
<IconName>ww-c03.png</IconName>
<IconURL>https://cdn.dsmg.gov.mo/assets/icons/c03.png</IconURL>
<IconDescription>多雲</IconDescription>
</Icon>
<WeatherStatus>03</WeatherStatus>
<FeelsLikeLevel>6</FeelsLikeLevel>
<FeelsLikeDescription>溫暖</FeelsLikeDescription>
</Custom>
</ActualWeatherBrief>`;

const FIX_ACTUAL = `<?xml version='1.0' encoding='utf-8'?>
<ActualWeather xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="actualweather.xsd"><System><SysAuthor>DSMG-DDI</SysAuthor><SysPubdate>2026-11-07 23:40</SysPubdate><SysLanguage>0</SysLanguage><version>1.05</version></System><Custom><WeatherStationInfo><Location><Code>FM</Code><Name>澳門</Name></Location><Location><Code>TG</Code><Name>氹仔</Name></Location><Location><Code>DC</Code><Name>路環</Name></Location></WeatherStationInfo>
<WeatherReport><station code="DP"><stationname>紀念孫中山市政公園</stationname><RecordTime>2026-11-07 23:40</RecordTime><Temperature_daily_max><MeasureUnit>°C</MeasureUnit><Type>8</Type><Value>30</Value><dValue>29.5</dValue></Temperature_daily_max><Temperature_daily_min><MeasureUnit>°C</MeasureUnit><Type>9</Type><Value>25</Value><dValue>24.7</dValue></Temperature_daily_min><Temperature><MeasureUnit>°C</MeasureUnit><Type>3</Type><Value>26</Value><dValue>25.7</dValue></Temperature><Humidity><MeasureUnit>%</MeasureUnit><Type>3</Type><Value>80</Value><dValue>80</dValue></Humidity><DewPoint><MeasureUnit>°C</MeasureUnit><Type>3</Type><Value>22</Value><dValue>21.9</dValue></DewPoint><WindGust><MeasureUnit>km/h</MeasureUnit><Type>3</Type><Value>15</Value><dValue>14.8</dValue></WindGust><WindSpeed><MeasureUnit>km/h</MeasureUnit><Type>3</Type><Value>6</Value><dValue>6.5</dValue></WindSpeed><Rainfall><MeasureUnit>mm</MeasureUnit><Type>3</Type><Value>0.0</Value><dValue>0.0</dValue></Rainfall><Rainfall><MeasureUnit>mm</MeasureUnit><Type>4</Type><Value>0.0</Value><dValue>0.0</dValue></Rainfall><Rainfall><MeasureUnit>mm</MeasureUnit><Type>5</Type><Value>0.0</Value><dValue>0.0</dValue></Rainfall><WindDirection><MeasureUnit>°</MeasureUnit><Type>3</Type><Value>ENE</Value><dValue>ENE</dValue><Degree>64</Degree><WindDescription>東北偏東</WindDescription></WindDirection><FeelsLike><FeelsLikeLevel>7</FeelsLikeLevel><FeelsLikeDescription>炎熱</FeelsLikeDescription></FeelsLike></station></WeatherReport>
<WeatherReport><station code="EM"><stationname>黑沙環</stationname><RecordTime>2026-11-07 23:40</RecordTime><Temperature_daily_max><MeasureUnit>°C</MeasureUnit><Type>8</Type><Value>29</Value><dValue>28.9</dValue></Temperature_daily_max><Temperature_daily_min><MeasureUnit>°C</MeasureUnit><Type>9</Type><Value>25</Value><dValue>25.0</dValue></Temperature_daily_min><Temperature><MeasureUnit>°C</MeasureUnit><Type>3</Type><Value>26</Value><dValue>25.8</dValue></Temperature><Humidity><MeasureUnit>%</MeasureUnit><Type>3</Type><Value>80</Value><dValue>80</dValue></Humidity><DewPoint><MeasureUnit>°C</MeasureUnit><Type>3</Type><Value>22</Value><dValue>22.0</dValue></DewPoint><WindGust><MeasureUnit>km/h</MeasureUnit><Type>3</Type><Value>34</Value><dValue>34.2</dValue></WindGust><WindSpeed><MeasureUnit>km/h</MeasureUnit><Type>3</Type><Value>11</Value><dValue>11.2</dValue></WindSpeed><Rainfall><MeasureUnit>mm</MeasureUnit><Type>3</Type><Value>0.0</Value><dValue>0.0</dValue></Rainfall><Rainfall><MeasureUnit>mm</MeasureUnit><Type>4</Type><Value>0.0</Value><dValue>0.0</dValue></Rainfall><Rainfall><MeasureUnit>mm</MeasureUnit><Type>5</Type><Value>0.0</Value><dValue>0.0</dValue></Rainfall><WindDirection><MeasureUnit>°</MeasureUnit><Type>3</Type><Value>NE</Value><dValue>NE</dValue><Degree>52</Degree><WindDescription>東北</WindDescription></WindDirection><FeelsLike><FeelsLikeLevel>6</FeelsLikeLevel><FeelsLikeDescription>溫暖</FeelsLikeDescription></FeelsLike></station></WeatherReport>
</Custom></ActualWeather>`;

const FIX_RAINSTORM = `<?xml version="1.0" encoding="UTF-8" ?>
<RainstormWarning xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="Rainstorm.xsd">
 <System>
  <SysAuthor>SMG</SysAuthor>
  <SysPubdate>2026-10-04 23:25 GMT+8</SysPubdate>
  <SysLanguage>0</SysLanguage>
 </System>
 <ReportInfo>
   <ReportTitle>RAINSTORM</ReportTitle>
   <ReportType>WARNING</ReportType>
   <ReportNo></ReportNo>
   <RecordId></RecordId>
 </ReportInfo>
 <Custom>
  <Rainstorm>
   <Warncode>NIL</Warncode>
   <Action>NIL</Action>
   <IssuedAt>2026-10-04 23:25</IssuedAt>
   <SignalChangedAt></SignalChangedAt>
   <Inforce>0</Inforce>
   <Status>0</Status>
   <Icon>
    <IconURL></IconURL>
   </Icon>
   <Description>現時沒有暴雨警告信號。</Description>
   <TTS></TTS>
   <Complementary>
    <Tips></Tips>
    <Other></Other>
   </Complementary>   
  </Rainstorm>
 </Custom>
</RainstormWarning>`;

const FIX_TYPHOON = `<?xml version="1.0" encoding="UTF-8" ?>
<?xml-stylesheet type="text/xsl" href="c_typhoon.xsl" ?>
<TyphoonWarning xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="Typhoon.xsd">
 <System>
  <SysAuthor>SMG</SysAuthor>
  <SysPubdate>2026-09-03 23:00 GMT+8</SysPubdate>
  <SysLanguage>0</SysLanguage>
 </System>
 <Custom>
  <TropicalCyclone>
   <Tcid>NIL</Tcid>
   <Smgid/>
   <Name>NIL</Name>	  
   <Warncode>NIL</Warncode>
   <Action>NIL</Action>
   <IssuedAt>2026-09-03 23:00</IssuedAt>
   <SignalChangedAt></SignalChangedAt>
   <Inforce>0</Inforce>
   <Status>0</Status>
   <SigUpdate>0</SigUpdate>   
   <InforceChange/>
   <IssuedAtChange/>   
   <Description>現時並沒有熱帶氣旋信號。</Description>
   <Major>現時並沒有熱帶氣旋信號。</Major>
   <Minor/> 
   <TTS/>
   <Image>
    <ImageURL>https://xml.smg.gov.mo/typhoon/ty_channel.gif</ImageURL>
   </Image>
	<Icon>
	<IconURL/>
	</Icon>   
   <Misc>現時並沒有熱帶氣旋信號。</Misc>
  </TropicalCyclone>
 </Custom>
</TyphoonWarning>`;

const FIX_FORECAST = `<?xml version="1.0" encoding="UTF-8" ?>

<ActualForecast xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="weatherforecast.xsd">
 <System>
  <SysAuthor>SMG-InfoGrp</SysAuthor>
  <SysPubdate>2026-11-07 21:00</SysPubdate>
  <SysLanguage>0</SysLanguage>
 </System>
 <Custom>
  <TodaySituation>一股偏東氣流正影響本澳天氣。</TodaySituation>
  <WeatherForecast>
   <AstronomicalTide>NIL</AstronomicalTide>
   <ValidFor>2026-11-07</ValidFor>
   <WeatherDescription>大致多雲。
有幾陣微雨。
吹4至5級偏東風及有陣風。</WeatherDescription>
  </WeatherForecast>
  <WeatherForecast>
   <AstronomicalTide>NIL</AstronomicalTide>
   <ValidFor>2026-11-08</ValidFor>
   <WeatherDescription>多雲，短暫時間有陽光。
早晚有幾陣雨。
吹3至5級東至東北風及有陣風。
氣溫約為攝氏24至29度。
相對濕度介乎百分之60至95之間。
預測最高紫外線指數約為 5，級別屬於中等。</WeatherDescription>
  </WeatherForecast>
 </Custom>
</ActualForecast>`;

const FIX_SEVEN_DAY = `<?xml version="1.0" encoding="UTF-8" ?>
<?xml-stylesheet href="c_7daysforecast.xsl" type="text/xsl"?>

<SevenDaysForecast xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="7daysweatherforecast.xsd">
 <System>
  <SysAuthor>SMG-InfoGrp</SysAuthor>
  <SysPubdate>2026-11-07 21:00</SysPubdate>
  <SysLanguage>0</SysLanguage>
 </System>
 <Custom>
<WeatherForecast>
   <AstronomicalTide>NIL</AstronomicalTide>
   <ValidFor>2026-11-08</ValidFor>
   <c_DayOfWeek>日</c_DayOfWeek>
   <Icon>
    <IconName>ww-c28.gif</IconName>
    <IconURL>http://www.smg.gov.mo/icons/weatherIcon/ww-c28.gif</IconURL>
   </Icon>
   <WeatherStatus>28</WeatherStatus>
   <Temperature>
    <Type>1</Type>
    <MeasureUnit>&#176;C</MeasureUnit>
    <Value>29</Value>
   </Temperature>
   <Temperature>
    <Type>2</Type>
    <MeasureUnit>&#176;C</MeasureUnit>
    <Value>24</Value>
   </Temperature>
   <Humidity>
    <Type>1</Type>
    <MeasureUnit>%</MeasureUnit>
    <Value>95</Value>
   </Humidity>
   <Humidity>
    <Type>2</Type>
    <MeasureUnit>%</MeasureUnit>
    <Value>60</Value>
   </Humidity>
   <WeatherDescription>多雲，短暫時間有陽光。早晚有幾陣雨。吹3至5級東至東北風及有陣風。</WeatherDescription>
  </WeatherForecast>
<WeatherForecast>
   <AstronomicalTide>NIL</AstronomicalTide>
   <ValidFor>2026-11-09</ValidFor>
   <c_DayOfWeek>一</c_DayOfWeek>
   <Icon>
    <IconName>ww-c28.gif</IconName>
    <IconURL>http://www.smg.gov.mo/icons/weatherIcon/ww-c28.gif</IconURL>
   </Icon>
   <WeatherStatus>28</WeatherStatus>
   <Temperature>
    <Type>1</Type>
    <MeasureUnit>&#176;C</MeasureUnit>
    <Value>25</Value>
   </Temperature>
   <Temperature>
    <Type>2</Type>
    <MeasureUnit>&#176;C</MeasureUnit>
    <Value>19</Value>
   </Temperature>
   <Humidity>
    <Type>1</Type>
    <MeasureUnit>%</MeasureUnit>
    <Value>90</Value>
   </Humidity>
   <Humidity>
    <Type>2</Type>
    <MeasureUnit>%</MeasureUnit>
    <Value>45</Value>
   </Humidity>
   <WeatherDescription>氣溫顯著下降。多雲，部份時間有陽光。初時有幾陣雨。吹5至6級偏北風及有陣風。</WeatherDescription>
  </WeatherForecast>
<IssuedTime>2026-11-07 21:00</IssuedTime>
</Custom>
</SevenDaysForecast>`;

/* ══════════════════════════════════════════════════════════════════════
 * A. 實時天氣簡報
 * ══════════════════════════════════════════════════════════════════════ */
function testBrief() {
  console.log("\nA. 實時天氣簡報（c_actual_brief.xml）");
  const b = parseWeatherBrief(FIX_BRIEF);
  assertEq(b.temperatureC, 24, "當前氣溫取 <Temperature><Type>3</Type>（三個 Temperature 靠 Type 區分）");
  assertEq(b.temperatureMaxC, 28, "當日最高取 Type=8");
  assertEq(b.temperatureMinC, 23, "當日最低取 Type=9");
  assertEq(b.humidityPct, 84, "相對濕度 84%");
  assertEq(b.windSpeedKmh, 18, "風速 18 km/h");
  assertEq(b.windSpeedLevel, "三級", "風速級別原文「三級」");
  assertEq(b.windDirectionCode, "ENE", "風向代碼 ENE");
  assertEq(b.windDirection, "東北偏東", "風向中文「東北偏東」");
  assertEq(b.weatherStatus, "03", "天氣代碼 03");
  assertEq(b.description, "多雲", "天氣描述「多雲」（取 IconDescription）");
  assertEq(b.feelsLike, "溫暖", "體感「溫暖」");
  assertEq(b.publishedAt, "2026-11-07T22:56:00+08:00", "SysPubdate 歸一化為帶 +08:00 的 ISO");
  assertEq(b.validFor, "2026-11-07 23:00", "有效期原文保留");
  assert(
    b.iconUrl === null || b.iconUrl.startsWith("https://"),
    `圖標地址恆為 https（避免 PWA 的 mixed content 攔截，實際 ${b.iconUrl}）`,
  );
  assertNoMojibake(b, "簡報解析結果無 U+FFFD");
}

/* ══════════════════════════════════════════════════════════════════════
 * B. 分站實時觀測
 * ══════════════════════════════════════════════════════════════════════ */
function testActual() {
  console.log("\nB. 分站實時觀測（c_actualweather.xml）");
  const a = parseActualWeather(FIX_ACTUAL);
  assertEq(a.stations.length, 2, "夾具截斷為 2 站，全部解析成功");
  const s = a.stations[0];
  assertEq(s.code, "DP", "站點代碼取自 <station code=\"…\"> 屬性");
  assertEq(s.name, "紀念孫中山市政公園", "站名取自 <stationname>");
  assertEq(s.temperatureC, 26, "氣溫 26℃（取塊內 <Value>，不是整段子 XML）");
  assertEq(s.temperatureMaxC, 30, "當日最高 30℃");
  assertEq(s.temperatureMinC, 25, "當日最低 25℃");
  assertEq(s.humidityPct, 80, "濕度 80%");
  assertEq(s.dewPointC, 22, "露點 22℃");
  assertEq(s.windSpeedKmh, 6, "風速 6 km/h");
  assertEq(s.windGustKmh, 15, "陣風 15 km/h");
  assertEq(s.windDirectionDegree, 64, "風向角度取 <Degree>");
  assertEq(s.windDirection, "東北偏東", "風向中文");
  assertEq(s.feelsLike, "炎熱", "體感「炎熱」");
  assert(
    a.stations.every((x) => typeof x.name === "string" && x.name.length > 0),
    "每一站都有非空站名",
  );
  assertNoMojibake(a, "分站觀測無 U+FFFD");
}

/* ══════════════════════════════════════════════════════════════════════
 * C. 暴雨警告：布爾位是安全語義
 * ══════════════════════════════════════════════════════════════════════ */
function testRainstorm() {
  console.log("\nC. 暴雨警告（c_rainstorm.xml）");
  const w = parseRainstormWarning(FIX_RAINSTORM);
  assertEq(w.inforce, false, "快照 Inforce=0 ⇒ false（現時沒有警告）");
  assertEq(w.warncode, "NIL", "警告代碼 NIL");
  assertEq(w.description, "現時沒有暴雨警告信號。", "描述原文");
  assertEq(w.publishedAt, "2026-10-04T23:25:00+08:00", "帶 GMT+8 後綴的 SysPubdate 也能歸一化");
  assertNoMojibake(w, "暴雨警告無 U+FFFD");

  const on = (v: string) => FIX_RAINSTORM.replace("<Inforce>0</Inforce>", `<Inforce>${v}</Inforce>`);
  assertEq(parseRainstormWarning(on("1")).inforce, true, "Inforce=1 ⇒ true");
  assertEq(parseRainstormWarning(on("3")).inforce, true, "Inforce=3（非 0 任意值）⇒ true");
  assertThrows(
    () => parseRainstormWarning(on("")),
    /為空/,
    "Inforce 空 ⇒ 拋（不能靠 Number(\"\")===0 靜默變成「無警告」）",
  );
}

/* ══════════════════════════════════════════════════════════════════════
 * D. 熱帶氣旋 / 預報 / 七日預報
 * ══════════════════════════════════════════════════════════════════════ */
function testOthers() {
  console.log("\nD. 熱帶氣旋與預報");

  const t = parseTyphoonWarning(FIX_TYPHOON);
  assertEq(t.inforce, false, "熱帶氣旋 Inforce=0 ⇒ false");
  assertEq(t.tcid, "NIL", "Tcid=NIL");
  assertEq(t.name, "NIL", "Name=NIL");
  assert(
    (t.description ?? "").includes("熱帶氣旋"),
    `描述非空且指向熱帶氣旋（實際「${t.description}」）`,
  );
  assert(
    t.imageUrl === null || t.imageUrl.startsWith("https://"),
    "氣旋圖地址恆為 https（上游給的是 http 明文）",
  );
  assertNoMojibake(t, "熱帶氣旋無 U+FFFD");

  const f = parseForecast(FIX_FORECAST);
  assertEq(f.days.length, 2, "天氣預報 2 天全部解析");
  assertEq(f.days[0].validFor, "2026-11-07", "首日日期");
  assert(
    (f.situation ?? "").length > 0,
    `今日天氣形勢非空（實際「${f.situation}」）`,
  );
  assert(f.days[0].description.includes("偏東"), `首日描述含「偏東」（實際「${f.days[0].description}」）`);
  assert(f.days[1].description.includes("\n"), "多行描述保留內部換行（不壓成一行）");
  assertNoMojibake(f, "天氣預報無 U+FFFD");

  const d7 = parseSevenDayForecast(FIX_SEVEN_DAY);
  assertEq(d7.days.length, 2, "七日預報夾具截斷為 2 天");
  const d1 = d7.days[0];
  assertEq(d1.validFor, "2026-11-08", "首日日期");
  assertEq(d1.dayOfWeek, "日", "星期取自 <c_DayOfWeek>");
  assertEq(d1.temperatureMaxC, 29, "最高溫取 <Temperature><Type>1</Type>");
  assertEq(d1.temperatureMinC, 24, "最低溫取 <Temperature><Type>2</Type>");
  assertEq(d1.humidityMaxPct, 95, "最高濕度取 <Humidity><Type>1</Type>");
  assertEq(d1.humidityMinPct, 60, "最低濕度取 <Humidity><Type>2</Type>");
  assertEq(d1.weatherStatus, "28", "天氣代碼 28");
  assertEq(
    d1.iconUrl,
    "https://www.smg.gov.mo/icons/weatherIcon/ww-c28.gif",
    "圖標協議由 http 升級為 https（同主機同路徑，已實測 200）",
  );
  assert((d1.description ?? "").includes("多雲"), "天氣描述原文保留");
  assertEq(d7.issuedTime, "2026-11-07 21:00", "IssuedTime 原文保留");
  assertNoMojibake(d7, "七日預報無 U+FFFD");
}

/* ══════════════════════════════════════════════════════════════════════
 * E. 時刻歸一化
 * ══════════════════════════════════════════════════════════════════════ */
function testStamp() {
  console.log("\nE. SysPubdate 歸一化");
  assertEq(
    normalizeSmgStamp("2026-11-07 22:56"),
    "2026-11-07T22:56:00+08:00",
    "無時區後綴 ⇒ 補 +08:00",
  );
  assertEq(
    normalizeSmgStamp("2026-10-04 23:25 GMT+8"),
    "2026-10-04T23:25:00+08:00",
    "帶 GMT+8 後綴 ⇒ 去掉後綴補 +08:00",
  );
  assertEq(
    normalizeSmgStamp("2026-11-08 00:05"),
    "2026-11-08T00:05:00+08:00",
    "凌晨 00:05 不得被判非法（h23 小時循環回歸）",
  );
  assertEq(normalizeSmgStamp("2026-02-30 10:00"), null, "2026-02-30 不是合法日期 ⇒ null（Date 會自動進位）");
  assertEq(normalizeSmgStamp("2026-11-07"), null, "缺時刻 ⇒ null（不猜）");
  assertEq(normalizeSmgStamp(""), null, "空串 ⇒ null");
  assertEq(normalizeSmgStamp(null), null, "null ⇒ null");
}

/* ══════════════════════════════════════════════════════════════════════
 * F. fail-closed：結構異常必須失敗，不能「空但成功」
 * ══════════════════════════════════════════════════════════════════════ */
async function testFailClosed() {
  console.log("\nF. 結構異常（fail-closed）");

  assertThrows(
    () => parseRainstormWarning("<html><body>404 Not Found</body></html>"),
    /根節點/,
    "錯誤頁（根節點不對）⇒ 拋",
  );
  assertThrows(
    () => parseRainstormWarning("<RainstormWarning><System></System></RainstormWarning>"),
    /缺 <Custom>/,
    "缺 Custom ⇒ 拋",
  );
  assertThrows(
    () => parseRainstormWarning(FIX_RAINSTORM.replace("<Inforce>0</Inforce>", "")),
    /缺 <Inforce>/,
    "缺 Inforce ⇒ 拋（不默認成「無警告」）",
  );
  assertThrows(
    () => parseRainstormWarning(FIX_RAINSTORM.replace("<Inforce>0</Inforce>", "<Inforce>abc</Inforce>")),
    /不是數字/,
    "Inforce 非數字 ⇒ 拋（未知狀態不猜）",
  );
  assertThrows(
    () => parseWeatherBrief(FIX_BRIEF.replace(/<Temperature>/g, "<Temp>")),
    /缺當前氣溫|根節點|缺 </,
    "氣溫塊被改名 ⇒ 拋（不返回 temperatureC:null 的「正常」對象）",
  );
  assertThrows(
    () => parseActualWeather("<ActualWeather><Custom></Custom></ActualWeather>"),
    /0 個氣象站/,
    "空殼（0 站）⇒ 拋，不當成「今天沒有觀測」",
  );
  assertThrows(
    () => parseForecast("<ActualForecast><Custom></Custom></ActualForecast>"),
    /0 天預報/,
    "預報 0 天 ⇒ 拋",
  );
  assertThrows(
    () => parseSevenDayForecast("<SevenDaysForecast><Custom></Custom></SevenDaysForecast>"),
    /0 天預報/,
    "七日預報 0 天 ⇒ 拋",
  );

  // 走完整 fetch→decode→parse 鏈路（data: URL 不聯網、不等待超時）
  const badRoot = await fetchRainstormWarning("data:application/xml,%3Chtml%3E%3C%2Fhtml%3E");
  assert(badRoot.ok === false, "fetch 層：畸形 XML ⇒ ok:false（不拋出到調用方）");
  assertEq(badRoot.ok === false ? badRoot.code : "unexpected", "parse", "失敗碼為 parse");

  const badBytes = await fetchWeatherBrief("data:application/xml,%EF%BF%BD");
  assert(badBytes.ok === false, "fetch 層：解碼出 U+FFFD ⇒ ok:false");
  assertEq(badBytes.ok === false ? badBytes.code : "unexpected", "decode", "失敗碼為 decode");
}

/* ══════════════════════════════════════════════════════════════════════
 * G. 聯網實測（六個端點，允許實連）
 * ══════════════════════════════════════════════════════════════════════ */
type Live = { status: number; ms: number; text: string; encoding: string };

async function live(url: string): Promise<Live | null> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "M-Map/4.1 (weather smoke test; non-commercial)" },
    });
    const text = await res.text();
    const encoding = /encoding=["']([\w-]+)["']/i.exec(text.slice(0, 120))?.[1] ?? "(未聲明)";
    return { status: res.status, ms: Math.round(performance.now() - t0), text, encoding };
  } catch (e) {
    console.error(`    連線失敗 ${url}：${(e as Error).message}`);
    return null;
  }
}

async function testLive() {
  console.log("\nG. 聯網實測（6 個端點）");
  const rows: [string, string][] = [
    ["c_actual_brief", SMG_URL.brief],
    ["c_actualweather", SMG_URL.actual],
    ["c_forecast", SMG_URL.forecast],
    ["c_7daysforecast", SMG_URL.sevenDay],
    ["c_rainstorm", SMG_URL.rainstorm],
    ["c_typhoon", SMG_URL.typhoon],
  ];
  const got = new Map<string, Live | null>();
  for (const [name, url] of rows) got.set(name, await live(url));

  for (const [name] of rows) {
    const r = got.get(name) ?? null;
    assert(r !== null, `${name}：可連線`);
    if (r === null) continue;
    assertEq(r.status, 200, `${name}：HTTP 200`);
    assert(!r.text.includes("\uFFFD"), `${name}：響應文本無 U+FFFD（編碼 ${r.encoding}）`);
    assert(r.text.length > 200, `${name}：響應體非空（${r.text.length} 字符）`);
  }

  const briefXml = got.get("c_actual_brief")?.text ?? "";
  const actualXml = got.get("c_actualweather")?.text ?? "";
  const forecastXml = got.get("c_forecast")?.text ?? "";
  const sevenXml = got.get("c_7daysforecast")?.text ?? "";
  const rainXml = got.get("c_rainstorm")?.text ?? "";
  const typhoonXml = got.get("c_typhoon")?.text ?? "";

  if (briefXml) {
    const b = parseWeatherBrief(briefXml);
    assert(typeof b.temperatureC === "number", `實時簡報：氣溫可解析（${b.temperatureC}℃）`);
    assert(b.publishedAt !== null, `實時簡報：發佈時刻可歸一化（${b.publishedAt}）`);
    assert((b.description ?? "").length > 0, `實時簡報：天氣描述非空（${b.description}）`);
    assertNoMojibake(b, "實時簡報（真實響應）無 U+FFFD");
  }
  if (actualXml) {
    const a = parseActualWeather(actualXml);
    assert(a.stations.length >= 10, `分站觀測：站點數合理（實測 ${a.stations.length} 站）`);
    // 實測事實（2026-11-07）：17 站中 7 個是橋樑站（MN/MS/PN/PS/PG/PV/PL），它們**只上報風**，
    // 沒有 Temperature / Humidity 塊。故「每站都有氣溫」是錯的期望 —— 每站都有風速才是真的。
    const withTemp = a.stations.filter((s) => typeof s.temperatureC === "number");
    assertEq(withTemp.length, 10, "分站觀測：10 個陸上站有氣溫（7 個橋樑站只有風）");
    assert(
      a.stations.every((s) => typeof s.windSpeedKmh === "number"),
      "分站觀測：每一站都有風速（含 7 個橋樑站）",
    );
    assertNoMojibake(a, "分站觀測（真實響應）無 U+FFFD");
  }
  if (forecastXml) {
    const f = parseForecast(forecastXml);
    assert(f.days.length > 0, `天氣預報：至少 1 天（實測 ${f.days.length} 天）`);
    assertNoMojibake(f, "天氣預報（真實響應）無 U+FFFD");
  }
  if (sevenXml) {
    const d = parseSevenDayForecast(sevenXml);
    assertEq(d.days.length, 7, "七日預報：恰好 7 天");
    assert(
      d.days.every((x) => typeof x.temperatureMaxC === "number" && typeof x.temperatureMinC === "number"),
      "七日預報：每日最高/最低溫均可解析",
    );
    assertNoMojibake(d, "七日預報（真實響應）無 U+FFFD");
  }
  if (rainXml) {
    const w = parseRainstormWarning(rainXml);
    assert(typeof w.inforce === "boolean", `暴雨警告：Inforce 解析為布爾（${w.inforce}）`);
    assert((w.description ?? "").length > 0, `暴雨警告：描述非空（${w.description}）`);
    assertNoMojibake(w, "暴雨警告（真實響應）無 U+FFFD");
  }
  if (typhoonXml) {
    const t = parseTyphoonWarning(typhoonXml);
    assert(typeof t.inforce === "boolean", `熱帶氣旋：Inforce 解析為布爾（${t.inforce}）`);
    assertNoMojibake(t, "熱帶氣旋（真實響應）無 U+FFFD");
  }

  // 取數封裝的端到端（含解碼、超時、重試、錯誤轉換）
  const wrapped = await fetchWeatherBrief();
  assert(wrapped.ok === true, "取數封裝：實時簡報端到端成功（含按聲明解碼）");
  if (wrapped.ok) {
    assert(
      !Number.isNaN(Date.parse(wrapped.fetchedAt)),
      `取數封裝：fetchedAt 是合法時間（${wrapped.fetchedAt}）`,
    );
  }

  console.log("\n  端點實測明細：");
  console.log("  | 端點 | HTTP | 耗時 | 編碼 | 大小 |");
  console.log("  |---|---|---|---|---|");
  for (const [name, url] of rows) {
    const r = got.get(name);
    console.log(
      `  | ${name} | ${r?.status ?? "連線失敗"} | ${r ? `${r.ms}ms` : "-"} | ` +
        `${r?.encoding ?? "-"} | ${r ? `${r.text.length} 字符` : "-"} |`,
    );
    void url;
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 入口
 * ══════════════════════════════════════════════════════════════════════ */
async function main() {
  console.log("SMG 氣象數據接入斷言（離線夾具 + 聯網實測）\n");
  testBrief();
  testActual();
  testRainstorm();
  testOthers();
  testStamp();
  await testFailClosed();
  await testLive();

  console.log(`\n結果：通過 ${pass} · 失敗 ${fail}`);
  if (fail) {
    console.error("\n❌ 氣象數據接入與預期不符 —— 每一條 ✗ 都可能是「前端會顯示錯誤天氣」的入口。");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("測試腳本報錯：", e);
  process.exit(1);
});
