//! The chat-search indexer's door to the app: the host that owns the running engine (it
//! follows the same Claude folder as the usage engine), the status event, and the
//! commands. Nothing here runs on the UI thread: the engine has its own thread and
//! `search_chats` runs on the blocking pool.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use atlas_core::search::{db, SearchConfig, SearchEngine, SearchPage, SearchSink, SearchStatus};
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;
use crate::usage::{Roots, Signal};

pub const STATUS_EVENT: &str = "atlas://search/status";

/// If the usage engine never reports a finished first pass (it failed, say), the chat
/// index still starts this long after launch.
const FALLBACK_START: Duration = Duration::from_secs(45);

type Shared<'a> = State<'a, Arc<AppState>>;

struct Running {
    roots: Roots,
    engine: Arc<SearchEngine>,
}

#[derive(Default)]
pub struct SearchHost {
    current: Mutex<Option<Running>>,
}

struct TauriSearchSink {
    app: AppHandle,
}

impl SearchSink for TauriSearchSink {
    fn status(&self, s: SearchStatus) {
        let _ = self.app.emit(STATUS_EVENT, s);
    }
    fn log(&self, line: &str) {
        eprintln!("{line}");
    }
}

impl SearchHost {
    /// Start, keep or restart the index so it matches the folder Atlas reads. Called on
    /// the usage sync's background thread (stopping the old engine waits for it).
    pub fn sync(&self, wanted: Option<&Roots>, data_dir: &Path, app: &AppHandle) {
        let old = {
            let mut cur = self.current.lock().unwrap_or_else(|p| p.into_inner());
            if cur.as_ref().map(|r| &r.roots) == wanted {
                return;
            }
            let old = cur.take();
            if let Some(roots) = wanted {
                let file = db::search_file(data_dir, &roots.projects_dir, roots.real);
                let cfg = SearchConfig::new(roots.projects_dir.clone(), roots.config_dir.clone(), file);
                let engine = SearchEngine::start(cfg, Arc::new(TauriSearchSink { app: app.clone() }));
                let later = Arc::clone(&engine);
                std::thread::spawn(move || {
                    std::thread::sleep(FALLBACK_START);
                    later.poke();
                });
                *cur = Some(Running { roots: roots.clone(), engine });
            }
            old
        };
        if let Some(o) = old {
            o.engine.stop();
        }
    }

    pub fn engine(&self) -> Result<Arc<SearchEngine>, String> {
        self.current
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|r| Arc::clone(&r.engine))
            .ok_or_else(|| "Atlas has no Claude folder to search yet.".to_string())
    }

    /// Something may have changed on disk; the engine debounces and scans.
    pub fn poke(&self) {
        if let Ok(e) = self.engine() {
            e.poke();
        }
    }

    pub fn shutdown(&self) {
        let old = self.current.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(o) = old {
            o.engine.stop();
        }
    }
}

/// Poke the index when the usage side says the folder changed, but only once the usage
/// index has done its first full pass, so the two never fight over the disk at launch.
pub fn wire(state: &Arc<AppState>) {
    let st = Arc::clone(state);
    state.usage.signals.subscribe(move |sig| match sig {
        Signal::Idle => st.search.poke(),
        Signal::Changed | Signal::Focus => {
            if st.usage.first_index_done() {
                st.search.poke();
            }
        }
        Signal::Restarted => {}
    });
}

#[tauri::command]
pub async fn search_chats(
    state: Shared<'_>,
    query: String,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<SearchPage, String> {
    let engine = state.search.engine()?;
    tauri::async_runtime::spawn_blocking(move || engine.search(&query, limit.unwrap_or(20), offset.unwrap_or(0)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn search_status(state: Shared<'_>) -> Result<SearchStatus, String> {
    Ok(state.search.engine().map(|e| e.status()).unwrap_or_default())
}
