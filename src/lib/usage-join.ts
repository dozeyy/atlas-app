// Joins what Claude actually ran (the usage engine) onto what is set up (the Setup
// scan), by name. Pure: the hook in UsagePanel fetches, this decides.

import type { SetupItem } from "./setup-types";
import type { UsageRow } from "./usage-types";
import type { ItemUse } from "./usageTypes";
import { addDays, localDay } from "./usage";

export const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/** The 30 day window the panel asks the usage engine about (local days, inclusive). */
export function usageWindow(now: Date = new Date()): { from: string; to: string } {
  const to = localDay(now);
  return { from: addDays(to, -(WINDOW_DAYS - 1)), to };
}

/** Skills and agents that count for this panel: real, yours-to-use, and not shadowed by another copy. */
export function trackable(i: SetupItem): boolean {
  if (i.kind !== "skill" && i.kind !== "agent") return false;
  if (i.backup || i.worktree) return false;
  return i.conflict?.status !== "overridden";
}

/**
 * One row per trackable item. `isNew` marks something that was created or changed
 * inside the window, so "never used" is never said about a thing added yesterday.
 * Without a modified time there is nothing to say it is new, so it counts as established.
 */
export function joinUsage(items: SetupItem[], skills: ItemUse[], agents: ItemUse[], now: number = Date.now()): UsageRow[] {
  const by = {
    skill: new Map(skills.map((u) => [u.id.toLowerCase(), u])),
    agent: new Map(agents.map((u) => [u.id.toLowerCase(), u])),
  };
  const cutoff = now - WINDOW_DAYS * DAY_MS;
  const rows: UsageRow[] = [];
  for (const i of items) {
    if (!trackable(i)) continue;
    const u = by[i.kind as "skill" | "agent"].get(i.name.toLowerCase());
    rows.push({
      id: i.id,
      kind: i.kind,
      uses30d: u?.uses ?? 0,
      lastUsed: u?.lastUsed ?? null,
      isNew: i.modifiedMs !== null && i.modifiedMs > cutoff,
    });
  }
  return rows;
}
