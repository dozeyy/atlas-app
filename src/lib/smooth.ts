// A long run of values as a short, smooth ridge: the Dashboard's ridge language (monotone cubic
// through a few points, never below its baseline) for the places that get hundreds of points (a
// chat's activity in Pick up, the year on the recap card). Pure: no React, no DOM.

import { ridgeGeometry } from "./chartPaths";
import type { Pt, RidgeGeometry } from "./chartPaths";

/**
 * `values` summed into at most `n` even buckets, left to right, so a long trace keeps its totals
 * and its shape but loses the per-point jitter. `n` or fewer values pass through unchanged.
 */
export function bucket(values: number[], n: number): number[] {
  const len = values.length;
  if (len <= n || n < 1) return values.slice();
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < len; i++) out[Math.min(n - 1, Math.floor((i * n) / len))] += values[i];
  return out;
}

export interface Smoothed extends RidgeGeometry {
  /** The points the curve goes through, after bucketing. */
  values: number[];
  /** The last point, for an end dot; null when there are no values. */
  last: Pt | null;
}

/**
 * Bucket to `n` points or fewer, then lay them out as a ridge in a `w` x `h` box: the curve is
 * monotone cubic (chartPaths.smoothPath), so it stays between its points and never dips under the
 * baseline where usage drops to zero. `pad` is the room at each side, `top` and `bottom` the room
 * above the peak and under the baseline, as the Dashboard ridge takes them.
 */
export function bucketAndSmooth(values: number[], n: number, w: number, h: number, pad = 2, top = 2, bottom = 2): Smoothed {
  const v = bucket(values, n);
  const g = ridgeGeometry(v, w, h, pad, top, bottom);
  return { ...g, values: v, last: g.pts.length ? g.pts[g.pts.length - 1] : null };
}
