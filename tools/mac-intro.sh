#!/bin/bash
# The launch intro on macOS, recorded: Atlas is opened the way a person opens it (LaunchServices,
# `open`), with the intro on and its trace log (ATLAS_INTRO_TRACE=1), while ffmpeg records the
# screen at 30 fps. Run 1 is a first launch (empty data folder), runs 2 and 3 are later launches.
# Each run leaves intro-N.mp4, intro-N.log (Atlas's stderr), intro-N-grid.png (10 fps contact sheet
# from the launch) and a line in intro-summary.txt.
#
#   tools/mac-intro.sh [OUT_DIR] [APP]
#     OUT_DIR  default mac-check-out
#     APP      default target/aarch64-apple-darwin/release/bundle/macos/Atlas.app
#
# Runs against a made-up Claude folder in a temp HOME (tools/make-demo-fixture.py): the real
# ~/.claude and Atlas data are never read or written.

set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 2
OUT=${1:-mac-check-out}
APP=${2:-target/aarch64-apple-darwin/release/bundle/macos/Atlas.app}
mkdir -p "$OUT/intro" && OUT=$(cd "$OUT/intro" && pwd)
SUM=$OUT/intro-summary.txt
: >"$SUM"
say() { printf '%s\n' "$*" | tee -a "$SUM"; }
now() { python3 -c 'import time; print("%.3f" % time.time())'; }

[ "$(uname -s)" = Darwin ] || { echo "mac-intro.sh runs on macOS only." >&2; exit 2; }
[ -d "$APP" ] || { say "FAIL no app at $APP"; exit 1; }
APP=$(cd "$APP" && pwd)
EXE="$APP/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"

command -v ffmpeg >/dev/null || brew install ffmpeg >"$OUT/brew.log" 2>&1
command -v ffmpeg >/dev/null || { say "FAIL no ffmpeg"; exit 1; }

T=$(mktemp -d /tmp/atlas-intro.XXXXXX)
REC_PID=""
cleanup() {
  [ -n "$REC_PID" ] && kill -INT "$REC_PID" 2>/dev/null
  pkill -f "$EXE" 2>/dev/null
  rm -rf "$T"
}
trap cleanup EXIT

python3 tools/make-demo-fixture.py "$T/fx" >"$OUT/fixture.log" 2>&1 || { say "FAIL fixture (fixture.log)"; exit 1; }
FXHOME=$T/fx/home
DATA=$T/data
mkdir -p "$DATA"

# The Dock stays out of the way; a Finder window sits behind, like a person's desktop.
defaults write com.apple.dock autohide -bool true && defaults write com.apple.dock autohide-delay -float 1000 && killall Dock 2>/dev/null
open /Applications 2>/dev/null
sleep 2

screen=$(ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | sed -n 's/.*\[\([0-9]*\)\] Capture screen 0.*/\1/p' | head -n 1)
say "screen device: ${screen:-none}"
system_profiler SPDisplaysDataType 2>/dev/null | grep -E 'Resolution|Chipset|Metal' | sed 's/^ */      /' | tee -a "$SUM"

for run in 1 2 3; do
  raw=$T/raw-$run.mkv
  ffmpeg -hide_banner -loglevel error -f avfoundation -capture_cursor 1 -framerate 30 \
    -i "${screen:-1}:none" -c:v libx264 -preset ultrafast -crf 18 "$raw" </dev/null >"$OUT/ffmpeg-$run.log" 2>&1 &
  REC_PID=$!
  rec_at=$(now)
  sleep 3
  kill -0 "$REC_PID" 2>/dev/null || { say "FAIL ffmpeg did not start (ffmpeg-$run.log)"; cat "$OUT/ffmpeg-$run.log"; exit 1; }
  launch_at=$(now)
  # LaunchServices, as a Dock or Finder launch: the app is activated like a person's launch.
  open -n -a "$APP" --stdout "$OUT/intro-$run.log" --stderr "$OUT/intro-$run.log" \
    --env HOME="$FXHOME" --env ATLAS_DATA_DIR="$DATA" --env ATLAS_INTRO_TRACE=1 --env ATLAS_MULTI=1
  sleep 12
  screencapture -x "$OUT/intro-$run-end.png"
  kill -INT "$REC_PID" 2>/dev/null
  wait "$REC_PID" 2>/dev/null
  REC_PID=""
  pkill -f "$EXE" 2>/dev/null
  sleep 2
  pkill -9 -f "$EXE" 2>/dev/null
  off=$(python3 -c "print('%.2f' % ($launch_at - $rec_at))")
  ffmpeg -hide_banner -loglevel error -i "$raw" -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p -movflags +faststart "$OUT/intro-$run.mp4"
  # 10 fps from 0.2 s before the launch, 6 s: 60 frames.
  start=$(python3 -c "print('%.2f' % max(0, $off - 0.2))")
  ffmpeg -hide_banner -loglevel error -ss "$start" -i "$OUT/intro-$run.mp4" -t 6 \
    -vf "fps=10,scale=320:-1,tile=10x6" -frames:v 1 "$OUT/intro-$run-grid.png"
  say "run $run: launch epoch $launch_at, video offset ${off} s, grid starts at ${start} s"
  grep -E 'intro|startup' "$OUT/intro-$run.log" | grep -v 'main thread busy [3-4][0-9] ms' | head -n 80 | sed 's/^/      /' >>"$SUM"
done
say "done"
