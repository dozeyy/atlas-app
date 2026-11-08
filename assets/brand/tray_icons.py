"""Tray icons from the brand mark (mark only, no tile). Run from the repo root:
python make_tray_icons.py <repo>"""
import sys
from PIL import Image

repo = sys.argv[1]
src = Image.open(f"{repo}/assets/brand/atlas-mark-1024.png").convert("RGBA")
src = src.crop(src.getbbox())


def fit(size, margin):
    box = size - 2 * margin
    w, h = src.size
    k = box / max(w, h)
    im = src.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(im, ((size - im.width) // 2, (size - im.height) // 2), im)
    return out


fit(64, 2).save(f"{repo}/crates/app/icons/tray.png", optimize=True)
t = fit(44, 2)
# Template image: macOS tints it, only the alpha matters.
t = Image.merge("RGBA", (*[Image.new("L", t.size, 0)] * 3, t.getchannel("A")))
t.save(f"{repo}/crates/app/icons/tray-template.png", optimize=True)
print("ok")
