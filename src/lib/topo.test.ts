import { describe, expect, it } from "vitest";
import { contourPath, contourPaths, INDEX_EVERY, PEAK_BAND, topoPeaks } from "./topo";

describe("contourPath", () => {
  const opts = { width: 960, height: 420 };

  it("is deterministic for a seed", () => {
    expect(contourPath({ ...opts, seed: 3 })).toBe(contourPath({ ...opts, seed: 3 }));
  });

  it("differs between seeds", () => {
    expect(contourPath({ ...opts, seed: 3 })).not.toBe(contourPath({ ...opts, seed: 4 }));
  });

  it("draws real line segments and stays inside the box", () => {
    const d = contourPath(opts);
    expect(d.startsWith("M")).toBe(true);
    const nums = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
    expect(nums.length).toBeGreaterThan(400);
    for (let i = 0; i < nums.length; i += 2) {
      expect(nums[i]).toBeGreaterThanOrEqual(-0.1);
      expect(nums[i]).toBeLessThanOrEqual(opts.width + 0.1);
      expect(nums[i + 1]).toBeGreaterThanOrEqual(-0.1);
      expect(nums[i + 1]).toBeLessThanOrEqual(opts.height + 0.1);
    }
  });

  it("stays small enough to ship as one static path", () => {
    expect(contourPath(opts).length).toBeLessThan(120_000);
  });

  it("chains the cell segments into whole lines: far more joins than starts", () => {
    const d = contourPath(opts);
    const starts = (d.match(/M/g) ?? []).length;
    const joins = (d.match(/L/g) ?? []).length;
    expect(starts).toBeGreaterThan(0);
    expect(joins).toBeGreaterThan(starts * 10);
    // A ring is closed, never left as an open line with a seam.
    expect((d.match(/Z/g) ?? []).length).toBeGreaterThan(0);
  });

  it("sets every fifth level apart as an index contour, both sets inside the box", () => {
    const { minor, index } = contourPaths({ ...opts, levels: 11 });
    expect(minor.length).toBeGreaterThan(0);
    expect(index.length).toBeGreaterThan(0);
    // 11 levels: 9 ordinary, 2 index (5 and 10).
    expect(index.length).toBeLessThan(minor.length);
    expect(Math.floor(11 / INDEX_EVERY)).toBe(2);
    for (const d of [minor, index]) {
      const nums = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
      for (let i = 0; i < nums.length; i += 2) {
        expect(nums[i]).toBeGreaterThanOrEqual(-0.1);
        expect(nums[i]).toBeLessThanOrEqual(opts.width + 0.1);
        expect(nums[i + 1]).toBeGreaterThanOrEqual(-0.1);
        expect(nums[i + 1]).toBeLessThanOrEqual(opts.height + 0.1);
      }
    }
  });

  it("keeps every summit inside the middle of the frame, with two far enough apart for a saddle", () => {
    const [lo, hi] = PEAK_BAND;
    for (let seed = 1; seed <= 200; seed++) {
      const peaks = topoPeaks(seed, opts.width, opts.height);
      expect(peaks.length).toBeGreaterThanOrEqual(3);
      for (const p of peaks) {
        expect(p.x).toBeGreaterThanOrEqual(lo);
        expect(p.x).toBeLessThanOrEqual(hi);
        expect(p.y).toBeGreaterThanOrEqual(lo);
        expect(p.y).toBeLessThanOrEqual(hi);
      }
      // The two main summits sit on opposite sides of the long axis, inside the middle half of
      // it (a square box shows only that much), and close in height so both get their rings.
      expect(Math.abs(peaks[0].x - peaks[1].x)).toBeGreaterThanOrEqual(0.26);
      expect(Math.min(peaks[0].x, peaks[1].x)).toBeGreaterThanOrEqual(0.25);
      expect(Math.max(peaks[0].x, peaks[1].x)).toBeLessThanOrEqual(0.75);
      expect(peaks[1].h / peaks[0].h).toBeGreaterThanOrEqual(0.82);
    }
    // A tall frame uses its own long axis.
    const tall = topoPeaks(9, 420, 960);
    expect(Math.abs(tall[0].y - tall[1].y)).toBeGreaterThanOrEqual(0.26);
  });
});
