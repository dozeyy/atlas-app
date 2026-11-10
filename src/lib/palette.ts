// The quick jump (Ctrl+K): what can be jumped to, and how a typed word ranks it.
// Pure on purpose: the component only draws what this returns, and the tests live here.

import { dayLabel } from "./sessionBrowse";
import { localDay } from "./usage";
import type { SetupItem } from "./setup-types";
import type { SessionRow, View } from "./types";

export type PaletteKind = "page" | "library" | "session" | "project" | "skill" | "agent" | "command";

export interface PaletteTarget {
  view: View;
  /** Open the Toolkit on this tab. */
  toolkitTab?: "setup" | "library" | "team";
  /** Open this chat in Sessions. */
  session?: string;
  /** Show this project's chats in Sessions (a project key, as the filter uses it). */
  project?: string;
  /** Open this item in the Toolkit. */
  toolkitItem?: string;
}

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  title: string;
  /** Under the title: the project, the scope, the folder. */
  sub: string;
  /** At the right edge: a shortcut or a day. */
  meta: string;
  /** Searched, never shown (what a page is also called, an item's description). */
  extra: string;
  /** Recency in ms; breaks ties between equally good matches. */
  at: number;
  /** Listed even when no typed word matches it, at this score (a chat found by its message text). */
  forced?: number;
  target: PaletteTarget;
}

/** What each kind is called on its row. */
export const KIND_LABEL: Record<PaletteKind, string> = {
  page: "Page",
  library: "Library",
  session: "Chat",
  project: "Project",
  skill: "Skill",
  agent: "Agent",
  command: "Command",
};

/** Same score, better kind first: pages, then projects and toolkit items, then chats. */
const KIND_ORDER: Record<PaletteKind, number> = { page: 0, library: 0, project: 1, skill: 2, agent: 2, command: 2, session: 3 };
/** A little weight for the kind, so "set" lands on Settings before a chat that starts with "set". */
const KIND_BIAS: Record<PaletteKind, number> = { page: 30, library: 30, project: 10, skill: 8, agent: 8, command: 8, session: 0 };

/** Other words a page answers to. */
const PAGE_WORDS: Partial<Record<View, string>> = {
  dashboard: "overview usage tokens home",
  now: "live running active current",
  sessions: "chats conversations transcripts",
  setup: "skills agents commands hooks mcp servers plugins memory",
  history: "changes undo restore log",
  wrapped: "year recap story summary",
  settings: "preferences options theme folder",
};

export function pageItems(nav: { view: View; label: string }[], mod: string): PaletteItem[] {
  return nav.map((n, i) => ({
    id: `page:${n.view}`,
    kind: "page",
    title: n.label,
    sub: "",
    meta: `${mod}+${i + 1}`,
    extra: PAGE_WORDS[n.view] ?? "",
    at: 0,
    target: { view: n.view },
  }));
}

/** "Library": the Toolkit's second tab, found by typing (it is not one of the sidebar pages). */
export function libraryItem(): PaletteItem {
  return {
    id: "library:tab",
    kind: "library",
    title: "Library",
    sub: "Find and add plugins and skills",
    meta: "",
    extra: "plugins skills marketplace catalog install add github toolkit",
    at: 0,
    target: { view: "setup", toolkitTab: "library" },
  };
}

export function sessionItem(row: SessionRow, now = new Date()): PaletteItem {
  return {
    id: `session:${row.sessionId}`,
    kind: "session",
    title: row.name ?? `Session in ${row.projectName}`,
    sub: row.projectName,
    meta: dayLabel(localDay(new Date(row.startedAt)), now),
    extra: row.projectPath,
    at: row.startedAt,
    target: { view: "sessions", session: row.sessionId },
  };
}

export function projectItem(p: { projectKey: string; name: string; path: string }): PaletteItem {
  return {
    id: `project:${p.projectKey}`,
    kind: "project",
    title: p.name,
    sub: p.path,
    meta: "",
    extra: "",
    at: 0,
    target: { view: "sessions", project: p.projectKey },
  };
}

const TOOLKIT_KINDS = new Set(["skill", "agent", "command"]);

/** Skills, agents and commands only, once each, without backups or worktree copies. */
export function toolkitItems(items: SetupItem[]): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const i of items) {
    if (!TOOLKIT_KINDS.has(i.kind) || i.backup || i.worktree) continue;
    out.push({
      id: `${i.kind}:${i.id}`,
      kind: i.kind as PaletteKind,
      title: i.name,
      sub: i.scopeLabel,
      meta: "",
      extra: i.description,
      at: i.modifiedMs ?? 0,
      target: { view: "setup", toolkitItem: i.id },
    });
  }
  return out;
}

// ---- ranking ----------------------------------------------------------------------------------

export const words = (q: string): string[] => q.toLowerCase().split(/\s+/).filter(Boolean);

const isStart = (text: string, i: number) => i === 0 || /[\s\-_/.:\\]/.test(text[i - 1]!);

/** Is every character of `needle` in `hay`, in order? ("rvw" is in "review") */
function inOrder(needle: string, hay: string): boolean {
  let at = 0;
  for (const ch of needle) {
    at = hay.indexOf(ch, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

/** How well one typed word matches: its title first, then the rest. 0 means it does not. */
function wordScore(word: string, title: string, rest: string): number {
  const first = title.indexOf(word);
  if (first === 0) return 100;
  for (let i = first; i >= 0; i = title.indexOf(word, i + 1)) if (isStart(title, i)) return 80;
  if (first > 0) return 55;
  if (rest.includes(word)) return 25;
  if (word.length >= 2 && inOrder(word, title)) return 12;
  return 0;
}

/** 0 when the item does not match. Every typed word has to match something. */
export function scoreItem(query: string, item: PaletteItem): number {
  const ws = words(query);
  if (!ws.length) return 1;
  const title = item.title.toLowerCase();
  const rest = `${item.sub} ${item.extra}`.toLowerCase();
  let sum = 0;
  for (const w of ws) {
    const s = wordScore(w, title, rest);
    if (!s) return item.forced ?? 0;
    sum += s;
  }
  if (title === ws.join(" ")) sum += 40;
  return sum + KIND_BIAS[item.kind] + Math.max(0, 12 - Math.floor(title.length / 6));
}

/** The best `limit` matches, best first. With nothing typed: every page, then the newest chats. */
export function rankItems(items: PaletteItem[], query: string, limit = 30): PaletteItem[] {
  if (!words(query).length) return defaultList(items, limit);
  const scored: { item: PaletteItem; score: number }[] = [];
  for (const item of items) {
    const score = scoreItem(query, item);
    if (score > 0) scored.push({ item, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] ||
      b.item.at - a.item.at ||
      a.item.title.localeCompare(b.item.title),
  );
  return scored.slice(0, limit).map((s) => s.item);
}

/** Nothing typed yet: the pages in sidebar order, then the newest chats. */
export function defaultList(items: PaletteItem[], limit = 30, recent = 6): PaletteItem[] {
  const pages = items.filter((i) => i.kind === "page");
  const chats = items
    .filter((i) => i.kind === "session")
    .sort((a, b) => b.at - a.at)
    .slice(0, recent);
  return [...pages, ...chats].slice(0, limit);
}

/** The pieces of `text` to draw bold: where the typed words match, merged. [start, end) pairs. */
export function matchRanges(query: string, text: string): [number, number][] {
  const low = text.toLowerCase();
  const found: [number, number][] = [];
  for (const w of words(query)) {
    let at = low.indexOf(w);
    for (let i = at; i >= 0; i = low.indexOf(w, i + 1)) {
      if (isStart(low, i)) {
        at = i;
        break;
      }
    }
    if (at >= 0) found.push([at, at + w.length]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** Keeps a list's picked row in range as the list changes length. */
export const clampIndex = (i: number, length: number): number => (length <= 0 ? 0 : Math.min(Math.max(i, 0), length - 1));

/** Up and Down wrap around the ends. */
export const stepIndex = (i: number, delta: 1 | -1, length: number): number => (length <= 0 ? 0 : (i + delta + length) % length);
