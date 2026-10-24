/** 宿主环境适配：在 Tauri 中调用后台命令；在普通浏览器中（界面预览）返回演示模式。 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';

export const inTauri = '__TAURI_INTERNALS__' in window;

export interface AuthStatus {
  demo: boolean;
  signedIn: boolean;
  clientFile: boolean;
  clientPath: string;
}

export interface AuthError {
  code: 'NO_CLIENT_FILE' | 'NOT_SIGNED_IN' | 'REAUTH_REQUIRED' | 'NETWORK' | 'AUTH_FAILED' | 'CREDENTIAL_STORE';
  message: string;
}

export function isAuthError(e: unknown): e is AuthError {
  return typeof e === 'object' && e !== null && 'code' in e && 'message' in e;
}

export const host = {
  authStatus: (): Promise<AuthStatus> =>
    inTauri ? invoke<AuthStatus>('auth_status') : Promise.resolve({ demo: true, signedIn: true, clientFile: true, clientPath: '' }),
  signIn: () => invoke<void>('sign_in'),
  signOut: () => invoke<void>('sign_out'),
  accessToken: () => invoke<string>('access_token'),
  invalidateToken: () => invoke<void>('invalidate_token'),
  getLocked: (): Promise<boolean> => (inTauri ? invoke<boolean>('get_locked') : Promise.resolve(false)),
  setLocked: (locked: boolean) => (inTauri ? invoke<void>('set_locked', { locked }) : Promise.resolve()),
  open: (url: string) => (inTauri ? openUrl(url) : Promise.resolve(void window.open(url, '_blank'))),
  on: <T>(event: string, cb: (payload: T) => void) => (inTauri ? listen<T>(event, (e) => cb(e.payload)) : Promise.resolve(() => {})),
};
