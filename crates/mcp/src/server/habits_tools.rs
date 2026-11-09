//! The two repeated-request tools (docs/specs/skill-library.md, Unit B). A child module of
//! `server` so the tools join the same server, in their own block.
//!
//! `find_repeated_requests` only reads Atlas's chat index. `note_skill_offer` writes one small
//! file in Atlas's own data folder (`habits.json`: ids and answers, never any text), so it is
//! allowed in propose mode too: it changes nothing in the user's Claude folder.

use std::sync::Arc;

use atlas_core::habits::{FindArgs, NoteArgs};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::schemars::JsonSchema;
use rmcp::{ErrorData, tool, tool_router};
use serde::Deserialize;

use super::{AtlasServer, fail, ok};

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase")]
pub struct FindRepeatedArgs {
    /// The request in front of you, as the user typed it. Adds `likeMatch`: whether the user has
    /// asked this kind of thing before (even fewer times than the offer bar), and its group.
    pub like: Option<String>,
    /// Only requests asked within this many days (default 90, at most 365).
    pub days: Option<i64>,
    /// Only requests asked in this project (part of its folder name).
    pub project: Option<String>,
    /// At most this many groups (default 8, at most 20).
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
#[serde(rename_all = "camelCase")]
pub struct NoteOfferArgs {
    /// The `id` of a group from find_repeated_requests.
    pub group_id: Option<String>,
    /// Or the request's own text (used when you have no group id; only its fingerprint is kept).
    pub like: Option<String>,
    /// offered (you made the offer), declined (the user said no), made (a skill was saved) or
    /// never (the user said to stop asking: no offers at all from now on).
    pub answer: String,
    /// With `made`: the name of the skill that was saved.
    pub skill_name: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

const NOT_READY: &str = "Atlas could not start its repeated-requests reader.";

#[tool_router(router = habits_router, vis = "pub(crate)")]
impl AtlasServer {
    #[tool(
        name = "find_repeated_requests",
        description = "Find what the user keeps asking Claude for, across all their past Claude Code chats: requests typed by the user in different words that mean the same thing, counted over chats and days. Only what the user typed (never replies, helper chats, pasted logs or automatic prompts). Returns groups with a count, chats, days, projects, a representative request and a few other wordings, `meetsBar` (enough to offer a skill) and `offer` (what the user already said about it). Pass `like` with the request in front of you to ask 'has the user asked this before?'. Read-only; runs on this computer and nothing leaves it.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn find_repeated_requests(&self, Parameters(a): Parameters<FindRepeatedArgs>) -> Result<CallToolResult, ErrorData> {
        let Some(h) = self.habits.as_ref().map(Arc::clone) else { return Ok(fail(NOT_READY)) };
        let args = FindArgs { like: a.like, days: a.days, project: a.project, limit: a.limit };
        let r = tokio::task::spawn_blocking(move || h.find(&args, now_ms())).await;
        Ok(match r {
            Ok(Ok(v)) => ok(&v),
            Ok(Err(e)) => fail(e),
            Err(_) => fail("Atlas hit an internal error."),
        })
    }

    #[tool(
        name = "note_skill_offer",
        description = "Remember what happened when you offered to turn a repeated request into a skill, so the user is never asked twice about the same thing: answer `offered` (you asked), `declined` (they said no), `made` (a skill was saved, with skillName) or `never` (they said to stop asking: no more offers at all). Pass `groupId` from find_repeated_requests, or `like` with the request's text. Stores ids and answers only, in Atlas's own data folder, never any text. Changes nothing in the user's Claude folder.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn note_skill_offer(&self, Parameters(a): Parameters<NoteOfferArgs>) -> Result<CallToolResult, ErrorData> {
        let Some(h) = self.habits.as_ref().map(Arc::clone) else { return Ok(fail(NOT_READY)) };
        let args = NoteArgs { group_id: a.group_id, like: a.like, answer: a.answer, skill_name: a.skill_name };
        let r = tokio::task::spawn_blocking(move || h.note(&args, now_ms())).await;
        Ok(match r {
            Ok(Ok(v)) => ok(&v),
            Ok(Err(e)) => fail(e),
            Err(_) => fail("Atlas hit an internal error."),
        })
    }
}
