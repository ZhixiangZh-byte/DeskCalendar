/** 各组件共用的界面片段：图标、格式化、条目行和各种面板 */
import { dayOfWeek } from './date';
import type { CalendarItem } from './model';
import { prefs, type Theme } from './prefs';
import type { TaskTarget } from './source';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** 线条图标（跟随文字颜色） */
export const ICONS = {
  refresh: '<svg viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89"/><path d="M13.5 2.5v3h-3"/></svg>',
  settings:
    '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg>',
  through:
    '<svg viewBox="0 0 16 16"><path d="M4 2.5l8 5-3.6.8 2.1 4-1.5.8-2.1-4L4 11.5z"/><path d="M1.5 14.5l13-13" stroke-dasharray="1.6 1.6"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 10月24日 周六 */
export function fmtDate(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}月${d}日 ${WEEKDAY_NAMES[dayOfWeek(date)]}`;
}

/** 10/24 */
export function fmtShort(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}/${d}`;
}

export function plusHour(time: string): string {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return `${String((h + 1) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 新建时默认的开始时间：今天取下一个整点，其他日子取 09:00 */
export function defaultStart(date: string, today: string): string {
  const d = new Date();
  if (date !== today || d.getHours() >= 23) return '09:00';
  return `${String(d.getHours() + 1).padStart(2, '0')}:00`;
}

/** 四象限标记用小圆点（红 = 重要，橙 = 紧急） */
export function tagDots(item: CalendarItem): string {
  return `${item.important ? '<span class="tag imp" title="重要"></span>' : ''}${item.urgent ? '<span class="tag urg" title="紧急"></span>' : ''}`;
}

/** 列表视图中的一行：任务带勾选框，事件带颜色条；可附加日期标签 */
export function rowHtml(item: CalendarItem, opts: { chip?: string; chipClass?: string } = {}): string {
  const chip = opts.chip ? `<span class="chip ${opts.chipClass ?? ''}">${esc(opts.chip)}</span>` : '';
  if (item.kind === 'event') {
    const time = item.time ? `<span class="time">${item.time}</span>` : '';
    return `<li class="row-item event" style="--c:${esc(item.color)}" data-act="open-event" data-id="${esc(item.id)}" title="${esc(item.title)}">
        <span class="bar-mark"></span>${time}<span class="t">${esc(item.title)}</span>${chip}</li>`;
  }
  return `<li class="row-item task${item.completed ? ' done' : ''}" data-act="open-task" data-id="${esc(item.id)}" title="${esc(item.notes ? `${item.title}\n${item.notes}` : item.title)}">
      <button class="check" data-act="toggle" data-id="${esc(item.id)}" aria-label="${item.completed ? '标记为未完成' : '标记为完成'}"></button>
      <span class="t">${esc(item.title)}</span>${tagDots(item)}${chip}</li>`;
}

export const TITLE_HINT = '末尾加 ! 重要 · !! 紧急 · !!! 重要且紧急';

function tagToggles(important: boolean, urgent: boolean): string {
  return `
    <label class="toggle imp"><input type="checkbox" name="important" ${important ? 'checked' : ''} />重要</label>
    <label class="toggle urg"><input type="checkbox" name="urgent" ${urgent ? 'checked' : ''} />紧急</label>`;
}

export interface AddOptions {
  /** null：不设日期的任务 */
  date: string | null;
  target: TaskTarget;
  important: boolean;
  urgent: boolean;
  /** 预填开始时间（日视图点时间轴时），同时默认勾选"指定时间" */
  startTime?: string;
}

export function addPanel(o: AddOptions, today: string): string {
  const title =
    o.target === 'long-term' ? '长期规划 · 新建' : o.date ? `${fmtDate(o.date)} · 新建` : '新建任务（不设日期）';
  const start = o.startTime ?? (o.date ? defaultStart(o.date, today) : '09:00');
  const timed = Boolean(o.startTime);
  // 只有带日期的计划才能建成日历事件
  const timeRow = o.date
    ? `<div class="row">
        <label class="toggle"><input type="checkbox" name="timed" data-input="timed" ${timed ? 'checked' : ''} />指定时间</label>
        <span class="time-fields" ${timed ? '' : 'hidden'}>
          <input type="time" name="start" value="${start}" data-input="start-time" /> –
          <input type="time" name="end" value="${plusHour(start)}" />
        </span>
      </div>
      <p class="muted small timed-hint" ${timed ? '' : 'hidden'}>带时间的计划会建成 Google 日历事件（日历事件没有"完成"状态）。</p>`
    : '';
  return `
    <form class="panel quick-add" data-form="add">
      <div class="panel-title">${esc(title)}</div>
      <input name="title" placeholder="标题（${TITLE_HINT}）" autocomplete="off" maxlength="500" />
      <textarea name="notes" rows="2" placeholder="详情（可选，Ctrl+Enter 添加）" maxlength="8000"></textarea>
      ${timeRow}
      <p class="panel-error" hidden></p>
      <div class="row">
        <span class="tag-toggles" ${timed ? 'hidden' : ''}>${tagToggles(o.important, o.urgent)}</span>
        <span class="spacer"></span>
        <button type="button" data-act="close-overlay">取消</button>
        <button type="submit" class="primary">添加</button>
      </div>
    </form>`;
}

export function taskPanel(item: CalendarItem, longTerm: boolean): string {
  return `
    <form class="panel task-detail" data-form="task" data-id="${esc(item.id)}">
      <div class="row">
        <label class="toggle done-toggle"><input type="checkbox" name="completed" ${item.completed ? 'checked' : ''} />已完成</label>
        <span class="spacer"></span>
        <span class="muted small">${longTerm ? '长期规划' : 'Google 任务'}</span>
      </div>
      <input name="title" value="${esc(item.title)}" placeholder="标题（${TITLE_HINT}）" autocomplete="off" maxlength="500" />
      <textarea name="notes" rows="4" placeholder="详情" maxlength="8000">${esc(item.notes)}</textarea>
      <div class="row">
        <label class="inline-field">日期 <input type="date" name="date" value="${item.start}" /></label>
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

export function eventPanel(item: CalendarItem): string {
  return item.editable ? eventForm(item) : eventView(item);
}

export function settingsPanel(opts: { locked: boolean; demo: boolean }): string {
  const theme = (value: Theme, label: string) =>
    `<label class="seg"><input type="radio" name="theme" value="${value}" data-input="theme" ${prefs.theme === value ? 'checked' : ''} />${label}</label>`;
  return `
    <div class="panel settings">
      <div class="panel-title">设置（所有组件共用）</div>
      <div class="field">外观 <span class="segmented">${theme('system', '跟随系统')}${theme('light', '浅色')}${theme('dark', '深色')}</span></div>
      <label class="field">背景不透明度
        <input type="range" min="20" max="100" value="${Math.round(prefs.opacity * 100)}" data-input="opacity" />
      </label>
      <label class="field check-field"><input type="checkbox" data-input="show-completed" ${prefs.showCompleted ? 'checked' : ''} />显示已完成的任务</label>
      <label class="field check-field"><input type="checkbox" data-input="locked" ${opts.locked ? 'checked' : ''} />锁定位置和大小</label>
      <p class="muted small">显示其他组件（日视图、四象限、回顾箱、长期规划）、开机自启、全局鼠标穿透：托盘图标右键菜单。</p>
      <div class="row">
        ${opts.demo ? '' : '<button type="button" data-act="signout">退出 Google 登录</button>'}
        <span class="spacer"></span>
        <button type="button" class="primary" data-act="close-overlay">完成</button>
      </div>
    </div>`;
}
