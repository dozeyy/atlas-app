// The Atlas mark as path data, for the places that cannot use the CSS mask (`.spark` in trail.css):
// an SVG that needs the mark in its own coordinate space (Wrapped's charts and trail) and the recap
// card's canvas. One source: `assets/spark.svg`, read at build time, so the mark is the same glyph
// everywhere in the app ("Atlas mark everywhere", Will, 2026-11-10).

import raw from "../assets/spark.svg?raw";

/** The side of the square the mark is drawn in (the SVG's viewBox). */
export const SPARK_BOX = 1024;

/** The mark's paths (the swoosh and its dot), in SPARK_BOX units. */
export const SPARK_PATHS: readonly string[] = [...raw.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);

let compiled: Path2D[] | null = null;

/**
 * Paint the mark on a canvas, filled with the context's current fillStyle, centred on (cx, cy) in a
 * box `size` wide. The paths are compiled once; a context without Path2D (a test DOM) draws nothing.
 */
export function drawSparkMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  if (typeof Path2D === "undefined") return;
  compiled ??= SPARK_PATHS.map((d) => new Path2D(d));
  const k = size / SPARK_BOX;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(k, k);
  for (const p of compiled) ctx.fill(p);
  ctx.restore();
}
