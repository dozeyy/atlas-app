<#
.SYNOPSIS
  Prunes stale agent worktrees under .claude\worktrees that are provably safe to delete.

.DESCRIPTION
  A worktree is removed only when ALL of these hold:
    1. No file inside it was written in the last -MinAgeHours (default 48).
    2. Its HEAD commit is contained in a remote branch (after a fetch of 'backup').
    3. It is clean, OR every dirty file's current content is byte-identical (git blob
       hash) to the copy in a remote 'wip' snapshot ref for that worktree id
       (deleted files must be absent from the snapshot). Otherwise it is skipped.
  Removal uses `git worktree remove` (--force only when dirty files are proven backed up),
  then `git worktree prune`. If git reports "Filename too long", the tree is deleted
  file by file through \\?\ paths and then pruned.

  Dry run by default. Pass -Apply to delete. Never touches the main worktree or the
  hard-coded broken worktree below. Local branches are left alone.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\prune-worktrees.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\prune-worktrees.ps1 -Apply
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [int]$MinAgeHours = 48,
    [string[]]$Id,
    [string]$LogPath = (Join-Path $HOME '.claude\logs\atlas-prune-worktrees.log')
)

$ErrorActionPreference = 'Continue'
$NeverTouch = @('agent-a33e4a1e0ddfb2048')   # broken gitfile, hands off

$Root = Split-Path $PSScriptRoot -Parent
$WtRoot = (Join-Path $Root '.claude\worktrees')
Set-Location $Root

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
public static class WtScan {
    static string LP(string p) {
        if (p.StartsWith(@"\\?\")) return p;
        return @"\\?\" + p;
    }
    // Newest file write time (UTC). Stops as soon as a file newer than cutoff is seen.
    public static DateTime Newest(string root, DateTime cutoffUtc, out string newestPath) {
        DateTime max = DateTime.MinValue; newestPath = "";
        var stack = new Stack<string>();
        stack.Push(LP(root));
        while (stack.Count > 0) {
            string d = stack.Pop();
            DirectoryInfo di = new DirectoryInfo(d);
            FileSystemInfo[] items;
            try { items = di.GetFileSystemInfos(); } catch { continue; }
            foreach (var it in items) {
                bool isDir = (it.Attributes & FileAttributes.Directory) != 0;
                bool reparse = (it.Attributes & FileAttributes.ReparsePoint) != 0;
                if (isDir) { if (!reparse) stack.Push(it.FullName); continue; }
                DateTime t = it.LastWriteTimeUtc;
                if (t > max) { max = t; newestPath = it.FullName; if (max > cutoffUtc) return max; }
            }
        }
        return max;
    }
    // File-by-file delete (no recursive Directory.Delete). Returns number of failures.
    public static int DeleteTree(string root) {
        int fails = 0;
        DeleteDir(LP(root), ref fails);
        return fails;
    }
    static void DeleteDir(string d, ref int fails) {
        DirectoryInfo di = new DirectoryInfo(d);
        FileSystemInfo[] items;
        try { items = di.GetFileSystemInfos(); } catch { fails++; return; }
        foreach (var it in items) {
            bool isDir = (it.Attributes & FileAttributes.Directory) != 0;
            bool reparse = (it.Attributes & FileAttributes.ReparsePoint) != 0;
            try {
                if (isDir && !reparse) { DeleteDir(it.FullName, ref fails); }
                else if (isDir) { Directory.Delete(it.FullName, false); }   // junction: removes the link only
                else { File.SetAttributes(it.FullName, FileAttributes.Normal); File.Delete(it.FullName); }
            } catch { fails++; }
        }
        try { File.SetAttributes(d, FileAttributes.Normal); Directory.Delete(d, false); } catch { fails++; }
    }
}
'@

New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null
$mode = if ($Apply) { 'APPLY' } else { 'DRY-RUN' }
function Log([string]$m) {
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $mode, $m
    Add-Content -Path $LogPath -Value $line
    Write-Host $line
}

Log "start. root=$Root minAgeHours=$MinAgeHours"
& git fetch backup --quiet 2>$null
if ($LASTEXITCODE -ne 0) { Log "WARN: git fetch backup failed; using existing remote refs" }

# --- enumerate worktrees (git-listed only) ---
$list = & git worktree list --porcelain
$wts = @(); $cur = $null
foreach ($l in $list) {
    if ($l -like 'worktree *') { if ($cur) { $wts += $cur }; $cur = @{ Path = ($l.Substring(9) -replace '/', '\'); Locked = $false; Prunable = $false } }
    elseif ($l -like 'locked*') { $cur.Locked = $true }
    elseif ($l -like 'prunable*') { $cur.Prunable = $true }
}
if ($cur) { $wts += $cur }
$wts = $wts | Where-Object { $_.Path.StartsWith($WtRoot, [StringComparison]::OrdinalIgnoreCase) -and $_.Path.Length -gt $WtRoot.Length }
if ($Id) { $wts = $wts | Where-Object { $p = $_.Path; $Id | Where-Object { $p -like "*$_" } } }

$cutoff = (Get-Date).ToUniversalTime().AddHours(-$MinAgeHours)
$wipRefs = @(& git for-each-ref --format='%(refname)' refs/remotes | Where-Object { $_ -match 'wip' })
$rows = @()

foreach ($w in $wts) {
    $name = Split-Path $w.Path -Leaf
    $row = [ordered]@{ Worktree = $name; Newest = ''; AgeOK = ''; OnRemote = ''; Dirty = ''; Backed = ''; Decision = '' }
    $skip = @()

    if ($NeverTouch -contains $name) { $row.Decision = 'SKIP never-touch'; $rows += [pscustomobject]$row; continue }
    if ($w.Locked)   { $skip += 'locked' }
    if ($w.Prunable) { $skip += 'missing-dir' }
    if (-not (Test-Path -LiteralPath $w.Path)) { $row.Decision = 'SKIP ' + ($skip + 'no-dir' -join ','); $rows += [pscustomobject]$row; continue }

    # 1. age
    $np = ''
    $newest = [WtScan]::Newest($w.Path, $cutoff, [ref]$np)
    $row.Newest = $newest.ToLocalTime().ToString('MM-dd HH:mm')
    $ageOk = ($newest -le $cutoff)
    $row.AgeOK = if ($ageOk) { 'yes' } else { 'NO' }
    if (-not $ageOk) { $skip += 'recent-write' }

    Push-Location $w.Path
    try {
        # 2. HEAD on a remote
        $head = (& git rev-parse HEAD) 2>$null
        $remote = @(& git branch -r --contains $head 2>$null)
        $onRemote = ($LASTEXITCODE -eq 0 -and $remote.Count -gt 0)
        $row.OnRemote = if ($onRemote) { 'yes' } else { 'NO' }
        if (-not $onRemote) { $skip += 'head-not-on-remote' }

        # 3. clean, or every dirty file matches a remote wip snapshot
        $raw = & git status --porcelain=v1 -z --untracked-files=all
        if ($LASTEXITCODE -ne 0) {
            $row.Dirty = '?'; $row.Backed = 'n/a'; $skip += 'status-failed'
            $needForce = $false
        } else {
            $s = ($raw -join "`n")
            $tok = @($s.Split([char]0) | Where-Object { $_ -ne '' })
            $paths = New-Object System.Collections.Generic.List[string]
            for ($i = 0; $i -lt $tok.Count; $i++) {
                $t = $tok[$i]; if ($t.Length -lt 4) { continue }
                $paths.Add($t.Substring(3))
                if ($t[0] -eq 'R' -or $t[0] -eq 'C') { $i++; $paths.Add($tok[$i]) }   # original path of a rename/copy
            }
            $row.Dirty = $paths.Count
            $needForce = ($paths.Count -gt 0)
            if ($paths.Count -eq 0) { $row.Backed = 'clean' }
            else {
                $wid = $name -replace '^agent-', ''
                $snaps = @($wipRefs | Where-Object { $_ -like "*wip-agent-$wid*" })
                if ($snaps.Count -eq 0) { $row.Backed = 'no snapshot'; $skip += 'dirty-no-snapshot' }
                else {
                    $backed = $false
                    foreach ($snap in $snaps) {
                        $allMatch = $true
                        foreach ($rel in $paths) {
                            $abs = Join-Path $w.Path ($rel -replace '/', '\')
                            $want = (& git rev-parse -q --verify ('{0}:{1}' -f $snap, $rel)) 2>$null
                            $inSnap = ($LASTEXITCODE -eq 0)
                            if (Test-Path -LiteralPath $abs -PathType Leaf) {
                                $have = (& git hash-object --path=$rel -- $abs) 2>$null
                                if (-not ($inSnap -and $have -and $have -eq $want)) { $allMatch = $false; break }
                            } elseif (Test-Path -LiteralPath $abs) {
                                $allMatch = $false; break               # directory / nested repo: cannot prove
                            } else {
                                if ($inSnap) { $allMatch = $false; break }   # deleted here but present in snapshot
                            }
                        }
                        if ($allMatch) { $backed = $true; $row.Backed = 'yes (' + ($snap -replace '^refs/remotes/', '') + ')'; break }
                    }
                    if (-not $backed) { $row.Backed = 'NO (mismatch)'; $skip += 'dirty-not-backed-up' }
                }
            }
        }
    } finally { Pop-Location }

    if ($skip.Count -gt 0) { $row.Decision = 'SKIP ' + ($skip -join ',') }
    else {
        if (-not $Apply) { $row.Decision = 'WOULD REMOVE' + $(if ($needForce) { ' (force, backed up)' } else { '' }) }
        else {
            $gargs = @('worktree', 'remove'); if ($needForce) { $gargs += '--force' }; $gargs += $w.Path
            $out = (& git @gargs 2>&1 | Out-String)
            $ok = ($LASTEXITCODE -eq 0) -and -not (Test-Path -LiteralPath $w.Path)
            if (-not $ok -and $out -match 'too long') {
                Log "$name : git hit 'Filename too long', deleting file by file"
                $f = [WtScan]::DeleteTree($w.Path)
                Log "$name : file-by-file delete finished, failures=$f"
                $ok = -not (Test-Path -LiteralPath $w.Path)
            }
            if ($ok) { $row.Decision = 'REMOVED' } else { $row.Decision = 'FAILED: ' + $out.Trim().Split("`n")[0] }
        }
    }
    Log ("{0} newest={1} remote={2} dirty={3} backed={4} -> {5}" -f $name, $row.Newest, $row.OnRemote, $row.Dirty, $row.Backed, $row.Decision)
    $rows += [pscustomobject]$row
}

if ($Apply) { & git worktree prune; Log "git worktree prune done" }
$rows | Format-Table -AutoSize | Out-String -Width 250 | Write-Host
$rm = @($rows | Where-Object { $_.Decision -like 'REMOVED*' -or $_.Decision -like 'WOULD REMOVE*' }).Count
Log "done. candidates/removed=$rm of $($rows.Count)"
