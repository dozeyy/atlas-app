// What the Now tab receives. Mirrors crates/core/src/now/model.rs (camelCase). Nothing in
// here is prompt or message text: tool names, paths, a command's first word, titles, numbers.

export interface NowDoing {
  /** read, edit, write, run, search, web, helper, plan, ask, tool, think or wait: picks the icon. */
  kind: string;
  /** "Editing", "Running", "Reading 3 files", "Waiting for you". */
  verb: string;
  /** The file, command word or site the verb acts on. */
  target: string | null;
}

export interface NowStep {
  id: string;
  kind: string;
  verb: string;
  target: string | null;
  tsMs: number;
  done: boolean;
  /** The helper that made the call, if it was not the chat itself. */
  by: string | null;
}

export interface NowHelper {
  id: string;
  name: string;
  doing: NowDoing | null;
  tokens: number;
  costUsd: number | null;
  startedMs: number | null;
  done: boolean;
}

export interface NowFile {
  path: string;
  edited: boolean;
}

export interface NowChat {
  sessionId: string;
  title: string | null;
  project: string;
  model: string | null;
  state: "working" | "waiting";
  startedMs: number | null;
  /** While waiting: how long the last stretch of work took, ms. */
  workedMs: number | null;
  lastWriteMs: number;
  doing: NowDoing;
  tokens: number;
  costUsd: number | null;
  unpriced: boolean;
  helpers: NowHelper[];
  /** Newest first. */
  files: NowFile[];
  /** Oldest first. */
  steps: NowStep[];
}

export interface NowLast {
  sessionId: string;
  title: string | null;
  project: string;
  model: string | null;
  endedMs: number;
}

export interface NowSnapshot {
  chats: NowChat[];
  last: NowLast | null;
  /** Atlas has a Claude folder to watch. */
  watching: boolean;
}

export const EMPTY_NOW: NowSnapshot = { chats: [], last: null, watching: true };
