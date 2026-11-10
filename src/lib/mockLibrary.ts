// Stand-in for the Library commands, for tests and screenshots in a plain browser. A small seed
// catalog, an in-memory "installed" list and a few switches a test or the address bar can flip:
//   ?library=offline   the catalog cannot be reached
//   ?cli=0             Claude Code's command is not on this computer
//   ?flagged=1         every plugin check finds something
// Nothing here touches a disk or the network.

import type {
  CatalogAll,
  CatalogEntry,
  CatalogView,
  FileText,
  InstalledRow,
  Inspected,
  ItemResult,
  LibraryDetail,
  LibraryProgress,
  MarketAdded,
  Pick,
  PluginOutcome,
  PluginSource,
  SafetyReport,
  UndoDone,
  Shaped,
} from "./libraryTypes";

const DIR = "anthropic-plugin-directory";

/** What the backend keeps per plugin: the slim entry plus its source (the page only gets the slim part). */
export type MockEntry = CatalogEntry & { source: PluginSource };

const seed = (name: string, description: string, marketplace = DIR, source: PluginSource | null = null): MockEntry => ({
  pluginId: `${name}@${marketplace}`,
  name,
  description,
  marketplace,
  version: "1.0.0",
  byCommand: source?.kind === "command",
  source: source ?? { kind: "github", repo: `example/${name}`, sha: null, path: null },
});

export const SEED_CATALOG: MockEntry[] = [
  seed("frontend-design", "Create distinctive, production-grade frontend interfaces with high design quality."),
  seed("code-review", "Review a pull request for bugs, regressions and style."),
  seed("pdf-tools", "Read, merge, split and fill PDF files."),
  seed("commit-commands", "Commit, push and open a pull request in one step."),
  seed("security-guidance", "Reminds Claude of common security mistakes while it edits files."),
  seed("feature-dev", "A guided workflow for building a feature from idea to tests."),
  seed("explanatory-output-style", "Adds short notes on why Claude chose a pattern.", DIR),
  seed("playwright", "Drive a browser to check a page works.", DIR),
  seed("github", "Work with issues and pull requests from the chat.", DIR),
  seed("typescript-lsp", "Language server for TypeScript.", DIR),
  seed("plugin-dev", "Tools for writing your own plugin."),
  seed("hookify", "Turn a repeated correction into a rule."),
  seed("learning-output-style", "Interactive learning mode that asks you to write key parts."),
  seed("agent-sdk-dev", "Start and check a new Agent SDK app."),
  seed("pr-review-toolkit", "A set of focused reviewers for a pull request."),
  seed("ralph-loop", "Run a task in a loop until it passes.", DIR, { kind: "command" }),
  seed("terraform", "Plan and review infrastructure changes.", "community-tools"),
  seed("sql-helper", "Write and explain database queries.", "community-tools"),
  seed("release-notes", "Draft release notes from a range of commits.", "community-tools"),
];

const GOOD: SafetyReport = {
  flags: [],
  summary: "Text only. Nothing here runs on its own.",
  caption: "Atlas read every file for patterns it knows. This is not a promise that a plugin is safe.",
  treeHash: "0".repeat(64),
  files: 3,
};

const FLAGGED: SafetyReport = {
  flags: [
    {
      code: "runs_commands",
      words: "Runs commands on your computer when it is used.",
      evidence: [{ path: "hooks/hooks.json", line: 6, excerpt: '"command": "node scripts/format.js"' }],
    },
    {
      code: "reaches_network",
      words: "Can reach the internet.",
      evidence: [{ path: "scripts/format.js", line: 12, excerpt: "fetch(url)" }],
    },
  ],
  summary: "2 things to look at before you install.",
  caption: GOOD.caption,
  treeHash: "1".repeat(64),
  files: 5,
};

const fromUrl = () => {
  try {
    const q = new URLSearchParams(window.location.search);
    return { offline: q.get("library") === "offline", cli: q.get("cli") !== "0", flagged: q.get("flagged") === "1" };
  } catch {
    return { offline: false, cli: true, flagged: false };
  }
};

export class MockLibrary {
  entries: MockEntry[] = SEED_CATALOG.slice();
  cli: boolean;
  offline: boolean;
  /** Every plugin check finds something. */
  flagged: boolean;
  fetchedMs: number | null = null;
  installed: InstalledRow[] = [];
  /** Milliseconds each slow step takes (a test sets 0). */
  delay = 120;
  /** Rows in the first catalog answer; more entries than this and the rest comes from libraryCatalogAll. */
  firstPage = Number.POSITIVE_INFINITY;
  /** A test reads what was asked. */
  calls: string[] = [];
  perf: number[] = [];
  /** Plugin ids that fail to install, for the error sentence. */
  failInstall = new Set<string>();
  private marketplaces: { name: string; source: string; installLocation: string | null }[] = [];
  private tokens = new Map<string, LibraryDetail>();
  private n = 0;
  private progress = new Set<(p: LibraryProgress) => void>();

  constructor() {
    const u = fromUrl();
    this.cli = u.cli;
    this.offline = u.offline;
    this.flagged = u.flagged;
  }

  private wait = (ms = this.delay) => new Promise<void>((r) => setTimeout(r, ms));
  private log(s: string) {
    this.calls.push(s);
  }

  private view(): CatalogView {
    const slim = this.entries.map(({ source: _source, ...e }) => e);
    const counts: Record<string, number> = {};
    for (const e of slim) counts[e.marketplace] = (counts[e.marketplace] ?? 0) + 1;
    return {
      entries: slim,
      total: slim.length,
      counts,
      partial: false,
      fetchedMs: this.fetchedMs,
      nowMs: Date.now(),
      cli: this.cli,
      sandbox: false,
      marketplaces: this.marketplaces,
      stale: this.fetchedMs === null || Date.now() - this.fetchedMs > 6 * 3600_000,
    };
  }

  async libraryCatalog(): Promise<CatalogView> {
    this.log("catalog");
    // The first look is the saved copy: nothing fetched yet unless an earlier refresh ran.
    if (this.fetchedMs === null && !this.offline) this.fetchedMs = Date.now() - 20 * 60_000;
    if (this.offline && this.fetchedMs === null) return { ...this.view(), entries: [], total: 0, counts: {} };
    const v = this.view();
    // Like the real backend: past one page, the first call carries only the first rows.
    if (v.entries.length > this.firstPage) {
      const first = v.entries.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, this.firstPage);
      return { ...v, entries: first, partial: true };
    }
    return v;
  }

  async libraryCatalogAll(): Promise<CatalogAll> {
    this.log("catalog-all");
    return { fetchedMs: this.fetchedMs, entries: this.view().entries };
  }

  async libraryRefresh(marketplace?: string): Promise<CatalogView> {
    this.log(`refresh${marketplace ? `:${marketplace}` : ""}`);
    await this.wait();
    if (this.offline) throw new Error(OFFLINE_ERR);
    this.fetchedMs = Date.now();
    return this.view();
  }

  async libraryInstalled(): Promise<InstalledRow[]> {
    this.log("installed");
    return this.installed.slice();
  }

  private detail(repo: string, shaped: Shaped, flagged: boolean, marketSource: string | null = null): LibraryDetail {
    const inspected: Inspected = { shaped, check: flagged ? FLAGGED : GOOD };
    const d: LibraryDetail = { token: `tok-${++this.n}`, repo, sha: "a1b2c3d4e5f6", subpath: null, inspected, taken: [], marketSource };
    this.tokens.set(d.token, d);
    return d;
  }

  private pluginShape(e: CatalogEntry): Shaped {
    return {
      shape: "plugin",
      name: e.name,
      description: e.description,
      plugins: [],
      items: [
        { kind: "skill", name: e.name, rel: `skills/${e.name}`, isDir: true },
        { kind: "command", name: "run", rel: "commands/run.md", isDir: false },
      ],
      notInstalled: [],
    };
  }

  async libraryInspectPlugin(pluginId: string): Promise<LibraryDetail> {
    this.log(`inspect:${pluginId}`);
    const e = this.entries.find((x) => x.pluginId === pluginId);
    if (!e) throw new Error("Atlas could not find that plugin.");
    await this.wait();
    if (this.offline) throw new Error(OFFLINE_ERR);
    const repo = e.source.kind === "github" ? e.source.repo : "";
    return this.detail(repo, this.pluginShape(e), this.flagged);
  }

  async libraryInspectInstalled(id: string): Promise<LibraryDetail> {
    this.log(`inspect-installed:${id}`);
    const row = this.installed.find((x) => x.id === id);
    const e = this.entries.find((x) => x.pluginId === id);
    return this.detail(row?.repo ?? "", this.pluginShape(e ?? seed(row?.name ?? id, "")), false);
  }

  async libraryInspectLink(text: string): Promise<LibraryDetail> {
    this.log(`link:${text}`);
    const m = /github\.com\/([\w.-]+)\/([\w.-]+)/i.exec(text) ?? /^([\w.-]+)\/([\w.-]+)$/.exec(text.trim());
    if (!m) throw new Error("That is not a GitHub link Atlas understands. Try github.com/owner/repo.");
    const repo = `${m[1]}/${m[2]}`;
    await this.wait();
    if (this.offline) throw new Error(OFFLINE_ERR);
    if (/market/i.test(repo)) {
      const shaped: Shaped = {
        shape: "marketplace",
        name: m[2]!,
        description: "A set of plugins.",
        plugins: [
          { name: "alpha", description: "The first plugin." },
          { name: "beta", description: "The second plugin." },
        ],
        items: [],
        notInstalled: [],
      };
      return this.detail(repo, shaped, false, repo);
    }
    const shaped: Shaped = {
      shape: "loose",
      name: m[2]!,
      description: "",
      plugins: [],
      items: [
        { kind: "skill", name: "tidy-notes", rel: "skills/tidy-notes", isDir: true },
        { kind: "agent", name: "reviewer", rel: "agents/reviewer.md", isDir: false },
        { kind: "command", name: "ship", rel: "commands/ship.md", isDir: false },
      ],
      notInstalled: [{ what: "1 hook", path: "hooks/hooks.json" }],
    };
    const d = this.detail(repo, shaped, this.flagged);
    d.taken = [{ kind: "command", name: "ship", message: "You already have one called ship." }];
    return d;
  }

  async libraryReadFile(token: string, rel: string): Promise<FileText> {
    this.log(`read:${token}:${rel}`);
    if (!this.tokens.has(token)) throw new Error("Check it again first.");
    return { text: `---\nname: example\ndescription: Shown from ${rel}\n---\n\nDo the thing carefully.\n`, truncated: false };
  }

  async libraryInstallPlugin(pluginId: string, token: string): Promise<PluginOutcome> {
    this.log(`install:${pluginId}`);
    if (!this.tokens.has(token)) throw new Error("Check it again first.");
    this.emit({ label: pluginId, downloaded: 1_200_000, total: null });
    await this.wait();
    if (this.failInstall.has(pluginId)) throw new Error("Claude Code could not install it. Nothing changed.");
    const e = this.entries.find((x) => x.pluginId === pluginId);
    this.installed.push({
      kind: "plugin",
      id: pluginId,
      name: e?.name ?? pluginId,
      itemKind: "",
      enabled: true,
      version: e?.version ?? null,
      path: null,
      repo: "",
      backupId: `b-${this.n}`,
      changed: false,
    });
    return { id: pluginId, backupId: `b-${this.n}`, installPath: null, version: e?.version ?? null, changed: false };
  }

  /** Plugin rows that were removed, by backup id, so an Undo can bring one back. */
  private removed = new Map<string, InstalledRow>();

  async libraryUninstallPlugin(id: string): Promise<string> {
    this.log(`uninstall:${id}`);
    await this.wait(40);
    const row = this.installed.find((x) => x.id === id);
    this.installed = this.installed.filter((x) => x.id !== id);
    const backupId = `b-${++this.n}`;
    if (row) this.removed.set(backupId, row);
    return backupId;
  }

  async libraryUndo(backupId: string): Promise<UndoDone> {
    this.log(`undo:${backupId}`);
    await this.wait(40);
    const row = this.removed.get(backupId);
    if (row) {
      this.removed.delete(backupId);
      this.installed.push(row);
      return { id: row.id, name: row.name, did: "install", backupId: `b-${++this.n}` };
    }
    const hit = this.installed.find((x) => x.kind === "plugin" && x.backupId === backupId);
    if (!hit) throw new Error("That change can't be undone from here.");
    this.installed = this.installed.filter((x) => x !== hit);
    return { id: hit.id, name: hit.name, did: "uninstall", backupId: `b-${++this.n}` };
  }

  async librarySetEnabled(id: string, on: boolean): Promise<void> {
    this.log(`enabled:${id}:${on}`);
    this.installed = this.installed.map((x) => (x.id === id ? { ...x, enabled: on } : x));
  }

  async libraryAddMarketplace(token: string): Promise<MarketAdded> {
    this.log("add-marketplace");
    const d = this.tokens.get(token);
    if (!d) throw new Error("Check it again first.");
    await this.wait();
    const name = d.inspected.shaped.name;
    this.marketplaces.push({ name, source: d.repo, installLocation: null });
    this.entries = this.entries.concat(d.inspected.shaped.plugins.map((p) => seed(p.name, p.description, name)));
    return { name, backupId: `b-${++this.n}`, catalog: this.view() };
  }

  async libraryInstallItems(token: string, picks: Pick[]): Promise<ItemResult[]> {
    this.log(`items:${picks.map((p) => p.name).join(",")}`);
    const d = this.tokens.get(token);
    if (!d) throw new Error("Check it again first.");
    await this.wait();
    const out: ItemResult[] = [];
    for (const p of picks) {
      const backupId = `b-${++this.n}`;
      this.installed.push({ kind: "item", id: `${p.kind}:${p.name}`, name: p.name, itemKind: p.kind, enabled: null, version: null, path: null, repo: d.repo, backupId, changed: false });
      out.push({ kind: p.kind, name: p.name, ok: true, backupId, path: null, message: "" });
    }
    return out;
  }

  async libraryRemoveItem(backupId: string): Promise<void> {
    this.log(`remove:${backupId}`);
    this.installed = this.installed.filter((x) => x.backupId !== backupId);
  }

  async libraryOpenRepo(repo: string): Promise<void> {
    this.log(`open:${repo}`);
  }

  async libraryCancel(): Promise<void> {
    this.log("cancel");
  }

  libraryPerf(ms: number): void {
    this.perf.push(ms);
  }

  async onLibraryProgress(cb: (p: LibraryProgress) => void): Promise<() => void> {
    this.progress.add(cb);
    return () => this.progress.delete(cb);
  }

  private emit(p: LibraryProgress) {
    for (const cb of this.progress) cb(p);
  }
}

const OFFLINE_ERR = "Atlas could not reach the plugin catalog. Check your connection and press Refresh.";
