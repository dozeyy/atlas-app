"""Continuous-drag judge (frames from tools/resize-drag.ps1 -MoveMs N).

For every frame captured during the drag: where does the content that hugs each moving edge sit
relative to that edge AS DRAWN in the picture, compared with a settled layout? The references are
the settled frame before the press (sub 97) and the one 700 ms after release (sub 98); each frame
is judged against the one it matches best, since the page can switch layout between the two sizes
(the dashboard's right column does). 0 px = in place. Positive = drawn further out than it belongs (pushed into / clipped by
the edge), negative = inward. This is what the eye sees as "pushes the app" or "the bar flashes".

The window's drawn edge comes from the picture, not from the window rect: resize-drag.ps1 puts a
magenta backdrop behind the window, so every pixel that is not magenta is the window. The rect
read just before the screen copy can be a step newer than the composed picture (the size loop
moved the window between the two reads); judged against that rect, a frame drawn perfectly reads
as one whole step off. The lag is reported separately and is not a visible shift.

Bands only cover content that is pinned to that edge in Atlas's layout:
  R: the right 48 px (card borders and margin), rows 100..500 below the top
  L: the left 48 px (sidebar icons), same rows
  T: the top 48 px over the left 300 px (title bar buttons)
  B: the bottom 48 px over the left 180 px (the sidebar footer)
Content that reflows with the size (charts, text, the clipped bottom of the page) is left out:
comparing it with the settled layout measures the reflow, not a shift.

Without a backdrop (older captures) it falls back to the window rect and says so.

  python tools/analyze-continuous.py <frames-root> [band-px]
"""
import json, os, sys
import numpy as np
from PIL import Image

SEARCH = 40
# A best match worse than this (mean abs gray difference) is not the same content at all: the band
# shows something the settled layouts do not (clipped, stale or half-drawn), counted as out of place.
NO_MATCH = 6.0


def load(d, f):
    return np.asarray(Image.open(os.path.join(d, f)).convert("RGB")).astype(np.int16)


def backdrop(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return (r - g > 60) & (b - g > 60)


def has_backdrop(rgb):
    h, w = rgb.shape[:2]
    return all(backdrop(rgb[y:y + 1, x:x + 1])[0, 0] for y, x in ((2, 2), (2, w - 3), (h - 3, 2), (h - 3, w - 3)))


def drawn_rect(rgb, m):
    """The window rect as drawn: the non-backdrop area, median over the middle of each side."""
    win = ~backdrop(rgb)
    L, T, R, B = m["L"], m["T"], m["R"], m["B"]

    def first_last(lines):
        f, l = [], []
        for line in lines:
            nz = np.nonzero(line)[0]
            if len(nz):
                f.append(nz.min())
                l.append(nz.max() + 1)
        return int(np.median(f)), int(np.median(l))

    rows = [win[y] for y in range(T + (B - T) // 4, T + 3 * (B - T) // 4, 7)]
    cols = [win[:, x] for x in range(L + (R - L) // 4, L + 3 * (R - L) // 4, 7)]
    dl, dr = first_last(rows)
    dt, db = first_last(cols)
    return {"L": dl, "T": dt, "R": dr, "B": db}


def band(gray, w, side, size, ref_w, ref_h):
    """(y0, y1, x0, x1) of the band pinned to `side` of drawn rect w, sized to fit both frames."""
    h = min(w["B"] - w["T"], ref_h)
    width = min(w["R"] - w["L"], ref_w)
    if side in "LR":
        y0 = w["T"] + 100
        y1 = w["T"] + max(110, min(500, h - 60))
        x0 = w["R"] - size if side == "R" else w["L"]
        return y0, y1, x0, x0 + size
    x0, x1 = w["L"], w["L"] + min(300 if side == "T" else 180, width)
    y0 = w["B"] - size if side == "B" else w["T"]
    return y0, y0 + size, x0, x1


def shift(cur, cw, ref, rw, side, size):
    """Best d (px, positive = outward) for the band of `cur` against the same band of `ref`."""
    rw_w, rw_h = rw["R"] - rw["L"], rw["B"] - rw["T"]
    cw_w, cw_h = cw["R"] - cw["L"], cw["B"] - cw["T"]
    ry0, ry1, rx0, rx1 = band(ref, rw, side, size, cw_w, cw_h)
    cy0, cy1, cx0, cx1 = band(cur, cw, side, size, rw_w, rw_h)
    a = ref[ry0:ry1, rx0:rx1]
    out = None
    for d in range(-SEARCH, SEARCH + 1):
        # Content drawn d px outward of where the settled layout has it.
        o = d if side in "RB" else -d
        if side in "LR":
            b = cur[cy0:cy1, cx0 + o:cx1 + o]
        else:
            b = cur[cy0 + o:cy1 + o, cx0:cx1]
        if b.shape != a.shape or b.size == 0:
            continue
        e = float(np.abs(a - b).mean())
        if out is None or e < out[1] or (e == out[1] and abs(d) < abs(out[0])):
            out = (d, e)
    return out


def run(d, size):
    meta = json.load(open(os.path.join(d, "meta.json"), encoding="utf-8-sig"))
    sides = os.path.basename(d).split("-")[-1]
    refs = []
    for m in sorted((m for m in meta if m["sub"] in (97, 98)), key=lambda m: -m["sub"]):
        rgb = load(d, m["file"])
        refs.append((m, rgb))
    mask = has_backdrop(refs[0][1])
    refs = [(drawn_rect(rgb, m) if mask else {k: m[k] for k in "LTRB"}, rgb.mean(axis=2), "rs"[m["sub"] == 97]) for m, rgb in refs]
    frames = [m for m in meta if m["sub"] < 97]
    rows = []
    for m in frames:
        rgb = load(d, m["file"])
        cw = drawn_rect(rgb, m) if mask else {k: m[k] for k in "LTRB"}
        gray = rgb.mean(axis=2)
        per = []
        for s in sides:
            dd, e, which = min((shift(gray, cw, ref, rw, s, size) + (k,) for rw, ref, k in refs), key=lambda t: t[1])
            lag = (m[s] - cw[s]) if s in "RB" else (cw[s] - m[s])   # > 0: the rect is ahead of the picture
            per.append((s, dd, e, lag, which))
        rows.append(per)
    name = os.path.basename(d)
    print(f"{name}: {'drawn edge from the backdrop' if mask else 'NO BACKDROP: window rect used, rect-vs-picture lag reads as a shift'}")
    for i, s in enumerate(sides):
        off = [abs(r[i][1]) for r in rows]
        bad = sum(1 for r in rows if abs(r[i][1]) >= 2 or r[i][2] > NO_MATCH)
        nomatch = sum(1 for r in rows if r[i][2] > NO_MATCH)
        lagged = sum(1 for r in rows if abs(r[i][3]) >= 2)
        print(f"  {s}: {bad}/{len(rows)} frames with the edge content >=2 px out of place or unmatched ({nomatch} unmatched), "
              f"max {max(off)} px, mean {np.mean(off):.1f} px; picture behind the rect in {lagged} frames (capture timing)")
        print("    offsets (x = no match): " + " ".join("x" if r[i][2] > NO_MATCH else f"{r[i][1]:+d}" for r in rows))
        print("    match err (r = release, s = start reference): " + " ".join(f"{r[i][2]:.0f}{r[i][4]}" for r in rows))
        print("    rect ahead of picture: " + " ".join(f"{r[i][3]:+d}" for r in rows))


if __name__ == "__main__":
    root = sys.argv[1]
    size = int(sys.argv[2]) if len(sys.argv) > 2 else 48
    for name in sorted(os.listdir(root)):
        p = os.path.join(root, name)
        if os.path.isfile(os.path.join(p, "meta.json")):
            run(p, size)
