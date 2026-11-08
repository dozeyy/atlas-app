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

const keys = new WeakMap<SetupItem, string>();

function searchKey(i: SetupItem): string {
  let k = keys.get(i);
  if (k === undefined) {
    k = [
      i.name,
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

export function tileBlurb(id: TileId): string {
  return id === "more" ? "Settings files, the status line, hook scripts, keybindings and everything else." : KIND_BY_ID[id].blurb;
}

export function itemsForTile(items: SetupItem[], id: TileId): SetupItem[] {
  const kinds = tileKinds(id);
  return items.filter((i) => kinds.includes(i.kind));
}
