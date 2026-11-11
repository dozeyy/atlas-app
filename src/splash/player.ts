// A frame-by-frame player for the splash's keyframes: the same keyframes and options the Web
// Animations API takes (transform scale/rotate and opacity, per-keyframe or whole-run cubic-bezier
// easing, delay, fill both), evaluated in a requestAnimationFrame loop and written to the
// element's style.
//
// Why it exists: on macOS (WKWebView) the splash's Web Animations ran on the page but never reached
// the screen. Recorded on a GitHub macOS runner (mac-check intro_only, 2026-11-10): the page logged
// the clay screen 165 ms after the timeline started while the window kept showing the mark's
// un-animated first frame, until the watchdog closed it. Plain style writes each frame do reach the
// screen there, so macOS plays the intro with this. Windows keeps the Web Animations API.
//
// The clock starts on the first frame after `start()`, and a late frame (the window server busy,
// the machine stalled) holds the timeline back instead of letting it jump ahead: the intro may run
// a little longer, it never skips a beat.

import { cubicBezier } from "./timeline";

type Ease = (t: number) => number;

const linear: Ease = (t) => t;

/** "linear" or "cubic-bezier(a, b, c, d)" as a function; anything else is linear. */
export function parseEasing(e: string | undefined): Ease {
  if (!e || e === "linear") return linear;
  const m = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/.exec(e.trim());
  return m ? cubicBezier(+m[1], +m[2], +m[3], +m[4]) : linear;
}

/** A transform the splash animates ("scale(1.06)", "rotate(-300deg)") or an opacity. */
interface Value {
  fn: string;
  n: number;
  unit: string;
}

function parseValue(v: unknown): Value {
  if (typeof v === "number") return { fn: "", n: v, unit: "" };
  const s = String(v).trim();
  const m = /^([a-zA-Z]+)\(\s*([-\d.]+)([a-z%]*)\s*\)$/.exec(s);
  if (m) return { fn: m[1], n: +m[2], unit: m[3] };
  return { fn: "", n: Number(s) || 0, unit: "" };
}

const format = (v: Value, n: number) => (v.fn ? `${v.fn}(${n}${v.unit})` : String(n));

interface Stop {
  offset: number;
  value: Value;
  ease: Ease;
}

interface Track {
  el: HTMLElement;
  prop: "transform" | "opacity";
  stops: Stop[];
  delay: number;
  duration: number;
  whole: Ease;
  done: () => void;
  ended: boolean;
}

/** What `run` returns: enough of an Animation for the splash (it only awaits `finished`). */
export interface PlayerAnimation {
  finished: Promise<unknown>;
  playState: string;
  currentTime: CSSNumberish | null;
}

/** The value of a track `ms` after the player's start (fill both). */
export function sample(stops: readonly Stop[], whole: Ease, delay: number, duration: number, ms: number): number {
  const p = duration <= 0 ? 1 : Math.min(1, Math.max(0, (ms - delay) / duration));
  const t = whole(p);
  if (t <= stops[0].offset) return stops[0].value.n;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (t <= b.offset) {
      const span = b.offset - a.offset;
      const local = span <= 0 ? 1 : a.ease((t - a.offset) / span);
      return a.value.n + (b.value.n - a.value.n) * local;
    }
  }
  return stops[stops.length - 1].value.n;
}

export function toStops(keyframes: readonly Keyframe[], prop: "transform" | "opacity"): Stop[] {
  const n = keyframes.length;
  return keyframes.map((k, i) => ({
    offset: typeof k.offset === "number" ? k.offset : n === 1 ? 1 : i / (n - 1),
    value: parseValue(k[prop]),
    ease: parseEasing(typeof k.easing === "string" ? k.easing : undefined),
  }));
}

/** Frames later than this hold the timeline back by the excess. */
const MAX_STEP_MS = 34;

export class SplashPlayer {
  private tracks: Track[] = [];
  private started = false;
  private elapsed = 0;
  private last = 0;
  private running = false;

  /** Same arguments as `Element.animate` (the subset the splash uses). Plays from `start()`. */
  run(el: Element, keyframes: Keyframe[], opts: KeyframeAnimationOptions): PlayerAnimation {
    const prop = "transform" in keyframes[0] ? "transform" : "opacity";
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const track: Track = {
      el: el as HTMLElement,
      prop,
      stops: toStops(keyframes, prop),
      delay: typeof opts.delay === "number" ? opts.delay : 0,
      duration: typeof opts.duration === "number" ? opts.duration : 0,
      whole: parseEasing(typeof opts.easing === "string" ? opts.easing : undefined),
      done,
      ended: false,
    };
    this.tracks.push(track);
    // fill: both: the first keyframe applies before the run starts.
    this.apply(track, 0);
    // A track added after the start (the reduced-motion fade) starts from now.
    if (this.started) {
      track.delay += this.elapsed;
      if (!this.running) this.loop();
    }
    const self = this;
    return {
      finished,
      get playState() {
        return track.ended ? "finished" : "running";
      },
      get currentTime() {
        return self.started ? self.elapsed - track.delay : null;
      },
    };
  }

  private apply(t: Track, ms: number) {
    const v = sample(t.stops, t.whole, t.delay, t.duration, ms);
    t.el.style[t.prop] = format(t.stops[0].value, Math.round(v * 10000) / 10000);
  }

  /** Start the clock on the next frame. */
  start() {
    if (this.running || this.started) return;
    this.loop();
  }

  private loop() {
    this.running = true;
    requestAnimationFrame((now) => {
      this.started = true;
      this.last = now;
      this.tick(now);
    });
  }

  private tick = (now: number) => {
    const step = now - this.last;
    this.last = now;
    this.elapsed += Math.min(step, MAX_STEP_MS);
    let live = false;
    for (const t of this.tracks) {
      if (t.ended) continue;
      this.apply(t, this.elapsed);
      if (this.elapsed >= t.delay + t.duration) {
        t.ended = true;
        t.done();
      } else live = true;
    }
    if (live) requestAnimationFrame(this.tick);
    else this.running = false;
  };
}
