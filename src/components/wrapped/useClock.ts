import { useLayoutEffect, useRef } from "react";
import { prefersReducedMotion } from "../../lib/motion";

/**
 * Runs one slide's clock: t goes 0 -> 1 over `ms`, after `delay` ms, and `apply(t)` is called on
 * every frame. `apply` writes straight to the DOM (style / attributes); no React state changes
 * per frame. Reduced motion (or no animation frames) applies t = 1 once. The last call is always t = 1.
 */
export function useClock(ms: number, delay: number, apply: (t: number) => void): void {
  const fn = useRef(apply);
  fn.current = apply;
  useLayoutEffect(() => {
    if (prefersReducedMotion() || typeof requestAnimationFrame === "undefined") {
      fn.current(1);
      return;
    }
    fn.current(0);
    let raf = 0;
    const t0 = performance.now() + delay;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - t0) / ms));
      fn.current(t);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ms, delay]);
}
