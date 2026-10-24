/**
 * 五种组件视图：月历、日视图、四象限、回顾箱、长期规划。
 * 每个视图决定要查询什么数据、顶栏标题和导航，以及主体怎么渲染；数据加载和交互由 main.ts 统一处理。
 */
import { addDays, localDateTime, today as todayOf } from './date';
import { lunarFestival, lunarFull, lunarLabel } from './lunar';
import { compareItems, type CalendarItem } from './model';
import { buildMonth, monthRange, shiftMonth } from './month';
import type { Query, Snapshot } from './source';
import { esc, fmtDate, fmtShort, rowHtml, tagDots } from './ui';

export type ViewId = 'month' | 'day' | 'quadrant' | 'review' | 'longterm';

export interface ViewCtx {
  today: string;
  snapshot: Snapshot | null;
  showCompleted: boolean;
  showLunar: boolean;
}

export interface View {
  id: ViewId;
  name: string;
  /** 顶栏是否显示 ‹ 今天 › */
  nav: boolean;
  title(ctx: ViewCtx): string;
  query(ctx: ViewCtx): Query;
  shift(delta: number): void;
  reset(): void;
  bodyClass: string;
  render(ctx: ViewCtx): string;
  /** 渲染后的处理（如日视图滚动到当前时间） */
  afterRender?(body: HTMLElement, ctx: ViewCtx): void;
}

const items = (ctx: ViewCtx) => ctx.snapshot?.items ?? [];

// ---------- 农历 ----------

/** 月历格子里的农历短标签（节日高亮） */
function lunarHtml(date: string): string {
  const l = lunarLabel(date);
  return l ? `<span class="lunar${l.festival ? ' festival' : ''}">${l.text}</span>` : '';
}

/** 日视图顶部的农历行，如"农历 丙午马年 九月十五 · 中秋节" */
function lunarLine(date: string): string {
  const full = lunarFull(date);
  if (!full) return '';
  const festival = lunarFestival(date);
  return `<div class="lunar-line">农历 ${full}${festival ? ` · <span class="festival">${festival}</span>` : ''}</div>`;
}

// ---------- 月历 ----------

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function monthItemHtml(item: CalendarItem, date: string): string {
  if (item.kind === 'event') {
    const continued = item.start < date;
    const label = item.time && !continued ? `<span class="time">${item.time}</span>` : '';
    return `<li class="item event${item.time ? ' timed' : ' allday'}${item.pending ? ' pending' : ''}" style="--c:${esc(item.color)}" data-act="open-event" data-id="${esc(item.id)}" title="${esc(item.title)}">${label}<span class="t">${esc(item.title)}</span></li>`;
  }
  return `<li class="item task${item.completed ? ' done' : ''}${item.pending ? ' pending' : ''}" data-act="open-task" data-id="${esc(item.id)}" title="${esc(item.notes ? `${item.title}\n${item.notes}` : item.title)}">
      <button class="check" data-act="toggle" data-id="${esc(item.id)}" aria-label="${item.completed ? '标记为未完成' : '标记为完成'}"></button>
      <span class="t">${esc(item.title)}</span>${tagDots(item)}</li>`;
}

function monthView(): View {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1;
  return {
    id: 'month',
    name: '月历',
    nav: true,
    bodyClass: 'month-body',
    title: () => `${year}年${month}月`,
    query: () => ({ kind: 'range', range: monthRange(year, month) }),
    shift(delta) {
      ({ year, month } = shiftMonth(year, month, delta));
    },
    reset() {
      const d = new Date();
      year = d.getFullYear();
      month = d.getMonth() + 1;
    },
    render(ctx) {
      const weeks = buildMonth(year, month, items(ctx), { today: ctx.today, showCompleted: ctx.showCompleted });
      const cells = weeks
        .flat()
        .map(
          (d) => `
          <div class="day${d.inMonth ? '' : ' out'}${d.isToday ? ' today' : ''}${d.weekend ? ' weekend' : ''}" data-act="add" data-date="${d.date}">
            <div class="day-head"><span class="num">${d.day}</span>${ctx.showLunar ? lunarHtml(d.date) : ''}</div>
            <ul class="items">${d.items.map((i) => monthItemHtml(i, d.date)).join('')}</ul>
          </div>`,
        )
        .join('');
      return `
        <div class="weekdays">${WEEKDAYS.map((d, i) => `<span class="${i >= 5 ? 'weekend' : ''}">${d}</span>`).join('')}</div>
        <div class="grid">${cells}</div>`;
    },
  };
}

// ---------- 日视图 ----------

/** 时间轴每小时的高度（像素） */
export const HOUR_PX = 36;

export interface PlacedEvent {
  item: CalendarItem;
  /** 当天内的开始、结束分钟（0–1440） */
  startMin: number;
  endMin: number;
  /** 所在列与所在重叠组的列数，用于并排显示重叠的事件 */
  col: number;
  cols: number;
}

const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** 某一天的定时事件在时间轴上的位置；跨天事件在当天截断 */
export function layoutTimeline(all: readonly CalendarItem[], date: string): PlacedEvent[] {
  const placed: PlacedEvent[] = all
    .filter((i) => i.kind === 'event' && i.time !== null && i.start <= date && (i.endTimeDate ?? i.start) >= date)
    .map((item) => {
      const startMin = item.start < date ? 0 : toMin(item.time!);
      const endDate = item.endTimeDate ?? item.start;
      let endMin = endDate > date ? 1440 : item.endTime ? toMin(item.endTime) : startMin + 60;
      endMin = Math.max(endMin, startMin + 20); // 太短的事件也保证看得见
      return { item, startMin, endMin: Math.min(endMin, 1440), col: 0, cols: 1 };
    })
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  // 贪心分列：同一重叠组内取最少的列
  let group: PlacedEvent[] = [];
  let groupEnd = -1;
  const colEnds: number[] = [];
  const flush = () => {
    const cols = Math.max(1, ...group.map((p) => p.col + 1));
    for (const p of group) p.cols = cols;
    group = [];
    colEnds.length = 0;
  };
  for (const p of placed) {
    if (p.startMin >= groupEnd) flush();
    let col = colEnds.findIndex((end) => end <= p.startMin);
    if (col < 0) col = colEnds.length;
    colEnds[col] = p.endMin;
    p.col = col;
    group.push(p);
    groupEnd = Math.max(groupEnd, p.endMin);
  }
  flush();
  return placed;
}

function dayView(): View {
  let date = todayOf();
  let scrolledFor = '';
  return {
    id: 'day',
    name: '日视图',
    nav: true,
    bodyClass: 'day-body',
    // 窄组件里用短格式：10/24 周六
    title: () => fmtDate(date).replace(/^(\d+)月(\d+)日/, '$1/$2'),
    query: () => ({ kind: 'range', range: { start: date, end: date } }),
    shift(delta) {
      date = addDays(date, delta);
    },
    reset() {
      date = todayOf();
    },
    render(ctx) {
      const all = items(ctx);
      const allDay = all
        .filter(
          (i) =>
            i.start &&
            i.start <= date &&
            i.end >= date &&
            (i.kind === 'task' ? ctx.showCompleted || !i.completed : i.time === null),
        )
        .sort(compareItems);
      const placed = layoutTimeline(all, date);
      const hours = Array.from({ length: 24 }, (_, h) => `<div class="hour" style="top:${h * HOUR_PX}px"><span>${h}:00</span></div>`).join('');
      const nowLine =
        date === ctx.today
          ? (() => {
              const n = localDateTime(new Date()).time;
              return `<div class="now-line" style="top:${(toMin(n) / 60) * HOUR_PX}px"></div>`;
            })()
          : '';
      const events = placed
        .map((p) => {
          const top = (p.startMin / 60) * HOUR_PX;
          const height = Math.max(((p.endMin - p.startMin) / 60) * HOUR_PX - 2, 14);
          const left = `calc(var(--gutter) + (100% - var(--gutter)) * ${p.col} / ${p.cols})`;
          const width = `calc((100% - var(--gutter)) / ${p.cols} - 3px)`;
          const time = p.item.start < date ? '（续）' : p.item.time!;
          return `<div class="tl-event${p.item.pending ? ' pending' : ''}" style="top:${top}px;height:${height}px;left:${left};width:${width};--c:${esc(p.item.color)}" data-act="open-event" data-id="${esc(p.item.id)}" title="${esc(`${p.item.time}–${p.item.endTime ?? ''} ${p.item.title}`)}"><span class="time">${time}</span> ${esc(p.item.title)}</div>`;
        })
        .join('');
      return `
        ${ctx.showLunar ? lunarLine(date) : ''}
        <div class="allday" data-scroll="allday" data-act="add" data-date="${date}">
          ${allDay.length ? `<ul class="list">${allDay.map((i) => rowHtml(i)).join('')}</ul>` : '<p class="empty">没有全天日程或任务</p>'}
        </div>
        <div class="timeline-scroll" data-scroll="timeline">
          <div class="timeline" data-act="add-at" data-date="${date}" style="height:${24 * HOUR_PX}px">${hours}${nowLine}${events}</div>
        </div>`;
    },
    afterRender(body, ctx) {
      // 切换日期后滚到合适位置：今天滚到当前时间前一小时，其他日子滚到 8:00
      if (scrolledFor === date) return;
      scrolledFor = date;
      const scroller = body.querySelector<HTMLElement>('.timeline-scroll');
      if (!scroller) return;
      const hour = date === ctx.today ? Math.max(0, new Date().getHours() - 1) : 8;
      scroller.scrollTop = hour * HOUR_PX;
    },
  };
}

// ---------- 四象限 ----------

export interface QuadrantGroups {
  importantUrgent: CalendarItem[];
  importantOnly: CalendarItem[];
  urgentOnly: CalendarItem[];
  neither: CalendarItem[];
}

/** 未完成任务按重要 × 紧急分组；组内按日期排序，没有日期的排最后 */
export function splitQuadrants(all: readonly CalendarItem[]): QuadrantGroups {
  const g: QuadrantGroups = { importantUrgent: [], importantOnly: [], urgentOnly: [], neither: [] };
  for (const t of all) {
    if (t.kind !== 'task' || t.completed) continue;
    if (t.important && t.urgent) g.importantUrgent.push(t);
    else if (t.important) g.importantOnly.push(t);
    else if (t.urgent) g.urgentOnly.push(t);
    else g.neither.push(t);
  }
  const key = (t: CalendarItem) => t.start || '￿';
  for (const list of Object.values(g) as CalendarItem[][]) {
    list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.title.localeCompare(b.title, 'zh-CN')));
  }
  return g;
}

function dateChip(t: CalendarItem, today: string): { chip?: string; chipClass?: string } {
  if (!t.start) return {};
  if (t.start < today) return { chip: fmtShort(t.start), chipClass: 'overdue' };
  if (t.start === today) return { chip: '今天', chipClass: 'today' };
  return { chip: fmtShort(t.start) };
}

function quadrantView(): View {
  return {
    id: 'quadrant',
    name: '四象限',
    nav: false,
    bodyClass: 'quadrant-body',
    title: () => '四象限',
    query: () => ({ kind: 'open-tasks' }),
    shift() {},
    reset() {},
    render(ctx) {
      const g = splitQuadrants(items(ctx));
      const quad = (cls: string, name: string, list: CalendarItem[], imp: boolean, urg: boolean) => `
        <section class="quad ${cls}" data-scroll="${cls}" data-act="add" data-imp="${imp ? 1 : 0}" data-urg="${urg ? 1 : 0}">
          <h2>${name}<span class="count">${list.length || ''}</span></h2>
          <ul class="list">${list.map((t) => rowHtml(t, dateChip(t, ctx.today))).join('')}</ul>
        </section>`;
      return `
        ${quad('q1', '重要且紧急', g.importantUrgent, true, true)}
        ${quad('q2', '重要不紧急', g.importantOnly, true, false)}
        ${quad('q3', '紧急不重要', g.urgentOnly, false, true)}
        ${quad('q4', '不重要不紧急', g.neither, false, false)}`;
    },
  };
}

// ---------- 回顾箱 ----------

export const REVIEW_DAYS = 30;

/** 逾期未完成（最早的在前）与已完成（最近完成的在前） */
export function reviewGroups(all: readonly CalendarItem[], today: string): { overdue: CalendarItem[]; done: CalendarItem[] } {
  const tasks = all.filter((t) => t.kind === 'task');
  return {
    overdue: tasks.filter((t) => !t.completed && t.start && t.start < today).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)),
    done: tasks
      .filter((t) => t.completed)
      .sort((a, b) => ((a.completedAt ?? '') < (b.completedAt ?? '') ? 1 : (a.completedAt ?? '') > (b.completedAt ?? '') ? -1 : 0)),
  };
}

function reviewView(): View {
  return {
    id: 'review',
    name: '回顾箱',
    nav: false,
    bodyClass: 'list-body review-body',
    title: () => '回顾箱',
    query: (ctx) => ({
      kind: 'review',
      today: ctx.today,
      completedSince: new Date(Date.now() - REVIEW_DAYS * 86_400_000).toISOString(),
    }),
    shift() {},
    reset() {},
    render(ctx) {
      const { overdue, done } = reviewGroups(items(ctx), ctx.today);
      const doneChip = (t: CalendarItem) => (t.completedAt ? { chip: `${fmtShort(localDateTime(new Date(t.completedAt)).date)} 完成` } : {});
      return `
        <section>
          <h2>逾期未完成<span class="count">${overdue.length || ''}</span></h2>
          ${overdue.length ? `<ul class="list">${overdue.map((t) => rowHtml(t, dateChip(t, ctx.today))).join('')}</ul>` : '<p class="empty">没有逾期的任务</p>'}
        </section>
        <section>
          <h2>最近 ${REVIEW_DAYS} 天完成<span class="count">${done.length || ''}</span></h2>
          ${done.length ? `<ul class="list">${done.map((t) => rowHtml(t, doneChip(t))).join('')}</ul>` : '<p class="empty">还没有完成的任务</p>'}
        </section>`;
    },
  };
}

// ---------- 长期规划 ----------

function longTermView(): View {
  return {
    id: 'longterm',
    name: '长期规划',
    nav: false,
    bodyClass: 'list-body longterm-body',
    title: () => '长期规划',
    query: () => ({ kind: 'long-term' }),
    shift() {},
    reset() {},
    render(ctx) {
      const all = items(ctx).filter((t) => t.kind === 'task');
      const open = all.filter((t) => !t.completed).sort(compareItems);
      const done = ctx.showCompleted ? all.filter((t) => t.completed).sort(compareItems) : [];
      const rows = [...open, ...done].map((t) => rowHtml(t, t.start ? { chip: fmtShort(t.start) } : {})).join('');
      return `
        <div class="longterm" data-scroll="longterm" data-act="add" data-target="long-term">
          ${rows ? `<ul class="list">${rows}</ul>` : '<p class="empty">还没有长期规划</p>'}
          <button class="add-row" data-act="add" data-target="long-term">＋ 新建长期规划</button>
        </div>`;
    },
  };
}

export function createView(id: string | null): View {
  switch (id) {
    case 'day':
      return dayView();
    case 'quadrant':
      return quadrantView();
    case 'review':
      return reviewView();
    case 'longterm':
      return longTermView();
    default:
      return monthView();
  }
}
