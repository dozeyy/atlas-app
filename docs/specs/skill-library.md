# Skill Library and repeated-request skills

**What it is:** two features Will asked for on 2026-11-09, the core of Atlas's new direction
("a separate thing where everyone installs skills and everything to help Claude"; Atlas is the
toolbox that makes Claude better, not a Claude replacement):

1. **Library** (a tab inside Toolkit): browse and preview plugins, skills, agents, commands,
   hooks, MCP servers and output styles from the official plugin catalog, any marketplace, or
   any pasted GitHub link; a plain-words safety check before install; install in a click.
2. **Skills from repeated requests, in the chat** (not in the app). Will: "Don't make habit
   skills inside app but like for the skill if someone in chat keeps doing whatever the skill
   should detect that and offer to make a skill out of it." The Atlas Claude Code plugin notices
   when the user keeps asking for the same kind of thing, offers once to turn it into a skill,
   and saves it through the Atlas MCP. A new read-only MCP tool, `find_repeated_requests`, lets
   it see the user's past chats.

**Status:** spec, not built. Two parallel build units: **A** Library tab (app + core) and **B**
plugin skill text + MCP `find_repeated_requests` + the search index `origin` column. No shared
shell unit. Will answered the first open questions on 2026-11-09 (section 7). Research was done
on 2026-11-09 against Claude Code **2.1.296** on Windows in a scratch `CLAUDE_CONFIG_DIR`; the
real `~/.claude/plugins/*.json` were unchanged afterwards (mtime listing diff).

---

## Goal
- In Toolkit > Library a user finds a skill or plugin, reads in plain words what it can do to
  their computer, and installs it with one click. Every install and uninstall is backed up,
  shows in History and can be undone.
- In any Claude Code chat, when the user has clearly asked for the same kind of thing before,
  Claude offers once, in one line, after the task is done, to turn it into a skill. On yes it
  drafts `SKILL.md` from the user's real wording, shows it, and saves it through the Atlas MCP
  (backup, History, Undo). It never nags.
- Nothing writes the real Claude folder in dev or tests.

## Not in scope (v1)
- Any in-app Habits UI: no Habits tab, cards, editor, or app commands for it. Habit
  detection lives only in the plugin skill + MCP tool.
- A curated Atlas list, ratings, download counts, screenshots, or any Atlas server.
- Hosts other than github.com for pasted links (GitLab, Bitbucket, gists, raw URLs, npm).
- Plugins whose catalog source is `command` or `npm` (they run a command at install).
- Installing hooks or LSP servers from a repo that is not a marketplace (Will: list them as
  not installed).
- Project or local install scope (user scope only), plugin `update`, `prune`, `configure`,
  `userConfig` entry, plugin `eval`/`validate` UI, renaming a copied item on a name clash.
- Category filters (the directory catalog has no category field). (Popularity sorting was out of v1 and is built since: section 9.)
- Any AI model inside Atlas for grouping requests (no `claude -p`, no embeddings, no network);
  the drafting is done by the Claude the user is already chatting with.
- MCP `suggest_install` (section 6: not cheap, no Pending Changes UI exists yet).
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
  Atlas-written `marketplace.json` works (tested) but is not used (1.2).
- A plugin is a folder with `.claude-plugin/plugin.json` and any of `skills/`, `agents/`,
  `commands/`, `output-styles/`, `hooks/hooks.json`, `.mcp.json`, `lspServers`, scripts.
  Real example the safety check must catch: `hookify` ships `hooks/*.py` and runs
  `python3 "${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py"` on every `PreToolUse`, `PostToolUse`
  and `Stop`.
- `https://codeload.github.com/<o>/<r>/tar.gz/<ref>` returns a tarball whose pax global header
  holds `comment=<full commit sha>` (verified on `octocat/Hello-World`, ref `HEAD`). No git, no
  API token, no API rate limit.

### 1.2 How a pasted GitHub repo installs (Will: option a)
- **Repo has `.claude-plugin/marketplace.json`**: it is a marketplace. `claude plugin
  marketplace add owner/repo`, then its plugins install like catalog plugins (Claude Code is
  the writer).
- **Anything else** (one `SKILL.md`, a `skills/` folder, `agents/`, `commands/`,
  `output-styles/`, the same under `.claude/`, or a `plugin.json`-only plugin): Atlas copies
  the skills, agents, commands and output styles into the user's Claude folder **through the
  Setup write path** (backup + atomic write + History + Undo); MCP servers from a root
  `.mcp.json` go through the existing `create mcpServer` path (Claude Code's
  `claude mcp add-json`, guarded edit as fallback). Hooks and LSP servers are listed as not
  installed with a plain reason.
- Why: copied items become ordinary user items (usable as `/name`, editable in Toolkit, Undo
  restores bytes exactly) through the one write path that exists and was reviewed.

### 1.3 Where repeated requests come from
- The usage cache stores **no prompt text** (only an 80-char first-prompt summary per helper,
  the approved exception to recon D15/D43). The **chat search index** (`<data>/search.sqlite`,
  or `caches/<hash>.search.sqlite` for other roots, `search::db::search_file`) stores user text
  with secrets masked before indexing: `msgs(id, uuid, file_id, session_id, agent_id, role
  0=user, ts)` + `fts(text)` (rowid = `msgs.id`) + `sfiles(..., is_subagent, project)`. It is
  built by the app's search engine; the MCP only reads it.
- It cannot tell a typed prompt from a machine one. Real user lines (sampled: field names and
  enum values only, no text) carry `origin.kind` = `human` | `task-notification` | `peer`,
  `promptSource` = `sdk` | `system`, `isCompactSummary`, `isSidechain`, and `entrypoint`
  (`claude-desktop`, `sdk-cli` = headless `-p`). In Will's 150 newest files: 2,197 task
  notifications, 119 scheduled prompts and 483 `sdk-cli` lines would all pass as typed.
- Decision: the index gains `msgs.origin INTEGER` (0 unknown/older line, 1 human, 2 machine),
  search schema 2 + `PARSER_VERSION` "2" (one background re-read inside the existing <= 60 s
  budget). Machine = `origin.kind` present and not `human`, or `promptSource == "system"`, or
  `isCompactSummary`, or `entrypoint == "sdk-cli"`.
- The Atlas MCP's direct mode (what Connect registers: no `--propose`) already lets
  `create_item` write a skill whose `SKILL.md` has no `hooks`/`allowed-tools`-style keys and no
  `!` command lines (`ops.rs` `CODE_KEYS`). A drafted habit skill is plain text, so it saves
  directly, with a backup tagged `mcp` (History: "Made by Claude through Atlas's connector").
---

## 2. Decisions made (the code-reviewer's checklist)

### Both units
- D4. **The real-folder guard covers the CLI.** Every `claude` spawn sets `CLAUDE_CONFIG_DIR`
  to the resolved root explicitly; debug builds refuse to spawn when the root is the real
  Claude folder (same rule as `fsutil::check_write_allowed`), including listing calls (1.1:
  they write). Sandbox Mode points the CLI at the sandbox copy.
- D5. Every spawn goes through `atlas_core::proc::quiet` (no console window) with a timeout
  (list 30 s, marketplace add/update 120 s, install 180 s, others 30 s) and stdout capped at
  8 MB; only `--json` output is parsed, the last JSON line wins; never on the UI thread.
- D6. Network only (a) when Toolkit > Library is open and the catalog cache is older than 6 h,
  (b) on Refresh, (c) when the user opens a plugin's details or checks a pasted link. Never at
  startup, never in the background otherwise, no telemetry, no Atlas server. Unit B never uses
  the network.
- D7. Nothing downloaded is executed by Atlas: no script, installer, `npm` or `git`. Install
  never passes `-y` or `--accept-command`; a plugin that needs a command to install is refused
  with one plain sentence.
- D8. ASCII-only UI strings; no "Live" tags; key hints via `useKeyHints` only; calm zones per
  DIRECTION.md (detail sheet, check, confirms: no springs, no count-ups, no spark).

### Unit A: Library tab
- D1. **Library is a tab inside Toolkit** (Will). Toolkit gets a segmented control,
  "Your setup" | "Library", remembered in localStorage `atlas.toolkit.tab`. The sidebar, the
  Ctrl/Cmd+1..7 shortcuts and `View` are unchanged. Ctrl+K quick jump gains "Library" (opens
  Toolkit on that tab).
- D3. Library writes go through `atlas_core::setup_write` or Claude Code's CLI, hold the
  cross-process write lock, and tag their backups `library`; History shows "Installed from the
  Library" (`history_source` + `sourceNote`).
- D10. Catalog = `claude plugin list --available --json`, parsed in Rust, cached atomically at
  `<data>/library/catalog.json` (`schemaVersion` 1, `fetchedMs`, entries). The tab paints from
  the cache; refresh runs in the background and swaps the list in when done. Refresh of one
  marketplace = `marketplace update <name> --json`.
- D11. Search is in memory over name + description + marketplace (case-folded, every word must
  match, the last word as a prefix); no network per keystroke.
- D12. Rows are keyed by `pluginId`; the same plugin in two marketplaces stays two rows with
  their source captions ("Claude plugin directory", or the marketplace name).
- D13. Preview and check need the plugin's files: fetched on demand from
  `codeload.github.com/<o>/<r>/tar.gz/<sha>` (catalog sha; `git-subdir` keeps only `path`), or
  read from the local marketplace clone for relative sources (`./plugin`). Staging is
  content-addressed at `<data>/library/fetch/<o>-<r>-<sha12>/`, reused when present; folders
  untouched for 7 days are pruned when the tab opens.
- D14. Download: HTTPS only; redirects only within `github.com` and `codeload.github.com`;
  connect 10 s, total 120 s; compressed cap 25 MB; progress events and Cancel (AtomicBool).
  Direct dependencies (Will: yes): `reqwest` in `crates/app` (already linked by the updater),
  `flate2` + `tar` in `crates/core` (already in `Cargo.lock`), at the locked versions; a new
  feature flag only if `cargo tree` shows no new crate. `ATLAS_LIBRARY_GITHUB_BASE` overrides
  the base URL only in debug builds or with the `dev-update` feature (the `ATLAS_UPDATE_URL`
  pattern).
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
  | `not_installed` | Not installed: its hooks and LSP servers. Atlas installs those only from a plugin marketplace, so they can be turned off and removed as one plugin. | plugin.json-only or loose shape carrying hooks or LSP (1.2) |
  | `bad_header` | Has a header Atlas can't read | unparseable or unclosed YAML header |

  None found: "Text only. Nothing here runs on its own." Always one caption: "Atlas reads the
  files without running them. This is a guide, not a guarantee." YAML headers are parsed with
  the same parser and merge-key handling as the MCP header check.
- D19. Each check carries `treeHash` = sha256 over sorted (relative path, bytes). After a CLI
  install Atlas re-scans `installPath` (ignoring Claude Code's `.in_use` marker); a different
  hash marks the row "Changed since you checked it" with Check again (no auto-uninstall).
- D20. One-click rule (Will: a): a row's Install installs at once when its check is done and
  has no flags; otherwise it opens the detail sheet (fetching first) and focuses the sheet's
  Install. A flagged install always takes that second, deliberate click.
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
  `installedMs`, `backupId`. The rail's Installed filter = `installed_plugins.json` + ledger
  items still on disk.
- D24. Claude Code's command not found (`connect::find_claude_cli`): the cached catalog still
  lists; plugin rows say "Needs Claude Code's command to install plugins." Loose items from
  links still install (MCP servers then use the guarded edit).
- D25. MCP `search_library {query, limit 1..20 (default 10)}`, read-only: filters
  `<data>/library/catalog.json` with the D11 matcher and returns `{pluginId, name, description,
  marketplace, version, installed}`; no network, no CLI. No catalog file yet: "Open Toolkit >
  Library in Atlas once so it can load the plugin catalog." Cheap, so it is in Unit A.
### Unit B: repeated requests -> skill, in the chat
Index and grouping (core)
- D30. Rows: `role = 0 AND origin IN (0,1) AND agent_id IS NULL AND sfiles.is_subagent = 0`.
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
- D34. A repeated request = a group with >= 5 prompts, in >= 3 different sessions, on >= 2
  different days, last seen within the `days` window (default 90). Order: count desc, then last
  seen desc. All thresholds in one place (`habits::Thresholds`).
- D35. Group id = first 16 hex of sha256(leader's normalized text), stable across runs.
  Representative = the most frequent original text in the group (tie: newest), cut to 400
  characters; examples = up to 5 other distinct originals, newest first.

MCP tools (`crates/mcp`, documented in `docs/specs/mcp-server.md`)
- D40. `find_repeated_requests`, read-only, allowed in direct and propose mode. Input
  (camelCase): `like?: string` (the request in front of Claude now, <= 2,000 chars), `days?:
  1..365` (default 90), `project?: string` (a known project name or path), `limit?: 1..20`
  (default 8). Output: `{ indexedThroughMs, offersOff, likeMatch: {groupId, similarity} |
  null, groups: [{ id, count, sessions, days, projects: [name], firstSeenMs, lastSeenMs,
  representative, examples: [string], offer: null | {answer, atMs, skillName?} }] }`.
  With `like`, the group whose leader has Jaccard >= 0.55 with the normalized `like` text is
  returned first even when it is under the D34 thresholds (count >= 2), so "has the user asked
  for this before?" has an answer.
- D41. It reads the search index through a read-only SQLite connection (the file resolved like
  the app, `search::db::search_file`); it never writes the index and never reads transcripts
  itself. Missing index: tool error "Atlas has not read your chats yet. Open the Atlas app once
  and try again." Schema 1: "Open the Atlas app once so it can update its chat index."
- D42. Cache: in-process, keyed by (index path, `MAX(msgs.id)`, file mtime); the first call
  groups (<= 2 s release on 20,000 prompts), later calls with no new rows answer from memory.
  No network, no file cache.
- D43. `note_skill_offer {groupId, answer: "offered" | "declined" | "made" | "never",
  skillName?}` writes `<data>/habits.json` (`schemaVersion` 1, atomic; per group id: answer,
  `atMs`, skill name; plus `offersOff`). It writes Atlas's own data only, never the Claude
  folder, so it is allowed in direct mode. `never` (any group id) sets `offersOff: true`.
- D44. Privacy: the tools return only text the user typed (D30-D31), already secret-masked;
  never assistant text, never a prompt containing `***`; nothing is logged; `habits.json`
  holds ids, answers, times and skill names only.

The skill (plugin root `skill/`)
- D50. A **second skill in the Atlas plugin**, `skill/skills/atlas-repeats/SKILL.md`, not new
  text in `skill/skills/atlas/SKILL.md`. Reason: a skill's body only loads when it fires, and it
  fires from its always-listed description; the usage skill's description is about usage, and
  adding a second trigger to it would make usage questions and repeat offers compete. Same
  plugin, same marketplace, same version number (MEMORY 2026-11-08: plugin, app and tag share
  one version). (Open question 1 in section 7.)
- D51. Frontmatter: `name: atlas-repeats`; `description` says it offers to turn a request the
  user keeps making into a reusable skill; `when_to_use`: after a task is finished, when the
  user's request is one they have clearly made before (the same kind of ask 3+ times in this
  chat, or words like "again", "like last time", "as usual", "same as before"), or when the
  user asks "make this a skill". Not mid-task, not for one-off questions, not when the user
  already said no to it. `allowed-tools: mcp__atlas__find_repeated_requests,
  mcp__atlas__note_skill_offer` (read-only and Atlas-data-only); `create_item` is not
  pre-allowed, so Claude Code asks before the save.
- D52. Body steps: (1) if `mcp__atlas__find_repeated_requests` exists, call it with `like` =
  the user's current request; if `offersOff`, stop silently; (2) offer only if the matched group
  meets D34 (or this chat alone has 3+ asks of the same kind), has no `offer` answer, and no
  existing skill covers it (`list_items {kind: "skill", query: <2-3 key words>}`; if one does,
  at most mention it once: "Your skill /x does this."); (3) the offer is one line at the end of
  the reply, after the task's result, e.g. "You've asked for this 14 times across 6 chats. Want
  me to turn it into a skill?", then `note_skill_offer offered`; (4) "no" or silence -> `declined`
  and never again for that group; "stop asking" -> `never`; (5) on yes, draft with the D53
  template, show the whole file in a code block, apply the user's edits, then
  `create_item {kind: "skill", name, text}` and `note_skill_offer made`; report the saved path
  and that it can be undone in Atlas History.
- D53. Draft template (the skill instructs Claude to fill it from the user's real wording, not
  invent steps):

  ```
  ---
  name: <2-4 key words, kebab-case, [a-z0-9-], <= 40 chars>
  description: <what it does in one line>. Use when the user asks things like '<ex1>', '<ex2>' or '<ex3>'.
  ---

  # <Name in words>

  The user asks for this often. Do it the way they describe it:

  > <their most common wording, verbatim>

  ## Ways they ask
  - '<example>'   (up to 5)
  ```

  Rules: one-line description <= 1,024 chars without `<` or `>`; no `allowed-tools`, `hooks` or
  other `CODE_KEYS`; no `!` command lines; no example containing `***`; a taken name gets `-2`.
- D54. Never naggy: at most one offer per chat; at most once per group ever (D43); never
  mid-task, never before the task's result, never in the same reply as an error or a question
  to the user; the offer is one sentence, no emoji, no exclamation mark.
- D55. Without the Atlas MCP connected: offer only on repeats inside this chat; on yes show the
  draft and say "Connect Atlas in Settings > Claude Code to save it with a backup, or tell me to
  save it here." Save with Claude Code's own file tools only after that second yes.
---

## 3. Screens: Toolkit > Library (Trail Map; tokens from `src/styles/tokens.css`)

No page scroll at 1280x800 on either Toolkit tab; at 900x600 lists scroll inside their pane,
nothing clipped. Unit B has no screens.

**Toolkit tab row** (top of the page, 40 px): the segmented control "Your setup" | "Library"
(track `raised` radius 10, sliding thumb 320 ms spring). "Your setup" is today's Toolkit,
unchanged; if the 40 px row makes it scroll at 1280x800, the height comes out of the gaps
between its panels, not out of the tiles.

**Library tab, top row** (48 px): a 36 px search field (240-360 px, radius 8, magnifier 16 px,
placeholder "Search plugins and skills"), **Add from GitHub** (secondary, `GithubLogo`), and a
32 px Refresh icon button (`spin`) with the caption "Updated 3 min ago" / "Updating...".

**Source rail** (>= 1100 px: 200 px column left of the list; below: a Source dropdown in the
top row): All, Installed (count), Claude plugin directory (count), each added marketplace
(count), Add a marketplace.

**List:** virtualized 56 px rows, row hover `raised` (no lift): 32 px icon blob (`Package`,
radius 10, `accent-tint`), name 14/600 over a one-line description (`text-2`, truncated); right
side: source caption 12, version 12 mono, an "Installed" pill when installed, Install
(secondary, 28 px) or Open. Installed rows add the plugin on/off switch (`claude plugin
enable/disable`) and an Uninstall X with the Toolkit inline confirm; Library-copied items add
Open in Toolkit and a Remove X (inline confirm = Undo of the create); the D19 note with Check
again. Click or Enter opens the sheet.

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
path; taken names unticked with the reason), the Before-you-install card (with the
`not_installed` line when hooks or LSP servers are present), and "Install 3 items" (primary).

**States**
- No catalog cache and offline: Topo + spark, "Atlas could not reach the plugin catalog. Check
  your connection and press Refresh." Search with no match: "Nothing matches <query>."
- No Claude Code command: the D24 line on plugin rows and one notice line above the list.
- Fetch error: one sentence naming the cause (not found, too big, timed out, not a GitHub
  link, unsafe archive) and the next step; nothing is half installed.
- Install error: the CLI `message` cut to one sentence, plus "Nothing was changed." when the
  read-back confirms it.

**Keyboard:** Ctrl/Cmd+F or `/` focuses search; Up/Down move the selected row; Enter opens the
sheet; Ctrl/Cmd+Enter in the sheet installs; Esc closes the sheet, dialog or confirm;
Left/Right on the segmented control switch tabs.

---

## 4. Build units and files

### Unit A: Library tab (app + core)
| File | Change |
|---|---|
| `src/pages/Setup.tsx` | "Your setup" / "Library" segmented control, `atlas.toolkit.tab` (D1) |
| `src/components/CommandPalette.tsx` | "Library" entry (D1) |
| `src/components/library/{LibraryTab,SourceRail,LibraryList,DetailSheet,SafetyCheck,AddFromGitHub,ItemChecklist}.tsx` | UI |
| `src/lib/{library.ts,libraryTypes.ts,mockLibrary.ts}` | model, filter, mock backend |
| `crates/core/src/library/{mod,catalog,cli,link,archive,shape,check,install,ledger}.rs` | catalog parse + cache (D10), CLI runner (D4, D5, D7), link parse (D16), tar.gz reader (D15), shape (D17), check (D18, D19), installs (D21, D22), ledger (D23) |
| `crates/core/src/setup_write.rs` | `install_skill_folder`; `restore_any` undoes a folder `create` (D22) |
| `crates/core/src/history/marks.rs`, `src/lib/historyModel.ts` | source `library` (D3) |
| `crates/core/Cargo.toml` | `flate2`, `tar` at the locked versions (D14) |
| `crates/app/src/library.rs` | commands, reqwest download with progress + cancel events, background refresh |
| `crates/app/Cargo.toml` | direct `reqwest` at the locked version (D14) |
| `src/lib/shotTour.ts`, `tools/mac-check.sh` | the Library tab in the picture tour, new counts |
| `fixtures/library/` | captured CLI JSON (1.1 shapes, incl. a 3,603-entry catalog), small `.tar.gz` repos: marketplace, hookify-like plugin, plugin.json-only repo with hooks + skills, loose skills with scripts, http-MCP repo, malicious archives |

### Unit B: skill text + `find_repeated_requests` + `origin` column
| File | Change |
|---|---|
| `crates/core/src/search/{extract,db,mod}.rs` | `origin` column, schema 2, `PARSER_VERSION` "2" (1.3) |
| `crates/core/src/habits/{mod,filter,normalize,cluster,notes}.rs` | new: D30-D35 grouping, D43 `habits.json` |
| `skill/skills/atlas-repeats/SKILL.md` | new skill (D50-D55) |
| `skill/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | descriptions mention the new skill; version bump with the release |
| `tools/make-fixtures.py`, `fixtures/claude-habits/` | repeated-request fixture (every text line `"fixtureText": true`) |

### Shared files (append-only; merge A first, B rebases)
- `crates/mcp/src/server.rs`: A adds `search_library` (D25); B adds `find_repeated_requests`
  and `note_skill_offer` (D40-D43).
- `docs/specs/mcp-server.md`: each unit adds its tool rows and notes.
- `crates/core/src/lib.rs`: `pub mod library;` (A), `pub mod habits;` (B).
- `crates/mcp/src/main.rs` only if the server needs the data dir passed differently (today it
  already resolves `--data-dir`).
---

## 5. Acceptance criteria

Both units
1. `cargo test --workspace` passes, including a test that runs every Library write (plugin
   install via a fake CLI, uninstall, copy install, undo) and every Unit B write
   (`note_skill_offer`, `create_item` of a drafted skill) against tempdir roots and asserts the
   real Claude folder's tree (paths, sizes, mtimes) is unchanged.
2. `npx tsc --noEmit`, `npm test`, `cargo clippy --workspace -- -D warnings` green; existing
   tests changed only where intended (tour counts, Toolkit tab).

Unit A: Library tab
3. Debug build, real root: the CLI runner refuses `list --available` and `install` without
   spawning (unit test: spawn counter stays 0).
4. A source-level test (like `no_network_listener`) fails if `crates/core/src/library` or
   `crates/app/src/library.rs` builds a `Command` without `proc::quiet`, or starts anything but
   `claude`; the runner test asserts no install call carries `-y` or `--accept-command`.
   [Will or a screen recording] no console window flashes during refresh, install, uninstall.
5. With the `ATLAS_LIBRARY_GITHUB_BASE` test server counting requests: 0 requests in a 60 s run
   that never opens Toolkit > Library.
6. Parsing the captured `list --available --json` fixture yields 3,603 entries with pluginId,
   name, marketplace, version, source kind and sha; `catalog.json` round-trips, and a write
   killed between temp and rename leaves the old file readable.
7. With the 3,603-entry cache, the Library tab shows rows <= 150 ms after the tab switch (log
   line `library: first rows N ms`); during a refresh a typed key appears in the search field
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
    `no_ask` + `commands`; a YAML merge key hiding `hooks` is caught; a planted `sk-ant-` token
    in a script shows masked; the plugin.json-only repo with hooks yields `not_installed`.
13. Verifier, real network, scratch `CLAUDE_CONFIG_DIR` (never the real folder): install
    `frontend-design@anthropic-plugin-directory` from the UI -> row shows Installed, History
    shows "Installed from the Library", the backup holds the three JSON files, the ledger has
    the entry; Undo -> `installed_plugins.json` no longer lists it and `plugins/data/<id>` is
    kept. Screenshots of the list, the sheet and History.
14. Copy install from the loose fixture (test server): two skills with scripts and one agent
    land under `<root>/skills/` and `<root>/agents/` byte-identical to the archive; a taken name
    is unticked and untouched; Undo moves the folder into the backup and the trash; undoing
    that Undo restores it byte-identical (hash test). The plugin.json-only fixture installs its
    skills and leaves `settings.json` hooks untouched (hash test).
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
20. MCP `search_library`: on the catalog fixture "frontend" returns `frontend-design` first; no
    catalog file returns the D25 sentence; the test server sees 0 requests.
21. Screens at 1280x800 and 900x600, light and dark (Silver once at 1280x800): "Your setup" with
    the tab row (no scroll at 1280x800), the Library list with the rail, the sheet with flags,
    an Add-from-GitHub result with `not_installed`, the Installed filter, empty and error
    states; nothing clipped at 900x600; fixtures only; saved under `docs/shots/library/` and
    viewed.
22. Sidebar, `View` and Ctrl/Cmd+1..7 unchanged (existing tests untouched); Ctrl+K "Library"
    opens Toolkit on the Library tab (test).

Unit B: repeated requests
23. Search schema 2: a schema-1 index re-reads once and fills `origin`; fixture lines with
    `origin.kind` human / task-notification / peer, `promptSource: system`, `isCompactSummary`,
    `entrypoint: sdk-cli` map to 1 / 2 / 2 / 2 / 2 / 2, and a subagent file's lines are excluded.
24. Fixture: the planted request (7 variants, 4 sessions, 3 days) is one group with count 7;
    none of these is a group (one named test each): a request x20 in one session, a subagent
    prompt x20, a task notification x30, a slash command x10, a pasted log x6, a 2-word prompt
    x15, a prompt with a masked secret x6.
25. Deterministic: two runs, and a run with the input rows shuffled, give the same ids, counts
    and order.
26. 20,000 synthetic prompts group in <= 2 s in release (`cargo test --release -p atlas-core
    habits::bench -- --ignored` prints the time); a second MCP call with no new rows answers in
    <= 50 ms.
27. MCP stdio test on the fixture data dir: `find_repeated_requests {}` returns the planted
    group with count 7, sessions 4, days 3, its projects and <= 5 examples; `{like: <a fresh
    variant>}` sets `likeMatch` to that group; no returned text contains `***` or assistant text;
    the index file's sha256 is the same before and after; missing index and schema-1 index give
    the D41 sentences.
28. `note_skill_offer`: `declined` shows as the group's `offer`; `never` makes `offersOff` true;
    `habits.json` contains no fixture prompt text (grep: 0 hits); the Claude folder is untouched.
29. `create_item {kind:"skill"}` in direct mode accepts a filled D53 draft (backup tagged `mcp`,
    History "Made by Claude through Atlas's connector") and refuses the same draft with an
    `allowed-tools` line (existing allow-list).
30. `claude plugin validate skill --json` reports success with no errors; `atlas-repeats`
    SKILL.md is ASCII and has the D51 frontmatter keys.
31. Verifier, scratch `CLAUDE_CONFIG_DIR`, plugin loaded with `--plugin-dir skill`, `atlas-mcp`
    registered with `--config-dir`/`--data-dir` pointing at the fixture: a headless `claude -p`
    with a fresh variant of the planted request, after the task, ends with exactly one offer
    line; with that group noted `declined`, no offer; with `offersOff`, no offer; with a one-off
    request, no offer. Transcripts saved as evidence (fixture text only).
32. [Will] In his real chats the offer comes at the right moment, once, and never feels naggy;
    a saved skill fires when he asks the same thing again.
33. [Will] The Library tab feels instant, and the check's words make sense to someone who is
    not a developer.

## Done when
Units A and B are merged to `main`; criteria 1-31 carry evidence (test names, log lines,
screenshot and transcript paths) and pass code-reviewer and verifier; a release build installed
one real plugin into a scratch config dir; the plugin version is bumped with the next release
so `atlas-repeats` ships; Will has run 32 and 33.

## Risk-floor flags
- Unit A installs third-party code into Claude's setup (hooks and MCP servers later run with
  the user's rights): opus code-reviewer with the security checklist, plus the verifier.
- Untrusted archives (path traversal, symlinks, bombs) and untrusted YAML/JSON (Unit A).
- The CLI writes the Claude folder even when listing (1.1): the debug guard must cover it.
- Unit B hands the user's own typed prompts to Claude through a local stdio MCP: masked text
  only, user-typed only, nothing logged (D44); the reviewer checks the filters and the masking.
- The search schema bump re-reads the whole corpus once (background, existing budget).

## Known, accepted risks (security review, 2026-11-09)
- **Gap between the last look and Claude Code's copy.** A plugin inside a marketplace folder
  (Local source) is re-hashed right before the install and refused if it is not the one that was
  checked (`install::local_unchanged`), but Claude Code copies the folder a moment later, and a
  process that can write the user's own Claude folder could change it in between. Not closed:
  whoever can write that folder can already edit settings and hooks directly. The backstop is the
  rollback: after the install the landed files are hashed again, and any difference from the
  checked ones (`files_differ`) takes the plugin out again (`take_out_again`), both steps in
  History. A pinned commit has the same backstop through the landed sha (`commit_differs`).
- **A directory plugin's own entry is read from the repo it is fetched from**, at the pinned
  commit (the built-in directory has no marketplace file on this computer). No entry for the
  folder and no plugin manifest means "can't read" (two clicks), never clean. It is not read
  again at install: the pinned commit is what is installed, and a changed listing is refused
  (`same_listing`).

- **Official entries of external directory plugins, mostly not visible (security re-review, 2026-11-09).**
  A directory plugin whose repo is outside `claude-plugins-official` can have its manifest written inline
  in the official marketplace's entry (`strict: false`, `skills`, `hooks`, `lspServers`...). Atlas looks the
  entry up by name in the official marketplace folder Claude Code keeps (`known_marketplaces.json`), or in
  the copy just fetched when the plugin comes from the official repo, and reads it only when its source
  (repo, folder, commit) matches what the catalog lists; the same name from another place is unreadable
  (two clicks). When that folder is not on the computer (Claude Code never added the official
  marketplace), the roughly 3,350 external directory entries have no official entry to read: only their own
  files and manifest are checked. Accepted: the plugin is still staged at an exact commit and the sheet
  says what it found; the staged `repo:` key is not re-read at install. The same gap exists when the
  local official clone is older than the catalog: a name added since is not in it, so its inline fields
  are not seen.

## Suggested agent chain
Unit A coder (sonnet; Rust + React; primary skill `ui-ux-pro-max`) and Unit B coder (sonnet;
Rust + skill text) in parallel worktrees -> per unit code-reviewer (A: opus + security
checklist; B: sonnet) in parallel with a verifier -> merge A, rebase and merge B ->
design-reviewer on `docs/shots/library/` -> Will (32, 33).

---

## 6. MCP tie-in (Library)
- `search_library`: **yes, in Unit A** (D25). It is cheap: a read-only filter over
  `catalog.json`.
- `suggest_install`: **no, not now.** It is not cheap. A proposal would need a new `Write`
  variant whose apply fetches, checks and runs the CLI inside `pending::apply`. Also no Pending
  Changes screen exists in the app yet (Phase 6), so a proposal would sit where nobody sees it.
  When it is built, it must stay propose-only, never direct, so a prompt-injected chat cannot
  install hooks.

## 7. Will's answers (2026-11-09) and open questions
Answered: install clicks = one click when clean, a second in the sheet when flagged (D20);
Library = a tab inside Toolkit (D1); non-marketplace repos install skills, agents, commands,
output styles and MCP servers, hooks and LSP listed as not installed (1.2, D18); direct
`reqwest` + `flate2` + `tar` (D14); no in-app Habits, the plugin skill offers instead (Unit B).

Open:
1. Where the offer instructions live: (a) a second skill `atlas-repeats` in the same Atlas
   plugin [pick, D50]; (b) inside the existing `atlas` usage skill.
2. When to offer from past chats: (a) 5 asks in 3 chats on 2 days, or 3 in this chat [pick,
   D34/D52]; (b) lower (3 asks in 2 chats); (c) higher (10 asks).

## 8. Not verified
- Whether `list --available` refetches the directory over the network on every call.
- Whether installing a directory plugin ever runs code (npm dependencies, `.mcpb` setup); only
  a skill-only plugin was installed.
- JSON of `marketplace update`, `enable`, `disable`; whether a reinstall after `--keep-data`
  gets its data back.
- macOS: finding `claude` from a GUI app's PATH (`find_claude_cli` adds `~/.local/bin` and
  `~/.claude/local`); codeload behind proxies.
- Whether models fire `atlas-repeats` reliably from its description, and whether a plugin
  skill's `allowed-tools` pre-allows `mcp__atlas__*` tools (criterion 31 tests it).
- The thresholds (D33, D34) are first guesses; only Will's real chats tune them (32).

## 9. Most installed first (added 2026-11-11)
- Where the counts live: Claude Code's `<config>/plugins/plugin-catalog-cache.json`, field
  `catalog.plugins["<name>@<marketplace>"].unique_installs` (an integer; `installs_generated_at`
  dates it). Only `claude-plugins-official` carries it (313 of 315 plugins on Will's machine);
  the built-in directory (`anthropic-plugin-directory`) and added marketplaces have none, so those
  plugins have no count. Matching is by exact plugin id; nothing is matched by name. No network.
- `atlas_core::library::popularity` reads the file (lenient: a count in a wrong shape drops only
  that plugin; a missing, oversized or foreign file means no counts) and orders the catalog once
  per answer: catalog order (directory first), then, when any count exists, a stable sort, most
  installs first, no count after every count, ties in catalog order. `library_catalog` (first 60)
  and `library_catalog_all` use the same function, so the first rows are the rows the page keeps.
  Each slim entry carries `installs` (when known) and `pos` (its catalog position).
- The page sorts nothing per render: the store orders `idx` when data lands or when the choice
  changes (`orderIndexed`, stable, `pos` restores the catalog's order). The Sort control is the
  shared `OptionsMenu` (Most installed / Catalog order) and exists only when counts exist. The
  choice lasts the session, not the launch, so the first page always matches the default.
- Under All with nothing typed in popular order: Installed first, then one run under "More
  plugins" across marketplaces, each row outside the directory naming its source. A row shows
  "12k installs" in its quiet right-hand side when it has a count.
