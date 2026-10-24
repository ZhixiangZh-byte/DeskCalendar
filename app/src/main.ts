/** 月历组件界面与控制逻辑 */
import './styles.css';
import { localDateTime, today } from './date';
import { ApiError } from './google';
import type { CalendarItem } from './model';
import { buildMonth, monthRange, shiftMonth } from './month';
import { host, isAuthError, type AuthStatus } from './platform';
import { cache, DemoSource, GoogleSource, type DataSource, type Snapshot } from './source';

const POLL_MS = 3 * 60_000;
const FOCUS_REFRESH_MS = 30_000;
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const PREFS_KEY = 'deskcalendar.prefs.v1';

interface Prefs {
  /** 背景不透明度 0.2–1 */
  opacity: number;
  showCompleted: boolean;
}

function loadPrefs(): Prefs {
  const defaults: Prefs = { opacity: 0.72, showCompleted: true };
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return defaults;
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 忽略
  }
}

type SyncStatus = 'loading' | 'ok' | 'offline' | 'error';

const now = new Date();
const prefs = loadPrefs();
const state = {
  view: { year: now.getFullYear(), month: now.getMonth() + 1 },
  today: today(),
  auth: null as AuthStatus | null,
  source: null as DataSource | null,
  snapshot: null as Snapshot | null,
  status: 'loading' as SyncStatus,
  message: '',
  locked: false,
  quickAdd: null as { date: string } | null,
  settingsOpen: false,
  busy: false,
  loadSeq: 0,
};

const app = document.querySelector<HTMLDivElement>('#app')!;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function applyOpacity(): void {
  document.documentElement.style.setProperty('--bg-alpha', String(prefs.opacity));
}

const drag = () => (state.locked ? '' : 'data-tauri-drag-region');

// ---------- 登录界面 ----------

function renderSignIn(kind: 'no-client' | 'signed-out' | 'waiting', detail = ''): void {
  const body =
    kind === 'no-client'
      ? `<p>找不到 Google OAuth 客户端文件：</p><p class="path">${esc(state.auth?.clientPath ?? '')}</p><p>请按项目说明创建"桌面应用"类型的客户端，下载 JSON 后放到上面的位置，然后重新启动组件。</p>`
      : kind === 'waiting'
        ? `<p>已在浏览器中打开 Google 授权页面，请完成登录。</p><p class="muted">出现"Google 未验证此应用"时，点"继续"。</p>`
        : `<p>登录 Google 后，月历会显示你的日程和任务。</p>
           <button class="primary" data-act="signin">登录 Google</button>`;
  app.innerHTML = `
    <div id="card" class="card signin">
      <header class="bar" ${drag()}><h1 ${drag()}>DeskCalendar</h1></header>
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

// ---------- 月历界面 ----------

function renderShell(): void {
  app.innerHTML = `
    <div id="card" class="card">
      <header id="bar" class="bar"></header>
      <div class="weekdays">${WEEKDAYS.map((d, i) => `<span class="${i >= 5 ? 'weekend' : ''}">${d}</span>`).join('')}</div>
      <div id="grid" class="grid"></div>
      <div id="overlay"></div>
    </div>`;
  renderBar();
  renderGrid();
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
  const { year, month } = state.view;
  bar.outerHTML = `
    <header id="bar" class="bar" ${drag()}>
      <button class="icon" data-act="prev" title="上个月">‹</button>
      <h1 ${drag()}>${year}年${month}月</h1>
      <button class="icon" data-act="next" title="下个月">›</button>
      <button class="pill" data-act="today">今天</button>
      ${state.auth?.demo ? '<span class="badge">演示数据</span>' : ''}
      <span class="spacer" ${drag()}></span>
      <span class="status ${state.status}" title="${esc(statusTitle())}"></span>
      <button class="icon" data-act="refresh" title="刷新">⟳</button>
      <button class="icon" data-act="settings" title="设置">⚙</button>
    </header>`;
}

function itemHtml(item: CalendarItem, date: string): string {
  if (item.kind === 'event') {
    const continued = item.start < date;
    const label = item.time && !continued ? `<span class="time">${item.time}</span>` : '';
    return `<li class="item event${item.time ? ' timed' : ' allday'}" style="--c:${esc(item.color)}" data-act="open-event" data-id="${esc(item.id)}" title="${esc(item.title)}">${label}<span class="t">${esc(item.title)}</span></li>`;
  }
  // 四象限标记用小圆点（红 = 重要，橙 = 紧急），给标题留出空间
  const tags = `${item.important ? '<span class="tag imp" title="重要"></span>' : ''}${item.urgent ? '<span class="tag urg" title="紧急"></span>' : ''}`;
  return `<li class="item task${item.completed ? ' done' : ''}" data-id="${esc(item.id)}" title="${esc(item.notes ? `${item.title}\n${item.notes}` : item.title)}">
      <button class="check" data-act="toggle" data-id="${esc(item.id)}" aria-label="${item.completed ? '标记为未完成' : '标记为完成'}"></button>
      <span class="t">${esc(item.title)}</span>${tags}</li>`;
}

function renderGrid(): void {
  const grid = document.querySelector('#grid');
  if (!grid) return;
  const weeks = buildMonth(state.view.year, state.view.month, state.snapshot?.items ?? [], {
    today: state.today,
    showCompleted: prefs.showCompleted,
  });
  grid.innerHTML = weeks
    .flat()
    .map(
      (d) => `
      <div class="day${d.inMonth ? '' : ' out'}${d.isToday ? ' today' : ''}${d.weekend ? ' weekend' : ''}" data-act="add" data-date="${d.date}">
        <span class="num">${d.day}</span>
        <ul class="items">${d.items.map((i) => itemHtml(i, d.date)).join('')}</ul>
      </div>`,
    )
    .join('');
}

function renderOverlay(): void {
  const overlay = document.querySelector('#overlay');
  if (!overlay) return;
  if (state.quickAdd) {
    const [, m, d] = state.quickAdd.date.split('-').map(Number);
    overlay.innerHTML = `
      <form class="panel quick-add" data-form="add">
        <div class="panel-title">${m}月${d}日 新建任务</div>
        <input name="title" placeholder="任务标题，回车添加" autocomplete="off" maxlength="500" />
        <div class="row">
          <label class="toggle imp"><input type="checkbox" name="important" />重要</label>
          <label class="toggle urg"><input type="checkbox" name="urgent" />紧急</label>
          <span class="spacer"></span>
          <button type="button" data-act="close-overlay">取消</button>
          <button type="submit" class="primary">添加</button>
        </div>
      </form>`;
    overlay.querySelector<HTMLInputElement>('input[name=title]')!.focus();
  } else if (state.settingsOpen) {
    overlay.innerHTML = `
      <div class="panel settings">
        <div class="panel-title">设置</div>
        <label class="field">背景不透明度
          <input type="range" min="20" max="100" value="${Math.round(prefs.opacity * 100)}" data-input="opacity" />
        </label>
        <label class="field check-field"><input type="checkbox" data-input="show-completed" ${prefs.showCompleted ? 'checked' : ''} />显示已完成的任务</label>
        <label class="field check-field"><input type="checkbox" data-input="locked" ${state.locked ? 'checked' : ''} />锁定位置和大小</label>
        <p class="muted">鼠标穿透、开机自启在托盘图标的右键菜单里。</p>
        <div class="row">
          ${state.auth?.demo ? '' : '<button type="button" data-act="signout">退出 Google 登录</button>'}
          <span class="spacer"></span>
          <button type="button" class="primary" data-act="close-overlay">完成</button>
        </div>
      </div>`;
  } else {
    overlay.innerHTML = '';
  }
}

function setStatus(status: SyncStatus, message = ''): void {
  state.status = status;
  state.message = message;
  renderBar();
}

// ---------- 数据 ----------

function currentRange() {
  return monthRange(state.view.year, state.view.month);
}

async function refresh(): Promise<void> {
  const source = state.source;
  if (!source) return;
  const range = currentRange();
  const seq = ++state.loadSeq;
  state.today = today();
  setStatus('loading');
  try {
    const snapshot = await source.load(range);
    if (seq !== state.loadSeq) return; // 期间切换了月份
    state.snapshot = snapshot;
    if (!state.auth?.demo) cache.write(snapshot);
    setStatus('ok');
    renderGrid();
  } catch (e) {
    if (seq !== state.loadSeq) return;
    handleError(e);
  }
}

function handleError(e: unknown): void {
  if (isAuthError(e)) {
    if (e.code === 'NOT_SIGNED_IN' || e.code === 'REAUTH_REQUIRED' || e.code === 'NO_CLIENT_FILE') {
      state.source = null;
      void start(e.code === 'REAUTH_REQUIRED' ? e.message : '');
      return;
    }
    setStatus(e.code === 'NETWORK' ? 'offline' : 'error', e.message);
  } else if (e instanceof ApiError) {
    setStatus('error', `Google 返回错误 ${e.status}：${e.message}`);
  } else if (e instanceof TypeError) {
    setStatus('offline', '网络不可用');
  } else {
    setStatus('error', String(e));
  }
}

function showMonth(year: number, month: number): void {
  state.view = { year, month };
  state.snapshot = state.auth?.demo ? null : cache.read(currentRange());
  renderBar();
  renderGrid();
  void refresh();
}

function findItem(id: string): CalendarItem | undefined {
  return state.snapshot?.items.find((i) => i.id === id);
}

function replaceItem(id: string, next: CalendarItem): void {
  if (!state.snapshot) return;
  state.snapshot = { ...state.snapshot, items: state.snapshot.items.map((i) => (i.id === id ? next : i)) };
  if (!state.auth?.demo) cache.write(state.snapshot);
  renderGrid();
}

async function toggleTask(id: string): Promise<void> {
  const item = findItem(id);
  if (!item || item.kind !== 'task' || !state.source) return;
  const target = !item.completed;
  replaceItem(id, { ...item, completed: target }); // 先更新界面
  try {
    replaceItem(id, await state.source.setCompleted(item, target));
  } catch (e) {
    replaceItem(id, item); // 失败则恢复
    handleError(e);
  }
}

async function addTask(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const title = String(data.get('title') ?? '').trim();
  if (!title || !state.quickAdd || !state.source || state.busy) return;
  const listId = state.snapshot?.defaultTaskList;
  if (!listId) {
    setStatus('error', '没有可用的任务清单（请先在 Google Tasks 中建一个清单）');
    return;
  }
  state.busy = true;
  try {
    const created = await state.source.createTask(listId, {
      title,
      date: state.quickAdd.date,
      notes: '',
      important: data.get('important') === 'on',
      urgent: data.get('urgent') === 'on',
    });
    if (state.snapshot) {
      state.snapshot = { ...state.snapshot, items: [...state.snapshot.items, created] };
      if (!state.auth?.demo) cache.write(state.snapshot);
    }
    state.quickAdd = null;
    renderOverlay();
    renderGrid();
  } catch (e) {
    handleError(e);
  } finally {
    state.busy = false;
  }
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
    case 'next': {
      const m = shiftMonth(state.view.year, state.view.month, act === 'prev' ? -1 : 1);
      showMonth(m.year, m.month);
      break;
    }
    case 'today': {
      const d = new Date();
      showMonth(d.getFullYear(), d.getMonth() + 1);
      break;
    }
    case 'refresh':
      void refresh();
      break;
    case 'settings':
      state.quickAdd = null;
      state.settingsOpen = !state.settingsOpen;
      renderOverlay();
      break;
    case 'close-overlay':
      state.quickAdd = null;
      state.settingsOpen = false;
      renderOverlay();
      break;
    case 'toggle':
      ev.stopPropagation();
      void toggleTask(el.dataset.id!);
      break;
    case 'open-event': {
      const link = findItem(el.dataset.id!)?.link;
      if (link) void host.open(link);
      break;
    }
    case 'add':
      // 只在点到格子空白处时新建，点到条目上不触发
      if (target.closest('.item')) break;
      state.settingsOpen = false;
      state.quickAdd = { date: el.dataset.date! };
      renderOverlay();
      break;
    case 'signout':
      void host.signOut().then(() => {
        cache.clear();
        state.settingsOpen = false;
        void start();
      });
      break;
  }
});

app.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  if (form.dataset.form === 'add') void addTask(form);
});

app.addEventListener('input', (ev) => {
  const el = ev.target as HTMLInputElement;
  switch (el.dataset.input) {
    case 'opacity':
      prefs.opacity = Number(el.value) / 100;
      applyOpacity();
      savePrefs();
      break;
    case 'show-completed':
      prefs.showCompleted = el.checked;
      savePrefs();
      renderGrid();
      break;
    case 'locked':
      void host.setLocked(el.checked);
      break;
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && (state.quickAdd || state.settingsOpen)) {
    state.quickAdd = null;
    state.settingsOpen = false;
    renderOverlay();
  }
});

// ---------- 启动 ----------

let pollTimer: number | undefined;

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
    state.snapshot = cache.read(currentRange());
  }
  renderShell();
  void refresh();
  pollTimer = window.setInterval(() => void refresh(), POLL_MS);
}

applyOpacity();
void host.on<boolean>('locked-changed', (locked) => {
  state.locked = locked;
  renderBar();
  if (state.settingsOpen) renderOverlay();
});
void host.on('refresh', () => void refresh());
void host.on('auth-changed', () => void start());
window.addEventListener('online', () => void refresh());
window.addEventListener('focus', () => {
  if (state.snapshot && Date.now() - state.snapshot.fetchedAt > FOCUS_REFRESH_MS) void refresh();
});
// 跨过午夜时更新"今天"
window.setInterval(() => {
  if (today() !== state.today) {
    state.today = today();
    renderGrid();
  }
}, 60_000);

void start();
