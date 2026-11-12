//! App state: Atlas's settings, the resolved Claude config root and the
//! Sandbox Mode slot. Everything the front end sees goes through `AppInfo`.
//!
//! Threading rules (the UI thread must never wait on the disk):
//! - the `inner` mutex guards memory only; no file is read, written or deleted
//!   while it is held;
//! - settings are written after the guard is dropped, one writer at a time, and
//!   always from the latest in-memory copy;
//! - a sandbox copy is made on its own thread, and an old sandbox is deleted on
//!   its own thread (it can be 256 MB), so switching Sandbox Mode never blocks.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use atlas_core::launch::LaunchArgs;
use atlas_core::paths::{self, ConfigInputs, ConfigRoot, ConfigSource};
use atlas_core::sandbox::{self, Sandbox, SandboxError, SandboxOptions, SandboxReport};
use atlas_core::settings::{self, Settings, Theme, View};
use serde::Serialize;

use crate::now::NowHost;
use crate::search::SearchHost;
use crate::usage::{Roots, UsageHost};

pub const INFO_EVENT: &str = "atlas://info";
/// A quit was held back because an editor has unsaved edits; the page asks the user.
pub const QUIT_ASK_EVENT: &str = "atlas://quit-ask";

#[derive(Debug, PartialEq, Eq)]
pub enum Leave {
    Go,
    Ask,
}

/// How often the running app tells other Atlas instances its sandbox is in use.
const HEARTBEAT: Duration = Duration::from_secs(10 * 60);
/// How long exit waits for a copy to stop or a delete to finish.
const EXIT_WAIT: Duration = Duration::from_secs(5);

/// Called with a fresh snapshot whenever state changes outside a command
/// (a sandbox copy finishing). The app wires this to the Tauri event.
pub type Notify = Arc<dyn Fn(AppInfo) + Send + Sync>;

enum Slot {
    Off,
    Preparing,
    Ready(Box<Sandbox>),
    Failed(String),
}

/// The sandbox copy in progress: a flag to stop it and the thread making it.
struct Build {
    cancel: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

struct Inner {
    settings: Settings,
    /// Sandbox Mode wanted (setting or `--sandbox` flag).
    sandbox_wanted: bool,
    slot: Slot,
    /// Bumped on every change so a slow copy that finished late is thrown away.
    generation: u64,
    build: Option<Build>,
    first_paint_ms: Option<u64>,
    /// Why the last settings write failed; cleared by the next one that works.
    save_error: Option<String>,
}

pub struct AppState {
    pub started: Instant,
    pub launch: LaunchArgs,
    pub data_dir: PathBuf,
    /// Where the usage cache lives: machine-local app data, or `--data-dir` (Q7).
    pub local_data_dir: PathBuf,
    pub usage: Arc<UsageHost>,
    /// The chat-search index; follows the same folder as `usage`.
    pub search: Arc<SearchHost>,
    /// The record of how the setup changed (History).
    pub history: Arc<crate::history::HistoryHost>,
    /// The Now tab's live view of running chats; follows the same folder as usage.
    pub now: Arc<NowHost>,
    home: PathBuf,
    cwd: PathBuf,
    env_config: Option<OsString>,
    sandbox_parent: PathBuf,
    settings_note: Option<String>,
    inner: Mutex<Inner>,
    /// Orders settings writes without holding `inner` during the disk write.
    save_lock: Mutex<()>,
    /// Sequence number stamped on every snapshot, so the page can drop a stale one.
    seq: AtomicU64,
    notify: Mutex<Option<Notify>>,
    /// Deletes of old sandboxes still running; exit waits for them.
    discards: Mutex<Vec<JoinHandle<()>>>,
    /// An editor in the page holds edits that are not saved: a quit asks first.
    unsaved: AtomicBool,
    /// The launch-time connection to Claude Code has been started (a page reload must not start another).
    auto_connect_started: AtomicBool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub dir: String,
    pub claude_json: String,
    pub projects_dir: String,
    pub source: ConfigSource,
    pub dir_exists: bool,
    pub claude_json_exists: bool,
    pub projects_exists: bool,
    pub projects_read_only: bool,
}

impl ConfigView {
    fn of(root: &ConfigRoot) -> Self {
        ConfigView {
            dir: root.dir.to_string_lossy().into_owned(),
            claude_json: root.claude_json.to_string_lossy().into_owned(),
            projects_dir: root.projects_dir.to_string_lossy().into_owned(),
            source: root.source,
            dir_exists: root.dir.is_dir(),
            claude_json_exists: root.claude_json.is_file(),
            projects_exists: root.projects_dir.is_dir(),
            projects_read_only: root.projects_read_only,
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SandboxView {
    pub enabled: bool,
    /// off | preparing | ready | failed
    pub state: &'static str,
    pub error: Option<String>,
    pub path: Option<String>,
    pub report: Option<SandboxReport>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// Rises with every snapshot; the page ignores one older than what it has.
    pub seq: u64,
    pub version: &'static str,
    /// "debug" or "release": shown in About.
    pub build: &'static str,
    pub platform: &'static str,
    /// Mica / vibrancy is active, so the page background must stay transparent.
    pub backdrop: bool,
    pub data_dir: String,
    /// The folder Atlas works on. None while a sandbox is still being prepared
    /// or failed: Atlas never falls back to the real config silently.
    pub config: Option<ConfigView>,
    /// The folder the sandbox is (or would be) copied from.
    pub real_config: ConfigView,
    pub sandbox: SandboxView,
    /// `--config-dir` was given: the Settings choice cannot override it.
    pub config_locked_by_flag: bool,
    pub settings: Settings,
    pub settings_note: Option<String>,
    /// The last write of Atlas's settings failed: what changed will not survive a restart.
    pub settings_save_error: Option<String>,
    pub first_paint_ms: Option<u64>,
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub theme: Option<Theme>,
    pub last_view: Option<View>,
    pub launch_animation: Option<bool>,
    pub close_to_tray: Option<bool>,
    pub notify_on_finish: Option<bool>,
    pub show_shortcuts: Option<bool>,
    pub mcp_auto_connect: Option<bool>,
    pub history_keep_versions: Option<u32>,
    pub count_cache_in_totals: Option<bool>,
    pub text_size: Option<settings::TextSize>,
    /// Webview zoom in percent; snapped to the nearest step.
    pub zoom_percent: Option<u32>,
}

impl AppState {
    pub fn new(launch: LaunchArgs) -> Arc<AppState> {
        let home = paths::home_dir().unwrap_or_else(std::env::temp_dir);
        let cwd = std::env::current_dir().unwrap_or_else(|_| home.clone());
        let env_config = std::env::var_os("CLAUDE_CONFIG_DIR");
        let atlas_env = std::env::var_os("ATLAS_DATA_DIR");
        let data_dir =
            paths::data_dir(launch.data_dir.as_deref(), atlas_env.as_deref(), &home, &cwd)
                .unwrap_or_else(|| std::env::temp_dir().join("atlas"));
        let local_data_dir =
            paths::local_data_dir(launch.data_dir.as_deref(), atlas_env.as_deref(), &home, &cwd)
                .unwrap_or_else(|| data_dir.clone());
        Self::with_parts(launch, home, cwd, env_config, data_dir, local_data_dir, std::env::temp_dir())
    }

    /// Everything `new` reads from the machine, passed in (tests use scratch folders).
    fn with_parts(
        launch: LaunchArgs,
        home: PathBuf,
        cwd: PathBuf,
        env_config: Option<OsString>,
        data_dir: PathBuf,
        local_data_dir: PathBuf,
        sandbox_parent: PathBuf,
    ) -> Arc<AppState> {
        let started = Instant::now();
        // Say these folders are Atlas's (a one-line marker file) before anything is written to
        // them, so the uninstaller's "remove saved data" knows which folders it may touch.
        atlas_core::fsutil::mark_data_dirs(&data_dir, &local_data_dir);
        let loaded = settings::load(&data_dir);
        let settings_note = loaded.recovered_from.as_ref().map(|p| {
            format!("Atlas's settings file was damaged and was set aside as {}.", p.display())
        });
        let sandbox_wanted = launch.sandbox || loaded.settings.sandbox;

        Arc::new(AppState {
            started,
            launch,
            data_dir,
            local_data_dir,
            usage: Arc::new(UsageHost::default()),
            search: Arc::new(SearchHost::default()),
            history: Arc::new(crate::history::HistoryHost::default()),
            now: Arc::new(NowHost::default()),
            home,
            cwd,
            env_config,
            sandbox_parent,
            settings_note,
            inner: Mutex::new(Inner {
                settings: loaded.settings,
                sandbox_wanted,
                slot: if sandbox_wanted { Slot::Preparing } else { Slot::Off },
                generation: 0,
                build: None,
                first_paint_ms: None,
                save_error: None,
            }),
            save_lock: Mutex::new(()),
            seq: AtomicU64::new(0),
            notify: Mutex::new(None),
            discards: Mutex::new(Vec::new()),
            unsaved: AtomicBool::new(false),
            auto_connect_started: AtomicBool::new(false),
        })
    }

    /// True the first time it is asked, false after: the launch-time Claude Code connection runs once.
    pub fn claim_auto_connect(&self) -> bool {
        !self.auto_connect_started.swap(true, Ordering::SeqCst)
    }

    /// The page reports whether an editor holds edits that are not saved.
    pub fn set_unsaved(&self, on: bool) {
        self.unsaved.store(on, Ordering::SeqCst);
    }

    pub fn has_unsaved(&self) -> bool {
        self.unsaved.load(Ordering::SeqCst)
    }

    /// A window close or quit that would end the program, and what to do about it. With unsaved
    /// edits it is held back and the page asks; otherwise it goes ahead.
    pub fn leave_decision(&self, would_exit: bool) -> Leave {
        if would_exit && self.has_unsaved() { Leave::Ask } else { Leave::Go }
    }

    /// Where background changes are announced (see `Notify`).
    pub fn set_notifier(&self, notify: Notify) {
        *self.notify.lock().unwrap_or_else(|p| p.into_inner()) = Some(notify);
    }

    /// Send the current snapshot to the page, if a notifier is set.
    pub fn announce(&self) {
        let notify = self.notify.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(n) = notify {
            n(self.info());
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn real_root(&self, inner: &Inner) -> ConfigRoot {
        let override_path = inner.settings.config_dir_override.as_deref().map(Path::new);
        paths::resolve_config_root(&ConfigInputs {
            flag: self.launch.config_dir.as_deref(),
            settings_override: override_path,
            env: self.env_config.as_deref(),
            home: &self.home,
            cwd: &self.cwd,
        })
    }

    /// The folder the usage engine reads, or None while there is none to read (a
    /// sandbox still copying or failed: never a silent fall back to the real folder).
    pub fn usage_roots(&self) -> Option<Roots> {
        let inner = self.lock();
        let real = self.real_root(&inner);
        let root = match &inner.slot {
            Slot::Off => real.clone(),
            Slot::Ready(sb) => sb.root.clone(),
            Slot::Preparing | Slot::Failed(_) => return None,
        };
        Some(Roots {
            real: real.source != ConfigSource::Flag && root.projects_dir == real.projects_dir,
            projects_dir: root.projects_dir,
            config_dir: root.dir,
        })
    }

    /// The Claude folder History records: the user's real one, never a sandbox copy (so
    /// `None` while Sandbox Mode is on or still copying).
    pub fn history_root(&self) -> Option<ConfigRoot> {
        let inner = self.lock();
        matches!(inner.slot, Slot::Off).then(|| self.real_root(&inner))
    }

    pub fn history_keep(&self) -> u32 {
        self.lock().settings.history_keep_versions
    }

    /// What Setup scans: the folder Atlas works on (the real one, or the sandbox
    /// copy once it is ready). None while a sandbox is still being prepared.
    pub fn setup_inputs(&self, include_worktrees: bool) -> Option<atlas_core::setup::DiscoveryInputs> {
        let inner = self.lock();
        let (root, sandboxed) = match &inner.slot {
            Slot::Off => (self.real_root(&inner), false),
            Slot::Ready(sb) => (sb.root.clone(), true),
            _ => return None,
        };
        Some(atlas_core::setup::DiscoveryInputs {
            root,
            home: self.home.clone(),
            managed_dir: atlas_core::setup::default_managed_dir(),
            include_worktrees,
            sandboxed,
        })
    }

    pub fn info(&self) -> AppInfo {
        let inner = self.lock();
        self.info_locked(&inner)
    }

    fn info_locked(&self, inner: &Inner) -> AppInfo {
        let real = self.real_root(inner);
        let (config, sandbox) = match &inner.slot {
            Slot::Off => (
                Some(ConfigView::of(&real)),
                SandboxView { enabled: false, state: "off", error: None, path: None, report: None },
            ),
            Slot::Preparing => (
                None,
                SandboxView { enabled: true, state: "preparing", error: None, path: None, report: None },
            ),
            Slot::Failed(e) => (
                None,
                SandboxView {
                    enabled: true,
                    state: "failed",
                    error: Some(e.clone()),
                    path: None,
                    report: None,
                },
            ),
            Slot::Ready(sb) => (
                Some(ConfigView::of(&sb.root)),
                SandboxView {
                    enabled: true,
                    state: "ready",
                    error: None,
                    path: Some(sb.root.dir.to_string_lossy().into_owned()),
                    report: Some(sb.report.clone()),
                },
            ),
        };
        AppInfo {
            // Taken while `inner` is held, so a later state always has a larger number.
            seq: self.seq.fetch_add(1, Ordering::SeqCst) + 1,
            version: env!("CARGO_PKG_VERSION"),
            build: if cfg!(debug_assertions) { "debug" } else { "release" },
            platform: platform(),
            backdrop: backdrop_supported(),
            data_dir: self.data_dir.to_string_lossy().into_owned(),
            config,
            real_config: ConfigView::of(&real),
            sandbox,
            config_locked_by_flag: self.launch.config_dir.is_some(),
            settings: inner.settings.clone(),
            settings_note: self.settings_note.clone(),
            settings_save_error: inner.save_error.clone(),
            first_paint_ms: inner.first_paint_ms,
        }
    }

    /// Write the latest settings to disk. Call with `inner` released: the write
    /// (and its fsync) happens here, outside the guard. Writers queue on
    /// `save_lock` and each saves the newest copy, so the last change always wins.
    fn persist(&self) {
        let _writing = self.save_lock.lock().unwrap_or_else(|p| p.into_inner());
        let snapshot = self.lock().settings.clone();
        let result = settings::save(&self.data_dir, &snapshot);
        let mut inner = self.lock();
        match result {
            Ok(()) => inner.save_error = None,
            Err(e) => {
                eprintln!("[atlas] could not save settings: {e}");
                inner.save_error = Some(format!(
                    "Atlas could not save its settings ({e}). What you changed will be lost when Atlas closes."
                ));
            }
        }
    }

    pub fn update_settings(&self, patch: SettingsPatch) -> AppInfo {
        let changed = {
            let mut inner = self.lock();
            let mut changed = false;
            if let Some(t) = patch.theme {
                changed |= inner.settings.theme != t;
                inner.settings.theme = t;
            }
            if let Some(v) = patch.last_view {
                changed |= inner.settings.last_view != v;
                inner.settings.last_view = v;
            }
            if let Some(a) = patch.launch_animation {
                changed |= inner.settings.launch_animation != a;
                inner.settings.launch_animation = a;
            }
            if let Some(c) = patch.close_to_tray {
                changed |= inner.settings.close_to_tray != c;
                inner.settings.close_to_tray = c;
            }
            if let Some(n) = patch.notify_on_finish {
                changed |= inner.settings.notify_on_finish != n;
                inner.settings.notify_on_finish = n;
            }
            if let Some(s) = patch.show_shortcuts {
                changed |= inner.settings.show_shortcuts != s;
                inner.settings.show_shortcuts = s;
            }
            if let Some(m) = patch.mcp_auto_connect {
                changed |= inner.settings.mcp_auto_connect != m;
                inner.settings.mcp_auto_connect = m;
            }
            if let Some(k) = patch.history_keep_versions.map(settings::clamp_keep_versions) {
                changed |= inner.settings.history_keep_versions != k;
                inner.settings.history_keep_versions = k;
            }
            if let Some(c) = patch.count_cache_in_totals {
                changed |= inner.settings.count_cache_in_totals != c;
                inner.settings.count_cache_in_totals = c;
            }
            if let Some(t) = patch.text_size {
                changed |= inner.settings.text_size != t;
                inner.settings.text_size = t;
            }
            if let Some(z) = patch.zoom_percent.map(settings::snap_zoom) {
                changed |= inner.settings.zoom_percent != z;
                inner.settings.zoom_percent = z;
            }
            changed
        };
        if changed {
            self.persist();
        }
        self.info()
    }

    /// Save the "Let Claude Code use Atlas" choice. `Err` when it could not be written to disk:
    /// the choice is put back as it was, so the page never promises a setting that the next
    /// launch will not find (an off that is lost means Atlas reconnects by itself).
    pub fn save_mcp_choice(&self, on: bool) -> Result<(), String> {
        let before = {
            let mut inner = self.lock();
            std::mem::replace(&mut inner.settings.mcp_auto_connect, on)
        };
        // Always write: `update_settings` skips an unchanged value, and the stored save error
        // can still be set from an earlier failed save, which would read as this one failing.
        self.persist();
        if self.lock().save_error.is_none() {
            return Ok(());
        }
        self.lock().settings.mcp_auto_connect = before;
        self.persist();
        Err("Atlas could not save this choice, so it left the connection to Claude Code as it was.".into())
    }

    /// Closing the window hides Atlas to the tray (opt-in, default off).
    pub fn close_to_tray(&self) -> bool {
        self.lock().settings.close_to_tray
    }

    /// Draw keyboard shortcut hints (opt-in, default off). Read by the macOS menu only.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn show_shortcuts(&self) -> bool {
        self.lock().settings.show_shortcuts
    }

    /// Atlas connects itself to Claude Code (default on; the user's off choice is kept).
    pub fn mcp_auto_connect(&self) -> bool {
        self.lock().settings.mcp_auto_connect
    }

    /// Token totals include cache writes and reads ("Count cache in token totals", default off).
    pub fn count_cache_in_totals(&self) -> bool {
        self.lock().settings.count_cache_in_totals
    }

    /// Tell the user when a running chat finishes or waits for them (opt-in, default off).
    pub fn notify_on_finish(&self) -> bool {
        self.lock().settings.notify_on_finish
    }

    pub fn mark_first_paint(&self) -> u64 {
        let ms = self.started.elapsed().as_millis() as u64;
        let mut inner = self.lock();
        *inner.first_paint_ms.get_or_insert(ms)
    }

    /// Set (or clear) the folder chosen in Settings. Re-prepares the sandbox if
    /// Sandbox Mode is on.
    pub fn set_config_override(self: &Arc<Self>, dir: Option<String>) -> AppInfo {
        self.lock().settings.config_dir_override = dir.filter(|d| !d.trim().is_empty());
        self.persist();
        self.restart_sandbox_if_wanted();
        self.info()
    }

    pub fn set_sandbox(self: &Arc<Self>, enabled: bool) -> AppInfo {
        {
            let mut inner = self.lock();
            inner.sandbox_wanted = enabled;
            inner.settings.sandbox = enabled;
        }
        self.persist();
        self.restart_sandbox_if_wanted();
        self.info()
    }

    /// Drop any current sandbox and, if Sandbox Mode is wanted, start copying a
    /// new one on a background thread. Never blocks the caller: the old copy is
    /// deleted on its own thread, and a copy still running is told to stop.
    pub fn restart_sandbox_if_wanted(self: &Arc<Self>) {
        let (gen_id, real, old, wanted) = {
            let mut inner = self.lock();
            inner.generation += 1;
            if let Some(b) = inner.build.take() {
                b.cancel.store(true, Ordering::Relaxed); // it cleans up after itself
            }
            let wanted = inner.sandbox_wanted;
            let old = std::mem::replace(&mut inner.slot, if wanted { Slot::Preparing } else { Slot::Off });
            (inner.generation, self.real_root(&inner), old, wanted)
        };
        if let Slot::Ready(sb) = old {
            self.discard_in_background(*sb);
        }
        // The engine stops reading the old folder at once; it starts on the new one
        // when there is one (now, or when the sandbox copy is ready).
        self.usage.sync_in_background(self);
        if !wanted {
            return;
        }

        let cancel = Arc::new(AtomicBool::new(false));
        let this = Arc::clone(self);
        let flag = Arc::clone(&cancel);
        let handle = std::thread::Builder::new()
            .name("atlas-sandbox".into())
            .spawn(move || {
                let started = Instant::now();
                let result = sandbox::create_cancellable(
                    &real,
                    &this.sandbox_parent,
                    &SandboxOptions::default(),
                    &flag,
                );
                // Decide under the guard, delete after it is dropped.
                let leftover: Option<Sandbox> = {
                    let mut inner = this.lock();
                    let superseded =
                        inner.generation != gen_id || !inner.sandbox_wanted || flag.load(Ordering::Relaxed);
                    match result {
                        Ok(sb) if superseded => Some(sb),
                        Ok(sb) => {
                            eprintln!(
                                "[atlas] sandbox ready in {} ms: {} files",
                                started.elapsed().as_millis(),
                                sb.report.files_copied
                            );
                            inner.slot = Slot::Ready(Box::new(sb));
                            None
                        }
                        Err(SandboxError::Cancelled) => None,
                        Err(_) if superseded => None,
                        Err(e) => {
                            inner.slot = Slot::Failed(e.to_string());
                            None
                        }
                    }
                };
                if let Some(sb) = leftover {
                    let _ = sb.discard();
                }
                this.usage.sync_in_background(&this);
                this.announce();
            })
            .expect("spawn sandbox thread");
        self.lock().build = Some(Build { cancel, handle });
    }

    fn discard_in_background(&self, sb: Sandbox) {
        let handle = std::thread::spawn(move || {
            let _ = sb.discard();
        });
        let mut pending = self.discards.lock().unwrap_or_else(|p| p.into_inner());
        pending.retain(|h| !h.is_finished());
        pending.push(handle);
    }

    /// App exit: stop any copy, remove the live sandbox and wait (briefly) for
    /// deletes already under way, so no `atlas-sandbox-*` folder is left behind.
    pub fn shutdown(&self) {
        // The chat index first: it is the longer pass to cancel, and both stop at the
        // next line or batch.
        self.now.shutdown();
        self.search.shutdown();
        self.usage.shutdown();
        let (old, build) = {
            let mut inner = self.lock();
            inner.generation += 1; // a copy that finishes now is thrown away
            (std::mem::replace(&mut inner.slot, Slot::Off), inner.build.take())
        };
        if let Some(b) = &build {
            b.cancel.store(true, Ordering::Relaxed);
        }
        if let Slot::Ready(sb) = old {
            let _ = sb.discard();
        }
        let mut handles = std::mem::take(&mut *self.discards.lock().unwrap_or_else(|p| p.into_inner()));
        handles.extend(build.map(|b| b.handle));
        join_within(handles, EXIT_WAIT);
    }

    /// Tell other Atlas instances this sandbox is in use (see `sandbox::touch`).
    pub fn refresh_sandbox_marker(&self) {
        let dir = match &self.lock().slot {
            Slot::Ready(sb) => Some(sb.root.dir.clone()),
            _ => None,
        };
        if let Some(dir) = dir {
            let _ = sandbox::touch(&dir);
        }
    }

    /// Keep the live sandbox's marker fresh for as long as the app runs.
    pub fn start_heartbeat(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let _ = std::thread::Builder::new().name("atlas-heartbeat".into()).spawn(move || {
            loop {
                std::thread::sleep(HEARTBEAT);
                let Some(state) = weak.upgrade() else { return };
                state.refresh_sandbox_marker();
            }
        });
    }

    /// Remove sandboxes a crash left behind. Never one whose owner is still running.
    pub fn sweep_stale_sandboxes(&self) {
        let n = sandbox::cleanup_stale(&self.sandbox_parent, Duration::from_secs(24 * 3600));
        if n > 0 {
            eprintln!("[atlas] removed {n} old sandbox folder(s)");
        }
    }
}

/// Wait for threads to finish, but never longer than `limit` in total.
fn join_within(handles: Vec<JoinHandle<()>>, limit: Duration) {
    if handles.is_empty() {
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for h in handles {
            let _ = h.join();
        }
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(limit);
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Mica needs Windows 11 (build 22000+); macOS vibrancy is always there.
pub fn backdrop_supported() -> bool {
    // A way to see the Windows 10 look on a Windows 11 machine (ATLAS_NO_BACKDROP=1).
    if std::env::var_os("ATLAS_NO_BACKDROP").is_some() {
        return false;
    }
    #[cfg(windows)]
    {
        windows_version::OsVersion::current().build >= 22000
    }
    #[cfg(target_os = "macos")]
    {
        true
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::AtomicUsize;
    use tempfile::{TempDir, tempdir};

    /// A state wired to scratch folders: a small fake Claude folder, its own data
    /// dir and its own "temp" parent for sandboxes.
    fn fixture(sandbox: bool) -> (TempDir, Arc<AppState>) {
        let tmp = tempdir().unwrap();
        let claude = tmp.path().join("claude");
        fs::create_dir_all(claude.join("skills/a")).unwrap();
        fs::write(claude.join("CLAUDE.md"), b"# hi").unwrap();
        fs::write(claude.join("skills/a/SKILL.md"), b"x").unwrap();
        fs::write(claude.join("settings.json"), br#"{"model":"x","env":{"K":"LIVE"}}"#).unwrap();
        let launch = LaunchArgs {
            config_dir: Some(claude),
            data_dir: Some(tmp.path().join("data")),
            sandbox,
            warnings: vec![],
        };
        let state = AppState::with_parts(
            launch,
            tmp.path().join("home"),
            tmp.path().to_path_buf(),
            None,
            tmp.path().join("data"),
            tmp.path().join("data"),
            tmp.path().join("sbx"),
        );
        (tmp, state)
    }

    fn sandboxes(tmp: &TempDir) -> Vec<PathBuf> {
        fs::read_dir(tmp.path().join("sbx"))
            .map(|rd| {
                rd.filter_map(Result::ok)
                    .map(|e| e.path())
                    .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(sandbox::DIR_PREFIX)))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn wait_for(what: &str, mut ok: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(20);
        while Instant::now() < end {
            if ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        panic!("timed out waiting for: {what}");
    }

    fn ready(state: &Arc<AppState>) -> PathBuf {
        wait_for("sandbox ready", || state.info().sandbox.state == "ready");
        PathBuf::from(state.info().sandbox.path.unwrap())
    }

    #[test]
    fn turning_sandbox_off_removes_the_copy_and_returns_to_the_real_folder() {
        let (tmp, state) = fixture(false);
        assert_eq!(state.info().sandbox.state, "off");
        state.set_sandbox(true);
        let copy = ready(&state);
        assert!(copy.join("CLAUDE.md").is_file());
        assert_eq!(sandboxes(&tmp).len(), 1);
        // The copy never carries the secret from settings.json.
        assert!(!fs::read_to_string(copy.join("settings.json")).unwrap().contains("LIVE"));

        let info = state.set_sandbox(false);
        assert_eq!(info.sandbox.state, "off");
        assert_eq!(info.config.as_ref().unwrap().source, ConfigSource::Flag, "back on the real folder");
        wait_for("copy deleted after Sandbox off", || sandboxes(&tmp).is_empty());
        assert!(tmp.path().join("claude/CLAUDE.md").is_file(), "the real folder is untouched");
    }

    #[test]
    fn exit_removes_the_live_sandbox() {
        let (tmp, state) = fixture(true);
        state.restart_sandbox_if_wanted();
        let copy = ready(&state);
        assert!(copy.is_dir());
        state.shutdown();
        assert!(!copy.exists(), "exit must remove the sandbox before it returns");
        assert!(sandboxes(&tmp).is_empty());
    }

    #[test]
    fn exit_or_turning_off_while_the_copy_is_still_running_leaves_nothing() {
        for exit in [true, false] {
            let (tmp, state) = fixture(false);
            state.set_sandbox(true); // copy starts on its thread
            if exit {
                state.shutdown(); // waits for the copy to stop and clean up
                assert!(sandboxes(&tmp).is_empty(), "left behind after exit");
            } else {
                state.set_sandbox(false);
                wait_for("half-built copy removed", || sandboxes(&tmp).is_empty());
            }
            // And nothing arrives late.
            std::thread::sleep(Duration::from_millis(150));
            assert!(sandboxes(&tmp).is_empty(), "a late copy appeared (exit={exit})");
            assert_ne!(state.info().sandbox.state, "ready");
        }
    }

    #[test]
    fn switching_the_folder_replaces_the_copy_and_deletes_the_old_one() {
        let (tmp, state) = fixture(true);
        state.restart_sandbox_if_wanted();
        let first = ready(&state);
        state.set_config_override(None); // re-prepares from the same source
        wait_for("old copy gone", || !first.exists());
        let second = ready(&state);
        assert_ne!(first, second);
        wait_for("exactly one copy left", || sandboxes(&tmp).len() == 1);
    }

    #[test]
    fn the_marker_is_refreshed_for_the_live_sandbox() {
        let (_tmp, state) = fixture(true);
        state.restart_sandbox_if_wanted();
        let copy = ready(&state);
        let marker = copy.join(sandbox::MARKER);
        let old = std::time::SystemTime::now() - Duration::from_secs(3 * 24 * 3600);
        fs::File::options().write(true).open(&marker).unwrap().set_modified(old).unwrap();
        state.refresh_sandbox_marker();
        let age = std::time::SystemTime::now().duration_since(fs::metadata(&marker).unwrap().modified().unwrap()).unwrap();
        assert!(age < Duration::from_secs(60), "marker still {age:?} old");
        // And so a sweep by another instance keeps it.
        assert_eq!(sandbox::cleanup_stale(&state.sandbox_parent, Duration::from_secs(24 * 3600)), 0);
        assert!(copy.exists());
    }

    #[test]
    fn the_off_choice_for_claude_code_is_saved_and_a_new_launch_still_sees_it() {
        let (tmp, state) = fixture(false);
        assert!(state.mcp_auto_connect(), "on by default");
        let info = state.update_settings(SettingsPatch { mcp_auto_connect: Some(false), ..Default::default() });
        assert!(!info.settings.mcp_auto_connect);
        assert!(!settings::load(&tmp.path().join("data")).settings.mcp_auto_connect);
    }

    #[test]
    fn text_size_and_zoom_are_saved_and_a_zoom_snaps_to_a_step() {
        let (tmp, state) = fixture(false);
        let info = state.update_settings(SettingsPatch { text_size: Some(settings::TextSize::Larger), zoom_percent: Some(137), ..Default::default() });
        assert_eq!((info.settings.text_size, info.settings.zoom_percent), (settings::TextSize::Larger, 125));
        let saved = settings::load(&tmp.path().join("data")).settings;
        assert_eq!((saved.text_size, saved.zoom_percent), (settings::TextSize::Larger, 125));
        // Something else changing leaves them as they were.
        let info = state.update_settings(SettingsPatch { show_shortcuts: Some(true), ..Default::default() });
        assert_eq!((info.settings.text_size, info.settings.zoom_percent), (settings::TextSize::Larger, 125));
    }

    #[test]
    fn an_off_choice_that_cannot_be_saved_is_refused_and_put_back() {
        let (tmp, state) = fixture(false);
        let blocker = tmp.path().join("data").join(settings::FILE_NAME);
        fs::create_dir_all(&blocker).unwrap();
        let err = state.save_mcp_choice(false).expect_err("a lost off would let Atlas reconnect");
        assert!(err.contains("could not save"), "{err}");
        assert!(state.mcp_auto_connect(), "the page must not show an off that the next launch will not find");
        fs::remove_dir_all(&blocker).unwrap();
        state.save_mcp_choice(false).expect("saves once the disk allows");
        assert!(!settings::load(&tmp.path().join("data")).settings.mcp_auto_connect);
    }

    #[test]
    fn an_old_save_failure_does_not_make_an_unchanged_choice_look_failed() {
        let (tmp, state) = fixture(false);
        let blocker = tmp.path().join("data").join(settings::FILE_NAME);
        fs::create_dir_all(&blocker).unwrap();
        // An earlier, unrelated save fails and leaves the stored error set.
        let info = state.update_settings(SettingsPatch { show_shortcuts: Some(true), ..Default::default() });
        assert!(info.settings_save_error.is_some());
        fs::remove_dir_all(&blocker).unwrap();
        // The choice is already on and the disk works now: nothing failed, so no refusal.
        assert!(state.mcp_auto_connect());
        state.save_mcp_choice(true).expect("a save that works must not report the old error");
        assert!(state.info().settings_save_error.is_none());
        assert!(settings::load(&tmp.path().join("data")).settings.mcp_auto_connect);
    }

    #[test]
    fn the_launch_connection_is_claimed_once() {
        let (_tmp, state) = fixture(false);
        assert!(state.claim_auto_connect());
        assert!(!state.claim_auto_connect(), "a page reload must not start a second one");
    }

    #[test]
    fn a_failed_settings_save_is_reported_and_clears_when_a_save_works() {
        let (tmp, state) = fixture(false);
        // A folder where the settings file should go makes the replace fail.
        let blocker = tmp.path().join("data").join(settings::FILE_NAME);
        fs::create_dir_all(&blocker).unwrap();

        let info = state.update_settings(SettingsPatch { theme: Some(Theme::Dark), last_view: None, launch_animation: None, ..Default::default() });
        assert_eq!(info.settings.theme, Theme::Dark, "the choice still applies for this session");
        let msg = info.settings_save_error.expect("failure must be surfaced");
        assert!(msg.contains("could not save"), "{msg}");

        fs::remove_dir_all(&blocker).unwrap();
        let info = state.update_settings(SettingsPatch { theme: None, last_view: Some(View::Setup), launch_animation: None, ..Default::default() });
        assert!(info.settings_save_error.is_none());
        let on_disk = settings::load(&tmp.path().join("data")).settings;
        assert_eq!(on_disk.theme, Theme::Dark, "the latest in-memory copy is what gets written");
        assert_eq!(on_disk.last_view, View::Setup);
    }

    #[test]
    fn close_to_tray_is_off_until_asked_and_survives_a_restart() {
        let (tmp, state) = fixture(false);
        assert!(!state.close_to_tray());
        assert!(!state.info().settings.close_to_tray);
        // A patch that does not mention it leaves it alone.
        state.update_settings(SettingsPatch { theme: Some(Theme::Dark), ..Default::default() });
        assert!(!state.close_to_tray());
        let info = state.update_settings(SettingsPatch { close_to_tray: Some(true), ..Default::default() });
        assert!(info.settings.close_to_tray && state.close_to_tray());
        assert!(settings::load(&tmp.path().join("data")).settings.close_to_tray, "persisted");
        state.update_settings(SettingsPatch { close_to_tray: Some(false), ..Default::default() });
        assert!(!settings::load(&tmp.path().join("data")).settings.close_to_tray);
    }

    #[test]
    fn a_quit_is_held_back_only_while_edits_are_unsaved() {
        let (_tmp, state) = fixture(false);
        assert_eq!(state.leave_decision(true), Leave::Go, "nothing unsaved");
        state.set_unsaved(true);
        assert_eq!(state.leave_decision(true), Leave::Ask);
        assert_eq!(state.leave_decision(false), Leave::Go, "a close that only hides the window loses nothing");
        state.set_unsaved(false);
        assert_eq!(state.leave_decision(true), Leave::Go, "saved or discarded");
    }

    #[test]
    fn snapshots_carry_a_rising_sequence_number() {
        let (_tmp, state) = fixture(false);
        let a = state.info().seq;
        let b = state.update_settings(SettingsPatch { theme: Some(Theme::Light), last_view: None, launch_animation: None, ..Default::default() }).seq;
        let c = state.info().seq;
        assert!(a < b && b < c, "{a} {b} {c}");
    }

    #[test]
    fn announce_reaches_the_notifier_with_the_sandbox_result() {
        let (_tmp, state) = fixture(false);
        let seen = Arc::new(AtomicUsize::new(0));
        let s2 = Arc::clone(&seen);
        state.set_notifier(Arc::new(move |info| {
            if info.sandbox.state == "ready" {
                s2.fetch_add(1, Ordering::SeqCst);
            }
        }));
        state.set_sandbox(true);
        wait_for("ready announced", || seen.load(Ordering::SeqCst) >= 1);
        state.shutdown();
    }
}
