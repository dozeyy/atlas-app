import { useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { EASES, pieceWindow, pulseAfter, seg } from "../../lib/wrappedClock";
import type { Mood } from "../../lib/wrappedPoster";
import type { HeroBox } from "../../lib/posterMath";
import type { ClockCtx } from "./clock";

// The small tools every hero graphic is built from: the pose a piece takes on each frame, the piece
// timing a mood gives it, and the SVG shell. Nothing here keeps state; a hero's useTick calls these
// and writes the result straight to the element's style.

export type El = SVGElement | HTMLElement;

export interface Pose {
  x?: number;
  y?: number;
  sx?: number;
  sy?: number;
  r?: number;
  o?: number;
}

/** Write a pose to an element's transform and opacity. The only per-frame DOM write a hero makes. */
export function put(el: El | null | undefined, p: Pose): void {
  if (!el) return;
  const s = el.style;
  const scaled = p.sx !== undefined || p.sy !== undefined;
  s.transform =
    `translate(${(p.x ?? 0).toFixed(2)}px,${(p.y ?? 0).toFixed(2)}px)` +
    (p.r ? ` rotate(${p.r.toFixed(2)}deg)` : "") +
    (scaled
      ? ` scale(${(p.sx ?? 1).toFixed(4)},${(p.sy ?? 1).toFixed(4)})`
      : "");
  if (p.o !== undefined) s.opacity = p.o.toFixed(3);
}

/** A list of element refs a tick can walk: `ref(i)` goes on the i-th element. */
export function useEls(): {
  els: RefObject<(El | null)[]>;
  ref: (i: number) => (e: El | null) => void;
} {
  const els = useRef<(El | null)[]>([]);
  const refs = useRef<Map<number, (e: El | null) => void>>(new Map());
  const ref = (i: number) => {
    let f = refs.current.get(i);
    if (!f) {
      f = (e: El | null) => {
        els.current[i] = e;
      };
      refs.current.set(i, f);
    }
    return f;
  };
  return { els, ref };
}

/** One element ref, as a pair that can be read in a tick. */
export function useEl(): {
  el: RefObject<El | null>;
  ref: (e: El | null) => void;
} {
  const el = useRef<El | null>(null);
  const ref = useRef((e: El | null) => {
    el.current = e;
  });
  return { el, ref: ref.current };
}

/**
 * The piece timing of the hero beat for this mood: `at(t, i, n)` is how far piece i of n has got
 * (`p`, eased the way the mood eases) and, for the heavy mood, how hard it is squashing after its
 * landing (`landed`, 0..1..0).
 */
export function pieces(ctx: ClockCtx, id = "hero") {
  const b = ctx.beats.find((x) => x.id === id);
  if (!b) throw new Error(`no beat called ${id}`);
  const ease = EASES[b.ease];
  const heavy = ctx.mood === "heavy";
  return (t: number, i: number, n: number): { p: number; landed: number } => {
    const [a, z] = pieceWindow(b, ctx.ms, i, n);
    return {
      p: ease(seg(t, a, z)),
      landed: heavy ? pulseAfter(t, z, ctx.ms, 240) : 0,
    };
  };
}

/** The raw eased value of a beat at t (for a piece that is not one of a crowd). */
export function beatValue(ctx: ClockCtx, id: string, t: number): number {
  const b = ctx.beats.find((x) => x.id === id);
  if (!b) throw new Error(`no beat called ${id}`);
  return EASES[b.ease](seg(t, b.start, b.end));
}

/** A bar or block arriving: it grows up from its base; in the heavy mood it drops from above and squashes on the floor. */
export function enter(mood: Mood, p: number, landed: number, drop = 320): Pose {
  if (mood === "heavy")
    return {
      y: -(1 - p) * drop,
      sx: 1 + 0.07 * landed,
      sy: 1 - 0.13 * landed,
      o: p > 0.003 ? 1 : 0,
    };
  return { sy: p, o: p > 0.003 ? 1 : 0 };
}

/** A free shape arriving: it pops up from nothing; in the heavy mood it drops and squashes. */
export function pop(mood: Mood, p: number, landed: number, drop = 280): Pose {
  if (mood === "heavy") return enter(mood, p, landed, drop);
  return { sx: p, sy: p, o: p > 0.003 ? 1 : 0 };
}

/** A ring that spreads once from the key piece and is gone: the pulse moods' one decisive beat. */
export function ripple(
  el: El | null | undefined,
  ctx: ClockCtx,
  t: number,
  dur = 800,
): void {
  const b = ctx.beats.find((x) => x.id === "pulse");
  if (!el || !b) return;
  const k = seg(t, b.start, b.start + dur / ctx.ms);
  put(el, {
    sx: 1 + 1.1 * k,
    sy: 1 + 1.1 * k,
    o: k > 0 && k < 1 ? 0.85 * (1 - k) : 0,
  });
}

export { star } from "../../lib/posterMath";

/** The SVG every hero draws into: design units, nothing clipped (the card does the clipping). */
export function HeroSvg({
  box,
  children,
}: {
  box: HeroBox;
  children: ReactNode;
}) {
  return (
    <svg
      className="pr-svg"
      viewBox={`0 0 ${box.fullW} ${box.h}`}
      width={box.fullW}
      height={box.h}
      aria-hidden="true"
      focusable="false"
    >
      <g transform={`translate(${box.ox} 0)`}>{children}</g>
    </svg>
  );
}

/** Rotate an element about a point with the SVG transform attribute (no CSS box to worry about). */
export function spin(
  el: El | null | undefined,
  deg: number,
  cx: number,
  cy: number,
): void {
  el?.setAttribute("transform", `rotate(${deg.toFixed(2)} ${cx} ${cy})`);
}

/** Scale an element about a point, also with the SVG transform attribute. */
export function scaleAbout(
  el: El | null | undefined,
  s: number,
  cx: number,
  cy: number,
): void {
  el?.setAttribute(
    "transform",
    `translate(${cx} ${cy}) scale(${Math.max(0, s).toFixed(4)}) translate(${-cx} ${-cy})`,
  );
}

export function fade(el: El | null | undefined, o: number): void {
  if (el) el.style.opacity = Math.max(0, Math.min(1, o)).toFixed(3);
}

/** Ease-out-quad step used where a label should arrive just after the shape it names. */
export const after = (p: number, from = 0.7): number =>
  Math.max(0, Math.min(1, (p - from) / (1 - from)));
