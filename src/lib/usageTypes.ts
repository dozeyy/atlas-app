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

export interface SessionDetail {
  row: SessionRow;
  byModel: { model: string; tokens: Tokens; cost: Cost }[];
  byAgent: { agentId: string | null; messages: number; tokens: Tokens; cost: Cost }[];
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
