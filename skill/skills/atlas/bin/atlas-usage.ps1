# Atlas launcher for PowerShell (Windows PowerShell 5.1, and pwsh 7 on Windows, macOS and Linux):
# finds or fetches the atlas-usage program, then runs it with the arguments unchanged. It works the
# same way as atlas-usage.sh next to it: same order, messages, exit codes and saved-copy folders.
#   usage: atlas-usage.ps1 <atlas-usage arguments>
#          atlas-usage.ps1 launcher-doctor   says which copy it would run and why; runs nothing
# Order: (0) $env:ATLAS_USAGE_BIN, (a) atlas-usage on PATH, (b) a copy cached under
# <data>\cache\<plugin version>\, (c) the Atlas app's copy, (d) download tag v<plugin version> of
# dozeyy/atlas, (e) only if that download fails: the newest older saved copy, then an older copy
# passed over in (a) or (c).
# <data> = $env:CLAUDE_PLUGIN_DATA when the shell has it, else a per-user cache folder
# (%LOCALAPPDATA%\atlas\skill, ~/Library/Caches/atlas/skill, ${XDG_CACHE_HOME:-~/.cache}/atlas/skill),
# else this script's own folder.
# A file sitting loose next to this script is never run: only PATH, the app and the verified cache.
# A copy on PATH or in the app whose SHA-256 is the pinned build of an OLDER plugin version is passed
# over (and kept as the last resort). Copies with hashes not in checksums.txt (your own builds) run.
# Trust: a download is run ONLY if its SHA-256 equals the line "<version> <asset> <sha256>" in
# checksums.txt next to this script (pinned when the plugin was released), and a saved copy is checked
# against the same line each time it runs. What the release says can only add a refusal. No pinned
# line = no download. Old lines stay in checksums.txt on purpose: they name old builds.
# Signature: on a download the release's SHA256SUMS.txt and SHA256SUMS.txt.sig are fetched too. The
# signature must be made by the Atlas update key below (checked by a small Ed25519 + BLAKE2b-512
# verifier compiled here, no packages) and the list must give the program the pinned hash, or the
# download is deleted. Only the "ED" form (Ed25519 over the file's BLAKE2b-512) is accepted. If the
# verifier cannot be compiled, the pin alone decides, quietly; launcher-doctor says which.
# A saved copy that cannot be read to hash it is never run: it is deleted and fetched again.
# Without a pinned line for this version, no saved copy is run at all.
# Arguments reach the program unchanged, empty ones and embedded quotes too (PowerShell before 7.3
# mangles those, so there the program is started directly with each argument quoted).
# Exit code 3 = the launcher itself failed (one plain line on stderr); 4 = the program found is too old
# for repeats / offer-note / debrief.
# ATLAS_USAGE_BIN = a program file to run instead of searching (no checksum check: your choice).
# ATLAS_USAGE_LAUNCHER_VERBOSE=1 names the copy used.
# Test aid: ATLAS_USAGE_TEST_SOURCE = a local folder, or an http://127.0.0.1 / localhost
# address, that stands in for the release (the pinned hash still applies). A network path
# (\\host\share, //host, a mapped network drive) is refused: the stand-in must be on this computer.
# Only together with it,
# ATLAS_USAGE_TEST_PUBKEY replaces the update key, so tests can sign their own files. That grants
# nothing: the stand-in release is local, its files must still match the pins, and whoever can set
# these variables can already set ATLAS_USAGE_BIN. Downloads from GitHub always use the real key.

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Repo = 'dozeyy/atlas'
$Update = '/plugin marketplace update atlas'
# plugins.updater.pubkey in crates/app/tauri.conf.json: the key that signs every release's SHA256SUMS.txt.
$PubKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ0NDgzQzI2NTdDMTIyM0QKUldROUlzRlhKanhJUk5WZE1acm5keEtUYm1wUnRoQ0thcVREQXlqZGVhdzVxdXNWaXZuTnhTZ0QK'
$rest = @($args)

function Exit-Launcher([string]$msg) {
    [Console]::Error.WriteLine("atlas-usage: $msg")
    exit 3
}
function Write-Note([string]$msg) { [Console]::Error.WriteLine("atlas-usage: $msg") }
function Write-Verbose2([string]$a, [string]$b) {
    if ($env:ATLAS_USAGE_LAUNCHER_VERBOSE) { [Console]::Error.WriteLine("atlas-usage launcher: $a $b") }
}

$doctor = ($rest.Count -gt 0 -and [string]$rest[0] -ceq 'launcher-doctor')
function Write-Report([string]$label, [string]$text) { # launcher-doctor lines, on stdout
    if ($doctor) { [Console]::Out.WriteLine(('{0,-15} {1}' -f $label, $text)) }
}

# Strictly http://127.0.0.1 or http://localhost, optional :port, then / or the end.
function Test-Loopback([string]$u) { return ($u -cmatch '^http://(127\.0\.0\.1|localhost)(:[0-9]+)?(/|$)') }

# The SHA-256 of a file, kept for the last file asked about (the chosen copy is hashed once).
$script:memoPath = $null
$script:memoHash = ''
function Get-Hash([string]$path) {
    if ($path -ne $script:memoPath) {
        $script:memoPath = $path
        $script:memoHash = ''
        try { $script:memoHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() } catch { $script:memoHash = '' }
    }
    return $script:memoHash
}

# True when version $a is strictly older than $b. Only the numeric dotted start counts
# ("0.2.0-beta" -> 0.2.0); a name without one is "not older", so it is never pruned.
function Test-VersionOlder([string]$a, [string]$b) {
    if ($a -notmatch '^([0-9]+(\.[0-9]+)*)') { return $false }
    $ca = $Matches[1].Split('.')
    if ($b -notmatch '^([0-9]+(\.[0-9]+)*)') { return $false }
    $cb = $Matches[1].Split('.')
    $n = [Math]::Max($ca.Count, $cb.Count)
    for ($i = 0; $i -lt $n; $i++) {
        $x = [decimal]0; $y = [decimal]0
        if ($i -lt $ca.Count) { $x = [decimal]$ca[$i] }
        if ($i -lt $cb.Count) { $y = [decimal]$cb[$i] }
        if ($x -lt $y) { return $true }
        if ($x -gt $y) { return $false }
    }
    return $false
}

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { Exit-Launcher 'cannot find the skill folder.' }
$pins = Join-Path $scriptDir 'checksums.txt'

# Pinned lines: "<version> <asset> <sha256>", tolerant of a BOM and CRLF.
$pinLines = @()
if (Test-Path -LiteralPath $pins -PathType Leaf) {
    foreach ($line in [IO.File]::ReadAllLines($pins)) {
        $f = @($line.TrimStart([char]0xFEFF) -split '\s+' | Where-Object { $_ })
        if ($f.Count -ge 3) { $pinLines += , $f }
    }
}
function Get-Pin([string]$ver, [string]$name) { # -> its sha256 (lowercase), or ''
    foreach ($f in $pinLines) {
        if ([string]$f[0] -ceq $ver -and [string]$f[1] -ceq $name -and $f[2] -match '^[0-9A-Fa-f]{64}$') { return $f[2].ToLowerInvariant() }
    }
    return ''
}
function Get-PinVersion([string]$hash) { # sha256 -> the plugin version whose pinned build has that hash, or ''
    if (-not $hash) { return '' }
    foreach ($f in $pinLines) {
        if ($f[0] -match '^[0-9]' -and $f[2].ToLowerInvariant() -ceq $hash) { return [string]$f[0] }
    }
    return ''
}
function Test-AnyPin([string]$ver) { # true when any build of that version is pinned
    foreach ($f in $pinLines) { if ([string]$f[0] -ceq $ver -and $f[2].Length -eq 64) { return $true } }
    return $false
}

# The plugin version (= the release tag without its v), read from the plugin's own manifest.
# Anything that is not digits, letters, dot, dash or underscore, starting with a digit, is no version.
$version = ''
try {
    $pj = Join-Path $scriptDir (Join-Path '..' (Join-Path '..' (Join-Path '..' (Join-Path '.claude-plugin' 'plugin.json'))))
    if (Test-Path -LiteralPath $pj -PathType Leaf) {
        foreach ($line in [IO.File]::ReadAllLines($pj)) {
            if ($line -match '"version"\s*:\s*"([^"]*)"') {
                $candidate = [string]$Matches[1]
                if ($candidate -cmatch '^[0-9][A-Za-z0-9._-]*$') { $version = $candidate }
                break
            }
        }
    }
} catch { $version = '' }

$onWindows = ($PSVersionTable.PSEdition -ne 'Core') -or $IsWindows
$onMac = (-not $onWindows) -and $IsMacOS
$onLinux = (-not $onWindows) -and $IsLinux
if ($onWindows) { $exe = 'atlas-usage.exe' } else { $exe = 'atlas-usage' }

function Test-Musl {
    if (@(Get-ChildItem -Path '/lib' -Filter 'ld-musl-*.so.1' -ErrorAction SilentlyContinue).Count -gt 0) { return $true }
    try { return [bool]((& ldd --version 2>&1 | Out-String) -match 'musl') } catch { return $false }
}

# Which release file fits this computer.
$asset = ''
$platform = 'this computer'
if ($onWindows) {
    $asset = 'atlas-usage-windows-x64.exe'; $platform = 'Windows x64'
    $pa = $env:PROCESSOR_ARCHITEW6432
    if (-not $pa) { $pa = $env:PROCESSOR_ARCHITECTURE }
    if ($pa -eq 'ARM64') {
        # A native build when this version has one; else the x64 build, which Windows on ARM runs emulated.
        if ($version -and (Get-Pin $version 'atlas-usage-windows-arm64.exe')) {
            $asset = 'atlas-usage-windows-arm64.exe'; $platform = 'Windows ARM64'
        } else {
            $platform = 'Windows ARM64 (x64 build, emulated)'
        }
    }
} elseif ($onMac) {
    $asset = 'atlas-usage-macos-universal'; $platform = 'macOS'
} else {
    $arch = ''
    try { $arch = [string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture } catch { $arch = '' }
    $la = ''
    if ($arch -eq 'X64') { $la = 'x64' } elseif ($arch -eq 'Arm64') { $la = 'arm64' }
    if ($onLinux) { $platform = ('Linux ' + $arch.ToLowerInvariant()).Trim() } else { $platform = ('this system ' + $arch.ToLowerInvariant()).Trim() }
    if ($onLinux -and $la) {
        $asset = "atlas-usage-linux-$la"; $platform = "Linux $la"
        if (Test-Musl) { $asset = "$asset-musl"; $platform = "Linux $la (musl)" }
    }
}
$want = ''
if ($version -and $asset) { $want = Get-Pin $version $asset }

# The stand-in release (tests only), and the key its signature must come from.
# A network share is not on this computer: refused before anything touches it.
function Test-NetworkPath([string]$p) {
    if ($p.StartsWith('\\') -or $p.StartsWith('//')) { return $true }
    if ($onWindows) {
        try {
            $full = [IO.Path]::GetFullPath($p)
            if ($full.StartsWith('\\')) { return $true }
            $root = [IO.Path]::GetPathRoot($full)
            if ($root -and (New-Object IO.DriveInfo $root).DriveType -eq [IO.DriveType]::Network) { return $true }
        } catch { return $true }
    }
    return $false
}
$src = $env:ATLAS_USAGE_TEST_SOURCE
$srcIsDir = $false
$srcIsLoopback = $false
if ($src) {
    if (Test-Loopback $src) { $srcIsLoopback = $true }
    elseif (-not (Test-NetworkPath $src) -and (Test-Path -LiteralPath $src -PathType Container)) { $srcIsDir = $true }
    if (-not ($srcIsDir -or $srcIsLoopback)) {
        Exit-Launcher "ATLAS_USAGE_TEST_SOURCE ($src) must be a folder on this computer or an http://127.0.0.1 or http://localhost address; network paths are refused. Fix it or unset it."
    }
}
$pubKey = $PubKey
$keyName = 'the Atlas release key'
if (($srcIsDir -or $srcIsLoopback) -and $env:ATLAS_USAGE_TEST_PUBKEY) {
    $pubKey = $env:ATLAS_USAGE_TEST_PUBKEY; $keyName = 'the test key in ATLAS_USAGE_TEST_PUBKEY'
}

# Where saved copies live.
$binDir = $env:CLAUDE_PLUGIN_DATA
if (-not $binDir) {
    $binDir = ''
    if ($onMac) {
        if ($env:HOME) { $binDir = Join-Path $env:HOME 'Library/Caches/atlas/skill' }
    } elseif ($onLinux) {
        $xbase = $env:XDG_CACHE_HOME
        if (-not ($xbase -and $xbase.StartsWith('/'))) { $xbase = '' }
        if (-not $xbase -and $env:HOME) { $xbase = Join-Path $env:HOME '.cache' }
        if ($xbase) { $binDir = Join-Path $xbase 'atlas/skill' }
    } elseif ($onWindows -and $env:LOCALAPPDATA) {
        $binDir = Join-Path $env:LOCALAPPDATA 'atlas\skill'
    }
    if ($binDir) {
        try { New-Item -ItemType Directory -Force -Path $binDir -ErrorAction Stop | Out-Null } catch { $binDir = '' }
    }
    if (-not $binDir) { $binDir = $scriptDir }
}
$cacheRoot = Join-Path $binDir 'cache'
$verDir = ''
$cached = ''
if ($version) {
    $verDir = Join-Path $cacheRoot $version
    $cached = Join-Path $verDir $exe
}

# --- Signature check (minisign / Tauri "ED" form), the same steps as tools/verify-minisign.mjs.
# Ed25519 (RFC 8032, cofactorless) and BLAKE2b-512 (RFC 7693) in plain C#: no packages, no network.
$VerifierSource = @'
using System;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

public static class AtlasMinisign {
    static readonly BigInteger P = BigInteger.Pow(2, 255) - 19;
    static readonly BigInteger L = BigInteger.Pow(2, 252) + BigInteger.Parse("27742317777372353535851937790883648493");
    static readonly BigInteger D;
    static readonly BigInteger SqrtM1;
    static readonly BigInteger[] Base;

    static AtlasMinisign() {
        D = Mod(new BigInteger(-121665) * Inv(new BigInteger(121666)));
        SqrtM1 = BigInteger.ModPow(2, (P - 1) / 4, P);
        BigInteger by = Mod(4 * Inv(5));
        BigInteger bx = RecoverX(by, 0);
        Base = new BigInteger[] { bx, by, BigInteger.One, Mod(bx * by) };
    }

    static BigInteger Mod(BigInteger a) { a = BigInteger.Remainder(a, P); return a.Sign < 0 ? a + P : a; }
    static BigInteger Inv(BigInteger a) { return BigInteger.ModPow(Mod(a), P - 2, P); }

    static BigInteger RecoverX(BigInteger y, int sign) { // -1 when there is no such point
        if (y >= P) return BigInteger.MinusOne;
        BigInteger x2 = Mod((y * y - 1) * Inv(D * y * y + 1));
        if (x2.IsZero) return sign == 1 ? BigInteger.MinusOne : BigInteger.Zero;
        BigInteger x = BigInteger.ModPow(x2, (P + 3) / 8, P);
        if (!Mod(x * x - x2).IsZero) x = Mod(x * SqrtM1);
        if (!Mod(x * x - x2).IsZero) return BigInteger.MinusOne;
        if ((x.IsEven ? 0 : 1) != sign) x = P - x;
        return x;
    }

    static BigInteger[] Add(BigInteger[] p, BigInteger[] q) { // extended coordinates
        BigInteger a = Mod((p[1] - p[0]) * (q[1] - q[0]));
        BigInteger b = Mod((p[1] + p[0]) * (q[1] + q[0]));
        BigInteger c = Mod(2 * p[3] * q[3] * D);
        BigInteger d = Mod(2 * p[2] * q[2]);
        BigInteger e = b - a, f = d - c, g = d + c, h = b + a;
        return new BigInteger[] { Mod(e * f), Mod(g * h), Mod(f * g), Mod(e * h) };
    }

    static BigInteger[] Mul(BigInteger s, BigInteger[] p) {
        BigInteger[] q = new BigInteger[] { BigInteger.Zero, BigInteger.One, BigInteger.One, BigInteger.Zero };
        while (s.Sign > 0) {
            if (!s.IsEven) q = Add(q, p);
            p = Add(p, p);
            s >>= 1;
        }
        return q;
    }

    static bool SamePoint(BigInteger[] p, BigInteger[] q) {
        return Mod(p[0] * q[2] - q[0] * p[2]).IsZero && Mod(p[1] * q[2] - q[1] * p[2]).IsZero;
    }

    static BigInteger FromLE(byte[] b, int off, int len) {
        byte[] t = new byte[len + 1]; // the extra zero byte keeps it positive
        Array.Copy(b, off, t, 0, len);
        return new BigInteger(t);
    }

    static BigInteger[] Decode(byte[] b, int off) {
        byte[] t = new byte[33];
        Array.Copy(b, off, t, 0, 32);
        int sign = t[31] >> 7;
        t[31] &= 0x7f;
        BigInteger y = new BigInteger(t);
        BigInteger x = RecoverX(y, sign);
        if (x.Sign < 0) return null;
        return new BigInteger[] { x, y, BigInteger.One, Mod(x * y) };
    }

    public static bool Ed25519(byte[] pub, byte[] msg, byte[] sig) {
        if (pub == null || sig == null || msg == null || pub.Length != 32 || sig.Length != 64) return false;
        BigInteger[] a = Decode(pub, 0);
        if (a == null) return false;
        BigInteger[] r = Decode(sig, 0);
        if (r == null) return false;
        BigInteger s = FromLE(sig, 32, 32);
        if (s >= L) return false;
        byte[] h;
        using (SHA512 sha = SHA512.Create()) {
            byte[] buf = new byte[64 + msg.Length];
            Array.Copy(sig, 0, buf, 0, 32);
            Array.Copy(pub, 0, buf, 32, 32);
            Array.Copy(msg, 0, buf, 64, msg.Length);
            h = sha.ComputeHash(buf);
        }
        BigInteger k = BigInteger.Remainder(FromLE(h, 0, 64), L);
        return SamePoint(Mul(s, Base), Add(r, Mul(k, a)));
    }

    static readonly ulong[] IV = {
        0x6a09e667f3bcc908UL, 0xbb67ae8584caa73bUL, 0x3c6ef372fe94f82bUL, 0xa54ff53a5f1d36f1UL,
        0x510e527fade682d1UL, 0x9b05688c2b3e6c1fUL, 0x1f83d9abfb41bd6bUL, 0x5be0cd19137e2179UL };
    static readonly byte[][] Sigma = {
        new byte[] { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 },
        new byte[] { 14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3 },
        new byte[] { 11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4 },
        new byte[] { 7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8 },
        new byte[] { 9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13 },
        new byte[] { 2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9 },
        new byte[] { 12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11 },
        new byte[] { 13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10 },
        new byte[] { 6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5 },
        new byte[] { 10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0 } };

    static ulong Rotr(ulong x, int n) { return (x >> n) | (x << (64 - n)); }

    static void G(ulong[] v, int a, int b, int c, int d, ulong x, ulong y) {
        v[a] = v[a] + v[b] + x; v[d] = Rotr(v[d] ^ v[a], 32);
        v[c] = v[c] + v[d];     v[b] = Rotr(v[b] ^ v[c], 24);
        v[a] = v[a] + v[b] + y; v[d] = Rotr(v[d] ^ v[a], 16);
        v[c] = v[c] + v[d];     v[b] = Rotr(v[b] ^ v[c], 63);
    }

    static ulong ReadLE(byte[] b, int off) {
        ulong r = 0;
        for (int i = 7; i >= 0; i--) r = (r << 8) | b[off + i];
        return r;
    }

    static void Compress(ulong[] h, byte[] block, ulong t, bool last) {
        ulong[] m = new ulong[16];
        for (int i = 0; i < 16; i++) m[i] = ReadLE(block, i * 8);
        ulong[] v = new ulong[16];
        for (int i = 0; i < 8; i++) { v[i] = h[i]; v[i + 8] = IV[i]; }
        v[12] ^= t;
        if (last) v[14] = ~v[14];
        for (int r = 0; r < 12; r++) {
            byte[] s = Sigma[r % 10];
            G(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
            G(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
            G(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
            G(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
            G(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
            G(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
            G(v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
            G(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
        }
        for (int i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
    }

    public static byte[] Blake2b512(byte[] data) {
        ulong[] h = (ulong[])IV.Clone();
        h[0] ^= 0x01010040UL; // 64-byte digest, no key
        byte[] block = new byte[128];
        ulong t = 0;
        int off = 0;
        while (data.Length - off > 128) {
            Array.Copy(data, off, block, 0, 128);
            t += 128;
            Compress(h, block, t, false);
            off += 128;
        }
        Array.Clear(block, 0, 128);
        int rem = data.Length - off;
        Array.Copy(data, off, block, 0, rem);
        t += (ulong)rem;
        Compress(h, block, t, true);
        byte[] outb = new byte[64];
        for (int i = 0; i < 8; i++)
            for (int j = 0; j < 8; j++) outb[i * 8 + j] = (byte)(h[i] >> (8 * j));
        return outb;
    }

    static string[] Lines(string b64) {
        string text = Encoding.UTF8.GetString(Convert.FromBase64String(b64.Trim()));
        string[] lines = text.Split('\n');
        for (int i = 0; i < lines.Length; i++) lines[i] = lines[i].TrimEnd('\r');
        return lines;
    }

    static bool Same(byte[] a, int ao, byte[] b, int bo, int n) {
        for (int i = 0; i < n; i++) if (a[ao + i] != b[bo + i]) return false;
        return true;
    }

    // "" when the signature file is a good signature of data by the key, and its trusted comment
    // carries a good signature too; otherwise why not.
    public static string Verify(string pubB64, byte[] data, string sigFileText) {
        byte[] raw, sig, glob;
        string[] sl;
        try {
            string[] pl = Lines(pubB64);
            if (pl.Length < 2) return "the public key is not a minisign key";
            raw = Convert.FromBase64String(pl[1].Trim());
        } catch (Exception) { return "cannot read the public key"; }
        if (raw.Length != 42 || raw[0] != (byte)'E' || raw[1] != (byte)'d') return "the public key is not a minisign Ed25519 key";
        byte[] pk = new byte[32];
        Array.Copy(raw, 10, pk, 0, 32);
        try {
            sl = Lines(sigFileText);
            if (sl.Length < 2) return "cannot read the signature file";
            sig = Convert.FromBase64String(sl[1].Trim());
        } catch (Exception) { return "cannot read the signature file"; }
        if (sig.Length != 74) return "the signature has the wrong length";
        // Only "ED" (prehashed with BLAKE2b-512); the legacy unhashed "Ed" form is refused.
        if (sig[0] != (byte)'E' || sig[1] != (byte)'D') return "not an ED (prehashed) signature";
        if (!Same(sig, 2, raw, 2, 8)) return "the signature was made by a different key";
        byte[] s64 = new byte[64];
        Array.Copy(sig, 10, s64, 0, 64);
        byte[] signedData = Blake2b512(data);
        if (!Ed25519(pk, signedData, s64)) return "the signature does not match this file";
        string tc = sl.Length > 2 ? sl[2] : "";
        const string prefix = "trusted comment: ";
        if (!tc.StartsWith(prefix, StringComparison.Ordinal)) return "no trusted comment";
        try { glob = Convert.FromBase64String(sl.Length > 3 ? sl[3].Trim() : ""); } catch (Exception) { return "bad global signature"; }
        if (glob.Length != 64) return "the global signature has the wrong length";
        byte[] tcb = Encoding.UTF8.GetBytes(tc.Substring(prefix.Length));
        byte[] gmsg = new byte[64 + tcb.Length];
        Array.Copy(s64, 0, gmsg, 0, 64);
        Array.Copy(tcb, 0, gmsg, 64, tcb.Length);
        if (!Ed25519(pk, gmsg, glob)) return "the trusted comment signature is not valid";
        return "";
    }
}
'@

# True when the verifier compiled here (it then stays loaded for this run).
function Test-Verifier {
    if ('AtlasMinisign' -as [type]) { return $true }
    try {
        if ($PSVersionTable.PSEdition -eq 'Core') {
            Add-Type -TypeDefinition $VerifierSource -Language CSharp -ErrorAction Stop
        } else {
            Add-Type -TypeDefinition $VerifierSource -Language CSharp -ReferencedAssemblies 'System.Numerics' -ErrorAction Stop
        }
        return [bool]('AtlasMinisign' -as [type])
    } catch { return $false }
}

# True when SHA256SUMS.txt names the asset, and every line naming it gives the pinned hash.
function Test-SumsListPin([string]$sumsPath, [string]$name, [string]$hash) {
    $seen = $false
    foreach ($line in [IO.File]::ReadAllLines($sumsPath)) {
        $f = @($line -split '\s+' | Where-Object { $_ })
        if ($f.Count -lt 2) { continue }
        $n = [string]$f[1]
        if ($n.StartsWith('*')) { $n = $n.Substring(1) }
        if ($n -ceq $name) {
            $seen = $true
            if ($f[0].ToLowerInvariant() -cne $hash) { return $false }
        }
    }
    return $seen
}

if ($doctor) {
    [Console]::Out.WriteLine('Atlas launcher check (runs nothing, downloads nothing)')
    $pv = $version
    if (-not $pv) { $pv = 'no version (installed by hand?)' }
    Write-Report 'plugin' $pv
    Write-Report 'computer' $platform
    if (-not $asset) { Write-Report 'build' 'none made for this computer' }
    elseif ($want) { Write-Report 'build' "$asset, pinned" }
    elseif ($version) { Write-Report 'build' "$asset, not pinned for $version" }
    else { Write-Report 'build' "$asset, not pinned for this copy" }
    Write-Report 'saved in' $cacheRoot
    $dl = @()
    if ($onWindows) { $curlName = 'curl.exe' } else { $curlName = 'curl' }
    if (Get-Command $curlName -CommandType Application -ErrorAction SilentlyContinue) { $dl += 'curl' }
    $dl += 'PowerShell'
    if (Get-Command gh -CommandType Application -ErrorAction SilentlyContinue) { $dl += 'gh' }
    Write-Report 'download' (($dl -join ', ') + '; checksum with PowerShell')
    if (Test-Verifier) {
        Write-Report 'signature' "checked on download with the built-in verifier, against $keyName"
    } else {
        Write-Report 'signature' 'NOT checked on this computer (the built-in verifier could not be compiled here). The pinned checksum still applies.'
    }
}
function Write-SavedSignature { # how the saved copy in the version folder was checked when it was saved
    $state = ''
    try { $state = ([IO.File]::ReadAllText((Join-Path $verDir 'signature'))).Trim() } catch { $state = '' }
    if ($state -ceq 'checked') { Write-Report '  signature' 'checked when it was saved' }
    elseif ($state -ceq 'unchecked') { Write-Report '  signature' 'not checked when it was saved (no Ed25519 check then); pinned checksum only' }
    else { Write-Report '  signature' 'not recorded (saved by an older launcher); pinned checksum only' }
}

# The repeated-request and debrief commands need a program that knows them: an older copy would read
# "repeats" as something else and answer with nothing useful, so it is refused here with one plain
# line (exit code 4). A copy that passed is remembered by its hash, so it is asked only once.
function Invoke-Program([string]$path) {
    $need = ''; $word = ''; $what = ''
    if ($rest.Count -gt 0) {
        $first = [string]$rest[0]
        if ($first -ceq 'repeats' -or $first -ceq 'offer-note') { $need = 'repeats'; $word = 'offer-note'; $what = 'repeated requests' }
        elseif ($first -ceq 'debrief') { $need = 'debrief'; $word = 'helpers did'; $what = 'the debrief' }
    }
    if ($need) {
        $h = Get-Hash $path
        $mark = ''
        if ($h) { $mark = Join-Path (Join-Path $cacheRoot 'caps') "$h.$need" }
        if (-not ($mark -and (Test-Path -LiteralPath $mark -PathType Leaf))) {
            $probe = & $path $need --help 2>$null | Out-String
            if (-not $probe.Contains($word)) {
                [Console]::Error.WriteLine("atlas-usage: this copy of atlas-usage ($path) is too old for $what. Update the Atlas plugin ($Update) or the Atlas app.")
                exit 4
            }
            if ($mark) {
                try {
                    New-Item -ItemType Directory -Force -Path (Join-Path $cacheRoot 'caps') -ErrorAction Stop | Out-Null
                    [IO.File]::WriteAllText($mark, '')
                } catch { $mark = '' }
            }
        }
    }
    if ($PSVersionTable.PSVersion -ge [version]'7.3') {
        try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { $null = $_ } # bars are UTF-8
        & $path @rest
        exit $LASTEXITCODE
    }
    # Older PowerShell drops empty arguments and passes embedded quotes unescaped: start the program
    # directly instead. It shares this console and these stdin/stdout/stderr handles, so its output
    # goes out byte for byte.
    $psi = New-Object Diagnostics.ProcessStartInfo $path
    $psi.UseShellExecute = $false
    $psi.Arguments = ConvertTo-CommandLine $rest
    $proc = [Diagnostics.Process]::Start($psi)
    $proc.WaitForExit()
    exit $proc.ExitCode
}

# One command line from separate arguments, quoted the way Windows programs split them again
# (CommandLineToArgvW / the C runtime): backslashes count only before a quote.
function ConvertTo-CommandLine([string[]]$list) {
    $parts = foreach ($a in $list) {
        if ($a.Length -gt 0 -and $a -notmatch '[\s"]') { $a; continue }
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
        $sb.ToString()
    }
    return ($parts -join ' ')
}

function Select-Program([string]$path, [string]$label) { # the copy to run (launcher-doctor stops here)
    if ($doctor) {
        Write-Report 'would run' "$label $path"
        exit 0
    }
    Write-Verbose2 $label $path
}

# A copy found on PATH or in the app is passed over when its hash is the pinned build of an
# older plugin version. The first one passed over is kept for the case the download fails.
$script:stale = ''
$script:staleVer = ''
function Test-CurrentEnough([string]$path, [string]$label) {
    $old = ''
    if ($version) {
        $h = Get-Hash $path
        if ($h) { $old = Get-PinVersion $h }
    }
    if ($old -and (Test-VersionOlder $old $version)) {
        Write-Verbose2 'passed over:' "$path (release $old, older than $version)"
        Write-Report $label "$path (release $old, older than ${version}: passed over)"
        if (-not $script:stale) { $script:stale = $path; $script:staleVer = $old }
        return $false
    }
    Write-Report $label $path
    return $true
}

# A saved copy runs only if it still matches its pin; one that does not is deleted.
function Test-CacheOk([string]$path) {
    # No pin for this version (checksums.txt missing, cut short or without this line): nothing was
    # downloaded without one, so whatever is in the folder is not run.
    if (-not $want) {
        if ($doctor) { Write-Report 'saved copy' "$path (not run: v$version has no pinned checksum to check it against)" }
        return $false
    }
    $h = Get-Hash $path
    if ($h -and $h -ceq $want) { return $true }
    # Changed, or not readable (no read permission, locked by another program): never run it.
    if ($h) { $why = 'did not match the checksum pinned in this plugin' } else { $why = 'could not be read to check it' }
    if ($doctor) {
        Write-Report 'saved copy' "$path ($why; it would be fetched again)"
        return $false
    }
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    $script:memoPath = $null
    Write-Note "the saved copy of the program $why, so it was deleted. Fetching it again."
    return $false
}

# (0) a file named by the user
if ($env:ATLAS_USAGE_BIN) {
    if (-not (Test-Path -LiteralPath $env:ATLAS_USAGE_BIN -PathType Leaf)) {
        Exit-Launcher "ATLAS_USAGE_BIN is set to $($env:ATLAS_USAGE_BIN), which is not a file. Fix it or unset it."
    }
    Select-Program $env:ATLAS_USAGE_BIN 'ATLAS_USAGE_BIN:'
    Invoke-Program $env:ATLAS_USAGE_BIN
}

# (a) on PATH
$onPath = Get-Command atlas-usage -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($onPath -and (Test-Path -LiteralPath $onPath.Source -PathType Leaf)) {
    if (Test-CurrentEnough $onPath.Source 'PATH') {
        Select-Program $onPath.Source 'PATH:'
        Invoke-Program $onPath.Source
    }
} else {
    Write-Report 'PATH' 'no atlas-usage'
}

# (b) cached copy, keyed by the plugin version
if ($cached -and (Test-Path -LiteralPath $cached -PathType Leaf) -and (Test-CacheOk $cached)) {
    Write-Report 'saved copy' "$cached (matches its pin)"
    if ($doctor) { Write-SavedSignature }
    Select-Program $cached 'cache:'
    Invoke-Program $cached
}
if ($cached -and -not (Test-Path -LiteralPath $cached -PathType Leaf)) { Write-Report 'saved copy' "none for $version" }

# (c) the Atlas app's copy: Windows per-user and machine-wide installs, the Mac app bundle
$apps = @()
if ($onWindows) {
    foreach ($wd in @($env:LOCALAPPDATA, $env:ProgramW6432, $env:ProgramFiles)) {
        if ($wd) {
            $ap = Join-Path (Join-Path $wd 'Atlas') $exe
            if ($apps -notcontains $ap) { $apps += $ap }
        }
    }
} elseif ($onMac) {
    $apps += "/Applications/Atlas.app/Contents/MacOS/$exe"
    if ($env:HOME) { $apps += (Join-Path $env:HOME "Applications/Atlas.app/Contents/MacOS/$exe") }
}
$foundApp = $false
foreach ($ap in $apps) {
    if (-not (Test-Path -LiteralPath $ap -PathType Leaf)) { continue }
    $foundApp = $true
    if (Test-CurrentEnough $ap 'Atlas app') {
        Select-Program $ap 'Atlas app:'
        Invoke-Program $ap
    }
}
if (-not $foundApp) { Write-Report 'Atlas app' 'not found' }

# (d) download, verify against the pinned hash, cache
$Hint = "Install the Atlas app from github.com/$Repo/releases, or put atlas-usage on PATH."
if ($doctor) {
    if (-not $asset) { Write-Report 'would run' "nothing: there is no ready-made build for $platform" }
    elseif (-not $version) { Write-Report 'would run' 'nothing: this copy of the skill has no version' }
    elseif (-not $want) { Write-Report 'would run' "nothing: v$version has no pinned build for $platform" }
    else { Write-Report 'would run' "a one-time download of v$version ($asset), checked against its pin" }
    if ($script:stale) { Write-Report 'if offline' "$($script:stale) (release $($script:staleVer))" }
    exit 0
}

if (-not $asset) { Exit-Launcher "there is no ready-made build for $platform yet. Download a build from github.com/$Repo/releases or install the Atlas app." }
if (-not $version) { Exit-Launcher "this copy of the skill has no version, so it cannot fetch the program. Put atlas-usage on PATH, or install the plugin: /plugin marketplace add $Repo" }
if (-not $want) {
    if (Test-AnyPin $version) {
        Exit-Launcher "there is no ready-made build for $platform in v$version yet. Download a build from github.com/$Repo/releases or install the Atlas app."
    }
    Exit-Launcher "this plugin version ($version) has no pinned build yet. Update the plugin ($Update), or put atlas-usage on PATH."
}

try { New-Item -ItemType Directory -Force -Path $cacheRoot -ErrorAction Stop | Out-Null } catch { Exit-Launcher "cannot write to $binDir. $Hint" }
# The longest a download takes: three files (program, list, signature), each up to 4 tries of 20 s
# to connect + 300 s, about 64 minutes. A lock or work folder older than about twice that was left
# by a run that was killed.
$staleMinutes = 130
# Work folders of runs that were killed mid-download.
Get-ChildItem -LiteralPath $cacheRoot -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name.StartsWith('.dl') -and $_.LastWriteTime -lt (Get-Date).AddMinutes(-$staleMinutes) } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

$lock = Join-Path $cacheRoot ".lock-$version"
$lockOwner = Join-Path $lock 'owner'
$token = [guid]::NewGuid().ToString('N')
$script:locked = $false
$script:work = ''
function Read-Owner([string]$file) { try { return [IO.File]::ReadAllText($file).Trim() } catch { return '' } }
function Clear-Download {
    if ($script:work) { Remove-Item -LiteralPath $script:work -Recurse -Force -ErrorAction SilentlyContinue }
    # Only this run's own lock: a run that took over a stale lock holds a different token.
    if ($script:locked -and (Read-Owner $lockOwner) -ceq $token) {
        Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction SilentlyContinue
    }
    $script:work = ''; $script:locked = $false
}

# Returns the copy to run. A function, so that 'return' leaves only this part and the finally
# block always cleans up (also when Exit-Launcher exits).
function Invoke-Download {
try {
    # One download at a time per version: a second run waits for the first instead of fetching too.
    # The lock folder holds this run's token. A stale lock is renamed first (atomic) and judged again
    # by the renamed folder's own time, since another run may have replaced it with a fresh lock in
    # between. A fresh one is put back only where there is no lock (a new folder, never a move onto
    # one); a stale one is deleted.
    $waited = 0
    while ($waited -lt 330) {
        try {
            New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null
            try { [IO.File]::WriteAllText($lockOwner, "$token`n") } catch { $null = $_ }
            $script:locked = $true
            break
        } catch { $null = $_ }
        $li = Get-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
        if ($li -and $li.LastWriteTime -lt (Get-Date).AddMinutes(-$staleMinutes)) {
            $grave = Join-Path $cacheRoot ".dl.stale-lock.$token"
            $moved = $false
            try { [IO.Directory]::Move($lock, $grave); $moved = $true } catch { $null = $_ }
            if ($moved) {
                $gi = Get-Item -LiteralPath $grave -Force -ErrorAction SilentlyContinue
                if ($gi -and $gi.LastWriteTime -ge (Get-Date).AddMinutes(-$staleMinutes)) {
                    $made = $false
                    try { New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null; $made = $true } catch { $null = $_ }
                    if ($made) { try { [IO.File]::Move((Join-Path $grave 'owner'), $lockOwner) } catch { $null = $_ } }
                }
                Remove-Item -LiteralPath $grave -Recurse -Force -ErrorAction SilentlyContinue
            }
            $waited++
            continue
        }
        if ($waited -eq 0) { Write-Note 'another run is fetching the program; waiting for it...' }
        Start-Sleep -Seconds 2
        $waited += 2
    }
    # Another run may have saved it meanwhile.
    if ((Test-Path -LiteralPath $cached -PathType Leaf) -and (Test-CacheOk $cached)) {
        Write-Verbose2 'cache:' $cached
        return $cached
    }

    # A private work folder per run: two runs at once never share a half-written file.
    $script:work = Join-Path $cacheRoot ('.dl.' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try { New-Item -ItemType Directory -Force -Path $script:work -ErrorAction Stop | Out-Null } catch { $script:work = ''; Exit-Launcher "cannot write to $binDir. $Hint" }

    # curl is preferred: --proto-redir keeps every redirect on https. Without it, PowerShell's own
    # request follows redirects itself, and each hop must stay on https (Windows PowerShell 5.1's
    # Invoke-WebRequest would follow https -> http). Retries cover dropped connections too.
    if ($onWindows) { $curlName = 'curl.exe' } else { $curlName = 'curl' }
    $curl = Get-Command $curlName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $curlRetry = @('--retry', '3')
    if ($curl) {
        $curlHelp = (& $curl.Source --help all 2>$null | Out-String)
        if ($curlHelp.Contains('--retry-all-errors')) { $curlRetry = @('--retry', '3', '--retry-all-errors') }
        elseif ($curlHelp.Contains('--retry-connrefused')) { $curlRetry = @('--retry', '3', '--retry-connrefused') }
    }
    function Get-Url([string]$url, [string]$dest, [bool]$secure) {
        if ($curl) {
            if ($secure) { $proto = @('--proto', '=https', '--proto-redir', '=https') } else { $proto = @('--proto', '=http', '--proto-redir', '=http') }
            & $curl.Source -fsSL @proto @curlRetry --connect-timeout 20 --max-time 300 -o $dest $url *> $null
            return (($LASTEXITCODE -eq 0) -and (Test-Path -LiteralPath $dest -PathType Leaf))
        }
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { $null = $_ }
        for ($try = 0; $try -lt 4; $try++) {
            if ($try -gt 0) { Start-Sleep -Seconds $try }
            $retry = $false
            $u = $url
            for ($hop = 0; $hop -lt 6; $hop++) {
                if ($secure) { $schemeOk = $u -cmatch '^https://' } else { $schemeOk = Test-Loopback $u }
                if (-not $schemeOk) { return $false }
                $resp = $null
                try {
                    $req = [Net.HttpWebRequest]::Create($u)
                    $req.AllowAutoRedirect = $false
                    $req.Timeout = 20000
                    $req.ReadWriteTimeout = 300000
                    $req.UserAgent = 'atlas-usage-launcher'
                    $resp = $req.GetResponse()
                } catch {
                    $ex = $_.Exception
                    while ($ex -and -not ($ex -is [Net.WebException])) { $ex = $ex.InnerException }
                    if ($ex) { $resp = $ex.Response }
                }
                if ($null -eq $resp) { $retry = $true; break } # dropped or refused: try again
                try {
                    $code = [int]$resp.StatusCode
                    if ($code -ge 200 -and $code -lt 300) {
                        # At most 300 s per try, like curl --max-time 300.
                        $fs = [IO.File]::Create($dest)
                        try {
                            $st = $resp.GetResponseStream()
                            $buf = New-Object byte[] 65536
                            $sw = [Diagnostics.Stopwatch]::StartNew()
                            while (($n = $st.Read($buf, 0, $buf.Length)) -gt 0) {
                                $fs.Write($buf, 0, $n)
                                if ($sw.Elapsed.TotalSeconds -gt 300) { throw 'the download took too long' }
                            }
                        } finally { $fs.Dispose() }
                        return $true
                    } elseif ($code -ge 300 -and $code -lt 400 -and $resp.Headers['Location']) {
                        $u = (New-Object Uri ((New-Object Uri $u), [string]$resp.Headers['Location'])).AbsoluteUri
                    } else {
                        $retry = ($code -ge 500 -or $code -eq 408 -or $code -eq 429)
                        break
                    }
                } catch { $retry = $true; break } finally { $resp.Close() }
            }
            if (-not $retry) { return $false }
        }
        return $false
    }
    function Get-ReleaseFile([string]$name) { # -> $work/<name>, from the stand-in release or from GitHub
        $dest = Join-Path $script:work $name
        if ($srcIsDir) {
            try { Copy-Item -LiteralPath (Join-Path $src $name) -Destination $dest -ErrorAction Stop; return $true } catch { return $false }
        }
        if ($srcIsLoopback) { return (Get-Url ($src.TrimEnd('/') + "/$name") $dest $false) }
        if (Get-Url "https://github.com/$Repo/releases/download/v$version/$name" $dest $true) { return $true }
        # Only if that failed: a signed-in GitHub CLI can fetch it too (the release is public, so this is
        # a second route, not a need).
        $gh = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $gh) { return $false }
        Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
        $env:GH_PROMPT_DISABLED = '1'
        & $gh.Source release download "v$version" --repo $Repo --pattern $name --dir $script:work --clobber *> $null
        return (($LASTEXITCODE -eq 0) -and (Test-Path -LiteralPath $dest -PathType Leaf))
    }

    # The signed checksum list is fetched too when this computer can check it.
    $checkSig = Test-Verifier

    Write-Note "first use of v${version}: downloading the program for $platform (one time)..."
    $started = Get-Date
    $file = Join-Path $script:work $asset
    $got = Get-ReleaseFile $asset
    if ($got -and $checkSig) {
        $got = (Get-ReleaseFile 'SHA256SUMS.txt') -and (Get-ReleaseFile 'SHA256SUMS.txt.sig')
    }

    # (e) the download failed: an older copy that is still good beats no answer.
    if (-not $got) {
        $older = ''; $olderVer = ''
        foreach ($d in @(Get-ChildItem -LiteralPath $cacheRoot -Directory -ErrorAction SilentlyContinue | Where-Object { -not $_.Name.StartsWith('.') })) {
            $p = Join-Path $d.FullName $exe
            if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { continue }
            if (-not (Test-VersionOlder $d.Name $version)) { continue }
            $h = Get-Hash $p
            if (-not $h -or (Get-PinVersion $h) -cne $d.Name) { continue }
            if (-not $olderVer -or (Test-VersionOlder $olderVer $d.Name)) { $older = $p; $olderVer = $d.Name }
        }
        if (-not $older -and $script:stale) { $older = $script:stale; $olderVer = $script:staleVer }
        if ($older) {
            Write-Note "could not download v$version (check the internet connection), so this answer comes from the older v$olderVer. It tries again next time."
            Write-Verbose2 'older copy:' $older
            return $older
        }
        Exit-Launcher "could not download the program (release v$version of github.com/$Repo). Check the internet connection, then try again. $Hint"
    }

    $have = ''
    try { $have = (Get-FileHash -LiteralPath $file -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() } catch { $have = '' }
    if (-not $have) { Exit-Launcher 'no tool to check the download (need Get-FileHash).' }
    if ($want -cne $have) {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        Exit-Launcher "the downloaded program did not match the checksum pinned in this plugin, so it was deleted and not run. Try again later, or update the plugin ($Update)."
    }

    # The release's own list must be signed by the Atlas key and agree with the pin.
    $signed = 'unchecked'
    if ($checkSig) {
        $why = 'cannot read the checksum list'
        try {
            $sums = Join-Path $script:work 'SHA256SUMS.txt'
            $why = [AtlasMinisign]::Verify($pubKey, [IO.File]::ReadAllBytes($sums), [IO.File]::ReadAllText((Join-Path $script:work 'SHA256SUMS.txt.sig')))
        } catch { $why = 'cannot read the checksum list' }
        if ($why) {
            Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
            Exit-Launcher "the release's checksum list is not signed by the Atlas key, so the download was deleted and not run. Try again later, or update the plugin ($Update)."
        }
        if (-not (Test-SumsListPin $sums $asset $want)) {
            Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
            Exit-Launcher "the release's signed checksum list does not list this program with the pinned checksum, so the download was deleted and not run. Try again later, or update the plugin ($Update)."
        }
        $signed = 'checked'
    }

    # Atomic rename into place. If another run got there first, its copy is just as good.
    if (-not $onWindows) { & chmod +x $file 2>$null }
    try { New-Item -ItemType Directory -Force -Path $verDir -ErrorAction Stop | Out-Null } catch { $null = $_ }
    $saved = $false
    try { Move-Item -LiteralPath $file -Destination $cached -Force -ErrorAction Stop; $saved = $true } catch { $null = $_ }
    $script:memoPath = $null
    if ($saved) {
        try { [IO.File]::WriteAllText((Join-Path $verDir 'signature'), "$signed`n") } catch { $null = $_ }
    } else {
        # Another run saved it first: its copy runs only if it matches the pin too.
        if (-not (Test-Path -LiteralPath $cached -PathType Leaf)) { Exit-Launcher "cannot save the program to $binDir. $Hint" }
        if ((Get-Hash $cached) -cne $want) { Exit-Launcher "cannot save the program to $binDir, and the copy already there does not match its pin. $Hint" }
    }

    # Drop only versions OLDER than this one (compared as versions, not strings): another plugin
    # version sharing this folder keeps its own copy. Work folders and the lock start with a dot and
    # are skipped. The remembered command checks go too: they are cheap to make again.
    Get-ChildItem -LiteralPath $cacheRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { -not $_.Name.StartsWith('.') -and (Test-VersionOlder $_.Name $version) } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath (Join-Path $cacheRoot 'caps') -Recurse -Force -ErrorAction SilentlyContinue

    $size = 0
    try { $size = (Get-Item -LiteralPath $cached -ErrorAction Stop).Length } catch { $size = 0 }
    $took = [int][Math]::Floor(((Get-Date) - $started).TotalSeconds)
    $mb = ([double]$size / 1048576).ToString('0.0', [Globalization.CultureInfo]::InvariantCulture)
    $matched = 'the pinned checksum'
    if ($signed -ceq 'checked') { $matched = 'the pinned checksum and the signed release list' }
    Write-Note "downloaded $mb MB in ${took}s; it matches $matched."
    Write-Verbose2 'downloaded:' $cached
    return $cached
} finally {
    Clear-Download
}
}
$runPath = Invoke-Download | Select-Object -Last 1
if ($runPath) { Invoke-Program $runPath }
exit 3
