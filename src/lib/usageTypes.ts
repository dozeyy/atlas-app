// Usage engine shapes. Mirrors crates/core/src/usage (serde camelCase).

export interface Tokens {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** The headline total, counted by Rust: input + output, plus cache writes and reads when Settings > "Count cache in token totals" is on. */
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
  /** Milliseconds, like every time in the UI (the engine sends seconds; `indexedAtMs` in ipc.ts). */
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

/** Replies that ran at one reasoning effort ("low" ... "max"). Most used first. */
export interface EffortUse {
  effort: string;
  replies: number;
}

export interface ModelUse {
  model: string;
  known: boolean;
  tokens: Tokens;
  cost: Cost;
  /** Per reasoning effort; empty when the transcripts gave none (never guessed). */
  efforts?: EffortUse[];
}

export interface ModelSpend {
  model: string;
  /** The price list knows the model (Session and helper detail send it). */
  known?: boolean;
  tokens: Tokens;
  cost: Cost;
  efforts?: EffortUse[];
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
  /** The main conversation's model (most tokens), "" when unknown. */
  mainModel?: string;
  /** The main conversation's reasoning efforts, most used first; empty when none recorded. */
  efforts?: EffortUse[];
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

/** Everything since the first recorded day: the same totals the `atlas-usage` CLI prints for `all`. */
export interface Lifetime {
  /** First local day with any usage; null on an empty cache. */
  firstDay: string | null;
  today: string;
  total: Period;
  /** The day with the most tokens; null when no day has any. */
  busiest: { day: string; tokens: Tokens; cost: Cost } | null;
  /** Most tokens first. */
  byModel: ModelUse[];
  /** Local days with tokens, oldest first. */
  activeDays: string[];
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

/** What the Wrapped story needs beyond the other lists: chat shapes, helper work, the busiest crowd. */
export interface WrappedHabits {
  /** Chats with a message in the range. */
  chats: number;
  /** Of those, chats whose messages span under ten minutes. */
  shortChats: number;
  /** Of those, chats whose messages span two hours or more. */
  longChats: number;
  /** Tokens in the range (the headline unit), and the part helpers spent. */
  allTokens: number;
  helperTokens: number;
  /** The chat that started the most helpers; null when no chat started one. */
  mostHelpers: SessionRow | null;
  /** The chat with the most tokens in all (its whole length); null when the range has no chat. */
  biggest: SessionRow | null;
  /** Whole-chat tokens of exactly those `chats` (not chats that are gone), for a true average. */
  chatTokens: number;
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
  efforts?: EffortUse[];
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
  byModel: ModelSpend[];
  timeline: MessagePoint[];
  file: { path: string; isSubagent: boolean; missing: boolean } | null;
  prompt: string | null;
  promptTruncated: boolean;
  sessionTokens: Tokens;
  sessionCost: Cost;
}

export interface SessionDetail {
  row: SessionRow;
  byModel: ModelSpend[];
  byAgent: { agentId: string | null; messages: number; tokens: Tokens; cost: Cost }[];
  /** The helpers, in the order they started. `row` is main plus every helper. */
  agents: AgentSummary[];
  /** The main conversation alone. */
  main: MainThread;
  timeline: MessagePoint[];
  files: { path: string; isSubagent: boolean; missing: boolean }[];
  claudeCodeCostUsd: number | null;
}

// ---- where it went (one chat's receipt) ---------------------------------------

/** Dollars by what was bought. `input` is fresh, uncached input. */
export interface ReceiptKinds {
  output: number;
  cacheWrite: number;
  cacheRead: number;
  input: number;
  web: number;
}

/** Tokens by what they were. Which of them add up to the headline is the Settings switch (`Receipt.countsCache`). */
export interface ReceiptTokenKinds {
  output: number;
  cacheWrite: number;
  input: number;
  cacheRead: number;
}

export interface ReceiptModel {
  model: string;
  usd: number;
  /** The figure the pages headline for this model (counted like every total). */
  tokens: number;
  /** The same tokens by kind, for the hover. */
  tokenKinds: ReceiptTokenKinds;
}

/** A big thing that went into the conversation. `usd` is an estimate. */
export interface ReceiptItem {
  /** One file read however often, one big result, or many small results of one tool. */
  kind: "read" | "output" | "outputs";
  tool: string;
  path: string | null;
  count: number;
  tokens: number;
  usd: number | null;
  /** The thread's name when exactly one thread produced it. */
  thread: string | null;
}

export type ReceiptFlagKind = "repeat_read" | "huge_output" | "heavy_helper" | "cache_miss";

export interface ReceiptFlag {
  kind: ReceiptFlagKind;
  /** The file, the tool, or the helper's name. */
  label: string;
  agentId: string | null;
  count: number;
  tokens: number;
  usd: number | null;
  /** cache_miss: the longest pause. */
  minutes: number | null;
  model: string | null;
  /** heavy_helper: what it did, most used first. */
  tools: string[];
}

/** How a helper ended, only where the transcript says. */
export type Outcome = "finished" | "errored" | "stopped";

/** The main chat (`agentId` null) or one helper: its spend and its slice of the receipt. */
export interface ReceiptThread {
  agentId: string | null;
  name: string;
  parentAgentId: string | null;
  spawnDepth: number;
  model: string;
  usd: number;
  tokens: number;
  cacheReadTokens: number;
  messages: number;
  durationMs: number;
  toolCalls: number;
  kinds: ReceiptKinds;
  tokenKinds: ReceiptTokenKinds;
  models: ReceiptModel[];
  outcome: Outcome | null;
  items: ReceiptItem[];
  itemsOtherUsd: number;
  flags: ReceiptFlag[];
  unpricedTokens: number;
}

/** Every view lists its lines plus an "everything else" remainder, so lines + remainder == totalUsd. */
export interface Receipt {
  sessionId: string;
  totalUsd: number | null;
  complete: boolean;
  /** The transcripts could be read, so big items and most flags are present. */
  scanned: boolean;
  /** Main chat first, then the helpers in the order they started. */
  threads: ReceiptThread[];
  threadsOtherUsd: number;
  models: ReceiptModel[];
  modelsOtherUsd: number;
  kinds: ReceiptKinds;
  kindsOtherUsd: number;
  /** The setting "Count cache in token totals" was on: every headline below includes cache writes and reads, so the by-kind lines must too. */
  countsCache: boolean;
  /** The chat's headline tokens (counted like every total), and its tokens by kind. */
  totalTokens: number;
  tokenKinds: ReceiptTokenKinds;
  items: ReceiptItem[];
  itemsOtherUsd: number;
  flags: ReceiptFlag[];
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
