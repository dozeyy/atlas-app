import { describe, expect, it } from "vitest";
import { beatAt, clamp01, EASES, pieceAt, pieceWindow, pulseAfter, seg, STAGGER_MS, STAGGER_TOTAL_MS } from "./wrappedClock";
import type { Beat, EaseName } from "./wrappedClock";

describe("seg", () => {
  it("is 0 before the window, 1 after it and linear inside", () => {
    expect(seg(0.1, 0.2, 0.6)).toBe(0);
    expect(seg(0.2, 0.2, 0.6)).toBe(0);
    expect(seg(0.4, 0.2, 0.6)).toBeCloseTo(0.5, 9);
    expect(seg(0.6, 0.2, 0.6)).toBe(1);
    expect(seg(0.9, 0.2, 0.6)).toBe(1);
  });
  it("treats an empty window as a step", () => {
    expect(seg(0.4, 0.5, 0.5)).toBe(0);
    expect(seg(0.5, 0.5, 0.5)).toBe(1);
  });
  it("clamps", () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(7)).toBe(1);
  });
});

describe("the easings", () => {
  const names = Object.keys(EASES) as EaseName[];
  it("start at 0 and finish at 1 (the pulse comes back to 0)", () => {
    for (const n of names) {
      expect(EASES[n](0), n).toBeCloseTo(0, 9);
      expect(EASES[n](1), n).toBeCloseTo(n === "pulse" ? 0 : n === "steps12" ? 1 : 1, 9);
    }
  });
  it("never give NaN, in or out of range", () => {
    for (const n of names) for (const x of [-1, 0, 0.001, 0.3, 0.5, 0.999, 1, 2]) expect(Number.isFinite(EASES[n](x)), `${n} ${x}`).toBe(true);
  });
  it("overshoot for the spring and the back ease, then settle", () => {
    for (const n of ["spring", "outBack"] as const) {
      const peak = Math.max(...Array.from({ length: 200 }, (_, i) => EASES[n](i / 199)));
      expect(peak, n).toBeGreaterThan(1.03);
      expect(peak, n).toBeLessThan(1.4);
    }
  });
  it("never overshoot for the plain eases, and rise monotonically", () => {
    for (const n of ["linear", "outCubic", "outQuart", "inQuad", "inOutCubic"] as const) {
      let last = -1;
      for (let i = 0; i <= 100; i++) {
        const v = EASES[n](i / 100);
        expect(v, n).toBeGreaterThanOrEqual(last);
        expect(v, n).toBeLessThanOrEqual(1);
        last = v;
      }
    }
  });
  it("swing past 1 once and settle: the spring has no second wobble worth seeing", () => {
    const xs = Array.from({ length: 400 }, (_, i) => i / 399);
    const v = xs.map((x) => EASES.spring(x));
    // After its one overshoot the spring never leaves a 1.5% band round 1.
    const after = v.slice(Math.floor(0.6 * 399));
    expect(Math.max(...after)).toBeLessThan(1.02);
    expect(Math.min(...after)).toBeGreaterThan(0.985);
  });
  it("the landing ease (outQuart) never passes 1", () => {
    expect(Math.max(...Array.from({ length: 101 }, (_, i) => EASES.outQuart(i / 100)))).toBe(1);
  });
  it("steps in twelfths", () => {
    expect(EASES.steps12(0.49)).toBeCloseTo(5 / 12, 9);
    expect(EASES.steps12(0.5)).toBeCloseTo(6 / 12, 9);
  });
});

describe("beats", () => {
  const beats: Beat[] = [
    { id: "a", start: 0, end: 0.5, ease: "linear" },
    { id: "b", start: 0.5, end: 1, ease: "outCubic" },
  ];
  it("read the eased progress of one beat from the shared t", () => {
    expect(beatAt(beats, "a", 0.25)).toBeCloseTo(0.5, 9);
    expect(beatAt(beats, "b", 0.25)).toBe(0);
    expect(beatAt(beats, "b", 1)).toBe(1);
  });
  it("throws for a beat that does not exist, so a typo cannot hide", () => {
    expect(() => beatAt(beats, "z", 0.5)).toThrow(/no beat/);
  });
});

describe("pieces", () => {
  const beat: Beat = { id: "hero", start: 0.1, end: 0.7, ease: "linear" };
  const ms = 2600;
  it("start one stagger step apart, land one after another, and the last one ends with the beat", () => {
    const w = [0, 1, 2, 3].map((i) => pieceWindow(beat, ms, i, 4));
    for (let i = 1; i < w.length; i++) {
      expect((w[i][0] - w[i - 1][0]) * ms).toBeCloseTo(STAGGER_MS, 6);
      expect((w[i][1] - w[i - 1][1]) * ms).toBeCloseTo(STAGGER_MS, 6);
    }
    expect(w[3][1]).toBeCloseTo(beat.end, 9);
  });
  it("keep the whole fan under the total, however many pieces follow each other", () => {
    for (const n of [2, 5, 12, 30, 182]) {
      const first = pieceWindow(beat, ms, 0, n)[0];
      const last = pieceWindow(beat, ms, n - 1, n)[0];
      expect((last - first) * ms, `n=${n}`).toBeLessThanOrEqual(STAGGER_TOTAL_MS + 1e-6);
      expect(pieceWindow(beat, ms, n - 1, n)[1], `n=${n}`).toBeCloseTo(beat.end, 9);
      expect(last, `n=${n}`).toBeLessThan(beat.end);
    }
  });
  it("land every piece by the end of the beat, the last one included", () => {
    const beats = [beat];
    for (let i = 0; i < 6; i++) expect(pieceAt(beats, "hero", beat.end, ms, i, 6)).toBe(1);
    expect(pieceAt(beats, "hero", beat.start, ms, 0, 6)).toBe(0);
    // A later piece is behind an earlier one at the same moment.
    expect(pieceAt(beats, "hero", 0.3, ms, 5, 6)).toBeLessThan(pieceAt(beats, "hero", 0.3, ms, 0, 6));
  });
  it("a single piece is the beat itself", () => {
    expect(pieceWindow(beat, ms, 0, 1)).toEqual([beat.start, beat.end]);
  });
  it("pulses once, from the moment given, and is gone after", () => {
    expect(pulseAfter(0.2, 0.3, ms, 300)).toBe(0);
    expect(pulseAfter(0.3 + 150 / ms, 0.3, ms, 300)).toBeCloseTo(1, 6);
    expect(pulseAfter(0.9, 0.3, ms, 300)).toBeCloseTo(0, 6);
  });
});