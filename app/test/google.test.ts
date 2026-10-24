import { describe, expect, it } from 'vitest';
import { ApiError, GoogleClient } from '../src/google';
import { eventToItem, taskToItem } from '../src/model';
import { eventPatch, eventSpan, GoogleSource, type EventFields } from '../src/source';

interface Call {
  method: string;
  url: URL;
  auth: string;
  body: unknown;
}

/** 假的 fetch：按 URL 路径返回预设响应，并记录所有请求 */
function fakeFetch(routes: Record<string, (call: Call) => { status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      auth: headers.authorization ?? '',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    // 路由键形如 'GET /path/suffix' 或 '/path/suffix'（任意方法）
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.includes(' ') ? k.split(' ') : [undefined, k];
      return (!m || m === call.method) && url.pathname.endsWith(p!);
    });
    if (!key) return new Response(JSON.stringify({ error: { message: `no route ${url.pathname}` } }), { status: 404 });
    const res = routes[key]!(call);
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), { status: res.status ?? 200 });
  };
  return { impl: impl as typeof fetch, calls };
}

function tokens() {
  let n = 0;
  let invalidated = 0;
  return {
    provider: { token: async () => `tok${n}`, invalidate: async () => void (invalidated++, n++) },
    get invalidated() {
      return invalidated;
    },
  };
}

describe('GoogleClient', () => {
  it('收到 401 时让令牌失效并用新令牌重试一次', async () => {
    const t = tokens();
    const { impl, calls } = fakeFetch({
      'GET /users/@me/lists': (c) => (c.auth === 'Bearer tok0' ? { status: 401, body: {} } : { body: { items: [{ id: 'l1', title: '我的任务' }] } }),
    });
    const lists = await new GoogleClient(t.provider, impl).taskLists();
    expect(lists).toEqual([{ id: 'l1', title: '我的任务' }]);
    expect(t.invalidated).toBe(1);
    expect(calls.map((c) => c.auth)).toEqual(['Bearer tok0', 'Bearer tok1']);
  });

  it('连续 401 不会无限重试，抛出 ApiError', async () => {
    const t = tokens();
    const { impl, calls } = fakeFetch({ 'GET /users/@me/lists': () => ({ status: 401, body: { error: { message: 'bad' } } }) });
    await expect(new GoogleClient(t.provider, impl).taskLists()).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(2);
  });

  it('自动翻页', async () => {
    const t = tokens();
    const { impl } = fakeFetch({
      'GET /users/me/calendarList': (c) =>
        c.url.searchParams.get('pageToken')
          ? { body: { items: [{ id: 'b', summary: 'B' }, { id: 'hidden', summary: 'H', selected: false }] } }
          : { body: { items: [{ id: 'a', summary: 'A', selected: true }], nextPageToken: 'p2' } },
    });
    const cals = await new GoogleClient(t.provider, impl).calendars();
    expect(cals.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('新建任务：due 只写日期；勾选/取消完成的请求格式', async () => {
    const t = tokens();
    const { impl, calls } = fakeFetch({
      'POST /lists/l1/tasks': (c) => ({ body: { id: 'new', ...(c.body as object), due: '2026-10-24T00:00:00.000Z' } }),
      'PATCH /lists/l1/tasks/new': (c) => ({ body: { id: 'new', title: 'x', due: '2026-10-24T00:00:00.000Z', ...(c.body as object) } }),
    });
    const api = new GoogleClient(t.provider, impl);
    await api.createTask('l1', { title: '写周报', due: '2026-10-24', notes: '#重要' });
    expect(calls[0]!.body).toEqual({ title: '写周报', due: '2026-10-24T00:00:00.000Z', notes: '#重要' });
    await api.setTaskCompleted('l1', 'new', true);
    await api.setTaskCompleted('l1', 'new', false);
    expect(calls[1]!.body).toEqual({ status: 'completed' });
    expect(calls[2]!.body).toEqual({ status: 'needsAction', completed: null });
  });
});

describe('GoogleSource', () => {
  it('合并所有显示中的日历和任务清单；排除"长期规划"清单；新任务写入第一个普通清单', async () => {
    const t = tokens();
    const { impl, calls } = fakeFetch({
      'GET /users/me/calendarList': () => ({ body: { items: [{ id: 'primary@x', summary: '我', backgroundColor: '#123456', primary: true }] } }),
      'GET /users/@me/lists': () => ({ body: { items: [{ id: 'lt', title: '长期规划' }, { id: 'l1', title: '我的任务' }] } }),
      '/events': () => ({
        body: { items: [{ id: 'e1', summary: '组会', start: { dateTime: '2026-10-24T10:00:00+08:00' }, end: { dateTime: '2026-10-24T11:00:00+08:00' } }] },
      }),
      'GET /lists/l1/tasks': () => ({
        body: { items: [{ id: 't1', title: '写周报', due: '2026-10-24T00:00:00.000Z', notes: '#紧急', status: 'needsAction' }] },
      }),
    });
    const snap = await new GoogleSource(t.provider, impl).load({ kind: 'range', range: { start: '2026-09-28', end: '2026-11-08' } });
    expect(snap.defaultTaskList).toBe('l1');
    expect(snap.primaryCalendar).toEqual({ id: 'primary@x', color: '#123456' });
    expect(snap.longTermList).toBe('lt');
    expect(snap.key).toBe('range:2026-09-28:2026-11-08');
    expect(snap.items.map((i) => [i.kind, i.title, i.start, i.time, i.urgent])).toEqual([
      ['event', '组会', '2026-10-24', '10:00', false],
      ['task', '写周报', '2026-10-24', null, true],
    ]);
    expect(snap.items[0]!.color).toBe('#123456');
    expect(calls.some((c) => c.url.pathname.includes('/lists/lt/'))).toBe(false);
    const taskCall = calls.find((c) => c.url.pathname === '/tasks/v1/lists/l1/tasks')!;
    expect(taskCall.url.searchParams.get('dueMin')).toBe('2026-09-28T00:00:00.000Z');
    expect(taskCall.url.searchParams.get('dueMax')).toBe('2026-11-09T00:00:00.000Z');
    const evCall = calls.find((c) => c.url.pathname.endsWith('/events'))!;
    expect(evCall.url.searchParams.get('timeMin')).toBe('2026-09-27T16:00:00.000Z');
  });
});

describe('编辑、删除任务与新建事件', () => {
  it('修改任务：标签写回备注末尾；完成状态没变时不发送 status', async () => {
    const t = tokens();
    const { impl, calls } = fakeFetch({
      'PATCH /lists/l1/tasks/t1': (c) => ({ body: { id: 't1', due: '2026-10-25T00:00:00.000Z', ...(c.body as object) } }),
    });
    const source = new GoogleSource(t.provider, impl);
    const item = taskToItem({ id: 't1', title: '旧', due: '2026-10-24T00:00:00.000Z', status: 'needsAction' }, 'l1')!;
    const updated = await source.updateTask(item, { title: '新', notes: '详情', date: '2026-10-25', important: true, urgent: false, completed: false });
    expect(calls[0]!.body).toEqual({ title: '新', notes: '详情\n#重要', due: '2026-10-25T00:00:00.000Z' });
    expect(updated).toMatchObject({ title: '新', notes: '详情', important: true, start: '2026-10-25' });

    await source.updateTask(updated, { title: '新', notes: '', date: '2026-10-25', important: false, urgent: false, completed: true });
    expect(calls[1]!.body).toEqual({ title: '新', notes: '', due: '2026-10-25T00:00:00.000Z', status: 'completed' });
  });

  it('删除任务', async () => {
    const t = tokens();
    const { impl, calls } = fakeFetch({ 'DELETE /lists/l1/tasks/t1': () => ({ status: 204 }) });
    await new GoogleClient(t.provider, impl).deleteTask('l1', 't1');
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['DELETE /tasks/v1/lists/l1/tasks/t1']);
  });

  it('新建定时事件：本地时间 + 时区名；结束时间不晚于开始时间时视为次日', async () => {
    expect(eventSpan({ title: 'x', notes: '', date: '2026-10-24', startTime: '23:00', endTime: '00:30' })).toEqual({
      start: '2026-10-24T23:00',
      end: '2026-10-25T00:30',
    });
    const t = tokens();
    const { impl, calls } = fakeFetch({
      'POST /calendars/primary%40x/events': (c) => ({ body: { id: 'e1', htmlLink: 'https://x', ...(c.body as object) } }),
    });
    const source = new GoogleSource(t.provider, impl);
    const item = await source.createEvent({ id: 'primary@x', color: '#123' }, { title: '组会', notes: '带数据', date: '2026-10-24', startTime: '14:00', endTime: '15:30' });
    expect(calls[0]!.body).toEqual({
      summary: '组会',
      description: '带数据',
      start: { dateTime: '2026-10-24T14:00:00', timeZone: 'Asia/Singapore' },
      end: { dateTime: '2026-10-24T15:30:00', timeZone: 'Asia/Singapore' },
    });
    expect(item).toMatchObject({ kind: 'event', title: '组会', start: '2026-10-24', time: '14:00', endTime: '15:30', color: '#123', notes: '带数据' });
  });
});

describe('编辑与删除事件', () => {
  const timed = () =>
    eventToItem(
      {
        id: 'e1', summary: '组会', description: '<b>议程</b>', location: '会议室',
        start: { dateTime: '2026-10-24T10:00:00+08:00' }, end: { dateTime: '2026-10-24T11:00:00+08:00' },
      },
      'cal',
      '#123',
      true,
    )!;
  const fields = (p: Partial<EventFields> = {}): EventFields => ({
    title: '组会', notes: '议程', location: '会议室', allDay: false,
    startDate: '2026-10-24', endDate: '2026-10-24', startTime: '10:00', endTime: '11:00', ...p,
  });

  it('没有修改时补丁为空；说明没动就不发送（保留 Google 中的富文本）', () => {
    expect(eventPatch(timed(), fields(), 'Asia/Singapore')).toEqual({});
    expect(eventPatch(timed(), fields({ title: '组会（改）' }), 'Asia/Singapore')).toEqual({ summary: '组会（改）' });
  });

  it('改时间：发送本地时间 + 时区，并清掉全天字段', () => {
    expect(eventPatch(timed(), fields({ startTime: '14:00', endTime: '15:30' }), 'Asia/Singapore')).toEqual({
      start: { dateTime: '2026-10-24T14:00:00', timeZone: 'Asia/Singapore', date: null },
      end: { dateTime: '2026-10-24T15:30:00', timeZone: 'Asia/Singapore', date: null },
    });
  });

  it('改成全天（跨两天）：end.date 为最后一天的次日，并清掉定时字段', () => {
    expect(eventPatch(timed(), fields({ allDay: true, endDate: '2026-10-25' }), 'Asia/Singapore')).toEqual({
      start: { date: '2026-10-24', dateTime: null, timeZone: null },
      end: { date: '2026-10-26', dateTime: null, timeZone: null },
    });
  });

  it('GoogleSource.updateEvent 发送 PATCH 并返回新条目；无修改时不发请求；deleteEvent 发送 DELETE', async () => {
    const t = tokens();
    const { impl, calls } = fakeFetch({
      'PATCH /calendars/cal/events/e1': (c) => ({
        body: {
          id: 'e1', summary: (c.body as { summary?: string }).summary ?? '组会', location: '会议室', organizer: { self: true },
          start: { dateTime: '2026-10-24T10:00:00+08:00' }, end: { dateTime: '2026-10-24T11:00:00+08:00' },
        },
      }),
      'DELETE /calendars/cal/events/e1': () => ({ status: 204 }),
    });
    const source = new GoogleSource(t.provider, impl);
    const item = timed();
    expect(await source.updateEvent(item, fields())).toBe(item);
    expect(calls).toHaveLength(0);
    const updated = await source.updateEvent(item, fields({ title: '组会（改）' }));
    expect(calls[0]).toMatchObject({ method: 'PATCH', body: { summary: '组会（改）' } });
    expect(updated).toMatchObject({ title: '组会（改）', editable: true, color: '#123' });
    await source.deleteEvent(item);
    expect(calls[1]!.method).toBe('DELETE');
  });
});

describe('各组件的查询', () => {
  const lists = { items: [{ id: 'lt', title: '长期规划' }, { id: 'l1', title: '我的任务' }] };
  const task = (id: string, extra: object = {}) => ({ id, title: id, status: 'needsAction', ...extra });

  it('四象限：未完成任务，不限日期，排除长期规划清单', async () => {
    const t = tokens();
    const { impl, calls } = fakeFetch({
      'GET /users/@me/lists': () => ({ body: lists }),
      'GET /lists/l1/tasks': () => ({ body: { items: [task('a'), task('b', { due: '2026-10-24T00:00:00.000Z' })] } }),
    });
    const snap = await new GoogleSource(t.provider, impl).load({ kind: 'open-tasks' });
    expect(snap.items.map((i) => [i.title, i.start])).toEqual([['a', ''], ['b', '2026-10-24']]);
    const call = calls.find((c) => c.url.pathname.endsWith('/lists/l1/tasks'))!;
    expect(call.url.searchParams.get('showCompleted')).toBe('false');
    expect(call.url.searchParams.has('dueMin')).toBe(false);
    expect(calls.some((c) => c.url.pathname.includes('/lists/lt/'))).toBe(false);
    expect(calls.some((c) => c.url.pathname.includes('calendarList'))).toBe(false);
  });

  it('回顾箱：逾期未完成 + 指定时刻后完成的任务，去重', async () => {
    const t = tokens();
    const { impl, calls } = fakeFetch({
      'GET /users/@me/lists': () => ({ body: lists }),
      'GET /lists/l1/tasks': (c) =>
        c.url.searchParams.get('showCompleted') === 'false'
          ? { body: { items: [task('逾期', { due: '2026-10-20T00:00:00.000Z' })] } }
          : {
              body: {
                items: [
                  task('逾期', { due: '2026-10-20T00:00:00.000Z' }),
                  task('已完成', { status: 'completed', completed: '2026-10-22T08:00:00.000Z' }),
                  task('今天未完成', { due: '2026-10-24T00:00:00.000Z' }),
                ],
              },
            },
    });
    const snap = await new GoogleSource(t.provider, impl).load({ kind: 'review', today: '2026-10-24', completedSince: '2026-09-24T00:00:00.000Z' });
    expect(snap.items.map((i) => i.title).sort()).toEqual(['已完成', '逾期']);
    const overdueCall = calls.find((c) => c.url.searchParams.get('showCompleted') === 'false')!;
    expect(overdueCall.url.searchParams.get('dueMax')).toBe('2026-10-24T00:00:00.000Z');
    const doneCall = calls.find((c) => c.url.searchParams.has('completedMin'))!;
    expect(doneCall.url.searchParams.get('completedMin')).toBe('2026-09-24T00:00:00.000Z');
  });

  it('长期规划：读"长期规划"清单；清单不存在时新建任务会先创建清单', async () => {
    const t = tokens();
    let hasList = false;
    const { impl, calls } = fakeFetch({
      'GET /users/@me/lists': () => ({ body: { items: hasList ? lists.items : [{ id: 'l1', title: '我的任务' }] } }),
      'POST /users/@me/lists': (c) => {
        hasList = true;
        return { body: { id: 'lt', ...(c.body as object) } };
      },
      'POST /lists/lt/tasks': (c) => ({ body: { id: 'new', ...(c.body as object) } }),
      'GET /lists/lt/tasks': () => ({ body: { items: [task('学会潜水')] } }),
    });
    const source = new GoogleSource(t.provider, impl);
    const empty = await source.load({ kind: 'long-term' });
    expect(empty.items).toEqual([]);
    expect(empty.longTermList).toBeNull();

    const created = await source.createTask('long-term', { title: '写一本书', notes: '', date: null, important: true, urgent: false });
    expect(calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/users/@me/lists'))!.body).toEqual({ title: '长期规划' });
    expect(calls.find((c) => c.url.pathname.endsWith('/lists/lt/tasks'))!.body).toEqual({ title: '写一本书', notes: '#重要' });
    expect(created).toMatchObject({ sourceId: 'lt', start: '', important: true });

    const snap = await source.load({ kind: 'long-term' });
    expect(snap.items.map((i) => i.title)).toEqual(['学会潜水']);
  });

  it('清除任务日期时 due 发送 null', async () => {
    const t = tokens();
    const { impl, calls } = fakeFetch({ 'PATCH /lists/l1/tasks/t1': (c) => ({ body: { id: 't1', ...(c.body as object) } }) });
    await new GoogleClient(t.provider, impl).updateTask('l1', 't1', { title: 'x', notes: '', due: null });
    expect(calls[0]!.body).toEqual({ title: 'x', notes: '', due: null });
  });
});
