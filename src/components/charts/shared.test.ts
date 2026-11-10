import { describe, expect, it } from "vitest";
import { clearPeak, stepIndex } from "./shared";

describe("clearPeak (which bar gets the summit spark)", () => {
  it("picks the one bar that stands clear of the rest", () => {
    expect(clearPeak([2, 3, 9, 4, 3])).toBe(2);
    expect(clearPeak([0, 0, 5, 12, 6, 0])).toBe(3);
  });

  it("plants nothing on level bars, a tie at the top, a lone bar or an empty chart", () => {
    expect(clearPeak([5, 5, 5, 5])).toBe(-1);
    expect(clearPeak([10, 10.2, 9.9, 10.1])).toBe(-1);
    expect(clearPeak([3, 9, 9, 2])).toBe(-1);
    expect(clearPeak([3, 9, 8.8, 2])).toBe(-1);
    expect(clearPeak([0, 7, 0])).toBe(-1);
    expect(clearPeak([4, 9])).toBe(-1);
    expect(clearPeak([])).toBe(-1);
    expect(clearPeak([0, 0])).toBe(-1);
  });
});

describe("stepIndex (chart keyboard)", () => {
  it("starts from the right edge for Left/End and the left edge for Right", () => {
    expect(stepIndex("ArrowRight", null, 10)).toBe(0);
    expect(stepIndex("ArrowLeft", null, 10)).toBe(9);
    expect(stepIndex("End", null, 10)).toBe(9);
    expect(stepIndex("Home", 5, 10)).toBe(0);
  });

  it("clamps at both ends", () => {
    expect(stepIndex("ArrowRight", 9, 10)).toBe(9);
    expect(stepIndex("ArrowLeft", 0, 10)).toBe(0);
  });

  it("jumps a week at a time on the heat grid, and ignores Up/Down on a bar chart", () => {
    expect(stepIndex("ArrowDown", 3, 100, 7)).toBe(10);
    expect(stepIndex("ArrowUp", 3, 100, 7)).toBe(0);
    expect(stepIndex("ArrowDown", 3, 100)).toBeUndefined();
  });

  it("Escape clears the readout; an empty chart or other keys do nothing", () => {
    expect(stepIndex("Escape", 4, 10)).toBeNull();
    expect(stepIndex("ArrowRight", null, 0)).toBeUndefined();
    expect(stepIndex("a", 4, 10)).toBeUndefined();
  });
});
