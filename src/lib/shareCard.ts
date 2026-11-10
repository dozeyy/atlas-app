// Wrapped's end card, drawn to a canvas. The canvas on the page is the picture that gets saved, so
// what you see is what leaves the app. It is laid out on a 452 x 420 grid and drawn at 3x
// (1356 x 1260), so the preview stays sharp on a 2x screen at the size the sheet shows it. It is
// drawn from the app's own tokens at the moment of drawing, so it matches the theme you see, and
// from the numbers and names a ShareCard carries; it never sees a chat name or a prompt.
// (A canvas cannot set the CASL axis, so the figures use Recursive's default softness here.)

import { drawSparkMark } from "./sparkMark";
import type { ShareCard } from "./wrappedModel";

const S = 3;
export const CARD_W = 452 * S;
export const CARD_H = 420 * S;

const PAD_X = 36 * S;
const PAD_TOP = 34 * S;
const COLS = 2;
const COL_GAP = 24 * S;

interface Palette {
  bg: string;
  ink: string;
  ink2: string;
  accent: string;
  fill: string;
  ui: string;
  display: string;
}

function palette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    bg: get("--raised", "Canvas"),
    ink: get("--ink", "CanvasText"),
    ink2: get("--ink-2", "GrayText"),
    accent: get("--accent", "Highlight"),
    fill: get("--heat-1", "Canvas"),
    ui: get("--font-ui", "sans-serif"),
    display: get("--font-display", "sans-serif"),
  };
}

/** Load the display face for the digits and letters the card draws, so the first paint is right. */
export async function loadCardFonts(): Promise<void> {
  try {
    await document.fonts?.load('760 100px "Recursive Variable"', "0123456789MkBT. abcdefghijklmnopqrstuvwxyz");
  } catch {
    /* the system face is the fallback */
  }
}

function spaced(ctx: CanvasRenderingContext2D, px: string): void {
  // letterSpacing is newer than the rest of the 2D API: skip it where it is missing.
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = px;
}

/** Shrink the font until the text fits `max`; `min` is the floor. Returns the size used. */
function fit(ctx: CanvasRenderingContext2D, text: string, font: (px: number) => string, start: number, min: number, max: number): number {
  let px = start;
  ctx.font = font(px);
  while (px > min && ctx.measureText(text).width > max) {
    px -= 2;
    ctx.font = font(px);
  }
  return px;
}

/** `text` cut with "..." when it still does not fit. */
function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}...`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}...`;
}

/** Paint the card. Returns false when the canvas has no 2D context. */
export function drawShareCard(canvas: HTMLCanvasElement, card: ShareCard): boolean {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const p = palette();
  const ui = (w: number, px: number) => `${w} ${px}px ${p.ui}`;
  const display = (w: number) => (px: number) => `${w} ${px}px ${p.display}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // The header: the wordmark on the left, the dated range on the right.
  const innerW = CARD_W - PAD_X * 2;
  ctx.fillStyle = p.ink2;
  ctx.font = ui(600, 13 * S);
  const headBase = PAD_TOP + 13 * S;
  const range = card.range;
  const rangeW = ctx.measureText(range).width;
  ctx.fillText(card.title, PAD_X, headBase);
  ctx.fillText(range, CARD_W - PAD_X - rangeW, headBase);

  // The one big figure, then its unit.
  const figBase = PAD_TOP + 18 * S + 22 * S + 72 * S;
  spaced(ctx, `${-0.035 * 96 * S}px`);
  const size = fit(ctx, card.tokens, display(760), 96 * S, 48 * S, innerW - 110 * S);
  ctx.font = display(760)(size);
  ctx.fillStyle = p.ink;
  ctx.fillText(card.tokens, PAD_X, figBase);
  const figW = ctx.measureText(card.tokens).width;
  spaced(ctx, "0px");
  ctx.font = display(700)(22 * S);
  ctx.fillStyle = p.ink2;
  ctx.fillText(card.unit, PAD_X + figW + 8 * S, figBase);

  // The history as a ridge.
  const ridgeTop = PAD_TOP + 18 * S + 22 * S + 88 * S + 18 * S;
  const ridgeH = 64 * S;
  if (card.ridge.length > 1) {
    const w = 380 * S;
    const pts = card.ridge.map((v, i): [number, number] => [(i / (card.ridge.length - 1)) * w + PAD_X, ridgeTop + ridgeH - 2 * S - v * (ridgeH - 8 * S)]);
    ctx.beginPath();
    ctx.moveTo(PAD_X, ridgeTop + ridgeH);
    pts.forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.lineTo(PAD_X + w, ridgeTop + ridgeH);
    ctx.closePath();
    ctx.fillStyle = p.fill;
    ctx.fill();
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 1.6 * S;
    ctx.lineJoin = "round";
    ctx.stroke();
    // The summit: a dot on the highest point and the Atlas mark above it, as the Dashboard ridge wears.
    const peak = pts.reduce((best, pt) => (pt[1] < best[1] ? pt : best), pts[0]);
    ctx.fillStyle = p.accent;
    ctx.beginPath();
    ctx.arc(peak[0], peak[1], 3 * S, 0, Math.PI * 2);
    ctx.fill();
    drawSparkMark(ctx, peak[0], peak[1] - 15 * S, 16 * S);
  }

  // Up to four facts, two to a row: the value over its label.
  const colW = (innerW - COL_GAP * (COLS - 1)) / COLS;
  const factsTop = ridgeTop + ridgeH + 22 * S;
  card.facts.slice(0, 4).forEach((f, i) => {
    const x = PAD_X + (i % COLS) * (colW + COL_GAP);
    const y = factsTop + Math.floor(i / COLS) * (48 * S + 20 * S);
    // A long name steps down a little, then is cut with "...": it never shrinks to small print
    // beside a full-size number.
    const px = fit(ctx, f.value, display(720), 26 * S, 20 * S, colW);
    ctx.font = display(720)(px);
    ctx.fillStyle = p.ink;
    ctx.fillText(clip(ctx, f.value, colW), x, y + 24 * S);
    ctx.font = ui(400, 13 * S);
    ctx.fillStyle = p.ink2;
    ctx.fillText(f.label, x, y + 24 * S + 22 * S);
  });
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
