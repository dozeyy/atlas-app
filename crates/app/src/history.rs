//! History's door to the page: a worker that keeps the record up to date, and the read-only
//! commands the History page and Settings use.
//!
//! The worker starts after the first paint, waits for the first usage index to settle (so two
//! disk-heavy jobs do not run at once), takes the baseline, and from then on rescans a couple
//! of seconds after Setup reports a change. It pauses while Sandbox Mode is on: a sandbox
//! copy is not the user's real setup. Every write lands under Atlas's own local data folder.

use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use atlas_core::history::diff::{Diff, CONTEXT};
use atlas_core::history::query::{self, Against, EventFilter, EventsPage, ItemDetail, Overview};
use atlas_core::history::store::Store;
use atlas_core::history::{self, import, scan, tracked_from};
use atlas_core::paths::ConfigRoot;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Listener, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::setup_service::{SetupHub, SETUP_EVENT};
use crate::state::AppState;
use crate::usage::Signal;

pub const CHANGED_EVENT: &str = "atlas://history/changed";

type Shared<'a> = State<'a, Arc<AppState>>;

#[derive(Clone, Copy)]
enum Msg {
    /// Setup saw something change.
    Poke,
    /// The usage engine settled.
    UsageIdle,
}

struct Open {
    root: PathBuf,
    store: Arc<Store>,
    config: ConfigRoot,
}

#[derive(Default)]
pub struct HistoryHost {
    tx: Mutex<Option<Sender<Msg>>>,
    open: Mutex<Option<Open>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Changed {
    events: usize,
}

impl HistoryHost {
    /// The store for the folder Atlas works on, opened on first use. `None` while Sandbox Mode
    /// is on (history follows the real setup only) or the folder is not ready.
    fn store(&self, state: &AppState) -> Option<(Arc<Store>, ConfigRoot)> {
        let cfg = state.history_root()?;
        let mut g = self.open.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(o) = g.as_ref()
            && o.root == cfg.dir
        {
            return Some((o.store.clone(), o.config.clone()));
        }
        let dir = history::store_dir(&state.local_data_dir, &cfg.dir);
        let store = match Store::open(&dir) {
            Ok(s) => Arc::new(s),
            Err(e) => {
                eprintln!("[atlas] history: {e}");
                return None;
            }
        };
        *g = Some(Open { root: cfg.dir.clone(), store: store.clone(), config: cfg.clone() });
        Some((store, cfg))
    }

    /// Start the worker (once). Called after the first paint.
    pub fn start(self: &Arc<Self>, app: &AppHandle) {
        let mut g = self.tx.lock().unwrap_or_else(|p| p.into_inner());
        if g.is_some() {
            return;
        }
        let (tx, rx) = channel::<Msg>();
        *g = Some(tx.clone());
        drop(g);
        let idle_tx = tx.clone();
        let state = app.state::<Arc<AppState>>().inner().clone();
        state.usage.signals.subscribe(move |s| {
            if s == Signal::Idle {
                let _ = idle_tx.send(Msg::UsageIdle);
            }
        });
        let poke_tx = tx;
        app.listen(SETUP_EVENT, move |_| {
            let _ = poke_tx.send(Msg::Poke);
        });
        let (host, app) = (Arc::clone(self), app.clone());
        let _ = std::thread::Builder::new().name("atlas-history".into()).spawn(move || host.run(&app, rx));
    }

    fn run(&self, app: &AppHandle, rx: std::sync::mpsc::Receiver<Msg>) {
        let state = app.state::<Arc<AppState>>().inner().clone();
        let hub = app.state::<Arc<SetupHub>>().inner().clone();
        // Let the first usage index finish before reading every transcript a second time.
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Msg::UsageIdle) | Err(RecvTimeoutError::Timeout) => break,
                Ok(Msg::Poke) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        let mut last_import: Option<Instant> = None;
        loop {
            self.pass(app, &state, &hub, &mut last_import);
            // Sleep until something happens, then wait for it to go quiet.
            match rx.recv() {
                Ok(_) => {}
                Err(_) => return,
            }
            loop {
                match rx.recv_timeout(Duration::from_secs(2)) {
                    Ok(_) => {}
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        }
    }

    fn pass(&self, app: &AppHandle, state: &Arc<AppState>, hub: &Arc<SetupHub>, last_import: &mut Option<Instant>) {
        let Some((store, cfg)) = self.store(state) else { return };
        let Ok(disc) = hub.current(app, state) else { return };
        let started = Instant::now();
        let tracked = tracked_from(&disc.snapshot);
        let now = now_ms();
        let cj = cfg.claude_json.is_file().then_some(cfg.claude_json.as_path());
        let report = match scan::scan(&store, &tracked, cj, now) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[atlas] history: {e}");
                return;
            }
        };
        let mut imported = (0, 0);
        if last_import.is_none_or(|t| t.elapsed() > Duration::from_secs(60)) {
            imported.0 = import::import_backups(&store, &cfg.dir, &cfg.claude_json, now).unwrap_or(0);
            imported.1 = import::import_file_history(&store, &cfg.dir, &cfg.projects_dir, &tracked, now).unwrap_or(0);
            *last_import = Some(Instant::now());
        }
        let keep = state.history_keep() as usize;
        let pruned = scan::prune(&store, keep).unwrap_or((0, 0));
        if report.baseline {
            eprintln!("[atlas] history: baseline {} items, {} bytes stored, {} ms", report.items, store.disk_bytes(), started.elapsed().as_millis());
        }
        if imported.0 + imported.1 > 0 {
            eprintln!("[atlas] history: imported {} claude_backup, {} claude_edit", imported.0, imported.1);
        }
        if pruned.0 > 0 {
            eprintln!("[atlas] history: pruned {} old versions, {} bytes", pruned.0, pruned.1);
        }
        let changed = report.added + report.changed + report.removed + report.renamed + imported.0 + imported.1;
        if changed > 0 || report.baseline {
            let _ = app.emit(CHANGED_EVENT, Changed { events: changed });
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn open_store(st: &AppState, host: &HistoryHost) -> Result<(Arc<Store>, ConfigRoot), String> {
    host.store(st).ok_or_else(|| "History is paused while Sandbox Mode is on.".to_string())
}

#[tauri::command]
pub async fn history_overview(state: Shared<'_>, offset_min: Option<i32>) -> Result<Option<Overview>, String> {
    let st = state.inner().clone();
    blocking(move || {
        let Some((store, _)) = st.history.store(&st) else { return Ok(None) };
        let now = now_ms();
        query::overview(&store, now, offset_min.unwrap_or(0), st.history_keep()).map(Some)
    })
    .await
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EventsArgs {
    #[serde(default)]
    groups: Vec<String>,
    project: Option<String>,
    text: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
}

#[tauri::command]
pub async fn history_events(state: Shared<'_>, args: EventsArgs) -> Result<EventsPage, String> {
    let st = state.inner().clone();
    blocking(move || {
        let (store, _) = open_store(&st, &st.history)?;
        query::events(&store, &EventFilter { groups: args.groups, project: args.project, text: args.text, cursor: args.cursor, limit: args.limit.unwrap_or(40) })
    })
    .await
}

#[tauri::command]
pub async fn history_item(state: Shared<'_>, key: String) -> Result<Option<ItemDetail>, String> {
    let st = state.inner().clone();
    blocking(move || {
        let (store, _) = open_store(&st, &st.history)?;
        query::item(&store, &key)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffArgs {
    version_id: i64,
    against_version_id: Option<i64>,
    against_current: Option<bool>,
    context: Option<usize>,
}

#[tauri::command]
pub async fn history_diff(state: Shared<'_>, args: DiffArgs) -> Result<Diff, String> {
    let st = state.inner().clone();
    blocking(move || {
        let (store, _) = open_store(&st, &st.history)?;
        let against = match (args.against_version_id, args.against_current.unwrap_or(false)) {
            (Some(v), _) => Against::Version(v),
            (None, true) => Against::Current,
            _ => Against::Previous,
        };
        query::compare(&store, args.version_id, against, args.context.unwrap_or(CONTEXT).min(5000))
    })
    .await
}

/// The text of one copy, secrets masked, for the clipboard.
#[tauri::command]
pub async fn history_copy_version(state: Shared<'_>, version_id: i64) -> Result<String, String> {
    let st = state.inner().clone();
    blocking(move || {
        let (store, _) = open_store(&st, &st.history)?;
        query::copy_text(&store, version_id)
    })
    .await
}

/// Ask where to put a copy and write it there. Never into a Claude folder. Returns the path, or
/// nothing when the picker was cancelled.
#[tauri::command]
pub async fn history_save_copy(app: AppHandle, state: Shared<'_>, version_id: i64) -> Result<Option<String>, String> {
    let st = state.inner().clone();
    let (text, name, cfg) = {
        let st2 = st.clone();
        blocking(move || {
            let (store, cfg) = open_store(&st2, &st2.history)?;
            Ok((query::copy_text(&store, version_id)?, query::suggested_name(&store, version_id)?, cfg))
        })
        .await?
    };
    let Some(picked) = app.dialog().file().set_title("Save a copy").set_file_name(&name).blocking_save_file() else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    history::save_copy_guard(&path, &cfg.dir)?;
    if let Some(parent) = path.parent() {
        history::save_copy_guard(parent, &cfg.dir)?;
    }
    blocking(move || {
        atlas_core::fsutil::atomic_write(&path, text.as_bytes()).map_err(|e| format!("The copy could not be saved: {e}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}

/// Show Atlas's history folder in the file manager.
#[tauri::command(async)]
pub fn history_open_folder(state: Shared) -> Result<(), String> {
    let (store, _) = open_store(&state, &state.history)?;
    crate::commands::open_in_file_manager(store.dir())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsOverview {
    /// Claude Code's own settings file, shown as a path only.
    pub claude_settings_file: Option<String>,
    /// How many days Claude Code keeps its chat logs before clearing them (its own setting).
    pub cleanup_days: Option<u32>,
    pub history_bytes: u64,
    pub history_versions: u32,
    pub history_items: u32,
    pub keep_versions: u32,
    pub cache_bytes: u64,
    pub history_paused: bool,
}

/// Facts the Settings page shows that are not settings: sizes, and what Claude Code itself is set to.
#[tauri::command]
pub async fn settings_overview(state: Shared<'_>) -> Result<SettingsOverview, String> {
    let st = state.inner().clone();
    blocking(move || {
        let info = st.info();
        let dir = info.config.as_ref().map(|c| PathBuf::from(&c.dir));
        let settings_path = dir.as_ref().map(|d| d.join("settings.json")).filter(|p| p.is_file());
        let cleanup_days = settings_path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| v.get("cleanupPeriodDays").and_then(|d| d.as_u64()))
            .map(|d| d.min(u32::MAX as u64) as u32);
        let (history_bytes, history_versions, history_items, paused) = match st.history.store(&st) {
            Some((store, _)) => {
                let o = query::overview(&store, now_ms(), 0, st.history_keep());
                let (v, i) = o.map(|o| (o.versions, o.items)).unwrap_or((0, 0));
                (store.disk_bytes(), v, i, false)
            }
            None => (0, 0, 0, st.history_root().is_none()),
        };
        let cache_bytes = st
            .usage_roots()
            .map(|r| {
                let db = atlas_core::cache::cache_file(&st.local_data_dir, &r.projects_dir, r.real);
                let mut n = 0u64;
                for ext in ["", "-wal", "-shm"] {
                    let mut p = db.clone().into_os_string();
                    p.push(ext);
                    n += std::fs::metadata(PathBuf::from(p)).map(|m| m.len()).unwrap_or(0);
                }
                n
            })
            .unwrap_or(0);
        Ok(SettingsOverview {
            claude_settings_file: settings_path.map(|p| p.to_string_lossy().into_owned()),
            cleanup_days,
            history_bytes,
            history_versions,
            history_items,
            keep_versions: st.history_keep(),
            cache_bytes,
            history_paused: paused,
        })
    })
    .await
}
