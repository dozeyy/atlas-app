import { describe, expect, it } from "vitest";
import {
  COPY_MAX,
  EDGE_CLEAR,
  EMPTY_SNAPSHOT,
  RING_COUNT,
  SHEET,
  SUMMIT,
  TRAIL_CURVES,
  distanceToLoop,
  readingFraction,
  readingLine,
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

describe("the live reading line", () => {
  it("uses the app's compact numbers", () => {
    expect(readingLine(reading({ done: 1204, total: 1881, tokens: 27_400_000 }))).toBe(
      "Already reading your chats: 1.2k of 1.9k, 27M tokens",
    );
    expect(readingLine(reading({ done: 7, total: 40, tokens: 950 }))).toBe("Already reading your chats: 7 of 40, 950 tokens");
  });

  it("says what it is doing before it knows how many", () => {
    expect(readingLine(reading({ total: 0 }))).toBe("Looking for your chats");
  });

  it("settles into a plain result", () => {
    expect(readingLine(reading({ done: 1881, total: 1881, tokens: 7_300_000, finished: true }))).toBe("Read 1.9k chats, 7.3M tokens");
    expect(readingLine(reading({ done: 1, total: 1, tokens: 12, finished: true }))).toBe("Read 1 chat, 12 tokens");
  });

  it("is honest when there is nothing to read or reading failed, without jokes", () => {
    expect(readingLine(reading({ available: false }))).toBe("No chats found yet.");
    expect(readingLine(reading({ failed: true }))).toContain("Atlas will read your chats when it opens");
  });

  it("never uses an exclamation mark or a dollar sign", () => {
    for (const r of [reading({}), reading({ done: 3, total: 9, tokens: 5 }), reading({ finished: true, total: 3 }), reading({ failed: true }), reading({ available: false })]) {
      expect(readingLine(r)).not.toMatch(/[!$]/);
    }
  });
});

describe("the trail follows the reading", () => {
  it("is exactly how far the chats have been read, before Install is pressed", () => {
    expect(trailProgress(snap({ reading: reading({ done: 0, total: 100 }) }))).toBe(0);
    expect(trailProgress(snap({ reading: reading({ done: 50, total: 100 }) }))).toBe(0.5);
    expect(trailProgress(snap({ reading: reading({ done: 100, total: 100, finished: true }) }))).toBe(1);
  });

  it("is not moved by the installer: Install pressed mid-read keeps following the reading", () => {
    const mid = reading({ done: 30, total: 100 });
    for (const install of [0, 0.15, 0.6, 1]) {
      expect(trailProgress(snap({ phase: "installing", install, reading: mid }))).toBe(0.3);
    }
  });

  it("stands at the mark exactly when the reading is done", () => {
    const done = reading({ finished: true, done: 9, total: 9 });
    expect(trailProgress(snap({ phase: "installing", install: 0.2, reading: done }))).toBe(1);
    expect(trailProgress(snap({ reading: reading({ done: 8, total: 9 }) }))).toBeLessThan(1);
  });

  it("has nothing to follow when there is nothing to read or the read failed", () => {
    expect(readingFraction(reading({ failed: true }))).toBe(0);
    expect(trailProgress(snap({ reading: reading({ available: false }) }))).toBe(0);
    // ...and the finished setup still carries it to the summit.
    expect(trailProgress(snap({ phase: "done", reading: reading({ available: false }) }))).toBe(1);
  });

  it("never claims more than 1 or less than 0", () => {
    expect(readingFraction(reading({ done: 120, total: 100 }))).toBe(1);
    expect(readingFraction(reading({ done: 0, total: 0 }))).toBe(0);
  });
});

describe("the screens", () => {
  it("offers one Install button and the options on Ready", () => {
    const s = screenFor(snap({}), true);
    expect(s.primary).toEqual({ label: "Install", action: "install" });
    expect(s.options && s.closable).toBe(true);
  });

  it("offers Install while the chats are still being read, not only after", () => {
    const s = screenFor(snap({ reading: reading({ done: 10, total: 100 }) }), true);
    expect(s.primary).toEqual({ label: "Install", action: "install" });
  });

  it("cannot be closed while installing, and has no button", () => {
    const s = screenFor(snap({ phase: "installing", stage: "install", reading: reading({ finished: true, total: 3, done: 3 }) }), true);
    expect(s.primary).toBeNull();
    expect(s.closable).toBe(false);
    expect(s.line).toBe("Installing Atlas");
  });

  it("keeps the reading count in the line when Install was pressed early", () => {
    const early = reading({ done: 300, total: 1000 });
    expect(screenFor(snap({ phase: "installing", stage: "unpack", reading: early }), true).line).toBe(
      "Unpacking\nStill reading your chats: 300 of 1k",
    );
    expect(screenFor(snap({ phase: "installing", stage: "install", reading: early }), true).line).toBe(
      "Installing Atlas\nStill reading your chats: 300 of 1k",
    );
  });

  it("shows the reading while it finishes after the install", () => {
    const s = screenFor(snap({ phase: "installing", stage: "reading", reading: reading({ done: 800, total: 1000 }) }), true);
    expect(s.line).toBe("Finishing your chats: 800 of 1k");
  });

  it("asks before installing over a running Atlas", () => {
    const s = screenFor(snap({ phase: "closeAtlas" }), true);
    expect(s.primary?.label).toBe("Close Atlas and continue");
  });

  it("puts the error in plain words with Retry", () => {
    const s = screenFor(snap({ phase: "error", error: "The installer stopped before it finished (code 2)." }), true);
    expect(s.line).toContain("code 2");
    expect(s.primary?.action).toBe("retry");
  });

  it("hands off by itself when Open Atlas is on, and asks when it is off", () => {
    expect(screenFor(snap({ phase: "done" }), true).primary).toBeNull();
    expect(screenFor(snap({ phase: "done" }), false).primary?.action).toBe("openAtlas");
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
