# 冒烟测试：以演示数据启动全部组件，检查每个窗口存在、所有者是桌面窗口、按 Win+D（显示桌面）后仍可见。
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

$widgets = [ordered]@{ month = '月历'; day = '日视图'; quadrant = '四象限'; review = '回顾箱'; longterm = '长期规划' }
$exe = Join-Path $PSScriptRoot "..\src-tauri\target\$(if ($Release) { 'release' } else { 'debug' })\DeskCalendar.exe"
$proc = Start-Process -FilePath $exe -ArgumentList '--demo', "--widgets=$($widgets.Keys -join ',')" -PassThru

$found = @{}
for ($i = 0; $i -lt 80 -and $found.Count -lt $widgets.Count; $i++) {
    Start-Sleep -Milliseconds 250
    foreach ($k in $widgets.Keys) {
        if (-not $found.Contains($k)) {
            # PowerShell 会把 $null 当空字符串传给 .NET，类名参数必须用 [NullString]::Value
            $h = [W]::FindWindow([NullString]::Value, "DeskCalendar $($widgets[$k])")
            if ($h -ne [IntPtr]::Zero) { $found[$k] = $h }
        }
    }
}
Start-Sleep -Seconds 2

# 沿 Z 序向下查找：能找到桌面窗口（Progman）说明组件位于桌面之上
function AboveDesktop([IntPtr]$h) {
    $n = $h
    for ($i = 0; $i -lt 5000; $i++) {
        $n = [W]::GetWindow($n, 2)   # GW_HWNDNEXT
        if ($n -eq [IntPtr]::Zero) { return $false }
        if ([W]::Cls($n) -eq 'Progman') { return $true }
    }
    return $false
}
function DesktopShown { @('Progman', 'WorkerW') -contains [W]::Cls([W]::GetForegroundWindow()) }
function WaitFor([scriptblock]$c) { for ($i = 0; $i -lt 40; $i++) { if (& $c) { Start-Sleep -Milliseconds 700; return $true }; Start-Sleep -Milliseconds 100 }; $false }

# 用真实按键模拟 Win+D：Shell.ToggleDesktop() 在其他程序抢占前台时不可靠
[W]::WinD(); $shown = WaitFor { DesktopShown }
$rows = foreach ($k in $widgets.Keys) {
    $h = $found[$k]
    if (-not $h) { [pscustomobject]@{ widget = $k; found = $false }; continue }
    $r = New-Object W+RECT; [void][W]::GetWindowRect($h, [ref]$r)
    # 取每个窗口左上角附近的点做命中测试
    $p = New-Object W+POINT; $p.X = $r.L + 20; $p.Y = $r.T + 15
    $hit = [W]::WindowFromPoint($p)
    [pscustomobject]@{
        widget           = $k
        found            = $true
        ownerClass       = [W]::Cls([W]::GetWindow($h, 4))   # GW_OWNER
        size             = "$($r.R - $r.L)x$($r.B - $r.T)"
        aboveDesktop     = AboveDesktop $h
        # 组件之间可能互相重叠，命中任一组件都算没有被桌面盖住
        hitIsWidget      = [bool]($found.Values | Where-Object { $_ -eq $hit -or [W]::IsChild($_, $hit) })
    }
}
[W]::WinD(); [void](WaitFor { -not (DesktopShown) })

"desktopShown: $shown   processAlive: $(-not $proc.HasExited)"
$rows | Format-Table -AutoSize | Out-String
Stop-Process $proc -Force -ErrorAction SilentlyContinue
