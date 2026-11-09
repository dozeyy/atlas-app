//! The Now tab's engine: watches the Claude projects folder, follows the chats that were
//! written to in the last couple of minutes, and tells a sink whenever what the page
//! shows has changed.
//!
//! Cost shape: with nothing running the worker thread is blocked on a channel (no timer,
//! no polling). While a chat is running it wakes at most once a second to stat the files
//! it follows (a safety net for filesystems that report appends late) and on every watcher
//! event. Transcripts are opened read-only through `usage::reader` only, and read from
//! where the last read ended.

pub mod facts;
pub mod model;
pub mod finish;
pub mod track;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

pub use model::{Doing, NowChat, NowFile, NowHelper, NowLast, NowSnapshot, NowStep};

use crate::usage::pricing::PriceTable;
use crate::usage::reader::ReadStats;
use crate::usage::scan::{self, Found};
use crate::usage::time::now_ms;
use facts::Facts;
use track::{Session, last_entry_ms, mtime_ms, tail_last};

/// A chat is "running" while any of its files was written to this recently.
pub const WINDOW_MS: i64 = 120_000;
/// ...and its newest entry is no older than this. A restored or copied `~/.claude` (Time
/// Machine, Migration Assistant, a sync) gives every old transcript a fresh write time; its
/// entries keep their real times. Generous, so one long streamed reply never drops a live chat.
pub const ENTRY_MAX_AGE_MS: i64 = 15 * 60_000;
/// At most one update this often.
const THROTTLE: Duration = Duration::from_millis(150);
/// Wait this long after the first event so a burst of writes becomes one read.
const COALESCE: Duration = Duration::from_millis(40);
/// While something runs, stat its files this often.
const SAFETY_TICK: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub struct NowConfig {
    pub projects_dir: PathBuf,
    pub prices: PriceTable,
    pub window_ms: i64,
}

impl NowConfig {
    pub fn new(projects_dir: PathBuf, prices: PriceTable) -> NowConfig {
        NowConfig { projects_dir, prices, window_ms: WINDOW_MS }
    }
}

/// Where updates go. The app turns them into an event for the page.
pub trait NowSink: Send + Sync + 'static {
    fn update(&self, snapshot: &NowSnapshot);
}

impl<F: Fn(&NowSnapshot) + Send + Sync + 'static> NowSink for F {
    fn update(&self, snapshot: &NowSnapshot) {
        self(snapshot)
    }
}

enum Msg {
    Path(PathBuf),
    Rescan,
    Stop,
}

pub struct NowEngine {
    tx: Sender<Msg>,
    shared: Arc<Mutex<NowSnapshot>>,
    join: Mutex<Option<JoinHandle<()>>>,
    // Held only to keep the OS watch alive.
    _watcher: Option<RecommendedWatcher>,
}

impl NowEngine {
    pub fn start(cfg: NowConfig, sink: Arc<dyn NowSink>) -> NowEngine {
        let (tx, rx) = mpsc::channel::<Msg>();
        let shared = Arc::new(Mutex::new(NowSnapshot::default()));

        let mut watcher = None;
        if cfg.projects_dir.is_dir() {
            let (tx2, pd) = (tx.clone(), cfg.projects_dir.clone());
            let canon = crate::usage::watch::canon_root(&pd);
            let made = notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
                Ok(ev) => {
                    if matches!(ev.kind, EventKind::Access(_)) {
                        return;
                    }
                    for p in ev.paths {
                        let p = crate::usage::watch::rebase(&pd, &canon, p);
                        if scan::classify(&pd, &p).is_some() {
                            let _ = tx2.send(Msg::Path(p));
                        }
                    }
                }
                Err(_) => {
                    let _ = tx2.send(Msg::Rescan);
                }
            });
            if let Ok(mut w) = made
                && w.watch(&cfg.projects_dir, RecursiveMode::Recursive).is_ok()
            {
                watcher = Some(w);
            }
        }
        // No watcher (a network drive, a refused handle): look again every second.
        let polling = watcher.is_none() && cfg.projects_dir.is_dir();

        let shared2 = shared.clone();
        let join = thread::Builder::new()
            .name("atlas-now".into())
            .spawn(move || run(cfg, rx, sink, shared2, polling))
            .ok();
        NowEngine { tx, shared, join: Mutex::new(join), _watcher: watcher }
    }

    pub fn snapshot(&self) -> NowSnapshot {
        self.shared.lock().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn stop(&self) {
        let _ = self.tx.send(Msg::Stop);
        if let Some(j) = self.join.lock().ok().and_then(|mut j| j.take()) {
            let _ = j.join();
        }
    }
}

impl Drop for NowEngine {
    fn drop(&mut self) {
        self.stop();
    }
}

// ------------------------------------------------------------------------------- worker

fn run(cfg: NowConfig, rx: mpsc::Receiver<Msg>, sink: Arc<dyn NowSink>, shared: Arc<Mutex<NowSnapshot>>, polling: bool) {
    let mut st = State::new(cfg);
    st.load_initial(now_ms());
    let mut last_json = String::new();
    let mut last_emit: Option<Instant> = None;
    let mut dirty = true;
    loop {
        let wait = if dirty {
            Some(last_emit.map_or(Duration::ZERO, |t| THROTTLE.saturating_sub(t.elapsed())))
        } else if st.has_active() || polling {
            Some(SAFETY_TICK)
        } else {
            None
        };
        let mut paths: HashSet<PathBuf> = HashSet::new();
        let mut rescan = false;
        let first = match wait {
            None => rx.recv().ok(),
            Some(d) => match rx.recv_timeout(d) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            },
        };
        if let Some(m) = first {
            let mut take = |m: Msg| -> bool {
                match m {
                    Msg::Stop => return false,
                    Msg::Path(p) => {
                        paths.insert(p);
                    }
                    Msg::Rescan => rescan = true,
                }
                true
            };
            if !take(m) {
                return;
            }
            thread::sleep(COALESCE);
            while let Ok(m) = rx.try_recv() {
                if !take(m) {
                    return;
                }
            }
        } else if wait.is_none() {
            return; // the channel closed
        }

        let now = now_ms();
        for p in &paths {
            st.on_path(p, now);
        }
        if rescan || polling {
            st.rescan(now);
        }
        st.tick(now);

        let snap = st.snapshot(now);
        let json = serde_json::to_string(&snap).unwrap_or_default();
        if json != last_json {
            if last_emit.is_none_or(|t| t.elapsed() >= THROTTLE) {
                if let Ok(mut g) = shared.lock() {
                    *g = snap.clone();
                }
                sink.update(&snap);
                last_json = json;
                last_emit = Some(Instant::now());
                dirty = false;
            } else {
                dirty = true;
            }
        } else {
            dirty = false;
        }
    }
}

// ------------------------------------------------------------------------------- state

pub(crate) struct State {
    cfg: NowConfig,
    facts: Facts,
    stats: ReadStats,
    sessions: Vec<Session>,
    /// Chats that are not running, newest first.
    recent: Vec<NowLast>,
    seq: u64,
    /// Freshly written files whose newest entry is old (a restore), by (write time, size), so
    /// the polling fallback does not read their ends again every second.
    stale: HashMap<PathBuf, (i64, u64)>,
}

/// How many finished chats the page can list.
pub const RECENT_MAX: usize = 6;

impl State {
    pub(crate) fn new(cfg: NowConfig) -> State {
        State {
            cfg,
            facts: Facts::new(),
            stats: ReadStats::default(),
            sessions: Vec::new(),
            recent: Vec::new(),
            seq: 0,
            stale: HashMap::new(),
        }
    }

    /// Is a chat whose newest file is `path` running? Written within the window, and its newest
    /// entry recent too: a write time alone is not enough (see `ENTRY_MAX_AGE_MS`).
    fn is_live(&mut self, path: &Path, mtime_ms: i64, size: u64, now: i64) -> bool {
        if now - mtime_ms > self.cfg.window_ms {
            return false;
        }
        if self.stale.get(path) == Some(&(mtime_ms, size)) {
            return false;
        }
        match last_entry_ms(path) {
            Some(ts) if now - ts > ENTRY_MAX_AGE_MS => {
                self.stale.insert(path.to_path_buf(), (mtime_ms, size));
                false
            }
            _ => true,
        }
    }

    /// Put a chat that just stopped at the top of the finished list (once, newest first).
    fn remember(&mut self, l: NowLast) {
        self.recent.retain(|r| r.session_id != l.session_id);
        self.recent.push(l);
        self.recent.sort_by_key(|r| std::cmp::Reverse(r.ended_ms));
        self.recent.truncate(RECENT_MAX);
    }

    pub(crate) fn has_active(&self) -> bool {
        !self.sessions.is_empty()
    }

    fn proj_dir_of(path: &Path, is_sub: bool) -> Option<PathBuf> {
        let up = if is_sub { path.parent()?.parent()?.parent()? } else { path.parent()? };
        Some(up.to_path_buf())
    }

    /// The chat's own transcript and every helper transcript beside it.
    fn siblings(proj_dir: &Path, sid: &str) -> Vec<(PathBuf, bool)> {
        let mut out = Vec::new();
        let main = proj_dir.join(format!("{sid}.jsonl"));
        if main.is_file() {
            out.push((main, false));
        }
        if let Ok(rd) = std::fs::read_dir(proj_dir.join(sid).join("subagents")) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("jsonl")) {
                    out.push((p, true));
                }
            }
        }
        out
    }

    fn open_session(&mut self, sid: &str, proj_dir: &Path) {
        self.seq += 1;
        let hint = proj_dir.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let mut s = Session::new(sid.to_string(), self.seq, hint);
        for (p, is_sub) in State::siblings(proj_dir, sid) {
            let fi = s.add_file(&p, is_sub);
            let _ = s.read_file(fi, &self.facts, &self.cfg.prices, &self.stats);
        }
        if !s.files.is_empty() {
            self.recent.retain(|r| r.session_id != sid);
            self.sessions.push(s);
        }
    }

    /// Everything on disk: open the chats that are running, remember the newest other one.
    pub(crate) fn load_initial(&mut self, now: i64) {
        self.sessions.clear();
        let found = scan::walk(&self.cfg.projects_dir).unwrap_or_default();
        self.adopt(&found, now);
    }

    fn adopt(&mut self, found: &[Found], now: i64) {
        let cutoff = now - self.cfg.window_ms;
        let mut newest: HashMap<&str, (i64, &Found)> = HashMap::new();
        let mut active: Vec<(&str, PathBuf)> = Vec::new();
        for f in found {
            let ms = (f.mtime_ns / 1_000_000).max(0);
            let e = newest.entry(f.folder_session.as_str()).or_insert((0, f));
            if ms > e.0 {
                *e = (ms, f);
            }
        }
        for (sid, (ms, f)) in &newest {
            if *ms >= cutoff
                && !self.sessions.iter().any(|s| s.id == *sid)
                && self.is_live(&f.path, *ms, f.size, now)
                && let Some(pd) = State::proj_dir_of(&f.path, f.is_subagent)
            {
                active.push((sid, pd));
            }
        }
        active.sort_by_key(|(sid, _)| newest[sid].0);
        for (sid, pd) in active {
            self.open_session(sid, &pd);
        }
        if self.recent.is_empty() {
            self.find_recent(found);
        }
    }

    /// The newest chats that are not running, each read from the end of its transcript.
    fn find_recent(&mut self, found: &[Found]) {
        let mut by_chat: HashMap<&str, &Found> = HashMap::new();
        for f in found.iter().filter(|f| !f.is_subagent && !self.sessions.iter().any(|s| s.id == f.folder_session)) {
            let e = by_chat.entry(f.folder_session.as_str()).or_insert(f);
            if f.mtime_ns > e.mtime_ns {
                *e = f;
            }
        }
        let mut newest: Vec<&Found> = by_chat.into_values().collect();
        newest.sort_by_key(|f| std::cmp::Reverse(f.mtime_ns));
        for f in newest.into_iter().take(RECENT_MAX) {
            let ended = (f.mtime_ns / 1_000_000).max(0);
            let hint = f.path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()).unwrap_or("");
            if let Some(mut l) = tail_last(&f.path, &f.folder_session, hint, &self.facts, &self.cfg.prices, &self.stats) {
                l.ended_ms = l.ended_ms.min(ended);
                self.remember(l);
            }
        }
    }

    /// A watcher event for one transcript path.
    pub(crate) fn on_path(&mut self, path: &Path, now: i64) {
        let Some(found) = scan::stat_path(&self.cfg.projects_dir, path) else { return };
        let sid = found.folder_session.clone();
        if let Some(i) = self.sessions.iter().position(|s| s.id == sid) {
            let s = &mut self.sessions[i];
            let fi = s.add_file(path, found.is_subagent);
            let _ = s.read_file(fi, &self.facts, &self.cfg.prices, &self.stats);
            return;
        }
        if self.is_live(&found.path, found.mtime_ns / 1_000_000, found.size, now)
            && let Some(pd) = State::proj_dir_of(&found.path, found.is_subagent)
        {
            self.open_session(&sid, &pd);
        }
    }

    /// A full look (the watcher lost track, or there is no watcher).
    pub(crate) fn rescan(&mut self, now: i64) {
        let found = scan::walk(&self.cfg.projects_dir).unwrap_or_default();
        self.adopt(&found, now);
    }

    /// Once a second while something runs: catch appends the watcher reported late, and
    /// retire chats that went quiet.
    pub(crate) fn tick(&mut self, now: i64) {
        let cutoff = now - self.cfg.window_ms;
        self.stale.retain(|_, (m, _)| *m >= cutoff);
        for s in &mut self.sessions {
            for fi in 0..s.files.len() {
                let f = &s.files[fi];
                if f.is_sub && f.mtime_ms < cutoff {
                    continue;
                }
                // `fs::metadata` (not a directory entry) so the size is current on Windows.
                let Ok(m) = std::fs::metadata(&f.path) else { continue };
                if m.len() != f.offset || mtime_ms(&m) != f.mtime_ms {
                    let _ = s.read_file(fi, &self.facts, &self.cfg.prices, &self.stats);
                }
            }
        }
        let (keep, gone): (Vec<_>, Vec<_>) =
            std::mem::take(&mut self.sessions).into_iter().partition(|s| s.newest_write_ms() >= cutoff);
        self.sessions = keep;
        for s in &gone {
            self.remember(s.last());
        }
    }

    pub(crate) fn snapshot(&self, now: i64) -> NowSnapshot {
        let mut order: Vec<&Session> = self.sessions.iter().collect();
        order.sort_by_key(|s| s.seq);
        NowSnapshot {
            chats: order.iter().map(|s| s.chat(now, self.cfg.window_ms)).collect(),
            last: self.recent.first().cloned(),
            recent: self.recent.clone(),
            watching: self.cfg.projects_dir.is_dir(),
        }
    }
}
