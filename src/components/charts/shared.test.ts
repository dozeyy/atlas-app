import { describe, expect, it } from "vitest";
import { stepIndex } from "./shared";

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
