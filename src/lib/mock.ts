// In-memory stand-in for the Rust side: used in a plain browser and in tests.
// Settings persist in localStorage only so a browser reload keeps your choices.

import type { AppInfo, ConfigView, Platform, Settings, Theme, View } from "./types";
import type { Backend } from "./ipc";
import { MockUsage } from "./mockUsage";

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

  private commit(next: AppInfo): AppInfo {
    this.info = next;
    try {
      localStorage.setItem(KEY, JSON.stringify(next.settings));
    } catch {
      /* private mode: fine */
    }
    this.listeners.forEach((l) => l(next));
    return next;
  }

  async updateSettings(patch: { theme?: Theme; lastView?: View }): Promise<AppInfo> {
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

  // ---- usage: the stand-in lives in mockUsage.ts so this file stays small ----
  readonly usage = new MockUsage();
  usageStatus = () => this.usage.usageStatus();
  usageDashboard = () => this.usage.usageDashboard();
  usageTimeline: Backend["usageTimeline"] = (a) => this.usage.usageTimeline(a);
  sessionsList: Backend["sessionsList"] = (q) => this.usage.sessionsList(q);
  sessionDetail: Backend["sessionDetail"] = (id) => this.usage.sessionDetail(id);
  agentDetail: Backend["agentDetail"] = (s, a) => this.usage.agentDetail(s, a);
  usageByItem: Backend["usageByItem"] = (q) => this.usage.usageByItem(q);
  sessionTranscript: Backend["sessionTranscript"] = (id, c, l) => this.usage.sessionTranscript(id, c, l);
  usageFilterOptions = () => this.usage.usageFilterOptions();
  usageReindex: Backend["usageReindex"] = () => this.usage.usageReindex();
  pricingGet = () => this.usage.pricingGet();
  pricingReveal = () => this.usage.pricingReveal();
  onUsageStatus: Backend["onUsageStatus"] = (cb) => this.usage.onUsageStatus(cb);
  onUsageProgress: Backend["onUsageProgress"] = (cb) => this.usage.onUsageProgress(cb);
  onUsageChanged: Backend["onUsageChanged"] = (cb) => this.usage.onUsageChanged(cb);

  async onInfo(cb: (i: AppInfo) => void): Promise<() => void> {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
