// The last year of days, fetched ONCE and shared by everything that wants a daily picture:
// the sidebar streak chip, the Dashboard heat grid and its "longest yet" pill. One query
// (a 365-day daily timeline is a few hundred small rows), cached in memory per launch and
// per Claude folder, dropped whenever the engine says the numbers moved.

import { useEffect, useRef, useState } from "react";
import { getBackend } from "./ipc";
import { longestStreak, streakLength } from "./chartPaths";
import { addDays, headline } from "./usage";
import { useToday } from "./today";
import type { TimelinePoint } from "./types";

export interface Daily {
  /** Local days, oldest first, ending today. */
  days: string[];
  /** Same order. */
  tokens: number[];
  points: TimelinePoint[];
  today: string;
  streak: number;
  longest: number;
}

const DAYS = 365;
const cache = new Map<string, Promise<Daily>>();
const listeners = new Set<() => void>();

export function dailyKey(today: string, scope: string | null): string {
  return `${scope ?? ""}|${today}`;
}

function build(today: string, points: TimelinePoint[]): Daily {
  const byDay = new Map(points.map((p) => [p.start, p]));
  const days: string[] = [];
  const tokens: number[] = [];
  const out: TimelinePoint[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    const p = byDay.get(d);
    days.push(d);
    tokens.push(p ? headline(p.tokens) : 0);
    out.push(
      p ?? {
        start: d,
        tokens: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, total: 0, webSearch: 0, webFetch: 0 },
        cost: { usd: null, complete: true, unpricedTokens: 0 },
        sessions: 0,
      },
    );
  }
  return { days, tokens, points: out, today, streak: streakLength(tokens), longest: longestStreak(tokens) };
}

export function fetchDaily(today: string, scope: string | null): Promise<Daily> {
  const k = dailyKey(today, scope);
  let p = cache.get(k);
  if (!p) {
    // A new day: yesterday's answers will not be asked for again.
    for (const old of cache.keys()) if (!old.endsWith(`|${today}`)) cache.delete(old);
    p = getBackend()
      .usageTimeline({ from: addDays(today, -(DAYS - 1)), to: today, bucket: "day" })
      .then((t) => build(today, t.points));
    p.catch(() => cache.delete(k));
    cache.set(k, p);
  }
  return p;
}

/** Forget what was fetched and tell every mounted hook to ask again. */
export function invalidateDaily(): void {
  cache.clear();
  listeners.forEach((l) => l());
}

/**
 * The shared daily picture. `scope` is the Claude folder so a folder switch refetches.
 * Returns null until the first answer; errors leave it null (the chip simply stays away).
 * The numbers shown stay on screen while the new day's answer is on its way.
 */
export function useDaily(scope: string | null): Daily | null {
  // The day comes from the shared signal, so the picture is asked for again at local midnight
  // (and when a hidden window is shown on a later day), not only when usage changes.
  const today = useToday();
  const [data, setData] = useState<Daily | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const tries = useRef(0);

  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    const backend = getBackend();
    let off: (() => void) | undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    backend
      .onUsageChanged(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(invalidateDaily, 250);
      })
      .then((fn) => (alive ? (off = fn) : fn()))
      .catch(() => {});
    return () => {
      alive = false;
      listeners.delete(l);
      off?.();
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (scope === null) {
      setData(null);
      return;
    }
    const id = ++seq.current;
    let retry: ReturnType<typeof setTimeout> | undefined;
    fetchDaily(today, scope)
      .then((d) => {
        if (id === seq.current) {
          tries.current = 0;
          setData(d);
        }
      })
      .catch(() => {
        // The engine may still be opening its cache at launch and nothing else tells us when it is
        // ready (no files to read means no "changed" event), so ask again a few times.
        if (id === seq.current && tries.current < 6) {
          tries.current++;
          retry = setTimeout(() => setTick((t) => t + 1), 800 * tries.current);
        }
      });
    return () => {
      seq.current++;
      if (retry) clearTimeout(retry);
    };
  }, [scope, tick, today]);

  return data;
}
