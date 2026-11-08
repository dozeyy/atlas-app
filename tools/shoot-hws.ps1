# Screenshots of the real running app for History, Wrapped and Settings.
# Dev data only: a fixture folder (--config-dir) and a scratch data dir; nothing under the real
# Claude folder is touched, and the app gets its own WebView2 profile.
#
#   powershell -NoProfile -File tools\shoot-hws.ps1 -Config <fixture .claude> -Data <scratch> -Out <dir> [-Theme light|silver|dark] [-Width 1280 -Height 800] [-Views history,wrapped,settings] [-Keep]
#
# Writes <Out>\<view>-<theme>-<W>x<H>.png (the window rect, actual pixels) and <Out>\app-<theme>.log.
param(
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][string]$Data,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Theme = "light",
  [int]$Width = 1280,
  [int]$Height = 800,
  [string[]]$Views = @("history", "wrapped", "settings"),
  [string]$Exe = "",
  [int]$SettleMs = 5000,
  [switch]$Keep
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $Exe) { $Exe = Join-Path $root "target\debug\atlas.exe" }
$Exe = (Resolve-Path $Exe).Path
New-Item -ItemType Directory -Force $Out, $Data | Out-Null
$Out = (Resolve-Path $Out).Path
$Data = (Resolve-Path $Data).Path

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
[void][W]::SetProcessDPIAware()

# Pin the theme in the scratch settings before launch (the app keeps unknown keys).
$settings = Join-Path $Data "settings.json"
if (Test-Path $settings) {
  $j = Get-Content $settings -Raw | ConvertFrom-Json
  $j.theme = $Theme
  $j | ConvertTo-Json -Depth 8 | Set-Content $settings -Encoding utf8
}

Get-Process atlas -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | Stop-Process -Force
Start-Sleep -Milliseconds 400
$env:ATLAS_NO_INTRO = "1"
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $Data "webview2"
$log = Join-Path $Out "app-$Theme.log"
$app = Start-Process $Exe -ArgumentList @("--config-dir", $Config, "--data-dir", $Data) -RedirectStandardError $log -PassThru

$h = [IntPtr]::Zero
for ($i = 0; $i -lt 100 -and $h -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 200
  $app.Refresh()
  $h = $app.MainWindowHandle
}
if ($h -eq [IntPtr]::Zero) { throw "Atlas never showed a window" }

if (-not (Test-Path $settings)) {
  # First run: the app has just written its settings. Pin the theme and relaunch once.
  Start-Sleep -Milliseconds 1500
  if (Test-Path $settings) {
    $app | Stop-Process -Force
    Start-Sleep -Milliseconds 600
    $j = Get-Content $settings -Raw | ConvertFrom-Json
    $j.theme = $Theme
    $j | ConvertTo-Json -Depth 8 | Set-Content $settings -Encoding utf8
    $app = Start-Process $Exe -ArgumentList @("--config-dir", $Config, "--data-dir", $Data) -RedirectStandardError $log -PassThru
    $h = [IntPtr]::Zero
    for ($i = 0; $i -lt 100 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 200; $app.Refresh(); $h = $app.MainWindowHandle }
  }
}

[void][W]::ShowWindow($h, 9)
[void][W]::SetWindowPos($h, [IntPtr]::Zero, 40, 20, $Width, $Height, 0x0040)
# Alt tap lets SetForegroundWindow through.
[W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][W]::SetForegroundWindow($h)
Start-Sleep -Milliseconds $SettleMs

$keys = @{ history = "^4"; wrapped = "^5"; settings = "^6"; dashboard = "^1"; sessions = "^2"; toolkit = "^3" }
foreach ($v in $Views) {
  [W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][W]::SetForegroundWindow($h)
  [System.Windows.Forms.SendKeys]::SendWait($keys[$v])
  Start-Sleep -Milliseconds 1800
  $r = New-Object W+RECT
  [void][W]::GetWindowRect($h, [ref]$r)
  $w = $r.R - $r.L; $hh = $r.B - $r.T
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
  $file = Join-Path $Out "$v-$Theme-${Width}x${Height}.png"
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  "$file ($w x $hh)"
}
if (-not $Keep) { Get-Process atlas -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | Stop-Process -Force }
