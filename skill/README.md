# Atlas skill: your Claude Code usage in chat

Type `/atlas` in a Claude Code chat to see what this chat has used, or ask in plain words
("what's my usage this week", "how many tokens has this chat used", "usage for this
project", "last week vs this week"); Claude picks the skill up on its own. The numbers come
from the same engine as the Atlas app, so a day here equals that day's bar in the app.

**Where it works:** Claude Code - the terminal, the desktop app's Code tab and the IDE
extensions. It reads the transcripts Claude Code keeps on this computer, so it does **not**
work in claude.ai web chat.

**Read-only:** transcripts under `~/.claude` (or `CLAUDE_CONFIG_DIR`) are only read. The
index lives in Atlas's own data folder (`%LOCALAPPDATA%\atlas\cli` on Windows,
`~/Library/Application Support/atlas/cli` on macOS, `~/.local/share/atlas/cli` on Linux).

## What you get

- `/atlas` - this chat: headline tokens, cache reads apart, main chat vs helpers
  (subagents), model mix, the biggest helpers, activity per hour or day.
- `/atlas this week`, `last week`, `today`, `7d`, `30d`, `this month`, `all`, a date or
  `2026-11-02..2026-11-07` - headline, activity, models, projects, biggest sessions.
  Activity is a bar per day up to 14 days; from 15 days to 12 weeks it is the app's terrain
  grid (a cell per day, 7 days per row, today bottom-right, `▲` on the busiest day); longer
  ranges are a bar per week, then per month.
- `/atlas this project` (or `project last week`) - the same, for the current folder's project.
- `/atlas last week vs this week` - side by side with the change, by model and by project.

The look follows the app: the same names (Sessions, Models, Projects, Activity, Helpers,
"Today"), models named as the app names them ("Sonnet 5.5"), and tokens as the figure. Tokens
= input + output + cache writes; cache reads are shown apart. Numbers use 3 significant
digits (7.3k, 56.1M). The one dollar figure is the closing line, an API-price estimate, not a
bill.

Chat output has no colour of its own: Claude Code shows the text in your terminal's theme, so
the glyphs (`█ ▂ ▃ ▅ ▆ · ▲`) are all there is. If your terminal draws boxes for them, ask for
`--ascii` bars.

## Install

In Claude Code:

```
/plugin marketplace add dozeyy/atlas
/plugin install atlas@atlas
```

Then type `/atlas`. There is no binary to set up: the plugin's launcher uses the first of
these it finds:

1. `atlas-usage` on your PATH.
2. A copy it saved earlier (in `cache/<plugin version>/`, in the plugin's data folder when
   the shell has one, else inside the plugin's own folder).
3. The Atlas app's copy, next to `atlas.exe` in its install folder (by default
   `%LOCALAPPDATA%\Atlas\atlas-usage.exe`, Windows).
4. Otherwise it downloads the right build for your computer, once, after the first release
   exists: from the release tagged `v<plugin version>` of `dozeyy/atlas`, over HTTPS. The plugin ships `skill/skills/atlas/bin/checksums.txt`, a list of
   `<version> <file> <sha256>` lines fixed when that version was released. The download runs
   only if its SHA-256 equals the pinned line; otherwise it is deleted and never run. A plugin
   version with no pinned line downloads nothing: the launcher says to update the plugin.

If the download cannot work (offline, or no build for this computer yet), the launcher prints
one line saying what to do. The plugin version, the app version and the
release tag are one number. The saved copy lives in a folder named after it, so updating the
plugin fetches the matching build by itself and removes the older folder.

**Fallback, by hand** (no plugin): the program comes from the release downloads (the launcher
fetches it and checks it for you) or ships with the Atlas app. Take a build from the
[releases](https://github.com/dozeyy/atlas/releases) and put it on PATH, and copy
`skill/skills/atlas/` to `~/.claude/skills/atlas/`. Without the plugin there is no version to
download, so the launcher uses the program on PATH (or the Atlas app's copy).

**Releasing** (maintainers): with the built `atlas-usage-*` files from the same CI run in a
folder, run `pwsh tools/pin-skill-checksums.ps1 -Dir <folder> -Version <version>` and commit
the updated `skill/skills/atlas/bin/checksums.txt`. `-Version` must equal the version in
`skill/.claude-plugin/plugin.json`; the script hashes the files itself and refuses to change
the hashes of an already pinned version unless `-Force`.

When Claude picks the skill up from a plain question it uses the Skill tool; if your
permission mode asks, allow it once or add `Skill(atlas)` to `permissions.allow`. Typing
`/atlas` needs no approval, and the skill itself allows only its own launcher script.

The first run indexes every transcript (about a minute for a few GB); later runs take
under a second.

## Running the program directly

```
atlas-usage                      # this chat ($CLAUDE_CODE_SESSION_ID), markdown
atlas-usage last-week --vs week  # comparison
atlas-usage project 30d --json   # JSON for scripts
atlas-usage 30d --ascii          # plain # bars (or ATLAS_ASCII=1)
atlas-usage --help
```

## With or without the Atlas app

The plugin works on its own: install it and `/atlas` and the skill offers below both run, with
no Atlas app and no setup. The Atlas app adds a Claude connector (tools Claude can call to read
and manage your setup), saves a new skill with a backup you can undo in History, keeps the chat
index warm in the background so the first answer is instant, and shows the same usage as charts.

## Offers to make a skill (atlas-repeats)

The plugin carries a second, quiet skill. When you keep asking Claude for the same kind of
thing - 3 or more times in one chat, or 5 times across 3 chats on 2 days - it offers once, after
the task, to turn it into a skill. It looks only when your request says "again", "like last
time", "as usual" or "make this a skill", or you have asked the same thing 3 times in the chat.
It shows the draft, built from your own wording, and saves nothing until you say yes. Say no and
it never asks about that request again; say "stop asking" and it stops offering at all.

What stays where: the grouping is plain word matching on this computer (no AI call, no network
from the program), and `habits.json` holds ids and answers, never prompt text. But what the
program or connector returns is shown to Claude like any chat text, and so goes to Claude's
service as part of the conversation. By default that is only wordings you typed in the current
project (the counts include every project); wordings from other projects are returned only if
you ask for them.

It needs only this plugin. With the Atlas app and its Claude connector it uses the connector's
tools and saves with a backup. Without them it runs the same program as `/atlas`:

```
atlas-usage repeats --like "<the request>" --json   # what you keep asking, as JSON
atlas-usage offer-note <id> declined                # also: made, or `offer-note off`
```

The program reads your chats into its own index, newest first, for at most 20 seconds per run;
a run that cannot finish says so and the next one carries on, so it never holds up a task. If the
Atlas app's index is there and current it is used instead. A copy of the program from before this
feature is refused with one plain line ("too old for repeated requests") and the skill tells you
once to update. Answers are kept as ids in
`habits.json` in Atlas's data folder. Without the connector the skill writes the new skill to
`~/.claude/skills/<name>/SKILL.md` (never over an existing one) after you say yes.

Releasing: the `repeats` and `offer-note` commands exist only in builds from this change on, so
the plugin version bump (plugin, app and tag move together) and `pin-skill-checksums` must come
before this works for someone installing the plugin alone.
