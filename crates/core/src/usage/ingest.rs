//! Reading transcripts into the ledger (D5, D11-D14, D34, D35, D39).
//!
//! Workers stream and parse files (largest first); a bounded channel feeds one
//! writer that owns the SQLite connection. Each batch commits in one transaction
//! together with the file's new committed offset, so a killed app resumes exactly
//! where the last commit ended. After a batch, the aggregates for the touched
//! hours and sessions are rebuilt from `messages` (self-healing, no +/- drift).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::sync_channel;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};

use super::line::{LineEvent, MsgEvent, Prefilter, Skip};
use super::pricing::Counts;
use super::reader::{open_read_only, read_lines, Item, ReadStats, LINE_CAP};
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
        };
        let Ok(file) = open_read_only(&task.path) else {
            // Gone or locked: nothing to read now; the next sweep decides.
            let mut b = new_batch(true, task.start);
            b.done = false;
            let _ = tx.send(b);
            continue;
        };
        let mut batch = new_batch(true, task.start);
        let mut first = true;
        let mut prev_end = task.start;
        let mut batch_first_off = task.start;
        let mut lines = 0usize;
        let mut alive = true;
        let result = read_lines(file, task.start, opts.line_cap, stats, |item, end| {
            match item {
                Item::Line(l) => match pf.parse(l) {
                    Ok(ev) => {
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
                },
                Item::LongLine => {
                    batch.long_lines += 1;
                    lines += 1;
                }
            }
            prev_end = end;
            batch.end_offset = end;
            if lines >= opts.batch_lines || end - batch_first_off >= opts.batch_bytes {
                batch.bytes = end - batch_first_off;
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

    // Last line per key within this batch wins (D12).
    let mut last: HashMap<&str, usize> = HashMap::new();
    for (i, (ev, _)) in b.events.iter().enumerate() {
        if let LineEvent::Message(m) = ev {
            last.insert(m.key.as_str(), i);
        }
    }

    let mut deltas: HashMap<String, SessionDelta> = HashMap::new();
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
               price_tier, skill, mcp_server, mcp_tool)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26)",
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
                        m.agent_id,
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

    // The file: committed offset and diagnostics in the same transaction (D5).
    if b.replace_counts {
        tx.execute(
            "UPDATE files SET offset=?2, malformed_lines=?3, long_lines=?4 WHERE file_id=?1",
            params![task.file_id, b.end_offset as i64, b.malformed as i64, b.long_lines as i64],
        )?;
    } else {
        tx.execute(
            "UPDATE files SET offset=?2, malformed_lines=malformed_lines+?3, long_lines=long_lines+?4 WHERE file_id=?1",
            params![task.file_id, b.end_offset as i64, b.malformed as i64, b.long_lines as i64],
        )?;
    }
    if b.done {
        tx.execute(
            "UPDATE files SET size=?2, mtime_ns=?3 WHERE file_id=?1",
            params![task.file_id, task.size as i64, task.mtime_ns],
        )?;
    }

    refresh_aggregates(&tx)?;
    touched.sessions = {
        let mut st = tx.prepare_cached("SELECT s FROM ts")?;
        let v: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        v
    };
    tx.execute_batch("DELETE FROM th; DELETE FROM ts;")?;
    tx.commit()?;
    Ok(touched)
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
