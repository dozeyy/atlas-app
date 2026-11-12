// The words and numbers of the Dashboard's "All time" row. Pure: no React, no backend. The
// totals come from Rust already counted (the same core call as the `atlas-usage` CLI's `all`
// scope); this only picks, rounds and words them.

import { longestStreak } from "./chartPaths";
import { longDate, monthDay } from "./dashboardModel";
import { kindsOf, mergeModelRows, plural, tokenHint } from "./usage";
import { daysBetween } from "./wrappedModel";
import type { Lifetime } from "./types";

export const LIFETIME_NOTE = "Counted since Atlas first read your chats.";

/** One flag per local day from `first` to `today`: 1 where there was usage. The streak code reads this. */
export function activeSeries(first: string, today: string, activeDays: string[]): number[] {
  const n = Math.max(0, daysBetween(first, today)) + 1;
  const out = new Array<number>(n).fill(0);
  for (const d of activeDays) {
    const i = daysBetween(first, d);
    if (i >= 0 && i < n) out[i] = 1;
  }
  return out;
}

/**
 * The longest run of days in a row with usage since the first one, by the same `longestStreak`
 * the Dashboard's streak card uses. `current` (`useDaily().streak`, the sidebar chip's number) is
 * a floor: that count looks back a year, so the record may not be lower than it.
 */
export function lifetimeLongest(l: Lifetime, current: number): number {
  const first = l.firstDay;
  const run = first ? longestStreak(activeSeries(first, l.today, l.activeDays)) : 0;
  return Math.max(run, current);
}

/** "Nov 3", or "Nov 3, 2025" when it is not this year. */
export function dayWithYear(day: string, today: string): string {
  return day.slice(0, 4) === today.slice(0, 4) ? monthDay(day) : longDate(day);
}

/** "Tue, Nov 3, 2026" for a hover. */
function fullDay(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

export interface LifetimeView {
  /** "Mar 4, 2026". */
  since: string;
  tokens: number;
  tokensTip: string;
  sessions: number;
  sessionsTip: string;
  busiest: { tokens: number; day: string; tip: string } | null;
  favorite: { label: string; tip: string } | null;
  longest: number;
  longestTip: string;
}

/** The row's content, or null when nothing has been used yet (the page shows its empty state then). */
export function lifetimeView(l: Lifetime, current: number): LifetimeView | null {
  if (!l.firstDay || l.total.tokens.total <= 0) return null;
  const total = l.total.tokens.total;

  const b = l.busiest;
  const busiest = b
    ? {
        tokens: b.tokens.total,
        day: dayWithYear(b.day, l.today),
        tip: `${fullDay(b.day)}, the day with the most tokens\n${tokenHint(b.tokens.total, b.cost, kindsOf(b.tokens))}`,
      }
    : null;

  // One row per model name (ids that read the same are added), the most tokens first.
  const models = mergeModelRows(l.byModel).sort((a, c) => c.tokens.total - a.tokens.total || a.label.localeCompare(c.label));
  const top = models[0];
  const favorite =
    top && top.tokens.total > 0
      ? {
          label: top.label,
          tip: `${top.label}, ${Math.round((top.tokens.total / total) * 100)}% of all tokens\n${tokenHint(top.tokens.total, top.cost, kindsOf(top.tokens))}`,
        }
      : null;

  const longest = lifetimeLongest(l, current);
  return {
    since: longDate(l.firstDay),
    tokens: total,
    tokensTip: `All time\n${tokenHint(total, l.total.cost, kindsOf(l.total.tokens))}`,
    sessions: l.total.sessions,
    sessionsTip: `${plural(l.total.sessions, "session")}. A chat still counts after Claude Code deletes its file.`,
    busiest,
    favorite,
    longest,
    longestTip: `Your longest streak: ${plural(longest, "day")} in a row.`,
  };
}
