// Topographic contour lines: Atlas's signature backdrop for empty states,
// onboarding and Wrapped. A smooth height field is traced into contour lines
// with marching squares, and the cell segments are chained into whole
// polylines, so each line is one stroke (round joins, no seams, a closed ring
// closes). Pure and deterministic: the same seed always draws the same map, and
// it is computed once and drawn as two static SVG paths: the ordinary lines and,
// like a printed map, every fifth line as a heavier index contour.
//
// The land: two main summits, one on each side of the frame's long axis, so a
// saddle forms between them, plus one or two smaller hills; every summit sits
// inside the middle 15-85 % of the frame, so the rings and the saddle are on
// screen and not cut off at an edge.

export interface TopoOptions {
  width: number;
  height: number;
  /** Grid cells per side of the sampling grid (more = smoother, bigger path). */
  cols?: number;
  rows?: number;
  levels?: number;
  seed?: number;
}

export interface TopoPaths {
  /** The ordinary contour lines. */
  minor: string;
  /** Every fifth line (an index contour on a printed map), drawn a little heavier. */
  index: string;
}

/** A summit's place as a share of the frame (0-1 on each axis), for tests and tuning. */
export interface TopoPeak {
  x: number;
  y: number;
  r: number;
  h: number;
}

/** Which levels are index contours: every fifth, counting from the lowest. */
export const INDEX_EVERY = 5;

/**
 * The band of the frame (as a share of each side) every summit stays inside. The drawing covers
 * its box (`slice`), so a box squarer than 960 x 420 shows only the middle ~70 % of the width:
 * the band keeps the summits inside that too.
 */
export const PEAK_BAND: [number, number] = [0.2, 0.8];

function rng(seed: number): () => number {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Corner order: tl, tr, br, bl. Edges: 0 top, 1 right, 2 bottom, 3 left. */
const SEGMENTS: Record<number, number[][]> = {
  1: [[3, 2]],
  2: [[2, 1]],
  3: [[3, 1]],
  4: [[0, 1]],
  5: [
    [0, 3],
    [2, 1],
  ],
  6: [[0, 2]],
  7: [[0, 3]],
  8: [[0, 3]],
  9: [[0, 2]],
  10: [
    [0, 1],
    [3, 2],
  ],
  11: [[0, 1]],
  12: [[3, 1]],
  13: [[2, 1]],
  14: [[3, 2]],
};

/**
 * The summits for a seed, in frame shares. Two main ones sit on opposite sides of the long
 * axis (at least a fifth of the frame apart), the rest are smaller hills anywhere in the band.
 */
export function topoPeaks(seed: number, width: number, height: number): TopoPeak[] {
  const rand = rng(seed);
  const [lo, hi] = PEAK_BAND;
  const span = (a: number, b: number) => a + rand() * (b - a);
  const wide = width >= height;
  // The long axis is split into a near part and a far part for the two summits, at least 0.28
  // of it apart, and the second summit stands at 82-100 % of the first's height with a radius
  // that leaves a dip between them: both get their own rings, and the lower rings join around
  // the pair, which is the saddle.
  // A box as tall as it is wide shows only the middle ~55 % of the long axis, so the summits
  // keep to 0.25-0.75 of it.
  const near = () => span(lo + 0.05, 0.37);
  const far = () => span(0.63, hi - 0.05);
  const across = () => span(lo + 0.05, hi - 0.05);
  const main = (along: () => number, h: number): TopoPeak => {
    const a = along();
    const b = across();
    return { x: wide ? a : b, y: wide ? b : a, r: 0.12 + rand() * 0.08, h };
  };
  const hill = (): TopoPeak => ({ x: span(lo, hi), y: span(lo, hi), r: 0.08 + rand() * 0.08, h: 0.25 + rand() * 0.25 });
  const h0 = 0.9 + rand() * 0.3;
  const peaks = [main(near, h0), main(far, h0 * (0.82 + rand() * 0.18)), hill()];
  if (rand() < 0.5) peaks.push(hill());
  return peaks;
}

/** Both sets of lines for a seed. */
export function contourPaths({ width, height, cols = 56, rows = 36, levels = 11, seed = 7 }: TopoOptions): TopoPaths {
  const peaks = topoPeaks(seed, width, height).map((p) => ({
    x: p.x * width,
    y: p.y * height,
    r: p.r * Math.max(width, height),
    h: p.h,
  }));
  // The ripple's phase comes after the peaks in the stream, so a seed's summits never move
  // when the ripple is retuned.
  const rand = rng(seed ^ 0x9e3779b9);
  const phase = [rand() * 6.28, rand() * 6.28];

  const field = (x: number, y: number): number => {
    let v = 0;
    for (const p of peaks) {
      const dx = x - p.x;
      const dy = y - p.y;
      v += p.h * Math.exp(-(dx * dx + dy * dy) / (2 * p.r * p.r));
    }
    // A little ripple so the lines are never perfect circles.
    v += 0.08 * Math.sin(x / (width * 0.11) + phase[0]) * Math.cos(y / (height * 0.13) + phase[1]);
    return v;
  };

  const cw = width / cols;
  const ch = height / rows;
  const grid: number[][] = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j <= rows; j++) {
    const row: number[] = [];
    for (let i = 0; i <= cols; i++) {
      const v = field(i * cw, j * ch);
      row.push(v);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    grid.push(row);
  }

  const minor: string[] = [];
  const index: string[] = [];

  for (let k = 1; k <= levels; k++) {
    const t = lo + ((hi - lo) * k) / (levels + 1);
    // Every crossing is keyed by the grid edge it sits on, so the two cells that share an edge
    // name the same point and the segments chain into one line.
    const segs: { a: number; b: number }[] = [];
    const pts = new Map<number, [number, number]>();
    const hKey = (i: number, j: number) => j * (cols + 1) + i; // edge (i,j)-(i+1,j)
    const vKey = (i: number, j: number) => (rows + 1) * (cols + 1) + j * (cols + 1) + i; // edge (i,j)-(i,j+1)
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const tl = grid[j][i];
        const tr = grid[j][i + 1];
        const br = grid[j + 1][i + 1];
        const bl = grid[j + 1][i];
        const idx = (tl > t ? 8 : 0) | (tr > t ? 4 : 0) | (br > t ? 2 : 0) | (bl > t ? 1 : 0);
        const cell = SEGMENTS[idx];
        if (!cell) continue;
        const x0 = i * cw;
        const y0 = j * ch;
        const edge = (e: number): number => {
          let key: number;
          let p: [number, number];
          switch (e) {
            case 0:
              key = hKey(i, j);
              p = [x0 + cw * ((t - tl) / (tr - tl)), y0];
              break;
            case 1:
              key = vKey(i + 1, j);
              p = [x0 + cw, y0 + ch * ((t - tr) / (br - tr))];
              break;
            case 2:
              key = hKey(i, j + 1);
              p = [x0 + cw * ((t - bl) / (br - bl)), y0 + ch];
              break;
            default:
              key = vKey(i, j);
              p = [x0, y0 + ch * ((t - tl) / (bl - tl))];
          }
          if (!pts.has(key)) pts.set(key, p);
          return key;
        };
        for (const [a, b] of cell) segs.push({ a: edge(a), b: edge(b) });
      }
    }
    const out = k % INDEX_EVERY === 0 ? index : minor;
    for (const line of chain(segs)) out.push(toPath(line.map((key) => pts.get(key)!), line[0] === line[line.length - 1]));
  }
  return { minor: minor.join(""), index: index.join("") };
}

/** All the lines in one path (the index lines included), for anything that wants one stroke. */
export function contourPath(opts: TopoOptions): string {
  const { minor, index } = contourPaths(opts);
  return minor + index;
}

/**
 * Chains edge-keyed segments into polylines: each key appears in at most two segments, so a
 * line is walked from one end to the other; a ring comes back to its first key.
 */
function chain(segs: { a: number; b: number }[]): number[][] {
  const at = new Map<number, number[]>();
  const link = (key: number, s: number) => {
    const list = at.get(key);
    if (list) list.push(s);
    else at.set(key, [s]);
  };
  segs.forEach((s, n) => {
    link(s.a, n);
    link(s.b, n);
  });
  const used = new Uint8Array(segs.length);
  const walk = (start: number, from: number): number[] => {
    const line: number[] = [];
    let key = from;
    let s = start;
    for (;;) {
      used[s] = 1;
      const seg = segs[s];
      key = seg.a === key ? seg.b : seg.a;
      line.push(key);
      const next = (at.get(key) ?? []).find((n) => !used[n]);
      if (next === undefined) return line;
      s = next;
    }
  };
  const lines: number[][] = [];
  // Open lines first, each started from a free end (a key with one segment), so no line is
  // begun in the middle and split in two.
  for (const [key, list] of at) {
    if (list.length !== 1 || used[list[0]]) continue;
    lines.push([key, ...walk(list[0], key)]);
  }
  // What is left is rings.
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    lines.push([segs[s].a, ...walk(s, segs[s].a)]);
  }
  return lines;
}

function toPath(points: [number, number][], closed: boolean): string {
  const f = (n: number) => Math.round(n * 10) / 10;
  let d = "";
  for (let n = 0; n < points.length; n++) {
    if (closed && n === points.length - 1) break;
    const [x, y] = points[n];
    d += `${n === 0 ? "M" : "L"}${f(x)} ${f(y)}`;
  }
  return closed ? `${d}Z` : d;
}
