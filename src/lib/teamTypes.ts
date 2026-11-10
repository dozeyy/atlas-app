// The Team tab's shapes. Mirrors crates/core/src/usage/scorecard.rs and crates/app/src/team.rs
// (serde camelCase).

import type { Cost, Tokens } from "./usageTypes";

export type StartedFrom = "all" | "interactive" | "headless";

export interface ScorecardArgs {
  /** Runs that started in the last N days; omitted = all history. Times in these shapes are ms. */
  days?: number | null;
  agentType?: string | null;
  startedFrom: StartedFrom;
}

export interface EndCounts {
  finished: number;
  errored: number;
  stopped: number;
  unknown: number;
}

export interface StartedSplit {
  interactive: number;
  headless: number;
}

export interface VerdictCounts {
  pass: number;
  findings: number;
  partial: number;
  other: number;
  none: number;
}

export interface ReviewCounts {
  tied: number;
  passed: number;
  sentBack: number;
  other: number;
  notTied: number;
  /** A rate sentence is honest only from 5 tied reviews. */
  rateOk: boolean;
}

export interface ProjectRuns {
  projectKey: string;
  name: string;
  runs: number;
  tokens: number;
}

export interface ModelUse {
  model: string;
  modelName: string;
  effort: string | null;
  messages: number;
  runs: number;
}

export interface RunRow {
  sessionId: string;
  /** Empty: the chat itself ran as this agent. */
  agentId: string;
  started: number;
  durationMs: number;
  resumes: number;
  toolCalls: number;
  endStatus: "finished" | "errored" | "stopped" | null;
  endSource: string | null;
  verdict: "pass" | "findings" | "partial" | "other" | null;
  verdictWord: string | null;
  tokens: number;
  cost: Cost;
  entrypoint: string | null;
  headless: boolean;
  projectKey: string;
  project: string;
  worktreeBranch: string | null;
  model: ModelUse | null;
}

export interface TypeCard {
  agentType: string;
  displayName: string;
  reviewer: boolean;
  runs: number;
  ends: EndCounts;
  finishRate: number | null;
  tooFewRuns: boolean;
  toolCallsMedian: number | null;
  durationMsMedian: number | null;
  resumedRuns: number;
  tokens: Tokens;
  cost: Cost;
  /** Runs started per rolling week, oldest first, the last one ending today (always 12). */
  weekly: number[];
  started: StartedSplit;
  verdicts: VerdictCounts | null;
  reviews: ReviewCounts | null;
  projects: ProjectRuns[];
  topModel: ModelUse | null;
  mix: ModelUse[];
  recent: RunRow[];
}

export interface Scorecard {
  fromTs: number | null;
  toTs: number;
  /** "History covers the last N days": the age of the oldest chat in the cache. */
  historyDays: number | null;
  totalRuns: number;
  types: TypeCard[];
}

export interface ThemeArgs {
  days?: number | null;
  limit?: number | null;
}

export interface SeverityCount {
  severity: string;
  count: number;
}

export interface TypeCount {
  agentType: string;
  count: number;
}

export interface ThemeExample {
  text: string;
  sessionId: string;
  agentId: string;
  ts: number;
}

export interface ReviewTheme {
  id: string;
  label: string;
  count: number;
  runs: number;
  severities: SeverityCount[];
  foundInWorkBy: TypeCount[];
  notTied: number;
  reviewers: TypeCount[];
  projects: string[];
  /** The folders behind `projects`, most findings first. A rule is written to a folder, so the page hands these back. */
  projectPaths: string[];
  lastSeen: number;
  examples: ThemeExample[];
}

export interface MadeRule {
  path: string;
  madeMs: number;
}

export interface Themes {
  fromTs: number | null;
  findings: number;
  total: number;
  themes: ReviewTheme[];
  /** Theme id -> where it already became a rule. */
  made: Record<string, MadeRule>;
}

// ---- Make this a rule ----------------------------------------------------------------

export interface RuleTarget {
  /** `global`, `project:<folder>` or `file`. */
  id: string;
  /** `line` (a line in a CLAUDE.md) or `file` (a new rule file). */
  kind: "line" | "file";
  title: string;
  path: string;
  /** What the file looked like when the sheet opened; handed back with Save. */
  stamp: string;
  exists: boolean;
  text: string;
  blocked: string | null;
  /** For a CLAUDE.md line: the lines around where the rule lands. Empty or null: no preview. */
  preview: PreviewLine[] | null;
}

/** `keep` is already in the file, `added` is a heading Atlas adds, `slot` is the rule itself. */
export interface PreviewLine {
  kind: "keep" | "added" | "slot";
  text: string;
}

export interface RuleSheetData {
  targets: RuleTarget[];
}

export interface RuleSave {
  themeId: string;
  label: string;
  projectPaths: string[];
  targetId: string;
  text: string;
  stamp: string;
}

export interface RuleReply {
  /** `already`: the line was in the file, nothing was written. */
  status: "saved" | "already" | "conflict";
  backupId: string | null;
  path: string | null;
  message: string | null;
  /** A quiet extra sentence on success. */
  note: string | null;
}
