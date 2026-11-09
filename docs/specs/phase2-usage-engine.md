# Phase 2 - Usage engine

**What it is:** the build spec for the part of Atlas that reads Claude Code session
transcripts, keeps a durable usage ledger in SQLite, prices it, and serves the
Dashboard, Sessions (list + detail) and usage-timeline queries to the front end.
**Status:** spec, 2026-11-08. Not started. Builds on Phase 1 (in progress when this was
written: `crates/core/src/{paths,fsutil,sandbox,settings,launch}.rs`,
`crates/app/src/{state,commands,main}.rs`, `src/lib/{ipc,types,mock}.ts`,
`fixtures/claude-{basic,edge}`, `tools/make-fixtures.py`).
**Sources:** `CLAUDE.md` (roadmap, safety invariants), `BUILD-PROMPT.md` (data sources
A and B; features 1 and 2), `docs/phase0-recon.md` (wins over the spec), the live
pricing page (fetched 2026-11-08), and read-only measurements of Will's
`~/.claude/projects` (2026-11-08, below).

---

## Goal
- Every assistant API call in `projects/**/*.jsonl` (main + `subagents/`) is counted
  exactly once, with the correct (last-line) usage, priced from an editable data file,
  and stored in a ledger that outlives Claude Code's 30-day transcript sweep.
- The UI never waits on transcript I/O: it paints from the cache, the first-ever index
  runs in the background with visible progress, and live sessions update within ~1 s.
- `~/.claude` is only ever read.

## Not in scope (this spec)
- The visual build of the Dashboard charts, Sessions table, Session Detail screen,
  heatmap and Wrapped (separate UI spec through `ui-builder`; this spec delivers their
  data and one progress strip).
- Full-text search / FTS5 (roadmap Phase 2 item; separate spec, see Open questions).
- The "Edit prices" screen (BUILD-PROMPT feature 9). Prices are editable by editing the
  JSON file; the screen comes later.
- Real API spend via the Admin API (BUILD-PROMPT data source C).
- Spend alerts, tray readout, Wrapped (Phase 7); they will consume these queries.
- Filtering out Atlas-assistant sessions (Phase 6; a column is reserved for it).
- `history.jsonl`, `stats-cache.json`, `~/.claude.json` `lastModelUsage` (not read).
- Change history / backups / Undo (that is the History page; Phase 4).

---

## Measured baseline (Will's machine, read-only, 2026-11-08)
| Measure | Value | How |
|---|---|---|
| Transcript files | 1,884 (1,511 subagent) | `find projects -name '*.jsonl'` |
| Total bytes | 5.35 GB | sum of sizes |
| Largest file | 300.0 MB (299,968,107 B), 26,708 lines, 6,217 assistant lines | `wc -l`, `grep -c` |
| Total lines | 658,832 | `cat` + `awk` |
| Longest single line | 2,065,864 chars (largest file: 1,362,852) | `awk length` |
| Lines containing `"type":"assistant"` | 222,998 (about half are duplicates per recon) | `grep -o` + `wc -l` |
| Raw sequential read, all files | 6.9 s first run, 3.9 s second (OS cache warm) | `xargs cat > /dev/null` |
| Raw read, largest file | 0.30 s (warm) | `cat > /dev/null` |
- Cold-cache (after reboot) read time was **not** measured; the bench harness must.

## Performance budgets (pass/fail; bench harness, release build, Will's PC)
| Metric | Budget | Measured on |
|---|---|---|
| First full index, OS cache warm | <= 30 s | real `projects/` (5.35 GB), read-only path |
| First full index, cold (first run after reboot) | <= 90 s (or "not measured" + reason if a cold cache can't be forced) | same |
| Synthetic 300 MB single file, full parse | <= 6 s | generated at bench time |
| No-change rescan (stat all files, zero bytes parsed) | <= 300 ms | real data, after full index |
| One append of <= 64 KB to one file -> DB commit | <= 50 ms after the debounce fires | bench append test |
| Append on disk -> `atlas://usage/changed` reaches the page | <= 1.0 s (500 ms debounce + work) | app log timestamps |
| Indexer peak memory (process working set) | <= 250 MB during full index; a 300 MB file adds <= 32 MB over a 1 MB file | bench prints `PeakWorkingSetSize` / `ru_maxrss` |
| Per-line buffer | hard cap 64 MiB; longer lines skipped and counted | unit test |
| `usage_dashboard` | <= 50 ms | real cache + synthetic 1,000,000-message cache |
| `usage_timeline` 365 days x day | <= 50 ms | same |
| `sessions_list` page of 50, any sort | <= 50 ms | same |
| `session_detail` (largest session) | <= 100 ms | same |
| UI thread | zero transcript or SQLite work; first paint unchanged from Phase 1 | `[atlas] startup` line before/after |
| Dashboard populated from an existing cache | < 2 s from launch (CLAUDE.md) | log `usage: dashboard ready <ms>` |

---
## Decisions made (each line is a review checklist item)
**Reading**
- D1. Only `<projects_dir>/<proj>/<session>.jsonl` and
  `<projects_dir>/<proj>/<session>/subagents/*.jsonl` are read. Nothing else under the
  config root is opened (`tool-results/`, `memory/`, `.credentials.json`, `sessions/`
  never touched). `projects_dir` comes from Phase 1 `ConfigRoot::projects_dir`.
- D2. Every transcript open goes through one function, `usage::reader::open_read_only`,
  using `OpenOptions::new().read(true)` only. On Windows the Rust default share mode
  (read | write | delete) stays, so Claude Code can keep appending and its sweep can
  delete a file Atlas is reading. No write/create/remove/rename call exists anywhere in
  `crates/core/src/usage/`.
- D3. File identity = (path, fs id, head hash). fs id: Windows volume serial + file
  index (`winapi-util`), Unix (dev, ino). Head hash: SHA-256 of the first 4 KiB (whole
  file if shorter), refreshed until the file reaches 4 KiB.
- D4. Rescan rule per file: same fs id + head hash and size >= committed offset -> read
  only `[offset, EOF)`. Size < offset, fs id changed, or head hash changed -> a new file
  version, read from 0 (rows upsert by key, so re-reading is safe). File gone ->
  `files.missing = 1`; its rows stay.
- D5. The committed offset is the byte after the last `\n` read. A trailing partial line
  is never parsed or committed; the next pass re-reads it. The offset and the rows parsed
  from those bytes commit in the same SQLite transaction.
- D6. Streaming only: `BufReader` (1 MiB) + one reusable line buffer per worker; no
  `read_to_end` / `read_to_string` / `fs::read` on a transcript, ever. A line longer than
  64 MiB is skipped by scanning to the next `\n` without buffering, counted in
  `files.long_lines`.
- D7. Cheap prefilter before JSON: a line is fully parsed only if it contains one of
  `"type":"assistant"`, `"type":"custom-title"`, `"type":"agent-name"`,
  `"type":"relocated"`, `"type":"cost-state"` (`memchr::memmem`). `api-request*` and
  every other type are skipped unparsed. (Escaped JSON inside a string cannot produce
  these exact bytes.)
- D8. Parse into serde structs that borrow `&str` and skip unknown fields; never into
  `serde_json::Value`. A line that fails to parse, or an `assistant` line missing
  `message.id`, `requestId`, `message.model` or `message.usage`, is counted in
  `files.malformed_lines` and skipped; the file continues.
- D9. A UTF-8 BOM at offset 0 and CRLF line endings are tolerated.
- D10. Not API calls, skipped: model `<synthetic>`, and lines whose four token counts
  are all 0 (e.g. `isApiErrorMessage`). Counted in diagnostics, not stored.

**Identity, dedup, attribution**
- D11. Message key = `message.id + "|" + requestId`, global primary key.
- D12. Within one file the **last** line for a key wins (all usage fields replaced).
  Across files (recon saw none; still possible after resume/fork) the row with the
  higher `output_tokens` wins, a tie keeps the existing row; each cross-file collision
  increments `meta.cross_file_dupes`. The result is independent of scan order.
- D13. Session id = the line's `sessionId`; for a subagent line without one, the
  `<session>` folder above `subagents/`. Subagent rows carry `agent_id` (`agentId`) and
  `is_sidechain` and roll up into the parent session.
- D14. Project = `cwd` of the session's first line that has one; a `relocated` line
  replaces it with `relocatedCwd`. A session never splits across projects. The folder
  name is never decoded. Grouping key = the path with separators normalized and, on
  Windows and macOS, case-folded; the display path keeps the original spelling.
- D15. Session title = latest `custom-title` > latest `agent-name` > none (UI shows
  "Session in <project folder name>"). No message text is stored in the cache.
- D16. `cost-state.totalCostUSD`, when present, is stored per session as Claude Code's
  own figure for a cross-check; it is never the displayed cost.

**Tokens and pricing**
- D17. Stored per message: `input_tokens`, `output_tokens`, cache writes split 5m/1h
  from `cache_creation.ephemeral_{5m,1h}_input_tokens`, `cache_read_input_tokens`,
  `server_tool_use.{web_search_requests, web_fetch_requests}`,
  `output_tokens_details.thinking_tokens` (info only; already inside output), `speed`,
  `inference_geo`, `service_tier`, `attributionSkill`, `attributionMcpServer`,
  `attributionMcpTool`, `timestamp`.
- D18. Missing `cache_creation` breakdown -> all of `cache_creation_input_tokens` is
  booked as 5m and the row is flagged `cw_assumed = 1` (Open question Q4). A breakdown
  that does not sum to the total wins over the total; the mismatch is counted.
- D19. `usage.iterations[]` is not summed; top-level counts are used (Q3).
- D20. Prices are a data file, not code: bundled seed
  `crates/core/pricing/pricing.default.json` (also `include_str!`-ed as the last-resort
  fallback) and the live copy `<data_dir>/pricing.json`, created from the seed on first
  run. The live copy is watched; an edit reprices instantly with no reindex and no
  rebuild. A live copy that fails validation is ignored (last good table kept) and the
  error shows in `usage_status`.
- D21. Seed upgrade: when a newer app ships a seed with a later `updated`, the live copy
  is replaced only if its content hash still equals the seed it came from (never
  edited); otherwise it is kept and status says a newer price list is available.
- D22. Model match is the exact id, or an id listed in that model's `aliases`. No
  prefix, family or "closest model" matching. Anything else is an **unknown model**:
  its tokens count everywhere, its cost is `null`, and it is listed in warnings.
- D23. Modifiers: `speed: "fast"` uses the model's `fast` input/output rates, with cache
  rates scaled by the same ratio as the base rates (pricing page: caching multipliers
  stack on fast mode); a fast row on a model with no `fast` entry is unpriced.
  `inference_geo: "us"` x 1.1 on every category; `"global"` x 1.0. Any other geo,
  speed, or `service_tier` other than `"standard"` -> unpriced (cost `null`, tokens
  kept, warning). Never guessed.
- D24. Haiku 5.5 long-context tier is decided per request: prompt = input + cache read +
  cache writes; > 100,000 -> the `longContext` rates for that whole request (pricing
  page). Stored as `price_tier` on the message.
- D25. Web search: `webSearchPerThousand` x requests / 1000 ($10 per 1,000). Web fetch:
  $0 extra (pricing page). Both shown as their own line in breakdowns.
- D26. Cost is computed at query time from token buckets x the loaded price table, in
  f64 dollars; never stored. A cost figure carries `complete: false` and the unpriced
  token count when any row in it was unpriced. UI copy always says "estimated".

**Cache (SQLite)**
- D27. rusqlite, `bundled`. Location: `<data_dir>/cache.sqlite` when `projects_dir` is
  the real default (`~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects`), else
  `<data_dir>/caches/<first 16 hex of sha256(canonical projects_dir)>.sqlite`, so
  fixtures, `--config-dir` folders and excluded-projects sandboxes never mix into the
  real ledger. A sandbox that links the real logs read-only shares the real ledger (same
  `projects_dir`). If the cache path would fall inside `ConfigRoot.dir`, the engine
  refuses to start (state `error`).
- D28. Pragmas `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`,
  `busy_timeout=5000`. One writer connection on the indexer thread; two read-only
  connections in a small `Mutex<Vec<Connection>>` pool for commands. No r2d2.
- D29. Schema version = `PRAGMA user_version`; parser version in `meta`. Migrations are
  forward-only Rust functions `m0001...`, each in one transaction. A DB with a newer
  `user_version` than the app knows opens read-only, is never migrated or indexed, and
  the status says so.
- D30. Parser version bump -> background re-read of every file still on disk from 0
  (upsert; ledger rows of missing files kept). Never blocking.
- D31. Durable ledger: no row is ever deleted because a transcript disappeared.
- D32. Corruption: an open error `SQLITE_CORRUPT` / `SQLITE_NOTADB`, or a failing
  `PRAGMA quick_check` run in the background after first paint -> close; rename the DB
  (and `-wal`/`-shm`) to `*.corrupt-<unix ts>`; restore the newest `cache.sqlite.bak`
  if it passes `quick_check`, else start empty; then index. Status says only transcripts
  still on disk could be recovered.
- D33. Backup snapshot: `VACUUM INTO cache.sqlite.bak.tmp`, then atomic rename to
  `cache.sqlite.bak`, after a full index and at most once per 24 h, off the UI thread.
  One snapshot kept. (It is what protects pre-sweep history from corruption.)
- D34. Batches commit every <= 5,000 parsed lines or <= 64 MiB read, whichever comes
  first; a killed app loses at most one batch and resumes from committed offsets.
- D35. Aggregates are recomputed for the touched keys after each batch (`DELETE` +
  `INSERT ... SELECT ... GROUP BY` for the affected `hour_local` buckets and sessions),
  not maintained by +/- arithmetic. Self-healing; a full rebuild is the same SQL.
- D36. Time: messages store `ts_utc_ms`. Buckets use the OS local time zone at index
  time (`chrono::Local`), stored as `hour_local` (`YYYY-MM-DDTHH`); `meta` keeps a tz
  fingerprint and a change triggers a background recompute. "Today" = local calendar
  day; "7 days" = today + previous 6; "30 days" = today + previous 29. Weeks start Monday
  (ISO; Q9).
- D37. Token "total" = input + output + cache writes + cache reads (what is billed);
  every response also carries each part (Q2).

**Threads, watching, IPC**
- D38. Every usage Tauri command is `async` (Tauri 2 runs sync commands on the main
  thread) and does its SQLite work inside `tauri::async_runtime::spawn_blocking`.
- D39. Indexer: `std::thread::scope` workers, `min(available_parallelism - 1, 4)`,
  files ordered largest first; workers parse, a bounded `sync_channel(8)` feeds the
  single writer. No rayon, no tokio in core.
- D40. The engine starts after `frontend_ready` (no transcript or cache I/O before first
  paint) and restarts on a config-root change (sandbox toggle, folder override); the
  running pass is cancelled at the next batch boundary.
- D41. Watcher: `notify` recursive on `projects_dir`; own trailing debounce of 500 ms
  with a 2 s max wait (a constantly-appending live session still refreshes); only
  `*.jsonl` paths queue work. Watcher error/overflow, window focus, and a 5-minute timer
  while the window is visible trigger a stat sweep (D4) as the safety net.
- D42. Events are coalesced: progress <= 10 per second, `changed` <= 1 per second.
- D43. Session Detail's readable transcript streams from the jsonl files on demand
  (user/assistant text blocks only, each capped at 20,000 chars), never cached. Missing
  files -> "no longer on disk" instead of text.
- D44. New core dependencies: `rusqlite` (bundled), `memchr`, `sha2`, `chrono` (clock),
  `notify`, `winapi-util` (Windows only). Each serves a decision above; nothing else.

---

## Seed price table (`pricing.default.json`)
- Source of every number: `https://platform.claude.com/docs/en/about-claude/pricing`,
  fetched 2026-11-08 (Model pricing table + footnotes 1-3, Fast mode, Data residency,
  Long context and Web search sections). Seed `updated: "2026-11-08"`.
- Cross-checked with the `claude-api` skill (bundled with CLI 2.1.317, model table
  cached 2026-10-06): input/output agree on every row. **One disagreement:** the skill
  gives Sonnet 5.5 cache reads as $0.20; the live page gives $0.10 (footnote 2: 0.05x of
  $2). The live page wins.
- USD per million tokens:

| Model id | Input | Output | 5m write | 1h write | Cache read | Fast in / out | Note |
|---|---|---|---|---|---|---|---|
| `claude-fable-5-1` | 10 | 50 | 12.50 | 20 | 0.25 | - | read = 0.025x |
| `claude-fable-5` | 10 | 50 | 12.50 | 20 | 1.00 | - | seen on Will's PC |
| `claude-opus-5-5` | 4 | 20 | 5 | 8 | 0.20 | 8 / 40 | read = 0.05x |
| `claude-opus-5` | 5 | 25 | 6.25 | 10 | 0.50 | 10 / 50 | |
| `claude-opus-4-8` | 5 | 25 | 6.25 | 10 | 0.50 | 10 / 50 | |
| `claude-opus-4-7` | 5 | 25 | 6.25 | 10 | 0.50 | - | no fast mode on 4.7 |
| `claude-opus-4-6` | 5 | 25 | 6.25 | 10 | 0.50 | - | |
| `claude-sonnet-5-5` | 2 | 10 | 2.50 | 4 | 0.10 | - | read = 0.05x |
| `claude-sonnet-5` | 2 | 10 | 2.50 | 4 | 0.20 | - | intro price made standard (footnote 3) |
| `claude-sonnet-4-6` | 3 | 15 | 3.75 | 6 | 0.30 | - | |
| `claude-haiku-5-5` (prompt <= 100k) | 0.10 | 0.50 | 0.125 | 0.20 | 0.01 | - | |
| `claude-haiku-5-5` (prompt > 100k) | 0.50 | 2.50 | 0.625 | 1 | 0.05 | - | `longContext` block |
| `claude-haiku-4-5` | 1 | 5 | 1.25 | 2 | 0.10 | - | |
- Global keys: `webSearchPerThousand: 10`, `webFetchPerThousand: 0`,
  `geoMultipliers: {"global": 1.0, "us": 1.1}`, `serviceTiers: ["standard"]`.
- Entry shape: `"claude-opus-5-5": {"input": 4, "output": 20, "cacheWrite5m": 5,
  "cacheWrite1h": 8, "cacheRead": 0.2, "fast": {"input": 8, "output": 40},
  "aliases": [], "source": "<pricing url>#model-pricing"}`. Haiku 5.5 adds
  `"longContext": {"thresholdTokens": 100000, "input": 0.5, "output": 2.5,
  "cacheWrite5m": 0.625, "cacheWrite1h": 1, "cacheRead": 0.05}`. Top level:
  `schemaVersion, updated, currency, unit, source, webSearchPerThousand,
  webFetchPerThousand, geoMultipliers, serviceTiers, models`.

---
## Cache schema v1 (`m0001`)
- `meta(key TEXT PK, value TEXT)`: `parser_version`, `projects_dir`, `tz_fingerprint`,
  `created_at`, `last_full_index_at`, `cross_file_dupes`, `last_backup_at`.
- `files(file_id INTEGER PK, path TEXT, fs_id TEXT, head_hash BLOB, size INTEGER,
  mtime_ns INTEGER, offset INTEGER, session_id TEXT, agent_id TEXT, is_subagent INTEGER,
  missing INTEGER, malformed_lines INTEGER, long_lines INTEGER, last_seen_at INTEGER,
  UNIQUE(path, fs_id))`.
- `sessions(session_id TEXT PK, project_key TEXT, project_path TEXT, title TEXT,
  title_source TEXT, first_ts INTEGER, last_ts INTEGER, messages INTEGER,
  subagent_messages INTEGER, entrypoint TEXT, cc_version TEXT, cc_cost_usd REAL,
  is_atlas_assistant INTEGER DEFAULT 0, missing INTEGER)`.
- `messages(msg_key TEXT PK, session_id TEXT, file_id INTEGER, line_offset INTEGER,
  agent_id TEXT, is_sidechain INTEGER, model TEXT, ts_utc_ms INTEGER, hour_local TEXT,
  input INTEGER, output INTEGER, cw5m INTEGER, cw1h INTEGER, cr INTEGER,
  cw_assumed INTEGER, web_search INTEGER, web_fetch INTEGER, thinking INTEGER,
  speed TEXT, geo TEXT, service_tier TEXT, price_tier INTEGER, skill TEXT,
  mcp_server TEXT, mcp_tool TEXT) WITHOUT ROWID`; indexes `(session_id, ts_utc_ms)`,
  `(hour_local)`, `(ts_utc_ms)`.
- `usage_hour(hour_local, project_key, model, speed, geo, service_tier, price_tier,
  input, output, cw5m, cw1h, cr, web_search, web_fetch, messages; PK = first 7 cols)`.
- `session_model(session_id, model, speed, geo, service_tier, price_tier, <same token
  cols>, messages; PK = first 6 cols)` so sort-by-cost runs in SQL.
- Read connections load prices into `TEMP TABLE prices`, refreshed on `pricing/changed`.

---

## Tauri commands (all `async`; camelCase JSON; types mirrored in `src/lib/types.ts`)
| Command | Args | Returns |
|---|---|---|
| `usage_status` | - | `UsageStatus` |
| `usage_dashboard` | - | `Dashboard` |
| `usage_timeline` | `{from: "YYYY-MM-DD", to, bucket: hour/day/week/month, groupBy?: model/project}` | `Timeline` |
| `sessions_list` | `SessionQuery` | `SessionPage` |
| `session_detail` | `{sessionId}` | `SessionDetail` |
| `session_transcript` | `{sessionId, cursor?, limit? (<= 100)}` | `TranscriptPage` |
| `usage_filter_options` | - | `{projects: ProjectRef[], models: ModelRef[]}` |
| `usage_reindex` | `{scope: changed/full}` | `UsageStatus` |
| `pricing_get` | - | `{table, path, error: string or null, newerSeedAvailable: bool}` |
| `pricing_reveal` | - | opens `pricing.json` in the OS file manager |

## Events
- `atlas://usage/status` -> `UsageStatus` on every state change.
- `atlas://usage/progress` -> `{phase: scanning/indexing/aggregating, filesDone,
  filesTotal, bytesDone, bytesTotal, startedAt}` (<= 10 per second).
- `atlas://usage/changed` -> `{sessionIds, fromDay, toDay, reason:
  append/index/reprice/tz}` (<= 1 per second).
- `atlas://pricing/changed` -> same payload as `pricing_get`.

## Query shapes
- `Tokens = {input, output, cacheWrite5m, cacheWrite1h, cacheRead, total, webSearch,
  webFetch}`; `Cost = {usd: number or null, complete: bool, unpricedTokens: number}`.
- `UsageStatus = {state: idle/indexing/error/readOnly/recovering, firstIndexDone,
  lastIndexedAt, filesTracked, filesMissing, malformedLines, longLines, unknownModels:
  string[], cwAssumedRows, crossFileDupes, cachePath, cacheBytes, error, note}`.
- `Dashboard = {today, week, month: {tokens: Tokens, cost: Cost, sessions},
  byModel: [{model, known, tokens, cost}] (30 days), topProjects: [{projectKey, name,
  path, tokens, cost, sessions}] (30 days, top 8 + "other"), recent: SessionRow[8],
  warnings: {unknownModels, unpricedTokens}}`.
- `Timeline = {bucket, points: [{start, tokens, cost, sessions}] (zero-filled),
  series?: [{key, label, points}]}`; serves the usage chart, the year heatmap (365 x day)
  and hour-of-day stats.
- `SessionQuery = {from?, to?, projects?, models?, text? (title or project contains,
  case-insensitive), minCostUsd?, includeMissing?, sort: start/cost/tokens/duration,
  dir: asc/desc, cursor?, limit (<= 200)}`.
- `SessionRow = {sessionId, title, projectName, projectPath, startedAt, endedAt,
  durationMs, models, messages, subagentMessages, tokens, cost, missing}`;
  `SessionPage = {rows, nextCursor, total}` (keyset cursor).
- `SessionDetail = {row, byModel: [{model, tokens, cost}], byAgent: [{agentId or null,
  messages, tokens, cost}], timeline: [{ts, model, agentId, tokens, cost, skill}],
  files: [{path, isSubagent, missing}], claudeCodeCostUsd}`.
- `TranscriptPage = {items: [{ts, role, agentId, text, truncated}], nextCursor,
  sourceMissing}`.

---

## Files
| Path | Purpose |
|---|---|
| `crates/core/Cargo.toml` | add the D44 dependencies |
| `crates/core/src/lib.rs` | `pub mod usage; pub mod cache;` |
| `crates/core/src/cache/mod.rs` | open (D27, D28), read pool, quick_check, corrupt recovery (D32), backup (D33) |
| `crates/core/src/cache/migrate.rs` | `user_version`, `m0001`, newer-version read-only (D29) |
| `crates/core/src/usage/mod.rs` | `UsageEngine`: start/stop/cancel, status, event-sink trait (no Tauri types) |
| `crates/core/src/usage/scan.rs` | walk `projects_dir`, classify main/subagent, stat, fs id, head hash, diff vs `files` (D1, D3, D4) |
| `crates/core/src/usage/reader.rs` | `open_read_only`, offset reads, partial-line hold-back, 64 MiB cap, BOM/CRLF (D2, D5, D6, D9) |
| `crates/core/src/usage/line.rs` | prefilter + borrowed serde structs -> `LineEvent` (D7, D8, D10, D17) |
| `crates/core/src/usage/ingest.rs` | worker pool, dedup (D12), batch writer, aggregate refresh (D34, D35, D39) |
| `crates/core/src/usage/pricing.rs` | load / validate / seed-upgrade / watch pricing JSON, cost math, unknown flags (D20-D26) |
| `crates/core/src/usage/time.rs` | local hour buckets, ranges, tz fingerprint (D36) |
| `crates/core/src/usage/query.rs` | dashboard, timeline, sessions list/detail, filter options |
| `crates/core/src/usage/transcript.rs` | paged text reader for Session Detail (D43) |
| `crates/core/src/usage/watch.rs` | notify + debounce + sweeps (D41) |
| `crates/core/pricing/pricing.default.json` | seed price table with sources |
| `crates/core/tests/usage_fixtures.rs` | fixture acceptance tests |
| `crates/core/tests/usage_huge.rs` | generated huge-file and long-line tests |
| `crates/core/tests/usage_cache.rs` | migration, corruption, newer-schema, crash-resume tests |
| `crates/core/examples/usage_bench.rs` | bench harness (`--projects --data --gen-huge --runs --append-test --json`) |
| `tools/make-fixtures.py` | add `usage()` -> `fixtures/usage/` |
| `fixtures/usage/**` | generated usage edge cases (below) |
| `crates/app/src/usage.rs` | Tauri commands + event bridge (implements the core event sink) |
| `crates/app/src/state.rs` | owns `Arc<UsageEngine>`; start after `frontend_ready`; restart on root change |
| `crates/app/src/main.rs` | register the usage commands |
| `src/lib/types.ts` | usage types above |
| `src/lib/ipc.ts` | `Backend` usage methods + listeners |
| `src/lib/mock.ts` | MockBackend usage data matching the basic numbers below |
| `src/components/IndexProgress.tsx` | first-run progress strip (Dashboard + Sessions empty states) |
| `src/lib/usage.test.ts`, `src/components/IndexProgress.test.tsx` | front-end contract + progress tests |
| `docs/bench/usage-YYYY-MM-DD.md` | bench output kept with the commit that met the budgets |

## New fixture `fixtures/usage/` (from `make-fixtures.py`; no real text)
- An unknown model `claude-nova-9` (made-up id) and a date-suffixed id with no alias.
- Fast-mode `claude-opus-5-5`; `inference_geo: "us"`; `service_tier: "priority"`;
  3 web searches + 2 web fetches; a 1h cache write; a cache write with no
  `cache_creation` breakdown; a breakdown that does not sum.
- `claude-haiku-5-5` requests above and exactly at 100,000 prompt tokens.
- The same key in two files with different `output_tokens`.
- A `relocated` line; `custom-title` and `agent-name` both present; `cost-state`.
- A CRLF file, a BOM file, a subagent file whose lines lack `sessionId`.
- An `isApiErrorMessage` line with zero usage; timestamps either side of local midnight.
- Generated **at test time, never committed**: shrunk/rotated files, deleted files, a
  same-size replacement, live appends, a 64 MiB + 1 line, the huge files.

---
## Acceptance criteria
Commands run from the repo root; test names are the ones to create.
1. `cargo test -p atlas-core --test usage_fixtures` exits 0.
2. `basic_totals_match`: indexing `fixtures/basic` yields exactly 6 messages,
   3 sessions, 2 projects (`/fixture/app`, `/fixture/other`); totals input 697,
   output 538, cache write 2,000 (all 5m), cache read 6,000.
3. `dedup_keeps_last_line`: `msg_A` output = 120 (not 5), `msg_SA1` output = 77 (not 3);
   total output 538 (first-seen dedup would give 349).
4. `subagents_roll_up`: session `11111111-...-000000000001` has 4 messages (A, B, C,
   SA1), input 680, output 509, cache write 2,000, cache read 6,000,
   `subagentMessages` 1, and `byAgent` lists `f1`.
5. `basic_cost_matches_price_table` (tolerance 1e-9): total $0.0166325; session 1
   $0.0152725; `msg_A` (sonnet-5-5) $0.0064; `msg_C` (opus-5-5) $0.0088; `msg_D`
   (fable-5) $0.0011; `msg_E` (opus-4-8) $0.00026.
6. `synthetic_and_half_line_skipped`: `msg_S` (`<synthetic>`) and `msg_HALF` are absent;
   session 1 file offset = the byte after its last `\n`.
7. `half_line_completed_later`: completing the `msg_HALF` line in a temp copy and
   rescanning adds exactly that message; no other row changes.
8. `garbage_never_crashes`: `fixtures/edge` indexes with 0 messages,
   `malformedLines` >= 4, `empty.jsonl` tracked at offset 0, no panic.
9. `unknown_model_flagged`: `claude-nova-9` tokens are in every total, its cost is
   `null`, its day and session costs have `complete: false` with the right
   `unpricedTokens`, and `unknownModels` lists it and the date-suffixed id.
10. `modifiers_priced`: fast opus-5-5 (in 1,000 / out 1,000) = $0.048; geo `us`
    opus-5-5 (in 1,000 / out 1,000) = $0.0264; 3 web searches add $0.03; web fetches add
    $0; the `service_tier: "priority"` row is unpriced.
11. `haiku_long_context_tier`: haiku-5-5 with input 90,000 + cache read 20,000 + output
    1,000 = $0.0485 (long tier); the request at exactly 100,000 uses base rates.
12. `cache_write_split`: 1h writes priced at the 1h rate; the missing breakdown is booked
    as 5m with `cwAssumedRows` = 1; the non-summing breakdown uses the breakdown.
13. `cross_file_dupe_order_independent`: indexing the two-file duplicate in both orders
    gives the same row (higher output) and `crossFileDupes` = 1.
14. `project_from_cwd_and_relocated`: project comes from `cwd`, `relocated` overrides it,
    the folder name is never used; on Windows `C:\X\Proj` and `c:\x\proj` group together.
15. `titles`: custom-title beats agent-name; neither -> `title: null`.
16. `rotation_and_deletion`: (a) a shrunk file is re-read from 0 with no duplicate rows;
    (b) a same-size replacement with different bytes (head hash change) is re-read;
    (c) a deleted file keeps its rows and sets `missing`; (d) deleting a file while it is
    being read ends that file's pass without error (Windows).
17. `incremental_reads_only_new_bytes`: after a full index, appending N bytes and
    rescanning reads exactly N bytes (reader byte counter) from that one file only.
18. `local_day_buckets`: with an injected test time zone, lines either side of local
    midnight land on the right days; today / 7 days / 30 days follow D36.
19. `read_only_guarantee`: a snapshot (bytes + mtimes + file list) of a temp copy of each
    fixture root is identical before and after full index, rescans and transcript reads.
20. `no_write_calls_in_usage`: a test greps `crates/core/src/usage/` and finds no
    `write(true)`, `create(`, `File::create`, `remove_file`, `remove_dir`, `rename(`,
    and no `OpenOptions` outside `reader::open_read_only`.
21. `cache_outside_config_root`: a data dir inside the config root -> engine state
    `error`, nothing written anywhere.
22. `cargo test -p atlas-core --test usage_cache` exits 0, covering: (a) a fresh DB gets
    `user_version` 1; (b) an empty DB migrates; (c) `user_version` 99 opens read-only,
    state `readOnly`, file bytes unchanged; (d) a DB of random bytes is renamed to
    `*.corrupt-*`, a valid `.bak` is restored, indexing completes; (e) with no `.bak`, an
    empty DB is created and indexing completes; (f) stopping the writer between batches
    (test hook) and restarting resumes from the committed offset with identical totals.
23. `pricing_file`: first run copies the seed to `<data>/pricing.json`; editing a price
    there changes `usage_dashboard` cost with zero transcript bytes read and emits
    `pricing/changed`; invalid JSON keeps the last good table and sets `error`; both D21
    branches tested; every seed model has `source`, and the file has `updated`.
24. `cargo test -p atlas-core --test usage_huge` exits 0: a generated 16 MiB file with
    2 MiB and 8 MiB lines parses correctly; a 64 MiB + 1 byte line is skipped and counted;
    the line buffer never exceeds the cap (instrumented).
25. `cargo test -p atlas-core --test usage_huge -- --ignored` generates a 300 MB file in a
    temp dir, indexes it, asserts the message count, deletes it; `git status` is clean
    afterwards.
26. `cargo run --release -p atlas-core --example usage_bench -- --projects <real
    projects dir> --data <temp dir> --runs 3 --append-test` prints, and
    `docs/bench/usage-<date>.md` records, every budget row with PASS/FAIL; all PASS (the
    cold row may read "not measured" with the reason). The bench checks its own
    before/after size + mtime listing of `--projects` and fails if anything changed.
27. The bench prints Atlas's estimate vs `cost-state.totalCostUSD` for sessions that
    have one (count, median and max deviation). Report only; no threshold (Q5).
28. App: `npm run tauri dev -- -- --config-dir fixtures/basic` (or the Phase 1
    equivalent) logs `usage: index done 6 messages`, and the `[atlas] startup` line
    prints before any `usage:` line.
29. App in Sandbox Mode (real logs linked read-only): the first run shows the progress
    strip advancing (screenshots at 1600x900 mid-index and after), then the Dashboard
    empty state gives way to data. `[Will]` judges that the strip reads calm.
30. Live update in Sandbox Mode: during a real Claude Code session, within 1 s of each
    assistant reply the app logs `usage: changed` and that session's tokens in
    `sessions_list` grow.
31. `npm test` exits 0 with `usage.test.ts` (the mock returns the basic numbers
    through the same types) and `IndexProgress.test.tsx` (0 %, mid, done and error
    states; reduced motion = no animation).
32. `[Will]`: while the real data indexes, window drag/resize and sidebar clicks feel
    instant. Code review confirms D38 (no sync usage command).
33. `cargo clippy -p atlas-core -p atlas -- -D warnings` and `npm run build` are clean.

## Done when
- Criteria 1-33 pass with evidence (test output, the bench file, log lines, screenshots).
- Every budget row is PASS in `docs/bench/usage-<date>.md` on Will's PC.
- code-reviewer and verifier both pass; `MEMORY.md` has the entry with measured numbers;
  committed.

## Risk-floor flags
- Not on the risk floor (no money movement, credentials, live instance, production
  deploy, installer) and not on the gate list.
- Big and multi-area -> code-reviewer + verifier required.
- Closest risk: the read-only invariant on the real `~/.claude/projects` (the bench and
  Sandbox linked mode read real logs). The reviewer checks D1, D2 and criteria 19-21, 26.
- Privacy: no message text in the cache (D15, D43); bench output prints counts and model
  ids only, never text.

## Suggested agent chain (after Phase 1 is committed)
1. `desktop-app-dev`, unit A: `crates/core` cache + usage engine + pricing + fixture +
   tests + bench (criteria 1-27, 33 core part).
2. `perf-profiler`, only if a budget row fails.
3. `desktop-app-dev`, unit B: `crates/app` commands/events/watcher wiring, `src/lib`
   types/ipc/mock, `IndexProgress` (criteria 28-33). Sequential after A (same repo).
4. `verify-auditor`: prove the tests can fail (plant first-seen dedup, a whole-file read,
   a prefix model match, a sync command).
5. `code-reviewer` (the D-list as its checklist) in parallel with `verifier`
   (criteria 1-33).

---

## Conflicts found (spec vs recon vs this brief)
- Dedup: the spec says "by message ID + request ID" without saying which line; the recon
  says keep the **last**. This spec follows the recon (D12).
- Pricing: the spec has one "cache write" price; the recon and the pricing page need 5m
  and 1h writes, web search, fast mode, the geo multiplier and the Haiku 5.5
  long-context tier (D23-D25).
- File key: the spec says path + size + mtime; the recon adds the file id; this spec adds
  a head hash for same-size replacement (D3).
- History page: the brief says the engine feeds a History timeline; `BUILD-PROMPT`
  section 8, `CLAUDE.md` and the Phase 1 History placeholder define History as the
  change/backup timeline (Phase 4). This spec delivers `usage_timeline` without picking
  its page (Q1).
- Cache path: `CLAUDE.md` names one `<appdata>/atlas/cache.sqlite`; this spec keeps that
  path for the real logs and adds per-root caches for fixtures and other roots (D27).
- `claude-api` skill vs the live pricing page: Sonnet 5.5 cache read $0.20 vs $0.10; the
  page wins.

## Amendments, 2026-11-08 (subagents, item usage; cache schema v2 and v3)

- **Schema v2 (`m0002`)**: `agents(session_id, agent_id, file_id, agent_type, description,
  tool_use_id, parent_agent_id, spawn_depth, prompt_summary)` and `sessions.prompt_summary`,
  `files.tool_calls`. Subagent
  files are read like any other file; their messages count once, under the parent session
  (line `sessionId`, else the parent folder). The helper's name comes from its `.meta.json`
  sidecar (`description`, then `agentType`), then a short summary of its first prompt, then
  "Helper". The parent `Agent` tool_use is not parsed for naming; the sidecar is enough and
  is present for every real helper checked.
- **Privacy amendment (explicit exception to D15 and D43, at Will's direction)**: one line of
  at most 80 characters of the first prompt is cached, as `prompt_summary`, to name sessions
  and helpers that have no title or description. The full prompt is never cached: it is read
  from the transcript when a helper's detail is opened (`transcript::first_prompt`, capped at
  4,000 characters) and is not stored.
- **Commands added**: `usage_agent_detail {sessionId, agentId}` returns `AgentDetail`
  (tokens, cost, models, duration, tool calls, prompt, timeline); `session_detail` now
  carries `agents` and `main` (the main thread alone) and `sessions_list` rows carry `name`,
  `nameSource` and `agentCount`. Helpers are never rows of their own.
- **Schema v3 (`m0003`) and item usage**: `item_use(file_id, session_id, hour_utc,
  hour_local, kind, item, uses, last_ts)`, one row per file, session, hour, kind and item,
  `kind` being `tool` (every tool_use name), `skill` (`Skill`, `input.skill`) or `agent`
  (`Agent` or `Task`, `input.subagent_type`, else `general-purpose`). `PARSER_VERSION` is
  "3", so an old cache re-reads once. `hour_local` follows the time zone and is rewritten
  with the other buckets when the zone changes.
- **`usage_by_item {kind, from?, to?, sessionId?, limit?}`** returns
  `[{id, kind, uses, sessions, lastUsed}]`, busiest first. `uses` and `sessions` count the
  local days `from..to` (inclusive); `lastUsed` (epoch ms) is the last time ever, so
  "used this month" is `uses > 0` and "never used" is an installed item that is not in the
  list. Never-used items are not returned. The Setup page reads this as
  `uses30d` = `uses` over the last 30 days.
- **Caveat**: tool calls are counted each time they appear, and about 1 % of tool ids repeat
  across files (resumed sessions), so a call can count twice; token totals are de-duplicated.
- **Time zones**: day buckets use the zone offset at the time of the call; a zone with a
  half-hour offset or a daylight change shifts a call near midnight to the neighbouring day
  the same way the token buckets move.
- Tests: `crates/core/tests/usage_agents.rs` (8) and `usage_items.rs` (9) with the synthetic
  fixtures `fixtures/agents` and `fixtures/items`. Invented sample prompts in
  fixtures carry `"fixtureText": true`, which the "no real text" guard accepts.

## Open questions
- Q1. Where does the usage timeline live: the Dashboard (usage chart + heatmap) only, or
  a usage tab on the History page, which the spec reserves for change history?
- Q2. Is the hero "tokens" number the billed total (cache reads can be most of it) or
  input + output only? D37 defaults to the billed total; Will decides what dad sees.
- Q3. `usage.iterations[]`: do the top-level counts already include the iterations? D19
  assumes yes; unit A checks one real multi-iteration line (read-only) before release.
  **Answered 2026-11-08 (Will's default: never add iterations on top of top-level).**
  Read-only scan of the real `~/.claude/projects` (assistant lines carrying the key,
  numbers only, no text kept): 181,889 lines have `usage.iterations`; 256 are empty arrays;
  all 181,633 non-empty ones hold exactly one iteration, and for 181,631 of them the
  iteration's input, output, cache-read and cache-creation counts equal the top-level
  counts exactly. Adding the iterations on top would double count about 181,000 lines, so
  D19 stands. The other 2 lines are one message written twice with all-zero top-level
  counts and a populated iteration; the parser already skips all-zero lines
  (`Skip::ZeroUsage`), so the earlier full copy of that message is the one that counts.
  Limit of the evidence: this machine has no line with two or more iterations, so
  "top-level is the sum over several iterations" is untested. If a line with several
  iterations ever shows up and its top-level counts are smaller than their sum, the
  Dashboard undercounts it (it never double counts); repeat the scan then.
- Q4. Does Claude Code ever write 1h cache tokens without the `cache_creation`
  breakdown? D18 books those as 5m.
- Q5. What deviation between Atlas's estimate and Claude Code's `cost-state` figure is
  acceptable (criterion 27 reports it; no threshold set)?
- Q6. Full-text search: its own Phase 2 spec (as the roadmap says), or move it to a
  later phase?
- Q7. On Windows `<appdata>` resolves to Roaming (`dirs::data_dir`, Phase 1). A cache of
  hundreds of MB would sync with a roaming profile: move the cache to Local
  (`dirs::data_local_dir`) and keep settings in Roaming?
- Q8. Retention: offering to raise `cleanupPeriodDays` (recon item 11) writes Claude
  Code's settings. Which phase, and is it in v1?
- Q9. Week start: ISO Monday (D36) or the OS locale's first day on dad's Mac?