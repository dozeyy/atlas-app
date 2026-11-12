# Tests for skill/skills/atlas/bin/atlas-usage.ps1, the same checks as test-launcher.sh. No network:
# fake programs and a local folder stand in for the release (ATLAS_USAGE_TEST_SOURCE), the pins are
# made here, and the stand-in release is signed with a throwaway key made here (node,
# tests/launcher/sign-minisign.mjs). Each run of the launcher is a fresh process of the PowerShell
# that runs this file, with a clean environment.
#   usage: powershell -NoProfile -ExecutionPolicy Bypass -File tests/launcher/Test-Launcher.ps1
#          pwsh -NoProfile -File tests/launcher/Test-Launcher.ps1
# Runs on Windows (PowerShell 5.1 and pwsh 7), Linux and macOS (pwsh 7).
# -MakeFake is internal: pwsh on Windows asks Windows PowerShell to build a fake .exe with it.
param([string]$MakeFake, [string]$FakeId, [switch]$FakeOld)

$ErrorActionPreference = 'Continue'
$onWindows = ($PSVersionTable.PSEdition -ne 'Core') -or $IsWindows

# fake <file> <id> [old]: prints its id and arguments; an "old" one knows no repeats/debrief.
$FakeSource = @'
using System;
using System.IO;
public static class FAKECLASS {
    public static int Main(string[] a) {
        string id = "FAKEID";
        bool old = FAKEOLD;
        if (!old && a.Length >= 2 && a[0] == "repeats" && a[1] == "--help") { Console.WriteLine("usage: repeats, offer-note"); return 0; }
        if (!old && a.Length >= 2 && a[0] == "debrief" && a[1] == "--help") { Console.WriteLine("what this chat's helpers did"); return 0; }
        if (a.Length > 0 && a[0] == "args") { // each argument in brackets, to see their bounds
            var sb = new System.Text.StringBuilder();
            foreach (string x in a) sb.Append("[" + x + "]");
            Console.WriteLine(sb.ToString());
            return 0;
        }
        string log = Environment.GetEnvironmentVariable("FAKE_LOG");
        if (!old && !string.IsNullOrEmpty(log)) File.AppendAllText(log, "run\n");
        Console.WriteLine("fake " + id + " " + string.Join(" ", a));
        return 0;
    }
}
'@
function Invoke-FakeBuild([string]$out, [string]$id, [bool]$old) {
    $cls = 'Fake' + [guid]::NewGuid().ToString('N')
    $code = $FakeSource.Replace('FAKECLASS', $cls).Replace('FAKEID', $id).Replace('FAKEOLD', $old.ToString().ToLowerInvariant())
    Add-Type -TypeDefinition $code -Language CSharp -OutputType ConsoleApplication -OutputAssembly $out
}
if ($MakeFake) {
    Invoke-FakeBuild $MakeFake $FakeId $FakeOld.IsPresent
    exit 0
}

$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $here (Join-Path '..' '..'))).Path
$launcherSrc = Join-Path $repo (Join-Path 'skill' (Join-Path 'skills' (Join-Path 'atlas' (Join-Path 'bin' 'atlas-usage.ps1'))))
# The PowerShell running this file, as a program (a dotnet global-tool pwsh runs inside dotnet.exe).
if ($PSVersionTable.PSEdition -eq 'Core') {
    $shellExe = Join-Path $PSHOME $(if ($onWindows) { 'pwsh.exe' } else { 'pwsh' })
    if (-not (Test-Path -LiteralPath $shellExe)) { $shellExe = (Get-Command pwsh -CommandType Application | Select-Object -First 1).Source }
} else {
    $shellExe = Join-Path $PSHOME 'powershell.exe'
}
$shellName = "$($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)"

$T = Join-Path ([IO.Path]::GetTempPath()) ('atlas-launcher-test.' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $T | Out-Null

$script:passed = 0
$script:failed = 0
function Write-Ok([string]$name) { $script:passed++; [Console]::Out.WriteLine("ok   $name") }
function Write-Bad([string]$name, [string]$detail) {
    $script:failed++
    [Console]::Out.WriteLine("FAIL $name")
    if ($detail) { [Console]::Out.WriteLine("     $detail") }
}
function Read-Text([string]$path) { if (Test-Path -LiteralPath $path) { return [IO.File]::ReadAllText($path) } else { return '' } }
function Test-Check([string]$name, [scriptblock]$cond) {
    $r = $false
    try { $r = [bool](& $cond) } catch { $r = $false }
    if ($r) { Write-Ok $name }
    else {
        $o = Read-Text (Join-Path $T 'out'); $e = Read-Text (Join-Path $T 'err')
        if ($o.Length -gt 600) { $o = $o.Substring(0, 600) }
        if ($e.Length -gt 600) { $e = $e.Substring(0, 600) }
        Write-Bad $name "out: $o | err: $e"
    }
}
function Test-Out([string]$s) { return (Read-Text (Join-Path $T 'out')).Contains($s) }
function Test-Err([string]$s) { return (Read-Text (Join-Path $T 'err')).Contains($s) }
function Get-Sha([string]$path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }

$exe = 'atlas-usage'
if ($onWindows) {
    $asset = 'atlas-usage-windows-x64.exe'; $exe = 'atlas-usage.exe'
} elseif ($IsMacOS) {
    $asset = 'atlas-usage-macos-universal'
} else {
    if ([string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { $asset = 'atlas-usage-linux-arm64' } else { $asset = 'atlas-usage-linux-x64' }
    if (@(Get-ChildItem -Path '/lib' -Filter 'ld-musl-*.so.1' -ErrorAction SilentlyContinue).Count -gt 0) { $asset = "$asset-musl" }
}

# The stand-in release is signed with a key made now; a second key plays a stranger.
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) { [Console]::Out.WriteLine('FAIL: the tests need node to sign their stand-in release'); exit 1 }
$signer = Join-Path $here 'sign-minisign.mjs'
New-Item -ItemType Directory -Path (Join-Path $T 'key'), (Join-Path $T 'key2') | Out-Null
$TestKey = (& $node.Source $signer keygen (Join-Path $T 'key') | Out-String).Trim()
$null = & $node.Source $signer keygen (Join-Path $T 'key2')
if (-not $TestKey) { [Console]::Out.WriteLine('FAIL: cannot make a test key'); exit 1 }
function Invoke-Sign([string[]]$a) {
    $null = & $node.Source $signer @a
    if ($LASTEXITCODE -ne 0) { throw "signer failed: $a" }
}

# Fake programs: a C# console program on Windows (built once per id), a shell script elsewhere.
$fakeDir = Join-Path $T 'fakes'
New-Item -ItemType Directory -Path $fakeDir | Out-Null
function Write-Fake([string]$file, [string]$id, [switch]$Old) {
    $dir = Split-Path -Parent $file
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    if ($onWindows) {
        $built = Join-Path $fakeDir ("$id" + $(if ($Old) { '-old' } else { '' }) + '.exe')
        if (-not (Test-Path -LiteralPath $built)) {
            if ($PSVersionTable.PSEdition -eq 'Core') {
                $wp = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
                $fa = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-MakeFake', $built, '-FakeId', $id)
                if ($Old) { $fa += '-FakeOld' }
                & $wp @fa
            } else {
                Invoke-FakeBuild $built $id $Old.IsPresent
            }
        }
        Copy-Item -LiteralPath $built -Destination $file -Force
    } else {
        if ($Old) {
            $text = "#!/bin/sh`necho `"fake $id `$*`"`n"
        } else {
            $text = "#!/bin/sh`ncase `"`$1 `$2`" in`n  `"repeats --help`") echo `"usage: repeats, offer-note`"; exit 0 ;;`n" +
                "  `"debrief --help`") echo `"what this chat's helpers did`"; exit 0 ;;`nesac`n" +
                "[ `"`$1`" = args ] && { for a; do printf '[%s]' `"`$a`"; done; echo; exit 0; }`n" +
                "[ -n `"`$FAKE_LOG`" ] && echo run >>`"`$FAKE_LOG`"`necho `"fake $id `$*`"`n"
        }
        [IO.File]::WriteAllText($file, $text)
        & chmod +x $file
    }
}

# A plugin tree at $T/p<n> with the given version; the release folder $T/rel<n>.
function Initialize-Plugin([int]$n, [string]$ver) {
    $script:P = Join-Path $T "p$n"
    $bin = Join-Path $script:P (Join-Path 'skills' (Join-Path 'atlas' 'bin'))
    New-Item -ItemType Directory -Force -Path (Join-Path $script:P '.claude-plugin'), $bin | Out-Null
    [IO.File]::WriteAllText((Join-Path $script:P (Join-Path '.claude-plugin' 'plugin.json')), "{ `"name`": `"atlas`", `"version`": `"$ver`" }`n")
    Copy-Item -LiteralPath $launcherSrc -Destination (Join-Path $bin 'atlas-usage.ps1')
    [IO.File]::WriteAllText((Join-Path $bin 'checksums.txt'), "# test pins`n")
    $script:L = Join-Path $bin 'atlas-usage.ps1'
    $script:PINS = Join-Path $bin 'checksums.txt'
    $script:REL = Join-Path $T "rel$n"
    New-Item -ItemType Directory -Force -Path $script:REL | Out-Null
}
function Add-Pin([string]$ver, [string]$name, [string]$file) {
    [IO.File]::AppendAllText($script:PINS, "$ver $name $(Get-Sha $file)`n")
}

# A PATH without any real atlas-usage, gh or Atlas app.
$emptyBin = Join-Path $T 'emptybin'
New-Item -ItemType Directory -Path $emptyBin, (Join-Path $T 'home'), (Join-Path $T 'tmp'), (Join-Path $T 'lad'), (Join-Path $T 'pf') | Out-Null
if ($onWindows) {
    $sys = $env:SystemRoot
    $BasePath = "$emptyBin;$sys\System32;$sys;$sys\System32\WindowsPowerShell\v1.0"
} else {
    $BasePath = "${emptyBin}:/usr/bin:/bin:/usr/sbin:/sbin"
    if (Get-Command gh -ErrorAction SilentlyContinue) { & ln -s /bin/false (Join-Path $emptyBin 'gh') }
}

# One argument quoted the way Windows programs (and .NET on Unix) split a command line again.
function Quote([string]$a) {
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append('"')
    $bs = 0
    foreach ($c in $a.ToCharArray()) {
        if ($c -eq [char]92) { $bs++; continue }
        if ($c -eq [char]34) { [void]$sb.Append([char]92, 2 * $bs + 1) }
        elseif ($bs) { [void]$sb.Append([char]92, $bs) }
        [void]$sb.Append($c)
        $bs = 0
    }
    [void]$sb.Append([char]92, 2 * $bs)
    [void]$sb.Append('"')
    return $sb.ToString()
}
# Starts the launcher with a clean environment. $o: Data, Src, Key, RunPath, Extra (hashtable),
# Out / Err file names. Returns the process (already finished unless -NoWait).
function Invoke-Launcher([hashtable]$o, [string[]]$argv, [switch]$NoWait) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $shellExe
    $al = @('-NoProfile')
    if ($onWindows) { $al += @('-ExecutionPolicy', 'Bypass') }
    $al += @('-File', (Quote $script:L))
    foreach ($a in $argv) { $al += (Quote $a) }
    $psi.Arguments = $al -join ' '
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $psi.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $e = $psi.EnvironmentVariables
    $e.Clear()
    $path = $BasePath
    if ($o.ContainsKey('RunPath')) { $path = $o.RunPath }
    $e['PATH'] = $path
    $e['HOME'] = (Join-Path $T 'home')
    if ($onWindows) {
        foreach ($k in 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'DOTNET_ROOT', 'USERPROFILE') {
            $v = [Environment]::GetEnvironmentVariable($k)
            if ($v) { $e[$k] = $v }
        }
        $e['TEMP'] = (Join-Path $T 'tmp'); $e['TMP'] = (Join-Path $T 'tmp')
        $e['LOCALAPPDATA'] = (Join-Path $T 'lad')
        $e['ProgramFiles'] = (Join-Path $T 'pf'); $e['ProgramW6432'] = (Join-Path $T 'pf')
    } else {
        $e['TMPDIR'] = (Join-Path $T 'tmp')
    }
    if ($o.ContainsKey('Data')) { $data = $o.Data } else { $data = Join-Path $T 'data' }
    if ($data) { $e['CLAUDE_PLUGIN_DATA'] = $data }
    if ($o.ContainsKey('Src')) { $s = $o.Src } else { $s = $script:REL }
    if ($s) { $e['ATLAS_USAGE_TEST_SOURCE'] = $s }
    if ($o.ContainsKey('Key')) { $k2 = $o.Key } else { $k2 = $TestKey }
    if ($k2) { $e['ATLAS_USAGE_TEST_PUBKEY'] = $k2 }
    if (-not $o.ContainsKey('Quiet')) { $e['ATLAS_USAGE_LAUNCHER_VERBOSE'] = '1' }
    if ($o.ContainsKey('FakeLog')) { $e['FAKE_LOG'] = $o.FakeLog }
    if ($o.ContainsKey('Extra')) { foreach ($k in $o.Extra.Keys) { $e[$k] = $o.Extra[$k] } }
    $p = [Diagnostics.Process]::Start($psi)
    $p | Add-Member -NotePropertyName OutTask -NotePropertyValue $p.StandardOutput.ReadToEndAsync()
    $p | Add-Member -NotePropertyName ErrTask -NotePropertyValue $p.StandardError.ReadToEndAsync()
    $outName = 'out'; $errName = 'err'
    if ($o.ContainsKey('Out')) { $outName = $o.Out }
    if ($o.ContainsKey('Err')) { $errName = $o.Err }
    $p | Add-Member -NotePropertyName OutFile -NotePropertyValue (Join-Path $T $outName)
    $p | Add-Member -NotePropertyName ErrFile -NotePropertyValue (Join-Path $T $errName)
    if (-not $NoWait) { Wait-Launcher $p }
    return $p
}
function Wait-Launcher($p) {
    $p.WaitForExit()
    [IO.File]::WriteAllText($p.OutFile, $p.OutTask.Result)
    [IO.File]::WriteAllText($p.ErrFile, $p.ErrTask.Result)
}
# Each run signs the stand-in release first (NoSign keeps hand-made files as they are).
function Invoke-Run([hashtable]$o, [string[]]$argv) {
    if (-not $o.ContainsKey('NoSign') -and (Test-Path -LiteralPath $script:REL)) { Invoke-Sign @('sums', (Join-Path $T 'key'), $script:REL) }
    $p = Invoke-Launcher $o $argv
    return $p.ExitCode
}

# --- 1. first run downloads, checks the pin, saves, runs with the arguments unchanged
Initialize-Plugin 1 '1.0.0'
Write-Fake (Join-Path $REL $asset) 'v1'
Add-Pin '1.0.0' $asset (Join-Path $REL $asset)
$rc = Invoke-Run @{} @('week', '--top', '3')
Test-Check 'download: exit 0' { $rc -eq 0 }
Test-Check 'download: runs with the same arguments' { Test-Out 'fake v1 week --top 3' }
Test-Check 'download: says what it fetched' { Test-Err 'downloading the program for' }
Test-Check 'download: reports size' { Test-Err 'matches the pinned checksum' }
Test-Check 'download: saved under the plugin data folder' { Test-Path -LiteralPath (Join-Path $T "data/cache/1.0.0/$exe") -PathType Leaf }

# --- 2. second run uses the saved copy
$rc = Invoke-Run @{} @('today')
Test-Check 'cache: used' { Test-Err 'launcher: cache:' }
Test-Check 'cache: output' { Test-Out 'fake v1 today' }

# --- 3. a saved copy that no longer matches its pin is deleted and fetched again
[IO.File]::WriteAllText((Join-Path $T "data/cache/1.0.0/$exe"), "#!/bin/sh`necho tampered`n")
if (-not $onWindows) { & chmod +x (Join-Path $T "data/cache/1.0.0/$exe") }
$rc = Invoke-Run @{} @('today')
Test-Check 'tampered cache: not run' { -not (Test-Out 'tampered') }
Test-Check 'tampered cache: refetched and run' { Test-Out 'fake v1 today' }
Test-Check 'tampered cache: says so' { Test-Err 'did not match the checksum' }

# --- 4. checksum mismatch on download: exit 3, nothing saved
Initialize-Plugin 2 '2.0.0'
Write-Fake (Join-Path $REL $asset) 'v2'
[IO.File]::AppendAllText($PINS, "2.0.0 $asset 0000000000000000000000000000000000000000000000000000000000000000`n")
$rc = Invoke-Run @{ Data = (Join-Path $T 'data2') } @('week')
Test-Check 'mismatch: exit 3' { $rc -eq 3 }
Test-Check 'mismatch: message' { Test-Err 'did not match the checksum pinned' }
Test-Check 'mismatch: nothing saved' { -not (Test-Path -LiteralPath (Join-Path $T "data2/cache/2.0.0/$exe")) }
Test-Check 'mismatch: no lock or work folder left' { @(Get-ChildItem -LiteralPath (Join-Path $T 'data2/cache') -Force | Where-Object { $_.Name.StartsWith('.') }).Count -eq 0 }

# --- 5. no pin for this version: exit 3 and the exact update command
Initialize-Plugin 3 '3.0.0'
Write-Fake (Join-Path $REL $asset) 'v3'
$rc = Invoke-Run @{ Data = (Join-Path $T 'data3') } @('week')
Test-Check 'no pin: exit 3' { $rc -eq 3 }
Test-Check 'no pin: names the update command' { Test-Err '/plugin marketplace update atlas' }

# --- 6. a version with pins, but none for this computer
Initialize-Plugin 4 '4.0.0'
Write-Fake (Join-Path $REL 'other') 'v4'
Add-Pin '4.0.0' 'atlas-usage-some-other-computer' (Join-Path $REL 'other')
$rc = Invoke-Run @{ Data = (Join-Path $T 'data4') } @('week')
Test-Check 'no build for this computer: exit 3' { $rc -eq 3 }
Test-Check 'no build for this computer: says so' { Test-Err 'no ready-made build for' }

# --- 7. offline after a plugin update: the older saved copy answers, with a note
Initialize-Plugin 5 '1.0.0'
Write-Fake (Join-Path $REL $asset) 'v1'
Add-Pin '1.0.0' $asset (Join-Path $REL $asset)
$null = Invoke-Run @{ Data = (Join-Path $T 'data5') } @('week')
Test-Check 'offline setup: v1 saved' { Test-Path -LiteralPath (Join-Path $T "data5/cache/1.0.0/$exe") -PathType Leaf }
Write-Fake (Join-Path $T 'v11/prog') 'v1.1'
Add-Pin '1.1.0' $asset (Join-Path $T 'v11/prog')
$pjPath = Join-Path $P '.claude-plugin/plugin.json'
[IO.File]::WriteAllText($pjPath, ([IO.File]::ReadAllText($pjPath)).Replace('"1.0.0"', '"1.1.0"'))
Remove-Item -LiteralPath (Join-Path $REL $asset)
$rc = Invoke-Run @{ Data = (Join-Path $T 'data5') } @('week')
Test-Check 'offline: exit 0' { $rc -eq 0 }
Test-Check 'offline: older copy answers' { Test-Out 'fake v1 week' }
Test-Check 'offline: says which version' { Test-Err 'comes from the older v1.0.0' }
Copy-Item -LiteralPath (Join-Path $T 'v11/prog') -Destination (Join-Path $REL $asset)
$rc = Invoke-Run @{ Data = (Join-Path $T 'data5') } @('week')
Test-Check 'back online: new version' { Test-Out 'fake v1.1 week' }
Test-Check 'back online: older copy pruned' { -not (Test-Path -LiteralPath (Join-Path $T 'data5/cache/1.0.0')) }

# --- 8. a copy on PATH: an old pinned release is passed over, an unknown build is used
Initialize-Plugin 6 '2.0.0'
Write-Fake (Join-Path $T 'oldbin-v1/prog') 'v1'
$oldbin = Join-Path $T 'oldbin-v1/prog'
Add-Pin '1.0.0' $asset $oldbin
Write-Fake (Join-Path $REL $asset) 'v2'
Add-Pin '2.0.0' $asset (Join-Path $REL $asset)
New-Item -ItemType Directory -Path (Join-Path $T 'pathold'), (Join-Path $T 'pathdev') | Out-Null
Copy-Item -LiteralPath $oldbin -Destination (Join-Path $T "pathold/$exe")
$sep = [IO.Path]::PathSeparator
$rc = Invoke-Run @{ RunPath = ((Join-Path $T 'pathold') + $sep + $BasePath); Data = (Join-Path $T 'data6') } @('week')
Test-Check 'PATH old release: passed over' { Test-Err 'passed over' }
Test-Check 'PATH old release: current build runs' { Test-Out 'fake v2 week' }
Write-Fake (Join-Path $T "pathdev/$exe") 'dev'
$rc = Invoke-Run @{ RunPath = ((Join-Path $T 'pathdev') + $sep + $BasePath); Data = (Join-Path $T 'data6') } @('week')
Test-Check 'PATH own build: used' { Test-Out 'fake dev week' }
# Offline with only the old PATH copy: it is the last resort.
Initialize-Plugin 7 '2.0.0'
Add-Pin '1.0.0' $asset $oldbin
Write-Fake (Join-Path $T 'v2b/prog') 'v2'
Add-Pin '2.0.0' $asset (Join-Path $T 'v2b/prog')
$rc = Invoke-Run @{ RunPath = ((Join-Path $T 'pathold') + $sep + $BasePath); Data = (Join-Path $T 'data7') } @('week')
Test-Check 'offline, old PATH copy: last resort' { Test-Out 'fake v1 week' }

# --- 9. too old for repeats: exit 4; a good copy's check is remembered
Initialize-Plugin 8 '1.0.0'
Write-Fake (Join-Path $REL $asset) 'v1' -Old
Add-Pin '1.0.0' $asset (Join-Path $REL $asset)
$rc = Invoke-Run @{ Data = (Join-Path $T 'data8') } @('repeats', '--like', 'x', '--json')
Test-Check 'too old: exit 4' { $rc -eq 4 }
Test-Check 'too old: names the update command' { Test-Err '/plugin marketplace update atlas' }
Initialize-Plugin 9 '1.0.0'
Write-Fake (Join-Path $REL $asset) 'v1'
Add-Pin '1.0.0' $asset (Join-Path $REL $asset)
$rc = Invoke-Run @{ Data = (Join-Path $T 'data9') } @('debrief', '--detail', 'low')
Test-Check 'debrief: runs' { Test-Out 'fake v1 debrief --detail low' }
Test-Check 'debrief: check remembered' { @(Get-ChildItem -LiteralPath (Join-Path $T 'data9/cache/caps') -Filter '*.debrief').Count -eq 1 }

# --- 10. ATLAS_USAGE_BIN
Write-Fake (Join-Path $T "mine/$exe") 'mine'
$rc = Invoke-Run @{ Data = (Join-Path $T 'data9'); Extra = @{ ATLAS_USAGE_BIN = (Join-Path $T "mine/$exe") } } @('week')
Test-Check 'ATLAS_USAGE_BIN: used' { Test-Out 'fake mine week' }
$rc = Invoke-Run @{ Data = (Join-Path $T 'data9'); Extra = @{ ATLAS_USAGE_BIN = (Join-Path $T 'nope') } } @('week')
Test-Check 'ATLAS_USAGE_BIN missing: exit 3' { $rc -eq 3 }

# --- 11. launcher-doctor runs nothing
$rc = Invoke-Run @{ Data = (Join-Path $T 'data9'); FakeLog = (Join-Path $T 'runs.log') } @('launcher-doctor')
Test-Check 'doctor: exit 0' { $rc -eq 0 }
Test-Check 'doctor: names the copy' { Test-Out 'would run' }
Test-Check 'doctor: ran nothing' { -not (Test-Path -LiteralPath (Join-Path $T 'runs.log')) }
$null = Invoke-Run @{ Data = (Join-Path $T 'data-doctor-empty') } @('launcher-doctor')
Test-Check 'doctor: would download' { Test-Out 'one-time download' }
Test-Check 'doctor: downloaded nothing' { -not (Test-Path -LiteralPath (Join-Path $T 'data-doctor-empty/cache/1.0.0')) }

# --- 12. no plugin data folder: a per-user cache folder, not the plugin folder
Initialize-Plugin 10 '1.0.0'
Write-Fake (Join-Path $REL $asset) 'v1'
Add-Pin '1.0.0' $asset (Join-Path $REL $asset)
if ($onWindows) { $wantDir = Join-Path $T 'lad/atlas/skill/cache/1.0.0' }
elseif ($IsMacOS) { $wantDir = Join-Path $T 'home/Library/Caches/atlas/skill/cache/1.0.0' }
else { $wantDir = Join-Path $T 'home/.cache/atlas/skill/cache/1.0.0' }
$rc = Invoke-Run @{ Data = '' } @('week')
Test-Check 'user cache: used' { Test-Path -LiteralPath (Join-Path $wantDir $exe) -PathType Leaf }
Test-Check 'user cache: not in the plugin folder' { -not (Test-Path -LiteralPath (Join-Path $P 'skills/atlas/bin/cache')) }

# --- 13. two runs at once: one download, both answer
Initialize-Plugin 11 '1.0.0'
Write-Fake (Join-Path $REL $asset) 'v1'
Add-Pin '1.0.0' $asset (Join-Path $REL $asset)
Invoke-Sign @('sums', (Join-Path $T 'key'), $REL)
$pa = Invoke-Launcher @{ Data = (Join-Path $T 'data11'); Quiet = 1; Out = 'outA'; Err = 'errA' } @('week') -NoWait
$pb = Invoke-Launcher @{ Data = (Join-Path $T 'data11'); Quiet = 1; Out = 'outB'; Err = 'errB' } @('week') -NoWait
Wait-Launcher $pa
Wait-Launcher $pb
Test-Check 'parallel: first answers' { (Read-Text (Join-Path $T 'outA')).Contains('fake v1 week') }
Test-Check 'parallel: second answers' { (Read-Text (Join-Path $T 'outB')).Contains('fake v1 week') }
Test-Check 'parallel: no lock left' { @(Get-ChildItem -LiteralPath (Join-Path $T 'data11/cache') -Force -Filter '.lock*').Count -eq 0 }
Test-Check 'parallel: no work folder left' { @(Get-ChildItem -LiteralPath (Join-Path $T 'data11/cache') -Force -Filter '.dl*').Count -eq 0 }

# --- 14. a loopback address stands in for the release (http), when python is here
$py = $null
foreach ($cand in 'python3', 'python') {
    $c = Get-Command $cand -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) {
        & $c.Source -c 'import http.server' *> $null
        if ($LASTEXITCODE -eq 0) { $py = $c.Source; break }
    }
}
if ($py) {
    Initialize-Plugin 12 '1.0.0'
    Write-Fake (Join-Path $REL $asset) 'v1'
    Add-Pin '1.0.0' $asset (Join-Path $REL $asset)
    Invoke-Sign @('sums', (Join-Path $T 'key'), $REL)
    $port = 20000 + ($PID % 20000)
    $spsi = New-Object Diagnostics.ProcessStartInfo
    $spsi.FileName = $py
    $spsi.Arguments = "-m http.server $port --bind 127.0.0.1"
    $spsi.WorkingDirectory = $REL
    $spsi.UseShellExecute = $false
    $spsi.RedirectStandardOutput = $true
    $spsi.RedirectStandardError = $true
    $srv = [Diagnostics.Process]::Start($spsi)
    $null = $srv.StandardOutput.ReadToEndAsync(); $null = $srv.StandardError.ReadToEndAsync()
    $up = $false
    for ($i = 0; $i -lt 50 -and -not $up; $i++) {
        try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); $up = $true } catch { Start-Sleep -Milliseconds 100 }
    }
    $rc = Invoke-Run @{ Src = "http://127.0.0.1:$port"; Data = (Join-Path $T 'data12'); NoSign = 1 } @('week')
    try { $srv.Kill() } catch { $null = $_ }
    Test-Check 'loopback: downloads and runs' { Test-Out 'fake v1 week' }
}

# --- 15. the signed checksum list (SHA256SUMS.txt + .sig from the same release)
function Initialize-SigCase([int]$n) { # a fresh plugin + release with a pinned v1 program
    Initialize-Plugin $n '1.0.0'
    Write-Fake (Join-Path $script:REL $asset) 'v1'
    Add-Pin '1.0.0' $asset (Join-Path $script:REL $asset)
    Write-Fake (Join-Path $script:REL 'other-file') 'other'
}
function Test-Refused([string]$name, [string]$data, [string]$why) {
    Test-Check "${name}: exit 3" { $rc -eq 3 }
    Test-Check "${name}: says why" { Test-Err $why }
    Test-Check "${name}: names the update command" { Test-Err '/plugin marketplace update atlas' }
    Test-Check "${name}: not run" { -not (Test-Out 'fake v1') }
    Test-Check "${name}: nothing saved" { -not (Test-Path -LiteralPath (Join-Path $data "cache/1.0.0/$exe")) }
}
Initialize-SigCase 13
$null = Invoke-Run @{ Data = (Join-Path $T 'data13') } @('launcher-doctor')
if (Test-Out 'checked on download with the built-in verifier') {
    Initialize-SigCase 14
    $rc = Invoke-Run @{ Data = (Join-Path $T 'data14') } @('week')
    Test-Check 'signature: good list, exit 0' { $rc -eq 0 }
    Test-Check 'signature: good list, runs' { Test-Out 'fake v1 week' }
    Test-Check 'signature: says it was checked' { Test-Err 'signed release list' }
    Test-Check 'signature: recorded for the saved copy' { (Read-Text (Join-Path $T 'data14/cache/1.0.0/signature')).Trim() -ceq 'checked' }
    $null = Invoke-Run @{ Data = (Join-Path $T 'data14') } @('launcher-doctor')
    Test-Check 'signature: doctor reports the saved copy' { Test-Out 'checked when it was saved' }

    # one byte of the list changed after signing
    Initialize-SigCase 15
    Invoke-Sign @('sums', (Join-Path $T 'key'), $REL)
    $sp = Join-Path $REL 'SHA256SUMS.txt'
    [IO.File]::WriteAllText($sp, ([IO.File]::ReadAllText($sp)).Replace('other-file', 'other-filf'))
    $rc = Invoke-Run @{ Data = (Join-Path $T 'data15'); NoSign = 1 } @('week')
    Test-Refused 'list changed after signing' (Join-Path $T 'data15') 'not signed by the Atlas key'
    # one byte of the trusted comment changed
    Initialize-SigCase 16
    Invoke-Sign @('sums', (Join-Path $T 'key'), $REL)
    $sg = Join-Path $REL 'SHA256SUMS.txt.sig'
    $inner = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([IO.File]::ReadAllText($sg).Trim())).Replace('file:', 'fild:')
    [IO.File]::WriteAllText($sg, [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($inner)))
    $rc = Invoke-Run @{ Data = (Join-Path $T 'data16'); NoSign = 1 } @('week')
    Test-Refused 'trusted comment changed' (Join-Path $T 'data16') 'not signed by the Atlas key'
    # signed by another key
    Initialize-SigCase 17
    Invoke-Sign @('sums', (Join-Path $T 'key2'), $REL)
    $rc = Invoke-Run @{ Data = (Join-Path $T 'data17'); NoSign = 1 } @('week')
    Test-Refused 'another key' (Join-Path $T 'data17') 'not signed by the Atlas key'
    # a well-signed list that gives the program another hash
    Initialize-SigCase 18
    [IO.File]::WriteAllText((Join-Path $REL 'SHA256SUMS.txt'), "1111111111111111111111111111111111111111111111111111111111111111  $asset`n")
    Invoke-Sign @('sign', (Join-Path $T 'key'), (Join-Path $REL 'SHA256SUMS.txt'))
    $rc = Invoke-Run @{ Data = (Join-Path $T 'data18'); NoSign = 1 } @('week')
    Test-Refused 'list disagrees with the pin' (Join-Path $T 'data18') 'does not list this program with the pinned checksum'
    # a well-signed list without the program
    Initialize-SigCase 19
    [IO.File]::WriteAllText((Join-Path $REL 'SHA256SUMS.txt'), "$(Get-Sha (Join-Path $REL 'other-file'))  other-file`n")
    Invoke-Sign @('sign', (Join-Path $T 'key'), (Join-Path $REL 'SHA256SUMS.txt'))
    $rc = Invoke-Run @{ Data = (Join-Path $T 'data19'); NoSign = 1 } @('week')
    Test-Refused 'list without the program' (Join-Path $T 'data19') 'does not list this program with the pinned checksum'
    # the release has no signed list: treated as a failed download
    Initialize-SigCase 20
    $rc = Invoke-Run @{ Data = (Join-Path $T 'data20'); NoSign = 1 } @('week')
    Test-Check 'no list: exit 3' { $rc -eq 3 }
    Test-Check 'no list: says the download failed' { Test-Err 'could not download' }
    Test-Check 'no list: nothing saved' { -not (Test-Path -LiteralPath (Join-Path $T "data20/cache/1.0.0/$exe")) }
    # the legacy unhashed "Ed" form, even when its signature is good, is refused
    Initialize-SigCase 24
    Invoke-Sign @('sums-legacy', (Join-Path $T 'key'), $REL)
    $rc = Invoke-Run @{ Data = (Join-Path $T 'data24'); NoSign = 1 } @('week')
    Test-Refused 'legacy Ed signature' (Join-Path $T 'data24') 'not signed by the Atlas key'
    # the test key counts only together with a stand-in release
    $null = Invoke-Run @{ Data = (Join-Path $T 'data20'); Src = '' } @('launcher-doctor')
    Test-Check 'test key: ignored without a stand-in release' { Test-Out 'against the Atlas release key' }
} else {
    Write-Bad 'signature: the built-in verifier did not compile' ''
}
# No verifier: PowerShell always carries its own (compiled from C# in the launcher), so the
# pin-only path is tested in test-launcher.sh, where openssl can be taken away.
[Console]::Out.WriteLine('note the no-verifier checks live in test-launcher.sh: PowerShell always has its verifier')

# --- 16. a saved copy that cannot be read to hash it is never run
Initialize-Plugin 22 '1.0.0'
Write-Fake (Join-Path $REL $asset) 'v1'
Add-Pin '1.0.0' $asset (Join-Path $REL $asset)
$null = Invoke-Run @{ Data = (Join-Path $T 'data22') } @('week')
$c22 = Join-Path $T "data22/cache/1.0.0/$exe"
if ($onWindows) {
    # Held open by another program with no sharing: it cannot be read, deleted or replaced.
    $hold = [IO.File]::Open($c22, 'Open', 'Read', 'None')
    try { $rc = Invoke-Run @{ Data = (Join-Path $T 'data22') } @('today') } finally { $hold.Dispose() }
    Test-Check 'unreadable cache: exit 3' { $rc -eq 3 }
    Test-Check 'unreadable cache: not run' { -not (Test-Out 'fake v1') }
    Test-Check 'unreadable cache: says so' { Test-Err 'could not be read to check it' }
} else {
    & chmod 111 $c22
    $rcRead = $true
    try { [IO.File]::ReadAllBytes($c22) | Out-Null } catch { $rcRead = $false }
    if ($rcRead) {
        [Console]::Out.WriteLine('note mode 111 leaves the file readable here (root): unreadable copy not tested')
    } else {
        $rc = Invoke-Run @{ Data = (Join-Path $T 'data22') } @('today')
        Test-Check 'unreadable cache: exit 0' { $rc -eq 0 }
        Test-Check 'unreadable cache: refetched and run' { Test-Out 'fake v1 today' }
        Test-Check 'unreadable cache: says so' { Test-Err 'could not be read to check it' }
    }
}

# --- 17. the copy cannot be replaced: the one already there runs only if it matches its pin
Initialize-Plugin 23 '1.0.0'
Write-Fake (Join-Path $REL $asset) 'v1'
Add-Pin '1.0.0' $asset (Join-Path $REL $asset)
$null = Invoke-Run @{ Data = (Join-Path $T 'data23') } @('week')
$c23 = Join-Path $T "data23/cache/1.0.0/$exe"
Write-Fake $c23 'tampered'
$tested23 = $true
if ($onWindows) {
    # Held open for reading only: it can be hashed and run, but not deleted or replaced.
    $hold = [IO.File]::Open($c23, 'Open', 'Read', 'Read')
    try { $rc = Invoke-Run @{ Data = (Join-Path $T 'data23') } @('today') } finally { $hold.Dispose() }
} else {
    $d23 = Join-Path $T 'data23/cache/1.0.0'
    & chmod 555 $d23
    $probe = Join-Path $d23 'probe'
    try { [IO.File]::WriteAllText($probe, ''); Remove-Item -LiteralPath $probe -Force; $tested23 = $false } catch { $null = $_ }
    if ($tested23) { $rc = Invoke-Run @{ Data = (Join-Path $T 'data23') } @('today') }
    & chmod 755 $d23
}
if ($tested23) {
    Test-Check 'unreplaceable copy: exit 3' { $rc -eq 3 }
    Test-Check 'unreplaceable copy: not run' { -not (Test-Out 'fake tampered') }
    Test-Check 'unreplaceable copy: says so' { Test-Err 'the copy already there does not match its pin' }
} else {
    [Console]::Out.WriteLine('note mode 555 leaves the folder writable here (root): unreplaceable copy not tested')
}

# --- 18. the stand-in release must be on this computer: a network path is refused
Initialize-Plugin 26 '1.0.0'
Write-Fake (Join-Path $REL $asset) 'v1'
Add-Pin '1.0.0' $asset (Join-Path $REL $asset)
foreach ($unc in '\\localhost\share', '//localhost/share') {
    $rc = Invoke-Run @{ Src = $unc; Data = (Join-Path $T 'data26') } @('week')
    Test-Check "network stand-in ${unc}: exit 3" { $rc -eq 3 }
    Test-Check "network stand-in ${unc}: says so" { Test-Err 'network paths are refused' }
}
Test-Check 'network stand-in: nothing saved' { -not (Test-Path -LiteralPath (Join-Path $T "data26/cache/1.0.0/$exe")) }

# --- 19. arguments reach the program unchanged: empty ones, spaces, quotes, backslashes
$rc = Invoke-Run @{ Data = (Join-Path $T 'data26') } @('args', '', 'a "b" c', 'x\', 'tail\"q')
Test-Check 'arguments: exit 0' { $rc -eq 0 }
Test-Check 'arguments: unchanged' { (Read-Text (Join-Path $T 'out')).Trim() -ceq '[args][][a "b" c][x\][tail\"q]' }

# --- 20. a lock left by a killed run is taken over, and only this run's own lock is removed
Initialize-Plugin 27 '1.0.0'
Write-Fake (Join-Path $REL $asset) 'v1'
Add-Pin '1.0.0' $asset (Join-Path $REL $asset)
$lk = Join-Path $T 'data27/cache/.lock-1.0.0'
New-Item -ItemType Directory -Force -Path $lk | Out-Null
[IO.File]::WriteAllText((Join-Path $lk 'owner'), "someone-else`n")
(Get-Item -LiteralPath $lk).LastWriteTime = (Get-Date).AddDays(-1)
$rc = Invoke-Run @{ Data = (Join-Path $T 'data27') } @('week')
Test-Check 'stale lock: taken over, runs' { Test-Out 'fake v1 week' }
Test-Check 'stale lock: no lock or work folder left' { @(Get-ChildItem -LiteralPath (Join-Path $T 'data27/cache') -Force | Where-Object { $_.Name.StartsWith('.') }).Count -eq 0 }

Remove-Item -LiteralPath $T -Recurse -Force -ErrorAction SilentlyContinue
[Console]::Out.WriteLine('')
[Console]::Out.WriteLine("$($script:passed) passed, $($script:failed) failed ($shellName)")
if ($script:failed -ne 0) { exit 1 }
exit 0
