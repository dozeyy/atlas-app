"""For each mid-drag frame, which picture is on screen?
  new    = the settled frame of this step (correct, relaid-out content)
  stale  = the previous step's settled content, pinned to the window's new top-left corner
  screen = the previous step's settled content, left where it was on screen
Error = mean abs pixel difference over the window rect (0 = identical)."""
import json, os, sys
import numpy as np
from PIL import Image, ImageDraw

def load(d, f):
    return np.asarray(Image.open(os.path.join(d, f)).convert("RGB")).astype(np.int16)

def err(a, b):
    return float(np.abs(a - b).mean())

def run(d, sheet_step):
    meta = json.load(open(os.path.join(d, "meta.json"), encoding="utf-8-sig"))
    settled = {m["step"]: m for m in meta if m["sub"] == 99}
    rows = []
    worst = 0.0
    for m in meta:
        s = m["step"]
        if m["sub"] == 99 or s - 1 not in settled:
            continue
        p = settled[s - 1]
        cur = load(d, m["file"]); new = load(d, settled[s]["file"]); prev = load(d, p["file"])
        L, T, R, B = m["L"], m["T"], m["R"], m["B"]
        w, h = R - L, B - T
        win = cur[T:B, L:R]
        e_new = err(win, new[T:B, L:R])
        e_screen = err(win, prev[T:B, L:R])
        st = prev[p["T"]:p["T"] + h, p["L"]:p["L"] + w]
        e_stale = err(win[: st.shape[0], : st.shape[1]], st)
        best = min((e_new, "new"), (e_stale, "stale"), (e_screen, "screen"))[1]
        rows.append((s, m["sub"], m["ms"], (L, T, R, B), round(e_new, 2), round(e_stale, 2), round(e_screen, 2), best))
        if best != "new":
            worst = max(worst, e_new)
    bad = sum(1 for r in rows if r[-1] != "new" and r[4] > 1.0)
    print(f"{os.path.basename(d)}: {bad}/{len(rows)} mid-drag frames not showing the new layout (err>1)")
    for r in rows:
        print("  step %2d sub %d t=%5d rect=%s  new=%5.2f stale=%5.2f screen=%5.2f -> %s" % r)
    # contact sheet: previous settled frame | first frame after the move | settled frame,
    # cropped to the union of the window rects, with the window's real edge outlined in red.
    first = next(m for m in meta if m["step"] == sheet_step and m["sub"] == 0)
    picks = [(settled[sheet_step - 1], "before the move"), (first, "first frame after the move"), (settled[sheet_step], "settled")]
    x0 = min(m["L"] for m, _ in picks) - 12; y0 = min(m["T"] for m, _ in picks) - 12
    x1 = max(m["R"] for m, _ in picks) + 12; y1 = max(m["B"] for m, _ in picks) + 12
    sc = 0.5
    w, h = int((x1 - x0) * sc), int((y1 - y0) * sc)
    sheet = Image.new("RGB", (w * 3 + 16, h + 24), "white")
    dr = ImageDraw.Draw(sheet)
    for i, (m, lab) in enumerate(picks):
        im = Image.open(os.path.join(d, m["file"])).convert("RGB")
        ImageDraw.Draw(im).rectangle((m["L"] - 1, m["T"] - 1, m["R"], m["B"]), outline=(255, 0, 0))
        sheet.paste(im.crop((x0, y0, x1, y1)).resize((w, h)), (i * (w + 8), 24))
        dr.text((i * (w + 8) + 6, 6), lab, fill="black")
    return sheet

if __name__ == "__main__":
    root = sys.argv[1]
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    for name in sorted(os.listdir(root)):
        d = os.path.join(root, name)
        if os.path.isfile(os.path.join(d, "meta.json")):
            run(d, 3).save(os.path.join(out, f"{name}.png"))
