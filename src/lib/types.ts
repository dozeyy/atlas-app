// Mirrors crates/app/src/state.rs (AppInfo) and crates/core (Settings, sandbox).

export type Theme = "system" | "light" | "dark";
export type View = "dashboard" | "sessions" | "setup" | "history" | "wrapped" | "settings";
export type Platform = "windows" | "macos" | "linux";
export type ConfigSource = "flag" | "settings" | "env" | "default" | "sandbox";

export interface Settings {
  schemaVersion: number;
  theme: Theme;
  lastView: View;
  configDirOverride: string | null;
  sandbox: boolean;
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
  reason: "sensitive" | "bulk" | "tooLarge" | "overBudget" | "folderLink" | "unreadable";
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
  version: string;
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
  firstPaintMs: number | null;
}

export const VIEWS: View[] = ["dashboard", "sessions", "setup", "history", "wrapped", "settings"];

export * from "./usageTypes";
