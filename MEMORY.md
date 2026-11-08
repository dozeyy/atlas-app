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

## 2026-11-08 - Phase 3 Setup page (read only), finish pass
- Root cause of the idle CPU burn (12.7 % of one core with the window open): the watcher treated every event under any watched project folder as relevant, and a busy home/temp folder fired 77 rescans in 25 s. `is_relevant` now keeps only what Setup reads (`.claude`, CLAUDE.md, CLAUDE.local.md, AGENTS.md, .mcp.json, one level deep) and drops node_modules, .git and agent worktrees. Idle after the fix: 0.00 % of one core over 30 s, 13 MB private.
- Measured on Will's real config (release, read only): discovery first 102 ms, p50 59.8, p95 62.2; 969 items, 35 projects, 762 KB snapshot. In the real debug app: Dashboard to Setup 11-14 ms content, 22-26 ms painted; detail open 8-34 ms; search keystroke 3-19 ms (first key 19 ms, over the 16 ms budget; the rest are under). 521 listed files, 0 changed during the run; the external stamp (10874 files, sizes + mtimes) was identical before and after, only `.claude.json` mtime moved (running Claude sessions, same length).
- Will's feedback: fill the empty space, and make it warm and fun, not a spreadsheet. Done: type tiles wrap and grow (no empty cells), empty states take the rest of the page height, an odd last card spans the row, friendly header ("106 skills, 56 agents, 4 commands and 14 MCP servers"; "935 things set up across 31 projects, all yours."). Sidebar header block untouched on purpose (main 299a834 removes it).
- Test gaps closed: Enter opens, Arrow navigation, scope filter, viewer read only (mutation-checked: flipping `readOnly` fails it). A first draft of the read-only test passed with `readOnly` off (it only dispatched events), so it now checks the editor state itself.
- Deviations: shots at 150 % use a forced WebView scale factor, not the OS display scale; fixture shots use `--config-dir`, so `.claude.json` there is not read (decoy); the fixture has no secret value that reaches the UI, so "masked env as dots" is covered by tests, not a shot (the shot shows env names and the Values hidden chip); permissions use a 60-row cap with "Show more" instead of virtualisation; empty groups are hidden rather than shown dimmed.
