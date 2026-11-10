import { describe, expect, it } from "vitest";
import {
  MIN_BAR,
  ZERO_STUB,
  barPath,
  barTop,
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
  it("rings exactly as many days as the streak count", () => {
    const today = heatLayout([5, 0, 5, 5, 5]);
    expect(today.streak).toBe(3);
    expect([today.streakStart, today.streakEnd]).toEqual([2, 4]);
    const yesterday = heatLayout([0, 5, 5, 5, 0]);
    expect(yesterday.streak).toBe(3);
    expect([yesterday.streakStart, yesterday.streakEnd]).toEqual([1, 3]);
    const none = heatLayout([5, 0, 0]);
    expect([none.streakStart, none.streakEnd]).toEqual([-1, -1]);
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
  it("the ridge never dips below its baseline or above its peak (a week with a peak, a slide and empty days)", () => {
    const weeks = [
      [44, 30, 7.5, 0, 0, 2, 18],
      [100, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 90, 0, 0, 0],
      [5, 80, 1, 0, 70, 0.5, 0],
    ];
    for (const values of weeks) {
      const g = ridgeGeometry(values, 600, 160);
      const ys = g.pts.map((p) => p[1]);
      const lo = Math.min(...ys);
      const hi = Math.max(...ys);
      const nums = g.line.match(/-?\d+(\.\d+)?/g)!.map(Number);
      // Sample every cubic segment densely: x0,y0 then repeating (c1x,c1y c2x,c2y x,y).
      let x0 = nums[0];
      let y0 = nums[1];
      for (let k = 2; k + 5 < nums.length + 1; k += 6) {
        const [, c1y, , c2y, x1, y1] = nums.slice(k, k + 6);
        for (let s = 0; s <= 40; s++) {
          const u = s / 40;
          const y = (1 - u) ** 3 * y0 + 3 * (1 - u) ** 2 * u * c1y + 3 * (1 - u) * u * u * c2y + u ** 3 * y1;
          expect(y).toBeLessThanOrEqual(hi + 0.01);
          expect(y).toBeGreaterThanOrEqual(lo - 0.01);
        }
        x0 = x1;
        y0 = y1;
      }
      expect(x0).toBeGreaterThan(0);
      expect(hi).toBeLessThanOrEqual(g.baseline);
    }
  });
  it("barPath keeps a flat bottom on the baseline", () => {
    expect(barPath(10, 8, 20, 100, 6)).toContain("V100Z");
    expect(barPath(10, 8, 99, 100, 6)).toBe("M10,100h8v-1h-8Z");
  });
});

describe("barTop", () => {
  // A 30-day Activity chart (made-up figures): a 150M peak on a 200M scale, a 162 px plot.
  const base = 162;
  const top = 28;
  const max = 200e6;
  const h = (v: number) => base - barTop(v, max, base, top);

  it("a day with usage is never drawn lower than an empty day's stub", () => {
    // A 2M day was 1.3 px tall, under the 3 px stub of the empty days beside it.
    expect(h(2e6)).toBeGreaterThan(ZERO_STUB);
    expect(h(69e3)).toBe(MIN_BAR);
    expect(h(0)).toBe(0);
  });
  it("stays proportional above the floor", () => {
    expect(h(150e6)).toBeCloseTo(0.75 * (base - top), 6);
    expect(h(44e6) / h(18e6)).toBeCloseTo(44 / 18, 6);
    expect(h(max * 3)).toBe(base - top);
  });
  it("an empty scale draws nothing", () => {
    expect(h(NaN)).toBe(0);
    expect(base - barTop(5, 0, base, top)).toBe(0);
  });
});
