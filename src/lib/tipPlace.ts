/** Where the tooltip goes. Pure, so it is easy to test: no DOM, only boxes. */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface Size {
  w: number;
  h: number;
}
export type Side = "below" | "above" | "point";
export interface Placement {
  x: number;
  y: number;
  side: Side;
  /** Where the little arrow sits, in px from the tip's left edge. */
  caret: number;
}

export const GAP = 8; // between the thing and the tip
export const EDGE = 8; // the tip never gets closer than this to the window edge
const CARET_INSET = 14;

/**
 * Below the target when it fits, else above, else (a target as tall as the window) beside the
 * pointer. The tip is centered on the target and slid back inside the window; the arrow keeps
 * pointing at the target's center however far the tip slid.
 */
export function place(target: Box, tip: Size, view: Size, pointer: { x: number; y: number }): Placement {
  const cx = (target.left + target.right) / 2;
  const maxX = Math.max(EDGE, view.w - EDGE - tip.w);
  const clampX = (x: number) => Math.min(Math.max(x, EDGE), maxX);
  const roomBelow = view.h - EDGE - (target.bottom + GAP);
  const roomAbove = target.top - GAP - EDGE;

  let side: Side;
  if (roomBelow >= tip.h) side = "below";
  else if (roomAbove >= tip.h) side = "above";
  else side = "point";

  if (side === "point") {
    // Neither side has room: sit next to the pointer, kept inside the window.
    const x = clampX(pointer.x + 14);
    const y = Math.min(Math.max(pointer.y + 18, EDGE), Math.max(EDGE, view.h - EDGE - tip.h));
    return { x, y, side, caret: CARET_INSET };
  }

  // A wide target (a card, a whole row): follow the pointer's column, not the far-off center,
  // so the tip appears near where the person is looking.
  const wide = target.right - target.left > tip.w * 2;
  const anchor = wide ? Math.min(Math.max(pointer.x, target.left), target.right) : cx;
  const x = clampX(anchor - tip.w / 2);
  const y = side === "below" ? target.bottom + GAP : target.top - GAP - tip.h;
  const caret = Math.min(Math.max(anchor - x, CARET_INSET), Math.max(CARET_INSET, tip.w - CARET_INSET));
  return { x, y, side, caret };
}
