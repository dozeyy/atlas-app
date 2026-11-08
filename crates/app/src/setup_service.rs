//! Setup (read only): the live scan the Setup page reads.
//!
//! One `LiveSetup` per (config root, sandbox, worktrees) combination. It is
//! started on a background thread right after the first paint, so the page
//! already has Will's setup the moment he opens it; a change on disk raises
//! `atlas://setup-changed` and the page pulls the new snapshot. The page can
//! only ask for a snapshot, one source text by id, or one revealed value.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use atlas_core::setup::source::SourceView;
use atlas_core::setup::watch::LiveSetup;
use atlas_core::setup::{Discovery, DiscoveryInputs};
use serde::{Serialize, Serializer};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;

pub const SETUP_EVENT: &str = "atlas://setup-changed";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Changed {
    version: u64,
}

struct Active {
    key: String,
    live: Arc<LiveSetup>,
}

#[derive(Default)]
pub struct SetupHub {
    active: Mutex<Option<Active>>,
    worktrees: AtomicBool,
}

fn key_of(i: &DiscoveryInputs) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        i.root.dir.display(),
        i.root.claude_json.display(),
        i.root.projects_dir.display(),
        i.sandboxed,
        i.include_worktrees
    )
}

impl SetupHub {
    /// The scan for the folder Atlas is working on right now (built on first use).
    fn ensure(&self, app: &AppHandle, state: &AppState) -> Result<Arc<LiveSetup>, String> {
        let inputs = state
            .setup_inputs(self.worktrees.load(Ordering::Relaxed))
            .ok_or_else(|| "Your Claude folder is not ready yet.".to_string())?;
        let key = key_of(&inputs);
        let mut g = self.active.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(a) = g.as_ref() {
            if a.key == key {
                return Ok(a.live.clone());
            }
        }
        let started = Instant::now();
        let handle = app.clone();
        let live = LiveSetup::start(inputs, move |v| {
            let _ = handle.emit(SETUP_EVENT, Changed { version: v });
        });
        let (_, d) = live.current();
        eprintln!(
            "[atlas] setup: discovery {} ms, {} items, {} projects",
            started.elapsed().as_millis(),
            d.snapshot.items.len(),
            d.snapshot.projects.len()
        );
        let live = Arc::new(live);
        *g = Some(Active { key, live: live.clone() });
        drop(g);
        // A new scan replaced the old one (first run, root change, worktrees toggle).
        let _ = app.emit(SETUP_EVENT, Changed { version: 1 });
        Ok(live)
    }

    fn current(&self, app: &AppHandle, state: &AppState) -> Result<Arc<Discovery>, String> {
        Ok(self.ensure(app, state)?.current().1)
    }
}

/// Start the first scan on a background thread (called once the page has painted).
pub fn prefetch(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new().name("atlas-setup-first".into()).spawn(move || {
        let state = app.state::<Arc<AppState>>().inner().clone();
        let hub = app.state::<Arc<SetupHub>>().inner().clone();
        let _ = hub.ensure(&app, &state);
    });
}

/// Serialises the snapshot of a shared scan without copying it.
pub struct SnapshotOut(Arc<Discovery>);

impl Serialize for SnapshotOut {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.snapshot.serialize(s)
    }
}

type Info<'a> = State<'a, Arc<AppState>>;
type Hub<'a> = State<'a, Arc<SetupHub>>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// The whole setup, without file bodies. `include_worktrees` switches the
/// agent-worktree folders on or off (the page's "Show worktrees" toggle).
#[tauri::command]
pub async fn setup_snapshot(app: AppHandle, state: Info<'_>, hub: Hub<'_>, include_worktrees: Option<bool>) -> Result<SnapshotOut, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    if let Some(w) = include_worktrees {
        hub.worktrees.store(w, Ordering::Relaxed);
    }
    blocking(move || hub.current(&app, &st).map(SnapshotOut)).await
}

/// The masked text of one item, by an id the last scan produced.
#[tauri::command]
pub async fn setup_read_source(app: AppHandle, state: Info<'_>, hub: Hub<'_>, id: String) -> Result<SourceView, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || hub.current(&app, &st)?.read_source(&id)).await
}

/// One masked value, for the click-to-reveal button. Never logged or cached.
#[tauri::command]
pub async fn setup_reveal(app: AppHandle, state: Info<'_>, hub: Hub<'_>, id: String, index: usize) -> Result<String, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || hub.current(&app, &st)?.reveal(&id, index)).await
}
