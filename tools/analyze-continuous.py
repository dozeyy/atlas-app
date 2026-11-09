"""Continuous-drag judge (frames from tools/resize-drag.ps1 -MoveMs N).

For every frame captured during the drag, where does the content that hugs the window's right
edge (horizontal drags) or bottom edge (T/B drags) sit relative to that edge, compared with the
final layout 700 ms after release? 0 px = in place. A positive offset means the content is drawn
that many px further out than it belongs (pushed toward / clipped by the edge), negative = inward.
This is what the eye sees as "pushes the app right" or "the right bar flashes".

  python tools/analyze-continuous.py <frames-root> [band-px]
"""
import json, os, sys
import numpy as np
from PIL import Image

def load(d, f):
    return np.asarray(Image.open(os.path.join(d, f)).convert("L")).astype(np.int16)

def offset(cur, m, ref, r, vertical, band, search=60):
    """Best shift of the edge band of `cur` (rect m) against `ref` (rect r)."""
    if not vertical:
        h = min(m["B"] - m["T"], r["B"] - r["T"])
        y0, y1 = int(h * 0.25), int(h * 0.75)
        a = ref[r["T"] + y0:r["T"] + y1, r["R"] - band:r["R"] - 6]
        best = None
        for d in range(-search, search + 1):
            x0 = m["R"] - band + d
            b = cur[m["T"] + y0:m["T"] + y1, x0:x0 + a.shape[1]]
            if b.shape != a.shape:
                continue
            e = float(np.abs(a - b).mean())
            if best is None or e < best[1]:
                best = (d, e)
        return best
    w = min(m["R"] - m["L"], r["R"] - r["L"])
    x0, x1 = int(w * 0.25), int(w * 0.75)
    a = ref[r["B"] - band:r["B"] - 6, r["L"] + x0:r["L"] + x1]
    best = None
    for d in range(-search, search + 1):
        y0 = m["B"] - band + d
        b = cur[y0:y0 + a.shape[0], m["L"] + x0:m["L"] + x1]
        if b.shape != a.shape:
            continue
        e = float(np.abs(a - b).mean())
        if best is None or e < best[1]:
            best = (d, e)
    return best

def run(d, band):
    meta = json.load(open(os.path.join(d, "meta.json"), encoding="utf-8-sig"))
    edge = os.path.basename(d).split("-")[-1]
    vertical = "L" not in edge and "R" not in edge
    rel = next(m for m in meta if m["sub"] == 98)
    ref = load(d, rel["file"])
    rows = []
    for m in meta:
        if m["sub"] >= 98:
            continue
        dd, e = offset(load(d, m["file"]), m, ref, rel, vertical, band)
        rows.append((m["ms"], m["step"], dd, e))
    off = [abs(r[2]) for r in rows]
    bad = sum(1 for o in off if o >= 2)
    dur = (rows[-1][0] - rows[0][0]) / max(1, len(rows) - 1)
    print(f"{os.path.basename(d)}: {bad}/{len(rows)} frames with the edge content >=2 px out of place, "
          f"max {max(off)} px, mean {np.mean(off):.1f} px (one frame per {dur:.0f} ms)")
    print("  offsets: " + " ".join(f"{r[2]:+d}" for r in rows))
    print("  match err: " + " ".join(f"{r[3]:.0f}" for r in rows))

if __name__ == "__main__":
    root = sys.argv[1]
    band = int(sys.argv[2]) if len(sys.argv) > 2 else 140
    for name in sorted(os.listdir(root)):
        p = os.path.join(root, name)
        if os.path.isfile(os.path.join(p, "meta.json")):
            run(p, band)
