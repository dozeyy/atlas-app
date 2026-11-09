"""For each mid-drag frame, which picture is on screen?
  new    = the settled frame of this step (correct, relaid-out content)
  stale  = the previous step's settled content, pinned to the window's new top-left corner
  screen = the previous step's settled content, left where it was on screen
Error = mean abs pixel difference over the window rect (0 = identical).
Also checks whether the app relays out live at all: a settled frame that equals the previous
layout pinned to the new top-left means the content was only clipped, and the "released" frame
(700 ms after mouse-up) shows whether the layout changed once the drag ended."""
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
        if m["sub"] >= 90 or s - 1 not in settled:
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
        # A window that has not taken the new size yet (Atlas holds it until the page has drawn
        # that size) is right when it still shows the previous layout: "held". When the content
        # inside the overlap with the new rect already matches the new layout, only the moving
        # edge's strip is off: "lead" (the page drew first, the window follows a frame later).
        same_as_prev = (L, T, R, B) == (p["L"], p["T"], p["R"], p["B"])
        if same_as_prev and e_screen < 1.0:
            best = "held"
        elif best != "new" or e_new > 1.0:
            n = settled[s]
            iL, iT, iR, iB = max(L, n["L"]), max(T, n["T"]), min(R, n["R"]), min(B, n["B"])
            if iR > iL and iB > iT and err(cur[iT:iB, iL:iR], new[iT:iB, iL:iR]) < 1.0:
                best = "lead"
        rows.append((s, m["sub"], m["ms"], (L, T, R, B), round(e_new, 2), round(e_stale, 2), round(e_screen, 2), best))
        if best not in ("new", "held"):
            worst = max(worst, e_new)
    bad = sum(1 for r in rows if r[-1] in ("stale", "screen") and r[4] > 1.0)
    lead = sum(1 for r in rows if r[-1] == "lead")
    held = sum(1 for r in rows if r[-1] == "held")
    print(f"{os.path.basename(d)}: {bad}/{len(rows)} mid-drag frames show content out of place (err>1); "
          f"{lead} edge-strip-only (lead), {held} held at the previous size")
    frozen = 0
    for s in sorted(settled):
        if s - 1 not in settled:
            continue
        a, b = settled[s - 1], settled[s]
        w, h = b["R"] - b["L"], b["B"] - b["T"]
        cur = load(d, b["file"])[b["T"]:b["B"], b["L"]:b["R"]]
        st = load(d, a["file"])[a["T"]:a["T"] + h, a["L"]:a["L"] + w]
        if (a["R"] - a["L"], a["B"] - a["T"]) != (w, h) and err(cur[: st.shape[0], : st.shape[1]], st) < 0.3:
            frozen += 1
    rel = next((m for m in meta if m["sub"] == 98), None)
    line = f"  live relayout: {len(settled) - 1 - frozen}/{len(settled) - 1} settled steps relaid out"
    if rel:
        last = settled[max(settled)]
        if (rel["R"] - rel["L"], rel["B"] - rel["T"]) == (last["R"] - last["L"], last["B"] - last["T"]):
            line += f"; released vs last settled err={err(load(d, rel['file'])[rel['T']:rel['B'], rel['L']:rel['R']], load(d, last['file'])[last['T']:last['B'], last['L']:last['R']]):.2f}"
    print(line)
    # Press and release bursts (subs 90..97): every frame right after the press must equal the
    # window before it; every frame right after the release must equal either the last settled
    # frame or the released one (same rect), nothing in between.
    win = lambda m, im: im[m["T"]:m["B"], m["L"]:m["R"]]
    def same(m, ref):
        if (m["R"] - m["L"], m["B"] - m["T"]) != (ref["R"] - ref["L"], ref["B"] - ref["T"]):
            return float("inf")
        return err(win(m, load(d, m["file"])), win(ref, load(d, ref["file"])))
    press = [m for m in meta if m["step"] == 0 and 90 <= m["sub"] < 98]
    if press and 0 in settled:
        errs = [same(m, settled[0]) for m in press]
        print(f"  press: {sum(e > 1.0 for e in errs)}/{len(errs)} frames differ from before the press (max err {max(errs):.2f})")
    last = max(settled) if settled else None
    after = [m for m in meta if last is not None and m["step"] == last + 1 and 90 <= m["sub"] < 98]
    if after and rel:
        errs = [min(same(m, settled[last]), same(m, rel)) for m in after]
        print(f"  release: {sum(e > 1.0 for e in errs)}/{len(errs)} frames match neither the last drag frame nor the final one (max err {max(errs):.2f})")
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
