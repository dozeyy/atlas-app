import { useLayoutEffect, type RefObject } from "react";

/**
 * Sets `--sb` on a scroll pane to the width of its own vertical scrollbar (whatever that is on
 * this system), measured after every render. A `.lift-room` pane (and the Sessions list) grows
 * by that much on the right so the bar sits in the page gutter and the cards end exactly where
 * the toolbar above them ends, with or without a scrollbar.
 */
export function useScrollbarVar(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || el.offsetWidth === 0) return;
    const bar = `${el.offsetWidth - el.clientWidth}px`;
    if (el.style.getPropertyValue("--sb") !== bar) el.style.setProperty("--sb", bar);
  });
}
