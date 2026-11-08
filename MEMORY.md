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

