// Poster Riot, the data side: which colour pair, layout and mood each slide gets, how a long figure
// is fitted into its column, and the timeline (a list of beats) each mood plays on the slide's one
// clock. Pure functions and tables only; the drawing is in components/wrapped.

import type { Beat } from "./wrappedClock";

// ---- colour ---------------------------------------------------------------------------------

export const PAIR_IDS = [
  "clay",
  "sand",
  "night",
  "peach",
  "mist",
  "ember",
] as const;
export type PairId = (typeof PAIR_IDS)[number];

/** The roles every pair defines in tokens.css as --pr-<pair>-<role>. */
export const PAIR_ROLES = [
  "bg",
  "fg",
  "soft",
  "acc",
  "alt",
  "dark",
  "strip-bg",
  "strip-fg",
] as const;

// ---- layout ---------------------------------------------------------------------------------

/**
 * Where the words sit; the hero takes the rest of the card.
 * bl / br: words along the bottom (left or right), hero band above.
 * tl / tr: words along the top, hero band below.
 * ml / mr: words in a column on the left or right, a tall hero beside them.
 * mid: words centred, hero band above. tilt: words turned -4 degrees, hero band above.
 */
export type Layout = "bl" | "br" | "tl" | "tr" | "ml" | "mr" | "mid" | "tilt";

/** The flipped twin of a layout: never the same one. */
export const MIRROR: Record<Layout, Layout> = {
  bl: "br",
  br: "bl",
  tl: "tr",
  tr: "tl",
  ml: "mr",
  mr: "ml",
  mid: "tilt",
  tilt: "mid",
};

/** How the motion feels: a brag number, a heavy stack, a ticking clock, one decisive pulse. */
export type Mood = "snappy" | "heavy" | "tick" | "pulse";

export interface PosterSpec {
  pair: PairId;
  layout: Layout;
  mood: Mood;
  /** A thin topo-line pattern over the field. */
  topo: boolean;
}

/** What each slide asks for. `plan` bends a layout or a pair only when a neighbour would repeat it. */
export const POSTERS: Record<string, PosterSpec> = {
  cover: { pair: "clay", layout: "mid", mood: "snappy", topo: true },
  tokens: { pair: "sand", layout: "bl", mood: "snappy", topo: false },
  novels: { pair: "night", layout: "tr", mood: "heavy", topo: false },
  first: { pair: "peach", layout: "tl", mood: "tick", topo: true },
  days: { pair: "mist", layout: "br", mood: "pulse", topo: false },
  biggest: { pair: "ember", layout: "mr", mood: "heavy", topo: false },
  long: { pair: "sand", layout: "ml", mood: "tick", topo: true },
  project: { pair: "clay", layout: "bl", mood: "heavy", topo: false },
  skill: { pair: "night", layout: "ml", mood: "heavy", topo: true },
  helper: { pair: "mist", layout: "tr", mood: "snappy", topo: false },
  crowd: { pair: "peach", layout: "mr", mood: "pulse", topo: false },
  tool: { pair: "night", layout: "br", mood: "heavy", topo: false },
  busiest: { pair: "clay", layout: "tl", mood: "pulse", topo: true },
  weekday: { pair: "sand", layout: "bl", mood: "snappy", topo: false },
  rhythm: { pair: "ember", layout: "tr", mood: "tick", topo: true },
  models: { pair: "mist", layout: "ml", mood: "snappy", topo: false },
  type: { pair: "peach", layout: "tilt", mood: "snappy", topo: false },
  card: { pair: "night", layout: "mid", mood: "snappy", topo: true },
};

/** The spec for each slide id in order, with no two neighbours sharing a layout or a colour pair. */
export function plan(ids: string[]): PosterSpec[] {
  const out: PosterSpec[] = [];
  for (const id of ids) {
    const want = POSTERS[id] ?? POSTERS.tokens;
    const prev = out[out.length - 1];
    let layout = want.layout;
    let pair = want.pair;
    if (prev && layout === prev.layout) layout = MIRROR[layout];
    if (prev && pair === prev.pair) {
      let k = PAIR_IDS.indexOf(pair);
      do k = (k + 1) % PAIR_IDS.length;
      while (PAIR_IDS[k] === prev.pair);
      pair = PAIR_IDS[k];
    }
    out.push({ ...want, layout, pair });
  }
  return out;
}

// ---- fitting a figure into its column ---------------------------------------------------------

/** Anton's advance widths in em, estimated by class: tabular digits, caps, lower case, the rest. */
export function emWidth(text: string): number {
  let w = 0;
  for (const c of text) {
    if (c >= "0" && c <= "9") w += 0.52;
    else if (c === " ") w += 0.22;
    else if (c >= "A" && c <= "Z") w += 0.5;
    else if (c >= "a" && c <= "z") w += 0.45;
    else if (c === "." || c === "," || c === ":") w += 0.26;
    else if (c === "%") w += 0.7;
    else w += 0.4;
  }
  return w;
}

export interface FigureFit {
  lines: string[];
  /** Font size in design units (1 unit = 1 px at the 1091 x 700 reference card). */
  size: number;
}

/** Biggest figure size in design units, and the smallest a figure may shrink to before it wraps. */
export const FIG_MAX = 280;
export const FIG_MIN = 96;

/**
 * Fit a figure into `width` design units. One line at full size if it fits; otherwise it shrinks
 * down to FIG_MIN; below that it breaks in two at a space or hyphen near the middle (or the middle
 * of the word) and the longer half sets the size. Never shrinks under 56.
 */
export function fitFigure(
  text: string,
  width: number,
  max = FIG_MAX,
): FigureFit {
  const one = Math.min(max, width / Math.max(0.01, emWidth(text)));
  if (one >= FIG_MIN || text.length < 6)
    return { lines: [text], size: Math.max(56, Math.floor(one)) };
  const mid = text.length / 2;
  let cut = -1;
  for (let i = 1; i < text.length - 1; i++) {
    if (
      (text[i] === " " || text[i] === "-") &&
      (cut < 0 || Math.abs(i - mid) < Math.abs(cut - mid))
    )
      cut = i;
  }
  const sep = cut >= 0;
  if (!sep) cut = Math.ceil(mid);
  // A hyphen stays at the end of the first line; a space is dropped; with no separator the word is cut in two.
  const a = text
    .slice(0, sep && text[cut] === " " ? cut : sep ? cut + 1 : cut)
    .trim();
  const b = text.slice(sep ? cut + 1 : cut).trim();
  const longest = Math.max(emWidth(a), emWidth(b));
  return {
    lines: [a, b],
    size: Math.max(56, Math.floor(Math.min(max, width / longest))),
  };
}

// ---- timelines --------------------------------------------------------------------------------

export interface MoodTimeline {
  /** The slide's clock runs t = 0..1 over this many ms. */
  ms: number;
  beats: Beat[];
}

const at = (
  ms: number,
  a: number,
  b: number,
  id: string,
  ease: Beat["ease"],
): Beat => ({ id, start: a / ms, end: b / ms, ease });

function make(
  ms: number,
  rows: [string, number, number, Beat["ease"]][],
): MoodTimeline {
  return { ms, beats: rows.map(([id, a, b, ease]) => at(ms, a, b, id, ease)) };
}

/**
 * One timeline per mood: the beats every slide of that mood plays. `fig` is the big figure's move,
 * `count` its digits counting (landing just before the hero settles), `hero` the graphic (it
 * staggers its own pieces inside this window), `strip` and `line` the words that follow.
 */
export const TIMELINES: Record<Mood, MoodTimeline> = {
  /** A brag number: slams in on a spring. */
  snappy: make(2600, [
    ["kicker", 0, 320, "outCubic"],
    ["fig", 60, 700, "spring"],
    ["count", 60, 960, "outCubic"],
    ["hero", 220, 1700, "spring"],
    ["hand", 220, 1500, "outQuart"],
    ["strip", 640, 980, "outCubic"],
    ["line", 820, 1160, "outCubic"],
  ]),
  /** A stack: drops from above and settles, with a squash on the floor. */
  heavy: make(2700, [
    ["kicker", 0, 320, "outCubic"],
    ["fig", 80, 640, "inQuad"],
    ["squash", 640, 900, "pulse"],
    ["count", 80, 980, "outCubic"],
    ["hero", 200, 1900, "inQuad"],
    ["hand", 200, 1900, "outQuart"],
    ["strip", 760, 1100, "outCubic"],
    ["line", 900, 1240, "outCubic"],
  ]),
  /** Time: everything steps, like a clock. */
  tick: make(3000, [
    ["kicker", 0, 320, "outCubic"],
    ["fig", 60, 700, "outCubic"],
    ["count", 60, 1000, "steps12"],
    ["hero", 200, 2200, "outCubic"],
    ["hand", 200, 2200, "steps24"],
    ["strip", 900, 1240, "outCubic"],
    ["line", 1060, 1400, "outCubic"],
  ]),
  /** A streak or a peak: lands, then one decisive pulse. It does not repeat. */
  pulse: make(2600, [
    ["kicker", 0, 320, "outCubic"],
    ["fig", 60, 620, "outBack"],
    ["pulse", 760, 1160, "pulse"],
    ["count", 60, 960, "outCubic"],
    ["hero", 200, 1500, "outCubic"],
    ["hand", 200, 1500, "outQuart"],
    ["strip", 660, 1000, "outCubic"],
    ["line", 840, 1180, "outCubic"],
  ]),
};

/**
 * ms the wipe between two cards takes, and how long a new card waits before its clock starts. The
 * clock starts with the wipe (under the block, which covers the card for the first half), so the
 * words are already arriving when the block uncovers them: no empty card in between.
 */
export const WIPE_MS = 560;
export const WIPE_LEAD = 0;

// ---- the frame and where everything sits -------------------------------------------------------

/** Every poster is laid out on this frame (design units); the card scales it to fit and the field fills what is left. */
export const FRAME_W = 1091;
export const FRAME_H = 700;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PosterBoxes {
  /** The hero graphic's box. It may bleed past the frame; nothing else does. */
  hero: Box;
  /** Kicker, unit and the big figure, one stack. */
  main: Box;
  /** The sentence. */
  line: Box;
  /** The comparison, on a solid strip. It runs off the edge it touches. */
  strip: Box;
  /** The strip's text starts this far in from the strip's left edge. */
  stripPad: number;
  /** Which end of `main` the words hug, and the text alignment. */
  anchor: "start" | "end";
  align: "left" | "right" | "center";
  /** `main` is turned by this many degrees about its centre. */
  tilt: number;
  /** Which edge the hero bleeds toward, and whether it sits above the words. */
  side: "l" | "r";
  top: boolean;
  /** The shape the hero is drawn for. */
  shape: "band" | "wide" | "tall";
}

const mirrorX = (b: Box): Box => ({ ...b, x: FRAME_W - b.x - b.w });
const mirrorY = (b: Box): Box => ({ ...b, y: FRAME_H - b.y - b.h });

const BL: PosterBoxes = {
  hero: { x: 300, y: -30, w: 840, h: 380 },
  main: { x: 40, y: 350, w: 620, h: 280 },
  line: { x: 690, y: 400, w: 353, h: 200 },
  strip: { x: -60, y: 640, w: FRAME_W + 120, h: 60 },
  stripPad: 108,
  anchor: "end",
  align: "left",
  tilt: 0,
  side: "r",
  top: true,
  shape: "band",
};

const ML: PosterBoxes = {
  hero: { x: 520, y: -30, w: 640, h: 760 },
  main: { x: 40, y: 40, w: 460, h: 380 },
  line: { x: 48, y: 440, w: 420, h: 150 },
  strip: { x: -60, y: 612, w: 580, h: 88 },
  stripPad: 108,
  anchor: "start",
  align: "left",
  tilt: 0,
  side: "r",
  top: true,
  shape: "tall",
};

const MID: PosterBoxes = {
  hero: { x: -60, y: -40, w: 1211, h: 300 },
  main: { x: 95, y: 262, w: 900, h: 286 },
  line: { x: 195, y: 554, w: 700, h: 80 },
  strip: { x: -60, y: 640, w: FRAME_W + 120, h: 60 },
  stripPad: 108,
  anchor: "start",
  align: "center",
  tilt: 0,
  side: "r",
  top: true,
  shape: "wide",
};

const TILT: PosterBoxes = {
  hero: { x: -60, y: -40, w: 1211, h: 228 },
  main: { x: 70, y: 232, w: 950, h: 290 },
  line: { x: 195, y: 562, w: 700, h: 72 },
  strip: { x: -60, y: 640, w: FRAME_W + 120, h: 60 },
  stripPad: 108,
  anchor: "start",
  align: "left",
  tilt: -4,
  side: "r",
  top: true,
  shape: "wide",
};

const flipX = (p: PosterBoxes): PosterBoxes => ({
  ...p,
  hero: mirrorX(p.hero),
  main: mirrorX(p.main),
  line: mirrorX(p.line),
  strip: mirrorX(p.strip),
  align: p.align === "left" ? "right" : p.align === "right" ? "left" : p.align,
  side: p.side === "r" ? "l" : "r",
});
const flipY = (p: PosterBoxes): PosterBoxes => ({
  ...p,
  hero: mirrorY(p.hero),
  main: mirrorY(p.main),
  line: mirrorY(p.line),
  strip: mirrorY(p.strip),
  anchor: p.anchor === "end" ? "start" : "end",
  top: !p.top,
});

/** The boxes for each layout: three drawn by hand, the rest are their mirrors. */
export const BOXES: Record<Layout, PosterBoxes> = {
  bl: BL,
  br: flipX(BL),
  tl: flipY(BL),
  tr: flipX(flipY(BL)),
  ml: ML,
  mr: flipX(ML),
  mid: MID,
  tilt: TILT,
};

/** The box a turned `main` really covers: its corners after the turn. */
export function turnedBox(b: Box, deg: number): Box {
  if (deg === 0) return b;
  const r = (deg * Math.PI) / 180;
  const w = Math.abs(b.w * Math.cos(r)) + Math.abs(b.h * Math.sin(r));
  const h = Math.abs(b.w * Math.sin(r)) + Math.abs(b.h * Math.cos(r));
  return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
}

export const boxesOverlap = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The kicker row above the figure: one line, or two where the column is narrow. */
export const HEAD_ROW = 48;
export const HEAD_TALL = 96;

/** How tall a line of the figure is, as a share of its font size (Anton set tight). */
export const FIG_LINE = 0.9;

/**
 * Keep a number with its unit: "3 days" is one word to the line breaker, so a sentence never ends a
 * line on a lone "3". (A no-break space; written as an escape because the source stays ASCII.)
 */
export function glueUnits(text: string): string {
  return text.replace(/(\d[\d.,]*[kMBx%]?) (?=[A-Za-z(])/g, "$1\u00A0");
}

/**
 * Fit the figure into the room `main` leaves it: width first (fitFigure), then the height it has
 * once the kicker row is taken off. Returns the lines and the size in design units.
 */
export function fitMain(
  text: string,
  main: Box,
  headH = main.w < 500 ? HEAD_TALL : HEAD_ROW,
): FigureFit {
  const fit = fitFigure(text, main.w, FIG_MAX);
  const room = main.h - headH;
  const need = fit.size * FIG_LINE * fit.lines.length;
  if (need <= room) return fit;
  return {
    lines: fit.lines,
    size: Math.max(56, Math.floor(room / (FIG_LINE * fit.lines.length))),
  };
}
