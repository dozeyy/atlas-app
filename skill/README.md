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

- `/atlas` - this chat: headline tokens, cache reads apart, API-price estimate, main
  thread vs helpers (subagents), model mix, the biggest helpers, activity per hour or day.
- `/atlas this week`, `last week`, `today`, `7d`, `30d`, `this month`, `all`, a date or
  `2026-11-02..2026-11-07` - headline, a bar per day (week or month for long ranges),
  model mix, top projects, biggest chats.
- `/atlas this project` (or `project last week`) - the same, for the current folder's project.
- `/atlas last week vs this week` - side by side with the change.

Tokens = input + output + cache writes; cache reads are shown apart. Numbers use 3
significant digits (7.3k, 56.1M). Dollar figures are API-price estimates, not a bill.

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
   exists: from the release tagged `v<plugin version>` of `dozeyy/atlas` (with `gh` if you are
   signed in to it, else HTTPS only). The plugin ships `skill/skills/atlas/bin/checksums.txt`, a list of
   `<version> <file> <sha256>` lines fixed when that version was released. The download runs
   only if its SHA-256 equals the pinned line; otherwise it is deleted and never run. A plugin
   version with no pinned line downloads nothing: the launcher says to update the plugin.

If the download cannot work (offline, or the repo is private and `gh` is not signed in), the
launcher prints one line saying what to do. The plugin version, the app version and the
release tag are one number. The saved copy lives in a folder named after it, so updating the
plugin fetches the matching build by itself and removes the older folder.

**Fallback, by hand** (no plugin):

- Build the program: `cargo install --path crates/cli` from this repo (it lands on PATH via
  `~/.cargo/bin`), or take a prebuilt one from the release and put it on PATH.
- Copy `skill/skills/atlas/` to `~/.claude/skills/atlas/`. Without the plugin there is no
  version to download, so the launcher uses the program on PATH (or the Atlas app's copy).
  `claude --plugin-dir <this repo>/skill` tries the plugin without installing it.

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
atlas-usage --help
```
