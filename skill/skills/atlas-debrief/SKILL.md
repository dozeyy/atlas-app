---
name: atlas-debrief
description: Plain-words facts about what a chat's helpers (subagents) did, to fold into a recap of a helper run. Needs only this plugin.
when_to_use: Only when the user asks for a debrief or recap of a helper run, or an orchestrated run just ended and they asked for one. Never on your own initiative and never every turn.
allowed-tools: Bash(sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" debrief --detail low), Bash(sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" debrief --detail high), Bash(sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" debrief --detail low --cost), Bash(sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" debrief --detail high --cost)
---

# Debrief a helper run

Only because the user asked for a debrief or recap of the helpers, or for one at the end
of an orchestrated run. Otherwise say nothing about it.

## Get the facts

Run it with the Bash tool (on Windows that is Git Bash). Copy this command character for
character, keeping the `..`: it is pre-approved only in exactly this form.
`sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" debrief --detail low`

- It debriefs this chat. Do not add a session id.
- `--detail high` only if they want each helper listed.
- `--cost` after the detail only if they asked what it cost (an estimate, not a bill).
- Default timeout; never wait on it.

You get a few lines of facts: Ran, Helpers, Models, Reviews, Tokens, sometimes Biggest,
Open, Changed (worktree branches only), Caught. Counts and labels, nothing graded.
A first line starting "Couldn't tell which chat this is" means the program picked the
newest chat itself: keep that line, word for word, before the facts.

## Say it in their style

Fold the facts into the report you are already writing, the way the user likes reports.
Never impose a format.

- A terse user gets one or two lines. A detailed user gets a short section.
- An "Atlas" heading only if the report already has headed sections.
- Keep what matters: helpers that stopped or never finished, reviews that asked for
  changes, anything open. Never repeat a fact the report already states.
- No advice, grades or praise.

## When it fails

- "too old for the debrief": say once, "Update the Atlas plugin or app to get debriefs."
- "Helpers: none": the chat used no helpers; say so briefly.
- Any other error or no output (for example exit 3): say in one sentence that you
  couldn't read this run. Don't retry or repeat the error text.
