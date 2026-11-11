# Tray readout and chat search

**What it is:** two features Will picked on 2026-11-08: (1) a tray / menu-bar icon that
shows today's tokens and estimated spend; (2) full-text search over the text of every
Claude Code transcript (user + assistant messages, subagents included).
**Status:** built on branch `tray-search`. The search UI waits for `fun-pass` to merge;
this branch is backend, IPC, types and the mock only.

---

## 1. Tray readout
- Icon: `crates/app/icons/tray.png` (64 px, the clay mark on transparent, from
  `assets/brand/atlas-mark-1024.png`); macOS gets `tray-template.png` (black + alpha,
  template image so the menu bar tints it).
- Text: `Today: <tokens> tokens · ~$<cost> est.` Tokens = the headline definition
  (input + output, or with cache writes and reads when Settings > Count cache in token totals is on; Q2); cost = `Cost.usd` from the same query, always
  "est."; `+` after the amount when some tokens are unpriced. First index still running:
  `Reading your Claude history...`. No Claude folder: `Atlas`.
- Menu: the readout line (disabled), separator, **Open Atlas**, **Quit Atlas**. The same
  line is the tooltip. Left click opens / focuses the main window (same path as the
  single-instance handler, and it does nothing while the launch intro owns the window).
- Refresh: event-driven. The usage engine's `Changed` event (already coalesced to 1 per
  second) and its `Idle` status nudge a tray thread; a 60 s timer is the fallback (it also
  rolls the day over at midnight). Text unchanged = no OS call. The query is one
  `fetch_hours` over today (`UsageEngine::today`), no dashboard build.
- Close-to-tray: Settings flag `closeToTray`, default **false**. `SettingsPatch.closeToTray`
  added; no UI yet (Settings screen belongs to `fun-pass`). Only honoured when the tray
  actually exists.

## 2. Chat search

### Where it lives
- Own file `search.sqlite` next to `cache.sqlite` in Local AppData (fixtures / `--config-dir`
  get `caches/<hash>.search.sqlite`). **Separate from the usage cache on purpose:** the
  usage cache holds numbers and no message text (D15/D43); this file holds text. It can be
  deleted at any time and rebuilds. It refuses to live inside the Claude config folder.
- Code: `crates/core/src/search/` (`mod.rs` engine, `db.rs` schema, `extract.rs` lines to
  text, `mask.rs` secrets, `query.rs` FTS query + results). Transcripts are opened only
  through `usage::reader` (read-only).

### Schema (user_version 1)
- `sfiles(file_id, path UNIQUE, fs_id, head_hash, head_len, size, mtime_ns, offset, missing,
  session_id, is_subagent, agent_id, project)`: one row per transcript, same identity rules as
  the usage `files` table (D3-D5): resume at `offset`; new version if the id, head hash or
  size says so.
- `msgs(id PK, uuid UNIQUE, file_id, session_id, agent_id, role, ts)`: `id` is the FTS rowid.
  `uuid` dedups a message copied into a resumed session (first indexed wins).
- `fts` = `fts5(text, tokenize='unicode61 remove_diacritics 2')`, content stored (needed for
  `snippet()`). `meta(key, value)`: `parser_version`; a change wipes and re-reads.

### Ingest
- One background thread (`search-index`), one writer, below-normal thread priority on Windows.
  Triggers: usage `Idle` after its first index, usage `Changed`, a 5 min sweep, window focus.
  It never runs while the usage first index is still going (they would fight for the disk).
- Pass = walk the projects folder (stat only), skip files whose size + mtime match, otherwise
  open once, check identity, read `[offset, EOF)` with the shared 1 MiB streaming reader.
  Newest files first, so recent chats are searchable first. Commit every ~2,000 messages or
  16 MiB with the new offset in the same transaction (a kill loses nothing, never doubles).
- A line is parsed only if it holds `"type":"user"` or `"type":"assistant"` and is not a
  tool-result-only line. Text blocks only (no thinking, no tool input, no tool output),
  `isMeta` skipped, 20,000 chars per message (same cap as the transcript view).
- Secrets are masked **before** indexing (`***`), so the file never holds them and a
  search cannot find them. Snippets get a second check on the way out.
- Cancel: an `AtomicBool` checked per line; `stop()` joins the thread; the offset commits
  where it got to. Files that disappear are flagged `missing`, their text stays searchable
  (Atlas keeps what Claude Code sweeps, same as the usage ledger).
- Subagent files attribute to the parent session (`agentId` kept for the UI).

### Query
- `search_chats(query, limit, offset)` -> `SearchPage { hits, hasMore, tookMs, index }`.
  `limit` clamps to 1..=50. Free text is turned into a safe FTS5 expression: every word is
  quoted, the last bare word is a prefix (`wor*`, search as you type), `"quoted phrases"`
  stay phrases, all terms AND. No input can produce an FTS syntax error.
- Order: `bm25` ascending, then `ts` descending. Snippet: `snippet(fts, 0, ...)` of 16
  tokens, returned as `[{text, hit}]` parts (no HTML to inject).
- Hit: `{ id, sessionId, agentId, project, projectName, ts, role, snippet[] }`.
- Also `search_status` (state, files done / total, messages, db bytes) and the event
  `atlas://search/status`; the page returns `index` too so the UI can say "still indexing".

## 3. Perf budgets (measured numbers: `docs/bench/search-2026-11-08.md`)
| Metric | Budget |
|---|---|
| First build, real 5.5 GB, release, warm OS cache | <= 60 s, UI and usage never wait |
| No-change pass | <= 300 ms |
| One appended chat line to searchable | <= 1.5 s after the usage `Changed` event |
| Query 1 word / 3 words / phrase, p95 | <= 50 ms |
| Index size | reported, no budget (text is the data) |
| Memory | no more than the usage indexer: 1 MiB reader + one batch |

## 4. Open questions
- Retention: the file keeps text after Claude Code sweeps the transcript (30 days default).
  Good for search, but it is a second copy of conversation text on disk. Settings should say
  so and offer "Forget search history" (delete the file).
- Resumed sessions copy history: uuid dedup keeps the first indexed copy; the other
  session's hit is lost. Alternative: keep both.
- The 20,000 char cap drops the tail of huge pasted logs.
- Ranking: bm25 favours short messages; "then recency" only breaks exact ties.
- Result click: needs "open session at this message" (a transcript cursor by message). The
  hit carries `id` for it; the transcript API has no seek-by-message yet.
- Linux tray needs appindicator; if the tray cannot be created, close-to-tray stays off.
