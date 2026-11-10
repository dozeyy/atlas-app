// Pure helpers for the Setup page: what each kind looks like, how items are
// filtered, searched, counted and grouped. No React, no IPC: fast to test.

import type { ComponentType } from "react";
import {
  Anchor,
  BookOpenText,
  Brain,
  FileCode,
  Files,
  FlowArrow,
  Gear,
  Keyboard,
  Lightning,
  ListChecks,
  Notebook,
  PaintBrush,
  type IconProps,
  PlugsConnected,
  PuzzlePiece,
  Robot,
  Rows,
  ShieldCheck,
  TerminalWindow,
  TextAa,
} from "@phosphor-icons/react";
import type { ItemKind, ScopeKind, SetupItem, SetupProject } from "./setup-types";

export interface KindMeta {
  kind: ItemKind;
  /** "Skills" */
  plural: string;
  /** "skill" */
  singular: string;
  icon: ComponentType<IconProps>;
  /** One short line under the group title. */
  blurb: string;
  /** Dense one-line rows instead of cards (long lists). */
  compact: boolean;
  /** Shown as a big tile in the summary. */
  headline: boolean;
}

export const KINDS: KindMeta[] = [
  { kind: "skill", plural: "Skills", singular: "skill", icon: Lightning, blurb: "Reusable know-how Claude loads when it is relevant.", compact: false, headline: true },
  { kind: "agent", plural: "Agents", singular: "agent", icon: Robot, blurb: "Specialists Claude can hand work to.", compact: false, headline: true },
  { kind: "command", plural: "Commands", singular: "command", icon: TerminalWindow, blurb: "Slash commands you can type.", compact: false, headline: true },
  { kind: "mcpServer", plural: "MCP servers", singular: "MCP server", icon: PlugsConnected, blurb: "Tools and data Claude can reach.", compact: false, headline: true },
  { kind: "hook", plural: "Hooks", singular: "hook", icon: Anchor, blurb: "Commands that run on Claude's events.", compact: false, headline: true },
  { kind: "hookScript", plural: "Hook scripts", singular: "hook script", icon: FileCode, blurb: "Script files in your hooks folder and what uses them.", compact: true, headline: false },
  { kind: "plugin", plural: "Plugins", singular: "plugin", icon: PuzzlePiece, blurb: "Bundles installed from a marketplace.", compact: false, headline: true },
  { kind: "outputStyle", plural: "Output styles", singular: "output style", icon: TextAa, blurb: "How Claude words its replies.", compact: false, headline: false },
  { kind: "statusLine", plural: "Status line", singular: "status line", icon: Rows, blurb: "The line shown under the prompt.", compact: false, headline: false },
  { kind: "instructions", plural: "Instructions", singular: "instruction file", icon: BookOpenText, blurb: "CLAUDE.md and AGENTS.md files Claude reads first.", compact: false, headline: true },
  { kind: "rule", plural: "Rules", singular: "rule", icon: ListChecks, blurb: "Rule files, some only for certain paths.", compact: false, headline: true },
  { kind: "permission", plural: "Permissions", singular: "permission", icon: ShieldCheck, blurb: "What Claude may do without asking.", compact: true, headline: true },
  { kind: "settings", plural: "Settings files", singular: "settings file", icon: Gear, blurb: "settings.json at each level.", compact: false, headline: false },
  { kind: "autoMemory", plural: "Memory", singular: "memory file", icon: Brain, blurb: "Notes Claude keeps for each project.", compact: true, headline: true },
  { kind: "agentMemory", plural: "Agent memory", singular: "agent memory file", icon: Notebook, blurb: "Notes kept by individual agents.", compact: true, headline: false },
  { kind: "workflow", plural: "Workflows", singular: "workflow", icon: FlowArrow, blurb: "Scripted multi-step runs.", compact: false, headline: false },
  { kind: "keybindings", plural: "Keybindings", singular: "keybindings file", icon: Keyboard, blurb: "Your keyboard shortcuts.", compact: false, headline: false },
  { kind: "theme", plural: "Themes", singular: "theme", icon: PaintBrush, blurb: "Color themes.", compact: false, headline: false },
  { kind: "other", plural: "Other files", singular: "file", icon: Files, blurb: "Everything else in these folders. Atlas does not manage these.", compact: true, headline: false },
];

export const KIND_BY_ID: Record<ItemKind, KindMeta> = Object.fromEntries(KINDS.map((k) => [k.kind, k])) as Record<
  ItemKind,
  KindMeta
>;

export type ScopeFilter = "all" | "global" | "project";

export interface Filters {
  scope: ScopeFilter;
  /** Only with scope "project": one project, or null for all projects. */
  projectId: string | null;
  query: string;
  kind: ItemKind | null;
  showWorktrees: boolean;
  showBackups: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  scope: "all",
  projectId: null,
  query: "",
  kind: null,
  showWorktrees: false,
  showBackups: false,
};

/** Project and local scopes belong to a project; everything else applies everywhere. */
export function isProjectScope(s: ScopeKind): boolean {
  return s === "project" || s === "local";
}

const SCOPE_RANK: Record<ScopeKind, number> = {
  managed: 0,
  user: 1,
  synced: 2,
  connector: 3,
  plugin: 4,
  project: 5,
  local: 6,
};

export const SCOPE_NAME: Record<ScopeKind, string> = {
  user: "Global",
  project: "Project",
  local: "Local",
  plugin: "Plugin",
  synced: "claude.ai",
  managed: "Managed",
  connector: "claude.ai",
};

/** Claude Code's hook events in plain words. The create flow offers them; cards and the sheet title read them. */
export const HOOK_EVENTS: { value: string; label: string }[] = [
  { value: "PostToolUse", label: "After a tool runs" },
  { value: "PreToolUse", label: "Before a tool runs" },
  { value: "UserPromptSubmit", label: "When you send a message" },
  { value: "Stop", label: "When Claude finishes" },
  { value: "SessionStart", label: "When a session starts" },
  { value: "Notification", label: "When Claude needs you" },
  { value: "SubagentStop", label: "When an agent finishes" },
  { value: "PreCompact", label: "Before the session is trimmed" },
];

// The middle dot is written as an escape: source strings stay ASCII.
const DOT = "\u00b7";
const SEP = /\s+\u00b7\s+/;
/** Tool names joined with a bar and nothing else ("Edit|Write"). A pattern such as "Bash(npm test|lint)" is not that. */
const PLAIN_NAMES = /^[A-Za-z_][\w-]*(\|[A-Za-z_][\w-]*)+$/;

/**
 * A permission rule in words. The settings file spells a rule "Bash(git status:*)"; under its
 * "Allowed" or "Blocked" heading that reads "Commands that start with git status". Only shapes
 * Atlas is sure of get words; any other rule is shown as written.
 */
export function ruleWords(rule: string): string {
  const r = rule.trim();
  const mcp = /^mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*?)(?:__([\w-]+))?$/.exec(r);
  if (mcp) return mcp[2] ? `${mcp[2]}, from ${mcp[1]}` : `Every tool from ${mcp[1]}`;
  const m = /^([A-Za-z]+)(?:\((.*)\))?$/s.exec(r);
  if (!m) return rule;
  const [, tool, inside] = m;
  const any = inside === undefined || inside === "*" || inside === "**";
  switch (tool) {
    case "Bash": {
      if (any) return "Any command";
      const start = /^(.+?)(?::\*| \*)$/.exec(inside);
      if (start && !/[*|&;]/.test(start[1])) return `Commands that start with ${start[1]}`;
      return /[*|&;]/.test(inside) ? rule : `The command ${inside}`;
    }
    case "Read":
      return any ? "Read any file" : `Read ${inside}`;
    case "Edit":
    case "Write":
    case "MultiEdit":
      return any ? "Change any file" : `Change ${inside}`;
    case "WebFetch": {
      if (any) return "Open any web page";
      const d = /^domain:(.+)$/.exec(inside);
      return d ? `Open pages on ${d[1]}` : rule;
    }
    case "WebSearch":
      return any ? "Search the web" : rule;
    default:
      return rule;
  }
}

/**
 * The name a person reads; the stored name stays in the hover, the sheet's facts and the search.
 * - A hook's stored name is its event and its matcher as the settings file spells them
 *   ("PreToolUse", a middle dot, "Edit|Write"): it reads "Before a tool runs", the dot,
 *   "Edit, Write". A matcher that is a pattern, not a list of names, is shown as written.
 * - A plugin is stored as "name@marketplace": it reads as its name.
 * - A permission is a rule ("Bash(git:*)"): it reads in words where Atlas is sure of them.
 * Anything Atlas has no words for, and every other kind, keeps its own name.
 */
export function displayName(i: SetupItem): string {
  if (i.kind === "plugin") {
    const at = i.name.lastIndexOf("@");
    return at > 0 ? i.name.slice(0, at) : i.name;
  }
  if (i.kind === "permission") return ruleWords(i.name);
  if (i.kind !== "hook") return i.name;
  const [event, ...rest] = i.name.split(SEP);
  const words = HOOK_EVENTS.find((h) => h.value === event)?.label;
  if (!words) return i.name;
  const matcher = rest.join(` ${DOT} `).trim();
  if (!matcher || matcher === "any" || matcher === "*") return words;
  return `${words} ${DOT} ${PLAIN_NAMES.test(matcher) ? matcher.split("|").join(", ") : matcher}`;
}

const WEB_KINDS = new Set(["http", "sse", "ws", "streamable-http"]);

/** How a connected tool is reached, in words: a program on this computer, or a web address. */
export function connectionWords(transport: string, target: string): string {
  if (transport === "stdio") return "Runs on this computer";
  if (WEB_KINDS.has(transport)) {
    const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:@\s]+)/i.exec(target)?.[1];
    return host ? `Connects to ${host}` : "Connects over the web";
  }
  return "";
}

/** An MCP server's one-line summary split into how it connects and what exactly ("stdio: npx -y pkg"). */
export function splitSummary(summary: string): { transport: string; target: string } {
  const m = /^([a-z][a-z-]*)\s*(?::(?!\/\/)|\u00b7)\s*(.*)$/s.exec(summary);
  return m ? { transport: m[1], target: m[2] } : { transport: "", target: summary };
}

/**
 * An item's first line in words. A hook's "command: fmt.sh --check" reads "Runs fmt.sh --check";
 * an MCP server's "stdio: npx -y pkg" reads "Runs on this computer" (the exact command is in the
 * hover and in the sheet's Connection facts). Other kinds: their description.
 */
export function displayDescription(i: SetupItem): string {
  if (i.kind === "mcpServer") {
    const { transport, target } = splitSummary(i.description);
    return connectionWords(transport || (i.mcp?.transport ?? ""), target) || i.description;
  }
  if (i.kind !== "hook" && i.kind !== "statusLine") return i.description;
  const m = /^(command|prompt)\s*(?::|\u00b7)\s*(.*)$/s.exec(i.description);
  // The status line's description is its command, with or without the type in front.
  if (i.kind === "statusLine") return (m ? m[2] : i.description) ? `Runs ${m ? m[2] : i.description}` : i.description;
  if (!m || !m[2]) return i.description;
  return m[1] === "command" ? `Runs ${m[2]}` : `Asks Claude: ${m[2]}`;
}

/**
 * A list of tools from a file's header ("Read, Bash(git:*)") with each rule in words where Atlas
 * has them. Commas inside a rule's brackets belong to the rule.
 */
export function toolsWords(list: string): string {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.includes("(") ? ruleWords(p) : p))
    .join(", ");
}

/** "1 skills" (as the scan counts a plugin's parts) reads "1 skill". Every other tag is kept. */
function oneOf(tag: string): string {
  const m = /^1 (.+)s$/.exec(tag);
  return m ? `1 ${m[1]}` : tag;
}

/**
 * The tags an item shows. A hook's are its event and type, an MCP server's its transport, a
 * permission's its list and tool, the status line's its type: the title, the first line or the
 * group heading already say those in words, so those kinds show none. A plugin's counts are put
 * in the singular.
 */
export function displayChips(i: SetupItem): string[] {
  if (i.kind === "hook" || i.kind === "mcpServer" || i.kind === "permission" || i.kind === "statusLine") return [];
  return i.kind === "plugin" ? i.chips.map(oneOf) : i.chips;
}

/**
 * The words on an item's state chip, and what they mean on hover. "Shadowed" is the scan's word
 * for a copy that loses to another with the same name: it reads "Not in use".
 */
export function stateWords(e: SetupItem["enabled"]): { label: string; hint?: string } {
  if (e.state === "shadowed") return { label: "Not in use", hint: "Another copy with the same name is used instead of this one." };
  return { label: e.label };
}

const keys = new WeakMap<SetupItem, string>();

function searchKey(i: SetupItem): string {
  let k = keys.get(i);
  if (k === undefined) {
    k = [
      i.name,
      displayName(i),
      displayDescription(i),
      i.description,
      i.scopeLabel,
      KIND_BY_ID[i.kind].singular,
      i.chips.join(" "),
      i.path ?? "",
      i.plugin ?? "",
      i.enabled.label,
    ]
      .join("\n")
      .toLowerCase();
    keys.set(i, k);
  }
  return k;
}

export function matchesQuery(i: SetupItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const key = searchKey(i);
  return q.split(/\s+/).every((t) => key.includes(t));
}

/** Everything the toolbar's filters allow, ignoring the kind tile (counts need that). */
export function visibleItems(items: SetupItem[], f: Filters): SetupItem[] {
  return items.filter((i) => {
    if (i.worktree && !f.showWorktrees) return false;
    if (i.backup && !f.showBackups) return false;
    if (f.scope === "global" && isProjectScope(i.scope)) return false;
    if (f.scope === "project") {
      if (!isProjectScope(i.scope)) return false;
      if (f.projectId && i.projectId !== f.projectId) return false;
    }
    return matchesQuery(i, f.query);
  });
}

export function applyKind(items: SetupItem[], kind: ItemKind | null): SetupItem[] {
  return kind ? items.filter((i) => i.kind === kind) : items;
}

export function countByKind(items: SetupItem[]): Map<ItemKind, number> {
  const m = new Map<ItemKind, number>();
  for (const i of items) m.set(i.kind, (m.get(i.kind) ?? 0) + 1);
  return m;
}

export interface ScopeCounts {
  global: number;
  project: number;
  plugin: number;
  managed: number;
  claudeAi: number;
}

export function countByScope(items: SetupItem[]): ScopeCounts {
  const c: ScopeCounts = { global: 0, project: 0, plugin: 0, managed: 0, claudeAi: 0 };
  for (const i of items) {
    if (isProjectScope(i.scope)) c.project++;
    else if (i.scope === "plugin") c.plugin++;
    else if (i.scope === "managed") c.managed++;
    else if (i.scope === "synced" || i.scope === "connector") c.claudeAi++;
    else c.global++;
  }
  return c;
}

export function compareItems(a: SetupItem, b: SetupItem): number {
  const s = SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope];
  if (s !== 0) return s;
  if (a.scopeLabel !== b.scopeLabel) return a.scopeLabel.localeCompare(b.scopeLabel);
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
}

export interface Group {
  meta: KindMeta;
  items: SetupItem[];
}

/** Items grouped by kind in the page's fixed order; empty groups are left out. */
export function groupItems(items: SetupItem[]): Group[] {
  const by = new Map<ItemKind, SetupItem[]>();
  for (const i of items) {
    const l = by.get(i.kind);
    if (l) l.push(i);
    else by.set(i.kind, [i]);
  }
  const out: Group[] = [];
  for (const meta of KINDS) {
    const list = by.get(meta.kind);
    if (list?.length) out.push({ meta, items: list.sort(compareItems) });
  }
  return out;
}

/**
 * A sorted list cut into runs of one place (Global, Project - atlas, a plugin, claude.ai). Items
 * arrive sorted by place already, so a run is just the neighbours that share a label.
 */
export function scopeRuns(items: SetupItem[]): { label: string; items: SetupItem[] }[] {
  const out: { label: string; items: SetupItem[] }[] = [];
  for (const i of items) {
    const last = out[out.length - 1];
    if (last && last.label === i.scopeLabel) last.items.push(i);
    else out.push({ label: i.scopeLabel, items: [i] });
  }
  return out;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where an arrow key moves among cards laid out in a wrapping grid. Left/Right step by one;
 * Up/Down go to the card in the next row whose centre is nearest across. With no layout (all
 * boxes empty) Up/Down step by one so the list still walks in reading order. Returns `from`
 * when there is nowhere to go.
 */
export function gridMove(boxes: Box[], from: number, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): number {
  const last = boxes.length - 1;
  if (from < 0 || from > last) return from;
  if (key === "ArrowLeft") return Math.max(0, from - 1);
  if (key === "ArrowRight") return Math.min(last, from + 1);
  const down = key === "ArrowDown";
  if (boxes.every((b) => b.width === 0)) return Math.max(0, Math.min(last, from + (down ? 1 : -1)));
  const me = boxes[from]!;
  const cx = me.left + me.width / 2;
  let rowTop: number | null = null;
  for (const b of boxes) {
    const beyond = down ? b.top > me.top + 4 : b.top < me.top - 4;
    if (!beyond) continue;
    if (rowTop === null || (down ? b.top < rowTop : b.top > rowTop)) rowTop = b.top;
  }
  if (rowTop === null) return from;
  let best = from;
  let bestDist = Infinity;
  boxes.forEach((b, i) => {
    if (Math.abs(b.top - rowTop!) > 4) return;
    const d = Math.abs(b.left + b.width / 2 - cx);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}

/** Permissions split by what the rule does. */
export function permissionBuckets(items: SetupItem[]): { id: "deny" | "ask" | "allow" | "other"; items: SetupItem[] }[] {
  const out = { deny: [] as SetupItem[], ask: [] as SetupItem[], allow: [] as SetupItem[], other: [] as SetupItem[] };
  for (const i of items) {
    const c = i.chips[0];
    if (c === "deny" || c === "ask" || c === "allow") out[c].push(i);
    else out.other.push(i);
  }
  return (["deny", "ask", "allow", "other"] as const).map((id) => ({ id, items: out[id] })).filter((b) => b.items.length);
}

/** An item that belongs to a project folder that is no longer on disk. */
export function isOnMissingProject(i: SetupItem, projects: SetupProject[]): boolean {
  if (!i.projectId) return false;
  const p = projects.find((x) => x.id === i.projectId);
  return !!p && !p.exists;
}

export function relativeTime(ms: number | null, now = Date.now()): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 45) return `${d} d ago`;
  const mo = Math.round(d / 30);
  if (mo < 18) return `${mo} mo ago`;
  return `${Math.round(d / 365)} y ago`;
}

/** Plain-language tone for the state chip. */
export type Tone = "good" | "muted" | "warn" | "bad" | "accent";

export function enabledTone(state: SetupItem["enabled"]["state"]): Tone {
  switch (state) {
    case "on":
    case "approved":
      return "good";
    case "active":
      return "accent";
    case "off":
    case "inactive":
      return "muted";
    case "rejected":
      return "bad";
    case "shadowed":
    case "pending":
    case "custom":
      return "warn";
    default:
      return "muted";
  }
}

// ---- the tile grid on the Setup page ----

/** A tile opens a collection: one kind, or "more" for everything that has no tile of its own. */
export type TileId = ItemKind | "more";

/** Eleven kinds plus "more" = twelve tiles, which divide evenly into 2, 3, 4 and 6 columns. */
export const TILE_KINDS: ItemKind[] = [
  "skill",
  "agent",
  "command",
  "mcpServer",
  "hook",
  "plugin",
  "instructions",
  "rule",
  "permission",
  "autoMemory",
  "outputStyle",
];

export const MORE_KINDS: ItemKind[] = KINDS.map((k) => k.kind).filter((k) => !TILE_KINDS.includes(k));

export function tileKinds(id: TileId): ItemKind[] {
  return id === "more" ? MORE_KINDS : [id];
}

export function tileTitle(id: TileId): string {
  return id === "more" ? "More" : KIND_BY_ID[id].plural;
}

/** A tile's name as it reads in the middle of a sentence: "skills", "output styles", but "MCP servers". */
export function tileNoun(id: TileId): string {
  const t = tileTitle(id);
  return /^[A-Z]{2}/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1);
}

/** What the search box of an open tile says. The More tile holds several kinds, so it has its own words. */
export function searchPlaceholder(id: TileId): string {
  return id === "more" ? "Search everything else" : `Search ${tileNoun(id)}`;
}

export function tileBlurb(id: TileId): string {
  return id === "more" ? "Settings files, the status line, hook scripts, keybindings and everything else." : KIND_BY_ID[id].blurb;
}

export function itemsForTile(items: SetupItem[], id: TileId): SetupItem[] {
  const kinds = tileKinds(id);
  return items.filter((i) => kinds.includes(i.kind));
}
