// Pure model for the sidebar's "Today" readout: today's token total and a 24 hour trace.
// No React, no DOM, so the rules (what counts, the trace never leaving its baseline) are tested.

import { ridgeGeometry } from "./chartPaths";
import { addDays, headline, localDay } from "./usage";
import type { TimelinePoint } from "./types";

const pad = (n: number) => String(n).padStart(2, "0");

/** The hour bucket key the engine uses for a local moment: "2026-11-08T14". */
export function hourKey(d: Date): string {
  return `${localDay(d)}T${pad(d.getHours())}`;
}

/**
 * The 24 hour keys ending with the hour of `now`, oldest first.
 *
 * The engine's hour grid is wall-clock labels, 24 per day, whatever the clock did (a fall-back
 * hour is one label, a spring-forward hour a zero one). So the keys step back through that grid
 * (hour - 1, then the previous day's 23) and never subtract milliseconds, which would repeat or
 * skip a label on a daylight-saving change.
 */
export function last24Keys(now: Date): string[] {
  let day = localDay(now);
  let hour = now.getHours();
  const keys: string[] = [];
  for (let i = 0; i < 24; i++) {
    keys.push(`${day}T${pad(hour)}`);
    if (hour === 0) {
      day = addDays(day, -1);
      hour = 23;
    } else {
      hour--;
    }
  }
  return keys.reverse();
}

/** Tokens per hour for the last 24 hours (gaps are zero), same headline rule as everywhere else. */
export function last24Hours(points: TimelinePoint[], now: Date): number[] {
  const byKey = new Map(points.map((p) => [p.start, headline(p.tokens)]));
  return last24Keys(now).map((k) => byKey.get(k) ?? 0);
}

/** Today's tokens: every hour bucket that starts with today's local day. */
export function todayTotal(points: TimelinePoint[], now: Date): number {
  const day = localDay(now);
  let sum = 0;
  for (const p of points) if (p.start.startsWith(day)) sum += headline(p.tokens);
  return sum;
}

/** The query window for the readout: yesterday through today, hourly. */
export function statRange(now: Date): { from: string; to: string } {
  const today = localDay(now);
  return { from: addDays(today, -1), to: today };
}

export interface SparkShape {
  line: string;
  area: string;
  /** y of the floor; no point of the trace is ever below it. */
  baseline: number;
  /** The last point, for the end dot. */
  last: [number, number] | null;
  empty: boolean;
}

/**
 * A w x h trace with a 2 px margin all round. The path is a monotone curve, so it stays between
 * its points and never dips under the baseline, even where usage falls to zero.
 */
export function sparkShape(values: number[], w: number, h: number): SparkShape {
  const g = ridgeGeometry(values, w, h, 2, 2, 2);
  return {
    line: g.line,
    area: g.area,
    baseline: g.baseline,
    last: g.pts.length ? g.pts[g.pts.length - 1] : null,
    empty: !values.some((v) => v > 0),
  };
}
