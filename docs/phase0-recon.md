# Atlas - Phase 0 recon

**What it is:** what a real Claude Code install looks like on disk (Will's Windows
machine, 2026-11-08), what the current docs say, the architecture that follows, every
place the spec (`BUILD-PROMPT.md`) disagrees with reality, and the risks.
**Status:** done, read-only. Nothing under `~/.claude` or `~/.claude.json` was written.
Only key names, counts and model ids were sampled; no message text, values or secrets.

Sources: the live config (Claude Code CLI 2.1.296 on PATH, npm global install; the
desktop app bundles 2.1.317), `claude --help` / `claude mcp --help`, and
code.claude.com/docs pages `settings`, `claude-directory`, `mcp`, `hooks`.

---

## 1. Findings

### 1.1 Config root
- `CLAUDE_CONFIG_DIR` is **not set** (process, user or machine scope).
- Docs: with `CLAUDE_CONFIG_DIR` set, every `~/.claude` path moves under it, **and so
  does `.claude.json`** (`$CLAUDE_CONFIG_DIR/.claude.json`, not `~/.claude.json`).
- Will's machine has a stray 847-byte `~/.claude/.claude.json` (a few start-up keys,
  no MCP data) beside the real 106 KB `~/.claude.json`. Atlas must pick the file by the
  rule above, never "whichever exists".
- `~/.claude.json` siblings: `.claude.json.backup`, dated `.bak-*` copies and an
  orphaned `.claude.json.tmp.<pid>.<hash>` from Aug 2026 (evidence that a writer was
  interrupted mid-rename once). Claude Code also keeps its own copies in
  `~/.claude/backups/` (5 newest).
- On Will's machine `~/.claude` is itself a git repo (his harness). Not expected on
  dad's, but Atlas should tolerate it (do not touch `.git`, list it nowhere).

### 1.2 Top-level layout of `~/.claude` (Will's)
`CLAUDE.md`, `MEMORY.md`, `settings.json`, `settings.local.json`, `history.jsonl`,
`.credentials.json`, `policy-limits.json`, `daemon.lock`, `.update.lock`, and dirs
`agents/ skills/ hooks/ output-styles/ rules/ plugins/ projects/ backups/ cache/
debug/ file-history/ sessions/ session-env/ shell-snapshots/ jobs/ daemon/ ide/
scheduled-tasks/ state/ templates/ reference/ scripts/ spares/ cloud/ bridge-spawn/`.
No global `commands/` dir (commands are optional and folded into skills upstream).
Many of these are Will's own folders: "Other files" will be large on power users.

### 1.3 Session transcripts (usage source)
- Path: `projects/<encoded-cwd>/<sessionId>.jsonl`; subagents at
  `projects/<encoded-cwd>/<sessionId>/subagents/*.jsonl`; also `tool-results/`,
  `mcp-tasks/`, and per-project `memory/` (auto memory).
- Folder encoding is lossy (every non-alphanumeric char becomes `-`): never decode it;
  take the project path from the `cwd` field (and `relocated.relocatedCwd`).
- Scale here: 81 project folders, **1,881 jsonl files, 1,508 of them (80 %) subagent
  files, 5.3 GB total, largest single file 300 MB**. Oldest file 2026-07-14.
- Line `type`s seen: `user, assistant, attachment, system, api-request,
  api-request-blob, api-request-shape, queue-operation, last-prompt, custom-title,
  agent-name, file-history-snapshot, file-history-delta, atis-latch, bridge-session,
  cost-state, tools-used, mode, relocated`. Only `assistant` carries usage. The
  `api-request*` lines carry the request (system prompt, tools): large, skip them.
- `assistant` line fields used: `message.{id, model, usage}`, `requestId`, `timestamp`,
  `sessionId`, `cwd`, `isSidechain`, `agentId`, `entrypoint`, `version`, `gitBranch`,
  `attributionSkill`, `attributionMcpServer`, `attributionMcpTool`, `isApiErrorMessage`.
- `message.usage` keys: `input_tokens, output_tokens, cache_creation_input_tokens,
  cache_read_input_tokens, cache_creation.{ephemeral_5m_input_tokens,
  ephemeral_1h_input_tokens}, output_tokens_details.thinking_tokens,
  server_tool_use.{web_search_requests, web_fetch_requests}, service_tier, speed,
  inference_geo, iterations[]`. All sampled: `standard / standard / global`.
- Models seen: `claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, claude-opus-5,
  claude-opus-4-8, claude-opus-4-6, claude-fable-5`, plus `<synthetic>` (skip: not an
  API call).
- **Duplicates:** in an 80-file sample, 5,495 of 11,134 assistant lines repeat an
  earlier `message.id + requestId`. Every duplicate is in the same file (none crossed
  files in a 150-file check). The lines differ **only in `output_tokens`**, and the
  **last line always holds the maximum** (9,037/9,037); the first line holds it only
  87 % of the time. Rule: dedup by `message.id + requestId`, keep the last line's usage.
- `cost-state` lines carry Claude Code's own `totalCostUSD` + per-model `modelUsage`
  for a session, and `~/.claude.json projects[p].lastModelUsage` has `costUSD` per
  model: a free cross-check for Atlas's estimates (seen in few sessions only).
- Malformed lines in the sample: 0 (still must be tolerated; the newest line of a live
  session is often half-written).
- `custom-title` / `agent-name` lines give human session names for the Sessions list.

### 1.4 Retention (big for Wrapped)
- Docs: transcripts, subagent dirs, file-history etc. are deleted after
  `cleanupPeriodDays`, **default 30 days**. Auto memory and `history.jsonl` are kept.
  `stats-cache.json` (aggregates behind `/usage`) is kept but absent on Will's machine.
- So on a default install the logs hold about one month. A "full year" heatmap and
  Wrapped 2026 cannot come from the logs unless dad's `cleanupPeriodDays` is high.

### 1.5 `~/.claude.json` (global state, written constantly by Claude Code)
- 106 KB, 2-space JSON, LF, modified minutes before the recon. 60+ top-level keys incl.
  `oauthAccount`, `userID`, `machineID`, `cachedGrowthBookFeatures` (1,155 keys),
  `projects` (50 entries), `mcpServers`, `skillUsage`, `pluginUsage`.
- `mcpServers` (user scope): 2 stdio servers, keys `type, command, args, env`.
- `projects["C:\\Users\\...\\proj"]` keys: `allowedTools, mcpContextUris,
  enabledMcpjsonServers, disabledMcpjsonServers, hasTrustDialogAccepted, mcpServers`
  (15 entries; 3 non-empty = **local-scope servers**), plus last-session stats.
  16 of the 50 project paths no longer exist on disk.
- `skillUsage[name] = {usageCount, lastUsedAt}` and `pluginUsage` exist: Wrapped's
  "most-used skill" can come from here plus `attributionSkill` in the logs.

### 1.6 MCP servers: where they really live (docs + disk)
| Scope | Where | Precedence |
|---|---|---|
| Managed | `managedMcpServers` setting / managed-mcp file (read-only) | highest |
| Local (default of `claude mcp add`) | `~/.claude.json` `projects[path].mcpServers` | 1 |
| Project | `<project>/.mcp.json` `mcpServers` (needs approval: `enabledMcpjsonServers` / `disabledMcpjsonServers` per project) | 2 |
| User | `~/.claude.json` top-level `mcpServers` | 3 |
| Plugin | plugin root `.mcp.json` or `plugin.json` `mcpServers` | 4 |
| claude.ai connectors | remote, account-level, not on disk | 5 |
- Same name in two scopes: the winner's whole entry is used, no field merge.
- **On/off is per project**, stored in `~/.claude.json projects[path].disabledMcpServers`
  (opt-out) / `enabledMcpServers` (opt-in for default-off built-ins). There is no
  global "disabled" flag on a server.
- `.mcp.json` supports `${VAR}` / `${VAR:-default}` expansion; show unexpanded.
- Will's projects: 0 `.mcp.json` files; 1 plugin installed (`impeccable`), no plugin
  MCP servers.
- CLI 2.1.296 has `claude mcp add | add-json | remove | get | list` with
  `-s local|user|project`. `list` health-checks (launches) servers: never call it as
  a passive read.

### 1.7 settings.json and hooks
- Official schema: `https://json.schemastore.org/claude-code-settings.json` (may lag
  the CLI; warn, do not block, on unknown keys).
- Will's user settings keys: `skillListingBudgetFraction, model, autoCompactWindow,
  outputStyle, env, skillOverrides, worktree, hooks, extraKnownMarketplaces,
  effortLevel, theme, inputNeededNotifEnabled, agentPushNotifEnabled, enabledPlugins,
  permissions{defaultMode, allow[212], deny[39]}, skipDangerousModePermissionPrompt`.
- Files and precedence (high to low): managed > `--settings` > project
  `.claude/settings.local.json` > project `.claude/settings.json` > user. Arrays such as
  `permissions.allow` merge across files. Claude Code hot-reloads settings on change and
  fires the `ConfigChange` hook.
- Hooks shape: `hooks.<Event>[] = { matcher?, hooks: [ { type, ... } ] }`. Handler
  types: `command` (`command, args, async, shell, onFailure`), `http`, `mcp_tool`,
  `prompt`, `agent`; common `if, timeout, statusMessage, once`. 33 events.
  **No per-hook enabled flag** (docs say so); only `disableAllHooks`.
- Hooks also come from plugin `hooks/hooks.json`, skill frontmatter and agent
  frontmatter.

### 1.8 Other item types (docs + disk)
- User and project: `CLAUDE.md`, `rules/*.md` (frontmatter `paths`),
  `skills/<name>/SKILL.md`, `commands/*.md`, `agents/*.md`, `output-styles/*.md`,
  `workflows/*.js`, `agent-memory/<name>/`. Project-only: `CLAUDE.local.md`,
  `AGENTS.md`, `.mcp.json`, `.worktreeinclude`. User-only: `keybindings.json`,
  `themes/*.json`, `projects/<p>/memory/` (auto memory).
- Frontmatter sets are documented per type (skills about 20 fields, agents about 19).
  Will's agents carry a custom `lane` key and use **CRLF**; some dirs hold `.bak-*`
  files. Preserve unknown keys and line endings; list stray files as Other.
- Plugins: `plugins/installed_plugins.json` `{version, plugins: {id: [{scope,
  installPath, version, ...}]}}`, `known_marketplaces.json`, `cache/`,
  `marketplaces/`, `synced/` (claude.ai-synced). Enabled state lives in settings
  `enabledPlugins{"name@marketplace": bool}`.
- Project scope on this machine: 34 live project dirs; 31 have `.claude/`, 25 skills,
  9 agents, 3 commands, 13 `settings.json`, 24 `settings.local.json`, 29 `CLAUDE.md`.

### 1.9 Headless `claude` for the assistant
- `claude -p --output-format stream-json [--include-partial-messages]
  [--input-format stream-json]`, `--mcp-config <file> --strict-mcp-config`,
  `--allowedTools`, `--disallowedTools`, `--tools`, `--permission-mode dontAsk`,
  `--permission-prompts none`, `--append-system-prompt`, `--setting-sources`,
  `--max-budget-usd`, `--no-session-persistence`, `-n/--name`.
- `--bare` would be ideal but **requires `ANTHROPIC_API_KEY`** (no OAuth, no keychain):
  unusable for a subscription user. Do not use it.

### 1.10 Toolchain (Windows dev box)
| Tool | State |
|---|---|
| rustc / cargo | 1.97.1, target `x86_64-pc-windows-msvc` only |
| MSVC | Visual Studio Build Tools 2022 (vswhere confirms VC tools) |
| WebView2 | 157.0.4341.42 |
| node / npm | 24.18.0 / 11.16.0 (no pnpm, no bun) |
| tauri-cli | cargo-tauri 2.11.4 installed; npm `@tauri-apps/cli` latest 2.12.4 |
| crates | `rmcp` 3.9.0 latest; `tauri` latest is 3.0.0-alpha.6 (stay on 2.x) |
| gh | 2.93.0, logged in as `dozeyy` |
| claude | 2.1.296 on PATH (npm global); desktop app bundles 2.1.317 |
| macOS | no Mac, no Apple targets: macOS builds only in GitHub Actions |

---

## 2. Architecture

### 2.1 Workspace
```
Atlas/
  Cargo.toml                 workspace: crates/core, crates/app, crates/mcp
  crates/core/               no Tauri, no UI: everything testable with fixtures
    paths.rs                 config-root resolution (CLAUDE_CONFIG_DIR, --config-dir, sandbox)
    usage/                   scanner, line parser, dedup, aggregates, pricing
    cache.rs                 SQLite (rusqlite bundled, WAL, FTS5)
    setup/                   discovery + item model per kind, frontmatter, scopes
    write/                   the ONE write path: backup -> atomic write -> verify -> journal
    claude_json.rs           surgical .claude.json edits + CLI-first MCP add/remove
    history.rs               backup index, restore, undo stack, prune
  crates/app/                Tauri 2 shell: commands, events, tray, watcher, sidecar spawn
  crates/mcp/                rmcp stdio server binary (`atlas-mcp`), reuses core
  src/                       React + TS + Vite front end
    styles/tokens.css        the only place colors, radii, spacing, motion live
  fixtures/                  fake config roots (user + projects + transcripts), incl. CRLF,
                             symlinks, malformed lines, duplicates, huge-file stub
  .github/workflows/build.yml  macOS universal + Windows matrix, artifacts
```

### 2.2 Data flow
1. Start: resolve config root -> open cache -> UI paints from cached aggregates
   (no file I/O before first paint).
2. Background scanner (Rust thread pool, off the UI thread) walks `projects/`,
   compares each file's (size, mtime, inode/file-id) with the cache, and reads only the
   **new bytes from the last committed offset** (transcripts are append-only). Files
   that shrank or changed id are re-read from 0. A trailing partial line is left for
   the next pass.
3. Parser reads only `assistant` lines' needed fields (serde with borrowed `&str`,
   skipping unknown fields; `api-request*` lines skipped by a cheap prefix check), plus
   `custom-title`, `agent-name`, `relocated`, `cost-state`.
4. Upsert `messages(msg_key PK, session_id, agent_id, project, model, ts, in, out,
   cache_w_5m, cache_w_1h, cache_r, web_search, is_sidechain, skill, ...)`: the
   last line for a key wins. Aggregates (per day x model x project) update in the same
   transaction; sessions table keyed by `sessionId` (subagent files roll up into it).
5. `notify` watcher on `projects/` (debounced 500 ms) re-runs step 2 for changed
   files; the front end gets a Tauri event and refreshes from SQLite.
6. Full-text search: FTS5 over user and assistant **text blocks only** (no tool
   results, no api-request lines), built lazily in the background on first use of
   search, with progress. Session Detail streams the transcript straight from the
   jsonl by offset.

### 2.3 Cache as a durable ledger
- Rows are never deleted when Claude Code's sweep deletes a transcript: the cache is
  the long-term history (that is what makes Wrapped and the year heatmap possible from
  install day onward). Files gone from disk are marked `source_missing`.
- Key by `(path, file-id)` not just path+size+mtime; `schemaVersion` + parser version
  in the DB: a parser change triggers a background rebuild, never a blocking one.

### 2.4 Write path (backups + atomic writes), used by UI, assistant and MCP alike
1. Resolve the real target (follow symlinks; write the target, keep the link).
2. Read current bytes; if they differ from what the editor loaded -> conflict dialog
   (newest wins only with consent).
3. Snapshot current bytes to `<appdata>/atlas/backups/<yyyy>/<hash-of-path>/<ts>.bak`
   + an index row `{path, ts, source: user|assistant|mcp, summary, sha256}`.
4. Write temp file in the **same directory**, fsync, then rename over the target
   (POSIX `rename`, Windows `ReplaceFileW` / `MoveFileExW(REPLACE_EXISTING)`), with
   retry and backoff on sharing violations (Claude Code or an AV scanner holding it).
5. Preserve line endings, BOM, trailing newline, file mode; JSON edits use
   `serde_json` with `preserve_order` + same indent; for settings files prefer a
   format-preserving edit (change only the edited span) so diffs stay one key wide.
6. Re-read and verify (parse + hash) and append to the history journal; Undo = restore
   the previous snapshot through this same path.
- `.claude.json` MCP edits: first choice `claude mcp add-json -s user|local` and
  `claude mcp remove -s ...` (Claude Code's own writer and locking). Fallback (CLI
  missing): read -> change only `mcpServers` (or one project's `disabledMcpServers`)
  -> re-read immediately before rename -> abort if the file changed in between ->
  verify every other top-level key is byte-identical after write.
- Hook on/off: Claude Code has no per-hook flag, so "off" moves the handler into an
  Atlas-owned stash (`<appdata>/atlas/disabled-hooks.json`, with its exact original
  position) and "on" puts it back. Shown honestly as "Off (kept by Atlas)".
- Prune: last 50 versions per file; `projects/` logs never backed up.

### 2.5 MCP crate (`crates/mcp`, binary `atlas-mcp`)
- rmcp 3.x stdio server, tools as in the spec (`list_items, read_item, create_item,
  update_item, rename_item, delete_item, toggle_hook, toggle_mcp_server,
  get_usage_summary, list_backups, restore_backup`), JSON-schema inputs.
- Opens the same SQLite cache read-only for usage and goes through `core::write` for
  every change (tag `source=mcp`). The running app sees the change through its file
  watcher and the history index.
- `--propose` mode: write tools queue a pending change (file in
  `<appdata>/atlas/pending/`) instead of writing. The in-app assistant launches
  `claude -p --mcp-config <atlas-only.json> --strict-mcp-config --allowedTools
  "mcp__atlas__*" --permission-mode dontAsk --permission-prompts none` with
  `atlas-mcp --propose`, so nothing it does reaches disk until Approve.
- Registered as `atlas` at user scope with the absolute path of the installed sidecar.
  The app re-checks that path at every start and repairs it after a move or update.
- Concurrency: app and MCP process share one cross-process lock file around writes.

---

## 3. Spec vs reality (reality wins)
1. **Dedup:** spec "dedupe by message ID + request ID" is right, but keep the **last**
   line's usage, not the first (first-seen undercounts output tokens).
2. **Subagent transcripts** (80 % of files) live in `<session>/subagents/`; they must be
   counted and rolled up into their parent session.
3. **Project path** comes from `cwd`, not the folder name (lossy encoding).
4. **`.claude.json` location** depends on `CLAUDE_CONFIG_DIR` (inside it when set).
5. **MCP scopes:** there are three file scopes, not two: add **local** scope
   (`projects[path].mcpServers` in `.claude.json`, the CLI default), plus plugin,
   managed and claude.ai connector servers (read-only rows).
6. **MCP enable/disable** is per project (`disabledMcpServers`); there is no global
   off switch. The UI offers "off in project X" (and "off everywhere" = write the list
   for every known project, explained).
7. **Hooks toggle** has no native flag: Atlas stash, as in 2.4. New handler types
   (`http, mcp_tool, prompt, agent`) need form support; 33 events.
8. **More item types** than the spec lists: `rules/`, `workflows/`, `agent-memory/`,
   auto memory (`projects/<p>/memory/`), `CLAUDE.local.md`, `AGENTS.md`,
   `keybindings.json`, `themes/`. `commands/` still exists but is optional.
9. **Plugins** are managed by `claude plugin` + `enabledPlugins`: Atlas lists them and
   toggles `enabledPlugins`; it does not edit plugin caches.
10. **Pricing table** needs separate cache-write prices for 5-minute and 1-hour TTL,
    web-search request pricing, and room for `speed` / `inference_geo` multipliers;
    unknown and `<synthetic>` models are excluded from cost.
11. **Retention:** logs are swept after 30 days by default. Wrapped/heatmap read from
    Atlas's durable cache, and first launch shows only what is still on disk. Atlas can
    offer (with consent, through the write path) to raise `cleanupPeriodDays`.
12. **Assistant:** `--bare` needs an API key; use the normal headless mode with
    `--strict-mcp-config` and Atlas-only tools. Its own sessions get named
    ("Atlas assistant") and filtered in Sessions by default (they still count in usage).
13. **"Connect to Claude Code":** prefer `claude mcp add-json -s user` over editing the
    file; `claude mcp list` launches servers, so never use it to read config.
14. **macOS unsigned builds:** the README's "right-click -> Open" is outdated on recent
    macOS; the user must use System Settings > Privacy & Security > Open Anyway. Apple
    Silicon also needs at least an ad-hoc signature (Tauri does this).
15. **Sources not to touch:** `.credentials.json`, `sessions/*`, `history.jsonl`
    (prompt text), `~/.claude/backups/` (Claude Code's own `.claude.json` copies; Atlas
    keeps its backups in its own app data dir).

---

## 4. Risks
| Risk | Mitigation |
|---|---|
| Clobbering a concurrent Claude Code write to `.claude.json` | CLI-first; else re-read + compare before rename, one key only, verify after, backup always |
| Windows rename fails while the target is open (sharing violation) | `ReplaceFileW` + bounded retry; never leave the temp file behind (Will's disk shows an orphaned one) |
| Symlinked config files (dotfiles repos) replaced by a plain file | resolve and write the link target |
| First index of 5 GB / 300 MB files is slow | streaming byte-offset parser, prefix skip of `api-request*` lines, background + progress, UI from cache |
| FTS index size | text blocks only, built lazily, size shown in Settings with a "rebuild/clear" button |
| Logs format changes between Claude Code versions (many new line types already) | tolerant parser, unknown types ignored, parser version in the cache, fixture per known shape |
| Wrapped thin on Christmas (30-day retention) | check dad's `cleanupPeriodDays` before Christmas; install Atlas early so the ledger fills; Wrapped copy adapts to the span it has |
| No Mac for local testing; dad is on macOS | CI `.dmg` per phase; someone runs it on a Mac before Christmas (open question) |
| Unsigned macOS app blocked by Gatekeeper | clear first-run instructions; optional Developer ID + notarization (paid: gated) |
| Terracotta accent sits next to danger red and near Claude's own brand color | danger always with icon + words; accent decision is an open question |
| MCP sidecar path changes when the app is moved/updated | re-verify and repair registration on every start |
| Assistant spends dad's quota / tokens | `--max-budget-usd` per run, visible in the panel; its sessions counted in usage |
