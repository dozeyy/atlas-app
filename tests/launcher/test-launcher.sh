#!/bin/sh
# Tests for skill/skills/atlas/bin/atlas-usage.sh. No network: fake programs and a local folder
# stand in for the release (ATLAS_USAGE_TEST_SOURCE), and the pins are made here. The stand-in
# release is signed with a throwaway key made here (node, tests/launcher/sign-minisign.mjs).
#   usage: sh tests/launcher/test-launcher.sh [shell to run the launcher with, default sh]
# Runs on Linux, macOS and Git Bash on Windows. ATLAS_TEST_REQUIRE_SIGNATURE=1 fails the run when
# the launcher finds no openssl that can check signatures (CI sets it where one must exist).

SHELL_UNDER_TEST=${1:-sh}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
launcher_src=$repo/skill/skills/atlas/bin/atlas-usage.sh

T=$(mktemp -d "${TMPDIR:-/tmp}/atlas-launcher-test.XXXXXX")
trap 'rm -rf "$T"' EXIT

passed=0
failed=0
ok() { passed=$((passed + 1)); printf 'ok   %s\n' "$1"; }
bad() { failed=$((failed + 1)); printf 'FAIL %s\n' "$1"; [ -n "$2" ] && printf '     %s\n' "$2"; }
check() { # name condition-command...
  name=$1; shift
  if "$@"; then ok "$name"; else bad "$name" "out: $(head -c 600 "$T/out" 2>/dev/null) | err: $(head -c 600 "$T/err" 2>/dev/null)"; fi
}
has_out() { grep -q -- "$1" "$T/out"; }
has_err() { grep -q -- "$1" "$T/err"; }

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

exe=atlas-usage
case $(uname -s) in
  Darwin) asset=atlas-usage-macos-universal ;;
  Linux)
    case $(uname -m) in aarch64 | arm64) asset=atlas-usage-linux-arm64 ;; *) asset=atlas-usage-linux-x64 ;; esac
    for lm in /lib/ld-musl-*.so.1; do [ -e "$lm" ] && asset=$asset-musl; done
    ;;
  MINGW* | MSYS* | CYGWIN*) asset=atlas-usage-windows-x64.exe exe=atlas-usage.exe ;;
  *) echo "FAIL: this test runs on Linux, macOS and Git Bash"; exit 1 ;;
esac

# The stand-in release is signed with a key made now; a second key plays a stranger.
command -v node >/dev/null 2>&1 || { echo "FAIL: the tests need node to sign their stand-in release"; exit 1; }
signer=$here/sign-minisign.mjs
mkdir -p "$T/key" "$T/key2"
TESTKEY=$(node "$signer" keygen "$T/key") && [ -n "$TESTKEY" ] || { echo "FAIL: cannot make a test key"; exit 1; }
OTHERKEY=$(node "$signer" keygen "$T/key2") && [ -n "$OTHERKEY" ] || { echo "FAIL: cannot make a test key"; exit 1; }

# fake <file> <id> [old]: prints its id and arguments; an "old" one knows no repeats/debrief.
fake() {
  if [ "$3" = old ]; then
    printf '#!/bin/sh\necho "fake %s $*"\n' "$2" >"$1"
  else
    cat >"$1" <<EOF
#!/bin/sh
case "\$1 \$2" in
  "repeats --help") echo "usage: repeats, offer-note"; exit 0 ;;
  "debrief --help") echo "what this chat's helpers did"; exit 0 ;;
esac
[ "\$1" = args ] && { for a; do printf '[%s]' "\$a"; done; echo; exit 0; }
[ -n "\$FAKE_LOG" ] && echo run >>"\$FAKE_LOG"
echo "fake $2 \$*"
EOF
  fi
  chmod +x "$1"
}

# A plugin tree at $T/p<n> with the given version; the release folder $T/rel<n>.
setup() { # n version
  P=$T/p$1
  mkdir -p "$P/.claude-plugin" "$P/skills/atlas/bin"
  printf '{ "name": "atlas", "version": "%s" }\n' "$2" >"$P/.claude-plugin/plugin.json"
  cp "$launcher_src" "$P/skills/atlas/bin/atlas-usage.sh"
  printf '# test pins\n' >"$P/skills/atlas/bin/checksums.txt"
  L=$P/skills/atlas/bin/atlas-usage.sh
  PINS=$P/skills/atlas/bin/checksums.txt
  REL=$T/rel$1
  mkdir -p "$REL"
}
pin() { printf '%s %s %s\n' "$1" "$2" "$(sha "$3")" >>"$PINS"; }

# A PATH without any real atlas-usage (but with the openssl this shell would use).
mkdir -p "$T/emptybin" "$T/home" "$T/noverifier"
BASEPATH=$T/emptybin:/usr/bin:/bin:/usr/sbin:/sbin
osl=$(command -v openssl 2>/dev/null)
case ${osl%/*} in '' | /usr/bin | /bin) ;; *) BASEPATH=$T/emptybin:${osl%/*}:/usr/bin:/bin:/usr/sbin:/sbin ;; esac
command -v gh >/dev/null 2>&1 && ln -s /bin/false "$T/emptybin/gh"
# An openssl that can do nothing: the launcher must fall back to the pin alone.
printf '#!/bin/sh\nexit 1\n' >"$T/noverifier/openssl" && chmod +x "$T/noverifier/openssl"
# Each run signs the stand-in release first (NOSIGN=1 keeps hand-made files as they are).
# Settings come as assignments before the call (DATA=... run week). A POSIX shell may keep those
# after a function returns (bash 3.2 as sh on macOS does), so run clears them before it returns.
run() { # extra env assignments are given through env
  if [ -z "$NOSIGN" ] && [ -d "$REL" ]; then node "$signer" sums "$T/key" "$REL"; fi
  env -i PATH="${RUNPATH:-$BASEPATH}" HOME="$T/home" TMPDIR="$T" CLAUDE_PLUGIN_DATA="${DATA-$T/data}" \
    ATLAS_USAGE_TEST_SOURCE="${SRC-$REL}" ATLAS_USAGE_TEST_PUBKEY="${KEY-$TESTKEY}" ATLAS_USAGE_LAUNCHER_VERBOSE=1 \
    FAKE_LOG="$FAKE_LOG" ${EXTRA:+"$EXTRA"} "$SHELL_UNDER_TEST" "$L" "$@" >"$T/out" 2>"$T/err"
  run_rc=$?
  unset NOSIGN RUNPATH DATA SRC KEY FAKE_LOG EXTRA
  return $run_rc
}

# --- 1. first run downloads, checks the pin, saves, runs with the arguments unchanged
setup 1 1.0.0
fake "$REL/$asset" v1
pin 1.0.0 "$asset" "$REL/$asset"
run week --top 3; rc=$?
check "download: exit 0" [ "$rc" = 0 ]
check "download: runs with the same arguments" has_out "fake v1 week --top 3"
check "download: says what it fetched" has_err "downloading the program for"
check "download: reports size" has_err "matches the pinned checksum"
check "download: saved under the plugin data folder" [ -x "$T/data/cache/1.0.0/$exe" ]

# --- 2. second run uses the saved copy
run today; rc=$?
check "cache: used" has_err "launcher: cache:"
check "cache: output" has_out "fake v1 today"

# --- 3. a saved copy that no longer matches its pin is deleted and fetched again
printf '#!/bin/sh\necho tampered\n' >"$T/data/cache/1.0.0/$exe"
run today; rc=$?
check "tampered cache: not run" sh -c "! grep -q tampered '$T/out'"
check "tampered cache: refetched and run" has_out "fake v1 today"
check "tampered cache: says so" has_err "did not match the checksum"

# --- 4. checksum mismatch on download: exit 3, nothing saved
setup 2 2.0.0
fake "$REL/$asset" v2
printf '2.0.0 %s %s\n' "$asset" 0000000000000000000000000000000000000000000000000000000000000000 >>"$PINS"
DATA=$T/data2 run week; rc=$?
check "mismatch: exit 3" [ "$rc" = 3 ]
check "mismatch: message" has_err "did not match the checksum pinned"
check "mismatch: nothing saved" [ ! -e "$T/data2/cache/2.0.0/$exe" ]

# --- 5. no pin for this version: exit 3 and the exact update command
setup 3 3.0.0
fake "$REL/$asset" v3
DATA=$T/data3 run week; rc=$?
check "no pin: exit 3" [ "$rc" = 3 ]
check "no pin: names the update command" has_err "/plugin marketplace update atlas"

# --- 6. a version with pins, but none for this computer
setup 4 4.0.0
fake "$REL/other" v4
pin 4.0.0 atlas-usage-some-other-computer "$REL/other"
DATA=$T/data4 run week; rc=$?
check "no build for this computer: exit 3" [ "$rc" = 3 ]
check "no build for this computer: says so" has_err "no ready-made build for"

# --- 7. offline after a plugin update: the older saved copy answers, with a note
setup 5 1.0.0
fake "$REL/$asset" v1
pin 1.0.0 "$asset" "$REL/$asset"
DATA=$T/data5 run week
check "offline setup: v1 saved" [ -x "$T/data5/cache/1.0.0/$exe" ]
fake "$T/v11" v1.1
pin 1.1.0 "$asset" "$T/v11"
sed 's/"1.0.0"/"1.1.0"/' "$P/.claude-plugin/plugin.json" >"$T/pj" && mv "$T/pj" "$P/.claude-plugin/plugin.json"
rm -f "$REL/$asset"
DATA=$T/data5 run week; rc=$?
check "offline: exit 0" [ "$rc" = 0 ]
check "offline: older copy answers" has_out "fake v1 week"
check "offline: says which version" has_err "comes from the older v1.0.0"
cp "$T/v11" "$REL/$asset"
DATA=$T/data5 run week; rc=$?
check "back online: new version" has_out "fake v1.1 week"
check "back online: older copy pruned" [ ! -e "$T/data5/cache/1.0.0" ]

# --- 8. a copy on PATH: an old pinned release is passed over, an unknown build is used
setup 6 2.0.0
fake "$T/oldbin-v1" v1
pin 1.0.0 "$asset" "$T/oldbin-v1"
fake "$REL/$asset" v2
pin 2.0.0 "$asset" "$REL/$asset"
mkdir -p "$T/pathold" "$T/pathdev"
cp "$T/oldbin-v1" "$T/pathold/$exe"
RUNPATH=$T/pathold:$BASEPATH DATA=$T/data6 run week; rc=$?
check "PATH old release: passed over" has_err "passed over"
check "PATH old release: current build runs" has_out "fake v2 week"
fake "$T/pathdev/$exe" dev
RUNPATH=$T/pathdev:$BASEPATH DATA=$T/data6 run week; rc=$?
check "PATH own build: used" has_out "fake dev week"
# Offline with only the old PATH copy: it is the last resort.
setup 7 2.0.0
pin 1.0.0 "$asset" "$T/oldbin-v1"
fake "$T/v2b" v2
pin 2.0.0 "$asset" "$T/v2b"
RUNPATH=$T/pathold:$BASEPATH DATA=$T/data7 run week; rc=$?
check "offline, old PATH copy: last resort" has_out "fake v1 week"

# --- 9. too old for repeats: exit 4; a good copy's check is remembered
setup 8 1.0.0
fake "$REL/$asset" v1 old
pin 1.0.0 "$asset" "$REL/$asset"
DATA=$T/data8 run repeats --like "x" --json; rc=$?
check "too old: exit 4" [ "$rc" = 4 ]
check "too old: names the update command" has_err "/plugin marketplace update atlas"
setup 9 1.0.0
fake "$REL/$asset" v1
pin 1.0.0 "$asset" "$REL/$asset"
DATA=$T/data9 run debrief --detail low; rc=$?
check "debrief: runs" has_out "fake v1 debrief --detail low"
check "debrief: check remembered" sh -c "ls '$T/data9/cache/caps/' | grep -q '\\.debrief\$'"

# --- 10. ATLAS_USAGE_BIN
fake "$T/mine" mine
EXTRA="ATLAS_USAGE_BIN=$T/mine" DATA=$T/data9 run week; rc=$?
check "ATLAS_USAGE_BIN: used" has_out "fake mine week"
EXTRA="ATLAS_USAGE_BIN=$T/nope" DATA=$T/data9 run week; rc=$?
check "ATLAS_USAGE_BIN missing: exit 3" [ "$rc" = 3 ]

# --- 11. launcher-doctor runs nothing
FAKE_LOG=$T/runs.log DATA=$T/data9 run launcher-doctor; rc=$?
check "doctor: exit 0" [ "$rc" = 0 ]
check "doctor: names the copy" has_out "would run"
check "doctor: ran nothing" [ ! -e "$T/runs.log" ]
DATA=$T/data-doctor-empty run launcher-doctor
check "doctor: would download" has_out "one-time download"
check "doctor: downloaded nothing" [ ! -e "$T/data-doctor-empty/cache/1.0.0" ]

# --- 12. no plugin data folder: a per-user cache folder, not the plugin folder
setup 10 1.0.0
fake "$REL/$asset" v1
pin 1.0.0 "$asset" "$REL/$asset"
lad=
case $(uname -s) in
  Darwin) want_dir=$T/home/Library/Caches/atlas/skill/cache/1.0.0 ;;
  MINGW* | MSYS* | CYGWIN*) want_dir=$T/lad/atlas/skill/cache/1.0.0 lad=LOCALAPPDATA=$T/lad ;;
  *) want_dir=$T/home/.cache/atlas/skill/cache/1.0.0 ;;
esac
EXTRA=$lad DATA='' run week; rc=$?
check "user cache: used" [ -x "$want_dir/$exe" ]
check "user cache: not in the plugin folder" [ ! -e "$P/skills/atlas/bin/cache" ]

# --- 13. two runs at once: one download, both answer
setup 11 1.0.0
fake "$REL/$asset" v1
pin 1.0.0 "$asset" "$REL/$asset"
node "$signer" sums "$T/key" "$REL"
env -i PATH="$BASEPATH" HOME="$T/home" TMPDIR="$T" CLAUDE_PLUGIN_DATA="$T/data11" ATLAS_USAGE_TEST_SOURCE="$REL" \
  ATLAS_USAGE_TEST_PUBKEY="$TESTKEY" "$SHELL_UNDER_TEST" "$L" week >"$T/outA" 2>"$T/errA" &
env -i PATH="$BASEPATH" HOME="$T/home" TMPDIR="$T" CLAUDE_PLUGIN_DATA="$T/data11" ATLAS_USAGE_TEST_SOURCE="$REL" \
  ATLAS_USAGE_TEST_PUBKEY="$TESTKEY" "$SHELL_UNDER_TEST" "$L" week >"$T/outB" 2>"$T/errB"
wait
check "parallel: first answers" grep -q "fake v1 week" "$T/outA"
check "parallel: second answers" grep -q "fake v1 week" "$T/outB"
check "parallel: no lock left" sh -c "! ls -a '$T/data11/cache' | grep -q '^\\.lock'"
check "parallel: no work folder left" sh -c "! ls -a '$T/data11/cache' | grep -q '^\\.dl'"

# --- 14. a loopback address stands in for the release (http), when python3 is here
if command -v python3 >/dev/null 2>&1 && python3 -c "import http.server" >/dev/null 2>&1; then
  setup 12 1.0.0
  fake "$REL/$asset" v1
  pin 1.0.0 "$asset" "$REL/$asset"
  port=$((20000 + $$ % 20000))
  (cd "$REL" && exec python3 -m http.server "$port" --bind 127.0.0.1) >/dev/null 2>&1 &
  srv=$!
  i=0
  while [ $i -lt 50 ] && ! curl -fs "http://127.0.0.1:$port/" >/dev/null 2>&1; do sleep 0.1; i=$((i + 1)); done
  SRC=http://127.0.0.1:$port DATA=$T/data12 run week; rc=$?
  kill "$srv" 2>/dev/null
  check "loopback: downloads and runs" has_out "fake v1 week"
fi

# --- 15. the signed checksum list (SHA256SUMS.txt + .sig from the same release)
sigsetup() { # n: a fresh plugin + release with a pinned v1 program
  setup "$1" 1.0.0
  fake "$REL/$asset" v1
  pin 1.0.0 "$asset" "$REL/$asset"
  fake "$REL/other-file" other
}
sigsetup 13
DATA=$T/data13 run launcher-doctor
if has_out "checked on download with openssl"; then
  sigsetup 14
  DATA=$T/data14 run week; rc=$?
  check "signature: good list, exit 0" [ "$rc" = 0 ]
  check "signature: good list, runs" has_out "fake v1 week"
  check "signature: says it was checked" has_err "signed release list"
  check "signature: recorded for the saved copy" grep -qx checked "$T/data14/cache/1.0.0/signature"
  DATA=$T/data14 run launcher-doctor
  check "signature: doctor reports the saved copy" has_out "checked when it was saved"

  refused() { # name data-folder message
    check "$1: exit 3" [ "$rc" = 3 ]
    check "$1: says why" has_err "$3"
    check "$1: names the update command" has_err "/plugin marketplace update atlas"
    check "$1: not run" sh -c "! grep -q 'fake v1' '$T/out'"
    check "$1: nothing saved" [ ! -e "$2/cache/1.0.0/$exe" ]
  }
  # one byte of the list changed after signing
  sigsetup 15
  node "$signer" sums "$T/key" "$REL"
  sed 's/other-file/other-filf/' "$REL/SHA256SUMS.txt" >"$T/sums" && mv "$T/sums" "$REL/SHA256SUMS.txt"
  NOSIGN=1 DATA=$T/data15 run week
  rc=$?; refused "list changed after signing" "$T/data15" "not signed by the Atlas key"
  # one byte of the trusted comment changed
  sigsetup 16
  node "$signer" sums "$T/key" "$REL"
  openssl base64 -d -A -in "$REL/SHA256SUMS.txt.sig" -out "$T/sigtxt"
  sed 's/file:/fild:/' "$T/sigtxt" >"$T/sigtxt2" && openssl base64 -A -in "$T/sigtxt2" -out "$REL/SHA256SUMS.txt.sig"
  NOSIGN=1 DATA=$T/data16 run week
  rc=$?; refused "trusted comment changed" "$T/data16" "not signed by the Atlas key"
  # signed by another key
  sigsetup 17
  node "$signer" sums "$T/key2" "$REL"
  NOSIGN=1 DATA=$T/data17 run week
  rc=$?; refused "another key" "$T/data17" "not signed by the Atlas key"
  # a well-signed list that gives the program another hash
  sigsetup 18
  printf '%s  %s\n' 1111111111111111111111111111111111111111111111111111111111111111 "$asset" >"$REL/SHA256SUMS.txt"
  node "$signer" sign "$T/key" "$REL/SHA256SUMS.txt"
  NOSIGN=1 DATA=$T/data18 run week
  rc=$?; refused "list disagrees with the pin" "$T/data18" "does not list this program with the pinned checksum"
  # a well-signed list without the program
  sigsetup 19
  printf '%s  other-file\n' "$(sha "$REL/other-file")" >"$REL/SHA256SUMS.txt"
  node "$signer" sign "$T/key" "$REL/SHA256SUMS.txt"
  NOSIGN=1 DATA=$T/data19 run week
  rc=$?; refused "list without the program" "$T/data19" "does not list this program with the pinned checksum"
  # the release has no signed list: treated as a failed download
  sigsetup 20
  NOSIGN=1 DATA=$T/data20 run week; rc=$?
  check "no list: exit 3" [ "$rc" = 3 ]
  check "no list: says the download failed" has_err "could not download"
  check "no list: nothing saved" [ ! -e "$T/data20/cache/1.0.0/$exe" ]
  # the legacy unhashed "Ed" form, even when its signature is good, is refused
  sigsetup 24
  node "$signer" sums-legacy "$T/key" "$REL"
  NOSIGN=1 DATA=$T/data24 run week
  rc=$?; refused "legacy Ed signature" "$T/data24" "not signed by the Atlas key"
  # an openssl without pkeyutl -rawin (1.1.1) fails the self-test: the pin alone decides
  mkdir -p "$T/oldssl"
  # shellcheck disable=SC2016 # the $ signs belong to the script being written
  printf '#!/bin/sh\nfor a; do [ "$a" = -rawin ] && { echo "pkeyutl: Unknown option: -rawin" >&2; exit 1; }; done\nexec "%s" "$@"\n' \
    "$(command -v openssl)" >"$T/oldssl/openssl" && chmod +x "$T/oldssl/openssl"
  sigsetup 25
  RUNPATH=$T/oldssl:$BASEPATH DATA=$T/data25 run week; rc=$?
  check "openssl 1.1.1 (no -rawin): exit 0" [ "$rc" = 0 ]
  check "openssl 1.1.1 (no -rawin): runs on the pin" has_out "fake v1 week"
  check "openssl 1.1.1 (no -rawin): recorded unchecked" grep -qx unchecked "$T/data25/cache/1.0.0/signature"
  RUNPATH=$T/oldssl:$BASEPATH DATA=$T/data25 run launcher-doctor
  check "openssl 1.1.1 (no -rawin): doctor says not checked" has_out "NOT checked on this computer"
  # the test key counts only together with a stand-in release
  SRC='' DATA=$T/data20 run launcher-doctor
  check "test key: ignored without a stand-in release" has_out "against the Atlas release key"
else
  if [ -n "$ATLAS_TEST_REQUIRE_SIGNATURE" ]; then
    bad "signature: openssl here cannot check Ed25519, and ATLAS_TEST_REQUIRE_SIGNATURE is set" "$(openssl version 2>&1)"
  else
    printf 'note this openssl cannot check Ed25519 (%s): signature refusals not tested here\n' "$(openssl version 2>&1)"
  fi
fi
# no verifier: the pin alone decides, and normal runs say nothing about it
sigsetup 21
RUNPATH=$T/noverifier:$BASEPATH DATA=$T/data21 run week; rc=$?
check "no verifier: exit 0" [ "$rc" = 0 ]
check "no verifier: runs on the pin" has_out "fake v1 week"
check "no verifier: quiet about it" sh -c "! grep -qi 'sign' '$T/err'"
check "no verifier: recorded" grep -qx unchecked "$T/data21/cache/1.0.0/signature"
RUNPATH=$T/noverifier:$BASEPATH DATA=$T/data21 run launcher-doctor
check "no verifier: doctor says so" has_out "NOT checked on this computer"
check "no verifier: doctor on the saved copy" has_out "not checked when it was saved"

# --- 16. a saved copy that cannot be read to hash it is never run: deleted and fetched again
setup 22 1.0.0
fake "$REL/$asset" v1
pin 1.0.0 "$asset" "$REL/$asset"
DATA=$T/data22 run week
chmod 111 "$T/data22/cache/1.0.0/$exe"
if [ -r "$T/data22/cache/1.0.0/$exe" ]; then
  printf 'note mode 111 leaves the file readable here (Windows or root): unreadable copy not tested\n'
else
  DATA=$T/data22 run today; rc=$?
  check "unreadable cache: exit 0" [ "$rc" = 0 ]
  check "unreadable cache: refetched and run" has_out "fake v1 today"
  check "unreadable cache: says so" has_err "could not be read to check it"
fi

# --- 17. the copy cannot be replaced (folder read-only): the one already there runs only if it matches
setup 23 1.0.0
fake "$REL/$asset" v1
pin 1.0.0 "$asset" "$REL/$asset"
DATA=$T/data23 run week
printf '#!/bin/sh\necho tampered\n' >"$T/data23/cache/1.0.0/$exe"
chmod 555 "$T/data23/cache/1.0.0"
if [ -w "$T/data23/cache/1.0.0" ]; then
  printf 'note mode 555 leaves the folder writable here (Windows or root): unreplaceable copy not tested\n'
else
  DATA=$T/data23 run today; rc=$?
  check "unreplaceable copy: exit 3" [ "$rc" = 3 ]
  check "unreplaceable copy: not run" sh -c "! grep -q tampered '$T/out'"
  check "unreplaceable copy: says so" has_err "the copy already there does not match its pin"
fi
chmod 755 "$T/data23/cache/1.0.0"

# --- 18. the stand-in release must be on this computer: a network path is refused
setup 26 1.0.0
fake "$REL/$asset" v1
pin 1.0.0 "$asset" "$REL/$asset"
SRC=//localhost/share DATA=$T/data26 run week; rc=$?
check "network stand-in: exit 3" [ "$rc" = 3 ]
check "network stand-in: says so" has_err "network paths are refused"
check "network stand-in: nothing saved" [ ! -e "$T/data26/cache/1.0.0/$exe" ]

# --- 19. arguments reach the program unchanged: empty ones, spaces, quotes, backslashes
# shellcheck disable=SC1003 # a trailing backslash inside single quotes, on purpose
DATA=$T/data26 run args '' 'a "b" c' 'x\' 'tail\"q'; rc=$?
check "arguments: exit 0" [ "$rc" = 0 ]
check "arguments: unchanged" grep -qxF '[args][][a "b" c][x\][tail\"q]' "$T/out"

# --- 20. a lock left by a killed run is taken over, and only this run's own lock is removed
setup 27 1.0.0
fake "$REL/$asset" v1
pin 1.0.0 "$asset" "$REL/$asset"
mkdir -p "$T/data27/cache/.lock-1.0.0"
echo someone-else >"$T/data27/cache/.lock-1.0.0/owner"
touch -t 202001010000 "$T/data27/cache/.lock-1.0.0"
DATA=$T/data27 run week; rc=$?
check "stale lock: taken over, runs" has_out "fake v1 week"
check "stale lock: no lock left" sh -c "! ls -a '$T/data27/cache' | grep -q '^\\.lock'"
check "stale lock: no work folder left" sh -c "! ls -a '$T/data27/cache' | grep -q '^\\.dl'"

printf '\n%s passed, %s failed (%s)\n' "$passed" "$failed" "$SHELL_UNDER_TEST"
[ "$failed" = 0 ]
