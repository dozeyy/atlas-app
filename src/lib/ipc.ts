// The only file that talks to Rust. In a plain browser (Vite dev, tests) it
// falls back to an in-memory stand-in so every screen can be designed and
// tested without the desktop shell.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppInfo,
  Bucket,
  Dashboard,
  FilterOptions,
  IndexProgress,
  PricingInfo,
  SessionDetail,
  AgentDetail,
  ItemQuery,
  ItemUse,
  WrappedHabits,
  Receipt,
  SearchPage,
  SearchStatus,
  SessionPage,
  SessionQuery,
  Theme,
  Timeline,
  TranscriptPage,
  UsageChanged,
  UsageStatus,
  View,
} from "./types";
import type {
  CostReport,
  CreateKind,
  DeleteOutcome,
  Draft,
  DuplicateOutcome,
  Problem,
  RawEdit,
  SaveReply,
  SetupSnapshot,
  SkillFile,
  SourceView,
  UndoOutcome,
} from "./setup-types";
import type {
  DiffArgs,
  EventsArgs,
  EventsPage,
  HistoryDiff,
  HistoryOverview,
  ItemDetail,
  SettingsOverview,
} from "./historyTypes";
import type { NowFinished, NowSnapshot } from "./nowTypes";
import type { UpdateInfo, UpdateProgress } from "./updateTypes";
import { MockBackend } from "./mock";

declare global {
  interface Window {
    __ATLAS_BOOT__?: AppInfo;
    __TAURI_INTERNALS__?: unknown;
  }
}

export const INFO_EVENT = "atlas://info";
export const USAGE_STATUS_EVENT = "atlas://usage/status";
export const USAGE_PROGRESS_EVENT = "atlas://usage/progress";
export const USAGE_CHANGED_EVENT = "atlas://usage/changed";
export const SEARCH_STATUS_EVENT = "atlas://search/status";
export const NOW_UPDATE_EVENT = "atlas://now/update";
export const NOW_FINISHED_EVENT = "atlas://now/finished";
export const QUIT_ASK_EVENT = "atlas://quit-ask";
export const UPDATE_PROGRESS_EVENT = "atlas://update/progress";

export type Unlisten = () => void;

/** Claude Code connection: what Settings shows for the Atlas MCP server. */
export interface McpStatus {
  /** connected | notConnected | moved (registered to a different copy of Atlas's own connector)
   *  | foreign (the name "atlas" belongs to some other program: Atlas never touches it) */
  state: "connected" | "notConnected" | "moved" | "foreign";
  /** The program Claude's settings point at. */
  command: string | null;
  /** The connector program that ships with this Atlas (null when it is missing). */
  server: string | null;
  /** Claude Code's command was found on this computer. */
  cliFound: boolean;
  configReadable: boolean;
  /** Sandbox Mode is on: Connect is off. */
  sandbox: boolean;
}
export interface McpOutcome {
  state: Omit<McpStatus, "sandbox">;
  via: "cli" | "file" | "none";
  backupId: string | null;
}
export const SETUP_EVENT = "atlas://setup-changed";
export const HISTORY_EVENT = "atlas://history/changed";

export const inTauri = (): boolean =>
  typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;

export interface SettingsPatch {
  theme?: Theme;
  lastView?: View;
  launchAnimation?: boolean;
  /** Closing the window hides Atlas to the tray instead of quitting. */
  closeToTray?: boolean;
  /** Tell me (a toast, or a desktop notice when Atlas is behind) when a chat stops. Off by default. */
  notifyOnFinish?: boolean;
  /** Show keyboard shortcut hints in tooltips, badges and menus. Off by default. */
  showShortcuts?: boolean;
  /** Let Claude Code use Atlas (the Settings switch). Turning it off is remembered. */
  mcpAutoConnect?: boolean;
  /** Copies kept per file in History (clamped to 10-200 by the backend). */
  historyKeepVersions?: number;
}

export interface Backend {
  boot(): AppInfo;
  updateSettings(patch: SettingsPatch): Promise<AppInfo>;
  setSandbox(enabled: boolean): Promise<AppInfo>;
  chooseConfigDir(): Promise<AppInfo>;
  clearConfigDir(): Promise<AppInfo>;
  /** Shows the Claude folder Atlas reads in the file manager. */
  openConfigDir(): Promise<void>;
  /** Shows Atlas's own data folder in the file manager. */
  openDataDir(): Promise<void>;
  /** Whether an uninstaller sits beside this Atlas (a real Windows install, not a dev run). */
  uninstallAvailable(): Promise<boolean>;
  /** Reads the connection to Claude Code from Claude's own settings file. */
  mcpStatus(): Promise<McpStatus>;
  mcpConnect(): Promise<McpOutcome>;
  mcpDisconnect(): Promise<McpOutcome>;
  /** Starts the uninstaller on its own; it asks Atlas to quit once the person says yes there. */
  uninstallAtlas(): Promise<void>;
  frontendReady(): Promise<void>;
  /** The page draws the title bar, so the caption buttons ask Rust to act on the window. */
  windowControl(action: "minimize" | "toggle-maximize" | "close"): Promise<void>;
  windowMaximized(): Promise<boolean>;
  /** Tells Rust whether an editor holds edits that are not saved, so a close or quit can ask first. */
  setUnsaved(on: boolean): Promise<void>;
  /** Rust held back a quit because of unsaved edits; the page asks, and `leaveApp` carries it out. */
  onQuitAsk(cb: () => void): Promise<Unlisten>;
  /** Quit now (after the user chose Discard). */
  leaveApp(): Promise<void>;
  onInfo(cb: (info: AppInfo) => void): Promise<() => void>;

  // Usage engine. Every call is async; none blocks the page.
  usageStatus(): Promise<UsageStatus>;
  usageDashboard(): Promise<Dashboard>;
  usageTimeline(args: { from: string; to: string; bucket: Bucket; groupBy?: "model" | "project" }): Promise<Timeline>;
  sessionsList(query: SessionQuery): Promise<SessionPage>;
  sessionDetail(sessionId: string): Promise<SessionDetail | null>;
  agentDetail(sessionId: string, agentId: string): Promise<AgentDetail | null>;
  /** Where one chat's money went, and the helper tree's numbers. Read from the files once, then kept. */
  sessionReceipt(sessionId: string): Promise<Receipt | null>;
  usageByItem(query: ItemQuery): Promise<ItemUse[]>;
  /** Chat shapes, helper work and the chat with the most helpers, for Wrapped. Local days, inclusive. */
  usageWrappedHabits(args: { from: string; to: string }): Promise<WrappedHabits>;
  /**
   * Wrapped's share card: the PNG bytes and today's local day. Opens a save picker that starts in
   * Pictures; resolves to the saved path, or null when the picker was cancelled.
   */
  wrappedSaveCard(png: number[], day: string): Promise<string | null>;
  sessionTranscript(sessionId: string, cursor?: string | null, limit?: number): Promise<TranscriptPage>;
  usageFilterOptions(): Promise<FilterOptions>;
  usageReindex(scope: "changed" | "full"): Promise<UsageStatus>;
  pricingGet(): Promise<PricingInfo>;
  pricingReveal(): Promise<void>;
  /** Open the folder a chat ran in. Only the id goes over; rejects when there is no such folder. */
  sessionOpenFolder(sessionId: string): Promise<void>;
  onUsageStatus(cb: (s: UsageStatus) => void): Promise<Unlisten>;
  onUsageProgress(cb: (p: IndexProgress) => void): Promise<Unlisten>;
  onUsageChanged(cb: (c: UsageChanged) => void): Promise<Unlisten>;

  // Chat search: full text over every past chat (user and assistant text). Ranked, with a
  // short masked snippet per hit; a helper's messages belong to the parent session.
  searchChats(query: string, limit?: number, offset?: number): Promise<SearchPage>;
  searchStatus(): Promise<SearchStatus>;
  onSearchStatus(cb: (s: SearchStatus) => void): Promise<Unlisten>;

  // Now: the chats running right now, followed read-only. Pushed as events; the page never polls.
  nowSnapshot(): Promise<NowSnapshot>;
  onNowUpdate(cb: (s: NowSnapshot) => void): Promise<Unlisten>;
  /** A chat Atlas watched working has stopped. Only sent while "Tell me when a chat finishes" is on. */
  onNowFinished(cb: (f: NowFinished) => void): Promise<Unlisten>;

  /** Setup: the whole setup without file bodies. */
  setupSnapshot(includeWorktrees?: boolean): Promise<SetupSnapshot>;
  /** What each part of the setup costs over the last week (estimates, read only). */
  setupCost(): Promise<CostReport>;
  /** The masked text of one item. */
  setupReadSource(id: string): Promise<SourceView>;
  /** One masked value, on request. */
  setupReveal(id: string, index: number): Promise<string>;
  onSetupChanged(cb: (version: number) => void): Promise<() => void>;
  /** The editable text of one item (text with secrets is empty until `reveal`). */
  setupItemRaw(id: string, reveal?: boolean, file?: string): Promise<RawEdit>;
  /** What is wrong with `text` as this item's content (empty = fine). */
  setupValidate(id: string, text: string, file?: string): Promise<Problem[]>;
  /** Backup, atomic write, read back. `conflict` when the file changed on disk. */
  setupSave(id: string, text: string, stamp: string, force?: boolean, file?: string): Promise<SaveReply>;
  /** The files inside a skill's folder, SKILL.md first (empty for anything else). */
  setupSkillFiles(id: string): Promise<SkillFile[]>;
  /** Show an item's file in the file manager (`open` false) or open it in the default editor (`open` true). */
  setupOpenFile(id: string, file: string | undefined, open: boolean): Promise<void>;
  /** Copy a user skill to a new folder name. Never over an existing one. */
  setupDuplicate(id: string, name: string): Promise<DuplicateOutcome>;
  /** Back up the whole item, then delete it. */
  setupDelete(id: string): Promise<DeleteOutcome>;
  /** Put a deleted item back exactly as it was. */
  setupUndo(backupId: string): Promise<UndoOutcome>;
  /** A starting text for something new; nothing is written yet. */
  setupCreateDraft(kind: CreateKind, name: string, event?: string): Promise<Draft>;
  /** Write the new item (never over an existing one). */
  setupCreate(kind: CreateKind, name: string, event: string | undefined, text: string): Promise<DeleteOutcome>;
  /** What is wrong with `text` as a new item's content (nothing is written). */
  setupValidateDraft(kind: CreateKind, name: string, event: string | undefined, text: string): Promise<Problem[]>;

  // History: Atlas's own record of how the setup changed. Read-only here; copies are masked.
  /** Totals, the 30-day ribbon and the project list. null while History is paused (Sandbox Mode). */
  historyOverview(): Promise<HistoryOverview | null>;
  historyEvents(args: EventsArgs): Promise<EventsPage>;
  historyItem(key: string): Promise<ItemDetail | null>;
  historyDiff(args: DiffArgs): Promise<HistoryDiff>;
  /** The masked text of one copy, for the clipboard. */
  historyCopyVersion(versionId: number): Promise<string>;
  /** Asks where to put a copy and writes it there. The path, or null when cancelled. */
  historySaveCopy(versionId: number): Promise<string | null>;
  historyOpenFolder(): Promise<void>;
  onHistoryChanged(cb: () => void): Promise<Unlisten>;
  /** Sizes and Claude Code's own cleanup setting, for the Settings page. */
  settingsOverview(): Promise<SettingsOverview>;

  // Updates: Atlas asks whether a newer version exists and installs it only when told to.
  /** The newer version, or null when this one is current. Rejects with one plain sentence. */
  updateCheck(): Promise<UpdateInfo | null>;
  /** Download, verify and install what the last check found, then start the new version. Resolves only on failure (the app is gone otherwise). */
  updateInstall(): Promise<void>;
  onUpdateProgress(cb: (p: UpdateProgress) => void): Promise<Unlisten>;
}

const tauriBackend: Backend = {
  boot: () => window.__ATLAS_BOOT__ as AppInfo,
  updateSettings: (patch) => invoke<AppInfo>("update_settings", { patch }),
  setSandbox: (enabled) => invoke<AppInfo>("set_sandbox", { enabled }),
  chooseConfigDir: () => invoke<AppInfo>("choose_config_dir"),
  clearConfigDir: () => invoke<AppInfo>("clear_config_dir"),
  openConfigDir: () => invoke<void>("open_config_dir"),
  openDataDir: () => invoke<void>("open_data_dir"),
  uninstallAvailable: () => invoke<boolean>("uninstall_available"),
  uninstallAtlas: () => invoke<void>("uninstall_atlas"),
  mcpStatus: () => invoke<McpStatus>("mcp_status"),
  mcpConnect: () => invoke<McpOutcome>("mcp_connect"),
  mcpDisconnect: () => invoke<McpOutcome>("mcp_disconnect"),
  frontendReady: async () => {
    await invoke("frontend_ready");
  },
  windowControl: (action) => invoke<void>("window_control", { action }),
  windowMaximized: () => invoke<boolean>("window_maximized"),
  setUnsaved: (on) => invoke<void>("set_unsaved", { on }),
  onQuitAsk: (cb) => listen<null>(QUIT_ASK_EVENT, () => cb()),
  leaveApp: () => invoke<void>("leave_app"),
  onInfo: async (cb) => {
    const off = await listen<AppInfo>(INFO_EVENT, (e) => cb(e.payload));
    return off;
  },

  usageStatus: () => invoke<UsageStatus>("usage_status"),
  usageDashboard: () => invoke<Dashboard>("usage_dashboard"),
  usageTimeline: (a) => invoke<Timeline>("usage_timeline", a),
  sessionsList: (query) => invoke<SessionPage>("sessions_list", { query }),
  sessionDetail: (sessionId) => invoke<SessionDetail | null>("session_detail", { sessionId }),
  agentDetail: (sessionId, agentId) => invoke<AgentDetail | null>("usage_agent_detail", { sessionId, agentId }),
  sessionReceipt: (sessionId) => invoke<Receipt | null>("session_receipt", { sessionId }),
  usageByItem: (query) => invoke<ItemUse[]>("usage_by_item", { query }),
  usageWrappedHabits: (args) => invoke<WrappedHabits>("usage_wrapped_habits", args),
  wrappedSaveCard: (png, day) => invoke<string | null>("wrapped_save_card", { png, day }),
  sessionTranscript: (sessionId, cursor = null, limit = 50) =>
    invoke<TranscriptPage>("session_transcript", { sessionId, cursor, limit }),
  usageFilterOptions: () => invoke<FilterOptions>("usage_filter_options"),
  usageReindex: (scope) => invoke<UsageStatus>("usage_reindex", { scope }),
  pricingGet: () => invoke<PricingInfo>("pricing_get"),
  pricingReveal: async () => {
    await invoke("pricing_reveal");
  },
  sessionOpenFolder: async (sessionId) => {
    await invoke("session_open_folder", { sessionId });
  },
  onUsageStatus: (cb) => listen<UsageStatus>(USAGE_STATUS_EVENT, (e) => cb(e.payload)),
  onUsageProgress: (cb) => listen<IndexProgress>(USAGE_PROGRESS_EVENT, (e) => cb(e.payload)),
  onUsageChanged: (cb) => listen<UsageChanged>(USAGE_CHANGED_EVENT, (e) => cb(e.payload)),
  searchChats: (query, limit = 20, offset = 0) => invoke<SearchPage>("search_chats", { query, limit, offset }),
  searchStatus: () => invoke<SearchStatus>("search_status"),
  onSearchStatus: (cb) => listen<SearchStatus>(SEARCH_STATUS_EVENT, (e) => cb(e.payload)),
  nowSnapshot: () => invoke<NowSnapshot>("now_snapshot"),
  onNowUpdate: (cb) => listen<NowSnapshot>(NOW_UPDATE_EVENT, (e) => cb(e.payload)),
  onNowFinished: (cb) => listen<NowFinished>(NOW_FINISHED_EVENT, (e) => cb(e.payload)),
  setupSnapshot: (includeWorktrees) => invoke<SetupSnapshot>("setup_snapshot", { includeWorktrees }),
  setupCost: () => invoke<CostReport>("setup_cost"),
  setupReadSource: (id) => invoke<SourceView>("setup_read_source", { id }),
  setupReveal: (id, index) => invoke<string>("setup_reveal", { id, index }),
  setupItemRaw: (id, reveal, file) => invoke<RawEdit>("setup_item_raw", { id, reveal, file }),
  setupValidate: (id, text, file) => invoke<Problem[]>("setup_validate", { id, text, file }),
  setupSave: (id, text, stamp, force, file) => invoke<SaveReply>("setup_save", { id, text, stamp, force, file }),
  setupSkillFiles: (id) => invoke<SkillFile[]>("setup_skill_files", { id }),
  setupOpenFile: (id, file, open) => invoke<void>("setup_open_file", { id, file, open }),
  setupDuplicate: (id, name) => invoke<DuplicateOutcome>("setup_duplicate", { id, name }),
  setupDelete: (id) => invoke<DeleteOutcome>("setup_delete", { id }),
  setupUndo: (backupId) => invoke<UndoOutcome>("setup_undo", { backupId }),
  setupCreateDraft: (kind, name, event) => invoke<Draft>("setup_create_draft", { kind, name, event }),
  setupValidateDraft: (kind, name, event, text) => invoke<Problem[]>("setup_validate_draft", { kind, name, event, text }),
  setupCreate: (kind, name, event, text) => invoke<DeleteOutcome>("setup_create", { kind, name, event, text }),
  onSetupChanged: async (cb) => {
    const off = await listen<{ version: number }>(SETUP_EVENT, (e) => cb(e.payload.version));
    return off;
  },
  historyOverview: () =>
    invoke<HistoryOverview | null>("history_overview", { offsetMin: -new Date().getTimezoneOffset() }),
  historyEvents: (args) => invoke<EventsPage>("history_events", { args }),
  historyItem: (key) => invoke<ItemDetail | null>("history_item", { key }),
  historyDiff: (args) => invoke<HistoryDiff>("history_diff", { args }),
  historyCopyVersion: (versionId) => invoke<string>("history_copy_version", { versionId }),
  historySaveCopy: (versionId) => invoke<string | null>("history_save_copy", { versionId }),
  historyOpenFolder: async () => {
    await invoke("history_open_folder");
  },
  onHistoryChanged: (cb) => listen(HISTORY_EVENT, () => cb()),
  settingsOverview: () => invoke<SettingsOverview>("settings_overview"),
  updateCheck: () => invoke<UpdateInfo | null>("update_check"),
  updateInstall: async () => {
    await invoke("update_install");
  },
  onUpdateProgress: (cb) => listen<UpdateProgress>(UPDATE_PROGRESS_EVENT, (e) => cb(e.payload)),
};

/** macOS menu bar (crates/app/src/macmenu.rs): the id of the picked Atlas item. */
export const MENU_EVENT = "atlas://menu";

/**
 * Calls `cb` with the id of each macOS menu bar item the user picks ("settings", "about" and the
 * Help sheet ids). Other platforms and the browser never send one.
 */
export async function onNativeMenu(cb: (id: string) => void): Promise<Unlisten> {
  if (!inTauri()) return () => {};
  return listen<string>(MENU_EVENT, (e) => cb(e.payload));
}

/** The macOS proof run's screenshot tour (crates/app/src/tour.rs). Debug builds only. */
export function tourStep(action: "size" | "capture" | "log" | "done", arg = ""): Promise<void> {
  return invoke<void>("tour_step", { action, arg });
}

let backend: Backend | null = null;

export function getBackend(): Backend {
  if (!backend) {
    backend = inTauri() && window.__ATLAS_BOOT__ ? tauriBackend : new MockBackend();
  }
  return backend;
}

/** Tests install their own backend. */
export function setBackend(b: Backend | null): void {
  backend = b;
}
