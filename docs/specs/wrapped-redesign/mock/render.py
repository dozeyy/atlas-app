"""Render the Wrapped redesign mockups to PNG with headless Chrome (1280 x 800, the Atlas window).
Usage: python docs/specs/wrapped-redesign/mock/render.py [a|b|c ...]
Output: docs/specs/wrapped-redesign/<direction>/<nn>-<slide>-<theme>.png and a contact sheet per theme."""
import pathlib, subprocess, sys

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent
PROFILE = pathlib.Path(__import__("tempfile").gettempdir()) / "atlas-wrapped-mock-chrome"
BROWSER = r"C:\Program Files\Google\Chrome\Application\chrome.exe"  # headless Edge returned without a picture here
DIRS = {
    "a": ("a-summit.html", "a-summit", [(1, "opener"), (2, "totals"), (3, "days"), (6, "clock"), (8, "compare"), (11, "helper"), (15, "end")]),
    "b": ("b-patches.html", "b-patches", [(1, "opener"), (2, "totals"), (3, "days"), (6, "clock"), (8, "compare"), (11, "helper"), (15, "end")]),
    "c": ("c-departures.html", "c-departures", [(1, "opener"), (2, "totals"), (3, "days"), (6, "clock"), (8, "compare"), (11, "helper"), (15, "end")]),
}


def shot(page: pathlib.Path, s: int, theme: str, out: pathlib.Path) -> None:
    url = page.as_uri() + f"?s={s}&t={theme}"
    subprocess.run([BROWSER, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
                    "--window-size=1280,800", f"--user-data-dir={PROFILE}", "--virtual-time-budget=3000", f"--screenshot={out}", url],
                   check=True, capture_output=True, timeout=60)
    import time
    for _ in range(100):
        if out.exists() and out.stat().st_size > 0:
            return
        time.sleep(0.1)
    raise RuntimeError(f"no screenshot: {out}")


def sheet(files, out):
    from PIL import Image
    w, h = 640, 400
    cols = 3
    rows = (len(files) + cols - 1) // cols
    im = Image.new("RGB", (w * cols, h * rows), "white")
    for i, f in enumerate(files):
        t = Image.open(f).convert("RGB").resize((w, h), Image.LANCZOS)
        im.paste(t, ((i % cols) * w, (i // cols) * h))
    im.save(out)


for key in sys.argv[1:] or DIRS:
    page, folder, slides = DIRS[key]
    dest = OUT / folder
    dest.mkdir(exist_ok=True)
    for theme in ("light", "dark"):
        files = []
        for s, name in slides:
            f = dest / f"{s:02d}-{name}-{theme}.png"
            shot(HERE / page, s, theme, f)
            files.append(f)
        sheet(files, dest / f"sheet-{theme}.png")
    print(folder, "done")
