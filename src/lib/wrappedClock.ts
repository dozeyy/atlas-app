// The Wrapped clock. One progress value t (0..1) runs per slide; every moving piece is a pure
// function of t (seg + an easing), so pieces that look linked cannot disagree: the hand of a dial
// and the arcs it draws are both read from the same eased value. The timeline is data: a list of
// beats { id, start, end, ease }. Nothing here touches the DOM (useClock.ts does the writing).

export type EaseName = "linear" | "outCubic" | "inOutCubic" | "outBack" | "spring" | "steps12" | "pulse";
export type Ease = (x: number) => number;

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Progress of t through the window [a, b]: 0 before it, 1 after it, linear between. */
export function seg(t: number, a: number, b: number): number {
  if (b <= a) return t >= b ? 1 : 0;
  return clamp01((t - a) / (b - a));
}

/** A damped spring step response sampled once (so a frame is a lookup, not a solve). It overshoots, then settles on 1. */
function springSamples(n: number, damping = 0.42, cycles = 2.4): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    const v = 1 - Math.exp(-x * 7) * Math.cos(x * cycles * Math.PI * 2 * 0.5 * (1 + damping));
    out.push(v);
  }
  out[n] = 1;
  return out;
}
const SPRING = springSamples(120);

export const EASES: Record<EaseName, Ease> = {
  linear: (x) => clamp01(x),
  outCubic: (x) => 1 - (1 - clamp01(x)) ** 3,
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
