#!/bin/bash
# Records Atlas on a Mac the way a person meets it, as one screen video: the download in Finder,
# the disk image, the drag into Applications, the first launch (intro animation, first read of the
# chats), every page with the pointer moving over it, the quick jump, the folded sidebar, Settings
# and its themes, the keyboard shortcuts, every Wrapped slide, then the uninstall the README gives
# (drag to the Trash, delete the atlas data folder). Runs on GitHub's macOS runners only
# (.github/workflows/mac-video.yml): it installs into /Applications and writes a made-up Claude
# folder into this machine's HOME, which is only acceptable on a throwaway runner.
#
#   tools/mac-video.sh <version> [OUT_DIR]        e.g. tools/mac-video.sh 0.1.5 mac-video-out
#
# Out: OUT_DIR/atlas-mac.mp4, marks.txt (second -> step), frames/ (one picture per step, to check
# the video without watching it), steps.txt (what worked and what fell back).

set -u
VER=${1:?usage: mac-video.sh <version> [OUT_DIR]}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 2
OUT=${2:-mac-video-out}
mkdir -p "$OUT/frames" && OUT=$(cd "$OUT" && pwd)
LOG=$OUT/steps.txt
: >"$LOG"
say() { printf '%s\n' "$*" | tee -a "$LOG"; }

[ "$(uname -s)" = Darwin ] || { echo "macOS only" >&2; exit 2; }
# Never on a real Mac: this writes ~/.claude and /Applications.
[ "${GITHUB_ACTIONS:-}" = true ] && [ "${RUNNER_ENVIRONMENT:-github-hosted}" = github-hosted ] ||
  { echo "mac-video.sh runs only on a GitHub-hosted runner (it writes this machine's HOME)" >&2; exit 2; }

T=$(mktemp -d /tmp/atlas-video.XXXXXX)
REC_PID=""
TOUCH_PID=""
cleanup() {
  [ -n "$TOUCH_PID" ] && kill "$TOUCH_PID" 2>/dev/null
  [ -n "$REC_PID" ] && kill -TERM "$REC_PID" 2>/dev/null
}
trap cleanup EXIT

# ---- Tools --------------------------------------------------------------------------------------
swiftc -O -o "$T/drive" tools/mac-drive.swift >"$OUT/swiftc.log" 2>&1 || { say "FAIL could not build the pointer driver"; exit 1; }
swiftc -O -o "$T/winlist" tools/mac-windows.swift >>"$OUT/swiftc.log" 2>&1 || { say "FAIL could not build the window lister"; exit 1; }
D=$T/drive
say "pointer driver may read controls: $("$D" trusted)"
command -v ffmpeg >/dev/null || brew install ffmpeg >"$OUT/brew.log" 2>&1
command -v ffmpeg >/dev/null || { say "FAIL no ffmpeg"; exit 1; }

# Each Apple event gets 12 s: a Finder that stops answering must not stall the recording.
osa() {
  osascript -e "$@" >>"$OUT/osascript.log" 2>&1 &
  local p=$! k
  ( sleep 12; kill "$p" 2>/dev/null ) &
  k=$!
  wait "$p" 2>/dev/null
  kill "$k" 2>/dev/null
}
snap() { screencapture -x "$OUT/frames/$1.png" 2>/dev/null; }
cmd() { osa "tell application \"System Events\" to keystroke \"$1\" using command down"; }
code() { osa "tell application \"System Events\" to key code $1"; } # 124 right, 53 esc, 36 return, 48 tab
typeit() { osa "tell application \"System Events\" to keystroke \"$1\""; }
pause() { sleep "$1"; }

# ---- The machine: a clean desktop and a made-up Claude folder ------------------------------------
defaults write com.apple.dock autohide -bool true && defaults write com.apple.dock autohide-delay -float 1000 && killall Dock
# No spring-loaded folders: hovering the drag over the Applications alias opened that folder and
# the drop never landed (the ghost icon then floated over the whole recording).
defaults write NSGlobalDomain com.apple.springing.enabled -bool false
# GitHub's macOS runners have Reduce Motion on, which swaps every animation for a fade. A user's
# Mac has it off: turn it off (the app is also opened with ATLAS_REDUCE_MOTION=0 for the intro).
defaults write com.apple.universalaccess reduceMotion -bool false 2>/dev/null || true
launchctl setenv ATLAS_REDUCE_MOTION 0 2>/dev/null || true
pic=$(ls /System/Library/Desktop\ Pictures/*.heic /System/Library/Desktop\ Pictures/*.jpg 2>/dev/null | head -n 1)
[ -n "$pic" ] && osa "tell application \"System Events\" to tell every desktop to set picture to \"$pic\""
osa 'tell application "Finder" to close every window'
osa 'tell application "System Events" to set visible of every process whose visible is true and name is not "Finder" to false'

python3 tools/make-demo-fixture.py "$T/fx" --live >"$OUT/fixture.log" 2>&1 || { say "FAIL fixture"; exit 1; }
rm -rf "$HOME/.claude" "$HOME/.claude.json"
cp -R "$T/fx/home/.claude" "$HOME/.claude"
[ -f "$T/fx/home/.claude.json" ] && cp "$T/fx/home/.claude.json" "$HOME/.claude.json"
# The fixture's two live chats, at their new place; touched every 20 s so they stay live on Now.
sed "s#$T/fx/home#$HOME#" "$T/fx/live.txt" >"$T/live.txt" 2>/dev/null
( while :; do while IFS= read -r f; do [ -f "$f" ] && touch "$f"; done <"$T/live.txt"; sleep 20; done ) &
TOUCH_PID=$!
say "made-up Claude folder in the runner's HOME"

# Claude Code itself, the way its site says to install it (into ~/.local/bin), so the Library and
# the Claude Code card in Settings meet a real `claude`, as on a user's Mac.
if curl -fsSL https://claude.ai/install.sh -o "$T/install-claude.sh" && bash "$T/install-claude.sh" >"$OUT/claude-install.log" 2>&1; then
  say "Claude Code installed: $("$HOME/.local/bin/claude" --version 2>/dev/null)"
  # A user's Claude Code has the official plugin catalog; a fresh install on the runner has none,
  # and the Library would open empty. Claude Code checks the whole marketplace record first, and the
  # made-up folder's entry lacks the fields a real one has, so fill them in.
  python3 - "$HOME/.claude/plugins/known_marketplaces.json" <<'PY' >>"$OUT/claude-install.log" 2>&1
import json, os, sys, datetime
p = sys.argv[1]
if os.path.exists(p):
    d = json.load(open(p))
    for name, m in d.items():
        if isinstance(m, dict):
            m.setdefault("installLocation", os.path.join(os.path.dirname(p), "marketplaces", name))
            m.setdefault("lastUpdated", datetime.datetime.utcnow().isoformat() + "Z")
    json.dump(d, open(p, "w"), indent=2)
PY
  perl -e 'alarm 120; exec @ARGV' "$HOME/.local/bin/claude" plugin marketplace add anthropics/claude-plugins-official >>"$OUT/claude-install.log" 2>&1
  say "official plugin catalog added: exit $?"
  # What the Library will get: the same command Atlas runs (crates/core/src/library/cli.rs).
  perl -e 'alarm 60; exec @ARGV' "$HOME/.local/bin/claude" plugin list --available --json >"$OUT/claude-plugin-list.txt" 2>&1
  say "claude plugin list --available: exit $?, $(head -c 300 "$OUT/claude-plugin-list.txt" | tr '
' ' ')"
else
  say "      Claude Code did not install (claude-install.log): the Library will say it cannot load"
fi

mkdir -p "$HOME/Downloads"
DMG=$HOME/Downloads/Atlas-macOS.dmg
curl -fsSL -o "$DMG" "https://github.com/dozeyy/atlas/releases/download/v$VER/Atlas-macOS.dmg" || { say "FAIL could not download the $VER dmg"; exit 1; }
say "downloaded Atlas-macOS.dmg $VER ($(du -h "$DMG" | cut -f1))"

# ---- Recording ----------------------------------------------------------------------------------
screen=$(ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | sed -n 's/.*\[\([0-9]*\)\] Capture screen 0.*/\1/p' | head -n 1)
say "screen device: ${screen:-none}"
RAW=$T/raw.mov
ffmpeg -hide_banner -loglevel error -f avfoundation -capture_cursor 1 -capture_mouse_clicks 1 -framerate 30 \
  -i "${screen:-1}:none" -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p "$RAW" </dev/null >"$OUT/ffmpeg.log" 2>&1 &
REC_PID=$!
sleep 3
kill -0 "$REC_PID" 2>/dev/null || { say "FAIL ffmpeg did not start (ffmpeg.log)"; cat "$OUT/ffmpeg.log"; exit 1; }
T0=$(date +%s)
mark() { echo "$(($(date +%s) - T0)) $1" >>"$OUT/marks.txt"; say "[$(($(date +%s) - T0))s] $1"; }

# ---- 1. The download and the disk image ---------------------------------------------------------
mark "downloads"
osa 'tell application "Finder" to open folder "Downloads" of home'
osa 'tell application "Finder" to set bounds of front window to {140, 120, 860, 540}'
pause 1.5
osa 'tell application "Finder" to select file "Atlas-macOS.dmg" of folder "Downloads" of home'
pause 1.5
mark "open-dmg"
# Finder's own "open" of a disk image is refused on the runner (no app may open it by an Apple
# event), so mount it the way a double-click does and show its window.
VOL=$(hdiutil attach "$DMG" 2>>"$OUT/hdiutil.log" | awk -F'	' '/\/Volumes\//{ print $NF; exit }')
[ -n "$VOL" ] && open "$VOL"
pause 4
osa 'tell application "Finder" to close (every window whose name is "Downloads")'
pause 1
b=$(osascript -e 'tell application "Finder" to get bounds of front window' 2>>"$OUT/osascript.log" | tr -d ' ')
say "disk image window: ${b:-none} ($VOL)"
mark "drag-to-applications"
if [ -n "$b" ]; then
  x1=${b%%,*}; rest=${b#*,}; y1=${rest%%,*}; y2=${b##*,}; rest2=${rest#*,}; x2=${rest2%%,*}
  # The icons sit at (180,170) and (480,170) of a 660 x 400 content area; the title bar is the
  # rest of the window's height.
  bar=$(((y2 - y1) - 400)); [ "$bar" -lt 0 ] && bar=28
  "$D" drag $((x1 + 180)) $((y1 + bar + 170)) $((x1 + 480)) $((y1 + bar + 170))
fi
for _ in $(seq 1 60); do ls /Applications/Atlas.app/Contents/MacOS/* >/dev/null 2>&1 && break; sleep 0.5; done
if [ -d /Applications/Atlas.app ]; then
  # Wait for Finder's copy to finish (the size stops changing).
  last=""; for _ in $(seq 1 40); do s=$(du -sk /Applications/Atlas.app | cut -f1); [ "$s" = "$last" ] && break; last=$s; sleep 0.75; done
  say "ok    dragged into Applications"
else
  snap drag-missed
  code 53 # Escape ends a drag that never dropped, so its ghost icon does not float over the video
  ditto "$VOL/Atlas.app" /Applications/Atlas.app && say "fallback: copied with ditto (the drag did not land; frames/drag-missed.png)"
fi
pause 2
osa 'tell application "Finder" to close every window'
[ -n "$VOL" ] && hdiutil detach -quiet "$VOL" 2>/dev/null
pause 1

# ---- 2. First launch: the intro, then the first read of the chats --------------------------------
mark "applications"
osa 'tell application "Finder" to open folder "Applications" of startup disk'
osa 'tell application "Finder" to set bounds of front window to {140, 120, 860, 540}'
osa 'tell application "Finder" to select file "Atlas.app" of folder "Applications" of startup disk'
pause 2
mark "launch"
open --env ATLAS_REDUCE_MOTION=0 /Applications/Atlas.app 2>/dev/null || open /Applications/Atlas.app
PID=""
for _ in $(seq 1 60); do PID=$(pgrep -f '/Applications/Atlas.app/Contents/MacOS/' | head -n 1); [ -n "$PID" ] && break; sleep 0.25; done
[ -n "$PID" ] || { say "FAIL Atlas did not start"; exit 1; }
WIN=""
for _ in $(seq 1 120); do WIN=$("$T/winlist" "$PID" | awk '{ split($2, r, ","); if (r[3] >= 600) { print $2; exit } }'); [ -n "$WIN" ] && break; sleep 0.25; done
say "window: ${WIN:-none}"
[ -n "$WIN" ] || { say "FAIL Atlas showed no window"; exit 1; }
osa 'tell application "Finder" to close every window'
pause 8 # the intro plays, then the Dashboard counts up while the chats are read
IFS=, read -r WX WY WW WH <<<"${WIN:-0,31,1024,677}"
cx=$((WX + WW / 2)); cy=$((WY + WH / 2))

# Clicks a control by its name; returns non-zero when it is not found.
press() {
  local at
  at=$("$D" find "$PID" "$1" 2>/dev/null) || { say "      no '$1' on screen"; return 1; }
  "$D" click $at
}
hover() { local at; at=$("$D" find "$PID" "$1" 2>/dev/null) && "$D" move $at 350; }
# A slow sweep of the page so charts and cards show their hover states.
sweep() {
  "$D" move $((WX + 300)) $((WY + $1)) 500
  "$D" move $((WX + WW - 80)) $((WY + $1)) 2600
}
page() { # nav name, shortcut digit
  mark "page-$1"
  press "$1" || cmd "$2"
  pause 2.5
}

mark "dashboard"
"$D" move $cx $cy 600
sweep 230
sweep 420
"$D" scroll -8 $cx $cy
pause 1.5
"$D" scroll 8 $cx $cy
pause 1

# ---- 3. Every page, through the sidebar -------------------------------------------------------------
for n in Dashboard Now Sessions Toolkit History; do hover "$n"; pause 0.35; done
page Now 2
sweep 260; "$D" scroll -6 $cx $cy; pause 1.5; "$D" scroll 6 $cx $cy
page Sessions 3
sweep 300
mark "quick-jump-session"
cmd k; pause 1.2; typeit "Tidy"; pause 1.2; code 36; pause 3
"$D" scroll -6 $cx $cy; pause 1.5; code 53; pause 1.5
page Toolkit 4
sweep 300
"$D" scroll -6 $cx $cy; pause 1.5; "$D" scroll 6 $cx $cy
mark "toolkit-library"
press "Library" && pause 3
# An empty catalog offers the official one: press it, the way a user would.
if press "Add the official catalog"; then pause 10; fi
sweep 320
# When the Library cannot load, open its Details so the frame shows what Claude Code said.
if press "Details"; then pause 2; snap library-details; fi
mark "toolkit-team"
press "Team" && pause 3 && sweep 320
press "Your setup" && pause 1.5
mark "quick-jump-skill"
cmd k; pause 1.2; typeit "skill"; pause 1.5; code 36; pause 3; code 53; pause 1.5
page History 5
sweep 300
mark "now-again"
cmd 2; pause 2

# ---- 4. The sidebar folded and back ---------------------------------------------------------------
mark "fold"
press "Sidebar" || cmd b
pause 2.5
"$D" move $((WX + 26)) $((WY + 60)) 500; pause 0.6; "$D" move $((WX + 66)) $((WY + 60)) 400; pause 0.6
"$D" move $((WX + 26)) $((WY + 100)) 400; pause 0.6; "$D" move $((WX + 66)) $((WY + 100)) 400; pause 1
mark "unfold"
press "Sidebar" || cmd b
pause 2.5

# ---- 5. Settings: themes, the Claude Code connection -------------------------------------------------
mark "settings"
press "Settings" || cmd ,
pause 2.5
for th in Dark Silver Light; do mark "theme-$th"; press "$th" && pause 3; done
# Count cache in token totals: on, then the Dashboard's big number with its hover table, then off.
mark "count-cache-on"
press "General" && pause 2
if press "Count cache in token totals"; then
  pause 2; cmd 1; pause 3
  "$D" move $((WX + 270)) $((WY + 128)) 700; pause 3.5; snap hover-total
  mark "count-cache-off"
  press "Settings" || cmd ,
  pause 2; press "General"; pause 1.5; press "Count cache in token totals"; pause 2
fi
"$D" scroll -10 $cx $cy; pause 2; "$D" scroll -10 $cx $cy; pause 2
mark "settings-claude-code"
press "Claude Code" && pause 3
"$D" scroll 20 $cx $cy; pause 1

# ---- 6. The menu: keyboard shortcuts ----------------------------------------------------------------
mark "shortcuts"
if press "Menu"; then
  pause 1.2
  hover "Help"; pause 1.2
  press "Keyboard shortcuts" && pause 4
  code 53; pause 1.5
fi

# ---- 7. Wrapped, every slide ----------------------------------------------------------------------
mark "wrapped"
press "Wrapped" || cmd 7
pause 4
for i in $(seq 1 12); do mark "wrapped-$i"; code 124; pause 3.4; done
pause 2
code 53; pause 2
mark "dashboard-again"
cmd 1; pause 3

# ---- 8. Quit and uninstall, as the README says ------------------------------------------------------
mark "quit"
cmd q
for _ in $(seq 1 40); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
kill -0 "$PID" 2>/dev/null && say "FAIL Cmd+Q did not quit" || say "ok    Cmd+Q quit Atlas"
pause 1.5
mark "uninstall-app"
osa 'tell application "Finder" to open folder "Applications" of startup disk'
osa 'tell application "Finder" to set bounds of front window to {140, 120, 860, 540}'
osa 'tell application "Finder" to select file "Atlas.app" of folder "Applications" of startup disk'
pause 2
osa 'tell application "Finder" to delete file "Atlas.app" of folder "Applications" of startup disk'
pause 2.5
if [ -d /Applications/Atlas.app ]; then
  snap trash-app-missed
  mv /Applications/Atlas.app "$HOME/.Trash/" && say "fallback: moved Atlas.app to the Trash by hand (frames/trash-app-missed.png)"
else
  say "ok    Atlas.app moved to the Trash"
fi
mark "uninstall-data"
osa 'tell application "Finder" to close every window'
osa "tell application \"Finder\" to open (POSIX file \"$HOME/Library/Application Support\" as alias)"
osa 'tell application "Finder" to set bounds of front window to {140, 120, 860, 540}'
pause 1
osa "tell application \"Finder\" to select (POSIX file \"$HOME/Library/Application Support/atlas\" as alias)"
pause 2
osa "tell application \"Finder\" to delete (POSIX file \"$HOME/Library/Application Support/atlas\" as alias)"
pause 2
if [ -d "$HOME/Library/Application Support/atlas" ]; then
  snap trash-data-missed
  mv "$HOME/Library/Application Support/atlas" "$HOME/.Trash/" && say "fallback: moved the atlas data folder to the Trash by hand"
else
  say "ok    atlas data folder moved to the Trash"
fi
mark "trash"
osa 'tell application "Finder" to close every window'
osa 'tell application "Finder" to open trash'
osa 'tell application "Finder" to set bounds of front window to {140, 120, 860, 540}'
pause 4
mark "end"

# ---- Finish the file ----------------------------------------------------------------------------
kill -TERM "$REC_PID" 2>/dev/null
wait "$REC_PID" 2>/dev/null
REC_PID=""
ffmpeg -hide_banner -loglevel error -i "$RAW" -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p -movflags +faststart "$OUT/atlas-mac.mp4" ||
  cp "$RAW" "$OUT/atlas-mac.mov"
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/atlas-mac.mp4" 2>/dev/null)
say "video: ${dur:-?} s, $(du -h "$OUT"/atlas-mac.* | cut -f1 | head -n 1)"
# One picture a little after each step, and a contact sheet every 3 s.
i=0
while read -r s name; do
  i=$((i + 1))
  ffmpeg -hide_banner -loglevel error -ss $((s + 2)) -i "$OUT/atlas-mac.mp4" -frames:v 1 "$OUT/frames/$(printf '%03d' $i)-$name.png" 2>/dev/null
done <"$OUT/marks.txt"
ffmpeg -hide_banner -loglevel error -i "$OUT/atlas-mac.mp4" -vf "fps=1/3,scale=341:-1,tile=6x6" "$OUT/frames/sheet-%02d.png" 2>/dev/null
say "done"
