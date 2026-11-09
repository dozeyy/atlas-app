//! The Now tab's door to the app: owns the running engine (it follows the same Claude
//! folder as the usage engine), pushes each change to the page as an event, and answers
//! the page's first look. The engine has its own thread; nothing here touches the UI thread.

use std::path::Path;
use std::sync::{Arc, Mutex};

use atlas_core::cache::pricing_file;
use atlas_core::now::finish::{Finished, NotifyTracker};
use atlas_core::now::{NowConfig, NowEngine, NowSink, NowSnapshot};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

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

/// A chat Atlas watched working has stopped (finished, or asked a question). Only sent while
/// "Tell me when a chat finishes" is on in Settings.
pub const FINISHED_EVENT: &str = "atlas://now/finished";

struct TauriNowSink {
    app: AppHandle,
    tracker: Mutex<NotifyTracker>,
}

impl TauriNowSink {
    fn new(app: AppHandle) -> TauriNowSink {
        TauriNowSink { app, tracker: Mutex::new(NotifyTracker::new()) }
    }

    /// The window is in front of the user: its own toast is enough.
    fn window_in_front(&self) -> bool {
        self.app
            .get_webview_window("main")
            .is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && w.is_focused().unwrap_or(false))
    }

    fn announce(&self, f: &Finished) {
        let _ = self.app.emit(FINISHED_EVENT, f);
        if self.window_in_front() {
            return;
        }
        let body = if f.kind == "ask" { format!("{} has a question for you", f.name) } else { format!("{} finished", f.name) };
        if let Err(e) = self.app.notification().builder().title("Atlas").body(body).show() {
            eprintln!("[atlas] notification: {e}");
        }
    }
}

impl NowSink for TauriNowSink {
    fn update(&self, snapshot: &NowSnapshot) {
        let _ = self.app.emit(UPDATE_EVENT, snapshot);
        // Always watch, so switching the setting on later does not announce old news.
        let finished = self.tracker.lock().unwrap_or_else(|p| p.into_inner()).observe(snapshot);
        if finished.is_empty() || !self.app.state::<Arc<AppState>>().notify_on_finish() {
            return;
        }
        for f in &finished {
            self.announce(f);
        }
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
                let engine = Arc::new(NowEngine::start(cfg, Arc::new(TauriNowSink::new(app.clone()))));
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
