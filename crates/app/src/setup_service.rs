//! Setup: the live scan the Setup page reads, and the commands that change it.
//!
//! One `LiveSetup` per (config root, sandbox, worktrees) combination. It is
//! started on a background thread right after the first paint, so the page
//! already has Will's setup the moment he opens it; a change on disk raises
//! `atlas://setup-changed` and the page pulls the new snapshot. The page can
//! only ask for a snapshot, one source text by id, or one revealed value.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use atlas_core::setup::cost::{self, CostReport};
use atlas_core::setup::source::SourceView;
use atlas_core::setup::watch::LiveSetup;
use atlas_core::setup::{Discovery, DiscoveryInputs};
use atlas_core::usage::costmix::CostMix;
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
        if let Some(a) = g.as_ref()
            && a.key == key {
                return Ok(a.live.clone());
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

    pub(crate) fn current(&self, app: &AppHandle, state: &AppState) -> Result<Arc<Discovery>, String> {
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

/// What each piece of the setup costs over the last week (read only). Without a usage cache
/// the report still has token sizes, just no dollars.
#[tauri::command]
pub async fn setup_cost(app: AppHandle, state: Info<'_>, hub: Hub<'_>) -> Result<CostReport, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || {
        let d = hub.current(&app, &st)?;
        let mix = st
            .usage
            .engine()
            .and_then(|e| e.cost_mix(cost::WINDOW_DAYS))
            .unwrap_or_else(|_| CostMix { days: cost::WINDOW_DAYS, ..Default::default() });
        let mcp = cost::sample_mcp(&mix.samples);
        Ok(cost::estimate(&d, &mix, &mcp))
    })
    .await
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

// ---------------------------------------------------------------------------
// Changes. Every command below acts on an id the last scan produced, backs up
// first, and returns once a fresh scan shows the change. In debug builds the
// write guard in `atlas_core::fsutil` refuses the real Claude folder.
// ---------------------------------------------------------------------------

use atlas_core::setup_write::{self as sw, CreateCtx, Draft, Problem, RawEdit, WriteError};

pub(crate) fn backups_dir(state: &AppState) -> std::path::PathBuf {
    state.data_dir.join("setup-backups")
}

/// One change at a time, also against the Atlas MCP server (a separate process that changes the
/// same files through the same write path). Held until the change is done.
pub(crate) fn write_lock(state: &AppState) -> Result<atlas_core::writelock::WriteGuard, String> {
    atlas_core::writelock::acquire(&state.data_dir, std::time::Duration::from_secs(15)).map_err(|e| e.to_string())
}

impl SetupHub {
    /// Rescan now so the next snapshot already shows what just changed.
    pub(crate) fn refresh(&self, app: &AppHandle, state: &AppState) {
        if let Ok(live) = self.ensure(app, state) {
            live.rescan_wait(std::time::Duration::from_secs(3));
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReply {
    /// saved | conflict
    status: &'static str,
    stamp: Option<String>,
    backup_id: Option<String>,
}

/// The editable text of one item. Text holding secrets is left out until `reveal`.
#[tauri::command]
pub async fn setup_item_raw(app: AppHandle, state: Info<'_>, hub: Hub<'_>, id: String, reveal: Option<bool>, file: Option<String>) -> Result<RawEdit, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || hub.current(&app, &st)?.read_raw_file(&id, file.as_deref(), reveal.unwrap_or(false)).map_err(|e| e.message())).await
}

/// What is wrong with `text` as the new content of this item (empty = fine).
#[tauri::command]
pub async fn setup_validate(app: AppHandle, state: Info<'_>, hub: Hub<'_>, id: String, text: String, file: Option<String>) -> Result<Vec<Problem>, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || hub.current(&app, &st)?.validate_text_file(&id, file.as_deref(), &text).map_err(|e| e.message())).await
}

/// The files inside a skill's folder (empty for anything else).
#[tauri::command]
pub async fn setup_skill_files(app: AppHandle, state: Info<'_>, hub: Hub<'_>, id: String) -> Result<Vec<sw::SkillFile>, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || hub.current(&app, &st)?.skill_files(&id).map_err(|e| e.message())).await
}

/// Show an item's file in the file manager (`open` false) or open it in the default editor
/// (`open` true). The page names an item id from the last scan, never a path; opening is
/// limited to plain-text kinds so a script is never run by the default handler.
#[tauri::command]
pub async fn setup_open_file(app: AppHandle, state: Info<'_>, hub: Hub<'_>, id: String, file: Option<String>, open: bool) -> Result<(), String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || {
        let path = hub.current(&app, &st)?.file_target(&id, file.as_deref()).map_err(|e| e.message())?;
        if open { open_text_file(&path) } else { show_in_folder(&path) }
    })
    .await
}

const OPEN_EXTS: &[&str] = &["md", "markdown", "txt", "json", "jsonc", "yml", "yaml", "toml", "csv", "ini", "cfg"];

/// Whether "open in default editor" may hand this file to the OS.
pub(crate) fn may_open_as_text(path: &std::path::Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| OPEN_EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

fn open_text_file(path: &std::path::Path) -> Result<(), String> {
    // Vetted again here, so no caller can hand the OS a relative, network or option-like path.
    let path = atlas_core::fsutil::vet_open_path(path)?;
    if !may_open_as_text(&path) {
        return Err("Atlas only opens plain text files. Use Show in folder for this one.".into());
    }
    use std::process::Command;
    #[cfg(windows)]
    let r = atlas_core::proc::quiet(Command::new("rundll32.exe").arg("url.dll,FileProtocolHandler").arg(&path)).spawn();
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg(&path).spawn();
    #[cfg(not(any(windows, target_os = "macos")))]
    let r = Command::new("xdg-open").arg(&path).spawn();
    r.map(|_| ()).map_err(|e| format!("Could not open the file: {e}"))
}

fn show_in_folder(path: &std::path::Path) -> Result<(), String> {
    let path = atlas_core::fsutil::vet_open_path(path)?;
    use std::process::Command;
    #[cfg(windows)]
    let r = atlas_core::proc::quiet(Command::new("explorer.exe").arg(format!("/select,{}", path.display()))).spawn();
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg("-R").arg(&path).spawn();
    #[cfg(not(any(windows, target_os = "macos")))]
    let r = Command::new("xdg-open").arg(path.parent().unwrap_or(&path)).spawn();
    r.map(|_| ()).map_err(|e| format!("Could not open the folder: {e}"))
}

/// Copy a skill under a new name into the user's own skills folder.
#[tauri::command]
pub async fn setup_duplicate(app: AppHandle, state: Info<'_>, hub: Hub<'_>, id: String, name: String) -> Result<sw::DuplicateOutcome, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || {
        let _lock = write_lock(&st)?;
        let i = st.setup_inputs(false).ok_or_else(|| "Your Claude folder is not ready yet.".to_string())?;
        let out = hub.current(&app, &st)?.duplicate_skill(&id, &name, &i.root.dir).map_err(|e| e.message())?;
        hub.refresh(&app, &st);
        Ok(out)
    })
    .await
}

/// Save: backup, atomic write, read back. `force` overwrites a file that changed on disk.
#[tauri::command]
// Each argument is one named field of the IPC call; bundling them would change the wire shape.
#[allow(clippy::too_many_arguments)]
pub async fn setup_save(app: AppHandle, state: Info<'_>, hub: Hub<'_>, id: String, text: String, stamp: String, force: Option<bool>, file: Option<String>) -> Result<SaveReply, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || {
        let _lock = write_lock(&st)?;
        let d = hub.current(&app, &st)?;
        let plan = d.save_plan_file(&id, file.as_deref()).map_err(|e| e.message())?;
        match sw::apply_save(&plan, &text, &stamp, force.unwrap_or(false), &backups_dir(&st)) {
            Ok(o) => {
                hub.refresh(&app, &st);
                Ok(SaveReply { status: "saved", stamp: Some(o.stamp), backup_id: o.backup_id })
            }
            Err(WriteError::Conflict) => Ok(SaveReply { status: "conflict", stamp: None, backup_id: None }),
            Err(e) => Err(e.message()),
        }
    })
    .await
}

/// How long Claude Code keeps sessions: one of 30 days, a year or "forever" (3650 days), written to
/// `cleanupPeriodDays` in the Claude Code settings file through the same backup-first write path as
/// every other change. Any other number, 0 included, is refused in `atlas_core::retention`.
#[tauri::command]
pub async fn retention_set(app: AppHandle, state: Info<'_>, hub: Hub<'_>, days: u32) -> Result<atlas_core::retention::Changed, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || {
        let _lock = write_lock(&st)?;
        let i = st.setup_inputs(false).ok_or_else(|| "Your Claude folder is not ready yet.".to_string())?;
        let out = atlas_core::retention::set_days(&i.root.dir, i.managed_dir.as_deref(), &backups_dir(&st), days).map_err(|e| e.message())?;
        if out.backup_id.is_some() {
            hub.refresh(&app, &st);
        }
        Ok(out)
    })
    .await
}

/// Delete one item after backing it up whole. Returns the backup id for Undo.
#[tauri::command]
pub async fn setup_delete(app: AppHandle, state: Info<'_>, hub: Hub<'_>, id: String) -> Result<sw::DeleteOutcome, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || {
        let _lock = write_lock(&st)?;
        let plan = hub.current(&app, &st)?.delete_plan(&id).map_err(|e| e.message())?;
        // A delete also goes to the computer's trash, so it is recoverable even if Atlas's backups are cleared.
        let out = sw::apply_delete_with(&plan, &backups_dir(&st), true).map_err(|e| e.message())?;
        hub.refresh(&app, &st);
        Ok(out)
    })
    .await
}

/// Put a change back exactly as it was: a delete is restored, a save or create (a rule Atlas added)
/// is reverted while the file is still what that change left.
#[tauri::command]
pub async fn setup_undo(app: AppHandle, state: Info<'_>, hub: Hub<'_>, backup_id: String) -> Result<sw::UndoOutcome, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || {
        let _lock = write_lock(&st)?;
        let d = hub.current(&app, &st)?;
        let i = st.setup_inputs(false).ok_or_else(|| "Your Claude folder is not ready yet.".to_string())?;
        let confine = sw::Confine::from_discovery(&i.root.dir, &i.root.claude_json, &d);
        let out = sw::restore_any(&backups_dir(&st), &backup_id, &confine).map_err(|e| e.message())?;
        hub.refresh(&app, &st);
        Ok(out)
    })
    .await
}

/// A starting text for something new (nothing is written yet).
#[tauri::command]
pub async fn setup_create_draft(state: Info<'_>, kind: String, name: String, event: Option<String>) -> Result<Draft, String> {
    let st = state.inner().clone();
    blocking(move || {
        let i = st.setup_inputs(false).ok_or_else(|| "Your Claude folder is not ready yet.".to_string())?;
        sw::create_draft(&kind, &name, event.as_deref(), &CreateCtx { root: &i.root.dir, claude_json: &i.root.claude_json }).map_err(|e| e.message())
    })
    .await
}

/// Write the new item (never over an existing one).
#[tauri::command]
pub async fn setup_create(app: AppHandle, state: Info<'_>, hub: Hub<'_>, kind: String, name: String, event: Option<String>, text: String) -> Result<sw::DeleteOutcome, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || {
        let _lock = write_lock(&st)?;
        let i = st.setup_inputs(false).ok_or_else(|| "Your Claude folder is not ready yet.".to_string())?;
        let out = sw::create_apply(&kind, &name, event.as_deref(), &text, &CreateCtx { root: &i.root.dir, claude_json: &i.root.claude_json }, &backups_dir(&st)).map_err(|e| e.message())?;
        hub.refresh(&app, &st);
        Ok(out)
    })
    .await
}

/// What is wrong with `text` as the content of a new item (nothing is written).
#[tauri::command]
pub async fn setup_validate_draft(state: Info<'_>, kind: String, name: String, event: Option<String>, text: String) -> Result<Vec<Problem>, String> {
    let st = state.inner().clone();
    blocking(move || {
        let i = st.setup_inputs(false).ok_or_else(|| "Your Claude folder is not ready yet.".to_string())?;
        sw::validate_draft(&kind, &name, event.as_deref(), &text, &CreateCtx { root: &i.root.dir, claude_json: &i.root.claude_json }).map_err(|e| e.message())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::may_open_as_text;
    use std::path::Path;

    #[test]
    fn only_plain_text_files_are_handed_to_the_default_editor() {
        for ok in ["a/SKILL.md", "x.JSON", "notes.txt", "c.yaml", "d.toml"] {
            assert!(may_open_as_text(Path::new(ok)), "{ok}");
        }
        for no in ["run.ps1", "x.bat", "y.cmd", "z.exe", "s.sh", "a.js", "b.py", "noext", "link.lnk", "page.html", "x.vbs"] {
            assert!(!may_open_as_text(Path::new(no)), "{no}");
        }
    }
}
