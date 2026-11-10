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
    /// Identical calls in a row folded into this step (1 = a single call).
    pub count: u32,
    /// The helper that made the call, if it was not the chat itself.
    pub by: Option<String>,
}

/// A helper's own task list, as counts only: "Step 3 of 6". Shown only once it has moved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCount {
    pub done: u32,
    pub total: u32,
}

/// What a typical run of this kind of helper looks like: the median of its finished runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Typical {
    /// Median tool calls.
    pub calls: u32,
    /// Median length, ms.
    pub ms: i64,
    /// How many finished runs the medians come from.
    pub runs: u32,
}

/// The tool call a helper is waiting on. Only a kind and one safe word, never the command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCall {
    pub kind: String,
    /// The program for a command ("cargo"), else "a helper", "the web" or "a tool".
    pub word: String,
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
    /// What kind of helper it is (`code-reviewer`), from the sidecar.
    pub agent_type: Option<String>,
    /// What it was sent to do: the dispatcher's short description (masked, at most 80 characters).
    pub goal: Option<String>,
    /// Tool calls made so far.
    pub tool_calls: u32,
    /// Its own task list, once it has one with 2 or more steps that has moved.
    pub plan: Option<PlanCount>,
    /// The typical run of this type (needs `MIN_TYPICAL_RUNS` finished runs), else None.
    pub typical: Option<Typical>,
    /// What it has mostly been doing in its last few calls ("Reading", "Testing").
    pub phase: String,
    /// When its newest line was written, epoch ms.
    pub last_line_ms: Option<i64>,
    /// The call it is waiting on, if one is open.
    pub open_call: Option<OpenCall>,
    /// The model id its newest lines name (`claude-opus-5-5`); the page turns it into "Opus 5.5".
    pub model: Option<String>,
    /// The effort level its newest line says (`high`). None when no line says one.
    pub effort: Option<String>,
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
    /// Everything the chat used while Atlas followed it. None for a chat that was already
    /// over when Atlas started (only the end of its transcript is read, so a total would lie).
    pub tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowSnapshot {
    /// Chats written to in the last couple of minutes, in the order they were first seen.
    pub chats: Vec<NowChat>,
    pub last: Option<NowLast>,
    /// The newest chats that are not running, newest first (`last` is the first of them).
    pub recent: Vec<NowLast>,
    /// Atlas has a folder to watch (false: no Claude folder).
    pub watching: bool,
}
