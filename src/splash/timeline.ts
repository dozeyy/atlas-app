// The launch intro's clock: the single source for every time and curve in it.
// All values are milliseconds from the first splash frame. Only transform and
// opacity are animated (compositor-driven, no layout, no paint).

/** Out-and-back with a little overshoot: the burst and the dot's pop. */
export const EASE_BURST = "cubic-bezier(0.16, 0.9, 0.24, 1)";
export const EASE_SETTLE = "cubic-bezier(0.4, 0, 0.2, 1)";
/** The swirl: slow in, fast through the middle, slow out. */
export const EASE_SWIRL = "cubic-bezier(0.65, 0, 0.3, 1)";
/** The boom: instant punch that eases off. */
export const EASE_BOOM = "cubic-bezier(0.14, 0.86, 0.2, 1)";
/** The clay screen floods out: quick start, soft landing. */
export const EASE_FLOOD = "cubic-bezier(0.5, 0.05, 0.25, 1)";
/** The clay halves slide away. */
export const EASE_SPLIT = "cubic-bezier(0.76, 0, 0.24, 1)";

export const T = {
  /** Arms burst out of the center, staggered in this order (clockwise from the top arm). */
  burst: { dur: 340, stagger: [0, 40, 80, 110, 135] as readonly number[] },
  /** The dot pops last. */
  dot: { at: 250, dur: 250 },
  /** Everything fills together on one curve. */
  fill: { at: 500, dur: 400 },
  /** The mark swirls: rotate + shrink, with trailing ghosts. */
  swirl: { at: 900, dur: 500, turn: -270, scale: 0.72 },
  /** Ghost trails lag the mark by these delays. */
  ghosts: [{ lag: 32, alpha: 0.34 }, { lag: 64, alpha: 0.2 }, { lag: 96, alpha: 0.1 }],
  /** Boom: the mark punches out, then the flood covers the window in flat clay. */
  boom: { at: 1400, dur: 160, scale: 1.7, extraTurn: -28 },
  flood: { at: 1400, dur: 200 },
  /** Clay halves slide apart to show the app; the app lands from `appFrom`. */
  split: { dur: 520 },
  appIn: { dur: 560, from: 0.96 },
  /** Reduced motion: the mark fades in, then the app replaces it with a fade. */
  reduced: { fade: 150 },
} as const;

/** When the clay screen is complete. */
export const CLAY_AT = T.flood.at + T.flood.dur;

/** Designed total, first frame to the app settled, with ~70 ms for the handoff. */
export const DESIGNED_TOTAL = CLAY_AT + 70 + Math.max(T.split.dur, T.appIn.dur);

/** The frame-timing numbers the intro reports to Rust. */
export interface FrameReport {
  frames: number;
  worstMs: number;
  over20: number;
  over33: number;
  p95Ms: number;
  totalMs: number;
}

export function summarizeFrames(deltas: readonly number[], totalMs: number): FrameReport {
  const sorted = [...deltas].sort((a, b) => a - b);
  return {
    frames: deltas.length,
    worstMs: sorted.length ? sorted[sorted.length - 1] : 0,
    over20: deltas.filter((d) => d > 20).length,
    over33: deltas.filter((d) => d > 33).length,
    p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0,
    totalMs,
  };
}
