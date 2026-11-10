// History shapes. Mirrors crates/core/src/history (serde camelCase).

export type ChangeKind = "added" | "changed" | "removed" | "renamed" | "dated";
export type ChangeSource = "atlas_snapshot" | "claude_backup" | "claude_edit" | "atlas_mcp" | "atlas_assistant" | "atlas_library" | "file_date";

/** Filter groups, in the order the chips show them. */
export type HistoryGroup = "settings" | "skills" | "agents" | "hooks" | "mcp" | "instructions" | "other";

export interface ItemRef {
  key: string;
  kind: string;
  scope: string;
  project: string | null;
  name: string;
  path: string;
  gone: boolean;
}

export interface HistoryEvent {
  id: number;
  /** ms since the epoch. */
  at: number;
  kind: ChangeKind;
  source: ChangeSource;
  summary: string;
  item: ItemRef;
  fromVersion: number | null;
  toVersion: number | null;
  /** A copy of the new side is kept, so a diff can be shown. */
  hasCopy: boolean;
  sessionId: string | null;
}

export interface EventsArgs {
  groups?: HistoryGroup[];
  project?: string | null;
  text?: string | null;
  cursor?: string | null;
  limit?: number;
}

export interface EventsPage {
  events: HistoryEvent[];
  next: string | null;
}

export interface DayCount {
  /** Start of the local day, ms since the epoch. */
  day: number;
  count: number;
}

export interface HistoryOverview {
  items: number;
  versions: number;
  events: number;
  /** Changes Atlas saw itself (not from Claude's own copies or file dates). */
  watchedEvents: number;
  /** When Atlas first looked, 0 when it has not yet. */
  watchingSince: number;
  bytes: number;
  /** The last 30 local days, oldest first. */
  days: DayCount[];
  projects: string[];
  keepVersions: number;
}

export interface VersionRow {
  id: number;
  at: number;
  source: ChangeSource;
  bytes: number;
  hasCopy: boolean;
  sessionId: string | null;
  agentId: string | null;
}

export interface ItemDetail {
  item: ItemRef;
  firstSeenAt: number;
  /** Newest first. */
  versions: VersionRow[];
  events: number;
}

export interface DiffSeg {
  t: string;
  /** This part is what changed inside the line. */
  c: boolean;
}

export interface DiffLine {
  kind: "same" | "add" | "del";
  oldNo: number | null;
  newNo: number | null;
  text: string;
  segs: DiffSeg[] | null;
}

export interface DiffHunk {
  skippedBefore: number;
  lines: DiffLine[];
}

export interface HistoryDiff {
  kind: "text" | "same" | "binary" | "tooLarge" | "missing";
  summary: string[];
  hunks: DiffHunk[];
  skippedAfter: number;
  added: number;
  removed: number;
  cut: boolean;
}

export interface DiffArgs {
  versionId: number;
  againstVersionId?: number | null;
  /** Compare the picked copy with what is on disk now. */
  againstCurrent?: boolean;
  context?: number;
}

/** Facts the Settings page shows that are not settings. */
export interface SettingsOverview {
  claudeSettingsFile: string | null;
  /** How many days Claude Code keeps its chat logs (its own setting), when it says. */
  cleanupDays: number | null;
  historyBytes: number;
  historyVersions: number;
  historyItems: number;
  keepVersions: number;
  cacheBytes: number;
  historyPaused: boolean;
}
