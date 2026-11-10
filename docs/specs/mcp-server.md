# Atlas MCP server (`atlas-mcp`)

Phase 5. A real MCP server over stdio so Claude Code (or any MCP client) can list and manage the
user's Claude Code setup through Atlas, with the same backups and History as the app.

Code: `crates/mcp` (server, usage summary), `crates/core/src/{ops,pending,connect,proc,writelock}.rs`
(shared logic), `crates/app/src/mcp_service.rs` (Connect / Disconnect commands),
`src/pages/Settings.tsx` ("Claude Code" section).

## How it runs

- `rmcp` 3.9.0, stdio transport only. The program never opens a socket or a port (a source-level
  test, `no_network_listener`, fails the build if a listener API appears).
- Flags: `--config-dir <dir>` (Claude folder), `--data-dir <dir>` (Atlas data: backups, queue,
  usage cache), `--propose [queue-dir]`. With no flags the folders resolve exactly like the app:
  flag, then `CLAUDE_CONFIG_DIR`, then `~/.claude`; data dir from `ATLAS_DATA_DIR` or the OS data dir.
- stdout is the protocol; everything else goes to stderr.
- Windows: built with the GUI subsystem (`windows_subsystem = "windows"`), so no console window can
  appear however it is started. Piped stdin/stdout still work (tested: PE subsystem check).

## Tools

| Tool | Writes | What it does |
|---|---|---|
| `list_items` | no | Everything in the setup (kind, scope, project, query, limit filters). Returns ids. |
| `read_item` | no | Text of one item plus `stamp` and whether it is editable or deletable. Secrets shown as dots. |
| `create_item` | yes | New skill, agent, command, rule, output style, hook, MCP server, CLAUDE.md in the user folder. Never replaces. |
| `update_item` | yes | Replaces the whole text. Refused on hidden secrets, on the mask dots, or if the file changed since `stamp`. |
| `rename_item` | yes | Skills (user scope), agents, commands, rules, output styles. |
| `delete_item` | yes | Moves the item into Atlas backups (restorable exactly). |
| `toggle_hook` | yes | Off parks the entry in a backup (`parked:<backupId>`); on puts it back where it was. |
| `toggle_mcp_server` | yes | Edits `projects[key].disabledMcpServers`. |
| `get_usage_summary` | no | Tokens, estimated cost, per model, top projects and chats for today / yesterday / 7d / 30d / month / all. |
| `list_backups` | no | Backups, newest first, with who made them. |
| `restore_backup` | yes | Undo from a backup; refuses to overwrite a file changed again since. |
| `find_repeated_requests` | no | Groups what the person typed in past chats (no AI, no network). Optional `like` (the request in front of Claude), `days`, `project`, `limit`, `currentProject` (default: the server's folder), `allProjectsText`. Returns `groups` (`id`, `count`, `sessions`, `days`, `representative`, `examples`, `meetsBar`, `offer`), `likeMatch`, `likeOffer`, `offersOff`, `offerBar`, `wordingsFrom`. The answer is shown to Claude, so wordings come only from `currentProject` unless `allProjectsText` is set (counts always span all projects). |
| `note_skill_offer` | no (Atlas data only) | Remembers the answer to an offer to make a skill: `answer` offered, declined, made or never, with `groupId` or `like`, and `skillName` for made. Writes ids only to `habits.json`. |
| `search_library` | no | Search the plugin catalog Atlas's Library saved (`<data>/library/catalog.json`): `{query, limit 1..20, default 10}` returns `{pluginId, name, description, marketplace, version, installed}`. Every word must match, the last as a prefix. No network, no command, nothing installed; with no catalog yet the error says to open Toolkit > Library once. |
| `get_agent_scorecard` | no | How the helpers (subagents) in past chats have done, one card per helper type: runs, how they ended, finish rate, medians, tokens, models and efforts, reviews, projects. Optional `days`, `agentType` (also returns that type's newest runs), `startedFrom` (all, interactive, headless), `limit` (types, default 15). Counts and facts, never a grade. |
| `get_review_themes` | no | What reviewer helpers keep raising, grouped, with counts, severities, the worker types the reviewed work came from and masked, cut-short examples. Optional `days`, `limit` (default 8). A quiet history returns no themes. |
| `get_run_debrief` | no | The after-run debrief of one chat as plain text (10 lines / 900 characters; `detail` high: 40 / 3,000): optional `sessionId` (left out: the newest chat that used helpers, and the first line of the text names which chat it picked), optional `since` (ISO time, day or epoch ms), `detail`, `includeCost`. The text is byte-identical to `atlas-usage debrief` because both call `usage::debrief_text::render`. |

Inputs are camelCase (`newName`, `backupId`). A failed call returns an MCP tool error with one plain
sentence, never a protocol error.

## Security model

- Reachable only by the program that starts it over a pipe. No port, no listener, no HTTP.
- Paths: only inside the Claude config root, or a known project directory from discovery.
  Anything else, including `..` escapes, is refused.
- Never exposed: `.credentials.json`, `sessions/*.key`, OAuth / admin keys. Not listed, not readable,
  not writable (tests try each, with a tree snapshot before and after). Secret-looking values in
  readable files are masked; writing the mask back is refused.
- Direct mode (no `--propose`) is tagged `mcp` and is an **allow-list**: it may only create or edit
  Instructions, Rules, Output styles and plain markdown. Skills, agents and commands are allowed only
  as `.md` text with no `hooks`/`allowed-tools`-style frontmatter keys and no `!` command lines in
  the body; non-`.md` skill files and `Other` items are refused. Hooks, MCP servers, settings,
  permissions, the status line and `.claude.json` are never written in direct mode, and neither is
  turning an MCP server on or a parked hook back on. Those need the user's approval, which is propose
  mode. This stops a prompt-injected chat from planting a command that runs later.
- The header check parses the YAML the way the scanner does (merge keys applied), so quoted, flow,
  explicit and merge forms of `hooks` / `allowed-tools` / ... are seen; an unreadable or unclosed
  header is refused.
- Restore (`RestoreBackup`) in direct mode is decided from the files that would be written, not the
  manifest's `kind`: a backup of a code kind, `settings*.json`, `.claude.json` or `.mcp.json`, any
  file that is not `.md`, any path under `hooks/`, `scripts/` or `local/`, or text that carries code
  is refused.
- A proposal longer than `TEXT_CAP` (100k characters) is refused, so a card is never a cut-off
  version of what runs. A card for a change that runs commands says "This change runs commands".
  The card for a restore or a parked hook turned back on shows the content that comes back.
- `Ops::new` registers MCP servers through Claude Code's command by default (`with_cli` overrides;
  tests opt out). If the command stores the entry in its own form it still counts as added, with a
  note.
- Restore targets come from the backup manifest, so they are confined (`Confine`): the Claude root,
  `.claude.json`, and the known projects' `.claude` folders and root files only. A forged manifest
  pointing elsewhere is refused.
- A restore is applied once (manifest `restored` mark), takes a safety backup of the current file,
  re-reads right before writing and verifies after. An entry that is already in the list is not
  added a second time.
- Delete goes to the OS trash as well as the backups (`ATLAS_NO_TRASH=1` skips the trash for tests).
- Pending changes are re-previewed at apply time (`pending::verify`); a card that no longer matches
  what Atlas computes is marked failed, and the list shows the recomputed card (`pending::display`).
- `.claude.json` MCP-server creation goes through `claude mcp add-json` when the CLI is found; the
  guarded direct edit (size+mtime+bytes re-check before the rename, untouched-key check after) is the
  fallback. Residual risk: a rival write in the microseconds between the last look and the rename
  cannot be detected afterwards.
- Connect/Disconnect wait up to 15 s for the write lock, then say "Another Atlas change is in
  progress". Disconnect reports an unreadable settings file instead of treating it as gone.
- Every write: backup first, atomic write, read-back verify, cross-process write lock
  (`<data>/setup-backups/../write.lock`) shared with the app.
- Debug builds refuse writes under the real Claude folder (`fsutil::check_write_allowed`).

## Provenance in History

Each backup manifest carries `source`: `mcp` (direct mode) or `assistant` (propose mode applied by
Atlas). The History scan matches those backups to the version they produced (file key + sha256), to
removals, and to `.claude.json` changes (2-minute window), and stores the event source as
`atlas_mcp` / `atlas_assistant`. The app shows "Skill edited by Claude" and a source note. The
file watcher plus the history rescan make the app update by itself.

## Propose mode and the pending-changes queue

`atlas-mcp --propose <queue-dir>` (default `<atlas data dir>/pending-changes`). Write tools do not
touch the Claude folder; each records one `PendingChange` and tells Claude the change is waiting for
the user. Phase 6's assistant lists the queue, shows `before` / `after` as a diff and, on approval,
calls `pending::apply(ops, queue, id)`, which runs the stored `request` through `Ops::apply` (same
backup, atomic write and History tag). `pending::reject` only marks the file.

One file per change: `<queue-dir>/<id>.json`, pretty JSON, written atomically.
`id` = `<13-digit ms>-<4-digit counter>-<tool>` (sorts oldest first).

```json
{
  "schema": 1,
  "id": "1762690000000-0003-update_item",
  "createdMs": 1762690000000,
  "status": "pending",
  "tool": "update_item",
  "summary": "Change the skill \"ship\"",
  "kind": "skill",
  "name": "ship",
  "targetPath": "C:/Users/you/.claude/skills/ship/SKILL.md",
  "before": "old text ...",
  "after": "new text ...",
  "note": null,
  "request": { "tool": "update_item", "id": "...", "text": "new text ...", "file": null, "stamp": "..." },
  "source": "assistant",
  "resolvedMs": null,
  "result": null
}
```

- `status`: `pending`, `applied`, `rejected`, `failed`. Resolved files stay as a record
  (`resolvedMs`, `result` hold the outcome or the failure reason); `pending::prune` clears old ones.
- `before` is absent for a new item, `after` absent for a delete. For hooks and MCP servers the
  texts are the JSON entry.
- `request` is the exact value `Ops::apply` takes (tagged by `tool`): `create_item {kind, name, event?,
  text?}`, `update_item {id, text, file?, stamp?}`, `rename_item {id, new_name}`, `delete_item {id}`,
  `toggle_hook {id, enabled}`, `toggle_mcp_server {id, enabled, project?}`, `restore_backup {backup_id}`.
- An edit proposal is pinned to the file's stamp at proposal time, so approving after the file changed
  fails with a plain message instead of overwriting.

## Connect / Disconnect

Settings, "Claude Code" section. Commands: `mcp_status`, `mcp_connect`, `mcp_disconnect`.

- Connect runs Claude Code's own command: `claude mcp add-json -s user atlas '<json>'` (an existing
  registration pointing elsewhere is removed first). Disconnect: `claude mcp remove -s user atlas`.
  The command runs hidden (`CREATE_NO_WINDOW`), 25 s limit, with `CLAUDE_CONFIG_DIR` set when the
  Claude folder is not the default.
- Fallback, only when the command is missing or the file does not show the change afterwards: the
  one-key edit of `.claude.json` (`mcpServers.atlas` only): backup, re-read before the swap, atomic
  write, read-back proof that every other key is untouched.
- The registered JSON: `{"type":"stdio","command":"<absolute path of atlas-mcp>","args":[...],"env":{}}`.
  `args` carries `--config-dir` / `--data-dir` only when those were chosen explicitly.
- State is read from `.claude.json`: `connected` (command equals the shipped path), `moved`
  (registered to another path, offer Reconnect), `notConnected`.
- Sandbox Mode never connects (the sandbox is a copy). Debug builds refuse the real folder.

## Packaging

- Windows: `atlas-mcp.exe` is installed beside `atlas.exe` (`tauri.windows-bundle.conf.json`
  resources; `tools/build-setup.ps1` builds it first). The Setup exe embeds the NSIS installer, so it
  ships too.
- macOS: `Contents/Resources/atlas-mcp` through `tauri.macos-bundle.conf.json` (passed with
  `--config` in the workflows; not auto-merged so plain `cargo test` does not need the file).
- Atlas finds it next to the running exe, or in `../Resources`, and registers the absolute path.

## Repeated requests (find_repeated_requests, note_skill_offer)

Used only by the plugin skill `atlas-repeats` (`docs/specs/skill-library.md`, D30-D55). There is no
Habits screen in the app.

- Source: the chat search index (`msgs.origin` 0 or 1 only: what was typed, never assistant text,
  helper chats or pasted tool output). Read-only; a missing or old index returns one plain sentence.
- Grouping is deterministic: normalize, 5-gram shingles, 64-hash MinHash, banded candidates, then
  exact Jaccard >= 0.55 against the group's first member (no chaining). A group id is the first 16
  hex of the SHA-256 of that normalized first wording. Bar to offer: 5 asks across 3 chats on 2
  days within 90 days, or 3 asks in this chat; constants in `habits::cluster::Thresholds`.
- `habits.json` (Atlas data folder, atomic writes, schema-versioned): per group id its answer,
  time, optional skill name and `aliases` (ids of member wordings, so a group whose first wording
  changes is still recognised), plus a global `offersOff`. It never holds prompt text.
- Without the app: the same two operations are `atlas-usage repeats [--like TEXT] --json` and
  `atlas-usage offer-note <id|-> <made|declined|off>` in the plugin's CLI, on the same core code and
  the same `habits.json`. The CLI reads the app's index when it is usable and no chat file is newer
  than its last pass, else reads the transcripts itself into `<cache dir>/search.sqlite`, newest
  first, for at most 20 s per run (`ATLAS_USAGE_READ_SECS`); an unfinished read answers with what it
  has plus `"reading": true`, or one plain sentence when nothing is read yet. `offer-note` never
  starts a read. The launcher refuses a copy of `atlas-usage` that lacks these commands (exit 4).
- Privacy: grouping runs on this computer, but the tools' answers go into Claude's context. Wordings
  are therefore limited to the current project by default; a damaged `habits.json` turns offers
  off until fixed, and a bracketed harness line such as `[Request interrupted by user]` is never a
  request.

## Helper reports (get_agent_scorecard, get_review_themes, get_run_debrief)

Unit 4 of `docs/specs/agent-scorecard.md` (D60-D65). Read-only (`read_only_hint`), stdio only, and
present in direct and propose mode alike (nothing is queued or written).

- They read the usage index (`<data dir>/cli/cache.sqlite`, the same one `get_usage_summary` starts
  on first use) and the transcripts, never writing the Claude folder; a test compares every file and
  folder time under a scratch Claude folder before and after the calls. The first call waits up to
  90 s for the first read of the chats, else says so in one sentence.
- Finding text is secret-masked (`search::mask::mask_secrets`) before it is stored and cut short;
  a helper's goal on the debrief is the first line of its dispatch description, dropped if masking
  would change it, cut to 80 characters.
- `get_run_debrief` returns text, not JSON: Claude folds a few lines of facts into the report it is
  already writing, in the user's own style (the `atlas-debrief` skill says how). `atlas-usage debrief
  --json` carries the same facts as JSON.
- Files changed is not in the debrief: the ledger records no edits per helper, so `Changed` lists
  only worktree branches helpers worked on, labelled as branches (D61: v1 is branches only). Branch
  names are masked like goals. `Models` starts with the chat's own model and effort.
- The skill `atlas-debrief` does not need these tools: it calls the plugin's own `atlas-usage debrief`
  through the launcher (four exact `Bash(sh ".../atlas-usage.sh" debrief --detail low|high [--cost])` lines, no wildcard, so no other option such as `--cache-dir` is pre-approved; the program finds the chat from `CLAUDE_CODE_SESSION_ID`), so it works
  without the app. The launcher refuses a program that has no `debrief` command (exit 4).

## Console windows

Every child process Atlas spawns uses `CREATE_NO_WINDOW` (`atlas_core::proc::quiet`): `claude mcp`,
explorer / rundll32 helpers, the uninstaller hand-off. Detached relaunch spawns create no console
by construction (they start GUI programs). `atlas-mcp` is a GUI-subsystem program (above).

## Differences from the original spec

- `delete_item` goes to Atlas backups (restorable with `restore_backup`), not the OS trash.
- `create_item` is user scope only.
- `.claude.json` item edits use the direct one-key safe edit, not the CLI; the CLI is only used for
  Connect / Disconnect.
- Parked (turned-off) hooks are not yet shown on Setup; `list_items` lists them.
