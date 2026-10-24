import { describe, expect, it } from 'vitest';
import { compareItems, eventToItem, htmlToText, parseQuickTitle, parseTags, taskToItem, withTags, type CalendarItem } from '../src/model';

describe('四象限标签', () => {
  it('解析末尾标签行', () => {
    expect(parseTags('第一行\n#重要 #紧急')).toEqual({ body: '第一行', important: true, urgent: true });
    expect(parseTags('#紧急')).toEqual({ body: '', important: false, urgent: true });
    expect(parseTags('备注\n#重要\n\n')).toEqual({ body: '备注', important: true, urgent: false });
  });

  it('正文里提到 #重要 不算标签；末行有其他文字也不算', () => {
    expect(parseTags('这件事 #重要 但不是标签行\n其他')).toMatchObject({ important: false });
    expect(parseTags('备注\n#重要 记得')).toMatchObject({ important: false, urgent: false });
    expect(parseTags(undefined)).toEqual({ body: '', important: false, urgent: false });
  });

  it('写入标签：替换旧标签行，没有标签时去掉标签行', () => {
    expect(withTags('备注', { important: true, urgent: false })).toBe('备注\n#重要');
    expect(withTags('备注\n#重要', { important: false, urgent: true })).toBe('备注\n#紧急');
    expect(withTags('备注\n#重要 #紧急', { important: false, urgent: false })).toBe('备注');
    expect(withTags('', { important: true, urgent: true })).toBe('#重要 #紧急');
  });

  it('写入后再解析得到同样的结果', () => {
    for (const important of [false, true]) {
      for (const urgent of [false, true]) {
        expect(parseTags(withTags('正文', { important, urgent }))).toEqual({ body: '正文', important, urgent });
      }
    }
  });
});

describe('标题末尾的感叹号标记', () => {
  it('1 个 = 重要，2 个 = 紧急，3 个及以上 = 重要且紧急；半角全角都可以', () => {
    expect(parseQuickTitle('写周报!')).toEqual({ title: '写周报', important: true, urgent: false });
    expect(parseQuickTitle('写周报！！')).toEqual({ title: '写周报', important: false, urgent: true });
    expect(parseQuickTitle('写周报!！!')).toEqual({ title: '写周报', important: true, urgent: true });
    expect(parseQuickTitle('写周报 !!!! ')).toEqual({ title: '写周报', important: true, urgent: true });
  });

  it('没有感叹号或感叹号不在末尾时不算标记', () => {
    expect(parseQuickTitle('  买菜  ')).toEqual({ title: '买菜', important: false, urgent: false });
    expect(parseQuickTitle('Hello! 世界')).toEqual({ title: 'Hello! 世界', important: false, urgent: false });
    expect(parseQuickTitle('!!')).toEqual({ title: '', important: false, urgent: true });
  });
});

describe('事件说明转纯文本', () => {
  it('去掉 HTML 标签、换行、实体；纯文本原样保留', () => {
    expect(htmlToText('第一行<br>第二行<br/><b>加粗</b> &amp; &lt;x&gt;')).toBe('第一行\n第二行\n加粗 & <x>');
    expect(htmlToText('<p>段落一</p><p>段落二</p>')).toBe('段落一\n段落二');
    expect(htmlToText('  a < b 的普通文字 ')).toBe('a < b 的普通文字');
  });
});

describe('事件转换', () => {
  it('定时事件带结束时间、地点和说明', () => {
    const item = eventToItem(
      {
        id: 'e', summary: '组会', location: ' S2 会议室 ', description: '议程<br>进展',
        start: { dateTime: '2026-10-24T10:00:00+08:00' }, end: { dateTime: '2026-10-24T11:30:00+08:00' },
      },
      'cal',
      '#fff',
    );
    expect(item).toMatchObject({ time: '10:00', endTime: '11:30', location: 'S2 会议室', notes: '议程\n进展' });
  });

  it('全天事件：end.date 不含当天', () => {
    const item = eventToItem({ id: 'e', summary: '会议', start: { date: '2026-10-24' }, end: { date: '2026-10-25' } }, 'cal', '#fff');
    expect(item).toMatchObject({ kind: 'event', start: '2026-10-24', end: '2026-10-24', time: null, title: '会议' });
  });

  it('多天全天事件', () => {
    const item = eventToItem({ id: 'e', start: { date: '2026-10-29' }, end: { date: '2026-11-02' } }, 'cal', '#fff');
    expect(item).toMatchObject({ start: '2026-10-29', end: '2026-11-01', title: '（无标题）' });
  });

  it('定时事件按本机时区（新加坡）换算', () => {
    const item = eventToItem(
      { id: 'e', start: { dateTime: '2026-10-24T01:30:00Z' }, end: { dateTime: '2026-10-24T02:30:00Z' } },
      'cal',
      '#fff',
    );
    expect(item).toMatchObject({ start: '2026-10-24', end: '2026-10-24', time: '09:30' });
  });

  it('跨午夜的定时事件占两天；恰好结束于 00:00 的只占一天', () => {
    const overnight = eventToItem(
      { id: 'e', start: { dateTime: '2026-10-24T22:00:00+08:00' }, end: { dateTime: '2026-10-25T02:00:00+08:00' } },
      'cal',
      '#fff',
    );
    expect(overnight).toMatchObject({ start: '2026-10-24', end: '2026-10-25', time: '22:00' });
    const untilMidnight = eventToItem(
      { id: 'e', start: { dateTime: '2026-10-24T22:00:00+08:00' }, end: { dateTime: '2026-10-25T00:00:00+08:00' } },
      'cal',
      '#fff',
    );
    expect(untilMidnight).toMatchObject({ start: '2026-10-24', end: '2026-10-24' });
  });

  it('已取消或缺少时间的事件忽略', () => {
    expect(eventToItem({ id: 'e', status: 'cancelled', start: { date: '2026-10-24' }, end: { date: '2026-10-25' } }, 'c', '')).toBeNull();
    expect(eventToItem({ id: 'e' }, 'c', '')).toBeNull();
  });
});

describe('任务转换', () => {
  it('取 due 的日期部分，解析完成状态和标签', () => {
    const item = taskToItem(
      { id: 't', title: '写周报', notes: '本周\n#重要', status: 'completed', due: '2026-10-24T00:00:00.000Z' },
      'list',
    );
    expect(item).toMatchObject({ kind: 'task', start: '2026-10-24', end: '2026-10-24', completed: true, important: true, urgent: false, notes: '本周' });
  });

  it('没有日期（长期规划）或已删除的任务不显示', () => {
    expect(taskToItem({ id: 't', title: 'x' }, 'list')).toBeNull();
    expect(taskToItem({ id: 't', title: 'x', due: '2026-10-24T00:00:00.000Z', deleted: true }, 'list')).toBeNull();
  });
});

describe('同一天内的排序', () => {
  const base = (p: Partial<CalendarItem>): CalendarItem => ({
    kind: 'task', id: p.title ?? 'x', sourceId: 's', title: 'x', start: '2026-10-24', end: '2026-10-24', time: null, endTime: null,
    color: '', completed: false, important: false, urgent: false, link: null, notes: '', location: '', ...p,
  });

  it('全天事件 → 定时事件 → 未完成任务（重要紧急优先）→ 已完成任务', () => {
    const items = [
      base({ title: '已完成', completed: true }),
      base({ title: '普通任务' }),
      base({ title: '重要紧急', important: true, urgent: true }),
      base({ title: '下午会', kind: 'event', time: '14:00' }),
      base({ title: '上午会', kind: 'event', time: '09:00' }),
      base({ title: '全天', kind: 'event' }),
      base({ title: '重要', important: true }),
    ];
    expect(items.sort(compareItems).map((i) => i.title)).toEqual(['全天', '上午会', '下午会', '重要紧急', '重要', '普通任务', '已完成']);
  });
});
