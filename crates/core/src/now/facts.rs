//! One transcript line -> the few facts the Now page needs (and nothing else).
//!
//! This is the privacy boundary of the Now tab. A line is read for: its role, time and
//! working folder, the tool calls it makes (name, file, first word of a command), the ids
//! of tool results, the stop reason, titles, and token usage. Prompt text, assistant text,
//! tool output and tool input bodies are never copied out. Everything that does leave is
//! passed through the secret mask.

use std::borrow::Cow;

use memchr::memmem::Finder;
use serde::Deserialize;
use serde::de::IgnoredAny;

use crate::search::mask::mask_secrets;
use crate::usage::line::{LineEvent, MsgEvent, Prefilter};
use crate::usage::receipt_scan::{Notice, notices_in};
use crate::usage::time::parse_iso_ms;

/// Longest target shown for a file, command word or site.
const TARGET_CAP: usize = 56;

/// How a tool call reads on the page.
#[derive(Debug, Clone, PartialEq)]
pub struct Desc {
    pub kind: &'static str,
    pub verb: String,
    pub target: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolFact {
    pub id: String,
    pub desc: Desc,
    /// A file this call reads or changes: (short path, changed).
    pub touched: Option<(String, bool)>,
    /// A command that runs tests (matched on a fixed word list; only this yes/no is kept).
    pub test: bool,
    /// What the call does to the helper's task list, if it is a task-list tool.
    pub plan: Option<PlanOp>,
}

/// Where one step of a task list stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepState {
    Pending,
    Active,
    Done,
}

/// A change to a helper's task list. Only the states are read, never a step's text.
#[derive(Debug, Clone, PartialEq)]
pub enum PlanOp {
    /// The whole list (`TodoWrite` `todos`, an `update_plan` `items`).
    Set(Vec<StepState>),
    /// `update_plan {advance:true}`: finish the active step, start the next.
    Advance,
    /// `update_plan {done:[i], start:j}`, both 1-based.
    Mark { done: Vec<usize>, start: Option<usize> },
    /// `TaskCreate`: one more step.
    Add,
    /// `TaskUpdate {taskId, status}`.
    Update { id: String, status: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Assistant,
    /// A real prompt from the user (not a tool result, not a system note).
    Prompt,
    /// Tool results coming back.
    Result,
    Title,
    Other,
}

#[derive(Debug, Clone)]
pub struct Parsed {
    pub role: Role,
    pub ts_ms: Option<i64>,
    pub cwd: Option<String>,
    pub stop_reason: Option<String>,
    pub tools: Vec<ToolFact>,
    pub result_ids: Vec<String>,
    /// The user stopped the chat (Esc): nothing is running any more.
    pub interrupted: bool,
    /// `(from a custom-title line, title)`.
    pub title: Option<(bool, String)>,
    pub usage: Option<Box<MsgEvent>>,
    /// The effort level the line says it ran at (`high`), if it says one. Never guessed.
    pub effort: Option<String>,
    /// Helpers the parent says have ended (`<task-notification>` records): agent id and status.
    pub notices: Vec<Notice>,
}

pub struct Facts {
    pre: Prefilter,
    assistant: Finder<'static>,
    user: Finder<'static>,
    titles: [Finder<'static>; 2],
    /// A notification only counts at the start of a field, as Claude Code writes it; a file or
    /// tool result that quotes the marker carries it mid-string.
    notice: [Finder<'static>; 2],
}

impl Default for Facts {
    fn default() -> Self {
        Facts::new()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw<'a> {
    #[serde(rename = "type", borrow)]
    ty: Cow<'a, str>,
    #[serde(borrow, default)]
    timestamp: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    cwd: Option<Cow<'a, str>>,
    #[serde(default)]
    is_meta: Option<bool>,
    #[serde(borrow, default)]
    message: Option<Msg<'a>>,
    #[serde(borrow, default)]
    custom_title: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    agent_name: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    effort: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    per_turn_effort: Option<Cow<'a, str>>,
}

#[derive(Deserialize)]
struct Msg<'a> {
    #[serde(borrow, default)]
    stop_reason: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    content: Option<Content<'a>>,
}

/// Blocks, or a plain string (a typed prompt). The string is never kept.
#[derive(Deserialize)]
#[serde(untagged)]
enum Content<'a> {
    Blocks(#[serde(borrow)] Vec<Block<'a>>),
    Text(IgnoredAny),
}

#[derive(Deserialize)]
struct Block<'a> {
    #[serde(rename = "type", borrow, default)]
    ty: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    id: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    name: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    tool_use_id: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    input: Option<Input<'a>>,
    /// Only looked at for the stop marker; never kept.
    #[serde(borrow, default, deserialize_with = "text_or_none")]
    text: Option<Cow<'a, str>>,
}

/// One step of a task list: only its state is read, never its text.
#[derive(Deserialize, Default)]
struct StepIn {
    #[serde(default, deserialize_with = "lenient")]
    status: Option<String>,
}

/// `TaskUpdate`'s id, written as a string or a number.
#[derive(Deserialize)]
#[serde(untagged)]
enum TaskId {
    Text(String),
    Num(i64),
}

/// The only tool input fields that are read. Each is a path, a command, a site, a type name or
/// a task-list state; a body (`content`, `old_string`, `prompt`...) is not even named here.
#[derive(Deserialize, Default)]
struct Input<'a> {
    #[serde(borrow, default, deserialize_with = "text_or_none")]
    file_path: Option<Cow<'a, str>>,
    #[serde(borrow, default, deserialize_with = "text_or_none")]
    notebook_path: Option<Cow<'a, str>>,
    #[serde(borrow, default, deserialize_with = "text_or_none")]
    command: Option<Cow<'a, str>>,
    #[serde(borrow, default, deserialize_with = "text_or_none")]
    url: Option<Cow<'a, str>>,
    #[serde(borrow, default, deserialize_with = "text_or_none")]
    subagent_type: Option<Cow<'a, str>>,
    #[serde(borrow, default, deserialize_with = "text_or_none")]
    skill: Option<Cow<'a, str>>,
    #[serde(default, deserialize_with = "lenient")]
    todos: Option<Vec<StepIn>>,
    #[serde(default, deserialize_with = "lenient")]
    items: Option<Vec<StepIn>>,
    #[serde(default, deserialize_with = "lenient")]
    advance: Option<bool>,
    #[serde(default, deserialize_with = "lenient")]
    done: Option<Vec<i64>>,
    #[serde(default, deserialize_with = "lenient")]
    start: Option<i64>,
    #[serde(default, deserialize_with = "lenient", rename = "taskId")]
    task_id: Option<TaskId>,
    #[serde(borrow, default, deserialize_with = "text_or_none")]
    status: Option<Cow<'a, str>>,
}

/// A field of an unexpected shape reads as absent instead of failing the whole line.
fn lenient<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Any<T> {
        Ok(T),
        Other(IgnoredAny),
    }
    Ok(match Any::<T>::deserialize(d)? {
        Any::Ok(t) => Some(t),
        Any::Other(_) => None,
    })
}

/// A field that is not a string (a surprise in some tool) reads as absent instead of
/// failing the whole line.
fn text_or_none<'de, 'a, D>(d: D) -> Result<Option<Cow<'a, str>>, D::Error>
where
    D: serde::Deserializer<'de>,
    'de: 'a,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Any<'a> {
        Text(#[serde(borrow)] Cow<'a, str>),
        Other(IgnoredAny),
    }
    Ok(match Any::deserialize(d)? {
        Any::Text(t) => Some(t),
        Any::Other(_) => None,
    })
}

impl Facts {
    pub fn new() -> Facts {
        let f = |s: &'static str| Finder::new(s.as_bytes()).into_owned();
        Facts {
            pre: Prefilter::new(),
            assistant: f(r#""type":"assistant""#),
            user: f(r#""type":"user""#),
            titles: [f(r#""type":"custom-title""#), f(r#""type":"agent-name""#)],
            notice: [f(r#""content":"<task-notification>"#), f(r#""text":"<task-notification>"#)],
        }
    }

    /// Read one line (without its newline). `None` for every line type the page ignores.
    pub fn parse(&self, line: &[u8]) -> Option<Parsed> {
        let is_asst = self.assistant.find(line).is_some();
        let is_user = !is_asst && self.user.find(line).is_some();
        let is_title = !is_asst && !is_user && self.titles.iter().any(|f| f.find(line).is_some());
        // Which helpers ended: a record in the parent chat (a queued line or a user line).
        let has_notice = !is_asst && self.notice.iter().any(|f| f.find(line).is_some());
        if !(is_asst || is_user || is_title || has_notice) {
            return None;
        }
        let raw: Raw = serde_json::from_slice(line).ok()?;
        let ts_ms = raw.timestamp.as_deref().and_then(parse_iso_ms);
        let cwd = raw.cwd.filter(|c| !c.is_empty()).map(Cow::into_owned);
        let mut out = Parsed {
            role: Role::Other,
            ts_ms,
            cwd,
            stop_reason: None,
            tools: Vec::new(),
            result_ids: Vec::new(),
            interrupted: false,
            title: None,
            usage: None,
            effort: None,
            notices: Vec::new(),
        };
        if has_notice {
            notices_in(line, &mut out.notices);
        }
        match raw.ty.as_ref() {
            "custom-title" | "agent-name" => {
                let custom = raw.ty == "custom-title";
                let t = if custom { raw.custom_title } else { raw.agent_name };
                if let Some(t) = t.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
                    out.role = Role::Title;
                    out.title = Some((custom, clean(&t, 80)));
                }
            }
            "assistant" => {
                out.role = Role::Assistant;
                out.effort = raw.per_turn_effort.as_deref().or(raw.effort.as_deref()).and_then(effort_word);
                if let Ok(LineEvent::Message(m)) = self.pre.parse(line) {
                    out.usage = Some(m);
                }
                if let Some(msg) = raw.message {
                    out.stop_reason = msg.stop_reason.map(Cow::into_owned);
                    if let Some(Content::Blocks(blocks)) = msg.content {
                        for b in blocks {
                            if b.ty.as_deref() != Some("tool_use") {
                                continue;
                            }
                            let (Some(id), Some(name)) = (b.id, b.name) else { continue };
                            let input = b.input.unwrap_or_default();
                            out.tools.push(describe(&id, &name, &input, out.cwd.as_deref()));
                        }
                    }
                }
            }
            "user" => {
                if raw.is_meta == Some(true) {
                    return Some(out);
                }
                match raw.message.and_then(|m| m.content) {
                    Some(Content::Text(_)) => out.role = Role::Prompt,
                    Some(Content::Blocks(blocks)) => {
                        let mut result = false;
                        let mut human = false;
                        for b in blocks {
                            match b.ty.as_deref() {
                                Some("tool_result") => {
                                    result = true;
                                    if let Some(id) = b.tool_use_id {
                                        out.result_ids.push(id.into_owned());
                                    }
                                }
                                Some("text") => {
                                    human = true;
                                    if b.text.as_deref().is_some_and(|t| t.starts_with("[Request interrupted")) {
                                        out.interrupted = true;
                                    }
                                }
                                Some("image") => human = true,
                                _ => {}
                            }
                        }
                        out.role = if result {
                            Role::Result
                        } else if human {
                            Role::Prompt
                        } else {
                            Role::Other
                        };
                    }
                    None => {}
                }
            }
            _ if !out.notices.is_empty() => {}
            _ => return None,
        }
        Some(out)
    }
}

// ---------------------------------------------------------------- describing a tool call

fn describe(id: &str, name: &str, input: &Input, cwd: Option<&str>) -> ToolFact {
    let file = input.file_path.as_deref().or(input.notebook_path.as_deref());
    let path = file.map(|p| short_path(p, cwd));
    let (kind, verb, target, touched): (&'static str, &str, Option<String>, Option<(String, bool)>) = match name {
        "Read" => ("read", "Reading", path.clone(), path.map(|p| (p, false))),
        "Edit" | "MultiEdit" | "NotebookEdit" => ("edit", "Editing", path.clone(), path.map(|p| (p, true))),
        "Write" => ("write", "Writing", path.clone(), path.map(|p| (p, true))),
        "Bash" | "PowerShell" | "BashOutput" | "KillShell" => {
            ("run", "Running", input.command.as_deref().map(command_head), None)
        }
        "Grep" | "Glob" | "LS" => ("search", "Searching", None, None),
        "WebFetch" => ("web", "Fetching", input.url.as_deref().and_then(host_of), None),
        "WebSearch" => ("web", "Searching the web", None, None),
        "Task" | "Agent" => ("helper", "Starting a helper", input.subagent_type.as_deref().map(|t| clean(t, 32)), None),
        "TodoWrite" | "ExitPlanMode" | "EnterPlanMode" | "TaskCreate" | "TaskUpdate" => ("plan", "Planning", None, None),
        n if n.starts_with("mcp__") && n.ends_with("__update_plan") => ("plan", "Planning", None, None),
        "AskUserQuestion" => ("ask", "Asking you", None, None),
        "Skill" => ("tool", "Using a skill", input.skill.as_deref().map(|s| clean(s, 32)), None),
        n if n.starts_with("mcp__") => ("tool", "Using", Some(mcp_label(n)), None),
        n => ("tool", "Using", Some(clean(n, 32)), None),
    };
    let test = matches!(name, "Bash" | "PowerShell") && input.command.as_deref().is_some_and(is_test_run);
    ToolFact {
        id: id.to_string(),
        desc: Desc { kind, verb: verb.to_string(), target: target.map(|t| mask(&t)) },
        touched: touched.map(|(p, w)| (mask(&p), w)),
        test,
        plan: plan_op(name, input),
    }
}

/// Words that mark a command as a test run, matched whole against the first
/// `TEST_SCAN_CHARS` characters of it (`cargo test`, `npx vitest run`, `pytest -q`,
/// `./verify.ps1`). Only the yes/no leaves this file.
const TEST_WORDS: &[&str] = &["test", "tests", "vitest", "jest", "pytest", "nextest", "verify"];
const TEST_SCAN_CHARS: usize = 200;

pub fn is_test_run(cmd: &str) -> bool {
    let head: String = cmd.chars().take(TEST_SCAN_CHARS).collect::<String>().to_ascii_lowercase();
    head.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| TEST_WORDS.contains(&w))
}

fn state_of(status: Option<&str>) -> StepState {
    match status {
        Some("completed") => StepState::Done,
        Some("in_progress") => StepState::Active,
        _ => StepState::Pending,
    }
}

/// A task-list tool's effect on the list. A helper that never touches one yields `None` for
/// every call, which is nearly all of them (the spec's 0 of 1,594).
fn plan_op(name: &str, input: &Input) -> Option<PlanOp> {
    match name {
        "TodoWrite" => input.todos.as_ref().map(|t| PlanOp::Set(t.iter().map(|s| state_of(s.status.as_deref())).collect())),
        "TaskCreate" => Some(PlanOp::Add),
        "TaskUpdate" => {
            let id = match input.task_id.as_ref()? {
                TaskId::Text(t) => t.clone(),
                TaskId::Num(n) => n.to_string(),
            };
            Some(PlanOp::Update { id, status: input.status.as_deref()?.to_string() })
        }
        n if n.starts_with("mcp__") && n.ends_with("__update_plan") => {
            if let Some(items) = &input.items {
                return Some(PlanOp::Set(items.iter().map(|s| state_of(s.status.as_deref())).collect()));
            }
            if input.advance == Some(true) {
                return Some(PlanOp::Advance);
            }
            if input.done.is_some() || input.start.is_some() {
                let idx = |n: &i64| usize::try_from(*n).ok().filter(|n| *n >= 1);
                return Some(PlanOp::Mark {
                    done: input.done.iter().flatten().filter_map(idx).collect(),
                    start: input.start.as_ref().and_then(idx),
                });
            }
            None
        }
        _ => None,
    }
}

/// Each part of a path is masked on its own: the masker works on whole words, and a path is one word.
fn mask(s: &str) -> String {
    s.split('/').map(|part| mask_secrets(part).into_owned()).collect::<Vec<_>>().join("/")
}

/// One printable line of at most `max` characters.
pub fn clean(s: &str, max: usize) -> String {
    let one: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let one = one.trim();
    if one.chars().count() <= max {
        return one.to_string();
    }
    let cut: String = one.chars().take(max.saturating_sub(3)).collect();
    format!("{}...", cut.trim_end())
}

/// A path as the project knows it: relative to the working folder when inside it, else the
/// last three parts. Forward slashes everywhere.
pub fn short_path(p: &str, cwd: Option<&str>) -> String {
    let norm = p.replace('\\', "/");
    if let Some(c) = cwd {
        let c = c.replace('\\', "/");
        let c = c.trim_end_matches('/');
        if !c.is_empty()
            && norm.len() > c.len() + 1
            && norm.get(..c.len()).is_some_and(|h| h.eq_ignore_ascii_case(c))
            && norm.as_bytes()[c.len()] == b'/'
        {
            return tail(&norm[c.len() + 1..], TARGET_CAP);
        }
    }
    let parts: Vec<&str> = norm.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() > 3 {
        return tail(&format!(".../{}", parts[parts.len() - 3..].join("/")), TARGET_CAP);
    }
    tail(&parts.join("/"), TARGET_CAP)
}

/// Keep the end of a long path (the file name is the part that matters).
fn tail(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    let skip = n - (max - 3);
    format!("...{}", s.chars().skip(skip).collect::<String>())
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let host = rest.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?; // never a user:password@ part
    let host = host.split(':').next()?;
    (!host.is_empty()).then(|| clean(host, 40))
}

fn mcp_label(name: &str) -> String {
    let mut it = name.splitn(3, "__");
    let _ = it.next();
    let server = it.next().unwrap_or("");
    let tool = it.next().unwrap_or("");
    let server = server.strip_prefix("claude_ai_").unwrap_or(server);
    match (server.is_empty(), tool.is_empty()) {
        (false, false) => clean(&format!("{tool} ({server})"), 40),
        (false, true) => clean(server, 40),
        _ => clean(name, 40),
    }
}

/// Programs whose next word is safe and useful to show ("cargo test").
const RUNNERS: &[&str] = &[
    "cargo", "npm", "pnpm", "yarn", "bun", "npx", "git", "go", "dotnet", "pip", "python", "node", "make", "gh", "tauri",
    "godot", "gradle", "gradlew", "mvn",
];
const SUBCOMMANDS: &[&str] = &[
    "test", "build", "run", "check", "clippy", "fmt", "install", "add", "status", "diff", "log", "commit", "push", "pull",
    "fetch", "checkout", "branch", "merge", "rebase", "stash", "dev", "start", "lint", "format", "typecheck", "publish",
    "bench", "doc", "clean", "init", "show", "restore", "reset", "tag", "clone", "ci", "tsc", "vitest", "release",
];
/// Words that only set the scene for the real command.
const SCENE: &[&str] = &["cd", "pushd", "popd", "set-location", "export", "set", "source", "echo", "sudo", "time", "env", "&", "call"];

/// The first word of a command (and its subcommand for the usual tools). Never arguments.
pub fn command_head(cmd: &str) -> String {
    for seg in cmd.split(['\n', ';']).flat_map(|s| s.split("&&")).flat_map(|s| s.split("||")) {
        let mut words = seg.split_whitespace().filter(|w| !w.contains('=') && !w.starts_with('$'));
        let mut first = None;
        for w in words.by_ref() {
            let bare = program_name(w);
            if bare.is_empty() || SCENE.contains(&bare.to_ascii_lowercase().as_str()) {
                if bare.eq_ignore_ascii_case("cd")
                    || bare.eq_ignore_ascii_case("set-location")
                    || bare.eq_ignore_ascii_case("pushd")
                {
                    // Its argument (a folder) is not the command either.
                    break;
                }
                continue;
            }
            first = Some(bare);
            break;
        }
        let Some(first) = first else { continue };
        if mask_secrets(&first).as_ref() != first.as_str() || first.len() > 32 {
            return "a command".to_string();
        }
        if RUNNERS.contains(&first.to_ascii_lowercase().as_str())
            && let Some(next) = words.next()
        {
            let next = next.to_ascii_lowercase();
            if SUBCOMMANDS.contains(&next.as_str()) {
                // `npm run build`: the script name is shown only for the usual ones.
                if next == "run"
                    && let Some(script) = words.next()
                {
                    let script = script.to_ascii_lowercase();
                    if SUBCOMMANDS.contains(&script.as_str()) {
                        return format!("{first} run {script}");
                    }
                }
                return format!("{first} {next}");
            }
        }
        return first;
    }
    "a command".to_string()
}

/// `C:\tools\cargo.exe` -> `cargo`; quotes and a leading `&` stripped.
fn program_name(w: &str) -> String {
    let w = w.trim_matches(|c| c == '"' || c == '\'' || c == '(' || c == '`');
    let base = w.rsplit(['/', '\\']).next().unwrap_or(w);
    let base = base.strip_suffix(".exe").or_else(|| base.strip_suffix(".cmd")).unwrap_or(base);
    base.to_string()
}

/// An effort level as the transcript writes it (`high`, `xhigh`): one short lowercase word, or
/// nothing. Anything else (empty, long, odd characters) is dropped rather than shown.
pub fn effort_word(w: &str) -> Option<String> {
    let w = w.trim();
    (!w.is_empty() && w.len() <= 10 && w.bytes().all(|b| b.is_ascii_lowercase())).then(|| w.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(line: &str) -> Parsed {
        Facts::new().parse(line.as_bytes()).expect("a line the page reads")
    }

    #[test]
    fn commands_show_a_word_or_two_never_arguments() {
        assert_eq!(command_head("cargo test -p atlas-core --lib"), "cargo test");
        assert_eq!(command_head("cd \"C:/x y\" && npm run build"), "npm run build");
        assert_eq!(command_head("git status | head"), "git status");
        assert_eq!(command_head("FOO=bar ls -la"), "ls");
        assert_eq!(command_head("C:\\tools\\rg.exe secret-pattern src"), "rg");
        assert_eq!(command_head("cargo clean-the-world"), "cargo");
        assert_eq!(command_head("cd /tmp"), "a command");
        assert_eq!(command_head("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA do"), "a command");
    }

    #[test]
    fn effort_is_the_lines_own_word_or_nothing() {
        let line = |extra: &str| {
            format!(r#"{{"type":"assistant","timestamp":"2026-11-08T10:00:00.000Z"{extra},"message":{{"stop_reason":"tool_use","content":[]}}}}"#)
        };
        assert_eq!(one(&line(r#","effort":"high""#)).effort.as_deref(), Some("high"));
        // The per-turn level wins over the plain one.
        assert_eq!(one(&line(r#","effort":"high","perTurnEffort":"medium""#)).effort.as_deref(), Some("medium"));
        assert_eq!(one(&line("")).effort, None);
        // Not a word we can trust: dropped, never guessed.
        assert_eq!(one(&line(r#","effort":"HIGH!!""#)).effort, None);
        assert_eq!(one(&line(r#","effort":"a-very-long-made-up-level""#)).effort, None);
        assert_eq!(effort_word("xhigh").as_deref(), Some("xhigh"));
    }

    #[test]
    fn paths_are_short_and_forward_slashed() {
        let cwd = Some("C:\\Users\\Will\\Documents\\app");
        assert_eq!(short_path("C:\\Users\\Will\\Documents\\app\\src\\App.tsx", cwd), "src/App.tsx");
        assert_eq!(short_path("c:/users/will/documents/APP/a.txt", cwd), "a.txt");
        assert_eq!(short_path("C:\\Users\\Will\\.claude\\rules\\x.md", cwd), ".../.claude/rules/x.md");
        assert_eq!(short_path("a.txt", None), "a.txt");
        let long = format!("{}/file.rs", "d".repeat(80));
        let s = short_path(&long, None);
        assert!(s.chars().count() <= TARGET_CAP && s.ends_with("file.rs") && s.starts_with("..."), "{s}");
    }

    #[test]
    fn a_tool_call_keeps_the_name_and_target_but_not_the_body() {
        let p = one(
            r#"{"type":"assistant","timestamp":"2026-11-08T10:00:00.000Z","cwd":"C:\\p\\app","message":{"stop_reason":"tool_use","content":[{"type":"text","text":"SECRET PROSE"},{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"C:\\p\\app\\src\\a.ts","old_string":"OLD BODY","new_string":"NEW BODY"}}]}}"#,
        );
        assert_eq!(p.role, Role::Assistant);
        assert_eq!(p.stop_reason.as_deref(), Some("tool_use"));
        assert_eq!(p.tools.len(), 1);
        let t = &p.tools[0];
        assert_eq!((t.desc.kind, t.desc.verb.as_str(), t.desc.target.as_deref()), ("edit", "Editing", Some("src/a.ts")));
        assert_eq!(t.touched, Some(("src/a.ts".to_string(), true)));
        let all = format!("{p:?}");
        for leak in ["SECRET PROSE", "OLD BODY", "NEW BODY"] {
            assert!(!all.contains(leak), "{leak} leaked");
        }
    }

    #[test]
    fn user_lines_are_prompts_results_or_nothing_and_never_keep_text() {
        let typed = one(r#"{"type":"user","timestamp":"2026-11-08T10:00:00.000Z","message":{"role":"user","content":"please do the thing"}}"#);
        assert_eq!(typed.role, Role::Prompt);
        assert!(!format!("{typed:?}").contains("please do the thing"));
        let blocks = one(r#"{"type":"user","message":{"content":[{"type":"text","text":"hello there"}]}}"#);
        assert_eq!(blocks.role, Role::Prompt);
        let res = one(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"OUTPUT TEXT"}]}}"#);
        assert_eq!((res.role, res.result_ids.clone()), (Role::Result, vec!["t1".to_string()]));
        assert!(!format!("{res:?}").contains("OUTPUT TEXT"));
        let meta = one(r#"{"type":"user","isMeta":true,"message":{"content":"caveat"}}"#);
        assert_eq!(meta.role, Role::Other);
        assert!(Facts::new().parse(br#"{"type":"attachment","x":1}"#).is_none());
    }

    #[test]
    fn titles_and_odd_inputs() {
        let t = one(r#"{"type":"custom-title","customTitle":"  Fix the build  ","sessionId":"s"}"#);
        assert_eq!(t.title, Some((true, "Fix the build".to_string())));
        let a = one(r#"{"type":"agent-name","agentName":"Quiet river"}"#);
        assert_eq!(a.title, Some((false, "Quiet river".to_string())));
        // A path that is not a string does not sink the line.
        let odd = one(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"Read","input":{"file_path":5}}]}}"#);
        assert_eq!(odd.tools.len(), 1);
        assert_eq!(odd.tools[0].desc.target, None);
    }

    #[test]
    fn secrets_in_a_target_are_masked() {
        let p = one(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"Read","input":{"file_path":"C:\\x\\sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}}]}}"#,
        );
        let target = p.tools[0].desc.target.clone().unwrap();
        assert!(!target.contains("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "{target}");
        assert!(target.contains("***"));
    }

    #[test]
    fn web_and_mcp_names() {
        assert_eq!(host_of("https://user:pw@example.com:8080/a?b=c").as_deref(), Some("example.com"));
        assert_eq!(mcp_label("mcp__claude-in-chrome__navigate"), "navigate (claude-in-chrome)");
        assert_eq!(mcp_label("mcp__claude_ai_Gmail__search_threads"), "search_threads (Gmail)");
    }
}
