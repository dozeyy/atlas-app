// The Library's pure model: search over the catalog, the source filters, the rows the list draws and
// the plain sentences around them. No React and no IPC here, so every rule has a test.

import type { CatalogEntry, CatalogView, InstalledRow, Inspected, ItemResult, MarketplaceInfo } from "./libraryTypes";

/** Claude Code's own marketplace. */
export const DIRECTORY = "anthropic-plugin-directory";
/** The catalog is asked for again when the saved copy is older than this. */
export const STALE_MS = 6 * 60 * 60 * 1000;

export const NO_CLI = "Needs Claude Code's command to install plugins.";
export const COMMAND_SOURCE = "This plugin installs by running a command. Atlas does not run those.";
export const OFFLINE = "Atlas could not reach the plugin catalog. Check your connection and press Refresh.";

// ---- search ------------------------------------------------------------------------------------

/** An entry with its words split once, so a keystroke only compares. */
export interface Indexed {
  e: CatalogEntry;
  name: string;
  nameT: string[];
  mpT: string[];
  allT: string[];
}

export function tokens(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of s.toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(ch)) cur += ch;
    else if (cur) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function indexEntries(entries: CatalogEntry[]): Indexed[] {
  return entries.map((e) => {
    const nameT = tokens(e.name);
    const mpT = nameT.concat(tokens(e.marketplace));
    return { e, name: e.name.toLowerCase(), nameT, mpT, allT: mpT.concat(tokens(e.description)) };
  });
}

const allPrefix = (words: string[], toks: string[]) => words.every((w) => toks.some((t) => t.startsWith(w)));

/** Lower is better; -1 means no match. The same rules as the connector's `search_library`. */
function rank(x: Indexed, words: string[], whole: string): number {
  if (x.name === whole) return 0;
  if (x.name.startsWith(whole)) return 1;
  if (allPrefix(words, x.nameT)) return 2;
  if (allPrefix(words, x.mpT)) return 3;
  return allPrefix(words, x.allT) ? 4 : -1;
}

// One collator: `String.localeCompare` builds one per call, which is what made big result sets slow to sort.
const collator = new Intl.Collator();
const byName = (a: CatalogEntry, b: CatalogEntry) => collator.compare(a.name, b.name) || collator.compare(a.marketplace, b.marketplace);

/** Entries that match `query` (every word starts a word of the name, source or description), best first. */
export function searchEntries(idx: Indexed[], query: string): CatalogEntry[] {
  const words = tokens(query);
  if (!words.length) return idx.map((x) => x.e).sort(byName);
  const whole = query.trim().toLowerCase();
  const hits: { r: number; e: CatalogEntry }[] = [];
  for (const x of idx) {
    const r = rank(x, words, whole);
    if (r >= 0) hits.push({ r, e: x.e });
  }
  hits.sort((a, b) => a.r - b.r || a.e.name.length - b.e.name.length || byName(a.e, b.e));
  return hits.map((h) => h.e);
}

// ---- sources -----------------------------------------------------------------------------------

export const ALL = "all";
export const INSTALLED = "installed";
export const mpId = (name: string) => `mp:${name}`;

export function sourceCaption(marketplace: string): string {
  return marketplace === DIRECTORY ? "Claude plugin directory" : marketplace;
}

export interface SourceOption {
  id: string;
  label: string;
  count: number;
}

/** The rail: All, Installed, the directory, then each marketplace the user added. */
export function sourceOptions(entries: CatalogEntry[], marketplaces: MarketplaceInfo[], installedCount: number): SourceOption[] {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.marketplace, (counts.get(e.marketplace) ?? 0) + 1);
  const names = new Set<string>([...counts.keys(), ...marketplaces.map((m) => m.name)]);
  names.delete(DIRECTORY);
  const rest = [...names].sort((a, b) => a.localeCompare(b));
  const out: SourceOption[] = [
    { id: ALL, label: "All", count: entries.length },
    { id: INSTALLED, label: "Installed", count: installedCount },
    { id: mpId(DIRECTORY), label: sourceCaption(DIRECTORY), count: counts.get(DIRECTORY) ?? 0 },
  ];
  for (const n of rest) out.push({ id: mpId(n), label: n, count: counts.get(n) ?? 0 });
  return out;
}

// ---- rows --------------------------------------------------------------------------------------

export type LibraryRow =
  | { type: "plugin"; key: string; entry: CatalogEntry; installed: InstalledRow | null }
  | { type: "installedPlugin"; key: string; row: InstalledRow }
  | { type: "item"; key: string; row: InstalledRow };

export const ROW_H = 56;

const ITEM_WORD: Record<string, string> = {
  skill: "Skill",
  agent: "Agent",
  command: "Command",
  outputStyle: "Output style",
  mcpServer: "MCP server",
};
export const itemWord = (kind: string): string => ITEM_WORD[kind] ?? "Item";

export function installedById(rows: InstalledRow[]): Map<string, InstalledRow> {
  const m = new Map<string, InstalledRow>();
  for (const r of rows) if (r.kind === "plugin") m.set(r.id, r);
  return m;
}

export interface RowInput {
  idx: Indexed[];
  installed: InstalledRow[];
  source: string;
  query: string;
}

const plain = (s: string) => tokens(s);

/** What the list shows for the chosen source and the typed words. */
export function buildRows({ idx, installed, source, query }: RowInput): LibraryRow[] {
  const have = installedById(installed);
  if (source === INSTALLED) {
    const byId = new Map(idx.map((x) => [x.e.pluginId, x.e]));
    const words = tokens(query);
    const rows: LibraryRow[] = [];
    for (const r of installed) {
      const entry = r.kind === "plugin" ? byId.get(r.id) : undefined;
      const text = plain(`${r.name} ${entry?.description ?? ""} ${itemWord(r.itemKind)}`);
      if (words.length && !words.every((w) => text.some((t) => t.startsWith(w)))) continue;
      if (r.kind === "plugin") rows.push(entry ? { type: "plugin", key: entry.pluginId, entry, installed: r } : { type: "installedPlugin", key: r.id, row: r });
      else rows.push({ type: "item", key: `item:${r.backupId}`, row: r });
    }
    return rows.sort((a, b) => rowName(a).localeCompare(rowName(b)));
  }
  const scope = source.startsWith("mp:") ? idx.filter((x) => x.e.marketplace === source.slice(3)) : idx;
  return searchEntries(scope, query).map((entry) => ({ type: "plugin", key: entry.pluginId, entry, installed: have.get(entry.pluginId) ?? null }));
}

export function rowName(r: LibraryRow): string {
  return r.type === "plugin" ? r.entry.name : r.row.name;
}

// ---- words -------------------------------------------------------------------------------------

/** "Updated just now", "Updated 3 min ago", "Updated 2 h ago", "Updated 4 days ago". */
export function updatedWords(fetchedMs: number | null, nowMs: number): string {
  if (fetchedMs === null) return "Not loaded yet";
  const m = Math.max(0, Math.floor((nowMs - fetchedMs) / 60000));
  if (m < 1) return "Updated just now";
  if (m < 60) return `Updated ${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `Updated ${h} h ago`;
  return `Updated ${Math.floor(h / 24)} days ago`;
}

export function isStale(view: CatalogView | null, nowMs: number): boolean {
  return !view || view.fetchedMs === null || nowMs - view.fetchedMs > STALE_MS;
}

/** "2.1 MB" / "340 KB". */
export function bytesWords(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** "Reading owner/repo... 2.1 MB". */
export function readingWords(label: string, downloaded: number): string {
  return `Reading ${label}...${downloaded > 0 ? ` ${bytesWords(downloaded)}` : ""}`;
}

/** A line says "flagged" when the check found anything. */
export const isClean = (i: Inspected | null | undefined): boolean => !!i && i.check.flags.length === 0;

/** Counts per kind for "What's inside": "2 skills, 1 agent". */
export function insideWords(items: { kind: string }[]): string {
  const order = ["skill", "agent", "command", "outputStyle", "mcpServer"];
  const plural: Record<string, [string, string]> = {
    skill: ["skill", "skills"],
    agent: ["agent", "agents"],
    command: ["command", "commands"],
    outputStyle: ["output style", "output styles"],
    mcpServer: ["MCP server", "MCP servers"],
  };
  const n = new Map<string, number>();
  for (const i of items) n.set(i.kind, (n.get(i.kind) ?? 0) + 1);
  return order
    .filter((k) => n.has(k))
    .map((k) => `${n.get(k)} ${plural[k]![n.get(k) === 1 ? 0 : 1]}`)
    .join(", ");
}

/** The read-only viewer's grammar for a file name. */
export function languageOf(rel: string): string {
  const ext = rel.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "md":
    case "markdown":
      return "markdown";
    case "json":
      return "json";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "ts":
      return "typescript";
    case "py":
      return "python";
    case "yaml":
    case "yml":
      return "yaml";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "ps1":
    case "psm1":
      return "powershell";
    case "toml":
      return "toml";
    default:
      return "text";
  }
}

/** The file inside a plugin that holds an item's words (a skill folder shows its SKILL.md). */
export function itemFile(i: { rel: string; isDir: boolean }): string {
  return i.isDir ? `${i.rel.replace(/\/$/, "")}/SKILL.md` : i.rel;
}

/** One plain sentence from what an install of loose items reported. */
export function installSummary(results: ItemResult[]): string {
  const ok = results.filter((r) => r.ok).length;
  const bad = results.filter((r) => !r.ok);
  if (!bad.length) return ok === 1 ? `Installed ${results[0]!.name}.` : `Installed ${ok} items.`;
  if (!ok) return bad[0]!.message || "Nothing was installed.";
  return `Installed ${ok} of ${results.length} items. ${bad[0]!.message}`;
}

/**
 * `owner/repo` when the pasted words look like a GitHub link (github.com/owner/repo, a full https
 * link with /tree/branch/folder, or plain owner/repo), else null. Only decides whether Check is
 * enabled; the real parsing is Rust's.
 */
export function parseGithub(text: string): string | null {
  const t = text.trim().replace(/\.git$/i, "");
  if (!t) return null;
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[/?#].*)?$/i.exec(t) ?? /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(t);
  return m ? `${m[1]}/${m[2]!.replace(/\.git$/i, "")}` : null;
}

/** The Toolkit item (its id) whose file is, or sits inside, `path`; null when the Toolkit has not read it yet. */
export function toolkitIdFor(items: { id: string; path: string | null }[], path: string | null): string | null {
  if (!path) return null;
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const want = norm(path);
  const exact = items.find((i) => i.path && norm(i.path) === want);
  if (exact) return exact.id;
  return items.find((i) => i.path && (norm(i.path).startsWith(`${want}/`) || want.startsWith(`${norm(i.path)}/`)))?.id ?? null;
}

/** Can Atlas install this entry at all, and if not, why (a sentence for the row). */
export function installBlock(entry: CatalogEntry, cli: boolean): string | null {
  if (entry.source.kind === "command") return COMMAND_SOURCE;
  if (!cli) return NO_CLI;
  return null;
}
