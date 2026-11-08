# Screens - History, Wrapped, Settings

**What it is:** the build spec for the three screens that are still placeholders or
thin: History and Wrapped (`src/pages/Placeholders.tsx`) and Settings
(`src/pages/Settings.tsx`). Will wants them done now, ahead of roadmap Phases 4 and 7.
**Status:** spec, 2026-11-08. Not started. Builds on main `299a834` plus the
`phase2-usage` (usage ledger), `phase3-setup` (Setup discovery + watcher) and
`launch-intro` (launch animation setting) branches, all three merged first.
**Sources:** `CLAUDE.md` (roadmap, safety invariants, Design Identity),
`BUILD-PROMPT.md` sections 6, 8, 9, `docs/phase0-recon.md` (wins over the spec), the
Phase 2 and Phase 3 specs and worktrees (`crates/core/src/{cache,usage,setup,layout}`),
`open-question-defaults-2026-11-08.md`, read-only measurements of Will's disk (below).

**Will's direction (verbatim):**
- "finish the rest of the screens fill the empty space"
- "It should be just like ready to go as soon as they open it. It should already have
  all their info for their Claude. And this should be super nice. I like the icons."
- "the UI does look pretty good, but it does not fit right now like a real Claude app
  should. This isn't going to be like a Claude app, but it should be more fun than like
  a big spreadsheet dump."
- Relayed: subagents nest under their parent session and are named by what they did.

---

## Goal
- All three screens show the user's **real** data the first time Atlas opens, with zero
  setup, read-only, no "Coming soon", no placeholder copy and no empty regions at
  1280x800 or at the 900x600 minimum window.
- Each screen is warm, friendly and a little playful: one hero moment per screen, human
  sentences instead of tables, Phosphor icons on every row, the topographic contour
  thread behind the hero areas.
- History records every change to the user's Claude setup from today on, and fills its
  past from what Claude Code itself already keeps on disk.
- `~/.claude`, `~/.claude.json` and project `.claude/` folders are only ever read.

## Not in scope
- **Restore / Undo writing into the real config** (recommended for Phase 4, see D-H20).
  This build offers "Copy this version" and "Save a copy..." outside the Claude folder.
- Reading the git history of `~/.claude` (Open Q1; default: not in this build).
- Wrapped "Export as image", the first-launch "Merry Christmas" intro card and
  auto-play on first launch (Phase 7 with the tray; Open Q4).
- Settings rows that need features not built yet: pricing table editor, spend alerts,
  Admin API key, launch at login, close-to-tray, MCP connect, "Export diagnostics"
  (their phases own them). No disabled rows for them either: they are simply absent.
- Offering to raise `cleanupPeriodDays` (a write to Claude Code's settings; Phase 4 per
  the Q8 default). Settings and Wrapped only *show* the value.
- History for plugin, synced (`anthropic-skills:`), managed and claude.ai connector
  items (installers change them; they are not the user's edits).
- `history.jsonl` (prompt text), `.credentials.json`, `sessions/`, `*.key`: never read.

---

## Measured on Will's disk (read-only, 2026-11-08)
| Source | What is there | Use |
|---|---|---|
| `~/.claude/backups/.claude.json.backup.<epoch-ms>` | 5 files, all 106,510 B, written 09:41-09:47 today (Claude Code keeps the 5 newest) | History import, redacted MCP view only |
| `~/.claude.json.backup` | 1 file, 105,096 B, 2026-11-05 | same |
| `~/.claude.json.bak-*` | 3 files, 2026-09-02/03 (Will's tooling, not Claude Code) | same, labelled "backup copy" |
| `~/.claude.json.tmp.<pid>.<hash>` | 1 orphan, 2026-08-19 | ignored, never parsed |
| `~/.claude/backups/` other entries | 22 folders/files of Will's own harness backups | ignored |
| `~/.claude/file-history/` | 27 session folders, 342 files, 5.4 MB, 2026-07-07..2026-11-08, names `<hash>@vN` | History import for config paths |
| `file-history-snapshot` lines in transcripts | 1,709 tracked entries, 138 distinct paths, 16 of them config paths (11 under `~/.claude`); value keys `backupFileName, backupTime, realParentDir, version` | maps a backup file to its path, session and time |
| User-scope setup files (skills, agents, rules, hooks, output-styles, settings, CLAUDE.md, keybindings) | 6,024 files, 61.7 MB; text files 4,278 = 4.2 MB; 12 files > 1 MB; mtimes 2026-06-09..2026-11-08; 9 distinct change days in the last 30 | baseline snapshot + "before Atlas" dates |
| `~/.claude` git repo | 16 commits, 2026-08-03..2026-10-25, 8 distinct days, 33 uncommitted changes | not read (Open Q1) |
| `settings.json` `cleanupPeriodDays` | unset (Claude Code default 30 days) | shown in Settings and Wrapped |
| Transcripts by month (mtime) | Jul 7, Sep 1, Oct 1,290, Nov 594 | Wrapped coverage: effectively Oct 9 on, plus a few July files |
| Phase 2 ledger (bench run) | 113,051 messages, 1,890 session files | Wrapped source |
| `.claude.json` `firstStartTime` | 2026-06-10 | Wrapped "with Claude Code since" line |
| `.claude.json` `skillUsage` / `pluginUsage` | 44 / 17 entries | not used (D-W9) |
| `attributionSkill` in transcripts | 22 distinct skills; top one on 3,249 lines | Wrapped top skill (already `messages.skill`) |
| `tool_use` blocks in transcripts | 145,271 lines carry one (before dedup) | Wrapped tools (needs D-W7) |
| `tools-used` lines | in 3 files only | not used |
| `stats-cache.json` | absent | not used |
| Layout tokens | sidebar 232 px, content max 960 px, page padding 40 px: inner width 880 px at 1280, 588 px at 900 | layout targets below |
---

## Decisions made (each line is a code-review checklist item)

### Shared (all three screens)
- D-S1. No `EmptyState` with a "Coming soon" badge remains; `Placeholders.tsx` loses
  `History` and `Wrapped` (and `Setup`, which Phase 3 replaces).
- D-S2. "Fills the space" is measured: at 1280x800 and 900x600 the first screen of each
  page has no blank band taller than 120 px between the header and the bottom edge, and
  no column leaves more than 160 px of unused width (fill probe, criterion 27).
- D-S3. Tone: headings and lines are human sentences in second person ("You changed 3
  skills this week"), never column headers. No table with more than 3 columns on these
  screens; lists are rows with an icon, a sentence and at most one number.
- D-S4. One hero moment per screen: History = "Your setup, over time" strip with the
  change-day ribbon; Wrapped = the year cover with the ticker number; Settings = the
  "Atlas on this computer" card. Each hero sits on the contour background (`Topo.tsx`)
  and uses the number ticker; reduce-motion swaps both for a fade.
- D-S5. Icons: Phosphor (the app's set), one icon per item kind, the same map Setup uses.
  Duotone weight on hero icons, regular in rows.
- D-S6. Subagents are never listed as their own sessions. Anything a subagent did counts
  once under its parent session and is named with the Phase 2 human name (the same
  function Sessions uses; no second naming rule).
- D-S7. All new commands are `async`; no file or SQLite work on the UI thread; payloads
  under 1 MB; types mirrored in `src/lib/types.ts`; `MockBackend` serves the same shapes
  so Vitest and the plain browser render all three screens.
- D-S8. Copy is ASCII-only, no emoji, no Anthropic or Claude logos.

### History
- D-H1. History tracks exactly the Setup items (Phase 3 discovery) that have a `path`,
  scope `user`, `project` or `local`, not worktrees, not denied by `layout::is_denied`,
  plus a **redacted MCP view** of `.claude.json` (user `mcpServers`, each project's
  `mcpServers`, `disabledMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers`),
  secrets masked with the Phase 3 masker before storing. `.claude.json` is never stored
  whole.
- D-H2. Store: `<local-appdata>/atlas/history/` (Local, not Roaming, per Q7):
  `history.sqlite` (index) + `blobs/<sha256[0..2]>/<sha256>` (content-addressed,
  deduped). Separate from `cache.sqlite`: history is not rebuildable and must survive a
  cache reset. Phase 4 write-path backups add rows to this same index.
- D-H3. Schema `h0001`: `items(item_key PK, kind, scope, project, name, path,
  first_seen_at, gone_at)`; `versions(version_id PK, item_key, sha256, bytes,
  captured_at, observed_mtime, source, origin_ref, session_id, agent_name)`;
  `events(event_id PK, item_key, at, kind added|changed|removed|renamed|dated,
  from_version, to_version, source, summary)`; `meta`. Sources written by this build:
  `atlas_snapshot`, `claude_backup`, `claude_edit`, `file_date`.
- D-H4. Baseline: on first run, after Setup discovery completes, every tracked text file
  <= 1 MiB is hashed and stored (Will: about 4.2 MB). Larger or binary files (a NUL in
  the first 8 KiB) are tracked by size + mtime + hash only, never stored; their diff
  reads "This file is too large or not text to compare."
- D-H5. Rescan: on every launch and on every Phase 3 `LiveSetup` change (debounced to
  2 s of quiet), stat tracked files and re-hash only those whose size or mtime moved;
  store a version only if the hash changed. A file gone -> `removed`; a removed + added
  pair with the same hash in one pass -> `renamed`.
- D-H6. Snapshotting runs on a background thread after first paint, yields to the
  usage indexer, and never blocks the UI.
- D-H7. Before Atlas, source 1 (`file_date`): one `dated` event per tracked item at its
  newest mtime: "Last changed on <date>. Atlas started keeping copies on <date>." No
  diff. A skill folder is one item, dated by its newest file.
- D-H8. Before Atlas, source 2 (`claude_backup`): Claude Code's own `.claude.json`
  copies (`<root>/backups/.claude.json.backup.<ms>`, `~/.claude.json.backup`) and
  `.claude.json.bak-*` siblings (labelled "backup copy") are read once each, reduced to
  the redacted MCP view (D-H1) and imported as versions at their mtime. Identical views
  collapse into one. Other names in `backups/` and `*.tmp.*` files are ignored.
- D-H9. Before Atlas, source 3 (`claude_edit`): the Phase 2 parser adds
  `"type":"file-history-snapshot"` to its prefilter and stores `(session_id, agent_id,
  path, backup_file, version, backup_time)` in a new cache table `file_backups`
  (`m0002`). History imports only rows whose `path` is a tracked item, reading
  `<root>/file-history/<session>/<backup_file>` read-only into the blob store
  (`origin_ref` = backup file name). Project source files are never imported.
- D-H10. What a `<hash>@vN` file holds (content before or after the edit) is verified on
  3 real samples before the importer is written; the finding goes into this spec and the
  wording follows it ("Claude changed this during <session title>"). A subagent edit
  names the parent session and the subagent's human name (D-S6).
  **Finding (built, `crates/core/src/history/import.rs`):** the copy for a tracked file is
  found through the transcripts' `file-history-snapshot` lines: each names a relative file
  plus a `backupFileName`; the tracked path is the relative name joined with the session's
  real parent dir (`realParentDir`), and the copy sits at
  `<config>/file-history/<sessionId>/<backupFileName>`. Only rows whose path is a tracked
  item are imported. The three real samples were not recorded as file names in this spec.
- D-H11. Imports are idempotent, keyed by (source, origin_ref, or path + mtime); a rerun
  adds nothing. They run at first launch and on each rescan for new files.
- D-H12. Prune: keep the newest N versions per item (default 50, Settings D-T6); never
  prune the newest version or the baseline of an item that still exists. Orphan blobs
  are deleted by a background sweep. Only Atlas's own `history/` folder is deleted from.
- D-H13. Diff in Rust (`similar` crate: line diff + inline word changes), 3 lines of
  context, unchanged runs collapsed as "N lines the same" (click to expand). Secrets are
  masked on both sides before diffing: a changed secret reads "a hidden value changed".
  A change in line endings or BOM only reads "Only line endings changed."
- D-H14. JSON files (settings, `.mcp.json`, keybindings, the MCP view) get a plain-words
  summary above the diff from a structural compare ("Added 3 allowed commands, changed
  the model from Sonnet to Opus, removed the hook on Stop"). Markdown with frontmatter
  summarises frontmatter changes first ("description changed").
- D-H15. Layout: at inner width >= 760 px, two panes (timeline 320 px + detail); below,
  one pane where picking an event slides the detail in over the list, with Back and Esc.
- D-H16. Hero strip: one sentence ("Atlas is keeping an eye on 214 files in 12 projects.
  37 changes so far, the newest 4 minutes ago.") over a 30-day ribbon of day dots sized
  by change count, today at the right; clicking a dot scrolls the timeline to that day.
- D-H17. Timeline grouped by day (sticky "Today", "Yesterday", weekday names this week,
  then dates). A row = kind icon + a sentence ("You changed the code-reviewer agent",
  "Claude changed settings.json during 'Fix the tray icon'") + scope chip + time. Several
  changes to one item in one day collapse into "changed 4 times", expandable. A divider
  "Before Atlas was watching" separates imported and dated events from live ones.
- D-H18. Filters: kind chips (All, Settings, Skills, Agents, Hooks, MCP, Instructions,
  Other) + project picker + search over item names. Keyboard: Up/Down moves the
  selection, Enter opens, Ctrl/Cmd+F focuses search.
- D-H19. Detail pane: header (icon, name, scope, path in mono, "Open in Setup"), a
  version scrubber (a dot per version, newest right), the summary (D-H14) and the diff
  against the version before, plus "Compare with now". Actions: "Copy this version"
  (clipboard) and "Save a copy..." (save dialog). Save refuses any path inside the
  config root or a project `.claude/` folder, in every build: "Pick a folder outside
  your Claude folder."
- D-H20. **Restore/Undo: Phase 4, not this build.** Restore writes the real config, and
  the safe write path (backup first, atomic rename, conflict re-check, `claude mcp` for
  `.claude.json`) is Phase 4's core; a restore built now would be a second write path,
  against the one-write-path invariant. In Phase 4: Restore = a `core::write` with
  `source = user`, behind a confirm sheet showing the diff from the current file to the
  chosen version ("Put back this version of settings.json? Atlas saves the current one
  first."); Ctrl/Cmd+Z undoes the last Atlas write only.
- D-H21. Commands: `history_overview() -> {tracked, projects, changes, since, newestAt,
  ribbon: [{day, count}]}`; `history_events({cursor?, limit <= 100, kinds?, project?,
  text?}) -> {rows, nextCursor}`; `history_item({itemKey}) -> {item, versions}`;
  `history_diff({versionId, againstVersionId? | againstCurrent}) -> Diff`;
  `history_copy_version({versionId}) -> string` (masked); `history_save_copy({versionId})
  -> path | cancelled`. Event `atlas://history/changed`.
- D-H22. Nothing under the config root or a project is opened for write; the history
  module reads through one read-only helper (as Phase 2 D2) and a grep test enforces it.
### Wrapped
- D-W1. Source: the Phase 2 ledger only (`messages`, `sessions`, `usage_hour`,
  `session_model`, plus `tool_day` from D-W7); year = local calendar year. Commands
  `wrapped_year({year}) -> WrappedYear` (<= 100 ms on the real cache) and
  `wrapped_years() -> [{year, firstDay, lastDay, activeDays}]`.
- D-W2. Coverage is honest: `WrappedYear.coverage = {firstDay, lastDay, daysOnRecord,
  daysInRange, retentionDays}`. The cover reads "Your 2026 with Claude Code, from
  October 9 to today" when the ledger starts after January 1, and "2026 so far" before
  December 31. If `.claude.json` `firstStartTime` (one key, read-only) predates the first
  ledger day, one line adds: "You started using Claude Code on June 10. Claude Code
  clears its logs after 30 days, so this story starts on October 9, and Atlas keeps
  everything from here on." No stat is extrapolated or annualised.
- D-W3. Short records: fewer than 7 active days -> 4 slides (cover, totals, busiest day,
  closing); 0 messages -> the Phase 2 indexing state (IndexProgress) with a friendly line,
  never a made-up story.
- D-W4. Totals: headline tokens = input + output + cache writes (Q2 default); cost is an
  estimate labelled "estimated", and `complete: false` reads "at least $X". Sessions =
  parent sessions only; subagent work counts inside its parent (D-S6).
- D-W5. Busiest day = most headline tokens; streak = longest run of consecutive local
  days with at least one message; plus "active on N of M days".
- D-W6. Longest session = most **active** time: gaps over 30 minutes between messages
  (parent and its subagents together) do not count. Shows title, project and "about
  3 h 20 min of work". SQL window function over `messages(session_id, ts_utc_ms)`.
- D-W7. Tools: Phase 2 parser version 2 reads `message.content[].name` of `tool_use`
  blocks (borrowed serde, `input` skipped with `IgnoredAny`) on deduped assistant
  messages into `tool_day(day_local, tool, calls)` (`m0002`); `mcp__<server>__<tool>`
  groups as "<server> (MCP)". The reindex the version bump triggers never deletes
  ledger rows of files no longer on disk; tool stats say "since <first day with tool
  data>" when that is later than the coverage start.
- D-W8. Top 3 projects by headline tokens, named by folder name; top model as a share
  of headline tokens with friendly names (Opus 5.5, Sonnet 5.5) from one label map.
- D-W9. Top skill from `messages.skill` (`attributionSkill`) within the year;
  `.claude.json` `skillUsage` is not used (lifetime counts, not year-scoped). A "top
  agent" slide only per Open Q5.
- D-W10. Rhythm: local hours bucketed Morning 5-12, Afternoon 12-17, Evening 17-22,
  Late night 22-5; the largest names the slide ("You are an evening coder"), with a
  24-bar hour chart.
- D-W11. The Wrapped page is not only a launcher: hero cover card (year, coverage line,
  headline number with the ticker, a large "Play your year" button) on the contour
  background, then a 2-column grid of story cards (totals, busiest day + streak, longest
  session, top projects, model, tools + skill, rhythm). Each card = a sentence plus one
  big number or a small chart, never a table. One column below 760 px inner width.
- D-W12. Story: full-window overlay, 5-8 slides, progress segments on top;
  Right/Space/click = next, Left = back, Esc = close; spring transitions (Framer Motion),
  reduce-motion = 150 ms cross-fades. Slides show nothing the page does not have.
- D-W13. Year picker only when `wrapped_years` has more than one year.
- D-W14. Copy is warm and specific, never generic: each slide sentence uses a real name
  or number ("You and Claude spent most of November 3 on heavens-casino").

### Settings
- D-T1. Layout: a sticky section rail on the left (Appearance, Claude folder, Your data,
  History, About) at inner width >= 760 px, content column beside it; below 760 px the
  rail becomes a chip row under the header. Sections stay cards of rows (label, one-line
  hint, control) as today.
- D-T2. Hero: "Atlas on this computer" card: app icon, version, one live sentence
  ("Reading Claude Code's folder: 1,890 sessions and 214 setup files. Everything stays
  on this computer."), started-in time.
- D-T3. Appearance: Theme (System/Light/Dark, existing) and Launch animation (from
  `launch-intro`, on by default; the hint mentions click-to-skip and reduce motion).
- D-T4. Claude folder: the existing chooser and Sandbox, plus read-only rows: where
  `.claude.json` lives (inside the folder or in home), the settings file path, and
  "Claude Code keeps conversation logs for 30 days" (from `cleanupPeriodDays`, "its
  default" when unset) with "Atlas keeps what it has read".
- D-T5. Your data: usage cache (path, size, sessions and messages tracked, last updated,
  state from `usage_status`); "Read logs again" (`usage_reindex changed`); "Rebuild from
  scratch" behind a confirm (`full`; explains that logs Claude Code already cleared cannot
  be read again, so their numbers are kept); price list (file, updated date, model count,
  error state, "Show file" via `pricing_reveal`); "Open Atlas data folder".
- D-T6. History: store size, versions kept, "Keep up to N versions of each file"
  (stepper 10-200, default 50, persisted as `historyKeepVersions` in Atlas's
  settings.json through the existing unknown-key-preserving loader), "Open history
  folder".
- D-T7. About: version, build date, started-in, data folder, the privacy sentence
  ("Atlas never sends your data anywhere"), a one-line credit.
- D-T8. Every value is live (events refresh it); only first-paint may read "Not
  measured", and only before it is measured.

---

## Layout targets
| Window | Inner width | History | Wrapped | Settings |
|---|---|---|---|---|
| 1280x800 | 880 px | hero strip + two panes | cover + 2-column cards | rail 176 px + column |
| 900x600 (min) | 588 px | hero strip + one pane, slide-in detail | cover + 1 column | chip row + column |

**No-scroll decision (Will, 2026-11-08: "I don't want too much information on one tab ... don't want to have to scroll"):**
the page itself never scrolls at 1280x800 or 900x600. History: hero strip, then timeline
and detail as two panes that scroll inside themselves. Wrapped: an inline click-through
story (cover, then one slide per page; Back / Next / arrow keys / progress bars), no cards
stack. Settings: a rail and one section at a time (Appearance, Claude folder, Your data,
History, About). This supersedes the stacked "cards" and "column" wording in the table.

## Files
| Path | Change |
|---|---|
| `crates/core/src/history/{mod,store,scan,import,diff,summary,migrate}.rs` | new: store, baseline and rescan, imports, diff, summaries, `h0001` |
| `crates/core/src/usage/{line,ingest,mod}.rs` | parser v2: `file-history-snapshot`, `tool_use` names |
| `crates/core/src/cache/migrate.rs` | `m0002`: `file_backups`, `tool_day` |
| `crates/core/src/wrapped.rs` | `wrapped_year`, `wrapped_years` |
| `crates/core/src/settings.rs` | `historyKeepVersions` |
| `crates/core/Cargo.toml` | `similar` |
| `crates/app/src/{history,wrapped}.rs`, `main.rs`, `state.rs` | commands, events; snapshotter starts after first paint |
| `crates/core/tests/{history,wrapped}.rs` | fixture tests below |
| `tools/make-fixtures.py` | `history()` -> `fixtures/claude-history/` |
| `src/pages/{History,Wrapped,Settings}.tsx` + `.test.tsx` | the screens and Vitest |
| `src/components/history/*`, `src/components/wrapped/*` | ribbon, timeline, diff view, story, cards |
| `src/lib/{types,ipc,mock}.ts` | types, calls, mock data |
| `src/pages/Placeholders.tsx` | History and Wrapped removed |

Fixture `fixtures/claude-history/` (generated, no real text): a `settings.json` with 2
earlier versions in `file-history/` and matching `file-history-snapshot` lines (one from
a subagent), `backups/.claude.json.backup.<ms>` x2 (one adds an MCP server, one carries
an `env` secret and an `oauthAccount` block), a `.bak-*` sibling, a skill folder, a
2 MiB text file, a binary file, a CRLF agent, a project `.claude/settings.json`.
---

## Acceptance criteria
Commands run from the repo root; test names are the ones to create.

### History
1. `cargo test -p atlas-core --test history` exits 0.
2. `baseline_counts`: the first run on `fixtures/claude-history` tracks exactly the
   fixture's items, stores text files <= 1 MiB, and stores no blob for the 2 MiB and
   binary files.
3. `imports`: both `file-history` versions and both `.claude.json` backups become
   versions with sources `claude_edit` / `claude_backup`; the subagent edit carries the
   parent `session_id` and a human `agent_name`; a second run adds 0 rows.
4. `mcp_view_redacted`: a byte search of the whole `history/` folder finds neither the
   fixture secret value, nor any `oauthAccount` field, nor any `.claude.json` key outside
   D-H1.
5. `rescan_detects`: editing, deleting and renaming files in a temp copy give `changed`,
   `removed`, `renamed` within one rescan; an untouched file is not re-hashed (counter).
6. `diff_shapes`: a settings change returns hunks with 3 context lines and a summary
   naming the added allowed command and the model change; a secret change reads "a
   hidden value changed"; a CRLF-only change reads "Only line endings changed".
7. `prune`: with keep = 3, an item with 5 versions keeps the newest 3; orphan blobs are
   removed; nothing outside `history/` is deleted.
8. `read_only_guarantee`: bytes, mtimes and file list of a temp copy of the fixture root
   are identical before and after baseline, imports, rescans and diffs; a grep test finds
   no write/create/remove/rename call in `crates/core/src/history/` outside the store
   helper.
9. `save_copy_guard`: `history_save_copy` to a path under the config root or a project
   `.claude/` returns the refusal; a path outside gets the masked text.
10. Real data (release build, `--data-dir <scratch>`, real config, read-only): logs
    `history: baseline <n> items, <bytes> stored, <ms> ms` with stored <= 10 MB and
    <= 15 s, and `history: imported <a> claude_backup, <b> claude_edit`; a before/after
    size + mtime listing of `~/.claude` (live `projects/` growth excluded) and of
    `~/.claude.json*` shows no change.
11. The D-H10 finding is written into this spec with the 3 sample file names (no
    contents).
12. Screenshots at 1280x800 and 900x600 (Sandbox Mode, real data) in
    `docs/shots/screens/`: hero strip with ribbon, timeline with the "Before Atlas was
    watching" divider, a settings.json diff with its summary, the slide-in detail at
    900x600.
13. `[Will]` History reads like the story of his setup, warm and a bit playful, not a
    log file or a spreadsheet.

### Wrapped
14. `cargo test -p atlas-core --test wrapped` exits 0 on `fixtures/claude-usage` +
    `claude-basic`: exact totals, busiest day, streak, active-time longest session (a
    2 h idle gap is not counted), top 3 projects, top model share, rhythm bucket, and
    sessions counted once with subagents rolled into the parent.
15. `coverage_partial_year`: a ledger starting Oct 9 reports `firstDay` Oct 9, the cover
    says "from October 9", and no field is scaled to a full year.
16. `short_record`: 3 active days -> 4 slides; 0 messages -> the indexing state.
17. `parser_v2`: `tool_day` matches the fixture's `tool_use` blocks after dedup (last line
    wins); the parser bump leaves every row of a `missing` file in place (counts and
    totals for missing files unchanged).
18. `wrapped_year` on the real cache (bench harness): median of 5 <= 100 ms.
19. Screenshots at 1280x800 and 900x600 of the page, and every story slide at 1280x800,
    real data in Sandbox Mode; a reduced-motion run shows fades only.
20. Vitest: Right, Space, Left and Esc drive the story on the mock.
21. `[Will]` the story feels like a gift: warm, specific, fun, with real hero moments.

### Settings
22. Every row in D-T2..D-T7 renders live values from the mock (Vitest) and the real app
    (screenshot); `historyKeepVersions` survives a restart, and unknown keys in Atlas's
    `settings.json` survive (the existing preservation test is extended).
23. "Rebuild from scratch" opens a confirm; Cancel changes nothing; confirming logs
    `usage: reindex full`, and totals for missing files are the same afterwards.
24. The rail scrolls to each section and highlights the one in view; below 760 px the chip
    row replaces it (screenshots at both sizes).
25. `[Will]` Settings feels friendly and complete, not a form dump.

### All three
26. `grep -rn "Coming soon" src/` returns nothing.
27. Fill probe: a Vitest layout test at fixed 1280x800 and 900x600 (or a dev-only probe in
    the real app) reports per screen the tallest blank band (<= 120 px) and the unused
    width (<= 160 px); the numbers go in the report.
28. No `table` with more than 3 columns on the three pages (DOM test).
29. `npm test`, `cargo test --workspace`, `cargo clippy --workspace -- -D warnings` and
    `npm run build` are clean.
30. First paint is unchanged from Phase 1 (`[atlas] startup` line); `history:` and
    `wrapped:` log lines come after it.

## Done when
- Criteria 1-30 pass with evidence (test output, log lines, the listing comparison,
  screenshots in `docs/shots/screens/`).
- Will signs off the `[Will]` criteria 13, 21 and 25 by looking at the screens.
- code-reviewer and verifier both pass; MEMORY.md has the entry with measured numbers;
  committed.

## Risk-floor flags
- Not on the risk floor and nothing on the gate list: this build writes only to Atlas's
  own data folder and to a user-chosen "Save a copy" path outside the Claude folder.
- Big and multi-area -> code-reviewer + verifier required.
- Closest risks: (a) the read-only invariant over three new read surfaces (`backups/`,
  `file-history/`, `.claude.json` copies); (b) secrets copied into Atlas's store: the
  `.claude.json` view is redacted before storing (criterion 4), but settings files are
  stored as-is so Phase 4 can restore them exactly, which puts `env` values from
  `settings.json` into Local AppData (Open Q3). The reviewer checks D-H1, D-H13, D-H22
  and criteria 4, 8, 9, 10.

## Suggested agent chain
1. `desktop-app-dev`, unit A (after the three branches are merged): parser v2 + `m0002`,
   history core + imports + diff, wrapped queries, tests (criteria 1-11, 14-18).
2. `ui-builder`, unit B (sequential, same repo): the three pages, components, mock,
   Vitest, fill probe, screenshots (criteria 12, 19-30), with `ui-ux-pro-max` and the
   Design Identity block; `design-reviewer` on the screenshots for the "fun, not a
   spreadsheet" bar before Will looks.
3. `verify-auditor`: plant a `.claude.json` field leak, a write under the config root, a
   first-seen tool dedup and a wall-clock longest session; each must fail a test.
4. `code-reviewer` (this D-list) in parallel with `verifier` (criteria 1-30).

## Open
- Q1. Read the git history of `~/.claude` as a fourth "before Atlas" source? Only Will's
  machine has one (16 commits); dad's almost surely does not, and running `git` on a Mac
  without developer tools pops an install dialog. **Default: no** (later via the
  pure-Rust `gix` crate if Will wants it for himself).
- Q2. Restore/Undo now or in Phase 4? **Default: Phase 4** (D-H20); this build gives
  Copy and Save a copy.
- Q3. Settings files are kept as-is in Atlas's history (needed for exact restore), so
  `env` values in `settings.json` land in Local AppData. **Default: accept** (same user,
  same machine, never Roaming, masked on screen); the alternative masks before storing
  and gives up exact restore of those files.
- Q4. Wrapped export-as-image, the first-launch Christmas intro and auto-play: **Default:
  Phase 7**, as the roadmap says.
- Q5. A "most-used agent" slide needs a subagent type name, which depends on how Phase 2
  names subagents. **Default: show it only if the Phase 2 name is a stable type; else
  skip the slide.**
- Q6. History over every Setup scope (34 live projects, more noise) or user scope only?
  **Default: every Setup-listed scope (D-H1)**, narrowed with the project picker, since
  dad's project CLAUDE.md files matter to him.