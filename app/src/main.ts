/** 月历组件界面与控制逻辑 */
import './styles.css';
import { dayOfWeek, localDateTime, today } from './date';
import { ApiError } from './google';
import { parseQuickTitle, type CalendarItem } from './model';
import { buildMonth, monthRange, shiftMonth } from './month';
import { host, inTauri, isAuthError, type AuthStatus } from './platform';
import { cache, DemoSource, GoogleSource, type DataSource, type Snapshot } from './source';

const POLL_MS = 3 * 60_000;
const FOCUS_REFRESH_MS = 30_000;
const CLICK_THROUGH_SECONDS = 5;
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const PREFS_KEY = 'deskcalendar.prefs.v1';

type Theme = 'system' | 'light' | 'dark';

interface Prefs {
  /** 背景不透明度 0.2–1 */
  opacity: number;
  showCompleted: boolean;
  theme: Theme;
}

function loadPrefs(): Prefs {
  const defaults: Prefs = { opacity: 0.72, showCompleted: true, theme: 'system' };
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

type Overlay =
  | { type: 'add'; date: string }
  | { type: 'task'; id: string }
  | { type: 'event'; id: string }
  | { type: 'settings' }
  | null;

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
  clickThrough: false,
  overlay: null as Overlay,
  busy: false,
  loadSeq: 0,
};

const app = document.querySelector<HTMLDivElement>('#app')!;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const drag = () => (state.locked ? '' : 'data-tauri-drag-region');

/** 线条图标（跟随文字颜色） */
const ICONS = {
  refresh: '<svg viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89"/><path d="M13.5 2.5v3h-3"/></svg>',
  settings:
    '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg>',
  through:
    '<svg viewBox="0 0 16 16"><path d="M4 2.5l8 5-3.6.8 2.1 4-1.5.8-2.1-4L4 11.5z"/><path d="M1.5 14.5l13-13" stroke-dasharray="1.6 1.6"/></svg>',
};

// ---------- 主题与外观 ----------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyAppearance(): void {
  const resolved = prefs.theme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : prefs.theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.setProperty('--bg-alpha', String(prefs.opacity));
}
darkQuery.addEventListener('change', applyAppearance);

function fmtDate(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}月${d}日 ${WEEKDAY_NAMES[dayOfWeek(date)]}`;
}

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
    <div id="card" class="card${state.clickThrough ? ' passthrough' : ''}">
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
      <button class="icon nav" data-act="prev" title="上个月">‹</button>
      <h1 ${drag()}>${year}年${month}月</h1>
      <button class="icon nav" data-act="next" title="下个月">›</button>
      <button class="pill" data-act="today">今天</button>
      ${state.auth?.demo ? '<span class="badge">演示数据</span>' : ''}
      <span class="spacer" ${drag()}></span>
      <span class="status ${state.status}" title="${esc(statusTitle())}"></span>
      <button class="icon" data-act="refresh" title="刷新">${ICONS.refresh}</button>
      <button class="icon" data-act="passthrough" title="鼠标穿透 ${CLICK_THROUGH_SECONDS} 秒（期间可点击组件后面的桌面图标）">${ICONS.through}</button>
      <button class="icon" data-act="settings" title="设置">${ICONS.settings}</button>
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
  return `<li class="item task${item.completed ? ' done' : ''}" data-act="open-task" data-id="${esc(item.id)}" title="${esc(item.notes ? `${item.title}\n${item.notes}` : item.title)}">
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

// ---------- 浮层：新建 / 任务详情 / 事件详情 / 设置 ----------

const TITLE_HINT = '末尾加 ! 重要 · !! 紧急 · !!! 重要且紧急';

function tagToggles(important: boolean, urgent: boolean): string {
  return `
    <label class="toggle imp"><input type="checkbox" name="important" ${important ? 'checked' : ''} />重要</label>
    <label class="toggle urg"><input type="checkbox" name="urgent" ${urgent ? 'checked' : ''} />紧急</label>`;
}

/** 新建时默认的开始时间：今天取下一个整点，其他日子取 09:00 */
function defaultStart(date: string): string {
  const d = new Date();
  if (date !== state.today || d.getHours() >= 23) return '09:00';
  return `${String(d.getHours() + 1).padStart(2, '0')}:00`;
}

function plusHour(time: string): string {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return `${String((h + 1) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function addPanel(date: string): string {
  const start = defaultStart(date);
  return `
    <form class="panel quick-add" data-form="add">
      <div class="panel-title">${fmtDate(date)} · 新建</div>
      <input name="title" placeholder="标题（${TITLE_HINT}）" autocomplete="off" maxlength="500" />
      <textarea name="notes" rows="2" placeholder="详情（可选，Ctrl+Enter 添加）" maxlength="8000"></textarea>
      <div class="row">
        <label class="toggle"><input type="checkbox" name="timed" data-input="timed" />指定时间</label>
        <span class="time-fields" hidden>
          <input type="time" name="start" value="${start}" data-input="start-time" /> –
          <input type="time" name="end" value="${plusHour(start)}" />
        </span>
      </div>
      <p class="muted small timed-hint" hidden>带时间的计划会建成 Google 日历事件（日历事件没有"完成"状态）。</p>
      <p class="panel-error" hidden></p>
      <div class="row">
        <span class="tag-toggles">${tagToggles(false, false)}</span>
        <span class="spacer"></span>
        <button type="button" data-act="close-overlay">取消</button>
        <button type="submit" class="primary">添加</button>
      </div>
    </form>`;
}

function taskPanel(item: CalendarItem): string {
  return `
    <form class="panel task-detail" data-form="task" data-id="${esc(item.id)}">
      <div class="row">
        <label class="toggle done-toggle"><input type="checkbox" name="completed" ${item.completed ? 'checked' : ''} />已完成</label>
        <span class="spacer"></span>
        <span class="muted small">Google 任务</span>
      </div>
      <input name="title" value="${esc(item.title)}" placeholder="标题（${TITLE_HINT}）" autocomplete="off" maxlength="500" />
      <textarea name="notes" rows="4" placeholder="详情" maxlength="8000">${esc(item.notes)}</textarea>
      <div class="row">
        <label class="inline-field">日期 <input type="date" name="date" value="${item.start}" required /></label>
        <span class="spacer"></span>
        ${tagToggles(item.important, item.urgent)}
      </div>
      <p class="panel-error" hidden></p>
      <div class="row">
        <button type="button" class="danger" data-act="delete-item">删除</button>
        ${item.link ? '<button type="button" data-act="open-link">在 Google 中打开</button>' : ''}
        <span class="spacer"></span>
        <button type="button" data-act="close-overlay">取消</button>
        <button type="submit" class="primary">保存</button>
      </div>
    </form>`;
}

/** 只读事件（别人组织的会议、只读日历）：只显示信息 */
function eventView(item: CalendarItem): string {
  let when: string;
  if (item.time) {
    const endDate = item.endTimeDate ?? item.start;
    when = `${fmtDate(item.start)} ${item.time}${item.endTime ? `–${endDate !== item.start ? `${fmtDate(endDate)} ` : ''}${item.endTime}` : ''}`;
  } else {
    when = item.end !== item.start ? `${fmtDate(item.start)} – ${fmtDate(item.end)}（全天）` : `${fmtDate(item.start)}（全天）`;
  }
  return `
    <div class="panel event-detail">
      <div class="event-head"><span class="swatch" style="--c:${esc(item.color)}"></span><div class="panel-title">${esc(item.title)}</div></div>
      <div class="meta">${esc(when)}</div>
      ${item.location ? `<div class="meta">地点：${esc(item.location)}</div>` : ''}
      ${item.notes ? `<div class="desc">${esc(item.notes)}</div>` : ''}
      <p class="muted small">此日程来自只读日历，或是别人组织的会议，只能在这里查看。</p>
      <div class="row">
        <span class="spacer"></span>
        ${item.link ? '<button type="button" data-act="open-link">在 Google 日历中打开</button>' : ''}
        <button type="button" class="primary" data-act="close-overlay">关闭</button>
      </div>
    </div>`;
}

/** 可编辑的事件：标题、全天/定时、起止日期时间、地点、说明 */
function eventForm(item: CalendarItem): string {
  const allDay = item.time === null;
  const endDate = allDay ? item.end : (item.endTimeDate ?? item.start);
  const startTime = item.time ?? '09:00';
  const endTime = item.endTime ?? plusHour(startTime);
  return `
    <form class="panel event-detail${allDay ? ' all-day' : ''}" data-form="event" data-id="${esc(item.id)}">
      <div class="row">
        <span class="swatch" style="--c:${esc(item.color)}"></span>
        <span class="muted small">Google 日历事件</span>
        <span class="spacer"></span>
        <label class="toggle"><input type="checkbox" name="allDay" data-input="all-day" ${allDay ? 'checked' : ''} />全天</label>
      </div>
      <input name="title" value="${esc(item.title)}" placeholder="标题" autocomplete="off" maxlength="500" />
      <div class="when-grid">
        <span class="muted">开始</span>
        <input type="date" name="startDate" value="${item.start}" data-input="start-date" required />
        <input type="time" name="startTime" value="${startTime}" class="time-only" data-input="start-time" />
        <span class="muted">结束</span>
        <input type="date" name="endDate" value="${endDate}" required />
        <input type="time" name="end" value="${endTime}" class="time-only" />
      </div>
      <input name="location" value="${esc(item.location)}" placeholder="地点（可选）" autocomplete="off" maxlength="500" />
      <textarea name="notes" rows="3" placeholder="说明（可选）" maxlength="8000">${esc(item.notes)}</textarea>
      ${item.recurring ? '<p class="muted small">这是重复日程中的一次，修改或删除只影响这一次。</p>' : ''}
      <p class="panel-error" hidden></p>
      <div class="row">
        <button type="button" class="danger" data-act="delete-item">删除</button>
        ${item.link ? '<button type="button" data-act="open-link">在 Google 日历中打开</button>' : ''}
        <span class="spacer"></span>
        <button type="button" data-act="close-overlay">取消</button>
        <button type="submit" class="primary">保存</button>
      </div>
    </form>`;
}

function eventPanel(item: CalendarItem): string {
  return item.editable ? eventForm(item) : eventView(item);
}

function settingsPanel(): string {
  const theme = (value: Theme, label: string) =>
    `<label class="seg"><input type="radio" name="theme" value="${value}" data-input="theme" ${prefs.theme === value ? 'checked' : ''} />${label}</label>`;
  return `
    <div class="panel settings">
      <div class="panel-title">设置</div>
      <div class="field">外观 <span class="segmented">${theme('system', '跟随系统')}${theme('light', '浅色')}${theme('dark', '深色')}</span></div>
      <label class="field">背景不透明度
        <input type="range" min="20" max="100" value="${Math.round(prefs.opacity * 100)}" data-input="opacity" />
      </label>
      <label class="field check-field"><input type="checkbox" data-input="show-completed" ${prefs.showCompleted ? 'checked' : ''} />显示已完成的任务</label>
      <label class="field check-field"><input type="checkbox" data-input="locked" ${state.locked ? 'checked' : ''} />锁定位置和大小</label>
      <p class="muted small">开机自启、长期鼠标穿透在托盘图标的右键菜单里。</p>
      <div class="row">
        ${state.auth?.demo ? '' : '<button type="button" data-act="signout">退出 Google 登录</button>'}
        <span class="spacer"></span>
        <button type="button" class="primary" data-act="close-overlay">完成</button>
      </div>
    </div>`;
}

function renderOverlay(): void {
  const overlay = document.querySelector('#overlay');
  if (!overlay) return;
  const o = state.overlay;
  let panel = '';
  if (o?.type === 'add') panel = addPanel(o.date);
  else if (o?.type === 'settings') panel = settingsPanel();
  else if (o?.type === 'task' || o?.type === 'event') {
    const item = findItem(o.id);
    if (item) panel = o.type === 'task' ? taskPanel(item) : eventPanel(item);
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
  return { status: 'error', message: String(e) };
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

function updateItems(fn: (items: CalendarItem[]) => CalendarItem[]): void {
  if (!state.snapshot) return;
  state.snapshot = { ...state.snapshot, items: fn(state.snapshot.items) };
  if (!state.auth?.demo) cache.write(state.snapshot);
  renderGrid();
}

const replaceItem = (id: string, next: CalendarItem) => updateItems((items) => items.map((i) => (i.id === id ? next : i)));

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
    if (data.get('timed') === 'on') {
      const calendar = state.snapshot?.primaryCalendar;
      if (!calendar) return panelError('找不到主日历，无法新建日历事件');
      const startTime = String(data.get('start') || '09:00');
      const endTime = String(data.get('end') || plusHour(startTime));
      created = await source.createEvent(calendar, { title, notes, date: o.date, startTime, endTime });
    } else {
      const listId = state.snapshot?.defaultTaskList;
      if (!listId) return panelError('没有可用的任务清单（请先在 Google Tasks 中建一个清单）');
      created = await source.createTask(listId, { title, notes, date: o.date, important, urgent });
    }
    updateItems((items) => [...items, created]);
    openOverlay(null);
  });
}

async function submitTask(form: HTMLFormElement): Promise<void> {
  const item = findItem(form.dataset.id ?? '');
  if (!item || !state.source) return;
  const data = new FormData(form);
  const { title, important, urgent } = readTitleAndTags(data);
  if (!title) return panelError('请填写标题');
  const date = String(data.get('date') ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return panelError('请选择日期');
  const source = state.source;
  await withBusy(form, async () => {
    const updated = await source.updateTask(item, {
      title,
      notes: String(data.get('notes') ?? '').trim(),
      date,
      important,
      urgent,
      completed: data.get('completed') === 'on',
    });
    replaceItem(item.id, updated);
    openOverlay(null);
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
  });
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
    case 'passthrough':
      void host.clickThroughFor(CLICK_THROUGH_SECONDS);
      if (!inTauri) setClickThrough(true, CLICK_THROUGH_SECONDS); // 浏览器预览中只演示效果
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
      openOverlay({ type: 'add', date: el.dataset.date! });
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
      renderGrid();
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
      // 切换全天：隐藏或显示时间输入
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

applyAppearance();
void host.on<boolean>('locked-changed', (locked) => {
  state.locked = locked;
  renderBar();
  if (state.overlay?.type === 'settings') renderOverlay();
});
void host.on<boolean>('click-through-changed', (on) => setClickThrough(on));
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

