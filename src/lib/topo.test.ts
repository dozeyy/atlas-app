import { describe, expect, it } from "vitest";
import { contourPath } from "./topo";

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
});
