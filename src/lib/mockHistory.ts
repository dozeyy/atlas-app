// Stand-in for the History engine: a made-up record so the page can be designed and tested in
// a plain browser. The real one is crates/core/src/history.

import type {
  ChangeKind,
  ChangeSource,
  DiffArgs,
  DiffHunk,
  EventsArgs,
  EventsPage,
  HistoryDiff,
  HistoryEvent,
  HistoryGroup,
  HistoryOverview,
  ItemDetail,
  ItemRef,
  SettingsOverview,
  VersionRow,
} from "./historyTypes";

const DAY = 86_400_000;
const GROUP_KINDS: Record<Exclude<HistoryGroup, "other">, string[]> = {
  settings: ["settings", "keybindings", "statusLine", "permission", "theme"],
  skills: ["skill"],
  agents: ["agent", "agentMemory"],
  hooks: ["hook", "hookScript"],
  mcp: ["mcpServer"],
  instructions: ["instructions", "rule"],
};

function item(key: string, kind: string, name: string, path: string, project: string | null = null, gone = false): ItemRef {
  return { key, kind, scope: project ? "project" : "user", project, name, path, gone };
}

const ITEMS = {
  settings: item("f:settings", "settings", "settings.json", "C:/Users/you/.claude/settings.json"),
  ship: item("f:ship", "skill", "ship-it", "C:/Users/you/.claude/skills/ship-it/SKILL.md"),
  review: item("f:review", "agent", "reviewer", "C:/Users/you/.claude/agents/reviewer.md"),
  fmt: item("f:fmt", "hook", "format-on-save", "C:/Users/you/.claude/hooks/format.sh"),
  mcp: item("mcp-view", "mcpServer", "MCP servers", ""),
  md: item("f:md", "instructions", "CLAUDE.md", "C:/Users/you/.claude/CLAUDE.md"),
  newsletter: item("f:newsletter", "instructions", "CLAUDE.md", "C:/Dev/newsletter/CLAUDE.md", "newsletter"),
  old: item("f:old", "skill", "old-notes", "C:/Users/you/.claude/skills/old-notes/SKILL.md", null, true),
  keys: item("f:keys", "keybindings", "keybindings.json", "C:/Users/you/.claude/keybindings.json"),
};

const SETTINGS_V1 = `{
  "model": "sonnet",
  "permissions": {
    "allow": ["Bash(npm test)"]
  }
}
`;
const SETTINGS_V2 = `{
  "model": "opus",
  "permissions": {
    "allow": ["Bash(npm test)", "Bash(git status)"]
  },
  "env": {
    "TOKEN": "****"
  }
}
`;
const SKILL_V1 = `---
name: ship-it
description: Tag, build and publish a release.
---
Run the tests, bump the version, tag it.
`;
const SKILL_V2 = `---
name: ship-it
description: Tag, build and publish a release, then post the notes.
---
Run the tests, bump the version, tag it.
Write the release notes from the commit list.
`;

interface Row {
  id: number;
  daysAgo: number;
  hour: number;
  kind: ChangeKind;
  source: ChangeSource;
  summary: string;
  item: ItemRef;
  copy: boolean;
  from?: number;
  to?: number;
  session?: string;
}

const ROWS: Row[] = [
  { id: 1, daysAgo: 0, hour: 9, kind: "changed", source: "atlas_snapshot", summary: "Changed the model to opus. Allowed 1 more command.", item: ITEMS.settings, copy: true, from: 11, to: 12 },
  { id: 2, daysAgo: 0, hour: 8, kind: "changed", source: "atlas_snapshot", summary: "Edited the instructions.", item: ITEMS.md, copy: true, from: 21, to: 22 },
  { id: 3, daysAgo: 1, hour: 17, kind: "added", source: "atlas_snapshot", summary: "New skill.", item: ITEMS.ship, copy: true, to: 31 },
  { id: 4, daysAgo: 3, hour: 14, kind: "changed", source: "claude_edit", summary: "Claude changed the description and added 1 line.", item: ITEMS.ship, copy: true, from: 31, to: 32, session: "s-0042" },
  { id: 5, daysAgo: 3, hour: 11, kind: "added", source: "atlas_snapshot", summary: "New helper.", item: ITEMS.review, copy: true, to: 41 },
  { id: 6, daysAgo: 6, hour: 20, kind: "changed", source: "atlas_snapshot", summary: "1 server added.", item: ITEMS.mcp, copy: true, from: 51, to: 52 },
  { id: 7, daysAgo: 9, hour: 10, kind: "removed", source: "atlas_snapshot", summary: "Removed.", item: ITEMS.old, copy: true, from: 61 },
  { id: 8, daysAgo: 12, hour: 16, kind: "renamed", source: "atlas_snapshot", summary: "Renamed from lint-on-save.", item: ITEMS.fmt, copy: true, from: 71, to: 72 },
  { id: 9, daysAgo: 12, hour: 9, kind: "changed", source: "claude_backup", summary: "A hidden value changed.", item: ITEMS.mcp, copy: true, from: 50, to: 51 },
  { id: 10, daysAgo: 17, hour: 13, kind: "changed", source: "atlas_snapshot", summary: "Edited the instructions.", item: ITEMS.newsletter, copy: true, from: 81, to: 82 },
  { id: 11, daysAgo: 23, hour: 18, kind: "added", source: "atlas_snapshot", summary: "New key bindings file.", item: ITEMS.keys, copy: true, to: 91 },
  { id: 12, daysAgo: 40, hour: 12, kind: "dated", source: "file_date", summary: "Last changed here.", item: ITEMS.settings, copy: false },
  { id: 13, daysAgo: 52, hour: 12, kind: "dated", source: "file_date", summary: "Last changed here.", item: ITEMS.md, copy: false },
  { id: 14, daysAgo: 71, hour: 12, kind: "dated", source: "file_date", summary: "Last changed here.", item: ITEMS.review, copy: false },
];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function groupOf(kind: string): HistoryGroup {
  for (const [g, kinds] of Object.entries(GROUP_KINDS)) if (kinds.includes(kind)) return g as HistoryGroup;
  return "other";
}

function lines(text: string): string[] {
  return text.replace(/\n$/, "").split("\n");
}

/** A small line diff, enough to draw. Not the real algorithm. */
function diffText(a: string, b: string): HistoryDiff {
  if (a === b) return { kind: "same", summary: ["Nothing changed."], hunks: [], skippedAfter: 0, added: 0, removed: 0, cut: false };
  const x = lines(a);
  const y = lines(b);
  const out: DiffHunk["lines"] = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push({ kind: "same", oldNo: i + 1, newNo: j + 1, text: x[i], segs: null });
      i++;
      j++;
    } else if (j < y.length && !x.slice(i).includes(y[j])) {
      out.push({ kind: "add", oldNo: null, newNo: j + 1, text: y[j], segs: null });
      added++;
      j++;
    } else if (i < x.length) {
      out.push({ kind: "del", oldNo: i + 1, newNo: null, text: x[i], segs: null });
      removed++;
      i++;
    } else {
      out.push({ kind: "add", oldNo: null, newNo: j + 1, text: y[j], segs: null });
      added++;
      j++;
    }
  }
  return { kind: "text", summary: [], hunks: [{ skippedBefore: 0, lines: out }], skippedAfter: 0, added, removed, cut: false };
}

/** The skill that was removed: its last copy is a real file, as the app would have kept it. */
const OLD_NOTES = `---
name: old-notes
description: Turn rough meeting notes into a short summary with next steps.
---

# Old notes

1. Read the notes the user pasted.
2. Write three lines: what was decided, what is still open, who does what.
3. Keep names and dates exactly as written.
`;

const TEXT: Record<number, string> = { 11: SETTINGS_V1, 12: SETTINGS_V2, 31: SKILL_V1, 32: SKILL_V2, 61: OLD_NOTES };

export class MockHistory {
  /** Tests set these to try the other states. */
  paused = false;
  empty = false;
  private listeners = new Set<() => void>();
  readonly now = Date.now();

  private events(): HistoryEvent[] {
    if (this.empty) return [];
    const today = startOfDay(this.now);
    return ROWS.map((r) => ({
      id: r.id,
      at: today - r.daysAgo * DAY + r.hour * 3_600_000,
      kind: r.kind,
      source: r.source,
      summary: r.summary,
      item: r.item,
      fromVersion: r.from ?? null,
      toVersion: r.to ?? null,
      hasCopy: r.copy,
      sessionId: r.session ?? null,
    })).sort((a, b) => b.at - a.at || b.id - a.id);
  }

  async historyOverview(): Promise<HistoryOverview | null> {
    if (this.paused) return null;
    const ev = this.events();
    const today = startOfDay(this.now);
    const days = Array.from({ length: 30 }, (_, i) => ({ day: today - (29 - i) * DAY, count: 0 }));
    for (const e of ev) {
      if (e.source === "file_date") continue;
      const idx = Math.floor((e.at - days[0].day) / DAY);
      if (idx >= 0 && idx < 30) days[idx].count++;
    }
    return {
      items: this.empty ? 0 : 9,
      versions: this.empty ? 0 : 14,
      events: ev.length,
      watchedEvents: ev.filter((e) => e.source !== "file_date").length,
      watchingSince: this.empty ? 0 : today - 24 * DAY,
      bytes: this.empty ? 0 : 61_440,
      days,
      projects: this.empty ? [] : ["newsletter"],
      keepVersions: 50,
    };
  }

  async historyEvents(args: EventsArgs): Promise<EventsPage> {
    let ev = this.events();
    if (args.groups?.length) ev = ev.filter((e) => args.groups!.includes(groupOf(e.item.kind)));
    if (args.project) ev = ev.filter((e) => e.item.project === args.project);
    const q = args.text?.trim().toLowerCase();
    if (q) ev = ev.filter((e) => `${e.item.name} ${e.item.path} ${e.summary}`.toLowerCase().includes(q));
    const start = args.cursor ? ev.findIndex((e) => `${e.at}:${e.id}` === args.cursor) + 1 : 0;
    const limit = args.limit ?? 40;
    const page = ev.slice(start, start + limit);
    const last = page[page.length - 1];
    return { events: page, next: start + limit < ev.length && last ? `${last.at}:${last.id}` : null };
  }

  async historyItem(key: string): Promise<ItemDetail | null> {
    const evs = this.events().filter((e) => e.item.key === key);
    if (evs.length === 0) return null;
    const versions: VersionRow[] = evs
      .filter((e) => e.toVersion !== null)
      .map((e) => ({ id: e.toVersion!, at: e.at, source: e.source, bytes: (TEXT[e.toVersion!] ?? "").length || 480, hasCopy: e.hasCopy, sessionId: e.sessionId, agentId: null }));
    return { item: evs[0].item, firstSeenAt: evs[evs.length - 1].at, versions, events: evs.length };
  }

  async historyDiff(args: DiffArgs): Promise<HistoryDiff> {
    const after = TEXT[args.versionId];
    if (after === undefined) {
      return { kind: "text", summary: ["1 server added."], hunks: [{ skippedBefore: 0, lines: [{ kind: "add", oldNo: null, newNo: 1, text: '"docs": { "type": "http", "url": "https://example.com/mcp" }', segs: null }] }], skippedAfter: 0, added: 1, removed: 0, cut: false };
    }
    const before = args.againstVersionId !== null && args.againstVersionId !== undefined ? TEXT[args.againstVersionId] : TEXT[args.versionId - 1];
    const d = diffText(before ?? "", after);
    return before === undefined ? { ...d, summary: ["First copy kept."] } : { ...d, summary: args.versionId === 12 ? ["Changed the model to opus.", "Allowed 1 more command.", "Added 1 setting."] : ["Changed the description."] };
  }

  async historyCopyVersion(versionId: number): Promise<string> {
    return TEXT[versionId] ?? "";
  }

  async historySaveCopy(_versionId: number): Promise<string | null> {
    return "C:/Users/you/Desktop/settings.json";
  }

  async historyOpenFolder(): Promise<void> {}

  async onHistoryChanged(cb: () => void): Promise<() => void> {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Tests call this to simulate the worker finding a change. */
  poke(): void {
    this.listeners.forEach((l) => l());
  }

  async settingsOverview(): Promise<SettingsOverview> {
    return {
      claudeSettingsFile: "C:/Users/you/.claude/settings.json",
      cleanupDays: 30,
      historyBytes: 61_440,
      historyVersions: 14,
      historyItems: 9,
      keepVersions: 50,
      cacheBytes: 3_400_000,
      historyPaused: this.paused,
    };
  }
}
