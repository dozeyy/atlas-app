// Mirrors crates/app/src/state.rs (AppInfo) and crates/core (Settings, sandbox).

/** "system" follows the OS (Light or Dark); the other three are pinned. */
export type Theme = "system" | "light" | "silver" | "dark";
export type View = "dashboard" | "now" | "sessions" | "setup" | "history" | "wrapped" | "settings";
export type Platform = "windows" | "macos" | "linux";
export type ConfigSource = "flag" | "settings" | "env" | "default" | "sandbox";

export interface Settings {
  schemaVersion: number;
  theme: Theme;
  lastView: View;
  configDirOverride: string | null;
  sandbox: boolean;
  launchAnimation: boolean;
  /** Closing the window hides Atlas to the tray instead of quitting (default off). */
  closeToTray: boolean;
  /** Tell me when a chat finishes or asks a question (default off). */
  notifyOnFinish: boolean;
  /** Show keyboard shortcut hints in tooltips, badges and menus (default off). */
  showShortcuts: boolean;
  /** How many copies of each file History keeps (10 to 200). */
  historyKeepVersions: number;
}

export interface ConfigView {
  dir: string;
  claudeJson: string;
  projectsDir: string;
  source: ConfigSource;
  dirExists: boolean;
  claudeJsonExists: boolean;
  projectsExists: boolean;
  projectsReadOnly: boolean;
}

export interface SkippedItem {
  path: string;
  reason: "sensitive" | "bulk" | "tooLarge" | "overBudget" | "folderLink" | "fileLink" | "unreadable";
}

export interface SandboxReport {
  filesCopied: number;
  foldersCopied: number;
  bytesCopied: number;
  skippedTotal: number;
  skipped: SkippedItem[];
  claudeJsonCopied: boolean;
}

export interface SandboxView {
  enabled: boolean;
  state: "off" | "preparing" | "ready" | "failed";
  error: string | null;
  path: string | null;
  report: SandboxReport | null;
}

export interface AppInfo {
  /** Rises with every snapshot from Rust; an older one is stale and ignored. */
  seq: number;
  version: string;
  /** "debug" or "release". */
  build: string;
  platform: Platform;
  backdrop: boolean;
  dataDir: string;
  /** null while a sandbox is being prepared or failed: Atlas never falls back to the real folder. */
  config: ConfigView | null;
  realConfig: ConfigView;
  sandbox: SandboxView;
  configLockedByFlag: boolean;
  settings: Settings;
  settingsNote: string | null;
  /** The last write of Atlas's settings failed: what was changed will not survive a restart. */
  settingsSaveError: string | null;
  firstPaintMs: number | null;
}

export const VIEWS: View[] = ["dashboard", "now", "sessions", "setup", "history", "wrapped", "settings"];

export * from "./usageTypes";
export * from "./searchTypes";
