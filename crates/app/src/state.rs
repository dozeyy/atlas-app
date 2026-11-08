//! App state: Atlas's settings, the resolved Claude config root and the
//! Sandbox Mode slot. Everything the front end sees goes through `AppInfo`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use atlas_core::launch::LaunchArgs;
use atlas_core::paths::{self, ConfigInputs, ConfigRoot, ConfigSource};
use atlas_core::sandbox::{self, Sandbox, SandboxOptions, SandboxReport};
use atlas_core::settings::{self, Settings, Theme, View};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const INFO_EVENT: &str = "atlas://info";

enum Slot {
    Off,
    Preparing,
    Ready(Box<Sandbox>),
    Failed(String),
}

struct Inner {
    settings: Settings,
    /// Sandbox Mode wanted (setting or `--sandbox` flag).
    sandbox_wanted: bool,
    slot: Slot,
    /// Bumped on every change so a slow copy that finished late is thrown away.
    generation: u64,
    first_paint_ms: Option<u64>,
}

pub struct AppState {
    pub started: Instant,
    pub launch: LaunchArgs,
    pub data_dir: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    env_config: Option<OsString>,
    sandbox_parent: PathBuf,
    settings_note: Option<String>,
    inner: Mutex<Inner>,
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
    pub version: &'static str,
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
    pub first_paint_ms: Option<u64>,
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub theme: Option<Theme>,
    pub last_view: Option<View>,
}

impl AppState {
    pub fn new(launch: LaunchArgs) -> Arc<AppState> {
        let started = Instant::now();
        let home = paths::home_dir().unwrap_or_else(std::env::temp_dir);
        let cwd = std::env::current_dir().unwrap_or_else(|_| home.clone());
        let env_config = std::env::var_os("CLAUDE_CONFIG_DIR");
        let atlas_env = std::env::var_os("ATLAS_DATA_DIR");
        let data_dir =
            paths::data_dir(launch.data_dir.as_deref(), atlas_env.as_deref(), &home, &cwd)
                .unwrap_or_else(|| std::env::temp_dir().join("atlas"));

        let loaded = settings::load(&data_dir);
        let settings_note = loaded.recovered_from.as_ref().map(|p| {
            format!("Atlas's settings file was damaged and was set aside as {}.", p.display())
        });
        let sandbox_wanted = launch.sandbox || loaded.settings.sandbox;

        Arc::new(AppState {
            started,
            launch,
            data_dir,
            home,
            cwd,
            env_config,
            sandbox_parent: std::env::temp_dir(),
            settings_note,
            inner: Mutex::new(Inner {
                settings: loaded.settings,
                sandbox_wanted,
                slot: if sandbox_wanted { Slot::Preparing } else { Slot::Off },
                generation: 0,
                first_paint_ms: None,
            }),
        })
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
            version: env!("CARGO_PKG_VERSION"),
            platform: platform(),
            backdrop: backdrop_supported(),
            data_dir: self.data_dir.to_string_lossy().into_owned(),
            config,
            real_config: ConfigView::of(&real),
            sandbox,
            config_locked_by_flag: self.launch.config_dir.is_some(),
            settings: inner.settings.clone(),
            settings_note: self.settings_note.clone(),
            first_paint_ms: inner.first_paint_ms,
        }
    }

    fn save_locked(&self, inner: &Inner) {
        if let Err(e) = settings::save(&self.data_dir, &inner.settings) {
            eprintln!("[atlas] could not save settings: {e}");
        }
    }

    pub fn update_settings(&self, patch: SettingsPatch) -> AppInfo {
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
        if changed {
            self.save_locked(&inner);
        }
        self.info_locked(&inner)
    }

    pub fn mark_first_paint(&self) -> u64 {
        let ms = self.started.elapsed().as_millis() as u64;
        let mut inner = self.lock();
        *inner.first_paint_ms.get_or_insert(ms)
    }

    /// Set (or clear) the folder chosen in Settings. Re-prepares the sandbox if
    /// Sandbox Mode is on.
    pub fn set_config_override(self: &Arc<Self>, app: &AppHandle, dir: Option<String>) -> AppInfo {
        {
            let mut inner = self.lock();
            inner.settings.config_dir_override = dir.filter(|d| !d.trim().is_empty());
            self.save_locked(&inner);
        }
        self.restart_sandbox_if_wanted(app);
        self.info()
    }

    pub fn set_sandbox(self: &Arc<Self>, app: &AppHandle, enabled: bool) -> AppInfo {
        {
            let mut inner = self.lock();
            inner.sandbox_wanted = enabled;
            inner.settings.sandbox = enabled;
            self.save_locked(&inner);
        }
        self.restart_sandbox_if_wanted(app);
        self.info()
    }

    /// Drop any current sandbox and, if Sandbox Mode is wanted, start copying a
    /// new one on a background thread. Never blocks the caller.
    pub fn restart_sandbox_if_wanted(self: &Arc<Self>, app: &AppHandle) {
        let (gen_id, real, old) = {
            let mut inner = self.lock();
            inner.generation += 1;
            let next = if inner.sandbox_wanted { Slot::Preparing } else { Slot::Off };
            let old = std::mem::replace(&mut inner.slot, next);
            (inner.generation, self.real_root(&inner), old)
        };
        if let Slot::Ready(sb) = old {
            let _ = sb.discard();
        }
        if !self.lock().sandbox_wanted {
            return;
        }
        let this = Arc::clone(self);
        let app = app.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            let result = sandbox::create(&real, &this.sandbox_parent, &SandboxOptions::default());
            let leftover = {
                let mut inner = this.lock();
                if inner.generation != gen_id || !inner.sandbox_wanted {
                    // Superseded while copying: throw this copy away.
                    result.ok().map(|sb| sb.discard())
                } else {
                    match result {
                        Ok(sb) => {
                            eprintln!(
                                "[atlas] sandbox ready in {} ms: {} files",
                                started.elapsed().as_millis(),
                                sb.report.files_copied
                            );
                            inner.slot = Slot::Ready(Box::new(sb));
                        }
                        Err(e) => inner.slot = Slot::Failed(e.to_string()),
                    }
                    None
                }
            };
            drop(leftover);
            let _ = app.emit(INFO_EVENT, this.info());
        });
    }

    /// Remove the live sandbox (app exit) and sweep old ones a crash left behind.
    pub fn shutdown(&self) {
        let old = std::mem::replace(&mut self.lock().slot, Slot::Off);
        if let Slot::Ready(sb) = old {
            let _ = sb.discard();
        }
    }

    pub fn sweep_stale_sandboxes(&self) {
        let n = sandbox::cleanup_stale(&self.sandbox_parent, std::time::Duration::from_secs(24 * 3600));
        if n > 0 {
            eprintln!("[atlas] removed {n} old sandbox folder(s)");
        }
    }
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
