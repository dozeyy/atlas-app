# Publishes a staged Atlas release to the PUBLIC repository (dozeyy/atlas), from your own PC.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/publish-public.ps1 -Version 0.1.0 [-DryRun]
#
# The release workflow (release.yml) builds, signs and pins in CI and leaves the finished files as a
# prerelease in the PRIVATE repo dozeyy/atlas-app (the staging copy). This script moves that release
# to the public repo using the `gh` sign-in already on this computer. No token is stored anywhere.
# Needs: gh (signed in), git, tar, node (for the signature check; tools/verify-minisign.mjs).
#
# Trust: the staging release is only a transport, anything that can write to it could swap a file. So
# nothing in it is believed until it is checked against something it cannot forge:
#   - the update public key in crates/app/tauri.conf.json on origin/main (read from git, not the
#     staging copy), used for REAL Ed25519 signature checks of SHA256SUMS.txt (signed by CI with the
#     update key), and of each update bundle against its .sig;
#   - the three atlas-usage-* hashes pinned in skill/skills/atlas/bin/checksums.txt on origin/main.
#
# What it does, in order (each step stops the whole run on a failure):
#   1. Downloads the staged release's assets from dozeyy/atlas-app into a temp folder.
#   2. Reads the plugin from origin/main of this repo (not your working tree).
#   3. Verifies, and refuses on any mismatch: all 12 files present and non-empty; the signature on
#      SHA256SUMS.txt; every file against SHA256SUMS.txt (so the installers, dmg and latest.json are
#      covered); the atlas-usage-* files against the plugin pins; each update bundle's .sig against
#      the bundle; latest.json (version, four platforms, URLs on dozeyy/atlas, signatures equal the
#      .sig files). The release notes come from latest.json (they are inside the signed list).
#   4. Reads the public release v<version>, compares each asset there by state, size and sha256, and
#      stops if a PUBLISHED release holds anything stale or unexpected (see docs/releasing.md, Roll
#      back). A draft's stale or extra assets are deleted and replaced.
#   5. Creates the release as a DRAFT (or reuses the draft) and uploads what is missing.
#   6. Prepares the plugin, marketplace and CHANGELOG entry in a fresh clone of dozeyy/atlas main
#      (committed locally, not pushed yet), so a problem there stops the run before anything is public.
#   7. Publishes the release.
#   8. Pushes the plugin commit. Done after publishing so the plugin never points at assets that are not
#      there; done on every run (also when the release was already published) so a failed push is
#      finished by a rerun.
# Safe to rerun.
#
# -DryRun does steps 1 to 4 for real (it downloads, verifies and reads the public repo) and only says
# what steps 5 to 8 would do. It writes nothing to either repo.
# Test hooks (not needed in normal use): -AssetsDir uses a folder instead of downloading, -SourceTree
# uses a folder (skill/, .claude-plugin/, crates/app/tauri.conf.json) instead of origin/main,
# -CloneUrl clones the plugin repo from somewhere else.
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [switch]$DryRun,
    [string]$Source = 'dozeyy/atlas-app',
    [string]$Target = 'dozeyy/atlas',
    [string]$AssetsDir = '',
    [string]$SourceTree = '',
    [string]$CloneUrl = ''
)
$ErrorActionPreference = 'Stop'

if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw "bad version '$Version' (expected x.y.z)" }
$Tag = "v$Version"
$Repo = Split-Path -Parent $PSScriptRoot
$Verifier = Join-Path $PSScriptRoot 'verify-minisign.mjs'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
if (-not $CloneUrl) { $CloneUrl = "https://github.com/$Target.git" }

function Say([string]$m) { Write-Host $m }
function Fail([string]$m) { throw "publish-public: $m" }
function Need([string]$cmd) { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Fail "$cmd is not installed or not on PATH." } }
function Sha([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }

# Runs a native command without letting its stderr become a PowerShell error (Windows PowerShell 5.1
# turns any stderr line into a terminating error under $ErrorActionPreference = 'Stop'). Returns the
# stdout lines; $script:Code is the exit code and $script:Err the stderr text.
$script:Code = 0
$script:Err = ''
function Exec([string]$exe, [string[]]$cmdArgs) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $all = @(& $exe @cmdArgs 2>&1) } finally { $ErrorActionPreference = $old }
    $script:Code = $LASTEXITCODE
    $script:Err = (($all | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" }) -join "`n").Trim()
    return @($all | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" })
}
# Exec, and stop with the command's own message when it fails.
function Run([string]$what, [string]$exe, [string[]]$cmdArgs) {
    $out = Exec $exe $cmdArgs
    if ($script:Code -ne 0) { Fail "$what failed (exit code $($script:Code)). $($script:Err)" }
    return $out
}
# Real Ed25519 (minisign) check of one file; stops the run when it does not verify.
function VerifySig([string]$pubkey, [string]$file, [string]$sig, [string]$what) {
    $null = Exec 'node' @($Verifier, $pubkey, $file, $sig)
    if ($script:Code -ne 0) { Fail "$what is not signed by the update key: $($script:Err) Nothing was published." }
}

Need gh; Need git; Need node
if (-not (Test-Path -LiteralPath $Verifier -PathType Leaf)) { Fail "tools/verify-minisign.mjs is missing." }
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
        $null = Run 'gh release download' 'gh' @('release', 'download', $Tag, '--repo', $Source, '--dir', $dist)
    }

    # ---- 2. plugin and update key, as committed on origin/main
    $src = Join-Path $Work 'src'
    if ($SourceTree) {
        $src = (Resolve-Path -LiteralPath $SourceTree).Path
        Say "Using the source tree $src (test hook)."
    } else {
        New-Item -ItemType Directory -Path $src | Out-Null
        Push-Location $Repo
        try {
            $null = Run 'git fetch origin main' 'git' @('fetch', '--no-tags', 'origin', 'main', '-q')
            $tar = Join-Path $Work 'src.tar'
            $null = Run 'git archive origin/main' 'git' @('archive', '-o', $tar, 'origin/main', 'skill', '.claude-plugin/marketplace.json', 'crates/app/tauri.conf.json')
        } finally { Pop-Location }
        $null = Run 'tar' 'tar' @('-xf', $tar, '-C', $src)
    }
    $pluginJson = Join-Path $src 'skill/.claude-plugin/plugin.json'
    $pins = Join-Path $src 'skill/skills/atlas/bin/checksums.txt'
    $market = Join-Path $src '.claude-plugin/marketplace.json'
    $tauriConf = Join-Path $src 'crates/app/tauri.conf.json'
    foreach ($f in @($pluginJson, $pins, $market, $tauriConf)) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { Fail "missing in the source tree: $f" } }
    $pv = (Get-Content -LiteralPath $pluginJson -Raw | ConvertFrom-Json).version
    if ($pv -cne $Version) { Fail "origin/main has plugin version $pv, not $Version. Merge the release commit first." }
    $conf = Get-Content -LiteralPath $tauriConf -Raw | ConvertFrom-Json
    $pubkey = $conf.plugins.updater.pubkey
    if (-not $pubkey) { Fail 'tauri.conf.json has no updater public key.' }

    # ---- 3. verify
    Say 'Verifying ...'
    $names = @('Atlas-Setup-Windows-x64.exe', "Atlas_${Version}_x64-setup.exe", "Atlas_${Version}_x64-setup.exe.sig",
        'Atlas-macOS.dmg', 'Atlas.app.tar.gz', 'Atlas.app.tar.gz.sig',
        'atlas-usage-windows-x64.exe', 'atlas-usage-macos-universal', 'atlas-usage-linux-x64',
        'SHA256SUMS.txt', 'SHA256SUMS.txt.sig', 'latest.json')
    foreach ($n in $names) {
        $p = Join-Path $dist $n
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { Fail "the release is missing $n." }
        if ((Get-Item -LiteralPath $p).Length -eq 0) { Fail "$n is empty." }
    }
    $extra = @(Get-ChildItem -LiteralPath $dist -File | Where-Object { $names -notcontains $_.Name } | ForEach-Object { $_.Name })
    if ($extra.Count -gt 0) { Fail "unexpected files in the release: $($extra -join ', ')." }

    # the signed list: the update key signed SHA256SUMS.txt, so everything it lists is what CI built
    VerifySig $pubkey (Join-Path $dist 'SHA256SUMS.txt') (Join-Path $dist 'SHA256SUMS.txt.sig') 'SHA256SUMS.txt'
    $sums = @{}
    foreach ($line in [IO.File]::ReadAllLines((Join-Path $dist 'SHA256SUMS.txt'))) {
        if ($line.Trim() -eq '') { continue }
        if ($line -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+)$') { Fail "SHA256SUMS.txt has a line that is not '<sha256>  <file>'." }
        $sums[$Matches[2].Trim()] = $Matches[1].ToLowerInvariant()
    }
    foreach ($n in $names) {
        if ($n -eq 'SHA256SUMS.txt' -or $n -eq 'SHA256SUMS.txt.sig') { continue }
        if (-not $sums.ContainsKey($n)) { Fail "SHA256SUMS.txt does not list $n." }
        if ((Sha (Join-Path $dist $n)) -cne $sums[$n]) { Fail "$n does not match the signed SHA256SUMS.txt. Nothing was published." }
    }

    # the plugin's pins (on main, a second anchor) for the three atlas-usage files
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

    # latest.json: what installed apps read
    $lj = Get-Content -LiteralPath (Join-Path $dist 'latest.json') -Raw | ConvertFrom-Json
    if ($lj.version -cne $Version) { Fail "latest.json says version $($lj.version), not $Version." }
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
    }
    foreach ($file in @("Atlas_${Version}_x64-setup.exe", 'Atlas.app.tar.gz')) {
        VerifySig $pubkey (Join-Path $dist $file) (Join-Path $dist "$file.sig") $file
    }
    Say 'All checks passed.'

    # notes: the ones inside latest.json (covered by the signed list), so the release page, the app's
    # update tooltip and the changelog say the same thing
    $notes = ''
    if ($lj.notes) { $notes = ([string]$lj.notes).Trim() }
    if ($notes -eq '') { $notes = "Atlas $Version" }
    $notesFile = Join-Path $Work 'notes.md'
    [IO.File]::WriteAllText($notesFile, $notes + "`n", $Utf8)

    # ---- 4. state of the public release, asset by asset
    $rel = $null
    # one compact JSON object per line (--jq '.[] | tojson'), one line per release across all pages, so
    # nothing depends on how a page boundary splits an array. The filter has no quotes in it on purpose:
    # Windows PowerShell 5.1 drops embedded double quotes from native command arguments.
    $lines = Run 'gh api releases' 'gh' @('api', "repos/$Target/releases?per_page=100", '--paginate', '--jq', '.[] | tojson')
    foreach ($l in $lines) {
        if ($l.Trim() -eq '') { continue }
        $r = $l | ConvertFrom-Json
        if ($r.tag_name -ceq $Tag) { $rel = $r; break }
    }
    $published = [bool]($rel -and (-not $rel.draft))
    $missing = @(); $stale = @(); $unexpected = @()
    $ids = @{}
    if (-not $rel) {
        $missing = @($names)
    } else {
        $byName = @{}
        foreach ($a in @($rel.assets)) { $byName[$a.name] = $a; $ids[$a.name] = $a.id }
        foreach ($n in $names) {
            if (-not $byName.ContainsKey($n)) { $missing += $n; continue }
            $a = $byName[$n]
            $path = Join-Path $dist $n
            $ok = ($a.state -ceq 'uploaded') -and ([int64]$a.size -eq (Get-Item -LiteralPath $path).Length)
            if ($ok) {
                if ($a.digest) {
                    $ok = ([string]$a.digest -ceq ('sha256:' + (Sha $path)))
                } elseif ($published) {
                    # no digest from the API: fetch the published file and compare it
                    $tmp = Join-Path $Work ('chk-' + [Guid]::NewGuid().ToString('N'))
                    New-Item -ItemType Directory -Path $tmp | Out-Null
                    $null = Exec 'gh' @('release', 'download', $Tag, '--repo', $Target, '--pattern', $n, '--dir', $tmp)
                    $got = Join-Path $tmp $n
                    $ok = ($script:Code -eq 0) -and (Test-Path -LiteralPath $got) -and ((Sha $got) -ceq (Sha $path))
                } else {
                    $ok = $false   # a draft asset that cannot be checked is simply replaced
                }
            }
            if (-not $ok) { $stale += $n }
        }
        $unexpected = @($byName.Keys | Where-Object { $names -notcontains $_ })
    }
    Say ("Public release {0}: {1}; assets missing: {2}, stale: {3}, unexpected: {4}" -f $Tag,
        $(if (-not $rel) { 'does not exist yet' } elseif ($published) { 'already published' } else { 'draft' }),
        $missing.Count, $stale.Count, $unexpected.Count)
    if ($published -and ($stale.Count -gt 0 -or $unexpected.Count -gt 0)) {
        Fail ("the PUBLISHED release $Tag in $Target holds files that are not the verified ones (stale: [$($stale -join ', ')], unexpected: [$($unexpected -join ', ')]). " +
            "It is not changed from here. Roll it back first (docs/releasing.md, Roll back), then rerun.")
    }

    if ($DryRun) {
        Say 'DRY RUN. Verification above was real (download, signatures, hashes, public repo read). Nothing below was done:'
        if (-not $rel) { Say "  - create draft $Tag in $Target and upload $($names.Count) assets" }
        else {
            if ($stale.Count -gt 0) { Say "  - delete and re-upload stale assets: $($stale -join ', ')" }
            if ($unexpected.Count -gt 0) { Say "  - delete unexpected assets from the draft: $($unexpected -join ', ')" }
            if ($missing.Count -gt 0) { Say "  - upload missing assets: $($missing -join ', ')" }
            if ($stale.Count + $unexpected.Count + $missing.Count -eq 0) { Say '  - assets already correct' }
        }
        Say "  - clone $Target main, replace skill/ and .claude-plugin/marketplace.json, add the CHANGELOG entry, commit"
        if ($published) { Say '  - release is already published: leave it' } else { Say "  - publish $Tag" }
        Say '  - push the plugin commit to main (after publishing)'
        Say "Notes that would be used:`n$notes"
        return
    }

    # ---- 5. draft release and assets
    if (-not $rel) {
        Say "Creating draft $Tag in $Target ..."
        $null = Run 'gh release create' 'gh' @('release', 'create', $Tag, '--repo', $Target, '--target', 'main', '--draft', '--title', "Atlas $Version", '--notes-file', $notesFile)
    } elseif (-not $published) {
        $null = Run 'gh release edit' 'gh' @('release', 'edit', $Tag, '--repo', $Target, '--title', "Atlas $Version", '--notes-file', $notesFile)
    }
    foreach ($n in @($stale) + @($unexpected)) {
        if (-not $ids.ContainsKey($n)) { continue }
        Say "Deleting $n from the draft ..."
        $null = Run "delete asset $n" 'gh' @('api', '-X', 'DELETE', "repos/$Target/releases/assets/$($ids[$n])")
    }
    $upload = @($missing) + @($stale)
    if ($upload.Count -gt 0) {
        Say "Uploading $($upload.Count) asset(s) ..."
        $paths = @($upload | ForEach-Object { Join-Path $dist $_ })
        $null = Run 'gh release upload' 'gh' @((@('release', 'upload', $Tag) + $paths + @('--repo', $Target)))
    }

    # ---- 6. plugin, marketplace and changelog into a clean clone of main (committed, not pushed)
    $clone = Join-Path $Work 'public'
    Say "Cloning $Target main ..."
    $null = Run 'git clone' 'git' @('clone', '--depth', '1', '--branch', 'main', '-q', $CloneUrl, $clone)
    $needPush = $false
    Push-Location $clone
    try {
        if (Test-Path -LiteralPath 'skill') { Remove-Item -LiteralPath 'skill' -Recurse -Force }
        Copy-Item -LiteralPath (Join-Path $src 'skill') -Destination 'skill' -Recurse
        New-Item -ItemType Directory -Path '.claude-plugin' -Force | Out-Null
        Copy-Item -LiteralPath $market -Destination '.claude-plugin/marketplace.json' -Force
        $clPath = Join-Path $clone 'CHANGELOG.md'
        if (-not (Test-Path -LiteralPath $clPath)) { Fail "CHANGELOG.md is missing in $Target main." }
        $cl = [IO.File]::ReadAllText($clPath)
        if ($cl -notmatch "(?m)^## $([regex]::Escape($Version)) ") {
            $marker = '<!-- releases -->'
            $at = $cl.IndexOf($marker, [StringComparison]::Ordinal)
            if ($at -lt 0) { Fail "CHANGELOG.md in $Target has no '$marker' line, so the entry for $Version cannot be added. Nothing was published." }
            $date = [DateTime]::UtcNow.ToString('yyyy-MM-dd')
            $entry = "$marker`n`n## $Version - $date`n`n$notes`n"
            $cl = $cl.Substring(0, $at) + $entry + $cl.Substring($at + $marker.Length)
            [IO.File]::WriteAllText($clPath, $cl, $Utf8)
        }
        $null = Exec 'git' @('config', 'user.name', 'dozeyy')
        $null = Exec 'git' @('config', 'user.email', 'dozeyy@users.noreply.github.com')
        $null = Run 'git add' 'git' @('add', '-A')
        $null = Exec 'git' @('diff', '--cached', '--quiet')
        if ($script:Code -eq 0) {
            Say 'The public repo already has this plugin and changelog.'
        } else {
            $null = Run 'git commit' 'git' @('commit', '-q', '-m', "Atlas ${Version}: plugin and changelog")
            $needPush = $true
        }
    } finally { Pop-Location }

    # ---- 7. publish the release
    if (-not $published) {
        Say "Publishing $Tag ..."
        $null = Run 'gh release edit' 'gh' @('release', 'edit', $Tag, '--repo', $Target, '--draft=false', '--latest')
    } else {
        Say 'The release was already published; its assets are all correct.'
    }

    # ---- 8. push the plugin, after the release is public
    if ($needPush) {
        Push-Location $clone
        try {
            $null = Exec 'git' @('push', '-q', 'origin', 'HEAD:main')
            if ($script:Code -ne 0) {
                Fail "the release is published but pushing the plugin to $Target main failed: $($script:Err) Rerun this command to finish it."
            }
        } finally { Pop-Location }
        Say 'Pushed the plugin and changelog to main.'
    }

    Say ''
    Say "Done: https://github.com/$Target/releases/tag/$Tag"
    Say "  assets: $($names.Count)   plugin version: $Version   checks: signed SHA256SUMS, pins, bundle signatures, latest.json"
} finally {
    if (Test-Path -LiteralPath $Work) { Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue }
}
