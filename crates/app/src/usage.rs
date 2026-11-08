//! The usage engine's door to the page: the host that owns the running engine, the
//! event bridge, and the async commands (D38: no usage command is synchronous, and
//! none runs SQLite or transcript work on the UI thread).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use atlas_core::cache;
use atlas_core::cache::pricing_file;
use atlas_core::usage::query::{
    AgentDetail, Dashboard, FilterOptions, ItemQuery, ItemUse, SessionDetail, SessionPage, SessionQuery, Timeline, TimelineArgs,
};
use atlas_core::usage::transcript::TranscriptPage;
use atlas_core::usage::{Event, EventSink, PricingInfo, State as UsageState, UsageConfig, UsageEngine, UsageStatus};
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;

pub const STATUS_EVENT: &str = "atlas://usage/status";
pub const PROGRESS_EVENT: &str = "atlas://usage/progress";
pub const CHANGED_EVENT: &str = "atlas://usage/changed";
pub const PRICING_EVENT: &str = "atlas://pricing/changed";

type Shared<'a> = State<'a, Arc<AppState>>;

/// What other parts of the app (the tray readout, the chat-search indexer) wait for. The
/// usage engine is the one source of "the Claude folder changed", so they hang off it
/// instead of watching the disk themselves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    /// New usage rows were written.
    Changed,
    /// The usage engine finished a pass and is idle.
    Idle,
    /// The window gained focus.
    Focus,
    /// The engine was replaced (another Claude folder, or none).
    Restarted,
}

type Listener = Arc<dyn Fn(Signal) + Send + Sync>;

#[derive(Default)]
pub struct Signals {
    listeners: Mutex<Vec<Listener>>,
}

impl Signals {
    pub fn subscribe(&self, f: impl Fn(Signal) + Send + Sync + 'static) {
        self.listeners.lock().unwrap_or_else(|p| p.into_inner()).push(Arc::new(f));
    }

    /// Runs the listeners on the caller's thread, outside the lock; they must be quick
    /// (a channel send or a poke).
    pub fn fire(&self, s: Signal) {
        let all: Vec<Listener> = self.listeners.lock().unwrap_or_else(|p| p.into_inner()).clone();
        for f in all {
            f(s);
        }
    }
}

/// What the engine reads and where its cache goes.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Roots {
    pub projects_dir: PathBuf,
    pub config_dir: PathBuf,
    /// The real ledger (`<data>/cache.sqlite`) rather than a per-folder cache (D27).
    pub real: bool,
}

struct Running {
    roots: Roots,
    engine: Arc<UsageEngine>,
}

#[derive(Default)]
pub struct UsageHost {
    current: Mutex<Option<Running>>,
    pub dashboard_logged: AtomicBool,
    /// Held while a start or a restart is in flight, so two syncs never interleave.
    syncing: Mutex<()>,
    /// The app handle events go out through; set once the window exists.
    app: Mutex<Option<AppHandle>>,
    pub signals: Arc<Signals>,
}

struct TauriSink {
    app: AppHandle,
    signals: Arc<Signals>,
}

impl EventSink for TauriSink {
    fn emit(&self, event: Event) {
        let signal = match &event {
            Event::Changed(_) => Some(Signal::Changed),
            Event::Status(s) if s.state == UsageState::Idle => Some(Signal::Idle),
            _ => None,
        };
        let _ = match event {
            Event::Status(s) => self.app.emit(STATUS_EVENT, s),
            Event::Progress(p) => self.app.emit(PROGRESS_EVENT, p),
            Event::Changed(c) => self.app.emit(CHANGED_EVENT, c),
            Event::Pricing(p) => self.app.emit(PRICING_EVENT, p),
        };
        if let Some(s) = signal {
            self.signals.fire(s);
        }
    }
    fn log(&self, line: &str) {
        eprintln!("{line}");
    }
}

impl UsageHost {
    /// Start, keep or restart the engine so it matches the folder Atlas works on.
    /// Always runs on a background thread: starting reads nothing, but stopping the
    /// old engine waits for it to wind down.
    pub fn sync_in_background(self: &Arc<Self>, state: &Arc<AppState>) {
        let Some(app) = self.app.lock().unwrap_or_else(|p| p.into_inner()).clone() else { return };
        let (host, state) = (Arc::clone(self), Arc::clone(state));
        std::thread::spawn(move || host.sync_now(&state, &app));
    }

    /// Give the host the handle it emits events through (called once, from `setup`).
    pub fn attach(&self, app: AppHandle) {
        *self.app.lock().unwrap_or_else(|p| p.into_inner()) = Some(app);
    }

    fn sync_now(&self, state: &AppState, app: &AppHandle) {
        let _one_at_a_time = self.syncing.lock().unwrap_or_else(|p| p.into_inner());
        let wanted = state.usage_roots();
        // The chat-search index follows the same folder (its own engine and file).
        state.search.sync(wanted.as_ref(), &state.local_data_dir, app);
        let old = {
            let mut cur = self.current.lock().unwrap_or_else(|p| p.into_inner());
            if cur.as_ref().map(|r| &r.roots) == wanted.as_ref() {
                return;
            }
            let old = cur.take();
            if let Some(roots) = wanted {
                let cache_db = cache::cache_file(&state.local_data_dir, &roots.projects_dir, roots.real);
                let mut cfg = UsageConfig::new(
                    roots.projects_dir.clone(),
                    roots.config_dir.clone(),
                    state.local_data_dir.clone(),
                    cache_db,
                );
                cfg.week_starts_sunday = week_starts_sunday();
                let engine = UsageEngine::start(cfg, Arc::new(TauriSink { app: app.clone(), signals: Arc::clone(&self.signals) }));
                *cur = Some(Running { roots, engine });
            }
            old
        };
        if let Some(o) = old {
            o.engine.stop();
        }
        // A new (or no) engine: the tray should not keep showing the old folder's numbers.
        self.signals.fire(Signal::Restarted);
    }

    pub fn engine(&self) -> Result<Arc<UsageEngine>, String> {
        self.current
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|r| Arc::clone(&r.engine))
            .ok_or_else(|| "Atlas has no Claude folder to read yet.".to_string())
    }

    pub fn focus(&self, focused: bool) {
        if let Ok(e) = self.engine() {
            e.set_visible(focused);
            if focused {
                e.focus();
            }
        }
        if focused {
            self.signals.fire(Signal::Focus);
        }
    }

    /// The first full pass over the transcripts has finished.
    pub fn first_index_done(&self) -> bool {
        self.engine().is_ok_and(|e| e.status().first_index_done)
    }

    pub fn shutdown(&self) {
        let old = self.current.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(o) = old {
            o.engine.stop();
        }
    }

    fn data_dir_for_pricing(&self, state: &AppState) -> PathBuf {
        state.local_data_dir.clone()
    }
}

/// Q9: the week starts where the operating system's locale says. Windows asks the
/// user's locale; elsewhere Monday.
pub fn week_starts_sunday() -> bool {
    #[cfg(windows)]
    {
        unsafe extern "system" {
            fn GetLocaleInfoEx(name: *const u16, lc_type: u32, data: *mut u16, len: i32) -> i32;
        }
        const LOCALE_IFIRSTDAYOFWEEK: u32 = 0x0000_100C;
        const LOCALE_RETURN_NUMBER: u32 = 0x2000_0000;
        let mut out = [0u16; 2];
        // SAFETY: a null name means the user's default locale; `out` holds the DWORD
        // that LOCALE_RETURN_NUMBER asks for.
        let n = unsafe { GetLocaleInfoEx(std::ptr::null(), LOCALE_IFIRSTDAYOFWEEK | LOCALE_RETURN_NUMBER, out.as_mut_ptr(), 2) };
        // 0 = Monday ... 6 = Sunday.
        n != 0 && (u32::from(out[0]) | (u32::from(out[1]) << 16)) == 6
    }
    #[cfg(not(windows))]
    {
        false
    }
}

async fn blocking<T, F>(engine: Result<Arc<UsageEngine>, String>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Arc<UsageEngine>) -> Result<T, String> + Send + 'static,
{
    let engine = engine?;
    tauri::async_runtime::spawn_blocking(move || f(engine)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn usage_status(state: Shared<'_>) -> Result<UsageStatus, String> {
    let engine = state.usage.engine();
    Ok(match engine {
        Ok(e) => e.status(),
        Err(_) => UsageStatus { note: Some("Waiting for a Claude folder.".into()), ..UsageStatus::default() },
    })
}

#[tauri::command]
pub async fn usage_dashboard(state: Shared<'_>) -> Result<Dashboard, String> {
    let started = state.started;
    let engine = state.usage.engine();
    let out = blocking(engine, |e| e.dashboard()).await?;
    if !state.usage.dashboard_logged.swap(true, Ordering::SeqCst) {
        eprintln!("usage: dashboard ready {} ms", started.elapsed().as_millis());
    }
    Ok(out)
}

#[tauri::command]
pub async fn usage_timeline(
    state: Shared<'_>,
    from: String,
    to: String,
    bucket: String,
    group_by: Option<String>,
) -> Result<Timeline, String> {
    let args = TimelineArgs { from, to, bucket, group_by };
    blocking(state.usage.engine(), move |e| e.timeline(&args)).await
}

#[tauri::command]
pub async fn sessions_list(state: Shared<'_>, query: SessionQuery) -> Result<SessionPage, String> {
    blocking(state.usage.engine(), move |e| e.sessions_list(&query)).await
}

#[tauri::command]
pub async fn session_detail(state: Shared<'_>, session_id: String) -> Result<Option<SessionDetail>, String> {
    blocking(state.usage.engine(), move |e| e.session_detail(&session_id)).await
}

#[tauri::command]
pub async fn usage_by_item(state: Shared<'_>, query: ItemQuery) -> Result<Vec<ItemUse>, String> {
    blocking(state.usage.engine(), move |e| e.usage_by_item(&query)).await
}

#[tauri::command]
pub async fn usage_agent_detail(state: Shared<'_>, session_id: String, agent_id: String) -> Result<Option<AgentDetail>, String> {
    blocking(state.usage.engine(), move |e| e.agent_detail(&session_id, &agent_id)).await
}

#[tauri::command]
pub async fn session_transcript(
    state: Shared<'_>,
    session_id: String,
    cursor: Option<String>,
    limit: Option<usize>,
) -> Result<TranscriptPage, String> {
    blocking(state.usage.engine(), move |e| {
        e.session_transcript(&session_id, cursor.as_deref(), limit.unwrap_or(50).clamp(1, 100))
    })
    .await
}

#[tauri::command]
pub async fn usage_filter_options(state: Shared<'_>) -> Result<FilterOptions, String> {
    blocking(state.usage.engine(), |e| e.filter_options()).await
}

#[tauri::command]
pub async fn usage_reindex(state: Shared<'_>, scope: String) -> Result<UsageStatus, String> {
    blocking(state.usage.engine(), move |e| {
        e.reindex(scope == "full");
        Ok(e.status())
    })
    .await
}

#[tauri::command]
pub async fn pricing_get(state: Shared<'_>) -> Result<PricingInfo, String> {
    blocking(state.usage.engine(), |e| Ok(e.pricing_info())).await
}

/// Show `pricing.json` in the OS file manager.
#[tauri::command]
pub async fn pricing_reveal(state: Shared<'_>) -> Result<(), String> {
    let path = pricing_file::live_path(&state.usage.data_dir_for_pricing(&state));
    tauri::async_runtime::spawn_blocking(move || reveal(&path)).await.map_err(|e| e.to_string())?
}

fn reveal(path: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    if !path.exists() {
        return Err("The price file has not been created yet.".into());
    }
    #[cfg(windows)]
    let r = Command::new("explorer.exe").arg(format!("/select,{}", path.display())).spawn();
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg("-R").arg(path).spawn();
    #[cfg(not(any(windows, target_os = "macos")))]
    let r = Command::new("xdg-open").arg(path.parent().unwrap_or(path)).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}
