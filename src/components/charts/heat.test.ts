import { describe, expect, it } from "vitest";
import { heatCell, heatWeeks, MAX_WEEKS, MIN_WEEKS } from "./HeatGrid";

describe("heat grid sizing", () => {
  it("shows at least 12 weeks and at most a year", () => {
    expect(heatWeeks(100)).toBe(MIN_WEEKS);
    expect(heatWeeks(5000)).toBe(MAX_WEEKS);
  });

  it("shows more weeks as the room grows", () => {
    expect(heatWeeks(900)).toBeGreaterThan(heatWeeks(400));
  });

  it("flexes the cell so whole weeks meet the edge, never past 18 px", () => {
    const w = 700;
    const weeks = heatWeeks(w);
    const cell = heatCell(w, weeks);
    expect(cell).toBeGreaterThanOrEqual(10);
    expect(cell).toBeLessThanOrEqual(18);
    expect(weeks * (cell + 4) - 4).toBeLessThanOrEqual(w);
    expect(heatCell(3000, 12)).toBe(18);
  });
});
