import { describe, expect, it } from "vitest";
import {
  COPY_MAX,
  EDGE_CLEAR,
  KEY_WINDOW_MS,
  isOwnPress,
  EMPTY_SNAPSHOT,
  RING_COUNT,
  SHEET,
  SUMMIT,
  TRAIL_CURVES,
  distanceToLoop,
  readingFraction,
  ringPath,
  ringPoints,
  screenFor,
  splitNumbers,
  trailPath,
  trailProgress,
  trailSamples,
  type Reading,
  type Snapshot,
} from "./view";

const reading = (p: Partial<Reading>): Reading => ({ ...EMPTY_SNAPSHOT.reading, ...p });
const snap = (p: Partial<Snapshot>): Snapshot => ({ ...EMPTY_SNAPSHOT, ...p });

describe("which clicks count as a person's own press", () => {
  const click = (o: Partial<{ isTrusted: boolean; detail: number; timeStamp: number }> = {}) => ({ isTrusted: true, detail: 1, timeStamp: 1000, ...o });

  it("counts a real mouse click and refuses a script's click", () => {
    expect(isOwnPress(click(), "primary", null)).toBe(true);
    expect(isOwnPress(click({ isTrusted: false }), "primary", null)).toBe(false);
    expect(isOwnPress(click({ isTrusted: false, detail: 0 }), "primary", { id: "primary", at: 990 })).toBe(false);
  });

  it("counts a keyboard click only right after Enter or Space went down on that same button", () => {
    const kb = click({ detail: 0, timeStamp: 1500 });
    expect(isOwnPress(kb, "primary", null)).toBe(false); // a stray keyup or a focus-driven click
    expect(isOwnPress(kb, "primary", { id: "secondary", at: 1400 })).toBe(false);
    expect(isOwnPress(kb, "primary", { id: "primary", at: 1400 })).toBe(true);
    expect(isOwnPress(kb, "primary", { id: "primary", at: 1500 - KEY_WINDOW_MS - 1 })).toBe(false);
    expect(isOwnPress(kb, "primary", { id: "primary", at: 1600 })).toBe(false); // keydown from the future
  });
});

describe("the trail", () => {
  it("climbs with whichever is further, the installer or the reading, and never claims more than 1", () => {
    const r = reading({ done: 50, total: 100 });
    expect(trailProgress(snap({ phase: "installing", install: 0.04, reading: r }))).toBe(0.5);
    expect(trailProgress(snap({ phase: "installing", install: 0.85, reading: r }))).toBe(0.85);
    expect(trailProgress(snap({ phase: "installing", install: 0.2, reading: reading({ done: 100, total: 100, finished: true }) }))).toBe(1);
    expect(readingFraction(reading({ done: 120, total: 100 }))).toBe(1);
    expect(readingFraction(reading({ done: 0, total: 0 }))).toBe(0);
  });

  it("has nothing to follow in the reading when there is nothing to read or it failed", () => {
    expect(readingFraction(reading({ failed: true }))).toBe(0);
    expect(trailProgress(snap({ phase: "installing", install: 0.3, reading: reading({ available: false }) }))).toBe(0.3);
    expect(trailProgress(snap({ phase: "done", reading: reading({ available: false }) }))).toBe(1);
  });

  it("follows only the remover while removing, and starts at the foot before the yes", () => {
    const r = reading({ done: 90, total: 100 });
    expect(trailProgress(snap({ mode: "uninstall", phase: "ready", reading: r }))).toBe(0);
    expect(trailProgress(snap({ mode: "uninstall", phase: "installing", install: 0.35, reading: r }))).toBe(0.35);
    expect(trailProgress(snap({ mode: "uninstall", phase: "done", install: 1 }))).toBe(1);
  });
});

describe("the install screens (it starts by itself, so there is no Install button)", () => {
  it("shows the step, the reading under it, and nothing to press or close", () => {
    const early = reading({ done: 300, total: 1000 });
    const s = screenFor(snap({ phase: "installing", stage: "unpack", reading: early }));
    expect(s.line).toBe("Unpacking\nReading your chats: 300 of 1k");
    expect(s.primary).toBeNull();
    expect(s.closable).toBe(false);
    expect(screenFor(snap({ phase: "installing", stage: "install", reading: early })).line).toBe("Installing Atlas\nReading your chats: 300 of 1k");
  });

  it("says only 'Installing Atlas' when there is no reading to report", () => {
    expect(screenFor(snap({ phase: "installing", stage: "install", reading: reading({ finished: true, total: 3, done: 3 }) })).line).toBe("Installing Atlas");
  });

  it("says 'Opening Atlas' at the hand-off, and 'All set.' with no buttons when done", () => {
    expect(screenFor(snap({ phase: "installing", stage: "opening", reading: reading({ done: 5, total: 9 }) })).line).toBe("Opening Atlas");
    const d = screenFor(snap({ phase: "done" }));
    expect(d.line).toBe("All set.");
    expect(d.primary).toBeNull();
    expect(d.closable).toBe(false);
  });

  it("never offers the saved-data box while installing", () => {
    for (const phase of ["ready", "closeAtlas", "installing", "done", "error"] as const) expect(screenFor(snap({ phase })).dataBox).toBe(false);
  });

  it("asks before closing a running Atlas, and puts an error in plain words with Retry", () => {
    expect(screenFor(snap({ phase: "closeAtlas" })).primary?.label).toBe("Close Atlas and continue");
    const e = screenFor(snap({ phase: "error", error: "The installer stopped before it finished (code 2)." }));
    expect(e.line).toContain("code 2");
    expect(e.primary?.action).toBe("retry");
  });
});

describe("the remover screen", () => {
  const out = (p: Partial<Snapshot>) => snap({ mode: "uninstall", ...p });

  it("asks once, with one primary button and the saved-data box", () => {
    const s = screenFor(out({}));
    expect(s.line).toBe("Remove Atlas from this computer?");
    expect(s.primary).toEqual({ label: "Uninstall", action: "uninstall" });
    expect(s.dataBox && s.closable).toBe(true);
  });

  it("names what it is doing, and cannot be closed meanwhile", () => {
    const lines = (stage: Snapshot["stage"]) => screenFor(out({ phase: "installing", stage }));
    expect(lines("closing").line).toBe("Closing Atlas");
    expect(lines("removing").line).toBe("Removing Atlas");
    expect(lines("data").line).toBe("Removing saved data");
    for (const st of ["closing", "removing", "data"] as const) {
      expect(lines(st).closable).toBe(false);
      expect(lines(st).primary).toBeNull();
      expect(lines(st).dataBox).toBe(false);
    }
  });

  it("ends with Close, and says plainly whether saved data was kept", () => {
    const kept = screenFor(out({ phase: "done" }), false);
    expect(kept.line).toBe("Atlas is removed.\nYour saved data is kept.");
    expect(kept.primary).toEqual({ label: "Close", action: "close" });
    expect(screenFor(out({ phase: "done" }), true).line).toBe("Atlas is removed.");
    // Removal was asked for, but a folder without Atlas's marker was left whole.
    expect(screenFor(out({ phase: "done", dataKept: true }), true).line).toBe("Atlas is removed.\nSome saved data is kept.");
  });

  it("puts a failure in plain words with Retry", () => {
    const e = screenFor(out({ phase: "error", error: "Atlas is still there." }));
    expect(e.primary?.action).toBe("retry");
    expect(e.line).toBe("Atlas is still there.");
  });

  it("promises nothing about the chats on the screen that the words do not keep", () => {
    // The promise lives in setup.html as a fixed line; the screen text never mentions deleting chats.
    for (const phase of ["ready", "installing", "done", "error"] as const) {
      expect(screenFor(out({ phase, stage: "removing", error: "x" })).line).not.toMatch(/delete.*chat/i);
    }
  });
});

describe("number styling", () => {
  it("splits numbers from words", () => {
    expect(splitNumbers("Read 1.9k chats, 27M tokens")).toEqual([
      { text: "Read ", num: false },
      { text: "1.9k", num: true },
      { text: " chats, ", num: false },
      { text: "27M", num: true },
      { text: " tokens", num: false },
    ]);
  });
});

describe("contour rings", () => {
  it("are closed, repeatable, and differ ring to ring", () => {
    const a = ringPath(100, 100, 1);
    expect(a.endsWith("Z")).toBe(true);
    expect(a).toBe(ringPath(100, 100, 1));
    expect(a).not.toBe(ringPath(100, 100, 2));
  });

  it("never touch or cross: neighbours stay at least 20 px apart everywhere", () => {
    for (let i = 0; i + 1 < RING_COUNT; i++) {
      const inner = ringPoints(SUMMIT.x, SUMMIT.y, i);
      const outer = ringPoints(SUMMIT.x, SUMMIT.y, i + 1);
      const apart = Math.min(
        ...inner.map((p) => distanceToLoop(p, outer)),
        ...outer.map((p) => distanceToLoop(p, inner)),
      );
      expect(apart, `ring ${i} to ${i + 1}`).toBeGreaterThanOrEqual(20);
    }
  });

  it("nest: every ring's points sit outside the one before it", () => {
    // Star-shaped about the summit and strictly growing along every ray = nested, no crossings.
    for (let i = 0; i + 1 < RING_COUNT; i++) {
      const a = ringPoints(0, 0, i);
      const b = ringPoints(0, 0, i + 1);
      a.forEach((p, k) => expect(Math.hypot(...b[k])).toBeGreaterThan(Math.hypot(...p) + 20));
    }
  });
});

describe("the trail", () => {
  const samples = trailSamples();

  it("never enters the area the words and options can cover, with room to spare", () => {
    const { x, y, w, h } = COPY_MAX;
    for (const [px, py] of samples) {
      const dx = Math.max(x - px, 0, px - (x + w));
      const dy = Math.max(y - py, 0, py - (y + h));
      expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(16);
    }
  });

  it("keeps clear of the sheet's edge and its close button", () => {
    for (const [px, py] of samples) {
      expect(px).toBeGreaterThanOrEqual(EDGE_CLEAR + 8);
      expect(px).toBeLessThanOrEqual(SHEET.w - EDGE_CLEAR - 8);
      expect(py).toBeLessThanOrEqual(SHEET.h - EDGE_CLEAR - 8);
      expect(Math.hypot(px - 532, py - 28)).toBeGreaterThan(60);
    }
  });

  it("is one connected path", () => {
    expect(trailPath().startsWith("M 40 352 C")).toBe(true);
    TRAIL_CURVES.slice(1).forEach((c, i) => expect(c[0]).toEqual(TRAIL_CURVES[i][3]));
  });
});