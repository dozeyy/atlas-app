// The setup checklist, as data. Each step says how to tell it is done (from the
// real scan, never from a saved tick box) and which create flow its button opens.
// Add, reorder or reword a step here and the panel follows.

import type { CreateKind, SetupItem } from "./setup-types";

export interface SetupStep {
  id: string;
  /** What Will does, as a short friendly phrase. */
  title: string;
  /** One warm line: why it is worth doing. */
  why: string;
  /** The button on a step that is not done yet. */
  action: string;
  /** Which create flow the button opens. */
  create: CreateKind;
  done: (items: SetupItem[]) => boolean;
}

const real = (i: SetupItem) => !i.backup && !i.worktree;
const yours = (i: SetupItem) => real(i) && (i.scope === "user" || i.scope === "project" || i.scope === "local");
const has = (items: SetupItem[], kind: SetupItem["kind"], pick: (i: SetupItem) => boolean = yours) => items.some((i) => i.kind === kind && pick(i));

export const SETUP_STEPS: SetupStep[] = [
  {
    id: "claude-md",
    title: "Tell Claude about yourself",
    why: "A global CLAUDE.md is the first thing Claude reads, every time. A few lines about how you like to work go a long way.",
    action: "Write it",
    create: "instructions",
    done: (items) => has(items, "instructions", (i) => real(i) && i.scope === "user"),
  },
  {
    id: "skill",
    title: "Make your first skill",
    why: "A skill teaches Claude one job and loads only when it is needed. Think of it as a recipe card.",
    action: "Make a skill",
    create: "skill",
    done: (items) => has(items, "skill"),
  },
  {
    id: "agent",
    title: "Add your first agent",
    why: "An agent is a specialist Claude can hand work to, like a reviewer who only reads and never edits.",
    action: "Add an agent",
    create: "agent",
    done: (items) => has(items, "agent"),
  },
  {
    id: "hook",
    title: "Set up a hook",
    why: "A hook runs a command on its own at the right moment, such as formatting a file after Claude edits it.",
    action: "Add a hook",
    create: "hook",
    done: (items) => has(items, "hook"),
  },
  {
    id: "rule",
    title: "Write a rule",
    why: "Rules are small notes Claude follows, and some only apply to certain files. Good for habits you keep repeating.",
    action: "Write a rule",
    create: "rule",
    done: (items) => has(items, "rule"),
  },
  {
    id: "mcp",
    title: "Connect an MCP server",
    why: "An MCP server gives Claude a new reach: your files, your calendar, GitHub, a database.",
    action: "Connect one",
    create: "mcpServer",
    done: (items) => has(items, "mcpServer"),
  },
  {
    id: "style",
    title: "Give Claude a voice",
    why: "An output style changes how Claude words its replies, from terse to chatty. A status line shows what you want at a glance.",
    action: "Make a style",
    create: "outputStyle",
    done: (items) => has(items, "outputStyle") || has(items, "statusLine", (i) => real(i) && i.enabled.state === "active"),
  },
];

export interface Progress {
  total: number;
  doneCount: number;
  done: SetupStep[];
  todo: SetupStep[];
  complete: boolean;
}

export function progress(items: SetupItem[], steps: SetupStep[] = SETUP_STEPS): Progress {
  const done = steps.filter((s) => s.done(items));
  const todo = steps.filter((s) => !s.done(items));
  return { total: steps.length, doneCount: done.length, done, todo, complete: todo.length === 0 };
}

export function progressTitle(p: Progress): string {
  return p.complete ? "Your setup is complete" : `Your setup: ${p.doneCount} of ${p.total} done`;
}
