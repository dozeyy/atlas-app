// Pure rules for browsing sessions: which day a row belongs to, how a day is named and summed,
// which colour a project wears, and the command that picks a chat back up. No React, no DOM.

import { dayWord, localDay } from "./usage";
import type { Platform, SessionRow } from "./types";

export interface DayGroup {
  /** Local day, YYYY-MM-DD. */
  day: string;
  label: string;
  rows: SessionRow[];
  /** Headline tokens of the rows listed under this day. */
  tokens: number;
}

/**
 * "Today", "Yesterday", the weekday for the rest of the week, then "Nov 3" (with the year when it
 * is not this one): the app's one day rule (`dayWord`), for a local day written YYYY-MM-DD.
 */
export function dayLabel(day: string, now: Date): string {
  const [y, m, d] = day.split("-").map(Number);
  return dayWord(new Date(y, m - 1, d, 12).getTime(), now.getTime(), true);
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

export interface FolderGroup {
  /** The project folder, as the rows name it; "" for chats with no folder. */
  key: string;
  /** The folder's name in plain words ("atlas"); "No folder" for the last group. */
  name: string;
  /** The full path, for the hover; "" when there is none. */
  path: string;
  rows: SessionRow[];
  /** Headline tokens of the rows listed under this folder. */
  tokens: number;
  /** When the newest chat here started. */
  latest: number;
}

/** The group every chat with no project folder falls into. */
export const NO_FOLDER = "No folder";

/**
 * Cuts a list into one group per project folder. A group sits where its first row sits in the
 * list (newest first: the folder with the newest chat on top), and its rows keep the list's
 * order, so more rows loading later only ever add to the end of a group or add groups at the
 * end; nothing moves. Chats with no folder go last, whatever their place in the list.
 */
/** A folder with a path but no name reads as its last segment ("C:/work/atlas" -> "atlas"), never "No folder". */
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || NO_FOLDER;
}

export function groupByFolder(rows: SessionRow[]): FolderGroup[] {
  const groups: FolderGroup[] = [];
  const at = new Map<string, FolderGroup>();
  let none: FolderGroup | null = null;
  for (const row of rows) {
    const path = (row.projectPath ?? "").trim();
    const key = path === "" ? "" : path.replace(/[\\/]+$/, "");
    let g: FolderGroup | null | undefined = key === "" ? none : at.get(key);
    if (g) {
      g.rows.push(row);
      g.tokens += row.tokens.total;
      if (row.startedAt > g.latest) g.latest = row.startedAt;
      continue;
    }
    g = { key, name: key === "" ? NO_FOLDER : row.projectName || lastSegment(key), path, rows: [row], tokens: row.tokens.total, latest: row.startedAt };
    if (key === "") none = g;
    else {
      at.set(key, g);
      groups.push(g);
    }
  }
  if (none) groups.push(none);
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

/** Chat ids Claude Code writes are UUIDs; anything wider than letters, digits, "-" and "_" is not pasted. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
/** PowerShell reads all four of these as a single quote, so each one is doubled inside '...'. */
const PS_QUOTES = /['‘’‚‛]/g;
/** Line breaks and other control characters would turn one pasted line into several. */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/**
 * What to paste in a terminal to pick a chat back up, as ONE line. Claude Code keeps chats per
 * folder, so it goes to the project's folder first when that is known. Windows gets PowerShell
 * (`Set-Location -LiteralPath` also changes drive; `cd` in cmd does not), macOS and Linux get a
 * POSIX shell. The folder sits in single quotes, where nothing expands. Returns null when the id
 * or folder cannot be pasted safely, so the caller does not offer a copy.
 */
export function resumeCommand(
  sessionId: string,
  projectPath: string | null | undefined,
  platform: Platform,
): string | null {
  if (!SAFE_ID.test(sessionId)) return null;
  const resume = `claude --resume ${sessionId}`;
  const dir = projectPath?.trim();
  if (!dir) return resume;
  if (hasControl(dir)) return null;
  if (platform === "windows") {
    return `Set-Location -LiteralPath '${dir.replace(PS_QUOTES, (q) => q + q)}'; ${resume}`;
  }
  // A folder that starts with "-" would be read by cd as an option; chats are stored by absolute path.
  if (!dir.startsWith("/")) return null;
  return `cd '${dir.replace(/'/g, "'\\''")}' && ${resume}`;
}
