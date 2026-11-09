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
> **Fun pass "Trail Map" (decided 2026-11-08) is the current direction; its spec,
> references, token additions, chart specs and mockups are in
> `docs/specs/fun-pass/DIRECTION.md`. Where the lines below and that file differ, it wins.**
> References with reasons: Apple macOS apps (native chrome, hierarchy by type), Things 3
> (check-fill moment, one accent), Linear (fast tooltips, sliding controls), Raycast (icon
> blobs, instant feedback), GitHub contribution graph + Apple Fitness rings + Duolingo
> streaks (data as progress), USGS topo maps (terrain, summit markers).
- Category: Desktop tools / utilities, warmer and more playful than Will's own tools
  (a gift, not an instrument panel): keyboard-first, instant, layered surfaces over
  shadows, exact state restore.
- Personality: warm, playful, exact, crafted, quietly proud of you. Not a spreadsheet:
  usage is a landscape, streak days are ringed in clay, the clay spark flags every peak,
  record and finish line.
- Palette (proposal; tokens in one source, `src/styles/tokens.css`):
  - Light: bg `#FAF8F5` warm off-white · surface `#FFFFFF` · raised `#F3F0EB` ·
    text `#1F1D1A` · text-2 `#6B655C` · line `#1F1D1A` at 10 %.
  - Dark (neutral graphite like the Claude app, no brown; Will, 2026-11-08): bg `#1F1F1E` ·
    surface `#292928` · raised `#333331` · text `#ECECEA` · text-2 `#A5A4A0` · line `#ECECEA` at 10 %.
  - Silver (clearly cooler and deeper than Light; Will, 2026-11-08): bg `#D2D8E0` · surface
    `#E8ECF1` · raised `#CDD3DC` · text `#1A1F27` · text-2 `#434B57`; accent `#B5573A`.
  - Default theme is Match Windows (`system`); a pinned theme only after the user picks one.
  - Accent terracotta (Will kept it, 2026-11-08): `--accent` `#C96442` for large marks
    and charts; `--accent-solid` `#B4532F` filled buttons (white text); `--accent-text`
    `#9C4524` text and links; dark mode `#E07A55` fill, `#E8896A` text. Shipped values
    are in `src/styles/tokens.css`; `src/styles/tokens.test.ts` fails if any text pair
    drops under 4.5:1, a graphic under 3:1, or accent and danger come within 25 degrees
    of OKLCH hue. The app UI accent stays as tuned for contrast; do not retune it to
    match the icon color.
  - Semantic (tuned in Phase 1; the proposal values failed AA or sat too close to
    terracotta): danger raspberry `#B80F4A` / `#FF6B8B`, success `#36704E` / `#6FBF8E`,
    warning `#86570F` / `#E3B341`. Still pair danger with an icon and words.
  - Charts: `--chart-1..4` clay, slate `#5B7083`, sand `#A8875F`, neutral; heat grid
    `--heat-0..5` clay elevation bands; resting bars `--bar-rest`. Hand-written SVG
    components, no chart library (Recharts dropped).
- Typography: body stays the system stack (SF Pro / Segoe UI Variable); display and
  numbers in **Recursive Variable, a little Casual** (`CASL 0.4`, weights 700-760; Will
  found `CASL 1` too playful, 2026-11-08; OFL,
  bundled via `@fontsource-variable/recursive`, no CDN; digits are tabular). Ramp:
  hero 56 · title 32 · stat 28 · tile 24 · figure 20 · small 15 in Recursive; lead 15 ·
  body 14 · caption 12 in system. Code stays SF Mono / Cascadia. Never Recursive for
  body, buttons, nav, inputs, tables or code.
- Shape & motion: 8 px grid (4 px half-steps); radii 8 controls · 14 cards · 18 sheets ·
  pills 999; 1 px lines at 10 %; `--shadow-lift` only on hovered clickable cards and
  floating layers. Hover 220 ms `--ease-spring` (lift -2 px), press 90 ms scale .96-.985
  on pointerdown, one-shot Phosphor icon micro-motions (zap, tilt, nudge, plug, swing,
  wiggle, bob, pop, spin); charts animate once per launch; three rationed celebrations
  (setup checklist complete, streak milestones, new busiest day), no confetti or sound.
  Calm zones: Settings, detail sheet, code viewer, History, Pending Changes, errors,
  anything destructive. "Reduce motion" swaps everything for fades.
- Signature effects: (1) the summit spark: the clay mark planted on chart peaks and
  completed checklists; (2) terrain charts: heat grid in clay elevation
  bands, streak days ringed in clay, today always the bottom-right cell labelled "Today"
  (no trail), ridge sparkline; (3) faint topographic contour lines
  behind empty states, onboarding and Wrapped; plus count-up hero numbers and the native
  vibrancy / Mica sidebar. No "Live" tags anywhere; Setup has no header chips (Will's Setup layout: checklist first,
  equal type tiles, cards with an X delete + inline confirm).
- Wrapped = **Summit** (decided by Will, 2026-11-09; `docs/specs/wrapped-redesign/DIRECTIONS.md`, look in `a-summit/*.png`): a quiet sheet, one huge Recursive figure, one plain line, at most one clay graphic, never a poster. The progress row is the trail (dotted line, clay fill, a waypoint button per slide, the clay spark on the current one); the last slide is a saveable recap card (canvas = preview = saved PNG). Each slide: readable in 3 s, no repeated fact (the card is the one exception), no stats on the opener, a hover only when it says something exact about that element, a slide with no data is skipped, nothing decorative or overlapping. Code: `src/lib/wrappedModel.ts` (slides), `src/components/wrapped/{Story,SlideView,Trail,graphics,CardSlide}.tsx`, `src/styles/summit.css`, `src/lib/shareCard.ts`.
- Icon: **DECIDED by Will (2026-11-08)**. Cream tile `#F7EBDC`, mark `#DC784D`.
  Sources and rebuild script in `assets/brand/` (`atlas-icon-1024.png` macOS tile,
  `atlas-icon-fullbleed-1024.png` Windows/full bleed, `atlas-mark-1024.png` mark only
  for the tray, `source-chatgpt.png` the original, `build.py`). Installed set:
  `crates/app/icons/` (generated with `npx tauri icon`; Windows set from the full-bleed
  file, `icon.icns` from the tile). The sidebar logo is `src/assets/atlas-icon-64.png`.
  No Anthropic or Claude logos or trademarks anywhere.

## Stack / Tools
- Tauri 2.x (stable line; 3.0 is alpha, do not use) · Rust 1.97 · Cargo workspace
  `crates/{core,app,mcp}` · `rmcp` 3.x for the MCP server · React + TypeScript + Vite +
  Tailwind, Radix UI, CSS/WAAPI motion, hand SVG charts, CodeMirror 6 · SQLite (rusqlite,
  bundled, FTS5) for the usage cache · `notify`, `keyring`, `trash` crates.
- npm (no pnpm/bun on this machine); `@tauri-apps/cli` pinned in `package.json`.
- Installers: `.dmg` (universal) + NSIS `.exe` (and `.msi`) via GitHub Actions matrix.
- **Atlas Setup** (`crates/setup`, front end `setup.html` + `src/setup/`): the styled Windows
  `Atlas-Setup-Windows-x64.exe`. It embeds the NSIS installer, installs it silently per user,
  and reads the chats into the cache while the window is open (same data dir, one writer, the
  indexer is stopped before Atlas launches). The trail on the sheet is the chat-reading
  progress; Install is a click, available at any time. Build it locally with
  `tools/build-setup.ps1`; the release workflow (`.github/workflows/release.yml`, tags `v*`)
  builds the same chain. Details: `docs/releasing.md`.
- **In-app updates** (`crates/app/src/update.rs`, `tauri-plugin-updater`): a quiet check after
  first paint and every 6 h against `https://github.com/dozeyy/atlas/releases/latest/download/latest.json`;
  a blue download icon at the sidebar's bottom-left offers the update, never installs by itself.
  The signing key is `C:\Users\Will\.tauri\atlas-updater.key` (outside every repo, never
  printed or committed); only the public key is in `tauri.conf.json`.

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
- [x] Phase 0: recon + architecture + spec changes (`docs/phase0-recon.md`).
- [x] Phase 1: workspace, Tauri shell, sidebar nav, tokens + light/dark, fixture config
      dirs, `--config-dir`, Sandbox Mode, CI matrix. Verified on Windows (screenshots in
      `docs/shots/phase1/`); macOS is built and tested only by CI until a Mac is at hand.

### Next
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

### Decided
- Terracotta accent kept; icon chosen (see Design Identity); repo is private
  `dozeyy/atlas`.

### Open questions
- macOS signing: unsigned (Open Anyway in Privacy & Security) vs a paid Apple
  Developer ID (gated: spending).
- Wrapped history: transcripts are swept after `cleanupPeriodDays` (default 30), so a
  full-year Wrapped needs dad's retention setting checked; see the recon doc.

## Phase 1 notes (how it is wired)
- Config dir: `--config-dir`, then Settings override, then `CLAUDE_CONFIG_DIR`, then
  `~/.claude`; `.claude.json` sits inside the config dir when `CLAUDE_CONFIG_DIR` or a
  flag/override is used. Data dir: `--data-dir`, `ATLAS_DATA_DIR`, then the OS data dir.
  Use a data-dir override for first-run tests.
- Sandbox Mode copies to `<temp>/atlas-sandbox-*` on a background thread and Atlas
  reads only the copy; while it is preparing or failed, the UI shows nothing rather
  than the real folder. `projects/` is never copied (linked read-only). Debug builds
  refuse writes under the real Claude folder (`fsutil::check_write_allowed`).
- Frontend talks to Rust only through `src/lib/ipc.ts`; a plain browser or tests get
  an in-memory `MockBackend`.
- Commands: `npm test` (Vitest), `cargo test --workspace` (plain `cargo test` skips the
  app crate by design), `npx tauri build --debug --no-bundle` then run
  `target/debug/atlas.exe --config-dir fixtures/claude-basic --data-dir <scratch>`.
  Fixtures regenerate with `python tools/make-fixtures.py`.
- Deferred on purpose: Framer Motion, tray (Phase 7); the window
  state plugin stores bounds in its own app-config folder, not in `--data-dir`.
- Launch intro (`crates/app/src/intro.rs`, `splash.html`, `src/splash/`): a transparent
  `splash` window (denylisted from window-state) sits over the hidden main window's rect
  and plays the mark animation (burst, fill, spin that leaves gradient orange trails until
  the mark is a solid disc, a ripple of clay-tone rings out to flat clay, then a feathered
  circular hole opens from the middle and the app lands from scale .98; timeline in
  `src/splash/timeline.ts`, only the hole is drawn per frame, on a canvas); Rust hands
  off to the real window (`launch_animation`
  setting, on by default; any click or key skips; reduced motion = 150 ms fade).
  `ATLAS_NO_INTRO=1` turns it off, `ATLAS_REDUCE_MOTION=1` forces the reduced path. The
  mark's SVG is `assets/brand/atlas-mark.svg` (`python assets/brand/trace_mark.py`).
  Single-instance (`tauri-plugin-single-instance`): a second launch focuses and restores
  the running window, no intro; `ATLAS_MULTI=1` disables the lock for tests. Evidence
  tools: `tools/capture-intro.ps1`, `tools/analyze-intro.py`, `tools/drive-intro.ps1`,
  `tools/record-intro.ps1` (minimizes every window, never closes one, restores them).
