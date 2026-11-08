# Records a clean run of the intro: every window is minimized first (nothing is closed), the
# window-state file is set aside so Atlas starts centered (and put back afterwards), the run is
# captured, and the windows are restored.
#
#   powershell -NoProfile -File tools\record-intro.ps1 -Out <dir> -Exe <atlas.exe> -DataDir <dir> [-Region "x,y,w,h"]
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [string]$Region = "520,180,1520,1080",
  [int]$Seconds = 4
)
$ErrorActionPreference = "Stop"
$Exe = (Resolve-Path $Exe).Path
$state = Join-Path $env:APPDATA "me.willhenry.atlas\.window-state.json"
$backup = "$state.record-backup"
$shell = New-Object -ComObject Shell.Application
try {
  if (Test-Path $state) { Move-Item $state $backup -Force }
  $shell.MinimizeAll()
  Start-Sleep -Milliseconds 1500
  & (Join-Path $PSScriptRoot "capture-intro.ps1") -Out $Out -Exe $Exe -Region $Region -Seconds $Seconds -DataDir $DataDir
}
finally {
  $shell.UndoMinimizeALL()
  Get-Process atlas -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | Stop-Process -Force
  Start-Sleep -Milliseconds 400
  if (Test-Path $backup) { Move-Item $backup $state -Force }
  elseif (Test-Path $state) { Remove-Item $state -Force }
}
