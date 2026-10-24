import { describe, expect, it } from 'vitest';
import { lunarDayName, lunarFestival, lunarFull, lunarLabel, lunarMonthName, lunarOf, lunarYearName, parseMonth } from '../src/lunar';
import { DemoSource } from '../src/source';
import { createView } from '../src/views';

describe('农历换算（与已知日期核对）', () => {
  it.each([
    ['2026-02-17', { year: 2026, month: 1, leap: false, day: 1 }], // 2026 春节
    ['2026-02-16', { year: 2025, month: 12, leap: false, day: 29 }], // 腊月只有 29 天
    ['2026-09-25', { year: 2026, month: 8, leap: false, day: 15 }], // 2026 中秋
    ['2026-10-24', { year: 2026, month: 9, leap: false, day: 15 }],
    ['2025-07-25', { year: 2025, month: 6, leap: true, day: 1 }], // 2025 闰六月初一
    ['2025-08-23', { year: 2025, month: 7, leap: false, day: 1 }],
    ['2033-12-22', { year: 2033, month: 11, leap: true, day: 1 }], // 2033 闰冬月
  ])('%s', (date, expected) => {
    expect(lunarOf(date)).toEqual(expected);
  });

  it('ICU 的月份输出：数字和中文月名两种格式都能解析', () => {
    expect(parseMonth('9')).toEqual({ month: 9, leap: false });
    expect(parseMonth('闰6')).toEqual({ month: 6, leap: true });
    expect(parseMonth('九月')).toEqual({ month: 9, leap: false });
    expect(parseMonth('闰六月')).toEqual({ month: 6, leap: true });
    expect(parseMonth('十一月')).toEqual({ month: 11, leap: false });
    expect(parseMonth('冬月')).toEqual({ month: 11, leap: false });
    expect(parseMonth('腊月')).toEqual({ month: 12, leap: false });
    expect(parseMonth('正月')).toEqual({ month: 1, leap: false });
    expect(parseMonth('十三月')).toBeNull();
    expect(parseMonth('')).toBeNull();
  });

  it('月名、日名用传统写法', () => {
    expect(lunarMonthName({ year: 2026, month: 1, leap: false, day: 1 })).toBe('正月');
    expect(lunarMonthName({ year: 2026, month: 11, leap: false, day: 1 })).toBe('冬月');
    expect(lunarMonthName({ year: 2026, month: 12, leap: false, day: 1 })).toBe('腊月');
    expect(lunarMonthName({ year: 2025, month: 6, leap: true, day: 1 })).toBe('闰六月');
    const day = (d: number) => lunarDayName({ year: 2026, month: 1, leap: false, day: d });
    expect([1, 10, 11, 20, 21, 29, 30].map(day)).toEqual(['初一', '初十', '十一', '二十', '廿一', '廿九', '三十']);
  });

  it('干支纪年与生肖', () => {
    expect(lunarYearName({ year: 2026, month: 1, leap: false, day: 1 })).toBe('丙午马年');
    expect(lunarYearName({ year: 2025, month: 1, leap: false, day: 1 })).toBe('乙巳蛇年');
    expect(lunarYearName({ year: 1984, month: 1, leap: false, day: 1 })).toBe('甲子鼠年');
    expect(lunarFull('2026-10-24')).toBe('丙午马年 九月十五');
  });
});

describe('传统节日与月历标签', () => {
  it('节日：春节、中秋、端午、重阳；除夕取正月初一的前一天（腊月 29 天也正确）', () => {
    expect(lunarFestival('2026-02-17')).toBe('春节');
    expect(lunarFestival('2026-02-16')).toBe('除夕');
    expect(lunarFestival('2026-09-25')).toBe('中秋节');
    expect(lunarFestival('2026-06-19')).toBe('端午节');
    expect(lunarFestival('2026-10-18')).toBe('重阳节');
    expect(lunarFestival('2026-10-24')).toBeNull();
  });

  it('闰月里的同一天不算节日', () => {
    // 2025 闰六月期间没有节日；闰六月十五不是中元节（中元节在七月十五）
    expect(lunarOf('2025-08-08')).toMatchObject({ month: 6, leap: true, day: 15 });
    expect(lunarFestival('2025-08-08')).toBeNull();
  });

  it('月历标签：节日 > 初一显示月名 > 日名', () => {
    expect(lunarLabel('2026-09-25')).toEqual({ text: '中秋节', festival: true });
    expect(lunarLabel('2026-10-10')).toEqual({ text: '九月', festival: false }); // 九月初一
    expect(lunarLabel('2026-10-24')).toEqual({ text: '十五', festival: false });
  });
});

describe('视图中的农历显示', () => {
  it('月历每格显示农历，可以关闭', async () => {
    const view = createView('month');
    const today = '2026-10-24';
    const snapshot = await new DemoSource(today).load(view.query({ today, snapshot: null, showCompleted: true, showLunar: true }));
    const on = view.render({ today, snapshot, showCompleted: true, showLunar: true });
    const off = view.render({ today, snapshot, showCompleted: true, showLunar: false });
    expect(on).toContain('class="lunar"');
    expect(off).not.toContain('class="lunar');
  });

  it('日视图顶部显示农历行', async () => {
    const view = createView('day');
    const today = new Date().toISOString().slice(0, 10);
    const snapshot = await new DemoSource(today).load(view.query({ today, snapshot: null, showCompleted: true, showLunar: true }));
    expect(view.render({ today, snapshot, showCompleted: true, showLunar: true })).toContain('class="lunar-line">农历 ');
    expect(view.render({ today, snapshot, showCompleted: true, showLunar: false })).not.toContain('lunar-line');
  });
});
