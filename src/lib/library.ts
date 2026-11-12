// The Library's pure model: search over the catalog, the source filters, the rows the list draws and
// the plain sentences around them. No React and no IPC here, so every rule has a test.

import type { CatalogEntry, CatalogView, InstalledRow, Inspected, ItemResult, MarketplaceInfo } from "./libraryTypes";
import { formatBytes } from "./labels";
import { exact } from "./usage";

/** Claude Code's own marketplace. */
export const DIRECTORY = "anthropic-plugin-directory";
/** The catalog is asked for again when the saved copy is older than this. */
export const STALE_MS = 6 * 60 * 60 * 1000;

export const NO_CLI = "Needs Claude Code's command to install plugins.";
export const COMMAND_SOURCE = "This plugin installs by running a command. Atlas does not run those.";
/** The name Claude Code gives Anthropic's official plugin marketplace. */
export const OFFICIAL_CATALOG = "claude-plugins-official";
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

/**
 * Nothing typed: the catalog's own order. That is the order each marketplace lists its plugins in
 * (the directory's is ranked, its most used first), the directory before the marketplaces the
 * user added. This is the "Catalog order" choice; with install counts the list opens in
 * "popular" order instead (see `orderIndexed`).
 */
export function catalogOrder(idx: Indexed[]): CatalogEntry[] {
  const first: CatalogEntry[] = [];
  const rest: CatalogEntry[] = [];
  for (const x of idx) (x.e.marketplace === DIRECTORY ? first : rest).push(x.e);
  return first.concat(rest);
}

// ---- order -------------------------------------------------------------------------------------

/** "popular": most installs first, then what has no count, each in catalog order. "catalog": the catalog's own order. */
export type LibraryOrder = "popular" | "catalog";

/** Some plugin has an install count: only then is there a popular order to offer. */
export const hasInstalls = (entries: readonly CatalogEntry[]): boolean => entries.some((e) => e.installs != null);

/**
 * The list in one of its two orders, stable: equal counts and plugins with no count keep the
 * catalog's order (`pos`; the array order for an entry that carries none). Done once when the data
 * lands or the choice changes, never per render. Returns a new array.
 */
export function orderIndexed(idx: readonly Indexed[], order: LibraryOrder): Indexed[] {
  const at = new Map<Indexed, number>();
  idx.forEach((x, i) => at.set(x, x.e.pos ?? i));
  const pos = (x: Indexed) => at.get(x) as number;
  if (order === "catalog") return idx.slice().sort((a, b) => pos(a) - pos(b));
  return idx.slice().sort((a, b) => {
    const x = a.e.installs;
    const y = b.e.installs;
    if (x != null && y != null && x !== y) return y - x;
    if ((x != null) !== (y != null)) return x != null ? -1 : 1;
    return pos(a) - pos(b);
  });
}

/** "12k installs", "1.2M installs", "1 install": a short count for a row's quiet side. Empty for none. */
export function installsWords(n: number | undefined): string {
  if (n == null || !(n >= 1)) return "";
  const round = Math.round(n);
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  let figure: string;
  if (round < 1000) figure = String(round);
  else if (round < 10_000) figure = `${trim(round / 1000)}k`;
  else if (round < 999_500) figure = `${Math.round(round / 1000)}k`;
  else figure = `${trim(round / 1_000_000)}M`;
  return `${figure} ${round === 1 ? "install" : "installs"}`;
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
  /** Something in this source wants a second look: short words for the rail, and the whole sentence. */
  flag?: { short: string; full: string };
}

/** Installed plugins the list marks "Changed since you checked it": changed, and still in the catalog. */
export function changedCount(idx: Indexed[], installed: InstalledRow[]): number {
  const ids = new Set(idx.map((x) => x.e.pluginId));
  return installed.filter((r) => r.kind === "plugin" && r.changed && ids.has(r.id)).length;
}

/** The rail: All, Installed, the directory, then each marketplace the user added. */
export function sourceOptions(
  total: number,
  perMarketplace: Record<string, number>,
  marketplaces: MarketplaceInfo[],
  installedCount: number,
  changed = 0,
): SourceOption[] {
  const counts = new Map<string, number>(Object.entries(perMarketplace));
  const names = new Set<string>([...counts.keys(), ...marketplaces.map((m) => m.name)]);
  names.delete(DIRECTORY);
  const rest = [...names].sort((a, b) => a.localeCompare(b));
  const out: SourceOption[] = [
    { id: ALL, label: "All", count: total },
    {
      id: INSTALLED,
      label: "Installed",
      count: installedCount,
      // The row says it too, but that row can be far down the list: the source says so where it is always seen.
      flag: changed > 0 ? { short: `${exact(changed)} changed`, full: `${exact(changed)} changed since you checked ${changed === 1 ? "it" : "them"}` } : undefined,
    },
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
/** A heading over a run of rows (see buildList). */
export const HEAD_H = 32;

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
  /** The catalog, already in `order` (the store sorts it once). */
  idx: Indexed[];
  installed: InstalledRow[];
  source: string;
  query: string;
  /** How `idx` is ordered. Default "catalog". */
  order?: LibraryOrder;
}

const plain = (s: string) => tokens(s);

/** What the list shows for the chosen source and the typed words. */
export function buildRows({ idx, installed, source, query, order = "catalog" }: RowInput): LibraryRow[] {
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
    // What needs a second look ("Changed since you checked it") first, then A to Z.
    const look = (r: LibraryRow) => (r.type === "plugin" && r.installed?.changed ? 0 : 1);
    return rows.sort((a, b) => look(a) - look(b) || rowName(a).localeCompare(rowName(b)));
  }
  const scope = source.startsWith("mp:") ? idx.filter((x) => x.e.marketplace === source.slice(3)) : idx;
  // Typed words rank by match; nothing typed keeps the catalog's own order (see catalogOrder).
  const typed = tokens(query).length > 0;
  // Popular: `idx` already is in that order (sorted once, stable), across every marketplace.
  const popular = order === "popular";
  const list = typed ? searchEntries(scope, query) : popular ? scope.map((x) => x.e) : catalogOrder(scope);
  const rows: LibraryRow[] = list.map((entry) => ({ type: "plugin", key: entry.pluginId, entry, installed: have.get(entry.pluginId) ?? null }));
  if (source !== ALL || typed) return rows;
  // All, nothing typed: what is installed leads (what changed first), then each marketplace as one
  // run, the directory before the others in the rail's order. Inside a run the catalog's order holds
  // (the sort is stable), so buildList can put one heading over each.
  const rank = (r: LibraryRow) => (r.type === "plugin" && r.installed ? (r.installed.changed ? 0 : 1) : 2);
  if (popular) return rows.sort((x, y) => rank(x) - rank(y));
  const market = (r: LibraryRow) => (r.type === "plugin" ? r.entry.marketplace : "");
  return rows.sort((x, y) => {
    const d = rank(x) - rank(y);
    if (d || rank(x) < 2) return d;
    const mx = market(x);
    const my = market(y);
    if (mx === my) return 0;
    return mx === DIRECTORY ? -1 : my === DIRECTORY ? 1 : mx.localeCompare(my);
  });
}

/** A heading over a run of rows: it sits above row `at`. */
export interface ListHead {
  at: number;
  label: string;
}

export interface ListModel {
  rows: LibraryRow[];
  /** All with nothing typed: "Installed", then one heading per marketplace. Empty when one heading would say it all. */
  heads: ListHead[];
  /**
   * A row may name where it comes from: only when sources are mixed and no heading says it (a
   * search under All, the Installed filter). Even then the row stays quiet for the directory.
   */
  showSource: boolean;
}

export const INSTALLED_HEAD = "Installed";
/** Under All in popular order, the one run after what is installed: it spans every marketplace. */
export const MORE_HEAD = "More plugins";

/** The rows, and what frames them: headings under All, the source on a row only where it adds something. */
export function buildList(input: RowInput): ListModel {
  const rows = buildRows(input);
  const typed = tokens(input.query).length > 0;
  if (input.source !== ALL || typed) return { rows, heads: [], showSource: input.source === ALL || input.source === INSTALLED };
  const popular = input.order === "popular";
  const heads: ListHead[] = [];
  let last: string | null = null;
  rows.forEach((r, at) => {
    if (r.type !== "plugin") return;
    const label = r.installed ? INSTALLED_HEAD : popular ? MORE_HEAD : sourceCaption(r.entry.marketplace);
    if (label !== last) heads.push({ at, label });
    last = label;
  });
  // One list across marketplaces has no heading that names them, so a row outside the directory names its own.
  return { rows, heads: heads.length > 1 ? heads : [], showSource: popular };
}

export function rowName(r: LibraryRow): string {
  return r.type === "plugin" ? r.entry.name : r.row.name;
}

// ---- what a row is about -----------------------------------------------------------------------

/**
 * What a plugin is about, read from its own name and description: the catalog sends nothing else
 * (no contents, no counts), so the row's picture is a reading of those words and never a claim
 * about what is inside. "plugin" is the honest answer when the words say nothing.
 */
export type Topic =
  | "style"
  | "language"
  | "hooks"
  | "agents"
  | "commands"
  | "skills"
  | "design"
  | "review"
  | "documents"
  | "security"
  | "cloud"
  | "data"
  | "web"
  | "git"
  | "loop"
  | "build"
  | "plugin";

/** One word for the picture's hover. */
export const TOPIC_WORD: Record<Topic, string> = {
  style: "Output style",
  language: "Language server",
  hooks: "Hooks",
  agents: "Agents",
  commands: "Commands",
  skills: "Skills",
  design: "Design",
  review: "Review",
  documents: "Documents",
  security: "Security",
  cloud: "Cloud",
  data: "Data",
  web: "Web",
  git: "Git",
  loop: "Automation",
  build: "Building",
  plugin: "Plugin",
};

// First match wins. A plain entry is a whole word (or two words in a row); one ending in "*" is
// the start of a word. What a plugin adds to Claude Code (a style, hooks, agents) comes before
// what it is for (design, review, documents).
const TOPIC_RULES: [Topic, string[]][] = [
  ["style", ["output style", "output styles"]],
  ["language", ["lsp", "language server"]],
  ["hooks", ["hook*"]],
  ["agents", ["agent*", "subagent*"]],
  ["commands", ["command*", "slash"]],
  ["skills", ["skill*"]],
  ["design", ["design*", "frontend", "ui", "ux", "css", "figma", "tailwind"]],
  ["review", ["review*", "audit*", "lint*"]],
  ["documents", ["pdf", "docx", "xlsx", "pptx", "excel", "spreadsheet*", "slides", "document*", "notes", "markdown"]],
  ["security", ["security", "secure", "secret*", "vulnerab*"]],
  ["cloud", ["infrastructure", "terraform", "deploy*", "cloud", "docker", "kubernetes", "aws", "azure", "gcp"]],
  ["data", ["sql", "database*", "query", "queries", "postgres*", "csv", "analytics"]],
  ["web", ["browser*", "playwright", "web", "website*", "http", "scrape*"]],
  ["git", ["git", "github", "gitlab", "commit*", "branch*", "merge", "changelog", "pull request", "pull requests"]],
  ["loop", ["loop*", "schedule*", "automat*", "cron", "repeat*"]],
  ["build", ["dev", "sdk", "build*", "test*", "debug*", "workflow*", "feature*"]],
];

function topicIn(text: string): Topic | null {
  const hay = ` ${tokens(text).join(" ")} `;
  for (const [topic, words] of TOPIC_RULES) {
    for (const w of words) {
      if (w.endsWith("*") ? hay.includes(` ${w.slice(0, -1)}`) : hay.includes(` ${w} `)) return topic;
    }
  }
  return null;
}

/** The name says most, so it is read first; the description only when the name says nothing. */
export function entryTopic(e: { name: string; description?: string }): Topic {
  return topicIn(e.name) ?? topicIn(e.description ?? "") ?? "plugin";
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

/** "2.1 MB" / "340 KB": the app's one size format, never less than 1 KB while something is arriving. */
export function bytesWords(n: number): string {
  return formatBytes(Math.max(1024, n));
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
  if (entry.byCommand) return COMMAND_SOURCE;
  if (!cli) return NO_CLI;
  return null;
}
