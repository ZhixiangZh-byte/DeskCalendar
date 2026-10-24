/** 月历网格：按周分行，每格含当天的条目（跨天事件在覆盖的每一天都出现）。 */
import { addDays, dayOfWeek, daysInMonth, formatDate } from './date';
import { compareItems, type CalendarItem } from './model';

export interface MonthDay {
  date: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  weekend: boolean;
  items: CalendarItem[];
}

export interface MonthOptions {
  /** 0 = 周日开头，1 = 周一开头（默认） */
  weekStartsOn?: 0 | 1;
  today?: string;
  showCompleted?: boolean;
}

/** 网格覆盖的日期范围（固定 6 行，组件高度不随月份变化） */
export function monthRange(year: number, month: number, weekStartsOn: 0 | 1 = 1): { start: string; end: string } {
  const first = formatDate(year, month, 1);
  const lead = (dayOfWeek(first) - weekStartsOn + 7) % 7;
  const start = addDays(first, -lead);
  return { start, end: addDays(start, 41) };
}

export function buildMonth(year: number, month: number, items: readonly CalendarItem[], options: MonthOptions = {}): MonthDay[][] {
  const { start, end } = monthRange(year, month, options.weekStartsOn ?? 1);
  const byDate = new Map<string, CalendarItem[]>();
  for (const item of items) {
    if (item.completed && options.showCompleted === false) continue;
    if (!item.start) continue; // 没有日期的任务不进月历
    // 只遍历与网格重叠的部分
    let d = item.start < start ? start : item.start;
    const last = item.end > end ? end : item.end;
    for (; d <= last; d = addDays(d, 1)) {
      let list = byDate.get(d);
      if (!list) byDate.set(d, (list = []));
      list.push(item);
    }
  }
  const prefix = formatDate(year, month, 1).slice(0, 7);
  const weeks: MonthDay[][] = [];
  let date = start;
  for (let w = 0; w < 6; w++) {
    const row: MonthDay[] = [];
    for (let i = 0; i < 7; i++) {
      const dow = dayOfWeek(date);
      row.push({
        date,
        day: Number(date.slice(8)),
        inMonth: date.startsWith(prefix),
        isToday: date === options.today,
        weekend: dow === 0 || dow === 6,
        items: (byDate.get(date) ?? []).sort(compareItems),
      });
      date = addDays(date, 1);
    }
    weeks.push(row);
  }
  return weeks;
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

export { daysInMonth };
