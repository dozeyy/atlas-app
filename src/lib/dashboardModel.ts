// Small pure helpers for the Dashboard's words and numbers. No React here.

import { addDays } from "./usage";
import type { TimelinePoint } from "./types";
import { headline } from "./usage";

/** Morning 5-12, afternoon 12-17, evening 17-5. No name (DIRECTION.md, copy rules). */
export function greeting(now: Date): string {
  const h = now.getHours();
  if (h >= 5 && h < 12) return "Good morning.";
  if (h >= 12 && h < 17) return "Good afternoon.";
  return "Good evening.";
}

/** "Sunday, November 8" for the eyebrow. */
export function longDate(now: Date): string {
  return now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/** "Sun, Nov 8" for a day in a tooltip. */
export function shortDay(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** One-letter weekday for the ridge axis. */
export function weekdayInitial(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "narrow" });
}

/** "Updated just now" / "Updated 3 min ago" / "Updated 2 h ago". Quiet, never a pulse. */
export function updatedText(lastIndexedAt: number | null, now = Date.now()): string | null {
  if (lastIndexedAt === null) return null;
  const min = Math.floor(Math.max(0, now - lastIndexedAt) / 60_000);
  if (min < 1) return "Updated just now";
  if (min < 60) return `Updated ${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Updated ${h} h ago`;
  return `Updated ${Math.floor(h / 24)} d ago`;
}

/** Whole-number percent change, null when there is no earlier figure to compare with. */
export function percentChange(now: number, before: number): number | null {
  if (before <= 0) return null;
  return Math.round(((now - before) / before) * 100);
}

/** Tokens of the last `n` days of a daily series (oldest first, last is today) and the `n` before. */
export function lastAndPrevious(tokens: number[], n: number): { last: number[]; prev: number[] } {
  const len = tokens.length;
  return { last: tokens.slice(Math.max(0, len - n)), prev: tokens.slice(Math.max(0, len - 2 * n), Math.max(0, len - n)) };
}

/** The last `n` local days ending `today`, oldest first. */
export function lastDays(today: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addDays(today, -(n - 1 - i)));
}

/** Sum a project series (daily points) over its last `n` points. */
export function sumTail(points: TimelinePoint[], n: number): number {
  return points.slice(-n).reduce((s, p) => s + headline(p.tokens), 0);
}

/** Sum a series into `bins` roughly even groups (for a sparkline). */
export function bin(values: number[], bins: number): number[] {
  if (values.length <= bins) return values;
  const out: number[] = [];
  for (let b = 0; b < bins; b++) {
    const from = Math.floor((b * values.length) / bins);
    const to = Math.floor(((b + 1) * values.length) / bins);
    out.push(values.slice(from, to).reduce((s, v) => s + v, 0));
  }
  return out;
}
