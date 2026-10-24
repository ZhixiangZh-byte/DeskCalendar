/**
 * 外观偏好：所有组件共用（存于 localStorage，同源窗口共享）。
 * 一个组件里改了设置，其他组件通过 storage 事件立即同步。
 */

export type Theme = 'system' | 'light' | 'dark';

export interface Prefs {
  /** 背景不透明度 0.2–1 */
  opacity: number;
  showCompleted: boolean;
  theme: Theme;
}

const PREFS_KEY = 'deskcalendar.prefs.v1';
const DEFAULTS: Prefs = { opacity: 0.72, showCompleted: true, theme: 'system' };

function read(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export const prefs: Prefs = read();

export function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 忽略
  }
}

// 在非浏览器环境（单元测试）中没有 matchMedia
const darkQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function applyAppearance(): void {
  const resolved = prefs.theme === 'system' ? (darkQuery?.matches ? 'dark' : 'light') : prefs.theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.setProperty('--bg-alpha', String(prefs.opacity));
}

/** 系统主题或其他组件的设置变化时重新应用；onChange 用于重新渲染 */
export function watchPrefs(onChange: () => void): void {
  darkQuery?.addEventListener('change', applyAppearance);
  window.addEventListener('storage', (e) => {
    if (e.key !== PREFS_KEY) return;
    Object.assign(prefs, read());
    applyAppearance();
    onChange();
  });
}
