// The Wrapped clock. One progress value t (0..1) runs per slide; every moving piece is a pure
// function of t (seg + an easing), so pieces that look linked cannot disagree: the hand of a dial
// and the arcs it draws are both read from the same eased value. The timeline is data: a list of
// beats { id, start, end, ease }. Nothing here touches the DOM (useClock.ts does the writing).

export type EaseName =
  | "linear"
  | "outCubic"
  | "outQuart"
  | "inQuad"
  | "inOutCubic"
  | "outBack"
  | "spring"
  | "steps12"
  | "steps24"
  | "steps8"
  | "pulse";
export type Ease = (x: number) => number;

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Progress of t through the window [a, b]: 0 before it, 1 after it, linear between. */
export function seg(t: number, a: number, b: number): number {
  if (b <= a) return t >= b ? 1 : 0;
  return clamp01((t - a) / (b - a));
}

/**
 * A damped spring step response sampled once (so a frame is a lookup, not a solve). It swings past
 * 1 by about 8% once, then settles: a number that lands, never one that wobbles.
 */
function springSamples(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    out.push(1 - Math.exp(-5.6 * x) * Math.cos(7 * x));
  }
  out[n] = 1;
  return out;
}
const SPRING = springSamples(120);

export const EASES: Record<EaseName, Ease> = {
  linear: (x) => clamp01(x),
  outCubic: (x) => 1 - (1 - clamp01(x)) ** 3,
  /** A hard start that glides in and stops dead: a hand that lands and stays. */
  outQuart: (x) => 1 - (1 - clamp01(x)) ** 4,
  /** Gravity: slow off the line, fastest at the floor (the landing is a separate squash). */
  inQuad: (x) => clamp01(x) ** 2,
  inOutCubic: (x) => {
    const k = clamp01(x);
    return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
  },
  /** A fast overshoot that settles: for numbers that slam in. */
  outBack: (x) => {
    const k = clamp01(x) - 1;
    return 1 + 2.70158 * k * k * k + 1.70158 * k * k;
  },
  /** The sampled spring: overshoots a little more than once, lands on 1. */
  spring: (x) => {
    const k = clamp01(x) * 120;
    const i = Math.min(119, Math.floor(k));
    return SPRING[i] + (SPRING[i + 1] - SPRING[i]) * (k - i);
  },
  /** Twelve ticks, like a clock hand that steps. */
  steps12: (x) => Math.floor(clamp01(x) * 12) / 12,
  /** Twenty-four ticks: a second hand, or a scan across 24 hours. */
  steps24: (x) => Math.floor(clamp01(x) * 24) / 24,
  /** Eight ticks, a coarser tick for a typed line. */
  steps8: (x) => Math.floor(clamp01(x) * 8) / 8,
  /** 0 -> 1 -> 0 once: a pulse. */
  pulse: (x) => Math.sin(clamp01(x) * Math.PI),
};

export interface Beat {
  id: string;
  /** Where in t (0..1) it starts and ends. */
  start: number;
  end: number;
  ease: EaseName;
}

/** The eased progress of one beat at time t. */
export function beatAt(beats: readonly Beat[], id: string, t: number): number {
  const b = beats.find((x) => x.id === id);
  if (!b) throw new Error(`no beat called ${id}`);
  return EASES[b.ease](seg(t, b.start, b.end));
}

/** Milliseconds a timeline of `ms` takes to reach t. */
export const timeAt = (ms: number, t: number): number => ms * t;

// ---- pieces: one beat shared by several things that follow each other -------------------------

/** One step between neighbours in a stagger, in ms: 30 to 60 by the brief; the whole fan stays under STAGGER_TOTAL_MS. */
export const STAGGER_MS = 45;
export const STAGGER_TOTAL_MS = 600;

/**
 * Piece i of n inside a beat: its own window [a, b] in t. The pieces start STAGGER_MS apart (less
 * when there are many, so the whole fan stays under STAGGER_TOTAL_MS and never past half the beat)
 * and every window is the same length, so the last piece ends where the beat does and the others
 * land one after another.
 */
export function pieceWindow(
  beat: Beat,
  ms: number,
  i: number,
  n: number,
): [number, number] {
  const span = (beat.end - beat.start) * ms;
  const step =
    n > 1
      ? Math.min(
          STAGGER_MS,
          STAGGER_TOTAL_MS / (n - 1),
          (span * 0.55) / (n - 1),
        )
      : 0;
  const len = span - step * (n - 1);
  const a = beat.start * ms + step * i;
  return [a / ms, (a + len) / ms];
}
/** The eased progress of piece i of n in the beat called `id`. */
export function pieceAt(
  beats: readonly Beat[],
  id: string,
  t: number,
  ms: number,
  i: number,
  n: number,
): number {
  const b = beats.find((x) => x.id === id);
  if (!b) throw new Error(`no beat called ${id}`);
  const [a, z] = pieceWindow(b, ms, i, n);
  return EASES[b.ease](seg(t, a, z));
}

/** A one-off pulse (0 -> 1 -> 0) that starts the moment `t` passes `from` and lasts `dur` ms. */
export function pulseAfter(
  t: number,
  from: number,
  ms: number,
  dur: number,
): number {
  return EASES.pulse(seg(t, from, from + dur / ms));
}
