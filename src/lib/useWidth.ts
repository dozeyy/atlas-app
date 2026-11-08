import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

/**
 * The measured width of an element, kept current. 0 until it is measured (and always in jsdom,
 * which has no layout), so callers pick the wide layout when they see 0.
 */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => setW(Math.round(el.getBoundingClientRect().width));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
