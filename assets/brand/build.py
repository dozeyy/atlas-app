# Clean Atlas icon from the ChatGPT image: keep the mark's shape, redraw edges and tile.
import sys
from collections import deque

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

src, out = sys.argv[1], sys.argv[2]
im = np.asarray(Image.open(src).convert("RGBA")).astype(np.float32)
H, W = im.shape[:2]
tile_rgb = np.median(im[300:600, 300:600, :3].reshape(-1, 3), axis=0)
right = im[:, W // 2 + 60:]
rgb, a = right[..., :3], right[..., 3]
orange = (a > 128) & (rgb[..., 0] > 180) & (rgb[..., 1] > 90) & (rgb[..., 1] < 160) & (rgb[..., 2] < 120)
mark_rgb = np.median(rgb[orange], axis=0)

# Connected components: keep the big ones (spark + dot), drop the specks.
lab = np.zeros(orange.shape, np.int32)
sizes = {}
n = 0
for y, x in zip(*np.nonzero(orange)):
    if lab[y, x]:
        continue
    n += 1
    q = deque([(y, x)])
    lab[y, x] = n
    c = 0
    while q:
        cy, cx = q.popleft()
        c += 1
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = cy + dy, cx + dx
            if 0 <= ny < lab.shape[0] and 0 <= nx < lab.shape[1] and orange[ny, nx] and not lab[ny, nx]:
                lab[ny, nx] = n
                q.append((ny, nx))
    sizes[n] = c
keep = [k for k, s in sizes.items() if s > 2000]
print("components kept:", [sizes[k] for k in keep], "tile", tile_rgb.round(), "mark", mark_rgb.round())
mask = np.isin(lab, keep)
ys, xs = np.nonzero(mask)
crop = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]

# Square canvas around the mark, then smooth edges: upscale, blur, threshold.
side = max(crop.shape)
pad = np.zeros((side, side), bool)
oy, ox = (side - crop.shape[0]) // 2, (side - crop.shape[1]) // 2
pad[oy:oy + crop.shape[0], ox:ox + crop.shape[1]] = crop
S = 4096
big = Image.fromarray((pad * 255).astype(np.uint8)).resize((S, S), Image.BICUBIC).filter(ImageFilter.GaussianBlur(10))
big = big.point(lambda v: 255 if v >= 128 else 0)


def mark_layer(size):
    return big.resize((size, size), Image.LANCZOS)


def color_img(mask_img, rgb):
    layer = Image.new("RGBA", mask_img.size, tuple(int(v) for v in rgb) + (0,))
    layer.putalpha(mask_img)
    return layer


M = 1024
# macOS tile: rounded square on the Apple 824 px body grid, mark 60% of the body.
tile = Image.new("L", (M * 4, M * 4), 0)
inset, r = 100 * 4, 185 * 4
ImageDraw.Draw(tile).rounded_rectangle((inset, inset, M * 4 - inset, M * 4 - inset), r, fill=255)
tile = tile.resize((M, M), Image.LANCZOS)
icon = color_img(tile, tile_rgb)
ms = int((M - 200) * 0.60)
icon.alpha_composite(color_img(mark_layer(ms), mark_rgb), ((M - ms) // 2, (M - ms) // 2))
icon.save(out + "/atlas-icon-1024.png")

# Full-bleed tile for Windows (no transparent margin).
full = Image.new("L", (M * 4, M * 4), 0)
ImageDraw.Draw(full).rounded_rectangle((0, 0, M * 4, M * 4), 230 * 4, fill=255)
full = color_img(full.resize((M, M), Image.LANCZOS), tile_rgb)
ms2 = int(M * 0.60)
full.alpha_composite(color_img(mark_layer(ms2), mark_rgb), ((M - ms2) // 2, (M - ms2) // 2))
full.save(out + "/atlas-icon-fullbleed-1024.png")

# Mark alone on transparent, for the tray.
color_img(mark_layer(M), mark_rgb).save(out + "/atlas-mark-1024.png")

# Preview: sizes on light and dark.
prev = Image.new("RGBA", (1200, 360), (236, 233, 228, 255))
prev.alpha_composite(Image.new("RGBA", (600, 360), (30, 30, 30, 255)), (600, 0))
for bg in (0, 600):
    x = bg + 20
    for s in (256, 64, 32, 16):
        prev.alpha_composite(icon.resize((s, s), Image.LANCZOS), (x, 30))
        x += s + 20
    prev.alpha_composite(color_img(mark_layer(16), mark_rgb), (bg + 20, 320))
    prev.alpha_composite(color_img(mark_layer(32), mark_rgb), (bg + 50, 312))
prev.save(out + "/preview.png")
