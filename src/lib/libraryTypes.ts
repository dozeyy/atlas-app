// What the Library commands (crates/app/src/library.rs) send. Camel-case mirrors of the Rust
// structs; nothing here is computed on the page.

export type PluginSource =
  | { kind: "github"; repo: string; sha?: string | null; path?: string | null; gitRef?: string | null }
  | { kind: "local"; path: string }
  | { kind: "command" }
  | { kind: "other"; url: string };

export interface CatalogEntry {
  /** `name@marketplace`: the row's key. */
  pluginId: string;
  name: string;
  description: string;
  marketplace: string;
  version: string;
  /** Installing it runs a command: Atlas does not offer it. (The full source stays in Rust.) */
  byCommand: boolean;
}

/** Every entry, slim: sent after the first rows are painted. */
export interface CatalogAll {
  fetchedMs: number | null;
  entries: CatalogEntry[];
}

export interface MarketplaceInfo {
  name: string;
  /** `owner/repo` for GitHub, the folder for a directory, else empty. */
  source: string;
  installLocation: string | null;
}

export interface CatalogView {
  /** Every entry, or (when `partial`) the first page in the list's order. */
  entries: CatalogEntry[];
  /** The whole catalog's size and its size per marketplace (the source rail). */
  total: number;
  counts: Record<string, number>;
  /** `entries` is only the first page; `libraryCatalogAll` has the rest. */
  partial: boolean;
  /** When the cache was made; null until the first refresh. */
  fetchedMs: number | null;
  nowMs: number;
  /** Claude Code's command is on this computer. */
  cli: boolean;
  /** Sandbox Mode: installs go to the copy. */
  sandbox: boolean;
  marketplaces: MarketplaceInfo[];
  /** Older than six hours (or missing): refresh in the background. */
  stale: boolean;
}

/** One line of the Installed filter: a plugin Claude Code has, or an item the Library copied. */
export interface InstalledRow {
  kind: "plugin" | "item";
  id: string;
  name: string;
  /** For an item: skill | agent | command | outputStyle | mcpServer. */
  itemKind: string;
  /** Plugins only. */
  enabled: boolean | null;
  version: string | null;
  path: string | null;
  repo: string;
  backupId: string;
  /** The installed files are not the ones that were checked. */
  changed: boolean;
}

export interface EvidenceLine {
  path: string;
  line: number | null;
  excerpt: string;
}

export interface SafetyFlag {
  code: string;
  /** The words on screen. */
  words: string;
  evidence: EvidenceLine[];
}

export interface SafetyReport {
  flags: SafetyFlag[];
  /** "Text only. Nothing here runs on its own." when there are no flags. */
  summary: string;
  caption: string;
  treeHash: string;
  files: number;
}

export type ItemKind = "skill" | "agent" | "command" | "outputStyle" | "mcpServer";

export interface InnerItem {
  kind: ItemKind | string;
  name: string;
  rel: string;
  isDir: boolean;
  key?: string | null;
}

export interface Shaped {
  shape: "marketplace" | "plugin" | "loose" | "nothing";
  name: string;
  description: string;
  plugins: { name: string; description: string }[];
  items: InnerItem[];
  notInstalled: { what: string; path: string }[];
}

export interface Inspected {
  shaped: Shaped;
  check: SafetyReport;
}

export interface Taken {
  kind: string;
  name: string;
  message: string;
}

/** What opening a plugin, an installed plugin or a pasted link gives back. */
export interface LibraryDetail {
  /** Names this look in later calls (the page never passes a path). */
  token: string;
  /** `owner/repo` ("" for a plugin that lives inside its marketplace). */
  repo: string;
  sha: string;
  subpath: string | null;
  inspected: Inspected;
  /** Items whose names are already in the user's folder (never replaced). */
  taken: Taken[];
  /** The folder is a marketplace that can be added (its `owner/repo`). */
  marketSource: string | null;
}

export interface FileText {
  text: string;
  truncated: boolean;
}

export interface PluginOutcome {
  id: string;
  backupId: string;
  installPath: string | null;
  version: string | null;
  /** The installed files are not the ones that were checked. */
  changed: boolean;
}

/** What an Undo of a plugin change did (`did` is what was done now). */
export interface UndoDone {
  id: string;
  name: string;
  did: "install" | "uninstall";
  backupId: string;
}

export interface ItemResult {
  kind: string;
  name: string;
  ok: boolean;
  backupId: string;
  path: string | null;
  message: string;
}

export interface MarketAdded {
  name: string;
  backupId: string;
  catalog: CatalogView;
}

export interface LibraryProgress {
  label: string;
  downloaded: number;
  total: number | null;
}

export interface Pick {
  kind: string;
  name: string;
}
