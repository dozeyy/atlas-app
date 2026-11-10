// Chat search: mirrors crates/core/src/search (query.rs and mod.rs).

/** One piece of a snippet; `hit` marks the words that matched the query. */
export interface SnippetPart {
  text: string;
  hit: boolean;
}

export interface SearchHit {
  /** The message's row id in the index (stable until the index is rebuilt). */
  id: number;
  /** A helper's (subagent's) messages carry the parent session's id. */
  sessionId: string;
  /** Set when a helper of that session wrote the message. */
  agentId: string | null;
  project: string;
  projectName: string;
  /** Epoch milliseconds. */
  ts: number | null;
  role: "user" | "assistant";
  /** Short, already masked (anything that looked like a secret is "***"). */
  snippet: SnippetPart[];
}

export type SearchState = "waiting" | "indexing" | "idle" | "error";

export interface SearchStatus {
  state: SearchState;
  /** The first full build has finished: results cover every chat on disk. */
  ready: boolean;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  messages: number;
  dbBytes: number;
  /** Milliseconds, like every time in the UI (the engine sends seconds; `indexedAtMs` in ipc.ts). */
  lastIndexedAt: number | null;
  error: string | null;
}

export interface SearchPage {
  hits: SearchHit[];
  hasMore: boolean;
  tookMs: number;
  index: SearchStatus;
}
