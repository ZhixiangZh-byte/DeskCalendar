/**
 * 数据源：负责取得某个日期范围内的条目、新建任务、勾选完成。
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
  fetchedAt: number;
}

export interface NewTask {
  title: string;
  date: string;
  notes: string;
  important: boolean;
  urgent: boolean;
}

export interface DataSource {
  load(range: DateRange): Promise<Snapshot>;
  createTask(listId: string, task: NewTask): Promise<CalendarItem>;
  setCompleted(item: CalendarItem, completed: boolean): Promise<CalendarItem>;
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
          (await this.api.events(c.id, timeMin, timeMax)).map((e) => eventToItem(e, c.id, c.backgroundColor ?? '#9aa5ce')),
        ),
      ),
      Promise.all(usable.map(async (l) => (await this.api.tasks(l.id, range.start, dueMax)).map((t) => taskToItem(t, l.id)))),
    ]);
    const items = [...eventGroups.flat(), ...taskGroups.flat()].filter((x): x is CalendarItem => x !== null);
    return { range, items, defaultTaskList: usable[0]?.id ?? null, fetchedAt: Date.now() };
  }

  async createTask(listId: string, task: NewTask): Promise<CalendarItem> {
    const created = await this.api.createTask(listId, {
      title: task.title,
      due: task.date,
      notes: withTags(task.notes, task),
    });
    return taskToItem(created, listId)!;
  }

  async setCompleted(item: CalendarItem, completed: boolean): Promise<CalendarItem> {
    const updated = await this.api.setTaskCompleted(item.sourceId, item.id, completed);
    return taskToItem(updated, item.sourceId) ?? { ...item, completed };
  }
}

/** 演示数据：以"今天"为中心生成，便于在没有登录时预览界面 */
export class DemoSource implements DataSource {
  private items: CalendarItem[];
  private seq = 0;

  constructor(todayDate: string) {
    const d = (n: number) => addDays(todayDate, n);
    const ev = (title: string, start: string, time: string | null, color: string, end = start): CalendarItem => ({
      kind: 'event', id: `e${++this.seq}`, sourceId: 'demo-cal', title, start, end, time, color,
      completed: false, important: false, urgent: false, link: null, notes: '',
    });
    const task = (title: string, date: string, opts: Partial<CalendarItem> = {}): CalendarItem => ({
      kind: 'task', id: `t${++this.seq}`, sourceId: 'demo-list', title, start: date, end: date, time: null,
      color: TASK_COLOR, completed: false, important: false, urgent: false, link: null, notes: '', ...opts,
    });
    this.items = [
      ev('组会', d(0), '10:00', '#e0af68'),
      ev('实验室安全培训', d(2), '14:30', '#9ece6a'),
      ev('学术会议', d(5), null, '#bb9af7', d(7)),
      ev('导师 1:1', d(-3), '16:00', '#e0af68'),
      ev('牙医', d(9), '09:15', '#f7768e'),
      task('写周报', d(0), { important: true, urgent: true }),
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
    return { range, items: structuredClone(items), defaultTaskList: 'demo-list', fetchedAt: Date.now() };
  }

  async createTask(listId: string, task: NewTask): Promise<CalendarItem> {
    const item: CalendarItem = {
      kind: 'task', id: `t${++this.seq}`, sourceId: listId, title: task.title, start: task.date, end: task.date,
      time: null, color: TASK_COLOR, completed: false, important: task.important, urgent: task.urgent, link: null, notes: task.notes,
    };
    this.items.push(item);
    return structuredClone(item);
  }

  async setCompleted(item: CalendarItem, completed: boolean): Promise<CalendarItem> {
    const found = this.items.find((i) => i.id === item.id);
    if (found) found.completed = completed;
    return { ...item, completed };
  }
}

const CACHE_PREFIX = 'deskcalendar.cache.v1:';

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
      for (const key of Object.keys(localStorage)) if (key.startsWith(CACHE_PREFIX)) localStorage.removeItem(key);
    } catch {
      // 忽略
    }
  },
};
