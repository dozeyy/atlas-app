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
