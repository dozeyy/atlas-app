// Topographic contour lines: Atlas's signature backdrop for empty states,
// onboarding and Wrapped. A smooth height field is traced into contour lines
// with marching squares. Pure and deterministic: the same seed always draws the
// same map, and it is computed once and drawn as one static SVG path.

export interface TopoOptions {
  width: number;
  height: number;
  /** Grid cells per side of the sampling grid (more = smoother, bigger path). */
  cols?: number;
  rows?: number;
  levels?: number;
  seed?: number;
}

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

type Peak = { x: number; y: number; r: number; h: number };

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

export function contourPath({
  width,
  height,
  cols = 56,
  rows = 36,
  levels = 11,
  seed = 7,
}: TopoOptions): string {
  const rand = rng(seed);
  const peaks: Peak[] = Array.from({ length: 4 }, () => ({
    x: rand() * width,
    y: rand() * height,
    r: (0.18 + rand() * 0.22) * Math.max(width, height),
    h: 0.6 + rand() * 0.6,
  }));
  const phase = [rand() * 6.28, rand() * 6.28];

  const field = (x: number, y: number): number => {
    let v = 0;
    for (const p of peaks) {
      const dx = x - p.x;
      const dy = y - p.y;
      v += p.h * Math.exp(-(dx * dx + dy * dy) / (2 * p.r * p.r));
    }
    // A little ripple so the lines are never perfect circles.
    v += 0.06 * Math.sin(x / (width * 0.11) + phase[0]) * Math.cos(y / (height * 0.13) + phase[1]);
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

  const parts: string[] = [];
  const f = (n: number) => Math.round(n * 10) / 10;

  for (let k = 1; k <= levels; k++) {
    const t = lo + ((hi - lo) * k) / (levels + 1);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const tl = grid[j][i];
        const tr = grid[j][i + 1];
        const br = grid[j + 1][i + 1];
        const bl = grid[j + 1][i];
        const idx = (tl > t ? 8 : 0) | (tr > t ? 4 : 0) | (br > t ? 2 : 0) | (bl > t ? 1 : 0);
        const segs = SEGMENTS[idx];
        if (!segs) continue;
        const x0 = i * cw;
        const y0 = j * ch;
        const edge = (e: number): [number, number] => {
          switch (e) {
            case 0:
              return [x0 + cw * ((t - tl) / (tr - tl)), y0];
            case 1:
              return [x0 + cw, y0 + ch * ((t - tr) / (br - tr))];
            case 2:
              return [x0 + cw * ((t - bl) / (br - bl)), y0 + ch];
            default:
              return [x0, y0 + ch * ((t - tl) / (bl - tl))];
          }
        };
        for (const [a, b] of segs) {
          const [ax, ay] = edge(a);
          const [bx, by] = edge(b);
          parts.push(`M${f(ax)} ${f(ay)}L${f(bx)} ${f(by)}`);
        }
      }
    }
  }
  return parts.join("");
}
