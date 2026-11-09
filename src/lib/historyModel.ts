// Pure helpers for the History page: sentences, day grouping, the ribbon. No React, no IPC.

import { KIND_BY_ID } from "./setup-model";
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
export function whatHappened(e: Pick<HistoryEvent, "kind" | "item" | "source">): string {
  if (e.source === "claude_edit") return `${noun(e.item.kind)} edited by Claude`;
  return `${noun(e.item.kind)} ${VERB[e.kind]}`;
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

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const base = `${MONTH[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/** "Today", "Yesterday", a weekday this week, else a date. */
export function dayLabel(start: number, now = Date.now()): string {
  const today = startOfDay(now);
  const days = Math.round((today - start) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return WEEKDAY[new Date(start).getDay()];
  return shortDate(start, now);
}

export function timeText(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** "4 minutes ago", "Yesterday at 3:10 PM", "Oct 9". */
export function agoText(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} ${m === 1 ? "minute" : "minutes"} ago`;
  const h = Math.round(m / 60);
  if (h < 24 && startOfDay(ms) === startOfDay(now)) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  return `${dayLabel(startOfDay(ms), now)} at ${timeText(ms)}`;
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

/** What a dot on the rail looks like: accent for added/changed, sand for dated, grey otherwise. */
export function dotTone(kind: ChangeKind): "accent" | "sand" | "quiet" {
  if (kind === "added" || kind === "changed") return "accent";
  if (kind === "dated") return "sand";
  return "quiet";
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
