/**
 * 数据源：负责取得某个日期范围内的条目，以及新建、修改、删除和勾选完成任务、新建定时事件。
 * - GoogleSource：Google Calendar（所有勾选显示的日历）+ Google Tasks（除"长期规划"外的清单）
 * - DemoSource：内存中的演示数据（界面预览、--demo 启动）
 * 以后接入 Microsoft/Outlook 时，再实现一个只读数据源并合并结果即可。
 */
import { addDays, startOfLocalDay } from './date';
import { GoogleClient, type TokenProvider } from './google';
import { eventToItem, taskToItem, withTags, TASK_COLOR, type CalendarItem } from './model';

export const LONG_TERM_LIST = '长期规划';

export interface DateRange {
  /** 含 */
  start: string;
  /** 含 */
  end: string;
}

export interface Snapshot {
  range: DateRange;
  items: CalendarItem[];
  /** 新建任务写入的清单 */
  defaultTaskList: string | null;
  /** 新建定时事件写入的日历（主日历） */
  primaryCalendar: { id: string; color: string } | null;
  fetchedAt: number;
}

/** 新建或修改任务时的内容；标题不含末尾的感叹号标记 */
export interface TaskFields {
  title: string;
  notes: string;
  date: string;
  important: boolean;
  urgent: boolean;
}

export interface NewEvent {
  title: string;
  notes: string;
  date: string;
  /** HH:mm */
  startTime: string;
  /** HH:mm；不晚于开始时间时视为次日 */
  endTime: string;
}

/** 编辑事件时的内容 */
export interface EventFields {
  title: string;
  notes: string;
  location: string;
  allDay: boolean;
  startDate: string;
  /** 全天事件：最后一天（含）；定时事件：结束时刻所在日期 */
  endDate: string;
  /** HH:mm，仅定时事件 */
  startTime: string;
  endTime: string;
}

/**
 * 生成事件的 PATCH 内容，只包含相对原条目有变化的字段。
 * 说明（description）没改就不发送，避免把 Google 里的富文本覆盖成纯文本。
 */
export function eventPatch(item: CalendarItem, f: EventFields, timeZone: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (f.title !== item.title) patch.summary = f.title;
  if (f.notes !== item.notes) patch.description = f.notes;
  if (f.location !== item.location) patch.location = f.location;
  const wasAllDay = item.time === null;
  const timeChanged =
    f.allDay !== wasAllDay ||
    f.startDate !== item.start ||
    (f.allDay
      ? f.endDate !== item.end
      : f.startTime !== item.time || f.endTime !== item.endTime || f.endDate !== item.endTimeDate);
  if (timeChanged) {
    if (f.allDay) {
      // 全天事件的 end.date 不含当天
      patch.start = { date: f.startDate, dateTime: null, timeZone: null };
      patch.end = { date: addDays(f.endDate, 1), dateTime: null, timeZone: null };
    } else {
      patch.start = { dateTime: `${f.startDate}T${f.startTime}:00`, timeZone, date: null };
      patch.end = { dateTime: `${f.endDate}T${f.endTime}:00`, timeZone, date: null };
    }
  }
  return patch;
}

export interface DataSource {
  load(range: DateRange): Promise<Snapshot>;
  createTask(listId: string, task: TaskFields): Promise<CalendarItem>;
  updateTask(item: CalendarItem, fields: TaskFields & { completed: boolean }): Promise<CalendarItem>;
  deleteTask(item: CalendarItem): Promise<void>;
  setCompleted(item: CalendarItem, completed: boolean): Promise<CalendarItem>;
  createEvent(calendar: { id: string; color: string }, ev: NewEvent): Promise<CalendarItem>;
  updateEvent(item: CalendarItem, fields: EventFields): Promise<CalendarItem>;
  deleteEvent(item: CalendarItem): Promise<void>;
}

/** 定时事件的开始、结束本地日期时间 */
export function eventSpan(ev: NewEvent): { start: string; end: string } {
  const endDate = ev.endTime > ev.startTime ? ev.date : addDays(ev.date, 1);
  return { start: `${ev.date}T${ev.startTime}`, end: `${endDate}T${ev.endTime}` };
}

export class GoogleSource implements DataSource {
  private readonly api: GoogleClient;

  constructor(tokens: TokenProvider, fetchImpl?: typeof fetch) {
    this.api = new GoogleClient(tokens, fetchImpl);
  }

  async load(range: DateRange): Promise<Snapshot> {
    const timeMin = startOfLocalDay(range.start);
    const timeMax = startOfLocalDay(addDays(range.end, 1));
    const dueMax = addDays(range.end, 1);
    const [calendars, lists] = await Promise.all([this.api.calendars(), this.api.taskLists()]);
    const usable = lists.filter((l) => l.title !== LONG_TERM_LIST);
    const [eventGroups, taskGroups] = await Promise.all([
      Promise.all(
        calendars.map(async (c) =>
          (await this.api.events(c.id, timeMin, timeMax)).map((e) =>
            eventToItem(e, c.id, c.backgroundColor ?? '#9aa5ce', c.accessRole === 'owner' || c.accessRole === 'writer'),
          ),
        ),
      ),
      Promise.all(usable.map(async (l) => (await this.api.tasks(l.id, range.start, dueMax)).map((t) => taskToItem(t, l.id)))),
    ]);
    const items = [...eventGroups.flat(), ...taskGroups.flat()].filter((x): x is CalendarItem => x !== null);
    const primary = calendars.find((c) => c.primary);
    return {
      range,
      items,
      defaultTaskList: usable[0]?.id ?? null,
      primaryCalendar: primary ? { id: primary.id, color: primary.backgroundColor ?? '#9aa5ce' } : null,
      fetchedAt: Date.now(),
    };
  }

  async createTask(listId: string, task: TaskFields): Promise<CalendarItem> {
    const created = await this.api.createTask(listId, { title: task.title, due: task.date, notes: withTags(task.notes, task) });
    return taskToItem(created, listId)!;
  }

  async updateTask(item: CalendarItem, f: TaskFields & { completed: boolean }): Promise<CalendarItem> {
    const updated = await this.api.updateTask(item.sourceId, item.id, {
      title: f.title,
      notes: withTags(f.notes, f),
      due: f.date,
      ...(f.completed !== item.completed ? { completed: f.completed } : {}),
    });
    return taskToItem(updated, item.sourceId)!;
  }

  deleteTask(item: CalendarItem): Promise<void> {
    return this.api.deleteTask(item.sourceId, item.id);
  }

  async setCompleted(item: CalendarItem, completed: boolean): Promise<CalendarItem> {
    const updated = await this.api.setTaskCompleted(item.sourceId, item.id, completed);
    return taskToItem(updated, item.sourceId) ?? { ...item, completed };
  }

  async createEvent(calendar: { id: string; color: string }, ev: NewEvent): Promise<CalendarItem> {
    const span = eventSpan(ev);
    const created = await this.api.createEvent(calendar.id, {
      summary: ev.title,
      description: ev.notes,
      start: span.start,
      end: span.end,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    return eventToItem(created, calendar.id, calendar.color, true)!;
  }

  async updateEvent(item: CalendarItem, f: EventFields): Promise<CalendarItem> {
    const patch = eventPatch(item, f, Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (Object.keys(patch).length === 0) return item;
    const updated = await this.api.patchEvent(item.sourceId, item.id, patch);
    return eventToItem(updated, item.sourceId, item.color, true) ?? item;
  }

  deleteEvent(item: CalendarItem): Promise<void> {
    return this.api.deleteEvent(item.sourceId, item.id);
  }
}

/** 演示数据：以"今天"为中心生成，便于在没有登录时预览界面 */
export class DemoSource implements DataSource {
  private items: CalendarItem[];
  private seq = 0;

  constructor(todayDate: string) {
    const d = (n: number) => addDays(todayDate, n);
    const blank = {
      completed: false, important: false, urgent: false, link: null, notes: '', location: '', endTime: null, endTimeDate: null,
      editable: true, recurring: false,
    };
    const ev = (title: string, start: string, time: string | null, color: string, opts: Partial<CalendarItem> = {}): CalendarItem => ({
      ...blank, kind: 'event', id: `e${++this.seq}`, sourceId: 'demo-cal', title, start, end: start, time, color,
      link: 'https://calendar.google.com/', endTimeDate: time ? start : null, ...opts,
    });
    const task = (title: string, date: string, opts: Partial<CalendarItem> = {}): CalendarItem => ({
      ...blank, kind: 'task', id: `t${++this.seq}`, sourceId: 'demo-list', title, start: date, end: date, time: null,
      color: TASK_COLOR, ...opts,
    });
    this.items = [
      ev('组会', d(0), '10:00', '#e0af68', { endTime: '11:30', location: 'S2-B3c 会议室', notes: '汇报本周实验进展\n带上测量数据' }),
      ev('实验室安全培训', d(2), '14:30', '#9ece6a', { endTime: '16:00' }),
      ev('学术会议', d(5), null, '#bb9af7', { end: d(7), location: '新加坡国立大学' }),
      ev('学院讲座（他人组织）', d(1), '15:00', '#7dcfff', { endTime: '16:00', editable: false }),
      ev('每周例会', d(7), '09:30', '#e0af68', { endTime: '10:00', recurring: true }),
      ev('导师 1:1', d(-3), '16:00', '#e0af68', { endTime: '16:30' }),
      ev('牙医', d(9), '09:15', '#f7768e', { endTime: '10:00' }),
      task('写周报', d(0), { important: true, urgent: true, notes: '本周进展、下周计划' }),
      task('读两篇论文', d(0), { important: true }),
      task('报销发票', d(-2), { urgent: true }),
      task('整理实验数据', d(-1), { completed: true }),
      task('准备组会 PPT', d(1), { important: true }),
      task('回复合作者邮件', d(3)),
      task('交材料给 IT', d(-6), { completed: true }),
      task('订机票', d(4), { urgent: true }),
    ];
  }

  async load(range: DateRange): Promise<Snapshot> {
    const items = this.items.filter((i) => i.end >= range.start && i.start <= range.end);
    return {
      range,
      items: structuredClone(items),
      defaultTaskList: 'demo-list',
      primaryCalendar: { id: 'demo-cal', color: '#e0af68' },
      fetchedAt: Date.now(),
    };
  }

  private put(item: CalendarItem): CalendarItem {
    const i = this.items.findIndex((x) => x.id === item.id);
    if (i >= 0) this.items[i] = item;
    else this.items.push(item);
    return structuredClone(item);
  }

  async createTask(listId: string, t: TaskFields): Promise<CalendarItem> {
    return this.put({
      kind: 'task', id: `t${++this.seq}`, sourceId: listId, title: t.title, start: t.date, end: t.date, time: null, endTime: null,
      color: TASK_COLOR, completed: false, important: t.important, urgent: t.urgent, link: null, notes: t.notes, location: '',
      endTimeDate: null, editable: true, recurring: false,
    });
  }

  async updateTask(item: CalendarItem, f: TaskFields & { completed: boolean }): Promise<CalendarItem> {
    return this.put({ ...item, title: f.title, notes: f.notes, start: f.date, end: f.date, important: f.important, urgent: f.urgent, completed: f.completed });
  }

  async deleteTask(item: CalendarItem): Promise<void> {
    this.items = this.items.filter((i) => i.id !== item.id);
  }

  async setCompleted(item: CalendarItem, completed: boolean): Promise<CalendarItem> {
    return this.put({ ...item, completed });
  }

  async createEvent(calendar: { id: string; color: string }, ev: NewEvent): Promise<CalendarItem> {
    const span = eventSpan(ev);
    return this.put({
      kind: 'event', id: `e${++this.seq}`, sourceId: calendar.id, title: ev.title, start: ev.date, end: span.end.slice(0, 10),
      time: ev.startTime, endTime: ev.endTime, endTimeDate: span.end.slice(0, 10), color: calendar.color, completed: false,
      important: false, urgent: false, link: null, notes: ev.notes, location: '', editable: true, recurring: false,
    });
  }

  async updateEvent(item: CalendarItem, f: EventFields): Promise<CalendarItem> {
    return this.put({
      ...item,
      title: f.title,
      notes: f.notes,
      location: f.location,
      start: f.startDate,
      end: f.allDay ? f.endDate : f.endTime === '00:00' && f.endDate > f.startDate ? addDays(f.endDate, -1) : f.endDate,
      time: f.allDay ? null : f.startTime,
      endTime: f.allDay ? null : f.endTime,
      endTimeDate: f.allDay ? null : f.endDate,
    });
  }

  async deleteEvent(item: CalendarItem): Promise<void> {
    this.items = this.items.filter((i) => i.id !== item.id);
  }
}

// v3：条目新增 endTimeDate / editable / recurring 字段
const CACHE_PREFIX = 'deskcalendar.cache.v3:';

/** 本地缓存：启动时先显示上次的数据，离线时也能看 */
export const cache = {
  read(range: DateRange): Snapshot | null {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + range.start);
      return raw ? (JSON.parse(raw) as Snapshot) : null;
    } catch {
      return null;
    }
  },
  write(snapshot: Snapshot): void {
    try {
      localStorage.setItem(CACHE_PREFIX + snapshot.range.start, JSON.stringify(snapshot));
    } catch {
      // 存储已满或不可用时忽略
    }
  },
  clear(): void {
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith('deskcalendar.cache.')) localStorage.removeItem(key);
    } catch {
      // 忽略
    }
  },
};
