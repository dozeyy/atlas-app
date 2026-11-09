# Pins a release build's atlas-usage hashes into the plugin.
#   pwsh tools/pin-skill-checksums.ps1 -Dir <folder with the built atlas-usage-* files> -Version <x.y.z> [-Force]
# Hashes the three built files directly (Get-FileHash), so nothing a release page says is read.
# Writes "<version> <asset> <sha256>" lines into skill/skills/atlas/bin/checksums.txt, keeping the
# other versions' lines. LF endings, no BOM.
#  - -Version must equal the version in skill/.claude-plugin/plugin.json.
#  - A version that is already pinned with different hashes is refused unless -Force.
# The launcher trusts only that file, so run this from a trusted checkout, on the files the same
# CI run built and uploaded, and commit the result with the plugin version set to the same number.
param(
    [Parameter(Mandatory = $true)][string]$Dir,
    [Parameter(Mandatory = $true)][string]$Version,
    [switch]$Force,
    [string]$Out = '',
    [string]$PluginJson = ''
)
$ErrorActionPreference = 'Stop'

if ($Version -notmatch '^[0-9][A-Za-z0-9._-]*$') { throw "bad version '$Version'" }

$repo = Split-Path -Parent $PSScriptRoot
if (-not $PluginJson) { $PluginJson = Join-Path (Join-Path (Join-Path $repo 'skill') '.claude-plugin') 'plugin.json' }
if (-not $Out) { $Out = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $repo 'skill') 'skills') 'atlas') 'bin') 'checksums.txt' }

$pj = [IO.File]::ReadAllText($PluginJson)
if ($pj -notmatch '"version"\s*:\s*"([^"]*)"') { throw "no version in $PluginJson" }
$pluginVersion = [string]$Matches[1]
if ($pluginVersion -cne $Version) { throw "-Version $Version is not the plugin version $pluginVersion (plugin.json); bump them together" }

$wanted = @('atlas-usage-windows-x64.exe', 'atlas-usage-macos-universal', 'atlas-usage-linux-x64')
$new = [ordered]@{}
foreach ($a in $wanted) {
    $p = Join-Path $Dir $a
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "missing built file: $p" }
    if ((Get-Item -LiteralPath $p).Length -eq 0) { throw "empty built file: $p" }
    $new[$a] = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
}

$keep = New-Object System.Collections.Generic.List[string]
$old = @{}
if (Test-Path -LiteralPath $Out -PathType Leaf) {
    foreach ($line in [IO.File]::ReadAllLines($Out)) {
        $line = $line.TrimStart([char]0xFEFF)
        if ($line.Trim() -eq '') { continue }
        $f = @($line -split '\s+' | Where-Object { $_ })
        if ($f.Count -ge 3 -and $f[0] -ceq $Version) { $old[$f[1]] = $f[2].ToLowerInvariant(); continue }
        $keep.Add($line.TrimEnd())
    }
}
if ($old.Count -gt 0) {
    $same = ($old.Count -eq $new.Count)
    foreach ($a in $wanted) { if (-not $old.ContainsKey($a) -or $old[$a] -ne $new[$a]) { $same = $false } }
    if (-not $same -and -not $Force) { throw "version $Version is already pinned with different hashes; a released version must not change (use -Force only if you mean it)" }
}
foreach ($a in $wanted) { $keep.Add("$Version $a $($new[$a])") }

$text = ($keep -join "`n") + "`n"
[IO.File]::WriteAllText([IO.Path]::GetFullPath($Out), $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "pinned $Version -> $Out"
