// Wrapped's share card, drawn to a canvas. The canvas on the page is the picture that gets saved, so
// what Will sees is what leaves the app. It is a Poster Riot card: flat terracotta, one giant stat,
// one hero glyph, a slate strip with the small print. It uses the poster tokens (one look in every
// theme) and only the numbers and names a ShareCard carries; it never sees a chat name or a prompt.

import { chamfer, star } from "./posterMath";
import type { ShareCard } from "./wrappedModel";

export const CARD_W = 1200;
export const CARD_H = 675;

const PAD = 56;
const STRIP_H = 84;
const STROKE = 8;
const FIG_TOP = 128;
const FIG_BASE = 452;

interface Palette {
  bg: string;
  fg: string;
  soft: string;
  acc: string;
  onAcc: string;
  dark: string;
  stripBg: string;
  stripFg: string;
  mono: string;
  poster: string;
}

function palette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback;
  return {
    bg: get("--pr-clay-bg", "Canvas"),
    fg: get("--pr-clay-fg", "CanvasText"),
    soft: get("--pr-clay-soft", "Canvas"),
    acc: get("--pr-clay-acc", "Highlight"),
    onAcc: get("--pr-clay-on-acc", "HighlightText"),
    dark: get("--pr-clay-dark", "CanvasText"),
    stripBg: get("--pr-clay-strip-bg", "CanvasText"),
    stripFg: get("--pr-clay-strip-fg", "Canvas"),
    mono: get("--font-code", "monospace"),
    poster: get("--font-poster", "Impact, sans-serif"),
  };
}

/** Load the display face for the digits and letters the card draws, so the first paint is right. */
export async function loadCardFonts(): Promise<void> {
  try {
    await document.fonts?.load(
      '400 100px "Anton"',
      "0123456789MkBT. abcdefghijklmnopqrstuvwxyz",
    );
  } catch {
    /* the system face is the fallback */
  }
}

/** Shrink the font until the text fits `max`, then cut it with "..." if it still does not. */
function fit(
  ctx: CanvasRenderingContext2D,
  text: string,
  font: (px: number) => string,
  start: number,
  min: number,
  max: number,
): number {
  let px = start;
  ctx.font = font(px);
  while (px > min && ctx.measureText(text).width > max) {
    px -= 2;
    ctx.font = font(px);
  }
  return px;
}

function clip(
  ctx: CanvasRenderingContext2D,
  text: string,
  max: number,
): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}...`).width > max)
    t = t.slice(0, -1);
  return `${t.trimEnd()}...`;
}

function spaced(ctx: CanvasRenderingContext2D, px: string): void {
  // letterSpacing is newer than the rest of the 2D API: skip it where it is missing.
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing =
    px;
}

/** Fill (and, with a stroke colour, outline) an SVG path string. The same chamfer() and star() the posters draw with. */
function shape(
  ctx: CanvasRenderingContext2D,
  d: string,
  fill: string,
  stroke?: string,
): void {
  if (typeof Path2D === "undefined") return;
  const path = new Path2D(d);
  ctx.fillStyle = fill;
  ctx.fill(path);
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = STROKE;
    ctx.lineJoin = "miter";
    ctx.stroke(path);
  }
}

/** `n` heights taken evenly from the history ridge (0..1), the tallest at least a little tall. */
export function ridgeBars(ridge: number[], n: number): number[] {
  if (ridge.length === 0) return new Array<number>(n).fill(0.12);
  return Array.from({ length: n }, (_, i) => {
    const at = (i / Math.max(1, n - 1)) * (ridge.length - 1);
    const a = Math.floor(at);
    const b = Math.min(ridge.length - 1, a + 1);
    const v = ridge[a] + (ridge[b] - ridge[a]) * (at - a);
    return Math.max(0.1, Math.min(1, v));
  });
}

/** Paint the card. Returns false when the canvas has no 2D context. */
export function drawShareCard(
  canvas: HTMLCanvasElement,
  card: ShareCard,
): boolean {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const p = palette();
  const mono = (w: number, px: number) => `${w} ${px}px ${p.mono}`;
  const poster = (px: number) => `400 ${px}px "Anton", ${p.poster}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // The hero glyph: the history as chunky bars in a chamfered block, with a spark on the peak.
  const bx = 716;
  const by = 52;
  const bw = CARD_W - bx - 48;
  const bh = CARD_H - STRIP_H - by - 36;
  shape(ctx, chamfer(bx, by, bw, bh, 36), p.soft, p.dark);
  const n = 11;
  const gap = 12;
  const inset = 40;
  const barW = (bw - inset * 2 - gap * (n - 1)) / n;
  const heights = ridgeBars(card.ridge, n);
  const tall = bh - inset * 2 - 28;
  let peak = 0;
  heights.forEach((h, i) => {
    if (h > heights[peak]) peak = i;
  });
  heights.forEach((h, i) => {
    const hh = Math.max(24, h * tall);
    const x = bx + inset + i * (barW + gap);
    shape(
      ctx,
      chamfer(x, by + bh - inset - hh, barW, hh, 10),
      i === peak ? p.bg : p.dark,
    );
  });
  const px = bx + inset + peak * (barW + gap) + barW / 2;
  const py = by + bh - inset - Math.max(24, heights[peak] * tall);
  shape(ctx, star(px, Math.max(by + 34, py - 40), 38), p.acc, p.dark);

  // The unit, as a chip.
  ctx.font = mono(700, 24);
  spaced(ctx, "2px");
  const unit = card.unit.toUpperCase();
  const uw = ctx.measureText(unit).width + 32;
  shape(ctx, chamfer(PAD, 52, uw, 44, 8), p.acc);
  ctx.fillStyle = p.onAcc;
  ctx.fillText(unit, PAD + 16, 83);
  spaced(ctx, "0px");

  // The one giant stat, sitting on a fixed baseline.
  const maxW = bx - PAD - 36;
  const size = fit(ctx, card.tokens, poster, 420, 140, maxW);
  ctx.font = poster(size);
  ctx.fillStyle = p.fg;
  ctx.fillText(card.tokens, PAD - 4, Math.max(FIG_BASE, FIG_TOP + size * 0.7));

  // Up to three small stats under it.
  const tiles = card.tiles.slice(0, 3);
  if (tiles.length > 0) {
    const col = (bx - PAD - 20) / tiles.length;
    tiles.forEach((t, i) => {
      const x = PAD + i * col;
      ctx.font = mono(700, 18);
      spaced(ctx, "2px");
      ctx.fillStyle = p.acc;
      ctx.fillText(
        clip(ctx, t.label.toUpperCase(), col - 18),
        x,
        FIG_BASE + 52,
      );
      spaced(ctx, "0px");
      ctx.fillStyle = p.fg;
      const f = fit(ctx, t.value, poster, 46, 26, col - 18);
      ctx.font = poster(f);
      ctx.fillText(
        clip(ctx, t.value, col - 18),
        x,
        FIG_BASE + 52 + 8 + f * 0.9,
      );
    });
  }

  // The strip: the small print on slate, and the wordmark.
  ctx.fillStyle = p.stripBg;
  ctx.fillRect(0, CARD_H - STRIP_H, CARD_W, STRIP_H);
  ctx.fillStyle = p.stripFg;
  const base = CARD_H - STRIP_H / 2 + 8;
  ctx.font = mono(700, 24);
  spaced(ctx, "1px");
  const mark = "ATLAS WRAPPED";
  const mw = ctx.measureText(mark).width;
  const room = CARD_W - PAD * 2 - mw - 40;
  ctx.fillText(
    clip(ctx, `${card.days}   ${card.range}`.toUpperCase(), room),
    PAD,
    base,
  );
  ctx.fillText(mark, CARD_W - PAD - mw, base);
  spaced(ctx, "0px");
  return true;
}

/** The canvas as PNG bytes, ready for the Rust side (a plain number list crosses the bridge). */
export function cardBytes(canvas: HTMLCanvasElement): Promise<number[]> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("The picture could not be made."));
        return;
      }
      blob
        .arrayBuffer()
        .then((buf) => resolve(Array.from(new Uint8Array(buf))))
        .catch(reject);
    }, "image/png");
  });
}
