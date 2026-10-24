/** Google Calendar / Tasks REST 客户端。访问令牌由后台（Rust）提供；收到 401 时让令牌失效并重试一次。 */
import type { GoogleEvent, GoogleTask } from './model';

const CAL = 'https://www.googleapis.com/calendar/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';

export interface TokenProvider {
  token(): Promise<string>;
  invalidate(): Promise<void>;
}

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GoogleCalendar {
  id: string;
  summary: string;
  backgroundColor?: string;
  primary?: boolean;
  selected?: boolean;
  hidden?: boolean;
  accessRole?: string;
}

export interface GoogleTaskList {
  id: string;
  title: string;
}

type Json = Record<string, unknown>;

export class GoogleClient {
  constructor(
    private readonly tokens: TokenProvider,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async request<T>(method: string, url: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.tokens.token();
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && !retried) {
      await this.tokens.invalidate();
      return this.request<T>(method, url, body, true);
    }
    if (res.status === 204) return {} as T;
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        message = ((JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message);
      } catch {
        // 保留原始文本
      }
      throw new ApiError(res.status, message);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async listAll<T>(url: URL, key = 'items'): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    do {
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await this.request<Json>('GET', url.toString());
      out.push(...((page[key] as T[] | undefined) ?? []));
      pageToken = page.nextPageToken as string | undefined;
    } while (pageToken);
    return out;
  }

  /** 在 Google 日历中处于勾选（显示）状态的日历 */
  async calendars(): Promise<GoogleCalendar[]> {
    const url = new URL(`${CAL}/users/me/calendarList`);
    url.searchParams.set('maxResults', '250');
    const all = await this.listAll<GoogleCalendar>(url);
    return all.filter((c) => c.selected !== false && !c.hidden);
  }

  /** 时间范围内的事件（重复事件按单次展开） */
  async events(calendarId: string, timeMin: Date, timeMax: Date): Promise<GoogleEvent[]> {
    const url = new URL(`${CAL}/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('maxResults', '2500');
    url.searchParams.set('timeMin', timeMin.toISOString());
    url.searchParams.set('timeMax', timeMax.toISOString());
    return this.listAll<GoogleEvent>(url);
  }

  async taskLists(): Promise<GoogleTaskList[]> {
    const url = new URL(`${TASKS}/users/@me/lists`);
    url.searchParams.set('maxResults', '100');
    return this.listAll<GoogleTaskList>(url);
  }

  /** 截止日期在 [dueMin, dueMax) 内的任务，含已完成和已隐藏的 */
  async tasks(listId: string, dueMin: string, dueMax: string): Promise<GoogleTask[]> {
    const url = new URL(`${TASKS}/lists/${encodeURIComponent(listId)}/tasks`);
    url.searchParams.set('maxResults', '100');
    url.searchParams.set('showCompleted', 'true');
    url.searchParams.set('showHidden', 'true');
    url.searchParams.set('dueMin', `${dueMin}T00:00:00.000Z`);
    url.searchParams.set('dueMax', `${dueMax}T00:00:00.000Z`);
    return this.listAll<GoogleTask>(url);
  }

  createTask(listId: string, task: { title: string; due: string; notes?: string }): Promise<GoogleTask> {
    return this.request<GoogleTask>('POST', `${TASKS}/lists/${encodeURIComponent(listId)}/tasks`, {
      title: task.title,
      due: `${task.due}T00:00:00.000Z`,
      ...(task.notes ? { notes: task.notes } : {}),
    });
  }

  /** 修改任务；due 为 YYYY-MM-DD；completed 不传时不改变完成状态 */
  updateTask(
    listId: string,
    taskId: string,
    patch: { title: string; notes: string; due: string; completed?: boolean },
  ): Promise<GoogleTask> {
    const status =
      patch.completed === undefined ? {} : patch.completed ? { status: 'completed' } : { status: 'needsAction', completed: null };
    return this.request<GoogleTask>(
      'PATCH',
      `${TASKS}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      { title: patch.title, notes: patch.notes, due: `${patch.due}T00:00:00.000Z`, ...status },
    );
  }

  async deleteTask(listId: string, taskId: string): Promise<void> {
    await this.request('DELETE', `${TASKS}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`);
  }

  /** 新建定时事件。时间为本地日期时间（YYYY-MM-DDTHH:mm），timeZone 为 IANA 时区名 */
  createEvent(
    calendarId: string,
    ev: { summary: string; description: string; start: string; end: string; timeZone: string },
  ): Promise<GoogleEvent> {
    return this.request<GoogleEvent>('POST', `${CAL}/calendars/${encodeURIComponent(calendarId)}/events`, {
      summary: ev.summary,
      ...(ev.description ? { description: ev.description } : {}),
      start: { dateTime: `${ev.start}:00`, timeZone: ev.timeZone },
      end: { dateTime: `${ev.end}:00`, timeZone: ev.timeZone },
    });
  }

  /** 修改事件（只发送传入的字段）。全天与定时互相转换时，用 null 清掉另一种时间字段 */
  patchEvent(calendarId: string, eventId: string, patch: Record<string, unknown>): Promise<GoogleEvent> {
    return this.request<GoogleEvent>(
      'PATCH',
      `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      patch,
    );
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.request('DELETE', `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  }

  setTaskCompleted(listId: string, taskId: string, completed: boolean): Promise<GoogleTask> {
    return this.request<GoogleTask>(
      'PATCH',
      `${TASKS}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      completed ? { status: 'completed' } : { status: 'needsAction', completed: null },
    );
  }
}
