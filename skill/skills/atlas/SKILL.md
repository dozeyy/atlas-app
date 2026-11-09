---
name: atlas
description: Shows the user's Claude Code token usage right in the chat, with the same numbers as the Atlas app - this chat, today, this week, last week, the last 7 or 30 days, a month, a date range, this project or all time, and comparisons like last week vs this week. Charts are drawn in text: bars for a week or less, a terrain grid for a month.
when_to_use: Use whenever the user asks about their own Claude Code usage, tokens or spend, with or without typing /atlas. Examples - "what's my usage this week", "how many tokens has this chat used", "what's my usage for this chat looking like", "usage for this project", "last week vs this week", "how much did I use today", "which models did I use most this month", "what did yesterday cost". Not for questions about API pricing in general or another person's account.
argument-hint: "[this chat | today | yesterday | this week | last week | 7d | 30d | this month | last month | all | project | YYYY-MM-DD..YYYY-MM-DD] [vs <scope>]"
allowed-tools: Bash(sh "${CLAUDE_SKILL_DIR}/bin/atlas-usage.sh" *), PowerShell(powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/bin/atlas-usage.ps1" *)
---

# Atlas usage in chat

The `atlas-usage` program reads this computer's Claude Code transcripts (read-only) with
the Atlas app's own engine and prints finished markdown in the app's voice: a headline in
tokens, a text chart (bars, or the terrain grid for a month), the models, and a few short
tables. Your job is to pick the scope, run it once, and show its output.

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
| the user says the bars show as boxes or question marks | add `--ascii` (plain `#` bars) |

Build the command only from words in this table, dates and a project name made of letters,
digits, `-`, `_` and `.`. Never paste the user's own text into the command line.

## 2. Run it (one command)

Always pass this chat's id so "this chat" and the defaults are exact. The launcher finds
`atlas-usage` itself, or downloads it once on first use, and runs it with the words you give.

Windows (PowerShell):
```
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/bin/atlas-usage.ps1" <words> --session ${CLAUDE_SESSION_ID}
```

macOS / Linux (Bash; also works in Git Bash on Windows):
```
sh "${CLAUDE_SKILL_DIR}/bin/atlas-usage.sh" <words> --session ${CLAUDE_SESSION_ID}
```

- Use a long timeout (600000 ms). The first run downloads the program and indexes every
  transcript and can take a minute; later runs take under a second.
- Never read transcript files yourself and never compute usage numbers by hand: the
  numbers must match the Atlas app.

## 3. Show the result

- Your reply starts with the program's stdout, copied character for character: same
  lines, same order, same words, bold and ```text blocks kept (the bars only line up inside
  them). No preamble, no headings of your own, no rewording, no re-rounding.
- After it, at most one short sentence of your own, and only if it adds something the
  output does not say (a big change, the busiest day's cause). Usually none. No extra
  tables. Do not mention which copy of the program ran.
- Voice, the app's: plain, numbers first, sentence case. No greeting, no exclamation marks,
  no emoji, no jokes, no "Live". Say tokens, sessions and helpers, as the app does.
- Tokens are the figure. The one dollar number is the closing line, an API-price estimate;
  never lead with it, repeat it, or call it a charge or a bill.
- The chart glyphs (`█ ▏ ▂ ▃ ▅ ▆ · ▲`) are part of the output: keep them, and keep each
  chart inside its ```text block. `▲` marks the busiest day, `·` an idle one, and
  "Today" is the last row or cell.
- If the output says no session id was given or it fell back to the newest chat in the
  project, keep that line.
- Optional: if a visual tool such as `show_widget` is available and the user asks for a
  richer chart, run the same command again with `--json` and draw from those numbers. The
  text output must still be shown and stand on its own. In the JSON, `report.points` is
  one point per `report.bucket`: a day for ranges up to 84 days, a week up to 26 weeks, a
  month beyond; plot them as they come and label the buckets accordingly (the last day is
  "Today"). Draw it in Atlas's colours, not a
  default palette. Light (page `#FAF8F5`, text `#1F1D1A`): resting bars `#D07A55`, today
  and the busiest day clay `#C96442`, second series slate `#5B7083`, third sand `#A8875F`,
  idle `#F0EBE4`. Dark (page `#1F1F1E`, text `#ECECEA`): resting bars `#B4653F`, today and
  the busiest day clay `#E07A55`, slate `#8FA3B5`, sand `#C9A678`, idle `#2E2E2D`. Bars
  start at zero and never dip below the baseline. Label the last day "Today", mark only
  the busiest day, show tokens, and keep dollars out of it.

## If it fails

- A line starting `atlas-usage:` with exit code 3 comes from the launcher (no internet, no
  access to the download, checksum mismatch, no build for this computer). Show that line
  as-is; it says what to do. Do not try to work the numbers out another way.
- Any other error: show the error line as-is and suggest the closest valid scope from the
  table above.

This works in Claude Code (terminal, desktop app Code tab, IDE extensions), where the
transcripts live on this computer. It cannot work in claude.ai web chat.
