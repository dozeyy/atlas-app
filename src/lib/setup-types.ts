// Mirrors crates/core/src/setup/model.rs and source.rs (camelCase on the wire).
// Checked against a real Rust-serialised sample by setup-types.test.ts.

export type ItemKind =
  | "skill"
  | "agent"
  | "command"
  | "hook"
  | "hookScript"
  | "mcpServer"
  | "plugin"
  | "settings"
  | "permission"
  | "statusLine"
  | "outputStyle"
  | "instructions"
  | "rule"
  | "autoMemory"
  | "agentMemory"
  | "workflow"
  | "keybindings"
  | "theme"
  | "other";

export type ScopeKind = "user" | "project" | "local" | "plugin" | "synced" | "managed" | "connector";

export type EnabledKind =
  | "on"
  | "off"
  | "active"
  | "inactive"
  | "shadowed"
  | "approved"
  | "rejected"
  | "pending"
  | "custom"
  | "none";

export interface Enabled {
  state: EnabledKind;
  label: string;
  raw: string | null;
}

export type ConflictStatus = "overrides" | "overridden" | "conflict" | "duplicate";

export interface DefinedIn {
  id: string;
  scopeLabel: string;
  winner: boolean;
  isSelf: boolean;
}

export interface Conflict {
  status: ConflictStatus;
  label: string;
  /** Winner first. */
  definedIn: DefinedIn[];
}

export interface DetailRow {
  label: string;
  value: string;
}

export interface ProjectState {
  projectId: string;
  projectName: string;
  on: boolean;
}

export interface McpInfo {
  transport: string;
  summary: string;
  envKeys: string[];
  headerKeys: string[];
  perProject: ProjectState[];
  onCount: number;
  totalProjects: number;
}

export interface SetupItem {
  id: string;
  kind: ItemKind;
  scope: ScopeKind;
  scopeLabel: string;
  projectId: string | null;
  plugin: string | null;
  name: string;
  description: string;
  path: string | null;
  linkTarget: string | null;
  size: number | null;
  modifiedMs: number | null;
  enabled: Enabled;
  conflict: Conflict | null;
  chips: string[];
  warnings: string[];
  detail: DetailRow[];
  attachments: string[];
  usedBy: number | null;
  mcp: McpInfo | null;
  backup: boolean;
  realProjectFile: boolean;
  hasSecrets: boolean;
  worktree: boolean;
}

export interface SetupProject {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  isHome: boolean;
  isWorktree: boolean;
  parentId: string | null;
  worktreeCount: number;
  itemCount: number;
  localMcpCount: number;
  lastActivityMs: number;
}

export interface HiddenCounts {
  worktrees: number;
  missingProjects: number;
  emptyProjects: number;
  backups: number;
}

export interface RootStatus {
  dir: string;
  dirExists: boolean;
  claudeJson: string;
  /** ok | missing | stale | unreadable */
  claudeJsonState: string;
}

export interface SetupSnapshot {
  version: number;
  root: RootStatus;
  items: SetupItem[];
  projects: SetupProject[];
  hidden: HiddenCounts;
  elapsedMs: number;
}

export interface MaskedRange {
  /** UTF-16 offsets into `text`. */
  start: number;
  end: number;
  key: string;
  index: number;
}

export interface SourceView {
  id: string;
  text: string;
  language: string;
  truncated: boolean;
  maskedRanges: MaskedRange[];
  size: number;
  lineEnding: "LF" | "CRLF";
  bom: boolean;
}
