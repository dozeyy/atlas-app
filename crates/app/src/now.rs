//! The Now tab's door to the app: owns the running engine (it follows the same Claude
//! folder as the usage engine), pushes each change to the page as an event, and answers
//! the page's first look. The engine has its own thread; nothing here touches the UI thread.

use std::path::Path;
use std::sync::{Arc, Mutex};

use atlas_core::cache::pricing_file;
use atlas_core::now::{NowConfig, NowEngine, NowSink, NowSnapshot};
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;
use crate::usage::Roots;

pub const UPDATE_EVENT: &str = "atlas://now/update";

type Shared<'a> = State<'a, Arc<AppState>>;

struct Running {
    roots: Roots,
    engine: Arc<NowEngine>,
}

#[derive(Default)]
pub struct NowHost {
    current: Mutex<Option<Running>>,
}

struct TauriNowSink {
    app: AppHandle,
}

impl NowSink for TauriNowSink {
    fn update(&self, snapshot: &NowSnapshot) {
        let _ = self.app.emit(UPDATE_EVENT, snapshot);
    }
}

impl NowHost {
    /// Start, keep or restart the engine so it follows the folder Atlas reads. Called on
    /// the usage sync's background thread (stopping the old engine waits for it).
    pub fn sync(&self, wanted: Option<&Roots>, data_dir: &Path, app: &AppHandle) {
        let old = {
            let mut cur = self.current.lock().unwrap_or_else(|p| p.into_inner());
            if cur.as_ref().map(|r| &r.roots) == wanted {
                return;
            }
            let old = cur.take();
            if let Some(roots) = wanted {
                // Read-only: the live price file if there is one, else the built-in prices.
                let prices = pricing_file::load(data_dir, None).table;
                let cfg = NowConfig::new(roots.projects_dir.clone(), prices);
                let engine = Arc::new(NowEngine::start(cfg, Arc::new(TauriNowSink { app: app.clone() })));
                *cur = Some(Running { roots: roots.clone(), engine });
            }
            old
        };
        if let Some(o) = old {
            o.engine.stop();
        }
    }

    pub fn snapshot(&self) -> NowSnapshot {
        self.current
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|r| r.engine.snapshot())
            .unwrap_or_default()
    }

    pub fn shutdown(&self) {
        let old = self.current.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(o) = old {
            o.engine.stop();
        }
    }
}

#[tauri::command]
pub async fn now_snapshot(state: Shared<'_>) -> Result<NowSnapshot, String> {
    Ok(state.now.snapshot())
}
