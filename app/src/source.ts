/**
 * 数据源：按"查询"取得条目，以及任务和事件的增删改。
 * - GoogleSource：Google Calendar（所有勾选显示的日历）+ Google Tasks
 * - DemoSource：内存中的演示数据（界面预览、--demo 启动）
 * 以后接入 Microsoft/Outlook 时，再实现一个只读数据源并合并结果即可。
 */
import { addDays, startOfLocalDay } from './date';
import { ApiError, GoogleClient, type GoogleTaskList, type TokenProvider } from './google';
import { eventToItem, taskToItem, withTags, TASK_COLOR, type CalendarItem } from './model';

/** Google Tasks 中存放长期规划的清单名 */
export const LONG_TERM_LIST = '长期规划';

export interface DateRange {
  /** 含 */
  start: string;
  /** 含 */
  end: string;
}

/** 各组件需要的数据 */
export type Query =
  /** 月历、日视图：日期范围内的事件和任务 */
  | { kind: 'range'; range: DateRange }
  /** 四象限：所有未完成的任务（不含长期规划），有无日期都要 */
  | { kind: 'open-tasks' }
  /** 回顾箱：逾期未完成（日期早于 today）+ completedSince 之后完成的任务 */
  | { kind: 'review'; today: string; completedSince: string }
  /** 长期规划清单中的任务 */
  | { kind: 'long-term' };

export function queryKey(q: Query): string {
  switch (q.kind) {
    case 'range':
      return `range:${q.range.start}:${q.range.end}`;
    case 'review':
      return `review:${q.today}`;
    default:
      return q.kind;
  }
}

/** 全量刷新时记下的日历和任务清单，增量刷新时沿用 */
export interface SnapshotMeta {
  calendars: { id: string; color: string; writable: boolean }[];
  /** 除长期规划外的任务清单 */
  usableLists: string[];
}

export interface Snapshot {
  key: string;
  items: CalendarItem[];
  /** 新建任务写入的清单 */
  defaultTaskList: string | null;
  /** 长期规划清单（尚未创建时为 null） */
  longTermList: string | null;
  /** 新建定时事件写入的日历（主日历），只在日期范围查询中提供 */
  primaryCalendar: { id: string; color: string } | null;
  /** 数据取回的时刻（显示"已同步 HH:mm"） */
  fetchedAt: number;
  /** 本次请求开始的时刻：下次增量刷新取这之后的变化 */
  syncedAt: number;
  /** 上次全量刷新的时刻 */
  fullAt: number;
  meta: SnapshotMeta | null;
  /** 离线时由其他组件的缓存拼出来的数据（可能不完整），不用于增量刷新 */
  derived?: boolean;
}

/** 两次全量刷新的最长间隔；其间只做增量刷新 */
export const FULL_REFRESH_MS = 15 * 60_000;
/** 增量刷新的时间余量，抵消本机与 Google 服务器的时钟偏差（重复取到的条目会被合并，不会重复） */
const UPDATED_MIN_MARGIN_MS = 5 * 60_000;

/** 条目是否属于某个查询（用于增量合并和离线修改的预览） */
export function matchesQuery(item: CalendarItem, query: Query, longTermList: string | null): boolean {
  const longTerm = item.kind === 'task' && longTermList !== null && item.sourceId === longTermList;
  switch (query.kind) {
    case 'range':
      return !longTerm && Boolean(item.start) && item.start <= query.range.end && item.end >= query.range.start;
    case 'open-tasks':
      return item.kind === 'task' && !longTerm && !item.completed;
    case 'review':
      return (
        item.kind === 'task' &&
        !longTerm &&
        ((!item.completed && Boolean(item.start) && item.start < query.today) ||
          (item.completed && (item.completedAt ?? '') >= query.completedSince))
      );
    case 'long-term':
      return longTerm;
  }
}

/** 把增量变化合并进已有条目：删除的移除；修改后不再属于该查询的也移除 */
export function mergeChanges(
  items: readonly CalendarItem[],
  changes: { upserts: CalendarItem[]; removedIds: string[] },
  query: Query,
  longTermList: string | null,
): CalendarItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const id of changes.removedIds) byId.delete(id);
  for (const item of changes.upserts) {
    if (matchesQuery(item, query, longTermList)) byId.set(item.id, item);
    else byId.delete(item.id);
  }
  return [...byId.values()];
}

// ---------- 根据填写内容构造条目（演示数据源和离线修改预览共用） ----------

export function localTaskItem(id: string, sourceId: string, f: TaskFields): CalendarItem {
  return {
    kind: 'task', id, sourceId, title: f.title, start: f.date ?? '', end: f.date ?? '', time: null, endTime: null,
    endTimeDate: null, color: TASK_COLOR, completed: false, completedAt: null, important: f.important, urgent: f.urgent,
    link: null, notes: f.notes, location: '', editable: true, recurring: false,
  };
}

export function withTaskFields(item: CalendarItem, f: TaskFields & { completed: boolean }): CalendarItem {
  return {
    ...item, title: f.title, notes: f.notes, start: f.date ?? '', end: f.date ?? '', important: f.important, urgent: f.urgent,
    completed: f.completed, completedAt: f.completed ? (item.completedAt ?? new Date().toISOString()) : null,
  };
}

export function withCompleted(item: CalendarItem, completed: boolean): CalendarItem {
  return { ...item, completed, completedAt: completed ? (item.completedAt ?? new Date().toISOString()) : null };
}

export function localEventItem(id: string, calendar: { id: string; color: string }, ev: NewEvent): CalendarItem {
  const span = eventSpan(ev);
  return {
    kind: 'event', id, sourceId: calendar.id, title: ev.title, start: ev.date, end: span.end.slice(0, 10),
    time: ev.startTime, endTime: ev.endTime, endTimeDate: span.end.slice(0, 10), color: calendar.color, completed: false,
    completedAt: null, important: false, urgent: false, link: null, notes: ev.notes, location: '', editable: true, recurring: false,
  };
}

export function withEventFields(item: CalendarItem, f: EventFields): CalendarItem {
  return {
    ...item,
    title: f.title,
    notes: f.notes,
    location: f.location,
    start: f.startDate,
    end: f.allDay ? f.endDate : f.endTime === '00:00' && f.endDate > f.startDate ? addDays(f.endDate, -1) : f.endDate,
    time: f.allDay ? null : f.startTime,
    endTime: f.allDay ? null : f.endTime,
    endTimeDate: f.allDay ? null : f.endDate,
  };
}

/** 新建或修改任务时的内容；标题不含末尾的感叹号标记 */
export interface TaskFields {
  title: string;
  notes: string;
  /** YYYY-MM-DD；null 表示不设日期 */
  date: string | null;
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

/** 新任务写入哪里：默认清单，或长期规划清单 */
export type TaskTarget = 'default' | 'long-term';

export interface DataSource {
  /** prev：同一查询的上一份数据；提供且未过期时只取增量 */
  load(query: Query, prev?: Snapshot | null): Promise<Snapshot>;
  createTask(target: TaskTarget, task: TaskFields): Promise<CalendarItem>;
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

const notNull = <T>(x: T | null): x is T => x !== null;

export class GoogleSource implements DataSource {
  private readonly api: GoogleClient;
  /** 最近一次读到的任务清单，用于确定新任务写入哪个清单 */
  private lists: GoogleTaskList[] | null = null;

  constructor(tokens: TokenProvider, fetchImpl?: typeof fetch) {
    this.api = new GoogleClient(tokens, fetchImpl);
  }

  private async taskLists(): Promise<{ usable: GoogleTaskList[]; longTerm: GoogleTaskList | null }> {
    this.lists = await this.api.taskLists();
    return {
      usable: this.lists.filter((l) => l.title !== LONG_TERM_LIST),
      longTerm: this.lists.find((l) => l.title === LONG_TERM_LIST) ?? null,
    };
  }

  async load(query: Query, prev?: Snapshot | null): Promise<Snapshot> {
    const key = queryKey(query);
    if (prev && prev.key === key && prev.meta && Date.now() - prev.fullAt < FULL_REFRESH_MS) {
      return this.loadIncremental(query, prev, prev.meta);
    }
    return this.loadFull(query);
  }

  /** 增量刷新：沿用上次的日历和清单，只取 prev.syncedAt 之后修改或删除的条目并合并 */
  private async loadIncremental(query: Query, prev: Snapshot, meta: SnapshotMeta): Promise<Snapshot> {
    const startedAt = Date.now();
    const updatedMin = new Date(prev.syncedAt - UPDATED_MIN_MARGIN_MS).toISOString();
    const lists = query.kind === 'long-term' ? (prev.longTermList ? [prev.longTermList] : []) : meta.usableLists;
    const upserts: CalendarItem[] = [];
    const removedIds: string[] = [];
    await Promise.all([
      // 任务不加日期过滤：被改到范围之外的任务也要取回，才能从当前视图中移除
      ...lists.map(async (listId) => {
        for (const t of await this.api.tasks(listId, { updatedMin, showDeleted: true })) {
          const item = taskToItem(t, listId);
          if (item) upserts.push(item);
          else removedIds.push(t.id);
        }
      }),
      ...(query.kind === 'range'
        ? meta.calendars.map(async (c) => {
            const timeMin = startOfLocalDay(query.range.start);
            const timeMax = startOfLocalDay(addDays(query.range.end, 1));
            for (const e of await this.api.events(c.id, timeMin, timeMax, { updatedMin })) {
              const item = eventToItem(e, c.id, c.color, c.writable);
              if (item) upserts.push(item);
              else removedIds.push(e.id);
            }
          })
        : []),
    ]);
    return {
      ...prev,
      items: mergeChanges(prev.items, { upserts, removedIds }, query, prev.longTermList),
      fetchedAt: Date.now(),
      syncedAt: startedAt,
    };
  }

  private async loadFull(query: Query): Promise<Snapshot> {
    const startedAt = Date.now();
    const { usable, longTerm } = await this.taskLists();
    const tasksOf = async (lists: GoogleTaskList[], opts: Parameters<GoogleClient['tasks']>[1]) =>
      (await Promise.all(lists.map(async (l) => (await this.api.tasks(l.id, opts)).map((t) => taskToItem(t, l.id))))).flat();

    let items: CalendarItem[];
    let primaryCalendar: Snapshot['primaryCalendar'] = null;
    let calendarMeta: SnapshotMeta['calendars'] = [];
    switch (query.kind) {
      case 'range': {
        const { range } = query;
        const timeMin = startOfLocalDay(range.start);
        const timeMax = startOfLocalDay(addDays(range.end, 1));
        const calendars = await this.api.calendars();
        calendarMeta = calendars.map((c) => ({
          id: c.id,
          color: c.backgroundColor ?? '#9aa5ce',
          writable: c.accessRole === 'owner' || c.accessRole === 'writer',
        }));
        const [eventGroups, tasks] = await Promise.all([
          Promise.all(
            calendarMeta.map(async (c) => (await this.api.events(c.id, timeMin, timeMax)).map((e) => eventToItem(e, c.id, c.color, c.writable))),
          ),
          tasksOf(usable, { dueMin: range.start, dueMax: addDays(range.end, 1) }),
        ]);
        items = [...eventGroups.flat(), ...tasks].filter(notNull);
        const primary = calendars.find((c) => c.primary);
        primaryCalendar = primary ? { id: primary.id, color: primary.backgroundColor ?? '#9aa5ce' } : null;
        break;
      }
      case 'open-tasks':
        items = (await tasksOf(usable, { showCompleted: false })).filter(notNull);
        break;
      case 'review': {
        const [overdue, done] = await Promise.all([
          tasksOf(usable, { showCompleted: false, dueMax: query.today }),
          tasksOf(usable, { completedMin: query.completedSince }),
        ]);
        const byId = new Map<string, CalendarItem>();
        for (const t of [...overdue, ...done].filter(notNull)) {
          if (t.completed || (t.start && t.start < query.today)) byId.set(t.id, t);
        }
        items = [...byId.values()];
        break;
      }
      case 'long-term':
        items = longTerm ? (await tasksOf([longTerm], {})).filter(notNull) : [];
        break;
    }
    const now = Date.now();
    return {
      key: queryKey(query),
      items,
      defaultTaskList: usable[0]?.id ?? null,
      longTermList: longTerm?.id ?? null,
      primaryCalendar,
      fetchedAt: now,
      syncedAt: startedAt,
      fullAt: now,
      meta: { calendars: calendarMeta, usableLists: usable.map((l) => l.id) },
    };
  }

  /** 确定新任务写入的清单；长期规划清单不存在时自动创建 */
  private async targetList(target: TaskTarget): Promise<string> {
    const { usable, longTerm } = this.lists
      ? {
          usable: this.lists.filter((l) => l.title !== LONG_TERM_LIST),
          longTerm: this.lists.find((l) => l.title === LONG_TERM_LIST) ?? null,
        }
      : await this.taskLists();
    if (target === 'long-term') {
      if (longTerm) return longTerm.id;
      const created = await this.api.createTaskList(LONG_TERM_LIST);
      this.lists = [...(this.lists ?? []), created];
      return created.id;
    }
    if (!usable[0]) throw new Error('没有可用的任务清单（请先在 Google Tasks 中建一个清单）');
    return usable[0].id;
  }

  async createTask(target: TaskTarget, task: TaskFields): Promise<CalendarItem> {
    const listId = await this.targetList(target);
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

const DEMO_LIST = 'demo-list';
const DEMO_LONG_TERM = 'demo-longterm';

/** 演示数据：以"今天"为中心生成，便于在没有登录时预览界面 */
export class DemoSource implements DataSource {
  private items: CalendarItem[];
  private seq = 0;

  constructor(todayDate: string) {
    const d = (n: number) => addDays(todayDate, n);
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const blank = {
      completed: false, completedAt: null, important: false, urgent: false, link: null, notes: '', location: '',
      endTime: null, endTimeDate: null, editable: true, recurring: false,
    };
    const ev = (title: string, start: string, time: string | null, color: string, opts: Partial<CalendarItem> = {}): CalendarItem => ({
      ...blank, kind: 'event', id: `e${++this.seq}`, sourceId: 'demo-cal', title, start, end: start, time, color,
      link: 'https://calendar.google.com/', endTimeDate: time ? start : null, ...opts,
    });
    const task = (title: string, date: string, opts: Partial<CalendarItem> = {}): CalendarItem => ({
      ...blank, kind: 'task', id: `t${++this.seq}`, sourceId: DEMO_LIST, title, start: date, end: date, time: null,
      color: TASK_COLOR, ...opts,
    });
    const done = (daysBack: number) => ({ completed: true, completedAt: daysAgo(daysBack) });
    this.items = [
      ev('组会', d(0), '10:00', '#e0af68', { endTime: '11:30', location: 'S2-B3c 会议室', notes: '汇报本周实验进展\n带上测量数据' }),
      ev('实验室安全培训', d(2), '14:30', '#9ece6a', { endTime: '16:00' }),
      ev('学术会议', d(5), null, '#bb9af7', { end: d(7), location: '新加坡国立大学' }),
      ev('学院讲座（他人组织）', d(1), '15:00', '#7dcfff', { endTime: '16:00', editable: false }),
      ev('每周例会', d(7), '09:30', '#e0af68', { endTime: '10:00', recurring: true }),
      ev('导师 1:1', d(-3), '16:00', '#e0af68', { endTime: '16:30' }),
      ev('牙医', d(9), '09:15', '#f7768e', { endTime: '10:00' }),
      ev('午餐讨论', d(0), '12:30', '#9ece6a', { endTime: '13:30' }),
      ev('样品测试', d(0), '15:00', '#7dcfff', { endTime: '17:00' }),
      task('写周报', d(0), { important: true, urgent: true, notes: '本周进展、下周计划' }),
      task('读两篇论文', d(0), { important: true }),
      task('报销发票', d(-2), { urgent: true }),
      task('整理实验数据', d(-1), done(1)),
      task('准备组会 PPT', d(1), { important: true }),
      task('回复合作者邮件', d(3)),
      task('交材料给 IT', d(-6), done(5)),
      task('订机票', d(4), { urgent: true }),
      task('更新实验记录本', d(-4)),
      task('学习新的拟合方法', '', { important: true }),
      task('整理桌面文件', ''),
      task('续签门禁卡', '', { urgent: true }),
      task('完成第一篇论文初稿', '', { sourceId: DEMO_LONG_TERM, important: true, notes: '目标：明年 3 月投稿' }),
      task('学会使用 COMSOL 多物理场耦合', '', { sourceId: DEMO_LONG_TERM }),
      task('每周跑步三次', '', { sourceId: DEMO_LONG_TERM }),
      task('考取潜水证', '', { sourceId: DEMO_LONG_TERM, ...done(10) }),
    ];
  }

  /** 测试离线队列用：在浏览器控制台设置 globalThis.__DESKCAL_DEMO_OFFLINE__ = true，演示数据源的所有请求都会像断网一样失败 */
  private checkOnline(): void {
    if ((globalThis as { __DESKCAL_DEMO_OFFLINE__?: boolean }).__DESKCAL_DEMO_OFFLINE__) throw new TypeError('Failed to fetch（模拟断网）');
  }

  async load(query: Query): Promise<Snapshot> {
    this.checkOnline();
    const items = this.items.filter((i) => matchesQuery(i, query, DEMO_LONG_TERM));
    const now = Date.now();
    return {
      key: queryKey(query),
      items: structuredClone(items),
      defaultTaskList: DEMO_LIST,
      longTermList: DEMO_LONG_TERM,
      primaryCalendar: query.kind === 'range' ? { id: 'demo-cal', color: '#e0af68' } : null,
      fetchedAt: now,
      syncedAt: now,
      fullAt: now,
      meta: null,
    };
  }

  private put(item: CalendarItem): CalendarItem {
    const i = this.items.findIndex((x) => x.id === item.id);
    if (i >= 0) this.items[i] = item;
    else this.items.push(item);
    return structuredClone(item);
  }

  private existing(item: CalendarItem): CalendarItem {
    const found = this.items.find((x) => x.id === item.id);
    if (!found) throw new ApiError(404, '条目不存在（可能已在其他设备上删除）');
    return found;
  }

  async createTask(target: TaskTarget, t: TaskFields): Promise<CalendarItem> {
    this.checkOnline();
    return this.put(localTaskItem(`t${++this.seq}`, target === 'long-term' ? DEMO_LONG_TERM : DEMO_LIST, t));
  }

  async updateTask(item: CalendarItem, f: TaskFields & { completed: boolean }): Promise<CalendarItem> {
    this.checkOnline();
    return this.put(withTaskFields(this.existing(item), f));
  }

  async deleteTask(item: CalendarItem): Promise<void> {
    this.checkOnline();
    this.existing(item);
    this.items = this.items.filter((i) => i.id !== item.id);
  }

  async setCompleted(item: CalendarItem, completed: boolean): Promise<CalendarItem> {
    this.checkOnline();
    return this.put(withCompleted(this.existing(item), completed));
  }

  async createEvent(calendar: { id: string; color: string }, ev: NewEvent): Promise<CalendarItem> {
    this.checkOnline();
    return this.put(localEventItem(`e${++this.seq}`, calendar, ev));
  }

  async updateEvent(item: CalendarItem, f: EventFields): Promise<CalendarItem> {
    this.checkOnline();
    return this.put(withEventFields(this.existing(item), f));
  }

  async deleteEvent(item: CalendarItem): Promise<void> {
    this.checkOnline();
    this.existing(item);
    this.items = this.items.filter((i) => i.id !== item.id);
  }
}

// v5：快照新增 syncedAt / fullAt / meta（增量刷新）
const CACHE_PREFIX = 'deskcalendar.cache.v5:';

/** 本地缓存：启动时先显示上次的数据，离线时也能看 */
export const cache = {
  read(query: Query): Snapshot | null {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + queryKey(query));
      return raw ? (JSON.parse(raw) as Snapshot) : null;
    } catch {
      return null;
    }
  },
  write(snapshot: Snapshot): void {
    if (snapshot.derived) return; // 拼出来的数据不完整，不写回缓存
    try {
      localStorage.setItem(CACHE_PREFIX + snapshot.key, JSON.stringify(snapshot));
    } catch {
      // 存储已满或不可用时忽略
    }
  },
  /** 所有组件的缓存（按取回时间从旧到新） */
  readAll(): Snapshot[] {
    const out: Snapshot[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(CACHE_PREFIX)) continue;
        const raw = localStorage.getItem(key);
        if (raw) out.push(JSON.parse(raw) as Snapshot);
      }
    } catch {
      // 忽略损坏的缓存
    }
    return out.sort((a, b) => a.fetchedAt - b.fetchedAt);
  },
  /**
   * 本查询没有缓存时（如离线时第一次打开某个组件），从其他组件的缓存中挑出属于本查询的条目。
   * 同一条目以最近取回的为准。没有任何缓存时返回 null。
   */
  derive(query: Query): Snapshot | null {
    const all = this.readAll();
    if (!all.length) return null;
    const latest = all[all.length - 1]!;
    const longTermList = [...all].reverse().find((s) => s.longTermList)?.longTermList ?? null;
    const byId = new Map<string, CalendarItem>();
    for (const s of all) for (const item of s.items) byId.set(item.id, item);
    return {
      key: queryKey(query),
      items: [...byId.values()].filter((i) => matchesQuery(i, query, longTermList)),
      defaultTaskList: [...all].reverse().find((s) => s.defaultTaskList)?.defaultTaskList ?? null,
      longTermList,
      primaryCalendar: [...all].reverse().find((s) => s.primaryCalendar)?.primaryCalendar ?? null,
      fetchedAt: latest.fetchedAt,
      syncedAt: 0,
      fullAt: 0,
      meta: null,
      derived: true,
    };
  },
  /** 本查询的缓存；没有时从其他组件的缓存中拼出 */
  readOrDerive(query: Query): Snapshot | null {
    return this.read(query) ?? this.derive(query);
  },
  clear(): void {
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith('deskcalendar.cache.')) localStorage.removeItem(key);
    } catch {
      // 忽略
    }
  },
};
