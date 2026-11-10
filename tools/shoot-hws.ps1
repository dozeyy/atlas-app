# Screenshots of the real running app for History, Wrapped and Settings.
# Dev data only: a fixture folder (--config-dir) and a scratch data dir; nothing under the real
# Claude folder is touched, and the app gets its own WebView2 profile.
#
#   powershell -NoProfile -File tools\shoot-hws.ps1 -Config <fixture .claude> -Data <scratch> -Out <dir>
#       [-Theme light|silver|dark] [-Width 1280 -Height 800] [-Views history,wrapped,settings]
#       [-Click "x,y;k:text;x,y"] [-EditFixture] [-Tag name]   (k:text types into the focused field)
#
# One fresh launch per view (the view is pinned through the scratch settings.json, so no key
# presses are needed). The window is moved to the primary screen, made topmost and captured from
# the screen. -Click runs window-relative clicks (after settle) before the capture.
# -EditFixture appends to the fixture's CLAUDE.md first, so History shows a live "changed" row.
# Writes <Out>\<view>-<theme>-<W>x<H>[-tag].png and <Out>\app-<theme>.log.
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
  [string]$Click = "",
  [string]$Tag = "",
  [string]$Park = "",
  [switch]$EditFixture
)
$ErrorActionPreference = "Stop"
$Views = @($Views | ForEach-Object { $_ -split "," })   # -File passes "a,b" as one string
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
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  /// The visible frame (no invisible resize border): what the eye sees.
  public static RECT Visible(IntPtr h) { RECT r; DwmGetWindowAttribute(h, 9, out r, 16); return r; }
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  /// The app's real window (class "Tauri Window"), not the tray or message windows.
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) { var c = new System.Text.StringBuilder(64); GetClassName(h, c, 64); if (c.ToString() == "Tauri Window") { found = h; return false; } } return true; }, IntPtr.Zero);
    return found;
  }
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
"@
[void][W]::SetProcessDPIAware()

function Stop-Atlas { Get-Process atlas -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | Stop-Process -Force; Start-Sleep -Milliseconds 700 }

foreach ($v in $Views) {
  Stop-Atlas
  # Pin theme and view in the scratch settings (the app keeps keys it does not know).
  $settings = Join-Path $Data "settings.json"
  @{ schemaVersion = 1; theme = $Theme; lastView = $v } | ConvertTo-Json | Set-Content $settings -Encoding utf8

  $env:ATLAS_NO_INTRO = "1"
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $Data "webview2"
  $log = Join-Path $Out "app-$Theme.log"
  $app = Start-Process $Exe -ArgumentList @("--config-dir", $Config, "--data-dir", $Data) -RedirectStandardError $log -PassThru
  $h = [IntPtr]::Zero
  for ($i = 0; $i -lt 100 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 200; $h = [W]::Find([uint32]$app.Id) }
  if ($h -eq [IntPtr]::Zero) { throw "Atlas never showed a window" }

  Start-Sleep -Milliseconds 1500
  [void][W]::ShowWindow($h, 9)
  # HWND_TOPMOST (-1), SWP_SHOWWINDOW (0x40): above the terminal, on the primary screen.
  [void][W]::SetWindowPos($h, [IntPtr](-1), 80, 60, $Width, $Height, 0x0040)
  Start-Sleep -Milliseconds $SettleMs
  [void][W]::SetWindowPos($h, [IntPtr](-1), 80, 60, $Width, $Height, 0x0040)
  # Size the window so the VISIBLE frame is exactly Width x Height.
  $o = New-Object W+RECT; [void][W]::GetWindowRect($h, [ref]$o); $vis = [W]::Visible($h)
  $padW = ($o.R - $o.L) - ($vis.R - $vis.L); $padH = ($o.B - $o.T) - ($vis.B - $vis.T)
  [void][W]::SetWindowPos($h, [IntPtr](-1), 80, 60, $Width + $padW, $Height + $padH, 0x0040)
  Start-Sleep -Milliseconds 900

  if ($EditFixture) {
    Add-Content (Join-Path $Config "CLAUDE.md") "`nA line added while Atlas was running."
    Start-Sleep -Milliseconds 3500
  }

  $r = [W]::Visible($h)
  if ($Click) {
    foreach ($pt in $Click.Split(";")) {
      if ($pt.StartsWith("k:")) {   # "k:text" types into whatever has focus (SendKeys syntax)
        [System.Windows.Forms.SendKeys]::SendWait($pt.Substring(2))
        Start-Sleep -Milliseconds 600
        continue
      }
      $xy = $pt.Split(",")
      [void][W]::SetCursorPos($r.L + [int]$xy[0], $r.T + [int]$xy[1])
      Start-Sleep -Milliseconds 150
      [W]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [W]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 900
    }
  }
  # The pointer rests in the corner (it opens the menu button's hover menu); -Park "x,y" puts it elsewhere.
  $pk = if ($Park) { $Park.Split(",") } else { @("2", "2") }
  [void][W]::SetCursorPos($r.L + [int]$pk[0], $r.T + [int]$pk[1])
  Start-Sleep -Milliseconds 500

  $w = $r.R - $r.L; $hh = $r.B - $r.T
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
  $name = "$v-$Theme-${Width}x${Height}" + $(if ($Tag) { "-$Tag" } else { "" }) + ".png"
  $file = Join-Path $Out $name
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  "$file ($w x $hh)"
  Stop-Atlas
}

