---
name: atlas
description: Shows the user's Claude Code token usage right in the chat, with the same numbers as the Atlas app - this chat, today, this week, last week, the last 7 or 30 days, a month, a date range, this project or all time, and comparisons like last week vs this week. Charts are drawn as text bars.
when_to_use: Use whenever the user asks about their own Claude Code usage, tokens or spend, with or without typing /atlas. Examples - "what's my usage this week", "how many tokens has this chat used", "what's my usage for this chat looking like", "usage for this project", "last week vs this week", "how much did I use today", "which models did I use most this month", "what did yesterday cost". Not for questions about API pricing in general or another person's account.
argument-hint: "[this chat | today | yesterday | this week | last week | 7d | 30d | this month | last month | all | project | YYYY-MM-DD..YYYY-MM-DD] [vs <scope>]"
allowed-tools: Bash(atlas-usage *), Bash("${CLAUDE_SKILL_DIR}/bin/atlas-usage" *), Bash(${CLAUDE_SKILL_DIR}/bin/atlas-usage *), PowerShell(atlas-usage *), PowerShell(& "${CLAUDE_SKILL_DIR}/bin/atlas-usage" *)
---

# Atlas usage in chat

The `atlas-usage` program reads this computer's Claude Code transcripts (read-only) with
the Atlas app's own engine and prints finished markdown: a headline, text bar charts and a
few short tables. Your job is to pick the scope, run it once, and show its output.

The user asked: `$ARGUMENTS`
(Empty means `/atlas` with nothing after it, or you were invoked from a plain question:
then use the user's latest message instead.)

## 1. Pick the scope words

| The user means | Words to pass |
|---|---|
| this chat, this conversation, nothing specific (`/atlas` alone) | `chat` |
| today / yesterday | `today` / `yesterday` |
| this week, so far this week | `week` |
| last week, previous week | `last-week` |
| past 7 days, past 30 days, past N days | `7d` / `30d` / `<N>d` |
| this month / last month | `month` / `last-month` |
| all time, ever, total | `all` |
| a day or a range | `2026-11-02` or `2026-11-02..2026-11-07` (resolve "Monday", "Nov 3" etc. against today's date) |
| this project, this repo, this folder | add `project` (alone = all time; with a range = that range, e.g. `project week`) |
| a named project ("usage for atlas") | add `--project=<name>` |
| A vs B, compared to, versus | `<A> --vs <B>`, e.g. `last-week --vs week` |
| top N, more rows | `--top <N>` |

## 2. Run it (one command)

Always pass this chat's id so "this chat" and the defaults are exact:

```
atlas-usage <words> --session ${CLAUDE_SESSION_ID}
```

- If `atlas-usage` is not on PATH, run the copy next to this skill instead:
  `"${CLAUDE_SKILL_DIR}/bin/atlas-usage" <words> --session ${CLAUDE_SESSION_ID}`
- Use a long timeout (600000 ms). The first run indexes every transcript and can take a
  minute; later runs take under a second.
- Never read transcript files yourself and never compute usage numbers by hand: the
  numbers must match the Atlas app.

## 3. Show the result

- Your reply starts with the program's stdout, copied character for character: same
  lines, same order, same words, bold and ```text blocks kept (the bars only line up inside
  them). No preamble, no headings of your own, no rewording, no re-rounding.
- After it, at most one short sentence of your own if it helps (the biggest day, a big
  change). No extra tables. Do not mention which copy of the program ran.
- Dollar figures are API-price estimates, not a bill; never present them as charges.
- If the output says no session id was given or it fell back to the newest chat in the
  project, keep that line.
- Optional: if a visual tool such as `show_widget` is available and the user asks for a
  richer chart, run the same command again with `--json` and draw from those numbers. The
  text output must still be shown and stand on its own.

## If it fails

- `command not found` for both: tell the user in one line that the `atlas-usage` program is
  not installed and point them to the Atlas skill README (build with
  `cargo install --path crates/cli` from the Atlas repo, or put the prebuilt binary in
  `${CLAUDE_SKILL_DIR}/bin/`). Do not try to work the numbers out another way.
- Any other error: show the error line as-is and suggest the closest valid scope from the
  table above.

This works in Claude Code (terminal, desktop app Code tab, IDE extensions), where the
transcripts live on this computer. It cannot work in claude.ai web chat.
