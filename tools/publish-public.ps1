# Publishes a staged Atlas release to the PUBLIC repository (dozeyy/atlas), from your own PC.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/publish-public.ps1 -Version 0.1.0 [-DryRun]
#
# The release workflow (release.yml) builds, signs and pins in CI and leaves the finished files as a
# prerelease in the PRIVATE repo dozeyy/atlas-app (the staging copy). This script moves that release
# to the public repo using the `gh` sign-in already on this computer. No token is stored anywhere.
#
# What it does, in order (each step stops the whole run on a failure):
#   1. Downloads the staged release's assets from dozeyy/atlas-app into a temp folder.
#   2. Reads the plugin and the notes as committed on origin/main of this repo (not your working tree).
#   3. Verifies, and refuses on any mismatch:
#        - every required asset is there, none is empty;
#        - the three atlas-usage-* files match the lines pinned in the plugin's checksums.txt;
#        - SHA256SUMS.txt matches every asset;
#        - latest.json: version, the four platform entries, each URL points at
#          github.com/dozeyy/atlas/releases/download/v<version>/<file>, each signature equals the
#          file's .sig, and each .sig was made by the key whose public half is in tauri.conf.json
#          (a bundle still signed by a CI throwaway key is refused).
#   4. Creates (or finds) the v<version> release in dozeyy/atlas as a DRAFT and uploads the assets.
#   5. Clones dozeyy/atlas main fresh, replaces skill/ and .claude-plugin/marketplace.json, adds the
#      CHANGELOG entry, commits and pushes.
#   6. Publishes the release LAST, so latest.json never points at assets that are not there yet.
# Safe to rerun: a finished step is detected and skipped; a published release is never touched again
# except to add a missing asset.
#
# -DryRun does steps 1 to 3, then only says what steps 4 to 6 would do (it still reads the public repo).
# Test hooks (not needed in normal use): -AssetsDir uses a folder instead of downloading, -SourceTree
# uses a folder (skill/, .claude-plugin/, crates/app/tauri.conf.json, docs/release-notes/) instead of
# origin/main.
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [switch]$DryRun,
    [string]$Source = 'dozeyy/atlas-app',
    [string]$Target = 'dozeyy/atlas',
    [string]$AssetsDir = '',
    [string]$SourceTree = ''
)
$ErrorActionPreference = 'Stop'

if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw "bad version '$Version' (expected x.y.z)" }
$Tag = "v$Version"
$Repo = Split-Path -Parent $PSScriptRoot
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Say([string]$m) { Write-Host $m }
function Fail([string]$m) { throw "publish-public: $m" }
function Need([string]$cmd) { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Fail "$cmd is not installed or not on PATH." } }
function Native([string]$what) { if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE)." } }
function Sha([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }
# Minisign key id (8 bytes, hex) from a Tauri public key or .sig value (both are base64 of a 2-line text).
function KeyId([string]$outer, [string]$what) {
    try {
        $text = $Utf8.GetString([Convert]::FromBase64String($outer.Trim()))
        $line = ($text -split "`r?`n")[1]
        $raw = [Convert]::FromBase64String($line.Trim())
        if ($raw.Length -lt 10) { throw 'too short' }
        return (($raw[2..9] | ForEach-Object { $_.ToString('x2') }) -join '')
    } catch { Fail "$what is not a readable minisign value ($($_.Exception.Message))." }
}

Need gh; Need git
if (-not $AssetsDir -or -not $SourceTree) { Need tar }

$Work = Join-Path ([IO.Path]::GetTempPath()) ("atlas-publish-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Work | Out-Null
try {
    # ---- 1. assets
    $dist = Join-Path $Work 'dist'
    if ($AssetsDir) {
        $dist = (Resolve-Path -LiteralPath $AssetsDir).Path
        Say "Using assets in $dist (test hook)."
    } else {
        Say "Downloading $Tag from $Source ..."
        New-Item -ItemType Directory -Path $dist | Out-Null
        & gh release download $Tag --repo $Source --dir $dist
        Native 'gh release download'
    }

    # ---- 2. plugin and notes, as committed on origin/main
    $src = Join-Path $Work 'src'
    if ($SourceTree) {
        $src = (Resolve-Path -LiteralPath $SourceTree).Path
        Say "Using the source tree $src (test hook)."
    } else {
        New-Item -ItemType Directory -Path $src | Out-Null
        Push-Location $Repo
        try {
            & git fetch --no-tags origin main -q
            Native 'git fetch origin main'
            $tar = Join-Path $Work 'src.tar'
            & git archive -o $tar origin/main skill .claude-plugin/marketplace.json crates/app/tauri.conf.json docs/release-notes
            Native 'git archive origin/main'
        } finally { Pop-Location }
        & tar -xf $tar -C $src
        Native 'tar'
    }
    $pluginJson = Join-Path $src 'skill/.claude-plugin/plugin.json'
    $pins = Join-Path $src 'skill/skills/atlas/bin/checksums.txt'
    $market = Join-Path $src '.claude-plugin/marketplace.json'
    $tauriConf = Join-Path $src 'crates/app/tauri.conf.json'
    foreach ($f in @($pluginJson, $pins, $market, $tauriConf)) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { Fail "missing in the source tree: $f" } }
    $pv = (Get-Content -LiteralPath $pluginJson -Raw | ConvertFrom-Json).version
    if ($pv -cne $Version) { Fail "origin/main has plugin version $pv, not $Version. Merge the release commit first." }

    # ---- 3. verify
    Say 'Verifying ...'
    $names = @('Atlas-Setup-Windows-x64.exe', "Atlas_${Version}_x64-setup.exe", "Atlas_${Version}_x64-setup.exe.sig",
        'Atlas-macOS.dmg', 'Atlas.app.tar.gz', 'Atlas.app.tar.gz.sig',
        'atlas-usage-windows-x64.exe', 'atlas-usage-macos-universal', 'atlas-usage-linux-x64',
        'SHA256SUMS.txt', 'latest.json')
    foreach ($n in $names) {
        $p = Join-Path $dist $n
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { Fail "the release is missing $n." }
        if ((Get-Item -LiteralPath $p).Length -eq 0) { Fail "$n is empty." }
    }
    $extra = @(Get-ChildItem -LiteralPath $dist -File | Where-Object { $names -notcontains $_.Name } | ForEach-Object { $_.Name })
    if ($extra.Count -gt 0) { Fail "unexpected files in the release: $($extra -join ', ')." }

    # the plugin's pins are the root of trust for the three atlas-usage files
    $pinned = @{}
    foreach ($line in [IO.File]::ReadAllLines($pins)) {
        if ($line -match '^\s*#' -or $line.Trim() -eq '') { continue }
        $f = $line.Trim() -split '\s+'
        if ($f.Count -ge 3 -and $f[0] -ceq $Version) { $pinned[$f[1]] = $f[2].ToLowerInvariant() }
    }
    foreach ($a in @('atlas-usage-windows-x64.exe', 'atlas-usage-macos-universal', 'atlas-usage-linux-x64')) {
        if (-not $pinned.ContainsKey($a)) { Fail "checksums.txt on origin/main has no pinned line for $Version $a (the pin step of the release did not finish; pin by hand, push, then rerun)." }
        if ((Sha (Join-Path $dist $a)) -cne $pinned[$a]) { Fail "$a does not match the hash pinned in checksums.txt. Nothing was published." }
    }

    # SHA256SUMS.txt covers every other asset
    $sums = @{}
    foreach ($line in [IO.File]::ReadAllLines((Join-Path $dist 'SHA256SUMS.txt'))) {
        if ($line.Trim() -eq '') { continue }
        if ($line -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+)$') { Fail "SHA256SUMS.txt has a line that is not '<sha256>  <file>'." }
        $sums[$Matches[2].Trim()] = $Matches[1].ToLowerInvariant()
    }
    foreach ($n in $names) {
        if ($n -eq 'SHA256SUMS.txt') { continue }
        if (-not $sums.ContainsKey($n)) { Fail "SHA256SUMS.txt does not list $n." }
        if ((Sha (Join-Path $dist $n)) -cne $sums[$n]) { Fail "$n does not match SHA256SUMS.txt." }
    }

    # latest.json: what installed apps read
    $lj = Get-Content -LiteralPath (Join-Path $dist 'latest.json') -Raw | ConvertFrom-Json
    if ($lj.version -cne $Version) { Fail "latest.json says version $($lj.version), not $Version." }
    $conf = Get-Content -LiteralPath $tauriConf -Raw | ConvertFrom-Json
    $pubId = KeyId $conf.plugins.updater.pubkey 'the public key in tauri.conf.json'
    $base = "https://github.com/$Target/releases/download/$Tag"
    $bundles = @{
        'windows-x86_64'   = "Atlas_${Version}_x64-setup.exe"
        'darwin-universal' = 'Atlas.app.tar.gz'
        'darwin-aarch64'   = 'Atlas.app.tar.gz'
        'darwin-x86_64'    = 'Atlas.app.tar.gz'
    }
    foreach ($k in $bundles.Keys) {
        $e = $lj.platforms.$k
        if (-not $e) { Fail "latest.json has no entry for $k." }
        $file = $bundles[$k]
        if ($e.url -cne "$base/$file") { Fail "latest.json $k url is '$($e.url)', expected '$base/$file'." }
        $sigText = (Get-Content -LiteralPath (Join-Path $dist "$file.sig") -Raw).Trim()
        if ($e.signature.Trim() -cne $sigText) { Fail "latest.json $k signature differs from $file.sig." }
        if ((KeyId $sigText "$file.sig") -cne $pubId) { Fail "$file.sig was not made by the update key in tauri.conf.json (a throwaway CI key?). Nothing was published." }
    }
    Say 'All checks passed.'

    # ---- notes
    $notesFile = Join-Path $Work 'notes.md'
    $srcNotes = Join-Path $src "docs/release-notes/$Version.md"
    if ((Test-Path -LiteralPath $srcNotes) -and (Get-Item -LiteralPath $srcNotes).Length -gt 0) {
        $notes = [IO.File]::ReadAllText($srcNotes).Trim()
    } else { $notes = "Atlas $Version" }
    [IO.File]::WriteAllText($notesFile, $notes + "`n", $Utf8)

    # ---- state of the public release
    $rel = $null
    $json = & gh api "repos/$Target/releases?per_page=100" --paginate
    Native 'gh api releases'
    foreach ($r in (($json -join "`n") | ConvertFrom-Json)) { if ($r.tag_name -ceq $Tag) { $rel = $r; break } }
    $published = $rel -and (-not $rel.draft)
    $have = @(); if ($rel) { $have = @($rel.assets | ForEach-Object { $_.name }) }
    $missing = @($names | Where-Object { $have -notcontains $_ })
    Say ("Public release {0}: {1}" -f $Tag, $(if (-not $rel) { 'does not exist yet' } elseif ($published) { 'already published' } else { 'draft' }))

    if ($DryRun) {
        Say 'DRY RUN. Nothing below was done:'
        if (-not $rel) { Say "  - create draft $Tag in $Target and upload $($names.Count) assets" }
        elseif ($missing.Count -gt 0) { Say "  - upload missing assets to $Tag : $($missing -join ', ')" }
        else { Say '  - assets already uploaded' }
        Say "  - clone $Target main, replace skill/ and .claude-plugin/marketplace.json, add the CHANGELOG entry, commit and push"
        if ($published) { Say '  - release is already published: leave it' } else { Say "  - publish $Tag last" }
        Say "Notes that would be used:`n$notes"
        return
    }

    # ---- 4. draft release and assets
    if (-not $rel) {
        Say "Creating draft $Tag in $Target ..."
        & gh release create $Tag --repo $Target --target main --draft --title "Atlas $Version" --notes-file $notesFile
        Native 'gh release create'
        $missing = $names
    }
    if ($missing.Count -gt 0) {
        Say "Uploading $($missing.Count) asset(s) ..."
        $paths = @($missing | ForEach-Object { Join-Path $dist $_ })
        & gh release upload $Tag @paths --repo $Target
        Native 'gh release upload'
    }

    # ---- 5. plugin, marketplace and changelog into a clean clone of main
    if (-not $published) {
        $clone = Join-Path $Work 'public'
        Say "Cloning $Target main ..."
        & git clone --depth 1 --branch main -q "https://github.com/$Target.git" $clone
        Native 'git clone'
        Push-Location $clone
        try {
            if (Test-Path -LiteralPath 'skill') { Remove-Item -LiteralPath 'skill' -Recurse -Force }
            Copy-Item -LiteralPath (Join-Path $src 'skill') -Destination 'skill' -Recurse
            New-Item -ItemType Directory -Path '.claude-plugin' -Force | Out-Null
            Copy-Item -LiteralPath $market -Destination '.claude-plugin/marketplace.json' -Force
            if (Test-Path -LiteralPath 'CHANGELOG.md') {
                $cl = [IO.File]::ReadAllText((Join-Path $clone 'CHANGELOG.md'))
                if ($cl -notmatch "(?m)^## $([regex]::Escape($Version)) " -and $cl.Contains('<!-- releases -->')) {
                    $date = [DateTime]::UtcNow.ToString('yyyy-MM-dd')
                    $entry = "<!-- releases -->`n`n## $Version - $date`n`n$notes`n"
                    $cl = $cl.Replace('<!-- releases -->', $entry)
                    [IO.File]::WriteAllText((Join-Path $clone 'CHANGELOG.md'), $cl, $Utf8)
                }
            }
            & git config user.name 'dozeyy'
            & git config user.email 'dozeyy@users.noreply.github.com'
            & git add -A
            Native 'git add'
            & git diff --cached --quiet
            if ($LASTEXITCODE -eq 0) {
                Say 'The public repo already has this plugin and changelog.'
            } else {
                & git commit -q -m "Atlas ${Version}: plugin and changelog"
                Native 'git commit'
                & git push -q origin HEAD:main
                Native 'git push'
                Say 'Pushed the plugin and changelog to main.'
            }
        } finally { Pop-Location }

        # ---- 6. publish last
        Say "Publishing $Tag ..."
        & gh release edit $Tag --repo $Target --draft=false --latest
        Native 'gh release edit'
    } elseif ($missing.Count -gt 0) {
        Say 'The release was already published; the missing assets were added.'
    } else {
        Say 'The release was already published and complete: nothing to do.'
    }

    Say ''
    Say "Done: https://github.com/$Target/releases/tag/$Tag"
    Say "  assets: $($names.Count)   plugin version: $Version   checks: pins, SHA256SUMS, latest.json, update key"
} finally {
    if (Test-Path -LiteralPath $Work) { Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue }
}
