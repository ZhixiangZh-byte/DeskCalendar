/**
 * Google Calendar / Tasks 可行性验证脚本（Node 24 直接运行：node verify-google.ts）。
 *
 * 做的事：
 * 1. 桌面应用 OAuth（本机回环地址 + PKCE），并验证刷新令牌可用；
 * 2. 只读统计你现有的日历和任务（只记数量和字段名，不记标题内容）；
 * 3. 在主日历建一个测试事件、在一个新建的测试任务清单里建测试任务，验证读写、完成、增量同步，最后全部删除。
 *
 * 令牌只保存在内存里，脚本结束即丢弃。结果写入同目录的 report.json（不含令牌）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exec } from 'node:child_process';

const CLIENT_FILE = join(homedir(), '.deskcalendar', 'google-oauth-client.json');
const REPORT_FILE = join(import.meta.dirname, 'report.json');
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/tasks',
];
const TEST_TAG = '[DeskCalendar 验证·可删除]';

type Json = Record<string, any>;
interface Check {
  id: string;
  name: string;
  ok: boolean;
  detail?: unknown;
}

const checks: Check[] = [];
const cleanup: (() => Promise<unknown>)[] = [];
let accessToken = '';

function record(id: string, name: string, ok: boolean, detail?: unknown): void {
  checks.push({ id, name, ok, ...(detail !== undefined && { detail }) });
  console.log(`${ok ? '✔' : '✘'} ${id} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function oauth(): Promise<{ refreshToken: string; clientId: string; clientSecret: string }> {
  const raw = JSON.parse(readFileSync(CLIENT_FILE, 'utf8')) as Json;
  const client = raw.installed as Json | undefined;
  if (!client) throw new Error('客户端文件里没有 "installed" 段：请确认创建的是"桌面应用"类型的 OAuth 客户端');
  const clientId: string = client.client_id;
  const clientSecret: string = client.client_secret;

  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      const ok = !err && url.searchParams.get('state') === state && url.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ok ? '<h2>授权成功，可以关闭此页面，回到终端查看结果。</h2>' : `<h2>授权失败：${err ?? 'state 不匹配'}</h2>`);
      server.close();
      if (ok) resolve({ code: url.searchParams.get('code')!, redirectUri });
      else reject(new Error(`授权失败：${err ?? 'state 不匹配'}`));
    });
    let redirectUri = '';
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      redirectUri = `http://127.0.0.1:${port}`;
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        prompt: 'consent',
      }).toString();
      console.log('\n请在浏览器中完成授权（如未自动打开，请复制下面的链接）：\n');
      console.log(auth.toString() + '\n');
      exec(`start "" "${auth.toString()}"`);
    });
  });

  const token = await postForm('https://oauth2.googleapis.com/token', {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  const granted = String(token.scope ?? '').split(' ');
  record('G1', 'OAuth 授权并取得刷新令牌', Boolean(token.refresh_token) && SCOPES.every((s) => granted.includes(s)), {
    scopesGranted: SCOPES.filter((s) => granted.includes(s)).map((s) => s.split('/').pop()),
    accessTokenTtlSec: token.expires_in,
  });
  accessToken = token.access_token;
  return { refreshToken: token.refresh_token, clientId, clientSecret };
}

async function postForm(url: string, form: Record<string, string>): Promise<Json> {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(form) });
  const body = (await res.json()) as Json;
  if (!res.ok) throw new Error(`${url} → ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function api(method: string, url: string, body?: unknown): Promise<Json> {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (res.status === 204) return {};
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Json) : {};
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}

async function listAll(url: string, itemsKey = 'items'): Promise<{ items: Json[]; last: Json }> {
  const items: Json[] = [];
  let pageToken: string | undefined;
  let last: Json = {};
  do {
    const u = new URL(url);
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    last = await api('GET', u.toString());
    items.push(...((last[itemsKey] as Json[] | undefined) ?? []));
    pageToken = last.nextPageToken;
  } while (pageToken);
  return { items, last };
}

const CAL = 'https://www.googleapis.com/calendar/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';

function localDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

async function verifyCalendar(): Promise<void> {
  const { items: cals } = await listAll(`${CAL}/users/me/calendarList?maxResults=250`);
  const primary = cals.find((c) => c.primary);
  const tz: string = primary?.timeZone ?? 'Asia/Singapore';
  record('G2', '读取日历列表', cals.length > 0 && Boolean(primary), {
    calendars: cals.length,
    writable: cals.filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer').length,
    primaryTimeZone: tz,
  });

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const { items: monthEvents } = await listAll(
    `${CAL}/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=${monthStart.toISOString()}&timeMax=${monthEnd.toISOString()}`,
  );
  record('G3', '读取本月主日历事件（展开重复事件）', true, {
    events: monthEvents.length,
    allDay: monthEvents.filter((e) => e.start?.date).length,
    eventTypes: [...new Set(monthEvents.map((e) => e.eventType))],
  });

  // 增量同步：先做一次全量，拿到 nextSyncToken
  const { last: syncBase } = await listAll(`${CAL}/calendars/primary/events?maxResults=250&showDeleted=true&timeMin=${monthStart.toISOString()}`);
  // 注意：带 timeMin 时不返回 syncToken，所以另做一次不带时间范围的全量
  const { last: full } = syncBase.nextSyncToken ? { last: syncBase } : await listAll(`${CAL}/calendars/primary/events?maxResults=2500&showDeleted=true`);
  const syncToken: string | undefined = full.nextSyncToken;

  // 建测试事件：明天 08:00–08:15（本地时区），带私有扩展属性
  const tomorrow = localDate(new Date(Date.now() + 86_400_000), tz);
  const created = await api('POST', `${CAL}/calendars/primary/events`, {
    summary: `${TEST_TAG} 测试事件`,
    description: '由 DeskCalendar 可行性验证脚本创建，会自动删除。',
    start: { dateTime: `${tomorrow}T08:00:00`, timeZone: tz },
    end: { dateTime: `${tomorrow}T08:15:00`, timeZone: tz },
    extendedProperties: { private: { deskcalendar: 'feasibility' } },
    reminders: { useDefault: false },
  });
  cleanup.push(() => api('DELETE', `${CAL}/calendars/primary/events/${created.id}`).catch(() => undefined));
  const got = await api('GET', `${CAL}/calendars/primary/events/${created.id}`);
  record('G4', '新建带具体时间的事件并读回（含私有扩展属性）', got.start?.dateTime?.includes('T08:00:00') && got.extendedProperties?.private?.deskcalendar === 'feasibility', {
    start: got.start,
  });

  const patched = await api('PATCH', `${CAL}/calendars/primary/events/${created.id}`, { summary: `${TEST_TAG} 测试事件（已修改）` });
  record('G5', '修改事件（返回新 etag，可用于冲突检测）', patched.etag !== got.etag && patched.summary.endsWith('（已修改）'));

  if (syncToken) {
    const delta = await api('GET', `${CAL}/calendars/primary/events?syncToken=${encodeURIComponent(syncToken)}`);
    const found = ((delta.items as Json[]) ?? []).some((e) => e.id === created.id);
    record('G6', '用 syncToken 增量同步能拿到新事件', found, { changes: (delta.items as Json[] | undefined)?.length ?? 0 });
  } else {
    record('G6', '用 syncToken 增量同步能拿到新事件', false, '没有拿到 nextSyncToken');
  }

  await api('DELETE', `${CAL}/calendars/primary/events/${created.id}`);
  cleanup.pop();
  const afterDelete = await api('GET', `${CAL}/calendars/primary/events/${created.id}`);
  record('G7', '删除事件（删除后状态为 cancelled，增量同步可感知）', afterDelete.status === 'cancelled');
}

async function verifyTasks(): Promise<void> {
  const { items: lists } = await listAll(`${TASKS}/users/@me/lists?maxResults=100`);
  // 只读统计现有任务：数量和出现过的字段名（用于判断 API 是否暴露重复规则等信息）
  let total = 0;
  let withDue = 0;
  let completed = 0;
  const fieldNames = new Set<string>();
  for (const list of lists) {
    const { items } = await listAll(`${TASKS}/lists/${list.id}/tasks?maxResults=100&showCompleted=true&showHidden=true`);
    total += items.length;
    withDue += items.filter((t) => t.due).length;
    completed += items.filter((t) => t.status === 'completed').length;
    for (const t of items) for (const k of Object.keys(t)) fieldNames.add(k);
  }
  record('T1', '读取任务清单与现有任务（只统计）', lists.length > 0, {
    lists: lists.length,
    tasks: total,
    withDue,
    completed,
    fieldNames: [...fieldNames].sort(),
  });

  const list = await api('POST', `${TASKS}/users/@me/lists`, { title: `${TEST_TAG} 测试清单` });
  cleanup.push(() => api('DELETE', `${TASKS}/users/@me/lists/${list.id}`).catch(() => undefined));

  // 截止时间故意写 15:30，验证 API 是否丢弃时间部分
  const today = localDate(new Date(), 'Asia/Singapore');
  const notes = '第一行备注\n#重要 #紧急';
  const before = new Date().toISOString();
  const task = await api('POST', `${TASKS}/lists/${list.id}/tasks`, {
    title: `${TEST_TAG} 测试任务`,
    notes,
    due: `${today}T15:30:00.000Z`,
  });
  record('T2', '新建带日期的任务；备注末尾标签原样保存', task.notes === notes && String(task.due).startsWith(today), { due: task.due });
  record('T3', '确认截止时间的"时间部分"被丢弃（符合文档）', task.due === `${today}T00:00:00.000Z`, { due: task.due });

  const done = await api('PATCH', `${TASKS}/lists/${list.id}/tasks/${task.id}`, { status: 'completed' });
  record('T4', '勾选完成（自动记录完成时间）', done.status === 'completed' && Boolean(done.completed), { completed: done.completed });

  const { items: incremental } = await listAll(
    `${TASKS}/lists/${list.id}/tasks?showCompleted=true&showHidden=true&updatedMin=${encodeURIComponent(before)}`,
  );
  record('T5', '用 updatedMin 增量获取变化的任务（含已完成）', incremental.some((t) => t.id === task.id));

  const undone = await api('PATCH', `${TASKS}/lists/${list.id}/tasks/${task.id}`, { status: 'needsAction', completed: null });
  record('T6', '取消完成', undone.status === 'needsAction' && !undone.completed);

  const noDue = await api('POST', `${TASKS}/lists/${list.id}/tasks`, { title: `${TEST_TAG} 无日期任务（模拟长期规划）` });
  record('T7', '新建无日期任务（长期规划清单用）', !noDue.due);

  await api('DELETE', `${TASKS}/users/@me/lists/${list.id}`);
  cleanup.pop();
  const listsAfter = await listAll(`${TASKS}/users/@me/lists?maxResults=100`);
  record('T8', '删除测试清单（连同其中的任务）', !listsAfter.items.some((l) => l.id === list.id));
}

async function main(): Promise<void> {
  console.log(`读取 OAuth 客户端文件：${CLIENT_FILE}`);
  const { refreshToken, clientId, clientSecret } = await oauth();

  const refreshed = await postForm('https://oauth2.googleapis.com/token', {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  record('G0', '用刷新令牌换取新的访问令牌（组件长期运行所需）', Boolean(refreshed.access_token));
  accessToken = refreshed.access_token;

  for (const [name, fn] of [
    ['Calendar', verifyCalendar],
    ['Tasks', verifyTasks],
  ] as const) {
    try {
      await fn();
    } catch (err) {
      record('ERR', `${name} 验证中断`, false, (err as Error).message);
    }
  }
}

main()
  .catch((err: Error) => record('ERR', '验证中断', false, err.message))
  .finally(async () => {
    for (const fn of cleanup.reverse()) await fn();
    const passed = checks.filter((c) => c.ok).length;
    writeFileSync(REPORT_FILE, JSON.stringify({ at: new Date().toISOString(), passed, total: checks.length, checks }, null, 2));
    console.log(`\n通过 ${passed}/${checks.length}，报告：${REPORT_FILE}`);
    if (cleanup.length) console.log('注意：验证中途中断，已尝试自动删除测试数据；如仍有残留，请在 Google 日历 / Tasks 中手动删除标题含"DeskCalendar 验证"的项目');
  });
