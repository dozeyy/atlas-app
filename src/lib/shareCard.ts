// Wrapped's share card, drawn to a canvas. The canvas on the page is the picture that gets saved,
// so what Will sees is what leaves the app. It uses the --share-* tokens (one look in every
// theme) and only the numbers and names a ShareCard carries; it never sees a chat name.

import type { ShareCard } from "./wrappedModel";

export const CARD_W = 1200;
export const CARD_H = 675;

/** The left panel's width; the stats sit to the right of it. */
const SPLIT = 640;
const PAD = 56;

interface Palette {
  panel: string;
  ink: string;
  ink2: string;
  line: string;
  accent: string;
  onAccent: string;
  sand: string;
  ui: string;
  display: string;
}

function palette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    panel: get("--share-panel", "Canvas"),
    ink: get("--share-ink", "CanvasText"),
    ink2: get("--share-ink-2", "GrayText"),
    line: get("--share-line", "GrayText"),
    accent: get("--share-accent", "Highlight"),
    onAccent: get("--share-accent-ink", "HighlightText"),
    sand: get("--share-sand", "GrayText"),
    ui: get("--font-ui", "system-ui, sans-serif"),
    display: get("--font-display", "system-ui, sans-serif"),
  };
}

/** Load the display face for the digits and letters the card draws, so the first paint is right. */
export async function loadCardFonts(): Promise<void> {
  try {
    await document.fonts?.load('800 100px "Recursive Variable"', "0123456789MkBT. abcdefghijklmnopqrstuvwxyz");
  } catch {
    /* the system face is the fallback */
  }
}

/** Shrink the font until the text fits `max`, then cut it with "..." if it still does not. */
function fit(ctx: CanvasRenderingContext2D, text: string, font: (px: number) => string, start: number, min: number, max: number): number {
  let px = start;
  ctx.font = font(px);
  while (px > min && ctx.measureText(text).width > max) {
    px -= 2;
    ctx.font = font(px);
  }
  return px;
}

function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}...`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}...`;
}

function spaced(ctx: CanvasRenderingContext2D, px: string): void {
  // letterSpacing is newer than the rest of the 2D API: skip it where it is missing.
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = px;
}

function star(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.32;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/** Paint the card. Returns false when the canvas has no 2D context. */
export function drawShareCard(canvas: HTMLCanvasElement, card: ShareCard): boolean {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const p = palette();
  const ui = (w: number, px: number) => `${w} ${px}px ${p.ui}`;
  const disp = (w: number) => (px: number) => `${w} ${px}px ${p.display}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  ctx.fillStyle = p.panel;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Left panel: terracotta with contour rings, like the map the app is named for.
  ctx.fillStyle = p.accent;
  ctx.fillRect(0, 0, SPLIT, CARD_H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, SPLIT, CARD_H);
  ctx.clip();
  ctx.strokeStyle = p.onAccent;
  ctx.lineWidth = 2;
  for (let i = 0; i < 7; i++) {
    ctx.globalAlpha = 0.18 - i * 0.02;
    ctx.beginPath();
    ctx.ellipse(SPLIT - 40, CARD_H - 30, 120 + i * 62, 90 + i * 50, -0.35, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  const inner = SPLIT - PAD * 2;
  ctx.fillStyle = p.onAccent;
  ctx.font = ui(700, 30);
  ctx.fillText(clip(ctx, card.title, inner), PAD, 96);

  const bigPx = fit(ctx, card.tokens, disp(800), 240, 120, inner);
  ctx.font = disp(800)(bigPx);
  ctx.fillText(card.tokens, PAD - 6, 96 + 40 + bigPx * 0.78);
  const baseBig = 96 + 40 + bigPx * 0.78;
  ctx.font = ui(700, 48);
  ctx.fillText(card.unit, PAD, baseBig + 62);
  ctx.font = ui(600, 30);
  ctx.globalAlpha = 0.92;
  ctx.fillText(clip(ctx, card.days, inner), PAD, baseBig + 116);
  ctx.globalAlpha = 1;

  ctx.font = ui(600, 26);
  ctx.fillText(clip(ctx, card.range, inner), PAD, CARD_H - 84);
  ctx.font = ui(800, 22);
  spaced(ctx, "3px");
  ctx.fillText("ATLAS WRAPPED", PAD, CARD_H - 48);
  spaced(ctx, "0px");

  // Right: the stats, one under another.
  const n = card.tiles.length;
  if (n > 0) {
    const top = 64;
    const room = CARD_H - top * 2;
    const slot = Math.min(156, room / n);
    const startY = top + (room - slot * n) / 2;
    const x = SPLIT + PAD;
    const w = CARD_W - SPLIT - PAD * 2;
    card.tiles.forEach((t, i) => {
      const y = startY + i * slot;
      if (i > 0) {
        ctx.fillStyle = p.line;
        ctx.fillRect(x, y, w, 2);
      }
      ctx.fillStyle = p.ink2;
      ctx.font = ui(700, 22);
      spaced(ctx, "1px");
      ctx.fillText(t.label.toUpperCase(), x, y + slot * 0.36);
      spaced(ctx, "0px");
      ctx.fillStyle = p.ink;
      const px = fit(ctx, t.value, disp(760), 58, 30, w);
      ctx.font = disp(760)(px);
      ctx.fillText(clip(ctx, t.value, w), x, y + slot * 0.36 + 16 + px * 0.86);
    });
  }

  ctx.fillStyle = p.sand;
  star(ctx, CARD_W - 70, 70, 26);
  star(ctx, CARD_W - 118, 118, 12);
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
