#!/bin/sh
# Atlas launcher for macOS, Linux (and Git Bash on Windows): finds or fetches the
# atlas-usage program, then runs it with the arguments unchanged.
#   usage: sh atlas-usage.sh <atlas-usage arguments>
# Order: (a) atlas-usage on PATH, (b) a copy cached under <data>/cache/<plugin version>/
# (<data> = $CLAUDE_PLUGIN_DATA when the shell has it, else this script's own folder, which
# changes with every plugin version and goes away with the plugin), (c) Windows only: the Atlas
# app's install folder, (d) download tag v<plugin version> of dozeyy/atlas.
# A file sitting loose next to this script is never run: only PATH, the app and the verified cache.
# The download is trusted ONLY if its SHA-256 equals the line "<version> <asset> <sha256>" in
# checksums.txt next to this script (pinned when the plugin was released). Nothing the release
# itself says is trusted. No pinned line = no download.
# Exit code 3 = the launcher itself failed (one plain line on stderr).
# Test aid: ATLAS_USAGE_TEST_SOURCE = a local folder, or an http://127.0.0.1 / localhost
# address, that stands in for the release (the pinned hash still applies).
# ATLAS_USAGE_LAUNCHER_VERBOSE=1 names the copy used.

REPO="dozeyy/atlas"

fail() {
  printf 'atlas-usage: %s\n' "$1" >&2
  exit 3
}

say() { # verbose-only note
  [ -n "$ATLAS_USAGE_LAUNCHER_VERBOSE" ] && printf 'atlas-usage launcher: %s %s\n' "$1" "$2" >&2
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

scriptdir=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || fail "cannot find the skill folder."
bindir=$CLAUDE_PLUGIN_DATA
[ -n "$bindir" ] || bindir=$scriptdir

os=$(uname -s 2>/dev/null)
case $os in
  MINGW* | MSYS* | CYGWIN*) exe=atlas-usage.exe ;;
  *) exe=atlas-usage ;;
esac

# (a) on PATH
onpath=$(command -v atlas-usage 2>/dev/null)
if [ -n "$onpath" ] && [ -f "$onpath" ]; then
  say "PATH:" "$onpath"
  exec "$onpath" "$@"
fi

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
cacheroot=$bindir/cache
verdir=$cacheroot/$version
cached=$verdir/$exe

# (b) cached copy, keyed by the plugin version
if [ -n "$version" ] && [ -f "$cached" ]; then
  say "cache:" "$cached"
  exec "$cached" "$@"
fi

# (c) the Atlas app's install folder (Windows; the installer's per-user default)
if [ "$exe" = "atlas-usage.exe" ] && [ -n "$LOCALAPPDATA" ] && [ -f "$LOCALAPPDATA/Atlas/$exe" ]; then
  say "Atlas app:" "$LOCALAPPDATA/Atlas/$exe"
  exec "$LOCALAPPDATA/Atlas/$exe" "$@"
fi

# (d) download, verify against the pinned hash, cache
hint="Install the Atlas app from github.com/$REPO/releases, or put atlas-usage on PATH."
arch=$(uname -m 2>/dev/null)
case $os in
  Darwin) asset=atlas-usage-macos-universal ;;
  Linux)
    case $arch in
      x86_64 | amd64) asset=atlas-usage-linux-x64 ;;
      *) fail "there is no ready-made build for $arch yet. Download a build from github.com/$REPO/releases or install the Atlas app." ;;
    esac
    ;;
  MINGW* | MSYS* | CYGWIN*) asset=atlas-usage-windows-x64.exe ;;
  *) fail "there is no ready-made build for $os. Download a build from github.com/$REPO/releases or install the Atlas app." ;;
esac

[ -n "$version" ] || fail "this copy of the skill has no version, so it cannot fetch the program. Put atlas-usage on PATH, or install the plugin: /plugin marketplace add $REPO"

# The pinned hash: "<version> <asset> <sha256>", tolerant of a BOM and CRLF.
want=
if [ -f "$scriptdir/checksums.txt" ]; then
  want=$(LC_ALL=C awk -v v="$version" -v f="$asset" '
    NR == 1 && substr($0, 1, 3) == "\357\273\277" { $0 = substr($0, 4) }
    { sub(/\r$/, "") }
    ($1 "") == (v "") && ($2 "") == (f "") && $3 ~ /^[0-9A-Fa-f]+$/ && length($3) == 64 { print tolower($3); exit }
  ' "$scriptdir/checksums.txt")
fi
[ -n "$want" ] || fail "this plugin version ($version) has no pinned build yet; update the plugin, or put atlas-usage on PATH."

mkdir -p "$cacheroot" 2>/dev/null || fail "cannot write to $bindir. $hint"
# Work folders of runs that were killed mid-download: remove the ones older than an hour.
find "$cacheroot" -maxdepth 1 -type d -name '.dl*' -mmin +60 -exec rm -rf {} + >/dev/null 2>&1
# A private work folder per run: two runs at once never share a half-written file.
work=$(mktemp -d "$cacheroot/.dl.XXXXXX" 2>/dev/null) || fail "cannot write to $bindir. $hint"
trap 'rm -rf "$work"' EXIT HUP INT TERM

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | sed 's/^.*= //'
  else
    return 1
  fi
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

# curl is preferred: --proto-redir keeps every redirect on https. wget's --https-only does not
# cover redirects on every build, so wget is only a fallback and the hash pin is the guard there.
fetch() { # url dest secure(1=https only)
  if command -v curl >/dev/null 2>&1; then
    if [ "$3" = 1 ]; then
      curl -fsSL --proto =https --proto-redir =https --retry 2 --connect-timeout 20 --max-time 300 -o "$2" "$1" >/dev/null 2>&1
    else
      curl -fsSL --proto =http --proto-redir =http --retry 2 --connect-timeout 20 --max-time 300 -o "$2" "$1" >/dev/null 2>&1
    fi
  elif command -v wget >/dev/null 2>&1; then
    if [ "$3" = 1 ]; then
      wget -q --https-only -T 60 -O "$2" "$1" >/dev/null 2>&1
    else
      wget -q -T 60 -O "$2" "$1" >/dev/null 2>&1
    fi
  else
    return 1
  fi
}

printf 'atlas-usage: first use, downloading the program (one time)...\n' >&2
got=0
src=$ATLAS_USAGE_TEST_SOURCE
if [ -n "$src" ] && [ -d "$src" ]; then
  cp "$src/$asset" "$work/$asset" 2>/dev/null && got=1
elif [ -n "$src" ] && loopback_ok "$src"; then
  fetch "${src%/}/$asset" "$work/$asset" 0 && got=1
else
  # Optional: a signed-in GitHub CLI can fetch it too (the release is public, so this is not needed).
  if command -v gh >/dev/null 2>&1; then
    export GH_PROMPT_DISABLED=1
    if gh auth status >/dev/null 2>&1; then
      if gh release download "v$version" --repo "$REPO" --pattern "$asset" --dir "$work" --clobber >/dev/null 2>&1 \
        && [ -f "$work/$asset" ]; then
        got=1
      fi
    fi
  fi
  if [ "$got" = 0 ]; then
    fetch "https://github.com/$REPO/releases/download/v$version/$asset" "$work/$asset" 1 && got=1
  fi
fi
[ "$got" = 1 ] || fail "could not download the program (release v$version of github.com/$REPO). Check the internet connection, then try again. $hint"

have=$(sha256_of "$work/$asset") || fail "no tool to check the download (need sha256sum, shasum or openssl)."
if [ "$want" != "$have" ]; then
  rm -f "$work/$asset"
  fail "the downloaded program did not match the checksum pinned in this plugin, so it was deleted and not run. Try again later, or update the plugin."
fi

# Atomic rename into place. If another run got there first, its copy is just as good.
chmod +x "$work/$asset" 2>/dev/null
mkdir -p "$verdir" 2>/dev/null
mv -f "$work/$asset" "$cached" 2>/dev/null || [ -f "$cached" ] || fail "cannot save the program to $bindir. $hint"

# Drop only versions OLDER than this one (compared as versions, not strings): another plugin
# version sharing this folder keeps its own copy. Work folders start with a dot and are skipped.
for d in "$cacheroot"/*; do
  [ -d "$d" ] || continue
  if ver_older "${d##*/}" "$version"; then rm -rf "$d"; fi
done
rm -rf "$work"
trap - EXIT HUP INT TERM

say "downloaded:" "$cached"
exec "$cached" "$@"
