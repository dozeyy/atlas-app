# Records the launch intro from the real running app: a screen capture (ffmpeg gdigrab,
# wall-clock timestamps) of the window region while Atlas cold-starts, plus the app's
# own log. Dev data only: --config-dir fixtures\claude-basic and a scratch --data-dir.
#
#   powershell -NoProfile -File tools\capture-intro.ps1 -Out <dir> [-Exe <atlas.exe>] [-Region "x,y,w,h"] [-Seconds 5] [-Fps 120] [-DataDir <dir>] [-EnvVars NAME=VALUE,...]
#
# Writes <Out>\capture.mkv, <Out>\frames.log (ffmpeg showinfo, wall-clock pts), <Out>\app.log
# and <Out>\launch.txt (launch wall-clock ms since the Unix epoch, then the process start time).
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Exe = "",
  [string]$Region = "0,0,2560,1440",
  [int]$Seconds = 5,
  [int]$Fps = 120,
  [string]$DataDir = "",
  [string[]]$EnvVars = @()
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $Exe) { $Exe = Join-Path $root "target\debug\atlas.exe" }
$Exe = (Resolve-Path $Exe).Path
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path
if (-not $DataDir) { $DataDir = Join-Path $Out "data" }
New-Item -ItemType Directory -Force $DataDir | Out-Null
Get-Process atlas -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | Stop-Process -Force
Start-Sleep -Milliseconds 400

$x, $y, $w, $h = $Region.Split(",")
# With -copyts the timeline is the Unix epoch, so the stop time is absolute too.
$endAt = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0 + 1.6 + $Seconds).ToString([cultureinfo]::InvariantCulture)
$ff = Start-Process ffmpeg -ArgumentList @(
  "-y", "-f", "gdigrab", "-framerate", "$Fps", "-use_wallclock_as_timestamps", "1",
  "-offset_x", "$x", "-offset_y", "$y", "-video_size", "${w}x${h}", "-draw_mouse", "0", "-i", "desktop",
  "-to", $endAt, "-copyts", "-fps_mode", "passthrough",
  "-vf", "showinfo", "-c:v", "ffv1", "-level", "3", (Join-Path $Out "capture.mkv")
) -RedirectStandardError (Join-Path $Out "frames.log") -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 1200

foreach ($e in $EnvVars) { $k, $v = $e.Split("=", 2); Set-Item "Env:$k" $v }
$launchMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$app = Start-Process $Exe -ArgumentList @("--config-dir", (Join-Path $root "fixtures\claude-basic"), "--data-dir", $DataDir) `
  -RedirectStandardError (Join-Path $Out "app.log") -PassThru
$startMs = ([DateTimeOffset]$app.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
"$launchMs`n$startMs" | Set-Content (Join-Path $Out "launch.txt")
$ff.WaitForExit()

Get-Process atlas -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | Stop-Process -Force
