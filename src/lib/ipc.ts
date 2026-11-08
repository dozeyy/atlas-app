// The only file that talks to Rust. In a plain browser (Vite dev, tests) it
// falls back to an in-memory stand-in so every screen can be designed and
// tested without the desktop shell.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppInfo, Theme, View } from "./types";
import type { SetupSnapshot, SourceView } from "./setup-types";
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
  /** Setup (read only): the whole setup without file bodies. */
  setupSnapshot(includeWorktrees?: boolean): Promise<SetupSnapshot>;
  /** The masked text of one item. */
  setupReadSource(id: string): Promise<SourceView>;
  /** One masked value, on request. */
  setupReveal(id: string, index: number): Promise<string>;
  onSetupChanged(cb: (version: number) => void): Promise<() => void>;
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
