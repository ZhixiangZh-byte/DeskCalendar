# 桌面层原型自动检查：对每种模式启动原型 → "显示桌面" → 检测卡片中心点是否仍是原型窗口 → 恢复。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File selftest.ps1 [-Modes owned,desktop,bottom,normal] [-Hotkey]
# -Hotkey：用模拟按键 Win+D 代替 Shell.ToggleDesktop()
param([string[]]$Modes = @('owned', 'desktop', 'bottom', 'normal'), [switch]$Hotkey)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static void WinD() { keybd_event(0x5B,0,0,UIntPtr.Zero); keybd_event(0x44,0,0,UIntPtr.Zero); keybd_event(0x44,0,2,UIntPtr.Zero); keybd_event(0x5B,0,2,UIntPtr.Zero); }
}
"@

$exe = Join-Path $PSScriptRoot 'src-tauri\target\debug\desktop-layer.exe'
$shell = New-Object -ComObject Shell.Application
$desktopClasses = @('Progman', 'WorkerW')

function DesktopShown { $desktopClasses -contains [W]::Cls([W]::GetForegroundWindow()) }
function Toggle { if ($Hotkey) { [W]::WinD() } else { $shell.ToggleDesktop() } }
function WaitFor([scriptblock]$cond) {
    for ($i = 0; $i -lt 40; $i++) { if (& $cond) { Start-Sleep -Milliseconds 700; return $true }; Start-Sleep -Milliseconds 100 }
    return $false
}

$results = @()
foreach ($mode in $Modes) {
    $out = Join-Path $env:TEMP "desklayer-$mode-$PID.txt"
    $proc = Start-Process -FilePath $exe -ArgumentList "--mode=$mode" -RedirectStandardOutput $out -PassThru
    $status = $null
    for ($i = 0; $i -lt 60 -and -not $status; $i++) {
        Start-Sleep -Milliseconds 250
        $line = Get-Content $out -ErrorAction SilentlyContinue | Where-Object { $_ -like 'DESKLAYER_STATUS *' } | Select-Object -First 1
        if ($line) { $status = $line.Substring(17) | ConvertFrom-Json }
    }
    if (-not $status) { $results += [pscustomobject]@{ mode = $mode; note = 'no status output' }; Stop-Process $proc -Force; continue }
    Start-Sleep -Seconds 2   # 等 WebView 渲染

    $hwnd = [IntPtr]$status.hwnd
    $parent = [W]::GetAncestor($hwnd, 1)   # GA_PARENT：顶层窗口返回桌面窗口，挂到桌面层后返回 Progman
    $r = New-Object W+RECT; [void][W]::GetWindowRect($hwnd, [ref]$r)
    $p = New-Object W+POINT; $p.X = [int](($r.L + $r.R) / 2); $p.Y = [int](($r.T + $r.B) / 2)

    $wasShown = DesktopShown
    Toggle
    $shown = WaitFor { DesktopShown }
    $hit = [W]::WindowFromPoint($p)
    $visible = ($hit -eq $hwnd) -or [W]::IsChild($hwnd, $hit)
    $iconic = [W]::IsIconic($hwnd)
    $hitClass = [W]::Cls($hit)
    Toggle
    $restored = WaitFor { -not (DesktopShown) }

    $results += [pscustomobject]@{
        mode             = $mode
        method           = $(if ($Hotkey) { 'Win+D' } else { 'ToggleDesktop' })
        parentClass      = [W]::Cls($parent)
        desktopShown     = $shown -and -not $wasShown
        visibleAfterWinD = $visible
        minimized        = $iconic
        hitClass         = $hitClass
        restored         = $restored
    }
    Stop-Process $proc -Force -ErrorAction SilentlyContinue
    Remove-Item $out -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}
$results | Format-Table -AutoSize | Out-String -Width 200
