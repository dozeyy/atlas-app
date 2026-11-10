import { useCallback, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./motion";

/** How long a sheet takes to leave: inside the 150 to 200 ms a close should take. */
export const CLOSE_MS = 180;
/** With reduced motion a close is a short fade, never a slide. */
export const CLOSE_REDUCED_MS = 120;

/**
 * A close that plays out before the thing unmounts. `requestClose` marks the element as leaving
 * (render `data-closing` on it, which `.sheet-enter[data-closing]` and `.fade-in[data-closing]`
 * animate out) and calls `onClose` once the exit has had its time; a second request while it
 * is leaving does nothing. The caller still owns the unmount: `onClose` is its own close, unchanged.
 */
export function useClosing(onClose: () => void): { closing: boolean; requestClose: () => void } {
  const [closing, setClosing] = useState(false);
  const latest = useRef(onClose);
  latest.current = onClose;
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const requestClose = useCallback(() => {
    if (timer.current) return;
    setClosing(true);
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      latest.current();
    }, prefersReducedMotion() ? CLOSE_REDUCED_MS : CLOSE_MS);
  }, []);
  return { closing, requestClose };
}
