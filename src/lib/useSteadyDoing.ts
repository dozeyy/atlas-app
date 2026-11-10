// The calm rules of the Now tab, shared by the chat cards and the helper list. The live feed
// changes many times a second; shown raw, lines re-mounted and bars jumped and the page flickered.
// Here every change is shown at once as text, but only animates at most once per CALM_MS.

import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./motion";
import type { NowDoing } from "./nowTypes";

/** A tool's line stays up this long after the call ends, so back-to-back calls never blink to "Thinking". */
export const HOLD_MS = 1200;
/** At most one entrance, slide or fill move per this long per card or row: rapid calls just update in place. */
export const CALM_MS = 1000;

const doingId = (d: NowDoing) => `${d.kind}|${d.verb}|${d.target ?? ""}`;

/**
 * What the "doing" line shows. The live feed flips tool -> "Thinking" -> the same tool on every
 * call, many times a second when a script polls; shown raw, the line re-mounted and faded in each
 * time and the card flashed. Here a tool's line is held for HOLD_MS before "Thinking" replaces it,
 * and the swap animates (a new `swapKey`) at most once per CALM_MS; a faster change only swaps
 * the text in place.
 */
export function useSteadyDoing(live: NowDoing): { doing: NowDoing; swapKey: number } {
  const [shown, setShown] = useState({ doing: live, key: 0 });
  const lastSwap = useRef(0);
  const liveRef = useRef(live);
  liveRef.current = live;
  const liveId = doingId(live);
  const shownId = doingId(shown.doing);
  const shownKind = shown.doing.kind;
  useEffect(() => {
    if (liveId === shownId) return;
    const swap = () => {
      const t = performance.now();
      const animate = t - lastSwap.current >= CALM_MS;
      if (animate) lastSwap.current = t;
      setShown((prev) => ({ doing: liveRef.current, key: animate ? prev.key + 1 : prev.key }));
    };
    const fromTool = !["think", "wait", "ask"].includes(shownKind);
    if (liveRef.current.kind === "think" && fromTool) {
      const t = setTimeout(swap, HOLD_MS);
      return () => clearTimeout(t);
    }
    swap();
  }, [liveId, shownId, shownKind]);
  return { doing: shown.doing, swapKey: shown.key };
}

/** A helper's phase word stays up at least this long before the next one replaces it. */
export const PHASE_HOLD_MS = 2000;

/**
 * A word that changes with the live feed (a helper's phase: Reading, Testing, ...) shown steadily:
 * a new word waits until the current one has been up for `holdMs`, then the newest word wins (the
 * ones in between are skipped, never queued). `swapKey` changes only when the shown word does, so
 * the line re-mounts (and animates) once per swap and never on a repeat of the same word.
 */
export function useHeldWord(live: string, holdMs = PHASE_HOLD_MS): { text: string; swapKey: number } {
  const [shown, setShown] = useState({ text: live, key: 0 });
  const since = useRef(performance.now());
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(() => {
    if (live === shown.text) return;
    const wait = Math.max(0, since.current + holdMs - performance.now());
    const t = setTimeout(() => {
      const next = liveRef.current;
      since.current = performance.now();
      setShown((p) => (p.text === next ? p : { text: next, key: p.key + 1 }));
    }, wait);
    return () => clearTimeout(t);
  }, [live, shown.text, holdMs]);
  return { text: shown.text, swapKey: shown.key };
}

/**
 * A progress fill (0 to 1) that is always set to its newest value but only animates its move at
 * most once per CALM_MS, and never under reduced motion. The first value never animates.
 */
export function useCalmFill(target: number | null): { fill: number | null; animate: boolean } {
  const [s, setS] = useState<{ fill: number | null; animate: boolean }>({ fill: target, animate: false });
  const last = useRef(-CALM_MS);
  const shown = useRef(target);
  useEffect(() => {
    if (shown.current === target) return;
    const t = performance.now();
    const animate = target !== null && shown.current !== null && !prefersReducedMotion() && t - last.current >= CALM_MS;
    if (animate) last.current = t;
    shown.current = target;
    setS({ fill: target, animate });
  }, [target]);
  return s;
}
