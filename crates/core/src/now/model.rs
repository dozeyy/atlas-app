//! What the Now page receives. Everything here is safe to show: tool names, file paths,
//! the first word of a command, titles and numbers. No prompt or message text, ever
//! (`facts.rs` is the only place that turns a transcript line into these).

use serde::Serialize;

/// What a chat (or a helper) is doing right now, in words the page can show.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Doing {
    /// `read`, `edit`, `write`, `run`, `search`, `web`, `helper`, `plan`, `ask`, `tool`,
    /// `think` or `wait`: picks the icon.
    pub kind: String,
    /// "Editing", "Running", "Reading 3 files", "Waiting for you".
    pub verb: String,
    /// The file, command word or site the verb acts on (already shortened and masked).
    pub target: Option<String>,
}

/// One tool call on the trail.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowStep {
    /// The tool call's id: stable, so the page can animate only the new ones.
    pub id: String,
    pub kind: String,
    pub verb: String,
    pub target: Option<String>,
    pub ts_ms: i64,
    /// Its result has come back.
    pub done: bool,
    /// The helper that made the call, if it was not the chat itself.
    pub by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowHelper {
    pub id: String,
    pub name: String,
    pub doing: Option<Doing>,
    pub tokens: u64,
    pub cost_usd: Option<f64>,
    pub started_ms: Option<i64>,
    /// It said its last word; the page lets it linger a few seconds, then it is dropped.
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowFile {
    pub path: String,
    /// Changed (edited or written) rather than only read.
    pub edited: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowChat {
    pub session_id: String,
    pub title: Option<String>,
    /// The folder name of the chat's working directory.
    pub project: String,
    /// The model id as the transcript says it.
    pub model: Option<String>,
    /// `working` while it has something to do, `waiting` once it is the user's turn.
    pub state: String,
    /// When the current stretch of work began (the last prompt), epoch ms.
    pub started_ms: Option<i64>,
    /// While waiting: how long the last stretch of work took, ms.
    pub worked_ms: Option<i64>,
    /// Newest write to any of the chat's files, epoch ms.
    pub last_write_ms: i64,
    pub doing: Doing,
    /// Input + output + cache writes, summed over the chat and its helpers.
    pub tokens: u64,
    /// Estimated dollars (None when nothing could be priced).
    pub cost_usd: Option<f64>,
    pub unpriced: bool,
    pub helpers: Vec<NowHelper>,
    /// Newest first.
    pub files: Vec<NowFile>,
    /// Oldest first, the last few tool calls of the chat and its helpers.
    pub steps: Vec<NowStep>,
}

/// The chat that was written last, shown when nothing is running.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowLast {
    pub session_id: String,
    pub title: Option<String>,
    pub project: String,
    pub model: Option<String>,
    pub ended_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowSnapshot {
    /// Chats written to in the last couple of minutes, in the order they were first seen.
    pub chats: Vec<NowChat>,
    pub last: Option<NowLast>,
    /// Atlas has a folder to watch (false: no Claude folder).
    pub watching: bool,
}
