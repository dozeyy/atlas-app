# Skill Library and Habits

**What it is:** two features Will asked for on 2026-11-09, the core of Atlas's new direction
("a separate thing where everyone installs skills and everything to help Claude"; Atlas is the
toolbox that makes Claude better, not a Claude replacement):

1. **Library**: browse and preview plugins, skills, agents, commands, hooks, MCP servers and
   output styles from the official plugin catalog, any marketplace, or any pasted GitHub link;
   a plain-words safety check before install; install in a click.
2. **Habits**: find requests the user types again and again across chats ("You've asked for
   this 14 times. Turn it into a skill?") and write a skill from them.

**Status:** spec, not built. Two build units (A Library, B Habits) after a small shared shell
(Unit 0). Research was done on 2026-11-09 against Claude Code **2.1.296** on Windows in a
scratch `CLAUDE_CONFIG_DIR`; the real `~/.claude/plugins/*.json` were unchanged afterwards
(mtime listing diff).

---

## Goal
A user opens Library, finds a skill or plugin, reads in plain words what it can do to their
computer, and installs it with one click; a user opens Habits, sees the requests they repeat,
and saves one as a skill after editing it. Every install, uninstall and new skill is backed up,
shows in History and can be undone. Nothing writes the real Claude folder in dev or tests.

## Not in scope (v1)
- A curated Atlas list, ratings, download counts, screenshots, or any Atlas server.
- Hosts other than github.com for pasted links (GitLab, Bitbucket, gists, raw URLs, npm).
- Plugins whose catalog source is `command` or `npm` (they run a command at install).
- Installing **hooks or LSP servers from a repo that is not a marketplace** (OPEN Q1).
- Project or local install scope (user scope only), plugin `update`, `prune`, `configure`,
  `userConfig` entry, plugin `eval`/`validate` UI, renaming a copied item on a name clash.
- Category filters (the directory catalog has no category field), sorting by popularity.
- Using an AI model for Habits (no `claude -p`, no network, no embeddings) (OPEN Q4).
- Habits per project, merging habits by hand, scheduling or automating a habit.
- MCP tools `search_library` / `suggest_install` (section 6; a later unit).
- Showing "installed from the Library" provenance on Toolkit cards.

---

## 1. Research findings (what the spec rests on)

### 1.1 Claude Code's plugin CLI (2.1.296)
Every mutating subcommand has `--json` (one result line on stdout, same exit codes):

| Command | Use in Atlas | JSON seen |
|---|---|---|
| `claude plugin list --available --json` | the catalog | `{"installed":[...],"available":[{pluginId,name,description?,marketplaceName,version?,source}]}` |
| `claude plugin list --json` | installed state | `[]` when empty |
| `claude plugin marketplace list --json` | added marketplaces | `[]` when empty |
| `claude plugin marketplace add <owner/repo or path> --json` | add a pasted marketplace | `{"command":"marketplace-add","outcome":"ok","marketplace":"impeccable","message":"..."}`; failure `{"outcome":"failed","failureCode":"manifest_missing",...}` |
| `claude plugin marketplace update <name> --json` | Refresh | not run |
| `claude plugin install <name@marketplace> --json` | install | `{"command":"install","outcome":"ok","plugin":"...","pluginId":"...","scope":"user","message":"..."}` |
| `claude plugin uninstall <id> --keep-data --json` | uninstall | failure `{"outcome":"failed","failureCode":"not_installed",...}`, exit 1 |
| `claude plugin enable/disable <id> --json` | on/off | not run |
| `claude plugin details <id>` | not used: installed plugins only, no `--json` | text table |

- `--available` includes a built-in **`anthropic-plugin-directory`** marketplace (3,602
  entries) even with no marketplace added; every entry's source is github.com with a pinned
  `sha` (`url` 2,603, `git-subdir` 999). Output 2.15 MB; the call took 2.2 s warm, 3.1 s cold.
  Plugins of added marketplaces are listed too (`impeccable@impeccable`, source `"./plugin"`).
- Install of `frontend-design@anthropic-plugin-directory` took 13.2 s; uninstall 3.3 s;
  marketplace add (`pbakaus/impeccable`) 20.9 s.
- Store layout (inside the config dir): `plugins/known_marketplaces.json`
  (`{name:{source:{source:"github",repo}|{source:"directory",path}, installLocation,
  lastUpdated}}`), `plugins/installed_plugins.json` (`{version:2, plugins:{id:[{scope,
  installPath, version, installedAt, lastUpdated, gitCommitSha, directoryRepositoryKey?}]}}`),
  `plugins/cache/<marketplace>/<plugin>/<version>[-<sha12>]/`, `plugins/marketplaces/<name>/`
  (a clone), `plugins/data/<id>/` (plugin data, deleted by uninstall unless `--keep-data`),
  `plugin-directory-cache-v2.json` (internal; Atlas never reads it). Enabled state:
  `settings.json` `enabledPlugins{"id":true}`; marketplaces in `extraKnownMarketplaces`.
- **Even `list --available` writes** into the config dir (it created
  `plugin-directory-cache-v2.json` and `plugin-catalog-cache.json`). Every CLI call is a write.
- A bare repo is **not** installable by the CLI: `marketplace add` on a folder with only
  `skills/` and `agents/` fails `manifest_missing`; `install x --marketplace <dir>` with a
  `plugin.json` but no `marketplace.json` fails the same way. Wrapping a copy in an
  Atlas-written `marketplace.json` (source `"./plugins/x"`), then `marketplace add <dir>` +
  `install x@atlas-local` **does work** (tested), recorded as `{source:"directory", path}`.
- A plugin is a folder with `.claude-plugin/plugin.json` and any of `skills/`, `agents/`,
  `commands/`, `output-styles/`, `hooks/hooks.json`, `.mcp.json`, `lspServers`, scripts.
  What the safety check must catch, real example: `hookify` ships `hooks/*.py` and runs
  `python3 "${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py"` on every `PreToolUse`, `PostToolUse`
  and `Stop`.
- `https://codeload.github.com/<o>/<r>/tar.gz/<ref>` returns a tarball whose pax global header
  holds `comment=<full commit sha>` (verified on `octocat/Hello-World`, ref `HEAD`). No git, no
  API token, no API rate limit.

### 1.2 Decision: how a pasted GitHub repo installs
- **Repo has `.claude-plugin/marketplace.json`**: it is a marketplace. `claude plugin
  marketplace add owner/repo`, then its plugins install like catalog plugins (Claude Code is
  the writer).
- **Anything else** (one `SKILL.md`, a `skills/` folder, `agents/`, `commands/`,
  `output-styles/`, the same under `.claude/`, or a `plugin.json`-only plugin): Atlas **copies
  the markdown items into the user's Claude folder through the Setup write path** (backup +
  atomic write + History + Undo); MCP servers from a root `.mcp.json` go through the existing
  `create mcpServer` path (Claude Code's `claude mcp add-json`, guarded edit as fallback).
  Hooks and LSP servers in such repos are listed by the check as "Not installed".
- Why: copied items become ordinary user items (usable as `/name`, editable in Toolkit, Undo
  restores bytes exactly) through the one write path that exists and was reviewed. A wrap
  would make every pasted repo a plugin the user cannot edit, add an Atlas-owned marketplace
  folder that must stay alive, and namespace each skill (`x:greet`). The tested wrap stays the
  answer to OPEN Q1 if Will wants hooks from plain repos.

### 1.3 Where habits come from
- The usage cache stores **no prompt text** (only an 80-char first-prompt summary per helper,
  the approved exception to recon D15/D43). The **chat search index** (`<data>/search.sqlite`, or
  `caches/<hash>.search.sqlite` for other roots) already stores user text with secrets masked
  before indexing: `msgs(id, uuid, file_id, session_id, agent_id, role 0=user, ts)` + `fts(text)`
  (rowid = `msgs.id`) + `sfiles(..., is_subagent, project)`.
- It cannot tell a typed prompt from a machine one. Real user lines (sampled: field names and
  enum values only, no text) carry `origin.kind` = `human` | `task-notification` | `peer`,
  `promptSource` = `sdk` | `system`, `isCompactSummary`, `isSidechain`, and `entrypoint`
  (`claude-desktop`, `sdk-cli` = headless `-p`). In Will's 150 newest files: 2,197 task
  notifications, 119 scheduled prompts and 483 `sdk-cli` lines would all pass as typed.
- Decision: **Habits reads the search index**, which gains one column `msgs.origin INTEGER`
  (0 unknown/older line, 1 human, 2 machine), search schema 2 + `PARSER_VERSION` "2" (one
  background re-read inside the existing <= 60 s budget). Machine = `origin.kind` present and
  not `human`, or `promptSource == "system"`, or `isCompactSummary`, or
  `entrypoint == "sdk-cli"`.

---

## 2. Decisions made (the code-reviewer's checklist)

### Shared
- D1. New sidebar page **Library** (`view: "library"`, Phosphor `Books`, motion `bob`), right
  after Toolkit. Shortcuts become Ctrl/Cmd+1..8 (History 6, Settings 7, Wrapped 8). (OPEN Q5)
- D2. Library has three tabs in one segmented control: **Browse**, **Installed**, **Habits**;
  last tab kept in localStorage `atlas.library.tab`. No page header (as every page).
- D3. Every Library/Habits write goes through `atlas_core::setup_write` or Claude Code's CLI,
  holds the cross-process write lock, and tags its backup `library` or `habits`; History shows
  "Installed from the Library" / "Made from your habits" (`history_source` + `sourceNote`).
- D4. **The real-folder guard covers the CLI.** Every `claude` spawn sets `CLAUDE_CONFIG_DIR`
  to the resolved root explicitly; debug builds refuse to spawn when the root is the real
  Claude folder (same rule as `fsutil::check_write_allowed`), including listing calls (1.1:
  they write). Sandbox Mode points the CLI at the sandbox copy.
- D5. Every spawn goes through `atlas_core::proc::quiet` (no console window) with a timeout
  (list 30 s, marketplace add/update 120 s, install 180 s, others 30 s) and stdout capped at
  8 MB; only `--json` output is parsed, the last JSON line wins; never on the UI thread.
- D6. Network only (a) when the Library page is open and the catalog cache is older than 6 h,
  (b) on Refresh, (c) when the user opens a plugin's details or checks a pasted link. Never at
  startup, never in the background otherwise, no telemetry, no Atlas server. Habits never uses
  the network.
- D7. Nothing downloaded is executed by Atlas: no script, installer, `npm` or `git`. Install
  never passes `-y` or `--accept-command`; a plugin that needs a command to install is refused
  with one plain sentence.
- D8. ASCII-only UI strings; no "Live" tags; key hints via `useKeyHints` only; calm zones per
  DIRECTION.md (detail sheet, check, editor, confirms: no springs, no count-ups, no spark).
### Library (Unit A)
- D10. Catalog = `claude plugin list --available --json`, parsed in Rust, cached atomically at
  `<data>/library/catalog.json` (`schemaVersion` 1, `fetchedMs`, entries). The page paints from
  the cache; refresh runs in the background and swaps the list in when done. Refresh of one
  marketplace = `marketplace update <name> --json`.
- D11. Browse search is in memory over name + description + marketplace (case-folded, every
  word must match, the last word as a prefix); no network per keystroke.
- D12. Rows are keyed by `pluginId`; the same plugin in two marketplaces stays two rows with
  their source captions ("Claude plugin directory", or the marketplace name).
- D13. Preview and check need the plugin's files: fetched on demand from
  `codeload.github.com/<o>/<r>/tar.gz/<sha>` (catalog sha; `git-subdir` keeps only `path`), or
  read from the local marketplace clone for relative sources (`./plugin`). Staging is
  content-addressed at `<data>/library/fetch/<o>-<r>-<sha12>/`, reused when present; folders
  untouched for 7 days are pruned when Library opens.
- D14. Download: HTTPS only; redirects only within `github.com` and `codeload.github.com`;
  connect 10 s, total 120 s; compressed cap 25 MB; progress events and Cancel (AtomicBool).
  HTTP lives in `crates/app` (reqwest, already linked by the updater); archive reading lives
  in `crates/core` (`flate2` + `tar`, already in `Cargo.lock`) so tests need no network.
  `ATLAS_LIBRARY_GITHUB_BASE` overrides the base URL only in debug builds or with the
  `dev-update` feature (the `ATLAS_UPDATE_URL` pattern). (OPEN Q3)
- D15. Archives are untrusted: regular files only (no symlinks, hard links, devices), no
  absolute paths, no `..`, no Windows-reserved names (CON, NUL, ...), depth <= 12, <= 2,000
  files, <= 50 MB unpacked, each file <= 5 MB. Any violation refuses the whole fetch with one
  sentence and leaves nothing in staging. Every write path is checked to stay inside staging
  after the join.
- D16. Link forms accepted: `owner/repo`, `https://github.com/o/r[.git]`,
  `.../tree/<ref>/<path>`, `.../blob/<ref>/<path>` (its folder), `git@github.com:o/r.git`.
  Anything else: "Paste a GitHub link, like github.com/owner/repo." Default ref `HEAD`; the
  resolved sha comes from the tarball's pax header and is shown.
- D17. Shape of the staged tree (or the linked subfolder), first match wins: marketplace
  (`.claude-plugin/marketplace.json`) > plugin (`.claude-plugin/plugin.json`) > loose items
  (root `SKILL.md`; `*/SKILL.md` and `skills/*/SKILL.md` to depth 3; `agents/*.md`,
  `commands/*.md`, `output-styles/*.md`, also under `.claude/`; root `.mcp.json`). Nothing:
  "This repo has nothing Atlas can install: no skills, agents, commands, output styles, MCP
  servers or plugins."
- D18. The **safety check** is static (reads files, runs nothing) and returns plain lines, each
  with evidence (`path:line` + a one-line excerpt, secrets masked with `search::mask`):

  | Code | Words on screen | Trigger |
  |---|---|---|
  | `commands` | Runs commands on your computer | a hook of type `command`, a stdio MCP or LSP server, a `!` command line in a skill/command body, `allowed-tools` with Bash |
  | `every_action` | Runs before or after every tool Claude uses | hook on `PreToolUse`/`PostToolUse` with no matcher, `""` or `"*"` |
  | `every_message` | Runs on every message you send | hook on `UserPromptSubmit`, `Stop` or `SessionStart` |
  | `internet` | May use the internet | http/sse MCP url, `WebFetch`/`WebSearch` in allowed-tools, `curl`/`wget`/`Invoke-WebRequest`/`http(s)://` in a script |
  | `server` | Starts a helper program Claude talks to (MCP server) | `.mcp.json`, `plugin.json` `mcpServers`, `.mcpb` |
  | `scripts` | Comes with scripts | `.py .js .mjs .cjs .ts .sh .bash .zsh .ps1 .psm1 .bat .cmd .rb .pl`, or a `#!` first line |
  | `programs` | Comes with programs | `.exe .dll .so .dylib .jar .node .wasm`, files under `bin/`, PE/ELF/Mach-O magic bytes |
  | `no_ask` | Lets Claude use these without asking: <tools> | `allowed-tools` in a skill, command or agent |
  | `also_installs` | Also installs: <names> | `plugin.json` `dependencies` |
  | `asks_settings` | Asks you for settings or keys after install | `plugin.json` `userConfig` |
  | `not_installed` | Not installed from this repo: hooks, LSP servers | plugin.json-only or loose shape carrying hooks or LSP (1.2) |
  | `bad_header` | Has a header Atlas can't read | unparseable or unclosed YAML header |

  None found: "Text only. Nothing here runs on its own." Always one caption: "Atlas reads the
  files without running them. This is a guide, not a guarantee." YAML headers are parsed with
  the same parser and merge-key handling as the MCP header check.
- D19. Each check carries `treeHash` = sha256 over sorted (relative path, bytes). After a CLI
  install Atlas re-scans `installPath` (ignoring Claude Code's `.in_use` marker); a different
  hash marks the row "Changed since you checked it" with Check again (no auto-uninstall).
- D20. One-click rule: a row's Install installs at once when its check is done and has no
  flags; otherwise it opens the detail sheet (fetching first) and focuses the sheet's Install.
  A flagged install always takes that second, deliberate click. (OPEN Q2)
- D21. Plugin install: back up `settings.json`, `plugins/installed_plugins.json` and
  `plugins/known_marketplaces.json` (tag `library`), run `claude plugin install <id> --json`
  (user scope), read `installed_plugins.json` back. Uninstall and Undo of an install =
  `claude plugin uninstall <id> --keep-data --json` (keeps the plugin's data, so a reinstall
  brings it back). Undo of an uninstall = reinstall of the same id, the check re-run first if
  the catalog sha moved.
- D22. Loose-item install: each ticked item through the write path. Single-file kinds use
  `create_apply`; a skill folder uses a new `install_skill_folder` built like `duplicate_skill`
  (temp `.atlas-copy-*` beside the target, one `rename`, never replaces, `DUP_MAX_FILES` /
  `DUP_MAX_BYTES` caps, non-UTF-8 `SKILL.md` refused) **plus** a `create` manifest with
  `is_dir: true`. `restore_any` learns to undo a folder `create`: move the folder into the
  backup (so the undo is itself restorable) and to the OS trash. A taken name: the item is
  unticked with "You already have one called <name>" (no overwrite, no rename in v1).
- D23. Ledger `<data>/library/ledger.json` (`schemaVersion` 1, atomic, one writer: the Library
  service): per install, kind (`plugin` | `item`), id or path, repo, sha, `treeHash`,
  `installedMs`, `backupId`. Installed tab = `installed_plugins.json` + ledger items still on disk.
- D24. Claude Code's command not found (`connect::find_claude_cli`): Browse still lists the
  cached catalog; plugin rows say "Needs Claude Code's command to install plugins." Loose items
  from links still install (MCP servers then use the guarded edit).
### Habits (Unit B)
- D30. Source rows: `role = 0 AND origin IN (0,1) AND agent_id IS NULL AND sfiles.is_subagent = 0`.
- D31. Dropped before grouping: first non-space char `/` (slash command), or `<` followed by a
  tag name (command-name, local-command-*, task-notification, system-reminder, bash-input,
  pasted_content, scheduled-task, ...); a code fence; >= 6 lines; < 12 or > 400 characters after
  trim; < 3 words; letters < 60 % of non-space characters (logs, paths, stack traces); the mask
  `***` anywhere (a secret was there).
- D32. Normalize: lowercase; URLs -> `url`; paths (`\`, `~/`, or `/` with >= 2 segments) ->
  `path`; numbers -> `n`; quoted or backticked spans -> `q`; other non-alphanumerics -> space;
  collapse spaces; strip leading fillers (`please`, `pls`, `can you`, `could you`, `hey`, `ok`,
  `okay`, `now`, `claude`) repeatedly.
- D33. Grouping, deterministic, no model: count exact duplicates of the normalized string;
  shingles = character 5-grams; MinHash with 64 fixed-seed hashes + LSH 16 bands x 4 rows for
  candidates; **leader clustering**: unique strings in descending count (tie: newest) each join
  the first leader whose exact shingle Jaccard is >= 0.55, else become a leader. No chaining.
- D34. A habit = a group with >= 5 prompts, in >= 3 different sessions, on >= 2 different days,
  last seen within 90 days. Order: count desc, then last seen desc. At most 12 shown. All
  thresholds in one place (`habits::Thresholds`).
- D35. Habit id = first 16 hex of sha256(leader's normalized text). Dismissed ("Not a habit")
  and made ("Saved as /name") ids persist in `<data>/habits.json` (`schemaVersion` 1, atomic,
  ids only); both are hidden. Representative = the most frequent original text in the group
  (tie: newest); examples = up to 5 other distinct originals, newest first.
- D36. Computed on a background thread after a search pass, cached in memory keyed by the
  search engine's pass counter; while the first search index runs, the tab shows its progress.
- D37. The skill text is built in Rust (`habits::skill_draft`) and opened in an editor before
  anything is written. Save = the existing `setup_create("skill", name, None, text)` (backup,
  atomic write, History, Undo) with the backup tagged `habits`. Template:

  ```
  ---
  name: <name>
  description: <representative request, first 20 words, cleaned>. Use when the user asks things like '<ex1>', '<ex2>' or '<ex3>'.
  ---

  # <Name in words>

  The user asks for this often. Do it the way they describe it:

  > <representative request, verbatim>

  ## Ways they ask
  - '<example>'   (up to 5)
  ```

  Name = the 2-4 most frequent non-stopword words of the group in the leader's order,
  kebab-case, <= 40 characters of `[a-z0-9-]`, `-2`/`-3` when taken, fallback `my-habit`.
  Description: one line, <= 1,024 characters, no `<` or `>`.
- D38. Privacy: habit text never leaves the machine, is never logged, never sent in an event
  (only returned on request), never offered to the MCP server, never in screenshots of real
  data; verification shots use the habits fixture only. `habits.json` holds ids only, so
  deleting the search index removes every habit's text.

---

## 3. Screens (Trail Map; tokens from `src/styles/tokens.css`)

No page scroll at 1280x800; at 900x600 lists scroll inside their pane, nothing clipped.

**Top bar (every tab), a 48 px row, 16 px page padding:** the segmented control (Browse |
Installed | Habits; track `raised` radius 10, sliding thumb 320 ms spring) on the left. On
Browse and Installed: a 36 px search field (240-360 px, radius 8, magnifier 16 px, placeholder
"Search plugins and skills"), **Add from GitHub** (secondary, `GithubLogo`), and a 32 px Refresh
icon button (`spin`) with the caption "Updated 3 min ago" / "Updating...".

**Browse:** a virtualized list of 56 px rows, row hover `raised` (no lift): 32 px icon blob
(`Package`, radius 10, `accent-tint`), name 14/600 over a one-line description (`text-2`,
truncated); right side: source caption 12, version 12 mono, an "Installed" pill when installed,
Install (secondary, 28 px) or Open. At >= 1100 px a 200 px source rail sits left of the list
(All, Claude plugin directory, each added marketplace with its count, Add a marketplace); below
1100 px the rail folds into a Source dropdown in the top bar. Click or Enter opens the sheet.

**Detail sheet** (right, 480 px, `sheet-in` 250 ms, calm zone): name 20/600; source line with
the repo link (opens the OS browser), version + short sha; description; **What's inside**
(count per kind + names; a name opens a read-only CodeMirror view of the file); **Before you
install** card: one row per flag (16 px icon + words in `warning`, never color alone), each
expandable to its evidence lines, then the D18 caption; footer Install (primary) or Uninstall
(secondary, inline confirm). Esc closes. While fetching: "Reading <owner>/<repo>... 2.1 MB",
a thin progress bar and Cancel.

**Add from GitHub** (dialog, 520 px): one input (autofocus, placeholder "github.com/owner/repo")
and Check (primary, disabled until the text parses). Marketplace result: its plugin list and
"Add this marketplace" (primary). Plugin or loose result: a checklist of items (kind icon, name,
path; taken names unticked with the reason), the Before-you-install card, and "Install 3 items"
(primary).

**Installed:** 56 px rows: installed plugins (on/off switch via `claude plugin enable/disable`,
Uninstall X with the Toolkit inline confirm) and Library-copied items (Open in Toolkit, Remove X
with the inline confirm = Undo of the create); the D19 note with Check again.

**Habits:** a 2-column grid of cards (1 column under 1000 px), radius 14, clickable-card lift.
Card: the count in display `stat` (28, Recursive) + caption "times"; the representative in
quotes (14, 2 lines max); meta "in 6 chats, last on Nov 7" (caption, `text-2`); **Make a
skill** (primary, small) and **Not a habit** (ghost). Clicking the card expands it to the
examples (date + project name each). The page's one hero number is the top card's count, no
count-up after the first view. Make a skill opens a calm sheet: Name input (validated like
Toolkit create), CodeMirror with the drafted `SKILL.md`, the note "Where it goes: <skills
folder>", Save (primary, Ctrl/Cmd+S, disabled while invalid) and Cancel. After Save: toast
"Saved as /name" with Undo and Open in Toolkit; the card collapses out (200 ms).

**States**
- No catalog cache and offline: Topo + spark, "Atlas could not reach the plugin catalog. Check
  your connection and press Refresh." Search with no match: "Nothing matches <query>."
- No Claude Code command: the D24 line on plugin rows and one notice line above the list.
- Fetch error: one sentence naming the cause (not found, too big, timed out, not a GitHub
  link, unsafe archive) and the next step; nothing is half installed.
- Install error: the CLI `message` cut to one sentence, plus "Nothing was changed." when the
  read-back confirms it.
- Habits while the index builds: "Reading your chats. This runs once." + the search progress.
- No habits: Topo + spark, "No habits yet. When you ask Claude for the same thing in a few
  different chats, it shows up here."

**Keyboard:** Ctrl/Cmd+F or `/` focuses search; Up/Down move the selected row; Enter opens the
sheet; Ctrl/Cmd+Enter in the sheet installs; Esc closes the sheet, dialog or confirm;
Left/Right on the segmented control switch tabs; Ctrl/Cmd+S saves in Make a skill.
---

## 4. Build units and files

### Unit 0: shared shell (main session, small; lands before A and B)
| File | Change |
|---|---|
| `src/lib/types.ts` | `View` adds `"library"` |
| `src/components/Sidebar.tsx` | NAV row after Toolkit (D1) |
| `src/App.tsx` | page switch, Ctrl/Cmd+1..8 |
| `src/components/HelpSheets.tsx` | shortcut list |
| `src/pages/Library.tsx` | tab shell, segmented control, `atlas.library.tab`; renders `BrowseTab`, `InstalledTab`, `HabitsTab` placeholders |
| `crates/core/src/history/marks.rs`, `src/lib/historyModel.ts` | sources `library` and `habits` (D3) |
| `src/lib/shotTour.ts`, `tools/mac-check.sh` | Library in the picture tour, new counts |

### Unit A: Library
| File | Change |
|---|---|
| `crates/core/src/library/{mod,catalog,cli,link,archive,shape,check,install,ledger}.rs` | new: catalog parse + cache (D10), CLI runner (D4, D5, D7), link parse (D16), tar.gz reader (D15), shape (D17), check (D18, D19), installs (D21, D22), ledger (D23) |
| `crates/core/src/setup_write.rs` | `install_skill_folder`; `restore_any` undoes a folder `create` (D22) |
| `crates/core/Cargo.toml` | `flate2`, `tar` at the locked versions (OPEN Q3) |
| `crates/app/src/library.rs` | commands, reqwest download with progress + cancel events, background refresh |
| `crates/app/Cargo.toml` | direct `reqwest` at the locked version; no new feature unless `cargo tree` shows no new crate |
| `src/components/library/{BrowseTab,InstalledTab,DetailSheet,SafetyCheck,AddFromGitHub,ItemChecklist}.tsx` | UI |
| `src/lib/{library.ts,libraryTypes.ts,mockLibrary.ts}` | model, filter, mock backend |
| `fixtures/library/` | captured CLI JSON (1.1 shapes, incl. a 3,603-entry catalog), small `.tar.gz` repos: marketplace, hookify-like plugin, loose skills with scripts, http-MCP repo, malicious archives |

### Unit B: Habits
| File | Change |
|---|---|
| `crates/core/src/search/{extract,db,mod}.rs` | `origin` column, schema 2, `PARSER_VERSION` "2" (1.3) |
| `crates/core/src/habits/{mod,filter,normalize,cluster,skill,store}.rs` | new (D30-D37) |
| `crates/app/src/habits.rs` | commands `habits_list`, `habits_dismiss`, `habits_draft` |
| `src/components/setup/CreateFlow.tsx` | optional `initialName` / `initialText` props, only if reused for Make a skill |
| `src/components/library/habits/{HabitsTab,HabitCard,MakeSkillSheet}.tsx` | UI |
| `src/lib/{habitsTypes.ts,mockHabits.ts}` | types, mock |
| `tools/make-fixtures.py`, `fixtures/claude-habits/` | habits fixture (every text line `"fixtureText": true`) |

### Shared, append-only (merge A first, B rebases)
`crates/core/src/lib.rs` (`pub mod library; pub mod habits;`), `crates/app/src/main.rs`
(`generate_handler!` entries, managed state), `src/lib/ipc.ts` (Backend methods),
`src/lib/mock.ts`.

---

## 5. Acceptance criteria

Safety (both units)
1. `cargo test --workspace` passes, including a test that runs every Library and Habits write
   (plugin install via a fake CLI, uninstall, copy install, undo, make skill) against a tempdir
   root and asserts the real Claude folder's tree (paths, sizes, mtimes) is unchanged.
2. Debug build, real root: the CLI runner refuses `list --available` and `install` without
   spawning (unit test: spawn counter stays 0).
3. A source-level test (like `no_network_listener`) fails if `crates/core/src/library`,
   `crates/app/src/library.rs` or `crates/app/src/habits.rs` builds a `Command` without
   `proc::quiet`. [Will or a screen recording] no console window flashes during refresh,
   install and uninstall on Windows.
4. With the `ATLAS_LIBRARY_GITHUB_BASE` test server counting requests: 0 requests in a 60 s run
   that never opens Library; 0 requests from Habits (source test: no HTTP client under `habits/`).
5. The only process `library/` can start is `claude`; the runner test asserts no install call
   ever carries `-y` or `--accept-command`.

Library
6. Parsing the captured `list --available --json` fixture yields 3,603 entries with pluginId,
   name, marketplace, version, source kind and sha; `catalog.json` round-trips, and a write
   killed between temp and rename leaves the old file readable.
7. With the 3,603-entry cache, Browse shows rows <= 150 ms after navigation (log line
   `library: first rows N ms`); during a refresh a typed key appears in the search field
   within one frame.
8. Search over 3,603 entries: p95 <= 16 ms per keystroke (vitest bench on the fixture).
9. Link parsing: a table test over every D16 form plus 10 rejects (gitlab, gist, raw URL, `..`,
   empty, spaces, extra path parts without tree/blob, ...) with the exact message.
10. Each malicious archive (symlink, hard link, `../x`, absolute path, 2,001 files, 51 MB, one
    6 MB file, `CON`) is refused and its staging folder does not exist afterwards.
11. Shape detection: the fixtures resolve to marketplace / plugin / loose / nothing as D17 says.
12. Safety check: the hookify-like fixture yields `commands`, `every_action`, `every_message`
    and `scripts` with `path:line` evidence; the http-MCP fixture yields `internet` + `server`; a
    plain skill yields "Text only. Nothing here runs on its own."; `allowed-tools: Bash` yields
    `no_ask` + `commands`; a YAML merge key hiding `hooks` is caught; a planted `sk-ant-`
    token in a script shows masked.
13. Verifier, real network, scratch `CLAUDE_CONFIG_DIR` (never the real folder): install
    `frontend-design@anthropic-plugin-directory` from the UI -> row shows Installed, History
    shows "Installed from the Library", the backup holds the three JSON files, the ledger has
    the entry; Undo -> `installed_plugins.json` no longer lists it and `plugins/data/<id>` is
    kept. Screenshots of Browse, the sheet and History.
14. Copy install from the loose fixture (test server): two skills with scripts and one agent
    land under `<root>/skills/` and `<root>/agents/` byte-identical to the archive; a taken name
    is unticked and untouched; Undo moves the folder into the backup and the trash; undoing
    that Undo restores it byte-identical (hash test).
15. Marketplace link: the marketplace fixture makes the runner record exactly
    `plugin marketplace add <o/r> --json`, then lists its plugins; a `manifest_missing` reply
    shows one sentence and changes nothing on disk.
16. A fake CLI that installs a tree different from the checked one marks the row "Changed since
    you checked it" (D19).
17. D20: a clean, checked plugin installs from its row in one click; a flagged one opens the
    sheet and needs the sheet's Install (component test + screenshot).
18. With `find_claude_cli` returning None, plugin rows show the D24 line and a loose install
    still works (test + screenshot).
19. A `command`- or `npm`-source entry shows Install disabled with "This plugin installs by
    running a command. Atlas does not run those." (test).

Habits
20. Search schema 2: a schema-1 index re-reads once and fills `origin`; fixture lines with
    `origin.kind` human / task-notification / peer, `promptSource: system`, `isCompactSummary`,
    `entrypoint: sdk-cli` map to 1 / 2 / 2 / 2 / 2 / 2, and a subagent file's lines are excluded.
21. Habits fixture: the planted habit (7 variants of one request, 4 sessions, 3 days) is found
    once with count 7; each of these is not a habit (one named test each): a request x20 in one
    session, a subagent prompt x20, a task notification x30, a slash command x10, a pasted log
    x6, a 2-word prompt x15, a prompt with a masked secret x6.
22. Deterministic: two runs, and a run with the input rows shuffled, give the same ids, counts
    and order.
23. 20,000 synthetic prompts group in <= 2 s in release (`cargo test --release -p atlas-core
    habits::bench -- --ignored` prints the time); a call with no new search pass returns the
    cached list in <= 50 ms.
24. The skill draft passes the Toolkit validator; `name` matches `[a-z0-9-]{1,40}`; the
    description is one line, <= 1,024 characters, without `<` or `>`; a taken name gets `-2`.
25. In the app on the fixture root: edit the draft, Ctrl+S -> `<root>/skills/<name>/SKILL.md`
    equals the editor text, History shows "Made from your habits", Undo removes it, the card
    stays hidden after a relaunch. Screenshots of the tab, the sheet and History.
26. Not a habit: the card hides and stays hidden after a relaunch; `habits.json` contains no
    fixture text (grep: 0 hits).
27. Run the app on the fixture with logging on; grep the log folder for every fixture prompt:
    0 hits.

Both
28. Screens at 1280x800 and 900x600, light and dark (Silver once at 1280x800): Browse, the sheet
    with flags, an Add-from-GitHub result, Installed, Habits, Make a skill, empty and error
    states; no page scroll at 1280x800, nothing clipped at 900x600; fixtures only; saved under
    `docs/shots/library/` and viewed.
29. `npx tsc --noEmit`, `npm test`, `cargo test --workspace`, `cargo clippy --workspace -- -D
    warnings` green; existing tests changed only where intended (shortcut numbers, tour counts).
30. [Will] Browsing feels instant, and the check's words make sense to someone who is not a
    developer.
31. [Will] On his real chats the top habits are things he really repeats, and a saved skill
    fires in Claude Code when he asks the same thing again.

## Done when
Units 0, A and B are merged to `main`; criteria 1-29 carry evidence (test names, log lines,
screenshot paths) and pass code-reviewer and verifier; a release build installed one real
plugin into a scratch config dir; Will has run 30 and 31.

## Risk-floor flags
- Installing third-party code into Claude's setup (hooks and MCP servers later run with the
  user's rights): opus code-reviewer with the security checklist, plus the verifier.
- Untrusted archives (path traversal, symlinks, bombs) and untrusted YAML/JSON.
- The CLI writes the Claude folder even when listing (1.1): the debug guard must cover it.
- Habits reads conversation text: privacy (D38); no screenshots of real prompts.
- The search schema bump re-reads the whole corpus once (background, existing budget).

## Suggested agent chain
Unit 0 main session -> Unit A coder (sonnet, Rust + React, primary skill `ui-ux-pro-max`) and
Unit B coder (sonnet) in parallel worktrees -> per unit code-reviewer (opus + security
checklist for A; sonnet for B) and verifier in parallel -> merge A, rebase and merge B ->
design-reviewer on `docs/shots/library/` -> Will (30, 31).

---

## 6. MCP tie-in
Recommendation: **yes, later, as its own unit.** `search_library` (read-only over the cached
catalog, no network) is cheap; `suggest_install` only as a propose-mode card in Pending Changes
that carries the safety check, never in direct mode, so a prompt-injected chat cannot install
hooks. Not part of this spec's must-haves.

## 7. Open questions (Will)
1. A repo that is not a marketplace but ships hooks or LSP servers: (a) install only its
   skills, agents, commands, output styles and MCP servers, and list the hooks as not installed
   [pick]; (b) wrap it as a local Atlas marketplace so it installs whole as a plugin (tested).
2. Install clicks: (a) one click when the check is clean, a second click in the sheet when it
   flags something [pick]; (b) always one click; (c) always open the sheet first.
3. Rust dependencies: (a) direct `reqwest`, `flate2`, `tar` at the versions already in
   `Cargo.lock` through the updater, no new crates [pick]; (b) shell out to the OS `curl`.
4. Habit skills: (a) built from your own words only, no AI [pick]; (b) add a "Let Claude write
   the steps" button later (runs `claude -p`, uses tokens).
5. Placement: (a) Library in the sidebar right after Toolkit, shortcuts shift by one [pick];
   (b) Library as a tab inside Toolkit.

## 8. Not verified
- Whether `list --available` refetches the directory over the network on every call.
- Whether installing a directory plugin ever runs code (npm dependencies, `.mcpb` setup); only
  a skill-only plugin was installed here.
- JSON of `marketplace update`, `enable`, `disable`; whether a reinstall after `--keep-data`
  gets its data back.
- macOS: finding `claude` from a GUI app's PATH (`find_claude_cli` adds `~/.local/bin` and
  `~/.claude/local`); codeload behind proxies.
- The habit thresholds (D33, D34) are first guesses; only Will's real chats tune them (31).