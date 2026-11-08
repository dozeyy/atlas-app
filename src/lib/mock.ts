// In-memory stand-in for the Rust side: used in a plain browser and in tests.
// Settings persist in localStorage only so a browser reload keeps your choices.

import type { Backend, SettingsPatch } from "./ipc";
import type { AppInfo, ConfigView, Platform, Settings } from "./types";
import type { CostReport, CreateKind, DeleteOutcome, Draft, Problem, RawEdit, SaveReply, SetupSnapshot, SourceView, UndoOutcome } from "./setup-types";
import { MockSetupWorld, mockSetupReveal, mockSetupSource } from "./setup-mock";
import { mockCostReport } from "./setup-cost-mock";
import { MockUsage } from "./mockUsage";
import { MockSearch } from "./mockSearch";
import { MockHistory } from "./mockHistory";
import { MockNow } from "./mockNow";

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
    closeToTray: false,
    historyKeepVersions: 50,
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
    build: "release",
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
  /** The made-up setup and its edits; tests reach in to simulate outside changes. */
  readonly world = new MockSetupWorld();

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

  async openConfigDir(): Promise<void> {}
  async openDataDir(): Promise<void> {}

  async frontendReady(): Promise<void> {}
  async windowControl(_action: "minimize" | "toggle-maximize" | "close"): Promise<void> {}
  async windowMaximized(): Promise<boolean> {
    return false;
  }

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

  // ---- chat search: the stand-in lives in mockSearch.ts ----
  readonly search = new MockSearch();
  searchChats: Backend["searchChats"] = (q, limit, offset) => this.search.searchChats(q, limit, offset);
  searchStatus: Backend["searchStatus"] = () => this.search.searchStatus();
  onSearchStatus: Backend["onSearchStatus"] = (cb) => this.search.onSearchStatus(cb);

  // ---- history: the stand-in lives in mockHistory.ts ----
  readonly history = new MockHistory();
  historyOverview: Backend["historyOverview"] = () => this.history.historyOverview();
  historyEvents: Backend["historyEvents"] = (a) => this.history.historyEvents(a);
  historyItem: Backend["historyItem"] = (k) => this.history.historyItem(k);
  historyDiff: Backend["historyDiff"] = (a) => this.history.historyDiff(a);
  historyCopyVersion: Backend["historyCopyVersion"] = (v) => this.history.historyCopyVersion(v);
  historySaveCopy: Backend["historySaveCopy"] = (v) => this.history.historySaveCopy(v);
  historyOpenFolder: Backend["historyOpenFolder"] = () => this.history.historyOpenFolder();
  onHistoryChanged: Backend["onHistoryChanged"] = (cb) => this.history.onHistoryChanged(cb);
  settingsOverview: Backend["settingsOverview"] = async () => ({
    ...(await this.history.settingsOverview()),
    keepVersions: this.info.settings.historyKeepVersions,
  });
  // ---- Now: the stand-in lives in mockNow.ts ----
  readonly now = new MockNow();
  nowSnapshot: Backend["nowSnapshot"] = () => this.now.nowSnapshot();
  onNowUpdate: Backend["onNowUpdate"] = (cb) => this.now.onNowUpdate(cb);

  async onInfo(cb: (i: AppInfo) => void): Promise<() => void> {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async setupSnapshot(includeWorktrees = false): Promise<SetupSnapshot> {
    return this.world.snapshot(includeWorktrees);
  }

  async setupCost(): Promise<CostReport> {
    return mockCostReport(this.world.snapshot(false).items);
  }

  async setupReadSource(id: string): Promise<SourceView> {
    try {
      return this.world.source(id);
    } catch {
      return mockSetupSource(id);
    }
  }

  async setupReveal(id: string, index: number): Promise<string> {
    return mockSetupReveal(id, index);
  }

  async onSetupChanged(cb: (version: number) => void): Promise<() => void> {
    let v = 1;
    return this.world.onChange(() => cb(++v));
  }

  async setupItemRaw(id: string, reveal = false): Promise<RawEdit> {
    return this.world.raw(id, reveal);
  }

  async setupValidate(id: string, text: string): Promise<Problem[]> {
    return this.world.validate(id, text);
  }

  async setupSave(id: string, text: string, stamp: string, force = false): Promise<SaveReply> {
    return this.world.save(id, text, stamp, force);
  }

  async setupDelete(id: string): Promise<DeleteOutcome> {
    return this.world.delete(id);
  }

  async setupUndo(backupId: string): Promise<UndoOutcome> {
    return this.world.undo(backupId);
  }

  async setupCreateDraft(kind: CreateKind, name: string, event?: string): Promise<Draft> {
    return this.world.draft(kind, name, event);
  }

  async setupValidateDraft(kind: CreateKind, name: string, event: string | undefined, text: string): Promise<Problem[]> {
    return this.world.validateDraft(kind, name, event, text);
  }

  async setupCreate(kind: CreateKind, name: string, event: string | undefined, text: string): Promise<DeleteOutcome> {
    return this.world.create(kind, name, event, text);
  }
}
