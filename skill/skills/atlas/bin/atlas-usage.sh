#!/bin/sh
# Atlas launcher for macOS, Linux (and Git Bash on Windows): finds or fetches the
# atlas-usage program, then runs it with the arguments unchanged.
#   usage: sh atlas-usage.sh <atlas-usage arguments>
#          sh atlas-usage.sh launcher-doctor   says which copy it would run and why; runs nothing
# Order: (0) $ATLAS_USAGE_BIN, (a) atlas-usage on PATH, (b) a copy cached under
# <data>/cache/<plugin version>/, (c) the Atlas app's copy, (d) download tag v<plugin version> of
# dozeyy/atlas, (e) only if that download fails: the newest older saved copy, then an older copy
# passed over in (a) or (c).
# <data> = $CLAUDE_PLUGIN_DATA when the shell has it, else a per-user cache folder
# (~/Library/Caches/atlas/skill, ${XDG_CACHE_HOME:-~/.cache}/atlas/skill, %LOCALAPPDATA%\atlas\skill),
# else this script's own folder.
# A file sitting loose next to this script is never run: only PATH, the app and the verified cache.
# A copy on PATH or in the app whose SHA-256 is the pinned build of an OLDER plugin version is passed
# over (and kept as the last resort). Copies with hashes not in checksums.txt (your own builds) run.
# Trust: a download is run ONLY if its SHA-256 equals the line "<version> <asset> <sha256>" in
# checksums.txt next to this script (pinned when the plugin was released), and a saved copy is checked
# against the same line each time it runs. What the release says can only add a refusal. No pinned
# line = no download. Old lines stay in checksums.txt on purpose: they name old builds.
# Exit code 3 = the launcher itself failed (one plain line on stderr); 4 = the program found is too old
# for repeats / offer-note / debrief.
# Signature: on a download, when openssl here can check Ed25519 (OpenSSL 1.1.1 or later), the
# release's SHA256SUMS.txt and SHA256SUMS.txt.sig are fetched too. The signature must be made by the
# Atlas update key below and the list must give the program the pinned hash, or the download is
# deleted. Without such an openssl the pin alone decides, quietly; launcher-doctor says which.
# ATLAS_USAGE_BIN = a program file to run instead of searching (no checksum check: your choice).
# ATLAS_USAGE_LAUNCHER_VERBOSE=1 names the copy used.
# Test aid: ATLAS_USAGE_TEST_SOURCE = a local folder, or an http://127.0.0.1 / localhost
# address, that stands in for the release (the pinned hash still applies). Only together with it,
# ATLAS_USAGE_TEST_PUBKEY replaces the update key, so tests can sign their own files. That grants
# nothing: the stand-in release is local, its files must still match the pins, and whoever can set
# these variables can already set ATLAS_USAGE_BIN. Downloads from GitHub always use the real key.

REPO="dozeyy/atlas"
UPDATE="/plugin marketplace update atlas"
# plugins.updater.pubkey in crates/app/tauri.conf.json: the key that signs every release's SHA256SUMS.txt.
PUBKEY="dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ0NDgzQzI2NTdDMTIyM0QKUldROUlzRlhKanhJUk5WZE1acm5keEtUYm1wUnRoQ0thcVREQXlqZGVhdzVxdXNWaXZuTnhTZ0QK"
# A known answer: this key signed BLAKE2b-512("atlas launcher self-test"). openssl must agree before
# it is trusted to check anything (its private half was thrown away).
KAT_KEY="MCowBQYDK2VwAyEAHrPjnQ9OVF6xL9M3Gs5/dQ1qxB4Q2Z1/PW2PRcF6kqo="
KAT_SIG="iXsJeaAm9s6pcbZgrJwTstnsT0JjNRFnMnIS8OEmhUkwZ/kpfo+aIbmfC8DzBwSN2qqr2MrJe1cfJwgf3sc1Ag=="

fail() {
  printf 'atlas-usage: %s\n' "$1" >&2
  exit 3
}

note() { # a plain line on stderr that does not stop anything
  printf 'atlas-usage: %s\n' "$1" >&2
}

say() { # verbose-only note
  [ -n "$ATLAS_USAGE_LAUNCHER_VERBOSE" ] && printf 'atlas-usage launcher: %s %s\n' "$1" "$2" >&2
  return 0
}

doctor=
[ "$1" = launcher-doctor ] && doctor=1
report() { # launcher-doctor lines, on stdout
  [ -n "$doctor" ] && printf '%-15s %s\n' "$1" "$2"
  return 0
}

# Strictly http://127.0.0.1 or http://localhost, optional :port, then / or the end.
loopback_ok() {
  lrest=
  case $1 in
    http://127.0.0.1*) lrest=${1#http://127.0.0.1} ;;
    http://localhost*) lrest=${1#http://localhost} ;;
    *) return 1 ;;
  esac
  case $lrest in
    :*)
      lrest=${lrest#:}
      ldigits=${lrest%%[!0-9]*}
      [ -n "$ldigits" ] || return 1
      lrest=${lrest#"$ldigits"}
      ;;
  esac
  case $lrest in
    '' | /*) return 0 ;;
    *) return 1 ;;
  esac
}

sha_tool() {
  if command -v sha256sum >/dev/null 2>&1; then echo sha256sum
  elif command -v shasum >/dev/null 2>&1; then echo shasum
  elif command -v openssl >/dev/null 2>&1; then echo openssl
  fi
}

sha256_of() {
  case $(sha_tool) in
    sha256sum) sha256sum "$1" | cut -d' ' -f1 ;;
    shasum) shasum -a 256 "$1" | cut -d' ' -f1 ;;
    openssl) openssl dgst -sha256 "$1" | sed 's/^.*= //' ;;
    *) return 1 ;;
  esac
}

# The SHA-256 of a file, kept for the last file asked about (the chosen copy is hashed once).
memo_p=
memo_h=
hash_into() {
  if [ "$1" != "$memo_p" ]; then
    memo_p=$1
    memo_h=$(sha256_of "$1" 2>/dev/null | tr 'A-F' 'a-f') || memo_h=
  fi
}

# --- Signature check (minisign / Tauri "ED" form), the same steps as tools/verify-minisign.mjs.
b64d() { # base64 text file -> binary file
  openssl base64 -d -A -in "$1" -out "$2" 2>/dev/null && [ -s "$2" ]
}
hex_of() { # file offset count -> those bytes as lowercase hex
  dd if="$1" bs=1 skip="$2" count="$3" 2>/dev/null | od -An -tx1 | tr -d ' \n'
}
slice() { # file offset count dest
  dd if="$1" of="$4" bs=1 skip="$2" count="$3" 2>/dev/null
}
size_of() { wc -c <"$1" 2>/dev/null | tr -d ' '; }
ed_verify() { # DER public key, message file, raw 64-byte signature
  openssl pkeyutl -verify -pubin -keyform DER -inkey "$1" -rawin -in "$2" -sigfile "$3" >/dev/null 2>&1
}

# True when openssl here checks Ed25519 over BLAKE2b-512 correctly (the known answer above).
verifier_ok() { # scratch folder
  command -v openssl >/dev/null 2>&1 || return 1
  printf '%s' "$KAT_KEY" >"$1/kat.key.b64" && b64d "$1/kat.key.b64" "$1/kat.der" || return 1
  printf '%s' "$KAT_SIG" >"$1/kat.sig.b64" && b64d "$1/kat.sig.b64" "$1/kat.sig" || return 1
  printf 'atlas launcher self-test' >"$1/kat.msg"
  openssl dgst -blake2b512 -binary -out "$1/kat.hash" "$1/kat.msg" >/dev/null 2>&1 || return 1
  ed_verify "$1/kat.der" "$1/kat.hash" "$1/kat.sig"
}

# True when the minisign signature file (as Tauri writes it: base64 of four lines) is a good
# signature by $pubkey of the file, and its trusted comment carries a good signature too.
minisign_ok() { # scratch folder, file, signature file
  ms=$1/sig
  mkdir -p "$ms" || return 1
  # The key: base64 of two lines; line 2 is base64 of "Ed", an 8-byte key id and the 32-byte key.
  printf '%s' "$pubkey" >"$ms/pub.b64" && b64d "$ms/pub.b64" "$ms/pub.txt" || return 1
  sed -n '2p' "$ms/pub.txt" | tr -d '\r\n' >"$ms/pub2.b64" && b64d "$ms/pub2.b64" "$ms/pub.raw" || return 1
  [ "$(size_of "$ms/pub.raw")" = 42 ] && [ "$(hex_of "$ms/pub.raw" 0 2)" = 4564 ] || return 1
  printf '\060\052\060\005\006\003\053\145\160\003\041\000' >"$ms/pub.der" # Ed25519 key header
  slice "$ms/pub.raw" 10 32 "$ms/pk"
  cat "$ms/pk" >>"$ms/pub.der"
  # The signature: line 2 is "Ed"/"ED", the key id, then 64 bytes; line 3 the trusted comment,
  # line 4 the signature of (those 64 bytes + the comment).
  tr -d '\r\n' <"$3" >"$ms/sigfile.b64" && b64d "$ms/sigfile.b64" "$ms/sig.txt" || return 1
  sed -n '2p' "$ms/sig.txt" | tr -d '\r\n' >"$ms/sig2.b64" && b64d "$ms/sig2.b64" "$ms/sig.raw" || return 1
  [ "$(size_of "$ms/sig.raw")" = 74 ] || return 1
  ms_alg=$(hex_of "$ms/sig.raw" 0 2)
  [ "$(hex_of "$ms/sig.raw" 2 8)" = "$(hex_of "$ms/pub.raw" 2 8)" ] || return 1
  slice "$ms/sig.raw" 10 64 "$ms/sig"
  case $ms_alg in
    4544) openssl dgst -blake2b512 -binary -out "$ms/msg" "$2" >/dev/null 2>&1 || return 1 ;; # "ED"
    4564) cp "$2" "$ms/msg" || return 1 ;;                                                  # "Ed"
    *) return 1 ;;
  esac
  ed_verify "$ms/pub.der" "$ms/msg" "$ms/sig" || return 1
  ms_tc=$(sed -n '3p' "$ms/sig.txt" | tr -d '\r')
  case $ms_tc in "trusted comment: "*) ;; *) return 1 ;; esac
  sed -n '4p' "$ms/sig.txt" | tr -d '\r\n' >"$ms/glob.b64" && b64d "$ms/glob.b64" "$ms/glob" || return 1
  [ "$(size_of "$ms/glob")" = 64 ] || return 1
  cp "$ms/sig" "$ms/gmsg" && printf '%s' "${ms_tc#trusted comment: }" >>"$ms/gmsg" || return 1
  ed_verify "$ms/pub.der" "$ms/gmsg" "$ms/glob"
}

# True when SHA256SUMS.txt names the asset, and every line naming it gives the pinned hash.
sums_list_pin() { # SHA256SUMS.txt asset sha256
  LC_ALL=C awk -v f="$2" -v h="$3" '
    { sub(/\r$/, ""); n = $2; sub(/^\*/, "", n) }
    n == f { seen = 1; if (tolower($1) != h) bad = 1 }
    END { exit !(seen && !bad) }
  ' "$1"
}

# Only the numeric dotted start of a version counts ("0.2.0-beta" -> 0.2.0); true when $1 is
# strictly older than $2. Anything without such a start is "not older", so it is never pruned.
ver_older() {
  vo_a=${1%%[!0-9.]*}
  vo_b=${2%%[!0-9.]*}
  [ -n "$vo_a" ] && [ -n "$vo_b" ] || return 1
  while [ -n "$vo_a" ] || [ -n "$vo_b" ]; do
    vo_ah=${vo_a%%.*}
    vo_bh=${vo_b%%.*}
    case $vo_a in *.*) vo_a=${vo_a#*.} ;; *) vo_a= ;; esac
    case $vo_b in *.*) vo_b=${vo_b#*.} ;; *) vo_b= ;; esac
    vo_ah=${vo_ah:-0}
    vo_bh=${vo_bh:-0}
    if [ "$vo_ah" -lt "$vo_bh" ] 2>/dev/null; then return 0; fi
    if [ "$vo_ah" -gt "$vo_bh" ] 2>/dev/null; then return 1; fi
  done
  return 1
}

scriptdir=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || fail "cannot find the skill folder."
pins=$scriptdir/checksums.txt

# Pinned lines: "<version> <asset> <sha256>", tolerant of a BOM and CRLF.
pin_for() { # version asset -> its sha256 (lowercase), or nothing
  [ -f "$pins" ] || return 0
  LC_ALL=C awk -v v="$1" -v f="$2" '
    NR == 1 && substr($0, 1, 3) == "\357\273\277" { $0 = substr($0, 4) }
    { sub(/\r$/, "") }
    ($1 "") == (v "") && ($2 "") == (f "") && $3 ~ /^[0-9A-Fa-f]+$/ && length($3) == 64 { print tolower($3); exit }
  ' "$pins"
}
pin_version_of() { # sha256 -> the plugin version whose pinned build has that hash, or nothing
  [ -f "$pins" ] && [ -n "$1" ] || return 0
  LC_ALL=C awk -v h="$1" '
    NR == 1 && substr($0, 1, 3) == "\357\273\277" { $0 = substr($0, 4) }
    { sub(/\r$/, "") }
    $1 ~ /^[0-9]/ && tolower($3) == h { print $1; exit }
  ' "$pins"
}
has_any_pin() { # version -> true when any build of it is pinned
  [ -f "$pins" ] || return 1
  LC_ALL=C awk -v v="$1" '{ sub(/\r$/, "") } ($1 "") == (v "") && length($3) == 64 { found = 1 } END { exit !found }' "$pins"
}

# The plugin version (= the release tag without its v), read from the plugin's own manifest.
# Anything that is not digits, letters, dot, dash or underscore, starting with a digit, is no version.
version=
pj=$scriptdir/../../../.claude-plugin/plugin.json
if [ -f "$pj" ]; then
  version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pj" | head -n 1)
  case $version in
    [0-9]*) case $version in *[!A-Za-z0-9._-]*) version= ;; esac ;;
    *) version= ;;
  esac
fi

os=$(uname -s 2>/dev/null)
arch=$(uname -m 2>/dev/null)
win=
case $os in
  MINGW* | MSYS* | CYGWIN*) win=1 exe=atlas-usage.exe ;;
  *) exe=atlas-usage ;;
esac

winpath() { # a Windows path as this shell writes it
  if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf '%s\n' "$1"; fi
}

is_musl() {
  for lm in /lib/ld-musl-*.so.1; do [ -e "$lm" ] && return 0; done
  ldd --version 2>&1 | grep -qi musl
}

# Which release file fits this computer.
asset=
platform="$os $arch"
case $os in
  Darwin) asset=atlas-usage-macos-universal platform=macOS ;;
  Linux)
    la=
    case $arch in
      x86_64 | amd64) la=x64 ;;
      aarch64 | arm64) la=arm64 ;;
    esac
    if [ -n "$la" ]; then
      asset=atlas-usage-linux-$la platform="Linux $la"
      if is_musl; then asset=$asset-musl platform="Linux $la (musl)"; fi
    fi
    ;;
  MINGW* | MSYS* | CYGWIN*)
    asset=atlas-usage-windows-x64.exe platform="Windows x64"
    case ${PROCESSOR_ARCHITEW6432:-$PROCESSOR_ARCHITECTURE} in
      ARM64 | arm64)
        # A native build when this version has one; else the x64 build, which Windows on ARM runs emulated.
        if [ -n "$version" ] && [ -n "$(pin_for "$version" atlas-usage-windows-arm64.exe)" ]; then
          asset=atlas-usage-windows-arm64.exe platform="Windows ARM64"
        else
          platform="Windows ARM64 (x64 build, emulated)"
        fi
        ;;
    esac
    ;;
esac
want=
[ -n "$version" ] && [ -n "$asset" ] && want=$(pin_for "$version" "$asset")

# The stand-in release (tests only), and the key its signature must come from.
src=$ATLAS_USAGE_TEST_SOURCE
src_test=
if [ -n "$src" ] && { [ -d "$src" ] || loopback_ok "$src"; }; then src_test=1; fi
pubkey=$PUBKEY
keyname="the Atlas release key"
if [ -n "$src_test" ] && [ -n "$ATLAS_USAGE_TEST_PUBKEY" ]; then
  pubkey=$ATLAS_USAGE_TEST_PUBKEY keyname="the test key in ATLAS_USAGE_TEST_PUBKEY"
fi

# Where saved copies live.
bindir=$CLAUDE_PLUGIN_DATA
if [ -z "$bindir" ]; then
  case $os in
    Darwin) [ -n "$HOME" ] && bindir=$HOME/Library/Caches/atlas/skill ;;
    Linux)
      xbase=$XDG_CACHE_HOME
      case $xbase in /*) ;; *) xbase= ;; esac
      [ -z "$xbase" ] && [ -n "$HOME" ] && xbase=$HOME/.cache
      [ -n "$xbase" ] && bindir=$xbase/atlas/skill
      ;;
    *) [ -n "$win" ] && [ -n "$LOCALAPPDATA" ] && bindir=$(winpath "$LOCALAPPDATA")/atlas/skill ;;
  esac
  if [ -n "$bindir" ] && ! mkdir -p "$bindir" 2>/dev/null; then bindir=; fi
  [ -n "$bindir" ] || bindir=$scriptdir
fi
cacheroot=$bindir/cache
verdir=
cached=
if [ -n "$version" ]; then
  verdir=$cacheroot/$version
  cached=$verdir/$exe
fi

if [ -n "$doctor" ]; then
  printf 'Atlas launcher check (runs nothing, downloads nothing)\n'
  report "plugin" "${version:-no version (installed by hand?)}"
  report "computer" "$platform"
  if [ -z "$asset" ]; then report "build" "none made for this computer"
  elif [ -n "$want" ]; then report "build" "$asset, pinned"
  else report "build" "$asset, not pinned for ${version:-this copy}"; fi
  report "saved in" "$cacheroot"
  dl=
  command -v curl >/dev/null 2>&1 && dl="curl"
  command -v wget >/dev/null 2>&1 && dl="${dl:+$dl, }wget"
  command -v gh >/dev/null 2>&1 && dl="${dl:+$dl, }gh"
  sha_t=$(sha_tool)
  report "download" "${dl:-no curl, wget or gh}; checksum with ${sha_t:-nothing (need sha256sum, shasum or openssl)}"
  dtmp=$(mktemp -d "${TMPDIR:-/tmp}/atlas-doctor.XXXXXX" 2>/dev/null)
  if [ -n "$dtmp" ] && verifier_ok "$dtmp"; then
    report "signature" "checked on download with openssl, against $keyname"
  else
    report "signature" "NOT checked on this computer (openssl here cannot check Ed25519; needs OpenSSL 1.1.1 or later). The pinned checksum still applies."
  fi
  [ -n "$dtmp" ] && rm -rf "$dtmp"
fi
saved_sig() { # report how the saved copy in the version folder was checked when it was saved
  case $(cat "$verdir/signature" 2>/dev/null) in
    checked) report "  signature" "checked when it was saved" ;;
    unchecked) report "  signature" "not checked when it was saved (no Ed25519 check then); pinned checksum only" ;;
    *) report "  signature" "not recorded (saved by an older launcher); pinned checksum only" ;;
  esac
}

# The repeated-request and debrief commands need a program that knows them: an older copy would read
# "repeats" as something else and answer with nothing useful, so it is refused here with one plain
# line (exit code 4). A copy that passed is remembered by its hash, so it is asked only once.
run_bin() {
  rb=$1
  shift
  rb_need=
  case $1 in
    repeats | offer-note) rb_need=repeats rb_word=offer-note rb_what="repeated requests" ;;
    debrief) rb_need=debrief rb_word='helpers did' rb_what="the debrief" ;;
  esac
  if [ -n "$rb_need" ]; then
    hash_into "$rb"
    rb_mark=
    [ -n "$memo_h" ] && rb_mark=$cacheroot/caps/$memo_h.$rb_need
    if [ -n "$rb_mark" ] && [ -f "$rb_mark" ]; then
      :
    elif "$rb" "$rb_need" --help 2>/dev/null | grep -q "$rb_word"; then
      [ -n "$rb_mark" ] && mkdir -p "$cacheroot/caps" 2>/dev/null && : >"$rb_mark" 2>/dev/null
    else
      printf 'atlas-usage: this copy of atlas-usage (%s) is too old for %s. Update the Atlas plugin (%s) or the Atlas app.\n' "$rb" "$rb_what" "$UPDATE" >&2
      exit 4
    fi
  fi
  exec "$rb" "$@"
}

pick() { # path label: the copy to run (launcher-doctor stops here)
  if [ -n "$doctor" ]; then
    report "would run" "$2 $1"
    exit 0
  fi
  say "$2" "$1"
}

# A copy found on PATH or in the app is passed over when its hash is the pinned build of an
# older plugin version. The first one passed over is kept for the case the download fails.
stale=
stale_ver=
current_enough() { # path label
  ce_old=
  if [ -n "$version" ]; then
    hash_into "$1"
    [ -n "$memo_h" ] && ce_old=$(pin_version_of "$memo_h")
  fi
  if [ -n "$ce_old" ] && ver_older "$ce_old" "$version"; then
    say "passed over:" "$1 (release $ce_old, older than $version)"
    report "$2" "$1 (release $ce_old, older than $version: passed over)"
    if [ -z "$stale" ]; then stale=$1 stale_ver=$ce_old; fi
    return 1
  fi
  report "$2" "$1"
  return 0
}

# A saved copy runs only if it still matches its pin; one that does not is deleted.
cache_ok() { # path
  [ -n "$want" ] || return 0
  hash_into "$1"
  [ -n "$memo_h" ] || return 0 # no tool to check it: trusted, as it was checked when saved
  [ "$memo_h" = "$want" ] && return 0
  if [ -n "$doctor" ]; then
    report "saved copy" "$1 (does NOT match its pin; it would be fetched again)"
    return 1
  fi
  rm -f "$1"
  note "the saved copy of the program did not match the checksum pinned in this plugin, so it was deleted. Fetching it again."
  return 1
}

# (0) a file named by the user
if [ -n "$ATLAS_USAGE_BIN" ]; then
  [ -f "$ATLAS_USAGE_BIN" ] || fail "ATLAS_USAGE_BIN is set to $ATLAS_USAGE_BIN, which is not a file. Fix it or unset it."
  pick "$ATLAS_USAGE_BIN" "ATLAS_USAGE_BIN:"
  run_bin "$ATLAS_USAGE_BIN" "$@"
fi

# (a) on PATH
onpath=$(command -v atlas-usage 2>/dev/null)
if [ -n "$onpath" ] && [ -f "$onpath" ]; then
  if current_enough "$onpath" "PATH"; then
    pick "$onpath" "PATH:"
    run_bin "$onpath" "$@"
  fi
else
  report "PATH" "no atlas-usage"
fi

# (b) cached copy, keyed by the plugin version
if [ -n "$cached" ] && [ -f "$cached" ] && cache_ok "$cached"; then
  report "saved copy" "$cached (matches its pin)"
  [ -n "$doctor" ] && saved_sig
  pick "$cached" "cache:"
  run_bin "$cached" "$@"
fi
[ -n "$cached" ] && [ ! -f "$cached" ] && report "saved copy" "none for ${version}"

# (c) the Atlas app's copy: Windows per-user and machine-wide installs, the Mac app bundle
apps=
if [ -n "$win" ]; then
  # shellcheck disable=SC2154 # Windows sets these
  for wd in "$LOCALAPPDATA" "$ProgramW6432" "$ProgramFiles" "$PROGRAMFILES"; do
    [ -n "$wd" ] && apps="$apps
$(winpath "$wd")/Atlas/$exe"
  done
elif [ "$os" = Darwin ]; then
  apps="/Applications/Atlas.app/Contents/MacOS/$exe"
  [ -n "$HOME" ] && apps="$apps
$HOME/Applications/Atlas.app/Contents/MacOS/$exe"
fi
found_app=
oldifs=$IFS
IFS='
'
for ap in $apps; do
  IFS=$oldifs
  [ -f "$ap" ] || continue
  found_app=1
  if current_enough "$ap" "Atlas app"; then
    pick "$ap" "Atlas app:"
    run_bin "$ap" "$@"
  fi
done
IFS=$oldifs
[ -n "$found_app" ] || report "Atlas app" "not found"

# (d) download, verify against the pinned hash, cache
hint="Install the Atlas app from github.com/$REPO/releases, or put atlas-usage on PATH."
if [ -n "$doctor" ]; then
  if [ -z "$asset" ]; then report "would run" "nothing: there is no ready-made build for $platform"
  elif [ -z "$version" ]; then report "would run" "nothing: this copy of the skill has no version"
  elif [ -z "$want" ]; then report "would run" "nothing: v$version has no pinned build for $platform"
  else report "would run" "a one-time download of v$version ($asset), checked against its pin"; fi
  [ -n "$stale" ] && report "if offline" "$stale (release $stale_ver)"
  exit 0
fi

[ -n "$asset" ] || fail "there is no ready-made build for $platform yet. Download a build from github.com/$REPO/releases or install the Atlas app."
[ -n "$version" ] || fail "this copy of the skill has no version, so it cannot fetch the program. Put atlas-usage on PATH, or install the plugin: /plugin marketplace add $REPO"
if [ -z "$want" ]; then
  if has_any_pin "$version"; then
    fail "there is no ready-made build for $platform in v$version yet. Download a build from github.com/$REPO/releases or install the Atlas app."
  fi
  fail "this plugin version ($version) has no pinned build yet. Update the plugin ($UPDATE), or put atlas-usage on PATH."
fi

mkdir -p "$cacheroot" 2>/dev/null || fail "cannot write to $bindir. $hint"
# Work folders of runs that were killed mid-download: remove the ones older than an hour.
find "$cacheroot" -maxdepth 1 -type d -name '.dl*' -mmin +60 -exec rm -rf {} + >/dev/null 2>&1

# One download at a time per version: a second run waits for the first instead of fetching too.
# A lock older than 10 minutes was left by a run that was killed, and is taken over.
lock=$cacheroot/.lock-$version
locked=
work=
cleanup() {
  [ -n "$work" ] && rm -rf "$work"
  [ -n "$locked" ] && rmdir "$lock" 2>/dev/null
  work='' locked=''
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
waited=0
while [ "$waited" -lt 330 ]; do
  if mkdir "$lock" 2>/dev/null; then
    locked=1
    break
  fi
  if [ -n "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    rmdir "$lock" 2>/dev/null
    waited=$((waited + 1))
    continue
  fi
  [ "$waited" = 0 ] && note "another run is fetching the program; waiting for it..."
  sleep 2
  waited=$((waited + 2))
done
# Another run may have saved it meanwhile.
if [ -f "$cached" ] && cache_ok "$cached"; then
  cleanup
  say "cache:" "$cached"
  run_bin "$cached" "$@"
fi

# A private work folder per run: two runs at once never share a half-written file.
work=$(mktemp -d "$cacheroot/.dl.XXXXXX" 2>/dev/null) || fail "cannot write to $bindir. $hint"

# curl is preferred: --proto-redir keeps every redirect on https. wget's --https-only does not
# cover redirects on every build, so wget is only a fallback and the hash pin is the guard there.
# Retries cover dropped connections too, where this curl knows how.
curl_retry="--retry 3"
if command -v curl >/dev/null 2>&1; then
  curl_help=$(curl --help all 2>/dev/null)
  case $curl_help in
    *--retry-all-errors*) curl_retry="--retry 3 --retry-all-errors" ;;
    *--retry-connrefused*) curl_retry="--retry 3 --retry-connrefused" ;;
  esac
fi
fetch() { # url dest secure(1=https only)
  if command -v curl >/dev/null 2>&1; then
    if [ "$3" = 1 ]; then
      # shellcheck disable=SC2086 # curl_retry is several words on purpose
      curl -fsSL --proto =https --proto-redir =https $curl_retry --connect-timeout 20 --max-time 300 -o "$2" "$1" >/dev/null 2>&1
    else
      # shellcheck disable=SC2086
      curl -fsSL --proto =http --proto-redir =http $curl_retry --connect-timeout 20 --max-time 300 -o "$2" "$1" >/dev/null 2>&1
    fi
  elif command -v wget >/dev/null 2>&1; then
    if [ "$3" = 1 ]; then
      wget -q --https-only --tries=3 --retry-connrefused -T 60 -O "$2" "$1" >/dev/null 2>&1
    else
      wget -q --tries=3 --retry-connrefused -T 60 -O "$2" "$1" >/dev/null 2>&1
    fi
  else
    return 1
  fi
}

get() { # release file name -> $work/<name>, from the stand-in release or from GitHub
  if [ -n "$src" ] && [ -d "$src" ]; then
    cp "$src/$1" "$work/$1" 2>/dev/null
  elif [ -n "$src" ] && loopback_ok "$src"; then
    fetch "${src%/}/$1" "$work/$1" 0
  else
    fetch "https://github.com/$REPO/releases/download/v$version/$1" "$work/$1" 1 && return 0
    # Only if that failed: a signed-in GitHub CLI can fetch it too (the release is public, so this is
    # a second route, not a need).
    command -v gh >/dev/null 2>&1 || return 1
    rm -f "$work/$1"
    GH_PROMPT_DISABLED=1 gh release download "v$version" --repo "$REPO" --pattern "$1" --dir "$work" --clobber >/dev/null 2>&1 \
      && [ -f "$work/$1" ]
  fi
}

# The signed checksum list is fetched too when this computer can check it.
check_sig=
verifier_ok "$work" && check_sig=1

note "first use of v$version: downloading the program for $platform (one time)..."
started=$(date +%s 2>/dev/null)
got=0
get "$asset" && got=1
if [ "$got" = 1 ] && [ -n "$check_sig" ]; then
  { get SHA256SUMS.txt && get SHA256SUMS.txt.sig; } || got=0
fi

# (e) the download failed: an older copy that is still good beats no answer.
if [ "$got" = 0 ]; then
  older='' older_ver=''
  for d in "$cacheroot"/*; do
    [ -f "$d/$exe" ] || continue
    dv=${d##*/}
    ver_older "$dv" "$version" || continue
    hash_into "$d/$exe"
    [ -n "$memo_h" ] && [ "$(pin_version_of "$memo_h")" = "$dv" ] || continue
    if [ -z "$older_ver" ] || ver_older "$older_ver" "$dv"; then older=$d/$exe older_ver=$dv; fi
  done
  if [ -z "$older" ] && [ -n "$stale" ]; then older=$stale older_ver=$stale_ver; fi
  if [ -n "$older" ]; then
    cleanup
    note "could not download v$version (check the internet connection), so this answer comes from the older v$older_ver. It tries again next time."
    say "older copy:" "$older"
    run_bin "$older" "$@"
  fi
  fail "could not download the program (release v$version of github.com/$REPO). Check the internet connection, then try again. $hint"
fi

have=$(sha256_of "$work/$asset" | tr 'A-F' 'a-f') || fail "no tool to check the download (need sha256sum, shasum or openssl)."
[ -n "$have" ] || fail "no tool to check the download (need sha256sum, shasum or openssl)."
if [ "$want" != "$have" ]; then
  rm -f "$work/$asset"
  fail "the downloaded program did not match the checksum pinned in this plugin, so it was deleted and not run. Try again later, or update the plugin ($UPDATE)."
fi

# The release's own list must be signed by the Atlas key and agree with the pin.
signed=unchecked
if [ -n "$check_sig" ]; then
  if ! minisign_ok "$work" "$work/SHA256SUMS.txt" "$work/SHA256SUMS.txt.sig"; then
    rm -f "$work/$asset"
    fail "the release's checksum list is not signed by the Atlas key, so the download was deleted and not run. Try again later, or update the plugin ($UPDATE)."
  fi
  if ! sums_list_pin "$work/SHA256SUMS.txt" "$asset" "$want"; then
    rm -f "$work/$asset"
    fail "the release's signed checksum list does not list this program with the pinned checksum, so the download was deleted and not run. Try again later, or update the plugin ($UPDATE)."
  fi
  signed=checked
fi

# Atomic rename into place. If another run got there first, its copy is just as good.
chmod +x "$work/$asset" 2>/dev/null
mkdir -p "$verdir" 2>/dev/null
mv -f "$work/$asset" "$cached" 2>/dev/null || [ -f "$cached" ] || fail "cannot save the program to $bindir. $hint"
printf '%s\n' "$signed" >"$verdir/signature" 2>/dev/null

# Drop only versions OLDER than this one (compared as versions, not strings): another plugin
# version sharing this folder keeps its own copy. Work folders and the lock start with a dot and
# are skipped. The remembered command checks go too: they are cheap to make again.
for d in "$cacheroot"/*; do
  [ -d "$d" ] || continue
  if ver_older "${d##*/}" "$version"; then rm -rf "$d"; fi
done
rm -rf "$cacheroot/caps"
cleanup
trap - EXIT HUP INT TERM

size=$(wc -c <"$cached" 2>/dev/null | tr -d ' ')
took=
[ -n "$started" ] && took=$(($(date +%s 2>/dev/null) - started))
matched="the pinned checksum"
[ "$signed" = checked ] && matched="the pinned checksum and the signed release list"
note "downloaded $(awk -v b="${size:-0}" 'BEGIN { printf "%.1f MB", b / 1048576 }')${took:+ in ${took}s}; it matches $matched."
say "downloaded:" "$cached"
run_bin "$cached" "$@"
