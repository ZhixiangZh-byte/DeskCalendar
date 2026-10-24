/** 日期工具。日期统一用本地日历日期字符串 `YYYY-MM-DD`；日期运算在 UTC 下进行，避免时区和夏令时干扰。 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function toUtcMs(date: string): number {
  const m = DATE_PATTERN.exec(date);
  if (!m) throw new RangeError(`日期格式不合法：${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function addDays(date: string, days: number): string {
  const d = new Date(toUtcMs(date) + days * DAY_MS);
  return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** 0 = 星期日 … 6 = 星期六 */
export function dayOfWeek(date: string): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 时刻在本机时区下的日期与时间 */
export function localDateTime(d: Date): { date: string; time: string } {
  return {
    date: formatDate(d.getFullYear(), d.getMonth() + 1, d.getDate()),
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  };
}

export function today(now = new Date()): string {
  return localDateTime(now).date;
}

/** 本地日期 00:00 对应的时刻 */
export function startOfLocalDay(date: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}
