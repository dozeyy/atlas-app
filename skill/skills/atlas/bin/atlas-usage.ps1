# Atlas launcher for Windows: finds or fetches the atlas-usage program, then runs it with
# the arguments unchanged.
#   usage: atlas-usage.ps1 <atlas-usage arguments>
# Order: (a) atlas-usage on PATH, (b) a copy cached in <data>\cache\<plugin version>\
# (<data> = $env:CLAUDE_PLUGIN_DATA when the shell has it, else this script's own folder, which
# changes with every plugin version and goes away with the plugin; older version folders are
# removed when a new one is made), (c) the Atlas app's install folder, (d) download tag
# v<plugin version> of dozeyy/atlas.
# The download is trusted ONLY if its SHA-256 equals the line "<version> <asset> <sha256>" in
# checksums.txt next to this script (pinned when the plugin was released). Nothing the release
# itself says is trusted. No pinned line = no download.
# A file sitting loose next to this script is never run: only PATH, the app and the verified cache.
# Exit code 3 = the launcher itself failed (one plain line on stderr).
# Test aid: ATLAS_USAGE_TEST_SOURCE = a local folder, or an http://127.0.0.1 / localhost
# address, that stands in for the release (the pinned hash still applies).
# ATLAS_USAGE_LAUNCHER_VERBOSE=1 names the copy used.

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Repo = 'dozeyy/atlas'
$Asset = 'atlas-usage-windows-x64.exe'   # also what Windows on ARM runs (emulated)
$ExeName = 'atlas-usage.exe'

function Fail([string]$msg) {
    [Console]::Error.WriteLine("atlas-usage: $msg")
    exit 3
}

$rest = @($args)
$binDir = $env:CLAUDE_PLUGIN_DATA
if (-not $binDir) { $binDir = $PSScriptRoot }

function Use-Program([string]$path, [string]$why) {
    if ($env:ATLAS_USAGE_LAUNCHER_VERBOSE) { [Console]::Error.WriteLine("atlas-usage launcher: $why $path") }
    try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }  # bars are UTF-8
    & $path @rest
    exit $LASTEXITCODE
}

# (a) on PATH
$onPath = Get-Command atlas-usage -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($onPath) { Use-Program $onPath.Source 'PATH:' }

# The plugin version (= the release tag without its v), read from the plugin's own manifest.
# Only digits first, then letters, digits, dot, dash, underscore: anything else is no version.
$version = ''
try {
    $pj = Join-Path $PSScriptRoot '..\..\..\.claude-plugin\plugin.json'
    if ((Test-Path -LiteralPath $pj -PathType Leaf) -and ((Get-Content -Raw -LiteralPath $pj) -match '"version"\s*:\s*"([^"]*)"')) {
        $candidate = [string]$Matches[1]
        if ($candidate -match '^[0-9][A-Za-z0-9._-]*$') { $version = $candidate }
    }
} catch { }
$cacheRoot = Join-Path $binDir 'cache'

# (b) cached copy, keyed by the plugin version: <data>\cache\<version>\atlas-usage.exe.
# A plugin update changes the version, so the next run fetches a fresh copy by itself.
if ($version) {
    $verDir = Join-Path $cacheRoot $version
    $cached = Join-Path $verDir $ExeName
    if (Test-Path -LiteralPath $cached -PathType Leaf) { Use-Program $cached 'cache:' }
}

# (c) the Atlas app's install folder (the installer's per-user default: %LOCALAPPDATA%\Atlas)
if ($env:LOCALAPPDATA) {
    $app = Join-Path (Join-Path $env:LOCALAPPDATA 'Atlas') $ExeName
    if (Test-Path -LiteralPath $app -PathType Leaf) { Use-Program $app 'Atlas app:' }
}

# (d) download, verify against the pinned hash, cache
$Hint = 'Install the Atlas app from github.com/dozeyy/atlas/releases, or put atlas-usage on PATH.'
if (-not $version) {
    Fail 'this copy of the skill has no version, so it cannot fetch the program. Put atlas-usage on PATH, or install the plugin: /plugin marketplace add dozeyy/atlas'
}

# The pinned hash: "<version> <asset> <sha256>", tolerant of a BOM and CRLF.
$want = $null
$pins = Join-Path $PSScriptRoot 'checksums.txt'
if (Test-Path -LiteralPath $pins -PathType Leaf) {
    foreach ($line in [IO.File]::ReadAllLines($pins)) {
        $line = $line.TrimStart([char]0xFEFF)
        $f = @($line -split '\s+' | Where-Object { $_ })
        if ($f.Count -ge 3 -and $f[0] -ceq $version -and $f[1] -ceq $Asset -and $f[2] -match '^[0-9A-Fa-f]{64}$') {
            $want = $f[2].ToLowerInvariant(); break
        }
    }
}
if (-not $want) { Fail "this plugin version ($version) has no pinned build yet; update the plugin, or put atlas-usage on PATH." }

try { New-Item -ItemType Directory -Force -Path $cacheRoot -ErrorAction Stop | Out-Null }
catch { Fail "cannot write to $binDir. $Hint" }

# Work folders of runs that were killed mid-download: remove the ones older than an hour.
Get-ChildItem -LiteralPath $cacheRoot -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name.StartsWith('.dl') -and $_.LastWriteTime -lt (Get-Date).AddHours(-1) } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

# A private work folder per run: two runs at once never share a half-written file.
$work = Join-Path $cacheRoot ('.dl-' + [guid]::NewGuid().ToString('N'))
try { New-Item -ItemType Directory -Force -Path $work -ErrorAction Stop | Out-Null }
catch { Fail "cannot write to $binDir. $Hint" }

try {
    [Console]::Error.WriteLine('atlas-usage: first use, downloading the program (one time)...')
    $file = Join-Path $work $Asset
    $got = $false
    $src = $env:ATLAS_USAGE_TEST_SOURCE

    if ($src -and (Test-Path -LiteralPath $src -PathType Container)) {
        try {
            Copy-Item -LiteralPath (Join-Path $src $Asset) -Destination $file -ErrorAction Stop
            $got = $true
        } catch { }
    } else {
        $base = "https://github.com/$Repo/releases/download/v$version"
        $loopback = $false
        if ($src -match '^http://(127\.0\.0\.1|localhost)(:\d+)?(/|$)') { $base = $src.TrimEnd('/'); $loopback = $true }

        # The repo can be private: the signed-in GitHub CLI is the only thing that can reach it.
        if (-not $loopback -and (Get-Command gh -ErrorAction SilentlyContinue)) {
            $env:GH_PROMPT_DISABLED = '1'
            gh auth status *> $null
            if ($LASTEXITCODE -eq 0) {
                gh release download "v$version" --repo $Repo --pattern $Asset --dir $work --clobber *> $null
                $got = ($LASTEXITCODE -eq 0) -and (Test-Path -LiteralPath $file)
            }
        }
        if (-not $got) {
            try {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                $maxRedir = 5
                if ($loopback) { $maxRedir = 0 }
                Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 -MaximumRedirection $maxRedir -Uri "$base/$Asset" -OutFile $file -ErrorAction Stop
                $got = $true
            } catch { }
        }
    }
    if (-not $got) {
        Fail "could not download the program (release v$version of github.com/$Repo). Check the internet connection (if the repo is private, sign in with 'gh auth login'), then try again. $Hint"
    }

    $have = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($want -ne $have) {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        Fail 'the downloaded program did not match the checksum pinned in this plugin, so it was deleted and not run. Try again later, or update the plugin.'
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
