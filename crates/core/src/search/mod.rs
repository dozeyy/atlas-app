//! Full-text search over Claude Code transcripts (user + assistant text).
//!
//! A second, separate engine beside `usage`: its own SQLite file (`db`), its own
//! background thread, its own read-only connections. It reads transcripts only through
//! `usage::reader` (read-only), never touches the usage cache, and never runs on the UI
//! thread. See `docs/specs/tray-and-chat-search.md`.

pub mod db;
pub mod extract;
pub mod mask;
pub mod query;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::usage::reader::{open_read_only, read_lines, Item, ReadStats, LINE_CAP};
use crate::usage::scan::{self, Found};
use crate::usage::time::now_ms;

pub use query::{SearchHit, SearchPage, SnippetPart};

// ---------------------------------------------------------------- config

#[derive(Debug, Clone)]
pub struct SearchConfig {
    pub projects_dir: PathBuf,
    /// The Claude config root: the index must never live inside it.
    pub config_dir: PathBuf,
    /// The SQLite file (`db::search_file`).
    pub db: PathBuf,
    pub sweep_every: Duration,
    /// Commit after this many messages or this many text bytes, whichever first.
    pub batch_msgs: usize,
    pub batch_bytes: usize,
    /// Wait this long after a poke before scanning, so a burst of events is one pass.
    pub debounce: Duration,
}

impl SearchConfig {
    pub fn new(projects_dir: PathBuf, config_dir: PathBuf, db: PathBuf) -> Self {
        SearchConfig {
            projects_dir,
            config_dir,
            db,
            sweep_every: Duration::from_secs(300),
            batch_msgs: 2_000,
            batch_bytes: 16 * 1024 * 1024,
            debounce: Duration::from_millis(300),
        }
    }
}

// ---------------------------------------------------------------- status and sink

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SearchState {
    /// Started, nothing scanned yet (the app waits for the usage index to finish first).
    #[default]
    Waiting,
    Indexing,
    Idle,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchStatus {
    pub state: SearchState,
    /// The first full build has finished: results cover every chat on disk.
    pub ready: bool,
    pub files_done: usize,
    pub files_total: usize,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub messages: u64,
    pub db_bytes: u64,
    pub last_indexed_at: Option<i64>,
    pub error: Option<String>,
}

pub trait SearchSink: Send + Sync + 'static {
    fn status(&self, s: SearchStatus);
    fn log(&self, line: &str) {
        eprintln!("{line}");
    }
}

pub struct NullSearchSink;
impl SearchSink for NullSearchSink {
    fn status(&self, _: SearchStatus) {}
    fn log(&self, _: &str) {}
}

// ---------------------------------------------------------------- engine

enum Msg {
    Poke,
    Reindex,
    Stop,
}

struct Shared {
    status: Mutex<SearchStatus>,
    changed: Condvar,
    cancel: AtomicBool,
    /// Finished passes (tests and the bench wait on it).
    passes: Mutex<u64>,
}

pub struct SearchEngine {
    cfg: SearchConfig,
    tx: Sender<Msg>,
    shared: Arc<Shared>,
    readers: Mutex<Vec<Connection>>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl SearchEngine {
    /// Open (creating) the index and start the thread. Nothing is scanned until `poke()`.
    pub fn start(cfg: SearchConfig, sink: Arc<dyn SearchSink>) -> Arc<SearchEngine> {
        let shared = Arc::new(Shared {
            status: Mutex::new(SearchStatus::default()),
            changed: Condvar::new(),
            cancel: AtomicBool::new(false),
            passes: Mutex::new(0),
        });
        let (tx, rx) = channel();
        let engine = Arc::new(SearchEngine {
            cfg: cfg.clone(),
            tx,
            shared: Arc::clone(&shared),
            readers: Mutex::new(Vec::new()),
            join: Mutex::new(None),
        });
        if crate::usage::is_inside(&cfg.db, &cfg.config_dir) {
            engine.fail(&*sink, "The search index cannot live inside the Claude config folder.".into());
            return engine;
        }
        let conn = match db::open_writer(&cfg.db) {
            Ok(c) => c,
            Err(e) => {
                engine.fail(&*sink, e.to_string());
                return engine;
            }
        };
        let handle = std::thread::Builder::new()
            .name("search-index".into())
            .spawn(move || {
                lower_priority();
                let mut core = Core { cfg, sink, shared, conn, stats: ReadStats::default(), dupes: 0 };
                core.run(rx);
            })
            .expect("spawn search-index thread");
        *engine.join.lock().unwrap_or_else(|p| p.into_inner()) = Some(handle);
        engine
    }

    fn fail(&self, sink: &dyn SearchSink, msg: String) {
        sink.log(&format!("search: error {msg}"));
        let s = SearchStatus { state: SearchState::Error, error: Some(msg), ..Default::default() };
        self.shared.set_status(s.clone());
        sink.status(s);
    }

    /// Something may have changed on disk: scan (debounced). The first call also starts
    /// the first build.
    pub fn poke(&self) {
        let _ = self.tx.send(Msg::Poke);
    }

    /// Throw the index away and read everything again.
    pub fn reindex(&self) {
        let _ = self.tx.send(Msg::Reindex);
    }

    pub fn status(&self) -> SearchStatus {
        self.shared.status.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn passes(&self) -> u64 {
        *self.shared.passes.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Block until a pass finished after `after` passes (tests, bench).
    pub fn wait_pass(&self, after: u64, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut g = self.shared.passes.lock().unwrap_or_else(|p| p.into_inner());
        while *g <= after {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            g = self.shared.changed_passes(g, left);
        }
        true
    }

    /// Stop the thread (cancels a running pass at the next line) and wait for it.
    pub fn stop(&self) {
        self.shared.cancel.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Msg::Stop);
        if let Some(h) = self.join.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = h.join();
        }
    }

    /// Ranked full-text search. Safe to call from any thread, any time (an unfinished
    /// index just answers with what it has so far; `index.ready` says so).
    pub fn search(&self, input: &str, limit: usize, offset: usize) -> Result<SearchPage, String> {
        let status = self.status();
        if status.state == SearchState::Error {
            return Err(status.error.unwrap_or_else(|| "Chat search is not available.".into()));
        }
        let pooled = self.readers.lock().unwrap_or_else(|p| p.into_inner()).pop();
        let conn = match pooled {
            Some(c) => c,
            None => db::open_reader(&self.cfg.db).map_err(|e| format!("Chat search is not ready yet ({e})."))?,
        };
        let out = query::search(&conn, input, limit, offset, status).map_err(|e| format!("Chat search failed ({e})."));
        let mut g = self.readers.lock().unwrap_or_else(|p| p.into_inner());
        if g.len() < 3 {
            g.push(conn);
        }
        out
    }
}

impl Drop for SearchEngine {
    fn drop(&mut self) {
        self.shared.cancel.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Msg::Stop);
    }
}

impl Shared {
    fn set_status(&self, s: SearchStatus) {
        *self.status.lock().unwrap_or_else(|p| p.into_inner()) = s;
    }
    fn changed_passes<'a>(&self, g: std::sync::MutexGuard<'a, u64>, left: Duration) -> std::sync::MutexGuard<'a, u64> {
        self.changed.wait_timeout(g, left.min(Duration::from_millis(100))).unwrap_or_else(|p| p.into_inner()).0
    }
}

/// The index thread yields to the app and to the usage indexer.
fn lower_priority() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL};
        // SAFETY: the pseudo-handle of the calling thread is always valid.
        unsafe {
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
        }
    }
}

// ---------------------------------------------------------------- the indexer thread

struct Core {
    cfg: SearchConfig,
    sink: Arc<dyn SearchSink>,
    shared: Arc<Shared>,
    conn: Connection,
    stats: ReadStats,
    /// Messages skipped because their uuid was already indexed (resumed copies).
    dupes: u64,
}

/// A transcript to read, with where to start.
struct Task {
    file_id: i64,
    path: PathBuf,
    start: u64,
    size: u64,
    mtime_ns: i64,
    is_subagent: bool,
    folder_session: String,
    project: Option<String>,
}

struct Row {
    file_id: i64,
    fs_id: String,
    head_hash: Option<Vec<u8>>,
    head_len: u64,
    size: u64,
    mtime_ns: i64,
    offset: u64,
    missing: bool,
    project: Option<String>,
}

impl Core {
    fn log(&self, s: &str) {
        self.sink.log(s);
    }

    fn cancelled(&self) -> bool {
        self.shared.cancel.load(Ordering::Relaxed)
    }

    fn run(&mut self, rx: Receiver<Msg>) {
        // A parser change wipes the index so it is read again with the new rules.
        if db::get_meta(&self.conn, "parser_version").is_some_and(|v| v != db::PARSER_VERSION) {
            let _ = db::wipe(&self.conn);
        }
        db::set_meta(&self.conn, "parser_version", db::PARSER_VERSION);
        self.publish(SearchState::Waiting, 0, 0, 0, 0);

        let mut next_sweep: Option<Instant> = None;
        loop {
            let msg = match next_sweep {
                None => match rx.recv() {
                    Ok(m) => m,
                    Err(_) => return,
                },
                Some(t) => match rx.recv_timeout(t.saturating_duration_since(Instant::now())) {
                    Ok(m) => m,
                    Err(RecvTimeoutError::Timeout) => Msg::Poke,
                    Err(RecvTimeoutError::Disconnected) => return,
                },
            };
            let mut reindex = false;
            match msg {
                Msg::Stop => return,
                Msg::Reindex => reindex = true,
                Msg::Poke => {}
            }
            // Gather the rest of a burst.
            let until = Instant::now() + self.cfg.debounce;
            loop {
                match rx.recv_timeout(until.saturating_duration_since(Instant::now())) {
                    Ok(Msg::Stop) => return,
                    Ok(Msg::Reindex) => reindex = true,
                    Ok(Msg::Poke) => {}
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            if self.cancelled() {
                return;
            }
            if reindex {
                let _ = db::wipe(&self.conn);
            }
            self.pass();
            next_sweep = Some(Instant::now() + self.cfg.sweep_every);
            if self.cancelled() {
                return;
            }
        }
    }

    fn publish(&self, state: SearchState, files_done: usize, files_total: usize, bytes_done: u64, bytes_total: u64) {
        let ready = db::get_meta(&self.conn, "first_index_done").is_some();
        let messages = self.conn.query_row("SELECT COALESCE(MAX(id),0) FROM msgs", [], |r| r.get::<_, i64>(0)).unwrap_or(0) as u64;
        let mut db_bytes = std::fs::metadata(&self.cfg.db).map(|m| m.len()).unwrap_or(0);
        let mut wal = self.cfg.db.as_os_str().to_os_string();
        wal.push("-wal");
        db_bytes += std::fs::metadata(PathBuf::from(wal)).map(|m| m.len()).unwrap_or(0);
        let s = SearchStatus {
            state,
            ready,
            files_done,
            files_total,
            bytes_done,
            bytes_total,
            messages,
            db_bytes,
            last_indexed_at: db::get_meta(&self.conn, "last_indexed_at").and_then(|v| v.parse().ok()),
            error: None,
        };
        self.shared.set_status(s.clone());
        self.sink.status(s);
    }

    fn load_rows(&self) -> rusqlite::Result<HashMap<String, Row>> {
        let mut out = HashMap::new();
        let mut st = self.conn.prepare(
            "SELECT file_id, path, fs_id, head_hash, head_len, size, mtime_ns, offset, missing, project FROM sfiles",
        )?;
        let rows = st.query_map([], |r| {
            Ok((
                r.get::<_, String>(1)?,
                Row {
                    file_id: r.get(0)?,
                    fs_id: r.get(2)?,
                    head_hash: r.get(3)?,
                    head_len: r.get::<_, i64>(4)? as u64,
                    size: r.get::<_, i64>(5)? as u64,
                    mtime_ns: r.get(6)?,
                    offset: r.get::<_, i64>(7)? as u64,
                    missing: r.get::<_, i64>(8)? != 0,
                    project: r.get(9)?,
                },
            ))
        })?;
        for r in rows {
            let (p, row) = r?;
            out.insert(p, row);
        }
        Ok(out)
    }

    /// Decide what to read: new files from 0, grown files from their offset, replaced or
    /// shrunk files from 0 after their old text is removed. Stats only for unchanged ones.
    fn plan(&mut self, found: &[Found]) -> rusqlite::Result<Vec<Task>> {
        let mut rows = self.load_rows()?;
        let mut tasks = Vec::new();
        let tx = self.conn.transaction()?;
        {
            let mut insert = tx.prepare_cached("INSERT INTO sfiles(path, session_id, is_subagent) VALUES(?1,?2,?3)")?;
            let mut ident = tx.prepare_cached("UPDATE sfiles SET fs_id=?2, head_hash=?3, head_len=?4, offset=?5, missing=0 WHERE file_id=?1")?;
            for f in found {
                let key = f.path.to_string_lossy().into_owned();
                let existing = rows.remove(&key);
                if let Some(r) = &existing
                    && !r.missing
                    && r.size == f.size
                    && r.mtime_ns == f.mtime_ns
                {
                    continue;
                }
                let Ok(mut file) = open_read_only(&f.path) else { continue };
                let id = scan::fs_id(&file).unwrap_or_default();
                let cur_len = file.metadata().map(|m| m.len()).unwrap_or(f.size);
                let head_len = cur_len.min(scan::HEAD_BYTES);
                match existing {
                    Some(r) => {
                        let same_head = match &r.head_hash {
                            Some(old) if r.head_len > 0 => scan::head_hash(&mut file, r.head_len).is_ok_and(|h| &h == old),
                            _ => r.offset == 0,
                        };
                        let reset = id != r.fs_id || !same_head || cur_len < r.offset;
                        if reset {
                            tx.execute("DELETE FROM fts WHERE rowid IN (SELECT id FROM msgs WHERE file_id=?1)", [r.file_id])?;
                            tx.execute("DELETE FROM msgs WHERE file_id=?1", [r.file_id])?;
                        }
                        let hash = scan::head_hash(&mut file, head_len).unwrap_or_default();
                        let start = if reset { 0 } else { r.offset };
                        ident.execute(params![r.file_id, id, hash, head_len as i64, start as i64])?;
                        tasks.push(Task {
                            file_id: r.file_id,
                            path: f.path.clone(),
                            start,
                            size: f.size.max(cur_len),
                            mtime_ns: f.mtime_ns,
                            is_subagent: f.is_subagent,
                            folder_session: f.folder_session.clone(),
                            project: if reset { None } else { r.project },
                        });
                    }
                    None => {
                        insert.execute(params![key, f.folder_session, f.is_subagent as i64])?;
                        let file_id = tx.last_insert_rowid();
                        let hash = scan::head_hash(&mut file, head_len).unwrap_or_default();
                        ident.execute(params![file_id, id, hash, head_len as i64, 0i64])?;
                        tasks.push(Task {
                            file_id,
                            path: f.path.clone(),
                            start: 0,
                            size: f.size.max(cur_len),
                            mtime_ns: f.mtime_ns,
                            is_subagent: f.is_subagent,
                            folder_session: f.folder_session.clone(),
                            project: None,
                        });
                    }
                }
            }
            // Not seen any more: flag it. Its text stays searchable.
            let mut gone = tx.prepare_cached("UPDATE sfiles SET missing=1 WHERE file_id=?1")?;
            for r in rows.values().filter(|r| !r.missing) {
                gone.execute([r.file_id])?;
            }
        }
        tx.commit()?;
        // Newest chats first: they are the ones people look for.
        tasks.sort_by_key(|t| std::cmp::Reverse(t.mtime_ns));
        Ok(tasks)
    }

    fn pass(&mut self) {
        let started = Instant::now();
        let first = db::get_meta(&self.conn, "first_index_done").is_none();
        let found = match scan::walk(&self.cfg.projects_dir) {
            Ok(f) => f,
            Err(e) => {
                self.log(&format!("search: cannot list transcripts ({e})"));
                Vec::new()
            }
        };
        let tasks = match self.plan(&found) {
            Ok(t) => t,
            Err(e) => {
                self.fail(format!("could not plan the index: {e}"));
                return;
            }
        };
        let total_files = tasks.len();
        let total_bytes: u64 = tasks.iter().map(|t| t.size.saturating_sub(t.start)).sum();
        if total_files > 0 {
            self.publish(SearchState::Indexing, 0, total_files, 0, total_bytes);
        }
        let (mut done_files, mut done_bytes) = (0usize, 0u64);
        let mut last_emit = Instant::now();
        let mut completed = true;
        for t in tasks {
            if self.cancelled() {
                completed = false;
                break;
            }
            let span = t.size.saturating_sub(t.start);
            if !self.index_file(&t) {
                completed = false;
            }
            done_files += 1;
            done_bytes += span;
            if last_emit.elapsed() >= Duration::from_millis(250) {
                last_emit = Instant::now();
                self.publish(SearchState::Indexing, done_files, total_files, done_bytes, total_bytes);
            }
        }
        if completed && !self.cancelled() {
            db::set_meta(&self.conn, "last_indexed_at", &(now_ms() / 1000).to_string());
            db::set_meta(&self.conn, "first_index_done", "1");
        }
        if total_files > 0 || first {
            self.log(&format!(
                "search: pass of {total_files} files / {} MB in {} ms ({} repeated uuids skipped so far)",
                total_bytes / 1_000_000,
                started.elapsed().as_millis(),
                self.dupes
            ));
        }
        self.publish(SearchState::Idle, done_files, total_files, done_bytes, total_bytes);
        let mut g = self.shared.passes.lock().unwrap_or_else(|p| p.into_inner());
        *g += 1;
        self.shared.changed.notify_all();
    }

    fn fail(&self, msg: String) {
        self.log(&format!("search: error {msg}"));
        let s = SearchStatus { state: SearchState::Error, error: Some(msg), ..Default::default() };
        self.shared.set_status(s.clone());
        self.sink.status(s);
    }

    /// Read one file from its offset, committing batches. False when it stopped early.
    fn index_file(&mut self, t: &Task) -> bool {
        let Ok(file) = open_read_only(&t.path) else { return false };
        let agent_from_name = t
            .path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.strip_prefix("agent-").unwrap_or(s).to_string());
        let mut ctx = FileCtx { task: t, project: t.project.clone(), agent_from_name };
        let mut batch: Vec<extract::Message> = Vec::new();
        let mut batch_bytes = 0usize;
        let mut last_end = t.start;
        let mut error: Option<rusqlite::Error> = None;
        let (batch_msgs, batch_bytes_max) = (self.cfg.batch_msgs, self.cfg.batch_bytes);
        let cancel = &self.shared.cancel;
        let conn = &mut self.conn;
        let dupes = &mut self.dupes;

        let res = read_lines(file, t.start, LINE_CAP, &self.stats, |item, end| {
            if cancel.load(Ordering::Relaxed) {
                return false;
            }
            if let Item::Line(l) = item
                && let Some(m) = extract::parse(l)
            {
                batch_bytes += m.text.len();
                batch.push(m);
            }
            last_end = end;
            if batch.len() >= batch_msgs || batch_bytes >= batch_bytes_max {
                if let Err(e) = flush(conn, &mut ctx, &mut batch, last_end, dupes) {
                    error = Some(e);
                    return false;
                }
                batch_bytes = 0;
            }
            true
        });
        if let Some(e) = error {
            self.log(&format!("search: write failed ({e})"));
            return false;
        }
        let Ok(committed) = res else { return false };
        let cancelled = self.cancelled();
        let end = if cancelled { last_end } else { committed.max(last_end) };
        if let Err(e) = flush(&mut self.conn, &mut ctx, &mut batch, end, &mut self.dupes) {
            self.log(&format!("search: write failed ({e})"));
            return false;
        }
        if cancelled {
            return false;
        }
        let _ = self.conn.execute("UPDATE sfiles SET size=?2, mtime_ns=?3 WHERE file_id=?1", params![t.file_id, t.size as i64, t.mtime_ns]);
        true
    }
}

struct FileCtx<'a> {
    task: &'a Task,
    project: Option<String>,
    agent_from_name: Option<String>,
}

/// Write a batch and the new offset in one transaction.
fn flush(conn: &mut Connection, ctx: &mut FileCtx<'_>, batch: &mut Vec<extract::Message>, offset: u64, dupes: &mut u64) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut ins = tx.prepare_cached("INSERT OR IGNORE INTO msgs(uuid, file_id, session_id, agent_id, role, ts) VALUES(?1,?2,?3,?4,?5,?6)")?;
        let mut fts = tx.prepare_cached("INSERT INTO fts(rowid, text) VALUES(?1, ?2)")?;
        for m in batch.drain(..) {
            if ctx.project.is_none() {
                ctx.project = m.cwd.clone();
            }
            // A helper's chat belongs to the session that started it.
            let (session, agent) = if ctx.task.is_subagent {
                (ctx.task.folder_session.clone(), m.agent_id.or_else(|| ctx.agent_from_name.clone()))
            } else {
                (m.session_id.unwrap_or_else(|| ctx.task.folder_session.clone()), None)
            };
            let n = ins.execute(params![m.uuid, ctx.task.file_id, session, agent, (m.role == "assistant") as i64, m.ts])?;
            if n == 1 {
                fts.execute(params![tx.last_insert_rowid(), m.text])?;
            } else {
                *dupes += 1;
            }
        }
    }
    tx.execute(
        "UPDATE sfiles SET offset=?2, project=COALESCE(project, ?3) WHERE file_id=?1",
        params![ctx.task.file_id, offset as i64, ctx.project],
    )?;
    tx.commit()
}

/// Where a file's text goes, for tests that want to look inside.
pub fn db_path(cfg: &SearchConfig) -> &Path {
    &cfg.db
}

#[cfg(test)]
mod tests;
