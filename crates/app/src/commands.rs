//! Tauri commands: the only door between the page and Rust.

use std::sync::Arc;

use atlas_core::settings::Theme;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::state::{AppInfo, AppState, SettingsPatch};

type Shared<'a> = State<'a, Arc<AppState>>;

/// System follows the OS; Light / Silver / Dark pin the window (and so Mica / vibrancy and the
/// title bar). Silver is a light grey, so its window is a light one.
pub fn apply_window_theme(window: &WebviewWindow, theme: Theme) {
    let t = match theme {
        Theme::System => None,
        Theme::Light | Theme::Silver => Some(tauri::Theme::Light),
        Theme::Dark => Some(tauri::Theme::Dark),
    };
    let _ = window.set_theme(t);
}

/// Webview zoom for a saved percent. The window is hidden until the page has painted, so this runs
/// before the first frame is seen.
pub fn apply_zoom(window: &WebviewWindow, percent: u32) {
    if let Err(e) = window.set_zoom(f64::from(percent) / 100.0) {
        eprintln!("[atlas] zoom {percent}% not applied: {e}");
    }
}

#[tauri::command]
pub fn get_app_info(state: Shared) -> AppInfo {
    state.info()
}

// `async` here means "not on the UI thread": these write files.
#[tauri::command(async)]
pub fn update_settings(app: AppHandle, state: Shared, patch: SettingsPatch) -> AppInfo {
    let theme = patch.theme;
    let shortcuts = patch.show_shortcuts;
    let count = patch.count_cache_in_totals;
    let zoom = patch.zoom_percent;
    let info = state.update_settings(patch);
    // Every total, ranking and readout counts the new way from the next question on; the page
    // is told to ask again (`usage://changed`), the tray and the Now tab re-send theirs.
    if let Some(on) = count {
        state.usage.set_count_cache(on, &app);
        state.now.set_count_cache(on);
    }
    // The macOS menu bar draws Cmd+, only while the hints are on.
    #[cfg(target_os = "macos")]
    if shortcuts.is_some() {
        crate::macmenu::refresh(&app, info.settings.show_shortcuts);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = shortcuts;
    if let (Some(t), Some(w)) = (theme, app.get_webview_window("main")) {
        apply_window_theme(&w, t);
    }
    // The snapped value is what is saved, so it is also what the window shows.
    if zoom.is_some()
        && let Some(w) = app.get_webview_window("main")
    {
        apply_zoom(&w, info.settings.zoom_percent);
    }
    info
}

#[tauri::command(async)]
pub fn set_sandbox(state: Shared, enabled: bool) -> AppInfo {
    state.set_sandbox(enabled)
}

/// Opens the folder picker. Returns the new info, or the unchanged info when the
/// picker is cancelled.
#[tauri::command]
pub async fn choose_config_dir(app: AppHandle, state: Shared<'_>) -> Result<AppInfo, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Choose your Claude folder")
        .blocking_pick_folder();
    match picked {
        Some(p) => {
            let path = p.into_path().map_err(|e| e.to_string())?;
            Ok(state.set_config_override(Some(path.to_string_lossy().into_owned())))
        }
        None => Ok(state.info()),
    }
}

#[tauri::command(async)]
pub fn clear_config_dir(state: Shared) -> AppInfo {
    state.set_config_override(None)
}

/// Shows the Claude folder Atlas reads in the file manager. Takes no path from the page:
/// it opens the folder Atlas itself resolved, and nothing else.
#[tauri::command(async)]
pub fn open_config_dir(state: Shared) -> Result<(), String> {
    let info = state.info();
    let cfg = info.config.ok_or_else(|| "The folder is not ready yet.".to_string())?;
    if !cfg.dir_exists {
        return Err("That folder does not exist.".to_string());
    }
    open_in_file_manager(std::path::Path::new(&cfg.dir))
}

/// Shows Atlas's own data folder (settings, caches, backups of what the Toolkit changed) in the
/// file manager, for Help > Report a problem. Like the one above it takes no path from the page.
#[tauri::command(async)]
pub fn open_data_dir(state: Shared) -> Result<(), String> {
    let dir = state.data_dir.clone();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not open the folder: {e}"))?;
    open_in_file_manager(&dir)
}

/// The program that takes Atlas off this computer, when this is a real Windows install: the styled
/// remover Setup places beside Atlas, else the installer's own plain uninstaller. Nothing is ever
/// taken from the page; the path is always next to the running Atlas.
fn uninstaller_path() -> Option<std::path::PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    ["Uninstall Atlas.exe", "uninstall.exe"].iter().map(|n| dir.join(n)).find(|p| p.is_file())
}

/// Whether Settings should offer "Uninstall Atlas...".
#[tauri::command]
pub fn uninstall_available() -> bool {
    uninstaller_path().is_some()
}

/// Starts the remover on its own and leaves Atlas running: the remover asks Atlas to quit (through
/// the same quit signal an update uses) once the person has said yes on its own screen.
#[tauri::command(async)]
pub fn uninstall_atlas() -> Result<(), String> {
    let path = uninstaller_path().ok_or_else(|| "This copy of Atlas has no uninstaller beside it.".to_string())?;
    let mut cmd = std::process::Command::new(path);
    // Not Atlas's own working folder (often the install folder): the remover inherits it, and a
    // working folder is held open, which would keep the emptied install folder from going.
    cmd.current_dir(std::env::var_os("SystemRoot").map(std::path::PathBuf::from).filter(|p| p.is_dir()).unwrap_or_else(std::env::temp_dir));
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: no console at all, so no window (Windows
        // ignores CREATE_NO_WINDOW next to DETACHED_PROCESS; the remover is a windowed program).
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("Could not start the uninstaller: {e}"))
}

/// Wrapped's share card: ask where to put the PNG (starting in Pictures) and write it there.
/// The page hands over the bytes; only a PNG of sane size is written, and never into a Claude
/// folder. Returns the path, or nothing when the picker was cancelled.
#[tauri::command]
pub async fn wrapped_save_card(app: AppHandle, state: Shared<'_>, png: Vec<u8>, day: String) -> Result<Option<String>, String> {
    atlas_core::usage::wrapped::check_card(&png)?;
    let claude_dir = state.info().config.map(|c| std::path::PathBuf::from(c.dir));
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save your Wrapped card")
        .set_file_name(atlas_core::usage::wrapped::card_file_name(&day))
        .add_filter("PNG image", &["png"]);
    if let Ok(pictures) = app.path().picture_dir() {
        dialog = dialog.set_directory(pictures);
    }
    let Some(picked) = dialog.blocking_save_file() else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    if let Some(dir) = claude_dir.as_deref() {
        atlas_core::history::save_copy_guard(&path, dir)?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        atlas_core::fsutil::atomic_write(&path, &png).map_err(|e| format!("The image could not be saved: {e}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn open_in_file_manager(dir: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut cmd = std::process::Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut cmd = std::process::Command::new("xdg-open");
    // explorer reports exit code 1 even when it opened the folder, so only a failure to
    // start it counts as an error.
    atlas_core::proc::quiet(cmd.arg(dir)).spawn().map(|_| ()).map_err(|e| format!("Could not open the folder: {e}"))
}

/// Open a github.com page in the default browser. Only `https://github.com/<owner>/<repo>` shapes
/// get through, so a page can never hand the OS an arbitrary address.
pub(crate) fn open_github(repo: &str) -> Result<(), String> {
    let Ok(l) = atlas_core::library::link::parse(repo) else { return Err("That is not a GitHub repository.".into()) };
    let url = format!("https://github.com/{}/{}", l.owner, l.repo);
    #[cfg(windows)]
    let r = atlas_core::proc::quiet(std::process::Command::new("rundll32.exe").arg("url.dll,FileProtocolHandler").arg(&url)).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(not(any(windows, target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&url).spawn();
    r.map(|_| ()).map_err(|e| format!("Could not open the browser: {e}"))
}

/// The title bar is drawn by the page (it runs under the content, like the Claude app), so the
/// three caption buttons call here. `action` is "minimize", "toggle-maximize" or "close".
#[tauri::command]
pub fn window_control(app: AppHandle, action: String) {
    let Some(w) = app.get_webview_window("main") else { return };
    match action.as_str() {
        "minimize" => {
            let _ = w.minimize();
        }
        "toggle-maximize" => {
            if w.is_maximized().unwrap_or(false) {
                let _ = w.unmaximize();
            } else {
                let _ = w.maximize();
            }
        }
        "close" => {
            let _ = w.close();
        }
        _ => {}
    }
}

/// The page says whether an editor holds edits that are not saved, so a quit can ask first.
#[tauri::command]
pub fn set_unsaved(state: Shared, on: bool) {
    state.set_unsaved(on);
}

/// The user chose Discard at the quit question: quit now.
#[tauri::command]
pub fn leave_app(app: AppHandle, state: Shared) {
    state.set_unsaved(false);
    app.exit(0);
}

/// Whether the window is maximized, so the middle caption button can show Restore.
#[tauri::command]
pub fn window_maximized(app: AppHandle) -> bool {
    app.get_webview_window("main").and_then(|w| w.is_maximized().ok()).unwrap_or(false)
}

/// Windows edge drags: the page has drawn the frame for step `seq` (winframe.rs). Not async, so
/// Tauri runs it on the UI thread, where the drag's state lives.
#[tauri::command]
pub fn frame_ack(seq: u64, via: Option<u8>) {
    #[cfg(windows)]
    crate::winframe::on_ack(seq, via.unwrap_or(0));
    #[cfg(not(windows))]
    let _ = (seq, via);
}

/// The page has painted: show the window and record the time.
#[tauri::command]
pub fn frontend_ready(app: AppHandle, state: Shared) -> u64 {
    let ms = state.mark_first_paint();
    // During the launch intro the intro shows the window at the handoff.
    if !crate::intro::main_ready(&app)
        && let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.set_focus();
        }
    eprintln!("[atlas] startup: {ms} ms to first paint");
    // The usage engine starts only now, after the first paint (D40), on its own thread.
    state.usage.sync_in_background(state.inner());
    // Setup reads Will's Claude folder in the background so its page is full when opened.
    crate::setup_service::prefetch(&app);
    // Claude Code gets Atlas's connector without a button (opt-out in Settings), quietly.
    crate::mcp_service::auto_connect_in_background(state.inner());
    // History keeps its own record of the setup, quietly, once the first index has settled.
    state.history.start(&app);
    // The page booted with first_paint_ms unset; tell it the number now.
    let _ = app.emit(crate::state::INFO_EVENT, state.info());
    ms
}
