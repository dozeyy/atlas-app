# Phase 3 - Setup (read only)

**What it is:** the build spec for Atlas Phase 3: find every Claude Code setup item at every
scope, show it as cards, open its source read-only, flag shadowing, stay live via a file
watcher. **Status:** spec, 2026-11-08. Written while Phase 1 was being built; based on the
Phase 1 code as it stood (`crates/core/src/{paths,sandbox,fsutil,launch,settings}.rs`,
`crates/core/tests/fixtures.rs`, `tools/make-fixtures.py`, `src/lib/{ipc,types}.ts`).
**Precedence:** `docs/phase0-recon.md` > `BUILD-PROMPT.md`. Facts added here come from
Will's real config (read-only key names and counts, 2026-11-08) or the Claude Code docs,
marked "verify at build time" when not proven on disk.

Notation: `<root>` = resolved config dir (`ConfigRoot.dir`), `<cj>` = resolved
`ConfigRoot.claude_json`, `<p>` = a project folder, `<home>` = the user home folder.

---

## Goal
- The Setup page lists every item of every type, global + every project: name, type,
  scope, source path, enabled state, last modified, one-line description.
- Any item opens a read-only detail view: metadata + the raw source in CodeMirror 6 with
  syntax highlighting.
- Same-name skills, agents, commands, output styles and MCP servers at several scopes are
  flagged, with the winner marked.
- The page updates by itself when files change on disk.
- Nothing is written under `<root>`, `<cj>`, a project folder or a managed folder.

## Not in scope (Phase 4 or later, or not asked)
- Every write: edit, create, rename, duplicate, delete, toggle, templates, frontmatter
  form helper, validation-on-save, settings form, backups, History, Undo.
- "Reveal in Explorer/Finder" and "Open in editor" (Phase 4 list in the spec).
- MCP "Test connection", `claude mcp list`/`get` (they launch servers), any process spawn.
- "Edited by Claude" badge (Phase 5), Pending Changes (Phase 6).
- Plugin install/uninstall/update, marketplace browsing.
- Fetching claude.ai connectors or synced plugins over the network.
- Markdown live preview (Phase 4 editor).
- Search inside file bodies (search covers name, description, path only).
- TOML: no Claude Code config on disk or in the docs is TOML; no TOML parser.
- Usage, Sessions (Phase 2); Phase 3 reads only the `cwd` of transcripts.
- Changing Phase 1 behaviour (config-root resolution, sandbox copy rules).

## Grounding (read and measured, 2026-11-08)
- Real `C:\Users\Will\.claude` + `C:\Users\Will\.claude.json`, read-only, key names and
  counts only, no values copied. Python scan, Windows 11, warm cache, 2 runs.
- `<cj>`: 106,429 bytes, LF, no BOM, 62 top-level keys, parse 0.7 ms.
- `.claude.json projects`: **50 keys, 43 distinct after case + separator normalisation**
  (26 written `c:/Users/...`, 24 `C:\\Users\\...`; 6 duplicate groups); 29 distinct exist;
  3 have local MCP servers (2 stdio, 1 http); `disabledMcpServers` /
  `enabledMcpServers` present in none.
- `<home>` (`C:\Users\Will`) is itself a project key, so its `.claude\` **is** `<root>`.
  `C:\Users\Will\.claude` is also a project (it has `.claude\.claude\settings.local.json`).
- Transcript cwds (first `cwd` in the first 50 lines of 373 top-level `.jsonl`): 74
  distinct, 37 ms. Union with `.claude.json`: 99 paths, 54 exist, 49 exist and are not
  agent worktrees, 28 of those have a `.claude\` folder.
- Walk of `<root>` (bulk dirs pruned) + project `.claude\` + project root files: 765
  files, 25 ms; stat + first 4 KB of 423 `.md`: 42 ms.
- User scope: 36 agents (all CRLF; keys `name, description, lane, model, effort, tools,
  skills, isolation`), 37 skills (12 CRLF; keys `name, description, argument-hint,
  license, metadata, when_to_use, allowed-tools`), 26 synced skills, 7 rules (6 without
  frontmatter, 1 with `paths`), 1 output style (`name, description,
  keep-coding-instructions`), 0 commands, 3 hook scripts, 56 auto-memory folders (129
  files). `.bak-*` copies sit beside agents, rules, skills, output styles.
- `settings.json` keys: `skillListingBudgetFraction, model, autoCompactWindow,
  outputStyle, env, skillOverrides, worktree, hooks, extraKnownMarketplaces, effortLevel,
  theme, inputNeededNotifEnabled, agentPushNotifEnabled, enabledPlugins, permissions,
  skipDangerousModePermissionPrompt`.
  - `outputStyle` holds the style's frontmatter `name` ("Field Report"), not its file
    stem (`field-report.md`).
  - `skillOverrides` maps a skill name to a string (seen: `user-invocable-only`).
  - Hooks: 4 events, handler keys `type, command, timeout`; commands name scripts by
    absolute quoted path.
- Plugin on disk: `plugins/cache/<market>/<plugin>/<version>/` with
  `.claude-plugin/plugin.json`, `agents/`, `skills/`, `hooks/hooks.json`, plus
  `.grok-plugin/`, `.in_use/<pid>` (not Claude's; ignore).
- Not on Will's disk (docs only, shape to verify at build time): `keybindings.json`,
  `themes/`, `workflows/`, `agent-memory/`, global `commands/`, `statusLine`,
  `CLAUDE.local.md`, `.mcp.json` (0 projects), managed settings.
---

## Where each item lives and how it is parsed

| Kind | User scope | Project scope | Other scopes | Parse | Name; one-line description | Enabled state |
|---|---|---|---|---|---|---|
| Skill | `<root>/skills/<dir>/SKILL.md` (+ other files in `<dir>` as attachments) | `<p>/.claude/skills/<dir>/SKILL.md` | Plugin `skills/<dir>/SKILL.md`; Synced `<root>/skills/synced/<bucket>/<dir>/SKILL.md` + `manifest.json` `{lastUpdated, skills[{skillId, name, description, source, backingPluginId, updatedAt}]}`; Managed (verify) | YAML frontmatter | `name` else `<dir>`; `description` | effective `skillOverrides[name]` raw value (absent = On); plugin Off; Shadowed |
| Agent | `<root>/agents/*.md` | `<p>/.claude/agents/*.md` | Plugin `agents/*.md`; Managed (verify) | YAML frontmatter | `name` (else stem + warning); `description` | Shadowed / plugin Off / On |
| Command | `<root>/commands/**/*.md` | `<p>/.claude/commands/**/*.md` | Plugin `commands/` | YAML frontmatter, optional | path under `commands/` joined by `:`; `description` else first body line | Shadowed by same-name skill / On |
| Hook | `hooks.<Event>[] = {matcher?, hooks[{type, command?, timeout?, ...}]}` in `<root>/settings.json`, `settings.local.json` | same in `<p>/.claude/settings*.json` | Plugin `hooks/hooks.json` `{hooks:{...}}`; skill/agent frontmatter `hooks`; Managed | JSON | `<Event> · <matcher or "any">`; `<type>: <command, 60 chars>` | Off if effective `disableAllHooks` or plugin Off |
| Hook script | `<root>/hooks/*` + any file a hook command names | `<p>/.claude/hooks/*` | - | raw | file name; "Used by N hooks" / "Not referenced" | - |
| MCP server | User: `<cj>` `mcpServers.<name>` | Local: `<cj>` `projects[<p>].mcpServers.<name>`; Project: `<p>/.mcp.json` `mcpServers.<name>` | Plugin: `plugin.json` `mcpServers` or plugin `.mcp.json`; Managed `managed-mcp.json` (verify) | JSON | `<name>`; `stdio: <command> <args>` or `<type>: <url>` (never env/header values) | per project: Off if in `projects[<p>].disabledMcpServers`; `.mcp.json`: Approved / Rejected / Pending from `projects[<p>].enabledMcpjsonServers` / `disabledMcpjsonServers` + settings `enableAllProjectMcpServers` / `enabledMcpjsonServers` / `disabledMcpjsonServers`; card: "On in N of M projects" |
| Plugin | `<root>/plugins/installed_plugins.json` `{version, plugins{"<name>@<market>": [{scope, installPath, version, installedAt, lastUpdated, gitCommitSha}]}}` + `<installPath>/.claude-plugin/plugin.json` `{name, description, version, author, homepage, repository, skills}` | `enabledPlugins` in project settings | `known_marketplaces.json`, `extraKnownMarketplaces` (detail only) | JSON | `name@market`; `description`; child counts | effective `enabledPlugins["name@market"]` |
| Settings | `<root>/settings.json`, `settings.local.json` | `<p>/.claude/settings.json`, `settings.local.json` | Managed `managed-settings.json` (Windows `C:\Program Files\ClaudeCode\`, macOS `/Library/Application Support/ClaudeCode/`; verify) | JSON (tolerate BOM, CRLF) | file + scope; "N keys · M allow · K deny" | - |
| Permission rule | `permissions.{allow, deny, ask}[]`, `defaultMode`, `additionalDirectories` per settings file | same | Managed | from Settings | rule string; list name | - (source scope shown; arrays merge) |
| Status line | `statusLine {type, command, padding?}` in settings | same | Managed | from Settings | "Status line"; command head; links its script if the path resolves | effective one On, others Overridden |
| Output style | `<root>/output-styles/*.md` | `<p>/.claude/output-styles/*.md` | Plugin | YAML frontmatter | `name` else stem; `description` | Active when effective `outputStyle` equals `name` (case-insensitive) |
| Instructions | `<root>/CLAUDE.md` | `<p>/CLAUDE.md`, `<p>/.claude/CLAUDE.md`, `<p>/CLAUDE.local.md`, `<p>/AGENTS.md` | Managed CLAUDE.md (verify) | Markdown | file name; first `#` heading else first line | - (all load together) |
| Rule | `<root>/rules/*.md` | `<p>/.claude/rules/*.md` | - | YAML frontmatter, optional (`paths`) | stem; first body line; `paths` as chips | - |
| Auto memory | `<root>/projects/<encoded>/memory/*.md` | (mapped to its project) | - | Markdown | file name; first line | - |
| Agent memory | `<root>/agent-memory/<agent>/**` | `<p>/.claude/agent-memory/<agent>/**` (+ `agent-memory-local/`, verify) | - | raw | `<agent>/<file>`; first line | - |
| Workflow | `<root>/workflows/*.js` | `<p>/.claude/workflows/*.js` | - | raw (JS) | stem; first `//` comment | - |
| Keybindings | `<root>/keybindings.json` | - | - | JSON (shape verify) | "Keybindings"; "N bindings" if shape known, else size | - |
| Theme | `<root>/themes/*.json` | - | - | JSON | stem; `name` key if present | - |
| Other file | anything else under `<root>` not denied | anything else under `<p>/.claude/` | - | raw | file name; "Not managed by Atlas" | - |

- Deny list (never indexed, listed or opened; one shared constant with Sandbox):
  `.credentials.json`, `sessions/`, `*.key`, `*.pem`, `.env`, `history.jsonl`, `.git/`,
  `node_modules/`, `projects/**/*.jsonl`, `projects/**/tool-results/`,
  `projects/**/subagents/`, `backups/`, `cache/`, `debug/`, `file-history/`,
  `session-env/`, `shell-snapshots/`, `jobs/`, `daemon/`, `ide/`, `bridge-spawn/`,
  `cloud/`, `state/`, `scheduled-tasks/`, `telemetry/`, `statsig/`, `todos/`,
  `paste-cache/`, `uploads/`, `plugins/cache/` + `plugins/marketplaces/` (read only via
  installed plugins), `skills/synced/.bucket-*`, `*.lock`, `.claude.json.tmp.*`,
  `<p>/.claude/worktrees/`.
- `<cj>` is never shown whole; an MCP item shows only its own entry.

---

## Decisions made (code-reviewer checklist)
1. All discovery code lives in `crates/core/src/setup/`, no Tauri types; pure inputs
   `DiscoveryInputs { root: ConfigRoot, home, managed_dir: Option<PathBuf> }`; no env
   reads inside, so tests run in parallel (same rule as `paths.rs`).
2. `<cj>` is always `ConfigRoot.claude_json` from Phase 1; discovery never probes
   "whichever exists" (Will has a stray 847-byte `<root>/.claude.json`).
3. Project sources: `<cj>` `projects` keys + the first `cwd` of each top-level transcript
   in `ConfigRoot.projects_dir` (first 64 KB only, `api-request*` lines skipped, cached by
   path + size + mtime). No other source in Phase 3.
4. Project identity: absolute, separators unified, trailing separator dropped, case-folded
   on Windows only; display the spelling seen most recently.
5. A project whose `.claude` equals `<root>` (Will's home) contributes only its root files
   (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.mcp.json`) and its local MCP entries;
   its `.claude/` is user scope, never listed twice.
6. Paths containing `/.claude/worktrees/` are agent worktrees: hidden by default, counted
   under their parent project.
7. Missing project folders go in a collapsed "No longer on disk" group with their local MCP
   entries (still in `<cj>`); no file items.
8. A project appears in the project picker when it exists and has at least one item or a
   local MCP entry; the rest are counted ("N folders with no Claude files").
9. Auto-memory folder -> project: by the `cwd` of transcripts in the same encoded folder;
   if none remain, by encoding each known project path with the same lossy rule
   (non-alphanumeric -> `-`); unmatched folders show "Unknown project".
10. `ItemId = "<kind>:<fnv1a64(normalised path + '#' + json pointer)>"`, stable across
    runs (Phase 5 `read_item(id)` reuses it); no new hashing dependency.
11. Frontmatter: strip BOM, LF/CRLF fences, a maintained YAML crate (not `serde_yaml`,
    archived); invalid YAML still lists the item with "Frontmatter can't be read" + the
    error line; unknown keys kept and shown in the detail.
12. Card reads cap at 16 KB per file; widen to 256 KB only if the closing fence is not
    found.
13. JSON: `serde_json` with `preserve_order`; a parse failure lists the file with "Can't
    read this file" + position; a `<cj>` parse failure retries once after 100 ms, then
    keeps the last good snapshot with a quiet banner.
14. Shadowing order (re-check the docs pages at build time; docs win, the builder logs any
    difference):
    - Skills: managed > user > project; plugin skills are namespaced (`plugin:skill`) and
      synced skills by their source, so neither clashes.
    - Agents (by frontmatter `name`): managed > project > user > plugin.
    - Command vs skill with the same name: the skill wins.
    - Commands user vs project, output styles user vs project: "Conflict", no winner
      (docs state none).
    - MCP: local > project > user > plugin; the winner's whole entry, no field merge.
    - Settings scalars: managed > local > project > user, effective value + source in the
      Settings detail; arrays merge (no conflict).
    - Same name twice in one scope: "Duplicate", no winner.
    - CLAUDE.md, rules, hooks, permission rules: additive, never conflicts.
15. Effective settings for enabled state are computed per project (managed > project local
    > project > user); the Global view uses user + managed.
16. Secrets: values under `env` and `headers` (settings, MCP entries, `.mcp.json`) are
    masked in cards and the viewer; masking happens in core, the real value never crosses
    IPC; key names stay visible.
17. The viewer gets text from one core function that re-applies the deny list (a forged
    `ItemId` cannot open `.credentials.json`), caps at 1 MB and returns
    `{text, language, truncated, maskedRanges}`.
18. `.mcp.json` `${VAR}` / `${VAR:-default}` shown unexpanded.
19. Symlinks followed for reading with a canonical-path cycle guard; card shows
    "link -> target".
20. `.bak-*`, `*.bak`, `*~` are never items; they list under Other files as "backup copy".
21. Files opened read-only, read whole, closed at once; no handle kept (Rust std's Windows
    share mode lets Claude Code rename meanwhile).
22. Watcher: `notify` + debouncer (250 ms) in `core::setup::watch`; watches `<root>`
    recursively, `<cj>`'s folder non-recursively, each listed project's `.claude/`
    recursively and its root non-recursively, and `managed_dir` if present. Denied paths
    and `projects/**/*.jsonl` events are dropped. A `<cj>` change emits only when the hash
    of its MCP-relevant subtrees changes (`mcpServers`, `projects[*].{mcpServers,
    disabledMcpServers, enabledMcpServers, enabledMcpjsonServers,
    disabledMcpjsonServers}`, the set of project keys). Overflow or error -> one full
    rescan.
23. Refresh = full re-walk with a per-file (path, size, mtime) parse cache; no partial
    merge logic; shadowing recomputed every snapshot.
24. The watcher is rebuilt whenever the active `ConfigRoot` changes (sandbox on/off,
    folder chosen in Settings); a missing `<root>` is watched via its parent.
25. IPC: `setup_snapshot() -> SetupSnapshot` (no file bodies), `setup_read_source(id) ->
    SourceView`, event `atlas://setup-changed {version}`; the front end pulls.
26. Discovery starts after `frontend_ready`, on a background thread; never before first
    paint, never on the UI thread.
27. Sandbox Mode: `<root>` items come from the copy; project items are the real project
    files (the sandbox does not copy them); their cards say "Real project file".
28. The skip lists in `sandbox.rs` move to one shared module (`core::layout`) used by
    sandbox and setup; sandbox behaviour and its tests stay byte-identical.
29. No virtualisation library; `content-visibility: auto` on rows; add one only if the
    search budget fails.
30. CodeMirror colours come from new `--syntax-*` tokens in `src/styles/tokens.css`
    (light + dark), never hard-coded hex.
31. New fixture root `fixtures/pc/` from a new `setup()` in
    `tools/make-fixtures.py`; `basic` and `edge` unchanged.
32. Fixture project paths use the placeholder `@ROOT@`; tests copy the fixture to a temp
    dir and substitute the temp path (JSON-escaped) before discovery; tests never write
    under `fixtures/`.
---

## Setup page (UI)
- Inside the existing shell: group rail (left, 220 px) · item list · detail sheet (right,
  480 px, radius 14, slides 200 ms ease-out; fade under reduce motion).
- Group rail, each with a count badge: Skills · Agents · Commands · Hooks · Instructions ·
  Rules · Settings · Permissions · MCP Servers · Plugins · Output Styles · Status Line ·
  Memory (auto + agent memory) · Workflows · Keybindings & Themes · Other files. Empty
  groups stay visible, dimmed, with a topo empty state.
- Top bar: scope control `All · Global · Project` + project picker (most recent transcript
  activity first; worktrees and missing folders collapsed); search field (Ctrl/Cmd+F;
  name, description, path).
- Card: name (14, semibold), kind icon, scope chip (`Global`, `Project · <name>`,
  `Local · <name>`, `Plugin · <name>`, `claude.ai`, `Managed`), one-line description
  (truncated; full in tooltip), source path (mono 12, middle-truncated), enabled chip,
  last modified (relative; absolute in tooltip), conflict chip ("Overrides Global" /
  "Overridden by Project · app" / "Conflict" / "Duplicate").
- Detail sheet: header (name, kind, scope, path, size, line endings, BOM, modified),
  frontmatter table (unknown keys included), "Defined in" list for conflicts (winner
  first), per-project enabled matrix for MCP, attachments for skills, "Used by" for hook
  scripts, then the read-only CodeMirror view (md + YAML frontmatter, json, js/ts, sh,
  ps1, py; plain text otherwise).
- Keyboard: Up/Down move, Enter opens, Esc closes, Ctrl/Cmd+C copies the path; visible
  focus ring everywhere; every chip has an accessible label.
- States: loading skeleton (1 frame), empty group, unreadable file, `<root>` missing,
  `<cj>` mid-write banner, Sandbox note on project items.

---

## Acceptance criteria
Run from the Atlas root. "Fixture" = `fixtures/pc` materialised into a temp dir.
Rust tests live in `crates/core/tests/setup_*.rs` unless named.

Discovery and parsing
1. `cargo test -p atlas-core --test setup_fixtures` passes; it asserts the exact item
   count per (kind, scope) for the fixture (table kept in the test).
2. Every kind in the table above has at least one fixture item at every scope the table
   lists for it (user, project, local, plugin, synced, managed, other).
3. A skill folder's extra files are attachments of that skill, not Other files.
4. A skill with no frontmatter `name` takes its folder name; an agent with no `name` takes
   its file stem and carries a warning.
5. `broken-yaml/SKILL.md` lists with "Frontmatter can't be read" + the YAML error line;
   discovery does not fail.
6. CRLF + BOM fixture files parse to the same name/description as their LF twins.
7. `commands/nested/deploy/prod.md` is named `nested:deploy:prod`.
8. Each hook handler is one item (event, matcher, type, command head); a hook naming an
   existing script links to it, and that script shows "Used by 1".
9. `calm.md` with `name: Calm Notes` is Active when settings say
   `"outputStyle": "Calm Notes"`.
10. A `skillOverrides` value shows as that skill's enabled chip, raw value preserved.
11. `fixture-plugin@fixture-market` lists its skill, agent, command, hooks and MCP server
    as Plugin items; with `enabledPlugins` false they all read Off.
12. Synced skills come from `skills/synced/<bucket>/`; nothing under `.bucket-*` lists;
    `manifest.json` is not an item.
13. `<p>/CLAUDE.md`, `<p>/.claude/CLAUDE.md`, `<p>/CLAUDE.local.md`, `<p>/AGENTS.md` and
    `<root>/CLAUDE.md` all list, none flagged as a conflict.
14. Unknown files under `<root>` and `<p>/.claude/` (`launch.json`, `reference/notes.md`)
    list as Other; `.bak-*` files list as Other "backup copy", never as agents/skills.

MCP and `.claude.json`
15. MCP items exist at user, local, project, plugin and managed scope; `shared-srv`
    (local + project + user) shows local as winner and the other two "Overridden".
16. `user-srv` in `projects[app].disabledMcpServers` reads Off for `app`, On elsewhere,
    and "On in N of M projects" on its card.
17. `.mcp.json` servers read Approved / Rejected / Pending from the `.claude.json` and
    settings approval keys; `${VAR}` stays unexpanded.
18. Default resolution reads `home/.claude.json` (`user-srv` present, `decoy-srv`
    absent); resolution with `env = home/.claude` reads `home/.claude/.claude.json`
    (`decoy-srv` present, `user-srv` absent). `env` goes through `ConfigInputs`, never
    `std::env::set_var`.
19. The two spellings of the app key (`@ROOT@/work/app` and its backslash/upper-case twin)
    collapse to one project (`#[cfg(windows)]` assertion); both entries' local MCP
    servers are kept.

Projects
20. A project known only from a transcript `cwd` (`work/transcript-only`) appears with its
    items.
21. The home-as-project entry adds only `home/CLAUDE.md`; zero duplicate `ItemId`s and zero
    Project-scope items whose path is under `<root>`.
22. `work/app/.claude/worktrees/agent-x` is not a project; its `CLAUDE.md` is not listed.
23. `work/gone` sits in "No longer on disk" with its local MCP entry and no file items;
    `work/empty-proj` is counted, not listed.
24. `projects/<encoding of work/gone>/memory/` (no transcripts) maps to `work/gone`.

Conflicts
25. `shared-skill` (user + project) marks the documented winner; `same-as-skill` marks
    the skill over the command; `dup-a.md` + `dup-b.md` (both `name: dup`) show
    "Duplicate"; `shared-cmd` user vs project shows "Conflict", no winner. A unit test
    holds the order table and cites the docs pages + date checked.

Safety (read only)
26. `setup_fixtures` snapshots every byte of `fixtures/` before and after discovery, a
    watcher session and every `setup_read_source` call: identical.
27. `cargo test -p atlas-core --test setup_readonly` scans the text of
    `crates/core/src/setup/**` and fails on any of `fs::write`, `File::create`,
    `OpenOptions`, `rename`, `remove_file`, `remove_dir`, `create_dir`, `fs::copy`,
    `atomic_write`, `set_permissions`, `Command::new`.
28. No item, snapshot field or source view holds a `.credentials.json`, `sessions/`,
    `history.jsonl` or `*.key` path; `setup_read_source` with a forged id for
    `.credentials.json` returns an error.
29. `FIXTURE-PLACEHOLDER` (every fixture env/header/token value) appears nowhere in the
    serialised snapshot or any `SourceView.text`; the key names (`SECRET_TOKEN`,
    `Authorization`) do.
30. `fsutil::check_write_allowed` is untouched and all Phase 1 tests still pass:
    `cargo test -p atlas-core` green.

Performance
31. `cargo test -p atlas-core --release --test setup_real -- --ignored --nocapture` on
    Will's machine prints `SETUP_DISCOVERY first_ms=.. p50_ms=.. p95_ms=.. items=..
    projects=.. bytes=..` within budget; it only reads and prints counts, never names or
    values.
32. The app log prints `setup: discovery <ms> ms, <items> items, <projects> projects`
    after `frontend_ready`; Phase 1's first-paint log value is no worse than before
    Phase 3 (median of 3 launches each).

Live refresh
33. Fixture watch test: create `skills/new-one/SKILL.md` -> a snapshot with it within 1 s;
    edit its description -> updated within 1 s; delete the folder -> gone within 1 s.
34. Rewriting `<cj>` with only `numStartups` changed emits nothing; adding a user MCP
    server emits once and the item appears.
35. Switching the active root (two fixture roots) rebuilds the watcher: events from the
    old root stop arriving.

Front end
36. `npm test` passes, including `src/pages/Setup.test.tsx` on the mock snapshot: group
    counts, scope filter (All / Global / one project), search narrowing, conflict chips,
    Enter opens and Esc closes the sheet, the viewer is read-only (typing changes nothing;
    `EditorState.readOnly` true).
37. `npm run typecheck` and `npm run build` pass; a Rust test serialises a sample
    `SetupSnapshot` / `SourceView` and a Vitest test parses it against `types.ts` field
    names.
38. Screenshots in `docs/shots/phase3/`: Setup page on the fixture (`--config-dir`), light
    and dark, 100 % and 150 % DPI; sheet open on a skill and on an MCP server (masked env
    visible as dots); an empty group.
39. Screenshot of Setup on Will's real config (default root, read-only) showing real
    counts; no env or header value visible.
40. `[Will]` The Setup page reads calm and clear on his own setup; cards, chips and viewer
    feel right in light and dark.
41. `[Will]` The counts per group match what he expects of his setup.

---

## Performance budgets
- Measured baseline (Python, Will's machine, warm): `<cj>` parse 0.7 ms; walk 765 files
  25 ms; stat + 4 KB head of 423 `.md` 42 ms; cwd probe of 373 transcripts 37 ms; about
  105 ms total. Rust release must beat it.

| Metric | Budget | Measured by |
|---|---|---|
| Full discovery, real setup, release, warm | p50 <= 120 ms, p95 <= 200 ms | criterion 31 |
| First discovery in a fresh process | <= 400 ms | criterion 31 `first_ms` |
| File saved -> card updated on screen | <= 600 ms (250 ms debounce + <= 150 ms rescan + render) | criterion 33 + log timestamps |
| Setup page interactive after navigation (snapshot in memory) | <= 100 ms | app log |
| Search keystroke -> list updated, real item count | <= 16 ms | React Profiler, noted in MEMORY |
| Detail open, file <= 256 KB | <= 100 ms to highlighted text | log line |
| Source size cap | 1 MB, rest truncated with a banner | test in `setup_fixtures` |
| Snapshot IPC payload | <= 1 MB | criterion 31 `bytes` |
| Watcher idle CPU, Claude Code idle | < 0.5 % over 60 s | `Get-Process` CPU delta |
| First paint (Phase 1 contract) | unchanged, < 1 s | criterion 32 |
---

## Fixture additions (`fixtures/pc/`, from `tools/make-fixtures.py setup()`)
- Every secret-looking value is `FIXTURE-PLACEHOLDER`, every text `[fixture ...]`; the
  existing "no real secrets" test covers the new root.
- `home/.claude.json` (LF): top `mcpServers` `user-srv` (stdio, `env.SECRET_TOKEN`),
  `shared-srv` (stdio), `http-srv` (http, `headers.Authorization`); `projects` keys
  `@ROOT@/home`, `@ROOT@/work/app`, the Windows twin `@ROOT@\WORK\app`,
  `@ROOT@/work/empty-proj`, `@ROOT@/work/gone`, `@ROOT@/work/app/.claude/worktrees/agent-x`.
  `app`: local `shared-srv` + `local-only`, `disabledMcpServers: ["user-srv"]`,
  `enabledMcpjsonServers`, `disabledMcpjsonServers`. `gone`: one local server.
- `home/CLAUDE.md` (home-as-project root file).
- `home/.claude/` (user root):
  - Skills: `shared-skill/` (+ `scripts/run.py`), `user-only/`, `no-name-skill/`,
    `broken-yaml/`, `same-as-skill/`, `crlf-skill/` (CRLF + BOM) and an LF twin.
  - Synced: `skills/synced/o_u/{manifest.json,
    syn/SKILL.md}`; `skills/synced/.bucket-x/i/SKILL.md`.
  - Agents: `shared-agent.md` (CRLF), `user-agent.md`, `no-name-agent.md`, `dup-a.md` +
    `dup-b.md` (both `name: dup`), `user-agent.md.bak-20261001`.
  - Commands: `shared-cmd.md`, `same-as-skill.md`, `nested/deploy/prod.md`.
  - `hooks/fmt.sh`; `statusline.sh`; `settings.json` with hooks on 2 events (one naming
    `@ROOT@/home/.claude/hooks/fmt.sh`), `statusLine` naming `statusline.sh`,
    `skillOverrides {"user-only": "user-invocable-only"}`, `outputStyle: "Calm Notes"`,
    `enabledPlugins {"fixture-plugin@fixture-market": true}`, `permissions`
    allow/deny/ask, `env.SECRET_TOKEN`; `settings.local.json` with one allow rule.
  - `rules/always.md` (no frontmatter), `rules/ts-only.md` (`paths`).
  - `output-styles/calm.md` (`name: Calm Notes`).
  - `workflows/nightly.js`, `agent-memory/user-agent/notes.md`, `keybindings.json`,
    `themes/warm.json` (shapes marked "assumed, verify at build time" in the generator).
  - Plugins: `plugins/installed_plugins.json`, `plugins/known_marketplaces.json`,
    `@ROOT@/plugin/` (outside the config folder so paths stay short; `installPath` points there): `{.claude-plugin/plugin.json` (with
    `mcpServers`), `skills/plug-skill/SKILL.md`, `agents/plug-agent.md`,
    `commands/plug-cmd.md`, `hooks/hooks.json}`.
  - Transcripts: `projects/-enc-app/s1.jsonl` (cwd `@ROOT@/work/app`; first line
    an `api-request` to prove it is skipped), `projects/-enc-t-only/s2.jsonl`
    (cwd `@ROOT@/work/transcript-only`), `projects/-enc-app/memory/MEMORY.md`, and a
    `memory/notes.md` in the folder named by encoding `@ROOT@/work/gone` (made at
    materialise time; no transcript).
  - Never shown: `.credentials.json`, `sessions/x.key`, `history.jsonl`, `backups/`,
    `cache/`, `daemon.lock`.
  - Other: `MEMORY.md`, `reference/notes.md`, `policy-limits.json`.
  - Decoy: `home/.claude/.claude.json` with `mcpServers.decoy-srv` (criterion 18).
- `work/app/`: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.mcp.json` (`shared-srv`,
  `proj-srv` with `${PROJ_TOKEN}`, `rejected-srv`), `.claude/{settings.json`
  (`outputStyle` override, a deny rule), `settings.local.json`,
  `skills/shared-skill/SKILL.md`, `agents/shared-agent.md`, `commands/shared-cmd.md`,
  `rules/r.md`, `output-styles/proj-style.md`, `agent-memory/shared-agent/m.md`,
  `launch.json`, `worktrees/agent-x/CLAUDE.md}`.
- `work/dotclaude-only/.claude/CLAUDE.md`; `work/transcript-only/.claude/agents/t.md`;
  `work/empty-proj/.gitkeep`.
- `managed/managed-settings.json` (a deny rule, `disableAllHooks: false`) and
  `managed/managed-mcp.json` (`managed-srv`), passed as `managed_dir`.
- Regression on unchanged `basic` / `edge`: discovery finds
  `code-reviewer`, `commit-helper`, `standup`, `terse`, `testing`, `lane-agent`,
  `crlf-skill`, `nested:deploy:prod`, `fixture-notes`, `fixture-local`, and lists
  `unknown-dir/notes.txt` and `café ☃/readme.txt` as Other.

---

## File table

| File | New / change | What |
|---|---|---|
| `crates/core/Cargo.toml` | change | a maintained YAML crate; `notify` + debouncer |
| `crates/core/src/lib.rs` | change | `pub mod layout; pub mod setup;` |
| `crates/core/src/layout.rs` | new | shared deny/bulk lists (moved from `sandbox.rs`), `is_denied(rel)` |
| `crates/core/src/sandbox.rs` | change | imports lists from `layout`; behaviour identical |
| `crates/core/src/setup/mod.rs` | new | `DiscoveryInputs`, `discover() -> SetupSnapshot` |
| `crates/core/src/setup/model.rs` | new | `ItemKind`, `Scope`, `SetupItem`, `EnabledState`, `ItemId`, `Conflict`, `Project` (serde camelCase) |
| `crates/core/src/setup/frontmatter.rs` | new | fences (BOM/CRLF), YAML, description extraction |
| `crates/core/src/setup/projects.rs` | new | project sources, normalisation, worktree/home/missing, cwd probe, memory mapping |
| `crates/core/src/setup/claude_json.rs` | new | read-only `<cj>` view: user/local MCP, per-project MCP state, subtree hash |
| `crates/core/src/setup/files.rs` | new | markdown/raw kinds: skills, synced, agents, commands, rules, output styles, instructions, memory, agent memory, workflows, keybindings, themes, other |
| `crates/core/src/setup/settings_items.rs` | new | settings, hooks, hook scripts, permissions, status line, effective values |
| `crates/core/src/setup/mcp.rs` | new | all MCP scopes, enabled matrix, `.mcp.json` approval |
| `crates/core/src/setup/plugins.rs` | new | installed plugins + their child items |
| `crates/core/src/setup/shadow.rs` | new | precedence table, conflict marking |
| `crates/core/src/setup/source.rs` | new | `read_source(id)`: deny list, 1 MB cap, masking, language |
| `crates/core/src/setup/watch.rs` | new | watcher, filters, `<cj>` subtree diff, rebuild on root change |
| `crates/core/tests/setup_fixtures.rs` | new | criteria 1-26, 28-29, 33-35 |
| `crates/core/tests/setup_readonly.rs` | new | criterion 27 |
| `crates/core/tests/setup_real.rs` | new | criterion 31 (`#[ignore]`, read-only) |
| `crates/app/src/commands.rs` | change | `setup_snapshot`, `setup_read_source` |
| `crates/app/src/state.rs` | change | snapshot cache, watcher lifecycle per active root, `atlas://setup-changed` |
| `crates/app/src/main.rs` | change | register commands; discovery after `frontend_ready` |
| `tools/make-fixtures.py` | change | new `setup()`; `basic()` / `edge()` untouched |
| `fixtures/pc/**` | new | generated tree above |
| `package.json` | change | `@codemirror/{state,view,language,lang-markdown,lang-json,lang-javascript,lang-yaml,lang-python,legacy-modes}` |
| `src/lib/types.ts` | change | `SetupSnapshot`, `SetupItem`, `SourceView`, enums |
| `src/lib/ipc.ts` | change | `setupSnapshot()`, `readSource(id)`, `onSetupChanged(cb)` |
| `src/lib/mock.ts` | change | mock snapshot shaped like the fixture |
| `src/lib/codemirror.ts` | new | read-only editor factory, language by extension, token theme, mask decorations |
| `src/pages/Setup.tsx` | new | the page |
| `src/pages/Placeholders.tsx`, `src/App.tsx` | change | route `setup` to the new page; drop the placeholder |
| `src/components/setup/{GroupRail,ScopeBar,ItemList,ItemCard,DetailSheet,SourceViewer}.tsx` | new | UI pieces |
| `src/pages/Setup.test.tsx` | new | criterion 36 |
| `src/styles/tokens.css` | change | `--syntax-*` tokens, light + dark |
| `docs/shots/phase3/*.png` | new | criteria 38-39 |
| `MEMORY.md` | append | outcome, measured timings, docs-checked precedence |

---

## Risk-floor flags
- Credentials/tokens: the viewer and MCP/settings display handle `env`/`headers` values and
  sit next to `.credentials.json` and `sessions/*.key` -> **risk floor**: opus
  code-reviewer with the security checklist on `setup/source.rs`, `layout.rs`, masking and
  the IPC surface.
- Will's live config: read-only, but Atlas now reads and watches `~/.claude` and
  `~/.claude.json` while Claude Code writes them; review checks no handle is held and no
  write API is reachable (criteria 26-27).
- Gate list: none (no deploy, money, Pace, messages, deletes outside the project).

## Suggested agent chain
1. `desktop-app-dev`: `layout`, `setup/*`, fixture generator + fixtures, core tests
   (criteria 1-35).
2. `ui-builder`, once `model.rs` types land: IPC, Setup page, CodeMirror viewer, Vitest,
   screenshots (36-39). Same repo: sequential, or a worktree.
3. `verify-auditor`: plant a write call in `setup/` and an unmasked secret; 27 and 29 must
   fail.
4. `code-reviewer` (opus, security checklist) ∥ `verifier` (every criterion, the
   real-config bench, screenshots).
5. Will: 40-41.

## Done when
- Criteria 1-39 pass with evidence (command output, log lines, screenshot paths) on
  Windows; the fixture tests also pass in the macOS CI job.
- code-reviewer and verifier both pass; verify-auditor shows 27 and 29 can fail.
- A build Will can run shows his real Setup read-only and live, with no secret value on
  screen.
- `MEMORY.md` holds the measured timings and the docs-checked precedence table.
- Will signs off 40-41.

## Open questions (for Will)
1. Secret values (`env`, `headers`): always masked (this spec), or masked with a "Show"
   click?
2. Agent worktree folders (`.claude/worktrees/*`): hidden and counted under the parent
   project (this spec), or shown?
3. Project folders gone from disk (16 of 50 keys on Will's machine): collapsed "No longer
   on disk" group (this spec), or hidden?
4. Permissions: one row per rule (about 250 in Will's user settings) (this spec), or one
   row per settings file with counts?
5. claude.ai connectors and claude.ai-synced plugin servers exist on disk only as names in
   `mcp-needs-auth-cache.json`: list as name-only rows, or leave out (this spec)?
6. Synced claude.ai skills: own "claude.ai" scope (this spec); which prefix to display
   (`anthropic-skills:` in sessions; the manifest has `source` and `backingPluginId`,
   meaning unconfirmed)?
7. `.bak-*` copies: Other files tagged "backup copy" (this spec), or hidden?
8. Add `.claude.json` `githubRepoPaths` as a third project source?