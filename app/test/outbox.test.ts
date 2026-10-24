import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/google';
import type { CalendarItem } from '../src/model';
import {
  applyPending,
  flushOutbox,
  isRetryable,
  LONG_TERM_PLACEHOLDER,
  newTempId,
  outbox,
  remapTemp,
  type QueuedOp,
} from '../src/outbox';
import { cache, DemoSource, type Query, type Snapshot } from '../src/source';

// Node 里没有 localStorage：用内存实现代替（离线队列每次读写都访问它）
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  (globalThis as { __DESKCAL_DEMO_OFFLINE__?: boolean }).__DESKCAL_DEMO_OFFLINE__ = false;
});

const base = (p: Partial<CalendarItem>): CalendarItem => ({
  kind: 'task', id: p.title ?? 'x', sourceId: 'list', title: 'x', start: '2026-10-24', end: p.start ?? '2026-10-24', time: null,
  endTime: null, endTimeDate: null, color: '', completed: false, completedAt: null, important: false, urgent: false, link: null,
  notes: '', location: '', editable: true, recurring: false, ...p,
});
const range: Query = { kind: 'range', range: { start: '2026-10-01', end: '2026-10-31' } };
const fields = (p: object = {}) => ({ title: '新任务', notes: '', date: '2026-10-25', important: false, urgent: false, ...p });

describe('待同步修改的预览', () => {
  it('新建、修改、勾选、删除都叠加到已取回的条目上，并标为待同步', () => {
    const items = [base({ title: 'A' }), base({ title: 'B' }), base({ title: 'C' })];
    const shown = applyPending(
      items,
      [
        { kind: 'create-task', tempId: 'local-1', target: 'default', listId: 'list', fields: fields() },
        { kind: 'update-task', item: items[0]!, fields: { ...fields({ title: 'A 改', date: '2026-10-26' }), completed: false } },
        { kind: 'set-completed', item: items[1]!, completed: true },
        { kind: 'delete-task', item: items[2]! },
      ],
      range,
      null,
    );
    const by = Object.fromEntries(shown.map((i) => [i.id, i]));
    expect(Object.keys(by).sort()).toEqual(['A', 'B', 'local-1']);
    expect(by['local-1']).toMatchObject({ title: '新任务', start: '2026-10-25', pending: true });
    expect(by.A).toMatchObject({ title: 'A 改', start: '2026-10-26', pending: true });
    expect(by.B).toMatchObject({ completed: true, pending: true });
    expect(by.B!.completedAt).toBeTruthy();
  });

  it('对离线新建的条目再修改：按顺序叠加；修改后不属于当前查询的条目不显示', () => {
    const shown = applyPending(
      [],
      [
        { kind: 'create-task', tempId: 'local-1', target: 'default', listId: 'list', fields: fields() },
        { kind: 'update-task', item: base({ id: 'local-1' }), fields: { ...fields({ title: '改名' }), completed: false } },
        { kind: 'create-task', tempId: 'local-2', target: 'default', listId: 'list', fields: fields({ date: '2026-12-01' }) },
      ],
      range,
      null,
    );
    expect(shown.map((i) => [i.id, i.title])).toEqual([['local-1', '改名']]);
  });

  it('长期规划清单尚未创建时，离线新建的长期规划用占位 ID 显示在长期规划组件里', () => {
    const shown = applyPending(
      [],
      [{ kind: 'create-task', tempId: 'local-1', target: 'long-term', listId: LONG_TERM_PLACEHOLDER, fields: fields({ date: null }) }],
      { kind: 'long-term' },
      LONG_TERM_PLACEHOLDER,
    );
    expect(shown).toHaveLength(1);
  });

  it('同步后拿到真实 ID：队列中后续针对临时条目的修改改用真实 ID', () => {
    const ops = [
      { opId: '1', queuedAt: 0, kind: 'update-task', item: base({ id: 'local-1' }), fields: { ...fields(), completed: false } },
      { opId: '2', queuedAt: 0, kind: 'delete-task', item: base({ id: 'other' }) },
    ] as QueuedOp[];
    const out = remapTemp(ops, 'local-1', base({ id: 'g123', sourceId: 'real-list', link: 'https://x' }));
    expect(out[0]).toMatchObject({ item: { id: 'g123', sourceId: 'real-list', link: 'https://x' } });
    expect(out[1]).toMatchObject({ item: { id: 'other' } });
  });

  it('错误分类：断网、服务器错误、限流、登录问题稍后重试；Google 明确拒绝的不重试', () => {
    expect(isRetryable(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRetryable(new ApiError(503, 'x'))).toBe(true);
    expect(isRetryable(new ApiError(429, 'x'))).toBe(true);
    expect(isRetryable({ code: 'NETWORK', message: 'x' })).toBe(true);
    expect(isRetryable(new ApiError(404, 'x'))).toBe(false);
    expect(isRetryable(new ApiError(400, 'x'))).toBe(false);
  });
});

describe('提交离线队列（用演示数据源模拟 Google）', () => {
  const setOffline = (v: boolean) => ((globalThis as { __DESKCAL_DEMO_OFFLINE__?: boolean }).__DESKCAL_DEMO_OFFLINE__ = v);

  it('断网时停下并保留队列；联网后按顺序提交，临时 ID 换成真实 ID', async () => {
    const source = new DemoSource('2026-10-24');
    const existing = (await source.load(range)).items.find((i) => i.title === '读两篇论文')!;
    const tempId = newTempId();
    outbox.add({ kind: 'create-task', tempId, target: 'default', listId: 'demo-list', fields: fields({ title: '离线新建' }) });
    outbox.add({ kind: 'update-task', item: base({ id: tempId, sourceId: 'demo-list' }), fields: { ...fields({ title: '离线新建（改）' }), completed: false } });
    outbox.add({ kind: 'set-completed', item: existing, completed: true });

    setOffline(true);
    expect(await flushOutbox(source)).toEqual({ done: 0, dropped: [], blocked: true });
    expect(outbox.list()).toHaveLength(3);

    setOffline(false);
    expect(await flushOutbox(source)).toEqual({ done: 3, dropped: [], blocked: false });
    expect(outbox.list()).toEqual([]);
    const after = (await source.load(range)).items;
    const created = after.find((i) => i.title === '离线新建（改）')!;
    expect(created.id.startsWith('local-')).toBe(false);
    expect(after.filter((i) => i.title.startsWith('离线新建'))).toHaveLength(1);
    expect(after.find((i) => i.id === existing.id)!.completed).toBe(true);
  });

  it('Google 拒绝的项（如条目已在别处删除）被丢弃，其余继续提交', async () => {
    const source = new DemoSource('2026-10-24');
    outbox.add({ kind: 'delete-task', item: base({ id: 'already-gone' }) });
    outbox.add({ kind: 'create-task', tempId: newTempId(), target: 'default', listId: 'demo-list', fields: fields({ title: '照常提交' }) });
    const r = await flushOutbox(source);
    expect(r.done).toBe(1);
    expect(r.dropped.map((d) => d.op.kind)).toEqual(['delete-task']);
    expect(r.dropped[0]!.message).toContain('不存在');
    expect(outbox.list()).toEqual([]);
    expect((await source.load(range)).items.some((i) => i.title === '照常提交')).toBe(true);
  });
});

describe('离线时没有自己缓存的组件：从其他组件的缓存中拼出数据', () => {
  // 需要 length / key(i) 的完整内存 localStorage
  function memoryStorage() {
    const store = new Map<string, string>();
    return {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  }

  const snap = (key: string, items: CalendarItem[], fetchedAt: number, extra: Partial<Snapshot> = {}): Snapshot => ({
    key, items, defaultTaskList: 'list', longTermList: 'lt', primaryCalendar: { id: 'cal', color: '#123' },
    fetchedAt, syncedAt: fetchedAt, fullAt: fetchedAt, meta: null, ...extra,
  });

  it('四象限没有缓存时，从月历和长期规划的缓存中挑出未完成的普通任务；同一条目以最近取回的为准', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    cache.write(snap('range:2026-09-28:2026-11-08', [
      base({ title: '旧标题', id: 't1' }),
      base({ title: '已完成', completed: true }),
      base({ kind: 'event', title: '会议' }),
    ], 1000));
    cache.write(snap('long-term', [base({ title: '长期', sourceId: 'lt', start: '', end: '' })], 2000));
    cache.write(snap('review:2026-10-24', [base({ title: '新标题', id: 't1', important: true })], 3000));

    const derived = cache.readOrDerive({ kind: 'open-tasks' })!;
    expect(derived.derived).toBe(true);
    expect(derived.items.map((i) => [i.id, i.title, i.important])).toEqual([['t1', '新标题', true]]);
    expect(derived.longTermList).toBe('lt');
    expect(derived.fullAt).toBe(0); // 联网后一定全量刷新

    const lt = cache.readOrDerive({ kind: 'long-term' })!;
    expect(lt.items.map((i) => i.title)).toEqual(['长期']);
  });

  it('有自己的缓存时优先用自己的；完全没有缓存时返回 null；拼出来的数据不写回缓存', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    expect(cache.readOrDerive({ kind: 'open-tasks' })).toBeNull();
    cache.write(snap('open-tasks', [base({ title: '自己的' })], 1000));
    cache.write(snap('range:2026-09-28:2026-11-08', [base({ title: '别人的', id: 'x2' })], 2000));
    expect(cache.readOrDerive({ kind: 'open-tasks' })!.items.map((i) => i.title)).toEqual(['自己的']);

    const derived = cache.derive({ kind: 'long-term' })!;
    cache.write(derived);
    expect(cache.read({ kind: 'long-term' })).toBeNull();
  });
});
