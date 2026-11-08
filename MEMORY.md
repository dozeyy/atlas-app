# Atlas - Memory Log

Append-only. Log real outcomes, decisions, and completed work only. Never rewrite
past entries. Timestamp every entry (YYYY-MM-DD). Newest at the bottom: append to
the end (the known-fix-lookup hook reads the tail; later entries win).

## 2026-11-08 - init
- Initialized from the global setup (~/.claude/templates). Idea: a premium Tauri 2 +
  Rust + React companion app for Claude Code (usage/cost dashboard, Setup manager, own
  MCP server, in-app assistant with diff approval, Wrapped, tray), a Christmas gift for
  Will's dad on macOS + Windows. Spec saved verbatim as BUILD-PROMPT.md (written as
  "Basecamp"; the app is Atlas). Generated ./CLAUDE.md with the roadmap (spec phases
  0-8) and a Design Identity (warm neutrals + terracotta; icon motif OPEN).
- Bootstrapped by a dispatched agent while Will was on Remote Control; no init
  interview (the spec answers it); open questions relayed through the main session.

## 2026-11-08 - Phase 0 recon (read-only on the real config)
- Findings and architecture in docs/phase0-recon.md. Headlines: transcripts dedup by
  message.id+requestId but must keep the LAST line per key (only output_tokens grows
  across the duplicate lines; first-seen undercounts); 80 % of transcripts are
  subagent files under <session>/subagents/; per-project "local" MCP servers live in
  ~/.claude.json projects[path].mcpServers; MCP on/off is per project
  (disabledMcpServers), hooks have no per-hook enabled flag; transcripts are swept
  after cleanupPeriodDays (default 30); with CLAUDE_CONFIG_DIR set, .claude.json moves
  inside it. Toolchain on Windows complete (Rust 1.97.1, Node 24.18, tauri-cli 2.11.4,
  VS Build Tools 2022, WebView2); no macOS target or Mac locally.
- Phase 1 waits for Will's OK.

## 2026-11-08 - Phase 1 foundation
- Built: Cargo workspace (core/app/mcp stub), Tauri 2 shell, React 19 + Tailwind 4 + Radix
  frontend, 6-page sidebar, tokens (one file, contrast-tested), System/Light/Dark switch,
  Mica/vibrancy config, fixtures, `--config-dir`, Sandbox Mode, CI matrix. Will chose the
  icon mid-phase (assets/brand/) and kept the terracotta accent.
- Root causes found by tests: proposal colors failed AA (warning, accent text on the nav
  wash) and danger sat 10 degrees from terracotta in hue, so danger moved to raspberry;
  Windows canonicalize leaked a verbatim path prefix into the sandbox path shown in the UI
  (stripped at the source); first-paint ms was unset in the boot payload (the app now emits
  it after first paint). Once, a launch right after killing another instance opened no
  window (harness timing; not reproduced with a 3 s gap).
- Measured (debug build, Windows 11): 370-470 ms to first paint; Sandbox of the real
  ~/.claude = 2468 files in 4.3 s on a background thread, real files untouched.

- CI: first run failed on macOS only: std::path::absolute keeps ".." on Unix, so the real-config write guard missed home/x/../.claude/a when x did not exist (guard hole, fixed in comparable()). Second run green on both OS (run 42498855503). macOS runtime (launch, vibrancy, traffic lights) still unverified: no Mac.

## 2026-11-08 - Phase 2 usage engine (branch phase2-usage)
- Built: incremental parser (byte offsets, dedup keeps the LAST line per message.id|requestId, subagent roll-up), SQLite WAL cache in Local AppData (never inside the config dir; the engine refuses to start otherwise), pricing data file, background indexer with progress, watcher (500 ms debounce, 1 `changed` per second, 5 min sweep), IPC, Dashboard + Sessions + Session detail with loading, empty, error and indexing states.
- Q3 verified on real lines: top-level usage already includes iterations, so iterations are never added on top (finding in docs/specs/phase2-usage-engine.md).
- Perf (bench, release): real ~/.claude (5.5 GB, 113k messages) all budgets PASS; warm-cache dashboard ready in 475 ms; 1M synthetic: dashboard about 12 ms, timeline about 10 ms, sessions page 17-30 ms, session_detail 62 ms median (max 69-99 ms on reruns, one 233 ms outlier while other builds ran: no headroom). Details in docs/bench/usage-2026-11-08.md. Cold-cache first index of the real data in the debug build 30.5 s; not measured in release.
- Root causes: (1) Dashboard showed an error during the first index because the cache file did not exist yet: `cacheNotReady(status)` now shows the skeleton. (2) "13M tokens, 0 sessions": cards counted sessions STARTED in the period while tokens follow message time; cards now count sessions ACTIVE in the period (EXISTS probe on messages_session, dashboard 2 ms to 12 ms); timeline buckets keep "started" and say so. (3) Sessions "Showing 50 of" flake was a real one-render lag from effect-based paging; replaced with state derived from the first page. (4) The debug exe loaded another agent's vite dev server on port 1420 (stale placeholder UI in screenshots): build with `--features custom-protocol` to serve the embedded dist. (5) CopyFromScreen captured another agent's overlapping window: use PrintWindow.
- Incident: a stray file `real-after.txt` was written into C:\Users\Will\.claude\projects (a read-only bench listing redirected to the wrong path). It is NOT deleted (not mine to delete there). Will: `rm "C:/Users/Will/.claude/projects/real-after.txt"`. No transcript was modified; before/after listings of the real tree differ only by live-growing agent transcripts.
- Also fixed: Phase 1 clippy collapsible_if in fsutil.rs and sandbox.rs (acceptance 33).
- Will's direction 2026-11-08: no dead empty space on any screen at 1280x800 or the 900x600 minimum. Empty states now fill the remaining window height. Sidebar header untouched (main removed it in 299a834).
- Not verified: feel and live Claude Code update timing (acceptance 29, 30, 32 are Will's); the estimate vs cost-state deviation (mean +22.9 %, worst 3270 %) is unexplained.
