import { describe, expect, it } from "vitest";
import { beatAt, clamp01, EASES, seg } from "./wrappedClock";
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
    for (const n of ["linear", "outCubic", "inOutCubic"] as const) {
      let last = -1;
      for (let i = 0; i <= 100; i++) {
        const v = EASES[n](i / 100);
        expect(v, n).toBeGreaterThanOrEqual(last);
        expect(v, n).toBeLessThanOrEqual(1);
        last = v;
      }
    }
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
