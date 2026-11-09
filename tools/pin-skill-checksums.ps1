# Pins a release's atlas-usage hashes into the plugin.
#   pwsh tools/pin-skill-checksums.ps1 -Sums <SHA256SUMS.txt> -Version <x.y.z>
# Reads the release's SHA256SUMS.txt ("<sha256>  <file>" lines), takes the atlas-usage-* assets,
# and writes "<version> <asset> <sha256>" lines into skill/skills/atlas/bin/checksums.txt
# (replacing any lines for that version, keeping the other versions). LF endings, no BOM.
# The launcher trusts only this file, so run it from a trusted checkout and commit the result
# together with the plugin version set to the same number.
param(
    [Parameter(Mandatory = $true)][string]$Sums,
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Out = ''
)
$ErrorActionPreference = 'Stop'

if ($Version -notmatch '^[0-9][A-Za-z0-9._-]*$') { throw "bad version '$Version'" }
if (-not $Out) { $Out = Join-Path $PSScriptRoot '..\skill\skills\atlas\bin\checksums.txt' }
$wanted = @('atlas-usage-windows-x64.exe', 'atlas-usage-macos-universal', 'atlas-usage-linux-x64')

$found = @{}
foreach ($line in [IO.File]::ReadAllLines($Sums)) {
    $line = $line.TrimStart([char]0xFEFF)
    if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(\S+)\s*$' -and $wanted -contains $Matches[2]) {
        $found[$Matches[2]] = $Matches[1].ToLowerInvariant()
    }
}
$missing = @($wanted | Where-Object { -not $found.ContainsKey($_) })
if ($missing.Count -gt 0) { throw "SHA256SUMS.txt has no line for: $($missing -join ', ')" }

$keep = New-Object System.Collections.Generic.List[string]
if (Test-Path -LiteralPath $Out) {
    foreach ($line in [IO.File]::ReadAllLines($Out)) {
        $line = $line.TrimStart([char]0xFEFF)
        if ($line.Trim() -eq '') { continue }
        $f = @($line -split '\s+' | Where-Object { $_ })
        if ($f.Count -ge 3 -and $f[0] -ceq $Version) { continue }   # replaced below
        $keep.Add($line.TrimEnd())
    }
}
foreach ($a in $wanted) { $keep.Add("$Version $a $($found[$a])") }

$text = ($keep -join "`n") + "`n"
[IO.File]::WriteAllText((Resolve-Path -LiteralPath (Split-Path -Parent $Out)).Path + '\' + (Split-Path -Leaf $Out), $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "pinned $Version -> $Out"
