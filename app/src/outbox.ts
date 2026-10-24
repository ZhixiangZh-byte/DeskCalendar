/**
 * 离线修改队列。
 *
 * - 修改因断网失败时放进队列（localStorage，所有组件共用），界面上先按修改后的样子显示，标为"待同步"；
 * - 队列不空时，新的修改也排在后面，保证按顺序提交；
 * - 联网后按顺序提交：本地新建的条目拿到 Google 的真实 ID 后，队列中针对它的后续修改改用真实 ID；
 * - 断网、服务器错误、限流：停下来，稍后重试；Google 明确拒绝（如条目已在其他设备上删除）：丢弃该项并提示。
 */
import { ApiError } from './google';
import type { CalendarItem } from './model';
import {
  localEventItem,
  localTaskItem,
  matchesQuery,
  withCompleted,
  withEventFields,
  withTaskFields,
  type DataSource,
  type EventFields,
  type NewEvent,
  type Query,
  type TaskFields,
  type TaskTarget,
} from './source';

export type PendingOp =
  | { kind: 'create-task'; tempId: string; target: TaskTarget; listId: string; fields: TaskFields }
  | { kind: 'update-task'; item: CalendarItem; fields: TaskFields & { completed: boolean } }
  | { kind: 'set-completed'; item: CalendarItem; completed: boolean }
  | { kind: 'delete-task'; item: CalendarItem }
  | { kind: 'create-event'; tempId: string; calendar: { id: string; color: string }; ev: NewEvent }
  | { kind: 'update-event'; item: CalendarItem; fields: EventFields }
  | { kind: 'delete-event'; item: CalendarItem };

export type QueuedOp = PendingOp & { opId: string; queuedAt: number };

/** 长期规划清单尚未创建时，离线新建的长期规划暂用的清单 ID（同步时由数据源创建清单） */
export const LONG_TERM_PLACEHOLDER = '__long-term__';

/** 本地新建、尚未同步的条目 ID 前缀 */
export const TEMP_PREFIX = 'local-';

export function newTempId(): string {
  return `${TEMP_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 执行一项修改（联网时直接调用，或提交队列时调用）；删除返回 null */
export async function executeOp(source: DataSource, op: PendingOp): Promise<CalendarItem | null> {
  switch (op.kind) {
    case 'create-task':
      return source.createTask(op.target, op.fields);
    case 'update-task':
      return source.updateTask(op.item, op.fields);
    case 'set-completed':
      return source.setCompleted(op.item, op.completed);
    case 'delete-task':
      await source.deleteTask(op.item);
      return null;
    case 'create-event':
      return source.createEvent(op.calendar, op.ev);
    case 'update-event':
      return source.updateEvent(op.item, op.fields);
    case 'delete-event':
      await source.deleteEvent(op.item);
      return null;
  }
}

/** 修改生效后条目的样子（删除返回 null）；base 为该条目当前显示的样子 */
export function optimisticItem(op: PendingOp, base?: CalendarItem): CalendarItem | null {
  switch (op.kind) {
    case 'create-task':
      return localTaskItem(op.tempId, op.listId, op.fields);
    case 'create-event':
      return localEventItem(op.tempId, op.calendar, op.ev);
    case 'update-task':
      return withTaskFields(base ?? op.item, op.fields);
    case 'set-completed':
      return withCompleted(base ?? op.item, op.completed);
    case 'update-event':
      return withEventFields(base ?? op.item, op.fields);
    case 'delete-task':
    case 'delete-event':
      return null;
  }
}

/** 修改所针对的条目 ID */
export function targetId(op: PendingOp): string {
  return 'tempId' in op ? op.tempId : op.item.id;
}

/** 把待同步的修改叠加到已取回的条目上，供界面显示；受影响的条目标为 pending */
export function applyPending(
  items: readonly CalendarItem[],
  ops: readonly PendingOp[],
  query: Query,
  longTermList: string | null,
): CalendarItem[] {
  if (!ops.length) return items as CalendarItem[];
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const op of ops) {
    const id = targetId(op);
    const next = optimisticItem(op, byId.get(id));
    byId.delete(id);
    if (next && matchesQuery(next, query, longTermList)) byId.set(id, { ...next, pending: true });
  }
  return [...byId.values()];
}

/** 网络、服务器或登录状态导致的失败：保留在队列里稍后重试 */
export function isRetryable(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  // 后台返回的登录 / 网络错误（{ code, message }），如令牌刷新失败、需要重新登录
  if (typeof e === 'object' && e !== null && 'code' in e && 'message' in e) return true;
  if (e instanceof ApiError) return e.status >= 500 || e.status === 429 || e.status === 408;
  return false;
}

/** 本地新建的条目同步后拿到真实 ID：把队列中后续针对它的修改改为真实条目 */
export function remapTemp(ops: QueuedOp[], tempId: string, real: CalendarItem): QueuedOp[] {
  return ops.map((op) =>
    'item' in op && op.item.id === tempId ? { ...op, item: { ...op.item, id: real.id, sourceId: real.sourceId, link: real.link } } : op,
  );
}

const STORAGE_KEY = 'deskcalendar.outbox.v1';

/** 队列存于 localStorage：同源的所有组件窗口共用，每次读写都取最新内容 */
export const outbox = {
  key: STORAGE_KEY,
  list(): QueuedOp[] {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as QueuedOp[];
    } catch {
      return [];
    }
  },
  save(ops: QueuedOp[]): void {
    try {
      if (ops.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(ops));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 存储不可用时队列只能丢失；正常的 WebView2 中不会发生
    }
  },
  add(op: PendingOp): QueuedOp {
    const queued = { ...op, opId: newTempId(), queuedAt: Date.now() } as QueuedOp;
    this.save([...this.list(), queued]);
    return queued;
  },
  clear(): void {
    this.save([]);
  },
};

export interface FlushResult {
  /** 成功提交的项数 */
  done: number;
  /** 被 Google 拒绝而丢弃的项（附原因） */
  dropped: { op: QueuedOp; message: string }[];
  /** 因网络等原因中途停下 */
  blocked: boolean;
}

/**
 * 按顺序提交队列。多个组件可能同时尝试，用 Web Locks 保证同一时刻只有一个在提交（不支持时直接执行）。
 * 每提交一项立即写回队列，中途断网或关闭组件也不会重复提交已成功的项。
 */
export async function flushOutbox(source: DataSource): Promise<FlushResult> {
  const run = async (): Promise<FlushResult> => {
    const result: FlushResult = { done: 0, dropped: [], blocked: false };
    for (;;) {
      const ops = outbox.list();
      const op = ops[0];
      if (!op) break;
      try {
        const created = await executeOp(source, op);
        let rest = outbox.list().filter((o) => o.opId !== op.opId);
        if (created && 'tempId' in op) rest = remapTemp(rest, op.tempId, created);
        outbox.save(rest);
        result.done++;
      } catch (e) {
        if (isRetryable(e)) {
          result.blocked = true;
          break;
        }
        outbox.save(outbox.list().filter((o) => o.opId !== op.opId));
        result.dropped.push({ op, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return result;
  };
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (!locks) return run();
  // 已有组件在提交时直接返回，不排队等待
  return locks.request('deskcalendar-outbox', { ifAvailable: true }, async (lock) =>
    lock ? run() : { done: 0, dropped: [], blocked: false },
  );
}
