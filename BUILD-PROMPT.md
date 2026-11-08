# Atlas build prompt (from Will, 2026-11-08)

> Will: "setup a new folder on my pc for an application called Atlas". The prompt below
> was written for an app called "Basecamp"; **the app is Atlas**. Read every "Basecamp"
> as "Atlas" (name, MCP server, app data dir, branding). The mountain/campfire icon motif
> was chosen for "Basecamp"; the Atlas icon motif is an open decision for Will.

---

# Build Prompt: "Basecamp", a desktop companion app for Claude power users

> Paste everything below into Claude Code, run from an empty folder. Recommended: start in plan mode, review the plan, then let it build phase by phase.

---

## Your role and the mission

You are a senior desktop-app engineer and product designer. Build **Basecamp**, a polished, cross-platform (macOS + Windows) desktop app that gives one person total visibility and control over everything Claude on their machine: **usage and costs**, and **every file in their Claude Code setup** (skills, agents, commands, hooks, settings, MCP servers, CLAUDE.md).

This app is a **Christmas gift for my dad**, a lifelong Apple fan and heavy Claude Code user. It must feel premium, calm and native: something that looks like Apple or Linear designed it, not a weekend hackathon project. Reliability matters more than feature count: **it must never corrupt or lose his configuration.**

Work in phases (below). At the end of each phase: run the app, run the tests, fix what's broken, commit, and give me a short summary of what to test by hand. Ask me before making any decision that's expensive to reverse.

---

## Ground rules (read first)

1. **Verify before you build.** Claude Code's file layout, log format, settings schema and MCP config can change between versions. Before writing parsers, inspect a real `~/.claude` (read-only) and the current Claude Code docs, and adapt this spec to what's actually there. If the spec and reality disagree, reality wins: tell me what you changed.
2. **Never write to the real `~/.claude` or `~/.claude.json` during development or tests.** All tests use fixture folders. The app supports a `--config-dir <path>` flag and a **Sandbox Mode** toggle (copies the real config to a temp folder and works on the copy) so I can test safely on my own machine.
3. **Respect `CLAUDE_CONFIG_DIR`.** If that env var is set, use it instead of `~/.claude`.
4. **Every write is atomic and backed up first** (see Safety). No exceptions, including writes made by Claude through MCP.
5. **Read-only by default for anything you don't understand.** Unknown files appear in an "Other files" list and can be opened and edited, but never auto-modified.
6. **Cross-platform paths:** `~` = `$HOME` on macOS, `%USERPROFILE%` on Windows. Handle spaces, Unicode and long paths. Never hardcode `/` separators.

---

## Tech stack (use this unless you find a blocking reason not to; ask first)

- **Tauri 2** desktop shell (small, fast, native webview on both OSes)
- **Rust** backend in a Cargo workspace:
  - `crates/core`: all file discovery, parsing, editing, backups, usage aggregation (shared logic, no UI)
  - `crates/app`: Tauri app; exposes `core` to the frontend via Tauri commands
  - `crates/mcp`: standalone **MCP server binary** (stdio) built on the official Rust MCP SDK (`rmcp`), reusing `core`. Shipped as a Tauri sidecar.
- **Frontend:** React + TypeScript + Vite + Tailwind CSS, Radix UI primitives, Framer Motion for animation, Recharts (or visx) for charts, CodeMirror 6 for the editor (Markdown, JSON, YAML, shell, Python, JS highlighting)
- **File watching:** `notify` crate for live refresh when files change on disk
- **Secrets:** OS keychain via the `keyring` crate (macOS Keychain / Windows Credential Manager). Never store API keys in plain files.
- **Tests:** `cargo test` for core (with fixture dirs), Vitest + Testing Library for UI, and one Playwright smoke test if feasible

---

## Data sources (verify each against reality first)

### A. Claude Code usage logs
- Location: `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl`
- Each line is a JSON event. Assistant messages typically include `message.model`, `message.usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), `timestamp`, `sessionId`, `cwd`, and message/request IDs.
- **Deduplicate** by message ID + request ID (the same usage can appear more than once). Skip malformed lines gracefully; never crash on a bad file.
- Parse incrementally and cache results (e.g. SQLite in the app data dir, keyed by file path + size + mtime) so startup stays fast even with thousands of sessions.
- Derive: per-message, per-session, per-project, per-day/week/month, per-model totals.

### B. Cost estimates ("API-equivalent cost")
- Use a **pricing table** stored as editable JSON in the app's settings (per model: input, output, cache write, cache read, per million tokens).
- Seed it with **current official Anthropic API prices you look up from docs.claude.com at build time**, and show a "Prices last updated: <date>" note plus an "Edit prices" screen.
- Unknown models: show tokens, mark cost as "unknown model" (don't guess).
- Always label these as **estimates**, since subscription users don't pay per token.

### C. Real API spend (optional)
- If he adds an **Anthropic Admin API key** (stored in keychain), pull real usage and cost from Anthropic's Usage & Cost Admin API and show it in a separate "API account" view. Fully optional; the app works without it.

### D. Claude Code configuration (the "Setup" area)
Discover all of these, both **global** (`~/.claude/…`) and **per-project** (any `.claude/` folder inside projects he's worked in, found via the `cwd` values in session logs):

| Item | Typical location |
|---|---|
| Skills | `skills/<name>/SKILL.md` (+ any supporting files in that folder) |
| Subagents | `agents/*.md` (frontmatter: name, description, tools, model) |
| Slash commands | `commands/**/*.md` |
| Hooks | defined in `settings.json` → `hooks`; scripts often in `hooks/` |
| Global instructions | `CLAUDE.md` |
| Settings & permissions | `settings.json`, `settings.local.json` |
| MCP servers (user scope) | **`~/.claude.json` → `mcpServers`** (note: outside the `.claude` folder) |
| MCP servers (project scope) | `<project>/.mcp.json` |
| Plugins | `plugins/` |
| Output styles | `output-styles/` |
| Everything else | listed under "Other files" |

**Critical: `~/.claude.json` is large and Claude Code writes to it constantly.** Only ever modify the specific key you need (`mcpServers`), via read → modify → atomic write, re-reading immediately before writing. Preserve every other key exactly. Warn the user if Claude Code appears to be running when making MCP config changes.

### E. Other Claude surfaces
claude.ai chat / desktop / other Claude apps don't store token data locally. Don't fake it. Provide a "Quick Links" panel (open claude.ai, usage settings, Console, docs) instead.

---

## Features

### 1. Home / Dashboard
- Hero stats: tokens today, this week, this month; estimated cost for each; sessions today
- Usage over time chart (toggle tokens ↔ cost; day / week / month)
- Breakdown by model (donut) and by project (ranked bars)
- Calendar heatmap of activity (GitHub-style, full year)
- "Recent sessions" list → click to open Session Detail

### 2. Sessions
- Searchable, sortable table: date, project, duration, model(s), tokens (in / out / cache), est. cost
- **Full-text search** across all past sessions' messages
- Session Detail: token timeline, message list with readable transcript, cost breakdown, "Open project folder" button

### 3. Setup (the core of the gift)
- Left sidebar groups: **Skills · Agents · Commands · Hooks · CLAUDE.md · Settings · MCP Servers · Plugins · Output Styles · Other files**, each with a count badge and a Global / Project scope filter
- Each item shows a friendly card: name, description (parsed from frontmatter), scope, last modified, "Edited by Claude" badge if applicable
- **Full CRUD on every item:**
  - **Open / Edit:** CodeMirror editor with syntax highlighting, Markdown live preview (split view), frontmatter form helper for skills/agents/commands, validation (e.g. invalid YAML frontmatter or JSON shows inline errors and blocks save)
  - **New:** "New Skill / Agent / Command / Hook" buttons with clean starter templates that match Claude Code's current format
  - **Rename / Duplicate / Delete** (delete moves to OS trash, never permanent)
  - **Reveal in Finder / Explorer**
- **Settings** shown as a friendly form (permissions, model, env vars) with a "Raw JSON" tab. Preserve unknown keys and key order.
- **Hooks:** list by event, toggle on/off, edit the command, open the script file
- **MCP Servers:** list global + project servers, add (form for command/args/env or URL), edit, remove, enable/disable, with a "Test connection" button that launches it and lists its tools

### 4. Built-in Claude assistant
- A chat panel (slide-over from the right, ⌘K / Ctrl+K to open) where he can type things like "make me a skill that summarizes my git commits each morning".
- Implementation: run the local `claude` CLI headlessly (`claude -p … --output-format stream-json`), connected to Basecamp's own MCP server, with a system prompt describing the Setup structure. Stream responses into the panel.
- **All changes proposed by the in-app assistant go into a "Pending changes" queue** showing a side-by-side diff. Nothing is applied until he clicks **Approve** (or Approve all / Reject).
- If `claude` isn't installed or logged in, show a friendly setup message instead of an error.

### 5. Basecamp MCP server (so Claude Code can manage it too)
- Standalone stdio binary (`crates/mcp`) shipped with the app.
- One-click **"Connect to Claude Code"** button in the app that registers the server at user scope (via `claude mcp add` if available, otherwise the safe `~/.claude.json` edit described above), and a "Disconnect" button.
- Tools (clear names, JSON-schema inputs, helpful descriptions):
  - `list_items(kind?, scope?)` → skills, agents, commands, hooks, mcp servers, etc.
  - `read_item(id)`
  - `create_item(kind, scope, name, content)`
  - `update_item(id, content)`
  - `rename_item(id, new_name)`
  - `delete_item(id)` (to trash)
  - `toggle_hook(id, enabled)` / `toggle_mcp_server(id, enabled)`
  - `get_usage_summary(range)` → token & cost summary
  - `list_backups(id?)` / `restore_backup(backup_id)`
- Every MCP write goes through the same backup + atomic-write path and is tagged "Edited by Claude" in the app's change history. The app updates live (file watcher).

### 6. Claude Wrapped 2026 🎁
- A full-screen, animated, Spotify-Wrapped-style story (5–8 slides, tap/arrow to advance):
  total tokens; total sessions; busiest day; longest session; top 3 projects; favorite model; most-used skill/agent/command (if detectable from logs); late-night vs. morning coder; a fun closing card.
- A **"First launch" flag**: the very first time the app opens, show a "Merry Christmas, Dad 🎄" intro card, then play Wrapped. (Make the intro message editable in a config file so I can personalize it.)
- "Export as image" for sharing.

### 7. Menu bar / tray + widgets
- macOS menu bar icon / Windows tray icon showing today's tokens and est. cost, with a mini popover (today, this week, last session, "Open Basecamp")
- **Spend alerts:** notify when daily est. cost passes a threshold he sets

### 8. History, Backups & Undo
- Before any write, snapshot the previous version into the app data dir (`<appdata>/basecamp/backups/…`) with an index (file, timestamp, source: user / assistant / MCP, short description).
- "History" screen: timeline of all changes, diff viewer, one-click **Restore**.
- Global **Undo** (⌘Z / Ctrl+Z) for the last applied change.
- Backups exclude the large `projects/` logs folder. Auto-prune to the last N versions per file (default 50; configurable).

### 9. App Settings
- Config dir override, Sandbox Mode toggle, pricing table editor, alert thresholds, Admin API key, theme (System / Light / Dark), launch at login, MCP connect/disconnect, "Export diagnostics" button.

---

## Design language ("beautiful" is a requirement, not a nice-to-have)

- **Feel:** calm, warm, premium, native. Reference points: Apple's macOS apps, Linear, Raycast, Things 3.
- **Layout:** left sidebar navigation (Dashboard, Sessions, Setup, History, Wrapped, Settings), generous whitespace, content max-width with breathing room, 8-pt spacing grid.
- **Color:** warm neutral palette (soft off-white / deep charcoal in dark mode) with a single **terracotta/clay accent** (≈ `#C96442`; tune for contrast). Charts use a restrained, accessible palette derived from the accent and neutrals. Full light + dark mode, following the OS by default.
- **Type:** system font stack (SF Pro on Mac, Segoe UI Variable on Windows); monospace (SF Mono / Cascadia Code) for code and numbers in tables. Use tabular numerals for stats.
- **Platform polish:** macOS: translucent vibrancy sidebar, traffic-light buttons inset into the title bar. Windows: Mica backdrop, native title bar controls. Respect each OS's keyboard conventions (⌘ vs Ctrl).
- **Motion:** subtle, fast (150–250 ms), springy where it adds delight (Wrapped, card hovers, panel slide-ins). Respect "reduce motion".
- **Empty, loading and error states** are designed, not afterthoughts: friendly copy, skeleton loaders, never raw stack traces.
- **Accessibility:** keyboard-navigable everything, visible focus rings, WCAG AA contrast, screen-reader labels.
- **Branding:** original app icon and name (Basecamp, a small mountain/campfire motif in the accent color). **Do not use Anthropic's or Claude's logos or trademarks** in the icon or UI artwork.

---

## Build phases

**Phase 0: Recon & plan.** Inspect a real `~/.claude` read-only plus current Claude Code docs. Report findings (actual file layout, log fields, settings schema, MCP config location). Produce the architecture + a list of any spec changes. Wait for my OK.

**Phase 1: Foundation.** Workspace, Tauri app shell, sidebar navigation, theming (light/dark), design tokens, fixture `~/.claude` folders for tests, `--config-dir` + Sandbox Mode.

**Phase 2: Usage engine + Dashboard + Sessions.** Incremental log parser with cache, dedup, pricing table, all dashboard charts, sessions table, search, session detail.

**Phase 3: Setup area (read).** Discovery of every item type, global + project scope, cards, viewers, file watcher live refresh.

**Phase 4: Setup area (write) + Safety.** Editor, create/rename/duplicate/delete, templates, validation, settings form, hooks & MCP server management, atomic writes, backups, History screen, Undo.

**Phase 5: MCP server.** `crates/mcp` binary with all tools, sidecar packaging, one-click Connect/Disconnect, live "Edited by Claude" updates. Test it end-to-end with Claude Code against a sandbox config.

**Phase 6: Built-in assistant.** Headless `claude` integration, streaming chat panel, Pending Changes diff queue with Approve/Reject.

**Phase 7: Wrapped + tray + alerts.** Wrapped story with first-launch Christmas intro, export image, menu bar/tray popover, spend alerts.

**Phase 8: Polish & ship.** Icon, onboarding (3 quick screens), empty/error states, performance pass (cold start < 2 s with 1,000+ sessions), accessibility pass, README with screenshots.

---

## Testing & packaging

- `cargo test` covers: log parsing (including malformed lines and duplicates), cost math, discovery of every item type, atomic write + backup + restore, `~/.claude.json` edits preserving all other keys byte-for-byte where possible.
- UI tests for: dashboard renders with fixture data, editing + saving a skill, delete → restore, pending-change approval flow.
- **Packaging:** `.dmg` (universal: Apple Silicon + Intel) for macOS and `.msi`/NSIS installer for Windows. Tauri can't cross-compile between them reliably, so also add a **GitHub Actions workflow** with a macOS + Windows build matrix that uploads both installers as artifacts.
- Note unsigned-build caveats (macOS Gatekeeper right-click → Open; Windows SmartScreen "More info → Run anyway") in the README, plus optional steps for code signing later.

---

## Definition of done

- [ ] Installs and runs on macOS and Windows
- [ ] Dashboard and Sessions show accurate tokens and estimated costs from real Claude Code logs
- [ ] Every skill, agent, command, hook, setting, MCP server, CLAUDE.md, plugin and output style is listed (global + project) and can be opened, edited, created, renamed, duplicated and deleted
- [ ] Claude Code can connect to the Basecamp MCP server with one click and manage the same items
- [ ] In-app assistant proposes changes as diffs that require approval
- [ ] Every change is backed up and restorable; `~/.claude.json` is never corrupted
- [ ] Wrapped 2026 plays on first launch with the Christmas intro
- [ ] Looks and feels premium in both light and dark mode on both OSes
- [ ] README explains install, Sandbox Mode, MCP connection and troubleshooting

Start with **Phase 0** now.
