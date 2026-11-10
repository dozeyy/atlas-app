---
name: atlas-debrief
description: Exact facts about this chat's helpers (subagents) - count, models and effort, tokens, how each ended, review verdicts.
when_to_use: Only when the user asks for detail on the helpers (agents, models, tokens). A plain "debrief me" gets your normal recap, no Atlas. Never on your own initiative, never every turn.
allowed-tools: Bash(sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" debrief --detail low), Bash(sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" debrief --detail high), Bash(sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" debrief --detail low --cost), Bash(sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" debrief --detail high --cost)
---

# Debrief a helper run

Only because the user asked for detail on the helpers: what each did, their models,
tokens or reviews. A plain "debrief me" or "what did you do" is your own normal recap:
do not run this. Never at the end of a run on its own. Otherwise say nothing about it.

## Get the facts

Run it with the Bash tool (Git Bash on Windows). Copy this command character for
character, keeping the `..`: it is pre-approved only in exactly this form.
`sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" debrief --detail low`

- It debriefs this chat. Do not add a session id.
- `--detail high` only if they want each helper listed.
- `--cost` after the detail only if they asked what it cost (an estimate, not a bill).

You get lines of facts: Ran, Helpers, Models, Reviews, Tokens, sometimes Biggest, Open,
Changed (worktree branches only), Caught.
A first line starting "Couldn't tell which chat this is" means the program picked the
newest chat itself: keep that line, word for word, before the facts.

## Say it in their style

Answer with these facts, the way the user likes reports.
Never impose a format.

- A terse user gets one or two lines. A detailed user gets a short section.
- An "Atlas" heading only if the report already has headed sections.
- Keep what matters: helpers that stopped or never finished, reviews that asked for
  changes, anything open. Never repeat a fact the report already states.
- No advice or grades.

## When it fails

- "too old for the debrief": say once, "Update the Atlas plugin or app to get debriefs."
- "Helpers: none": the chat used no helpers; say so briefly.
- Any other error or no output (for example exit 3): say in one sentence that you
  couldn't read this run. Don't retry or repeat the error text.
