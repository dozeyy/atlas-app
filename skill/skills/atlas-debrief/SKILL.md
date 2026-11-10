---
name: atlas-debrief
description: Plain-words facts about what a chat's helpers (subagents) did, to fold into a recap of a helper run. Needs only this plugin.
when_to_use: Only when the user asks for a debrief or recap of a helper run, or an orchestrated run just ended and they asked for one. Never on your own initiative and never every turn.
allowed-tools: Bash(sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" debrief --session * --detail low*), Bash(sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" debrief --session * --detail high*)
---

# Debrief a helper run

Run this only because the user asked for a debrief or recap of the helpers, or asked for
one at the end of an orchestrated run. Otherwise say nothing about it.

## Get the facts

Run it with the Bash tool (on Windows that is Git Bash). Copy this command character for
character. Do not tidy or shorten the path, and keep the `..`: it is pre-approved only in
exactly this form, and any other spelling stops to ask the user.
`sh "${CLAUDE_SKILL_DIR}/../atlas/bin/atlas-usage.sh" debrief --session ${CLAUDE_SESSION_ID} --detail low`

- `--detail high` only if they want each helper listed.
- `--since <ISO time>` for just the latest run in a long chat.
- `--cost` only if they asked what it cost (an estimate, not a bill).
- Default timeout; never wait on it.

You get a few lines of facts: Ran, Helpers, Models, Reviews, Tokens, sometimes Biggest,
Open, Changed, Caught. Counts and labels, nothing graded.

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
- "No chat with that id" or no output: say you could not read this run, in one sentence.
- "Helpers: none": the chat used no helpers; say so briefly.
