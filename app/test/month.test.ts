import { describe, expect, it } from 'vitest';
import type { CalendarItem } from '../src/model';
import { buildMonth, monthRange, shiftMonth } from '../src/month';

const item = (p: Partial<CalendarItem>): CalendarItem => ({
  kind: 'task', id: p.title ?? 'x', sourceId: 's', title: 'x', start: '2026-10-24', end: p.start ?? '2026-10-24', time: null,
  color: '', completed: false, important: false, urgent: false, link: null, notes: '', ...p,
});

describe('月历网格', () => {
  it('2026 年 10 月：周一开头、固定 6 行，从 9 月 28 日到 11 月 8 日', () => {
    expect(monthRange(2026, 10)).toEqual({ start: '2026-09-28', end: '2026-11-08' });
    const weeks = buildMonth(2026, 10, [], { today: '2026-10-24' });
    expect(weeks).toHaveLength(6);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0]![0]).toMatchObject({ date: '2026-09-28', inMonth: false, day: 28 });
    const today = weeks.flat().find((d) => d.isToday)!;
    expect(today).toMatchObject({ date: '2026-10-24', weekend: true, inMonth: true });
  });

  it('条目放进对应日期；跨天事件出现在覆盖的每一天，超出网格的部分被截断', () => {
    const weeks = buildMonth(2026, 10, [
      item({ title: '任务', start: '2026-10-24', end: '2026-10-24' }),
      item({ title: '出差', kind: 'event', start: '2026-09-20', end: '2026-09-29' }),
      item({ title: '网格外', start: '2026-12-01', end: '2026-12-01' }),
    ]);
    const byDate = new Map(weeks.flat().map((d) => [d.date, d.items.map((i) => i.title)]));
    expect(byDate.get('2026-10-24')).toEqual(['任务']);
    expect(byDate.get('2026-09-28')).toEqual(['出差']);
    expect(byDate.get('2026-09-29')).toEqual(['出差']);
    expect(byDate.get('2026-09-30')).toEqual([]);
    expect([...byDate.values()].flat()).not.toContain('网格外');
  });

  it('可以隐藏已完成的任务', () => {
    const items = [item({ title: '未完成' }), item({ title: '已完成', completed: true })];
    const titles = (show: boolean) =>
      buildMonth(2026, 10, items, { showCompleted: show }).flat().find((d) => d.date === '2026-10-24')!.items.map((i) => i.title);
    expect(titles(true)).toEqual(['未完成', '已完成']);
    expect(titles(false)).toEqual(['未完成']);
  });

  it('切换月份跨年', () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 10, -22)).toEqual({ year: 2024, month: 12 });
  });
});
