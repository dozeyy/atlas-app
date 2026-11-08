// In-memory stand-in for the Rust side: used in a plain browser and in tests.
// Settings persist in localStorage only so a browser reload keeps your choices.

import type { SettingsPatch } from "./ipc";
import type { AppInfo, ConfigView, Platform, Settings } from "./types";

const KEY = "atlas.mock.settings";

function view(dir: string, source: ConfigView["source"]): ConfigView {
  return {
    dir,
    claudeJson: `${dir}/.claude.json`,
    projectsDir: `${dir}/projects`,
    source,
    dirExists: true,
    claudeJsonExists: true,
    projectsExists: true,
    projectsReadOnly: false,
  };
}

function loadSettings(): Settings {
  const base: Settings = {
    schemaVersion: 1,
    theme: "system",
    lastView: "dashboard",
    configDirOverride: null,
    sandbox: false,
    launchAnimation: true,
  };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return base;
  }
}

export function mockInfo(overrides: Partial<AppInfo> = {}, platform: Platform = "windows"): AppInfo {
  const real = view("C:/Users/you/.claude", "default");
  return {
    seq: 0,
    version: "0.1.0",
    platform,
    backdrop: false,
    dataDir: "C:/Users/you/AppData/Roaming/atlas",
    config: real,
    realConfig: real,
    sandbox: { enabled: false, state: "off", error: null, path: null, report: null },
    configLockedByFlag: false,
    settings: loadSettings(),
    settingsNote: null,
    settingsSaveError: null,
    firstPaintMs: null,
    ...overrides,
  };
}

export class MockBackend {
  private info: AppInfo = mockInfo();
  private listeners = new Set<(i: AppInfo) => void>();

  boot(): AppInfo {
    return this.info;
  }

  private commit(change: AppInfo): AppInfo {
    const next = { ...change, seq: this.info.seq + 1 };
    this.info = next;
    try {
      localStorage.setItem(KEY, JSON.stringify(next.settings));
    } catch {
      /* private mode: fine */
    }
    this.listeners.forEach((l) => l(next));
    return next;
  }

  async updateSettings(patch: SettingsPatch): Promise<AppInfo> {
    return this.commit({ ...this.info, settings: { ...this.info.settings, ...patch } });
  }

  async setSandbox(enabled: boolean): Promise<AppInfo> {
    const settings = { ...this.info.settings, sandbox: enabled };
    if (!enabled) {
      return this.commit({
        ...this.info,
        settings,
        config: this.info.realConfig,
        sandbox: { enabled: false, state: "off", error: null, path: null, report: null },
      });
    }
    const pending = this.commit({
      ...this.info,
      settings,
      config: null,
      sandbox: { enabled: true, state: "preparing", error: null, path: null, report: null },
    });
    setTimeout(() => {
      const copy = view("C:/Users/you/AppData/Local/Temp/atlas-sandbox-1", "sandbox");
      this.commit({
        ...this.info,
        config: { ...copy, projectsDir: this.info.realConfig.projectsDir, projectsReadOnly: true },
        sandbox: {
          enabled: true,
          state: "ready",
          error: null,
          path: copy.dir,
          report: {
            filesCopied: 214,
            foldersCopied: 38,
            bytesCopied: 1_480_000,
            skippedTotal: 9,
            skipped: [],
            claudeJsonCopied: true,
          },
        },
      });
    }, 600);
    return pending;
  }

  async chooseConfigDir(): Promise<AppInfo> {
    const dir = "C:/Users/you/Documents/other-claude";
    const settings = { ...this.info.settings, configDirOverride: dir };
    const cfg = view(dir, "settings");
    return this.commit({ ...this.info, settings, config: cfg, realConfig: cfg });
  }

  async clearConfigDir(): Promise<AppInfo> {
    const settings = { ...this.info.settings, configDirOverride: null };
    const cfg = view("C:/Users/you/.claude", "default");
    return this.commit({ ...this.info, settings, config: cfg, realConfig: cfg });
  }

  async frontendReady(): Promise<void> {}

  async onInfo(cb: (i: AppInfo) => void): Promise<() => void> {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
