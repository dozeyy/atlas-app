import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Graphic, heatBand, smooth, tileBoxes, wavePath } from "./graphics";
import type { SlideChart } from "../../lib/wrappedModel";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `item-${i}`, value: (n - i) * 10, note: `${(n - i) * 10} uses` }));
const days = Array.from({ length: 60 }, (_, i) => (i % 9 === 0 ? 0 : 100 + ((i * 37) % 90)));

const CHARTS: SlideChart[] = [
  { kind: "ridge", values: days },
  { kind: "spines", count: 360 },
  { kind: "trail", from: "2026-07-09", to: "2026-11-08", days: 122 },
  { kind: "heat", values: days, start: 3, run: [10, 14], weeks: 10 },
  { kind: "tower", value: 6_500_000, avg: 400_000 },
  { kind: "dial", hours: 30 },
  { kind: "tiles", rows: rows(5) },
  { kind: "podium", rows: rows(5) },
  { kind: "lollipop", rows: rows(4) },
  { kind: "burst", count: 40 },
  { kind: "bubbles", rows: rows(5) },
  { kind: "spike", values: days.slice(0, 21), peak: 10, first: "Oct 1", last: "Oct 21" },
  { kind: "spokes", values: [4, 9, 3, 2, 8, 1, 0] },
  { kind: "strip", values: Array.from({ length: 24 }, (_, h) => (h === 22 ? 900 : h * 3)) },
  { kind: "donut", rows: rows(4) },
  { kind: "badge", id: "owl", name: "Night Owl", score: 1.4, traits: [{ name: "Night Owl", score: 1.4, note: "62% at night" }, { name: "Sprinter", score: 0.7, note: "30% under ten minutes" }] },
];

describe("every hero graphic", () => {
  it("covers all sixteen kinds", () => {
    expect(new Set(CHARTS.map((c) => c.kind)).size).toBe(16);
  });

  for (const chart of CHARTS) {
    it(`${chart.kind}: draws from the data, names itself, animates in pieces and has no NaN`, () => {
      const { container } = render(<Graphic chart={chart} />);
      expect(container.firstElementChild, chart.kind).not.toBeNull();
      expect(container.innerHTML).not.toMatch(/NaN|undefined|Infinity/);
      expect(container.querySelector('[role="img"], [role="list"]'), chart.kind).not.toBeNull();
      expect(container.querySelectorAll("[data-a]").length, chart.kind).toBeGreaterThan(0);
    });
  }

  it("keeps every drawn shape on or above its baseline", () => {
    // The ridge, the spike and the tower sit on a baseline at the bottom of their box: no y past it.
    const ridge = render(<Graphic chart={CHARTS[0]} />).container;
    const [, , w, h] = ridge.querySelector("svg")!.getAttribute("viewBox")!.split(" ").map(Number);
    expect(w).toBe(1000);
    for (const path of Array.from(ridge.querySelectorAll("path"))) {
      const ys = (path.getAttribute("d") ?? "").match(/-?\d+(\.\d+)?/g)!.map(Number).filter((_, i) => i % 2 === 1);
      for (const y of ys) {
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(h);
      }
    }
    const spike = render(<Graphic chart={CHARTS[11]} />).container;
    const vb = spike.querySelector("svg")!.getAttribute("viewBox")!.split(" ").map(Number);
    for (const r of Array.from(spike.querySelectorAll("rect"))) {
      expect(Number(r.getAttribute("y")) + Number(r.getAttribute("height"))).toBeLessThanOrEqual(260 + 0.001);
      expect(Number(r.getAttribute("height"))).toBeGreaterThan(0);
    }
    expect(vb[3]).toBeGreaterThan(260);
  });

  it("draws zero days at a floor, never at a negative height", () => {
    const { container } = render(<Graphic chart={{ kind: "spike", values: [0, 0, 5, 0], peak: 2, first: "a", last: "b" }} />);
    for (const r of Array.from(container.querySelectorAll("rect"))) expect(Number(r.getAttribute("height"))).toBeGreaterThan(0);
  });

  it("says 'and N more' for a shelf too big to draw", () => {
    const { container } = render(<Graphic chart={{ kind: "spines", count: 360 }} />);
    expect(container.querySelectorAll(".g-book")).toHaveLength(12);
    expect(container.textContent).toContain("and 348 more");
    const small = render(<Graphic chart={{ kind: "spines", count: 3 }} />).container;
    expect(small.querySelectorAll(".g-book")).toHaveLength(3);
    expect(small.textContent).not.toContain("more");
  });

  it("puts the podium in 2-1-3 order with the winner marked and the rest as tags", () => {
    const { container } = render(<Graphic chart={CHARTS[7]} />);
    const pods = Array.from(container.querySelectorAll(".g-pod"));
    expect(pods.map((p) => p.getAttribute("data-rank"))).toEqual(["2", "1", "3"]);
    expect(container.querySelectorAll(".g-pod[data-first]")).toHaveLength(1);
    expect(container.querySelectorAll(".g-podium-rest li")).toHaveLength(2);
    // Counted down: the last place has the lowest rank number, the winner the highest.
    const r = (el: Element) => Number((el as HTMLElement).style.getPropertyValue("--r"));
    expect(r(container.querySelector('.g-pod[data-rank="1"]')!)).toBeGreaterThan(r(container.querySelector('.g-pod[data-rank="3"]')!));
    const tags = Array.from(container.querySelectorAll(".g-podium-rest li")).map(r);
    expect(tags).toEqual([1, 0]);
  });

  it("copes with one-item and empty-ish data", () => {
    for (const chart of [
      { kind: "tiles", rows: rows(1) },
      { kind: "podium", rows: rows(1) },
      { kind: "podium", rows: rows(2) },
      { kind: "lollipop", rows: rows(2) },
      { kind: "bubbles", rows: rows(2) },
      { kind: "donut", rows: rows(2) },
      { kind: "burst", count: 1 },
      { kind: "burst", count: 500 },
      { kind: "ridge", values: [0, 0, 0] },
      { kind: "ridge", values: [5] },
      { kind: "dial", hours: 0.2 },
      { kind: "dial", hours: 96 },
      { kind: "spokes", values: [0, 0, 0, 0, 0, 0, 0] },
      { kind: "strip", values: new Array(24).fill(0) },
      { kind: "heat", values: [1, 2], start: 0, run: null, weeks: 1 },
    ] as SlideChart[]) {
      const { container } = render(<Graphic chart={chart} />);
      expect(container.innerHTML, chart.kind).not.toMatch(/NaN|undefined|Infinity/);
    }
  });
});

describe("the graphic helpers", () => {
  it("draws a wave that never leaves the range of its points", () => {
    const pts: [number, number][] = [[0, 50], [10, 10], [20, 90], [30, 40]];
    const nums = wavePath(pts).match(/-?\d+(\.\d+)?/g)!.map(Number);
    for (let i = 1; i < nums.length; i += 2) {
      expect(nums[i]).toBeGreaterThanOrEqual(10);
      expect(nums[i]).toBeLessThanOrEqual(90);
    }
    expect(wavePath([])).toBe("");
  });

  it("smooths by a window and keeps the length", () => {
    expect(smooth([0, 0, 9, 0, 0], 1)).toEqual([0, 3, 3, 3, 0].map((v, i) => (i === 0 ? 0 : i === 4 ? 0 : v)));
    expect(smooth([], 3)).toEqual([]);
  });

  it("bands a heat cell by its place among active days, zero staying zero", () => {
    const active = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(heatBand(0, active)).toBe(0);
    expect(heatBand(10, active)).toBe(1);
    expect(heatBand(100, active)).toBe(5);
    expect(heatBand(5, [])).toBe(0);
  });

  it("slices tiles so their areas follow their values and fill the box", () => {
    const v = [50, 30, 20];
    const boxes = tileBoxes(v);
    const area = (b: { w: number; h: number }) => b.w * b.h;
    expect(boxes.reduce((s, b) => s + area(b), 0)).toBeCloseTo(10_000, 3);
    boxes.forEach((b, i) => expect(area(b)).toBeCloseTo(v[i] * 100, 3));
    expect(tileBoxes([])).toEqual([]);
    expect(tileBoxes([7])).toEqual([{ x: 0, y: 0, w: 100, h: 100 }]);
  });
});
