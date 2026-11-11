#!/bin/bash
# The macOS proof run: checks the built app the way a Mac user meets it, and takes pictures.
# Runs on any Mac and on GitHub's macOS runners (.github/workflows/mac-check.yml).
#
#   tools/mac-check.sh [OUT_DIR]                    (default: mac-check-out)
#
# Expects these to be built first (the workflow does it; see its steps for the commands):
#   release app + dmg   target/universal-apple-darwin/release/bundle/{macos/Atlas.app,dmg/*.dmg}
#   debug app (tour)    target/debug/bundle/macos/Atlas.app        npx tauri build --debug --bundles app
#   atlas-usage         target/atlas-usage-universal (lipo), else target/release/atlas-usage
# Override with ATLAS_REL_APP, ATLAS_DMG, ATLAS_DBG_APP, ATLAS_USAGE_BIN.
#
# Everything runs against a made-up Claude folder (tools/make-demo-fixture.py) in a temp HOME, with
# ATLAS_DATA_DIR in a temp folder: the real ~/.claude, ~/.claude.json and Atlas data are never read
# or written. No transcript text from a real machine can reach the pictures or logs.
# Exit code: 0 when every check passed, 1 when one failed (OUT_DIR/summary.txt says which).
# Checks that need macOS permissions a machine may not grant (keyboard via System Events) are
# reported as "skip", never as a pass.

set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 2
OUT=${1:-mac-check-out}
mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd)
SUM=$OUT/summary.txt
: >"$SUM"
FAILED=0
ok() { printf 'ok    %s\n' "$*" | tee -a "$SUM"; }
bad() { printf 'FAIL  %s\n' "$*" | tee -a "$SUM"; FAILED=1; }
skip() { printf 'skip  %s\n' "$*" | tee -a "$SUM"; }
note() { printf '      %s\n' "$*" | tee -a "$SUM"; }

[ "$(uname -s)" = Darwin ] || { echo "mac-check.sh runs on macOS only." >&2; exit 2; }

REL=${ATLAS_REL_APP:-target/universal-apple-darwin/release/bundle/macos/Atlas.app}
DMG=${ATLAS_DMG:-$(ls target/universal-apple-darwin/release/bundle/dmg/*.dmg 2>/dev/null | head -n 1)}
DBG=${ATLAS_DBG_APP:-target/debug/bundle/macos/Atlas.app}
CLI=${ATLAS_USAGE_BIN:-}
[ -n "$CLI" ] || { [ -x target/atlas-usage-universal ] && CLI=target/atlas-usage-universal; }
[ -n "$CLI" ] || CLI=target/release/atlas-usage

T=$(mktemp -d /tmp/atlas-mac-check.XXXXXX)
PIDS=""
cleanup() {
  for p in $PIDS; do kill "$p" 2>/dev/null; done
  [ -d "$T/dmg-mount" ] && hdiutil detach -quiet "$T/dmg-mount" 2>/dev/null
  rm -rf "$T"
}
trap cleanup EXIT

exe_of() { echo "$1/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$1/Contents/Info.plist")"; }

# ---- 0. The machine and the made-up Claude folder -------------------------------------------
{
  sw_vers
  uname -m
  system_profiler SPDisplaysDataType 2>/dev/null | grep -E 'Resolution|Retina|Main Display' | sed 's/^ *//'
} >"$OUT/machine.txt" 2>&1
note "machine: $(sw_vers -productVersion) $(uname -m), $(grep -m1 Resolution "$OUT/machine.txt" | sed 's/^Resolution: //')"

if python3 tools/make-demo-fixture.py "$T/fx" --live >"$OUT/fixture.log" 2>&1 && [ -d "$T/fx/home/.claude" ]; then
  ok "made-up Claude folder built (tools/make-demo-fixture.py)"
else
  bad "could not build the made-up Claude folder (fixture.log)"
  exit 1
fi
FXHOME=$T/fx/home
case "$FXHOME" in "$HOME" | "$HOME"/*) bad "the temp HOME is inside the real HOME"; exit 1 ;; esac

if swiftc -O -o "$T/winlist" tools/mac-windows.swift >"$OUT/swiftc.log" 2>&1; then :; else bad "could not build the window lister (swiftc.log)"; fi
windows_of() { [ -x "$T/winlist" ] && "$T/winlist" "$1" 2>/dev/null; }
# The first window at least 400 points wide: "<id> <x,y,w,h>".
main_window() { windows_of "$1" | awk '{ split($2, r, ","); if (r[3] >= 400) { print; exit } }'; }

# Starts an app with the made-up HOME and its own data folder; prints the pid.
launch() { # app data-dir log [VAR=value ...]
  local app=$1 data=$2 log=$3
  shift 3
  mkdir -p "$data"
  env -u CLAUDE_CONFIG_DIR HOME="$FXHOME" ATLAS_DATA_DIR="$data" ATLAS_NO_INTRO=1 ATLAS_MULTI=1 "$@" \
    "$(exe_of "$app")" >"$log" 2>&1 &
  echo $!
}
wait_window() { # pid seconds -> prints "<id> <rect>" or nothing
  local i=0
  while [ "$i" -lt "$(($2 * 4))" ]; do
    kill -0 "$1" 2>/dev/null || return 1
    local w
    w=$(main_window "$1")
    [ -n "$w" ] && { echo "$w"; return 0; }
    sleep 0.25
    i=$((i + 1))
  done
  return 1
}
keys() { # System Events keystroke; returns non-zero when this machine does not allow it
  osascript -e "tell application \"System Events\" to keystroke \"$1\" using command down" >>"$OUT/osascript.log" 2>&1
}

mkdir -p "$OUT/app" "$OUT/tour" "$OUT/dmg" "$OUT/cli"

# ---- 1. The release bundle --------------------------------------------------------------------
if [ -d "$REL" ]; then
  BIN=$(exe_of "$REL")
  archs=$(lipo -archs "$BIN" 2>/dev/null)
  case " $archs " in *" arm64 "*) case " $archs " in *" x86_64 "*) ok "universal app: $archs" ;; *) bad "app is not universal: $archs" ;; esac ;; *) bad "app is not universal: $archs" ;; esac
  /usr/libexec/PlistBuddy -c Print "$REL/Contents/Info.plist" >"$OUT/app/Info.plist.txt" 2>&1
  note "bundle id $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$REL/Contents/Info.plist"), min macOS $(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$REL/Contents/Info.plist" 2>/dev/null)"
  if codesign --verify --deep --strict --verbose=2 "$REL" >"$OUT/app/codesign-verify.txt" 2>&1; then
    ok "codesign --verify --deep --strict passes"
  else
    bad "codesign --verify failed (app/codesign-verify.txt)"
  fi
  codesign -dv --verbose=2 "$REL" >"$OUT/app/codesign-details.txt" 2>&1
  if grep -q 'Signature=adhoc' "$OUT/app/codesign-details.txt"; then ok "app is ad-hoc signed (no Apple account)"; else note "signature: $(grep -m1 -E '^(Signature|Authority)=' "$OUT/app/codesign-details.txt")"; fi
  # What a downloaded copy meets: quarantine on, Gatekeeper asked. Expected: rejected (not
  # notarized), which is why the README has the Open Anyway steps. Recorded, not judged.
  mkdir -p "$T/q" && ditto "$REL" "$T/q/Atlas.app" &&
    xattr -w com.apple.quarantine "0083;$(printf '%x' "$(date +%s)");Safari;" "$T/q/Atlas.app" &&
    spctl -a -t exec -vv "$T/q/Atlas.app" >"$OUT/app/gatekeeper-quarantined.txt" 2>&1
  note "Gatekeeper on a downloaded copy: $(head -n 1 "$OUT/app/gatekeeper-quarantined.txt")"
  if [ "${ATLAS_EXPECT_UPDATER:-0}" = 1 ]; then
    upd=$(dirname "$REL")
    if [ -s "$upd/Atlas.app.tar.gz" ] && [ -s "$upd/Atlas.app.tar.gz.sig" ]; then ok "update bundle + signature made (Atlas.app.tar.gz, .sig)"; else bad "update bundle or signature missing in $upd"; fi
  fi
else
  bad "no release app at $REL"
fi

# ---- 2. The release app, launched -------------------------------------------------------------
if [ -d "$REL" ]; then
  # Record this first launch (a fresh data folder, so the first read runs with the window up). A
  # state that shows for a fraction of a second is caught here by a rule: in 0.1.5 "Could not load
  # your usage" flashed for about 0.4 s as the first read ended. Frames at 10 a second, read by
  # Apple's Vision text recognition (tools/mac-ocr.swift).
  REC=""
  command -v ffmpeg >/dev/null || brew install ffmpeg >"$OUT/app/brew.log" 2>&1
  if command -v ffmpeg >/dev/null && swiftc -O -o "$T/ocr" tools/mac-ocr.swift >"$OUT/app/swiftc-ocr.log" 2>&1; then
    screen=$(ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | sed -n 's/.*\[\([0-9]*\)\] Capture screen 0.*/\1/p' | head -n 1)
    ffmpeg -hide_banner -loglevel error -f avfoundation -framerate 30 -i "${screen:-1}:none" \
      -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p "$T/first-launch.mov" </dev/null >"$OUT/app/ffmpeg.log" 2>&1 &
    REC=$!
    PIDS="$PIDS $REC"
    sleep 3
    kill -0 "$REC" 2>/dev/null || REC=""
  fi
  pid=$(launch "$REL" "$T/data-release" "$OUT/app/release.log")
  PIDS="$PIDS $pid"
  if win=$(wait_window "$pid" 60); then
    ok "release app opened its window ($(echo "$win" | cut -d' ' -f2))"
    sleep 10 # the first index of ~90 days of made-up chats, and the page settling
    screencapture -x -o -l"$(echo "$win" | cut -d' ' -f1)" "$OUT/app/release-window.png"
    screencapture -x "$OUT/app/release-screen.png" # menu bar, menu-bar icon, Dock
    ls "$T/data-release" >"$OUT/app/release-data-dir.txt" 2>&1
    [ -s "$OUT/app/release-data-dir.txt" ] && ok "Atlas keeps its data in the chosen folder: $(tr '\n' ' ' <"$OUT/app/release-data-dir.txt")" || bad "nothing in the chosen data folder (ATLAS_DATA_DIR ignored?)"
    if [ -n "$REC" ]; then
      kill -INT "$REC" 2>/dev/null
      wait "$REC" 2>/dev/null
      mkdir -p "$T/frames"
      ffmpeg -hide_banner -loglevel error -i "$T/first-launch.mov" -vf fps=10 "$T/frames/f%04d.png" 2>>"$OUT/app/ffmpeg.log"
      ffmpeg -hide_banner -loglevel error -i "$T/first-launch.mov" -c:v libx264 -preset slow -crf 24 -pix_fmt yuv420p \
        -movflags +faststart "$OUT/app/first-launch.mp4" 2>>"$OUT/app/ffmpeg.log"
      "$T/ocr" "$T/frames" "Could not load your usage" "Atlas could not read your usage" "Reading your sessions" "Last 7 days" \
        >"$OUT/app/first-launch-ocr.txt" 2>&1
      count() { awk -F'\t' -v p="$1" '$1 == p { print $2 }' "$OUT/app/first-launch-ocr.txt"; }
      frames=$(count frames)
      e1=$(count "Could not load your usage")
      e2=$(count "Atlas could not read your usage")
      errs=$((${e1:-0} + ${e2:-0}))
      reading=$(count "Reading your sessions")
      numbers=$(count "Last 7 days")
      for f in $(awk -F'\t' 'tolower($1) ~ /could not/ { print $3 }' "$OUT/app/first-launch-ocr.txt"); do cp "$T/frames/$f" "$OUT/app/first-launch-error-$f"; done
      if [ "${numbers:-0}" -eq 0 ]; then
        bad "first launch: the Dashboard's numbers never showed in ${frames:-0} frames (app/first-launch-ocr.txt, app/first-launch.mp4)"
      elif [ "$errs" -gt 0 ]; then
        bad "first launch: an error showed in $errs of $frames frames (app/first-launch-error-*.png)"
      else
        ok "first launch: no error in $frames frames at 10 a second (first read on screen in ${reading:-0}, numbers in $numbers)"
      fi
    else
      skip "first launch not recorded (no ffmpeg or text recognition: app/ffmpeg.log, app/brew.log, app/swiftc-ocr.log)"
    fi
    # The native menu bar: open the Atlas and Edit menus and take a picture of each.
    for m in Atlas Edit Window; do
      if osascript -e "tell application \"System Events\" to tell (first process whose unix id is $pid) to click menu bar item \"$m\" of menu bar 1" >>"$OUT/osascript.log" 2>&1; then
        sleep 0.8
        screencapture -x -R0,0,900,420 "$OUT/app/menu-$(echo "$m" | tr 'A-Z' 'a-z').png"
        osascript -e 'tell application "System Events" to key code 53' >>"$OUT/osascript.log" 2>&1
        sleep 0.3
        ok "menu bar has the $m menu (picture app/menu-$(echo "$m" | tr 'A-Z' 'a-z').png)"
      else
        skip "could not open the $m menu (System Events not allowed here: osascript.log)"
      fi
    done
    # Close with Cmd+W: the window goes, Atlas keeps running (Dock). Open it again from the Dock
    # (open = the Dock click, a reopen event). Then Cmd+Q quits.
    osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $pid) to true" >>"$OUT/osascript.log" 2>&1
    sleep 0.5
    if keys w; then
      sleep 2
      if kill -0 "$pid" 2>/dev/null && [ -z "$(main_window "$pid")" ]; then
        ok "Cmd+W hides the window and Atlas keeps running"
        open "$REL" >>"$OUT/osascript.log" 2>&1
        if win=$(wait_window "$pid" 15); then
          ok "opening Atlas again (Dock click) brings the window back"
          screencapture -x -o -l"$(echo "$win" | cut -d' ' -f1)" "$OUT/app/release-reopened.png"
        else
          bad "the window did not come back after a reopen"
        fi
      else
        bad "Cmd+W did not behave (window still there, or the app quit)"
      fi
      osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $pid) to true" >>"$OUT/osascript.log" 2>&1
      sleep 0.5
      keys q
      i=0
      while kill -0 "$pid" 2>/dev/null && [ $i -lt 40 ]; do sleep 0.25; i=$((i + 1)); done
      if kill -0 "$pid" 2>/dev/null; then bad "Cmd+Q did not quit Atlas"; else ok "Cmd+Q quits Atlas"; fi
    else
      skip "keyboard checks (Cmd+W, reopen, Cmd+Q): System Events not allowed here (osascript.log)"
    fi
  else
    bad "release app showed no window in 60 s (app/release.log)"
  fi
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  # Never in a release build: the screenshot tour.
  if strings "$(exe_of "$REL")" | grep -q 'ATLAS_SHOT_TOUR'; then bad "the release build contains the screenshot tour"; else ok "the release build has no screenshot tour in it"; fi
  # The release frontend (dist/, built last by the universal build) must not ship the tour chunk.
  if grep -rl 'shotTour' dist >/dev/null 2>&1; then bad "the release frontend ships the tour: $(grep -rl 'shotTour' dist | tr '\n' ' ')"; else ok "the release frontend (dist/) has no shotTour chunk"; fi
fi

# ---- 3. The screenshot tour (debug app): every page, light, dark, small -----------------------
if [ -d "$DBG" ]; then
  TOUR=$OUT/tour
  pid=$(launch "$DBG" "$T/data-tour" "$OUT/tour/app.log" ATLAS_SHOT_TOUR="$TOUR")
  PIDS="$PIDS $pid"
  end=$(($(date +%s) + 900))
  shots=0
  touched=0
  while [ ! -f "$TOUR/done.txt" ] && [ "$(date +%s)" -lt "$end" ] && kill -0 "$pid" 2>/dev/null; do
    # The fixture's two live chats stay live for the whole tour (Now drops a chat that has not
    # been written to for two minutes): touch them every 20 s, as a working Claude Code would.
    if [ $(($(date +%s) - touched)) -ge 20 ] && [ -f "$T/fx/live.txt" ]; then
      while IFS= read -r f; do [ -f "$f" ] && touch "$f"; done <"$T/fx/live.txt"
      touched=$(date +%s)
    fi
    for req in "$TOUR"/req/*.rect; do
      [ -f "$req" ] || continue
      name=$(basename "$req" .rect)
      rect=$(cat "$req")
      # The window itself by its id (exact, whatever the screen size); the app's rectangle only
      # when the window cannot be found. The window's real size goes in sizes.txt.
      win=$(main_window "$pid")
      if [ -n "$win" ]; then
        screencapture -x -o -l"${win%% *}" "$TOUR/$name.png" 2>>"$OUT/tour/screencapture.log"
        echo "$name ${win#* }" >>"$OUT/tour/sizes.txt"
      else
        screencapture -x -R"$rect" "$TOUR/$name.png" 2>>"$OUT/tour/screencapture.log"
        echo "$name $rect (by rectangle)" >>"$OUT/tour/sizes.txt"
      fi
      rm -f "$req"
      shots=$((shots + 1))
    done
    sleep 0.2
  done
  if [ -f "$TOUR/done.txt" ]; then ok "the tour finished: $shots pictures"; else bad "the tour did not finish (tour/tour.log, tour/app.log)"; fi
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  rm -rf "$TOUR/req"
  n=$(ls "$TOUR"/*.png 2>/dev/null | wc -l | tr -d ' ')
  # 27 stops light + 27 dark at 1280x800 (the 12 pages and views and the 15 Wrapped slides) and 13 at 900x600: src/lib/shotTour.ts.
  [ "$n" -ge 67 ] && ok "$n tour pictures (expected 67)" || bad "only $n tour pictures (expected 67)"
  [ -f "$TOUR/sizes.txt" ] && note "window sizes captured: $(awk '{ split($2, r, ","); print r[3] "x" r[4] }' "$TOUR/sizes.txt" | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
  if grep -E 'no picture|failed|tour stopped' "$TOUR/tour.log" >/dev/null 2>&1; then
    bad "tour steps went wrong: $(grep -cE 'no picture|failed|tour stopped' "$TOUR/tour.log") (tour/tour.log)"
  fi
  if grep -E ': no |not ready' "$TOUR/tour.log" >/dev/null 2>&1; then
    note "missing targets: $(grep -E ': no |not ready' "$TOUR/tour.log" | tr '\n' ';')"
  fi
  grep 'page scrolls' "$TOUR/tour.log" | sed 's/^/      scroll: /' >>"$SUM"
else
  bad "no debug app at $DBG (npx tauri build --debug --bundles app)"
fi

# ---- 4. The disk image: what a download looks like in Finder ----------------------------------
if [ -n "$DMG" ] && [ -f "$DMG" ]; then
  if hdiutil attach -readonly -nobrowse -mountpoint "$T/dmg-mount" "$DMG" >"$OUT/dmg/attach.txt" 2>&1; then
    ls -la "$T/dmg-mount" >"$OUT/dmg/contents.txt" 2>&1
    # Nothing on the disk image beyond what a download should hold.
    extra=$(ls -A "$T/dmg-mount" | grep -vxE 'Atlas\.app|Applications|\.background|\.DS_Store|\.VolumeIcon\.icns|\.fseventsd' | tr '\n' ' ')
    [ -z "$extra" ] && ok "dmg holds nothing extra" || bad "dmg holds unexpected entries: $extra(dmg/contents.txt)"
    [ -d "$T/dmg-mount/Atlas.app" ] && ok "dmg holds Atlas.app" || bad "dmg has no Atlas.app"
    [ -L "$T/dmg-mount/Applications" ] && ok "dmg has the Applications drop target" || bad "dmg has no Applications link"
    [ -f "$T/dmg-mount/.background/dmg-background.png" ] && ok "dmg has the Trail Map background" || bad "dmg has no background picture (dmg/contents.txt)"
    [ -f "$T/dmg-mount/.DS_Store" ] && ok "dmg has a Finder layout (.DS_Store)" || bad "dmg has no Finder layout: icons will not sit on the picture"
    hdiutil detach -quiet "$T/dmg-mount"
  else
    bad "could not mount $DMG (dmg/attach.txt)"
  fi
  # Opened the way a person does: Finder shows the window with its layout.
  dev=$(hdiutil attach -readonly "$DMG" 2>>"$OUT/dmg/attach.txt" | awk -F'\t' '/\/Volumes\//{ print $NF; exit }')
  if [ -n "$dev" ]; then
    open "$dev"
    sleep 4
    screencapture -x "$OUT/dmg/finder-screen.png"
    osascript -e 'tell application "Finder" to close every window' >>"$OUT/osascript.log" 2>&1
    hdiutil detach -quiet "$dev" 2>/dev/null || hdiutil detach -quiet -force "$dev" 2>/dev/null
    ok "dmg opened in Finder (picture dmg/finder-screen.png)"
  else
    skip "dmg could not be opened in Finder"
  fi
else
  bad "no dmg found"
fi

# ---- 5. atlas-usage on the made-up chats, and the skill's launcher ----------------------------
if [ -x "$CLI" ]; then
  note "atlas-usage archs: $(lipo -archs "$CLI" 2>/dev/null)"
  run_cli() { # name args... (on failure, the exit code and stderr go into the summary too)
    local name=$1 rc
    shift
    env -u CLAUDE_CONFIG_DIR HOME="$FXHOME" "$CLI" --config-dir "$FXHOME/.claude" --cache-dir "$T/cli-cache" "$@" \
      >"$OUT/cli/$name.txt" 2>"$OUT/cli/$name.err"
    rc=$?
    [ "$rc" -eq 0 ] || { note "atlas-usage $* ($name) exited $rc:"; tail -n 15 "$OUT/cli/$name.err" | sed "s#$T#<tmp>#g" | while IFS= read -r l; do note "  $l"; done; }
    return "$rc"
  }
  run_cli today today && ok "atlas-usage today runs" || bad "atlas-usage today failed (cli/today.err)"
  run_cli week-vs week --vs last-week && ok "atlas-usage week --vs last-week runs" || bad "atlas-usage week --vs failed"
  run_cli month-json month --json && python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$OUT/cli/month-json.txt" &&
    ok "atlas-usage month --json is valid JSON" || bad "atlas-usage --json failed or is not JSON"
  # The skill's launcher finds it on PATH (no download, no quarantine).
  mkdir -p "$T/bin" && cp "$CLI" "$T/bin/atlas-usage"
  if env -u CLAUDE_CONFIG_DIR HOME="$FXHOME" PATH="$T/bin:$PATH" ATLAS_USAGE_LAUNCHER_VERBOSE=1 \
    sh skill/skills/atlas/bin/atlas-usage.sh --config-dir "$FXHOME/.claude" --cache-dir "$T/cli-cache" today \
    >"$OUT/cli/skill-launcher.txt" 2>&1; then
    ok "the skill launcher runs atlas-usage ($(grep -m1 'launcher:' "$OUT/cli/skill-launcher.txt" | sed 's/.*launcher: //' | sed "s#$T#<tmp>#"))"
  else
    bad "the skill launcher failed (cli/skill-launcher.txt)"
  fi
  sed -i '' "s#$T#<tmp>#g" "$OUT/cli/skill-launcher.txt" 2>/dev/null
else
  bad "no atlas-usage at $CLI"
fi

echo
if [ "$FAILED" = 0 ]; then echo "mac-check: all checks passed. Pictures and logs in $OUT"; else echo "mac-check: some checks FAILED (see $SUM)"; fi
exit "$FAILED"
