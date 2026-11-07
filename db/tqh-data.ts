/**
 * 通琴号静态数据集（自动生成，勿手改）
 *
 * 来源：
 *   · 班次与站点时刻 —— 负责人整理的《通琴号路线站点时间汇总.md》（86 张小程序截图）
 *   · 站点坐标与全称 —— 腾讯地图收藏集分享（138 点，GCJ-02）
 *   · 属地与巴士站关联 —— 负责人逐条确认（2026-11-05）
 *
 * ★ 方向判定规则：按**终点站属地**，不看「上班/下班」。
 *   反例确实存在：A5线-澳琴早上班、D1市民中心-上班线、B13线-澳琴上班、
 *   D3/D5/D6 早班上班都是「上班」却「往横琴」。
 *
 * ★ 属地判定不能只看站名：「澳门新街坊」「澳门新街坊南」名字带澳门，
 *   实际位于横琴（经度 113.515）。
 *
 * 生成时间：2026-11-05T13:33:02.082Z
 */

export interface TqhStationSeed {
  /** 站点全称（腾讯地图收藏集原文，含 ①②③ 与括号） */
  name: string;
  /** 经度（GCJ-02） */
  lng: number;
  /** 纬度（GCJ-02） */
  lat: number;
  /** 属地 */
  side: "澳门" | "横琴";
  /** 关联的澳门巴士站站码（仅澳门侧且已确认等价时有值） */
  busCode: string | null;
}

export interface TqhTripStopSeed {
  seq: number;
  stationName: string;
  time: string;
}

export interface TqhTripSeed {
  /** 规范化班次名：序号｜方向｜线路名全称 */
  tripCode: string;
  /** 序号（A1/B6/C4/D3…） */
  routeNo: string;
  /** 方向（按终点站属地判定） */
  direction: "往澳门" | "往横琴";
  /** 线路名全称（md 原文标题） */
  lineFullName: string;
  /** 源文件中的完整标题原文（与 lineFullName 同值，保留以明示来源） */
  sourceName: string;
  /** 原文时段部分（澳琴早上班 / 上班 / 午下班…） */
  tripLabel: string;
  departureTime: string;
  arrivalTime: string;
  stopCount: number;
  originName: string;
  terminalName: string;
  stops: TqhTripStopSeed[];
}

export const TQH_STATIONS: TqhStationSeed[] = [
  {
    "name": "中海名钻(北门)②",
    "lng": 113.53759,
    "lat": 22.136332,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "依依桥北②",
    "lng": 113.535271,
    "lat": 22.13365,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "依依桥北①",
    "lng": 113.537125,
    "lat": 22.133474,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "伯牙小学临时停靠点②",
    "lng": 113.524704,
    "lat": 22.133774,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "天星里②",
    "lng": 113.531143,
    "lat": 22.13364,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "伯牙小学临时停靠点①",
    "lng": 113.525291,
    "lat": 22.133863,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "横琴国际商务中心(靠ICC)",
    "lng": 113.544228,
    "lat": 22.143843,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "下村②",
    "lng": 113.529228,
    "lat": 22.138304,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "澳门科技大学-伟龙（西北门）①",
    "lng": 113.570084,
    "lat": 22.149073,
    "side": "澳门",
    "busCode": "T373/1"
  },
  {
    "name": "澳门科技大学-伟龙（西北门）②",
    "lng": 113.570068,
    "lat": 22.149033,
    "side": "澳门",
    "busCode": "T373/1"
  },
  {
    "name": "天星里①",
    "lng": 113.52951,
    "lat": 22.13378,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "银河酒店",
    "lng": 113.558746,
    "lat": 22.14324,
    "side": "澳门",
    "busCode": null
  },
  {
    "name": "澳大/研究生宿舍②",
    "lng": 113.551353,
    "lat": 22.122862,
    "side": "澳门",
    "busCode": "T551/2"
  },
  {
    "name": "银河酒店①",
    "lng": 113.560333,
    "lat": 22.14753,
    "side": "澳门",
    "busCode": "T365/1"
  },
  {
    "name": "澳大/中央教学楼②",
    "lng": 113.551666,
    "lat": 22.125534,
    "side": "澳门",
    "busCode": "T552"
  },
  {
    "name": "新濠影汇①",
    "lng": 113.568375,
    "lat": 22.137518,
    "side": "澳门",
    "busCode": "T360"
  },
  {
    "name": "横琴国际商务中心(靠ICC)②",
    "lng": 113.544235,
    "lat": 22.143875,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "下村①",
    "lng": 113.528404,
    "lat": 22.138309,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "华发首府（4号岗）②",
    "lng": 113.528717,
    "lat": 22.136261,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "澳大/中央教学楼①",
    "lng": 113.55159,
    "lat": 22.125141,
    "side": "澳门",
    "busCode": "T552"
  },
  {
    "name": "澳门科技大学南门（新濠天地）②",
    "lng": 113.573425,
    "lat": 22.147415,
    "side": "澳门",
    "busCode": null
  },
  {
    "name": "澳门科技大学南门（新濠天地）①",
    "lng": 113.573418,
    "lat": 22.147409,
    "side": "澳门",
    "busCode": null
  },
  {
    "name": "新濠影汇②",
    "lng": 113.568604,
    "lat": 22.137819,
    "side": "澳门",
    "busCode": "T359"
  },
  {
    "name": "澳大/研究生宿舍①",
    "lng": 113.551353,
    "lat": 22.121849,
    "side": "澳门",
    "busCode": "T551/1"
  },
  {
    "name": "中海名钻(北门)①",
    "lng": 113.537666,
    "lat": 22.136211,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "华发首府（4号岗）①",
    "lng": 113.528687,
    "lat": 22.136271,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "开新三道南站（公交站）",
    "lng": 113.494652,
    "lat": 22.118835,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "横琴医院",
    "lng": 113.549362,
    "lat": 22.117945,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "横琴新家园((靠澳大)①",
    "lng": 113.545189,
    "lat": 22.125031,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "亚马喇前地G站台",
    "lng": 113.548279,
    "lat": 22.185921,
    "side": "澳门",
    "busCode": "M172/16"
  },
  {
    "name": "横琴人才公寓（西门）①",
    "lng": 113.540421,
    "lat": 22.125923,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "望德圣母湾马路/军营",
    "lng": 113.560486,
    "lat": 22.147661,
    "side": "澳门",
    "busCode": "T364/2"
  },
  {
    "name": "南光大厦(灏怡中心临时停靠点)",
    "lng": 113.546341,
    "lat": 22.135723,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "横琴国贸大厦(都会道临时停靠点)",
    "lng": 113.547302,
    "lat": 22.144108,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "濠江路口(靠澳大公交点)①",
    "lng": 113.545105,
    "lat": 22.129383,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "洋环路口(横琴华发商都)",
    "lng": 113.541374,
    "lat": 22.154266,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "国际网球中心（靠石山村公交点）",
    "lng": 113.537483,
    "lat": 22.12355,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "筷子基总站",
    "lng": 113.548569,
    "lat": 22.205381,
    "side": "澳门",
    "busCode": "M26/1"
  },
  {
    "name": "汇通五路（横琴北）",
    "lng": 113.533936,
    "lat": 22.161205,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "连贯公路/伦敦人",
    "lng": 113.568878,
    "lat": 22.143394,
    "side": "澳门",
    "busCode": "T380"
  },
  {
    "name": "荣澳道南",
    "lng": 113.538742,
    "lat": 22.154188,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "海擎天(劳工子弟幼稚园)",
    "lng": 113.547119,
    "lat": 22.202084,
    "side": "澳门",
    "busCode": null
  },
  {
    "name": "林茂/运顺新村",
    "lng": 113.547508,
    "lat": 22.202175,
    "side": "澳门",
    "busCode": "M130"
  },
  {
    "name": "亚马喇前地F站台",
    "lng": 113.548096,
    "lat": 22.186361,
    "side": "澳门",
    "busCode": "M172/15"
  },
  {
    "name": "海鸣桥（路西侧）",
    "lng": 113.534088,
    "lat": 22.15682,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "横琴国际商务中心②",
    "lng": 113.543518,
    "lat": 22.14562,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "海天居（银行）",
    "lng": 113.562805,
    "lat": 22.208252,
    "side": "澳门",
    "busCode": null
  },
  {
    "name": "沙梨头北街(筷子基宏佳工厦)",
    "lng": 113.546928,
    "lat": 22.206274,
    "side": "澳门",
    "busCode": null
  },
  {
    "name": "南光大厦(停车场出口临时停靠点)",
    "lng": 113.547493,
    "lat": 22.134798,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "汇通七路(IFC)",
    "lng": 113.534485,
    "lat": 22.164013,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "科创中心西门",
    "lng": 113.464752,
    "lat": 22.130352,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "花城公园(公交站)",
    "lng": 113.562302,
    "lat": 22.153191,
    "side": "澳门",
    "busCode": "T339/1"
  },
  {
    "name": "市民中心(祥顺路西侧）（西2）",
    "lng": 113.520821,
    "lat": 22.138597,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "排角/银河",
    "lng": 113.560272,
    "lat": 22.147537,
    "side": "澳门",
    "busCode": "T365/1"
  },
  {
    "name": "市民中心(祥顺路东侧）（东1）",
    "lng": 113.520988,
    "lat": 22.138285,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "中葡经贸中心(往琴海西)",
    "lng": 113.490906,
    "lat": 22.126362,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "澳门街坊会联合总会",
    "lng": 113.549118,
    "lat": 22.210289,
    "side": "澳门",
    "busCode": "M5"
  },
  {
    "name": "东北大马路/南澳",
    "lng": 113.559639,
    "lat": 22.203192,
    "side": "澳门",
    "busCode": "M55"
  },
  {
    "name": "澳门理工大学主校区(理工学院街）",
    "lng": 113.557068,
    "lat": 22.191446,
    "side": "澳门",
    "busCode": null
  },
  {
    "name": "赛马会(公交站)",
    "lng": 113.554482,
    "lat": 22.154102,
    "side": "澳门",
    "busCode": "T327"
  },
  {
    "name": "泉悦花园（氹仔华南工业大厦）",
    "lng": 113.564575,
    "lat": 22.153471,
    "side": "澳门",
    "busCode": "T318"
  },
  {
    "name": "东北大马路/保利达(公交站)",
    "lng": 113.562454,
    "lat": 22.206085,
    "side": "澳门",
    "busCode": "M235/2"
  },
  {
    "name": "鮑思高球場",
    "lng": 113.557076,
    "lat": 22.19948,
    "side": "澳门",
    "busCode": "M46/2"
  },
  {
    "name": "友谊马路/海景花园",
    "lng": 113.557518,
    "lat": 22.189297,
    "side": "澳门",
    "busCode": "M154"
  },
  {
    "name": "琴海西站总站",
    "lng": 113.455147,
    "lat": 22.137732,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "澳门新葡京酒店",
    "lng": 113.548149,
    "lat": 22.188301,
    "side": "澳门",
    "busCode": null
  },
  {
    "name": "林茂/运顺新村(公交站)",
    "lng": 113.54747,
    "lat": 22.202257,
    "side": "澳门",
    "busCode": "M130"
  },
  {
    "name": "澳门新濠锋酒店",
    "lng": 113.560089,
    "lat": 22.159056,
    "side": "澳门",
    "busCode": null
  },
  {
    "name": "中葡经贸中心(往口岸)",
    "lng": 113.491554,
    "lat": 22.126471,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "横琴市民中心（往口岸）",
    "lng": 113.524818,
    "lat": 22.138247,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "横琴人才公寓（正门）",
    "lng": 113.541161,
    "lat": 22.126514,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "横琴金融岛",
    "lng": 113.535095,
    "lat": 22.161964,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "十字门大道②（往IFC方向）",
    "lng": 113.536018,
    "lat": 22.151155,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "十字门大道①",
    "lng": 113.535873,
    "lat": 22.150928,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "向阳东(公交站)",
    "lng": 113.497894,
    "lat": 22.132908,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "横琴检察院（往颂琴方向）",
    "lng": 113.519447,
    "lat": 22.136826,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "横琴市民中心（往颂琴）",
    "lng": 113.522728,
    "lat": 22.137985,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "百合路口(公交站)",
    "lng": 113.456955,
    "lat": 22.154379,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "横琴大桥南②",
    "lng": 113.52401,
    "lat": 22.151361,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "澳门科技大学东门（轻轨站）",
    "lng": 113.575287,
    "lat": 22.150162,
    "side": "澳门",
    "busCode": "T429"
  },
  {
    "name": "荣澳道中（公交站）",
    "lng": 113.538734,
    "lat": 22.158121,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "横琴检察院（法院侧）",
    "lng": 113.519447,
    "lat": 22.136826,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "连贯公路/威尼斯人(公交站）",
    "lng": 113.568794,
    "lat": 22.146387,
    "side": "澳门",
    "busCode": "T363/2"
  },
  {
    "name": "琴朗路口",
    "lng": 113.533737,
    "lat": 22.139839,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "琴政路口（往创业谷方向）①",
    "lng": 113.539108,
    "lat": 22.135418,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "爱琴路东（公交站）",
    "lng": 113.516113,
    "lat": 22.154366,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "市民中心(祥顺路西侧)（西3）",
    "lng": 113.520676,
    "lat": 22.138931,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "南迎客平台（南二门）",
    "lng": 113.551414,
    "lat": 22.137009,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "琴政路口②",
    "lng": 113.539284,
    "lat": 22.134644,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "上村",
    "lng": 113.51519,
    "lat": 22.135265,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "横琴新家园②",
    "lng": 113.545189,
    "lat": 22.125027,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "威尼斯人（公交站）",
    "lng": 113.563171,
    "lat": 22.146036,
    "side": "澳门",
    "busCode": "T394"
  },
  {
    "name": "子期南道中（公交站）",
    "lng": 113.540115,
    "lat": 22.127832,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "保利国际广场（朗琴道交琴政路北侧）",
    "lng": 113.534355,
    "lat": 22.136253,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "霍英东马路/新濠天地",
    "lng": 113.570366,
    "lat": 22.147305,
    "side": "澳门",
    "busCode": "T392"
  },
  {
    "name": "粗沙环（公交点）",
    "lng": 113.545296,
    "lat": 22.121733,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "华发广场（联奥路交都会道）",
    "lng": 113.54213,
    "lat": 22.149879,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "中医药产业园①",
    "lng": 113.462166,
    "lat": 22.134863,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "澳门科技大学-轻轨站",
    "lng": 113.575623,
    "lat": 22.150112,
    "side": "澳门",
    "busCode": "T429"
  },
  {
    "name": "K2荔枝湾②",
    "lng": 113.525169,
    "lat": 22.136381,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "澳门新街坊南",
    "lng": 113.514854,
    "lat": 22.135185,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "中医药产业园（IN1下客点）",
    "lng": 113.462318,
    "lat": 22.132814,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "桂风道路口（北侧西行）",
    "lng": 113.491173,
    "lat": 22.142191,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "澳门新街坊南（往口岸）",
    "lng": 113.51722,
    "lat": 22.135893,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "澳门新街坊",
    "lng": 113.515503,
    "lat": 22.137436,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "市民中心(祥顺路东侧）（东3）",
    "lng": 113.520721,
    "lat": 22.138926,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "莲花路停车场",
    "lng": 113.562454,
    "lat": 22.137054,
    "side": "澳门",
    "busCode": null
  },
  {
    "name": "海上居",
    "lng": 113.560822,
    "lat": 22.210417,
    "side": "澳门",
    "busCode": "M247"
  },
  {
    "name": "机场大马路/上葡京",
    "lng": 113.580856,
    "lat": 22.141644,
    "side": "澳门",
    "busCode": "T434"
  },
  {
    "name": "濠江路口①",
    "lng": 113.544594,
    "lat": 22.131172,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "澳门口岸区H2(7/8/9卡位)",
    "lng": 113.551582,
    "lat": 22.137985,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "中医药产业园内",
    "lng": 113.462013,
    "lat": 22.131878,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "机场大马路/科大医院",
    "lng": 113.575127,
    "lat": 22.1504,
    "side": "澳门",
    "busCode": "T429"
  },
  {
    "name": "关闸马路",
    "lng": 113.553642,
    "lat": 22.209351,
    "side": "澳门",
    "busCode": "M7/3"
  },
  {
    "name": "关闸广场(旅游巴出口停靠位)",
    "lng": 113.55484,
    "lat": 22.212755,
    "side": "澳门",
    "busCode": null
  },
  {
    "name": "莲花路停车场（莲花关桥头）",
    "lng": 113.56559,
    "lat": 22.13608,
    "side": "澳门",
    "busCode": "T355/1"
  },
  {
    "name": "市民中心(祥顺路东侧）（东2）",
    "lng": 113.520844,
    "lat": 22.138617,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "巴波沙大馬路",
    "lng": 113.552711,
    "lat": 22.209938,
    "side": "澳门",
    "busCode": "M8"
  },
  {
    "name": "横琴口岸（南二门迎客平台）",
    "lng": 113.551292,
    "lat": 22.136866,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "科大/机场货运站",
    "lng": 113.575432,
    "lat": 22.150185,
    "side": "澳门",
    "busCode": "T417"
  },
  {
    "name": "二龙喉公园",
    "lng": 113.555939,
    "lat": 22.198063,
    "side": "澳门",
    "busCode": "M61/1"
  },
  {
    "name": "射击路/上葡京",
    "lng": 113.578773,
    "lat": 22.142256,
    "side": "澳门",
    "busCode": "T433"
  },
  {
    "name": "中央汇(创业谷)(临时停靠点)",
    "lng": 113.544693,
    "lat": 22.129429,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "观音堂(来来商场对面)",
    "lng": 113.555374,
    "lat": 22.200888,
    "side": "澳门",
    "busCode": null
  },
  {
    "name": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "lng": 113.560066,
    "lat": 22.159071,
    "side": "澳门",
    "busCode": null
  },
  {
    "name": "观音古庙门口（澳旅大望厦校区）",
    "lng": 113.55265,
    "lat": 22.203045,
    "side": "澳门",
    "busCode": null
  },
  {
    "name": "保利国际广场(琴政路北侧)",
    "lng": 113.534286,
    "lat": 22.136248,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "澳大/行政楼",
    "lng": 113.548241,
    "lat": 22.131048,
    "side": "澳门",
    "busCode": "T556"
  },
  {
    "name": "横琴检察院（往口岸）",
    "lng": 113.520645,
    "lat": 22.137182,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "澳门科技大学（望德圣母湾大马路）",
    "lng": 113.567497,
    "lat": 22.147457,
    "side": "澳门",
    "busCode": "T367"
  },
  {
    "name": "上村村口公交站",
    "lng": 113.512062,
    "lat": 22.139662,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "澳门威尼斯人",
    "lng": 113.567886,
    "lat": 22.144585,
    "side": "澳门",
    "busCode": null
  },
  {
    "name": "保利国际广场(琴政路南侧)",
    "lng": 113.534271,
    "lat": 22.136217,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "K2荔枝湾(伯牙幼儿园旁)",
    "lng": 113.5271,
    "lat": 22.136425,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "金汇国际广场①",
    "lng": 113.511482,
    "lat": 22.133884,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "桂风道路口（南侧东行）",
    "lng": 113.493332,
    "lat": 22.14295,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "环岛北路西（科创中心）②",
    "lng": 113.465225,
    "lat": 22.132042,
    "side": "横琴",
    "busCode": null
  },
  {
    "name": "市民中心(祥顺路西侧)（西1）",
    "lng": 113.520958,
    "lat": 22.138266,
    "side": "横琴",
    "busCode": null
  }
];

export const TQH_TRIPS: TqhTripSeed[] = [
  {
    "sourceName": "A1线-上班线",
    "routeNo": "A1",
    "direction": "往澳门",
    "lineFullName": "A1线-上班线",
    "tripLabel": "上班线",
    "tripCode": "A1｜往澳门｜A1线-上班线",
    "departureTime": "07:30",
    "arrivalTime": "08:32",
    "stopCount": 7,
    "originName": "汇通五路（横琴北）",
    "terminalName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "stops": [
      {
        "seq": 1,
        "stationName": "汇通五路（横琴北）",
        "time": "07:30"
      },
      {
        "seq": 2,
        "stationName": "华发广场（联奥路交都会道）",
        "time": "07:40"
      },
      {
        "seq": 3,
        "stationName": "横琴国际商务中心(靠ICC)",
        "time": "07:43"
      },
      {
        "seq": 4,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "08:15"
      },
      {
        "seq": 5,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "08:25"
      },
      {
        "seq": 6,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "08:27"
      },
      {
        "seq": 7,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "08:32"
      }
    ]
  },
  {
    "sourceName": "A2线-上班线",
    "routeNo": "A2",
    "direction": "往澳门",
    "lineFullName": "A2线-上班线",
    "tripLabel": "上班线",
    "tripCode": "A2｜往澳门｜A2线-上班线",
    "departureTime": "14:12",
    "arrivalTime": "15:05",
    "stopCount": 9,
    "originName": "澳门新街坊",
    "terminalName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊",
        "time": "14:12"
      },
      {
        "seq": 2,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "14:15"
      },
      {
        "seq": 3,
        "stationName": "华发首府（4号岗）①",
        "time": "14:16"
      },
      {
        "seq": 4,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "14:17"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)①",
        "time": "14:18"
      },
      {
        "seq": 6,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "14:48"
      },
      {
        "seq": 7,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "14:58"
      },
      {
        "seq": 8,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "15:00"
      },
      {
        "seq": 9,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "15:05"
      }
    ]
  },
  {
    "sourceName": "A2线-下班线",
    "routeNo": "A2",
    "direction": "往横琴",
    "lineFullName": "A2线-下班线",
    "tripLabel": "下班线",
    "tripCode": "A2｜往横琴｜A2线-下班线",
    "departureTime": "15:40",
    "arrivalTime": "16:34",
    "stopCount": 9,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "澳门新街坊",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "15:40"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学南门（新濠天地）②",
        "time": "15:48"
      },
      {
        "seq": 3,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "15:50"
      },
      {
        "seq": 4,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "16:20"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)②",
        "time": "16:29"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "16:30"
      },
      {
        "seq": 7,
        "stationName": "华发首府（4号岗）②",
        "time": "16:31"
      },
      {
        "seq": 8,
        "stationName": "K2荔枝湾②",
        "time": "16:31"
      },
      {
        "seq": 9,
        "stationName": "澳门新街坊",
        "time": "16:34"
      }
    ]
  },
  {
    "sourceName": "A3线早班-上班",
    "routeNo": "A3",
    "direction": "往澳门",
    "lineFullName": "A3线早班-上班",
    "tripLabel": "上班",
    "tripCode": "A3｜往澳门｜A3线早班-上班",
    "departureTime": "07:30",
    "arrivalTime": "08:33",
    "stopCount": 11,
    "originName": "中医药产业园内",
    "terminalName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "stops": [
      {
        "seq": 1,
        "stationName": "中医药产业园内",
        "time": "07:30"
      },
      {
        "seq": 2,
        "stationName": "环岛北路西（科创中心）②",
        "time": "07:32"
      },
      {
        "seq": 3,
        "stationName": "澳门新街坊",
        "time": "07:41"
      },
      {
        "seq": 4,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "07:45"
      },
      {
        "seq": 5,
        "stationName": "华发首府（4号岗）②",
        "time": "07:46"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "07:47"
      },
      {
        "seq": 7,
        "stationName": "中海名钻(北门)①",
        "time": "07:48"
      },
      {
        "seq": 8,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "08:15"
      },
      {
        "seq": 9,
        "stationName": "澳门威尼斯人",
        "time": "08:21"
      },
      {
        "seq": 10,
        "stationName": "澳门科技大学东门（轻轨站）",
        "time": "08:24"
      },
      {
        "seq": 11,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "08:33"
      }
    ]
  },
  {
    "sourceName": "A3线中班-下班",
    "routeNo": "A3",
    "direction": "往横琴",
    "lineFullName": "A3线中班-下班",
    "tripLabel": "下班",
    "tripCode": "A3｜往横琴｜A3线中班-下班",
    "departureTime": "12:00",
    "arrivalTime": "12:39",
    "stopCount": 11,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "中医药产业园（IN1下客点）",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "12:00"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学-伟龙（西北门）②",
        "time": "12:06"
      },
      {
        "seq": 3,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "12:09"
      },
      {
        "seq": 4,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "12:16"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)②",
        "time": "12:23"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "12:24"
      },
      {
        "seq": 7,
        "stationName": "华发首府（4号岗）①",
        "time": "12:25"
      },
      {
        "seq": 8,
        "stationName": "K2荔枝湾②",
        "time": "12:26"
      },
      {
        "seq": 9,
        "stationName": "澳门新街坊",
        "time": "12:29"
      },
      {
        "seq": 10,
        "stationName": "环岛北路西（科创中心）②",
        "time": "12:38"
      },
      {
        "seq": 11,
        "stationName": "中医药产业园（IN1下客点）",
        "time": "12:39"
      }
    ]
  },
  {
    "sourceName": "A3线晚班-下班",
    "routeNo": "A3",
    "direction": "往横琴",
    "lineFullName": "A3线晚班-下班",
    "tripLabel": "下班",
    "tripCode": "A3｜往横琴｜A3线晚班-下班",
    "departureTime": "19:30",
    "arrivalTime": "20:33",
    "stopCount": 11,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "中医药产业园（IN1下客点）",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "19:30"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "19:38"
      },
      {
        "seq": 3,
        "stationName": "霍英东马路/新濠天地",
        "time": "19:39"
      },
      {
        "seq": 4,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "20:04"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)②",
        "time": "20:11"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "20:12"
      },
      {
        "seq": 7,
        "stationName": "华发首府（4号岗）①",
        "time": "20:13"
      },
      {
        "seq": 8,
        "stationName": "K2荔枝湾②",
        "time": "20:16"
      },
      {
        "seq": 9,
        "stationName": "澳门新街坊",
        "time": "20:21"
      },
      {
        "seq": 10,
        "stationName": "环岛北路西（科创中心）②",
        "time": "20:31"
      },
      {
        "seq": 11,
        "stationName": "中医药产业园（IN1下客点）",
        "time": "20:33"
      }
    ]
  },
  {
    "sourceName": "A4线下午-上班",
    "routeNo": "A4",
    "direction": "往澳门",
    "lineFullName": "A4线下午-上班",
    "tripLabel": "上班",
    "tripCode": "A4｜往澳门｜A4线下午-上班",
    "departureTime": "17:38",
    "arrivalTime": "18:58",
    "stopCount": 17,
    "originName": "中医药产业园内",
    "terminalName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "stops": [
      {
        "seq": 1,
        "stationName": "中医药产业园内",
        "time": "17:38"
      },
      {
        "seq": 2,
        "stationName": "环岛北路西（科创中心）②",
        "time": "17:39"
      },
      {
        "seq": 3,
        "stationName": "桂风道路口（南侧东行）",
        "time": "17:44"
      },
      {
        "seq": 4,
        "stationName": "市民中心(祥顺路西侧)（西1）",
        "time": "17:50"
      },
      {
        "seq": 5,
        "stationName": "澳门新街坊",
        "time": "17:52"
      },
      {
        "seq": 6,
        "stationName": "金汇国际广场①",
        "time": "17:54"
      },
      {
        "seq": 7,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "17:56"
      },
      {
        "seq": 8,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "18:02"
      },
      {
        "seq": 9,
        "stationName": "华发首府（4号岗）②",
        "time": "18:03"
      },
      {
        "seq": 10,
        "stationName": "保利国际广场(琴政路南侧)",
        "time": "18:05"
      },
      {
        "seq": 11,
        "stationName": "中海名钻(北门)①",
        "time": "18:06"
      },
      {
        "seq": 12,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "18:26"
      },
      {
        "seq": 13,
        "stationName": "澳大/研究生宿舍①",
        "time": "18:34"
      },
      {
        "seq": 14,
        "stationName": "澳大/中央教学楼①",
        "time": "18:36"
      },
      {
        "seq": 15,
        "stationName": "澳门威尼斯人",
        "time": "18:45"
      },
      {
        "seq": 16,
        "stationName": "澳门科技大学东门（轻轨站）",
        "time": "18:51"
      },
      {
        "seq": 17,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "18:58"
      }
    ]
  },
  {
    "sourceName": "A4线夜班-下班",
    "routeNo": "A4",
    "direction": "往横琴",
    "lineFullName": "A4线夜班-下班",
    "tripLabel": "下班",
    "tripCode": "A4｜往横琴｜A4线夜班-下班",
    "departureTime": "21:55",
    "arrivalTime": "22:49",
    "stopCount": 11,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "中医药产业园（IN1下客点）",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "21:55"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "22:03"
      },
      {
        "seq": 3,
        "stationName": "霍英东马路/新濠天地",
        "time": "22:04"
      },
      {
        "seq": 4,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "22:20"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)②",
        "time": "22:27"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "22:28"
      },
      {
        "seq": 7,
        "stationName": "华发首府（4号岗）①",
        "time": "22:29"
      },
      {
        "seq": 8,
        "stationName": "K2荔枝湾②",
        "time": "22:32"
      },
      {
        "seq": 9,
        "stationName": "澳门新街坊",
        "time": "22:37"
      },
      {
        "seq": 10,
        "stationName": "环岛北路西（科创中心）②",
        "time": "22:47"
      },
      {
        "seq": 11,
        "stationName": "中医药产业园（IN1下客点）",
        "time": "22:49"
      }
    ]
  },
  {
    "sourceName": "A5线-澳琴早上班",
    "routeNo": "A5",
    "direction": "往横琴",
    "lineFullName": "A5线-澳琴早上班",
    "tripLabel": "澳琴早上班",
    "tripCode": "A5｜往横琴｜A5线-澳琴早上班",
    "departureTime": "09:00",
    "arrivalTime": "09:57",
    "stopCount": 8,
    "originName": "澳门理工大学主校区(理工学院街）",
    "terminalName": "澳门新街坊南",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门理工大学主校区(理工学院街）",
        "time": "09:00"
      },
      {
        "seq": 2,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "09:14"
      },
      {
        "seq": 3,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "09:43"
      },
      {
        "seq": 4,
        "stationName": "中海名钻(北门)②",
        "time": "09:50"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场(琴政路北侧)",
        "time": "09:51"
      },
      {
        "seq": 6,
        "stationName": "华发首府（4号岗）①",
        "time": "09:52"
      },
      {
        "seq": 7,
        "stationName": "K2荔枝湾②",
        "time": "09:53"
      },
      {
        "seq": 8,
        "stationName": "澳门新街坊南",
        "time": "09:57"
      }
    ]
  },
  {
    "sourceName": "A5线-琴澳上班",
    "routeNo": "A5",
    "direction": "往澳门",
    "lineFullName": "A5线-琴澳上班",
    "tripLabel": "琴澳上班",
    "tripCode": "A5｜往澳门｜A5线-琴澳上班",
    "departureTime": "10:15",
    "arrivalTime": "11:14",
    "stopCount": 8,
    "originName": "澳门新街坊南（往口岸）",
    "terminalName": "澳门理工大学主校区(理工学院街）",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "10:15"
      },
      {
        "seq": 2,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "10:17"
      },
      {
        "seq": 3,
        "stationName": "华发首府（4号岗）②",
        "time": "10:18"
      },
      {
        "seq": 4,
        "stationName": "保利国际广场(琴政路北侧)",
        "time": "10:19"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)①",
        "time": "10:20"
      },
      {
        "seq": 6,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "10:45"
      },
      {
        "seq": 7,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "11:00"
      },
      {
        "seq": 8,
        "stationName": "澳门理工大学主校区(理工学院街）",
        "time": "11:14"
      }
    ]
  },
  {
    "sourceName": "A5线-琴澳午上班",
    "routeNo": "A5",
    "direction": "往澳门",
    "lineFullName": "A5线-琴澳午上班",
    "tripLabel": "琴澳午上班",
    "tripCode": "A5｜往澳门｜A5线-琴澳午上班",
    "departureTime": "13:15",
    "arrivalTime": "14:14",
    "stopCount": 8,
    "originName": "澳门新街坊南（往口岸）",
    "terminalName": "澳门理工大学主校区(理工学院街）",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "13:15"
      },
      {
        "seq": 2,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "13:17"
      },
      {
        "seq": 3,
        "stationName": "华发首府（4号岗）②",
        "time": "13:18"
      },
      {
        "seq": 4,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "13:19"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)①",
        "time": "13:20"
      },
      {
        "seq": 6,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "13:45"
      },
      {
        "seq": 7,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "14:00"
      },
      {
        "seq": 8,
        "stationName": "澳门理工大学主校区(理工学院街）",
        "time": "14:14"
      }
    ]
  },
  {
    "sourceName": "A5线-琴澳晚下班",
    "routeNo": "A5",
    "direction": "往澳门",
    "lineFullName": "A5线-琴澳晚下班",
    "tripLabel": "琴澳晚下班",
    "tripCode": "A5｜往澳门｜A5线-琴澳晚下班",
    "departureTime": "17:45",
    "arrivalTime": "18:44",
    "stopCount": 8,
    "originName": "澳门新街坊南（往口岸）",
    "terminalName": "澳门理工大学主校区(理工学院街）",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "17:45"
      },
      {
        "seq": 2,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "17:47"
      },
      {
        "seq": 3,
        "stationName": "华发首府（4号岗）②",
        "time": "17:48"
      },
      {
        "seq": 4,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "17:49"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)①",
        "time": "17:50"
      },
      {
        "seq": 6,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "18:15"
      },
      {
        "seq": 7,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "18:30"
      },
      {
        "seq": 8,
        "stationName": "澳门理工大学主校区(理工学院街）",
        "time": "18:44"
      }
    ]
  },
  {
    "sourceName": "A5线-澳琴午下班",
    "routeNo": "A5",
    "direction": "往横琴",
    "lineFullName": "A5线-澳琴午下班",
    "tripLabel": "澳琴午下班",
    "tripCode": "A5｜往横琴｜A5线-澳琴午下班",
    "departureTime": "13:30",
    "arrivalTime": "14:29",
    "stopCount": 8,
    "originName": "澳门理工大学主校区(理工学院街）",
    "terminalName": "澳门新街坊南",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门理工大学主校区(理工学院街）",
        "time": "13:30"
      },
      {
        "seq": 2,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "13:44"
      },
      {
        "seq": 3,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "14:13"
      },
      {
        "seq": 4,
        "stationName": "中海名钻(北门)②",
        "time": "14:21"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "14:22"
      },
      {
        "seq": 6,
        "stationName": "华发首府（4号岗）②",
        "time": "14:23"
      },
      {
        "seq": 7,
        "stationName": "K2荔枝湾②",
        "time": "14:24"
      },
      {
        "seq": 8,
        "stationName": "澳门新街坊南",
        "time": "14:29"
      }
    ]
  },
  {
    "sourceName": "B1线（高校线）-上班",
    "routeNo": "B1",
    "direction": "往澳门",
    "lineFullName": "B1线（高校线）-上班",
    "tripLabel": "上班",
    "tripCode": "B1｜往澳门｜B1线（高校线）-上班",
    "departureTime": "17:27",
    "arrivalTime": "18:37",
    "stopCount": 11,
    "originName": "澳门新街坊",
    "terminalName": "澳门理工大学主校区(理工学院街）",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊",
        "time": "17:27"
      },
      {
        "seq": 2,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "17:28"
      },
      {
        "seq": 3,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "17:32"
      },
      {
        "seq": 4,
        "stationName": "华发首府（4号岗）①",
        "time": "17:33"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "17:34"
      },
      {
        "seq": 6,
        "stationName": "中海名钻(北门)①",
        "time": "17:35"
      },
      {
        "seq": 7,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "18:04"
      },
      {
        "seq": 8,
        "stationName": "澳门科技大学东门（轻轨站）",
        "time": "18:14"
      },
      {
        "seq": 9,
        "stationName": "澳门科技大学-伟龙（西北门）②",
        "time": "18:17"
      },
      {
        "seq": 10,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "18:22"
      },
      {
        "seq": 11,
        "stationName": "澳门理工大学主校区(理工学院街）",
        "time": "18:37"
      }
    ]
  },
  {
    "sourceName": "B1线（高校线）-下班",
    "routeNo": "B1",
    "direction": "往横琴",
    "lineFullName": "B1线（高校线）-下班",
    "tripLabel": "下班",
    "tripCode": "B1｜往横琴｜B1线（高校线）-下班",
    "departureTime": "19:00",
    "arrivalTime": "20:03",
    "stopCount": 9,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "澳门新街坊",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "19:00"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学东门（轻轨站）",
        "time": "19:08"
      },
      {
        "seq": 3,
        "stationName": "澳门科技大学-伟龙（西北门）②",
        "time": "19:10"
      },
      {
        "seq": 4,
        "stationName": "南迎客平台（南二门）",
        "time": "19:45"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)②",
        "time": "19:52"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "19:54"
      },
      {
        "seq": 7,
        "stationName": "华发首府（4号岗）①",
        "time": "19:57"
      },
      {
        "seq": 8,
        "stationName": "K2荔枝湾②",
        "time": "19:59"
      },
      {
        "seq": 9,
        "stationName": "澳门新街坊",
        "time": "20:03"
      }
    ]
  },
  {
    "sourceName": "B2线（高校线）-上班",
    "routeNo": "B2",
    "direction": "往澳门",
    "lineFullName": "B2线（高校线）-上班",
    "tripLabel": "上班",
    "tripCode": "B2｜往澳门｜B2线（高校线）-上班",
    "departureTime": "10:47",
    "arrivalTime": "11:44",
    "stopCount": 11,
    "originName": "澳门新街坊",
    "terminalName": "澳大/行政楼",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊",
        "time": "10:47"
      },
      {
        "seq": 2,
        "stationName": "金汇国际广场①",
        "time": "10:49"
      },
      {
        "seq": 3,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "10:50"
      },
      {
        "seq": 4,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "10:52"
      },
      {
        "seq": 5,
        "stationName": "华发首府（4号岗）①",
        "time": "10:53"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "10:54"
      },
      {
        "seq": 7,
        "stationName": "中海名钻(北门)①",
        "time": "10:56"
      },
      {
        "seq": 8,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "11:26"
      },
      {
        "seq": 9,
        "stationName": "澳大/研究生宿舍①",
        "time": "11:36"
      },
      {
        "seq": 10,
        "stationName": "澳大/中央教学楼①",
        "time": "11:39"
      },
      {
        "seq": 11,
        "stationName": "澳大/行政楼",
        "time": "11:44"
      }
    ]
  },
  {
    "sourceName": "B2线（高校线）-下班",
    "routeNo": "B2",
    "direction": "往横琴",
    "lineFullName": "B2线（高校线）-下班",
    "tripLabel": "下班",
    "tripCode": "B2｜往横琴｜B2线（高校线）-下班",
    "departureTime": "12:20",
    "arrivalTime": "13:08",
    "stopCount": 12,
    "originName": "澳门科技大学南门（新濠天地）①",
    "terminalName": "金汇国际广场①",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "12:20"
      },
      {
        "seq": 2,
        "stationName": "澳大/研究生宿舍②",
        "time": "12:31"
      },
      {
        "seq": 3,
        "stationName": "澳大/中央教学楼②",
        "time": "12:33"
      },
      {
        "seq": 4,
        "stationName": "澳大/行政楼",
        "time": "12:35"
      },
      {
        "seq": 5,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "12:55"
      },
      {
        "seq": 6,
        "stationName": "中海名钻(北门)②",
        "time": "13:01"
      },
      {
        "seq": 7,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "13:02"
      },
      {
        "seq": 8,
        "stationName": "华发首府（4号岗）①",
        "time": "13:03"
      },
      {
        "seq": 9,
        "stationName": "K2荔枝湾②",
        "time": "13:04"
      },
      {
        "seq": 10,
        "stationName": "澳门新街坊",
        "time": "13:06"
      },
      {
        "seq": 11,
        "stationName": "澳门新街坊南",
        "time": "13:07"
      },
      {
        "seq": 12,
        "stationName": "金汇国际广场①",
        "time": "13:08"
      }
    ]
  },
  {
    "sourceName": "B3线（高校线）-上班",
    "routeNo": "B3",
    "direction": "往澳门",
    "lineFullName": "B3线（高校线）-上班",
    "tripLabel": "上班",
    "tripCode": "B3｜往澳门｜B3线（高校线）-上班",
    "departureTime": "10:45",
    "arrivalTime": "11:45",
    "stopCount": 10,
    "originName": "横琴人才公寓（西门）①",
    "terminalName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "stops": [
      {
        "seq": 1,
        "stationName": "横琴人才公寓（西门）①",
        "time": "10:45"
      },
      {
        "seq": 2,
        "stationName": "国际网球中心（靠石山村公交点）",
        "time": "10:48"
      },
      {
        "seq": 3,
        "stationName": "粗沙环（公交点）",
        "time": "10:50"
      },
      {
        "seq": 4,
        "stationName": "横琴医院",
        "time": "10:51"
      },
      {
        "seq": 5,
        "stationName": "横琴新家园((靠澳大)①",
        "time": "10:54"
      },
      {
        "seq": 6,
        "stationName": "濠江路口(靠澳大公交点)①",
        "time": "10:55"
      },
      {
        "seq": 7,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "11:25"
      },
      {
        "seq": 8,
        "stationName": "澳门科技大学东门（轻轨站）",
        "time": "11:35"
      },
      {
        "seq": 9,
        "stationName": "澳门科技大学-伟龙（西北门）②",
        "time": "11:40"
      },
      {
        "seq": 10,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "11:45"
      }
    ]
  },
  {
    "sourceName": "B3线（高校线）-下班",
    "routeNo": "B3",
    "direction": "往横琴",
    "lineFullName": "B3线（高校线）-下班",
    "tripLabel": "下班",
    "tripCode": "B3｜往横琴｜B3线（高校线）-下班",
    "departureTime": "12:20",
    "arrivalTime": "13:14",
    "stopCount": 8,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "横琴医院",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "12:20"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学东门（轻轨站）",
        "time": "12:26"
      },
      {
        "seq": 3,
        "stationName": "澳门科技大学-伟龙（西北门）②",
        "time": "12:28"
      },
      {
        "seq": 4,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "12:58"
      },
      {
        "seq": 5,
        "stationName": "横琴人才公寓（正门）",
        "time": "13:03"
      },
      {
        "seq": 6,
        "stationName": "国际网球中心（靠石山村公交点）",
        "time": "13:06"
      },
      {
        "seq": 7,
        "stationName": "粗沙环（公交点）",
        "time": "13:09"
      },
      {
        "seq": 8,
        "stationName": "横琴医院",
        "time": "13:14"
      }
    ]
  },
  {
    "sourceName": "B3线（高校线）-琴澳下班",
    "routeNo": "B3",
    "direction": "往澳门",
    "lineFullName": "B3线（高校线）-琴澳下班",
    "tripLabel": "琴澳下班",
    "tripCode": "B3｜往澳门｜B3线（高校线）-琴澳下班",
    "departureTime": "17:46",
    "arrivalTime": "18:53",
    "stopCount": 11,
    "originName": "市民中心(祥顺路西侧)（西3）",
    "terminalName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "stops": [
      {
        "seq": 1,
        "stationName": "市民中心(祥顺路西侧)（西3）",
        "time": "17:46"
      },
      {
        "seq": 2,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "17:48"
      },
      {
        "seq": 3,
        "stationName": "子期南道中（公交站）",
        "time": "17:54"
      },
      {
        "seq": 4,
        "stationName": "横琴新家园②",
        "time": "17:56"
      },
      {
        "seq": 5,
        "stationName": "濠江路口(靠澳大公交点)①",
        "time": "17:57"
      },
      {
        "seq": 6,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "18:21"
      },
      {
        "seq": 7,
        "stationName": "澳大/研究生宿舍①",
        "time": "18:29"
      },
      {
        "seq": 8,
        "stationName": "澳大/中央教学楼①",
        "time": "18:31"
      },
      {
        "seq": 9,
        "stationName": "澳门科技大学东门（轻轨站）",
        "time": "18:40"
      },
      {
        "seq": 10,
        "stationName": "威尼斯人（公交站）",
        "time": "18:46"
      },
      {
        "seq": 11,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "18:53"
      }
    ]
  },
  {
    "sourceName": "B4线（高校线）-上班",
    "routeNo": "B4",
    "direction": "往澳门",
    "lineFullName": "B4线（高校线）-上班",
    "tripLabel": "上班",
    "tripCode": "B4｜往澳门｜B4线（高校线）-上班",
    "departureTime": "17:30",
    "arrivalTime": "18:35",
    "stopCount": 13,
    "originName": "横琴人才公寓（西门）①",
    "terminalName": "澳门科技大学-伟龙（西北门）①",
    "stops": [
      {
        "seq": 1,
        "stationName": "横琴人才公寓（西门）①",
        "time": "17:30"
      },
      {
        "seq": 2,
        "stationName": "国际网球中心（靠石山村公交点）",
        "time": "17:33"
      },
      {
        "seq": 3,
        "stationName": "粗沙环（公交点）",
        "time": "17:35"
      },
      {
        "seq": 4,
        "stationName": "横琴医院",
        "time": "17:36"
      },
      {
        "seq": 5,
        "stationName": "横琴新家园((靠澳大)①",
        "time": "17:39"
      },
      {
        "seq": 6,
        "stationName": "濠江路口(靠澳大公交点)①",
        "time": "17:40"
      },
      {
        "seq": 7,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "18:00"
      },
      {
        "seq": 8,
        "stationName": "澳大/研究生宿舍①",
        "time": "18:10"
      },
      {
        "seq": 9,
        "stationName": "澳大/中央教学楼①",
        "time": "18:13"
      },
      {
        "seq": 10,
        "stationName": "澳大/行政楼",
        "time": "18:18"
      },
      {
        "seq": 11,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "18:30"
      },
      {
        "seq": 12,
        "stationName": "澳门科技大学-轻轨站",
        "time": "18:33"
      },
      {
        "seq": 13,
        "stationName": "澳门科技大学-伟龙（西北门）①",
        "time": "18:35"
      }
    ]
  },
  {
    "sourceName": "B4线（高校线）-下班",
    "routeNo": "B4",
    "direction": "往横琴",
    "lineFullName": "B4线（高校线）-下班",
    "tripLabel": "下班",
    "tripCode": "B4｜往横琴｜B4线（高校线）-下班",
    "departureTime": "19:10",
    "arrivalTime": "19:55",
    "stopCount": 8,
    "originName": "澳大/行政楼",
    "terminalName": "横琴医院",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳大/行政楼",
        "time": "19:10"
      },
      {
        "seq": 2,
        "stationName": "澳大/研究生宿舍②",
        "time": "19:15"
      },
      {
        "seq": 3,
        "stationName": "澳大/中央教学楼②",
        "time": "19:16"
      },
      {
        "seq": 4,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "19:40"
      },
      {
        "seq": 5,
        "stationName": "横琴人才公寓（正门）",
        "time": "19:45"
      },
      {
        "seq": 6,
        "stationName": "国际网球中心（靠石山村公交点）",
        "time": "19:48"
      },
      {
        "seq": 7,
        "stationName": "粗沙环（公交点）",
        "time": "19:50"
      },
      {
        "seq": 8,
        "stationName": "横琴医院",
        "time": "19:55"
      }
    ]
  },
  {
    "sourceName": "B5线（高校线）-上班",
    "routeNo": "B5",
    "direction": "往澳门",
    "lineFullName": "B5线（高校线）-上班",
    "tripLabel": "上班",
    "tripCode": "B5｜往澳门｜B5线（高校线）-上班",
    "departureTime": "13:32",
    "arrivalTime": "14:34",
    "stopCount": 11,
    "originName": "澳门新街坊",
    "terminalName": "澳门科技大学（望德圣母湾大马路）",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊",
        "time": "13:32"
      },
      {
        "seq": 2,
        "stationName": "金汇国际广场①",
        "time": "13:34"
      },
      {
        "seq": 3,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "13:35"
      },
      {
        "seq": 4,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "13:38"
      },
      {
        "seq": 5,
        "stationName": "华发首府（4号岗）①",
        "time": "13:40"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "13:41"
      },
      {
        "seq": 7,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "14:12"
      },
      {
        "seq": 8,
        "stationName": "澳大/研究生宿舍①",
        "time": "14:18"
      },
      {
        "seq": 9,
        "stationName": "澳大/中央教学楼①",
        "time": "14:20"
      },
      {
        "seq": 10,
        "stationName": "澳大/行政楼",
        "time": "14:22"
      },
      {
        "seq": 11,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "14:34"
      }
    ]
  },
  {
    "sourceName": "B5线（高校线）-下班",
    "routeNo": "B5",
    "direction": "往横琴",
    "lineFullName": "B5线（高校线）-下班",
    "tripLabel": "下班",
    "tripCode": "B5｜往横琴｜B5线（高校线）-下班",
    "departureTime": "15:20",
    "arrivalTime": "16:14",
    "stopCount": 11,
    "originName": "澳门科技大学南门（新濠天地）②",
    "terminalName": "金汇国际广场①",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门科技大学南门（新濠天地）②",
        "time": "15:20"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "15:21"
      },
      {
        "seq": 3,
        "stationName": "澳大/研究生宿舍②",
        "time": "15:31"
      },
      {
        "seq": 4,
        "stationName": "澳大/行政楼",
        "time": "15:36"
      },
      {
        "seq": 5,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "16:00"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "16:02"
      },
      {
        "seq": 7,
        "stationName": "华发首府（4号岗）②",
        "time": "16:03"
      },
      {
        "seq": 8,
        "stationName": "K2荔枝湾②",
        "time": "16:05"
      },
      {
        "seq": 9,
        "stationName": "澳门新街坊",
        "time": "16:10"
      },
      {
        "seq": 10,
        "stationName": "澳门新街坊南",
        "time": "16:12"
      },
      {
        "seq": 11,
        "stationName": "金汇国际广场①",
        "time": "16:14"
      }
    ]
  },
  {
    "sourceName": "B5线（高校线）-澳琴晚班",
    "routeNo": "B5",
    "direction": "往横琴",
    "lineFullName": "B5线（高校线）-澳琴晚班",
    "tripLabel": "澳琴晚班",
    "tripCode": "B5｜往横琴｜B5线（高校线）-澳琴晚班",
    "departureTime": "22:00",
    "arrivalTime": "22:50",
    "stopCount": 9,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "汇通五路（横琴北）",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "22:00"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学东门（轻轨站）",
        "time": "22:07"
      },
      {
        "seq": 3,
        "stationName": "澳门科技大学-伟龙（西北门）①",
        "time": "22:10"
      },
      {
        "seq": 4,
        "stationName": "南迎客平台（南二门）",
        "time": "22:30"
      },
      {
        "seq": 5,
        "stationName": "荣澳道中（公交站）",
        "time": "22:41"
      },
      {
        "seq": 6,
        "stationName": "荣澳道南",
        "time": "22:42"
      },
      {
        "seq": 7,
        "stationName": "横琴大桥南②",
        "time": "22:45"
      },
      {
        "seq": 8,
        "stationName": "爱琴路东（公交站）",
        "time": "22:47"
      },
      {
        "seq": 9,
        "stationName": "汇通五路（横琴北）",
        "time": "22:50"
      }
    ]
  },
  {
    "sourceName": "B6线（高校线）-上班",
    "routeNo": "B6",
    "direction": "往澳门",
    "lineFullName": "B6线（高校线）-上班",
    "tripLabel": "上班",
    "tripCode": "B6｜往澳门｜B6线（高校线）-上班",
    "departureTime": "17:40",
    "arrivalTime": "18:46",
    "stopCount": 13,
    "originName": "澳门新街坊",
    "terminalName": "澳门新濠锋酒店",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊",
        "time": "17:40"
      },
      {
        "seq": 2,
        "stationName": "金汇国际广场①",
        "time": "17:42"
      },
      {
        "seq": 3,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "17:43"
      },
      {
        "seq": 4,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "17:46"
      },
      {
        "seq": 5,
        "stationName": "华发首府（4号岗）①",
        "time": "17:47"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "17:49"
      },
      {
        "seq": 7,
        "stationName": "中海名钻(北门)①",
        "time": "17:50"
      },
      {
        "seq": 8,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "18:19"
      },
      {
        "seq": 9,
        "stationName": "澳大/研究生宿舍①",
        "time": "18:25"
      },
      {
        "seq": 10,
        "stationName": "澳大/中央教学楼②",
        "time": "18:27"
      },
      {
        "seq": 11,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "18:39"
      },
      {
        "seq": 12,
        "stationName": "霍英东马路/新濠天地",
        "time": "18:41"
      },
      {
        "seq": 13,
        "stationName": "澳门新濠锋酒店",
        "time": "18:46"
      }
    ]
  },
  {
    "sourceName": "B6线（高校线）-下班",
    "routeNo": "B6",
    "direction": "往横琴",
    "lineFullName": "B6线（高校线）-下班",
    "tripLabel": "下班",
    "tripCode": "B6｜往横琴｜B6线（高校线）-下班",
    "departureTime": "18:55",
    "arrivalTime": "19:48",
    "stopCount": 9,
    "originName": "澳门新濠锋酒店",
    "terminalName": "澳门新街坊",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新濠锋酒店",
        "time": "18:55"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "19:03"
      },
      {
        "seq": 3,
        "stationName": "霍英东马路/新濠天地",
        "time": "19:05"
      },
      {
        "seq": 4,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "19:35"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)②",
        "time": "19:37"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "19:39"
      },
      {
        "seq": 7,
        "stationName": "华发首府（4号岗）②",
        "time": "19:41"
      },
      {
        "seq": 8,
        "stationName": "K2荔枝湾②",
        "time": "19:43"
      },
      {
        "seq": 9,
        "stationName": "澳门新街坊",
        "time": "19:48"
      }
    ]
  },
  {
    "sourceName": "B7线（高校线）-上班",
    "routeNo": "B7",
    "direction": "往澳门",
    "lineFullName": "B7线（高校线）-上班",
    "tripLabel": "上班",
    "tripCode": "B7｜往澳门｜B7线（高校线）-上班",
    "departureTime": "07:40",
    "arrivalTime": "08:45",
    "stopCount": 7,
    "originName": "横琴人才公寓（西门）①",
    "terminalName": "澳门新濠锋酒店",
    "stops": [
      {
        "seq": 1,
        "stationName": "横琴人才公寓（西门）①",
        "time": "07:40"
      },
      {
        "seq": 2,
        "stationName": "国际网球中心（靠石山村公交点）",
        "time": "07:43"
      },
      {
        "seq": 3,
        "stationName": "濠江路口(靠澳大公交点)①",
        "time": "07:45"
      },
      {
        "seq": 4,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "08:15"
      },
      {
        "seq": 5,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "08:25"
      },
      {
        "seq": 6,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "08:35"
      },
      {
        "seq": 7,
        "stationName": "澳门新濠锋酒店",
        "time": "08:45"
      }
    ]
  },
  {
    "sourceName": "B8线（高校线）-早班",
    "routeNo": "B8",
    "direction": "往澳门",
    "lineFullName": "B8线（高校线）-早班",
    "tripLabel": "早班",
    "tripCode": "B8｜往澳门｜B8线（高校线）-早班",
    "departureTime": "07:30",
    "arrivalTime": "08:52",
    "stopCount": 15,
    "originName": "上村村口公交站",
    "terminalName": "银河酒店①",
    "stops": [
      {
        "seq": 1,
        "stationName": "上村村口公交站",
        "time": "07:30"
      },
      {
        "seq": 2,
        "stationName": "澳门新街坊",
        "time": "07:32"
      },
      {
        "seq": 3,
        "stationName": "横琴检察院（往口岸）",
        "time": "07:34"
      },
      {
        "seq": 4,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "07:36"
      },
      {
        "seq": 5,
        "stationName": "华发首府（4号岗）①",
        "time": "07:37"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场(琴政路北侧)",
        "time": "07:38"
      },
      {
        "seq": 7,
        "stationName": "中海名钻(北门)①",
        "time": "07:39"
      },
      {
        "seq": 8,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "08:10"
      },
      {
        "seq": 9,
        "stationName": "澳大/行政楼",
        "time": "08:20"
      },
      {
        "seq": 10,
        "stationName": "澳大/研究生宿舍①",
        "time": "08:28"
      },
      {
        "seq": 11,
        "stationName": "澳大/中央教学楼①",
        "time": "08:29"
      },
      {
        "seq": 12,
        "stationName": "新濠影汇①",
        "time": "08:39"
      },
      {
        "seq": 13,
        "stationName": "澳门威尼斯人",
        "time": "08:44"
      },
      {
        "seq": 14,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "08:47"
      },
      {
        "seq": 15,
        "stationName": "银河酒店①",
        "time": "08:52"
      }
    ]
  },
  {
    "sourceName": "B8线（高校线）-晚班",
    "routeNo": "B8",
    "direction": "往横琴",
    "lineFullName": "B8线（高校线）-晚班",
    "tripLabel": "晚班",
    "tripCode": "B8｜往横琴｜B8线（高校线）-晚班",
    "departureTime": "22:00",
    "arrivalTime": "23:16",
    "stopCount": 18,
    "originName": "澳门科技大学东门（轻轨站）",
    "terminalName": "中医药产业园（IN1下客点）",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门科技大学东门（轻轨站）",
        "time": "22:00"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学-伟龙（西北门）②",
        "time": "22:02"
      },
      {
        "seq": 3,
        "stationName": "澳大/研究生宿舍②",
        "time": "22:14"
      },
      {
        "seq": 4,
        "stationName": "澳大/中央教学楼②",
        "time": "22:15"
      },
      {
        "seq": 5,
        "stationName": "澳大/行政楼",
        "time": "22:18"
      },
      {
        "seq": 6,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "22:42"
      },
      {
        "seq": 7,
        "stationName": "琴政路口②",
        "time": "22:48"
      },
      {
        "seq": 8,
        "stationName": "中海名钻(北门)②",
        "time": "22:49"
      },
      {
        "seq": 9,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "22:50"
      },
      {
        "seq": 10,
        "stationName": "华发首府（4号岗）①",
        "time": "22:52"
      },
      {
        "seq": 11,
        "stationName": "K2荔枝湾②",
        "time": "22:53"
      },
      {
        "seq": 12,
        "stationName": "澳门新街坊",
        "time": "22:56"
      },
      {
        "seq": 13,
        "stationName": "澳门新街坊南",
        "time": "22:58"
      },
      {
        "seq": 14,
        "stationName": "金汇国际广场①",
        "time": "22:59"
      },
      {
        "seq": 15,
        "stationName": "上村村口公交站",
        "time": "23:04"
      },
      {
        "seq": 16,
        "stationName": "桂风道路口（北侧西行）",
        "time": "23:11"
      },
      {
        "seq": 17,
        "stationName": "环岛北路西（科创中心）②",
        "time": "23:15"
      },
      {
        "seq": 18,
        "stationName": "中医药产业园（IN1下客点）",
        "time": "23:16"
      }
    ]
  },
  {
    "sourceName": "B9线（高校线）-上班",
    "routeNo": "B9",
    "direction": "往澳门",
    "lineFullName": "B9线（高校线）-上班",
    "tripLabel": "上班",
    "tripCode": "B9｜往澳门｜B9线（高校线）-上班",
    "departureTime": "07:54",
    "arrivalTime": "09:11",
    "stopCount": 13,
    "originName": "澳门新街坊",
    "terminalName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊",
        "time": "07:54"
      },
      {
        "seq": 2,
        "stationName": "上村",
        "time": "07:55"
      },
      {
        "seq": 3,
        "stationName": "横琴市民中心（往口岸）",
        "time": "07:56"
      },
      {
        "seq": 4,
        "stationName": "下村②",
        "time": "07:57"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "07:59"
      },
      {
        "seq": 6,
        "stationName": "中海名钻(北门)①",
        "time": "08:00"
      },
      {
        "seq": 7,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "08:30"
      },
      {
        "seq": 8,
        "stationName": "澳大/研究生宿舍①",
        "time": "08:40"
      },
      {
        "seq": 9,
        "stationName": "澳大/中央教学楼①",
        "time": "08:43"
      },
      {
        "seq": 10,
        "stationName": "澳大/行政楼",
        "time": "08:47"
      },
      {
        "seq": 11,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "08:59"
      },
      {
        "seq": 12,
        "stationName": "澳门科技大学东门（轻轨站）",
        "time": "09:01"
      },
      {
        "seq": 13,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "09:11"
      }
    ]
  },
  {
    "sourceName": "B9线（高校线）-下班",
    "routeNo": "B9",
    "direction": "往横琴",
    "lineFullName": "B9线（高校线）-下班",
    "tripLabel": "下班",
    "tripCode": "B9｜往横琴｜B9线（高校线）-下班",
    "departureTime": "18:30",
    "arrivalTime": "19:49",
    "stopCount": 13,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "上村",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "18:30"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学南门（新濠天地）②",
        "time": "18:40"
      },
      {
        "seq": 3,
        "stationName": "霍英东马路/新濠天地",
        "time": "18:42"
      },
      {
        "seq": 4,
        "stationName": "澳大/研究生宿舍①",
        "time": "19:00"
      },
      {
        "seq": 5,
        "stationName": "澳大/中央教学楼①",
        "time": "19:02"
      },
      {
        "seq": 6,
        "stationName": "澳大/行政楼",
        "time": "19:05"
      },
      {
        "seq": 7,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "19:35"
      },
      {
        "seq": 8,
        "stationName": "琴政路口②",
        "time": "19:42"
      },
      {
        "seq": 9,
        "stationName": "中海名钻(北门)②",
        "time": "19:43"
      },
      {
        "seq": 10,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "19:44"
      },
      {
        "seq": 11,
        "stationName": "华发首府（4号岗）②",
        "time": "19:45"
      },
      {
        "seq": 12,
        "stationName": "K2荔枝湾②",
        "time": "19:46"
      },
      {
        "seq": 13,
        "stationName": "上村",
        "time": "19:49"
      }
    ]
  },
  {
    "sourceName": "B10线（高校线）-午上班",
    "routeNo": "B10",
    "direction": "往澳门",
    "lineFullName": "B10线（高校线）-午上班",
    "tripLabel": "午上班",
    "tripCode": "B10｜往澳门｜B10线（高校线）-午上班",
    "departureTime": "10:55",
    "arrivalTime": "11:52",
    "stopCount": 9,
    "originName": "澳门新街坊",
    "terminalName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊",
        "time": "10:55"
      },
      {
        "seq": 2,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "10:58"
      },
      {
        "seq": 3,
        "stationName": "华发首府（4号岗）②",
        "time": "11:00"
      },
      {
        "seq": 4,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "11:01"
      },
      {
        "seq": 5,
        "stationName": "琴政路口（往创业谷方向）①",
        "time": "11:03"
      },
      {
        "seq": 6,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "11:28"
      },
      {
        "seq": 7,
        "stationName": "澳门科技大学-轻轨站",
        "time": "11:38"
      },
      {
        "seq": 8,
        "stationName": "澳门科技大学-伟龙（西北门）①",
        "time": "11:42"
      },
      {
        "seq": 9,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "11:52"
      }
    ]
  },
  {
    "sourceName": "B10线（高校线）-午下班",
    "routeNo": "B10",
    "direction": "往横琴",
    "lineFullName": "B10线（高校线）-午下班",
    "tripLabel": "午下班",
    "tripCode": "B10｜往横琴｜B10线（高校线）-午下班",
    "departureTime": "12:10",
    "arrivalTime": "12:55",
    "stopCount": 9,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "澳门新街坊",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "12:10"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学-轻轨站",
        "time": "12:17"
      },
      {
        "seq": 3,
        "stationName": "澳门科技大学-伟龙（西北门）②",
        "time": "12:20"
      },
      {
        "seq": 4,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "12:43"
      },
      {
        "seq": 5,
        "stationName": "琴政路口②",
        "time": "12:46"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "12:47"
      },
      {
        "seq": 7,
        "stationName": "华发首府（4号岗）②",
        "time": "12:48"
      },
      {
        "seq": 8,
        "stationName": "K2荔枝湾②",
        "time": "12:50"
      },
      {
        "seq": 9,
        "stationName": "澳门新街坊",
        "time": "12:55"
      }
    ]
  },
  {
    "sourceName": "B11线（高校线）-夜下班",
    "routeNo": "B11",
    "direction": "往横琴",
    "lineFullName": "B11线（高校线）-夜下班",
    "tripLabel": "夜下班",
    "tripCode": "B11｜往横琴｜B11线（高校线）-夜下班",
    "departureTime": "21:50",
    "arrivalTime": "23:00",
    "stopCount": 14,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "中医药产业园（IN1下客点）",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "21:50"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学-轻轨站",
        "time": "22:00"
      },
      {
        "seq": 3,
        "stationName": "澳门科技大学-伟龙（西北门）①",
        "time": "22:01"
      },
      {
        "seq": 4,
        "stationName": "澳大/研究生宿舍①",
        "time": "22:13"
      },
      {
        "seq": 5,
        "stationName": "澳大/中央教学楼②",
        "time": "22:14"
      },
      {
        "seq": 6,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "22:30"
      },
      {
        "seq": 7,
        "stationName": "中海名钻(北门)②",
        "time": "22:37"
      },
      {
        "seq": 8,
        "stationName": "华发首府（4号岗）②",
        "time": "22:39"
      },
      {
        "seq": 9,
        "stationName": "K2荔枝湾②",
        "time": "22:41"
      },
      {
        "seq": 10,
        "stationName": "澳门新街坊",
        "time": "22:44"
      },
      {
        "seq": 11,
        "stationName": "澳门新街坊南",
        "time": "22:46"
      },
      {
        "seq": 12,
        "stationName": "金汇国际广场①",
        "time": "22:48"
      },
      {
        "seq": 13,
        "stationName": "桂风道路口（北侧西行）",
        "time": "22:55"
      },
      {
        "seq": 14,
        "stationName": "中医药产业园（IN1下客点）",
        "time": "23:00"
      }
    ]
  },
  {
    "sourceName": "B12线（高校线）-夜下班",
    "routeNo": "B12",
    "direction": "往横琴",
    "lineFullName": "B12线（高校线）-夜下班",
    "tripLabel": "夜下班",
    "tripCode": "B12｜往横琴｜B12线（高校线）-夜下班",
    "departureTime": "22:00",
    "arrivalTime": "22:52",
    "stopCount": 9,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "中医药产业园（IN1下客点）",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "22:00"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学-轻轨站",
        "time": "22:07"
      },
      {
        "seq": 3,
        "stationName": "澳门科技大学-伟龙（西北门）①",
        "time": "22:10"
      },
      {
        "seq": 4,
        "stationName": "中海名钻(北门)②",
        "time": "22:34"
      },
      {
        "seq": 5,
        "stationName": "华发首府（4号岗）②",
        "time": "22:36"
      },
      {
        "seq": 6,
        "stationName": "K2荔枝湾②",
        "time": "22:38"
      },
      {
        "seq": 7,
        "stationName": "澳门新街坊",
        "time": "22:42"
      },
      {
        "seq": 8,
        "stationName": "桂风道路口（北侧西行）",
        "time": "22:47"
      },
      {
        "seq": 9,
        "stationName": "中医药产业园（IN1下客点）",
        "time": "22:52"
      }
    ]
  },
  {
    "sourceName": "B13线（高校线）-澳琴上班",
    "routeNo": "B13",
    "direction": "往横琴",
    "lineFullName": "B13线（高校线）-澳琴上班",
    "tripLabel": "澳琴上班",
    "tripCode": "B13｜往横琴｜B13线（高校线）-澳琴上班",
    "departureTime": "08:20",
    "arrivalTime": "09:01",
    "stopCount": 10,
    "originName": "澳大/研究生宿舍①",
    "terminalName": "金汇国际广场①",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳大/研究生宿舍①",
        "time": "08:20"
      },
      {
        "seq": 2,
        "stationName": "澳大/中央教学楼①",
        "time": "08:22"
      },
      {
        "seq": 3,
        "stationName": "澳大/行政楼",
        "time": "08:24"
      },
      {
        "seq": 4,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "08:43"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)②",
        "time": "08:50"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "08:52"
      },
      {
        "seq": 7,
        "stationName": "华发首府（4号岗）②",
        "time": "08:55"
      },
      {
        "seq": 8,
        "stationName": "K2荔枝湾②",
        "time": "08:57"
      },
      {
        "seq": 9,
        "stationName": "澳门新街坊南",
        "time": "09:00"
      },
      {
        "seq": 10,
        "stationName": "金汇国际广场①",
        "time": "09:01"
      }
    ]
  },
  {
    "sourceName": "B13线（高校线）-琴澳午班",
    "routeNo": "B13",
    "direction": "往澳门",
    "lineFullName": "B13线（高校线）-琴澳午班",
    "tripLabel": "琴澳午班",
    "tripCode": "B13｜往澳门｜B13线（高校线）-琴澳午班",
    "departureTime": "13:30",
    "arrivalTime": "14:20",
    "stopCount": 9,
    "originName": "金汇国际广场①",
    "terminalName": "澳大/中央教学楼②",
    "stops": [
      {
        "seq": 1,
        "stationName": "金汇国际广场①",
        "time": "13:30"
      },
      {
        "seq": 2,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "13:31"
      },
      {
        "seq": 3,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "13:37"
      },
      {
        "seq": 4,
        "stationName": "华发首府（4号岗）②",
        "time": "13:39"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "13:40"
      },
      {
        "seq": 6,
        "stationName": "中海名钻(北门)①",
        "time": "13:41"
      },
      {
        "seq": 7,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "14:12"
      },
      {
        "seq": 8,
        "stationName": "澳大/研究生宿舍②",
        "time": "14:18"
      },
      {
        "seq": 9,
        "stationName": "澳大/中央教学楼②",
        "time": "14:20"
      }
    ]
  },
  {
    "sourceName": "B13线（高校线）-澳琴下班",
    "routeNo": "B13",
    "direction": "往横琴",
    "lineFullName": "B13线（高校线）-澳琴下班",
    "tripLabel": "澳琴下班",
    "tripCode": "B13｜往横琴｜B13线（高校线）-澳琴下班",
    "departureTime": "18:00",
    "arrivalTime": "18:41",
    "stopCount": 10,
    "originName": "澳大/研究生宿舍①",
    "terminalName": "金汇国际广场①",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳大/研究生宿舍①",
        "time": "18:00"
      },
      {
        "seq": 2,
        "stationName": "澳大/中央教学楼①",
        "time": "18:02"
      },
      {
        "seq": 3,
        "stationName": "澳大/行政楼",
        "time": "18:04"
      },
      {
        "seq": 4,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "18:23"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)②",
        "time": "18:30"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场(琴政路北侧)",
        "time": "18:32"
      },
      {
        "seq": 7,
        "stationName": "华发首府（4号岗）②",
        "time": "18:35"
      },
      {
        "seq": 8,
        "stationName": "K2荔枝湾②",
        "time": "18:37"
      },
      {
        "seq": 9,
        "stationName": "澳门新街坊南",
        "time": "18:40"
      },
      {
        "seq": 10,
        "stationName": "金汇国际广场①",
        "time": "18:41"
      }
    ]
  },
  {
    "sourceName": "B14线（高校线）-琴澳上班",
    "routeNo": "B14",
    "direction": "往澳门",
    "lineFullName": "B14线（高校线）-琴澳上班",
    "tripLabel": "琴澳上班",
    "tripCode": "B14｜往澳门｜B14线（高校线）-琴澳上班",
    "departureTime": "09:00",
    "arrivalTime": "10:04",
    "stopCount": 10,
    "originName": "金汇国际广场①",
    "terminalName": "澳门科技大学南门（新濠天地）②",
    "stops": [
      {
        "seq": 1,
        "stationName": "金汇国际广场①",
        "time": "09:00"
      },
      {
        "seq": 2,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "09:01"
      },
      {
        "seq": 3,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "09:07"
      },
      {
        "seq": 4,
        "stationName": "华发首府（4号岗）②",
        "time": "09:09"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "09:10"
      },
      {
        "seq": 6,
        "stationName": "中海名钻(北门)①",
        "time": "09:11"
      },
      {
        "seq": 7,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "09:42"
      },
      {
        "seq": 8,
        "stationName": "澳大/研究生宿舍①",
        "time": "09:48"
      },
      {
        "seq": 9,
        "stationName": "澳大/中央教学楼①",
        "time": "09:50"
      },
      {
        "seq": 10,
        "stationName": "澳门科技大学南门（新濠天地）②",
        "time": "10:04"
      }
    ]
  },
  {
    "sourceName": "B14线（高校线）-澳琴午班",
    "routeNo": "B14",
    "direction": "往横琴",
    "lineFullName": "B14线（高校线）-澳琴午班",
    "tripLabel": "澳琴午班",
    "tripCode": "B14｜往横琴｜B14线（高校线）-澳琴午班",
    "departureTime": "13:20",
    "arrivalTime": "14:15",
    "stopCount": 12,
    "originName": "澳门科技大学南门（新濠天地）②",
    "terminalName": "金汇国际广场①",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门科技大学南门（新濠天地）②",
        "time": "13:20"
      },
      {
        "seq": 2,
        "stationName": "澳大/研究生宿舍②",
        "time": "13:31"
      },
      {
        "seq": 3,
        "stationName": "澳大/中央教学楼①",
        "time": "13:33"
      },
      {
        "seq": 4,
        "stationName": "澳大/行政楼",
        "time": "13:35"
      },
      {
        "seq": 5,
        "stationName": "南迎客平台（南二门）",
        "time": "13:54"
      },
      {
        "seq": 6,
        "stationName": "中海名钻(北门)②",
        "time": "14:01"
      },
      {
        "seq": 7,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "14:03"
      },
      {
        "seq": 8,
        "stationName": "华发首府（4号岗）①",
        "time": "14:04"
      },
      {
        "seq": 9,
        "stationName": "K2荔枝湾②",
        "time": "14:08"
      },
      {
        "seq": 10,
        "stationName": "澳门新街坊",
        "time": "14:11"
      },
      {
        "seq": 11,
        "stationName": "澳门新街坊南",
        "time": "14:13"
      },
      {
        "seq": 12,
        "stationName": "金汇国际广场①",
        "time": "14:15"
      }
    ]
  },
  {
    "sourceName": "B14线（高校线）-琴澳下班",
    "routeNo": "B14",
    "direction": "往澳门",
    "lineFullName": "B14线（高校线）-琴澳下班",
    "tripLabel": "琴澳下班",
    "tripCode": "B14｜往澳门｜B14线（高校线）-琴澳下班",
    "departureTime": "18:05",
    "arrivalTime": "19:11",
    "stopCount": 11,
    "originName": "金汇国际广场①",
    "terminalName": "澳门科技大学南门（新濠天地）②",
    "stops": [
      {
        "seq": 1,
        "stationName": "金汇国际广场①",
        "time": "18:05"
      },
      {
        "seq": 2,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "18:06"
      },
      {
        "seq": 3,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "18:12"
      },
      {
        "seq": 4,
        "stationName": "华发首府（4号岗）②",
        "time": "18:14"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "18:15"
      },
      {
        "seq": 6,
        "stationName": "中海名钻(北门)①",
        "time": "18:16"
      },
      {
        "seq": 7,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "18:41"
      },
      {
        "seq": 8,
        "stationName": "澳大/研究生宿舍①",
        "time": "18:53"
      },
      {
        "seq": 9,
        "stationName": "澳大/中央教学楼①",
        "time": "18:55"
      },
      {
        "seq": 10,
        "stationName": "澳大/行政楼",
        "time": "18:57"
      },
      {
        "seq": 11,
        "stationName": "澳门科技大学南门（新濠天地）②",
        "time": "19:11"
      }
    ]
  },
  {
    "sourceName": "B15线（高校线）-琴澳午班",
    "routeNo": "B15",
    "direction": "往澳门",
    "lineFullName": "B15线（高校线）-琴澳午班",
    "tripLabel": "琴澳午班",
    "tripCode": "B15｜往澳门｜B15线（高校线）-琴澳午班",
    "departureTime": "13:15",
    "arrivalTime": "14:13",
    "stopCount": 8,
    "originName": "澳门新街坊南（往口岸）",
    "terminalName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "13:15"
      },
      {
        "seq": 2,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "13:18"
      },
      {
        "seq": 3,
        "stationName": "华发首府（4号岗）①",
        "time": "13:20"
      },
      {
        "seq": 4,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "13:22"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)①",
        "time": "13:24"
      },
      {
        "seq": 6,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "13:49"
      },
      {
        "seq": 7,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "14:00"
      },
      {
        "seq": 8,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "14:13"
      }
    ]
  },
  {
    "sourceName": "B15线（高校线）-澳琴下班",
    "routeNo": "B15",
    "direction": "往横琴",
    "lineFullName": "B15线（高校线）-澳琴下班",
    "tripLabel": "澳琴下班",
    "tripCode": "B15｜往横琴｜B15线（高校线）-澳琴下班",
    "departureTime": "18:00",
    "arrivalTime": "19:00",
    "stopCount": 8,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "澳门新街坊南",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "18:00"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "18:11"
      },
      {
        "seq": 3,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "18:36"
      },
      {
        "seq": 4,
        "stationName": "中海名钻(北门)②",
        "time": "18:48"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "18:52"
      },
      {
        "seq": 6,
        "stationName": "华发首府（4号岗）①",
        "time": "18:54"
      },
      {
        "seq": 7,
        "stationName": "K2荔枝湾②",
        "time": "18:56"
      },
      {
        "seq": 8,
        "stationName": "澳门新街坊南",
        "time": "19:00"
      }
    ]
  },
  {
    "sourceName": "B15线（高校线）-澳琴晚班",
    "routeNo": "B15",
    "direction": "往横琴",
    "lineFullName": "B15线（高校线）-澳琴晚班",
    "tripLabel": "澳琴晚班",
    "tripCode": "B15｜往横琴｜B15线（高校线）-澳琴晚班",
    "departureTime": "21:50",
    "arrivalTime": "23:06",
    "stopCount": 15,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "百合路口(公交站)",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "21:50"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学-轻轨站",
        "time": "22:00"
      },
      {
        "seq": 3,
        "stationName": "澳门科技大学-伟龙（西北门）①",
        "time": "22:01"
      },
      {
        "seq": 4,
        "stationName": "澳大/研究生宿舍①",
        "time": "22:13"
      },
      {
        "seq": 5,
        "stationName": "澳大/中央教学楼①",
        "time": "22:14"
      },
      {
        "seq": 6,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "22:30"
      },
      {
        "seq": 7,
        "stationName": "中海名钻(北门)②",
        "time": "22:37"
      },
      {
        "seq": 8,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "22:39"
      },
      {
        "seq": 9,
        "stationName": "华发首府（4号岗）②",
        "time": "22:41"
      },
      {
        "seq": 10,
        "stationName": "K2荔枝湾②",
        "time": "22:44"
      },
      {
        "seq": 11,
        "stationName": "澳门新街坊",
        "time": "22:46"
      },
      {
        "seq": 12,
        "stationName": "澳门新街坊南",
        "time": "22:48"
      },
      {
        "seq": 13,
        "stationName": "金汇国际广场①",
        "time": "22:50"
      },
      {
        "seq": 14,
        "stationName": "中医药产业园（IN1下客点）",
        "time": "23:00"
      },
      {
        "seq": 15,
        "stationName": "百合路口(公交站)",
        "time": "23:06"
      }
    ]
  },
  {
    "sourceName": "B16线（高校线）-琴澳上班",
    "routeNo": "B16",
    "direction": "往澳门",
    "lineFullName": "B16线（高校线）-琴澳上班",
    "tripLabel": "琴澳上班",
    "tripCode": "B16｜往澳门｜B16线（高校线）-琴澳上班",
    "departureTime": "08:00",
    "arrivalTime": "08:57",
    "stopCount": 8,
    "originName": "澳门新街坊南（往口岸）",
    "terminalName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "08:00"
      },
      {
        "seq": 2,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "08:03"
      },
      {
        "seq": 3,
        "stationName": "华发首府（4号岗）①",
        "time": "08:04"
      },
      {
        "seq": 4,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "08:05"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)①",
        "time": "08:06"
      },
      {
        "seq": 6,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "08:31"
      },
      {
        "seq": 7,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "08:46"
      },
      {
        "seq": 8,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "08:57"
      }
    ]
  },
  {
    "sourceName": "B16线（高校线）-澳琴午班",
    "routeNo": "B16",
    "direction": "往横琴",
    "lineFullName": "B16线（高校线）-澳琴午班",
    "tripLabel": "澳琴午班",
    "tripCode": "B16｜往横琴｜B16线（高校线）-澳琴午班",
    "departureTime": "13:00",
    "arrivalTime": "14:00",
    "stopCount": 8,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "澳门新街坊南",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "13:00"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "13:11"
      },
      {
        "seq": 3,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "13:36"
      },
      {
        "seq": 4,
        "stationName": "中海名钻(北门)②",
        "time": "13:52"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "13:54"
      },
      {
        "seq": 6,
        "stationName": "华发首府（4号岗）①",
        "time": "13:56"
      },
      {
        "seq": 7,
        "stationName": "K2荔枝湾②",
        "time": "13:58"
      },
      {
        "seq": 8,
        "stationName": "澳门新街坊南",
        "time": "14:00"
      }
    ]
  },
  {
    "sourceName": "B16线（高校线）-琴澳下班",
    "routeNo": "B16",
    "direction": "往澳门",
    "lineFullName": "B16线（高校线）-琴澳下班",
    "tripLabel": "琴澳下班",
    "tripCode": "B16｜往澳门｜B16线（高校线）-琴澳下班",
    "departureTime": "18:00",
    "arrivalTime": "19:00",
    "stopCount": 8,
    "originName": "澳门新街坊南（往口岸）",
    "terminalName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "18:00"
      },
      {
        "seq": 2,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "18:02"
      },
      {
        "seq": 3,
        "stationName": "华发首府（4号岗）②",
        "time": "18:04"
      },
      {
        "seq": 4,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "18:06"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)①",
        "time": "18:08"
      },
      {
        "seq": 6,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "18:33"
      },
      {
        "seq": 7,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "18:49"
      },
      {
        "seq": 8,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "19:00"
      }
    ]
  },
  {
    "sourceName": "B16线（高校线）-澳琴晚班",
    "routeNo": "B16",
    "direction": "往横琴",
    "lineFullName": "B16线（高校线）-澳琴晚班",
    "tripLabel": "澳琴晚班",
    "tripCode": "B16｜往横琴｜B16线（高校线）-澳琴晚班",
    "departureTime": "22:15",
    "arrivalTime": "23:17",
    "stopCount": 8,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "澳门新街坊南",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "22:15"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "22:26"
      },
      {
        "seq": 3,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "22:51"
      },
      {
        "seq": 4,
        "stationName": "中海名钻(北门)②",
        "time": "23:08"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "23:10"
      },
      {
        "seq": 6,
        "stationName": "华发首府（4号岗）②",
        "time": "23:12"
      },
      {
        "seq": 7,
        "stationName": "K2荔枝湾②",
        "time": "23:14"
      },
      {
        "seq": 8,
        "stationName": "澳门新街坊南",
        "time": "23:17"
      }
    ]
  },
  {
    "sourceName": "B17线（高校线）-琴澳午上班",
    "routeNo": "B17",
    "direction": "往澳门",
    "lineFullName": "B17线（高校线）-琴澳午上班",
    "tripLabel": "琴澳午上班",
    "tripCode": "B17｜往澳门｜B17线（高校线）-琴澳午上班",
    "departureTime": "13:00",
    "arrivalTime": "14:00",
    "stopCount": 8,
    "originName": "澳门新街坊南（往口岸）",
    "terminalName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "13:00"
      },
      {
        "seq": 2,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "13:02"
      },
      {
        "seq": 3,
        "stationName": "华发首府（4号岗）②",
        "time": "13:03"
      },
      {
        "seq": 4,
        "stationName": "保利国际广场(琴政路北侧)",
        "time": "13:04"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)①",
        "time": "13:05"
      },
      {
        "seq": 6,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "13:31"
      },
      {
        "seq": 7,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "13:49"
      },
      {
        "seq": 8,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "14:00"
      }
    ]
  },
  {
    "sourceName": "B17线（高校线）-澳琴午下班",
    "routeNo": "B17",
    "direction": "往横琴",
    "lineFullName": "B17线（高校线）-澳琴午下班",
    "tripLabel": "澳琴午下班",
    "tripCode": "B17｜往横琴｜B17线（高校线）-澳琴午下班",
    "departureTime": "13:15",
    "arrivalTime": "14:13",
    "stopCount": 8,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "澳门新街坊南",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "13:15"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "13:26"
      },
      {
        "seq": 3,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "13:52"
      },
      {
        "seq": 4,
        "stationName": "中海名钻(北门)②",
        "time": "14:02"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "14:03"
      },
      {
        "seq": 6,
        "stationName": "华发首府（4号岗）②",
        "time": "14:04"
      },
      {
        "seq": 7,
        "stationName": "K2荔枝湾②",
        "time": "14:05"
      },
      {
        "seq": 8,
        "stationName": "澳门新街坊南",
        "time": "14:13"
      }
    ]
  },
  {
    "sourceName": "B17线（高校线）-琴澳晚上班",
    "routeNo": "B17",
    "direction": "往澳门",
    "lineFullName": "B17线（高校线）-琴澳晚上班",
    "tripLabel": "琴澳晚上班",
    "tripCode": "B17｜往澳门｜B17线（高校线）-琴澳晚上班",
    "departureTime": "17:50",
    "arrivalTime": "18:49",
    "stopCount": 8,
    "originName": "澳门新街坊南（往口岸）",
    "terminalName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "17:50"
      },
      {
        "seq": 2,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "17:52"
      },
      {
        "seq": 3,
        "stationName": "华发首府（4号岗）②",
        "time": "17:53"
      },
      {
        "seq": 4,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "17:54"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)①",
        "time": "17:55"
      },
      {
        "seq": 6,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "18:20"
      },
      {
        "seq": 7,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "18:39"
      },
      {
        "seq": 8,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "18:49"
      }
    ]
  },
  {
    "sourceName": "B17线（高校线）-澳琴晚下班",
    "routeNo": "B17",
    "direction": "往横琴",
    "lineFullName": "B17线（高校线）-澳琴晚下班",
    "tripLabel": "澳琴晚下班",
    "tripCode": "B17｜往横琴｜B17线（高校线）-澳琴晚下班",
    "departureTime": "17:45",
    "arrivalTime": "18:37",
    "stopCount": 8,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "澳门新街坊南",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "17:45"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "17:53"
      },
      {
        "seq": 3,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "18:19"
      },
      {
        "seq": 4,
        "stationName": "中海名钻(北门)②",
        "time": "18:29"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "18:30"
      },
      {
        "seq": 6,
        "stationName": "华发首府（4号岗）①",
        "time": "18:31"
      },
      {
        "seq": 7,
        "stationName": "K2荔枝湾②",
        "time": "18:32"
      },
      {
        "seq": 8,
        "stationName": "澳门新街坊南",
        "time": "18:37"
      }
    ]
  },
  {
    "sourceName": "B18线（高校线）-琴澳上班",
    "routeNo": "B18",
    "direction": "往澳门",
    "lineFullName": "B18线（高校线）-琴澳上班",
    "tripLabel": "琴澳上班",
    "tripCode": "B18｜往澳门｜B18线（高校线）-琴澳上班",
    "departureTime": "10:45",
    "arrivalTime": "12:00",
    "stopCount": 8,
    "originName": "澳门新街坊南（往口岸）",
    "terminalName": "观音古庙门口（澳旅大望厦校区）",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "10:45"
      },
      {
        "seq": 2,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "10:48"
      },
      {
        "seq": 3,
        "stationName": "华发首府（4号岗）②",
        "time": "10:49"
      },
      {
        "seq": 4,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "10:50"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)①",
        "time": "10:51"
      },
      {
        "seq": 6,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "11:17"
      },
      {
        "seq": 7,
        "stationName": "澳门理工大学主校区(理工学院街）",
        "time": "11:45"
      },
      {
        "seq": 8,
        "stationName": "观音古庙门口（澳旅大望厦校区）",
        "time": "12:00"
      }
    ]
  },
  {
    "sourceName": "B18线（高校线）-澳琴午班",
    "routeNo": "B18",
    "direction": "往横琴",
    "lineFullName": "B18线（高校线）-澳琴午班",
    "tripLabel": "澳琴午班",
    "tripCode": "B18｜往横琴｜B18线（高校线）-澳琴午班",
    "departureTime": "13:15",
    "arrivalTime": "14:30",
    "stopCount": 8,
    "originName": "观音古庙门口（澳旅大望厦校区）",
    "terminalName": "澳门新街坊南",
    "stops": [
      {
        "seq": 1,
        "stationName": "观音古庙门口（澳旅大望厦校区）",
        "time": "13:15"
      },
      {
        "seq": 2,
        "stationName": "澳门理工大学主校区(理工学院街）",
        "time": "13:30"
      },
      {
        "seq": 3,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "14:05"
      },
      {
        "seq": 4,
        "stationName": "中海名钻(北门)②",
        "time": "14:22"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "14:23"
      },
      {
        "seq": 6,
        "stationName": "华发首府（4号岗）②",
        "time": "14:24"
      },
      {
        "seq": 7,
        "stationName": "K2荔枝湾②",
        "time": "14:25"
      },
      {
        "seq": 8,
        "stationName": "澳门新街坊南",
        "time": "14:30"
      }
    ]
  },
  {
    "sourceName": "B19线（高校线）-澳琴下班",
    "routeNo": "B19",
    "direction": "往横琴",
    "lineFullName": "B19线（高校线）-澳琴下班",
    "tripLabel": "澳琴下班",
    "tripCode": "B19｜往横琴｜B19线（高校线）-澳琴下班",
    "departureTime": "18:00",
    "arrivalTime": "18:59",
    "stopCount": 8,
    "originName": "澳门理工大学主校区(理工学院街）",
    "terminalName": "澳门新街坊南",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门理工大学主校区(理工学院街）",
        "time": "18:00"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学-伟龙（西北门）①",
        "time": "18:13"
      },
      {
        "seq": 3,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "18:38"
      },
      {
        "seq": 4,
        "stationName": "中海名钻(北门)②",
        "time": "18:51"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "18:53"
      },
      {
        "seq": 6,
        "stationName": "华发首府（4号岗）①",
        "time": "18:55"
      },
      {
        "seq": 7,
        "stationName": "K2荔枝湾②",
        "time": "18:57"
      },
      {
        "seq": 8,
        "stationName": "澳门新街坊南",
        "time": "18:59"
      }
    ]
  },
  {
    "sourceName": "B19线（高校线）-琴澳午班",
    "routeNo": "B19",
    "direction": "往澳门",
    "lineFullName": "B19线（高校线）-琴澳午班",
    "tripLabel": "琴澳午班",
    "tripCode": "B19｜往澳门｜B19线（高校线）-琴澳午班",
    "departureTime": "13:15",
    "arrivalTime": "14:20",
    "stopCount": 8,
    "originName": "澳门新街坊南（往口岸）",
    "terminalName": "澳门理工大学主校区(理工学院街）",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "13:15"
      },
      {
        "seq": 2,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "13:17"
      },
      {
        "seq": 3,
        "stationName": "华发首府（4号岗）①",
        "time": "13:19"
      },
      {
        "seq": 4,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "13:21"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)①",
        "time": "13:23"
      },
      {
        "seq": 6,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "13:48"
      },
      {
        "seq": 7,
        "stationName": "澳门科技大学-伟龙（西北门）①",
        "time": "14:00"
      },
      {
        "seq": 8,
        "stationName": "澳门理工大学主校区(理工学院街）",
        "time": "14:20"
      }
    ]
  },
  {
    "sourceName": "B20线（高校线）-澳琴上班",
    "routeNo": "B20",
    "direction": "往横琴",
    "lineFullName": "B20线（高校线）-澳琴上班",
    "tripLabel": "澳琴上班",
    "tripCode": "B20｜往横琴｜B20线（高校线）-澳琴上班",
    "departureTime": "08:50",
    "arrivalTime": "09:51",
    "stopCount": 8,
    "originName": "澳门理工大学主校区(理工学院街）",
    "terminalName": "澳门新街坊南",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门理工大学主校区(理工学院街）",
        "time": "08:50"
      },
      {
        "seq": 2,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "09:04"
      },
      {
        "seq": 3,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "09:33"
      },
      {
        "seq": 4,
        "stationName": "中海名钻(北门)②",
        "time": "09:43"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "09:44"
      },
      {
        "seq": 6,
        "stationName": "华发首府（4号岗）①",
        "time": "09:45"
      },
      {
        "seq": 7,
        "stationName": "K2荔枝湾②",
        "time": "09:46"
      },
      {
        "seq": 8,
        "stationName": "澳门新街坊南",
        "time": "09:51"
      }
    ]
  },
  {
    "sourceName": "B21线（高校线）-琴澳上班",
    "routeNo": "B21",
    "direction": "往澳门",
    "lineFullName": "B21线（高校线）-琴澳上班",
    "tripLabel": "琴澳上班",
    "tripCode": "B21｜往澳门｜B21线（高校线）-琴澳上班",
    "departureTime": "08:54",
    "arrivalTime": "10:04",
    "stopCount": 11,
    "originName": "开新三道南站（公交站）",
    "terminalName": "澳门科技大学南门（新濠天地）②",
    "stops": [
      {
        "seq": 1,
        "stationName": "开新三道南站（公交站）",
        "time": "08:54"
      },
      {
        "seq": 2,
        "stationName": "金汇国际广场①",
        "time": "09:00"
      },
      {
        "seq": 3,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "09:01"
      },
      {
        "seq": 4,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "09:07"
      },
      {
        "seq": 5,
        "stationName": "华发首府（4号岗）②",
        "time": "09:09"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "09:10"
      },
      {
        "seq": 7,
        "stationName": "中海名钻(北门)①",
        "time": "09:11"
      },
      {
        "seq": 8,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "09:42"
      },
      {
        "seq": 9,
        "stationName": "澳大/研究生宿舍①",
        "time": "09:48"
      },
      {
        "seq": 10,
        "stationName": "澳大/中央教学楼①",
        "time": "09:50"
      },
      {
        "seq": 11,
        "stationName": "澳门科技大学南门（新濠天地）②",
        "time": "10:04"
      }
    ]
  },
  {
    "sourceName": "B21线（高校线）-澳琴下班",
    "routeNo": "B21",
    "direction": "往横琴",
    "lineFullName": "B21线（高校线）-澳琴下班",
    "tripLabel": "澳琴下班",
    "tripCode": "B21｜往横琴｜B21线（高校线）-澳琴下班",
    "departureTime": "18:00",
    "arrivalTime": "19:14",
    "stopCount": 10,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "中医药产业园（IN1下客点）",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "18:00"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学南门（新濠天地）②",
        "time": "18:11"
      },
      {
        "seq": 3,
        "stationName": "南迎客平台（南二门）",
        "time": "18:36"
      },
      {
        "seq": 4,
        "stationName": "中海名钻(北门)②",
        "time": "18:48"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "18:52"
      },
      {
        "seq": 6,
        "stationName": "华发首府（4号岗）①",
        "time": "18:54"
      },
      {
        "seq": 7,
        "stationName": "K2荔枝湾②",
        "time": "18:56"
      },
      {
        "seq": 8,
        "stationName": "澳门新街坊南",
        "time": "19:00"
      },
      {
        "seq": 9,
        "stationName": "环岛北路西（科创中心）②",
        "time": "19:12"
      },
      {
        "seq": 10,
        "stationName": "中医药产业园（IN1下客点）",
        "time": "19:14"
      }
    ]
  },
  {
    "sourceName": "B21线（高校线）-澳琴晚班",
    "routeNo": "B21",
    "direction": "往横琴",
    "lineFullName": "B21线（高校线）-澳琴晚班",
    "tripLabel": "澳琴晚班",
    "tripCode": "B21｜往横琴｜B21线（高校线）-澳琴晚班",
    "departureTime": "21:55",
    "arrivalTime": "22:49",
    "stopCount": 10,
    "originName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "terminalName": "中医药产业园（IN1下客点）",
    "stops": [
      {
        "seq": 1,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "21:55"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学南门（新濠天地）②",
        "time": "22:03"
      },
      {
        "seq": 3,
        "stationName": "南迎客平台（南二门）",
        "time": "22:20"
      },
      {
        "seq": 4,
        "stationName": "中海名钻(北门)②",
        "time": "22:27"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "22:28"
      },
      {
        "seq": 6,
        "stationName": "华发首府（4号岗）②",
        "time": "22:29"
      },
      {
        "seq": 7,
        "stationName": "K2荔枝湾②",
        "time": "22:32"
      },
      {
        "seq": 8,
        "stationName": "澳门新街坊",
        "time": "22:37"
      },
      {
        "seq": 9,
        "stationName": "环岛北路西（科创中心）②",
        "time": "22:47"
      },
      {
        "seq": 10,
        "stationName": "中医药产业园（IN1下客点）",
        "time": "22:49"
      }
    ]
  },
  {
    "sourceName": "C1线-上班",
    "routeNo": "C1",
    "direction": "往澳门",
    "lineFullName": "C1线-上班",
    "tripLabel": "上班",
    "tripCode": "C1｜往澳门｜C1线-上班",
    "departureTime": "17:43",
    "arrivalTime": "18:35",
    "stopCount": 14,
    "originName": "上村村口公交站",
    "terminalName": "银河酒店",
    "stops": [
      {
        "seq": 1,
        "stationName": "上村村口公交站",
        "time": "17:43"
      },
      {
        "seq": 2,
        "stationName": "澳门新街坊",
        "time": "17:45"
      },
      {
        "seq": 3,
        "stationName": "金汇国际广场①",
        "time": "17:46"
      },
      {
        "seq": 4,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "17:48"
      },
      {
        "seq": 5,
        "stationName": "横琴检察院（往口岸）",
        "time": "17:49"
      },
      {
        "seq": 6,
        "stationName": "下村②",
        "time": "17:51"
      },
      {
        "seq": 7,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "17:53"
      },
      {
        "seq": 8,
        "stationName": "中海名钻(北门)①",
        "time": "17:55"
      },
      {
        "seq": 9,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "18:14"
      },
      {
        "seq": 10,
        "stationName": "澳大/研究生宿舍①",
        "time": "18:20"
      },
      {
        "seq": 11,
        "stationName": "澳大/中央教学楼①",
        "time": "18:22"
      },
      {
        "seq": 12,
        "stationName": "新濠影汇①",
        "time": "18:29"
      },
      {
        "seq": 13,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "18:32"
      },
      {
        "seq": 14,
        "stationName": "银河酒店",
        "time": "18:35"
      }
    ]
  },
  {
    "sourceName": "C1线-下班",
    "routeNo": "C1",
    "direction": "往横琴",
    "lineFullName": "C1线-下班",
    "tripLabel": "下班",
    "tripCode": "C1｜往横琴｜C1线-下班",
    "departureTime": "18:40",
    "arrivalTime": "19:39",
    "stopCount": 9,
    "originName": "银河酒店",
    "terminalName": "上村村口公交站",
    "stops": [
      {
        "seq": 1,
        "stationName": "银河酒店",
        "time": "18:40"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学南门（新濠天地）②",
        "time": "18:50"
      },
      {
        "seq": 3,
        "stationName": "新濠影汇②",
        "time": "18:55"
      },
      {
        "seq": 4,
        "stationName": "南迎客平台（南二门）",
        "time": "19:20"
      },
      {
        "seq": 5,
        "stationName": "琴朗路口",
        "time": "19:28"
      },
      {
        "seq": 6,
        "stationName": "下村①",
        "time": "19:30"
      },
      {
        "seq": 7,
        "stationName": "横琴检察院（法院侧）",
        "time": "19:33"
      },
      {
        "seq": 8,
        "stationName": "澳门新街坊",
        "time": "19:34"
      },
      {
        "seq": 9,
        "stationName": "上村村口公交站",
        "time": "19:39"
      }
    ]
  },
  {
    "sourceName": "C2线-上班",
    "routeNo": "C2",
    "direction": "往澳门",
    "lineFullName": "C2线-上班",
    "tripLabel": "上班",
    "tripCode": "C2｜往澳门｜C2线-上班",
    "departureTime": "07:30",
    "arrivalTime": "08:45",
    "stopCount": 9,
    "originName": "百合路口(公交站)",
    "terminalName": "友谊马路/海景花园",
    "stops": [
      {
        "seq": 1,
        "stationName": "百合路口(公交站)",
        "time": "07:30"
      },
      {
        "seq": 2,
        "stationName": "向阳东(公交站)",
        "time": "07:41"
      },
      {
        "seq": 3,
        "stationName": "上村村口公交站",
        "time": "07:51"
      },
      {
        "seq": 4,
        "stationName": "下村②",
        "time": "07:56"
      },
      {
        "seq": 5,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "08:21"
      },
      {
        "seq": 6,
        "stationName": "新濠影汇①",
        "time": "08:31"
      },
      {
        "seq": 7,
        "stationName": "连贯公路/威尼斯人(公交站）",
        "time": "08:34"
      },
      {
        "seq": 8,
        "stationName": "澳门新葡京酒店",
        "time": "08:39"
      },
      {
        "seq": 9,
        "stationName": "友谊马路/海景花园",
        "time": "08:45"
      }
    ]
  },
  {
    "sourceName": "C3线-上班",
    "routeNo": "C3",
    "direction": "往澳门",
    "lineFullName": "C3线-上班",
    "tripLabel": "上班",
    "tripCode": "C3｜往澳门｜C3线-上班",
    "departureTime": "17:40",
    "arrivalTime": "18:48",
    "stopCount": 9,
    "originName": "中医药产业园内",
    "terminalName": "澳门新葡京酒店",
    "stops": [
      {
        "seq": 1,
        "stationName": "中医药产业园内",
        "time": "17:40"
      },
      {
        "seq": 2,
        "stationName": "桂风道路口（南侧东行）",
        "time": "17:46"
      },
      {
        "seq": 3,
        "stationName": "横琴金融岛",
        "time": "17:54"
      },
      {
        "seq": 4,
        "stationName": "十字门大道①",
        "time": "17:58"
      },
      {
        "seq": 5,
        "stationName": "横琴国际商务中心②",
        "time": "18:00"
      },
      {
        "seq": 6,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "18:25"
      },
      {
        "seq": 7,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "18:31"
      },
      {
        "seq": 8,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "18:33"
      },
      {
        "seq": 9,
        "stationName": "澳门新葡京酒店",
        "time": "18:48"
      }
    ]
  },
  {
    "sourceName": "C3线-下班",
    "routeNo": "C3",
    "direction": "往横琴",
    "lineFullName": "C3线-下班",
    "tripLabel": "下班",
    "tripCode": "C3｜往横琴｜C3线-下班",
    "departureTime": "18:50",
    "arrivalTime": "19:45",
    "stopCount": 8,
    "originName": "澳门新葡京酒店",
    "terminalName": "百合路口(公交站)",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新葡京酒店",
        "time": "18:50"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "18:55"
      },
      {
        "seq": 3,
        "stationName": "威尼斯人（公交站）",
        "time": "18:57"
      },
      {
        "seq": 4,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "19:18"
      },
      {
        "seq": 5,
        "stationName": "横琴国际商务中心(靠ICC)②",
        "time": "19:25"
      },
      {
        "seq": 6,
        "stationName": "十字门大道②（往IFC方向）",
        "time": "19:28"
      },
      {
        "seq": 7,
        "stationName": "汇通五路（横琴北）",
        "time": "19:32"
      },
      {
        "seq": 8,
        "stationName": "百合路口(公交站)",
        "time": "19:45"
      }
    ]
  },
  {
    "sourceName": "C4线早班-上班",
    "routeNo": "C4",
    "direction": "往澳门",
    "lineFullName": "C4线早班-上班",
    "tripLabel": "上班",
    "tripCode": "C4｜往澳门｜C4线早班-上班",
    "departureTime": "07:43",
    "arrivalTime": "08:30",
    "stopCount": 10,
    "originName": "上村村口公交站",
    "terminalName": "银河酒店①",
    "stops": [
      {
        "seq": 1,
        "stationName": "上村村口公交站",
        "time": "07:43"
      },
      {
        "seq": 2,
        "stationName": "澳门新街坊",
        "time": "07:45"
      },
      {
        "seq": 3,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "07:47"
      },
      {
        "seq": 4,
        "stationName": "华发首府（4号岗）②",
        "time": "07:48"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场(琴政路南侧)",
        "time": "07:49"
      },
      {
        "seq": 6,
        "stationName": "中海名钻(北门)①",
        "time": "07:50"
      },
      {
        "seq": 7,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "08:15"
      },
      {
        "seq": 8,
        "stationName": "新濠影汇①",
        "time": "08:18"
      },
      {
        "seq": 9,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "08:23"
      },
      {
        "seq": 10,
        "stationName": "银河酒店①",
        "time": "08:30"
      }
    ]
  },
  {
    "sourceName": "C4线晚班-下班",
    "routeNo": "C4",
    "direction": "往横琴",
    "lineFullName": "C4线晚班-下班",
    "tripLabel": "下班",
    "tripCode": "C4｜往横琴｜C4线晚班-下班",
    "departureTime": "18:30",
    "arrivalTime": "19:24",
    "stopCount": 9,
    "originName": "银河酒店",
    "terminalName": "上村村口公交站",
    "stops": [
      {
        "seq": 1,
        "stationName": "银河酒店",
        "time": "18:30"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "18:36"
      },
      {
        "seq": 3,
        "stationName": "新濠影汇②",
        "time": "18:42"
      },
      {
        "seq": 4,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "19:07"
      },
      {
        "seq": 5,
        "stationName": "琴朗路口",
        "time": "19:17"
      },
      {
        "seq": 6,
        "stationName": "下村①",
        "time": "19:18"
      },
      {
        "seq": 7,
        "stationName": "横琴检察院（往颂琴方向）",
        "time": "19:20"
      },
      {
        "seq": 8,
        "stationName": "澳门新街坊",
        "time": "19:21"
      },
      {
        "seq": 9,
        "stationName": "上村村口公交站",
        "time": "19:24"
      }
    ]
  },
  {
    "sourceName": "C4线中班-上班",
    "routeNo": "C4",
    "direction": "往澳门",
    "lineFullName": "C4线中班-上班",
    "tripLabel": "上班",
    "tripCode": "C4｜往澳门｜C4线中班-上班",
    "departureTime": "13:50",
    "arrivalTime": "14:38",
    "stopCount": 10,
    "originName": "上村村口公交站",
    "terminalName": "新濠锋正门（澳城大/澳理大/澳旅大）",
    "stops": [
      {
        "seq": 1,
        "stationName": "上村村口公交站",
        "time": "13:50"
      },
      {
        "seq": 2,
        "stationName": "澳门新街坊",
        "time": "13:53"
      },
      {
        "seq": 3,
        "stationName": "K2荔枝湾(伯牙幼儿园旁)",
        "time": "13:56"
      },
      {
        "seq": 4,
        "stationName": "华发首府（4号岗）②",
        "time": "13:57"
      },
      {
        "seq": 5,
        "stationName": "保利国际广场(琴政路南侧)",
        "time": "13:58"
      },
      {
        "seq": 6,
        "stationName": "中海名钻(北门)①",
        "time": "13:59"
      },
      {
        "seq": 7,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "14:24"
      },
      {
        "seq": 8,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "14:30"
      },
      {
        "seq": 9,
        "stationName": "澳门科技大学（望德圣母湾大马路）",
        "time": "14:32"
      },
      {
        "seq": 10,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "14:38"
      }
    ]
  },
  {
    "sourceName": "C4线夜班-下班",
    "routeNo": "C4",
    "direction": "往横琴",
    "lineFullName": "C4线夜班-下班",
    "tripLabel": "下班",
    "tripCode": "C4｜往横琴｜C4线夜班-下班",
    "departureTime": "21:33",
    "arrivalTime": "22:26",
    "stopCount": 10,
    "originName": "澳门新濠锋酒店",
    "terminalName": "上村村口公交站",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新濠锋酒店",
        "time": "21:33"
      },
      {
        "seq": 2,
        "stationName": "澳门科技大学南门（新濠天地）①",
        "time": "21:40"
      },
      {
        "seq": 3,
        "stationName": "霍英东马路/新濠天地",
        "time": "21:41"
      },
      {
        "seq": 4,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "22:06"
      },
      {
        "seq": 5,
        "stationName": "中海名钻(北门)②",
        "time": "22:13"
      },
      {
        "seq": 6,
        "stationName": "保利国际广场（朗琴道交琴政路北侧）",
        "time": "22:14"
      },
      {
        "seq": 7,
        "stationName": "华发首府（4号岗）①",
        "time": "22:15"
      },
      {
        "seq": 8,
        "stationName": "K2荔枝湾②",
        "time": "22:18"
      },
      {
        "seq": 9,
        "stationName": "澳门新街坊",
        "time": "22:23"
      },
      {
        "seq": 10,
        "stationName": "上村村口公交站",
        "time": "22:26"
      }
    ]
  },
  {
    "sourceName": "D1市民中心-上班线",
    "routeNo": "D1",
    "direction": "往横琴",
    "lineFullName": "D1市民中心-上班线",
    "tripLabel": "上班线",
    "tripCode": "D1｜往横琴｜D1市民中心-上班线",
    "departureTime": "07:40",
    "arrivalTime": "08:58",
    "stopCount": 11,
    "originName": "澳门新葡京酒店",
    "terminalName": "琴海西站总站",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门新葡京酒店",
        "time": "07:40"
      },
      {
        "seq": 2,
        "stationName": "澳门新濠锋酒店",
        "time": "08:00"
      },
      {
        "seq": 3,
        "stationName": "赛马会(公交站)",
        "time": "08:05"
      },
      {
        "seq": 4,
        "stationName": "莲花路停车场（莲花关桥头）",
        "time": "08:10"
      },
      {
        "seq": 5,
        "stationName": "南迎客平台（南二门）",
        "time": "08:25"
      },
      {
        "seq": 6,
        "stationName": "横琴市民中心（往颂琴）",
        "time": "08:37"
      },
      {
        "seq": 7,
        "stationName": "市民中心(祥顺路东侧）（东1）",
        "time": "08:38"
      },
      {
        "seq": 8,
        "stationName": "澳门新街坊",
        "time": "08:40"
      },
      {
        "seq": 9,
        "stationName": "中葡经贸中心(往琴海西)",
        "time": "08:45"
      },
      {
        "seq": 10,
        "stationName": "中医药产业园①",
        "time": "08:51"
      },
      {
        "seq": 11,
        "stationName": "琴海西站总站",
        "time": "08:58"
      }
    ]
  },
  {
    "sourceName": "D1市民中心-下班线",
    "routeNo": "D1",
    "direction": "往澳门",
    "lineFullName": "D1市民中心-下班线",
    "tripLabel": "下班线",
    "tripCode": "D1｜往澳门｜D1市民中心-下班线",
    "departureTime": "18:05",
    "arrivalTime": "19:53",
    "stopCount": 14,
    "originName": "琴海西站总站",
    "terminalName": "海上居",
    "stops": [
      {
        "seq": 1,
        "stationName": "琴海西站总站",
        "time": "18:05"
      },
      {
        "seq": 2,
        "stationName": "中葡经贸中心(往口岸)",
        "time": "18:13"
      },
      {
        "seq": 3,
        "stationName": "澳门新街坊",
        "time": "18:18"
      },
      {
        "seq": 4,
        "stationName": "市民中心(祥顺路西侧)（西1）",
        "time": "18:20"
      },
      {
        "seq": 5,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "18:22"
      },
      {
        "seq": 6,
        "stationName": "横琴市民中心（往口岸）",
        "time": "18:27"
      },
      {
        "seq": 7,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "18:47"
      },
      {
        "seq": 8,
        "stationName": "莲花路停车场",
        "time": "18:50"
      },
      {
        "seq": 9,
        "stationName": "赛马会(公交站)",
        "time": "19:00"
      },
      {
        "seq": 10,
        "stationName": "澳门新濠锋酒店",
        "time": "19:17"
      },
      {
        "seq": 11,
        "stationName": "澳门理工大学主校区(理工学院街）",
        "time": "19:38"
      },
      {
        "seq": 12,
        "stationName": "澳门新葡京酒店",
        "time": "19:41"
      },
      {
        "seq": 13,
        "stationName": "友谊马路/海景花园",
        "time": "19:43"
      },
      {
        "seq": 14,
        "stationName": "海上居",
        "time": "19:53"
      }
    ]
  },
  {
    "sourceName": "D2中医药产业园-上班",
    "routeNo": "D2",
    "direction": "往横琴",
    "lineFullName": "D2中医药产业园-上班",
    "tripLabel": "上班",
    "tripCode": "D2｜往横琴｜D2中医药产业园-上班",
    "departureTime": "07:30",
    "arrivalTime": "08:48",
    "stopCount": 13,
    "originName": "林茂/运顺新村(公交站)",
    "terminalName": "中医药产业园（IN1下客点）",
    "stops": [
      {
        "seq": 1,
        "stationName": "林茂/运顺新村(公交站)",
        "time": "07:30"
      },
      {
        "seq": 2,
        "stationName": "鮑思高球場",
        "time": "07:38"
      },
      {
        "seq": 3,
        "stationName": "东北大马路/南澳",
        "time": "07:43"
      },
      {
        "seq": 4,
        "stationName": "东北大马路/保利达(公交站)",
        "time": "07:48"
      },
      {
        "seq": 5,
        "stationName": "泉悦花园（氹仔华南工业大厦）",
        "time": "08:00"
      },
      {
        "seq": 6,
        "stationName": "莲花路停车场（莲花关桥头）",
        "time": "08:08"
      },
      {
        "seq": 7,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "08:23"
      },
      {
        "seq": 8,
        "stationName": "横琴国际商务中心②",
        "time": "08:28"
      },
      {
        "seq": 9,
        "stationName": "市民中心(祥顺路东侧）（东1）",
        "time": "08:33"
      },
      {
        "seq": 10,
        "stationName": "澳门新街坊",
        "time": "08:35"
      },
      {
        "seq": 11,
        "stationName": "中葡经贸中心(往琴海西)",
        "time": "08:40"
      },
      {
        "seq": 12,
        "stationName": "科创中心西门",
        "time": "08:46"
      },
      {
        "seq": 13,
        "stationName": "中医药产业园（IN1下客点）",
        "time": "08:48"
      }
    ]
  },
  {
    "sourceName": "D2中医药产业园-下班",
    "routeNo": "D2",
    "direction": "往澳门",
    "lineFullName": "D2中医药产业园-下班",
    "tripLabel": "下班",
    "tripCode": "D2｜往澳门｜D2中医药产业园-下班",
    "departureTime": "17:52",
    "arrivalTime": "19:29",
    "stopCount": 13,
    "originName": "中医药产业园内",
    "terminalName": "林茂/运顺新村",
    "stops": [
      {
        "seq": 1,
        "stationName": "中医药产业园内",
        "time": "17:52"
      },
      {
        "seq": 2,
        "stationName": "环岛北路西（科创中心）②",
        "time": "17:54"
      },
      {
        "seq": 3,
        "stationName": "中葡经贸中心(往口岸)",
        "time": "17:59"
      },
      {
        "seq": 4,
        "stationName": "澳门新街坊",
        "time": "18:04"
      },
      {
        "seq": 5,
        "stationName": "市民中心(祥顺路西侧）（西2）",
        "time": "18:08"
      },
      {
        "seq": 6,
        "stationName": "横琴国际商务中心(靠ICC)",
        "time": "18:14"
      },
      {
        "seq": 7,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "18:29"
      },
      {
        "seq": 8,
        "stationName": "莲花路停车场",
        "time": "18:33"
      },
      {
        "seq": 9,
        "stationName": "排角/银河",
        "time": "18:36"
      },
      {
        "seq": 10,
        "stationName": "花城公园(公交站)",
        "time": "18:42"
      },
      {
        "seq": 11,
        "stationName": "海天居（银行）",
        "time": "19:00"
      },
      {
        "seq": 12,
        "stationName": "东北大马路/南澳",
        "time": "19:10"
      },
      {
        "seq": 13,
        "stationName": "林茂/运顺新村",
        "time": "19:29"
      }
    ]
  },
  {
    "sourceName": "D3澳琴西线早班-上班",
    "routeNo": "D3",
    "direction": "往横琴",
    "lineFullName": "D3澳琴西线早班-上班",
    "tripLabel": "上班",
    "tripCode": "D3｜往横琴｜D3澳琴西线早班-上班",
    "departureTime": "07:20",
    "arrivalTime": "08:31",
    "stopCount": 13,
    "originName": "澳门街坊会联合总会",
    "terminalName": "汇通七路(IFC)",
    "stops": [
      {
        "seq": 1,
        "stationName": "澳门街坊会联合总会",
        "time": "07:20"
      },
      {
        "seq": 2,
        "stationName": "沙梨头北街(筷子基宏佳工厦)",
        "time": "07:24"
      },
      {
        "seq": 3,
        "stationName": "海擎天(劳工子弟幼稚园)",
        "time": "07:28"
      },
      {
        "seq": 4,
        "stationName": "亚马喇前地F站台",
        "time": "07:36"
      },
      {
        "seq": 5,
        "stationName": "望德圣母湾马路/军营",
        "time": "07:54"
      },
      {
        "seq": 6,
        "stationName": "连贯公路/伦敦人",
        "time": "07:58"
      },
      {
        "seq": 7,
        "stationName": "莲花路停车场（莲花关桥头）",
        "time": "08:02"
      },
      {
        "seq": 8,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "08:17"
      },
      {
        "seq": 9,
        "stationName": "南光大厦(停车场出口临时停靠点)",
        "time": "08:19"
      },
      {
        "seq": 10,
        "stationName": "横琴国际商务中心(靠ICC)②",
        "time": "08:23"
      },
      {
        "seq": 11,
        "stationName": "洋环路口(横琴华发商都)",
        "time": "08:27"
      },
      {
        "seq": 12,
        "stationName": "汇通五路（横琴北）",
        "time": "08:30"
      },
      {
        "seq": 13,
        "stationName": "汇通七路(IFC)",
        "time": "08:31"
      }
    ]
  },
  {
    "sourceName": "D3澳琴西线晚班-下班",
    "routeNo": "D3",
    "direction": "往澳门",
    "lineFullName": "D3澳琴西线晚班-下班",
    "tripLabel": "下班",
    "tripCode": "D3｜往澳门｜D3澳琴西线晚班-下班",
    "departureTime": "18:10",
    "arrivalTime": "19:16",
    "stopCount": 13,
    "originName": "汇通五路（横琴北）",
    "terminalName": "澳门街坊会联合总会",
    "stops": [
      {
        "seq": 1,
        "stationName": "汇通五路（横琴北）",
        "time": "18:10"
      },
      {
        "seq": 2,
        "stationName": "汇通七路(IFC)",
        "time": "18:11"
      },
      {
        "seq": 3,
        "stationName": "海鸣桥（路西侧）",
        "time": "18:13"
      },
      {
        "seq": 4,
        "stationName": "荣澳道南",
        "time": "18:16"
      },
      {
        "seq": 5,
        "stationName": "横琴国贸大厦(都会道临时停靠点)",
        "time": "18:19"
      },
      {
        "seq": 6,
        "stationName": "南光大厦(灏怡中心临时停靠点)",
        "time": "18:22"
      },
      {
        "seq": 7,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "18:37"
      },
      {
        "seq": 8,
        "stationName": "莲花路停车场",
        "time": "18:42"
      },
      {
        "seq": 9,
        "stationName": "澳门科技大学南门（新濠天地）②",
        "time": "18:47"
      },
      {
        "seq": 10,
        "stationName": "亚马喇前地G站台",
        "time": "19:02"
      },
      {
        "seq": 11,
        "stationName": "林茂/运顺新村(公交站)",
        "time": "19:10"
      },
      {
        "seq": 12,
        "stationName": "筷子基总站",
        "time": "19:13"
      },
      {
        "seq": 13,
        "stationName": "澳门街坊会联合总会",
        "time": "19:16"
      }
    ]
  },
  {
    "sourceName": "D5澳琴东线早班-上班",
    "routeNo": "D5",
    "direction": "往横琴",
    "lineFullName": "D5澳琴东线早班-上班",
    "tripLabel": "上班",
    "tripCode": "D5｜往横琴｜D5澳琴东线早班-上班",
    "departureTime": "07:40",
    "arrivalTime": "08:49",
    "stopCount": 16,
    "originName": "观音古庙门口（澳旅大望厦校区）",
    "terminalName": "中医药产业园（IN1下客点）",
    "stops": [
      {
        "seq": 1,
        "stationName": "观音古庙门口（澳旅大望厦校区）",
        "time": "07:40"
      },
      {
        "seq": 2,
        "stationName": "观音堂(来来商场对面)",
        "time": "07:41"
      },
      {
        "seq": 3,
        "stationName": "二龙喉公园",
        "time": "07:43"
      },
      {
        "seq": 4,
        "stationName": "巴波沙大馬路",
        "time": "07:51"
      },
      {
        "seq": 5,
        "stationName": "科大/机场货运站",
        "time": "08:07"
      },
      {
        "seq": 6,
        "stationName": "射击路/上葡京",
        "time": "08:09"
      },
      {
        "seq": 7,
        "stationName": "莲花路停车场（莲花关桥头）",
        "time": "08:13"
      },
      {
        "seq": 8,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "08:33"
      },
      {
        "seq": 9,
        "stationName": "中央汇(创业谷)(临时停靠点)",
        "time": "08:36"
      },
      {
        "seq": 10,
        "stationName": "依依桥北②",
        "time": "08:38"
      },
      {
        "seq": 11,
        "stationName": "天星里①",
        "time": "08:40"
      },
      {
        "seq": 12,
        "stationName": "伯牙小学临时停靠点①",
        "time": "08:41"
      },
      {
        "seq": 13,
        "stationName": "市民中心(祥顺路东侧）（东1）",
        "time": "08:42"
      },
      {
        "seq": 14,
        "stationName": "澳门新街坊",
        "time": "08:44"
      },
      {
        "seq": 15,
        "stationName": "澳门新街坊南",
        "time": "08:46"
      },
      {
        "seq": 16,
        "stationName": "中医药产业园（IN1下客点）",
        "time": "08:49"
      }
    ]
  },
  {
    "sourceName": "D5澳琴东线晚班-下班",
    "routeNo": "D5",
    "direction": "往澳门",
    "lineFullName": "D5澳琴东线晚班-下班",
    "tripLabel": "下班",
    "tripCode": "D5｜往澳门｜D5澳琴东线晚班-下班",
    "departureTime": "18:10",
    "arrivalTime": "19:25",
    "stopCount": 18,
    "originName": "中医药产业园内",
    "terminalName": "二龙喉公园",
    "stops": [
      {
        "seq": 1,
        "stationName": "中医药产业园内",
        "time": "18:10"
      },
      {
        "seq": 2,
        "stationName": "澳门新街坊",
        "time": "18:21"
      },
      {
        "seq": 3,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "18:23"
      },
      {
        "seq": 4,
        "stationName": "市民中心(祥顺路东侧）（东3）",
        "time": "18:25"
      },
      {
        "seq": 5,
        "stationName": "伯牙小学临时停靠点②",
        "time": "18:28"
      },
      {
        "seq": 6,
        "stationName": "天星里②",
        "time": "18:30"
      },
      {
        "seq": 7,
        "stationName": "依依桥北①",
        "time": "18:31"
      },
      {
        "seq": 8,
        "stationName": "濠江路口①",
        "time": "18:32"
      },
      {
        "seq": 9,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "18:52"
      },
      {
        "seq": 10,
        "stationName": "莲花路停车场",
        "time": "18:54"
      },
      {
        "seq": 11,
        "stationName": "机场大马路/上葡京",
        "time": "18:56"
      },
      {
        "seq": 12,
        "stationName": "机场大马路/科大医院",
        "time": "18:58"
      },
      {
        "seq": 13,
        "stationName": "海上居",
        "time": "19:11"
      },
      {
        "seq": 14,
        "stationName": "关闸广场(旅游巴出口停靠位)",
        "time": "19:13"
      },
      {
        "seq": 15,
        "stationName": "关闸马路",
        "time": "19:17"
      },
      {
        "seq": 16,
        "stationName": "观音古庙门口（澳旅大望厦校区）",
        "time": "19:22"
      },
      {
        "seq": 17,
        "stationName": "观音堂(来来商场对面)",
        "time": "19:23"
      },
      {
        "seq": 18,
        "stationName": "二龙喉公园",
        "time": "19:25"
      }
    ]
  },
  {
    "sourceName": "D6澳琴东线午班-上班",
    "routeNo": "D6",
    "direction": "往横琴",
    "lineFullName": "D6澳琴东线午班-上班",
    "tripLabel": "上班",
    "tripCode": "D6｜往横琴｜D6澳琴东线午班-上班",
    "departureTime": "13:00",
    "arrivalTime": "14:21",
    "stopCount": 18,
    "originName": "观音古庙门口（澳旅大望厦校区）",
    "terminalName": "中医药产业园（IN1下客点）",
    "stops": [
      {
        "seq": 1,
        "stationName": "观音古庙门口（澳旅大望厦校区）",
        "time": "13:00"
      },
      {
        "seq": 2,
        "stationName": "观音堂(来来商场对面)",
        "time": "13:01"
      },
      {
        "seq": 3,
        "stationName": "二龙喉公园",
        "time": "13:03"
      },
      {
        "seq": 4,
        "stationName": "巴波沙大馬路",
        "time": "13:11"
      },
      {
        "seq": 5,
        "stationName": "关闸广场(旅游巴出口停靠位)",
        "time": "13:15"
      },
      {
        "seq": 6,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "13:30"
      },
      {
        "seq": 7,
        "stationName": "科大/机场货运站",
        "time": "13:39"
      },
      {
        "seq": 8,
        "stationName": "射击路/上葡京",
        "time": "13:41"
      },
      {
        "seq": 9,
        "stationName": "莲花路停车场（莲花关桥头）",
        "time": "13:43"
      },
      {
        "seq": 10,
        "stationName": "横琴口岸（南二门迎客平台）",
        "time": "14:03"
      },
      {
        "seq": 11,
        "stationName": "中央汇(创业谷)(临时停靠点)",
        "time": "14:08"
      },
      {
        "seq": 12,
        "stationName": "依依桥北②",
        "time": "14:10"
      },
      {
        "seq": 13,
        "stationName": "天星里①",
        "time": "14:12"
      },
      {
        "seq": 14,
        "stationName": "伯牙小学临时停靠点①",
        "time": "14:13"
      },
      {
        "seq": 15,
        "stationName": "市民中心(祥顺路东侧）（东2）",
        "time": "14:14"
      },
      {
        "seq": 16,
        "stationName": "澳门新街坊",
        "time": "14:16"
      },
      {
        "seq": 17,
        "stationName": "澳门新街坊南",
        "time": "14:18"
      },
      {
        "seq": 18,
        "stationName": "中医药产业园（IN1下客点）",
        "time": "14:21"
      }
    ]
  },
  {
    "sourceName": "D6澳琴东线午班-下班",
    "routeNo": "D6",
    "direction": "往澳门",
    "lineFullName": "D6澳琴东线午班-下班",
    "tripLabel": "下班",
    "tripCode": "D6｜往澳门｜D6澳琴东线午班-下班",
    "departureTime": "11:30",
    "arrivalTime": "12:55",
    "stopCount": 19,
    "originName": "中医药产业园内",
    "terminalName": "二龙喉公园",
    "stops": [
      {
        "seq": 1,
        "stationName": "中医药产业园内",
        "time": "11:30"
      },
      {
        "seq": 2,
        "stationName": "澳门新街坊",
        "time": "11:41"
      },
      {
        "seq": 3,
        "stationName": "澳门新街坊南（往口岸）",
        "time": "11:43"
      },
      {
        "seq": 4,
        "stationName": "市民中心(祥顺路东侧）（东3）",
        "time": "11:45"
      },
      {
        "seq": 5,
        "stationName": "伯牙小学临时停靠点②",
        "time": "11:48"
      },
      {
        "seq": 6,
        "stationName": "天星里②",
        "time": "11:50"
      },
      {
        "seq": 7,
        "stationName": "依依桥北①",
        "time": "11:51"
      },
      {
        "seq": 8,
        "stationName": "濠江路口①",
        "time": "11:52"
      },
      {
        "seq": 9,
        "stationName": "澳门口岸区H2(7/8/9卡位)",
        "time": "12:12"
      },
      {
        "seq": 10,
        "stationName": "莲花路停车场",
        "time": "12:14"
      },
      {
        "seq": 11,
        "stationName": "机场大马路/上葡京",
        "time": "12:16"
      },
      {
        "seq": 12,
        "stationName": "机场大马路/科大医院",
        "time": "12:18"
      },
      {
        "seq": 13,
        "stationName": "新濠锋正门（澳城大/澳理大/澳旅大）",
        "time": "12:28"
      },
      {
        "seq": 14,
        "stationName": "海上居",
        "time": "12:40"
      },
      {
        "seq": 15,
        "stationName": "关闸广场(旅游巴出口停靠位)",
        "time": "12:42"
      },
      {
        "seq": 16,
        "stationName": "关闸马路",
        "time": "12:46"
      },
      {
        "seq": 17,
        "stationName": "观音古庙门口（澳旅大望厦校区）",
        "time": "12:51"
      },
      {
        "seq": 18,
        "stationName": "观音堂(来来商场对面)",
        "time": "12:52"
      },
      {
        "seq": 19,
        "stationName": "二龙喉公园",
        "time": "12:55"
      }
    ]
  }
];

export const TQH_META = {
  "trips": 80,
  "stations": 138,
  "stops": 843,
  "macauStations": 56,
  "hengqinStations": 82,
  "linked": 41,
  "toMacau": 39,
  "toHengqin": 41
};
