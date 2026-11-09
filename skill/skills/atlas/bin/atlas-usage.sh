#!/bin/sh
# Atlas launcher for macOS, Linux (and Git Bash on Windows): finds or fetches the
# atlas-usage program, then runs it with the arguments unchanged.
#   usage: sh atlas-usage.sh [--bin-dir=<folder>] <atlas-usage arguments>
# Order: (a) atlas-usage on PATH, (b) a copy cached in <folder> (the plugin data folder the
# skill passes in, else this script's own folder), (c) Windows only: the Atlas app's install
# folder, (d) download from the latest GitHub Release of dozeyy/atlas, checked against
# SHA256SUMS.txt.
# Exit code 3 = the launcher itself failed (one plain line on stderr).
# Test aid: ATLAS_USAGE_TEST_SOURCE = a local folder, or an http://127.0.0.1 / localhost
# address, that stands in for the release. ATLAS_USAGE_LAUNCHER_VERBOSE=1 names the copy used.

REPO="dozeyy/atlas"

fail() {
  printf 'atlas-usage: %s
' "$1" >&2
  exit 3
}

# --- the launcher's own option (everything after it goes to atlas-usage untouched) ---
bindir=""
case $1 in
  --bin-dir=*)
    bindir=${1#--bin-dir=}
    shift
    ;;
esac
# An unexpanded ${CLAUDE_PLUGIN_DATA} (skill installed by hand, not as a plugin) is empty or literal.
case $bindir in *'${'*) bindir="" ;; esac
if [ -z "$bindir" ]; then
  bindir=$CLAUDE_PLUGIN_DATA
  case $bindir in *'${'*) bindir="" ;; esac
fi
if [ -z "$bindir" ]; then
  bindir=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || fail "cannot find the skill folder."
fi

os=$(uname -s 2>/dev/null)
case $os in
  MINGW* | MSYS* | CYGWIN*) exe=atlas-usage.exe ;;
  *) exe=atlas-usage ;;
esac

# (a) on PATH
onpath=$(command -v atlas-usage 2>/dev/null)
if [ -n "$onpath" ] && [ -f "$onpath" ]; then
  [ -n "$ATLAS_USAGE_LAUNCHER_VERBOSE" ] && printf 'atlas-usage launcher: PATH: %s
' "$onpath" >&2
  exec "$onpath" "$@"
fi

# (b) cached copy
cached=$bindir/$exe
if [ -f "$cached" ]; then
  [ -n "$ATLAS_USAGE_LAUNCHER_VERBOSE" ] && printf 'atlas-usage launcher: cache: %s
' "$cached" >&2
  exec "$cached" "$@"
fi

# (c) the Atlas app's install folder (Windows)
if [ "$exe" = "atlas-usage.exe" ] && [ -n "$LOCALAPPDATA" ] && [ -f "$LOCALAPPDATA/Atlas/$exe" ]; then
  [ -n "$ATLAS_USAGE_LAUNCHER_VERBOSE" ] && printf 'atlas-usage launcher: Atlas app: %s
' "$LOCALAPPDATA/Atlas/$exe" >&2
  exec "$LOCALAPPDATA/Atlas/$exe" "$@"
fi

# (d) download, verify, cache
arch=$(uname -m 2>/dev/null)
case $os in
  Darwin) asset=atlas-usage-macos-universal ;;
  Linux)
    case $arch in
      x86_64 | amd64) asset=atlas-usage-linux-x64 ;;
      *) fail "there is no ready-made build for $arch yet. Build it from the Atlas repo with: cargo install --path crates/cli" ;;
    esac
    ;;
  MINGW* | MSYS* | CYGWIN*) asset=atlas-usage-windows-x64.exe ;;
  *) fail "there is no ready-made build for $os. Build it from the Atlas repo with: cargo install --path crates/cli" ;;
esac
hint="Install the Atlas app from github.com/$REPO/releases, or put atlas-usage on PATH."

mkdir -p "$bindir" 2>/dev/null || fail "cannot write to $bindir. $hint"
# A private work folder per run: two runs at once never share a half-written file.
work=$(mktemp -d "$bindir/.dl.XXXXXX" 2>/dev/null) || fail "cannot write to $bindir. $hint"
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

fetch() { # url dest
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 --connect-timeout 20 --max-time 300 -o "$2" "$1" >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 60 -O "$2" "$1" >/dev/null 2>&1
  else
    return 1
  fi
}

printf 'atlas-usage: first use, downloading the program (one time)...
' >&2
got=0
src=$ATLAS_USAGE_TEST_SOURCE
if [ -n "$src" ] && [ -d "$src" ]; then
  cp "$src/$asset" "$work/$asset" 2>/dev/null && cp "$src/SHA256SUMS.txt" "$work/SHA256SUMS.txt" 2>/dev/null && got=1
else
  base="https://github.com/$REPO/releases/latest/download"
  loopback=0
  case $src in
    http://127.0.0.1* | http://localhost*) base=${src%/}; loopback=1 ;;
  esac
  # The repo can be private: the signed-in GitHub CLI is the only thing that can reach it.
  if [ "$loopback" = 0 ] && command -v gh >/dev/null 2>&1; then
    export GH_PROMPT_DISABLED=1
    if gh auth status >/dev/null 2>&1; then
      if gh release download --repo "$REPO" --pattern "$asset" --pattern SHA256SUMS.txt --dir "$work" --clobber >/dev/null 2>&1 \
        && [ -f "$work/$asset" ] && [ -f "$work/SHA256SUMS.txt" ]; then
        got=1
      fi
    fi
  fi
  if [ "$got" = 0 ]; then
    fetch "$base/SHA256SUMS.txt" "$work/SHA256SUMS.txt" && fetch "$base/$asset" "$work/$asset" && got=1
  fi
fi
[ "$got" = 1 ] || fail "could not download the program from github.com/$REPO/releases. Check the internet connection (if the repo is private, sign in with 'gh auth login'), then try again. $hint"

# SHA-256 must match the line for this file in SHA256SUMS.txt.
want=$(tr -d '\r' <"$work/SHA256SUMS.txt" | awk -v f="$asset" '{ n = $2; sub(/^\*/, "", n); if (n == f) { print tolower($1); exit } }')
have=$(sha256_of "$work/$asset") || fail "no tool to check the download (need sha256sum, shasum or openssl)."
if [ -z "$want" ] || [ "$want" != "$have" ]; then
  rm -f "$work/$asset"
  fail "the downloaded program did not match its published checksum, so it was deleted and not run. Try again later, or install the Atlas app from github.com/$REPO/releases."
fi

# Atomic rename into place. If another run got there first, its copy is just as good.
chmod +x "$work/$asset" 2>/dev/null
mv -f "$work/$asset" "$cached" 2>/dev/null || [ -f "$cached" ] || fail "cannot save the program to $bindir. $hint"
rm -rf "$work"
trap - EXIT HUP INT TERM

[ -n "$ATLAS_USAGE_LAUNCHER_VERBOSE" ] && printf 'atlas-usage launcher: downloaded: %s
' "$cached" >&2
exec "$cached" "$@"
