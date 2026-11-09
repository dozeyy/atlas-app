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
- Restore (`RestoreBackup`) in direct mode is checked the same way: a backup of a code kind,
  `settings*.json`, `.claude.json` or `.mcp.json`, or one whose text carries code, is refused.
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
