import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Reads tokens.css itself, so the guarantees below hold for what actually ships.
const css = readFileSync(resolve(__dirname, "tokens.css"), "utf8");

type Vars = Record<string, string>;

function blockAfter(selector: string, from = 0): string {
  const at = css.indexOf(selector, from);
  if (at < 0) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function vars(block: string): Vars {
  const out: Vars = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    out[m[1]] = m[2].replace(/\/\*.*?\*\//g, "").trim();
  }
  return out;
}

const light = vars(blockAfter(":root,\n.theme-preview[data-theme=\"light\"]"));
const silver = vars(blockAfter(':root[data-theme="silver"]'));
const dark = vars(blockAfter(':root[data-theme="dark"]'));
const osDark = vars(blockAfter(':root:not([data-theme])', css.indexOf("@media (prefers-color-scheme: dark)")));

// ---- color math ----------------------------------------------------------------

type RGBA = [number, number, number, number];

function parse(value: string): RGBA {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(value);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3], rgb[4] === undefined ? 1 : +rgb[4]];
  throw new Error(`cannot parse color: ${value}`);
}

function over(fg: RGBA, bg: RGBA): RGBA {
  const a = fg[3];
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)).concat(1) as RGBA;
}

function lin(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: RGBA): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: RGBA, b: RGBA): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function oklchHue([r, g, b]: RGBA): number {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
}

const get = (set: Vars, name: string): RGBA => parse(set[name]);

/** A translucent color as it appears on a given surface. */
const on = (set: Vars, fg: string, bg: string): RGBA => over(get(set, fg), get(set, bg));

for (const [name, set] of [
  ["light", light],
  ["silver", silver],
  ["dark", dark],
] as const) {
  describe(`${name} theme`, () => {
    const surfaces = ["bg", "surface", "raised", "sidebar-solid"];

    it.each(surfaces)("primary text is readable on %s", (s) => {
      expect(contrast(get(set, "ink"), get(set, s))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(surfaces)("secondary text is readable on %s", (s) => {
      expect(contrast(get(set, "ink-2"), get(set, s))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(["bg", "surface", "sidebar-solid"])("accent text is readable on %s", (s) => {
      expect(contrast(get(set, "accent-text"), get(set, s))).toBeGreaterThanOrEqual(4.5);
    });

    it("accent text is readable on the selected-item wash", () => {
      for (const base of ["sidebar-solid", "bg"]) {
        const wash = on(set, "accent-tint", base);
        expect(contrast(get(set, "accent-text"), wash)).toBeGreaterThanOrEqual(4.5);
      }
    });

    it("button text is readable on the filled accent", () => {
      expect(contrast(get(set, "on-accent"), get(set, "accent-solid"))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(["danger", "success", "warning"])("%s text is readable on bg and surface", (c) => {
      expect(contrast(get(set, c), get(set, "bg"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(get(set, c), get(set, "surface"))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(["danger", "success", "warning"])("%s text is readable on its own tint", (c) => {
      const wash = on(set, `${c}-tint`, "bg");
      expect(contrast(get(set, c), wash)).toBeGreaterThanOrEqual(4.5);
    });

    it("graphics (accent, slate, switch off-state border) reach 3:1", () => {
      expect(contrast(get(set, "accent"), get(set, "bg"))).toBeGreaterThanOrEqual(3);
      expect(contrast(get(set, "slate"), get(set, "bg"))).toBeGreaterThanOrEqual(3);
      const border = on(set, "line-strong", "raised");
      expect(contrast(border, get(set, "raised"))).toBeGreaterThanOrEqual(1.3);
    });

    it.each(["chart-1", "chart-2", "chart-3", "chart-4", "bar-rest"])(
      "chart color %s reaches 3:1 on the card surface",
      (c) => {
        expect(contrast(get(set, c), get(set, "surface"))).toBeGreaterThanOrEqual(3);
      },
    );

    it("the tooltip is readable", () => {
      expect(contrast(get(set, "tip-ink"), get(set, "tip-bg"))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(["keyword", "string", "number", "comment", "name", "heading"])(
      "code color %s is readable on surface and raised",
      (c) => {
        for (const s of ["surface", "raised"]) {
          expect(contrast(get(set, `syntax-${c}`), get(set, s))).toBeGreaterThanOrEqual(4.5);
        }
      },
    );

    it("danger is clearly a different color from the terracotta accent", () => {
      const a = oklchHue(get(set, "accent"));
      const d = oklchHue(get(set, "danger"));
      const gap = Math.min(Math.abs(a - d), 360 - Math.abs(a - d));
      expect(gap).toBeGreaterThanOrEqual(25);
    });
  });
}

describe("theme blocks", () => {
  it("the OS-dark block matches the pinned-dark block exactly", () => {
    expect(osDark).toEqual(dark);
  });

  it("dark and silver override every color the light theme defines", () => {
    const colorKeys = Object.keys(light).filter((k) => /^(#|rgb)/.test(light[k]));
    for (const k of colorKeys) expect(dark, k).toHaveProperty(k);
    for (const k of colorKeys) expect(silver, k).toHaveProperty(k);
  });

  it("silver sits between light and dark", () => {
    const lum = (set: Vars, k: string) => luminance(get(set, k));
    for (const k of ["bg", "surface"]) {
      expect(lum(silver, k)).toBeLessThan(lum(light, k));
      expect(lum(silver, k)).toBeGreaterThan(lum(dark, k));
    }
  });
});
