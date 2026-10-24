//! DeskCalendar 后台：Google 登录、多个桌面组件窗口（贴桌面层）、托盘菜单与窗口设置。
//! Google API 的读写在前端（TypeScript）完成，访问令牌通过 `access_token` 命令提供；刷新令牌只留在 Rust 侧。
//! 所有组件窗口共用这一个后台：同一份登录状态、锁定状态和托盘菜单。

mod desktop;
mod oauth;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use windows::Win32::Foundation::HWND;

use crate::oauth::{Auth, AuthError};

/// 组件定义：窗口标签（同时是前端的视图名）、名称、默认大小
struct WidgetDef {
    label: &'static str,
    name: &'static str,
    width: f64,
    height: f64,
}

const WIDGETS: &[WidgetDef] = &[
    WidgetDef { label: "month", name: "月历", width: 560.0, height: 480.0 },
    WidgetDef { label: "day", name: "日视图", width: 300.0, height: 520.0 },
    WidgetDef { label: "quadrant", name: "四象限", width: 480.0, height: 420.0 },
    WidgetDef { label: "review", name: "回顾箱", width: 320.0, height: 460.0 },
    WidgetDef { label: "longterm", name: "长期规划", width: 300.0, height: 420.0 },
];

fn widget_def(label: &str) -> Option<&'static WidgetDef> {
    WIDGETS.iter().find(|w| w.label == label)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    /// 锁定所有组件的位置和大小
    locked: bool,
    /// 显示中的组件
    widgets: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self { locked: false, widgets: vec!["month".into()] }
    }
}

struct TrayItems {
    lock: CheckMenuItem<Wry>,
    through: CheckMenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
    widgets: Vec<(&'static str, CheckMenuItem<Wry>)>,
}

struct AppState {
    demo: bool,
    settings: Mutex<Settings>,
    /// 托盘里的"鼠标穿透"（所有组件）。不持久化：重启后总是关闭，避免组件"点不着"
    click_through: Mutex<bool>,
    tray: Mutex<Option<TrayItems>>,
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    let mut s: Settings = settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    s.widgets.retain(|l| widget_def(l).is_some());
    s
}

fn save_settings(app: &AppHandle, s: &Settings) {
    if let Some(p) = settings_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, serde_json::to_string_pretty(s).unwrap_or_default());
    }
}

fn hwnd_of(w: &WebviewWindow) -> Option<HWND> {
    w.hwnd().ok().map(|h| HWND(h.0))
}

/// 所有组件窗口
fn widget_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    WIDGETS.iter().filter_map(|d| app.get_webview_window(d.label)).collect()
}

fn save_state(app: &AppHandle) {
    let _ = app.save_window_state(StateFlags::POSITION | StateFlags::SIZE);
}

/// 新窗口贴到桌面层，并在失去焦点时退回底层
fn attach_widget(app: &AppHandle, window: &WebviewWindow) {
    if let Some(hwnd) = hwnd_of(window) {
        desktop::own_by_desktop(hwnd);
    }
    if *app.state::<AppState>().click_through.lock().unwrap() {
        let _ = window.set_ignore_cursor_events(true);
    }
    let w = window.clone();
    let h = app.clone();
    window.on_window_event(move |e| {
        if let WindowEvent::Focused(false) = e {
            if let Some(hwnd) = hwnd_of(&w) {
                desktop::send_to_bottom(hwnd);
            }
            // 拖动或缩放通常以点到别处结束，此时保存位置和大小
            save_state(&h);
        }
    });
}

/// 打开组件（已打开则不重复创建）。首次打开时按顺序错开位置，之后由 window-state 插件恢复
fn open_widget(app: &AppHandle, label: &str) -> tauri::Result<()> {
    let Some(def) = widget_def(label) else { return Ok(()) };
    if app.get_webview_window(label).is_some() {
        return Ok(());
    }
    let idx = WIDGETS.iter().position(|w| w.label == label).unwrap_or(0) as f64;
    let locked = app.state::<AppState>().settings.lock().unwrap().locked;
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(format!("index.html?view={label}").into()))
        .title(format!("DeskCalendar {}", def.name))
        .inner_size(def.width, def.height)
        .min_inner_size(240.0, 220.0)
        .position(60.0 + idx * 48.0, 80.0 + idx * 40.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .resizable(!locked)
        .build()?;
    attach_widget(app, &window);
    Ok(())
}

/// 显示或关闭组件，并记住选择
fn set_widget_visible(app: &AppHandle, label: &str, visible: bool) {
    if widget_def(label).is_none() {
        return;
    }
    let state = app.state::<AppState>();
    if visible {
        if let Err(e) = open_widget(app, label) {
            eprintln!("打开组件 {label} 失败：{e}");
            return;
        }
    } else if let Some(w) = app.get_webview_window(label) {
        save_state(app);
        let _ = w.destroy();
    }
    {
        let mut s = state.settings.lock().unwrap();
        s.widgets.retain(|l| l != label);
        if visible {
            s.widgets.push(label.to_string());
        }
        save_settings(app, &s);
    }
    if let Some(t) = state.tray.lock().unwrap().as_ref() {
        for (l, item) in &t.widgets {
            if *l == label {
                let _ = item.set_checked(visible);
            }
        }
    }
}

fn apply_locked(app: &AppHandle, locked: bool) {
    let state = app.state::<AppState>();
    {
        let mut s = state.settings.lock().unwrap();
        s.locked = locked;
        save_settings(app, &s);
    }
    for w in widget_windows(app) {
        let _ = w.set_resizable(!locked);
    }
    if let Some(t) = state.tray.lock().unwrap().as_ref() {
        let _ = t.lock.set_checked(locked);
    }
    let _ = app.emit("locked-changed", locked);
}

/// 托盘里的鼠标穿透：作用于所有组件
fn apply_click_through_all(app: &AppHandle, on: bool) {
    let state = app.state::<AppState>();
    *state.click_through.lock().unwrap() = on;
    for w in widget_windows(app) {
        let _ = w.set_ignore_cursor_events(on);
    }
    if let Some(t) = state.tray.lock().unwrap().as_ref() {
        let _ = t.through.set_checked(on);
    }
    let _ = app.emit("click-through-changed", on);
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

/// 顶栏按钮：只让这一个组件鼠标穿透 seconds 秒，期间组件点不到，所以由后台计时恢复
#[tauri::command]
fn click_through_for(app: AppHandle, window: WebviewWindow, seconds: u64) {
    let label = window.label().to_string();
    let set = move |app: &AppHandle, on: bool| {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.set_ignore_cursor_events(on);
        }
        let _ = app.emit_to(EventTarget::webview_window(label.clone()), "click-through-changed", on);
    };
    set(&app, true);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(seconds.clamp(1, 60)));
        // 托盘里开着全局穿透时保持穿透
        let global = *app.state::<AppState>().click_through.lock().unwrap();
        set(&app, global);
    });
}

#[tauri::command]
fn get_locked(state: State<AppState>) -> bool {
    state.settings.lock().unwrap().locked
}

#[tauri::command]
fn set_locked(app: AppHandle, locked: bool) {
    apply_locked(&app, locked);
}

/// 组件顶栏的"关闭"按钮：关闭这个组件（可在托盘菜单"显示组件"中重新打开）
#[tauri::command]
fn hide_widget(app: AppHandle, window: WebviewWindow) {
    let label = window.label().to_string();
    // 在主线程上销毁窗口，避免在本窗口的命令回调中直接销毁自己
    let h = app.clone();
    let _ = app.run_on_main_thread(move || set_widget_visible(&h, &label, false));
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let (locked, shown) = {
        let s = state.settings.lock().unwrap();
        (s.locked, s.widgets.clone())
    };
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);

    let widget_items: Vec<(&'static str, CheckMenuItem<Wry>)> = WIDGETS
        .iter()
        .map(|d| {
            let on = shown.iter().any(|l| l == d.label);
            CheckMenuItem::with_id(app, format!("widget:{}", d.label), d.name, true, on, None::<&str>).map(|i| (d.label, i))
        })
        .collect::<tauri::Result<_>>()?;
    let widget_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> =
        widget_items.iter().map(|(_, i)| i as &dyn tauri::menu::IsMenuItem<Wry>).collect();
    let widgets_menu = Submenu::with_items(app, "显示组件", true, &widget_refs)?;

    let refresh = MenuItem::with_id(app, "refresh", "立即刷新", true, None::<&str>)?;
    let lock = CheckMenuItem::with_id(app, "lock", "锁定位置和大小", true, locked, None::<&str>)?;
    let through = CheckMenuItem::with_id(app, "through", "鼠标穿透（所有组件）", true, false, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "开机自动启动", true, autostart_on, None::<&str>)?;
    let sign_out = MenuItem::with_id(app, "signout", "退出 Google 登录", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 DeskCalendar", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(
        app,
        &[&widgets_menu, &refresh, &sep()?, &lock, &through, &autostart, &sep()?, &sign_out, &quit],
    )?;
    *state.tray.lock().unwrap() = Some(TrayItems { lock, through, autostart, widgets: widget_items });

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
                apply_click_through_all(app, on);
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
                save_state(app);
                app.exit(0);
            }
            id => {
                if let Some(label) = id.strip_prefix("widget:") {
                    let visible = app.get_webview_window(label).is_none();
                    set_widget_visible(app, label, visible);
                }
            }
        })
        // 左键单击托盘图标：把所有组件临时提到前面（失去焦点后自动退回底层）
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                for w in widget_windows(tray.app_handle()) {
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
            for w in widget_windows(app) {
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
        .manage(AppState {
            demo,
            settings: Mutex::new(Settings::default()),
            click_through: Mutex::new(false),
            tray: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            sign_in,
            sign_out,
            access_token,
            invalidate_token,
            get_locked,
            set_locked,
            click_through_for,
            hide_widget
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = load_settings(&handle);
            // --widgets=month,day,...：本次运行显示指定组件（测试用，不改动保存的选择）
            let shown: Vec<String> = std::env::args()
                .find_map(|a| a.strip_prefix("--widgets=").map(|v| v.split(',').map(str::to_owned).collect()))
                .unwrap_or_else(|| settings.widgets.clone());
            *app.state::<AppState>().settings.lock().unwrap() = settings;
            build_tray(&handle)?;
            for label in &shown {
                open_widget(&handle, label)?;
            }

            // 资源管理器重启后 Progman 会被重建，定期检查并重新挂接
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(5));
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    for w in widget_windows(&h) {
                        if let Some(hwnd) = hwnd_of(&w) {
                            if !desktop::owner_is_valid(hwnd) {
                                desktop::own_by_desktop(hwnd);
                            }
                        }
                    }
                });
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("DeskCalendar 启动失败");
}
