import { describe, expect, it } from "vitest";
import {
  burstLayout,
  BURST_MAX,
  commandBars,
  dialFrame,
  dialModel,
  donutSectors,
  FAN,
  fanFrame,
  fanLayout,
  fanTimeline,
  heroBoxFor,
  hourCells,
  lollipops,
  podiumLayout,
  skyline,
  spikeLayout,
  tileBoxes,
  towerBlocks,
  TOWER_MAX,
  trailLayout,
  TRAIL_CLEAR,
} from "./posterMath";
import type { HeroBox } from "./posterMath";
import { BOXES, FRAME_H, FRAME_W } from "./wrappedPoster";
import type { Layout } from "./wrappedPoster";

const LAYOUTS = Object.keys(BOXES) as Layout[];
const BOX: HeroBox = {
  w: 760,
  h: 380,
  ox: 0,
  fullW: 760,
  floor: 350,
  ceil: 26,
  side: "r",
};

/** Distance from a point to a polygon (0 inside). */
function distToPoly(p: [number, number], poly: [number, number][]): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
    const dx = xj - xi;
    const dy = yj - yi;
    const t = Math.max(0, Math.min(1, ((p[0] - xi) * dx + (p[1] - yi) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p[0] - (xi + t * dx), p[1] - (yi + t * dy)));
  }
  return inside ? 0 : best;
}

describe("heroBoxFor", () => {
  it("keeps the data inside the frame and above the floor in every layout", () => {
    for (const l of LAYOUTS) {
      const p = BOXES[l];
      const b = heroBoxFor(p);
      expect(b.w, l).toBeGreaterThan(200);
      expect(b.ceil, l).toBeLessThan(b.floor);
      expect(p.hero.x + b.ox, l).toBeGreaterThanOrEqual(0);
      expect(p.hero.x + b.ox + b.w, l).toBeLessThanOrEqual(FRAME_W);
      expect(p.hero.y + b.floor, l).toBeLessThanOrEqual(FRAME_H);
      expect(p.hero.y + b.ceil, l).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the weekday fan", () => {
  const values = [3, 5, 4, 9, 6, 2, 1];
  const spokes = fanLayout(values, 300, 260);

  it("fans seven spokes with the busiest one reaching past the face", () => {
    expect(spokes).toHaveLength(7);
    const top = spokes.find((s) => s.top);
    expect(top?.day).toBe(3);
    expect(top?.len).toBe(FAN.R + FAN.over);
    for (const s of spokes) if (!s.top) expect(s.len).toBeLessThan(FAN.R);
  });

  it("keeps every label clear of every spoke", () => {
    for (const s of spokes)
      for (const o of spokes) {
        const d = distToPoly([s.label.x, s.label.y], o.poly);
        expect(d, `label ${s.day} vs spoke ${o.day}`).toBeGreaterThanOrEqual(
          FAN.label - 6,
        );
      }
  });

  it("lands the hand on the busiest spoke, never past it, and starts every spoke at nothing", () => {
    const { top } = fanTimeline(spokes);
    expect(fanFrame(spokes, 0).hand).toBe(180);
    expect(fanFrame(spokes, 1).hand).toBeCloseTo(top.angle, 6);
    let last = 181;
    for (let k = 0; k <= 100; k++) {
      const f = fanFrame(spokes, k / 100);
      expect(f.hand).toBeLessThanOrEqual(last);
      expect(f.hand).toBeGreaterThanOrEqual(top.angle - 1e-9);
      last = f.hand;
    }
    expect(fanFrame(spokes, 0).grow.every((g) => g === 0)).toBe(true);
    expect(fanFrame(spokes, 1).grow.every((g) => g === 1)).toBe(true);
  });

  it("grows a spoke from the same p the hand reads: a spoke is full once the hand has passed it", () => {
    for (let k = 0; k <= 100; k++) {
      const f = fanFrame(spokes, k / 100);
      spokes.forEach((s, i) => {
        const { top } = fanTimeline(spokes);
        if (s.angle >= top.angle && f.hand < s.angle - 30)
          expect(f.grow[i], `p=${k / 100} day ${s.day}`).toBe(1);
        if (f.hand > s.angle + 1e-9 && s.angle >= top.angle)
          expect(f.grow[i], `p=${k / 100} day ${s.day} not reached`).toBeLessThan(1);
      });
    }
  });
});

describe("the dial", () => {
  it("draws the turns the hand has made, from one progress", () => {
    for (const hours of [1.5, 6, 12, 30, 75]) {
      const m = dialModel(hours);
      for (let k = 0; k <= 20; k++) {
        const p = k / 20;
        const f = dialFrame(m, p);
        const drawn = m.fills.reduce((s, fill, i) => s + (fill - f.offsets[i]), 0);
        expect(drawn * 360, `${hours}h p=${p}`).toBeCloseTo(f.hand, 6);
      }
    }
  });
  it("caps at four rings", () => {
    expect(dialModel(500).fills).toHaveLength(4);
  });
});

describe("tiles", () => {
  it("fill the box exactly with no overlap", () => {
    const box = { x: 10, y: 20, w: 600, h: 300 };
    const t = tileBoxes([50, 30, 20, 10, 5], box);
    expect(t).toHaveLength(5);
    const area = t.reduce((s, b) => s + b.w * b.h, 0);
    expect(area).toBeCloseTo(box.w * box.h, 3);
    for (const b of t) {
      expect(b.x).toBeGreaterThanOrEqual(box.x - 1e-9);
      expect(b.y).toBeGreaterThanOrEqual(box.y - 1e-9);
      expect(b.x + b.w).toBeLessThanOrEqual(box.x + box.w + 1e-9);
      expect(b.y + b.h).toBeLessThanOrEqual(box.y + box.h + 1e-9);
    }
    for (let i = 0; i < t.length; i++)
      for (let j = i + 1; j < t.length; j++) {
        const a = t[i];
        const b = t[j];
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(w > 1e-6 && h > 1e-6, `${i} x ${j}`).toBe(false);
      }
  });
});

describe("the bars, the burst, the podium and the skyline", () => {
  it("keep the skyline in its box", () => {
    const bars = skyline([1, 5, 2, 9, 4, 7, 3, 8, 2, 6, 1, 4, 9, 3, 5, 2, 7], BOX);
    for (const b of bars) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(BOX.w);
      expect(b.y).toBeGreaterThanOrEqual(BOX.ceil - 1e-9);
      expect(b.y + b.h).toBeCloseTo(BOX.floor, 6);
    }
    expect(bars.filter((b) => b.peak)).toHaveLength(1);
  });

  it("draw the skyline on one scale: a zero is a zero, and a half is half", () => {
    const bars = skyline([0, 5, 10, 0], BOX);
    const room = BOX.floor - BOX.ceil;
    expect(bars[0].h).toBe(0);
    expect(bars[3].h).toBe(0);
    expect(bars[2].h).toBeCloseTo(room, 6);
    expect(bars[1].h).toBeCloseTo(room / 2, 6);
    // A quiet day never borrows the height of a loud one.
    expect(skyline([0, 0, 0], BOX).every((b) => b.h === 0)).toBe(true);
  });

  it("draw the spikes on the same honest scale, zero at the floor", () => {
    const s = spikeLayout([0, 4, 8, 0], 2, BOX);
    const room = BOX.floor - BOX.ceil;
    expect(s[0].h).toBe(0);
    expect(s[3].h).toBe(0);
    expect(s[2].h / s[1].h).toBeCloseTo(2, 6);
    expect(s[2].h).toBeLessThanOrEqual(room + 1e-9);
  });

  it("keep the podium inside its box, tallest last", () => {
    const bars = podiumLayout([4, 9, 5, 7, 3], BOX);
    for (const b of bars) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(BOX.w);
      expect(b.y).toBeGreaterThanOrEqual(BOX.ceil - 1e-9);
      expect(b.y + b.h).toBeCloseTo(BOX.floor, 6);
    }
    expect(bars[bars.length - 1].rank).toBe(1);
  });

  it("only promises as many label characters as fit along the bar (22 px mono, 14.3 a letter)", () => {
    for (const vals of [[4, 9, 5, 7, 3], [25, 24, 21, 12, 3], [1, 1, 1, 1, 1]]) {
      for (const b of podiumLayout(vals, BOX)) {
        expect(b.chars * 14.3).toBeLessThanOrEqual(b.h - 40);
      }
    }
  });

  it("set a long name smaller (never under 16) so the whole of it runs along its bar", () => {
    const names = ["away-mode", "ui-ux-pro-max", "fewer-permission-prompts", "design-critique", "orchestrate"];
    const bars = podiumLayout([25, 24, 21, 12, 3], BOX, names.map((n) => n.length));
    for (const b of bars) {
      const len = names[b.rank - 1].length;
      expect(b.px, names[b.rank - 1]).toBeGreaterThanOrEqual(16);
      expect(b.px).toBeLessThanOrEqual(22);
      // If the name fits at all, it fits whole.
      if (len * 16 * 0.65 <= b.h - 48) expect(b.chars, names[b.rank - 1]).toBeGreaterThanOrEqual(len);
    }
    // A short name keeps the full size.
    expect(bars.find((b) => b.rank === 1)!.px).toBe(22);
  });

  it("keep the command bars stacked inside the box and inside the cap", () => {
    const { bars, cap } = commandBars([2682, 1607, 1068, 82, 40], BOX);
    for (const b of bars) {
      expect(b.y).toBeGreaterThanOrEqual(BOX.ceil - 1e-9);
      expect(b.y + b.h).toBeLessThanOrEqual(BOX.floor + 1e-9);
      expect(b.len).toBeLessThanOrEqual(cap + 1e-9);
      expect(b.len).toBeGreaterThanOrEqual(cap * 0.4 - 1e-9);
    }
    for (let i = 1; i < bars.length; i++)
      expect(bars[i].y).toBeGreaterThanOrEqual(bars[i - 1].y + bars[i - 1].h);
    expect(bars[0].len).toBeCloseTo(cap, 6);
  });

  it("keep the spikes in the box with the peak tallest", () => {
    const s = spikeLayout([1, 2, 9, 3, 1], 2, BOX);
    for (const k of s) {
      expect(k.x).toBeGreaterThanOrEqual(0);
      expect(k.x + k.w).toBeLessThanOrEqual(BOX.w);
      expect(k.h).toBeLessThanOrEqual(BOX.floor - BOX.ceil + 1e-9);
    }
    expect(Math.max(...s.map((k) => k.h))).toBe(s[2].h);
  });

  it("keep the burst's satellites apart and the true count honest", () => {
    for (let n = 1; n <= BURST_MAX + 10; n++) {
      const { shown, sats } = burstLayout(n, 0, 0, 122, 210);
      expect(shown).toBe(Math.min(n, BURST_MAX));
      expect(sats).toHaveLength(shown);
      for (let i = 0; i < sats.length; i++)
        for (let j = i + 1; j < sats.length; j++)
          expect(
            Math.hypot(sats[i].x - sats[j].x, sats[i].y - sats[j].y),
            `n=${n} ${i}/${j}`,
          ).toBeGreaterThanOrEqual(sats[i].r + sats[j].r);
    }
  });

  it("keep every lollipop row apart, its stick before its count, its label before its stick", () => {
    const { rows, x0, pitch } = lollipops([28, 23, 18, 13], BOX);
    expect(pitch).toBeGreaterThanOrEqual(40);
    rows.forEach((r, i) => {
      if (i) expect(r.y - rows[i - 1].y).toBeCloseTo(pitch, 6);
      expect(x0 + r.len + 150).toBeLessThanOrEqual(BOX.w + 1e-9);
      expect(r.label).toBeLessThanOrEqual(x0);
    });
  });

  it("split donut sectors into exactly one turn", () => {
    for (const v of [[1], [3, 2, 1], [5, 4, 3, 2, 1, 1, 1], [38, 33, 28, 1]]) {
      const s = donutSectors(v);
      expect(s[0].from).toBe(0);
      expect(s[s.length - 1].to).toBeCloseTo(360, 6);
      expect(s.reduce((a, b) => a + b.share, 0)).toBeCloseTo(1, 6);
      s.forEach((k, i) => {
        if (i) expect(k.from).toBeCloseTo(s[i - 1].to, 6);
      });
    }
  });

  it("share the ring out of every token when given the whole, so a ring and its line agree", () => {
    // 40 + 8 named out of 100: the top model is 40%, and the 52 nobody named is the rest.
    const s = donutSectors([40, 8], 4, 100);
    expect(s.map((k) => Math.round(k.share * 100))).toEqual([40, 8, 52]);
    expect(s[s.length - 1].to).toBeCloseTo(360, 6);
    // A whole smaller than the named total is ignored, not negative.
    const t = donutSectors([40, 8], 4, 10);
    expect(t.map((k) => Math.round(k.share * 100))).toEqual([83, 17]);
  });

  it("lay 24 hour cells inside the width", () => {
    const { cells, cw } = hourCells(Array.from({ length: 24 }, (_, i) => i * i), 760);
    expect(cells).toHaveLength(24);
    expect(cells[0].x).toBeGreaterThanOrEqual(0);
    expect(cells[23].x + cw).toBeLessThanOrEqual(760);
    expect(cells.filter((c) => c.peak)).toHaveLength(1);
  });

  it("stack the tower from the true ratio, capped", () => {
    expect(towerBlocks(250, 100)).toMatchObject({ whole: 2, blocks: 3, capped: false, label: "2.5x" });
    expect(towerBlocks(100000, 100)).toMatchObject({ whole: TOWER_MAX, blocks: TOWER_MAX, capped: true });
  });

  it("draws exactly what the label says: 1.0x is one block, never two", () => {
    expect(towerBlocks(100, 100)).toMatchObject({ whole: 1, part: 0, blocks: 1, label: "1.0x" });
    expect(towerBlocks(100, 0)).toMatchObject({ blocks: 1 });
    // The label's number is the blocks' height: whole + part is the ratio to a tenth.
    const t = towerBlocks(137, 100);
    expect(t.label).toBe("1.4x");
    expect(t.whole + t.part).toBeCloseTo(1.37, 5);
  });

  it("rounds one way: 9.96 is not printed as 10.0x", () => {
    expect(towerBlocks(996, 100).label).toBe("10x");
    expect(towerBlocks(994, 100).label).toBe("9.9x");
    expect(towerBlocks(2500, 100).label).toBe("25x");
  });
});

describe("the trail", () => {
  it("keeps the month labels off the stones and inside the box", () => {
    const t = trailLayout("2026-01-05", 300, BOX);
    expect(t.marks.length).toBeGreaterThan(2);
    for (const m of t.marks) {
      expect(m.x - 70).toBeGreaterThanOrEqual(TRAIL_CLEAR - 1e-9);
      expect(m.ly).toBeLessThan(BOX.h + 30);
      // The label's box (about 44 wide, 24 tall, baseline at ly) against every stone (radius 13 + 4 outline).
      for (const s of t.stones) {
        const dx = Math.max(m.x - 22 - s.x, 0, s.x - (m.x + 22));
        const dy = Math.max(m.ly - 22 - s.y, 0, s.y - (m.ly + 4));
        expect(Math.hypot(dx, dy), `${m.label} vs stone`).toBeGreaterThanOrEqual(17);
      }
    }
  });
  it("keeps labels apart", () => {
    const t = trailLayout("2024-01-05", 900, BOX);
    for (let i = 1; i < t.marks.length; i++)
      expect(t.marks[i].x - t.marks[i - 1].x).toBeGreaterThanOrEqual(60);
  });
});
