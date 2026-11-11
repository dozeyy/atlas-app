// What the Now tab receives. Mirrors crates/core/src/now/model.rs (camelCase). Nothing in
// here is prompt or message text: tool names, paths, a command's first word, titles, numbers.

import type { TokenKinds } from "./usage";

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
  /** Identical calls in a row folded into this step (1 = a single call). */
  count: number;
  /** The helper that made the call, if it was not the chat itself. */
  by: string | null;
}

/** A helper's own task list as counts only (never the step text). */
export interface NowPlan {
  done: number;
  total: number;
}

/** What a typical run of this kind of helper looks like: the median of its finished runs. */
export interface NowTypical {
  /** Median tool calls. */
  calls: number;
  /** Median length, ms. */
  ms: number;
  /** How many finished runs the medians come from. */
  runs: number;
}

/** The call a helper is waiting on: a kind and one safe word, never the command itself. */
export interface NowOpenCall {
  kind: string;
  /** "cargo", or "a command", "a helper", "the web", "a tool". */
  word: string;
}

export interface NowHelper {
  id: string;
  name: string;
  doing: NowDoing | null;
  /** The headline total (counted like every total; the Settings switch decides about the cache). */
  tokens: number;
  /** The same tokens by kind, for the hover. */
  tokenKinds: TokenKinds;
  costUsd: number | null;
  startedMs: number | null;
  /** It said its last word; the list keeps it a few seconds, then the engine drops it. */
  done: boolean;
  /** "code-reviewer", "Explore": what kind of helper it is. */
  agentType: string | null;
  /** What it was sent to do: the dispatcher's short description (80 characters at most). */
  goal: string | null;
  /** Tool calls made so far. */
  toolCalls: number;
  /** Its task list, once it has 2 or more steps and one has moved. */
  plan: NowPlan | null;
  /** The typical run of this kind (5 or more finished runs behind it), else null. */
  typical: NowTypical | null;
  /** What its last few calls add up to: "Reading", "Testing", "Getting started". */
  phase: string;
  /** When its newest line was written, epoch ms. */
  lastLineMs: number | null;
  openCall: NowOpenCall | null;
  /** The model id its newest lines name ("claude-opus-5-5"), else null. */
  model: string | null;
  /** The effort level its newest line says ("high"), else null. Never a default. */
  effort: string | null;
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
  /** The reasoning effort of the newest reply; null when the transcript gives none. */
  effort?: string | null;
  state: "working" | "waiting";
  startedMs: number | null;
  /** While waiting: how long the last stretch of work took, ms. */
  workedMs: number | null;
  lastWriteMs: number;
  doing: NowDoing;
  /** The headline total (counted like every total; the Settings switch decides about the cache). */
  tokens: number;
  /** The same tokens by kind, for the hover. */
  tokenKinds: TokenKinds;
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
  effort?: string | null;
  endedMs: number;
  /** Tokens the chat used, when Atlas read the whole chat; null when only its tail was read. */
  tokens: number | null;
  /** The same tokens by kind; null when only the tail was read. */
  tokenKinds: TokenKinds | null;
}

export interface NowSnapshot {
  chats: NowChat[];
  /** The newest finished chat (the first of `recent`). */
  last: NowLast | null;
  /** The few chats that finished most recently, newest first. */
  recent: NowLast[];
  /** Atlas has a Claude folder to watch. */
  watching: boolean;
}

/** A chat Atlas watched working has stopped: it finished (`done`) or asked a question (`ask`). */
export interface NowFinished {
  sessionId: string;
  name: string;
  project: string;
  kind: "done" | "ask";
  workedMs: number | null;
}

export const EMPTY_NOW: NowSnapshot = { chats: [], last: null, recent: [], watching: true };
