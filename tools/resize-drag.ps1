# Real edge drags on a window with screen captures right after each move.
# Atlas: dev data only, pass a fixture --config-dir (tools/make-demo-fixture.py) and a scratch --data-dir.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\resize-drag.ps1 -Exe target\debug\atlas.exe `
#     -ConfigDir <fixture>\home\.claude -DataDir <scratch> -Out <scratch>\frames -Edges L,T,TL,BR,R,B -Mode shrink
#   python tools\analyze-resize.py <scratch>\frames <scratch>\sheets
#
# -Attach <process> drags an app that is already open instead (for comparison, e.g. Discord); its
# placement, z-order flag and visibility are put back afterwards and it is never closed.
#
# Per edge: SendInput press on the resize border (found by hit test), Steps moves of StepPx, PerStep
# captures (DwmFlush + screen copy) right after each move, then one settled capture 250 ms later.
# meta.json holds each frame's DWM window rect in capture coordinates. A launched Atlas is killed at
# the end, so the window-state plugin never saves the test bounds.
# A magenta backdrop sits behind the window over the whole capture area, so a judge can find the
# window's edge as drawn in each picture (windows behind it would otherwise pass for the window).
param(
  [string]$Exe,
  [string]$ConfigDir,
  [string]$DataDir,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Attach = "",
  [string]$Class = "Chrome_WidgetWin_1",
  [string[]]$Edges = @("L"),
  [string]$Mode = "shrink",
  [int]$Steps = 10,
  [int]$StepPx = 12,
  [int]$PerStep = 4,
  [int]$MoveMs = 0,   # > 0: continuous drag (one StepPx move every MoveMs), analyze with tools\analyze-continuous.py
  [int]$W0 = 1240,
  [int]$H0 = 820,
  [switch]$NoBackdrop,   # by default a magenta backdrop fills the capture area behind the window
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
  [StructLayout(LayoutKind.Sequential)] public struct PLACEMENT { public int len, flags, show; public int minX, minY, maxX, maxY; public RECT normal; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy, mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public int type; public MOUSEINPUT mi; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref PLACEMENT p);
  [DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr h, ref PLACEMENT p);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("dwmapi.dll")] static extern int DwmFlush();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  public delegate bool P(IntPtr h, IntPtr l);
  public static RECT Bounds(IntPtr h) { RECT r; DwmGetWindowAttribute(h, 9, out r, 16); return r; }
  public static bool Visible(IntPtr h) { return IsWindowVisible(h); }
  // The largest titled top-level window of these processes with this class.
  public static IntPtr Find(uint[] pids, string cls, bool visibleOnly) {
    IntPtr found = IntPtr.Zero; long best = -1;
    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) >= 0 && (!visibleOnly || IsWindowVisible(h)) && GetWindowTextLength(h) > 0) {
        var c = new System.Text.StringBuilder(64); GetClassName(h, c, 64);
        RECT r; GetWindowRect(h, out r); long a = (long)(r.R - r.L) * (r.B - r.T);
        if (c.ToString() == cls && a > best) { best = a; found = h; } }
      return true; }, IntPtr.Zero);
    return found;
  }
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
    // Step 0: the window before the press, then a burst of frames right after it (sub 90+): the
    // press alone must not change a pixel.
    var s0 = new Frame(); s0.Step = 0; s0.Sub = 99; s0.Ms = sw.ElapsedMilliseconds;
    s0.Win = Bounds(h); s0.Img = Grab(reg); list.Add(s0);
    Btn(0x0002);
    Burst(h, reg, sw, 0, list);
    Thread.Sleep(200);
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
    Burst(h, reg, sw, steps + 1, list);   // the frames right after the release (sub 90+)
    Thread.Sleep(700);   // "released": did the layout change once the drag ended?
    var rl = new Frame(); rl.Step = steps + 1; rl.Sub = 98; rl.Ms = sw.ElapsedMilliseconds;
    rl.Win = Bounds(h); rl.Img = Grab(reg); list.Add(rl);
    return list;
  }
  // Eight composed frames in a row, as subs 90..97 of `step`.
  static void Burst(IntPtr h, Rectangle reg, Stopwatch sw, int step, List<Frame> list) {
    for (int f = 0; f < 8; f++) {
      DwmFlush();
      var fr = new Frame(); fr.Step = step; fr.Sub = 90 + f; fr.Ms = sw.ElapsedMilliseconds;
      fr.Win = Bounds(h); fr.Img = Grab(reg); list.Add(fr);
    }
  }
  // Continuous drag, closer to a hand: a mover thread steps the cursor every moveMs while this
  // thread captures every composed frame (Step = moves done so far, Sub = frame index).
  static volatile int moved;
  public static List<Frame> RunContinuous(IntPtr h, int x, int y, int dx, int dy, int steps, int moveMs, Rectangle reg) {
    var list = new List<Frame>();
    var sw = Stopwatch.StartNew();
    SetCursorPos(x, y); Thread.Sleep(150);
    // The settled layout at the start size (sub 97): a judge compares each frame with this and
    // with the release frame (sub 98), since the layout can change between the two sizes.
    var st0 = new Frame(); st0.Step = 0; st0.Sub = 97; st0.Ms = sw.ElapsedMilliseconds;
    st0.Win = Bounds(h); st0.Img = Grab(reg); list.Add(st0);
    Btn(0x0002); Thread.Sleep(300);
    moved = 0;
    var mover = new Thread(() => { for (int s = 1; s <= steps; s++) { SetCursorPos(x + dx * s, y + dy * s); moved = s; Thread.Sleep(moveMs); } });
    mover.Start();
    int n = 0;
    while (mover.IsAlive) {
      DwmFlush();
      var fr = new Frame(); fr.Step = moved; fr.Sub = n++; fr.Ms = sw.ElapsedMilliseconds;
      fr.Win = Bounds(h); fr.Img = Grab(reg); list.Add(fr);
    }
    Thread.Sleep(250);
    var st = new Frame(); st.Step = steps; st.Sub = 99; st.Ms = sw.ElapsedMilliseconds;
    st.Win = Bounds(h); st.Img = Grab(reg); list.Add(st);
    Btn(0x0004);
    Thread.Sleep(700);
    var rl = new Frame(); rl.Step = steps + 1; rl.Sub = 98; rl.Ms = sw.ElapsedMilliseconds;
    rl.Win = Bounds(h); rl.Img = Grab(reg); list.Add(rl);
    return list;
  }
}
"@
[Drag]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
New-Item -ItemType Directory -Force $Out | Out-Null
if ($Attach) {
  $pids = [uint32[]]@(Get-Process -Name $Attach | ForEach-Object { $_.Id })
  $h = [Drag]::Find($pids, $Class, $false)
  if ($h -eq [IntPtr]::Zero) { throw "no $Class window for $Attach" }
  $place = New-Object Drag+PLACEMENT; $place.len = [Runtime.InteropServices.Marshal]::SizeOf($place)
  [Drag]::GetWindowPlacement($h, [ref]$place) | Out-Null
  $wasVisible = [Drag]::Visible($h)
  Write-Output "attached to $Attach window $h visible=$wasVisible show=$($place.show) normal=$($place.normal.L),$($place.normal.T),$($place.normal.R),$($place.normal.B)"
  if (-not $wasVisible) { [Drag]::ShowWindow($h, 5) | Out-Null }   # SW_SHOW: a renderer behind SW_SHOWNOACTIVATE kept its hidden size
  if ($place.show -eq 3) { [Drag]::ShowWindow($h, 9) | Out-Null }  # maximized: restore for the test
  Start-Sleep -Milliseconds 3000
} else {
  New-Item -ItemType Directory -Force $DataDir | Out-Null
  $sp = Join-Path $DataDir "settings.json"
  if (Test-Path $sp) { $j = Get-Content -Raw $sp | ConvertFrom-Json; $j.lastView = "dashboard"; [IO.File]::WriteAllText($sp, ($j | ConvertTo-Json)) }
  $env:ATLAS_NO_INTRO = "1"; $env:ATLAS_MULTI = "1"
  $app = Start-Process $Exe -ArgumentList @("--config-dir", "`"$ConfigDir`"", "--data-dir", "`"$DataDir`"") -RedirectStandardError (Join-Path $Out "atlas.log") -PassThru
  $h = [IntPtr]::Zero
  for ($i = 0; $i -lt 300 -and $h -eq [IntPtr]::Zero; $i++) {   # 45 s: a loaded machine starts slowly
    Start-Sleep -Milliseconds 150; $h = [Drag]::Find([uint32[]]@($app.Id), "Tauri Window", $true)
  }
  if ($h -eq [IntPtr]::Zero) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue; throw "no window" }
  Start-Sleep -Milliseconds 2500
}
$X0 = 260; $Y0 = 160
foreach ($edge in $Edges) {
  [Drag]::SetWindowPos($h, [IntPtr](-1), $X0, $Y0, $W0, $H0, 0x0040) | Out-Null   # topmost, show
  [Drag]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 1200
  $r = [Drag]::Bounds($h)
  $sign = if ($Mode -eq "shrink") { 1 } else { -1 }
  # Grab point: the first spot near the edge whose hit test is that edge (the border may sit
  # outside the visible frame, as on Atlas, or just inside it).
  $want = @{ L = 10; R = 11; T = 12; TL = 13; TR = 14; B = 15; BL = 16; BR = 17 }[$edge]
  $dx = 0; $dy = 0
  if ($edge.Contains("L")) { $dx = $sign * $StepPx }; if ($edge.Contains("R")) { $dx = -$sign * $StepPx }
  if ($edge.Contains("T")) { $dy = $sign * $StepPx }; if ($edge.Contains("B")) { $dy = -$sign * $StepPx }
  $ht = -1
  foreach ($o in @(-3, 2, -1, 0, 1, 3, 4)) {
    $x = [int](($r.L + $r.R) / 2); $y = [int](($r.T + $r.B) / 2)
    if ($edge.Contains("L")) { $x = $r.L + $o }; if ($edge.Contains("R")) { $x = $r.R - 1 - $o }
    if ($edge.Contains("T")) { $y = $r.T + [Math]::Max($o, 0) + 1 }; if ($edge.Contains("B")) { $y = $r.B - 1 - $o }
    $ht = [Drag]::HitTest($h, $x, $y); if ($ht -eq $want) { break }
  }
  if ($ht -ne $want) { Write-Output "$Mode-$edge skipped: no hit test $want near the edge (last $ht)"; continue }
  $m = 40 + $Steps * $StepPx
  $reg = New-Object System.Drawing.Rectangle(($r.L - $m), ($r.T - $m), ($r.R - $r.L + 2 * $m), ($r.B - $r.T + 2 * $m))
  $bd = $null
  if (-not $NoBackdrop) {
    Add-Type -AssemblyName System.Windows.Forms
    $bd = New-Object System.Windows.Forms.Form
    $bd.FormBorderStyle = "None"; $bd.ShowInTaskbar = $false; $bd.StartPosition = "Manual"; $bd.TopMost = $true
    $bd.BackColor = [System.Drawing.Color]::FromArgb(255, 0, 255)
    $bd.Show(); $bd.Bounds = $reg; $bd.Refresh(); [System.Windows.Forms.Application]::DoEvents()
    [Drag]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null   # back on top of the backdrop
    [Drag]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 400
    # Another window over the backdrop (another Atlas, a terminal) reads as part of this one in
    # the judge. Raise the backdrop and the window again until the area around the window is all
    # backdrop; the judge skips any frame where it still is not.
    for ($try = 1; $try -le 6; $try++) {
      $bmp = New-Object System.Drawing.Bitmap($reg.Width, $reg.Height)
      $gfx = [System.Drawing.Graphics]::FromImage($bmp); $gfx.CopyFromScreen($reg.X, $reg.Y, 0, 0, $reg.Size); $gfx.Dispose()
      $covered = 0
      for ($py = 0; $py -lt $reg.Height; $py += 12) {
        for ($px = 0; $px -lt $reg.Width; $px += 12) {
          $sx = $reg.X + $px; $sy = $reg.Y + $py
          if ($sx -ge $r.L - 40 -and $sx -lt $r.R + 40 -and $sy -ge $r.T - 40 -and $sy -lt $r.B + 40) { continue }
          $c = $bmp.GetPixel($px, $py)
          if (-not ($c.R - $c.G -gt 60 -and $c.B - $c.G -gt 60)) { $covered++ }
        }
      }
      $bmp.Dispose()
      if ($covered -le 2) { break }
      Write-Output "$Mode-$edge backdrop covered by another window ($covered samples), raising again ($try)"
      [Drag]::SetWindowPos($bd.Handle, [IntPtr](-1), 0, 0, 0, 0, 0x0013) | Out-Null
      [Drag]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null
      [Drag]::SetForegroundWindow($h) | Out-Null
      Start-Sleep -Milliseconds 300
    }
  }
  $shots = if ($MoveMs -gt 0) { [Drag]::RunContinuous($h, $x, $y, $dx, $dy, $Steps, $MoveMs, $reg) }
           else { [Drag]::Run($h, $x, $y, $dx, $dy, $Steps, $PerStep, $reg) }
  $dir = Join-Path $Out "$Mode-$edge"; New-Item -ItemType Directory -Force $dir | Out-Null
  $meta = @()
  foreach ($f in $shots) {
    $name = "s{0:D2}-{1:D2}.png" -f $f.Step, $f.Sub
    $f.Img.Save((Join-Path $dir $name), [System.Drawing.Imaging.ImageFormat]::Png); $f.Img.Dispose()
    $meta += [pscustomobject]@{ file = $name; step = $f.Step; sub = $f.Sub; ms = $f.Ms; L = $f.Win.L - $reg.X; T = $f.Win.T - $reg.Y; R = $f.Win.R - $reg.X; B = $f.Win.B - $reg.Y }
  }
  $meta | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $dir "meta.json")
  if ($bd) { $bd.Close(); $bd.Dispose() }
  Write-Output "$Mode-$edge hittest=$ht grab=($x,$y) frames=$($shots.Count) -> $dir"
}
[Drag]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0013) | Out-Null  # not topmost, no move/size/activate
if ($Attach) {
  [Drag]::SetWindowPlacement($h, [ref]$place) | Out-Null
  if (-not $wasVisible) { [Drag]::ShowWindow($h, 0) | Out-Null }
  $p2 = New-Object Drag+PLACEMENT; $p2.len = $place.len; [Drag]::GetWindowPlacement($h, [ref]$p2) | Out-Null
  Write-Output "restored: visible=$([Drag]::Visible($h)) show=$($p2.show) normal=$($p2.normal.L),$($p2.normal.T),$($p2.normal.R),$($p2.normal.B)"
} elseif (-not $KeepOpen) { Stop-Process -Id $app.Id -Force }
