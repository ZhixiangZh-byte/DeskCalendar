/**
 * 农历：用浏览器 / Node 内置的 ICU 中国历（Intl，ca-chinese）换算，不需要自带历表。
 * 月名、日名按传统写法（正月…冬月、腊月；初一…廿九、三十）自行生成，并标出传统节日。
 * 运行环境不支持中国历时，所有函数返回 null，界面上就不显示农历。
 */

export interface LunarDate {
  /** 农历年对应的公历年份（正月初一所在的公历年） */
  year: number;
  month: number;
  leap: boolean;
  day: number;
}

const MONTH_NAMES = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
const DAY_NAMES = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
const STEMS = '甲乙丙丁戊己庚辛壬癸';
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
const ZODIAC = '鼠牛虎兔龙蛇马羊猴鸡狗猪';

/** 农历（月-日）节日；闰月不算 */
const FESTIVALS: Record<string, string> = {
  '1-1': '春节',
  '1-15': '元宵节',
  '5-5': '端午节',
  '7-7': '七夕',
  '7-15': '中元节',
  '8-15': '中秋节',
  '9-9': '重阳节',
  '12-8': '腊八节',
  '12-23': '小年',
};

let formatter: Intl.DateTimeFormat | null | undefined;
function getFormatter(): Intl.DateTimeFormat | null {
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
      if (formatter.resolvedOptions().calendar !== 'chinese') formatter = null;
    } catch {
      formatter = null;
    }
  }
  return formatter;
}

const CN_MONTHS: Record<string, number> = {
  正: 1, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 冬: 11, 十二: 12, 腊: 12,
};

/**
 * 解析 ICU 输出的月份。不同选项组合下 ICU 可能输出数字（"9"、"闰6"）或中文月名（"九月"、"闰六月"、"腊月"），两种都接受
 */
export function parseMonth(s: string): { month: number; leap: boolean } | null {
  const m = /^(闰)?(?:(\d{1,2})|(.+?))月?$/.exec(s.trim());
  if (!m) return null;
  const month = m[2] ? Number(m[2]) : CN_MONTHS[m[3] ?? ''];
  return month && month >= 1 && month <= 12 ? { month, leap: Boolean(m[1]) } : null;
}

const cache = new Map<string, LunarDate | null>();

/** 公历日期 YYYY-MM-DD 对应的农历；不支持时返回 null */
export function lunarOf(date: string): LunarDate | null {
  if (cache.has(date)) return cache.get(date)!;
  let result: LunarDate | null = null;
  const fmt = getFormatter();
  if (fmt) {
    const parts = fmt.formatToParts(new Date(`${date}T00:00:00Z`));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const month = parseMonth(get('month'));
    const day = Number(get('day'));
    const year = Number(get('relatedYear') || get('year'));
    if (month && day >= 1 && day <= 30 && year) result = { year, ...month, day };
  }
  cache.set(date, result);
  return result;
}

export function lunarMonthName(l: LunarDate): string {
  return `${l.leap ? '闰' : ''}${MONTH_NAMES[l.month - 1]}月`;
}

export function lunarDayName(l: LunarDate): string {
  return DAY_NAMES[l.day - 1]!;
}

/** 干支纪年与生肖，如"丙午马年" */
export function lunarYearName(l: LunarDate): string {
  const i = l.year - 4;
  return `${STEMS[((i % 10) + 10) % 10]}${BRANCHES[((i % 12) + 12) % 12]}${ZODIAC[((i % 12) + 12) % 12]}年`;
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 传统节日；没有时返回 null。除夕取"正月初一的前一天"，腊月只有 29 天的年份也正确 */
export function lunarFestival(date: string): string | null {
  const l = lunarOf(date);
  if (!l) return null;
  const next = lunarOf(nextDay(date));
  if (next && next.month === 1 && next.day === 1 && !next.leap) return '除夕';
  return l.leap ? null : (FESTIVALS[`${l.month}-${l.day}`] ?? null);
}

/** 月历格子里显示的短标签：节日 > 初一显示月名 > 日名 */
export function lunarLabel(date: string): { text: string; festival: boolean } | null {
  const l = lunarOf(date);
  if (!l) return null;
  const festival = lunarFestival(date);
  if (festival) return { text: festival, festival: true };
  return { text: l.day === 1 ? lunarMonthName(l) : lunarDayName(l), festival: false };
}

/** 完整写法，如"丙午马年 九月十五" */
export function lunarFull(date: string): string | null {
  const l = lunarOf(date);
  return l ? `${lunarYearName(l)} ${lunarMonthName(l)}${lunarDayName(l)}` : null;
}
