# Atlas launcher for Windows: finds or fetches the atlas-usage program, then runs it with
# the arguments unchanged.
#   usage: atlas-usage.ps1 [--bin-dir=<folder>] <atlas-usage arguments>
# Order: (a) atlas-usage on PATH, (b) a copy cached in <folder>\atlas-usage\<plugin version>\
# (<folder> = the plugin data folder the skill passes in, else this script's own folder; older
# version folders are removed when a new one is made), (c) the Atlas app's install folder,
# (d) download from the latest GitHub Release of dozeyy/atlas, checked against SHA256SUMS.txt.
# Exit code 3 = the launcher itself failed (one plain line on stderr).
# Test aid: ATLAS_USAGE_TEST_SOURCE = a local folder, or an http://127.0.0.1 / localhost
# address, that stands in for the release. ATLAS_USAGE_LAUNCHER_VERBOSE=1 names the copy used.

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Repo = 'dozeyy/atlas'
$Asset = 'atlas-usage-windows-x64.exe'   # also what Windows on ARM runs (emulated)
$ExeName = 'atlas-usage.exe'

function Fail([string]$msg) {
    [Console]::Error.WriteLine("atlas-usage: $msg")
    exit 3
}

# --- the launcher's own option (everything after it goes to atlas-usage untouched) ---
$rest = @($args)
$binDir = ''
if ($rest.Count -ge 1 -and ([string]$rest[0]).StartsWith('--bin-dir=')) {
    $binDir = ([string]$rest[0]).Substring(10)
    $rest = @($rest | Select-Object -Skip 1)
}
# An unexpanded ${CLAUDE_PLUGIN_DATA} (skill installed by hand, not as a plugin) is empty here.
if (-not $binDir -or $binDir.Contains('${')) { $binDir = $env:CLAUDE_PLUGIN_DATA }
if (-not $binDir -or $binDir.Contains('${')) { $binDir = $PSScriptRoot }

function Use-Program([string]$path, [string]$why) {
    if ($env:ATLAS_USAGE_LAUNCHER_VERBOSE) { [Console]::Error.WriteLine("atlas-usage launcher: $why $path") }
    try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }  # bars are UTF-8
    & $path @rest
    exit $LASTEXITCODE
}

# (a) on PATH
$onPath = Get-Command atlas-usage -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($onPath) { Use-Program $onPath.Source 'PATH:' }

# (b) cached copy, keyed by the plugin version: <folder>\atlas-usage\<version>\atlas-usage.exe.
# A plugin update changes the version, so the next run fetches a fresh copy by itself.
$version = 'unknown'
try {
    $pj = Join-Path $PSScriptRoot '..\..\..\.claude-plugin\plugin.json'
    if ((Test-Path -LiteralPath $pj -PathType Leaf) -and ((Get-Content -Raw -LiteralPath $pj) -match '"version"\s*:\s*"([^"]+)"')) {
        $version = $Matches[1] -replace '[^A-Za-z0-9._-]', '_'
    }
} catch { }
$cacheRoot = Join-Path $binDir 'atlas-usage'
$verDir = Join-Path $cacheRoot $version
$cached = Join-Path $verDir $ExeName
if (Test-Path -LiteralPath $cached -PathType Leaf) { Use-Program $cached 'cache:' }

# (c) the Atlas app's install folder (the installer's per-user default: %LOCALAPPDATA%\Atlas)
if ($env:LOCALAPPDATA) {
    $app = Join-Path (Join-Path $env:LOCALAPPDATA 'Atlas') $ExeName
    if (Test-Path -LiteralPath $app -PathType Leaf) { Use-Program $app 'Atlas app:' }
}

# (d) download, verify, cache
$Hint = 'Install the Atlas app from github.com/dozeyy/atlas/releases, or put atlas-usage on PATH.'
try { New-Item -ItemType Directory -Force -Path $cacheRoot -ErrorAction Stop | Out-Null }
catch { Fail "cannot write to $binDir. $Hint" }

# A private work folder per run: two runs at once never share a half-written file.
$work = Join-Path $cacheRoot ('.dl-' + [guid]::NewGuid().ToString('N'))
try { New-Item -ItemType Directory -Force -Path $work -ErrorAction Stop | Out-Null }
catch { Fail "cannot write to $binDir. $Hint" }

try {
    [Console]::Error.WriteLine('atlas-usage: first use, downloading the program (one time)...')
    $sums = Join-Path $work 'SHA256SUMS.txt'
    $file = Join-Path $work $Asset
    $got = $false
    $src = $env:ATLAS_USAGE_TEST_SOURCE

    if ($src -and (Test-Path -LiteralPath $src -PathType Container)) {
        try {
            Copy-Item -LiteralPath (Join-Path $src $Asset) -Destination $file -ErrorAction Stop
            Copy-Item -LiteralPath (Join-Path $src 'SHA256SUMS.txt') -Destination $sums -ErrorAction Stop
            $got = $true
        } catch { }
    } else {
        $base = "https://github.com/$Repo/releases/latest/download"
        $loopback = $false
        if ($src -match '^http://(127\.0\.0\.1|localhost)(:\d+)?(/|$)') { $base = $src.TrimEnd('/'); $loopback = $true }

        # The repo can be private: the signed-in GitHub CLI is the only thing that can reach it.
        if (-not $loopback -and (Get-Command gh -ErrorAction SilentlyContinue)) {
            $env:GH_PROMPT_DISABLED = '1'
            gh auth status *> $null
            if ($LASTEXITCODE -eq 0) {
                gh release download --repo $Repo --pattern $Asset --pattern 'SHA256SUMS.txt' --dir $work --clobber *> $null
                $got = ($LASTEXITCODE -eq 0) -and (Test-Path -LiteralPath $file) -and (Test-Path -LiteralPath $sums)
            }
        }
        if (-not $got) {
            try {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 -Uri "$base/SHA256SUMS.txt" -OutFile $sums -ErrorAction Stop
                Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 -Uri "$base/$Asset" -OutFile $file -ErrorAction Stop
                $got = $true
            } catch { }
        }
    }
    if (-not $got) {
        Fail "could not download the program from github.com/$Repo/releases. Check the internet connection (if the repo is private, sign in with 'gh auth login'), then try again. $Hint"
    }

    # SHA-256 must match the line for this file in SHA256SUMS.txt.
    $want = $null
    foreach ($line in [IO.File]::ReadAllLines($sums)) {
        if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $Asset) { $want = $Matches[1].ToLowerInvariant(); break }
    }
    $have = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $want -or $want -ne $have) {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        Fail "the downloaded program did not match its published checksum, so it was deleted and not run. Try again later, or install the Atlas app from github.com/$Repo/releases."
    }

    # Atomic rename into place. If another run got there first, its copy is just as good.
    try { New-Item -ItemType Directory -Force -Path $verDir -ErrorAction Stop | Out-Null } catch { }
    try { Move-Item -LiteralPath $file -Destination $cached -ErrorAction Stop }
    catch { if (-not (Test-Path -LiteralPath $cached -PathType Leaf)) { Fail "cannot save the program to $binDir. $Hint" } }

    # A new version folder now exists: drop the older ones (work folders start with a dot).
    Get-ChildItem -LiteralPath $cacheRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne $version -and -not $_.Name.StartsWith('.') } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Use-Program $cached 'downloaded:'
