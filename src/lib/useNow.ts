// React glue for the Now tab: the engine's snapshot (pushed as events, never polled), a
// number that climbs to its new value, and a clock that ticks only while it is needed.

import { useEffect, useRef, useState } from "react";
import { getBackend } from "./ipc";
import { prefersReducedMotion } from "./motion";
import { EMPTY_NOW } from "./nowTypes";
import type { NowSnapshot } from "./nowTypes";
import { easeOutExpo } from "./useCountUp";

/** The latest snapshot, or null until the first one arrives. */
export function useNowSnapshot(): NowSnapshot | null {
  const [snap, setSnap] = useState<NowSnapshot | null>(null);
  useEffect(() => {
    const backend = getBackend();
    let alive = true;
    let pushed = false;
    let off: (() => void) | undefined;
    backend
      .onNowUpdate((s) => {
        if (!alive) return;
        pushed = true;
        setSnap(s);
      })
      .then((fn) => {
        if (alive) off = fn;
        else fn();
      })
      .catch(() => {});
    // The first look. An update that lands while this is in flight is newer: keep it.
    backend
      .nowSnapshot()
      .then((s) => {
        if (alive && !pushed) setSnap(s);
      })
      .catch(() => {
        if (alive && !pushed) setSnap(EMPTY_NOW);
      });
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return snap;
}

const CLIMB_MS = 600;

/**
 * A number that eases to each new value (every change, however small: a spend that moves a
 * cent at a time still climbs). Starts at its first value; reduced motion jumps.
 */
export function useClimb(target: number): number {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const origin = from.current;
    if (prefersReducedMotion() || origin === target) {
      from.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / CLIMB_MS);
      const v = origin + (target - origin) * easeOutExpo(p);
      from.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown;
}

/** `Date.now()`, refreshed every `ms` while `active`. Quiet (no timer) when not. */
export function useClock(active: boolean, ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}
