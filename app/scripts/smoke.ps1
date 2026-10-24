# 冒烟测试：以演示数据启动组件，检查窗口存在、所有者是桌面窗口、按 Win+D（显示桌面）后仍可见。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke.ps1 [-Release]
param([switch]$Release)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static void WinD() { keybd_event(0x5B,0,0,UIntPtr.Zero); keybd_event(0x44,0,0,UIntPtr.Zero); keybd_event(0x44,0,2,UIntPtr.Zero); keybd_event(0x5B,0,2,UIntPtr.Zero); }
}
"@
[void][W]::SetProcessDPIAware()

$exe = Join-Path $PSScriptRoot "..\src-tauri\target\$(if ($Release) { 'release' } else { 'debug' })\DeskCalendar.exe"
$proc = Start-Process -FilePath $exe -ArgumentList '--demo' -PassThru
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 60 -and $hwnd -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 250; $hwnd = [W]::FindWindow([NullString]::Value, 'DeskCalendar 月历') }
Start-Sleep -Seconds 2
$owner = [W]::GetWindow($hwnd, 4)   # GW_OWNER
$r = New-Object W+RECT; [void][W]::GetWindowRect($hwnd, [ref]$r)
$p = New-Object W+POINT; $p.X = [int](($r.L + $r.R) / 2); $p.Y = [int](($r.T + $r.B) / 2)

function DesktopShown { @('Progman', 'WorkerW') -contains [W]::Cls([W]::GetForegroundWindow()) }
function WaitFor([scriptblock]$c) { for ($i = 0; $i -lt 40; $i++) { if (& $c) { Start-Sleep -Milliseconds 700; return $true }; Start-Sleep -Milliseconds 100 }; $false }
# 用真实按键模拟 Win+D：Shell.ToggleDesktop() 在其他程序抢占前台时不可靠
[W]::WinD(); $shown = WaitFor { DesktopShown }
$hit = [W]::WindowFromPoint($p)
$visible = ($hit -eq $hwnd) -or [W]::IsChild($hwnd, $hit)
[W]::WinD(); [void](WaitFor { -not (DesktopShown) })

[pscustomobject]@{
    windowFound      = $hwnd -ne [IntPtr]::Zero
    processAlive     = -not $proc.HasExited
    ownerClass       = [W]::Cls($owner)
    size             = "$($r.R - $r.L)x$($r.B - $r.T)"
    desktopShown     = $shown
    visibleAfterWinD = $visible
} | Format-List | Out-String
Stop-Process $proc -Force -ErrorAction SilentlyContinue
