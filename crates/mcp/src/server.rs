//! The tools Claude sees. Each one is a thin wrapper over `atlas_core::ops::Ops`, so there is
//! one read path (the Setup scan) and one write path (`setup_write`) shared with the app.
//!
//! Direct mode applies a change and returns what happened. Propose mode (`--propose`) records
//! the change in the queue and returns its id; nothing on disk changes until the user approves
//! it in Atlas.

use std::path::PathBuf;
use std::sync::Arc;

use atlas_core::ops::{ListFilter, Ops, Write};
use atlas_core::pending;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::schemars::JsonSchema;
use rmcp::{ErrorData, ServerHandler, tool, tool_handler, tool_router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::usage::Usage;

mod habits_tools;
mod scorecard_tools;

const INSTRUCTIONS: &str = "Atlas reads and manages the user's Claude Code setup: skills, agents, slash commands, rules, output styles, hooks, MCP servers, instructions (CLAUDE.md) and settings. Start with list_items to find ids, then read_item. Every change is backed up first and can be undone with restore_backup. Secrets (keys, tokens, passwords) are never shown: a value you see as dots is hidden, never write the dots back. Items that hold secrets can be read but not edited here.";

#[derive(Clone)]
pub struct AtlasServer {
    ops: Arc<Ops>,
    /// Some(queue folder) = propose mode.
    propose: Option<PathBuf>,
    usage: Arc<Usage>,
    /// Repeated requests (`habits_tools`); set with `with_habits`.
    habits: Option<Arc<atlas_core::habits::Habits>>,
    tool_router: ToolRouter<Self>,
}

// ---------------------------------------------------------------- tool inputs

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase")]
pub struct ListArgs {
    /// Only this kind: skill, agent, command, rule, hook, hookScript, mcpServer, plugin, settings, permission, statusLine, outputStyle, instructions, autoMemory, agentMemory, workflow, keybindings or theme.
    pub kind: Option<String>,
    /// Only this scope: user, project, local, plugin, synced, managed or connector.
    pub scope: Option<String>,
    /// Only items of one project (its folder name, as listed in `projects` of an earlier result).
    pub project: Option<String>,
    /// Only items whose name or description contains this text.
    pub query: Option<String>,
    /// How many to return (default 40, at most 200).
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase")]
pub struct ReadArgs {
    /// The item's id from list_items.
    pub id: String,
    /// For a skill: a file inside its folder (one of `files` from an earlier read), instead of SKILL.md.
    pub file: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase")]
pub struct CreateArgs {
    /// What to create: skill, agent, command, rule, outputStyle, hook, mcpServer or instructions (a new CLAUDE.md).
    pub kind: String,
    /// Lowercase letters, numbers and dashes, like my-helper. For a hook this is ignored (use `event`).
    pub name: String,
    /// Hooks only: the event, for example PostToolUse or PreToolUse.
    pub event: Option<String>,
    /// The full text of the new item. Leave out to start from Atlas's template.
    pub text: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase")]
pub struct UpdateArgs {
    /// The item's id from list_items.
    pub id: String,
    /// The complete new text of the item (it replaces the old text).
    pub text: String,
    /// For a skill: edit this file inside its folder instead of SKILL.md.
    pub file: Option<String>,
    /// The `stamp` from read_item. If the item changed since, the edit is refused instead of overwriting.
    pub stamp: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase")]
pub struct RenameArgs {
    /// The item's id from list_items.
    pub id: String,
    /// The new name: lowercase letters, numbers and dashes.
    pub new_name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase")]
pub struct IdArgs {
    /// The item's id from list_items.
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase")]
pub struct HookArgs {
    /// The hook's id from list_items, or `parked:<backupId>` for a hook that is turned off.
    pub id: String,
    /// true = on, false = off.
    pub enabled: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase")]
pub struct McpToggleArgs {
    /// The MCP server's id from list_items.
    pub id: String,
    /// true = on, false = off.
    pub enabled: bool,
    /// Which project to turn it on or off for (its folder name). Leave out for every project that has it.
    pub project: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase")]
pub struct UsageArgs {
    /// today, yesterday, 7d (default), 30d, month or all.
    pub period: Option<String>,
    /// Only this project (part of its folder name).
    pub project: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase")]
pub struct BackupsArgs {
    /// How many, newest first (default 20, at most 200).
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase")]
pub struct RestoreArgs {
    /// The backup's id from list_backups, or `backupId` from an earlier change.
    pub backup_id: String,
}

// ---------------------------------------------------------------- results

fn pretty(v: &impl Serialize) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|_| "{}".into())
}

fn ok(v: &impl Serialize) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(pretty(v))])
}

fn fail(msg: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(msg)])
}

impl AtlasServer {
    pub fn new(ops: Ops, propose: Option<PathBuf>, usage: Usage) -> AtlasServer {
        AtlasServer { ops: Arc::new(ops), propose, usage: Arc::new(usage), habits: None, tool_router: Self::tool_router() + Self::habits_router() + Self::scorecard_router() }
    }

    pub fn with_habits(mut self, habits: atlas_core::habits::Habits) -> AtlasServer {
        self.habits = Some(Arc::new(habits));
        self
    }

    /// Run blocking work (file IO, the write lock, the usage index) off the async thread.
    async fn blocking<T: Send + 'static>(&self, f: impl FnOnce(&Ops) -> T + Send + 'static) -> Result<T, String> {
        let ops = Arc::clone(&self.ops);
        tokio::task::spawn_blocking(move || f(&ops)).await.map_err(|_| "Atlas hit an internal error.".to_string())
    }

    /// A write tool: applied now, or recorded for approval in propose mode.
    async fn write(&self, w: Write) -> CallToolResult {
        let queue = self.propose.clone();
        let r = self
            .blocking(move |ops| -> Result<Value, String> {
                match queue {
                    Some(queue) => {
                        let preview = ops.preview(&w)?;
                        let w = ops.pin_stamp(w);
                        let c = pending::propose(&queue, w, preview, "assistant").map_err(|e| format!("Atlas could not record the proposal: {e}"))?;
                        Ok(json!({
                            "proposed": true,
                            "status": "pending",
                            "changeId": c.id,
                            "summary": c.summary,
                            "note": "Nothing was changed. The change is waiting in Atlas for the user to approve or reject it."
                        }))
                    }
                    None => {
                        let a = ops.apply(&w)?;
                        Ok(serde_json::to_value(a).unwrap_or(Value::Null))
                    }
                }
            })
            .await;
        match r {
            Ok(Ok(v)) => ok(&v),
            Ok(Err(e)) | Err(e) => fail(e),
        }
    }
}

// ---------------------------------------------------------------- the tools

#[tool_router]
impl AtlasServer {
    #[tool(
        name = "list_items",
        description = "List what is set up in the user's Claude Code: skills, agents, slash commands, rules, hooks, MCP servers, output styles, instructions and more, from the user folder and from projects. Returns ids to use with the other tools, plus counts per kind and the project names. Read-only.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn list_items(&self, Parameters(a): Parameters<ListArgs>) -> Result<CallToolResult, ErrorData> {
        let f = ListFilter { kind: a.kind, scope: a.scope, project: a.project, query: a.query, limit: a.limit };
        Ok(match self.blocking(move |ops| ops.list_items(&f)).await {
            Ok(out) => ok(&out),
            Err(e) => fail(e),
        })
    }

    #[tool(
        name = "read_item",
        description = "Read one item's text (a skill's SKILL.md, an agent, a command, a rule, a hook or MCP entry, ...). Keys, tokens and passwords are shown as dots. Returns `stamp` (pass it to update_item to be sure nothing changed in between) and whether the item can be edited or deleted. Read-only.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn read_item(&self, Parameters(a): Parameters<ReadArgs>) -> Result<CallToolResult, ErrorData> {
        Ok(match self.blocking(move |ops| ops.read_item(&a.id, a.file.as_deref())).await {
            Ok(Ok(out)) => ok(&out),
            Ok(Err(e)) | Err(e) => fail(e),
        })
    }

    #[tool(
        name = "create_item",
        description = "Create a new skill, agent, slash command, rule, output style, hook, MCP server or CLAUDE.md in the user's Claude folder. Never replaces an existing item. Backed up and undoable. Hooks and MCP servers run commands, so they are only created with the user's approval (propose mode).",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false, open_world_hint = false)
    )]
    async fn create_item(&self, Parameters(a): Parameters<CreateArgs>) -> Result<CallToolResult, ErrorData> {
        Ok(self.write(Write::CreateItem { kind: a.kind, name: a.name, event: a.event, text: a.text }).await)
    }

    #[tool(
        name = "update_item",
        description = "Replace an item's whole text (read it first, change it, send the full new text). Backed up and undoable. Refused if the item holds hidden secrets, if the text contains the dots shown in place of secrets, or if it changed since the `stamp` you pass.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn update_item(&self, Parameters(a): Parameters<UpdateArgs>) -> Result<CallToolResult, ErrorData> {
        Ok(self.write(Write::UpdateItem { id: a.id, text: a.text, file: a.file, stamp: a.stamp }).await)
    }

    #[tool(
        name = "rename_item",
        description = "Rename a skill, agent, slash command, rule or output style. The old one is kept in the backups. Skills can only be renamed in the user folder.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = false)
    )]
    async fn rename_item(&self, Parameters(a): Parameters<RenameArgs>) -> Result<CallToolResult, ErrorData> {
        Ok(self.write(Write::RenameItem { id: a.id, new_name: a.new_name }).await)
    }

    #[tool(
        name = "delete_item",
        description = "Delete an item (a skill, agent, command, rule, hook, MCP server, ...). It is moved into Atlas's backups first, so restore_backup brings it back exactly. Items Atlas does not own (plugins, managed settings) can't be deleted.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = false)
    )]
    async fn delete_item(&self, Parameters(a): Parameters<IdArgs>) -> Result<CallToolResult, ErrorData> {
        Ok(self.write(Write::DeleteItem { id: a.id }).await)
    }

    #[tool(
        name = "toggle_hook",
        description = "Turn a hook off or back on. Off keeps the hook's entry in Atlas's backups (listed as `parked:<backupId>` by list_items) and back on puts it back exactly where it was.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn toggle_hook(&self, Parameters(a): Parameters<HookArgs>) -> Result<CallToolResult, ErrorData> {
        Ok(self.write(Write::ToggleHook { id: a.id, enabled: a.enabled }).await)
    }

    #[tool(
        name = "toggle_mcp_server",
        description = "Turn an MCP server (one kept in the user's Claude settings) on or off for a project, or for every project that has it. Takes effect the next time Claude Code starts there.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn toggle_mcp_server(&self, Parameters(a): Parameters<McpToggleArgs>) -> Result<CallToolResult, ErrorData> {
        Ok(self.write(Write::ToggleMcpServer { id: a.id, enabled: a.enabled, project: a.project }).await)
    }

    #[tool(
        name = "get_usage_summary",
        description = "How much Claude Code the user has used: tokens, an estimated cost at API prices (not a bill), per model (with its name and reasoning-effort mix), the biggest projects and chats. Periods: today, yesterday, 7d, 30d, month, all. The first call may take a while while Atlas reads the chats. Read-only.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn get_usage_summary(&self, Parameters(a): Parameters<UsageArgs>) -> Result<CallToolResult, ErrorData> {
        let usage = Arc::clone(&self.usage);
        let r = tokio::task::spawn_blocking(move || usage.summary(a.period.as_deref().unwrap_or("7d"), a.project.as_deref())).await;
        Ok(match r {
            Ok(Ok(v)) => ok(&v),
            Ok(Err(e)) => fail(e),
            Err(_) => fail("Atlas hit an internal error."),
        })
    }

    #[tool(
        name = "list_backups",
        description = "The backups Atlas made before each change, newest first: what changed, which file, who did it and whether it can be restored. Read-only.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn list_backups(&self, Parameters(a): Parameters<BackupsArgs>) -> Result<CallToolResult, ErrorData> {
        let limit = a.limit.unwrap_or(20);
        Ok(match self.blocking(move |ops| ops.list_backups(limit)).await {
            Ok(v) => ok(&json!({ "backups": v })),
            Err(e) => fail(e),
        })
    }

    #[tool(
        name = "restore_backup",
        description = "Undo a change from its backup (a deleted item comes back, an edit is reverted). If the file was changed again after that backup, nothing is overwritten and you are told.",
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = false)
    )]
    async fn restore_backup(&self, Parameters(a): Parameters<RestoreArgs>) -> Result<CallToolResult, ErrorData> {
        Ok(self.write(Write::RestoreBackup { backup_id: a.backup_id }).await)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for AtlasServer {
    fn get_info(&self) -> ServerConfig {
        let mut instructions = INSTRUCTIONS.to_string();
        if self.propose.is_some() {
            instructions.push_str(" This server is in propose mode: write tools do not change anything, they queue the change for the user to approve in Atlas.");
        }
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("atlas", env!("CARGO_PKG_VERSION")))
            .with_instructions(instructions)
    }
}
