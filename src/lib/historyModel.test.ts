import { describe, expect, it } from "vitest";
import { dayLabel, dotTone, groupEvents, groupOfKind, ribbonDot, ribbonLabel, ribbonStart, scopeText, startOfDay, whatHappened } from "./historyModel";
import type { HistoryEvent, ItemRef } from "./historyTypes";

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 8, 15, 0, 0).getTime();
const today = startOfDay(NOW);

function item(key: string, kind = "skill", name = key): ItemRef {
  return { key, kind, scope: "user", project: null, name, path: `/x/${name}`, gone: false };
}
function ev(id: number, at: number, it: ItemRef, over: Partial<HistoryEvent> = {}): HistoryEvent {
  return { id, at, kind: "changed", source: "atlas_snapshot", summary: "s", item: it, fromVersion: null, toVersion: id, hasCopy: true, sessionId: null, ...over };
}

describe("history sentences", () => {
  it("names what happened in plain words", () => {
    expect(whatHappened({ kind: "added", source: "atlas_snapshot", item: item("a", "skill") })).toBe("Skill added");
    expect(whatHappened({ kind: "changed", source: "atlas_snapshot", item: item("a", "settings") })).toBe("Settings file changed");
    expect(whatHappened({ kind: "changed", source: "claude_edit", item: item("a", "skill") })).toBe("Skill edited by Claude");
    expect(whatHappened({ kind: "changed", source: "atlas_mcp", item: item("a", "skill") })).toBe("Skill edited by Claude");
    expect(
      whatHappened({ kind: "changed", source: "atlas_library", summary: "Installed fd from the Library", item: item("a", "settings") }),
    ).toBe("Installed fd from the Library");
    expect(whatHappened({ kind: "changed", source: "atlas_library", summary: "Changed `x`.", item: item("a", "settings") })).toBe("Settings file changed");
    expect(whatHappened({ kind: "dated", source: "file_date", item: item("a", "nonsense") })).toBe("File last changed");
  });

  it("says where an item applies", () => {
    expect(scopeText(item("a"))).toBe("Every project");
    expect(scopeText({ ...item("a"), scope: "project", project: "newsletter" })).toBe("newsletter");
    expect(scopeText({ ...item("a"), scope: "local", project: "newsletter" })).toBe("newsletter, just you");
  });

  it("labels days relative to today", () => {
    expect(dayLabel(today, NOW)).toBe("Today");
    expect(dayLabel(today - DAY, NOW)).toBe("Yesterday");
    expect(dayLabel(today - 20 * DAY, NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it("maps item kinds to the same filter groups as the backend", () => {
    expect(groupOfKind("keybindings")).toBe("settings");
    expect(groupOfKind("agentMemory")).toBe("agents");
    expect(groupOfKind("hookScript")).toBe("hooks");
    expect(groupOfKind("rule")).toBe("instructions");
    expect(groupOfKind("plugin")).toBe("other");
  });
});

describe("groupEvents", () => {
  const a = item("a");
  const b = item("b");

  it("folds neighbouring changes to one file on one day", () => {
    const sections = groupEvents([ev(4, today + 5 * 3_600_000, a), ev(3, today + 4 * 3_600_000, a), ev(2, today + 3 * 3_600_000, b), ev(1, today + 2 * 3_600_000, a)], NOW, 0);
    expect(sections).toHaveLength(1);
    expect(sections[0].rows.map((r) => r.events.length)).toEqual([2, 1, 1]);
  });

  it("starts a new section each day and marks what came before watching", () => {
    const since = today - 5 * DAY;
    const sections = groupEvents(
      [ev(3, today + 1000, a), ev(2, today - DAY + 1000, a), ev(1, today - 10 * DAY, a, { kind: "dated", source: "file_date" })],
      NOW,
      since,
    );
    expect(sections.map((s) => s.label)).toEqual(["Today", "Yesterday", expect.any(String)]);
    expect(sections.map((s) => s.before)).toEqual([false, false, true]);
  });

  it("never folds dated events together", () => {
    const sections = groupEvents([ev(2, today - 9 * DAY + 2, a, { kind: "dated", source: "file_date" }), ev(1, today - 9 * DAY + 1, a, { kind: "dated", source: "file_date" })], NOW, today);
    expect(sections[0].rows).toHaveLength(2);
  });
});

describe("ribbon", () => {
  it("sizes dots by how busy the day was, with a faint pip for none", () => {
    expect(ribbonDot(0, 10)).toBe(4);
    expect(ribbonDot(1, 100)).toBeLessThan(ribbonDot(10, 100));
    expect(ribbonDot(100, 100)).toBe(20);
    expect(ribbonDot(5, 0)).toBeLessThanOrEqual(20);
  });

  it("reads each day aloud", () => {
    expect(ribbonLabel({ day: today, count: 0 }, NOW)).toBe("Today: no changes");
    expect(ribbonLabel({ day: today - DAY, count: 1 }, NOW)).toBe("Yesterday: 1 change");
    expect(ribbonLabel({ day: today - DAY, count: 3 }, NOW)).toBe("Yesterday: 3 changes");
  });

  it("keeps every seen change the same quiet dot, and a date from before watching a hollow one", () => {
    expect(dotTone("added")).toBe("seen");
    expect(dotTone("changed")).toBe("seen");
    expect(dotTone("removed")).toBe("seen");
    expect(dotTone("dated")).toBe("before");
  });

  it("starts the ribbon on the day watching began, so its first date agrees with the number beside it", () => {
    const days = Array.from({ length: 30 }, (_, i) => ({ day: today - (29 - i) * DAY, count: 0 }));
    // Began partway through that day, 24 days ago.
    expect(ribbonStart(days, today - 24 * DAY + 5 * 3_600_000)).toBe(5);
    expect(ribbonStart(days, today - 24 * DAY)).toBe(5);
    // Watching for longer than the ribbon shows, or not known yet: the whole ribbon.
    expect(ribbonStart(days, today - 90 * DAY)).toBe(0);
    expect(ribbonStart(days, 0)).toBe(0);
    expect(ribbonStart([], today)).toBe(0);
    // Began today.
    expect(ribbonStart(days, NOW)).toBe(29);
  });
});
