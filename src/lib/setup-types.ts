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
  /** Atlas can open this in the editor and save it. */
  editable: boolean;
  /** Atlas can delete it (backup first, Undo after). */
  deletable: boolean;
  /** Why Atlas will not change it; shown instead of the delete control. */
  locked: string | null;
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

// ---- changing things (setup_write.rs in core, setup_service.rs in the app) ----

/** The text of one item for the editor. Text with secrets stays empty until asked for. */
export interface RawEdit {
  id: string;
  text: string;
  language: string;
  /** What is on disk now; sent back on save so a change made meanwhile is noticed. */
  stamp: string;
  lineEnding: "LF" | "CRLF";
  bom: boolean;
  path: string;
  hasSecrets: boolean;
  needsReveal: boolean;
  /** For skills: the folder name the frontmatter name must equal. */
  folderName: string | null;
}

/** One file inside a skill's folder (SKILL.md first). */
export interface SkillFile {
  /** Path inside the skill folder, with `/`. */
  rel: string;
  size: number;
  language: string;
  /** SKILL.md itself. */
  main: boolean;
  /** Atlas can open it in the editor. */
  editable: boolean;
}

export interface DuplicateOutcome {
  name: string;
  path: string;
}

export interface Problem {
  message: string;
  /** 1-based, when known. */
  line: number | null;
}

export interface SaveReply {
  status: "saved" | "conflict";
  stamp: string | null;
  backupId: string | null;
}

export interface DeleteOutcome {
  backupId: string;
  name: string;
  kind: string;
  note: string | null;
}

export interface UndoOutcome {
  name: string;
  kind: string;
  /** The backup the undo was made from (set by the connector; the app ignores it). */
  backupId?: string | null;
}

export type CreateKind = "instructions" | "skill" | "agent" | "command" | "rule" | "outputStyle" | "hook" | "mcpServer";

export interface Draft {
  kind: string;
  name: string;
  title: string;
  path: string;
  language: string;
  text: string;
  folderName: string | null;
  whereNote: string;
}

/** One thing that costs context, from `setup_cost` (crates/core/src/setup/cost.rs). */
export interface CostRow {
  /** The setup item it is, when it is one (parent-folder files and tool groups are not). */
  id: string | null;
  name: string;
  /** An `ItemKind` string. */
  kind: string;
  scopeLabel: string;
  /** "All chats", "Chats in app", "Chats under Games". */
  loadsIn: string;
  global: boolean;
  path: string | null;
  /** Tokens added to every turn it loads in (0 = none). */
  tokens: number;
  /** Turns it loaded in during the window. */
  turns: number;
  usdLoaded: number;
  /** Tokens it adds when it runs (0 = it never runs on demand). */
  bodyTokens: number;
  /** Times it ran in the window; null when Atlas cannot tell. */
  uses: number | null;
  usdUsed: number;
  usdWeek: number;
  /** Counted from a real prompt (tools) instead of from a file. */
  measured: boolean;
}

export interface CostReport {
  windowDays: number;
  charsPerToken: number;
  turns: number;
  /** Tokens that load on every turn of every chat. */
  globalTokens: number;
  usdWeek: number;
  /** Some turns could not be priced, or there is no usage yet: dollars are a floor. */
  incomplete: boolean;
  /** Most expensive first. */
  rows: CostRow[];
}
