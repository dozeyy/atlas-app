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
  CreateKind,
  DeleteOutcome,
  Draft,
  Problem,
  RawEdit,
  SaveReply,
  SetupSnapshot,
  SourceView,
  UndoOutcome,
} from "./setup-types";
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

export type Unlisten = () => void;
export const SETUP_EVENT = "atlas://setup-changed";

export const inTauri = (): boolean =>
  typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;

export interface SettingsPatch {
  theme?: Theme;
  lastView?: View;
  launchAnimation?: boolean;
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
  frontendReady(): Promise<void>;
  /** The page draws the title bar, so the caption buttons ask Rust to act on the window. */
  windowControl(action: "minimize" | "toggle-maximize" | "close"): Promise<void>;
  windowMaximized(): Promise<boolean>;
  onInfo(cb: (info: AppInfo) => void): Promise<() => void>;

  // Usage engine. Every call is async; none blocks the page.
  usageStatus(): Promise<UsageStatus>;
  usageDashboard(): Promise<Dashboard>;
  usageTimeline(args: { from: string; to: string; bucket: Bucket; groupBy?: "model" | "project" }): Promise<Timeline>;
  sessionsList(query: SessionQuery): Promise<SessionPage>;
  sessionDetail(sessionId: string): Promise<SessionDetail | null>;
  agentDetail(sessionId: string, agentId: string): Promise<AgentDetail | null>;
  usageByItem(query: ItemQuery): Promise<ItemUse[]>;
  sessionTranscript(sessionId: string, cursor?: string | null, limit?: number): Promise<TranscriptPage>;
  usageFilterOptions(): Promise<FilterOptions>;
  usageReindex(scope: "changed" | "full"): Promise<UsageStatus>;
  pricingGet(): Promise<PricingInfo>;
  pricingReveal(): Promise<void>;
  onUsageStatus(cb: (s: UsageStatus) => void): Promise<Unlisten>;
  onUsageProgress(cb: (p: IndexProgress) => void): Promise<Unlisten>;
  onUsageChanged(cb: (c: UsageChanged) => void): Promise<Unlisten>;
  /** Setup: the whole setup without file bodies. */
  setupSnapshot(includeWorktrees?: boolean): Promise<SetupSnapshot>;
  /** The masked text of one item. */
  setupReadSource(id: string): Promise<SourceView>;
  /** One masked value, on request. */
  setupReveal(id: string, index: number): Promise<string>;
  onSetupChanged(cb: (version: number) => void): Promise<() => void>;
  /** The editable text of one item (text with secrets is empty until `reveal`). */
  setupItemRaw(id: string, reveal?: boolean): Promise<RawEdit>;
  /** What is wrong with `text` as this item's content (empty = fine). */
  setupValidate(id: string, text: string): Promise<Problem[]>;
  /** Backup, atomic write, read back. `conflict` when the file changed on disk. */
  setupSave(id: string, text: string, stamp: string, force?: boolean): Promise<SaveReply>;
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
}

const tauriBackend: Backend = {
  boot: () => window.__ATLAS_BOOT__ as AppInfo,
  updateSettings: (patch) => invoke<AppInfo>("update_settings", { patch }),
  setSandbox: (enabled) => invoke<AppInfo>("set_sandbox", { enabled }),
  chooseConfigDir: () => invoke<AppInfo>("choose_config_dir"),
  clearConfigDir: () => invoke<AppInfo>("clear_config_dir"),
  openConfigDir: () => invoke<void>("open_config_dir"),
  openDataDir: () => invoke<void>("open_data_dir"),
  frontendReady: async () => {
    await invoke("frontend_ready");
  },
  windowControl: (action) => invoke<void>("window_control", { action }),
  windowMaximized: () => invoke<boolean>("window_maximized"),
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
  usageByItem: (query) => invoke<ItemUse[]>("usage_by_item", { query }),
  sessionTranscript: (sessionId, cursor = null, limit = 50) =>
    invoke<TranscriptPage>("session_transcript", { sessionId, cursor, limit }),
  usageFilterOptions: () => invoke<FilterOptions>("usage_filter_options"),
  usageReindex: (scope) => invoke<UsageStatus>("usage_reindex", { scope }),
  pricingGet: () => invoke<PricingInfo>("pricing_get"),
  pricingReveal: async () => {
    await invoke("pricing_reveal");
  },
  onUsageStatus: (cb) => listen<UsageStatus>(USAGE_STATUS_EVENT, (e) => cb(e.payload)),
  onUsageProgress: (cb) => listen<IndexProgress>(USAGE_PROGRESS_EVENT, (e) => cb(e.payload)),
  onUsageChanged: (cb) => listen<UsageChanged>(USAGE_CHANGED_EVENT, (e) => cb(e.payload)),
  setupSnapshot: (includeWorktrees) => invoke<SetupSnapshot>("setup_snapshot", { includeWorktrees }),
  setupReadSource: (id) => invoke<SourceView>("setup_read_source", { id }),
  setupReveal: (id, index) => invoke<string>("setup_reveal", { id, index }),
  setupItemRaw: (id, reveal) => invoke<RawEdit>("setup_item_raw", { id, reveal }),
  setupValidate: (id, text) => invoke<Problem[]>("setup_validate", { id, text }),
  setupSave: (id, text, stamp, force) => invoke<SaveReply>("setup_save", { id, text, stamp, force }),
  setupDelete: (id) => invoke<DeleteOutcome>("setup_delete", { id }),
  setupUndo: (backupId) => invoke<UndoOutcome>("setup_undo", { backupId }),
  setupCreateDraft: (kind, name, event) => invoke<Draft>("setup_create_draft", { kind, name, event }),
  setupValidateDraft: (kind, name, event, text) => invoke<Problem[]>("setup_validate_draft", { kind, name, event, text }),
  setupCreate: (kind, name, event, text) => invoke<DeleteOutcome>("setup_create", { kind, name, event, text }),
  onSetupChanged: async (cb) => {
    const off = await listen<{ version: number }>(SETUP_EVENT, (e) => cb(e.payload.version));
    return off;
  },
};

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
