# Open-question defaults (2026-11-08)

**What it is:** the answers the builders use for the open questions in the Phase 2 and
Phase 3 specs. Will was away; these are defaults and he can overturn any of them. Each
one is the reversible, least-surprising choice.

**Status:** provisional, in force for the Phase 2 and Phase 3 builds.

## Phase 2: usage engine (`phase2-usage-engine.md`)
- Q1 Usage timeline: on the Dashboard (charts) and Sessions (per-session). History stays
  the change/backup timeline, per the recon and CLAUDE.md.
- Q2 Headline "tokens": input + output by default. Cache writes and cache reads dominate the
  total and inflate it, so they stay out unless the person turns on Settings > "Count cache in
  token totals" (Will, 2026-11-10); then the headline is input + output + cache writes + cache
  reads everywhere (one formula: `TokenCount` in Rust, `t.total` in the page). Dollars never
  change. Every token figure lists all four kinds, and "All together", on hover. (Before
  2026-11-10 the default also counted cache writes.)
- Q3 `usage.iterations[]`: verify against the fixtures and real lines before counting.
  The rule: never add iterations on top of a top-level usage that already includes them.
  Write the finding into the spec.
- Q4 Missing 5m/1h cache-write split: count it as 5m, and label the session "estimated".
- Q5 Cost accuracy: label every cost "estimate". The target is within 2 % of Claude
  Code's own figure where both exist. A larger gap is a bug to investigate, not a tuning knob.
- Q6 Full-text search: not in Phase 2. Phase 8 or after v1.
- Q7 Cache location: Local AppData. The cache is rebuildable and must not roam.
- Q8 Offering to raise `cleanupPeriodDays`: Phase 4 (writes). Phase 2 only shows a notice
  that transcripts older than N days are deleted by Claude Code and kept by Atlas.
- Q9 Week start: follow the OS locale.

## Phase 3: Setup read (`phase3-setup-read.md`)
1. Secret values (env, headers, tokens): masked by default, with a click to reveal one
   value. Never logged, never cached, never in screenshots.
2. Agent worktree folders: hidden by default, behind a "Show worktrees" toggle.
3. Deleted project folders: a collapsed "Missing" group at the bottom.
4. Permissions: one row per rule, grouped allow / ask / deny, with search; the list is
   virtualized (~250 rules).
5. claude.ai connectors: listed by name only (the only source is `mcp-needs-auth-cache.json`).
6. Synced skills: shown with the prefix Claude Code itself shows (`anthropic-skills:`).
7. `.bak-*` copies: hidden by default, shown with "Show backups".
8. `githubRepoPaths`: yes, a third project source, deduped with the other two after
   path normalisation (`.claude.json` has two spellings of the same path).
