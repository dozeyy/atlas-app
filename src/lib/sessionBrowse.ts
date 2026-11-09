// Pure rules for browsing sessions: which day a row belongs to, how a day is named and summed,
// which colour a project wears, and the command that picks a chat back up. No React, no DOM.

import { addDays, localDay } from "./usage";
import type { SessionRow } from "./types";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface DayGroup {
  /** Local day, YYYY-MM-DD. */
  day: string;
  label: string;
  rows: SessionRow[];
  /** Headline tokens of the rows listed under this day. */
  tokens: number;
}

/** "Today", "Yesterday", the weekday for the rest of the week, then "Nov 3" (with the year when it is not this one). */
export function dayLabel(day: string, now: Date): string {
  const today = localDay(now);
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  for (let back = 2; back <= 6; back++) {
    if (day === addDays(today, -back)) return WEEKDAYS[date.getDay()];
  }
  const text = `${MONTHS[m - 1]} ${d}`;
  return y === now.getFullYear() ? text : `${text}, ${y}`;
}

/** Cuts a list that is already in time order into runs of one local day. */
export function groupByDay(rows: SessionRow[], now: Date): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const row of rows) {
    const day = localDay(new Date(row.startedAt));
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.rows.push(row);
      last.tokens += row.tokens.total;
    } else {
      groups.push({ day, label: dayLabel(day, now), rows: [row], tokens: row.tokens.total });
    }
  }
  return groups;
}

/** A value as a share of the largest one, 0 to 1. A tiny non-zero value still shows a sliver. */
export function shareOfMax(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.max(0.04, Math.min(1, value / max));
}

/** Which of the four chart colours (1 to 4) a project wears. The same path always gets the same one. */
export function projectTone(projectPath: string): number {
  const key = projectPath.replace(/[\\/]+$/, "").toLowerCase();
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return (h % 4) + 1;
}

/**
 * What to paste in a terminal to pick a chat back up: Claude Code keeps chats per folder, so it
 * goes to the project's folder first when that is known.
 */
export function resumeCommand(sessionId: string, projectPath: string | null | undefined): string {
  const resume = `claude --resume ${sessionId}`;
  const dir = projectPath?.trim();
  return dir ? `cd "${dir.replace(/"/g, "")}"\n${resume}` : resume;
}
