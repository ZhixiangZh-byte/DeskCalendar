import { describe, expect, it } from 'vitest';
import type { CalendarItem } from '../src/model';
import { DemoSource } from '../src/source';
import { createView, layoutTimeline, reviewGroups, splitQuadrants } from '../src/views';

const base = (p: Partial<CalendarItem>): CalendarItem => ({
  kind: 'task', id: p.title ?? 'x', sourceId: 's', title: 'x', start: '2026-10-24', end: p.start ?? '2026-10-24', time: null,
  endTime: null, endTimeDate: null, color: '', completed: false, completedAt: null, important: false, urgent: false, link: null,
  notes: '', location: '', editable: true, recurring: false, ...p,
});
const ev = (title: string, time: string, endTime: string, p: Partial<CalendarItem> = {}) =>
  base({ kind: 'event', title, time, endTime, endTimeDate: p.start ?? '2026-10-24', ...p });

describe('日视图时间轴布局', () => {
  it('不重叠的事件各占整列；重叠的并排分列', () => {
    const placed = layoutTimeline(
      [
        ev('早会', '09:00', '10:00'),
        ev('A', '13:00', '15:00'),
        ev('B', '14:00', '15:30'),
        ev('C', '14:30', '16:00'),
        ev('D', '15:00', '16:00'),
        base({ title: '任务' }),
        base({ kind: 'event', title: '全天' }),
      ],
      '2026-10-24',
    );
    const by = Object.fromEntries(placed.map((p) => [p.item.title, p]));
    expect(Object.keys(by).sort()).toEqual(['A', 'B', 'C', 'D', '早会']);
    expect(by['早会']).toMatchObject({ startMin: 540, endMin: 600, col: 0, cols: 1 });
    // A 13–15、B 14–15:30、C 14:30–16、D 15–16：A、B、C 两两重叠，需要 3 列；D 复用 A 结束后空出的第 0 列
    expect([by.A!.col, by.B!.col, by.C!.col, by.D!.col]).toEqual([0, 1, 2, 0]);
    expect(new Set([by.A!.cols, by.B!.cols, by.C!.cols, by.D!.cols])).toEqual(new Set([3]));
  });

  it('跨天事件在当天截断；太短的事件至少 20 分钟高', () => {
    const placed = layoutTimeline(
      [
        ev('通宵实验', '22:00', '06:00', { start: '2026-10-23', endTimeDate: '2026-10-24' }),
        ev('跨到明天', '23:00', '01:00', { endTimeDate: '2026-10-25' }),
        ev('五分钟', '12:00', '12:05'),
      ],
      '2026-10-24',
    );
    const by = Object.fromEntries(placed.map((p) => [p.item.title, p]));
    expect(by['通宵实验']).toMatchObject({ startMin: 0, endMin: 360 });
    expect(by['跨到明天']).toMatchObject({ startMin: 1380, endMin: 1440 });
    expect(by['五分钟']).toMatchObject({ startMin: 720, endMin: 740 });
  });
});

describe('四象限与回顾箱分组', () => {
  it('未完成任务按重要 × 紧急分组，组内按日期排序、无日期排最后；事件和已完成任务不出现', () => {
    const g = splitQuadrants([
      base({ title: '无日期', start: '', important: true, urgent: true }),
      base({ title: '明天', start: '2026-10-25', important: true, urgent: true }),
      base({ title: '昨天', start: '2026-10-23', important: true, urgent: true }),
      base({ title: '重要', important: true }),
      base({ title: '紧急', urgent: true }),
      base({ title: '普通' }),
      base({ title: '已完成', completed: true, important: true }),
      base({ kind: 'event', title: '事件', important: true }),
    ]);
    expect(g.importantUrgent.map((t) => t.title)).toEqual(['昨天', '明天', '无日期']);
    expect(g.importantOnly.map((t) => t.title)).toEqual(['重要']);
    expect(g.urgentOnly.map((t) => t.title)).toEqual(['紧急']);
    expect(g.neither.map((t) => t.title)).toEqual(['普通']);
  });

  it('回顾箱：逾期按日期升序，已完成按完成时间倒序', () => {
    const r = reviewGroups(
      [
        base({ title: '逾期近', start: '2026-10-23' }),
        base({ title: '逾期远', start: '2026-10-01' }),
        base({ title: '今天', start: '2026-10-24' }),
        base({ title: '无日期', start: '' }),
        base({ title: '早完成', completed: true, completedAt: '2026-10-01T00:00:00Z' }),
        base({ title: '晚完成', completed: true, completedAt: '2026-10-20T00:00:00Z' }),
      ],
      '2026-10-24',
    );
    expect(r.overdue.map((t) => t.title)).toEqual(['逾期远', '逾期近']);
    expect(r.done.map((t) => t.title)).toEqual(['晚完成', '早完成']);
  });
});

describe('五个视图都能用演示数据渲染', () => {
  it.each(['month', 'day', 'quadrant', 'review', 'longterm'])('%s', async (id) => {
    const view = createView(id);
    expect(view.id).toBe(id);
    const today = '2026-10-24';
    const source = new DemoSource(today);
    const ctx = { today, snapshot: null, showCompleted: true, showLunar: true };
    const snapshot = await source.load(view.query(ctx));
    const html = view.render({ ...ctx, snapshot });
    expect(html.length).toBeGreaterThan(100);
    expect(view.title({ ...ctx, snapshot })).toBeTruthy();
    // 每个视图都至少能看到一条演示数据
    expect(html).toMatch(/data-act="open-(task|event)"/);
  });

  it('未知视图名回退到月历', () => {
    expect(createView(null).id).toBe('month');
    expect(createView('???').id).toBe('month');
  });
});
