import { useLayoutEffect, type RefObject } from "react";

/**
 * Sets `--sb` on a scroll pane to the width of its own vertical scrollbar (whatever that is on
 * this system). A `.lift-room` pane (and the Sessions list) grows by that much on the right so
 * the bar sits in the page gutter and the cards end exactly where the toolbar above them ends,
 * with or without a scrollbar.
 *
 * Measured once on mount and again whenever the pane's content box changes size: a scrollbar
 * appearing or leaving narrows or widens that box, so the observer sees it. No layout read on
 * every render.
 */
export function useScrollbarVar(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.offsetWidth === 0) return;
      const bar = `${el.offsetWidth - el.clientWidth}px`;
      if (el.style.getPropertyValue("--sb") !== bar) el.style.setProperty("--sb", bar);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el, { box: "content-box" });
    return () => ro.disconnect();
  }, [ref]);
}
