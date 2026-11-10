import { useCallback, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./motion";

/**
 * How long a sheet takes to leave: `--dur-close` in tokens.css (inside the 150 to 200 ms a close
 * should take), the same value the exit animation runs on. With reduced motion a close is a short
 * fade, never a slide: `--dur-close-reduced`. These are the fallbacks when the stylesheet is not
 * there (tests) and what the tests time against.
 */
export const CLOSE_MS = 180;
export const CLOSE_REDUCED_MS = 120;

/** A `<time>ms` or `<time>s` token read off the root, or the fallback when it is missing or odd. */
function tokenMs(name: string, fallback: number): number {
  if (typeof getComputedStyle !== "function") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = /^(\d*\.?\d+)(ms|s)$/.exec(raw);
  if (!m) return fallback;
  const n = Number(m[1]) * (m[2] === "s" ? 1000 : 1);
  return Number.isFinite(n) ? n : fallback;
}

/** The time a close takes right now, as the stylesheet has it. */
export function closeMs(): number {
  return prefersReducedMotion() ? tokenMs("--dur-close-reduced", CLOSE_REDUCED_MS) : tokenMs("--dur-close", CLOSE_MS);
}

/**
 * A close that plays out before the thing unmounts. `requestClose` marks the element as leaving
 * (render `data-closing` on it, which `.sheet-enter[data-closing]` and `.fade-in[data-closing]`
 * animate out) and calls `onClose` once the exit has had its time; a second request while it
 * is leaving does nothing. The caller still owns the unmount: `onClose` is its own close, unchanged.
 * Once `onClose` has run the hook is back at rest: a sheet the caller keeps mounted (or re-uses for
 * another item) is visible and closable again, never stuck invisible with its focus trap live.
 * A sheet that shows one item at a time is still keyed by the item, so a close started on one
 * never lands on the next.
 */
export function useClosing(onClose: () => void): { closing: boolean; requestClose: () => void } {
  const [closing, setClosing] = useState(false);
  const latest = useRef(onClose);
  latest.current = onClose;
  const timer = useRef(0);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
    },
    [],
  );
  const requestClose = useCallback(() => {
    if (timer.current) return;
    setClosing(true);
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      latest.current();
      if (mounted.current) setClosing(false);
    }, closeMs());
  }, []);
  return { closing, requestClose };
}
