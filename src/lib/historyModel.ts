// Pure helpers for the History page: sentences, day grouping, the ribbon. No React, no IPC.

import { KIND_BY_ID } from "./setup-model";
import { clockTime, dayWord, shortDate } from "./usage";
import type { ItemKind } from "./setup-types";
import type { ChangeKind, DayCount, HistoryEvent, HistoryGroup, ItemRef } from "./historyTypes";

export const GROUP_CHIPS: { id: HistoryGroup | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "settings", label: "Settings" },
  { id: "skills", label: "Skills" },
  { id: "agents", label: "Agents" },
  { id: "hooks", label: "Hooks" },
  { id: "mcp", label: "MCP" },
  { id: "instructions", label: "Instructions" },
  { id: "other", label: "Other" },
];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The Setup kind an item belongs to, falling back to "other" for anything unknown. */
export function setupKind(kind: string): ItemKind {
  return (kind in KIND_BY_ID ? kind : "other") as ItemKind;
}

/** "Skill", "Settings file": what the item is, for a line like "Skill added". */
export function noun(kind: string): string {
  return cap(KIND_BY_ID[setupKind(kind)].singular);
}

const VERB: Record<ChangeKind, string> = {
  added: "added",
  changed: "changed",
  removed: "removed",
  renamed: "renamed",
  dated: "last changed",
};

/** First line of a row: "Skill added". */
export function libraryLabel(e: Pick<HistoryEvent, "source"> & { summary?: string }): string | null {
  return e.source === "atlas_library" && e.summary && e.summary.includes("from the Library") ? e.summary : null;
}

export function whatHappened(e: Pick<HistoryEvent, "kind" | "item" | "source"> & { summary?: string }): string {
  // A plugin put in or taken out from the Library says so by name: "Installed x from the Library".
  const lib = libraryLabel(e);
  if (lib) return lib;
  if (e.source === "claude_edit" || e.source === "atlas_mcp") return `${noun(e.item.kind)} edited by Claude`;
  return `${noun(e.item.kind)} ${VERB[e.kind]}`;
}

/**
 * A long name in two parts, so a row can cut the middle and keep the ending, which is the part
 * that tells two files apart: "a-very-long-na" + "e-0123.json". A short name comes back whole
 * with an empty ending. Wide letters (Chinese, Japanese, Korean) count double.
 */
export function splitName(name: string, longFrom = 28, keep = 10): [string, string] {
  const chars = Array.from(name);
  if (chars.length <= longFrom) return [name, ""];
  let at = chars.length;
  let width = 0;
  while (at > 1) {
    const w = (chars[at - 1].codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
    if (width + w > keep) break;
    width += w;
    at--;
  }
  return [chars.slice(0, at).join(""), chars.slice(at).join("")];
}

/** Where an item applies, in plain words. */
export function scopeText(item: ItemRef): string {
  if (item.scope === "user") return "Every project";
  if (item.scope === "local") return item.project ? `${item.project}, just you` : "Just you";
  return item.project ?? "One project";
}

/** Where a change came from, only when it is not Atlas's own look. */
export function sourceNote(e: Pick<HistoryEvent, "source">): string | null {
  switch (e.source) {
    case "claude_edit":
      return "Kept by Claude Code while it worked";
    case "atlas_mcp":
      return "Made by Claude through Atlas's connector";
    case "atlas_assistant":
      return "Made by Atlas's assistant after you approved it";
    case "atlas_library":
      return "Installed from the Library";
    case "claude_backup":
      return "From a Claude Code backup";
    default:
      return null;
  }
}

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "Today", "Yesterday", a weekday this week, else a date: the app's one day rule (`dayWord`). */
export function dayLabel(start: number, now = Date.now()): string {
  return start >= startOfDay(now) ? "Today" : dayWord(start, now, true);
}

/**
 * "4 min ago", "2 h ago", "Yesterday at 3:10 PM" (or "at 15:10": the app's one clock, `clockTime`),
 * "Oct 9 at 9:00 AM". The short units are the ones the Toolkit and Now use.
 */
export function agoText(ms: number, now = Date.now(), locale?: string): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24 && startOfDay(ms) === startOfDay(now)) return `${h} h ago`;
  return `${dayLabel(startOfDay(ms), now)} at ${clockTime(ms, { locale })}`;
}

/** The changes one item had on one day, newest first. */
export interface RowGroup {
  key: string;
  item: ItemRef;
  events: HistoryEvent[];
}

export interface DaySection {
  /** Start of the local day. */
  start: number;
  label: string;
  /** Everything here happened before Atlas began watching. */
  before: boolean;
  rows: RowGroup[];
}

/**
 * Group newest-first events into days, and within a day fold neighbouring changes to the same
 * item into one row ("changed 4 times"). `watchingSince` splits live history from the rest.
 */
export function groupEvents(events: HistoryEvent[], now: number, watchingSince: number): DaySection[] {
  const out: DaySection[] = [];
  for (const e of events) {
    const start = startOfDay(e.at);
    const before = e.source === "file_date" || e.at < watchingSince;
    let day = out[out.length - 1];
    if (!day || day.start !== start || day.before !== before) {
      day = { start, label: dayLabel(start, now), before, rows: [] };
      out.push(day);
    }
    const last = day.rows[day.rows.length - 1];
    if (last && last.item.key === e.item.key && e.kind !== "dated") last.events.push(e);
    else day.rows.push({ key: `${start}:${e.item.key}:${e.id}`, item: e.item, events: [e] });
  }
  return out;
}

/**
 * What a dot on the rail looks like. History is a calm page: every change Atlas saw is the same
 * quiet dot, and a date from before it was watching is a hollow one. Clay is kept for the change
 * that is open.
 */
export function dotTone(kind: ChangeKind): "seen" | "before" {
  return kind === "dated" ? "before" : "seen";
}

/**
 * The first day on the ribbon Atlas was watching for. Days before it have nothing to show, so the
 * ribbon starts there and its first date agrees with "watching since". 0 when watching began
 * before the ribbon does, or is not known.
 */
export function ribbonStart(days: DayCount[], watchingSince: number): number {
  if (watchingSince <= 0 || days.length === 0) return 0;
  const first = startOfDay(watchingSince);
  const at = days.findIndex((d) => d.day >= first);
  return at < 0 ? 0 : at;
}

/** Dot diameter in px for a day with this many changes (0 = a faint pip). */
export function ribbonDot(count: number, max: number): number {
  if (count <= 0) return 4;
  const f = Math.min(1, Math.sqrt(count / Math.max(1, max)));
  return Math.round(8 + f * 12);
}

export function ribbonLabel(d: DayCount, now = Date.now()): string {
  const label = dayLabel(d.day, now);
  const when = label === "Today" || label === "Yesterday" ? label : shortDate(d.day, now);
  return d.count === 0 ? `${when}: no changes` : `${when}: ${d.count} ${d.count === 1 ? "change" : "changes"}`;
}

/** Which filter chip an item kind belongs to (the same split the backend uses). */
export function groupOfKind(kind: string): HistoryGroup {
  const k = setupKind(kind);
  if (["settings", "keybindings", "statusLine", "permission", "theme"].includes(k)) return "settings";
  if (k === "skill") return "skills";
  if (k === "agent" || k === "agentMemory") return "agents";
  if (k === "hook" || k === "hookScript") return "hooks";
  if (k === "mcpServer") return "mcp";
  if (k === "instructions" || k === "rule") return "instructions";
  return "other";
}
