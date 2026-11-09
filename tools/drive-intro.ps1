# Launches the real app for one intro scenario and prints its log. Dev data only:
# --config-dir fixtures\basic and a scratch --data-dir.
#
#   powershell -NoProfile -File tools\drive-intro.ps1 -Exe <atlas.exe> -DataDir <dir> [-KeyAtMs 1000] [-EnvVars A=1,B=2] [-Seconds 5] [-Second]
#
# -KeyAtMs  press Enter that many ms after launch (the splash has focus, so it skips the intro)
# -Second   launch a second instance while the first runs and report what happens to it
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [int]$KeyAtMs = 0,
  [string[]]$EnvVars = @(),
  [int]$Seconds = 5,
  [switch]$Second,
  [string]$Shot = ""
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Exe = (Resolve-Path $Exe).Path
New-Item -ItemType Directory -Force $DataDir | Out-Null
Get-Process atlas -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | Stop-Process -Force
Start-Sleep -Milliseconds 400
foreach ($e in $EnvVars) { $k, $v = $e.Split("=", 2); Set-Item "Env:$k" $v }
$log = Join-Path $DataDir "drive.log"
$cfg = Join-Path $root "fixtures\basic"
$t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$app = Start-Process $Exe -ArgumentList @("--config-dir", $cfg, "--data-dir", $DataDir) -RedirectStandardError $log -PassThru
if ($KeyAtMs -gt 0) {
  Add-Type -AssemblyName System.Windows.Forms
  Start-Sleep -Milliseconds $KeyAtMs
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  Write-Output "pressed Enter at $([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $t0) ms after launch"
}
if ($Second) {
  Start-Sleep -Milliseconds 4500
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p2 = Start-Process $Exe -ArgumentList @("--config-dir", $cfg, "--data-dir", $DataDir) -PassThru
  $p2.WaitForExit(5000) | Out-Null
  Write-Output "second instance exited=$($p2.HasExited) code=$(if ($p2.HasExited) { $p2.ExitCode }) after $($sw.ElapsedMilliseconds) ms; atlas processes now: $((Get-Process atlas -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | Measure-Object).Count)"
} else {
  Start-Sleep -Seconds $Seconds
}
if ($Shot) { ffmpeg -y -v error -f gdigrab -offset_x 565 -offset_y 210 -video_size 1046x754 -draw_mouse 0 -i desktop -frames:v 1 $Shot; Write-Output "screenshot: $Shot" }
Write-Output "--- log ---"
Get-Content $log
Get-Process atlas -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | Stop-Process -Force
