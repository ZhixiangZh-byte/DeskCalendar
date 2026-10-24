/**
 * 组件控制器：所有视图共用的加载、刷新、浮层面板和交互。
 * 视图由地址参数 ?view= 决定（month / day / quadrant / review / longterm），每个组件窗口一个视图。
 */
import './styles.css';
import { localDateTime, today } from './date';
import { ApiError } from './google';
import { parseQuickTitle, type CalendarItem } from './model';
import { host, inTauri, isAuthError, type AuthStatus } from './platform';
import { applyAppearance, prefs, savePrefs, watchPrefs, type Theme } from './prefs';
import { cache, DemoSource, GoogleSource, type DataSource, type Snapshot } from './source';
import { addPanel, eventPanel, esc, ICONS, plusHour, settingsPanel, taskPanel, type AddOptions } from './ui';
import { createView, HOUR_PX, type ViewCtx } from './views';

const POLL_MS = 3 * 60_000;
const FOCUS_REFRESH_MS = 30_000;
const CLICK_THROUGH_SECONDS = 5;

type SyncStatus = 'loading' | 'ok' | 'offline' | 'error';

type Overlay =
  | ({ type: 'add' } & AddOptions)
  | { type: 'task'; id: string }
  | { type: 'event'; id: string }
  | { type: 'settings' }
  | null;

const view = createView(new URLSearchParams(location.search).get('view'));
/** 本窗口的标识，用于忽略自己发出的"数据已变化"通知 */
const instanceId = `${view.id}-${Math.random().toString(36).slice(2, 8)}`;

const state = {
  today: today(),
  auth: null as AuthStatus | null,
  source: null as DataSource | null,
  snapshot: null as Snapshot | null,
  status: 'loading' as SyncStatus,
  message: '',
  locked: false,
  clickThrough: false,
  overlay: null as Overlay,
  busy: false,
  loadSeq: 0,
};

const app = document.querySelector<HTMLDivElement>('#app')!;
document.title = `DeskCalendar ${view.name}`;

const drag = () => (state.locked ? '' : 'data-tauri-drag-region');
const ctx = (): ViewCtx => ({
  today: state.today,
  snapshot: state.snapshot,
  showCompleted: prefs.showCompleted,
  showLunar: prefs.showLunar,
});

// ---------- 登录界面 ----------

function renderSignIn(kind: 'no-client' | 'signed-out' | 'waiting', detail = ''): void {
  const body =
    kind === 'no-client'
      ? `<p>找不到 Google OAuth 客户端文件：</p><p class="path">${esc(state.auth?.clientPath ?? '')}</p><p>请按项目说明创建"桌面应用"类型的客户端，下载 JSON 后放到上面的位置，然后重新启动组件。</p>`
      : kind === 'waiting'
        ? `<p>已在浏览器中打开 Google 授权页面，请完成登录。</p><p class="muted">出现"Google 未验证此应用"时，点"继续"。</p>`
        : `<p>登录 Google 后，${esc(view.name)}会显示你的日程和任务。</p>
           <button class="primary" data-act="signin">登录 Google</button>`;
  app.innerHTML = `
    <div id="card" class="card signin">
      <header class="bar" ${drag()}><h1 ${drag()}>DeskCalendar · ${esc(view.name)}</h1></header>
      <div class="signin-body">${body}${detail ? `<p class="error">${esc(detail)}</p>` : ''}</div>
    </div>`;
}

async function signIn(): Promise<void> {
  renderSignIn('waiting');
  try {
    await host.signIn();
    await start();
  } catch (e) {
    renderSignIn('signed-out', isAuthError(e) ? e.message : String(e));
  }
}

// ---------- 组件界面 ----------

function renderShell(): void {
  app.innerHTML = `
    <div id="card" class="card view-${view.id}${state.clickThrough ? ' passthrough' : ''}">
      <header id="bar" class="bar"></header>
      <div id="body" class="body ${view.bodyClass}"></div>
      <div id="overlay"></div>
    </div>`;
  renderBar();
  renderBody();
  renderOverlay();
}

function statusTitle(): string {
  const at = state.snapshot ? localDateTime(new Date(state.snapshot.fetchedAt)).time : '';
  switch (state.status) {
    case 'loading':
      return '正在同步…';
    case 'ok':
      return `已同步 ${at}`;
    case 'offline':
      return `离线，显示 ${at || '缓存'} 的数据`;
    case 'error':
      return state.message;
  }
}

function renderBar(): void {
  const bar = document.querySelector('#bar');
  if (!bar) return;
  const c = ctx();
  const title = `<h1 ${drag()}>${esc(view.title(c))}</h1>`;
  const nav = view.nav
    ? `<button class="icon nav" data-act="prev" title="上一个">‹</button>${title}<button class="icon nav" data-act="next" title="下一个">›</button>
       <button class="pill" data-act="today">今天</button>`
    : title;
  bar.outerHTML = `
    <header id="bar" class="bar" ${drag()}>
      ${nav}
      ${state.auth?.demo ? '<span class="badge">演示数据</span>' : ''}
      <span class="spacer" ${drag()}></span>
      <span class="status ${state.status}" title="${esc(statusTitle())}"></span>
      <button class="icon" data-act="refresh" title="刷新">${ICONS.refresh}</button>
      <button class="icon" data-act="passthrough" title="鼠标穿透 ${CLICK_THROUGH_SECONDS} 秒（期间可点击组件后面的桌面图标）">${ICONS.through}</button>
      <button class="icon" data-act="settings" title="设置">${ICONS.settings}</button>
      ${inTauri ? `<button class="icon" data-act="hide" title="关闭此组件（可在托盘菜单“显示组件”中重新打开）">${ICONS.close}</button>` : ''}
    </header>`;
}

function renderBody(): void {
  const body = document.querySelector<HTMLElement>('#body');
  if (!body) return;
  // 刷新时保留各滚动区域的位置（按 data-scroll 名称对应，元素增减不会错位）
  const saved = new Map([...body.querySelectorAll<HTMLElement>('[data-scroll]')].map((el) => [el.dataset.scroll!, el.scrollTop]));
  const bodyTop = body.scrollTop;
  const c = ctx();
  body.innerHTML = view.render(c);
  body.scrollTop = bodyTop;
  for (const el of body.querySelectorAll<HTMLElement>('[data-scroll]')) {
    const top = saved.get(el.dataset.scroll!);
    if (top !== undefined) el.scrollTop = top;
  }
  view.afterRender?.(body, c);
}

function renderOverlay(): void {
  const overlay = document.querySelector('#overlay');
  if (!overlay) return;
  const o = state.overlay;
  let panel = '';
  if (o?.type === 'add') panel = addPanel(o, state.today);
  else if (o?.type === 'settings') panel = settingsPanel({ locked: state.locked, demo: Boolean(state.auth?.demo) });
  else if (o?.type === 'task' || o?.type === 'event') {
    const item = findItem(o.id);
    if (item) panel = o.type === 'task' ? taskPanel(item, item.sourceId === state.snapshot?.longTermList) : eventPanel(item);
    else state.overlay = null;
  }
  // 点击面板以外的区域（遮罩）即关闭
  overlay.innerHTML = panel ? `<div class="backdrop" data-act="close-overlay"></div>${panel}` : '';
  if (o?.type === 'add') overlay.querySelector<HTMLInputElement>('input[name=title]')?.focus();
}

function openOverlay(o: Overlay): void {
  state.overlay = o;
  renderOverlay();
}

function panelError(message: string): void {
  const el = document.querySelector<HTMLElement>('#overlay .panel-error');
  if (!el) return setStatus('error', message);
  el.textContent = message;
  el.hidden = false;
}

function setStatus(status: SyncStatus, message = ''): void {
  state.status = status;
  state.message = message;
  renderBar();
}

// ---------- 数据 ----------

async function refresh(): Promise<void> {
  const source = state.source;
  if (!source) return;
  state.today = today();
  const query = view.query(ctx());
  const seq = ++state.loadSeq;
  setStatus('loading');
  try {
    const snapshot = await source.load(query);
    if (seq !== state.loadSeq) return; // 期间切换了日期范围
    state.snapshot = snapshot;
    if (!state.auth?.demo) cache.write(snapshot);
    setStatus('ok');
    renderBody();
  } catch (e) {
    if (seq !== state.loadSeq) return;
    handleError(e);
  }
}

/** 本组件修改了数据：刷新自己，并通知其他组件刷新 */
function afterMutation(): void {
  void host.broadcastDataChanged(instanceId);
  void refresh();
}

/** 把错误转成给人看的文字；需要重新登录时返回 null 并切到登录界面 */
function describeError(e: unknown): { status: SyncStatus; message: string } | null {
  if (isAuthError(e)) {
    if (e.code === 'NOT_SIGNED_IN' || e.code === 'REAUTH_REQUIRED' || e.code === 'NO_CLIENT_FILE') {
      state.source = null;
      state.overlay = null;
      void start(e.code === 'REAUTH_REQUIRED' ? e.message : '');
      return null;
    }
    return { status: e.code === 'NETWORK' ? 'offline' : 'error', message: e.message };
  }
  if (e instanceof ApiError) return { status: 'error', message: `Google 返回错误 ${e.status}：${e.message}` };
  if (e instanceof TypeError) return { status: 'offline', message: '网络不可用，请稍后再试' };
  return { status: 'error', message: e instanceof Error ? e.message : String(e) };
}

function handleError(e: unknown): void {
  const d = describeError(e);
  if (d) setStatus(d.status, d.message);
}

/** 面板里的操作失败时，把错误显示在面板中，保留用户已输入的内容 */
function handlePanelError(e: unknown): void {
  const d = describeError(e);
  if (d) panelError(d.message);
}

/** 切换日期范围（月历翻月、日视图翻天） */
function navigate(fn: () => void): void {
  fn();
  state.snapshot = state.auth?.demo ? null : cache.read(view.query(ctx()));
  renderBar();
  renderBody();
  void refresh();
}

function findItem(id: string): CalendarItem | undefined {
  return state.snapshot?.items.find((i) => i.id === id);
}

function updateItems(fn: (items: CalendarItem[]) => CalendarItem[]): void {
  if (!state.snapshot) return;
  state.snapshot = { ...state.snapshot, items: fn(state.snapshot.items) };
  if (!state.auth?.demo) cache.write(state.snapshot);
  renderBody();
}

const replaceItem = (id: string, next: CalendarItem) => updateItems((items) => items.map((i) => (i.id === id ? next : i)));

async function toggleTask(id: string): Promise<void> {
  const item = findItem(id);
  if (!item || item.kind !== 'task' || !state.source) return;
  const target = !item.completed;
  replaceItem(id, { ...item, completed: target }); // 先更新界面
  try {
    replaceItem(id, await state.source.setCompleted(item, target));
    afterMutation();
  } catch (e) {
    replaceItem(id, item); // 失败则恢复
    handleError(e);
  }
}

/** 读取标题与"重要/紧急"：标题末尾的感叹号与勾选框取并集 */
function readTitleAndTags(data: FormData): { title: string; important: boolean; urgent: boolean } {
  const q = parseQuickTitle(String(data.get('title') ?? ''));
  return { title: q.title, important: q.important || data.get('important') === 'on', urgent: q.urgent || data.get('urgent') === 'on' };
}

async function withBusy(form: HTMLFormElement, fn: () => Promise<void>): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  form.classList.add('busy');
  try {
    await fn();
  } catch (e) {
    handlePanelError(e);
  } finally {
    state.busy = false;
    form.classList.remove('busy');
  }
}

async function submitAdd(form: HTMLFormElement): Promise<void> {
  const o = state.overlay;
  if (o?.type !== 'add' || !state.source) return;
  const data = new FormData(form);
  const { title, important, urgent } = readTitleAndTags(data);
  if (!title) return panelError('请填写标题');
  const notes = String(data.get('notes') ?? '').trim();
  const source = state.source;
  await withBusy(form, async () => {
    let created: CalendarItem;
    if (o.date && data.get('timed') === 'on') {
      const calendar = state.snapshot?.primaryCalendar;
      if (!calendar) return panelError('找不到主日历，无法新建日历事件');
      const startTime = String(data.get('start') || '09:00');
      const endTime = String(data.get('end') || plusHour(startTime));
      created = await source.createEvent(calendar, { title, notes, date: o.date, startTime, endTime });
    } else {
      created = await source.createTask(o.target, { title, notes, date: o.date, important, urgent });
    }
    updateItems((items) => [...items, created]);
    openOverlay(null);
    afterMutation();
  });
}

async function submitTask(form: HTMLFormElement): Promise<void> {
  const item = findItem(form.dataset.id ?? '');
  if (!item || !state.source) return;
  const data = new FormData(form);
  const { title, important, urgent } = readTitleAndTags(data);
  if (!title) return panelError('请填写标题');
  const date = String(data.get('date') ?? '');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return panelError('日期格式不正确');
  const source = state.source;
  await withBusy(form, async () => {
    const updated = await source.updateTask(item, {
      title,
      notes: String(data.get('notes') ?? '').trim(),
      date: date || null,
      important,
      urgent,
      completed: data.get('completed') === 'on',
    });
    replaceItem(item.id, updated);
    openOverlay(null);
    afterMutation();
  });
}

async function submitEvent(form: HTMLFormElement): Promise<void> {
  const item = findItem(form.dataset.id ?? '');
  if (!item || !state.source) return;
  const data = new FormData(form);
  const title = String(data.get('title') ?? '').trim();
  if (!title) return panelError('请填写标题');
  const allDay = data.get('allDay') === 'on';
  const startDate = String(data.get('startDate') ?? '');
  const endDate = String(data.get('endDate') ?? '');
  const startTime = String(data.get('startTime') || '09:00');
  const endTime = String(data.get('end') || plusHour(startTime));
  if (!startDate || !endDate) return panelError('请填写日期');
  if (allDay ? endDate < startDate : `${endDate}T${endTime}` <= `${startDate}T${startTime}`) {
    return panelError('结束时间必须晚于开始时间');
  }
  const source = state.source;
  await withBusy(form, async () => {
    const updated = await source.updateEvent(item, {
      title,
      notes: String(data.get('notes') ?? '').trim(),
      location: String(data.get('location') ?? '').trim(),
      allDay,
      startDate,
      endDate,
      startTime,
      endTime,
    });
    replaceItem(item.id, updated);
    openOverlay(null);
    afterMutation();
  });
}

/** 删除任务或事件；第一次点击只是确认 */
async function deleteItem(button: HTMLButtonElement): Promise<void> {
  const form = button.closest('form')!;
  const item = findItem(form.dataset.id ?? '');
  if (!item || !state.source) return;
  if (button.dataset.confirm !== '1') {
    button.dataset.confirm = '1';
    button.textContent = '再点一次确认删除';
    return;
  }
  const source = state.source;
  await withBusy(form, async () => {
    await (item.kind === 'task' ? source.deleteTask(item) : source.deleteEvent(item));
    updateItems((items) => items.filter((i) => i.id !== item.id));
    openOverlay(null);
    afterMutation();
  });
}

/** 日视图：点时间轴空白处，按位置预填开始时间（取整到半小时） */
function addAt(el: HTMLElement, ev: MouseEvent): void {
  const rect = el.getBoundingClientRect();
  const minutes = Math.floor((((ev.clientY - rect.top) / HOUR_PX) * 60) / 30) * 30;
  const clamped = Math.min(Math.max(minutes, 0), 23 * 60 + 30);
  const startTime = `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
  openOverlay({ type: 'add', date: el.dataset.date!, target: 'default', important: false, urgent: false, startTime });
}

// ---------- 事件处理 ----------

app.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement;
  const el = target.closest<HTMLElement>('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  switch (act) {
    case 'signin':
      void signIn();
      break;
    case 'prev':
    case 'next':
      navigate(() => view.shift(act === 'prev' ? -1 : 1));
      break;
    case 'today':
      navigate(() => view.reset());
      break;
    case 'refresh':
      void refresh();
      break;
    case 'passthrough':
      void host.clickThroughFor(CLICK_THROUGH_SECONDS);
      if (!inTauri) setClickThrough(true, CLICK_THROUGH_SECONDS); // 浏览器预览中只演示效果
      break;
    case 'hide':
      void host.hideWidget();
      break;
    case 'settings':
      openOverlay(state.overlay?.type === 'settings' ? null : { type: 'settings' });
      break;
    case 'close-overlay':
      openOverlay(null);
      break;
    case 'toggle':
      ev.stopPropagation();
      void toggleTask(el.dataset.id!);
      break;
    case 'open-task':
      openOverlay({ type: 'task', id: el.dataset.id! });
      break;
    case 'open-event':
      openOverlay({ type: 'event', id: el.dataset.id! });
      break;
    case 'open-link': {
      const o = state.overlay;
      const link = o && 'id' in o ? findItem(o.id)?.link : null;
      if (link) void host.open(link);
      break;
    }
    case 'delete-item':
      void deleteItem(el as HTMLButtonElement);
      break;
    case 'add':
      openOverlay({
        type: 'add',
        date: el.dataset.date || null,
        target: el.dataset.target === 'long-term' ? 'long-term' : 'default',
        important: el.dataset.imp === '1',
        urgent: el.dataset.urg === '1',
      });
      break;
    case 'add-at':
      addAt(el, ev);
      break;
    case 'signout':
      void host.signOut().then(() => {
        cache.clear();
        state.overlay = null;
        void start();
      });
      break;
  }
});

app.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  if (form.dataset.form === 'add') void submitAdd(form);
  else if (form.dataset.form === 'task') void submitTask(form);
  else if (form.dataset.form === 'event') void submitEvent(form);
});

app.addEventListener('input', (ev) => {
  const el = ev.target as HTMLInputElement;
  switch (el.dataset.input) {
    case 'opacity':
      prefs.opacity = Number(el.value) / 100;
      applyAppearance();
      savePrefs();
      break;
    case 'theme':
      prefs.theme = el.value as Theme;
      applyAppearance();
      savePrefs();
      break;
    case 'show-completed':
      prefs.showCompleted = el.checked;
      savePrefs();
      renderBody();
      break;
    case 'show-lunar':
      prefs.showLunar = el.checked;
      savePrefs();
      renderBody();
      break;
    case 'locked':
      void host.setLocked(el.checked);
      break;
    case 'timed': {
      // 指定时间 → 建成日历事件：显示时间输入，隐藏只对任务有效的"重要/紧急"
      const form = el.form!;
      form.querySelector<HTMLElement>('.time-fields')!.hidden = !el.checked;
      form.querySelector<HTMLElement>('.timed-hint')!.hidden = !el.checked;
      form.querySelector<HTMLElement>('.tag-toggles')!.hidden = el.checked;
      break;
    }
    case 'start-time': {
      // 修改开始时间时，结束时间保持 1 小时后
      const end = el.form!.querySelector<HTMLInputElement>('input[name=end]')!;
      if (el.value) end.value = plusHour(el.value);
      break;
    }
    case 'all-day':
      el.form!.classList.toggle('all-day', el.checked);
      break;
    case 'start-date': {
      // 开始日期移到结束日期之后时，结束日期跟着移动
      const end = el.form!.querySelector<HTMLInputElement>('input[name=endDate]')!;
      if (el.value && end.value < el.value) end.value = el.value;
      break;
    }
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.overlay) {
    openOverlay(null);
  } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    // Ctrl+Enter：在详情框里也能提交
    const form = (ev.target as HTMLElement).closest?.('form');
    if (form) form.requestSubmit();
  }
});

let clickThroughTimer: number | undefined;

/** 鼠标穿透期间卡片变淡，提示此时点不到组件 */
function setClickThrough(on: boolean, autoOffSeconds?: number): void {
  state.clickThrough = on;
  document.querySelector('#card')?.classList.toggle('passthrough', on);
  window.clearTimeout(clickThroughTimer);
  if (on && autoOffSeconds) clickThroughTimer = window.setTimeout(() => setClickThrough(false), autoOffSeconds * 1000);
}

// ---------- 启动 ----------

let pollTimer: number | undefined;
let changeTimer: number | undefined;

async function start(detail = ''): Promise<void> {
  state.auth = await host.authStatus();
  state.locked = await host.getLocked();
  window.clearInterval(pollTimer);
  if (state.auth.demo) {
    state.source = new DemoSource(today());
  } else if (!state.auth.clientFile) {
    renderSignIn('no-client');
    return;
  } else if (!state.auth.signedIn) {
    renderSignIn('signed-out', detail);
    return;
  } else {
    state.source = new GoogleSource({ token: host.accessToken, invalidate: host.invalidateToken });
    state.snapshot = cache.read(view.query(ctx()));
  }
  renderShell();
  void refresh();
  pollTimer = window.setInterval(() => void refresh(), POLL_MS);
}

applyAppearance();
watchPrefs(() => {
  renderBody();
  if (state.overlay?.type === 'settings') renderOverlay();
});
void host.on<boolean>('locked-changed', (locked) => {
  state.locked = locked;
  renderBar();
  if (state.overlay?.type === 'settings') renderOverlay();
});
void host.on<boolean>('click-through-changed', (on) => setClickThrough(on));
void host.on('refresh', () => void refresh());
void host.on('auth-changed', () => void start());
// 其他组件改了数据：稍等片刻（合并连续的修改）后刷新
void host.on<string>('data-changed', (from) => {
  if (from === instanceId) return;
  window.clearTimeout(changeTimer);
  changeTimer = window.setTimeout(() => void refresh(), 400);
});
window.addEventListener('online', () => void refresh());
window.addEventListener('focus', () => {
  if (state.snapshot && Date.now() - state.snapshot.fetchedAt > FOCUS_REFRESH_MS) void refresh();
});
// 跨过午夜时更新"今天"
window.setInterval(() => {
  if (today() !== state.today) {
    state.today = today();
    void refresh();
  }
}, 60_000);

void start();
