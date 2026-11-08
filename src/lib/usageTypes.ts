// Usage engine shapes. Mirrors crates/core/src/usage (serde camelCase).

export interface Tokens {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** input + output + cache writes. Cache reads are shown apart (Q2). */
  total: number;
  webSearch: number;
  webFetch: number;
}

export interface Cost {
  /** null when nothing in the span could be priced. */
  usd: number | null;
  /** false when some tokens had no price (unknown model, priority tier). */
  complete: boolean;
  unpricedTokens: number;
}

export type IndexState = "idle" | "indexing" | "error" | "readOnly" | "recovering";

export interface UsageStatus {
  state: IndexState;
  firstIndexDone: boolean;
  lastIndexedAt: number | null;
  filesTracked: number;
  filesMissing: number;
  malformedLines: number;
  longLines: number;
  unknownModels: string[];
  cwAssumedRows: number;
  crossFileDupes: number;
  cachePath: string;
  cacheBytes: number;
  error: string | null;
  note: string | null;
}

export interface IndexProgress {
  phase: string;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  startedAt: number;
}

export interface UsageChanged {
  sessionIds: string[];
  fromDay: string | null;
  toDay: string | null;
  reason: string;
}

export interface Period {
  tokens: Tokens;
  cost: Cost;
  sessions: number;
}

export interface ModelUse {
  model: string;
  known: boolean;
  tokens: Tokens;
  cost: Cost;
}

export interface ProjectUse {
  projectKey: string;
  name: string;
  path: string;
  tokens: Tokens;
  cost: Cost;
  sessions: number;
}

export interface SessionRow {
  sessionId: string;
  title: string | null;
  /** The title, else a one-line summary of the first prompt, else null (say "Session in <project>"). */
  name: string | null;
  nameSource: "title" | "agent" | "prompt" | "none";
  /** Helpers (subagents) that ran inside this session. They are never rows of their own. */
  agentCount: number;
  projectName: string;
  projectPath: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  models: string[];
  messages: number;
  subagentMessages: number;
  tokens: Tokens;
  cost: Cost;
  missing: boolean;
}

export interface Dashboard {
  today: Period;
  week: Period;
  month: Period;
  byModel: ModelUse[];
  topProjects: ProjectUse[];
  recent: SessionRow[];
  warnings: { unknownModels: string[]; unpricedTokens: number };
  todayDate: string;
}

export type Bucket = "hour" | "day" | "week" | "month";

export interface TimelinePoint {
  start: string;
  tokens: Tokens;
  cost: Cost;
  sessions: number;
}

export interface Timeline {
  bucket: Bucket;
  points: TimelinePoint[];
  series: { key: string; label: string; points: TimelinePoint[] }[] | null;
}

export type SessionSort = "started" | "cost" | "tokens" | "duration";

export interface SessionQuery {
  from?: string | null;
  to?: string | null;
  projects?: string[];
  models?: string[];
  text?: string | null;
  /** Also list these sessions (the chats a message search found), whatever `text` matched. */
  alsoIds?: string[];
  minCostUsd?: number | null;
  includeMissing?: boolean;
  sort?: SessionSort;
  dir?: "asc" | "desc";
  cursor?: string | null;
  limit?: number;
}

export interface SessionPage {
  rows: SessionRow[];
  nextCursor: string | null;
  total: number;
}

export interface MessagePoint {
  ts: number;
  model: string;
  agentId: string | null;
  tokens: Tokens;
  cost: Cost;
  skill: string | null;
}

export type ItemKind = "skill" | "agent" | "tool";

/** Which items to count: a kind, local days (inclusive, YYYY-MM-DD), optionally one session. */
export interface ItemQuery {
  kind: ItemKind;
  from?: string | null;
  to?: string | null;
  sessionId?: string | null;
  limit?: number;
}

/**
 * One skill, helper type or tool Claude has called. `uses` and `sessions` count the period
 * asked for (0 when it ran only before it); `lastUsed` is the last time ever (epoch ms).
 * Something that never ran is not in the list.
 */
export interface ItemUse {
  id: string;
  kind: ItemKind;
  uses: number;
  sessions: number;
  lastUsed: number | null;
}

export interface AgentSummary {
  agentId: string;
  name: string;
  nameSource: "description" | "type" | "prompt" | "fallback";
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  parentAgentId: string | null;
  spawnDepth: number;
  model: string;
  models: string[];
  messages: number;
  tokens: Tokens;
  cost: Cost;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  toolCalls: number;
  missing: boolean;
}

export interface MainThread {
  messages: number;
  tokens: Tokens;
  cost: Cost;
  toolCalls: number;
}

export interface AgentDetail {
  sessionId: string;
  sessionName: string | null;
  projectName: string;
  agent: AgentSummary;
  parentName: string | null;
  byModel: { model: string; tokens: Tokens; cost: Cost }[];
  timeline: MessagePoint[];
  file: { path: string; isSubagent: boolean; missing: boolean } | null;
  prompt: string | null;
  promptTruncated: boolean;
  sessionTokens: Tokens;
  sessionCost: Cost;
}

export interface SessionDetail {
  row: SessionRow;
  byModel: { model: string; tokens: Tokens; cost: Cost }[];
  byAgent: { agentId: string | null; messages: number; tokens: Tokens; cost: Cost }[];
  /** The helpers, in the order they started. `row` is main plus every helper. */
  agents: AgentSummary[];
  /** The main conversation alone. */
  main: MainThread;
  timeline: MessagePoint[];
  files: { path: string; isSubagent: boolean; missing: boolean }[];
  claudeCodeCostUsd: number | null;
}

export interface TranscriptItem {
  ts: number | null;
  role: string;
  agentId: string | null;
  text: string;
  truncated: boolean;
}

export interface TranscriptPage {
  items: TranscriptItem[];
  nextCursor: string | null;
  sourceMissing: boolean;
}

export interface FilterOptions {
  projects: { projectKey: string; name: string; path: string }[];
  models: { model: string; known: boolean }[];
}

export interface PricingInfo {
  table: { updated: string; currency: string; unit: string; source: string };
  path: string;
  error: string | null;
  newerSeedAvailable: boolean;
}
