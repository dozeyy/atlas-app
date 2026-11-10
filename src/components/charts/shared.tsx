import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/** Width used before the first measure, and in jsdom where nothing has a size. */
export const FALLBACK_WIDTH = 640;

/** The element's content width, kept current with a ResizeObserver. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const w = Math.round(el.clientWidth);
      if (w > 0) setWidth((prev) => (prev === w ? prev : w));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width > 0 ? width : FALLBACK_WIDTH];
}

/** What a chart says about the thing under the pointer (or the focused item). */
export interface Readout {
  title: string;
  valueText: string;
  detail: string;
}

/** One chart item, in the shape every chart tooltip speaks (three lines). */
export interface BarDatum extends Readout {
  key: string;
  value: number;
  /** Short x-axis label, shown on some bars only. */
  axis: string;
}

/**
 * Which bar earns the summit spark, or -1 for none. The spark marks a peak, so it is planted only
 * when one bar clearly stands over the rest: at least three bars have something in them, the top
 * one is at least half again a typical bar (the median), and no other bar comes within 5% of it.
 * Level bars, a tie at the top or a lone bar get no spark.
 */
export function clearPeak(values: number[]): number {
  let at = -1;
  values.forEach((v, i) => {
    if (v > 0 && (at < 0 || v > values[at])) at = i;
  });
  if (at < 0) return -1;
  const top = values[at];
  const live = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (live.length < 3) return -1;
  const median = live[Math.floor((live.length - 1) / 2)];
  const runnerUp = live[live.length - 2];
  return top >= median * 1.5 && runnerUp <= top * 0.95 ? at : -1;
}

/** Left/Right/Home/End/Escape over `n` items; Up/Down jump by `jump` (the heat grid uses 7). */
export function stepIndex(key: string, at: number | null, n: number, jump = 0): number | null | undefined {
  if (n === 0) return undefined;
  const base = at ?? (key === "ArrowLeft" || key === "End" ? n : -1);
  switch (key) {
    case "ArrowRight":
      return Math.min(n - 1, base + 1);
    case "ArrowLeft":
      return Math.max(0, base - 1);
    case "ArrowDown":
      return jump ? Math.min(n - 1, base + jump) : undefined;
    case "ArrowUp":
      return jump ? Math.max(0, base - jump) : undefined;
    case "Home":
      return 0;
    case "End":
      return n - 1;
    case "Escape":
      return null;
    default:
      return undefined;
  }
}
