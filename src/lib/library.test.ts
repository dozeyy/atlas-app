import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import {
  ALL,
  COMMAND_SOURCE,
  DIRECTORY,
  INSTALLED,
  NO_CLI,
  buildRows,
  indexEntries,
  insideWords,
  installBlock,
  installSummary,
  isStale,
  mpId,
  parseGithub,
  searchEntries,
  sourceOptions,
  toolkitIdFor,
  updatedWords,
} from "./library";
import type { CatalogEntry, InstalledRow } from "./libraryTypes";

// The captured catalog (3,602 directory plugins + one local marketplace entry), the same file the
// Rust tests read.
function fixture(): CatalogEntry[] {
  const raw = gunzipSync(readFileSync(resolve(__dirname, "../../fixtures/library/catalog-available.json.gz"))).toString("utf8");
  const list = JSON.parse(raw).available as Record<string, unknown>[];
  return list.map((e) => ({
    pluginId: String(e.pluginId),
    name: String(e.name),
    description: typeof e.description === "string" ? e.description : "",
    marketplace: String(e.marketplaceName),
    version: typeof e.version === "string" ? e.version : "",
    source: { kind: "command" as const },
  }));
}

const entry = (name: string, description = "", marketplace = DIRECTORY): CatalogEntry => ({
  pluginId: `${name}@${marketplace}`,
  name,
  description,
  marketplace,
  version: "1.0.0",
  source: { kind: "github", repo: `o/${name}` },
});

describe("Library search", () => {
  const entries = fixture();
  const idx = indexEntries(entries);

  it("reads the whole captured catalog", () => {
    expect(entries.length).toBe(3603);
  });

  it("puts frontend-design first for 'frontend', like the connector's search_library", () => {
    expect(searchEntries(idx, "frontend")[0]!.name).toBe("frontend-design");
  });

  it("ranks an exact name, then a name that starts with the words, then names, then the rest", () => {
    const mini = indexEntries([
      entry("pdf", "Work with files"),
      entry("pdf-tools", "Merge pages"),
      entry("docs", "Fill out a pdf form"),
      entry("a-pdf-thing", "x"),
      entry("zzz", "x", "pdf-market"),
    ]);
    expect(searchEntries(mini, "pdf").map((e) => e.name)).toEqual(["pdf", "pdf-tools", "a-pdf-thing", "zzz", "docs"]);
  });

  it("needs every word to start some word of the entry", () => {
    const mini = indexEntries([entry("code-review", "Review a pull request"), entry("code-golf", "Short programs")]);
    expect(searchEntries(mini, "code rev").map((e) => e.name)).toEqual(["code-review"]);
    expect(searchEntries(mini, "code xyz")).toEqual([]);
  });

  it("lists everything A to Z when nothing is typed", () => {
    const all = searchEntries(idx, "");
    expect(all.length).toBe(3603);
    const names = all.slice(0, 50).map((e) => e.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("answers in 16 ms or less at the 95th percentile over the whole catalog (D13)", () => {
    const queries = ["f", "fr", "front", "frontend", "frontend des", "code", "code review", "pdf", "git", "github", "sql", "test", "react", "mcp", "security", "design", "docs", "api", "deploy", "a", "e", "py", "type", "lint", "slack", "notion", "figma", "zzzz", "review pull", "go"];
    for (const q of queries) searchEntries(idx, q); // warm the engine, as a few keystrokes would
    const ms: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (const q of queries) {
        const t = performance.now();
        searchEntries(idx, q);
        ms.push(performance.now() - t);
      }
    }
    ms.sort((a, b) => a - b);
    const p95 = ms[Math.floor(ms.length * 0.95)]!;
    expect(p95).toBeLessThanOrEqual(16);
  });
});

describe("Library rows and sources", () => {
  const a = entry("alpha", "First");
  const b = entry("beta", "Second", "community");
  const idx = indexEntries([a, b]);
  const plugin: InstalledRow = { kind: "plugin", id: a.pluginId, name: "alpha", itemKind: "", enabled: true, version: "1.0.0", path: null, repo: "", backupId: "b1", changed: false };
  const item: InstalledRow = { kind: "item", id: "skill:tidy", name: "tidy", itemKind: "skill", enabled: null, version: null, path: "C:/x/skills/tidy", repo: "o/r", backupId: "b2", changed: false };

  it("counts the rail: All, Installed, the directory, then each added marketplace", () => {
    const o = sourceOptions([a, b], [{ name: "empty-one", source: "", installLocation: null }], 2);
    expect(o.map((x) => [x.id, x.label, x.count])).toEqual([
      [ALL, "All", 2],
      [INSTALLED, "Installed", 2],
      [mpId(DIRECTORY), "Claude plugin directory", 1],
      [mpId("community"), "community", 1],
      [mpId("empty-one"), "empty-one", 0],
    ]);
  });

  it("marks catalog rows that are installed and filters by marketplace", () => {
    const rows = buildRows({ idx, installed: [plugin], source: ALL, query: "" });
    expect(rows.map((r) => r.type === "plugin" && r.installed !== null)).toEqual([true, false]);
    expect(buildRows({ idx, installed: [plugin], source: mpId("community"), query: "" }).map((r) => r.key)).toEqual([b.pluginId]);
  });

  it("the Installed filter lists plugins and copied items, filtered by the typed words", () => {
    const rows = buildRows({ idx, installed: [plugin, item], source: INSTALLED, query: "" });
    expect(rows.map((r) => r.key)).toEqual([a.pluginId, "item:b2"]);
    expect(buildRows({ idx, installed: [plugin, item], source: INSTALLED, query: "tid" }).map((r) => r.key)).toEqual(["item:b2"]);
  });

  it("says why a plugin cannot be installed", () => {
    expect(installBlock({ ...a, source: { kind: "command" } }, true)).toBe(COMMAND_SOURCE);
    expect(installBlock(a, false)).toBe(NO_CLI);
    expect(installBlock(a, true)).toBeNull();
  });
});

describe("Library words", () => {
  it("says how old the catalog is, and when it is stale", () => {
    const now = 10 * 24 * 3600_000;
    expect(updatedWords(null, now)).toBe("Not loaded yet");
    expect(updatedWords(now - 5_000, now)).toBe("Updated just now");
    expect(updatedWords(now - 3 * 60_000, now)).toBe("Updated 3 min ago");
    expect(updatedWords(now - 2 * 3600_000, now)).toBe("Updated 2 h ago");
    expect(updatedWords(now - 4 * 24 * 3600_000, now)).toBe("Updated 4 days ago");
    const view = (fetchedMs: number | null) => ({ entries: [], fetchedMs, nowMs: now, cli: true, sandbox: false, marketplaces: [], stale: false });
    expect(isStale(view(now - 5 * 3600_000), now)).toBe(false);
    expect(isStale(view(now - 7 * 3600_000), now)).toBe(true);
    expect(isStale(view(null), now)).toBe(true);
  });

  it("reads GitHub links the way Check needs", () => {
    expect(parseGithub("github.com/owner/repo")).toBe("owner/repo");
    expect(parseGithub("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(parseGithub("https://github.com/owner/repo/tree/main/skills/x")).toBe("owner/repo");
    expect(parseGithub("owner/repo")).toBe("owner/repo");
    expect(parseGithub("not a link")).toBeNull();
    expect(parseGithub("")).toBeNull();
  });

  it("counts what is inside and sums up an install", () => {
    expect(insideWords([{ kind: "skill" }, { kind: "skill" }, { kind: "agent" }])).toBe("2 skills, 1 agent");
    expect(installSummary([{ kind: "skill", name: "a", ok: true, backupId: "", path: null, message: "" }])).toBe("Installed a.");
    expect(
      installSummary([
        { kind: "skill", name: "a", ok: true, backupId: "", path: null, message: "" },
        { kind: "agent", name: "b", ok: false, backupId: "", path: null, message: "You already have one called b." },
      ]),
    ).toBe("Installed 1 of 2 items. You already have one called b.");
  });

  it("finds the Toolkit item for a copied file or folder", () => {
    const items = [
      { id: "skill:1", path: "C:\\Users\\me\\.claude\\skills\\tidy\\SKILL.md" },
      { id: "agent:2", path: "C:\\Users\\me\\.claude\\agents\\rev.md" },
    ];
    expect(toolkitIdFor(items, "c:/users/me/.claude/skills/tidy")).toBe("skill:1");
    expect(toolkitIdFor(items, "C:\\Users\\me\\.claude\\agents\\rev.md")).toBe("agent:2");
    expect(toolkitIdFor(items, "C:\\elsewhere")).toBeNull();
    expect(toolkitIdFor(items, null)).toBeNull();
  });
});
