import type { Conflict, Enabled, ItemKind, ScopeKind } from "./setup-types";
import { modelLabel } from "./usage";

/**
 * Every tag (chip) in the app, with what it means in plain words for the hover: where an item
 * lives, whether it is in use, which copy wins, what a plugin brings, and the fixed badges on
 * sheets and lists. One map, so a chip never appears without an explanation; tagWords.test.ts
 * fails on a tag this file does not know.
 *
 * A tip is one or two sentences: what it means for this item, then what (if anything) to do.
 */
export interface TagWords {
  label: string;
  tip: string;
}

/** The middle dot between a scope and its name ("Project \u00b7 atlas"), written as an escape so the source stays ASCII. */
const DOT = " \u00b7 ";

/** "Project \u00b7 atlas" -> "atlas"; a label without that part gives "". */
function after(label: string): string {
  const at = label.indexOf(DOT);
  return at < 0 ? "" : label.slice(at + DOT.length);
}

// ---- where it lives --------------------------------------------------------------------------

export function scopeWords(scope: ScopeKind, label: string): TagWords {
  const name = after(label) || "this project";
  switch (scope) {
    case "user":
      return { label, tip: "Global: in your Claude folder, so Claude has it in every project." };
    case "project":
      return { label, tip: `Project: in the .claude folder of ${name}, shared with everyone who has that repository. Claude has it only while working in ${name}.` };
    case "local":
      return { label, tip: `Local: in ${name} but only on this computer, kept out of the shared files. Claude has it only while working in ${name}.` };
    case "plugin":
      return { label, tip: `Plugin: it came with the plugin ${after(label) || "it belongs to"}. Change or remove the plugin in the Library; Atlas does not edit its files.` };
    case "synced":
    case "connector":
      return { label, tip: "claude.ai: it comes from your claude.ai account, not a file on this computer. Change it on claude.ai." };
    case "managed":
      return { label, tip: "Managed: set by your organisation for every project. Atlas shows it and leaves it alone." };
  }
}

// ---- in use or not ---------------------------------------------------------------------------

/**
 * The state chip. The scan's words are kept where they already read well ("Approved"); "Shadowed"
 * reads "Not in use". A label this map does not know gets an empty tip, which the test catches.
 */
export function stateWords(e: Enabled): TagWords {
  const l = e.label;
  const on = /^On in (\d+) of (\d+) projects$/.exec(l);
  switch (e.state) {
    case "on":
      if (on) return { label: l, tip: `Connected in ${on[1]} of the ${on[2]} projects that list it; the others switched it off in their own settings.` };
      if (l === "On") return { label: l, tip: "On: Claude uses it." };
      break;
    case "off":
      if (l === "Off") return { label: l, tip: "Off: switched off in settings, so Claude does not use it. Switch it on to use it again." };
      if (l === "Off in all projects") return { label: l, tip: "Off in every project that lists it: each one switched it off in its own settings." };
      if (l === "Plugin off") return { label: l, tip: "The plugin it came with is switched off, so this is not used. Switch the plugin on in the Library." };
      if (l === "Hooks disabled") return { label: l, tip: "Every hook is switched off (disableAllHooks in settings), so this one does not run." };
      break;
    case "active":
      if (l === "Active") return { label: l, tip: "Active: this is the one in use." };
      break;
    case "inactive":
      if (l === "Overridden") return { label: l, tip: "Overridden: a settings file closer to the project sets its own, so this one is not used." };
      if (l === "Not selected") return { label: l, tip: "Not selected: another output style is in use. Pick this one in Claude Code to use it." };
      break;
    case "shadowed":
      return { label: "Not in use", tip: "Another copy with the same name is used instead of this one." };
    case "approved":
      return { label: l, tip: "Approved: you said yes to this project's MCP server, so Claude connects it." };
    case "rejected":
      return { label: l, tip: "Rejected: you said no to this project's MCP server, so Claude does not connect it." };
    case "pending":
      return { label: l, tip: "Pending approval: Claude Code asks before it connects a project's MCP server. Say yes there to use it." };
    case "custom":
      return { label: l, tip: `Set to "${e.raw ?? l}" by skillOverrides in settings.` };
    case "none":
      if (l === "Account") return { label: l, tip: "Account: a claude.ai connector. It works once you are signed in there." };
      break;
  }
  return { label: l, tip: "" };
}

// ---- which copy wins -------------------------------------------------------------------------

export function conflictWords(c: Conflict): TagWords {
  const winner = c.definedIn.find((d) => d.winner && !d.isSelf)?.scopeLabel ?? c.label.replace(/^Overridden by /, "");
  const losers = c.definedIn.filter((d) => !d.winner).map((d) => d.scopeLabel);
  switch (c.status) {
    case "overrides":
      return { label: c.label, tip: `This copy is the one Claude uses. The other copy with this name${losers.length ? ` (${losers.join(", ")})` : ""} is skipped.` };
    case "overridden":
      return { label: c.label, tip: `Not in use: the ${winner} copy with this name wins, so Claude skips this one. Delete one or rename it to keep both.` };
    case "conflict":
      return { label: c.label, tip: "Two copies with this name sit at the same level, so which one Claude uses is not certain. Rename or delete one." };
    case "duplicate":
      return { label: c.label, tip: "Another copy with this name is in the same place. Claude uses one of them; delete or rename the other." };
  }
}

// ---- the plain tags on a card ----------------------------------------------------------------

const MODEL_FAMILY: Record<string, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable" };
const TRANSPORT: Record<string, string> = { stdio: "a program Claude starts on this computer", http: "a web address", sse: "a web address (server-sent events)", ws: "a web socket" };

/**
 * A tag as a person reads it, with what it means. Null for a tag this map does not know (the
 * test sweeps the mock setup, so a new tag shows up there first).
 * - An agent's tag is its model as its file writes it: a full id reads the way models read
 *   everywhere else ("Opus 5.5"), a family alias ("opus": whichever Opus is current) as the
 *   family's name. No version is made up for an alias.
 * - "local" (a settings file kept out of the project's shared files) reads in words.
 */
export function tagWords(kind: ItemKind, chip: string): TagWords | null {
  const raw = chip.trim();
  const low = raw.toLowerCase();
  if (kind === "agent") {
    if (low === "inherit") return { label: "Session's model", tip: "Runs on whichever model the session that calls it is using. Its file says: inherit." };
    const label = MODEL_FAMILY[low] ?? modelLabel(raw);
    if (label !== raw) return { label, tip: `The model this agent runs on; its file writes it as ${raw}.` };
  }
  if (low === "local") return { label: "This computer only", tip: "A local file: yours alone, not shared with the project." };
  if (low === "backup copy") return { label: "Backup copy", tip: "A copy Atlas saved before a change. History can put it back." };
  if (/^v\d/.test(low)) return { label: raw, tip: `Version ${raw.slice(1)} of the plugin, as its marketplace lists it.` };
  if (/^\d+ \D/.test(raw)) return { label: raw, tip: `What the plugin brings: ${raw}. They install and uninstall with it.` };
  if (TRANSPORT[low]) return { label: raw, tip: `How Claude reaches this server: ${TRANSPORT[low]}.` };
  if (kind === "rule" || /[*/]/.test(raw)) return { label: raw, tip: `Applies only while Claude works on files matching ${raw}.` };
  return null;
}

// ---- the fixed badges on sheets and lists ----------------------------------------------------

export const BADGES = {
  backupCopy: { label: "Backup copy", tip: "A copy Atlas saved before a change. History can put it back." },
  worktree: { label: "Agent worktree", tip: "Lives in a side copy of the project that an agent made. Claude has it only while working in that copy." },
  valuesHidden: { label: "Values hidden", tip: "Secret values in this item are hidden until you ask to see them." },
  used: { label: "Used", tip: "The copy Claude uses." },
  thisOne: { label: "This one", tip: "The copy open in this sheet." },
  onHere: { label: "On", tip: "This project connects it." },
  offHere: { label: "Off", tip: "This project switched it off in its own settings." },
  leftOut: { label: "Left out", tip: "In the repository but not copied: Atlas installs skills, agents and commands only, so this never runs." },
  installed: { label: "Installed", tip: "Installed through Claude Code, so Claude has it in every project. The switch turns it off without removing it." },
  installedChanged: { label: "Installed, changed", tip: "Its files changed after you checked them. Check it again before you trust it." },
  installedOff: { label: "Installed, switched off", tip: "Installed but switched off, so Claude does not use it. The switch turns it back on." },
  changedSince: { label: "Changed since you checked it", tip: "Its files changed after you checked them. Check it again before you trust it." },
} as const satisfies Record<string, TagWords>;

export type BadgeId = keyof typeof BADGES;

export const badge = (id: BadgeId): TagWords => BADGES[id];

/** The "+N" chip at the end of a card's tag row. */
export const moreWords = (n: number): TagWords => ({ label: `+${n}`, tip: `${n} more ${n === 1 ? "tag" : "tags"}. Open the card to see them all.` });

/** The kind chip at the top of a sheet: the kind's own one-line description. */
export const kindWords = (singular: string, blurb: string): TagWords => ({ label: singular.charAt(0).toUpperCase() + singular.slice(1), tip: blurb });
