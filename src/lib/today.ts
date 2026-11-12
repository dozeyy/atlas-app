// "Today", one signal for the whole window. Every view that depends on the date (the Dashboard's
// Today card, the streak, the heat grid's last cell, the lifetime row, a "last 30 days" range)
// reads it here instead of asking the clock when it happens to fetch, so a window left open
// overnight (the tray keeps it alive) moves to the new day on its own.
//
// One timer, set for the next local midnight, runs only while something is listening. It is
// re-armed every time it fires and every time the window comes back (a timer can be late or lost
// across sleep), and the same re-check runs when the window becomes visible or gets focus (the timer
// itself says nothing while the window is hidden; showing it catches up). No polling. The tray
// does the same for its own readout (`crates/app/src/tray.rs`).

import { useEffect, useRef, useSyncExternalStore } from "react";
import { localDay } from "./usage";

let current = localDay(new Date());
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** A beat past midnight, so the clock is surely on the new day when the timer fires. */
const MARGIN_MS = 100;

/** Milliseconds from `from` to the next local midnight (a DST day is 23 or 25 hours long, so ask the calendar). */
export function msToMidnight(from: Date = new Date()): number {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1).getTime() - from.getTime();
}

function arm(): void {
  if (timer) clearTimeout(timer);
  timer = listeners.size ? setTimeout(onTimer, msToMidnight() + MARGIN_MS) : null;
}

/**
 * The midnight timer. A hidden window (closed to the tray, minimized) has nobody looking and
 * nothing worth refetching, so it only sets the timer again; showing the window catches up
 * (`onVisible`).
 */
function onTimer(): void {
  if (document.visibilityState === "hidden") arm();
  else recheck();
}

/** Look at the clock now: tell everyone if the day changed, and set the timer again from the real time. */
function recheck(): void {
  const day = localDay(new Date());
  if (day !== current) {
    current = day;
    // Copy: a listener may unsubscribe while we call it.
    [...listeners].forEach((l) => l());
  }
  arm();
}

function onVisible(): void {
  if (document.visibilityState !== "hidden") recheck();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", recheck);
    document.addEventListener("resume", recheck);
  }
  listeners.add(listener);
  recheck(); // the day may have turned while nobody was listening
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("resume", recheck);
      arm(); // clears the timer
    }
  };
}

function snapshot(): string {
  // Nobody listening means nobody to tell, so a fresh read is safe; with listeners the value only
  // moves through `recheck`, which notifies.
  if (listeners.size === 0) current = localDay(new Date());
  return current;
}

/** Today's local date, "YYYY-MM-DD". Changes at local midnight, and when a hidden or sleeping window wakes on a later day. */
export function useToday(): string {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Run `cb(newDay)` when the day turns (not on mount). For a view that reloads quietly when it does. */
export function useDayChange(cb: (day: string) => void): void {
  const today = useToday();
  const seen = useRef(today);
  const latest = useRef(cb);
  latest.current = cb;
  useEffect(() => {
    if (seen.current === today) return;
    seen.current = today;
    latest.current(today);
  }, [today]);
}
