import { describe, expect, it } from "vitest";
import { bucket, bucketAndSmooth } from "./smooth";

const sum = (a: number[]) => a.reduce((n, v) => n + v, 0);

describe("bucket", () => {
  it("sums a long run into n even buckets and keeps the total", () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    const b = bucket(values, 24);
    expect(b).toHaveLength(24);
    expect(sum(b)).toBe(sum(values));
    // Left to right: the later buckets hold the larger values.
    expect(b[23]).toBeGreaterThan(b[0]);
  });

  it("passes a short run through unchanged, as a copy", () => {
    const values = [3, 0, 7];
    const b = bucket(values, 24);
    expect(b).toEqual(values);
    expect(b).not.toBe(values);
    expect(bucket([], 24)).toEqual([]);
  });

  it("keeps exactly n points when the run is a multiple of n, and every value lands once", () => {
    const b = bucket(Array.from({ length: 48 }, () => 1), 24);
    expect(b).toEqual(new Array(24).fill(2));
  });
});

describe("bucketAndSmooth", () => {
  it("draws no more than n points, as a monotone curve from the first to the last", () => {
    const values = Array.from({ length: 300 }, (_, i) => (i % 17) * 10);
    const s = bucketAndSmooth(values, 24, 144, 30);
    expect(s.values).toHaveLength(24);
    expect(s.pts).toHaveLength(24);
    expect(s.line.startsWith("M")).toBe(true);
    expect(s.line.split("C")).toHaveLength(24); // one cubic per step
    expect(s.last).toEqual(s.pts[23]);
    expect(s.area.endsWith("Z")).toBe(true);
  });

  it("never dips under the baseline where usage falls to zero", () => {
    const values = [0, 900, 0, 0, 40, 0, 0, 0, 800, 0];
    const s = bucketAndSmooth(values, 24, 144, 30);
    // Every control point and anchor of the path sits on or above the baseline (smaller y is higher).
    const ys = [...s.line.matchAll(/[\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(ys.length).toBeGreaterThan(0);
    for (const y of ys) expect(y).toBeLessThanOrEqual(s.baseline + 1e-9);
  });

  it("spans the box: the peak reaches the top margin, the last point ends at the right margin", () => {
    const s = bucketAndSmooth([1, 5, 2], 24, 100, 40, 2, 2, 2);
    expect(s.pts[0][0]).toBe(2);
    expect(s.last?.[0]).toBe(98);
    expect(s.pts[1][1]).toBe(2);
    expect(s.baseline).toBe(38);
    expect(s.peak).toBe(1);
  });

  it("gives an empty trace nothing to draw", () => {
    const s = bucketAndSmooth([], 24, 100, 40);
    expect(s.last).toBeNull();
    expect(s.line).toBe("");
    expect(s.area).toBe("");
  });
});
