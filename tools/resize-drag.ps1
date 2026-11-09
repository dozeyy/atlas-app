# Real edge drags on the Atlas window with screen captures right after each move.
# Dev data only: pass a fixture --config-dir (tools/make-demo-fixture.py) and a scratch --data-dir.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\resize-drag.ps1 -Exe target\debug\atlas.exe `
#     -ConfigDir <fixture>\home\.claude -DataDir <scratch> -Out <scratch>\frames -Edges L,T,TL,BR,R,B -Mode shrink
#   python tools\analyze-resize.py <scratch>\frames <scratch>\sheets
#
# Per edge: SendInput press on the native resize border, Steps moves of StepPx, PerStep captures
# (DwmFlush + screen copy) right after each move, then one settled capture 250 ms later. meta.json
# holds each frame's DWM window rect in capture coordinates. The app is killed at the end, so the
# window-state plugin never saves the test bounds.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$ConfigDir,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [Parameter(Mandatory = $true)][string]$Out,
  [string[]]$Edges = @("L"),
  [string]$Mode = "shrink",
  [int]$Steps = 10,
  [int]$StepPx = 12,
  [int]$PerStep = 4,
  [switch]$KeepOpen
)
$ErrorActionPreference = "Stop"
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
public static class Drag {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy, mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public int type; public MOUSEINPUT mi; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("dwmapi.dll")] static extern int DwmFlush();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  public static RECT Bounds(IntPtr h) { RECT r; DwmGetWindowAttribute(h, 9, out r, 16); return r; }
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  public static IntPtr Find(uint want) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == want && IsWindowVisible(h)) { var c = new System.Text.StringBuilder(64); GetClassName(h, c, 64); if (c.ToString() == "Tauri Window") found = h; }
      return true; }, IntPtr.Zero);
    return found;
  }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  public static int HitTest(IntPtr h, int x, int y) {
    return (int)SendMessage(h, 0x84, IntPtr.Zero, (IntPtr)((y << 16) | (x & 0xFFFF)));
  }
  static void Btn(int flag) {
    var i = new INPUT[1]; i[0].type = 0; i[0].mi.dwFlags = flag;
    if (SendInput(1, i, Marshal.SizeOf(typeof(INPUT))) != 1) throw new Exception("SendInput failed, size " + Marshal.SizeOf(typeof(INPUT)));
  }
  public class Frame { public Bitmap Img; public long Ms; public RECT Win; public int Step; public int Sub; }
  static Bitmap Grab(Rectangle reg) {
    var b = new Bitmap(reg.Width, reg.Height, PixelFormat.Format32bppRgb);
    using (var g = Graphics.FromImage(b)) g.CopyFromScreen(reg.X, reg.Y, 0, 0, reg.Size, CopyPixelOperation.SourceCopy);
    return b;
  }
  // Presses at (x,y), moves (dx,dy) per step, grabs `frames` screen captures right after each move.
  public static List<Frame> Run(IntPtr h, int x, int y, int dx, int dy, int steps, int frames, Rectangle reg) {
    var list = new List<Frame>();
    var sw = Stopwatch.StartNew();
    SetCursorPos(x, y); Thread.Sleep(150);
    Btn(0x0002); Thread.Sleep(120);
    for (int s = 1; s <= steps; s++) {
      SetCursorPos(x + dx * s, y + dy * s);
      for (int f = 0; f < frames; f++) {
        DwmFlush();
        var fr = new Frame(); fr.Step = s; fr.Sub = f; fr.Ms = sw.ElapsedMilliseconds;
        fr.Win = Bounds(h);
        fr.Img = Grab(reg);
        list.Add(fr);
      }
      Thread.Sleep(250);
      var st = new Frame(); st.Step = s; st.Sub = 99; st.Ms = sw.ElapsedMilliseconds;
      st.Win = Bounds(h); st.Img = Grab(reg); list.Add(st);
    }
    Btn(0x0004);
    return list;
  }
}
"@
[Drag]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
New-Item -ItemType Directory -Force $DataDir, $Out | Out-Null
$sp = Join-Path $DataDir "settings.json"
if (Test-Path $sp) { $j = Get-Content -Raw $sp | ConvertFrom-Json; $j.lastView = "dashboard"; [IO.File]::WriteAllText($sp, ($j | ConvertTo-Json)) }
$env:ATLAS_NO_INTRO = "1"; $env:ATLAS_MULTI = "1"
$app = Start-Process $Exe -ArgumentList @("--config-dir", "`"$ConfigDir`"", "--data-dir", "`"$DataDir`"") -RedirectStandardError (Join-Path $Out "atlas.log") -PassThru
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 100 -and $h -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 150; $h = [Drag]::Find([uint32]$app.Id)
}
if ($h -eq [IntPtr]::Zero) { throw "no window" }
Start-Sleep -Milliseconds 2500
$X0 = 260; $Y0 = 160; $W0 = 1240; $H0 = 820
foreach ($edge in $Edges) {
  [Drag]::SetWindowPos($h, [IntPtr](-1), $X0, $Y0, $W0, $H0, 0x0040) | Out-Null   # topmost, show
  [Drag]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 1200
  $r = [Drag]::Bounds($h)
  $sign = if ($Mode -eq "shrink") { 1 } else { -1 }
  $x = [int](($r.L + $r.R) / 2); $y = [int](($r.T + $r.B) / 2); $dx = 0; $dy = 0
  if ($edge.Contains("L")) { $x = $r.L - 3; $dx = $sign * $StepPx }
  if ($edge.Contains("R")) { $x = $r.R + 2; $dx = -$sign * $StepPx }
  if ($edge.Contains("T")) { $y = $r.T + 2; $dy = $sign * $StepPx }
  if ($edge.Contains("B")) { $y = $r.B + 2; $dy = -$sign * $StepPx }
  $ht = [Drag]::HitTest($h, $x, $y)
  $m = 40 + $Steps * $StepPx
  $reg = New-Object System.Drawing.Rectangle(($r.L - $m), ($r.T - $m), ($r.R - $r.L + 2 * $m), ($r.B - $r.T + 2 * $m))
  $shots = [Drag]::Run($h, $x, $y, $dx, $dy, $Steps, $PerStep, $reg)
  $dir = Join-Path $Out "$Mode-$edge"; New-Item -ItemType Directory -Force $dir | Out-Null
  $meta = @()
  foreach ($f in $shots) {
    $name = "s{0:D2}-{1:D2}.png" -f $f.Step, $f.Sub
    $f.Img.Save((Join-Path $dir $name), [System.Drawing.Imaging.ImageFormat]::Png); $f.Img.Dispose()
    $meta += [pscustomobject]@{ file = $name; step = $f.Step; sub = $f.Sub; ms = $f.Ms; L = $f.Win.L - $reg.X; T = $f.Win.T - $reg.Y; R = $f.Win.R - $reg.X; B = $f.Win.B - $reg.Y }
  }
  $meta | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $dir "meta.json")
  Write-Output "$Mode-$edge hittest=$ht grab=($x,$y) frames=$($shots.Count) -> $dir"
}
[Drag]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0003) | Out-Null  # not topmost
if (-not $KeepOpen) { Stop-Process -Id $app.Id -Force }





