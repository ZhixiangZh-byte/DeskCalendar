/**
 * 统一的条目模型：把 Google Calendar 事件和 Google Tasks 任务转换成月历上显示的同一种结构。
 * 以后接入 Microsoft/Outlook 时，只需再写一个转换函数。
 */
import { addDays, localDateTime } from './date';

export type ItemKind = 'event' | 'task';

export interface CalendarItem {
  kind: ItemKind;
  /** Google 中的 ID */
  id: string;
  /** 所属日历 ID 或任务清单 ID */
  sourceId: string;
  title: string;
  /** 起始日期（本地）YYYY-MM-DD */
  start: string;
  /** 结束日期（含）；单日条目等于 start */
  end: string;
  /** 开始时间 HH:mm；全天事件和任务为 null */
  time: string | null;
  color: string;
  completed: boolean;
  important: boolean;
  urgent: boolean;
  /** 在 Google 网页中打开的链接 */
  link: string | null;
  /** 任务备注（不含末尾标签行） */
  notes: string;
}

export const TASK_COLOR = '#7aa2f7';
export const TAG_IMPORTANT = '#重要';
export const TAG_URGENT = '#紧急';
const TAG_LINE = /^\s*(#重要|#紧急)(\s+(#重要|#紧急))*\s*$/;

/** 解析备注末尾的四象限标签行（只认最后一个非空行，且整行只能由标签组成） */
export function parseTags(notes: string | undefined): { body: string; important: boolean; urgent: boolean } {
  const text = (notes ?? '').replace(/\s+$/, '');
  const lines = text.split('\n');
  const last = lines[lines.length - 1] ?? '';
  if (!TAG_LINE.test(last)) return { body: text, important: false, urgent: false };
  return {
    body: lines.slice(0, -1).join('\n').replace(/\s+$/, ''),
    important: last.includes(TAG_IMPORTANT),
    urgent: last.includes(TAG_URGENT),
  };
}

/** 生成带标签行的备注（没有标签时不追加） */
export function withTags(body: string, tags: { important: boolean; urgent: boolean }): string {
  const parts = [tags.important && TAG_IMPORTANT, tags.urgent && TAG_URGENT].filter(Boolean);
  const clean = parseTags(body).body;
  if (!parts.length) return clean;
  return clean ? `${clean}\n${parts.join(' ')}` : parts.join(' ');
}

/** Google Calendar 事件（只列出用到的字段） */
export interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}

/** Google Tasks 任务（只列出用到的字段） */
export interface GoogleTask {
  id: string;
  title?: string;
  notes?: string;
  status?: 'needsAction' | 'completed';
  due?: string;
  deleted?: boolean;
  hidden?: boolean;
  webViewLink?: string;
}

export function eventToItem(ev: GoogleEvent, calendarId: string, color: string): CalendarItem | null {
  if (ev.status === 'cancelled' || !ev.start || !ev.end) return null;
  let start: string;
  let end: string;
  let time: string | null = null;
  if (ev.start.date && ev.end.date) {
    // 全天事件：end.date 不含当天
    start = ev.start.date;
    end = addDays(ev.end.date, -1);
  } else if (ev.start.dateTime && ev.end.dateTime) {
    const s = localDateTime(new Date(ev.start.dateTime));
    const e = localDateTime(new Date(ev.end.dateTime));
    start = s.date;
    time = s.time;
    // 结束于次日 00:00 的事件不算占用次日
    end = e.time === '00:00' && e.date > s.date ? addDays(e.date, -1) : e.date;
  } else {
    return null;
  }
  if (end < start) end = start;
  return {
    kind: 'event',
    id: ev.id,
    sourceId: calendarId,
    title: ev.summary?.trim() || '（无标题）',
    start,
    end,
    time,
    color,
    completed: false,
    important: false,
    urgent: false,
    link: ev.htmlLink ?? null,
    notes: '',
  };
}

/** 没有截止日期的任务（如长期规划）不显示在月历上，返回 null */
export function taskToItem(t: GoogleTask, listId: string): CalendarItem | null {
  if (t.deleted || !t.due) return null;
  // Tasks API 的 due 只保存日期，形如 2026-10-24T00:00:00.000Z，取日期部分即可
  const date = t.due.slice(0, 10);
  const tags = parseTags(t.notes);
  return {
    kind: 'task',
    id: t.id,
    sourceId: listId,
    title: t.title?.trim() || '（无标题）',
    start: date,
    end: date,
    time: null,
    color: TASK_COLOR,
    completed: t.status === 'completed',
    important: tags.important,
    urgent: tags.urgent,
    link: t.webViewLink ?? null,
    notes: tags.body,
  };
}

/**
 * 同一天内的显示顺序：全天事件 → 定时事件（按时间） → 未完成任务（重要/紧急优先） → 已完成任务
 */
export function compareItems(a: CalendarItem, b: CalendarItem): number {
  const rank = (x: CalendarItem) => (x.kind === 'event' ? (x.time === null ? 0 : 1) : x.completed ? 3 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1 && a.time !== b.time) return a.time! < b.time! ? -1 : 1;
  if (ra === 2) {
    const pa = Number(a.important) * 2 + Number(a.urgent);
    const pb = Number(b.important) * 2 + Number(b.urgent);
    if (pa !== pb) return pb - pa;
  }
  return a.title.localeCompare(b.title, 'zh-CN') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
