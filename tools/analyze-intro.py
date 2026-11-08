"""Analyze a capture made by tools/capture-intro.ps1.

  python -I tools/analyze-intro.py <capture dir> <window rect x,y,w,h> <crop origin x,y> [--shots <dir>]

Finds the first frame with splash pixels, flags white/black flashes and sudden full-frame
jumps, and (with --shots) saves a frame sequence + contact sheet that covers every step.
"""
import json
import re
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

cap = sys.argv[1]
rx, ry, rw, rh = (int(v) for v in sys.argv[2].split(","))
ox, oy = (int(v) for v in sys.argv[3].split(","))
shots = sys.argv[sys.argv.index("--shots") + 1] if "--shots" in sys.argv else None

pts = [float(m.group(1)) for m in re.finditer(r"pts_time:([0-9.]+)", open(f"{cap}/frames.log", errors="replace").read())]
launch_ms, start_ms = (int(v) for v in open(f"{cap}/launch.txt").read().split())
probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", f"{cap}/capture.mkv"],
                       capture_output=True, text=True).stdout.strip().split(",")
W, H = int(probe[0]), int(probe[1])
import os
import tempfile
raw = os.path.join(tempfile.gettempdir(), "atlas-intro-analyze.raw")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f"{cap}/capture.mkv", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", raw], check=True)
size = W * H * 3
count = os.path.getsize(raw) // size
mm = np.memmap(raw, dtype=np.uint8, mode="r", shape=(count, H, W, 3))
frames_meta = []
keep = mm
base = None
prev = None
x0, y0 = rx - ox, ry - oy
for n in range(count):
    f = mm[n]
    win = f[y0:y0 + rh, x0:x0 + rw]
    if base is None:
        base_win = np.array(win, dtype=np.int16)
        base = True
    wi = win.astype(np.int16)
    d_base = float(np.abs(wi - base_win).mean())
    fi = f[::4, ::4].astype(np.int16)
    d_prev = float(np.abs(fi - prev).mean()) if prev is not None else 0.0
    white = float((win.min(axis=2) >= 250).mean())
    black = float((win.max(axis=2) <= 5).mean())
    clay = float((np.abs(wi - np.array([220, 120, 77])).sum(axis=2) < 24).mean())
    orange = float(((wi[..., 0] - wi[..., 1] > 40) & (wi[..., 0] - wi[..., 2] > 60)).sum())
    frames_meta.append(dict(n=n, orange=orange, t=pts[n] if n < len(pts) else None, d_base=d_base, d_prev=d_prev, white=white, black=black, clay=clay))
    prev = fi

ts = np.array([m["t"] for m in frames_meta])
first = next(m for m in frames_meta if m["d_base"] > 1.0)
base_orange = frames_meta[0]["orange"]
logo = next(m for m in frames_meta if m["orange"] - base_orange > 40)
t0 = logo["t"]  # everything below is measured from the first frame with logo pixels in it
print(f"launch -> first change in the window area: {(first['t'] * 1000 - launch_ms):.0f} ms")
print(f"launch -> first LOGO pixels on screen: {(logo['t'] * 1000 - launch_ms):.0f} ms")
print(f"frames: {len(frames_meta)}  capture ~{len(frames_meta) / (ts[-1] - ts[0]):.0f} fps")
print(f"first logo frame is {(t0 * 1000 - start_ms):.0f} ms after process start")
clay_full = next(m for m in frames_meta if m["t"] > t0 and m["clay"] > 0.97)
print(f"first logo frame to full clay screen: {(clay_full['t'] - t0) * 1000:.0f} ms")
after = [m for m in frames_meta if m["t"] > clay_full["t"]]
# settled: first frame after clay where no more than 0.3 of the window differs from the final frame
final = frames_meta[-1]
settled = None
last_win = None
# total = last frame whose d_prev is above a small threshold
moving = [m for m in frames_meta if m["t"] >= t0 and m["d_prev"] > 0.05]
last_move = moving[-1]
print(f"first logo frame to last movement: {(last_move['t'] - t0) * 1000:.0f} ms")
# flashes: any frame in the window that is mostly white or black that was not before
flash = [(m["n"], round((m["t"] - t0) * 1000), round(m["white"], 3), round(m["black"], 3)) for m in frames_meta if m["t"] >= t0 and (m["white"] > 0.5 or m["black"] > 0.5)]
print("flash frames (white or black > 50% of window):", flash if flash else "none")
# biggest frame-to-frame jumps after t0
jumps = sorted(((m["d_prev"], round((m["t"] - t0) * 1000), m["n"]) for m in frames_meta if m["t"] >= t0), reverse=True)[:6]
print("largest frame-to-frame jumps (mean abs diff, ms from first frame, n):", [(round(a, 1), b, c) for a, b, c in jumps])
dts = np.diff(ts[ts >= t0 - 0.2]) * 1000
print(f"capture gaps: worst {dts.max():.1f} ms, >20 ms: {(dts > 20).sum()}  (this is the capture rate, not the app's)")

json.dump(dict(first_logo_ms_after_launch=t0 * 1000 - launch_ms, frames=frames_meta), open(f"{cap}/analysis.json", "w"))

if shots:
    import os
    os.makedirs(shots, exist_ok=True)
    targets = [0, 120, 240, 360, 500, 700, 900, 1100, 1250, 1400, 1480, 1560, 1640, 1740, 1840, 1960, 2100, 2400]
    chosen = []
    for tg in targets:
        i = int(np.argmin(np.abs(ts - (t0 + tg / 1000.0))))
        chosen.append((tg, i))
    names = []
    for tg, i in chosen:
        im = Image.fromarray(np.array(keep[i]))
        # keep the window and a 24 px margin around it
        m = 24
        im = im.crop((x0 - m, y0 - m, x0 + rw + m, y0 + rh + m))
        name = f"t{tg:04d}ms_frame{i:04d}.png"
        im.save(f"{shots}/{name}", optimize=True)
        names.append((tg, name, im))
    # contact sheet: 6 columns, labels
    cw, ch = 360, int(360 * names[0][2].height / names[0][2].width)
    cols = 6
    rows = (len(names) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cw, rows * (ch + 22)), (24, 24, 24))
    dr = ImageDraw.Draw(sheet)
    for k, (tg, name, im) in enumerate(names):
        r, c = divmod(k, cols)
        sheet.paste(im.resize((cw, ch), Image.LANCZOS), (c * cw, r * (ch + 22) + 22))
        dr.text((c * cw + 6, r * (ch + 22) + 5), f"+{tg} ms", fill=(235, 235, 235))
    sheet.save(f"{shots}/contact-sheet.png", optimize=True)
    print("saved", len(names), "frames + contact sheet to", shots)
