"""Contact sheet for tools/analyze-continuous.py: per frame, the area around one drawn edge (L, R, T
or B) at 2x, the release frame first, so an offset the judge reports can be looked at.

  python tools/edge-sheet.py <frames-root>/shrink-R R <out.png> [frame indexes, e.g. 1,2,6]
"""
import importlib.util, json, os, sys
import numpy as np
from PIL import Image, ImageDraw

spec = importlib.util.spec_from_file_location("ac", os.path.join(os.path.dirname(os.path.abspath(__file__)), "analyze-continuous.py"))
ac = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ac)

d, side, out = sys.argv[1], sys.argv[2], sys.argv[3]
meta = json.load(open(os.path.join(d, "meta.json"), encoding="utf-8-sig"))
frames = [m for m in meta if m["sub"] < 97]
if len(sys.argv) > 4:
    frames = [frames[int(i)] for i in sys.argv[4].split(",")]
frames = [next(m for m in meta if m["sub"] == 98)] + frames
tiles = []
for m in frames:
    rgb = ac.load(d, m["file"])
    w = ac.drawn_rect(rgb, m) if ac.has_backdrop(rgb) else {k: m[k] for k in "LTRB"}
    img = Image.fromarray(rgb.astype(np.uint8))
    box = {
        "R": (w["R"] - 180, w["T"] + 60, w["R"] + 60, w["T"] + 380),
        "L": (w["L"] - 60, w["T"] + 60, w["L"] + 180, w["T"] + 380),
        "B": (w["L"] - 20, w["B"] - 180, w["L"] + 300, w["B"] + 60),
        "T": (w["L"] - 20, w["T"] - 60, w["L"] + 300, w["T"] + 180),
    }[side]
    t = img.crop(box)
    t = t.resize((t.width * 2, t.height * 2), Image.NEAREST)
    dr = ImageDraw.Draw(t)
    dr.rectangle((0, 0, 200, 22), fill=(255, 255, 255))
    dr.text((4, 4), m["file"] + (" release" if m["sub"] == 98 else ""), fill=(0, 0, 0))
    tiles.append(t)
W, H = tiles[0].size
cols = min(5, len(tiles))
sheet = Image.new("RGB", ((W + 4) * cols, (H + 4) * ((len(tiles) + cols - 1) // cols)), (255, 255, 255))
for i, t in enumerate(tiles):
    sheet.paste(t, ((i % cols) * (W + 4), (i // cols) * (H + 4)))
sheet.save(out)
print(out, sheet.size)
