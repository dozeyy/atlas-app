import { describe, expect, it } from "vitest";
import { liftOver, type Box } from "./toastPlace";

const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });

describe("liftOver", () => {
  const pile = box(340, 514, 780, 580);

  it("stays put when nothing is under the pile", () => {
    expect(liftOver(pile, [], 40)).toBe(0);
    // Save sits to the right of the pile, the Name field above it.
    expect(liftOver(pile, [box(815, 540, 876, 574), box(349, 225, 868, 253)], 40)).toBe(0);
  });

  it("rises to just over a Cancel button it would cover", () => {
    const cancel = box(735, 540, 805, 574);
    const lift = liftOver(pile, [cancel, box(815, 540, 876, 574)], 40);
    expect(lift).toBe(580 - 540 + 8);
    expect(pile.bottom - lift).toBeLessThan(cancel.top);
  });

  it("rises again when the first rise lands on another control", () => {
    const cancel = box(735, 540, 805, 574);
    const field = box(349, 480, 868, 520);
    const lift = liftOver(pile, [cancel, field], 40);
    expect(pile.bottom - lift).toBeLessThanOrEqual(field.top - 8);
  });

  it("settles for clearing the action row when the sheet has no free band", () => {
    const rows = Array.from({ length: 12 }, (_, i) => box(349, 60 + i * 40, 868, 96 + i * 40));
    const cancel = box(735, 540, 805, 574);
    expect(liftOver(pile, [...rows, cancel], 40)).toBe(580 - 500 + 8);
  });

  it("ignores a control with no size", () => {
    expect(liftOver(pile, [box(400, 550, 400, 550)], 40)).toBe(0);
  });
});
