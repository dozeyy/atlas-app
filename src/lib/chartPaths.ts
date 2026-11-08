// Pure geometry and statistics for the hand-drawn charts. No React, no DOM.

export type Pt = [number, number];

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Monotone cubic path through points: smooth, and never dips below a lower neighbour. */
export function smoothPath(pts: Pt[]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${r2(pts[0][0])},${r2(pts[0][1])}`;
  const dx: number[] = [];
  const m: number[] = [];
  const t: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0] || 1e-6;
    m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
  }
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  let d = `M${r2(pts[0][0])},${r2(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${r2(pts[i][0] + h)},${r2(pts[i][1] + t[i] * h)} ${r2(pts[i + 1][0] - h)},${r2(pts[i + 1][1] - t[i + 1] * h)} ${r2(pts[i + 1][0])},${r2(pts[i + 1][1])}`;
  }
  return d;
}

/** A bar with a rounded top and a flat bottom sitting on `base`. */
export function barPath(x: number, w: number, top: number, base: number, radius: number): string {
  const h = base - top;
  const r = Math.min(radius, w / 2, h);
  if (h <= 0) return `M${r2(x)},${r2(base)}h${r2(w)}v-2h${r2(-w)}Z`;
  if (h < radius) return `M${r2(x)},${r2(base)}h${r2(w)}v${r2(-h)}h${r2(-w)}Z`;
  return `M${r2(x)},${r2(base)}V${r2(top + r)}Q${r2(x)},${r2(top)} ${r2(x + r)},${r2(top)}H${r2(x + w - r)}Q${r2(x + w)},${r2(top)} ${r2(x + w)},${r2(top + r)}V${r2(base)}Z`;
}

/** Height of the grey stub an empty bar slot shows. */
export const ZERO_STUB = 3;
/** Shortest bar a slot with any usage gets: always taller than an empty slot's stub. */
export const MIN_BAR = ZERO_STUB + 1;

/**
 * Top edge of a bar for `v` on a 0..`max` scale drawn from `base` up to `top`. Proportional,
 * except that any value above zero is lifted to at least MIN_BAR, so a day with real usage
 * never looks lower than a day with none (1.8M tokens next to a 144M peak is 1 px tall).
 */
export function barTop(v: number, max: number, base: number, top: number): number {
  if (!(v > 0) || !(max > 0)) return base;
  return Math.min(base - (Math.min(v, max) / max) * (base - top), base - MIN_BAR);
}

export interface RidgeGeometry {
  pts: Pt[];
  line: string;
  area: string;
  peak: number;
  baseline: number;
  /** Rough path length, for the draw-on animation. */
  length: number;
}

/** The weekly ridge: values left to right, the peak found, an area closed to the baseline. */
export function ridgeGeometry(values: number[], w: number, h: number, pad = 10, top = 34, bottom = 22): RidgeGeometry {
  const n = values.length;
  const max = Math.max(1, ...values);
  const x = (i: number) => (n === 1 ? w / 2 : pad + (i * (w - pad * 2)) / (n - 1));
  const y = (v: number) => top + (1 - v / max) * (h - top - bottom);
  const pts: Pt[] = values.map((v, i) => [x(i), y(v)]);
  const baseline = h - bottom;
  const line = smoothPath(pts);
  let peak = 0;
  values.forEach((v, i) => {
    if (v > values[peak]) peak = i;
  });
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const area = n ? `${line}L${r2(x(n - 1))},${r2(baseline)}L${r2(x(0))},${r2(baseline)}Z` : "";
  return { pts, line, area, peak, baseline, length: Math.ceil(length * 1.12) };
}

export interface RingGeometry {
  r: number;
  circ: number;
  /** stroke-dashoffset of the first lap. */
  offset: number;
  /** Second lap past 100 %, null when there is none. */
  offset2: number | null;
}

export function ringGeometry(size: number, stroke: number, frac: number): RingGeometry {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const f = Math.max(0, frac);
  return {
    r,
    circ,
    offset: circ * (1 - Math.min(f, 1)),
    offset2: f > 1 ? circ * (1 - Math.min(f - 1, 1)) : null,
  };
}

/** Today's tokens against a usual day: the median of the days that had any activity. */
export function usualDay(dailyTokens: number[]): number {
  const active = dailyTokens.filter((v) => v > 0).sort((a, b) => a - b);
  if (active.length === 0) return 0;
  const mid = Math.floor(active.length / 2);
  return active.length % 2 ? active[mid] : (active[mid - 1] + active[mid]) / 2;
}

/** Quantile cut points (20/45/70/90 % of the active days) that split activity into bands 1-5. */
export function heatCuts(values: number[]): number[] {
  const vals = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (vals.length === 0) return [];
  const q = (p: number) => vals[Math.floor(p * (vals.length - 1))];
  return [q(0.2), q(0.45), q(0.7), q(0.9)];
}

export function heatBand(v: number, cuts: number[]): number {
  if (v <= 0) return 0;
  return 1 + cuts.filter((c) => v > c).length;
}

/**
 * Consecutive active days ending today; if today is still empty the streak runs to
 * yesterday. `values` is oldest first and its last entry is today.
 */
export function streakLength(values: number[]): number {
  let end = values.length - 1;
  if (end >= 0 && values[end] <= 0) end--;
  let n = 0;
  for (let i = end; i >= 0 && values[i] > 0; i--) n++;
  return n;
}

/** The longest run of active days anywhere in `values`. */
export function longestStreak(values: number[]): number {
  let best = 0;
  let run = 0;
  for (const v of values) {
    run = v > 0 ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

export interface HeatCell {
  index: number;
  col: number;
  row: number;
  x: number;
  y: number;
  band: number;
}

export interface HeatLayout {
  cells: HeatCell[];
  weeks: number;
  width: number;
  height: number;
  streak: number;
  /** True when the last streak day is today (so today gets the heavier ring). */
  streakIncludesToday: boolean;
  cuts: number[];
  todayCell: HeatCell | null;
}

/**
 * Rolling weeks, oldest top-left, today the bottom-right cell; every column is seven
 * consecutive days. A partial first column (n not a multiple of 7) is padded at the top.
 */
export function heatLayout(values: number[], cell = 13, gap = 4, labelWidth = 40): HeatLayout {
  const n = values.length;
  const pad = (7 - (n % 7)) % 7;
  const weeks = Math.max(1, Math.ceil((n + pad) / 7));
  const step = cell + gap;
  const cuts = heatCuts(values);
  const cells: HeatCell[] = values.map((v, i) => {
    const col = Math.floor((i + pad) / 7);
    const row = (i + pad) % 7;
    return { index: i, col, row, x: col * step, y: row * step, band: heatBand(v, cuts) };
  });
  const streak = streakLength(values);
  return {
    cells,
    weeks,
    width: weeks * step - gap + labelWidth,
    height: 7 * step - gap,
    streak,
    streakIncludesToday: n > 0 && values[n - 1] > 0,
    cuts,
    todayCell: cells.length ? cells[cells.length - 1] : null,
  };
}

/** Percent weights for a stacked bar. */
export function stackFlex(values: number[]): number[] {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  if (total <= 0) return values.map(() => 0);
  return values.map((v) => (Math.max(0, v) / total) * 100);
}
