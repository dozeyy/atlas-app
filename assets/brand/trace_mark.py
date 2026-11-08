# Trace atlas-mark-1024.png into a clean vector: atlas-mark.svg (spark + dot, two paths),
# and src/splash/markGeometry.ts (the same paths plus the arm wedges the launch intro
# animates one by one). Also overlay-diffs the vector against the PNG and prints the mismatch.
#
# Needs: numpy, Pillow, potracer (pip install potracer). Run from the repo root:
#   python assets/brand/trace_mark.py
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
import potrace

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(HERE, "atlas-mark-1024.png")
M = 1024
UP = 2  # trace at 2x so curves land on sub-pixel edges
MARK = "#DC784D"

alpha = np.asarray(Image.open(SRC).convert("RGBA"))[..., 3]
big = np.asarray(Image.fromarray(alpha).resize((M * UP, M * UP), Image.BICUBIC)) >= 128

# The mark touches the canvas edge; pad so potrace sees closed shapes, then shift back.
PAD = 32
big = np.pad(big, PAD)
bmp = potrace.Bitmap(~big)  # potracer traces the False cells
plist = bmp.trace(turdsize=200, turnpolicy=potrace.POTRACE_TURNPOLICY_MINORITY,
                  alphamax=1.0, opticurve=True, opttolerance=0.4)


def curve_d(curve, k=1.0 / UP):
    """One closed potrace curve as SVG path data (absolute cubic Beziers)."""
    o = PAD * k
    sx, sy = curve.start_point.x * k - o, curve.start_point.y * k - o
    d = [f"M{sx:.2f} {sy:.2f}"]
    for seg in curve.segments:
        if seg.is_corner:
            d.append(f"L{seg.c.x * k - o:.2f} {seg.c.y * k - o:.2f}L{seg.end_point.x * k - o:.2f} {seg.end_point.y * k - o:.2f}")
        else:
            d.append(
                f"C{seg.c1.x * k - o:.2f} {seg.c1.y * k - o:.2f} {seg.c2.x * k - o:.2f} {seg.c2.y * k - o:.2f} "
                f"{seg.end_point.x * k - o:.2f} {seg.end_point.y * k - o:.2f}"
            )
    d.append("Z")
    return "".join(d)


def curve_points(curve, k=1.0 / UP, n=24):
    o = PAD * k
    pts = [(curve.start_point.x * k - o, curve.start_point.y * k - o)]
    for seg in curve.segments:
        p0 = pts[-1]
        if seg.is_corner:
            pts.append((seg.c.x * k - o, seg.c.y * k - o))
            pts.append((seg.end_point.x * k - o, seg.end_point.y * k - o))
        else:
            c1 = (seg.c1.x * k - o, seg.c1.y * k - o)
            c2 = (seg.c2.x * k - o, seg.c2.y * k - o)
            p3 = (seg.end_point.x * k - o, seg.end_point.y * k - o)
            for i in range(1, n + 1):
                t = i / n
                u = 1 - t
                pts.append((
                    u**3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t**3 * p3[0],
                    u**3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t**3 * p3[1],
                ))
    return pts


curves = list(plist)
assert len(curves) == 2, f"expected spark + dot, got {len(curves)} curves"
areas = []
for c in curves:
    p = curve_points(c)
    areas.append(abs(sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))) / 2)
spark, dot = (curves[0], curves[1]) if areas[0] > areas[1] else (curves[1], curves[0])
spark_d, dot_d = curve_d(spark), curve_d(dot)

svg = (
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {M} {M}" width="{M}" height="{M}">\n'
    f'  <title>Atlas mark</title>\n'
    f'  <path id="spark" fill="{MARK}" d="{spark_d}"/>\n'
    f'  <path id="dot" fill="{MARK}" d="{dot_d}"/>\n'
    f'</svg>\n'
)
with open(os.path.join(HERE, "atlas-mark.svg"), "w", newline="\n") as f:
    f.write(svg)

# ---- Overlay diff: rasterize the vector at 4x and compare with the PNG alpha ----
SS = 4
img = Image.new("L", (M * SS, M * SS), 0)
dr = ImageDraw.Draw(img)
for c in (spark, dot):
    dr.polygon([(x * SS, y * SS) for x, y in curve_points(c, n=40)], fill=255)
vec = np.asarray(img.resize((M, M), Image.BOX)).astype(np.float32)
png = alpha.astype(np.float32)
vec_b, png_b = vec >= 128, png >= 128
mism = int(np.count_nonzero(vec_b ^ png_b))
mark_px = int(np.count_nonzero(png_b))
print(f"mark pixels (png, alpha>=128): {mark_px}")
print(f"binary mismatch: {mism} px = {100 * mism / mark_px:.3f}% of the mark ({100 * mism / (M * M):.4f}% of canvas)")
print(f"mean |alpha diff|: {np.abs(vec - png).mean():.3f} / 255 over canvas; over mark bbox ring: "
      f"{np.abs(vec - png)[(vec_b | png_b)].mean():.2f}")
ov = np.zeros((M, M, 3), np.uint8) + 255
ov[png_b & vec_b] = (200, 200, 200)
ov[png_b & ~vec_b] = (220, 40, 40)  # in png only
ov[~png_b & vec_b] = (40, 90, 220)  # in vector only
Image.fromarray(ov).save(os.path.join(HERE, "mark-trace-diff.png"))

# ---- Arm wedges: split the spark by its notches, around the thickest point ----
mask = png_b.copy()
mask[(np.arange(M)[:, None] > -1) & (np.arange(M)[None, :] > 700) & (np.arange(M)[:, None] < 300)] = False  # drop the dot
er = mask.copy()
steps = 0
while er.sum() > 200:
    nxt = er.copy()
    nxt[1:] &= er[:-1]; nxt[:-1] &= er[1:]; nxt[:, 1:] &= er[:, :-1]; nxt[:, :-1] &= er[:, 1:]
    nxt[0] = nxt[-1] = False; nxt[:, 0] = nxt[:, -1] = False
    if nxt.sum() < 50:
        break
    er = nxt
    steps += 1
ys, xs = np.nonzero(er)
cx, cy = float(xs.mean()), float(ys.mean())
print(f"center ({cx:.1f},{cy:.1f}) inscribed radius ~{steps}px")

# radius of the silhouette along each ray; notches are the local minima.
N = 720
r = np.zeros(N)
for i in range(N):
    th = 2 * math.pi * i / N
    last = 0
    for d in range(1, 700):
        x, y = int(round(cx + d * math.cos(th))), int(round(cy + d * math.sin(th)))
        if 0 <= x < M and 0 <= y < M and mask[y, x]:
            last = d
    r[i] = last
k = 15
sm = np.array([r[(np.arange(i - k, i + k + 1)) % N].mean() for i in range(N)])
mins = [i for i in range(N) if sm[i] == sm[(np.arange(i - 40, i + 41)) % N].min() and sm[i] < sm.max() * 0.8]
# collapse neighbours
notch = []
for i in mins:
    if not notch or i - notch[-1] > 20:
        notch.append(i)
if len(notch) > 1 and notch[0] + N - notch[-1] <= 20:
    notch.pop()
ang = [2 * math.pi * i / N for i in notch]
print("arms:", len(ang), "notch angles (deg):", [round(math.degrees(a)) for a in ang])

wedges = []
R = 900
for i in range(len(ang)):
    a0, a1 = ang[i], ang[(i + 1) % len(ang)]
    if a1 <= a0:
        a1 += 2 * math.pi
    pts = [(cx, cy)]
    steps_n = 8
    for j in range(steps_n + 1):
        a = a0 + (a1 - a0) * j / steps_n
        pts.append((cx + R * math.cos(a), cy + R * math.sin(a)))
    wedges.append(" ".join(f"{x:.1f},{y:.1f}" for x, y in pts))

ts = (
    "// Generated by assets/brand/trace_mark.py from atlas-mark-1024.png. Do not edit by hand.\n"
    f"export const MARK_VIEWBOX = {M};\n"
    f"export const MARK_COLOR = \"{MARK}\";\n"
    f"export const MARK_CENTER = {{ x: {cx:.1f}, y: {cy:.1f} }};\n"
    f"export const SPARK_PATH = {json.dumps(spark_d)};\n"
    f"export const DOT_PATH = {json.dumps(dot_d)};\n"
    "/** One wedge (polygon points) per arm, cut at the notches between arms. */\n"
    f"export const ARM_WEDGES: string[] = {json.dumps(wedges, indent=2)};\n"
)
os.makedirs(os.path.join(ROOT, "src", "splash"), exist_ok=True)
with open(os.path.join(ROOT, "src", "splash", "markGeometry.ts"), "w", newline="\n") as f:
    f.write(ts)
print("wrote atlas-mark.svg, mark-trace-diff.png, src/splash/markGeometry.ts")
