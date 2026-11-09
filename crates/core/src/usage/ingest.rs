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
    /// Stretches of work this batch closed: a message woke the helper after it had finished.
    stretches: Vec<Stretch>,
}

/// One finished stretch of a helper's work and when the next one began (a resume).
struct Stretch {
    /// Where it began; None = before this read (the stored `seg_start` or first line applies).
    start: Option<i64>,
    end: i64,
    next: i64,
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
}

/// A last-line buffer that is reused, never grown without bound.
#[derive(Default)]
struct Slot {
    buf: Vec<u8>,
    set: bool,
}

impl Slot {
    fn put(&mut self, line: &[u8]) {
        self.buf.clear();
        if line.len() <= reviews::Thresholds::FINAL_TEXT_CAP {
            self.buf.extend_from_slice(line);
            self.set = true;
        } else {
            self.set = false;
        }
    }
}

/// The helpers of a chat that exist on disk: their ids and worktree branches, to find the ones a
/// dispatch prompt names. Read lazily, once per file, only when a prompt has to be checked.
#[derive(Default)]
struct Known {
    ids: HashSet<String>,
    branches: Vec<(String, String)>,
}

/// Per-file scratch of the ledger scan (lives across batches of one file).
#[derive(Default)]
struct RunScan {
    rc: Slot,
    text: Slot,
    setting_seen: bool,
    known: Option<Known>,
    /// Message keys already counted in `RunBatch::models` (a message streams as several lines).
    msg_seen: HashSet<String>,
    /// The last assistant text ended its turn, so the next real message is a resume.
    ended: bool,
    /// A real prompt was seen in this file (the first is the dispatch, not a resume).
    prompted: bool,
    /// The current stretch began / last had a line at these times.
    seg_start: Option<i64>,
    seg_last: Option<i64>,
}

/// Finders for the stretch scan, made once per worker.
struct SegFinders {
    user: memchr::memmem::Finder<'static>,
    tool_result: memchr::memmem::Finder<'static>,
    compaction: memchr::memmem::Finder<'static>,
    end_turn: memchr::memmem::Finder<'static>,
}

impl SegFinders {
    fn new() -> Self {
        let f = |s: &'static str| memchr::memmem::Finder::new(s.as_bytes()).into_owned();
        SegFinders {
            user: f(r#""type":"user""#),
            tool_result: f(r#""type":"tool_result""#),
            compaction: f("This session is being continued"),
            end_turn: f(r#""stop_reason":"end_turn""#),
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

fn load_known(dir: &Path) -> Known {
    let mut k = Known::default();
    let Ok(rd) = std::fs::read_dir(dir) else { return k };
    for e in rd.flatten().take(5000) {
        let p = e.path();
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
        if let Some(stem) = name.strip_suffix(".meta.json") {
            let id = naming::agent_id_of_stem(stem);
            if let Some(br) = read_sidecar(&p).and_then(|m| m.worktree_branch) {
                k.branches.push((br, id.clone()));
            }
            k.ids.insert(id);
        } else if let Some(stem) = name.strip_suffix(".jsonl") {
            k.ids.insert(naming::agent_id_of_stem(stem));
        }
    }
    k
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
        // A real message after the helper's last text ended its turn wakes it again (SendMessage):
        // that closes one stretch of work and opens the next. The first real message is the dispatch.
        if task.is_subagent
            && !interrupt
            && seg.user.find(l).is_some()
            && seg.tool_result.find(l).is_none()
            && seg.compaction.find(l).is_none()
        {
            if rs.prompted
                && rs.ended
                && let (Some(ts), Some(end)) = (ts, rs.seg_last)
            {
                run.stretches.push(Stretch { start: rs.seg_start, end, next: ts });
                rs.seg_start = Some(ts);
            }
            rs.prompted = true;
            rs.ended = false;
        }
        if let Some(ts) = ts {
            run.first_ts = Some(run.first_ts.map_or(ts, |c| c.min(ts)));
            run.last_ts = Some(run.last_ts.map_or(ts, |c| c.max(ts)));
            if rs.seg_last.is_none() && task.start == 0 {
                rs.seg_start = Some(ts);
            }
            rs.seg_last = Some(rs.seg_last.map_or(ts, |c| c.max(ts)));
        }
        if interrupt {
            run.interrupted = true;
        } else if pf.is_assistant_text(l) {
            rs.rc.put(l);
            rs.text.put(l);
            rs.ended = seg.end_turn.find(l).is_some();
        } else if pf.is_assistant_call(l) {
            rs.rc.put(l);
            rs.ended = false;
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
                    run.links.push(LinkRow { send: true, tool_use_id: c.tool_use_id, ts: f.ts_ms, subagent_type: String::new(), targets: vec![to] });
                }
            } else {
                let targets = match c.prompt.as_deref() {
                    Some(p) if !p.is_empty() => {
                        let k = rs.known.get_or_insert_with(|| load_known(&helpers_dir(task)));
                        mentioned(p, k)
                    }
                    _ => Vec::new(),
                };
                run.links.push(LinkRow {
                    send: false,
                    tool_use_id: c.tool_use_id,
                    ts: f.ts_ms,
                    subagent_type: c.subagent_type.map(|t| t.trim().to_string()).unwrap_or_default(),
                    targets,
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
    }
    if rs.text.set {
        if let Some(f) = pf.assistant_facts(&rs.text.buf, true)
            && let Some(t) = f.text
        {
            run.report = Some(Report { ts: f.ts_ms, verdict: reviews::parse_verdict(&t), findings: reviews::finding_lines(&t) });
        }
        rs.text.set = false;
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
        let mut rs = RunScan { prompted: task.start > 0, ..RunScan::default() };
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
    let row: Option<(i64, Option<String>, i64, i64, Option<String>)> = tx
        .query_row(
            "SELECT r.sidecar_finished, r.last_stop, r.last_api_error, r.interrupted,
                    (SELECT n.status FROM agent_notices n WHERE n.session_id = r.session_id AND n.agent_id = r.agent_id)
             FROM agent_runs r WHERE r.session_id = ?1 AND r.agent_id = ?2",
            params![sid, aid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let Some((fin, stop, api, int, notice)) = row else { return Ok(()) };
    let (status, source) = end_of(notice.as_deref(), fin != 0, api != 0, stop.as_deref(), int != 0);
    tx.execute(
        "UPDATE agent_runs SET end_status = ?3, end_source = ?4 WHERE session_id = ?1 AND agent_id = ?2",
        params![sid, aid, status, source],
    )?;
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
        if !r.stretches.is_empty() && !aid.is_empty() {
            let (mut active, mut seg, first): (i64, Option<i64>, Option<i64>) = tx.query_row(
                "SELECT active_ms, seg_start, first_ts FROM agent_runs WHERE session_id = ?1 AND agent_id = ?2",
                params![sid, aid],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            for st in &r.stretches {
                let from = st.start.or(seg).or(first).unwrap_or(st.end);
                active += (st.end - from).max(0);
                seg = Some(st.next);
            }
            tx.execute(
                "UPDATE agent_runs SET active_ms = ?3, seg_start = ?4, resumes = resumes + ?5 WHERE session_id = ?1 AND agent_id = ?2",
                params![sid, aid, active, seg, r.stretches.len() as i64],
            )?;
        }
        if !r.models.is_empty() {
            let mut put = tx.prepare_cached(
                "INSERT INTO agent_run_models(session_id, agent_id, file_id, model, effort, n) VALUES(?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(session_id, agent_id, model, effort) DO UPDATE SET n = n + excluded.n, file_id = excluded.file_id",
            )?;
            for ((model, effort), n) in &r.models {
                put.execute(params![sid, aid, task.file_id, model, effort, n])?;
            }
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
            "INSERT INTO agent_notices(session_id, agent_id, status, ts) VALUES(?1,?2,?3,?4)
             ON CONFLICT(session_id, agent_id) DO UPDATE SET status = excluded.status, ts = COALESCE(excluded.ts, ts)",
        )?;
        let mut seen: HashSet<&str> = HashSet::new();
        for (aid, status, ts) in &r.notices {
            put.execute(params![sid, aid, status, ts])?;
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
            if l.targets.is_empty() {
                put.execute(params![sid, task.file_id, kind, l.tool_use_id, l.ts, from, l.subagent_type, ""])?;
            }
            for t in &l.targets {
                put.execute(params![sid, task.file_id, kind, l.tool_use_id, l.ts, from, l.subagent_type, t])?;
            }
        }
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
