//! The three helper-report tools (docs/specs/agent-scorecard.md, Unit 4, D65). A child module of
//! `server` so the tools join the same server, in their own block.
//!
//! All three are read-only and work in direct and propose mode alike: they read the usage index
//! (the transcripts are only read; the index lives in Atlas's own data folder) and write nothing
//! in the user's Claude folder. Finding text is masked before it is stored, and `get_run_debrief`
//! returns the same text as `atlas-usage debrief`, from the same renderer.

use std::sync::Arc;

use atlas_core::usage::debrief_text::{self, Options};
use atlas_core::usage::scorecard::{DebriefArgs, ScorecardArgs, StartedFrom, ThemeArgs};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::schemars::JsonSchema;
use rmcp::{ErrorData, tool, tool_router};
use serde::Deserialize;
use serde_json::json;

use super::{AtlasServer, fail, ok};

/// Helper types a scorecard answer lists unless `limit` says otherwise (most runs first).
const DEFAULT_TYPES: u32 = 15;

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase")]
pub struct ScorecardToolArgs {
    /// Only runs that started in the last this many days (default: all the history Atlas has).
    pub days: Option<u32>,
    /// Only this helper type, by its name (for example `code-reviewer`). Also adds its newest runs.
    pub agent_type: Option<String>,
    /// all (default), interactive (started in a Claude Code chat) or headless (started by `claude -p` or the SDK).
    pub started_from: Option<String>,
    /// At most this many helper types, most runs first (default 15, at most 50).
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase")]
pub struct ThemesToolArgs {
    /// Only findings from runs in the last this many days (default: all history).
    pub days: Option<u32>,
    /// At most this many themes (1 to 20, default 8).
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase")]
pub struct DebriefToolArgs {
    /// The chat's session id (the id of this conversation, or any past chat).
    pub session_id: String,
    /// Only what happened at or after this time: an ISO time (2026-11-09T14:00:00Z), a day, or epoch milliseconds. Default: the start of the chat.
    pub since: Option<String>,
    /// low (default: at most 10 lines) or high (at most 40 lines, one line per helper).
    pub detail: Option<String>,
    /// Add an estimate in dollars at API prices to the Tokens line. Only when the user asks about cost.
    pub include_cost: Option<bool>,
}

const BUSY: &str = "Atlas hit an internal error.";

fn text(t: String) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(t)])
}

#[tool_router(router = scorecard_router, vis = "pub(crate)")]
impl AtlasServer {
    #[tool(
        name = "get_agent_scorecard",
        description = "How the user's Claude Code helpers (subagents) have done, one card per helper type: runs, how they ended, finish rate, median tool calls and working time, tokens, the models and reasoning efforts they ran on, how their reviews went (a reviewer's verdicts, or a worker's passed and sent-back reviews) and the projects they ran in. Counts and facts from the chats on this computer, never a grade; a rate is given only with enough runs. Filters: days, agentType, startedFrom. Without agentType the per-run lists are left out. Read-only. The first call may take a while while Atlas reads the chats.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn get_agent_scorecard(&self, Parameters(a): Parameters<ScorecardToolArgs>) -> Result<CallToolResult, ErrorData> {
        let started_from = match a.started_from.as_deref().map(str::trim).map(str::to_lowercase).as_deref() {
            None | Some("") | Some("all") => StartedFrom::All,
            Some("interactive") => StartedFrom::Interactive,
            Some("headless") => StartedFrom::Headless,
            Some(_) => return Ok(fail("startedFrom: use all, interactive or headless.")),
        };
        let one_type = a.agent_type.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string);
        let args = ScorecardArgs { days: a.days, agent_type: one_type.clone(), started_from };
        let limit = a.limit.unwrap_or(DEFAULT_TYPES).clamp(1, 50) as usize;
        let usage = Arc::clone(&self.usage);
        let r = tokio::task::spawn_blocking(move || usage.scorecard(&args)).await;
        Ok(match r {
            Ok(Ok(mut sc)) => {
                let total_types = sc.types.len();
                sc.types.truncate(limit);
                if one_type.is_none() {
                    for t in &mut sc.types {
                        t.recent.clear();
                    }
                }
                let mut v = serde_json::to_value(&sc).unwrap_or_default();
                if let Some(o) = v.as_object_mut() {
                    o.insert("typesTotal".into(), json!(total_types));
                    o.insert("costNote".into(), json!("Dollar figures are estimates at API prices, not a bill."));
                }
                ok(&v)
            }
            Ok(Err(e)) => fail(e),
            Err(_) => fail(BUSY),
        })
    }

    #[tool(
        name = "get_review_themes",
        description = "What reviewer helpers (code reviewers, verifiers) keep raising across the user's chats: findings grouped by what they say, with how many findings and runs, severities, which worker types the reviewed work came from, and a few examples. Finding text is secret-masked and cut short. A theme needs several findings from several runs, so a quiet history returns none. Read-only. The first call may take a while while Atlas reads the chats.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn get_review_themes(&self, Parameters(a): Parameters<ThemesToolArgs>) -> Result<CallToolResult, ErrorData> {
        let args = ThemeArgs { days: a.days, limit: Some(a.limit.unwrap_or(8).clamp(1, 20)) };
        let usage = Arc::clone(&self.usage);
        let r = tokio::task::spawn_blocking(move || usage.themes(&args)).await;
        Ok(match r {
            Ok(Ok(t)) => ok(&t),
            Ok(Err(e)) => fail(e),
            Err(_) => fail(BUSY),
        })
    }

    #[tool(
        name = "get_run_debrief",
        description = "A short plain-words debrief of what one chat's helpers did: how long the run took, how many helpers and how they ended, the models and reasoning efforts, what the reviewers said (passed, asked for changes, sent back), tokens, anything still open and what reviewers caught. Facts only, a few lines: fold them into the report you are writing, in the user's own style and length. The same text as `atlas-usage debrief`. Detail high adds one line per helper. Read-only. The first call may take a while while Atlas reads the chats.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn get_run_debrief(&self, Parameters(a): Parameters<DebriefToolArgs>) -> Result<CallToolResult, ErrorData> {
        let high = match a.detail.as_deref().map(str::trim).map(str::to_lowercase).as_deref() {
            None | Some("") | Some("low") => false,
            Some("high") => true,
            Some(_) => return Ok(fail("detail: use low or high.")),
        };
        let since = match a.since.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(debrief_text::parse_since).transpose() {
            Ok(s) => s,
            Err(e) => return Ok(fail(e)),
        };
        let args = DebriefArgs { session_id: a.session_id.trim().to_string(), since };
        let opts = Options { high, cost: a.include_cost.unwrap_or(false) };
        let usage = Arc::clone(&self.usage);
        let r = tokio::task::spawn_blocking(move || usage.debrief(&args)).await;
        Ok(match r {
            Ok(Ok(Some(d))) => text(debrief_text::render(&d, &opts)),
            Ok(Ok(None)) => fail("No chat with that id."),
            Ok(Err(e)) => fail(e),
            Err(_) => fail(BUSY),
        })
    }
}
