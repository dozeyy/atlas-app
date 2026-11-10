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
  /** An older Atlas is running, so the reading has not started; it begins when Atlas closes. */
  waiting: boolean;
}

/** What the window is for: putting Atlas on (it starts by itself), or taking it off. */
export type Mode = "install" | "uninstall";

export interface Snapshot {
  mode: Mode;
  phase: Phase;
  /** Installing: unpack, install, opening. Uninstalling: closing, removing, data. */
  stage: "" | "unpack" | "install" | "opening" | "closing" | "removing" | "data";
  /** 0..1, how far the installer (or the remover) is. */
  install: number;
  error: string | null;
  reading: Reading;
  reduceMotion: boolean;
  /** Uninstalled with "remove saved data" ticked, but a folder without Atlas's marker was left whole. */
  dataKept: boolean;
}

export const EMPTY_SNAPSHOT: Snapshot = {
  mode: "install",
  phase: "ready",
  stage: "",
  install: 0,
  error: null,
  reading: { available: true, done: 0, total: 0, tokens: 0, finished: false, failed: false, waiting: false },
  reduceMotion: false,
  dataKept: false,
};

/** 0..1, how much of the chats have been read. Nothing to read, or a failed read, counts as 0:
 *  there is no reading for the trail to follow. */
export function readingFraction(r: Reading): number {
  if (!r.available || r.failed) return 0;
  if (r.finished) return 1;
  if (r.total <= 0) return 0;
  return Math.min(1, r.done / r.total);
}

/** How far up the trail the walker is, 0..1. Installing: whichever is further, the installer or
 *  the reading of the chats (so it never waits on a slow read, and never walks back). Removing:
 *  the remover's own progress. Done is the summit. */
export function trailProgress(s: Snapshot): number {
  if (s.phase === "done") return 1;
  if (s.phase === "ready" && s.mode === "uninstall") return 0;
  if (s.mode === "uninstall") return Math.min(1, Math.max(0, s.install));
  return Math.max(Math.min(1, Math.max(0, s.install)), readingFraction(s.reading));
}

/** Whether the reading is still going: it has a count and has not ended. */
export function stillReading(r: Reading): boolean {
  return r.available && !r.failed && !r.finished && r.total > 0;
}

/** A real Enter or Space keydown on a button: which one, and when (event time stamp, ms). */
export interface KeyPress {
  id: string;
  at: number;
}

/** How long after the keydown a keyboard click still counts (Space clicks on release). */
export const KEY_WINDOW_MS = 5000;

/** Whether a click on button `id` is a person's own, so a button that changes what is done to the
 *  computer (Install, Close Atlas) never fires from anything else. A click made by a script
 *  (`isTrusted` false) never counts; a mouse click (`detail` above 0) counts; a click with no
 *  mouse behind it counts only right after a real Enter or Space keydown on that same button. */
export function isOwnPress(click: { isTrusted: boolean; detail: number; timeStamp: number }, id: string, key: KeyPress | null): boolean {
  if (!click.isTrusted) return false;
  if (click.detail > 0) return true;
  if (!key || key.id !== id) return false;
  const age = click.timeStamp - key.at;
  return age >= 0 && age < KEY_WINDOW_MS;
}

export type Action = "uninstall" | "closeAtlas" | "retry" | "close";

export interface Screen {
  line: string;
  primary: { label: string; action: Action } | null;
  /** The saved-data box (and its one-line promise) is offered: only when asking to remove Atlas. */
  dataBox: boolean;
  /** The X works (never in the middle of the work). */
  closable: boolean;
}

/** The "Put Atlas on the desktop" box: offered the whole time Setup installs, so it can be ticked
 * while the install runs (and even just after: it applies at once then). Never while removing. */
export function desktopBoxShown(s: Snapshot): boolean {
  return s.mode === "install";
}

/** Whether the remover's data box was ticked; only the uninstall screens use it. */
export function screenFor(s: Snapshot, removeData = false): Screen {
  const none = { primary: null, dataBox: false };
  if (s.mode === "uninstall") {
    switch (s.phase) {
      case "ready":
        return { line: "Remove Atlas from this computer?", primary: { label: "Uninstall", action: "uninstall" }, dataBox: true, closable: true };
      case "closeAtlas":
      case "installing": {
        const line = s.stage === "closing" ? "Closing Atlas" : s.stage === "data" ? "Removing saved data" : "Removing Atlas";
        return { line, ...none, closable: false };
      }
      case "done":
        return {
          line: !removeData
            ? "Atlas is removed.\nYour saved data is kept."
            : s.dataKept
              ? "Atlas is removed.\nSome saved data is kept."
              : "Atlas is removed.",
          primary: { label: "Close", action: "close" },
          dataBox: false,
          closable: true,
        };
      case "error":
        return { line: s.error ?? "Something went wrong.", primary: { label: "Retry", action: "retry" }, dataBox: false, closable: true };
    }
  }
  switch (s.phase) {
    // Installing starts by itself; "ready" is only the instant before the first report.
    case "ready":
      return { line: "Getting ready", ...none, closable: false };
    case "closeAtlas":
      return { line: "Atlas is open.", primary: { label: "Close Atlas and continue", action: "closeAtlas" }, dataBox: false, closable: true };
    case "installing": {
      // The install's own step is the line; the chats being read ride along under it.
      const reading = stillReading(s.reading);
      const counts = `Reading your sessions: ${compact(s.reading.done)} of ${compact(s.reading.total)}`;
      const step = s.stage === "unpack" ? "Unpacking" : s.stage === "opening" ? "Opening Atlas" : "Installing Atlas";
      return { line: `${step}${reading && s.stage !== "opening" ? `\n${counts}` : ""}`, ...none, closable: false };
    }
    case "done":
      // The window plays its spark and eases out on its own as Atlas opens.
      return { line: "All set.", ...none, closable: false };
    case "error":
      return { line: s.error ?? "Something went wrong.", primary: { label: "Retry", action: "retry" }, dataBox: false, closable: true };
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
