//! The head start: while the setup window is open, read the Claude Code chats into the
//! same usage cache the installed Atlas will use, so Atlas opens already indexed.
//!
//! It is the app's own engine (`atlas-core`, the same version) pointed at the same
//! folders the app would pick, so what setup writes is exactly what Atlas expects. The
//! chats are only ever read. Setup is the only writer of the cache until `stop` returns;
//! Atlas is launched after that, never while this still has the file open.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(test)]
use std::time::Duration;

use atlas_core::paths::{self, ConfigInputs};
use atlas_core::settings::{self, Settings};
use atlas_core::usage::{Event, EventSink, State, UsageConfig, UsageEngine};
use serde::Serialize;

/// Everything the plan reads from the machine, passed in so tests can use scratch folders.
pub struct Env {
    pub home: PathBuf,
    pub cwd: PathBuf,
    pub claude_config: Option<OsString>,
    pub atlas_data: Option<OsString>,
}

impl Env {
    pub fn from_process() -> Env {
        let home = paths::home_dir().unwrap_or_else(std::env::temp_dir);
        let cwd = std::env::current_dir().unwrap_or_else(|_| home.clone());
        Env {
            home,
            cwd,
            claude_config: std::env::var_os("CLAUDE_CONFIG_DIR"),
            atlas_data: std::env::var_os("ATLAS_DATA_DIR"),
        }
    }
}

/// Where the chats are and where the cache goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub projects_dir: PathBuf,
    pub config_dir: PathBuf,
    /// The folder the app keeps its usage cache in (`ATLAS_DATA_DIR`, else the machine-local app data).
    pub local_dir: PathBuf,
    pub cache_db: PathBuf,
}

/// Why there is nothing to read ahead of time. Never an error: Atlas simply reads later.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    /// No Claude Code chats on this machine yet.
    NoChats,
    /// A previous Atlas install works on a private copy, so the real cache is not the one it uses.
    Sandbox,
    /// No folder to keep the cache in.
    NoFolder,
}

/// Work out the folders the installed app will pick. An existing Atlas settings file is
/// read (never written) so a custom Claude folder chosen there is honored.
pub fn plan(env: &Env) -> Result<Plan, Skip> {
    let atlas_env = env.atlas_data.as_deref();
    let data_dir = paths::data_dir(None, atlas_env, &env.home, &env.cwd).ok_or(Skip::NoFolder)?;
    let local_dir = paths::local_data_dir(None, atlas_env, &env.home, &env.cwd).ok_or(Skip::NoFolder)?;
    let saved: Option<Settings> = std::fs::read_to_string(settings::path_in(&data_dir))
        .ok()
        .and_then(|text| Settings::from_json(&text));
    if saved.as_ref().is_some_and(|s| s.sandbox) {
        return Err(Skip::Sandbox);
    }
    let override_path = saved.as_ref().and_then(|s| s.config_dir_override.as_deref()).map(Path::new);
    let root = paths::resolve_config_root(&ConfigInputs {
        flag: None,
        settings_override: override_path,
        env: env.claude_config.as_deref(),
        home: &env.home,
        cwd: &env.cwd,
    });
    if !root.projects_dir.is_dir() {
        return Err(Skip::NoChats);
    }
    let cache_db = atlas_core::cache::cache_file(&local_dir, &root.projects_dir, true);
    Ok(Plan { projects_dir: root.projects_dir, config_dir: root.dir, local_dir, cache_db })
}

/// What the window shows about the reading.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    /// False when there is nothing to read (no chats yet, or a private copy in use).
    pub available: bool,
    pub done: u64,
    pub total: u64,
    pub tokens: u64,
    pub finished: bool,
    /// The cache could not be written; Atlas will read the chats itself when it opens.
    pub failed: bool,
    /// An Atlas is running, so the reading has not started yet; it begins when Atlas closes.
    pub waiting: bool,
}

#[derive(Default)]
struct Counts {
    done: AtomicU64,
    total: AtomicU64,
    index_ms: Mutex<Option<String>>,
}

struct Sink {
    counts: Arc<Counts>,
}

impl EventSink for Sink {
    fn emit(&self, event: Event) {
        if let Event::Progress(p) = event {
            self.counts.done.store(p.files_done as u64, Ordering::Relaxed);
            self.counts.total.store(p.files_total as u64, Ordering::Relaxed);
        }
    }
    /// The engine's log lines can name folders; only the one timing line is kept.
    fn log(&self, line: &str) {
        if line.starts_with("usage: index done") {
            *self.counts.index_ms.lock().unwrap_or_else(|p| p.into_inner()) = Some(line.to_string());
        }
    }
}

pub struct Indexer {
    engine: Arc<UsageEngine>,
    counts: Arc<Counts>,
    local_dir: PathBuf,
    cache_db: PathBuf,
    /// True when this run made the folder (so cancel may remove it again, if it ends up empty).
    created_dir: bool,
    /// What was in the folder before this run wrote anything. The cache folder can be the very
    /// folder Atlas is installed in, so cancel removes only names that are not in this list.
    before: HashSet<OsString>,
}

/// File names in `dir`, empty when it does not exist.
fn names_in(dir: &Path) -> HashSet<OsString> {
    std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| e.file_name()).collect()).unwrap_or_default()
}

/// The only names a reading can create in the cache folder: the cache database and its side
/// files, the pricing table, and the data-folder marker. The folder can be the one Atlas is
/// installed in (an update), so nothing else is ever a candidate.
fn made_names(cache_name: &std::ffi::OsStr) -> Vec<OsString> {
    let base = cache_name.to_string_lossy().into_owned();
    let mut v: Vec<OsString> = ["", "-wal", "-shm", "-journal", ".bak"].iter().map(|s| OsString::from(format!("{base}{s}"))).collect();
    for fixed in ["pricing.json", "pricing.seed-hash", atlas_core::fsutil::DATA_MARKER] {
        v.push(OsString::from(fixed));
    }
    v
}

/// Take back what a cancelled run made in the cache folder: the cache files, by exact name, that
/// were not there before, one by one. Nothing else is deleted, whatever its name or age: not a
/// folder, not a program file, not anything that was already there.
/// The folder itself goes only when this run made it and nothing at all is left in it (a plain
/// `remove_dir`, which fails on anything else).
fn remove_made(dir: &Path, before: &HashSet<OsString>, created_dir: bool, cache_name: &std::ffi::OsStr) {
    for name in made_names(cache_name) {
        if before.contains(&name) {
            continue;
        }
        let p = dir.join(&name);
        if std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_file()) {
            let _ = std::fs::remove_file(&p);
        }
    }
    if created_dir {
        let _ = std::fs::remove_dir(dir);
    }
}

impl Indexer {
    /// Start reading in the background and return at once.
    pub fn start(plan: &Plan) -> Indexer {
        let created_dir = !plan.local_dir.exists();
        let before = names_in(&plan.local_dir);
        // The folder is about to hold Atlas's cache: mark it Atlas's while it is new or empty.
        atlas_core::fsutil::mark_data_dir(&plan.local_dir);
        let counts = Arc::new(Counts::default());
        let mut cfg = UsageConfig::new(
            plan.projects_dir.clone(),
            plan.config_dir.clone(),
            plan.local_dir.clone(),
            plan.cache_db.clone(),
        );
        // One pass, no watcher: the installed Atlas watches from then on.
        cfg.watch = false;
        cfg.week_starts_sunday = atlas_core::usage::time::week_starts_sunday();
        let engine = UsageEngine::start(cfg, Arc::new(Sink { counts: Arc::clone(&counts) }));
        Indexer { engine, counts, local_dir: plan.local_dir.clone(), cache_db: plan.cache_db.clone(), created_dir, before }
    }

    pub fn finished(&self) -> bool {
        let s = self.engine.status();
        self.engine.passes() > 0 && matches!(s.state, State::Idle | State::Error | State::ReadOnly)
    }

    pub fn reading(&self) -> Reading {
        let s = self.engine.status();
        let finished = self.finished();
        let failed = matches!(s.state, State::Error | State::ReadOnly);
        let done = self.counts.done.load(Ordering::Relaxed);
        let mut total = self.counts.total.load(Ordering::Relaxed);
        // A pass over a cache that is already warm reads few or no files; what the person cares
        // about is how many chats the cache now holds.
        if finished && !failed {
            total = total.max(s.files_tracked.saturating_sub(s.files_missing));
        }
        Reading {
            available: true,
            done: if finished && !failed { total.max(done) } else { done },
            total,
            tokens: self.engine.tokens_so_far(),
            finished,
            failed,
            waiting: false,
        }
    }

    /// Wait up to `limit` for the pass to end. True when it did (tests; the app polls instead).
    #[cfg(test)]
    pub fn wait_finished(&self, limit: Duration) -> bool {
        self.finished() || self.engine.wait_pass(0, limit)
    }

    /// The engine's one timing line ("usage: index done ...") once the pass ended.
    pub fn timing_line(&self) -> Option<String> {
        self.counts.index_ms.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Stop at the next batch, wait for the writer to finish, and close the cache so
    /// nothing is left open (no -wal or -shm file stays behind). After this returns the
    /// installed Atlas may open the same file.
    pub fn stop(self) {
        self.stop_logged(&|_| {});
    }

    /// `stop`, saying how long each step took (the hand-off is on the clock the person watches).
    pub fn stop_logged(self, say: &dyn Fn(&str)) {
        let t = std::time::Instant::now();
        self.engine.stop();
        say(&format!("reader: engine stopped after {} ms", t.elapsed().as_millis()));
        let db = self.cache_db.clone();
        drop(self); // closes the engine's read connections
        say(&format!("reader: connections dropped after {} ms", t.elapsed().as_millis()));
        atlas_core::cache::checkpoint_and_close(&db);
        say(&format!("reader: cache checkpointed after {} ms", t.elapsed().as_millis()));
    }

    /// Stop, and take back the cache files this run made (see `remove_made`). The folder is
    /// never deleted with anything in it.
    pub fn stop_and_clean(self) {
        let (dir, before, created) = (self.local_dir.clone(), self.before.clone(), self.created_dir);
        let cache_name = self.cache_db.file_name().map(OsString::from).unwrap_or_else(|| OsString::from("cache.sqlite"));
        self.stop();
        remove_made(&dir, &before, created, &cache_name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(msg: &str, input: u64, output: u64) -> String {
        format!(
            concat!(
                r#"{{"type":"assistant","uuid":"x-{m}","sessionId":"s1","timestamp":"2026-11-01T10:00:00.000Z","cwd":"/fixture","#,
                r#""isSidechain":false,"requestId":"req_{m}","message":{{"id":"msg_{m}","type":"message","role":"assistant","#,
                r#""model":"claude-sonnet-5-5","content":[],"usage":{{"input_tokens":{i},"output_tokens":{o},"#,
                r#""cache_creation_input_tokens":0,"cache_read_input_tokens":0,"#,
                r#""cache_creation":{{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}},"#,
                r#""service_tier":"standard","speed":"standard","inference_geo":"global"}}}}}}"#
            ),
            m = msg,
            i = input,
            o = output
        )
    }

    /// A Claude folder with two small chats, and a scratch Atlas data folder that does not exist yet.
    fn fixture() -> (tempfile::TempDir, Env, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let proj = root.path().join("claude").join("projects").join("demo");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join("a.jsonl"), format!("{}\n{}\n", line("1", 100, 20), line("2", 300, 40))).unwrap();
        std::fs::write(proj.join("b.jsonl"), format!("{}\n", line("3", 1000, 200))).unwrap();
        let data = root.path().join("atlas-data");
        let env = Env {
            home: root.path().join("home"),
            cwd: root.path().to_path_buf(),
            claude_config: Some(root.path().join("claude").into_os_string()),
            atlas_data: Some(data.clone().into_os_string()),
        };
        (root, env, data)
    }

    #[test]
    fn the_plan_follows_the_same_folders_the_app_picks() {
        let (root, env, data) = fixture();
        let p = plan(&env).unwrap();
        assert_eq!(p.projects_dir, root.path().join("claude").join("projects"));
        assert_eq!(p.local_dir, data);
        assert_eq!(p.cache_db, data.join("cache.sqlite"));
    }

    #[test]
    fn no_chats_is_a_skip_not_an_error() {
        let (root, mut env, _) = fixture();
        env.claude_config = Some(root.path().join("nowhere").into_os_string());
        assert_eq!(plan(&env), Err(Skip::NoChats));
    }

    #[test]
    fn a_saved_custom_claude_folder_and_sandbox_mode_are_honored() {
        let (root, env, data) = fixture();
        std::fs::create_dir_all(&data).unwrap();
        let other = root.path().join("other").join("projects");
        std::fs::create_dir_all(&other).unwrap();
        let file = settings::path_in(&data);
        let json = serde_json::json!({ "configDirOverride": root.path().join("other").to_string_lossy() });
        std::fs::write(&file, json.to_string()).unwrap();
        assert_eq!(plan(&env).unwrap().projects_dir, other);
        std::fs::write(&file, r#"{"sandbox":true}"#).unwrap();
        assert_eq!(plan(&env), Err(Skip::Sandbox));
    }

    #[test]
    fn reading_fills_the_cache_counts_tokens_and_closes_cleanly() {
        let (_root, env, data) = fixture();
        let p = plan(&env).unwrap();
        let ix = Indexer::start(&p);
        assert!(ix.wait_finished(Duration::from_secs(60)), "the pass should end");
        let r = ix.reading();
        assert!(r.available && r.finished && !r.failed);
        assert_eq!(r.total, 2, "two chat files");
        assert_eq!(r.done, 2);
        assert_eq!(r.tokens, 100 + 20 + 300 + 40 + 1000 + 200);
        ix.stop();
        assert!(data.join("cache.sqlite").is_file());
        assert!(!data.join("cache.sqlite-wal").exists(), "the cache is closed cleanly");
        assert!(!data.join("cache.sqlite-shm").exists());
    }

    #[test]
    fn a_warm_cache_still_reports_how_many_chats_it_holds() {
        let (_root, env, _data) = fixture();
        let p = plan(&env).unwrap();
        let first = Indexer::start(&p);
        assert!(first.wait_finished(Duration::from_secs(60)));
        first.stop();
        // Second run: nothing changed, so the pass reads no files, but the line must not say "no chats".
        let again = Indexer::start(&p);
        assert!(again.wait_finished(Duration::from_secs(60)));
        let r = again.reading();
        assert_eq!((r.total, r.done), (2, 2));
        assert_eq!(r.tokens, 100 + 20 + 300 + 40 + 1000 + 200);
        again.stop();
    }

    #[test]
    fn cancel_removes_a_folder_setup_made_but_not_one_that_was_there() {
        let (_root, env, data) = fixture();
        let p = plan(&env).unwrap();
        assert!(!data.exists());
        let ix = Indexer::start(&p);
        ix.wait_finished(Duration::from_secs(60));
        ix.stop_and_clean();
        assert!(!data.exists(), "setup made it, so setup takes it away");

        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("keep.txt"), "mine").unwrap();
        let ix = Indexer::start(&p);
        ix.wait_finished(Duration::from_secs(60));
        ix.stop_and_clean();
        assert!(data.join("keep.txt").is_file(), "a folder that was already there stays");
        assert!(!data.join("cache.sqlite").exists(), "but the cache setup wrote is taken back");
    }

    #[test]
    fn cancel_never_touches_atlas_programs_even_when_the_cache_folder_is_the_install_folder() {
        // On Windows %LOCALAPPDATA%\atlas (cache) and %LOCALAPPDATA%\Atlas (install) are one folder.
        let (_root, env, data) = fixture();
        let p = plan(&env).unwrap();
        let ix = Indexer::start(&p);
        ix.wait_finished(Duration::from_secs(60));
        // The installer (a stray one, or an earlier install) puts its files in the same folder.
        std::fs::write(data.join("atlas.exe"), "program").unwrap();
        std::fs::write(data.join("uninstall.exe"), "remover").unwrap();
        std::fs::create_dir_all(data.join("history")).unwrap();
        std::fs::write(data.join("history").join("kept.json"), "{}").unwrap();
        ix.stop_and_clean();
        assert_eq!(std::fs::read_to_string(data.join("atlas.exe")).unwrap(), "program");
        assert!(data.join("uninstall.exe").is_file());
        assert!(data.join("history").join("kept.json").is_file(), "folders are never removed");
        assert!(!data.join("cache.sqlite").exists());
        assert!(!data.join("cache.sqlite-wal").exists());
        assert!(!data.join("cache.sqlite-shm").exists());
    }

    /// Every table's name and row count, and the database's own integrity verdict.
    fn cache_shape(db: &Path) -> (Vec<(String, i64)>, String) {
        let conn = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let names: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .flatten()
            .collect();
        let counts = names
            .into_iter()
            .map(|n| {
                let c: i64 = conn.query_row(&format!("SELECT count(*) FROM \"{n}\""), [], |r| r.get(0)).unwrap();
                (n, c)
            })
            .collect();
        let verdict: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        (counts, verdict)
    }

    /// The hand-off stops Setup's reading wherever it is and Atlas carries on from the same cache.
    /// However early or late the stop comes, the second engine must end with exactly what an
    /// uninterrupted read holds (no chat counted twice, none lost) in an intact database.
    #[test]
    fn a_read_stopped_part_way_is_continued_without_double_counting() {
        let (root, env, _) = fixture();
        let proj = root.path().join("claude").join("projects").join("demo");
        for i in 0..300 {
            std::fs::write(proj.join(format!("c{i}.jsonl")), format!("{}\n", line(&format!("c{i}"), 10 + i, 2))).unwrap();
        }
        let expected_tokens: u64 = (100 + 20 + 300 + 40 + 1000 + 200) + (0..300u64).map(|i| 10 + i + 2).sum::<u64>();

        // Baseline: one uninterrupted read into its own data folder.
        let mut base_env = Env { atlas_data: Some(root.path().join("base-data").into_os_string()), ..Env::from_process() };
        base_env.claude_config = env.claude_config.clone();
        let bp = plan(&base_env).unwrap();
        let ix = Indexer::start(&bp);
        assert!(ix.wait_finished(Duration::from_secs(120)));
        assert_eq!(ix.reading().tokens, expected_tokens);
        ix.stop();
        let baseline = cache_shape(&bp.cache_db);
        assert_eq!(baseline.1, "ok");

        for (round, stop_after_ms) in [0u64, 3, 15, 60].into_iter().enumerate() {
            let mut e = Env { atlas_data: Some(root.path().join(format!("cut-{round}")).into_os_string()), ..Env::from_process() };
            e.claude_config = env.claude_config.clone();
            let p = plan(&e).unwrap();
            let first = Indexer::start(&p);
            std::thread::sleep(Duration::from_millis(stop_after_ms));
            first.stop();
            assert!(!p.local_dir.join("cache.sqlite-wal").exists(), "closed cleanly at the hand-off (stop after {stop_after_ms} ms)");
            // Atlas, later: the same engine over the same cache, to the end.
            let second = Indexer::start(&p);
            assert!(second.wait_finished(Duration::from_secs(120)));
            let r = second.reading();
            assert!(!r.failed, "stop after {stop_after_ms} ms");
            assert_eq!(r.tokens, expected_tokens, "no double count, none lost (stop after {stop_after_ms} ms)");
            second.stop();
            let shape = cache_shape(&p.cache_db);
            assert_eq!(shape.1, "ok", "database intact (stop after {stop_after_ms} ms)");
            assert_eq!(shape.0, baseline.0, "same rows as an uninterrupted read (stop after {stop_after_ms} ms)");
        }
    }

    #[test]
    fn remove_made_takes_only_new_files_and_an_empty_folder_it_made() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("d");
        std::fs::create_dir_all(&dir).unwrap();
        let name = std::ffi::OsStr::new("cache.sqlite");
        std::fs::write(dir.join("old.txt"), "old").unwrap();
        std::fs::write(dir.join("pricing.json"), "was here").unwrap();
        let before = names_in(&dir);
        for n in ["cache.sqlite", "cache.sqlite-wal", "cache.sqlite-shm", "cache.sqlite-journal"] {
            std::fs::write(dir.join(n), "n").unwrap();
        }
        // New files that are not cache files are never taken: an update's other files, a
        // program, a folder.
        for n in ["new-update-file.dll", "setup.log", "atlas.exe", "Uninstall Atlas.exe", "other.sqlite"] {
            std::fs::write(dir.join(n), "keep").unwrap();
        }
        std::fs::create_dir_all(dir.join("resources")).unwrap();
        remove_made(&dir, &before, false, name);
        assert!(dir.join("old.txt").is_file());
        assert!(dir.join("pricing.json").is_file(), "a cache file that was already there stays");
        for n in ["cache.sqlite", "cache.sqlite-wal", "cache.sqlite-shm", "cache.sqlite-journal"] {
            assert!(!dir.join(n).exists(), "{n}");
        }
        for n in ["new-update-file.dll", "setup.log", "atlas.exe", "Uninstall Atlas.exe", "other.sqlite"] {
            assert!(dir.join(n).is_file(), "{n} is not a cache file and stays");
        }
        assert!(dir.join("resources").is_dir());
        assert!(dir.is_dir(), "a folder that was there stays");

        // A folder this run made: removed only when nothing is left in it.
        let made = root.path().join("made");
        std::fs::create_dir_all(&made).unwrap();
        std::fs::write(made.join("cache.sqlite"), "n").unwrap();
        remove_made(&made, &HashSet::new(), true, name);
        assert!(!made.exists(), "empty after the cache files went, and setup made it");
        let busy = root.path().join("busy");
        std::fs::create_dir_all(&busy).unwrap();
        std::fs::write(busy.join("atlas.exe"), "p").unwrap();
        remove_made(&busy, &HashSet::new(), true, name);
        assert!(busy.join("atlas.exe").is_file(), "anything left in it keeps the folder");
    }
}
