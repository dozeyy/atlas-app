import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BOXES, boxesOverlap, emWidth, fitFigure, fitMain, FIG_LINE, FIG_MIN, FRAME_H, FRAME_W, MIRROR, PAIR_IDS, PAIR_ROLES, plan, POSTERS, TIMELINES, turnedBox } from "./wrappedPoster";
import type { Layout, PairId } from "./wrappedPoster";

const css = readFileSync(resolve(__dirname, "../styles/tokens.css"), "utf8").replace(/\r\n/g, "\n");

function color(pair: string, role: string): [number, number, number] {
  const m = new RegExp(`--pr-${pair}-${role}:\\s*#([0-9a-f]{6})`, "i").exec(css);
  if (!m) throw new Error(`token --pr-${pair}-${role} is missing`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const lin = (c: number) => ((c / 255) <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]: [number, number, number]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
function ratio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const c = (p: PairId, role: string) => color(p, role);

describe("the poster colour pairs", () => {
  it("define every role in tokens.css", () => {
    for (const p of PAIR_IDS) for (const role of PAIR_ROLES) expect(() => color(p, role), `${p} ${role}`).not.toThrow();
  });
  it("pass 4.5:1 for every text on its background, in every pair", () => {
    for (const p of PAIR_IDS) {
      const pairs: [string, [number, number, number], [number, number, number]][] = [
        ["fg on bg", c(p, "fg"), c(p, "bg")],
        ["soft on bg", c(p, "soft"), c(p, "bg")],
        ["strip-fg on strip-bg", c(p, "strip-fg"), c(p, "strip-bg")],
        // Labels set on a hero fill.
        ["on-acc on acc", c(p, "on-acc"), c(p, "acc")],
        ["on-alt on alt", c(p, "on-alt"), c(p, "alt")],
      ];
      for (const [name, a, b] of pairs) expect(ratio(a, b), `${p}: ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("keep fg and soft text readable on the field's own tint and ghost shapes, in every pair", () => {
    // The tint (9%) and ghost (16%) are the pair's dark mixed into its bg, exactly as poster.css does it.
    const mix = (a: [number, number, number], b: [number, number, number], k: number): [number, number, number] => [0, 1, 2].map((i) => Math.round(a[i] * k + b[i] * (1 - k))) as [number, number, number];
    for (const p of PAIR_IDS) {
      const tint = mix(c(p, "dark"), c(p, "bg"), 0.09);
      const ghost = mix(c(p, "dark"), c(p, "bg"), 0.16);
      expect(ratio(c(p, "fg"), tint), `${p}: fg on tint`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(c(p, "soft"), tint), `${p}: soft on tint`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(c(p, "fg"), ghost), `${p}: fg on ghost`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("keep the hero fills visible against the field (acc 3:1, alt 2:1; the 8px outline does the rest)", () => {
    for (const p of PAIR_IDS) {
      expect(ratio(c(p, "acc"), c(p, "bg")), `${p} acc`).toBeGreaterThanOrEqual(3);
      expect(ratio(c(p, "alt"), c(p, "bg")), `${p} alt`).toBeGreaterThanOrEqual(2);
    }
  });
  it("are the same in every theme (the tokens sit in the theme-free block)", () => {
    const free = css.slice(css.indexOf("/* ---- Not theme-dependent"));
    for (const p of PAIR_IDS) expect(free).toContain(`--pr-${p}-bg:`);
  });
});

describe("plan: layouts, pairs and moods", () => {
  const all = Object.keys(POSTERS);
  it("gives every slide a pair, a layout and a mood", () => {
    for (const id of all) {
      const s = POSTERS[id];
      expect(PAIR_IDS).toContain(s.pair);
      expect(Object.keys(MIRROR)).toContain(s.layout);
      expect(["snappy", "heavy", "tick", "pulse"]).toContain(s.mood);
    }
  });
  it("never repeats a layout or a pair between neighbours, for the full story and for any subset", () => {
    const check = (ids: string[]) => {
      const p = plan(ids);
      for (let i = 1; i < p.length; i++) {
        expect(p[i].layout, `${ids[i - 1]} -> ${ids[i]} layout`).not.toBe(p[i - 1].layout);
        expect(p[i].pair, `${ids[i - 1]} -> ${ids[i]} pair`).not.toBe(p[i - 1].pair);
      }
    };
    check(all);
    // Every pair of slides that can end up next to each other when slides are missing.
    for (const a of all) for (const b of all) if (a !== b) check([a, b]);
    check(all.filter((_, i) => i % 2 === 0));
    check(all.filter((_, i) => i % 3 !== 1));
  });
  it("mirrors to a different layout and back", () => {
    for (const l of Object.keys(MIRROR) as Layout[]) {
      expect(MIRROR[l]).not.toBe(l);
      expect(MIRROR[MIRROR[l]]).toBe(l);
    }
  });
  it("uses all four moods across the story", () => {
    expect(new Set(all.map((id) => POSTERS[id].mood)).size).toBe(4);
  });
  it("uses at least four of the six pairs", () => {
    expect(new Set(all.map((id) => POSTERS[id].pair)).size).toBeGreaterThanOrEqual(4);
  });
});

describe("fitFigure", () => {
  it("keeps a short number at full size on one line", () => {
    const f = fitFigure("851M", 600);
    expect(f.lines).toEqual(["851M"]);
    expect(f.size).toBe(280);
  });
  it("shrinks a longer one to fit its column", () => {
    const f = fitFigure("10 d 15 h", 600);
    expect(f.lines).toHaveLength(1);
    expect(f.size * emWidth("10 d 15 h")).toBeLessThanOrEqual(600);
    expect(f.size).toBeGreaterThanOrEqual(FIG_MIN);
  });
  it("breaks a long name in two at a hyphen or space, and still fits", () => {
    for (const name of ["frontend-design", "claude-code-guide", "A very long project name"]) {
      const f = fitFigure(name, 560);
      expect(f.lines.length, name).toBe(2);
      expect(f.lines.join("").replace(/[ -]/g, "")).toBe(name.replace(/[ -]/g, ""));
      for (const l of f.lines) expect(l.length > 0 && f.size * emWidth(l) <= 561, `${name} / ${l}`).toBe(true);
    }
  });
  it("cuts a long single word in two without losing a letter", () => {
    const f = fitFigure("Supercalifragilistic", 560);
    expect(f.lines).toHaveLength(2);
    expect(f.lines.join("")).toBe("Supercalifragilistic");
  });
  it("never goes below 56", () => {
    expect(fitFigure("x".repeat(60), 300).size).toBeGreaterThanOrEqual(56);
  });
});

describe("the timelines", () => {
  it("are valid: every beat inside 0..1 and ordered, with the ids the poster reads", () => {
    for (const [mood, tl] of Object.entries(TIMELINES)) {
      expect(tl.ms).toBeGreaterThan(1500);
      const ids = tl.beats.map((b) => b.id);
      for (const need of ["kicker", "fig", "count", "hero", "strip", "line"]) expect(ids, `${mood} ${need}`).toContain(need);
      for (const b of tl.beats) {
        expect(b.start, `${mood} ${b.id}`).toBeGreaterThanOrEqual(0);
        expect(b.end, `${mood} ${b.id}`).toBeLessThanOrEqual(1);
        expect(b.end).toBeGreaterThanOrEqual(b.start);
      }
    }
  });
  it("land the count just before the hero settles", () => {
    for (const [mood, tl] of Object.entries(TIMELINES)) {
      const count = tl.beats.find((b) => b.id === "count")!;
      const hero = tl.beats.find((b) => b.id === "hero")!;
      expect(count.end, mood).toBeLessThan(hero.end);
      // Ease-out cubic of about 900 ms.
      const ms = (count.end - count.start) * tl.ms;
      expect(ms, mood).toBeGreaterThanOrEqual(880);
      expect(ms, mood).toBeLessThanOrEqual(1010);
    }
  });
});

describe("the layouts", () => {
  const layouts = Object.keys(BOXES) as Layout[];
  it("keep the words inside the frame, with the hero as the only thing that may bleed", () => {
    for (const l of layouts) {
      const b = BOXES[l];
      for (const [name, box] of [["main", turnedBox(b.main, b.tilt)], ["line", b.line]] as const) {
        expect(box.x, `${l} ${name} x`).toBeGreaterThanOrEqual(0);
        expect(box.y, `${l} ${name} y`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.w, `${l} ${name} right`).toBeLessThanOrEqual(FRAME_W);
        expect(box.y + box.h, `${l} ${name} bottom`).toBeLessThanOrEqual(FRAME_H);
      }
    }
  });
  it("never let the hero, the words, the sentence and the strip touch each other", () => {
    for (const l of layouts) {
      const b = BOXES[l];
      const named: [string, ReturnType<typeof turnedBox>][] = [["hero", b.hero], ["main", turnedBox(b.main, b.tilt)], ["line", b.line], ["strip", b.strip]];
      for (let i = 0; i < named.length; i++)
        for (let j = i + 1; j < named.length; j++) expect(boxesOverlap(named[i][1], named[j][1]), `${l}: ${named[i][0]} vs ${named[j][0]}`).toBe(false);
    }
  });
  it("mirror to each other: the same boxes, flipped, so a mirrored layout is as clean as the original", () => {
    expect(BOXES.br.main.x).toBe(FRAME_W - BOXES.bl.main.x - BOXES.bl.main.w);
    expect(BOXES.tl.main.y).toBe(FRAME_H - BOXES.bl.main.y - BOXES.bl.main.h);
    expect(BOXES.mr.align).toBe("right");
    expect(BOXES.tr.top).toBe(false);
    expect(BOXES.br.side).toBe("l");
  });
  it("turn only the tilted layout, and by -4 degrees", () => {
    for (const l of layouts) expect(BOXES[l].tilt, l).toBe(l === "tilt" ? -4 : 0);
  });
  it("fit a figure in the room the words leave it", () => {
    for (const l of layouts) {
      const b = BOXES[l];
      for (const text of ["851M", "10 d 15 h", "frontend-design", "Wednesday", "A very long project name"]) {
        const f = fitMain(text, b.main);
        const head = b.main.w < 500 ? 96 : 48;
        expect(f.size * FIG_LINE * f.lines.length, `${l} ${text}`).toBeLessThanOrEqual(b.main.h - head + 1);
        for (const line of f.lines) expect(f.size * emWidth(line), `${l} ${text} / ${line}`).toBeLessThanOrEqual(b.main.w + 1);
      }
    }
  });
});