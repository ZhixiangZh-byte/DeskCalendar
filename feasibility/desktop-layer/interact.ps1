# 桌面层原型交互测试：显示桌面后，模拟点击按钮、在输入框打字、拖动标题栏，读取原型报告的事件判断是否生效。
# 只对 Win+D 后仍可见的模式做交互，避免点到桌面图标。结束时恢复窗口和鼠标位置。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File interact.ps1 [-Modes owned,desktop]
param([string[]]$Modes = @('owned', 'desktop'))

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static void Key(byte vk) { keybd_event(vk,0,0,UIntPtr.Zero); System.Threading.Thread.Sleep(30); keybd_event(vk,0,2,UIntPtr.Zero); System.Threading.Thread.Sleep(30); }
  public static void WinD() { keybd_event(0x5B,0,0,UIntPtr.Zero); keybd_event(0x44,0,0,UIntPtr.Zero); keybd_event(0x44,0,2,UIntPtr.Zero); keybd_event(0x5B,0,2,UIntPtr.Zero); }
  public static void Click(int x, int y) { SetCursorPos(x, y); System.Threading.Thread.Sleep(80); mouse_event(2,0,0,0,UIntPtr.Zero); System.Threading.Thread.Sleep(60); mouse_event(4,0,0,0,UIntPtr.Zero); }
  public static void Drag(int x, int y, int dx, int dy) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(100); mouse_event(2,0,0,0,UIntPtr.Zero); System.Threading.Thread.Sleep(150);
    for (int i = 1; i <= 15; i++) { SetCursorPos(x + dx * i / 15, y + dy * i / 15); System.Threading.Thread.Sleep(25); }
    System.Threading.Thread.Sleep(100); mouse_event(4,0,0,0,UIntPtr.Zero);
  }
}
"@

# 与原型一致使用物理像素坐标（否则显示缩放 >100% 时坐标对不上）
[void][W]::SetProcessDPIAware()
$exe = Join-Path $PSScriptRoot 'src-tauri\target\debug\desktop-layer.exe'
$shell = New-Object -ComObject Shell.Application
function DesktopShown { @('Progman', 'WorkerW') -contains [W]::Cls([W]::GetForegroundWindow()) }
function WaitFor([scriptblock]$cond) {
    for ($i = 0; $i -lt 40; $i++) { if (& $cond) { Start-Sleep -Milliseconds 700; return $true }; Start-Sleep -Milliseconds 100 }
    return $false
}
function Events($file) {
    Get-Content $file -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_ -like 'DESKLAYER_EVENT *' } | ForEach-Object { $_.Substring(16) | ConvertFrom-Json }
}

$cursor = New-Object W+POINT; [void][W]::GetCursorPos([ref]$cursor)
$results = @()
foreach ($mode in $Modes) {
    $out = Join-Path $env:TEMP "deskinteract-$mode-$PID.txt"
    $proc = Start-Process -FilePath $exe -ArgumentList "--mode=$mode" -RedirectStandardOutput $out -PassThru
    $status = $null; $layout = $null
    for ($i = 0; $i -lt 80 -and -not ($status -and $layout); $i++) {
        Start-Sleep -Milliseconds 250
        $line = Get-Content $out -ErrorAction SilentlyContinue | Where-Object { $_ -like 'DESKLAYER_STATUS *' } | Select-Object -First 1
        if ($line) { $status = $line.Substring(17) | ConvertFrom-Json }
        $layout = (Events $out | Where-Object kind -eq 'layout' | Select-Object -Last 1).data
    }
    if (-not ($status -and $layout)) { $results += [pscustomobject]@{ mode = $mode; note = '原型未输出状态或布局' }; Stop-Process $proc -Force; continue }
    Start-Sleep -Seconds 1
    $hwnd = [IntPtr]$status.hwnd
    $r = New-Object W+RECT; [void][W]::GetWindowRect($hwnd, [ref]$r)
    $at = { param($pt) @(($r.L + $pt[0]), ($r.T + $pt[1])) }

    [W]::WinD(); [void](WaitFor { DesktopShown })
    $c = & $at $layout.counter
    $probe = New-Object W+POINT; $probe.X = $c[0]; $probe.Y = $c[1]
    $hit = [W]::WindowFromPoint($probe)
    $visible = ($hit -eq $hwnd) -or [W]::IsChild($hwnd, $hit)

    $row = [ordered]@{ mode = $mode; rect = "$($r.L),$($r.T) $($r.R - $r.L)x$($r.B - $r.T)"; probe = "$($c[0]),$($c[1])"; hitClass = [W]::Cls($hit); visibleAfterWinD = $visible }
    if ($visible) {
        [W]::Click($c[0], $c[1]); Start-Sleep -Milliseconds 400
        [W]::Click($c[0], $c[1]); Start-Sleep -Milliseconds 400
        $t = & $at $layout.text
        [W]::Click($t[0], $t[1]); Start-Sleep -Milliseconds 400
        foreach ($vk in 0x41, 0x42, 0x43, 0x31, 0x32, 0x33) { [W]::Key([byte]$vk) }   # a b c 1 2 3
        Start-Sleep -Milliseconds 500
        $h = & $at $layout.header
        [W]::Drag($h[0], $h[1], 80, 50); Start-Sleep -Milliseconds 600
        $r2 = New-Object W+RECT; [void][W]::GetWindowRect($hwnd, [ref]$r2)

        $ev = @(Events $out)
        $row.pointerdowns = @($ev | Where-Object kind -eq 'pointerdown').Count
        $row.clicks = @($ev | Where-Object kind -eq 'click').Count
        $row.typed = (@($ev | Where-Object kind -eq 'input') | Select-Object -Last 1).data
        $row.keydowns = @($ev | Where-Object kind -eq 'keydown').Count
        $row.moved = "$($r2.L - $r.L),$($r2.T - $r.T)"
        $row.gotFocus = @($ev | Where-Object { $_.kind -eq 'focus' -and $_.data -eq $true }).Count -gt 0
    }
    # 恢复：再按一次 Win+D；若点击组件打断了"显示桌面"状态，则改用"撤销全部最小化"
    [W]::WinD(); [void](WaitFor { -not (DesktopShown) })
    if ((DesktopShown) -or ([W]::GetForegroundWindow() -eq $hwnd)) { $shell.UndoMinimizeALL(); Start-Sleep -Milliseconds 800 }
    $results += [pscustomobject]$row
    Stop-Process $proc -Force -ErrorAction SilentlyContinue
    Remove-Item $out -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}
[void][W]::SetCursorPos($cursor.X, $cursor.Y)
$results | Format-Table -AutoSize | Out-String -Width 220
