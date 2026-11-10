# Agent scorecard, review themes, live helper tracker and after-run debrief

**Who it is for:** Sam Henry (Will's dad, samhenry.org), a fractional AI consultant who runs a
"software factory" on Claude Code: a named team of agents plus worker and reviewer subagents;
features flow spec -> PRD -> issues -> workers on branches -> independent spec and security
reviewers -> merge; human decisions over Slack; agents run 24x7, including headless `claude -p`
and Agent SDK runs. His principles "Autonomy Is Earned", "Trust and Verify" and "Guidance Is No
Guarantee" are what these four features make visible.

**What Will asked for (2026-11-09):**
1. **Agent scorecard**: one card per agent/subagent type: runs, tokens and estimated cost,
   active time, success and failure, how often its work passed review versus came back with
   findings, trend over time, the projects (and clients) it worked on.
2. **What reviewers keep catching**: recurring findings across all review-type helper outputs,
   grouped deterministically (no AI, no network), top themes with counts, examples, whose work
   they were found in and last seen; one click "Make this a rule" drafts a rule, previews it and
   saves it through the one write path (backup, History, Undo).
3. **Live helper tracker in Now**: every running helper with its name, type, one-line goal, an
   honest progress trail, elapsed time, tokens so far and a "stuck" hint.
4. **After-run debrief**: when a long or multi-agent run ends, the final report Claude already
   writes gets Atlas's facts folded in, in the user's own style, for a tiny token cost.

**Status:** spec, not built. Four build units: **1** helper ledger (core), **2** Team page
(scorecard + themes + Make this a rule), **3** Now tracker, **4** debrief (CLI + plugin skill +
MCP tools). Unit 3 is independent of Unit 1 and can start at once; Units 2 and 4 need Unit 1.

**Research:** done 2026-11-09 against Will's real transcripts (`~/.claude/projects`, read-only,
Python tallies run from the scratchpad; `.credentials.json` and keys were never opened) on
Claude Code **2.1.296**. Numbers below are counts, never content. Corpus: 393 main transcripts,
1,596 subagent transcripts, 1,594 `agent-*.meta.json` sidecars.

---

## Goal
Show Sam, from his own transcripts and nothing else, which helpers earned trust (they finish,
their work passes review) and which keep getting sent back; what the reviewers keep catching,
turned into a rule in one click; how far each running helper is from done without inventing a
percent; and a short, honest end-of-run debrief inside the report Claude already writes.

## Not in scope (v1)
- **Clients.** Nothing in a transcript names a client. Projects are shown; clients wait for open
  question 1.
- Any AI or network step in grouping, drafting or progress (all deterministic, local).
- Judging quality beyond what a reviewer wrote: Atlas reports verdicts, it never grades work.
- A verifier's `STATUS: done/partial` read as a review outcome (it is the agent's own status).
- "Files read versus files in the diff" progress for reviewers (measured useless, 1.4).
- A "writing the report" phase (not detectable live, 1.4).
- Plan step text in Now (counts only; open question 2).
- A Stop hook (open question 3; the skill is the recommendation, D64).
- Editing or deleting agents from the Team page (Toolkit owns agent files).
- Slack posting by Atlas. Sam's own agents post; Atlas only answers read-only MCP calls (D65).
- Raising `cleanupPeriodDays` for longer history (open question 6).
- macOS screenshots (CI-only per the project, as before).

---

## 1. Research findings (what the spec rests on)

### 1.1 How helper runs are recorded
- One helper run = one `projects/<cwd>/<session>/subagents/agent-<id>.jsonl` plus a sidecar
  `agent-<id>.meta.json`. Sidecar keys seen: `agentType` (1,594 of 1,594), `description`
  (1,594), `toolUseId` (1,594), `spawnDepth` (1,594; depth 1: 1,497, 2: 72, 3: 25),
  `requestShape` (1,312; background 1,189, foreground 123), `model` (474), `finished` (493, all
  `true`; newer Claude Code only), `worktreeBranch` (226), `parentAgentId` (97), `effort` (224),
  `isBuiltIn` (105), `stoppedByUser` (3). Atlas already stores type, description, tool-use id,
  parent and depth in the cache table `agents`, and tool calls per file in `files.tool_calls`.
- The dispatch is an `Agent` tool_use in the parent (2,037 seen; input keys `description`,
  `prompt`, `subagent_type` (2,030), `run_in_background` (1,736), `model`, `effort`,
  `isolation`). Its `toolUseResult` carries `agentId`, `status` (`async_launched` 1,602,
  `completed` 94) and, only for the 94 foreground runs, `totalDurationMs`, `totalTokens`,
  `totalToolUseCount`. So duration and totals come from the transcripts, not this result.
- How a background run ended: `<task-notification>` records in the parent with `task-id` and
  `status` (`completed`, `failed`, `killed`, `stopped`; repeated across lines, so dedup by id).
  The receipt code already maps these (`receipt.rs outcome_of`: finished / errored / stopped,
  else the thread's own end, else unknown).
- `isSidechain` is never true in a main transcript; subagent lines carry `agentId`.
- 39 agent types ran. The biggest: general-purpose 284, code-reviewer 263, verifier 185,
  chore-runner 130, desktop-app-dev 84, design-reviewer 70. Types are configuration names,
  which is how a named team shows up.
- A top-level session can itself run as an agent: the line field `agentSetting` names the agent
  type (9 sessions here). This is how a named agent started with `--agent` or the SDK shows up.
  `agentName` is the chat's title, not an agent, and is not used.

### 1.2 Headless and SDK runs
- `entrypoint` per main transcript: `claude-desktop` 349, `sdk-cli` 41, `claude-desktop-3p` 2,
  missing 1. Subagent lines repeat their parent's entrypoint. `cli` and other `sdk-*` values
  were not observed here; they are mapped by prefix (D13) and unknown values pass through raw.
- Headless lines also carry `promptSource: sdk` and `origin.kind` (`human`, `task-notification`,
  `peer`). The cache already stores `sessions.entrypoint`.

### 1.3 Detecting a review outcome honestly
- Reviewer-type runs (code-reviewer, verifier, design-reviewer, security-reviewer,
  acceptance-judge, verify-auditor): 535; 27 have no final text.
- A `VERDICT` line in the final assistant text: code-reviewer 228 of 263 (PASS 128,
  FIX-REQUIRED 69, FAIL 10, MERGE 5); design-reviewer 47 of 70 (OFF-SYSTEM 33, PASS 7);
  security-reviewer 9 of 10 (FIX-REQUIRED 8); verifier **5 of 185** (verifiers write
  `STATUS: done/partial`, their own status, not a verdict). So verdicts are honest for
  reviewers that write one and absent otherwise; "no verdict" is its own count.
- Findings: 154 of 508 reviewer outputs have a `FINDINGS` section (2,392 list items under it);
  severity words appear 1,230 times (Low 550, Medium 311, High 195, Critical 156, Minor 13);
  286 outputs cite `path:line`.
- Whose work a review was about, measured over 599-628 reviewer dispatches:
  - the reviewer's prompt names a worker of the same chat by agent id: 80; by worktree branch: 19;
  - exactly one non-reviewer helper ended between the previous reviewer dispatch and this one:
    99 of 628; none ended in that window: 367 (parallel or repeat reviews); 2 or more: 162;
  - after a review the work came back by `SendMessage` to a worker's agent id (1,242 of 1,416
    sends target an agent id; 1,094 a non-reviewer helper; 424 of those use review words) or
    by a fresh worker dispatch that carries the findings (137).
  Attribution is partial by nature: the spec ties a review to a worker only on these rules
  (D10) and shows how many runs could be tied, instead of guessing the rest.

### 1.4 Live progress signals
- Task lists: **0 of 1,594** helpers called `TodoWrite`, `TaskCreate` or `TaskUpdate` (the main
  chat does: 239 creates, 366 updates). 223 helpers set a plan with the desktop app's
  `mcp__ccd_turn__update_plan` (`items[{content,status}]`, plus `{advance:true}` and
  `{done:[i],start:j}` forms), median 2 calls per helper, and only **9 of 223** ever moved past
  the first step (201 ended with no step marked done). A plan is the best signal when it moves,
  and it rarely does, so it cannot be the main one.
- Reviewer "files read versus files in its diff": 186 of 263 code-reviewer prompts name 2+
  files, 240 run `git diff`, and 137 of the 186 never `Read` a named file. Useless; left out.
- Typical run per type (tool calls p25/p50/p75; minutes p25/p50/p75): code-reviewer 12/21/40,
  1.9/3.5/7.3; verifier 11/18/40, 2.0/5.5/13.8; chore-runner 3/5/9, 0.3/0.4/0.8;
  desktop-app-dev 54/166/297, 19.7/38.3/92.2; ui-builder 88/174/298, 26.2/54.4/119.9;
  general-purpose 9/20/50, 1.0/2.9/9.3. The spread is wide, so a comparison is only ever
  "about N0 %" (rounded to 10), never an exact percent.
- Phase: live tool calls are already classified (`now/facts.rs`: read, edit, write, run,
  search, web, helper, plan). Lines land per whole message, so "writing the report" is only
  known once the report exists.
- Today `now/track.rs helper_view` marks a helper done after 30 s with no write. A helper in a
  long build or test is silent longer than that, so the tracker needs a real end rule (D41).

### 1.5 Hooks and token cost (debrief)
- Plugin hooks (`hooks/hooks.json`, `${CLAUDE_PLUGIN_ROOT}`) can run on `Stop` and
  `SubagentStop`; the Stop payload has `session_id`, `cwd`, `transcript_path`,
  `stop_hook_active` (seen in the official ralph-loop plugin and the impeccable plugin's hook
  contract). A Stop hook stays silent or returns `{"decision":"block","reason":...}`, which
  makes Claude take another turn **after** its report. 4,741 transcript lines carry
  `hookAdditionalContext`, but whether a Stop hook's `additionalContext` reaches the model on
  2.1.296 is not proven here.
- `Stop` fires at every turn end. An orchestrated run ends many turns while background helpers
  still work (each notification wakes the chat), so "the run ended" is not one Stop event.
- Current `atlas` skill listing: description 336 + when_to_use 458 characters. Token figures in
  this spec are character estimates (about 4 characters per token) until criterion 37 measures
  them.

### 1.6 Measurable or not

| Wanted | Verdict | Source |
|---|---|---|
| Runs per agent type | Measurable | sidecar `agentType`; `agentSetting` for main-chat agents |
| Tokens, estimated cost | Measurable | `messages` by `agent_id` (existing ledger, price table) |
| Active time | Measurable as "time running" (first to last line) | helper transcript timestamps |
| Success / failure | Measurable as how a run **ended** (finished, errored, stopped, unknown) | task-notification, sidecar, thread end |
| Passed review vs sent back | Partly: reviewers' own verdicts yes; tying one to a worker only on D10 links | final text, dispatch prompts, SendMessage |
| Trend over time | Measurable | weekly buckets of the above |
| Projects | Measurable | session `cwd` / project |
| Clients | **Not measurable** | nothing in transcripts |
| Headless vs interactive | Measurable | `entrypoint` |
| Live progress from a plan | Measurable when the plan moves (rare) | plan tool calls |
| Live progress vs a typical run | Measurable as "about N0 % of a typical run" | tool calls vs the type's median |
| Reviewer files-read progress | **Not useful** | 1.4 |
| "Writing the report" phase | **Not measurable live** | 1.4 |

---

## 2. Decisions made (the code-reviewer's checklist)

### Unit 1: helper ledger (core)
- D1. A **helper run** is one subagent transcript (one `agents` row). A top-level session whose
  lines carry `agentSetting` is also a run of that type, marked "ran as the main chat".
- D2. Agent type = sidecar `agentType`; missing or blank -> `general-purpose` (existing rule);
  display name via `naming.rs humanize_type`; `agentSetting` stored in a new
  `sessions.agent_setting` column.
- D3. New cache table `agent_runs` (one row per run, ids and numbers only): `session_id`,
  `agent_id` (empty for a main-chat agent run), `agent_type`, `first_ts`, `last_ts`,
  `tool_calls`, `end_status` (`finished` | `errored` | `stopped` | NULL), `end_source`
  (`notice` | `sidecar` | `thread`), `verdict_word`, `verdict` (`pass` | `findings` | `other` |
  NULL), `findings_n`, `worktree_branch`. End status order: the parent's task-notification
  (reusing `receipt_scan::notices_in`, made `pub(crate)`), then sidecar `finished: true` ->
  finished, then the thread's own end (`end_turn` / API error / interrupted, as `outcome_of`).
- D4. **Time running** = `last_ts - first_ts` of the helper's own lines. Never summed into
  "hours worked" across parallel helpers; per-type figures use the median. `totalDurationMs`
  is not used (foreground only).
- D5. Tokens and cost come from the existing ledger. Outside Toolkit, tokens are the figure and
  dollars live in the hover, always called an estimate (MEMORY 2026-11-08 rule).
- D6. **Verdict parse** on the run's final assistant text (the last assistant line with text
  blocks, kept per file as ingest moves forward, so a growing transcript simply overwrites):
  first match of `(?mi)^\W*verdict\W{0,4}[:\-]?\W{0,4}([A-Za-z][A-Za-z-]+)`, upper-cased.
  `pass` = PASS, PASSED, MERGE, APPROVE, APPROVED, ACCEPT, ACCEPTED, LGTM. `findings` =
  FIX-REQUIRED, FAIL, FAILED, REVISE, OFF-SYSTEM, GENERIC, CHANGES-REQUESTED, BLOCK, BLOCKED,
  REJECT, REJECTED. Any other word -> `other` (raw word kept). No line -> NULL ("no verdict").
  `STATUS:` lines are never read as verdicts. The word lists live in one place
  (`reviews::VERDICTS`).
- D7. A **reviewer type** is a type whose name matches `(?i)review|verif|judge|audit|qa`, or
  whose runs carry a verdict at least half the time (at least 3 runs). Computed at query time.
- D8. **Finding lines** from the same final text: list items inside a section whose label or
  heading contains FINDINGS, ISSUES or PROBLEMS (until the next all-caps label or heading),
  plus any line or list item that starts with a severity word (Critical, High, Medium, Low,
  Blocker, Major, Minor, Nit; bare, bracketed, bold or followed by `:`). The severity is split
  off and kept. Dropped: under 12 or over 400 characters after trim, code fences, anything the
  secret mask (`search::mask`) changes. At most 40 per run. Stored masked in a new cache table
  `review_findings(session_id, agent_id, ord, severity, text, ts)`: a cache, safe to drop. This
  is the only assistant text Atlas keeps; prompts are never stored (existing rule).
- D9. **Links, ids only** (new table `agent_links`): per `Agent`/`Task` dispatch: session,
  time, spawned agent id (via `toolUseId`), and the agent ids of the same chat named in its
  prompt, by id (`a` + 16 hex) or by a `worktree_branch` already recorded for that chat; per
  `SendMessage`: session, time, target agent id when `to` (or `recipient`) is one. The prompt
  text is matched in memory and dropped.
- D10. **Tying a review to a worker**, in order: L1 the reviewer's dispatch names exactly one
  non-reviewer helper of the chat -> that helper. L2 exactly one non-reviewer helper ended in
  the chat between the previous reviewer dispatch (or chat start) and this one -> that helper.
  Else the review is "not tied". **Sent back:** a `findings` verdict followed, before the next
  reviewer dispatch in the chat, by a `SendMessage` to non-reviewer helper X, or by a dispatch
  whose prompt names X -> X's run counts as sent back, and a not-tied review becomes tied to X.
  A helper counts as sent back once per review, however many messages follow.
- D11. Worker card numbers: **Passed review** (tied reviews with `pass`), **Sent back** (D10),
  **Not tied to a review** (its runs with no tied review). A rate sentence ("Passed 9 of 12
  reviews") only with at least 5 tied reviews; below that, counts only.
- D12. Cache schema v7 (migrations `m0006` ledger tables and `m0007` later columns and tables;
  `m0005` is main's `messages.effort`) and a `PARSER_VERSION` bump: the corpus is re-read
  once in the background with the existing progress UI (release full index measured 14.7 s on
  5.5 GB, MEMORY 2026-11-08).
- D13. **Started from**: `entrypoint` starting `sdk-` -> "Headless" (covers `claude -p`, seen as
  `sdk-cli`); anything else or missing -> "Interactive". The raw value shows in a run's hover.
- D14. Grouping code is shared with Skill Library Unit B: `crates/core/src/textgroup.rs`
  (normalize as its D32, character 5-gram shingles, MinHash 64 fixed seeds, LSH 16x4, leader
  clustering at Jaccard >= 0.55, group id = first 16 hex of sha256 of the leader's normalized
  text). Whichever unit lands first writes it; the other imports it. Thresholds are passed in
  by the caller.

### Unit 2: Team page
- D20. **Where:** a new sidebar page **Team** after Toolkit (Dashboard 1, Now 2, Sessions 3,
  Toolkit 4, Team 5, History 6; Settings and Wrapped unchanged). Why not a Toolkit tab: Toolkit
  is the configuration (files) and already fills one screen at 1280x800; a scorecard is about
  runs across every chat, and built-in types (general-purpose, Explore) have no Toolkit file.
  Why not Sessions: Sessions is per chat; this is per agent over time. Icon Phosphor
  `IdentificationBadge`, motion `nudge`. `View` gains `"team"`.
- D21. Two tabs (the Toolkit tab control): **Scorecard** and **Caught in review**. Shared
  toolbar: range 7 days / 30 days / 90 days / All (default 30 days) and Started from All /
  Interactive / Headless (default All). Tab, range and filter persist in `settings.json` like
  other view state and restore before first paint.
- D22. Scorecard cards, one per type with at least one run in range, ordered by runs then
  tokens; a type-to-filter field (focus with `/` or by typing) filters by name.
- D23. Card detail: a side sheet (calm zone: no spring, no count-up, no spark) with 12 weekly
  bars of runs (existing `Bars`), how runs ended, review counts (D11) or, for a reviewer type,
  the verdicts it gave (Passed, Sent back, Other, No verdict), a projects table (project, runs,
  tokens), the Started from split, and the 20 newest runs; a run row opens that helper's
  existing detail page (the chat, then the helper). "Open agent file" shows when Toolkit has an
  agent item of that name and uses `openToolkitItemNext`.
- D24. **Themes:** findings in range (D8) grouped by D14. A theme = a group with >= 3 findings
  from >= 2 different runs; ordered by count, then last seen; top 12 shown, "Show all" for the
  rest. Thresholds in one place (`reviews::Thresholds`).
- D25. Theme content: label = the most frequent original finding text in the group (tie:
  newest), cut to 140 characters; count; severity mix; **found in work by** (worker types from
  D10 with counts, plus "not tied to one helper N"); reviewer types that raised it; projects;
  last seen; up to 3 other examples (masked, 200 characters), each with "Open chat".
- D26. **Make this a rule** (button on an expanded theme) opens a calm sheet:
  - Target, a radio: "A line in CLAUDE.md" (the config root's global `CLAUDE.md`, or the
    `CLAUDE.md` of one of the theme's projects, top 3 by count) or "A rule file"
    (`<config root>/rules/<slug>.md`, slug from the label, a-z0-9 and `-`, max 40).
  - Draft text, deterministic: `- Check before handing work back: <label with severity, path
    and line tokens removed, first letter upper-case, ending in a full stop>`; a rule file gets
    a `# <first 6 words, title case>` heading above it. The draft sits in the existing text
    editor and can be changed before saving.
  - A CLAUDE.md line is appended under `## Caught in review` (the heading is added at the end
    when missing), preserving line endings, BOM and every other byte; saved with `apply_save`
    and the stamp read when the sheet opened (stale -> "This file changed since you opened it."
    with a Reload button; nothing written). A rule file uses `create_apply("rule", ...)`.
  - Both go through the one write path: backup first, History event, Undo toast; Sandbox Mode,
    `--config-dir` and the debug guard apply unchanged.
- D27. After a save the theme shows "Made a rule, Nov 9" (from `<data>/review-rules.json`,
  `schemaVersion` 1, atomic: theme id -> target path and time; ids and paths only).
- D28. Copy: numbers first, sentence case, ASCII only, no exclamation marks, no "Live".
  Tooltips that name a shortcut use `useKeyHints().tip`.

### Unit 3: Now tracker
- D40. **Where:** a "Helpers at work" list inside the Running section, under the chat cards,
  full width: one row per running helper across all running chats, grouped under the chat name
  when more than one chat runs. The chat card keeps its files and its "N helpers" chip; its
  helper rows move to this list. Up to 6 rows show, then the list scrolls in its own pane.
  Order: start time, oldest first; rows never reorder while running. No running helper -> the
  list is not rendered.
- D41. **A helper is running until** one of: its parent recorded a task-notification for it; its
  sidecar says `finished: true`; its last assistant line ended `end_turn` with no open tool
  call; the parent chat is no longer followed. The 30 s silence rule is removed for this list (a
  long build is not "done"); a finished row leaves after `HELPER_LINGER_MS` (8 s).
- D42. Row content: `AgentAvatar` by type (existing `agentLook`), the humanized type as the
  name, the goal = the sidecar `description` (written by whoever dispatched it; masked, 80
  characters), the progress trail (D43), the phase word (D44) or the stuck line (D45), elapsed
  time, tokens so far (`useClimb`), tool calls.
- D43. **Progress, first source that applies:**
  - P1 plan: the helper's latest plan (`TodoWrite` `todos`, any `*update_plan` `items` with its
    `advance` and `done/start` forms, `TaskCreate`/`TaskUpdate` by `taskId`) once it has >= 2
    steps **and** has moved (a step completed, or the active step changed). Text "Step 3 of 6";
    fill = done / total. A plan that never moved is ignored (1.4).
  - P2 typical run: tool calls so far / the median tool calls of that type's **finished** runs
    in the last 90 days, when there are >= 5. Text "About 60% of a typical run" (rounded to the
    nearest 10, shown from 10 to 90); at or past the median "Longer than a typical run". Fill
    capped at 90 % while running. Hover: "A typical code reviewer run: 21 tool calls, 3.5 min
    (median of 263 runs)." Tool calls, not minutes, drive the fill: minutes include waiting on
    long commands; time stays in the hover.
  - P3 none: under 5 past runs -> no fill, text "No past runs to compare".
  - Medians come from the usage cache (`typical_runs(days: 90)`, added by this unit over the
    existing `agents`, `files.tool_calls` and messages tables; it uses `end_status` from Unit 1
    when present, else counts runs with no write for 10 min as ended). Read when Now starts and
    every 30 min, never per tick.
- D44. **Phase word** from the helper's last 6 steps, majority kind, tie -> newest: read or
  search -> "Reading"; edit or write -> "Changing files"; run -> "Running commands", or
  "Testing" when `facts.rs` flags the command as a test run (a fixed word list matched on its
  first 200 characters: test, vitest, jest, pytest, cargo test, dotnet test, go test, verify;
  only the boolean is kept); web -> "Looking things up"; helper -> "Waiting on a helper"; plan ->
  "Planning". The phase swaps through `useSteadyDoing` (held `HOLD_MS`, animated at most once
  per `CALM_MS`).
- D45. **Stuck hint:** no new line for >= 5 min (`STUCK_MS`, one constant) and no open tool call
  -> "No progress for 6 min" in `--warning` text (never red, no icon motion). With an open call
  -> "Running cargo for 6 min" in `--text-2` (a long command is not stuck). The minutes update
  once a minute.
- D46. Snapshot changes (`now/model.rs`, `nowTypes.ts`): `NowHelper` gains `agentType`, `goal`,
  `toolCalls`, `plan: {done, total} | null`, `typical: {calls, ms, runs} | null`, `phase`,
  `lastLineMs`, `openCall: {word} | null`. Still no prompt or message text.
- D47. Motion: the fill moves with a 260 ms ease-out at most once per `CALM_MS`; faster updates
  set the width without transition; reduced motion -> no width transition. Nothing loops; with
  nothing running no timer runs (existing Now cost contract).

### Unit 4: debrief (CLI, plugin skill, MCP)
- D60. CLI: `atlas-usage debrief [--session <id>] [--since <ISO time or epoch ms>] [--detail
  low|high] [--json]`, plus the existing `--config-dir` and `--cache-dir`. Window: `--since`,
  else the chat's first line. Scope: the chat and all its helpers at every depth. Default
  detail `low`.
- D61. **Low output:** plain text, at most 10 lines and 900 characters, `Label: facts` lines, no
  headings, tables, emoji or box drawing, in this order, a line left out when empty: `Ran` (wall
  time), `Helpers` (count by type and how they ended), `Reviews` (passed / sent back / no
  verdict), `Tokens` (total, then "about $X at API prices, estimate"), `Biggest` (the thread or
  helper with the most tokens and its share), `Open` (still running or stuck, D45 rule),
  `Changed` (**v1: worktree branches only**, labelled as branches: the ledger records no edits
  per helper, so no files-edited count is claimed), `Caught` (top 1-2 finding themes of this
  run, D14 grouping with the threshold lowered to >= 2 findings). **High:** at most 40 lines and
  3,000 characters: the same plus one line per helper (type, goal, how it ended, verdict,
  tokens, time) and up to 10 edited files.
  `Models` lists the chat's own model and effort first, marked "chat", then the helpers'. When the
  program picks the chat itself (no `--session`, no `CLAUDE_CODE_SESSION_ID`), the output starts
  with one plain line, "Couldn't tell which chat this is, so this is the newest chat with helpers:
  <title> (<age>).", on stdout (and the MCP text), which the skill keeps. Branch names are
  secret-masked like goals (dropped on a match).
- D62. Atlas supplies facts, never a format. The skill body tells Claude to fold them into the
  report it is already writing, in the active output style and the user's CLAUDE.md
  preferences: a terse user gets the key numbers in one or two lines (low), a detailed user a
  short section (high); no "Atlas" heading unless the report already uses sections; never
  repeat a fact the report already states.
- D63. A third skill in the Atlas plugin, `skill/skills/atlas-debrief/SKILL.md` (not text in
  `atlas`: a trigger in the usage skill would compete with usage questions, as D50 in
  `skill-library.md`). `description` + `when_to_use` <= 300 characters together. Draft:
  description "Adds Atlas facts (time, helpers, reviews, tokens, what is stuck) to the final
  report of a long or multi-agent run."; when_to_use "Only right before the final report of a
  run that used helpers or ran over an hour. Not for short chats." Body <= 1,800 characters;
  `allowed-tools` the same launcher lines as `atlas`, with `debrief` as the only verb.
- D64. **Skill, not a hook.** A Stop hook costs no tokens while silent, but it fires after
  Claude has written its report, so the debrief would arrive as a second message instead of
  being folded in; `decision: block` forces an extra turn, and an orchestrated run ends many
  turns while helpers still work, so a hook needs extra checks to avoid nagging. The skill fires
  at the right moment, before the report, and costs only its listing line until then. No
  `hooks/hooks.json` ships (open question 3).
- D65. **MCP: yes**, three read-only tools (`read_only_hint`, allowed in direct and propose
  mode): `get_agent_scorecard {days?, agentType?, startedFrom?}` (JSON, the Team page's
  numbers), `get_review_themes {days?, limit?: 1..20}` (JSON, masked text), `get_run_debrief
  {sessionId?, since?, detail?}` (the same text as the CLI; no `sessionId` means the newest chat
  that used helpers, and the first line of the text says which chat it picked). Why yes: Sam's agents can report on
  themselves in Slack ("I passed 9 of 12 reviews this month"), which is "Trust and Verify" in
  his own channel; the tools are read-only and never touch the Claude folder. Documented in
  `docs/specs/mcp-server.md`.
- D66. Works with the plugin alone: `atlas-usage` already runs the engine with its own cache;
  the first run indexes (about a minute) and later runs are fast. With the app, the MCP tools
  answer from the app's warm cache. Same numbers either way.
- D67. Token budget (estimates until measured, about 4 characters per token): listing <= 300
  characters (about 75 tokens, every session); body <= 1,800 characters (about 450, only when it
  fires); low call about 60 tokens of command plus <= 900 characters of output (about 225); high
  <= 3,000 characters (about 750). Criterion 37 replaces these with measured numbers.

---

## 3. Screens (Trail Map; tokens from `src/styles/tokens.css`, nothing inline)

### 3.1 Team > Scorecard (1280x800; only the card grid scrolls)
- Header: `PageTitle` "Team", one warm line "12 helper types ran 340 times in the last 30
  days." (14 body, `--text-2`). Right: the tab control (Scorecard, Caught in review), then the
  range and Started from segmented controls (radius 8, 32 px tall). A 32 px filter field left of
  the grid, placeholder "Filter helpers".
- Grid: 3 columns at 1280, 2 at 900, gap 16, cards radius 14, padding 16, `--surface`, 1 px
  line; hover lift -2 px and `--shadow-lift` (clickable). Card height 188 px.
  - Row 1: `AgentAvatar` 40, the type name (16 semibold, body face), a caption "Reviewer" or
    "Ran as the main chat" (12, `--text-2`) when it applies.
  - Row 2: three figures in Recursive 24 with 12 px captions: Runs, Tokens (hover: the dollar
    estimate), Typical time (median time running).
  - Row 3: a 6 px stacked bar of how runs ended: finished `--success`, errored `--danger`,
    stopped `--text-2`, unknown `--heat-0`; caption "31 finished, 2 errored, 1 stopped".
  - Row 4: review line. Worker: "Passed review 9, sent back 3, 18 not tied". Reviewer: "Gave
    PASS 128, sent back 69, no verdict 35". None: "No reviews yet".
  - Row 5: a 64x20 weekly-runs sparkline (12 weeks, 1.75 px `--accent`, the existing sparkline
    spec) and the top 2 project names as text, "+3" after.
- Detail sheet: 480 px side sheet, `sheet-in` 250 ms, Esc closes, focus returns to the card.
- States: loading = 6 skeleton cards (existing pulse); first index = skeletons plus "Reading
  your history. This runs once."; error = `ErrorBlock` "Atlas could not read the helper runs."
  + Try again; **no helpers** = Topo + 40 px spark + "No helpers yet. When Claude hands work to
  a helper (a subagent), its scorecard shows up here."; filter with no match = "No helper
  matches that name."; range with no runs = "No helper ran in the last 7 days."

### 3.2 Team > Caught in review
- One list of 48 px rows, not cards: rank (12, `--text-2`), the label (14, two lines max), the
  severity mix (12, "4 High, 2 Medium"), the count in Recursive 20, last seen ("3 days ago").
  Enter or click expands it (200 ms height; a fade only under reduced motion): examples, found
  in work by, reviewers, projects, then **Make this a rule** (`--accent-solid`, white text) or
  the line "Made a rule, Nov 9".
- Make-a-rule sheet (calm zone): the target radio, the resolved path in mono 12, the editor with
  the draft, a before/after preview of the last 6 lines of the target, Save and Cancel (Esc).
  Save is disabled while the text is empty.
- States: no reviewer runs -> Topo + spark + "Nothing caught yet. When a reviewer lists
  findings, the ones that keep coming back show up here."; reviewer runs but no theme -> "No
  repeats yet. 14 findings so far, none came up 3 times."; loading and error as 3.1.

### 3.3 Now > Helpers at work
- Section head like "Running" (`now-list-head`): "Helpers at work" + count. Rows 56 px:
  avatar 32 | name (14 semibold) over the goal (13, `--text-2`, one line, ellipsis, full text in
  `title`) | the trail, 200 px (120 px at 900 wide): a dotted 1.5 px `--line` path, an
  `--accent` fill up to the progress point and the 16 px spark at the far end, the goal (P3:
  the dotted path only) | progress text (12) | phase word or stuck line (13) | elapsed
  (Recursive 15) | tokens (Recursive 15, `data-opt` 2 so it drops first when narrow).
- The spark at the goal rests as a `--text-2` outline and fills `--accent` only when the helper
  finishes (one spark per row, marking completion); the row leaves 8 s later.
- No new colors; warning text uses `--warning`.

---

## 4. Build units and files

### Unit 1: helper ledger (core)
| File | Change |
|---|---|
| `crates/core/src/cache/migrate.rs` | `m0005`: `agent_runs`, `review_findings`, `agent_links`, `sessions.agent_setting`; `SCHEMA_VERSION` 5 |
| `crates/core/src/usage/line.rs` | parse `agentSetting`, `SendMessage` `to`/`recipient`, dispatch prompt id/branch mentions (in memory only), last assistant text per helper file |
| `crates/core/src/usage/ingest.rs` | fill the new tables; end status order (D3); `PARSER_VERSION` bump |
| `crates/core/src/usage/reviews.rs` (new) | verdict parse (D6), finding lines (D8), tie rules (D10), `VERDICTS`, `Thresholds` |
| `crates/core/src/usage/receipt_scan.rs` | `notices_in` made `pub(crate)` |
| `crates/core/src/textgroup.rs` (new, or from Skill Library Unit B) | D14 |
| `crates/core/src/usage/query.rs`, `crates/core/src/usage/mod.rs` | `agent_scorecard`, `review_themes`, `run_debrief` |
| `tools/make-fixtures.py`, `fixtures/claude-agents/` | worker -> reviewer -> SendMessage chain, a headless session, an `agentSetting` session, findings |
| `crates/core/tests/usage_agents.rs` | ledger tests |

### Unit 2: Team page
| File | Change |
|---|---|
| `src/lib/types.ts` | `View` adds `"team"` |
| `src/components/Sidebar.tsx`, `src/App.tsx`, `src/components/HelpSheets.tsx`, `src/lib/appMenu.ts` | nav item, route, shortcut list |
| `src/pages/Team.tsx`, `src/components/team/{ScoreCard,AgentSheet,ThemeList,RuleSheet}.tsx` (new) | screens 3.1, 3.2 |
| `src/styles/team.css` (new) | layered styles, tokens only |
| `src/lib/teamTypes.ts`, `src/lib/mockTeam.ts` (new), `src/lib/ipc.ts`, `src/lib/mock.ts` | IPC and mock backend |
| `crates/app/src/usage.rs`, `crates/app/src/main.rs` | `agent_scorecard`, `review_themes`, `make_rule_preview`, `make_rule_save` commands |
| `crates/core/src/setup_write.rs` | append-under-heading helper used by `make_rule_save` (through `apply_save`) |
| `src/lib/shotTour.ts` | Team shots |

### Unit 3: Now tracker
| File | Change |
|---|---|
| `crates/core/src/now/track.rs` | end rule D41, plan state, tool calls, last line time, open call |
| `crates/core/src/now/facts.rs` | plan shapes, test-run flag |
| `crates/core/src/now/model.rs`, `crates/core/src/now/mod.rs` | `NowHelper` fields, typical-run refresh |
| `crates/core/src/usage/query.rs` | `typical_runs(days)` |
| `src/lib/nowTypes.ts`, `src/lib/mockNow.ts` | types; mock rows for each progress kind and a stuck row |
| `src/pages/Now.tsx`, `src/components/now/HelperTracker.tsx` (new), `src/styles/now.css` | screen 3.3 |

### Unit 4: debrief
| File | Change |
|---|---|
| `crates/cli/src/main.rs`, `crates/cli/src/debrief.rs` (new) | `debrief` verb, D60-D61 |
| `skill/skills/atlas-debrief/SKILL.md` (new), `skill/.claude-plugin/plugin.json`, `skill/README.md` | D63; version bump with the release |
| `crates/mcp/src/server.rs`, `crates/mcp/src/usage.rs` | D65 tools |
| `docs/specs/mcp-server.md` | tool docs |

Unit 3 touches `usage/query.rs` too (one new function); merge Unit 1 first if both are open.

---

## 5. Acceptance criteria

### Unit 1
1. `cargo test -p atlas-core reviews::verdict` passes a table test: each D6 word maps to its
   class; `Verdict: pass` (any case, bold, colon or dash) -> pass; `STATUS: done` -> no
   verdict; an unknown word -> `other` with the word kept.
2. `cargo test -p atlas-core reviews::findings` passes: FINDINGS-section items and
   severity-led lines are found with their severity; lines under 12 or over 400 characters,
   code fences and masked lines are dropped; at most 40 per run.
3. `cargo test --test usage_agents` on the extended `fixtures/claude-agents` gives exact
   `agent_runs` rows: an end status from a notification, from `finished: true` and from a thread
   end; one L1 tie, one L2 tie, and one not-tied review that a SendMessage ties and marks sent
   back.
4. A test writes a fixture whose dispatch prompt holds `SENTINEL-PROMPT-7731` and whose finding
   holds a fake key; the cache file's bytes contain neither the sentinel nor the key.
5. A v4 cache opens, migrates to v5, re-reads once, and the dashboard totals equal a fresh
   index (existing migration test pattern).
6. A release run on the real corpus, read-only with a scratch `--data-dir`, logs the counts of
   reviewer runs, runs with a verdict, and runs tied by L1, L2 and sent back; the numbers go in
   MEMORY. Full re-read <= 20 s release (baseline 14.7 s).

### Unit 2
7. Team is the 5th sidebar item; `Ctrl+5` opens it and `Ctrl+6` opens History; Help >
   Keyboard shortcuts lists both (vitest).
8. Rust test on the fixture: `agent_scorecard(30d, all)` returns exact runs, tokens, median time
   running, ended counts, review counts, projects and 12 weekly buckets per type.
9. Started from Headless shows only the fixture's `sdk-cli` runs, Interactive the rest (vitest
   on the mock and a Rust test).
10. A worker card with under 5 tied reviews shows counts and no rate sentence; with 5 or more it
    shows "Passed N of M reviews" (vitest).
11. Card, Enter -> sheet; Esc -> focus back on the card; a recent-run row opens the helper's
    detail page (vitest).
12. Themes: a fixture with 4 rewordings of one finding across 3 runs plus 6 unrelated findings
    gives exactly one theme, count 4, with its found-in-work-by split; two runs give
    byte-identical JSON.
13. Make this a rule, CLAUDE.md target, on a `--config-dir` copy of `fixtures/claude-setup`:
    the file gains exactly the heading (if missing) and one line; every other byte (CRLF, BOM)
    is unchanged; a backup exists; History lists the change; Undo restores a sha256-identical
    file.
14. The rule-file target creates `rules/<slug>.md` through `create_apply`; Undo removes it.
15. Changing the target file between opening the sheet and Save refuses the save with "This
    file changed since you opened it." and writes nothing (Rust test).
16. A debug build refuses a rule save under the real Claude folder (existing guard test,
    extended).
17. Screens 3.1 and 3.2 at 1280x800 dark and light and 900x600 dark, from the real window
    (PrintWindow, debug exe with `custom-protocol`) on the fixture, saved in `docs/shots/team/`;
    the page itself never scrolls at 1280x800.
18. `fixtures/claude-basic` (no helpers) shows both empty states (screenshots); the first index
    shows skeletons, never an error; a forced IPC error shows the ErrorBlock with Try again.
19. `npm test` is green with the token contrast test unchanged; a search for hex colors in
    `src/components/team` and `src/styles/team.css` finds none; every new UI string is ASCII.
20. `[Will]` The Team page reads as Atlas (Trail Map), not a spreadsheet.

### Unit 3
21. Rust test: a helper with an open Bash call and no write for 90 s stays running; it ends on
    a notification, on `finished: true`, and on `end_turn` with no open call.
22. Rust test: a `TodoWrite` with 2 of 5 done -> plan {2, 5}; `update_plan` with `advance:true`
    and with `done:[0], start:1` moves it; a plan that never moved -> `plan: null`.
23. Rust test: 6 finished past code-reviewer runs with a median of 20 calls; a live one at 12
    calls -> `typical` set and the row text "About 60% of a typical run"; at 25 calls "Longer
    than a typical run"; with 4 past runs -> `typical: null` and "No past runs to compare".
24. Rust test: last 6 steps 4 reads + 2 edits -> "Reading"; a `cargo test` run -> "Testing";
    the snapshot JSON never contains the command line or the prompt (sentinel test).
25. Stuck: 5 min with no line and no open call -> "No progress for 5 min"; with an open `cargo`
    call -> "Running cargo for 5 min" (vitest, fake timers).
26. Anti-flicker (vitest, fake timers): 20 snapshot updates in 1 s cause at most one animated
    fill change and one phase swap; reduced motion -> no width transition.
27. With nothing running, Now starts no interval (existing cost test, extended); the medians are
    queried once at start and not again within 30 min (log line count).
28. A scripted fixture replay (lines appended to a scratch config dir) in the real window shows
    one row per progress kind plus a stuck row: screenshots 1280x800 dark and light and
    900x600 dark in `docs/shots/now-tracker/`.
29. `[Will]` During a real orchestrated run the tracker reads calm: no flicker, no nervous
    motion, and the progress words match what the helpers are doing.

### Unit 4
30. `atlas-usage debrief --session <fixture id> --config-dir fixtures/claude-agents --cache-dir
    <scratch>` exits 0 and prints at most 10 lines and 900 characters with `Ran`, `Helpers`,
    `Reviews` and `Tokens` lines (golden file test).
31. `--detail high` prints at most 40 lines and 3,000 characters with one line per helper.
32. `--json` returns the same facts as fields; an unknown session exits 2 with "No chat with
    that id."; a chat with no helpers prints a valid low debrief with "Helpers: none".
33. `--since` limits every figure to lines at or after that time (test with a mid-chat time).
34. A test reads `skill/skills/atlas-debrief/SKILL.md`: description + when_to_use <= 300
    characters, body <= 1,800 characters, `allowed-tools` lists only the launcher lines.
35. The MCP server lists `get_agent_scorecard`, `get_review_themes` and `get_run_debrief` with
    `read_only_hint`; `get_run_debrief` returns text byte-identical to the CLI for the same
    arguments (Rust test); none of them writes a file (directory mtime test).
36. No `skill/hooks/` folder ships (test), unless open question 3 changes it.
37. Measured token cost, recorded in MEMORY: in a scratch `CLAUDE_CONFIG_DIR`, with and
    without the plugin, the first-turn input token difference from the transcript's `usage`
    (listing cost); and the input growth after one low and one high debrief call in one chat.
38. `[Will]` On a real long run under a terse style the report gains 1-2 lines of key numbers;
    under a detailed style a short section; neither repeats facts the report already has.

## Done when
Units 1-4 are merged to `main`; criteria 1-37 carry evidence (test names, log lines,
screenshot paths, measured token numbers) and pass code-reviewer and verifier per unit;
`cargo test --workspace`, `npm test`, `tsc` and `clippy -D warnings` are green on the merged
tree; the plugin version is bumped with the next release so `atlas-debrief` ships; Will has
judged 20, 29 and 38.

## Risk-floor flags
- Not on the model-routing risk floor (no money, credentials, production deploy or installer
  code) and no gate-list step. Releasing the plugin is not gated.
- Make this a rule writes Claude's configuration (Atlas's first safety invariant): Unit 2 needs
  code-reviewer and verifier, with the byte-preservation and stale-file checks (13-16).
- The cache now keeps masked reviewer finding text (D8): the reviewer checks the mask, the caps,
  and that no prompt text is stored (4).
- The MCP tools hand finding text to any Claude connected on the same machine: read-only and
  masked.
- If Unit 4 touches the plugin launcher's download code (it should not), that is installer
  code: opus code-reviewer with the security checklist.

## Suggested agent chain
Unit 1 (desktop-app-dev, sonnet; Rust) and Unit 3 (desktop-app-dev for the Rust, ui-builder for
the row; primary skill `ui-ux-pro-max`) in parallel worktrees -> after Unit 1 merges, Unit 2
(ui-builder + desktop-app-dev) and Unit 4 (desktop-app-dev) in parallel -> per unit a
code-reviewer in parallel with a verifier -> design-reviewer on `docs/shots/team/` and
`docs/shots/now-tracker/` -> Will (20, 29, 38). Coordinate `textgroup.rs` with Skill Library
Unit B (whoever lands first owns it).

## Will's answers (2026-11-09) - these override D20 and criterion 7
- Team placement: **a tab inside Toolkit** (next to Your setup and Library), not a sidebar page.
  Its two views (Scorecard, Caught in review) become a segmented switch inside that tab. No new
  sidebar item, no Ctrl+5 change; criterion 7 becomes "Team is a Toolkit tab, reachable by keyboard".
- Clients: left out of v1 (group by project folder only).
- Dollars: hover only. History: show "History covers the last N days", no setting change.
- Tracker text: counts only. Trigger: the skill only (no Stop hook). (spec-writer picks, unchanged)

## Open questions (answered above)
1. Clients: (a) leave out in v1 (pick), (b) map project folders to clients in Settings,
   (c) treat a parent folder as the client.
2. Plan step text in the tracker: (a) counts only, "Step 3 of 6" (pick), (b) also the active
   step's text, masked, 60 characters.
3. End-of-run trigger: (a) the skill only (pick), (b) also an opt-in Stop hook, off by default.
4. Team placement: (a) a sidebar page after Toolkit (pick), (b) a tab inside Toolkit.
5. Dollars on Team cards: (a) hover only, as everywhere outside Toolkit (pick), (b) on the card,
   for a consultant who bills clients.
6. History depth: transcripts are deleted after `cleanupPeriodDays` (default 30): (a) say
   "History covers the last N days" on Team (pick), (b) offer to raise the setting.

## Not verified
- How Sam's own setup records his named agents (as subagent types, as `agentSetting` main
  chats, or as separate SDK sessions); the spec covers the first two, which are proven here.
- `cli`, `sdk-ts` and `sdk-py` entrypoints (prefix rule only; not seen on this machine).
- Whether a Stop hook's `additionalContext` reaches the model on 2.1.296.
- All token figures are character estimates until criterion 37.

## Unit 2 build notes (2026-11-09)
- D21 deviation, kept (coordinator, code review of bde78b9): the Team tab's range, Started from
  and view are UI prefs stored in the browser's localStorage (`atlas.team.prefs`,
  `atlas.toolkit.tab`), the same pattern as other view prefs, not in `settings.json`.
- History has no Undo button, by design: Undo is the toast's action right after the change. A
  rule made from Team is in History as "Instruction file changed" with its backup, and "Copy this
  version" / "Save a copy" bring the old bytes back.
- Ctrl+K to a Toolkit item while on the Team tab brings the "Your setup" tab forward, then opens
  the item.
- Make this a rule: a project target is identified by its folder (`project:<folder>`), checked
  against the scan on Save; the draft is redacted (secrets masked, `@imports`, backticks and
  markdown links removed, 160 characters); Save accepts exactly one `- ` line, no heading or code
  fence, up to 400 characters; a line already in the file is not added twice.
