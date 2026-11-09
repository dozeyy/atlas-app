import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { ReactNode, RefObject } from "react";
import { prefersReducedMotion } from "../../lib/motion";
import { clamp01 } from "../../lib/wrappedClock";
import type { Beat } from "../../lib/wrappedClock";
import { TIMELINES } from "../../lib/wrappedPoster";
import type { Mood } from "../../lib/wrappedPoster";

// One clock per poster. A single requestAnimationFrame loop walks t from 0 to 1 over the mood's
// timeline, and every moving piece (the figure's digits, the hero's bars, the strip) registers a
// function of t with useTick. They write straight to style.transform / opacity: React state never
// changes per frame, so a poster costs one rAF callback however many pieces it has.

export interface ClockCtx {
  beats: readonly Beat[];
  ms: number;
  mood: Mood;
  /** The latest t, for a piece that mounts late. */
  t: RefObject<number>;
  subscribe: (fn: (t: number) => void) => () => void;
}

const Ctx = createContext<ClockCtx | null>(null);

export function useClockCtx(): ClockCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTick needs a ClockProvider above it");
  return c;
}

/** The longest a frame may count for. A stalled tab then resumes where it was instead of jumping. */
const MAX_DT = 64;

export function ClockProvider({
  mood,
  delay = 0,
  frozen = false,
  paused = false,
  onFrame,
  runRef,
  children,
}: {
  mood: Mood;
  /** ms to wait before t starts to move (the colour wipe is still crossing the card). */
  delay?: number;
  /** A card that is only being looked at (the one going out): t = 1, no loop. */
  frozen?: boolean;
  /** Hold: t stops where it is. */
  paused?: boolean;
  onFrame?: (t: number) => void;
  /** The element that gets data-run while t is moving (so will-change is only held while animating). */
  runRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const tl = TIMELINES[mood];
  const subs = useRef(new Set<(t: number) => void>());
  const tRef = useRef(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const frameRef = useRef(onFrame);
  frameRef.current = onFrame;

  const ctx = useMemo<ClockCtx>(
    () => ({
      beats: tl.beats,
      ms: tl.ms,
      mood,
      t: tRef,
      subscribe(fn) {
        subs.current.add(fn);
        fn(tRef.current);
        return () => {
          subs.current.delete(fn);
        };
      },
    }),
    [tl, mood],
  );

  useLayoutEffect(() => {
    const emit = (t: number) => {
      tRef.current = t;
      subs.current.forEach((f) => f(t));
      frameRef.current?.(t);
    };
    const run = (on: boolean) => {
      const el = runRef?.current;
      if (!el) return;
      if (on) el.setAttribute("data-run", "");
      else el.removeAttribute("data-run");
    };
    if (
      frozen ||
      prefersReducedMotion() ||
      typeof requestAnimationFrame === "undefined"
    ) {
      emit(1);
      run(false);
      return;
    }
    emit(0);
    run(true);
    let raf = 0;
    let elapsed = -delay;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      if (!pausedRef.current) elapsed += Math.min(dt, MAX_DT);
      const t = clamp01(elapsed / tl.ms);
      emit(t);
      if (t < 1) raf = requestAnimationFrame(tick);
      else run(false);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      run(false);
    };
  }, [frozen, delay, tl, runRef]);

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

/** Register `fn` to be called with t on every frame (and once at once, so the first paint is the start pose). */
export function useTick(fn: (t: number, ctx: ClockCtx) => void): void {
  const ctx = useClockCtx();
  const ref = useRef(fn);
  ref.current = fn;
  useLayoutEffect(() => ctx.subscribe((t) => ref.current(t, ctx)), [ctx]);
}
