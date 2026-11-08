import { describe, expect, it } from "vitest";
import {
  barPath,
  heatBand,
  heatCuts,
  heatLayout,
  longestStreak,
  ridgeGeometry,
  ringGeometry,
  smoothPath,
  streakLength,
  usualDay,
} from "./chartPaths";

describe("streakLength", () => {
  it("counts consecutive active days ending today", () => {
    expect(streakLength([0, 5, 5, 5])).toBe(3);
  });
  it("runs to yesterday when today is still empty", () => {
    expect(streakLength([0, 5, 5, 0])).toBe(2);
  });
  it("is zero with no activity", () => {
    expect(streakLength([0, 0, 0])).toBe(0);
    expect(streakLength([])).toBe(0);
  });
  it("stops at the first gap", () => {
    expect(streakLength([5, 0, 5, 5])).toBe(2);
  });
});

describe("longestStreak", () => {
  it("finds the longest run anywhere", () => {
    expect(longestStreak([1, 1, 0, 1, 1, 1, 0, 1])).toBe(3);
    expect(longestStreak([])).toBe(0);
  });
});

describe("heat bands", () => {
  it("puts zero in band 0 and the biggest day in band 5", () => {
    const vals = Array.from({ length: 50 }, (_, i) => (i + 1) * 100);
    const cuts = heatCuts(vals);
    expect(cuts).toHaveLength(4);
    expect(heatBand(0, cuts)).toBe(0);
    expect(heatBand(5000, cuts)).toBe(5);
    expect(heatBand(100, cuts)).toBe(1);
  });
  it("has no cuts without activity", () => {
    expect(heatCuts([0, 0])).toEqual([]);
    expect(heatBand(5, [])).toBe(1);
  });
});

describe("heatLayout", () => {
  it("puts today bottom-right of 12 rolling weeks", () => {
    const vals = Array.from({ length: 84 }, () => 5);
    const l = heatLayout(vals);
    expect(l.weeks).toBe(12);
    expect(l.todayCell).toMatchObject({ col: 11, row: 6 });
    expect(l.cells[0]).toMatchObject({ col: 0, row: 0 });
    expect(l.streak).toBe(84);
  });
  it("pads a partial first column at the top", () => {
    const l = heatLayout(Array.from({ length: 10 }, () => 1));
    expect(l.cells[0].row).toBe(4);
    expect(l.todayCell?.row).toBe(6);
  });
});

describe("ridgeGeometry", () => {
  it("finds the peak and closes the area to the baseline", () => {
    const g = ridgeGeometry([1, 5, 3], 100, 100);
    expect(g.peak).toBe(1);
    expect(g.area.endsWith("Z")).toBe(true);
    expect(g.pts[1][1]).toBeLessThan(g.pts[0][1]);
  });
  it("survives all zeros and a single point", () => {
    expect(ridgeGeometry([0, 0, 0], 100, 100).line).toMatch(/^M/);
    expect(ridgeGeometry([4], 100, 100).line).toMatch(/^M/);
  });
});

describe("ringGeometry", () => {
  it("is empty at 0, full at 1 and runs a second lap past it", () => {
    expect(ringGeometry(104, 11, 0).offset).toBeCloseTo(ringGeometry(104, 11, 0).circ);
    expect(ringGeometry(104, 11, 1).offset).toBeCloseTo(0);
    expect(ringGeometry(104, 11, 1).offset2).toBeNull();
    const g = ringGeometry(104, 11, 1.5);
    expect(g.offset).toBeCloseTo(0);
    expect(g.offset2).toBeCloseTo(g.circ * 0.5);
  });
});

describe("usualDay", () => {
  it("is the median of the active days only", () => {
    expect(usualDay([0, 0, 10, 20, 30])).toBe(20);
    expect(usualDay([0, 10, 20])).toBe(15);
    expect(usualDay([0, 0])).toBe(0);
  });
});

describe("paths", () => {
  it("smoothPath handles few points", () => {
    expect(smoothPath([])).toBe("");
    expect(smoothPath([[1, 2]])).toBe("M1,2");
    expect(smoothPath([[0, 0], [10, 5]])).toMatch(/^M0,0C/);
  });
  it("barPath keeps a flat bottom on the baseline", () => {
    expect(barPath(10, 8, 20, 100, 6)).toContain("V100Z");
    expect(barPath(10, 8, 99, 100, 6)).toBe("M10,100h8v-1h-8Z");
  });
});
