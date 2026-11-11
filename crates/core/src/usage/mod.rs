//! The usage engine (Phase 2): reads Claude Code transcripts into a durable
//! SQLite ledger and answers questions about tokens and estimated cost.
//!
//! No Tauri types here. The app hands in an `EventSink`; the engine owns one
//! coordinator thread (the single SQLite writer), a small read pool for queries,
//! and a file watcher. Nothing in this folder writes a file: the cache and price
//! file code lives in `crate::cache` (acceptance criterion 20).

pub mod costmix;
pub mod count;
pub mod debrief_text;
pub mod ingest;
pub mod line;
pub mod naming;
pub mod pricing;
pub mod query;
pub mod reader;
pub mod receipt;
pub mod receipt_scan;
pub mod reviews;
pub mod scan;
pub mod scorecard;
pub mod time;
pub mod transcript;
pub mod watch;
pub mod wrapped;

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::cache::{self, pricing_file, OpenKind, PriceHandle, ReadPool};
use ingest::{IngestOptions, Progress};
use pricing::PriceTable;
use reader::ReadStats;
use scan::Mode;
use time::{now_ms, Tz};

/// Bump to make every install re-read its transcripts once (D30).
/// "4": effort per reply, and a replayed reply line with zeroed counts no longer wins its key.
/// "5": the helper ledger (agent runs, verdicts, findings).
pub const PARSER_VERSION: &str = "9";

// ---------------------------------------------------------------- config

#[derive(Debug, Clone)]
pub struct UsageConfig {
    /// `<config>/projects`, or the real logs behind a sandbox (read only).
    pub projects_dir: PathBuf,
    /// The Claude config root: the cache must never live inside it (D27).
    pub config_dir: PathBuf,
    /// Atlas's data folder: `pricing.json` lives here.
    pub data_dir: PathBuf,
    /// The SQLite file.
    pub cache_db: PathBuf,
    pub tz: Tz,
    pub week_starts_sunday: bool,
    /// Count cache writes and reads in token totals (the Settings switch). The engine can be
    /// told again later with `set_count_cache`.
    pub count_cache: bool,
    /// Test hook: pretend it is this instant (epoch ms).
    pub now_override_ms: Option<i64>,
    pub ingest: IngestOptions,
    pub watch: bool,
    pub debounce: Duration,
    pub max_wait: Duration,
    pub sweep_every: Duration,
}

impl UsageConfig {
    pub fn new(projects_dir: PathBuf, config_dir: PathBuf, data_dir: PathBuf, cache_db: PathBuf) -> Self {
        UsageConfig {
            projects_dir,
            config_dir,
            data_dir,
            cache_db,
            tz: Tz::Local,
            week_starts_sunday: false,
            count_cache: false,
            now_override_ms: None,
            ingest: IngestOptions::default(),
            watch: true,
            debounce: Duration::from_millis(500),
            max_wait: Duration::from_secs(2),
            sweep_every: Duration::from_secs(300),
        }
    }
}

/// Canonical form of `p` even when it does not exist yet: the deepest existing ancestor
/// is resolved (symlinks, 8.3 short names like `RUNNER~1`, `/var` -> `/private/var`) and
/// the missing tail is appended, so a not-yet-created file compares like its folder.
fn canon(p: &Path) -> std::path::PathBuf {
    let mut cur = p;
    let mut tail = Vec::new();
    loop {
        if let Ok(mut c) = cur.canonicalize() {
            c.extend(tail.iter().rev());
            return c;
        }
        match (cur.parent(), cur.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name);
                cur = parent;
            }
            _ => return p.to_path_buf(),
        }
    }
}

fn norm(p: &Path) -> String {
    let s = canon(p).to_string_lossy().replace('\\', "/");
    let s = s.strip_prefix("//?/").unwrap_or(&s).trim_end_matches('/').to_string();
    if cfg!(any(windows, target_os = "macos")) {
        s.to_lowercase()
    } else {
        s
    }
}

/// True when `inner` is `outer` or below it.
pub fn is_inside(inner: &Path, outer: &Path) -> bool {
    let (i, o) = (norm(inner), norm(outer));
    i == o || i.starts_with(&format!("{o}/"))
}

// ---------------------------------------------------------------- status and events

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Idle,
    #[default]
    Indexing,
    Error,
    ReadOnly,
    Recovering,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatus {
    pub state: State,
    pub first_index_done: bool,
    pub last_indexed_at: Option<i64>,
    pub files_tracked: u64,
    pub files_missing: u64,
    pub malformed_lines: u64,
    pub long_lines: u64,
    pub unknown_models: Vec<String>,
    pub cw_assumed_rows: u64,
    pub cross_file_dupes: u64,
    pub cache_path: String,
    pub cache_bytes: u64,
    pub error: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub phase: &'static str,
    pub files_done: usize,
    pub files_total: usize,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub started_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedEvent {
    pub session_ids: Vec<String>,
    pub from_day: Option<String>,
    pub to_day: Option<String>,
    pub reason: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PricingInfo {
    pub table: PriceTable,
    pub path: String,
    pub error: Option<String>,
    pub newer_seed_available: bool,
}

#[derive(Debug, Clone)]
pub enum Event {
    Status(UsageStatus),
    Progress(ProgressEvent),
    Changed(ChangedEvent),
    Pricing(PricingInfo),
}

pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: Event);
    fn log(&self, line: &str) {
        eprintln!("{line}");
    }
}

pub struct NullSink;
impl EventSink for NullSink {
    fn emit(&self, _: Event) {}
    fn log(&self, _: &str) {}
}

// ---------------------------------------------------------------- the engine

enum Msg {
    Fs(PathBuf),
    Sweep,
    Reindex { full: bool },
    Reprice,
    Visible(bool),
    /// A finished receipt scan to keep (written by the coordinator, the only writer).
    StoreScan { session_id: String, sig: String, body: String },
    Stop,
}

struct Shared {
    status: Mutex<UsageStatus>,
    changed: Condvar,
    pricing: Mutex<PricingInfo>,
    cancel: AtomicBool,
    passes: AtomicU64,
}

impl Shared {
    fn set_status(&self, s: UsageStatus) {
        *self.status.lock().unwrap_or_else(|p| p.into_inner()) = s;
        self.changed.notify_all();
    }
}

pub struct UsageEngine {
    cfg: UsageConfig,
    tx: Sender<Msg>,
    shared: Arc<Shared>,
    pool: ReadPool,
    prices: PriceHandle,
    stats: Arc<ReadStats>,
    /// The "Count cache in token totals" switch, read by every query (see `count`).
    count_cache: AtomicBool,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl UsageEngine {
    /// Start the engine. Refuses (state `error`, nothing written) when the cache
    /// or the data folder would sit inside the Claude config root (D27).
    pub fn start(cfg: UsageConfig, sink: Arc<dyn EventSink>) -> Arc<UsageEngine> {
        let refuse = is_inside(&cfg.cache_db, &cfg.config_dir) || is_inside(&cfg.data_dir, &cfg.config_dir);
        let loaded = if refuse {
            pricing_file::Loaded { table: PriceTable::seed(), error: None, newer_seed_available: false }
        } else {
            pricing_file::init(&cfg.data_dir, None)
        };
        let prices = cache::price_handle(loaded.table.clone());
        let info = PricingInfo {
            table: loaded.table,
            path: pricing_file::live_path(&cfg.data_dir).to_string_lossy().into_owned(),
            error: loaded.error,
            newer_seed_available: loaded.newer_seed_available,
        };
        let mut status = UsageStatus { cache_path: cfg.cache_db.to_string_lossy().into_owned(), ..Default::default() };
        if refuse {
            status.state = State::Error;
            status.error = Some("The usage cache cannot live inside the Claude config folder.".into());
        }
        let shared = Arc::new(Shared {
            status: Mutex::new(status),
            changed: Condvar::new(),
            pricing: Mutex::new(info),
            cancel: AtomicBool::new(false),
            passes: AtomicU64::new(0),
        });
        let (tx, rx) = channel();
        let stats = Arc::new(ReadStats::default());
        let pool = ReadPool::new(cfg.cache_db.clone(), Arc::clone(&prices), cfg.tz);
        let engine = Arc::new(UsageEngine {
            cfg: cfg.clone(),
            tx: tx.clone(),
            shared: Arc::clone(&shared),
            pool,
            prices: Arc::clone(&prices),
            stats: Arc::clone(&stats),
            count_cache: AtomicBool::new(cfg.count_cache),
            join: Mutex::new(None),
        });
        if refuse {
            sink.emit(Event::Status(engine.status()));
            return engine;
        }
        let core_cfg = cfg;
        let handle = std::thread::Builder::new()
            .name("usage-engine".into())
            .spawn(move || {
                let mut core = Core::new(core_cfg, sink, shared, prices, stats, tx);
                core.run(rx);
            })
            .expect("spawn usage-engine thread");
        *engine.join.lock().unwrap_or_else(|p| p.into_inner()) = Some(handle);
        engine
    }

    pub fn status(&self) -> UsageStatus {
        self.shared.status.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn pricing_info(&self) -> PricingInfo {
        self.shared.pricing.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Bytes pulled from transcripts so far (acceptance 17).
    pub fn bytes_read(&self) -> u64 {
        self.stats.bytes()
    }

    pub fn max_line_buffer(&self) -> u64 {
        self.stats.max_buffer()
    }

    pub fn passes(&self) -> u64 {
        self.shared.passes.load(Ordering::SeqCst)
    }

    /// Rescan now: `full` re-reads every file from 0 (rows upsert, so it is safe).
    pub fn reindex(&self, full: bool) {
        let _ = self.tx.send(Msg::Reindex { full });
    }

    /// The window gained focus: sweep as the watcher's safety net (D41).
    pub fn focus(&self) {
        let _ = self.tx.send(Msg::Sweep);
    }

    pub fn set_visible(&self, visible: bool) {
        let _ = self.tx.send(Msg::Visible(visible));
    }

    /// Re-read `pricing.json` (the watcher does this itself).
    pub fn reload_pricing(&self) {
        let _ = self.tx.send(Msg::Reprice);
    }

    /// Block until `pred` holds on the status, or the timeout passes (tests, bench).
    pub fn wait_status(&self, timeout: Duration, pred: impl Fn(&UsageStatus, u64) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        let mut g = self.shared.status.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            if pred(&g, self.shared.passes.load(Ordering::SeqCst)) {
                return true;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            g = self.shared.changed.wait_timeout(g, left.min(Duration::from_millis(100))).unwrap_or_else(|p| p.into_inner()).0;
        }
    }

    /// Wait until a pass finished after `after_passes` and the engine is not busy.
    pub fn wait_pass(&self, after_passes: u64, timeout: Duration) -> bool {
        self.wait_status(timeout, |s, n| {
            n > after_passes && matches!(s.state, State::Idle | State::Error | State::ReadOnly)
        })
    }

    /// Stop the coordinator (cancels a running pass at the next batch) and wait for it.
    pub fn stop(&self) {
        self.shared.cancel.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Msg::Stop);
        if let Some(h) = self.join.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = h.join();
        }
    }

    fn ctx(&self) -> query::QueryCtx {
        query::QueryCtx {
            tz: self.cfg.tz,
            now_ms: self.cfg.now_override_ms.unwrap_or_else(now_ms),
            prices: self.prices.read().unwrap_or_else(|p| p.into_inner()).clone(),
            week_starts_sunday: self.cfg.week_starts_sunday,
            count: self.count(),
        }
    }

    /// How totals are counted right now.
    pub fn count(&self) -> count::TokenCount {
        count::TokenCount::new(self.count_cache.load(Ordering::Relaxed))
    }

    /// The switch changed: every query from now on counts the new way. The caller tells the
    /// front end to ask again (a `usage://changed` event).
    pub fn set_count_cache(&self, on: bool) {
        self.count_cache.store(on, Ordering::Relaxed);
    }

    fn read<T>(&self, f: impl FnOnce(&Connection, &query::QueryCtx) -> rusqlite::Result<T>) -> Result<T, String> {
        let ctx = self.ctx();
        self.pool.with(|c| f(c, &ctx)).map_err(|e| format!("The usage cache is not ready yet ({e})."))
    }

    pub fn dashboard(&self) -> Result<query::Dashboard, String> {
        self.read(query::dashboard)
    }

    /// Today's totals only (the tray readout).
    pub fn today(&self) -> Result<query::Period, String> {
        self.read(query::today)
    }

    pub fn timeline(&self, a: &query::TimelineArgs) -> Result<query::Timeline, String> {
        self.read(|c, x| query::timeline(c, x, a))
    }

    /// Any day range, optionally one project (the `atlas-usage` CLI).
    pub fn scope_report(&self, a: &query::ScopeArgs) -> Result<query::ScopeReport, String> {
        self.read(|c, x| query::scope_report(c, x, a))
    }

    /// Every token counted in the ledger so far, all models and days, as the Dashboard counts
    /// tokens (the "Count cache in token totals" rule). It is the setup program's live line
    /// while it reads. One scan of the small hourly table; 0 while the cache is not ready.
    pub fn tokens_so_far(&self) -> u64 {
        self.read(|c, x| {
            c.query_row(
                &format!("SELECT COALESCE(SUM({}), 0) FROM usage_hour", x.count.sql("")),
                [],
                |r| r.get::<_, i64>(0),
            )
        })
        .map(|n| n.max(0) as u64)
        .unwrap_or(0)
    }

    /// The first local day with recorded usage.
    pub fn first_day(&self) -> Result<Option<String>, String> {
        self.read(|c, _| query::first_day(c))
    }

    /// The typical run of each kind of helper over the last `days` days, for the Now tracker.
    /// `Ok(None)` while the first pass over the transcripts is still running (the medians would be
    /// of a partly read history); `Err` when the query itself failed.
    pub fn typical_runs(&self, days: u32) -> Result<Option<Vec<query::TypicalRun>>, String> {
        if !matches!(self.status().state, State::Idle | State::ReadOnly) {
            return Ok(None);
        }
        self.read(|c, x| query::typical_runs(c, x, days)).map(Some)
    }

    /// The local day it is now (the day the app's periods end on).
    pub fn today_date(&self) -> String {
        query::today_of(&self.ctx())
    }

    pub fn sessions_list(&self, q: &query::SessionQuery) -> Result<query::SessionPage, String> {
        self.read(|c, x| query::sessions_list(c, x, q))
    }

    pub fn session_detail(&self, id: &str) -> Result<Option<query::SessionDetail>, String> {
        self.read(|c, x| query::session_detail(c, x, id))
    }

    /// One subagent with its spend; the prompt it was given is read from its transcript now.
    pub fn agent_detail(&self, session_id: &str, agent_id: &str) -> Result<Option<query::AgentDetail>, String> {
        let mut d = self.read(|c, x| query::agent_detail(c, x, session_id, agent_id))?;
        if let Some(d) = d.as_mut()
            && let Some(f) = d.file.as_ref().filter(|f| !f.missing)
            && let Some((text, cut)) = transcript::first_prompt(Path::new(&f.path), &self.stats)
        {
            d.prompt = Some(text);
            d.prompt_truncated = cut;
        }
        Ok(d)
    }

    /// How often each skill, helper type or tool was used in a period (see `query::usage_by_item`).
    pub fn usage_by_item(&self, q: &query::ItemQuery) -> Result<Vec<query::ItemUse>, String> {
        self.read(|c, _| query::usage_by_item(c, q))
    }

    /// The agent scorecard: one card per helper type (`scorecard`, spec `docs/specs/agent-scorecard.md`).
    pub fn agent_scorecard(&self, a: &scorecard::ScorecardArgs) -> Result<scorecard::Scorecard, String> {
        self.read(|c, x| scorecard::agent_scorecard(c, x, a))
    }

    /// Findings reviewers keep raising, grouped (spec D24, D25).
    pub fn review_themes(&self, a: &scorecard::ThemeArgs) -> Result<scorecard::Themes, String> {
        self.read(|c, x| scorecard::review_themes(c, x, a))
    }

    /// The facts of one chat's helpers since a time, for the after-run debrief (spec D60, D61).
    pub fn run_debrief(&self, a: &scorecard::DebriefArgs) -> Result<Option<scorecard::RunDebrief>, String> {
        self.read(|c, x| scorecard::run_debrief(c, x, a))
    }

    /// Chat shapes, the helpers' share and the chat with the most helpers (the Wrapped story).
    pub fn wrapped_habits(&self, from: &str, to: &str) -> Result<wrapped::WrappedHabits, String> {
        self.read(|c, x| wrapped::wrapped_habits(c, x, from, to))
    }

    /// The last `days` days as the setup-cost estimate needs them (see `costmix`).
    pub fn cost_mix(&self, days: u32) -> Result<costmix::CostMix, String> {
        self.read(|c, x| costmix::cost_mix(c, x, days))
    }

    pub fn filter_options(&self) -> Result<query::FilterOptions, String> {
        self.read(query::filter_options)
    }

    /// "Where the money went" for one chat. The numbers come from the ledger; the big-item and
    /// outcome parts come from one pass over the chat's transcripts, kept in the cache until a
    /// file changes. Runs on the caller's thread (the app calls it off the UI thread).
    pub fn receipt(&self, id: &str) -> Result<Option<receipt::Receipt>, String> {
        use receipt_scan::{Scan, ScanFile, SCAN_VERSION};
        let (files, sig, cached) = self.read(|c, _| {
            let sig = cache::receipts::signature(c, id, SCAN_VERSION)?;
            let cached = cache::receipts::load(c, id, &sig)?.and_then(|b| serde_json::from_str::<Scan>(&b).ok());
            let mut files = Vec::new();
            if cached.is_none() {
                let mut st = c.prepare_cached(
                    "SELECT f.path, a.agent_id FROM files f LEFT JOIN agents a ON a.file_id = f.file_id AND a.session_id = ?1 \
                     WHERE f.session_id = ?1 AND f.missing = 0 AND (f.is_subagent = 0 OR a.agent_id IS NOT NULL) \
                     ORDER BY f.is_subagent, f.path",
                )?;
                for r in st.query_map([id], |r| Ok(ScanFile { path: PathBuf::from(r.get::<_, String>(0)?), agent_id: r.get(1)? }))? {
                    files.push(r?);
                }
            }
            Ok((files, sig, cached))
        })?;
        let scan = match cached {
            Some(s) => s,
            None => {
                let s = receipt_scan::scan_files(&files, &self.stats);
                if s.readable
                    && let Ok(body) = serde_json::to_string(&s)
                {
                    let _ = self.tx.send(Msg::StoreScan { session_id: id.to_string(), sig, body });
                }
                s
            }
        };
        self.read(|c, x| receipt::build(c, x, id, Some(&scan)))
    }

    pub fn session_transcript(
        &self,
        id: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<transcript::TranscriptPage, String> {
        self.read(|c, _| transcript::page(c, id, cursor, limit, &self.stats))
    }
}

impl Drop for UsageEngine {
    fn drop(&mut self) {
        self.shared.cancel.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Msg::Stop);
    }
}

// ---------------------------------------------------------------- the coordinator

fn get_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0)).optional().ok().flatten()
}

fn set_meta(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?1,?2)", [key, value]);
}

/// Stable across daylight-saving switches, changes with the zone rules.
fn tz_fingerprint(tz: Tz) -> String {
    let base = 1_735_689_600_000i64; // 2025-01-01T00:00:00Z
    (0..12).map(|m| tz.offset_secs(base + m * 30 * 86_400_000 + 43_200_000).to_string()).collect::<Vec<_>>().join(",")
}

#[derive(Default)]
struct PendingChanged {
    ids: BTreeSet<String>,
    from: Option<String>,
    to: Option<String>,
    reason: &'static str,
    any: bool,
}

struct Core {
    cfg: UsageConfig,
    sink: Arc<dyn EventSink>,
    shared: Arc<Shared>,
    prices: PriceHandle,
    stats: Arc<ReadStats>,
    tx: Sender<Msg>,
    conn: Option<Connection>,
    kind: OpenKind,
    note: Option<String>,
    force_reparse: bool,
    visible: bool,
    paths: HashSet<PathBuf>,
    want_sweep: bool,
    want_reprice: bool,
    first_event: Option<Instant>,
    last_event: Option<Instant>,
    pending: PendingChanged,
    last_changed: Option<Instant>,
    next_sweep: Instant,
    watch: Option<watch::Watch>,
}

impl Core {
    fn new(
        cfg: UsageConfig,
        sink: Arc<dyn EventSink>,
        shared: Arc<Shared>,
        prices: PriceHandle,
        stats: Arc<ReadStats>,
        tx: Sender<Msg>,
    ) -> Core {
        let next_sweep = Instant::now() + cfg.sweep_every;
        Core {
            cfg,
            sink,
            shared,
            prices,
            stats,
            tx,
            conn: None,
            kind: OpenKind::Ready,
            note: None,
            force_reparse: false,
            visible: true,
            paths: HashSet::new(),
            want_sweep: false,
            want_reprice: false,
            first_event: None,
            last_event: None,
            pending: PendingChanged::default(),
            last_changed: None,
            next_sweep,
            watch: None,
        }
    }

    fn log(&self, line: &str) {
        self.sink.log(line);
    }

    // ----- status

    fn compute_status(&self, state: State, error: Option<String>) -> UsageStatus {
        let mut s = UsageStatus {
            state,
            error,
            note: self.note.clone(),
            cache_path: self.cfg.cache_db.to_string_lossy().into_owned(),
            cache_bytes: std::fs::metadata(&self.cfg.cache_db).map(|m| m.len()).unwrap_or(0),
            ..Default::default()
        };
        let Some(conn) = &self.conn else { return s };
        let row = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(missing),0), COALESCE(SUM(malformed_lines),0), COALESCE(SUM(long_lines),0) FROM files",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?)),
        );
        if let Ok((n, miss, mal, long)) = row {
            s.files_tracked = n as u64;
            s.files_missing = miss as u64;
            s.malformed_lines = mal as u64;
            s.long_lines = long as u64;
        }
        s.cw_assumed_rows =
            conn.query_row("SELECT COUNT(*) FROM messages WHERE cw_assumed=1", [], |r| r.get::<_, i64>(0)).unwrap_or(0) as u64;
        s.cross_file_dupes =
            conn.query_row("SELECT COUNT(*) FROM dupes", [], |r| r.get::<_, i64>(0)).unwrap_or(0) as u64;
        s.last_indexed_at = get_meta(conn, "last_full_index_at").and_then(|v| v.parse().ok());
        s.first_index_done = s.last_indexed_at.is_some();
        let table = self.prices.read().unwrap_or_else(|p| p.into_inner()).clone();
        if let Ok(mut st) = conn.prepare("SELECT DISTINCT model FROM usage_hour ORDER BY model")
            && let Ok(rows) = st.query_map([], |r| r.get::<_, String>(0)) {
                s.unknown_models = rows.flatten().filter(|m| !table.is_known(m)).collect();
            }
        s
    }

    fn publish(&self, state: State, error: Option<String>) {
        let s = self.compute_status(state, error);
        self.shared.set_status(s.clone());
        self.sink.emit(Event::Status(s));
    }

    fn publish_light(&self, state: State) {
        // Cheap state flip while a pass runs: keep the last counts.
        let mut s = self.shared.status.lock().unwrap_or_else(|p| p.into_inner()).clone();
        s.state = state;
        s.note = self.note.clone();
        self.shared.set_status(s.clone());
        self.sink.emit(Event::Status(s));
    }

    fn fail(&self, what: &str, e: impl std::fmt::Display) {
        let msg = format!("{what}: {e}");
        self.log(&format!("usage: error {msg}"));
        self.publish(State::Error, Some(msg));
    }

    // ----- lifecycle

    fn open(&mut self) -> bool {
        self.publish_light(State::Indexing);
        match cache::open_writer(&self.cfg.cache_db) {
            Ok(opened) => {
                if let Some(rec) = &opened.recovered {
                    self.note = Some(if rec.from_backup {
                        "The usage cache was damaged and restored from its last backup. Only transcripts still on disk could be recovered since then.".into()
                    } else {
                        "The usage cache was damaged and started over. Only transcripts still on disk could be recovered.".into()
                    });
                    self.force_reparse = true;
                }
                self.kind = opened.kind.clone();
                let conn = opened.conn;
                if self.kind == OpenKind::Ready {
                    let _ = cache::register_functions(&conn, &self.prices, self.cfg.tz);
                    let created = get_meta(&conn, "created_at").is_none();
                    if created {
                        set_meta(&conn, "created_at", &(now_ms() / 1000).to_string());
                    }
                    set_meta(&conn, "projects_dir", &self.cfg.projects_dir.to_string_lossy());
                    if get_meta(&conn, "parser_version").is_some_and(|v| v != PARSER_VERSION) {
                        self.force_reparse = true;
                    }
                } else {
                    self.note = Some("This cache was made by a newer Atlas. It is shown read-only and not updated.".into());
                }
                self.conn = Some(conn);
                true
            }
            Err(e) => {
                self.fail("could not open the usage cache", e);
                false
            }
        }
    }

    fn tz_check(&mut self) {
        let fp = tz_fingerprint(self.cfg.tz);
        let Some(conn) = self.conn.as_mut() else { return };
        match get_meta(conn, "tz_fingerprint") {
            Some(old) if old == fp => {}
            Some(_) => {
                let ok = conn
                    .execute("UPDATE messages SET hour_local = hour_of(ts_utc_ms)", [])
                    .and_then(|_| conn.execute("UPDATE item_use SET hour_local = hour_of(hour_utc * 3600000)", []))
                    .and_then(|_| ingest::rebuild_all_aggregates(conn).map(|_| 0));
                if let Err(e) = ok {
                    self.log(&format!("usage: time zone rebuild failed: {e}"));
                    return;
                }
                set_meta(conn, "tz_fingerprint", &fp);
                self.queue_changed("tz", &[], None, None);
            }
            None => set_meta(conn, "tz_fingerprint", &fp),
        }
    }

    fn run(&mut self, rx: Receiver<Msg>) {
        if !self.open() {
            self.idle_until_stop(rx);
            return;
        }
        if self.kind == OpenKind::ReadOnly {
            self.publish(State::ReadOnly, None);
            self.shared.passes.fetch_add(1, Ordering::SeqCst);
            self.idle_until_stop(rx);
            return;
        }
        self.tz_check();
        self.publish_light(State::Indexing);
        let force = std::mem::take(&mut self.force_reparse);
        self.pass(Mode::All { force_reparse: force }, "index");
        if self.shared.cancel.load(Ordering::SeqCst) {
            return;
        }
        // Integrity check after the first pass, off the UI path (D32).
        if self.conn.as_ref().is_some_and(|c| !cache::quick_check(c)) {
            self.log("usage: cache failed quick_check; rebuilding");
            self.conn = None;
            if let Ok(rec) = cache::recover(&self.cfg.cache_db) {
                self.note = Some(if rec.from_backup {
                    "The usage cache was damaged and restored from its last backup.".into()
                } else {
                    "The usage cache was damaged and started over. Only transcripts still on disk could be recovered.".into()
                });
            }
            if self.open() {
                self.tz_check();
                self.pass(Mode::All { force_reparse: true }, "index");
            }
        }
        if self.cfg.watch {
            self.start_watch();
        }
        self.main_loop(rx);
    }

    fn idle_until_stop(&mut self, rx: Receiver<Msg>) {
        while let Ok(m) = rx.recv() {
            if matches!(m, Msg::Stop) {
                break;
            }
        }
    }

    fn start_watch(&mut self) {
        let tx = self.tx.clone();
        let res = watch::start(&self.cfg.projects_dir, &self.cfg.data_dir, pricing_file::FILE_NAME, move |seen| {
            let _ = tx.send(match seen {
                watch::Seen::Transcript(p) => Msg::Fs(p),
                watch::Seen::Sweep => Msg::Sweep,
                watch::Seen::Pricing => Msg::Reprice,
            });
        });
        match res {
            Ok(w) => self.watch = Some(w),
            Err(e) => self.log(&format!("usage: watcher unavailable, sweeping instead ({e})")),
        }
    }

    fn deadline_debounce(&self) -> Option<Instant> {
        if self.paths.is_empty() && !self.want_sweep && !self.want_reprice {
            return None;
        }
        let (first, last) = (self.first_event?, self.last_event?);
        Some((last + self.cfg.debounce).min(first + self.cfg.max_wait))
    }

    fn deadline_changed(&self) -> Option<Instant> {
        if !self.pending.any {
            return None;
        }
        Some(self.last_changed.map(|t| t + Duration::from_secs(1)).unwrap_or_else(Instant::now))
    }

    fn note_event(&mut self) {
        let now = Instant::now();
        self.first_event.get_or_insert(now);
        self.last_event = Some(now);
    }

    fn handle(&mut self, m: Msg) -> bool {
        match m {
            Msg::Stop => return false,
            Msg::Fs(p) => {
                if self.paths.len() < 5000 {
                    self.paths.insert(p);
                } else {
                    self.want_sweep = true;
                }
                self.note_event();
            }
            Msg::Sweep => {
                self.want_sweep = true;
                self.note_event();
            }
            Msg::Reprice => {
                self.want_reprice = true;
                self.note_event();
            }
            Msg::Reindex { full } => {
                self.pass(Mode::All { force_reparse: full }, "index");
            }
            Msg::Visible(v) => self.visible = v,
            Msg::StoreScan { session_id, sig, body } => {
                if self.kind == OpenKind::Ready
                    && let Some(conn) = &self.conn
                {
                    let _ = cache::receipts::store(conn, &session_id, &sig, &body, now_ms());
                }
            }
        }
        true
    }

    fn main_loop(&mut self, rx: Receiver<Msg>) {
        loop {
            if self.shared.cancel.load(Ordering::SeqCst) {
                return;
            }
            let now = Instant::now();
            let mut wait = Duration::from_secs(30);
            for d in [self.deadline_debounce(), self.deadline_changed(), Some(self.next_sweep)].into_iter().flatten() {
                wait = wait.min(d.saturating_duration_since(now));
            }
            match rx.recv_timeout(wait) {
                Ok(m) => {
                    if !self.handle(m) {
                        return;
                    }
                    while let Ok(m) = rx.try_recv() {
                        if !self.handle(m) {
                            return;
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            let now = Instant::now();
            if self.deadline_debounce().is_some_and(|d| d <= now) {
                self.flush_events();
            }
            if self.visible && self.next_sweep <= now {
                self.next_sweep = Instant::now() + self.cfg.sweep_every;
                self.pass(Mode::All { force_reparse: false }, "append");
            } else if self.next_sweep <= now {
                self.next_sweep = Instant::now() + self.cfg.sweep_every;
            }
            if self.deadline_changed().is_some_and(|d| d <= Instant::now()) {
                self.emit_changed();
            }
        }
    }

    fn flush_events(&mut self) {
        self.first_event = None;
        self.last_event = None;
        if std::mem::take(&mut self.want_reprice) {
            self.reprice();
        }
        let sweep = std::mem::take(&mut self.want_sweep);
        let paths: Vec<PathBuf> = self.paths.drain().collect();
        if sweep {
            self.pass(Mode::All { force_reparse: false }, "append");
        } else if !paths.is_empty() {
            self.pass(Mode::Paths(paths), "append");
        }
    }

    // ----- pricing

    fn reprice(&mut self) {
        let current = self.prices.read().unwrap_or_else(|p| p.into_inner()).clone();
        let loaded = pricing_file::load(&self.cfg.data_dir, Some(&current));
        let changed = *current != loaded.table;
        let loaded_sig = loaded.table.tier_signature();
        if changed {
            *self.prices.write().unwrap_or_else(|p| p.into_inner()) = Arc::new(loaded.table.clone());
        }
        let info = {
            let mut g = self.shared.pricing.lock().unwrap_or_else(|p| p.into_inner());
            g.table = loaded.table;
            g.error = loaded.error;
            g.clone()
        };
        self.sink.emit(Event::Pricing(info));
        if changed {
            self.log("usage: prices changed");
            if current.tier_signature() != loaded_sig
                && let Some(conn) = self.conn.as_mut().filter(|_| self.kind == OpenKind::Ready)
            {
                match ingest::retier_all(conn) {
                    Ok(n) => self.sink.log(&format!("usage: long-context threshold changed, {n} messages re-tiered")),
                    Err(e) => self.sink.log(&format!("usage: re-tier failed: {e}")),
                }
            }
            self.queue_changed("reprice", &[], None, None);
            self.publish(State::Idle, None);
        }
    }

    // ----- events

    fn queue_changed(&mut self, reason: &'static str, ids: &[String], from: Option<String>, to: Option<String>) {
        let p = &mut self.pending;
        p.any = true;
        p.reason = reason;
        for id in ids.iter().take(500) {
            if p.ids.len() < 500 {
                p.ids.insert(id.clone());
            }
        }
        if let Some(f) = from
            && p.from.as_ref().is_none_or(|c| f < *c) {
                p.from = Some(f);
            }
        if let Some(t) = to
            && p.to.as_ref().is_none_or(|c| t > *c) {
                p.to = Some(t);
            }
    }

    fn emit_changed(&mut self) {
        let p = std::mem::take(&mut self.pending);
        if !p.any {
            return;
        }
        self.last_changed = Some(Instant::now());
        self.log(&format!("usage: changed {} sessions ({})", p.ids.len(), p.reason));
        self.sink.emit(Event::Changed(ChangedEvent {
            session_ids: p.ids.into_iter().collect(),
            from_day: p.from,
            to_day: p.to,
            reason: p.reason,
        }));
    }

    // ----- one pass

    fn pass(&mut self, mode: Mode, reason: &'static str) {
        if self.kind == OpenKind::ReadOnly || self.conn.is_none() {
            return;
        }
        let started = now_ms();
        let t0 = Instant::now();
        let full = matches!(mode, Mode::All { .. });
        let loud = full && reason == "index";
        if full {
            self.publish_light(State::Indexing);
        }
        let sink = Arc::clone(&self.sink);
        let emit_progress = move |phase: &'static str, p: Progress| {
            sink.emit(Event::Progress(ProgressEvent {
                phase,
                files_done: p.files_done,
                files_total: p.files_total,
                bytes_done: p.bytes_done,
                bytes_total: p.bytes_total,
                started_at: started,
            }));
        };
        if full {
            emit_progress("scanning", Progress::default());
        }
        let secs = started / 1000;
        let tz = self.cfg.tz;
        let projects = self.cfg.projects_dir.clone();
        let opts = self.cfg.ingest.clone();
        let (prices, stats, shared) = (Arc::clone(&self.prices), Arc::clone(&self.stats), Arc::clone(&self.shared));
        let mut owned = self.conn.take().expect("checked above");
        let conn = &mut owned;

        let plan = match scan::plan(conn, &projects, &mode, secs, &shared.cancel) {
            Ok(p) => p,
            Err(e) => {
                self.conn = Some(owned);
                self.fail("scan failed", e);
                return;
            }
        };
        let refreshed = ingest::refresh_missing(conn, &plan.flipped);
        let res = ingest::run_tasks(conn, &plan.tasks, tz, &prices, &opts, &stats, &shared.cancel, &mut |p| {
            if full || p.files_total > 3 {
                emit_progress("indexing", p);
            }
        });
        let res = match res {
            Ok(r) => r,
            Err(e) => {
                self.conn = Some(owned);
                self.fail("indexing failed", e);
                return;
            }
        };
        let finished = !(res.cancelled || shared.cancel.load(Ordering::SeqCst));
        if finished && full {
            set_meta(conn, "last_full_index_at", &secs.to_string());
            set_meta(conn, "parser_version", PARSER_VERSION);
            set_meta(conn, "tz_fingerprint", &tz_fingerprint(tz));
        }
        self.conn = Some(owned);
        if let Err(e) = refreshed {
            self.log(&format!("usage: could not refresh missing flags: {e}"));
        }
        if !finished {
            self.publish(State::Idle, None);
            return;
        }
        if full {
            self.maybe_backup(secs);
        }
        let total: i64 = self
            .conn
            .as_ref()
            .and_then(|c| c.query_row("SELECT COALESCE(SUM(messages),0) FROM sessions", [], |r| r.get(0)).ok())
            .unwrap_or(0);
        self.publish(State::Idle, None);
        {
            // Under the status lock, so a waiter cannot check, miss the bump and then sleep.
            let _g = shared.status.lock().unwrap_or_else(|p| p.into_inner());
            shared.passes.fetch_add(1, Ordering::SeqCst);
            shared.changed.notify_all();
        }
        if full && loud {
            self.log(&format!(
                "usage: index done {total} messages ({} files read, {} ms)",
                res.files,
                t0.elapsed().as_millis()
            ));
        }
        let touched = res.messages_seen > 0 || !plan.flipped.is_empty() || !res.sessions.is_empty();
        if touched {
            let from = res.from_hour.as_deref().map(|h| h[..10].to_string());
            let to = res.to_hour.as_deref().map(|h| h[..10].to_string());
            self.queue_changed(reason, &res.sessions, from, to);
            if self.deadline_changed().is_some_and(|d| d <= Instant::now()) {
                self.emit_changed();
            }
        }
    }

    fn maybe_backup(&mut self, now_secs: i64) {
        let Some(conn) = &self.conn else { return };
        let last: i64 = get_meta(conn, "last_backup_at").and_then(|v| v.parse().ok()).unwrap_or(0);
        if now_secs - last < 86_400 {
            return;
        }
        match cache::backup(conn, &self.cfg.cache_db) {
            Ok(()) => set_meta(conn, "last_backup_at", &now_secs.to_string()),
            Err(e) => self.log(&format!("usage: backup failed: {e}")),
        }
    }
}

#[cfg(test)]
mod path_tests {
    use super::is_inside;
    use std::path::Path;

    #[test]
    fn a_missing_file_under_an_aliased_folder_is_still_inside() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("claude");
        std::fs::create_dir(&real).unwrap();
        assert!(is_inside(&real.join("not-yet").join("search.sqlite"), &real));
        // Windows 8.3 short name for the same folder (CI runners live under RUNNER~1).
        let short = Path::new(r"C:\PROGRA~1");
        if cfg!(windows) && short.exists() {
            assert!(is_inside(&short.join("nope").join("x.sqlite"), Path::new(r"C:\Program Files")));
        }
        #[cfg(unix)]
        {
            let link = dir.path().join("link");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert!(is_inside(&link.join("x.sqlite"), &real));
        }
    }
}