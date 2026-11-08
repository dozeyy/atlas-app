// The only file that talks to Rust. In a plain browser (Vite dev, tests) it
// falls back to an in-memory stand-in so every screen can be designed and
// tested without the desktop shell.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppInfo, Theme, View } from "./types";
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
import type { UsageRow } from "./usage-types";
import { MockBackend } from "./mock";

declare global {
  interface Window {
    __ATLAS_BOOT__?: AppInfo;
    __TAURI_INTERNALS__?: unknown;
  }
}

export const INFO_EVENT = "atlas://info";
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
  frontendReady(): Promise<void>;
  onInfo(cb: (info: AppInfo) => void): Promise<() => void>;
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
  /** Usage per item. Absent until the usage engine is connected. */
  usageRows?(): Promise<UsageRow[] | null>;
}

const tauriBackend: Backend = {
  boot: () => window.__ATLAS_BOOT__ as AppInfo,
  updateSettings: (patch) => invoke<AppInfo>("update_settings", { patch }),
  setSandbox: (enabled) => invoke<AppInfo>("set_sandbox", { enabled }),
  chooseConfigDir: () => invoke<AppInfo>("choose_config_dir"),
  clearConfigDir: () => invoke<AppInfo>("clear_config_dir"),
  frontendReady: async () => {
    await invoke("frontend_ready");
  },
  onInfo: async (cb) => {
    const off = await listen<AppInfo>(INFO_EVENT, (e) => cb(e.payload));
    return off;
  },
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
