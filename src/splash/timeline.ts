// The launch intro's clock: the single source for every time and curve in it.
// All values are milliseconds from the first splash frame. Only transform and
// opacity are animated (compositor-driven, no layout, no paint).

/** Out-and-back with a little overshoot: the burst and the dot's pop. */
export const EASE_BURST = "cubic-bezier(0.16, 0.9, 0.24, 1)";
export const EASE_SETTLE = "cubic-bezier(0.4, 0, 0.2, 1)";
/** The spin builds speed: slow start, fast by the time the disc has formed. */
export const EASE_SPIN_IN = "cubic-bezier(0.55, 0.085, 0.68, 0.53)";
/** The spin keeps going and settles: it picks up at the speed the build-up ended on. */
export const EASE_SPIN_OUT = "cubic-bezier(0.12, 0.6, 0.3, 1)";
/** The ripple rolls out fast and settles at the window edge. */
export const EASE_RIPPLE = "cubic-bezier(0.3, 0.55, 0.35, 1)";
/** The hole opens: the ripple's curve played backwards (slow start, quick finish). */
export const EASE_WIPE: readonly [number, number, number, number] = [0.65, 0, 0.7, 0.45];

/** A CSS cubic-bezier as a function of time (0..1) -> progress (0..1). The wipe draws its own
 *  frames, so it needs the curve in code. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sy = (u: number) => ((ay * u + by) * u + cy) * u;
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 8; i++) {
      const err = sx(u) - t;
      if (Math.abs(err) < 1e-6) return sy(u);
      const d = dx(u);
      if (Math.abs(d) < 1e-6) break;
      u -= err / d;
    }
    let lo = 0;
    let hi = 1;
    u = t;
    for (let i = 0; i < 24; i++) {
      const x = sx(u);
      if (Math.abs(x - t) < 1e-6) break;
      if (x < t) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return sy(u);
  };
}

/** Radius of the solid disc the trails form, in mark-art units: the arm tips reach 569 and
 *  the dot's outer edge 617 from the mark's center (measured on atlas-mark-1024.png). */
export const DISC_R = 610;

export const T = {
  /** Arms burst out of the center, staggered in this order (clockwise from the top arm). */
  burst: { dur: 340, stagger: [0, 40, 80, 110, 135] as readonly number[] },
  /** The dot pops last. */
  dot: { at: 250, dur: 250 },
  /** Everything fills together on one curve. */
  fill: { at: 500, dur: 400 },
  /** The mark spins up (turn1 in dur1 ms, speeding up), then keeps turning and settles (turn2 in
   *  dur2). The two curves meet at the same speed, so there is no kink. */
  spin: { at: 860, dur1: 380, turn1: -300, dur2: 440, turn2: -102 },
  /** Trails: `count` copies of the mark follow the spin, each a little later than the one
   *  before (up to `lagMax` ms), each see-through. Where they overlap near the arm they are
   *  nearly solid, and they thin out toward the tail: the gradient. As the spin speeds up the
   *  copies spread wider until they close the gaps between the arms. */
  trail: { count: 28, lagMax: 112, alpha: 0.12, fadeIn: 70 },
  /** The spinning mark itself turns a lighter clay, so the spin stays readable on the disc. */
  lead: { at: 1000, dur: 240 },
  /** The solid disc behind the trails (arm-tip radius) fades in as they close up. */
  core: { at: 1120, dur: 200 },
  /** Ripple: `rings` nested discs of slightly different clay roll out from the disc's rim,
   *  one after the other; the last one is the flat clay that fills the window. */
  ripple: { at: 1240, dur: 320, stagger: 40, rings: 4 },
  /** The spinning mark fades into the clay while the ripple passes it. */
  markFade: { at: 1440, dur: 240 },
  /** Clay halves slide apart to show the app; the app lands from `appFrom`. */
  /** Wipe: a hole opens in the flat clay from the middle (a soft rim of `feather` px with a
   *  lighter ring in it) and grows until the clay is gone; the app lands from `from` inside it. */
  wipe: { dur: 460, feather: 30 },
  appIn: { dur: 480, from: 0.98 },
  /** Reduced motion: the mark fades in, then the app replaces it with a fade. */
  reduced: { fade: 150 },
} as const;

/** When the clay screen is complete. */
export const CLAY_AT = T.ripple.at + (T.ripple.rings - 1) * T.ripple.stagger + T.ripple.dur;

/** Designed total, first frame to the app settled, with ~70 ms for the handoff. */
export const DESIGNED_TOTAL = CLAY_AT + 70 + Math.max(T.wipe.dur, T.appIn.dur);

/** The frame-timing numbers the intro reports to Rust. */
export interface FrameReport {
  frames: number;
  worstMs: number;
  /** When the worst frame landed, ms after the first sampled frame. */
  worstAtMs: number;
  /** The gap between the first two frames: the animations start on the second, nothing is
   *  moving yet, and the compositor settles the animated layers here. Not counted in the rest. */
  startMs: number;
  over20: number;
  over33: number;
  p95Ms: number;
  totalMs: number;
}

export function summarizeFrames(deltas: readonly number[], totalMs: number, startMs = 0): FrameReport {
  const sorted = [...deltas].sort((a, b) => a - b);
  let worstAtMs = 0;
  let elapsed = 0;
  let worst = -1;
  for (const d of deltas) {
    elapsed += d;
    if (d > worst) {
      worst = d;
      worstAtMs = elapsed;
    }
  }
  return {
    frames: deltas.length,
    worstMs: sorted.length ? sorted[sorted.length - 1] : 0,
    worstAtMs,
    startMs,
    over20: deltas.filter((d) => d > 20).length,
    over33: deltas.filter((d) => d > 33).length,
    p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0,
    totalMs,
  };
}
