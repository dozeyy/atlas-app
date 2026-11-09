// What the setup window says and how far the trail has climbed, as pure functions of the
// snapshot Rust sends. No DOM in here, so it is all unit-tested.

import { compact } from "../lib/usage";

export type Phase = "ready" | "closeAtlas" | "installing" | "done" | "error";

export interface Reading {
  available: boolean;
  done: number;
  total: number;
  tokens: number;
  finished: boolean;
  failed: boolean;
}

export interface Snapshot {
  phase: Phase;
  stage: "" | "unpack" | "install" | "reading";
  /** 0..1, how far the installer is. */
  install: number;
  error: string | null;
  reading: Reading;
  reduceMotion: boolean;
}

export const EMPTY_SNAPSHOT: Snapshot = {
  phase: "ready",
  stage: "",
  install: 0,
  error: null,
  reading: { available: true, done: 0, total: 0, tokens: 0, finished: false, failed: false },
  reduceMotion: false,
};

/** 0..1, how much of the chats have been read. Nothing to read, or a failed read, counts as 0:
 *  there is no reading for the trail to follow. */
export function readingFraction(r: Reading): number {
  if (!r.available || r.failed) return 0;
  if (r.finished) return 1;
  if (r.total <= 0) return 0;
  return Math.min(1, r.done / r.total);
}

/** How far up the trail the walker is, 0..1: exactly how far the chats have been read, so it
 *  stands at the mark when the reading is done. The install does not move it (it has its own
 *  words in the label); only the finished setup carries it the rest of the way when there was
 *  nothing to follow. */
export function trailProgress(s: Snapshot): number {
  if (s.phase === "done") return 1;
  return readingFraction(s.reading);
}

/** Whether the reading is still going: it has a count and has not ended. */
export function stillReading(r: Reading): boolean {
  return r.available && !r.failed && !r.finished && r.total > 0;
}

/** The live line about the reading. */
export function readingLine(r: Reading): string {
  if (!r.available) return "No chats found yet.";
  if (r.failed) return "Could not read ahead. Atlas will read your chats when it opens.";
  if (r.finished) {
    if (r.total <= 0) return "No chats found yet.";
    return `Read ${compact(r.total)} ${r.total === 1 ? "chat" : "chats"}, ${compact(r.tokens)} tokens`;
  }
  if (r.total <= 0) return "Looking for your chats";
  return `Already reading your chats: ${compact(r.done)} of ${compact(r.total)}, ${compact(r.tokens)} tokens`;
}

export type Action = "install" | "closeAtlas" | "retry" | "openAtlas" | "close";

export interface Screen {
  line: string;
  primary: { label: string; action: Action } | null;
  secondary: { label: string; action: Action } | null;
  /** The quiet Options disclosure is offered. */
  options: boolean;
  /** The X works (never in the middle of an install). */
  closable: boolean;
}

/** What each phase puts on the sheet. No headers, no paragraphs: one line and at most two buttons. */
export function screenFor(s: Snapshot, openWhenDone: boolean): Screen {
  switch (s.phase) {
    case "ready":
      return { line: readingLine(s.reading), primary: { label: "Install", action: "install" }, secondary: null, options: true, closable: true };
    case "closeAtlas":
      return {
        line: "Atlas is open.",
        primary: { label: "Close Atlas and continue", action: "closeAtlas" },
        secondary: null,
        options: false,
        closable: true,
      };
    case "installing": {
      // The install's own step is the line; when the chats are still being read (Install was
      // pressed early) the count rides along, so both are always visible.
      const counts = `${compact(s.reading.done)} of ${compact(s.reading.total)}`;
      const reading = stillReading(s.reading);
      const line =
        s.stage === "reading"
          ? reading
            ? `Finishing your chats: ${counts}`
            : "Finishing up"
          : `${s.stage === "unpack" ? "Unpacking" : "Installing Atlas"}${reading ? `\nStill reading your chats: ${counts}` : ""}`;
      return { line, primary: null, secondary: null, options: false, closable: false };
    }
    case "done":
      return openWhenDone
        ? { line: "All set.", primary: null, secondary: null, options: false, closable: false }
        : {
            line: "All set.",
            primary: { label: "Open Atlas", action: "openAtlas" },
            secondary: { label: "Close", action: "close" },
            options: false,
            closable: true,
          };
    case "error":
      return {
        line: s.error ?? "Something went wrong.",
        primary: { label: "Retry", action: "retry" },
        secondary: null,
        options: false,
        closable: true,
      };
  }
}

/** Wrap each number in the line (1.2k, 27M, 304) so it can use the display face. */
export function splitNumbers(line: string): { text: string; num: boolean }[] {
  const out: { text: string; num: boolean }[] = [];
  const re = /\d[\d.]*[kMBTP]?/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: line.slice(last, at), num: false });
    out.push({ text: m[0], num: true });
    last = at + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), num: false });
  return out;
}

// ---------------------------------------------------------------- the map's geometry
// All of it lives here, as plain numbers, so a test can prove that no line ever meets another.

/** The sheet, in the units of the page's SVG (1 unit = 1 CSS px). */
export const SHEET = { w: 560, h: 380, radius: 18 };

/** Nothing on the map comes closer than this to anything it must not touch (px). */
export const CLEAR = 8;
/** Contours are gone this far in from the sheet's edge, and fade out over the 28 px after it
 *  (the four gradients in setup.html), so no line ever runs along or is cut flat by the border. */
export const EDGE_CLEAR = 12;

/** Where the middle of the mark's arms sits, and how big the mark is. */
export const SUMMIT = { x: 418, y: 138 };
export const MARK_PX = 120;

export const RING_COUNT = 8;
export const RING_FIRST = 88;
export const RING_STEP = 40;

type Pt = readonly [number, number];

/** One contour: a closed, gently wobbling loop around (cx, cy). Deterministic, so the same
 *  ring is drawn every time. The wobble's phase drifts by a small, fixed step from ring to
 *  ring, so neighbours keep (nearly) the same shape and can never fold into each other. */
export function ringPoints(cx: number, cy: number, index: number): Pt[] {
  const n = 96;
  const seed = 0.4 + index * 0.22;
  const r = RING_FIRST + index * RING_STEP;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const wob =
      1 +
      0.05 * Math.sin(3 * a + seed) +
      0.03 * Math.sin(5 * a + seed * 1.7) +
      0.016 * Math.sin(8 * a + seed * 2.3);
    out.push([cx + Math.cos(a) * r * wob * 1.12, cy + Math.sin(a) * r * wob * 0.9]);
  }
  return out;
}

export function ringPath(cx: number, cy: number, index: number): string {
  const pts = ringPoints(cx, cy, index);
  return `${pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join("")}Z`;
}

/** The dotted trail, as cubic curves (start, control, control, end), climbing from the
 *  bottom-left corner to just short of the mark. It runs low across the bottom, under every
 *  word the sheet can show, then turns up toward the summit. */
export const TRAIL_CURVES: readonly (readonly [Pt, Pt, Pt, Pt])[] = [
  [[40, 352], [150, 360], [268, 352], [326, 330]],
  [[326, 330], [384, 308], [358, 250], [372, 208]],
];

export function trailPath(): string {
  const [first] = TRAIL_CURVES;
  let d = `M ${first[0][0]} ${first[0][1]}`;
  for (const [, c1, c2, p] of TRAIL_CURVES) d += ` C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${p[0]} ${p[1]}`;
  return d;
}

/** Points along the trail, for distance checks. */
export function trailSamples(perCurve = 80): Pt[] {
  const out: Pt[] = [];
  for (const [p0, p1, p2, p3] of TRAIL_CURVES) {
    for (let i = 0; i <= perCurve; i++) {
      const t = i / perCurve;
      const u = 1 - t;
      const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
      out.push([
        w[0] * p0[0] + w[1] * p1[0] + w[2] * p2[0] + w[3] * p3[0],
        w[0] * p0[1] + w[1] * p1[1] + w[2] * p2[1] + w[3] * p3[1],
      ]);
    }
  }
  return out;
}

/** The most the words, buttons and options can ever cover: left 40, top 72, 296 wide, down to
 *  the last expanded option row. Nothing of the trail may enter it. */
export const COPY_MAX = { x: 40, y: 72, w: 296, h: 232 };

/** Shortest distance from a point to a closed polyline. */
export function distanceToLoop(p: Pt, loop: readonly Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const [ax, ay] = loop[i];
    const [bx, by] = loop[(i + 1) % loop.length];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
  }
  return best;
}
