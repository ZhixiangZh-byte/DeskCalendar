//! DeskCalendar 后台：Google 登录、贴桌面层、托盘菜单与窗口设置。
//! Google API 的读写在前端（TypeScript）完成，访问令牌通过 `access_token` 命令提供；刷新令牌只留在 Rust 侧。

mod desktop;
mod oauth;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use windows::Win32::Foundation::HWND;

use crate::oauth::{Auth, AuthError};

const WIDGET: &str = "month";

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    /// 锁定位置和大小
    locked: bool,
}

struct TrayItems {
    lock: CheckMenuItem<Wry>,
    through: CheckMenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
}

struct AppState {
    demo: bool,
    settings: Mutex<Settings>,
    /// 鼠标穿透不持久化：重启后总是关闭，避免组件"点不着"
    click_through: Mutex<bool>,
    tray: Mutex<Option<TrayItems>>,
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) {
    if let Some(p) = settings_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, serde_json::to_string_pretty(s).unwrap_or_default());
    }
}

fn widget_hwnd(app: &AppHandle) -> Option<HWND> {
    app.get_webview_window(WIDGET).and_then(|w| w.hwnd().ok()).map(|h| HWND(h.0))
}

fn apply_locked(app: &AppHandle, locked: bool) {
    let state = app.state::<AppState>();
    state.settings.lock().unwrap().locked = locked;
    save_settings(app, &state.settings.lock().unwrap());
    if let Some(w) = app.get_webview_window(WIDGET) {
        let _ = w.set_resizable(!locked);
    }
    if let Some(t) = state.tray.lock().unwrap().as_ref() {
        let _ = t.lock.set_checked(locked);
    }
    let _ = app.emit("locked-changed", locked);
}

fn apply_click_through(app: &AppHandle, on: bool) {
    let state = app.state::<AppState>();
    *state.click_through.lock().unwrap() = on;
    if let Some(w) = app.get_webview_window(WIDGET) {
        let _ = w.set_ignore_cursor_events(on);
    }
    if let Some(t) = state.tray.lock().unwrap().as_ref() {
        let _ = t.through.set_checked(on);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatus {
    demo: bool,
    signed_in: bool,
    client_file: bool,
    client_path: String,
}

#[tauri::command]
fn auth_status(state: State<AppState>) -> AuthStatus {
    let path = oauth::client_file_path();
    AuthStatus {
        demo: state.demo,
        signed_in: oauth::is_signed_in(),
        client_file: path.is_file(),
        client_path: path.display().to_string(),
    }
}

#[tauri::command]
async fn sign_in(app: AppHandle, auth: State<'_, Auth>) -> Result<(), AuthError> {
    auth.sign_in(&app).await?;
    let _ = app.emit("auth-changed", true);
    Ok(())
}

#[tauri::command]
async fn sign_out(app: AppHandle, auth: State<'_, Auth>) -> Result<(), ()> {
    auth.sign_out().await;
    let _ = app.emit("auth-changed", false);
    Ok(())
}

#[tauri::command]
async fn access_token(auth: State<'_, Auth>) -> Result<String, AuthError> {
    auth.access_token().await
}

#[tauri::command]
async fn invalidate_token(auth: State<'_, Auth>) -> Result<(), ()> {
    auth.invalidate().await;
    Ok(())
}

#[tauri::command]
fn get_locked(state: State<AppState>) -> bool {
    state.settings.lock().unwrap().locked
}

#[tauri::command]
fn set_locked(app: AppHandle, locked: bool) {
    apply_locked(&app, locked);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let locked = state.settings.lock().unwrap().locked;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);

    let refresh = MenuItem::with_id(app, "refresh", "立即刷新", true, None::<&str>)?;
    let lock = CheckMenuItem::with_id(app, "lock", "锁定位置和大小", true, locked, None::<&str>)?;
    let through = CheckMenuItem::with_id(app, "through", "鼠标穿透", true, false, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "开机自动启动", true, autostart_on, None::<&str>)?;
    let sign_out = MenuItem::with_id(app, "signout", "退出 Google 登录", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 DeskCalendar", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&refresh, &sep()?, &lock, &through, &autostart, &sep()?, &sign_out, &quit])?;
    *state.tray.lock().unwrap() = Some(TrayItems { lock, through, autostart });

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("缺少应用图标"))
        .tooltip("DeskCalendar")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "refresh" => {
                let _ = app.emit("refresh", ());
            }
            "lock" => {
                let locked = !app.state::<AppState>().settings.lock().unwrap().locked;
                apply_locked(app, locked);
            }
            "through" => {
                let on = !*app.state::<AppState>().click_through.lock().unwrap();
                apply_click_through(app, on);
            }
            "autostart" => {
                let al = app.autolaunch();
                let on = !al.is_enabled().unwrap_or(false);
                let _ = if on { al.enable() } else { al.disable() };
                if let Some(t) = app.state::<AppState>().tray.lock().unwrap().as_ref() {
                    let _ = t.autostart.set_checked(al.is_enabled().unwrap_or(false));
                }
            }
            "signout" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<Auth>().sign_out().await;
                    let _ = app.emit("auth-changed", false);
                });
            }
            "quit" => {
                let _ = app.save_window_state(StateFlags::POSITION | StateFlags::SIZE);
                app.exit(0);
            }
            _ => {}
        })
        // 左键单击托盘图标：把组件临时提到前面（失去焦点后自动退回底层）
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                if let Some(w) = tray.app_handle().get_webview_window(WIDGET) {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let demo = std::env::args().any(|a| a == "--demo");

    tauri::Builder::default()
        // 只允许运行一个实例；再次启动时把已有组件提到前面
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window(WIDGET) {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION | StateFlags::SIZE)
                .build(),
        )
        .manage(Auth::default())
        .manage(AppState { demo, settings: Mutex::new(Settings::default()), click_through: Mutex::new(false), tray: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            sign_in,
            sign_out,
            access_token,
            invalidate_token,
            get_locked,
            set_locked
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            *app.state::<AppState>().settings.lock().unwrap() = load_settings(&handle);
            build_tray(&handle)?;

            let window = app.get_webview_window(WIDGET).expect("缺少 month 窗口");
            let locked = app.state::<AppState>().settings.lock().unwrap().locked;
            window.set_resizable(!locked)?;
            if let Some(hwnd) = widget_hwnd(&handle) {
                desktop::own_by_desktop(hwnd);
            }
            let h = handle.clone();
            window.on_window_event(move |e| {
                if let WindowEvent::Focused(false) = e {
                    if let Some(hwnd) = widget_hwnd(&h) {
                        desktop::send_to_bottom(hwnd);
                    }
                    // 拖动或缩放通常以点到别处结束，此时保存位置和大小
                    let _ = h.save_window_state(StateFlags::POSITION | StateFlags::SIZE);
                }
            });

            // 资源管理器重启后 Progman 会被重建，定期检查并重新挂接
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(5));
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Some(hwnd) = widget_hwnd(&h) {
                        if !desktop::owner_is_valid(hwnd) {
                            desktop::own_by_desktop(hwnd);
                        }
                    }
                });
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("DeskCalendar 启动失败");
}
