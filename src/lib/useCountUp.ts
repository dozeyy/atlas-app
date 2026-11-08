import { useEffect, useRef, useState } from "react";
import { hasPlayed, markPlayed, prefersReducedMotion } from "./motion";

const DURATION_MS = 700;

/** easeOutExpo: fast start, long soft landing. */
export function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - 2 ** (-10 * t);
}

/**
 * Eases a shown number toward `target` over 700 ms.
 *  - First show of `id` in this launch: from 0. After that the number simply appears, so
 *    coming back to a page never replays it.
 *  - A later change starts from what is showing now; a change under 1 % just lands.
 *  - Reduced motion: no counting at all.
 * `running` is true while the shown number differs from the target.
 */
export function useCountUp(target: number, id?: string): { value: number; running: boolean } {
  const [first] = useState(() => !!id && !hasPlayed(`count:${id}`) && !prefersReducedMotion() && target !== 0);
  const [shown, setShown] = useState(first ? 0 : target);
  const from = useRef(shown);
  const raf = useRef(0);
  const firstRun = useRef(first);

  useEffect(() => {
    if (id) markPlayed(`count:${id}`);
    const origin = from.current;
    const small = Math.abs(target - origin) < Math.abs(target) * 0.01;
    const animate = !prefersReducedMotion() && (firstRun.current || !small) && origin !== target;
    firstRun.current = false;
    if (!animate) {
      from.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / DURATION_MS);
      const v = origin + (target - origin) * easeOutExpo(p);
      from.current = v;
      setShown(v);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, id]);

  return { value: shown, running: shown !== target };
}
