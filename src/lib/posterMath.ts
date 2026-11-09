// Poster Riot, the geometry of the hero graphics. Pure functions of the data and the hero's box
// (design units), so the layouts can be tested: nothing overlaps, nothing leaves its box, labels
// stay clear of the shapes they name. The drawing is in components/wrapped/heroes.

import { FRAME_H, FRAME_W } from "./wrappedPoster";
import type { Box, PosterBoxes } from "./wrappedPoster";

/** The one stroke: slate, this thick, wherever an outline is used. */
export const OUT = 8;

/**
 * What a hero may use of its box. `w` and `h` are the room its data has; it draws at 0..w across,
 * and the svg shifts that by `ox`, so data never leaves the frame while a decorative shape can still
 * run off the edge (coordinates beyond 0..w are the bleed).
 */
export interface HeroBox {
  w: number;
  h: number;
  /** How far in from the hero box's left edge the data starts, and the box's full width. */
  ox: number;
  fullW: number;
  /** y of the ground line (bars stand on it). */
  floor: number;
  /** y of the highest point the data may reach. */
  ceil: number;
  /** "l" or "r": the edge the big decorative shape bleeds off. */
  side: "l" | "r";
}

const SAFE_X = 24;
const SAFE_Y = 12;
const GAP = 26;

/** The room a layout's hero has: its data keeps inside the frame, the ground sits against the words or the edge. */
export function heroBoxFor(p: PosterBoxes): HeroBox {
  const hb = p.hero;
  const x0 = Math.max(hb.x, SAFE_X);
  const x1 = Math.min(hb.x + hb.w, FRAME_W - SAFE_X);
  const tall = p.shape === "tall";
  // A hero above the words stands on the line the words start at; one below them stands on the card's bottom edge.
  const ceil = tall || p.top ? SAFE_Y - hb.y : GAP;
  const floor = tall || !p.top ? FRAME_H - SAFE_Y - hb.y : hb.h - GAP;
  return {
    w: x1 - x0,
    h: hb.h,
    ox: x0 - hb.x,
    fullW: hb.w,
    floor,
    ceil,
    side: p.side,
  };
}
/** The fills a set of things takes in turn, with the ink that reads on each (token names, no hashes). */
export const SWATCH = [
  { fill: "acc", ink: "on-acc" },
  { fill: "alt", ink: "on-alt" },
  { fill: "fg", ink: "bg" },
  { fill: "sbg", ink: "sfg" },
  { fill: "soft", ink: "bg" },
] as const;

export type Swatch = (typeof SWATCH)[number];

/** `n` characters of text at most, ending in "..." where it was cut. ASCII only. */
export function clipText(text: string, max: number): string {
  if (max < 1) return "";
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 3).trimEnd()}...`;
}

/** A rectangle with its four corners cut by `c`: the one shape the posters share. */
export function chamfer(
  x: number,
  y: number,
  w: number,
  h: number,
  c: number,
): string {
  const k = Math.max(0, Math.min(c, w / 2.2, h / 2.2));
  const f = (n: number) => +n.toFixed(2);
  return `M${f(x + k)} ${f(y)}H${f(x + w - k)}L${f(x + w)} ${f(y + k)}V${f(y + h - k)}L${f(x + w - k)} ${f(y + h)}H${f(x + k)}L${f(x)} ${f(y + h - k)}V${f(y + k)}Z`;
}

/** Sum `values` into `n` equal runs of days (fewer if there are fewer days). */
export function binValues(values: number[], n: number): number[] {
  const k = Math.max(1, Math.min(n, values.length));
  const out = new Array<number>(k).fill(0);
  values.forEach((v, i) => {
    out[Math.min(k - 1, Math.floor((i * k) / values.length))] += Math.max(0, v);
  });
  return out;
}

// ---- tokens: a skyline of bars -----------------------------------------------------------------

export interface Bar {
  x: number;
  y: number;
  w: number;
  h: number;
  peak: boolean;
}

/** The history as chunky bars standing on the floor; the biggest run of days is the peak. */
export function skyline(values: number[], b: HeroBox, n = 16): Bar[] {
  const bins = binValues(values, n);
  const gap = 10;
  const pad = 24;
  const w = (b.w - pad * 2 - gap * (bins.length - 1)) / bins.length;
  const max = Math.max(...bins, 1);
  const top = bins.indexOf(Math.max(...bins));
  return bins.map((v, i) => {
    const h = Math.max(18, (v / max) * (b.floor - b.ceil));
    return { x: pad + i * (w + gap), y: b.floor - h, w, h, peak: i === top };
  });
}

// ---- first chat: a trail ------------------------------------------------------------------------

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function monthMarks(
  from: string,
  days: number,
): { at: number; label: string }[] {
  const [y, m, d] = from.split("-").map(Number);
  const out: { at: number; label: string }[] = [];
  const start = new Date(y, m - 1, d, 12).getTime();
  for (let k = 1; k <= 60; k++) {
    const t = new Date(y, m - 1 + k, 1, 12);
    const at = Math.round((t.getTime() - start) / 86_400_000);
    if (at >= days) break;
    out.push({ at, label: MONTHS[t.getMonth()] });
  }
  return out;
}

/** Room a month label needs on each side: a mark closer than this to either end is skipped. */
export const TRAIL_CLEAR = 70;
/** Closest two month labels may sit along the trail. */
export const MARK_GAP = 60;

export interface Trail {
  stones: { x: number; y: number; a: number }[];
  marks: { x: number; y: number; ly: number; label: string }[];
  start: [number, number];
  end: [number, number];
}

/** A winding trail from the oldest chat (left) to today (right), stones along it, a mark per month passed. */
export function trailLayout(
  from: string,
  days: number,
  b: HeroBox,
  stones = 26,
): Trail {
  const pad = 70;
  const span = b.w - pad * 2;
  const mid = (b.floor + b.ceil) / 2 + 10;
  const amp = Math.min(70, (b.floor - b.ceil) * 0.28);
  const yAt = (x: number) =>
    mid + Math.sin((x / b.w) * Math.PI * 3) * amp - (x / b.w) * 26;
  const pts = Array.from({ length: stones }, (_, i) => {
    const x = pad + (i / (stones - 1)) * span;
    const dy = yAt(x + 1) - yAt(x - 1);
    return { x, y: yAt(x), a: (Math.atan2(dy, 2) * 180) / Math.PI };
  });
  const marks = monthMarks(from, days)
    .map((m) => {
      const x = pad + (m.at / Math.max(1, days)) * span;
      // The label hangs below the trail, lower where the trail is steep so the stones beside it stay clear.
      const slope = Math.abs(yAt(x + 1) - yAt(x - 1)) / 2;
      return { x, y: yAt(x), ly: yAt(x) + 50 + slope * 36, label: m.label };
    })
    .filter((m) => m.x - pad >= TRAIL_CLEAR && b.w - pad - m.x >= TRAIL_CLEAR);
  // Keep the labels apart: a long history has more months than the trail has room for.
  const kept: typeof marks = [];
  for (const m of marks)
    if (kept.length === 0 || m.x - kept[kept.length - 1].x >= MARK_GAP)
      kept.push(m);
  return {
    stones: pts,
    marks: kept,
    start: [pad, yAt(pad)],
    end: [b.w - pad, yAt(b.w - pad)],
  };
}

// ---- days: the calendar -------------------------------------------------------------------------

/** Heat band 0..5 for a day, by its place among the active days (cuts at 20, 45, 70 and 90 percent). */
export function heatBand(v: number, sortedActive: number[]): number {
  if (v <= 0 || sortedActive.length === 0) return 0;
  let below = 0;
  for (const a of sortedActive) if (a < v) below++;
  const q = below / sortedActive.length;
  return q < 0.2 ? 1 : q < 0.45 ? 2 : q < 0.7 ? 3 : q < 0.9 ? 4 : 5;
}

export interface HeatCell {
  i: number;
  col: number;
  row: number;
  x: number;
  y: number;
  band: number;
  run: boolean;
}

/** The calendar as columns of weeks (Monday on top), standing on the floor. */
export function heatLayout(
  values: number[],
  start: number,
  weeks: number,
  run: [number, number] | null,
  b: HeroBox,
): { cells: HeatCell[]; size: number; pitch: number } {
  const pad = 24;
  const pitch = Math.min(
    (b.w - pad * 2) / Math.max(1, weeks),
    (b.floor - b.ceil) / 7,
  );
  const size = pitch - 6;
  const x0 = b.side === "r" ? b.w - pad - weeks * pitch : pad;
  const y0 = b.floor - 7 * pitch;
  const active = values.filter((v) => v > 0).sort((p, q) => p - q);
  const cells = values.map((v, i) => {
    const col = Math.floor((start + i) / 7);
    const row = (start + i) % 7;
    return {
      i,
      col,
      row,
      x: x0 + col * pitch + 3,
      y: y0 + row * pitch + 3,
      band: heatBand(v, active),
      run: !!run && i >= run[0] && i <= run[1],
    };
  });
  return { cells, size, pitch };
}

// ---- biggest chat: a tower -------------------------------------------------------------------------

export const TOWER_MAX = 14;

/** The biggest chat as a stack of "average chats": how many blocks, and whether it was capped. */
export function towerBlocks(
  value: number,
  avg: number,
): { blocks: number; ratio: number; capped: boolean } {
  const ratio = avg > 0 ? value / avg : 1;
  return {
    blocks: Math.max(2, Math.min(TOWER_MAX, Math.round(ratio))),
    ratio,
    capped: ratio > TOWER_MAX,
  };
}

// ---- longest sitting: a dial --------------------------------------------------------------------------

export interface DialModel {
  laps: number;
  rest: number;
  fills: number[];
  turns: number;
  end: number;
}

export function dialModel(hours: number): DialModel {
  const laps = Math.floor(hours / 12);
  const rest = (hours % 12) / 12;
  const rings = Math.min(4, laps + (rest > 0 ? 1 : 0));
  const fills = Array.from({ length: rings }, (_, k) => (k < laps ? 1 : rest));
  const turns = fills.reduce((s, f) => s + f, 0);
  return { laps, rest, fills, turns, end: (turns * 360) % 360 };
}

/**
 * One frame of the dial from its eased progress p: the hand and every ring are read from the same
 * p, so the arc a ring has drawn is always the turn the hand has made. `offsets` are the rings'
 * stroke-dashoffsets as a share of a full lap (0 = fully drawn).
 */
export function dialFrame(
  m: DialModel,
  p: number,
): { hand: number; offsets: number[] } {
  const travelled = p * m.turns;
  return {
    hand: travelled * 360,
    offsets: m.fills.map((f, k) => f - Math.min(f, Math.max(0, travelled - k))),
  };
}

// ---- project: tiles ------------------------------------------------------------------------------------

/** Slice a box into tiles sized by value: split the list where the halves weigh most alike, across the longer side. */
export function tileBoxes(
  values: number[],
  box: Box = { x: 0, y: 0, w: 100, h: 100 },
): Box[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [box];
  const total = values.reduce((a, b) => a + b, 0) || 1;
  let k = 1;
  let best = Infinity;
  let left = 0;
  for (let i = 0; i < values.length - 1; i++) {
    left += values[i];
    const gap = Math.abs(left - total / 2);
    if (gap < best) {
      best = gap;
      k = i + 1;
    }
  }
  const a = values.slice(0, k);
  const b = values.slice(k);
  const share = a.reduce((x, y) => x + y, 0) / total;
  return box.w >= box.h
    ? [
        ...tileBoxes(a, { ...box, w: box.w * share }),
        ...tileBoxes(b, {
          x: box.x + box.w * share,
          y: box.y,
          w: box.w * (1 - share),
          h: box.h,
        }),
      ]
    : [
        ...tileBoxes(a, { ...box, h: box.h * share }),
        ...tileBoxes(b, {
          x: box.x,
          y: box.y + box.h * share,
          w: box.w,
          h: box.h * (1 - share),
        }),
      ];
}

/** Whether a tile is big enough to hold a label of `chars` characters at `px` design units. */
export function tileFits(t: Box, chars: number, px: number): boolean {
  return t.w >= chars * px * 0.62 + 28 && t.h >= px + 30;
}

// ---- skill: a podium ---------------------------------------------------------------------------------------

export interface PodiumBar {
  rank: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** How many characters of the name fit along the bar. */
  chars: number;
}

/** Ranks counted down left to right (five first, one last, tallest). Heights follow the counts. */
export function podiumLayout(values: number[], b: HeroBox): PodiumBar[] {
  const n = values.length;
  const pad = 18;
  const gap = 12;
  const w = (b.w - pad * 2 - gap * (n - 1)) / n;
  const max = Math.max(...values, 1);
  const room = b.floor - b.ceil - 96;
  return values
    .map((v, i) => {
      const h = Math.max(room * 0.3, (v / max) * room);
      return {
        rank: i + 1,
        w,
        h,
        // The label is 22 px mono with 0.05em tracking: 14.3 design units a character, with the bar's own padding off both ends.
        chars: Math.max(0, Math.floor((h - 48) / 14.6)),
      };
    })
    .reverse()
    .map((p, k) => ({ ...p, x: pad + k * (w + gap), y: b.floor - p.h }));
}

// ---- helper: lollipops ----------------------------------------------------------------------------------------

export interface Lolly {
  y: number;
  len: number;
  label: number;
}

/** Rows of a stick and a head; the stick's length follows the count. */
export function lollipops(
  values: number[],
  b: HeroBox,
  labelW = 230,
  tail = 150,
): { rows: Lolly[]; x0: number; pitch: number } {
  const n = values.length;
  const pitch = Math.min(70, (b.floor - b.ceil) / n);
  const max = Math.max(...values, 1);
  const longest = b.w - labelW - tail;
  const rows = values.map((v, i) => ({
    y: b.ceil + i * pitch + pitch / 2,
    len: Math.max(longest * 0.16, (v / max) * longest),
    label: labelW,
  }));
  return { rows, x0: labelW, pitch };
}

// ---- crowd: a burst ---------------------------------------------------------------------------------------------

export const BURST_MAX = 26;

export interface Satellite {
  x: number;
  y: number;
  r: number;
  ring: number;
}

/** A chat in the middle, its helpers on two rings round it. At most BURST_MAX are drawn. */
export function burstLayout(
  count: number,
  cx: number,
  cy: number,
  r1: number,
  r2: number,
): { shown: number; sats: Satellite[] } {
  const shown = Math.max(1, Math.min(BURST_MAX, count));
  const inner = shown <= 10 ? shown : Math.ceil(shown * 0.4);
  // A few helpers get bigger dots so a small crowd still fills the poster.
  const rIn = shown <= 6 ? 40 : shown <= 10 ? 32 : 26;
  const outer = shown - inner;
  const sats: Satellite[] = [];
  for (let i = 0; i < inner; i++) {
    const a = (i / inner) * Math.PI * 2 - Math.PI / 2;
    sats.push({
      x: cx + Math.cos(a) * r1,
      y: cy + Math.sin(a) * r1,
      r: rIn,
      ring: 0,
    });
  }
  for (let i = 0; i < outer; i++) {
    const a = ((i + 0.5) / outer) * Math.PI * 2 - Math.PI / 2;
    sats.push({
      x: cx + Math.cos(a) * r2,
      y: cy + Math.sin(a) * r2,
      r: 20,
      ring: 1,
    });
  }
  return { shown, sats };
}

// ---- tool: command bars ---------------------------------------------------------------------------------------------

export interface CmdBar {
  y: number;
  h: number;
  len: number;
  /** Characters of the name that fit after the prompt and before the count. */
  chars: number;
}

/** Stacked command lines; each bar's length follows its count (never under 40% of the longest). */
export function commandBars(
  values: number[],
  b: HeroBox,
  charW = 14,
): { bars: CmdBar[]; cap: number } {
  const n = values.length;
  const gap = 12;
  const h = Math.min(66, (b.floor - b.ceil - gap * (n - 1)) / n);
  const max = Math.max(...values, 1);
  const cap = b.w - 40;
  const bars = values.map((v, i) => {
    const len = cap * (0.4 + 0.6 * (v / max));
    return {
      y: b.ceil + i * (h + gap),
      h,
      len,
      chars: Math.max(3, Math.floor((len - 40 - 28 - 100) / charW)),
    };
  });
  return { bars, cap };
}

// ---- busiest day: spikes ---------------------------------------------------------------------------------------------

export interface Spike {
  x: number;
  w: number;
  h: number;
  peak: boolean;
}

/** One pointed spike per day, the peak day towering over the rest. */
export function spikeLayout(
  values: number[],
  peak: number,
  b: HeroBox,
): Spike[] {
  const n = values.length;
  const pad = 30;
  const w = (b.w - pad * 2) / n;
  const max = Math.max(...values, 1);
  const room = b.floor - b.ceil;
  return values.map((v, i) => ({
    x: pad + i * w,
    w,
    h: i === peak ? room : Math.max(18, (v / max) * room * 0.6),
    peak: i === peak,
  }));
}

// ---- weekday: the half dial ----------------------------------------------------------------------------------------------

export const FAN_START = 165;
export const FAN_STEP = 25;
/** The half dial: face radius, where the spokes start, and how far the winner reaches past the face. */
export const FAN = { R: 220, hub: 44, over: 34, label: 26, tipDeg: 8 } as const;

export interface FanSpoke {
  day: number;
  /** Degrees, 0 = pointing right, 90 = up, 180 = left. */
  angle: number;
  len: number;
  top: boolean;
  /** Corners of the wedge: two at the hub end, two at the tip. */
  poly: [number, number][];
  label: { x: number; y: number };
}

export function polar(
  cx: number,
  cy: number,
  r: number,
  deg: number,
): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + Math.cos(a) * r, cy - Math.sin(a) * r];
}

/** The seven spokes of the week fanned over the upper half, Monday on the left, the busiest reaching past the face. */
export function fanLayout(
  values: number[],
  hx: number,
  hy: number,
): FanSpoke[] {
  const max = Math.max(...values, 1);
  const top = values.indexOf(Math.max(...values));
  return values.map((v, day) => {
    const angle = FAN_START - day * FAN_STEP;
    const len =
      day === top ? FAN.R + FAN.over : FAN.R * (0.42 + 0.46 * (v / max));
    const poly: [number, number][] = [
      polar(hx, hy, FAN.hub, angle + 3),
      polar(hx, hy, len, angle + FAN.tipDeg),
      polar(hx, hy, len, angle - FAN.tipDeg),
      polar(hx, hy, FAN.hub, angle - 3),
    ];
    const reach = Math.max(len, FAN.R + FAN.over) + FAN.label;
    const [lx, ly] = polar(hx, hy, reach, angle);
    return { day, angle, len, top: day === top, poly, label: { x: lx, y: ly } };
  });
}

/** When (0..1 of the hand's sweep) the hand reaches a spoke, and where it comes to rest. */
export function fanTimeline(spokes: FanSpoke[]): {
  top: FanSpoke;
  startAngle: number;
  arrive: number[];
} {
  const top = spokes.find((s) => s.top) ?? spokes[0];
  const startAngle = 180;
  const sweep = startAngle - top.angle;
  const arrive = spokes.map((s) =>
    s.angle >= top.angle && sweep > 0 ? (startAngle - s.angle) / sweep : 1,
  );
  return { top, startAngle, arrive };
}

/** The hand's angle and every spoke's growth (0..1) at the hand's eased progress p. */
export function fanFrame(
  spokes: FanSpoke[],
  p: number,
): { hand: number; grow: number[] } {
  const { top, startAngle, arrive } = fanTimeline(spokes);
  const hand = startAngle - (startAngle - top.angle) * p;
  const lead = 0.28;
  return {
    hand,
    // A spoke starts growing `lead` before the hand reaches it (but never before the sweep starts) and is full on arrival.
    grow: arrive.map((a) => {
      const from = Math.max(0, a - lead);
      return a <= from ? (p >= a ? 1 : 0) : Math.max(0, Math.min(1, (p - from) / (a - from)));
    }),
  };
}

// ---- models: a ring ------------------------------------------------------------------------------------------------------------

export interface Sector {
  from: number;
  to: number;
  share: number;
}

/** Sectors in degrees clockwise from twelve. The rest past `max` models is one sector. */
export function donutSectors(values: number[], max = 5): Sector[] {
  const top = values.slice(0, max);
  const rest = values.slice(max).reduce((a, b) => a + b, 0);
  const all = rest > 0 ? [...top, rest] : top;
  const total = all.reduce((a, b) => a + b, 0) || 1;
  let at = 0;
  return all.map((v) => {
    const from = at;
    at += (v / total) * 360;
    return { from, to: at, share: v / total };
  });
}

/** A ring sector from degree `a0` to `a1` (clockwise from twelve) between radii r0 and r1. */
export function sectorPath(
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
): string {
  const pt = (r: number, deg: number): [number, number] => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };
  const full = a1 - a0 >= 359.99;
  const f = (n: number) => +n.toFixed(2);
  if (full) {
    const [ox, oy] = pt(r1, a0);
    const [ix, iy] = pt(r0, a0);
    return `M${f(ox)} ${f(oy)}A${r1} ${r1} 0 1 1 ${f(ox - 0.01)} ${f(oy)}ZM${f(ix)} ${f(iy)}A${r0} ${r0} 0 1 0 ${f(ix - 0.01)} ${f(iy)}Z`;
  }
  const large = a1 - a0 > 180 ? 1 : 0;
  const [x0, y0] = pt(r1, a0);
  const [x1, y1] = pt(r1, a1);
  const [x2, y2] = pt(r0, a1);
  const [x3, y3] = pt(r0, a0);
  return `M${f(x0)} ${f(y0)}A${r1} ${r1} 0 ${large} 1 ${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}A${r0} ${r0} 0 ${large} 0 ${f(x3)} ${f(y3)}Z`;
}

// ---- rhythm: the hours --------------------------------------------------------------------------------------------------------------

export interface HourCell {
  hour: number;
  x: number;
  band: number;
  peak: boolean;
}

/** 24 cells in a row, banded by how much of the day's tokens each hour holds. */
export function hourCells(
  values: number[],
  w: number,
  pad = 30,
): { cells: HourCell[]; cw: number } {
  const cw = (w - pad * 2) / 24;
  const active = values.filter((v) => v > 0).sort((a, b) => a - b);
  const top = values.indexOf(Math.max(...values));
  return {
    cw,
    cells: values.map((v, hour) => ({
      hour,
      x: pad + hour * cw,
      band: heatBand(v, active),
      peak: hour === top,
    })),
  };
}

// ---- type: the gauges -----------------------------------------------------------------------------------------------------------------

/** How full a gauge is: a score of 1 is "the bar", the track runs to twice that. */
export const gaugeFill = (score: number): number =>
  Math.max(0.04, Math.min(1, score / 2));

export const initials = (name: string): string =>
  name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

/** The four-point spark. */
export function star(cx: number, cy: number, r: number): string {
  const f = (n: number) => +n.toFixed(2);
  const q = r * 0.24;
  return `M${f(cx)} ${f(cy - r)}L${f(cx + q)} ${f(cy - q)}L${f(cx + r)} ${f(cy)}L${f(cx + q)} ${f(cy + q)}L${f(cx)} ${f(cy + r)}L${f(cx - q)} ${f(cy + q)}L${f(cx - r)} ${f(cy)}L${f(cx - q)} ${f(cy - q)}Z`;
}
