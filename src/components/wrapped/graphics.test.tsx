import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Graphic, SPARK_SIZE } from "./graphics";
import type { SlideGraphic } from "../../lib/wrappedModel";

/** Every spark's box, and the SVG's viewBox, in the SVG's own units. */
function sparkBoxes(g: SlideGraphic) {
  const { container } = render(<Graphic g={g} />);
  const svg = container.querySelector("svg")!;
  const [vx, vy, vw, vh] = svg.getAttribute("viewBox")!.split(/\s+/).map(Number);
  const boxes = [...svg.querySelectorAll("g.sm-spark")].map((p) => {
    const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(p.parentElement!.getAttribute("transform")!)!;
    // The mark is the Atlas mark's paths in a 1024 box, scaled to 2 x size and centred on the group.
    const s = Number(p.getAttribute("data-size"));
    expect(p.querySelectorAll("path").length).toBeGreaterThan(0);
    return { l: Number(m[1]) - s, r: Number(m[1]) + s, t: Number(m[2]) - s, b: Number(m[2]) + s };
  });
  return { boxes, view: { l: vx, t: vy, r: vx + vw, b: vy + vh } };
}

const hours = Array.from({ length: 24 }, (_, i) => (i === 23 ? 900 : i * 10));
const cases: [string, SlideGraphic][] = [
  ["busiest day, peak first", { kind: "spike", values: [900, 300, 120, 0, 40, 10, 5], peak: 0, first: "a", last: "b" }],
  ["busiest day, peak last", { kind: "spike", values: [5, 10, 40, 0, 120, 300, 900], peak: 6, first: "a", last: "b" }],
  ["busiest day, peak in the middle", { kind: "spike", values: [5, 10, 900, 10, 5], peak: 2, first: "a", last: "b" }],
  ["weekdays, tallest bar at 100 percent, tied", { kind: "weekdays", values: [900, 100, 200, 300, 0, 50, 900], peak: 0 }],
  ["hours, peak last", { kind: "hours", values: hours, days: 5, peak: 23 }],
  ["hours, peak first", { kind: "hours", values: hours.slice().reverse(), days: 5, peak: 0 }],
];

describe("Wrapped graphics keep the spark inside the SVG", () => {
  it.each(cases)("%s", (_name, g) => {
    const { boxes, view } = sparkBoxes(g);
    expect(boxes.length).toBeGreaterThan(0);
    // The spring pop may overshoot to about 1.25x its size: that has to fit as well.
    const over = SPARK_SIZE * 0.25;
    for (const b of boxes) {
      expect(b.t - over).toBeGreaterThanOrEqual(view.t);
      expect(b.l - over).toBeGreaterThanOrEqual(view.l);
      expect(b.r + over).toBeLessThanOrEqual(view.r);
      expect(b.b).toBeLessThanOrEqual(view.b);
    }
  });
});
