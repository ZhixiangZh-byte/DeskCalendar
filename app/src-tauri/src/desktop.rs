//! 让组件"贴在桌面上"。
//!
//! 可行性验证（feasibility/desktop-layer）的结论：把窗口的**所有者**设为桌面图标层所在的顶层窗口
//! （Win11 24H2 起为 Progman，旧版本为某个顶层 WorkerW）。Windows 保证被拥有的窗口始终在所有者之上，
//! 所以 Win+D 把桌面提到最前时组件也跟着上来；窗口本身仍是普通顶层窗口，鼠标键盘输入都正常。
//! 不要改成 SetParent 挂成子窗口：那样能显示但完全收不到输入。

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, FindWindowW, GW_OWNER, GWLP_HWNDPARENT, GetWindow, HWND_BOTTOM, IsWindow,
    SMTO_NORMAL, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SendMessageTimeoutW, SetWindowLongPtrW, SetWindowPos,
};
use windows::core::{BOOL, PCWSTR, w};

unsafe extern "system" fn find_defview_host(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if unsafe { FindWindowExW(Some(hwnd), None, w!("SHELLDLL_DefView"), PCWSTR::null()) }.is_ok() {
        unsafe { *(lparam.0 as *mut HWND) = hwnd };
        return false.into();
    }
    true.into()
}

/// 桌面图标层所在的顶层窗口
pub fn desktop_host() -> Option<HWND> {
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

pub fn send_to_bottom(hwnd: HWND) {
    unsafe {
        let _ = SetWindowPos(hwnd, Some(HWND_BOTTOM), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

/// 把窗口的所有者设为桌面窗口并退到底层。返回是否成功。
pub fn own_by_desktop(hwnd: HWND) -> bool {
    let Some(host) = desktop_host() else { return false };
    unsafe { SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, host.0 as isize) };
    send_to_bottom(hwnd);
    true
}

/// 所有者是否仍然有效（资源管理器重启后 Progman 会被重建，需要重新挂接）
pub fn owner_is_valid(hwnd: HWND) -> bool {
    unsafe {
        match GetWindow(hwnd, GW_OWNER) {
            // 只做轻量检查（不发消息）：所有者仍存在且仍包含桌面图标层
            Ok(owner) => {
                IsWindow(Some(owner)).as_bool()
                    && FindWindowExW(Some(owner), None, w!("SHELLDLL_DefView"), PCWSTR::null()).is_ok()
            }
            Err(_) => false,
        }
    }
}
