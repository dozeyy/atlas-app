import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { dialFrame, dialModel, Graphic, heatBand, smooth, SPINES_LABEL_BELOW, spineGeometry, SPOKE, SPOKE_LEAD, SPOKE_RING, spokeFrame, spokeGeometry, spokeTimeline, tileBoxes, TRAIL_CLEAR, trailMarks, wavePath } from "./graphics";
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

  it("keeps every book and the label inside the box, at any count", () => {
    for (const count of [1, 5, 12, 13, 360, 999, 1011, 1012, 6400, 1e6]) {
      const g = spineGeometry(count);
      const top = 330 - g.shown * g.step; // y of the highest book
      expect(top, String(count)).toBeGreaterThanOrEqual(g.label ? 24 : 4);
      expect(g.height, String(count)).toBeGreaterThan(10);
      const { container } = render(<Graphic chart={{ kind: "spines", count }} />);
      for (const r of Array.from(container.querySelectorAll("g.g-book > rect"))) {
        const y = Number(r.getAttribute("y"));
        expect(y, String(count)).toBeGreaterThanOrEqual(0);
        expect(y + Number(r.getAttribute("height")), String(count)).toBeLessThanOrEqual(332);
      }
      const label = container.querySelector("text");
      if (label) expect(Number(label.getAttribute("y")), String(count)).toBeGreaterThanOrEqual(14);
    }
  });

  it("drops the 'more' label when the rest is as big as the figure beside it", () => {
    const { container } = render(<Graphic chart={{ kind: "spines", count: 6400 }} />);
    expect(container.textContent).not.toContain("more");
    expect(container.querySelectorAll(".g-book")).toHaveLength(12);
    expect(spineGeometry(SPINES_LABEL_BELOW + 12).label).toBe(false);
    expect(spineGeometry(SPINES_LABEL_BELOW + 11).label).toBe(true);
  });
  it("skips a trail month mark that would touch the flag or Today", () => {
    // 2026-07-09 + 122 days: Nov 1 is day 115, 51 units short of Today, so it goes; Aug to Oct stay.
    const marks = trailMarks("2026-07-09", 122).map((m) => m.label);
    expect(marks).toEqual(["Aug", "Sep", "Oct"]);
    for (const m of trailMarks("2025-01-01", 700)) {
      expect(m.x - 56).toBeGreaterThanOrEqual(TRAIL_CLEAR);
      expect(1000 - 56 - m.x).toBeGreaterThanOrEqual(TRAIL_CLEAR);
    }
    // A mark just inside the clear zone from the start is skipped too (Aug 1 is day 1 of a 31-day walk from Jul 31).
    expect(trailMarks("2026-07-31", 31)).toEqual([]);
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

describe("the weekday dial geometry", () => {
  const DATA = [[4, 9, 3, 2, 8, 1, 0], [0, 0, 0, 0, 0, 0, 0], [5, 5, 5, 5, 5, 5, 5], [1, 0, 0, 0, 0, 0, 100], [100, 1, 1, 1, 1, 1, 1]];
  const deg = (x: number, y: number) => ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;

  it("puts every label on its spoke's own line, clear of the longest spoke and the ring by a fixed gap", () => {
    for (const values of DATA) {
      const geo = spokeGeometry(values);
      expect(geo).toHaveLength(7);
      geo.forEach((s, i) => {
        // The label is centred on the spoke's angle (to a thousandth of a degree).
        expect(Math.abs((deg(s.lx, s.ly) - s.angle + 540) % 360 - 180), `label ${i} angle`).toBeLessThan(0.001);
        // The spoke at 100% ends at start + maxLen; the ring sits past it; the label's nearest edge past the ring by the gap.
        expect(s.len).toBeGreaterThanOrEqual(SPOKE.minLen);
        expect(s.len).toBeLessThanOrEqual(SPOKE.maxLen);
        expect(SPOKE_RING).toBeGreaterThanOrEqual(SPOKE.start + SPOKE.maxLen + SPOKE.ringGap);
        expect(s.labelInner, `label ${i} edge`).toBeGreaterThanOrEqual(SPOKE_RING + SPOKE.gap - 1e-9);
        // The label box stays inside the drawing.
        expect(Math.abs(s.lx) + SPOKE.labelW / 2).toBeLessThanOrEqual(SPOKE.half);
        expect(Math.abs(s.ly) + SPOKE.labelH / 2).toBeLessThanOrEqual(SPOKE.half);
      });
    }
  });

  it("keeps the seven label boxes apart", () => {
    const geo = spokeGeometry([4, 9, 3, 2, 8, 1, 0]);
    for (let i = 0; i < 7; i++) {
      for (let j = i + 1; j < 7; j++) {
        const dx = Math.abs(geo[i].lx - geo[j].lx) - SPOKE.labelW;
        const dy = Math.abs(geo[i].ly - geo[j].ly) - SPOKE.labelH;
        expect(Math.max(dx, dy), `${i} and ${j}`).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it("draws the bars and the labels from that geometry", () => {
    const { container } = render(<Graphic chart={{ kind: "spokes", values: [4, 9, 3, 2, 8, 1, 0] }} />);
    const geo = spokeGeometry([4, 9, 3, 2, 8, 1, 0]);
    const texts = Array.from(container.querySelectorAll("text"));
    expect(texts.map((t) => t.textContent)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    texts.forEach((t, i) => {
      expect(Number(t.getAttribute("x"))).toBeCloseTo(geo[i].lx, 6);
      expect(Number(t.getAttribute("y"))).toBeCloseTo(geo[i].ly, 6);
    });
    const bars = Array.from(container.querySelectorAll("rect.g-spoke"));
    bars.forEach((b, i) => {
      expect(b.parentElement?.getAttribute("transform")).toBe(`rotate(${geo[i].angle})`);
      expect(Number(b.getAttribute("y"))).toBeCloseTo(-(SPOKE.start + geo[i].len), 6);
    });
  });

  it("runs the hand and every spoke on one value: each spoke is full the moment the hand is on it, the busiest last", () => {
    for (const values of DATA) {
      const tl = spokeTimeline(values);
      const topAngle = (tl.top / 7) * 360;
      // The hand ends exactly on the busiest spoke.
      expect(spokeFrame(values, 1).hand).toBeCloseTo(topAngle, 9);
      expect(spokeFrame(values, 1).grow.every((g) => g === 1)).toBe(true);
      expect(spokeFrame(values, 0).grow.every((g) => g === 0)).toBe(true);
      expect(tl.arrive[tl.top]).toBe(1);
      expect(Math.max(...tl.arrive)).toBe(1);
      for (let i = 0; i < 7; i++) {
        if (i === tl.top) continue;
        // The hand's angle at the instant spoke i is full is that spoke's angle.
        const h = tl.arrive[i];
        const handThen = spokeFrame(values, h).hand;
        expect(Math.abs((((handThen - (i / 7) * 360 + 180) % 360) + 360) % 360 - 180), `spoke ${i}`).toBeLessThan(1e-9);
        expect(spokeFrame(values, h).grow[i]).toBe(1);
        // And it was still empty a lead before.
        expect(spokeFrame(values, h - SPOKE_LEAD / 360).grow[i]).toBe(0);
        // The busiest spoke lands after every other one.
        expect(h).toBeLessThan(1);
      }
    }
  });
});

describe("the sitting dial timeline", () => {
  it("draws exactly the turn the hand has made, at every moment", () => {
    for (const hours of [0.2, 3, 12, 14.5, 30, 47.9, 60, 96]) {
      const m = dialModel(hours);
      for (const p of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const f = dialFrame(m, p);
        // Turns drawn by the rings = turns the hand has made.
        const drawn = m.fills.reduce((s, fill, k) => s + (fill - f.offsets[k]), 0);
        expect(drawn, `${hours} h at ${p}`).toBeCloseTo(p * m.turns, 9);
        expect(f.hand / 360, `${hours} h at ${p}`).toBeCloseTo(p * m.turns, 9);
        // A ring draws only once the hand is on its lap.
        m.fills.forEach((fill, k) => {
          if (f.hand / 360 <= k) expect(f.offsets[k]).toBe(fill);
        });
      }
      // The hand ends on the sitting's own angle and every ring is full.
      expect(dialFrame(m, 1).offsets.every((o) => Math.abs(o) < 1e-9)).toBe(true);
      expect(dialFrame(m, 1).hand % 360).toBeCloseTo(m.end, 6);
    }
    expect(dialModel(14.5).end).toBeCloseTo(((14.5 % 12) / 12) * 360, 9);
  });

  it("turns the hand about the dial centre by an SVG attribute, so no CSS origin can move the pivot", () => {
    const { container } = render(<Graphic chart={{ kind: "dial", hours: 5 }} />);
    const hand = container.querySelector("svg > g[transform^='rotate(']")!;
    expect(hand.hasAttribute("data-a")).toBe(false);
    // Tests run with reduced motion, so the clock has already landed on t = 1: five hours is 150 degrees.
    expect(hand.getAttribute("transform")).toMatch(/^rotate\(150(\.00)? 150 150\)$/);
    const spokes = render(<Graphic chart={{ kind: "spokes", values: [4, 9, 3, 2, 8, 1, 0] }} />).container;
    const sh = Array.from(spokes.querySelectorAll("svg > g")).find((g) => g.getAttribute("transform")?.startsWith("rotate(") && g.querySelector("line"))!;
    expect(sh.hasAttribute("data-a")).toBe(false);
    // Busiest is Tuesday, 360/7 degrees round.
    expect(Number(sh.getAttribute("transform")!.match(/rotate\(([-\d.]+)\)/)![1])).toBeCloseTo(360 / 7, 1);
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

  it("gives every tile its full name and hint in a hover, so a clipped tile still says who it is", () => {
    const rows = [
      { label: "Origin Client (Games Godot)", name: "Origin Client", hint: "Games Godot", value: 60 },
      { label: "Origin Client (Minecraft Mods)", name: "Origin Client", hint: "Minecraft Mods", value: 40 },
    ];
    const { container } = render(<Graphic chart={{ kind: "tiles", rows }} />);
    const tiles = [...container.querySelectorAll(".g-tile-in")];
    expect(tiles.map((t) => t.getAttribute("title"))).toEqual(["Origin Client (Games Godot)", "Origin Client (Minecraft Mods)"]);
    expect(tiles.map((t) => t.querySelector(".g-tile-name")?.textContent)).toEqual(["Origin Client", "Origin Client"]);
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
