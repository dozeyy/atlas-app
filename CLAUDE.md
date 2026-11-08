# Atlas

> Project-specific config. Global rules, identity, model + skill routing live in
> `~/.claude/` and the `Desktop Apps\CLAUDE.md` category file and load automatically;
> this file is ONLY what is unique to Atlas. Keep it lean. Long logs go in `./MEMORY.md`.
> The full original spec is `BUILD-PROMPT.md` (written as "Basecamp": read every
> "Basecamp" as "Atlas"). Phase 0 findings and the architecture: `docs/phase0-recon.md`
> (where it and the spec disagree, the recon wins).

## Type
application

## One-liner
A premium Tauri 2 desktop companion for Claude Code: usage and cost dashboard, a safe
manager for every file in the Claude Code setup, its own MCP server, an in-app assistant
whose changes wait for approval, a "Wrapped" year story, and a tray readout.

## Why
A Christmas 2026 gift for Will's dad: a lifelong Apple fan and heavy Claude Code user.
He gets total visibility and control over everything Claude on his machine, in an app
that feels calm and native. **It must never corrupt or lose his configuration.**
Reliability beats feature count.

## Target
- Platform: macOS (primary, dad's machine; universal Apple Silicon + Intel) and Windows
  11 (Will's dev machine). Built locally on Windows, macOS via GitHub Actions.
- Audience: one person (dad), a non-developer-tools-builder power user of Claude Code.

## Scope (v1) = spec phases 1-8
- Must-have: Dashboard + Sessions (usage, est. cost, search), Setup (every item type,
  global + project, full CRUD with backups), History/Undo, Atlas MCP server + one-click
  connect, in-app assistant with a Pending Changes diff queue, Wrapped 2026 with the
  first-launch Christmas intro, tray/menu-bar readout + spend alerts, Settings, Sandbox
  Mode, `--config-dir`.
- NOT in v1: claude.ai/desktop token data (not stored locally: Quick Links only), code
  signing/notarization (unless Will approves the cost), auto-update, cloud sync,
  editing managed (org) settings, plugin install/uninstall (list + toggle only).

## Safety invariants (non-negotiable)
- Never write the real `~/.claude`, `~/.claude.json` or `$CLAUDE_CONFIG_DIR` during
  development or tests. Tests use fixture dirs; manual testing uses Sandbox Mode or
  `--config-dir`.
- Config root = `$CLAUDE_CONFIG_DIR` if set, else `~/.claude`; the global config file is
  `<root>/.claude.json` when `CLAUDE_CONFIG_DIR` is set, else `~/.claude.json`.
- Every write: backup snapshot first, then atomic write (temp in the same dir, fsync,
  rename/ReplaceFile with retry), resolving symlinks to their target, preserving line
  endings, BOM, key order and unknown keys. One write path for UI, assistant and MCP.
- `.claude.json`: prefer Claude Code's own writer (`claude mcp add-json/remove`); a
  direct edit touches one key, re-reads right before writing, and verifies afterwards.
- Unknown files are read-only until the user edits them. Delete = OS trash.
- Never index or display `.credentials.json`, `sessions/*.key`, OAuth/Admin keys.
  Admin API key lives in the OS keychain only.

## Design Identity
> Atlas's OWN look, not a copy of any other app (`~/.claude/rules/design-identity.md`).
> References with reasons: Apple macOS apps (native chrome, vibrancy, hierarchy by
> type), Things 3 (calm whitespace, one accent), Linear (keyboard-first, command
> palette, restrained dark), Raycast (Cmd/Ctrl+K summon, result density).
- Category: Desktop tools / utilities, tuned calmer and roomier than Will's own tools
  (a gift, not an instrument panel): keyboard-first, instant, layered surfaces over
  shadows, exact state restore.
- Personality: calm, warm, exact, crafted, quietly generous.
- Palette (proposal; tokens in one source, `src/styles/tokens.css`):
  - Light: bg `#FAF8F5` warm off-white · surface `#FFFFFF` · raised `#F3F0EB` ·
    text `#1F1D1A` · text-2 `#6B655C` · line `#1F1D1A` at 10 %.
  - Dark: bg `#1C1A17` deep charcoal · surface `#252220` · raised `#2E2A27` ·
    text `#EDE8E1` · text-2 `#A39B90` · line `#EDE8E1` at 10 %.
  - Accent terracotta (spec, **OPEN: keep?**): fill `#C96442` for large marks and
    charts; `#B4532F` for text, links and filled buttons (white text, about 5:1); dark
    mode `#E07A55` (about 5.8:1 on bg).
  - Semantic: danger `#B42318` / `#F97066`, success `#3F7D58` / `#6FBF8E`, warning
    `#B7791F` / `#E3B341`. Danger sits close to terracotta in hue: always pair it
    with an icon and words.
  - Charts: terracotta, then warm neutrals and one cool slate (`#5B7083`) for contrast;
    validate with the dataviz palette checker.
- Typography: system stack (SF Pro on macOS, Segoe UI Variable on Windows); SF Mono /
  Cascadia Code for code and table numbers; tabular numerals on every stat. Ramp 12
  caption · 14 body · 16 body-large · 20 subtitle · 28 title · 40 display (Wrapped
  goes larger).
- Shape & motion: 8 px grid (4 px half-steps); radii 6 controls · 10 cards · 14
  sheets and popovers; 1 px lines at 10 %; shadows only on floating layers. Motion
  150-250 ms ease-out, springs only for panels, cards and Wrapped; press-scale 0.97;
  "reduce motion" swaps everything for fades.
- Signature effects: (1) faint topographic contour lines (static SVG) behind empty
  states, onboarding and Wrapped, the "atlas" thread; (2) number ticker on hero stats
  (MagicUI Number Ticker technique); (3) native vibrancy sidebar on macOS, Mica on
  Windows.
- Icon motif: **OPEN** (the mountain/campfire was for "Basecamp"). No Anthropic or
  Claude logos or trademarks anywhere.

## Stack / Tools
- Tauri 2.x (stable line; 3.0 is alpha, do not use) · Rust 1.97 · Cargo workspace
  `crates/{core,app,mcp}` · `rmcp` 3.x for the MCP server · React + TypeScript + Vite +
  Tailwind, Radix UI, Framer Motion, Recharts, CodeMirror 6 · SQLite (rusqlite,
  bundled, FTS5) for the usage cache · `notify`, `keyring`, `trash` crates.
- npm (no pnpm/bun on this machine); `@tauri-apps/cli` pinned in `package.json`.
- Installers: `.dmg` (universal) + NSIS `.exe` (and `.msi`) via GitHub Actions matrix.

## Constraints
- Performance: first paint < 1 s; dashboard populated from the cache < 2 s with 1,000+
  sessions (Will's machine: 1,881 transcripts, 5.3 GB); first-ever index runs in the
  background with progress, never blocks the UI; incremental re-parse by byte offset.
- Persistence: app data dir `<appdata>/atlas/` (cache.sqlite, backups/, settings.json
  with `schemaVersion`, atomic writes). Window bounds, last view, filters and scroll
  restore exactly before first paint.
- Single instance; tray keeps running when the window closes (opt-in close-to-tray).

## Success =
The Definition of Done in `BUILD-PROMPT.md`, proven on Windows locally and on macOS
via a CI-built `.dmg` that dad (or Will on a Mac) installs and runs.

---

## Roadmap

### Now
- [x] Phase 0: recon + architecture + spec changes (`docs/phase0-recon.md`). **Waiting
      for Will's OK and the open questions before Phase 1.**

### Next
- [ ] Phase 1: workspace, Tauri shell, sidebar nav, tokens + light/dark, fixture config
      dirs, `--config-dir`, Sandbox Mode, CI matrix skeleton.
- [ ] Phase 2: usage engine (incremental parser, SQLite cache, dedup, pricing table),
      Dashboard, Sessions, search, Session Detail.
- [ ] Phase 3: Setup read: discovery of every item type, global + project, cards,
      viewers, file-watcher refresh.

### Later
- [ ] Phase 4: Setup write + safety: editor, CRUD, templates, validation, settings
      form, hooks + MCP management, atomic writes, backups, History, Undo.
- [ ] Phase 5: Atlas MCP server (`crates/mcp`), sidecar, Connect/Disconnect.
- [ ] Phase 6: in-app assistant (headless `claude -p`), Pending Changes queue.
- [ ] Phase 7: Wrapped 2026 + first-launch intro, tray/menu bar, spend alerts.
- [ ] Phase 8: icon, onboarding, empty/error states, perf + a11y pass, README.

### Open questions
- Icon motif for Atlas.
- Keep the terracotta accent (it sits close to Claude's own brand color)?
- GitHub repo for CI (account `dozeyy`).
- macOS signing: unsigned (Open Anyway in Privacy & Security) vs a paid Apple
  Developer ID (gated: spending).
- Wrapped history: transcripts are swept after `cleanupPeriodDays` (default 30), so a
  full-year Wrapped needs dad's retention setting checked; see the recon doc.
