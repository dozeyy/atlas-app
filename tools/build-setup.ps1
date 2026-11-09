# Builds Atlas-Setup-Windows-x64.exe from a clean checkout, the same chain the release workflow runs:
#   1. atlas-usage.exe (the command-line tool that ships next to atlas.exe)
#   2. the Atlas installer (NSIS) with that tool inside, signed for in-app updates when the key exists
#   3. atlas-setup with that installer embedded
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-setup.ps1
#
# The update signing key is read from $env:TAURI_SIGNING_PRIVATE_KEY (content or path) or, failing
# that, from C:\Users\Will\.tauri\atlas-updater.key. It is never printed. Without a key the installer
# is still built, only without the update artifacts. For update tests only: `-VersionOverride 0.1.1`
# builds a throwaway version and `-DevUpdate` allows a local http update server (release builds of
# the workflow use neither).
param(
  [string]$VersionOverride = "",
  [string]$OutDir = "",
  [switch]$DevUpdate
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($m) { Write-Host "==> $m" }
function Run($exe, $argList) {
  & $exe @argList
  if ($LASTEXITCODE -ne 0) { throw "$exe $($argList -join ' ') failed with exit code $LASTEXITCODE" }
}

if (-not (Test-Path (Join-Path $root "node_modules"))) { Step "npm ci"; Run "npm" @("ci") }

Step "atlas-usage (release)"
Run "cargo" @("build", "-p", "atlas-cli", "--release")

# Stale installers must not be picked up as the payload.
$nsisDir = Join-Path $root "target\release\bundle\nsis"
if (Test-Path $nsisDir) { Get-ChildItem $nsisDir -Filter "*" -File | Remove-Item -Force }

$cfg = @("--config", "crates/app/tauri.windows-bundle.conf.json")
$extra = @{ bundle = @{} }
if ($VersionOverride) { $extra.version = $VersionOverride }
if ($DevUpdate) {
  # Test builds only: lets a build talk to a local http server. Release builds never use this.
  $extra.plugins = @{ updater = @{ dangerousInsecureTransportProtocol = $true } }
}

$keyFile = "C:\Users\Will\.tauri\atlas-updater.key"
$signed = $false
if ($env:TAURI_SIGNING_PRIVATE_KEY) { $signed = $true }
elseif (Test-Path $keyFile) {
  $env:TAURI_SIGNING_PRIVATE_KEY = $keyFile
  if ($null -eq $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "" }
  $signed = $true
}
if (-not $signed) {
  Write-Host "No update signing key found: building without update artifacts."
  $extra.bundle.createUpdaterArtifacts = $false
}

$tmpCfg = $null
if ($VersionOverride -or $DevUpdate -or -not $signed) {
  $tmpDir = Join-Path $root "target\setup-build"
  New-Item -ItemType Directory -Force $tmpDir | Out-Null
  $tmpCfg = Join-Path $tmpDir "override.conf.json"
  ($extra | ConvertTo-Json -Depth 6) | Set-Content -Path $tmpCfg -Encoding utf8
  $cfg += @("--config", $tmpCfg)
}

$features = "payload,custom-protocol"
if ($DevUpdate) { Write-Host "(dev-update build: update endpoint can be overridden for local tests)" }

Step "Atlas installer (NSIS)"
$tauriArgs = @("tauri", "build", "--bundles", "nsis")
if ($DevUpdate) { $tauriArgs += @("--features", "dev-update") }
Run "npx" ($tauriArgs + $cfg)

$installer = Get-ChildItem $nsisDir -Filter "*.exe" -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw "tauri build produced no NSIS installer in $nsisDir" }
Step "installer: $($installer.Name)"

Step "Atlas Setup (payload embedded)"
$env:ATLAS_SETUP_PAYLOAD = $installer.FullName
Run "cargo" @("build", "-p", "atlas-setup", "--release", "--features", $features)

$built = Join-Path $root "target\release\atlas-setup.exe"
if (-not (Test-Path $built)) { throw "cargo build produced no $built" }
if (-not $OutDir) { $OutDir = Join-Path $root "target\release\bundle\setup" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$out = Join-Path $OutDir "Atlas-Setup-Windows-x64.exe"
Copy-Item $built $out -Force
$size = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host ""
Write-Host "Atlas Setup: $out ($size MB)"
Write-Host "Installer (also the update artifact): $($installer.FullName)"
$sig = "$($installer.FullName).sig"
if (Test-Path $sig) { Write-Host "Update signature: $sig" }
