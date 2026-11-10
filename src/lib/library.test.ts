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
  INSTALLED_HEAD,
  buildList,
  buildRows,
  indexEntries,
  insideWords,
  installBlock,
  installSummary,
  isStale,
  changedCount,
  mpId,
  parseGithub,
  rowName,
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
    byCommand: true,
  }));
}

const entry = (name: string, description = "", marketplace = DIRECTORY): CatalogEntry => ({
  pluginId: `${name}@${marketplace}`,
  name,
  description,
  marketplace,
  version: "1.0.0",
  byCommand: false,
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
    const o = sourceOptions(2, { [DIRECTORY]: 1, community: 1 }, [{ name: "empty-one", source: "", installLocation: null }], 2);
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

  it("with nothing typed, keeps the catalog's own order, the directory before added marketplaces", () => {
    // The captured file lists a local marketplace entry first, then the directory in its own (ranked) order.
    const captured = fixture();
    expect(captured[0]!.marketplace).not.toBe(DIRECTORY);
    const rows = buildRows({ idx: indexEntries(captured), installed: [], source: ALL, query: "" });
    expect(rows.slice(0, 3).map((r) => rowName(r))).toEqual(["superpowers", "frontend-design", "design"]);
    expect(rows.at(-1)!.key).toBe(captured[0]!.pluginId);
    expect(rows).toHaveLength(captured.length);
    // One marketplace on its own keeps its order too, and typed words still rank by match.
    const z = entry("zulu", "Last letter, listed first");
    const own = indexEntries([z, a, b]);
    expect(buildRows({ idx: own, installed: [], source: mpId(DIRECTORY), query: "" }).map((r) => rowName(r))).toEqual(["zulu", "alpha"]);
    expect(buildRows({ idx: own, installed: [], source: ALL, query: "alp" }).map((r) => rowName(r))).toEqual(["alpha"]);
  });

  it("the Installed filter puts what changed since it was checked first", () => {
    const z = entry("zulu", "Last");
    const changed: InstalledRow = { ...plugin, id: z.pluginId, name: "zulu", backupId: "b3", changed: true };
    const rows = buildRows({ idx: indexEntries([a, b, z]), installed: [plugin, item, changed], source: INSTALLED, query: "" });
    expect(rows.map((r) => r.key)).toEqual([z.pluginId, a.pluginId, "item:b2"]);
  });

  it("the Installed source says how many changed, counting only plugins the list can show as changed", () => {
    const z = entry("zulu", "Last");
    const changed: InstalledRow = { ...plugin, id: z.pluginId, name: "zulu", backupId: "b3", changed: true };
    const gone: InstalledRow = { ...plugin, id: "left@nowhere", name: "left", backupId: "b4", changed: true }; // no longer in the catalog: no chip on its row
    const n = changedCount(indexEntries([a, b, z]), [plugin, item, changed, gone]);
    expect(n).toBe(1);
    const flag = (count: number) => sourceOptions(3, {}, [], 4, count).find((o) => o.id === INSTALLED)?.flag;
    expect(flag(1)).toEqual({ short: "1 changed", full: "1 changed since you checked it" });
    expect(flag(2)?.full).toBe("2 changed since you checked them");
    expect(flag(0)).toBeUndefined();
    expect(sourceOptions(3, {}, [], 4, 2).filter((o) => o.flag)).toHaveLength(1);
  });

  it("under All with nothing typed: what you have first, then each marketplace under its own heading", () => {
    const z = entry("zulu", "Last");
    const c = entry("gamma", "Third", "community");
    const all = indexEntries([c, a, z, b]);
    const changed: InstalledRow = { ...plugin, id: b.pluginId, name: "beta", backupId: "b3", changed: true };
    const have: InstalledRow = { ...plugin, id: z.pluginId, name: "zulu", backupId: "b4" };
    const list = buildList({ idx: all, installed: [have, changed], source: ALL, query: "" });
    // Changed first among the installed, then the directory in its own order, then the others.
    expect(list.rows.map((r) => rowName(r))).toEqual(["beta", "zulu", "alpha", "gamma"]);
    expect(list.heads).toEqual([
      { at: 0, label: INSTALLED_HEAD },
      { at: 2, label: "Claude plugin directory" },
      { at: 3, label: "community" },
    ]);
    // The heading says where a row is from, so the row does not.
    expect(list.showSource).toBe(false);
  });

  it("no headings when they would say nothing, and the source back on the row when plugins from several places mix", () => {
    const one = buildList({ idx: indexEntries([a, entry("zulu")]), installed: [], source: ALL, query: "" });
    expect(one.heads).toEqual([]); // one group: a heading over the whole list is noise
    const typed = buildList({ idx, installed: [plugin], source: ALL, query: "alp" });
    expect(typed.heads).toEqual([]); // typed words rank by match, across sources
    expect(typed.showSource).toBe(true);
    const single = buildList({ idx, installed: [plugin], source: mpId("community"), query: "" });
    expect(single.heads).toEqual([]);
    expect(single.showSource).toBe(false); // the rail already says which one
    expect(buildList({ idx, installed: [plugin, item], source: INSTALLED, query: "" }).showSource).toBe(true);
  });

  it("says why a plugin cannot be installed", () => {
    expect(installBlock({ ...a, byCommand: true }, true)).toBe(COMMAND_SOURCE);
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
    const view = (fetchedMs: number | null) => ({ entries: [], total: 0, counts: {}, partial: false, fetchedMs, nowMs: now, cli: true, sandbox: false, marketplaces: [], stale: false });
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
