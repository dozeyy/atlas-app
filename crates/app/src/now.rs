//! The Now tab's door to the app: owns the running engine (it follows the same Claude
//! folder as the usage engine), pushes each change to the page as an event, and answers
//! the page's first look. The engine has its own thread; nothing here touches the UI thread.

use std::path::Path;
use std::sync::{Arc, Mutex};

use atlas_core::cache::pricing_file;
use atlas_core::now::finish::{Finished, NotifyTracker};
use atlas_core::now::{NowConfig, NowEngine, NowSink, NowSnapshot, TypicalAnswer, TYPICAL_DAYS};
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

/// Decides which stopped chats are announced. It always watches, so switching the setting on
/// later does not announce old news, but it hands back nothing while the setting is off.
#[derive(Default)]
struct FinishGate {
    tracker: Mutex<NotifyTracker>,
}

impl FinishGate {
    /// `enabled` is read only when something did stop.
    fn due(&self, snapshot: &NowSnapshot, enabled: impl FnOnce() -> bool) -> Vec<Finished> {
        let finished = self.tracker.lock().unwrap_or_else(|p| p.into_inner()).observe(snapshot);
        if finished.is_empty() || !enabled() {
            return Vec::new();
        }
        finished
    }
}

struct TauriNowSink {
    app: AppHandle,
    gate: FinishGate,
}

impl TauriNowSink {
    fn new(app: AppHandle) -> TauriNowSink {
        TauriNowSink { app, gate: FinishGate::default() }
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
        for f in &self.gate.due(snapshot, || self.app.state::<Arc<AppState>>().notify_on_finish()) {
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
                // The typical run of each kind of helper comes from the usage cache, asked for lazily
                // (the usage engine starts just after this one) and never per update.
                let handle = app.clone();
                let cfg = NowConfig::new(roots.projects_dir.clone(), prices).with_typical(Arc::new(move || {
                    // No usage engine yet (it starts just after this one) is "not ready", not a failure.
                    match handle.state::<Arc<AppState>>().usage.engine().map(|e| e.typical_runs(TYPICAL_DAYS)) {
                        Ok(Ok(Some(runs))) => TypicalAnswer::Ready(runs),
                        Ok(Err(_)) => TypicalAnswer::Failed,
                        Ok(Ok(None)) | Err(_) => TypicalAnswer::NotReady,
                    }
                }));
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

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_core::now::{Doing, NowChat};

    fn chat(state: &str) -> NowChat {
        NowChat {
            session_id: "a".into(),
            title: Some("Chat a".into()),
            project: "atlas".into(),
            model: None,
            state: state.into(),
            started_ms: None,
            worked_ms: Some(1_000),
            last_write_ms: 0,
            doing: Doing { kind: "wait".into(), verb: "x".into(), target: None },
            tokens: 0,
            cost_usd: None,
            unpriced: false,
            helpers: vec![],
            files: vec![],
            steps: vec![],
        }
    }

    fn snap(state: &str) -> NowSnapshot {
        NowSnapshot { chats: vec![chat(state)], watching: true, ..Default::default() }
    }

    #[test]
    fn nothing_is_announced_while_the_setting_is_off() {
        let gate = FinishGate::default();
        gate.due(&snap("working"), || false);
        assert!(gate.due(&snap("waiting"), || false).is_empty());
    }

    #[test]
    fn a_stop_is_announced_once_the_setting_is_on() {
        let gate = FinishGate::default();
        gate.due(&snap("working"), || true);
        let got = gate.due(&snap("waiting"), || true);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "Chat a");
        assert!(gate.due(&snap("waiting"), || true).is_empty(), "not again");
    }

    #[test]
    fn switching_it_on_later_does_not_announce_what_already_stopped() {
        let gate = FinishGate::default();
        gate.due(&snap("working"), || false);
        assert!(gate.due(&snap("waiting"), || false).is_empty(), "stopped while off: swallowed, not queued");
        assert!(gate.due(&snap("waiting"), || true).is_empty(), "turning it on does not replay it");
        gate.due(&snap("working"), || true);
        assert_eq!(gate.due(&snap("waiting"), || true).len(), 1, "the next stop is announced");
    }

    #[test]
    fn the_setting_is_only_read_when_something_stopped() {
        let gate = FinishGate::default();
        let mut reads = 0;
        gate.due(&snap("working"), || {
            reads += 1;
            true
        });
        assert_eq!(reads, 0);
    }
}
