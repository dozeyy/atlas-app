/** A box on screen: only its edges matter here. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The space kept between the pile and the control it rises over. */
const GAP = 8;

/**
 * How far the toast pile must rise so it lies over no control of the open sheet or dialog.
 * `pile` is where the pile rests with no lift, `controls` are the buttons and fields of the sheet,
 * `ceiling` is the top of the sheet. The pile rises, nothing under it moves: a button you are
 * about to press again stays where it was.
 *
 * It goes up to just over the highest control it would cover, and again if that lands on another
 * one. With no free band below the ceiling it settles for the first rise: clear of the bottom
 * action row, which is the one that matters.
 */
export function liftOver(pile: Box, controls: readonly Box[], ceiling: number): number {
  const beside = controls.filter((c) => c.right > pile.left && c.left < pile.right && c.bottom > c.top);
  let lift = 0;
  let first = 0;
  for (let round = 0; round < 8; round++) {
    const hit = beside.filter((c) => c.top < pile.bottom - lift && c.bottom > pile.top - lift);
    if (hit.length === 0) return lift;
    lift = pile.bottom - Math.min(...hit.map((c) => c.top)) + GAP;
    if (round === 0) first = lift;
    if (pile.top - lift < ceiling + GAP) return first;
  }
  return first;
}
