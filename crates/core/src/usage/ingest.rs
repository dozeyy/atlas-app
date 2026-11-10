//! Reading transcripts into the ledger (D5, D11-D14, D34, D35, D39).
//!
//! Workers stream and parse files (largest first); a bounded channel feeds one
//! writer that owns the SQLite connection. Each batch commits in one transaction
//! together with the file's new committed offset, so a killed app resumes exactly
//! where the last commit ended. After a batch, the aggregates for the touched
//! hours and sessions are rebuilt from `messages` (self-healing, no +/- drift).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::sync_channel;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};

use super::line::ToolLine;
use super::line::{LineEvent, MsgEvent, Prefilter, Skip};
use super::naming::{self, AgentMeta};
use super::pricing::Counts;
use super::reader::{open_read_only, read_lines, Item, ReadStats, LINE_CAP};
use super::receipt_scan::notices_in;
use super::reviews::{self, Finding, VerdictLine};
use super::scan::FileTask;
use super::time::Tz;
use crate::cache::PriceHandle;

#[derive(Debug, Clone)]
pub struct IngestOptions {
    pub workers: usize,
    /// Commit after this many parsed lines (D34).
    pub batch_lines: usize,
    /// ...or this many bytes read.
    pub batch_bytes: u64,
    pub line_cap: usize,
    /// Test hook: stop cleanly after this many committed batches.
    pub stop_after_batches: Option<usize>,
}

impl Default for IngestOptions {
    fn default() -> Self {
        let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
        IngestOptions {
            workers: cpus.saturating_sub(1).clamp(1, 4),
            batch_lines: 5000,
            batch_bytes: 64 * 1024 * 1024,
            line_cap: LINE_CAP,
            stop_after_batches: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Progress {
    pub files_done: usize,
    pub files_total: usize,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

#[derive(Debug, Default, Clone)]
pub struct PassResult {
    pub files: usize,
    pub batches: usize,
    pub messages_seen: u64,
    pub synthetic_skipped: u64,
    pub zero_skipped: u64,
    pub cancelled: bool,
    pub sessions: Vec<String>,
    pub from_hour: Option<String>,
    pub to_hour: Option<String>,
}

struct Batch {
    task_idx: usize,
    events: Vec<(LineEvent, u64)>,
    malformed: u64,
    long_lines: u64,
    synthetic: u64,
    zero: u64,
    end_offset: u64,
    /// First batch of a file read from 0: replaces the diagnostic counters.
    replace_counts: bool,
    /// The file was read to its end: record the size/mtime it was planned at.
    done: bool,
    bytes: u64,
    /// The first batch of this run over the file: carries the sidecar and registers the agent.
    first: bool,
    /// `tool_use` blocks in the assistant lines of this batch.
    tool_calls: u64,
    /// What those calls were (name, skill, helper type), with when and in which session.
    items: Vec<ToolLine>,
    /// One-line summary of the first real user prompt, found while reading from byte 0.
    prompt: Option<String>,
    /// The subagent's `.meta.json`, when there is one.
    meta: Option<AgentMeta>,
    /// What the run ledger read in this batch (`docs/specs/agent-scorecard.md` D3-D10).
    run: RunBatch,
}

/// What the helper-run ledger reads from a batch of lines. Numbers, ids and short finding lines
/// only: the prompts and the report text are read in memory and dropped here, in the worker.
#[derive(Default)]
struct RunBatch {
    /// Run facts were read from this batch (a helper's file, or a chat that ran as an agent).
    tracked: bool,
    /// The chat's `agent-setting` line was in this batch (a chat that ran as that agent).
    setting: Option<String>,
    first_ts: Option<i64>,
    last_ts: Option<i64>,
    /// `(stop_reason, api error)` of the last text-or-tool-call assistant line of the batch.
    end_line: Option<(Option<String>, bool)>,
    interrupted: bool,
    /// What the last text line of the batch said, parsed.
    report: Option<Report>,
    links: Vec<LinkRow>,
    /// `(helper id, status, time)` of each `<task-notification>` in the batch.
    notices: Vec<(String, String, Option<i64>)>,
    /// `(exact model id, effort or "")` -> assistant messages (each message counted once) in the
    /// batch. Unknown model ids are kept as they are.
    models: HashMap<(String, String), u32>,
    /// The first message this read counted: a read that starts inside a message that an earlier read
    /// already counted must not count it again (the writer compares the key with the stored one).
    first_msg: Option<(String, String, String)>,
    /// The key of the last message this batch counted.
    last_msg: Option<String>,
    /// What the helper's lines did to its turn, in order (see `Mark`). Folded by the writer, which
    /// knows the state the earlier reads left.
    marks: Vec<Mark>,
}

/// A change in a helper's turn: its last text ended it (`Ended`), it went on working (`Working`), or
/// a real message arrived (`Prompt`). Only changes are kept, so a long run makes few marks. The
/// writer turns them into stretches of work: a `Prompt` after `Ended` is a resume.
struct Mark {
    kind: MarkKind,
    ts: Option<i64>,
    /// The latest line time before a `Prompt` in this read: where the stretch it closes ended.
    prev_last: Option<i64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MarkKind {
    Ended,
    Working,
    Prompt,
}

struct Report {
    ts: Option<i64>,
    verdict: Option<VerdictLine>,
    findings: Vec<Finding>,
}

/// One `Agent`/`Task` dispatch or `SendMessage`, with the helper ids it named.
struct LinkRow {
    send: bool,
    tool_use_id: String,
    ts: Option<i64>,
    subagent_type: String,
    targets: Vec<String>,
    /// Id-shaped names in the prompt that no helper on disk has (yet).
    pending: Vec<String>,
}

/// A last-line buffer that is reused, never grown without bound.
#[derive(Default)]
struct Slot {
    buf: Vec<u8>,
    set: bool,
    /// The last line was too long to keep: only its time and stop reason are known.
    over: Option<Over>,
}

struct Over {
    ts: Option<i64>,
    stop: Option<&'static str>,
}

impl Slot {
    fn put(&mut self, line: &[u8], over: impl FnOnce() -> Over) {
        self.buf.clear();
        if line.len() <= reviews::Thresholds::FINAL_TEXT_CAP {
            self.buf.extend_from_slice(line);
            self.set = true;
            self.over = None;
        } else {
            self.set = false;
            self.over = Some(over());
        }
    }
}

/// The helpers of a chat that exist on disk: their ids and worktree branches, to find the ones a
/// dispatch prompt names. Read lazily, once per file, only when a prompt has to be checked.
#[derive(Default, Clone)]
struct Known {
    ids: HashSet<String>,
    branches: Vec<(String, String)>,
    /// File names of the folder already read (a sidecar is read once, not on every read).
    names: HashSet<String>,
}

/// Per-file scratch of the ledger scan (lives across batches of one file).
#[derive(Default)]
struct RunScan {
    rc: Slot,
    text: Slot,
    setting_seen: bool,
    known: Option<std::sync::Arc<Known>>,
    /// Message keys already counted in `RunBatch::models` (a message streams as several lines).
    msg_seen: HashSet<String>,
    /// Whether the last assistant line ended its turn; None until one is seen in this read.
    ended: Option<bool>,
    /// The latest line time seen in this read.
    last_ts: Option<i64>,
    /// The first counted message of this read has been recorded.
    first_msg_done: bool,
}

/// Finders for the stretch scan, made once per worker.
struct SegFinders {
    user: memchr::memmem::Finder<'static>,
    tool_result: memchr::memmem::Finder<'static>,
    compaction: memchr::memmem::Finder<'static>,
    end_turn: memchr::memmem::Finder<'static>,
    tool_use: memchr::memmem::Finder<'static>,
}

impl SegFinders {
    fn new() -> Self {
        let f = |s: &'static str| memchr::memmem::Finder::new(s.as_bytes()).into_owned();
        SegFinders {
            user: f(r#""type":"user""#),
            tool_result: f(r#""type":"tool_result""#),
            compaction: f("This session is being continued"),
            end_turn: f(r#""stop_reason":"end_turn""#),
            tool_use: f(r#""stop_reason":"tool_use""#),
        }
    }
}

fn helpers_dir(task: &FileTask) -> PathBuf {
    if task.is_subagent {
        task.path.parent().map(Path::to_path_buf).unwrap_or_default()
    } else {
        task.path.with_extension("").join("subagents")
    }
}

/// The helper folders read so far, by path, with the folder's modified time then. A folder that has
/// not changed is not listed again, and a changed one only has its new files read.
static KNOWN: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, (Option<std::time::SystemTime>, std::sync::Arc<Known>)>>> =
    std::sync::OnceLock::new();
const KNOWN_FOLDERS: usize = 64;

fn load_known(dir: &Path) -> std::sync::Arc<Known> {
    let cache = KNOWN.get_or_init(Default::default);
    let mtime = std::fs::metadata(dir).and_then(|m| m.modified()).ok();
    let prev = {
        let g = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        g.get(dir).cloned()
    };
    if let Some((m, k)) = &prev
        && mtime.is_some()
        && *m == mtime
    {
        return k.clone();
    }
    let mut k = prev.map(|(_, k)| (*k).clone()).unwrap_or_default();
    let mut retry = false;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten().take(5000) {
            let p = e.path();
            let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
            if k.names.contains(name) {
                continue;
            }
            if let Some(stem) = name.strip_suffix(".meta.json") {
                let id = naming::agent_id_of_stem(stem);
                let meta = read_sidecar(&p);
                // A sidecar that does not parse yet may be half written: read it again next time,
                // unless it has sat there a few seconds (then it is simply odd).
                if meta.is_none() && sidecar_is_fresh(&e) {
                    retry = true;
                    k.ids.insert(id);
                    continue;
                }
                if let Some(br) = meta.and_then(|m| m.worktree_branch) {
                    k.branches.push((br, id.clone()));
                }
                k.ids.insert(id);
            } else if let Some(stem) = name.strip_suffix(".jsonl") {
                k.ids.insert(naming::agent_id_of_stem(stem));
            }
            k.names.insert(name.to_string());
        }
    }
    let k = std::sync::Arc::new(k);
    let mut g = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if g.len() >= KNOWN_FOLDERS {
        g.clear();
    }
    // A folder with a sidecar still being written is listed again on the next call.
    g.insert(dir.to_path_buf(), (if retry { None } else { mtime }, k.clone()));
    k
}

/// A file written within the last few seconds (it may still be growing).
fn sidecar_is_fresh(e: &std::fs::DirEntry) -> bool {
    e.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_none_or(|age| age < std::time::Duration::from_secs(5))
}

/// Id-shaped names (`a` and 16 hex digits, like a helper's file name) in a prompt that no helper on
/// disk has: a dispatch that names a helper whose files are not there yet. Ids only, never prompt text.
fn pending_ids(prompt: &str, k: &Known) -> Vec<String> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    for tok in prompt.split(|c: char| !c.is_ascii_alphanumeric()) {
        if tok.len() == 17 && tok.starts_with('a') && tok[1..].bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) && !k.ids.contains(tok) {
            out.insert(tok.to_string());
            if out.len() >= 8 {
                break;
            }
        }
    }
    out.into_iter().collect()
}

/// The helper ids of the chat that a dispatch prompt names: by id, or by a worktree branch a helper
/// of the chat has recorded. Sorted, no duplicates. The prompt itself is not kept.
fn mentioned(prompt: &str, k: &Known) -> Vec<String> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    for tok in prompt.split(|c: char| !c.is_ascii_alphanumeric()) {
        if !tok.is_empty() && k.ids.contains(tok) {
            out.insert(tok.to_string());
        }
    }
    for (br, id) in &k.branches {
        if prompt.contains(br.as_str()) {
            out.insert(id.clone());
        }
    }
    out.into_iter().collect()
}

/// Read one line for the ledger: times, the interrupt marker, the last text and tool-call lines,
/// task-finished notices, and helper dispatches and messages.
fn scan_ledger_line(
    pf: &Prefilter,
    notice: &memchr::memmem::Finder<'static>,
    seg: &SegFinders,
    task: &FileTask,
    l: &[u8],
    rs: &mut RunScan,
    run: &mut RunBatch,
) {
    let tracking = task.is_subagent || rs.setting_seen;
    if tracking {
        run.tracked = true;
        let ts = pf.line_ts(l);
        let interrupt = pf.is_interrupt(l);
        // A real message is a mark: the writer decides whether it is the dispatch (the first) or a
        // resume (after the helper's last text ended its turn: SendMessage wakes it again).
        if task.is_subagent
            && !interrupt
            && seg.user.find(l).is_some()
            && seg.tool_result.find(l).is_none()
            && seg.compaction.find(l).is_none()
        {
            run.marks.push(Mark { kind: MarkKind::Prompt, ts, prev_last: rs.last_ts });
            rs.ended = Some(false);
            // The turn is open again until the helper answers: no stop reason stands for it.
            rs.rc.set = false;
            rs.rc.over = None;
            run.end_line = Some((None, false));
        }
        if let Some(ts) = ts {
            run.first_ts = Some(run.first_ts.map_or(ts, |c| c.min(ts)));
            run.last_ts = Some(run.last_ts.map_or(ts, |c| c.max(ts)));
            rs.last_ts = Some(rs.last_ts.map_or(ts, |c| c.max(ts)));
        }
        let over = || Over {
            ts: pf.line_ts(l),
            stop: if seg.end_turn.find(l).is_some() {
                Some("end_turn")
            } else if seg.tool_use.find(l).is_some() {
                Some("tool_use")
            } else {
                None
            },
        };
        if interrupt {
            run.interrupted = true;
        } else if pf.is_assistant_text(l) {
            rs.rc.put(l, over);
            rs.text.put(l, over);
            let ended = seg.end_turn.find(l).is_some();
            if rs.ended != Some(ended) {
                run.marks.push(Mark { kind: if ended { MarkKind::Ended } else { MarkKind::Working }, ts, prev_last: None });
                rs.ended = Some(ended);
            }
        } else if pf.is_assistant_call(l) {
            rs.rc.put(l, over);
            if rs.ended != Some(false) {
                run.marks.push(Mark { kind: MarkKind::Working, ts, prev_last: None });
                rs.ended = Some(false);
            }
        }
    }
    if notice.find(l).is_some() {
        let mut found = Vec::new();
        notices_in(l, &mut found);
        if !found.is_empty() {
            let ts = pf.line_ts(l);
            for n in found {
                run.notices.push((n.agent_id, n.status, ts));
            }
        }
    }
    if pf.is_link_call(l)
        && let Some(f) = pf.assistant_facts(l, false)
    {
        for c in f.calls {
            if c.send {
                if let Some(to) = c.to.map(|t| t.trim().to_string()).filter(|t| !t.is_empty() && t.len() <= 64) {
                    run.links.push(LinkRow { send: true, tool_use_id: c.tool_use_id, ts: f.ts_ms, subagent_type: String::new(), targets: vec![to], pending: Vec::new() });
                }
            } else {
                let (targets, pending) = match c.prompt.as_deref() {
                    Some(p) if !p.is_empty() => {
                        let k = rs.known.get_or_insert_with(|| load_known(&helpers_dir(task)));
                        (mentioned(p, k), pending_ids(p, k))
                    }
                    _ => (Vec::new(), Vec::new()),
                };
                run.links.push(LinkRow {
                    send: false,
                    tool_use_id: c.tool_use_id,
                    ts: f.ts_ms,
                    subagent_type: c.subagent_type.map(|t| t.trim().to_string()).unwrap_or_default(),
                    targets,
                    pending,
                });
            }
        }
    }
}

/// Parse the buffered last lines into the batch (verdict and findings from the report text), then
/// forget them: the next batch only reports lines newer than these.
fn flush_run(pf: &Prefilter, rs: &mut RunScan, run: &mut RunBatch) {
    if rs.rc.set {
        if let Some(f) = pf.assistant_facts(&rs.rc.buf, false) {
            run.end_line = Some((f.stop_reason, f.api_error));
        }
        rs.rc.set = false;
    } else if let Some(o) = rs.rc.over.take() {
        // A line too long to keep still says how the turn stopped.
        run.end_line = Some((o.stop.map(str::to_string), false));
    }
    if rs.text.set {
        if let Some(f) = pf.assistant_facts(&rs.text.buf, true)
            && let Some(t) = f.text
        {
            run.report = Some(Report { ts: f.ts_ms, verdict: reviews::parse_verdict(&t), findings: reviews::finding_lines(&t) });
        }
        rs.text.set = false;
    } else if let Some(o) = rs.text.over.take() {
        // The final text is too long to read: its old verdict and findings no longer stand for it.
        run.report = Some(Report { ts: o.ts, verdict: None, findings: Vec::new() });
    }
}

/// The sidecar `agent-<id>.meta.json`. Tiny; a missing or odd one is None.
fn read_sidecar(p: &Path) -> Option<AgentMeta> {
    use std::io::Read;
    let mut buf = Vec::new();
    open_read_only(p).ok()?.take(64 * 1024).read_to_end(&mut buf).ok()?;
    AgentMeta::parse(&buf)
}

/// The sidecar of `agent-<id>.jsonl` is `agent-<id>.meta.json`.
fn read_meta(jsonl: &Path) -> Option<AgentMeta> {
    read_sidecar(&jsonl.with_extension("meta.json"))
}

/// The summary of a line when it is a real (non-meta, non-tool-result) user prompt.
fn prompt_of(line: &[u8]) -> Option<String> {
    memchr::memmem::find(line, br#""type":"user""#)?;
    let it = super::transcript::item_from_line(line)?;
    if it.role != "user" {
        return None;
    }
    naming::summarize_prompt(&it.text)
}

/// The id of the agent a subagent file belongs to.
fn file_agent_id(path: &std::path::Path) -> Option<String> {
    path.file_stem().and_then(|s| s.to_str()).map(naming::agent_id_of_stem)
}

fn worker(
    idx: &AtomicUsize,
    tasks: &[FileTask],
    opts: &IngestOptions,
    stats: &ReadStats,
    cancel: &AtomicBool,
    tx: &std::sync::mpsc::SyncSender<Batch>,
) {
    let pf = Prefilter::new();
    let notice = memchr::memmem::Finder::new(b"<task-notification>").into_owned();
    let seg = SegFinders::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let i = idx.fetch_add(1, Ordering::Relaxed);
        let Some(task) = tasks.get(i) else { return };
        let new_batch = |first: bool, at: u64| Batch {
            task_idx: i,
            events: Vec::new(),
            malformed: 0,
            long_lines: 0,
            synthetic: 0,
            zero: 0,
            end_offset: at,
            replace_counts: first && task.start == 0,
            done: false,
            bytes: 0,
            first,
            tool_calls: 0,
            items: Vec::new(),
            prompt: None,
            meta: None,
            run: RunBatch::default(),
        };
        let Ok(file) = open_read_only(&task.path) else {
            // Gone or locked: nothing to read now; the next sweep decides.
            let mut b = new_batch(true, task.start);
            b.done = false;
            let _ = tx.send(b);
            continue;
        };
        let mut batch = new_batch(true, task.start);
        batch.meta = if task.is_subagent { read_meta(&task.path) } else { None };
        let mut want_prompt = task.start == 0;
        let mut line_no = 0usize;
        let mut first = true;
        let mut prev_end = task.start;
        let mut batch_first_off = task.start;
        let mut lines = 0usize;
        let mut alive = true;
        let mut rs = RunScan { setting_seen: task.agent_chat, ..RunScan::default() };
        let result = read_lines(file, task.start, opts.line_cap, stats, |item, end| {
            match item {
                Item::Line(l) => {
                    line_no += 1;
                    scan_ledger_line(&pf, &notice, &seg, task, l, &mut rs, &mut batch.run);
                    if want_prompt {
                        if line_no > 80 {
                            want_prompt = false;
                        } else if let Some(p) = prompt_of(l) {
                            batch.prompt = Some(p);
                            want_prompt = false;
                        }
                    }
                    let calls = pf.tool_calls(l);
                    if calls > 0 {
                        batch.tool_calls += calls;
                        if let Some(t) = pf.tool_uses(l) {
                            batch.items.push(t);
                        }
                    }
                    match pf.parse(l) {
                    Ok(ev) => {
                        if let LineEvent::AgentSetting { name, .. } = &ev
                            && !task.is_subagent
                        {
                            rs.setting_seen = true;
                            batch.run.setting = Some(name.clone());
                        }
                        if let LineEvent::Message(m) = &ev
                            && (task.is_subagent || rs.setting_seen)
                            && rs.msg_seen.insert(m.key.clone())
                        {
                            let effort = super::line::effort_of(l).unwrap_or_default();
                            if !rs.first_msg_done {
                                rs.first_msg_done = true;
                                batch.run.first_msg = Some((m.key.clone(), m.model.clone(), effort.clone()));
                            }
                            batch.run.last_msg = Some(m.key.clone());
                            *batch.run.models.entry((m.model.clone(), effort)).or_default() += 1;
                        }
                        batch.events.push((ev, prev_end));
                        lines += 1;
                    }
                    Err(Skip::Malformed) => {
                        batch.malformed += 1;
                        lines += 1;
                    }
                    Err(Skip::Synthetic) => batch.synthetic += 1,
                    Err(Skip::ZeroUsage) => batch.zero += 1,
                    Err(Skip::Ignored) => {}
                    }
                }
                Item::LongLine => {
                    batch.long_lines += 1;
                    lines += 1;
                }
            }
            prev_end = end;
            batch.end_offset = end;
            if lines >= opts.batch_lines || end - batch_first_off >= opts.batch_bytes {
                batch.bytes = end - batch_first_off;
                flush_run(&pf, &mut rs, &mut batch.run);
                let full = std::mem::replace(&mut batch, new_batch(false, end));
                first = false;
                let _ = first;
                lines = 0;
                batch_first_off = end;
                if tx.send(full).is_err() {
                    alive = false;
                    return false;
                }
                if cancel.load(Ordering::Relaxed) {
                    alive = false;
                    return false;
                }
            }
            true
        });
        if !alive {
            return;
        }
        flush_run(&pf, &mut rs, &mut batch.run);
        match result {
            Ok(committed) => {
                batch.end_offset = committed;
                batch.bytes = committed.saturating_sub(batch_first_off);
                batch.done = true;
            }
            Err(_) => {
                // Read failed part-way (file vanished): keep what was committed.
                batch.bytes = batch.end_offset.saturating_sub(batch_first_off);
            }
        }
        if tx.send(batch).is_err() {
            return;
        }
    }
}

/// Run the planned tasks to completion (or cancellation). The caller owns the
/// connection; this is the single writer.
#[allow(clippy::too_many_arguments)]
pub fn run_tasks(
    conn: &mut Connection,
    tasks: &[FileTask],
    tz: Tz,
    prices: &PriceHandle,
    opts: &IngestOptions,
    stats: &ReadStats,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Progress),
) -> rusqlite::Result<PassResult> {
    let mut res = PassResult::default();
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS th(h TEXT PRIMARY KEY) WITHOUT ROWID;
         CREATE TEMP TABLE IF NOT EXISTS ts(s TEXT PRIMARY KEY) WITHOUT ROWID;
         DELETE FROM th; DELETE FROM ts;",
    )?;
    let mut prog = Progress {
        files_total: tasks.len(),
        bytes_total: tasks.iter().map(|t| t.size.saturating_sub(t.start)).sum(),
        ..Default::default()
    };
    progress(prog);
    if tasks.is_empty() {
        return Ok(res);
    }
    let idx = AtomicUsize::new(0);
    let halt = AtomicBool::new(false);
    let workers = opts.workers.clamp(1, tasks.len().max(1));
    let (tx, rx) = sync_channel::<Batch>(8);
    let mut session_set: HashSet<String> = HashSet::new();
    let mut hour_lo: Option<String> = None;
    let mut hour_hi: Option<String> = None;
    let mut files_started: HashSet<usize> = HashSet::new();
    let mut hour_cache: HashMap<i64, String> = HashMap::new();
    let mut last_report = Instant::now();
    let mut err: Option<rusqlite::Error> = None;

    std::thread::scope(|scope| {
        for _ in 0..workers {
            let tx = tx.clone();
            let (idx, stats) = (&idx, stats);
            let halt = &halt;
            scope.spawn(move || worker(idx, tasks, opts, stats, halt, &tx));
        }
        drop(tx);
        for batch in rx.iter() {
            if cancel.load(Ordering::Relaxed) {
                halt.store(true, Ordering::Relaxed);
            }
            if err.is_some() {
                continue; // drain so workers can finish
            }
            let task = &tasks[batch.task_idx];
            files_started.insert(batch.task_idx);
            match apply_batch(conn, task, &batch, tz, prices, &mut hour_cache) {
                Ok(t) => {
                    res.batches += 1;
                    res.messages_seen += t.messages;
                    res.synthetic_skipped += batch.synthetic;
                    res.zero_skipped += batch.zero;
                    for s in t.sessions {
                        if session_set.len() < 500 {
                            session_set.insert(s);
                        }
                    }
                    if let Some(lo) = t.hour_lo
                        && hour_lo.as_ref().is_none_or(|c| lo < *c) {
                            hour_lo = Some(lo);
                        }
                    if let Some(hi) = t.hour_hi
                        && hour_hi.as_ref().is_none_or(|c| hi > *c) {
                            hour_hi = Some(hi);
                        }
                    prog.bytes_done += batch.bytes;
                    if batch.done {
                        prog.files_done += 1;
                    }
                    if last_report.elapsed() >= Duration::from_millis(100) {
                        last_report = Instant::now();
                        progress(prog);
                    }
                    if opts.stop_after_batches.is_some_and(|n| res.batches >= n) {
                        halt.store(true, Ordering::Relaxed);
                    }
                }
                Err(e) => {
                    err = Some(e);
                    halt.store(true, Ordering::Relaxed);
                }
            }
        }
    });
    if let Some(e) = err {
        return Err(e);
    }
    progress(prog);
    res.files = prog.files_done;
    res.cancelled = halt.load(Ordering::Relaxed);
    res.sessions = session_set.into_iter().collect();
    res.from_hour = hour_lo;
    res.to_hour = hour_hi;
    Ok(res)
}

#[derive(Default)]
struct Touched {
    messages: u64,
    sessions: Vec<String>,
    hour_lo: Option<String>,
    hour_hi: Option<String>,
}

/// Normalised grouping key for a project path (D14): separators unified, trailing
/// separator dropped, and case-folded on Windows and macOS.
pub fn project_key(path: &str) -> String {
    let mut s = path.replace('\\', "/");
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    if cfg!(any(windows, target_os = "macos")) {
        s = s.to_lowercase();
    }
    s
}

#[derive(Default)]
struct SessionDelta {
    title: Option<(String, bool)>,
    project: Option<(String, i64)>,
    cost: Option<f64>,
    entrypoint: Option<String>,
    version: Option<String>,
}

fn apply_batch(
    conn: &mut Connection,
    task: &FileTask,
    b: &Batch,
    tz: Tz,
    prices: &PriceHandle,
    hour_cache: &mut HashMap<i64, String>,
) -> rusqlite::Result<Touched> {
    let table = prices.read().unwrap_or_else(|p| p.into_inner()).clone();
    let tx = conn.transaction()?;
    tx.execute_batch("DELETE FROM th; DELETE FROM ts;")?;
    let mut touched = Touched::default();

    // One line per key within this batch: the one with the most output, the later on a tie (D12).
    // Streamed lines of a reply only grow, so this is the last one; a reply Claude Code writes
    // again later with its counts zeroed (seen after a rewind) cannot replace the real one.
    let mut last: HashMap<&str, usize> = HashMap::new();
    for (i, (ev, _)) in b.events.iter().enumerate() {
        if let LineEvent::Message(m) = ev {
            let keep = match last.get(m.key.as_str()) {
                Some(&j) => matches!(&b.events[j].0, LineEvent::Message(o) if m.output >= o.output),
                None => true,
            };
            if keep {
                last.insert(m.key.as_str(), i);
            }
        }
    }

    let mut deltas: HashMap<String, SessionDelta> = HashMap::new();
    let file_agent = if task.is_subagent { file_agent_id(&task.path) } else { None };
    let fallback_sid = task.folder_session.clone();
    let sid_of = |s: &Option<String>| s.clone().unwrap_or_else(|| fallback_sid.clone());
    {
        let mut sel = tx.prepare_cached(
            "SELECT file_id, output, hour_local, session_id FROM messages WHERE msg_key=?1",
        )?;
        let mut put = tx.prepare_cached(
            "INSERT OR REPLACE INTO messages(msg_key, session_id, file_id, line_offset, agent_id,
               is_sidechain, model, ts_utc_ms, hour_local, input, output, cw5m, cw1h, cr,
               cw_assumed, cw_mismatch, web_search, web_fetch, thinking, speed, geo, service_tier,
               price_tier, skill, mcp_server, mcp_tool, effort)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27)",
        )?;
        let mut dup = tx.prepare_cached("INSERT OR IGNORE INTO dupes(msg_key) VALUES(?1)")?;
        let mut th = tx.prepare_cached("INSERT OR IGNORE INTO th(h) VALUES(?1)")?;
        let mut ts = tx.prepare_cached("INSERT OR IGNORE INTO ts(s) VALUES(?1)")?;

        for (i, (ev, off)) in b.events.iter().enumerate() {
            match ev {
                LineEvent::Message(m) => {
                    if last.get(m.key.as_str()) != Some(&i) {
                        continue;
                    }
                    let sid = sid_of(&m.session_id);
                    let existing = sel
                        .query_row([&m.key], |r| {
                            Ok((
                                r.get::<_, i64>(0)?,
                                r.get::<_, i64>(1)?,
                                r.get::<_, String>(2)?,
                                r.get::<_, String>(3)?,
                            ))
                        })
                        .optional()?;
                    if let Some((fid, out, hour, old_sid)) = &existing {
                        if *fid != task.file_id {
                            dup.execute([&m.key])?;
                            if (m.output as i64) <= *out {
                                continue; // a tie or less keeps the existing row (D12)
                            }
                        } else if (m.output as i64) < *out {
                            continue; // same file, a later batch: less output is a replay, not the reply
                        }
                        th.execute([hour])?;
                        ts.execute([old_sid])?;
                    }
                    let hour = hour_cache
                        .entry(m.ts_ms.div_euclid(900_000))
                        .or_insert_with(|| tz.hour_bucket(m.ts_ms))
                        .clone();
                    let counts = Counts {
                        input: m.input,
                        output: m.output,
                        cw5m: m.cw5m,
                        cw1h: m.cw1h,
                        cr: m.cr,
                        web_search: m.web_search,
                    };
                    let tier = table.price_tier(&m.model, &counts);
                    put.execute(params![
                        m.key,
                        sid,
                        task.file_id,
                        *off as i64,
                        m.agent_id.as_ref().or(file_agent.as_ref()),
                        m.is_sidechain as i64,
                        m.model,
                        m.ts_ms,
                        hour,
                        m.input as i64,
                        m.output as i64,
                        m.cw5m as i64,
                        m.cw1h as i64,
                        m.cr as i64,
                        m.cw_assumed as i64,
                        m.cw_mismatch as i64,
                        m.web_search as i64,
                        m.web_fetch as i64,
                        m.thinking as i64,
                        m.speed,
                        m.geo,
                        m.service_tier,
                        tier,
                        m.skill,
                        m.mcp_server,
                        m.mcp_tool,
                        m.effort,
                    ])?;
                    th.execute([&hour])?;
                    ts.execute([&sid])?;
                    touched.messages += 1;
                    session_meta_from_message(&mut deltas, &sid, m, task.is_subagent);
                    if touched.hour_lo.as_ref().is_none_or(|c| hour < *c) {
                        touched.hour_lo = Some(hour.clone());
                    }
                    if touched.hour_hi.as_ref().is_none_or(|c| hour > *c) {
                        touched.hour_hi = Some(hour);
                    }
                }
                LineEvent::Title { session_id, title } => {
                    deltas.entry(sid_of(session_id)).or_default().title = Some((title.clone(), true));
                }
                LineEvent::AgentName { session_id, name } => {
                    let d = deltas.entry(sid_of(session_id)).or_default();
                    if !matches!(d.title, Some((_, true))) {
                        d.title = Some((name.clone(), false));
                    }
                }
                LineEvent::Relocated { session_id, cwd } => {
                    deltas.entry(sid_of(session_id)).or_default().project = Some((cwd.clone(), 3));
                }
                LineEvent::CostState { session_id, usd } => {
                    deltas.entry(sid_of(session_id)).or_default().cost = Some(*usd);
                }
                // Read by the helper-run ledger (`apply_ledger`), not a session field of its own.
                LineEvent::AgentSetting { .. } => {}
            }
        }
    }

    // Sessions: create, then fill in what the lines said.
    {
        let mut mk = tx.prepare_cached("INSERT OR IGNORE INTO sessions(session_id) VALUES(?1)")?;
        let mut cur = tx.prepare_cached("SELECT project_key FROM sessions WHERE session_id=?1")?;
        let mut set_proj = tx.prepare_cached(
            "UPDATE sessions SET project_path=?2, project_key=?3, project_src=?4
             WHERE session_id=?1 AND (project_src < ?4 OR ?4 = 3)",
        )?;
        let mut set_custom = tx.prepare_cached(
            "UPDATE sessions SET title=?2, title_source='custom' WHERE session_id=?1",
        )?;
        let mut set_agent = tx.prepare_cached(
            "UPDATE sessions SET title=?2, title_source='agent'
             WHERE session_id=?1 AND COALESCE(title_source,'') <> 'custom'",
        )?;
        let mut set_cost = tx.prepare_cached("UPDATE sessions SET cc_cost_usd=?2 WHERE session_id=?1")?;
        let mut set_misc = tx.prepare_cached(
            "UPDATE sessions SET entrypoint=COALESCE(?2, entrypoint), cc_version=COALESCE(?3, cc_version) WHERE session_id=?1",
        )?;
        let mut all_hours = tx.prepare_cached(
            "INSERT OR IGNORE INTO th SELECT DISTINCT hour_local FROM messages WHERE session_id=?1",
        )?;
        let mut ts = tx.prepare_cached("INSERT OR IGNORE INTO ts(s) VALUES(?1)")?;
        for (sid, d) in &deltas {
            mk.execute([sid])?;
            if let Some((path, src)) = &d.project {
                let before: Option<String> = cur.query_row([sid], |r| r.get(0)).optional()?.flatten();
                let key = project_key(path);
                set_proj.execute(params![sid, path, key, src])?;
                let after: Option<String> = cur.query_row([sid], |r| r.get(0)).optional()?.flatten();
                if before != after {
                    // The session moved projects: its hours regroup (D14).
                    all_hours.execute([sid])?;
                    ts.execute([sid])?;
                }
            }
            match &d.title {
                Some((t, true)) => {
                    set_custom.execute(params![sid, t])?;
                }
                Some((t, false)) => {
                    set_agent.execute(params![sid, t])?;
                }
                None => {}
            }
            if let Some(c) = d.cost {
                set_cost.execute(params![sid, c])?;
            }
            if d.entrypoint.is_some() || d.version.is_some() {
                set_misc.execute(params![sid, d.entrypoint, d.version])?;
            }
        }
    }

    // Subagent registry and prompt summaries.
    if task.is_subagent
        && let Some(aid) = &file_agent
    {
        if b.first {
            let m = b.meta.clone().unwrap_or_default();
            tx.execute("INSERT OR IGNORE INTO sessions(session_id) VALUES(?1)", [&task.folder_session])?;
            tx.execute(
                "INSERT INTO agents(session_id, agent_id, file_id, agent_type, description, tool_use_id, parent_agent_id, spawn_depth)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(session_id, agent_id) DO UPDATE SET
                   file_id=excluded.file_id,
                   agent_type=COALESCE(excluded.agent_type, agent_type),
                   description=COALESCE(excluded.description, description),
                   tool_use_id=COALESCE(excluded.tool_use_id, tool_use_id),
                   parent_agent_id=COALESCE(excluded.parent_agent_id, parent_agent_id),
                   spawn_depth=excluded.spawn_depth",
                params![
                    task.folder_session,
                    aid,
                    task.file_id,
                    m.agent_type,
                    m.description,
                    m.tool_use_id,
                    m.parent_agent_id,
                    m.spawn_depth.unwrap_or(1),
                ],
            )?;
        }
        if let Some(p) = &b.prompt {
            tx.execute(
                "UPDATE agents SET prompt_summary=?3 WHERE session_id=?1 AND agent_id=?2",
                params![task.folder_session, aid, p],
            )?;
        }
    } else if let Some(p) = &b.prompt {
        tx.execute("INSERT OR IGNORE INTO sessions(session_id) VALUES(?1)", [&task.folder_session])?;
        tx.execute("UPDATE sessions SET prompt_summary=?2 WHERE session_id=?1", params![task.folder_session, p])?;
    }

    // What the tool calls were, per session and hour. A file read again from 0 starts its rows over.
    if b.replace_counts {
        tx.execute("DELETE FROM item_use WHERE file_id=?1", [task.file_id])?;
    }
    if !b.items.is_empty() {
        let mut acc: HashMap<(String, i64, &'static str, String), (u64, i64)> = HashMap::new();
        let mut bump = |sid: &str, hour: i64, kind: &'static str, item: &str, ts: i64| {
            let e = acc.entry((sid.to_string(), hour, kind, item.to_string())).or_insert((0, ts));
            e.0 += 1;
            e.1 = e.1.max(ts);
        };
        for t in &b.items {
            let sid = sid_of(&t.session_id);
            let hour = t.ts_ms.div_euclid(3_600_000);
            for u in &t.uses {
                bump(&sid, hour, "tool", &u.name, t.ts_ms);
                match u.name.as_str() {
                    "Skill" => {
                        if let Some(s) = u.skill.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                            bump(&sid, hour, "skill", s, t.ts_ms);
                        }
                    }
                    // Claude Code runs an Agent call with no type as the general-purpose helper.
                    "Agent" | "Task" => {
                        let ty = u.agent_type.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("general-purpose");
                        bump(&sid, hour, "agent", ty, t.ts_ms);
                    }
                    _ => {}
                }
            }
        }
        let mut up = tx.prepare_cached(
            "INSERT INTO item_use(file_id, session_id, hour_utc, hour_local, kind, item, uses, last_ts)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(file_id, session_id, hour_utc, kind, item)
             DO UPDATE SET uses=uses+excluded.uses, last_ts=MAX(last_ts, excluded.last_ts)",
        )?;
        for ((sid, hour, kind, item), (uses, last)) in acc {
            let local = hour_cache
                .entry((hour * 3_600_000).div_euclid(900_000))
                .or_insert_with(|| tz.hour_bucket(hour * 3_600_000))
                .clone();
            up.execute(params![task.file_id, sid, hour, local, kind, item, uses as i64, last])?;
        }
    }

    // The file: committed offset and diagnostics in the same transaction (D5).
    if b.replace_counts {
        tx.execute(
            "UPDATE files SET offset=?2, malformed_lines=?3, long_lines=?4, tool_calls=?5 WHERE file_id=?1",
            params![task.file_id, b.end_offset as i64, b.malformed as i64, b.long_lines as i64, b.tool_calls as i64],
        )?;
    } else {
        tx.execute(
            "UPDATE files SET offset=?2, malformed_lines=malformed_lines+?3, long_lines=long_lines+?4, tool_calls=tool_calls+?5 WHERE file_id=?1",
            params![task.file_id, b.end_offset as i64, b.malformed as i64, b.long_lines as i64, b.tool_calls as i64],
        )?;
    }
    if b.done {
        tx.execute(
            "UPDATE files SET size=?2, mtime_ns=?3 WHERE file_id=?1",
            params![task.file_id, task.size as i64, task.mtime_ns],
        )?;
    }

    refresh_aggregates(&tx)?;
    apply_ledger(&tx, task, b, file_agent.as_deref())?;
    touched.sessions = {
        let mut st = tx.prepare_cached("SELECT s FROM ts")?;
        let v: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        v
    };
    tx.execute_batch("DELETE FROM th; DELETE FROM ts;")?;
    tx.commit()?;
    Ok(touched)
}

/// How a helper run ended (D3), from the strongest source that knows: the parent chat's
/// task-notification, then the sidecar's `finished: true`, then the thread's own last line (an API
/// error, `end_turn`, or an interrupt: the same rule as the receipt's `outcome_of`). None means the
/// run has not visibly ended.
pub(crate) fn end_of(
    notice: Option<&str>,
    sidecar_finished: bool,
    last_api_error: bool,
    last_stop: Option<&str>,
    interrupted: bool,
) -> (Option<&'static str>, Option<&'static str>) {
    match notice {
        Some("completed") => return (Some("finished"), Some("notice")),
        Some("failed") => return (Some("errored"), Some("notice")),
        Some("killed" | "stopped" | "cancelled") => return (Some("stopped"), Some("notice")),
        _ => {}
    }
    if sidecar_finished {
        return (Some("finished"), Some("sidecar"));
    }
    if last_api_error {
        return (Some("errored"), Some("thread"));
    }
    if last_stop == Some("end_turn") {
        return (Some("finished"), Some("thread"));
    }
    if interrupted {
        return (Some("stopped"), Some("thread"));
    }
    (None, None)
}

/// Recompute `end_status` / `end_source` of one run from what the ledger holds now.
fn refresh_end(tx: &rusqlite::Transaction, sid: &str, aid: &str) -> rusqlite::Result<()> {
    type EndRow = (i64, Option<String>, i64, i64, i64, Option<i64>, Option<String>, Option<i64>);
    let row: Option<EndRow> = tx
        .query_row(
            "SELECT r.sidecar_finished, r.last_stop, r.last_api_error, r.interrupted, r.resumes, r.seg_start,
                    (SELECT n.status FROM agent_notices n WHERE n.session_id = r.session_id AND n.agent_id = r.agent_id),
                    (SELECT n.ts FROM agent_notices n WHERE n.session_id = r.session_id AND n.agent_id = r.agent_id)
             FROM agent_runs r WHERE r.session_id = ?1 AND r.agent_id = ?2",
            params![sid, aid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
        )
        .optional()?;
    let Some((mut fin, stop, api, mut int, resumes, seg, mut notice, notice_ts)) = row else { return Ok(()) };
    // A helper that was woken again and has not finished this stretch is running: what said it was
    // done (a notice older than the stretch, the sidecar, an old interrupt) was about the last one.
    if resumes > 0 && api == 0 && stop.as_deref() != Some("end_turn") {
        if notice.is_some() && !matches!((notice_ts, seg), (Some(n), Some(s)) if n >= s) {
            notice = None;
        }
        fin = 0;
        int = 0;
    }
    let (status, source) = end_of(notice.as_deref(), fin != 0, api != 0, stop.as_deref(), int != 0);
    tx.execute(
        "UPDATE agent_runs SET end_status = ?3, end_source = ?4 WHERE session_id = ?1 AND agent_id = ?2",
        params![sid, aid, status, source],
    )?;
    Ok(())
}

/// Link the dispatches that named helper `aid` before its files existed (`agent_link_pending`) to
/// it, once it is in the ledger. A dispatch with nothing left unresolved loses its empty-target row.
fn heal_pending_links(tx: &rusqlite::Transaction, sid: &str, aid: &str) -> rusqlite::Result<()> {
    let has: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_runs WHERE session_id = ?1 AND agent_id = ?2)",
        params![sid, aid],
        |r| r.get(0),
    )?;
    let waiting: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_link_pending WHERE session_id = ?1 AND token = ?2)",
        params![sid, aid],
        |r| r.get(0),
    )?;
    if !has || !waiting {
        return Ok(());
    }
    tx.execute(
        "INSERT OR REPLACE INTO agent_links(session_id, file_id, kind, tool_use_id, ts, from_agent, subagent_type, target)
         SELECT l.session_id, l.file_id, l.kind, l.tool_use_id, l.ts, l.from_agent, l.subagent_type, ?2
         FROM agent_links l JOIN agent_link_pending p ON p.session_id = l.session_id AND p.tool_use_id = l.tool_use_id
         WHERE p.session_id = ?1 AND p.token = ?2 AND l.kind = 'dispatch' AND l.target = ''",
        params![sid, aid],
    )?;
    tx.execute("DELETE FROM agent_link_pending WHERE session_id = ?1 AND token = ?2", params![sid, aid])?;
    tx.execute(
        "DELETE FROM agent_links
         WHERE session_id = ?1 AND kind = 'dispatch' AND target = ''
           AND tool_use_id IN (SELECT tool_use_id FROM agent_links WHERE session_id = ?1 AND target = ?2)
           AND NOT EXISTS (SELECT 1 FROM agent_link_pending p WHERE p.session_id = ?1 AND p.tool_use_id = agent_links.tool_use_id)",
        params![sid, aid],
    )?;
    Ok(())
}

/// Fold a batch's marks into the helper's stretches of work. The state the earlier reads left is in
/// the stored row (its last line time, and whether its last text ended the turn), so a resume prompt
/// that arrives in a later read, hours after the helper finished, closes the stretch at the helper's
/// last line, not at the prompt: the idle gap is never work. Runs before the batch's own times land.
fn fold_marks(tx: &rusqlite::Transaction, sid: &str, aid: &str, r: &RunBatch) -> rusqlite::Result<()> {
    type Stored = (i64, Option<i64>, Option<i64>, Option<i64>, Option<String>);
    let stored: Option<Stored> = tx
        .query_row(
            "SELECT active_ms, seg_start, first_ts, last_ts, last_stop FROM agent_runs WHERE session_id = ?1 AND agent_id = ?2",
            params![sid, aid],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    let Some((mut active, seg, first, last, stop)) = stored else { return Ok(()) };
    let mut seg = seg.or(first).or(r.first_ts);
    let mut ended = stop.as_deref() == Some("end_turn");
    let mut resumes = 0i64;
    for m in &r.marks {
        match m.kind {
            MarkKind::Ended => ended = true,
            MarkKind::Working => ended = false,
            MarkKind::Prompt => {
                if ended && let Some(next) = m.ts {
                    let end = [m.prev_last, last].into_iter().flatten().max().unwrap_or(next);
                    active += (end - seg.unwrap_or(end)).max(0);
                    seg = Some(next);
                    resumes += 1;
                }
                ended = false;
            }
        }
    }
    if resumes > 0 {
        tx.execute(
            "UPDATE agent_runs SET active_ms = ?3, seg_start = ?4, resumes = resumes + ?5 WHERE session_id = ?1 AND agent_id = ?2",
            params![sid, aid, active, seg, resumes],
        )?;
    }
    Ok(())
}

/// The helper-run ledger of one batch (`docs/specs/agent-scorecard.md` D1-D10): the run row of this
/// file, the parent chat's task-finished notices, the verdict and finding lines of the report, and
/// the dispatch/message links. Everything here is ids, times, counts and masked finding lines.
fn apply_ledger(tx: &rusqlite::Transaction, task: &FileTask, b: &Batch, file_agent: Option<&str>) -> rusqlite::Result<()> {
    let sid = task.folder_session.as_str();
    let r = &b.run;
    if b.replace_counts {
        // This file is read again from byte 0: its rows start over.
        tx.execute(
            "DELETE FROM review_findings WHERE (session_id, agent_id) IN
               (SELECT session_id, agent_id FROM agent_runs WHERE file_id = ?1)",
            [task.file_id],
        )?;
        tx.execute("DELETE FROM agent_runs WHERE file_id = ?1", [task.file_id])?;
        tx.execute("DELETE FROM agent_links WHERE file_id = ?1", [task.file_id])?;
        tx.execute("DELETE FROM agent_run_models WHERE file_id = ?1", [task.file_id])?;
        tx.execute("DELETE FROM agent_link_pending WHERE file_id = ?1", [task.file_id])?;
        // The notices this chat file wrote go with it; the runs they ended are recomputed.
        let gone: Vec<(String, String)> = {
            let mut st = tx.prepare_cached("SELECT session_id, agent_id FROM agent_notices WHERE file_id = ?1")?;
            let v = st.query_map([task.file_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
            v
        };
        tx.execute("DELETE FROM agent_notices WHERE file_id = ?1", [task.file_id])?;
        for (s, a) in &gone {
            refresh_end(tx, s, a)?;
        }
    }

    // The run this file is: a helper (from its path), or the chat itself when it ran as an agent.
    let mut run_aid: Option<&str> = None;
    if let Some(aid) = file_agent {
        if b.first {
            let m = b.meta.as_ref();
            let meta_type = m.and_then(|m| m.agent_type.as_deref()).map(str::trim).filter(|s| !s.is_empty());
            tx.execute("INSERT OR IGNORE INTO sessions(session_id) VALUES(?1)", [sid])?;
            tx.execute(
                "INSERT INTO agent_runs(session_id, agent_id, file_id, agent_type, sidecar_finished, worktree_branch)
                 VALUES(?1, ?2, ?3, COALESCE(?4, 'general-purpose'), ?5, ?6)
                 ON CONFLICT(session_id, agent_id) DO UPDATE SET
                   file_id = excluded.file_id,
                   agent_type = COALESCE(?4, agent_type),
                   sidecar_finished = MAX(sidecar_finished, excluded.sidecar_finished),
                   worktree_branch = COALESCE(excluded.worktree_branch, worktree_branch)",
                params![
                    sid,
                    aid,
                    task.file_id,
                    meta_type,
                    m.and_then(|m| m.finished).unwrap_or(false) as i64,
                    m.and_then(|m| m.worktree_branch.as_deref()),
                ],
            )?;
        }
        run_aid = Some(aid);
    } else if let Some(name) = &r.setting {
        tx.execute("INSERT OR IGNORE INTO sessions(session_id) VALUES(?1)", [sid])?;
        tx.execute("UPDATE sessions SET agent_setting = ?2 WHERE session_id = ?1", params![sid, name])?;
        tx.execute(
            "INSERT INTO agent_runs(session_id, agent_id, file_id, agent_type) VALUES(?1, '', ?2, ?3)
             ON CONFLICT(session_id, agent_id) DO UPDATE SET file_id = excluded.file_id, agent_type = excluded.agent_type",
            params![sid, task.file_id, name],
        )?;
        run_aid = Some("");
    } else if r.tracked {
        // A later batch of a chat that ran as an agent.
        run_aid = Some("");
    }

    if let Some(aid) = run_aid {
        if r.tracked {
            if !r.marks.is_empty() && !aid.is_empty() {
                fold_marks(tx, sid, aid, r)?;
            }
            let (has_end, stop, api) = match &r.end_line {
                Some((s, a)) => (1i64, s.clone(), *a as i64),
                None => (0, None, 0),
            };
            tx.execute(
                "UPDATE agent_runs SET
                   first_ts = CASE WHEN ?3 IS NULL THEN first_ts WHEN first_ts IS NULL OR ?3 < first_ts THEN ?3 ELSE first_ts END,
                   last_ts  = CASE WHEN ?4 IS NULL THEN last_ts  WHEN last_ts  IS NULL OR ?4 > last_ts  THEN ?4 ELSE last_ts  END,
                   last_stop = CASE WHEN ?5 = 1 THEN ?6 ELSE last_stop END,
                   last_api_error = CASE WHEN ?5 = 1 THEN ?7 ELSE last_api_error END,
                   interrupted = MAX(interrupted, ?8)
                 WHERE session_id = ?1 AND agent_id = ?2",
                params![sid, aid, r.first_ts, r.last_ts, has_end, stop, api, r.interrupted as i64],
            )?;
        }
        if !r.models.is_empty() {
            // A read can start inside a message the last read already counted (it streams as several
            // lines): that one is not counted twice.
            let stored: Option<String> = tx
                .query_row("SELECT last_msg_key FROM agent_runs WHERE session_id = ?1 AND agent_id = ?2", params![sid, aid], |row| row.get(0))
                .optional()?
                .flatten();
            let skip = match (&r.first_msg, &stored) {
                (Some((key, model, effort)), Some(st)) if key == st => Some((model.clone(), effort.clone())),
                _ => None,
            };
            let mut put = tx.prepare_cached(
                "INSERT INTO agent_run_models(session_id, agent_id, file_id, model, effort, n) VALUES(?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(session_id, agent_id, model, effort) DO UPDATE SET n = n + excluded.n, file_id = excluded.file_id",
            )?;
            for ((model, effort), n) in &r.models {
                let n = if skip.as_ref().is_some_and(|(m, e)| m == model && e == effort) { n.saturating_sub(1) } else { *n };
                if n > 0 {
                    put.execute(params![sid, aid, task.file_id, model, effort, n])?;
                }
            }
        }
        if let Some(key) = &r.last_msg {
            tx.execute("UPDATE agent_runs SET last_msg_key = ?3 WHERE session_id = ?1 AND agent_id = ?2", params![sid, aid, key])?;
        }
        if let Some(rep) = &r.report {
            tx.execute("DELETE FROM review_findings WHERE session_id = ?1 AND agent_id = ?2", params![sid, aid])?;
            let mut put = tx.prepare_cached(
                "INSERT OR REPLACE INTO review_findings(session_id, agent_id, ord, severity, text, ts) VALUES(?1,?2,?3,?4,?5,?6)",
            )?;
            for (i, f) in rep.findings.iter().enumerate() {
                put.execute(params![sid, aid, i as i64, f.severity, f.text, rep.ts])?;
            }
            tx.execute(
                "UPDATE agent_runs SET verdict_word = ?3, verdict = ?4, findings_n = ?5
                 WHERE session_id = ?1 AND agent_id = ?2",
                params![
                    sid,
                    aid,
                    rep.verdict.as_ref().map(|v| if v.status { format!("{}{}", reviews::STATUS_PREFIX, v.word) } else { v.word.clone() }),
                    rep.verdict.as_ref().map(|v| v.class.as_str()),
                    rep.findings.len() as i64
                ],
            )?;
        }
        tx.execute(
            "UPDATE agent_runs SET tool_calls = COALESCE((SELECT tool_calls FROM files WHERE file_id = ?3), 0)
             WHERE session_id = ?1 AND agent_id = ?2",
            params![sid, aid, task.file_id],
        )?;
        if aid.is_empty() {
            // A chat's own clock is its messages' (the line scan only saw lines after the setting).
            tx.execute(
                "UPDATE agent_runs SET
                   first_ts = COALESCE((SELECT first_ts FROM sessions WHERE session_id = ?1), first_ts),
                   last_ts  = COALESCE((SELECT last_ts  FROM sessions WHERE session_id = ?1), last_ts)
                 WHERE session_id = ?1 AND agent_id = ''",
                [sid],
            )?;
        }
        refresh_end(tx, sid, aid)?;
    }

    // The parent chat's "task finished" records name helpers by id; a run learns its end from them.
    if !r.notices.is_empty() {
        let mut put = tx.prepare_cached(
            "INSERT INTO agent_notices(session_id, agent_id, status, ts, file_id) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(session_id, agent_id) DO UPDATE SET status = excluded.status, ts = COALESCE(excluded.ts, ts),
               file_id = excluded.file_id",
        )?;
        let mut seen: HashSet<&str> = HashSet::new();
        for (aid, status, ts) in &r.notices {
            put.execute(params![sid, aid, status, ts, task.file_id])?;
            seen.insert(aid.as_str());
        }
        for aid in seen {
            refresh_end(tx, sid, aid)?;
        }
    }

    // Dispatches and messages: ids only (D9).
    if !r.links.is_empty() {
        let mut put = tx.prepare_cached(
            "INSERT OR REPLACE INTO agent_links(session_id, file_id, kind, tool_use_id, ts, from_agent, subagent_type, target)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        )?;
        let from = file_agent.unwrap_or("");
        for l in &r.links {
            let kind = if l.send { "send" } else { "dispatch" };
            if l.targets.is_empty() || !l.pending.is_empty() {
                put.execute(params![sid, task.file_id, kind, l.tool_use_id, l.ts, from, l.subagent_type, ""])?;
            }
            for t in &l.targets {
                put.execute(params![sid, task.file_id, kind, l.tool_use_id, l.ts, from, l.subagent_type, t])?;
            }
            // A helper the prompt names that has no files yet: remembered until it has.
            for t in &l.pending {
                tx.execute(
                    "INSERT OR IGNORE INTO agent_link_pending(session_id, tool_use_id, token, file_id) VALUES(?1,?2,?3,?4)",
                    params![sid, l.tool_use_id, t, task.file_id],
                )?;
                heal_pending_links(tx, sid, t)?; // the helper may already be in the ledger
            }
        }
    }

    // A helper's files just appeared: dispatches that named it before it existed now link to it.
    if let Some(aid) = file_agent
        && b.first
    {
        heal_pending_links(tx, sid, aid)?;
    }
    Ok(())
}

fn session_meta_from_message(
    deltas: &mut HashMap<String, SessionDelta>,
    sid: &str,
    m: &MsgEvent,
    in_subagent_file: bool,
) {
    let d = deltas.entry(sid.to_string()).or_default();
    if let Some(cwd) = &m.cwd {
        let src = if in_subagent_file { 1 } else { 2 };
        let better = match &d.project {
            None => true,
            Some((_, s)) => src > *s,
        };
        if better {
            d.project = Some((cwd.clone(), src));
        }
    }
    if m.entrypoint.is_some() {
        d.entrypoint = m.entrypoint.clone();
    }
    if m.version.is_some() {
        d.version = m.version.clone();
    }
}

/// Rebuild the aggregates for the hours in `th` and the sessions in `ts` (D35).
fn refresh_aggregates(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "DELETE FROM usage_hour WHERE hour_local IN (SELECT h FROM th);
         INSERT INTO usage_hour
           SELECT m.hour_local, COALESCE(s.project_key, ''), m.model, m.speed, m.geo,
                  m.service_tier, m.price_tier,
                  SUM(m.input), SUM(m.output), SUM(m.cw5m), SUM(m.cw1h), SUM(m.cr),
                  SUM(m.web_search), SUM(m.web_fetch), COUNT(*)
           FROM messages m LEFT JOIN sessions s ON s.session_id = m.session_id
           WHERE m.hour_local IN (SELECT h FROM th)
           GROUP BY 1,2,3,4,5,6,7;
         UPDATE sessions SET messages = x.n, subagent_messages = x.sn, first_ts = x.f, last_ts = x.l
           FROM (SELECT session_id, COUNT(*) AS n,
                        SUM(CASE WHEN agent_id IS NOT NULL OR is_sidechain = 1 THEN 1 ELSE 0 END) AS sn,
                        MIN(ts_utc_ms) AS f, MAX(ts_utc_ms) AS l
                 FROM messages WHERE session_id IN (SELECT s FROM ts) GROUP BY session_id) x
           WHERE sessions.session_id = x.session_id;
         DELETE FROM session_model WHERE session_id IN (SELECT s FROM ts);
         INSERT INTO session_model
           SELECT session_id, model, speed, geo, service_tier, price_tier,
                  SUM(input), SUM(output), SUM(cw5m), SUM(cw1h), SUM(cr),
                  SUM(web_search), SUM(web_fetch), COUNT(*)
           FROM messages WHERE session_id IN (SELECT s FROM ts)
           GROUP BY 1,2,3,4,5,6;",
    )
}

/// Recompute the stored long-context flag of every message under the live price table, then
/// rebuild the aggregates that carry it. Needed when a price-file edit moves a threshold.
/// Returns how many messages changed tier.
pub fn retier_all(conn: &mut Connection) -> rusqlite::Result<usize> {
    let n = conn.execute(
        "UPDATE messages SET price_tier = price_tier_of(model, input, cw5m, cw1h, cr)
         WHERE price_tier != price_tier_of(model, input, cw5m, cw1h, cr)",
        [],
    )?;
    if n > 0 {
        rebuild_all_aggregates(conn)?;
    }
    Ok(n)
}

/// Rebuild every aggregate from `messages` (time-zone change, repair).
pub fn rebuild_all_aggregates(conn: &mut Connection) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS th(h TEXT PRIMARY KEY) WITHOUT ROWID;
         CREATE TEMP TABLE IF NOT EXISTS ts(s TEXT PRIMARY KEY) WITHOUT ROWID;
         DELETE FROM th; DELETE FROM ts;
         INSERT INTO th SELECT DISTINCT hour_local FROM messages;
         INSERT INTO ts SELECT session_id FROM sessions;",
    )?;
    refresh_aggregates(&tx)?;
    tx.execute_batch("DELETE FROM th; DELETE FROM ts;")?;
    tx.commit()
}

/// Recompute `sessions.missing` for the sessions that have rows in `file_ids`.
pub fn refresh_missing(conn: &mut Connection, file_ids: &[i64]) -> rusqlite::Result<()> {
    if file_ids.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    {
        let mut sess = tx.prepare_cached("SELECT DISTINCT session_id FROM messages WHERE file_id=?1")?;
        let mut upd = tx.prepare_cached(
            "UPDATE sessions SET missing = NOT EXISTS (
               SELECT 1 FROM messages m JOIN files f ON f.file_id = m.file_id
               WHERE m.session_id = sessions.session_id AND f.missing = 0)
             WHERE session_id = ?1",
        )?;
        for fid in file_ids {
            let ids: Vec<String> = sess.query_map([fid], |r| r.get(0))?.collect::<Result<_, _>>()?;
            for s in ids {
                upd.execute([s])?;
            }
        }
    }
    tx.commit()
}

#[cfg(test)]
mod known_tests {
    use super::*;

    /// A sidecar that is half written when the folder is first listed is read again on the next
    /// call, not remembered as read and empty.
    #[test]
    fn a_half_written_sidecar_is_read_again() {
        let dir = tempfile::tempdir().unwrap();
        let side = dir.path().join("agent-a0000000000000009.meta.json");
        std::fs::write(&side, r#"{"agentType":"coder","worktreeBran"#).unwrap();
        let k = load_known(dir.path());
        assert!(k.ids.contains("a0000000000000009"));
        assert!(k.branches.is_empty());
        std::fs::write(&side, r#"{"agentType":"coder","worktreeBranch":"claude/x"}"#).unwrap();
        let k = load_known(dir.path());
        assert_eq!(k.branches, vec![("claude/x".to_string(), "a0000000000000009".to_string())]);
    }
}
