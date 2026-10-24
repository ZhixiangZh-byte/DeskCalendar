//! 桌面层原型：验证透明无边框窗口能否"贴在桌面上"（按 Win+D 显示桌面后仍可见）。
//!
//! 启动参数 `--mode=`：
//! - `owned`（默认）：普通顶层窗口，所有者设为桌面窗口，平时退到底层
//! - `desktop`：作为子窗口挂到桌面图标层所在的窗口（含 SHELLDLL_DefView 的 Progman / WorkerW）下。
//!   2026-10-24 实测：Win+D 后可见，但点击、输入、拖动全部无效
//! - `bottom`：普通窗口，始终置于 Z 序最底层（对照组，预期按 Win+D 后会被盖住）
//! - `normal`：带任务栏按钮的普通窗口（对照组）

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{Manager, WebviewWindow, WindowEvent};
use windows::core::{w, BOOL, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::MapWindowPoints;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, FindWindowW, GetClassNameW, GetWindowRect, SendMessageTimeoutW, SetParent,
    SetWindowLongPtrW, SetWindowPos, GWLP_HWNDPARENT, HWND_BOTTOM, HWND_TOP, SMTO_NORMAL, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SWP_SHOWWINDOW,
};

#[derive(Clone, Serialize, Default)]
struct Status {
    mode: String,
    hwnd: isize,
    host: isize,
    host_class: String,
    error: Option<String>,
}

struct AppState(Mutex<Status>);

fn hwnd_of(window: &WebviewWindow) -> HWND {
    // tauri 与本 crate 使用同一版本的 windows crate，这里按原始句柄值转换，避免版本耦合
    HWND(window.hwnd().expect("取不到窗口句柄").0)
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

unsafe extern "system" fn find_defview_host(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if unsafe { FindWindowExW(Some(hwnd), None, w!("SHELLDLL_DefView"), PCWSTR::null()) }.is_ok() {
        unsafe { *(lparam.0 as *mut HWND) = hwnd };
        return false.into();
    }
    true.into()
}

/// 找到桌面图标层所在的窗口。Win11 24H2 起图标层直接在 Progman 下；旧版本在某个顶层 WorkerW 下。
fn desktop_host() -> Option<HWND> {
    unsafe {
        let progman = FindWindowW(w!("Progman"), PCWSTR::null()).ok()?;
        // 0x052C：让 Progman 创建壁纸用的 WorkerW（壁纸类软件的通用做法），保证层级稳定
        let _ = SendMessageTimeoutW(progman, 0x052C, WPARAM(0xD), LPARAM(0x1), SMTO_NORMAL, 1000, None);
        if FindWindowExW(Some(progman), None, w!("SHELLDLL_DefView"), PCWSTR::null()).is_ok() {
            return Some(progman);
        }
        let mut host = HWND::default();
        let _ = EnumWindows(Some(find_defview_host), LPARAM(&mut host as *mut HWND as isize));
        (!host.is_invalid()).then_some(host)
    }
}

fn attach_to_desktop(hwnd: HWND) -> Result<HWND, String> {
    let host = desktop_host().ok_or("找不到桌面图标层窗口")?;
    unsafe {
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).map_err(|e| e.to_string())?;
        SetParent(hwnd, Some(host)).map_err(|e| format!("SetParent 失败：{e}"))?;
        // 父窗口坐标系 = 虚拟屏幕坐标，需要换算
        let mut pts = [POINT { x: rect.left, y: rect.top }];
        MapWindowPoints(None, Some(host), &mut pts);
        SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            pts[0].x,
            pts[0].y,
            rect.right - rect.left,
            rect.bottom - rect.top,
            SWP_SHOWWINDOW | SWP_NOACTIVATE,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(host)
}

fn send_to_bottom(hwnd: HWND) {
    unsafe {
        let _ = SetWindowPos(hwnd, Some(HWND_BOTTOM), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

#[tauri::command]
fn status(state: tauri::State<AppState>) -> Status {
    state.0.lock().unwrap().clone()
}

/// 鼠标穿透 seconds 秒后自动恢复（原型里没有托盘菜单，避免"点不回来"）
#[tauri::command]
fn click_through_for(window: WebviewWindow, seconds: u64) -> Result<(), String> {
    window.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(seconds));
        let _ = window.set_ignore_cursor_events(false);
    });
    Ok(())
}

/// 前端把收到的交互事件报给 Rust，打印到 stdout 供自动化测试读取
#[tauri::command]
fn log_event(kind: String, data: serde_json::Value) {
    println!("DESKLAYER_EVENT {}", serde_json::json!({ "kind": kind, "data": data }));
}

/// 把窗口的所有者设为桌面窗口：窗口仍是普通顶层窗口（输入正常），
/// 但 Windows 保证被拥有的窗口始终在所有者之上，所以 Win+D 把桌面提到最前时组件跟着上来。
fn own_by_desktop(hwnd: HWND) -> Result<HWND, String> {
    let host = desktop_host().ok_or("找不到桌面图标层窗口")?;
    unsafe { SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, host.0 as isize) };
    send_to_bottom(hwnd);
    Ok(host)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mode = std::env::args()
        .find_map(|a| a.strip_prefix("--mode=").map(str::to_owned))
        .unwrap_or_else(|| "owned".into());

    tauri::Builder::default()
        .manage(AppState(Mutex::new(Status::default())))
        .invoke_handler(tauri::generate_handler![status, click_through_for, log_event])
        .setup(move |app| {
            let window = app.get_webview_window("widget").expect("缺少 widget 窗口");
            let hwnd = hwnd_of(&window);
            let mut st = Status { mode: mode.clone(), hwnd: hwnd.0 as isize, ..Default::default() };
            let attached = match mode.as_str() {
                "desktop" => Some(attach_to_desktop(hwnd)),
                "owned" => Some(own_by_desktop(hwnd)),
                "bottom" => {
                    send_to_bottom(hwnd);
                    None
                }
                // 对照组：带任务栏按钮的普通窗口，按 Win+D 后应被最小化（用来确认检测方法有效）
                _ => {
                    window.set_skip_taskbar(false)?;
                    None
                }
            };
            match attached {
                Some(Ok(host)) => {
                    st.host = host.0 as isize;
                    st.host_class = class_name(host);
                }
                Some(Err(e)) => st.error = Some(e),
                None => {}
            }
            let keep_bottom = matches!(mode.as_str(), "owned" | "bottom");
            let w = window.clone();
            window.on_window_event(move |e| match e {
                // 失去焦点后退回底层（在桌面之上、其他窗口之下）
                WindowEvent::Focused(false) if keep_bottom => send_to_bottom(hwnd_of(&w)),
                WindowEvent::Focused(f) => log_event("focus".into(), serde_json::json!(f)),
                WindowEvent::Moved(p) => log_event("moved".into(), serde_json::json!([p.x, p.y])),
                WindowEvent::Resized(s) => log_event("resized".into(), serde_json::json!([s.width, s.height])),
                _ => {}
            });
            // 供自动化测试读取
            println!("DESKLAYER_STATUS {}", serde_json::to_string(&st).unwrap());
            *app.state::<AppState>().0.lock().unwrap() = st;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
